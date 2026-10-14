import { describe, expect, it } from 'vitest'
import { type EngineState, SyncEngine, SyncError } from '../../src/main/sync/engine'
import { SyncAdapterError } from '../../src/main/sync/adapter'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { makeDevice, type TestDevice } from '../helpers/device'
import { MemoryAdapter, MemoryStore } from '../helpers/memory-adapter'

interface Peer extends TestDevice {
  adapter: MemoryAdapter
  engine: SyncEngine
  state: EngineState | null
}

function peer(store: MemoryStore, id: string, now?: () => number): Peer {
  const d = makeDevice(id, now)
  const adapter = new MemoryAdapter(store)
  const p = { ...d, adapter, state: null } as Peer
  p.engine = new SyncEngine(
    adapter,
    {
      vault: d.vault,
      keystore: d.keystore,
      deviceId: id,
      deviceInfo: () => ({ name: id, platform: 'test', appVersion: '0' }),
      kdf: TEST_KDF,
      now,
      saveState: (s) => (p.state = s)
    },
    null
  )
  return p
}

const hosts = (p: Peer): string[] =>
  p.vault
    .list('host')
    .map((h) => h.data.label)
    .sort()

describe('sync engine', () => {
  it('first device creates the vault; second joins and both converge', async () => {
    const store = new MemoryStore()
    const a = peer(store, 'deva')
    a.vault.upsert('host', { address: '1.1.1.1', label: 'from-a', password: 'pa' })
    await a.engine.createVault('master-password')
    expect(store.meta?.vaultId).toBeTruthy()
    expect(store.items.size).toBe(1)
    // remote contains only ciphertext
    for (const it of store.items.values()) expect(it.payload!.includes(Buffer.from('1.1.1.1'))).toBe(false)

    const b = peer(store, 'devb')
    b.vault.upsert('host', { address: '2.2.2.2', label: 'from-b' })
    await expect(b.engine.joinVault('wrong-password')).rejects.toMatchObject({ kind: 'wrong-password' })
    await b.engine.joinVault('master-password')
    expect(hosts(b)).toEqual(['from-a', 'from-b'])
    expect(b.keystore.key.equals(a.keystore.key)).toBe(true)
    await a.engine.syncOnce()
    expect(hosts(a)).toEqual(['from-a', 'from-b'])
    // secrets survive the round trip
    const fromA = b.vault.list('host').find((h) => h.data.label === 'from-a')!
    expect(fromA.data.password).toBe('pa')
  })

  it('last writer wins and deletes propagate', async () => {
    let t = 1_000_000
    const store = new MemoryStore()
    const a = peer(store, 'deva', () => t)
    const b = peer(store, 'devb', () => t)
    const h = a.vault.upsert('host', { address: 'h', label: 'v1' })
    await a.engine.createVault('master-password')
    await b.engine.joinVault('master-password')
    // concurrent offline edits: b edits later
    t += 10
    a.vault.patch(h.id, { label: 'edit-a' })
    t += 10
    b.vault.patch(h.id, { label: 'edit-b' })
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    expect(a.vault.get(h.id, 'host')?.data.label).toBe('edit-b')
    expect(b.vault.get(h.id, 'host')?.data.label).toBe('edit-b')
    // delete on a wins over an older edit
    t += 10
    a.vault.remove([h.id])
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect(b.vault.get(h.id)).toBeUndefined()
  })

  it('a device with a skewed clock still converges (HLC)', async () => {
    let ta = 5_000_000
    const tb = 1_000 // b's clock is far behind
    const store = new MemoryStore()
    const a = peer(store, 'deva', () => ta)
    const b = peer(store, 'devb', () => tb)
    const h = a.vault.upsert('host', { address: 'h', label: 'a1' })
    await a.engine.createVault('master-password')
    await b.engine.joinVault('master-password')
    // b edits after having seen a's version → must win despite its old clock
    b.vault.patch(h.id, { label: 'b-after-seeing-a' })
    await b.engine.syncOnce()
    ta += 1
    await a.engine.syncOnce()
    expect(a.vault.get(h.id, 'host')?.data.label).toBe('b-after-seeing-a')
  })

  it('device-only items never leave the device', async () => {
    const store = new MemoryStore()
    const a = peer(store, 'deva')
    const k = a.vault.upsert('key', { label: 'secret key', privateKey: 'PEM' })
    const s = a.vault.upsert('serialProfile', { label: 'usb', path: 'COM3' })
    await a.engine.createVault('master-password')
    expect(store.items.has(k.id)).toBe(true)
    expect(store.items.has(s.id)).toBe(false)
    a.vault.setLocalOnly(k.id, true)
    await a.engine.syncOnce()
    expect(store.items.get(k.id)?.deleted).toBe(true)
    expect(a.vault.get(k.id)).toBeTruthy()
    const b = peer(store, 'devb')
    await b.engine.joinVault('master-password')
    expect(b.vault.get(k.id)).toBeUndefined()
    // turning sync back on re-uploads it
    a.vault.setLocalOnly(k.id, false)
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect(b.vault.get(k.id, 'key')?.data.label).toBe('secret key')
  })

  it('reconcile repairs a remote that lost data', async () => {
    const store = new MemoryStore()
    const a = peer(store, 'deva')
    const h = a.vault.upsert('host', { address: 'h' })
    await a.engine.createVault('master-password')
    store.items.clear() // e.g. a DB restore lost rows
    await a.engine.syncOnce({ reconcile: true })
    expect(store.items.has(h.id)).toBe(true)
  })

  it('surfaces network errors as transient adapter errors', async () => {
    const store = new MemoryStore()
    const a = peer(store, 'deva')
    await a.engine.createVault('master-password')
    a.adapter.offline = true
    a.adapter.getVaultMeta = async () => {
      throw new SyncAdapterError('network', 'offline')
    }
    await expect(a.engine.syncOnce()).rejects.toMatchObject({ transient: true })
  })

  it('change password and rotate key', async () => {
    const store = new MemoryStore()
    const a = peer(store, 'deva')
    const b = peer(store, 'devb')
    const h = a.vault.upsert('host', { address: 'h', label: 'x' })
    await a.engine.createVault('master-password')
    await b.engine.joinVault('master-password')

    await a.engine.changePassword('master-password', 'new-master-password')
    const c = peer(store, 'devc')
    await expect(c.engine.joinVault('master-password')).rejects.toBeInstanceOf(SyncError)
    await c.engine.joinVault('new-master-password')
    expect(c.vault.get(h.id, 'host')?.data.label).toBe('x')

    const oldKey = Buffer.from(a.keystore.key)
    await a.engine.rotateKey('new-master-password')
    expect(a.keystore.key.equals(oldKey)).toBe(false)
    expect(store.meta?.keyEpoch).toBe(2)
    await expect(b.engine.syncOnce()).rejects.toMatchObject({ kind: 'needs-password' })
    await b.engine.unlockWithPassword('new-master-password')
    expect(b.keystore.key.equals(a.keystore.key)).toBe(true)
    b.vault.patch(h.id, { label: 'after-rotation' })
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    expect(a.vault.get(h.id, 'host')?.data.label).toBe('after-rotation')
    // devices list decrypts with the new key
    const devs = await a.engine.devices()
    expect(devs.find((d) => d.id === 'deva')?.name).toBe('deva')
  })

  it('second create on the same database is refused', async () => {
    const store = new MemoryStore()
    const a = peer(store, 'deva')
    await a.engine.createVault('master-password')
    const b = peer(store, 'devb')
    await expect(b.engine.createVault('master-password')).rejects.toMatchObject({ kind: 'vault-exists' })
  })

  it('handles many items with paging', async () => {
    const store = new MemoryStore()
    const a = peer(store, 'deva')
    for (let i = 0; i < 1234; i++) a.vault.upsert('snippet', { label: `s${i}`, script: 'echo' })
    await a.engine.createVault('master-password')
    expect(store.items.size).toBe(1234)
    const b = peer(store, 'devb')
    await b.engine.joinVault('master-password')
    expect(b.vault.list('snippet')).toHaveLength(1234)
  })
})
