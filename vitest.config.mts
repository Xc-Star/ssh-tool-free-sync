import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: 'forks'
  }
})
