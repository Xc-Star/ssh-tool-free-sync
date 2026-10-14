import { expect, type Page, test } from '@playwright/test'
import { type D1Mock, startD1Mock } from '../helpers/d1-mock-server'
import { launchApp, removeProfile, type Running, rpc } from './app'

const MASTER = 'correct-horse-battery-staple'

let mock: D1Mock
const running: Running[] = []
const profiles: string[] = []

test.beforeAll(async () => {
  mock = await startD1Mock()
})

test.afterAll(async () => {
  for (const r of running) await r.close({ keepData: true })
  for (const p of profiles) removeProfile(p)
  await mock?.close()
})

async function launch(name: string, userData?: string): Promise<Running> {
  const r = await launchApp(name, { userData })
  running.push(r)
  if (!profiles.includes(r.userData)) profiles.push(r.userData)
  return r
}

const card = (r: Running, label: string) => r.win.locator('[data-testid=host-card]', { hasText: label })

async function openSyncSettings(win: Page): Promise<void> {
  await win.click('[data-testid=nav-settings]')
  await win.click('[data-testid=settings-nav-sync]')
  await win.waitForSelector('[data-testid=sync-section]')
}

/** Wizard steps 1 and 2: pick Cloudflare D1, fill in the connection and test it. */
async function connectD1(win: Page): Promise<void> {
  await win.click('[data-testid=sync-db-d1]')
  await win.fill('[data-testid=sync-field-account-id]', mock.accountId)
  await win.fill('[data-testid=sync-field-database-id]', mock.databaseId)
  await win.fill('[data-testid=sync-field-api-token]', mock.token)
  await win.click('[data-testid=sync-advanced-toggle]')
  await win.fill('[data-testid=sync-field-base-url]', mock.baseUrl)
  await win.click('[data-testid=sync-test]')
}

test('set up sync in the wizard, join from a second device, keep syncing after a restart', async () => {
  // Device A: create the vault through the UI.
  const a = await launch('wizard-a')
  await rpc(a.win, 'vault.upsert', 'host', { label: 'wizard-a-host', address: '10.9.9.1', password: 'pw-a' })
  await openSyncSettings(a.win)
  await connectD1(a.win)
  const create = a.win.locator('[data-testid=sync-vault-create]')
  await expect(create).toBeVisible()
  await a.win.fill('[data-testid=sync-master-password]', MASTER)
  await a.win.fill('[data-testid=sync-master-password-confirm]', MASTER)
  await a.win.click('[data-testid=sync-ack-unrecoverable]')
  await create.locator('button[type=submit]').click()
  await a.win.click('[data-testid=sync-done]')
  await expect(a.win.locator('[data-testid=sync-dashboard]')).toBeVisible()
  await expect(a.win.locator('[data-testid=sync-state-label]')).toHaveText('已是最新')

  // Device B: the same connection finds the vault → join; a wrong password is rejected inline.
  const b = await launch('wizard-b')
  await openSyncSettings(b.win)
  await connectD1(b.win)
  const join = b.win.locator('[data-testid=sync-vault-join]')
  await expect(join).toBeVisible()
  await b.win.fill('[data-testid=sync-master-password]', 'not-the-password')
  await join.locator('button[type=submit]').click()
  await expect(join).toContainText('主密码错误')
  await b.win.fill('[data-testid=sync-master-password]', MASTER)
  await join.locator('button[type=submit]').click()
  await b.win.click('[data-testid=sync-done]')
  await expect(b.win.locator('[data-testid=sync-device]')).toHaveCount(2)
  await expect(b.win.locator('[data-testid=sync-dashboard]')).not.toContainText('未知设备')
  await b.win.click('[data-testid=nav-hosts]')
  await expect(card(b, 'wizard-a-host')).toBeVisible()

  // A quits; B keeps working; A restarts with the same profile and catches up on its own
  // (sync reconnects on startup, no manual "sync now").
  const profileA = a.userData
  await a.close({ keepData: true })
  await rpc(b.win, 'vault.upsert', 'host', { label: 'added-while-a-was-off', address: '10.9.9.2' })
  await expect.poll(async () => (await rpc<{ pendingChanges: number }>(b.win, 'sync.status')).pendingChanges, { timeout: 15_000 }).toBe(0)

  const a2 = await launch('wizard-a2', profileA)
  await expect(card(a2, 'added-while-a-was-off')).toBeVisible({ timeout: 30_000 })
  await expect(card(a2, 'wizard-a-host')).toBeVisible()
  await expect
    .poll(async () => {
      const s = await rpc<{ state: string; configured: boolean }>(a2.win, 'sync.status')
      return `${s.configured}:${s.state}`
    })
    .toBe('true:idle')
  // Secrets survive the restart (decrypted with the locally protected vault key).
  const hosts = await rpc<any[]>(a2.win, 'vault.list', 'host')
  const own = hosts.find((h) => h.data.label === 'wizard-a-host')
  expect((await rpc<any>(a2.win, 'vault.reveal', own.id)).data.password).toBe('pw-a')
})
