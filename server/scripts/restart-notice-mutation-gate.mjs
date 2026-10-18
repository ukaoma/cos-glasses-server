#!/usr/bin/env node
// Restart truth 6.78.0 (plan v3.1 P2) mutation gate: the interruption record and its planner
// (lib/query-job-resume.ts), the store's restart paths, the coordinator's bounded shutdown drain,
// the MVP-D delta journal reader and writer, the switches, and the runtime wiring. Mutations run
// only in a disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/restart-notice-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RESUME = ['server/lib/query-job-resume.test.ts']
const NOTICE = ['server/lib/query-job-restart-notice.test.ts']
const DELTA = ['server/lib/query-job-delta-journal.test.ts']
const OFF = ['server/lib/query-job-flags-off-identity.test.ts']
const FEAT = ['server/lib/query-job-feature.test.ts']
const WIRE = ['server/lib/query-job-restart-notice-wiring.test.ts']
const ALL = [...RESUME, ...NOTICE, ...DELTA, ...OFF, ...FEAT, ...WIRE]
const PLAN = 'server/lib/query-job-resume.ts', STORE = 'server/lib/query-job-store.ts', TYPES = 'server/lib/query-job-types.ts'
const COORD = 'server/lib/query-job-coordinator.ts', FEATURE = 'server/lib/query-job-feature.ts', RUNTIME = 'server/lib/query-job-runtime.ts'
const m = (name, file, edits, tests = RESUME) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The record: what was cut off, what was already done ──
  m('done-skips-reads', PLAN, ['    if (!step.finished || SIDE_EFFECT_FREE_VERBS.has(step.verb)) continue', '    if (!step.finished) continue']),
  m('outcome-matched-by-call', PLAN, ['        const step = call ? [...steps].reverse().find(s => s.call === call && !s.finished) : undefined',
    '        const step = steps.find(s => !s.finished)']),
  m('callless-step-ambiguous', PLAN, ['      if (!call) ambiguous = true\n', '']),
  m('only-tool-rows-are-steps', PLAN, ["    if (entry.kind === 'tool') {", "    if (entry.kind !== 'status' && entry.kind !== 'prose') {"]),
  m('newest-five-done', PLAN, ['  const alreadyDone = done.slice(-limits.alreadyDoneMax)', '  const alreadyDone = done.slice(0, limits.alreadyDoneMax)']),
  m('dropped-done-incomplete', PLAN, ['    || done.length > alreadyDone.length\n', '']),
  m('tool-activity-off-incomplete', PLAN, ["    || input.activityToolMode === 'off'\n", '']),
  m('capped-trail-incomplete', PLAN, ['  const trailCapped = (trail?.length ?? 0) >= QUERY_JOB_LIMITS.trailEntries', '  const trailCapped = false && (trail?.length ?? 0) >= QUERY_JOB_LIMITS.trailEntries']),
  m('dropped-trail-head-incomplete', PLAN, ['Number((trail![0] as TrailLike).trailSeq) > 1)', 'Number((trail![0] as TrailLike).trailSeq) > 1e9)']),
  m('two-open-incomplete', PLAN, ['    || unfinished.length > 1\n', '']),
  m('ambiguous-incomplete', PLAN, ['    || ambiguous\n', '']),
  m('no-trail-incomplete', PLAN, ['    || (providerStarted && !(trail?.length))\n', '']),
  m('parked-not-resumable', PLAN, ["    resumable: input.cause !== 'crash_loop_parked',", '    resumable: true,']),
  m('parked-incomplete', PLAN, ["  const incomplete = input.cause === 'crash_loop_parked'\n", '  const incomplete = false\n']),
  m('step-line-only-for-newest', PLAN, ['  const openWords = open && open === lastStep && openDetail ?', '  const openWords = open && openDetail ?']),
  m('planner-waits-on-fence', PLAN, ["  if (Number.isFinite(fence) && fence > opts.now) return { action: 'wait'", "  if (false) return { action: 'wait'"]),
  m('planner-never-auto-resumes', PLAN, ["    action: 'ask_user',\n    reason: declaredReadOnly ? 'auto_resume_deferred'", "    action: declaredReadOnly ? 'auto_resume' : 'ask_user',\n    reason: declaredReadOnly ? 'auto_resume_deferred'"]),
  m('legacy-shutdown-message-read', PLAN, ["  if (error.message === 'server_shutdown') return 'server_shutdown'\n", '']),

  // ── Types: the allowlist, the message, the parser ──
  m('allowlist-keeps-restart-causes', TYPES, ["new Set(['server_restarted', 'server_shutdown', 'crash_loop_parked'])", "new Set(['crash_loop_parked'])"], [...RESUME, ...NOTICE]),
  m('restart-message', TYPES, ["export const QUERY_JOB_RESTART_MESSAGE = 'Server restarted. Tap to retry.'", "export const QUERY_JOB_RESTART_MESSAGE = 'Server restarted. Prompt preserved; provider was not restarted.'"], [...RESUME, ...NOTICE]),
  m('parser-rejects-unknown-cause', TYPES, ["  if (typeof r.cause !== 'string' || !RESTART_CAUSES.has(r.cause)) return undefined", "  if (typeof r.cause !== 'string') return undefined"]),
  m('parser-bounds-done', TYPES, ['    .slice(-limits.alreadyDoneMax)\n', '']),

  // ── Store: both restart paths, the flag, built in the write, parked, hydration ──
  m('boot-path-gets-notice', STORE, ["    const restartCause = (reason === 'server_restarted' || reason === 'server_shutdown') && this.restartNotice()",
    "    const restartCause = (reason === 'server_shutdown') && this.restartNotice()"], NOTICE),
  m('shutdown-path-gets-notice', STORE, ["    const restartCause = (reason === 'server_restarted' || reason === 'server_shutdown') && this.restartNotice()",
    "    const restartCause = (reason === 'server_restarted') && this.restartNotice()"], NOTICE),
  m('notice-flag-honored', STORE, ["(reason === 'server_restarted' || reason === 'server_shutdown') && this.restartNotice()", "(reason === 'server_restarted' || reason === 'server_shutdown')"], [...NOTICE, ...OFF]),
  m('restart-error-at-construction', STORE, ['    const error: QueryJobError = restartCause ? restartError(restartCause) : {', '    const error: QueryJobError = false ? restartError(restartCause!) : {'], NOTICE),
  m('built-inside-the-write', STORE, ['        job: hydrated.snapshot,\n        activityToolMode: hydrated.request.activityToolMode,\n        cause: restartCause,',
    '        job: current,\n        activityToolMode: hydrated.request.activityToolMode,\n        cause: restartCause,'], NOTICE),
  m('late-fields-written', STORE, ['      if (late) {\n', '      if (false) {\n'], NOTICE),
  m('parked-gets-interruption', STORE, ["      const interruption = error.cause === 'crash_loop_parked' && this.restartNotice() ? buildInterruption({", '      const interruption = false ? buildInterruption({'], NOTICE),
  m('snapshot-keeps-interruption', STORE, ['      if (interruption) snapshot.interruption = interruption\n', ''], NOTICE),

  // ── Coordinator: the bounded shutdown drain ──
  m('shutdown-drains-callbacks', COORD, ['    if ((this.options.restartNotice ?? restartNoticeEnabled)()) await this.drainCallbacks(', '    if (false) await this.drainCallbacks('], NOTICE),
  m('drain-only-with-notice', COORD, ['    if ((this.options.restartNotice ?? restartNoticeEnabled)()) await this.drainCallbacks(', '    if (true) await this.drainCallbacks('], NOTICE),
  m('drain-is-bounded', COORD, ['      await Promise.race([Promise.all(runs.map(run => run.callbackTail.catch(() => {}))), bound])', '      await Promise.all(runs.map(run => run.callbackTail.catch(() => {})))'], NOTICE),

  // ── MVP-D: reader always on, writer by flag, equality only ──
  m('reader-rebuilds-delta-rows', STORE, ["  if (row.type === 'chunk' && eventData?.deltaOnly === true && patch && typeof eventData.text === 'string') {", '  if (false) {'], DELTA),
  m('reader-checks-length', STORE, ["    if (partialText === null || (typeof partialChars === 'number' && partialText.length !== partialChars)) {", '    if (partialText === null) {'], DELTA),
  m('reader-reset-by-whole-row', STORE, ["  if (typeof patch?.partialText === 'string') deltas.set(row.jobId, patch.partialText)\n  return parsed", '  return parsed'], DELTA),
  m('writer-off-passes-through', STORE, ['    if (!this.writeDeltas) return this.inner.append(root, partitionDay, line)\n', ''], [...DELTA, ...OFF]),
  m('writer-strips-only-a-suffix', STORE, ['      if (previous !== undefined && partial === previous + delta) {', '      if (previous !== undefined) {'], DELTA),
  m('writer-writes-length', STORE, ['eventData: { ...data, deltaOnly: true, partialChars: partial.length },', 'eventData: { ...data, deltaOnly: true },'], DELTA),

  // ── Switches and wiring ──
  m('notice-default-on', FEATURE, ['  return triState(env.COS_RESTART_NOTICE, true)', '  return triState(env.COS_RESTART_NOTICE, false)'], [...FEAT, ...NOTICE]),
  m('delta-default-off', FEATURE, ['  return triState(env.COS_QUERY_JOB_DELTA_JOURNAL, false)', '  return triState(env.COS_QUERY_JOB_DELTA_JOURNAL, true)'], [...FEAT, ...DELTA, ...OFF]),
  m('tristate-off-values', 'server/lib/env-switch.ts', ["  if (value === '0' || value === 'false' || value === 'off') return false\n", ''], [...FEAT, ...NOTICE]),
  m('runtime-uses-journal-factory', RUNTIME, ['  storage: createQueryJobJournalStorage(),\n', ''], WIRE),
  // ── P7 fixes (S8 the whole message fits the 32-column lead, S10 the cutOffDuring bound is the contract's) ──
  m('restart-message-fits-lead', TYPES, ['export const QUERY_JOB_RESTART_MESSAGE = \'Server restarted. Tap to retry.\'', 'export const QUERY_JOB_RESTART_MESSAGE = \'Server restarted. Retry or resume.\''], RESUME),
  m('cutoff-bound-is-contract', TYPES, ['  cutOffDuringChars: 60,', '  cutOffDuringChars: 80,'], RESUME),
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

const scratch = mkdtempSync(join(tmpdir(), 'restart-notice-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json', '.env.example']) cpSync(join(root, file), join(scratch, file))
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
  console.log(`${killed} of ${selected.length} restart truth 6.78.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
