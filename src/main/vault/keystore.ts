import type { LocalDb } from './db'
import { DecryptError, DEFAULT_KDF, type KdfParams, randomKey, unwrapKey, wrapKey, wrapKeyWithKek, type WrappedKey } from './crypto'

/** OS-level secret protection (Electron safeStorage in the app, a stub in tests). */
export interface SecretProtector {
  available(): boolean
  backend(): string
  /** True when the OS protection is weak (e.g. Linux without a keyring). */
  weak(): boolean
  encrypt(data: Buffer): Buffer
  decrypt(data: Buffer): Buffer
}

interface KeystoreRecord {
  version: 1
  /** os: VK protected by the OS keychain; password: VK wrapped by the app-lock password; plain: no protection available. */
  mode: 'os' | 'password' | 'plain'
  osBlob?: string
  plain?: string
  wrapped?: WrappedKey
}

const KV_KEY = 'keystore'

export class WrongPasswordError extends Error {
  constructor() {
    super('wrong password')
    this.name = 'WrongPasswordError'
  }
}

/**
 * The OS keychain cannot give back the vault key (Linux keyring / desktop changed, macOS keychain access
 * denied, Windows profile copied to another PC…). The local vault stays unreadable until it works again.
 */
export class KeystoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeystoreUnavailableError'
  }
}

/**
 * Holds the vault key (VK) that encrypts every local item. The VK is never written to disk in
 * plaintext unless the OS offers no protection at all and no app-lock password is set.
 */
export class Keystore {
  private vk: Buffer | null = null
  /** Key-encryption key derived from the app-lock password (kept only while unlocked). */
  private kek: Buffer | null = null

  constructor(
    private readonly db: LocalDb,
    private readonly protector: SecretProtector,
    private readonly kdf: KdfParams = DEFAULT_KDF
  ) {}

  private record(): KeystoreRecord | undefined {
    return this.db.kvGetJson<KeystoreRecord>(KV_KEY)
  }

  private save(rec: KeystoreRecord): void {
    this.db.kvSetJson(KV_KEY, rec)
  }

  get unlocked(): boolean {
    return this.vk !== null
  }

  get passwordEnabled(): boolean {
    return this.record()?.mode === 'password'
  }

  get weak(): boolean {
    const mode = this.record()?.mode
    if (mode === 'password') return false
    if (mode === 'plain') return true
    return this.protector.weak()
  }

  get backend(): string {
    return this.protector.backend()
  }

  /** The vault key. Throws when locked. */
  get key(): Buffer {
    if (!this.vk) throw new Error('vault is locked')
    return this.vk
  }

  /** Loads (or creates on first run) the vault key. Returns true when the vault is unlocked. Throws KeystoreUnavailableError. */
  init(): boolean {
    const rec = this.record()
    if (!rec) {
      this.vk = randomKey()
      this.protectWithOs(this.vk)
      return true
    }
    if (rec.mode === 'os' && rec.osBlob) {
      this.vk = this.decryptWithOs(rec.osBlob)
      return true
    }
    if (rec.mode === 'plain' && rec.plain) {
      this.vk = Buffer.from(rec.plain, 'base64')
      if (this.protector.available()) this.protectWithOs(this.vk)
      return true
    }
    return false
  }

  private decryptWithOs(blob: string): Buffer {
    let vk: Buffer
    try {
      if (!this.protector.available()) throw new Error(`No usable system keychain (backend: ${this.protector.backend()})`)
      vk = this.protector.decrypt(Buffer.from(blob, 'base64'))
    } catch (err) {
      throw new KeystoreUnavailableError(err instanceof Error ? err.message : String(err))
    }
    if (vk.length !== 32) throw new KeystoreUnavailableError('The system keychain returned an invalid vault key')
    return vk
  }

  /** Forgets the stored vault key for good (the data it protected must be wiped too); `init()` then creates a new one. */
  reset(): void {
    this.db.kvDelete(KV_KEY)
    this.vk = null
    this.kek = null
  }

  private protectWithOs(vk: Buffer): void {
    if (this.protector.available()) {
      this.save({ version: 1, mode: 'os', osBlob: this.protector.encrypt(vk).toString('base64') })
    } else {
      this.save({ version: 1, mode: 'plain', plain: vk.toString('base64') })
    }
  }

  async unlock(password: string): Promise<boolean> {
    const rec = this.record()
    if (!rec || rec.mode !== 'password' || !rec.wrapped) return this.init()
    try {
      const { key, kek } = await unwrapKey(rec.wrapped, password)
      this.vk = key
      this.kek = kek
      return true
    } catch (err) {
      if (err instanceof DecryptError) return false
      throw err
    }
  }

  /** Forgets the key (only meaningful when an app-lock password is configured). */
  lock(): boolean {
    if (!this.passwordEnabled) return false
    this.vk = null
    this.kek = null
    return true
  }

  async enablePassword(password: string): Promise<void> {
    const vk = this.key
    const wrapped = await wrapKey(vk, password, this.kdf)
    this.kek = (await unwrapKey(wrapped, password)).kek
    this.save({ version: 1, mode: 'password', wrapped })
  }

  async disablePassword(password: string): Promise<void> {
    await this.verifyPassword(password)
    this.protectWithOs(this.key)
    this.kek = null
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.verifyPassword(oldPassword)
    await this.enablePassword(newPassword)
  }

  async verifyPassword(password: string): Promise<void> {
    const rec = this.record()
    if (!rec || rec.mode !== 'password' || !rec.wrapped) return
    try {
      await unwrapKey(rec.wrapped, password)
    } catch (err) {
      if (err instanceof DecryptError) throw new WrongPasswordError()
      throw err
    }
  }

  /**
   * Replaces the vault key (sync join / key rotation). Must be called inside the same DB
   * transaction that re-encrypts the stored data.
   */
  replaceKey(newVk: Buffer): void {
    const rec = this.record()
    if (rec?.mode === 'password' && rec.wrapped && this.kek) {
      this.save({ version: 1, mode: 'password', wrapped: wrapKeyWithKek(newVk, this.kek, rec.wrapped.kdf, rec.wrapped.salt) })
    } else {
      this.protectWithOs(newVk)
    }
    this.vk = newVk
  }
}
