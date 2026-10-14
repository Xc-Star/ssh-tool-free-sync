import { defineConfig } from '@playwright/test'

/** Regenerates the README screenshots in docs/screenshots/ (`npm run screenshots`). Not part of the E2E suite. */
export default defineConfig({
  testDir: 'tests/screenshots',
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/screenshots'
})
