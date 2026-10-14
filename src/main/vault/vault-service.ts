import {
  DEFAULT_LOCAL_ONLY_KINDS,
  ITEM_KINDS,
  KIND_SCHEMAS,
  type Item,
  type ItemKind,
  type KindInput
} from '@shared/schemas'
import { uuidv7 } from '@shared/util'
import { z } from 'zod'
import { decryptJson, DecryptError, encryptJson } from './crypto'
import { type ItemRow, type LocalDb, toBuffer } from './db'
import type { Hlc } from './hlc'
import type { Keystore } from './keystore'
import { stripMasks, unmaskData } from './secrets'

/** Encrypted content of an item (what is stored locally and remotely). */
interface Envelope {
  kind: ItemKind
  data: unknown
  createdAt: number
  updatedAt: number
}

interface RowMeta {
  kind: string
  hlc: string
  deleted: boolean
  dirty: boolean
  localOnly: boolean
  remoteTombstone: boolean
}

/** Record pushed to / pulled from the sync database. */
export interface SyncRecord {
  id: string
  /** Encrypted envelope (null for tombstones). */
  payload: Buffer | null
  hlc: string
  deleted: boolean
}

export interface RemoteSyncRecord extends SyncRecord {
  deviceId: string
  seq: number
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

const itemAad = (id: string): string => `sshtool:item:${id}`
const kvAad = (k: string): string => `sshtool:kv:${k}`
const SECURE_PREFIX = 'secure:'

function isItemKind(k: unknown): k is ItemKind {
  return typeof k === 'string' && (ITEM_KINDS as readonly string[]).includes(k)
}

/**
 * The encrypted local vault. All items are kept decrypted in memory while unlocked; the SQLite
 * file only ever contains AES-GCM ciphertext.
 */
export class VaultService {
  private items = new Map<string, Item>()
  private meta = new Map<string, RowMeta>()
  private undecryptable = new Set<string>()
  private loaded = false

  /** Called with the set of kinds that changed (UI refresh). */
  onChange: (kinds: ItemKind[]) => void = () => {}
  /** Called after a local (user) modification that must be synced. */
  onLocalWrite: () => void = () => {}

  constructor(
    private readonly db: LocalDb,
    private readonly keystore: Keystore,
    readonly hlc: Hlc
  ) {}

  get isLoaded(): boolean {
    return this.loaded
  }

  // ------------------------------------------------------------------ lifecycle

  load(): void {
    const key = this.keystore.key
    this.items.clear()
    this.meta.clear()
    this.undecryptable.clear()
    for (const row of this.db.allItemRows()) {
      this.hlc.receive(row.hlc)
      this.meta.set(row.id, this.rowMeta(row))
      if (row.deleted || !row.payload) continue
      try {
        const env = decryptJson<Envelope>(key, toBuffer(row.payload)!, itemAad(row.id))
        const item = this.envelopeToItem(row.id, env, row.local_only === 1)
        if (item) this.items.set(row.id, item)
      } catch (err) {
        if (err instanceof DecryptError) this.undecryptable.add(row.id)
        else throw err
      }
    }
    this.loaded = true
  }

  unload(): void {
    this.items.clear()
    this.meta.clear()
    this.undecryptable.clear()
    this.loaded = false
  }

  /** Deletes all items, the connection history and every encrypted setting (used when the vault key is lost). */
  wipeLocal(): void {
    this.unload()
    this.db.tx(() => {
      this.db.db.exec('DELETE FROM items')
      this.db.db.exec('DELETE FROM history')
      for (const k of this.db.kvKeys(SECURE_PREFIX)) this.db.kvDelete(k)
    })
  }

  private rowMeta(row: ItemRow): RowMeta {
    return {
      kind: row.kind,
      hlc: row.hlc,
      deleted: row.deleted === 1,
      dirty: row.dirty === 1,
      localOnly: row.local_only === 1,
      remoteTombstone: row.remote_tombstone === 1
    }
  }

  private envelopeToItem(id: string, env: Envelope, localOnly: boolean): Item | null {
    if (!isItemKind(env.kind)) return null
    const parsed = (KIND_SCHEMAS[env.kind] as z.ZodObject).loose().safeParse(env.data)
    if (!parsed.success) return null
    return {
      id,
      kind: env.kind,
      data: parsed.data,
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
      localOnly
    } as Item
  }

  private ensureLoaded(): void {
    if (!this.loaded) throw new Error('vault is locked')
  }

  // ------------------------------------------------------------------ queries

  list<K extends ItemKind>(kind?: K): Item<K>[] {
    this.ensureLoaded()
    const all = [...this.items.values()]
    return (kind ? all.filter((i) => i.kind === kind) : all) as Item<K>[]
  }

  get<K extends ItemKind = ItemKind>(id: string | undefined, kind?: K): Item<K> | undefined {
    if (!id) return undefined
    this.ensureLoaded()
    const it = this.items.get(id)
    if (!it || (kind && it.kind !== kind)) return undefined
    return it as Item<K>
  }

  // ------------------------------------------------------------------ mutations

  private validate<K extends ItemKind>(kind: K, data: unknown): Item<K>['data'] {
    const schema = KIND_SCHEMAS[kind] as z.ZodObject
    const res = schema.loose().safeParse(data)
    if (!res.success) throw new ValidationError(z.prettifyError(res.error))
    return stripMasks(kind, res.data) as Item<K>['data']
  }

  private writeItem(item: Item, opts: { dirty: boolean; remoteTombstone?: boolean }): void {
    const ts = this.hlc.tick()
    const env: Envelope = { kind: item.kind, data: item.data, createdAt: item.createdAt, updatedAt: item.updatedAt }
    const prev = this.meta.get(item.id)
    const row: ItemRow = {
      id: item.id,
      kind: item.kind,
      payload: encryptJson(this.keystore.key, env, itemAad(item.id)),
      hlc: ts,
      deleted: 0,
      dirty: opts.dirty && !item.localOnly ? 1 : 0,
      local_only: item.localOnly ? 1 : 0,
      remote_tombstone: (opts.remoteTombstone ?? prev?.remoteTombstone) ? 1 : 0
    }
    this.db.putItemRow(row)
    this.meta.set(item.id, this.rowMeta(row))
    this.items.set(item.id, item)
    this.undecryptable.delete(item.id)
  }

  upsert<K extends ItemKind>(kind: K, input: KindInput[K], opts: { id?: string; localOnly?: boolean } = {}): Item<K> {
    this.ensureLoaded()
    if (!isItemKind(kind)) throw new ValidationError(`unknown kind ${String(kind)}`)
    const id = opts.id ?? uuidv7()
    const existing = this.items.get(id)
    if (existing && existing.kind !== kind) throw new ValidationError('kind mismatch')
    const data = this.validate(kind, unmaskData(kind, input, existing?.data))
    const now = Date.now()
    const localOnly = opts.localOnly ?? existing?.localOnly ?? DEFAULT_LOCAL_ONLY_KINDS.includes(kind)
    const item = {
      id,
      kind,
      data,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      localOnly
    } as Item<K>
    this.db.tx(() => this.writeItem(item as Item, { dirty: true }))
    this.changed([kind])
    return item
  }

  /** Shallow-merges `patch` into the item data (`undefined` values remove the field). */
  patch(id: string, patch: Record<string, unknown>): Item {
    this.ensureLoaded()
    const existing = this.items.get(id)
    if (!existing) throw new ValidationError('item not found')
    const merged: Record<string, unknown> = { ...(existing.data as Record<string, unknown>) }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete merged[k]
      else merged[k] = v
    }
    return this.upsert(existing.kind, unmaskData(existing.kind, merged, existing.data), { id })
  }

  remove(ids: string[]): void {
    this.ensureLoaded()
    const kinds = new Set<ItemKind>()
    this.db.tx(() => {
      for (const id of ids) {
        const it = this.items.get(id)
        const m = this.meta.get(id)
        if (!m || m.deleted) continue
        const row: ItemRow = {
          id,
          kind: m.kind,
          payload: null,
          hlc: this.hlc.tick(),
          deleted: 1,
          dirty: m.localOnly ? 0 : 1,
          local_only: m.localOnly ? 1 : 0,
          remote_tombstone: m.remoteTombstone ? 1 : 0
        }
        this.db.putItemRow(row)
        this.meta.set(id, this.rowMeta(row))
        this.items.delete(id)
        if (it) kinds.add(it.kind)
      }
    })
    if (kinds.size) this.changed([...kinds])
  }

  duplicate(id: string): Item {
    const it = this.items.get(id)
    if (!it) throw new ValidationError('item not found')
    const data = structuredClone(it.data) as Record<string, unknown>
    if (typeof data.label === 'string') data.label = `${data.label} (copy)`
    else if (typeof data.name === 'string') data.name = `${data.name} (copy)`
    return this.upsert(it.kind, data as never, { localOnly: it.localOnly })
  }

  /**
   * Switches device-only mode. Turning it on removes the item from the sync database
   * (a tombstone is pushed) while keeping it locally.
   */
  setLocalOnly(id: string, localOnly: boolean): Item {
    this.ensureLoaded()
    const it = this.items.get(id)
    if (!it) throw new ValidationError('item not found')
    if (it.localOnly === localOnly) return it
    const item = { ...it, localOnly, updatedAt: Date.now() } as Item
    this.db.tx(() => this.writeItem(item, { dirty: !localOnly, remoteTombstone: localOnly }))
    this.changed([it.kind])
    return item
  }

  private changed(kinds: ItemKind[], local = true): void {
    this.onChange(kinds)
    if (local) this.onLocalWrite()
  }

  // ------------------------------------------------------------------ secure key-value (encrypted with VK)

  getSecure<T>(k: string): T | undefined {
    const v = this.db.kvGet(SECURE_PREFIX + k)
    if (!v) return undefined
    return decryptJson<T>(this.keystore.key, Buffer.from(v, 'base64'), kvAad(k))
  }

  setSecure(k: string, value: unknown): void {
    this.db.kvSet(SECURE_PREFIX + k, encryptJson(this.keystore.key, value, kvAad(k)).toString('base64'))
  }

  deleteSecure(k: string): void {
    this.db.kvDelete(SECURE_PREFIX + k)
  }

  // ------------------------------------------------------------------ sync support

  /** Encrypted records that must be pushed to the sync database. */
  pendingPush(limit = 200): SyncRecord[] {
    const rows = this.db.db
      .prepare(
        `SELECT * FROM items WHERE (dirty = 1 AND local_only = 0) OR (local_only = 1 AND remote_tombstone = 1)
         ORDER BY hlc LIMIT ?`
      )
      .all(limit) as unknown as ItemRow[]
    return rows.map((r) => {
      const tomb = r.local_only === 1 || r.deleted === 1
      return { id: r.id, payload: tomb ? null : toBuffer(r.payload), hlc: r.hlc, deleted: tomb }
    })
  }

  pendingCount(): number {
    const row = this.db.db
      .prepare(
        'SELECT COUNT(*) AS n FROM items WHERE (dirty = 1 AND local_only = 0) OR (local_only = 1 AND remote_tombstone = 1)'
      )
      .get() as { n: number }
    return Number(row.n)
  }

  /** Clears the dirty flag of records that were pushed and have not changed since. */
  markPushed(records: { id: string; hlc: string }[]): void {
    const stmt = this.db.db.prepare('UPDATE items SET dirty = 0, remote_tombstone = 0 WHERE id = ? AND hlc = ?')
    this.db.tx(() => {
      for (const r of records) {
        stmt.run(r.id, r.hlc)
        const m = this.meta.get(r.id)
        if (m && m.hlc === r.hlc) {
          m.dirty = false
          m.remoteTombstone = false
        }
      }
    })
  }

  /** Marks the given synced items dirty so they are pushed again (reconcile). */
  markDirty(ids: string[]): void {
    const stmt = this.db.db.prepare('UPDATE items SET dirty = 1 WHERE id = ? AND local_only = 0')
    this.db.tx(() => {
      for (const id of ids) {
        stmt.run(id)
        const m = this.meta.get(id)
        if (m && !m.localOnly) m.dirty = true
      }
    })
  }

  /** Marks every live synced item dirty (initial upload when creating / joining a sync vault). */
  markAllDirty(): void {
    this.db.db.prepare('UPDATE items SET dirty = 1 WHERE local_only = 0 AND deleted = 0').run()
    for (const m of this.meta.values()) if (!m.localOnly && !m.deleted) m.dirty = true
  }

  /** id → hlc of every synced (non device-only) row, tombstones included. */
  syncIndex(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [id, m] of this.meta) if (!m.localOnly) out.set(id, m.hlc)
    return out
  }

  localHlc(id: string): string | undefined {
    return this.meta.get(id)?.hlc
  }

  /**
   * Applies records pulled from the sync database using last-writer-wins on the HLC.
   * Returns ids that could not be decrypted (encrypted with another vault key).
   */
  applyRemote(records: RemoteSyncRecord[]): { applied: number; undecryptable: string[] } {
    this.ensureLoaded()
    const key = this.keystore.key
    const kinds = new Set<ItemKind>()
    const failed: string[] = []
    let applied = 0
    this.db.tx(() => {
      for (const r of records) {
        this.hlc.receive(r.hlc)
        const local = this.meta.get(r.id)
        if (local?.localOnly) continue
        if (local && local.hlc >= r.hlc) continue
        if (r.deleted || !r.payload) {
          const kind = local?.kind ?? 'unknown'
          const row: ItemRow = {
            id: r.id,
            kind,
            payload: null,
            hlc: r.hlc,
            deleted: 1,
            dirty: 0,
            local_only: 0,
            remote_tombstone: 0
          }
          this.db.putItemRow(row)
          this.meta.set(r.id, this.rowMeta(row))
          const it = this.items.get(r.id)
          if (it) {
            kinds.add(it.kind)
            this.items.delete(r.id)
          }
          applied++
          continue
        }
        let env: Envelope
        try {
          env = decryptJson<Envelope>(key, r.payload, itemAad(r.id))
        } catch (err) {
          if (err instanceof DecryptError) {
            failed.push(r.id)
            continue
          }
          throw err
        }
        const item = this.envelopeToItem(r.id, env, false)
        const row: ItemRow = {
          id: r.id,
          kind: isItemKind(env.kind) ? env.kind : 'unknown',
          payload: r.payload,
          hlc: r.hlc,
          deleted: 0,
          dirty: 0,
          local_only: 0,
          remote_tombstone: 0
        }
        this.db.putItemRow(row)
        this.meta.set(r.id, this.rowMeta(row))
        this.undecryptable.delete(r.id)
        const prev = this.items.get(r.id)
        if (prev) kinds.add(prev.kind)
        if (item) {
          this.items.set(r.id, item)
          kinds.add(item.kind)
        } else {
          this.items.delete(r.id)
        }
        applied++
      }
    })
    if (kinds.size) this.changed([...kinds], false)
    return { applied, undecryptable: failed }
  }

  /**
   * Re-encrypts everything stored locally with `newKey` and swaps the vault key atomically.
   * `touch` assigns fresh HLC timestamps (key rotation); `markDirty` queues all items for upload.
   */
  reencrypt(newKey: Buffer, opts: { touch: boolean; markDirty: boolean }): void {
    const oldKey = this.keystore.key
    this.db.tx(() => {
      for (const row of this.db.allItemRows()) {
        let payload = row.payload
        if (payload) {
          try {
            const env = decryptJson<Envelope>(oldKey, toBuffer(payload)!, itemAad(row.id))
            payload = encryptJson(newKey, env, itemAad(row.id))
          } catch (err) {
            if (!(err instanceof DecryptError)) throw err
            continue
          }
        }
        const live = row.deleted === 0
        this.db.putItemRow({
          ...row,
          payload,
          hlc: opts.touch && live ? this.hlc.tick() : row.hlc,
          dirty: (opts.markDirty && live) || row.dirty === 1 ? (row.local_only ? 0 : 1) : 0
        })
      }
      for (const k of this.db.kvKeys(SECURE_PREFIX)) {
        const name = k.slice(SECURE_PREFIX.length)
        const v = this.db.kvGet(k)
        if (!v) continue
        try {
          const value = decryptJson(oldKey, Buffer.from(v, 'base64'), kvAad(name))
          this.db.kvSet(k, encryptJson(newKey, value, kvAad(name)).toString('base64'))
        } catch (err) {
          if (!(err instanceof DecryptError)) throw err
        }
      }
      const hist = this.db.db.prepare('SELECT id, payload FROM history').all() as { id: number; payload: Uint8Array }[]
      const upd = this.db.db.prepare('UPDATE history SET payload = ? WHERE id = ?')
      for (const h of hist) {
        try {
          const value = decryptJson(oldKey, toBuffer(h.payload)!, 'sshtool:history')
          upd.run(encryptJson(newKey, value, 'sshtool:history'), h.id)
        } catch {
          this.db.db.prepare('DELETE FROM history WHERE id = ?').run(h.id)
        }
      }
      this.keystore.replaceKey(newKey)
    })
    this.load()
    this.onChange([...ITEM_KINDS])
  }

  /** Ids that exist locally but could not be decrypted with the current key. */
  undecryptableIds(): string[] {
    return [...this.undecryptable]
  }

  /**
   * Re-stamps live items with a fresh HLC and queues them for upload (used when the remote copy
   * is unreadable, e.g. it was written with an old vault key during a key rotation).
   */
  retouch(ids: string[]): void {
    this.ensureLoaded()
    this.db.tx(() => {
      for (const id of ids) {
        const it = this.items.get(id)
        if (it && !it.localOnly) this.writeItem(it, { dirty: true })
      }
    })
  }
}
