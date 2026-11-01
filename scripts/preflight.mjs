#!/usr/bin/env node
// Fast fail-fast lane: the seconds-long checks that have failed AFTER a ~12 minute `npm test`
// (7 of 12 failing full runs, research-2), run first. It adds to the release gate; it replaces
// nothing. `npm test` is unchanged and still runs every one of these files again.
//
// Steps, in order, stopping at the first failure:
//   1. duplicates    iCloud copies ("name 2.ts") under the package
//   2. diff-check    git diff --check (GIT_PAGER=cat, or a hidden pager stalls it)
//   3. typecheck     tsc --noEmit
//   4. contracts     the contract test files below, via vitest, one worker
//
// A contract file that does not exist FAILS the lane, and so does a run whose executed file set is
// not exactly this list. vitest takes positional arguments as substring filters, so a missing file
// would otherwise just match nothing and the lane would stay green.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Contract files: read package.json, the changelog, the launcher, source shape or `npm pack --dry-run`. */
export const CONTRACT_FILES = [
  'server/lib/package-manifest.test.ts',     // version vs changelog, the zero-byte manifest class
  'server/lib/package-contents.test.ts',     // what npm would actually ship (npm pack --dry-run)
  'server/lib/launcher-contract.test.ts',    // npx launcher install contract, lockfile versions
  'server/routes/health-6890-parity.test.ts',
  'server/lib/key-lanes-spawn-census.test.ts', // a new provider spawn must be classified
  'server/lib/key-lanes-p6-census.test.ts',
  'server/routes/dictation-fuzzy-wiring.test.ts',
]

const steps = []
function step(name, fn) {
  const started = Date.now()
  console.log(`\n== preflight: ${name}`)
  const ok = fn()
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  steps.push({ name, ok, seconds })
  if (!ok) {
    console.error(`\npreflight FAILED at "${name}" after ${seconds}s. Nothing after it ran.`)
    summary()
    process.exit(1)
  }
  console.log(`== preflight: ${name} ok (${seconds}s)`)
}

function summary() {
  console.log('\npreflight summary')
  for (const s of steps) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name.padEnd(12)} ${s.seconds}s`)
}

function run(cmd, args, extraEnv = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...extraEnv } })
  return result.status === 0
}

function contracts() {
  const missing = CONTRACT_FILES.filter(f => !existsSync(join(ROOT, f)))
  if (missing.length > 0) {
    console.error(`contract file(s) missing:\n  ${missing.join('\n  ')}`)
    return false
  }
  const scratch = mkdtempSync(join(tmpdir(), 'cos-preflight-'))
  const out = join(scratch, 'result.json')
  try {
    // Fenced (test-support/fence.ts): health-6890-parity imports claude-bridge, which deletes the live
    // server's /tmp/cos-cli-sessions.json at import. A lane people run often must not do that.
    const ok = run('node_modules/.bin/vitest', ['run', '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, ...CONTRACT_FILES], { COS_TEST_FENCE: '1' })
    if (!existsSync(out)) { console.error('vitest wrote no JSON result'); return false }
    const result = JSON.parse(readFileSync(out, 'utf8'))
    const ran = result.testResults.map(r => relative(ROOT, r.name)).sort()
    const want = [...CONTRACT_FILES].sort()
    const absent = want.filter(f => !ran.includes(f))
    const extra = ran.filter(f => !want.includes(f))
    if (absent.length > 0 || extra.length > 0) {
      console.error(`contract file set mismatch.\n  did not run: ${absent.join(', ') || 'none'}\n  ran unlisted: ${extra.join(', ') || 'none'}`)
      return false
    }
    const empty = result.testResults.filter(r => r.assertionResults.length === 0).map(r => relative(ROOT, r.name))
    if (empty.length > 0) { console.error(`contract file(s) with zero tests: ${empty.join(', ')}`); return false }
    return ok
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = Date.now()
  step('duplicates', () => run('node', ['scripts/check-duplicates.mjs']))
  step('diff-check', () => run('git', ['diff', '--check'], { GIT_PAGER: 'cat', PAGER: 'cat' }))
  step('typecheck', () => run('node_modules/.bin/tsc', ['--noEmit']))
  step('contracts', contracts)
  summary()
  console.log(`\npreflight ok in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}
