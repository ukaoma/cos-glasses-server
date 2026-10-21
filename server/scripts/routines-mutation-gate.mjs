#!/usr/bin/env node
// Routines mutation gate (6.82.0). Mutations run only in a disposable copy of server/ and shared/;
// the live checkout (which a candidate may be running) is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/routines-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = [
  'server/lib/routines-config.test.ts',
  'server/lib/routines-scheduler.test.ts',
  'server/routes/routines.test.ts',
  'server/lib/morning-brief-golden.test.ts',
  'server/lib/claude-bridge-audit-caller.test.ts',
  'server/lib/query-job-runtime.test.ts',
]
const RS = 'server/lib/routines-scheduler.ts', RC = 'server/lib/routines-config.ts', RR = 'server/lib/routines-registry.ts'
const RT = 'server/routes/routines.ts', QR = 'server/lib/query-job-runtime.ts', CB = 'server/lib/claude-bridge.ts', MBS = 'server/lib/morning-brief-schedule.ts'
const mutations = [
  // The tick: every gate that keeps a skill routine from firing.
  ['tick-master-switch', RS, "    if (!this.masterEnabled()) return { ...result, reason: 'routines_off' }\n", ''],
  ['tick-durable-jobs', RS, "    if (!this.deps.durableJobsEnabled()) return { ...result, reason: 'durable_jobs_off' }\n", ''],
  ['tick-admissions', RS, "    if (!this.deps.admissionsOpen()) return { ...result, reason: 'admissions_closed' }\n", ''],
  ['tick-breaker-open', RS, "      if (this.breakerOpen(routine.id)) { result.skipped[routine.id] = 'breaker_open'; continue }\n", ''],
  ['tick-daily-cap', RS, "      if (!decision.resume && this.admittedToday(routine) >= routine.dailyCap) { result.skipped[routine.id] = 'daily_cap_reached'; continue }\n", ''],
  ['tick-reconciles-first', RS, '    await this.reconcile()\n    const result: RoutineTickResult', '    const result: RoutineTickResult'],
  // Run now.
  ['runnow-master-switch', RS, "      if (!this.masterEnabled()) throw new RoutineRunError(409, 'routines_off',", "      if (false) throw new RoutineRunError(409, 'routines_off',"],
  ['runnow-durable-jobs', RS, "      if (!this.deps.durableJobsEnabled()) throw new RoutineRunError(409, 'durable_jobs_off',", "      if (false) throw new RoutineRunError(409, 'durable_jobs_off',"],
  ['runnow-breaker', RS, '      if (this.breakerOpen(id)) {', '      if (false) {'],
  ['runnow-skill-missing', RS, "      if (!this.deps.skillExists(routine.skill)) throw new RoutineRunError(409, 'skill_missing',", "      if (false) throw new RoutineRunError(409, 'skill_missing',"],
  ['runnow-in-progress', RS, '        if (snapshot && !isTerminalQueryJobStatus(snapshot.status)) {\n          throw new RoutineRunError(409', '        if (false) {\n          throw new RoutineRunError(409'],
  ['runnow-daily-cap', RS, '      if (this.admittedToday(routine) >= routine.dailyCap) {', '      if (false) {'],
  ['runnow-global-cap', RS, '      if (this.admittedLastDay() >= ROUTINE_LIMITS.globalRunsPerDay) {\n        throw', '      if (false) {\n        throw'],
  ['cap-counts-admitted-only', RS, '.filter(run => run.day === day && run.jobId).length', '.filter(run => run.day === day).length'],
  // The breaker.
  ['breaker-threshold', RS, '      if (next.consecutiveFailures >= routine.breaker.failures) {', '      if (next.consecutiveFailures > routine.breaker.failures) {'],
  ['breaker-success-resets', RS, '      this.file.breakers[routineId] = { consecutiveFailures: 0,', '      this.file.breakers[routineId] = { consecutiveFailures: prior.consecutiveFailures,'],
  ['breaker-cooldown-ends', RS, '    return !!until && Date.parse(until) > this.now()', '    return !!until'],
  ['breaker-counted-once', RS, '      if (run.outcome || !run.jobId) continue', '      if (!run.jobId) continue'],
  ['breaker-cancel-not-counted', RS, "      if (outcome === 'canceled') continue\n", ''],
  ['breaker-submit-failure-counts', RS, '      this.recordOutcome(routine.id, false, failed.submitError)\n', ''],
  ['breaker-reset', RS, '        delete this.file.breakers[id]\n        this.log(`breaker reset for ${id}`)', '        this.log(`breaker reset for ${id}`)'],
  ['breaker-persisted', RS, "    try { this.persist() } catch (error) { this.log(`breaker write failed: ${(error as Error).message}`) }", '    void 0'],
  // What a fire submits.
  ['fire-model-explicit', RS, '        model: routine.model,\n', ''],
  ['fire-origin-label', RS, "        origin: { kind: 'routine', id: routine.id },\n", ''],
  ['fire-adopts-existing', RS, '      if (existing) {\n        const prior = resume', '      if (false) {\n        const prior = resume'],
  ['reservation-skips-terminal', RS, '      if (run.lastKnownStatus && isTerminalQueryJobStatus(run.lastKnownStatus as never)) continue\n', ''],
  ['tick-manual-never-takes-slot', MBS, "  const today = runs.filter(run => run.day === clock.day && run.trigger === 'scheduled')", '  const today = runs.filter(run => run.day === clock.day)'],
  ['create-limit', RS, '      if (this.file.routines.length >= ROUTINE_LIMITS.maxRoutines) {', '      if (false) {'],
  // Config.
  ['default-model-cheap', RC, "export const ROUTINE_DEFAULT_MODEL: ModelPreference = 'sonnet'", "export const ROUTINE_DEFAULT_MODEL: ModelPreference = 'opus'"],
  ['skill-must-exist', RC, "    if (!ctx.skillExists(skill)) throw new RoutineConfigError('unknown_skill',", "    if (false) throw new RoutineConfigError('unknown_skill',"],
  ['key-profile-refused', RC, '      if (!model && keyProfileRejectApplies(patch.model)) throw new RoutineConfigError(KEY_PROFILE_REJECT_CODE, KEY_PROFILE_SCHEDULED_REJECT)\n', ''],
  ['master-switch-words', RC, "  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')", "  return !(raw === '0')"],
  ['prompt-unattended-contract', RC, "    'Do not send email, Slack or any message, publish, deploy, push, delete data, or spend money. If the skill needs one of those, stop and say what it would do.',\n", ''],
  ['daily-cap-bounded', RC, "    base.dailyCap = intIn(patch.dailyCap, ROUTINE_LIMITS.dailyCapMin, ROUTINE_LIMITS.dailyCapMax, 'invalid_daily_cap', 'dailyCap')", '    base.dailyCap = Number(patch.dailyCap)'],
  ['audit-caller-routine-only', RC, "  return request.origin?.kind === 'routine' ? `routine:${request.origin.id}` : ''", '  return request.origin ? `routine:${request.origin.id}` : \'\''],
  // The registry and the route.
  ['brief-not-deletable', RR, "      if (id === MORNING_BRIEF_ROUTINE_ID) throw new RoutineRegistryError(409, 'cannot_delete_brief',", "      if (false) throw new RoutineRegistryError(409, 'cannot_delete_brief',"],
  ['brief-field-allowlist', RR, '        if (extra.length) throw', '        if (false) throw'],
  ['brief-is-routine-one', RR, '      routines: [await this.briefView(), ...await skills.views()],', '      routines: [...await skills.views(), await this.briefView()],'],
  ['route-error-detail', RT, '      return res.status(error.status).json({ error: { code: error.code, message: error.message, ...error.detail } })', '      return res.status(error.status).json({ error: { code: error.code, message: error.message } })'],
  // Token audit by caller.
  ['runtime-passes-audit-caller', QR, '      ...(routineAuditCaller(request) ? { auditCaller: routineAuditCaller(request) } : {}),\n', ''],
  ['claude-bridge-uses-audit-caller', CB, "      caller: options?.auditCaller ?? (options?.lightweight ? 'voice_query' : 'full_query'),", "      caller: options?.lightweight ? 'voice_query' : 'full_query',"],
  // The shared decision table the brief and routines both read (the golden guards the brief).
  ['schedule-one-per-day', MBS, '  if (accepted) return { fire: false, reason: \'already_fired\' }', '  if (false) return { fire: false, reason: \'already_fired\' }'],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const selected = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && selected.length !== names.length) throw new Error('Unknown mutation name in: ' + args.join(' '))

if (args.includes('--check')) {
  let bad = 0
  for (const [name, file, find, replacement] of mutations) {
    const text = readFileSync(join(root, file), 'utf8'), count = text.split(find).length - 1
    if (count !== 1 || find === replacement) { bad++; console.log(`${name}: ${count} matches in ${file}`) }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets unique`); process.exit(bad ? 1 : 0)
}
const scratch = mkdtempSync(join(tmpdir(), 'routines-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = () => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json'),
      COS_MAINTENANCE_GATE_PATH: join(scratch, 'gate', 'maintenance-gate.json'),
    },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run()
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${tests.length} files)`)
  const survived = []
  for (const [name, file, find, replacement] of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    if (original.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}`)
    const mutated = original.replace(find, replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    const result = run(), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(m => m[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { survived.push(name); console.log(`${name} SURVIVED${result.error ? ' (harness: ' + result.error.message + ')' : ''}`); continue }
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${selected.length - survived.length} of ${selected.length} routines mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
