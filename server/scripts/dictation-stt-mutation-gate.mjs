#!/usr/bin/env node
// Dictation STT mutation gate (6.73.0). Same runner as stt-mutation-gate.mjs: mutations run only in a
// disposable copy of server/ and shared/, never in the live checkout.
//
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file.
//   2. The mutated file differs from the original.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build or harness failure is not a kill.
//   4. The file is restored byte for byte before the next mutant.
// Usage: node server/scripts/dictation-stt-mutation-gate.mjs [--list | --check] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/dictation-stt.test.ts', 'server/routes/prompt-drafts-dictation-stt.test.ts', 'server/routes/prompt-drafts.test.ts',
  'server/lib/stt-runtime.test.ts', 'server/lib/parakeet.test.ts', 'server/routes/stt-settings.test.ts', 'server/lib/transcribe-audio.test.ts', 'server/routes/transcribe.test.ts']
const S = 'server/lib/stt-settings.ts', D = 'server/lib/dictation-stt.ts', T = 'server/lib/transcribe-audio.ts', PD = 'server/routes/prompt-drafts.ts'
const RU = 'server/lib/stt-runtime.ts', P = 'server/lib/parakeet.ts'
const mutations = [
  // Fast mode mapping.
  ['fast-mode-follows-preview', S, "  return mode === 'fast' ? 'fast' : 'final'", "  return 'final'"],
  ['final-follows-hq', S, "  const wantsParakeet = slot === 'final' ? settings.hq === 'parakeet-ultra' : settings.preview === 'parakeet'", "  const wantsParakeet = settings.preview === 'parakeet'"],
  ['transcribe-plans-its-slot', T, '  const slot = dictationSlotForMode(effectiveMode)', "  const slot = dictationSlotForMode('hq')"],
  ['parakeet-hq-is-hq-quality', T, '      actualQuality = effectiveMode\n', "      actualQuality = 'fast'\n"],
  // Fallback when cold, missing, broken or failed.
  ['cold-parakeet-is-whisper', S, '      : c.parakeetPreviewWarm ? null', '      : true ? null'],
  ['missing-parakeet-is-whisper', S, "  const reason = !c.parakeetInstalled ? 'parakeet_not_installed'", "  const reason = false ? 'parakeet_not_installed'"],
  ['open-breaker-is-whisper', S, "    : c.parakeetPreviewBreakerOpen ? 'parakeet_breaker_open'", "    : false ? 'parakeet_breaker_open'"],
  ['env-switch-holds-whisper', S, '  if (c.dictationDisabledByEnv) {', '  if (false) {'],
  ['parakeet-only-when-planned', T, "  if (plan.engine === 'parakeet-ultra') {\n    const outcome", '  if (true) {\n    const outcome'],
  ['failed-parakeet-decodes-whisper', T, '  if (decoded) {', '  if (true) {'],
  ['webm-never-reaches-parakeet', D, "  if (!isPcm16kMonoWav(audio)) return { ok: false, reason: 'audio_not_pcm_wav' }\n", ''],
  ['busy-is-not-a-miss', D, '    if (!busy) deps.miss()', '    deps.miss()'],
  ['front-end-failure-is-not-a-miss', D, '    try { input = await deps.frontEnd(audio, plan.frontEnd) } catch { input = audio }', '    input = await deps.frontEnd(audio, plan.frontEnd)'],
  ['hq-parakeet-warms', RU, "  const wanted = settings.preview === 'parakeet' || settings.hq === 'parakeet-ultra'", "  const wanted = settings.preview === 'parakeet'"],
  ['interactive-lane-capped', P, '    if (interactiveRunning >= INTERACTIVE_LANE_MAX) return Promise.reject(', '    if (false) return Promise.reject('],
  // Never switch selection mid-request; never reuse across selections.
  ['reuse-needs-same-selection', PD, '  if (recordSttKey(cached) !== sttKey) return false\n', ''],
  ['legacy-records-are-defaults', PD, '  return record.sttKey ?? legacyDictationKey(record.requestedMode)', "  return record.sttKey ?? 'legacy'"],
  ['finalize-passes-its-snapshot', PD, "await transcribeChunk(draftId, chunk.chunkIndex, chunk.audioBuffer, mode, 'final', plan)", "await transcribeChunk(draftId, chunk.chunkIndex, chunk.audioBuffer, mode, 'final')"],
  ['decode-gets-the-plan', PD, '      const result = await transcribeAudioBuffer(audio, { mode, policy, dictationPlan: plan })', '      const result = await transcribeAudioBuffer(audio, { mode, policy })'],
  // Live preview.
  ['peek-follows-preview', PD, "        if (plan.engine === 'parakeet-ultra') {\n          const outcome", '        if (false) {\n          const outcome'],
  ['peek-miss-is-whisper', PD, '        if (raw === null) raw = (await transcribeWhisperPreview(audio)).text', "        if (raw === null) raw = ''"],
  // GET contract.
  ['get-has-dictation', S, '    dictation: dictationView(settings, c),\n', ''],
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
const scratch = mkdtempSync(join(tmpdir(), 'dictation-stt-mutations-'))
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
  console.log(`${selected.length - survived.length} of ${selected.length} dictation STT mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
