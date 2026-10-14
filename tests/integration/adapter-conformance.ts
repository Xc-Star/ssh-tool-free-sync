import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, type TestContext } from 'vitest'
import {
  SCHEMA_VERSION,
  SchemaTooNewError,
  SyncAdapterError,
  type PushItem,
  type RemoteItem,
  type SyncAdapter,
  type VaultMeta
} from '../../src/main/sync/adapter'
import { formatHlc } from '../../src/main/vault/hlc'

export type AdapterFactory = (prefix: string) => Promise<SyncAdapter> | SyncAdapter

export interface ConformanceOptions {
  /** When this returns false every test is skipped (e.g. the database server could not be started). */
  available?: () => boolean
  /** Raw read of the stored `schema_version` row. */
  getSchemaVersion?: (prefix: string) => Promise<string | null>
  /** Raw overwrite of the stored `schema_version` row (for the "schema too new" check). */
  setSchemaVersion?: (prefix: string, version: string) => Promise<void>
  /** Drops the tables of a prefix after the suite. */
  dropTables?: (prefix: string) => Promise<void>
  /** Secrets that must never appear in the adapter label. */
  secrets?: () => string[]
  /** Concurrency test size (default 4 writers × 50 items). */
  writers?: number
  itemsPerWriter?: number
}

const BASE_MS = 1_760_000_000_000

export function newPrefix(): string {
  return `t${Date.now().toString(36)}${randomBytes(3).toString('hex')}_`
}

function hlc(offsetMs: number, counter = 0, device = 'dev-a'): string {
  return formatHlc(BASE_MS + offsetMs, counter, device)
}

function item(id: string, h: string, payload: Buffer | null, deviceId = 'dev-a'): PushItem {
  return { id, payload, hlc: h, deleted: payload === null, deviceId }
}

function sampleMeta(): VaultMeta {
  return {
    vaultId: randomUUID(),
    keyEpoch: 1,
    kdf: { alg: 'argon2id', m: 1024, t: 1, p: 1 },
    salt: randomBytes(16).toString('base64'),
    wrappedKey: randomBytes(61).toString('base64'),
    createdAt: Date.now(),
    createdBy: `dev-test 'quote' "double" \\backslash 🔑 ✓`
  }
}

async function pullAll(adapter: SyncAdapter, limit = 500): Promise<RemoteItem[]> {
  const out: RemoteItem[] = []
  let cursor = 0
  for (;;) {
    const page = await adapter.pull(cursor, limit)
    if (!page.length) return out
    out.push(...page)
    cursor = page[page.length - 1].seq
  }
}

function expectIncreasingSeqs(items: RemoteItem[]): void {
  for (let i = 1; i < items.length; i++) expect(items[i].seq).toBeGreaterThan(items[i - 1].seq)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Behavioural contract every `SyncAdapter` must satisfy. `makeAdapter` must return a new, unconnected
 * instance for the given table prefix on every call (several instances share one database).
 */
export function runAdapterConformance(
  name: string,
  makeAdapter: AdapterFactory,
  opts: ConformanceOptions = {}
): void {
  describe(`SyncAdapter conformance: ${name}`, () => {
    const opened: SyncAdapter[] = []
    const prefixes: string[] = []

    const requireBackend = (ctx: TestContext): void => {
      if (opts.available && !opts.available()) ctx.skip('database backend is not available')
    }

    const open = async (prefix: string): Promise<SyncAdapter> => {
      const adapter = await makeAdapter(prefix)
      opened.push(adapter)
      await adapter.connect()
      return adapter
    }

    const fresh = async (): Promise<{ prefix: string; adapter: SyncAdapter }> => {
      const prefix = newPrefix()
      prefixes.push(prefix)
      const adapter = await open(prefix)
      await adapter.ensureSchema()
      return { prefix, adapter }
    }

    afterEach(async () => {
      await Promise.all(opened.splice(0).map((a) => a.close().catch(() => undefined)))
    })

    afterAll(async () => {
      if (!opts.dropTables || (opts.available && !opts.available())) return
      for (const prefix of prefixes.splice(0)) await opts.dropTables(prefix).catch(() => undefined)
    })

    it('exposes kind, capabilities and a label without secrets', async (ctx) => {
      requireBackend(ctx)
      const adapter = await makeAdapter(newPrefix())
      expect(['postgres', 'mysql', 'd1']).toContain(adapter.kind)
      expect(adapter.label.length).toBeGreaterThan(0)
      for (const secret of opts.secrets?.() ?? []) expect(adapter.label).not.toContain(secret)
      expect(adapter.capabilities.defaultPollSec).toBeGreaterThan(0)
      expect(adapter.capabilities.defaultReconcileMin).toBeGreaterThan(0)
      expect(adapter.capabilities.realtime).toBe(typeof adapter.subscribe === 'function')
    })

    it('ensureSchema is idempotent and records the schema version', async (ctx) => {
      requireBackend(ctx)
      const { prefix, adapter } = await fresh()
      await adapter.ensureSchema()
      const second = await open(prefix)
      await second.ensureSchema()
      expect(await adapter.head()).toBe(0)
      expect(await adapter.pull(0, 10)).toEqual([])
      expect(await adapter.listIndex()).toEqual([])
      expect(await adapter.listDevices()).toEqual([])
      expect(await adapter.getItems([])).toEqual([])
      await adapter.push([])
      if (opts.getSchemaVersion) expect(await opts.getSchemaVersion(prefix)).toBe(String(SCHEMA_VERSION))
    })

    it('ensureSchema tolerates concurrent first runs', async (ctx) => {
      requireBackend(ctx)
      const prefix = newPrefix()
      prefixes.push(prefix)
      const adapters = await Promise.all([0, 1, 2].map(() => open(prefix)))
      await Promise.all(adapters.map((a) => a.ensureSchema()))
      expect(await adapters[1].head()).toBe(0)
    })

    it('ensureSchema refuses a newer remote schema version', async (ctx) => {
      requireBackend(ctx)
      const setVersion = opts.setSchemaVersion
      if (!setVersion) return ctx.skip('no raw schema access for this backend')
      const { prefix, adapter } = await fresh()
      await setVersion(prefix, String(SCHEMA_VERSION + 1))
      const err = await adapter.ensureSchema().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SchemaTooNewError)
      expect((err as SchemaTooNewError).remoteVersion).toBe(SCHEMA_VERSION + 1)
      await setVersion(prefix, String(SCHEMA_VERSION))
      await adapter.ensureSchema()
    })

    it('creates the vault metadata once and overwrites it on update', async (ctx) => {
      requireBackend(ctx)
      const { adapter } = await fresh()
      expect(await adapter.getVaultMeta()).toBeNull()
      const meta = sampleMeta()
      expect(await adapter.createVaultMeta(meta)).toBe(true)
      expect(await adapter.createVaultMeta(sampleMeta())).toBe(false)
      expect(await adapter.getVaultMeta()).toEqual(meta)
      const rotated: VaultMeta = { ...meta, keyEpoch: 2, wrappedKey: randomBytes(61).toString('base64') }
      await adapter.updateVaultMeta(rotated)
      expect(await adapter.getVaultMeta()).toEqual(rotated)
    })

    it('createVaultMeta is race-safe across instances', async (ctx) => {
      requireBackend(ctx)
      const { prefix } = await fresh()
      const adapters = await Promise.all(Array.from({ length: 5 }, () => open(prefix)))
      const metas = adapters.map(() => sampleMeta())
      const results = await Promise.all(adapters.map((a, i) => a.createVaultMeta(metas[i])))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await adapters[4].getVaultMeta()).toEqual(metas[results.indexOf(true)])
    })

    it('round-trips binary payloads, tombstones and device ids', async (ctx) => {
      requireBackend(ctx)
      const { adapter } = await fresh()
      const items: PushItem[] = [
        item(randomUUID(), hlc(1), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), 'dev-a'),
        item(randomUUID(), hlc(2), randomBytes(100 * 1024), 'dev-b'),
        item(randomUUID(), hlc(3), null, 'dev-c'),
        item(randomUUID(), hlc(4), Buffer.alloc(0), 'dev-a'),
        item('pref-main', hlc(5, 3, 'dev-b'), Buffer.from('{"quote":"\'\\"\\\\"}'), 'dev-b')
      ]
      await adapter.push(items)
      const pulled = await adapter.pull(0, 100)
      expect(pulled).toHaveLength(items.length)
      expectIncreasingSeqs(pulled)
      expect(await adapter.head()).toBe(pulled[pulled.length - 1].seq)
      const fetched = new Map((await adapter.getItems(items.map((i) => i.id))).map((r) => [r.id, r]))
      const pulledById = new Map(pulled.map((r) => [r.id, r]))
      for (const expected of items) {
        for (const got of [pulledById.get(expected.id), fetched.get(expected.id)]) {
          expect(got).toBeDefined()
          expect(got!.hlc).toBe(expected.hlc)
          expect(got!.deviceId).toBe(expected.deviceId)
          expect(got!.deleted).toBe(expected.deleted)
          expect(typeof got!.seq).toBe('number')
          expect(got!.seq).toBe(pulledById.get(expected.id)!.seq)
          if (expected.payload === null) {
            expect(got!.payload).toBeNull()
          } else {
            expect(Buffer.isBuffer(got!.payload)).toBe(true)
            expect(got!.payload!.equals(expected.payload)).toBe(true)
          }
        }
      }
    })

    it('applies last-writer-wins by hlc and gives every write a new seq', async (ctx) => {
      requireBackend(ctx)
      const { adapter } = await fresh()
      const id = randomUUID()
      const original = randomBytes(24)
      await adapter.push([item(id, hlc(100), original)])
      const [first] = await adapter.getItems([id])

      await adapter.push([item(id, hlc(50, 0, 'dev-b'), randomBytes(24), 'dev-b')])
      await adapter.push([item(id, hlc(100), randomBytes(24), 'dev-b')])
      let [current] = await adapter.getItems([id])
      expect(current.hlc).toBe(hlc(100))
      expect(current.seq).toBe(first.seq)
      expect(current.deviceId).toBe('dev-a')
      expect(current.payload!.equals(original)).toBe(true)
      expect(await adapter.head()).toBe(first.seq)
      expect(await adapter.pull(first.seq, 10)).toEqual([])

      await adapter.push([item(id, hlc(200, 0, 'dev-b'), null, 'dev-b')])
      ;[current] = await adapter.getItems([id])
      expect(current).toMatchObject({
        hlc: hlc(200, 0, 'dev-b'),
        deleted: true,
        payload: null,
        deviceId: 'dev-b'
      })
      expect(current.seq).toBeGreaterThan(first.seq)
      const tombstoneSeq = current.seq

      const revived = randomBytes(10)
      const other = randomUUID()
      // One call mixing a rejected (older), an accepted update and a new item.
      await adapter.push([
        item(id, hlc(150), randomBytes(5)),
        item(id, hlc(300), revived),
        item(other, hlc(1), Buffer.from('x'))
      ])
      ;[current] = await adapter.getItems([id])
      expect(current).toMatchObject({ hlc: hlc(300), deleted: false, deviceId: 'dev-a' })
      expect(current.payload!.equals(revived)).toBe(true)
      expect(current.seq).toBeGreaterThan(tombstoneSeq)
      const page = await adapter.pull(tombstoneSeq, 10)
      expect(page.map((r) => r.id).sort()).toEqual([id, other].sort())
      expectIncreasingSeqs(page)
      expect(await adapter.head()).toBe(page[page.length - 1].seq)

      const dup = randomUUID()
      await adapter.push([
        item(dup, hlc(3), Buffer.from('a')),
        item(dup, hlc(7), Buffer.from('b')),
        item(dup, hlc(5), Buffer.from('c'))
      ])
      const [d] = await adapter.getItems([dup])
      expect(d.hlc).toBe(hlc(7))
      expect(d.payload!.toString()).toBe('b')
    })

    it('never lets a paging reader miss an item while writers push concurrently', async (ctx) => {
      requireBackend(ctx)
      const writerCount = opts.writers ?? 4
      const perWriter = opts.itemsPerWriter ?? 50
      const pushSize = 5
      const { prefix } = await fresh()
      const writers = await Promise.all(Array.from({ length: writerCount }, () => open(prefix)))
      const reader = await open(prefix)

      const ids = Array.from({ length: 60 }, () => randomUUID())
      const expected = new Map<string, { hlc: string; payload: string }>()
      const plans = writers.map((_, w) => {
        const pushes: PushItem[][] = []
        for (let k = 0; k < perWriter; k += pushSize) {
          const batch: PushItem[] = []
          for (let n = k; n < Math.min(k + pushSize, perWriter); n++) {
            const id = ids[(n * 7 + w * 11) % ids.length]
            const h = hlc(Math.floor(Math.random() * 5000), n, `w${w}`)
            const payload = `${w}:${n}:${h}`
            batch.push(item(id, h, Buffer.from(payload), `w${w}`))
            const best = expected.get(id)
            if (!best || best.hlc < h) expected.set(id, { hlc: h, payload })
          }
          pushes.push(batch)
        }
        return pushes
      })

      let writersDone = false
      const seen = new Map<string, RemoteItem>()
      let lastSeq = 0
      const readLoop = (async () => {
        let cursor = 0
        for (;;) {
          const finished = writersDone
          const page = await reader.pull(cursor, 7)
          for (const r of page) {
            expect(r.seq).toBeGreaterThan(lastSeq)
            lastSeq = r.seq
            seen.set(r.id, r)
          }
          if (page.length) cursor = page[page.length - 1].seq
          else if (finished) return
          else await sleep(3)
        }
      })()
      await Promise.all(
        writers.map(async (adapter, w) => {
          for (const batch of plans[w]) await adapter.push(batch)
        })
      )
      writersDone = true
      await readLoop

      const final = await pullAll(reader)
      expect(new Set(final.map((r) => r.seq)).size).toBe(final.length)
      expect(final).toHaveLength(expected.size)
      expect(await reader.head()).toBe(final[final.length - 1].seq)
      for (const r of final) {
        const want = expected.get(r.id)!
        expect(r.hlc).toBe(want.hlc)
        expect(r.payload!.toString()).toBe(want.payload)
        // The cursor reader must have observed exactly this final version.
        expect(seen.get(r.id)?.seq).toBe(r.seq)
        expect(seen.get(r.id)?.hlc).toBe(r.hlc)
      }
    })

    it('pages pull results; getItems and listIndex are complete', async (ctx) => {
      requireBackend(ctx)
      const { adapter } = await fresh()
      const items = Array.from({ length: 250 }, (_, i) =>
        item(randomUUID(), hlc(i, i % 7, `dev-${i % 3}`), Buffer.from(`payload-${i}`), `dev-${i % 3}`)
      )
      await adapter.push(items)
      const pages: RemoteItem[][] = []
      let cursor = 0
      for (;;) {
        const page = await adapter.pull(cursor, 40)
        if (!page.length) break
        expect(page.length).toBeLessThanOrEqual(40)
        pages.push(page)
        cursor = page[page.length - 1].seq
      }
      expect(pages).toHaveLength(7)
      const all = pages.flat()
      expect(all).toHaveLength(250)
      expectIncreasingSeqs(all)
      expect(await adapter.head()).toBe(cursor)

      const payloadOf = new Map(items.map((i) => [i.id, i.payload!.toString()]))
      const wanted = items.slice(0, 140).map((i) => i.id)
      const unknown = Array.from({ length: 15 }, () => randomUUID())
      const fetched = await adapter.getItems([...wanted, ...unknown, wanted[0]])
      expect(fetched).toHaveLength(140)
      expect(new Set(fetched.map((r) => r.id))).toEqual(new Set(wanted))
      for (const r of fetched) expect(r.payload!.toString()).toBe(payloadOf.get(r.id))

      const index = await adapter.listIndex()
      expect(index).toHaveLength(250)
      const indexed = new Map(index.map((e) => [e.id, e.hlc]))
      for (const i of items) expect(indexed.get(i.id)).toBe(i.hlc)
    })

    it('upserts, lists and deletes devices', async (ctx) => {
      requireBackend(ctx)
      const { adapter } = await fresh()
      const info = Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i))
      await adapter.upsertDevice({ id: 'device-1', info, lastSeen: 1_700_000_000_000 })
      await adapter.upsertDevice({ id: 'device-2', info: null, lastSeen: 1_700_000_000_500 })
      let list = await adapter.listDevices()
      expect(list.map((d) => d.id).sort()).toEqual(['device-1', 'device-2'])
      const first = list.find((d) => d.id === 'device-1')!
      expect(first.info!.equals(info)).toBe(true)
      expect(first.lastSeen).toBe(1_700_000_000_000)
      expect(list.find((d) => d.id === 'device-2')!.info).toBeNull()

      const info2 = randomBytes(300)
      await adapter.upsertDevice({ id: 'device-1', info: info2, lastSeen: 1_700_000_100_000 })
      await adapter.deleteDevice('device-2')
      await adapter.deleteDevice('device-missing')
      list = await adapter.listDevices()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe('device-1')
      expect(list[0].info!.equals(info2)).toBe(true)
      expect(list[0].lastSeen).toBe(1_700_000_100_000)
    })

    it('notifies subscribers about pushes from other instances', async (ctx) => {
      requireBackend(ctx)
      const { prefix, adapter } = await fresh()
      if (!adapter.subscribe) return ctx.skip('adapter has no realtime feed')
      const writer = await open(prefix)
      let notify!: () => void
      const notified = new Promise<void>((resolve) => (notify = resolve))
      const errors: Error[] = []
      const unsubscribe = await adapter.subscribe(
        () => notify(),
        (err) => errors.push(err)
      )
      await writer.push([item(randomUUID(), hlc(1), randomBytes(8))])
      await withTimeout(notified, 10_000, 'a change notification')
      await unsubscribe()
      await unsubscribe()
      expect(errors).toEqual([])
    })

    it('fails with SyncAdapterError once closed', async (ctx) => {
      requireBackend(ctx)
      const { adapter } = await fresh()
      await adapter.close()
      await adapter.close()
      await expect(adapter.head()).rejects.toBeInstanceOf(SyncAdapterError)
    })
  })
}
