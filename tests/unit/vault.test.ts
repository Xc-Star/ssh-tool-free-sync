import { describe, expect, it } from 'vitest'
import { DecryptError, decrypt, deriveKey, encrypt, randomKey, TEST_KDF, unwrapKey, wrapKey } from '../../src/main/vault/crypto'
import { formatHlc, Hlc, parseHlc } from '../../src/main/vault/hlc'
import { Keystore, KeystoreUnavailableError } from '../../src/main/vault/keystore'
import { LocalDb } from '../../src/main/vault/db'
import { maskItem, unmaskData } from '../../src/main/vault/secrets'
import { SECRET_MASK } from '../../src/shared/schemas'
import { makeDevice, testProtector } from '../helpers/device'

describe('crypto', () => {
  it('round-trips and authenticates', () => {
    const key = randomKey()
    const blob = encrypt(key, Buffer.from('hello'), 'aad-1')
    expect(decrypt(key, blob, 'aad-1').toString()).toBe('hello')
    expect(() => decrypt(key, blob, 'aad-2')).toThrow(DecryptError)
    const tampered = Buffer.from(blob)
    tampered[tampered.length - 20] ^= 1
    expect(() => decrypt(key, tampered, 'aad-1')).toThrow(DecryptError)
    try {
      decrypt(randomKey(), blob, 'aad-1')
    } catch (err) {
      expect((err as DecryptError).reason).toBe('wrong-key')
    }
  })

  it('wraps keys with a password', async () => {
    const key = randomKey()
    const w = await wrapKey(key, 'correct horse', TEST_KDF)
    expect((await unwrapKey(w, 'correct horse')).key.equals(key)).toBe(true)
    await expect(unwrapKey(w, 'wrong')).rejects.toBeInstanceOf(DecryptError)
  })

  it('derives deterministic keys', async () => {
    const salt = Buffer.alloc(16, 7)
    const a = await deriveKey('pw', salt, TEST_KDF)
    const b = await deriveKey('pw', salt, TEST_KDF)
    expect(a.equals(b)).toBe(true)
    expect(a.length).toBe(32)
  })
})

describe('hlc', () => {
  it('is monotonic and survives clock skew', () => {
    let t = 1000
    const a = new Hlc('aaaa', () => t)
    const t1 = a.tick()
    const t2 = a.tick()
    expect(t2 > t1).toBe(true)
    t = 500 // clock goes backwards
    const t3 = a.tick()
    expect(t3 > t2).toBe(true)
    const b = new Hlc('bbbb', () => 10)
    b.receive(t3)
    expect(b.tick() > t3).toBe(true)
  })

  it('formats fixed width', () => {
    const s = formatHlc(1234, 5, 'dev')
    expect(s).toBe('000000000001234:00005:dev')
    expect(parseHlc(s)).toEqual({ ms: 1234, counter: 5, deviceId: 'dev' })
  })
})

describe('keystore', () => {
  it('creates a key, locks with a password and unlocks', async () => {
    const db = new LocalDb(':memory:')
    const ks = new Keystore(db, testProtector, TEST_KDF)
    expect(ks.init()).toBe(true)
    const k = Buffer.from(ks.key)
    await ks.enablePassword('secret1')
    expect(ks.lock()).toBe(true)
    expect(ks.unlocked).toBe(false)
    const ks2 = new Keystore(db, testProtector, TEST_KDF)
    expect(ks2.init()).toBe(false)
    expect(await ks2.unlock('nope')).toBe(false)
    expect(await ks2.unlock('secret1')).toBe(true)
    expect(ks2.key.equals(k)).toBe(true)
    await ks2.disablePassword('secret1')
    const ks3 = new Keystore(db, testProtector, TEST_KDF)
    expect(ks3.init()).toBe(true)
    expect(ks3.key.equals(k)).toBe(true)
  })

  it('reports an unusable OS keychain instead of crashing, and can start over', () => {
    const db = new LocalDb(':memory:')
    const ks = new Keystore(db, testProtector, TEST_KDF)
    ks.init()
    const old = Buffer.from(ks.key)
    const broken = { ...testProtector, decrypt: (): Buffer => { throw new Error('Error while decrypting the ciphertext') } }
    expect(() => new Keystore(db, broken, TEST_KDF).init()).toThrow(KeystoreUnavailableError)
    const gone = { ...testProtector, available: () => false }
    expect(() => new Keystore(db, gone, TEST_KDF).init()).toThrow(KeystoreUnavailableError)
    const garbage = { ...testProtector, decrypt: () => Buffer.from('short') }
    expect(() => new Keystore(db, garbage, TEST_KDF).init()).toThrow(KeystoreUnavailableError)

    const fresh = new Keystore(db, broken, TEST_KDF)
    fresh.reset()
    expect(fresh.init()).toBe(true)
    expect(fresh.key.equals(old)).toBe(false)
  })
})

describe('vault service', () => {
  it('stores only ciphertext and reloads', () => {
    const d = makeDevice('dev1')
    const host = d.vault.upsert('host', { address: '10.0.0.1', label: 'web', password: 's3cret-pass' })
    const row = d.db.getItemRow(host.id)!
    expect(Buffer.from(row.payload!).includes(Buffer.from('s3cret-pass'))).toBe(false)
    expect(Buffer.from(row.payload!).includes(Buffer.from('10.0.0.1'))).toBe(false)
    d.vault.load()
    expect(d.vault.get(host.id, 'host')?.data.password).toBe('s3cret-pass')
  })

  it('wipes local data but keeps device settings', () => {
    const d = makeDevice('dev1')
    d.vault.upsert('host', { address: '10.0.0.1' })
    d.vault.setSecure('sync.config', { kind: 'd1' })
    d.db.kvSet('settings', '{"theme":"light"}')
    d.vault.wipeLocal()
    expect(d.db.allItemRows()).toHaveLength(0)
    expect(d.db.kvKeys('secure:')).toHaveLength(0)
    expect(d.db.kvGet('settings')).toBe('{"theme":"light"}')
    expect(d.vault.isLoaded).toBe(false)
  })

  it('validates input and applies defaults', () => {
    const d = makeDevice()
    expect(() => d.vault.upsert('host', { address: '' } as never)).toThrow()
    const h = d.vault.upsert('host', { address: 'a.example.com' })
    expect(h.data.tagIds).toEqual([])
    expect(h.data.sshEnabled).toBe(true)
  })

  it('masks secrets and keeps them when the mask is sent back', () => {
    const d = makeDevice()
    const h = d.vault.upsert('host', { address: 'x', password: 'pw', proxy: { type: 'socks5', host: 'p', port: 1080, password: 'pp' } })
    const masked = maskItem(h)
    expect(masked.data.password).toBe(SECRET_MASK)
    expect(masked.data.proxy?.password).toBe(SECRET_MASK)
    const back = d.vault.upsert('host', { ...masked.data, label: 'renamed' }, { id: h.id })
    expect(back.data.password).toBe('pw')
    expect(back.data.proxy?.password).toBe('pp')
    expect(unmaskData('host', { address: 'x', password: SECRET_MASK }, undefined).password).toBeUndefined()
  })

  it('preserves unknown fields from newer app versions', () => {
    const d = makeDevice()
    const h = d.vault.upsert('host', { address: 'x', futureField: 42 } as never)
    expect((h.data as Record<string, unknown>).futureField).toBe(42)
    const p = d.vault.patch(h.id, { label: 'y' })
    expect((p.data as Record<string, unknown>).futureField).toBe(42)
  })

  it('tracks dirty items, tombstones and local-only', () => {
    const d = makeDevice()
    const a = d.vault.upsert('host', { address: 'a' })
    const s = d.vault.upsert('serialProfile', { label: 'usb', path: 'COM3' })
    expect(s.localOnly).toBe(true)
    expect(d.vault.pendingPush().map((r) => r.id)).toEqual([a.id])
    d.vault.markPushed(d.vault.pendingPush())
    expect(d.vault.pendingCount()).toBe(0)
    d.vault.remove([a.id])
    const tomb = d.vault.pendingPush()
    expect(tomb).toHaveLength(1)
    expect(tomb[0].deleted).toBe(true)
    expect(tomb[0].payload).toBeNull()
  })
})
