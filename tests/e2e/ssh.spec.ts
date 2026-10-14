import { expect, test } from '@playwright/test'
import { startTestSshServer, type TestSshServer } from '../helpers/ssh-test-server'
import { activeSessionId, launchApp, type Running, rpc, terminalText } from './app'

// The tests share one app and server (the second relies on the host key trusted by the first).
test.describe.configure({ mode: 'serial' })

let server: TestSshServer
let a: Running

test.beforeAll(async () => {
  server = await startTestSshServer({ users: { test: { password: 'test' } } })
  a = await launchApp('ssh')
})

test.afterAll(async () => {
  await a?.close()
  await server?.close()
})

test('create a host in the UI, trust its key and use the terminal', async () => {
  const { win } = a
  await win.click('[data-testid=new-host]')
  await win.fill('[data-testid=host-address]', '127.0.0.1')
  await win.fill('[data-testid=host-label]', 'e2e-server')
  await win.fill('[data-testid=host-port]', String(server.port))
  await win.fill('[data-testid=host-username]', 'test')
  await win.fill('[data-testid=host-password]', 'test')
  await win.click('[data-testid=host-save]')

  const card = win.locator('[data-testid=host-card]', { hasText: 'e2e-server' })
  await expect(card).toBeVisible()
  await card.click()

  // First connection: host key verification dialog.
  await win.waitForSelector('[data-testid=prompt-hostkey]')
  await expect(win.locator('[data-testid=prompt-hostkey]')).toContainText(server.hostKeyFingerprint)
  await win.click('[data-testid=hostkey-accept]')

  await expect(win.locator('[data-testid=terminal-tab]')).toHaveCount(1)
  const sid = await activeSessionId(win)
  await expect.poll(() => terminalText(win, sid)).toContain('Welcome to test-ssh')
  await win.keyboard.type('echo e2e-terminal-ok')
  await win.keyboard.press('Enter')
  await expect.poll(() => terminalText(win, sid)).toMatch(/\ne2e-terminal-ok/)

  // OS detection updates the host avatar (test server reports Ubuntu).
  await expect.poll(async () => (await rpc<any[]>(win, 'vault.list', 'host'))[0]?.data.osHint).toBe('ubuntu')

  // The host key is now trusted (and listed under Known Hosts).
  const known = await rpc<any[]>(win, 'vault.list', 'knownHost')
  expect(known[0].data.fingerprint).toBe(server.hostKeyFingerprint)

  // Split the pane: a second session to the same host opens without a host key prompt.
  await win.click('[data-testid=terminal-pane]', { button: 'right', modifiers: ['Shift'] })
  await win.getByRole('menuitem', { name: '向右分屏' }).click()
  await expect(win.locator('[data-testid=terminal-view]:not(.invisible) [data-testid=terminal-pane]')).toHaveCount(2)
})

test('command palette quick connect', async () => {
  const { win } = a
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+Shift+K')
  await win.waitForSelector('[data-testid=command-palette]')
  await win.keyboard.type(`ssh -p ${server.port} test@127.0.0.1`)
  await win.keyboard.press('Enter')
  // known host → no prompt; password unknown for this inline target → password prompt
  await win.waitForSelector('[data-testid=prompt-password]')
  await win.fill('[data-testid=prompt-input]', 'test')
  await win.click('[data-testid=prompt-submit]')
  const sid = await activeSessionId(win)
  await expect.poll(() => terminalText(win, sid)).toContain('Welcome to test-ssh')
})
