// vitest setupFile, wired by vitest.config.ts ONLY when COS_TEST_FENCE=1. It runs once per forked
// test file, before that file's imports, so module-scope constants (DATA_DIR and friends) are
// resolved against the private scratch area. See test-support/fence.ts.
import { appendFileSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect } from 'vitest'
import { applyFence, fenceRequested } from './fence.js'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Test files that need the real TMPDIR (test-support/real-tmpdir.txt: path, then an optional "# reason"). */
function needsRealTmpdir(testPath: string | undefined): boolean {
  if (!testPath) return false
  const rel = relative(PACKAGE_ROOT, testPath)
  const listed = readFileSync(fileURLToPath(new URL('./real-tmpdir.txt', import.meta.url)), 'utf8')
    .split('\n').map(line => line.replace(/#.*$/, '').trim()).filter(Boolean)
  return listed.includes(rel)
}

if (fenceRequested(process.env)) {
  const fence = applyFence(process.env, undefined, { keepTmpdir: needsRealTmpdir(expect.getState().testPath) })
  // afterAll covers a normal finish; the exit hook covers a file that fails inside a hook.
  afterAll(fence.cleanup)
  process.once('exit', fence.cleanup)
  // The driver (scripts/run-fenced.mjs) names a registry file; each fork records its root and test
  // file so the driver can remove, and report, any scratch area a fork left behind (a late write
  // recreated it after cleanup, or the worker was torn down before its hooks ran).
  const registry = process.env.COS_TEST_FENCE_REGISTRY
  if (registry) {
    try { appendFileSync(registry, `${fence.root}\t${relative(PACKAGE_ROOT, expect.getState().testPath ?? '')}\n`) } catch { /* registry is best effort */ }
  }
}
