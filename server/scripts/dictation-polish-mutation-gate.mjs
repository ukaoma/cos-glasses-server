#!/usr/bin/env node
// Dictation polish mutation gate (6.79.1): per-caller budgets, polishSkipped reasons, the filler
// pass and the prompt switch. Same runner as dictation-stt-mutation-gate.mjs: mutations run only
// in a disposable copy of server/ and shared/, never in the live checkout.
//
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file.
//   2. The mutated file differs from the original.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build or harness failure is not a kill.
//   4. The file is restored byte for byte before the next mutant.
// Usage: node server/scripts/dictation-polish-mutation-gate.mjs [--list | --check] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/dictation-fillers.test.ts', 'server/lib/dictation-polish-budget.test.ts', 'server/lib/dictation-clean.test.ts',
  'server/routes/prompt-drafts.test.ts', 'server/routes/dictation-fuzzy-wiring.test.ts']
const F = 'server/lib/dictation-fillers.ts', B = 'server/lib/dictation-polish-budget.ts', PD = 'server/routes/prompt-drafts.ts', C = 'server/lib/dictation-clean.ts'
const mutations = [
  // Filler pass: what it must leave alone.
  ['all-caps-kept', F, '(token.length > 1 && token === token.toUpperCase())', '(false)'],
  ['mm-after-number-kept', F, "|| (/^mm+$/i.test(token) && /\\d[ \\t]*$/.test(out + before))", '|| false'],
  ['hyphen-after-kept', F, "(?![\\p{L}\\p{N}'’-])/giu", "(?![\\p{L}\\p{N}'’])/giu"],
  ['hyphen-before-kept', F, "/(?<![\\p{L}\\p{N}'’-])(", "/(?<![\\p{L}\\p{N}'’])("],
  ['err-is-a-word', F, '|erm?|', '|er+m?|'],
  ['unchanged-is-identity', F, '  if (!removed) return text\n', ''],
  ['all-filler-keeps-original', F, "  return result.trim() === '' ? text : result", '  return result'],
  // Filler pass: how it repairs what is left.
  ['capital-handed-on', F, "    if (atStart && /^[A-Z]/.test(token) && after) {", '    if (false) {'],
  ['lowercase-stays-lowercase', F, "    if (atStart && /^[A-Z]/.test(token) && after) {", '    if (atStart && after) {'],
  ['own-sentence-terminator', F, '    after = atStart && OWN_SENTENCE_END.test(after)', '    after = false && OWN_SENTENCE_END.test(after)'],
  ['pause-comma-before-close', F, "      before = before.replace(/[ \\t]*[,;]$/, '')\n", ''],
  ['space-rejoin', F, "    if (out !== '' && spaceBefore && after", "    if (false && spaceBefore && after"],
  ['leading-pause-cleanup', F, ".replace(/^[ \\t]*[,;][ \\t]*/, '')", ''],
  ['filler-env-off', F, ".includes((env.COS_DICTATION_FILLER_PASS ?? '').trim().toLowerCase())", ".includes('')"],
  // Budgets.
  ['legacy-fallback-message-only', B, "  if (bucket === 'message') {", '  if (true) {'],
  ['legacy-fallback-honored', B, '    const legacy = positiveInt(env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY)', '    const legacy = null as number | null'],
  ['own-variable-wins', B, '  if (own !== null) return own\n', ''],
  ['whole-numbers-only', B, '  if (!/^\\d+$/.test(trimmed)) return null', '  if (!/^[\\d.e]+$/.test(trimmed)) return null'],
  ['zero-is-default', B, '  return value > 0 ? value : null', '  return value'],
  ['local-day', B, '  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`', '  return now.toISOString().slice(0, 10)'],
  ['spend-own-bucket', B, '    counts[bucket] += 1', '    counts.message += 1'],
  ['day-stamp-checked', B, '    if (raw?.date !== localDay() || !raw.counts', '    if (!raw.counts'],
  ['count-validated', B, '      if (Number.isInteger(value) && value > 0) counts[bucket] = value', '      counts[bucket] = value'],
  ['exhausted-at-cap', B, '  return polishCountToday(bucket) >= polishDailyCap(bucket)', '  return polishCountToday(bucket) > polishDailyCap(bucket)'],
  // Route wiring.
  ['meeting-skips-filler-pass', PD, "  if (opts.bucket !== 'meeting' && fillerPassEnabled())", '  if (fillerPassEnabled())'],
  ['filler-pass-switch', PD, "  if (opts.bucket !== 'meeting' && fillerPassEnabled())", "  if (opts.bucket !== 'meeting')"],
  ['finalize-spends-surface-bucket', PD, '    bucket: surface,\n', "    bucket: 'message',\n"],
  ['drafts-spend-own-bucket', PD, "bucket: 'prompt_draft', signal })", "bucket: 'message', signal })"],
  ['budget-checked', PD, '  if (polishBudgetExhausted(opts.bucket))', '  if (false)'],
  ['call-recorded', PD, '  recordPolishCall(opts.bucket)\n', ''],
  ['reason-disabled', PD, "polishSkipped: 'disabled' }", '}'],
  ['reason-too-long', PD, "polishSkipped: 'too_long' }", '}'],
  ['reason-breaker', PD, "polishSkipped: 'breaker_open' }", '}'],
  ['reason-daily-cap', PD, "polishSkipped: 'daily_cap' }", '}'],
  ['reason-failed', PD, "polishSkipped: 'failed' }", '}'],
  ['finalize-reports-reason', PD, '...(polishSkipped ? { polishSkipped } : {}) })', '...{} })'],
  ['draft-reports-reason', PD, '    ...(polishSkipped ? { polishSkipped } : {}),\n', ''],
  // Prompt switch.
  ['env-selects-version', C, "  return raw === 'v1' || raw === 'v2' ? raw : DEFAULT_DICTATION_POLISH_PROMPT", '  return DEFAULT_DICTATION_POLISH_PROMPT'],
  ['explicit-version-wins', C, '  const version = opts.promptVersion ?? dictationPolishPromptVersion()', '  const version = dictationPolishPromptVersion()'],
  ['system-prompt-follows-version', C, 'DICTATION_POLISH_SYSTEM_PROMPTS[version]', 'DICTATION_POLISH_SYSTEM_PROMPTS.v2'],
  ['v1-is-byte-identical', C, "doubled words, stray filler, and the known spellings below.'", "doubled words, stray filler, fillers, and the known spellings below.'"],
  ['default-is-v2', C, "export const DEFAULT_DICTATION_POLISH_PROMPT: DictationPolishPromptVersion = 'v2'", "export const DEFAULT_DICTATION_POLISH_PROMPT: DictationPolishPromptVersion = 'v1'"],
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
const scratch = mkdtempSync(join(tmpdir(), 'dictation-polish-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  // The quiet-gate tests run the real Silero model (the only file of server/models they need).
  cpSync(join(root, 'server/models/silero_vad.onnx'), join(scratch, 'server/models/silero_vad.onnx'))
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  cpSync(join(root, 'managed-runtime-contract.json'), join(scratch, 'managed-runtime-contract.json'))
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
  console.log(`${selected.length - survived.length} of ${selected.length} dictation polish mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
