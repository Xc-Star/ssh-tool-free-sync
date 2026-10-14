import { randomBytes } from 'node:crypto'
import { Hlc } from '../../src/main/vault/hlc'
import { LocalDb } from '../../src/main/vault/db'
import { Keystore, type SecretProtector } from '../../src/main/vault/keystore'
import { VaultService } from '../../src/main/vault/vault-service'
import { TEST_KDF } from '../../src/main/vault/crypto'

/** Reversible fake OS keychain for tests. */
export const testProtector: SecretProtector = {
  available: () => true,
  backend: () => 'test',
  weak: () => false,
  encrypt: (b) => Buffer.from(b.toString('hex'), 'utf8'),
  decrypt: (b) => Buffer.from(b.toString('utf8'), 'hex')
}

export interface TestDevice {
  db: LocalDb
  keystore: Keystore
  vault: VaultService
  hlc: Hlc
  deviceId: string
}

/** Creates an unlocked in-memory vault, as a fresh device would have. */
export function makeDevice(deviceId = randomBytes(4).toString('hex'), now?: () => number): TestDevice {
  const db = new LocalDb(':memory:')
  const keystore = new Keystore(db, testProtector, TEST_KDF)
  keystore.init()
  const hlc = new Hlc(deviceId, now)
  const vault = new VaultService(db, keystore, hlc)
  vault.load()
  return { db, keystore, vault, hlc, deviceId }
}
