import type { PushItem, RemoteDevice, RemoteItem, SyncAdapter, VaultMeta } from '../../src/main/sync/adapter'

/** Shared in-memory "database" so several adapters (devices) can talk to the same store. */
export class MemoryStore {
  meta: VaultMeta | null = null
  items = new Map<string, RemoteItem>()
  devices = new Map<string, RemoteDevice>()
  seq = 0
  pushCalls = 0
}

export class MemoryAdapter implements SyncAdapter {
  readonly kind = 'postgres' as const
  readonly capabilities = { realtime: false, defaultPollSec: 30, defaultReconcileMin: 15 }
  readonly label = 'memory'
  offline = false

  constructor(readonly store: MemoryStore) {}

  private check(): void {
    if (this.offline) throw Object.assign(new Error('offline'), { code: 'network' })
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async ensureSchema(): Promise<void> {
    this.check()
  }
  async getVaultMeta(): Promise<VaultMeta | null> {
    this.check()
    return this.store.meta ? structuredClone(this.store.meta) : null
  }
  async createVaultMeta(meta: VaultMeta): Promise<boolean> {
    this.check()
    if (this.store.meta) return false
    this.store.meta = structuredClone(meta)
    return true
  }
  async updateVaultMeta(meta: VaultMeta): Promise<void> {
    this.check()
    this.store.meta = structuredClone(meta)
  }
  async push(items: PushItem[]): Promise<void> {
    this.check()
    this.store.pushCalls++
    for (const it of items) {
      const cur = this.store.items.get(it.id)
      if (cur && cur.hlc >= it.hlc) continue
      this.store.items.set(it.id, { ...it, payload: it.payload ? Buffer.from(it.payload) : null, seq: ++this.store.seq })
    }
  }
  async pull(afterSeq: number, limit: number): Promise<RemoteItem[]> {
    this.check()
    return [...this.store.items.values()]
      .filter((i) => i.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((i) => ({ ...i }))
  }
  async getItems(ids: string[]): Promise<RemoteItem[]> {
    this.check()
    return ids.map((id) => this.store.items.get(id)).filter((i): i is RemoteItem => !!i).map((i) => ({ ...i }))
  }
  async head(): Promise<number> {
    this.check()
    return this.store.seq
  }
  async listIndex(): Promise<{ id: string; hlc: string }[]> {
    this.check()
    return [...this.store.items.values()].map((i) => ({ id: i.id, hlc: i.hlc }))
  }
  async upsertDevice(d: RemoteDevice): Promise<void> {
    this.check()
    this.store.devices.set(d.id, d)
  }
  async listDevices(): Promise<RemoteDevice[]> {
    this.check()
    return [...this.store.devices.values()]
  }
  async deleteDevice(id: string): Promise<void> {
    this.store.devices.delete(id)
  }
}
