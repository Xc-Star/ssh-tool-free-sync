import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results'
})
