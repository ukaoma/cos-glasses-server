import { defineConfig } from 'vitest/config'
import base from '../../vitest.config.js'

// A bounded, explicit two-worker check; the global suite remains serial by default.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test-support/isolation-canary/*.test.ts'],
    minWorkers: 2,
    maxWorkers: 2,
    testTimeout: 10_000,
  },
})
