// vitest setupFile, wired by vitest.config.ts ONLY when COS_TEST_FENCE=1. It runs once per forked
// test file, before that file's imports, so module-scope constants (DATA_DIR and friends) are
// resolved against the private scratch area. See test-support/fence.ts.
import { afterAll } from 'vitest'
import { applyFence, fenceRequested } from './fence.js'

if (fenceRequested(process.env)) {
  const fence = applyFence(process.env)
  // afterAll covers a normal finish; the exit hook covers a file that fails inside a hook.
  afterAll(fence.cleanup)
  process.once('exit', fence.cleanup)
}
