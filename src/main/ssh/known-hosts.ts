import type { Item } from '@shared/schemas'
import type { PromptService } from '../services/prompts'
import type { VaultService } from '../vault/vault-service'
import { fingerprintOf, keyTypeOf } from './keys'

export class HostKeyRejectedError extends Error {
  constructor(readonly changed: boolean) {
    super(changed ? 'Host key changed and was rejected' : 'Host key was not accepted')
    this.name = 'HostKeyRejectedError'
  }
}

/** Host key verification backed by synced `knownHost` vault items. */
export class KnownHostsService {
  /** Set when a verification was rejected so the connection error can be explained. */
  lastRejection: HostKeyRejectedError | null = null

  constructor(
    private readonly vault: VaultService,
    private readonly prompts: PromptService
  ) {}

  find(host: string, port: number): Item<'knownHost'>[] {
    const h = host.toLowerCase()
    return this.vault.list('knownHost').filter((k) => k.data.host.toLowerCase() === h && k.data.port === port)
  }

  async verify(target: { address: string; port: number; label: string }, blob: Buffer, sessionId?: string): Promise<boolean> {
    const keyType = keyTypeOf(blob)
    const fingerprint = fingerprintOf(blob)
    const entries = this.find(target.address, target.port)
    const sameType = entries.find((e) => e.data.keyType === keyType)
    if (sameType && sameType.data.fingerprint === fingerprint) return true

    const changed = !!sameType
    const answer = await this.prompts.ask({
      type: 'hostkey',
      sessionId,
      hostLabel: target.label,
      host: target.address,
      port: target.port,
      keyType,
      fingerprint,
      changed,
      oldFingerprint: sameType?.data.fingerprint
    })
    if (answer === 'accept-save') {
      const data = { host: target.address, port: target.port, keyType, fingerprint, publicKey: blob.toString('base64') }
      if (sameType) this.vault.upsert('knownHost', data, { id: sameType.id })
      else this.vault.upsert('knownHost', data)
      return true
    }
    if (answer === 'accept-once') return true
    this.lastRejection = new HostKeyRejectedError(changed)
    return false
  }
}
