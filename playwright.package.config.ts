import { defineConfig } from '@playwright/test'

/** Smoke-tests a packaged build (`npx electron-builder --dir` first): `npm run test:package`. Not part of the E2E suite. */
export default defineConfig({
  testDir: 'tests/package',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/package'
})
