import type { D1DbConfig } from '@shared/types'
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
  type VaultMeta
} from '../adapter'
import { D1Client, type D1Statement } from './d1-client'

const STATEMENTS_PER_REQUEST = 50
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
/** D1 allows at most 100 bound parameters per statement. */
const ID_CHUNK = 100
const INDEX_PAGE = 5000

interface ItemRow {
  id: string
  payload: string | null
  hlc: string
  deleted: number
  device_id: string
  seq: number
}

interface DeviceRow {
  id: string
  info: string | null
  last_seen: number
}

export function d1Label(config: D1DbConfig): string {
  return `Cloudflare D1 · ${(config.databaseId ?? '').slice(0, 8)}`
}

/**
 * Cloudflare D1 over the REST API. D1 has no interactive transactions but executes statements
 * serially on a single primary, so every pushed item is one atomic conditional upsert whose seq is
 * `MAX(seq) + 1`, which is strictly increasing in commit order. Binary columns are stored as base64 TEXT.
 */
export class D1Adapter implements SyncAdapter {
  readonly kind = 'd1' as const
  readonly capabilities: AdapterCapabilities = {
    realtime: false,
    defaultPollSec: 60,
    defaultReconcileMin: 30
  }
  readonly label: string
  private client: D1Client | null = null
  private readonly t: { meta: string; items: string; devices: string; seqIndex: string }

  constructor(
    private readonly config: D1DbConfig,
    private readonly options: { fetchImpl?: typeof fetch } = {}
  ) {
    const prefix = checkPrefix(config.tablePrefix)
    this.t = {
      meta: `"${prefix}meta"`,
      items: `"${prefix}items"`,
      devices: `"${prefix}devices"`,
      seqIndex: `"${prefix}items_seq"`
    }
    this.label = d1Label(config)
  }

  async connect(): Promise<void> {
    if (this.client) return
    const { accountId, databaseId, apiToken, baseUrl } = this.config
    if (!accountId?.trim() || !databaseId?.trim() || !apiToken?.trim()) {
      throw new SyncAdapterError(
        'config',
        'Cloudflare D1 needs an account ID, a database ID and an API token.'
      )
    }
    const client = new D1Client({
      accountId: accountId.trim(),
      databaseId: databaseId.trim(),
      apiToken: apiToken.trim(),
      baseUrl,
      fetchImpl: this.options.fetchImpl
    })
    await client.query('SELECT 1')
    this.client = client
  }

  async close(): Promise<void> {
    this.client = null
  }

  async ensureSchema(): Promise<void> {
    const { meta, items, devices, seqIndex } = this.t
    const results = await this.db().batch<{ v: string }>([
      { sql: `CREATE TABLE IF NOT EXISTS ${meta} (k TEXT PRIMARY KEY, v TEXT NOT NULL)` },
      {
        sql:
          `CREATE TABLE IF NOT EXISTS ${items} (id TEXT PRIMARY KEY, payload TEXT, hlc TEXT NOT NULL, ` +
          'deleted INTEGER NOT NULL DEFAULT 0, device_id TEXT NOT NULL, seq INTEGER NOT NULL)'
      },
      { sql: `CREATE UNIQUE INDEX IF NOT EXISTS ${seqIndex} ON ${items} (seq)` },
      {
        sql: `CREATE TABLE IF NOT EXISTS ${devices} (id TEXT PRIMARY KEY, info TEXT, last_seen INTEGER NOT NULL)`
      },
      {
        sql: `INSERT INTO ${meta} (k, v) VALUES ('schema_version', ?) ON CONFLICT (k) DO NOTHING`,
        params: [String(SCHEMA_VERSION)]
      },
      { sql: `SELECT v FROM ${meta} WHERE k = 'schema_version'` }
    ])
    const version = Number(results[results.length - 1].rows[0]?.v)
    if (Number.isFinite(version) && version > SCHEMA_VERSION) throw new SchemaTooNewError(version)
  }

  async getVaultMeta(): Promise<VaultMeta | null> {
    const { rows } = await this.db().query<{ v: string }>(`SELECT v FROM ${this.t.meta} WHERE k = 'vault'`)
    return rows.length ? parseVaultMeta(rows[0].v) : null
  }

  async createVaultMeta(meta: VaultMeta): Promise<boolean> {
    const { rows } = await this.db().query(
      `INSERT INTO ${this.t.meta} (k, v) VALUES ('vault', ?) ON CONFLICT (k) DO NOTHING RETURNING k`,
      [JSON.stringify(meta)]
    )
    return rows.length === 1
  }

  async updateVaultMeta(meta: VaultMeta): Promise<void> {
    await this.db().query(
      `INSERT INTO ${this.t.meta} (k, v) VALUES ('vault', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      [JSON.stringify(meta)]
    )
  }

  async push(items: PushItem[]): Promise<void> {
    const statements = latestById(items).map((item) => this.pushStatement(item))
    const groups = chunkBySize(statements, STATEMENTS_PER_REQUEST, MAX_REQUEST_BYTES, statementSize)
    for (const group of groups) await this.db().batch(group)
  }

  private pushStatement(item: PushItem): D1Statement {
    const items = this.t.items
    const payload = item.payload ? toBase64(item.payload) : null
    const params =
      payload === null ? [item.id, item.hlc, item.deviceId] : [item.id, payload, item.hlc, item.deviceId]
    // Values the API cannot bind as strings are inlined; both are generated here, never user input.
    const sql =
      `INSERT INTO ${items} (id, payload, hlc, deleted, device_id, seq) ` +
      `VALUES (?, ${payload === null ? 'NULL' : '?'}, ?, ${item.deleted ? 1 : 0}, ?, ` +
      `(SELECT COALESCE(MAX(seq), 0) + 1 FROM ${items})) ` +
      'ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, hlc = excluded.hlc, deleted = excluded.deleted, ' +
      `device_id = excluded.device_id, seq = excluded.seq WHERE excluded.hlc > ${items}.hlc`
    return { sql, params }
  }

  async pull(afterSeq: number, limit: number): Promise<RemoteItem[]> {
    const after = checkInt(afterSeq, 0, 'afterSeq')
    const max = checkInt(limit, 1, 'limit')
    const { rows } = await this.db().query<ItemRow>(
      `SELECT id, payload, hlc, deleted, device_id, seq FROM ${this.t.items} WHERE seq > ${after} ORDER BY seq ASC LIMIT ${max}`
    )
    return rows.map(toRemoteItem)
  }

  async getItems(ids: string[]): Promise<RemoteItem[]> {
    const out: RemoteItem[] = []
    const unique = [...new Set(ids)]
    for (let i = 0; i < unique.length; i += ID_CHUNK) {
      const group = unique.slice(i, i + ID_CHUNK)
      const { rows } = await this.db().query<ItemRow>(
        `SELECT id, payload, hlc, deleted, device_id, seq FROM ${this.t.items} WHERE id IN (${group.map(() => '?').join(', ')})`,
        group
      )
      out.push(...rows.map(toRemoteItem))
    }
    return out
  }

  async head(): Promise<number> {
    const { rows } = await this.db().query<{ v: number | null }>(
      `SELECT COALESCE(MAX(seq), 0) AS v FROM ${this.t.items}`
    )
    return Number(rows[0]?.v ?? 0)
  }

  async listIndex(): Promise<{ id: string; hlc: string }[]> {
    const out: { id: string; hlc: string }[] = []
    let after: string | null = null
    for (;;) {
      const { rows }: { rows: { id: string; hlc: string }[] } =
        after === null
          ? await this.db().query(`SELECT id, hlc FROM ${this.t.items} ORDER BY id LIMIT ${INDEX_PAGE}`)
          : await this.db().query(
              `SELECT id, hlc FROM ${this.t.items} WHERE id > ? ORDER BY id LIMIT ${INDEX_PAGE}`,
              [after]
            )
      for (const r of rows) out.push({ id: String(r.id), hlc: String(r.hlc) })
      if (rows.length < INDEX_PAGE) return out
      after = String(rows[rows.length - 1].id)
    }
  }

  async upsertDevice(device: RemoteDevice): Promise<void> {
    const lastSeen = checkInt(device.lastSeen, 0, 'lastSeen')
    const info = device.info ? toBase64(device.info) : null
    await this.db().query(
      `INSERT INTO ${this.t.devices} (id, info, last_seen) VALUES (?, ${info === null ? 'NULL' : '?'}, ${lastSeen}) ` +
        'ON CONFLICT (id) DO UPDATE SET info = excluded.info, last_seen = excluded.last_seen',
      info === null ? [device.id] : [device.id, info]
    )
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const { rows } = await this.db().query<DeviceRow>(
      `SELECT id, info, last_seen FROM ${this.t.devices} ORDER BY id`
    )
    return rows.map((r) => ({ id: String(r.id), info: fromBase64(r.info), lastSeen: Number(r.last_seen) }))
  }

  async deleteDevice(id: string): Promise<void> {
    await this.db().query(`DELETE FROM ${this.t.devices} WHERE id = ?`, [id])
  }

  private db(): D1Client {
    if (!this.client) throw new SyncAdapterError('network', 'Not connected to Cloudflare D1.')
    return this.client
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

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

function fromBase64(value: string | null | undefined): Buffer | null {
  return value === null || value === undefined ? null : Buffer.from(value, 'base64')
}

function toRemoteItem(r: ItemRow): RemoteItem {
  return {
    id: String(r.id),
    payload: fromBase64(r.payload),
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

function statementSize(s: D1Statement): number {
  return s.sql.length + (s.params ?? []).reduce((n, p) => n + p.length, 0) + 64
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
