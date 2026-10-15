import { expect, test } from '@playwright/test'
import { launchApp } from './app'

const terminalTabs = '[data-testid=terminal-tab]'
const visibleTerminal = '[data-testid=terminal-view]:not(.invisible)'

/** Closing terminal tabs must land on a neighbouring terminal, and on the vault once none are left. */
test('closing terminal tabs falls back to the vault, never SFTP', async () => {
  const a = await launchApp('tab-close')
  try {
    const { win } = a
    const vault = win.locator('[data-testid=tab-vault]')
    const sftp = win.locator('[data-testid=tab-sftp]')

    await win.click('[data-testid=open-local-terminal]')
    await expect(win.locator(terminalTabs)).toHaveCount(1)
    // Opening a terminal activates it, so go back to the vault before using the header button again.
    await win.click('[data-testid=tab-vault]')
    await win.click('[data-testid=open-local-terminal]')
    await expect(win.locator(terminalTabs)).toHaveCount(2)

    // Closing the active tab hands focus to the remaining terminal, not to a pinned tab.
    await win.locator(terminalTabs).last().locator('button[aria-label="close tab"]').click()
    await expect(win.locator(terminalTabs)).toHaveCount(1)
    await expect(win.locator(visibleTerminal)).toHaveCount(1)
    await expect(vault).toHaveAttribute('data-active', 'false')
    await expect(sftp).toHaveAttribute('data-active', 'false')

    // Closing the last one lands on the vault (it used to activate SFTP instead).
    await win.locator(terminalTabs).first().locator('button[aria-label="close tab"]').click()
    await expect(win.locator(terminalTabs)).toHaveCount(0)
    await expect(vault).toHaveAttribute('data-active', 'true')
    await expect(sftp).toHaveAttribute('data-active', 'false')
  } finally {
    await a.close()
  }
})
