import { SECRET_MASK } from '@shared/schemas'
import type { SyncDbConfig, SyncDevice, SyncIntervals, SyncStatus, SyncTestResult } from '@shared/types'
import type { Emitter } from '../services/emitter'
import type { KdfParams } from '../vault/crypto'
import type { LocalDb } from '../vault/db'
import type { Keystore } from '../vault/keystore'
import type { VaultService } from '../vault/vault-service'
import { SchemaTooNewError, type SyncAdapter, SyncAdapterError } from './adapter'
import { type EngineState, SyncEngine, SyncError } from './engine'

export interface SyncServiceDeps {
  vault: VaultService
  keystore: Keystore
  db: LocalDb
  emitter: Emitter
  deviceId: string
  deviceInfo: () => { name: string; platform: string; appVersion: string }
  createAdapter: (cfg: SyncDbConfig) => SyncAdapter
  describe: (cfg: SyncDbConfig) => string
  kdf?: KdfParams
}

const CONFIG_KEY = 'sync.config'
const STATE_KEY = 'sync.state'
const INTERVALS_KEY = 'sync.intervals'
const LOCAL_CHANGE_DEBOUNCE_MS = 1500
const FOCUS_THROTTLE_MS = 30_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Restores secrets the renderer only saw masked. */
function unmaskConfig(next: SyncDbConfig, prev: SyncDbConfig | null): SyncDbConfig {
  if (next.kind === 'd1') {
    const apiToken = next.apiToken === SECRET_MASK ? (prev?.kind === 'd1' ? prev.apiToken : '') : next.apiToken
    return { ...next, apiToken }
  }
  if (next.kind === 'webdav') {
    const password =
      next.password === SECRET_MASK ? (prev?.kind === 'webdav' ? prev.password : undefined) : next.password
    return { ...next, password }
  }
  const password =
    next.password === SECRET_MASK
      ? prev && prev.kind !== 'd1' && prev.kind !== 'webdav'
        ? prev.password
        : undefined
      : next.password
  return { ...next, password }
}

/** Background sync orchestration: triggers, single-flight runs, backoff, status reporting. */
export class SyncService {
  private engine: SyncEngine | null = null
  private config: SyncDbConfig | null = null
  private status: SyncStatus = {
    configured: false,
    state: 'disabled',
    pendingChanges: 0,
    realtime: false,
    pollIntervalSec: 60,
    reconcileIntervalMin: 15
  }
  private running: Promise<void> | null = null
  private pendingRun = false
  private pendingReconcile = false
  private pollTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private failures = 0
  private unsubscribe: (() => Promise<void>) | null = null
  private lastFocusSync = 0
  private generation = 0

  constructor(private readonly deps: SyncServiceDeps) {}

  // ------------------------------------------------------------------ status

  getStatus(): SyncStatus {
    const pending = this.deps.vault.isLoaded && this.config ? this.deps.vault.pendingCount() : 0
    return { ...this.status, pendingChanges: pending }
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.emitter.emit('sync.status', this.getStatus())
  }

  getConfigMasked(): SyncDbConfig | null {
    const cfg = this.config ?? (this.deps.keystore.unlocked ? this.loadConfig() : null)
    if (!cfg) return null
    if (cfg.kind === 'd1') return { ...cfg, apiToken: cfg.apiToken ? SECRET_MASK : '' }
    return { ...cfg, password: cfg.password ? SECRET_MASK : undefined }
  }

  private loadConfig(): SyncDbConfig | null {
    try {
      return this.deps.vault.getSecure<SyncDbConfig>(CONFIG_KEY) ?? null
    } catch {
      return null
    }
  }

  private intervals(adapter?: SyncAdapter): SyncIntervals {
    const stored = this.deps.db.kvGetJson<Partial<SyncIntervals>>(INTERVALS_KEY) ?? {}
    return {
      pollIntervalSec: stored.pollIntervalSec ?? adapter?.capabilities.defaultPollSec ?? 60,
      reconcileIntervalMin: stored.reconcileIntervalMin ?? adapter?.capabilities.defaultReconcileMin ?? 15
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Starts background sync if configured. Call after the vault is unlocked. */
  async start(): Promise<void> {
    this.config = this.loadConfig()
    if (!this.config) {
      this.setStatus({ configured: false, state: 'disabled' })
      return
    }
    const state = this.deps.vault.getSecure<EngineState>(STATE_KEY) ?? null
    const adapter = this.deps.createAdapter(this.config)
    this.engine = new SyncEngine(adapter, this.engineDeps(), state)
    const iv = this.intervals(adapter)
    this.setStatus({
      configured: true,
      state: 'idle',
      dbKind: this.config.kind,
      dbLabel: this.deps.describe(this.config),
      realtime: adapter.capabilities.realtime,
      ...iv
    })
    this.startLoops()
    void this.requestSync()
  }

  private engineDeps() {
    return {
      vault: this.deps.vault,
      keystore: this.deps.keystore,
      deviceId: this.deps.deviceId,
      deviceInfo: this.deps.deviceInfo,
      kdf: this.deps.kdf,
      saveState: (s: EngineState) => this.deps.vault.setSecure(STATE_KEY, s)
    }
  }

  private startLoops(): void {
    this.stopLoops()
    const gen = ++this.generation
    const iv = this.intervals(this.engine?.adapter)
    this.pollTimer = setInterval(() => void this.poll(), Math.max(5, iv.pollIntervalSec) * 1000)
    const adapter = this.engine?.adapter
    if (adapter?.subscribe) {
      const subscribe = (): void => {
        adapter
          .subscribe!(
            () => void this.requestSync(),
            () => {
              this.unsubscribe = null
              setTimeout(() => gen === this.generation && subscribe(), 15_000)
            }
          )
          .then(
            (unsub) => {
              if (gen !== this.generation) void unsub()
              else this.unsubscribe = unsub
            },
            () => setTimeout(() => gen === this.generation && subscribe(), 30_000)
          )
      }
      subscribe()
    }
  }

  private stopLoops(): void {
    this.generation++
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.pollTimer = this.debounceTimer = this.retryTimer = null
    const unsub = this.unsubscribe
    this.unsubscribe = null
    void unsub?.().catch(() => {})
  }

  /** Stops background sync (vault locked / app quitting). */
  async stop(): Promise<void> {
    this.stopLoops()
    const adapter = this.engine?.adapter
    this.engine = null
    await this.running?.catch(() => {})
    await adapter?.close().catch(() => {})
  }

  /**
   * Adapters connect lazily (connect() is idempotent), so a database that is unreachable when the app
   * starts is simply retried by the normal backoff instead of leaving sync offline until restart.
   */
  private async ready(): Promise<SyncEngine> {
    const engine = this.engine
    if (!engine) throw new Error('Sync is not configured')
    await engine.adapter.connect()
    return engine
  }

  // ------------------------------------------------------------------ triggers

  onLocalChange(): void {
    if (!this.engine) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.requestSync()
    }, LOCAL_CHANGE_DEBOUNCE_MS)
    this.setStatus({})
  }

  onFocus(): void {
    if (!this.engine || Date.now() - this.lastFocusSync < FOCUS_THROTTLE_MS) return
    this.lastFocusSync = Date.now()
    void this.requestSync()
  }

  private async poll(): Promise<void> {
    const engine = this.engine
    if (!engine || this.running || this.status.state === 'needs-password') return
    try {
      await engine.adapter.connect()
      const head = await engine.adapter.head()
      const reconcileDue = Date.now() - (engine.state?.lastReconcileAt ?? 0) >= this.status.reconcileIntervalMin * 60_000
      if (head > (engine.state?.cursor ?? 0) || this.deps.vault.pendingCount() > 0 || reconcileDue || this.status.state !== 'idle')
        await this.requestSync()
    } catch (err) {
      this.handleError(err)
    }
  }

  requestSync(reconcile = false): Promise<void> {
    const engine = this.engine
    if (!engine) return Promise.resolve()
    if (this.running) {
      this.pendingRun = true
      this.pendingReconcile ||= reconcile
      return this.running
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.running = (async () => {
      let first = true
      while ((first || this.pendingRun) && this.engine === engine) {
        first = false
        this.pendingRun = false
        const rec = reconcile || this.pendingReconcile
        reconcile = false
        this.pendingReconcile = false
        this.setStatus({ state: 'syncing' })
        try {
          await engine.adapter.connect()
          await engine.syncOnce({ reconcile: rec, reconcileIntervalMs: this.status.reconcileIntervalMin * 60_000 })
          this.failures = 0
          this.setStatus({ state: 'idle', lastSyncAt: Date.now(), lastError: undefined })
        } catch (err) {
          this.handleError(err)
          break
        }
      }
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private handleError(err: unknown): void {
    const msg = errorMessage(err)
    if (err instanceof SyncError) {
      if (err.kind === 'needs-password') return this.setStatus({ state: 'needs-password', lastError: msg })
      this.setStatus({ state: 'error', lastError: msg })
      return
    }
    this.failures++
    const transient = err instanceof SyncAdapterError ? err.transient : !(err instanceof SchemaTooNewError)
    this.setStatus({ state: transient ? 'offline' : 'error', lastError: msg })
    const delay = Math.min(5 * 60_000, (transient ? 5_000 : 30_000) * 2 ** Math.min(this.failures - 1, 6))
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.requestSync()
    }, delay)
  }

  // ------------------------------------------------------------------ user actions

  async test(input: SyncDbConfig): Promise<SyncTestResult> {
    const cfg = unmaskConfig(input, this.config ?? this.loadConfig())
    const adapter = this.deps.createAdapter(cfg)
    const started = Date.now()
    try {
      await adapter.connect()
      await adapter.ensureSchema()
      const meta = await adapter.getVaultMeta()
      return { ok: true, hasVault: !!meta, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, hasVault: false, error: errorMessage(err) }
    } finally {
      await adapter.close().catch(() => {})
    }
  }

  private async setup(input: SyncDbConfig, mode: 'create' | 'join', masterPassword: string): Promise<SyncStatus> {
    if (masterPassword.length < 8) throw new Error('The master password must be at least 8 characters')
    const cfg = unmaskConfig(input, this.config ?? this.loadConfig())
    await this.stop()
    const adapter = this.deps.createAdapter(cfg)
    try {
      await adapter.connect()
      const engine = new SyncEngine(adapter, this.engineDeps(), null)
      this.setStatus({ configured: true, state: 'syncing', dbKind: cfg.kind, dbLabel: this.deps.describe(cfg), lastError: undefined })
      if (mode === 'create') await engine.createVault(masterPassword)
      else await engine.joinVault(masterPassword)
      this.deps.vault.setSecure(CONFIG_KEY, cfg)
      this.config = cfg
      this.engine = engine
      this.failures = 0
      this.setStatus({
        configured: true,
        state: 'idle',
        lastSyncAt: Date.now(),
        realtime: adapter.capabilities.realtime,
        ...this.intervals(adapter)
      })
      this.startLoops()
      return this.getStatus()
    } catch (err) {
      await adapter.close().catch(() => {})
      this.engine = null
      const prev = this.loadConfig()
      if (prev) await this.start()
      else this.setStatus({ configured: false, state: 'disabled', lastError: errorMessage(err) })
      throw err
    }
  }

  create(cfg: SyncDbConfig, masterPassword: string): Promise<SyncStatus> {
    return this.setup(cfg, 'create', masterPassword)
  }

  join(cfg: SyncDbConfig, masterPassword: string): Promise<SyncStatus> {
    return this.setup(cfg, 'join', masterPassword)
  }

  async unlock(masterPassword: string): Promise<SyncStatus> {
    if (!this.engine) throw new Error('Sync is not configured')
    await this.running?.catch(() => {})
    const engine = await this.ready()
    await engine.unlockWithPassword(masterPassword)
    this.failures = 0
    this.setStatus({ state: 'idle', lastSyncAt: Date.now(), lastError: undefined })
    return this.getStatus()
  }

  async syncNow(): Promise<SyncStatus> {
    if (!this.engine) throw new Error('Sync is not configured')
    if (this.status.state === 'needs-password') return this.getStatus()
    await this.requestSync(true)
    if (this.running) await this.running
    return this.getStatus()
  }

  async disconnect(): Promise<void> {
    await this.stop()
    this.deps.vault.deleteSecure(CONFIG_KEY)
    this.deps.vault.deleteSecure(STATE_KEY)
    this.config = null
    this.setStatus({ configured: false, state: 'disabled', lastError: undefined, lastSyncAt: undefined, dbKind: undefined, dbLabel: undefined })
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.engine) throw new Error('Sync is not configured')
    if (newPassword.length < 8) throw new Error('The master password must be at least 8 characters')
    const engine = await this.ready()
    await engine.changePassword(oldPassword, newPassword)
  }

  async rotateKey(masterPassword: string): Promise<void> {
    if (!this.engine) throw new Error('Sync is not configured')
    await this.running?.catch(() => {})
    this.setStatus({ state: 'syncing' })
    try {
      const engine = await this.ready()
      await engine.rotateKey(masterPassword)
      this.setStatus({ state: 'idle', lastSyncAt: Date.now(), lastError: undefined })
    } catch (err) {
      this.handleError(err)
      throw err
    }
  }

  async devices(): Promise<SyncDevice[]> {
    if (!this.engine) return []
    const engine = await this.ready()
    return engine.devices()
  }

  setIntervals(iv: SyncIntervals): SyncStatus {
    const clean: SyncIntervals = {
      pollIntervalSec: Math.min(3600, Math.max(5, Math.round(iv.pollIntervalSec))),
      reconcileIntervalMin: Math.min(24 * 60, Math.max(1, Math.round(iv.reconcileIntervalMin)))
    }
    this.deps.db.kvSetJson(INTERVALS_KEY, clean)
    this.setStatus(clean)
    if (this.engine) this.startLoops()
    return this.getStatus()
  }
}
