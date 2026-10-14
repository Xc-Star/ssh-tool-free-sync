import {
  createPool,
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
  type SslOptions
} from 'mysql2/promise'
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

const DEFAULT_PORT = 3306
const PUSH_BATCH = 200
const ID_CHUNK = 100
const CONNECT_TIMEOUT_MS = 15_000
const QUERY_TIMEOUT_MS = 30_000
const TX_ATTEMPTS = 3
/** Rows per write statement / approximate SQL size (payloads are sent as hex, MySQL 5.7 allows 4 MB packets). */
const WRITE_ROWS = 50
const WRITE_BYTES = 1024 * 1024
const MAX_ID = 64
const MAX_HLC = 96

type Row = RowDataPacket & Record<string, unknown>

interface WriteRow {
  id: string
  payload: Buffer | null
  hlc: string
  deleted: boolean
  deviceId: string
  seq: number
}

export function mysqlLabel(config: SqlDbConfig): string {
  return `MySQL · ${sqlTarget(config, DEFAULT_PORT)}`
}

/**
 * MySQL / MariaDB adapter. Like PostgreSQL, every push locks the single counter row first, which
 * serializes writers so seq order equals commit order.
 */
export class MysqlAdapter implements SyncAdapter {
  readonly kind = 'mysql' as const
  readonly capabilities: AdapterCapabilities = {
    realtime: false,
    defaultPollSec: 30,
    defaultReconcileMin: 15
  }
  readonly label: string
  private pool: Pool | null = null
  private connecting: Promise<void> | null = null
  private readonly prepared = new WeakSet<object>()
  private readonly prefix: string
  private readonly t: { meta: string; items: string; devices: string; counter: string; seqIndex: string }
  private readonly secrets: string[]

  constructor(private readonly config: SqlDbConfig) {
    const prefix = checkPrefix(config.tablePrefix)
    this.prefix = prefix
    this.t = {
      meta: `\`${prefix}meta\``,
      items: `\`${prefix}items\``,
      devices: `\`${prefix}devices\``,
      counter: `\`${prefix}counter\``,
      seqIndex: `\`${prefix}items_seq\``
    }
    this.secrets = [config.password ?? '', urlPassword(config.url)].filter((s) => s.length >= 3)
    this.label = mysqlLabel(config)
  }

  async connect(): Promise<void> {
    if (this.pool) return
    this.connecting ??= this.openPool().finally(() => {
      this.connecting = null
    })
    await this.connecting
  }

  private async openPool(): Promise<void> {
    const pool = createPool(this.poolOptions())
    try {
      await this.withConn((conn) => run(conn, 'SELECT 1'), pool)
    } catch (err) {
      await pool.end().catch(() => undefined)
      throw err
    }
    this.pool = pool
  }

  async close(): Promise<void> {
    await this.connecting?.catch(() => undefined)
    const pool = this.pool
    this.pool = null
    await pool?.end().catch(() => undefined)
  }

  async ensureSchema(): Promise<void> {
    const t = this.t
    await this.withConn(async (conn) => {
      const names = ['meta', 'items', 'devices', 'counter'].map((n) => this.prefix + n)
      const found = await run<Row[]>(
        conn,
        'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)',
        [names]
      )
      // Only run DDL when needed, so a user without CREATE privilege works with pre-created tables.
      if (found.length < names.length) for (const ddl of this.ddl()) await run(conn, ddl)
      await run(conn, `INSERT IGNORE INTO ${t.counter} (id, v) VALUES (1, 0)`)
      await run(conn, `INSERT IGNORE INTO ${t.meta} (k, v) VALUES ('schema_version', ?)`, [
        String(SCHEMA_VERSION)
      ])
      const [row] = await run<Row[]>(conn, `SELECT v FROM ${t.meta} WHERE k = 'schema_version'`)
      const version = Number(row?.v)
      if (Number.isFinite(version) && version > SCHEMA_VERSION) throw new SchemaTooNewError(version)
    })
  }

  private ddl(): string[] {
    const t = this.t
    const bin = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'
    const opts = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    return [
      `CREATE TABLE IF NOT EXISTS ${t.meta} (k VARCHAR(191) ${bin} NOT NULL PRIMARY KEY, v MEDIUMTEXT NOT NULL) ${opts}`,
      `CREATE TABLE IF NOT EXISTS ${t.items} (id VARCHAR(${MAX_ID}) ${bin} NOT NULL PRIMARY KEY, ` +
        `payload MEDIUMBLOB NULL, hlc VARCHAR(${MAX_HLC}) ${bin} NOT NULL, deleted TINYINT(1) NOT NULL DEFAULT 0, ` +
        `device_id VARCHAR(${MAX_ID}) ${bin} NOT NULL, seq BIGINT NOT NULL, UNIQUE KEY ${t.seqIndex} (seq)) ${opts}`,
      `CREATE TABLE IF NOT EXISTS ${t.devices} (id VARCHAR(${MAX_ID}) ${bin} NOT NULL PRIMARY KEY, ` +
        `info MEDIUMBLOB NULL, last_seen BIGINT NOT NULL) ${opts}`,
      `CREATE TABLE IF NOT EXISTS ${t.counter} (id INT NOT NULL PRIMARY KEY, v BIGINT NOT NULL) ENGINE=InnoDB`
    ]
  }

  async getVaultMeta(): Promise<VaultMeta | null> {
    const [row] = await this.withConn((conn) =>
      run<Row[]>(conn, `SELECT v FROM ${this.t.meta} WHERE k = 'vault'`)
    )
    return row ? parseVaultMeta(String(row.v)) : null
  }

  async createVaultMeta(meta: VaultMeta): Promise<boolean> {
    const res = await this.withConn((conn) =>
      run<ResultSetHeader>(conn, `INSERT IGNORE INTO ${this.t.meta} (k, v) VALUES ('vault', ?)`, [
        JSON.stringify(meta)
      ])
    )
    return res.affectedRows === 1
  }

  async updateVaultMeta(meta: VaultMeta): Promise<void> {
    const json = JSON.stringify(meta)
    await this.withConn((conn) =>
      run(conn, `INSERT INTO ${this.t.meta} (k, v) VALUES ('vault', ?) ON DUPLICATE KEY UPDATE v = ?`, [
        json,
        json
      ])
    )
  }

  async push(items: PushItem[]): Promise<void> {
    const latest = latestById(items)
    for (const item of latest) checkItem(item)
    for (let i = 0; i < latest.length; i += PUSH_BATCH) await this.pushBatch(latest.slice(i, i + PUSH_BATCH))
  }

  private async pushBatch(batch: PushItem[]): Promise<void> {
    const t = this.t
    await this.transaction(async (conn) => {
      const [counter] = await run<Row[]>(conn, `SELECT v FROM ${t.counter} WHERE id = 1 FOR UPDATE`)
      if (!counter) throw notInitialised()
      const existing = await run<Row[]>(conn, `SELECT id, hlc FROM ${t.items} WHERE id IN (?) FOR UPDATE`, [
        batch.map((item) => item.id)
      ])
      const stored = new Map(existing.map((r) => [String(r.id), String(r.hlc)]))
      const accepted = batch.filter((item) => {
        const current = stored.get(item.id)
        return current === undefined || current < item.hlc
      })
      if (!accepted.length) return
      await run(conn, `UPDATE ${t.counter} SET v = v + ? WHERE id = 1`, [accepted.length])
      let seq = Number(counter.v)
      const inserts: WriteRow[] = []
      const updates: WriteRow[] = []
      for (const item of accepted) {
        const row = { ...item, payload: toBuffer(item.payload), seq: ++seq }
        ;(stored.has(item.id) ? updates : inserts).push(row)
      }
      for (const group of chunkBySize(inserts, WRITE_ROWS, WRITE_BYTES, rowSize)) {
        await run(conn, `INSERT INTO ${t.items} (id, payload, hlc, deleted, device_id, seq) VALUES ?`, [
          group.map((r) => [r.id, r.payload, r.hlc, r.deleted, r.deviceId, r.seq])
        ])
      }
      for (const group of chunkBySize(updates, WRITE_ROWS, WRITE_BYTES, rowSize)) {
        const { sql, values } = caseUpdate(t.items, group)
        await run(conn, sql, values)
      }
    })
  }

  async pull(afterSeq: number, limit: number): Promise<RemoteItem[]> {
    const rows = await this.withConn((conn) =>
      run<Row[]>(
        conn,
        `SELECT id, payload, hlc, deleted, device_id, seq FROM ${this.t.items} WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        [checkInt(afterSeq, 0, 'afterSeq'), checkInt(limit, 1, 'limit')]
      )
    )
    return rows.map(toRemoteItem)
  }

  async getItems(ids: string[]): Promise<RemoteItem[]> {
    const unique = [...new Set(ids)].filter((id) => id.length <= MAX_ID)
    if (!unique.length) return []
    return this.withConn(async (conn) => {
      const out: RemoteItem[] = []
      for (let i = 0; i < unique.length; i += ID_CHUNK) {
        const rows = await run<Row[]>(
          conn,
          `SELECT id, payload, hlc, deleted, device_id, seq FROM ${this.t.items} WHERE id IN (?)`,
          [unique.slice(i, i + ID_CHUNK)]
        )
        out.push(...rows.map(toRemoteItem))
      }
      return out
    })
  }

  async head(): Promise<number> {
    const [row] = await this.withConn((conn) =>
      run<Row[]>(conn, `SELECT v FROM ${this.t.counter} WHERE id = 1`)
    )
    return Number(row?.v ?? 0)
  }

  async listIndex(): Promise<{ id: string; hlc: string }[]> {
    const rows = await this.withConn((conn) => run<Row[]>(conn, `SELECT id, hlc FROM ${this.t.items}`))
    return rows.map((r) => ({ id: String(r.id), hlc: String(r.hlc) }))
  }

  async upsertDevice(device: RemoteDevice): Promise<void> {
    if (!device.id || device.id.length > MAX_ID) {
      throw new RangeError(`device id must be 1-${MAX_ID} characters`)
    }
    const info = toBuffer(device.info)
    const lastSeen = checkInt(device.lastSeen, 0, 'lastSeen')
    await this.withConn((conn) =>
      run(
        conn,
        `INSERT INTO ${this.t.devices} (id, info, last_seen) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE info = ?, last_seen = ?`,
        [device.id, info, lastSeen, info, lastSeen]
      )
    )
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const rows = await this.withConn((conn) =>
      run<Row[]>(conn, `SELECT id, info, last_seen FROM ${this.t.devices} ORDER BY id`)
    )
    return rows.map((r) => ({
      id: String(r.id),
      info: toBuffer(r.info as Buffer | null),
      lastSeen: Number(r.last_seen)
    }))
  }

  async deleteDevice(id: string): Promise<void> {
    await this.withConn((conn) => run(conn, `DELETE FROM ${this.t.devices} WHERE id = ?`, [id]))
  }

  private requirePool(): Pool {
    if (!this.pool) throw new SyncAdapterError('network', 'Not connected to MySQL.')
    return this.pool
  }

  /** Borrows a connection; connections that failed at the protocol level are destroyed, not reused. */
  private async withConn<T>(fn: (conn: PoolConnection) => Promise<T>, pool?: Pool): Promise<T> {
    let conn: PoolConnection
    try {
      conn = await (pool ?? this.requirePool()).getConnection()
    } catch (err) {
      throw this.mapError(err)
    }
    try {
      if (!this.prepared.has(conn.connection)) {
        await prepareSession(conn)
        this.prepared.add(conn.connection)
      }
      return await fn(conn)
    } catch (err) {
      if (isBroken(err)) conn.destroy()
      throw this.mapError(err)
    } finally {
      conn.release()
    }
  }

  /** Runs `fn` in a transaction; retried on deadlocks / lock wait timeouts. */
  private transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    return this.withConn(async (conn) => {
      for (let attempt = 1; ; attempt++) {
        await run(conn, 'START TRANSACTION')
        try {
          const result = await fn(conn)
          await run(conn, 'COMMIT')
          return result
        } catch (err) {
          if (isBroken(err)) throw err
          try {
            await run(conn, 'ROLLBACK')
          } catch {
            conn.destroy()
            throw err
          }
          if (attempt >= TX_ATTEMPTS || !isLockConflict(err)) throw err
          await sleep(25 * attempt + Math.random() * 50)
        }
      }
    })
  }

  private poolOptions(): PoolOptions {
    const c = this.config
    const target = c.url?.trim()
      ? parseUrl(c.url.trim())
      : {
          host: c.host?.trim() || 'localhost',
          port: c.port || DEFAULT_PORT,
          user: c.user || undefined,
          password: c.password || undefined,
          database: c.database || undefined
        }
    return {
      ...target,
      ssl: sslOptions(c.ssl, c.ca),
      connectionLimit: 3,
      // Keep at most one idle connection and close it after a minute (before typical server idle timeouts).
      maxIdle: 1,
      idleTimeout: 60_000,
      connectTimeout: CONNECT_TIMEOUT_MS,
      supportBigNumbers: true,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000
    }
  }

  private mapError(err: unknown): Error {
    if (err instanceof SyncAdapterError || err instanceof SchemaTooNewError || err instanceof RangeError) {
      return err
    }
    const e = (err ?? {}) as { code?: unknown; message?: unknown; sql?: unknown }
    const code = typeof e.code === 'string' ? e.code : ''
    const raw = (typeof e.message === 'string' && e.message) || code || 'unknown error'
    const kind = classify(err, code, raw)
    // mysql2 attaches the full SQL text (including hex payloads) to errors; it is noise in logs.
    if (typeof e.sql === 'string') delete e.sql
    return new SyncAdapterError(kind, `${MESSAGE_PREFIX[kind]}${redact(raw, this.secrets)}`, err)
  }
}

const MESSAGE_PREFIX: Record<SyncErrorCode, string> = {
  network: 'Cannot reach MySQL: ',
  auth: 'MySQL denied access: ',
  config: 'MySQL configuration problem: ',
  'rate-limit': 'MySQL is busy: ',
  schema: 'MySQL schema problem: ',
  unknown: 'MySQL error: '
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
const TLS_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|HANDSHAKE_)/
// ER_DBACCESS_DENIED, ER_ACCESS_DENIED, ER_TABLEACCESS_DENIED, ER_COLUMNACCESS_DENIED, ER_SPECIFIC_ACCESS_DENIED,
// ER_NOT_SUPPORTED_AUTH_MODE, ER_ACCESS_DENIED_NO_PASSWORD, ER_MUST_CHANGE_PASSWORD(_LOGIN), ER_ACCOUNT_HAS_BEEN_LOCKED
const AUTH_ERRNOS = new Set([1044, 1045, 1142, 1143, 1227, 1251, 1698, 1820, 1862, 3118])
// ER_NO_DB_ERROR, ER_BAD_DB_ERROR, ER_OPTION_PREVENTS_STATEMENT, ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION,
// ER_READ_ONLY_MODE, ER_SECURE_TRANSPORT_REQUIRED
const CONFIG_ERRNOS = new Set([1046, 1049, 1290, 1792, 1836, 3159])
// ER_CON_COUNT_ERROR, ER_TOO_MANY_USER_CONNECTIONS, ER_USER_LIMIT_REACHED, ER_LOCK_WAIT_TIMEOUT, ER_LOCK_DEADLOCK
const BUSY_ERRNOS = new Set([1040, 1203, 1226, 1205, 1213])
// server shutdown / aborted connection / net read+write errors / query interrupted / timeouts / session killed
const NETWORK_ERRNOS = new Set([
  1053, 1152, 1158, 1159, 1160, 1161, 1317, 2002, 2003, 2006, 2013, 3024, 3169, 4031
])

function classify(err: unknown, code: string, message: string): SyncErrorCode {
  const errno = (err as { errno?: unknown } | null)?.errno
  const n = typeof errno === 'number' ? errno : 0
  if (AUTH_ERRNOS.has(n)) return 'auth'
  if (CONFIG_ERRNOS.has(n)) return 'config'
  if (n === 1146) return 'schema'
  if (BUSY_ERRNOS.has(n)) return 'rate-limit'
  if (NETWORK_ERRNOS.has(n)) return 'network'
  if (TLS_CODE.test(code) || /\b(?:SSL|TLS)\b|certificate|secure connection/i.test(message)) return 'config'
  if (NETWORK_CODES.has(code) || code.startsWith('PROTOCOL_') || code === 'POOL_CLOSED') return 'network'
  if ((err as { fatal?: unknown } | null)?.fatal === true) return 'network'
  if (/Pool is closed|timeout|timed out/i.test(message)) return 'network'
  return 'unknown'
}

/** The connection is unusable (fatal protocol error or client-side timeout) and must be destroyed. */
function isBroken(err: unknown): boolean {
  const e = err as { fatal?: unknown; code?: unknown } | null
  return e?.fatal === true || e?.code === 'PROTOCOL_SEQUENCE_TIMEOUT'
}

function isLockConflict(err: unknown): boolean {
  const errno = (err as { errno?: unknown } | null)?.errno
  return errno === 1213 || errno === 1205
}

async function run<T extends RowDataPacket[] | ResultSetHeader = ResultSetHeader>(
  conn: PoolConnection,
  sql: string,
  values?: unknown[]
): Promise<T> {
  const [result] = await conn.query<T>({ sql, timeout: QUERY_TIMEOUT_MS }, values)
  return result
}

/**
 * Per-connection setup. Queries use mysql2's client-side escaping, which relies on backslash escapes,
 * so NO_BACKSLASH_ESCAPES must be off. The timeouts make the server drop a stalled client (and its
 * lock on the counter row) quickly instead of after the default 8 hours.
 */
async function prepareSession(conn: PoolConnection): Promise<void> {
  const [row] = await run<Row[]>(conn, 'SELECT @@SESSION.sql_mode AS mode')
  const modes = String(row?.mode ?? '')
    .split(',')
    .filter(Boolean)
  const kept = modes.filter((m) => m.toUpperCase() !== 'NO_BACKSLASH_ESCAPES' && /^\w+$/.test(m))
  if (kept.length !== modes.length) await run(conn, `SET SESSION sql_mode = '${kept.join(',')}'`)
  try {
    await run(conn, 'SET SESSION wait_timeout = 120, innodb_lock_wait_timeout = 20')
  } catch (err) {
    // Some MySQL-compatible services do not allow changing these; that is not fatal.
    if (isBroken(err)) throw err
  }
}

/** `UPDATE ... SET col = CASE id WHEN ... END` for several rows in one statement (MySQL + MariaDB). */
function caseUpdate(table: string, rows: WriteRow[]): { sql: string; values: unknown[] } {
  const values: unknown[] = []
  const column = (name: string, pick: (r: WriteRow) => unknown): string => {
    const whens = rows.map((r) => {
      values.push(r.id, pick(r))
      return 'WHEN ? THEN ?'
    })
    return `${name} = CASE id ${whens.join(' ')} END`
  }
  const sets = [
    column('payload', (r) => r.payload),
    column('hlc', (r) => r.hlc),
    column('deleted', (r) => r.deleted),
    column('device_id', (r) => r.deviceId),
    column('seq', (r) => r.seq)
  ]
  values.push(rows.map((r) => r.id))
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id IN (?)`, values }
}

function rowSize(r: WriteRow): number {
  return (r.payload?.length ?? 0) * 2 + r.id.length + r.hlc.length + r.deviceId.length + 128
}

function chunkBySize<T>(rows: T[], maxRows: number, maxBytes: number, size: (row: T) => number): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const row of rows) {
    const n = size(row)
    if (current.length && (current.length >= maxRows || bytes + n > maxBytes)) {
      groups.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += n
  }
  if (current.length) groups.push(current)
  return groups
}

/** Rejects values that a VARCHAR column would truncate silently in non-strict SQL modes. */
function checkItem(item: PushItem): void {
  if (!item.id || item.id.length > MAX_ID) throw new RangeError(`item id must be 1-${MAX_ID} characters`)
  if (!item.hlc || item.hlc.length > MAX_HLC) throw new RangeError(`item hlc must be 1-${MAX_HLC} characters`)
  if (!item.deviceId || item.deviceId.length > MAX_ID) {
    throw new RangeError(`item deviceId must be 1-${MAX_ID} characters`)
  }
}

function notInitialised(): SyncAdapterError {
  return new SyncAdapterError('schema', 'The sync tables are not initialised (ensureSchema has not run).')
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

function sslOptions(mode: SslMode, ca: string | undefined): SslOptions | undefined {
  const caOption = ca?.trim() ? { ca } : {}
  switch (mode) {
    case 'disable':
      return undefined
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-ca':
      return { rejectUnauthorized: true, verifyIdentity: false, ...caOption }
    default:
      return { rejectUnauthorized: true, verifyIdentity: true, ...caOption }
  }
}

/** Parsed here (instead of mysql2's `uri`) so URL parameters cannot override the explicit TLS setting. */
function parseUrl(url: string): Pick<PoolOptions, 'host' | 'port' | 'user' | 'password' | 'database'> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    // The parser error is not attached as cause: it echoes the input, password included.
    throw new SyncAdapterError('config', 'The MySQL connection URL is invalid.')
  }
  if (u.protocol !== 'mysql:' && u.protocol !== 'mariadb:') {
    throw new SyncAdapterError('config', 'MySQL connection URLs must start with mysql:// or mariadb://.')
  }
  return {
    host: u.hostname.replace(/^\[(.*)\]$/, '$1') || 'localhost',
    port: u.port ? Number(u.port) : DEFAULT_PORT,
    user: safeDecode(u.username) || undefined,
    password: safeDecode(u.password) || undefined,
    database: safeDecode(u.pathname.replace(/^\//, '')) || undefined
  }
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

function toRemoteItem(r: Row): RemoteItem {
  return {
    id: String(r.id),
    payload: toBuffer(r.payload as Buffer | null),
    hlc: String(r.hlc),
    deleted: Number(r.deleted) !== 0,
    deviceId: String(r.device_id),
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
