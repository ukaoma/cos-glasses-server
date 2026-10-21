#!/usr/bin/env node
// Mac recorder discard mutation gate (6.83.2). Same runner as dictation-stt-mutation-gate.mjs: mutations run only in a
// disposable copy of server/ and shared/, never in the live checkout.
//
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file.
//   2. The mutated file differs from the original.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build or harness failure is not a kill.
//   4. The file is restored byte for byte before the next mutant.
// Usage: node server/scripts/mac-discard-mutation-gate.mjs [--list | --check] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/routes/mac-recording.test.ts', 'server/lib/unsaved-audio-quarantine.test.ts']
const TS = 'server/routes/transcribe-stream.ts', M = 'server/routes/meeting.ts', Q = 'server/lib/unsaved-audio-quarantine.ts'
const mutations = [
  // The guards: never a capture with speech, mid-ASR, mid-upload, still receiving, or not a Mac capture.
  ['guard-not-mac', TS, "  if (!MAC_CAPTURE_ID.test(input.sessionId)) return 'not_mac_capture'\n", ''],
  ['guard-present', TS, "  if (!input.present) return 'session_not_found'\n", ''],
  ['guard-speech', TS, "  if (input.canonicalCount > 0) return 'has_speech'\n", ''],
  ['guard-asr-in-flight', TS, "  if (input.receivedIndices.some(index => !completed.has(index))) return 'asr_in_progress'\n", ''],
  ['guard-chunk-lock', TS, "  if (input.chunkInProgress) return 'chunk_in_progress'\n", ''],
  ['guard-idle', TS, "  if (input.silentForMs < MAC_DISCARD_IDLE_MS) return 'not_idle'\n", ''],
  ['guard-idle-threshold', TS, 'export const MAC_DISCARD_IDLE_MS = EMPTY_SESSION_STALE_MS', 'export const MAC_DISCARD_IDLE_MS = 0'],
  ['dry-run-changes-nothing', TS, '  if (options.dryRun) {\n', '  if (false) {\n'],
  ['closes-the-registry', TS, '  closeMacRecording(sessionId)\n  return {', '  return {'],
  ['quarantine-reason', TS, "      reason: 'discarded_no_sound',", "      reason: 'close_closed',"],
  ['short-clock-passed', TS, '      retentionMs: DISCARDED_RETENTION_MS,\n      receipt:', '      receipt:'],
  ['terminal-receipt-passed', TS, "      receipt: { outcome: 'no_speech', discarded: true,", "      receipt: undefined && { outcome: 'no_speech', discarded: true,"],
  ['close-honors-quarantine-options', TS, '        quarantine ? { retentionMs: quarantine.retentionMs, receipt: quarantine.receipt } : {})', '        {})'],
  ['advertised', TS, ', serverInstanceId: getServerInstanceId(), discard: true })', ', serverInstanceId: getServerInstanceId() })'],
  // The route.
  ['route-needs-confirm', M, '    const confirmed = body.confirm === true\n', '    const confirmed = true\n'],
  ['route-pin-required', M, "      res.status(400).json({ error: 'Server identity pin required', reason: 'server_identity_pin_required' })\n      return\n    }\n    if (pin !== serverInstanceId) {\n      res.status(409).json({ error: 'Server identity mismatch', reason: 'server_instance_mismatch' })\n      return\n    }\n    if (store.findBySessionId(sessionId)) {", "    }\n    if (store.findBySessionId(sessionId)) {"],
  ['route-mac-only', M, "    if (!MAC_CAPTURE_ID.test(sessionId)) {\n      res.status(400).json({ error: 'Only a Mac recording can be discarded here', reason: 'not_mac_capture' })", "    if (false) {\n      res.status(400).json({ error: 'Only a Mac recording can be discarded here', reason: 'not_mac_capture' })"],
  ['route-replay', M, "      if (disposition?.quarantineReason === 'discarded_no_sound') {", '      if (false) {'],
  ['route-refusal-is-409', M, "      res.status(409).json({ error: message[result.reason ?? ''] ?? 'Not discarded', reason: result.reason, receivedCount: result.receivedCount })", "      res.status(200).json({ error: message[result.reason ?? ''] ?? 'Not discarded', reason: result.reason, receivedCount: result.receivedCount })"],
  // The quarantine.
  ['own-clock-shorter-only', Q, '? Math.min(retentionMs, own) : retentionMs', '? own : retentionMs'],
  ['own-clock-read', Q, '    const ownRetentionMs = effectiveRetentionMs(manifest, retentionMs)\n', '    const ownRetentionMs = retentionMs\n'],
  ['manifest-keeps-clock', Q, '      ...(options.retentionMs ? { retentionMs: options.retentionMs } : {}),\n', ''],
  ['receipt-written', Q, '    if (options.receipt) {\n', '    if (false) {\n'],
  ['purge-uses-capture-expiry', Q, '    if (Date.now() > expiresMs) {', '    if (Date.now() - Date.parse(capture.quarantinedAt ?? "") > 72 * 3_600_000) {'],
  ['disposition-uses-own-clock', Q, '    retainedUntil: atMs != null ? new Date(atMs + effectiveRetentionMs(manifest, retentionMs)).toISOString() : null,', '    retainedUntil: atMs != null ? new Date(atMs + retentionMs).toISOString() : null,'],
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
const scratch = mkdtempSync(join(tmpdir(), 'mac-discard-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  // The quiet-gate tests run the real Silero model (the only file of server/models they need).
  cpSync(join(root, 'server/models/silero_vad.onnx'), join(scratch, 'server/models/silero_vad.onnx'))
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
  console.log(`${selected.length - survived.length} of ${selected.length} Mac discard mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
