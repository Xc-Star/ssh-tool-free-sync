import { DatabaseSync } from 'node:sqlite'

/**
 * Local persistence (one SQLite file per device) built on Node's bundled `node:sqlite`,
 * so no native module needs compiling on any platform.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload BLOB,
    hlc TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    dirty INTEGER NOT NULL DEFAULT 0,
    local_only INTEGER NOT NULL DEFAULT 0,
    remote_tombstone INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX items_dirty ON items(dirty);
  CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    payload BLOB NOT NULL
  );
  `
]

export interface ItemRow {
  id: string
  kind: string
  payload: Uint8Array | null
  hlc: string
  deleted: number
  dirty: number
  local_only: number
  remote_tombstone: number
}

export class LocalDb {
  readonly db: DatabaseSync
  private inTx = false

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  /** Runs `fn` inside a single IMMEDIATE transaction (nested calls join the outer transaction). */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.inTx = true
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this.inTx = false
    }
  }

  kvGet(k: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined
    return row?.v
  }

  kvSet(k: string, v: string): void {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v)
  }

  kvDelete(k: string): void {
    this.db.prepare('DELETE FROM kv WHERE k = ?').run(k)
  }

  kvKeys(prefix: string): string[] {
    const rows = this.db.prepare('SELECT k FROM kv WHERE k LIKE ?').all(`${prefix}%`) as { k: string }[]
    return rows.map((r) => r.k)
  }

  kvGetJson<T>(k: string): T | undefined {
    const v = this.kvGet(k)
    if (v === undefined) return undefined
    try {
      return JSON.parse(v) as T
    } catch {
      return undefined
    }
  }

  kvSetJson(k: string, v: unknown): void {
    this.kvSet(k, JSON.stringify(v))
  }

  allItemRows(): ItemRow[] {
    return this.db.prepare('SELECT * FROM items').all() as unknown as ItemRow[]
  }

  getItemRow(id: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemRow | undefined
  }

  putItemRow(r: ItemRow): void {
    this.db
      .prepare(
        `INSERT INTO items (id, kind, payload, hlc, deleted, dirty, local_only, remote_tombstone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, payload = excluded.payload, hlc = excluded.hlc,
           deleted = excluded.deleted, dirty = excluded.dirty, local_only = excluded.local_only,
           remote_tombstone = excluded.remote_tombstone`
      )
      .run(r.id, r.kind, r.payload, r.hlc, r.deleted, r.dirty, r.local_only, r.remote_tombstone)
  }

  close(): void {
    this.db.close()
  }
}

export function toBuffer(u8: Uint8Array | null | undefined): Buffer | null {
  if (!u8) return null
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)
}
