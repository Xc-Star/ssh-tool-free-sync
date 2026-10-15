import { expect, test } from '@playwright/test'
import { launchApp } from './app'

/**
 * Regression guard for ⌘Q: `will-quit` cancels the quit to tear the services down and then resumes it.
 * That resume used to be ignored (it ran while `will-quit` was still being emitted), so the process
 * stayed alive with no window. The harness force-kills on close, hence asserting the real exit code.
 */
test('quitting the app exits the process completely', async () => {
  const running = await launchApp('quit')
  try {
    const proc = running.app.process()
    const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)))

    await running.app.evaluate(({ app }) => {
      app.quit()
    })

    await expect(
      Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the app was still running 20 s after quit')), 20_000)
        )
      ])
    ).resolves.toBe(0)
  } finally {
    await running.close()
  }
})
