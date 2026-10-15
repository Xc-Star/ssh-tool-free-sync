import { expect, test } from '@playwright/test'
import { activeSessionId, launchApp, terminalText } from './app'

/** The Hosts page header exposes a one-click shortcut to a shell on this machine. */
test('the Hosts page button opens a working local terminal', async () => {
  const a = await launchApp('local-terminal')
  try {
    const { win } = a
    const button = win.locator('[data-testid=open-local-terminal]')
    await expect(button).toBeVisible()
    await button.click()

    await expect(win.locator('[data-testid=terminal-tab]')).toHaveCount(1)
    const sid = await activeSessionId(win)

    // Wait for the shell to draw something before typing: keys sent before the pty is up are dropped.
    await expect.poll(() => terminalText(win, sid)).toMatch(/\S/)
    await win.keyboard.type('echo e2e-local-terminal-ok')
    await win.keyboard.press('Enter')
    await expect.poll(() => terminalText(win, sid)).toContain('e2e-local-terminal-ok')
  } finally {
    await a.close()
  }
})
