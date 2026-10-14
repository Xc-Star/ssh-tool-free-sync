import type { ConnectionOptions } from 'node:tls'
import pg from 'pg'
import type { SqlDbConfig, SslMode } from '@shared/types'
import {
  assertTablePrefix,
  SCHEMA_VERSION,
  SchemaTooNewError,
  SyncAdapterError,
  type AdapterCapabilities,
  type PushItem,
  type RemoteDevice,
  type RemoteItem,
  type SyncAdapter,
  type SyncErrorCode,
  type VaultMeta
} from '../adapter'

const DEFAULT_PORT = 5432
const PUSH_BATCH = 200
const ID_CHUNK = 100
const CONNECT_TIMEOUT_MS = 15_000
const QUERY_TIMEOUT_MS = 30_000
const TX_ATTEMPTS = 3
// Every writer queues on the counter row lock, so a stalled client (e.g. a laptop that went to sleep
// mid-push) must not be able to hold it for long.
const TX_BEGIN =
  "BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = '20s'; " +
  "SET LOCAL idle_in_transaction_session_timeout = '60s'"

interface ItemRow {
  id: string
  payload: Buffer | null
  hlc: string
  deleted: boolean
  device_id: string
  seq: string | number
}

export function postgresLabel(config: SqlDbConfig): string {
  return `PostgreSQL · ${sqlTarget(config, DEFAULT_PORT)}`
}

/**
 * PostgreSQL adapter. Seqs come from a single counter row that every push locks first
 * (`SELECT ... FOR UPDATE`), which serializes writers so seq order equals commit order.
 */
export class PostgresAdapter implements SyncAdapter {
  readonly kind = 'postgres' as const
  readonly capabilities: AdapterCapabilities = { realtime: true, defaultPollSec: 60, defaultReconcileMin: 15 }
  readonly label: string
  private pool: pg.Pool | null = null
  private connecting: Promise<void> | null = null
  private readonly subscriptions = new Set<() => Promise<void>>()
  private readonly t: { meta: string; items: string; devices: string; counter: string; seqIndex: string }
  private readonly channel: string
  private readonly secrets: string[]

  constructor(private readonly config: SqlDbConfig) {
    const prefix = checkPrefix(config.tablePrefix)
    this.t = {
      meta: `"${prefix}meta"`,
      items: `"${prefix}items"`,
      devices: `"${prefix}devices"`,
      counter: `"${prefix}counter"`,
      seqIndex: `"${prefix}items_seq"`
    }
    this.channel = `${prefix.toLowerCase()}changes`
    this.secrets = [config.password ?? '', urlPassword(config.url)].filter((s) => s.length >= 3)
    this.label = postgresLabel(config)
  }

  async connect(): Promise<void> {
    if (this.pool) return
    this.connecting ??= this.openPool().finally(() => {
      this.connecting = null
    })
    await this.connecting
  }

  private async openPool(): Promise<void> {
    const pool = new pg.Pool({ ...this.clientConfig(), max: 3, idleTimeoutMillis: 10_000 })
    // Errors of idle clients (server restart, network loss) are emitted here; the pool drops the client.
    pool.on('error', () => undefined)
    try {
      await pool.query('SELECT 1')
    } catch (err) {
      await pool.end().catch(() => undefined)
      throw this.mapError(err)
    }
    this.pool = pool
  }

  async close(): Promise<void> {
    await this.connecting?.catch(() => undefined)
    await Promise.all([...this.subscriptions].map((stop) => stop()))
    const pool = this.pool
    this.pool = null
    await pool?.end().catch(() => undefined)
  }

  async ensureSchema(): Promise<void> {
    const t = this.t
    const [state] = await this.query<{ ok: boolean }>(
      'SELECT (to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AND to_regclass($3) IS NOT NULL ' +
        'AND to_regclass($4) IS NOT NULL) AS ok',
      [t.meta, t.items, t.devices, t.counter]
    )
    // Only run DDL when needed, so a user without CREATE privilege works with pre-created tables.
    if (!state?.ok) await this.createTables()
    await this.query(`INSERT INTO ${t.counter} (id, v) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`)
    await this.query(
      `INSERT INTO ${t.meta} (k, v) VALUES ('schema_version', $1) ON CONFLICT (k) DO NOTHING`,
      [String(SCHEMA_VERSION)]
    )
    const [row] = await this.query<{ v: string }>(`SELECT v FROM ${t.meta} WHERE k = 'schema_version'`)
    const version = Number(row?.v)
    if (Number.isFinite(version) && version > SCHEMA_VERSION) throw new SchemaTooNewError(version)
  }

  private async createTables(): Promise<void> {
    const t = this.t
    const ddl = [
      `CREATE TABLE IF NOT EXISTS ${t.meta} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${t.items} (id TEXT PRIMARY KEY, payload BYTEA, hlc TEXT NOT NULL, ` +
        'deleted BOOLEAN NOT NULL DEFAULT FALSE, device_id TEXT NOT NULL, seq BIGINT NOT NULL)',
      `CREATE UNIQUE INDEX IF NOT EXISTS ${t.seqIndex} ON ${t.items} (seq)`,
      `CREATE TABLE IF NOT EXISTS ${t.devices} (id TEXT PRIMARY KEY, info BYTEA, last_seen BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${t.counter} (id INT PRIMARY KEY, v BIGINT NOT NULL)`
    ].join(';\n')
    for (let attempt = 1; ; attempt++) {
      try {
        // A multi-statement simple query runs as one implicit transaction.
        await this.requirePool().query(ddl)
        return
      } catch (err) {
        // Concurrent CREATE ... IF NOT EXISTS from two clients can still collide in the catalog.
        if (attempt < TX_ATTEMPTS && isSqlState(err, '23505', '42P07', '42710')) continue
        throw this.mapError(err)
      }
    }
  }

  async getVaultMeta(): Promise<VaultMeta | null> {
    const [row] = await this.query<{ v: string }>(`SELECT v FROM ${this.t.meta} WHERE k = 'vault'`)
    return row ? parseVaultMeta(row.v) : null
  }

  async createVaultMeta(meta: VaultMeta): Promise<boolean> {
    const rows = await this.query(
      `INSERT INTO ${this.t.meta} (k, v) VALUES ('vault', $1) ON CONFLICT (k) DO NOTHING RETURNING k`,
      [JSON.stringify(meta)]
    )
    return rows.length === 1
  }

  async updateVaultMeta(meta: VaultMeta): Promise<void> {
    await this.query(
      `INSERT INTO ${this.t.meta} (k, v) VALUES ('vault', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
      [JSON.stringify(meta)]
    )
  }

  async push(items: PushItem[]): Promise<void> {
    const latest = latestById(items)
    for (let i = 0; i < latest.length; i += PUSH_BATCH) await this.pushBatch(latest.slice(i, i + PUSH_BATCH))
  }

  private async pushBatch(batch: PushItem[]): Promise<void> {
    const t = this.t
    await this.transaction(async (client) => {
      const counter = await client.query<{ v: string }>(`SELECT v FROM ${t.counter} WHERE id = 1 FOR UPDATE`)
      if (!counter.rows.length) throw notInitialised()
      const existing = await client.query<{ id: string; hlc: string }>(
        `SELECT id, hlc FROM ${t.items} WHERE id = ANY($1::text[]) FOR UPDATE`,
        [batch.map((item) => item.id)]
      )
      const stored = new Map(existing.rows.map((r) => [r.id, r.hlc]))
      const accepted = batch.filter((item) => {
        const current = stored.get(item.id)
        return current === undefined || current < item.hlc
      })
      if (!accepted.length) return
      const next = await client.query<{ v: string }>(
        `UPDATE ${t.counter} SET v = v + $1 WHERE id = 1 RETURNING v`,
        [accepted.length]
      )
      const firstSeq = Number(next.rows[0].v) - accepted.length + 1
      const values: unknown[] = []
      const tuples = accepted.map((item, i) => {
        const n = i * 6
        values.push(item.id, toBuffer(item.payload), item.hlc, item.deleted, item.deviceId, firstSeq + i)
        return `($${n + 1}, $${n + 2}::bytea, $${n + 3}, $${n + 4}::boolean, $${n + 5}, $${n + 6}::bigint)`
      })
      // All affected rows are locked by this transaction, so a plain upsert is safe here.
      await client.query(
        `INSERT INTO ${t.items} (id, payload, hlc, deleted, device_id, seq) VALUES ${tuples.join(', ')} ` +
          'ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, hlc = EXCLUDED.hlc, ' +
          'deleted = EXCLUDED.deleted, device_id = EXCLUDED.device_id, seq = EXCLUDED.seq',
        values
      )
      await client.query('SELECT pg_notify($1, $2)', [this.channel, ''])
    })
  }

  async pull(afterSeq: number, limit: number): Promise<RemoteItem[]> {
    const rows = await this.query<ItemRow>(
      `SELECT id, payload, hlc, deleted, device_id, seq FROM ${this.t.items} WHERE seq > $1 ORDER BY seq ASC LIMIT $2`,
      [checkInt(afterSeq, 0, 'afterSeq'), checkInt(limit, 1, 'limit')]
    )
    return rows.map(toRemoteItem)
  }

  async getItems(ids: string[]): Promise<RemoteItem[]> {
    const unique = [...new Set(ids)]
    const out: RemoteItem[] = []
    for (let i = 0; i < unique.length; i += ID_CHUNK) {
      const rows = await this.query<ItemRow>(
        `SELECT id, payload, hlc, deleted, device_id, seq FROM ${this.t.items} WHERE id = ANY($1::text[])`,
        [unique.slice(i, i + ID_CHUNK)]
      )
      out.push(...rows.map(toRemoteItem))
    }
    return out
  }

  async head(): Promise<number> {
    const [row] = await this.query<{ v: string }>(`SELECT v FROM ${this.t.counter} WHERE id = 1`)
    return Number(row?.v ?? 0)
  }

  async listIndex(): Promise<{ id: string; hlc: string }[]> {
    return this.query<{ id: string; hlc: string }>(`SELECT id, hlc FROM ${this.t.items}`)
  }

  async upsertDevice(device: RemoteDevice): Promise<void> {
    await this.query(
      `INSERT INTO ${this.t.devices} (id, info, last_seen) VALUES ($1, $2::bytea, $3::bigint) ` +
        'ON CONFLICT (id) DO UPDATE SET info = EXCLUDED.info, last_seen = EXCLUDED.last_seen',
      [device.id, toBuffer(device.info), checkInt(device.lastSeen, 0, 'lastSeen')]
    )
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const rows = await this.query<{ id: string; info: Buffer | null; last_seen: string }>(
      `SELECT id, info, last_seen FROM ${this.t.devices} ORDER BY id`
    )
    return rows.map((r) => ({ id: r.id, info: r.info ?? null, lastSeen: Number(r.last_seen) }))
  }

  async deleteDevice(id: string): Promise<void> {
    await this.query(`DELETE FROM ${this.t.devices} WHERE id = $1`, [id])
  }

  /** LISTEN on a dedicated connection; on failure `onError` is called once and the feed stops. */
  async subscribe(onChange: () => void, onError?: (err: Error) => void): Promise<() => Promise<void>> {
    const client = new pg.Client(this.clientConfig())
    let active = false
    let closed = false
    const stop = async (): Promise<void> => {
      if (closed) return
      closed = true
      active = false
      this.subscriptions.delete(stop)
      await client.end().catch(() => undefined)
    }
    const fail = (err: unknown): void => {
      if (!active) return
      void stop()
      callSafely(() => onError?.(this.mapError(err)))
    }
    client.on('error', fail)
    client.on('end', () =>
      fail(new SyncAdapterError('network', 'The PostgreSQL notification connection was closed.'))
    )
    client.on('notification', (msg) => {
      if (active && msg.channel === this.channel) callSafely(onChange)
    })
    this.subscriptions.add(stop)
    try {
      await client.connect()
      await client.query(`LISTEN "${this.channel}"`)
    } catch (err) {
      await stop()
      throw this.mapError(err)
    }
    if (closed) throw new SyncAdapterError('network', 'The PostgreSQL adapter was closed.')
    active = true
    return stop
  }

  private requirePool(): pg.Pool {
    if (!this.pool) throw new SyncAdapterError('network', 'Not connected to PostgreSQL.')
    return this.pool
  }

  private async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<R[]> {
    const pool = this.requirePool()
    try {
      return (await pool.query<R>(text, values)).rows
    } catch (err) {
      throw this.mapError(err)
    }
  }

  /** Runs `fn` in a READ COMMITTED transaction; retried on serialization failures / deadlocks. */
  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient
    try {
      client = await this.requirePool().connect()
    } catch (err) {
      throw this.mapError(err)
    }
    let discard = false
    // A checked-out client has no pool error listener; an unhandled 'error' event would crash the process.
    const onClientError = (): void => {
      discard = true
    }
    client.on('error', onClientError)
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await client.query(TX_BEGIN)
          const result = await fn(client)
          await client.query('COMMIT')
          return result
        } catch (err) {
          if (discard || isConnectionFailure(err)) {
            discard = true
            throw err
          }
          try {
            await client.query('ROLLBACK')
          } catch {
            discard = true
            throw err
          }
          if (attempt >= TX_ATTEMPTS || !isSqlState(err, '40001', '40P01')) throw err
          await sleep(25 * attempt + Math.random() * 50)
        }
      }
    } catch (err) {
      throw this.mapError(err)
    } finally {
      client.removeListener('error', onClientError)
      client.release(discard)
    }
  }

  private clientConfig(): pg.ClientConfig {
    const c = this.config
    const common: pg.ClientConfig = {
      ssl: tlsOptions(c.ssl, c.ca),
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: 'ssh-tool'
    }
    if (c.url?.trim()) return { ...common, connectionString: connectionString(c.url.trim()) }
    return {
      ...common,
      host: c.host?.trim() || 'localhost',
      port: c.port || DEFAULT_PORT,
      database: c.database || undefined,
      user: c.user || undefined,
      password: c.password || undefined
    }
  }

  private mapError(err: unknown): Error {
    if (err instanceof SyncAdapterError || err instanceof SchemaTooNewError) return err
    const e = (err ?? {}) as { code?: unknown; message?: unknown }
    const code = typeof e.code === 'string' ? e.code : ''
    const raw = (typeof e.message === 'string' && e.message) || code || 'unknown error'
    const kind = classify(err, code, raw)
    return new SyncAdapterError(kind, `${MESSAGE_PREFIX[kind]}${redact(raw, this.secrets)}`, err)
  }
}

const MESSAGE_PREFIX: Record<SyncErrorCode, string> = {
  network: 'Cannot reach PostgreSQL: ',
  auth: 'PostgreSQL denied access: ',
  config: 'PostgreSQL configuration problem: ',
  'rate-limit': 'PostgreSQL is busy: ',
  schema: 'PostgreSQL schema problem: ',
  unknown: 'PostgreSQL error: '
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EADDRNOTAVAIL'
])

const TLS_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/

function classify(err: unknown, code: string, message: string): SyncErrorCode {
  if (err instanceof pg.DatabaseError) {
    if (['28P01', '28000', '42501'].includes(code)) return 'auth'
    if (['3D000', '3F000', '25006'].includes(code)) return 'config'
    if (code === '42P01') return 'schema'
    if (['53300', '55P03', '40001', '40P01'].includes(code)) return 'rate-limit'
    if (code.startsWith('08') || ['57P01', '57P02', '57P03', '57014'].includes(code)) return 'network'
    return 'unknown'
  }
  if (NETWORK_CODES.has(code)) return 'network'
  if (TLS_CODE.test(code) || /\b(?:SSL|TLS)\b|certificate/i.test(message)) return 'config'
  if (/timeout|timed out|terminated|connection|socket|ECONN|Cannot use a pool/i.test(message)) {
    return 'network'
  }
  return 'unknown'
}

function isSqlState(err: unknown, ...codes: string[]): boolean {
  return err instanceof pg.DatabaseError && codes.includes(err.code ?? '')
}

/** Client-side failures (timeouts, dropped sockets) after which the connection must not be reused. */
function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof pg.DatabaseError || err instanceof SyncAdapterError) {
    return false
  }
  const code = (err as { code?: unknown }).code
  return (
    (typeof code === 'string' && NETWORK_CODES.has(code)) ||
    /timeout|terminated|connection/i.test(err.message)
  )
}

function notInitialised(): SyncAdapterError {
  return new SyncAdapterError('schema', 'The sync tables are not initialised (ensureSchema has not run).')
}

/** Listener exceptions must not propagate into pg's socket handling. */
function callSafely(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error('[sync] PostgreSQL change listener failed', err)
  }
}

function checkPrefix(prefix: string): string {
  try {
    return assertTablePrefix(prefix)
  } catch (err) {
    throw new SyncAdapterError('config', (err as Error).message, err)
  }
}

function checkInt(value: number, min: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`)
  }
  return value
}

function tlsOptions(mode: SslMode, ca: string | undefined): ConnectionOptions | false {
  const caOption = ca?.trim() ? { ca } : {}
  switch (mode) {
    case 'disable':
      return false
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-ca':
      return { rejectUnauthorized: true, ...caOption, checkServerIdentity: () => undefined }
    default:
      return { rejectUnauthorized: true, ...caOption }
  }
}

/** Drops ssl* URL parameters: pg would let them override the explicit `ssl` setting. */
function connectionString(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // The parser error is not attached as cause: it echoes the input, password included.
    throw new SyncAdapterError('config', 'The PostgreSQL connection URL is invalid.')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new SyncAdapterError(
      'config',
      'PostgreSQL connection URLs must start with postgres:// or postgresql://.'
    )
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^ssl/i.test(key) || key.toLowerCase() === 'uselibpqcompat') parsed.searchParams.delete(key)
  }
  return parsed.toString()
}

function sqlTarget(config: SqlDbConfig, defaultPort: number): string {
  if (config.url?.trim()) {
    try {
      const u = new URL(config.url.trim())
      return `${u.hostname || 'localhost'}:${u.port || defaultPort}/${safeDecode(u.pathname.replace(/^\//, ''))}`
    } catch {
      return 'invalid URL'
    }
  }
  const host = config.host?.trim() || 'localhost'
  return `${host.includes(':') ? `[${host}]` : host}:${config.port || defaultPort}/${config.database ?? ''}`
}

function urlPassword(url: string | undefined): string {
  if (!url) return ''
  try {
    return safeDecode(new URL(url).password)
  } catch {
    return ''
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function redact(message: string, secrets: string[]): string {
  let out = message
  for (const secret of secrets) out = out.split(secret).join('***')
  return out
}

function toBuffer(bytes: Uint8Array | null | undefined): Buffer | null {
  if (!bytes) return null
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function toRemoteItem(r: ItemRow): RemoteItem {
  return {
    id: r.id,
    payload: r.payload ?? null,
    hlc: r.hlc,
    deleted: r.deleted === true,
    deviceId: r.device_id,
    seq: Number(r.seq)
  }
}

function parseVaultMeta(value: string): VaultMeta {
  try {
    const meta: unknown = JSON.parse(value)
    if (meta && typeof meta === 'object') return meta as VaultMeta
  } catch {
    // fall through
  }
  throw new SyncAdapterError('unknown', 'The vault metadata stored in the sync database is corrupt.')
}

/** Keeps one entry per id (the greatest hlc), preserving first-seen order. */
function latestById(items: PushItem[]): PushItem[] {
  const byId = new Map<string, PushItem>()
  for (const item of items) {
    const prev = byId.get(item.id)
    if (!prev || prev.hlc < item.hlc) byId.set(item.id, item)
  }
  return [...byId.values()]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
