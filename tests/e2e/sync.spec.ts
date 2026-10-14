import { expect, test } from '@playwright/test'
import { type D1Mock, startD1Mock } from '../helpers/d1-mock-server'
import { launchApp, type Running, rpc } from './app'

const MASTER = 'correct-horse-battery-staple'

let mock: D1Mock
let a: Running
let b: Running

test.beforeAll(async () => {
  mock = await startD1Mock()
  a = await launchApp('sync-a')
  b = await launchApp('sync-b')
})

test.afterAll(async () => {
  await a?.close()
  await b?.close()
  await mock?.close()
})

function config() {
  return { kind: 'd1', accountId: mock.accountId, databaseId: mock.databaseId, apiToken: mock.token, tablePrefix: 'sshtool_', baseUrl: mock.baseUrl }
}

const card = (r: Running, label: string) => r.win.locator('[data-testid=host-card]', { hasText: label })

test('two devices sync hosts through Cloudflare D1 (end-to-end encrypted)', async () => {
  // Device A has data before sync is set up and creates the vault.
  await rpc(a.win, 'vault.upsert', 'host', { label: 'from-a', address: '10.1.1.1', username: 'root', password: 'secret-from-a' })
  const test1 = await rpc<{ ok: boolean; hasVault: boolean }>(a.win, 'sync.test', config())
  expect(test1).toMatchObject({ ok: true, hasVault: false })
  await rpc(a.win, 'sync.create', config(), MASTER)
  await expect(a.win.locator('[data-testid=sync-indicator]')).toBeVisible()

  // Nothing readable ends up in the database.
  const rows = mock.db.prepare('SELECT payload FROM sshtool_items').all() as { payload: string | null }[]
  expect(rows.length).toBeGreaterThan(0)
  const dump = JSON.stringify(rows)
  expect(dump).not.toContain('10.1.1.1')
  expect(Buffer.from(rows.map((r) => r.payload ?? '').join(''), 'base64').toString('latin1')).not.toContain('secret-from-a')

  // Device B has its own host and joins: data is merged both ways.
  await rpc(b.win, 'vault.upsert', 'host', { label: 'from-b', address: '10.2.2.2' })
  const test2 = await rpc<{ ok: boolean; hasVault: boolean }>(b.win, 'sync.test', config())
  expect(test2.hasVault).toBe(true)
  await expect(rpc(b.win, 'sync.join', config(), 'wrong password!')).rejects.toThrow(/Wrong master password/)
  await rpc(b.win, 'sync.join', config(), MASTER)
  await expect(card(b, 'from-a')).toBeVisible()
  await expect(card(b, 'from-b')).toBeVisible()
  await rpc(a.win, 'sync.now')
  await expect(card(a, 'from-b')).toBeVisible()

  // Secrets arrive intact (revealed on demand only).
  const hostsB = await rpc<any[]>(b.win, 'vault.list', 'host')
  const fromA = hostsB.find((h) => h.data.label === 'from-a')
  expect(fromA.data.password).not.toBe('secret-from-a')
  expect((await rpc<any>(b.win, 'vault.reveal', fromA.id)).data.password).toBe('secret-from-a')

  // Edit on B through the UI → appears on A.
  await card(b, 'from-a').hover()
  await card(b, 'from-a').locator('[data-testid=host-edit]').click()
  await b.win.fill('[data-testid=host-label]', 'renamed-on-b')
  await b.win.click('[data-testid=host-save]')
  await expect(card(b, 'renamed-on-b')).toBeVisible()
  await expect.poll(async () => (await rpc<{ pendingChanges: number }>(b.win, 'sync.status')).pendingChanges, { timeout: 15000 }).toBe(0)
  await rpc(a.win, 'sync.now')
  await expect(card(a, 'renamed-on-b')).toBeVisible()
  await expect(card(a, 'from-a')).toHaveCount(0)

  // Delete on A → disappears on B.
  const hostsA = await rpc<any[]>(a.win, 'vault.list', 'host')
  await rpc(a.win, 'vault.remove', [hostsA.find((h) => h.data.label === 'from-b').id])
  await rpc(a.win, 'sync.now')
  await rpc(b.win, 'sync.now')
  await expect(card(b, 'from-b')).toHaveCount(0)

  // Both devices are listed.
  const devices = await rpc<{ current: boolean }[]>(a.win, 'sync.devices')
  expect(devices).toHaveLength(2)
  expect(devices.filter((d) => d.current)).toHaveLength(1)
})
