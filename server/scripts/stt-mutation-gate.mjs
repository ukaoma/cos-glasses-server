#!/usr/bin/env node
// STT switcher mutation gate (6.72.0). Mutations run only in a disposable copy of server/ and shared/;
// the live checkout (which a candidate may be running) is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/stt-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/stt-resolver.test.ts', 'server/lib/parakeet.test.ts', 'server/routes/stt-settings.test.ts', 'server/lib/stt-live.test.ts',
  'server/lib/meeting-batch-stt.test.ts', 'server/lib/stt-runtime.test.ts', 'server/lib/whisper-batch-timing.test.ts']
const R = 'server/lib/stt-resolver.ts', P = 'server/lib/parakeet.ts', S = 'server/lib/stt-settings.ts', RT = 'server/routes/stt-settings.ts'
const L = 'server/lib/stt-live.ts', V = 'server/lib/vad-silero.ts', B = 'server/lib/meeting-batch-transcribe.ts', BT = 'server/lib/whisper-batch-timing.ts'
const RU = 'server/lib/stt-runtime.ts', MP = 'server/lib/meeting-batch-persistence.ts', WL = 'server/lib/whisper-local.ts'
const MT = 'server/routes/meeting.ts', TS = 'server/routes/transcribe-stream.ts'
const mutations = [
  // Resolver rules.
  ['gap-fill-only-deletion-prone', R, "const wantGap = kind === 'second_only' && options.primaryDeletionProne", "const wantGap = kind === 'second_only'"],
  ['time-skew-blocks-pairing', R, 'if (maxSkew !== null && ma !== null && mb !== null && Math.abs(ma - mb) > maxSkew) return INF', ''],
  ['time-skew-off-by-default', R, 'export const DEFAULT_MAX_SKEW_SEC: number | null = null', 'export const DEFAULT_MAX_SKEW_SEC: number | null = 2'],
  ['apply-false-changes-nothing', R, "if (options.apply && take === 'second')", "if (take === 'second')"],
  ['alignment-size-cap', R, "if ((P.length + 1) * (Q.length + 1) > MAX_ALIGNMENT_CELLS) return { ...primaryOnly(), skipped: 'too_long' }", ''],
  ['vocab-sees-edge-context', R, 'const withContext = (side: Token[]) => [...before, ...side.map(t => t.key), ...after]', 'const withContext = (side: Token[]) => side.map(t => t.key)'],
  // Parakeet: offline, pinned, bounded.
  ['sandbox-denies-network', P, '(version 1)(allow default)(deny network*)(deny file-write*', '(version 1)(allow default)(deny file-write*'],
  ['sandbox-required', P, "  if (!existsSync(sandbox)) return Promise.reject(new ParakeetError('sandbox_unavailable',", "  if (false) return Promise.reject(new ParakeetError('sandbox_unavailable',"],
  ['model-hash-verified', P, '        if (fileSize(target) !== file.size || await sha256File(target) !== file.sha256) {', '        if (false) {'],
  ['download-size-cap', P, '            if (written > file.size) {', '            if (false) {'],
  ['preview-lane-busy-is-miss', P, "    if (previewBusy) return Promise.reject(new ParakeetError('busy', 'a preview decode is already running'))\n", ''],
  ['warm-needs-budget', P, '      const ok = second.wallMs <= WARM_DECODE_BUDGET_MS', '      const ok = true'],
  ['cli-option-rejection', P, '      if (/Unknown option|not supported|transcription failed/i.test(stderr)) {', '      if (false) {'],
  ['short-clips-padded', P, '  writeFileSync(input, padShortWav(wav), { mode: 0o600 })', '  writeFileSync(input, wav, { mode: 0o600 })'],
  ['cli-failure-text-rejected', P, '/Unknown option|not supported|transcription failed/i', '/Unknown option|not supported/i'],
  ['child-env-has-no-keys', P, '  const out: NodeJS.ProcessEnv = { HOME: home, CFFIXED_USER_HOME: home, TMPDIR: work }', '  const out: NodeJS.ProcessEnv = { ...env, HOME: home, CFFIXED_USER_HOME: home, TMPDIR: work }'],
  // Settings contract.
  ['unknown-key-400', S, '  if (unknown.length) throw new SttSettingsError(', '  if (false) throw new SttSettingsError('],
  ['unavailable-choice-400', S, '    if (option && !option.available) throw new SttSettingsError(', '    if (false) throw new SttSettingsError('],
  ['same-engine-400', S, "    if (second) throw new SttSettingsError('The second opinion must be a different engine from the HQ model.')\n", ''],
  ['nemotron-not-faked', S, "{ id: 'nemotron-560', label: 'Nemotron streaming 560 ms', available: false,", "{ id: 'nemotron-560', label: 'Nemotron streaming 560 ms', available: true,"],
  ['hq-falls-back-when-missing', S, "  if (settings.hq === 'parakeet-ultra' && !c.parakeetInstalled) hq = { engine: 'large-v3', reason: 'parakeet_not_installed' }\n", ''],
  ['settings-reload-on-change', S, '  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return { ...cache.value }', '  if (cache) return { ...cache.value }'],
  ['install-refused-while-live', RT, '      if (deps.recordingLive()) return void res.status(409)', '      if (false) return void res.status(409)'],
  // Live gate.
  ['quiet-threshold-strict', L, 'isQuiet: speechSec < QUIET_SPEECH_SEC', 'isQuiet: speechSec <= QUIET_SPEECH_SEC'],
  ['unmeasured-is-not-quiet', L, "return { isQuiet: rms < QUIET_RMS, rms, speechSec: null, gate: 'rms_fallback' }", "return { isQuiet: true, rms, speechSec: null, gate: 'rms_fallback' }"],
  ['silero-fed-in-windows', V, '    for (let offset = 0; offset + MIN_SAMPLES <= float32.length; offset += MIN_SAMPLES) {\n      gateVad.acceptWaveform(float32.subarray(offset, offset + MIN_SAMPLES))\n      drain()\n    }\n', '    gateVad.acceptWaveform(float32)\n'],
  // HQ plan.
  ['timestamps-default-on', BT, "  return (hq ?? readSttSettings().hq) !== 'large-v3-legacy'", '  return false'],
  ['timestamps-per-engine', B, '  const timestamps = batchTimestampsEnabled(engine)', '  const timestamps = batchTimestampsEnabled()'],
  ['second-opinion-failure-keeps-primary', B, '      secondError = errorReason(error)\n', '      throw error\n'],
  ['plan-frozen-per-job', B, '      const input = await deps.frontEnd(combined, plan.frontEnd)', '      const input = await deps.frontEnd(combined, readSttSettings().frontEnd)'],
  ['checkpoint-identity-front-end', WL, "    enhancement: frontEnd === 'full' ? 'audio-enhance-v1' : 'audio-enhance-highpass-v1',", "    enhancement: 'audio-enhance-v1',"],
  ['sidecar-keeps-hypotheses', MP, '      ...(result.stt ? { stt: result.stt } : {}),\n', ''],
  // Preview.
  // QA round (6.72.0).
  ['protected-never-flips', R, "        if (!sameProtected(p, q)) reason = 'protected'", "        if (false) reason = 'protected'"],
  ['gap-fill-needs-speech-span', R, "  if (inside / timed.length < MIN_SPEECH_SHARE) return 'not_speech'\n", ''],
  ['gap-fill-needs-spans-at-all', R, "  if (!spans || !spans.length) return 'not_speech'\n", "  if (!spans || !spans.length) return 'gap_fill'\n"],
  ['gap-fill-confidence-floor', R, "/ scored.length < floor) return 'low_confidence'", "/ scored.length < -1) return 'low_confidence'"],
  ['vocab-region-cap', R, 'else if (wantVocab && (q.length > MAX_VOCAB_REGION_WORDS || p.length > q.length + MAX_VOCAB_REGION_SLACK)) {', 'else if (false) {'],
  ['cli-hash-pinned', P, "  const ok = await sha256File(path).then(h => h === PARAKEET_CLI.sha256, () => false)", '  const ok = true'],
  ['install-require-local', P, '        if (!placed && options.requireLocal) {', '        if (false) {'],
  ['install-idle-timeout', P, '            idle = setTimeout(() => ctl.abort(', '            idle = setTimeout(() => void (('],
  ['install-cancel', P, "  installAbort.abort(new ParakeetInstallError('The install was cancelled.'))", '  void 0'],
  ['boot-restores-mid-swap', P, "    if (!existsSync(currentDir()) && olds.length) {", '    if (false) {'],
  ['sandbox-denies-writes', P, '`(version 1)(allow default)(deny network*)(deny file-write*)`', '`(version 1)(allow default)(deny network*)`'],
  ['parakeet-primary-falls-back', B, "      const w = await decodeWhisperWindow(deps, input, previousText, 'large-v3', segment, audioDir)\n      primary = w.decode\n      if (w.fallbackReason)", "      throw error\n      const w = await decodeWhisperWindow(deps, input, previousText, 'large-v3', segment, audioDir)\n      primary = w.decode\n      if (w.fallbackReason)"],
  ['timestamp-failure-retries-legacy', B, '    if (!timestamps) throw error\n', '    throw error\n'],
  ['whisper-failure-uses-second', B, '      if (!secondModel || job.parakeetStopped) throw error\n', '      throw error\n'],
  ['empty-parakeet-over-speech-fails', B, '    if (speech !== null && speech >= PARAKEET_EMPTY_SPEECH_SEC) {', '    if (false) {'],
  ['parakeet-job-breaker', B, '    if (job.parakeetFailures >= PARAKEET_JOB_BREAKER_FAILURES) {', '    if (false) {'],
  ['checkpoint-reused-with-second', B, '      if (cached && plan.secondOpinion === \'off\') {', '      if (cached) {'],
  ['checkpoint-reuse-parakeet-excluded', B, "  const checkpointsUsable = plan.engine !== 'parakeet-ultra'\n", '  const checkpointsUsable = true\n'],
  ['taken-reflects-applied', B, "      disagreements = disagreements.map(d => ({ ...d, taken: 'primary' as const }))\n", ''],
  ['corrections-once', B, '      text = applyCorrections(resolved.text)\n', '      text = resolved.text\n'],
  ['plan-at-production-call', B, '    const batchSegments = await transcribeSegments(audioDir, segments, entries, sessionId, plan)', "    const batchSegments = await transcribeSegments(audioDir, segments, entries, sessionId, LEGACY_HQ_PLAN)"],
  ['plan-at-recovery-call', B, '  return { plan, run: () => transcribeSegments(quarantineDir, segments, entries, undefined, plan, deps) }', '  return { plan, run: () => transcribeSegments(quarantineDir, segments, entries, undefined, LEGACY_HQ_PLAN, deps) }'],
  ['recovery-keeps-hypotheses', MP, '  sidecar.sttSegments = results.filter(r => r.stt).map(r => ({', '  sidecar.sttSegments = results.filter(() => false).map(r => ({'],
  ['preview-old-phones-get-turbo', RU, '    if (!acceptedModels.includes(PREVIEW_PARAKEET_MODEL)) {', '    if (false) {'],
  ['preview-fallback-within-budget', RU, '    if (now() - started >= PREVIEW_TURBO_FALLBACK_BEFORE_MS) { previewStats.empty++; return null }', ''],
  ['preview-breaker-opens', RU, '  if (breaker.misses >= PREVIEW_BREAKER_MISSES) {', '  if (false) {'],
  ['preview-busy-not-a-miss', RU, '      if (!busy) notePreviewMiss()', '      notePreviewMiss()'],
  ['preview-parakeet-hears-front-end', RU, '      const r = await deps.parakeet(await deps.frontEnd(audio, eff.frontEnd))', '      const r = await deps.parakeet(audio)'],
  ['preview-parakeet-failure-is-turbo', RU, '    previewStats.turboFallbacks++\n  }\n  return turbo()', '    return null\n  }\n  return turbo()'],
  ['warm-deferred-while-live', RU, "  if (recordingLive()) return 'deferred'\n", ''],
  ['warm-retry-throttle', RU, "  if (w.state === 'failed' && now - w.at < WARM_RETRY_MS) return 'skipped'\n", ''],
  ['installable-needs-cli', RU, '  const installable = !installed.installed && !running && sandbox && appleSilicon && cli === true', '  const installable = !installed.installed && !running && sandbox && appleSilicon'],
  ['large-v3-preview-withdrawn', S, "    { id: 'large-v3', label: 'Whisper Large-v3', available: false,", "    { id: 'large-v3', label: 'Whisper Large-v3', available: true,"],
  ['corrupt-settings-logged-once', S, '    if (!warnedCorrupt) { warnedCorrupt = true;', '    if (true) { warnedCorrupt = true;'],
  ['slot-reason-surfaced', S, "      selected: settings.preview, effective: eff.preview.engine, ...slotReason(eff.preview.reason),", "      selected: settings.preview, effective: eff.preview.engine,"],
  ['text-drops-stay-on-rms', TS, '  const dropQuiet = rms < QUIET_RMS\n', '  const dropQuiet = isQuiet\n'],
  ['spoken-words-merge', WL, "      if (last && !/^\\s/.test(rawText) && !/^[\\s]*$/.test(rawText)) {", '      if (false) {'],
  ['preview-follows-effective-engine', RU, "  if (eff.preview.engine === 'parakeet') {", "  if (eff.settings.preview === 'parakeet') {"],
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
const scratch = mkdtempSync(join(tmpdir(), 'stt-mutations-'))
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
  console.log(`${selected.length - survived.length} of ${selected.length} STT mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
