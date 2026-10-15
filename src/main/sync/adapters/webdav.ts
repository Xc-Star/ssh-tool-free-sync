import { randomUUID } from 'node:crypto'
import type { WebdavDbConfig } from '@shared/types'
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
import { WebdavClient, WebdavConflictError, webdavHostPath } from './webdav-client'

/** Compare-and-swap attempts before giving up on a busy remote file. */
const CAS_RETRIES = 30
/** Randomised pause between CAS retries so concurrent devices do not keep colliding. */
const CAS_BACKOFF_MS = 40

interface StoredItem {
  hlc: string
  /** base64 ciphertext, or null for tombstones. */
  payload: string | null
  deleted: boolean
  deviceId: string
  seq: number
}

interface StoredDevice {
  /** base64 ciphertext, or null. */
  info: string | null
  lastSeen: number
}

/** The single JSON document that holds the whole sync state inside the WebDAV folder. */
interface WebdavState {
  schemaVersion: number
  vault: VaultMeta | null
  /** Highest sequence number handed out so far. */
  counter: number
  items: Record<string, StoredItem>
  devices: Record<string, StoredDevice>
  /** Random token written on every save; used to verify writes on servers without strong ETags. */
  rev: string
}

export function webdavLabel(config: WebdavDbConfig): string {
  return `WebDAV · ${webdavHostPath(config.url ?? '')}`
}

function emptyState(): WebdavState {
  return { schemaVersion: 0, vault: null, counter: 0, items: {}, devices: {}, rev: '' }
}

function parseState(text: string): WebdavState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SyncAdapterError('unknown', 'The WebDAV sync file is not valid JSON.')
  }
  const doc = value as Partial<WebdavState> | null
  if (!doc || typeof doc !== 'object' || typeof doc.counter !== 'number' || typeof doc.schemaVersion !== 'number') {
    throw new SyncAdapterError('unknown', 'The WebDAV sync file is corrupt or belongs to another application.')
  }
  return {
    schemaVersion: doc.schemaVersion,
    vault: doc.vault ?? null,
    counter: doc.counter,
    items: doc.items && typeof doc.items === 'object' ? doc.items : {},
    devices: doc.devices && typeof doc.devices === 'object' ? doc.devices : {},
    rev: typeof doc.rev === 'string' ? doc.rev : ''
  }
}

function toRemoteItem(id: string, stored: StoredItem): RemoteItem {
  return {
    id,
    payload: fromBase64(stored.payload),
    hlc: stored.hlc,
    deleted: stored.deleted,
    deviceId: stored.deviceId,
    seq: stored.seq
  }
}

/**
 * Sync storage on a WebDAV collection (Nextcloud, ownCloud, Synology, Apache/nginx mod_dav, Box…).
 *
 * The whole state lives in one JSON file (`<prefix>sync.json`). Every mutation is a read-modify-write
 * guarded by the file's ETag (`If-Match`) — or `If-None-Match: *` when the file does not exist yet —
 * so concurrent devices serialise through the server instead of clobbering each other. Servers that do
 * not expose a strong ETag fall back to verifying a random `rev` token after the upload.
 */
export class WebdavAdapter implements SyncAdapter {
  readonly kind = 'webdav' as const
  readonly capabilities: AdapterCapabilities = {
    realtime: false,
    defaultPollSec: 60,
    defaultReconcileMin: 30
  }
  readonly label: string
  private client: WebdavClient | null = null
  private readonly file: string
  private cache: { state: WebdavState; etag: string | null } | null = null

  constructor(
    private readonly config: WebdavDbConfig,
    private readonly options: { fetchImpl?: typeof fetch } = {}
  ) {
    const prefix = checkPrefix(config.tablePrefix)
    this.file = `${prefix}sync.json`
    this.label = webdavLabel(config)
  }

  async connect(): Promise<void> {
    if (this.client) return
    if (!this.config.url?.trim()) throw new SyncAdapterError('config', 'A WebDAV URL is required.')
    const client = new WebdavClient({
      url: this.config.url,
      username: this.config.username,
      password: this.config.password,
      fetchImpl: this.options.fetchImpl
    })
    await client.ensureCollection()
    // Verifies that the credentials can also read the folder contents, not just PROPFIND it.
    await client.read(this.file)
    this.client = client
  }

  async close(): Promise<void> {
    this.client = null
    this.cache = null
  }

  async ensureSchema(): Promise<void> {
    const snap = await this.load(false)
    if (snap.state.schemaVersion > SCHEMA_VERSION) throw new SchemaTooNewError(snap.state.schemaVersion)
    if (snap.exists && snap.state.schemaVersion === SCHEMA_VERSION) return
    await this.mutate((s) => {
      s.schemaVersion = SCHEMA_VERSION
      return undefined
    })
  }

  async getVaultMeta(): Promise<VaultMeta | null> {
    return (await this.load()).state.vault
  }

  async createVaultMeta(meta: VaultMeta): Promise<boolean> {
    return this.mutate((s) => {
      if (s.vault) return false
      s.vault = meta
      return true
    })
  }

  async updateVaultMeta(meta: VaultMeta): Promise<void> {
    await this.mutate((s) => {
      s.vault = meta
      return undefined
    })
  }

  async push(items: PushItem[]): Promise<void> {
    const batch = latestById(items)
    if (!batch.length) return
    await this.mutate((s) => {
      for (const item of batch) {
        const prev = s.items[item.id]
        if (prev && prev.hlc >= item.hlc) continue
        s.items[item.id] = {
          hlc: item.hlc,
          payload: item.payload ? toBase64(item.payload) : null,
          deleted: item.deleted,
          deviceId: item.deviceId,
          seq: ++s.counter
        }
      }
      return undefined
    })
  }

  async pull(afterSeq: number, limit: number): Promise<RemoteItem[]> {
    const after = checkInt(afterSeq, 0, 'afterSeq')
    const max = checkInt(limit, 1, 'limit')
    const { state } = await this.load()
    const out: RemoteItem[] = []
    for (const [id, stored] of Object.entries(state.items)) {
      if (stored.seq > after) out.push(toRemoteItem(id, stored))
    }
    out.sort((a, b) => a.seq - b.seq)
    return out.slice(0, max)
  }

  async getItems(ids: string[]): Promise<RemoteItem[]> {
    const { state } = await this.load()
    const out: RemoteItem[] = []
    for (const id of new Set(ids)) {
      const stored = state.items[id]
      if (stored) out.push(toRemoteItem(id, stored))
    }
    return out
  }

  async head(): Promise<number> {
    return (await this.load()).state.counter
  }

  async listIndex(): Promise<{ id: string; hlc: string }[]> {
    const { state } = await this.load()
    return Object.entries(state.items).map(([id, stored]) => ({ id, hlc: stored.hlc }))
  }

  async upsertDevice(device: RemoteDevice): Promise<void> {
    const lastSeen = checkInt(device.lastSeen, 0, 'lastSeen')
    const info = device.info ? toBase64(device.info) : null
    await this.mutate((s) => {
      s.devices[device.id] = { info, lastSeen }
      return undefined
    })
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const { state } = await this.load()
    return Object.entries(state.devices).map(([id, stored]) => ({
      id,
      info: fromBase64(stored.info),
      lastSeen: stored.lastSeen
    }))
  }

  async deleteDevice(id: string): Promise<void> {
    await this.mutate((s) => {
      delete s.devices[id]
      return undefined
    })
  }

  private db(): WebdavClient {
    if (!this.client) throw new SyncAdapterError('network', 'Not connected to the WebDAV server.')
    return this.client
  }

  /** Reads the remote document, revalidating with the cached ETag when possible. */
  private async load(revalidate = true): Promise<{ state: WebdavState; etag: string | null; exists: boolean }> {
    const client = this.db()
    const ifNoneMatch = revalidate && this.cache?.etag ? this.cache.etag : undefined
    const res = await client.read(this.file, ifNoneMatch)
    if (res.notModified && this.cache) return { ...this.cache, exists: true }
    if (res.body === null) {
      this.cache = null
      return { state: emptyState(), etag: null, exists: false }
    }
    const state = parseState(res.body)
    this.cache = { state, etag: res.etag }
    return { state, etag: res.etag, exists: true }
  }

  /** Read-modify-write loop: applies `fn` to a copy of the document and retries on a lost race. */
  private async mutate<T>(fn: (state: WebdavState) => T): Promise<T> {
    const client = this.db()
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      if (attempt) await sleep(1 + Math.floor(Math.random() * CAS_BACKOFF_MS))
      const snap = await this.load(true)
      const next: WebdavState = {
        schemaVersion: snap.state.schemaVersion,
        vault: snap.state.vault,
        counter: snap.state.counter,
        items: { ...snap.state.items },
        devices: { ...snap.state.devices },
        rev: randomUUID()
      }
      const result = fn(next)
      let etag: string | null
      try {
        etag = await client.write(this.file, JSON.stringify(next), { etag: snap.etag, exists: snap.exists })
      } catch (err) {
        if (err instanceof WebdavConflictError) {
          this.cache = null
          continue
        }
        throw err
      }
      if (etag) {
        this.cache = { state: next, etag }
        return result
      }
      // The server returned no validator, so confirm our revision actually landed before trusting it.
      const check = await client.read(this.file)
      if (check.body === null || !matchesRev(check.body, next.rev)) {
        this.cache = null
        continue
      }
      this.cache = { state: next, etag: check.etag }
      return result
    }
    throw new SyncAdapterError(
      'network',
      'The WebDAV sync file is being modified by another device. Will retry on the next sync.'
    )
  }
}

function matchesRev(text: string, rev: string): boolean {
  try {
    return parseState(text).rev === rev
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

/** Keeps one entry per id (the greatest hlc), preserving first-seen order. */
function latestById(items: PushItem[]): PushItem[] {
  const byId = new Map<string, PushItem>()
  for (const item of items) {
    const prev = byId.get(item.id)
    if (!prev || prev.hlc < item.hlc) byId.set(item.id, item)
  }
  return [...byId.values()]
}
