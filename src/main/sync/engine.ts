import { uuidv7 } from '@shared/util'
import type { SyncDevice } from '@shared/types'
import { DecryptError, decryptJson, DEFAULT_KDF, encryptJson, type KdfParams, randomKey, unwrapKey, wrapKey } from '../vault/crypto'
import type { Keystore } from '../vault/keystore'
import type { VaultService } from '../vault/vault-service'
import type { SyncAdapter, VaultMeta } from './adapter'

/** Per-device sync progress (persisted encrypted in the local vault). */
export interface EngineState {
  vaultId: string
  keyEpoch: number
  cursor: number
  lastReconcileAt: number
  lastHeartbeatAt: number
}

export type SyncErrorKind = 'needs-password' | 'vault-missing' | 'vault-mismatch' | 'wrong-password' | 'vault-exists' | 'no-vault'

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

export interface SyncResult {
  pushed: number
  pulled: number
  applied: number
  reconciled: boolean
}

export interface EngineDeps {
  vault: VaultService
  keystore: Keystore
  deviceId: string
  deviceInfo: () => { name: string; platform: string; appVersion: string }
  kdf?: KdfParams
  now?: () => number
  /** Called whenever the persisted state changes. */
  saveState: (s: EngineState) => void
}

const PUSH_BATCH = 200
const PULL_BATCH = 500
const FETCH_BATCH = 100
const HEARTBEAT_MS = 10 * 60_000
const deviceAad = (id: string): string => `sshtool:device:${id}`

/**
 * Sync algorithm (no timers): push dirty items → pull by seq cursor → periodic full reconcile.
 * Conflicts are resolved per item with last-writer-wins on hybrid logical clock timestamps.
 */
export class SyncEngine {
  state: EngineState | null
  private schemaChecked = false

  constructor(
    readonly adapter: SyncAdapter,
    private readonly deps: EngineDeps,
    state: EngineState | null
  ) {
    this.state = state
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private persist(): void {
    if (this.state) this.deps.saveState({ ...this.state })
  }

  private async unwrap(meta: VaultMeta, password: string): Promise<Buffer> {
    try {
      const { key } = await unwrapKey({ kdf: meta.kdf, salt: meta.salt, wrapped: meta.wrappedKey }, password)
      return key
    } catch (err) {
      if (err instanceof DecryptError) throw new SyncError('wrong-password', 'Wrong master password')
      throw err
    }
  }

  /** First device: creates the vault in the database and uploads everything. */
  async createVault(masterPassword: string): Promise<VaultMeta> {
    await this.adapter.ensureSchema()
    if (await this.adapter.getVaultMeta()) throw new SyncError('vault-exists', 'The database already contains a vault')
    const wrapped = await wrapKey(this.deps.keystore.key, masterPassword, this.deps.kdf ?? DEFAULT_KDF)
    const meta: VaultMeta = {
      vaultId: uuidv7(),
      keyEpoch: 1,
      kdf: wrapped.kdf,
      salt: wrapped.salt,
      wrappedKey: wrapped.wrapped,
      createdAt: this.now(),
      createdBy: this.deps.deviceId
    }
    const created = await this.adapter.createVaultMeta(meta)
    if (!created) {
      const current = await this.adapter.getVaultMeta()
      if (current?.vaultId !== meta.vaultId) throw new SyncError('vault-exists', 'Another device created the vault first')
    }
    this.state = { vaultId: meta.vaultId, keyEpoch: meta.keyEpoch, cursor: 0, lastReconcileAt: 0, lastHeartbeatAt: 0 }
    this.persist()
    this.deps.vault.markAllDirty()
    await this.syncOnce({ reconcile: true })
    return meta
  }

  /** Additional device: unlocks the remote vault key and merges local data into the vault. */
  async joinVault(masterPassword: string): Promise<VaultMeta> {
    await this.adapter.ensureSchema()
    const meta = await this.adapter.getVaultMeta()
    if (!meta) throw new SyncError('no-vault', 'The database does not contain a vault yet')
    const remoteKey = await this.unwrap(meta, masterPassword)
    if (!remoteKey.equals(this.deps.keystore.key)) this.deps.vault.reencrypt(remoteKey, { touch: false, markDirty: true })
    else this.deps.vault.markAllDirty()
    this.state = { vaultId: meta.vaultId, keyEpoch: meta.keyEpoch, cursor: 0, lastReconcileAt: 0, lastHeartbeatAt: 0 }
    this.persist()
    await this.syncOnce({ reconcile: true })
    return meta
  }

  /** After another device rotated the vault key: fetch the new key with the master password. */
  async unlockWithPassword(masterPassword: string): Promise<void> {
    const meta = await this.requireMeta(false)
    const key = await this.unwrap(meta, masterPassword)
    if (!key.equals(this.deps.keystore.key)) this.deps.vault.reencrypt(key, { touch: false, markDirty: false })
    this.state = { ...this.state!, keyEpoch: meta.keyEpoch, cursor: 0, lastReconcileAt: 0 }
    this.persist()
    await this.syncOnce({ reconcile: true })
    // Re-publish this device's info under the current key so other devices can read it right away.
    await this.heartbeat()
  }

  private async requireMeta(checkEpoch = true): Promise<VaultMeta> {
    if (!this.state) throw new SyncError('no-vault', 'Sync is not set up')
    const meta = await this.adapter.getVaultMeta()
    if (!meta) throw new SyncError('vault-missing', 'The vault no longer exists in the sync database')
    if (meta.vaultId !== this.state.vaultId)
      throw new SyncError('vault-mismatch', 'The sync database now contains a different vault')
    if (checkEpoch && meta.keyEpoch !== this.state.keyEpoch)
      throw new SyncError('needs-password', 'The vault key was changed on another device. Enter the master password.')
    return meta
  }

  async syncOnce(opts: { reconcile?: boolean; reconcileIntervalMs?: number } = {}): Promise<SyncResult> {
    if (!this.schemaChecked) {
      // Also guards against a database upgraded by a newer app version (SchemaTooNewError).
      await this.adapter.ensureSchema()
      this.schemaChecked = true
    }
    await this.requireMeta()
    const state = this.state!
    const vault = this.deps.vault
    const result: SyncResult = { pushed: 0, pulled: 0, applied: 0, reconciled: false }

    result.pushed += await this.pushPending()

    for (let guard = 0; guard < 10_000; guard++) {
      const items = await this.adapter.pull(state.cursor, PULL_BATCH)
      if (!items.length) break
      const res = vault.applyRemote(items)
      result.pulled += items.length
      result.applied += res.applied
      if (res.undecryptable.length) {
        const bad = new Set(res.undecryptable)
        const firstBad = items.find((i) => bad.has(i.id))!
        const meta = await this.adapter.getVaultMeta()
        if (meta && meta.keyEpoch !== state.keyEpoch) {
          state.cursor = Math.max(state.cursor, firstBad.seq - 1)
          this.persist()
          throw new SyncError('needs-password', 'The vault key was changed on another device. Enter the master password.')
        }
        // Same key epoch but unreadable (written with a stale key): re-upload our readable copy.
        vault.retouch(res.undecryptable)
      }
      state.cursor = items[items.length - 1].seq
      this.persist()
      if (items.length < PULL_BATCH) break
    }

    const due = this.now() - state.lastReconcileAt >= (opts.reconcileIntervalMs ?? 15 * 60_000)
    if (opts.reconcile || due) {
      await this.reconcile()
      result.reconciled = true
      result.pushed += await this.pushPending()
    }

    if (this.now() - state.lastHeartbeatAt >= HEARTBEAT_MS) await this.heartbeat()
    return result
  }

  private async pushPending(): Promise<number> {
    const vault = this.deps.vault
    let pushed = 0
    for (let guard = 0; guard < 1000; guard++) {
      const batch = vault.pendingPush(PUSH_BATCH)
      if (!batch.length) break
      await this.adapter.push(batch.map((r) => ({ ...r, deviceId: this.deps.deviceId })))
      vault.markPushed(batch)
      pushed += batch.length
      if (batch.length < PUSH_BATCH) break
    }
    return pushed
  }

  /** Full comparison of (id, hlc) between local and remote; repairs any divergence. */
  async reconcile(): Promise<void> {
    const vault = this.deps.vault
    const remote = new Map((await this.adapter.listIndex()).map((r) => [r.id, r.hlc]))
    const local = vault.syncIndex()
    const toFetch: string[] = []
    const toPush: string[] = []
    for (const [id, rh] of remote) {
      const lh = local.get(id)
      if (lh === undefined || lh < rh) toFetch.push(id)
    }
    for (const [id, lh] of local) {
      const rh = remote.get(id)
      if (rh === undefined || rh < lh) toPush.push(id)
    }
    for (let i = 0; i < toFetch.length; i += FETCH_BATCH) {
      const items = await this.adapter.getItems(toFetch.slice(i, i + FETCH_BATCH))
      const res = vault.applyRemote(items)
      if (res.undecryptable.length) vault.retouch(res.undecryptable)
    }
    if (toPush.length) vault.markDirty(toPush)
    this.state!.lastReconcileAt = this.now()
    this.persist()
  }

  async heartbeat(): Promise<void> {
    const info = encryptJson(this.deps.keystore.key, this.deps.deviceInfo(), deviceAad(this.deps.deviceId))
    await this.adapter.upsertDevice({ id: this.deps.deviceId, info, lastSeen: this.now() })
    if (this.state) {
      this.state.lastHeartbeatAt = this.now()
      this.persist()
    }
  }

  async devices(): Promise<SyncDevice[]> {
    const list = await this.adapter.listDevices()
    return list
      .map((d) => {
        let info = { name: 'Unknown device', platform: '', appVersion: '' }
        if (d.info) {
          try {
            info = decryptJson(this.deps.keystore.key, d.info, deviceAad(d.id))
          } catch {
            // device info written with an old key
          }
        }
        return { id: d.id, ...info, lastSeen: d.lastSeen, current: d.id === this.deps.deviceId }
      })
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const meta = await this.requireMeta()
    const key = await this.unwrap(meta, oldPassword)
    if (!key.equals(this.deps.keystore.key)) throw new SyncError('needs-password', 'Local vault key is out of date')
    const wrapped = await wrapKey(key, newPassword, this.deps.kdf ?? DEFAULT_KDF)
    await this.adapter.updateVaultMeta({ ...meta, kdf: wrapped.kdf, salt: wrapped.salt, wrappedKey: wrapped.wrapped })
  }

  /** Generates a new vault key, re-encrypts and re-uploads everything (revokes lost devices). */
  async rotateKey(masterPassword: string): Promise<void> {
    const meta = await this.requireMeta()
    const current = await this.unwrap(meta, masterPassword)
    if (!current.equals(this.deps.keystore.key)) throw new SyncError('needs-password', 'Local vault key is out of date')
    await this.syncOnce()
    const newKey = randomKey()
    const wrapped = await wrapKey(newKey, masterPassword, this.deps.kdf ?? DEFAULT_KDF)
    this.deps.vault.reencrypt(newKey, { touch: true, markDirty: true })
    // Publish the new epoch before uploading, so other devices stop at "needs password" instead
    // of treating new-key items as corrupt.
    await this.adapter.updateVaultMeta({
      ...meta,
      keyEpoch: meta.keyEpoch + 1,
      kdf: wrapped.kdf,
      salt: wrapped.salt,
      wrappedKey: wrapped.wrapped
    })
    this.state!.keyEpoch = meta.keyEpoch + 1
    this.persist()
    await this.pushPending()
    await this.heartbeat()
  }
}
