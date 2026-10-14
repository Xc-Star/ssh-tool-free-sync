import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, removeProfile, type Running, rpc } from './app'

// Loaded without an import statement: Playwright's TS loader hook cannot resolve the `node:sqlite` builtin.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')

const running: Running[] = []
let profile: string | undefined

test.afterAll(async () => {
  for (const r of running) await r.close({ keepData: true })
  if (profile) removeProfile(profile)
})

test('an unusable OS keychain shows a recovery screen instead of a dead window; reset starts over', async () => {
  const a = await launchApp('recovery')
  running.push(a)
  profile = a.userData
  await rpc(a.win, 'vault.upsert', 'host', { label: 'lost-host', address: '10.7.7.7' })
  await a.close({ keepData: true })

  // Simulate a keychain that can no longer decrypt the stored vault key (desktop/keyring changed, profile copied…).
  const db = new DatabaseSync(path.join(profile, 'vault.db'))
  const rec = JSON.parse((db.prepare("SELECT v FROM kv WHERE k = 'keystore'").get() as { v: string }).v)
  test.skip(rec.mode !== 'os', 'no OS keychain on this machine')
  rec.osBlob = Buffer.from('not a keychain blob').toString('base64')
  db.prepare("UPDATE kv SET v = ? WHERE k = 'keystore'").run(JSON.stringify(rec))
  db.close()

  const b = await launchApp('recovery-2', { userData: profile })
  running.push(b)
  const panel = b.win.locator('[data-testid=keystore-error]')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('无法打开本机保险库')
  await b.win.click('[data-testid=keystore-retry]')
  await expect(panel).toBeVisible()

  await b.win.click('[data-testid=keystore-reset]')
  await b.win.click('[data-testid=confirm-ok]')
  await expect(panel).toHaveCount(0)
  await expect(b.win.locator('[data-testid=new-host]')).toBeVisible()
  expect(await rpc<unknown[]>(b.win, 'vault.list', 'host')).toHaveLength(0)
  await rpc(b.win, 'vault.upsert', 'host', { label: 'fresh-host', address: '10.8.8.8' })
  await expect(b.win.locator('[data-testid=host-card]', { hasText: 'fresh-host' })).toBeVisible()
})
