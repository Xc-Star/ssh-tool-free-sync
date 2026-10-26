import { DEFAULT_SETTINGS, type LocalSettings } from '@shared/types'
import type { LocalDb } from '../vault/db'
import type { Emitter } from './emitter'

const KV_KEY = 'settings'

/** Device-local preferences (never synced). Stored in plaintext: needed before the vault is unlocked. */
export class SettingsService {
  private cache: LocalSettings | null = null

  constructor(
    private readonly db: LocalDb,
    private readonly emitter: Emitter
  ) {}

  get(): LocalSettings {
    if (!this.cache) {
      const stored = this.db.kvGetJson<Partial<LocalSettings>>(KV_KEY) ?? {}
      this.cache = {
        ...DEFAULT_SETTINGS,
        ...stored,
        sftp: { ...DEFAULT_SETTINGS.sftp, ...(stored.sftp ?? {}) },
        ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai ?? {}) }
      }
    }
    return this.cache
  }

  set(patch: Partial<LocalSettings>): LocalSettings {
    const cur = this.get()
    const next: LocalSettings = {
      ...cur,
      ...patch,
      sftp: { ...cur.sftp, ...(patch.sftp ?? {}) },
      ai: { ...cur.ai, ...(patch.ai ?? {}) }
    }
    next.sftp.concurrency = Math.min(8, Math.max(1, Math.round(next.sftp.concurrency)))
    next.autoLockMinutes = Math.max(0, Math.round(next.autoLockMinutes))
    next.ai.maxTurns = Math.min(100, Math.max(1, Math.round(next.ai.maxTurns)))
    next.ai.commandTimeoutSec = Math.min(600, Math.max(5, Math.round(next.ai.commandTimeoutSec)))
    this.cache = next
    this.db.kvSetJson(KV_KEY, next)
    this.emitter.emit('settings.changed', next)
    return next
  }
}
