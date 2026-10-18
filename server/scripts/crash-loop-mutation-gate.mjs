#!/usr/bin/env node
// Crash-loop parking 6.78.0 (MVP-C) mutation gate: the gate (lib/boot-resume.ts), the query-job
// boot requeue, meeting finalization resume, the maintenance status and Retry route, and the
// composition-root wiring. Mutations run only in a disposable copy of the checkout; the live
// checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/crash-loop-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB = ['server/lib/boot-resume.test.ts']
const QJ = ['server/lib/query-job-coordinator-boot-resume.test.ts']
const MEET = ['server/routes/meeting-boot-resume.test.ts', 'server/routes/meeting.test.ts']
const ROUTE = ['server/routes/maintenance.test.ts']
const WIRE = ['server/lib/boot-resume-wiring.test.ts']
const ALL = [...LIB, ...QJ, ...MEET, ...ROUTE, ...WIRE]
const GATE = 'server/lib/boot-resume.ts', COORD = 'server/lib/query-job-coordinator.ts', STORE = 'server/lib/query-job-store.ts'
const TYPES = 'server/lib/query-job-types.ts', RUNTIME = 'server/lib/query-job-runtime.ts', MEETING = 'server/routes/meeting.ts'
const MAINT = 'server/routes/maintenance.ts', INDEX = 'server/index.ts'
const m = (name, file, edits, tests = LIB) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The gate: counting ──
  m('crashed-boot-counts', GATE, ["      this.crashedBoot = this.loaded === 'ok' && !file.cleanShutdown", '      this.crashedBoot = false'], [...LIB, ...QJ, ...MEET]),
  m('clean-boot-never-counts', GATE, ["      this.crashedBoot = this.loaded === 'ok' && !file.cleanShutdown", "      this.crashedBoot = this.loaded === 'ok'"], [...LIB, ...QJ, ...MEET]),
  m('missing-ledger-is-clean', GATE, ["      this.crashedBoot = this.loaded === 'ok' && !file.cleanShutdown", '      this.crashedBoot = !file.cleanShutdown'], [...LIB, ...QJ]),
  m('count-increments', GATE, ['        entry.attempts = consecutive ? entry.attempts + 1 : 1', '        entry.attempts = consecutive ? entry.attempts : 1'], [...LIB, ...QJ]),
  m('window-restarts-count', GATE, ['        entry.attempts = consecutive ? entry.attempts + 1 : 1', '        entry.attempts = entry.attempts + 1']),
  m('window-30-minutes', GATE, ['this.now() - last < CRASH_LOOP_WINDOW_MS', 'this.now() - last < CRASH_LOOP_WINDOW_MS + 2 * 60_000']),
  m('window-from-last-count', GATE, ['        entry.lastAttemptAt = this.iso()', '        entry.lastAttemptAt ??= this.iso()']),
  m('limit-comparison', GATE, ['      if (entry.attempts > this.limit) {', '      if (entry.attempts >= this.limit) {'], [...LIB, ...QJ]),
  m('phase-reset', GATE, ['      if (entry && entry.phase !== phase) {', '      if (false) {'], [...LIB, ...MEET]),
  m('parked-check', GATE, ['      if (before?.parked) {', '      if (false) {'], [...LIB, ...MEET]),
  m('one-count-per-boot', GATE, ['      const counts = this.crashedBoot === true && !this.seenThisBoot.has(key)', '      const counts = this.crashedBoot === true']),
  m('fail-open-on-write', GATE, ["      if (!this.save('admit')) {", "      if (!this.save('admit') && false) {"]),
  m('flag-default-on', GATE, ["  if (raw === '0' || raw === 'false' || raw === 'off') return false\n  return true\n", "  if (raw === '0' || raw === 'false' || raw === 'off') return false\n  return false\n"], [...LIB, ...QJ]),
  m('flag-off-forces-off', GATE, ["  if (raw === '0' || raw === 'false' || raw === 'off') return false\n", ''], [...LIB, ...QJ]),
  m('clean-shutdown-write', GATE, ['      file.cleanShutdown = true', '      file.cleanShutdown = false'], [...LIB, ...QJ]),
  m('clean-shutdown-resets-counts', GATE, ['        if (!entry || entry.parked) continue\n        file.entries[key] =', '        if (true) continue\n        file.entries[key] =']),
  m('clean-shutdown-keeps-parked', GATE, ['        if (!entry || entry.parked) continue', '        if (!entry) continue']),
  m('open-clears-marker', GATE, ['      file.cleanShutdown = false\n', '']),
  m('wrong-shape-quarantined', GATE, ['          try { renameSync(this.path, quarantinedAs) } catch { quarantinedAs = null }', '          quarantinedAs = null']),
  m('retry-unparks', GATE, ['{ ...before, attempts: 0, parked: false, reason: null,', '{ ...before, attempts: 0, parked: before.parked, reason: null,'], [...LIB, ...ROUTE, ...MEET]),
  m('retry-resets-count', GATE, ['{ ...before, attempts: 0, parked: false, reason: null,', '{ ...before, attempts: before.attempts, parked: false, reason: null,'], [...LIB, ...QJ]),
  m('forget-removes', GATE, ["      delete file.entries[key]\n      this.save('forget')", "      this.save('forget')"], [...LIB, ...MEET]),
  m('prune-stale', GATE, ['    if (!Number.isFinite(touched) || nowMs - touched > STALE_MS) delete file.entries[key]', '    if (false) delete file.entries[key]']),
  m('prune-keeps-parked', GATE, ['    if (entry.parked) continue\n', '']),
  m('prune-cap', GATE, ['  if (keys.length <= MAX_ENTRIES) return', '  return']),
  m('status-lists-parked', GATE, ['        .filter(entry => entry.parked)', '        .filter(entry => !entry.parked)'], [...LIB, ...ROUTE]),

  // ── Query jobs ──
  m('qj-admit-before-start', COORD, ["      if (!this.admitBootRequeue(jobId)) { parked.push(jobId); continue }\n      queueMicrotask(() => { void this.execute(jobId, sessionId) })",
    "      queueMicrotask(() => { void this.execute(jobId, sessionId) })\n      if (!this.admitBootRequeue(jobId)) { parked.push(jobId); continue }"], QJ),
  m('qj-keyed-by-lineage', COORD, ["      return gate.admit('query_job', this.store.lineageOf(jobId) ?? jobId, 'start')", "      return gate.admit('query_job', jobId, 'start')"], QJ),
  m('qj-parked-goes-terminal', COORD, ['    for (const jobId of parked) await this.parkBootRequeue(jobId)\n', ''], QJ),
  m('qj-retry-on-resume', COORD, ["          if (admission.job.generation > 1) this.bootResumeLineage('retry', admission.job.clientJobId)\n", ''], QJ),
  m('qj-forget-on-start', COORD, ["          this.bootResumeLineage('forget', starting.job.clientJobId)\n", ''], QJ),
  m('qj-park-only-never-started', STORE, ["      if (hydrated.snapshot.status !== 'accepted') return { applied: false, job: clone(hydrated.snapshot) }\n      return this.persistMutation(hydrated, 'interrupted', 'interrupted', {",
    "      return this.persistMutation(hydrated, 'interrupted', 'interrupted', {"], QJ),
  m('qj-cause-allowlist', TYPES, ["new Set(['crash_loop_parked'])", 'new Set([])'], QJ),
  m('qj-runtime-passes-gate', RUNTIME, ['  bootResumeGate,\n', ''], WIRE),

  // ── Meeting finalization ──
  m('mf-admit-before-resume', MEETING, ["    if (!gate.admit('meeting_finalization', job.sessionId, job.phase)) continue\n    schedule(job)",
    "    schedule(job)\n    if (!gate.admit('meeting_finalization', job.sessionId, job.phase)) continue"], MEET),
  m('mf-forget-on-finish', MEETING, ["    bootResumeGate().forget('meeting_finalization', current.sessionId)\n    finalizationRetryCounts.delete(key)", '    finalizationRetryCounts.delete(key)'], MEET),
  m('mf-forget-when-already-complete', MEETING, ["      bootResumeGate().forget('meeting_finalization', current.sessionId)\n      return\n", '      return\n'], MEET),
  m('mf-replay-skips-parked', MEETING, ["if (pendingJob && !bootResumeGate().isParked('meeting_finalization', sessionId))", 'if (pendingJob)'], MEET),
  m('mf-retry-resumes-one', MEETING, ['    if (options.sessionId !== undefined && job.sessionId !== options.sessionId) continue\n', ''], MEET),

  // ── Maintenance surface ──
  m('status-parked-field', MAINT, ['    parked: parkedSnapshot(),', '    parked: [],'], ROUTE),
  m('route-404-not-parked', MAINT, ['  if (!gate.isParked(kind, id)) {', '  if (false) {'], ROUTE),
  m('route-400-unknown-kind', MAINT, ['  if (!isBootResumeKind(kind)) {', '  if (false) {'], ROUTE),
  m('route-resumes-meeting', MAINT, ['  const resumed = resumeRetriedItem(kind, id)', '  const resumed = false'], ROUTE),
  m('route-token-not-loopback', MAINT, ["maintenanceRouter.post('/maintenance/parked/:kind/:id/retry', (req, res) => {\n", "maintenanceRouter.post('/maintenance/parked/:kind/:id/retry', (req, res) => {\n  if (!requireLoopback(req, res)) return\n"], ROUTE),

  // ── Composition root (source-shape tests: index.ts cannot be executed) ──
  m('index-open-before-resume', INDEX, ['    bootResume.openBoot()\n    // Resume already-saved meetings whose post-response HQ/operations work\n    // was interrupted by a prior server update or process exit.\n    resumeMeetingFinalizationJobs()',
    '    // Resume already-saved meetings whose post-response HQ/operations work\n    // was interrupted by a prior server update or process exit.\n    resumeMeetingFinalizationJobs()\n    bootResume.openBoot()'], WIRE),
  m('index-clean-shutdown', INDEX, ['  bootResume.markCleanShutdown()\n', ''], WIRE),
  m('index-marker-at-start', INDEX, [['  bootResume.markCleanShutdown()\n  const forceExit', '  const forceExit'],
    ['  clearTimeout(forceExit)\n  process.exit(0)', '  bootResume.markCleanShutdown()\n  clearTimeout(forceExit)\n  process.exit(0)']], WIRE),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length && !args.includes('--check') ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && !args.includes('--check') && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
// --check: every target matches exactly once and changes its file. Runs no tests.
if (args.includes('--check')) {
  let bad = 0
  for (const { name, file, edits } of mutations) {
    let text = readFileSync(join(root, file), 'utf8')
    const original = text
    for (const [find, replacement] of edits) {
      const n = text.split(find).length - 1
      if (n !== 1) { console.log(`${name}: matches ${n} times in ${file}: ${find.slice(0, 90)}`); bad++ }
      else text = text.replace(find, () => replacement)
    }
    if (text === original) { console.log(`${name}: no change`); bad++ }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'crash-loop-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
  let killed = 0
  for (const { name, file, edits, tests } of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    let mutated = original
    for (const [find, replacement] of edits) {
      if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 80)}`)
      mutated = mutated.replace(find, () => replacement)
    }
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} crash-loop parking 6.78.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
