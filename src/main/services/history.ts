import type { HistoryEntry } from '@shared/types'
import { decryptJson, encryptJson } from '../vault/crypto'
import { type LocalDb, toBuffer } from '../vault/db'
import type { Keystore } from '../vault/keystore'
import type { Emitter } from './emitter'

const AAD = 'sshtool:history'
const MAX_ENTRIES = 1000

type StoredEntry = Omit<HistoryEntry, 'id'>

/** Connection history ("Logs"). Device-local and encrypted with the vault key. */
export class HistoryService {
  constructor(
    private readonly db: LocalDb,
    private readonly keystore: Keystore,
    private readonly emitter: Emitter
  ) {}

  add(entry: StoredEntry): number | undefined {
    if (!this.keystore.unlocked) return undefined
    const res = this.db.db
      .prepare('INSERT INTO history (started_at, payload) VALUES (?, ?)')
      .run(entry.startedAt, encryptJson(this.keystore.key, entry, AAD))
    this.db.db
      .prepare('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY started_at DESC LIMIT ?)')
      .run(MAX_ENTRIES)
    this.emitter.emit('history.changed', {})
    return Number(res.lastInsertRowid)
  }

  update(id: number | undefined, patch: Partial<StoredEntry>): void {
    if (id === undefined || !this.keystore.unlocked) return
    const row = this.db.db.prepare('SELECT payload FROM history WHERE id = ?').get(id) as
      | { payload: Uint8Array }
      | undefined
    if (!row) return
    const cur = decryptJson<StoredEntry>(this.keystore.key, toBuffer(row.payload)!, AAD)
    this.db.db
      .prepare('UPDATE history SET payload = ? WHERE id = ?')
      .run(encryptJson(this.keystore.key, { ...cur, ...patch }, AAD), id)
    this.emitter.emit('history.changed', {})
  }

  list(limit = 200): HistoryEntry[] {
    if (!this.keystore.unlocked) return []
    const rows = this.db.db
      .prepare('SELECT id, payload FROM history ORDER BY started_at DESC LIMIT ?')
      .all(limit) as { id: number; payload: Uint8Array }[]
    const out: HistoryEntry[] = []
    for (const r of rows) {
      try {
        out.push({ id: Number(r.id), ...decryptJson<StoredEntry>(this.keystore.key, toBuffer(r.payload)!, AAD) })
      } catch {
        // entries encrypted with a previous key are skipped
      }
    }
    return out
  }

  clear(): void {
    this.db.db.prepare('DELETE FROM history').run()
    this.emitter.emit('history.changed', {})
  }
}
