import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { PREF_ITEM_ID, terminalPrefsSchema, type TerminalPrefs } from '@shared/schemas'
import type { LockStatus, SyncDbConfig } from '@shared/types'
import { AiService } from './ai/agent'
import { AiConfigStore } from './ai/config-store'
import type { FetchImpl } from './ai/providers'
import { ForwardService } from './forward/forward-service'
import type { Emitter } from './services/emitter'
import { HistoryService } from './services/history'
import { PromptService } from './services/prompts'
import { SettingsService } from './services/settings'
import { UpdateService } from './services/updater'
import { SessionManager } from './sessions/session-manager'
import { FsService } from './sftp/fs-service'
import { TransferQueue } from './sftp/transfer-queue'
import { KnownHostsService } from './ssh/known-hosts'
import { ConnectionPool } from './ssh/pool'
import type { SyncAdapter } from './sync/adapter'
import { SyncService } from './sync/sync-service'
import { DEFAULT_KDF, type KdfParams } from './vault/crypto'
import { LocalDb } from './vault/db'
import { Hlc } from './vault/hlc'
import { Keystore, KeystoreUnavailableError, type SecretProtector } from './vault/keystore'
import { VaultService } from './vault/vault-service'

export interface ContextOptions {
  userData: string
  emitter: Emitter
  protector: SecretProtector
  appVersion: string
  createAdapter: (cfg: SyncDbConfig) => SyncAdapter
  describeDb: (cfg: SyncDbConfig) => string
  openPath?: (p: string) => Promise<string>
  watchFile?: (p: string, onChange: () => void) => () => void
  /** HTTP client for AI providers (Electron net.fetch in the app; a fake in tests). */
  fetchImpl?: FetchImpl
  kdf?: KdfParams
  dbFile?: string
}

/** Wires all main-process services together. */
export class AppContext {
  readonly db: LocalDb
  readonly deviceId: string
  readonly keystore: Keystore
  readonly hlc: Hlc
  readonly vault: VaultService
  readonly settings: SettingsService
  readonly history: HistoryService
  readonly prompts: PromptService
  readonly knownHosts: KnownHostsService
  readonly pool: ConnectionPool
  readonly sessions: SessionManager
  readonly fs: FsService
  readonly transfers: TransferQueue
  readonly forwards: ForwardService
  readonly sync: SyncService
  readonly updater: UpdateService
  readonly aiStore: AiConfigStore
  readonly ai: AiService
  readonly emitter: Emitter
  private keystoreError: string | undefined

  constructor(readonly opts: ContextOptions) {
    this.emitter = opts.emitter
    this.db = new LocalDb(opts.dbFile ?? path.join(opts.userData, 'vault.db'))
    let deviceId = this.db.kvGet('device.id')
    if (!deviceId) {
      deviceId = randomBytes(8).toString('hex')
      this.db.kvSet('device.id', deviceId)
    }
    this.deviceId = deviceId
    const kdf = opts.kdf ?? DEFAULT_KDF
    this.keystore = new Keystore(this.db, opts.protector, kdf)
    this.hlc = new Hlc(deviceId)
    this.vault = new VaultService(this.db, this.keystore, this.hlc)
    this.settings = new SettingsService(this.db, this.emitter)
    this.history = new HistoryService(this.db, this.keystore, this.emitter)
    this.prompts = new PromptService(this.emitter)
    this.knownHosts = new KnownHostsService(this.vault, this.prompts)
    const keepAlive = (): number => this.terminalPrefs().keepAliveInterval
    const connectDeps = {
      vault: this.vault,
      prompts: this.prompts,
      knownHosts: this.knownHosts,
      get defaultKeepAliveSec(): number {
        return keepAlive()
      }
    }
    this.pool = new ConnectionPool(connectDeps)
    this.sessions = new SessionManager({
      vault: this.vault,
      prompts: this.prompts,
      knownHosts: this.knownHosts,
      history: this.history,
      settings: this.settings,
      emitter: this.emitter,
      get defaultKeepAliveSec(): number {
        return keepAlive()
      }
    })
    this.fs = new FsService({
      pool: this.pool,
      sessions: this.sessions,
      vault: this.vault,
      emitter: this.emitter,
      openPath: opts.openPath,
      watchFile: opts.watchFile
    })
    this.transfers = new TransferQueue(this.fs, this.emitter, this.prompts, this.settings)
    this.forwards = new ForwardService(this.vault, this.pool, this.emitter)
    this.sync = new SyncService({
      vault: this.vault,
      keystore: this.keystore,
      db: this.db,
      emitter: this.emitter,
      deviceId,
      // SSHTOOL_DEVICE_NAME: optional override (demos / tests) so screenshots don't expose the real computer name.
      deviceInfo: () => ({
        name: process.env.SSHTOOL_DEVICE_NAME || os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        appVersion: opts.appVersion
      }),
      createAdapter: opts.createAdapter,
      describe: opts.describeDb,
      kdf
    })
    this.updater = new UpdateService({
      appVersion: opts.appVersion,
      getSettings: () => this.settings.get(),
      emitter: opts.emitter
    })
    this.aiStore = new AiConfigStore(this.db, opts.protector)
    this.ai = new AiService({
      store: this.aiStore,
      settings: this.settings,
      sessions: this.sessions,
      pool: this.pool,
      emitter: opts.emitter,
      fetchImpl: opts.fetchImpl ?? ((url, init) => fetch(url, init))
    })
    this.vault.onChange = (kinds) => {
      this.emitter.emit('vault.changed', { kinds })
      if (kinds.includes('portForward')) this.forwards.pruneDeleted()
    }
    this.vault.onLocalWrite = () => this.sync.onLocalChange()
  }

  terminalPrefs(): TerminalPrefs {
    const pref = this.vault.isLoaded ? this.vault.get(PREF_ITEM_ID, 'pref') : undefined
    return terminalPrefsSchema.parse(pref?.data.terminal ?? {})
  }

  lockStatus(): LockStatus {
    return {
      locked: !this.keystore.unlocked,
      passwordEnabled: this.keystore.passwordEnabled,
      backend: this.keystore.backend,
      weak: this.keystore.weak,
      autoLockMinutes: this.settings.get().autoLockMinutes,
      keystoreError: this.keystoreError
    }
  }

  /** Initializes the keystore; unlocks automatically unless an app-lock password is set. */
  async init(): Promise<void> {
    this.keystoreError = undefined
    try {
      if (this.keystore.init()) {
        await this.afterUnlock()
        return
      }
    } catch (err) {
      // Never let a keychain problem stop the app from starting: the lock screen offers retry / reset.
      if (!(err instanceof KeystoreUnavailableError)) throw err
      this.keystoreError = err.message
    }
    this.emitter.emit('lock.changed', this.lockStatus())
  }

  /** Tries the OS keychain again (e.g. after the user unlocked their keyring). */
  async retryKeystore(): Promise<void> {
    if (this.keystore.unlocked) return
    await this.init()
  }

  /**
   * Last resort when the vault key is lost (keychain unusable, app lock password forgotten): deletes the local
   * vault and starts with an empty one. Synced data can be restored by joining sync again.
   */
  async resetLocalVault(): Promise<void> {
    await this.stopActivity()
    this.db.tx(() => {
      this.vault.wipeLocal()
      this.keystore.reset()
    })
    await this.init()
  }

  async unlock(password: string): Promise<boolean> {
    const ok = await this.keystore.unlock(password)
    if (ok) await this.afterUnlock()
    return ok
  }

  private async afterUnlock(): Promise<void> {
    this.vault.load()
    this.emitter.emit('lock.changed', this.lockStatus())
    await this.sync.start()
    void this.forwards.autoStart()
  }

  async lock(): Promise<boolean> {
    if (!this.keystore.passwordEnabled) return false
    await this.sync.stop()
    this.keystore.lock()
    this.vault.unload()
    this.emitter.emit('lock.changed', this.lockStatus())
    return true
  }

  /** Stops every connection, transfer and background job. */
  private async stopActivity(): Promise<void> {
    this.prompts.cancelAll()
    this.transfers.cancelAll()
    this.sessions.closeAll()
    this.forwards.stopAll()
    this.fs.stopAllEdits()
    this.fs.closeAll()
    this.pool.closeAll()
    await this.sync.stop()
  }

  async shutdown(): Promise<void> {
    // Not in stopActivity(): app lock must not permanently end update checks (settings are
    // readable while locked and the check never touches the vault).
    this.updater.stop()
    await this.stopActivity()
    this.db.close()
  }
}
