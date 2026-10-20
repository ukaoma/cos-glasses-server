#!/usr/bin/env node
// Autonomous meeting save mutation gate (6.81.0). Mutations run only in a disposable copy of server/ and shared/;
// the live checkout (which a candidate may be running) is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/autonomous-save-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = [
  'server/lib/meeting-autonomous-finalize.test.ts',
  'server/lib/meeting-stop-intents.test.ts',
  'server/routes/meeting-autonomous-save.test.ts',
  'server/routes/meeting-autonomous-save-journey.test.ts',
]
const AF = 'server/lib/meeting-autonomous-finalize.ts', SI = 'server/lib/meeting-stop-intents.ts'
const MT = 'server/routes/meeting.ts', TS = 'server/routes/transcribe-stream.ts'
const mutations = [
  // The decision: only a complete, transcribed, quiet capture after a Stop is saved.
  ['decide-already-saved-first', AF, "  if (input.alreadySaved) return { action: 'stand_down', reason: 'already_saved' }\n", ''],
  ['decide-saving-waits', AF, "  if (input.saving) return { action: 'wait', reason: 'saving', missing: [], missingCount: 0, retryInMs: AUTONOMOUS_FINALIZE_POLL_MS }\n", ''],
  ['decide-closed-stands-down', AF, "  if (ledger.state === 'closed') return { action: 'stand_down', reason: 'closed_unsaved' }\n", ''],
  ['decide-nothing-captured', AF, "  if (intent.finalChunkIndex < 0) return { action: 'stand_down', reason: 'nothing_captured' }\n", ''],
  ['decide-revoke-beyond-final', AF, '  if (ledger.maxChunkIndex > intent.finalChunkIndex) {', '  if (false) {'],
  ['decide-unknown-session-waits', AF, "  if (ledger.state === 'missing') {", '  if (false) {'],
  ['decide-missing-chunks-wait', AF, '  if (absent.count > 0) {', '  if (false) {'],
  ['decide-asr-pending-wait', AF, '  if (pending.count > 0) {', '  if (false) {'],
  ['decide-settle-wait', AF, '  if (settleLeft > 0) {', '  if (false) {'],
  ['decide-settle-from-last-chunk', AF, 'Math.max(intent.receivedAt, ledger.lastActivityAt ?? 0)', 'intent.receivedAt'],
  ['decide-counts-final-index', AF, 'for (let index = 0; index <= finalIndex; index++)', 'for (let index = 0; index < finalIndex; index++)'],
  // The finalizer.
  ['finalizer-not-ready-waits', AF, '    if (!deps.ready()) {', '    if (false) {'],
  ['finalizer-in-flight-guard', AF, '    if (inFlight.has(sessionId)) return null\n', ''],
  ['finalizer-only-waiting', AF, "    if (!intent || intent.state !== 'waiting') return null\n", '    if (!intent) return null\n'],
  ['finalizer-records-server-save', AF, "          state: 'saved', savedBy: 'server', savedAt: at,", "          state: 'saved', savedBy: 'phone', savedAt: at,"],
  ['finalizer-wait-logged-on-change', AF, '        if (!last || last.reason !== decision.reason || last.missingCount !== decision.missingCount) {', '        if (true) {'],
  ['finalizer-tick-rearms', AF, '      if (Number.isFinite(soonest)) arm(soonest)\n', ''],
  ['finalizer-arm-keeps-sooner', AF, '    if (cancel && armedFor <= due) return\n', ''],
  ['finalizer-already-saved-outcome', AF, "      if (outcome.reason === 'already_saved') {", '      if (false) {'],
  ['finalizer-instance-mismatch-stands-down', AF, "      if (outcome.reason === 'server_instance_mismatch') {", '      if (false) {'],
  ['finalizer-save-in-progress-waits', AF, "      if (outcome.status === 409 && outcome.reason === 'save_in_progress') {", '      if (false) {'],
  ['finalizer-nothing-to-save-stands-down', AF, '      if (outcome.status === 404) {', '      if (false) {'],
  // The durable Stop.
  ['intent-raise-only', SI, '          finalChunkIndex: Math.max(existing.finalChunkIndex, input.finalChunkIndex),', '          finalChunkIndex: input.finalChunkIndex,'],
  ['intent-saved-is-final', SI, "      if (prior && prior.state === 'saved') return { ok: false, reason: 'terminal', intent: { ...prior } }\n", ''],
  ['intent-persisted-on-create', SI, '      intents[input.sessionId] = intent\n      persist(intents)\n', '      intents[input.sessionId] = intent\n'],
  ['intent-corrupt-set-aside', SI, '    try { renameSync(path, `${path}.corrupt.${Date.now()}`) } catch {}\n', ''],
  ['replay-empty-needs-asr', SI, "  return asrCompleted.includes(chunkIndex) ? { kind: 'empty' } : null", "  return { kind: 'empty' }"],
  // The routes.
  ['stop-requires-pin', MT, '    const pin = suppliedServerPin(req, body?.serverInstanceId)\n    if (!pin) {', '    const pin = suppliedServerPin(req, body?.serverInstanceId)\n    if (false) {'],
  ['stop-refuses-behind-server', MT, '    if (ledger && ledger.maxChunkIndex > (finalChunkIndex as number)) {', '    if (false) {'],
  ['stop-arms-finalizer', MT, "    void autonomousFinalizer.tick('stop_received')\n", ''],
  ['save-notes-phone-first', MT, "      if (origin !== 'server') notePhoneSavedFirst(sessionId, origin === 'phone' ? 'phone' : 'other')\n", ''],
  ['save-origin-from-pin', MT, "      await performSave(sessionId, body, respond, pin ? 'phone' : 'client')", "      await performSave(sessionId, body, respond, 'phone')"],
  ['save-replay-confirms-phone', MT, "        if (origin === 'phone') notePhoneAfterAutonomousSave(sessionId, 'save_replay')\n", ''],
  ['status-confirms-only-pinned', MT, "    if (saved && pin) notePhoneAfterAutonomousSave(sessionId, 'status')", "    if (saved) notePhoneAfterAutonomousSave(sessionId, 'status')"],
  ['status-stop-intent-field', MT, '      stopIntent: intent ? publicStopIntent(intent) : null,', '      stopIntent: null,'],
  ['autosave-instance-pin', MT, "    if (intent.serverInstanceId !== getServerInstanceId()) return { ok: false, status: 409, reason: 'server_instance_mismatch' }\n", ''],
  ['autosave-replayed-is-not-ours', MT, "    if (payload.replayed === true) return { ok: false, status: 200, reason: 'already_saved' }\n", ''],
  ['recording-stop-marks-server', MT, "            ...(origin === 'server' ? { savedBy: 'server' } : {}),\n", ''],
  // The late replay after the server's own save.
  ['replay-hook', TS, '    const replay = replayAfterAutonomousSave(sessionId, chunkIndex)\n    if (replay) return replay\n', ''],
  ['replay-only-server-saves', TS, "  if (!intent || intent.state !== 'saved' || intent.savedBy !== 'server' || !intent.sidecarPath) return null", '  if (!intent) return null'],
  ['replay-refused-counted', TS, '    store.update(sessionId, { lateRefused: (intent.lateRefused ?? 0) + 1 })\n', ''],
  ['replay-counted', TS, '    lateReplays: (intent.lateReplays ?? 0) + 1,\n', '    lateReplays: 0,\n'],
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
const scratch = mkdtempSync(join(tmpdir(), 'autonomous-save-mutations-'))
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
  console.log(`${selected.length - survived.length} of ${selected.length} autonomous-save mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
