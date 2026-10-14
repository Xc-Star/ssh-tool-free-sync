import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, type Running, rpc } from './app'

// Shared confirm / text prompt dialogs must put the keyboard where the user expects it
// (not on the dialog's close button), so Enter confirms and typing replaces the right text.
test.describe.configure({ mode: 'serial' })

let a: Running
let dir: string

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshtool-e2e-dialogs-'))
  fs.writeFileSync(path.join(dir, 'report.final.txt'), 'hello')
  a = await launchApp('dialogs')
})

test.afterAll(async () => {
  await a?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('confirm dialog: Enter confirms', async () => {
  const { win } = a
  await rpc(win, 'vault.upsert', 'host', { label: 'doomed-host', address: '10.0.0.9' })
  const card = win.locator('[data-testid=host-card]', { hasText: 'doomed-host' })
  await card.click({ button: 'right' })
  await win.getByRole('menuitem', { name: '删除' }).click()
  await expect(win.locator('[data-testid=confirm-ok]')).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(card).toHaveCount(0)
  expect(await rpc<unknown[]>(win, 'vault.list', 'host')).toHaveLength(0)
})

test('text prompt: input focused with the file stem selected (SFTP rename)', async () => {
  const { win } = a
  await win.click('[data-testid=tab-sftp]')
  await win.locator('[data-testid=sftp-breadcrumbs-left] button').last().click()
  await win.fill('[data-testid=sftp-path-input]', dir)
  await win.keyboard.press('Enter')
  const row = win.locator('[data-testid=sftp-pane-left] [data-testid=sftp-row][data-name="report.final.txt"]')
  await row.click({ button: 'right' })
  await win.getByRole('menuitem', { name: '重命名' }).click()

  await expect
    .poll(() =>
      win.evaluate(() => {
        const el = (globalThis as any).document.activeElement
        if (!el || el.tagName !== 'INPUT' || !el.closest('[role=dialog]')) return null
        return String(el.value).slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
      })
    )
    .toBe('report.final')
  // Nothing moves the selection afterwards (e.g. a late focus bounce).
  await win.waitForTimeout(300)
  await win.keyboard.type('renamed')
  await win.keyboard.press('Enter')
  await expect.poll(() => fs.existsSync(path.join(dir, 'renamed.txt'))).toBe(true)
  await expect(win.locator('[data-testid=sftp-pane-left] [data-testid=sftp-row][data-name="renamed.txt"]')).toBeVisible()
})
