#!/usr/bin/env node
// Turn-request binding mutation gate (lib/turn-request.ts and its three bridge call sites).
//
// Mutations run only in a disposable copy of server/ and shared/; the live checkout, which a
// running server may be loading, is never rewritten. Order of proof:
//   0. the target suites are GREEN unmutated, or the gate refuses (a red suite "kills" every
//      mutant and the count means nothing);
//   1. each find string appears EXACTLY once in its file;
//   2. the mutated file on disk differs from the original;
//   3. the mutant is killed only when the NAMED test expected to catch it is among the failing
//      tests in vitest's JSON report. Any other failure (a transform error, a crash, some
//      unrelated test) is reported as a harness failure, never as a kill.
//
// Usage: node server/scripts/turn-request-mutation-gate.mjs [--list] [name ...]
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/turn-request.test.ts', 'server/lib/turn-request-bridges.test.ts']
const HELPER = 'server/lib/turn-request.ts'
const CLAUDE = 'server/lib/claude-bridge.ts'
const CODEX = 'server/lib/codex-bridge.ts'
const CURSOR = 'server/lib/cursor-bridge.ts'
const INDEX = 'server/index.ts'

// [name, file, find, replacement, the test that must fail: a substring of vitest's fullName,
// which joins describe and test titles with a single space]
const mutations = [
  ['empty-query-writes-file', HELPER, '  if (!stripped) return null\n', '', 'writes nothing when there is no genuine user query'],
  ['unbindable-text-writes-file', HELPER, "if (typeof input.prompt !== 'string' || !input.prompt.includes(stripped)) return null", "if (typeof input.prompt !== 'string') return null", 'writes nothing when the user text is not inside the prompt'],
  ['js-trim-instead-of-python-strip', HELPER, "  return text.replace(PY_STRIP, '')", '  return text.trim()', 'strips exactly the Python str.isspace() set'],
  ['python3-disagrees-with-js-trim', HELPER, "  return text.replace(PY_STRIP, '')", '  return text.trim()', 'matches hashlib.sha256(prompt.strip()) computed by python3'],
  ['hash-of-unstripped-prompt', HELPER, "update(stripLikePython(prompt), 'utf8')", "update(prompt, 'utf8')", 'writes the contract shape, in the contract key order'],
  ['no-64kb-limit', HELPER, "  if (Buffer.byteLength(body, 'utf8') >= TURN_REQUEST_MAX_BYTES) return null\n", '', 'writes nothing at or over the 64 KB limit'],
  ['file-not-0600', HELPER, '    fchmodSync(fd, 0o600)', '    fchmodSync(fd, 0o644)', 'creates the directory 0700 and the file 0600'],
  ['open-dir-not-tightened', HELPER, '  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)\n', '', 'tightens an existing directory that was left open'],
  ['symlinked-dir-followed', HELPER, "  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('turn-requests is not a directory')\n", '', 'refuses a symlinked directory'],
  ['overwrite-same-turn', HELPER, 'fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |', 'fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC |', 'never overwrites a live file for the same turn id'],
  ['planted-symlink-followed', HELPER, 'fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |', 'fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC |', 'never writes through a symlink planted at the turn path'],
  ['unsafe-turn-id-as-file-name', HELPER, 'SAFE_TURN_ID.test(input.turnId)', 'input.turnId.length > 0', 'not a safe file name'],
  ['sweep-deletes-fresh-files', HELPER, '      if (nowMs - st.mtimeMs <= TURN_REQUEST_STALE_MS) continue\n', '', 'keeps a file just inside the hour'],
  ['sweep-deletes-nothing', HELPER, '      unlinkSync(file)\n      removed += 1', '      removed += 1', 'removes files older than an hour and keeps fresh ones'],
  ['no-first-use-sweep', HELPER, 'if (lastSweepAt === 0 || now.getTime() - lastSweepAt >= SWEEP_INTERVAL_MS) {', 'if (false) {', 'runs on first use'],
  ['no-release-on-exit', HELPER, "  child.once('exit', () => binding.release())\n", '', 'deletes the file on exit'],
  ['no-release-on-close', HELPER, "  child.once('close', () => binding.release())\n", '', 'deletes the file on close alone'],
  ['no-release-on-spawn-error', HELPER, '    if (child.pid === undefined) binding.release()', '    void 0', 'deletes the file on a spawn failure (error with no pid)'],
  ['release-on-running-child-error', HELPER, '    if (child.pid === undefined) binding.release()', '    binding.release()', 'keeps the file on an error from a child that is still running'],
  ['no-release-on-sync-throw', HELPER, '    binding?.release()\n    throw error', '    throw error', 'deletes the file when spawn throws synchronously'],
  ['inherited-path-forwarded', HELPER, '  delete env[TURN_REQUEST_ENV]\n', '', 'removes an inherited path when this spawn has no file'],
  ['claude-hashes-pre-ultracode-text', CLAUDE, 'createTurnRequestBinding({ userText: query, prompt: cliQuery,', 'createTurnRequestBinding({ userText: query, prompt: fullQuery,', 'hashes the ultracode keyword too'],
  ['claude-user-text-is-wrapped', CLAUDE, 'createTurnRequestBinding({ userText: query, prompt: cliQuery,', 'createTurnRequestBinding({ userText: fullQuery, prompt: cliQuery,', 'binds the user words behind an image preamble'],
  ['claude-env-not-applied', CLAUDE, '  applyTurnRequestEnv(env, turnRequest)\n', '', 'Claude bridge binds a plain turn'],
  ['claude-prewarm-forwards-inherited', CLAUDE, '    applyTurnRequestEnv(env, null)\n', '', 'pre-warm writes no file and strips an inherited path'],
  ['claude-file-outlives-child', CLAUDE, "spawnWithTurnRequest(turnRequest, () => spawn('claude'", "spawnWithTurnRequest(null, () => spawn('claude'", 'Claude bridge binds a plain turn and deletes the file when the child exits'],
  ['codex-hashes-user-request-only', CODEX, 'createTurnRequestBinding({ userText: query, prompt, turnId', 'createTurnRequestBinding({ userText: query, prompt: fullQuery, turnId', 'Codex bridge binds the SYSTEM INSTRUCTIONS'],
  ['codex-env-not-applied', CODEX, '  applyTurnRequestEnv(env, turnRequest)\n', '', 'Codex bridge writes a fresh file on the resume path'],
  ['codex-file-outlives-child', CODEX, 'spawnWithTurnRequest(turnRequest, () => spawn(resolvedCodex.path', 'spawnWithTurnRequest(null, () => spawn(resolvedCodex.path', 'Codex bridge removes the file when the inactivity timeout kills the child'],
  ['cursor-hashes-user-request-only', CURSOR, 'createTurnRequestBinding({ userText: query, prompt, turnId', 'createTurnRequestBinding({ userText: query, prompt: fullQuery, turnId', 'Cursor bridge binds the SYSTEM INSTRUCTIONS'],
  ['cursor-env-not-applied', CURSOR, '  applyTurnRequestEnv(env, turnRequest)\n', '', 'Cursor bridge writes a fresh file on the resume path'],
  ['cursor-file-outlives-child', CURSOR, 'spawnWithTurnRequest(turnRequest, () => spawn(agentBinary', 'spawnWithTurnRequest(null, () => spawn(agentBinary', 'Cursor bridge keeps the file while a SIGTERMed child is still alive'],
  ['cursor-turn-id-dropped', CURSOR, 'createTurnRequestBinding({ userText: query, prompt, turnId: options?.turnId })', 'createTurnRequestBinding({ userText: query, prompt, turnId: undefined })', 'uses the durable turn id as the file name'],
  ['startup-sweep-missing', INDEX, '    const staleTurnRequests = sweepStaleTurnRequests()\n', '    const staleTurnRequests = 0\n', 'sweeps stale turn-request files before the durable query runtime starts turns'],
]

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const [name, file, , , test] of mutations) console.log(`${name}\t${file}\t${test}`)
  process.exit(0)
}
const selected = args.length > 0 ? mutations.filter(m => args.includes(m[0])) : mutations
if (selected.length === 0) {
  console.error(`No matching mutations. Known: ${mutations.map(m => m[0]).join(', ')}`)
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'turn-request-mutations-'))
let exitCode = 0
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), {
    recursive: true,
    filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')),
  })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'tsconfig.json']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')

  const run = () => {
    const report = join(scratch, `report-${Date.now()}.json`)
    const result = spawnSync(process.execPath, [
      join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1',
      '--reporter=json', `--outputFile=${report}`, ...tests,
    ], {
      cwd: scratch,
      env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') },
      encoding: 'utf8',
      timeout: 180_000,
    })
    let parsed = null
    try { parsed = JSON.parse(readFileSync(report, 'utf8')) } catch { parsed = null }
    rmSync(report, { force: true })
    const failed = []
    let total = 0
    for (const suite of parsed?.testResults ?? []) {
      for (const a of suite.assertionResults ?? []) {
        total += 1
        if (a.status === 'failed') failed.push(a.fullName ?? a.title ?? '')
      }
    }
    return { status: result.status, error: result.error, parsed, failed, total, output: `${result.stdout}\n${result.stderr}` }
  }

  const baseline = run()
  if (baseline.status !== 0 || !baseline.parsed || baseline.failed.length > 0 || baseline.total === 0) {
    throw new Error(`Baseline is not green; a gate over a red suite proves nothing.\n${baseline.output}`)
  }
  console.log(`baseline PASS (${baseline.total} tests)`)

  let killed = 0
  const problems = []
  for (const [name, file, find, replacement, expected] of selected) {
    const target = join(scratch, file)
    const original = readFileSync(target, 'utf8')
    const hits = original.split(find).length - 1
    if (hits !== 1) { problems.push(`${name}: find appears ${hits} times in ${file}, expected 1`); continue }
    const mutated = original.replace(find, replacement)
    writeFileSync(target, mutated)
    if (readFileSync(target, 'utf8') === original) { problems.push(`${name}: the file did not change`); continue }
    const result = run()
    writeFileSync(target, original)
    const caught = result.failed.filter(t => t.includes(expected))
    if (result.status !== 0 && caught.length > 0) {
      killed += 1
      console.log(`${name} KILLED by "${caught[0]}"${result.failed.length > caught.length ? ` (+${result.failed.length - caught.length} more)` : ''}`)
    } else if (result.status === 0) {
      problems.push(`${name}: SURVIVED (suite green)`)
    } else {
      problems.push(`${name}: not attributed. Expected "${expected}" to fail; failing: ${result.failed.slice(0, 3).join(' | ') || '(none named)'}`)
    }
  }
  console.log(`${killed} of ${selected.length} turn-request mutations killed by their named test`)
  if (problems.length > 0) {
    exitCode = 1
    for (const line of problems) console.log(`  ${line}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
// exitCode, not process.exit(): exit() can drop output still queued on a pipe.
process.exitCode = exitCode
