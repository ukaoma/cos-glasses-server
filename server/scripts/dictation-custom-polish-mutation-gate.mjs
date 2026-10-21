#!/usr/bin/env node
// "Your polish instructions" mutation gate (6.85.0): the stored setting and its sanitizer, the
// prompt assembly (rules first, the block after them, empty = the 6.83.1 prompt), both dictation
// surfaces (cold and warm), the meeting exclusion, the telemetry, the routes and the capability.
// Same runner as dictation-format-mutation-gate.mjs: mutations run only in a disposable copy of
// server/ and shared/, never in the live checkout.
//
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file.
//   2. The mutated file differs from the original.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build or harness failure is not a kill.
//   4. The file is restored byte for byte before the next mutant.
// Usage: node server/scripts/dictation-custom-polish-mutation-gate.mjs [--list | --check] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/dictation-polish-instructions.test.ts', 'server/lib/dictation-polish-custom-prompt.test.ts',
  'server/lib/dictation-clean.test.ts', 'server/lib/dictation-prewarm.test.ts', 'server/routes/prompt-drafts.test.ts',
  'server/routes/dictation-polish-settings.test.ts', 'server/lib/token-audit-key-fields.test.ts', 'server/routes/health.test.ts']
const I = 'server/lib/dictation-polish-instructions.ts', C = 'server/lib/dictation-clean.ts', P = 'server/lib/dictation-prewarm.ts'
const PD = 'server/routes/prompt-drafts.ts', R = 'server/routes/dictation-polish-settings.ts', T = 'server/lib/token-audit.ts'
const H = 'server/routes/health.ts'
const mutations = [
  // Sanitizer and bounds.
  ['cap-is-1000', I, '  if (value.length > CUSTOM_INSTRUCTIONS_MAX_CHARS) {', '  if (value.length > CUSTOM_INSTRUCTIONS_MAX_CHARS + 1) {'],
  ['raw-cap-refused-early', I, '  if (raw.length > CUSTOM_INSTRUCTIONS_MAX_RAW_CHARS) {', '  if (false) {'],
  ['strings-only', I, "  if (typeof raw !== 'string') return", "  if (false) return"],
  ['controls-stripped', I, "    .replace(CONTROL, '')\n", ''],
  ['invisibles-stripped', I, "    .replace(INVISIBLE, '')\n", ''],
  ['prompt-tags-stripped', I, "    .replace(RESERVED_TAG, '')\n", ''],
  ['prompt-tags-any-case', I, '\\b[^>]*>/gi', '\\b[^>]*>/g'],
  ['line-breaks-normalized', I, "    .replace(/\\r\\n?|[\\u2028\\u2029]/g, '\\n')\n", ''],
  ['tabs-are-spaces', I, "    .replace(/\\t/g, ' ')\n", ''],
  ['blank-lines-collapsed', I, "    .replace(/\\n{3,}/g, '\\n\\n')\n", ''],
  ['trimmed', I, '    .trim()\n  if (value.length', '  if (value.length'],
  ['hash-is-short', I, ".digest('hex').slice(0, 8) : ''", ".digest('hex') : ''"],
  ['no-hash-when-off', I, ".digest('hex').slice(0, 8) : ''", ".digest('hex').slice(0, 8) : 'none'"],
  // Stored setting.
  ['read-sanitizes-again', I, '    const clean = sanitizeCustomInstructions(parsed?.customInstructions)', "    const clean = { ok: true as const, value: String(parsed?.customInstructions ?? '') }"],
  ['clear-deletes-file', I, '  if (!value) {\n    try { unlinkSync', '  if (false) {\n    try { unlinkSync'],
  ['file-is-private', I, "{ mode: 0o600 })\n  return stored", "{ mode: 0o644 })\n  return stored"],
  ['warns-once', I, '  if (warned) return\n', ''],
  ['damaged-file-reads-off', I, '      value = { customInstructions: clean.value, updatedAt:', "      value = { customInstructions: String(parsed?.customInstructions ?? clean.value), updatedAt:"],
  // Prompt assembly.
  ['block-in-prompt', C, '    ...userPreferencesBlock(customInstructions),\n', ''],
  ['block-after-rules', C, "    ...dictationPolishRules(version),\n    '',\n    ...userPreferencesBlock(customInstructions),\n", "    ...userPreferencesBlock(customInstructions),\n    ...dictationPolishRules(version),\n    '',\n"],
  ['block-sanitizes', C, "  const clean = sanitizeCustomInstructions(customInstructions ?? '')\n  if (!clean.ok || !clean.value) return []", "  const clean = { ok: true as const, value: customInstructions ?? '' }\n  if (!clean.value) return []"],
  ['block-intro', C, "    ...USER_PREFERENCES_INTRO,\n    '<user-style-preferences>',", "    '<user-style-preferences>',"],
  ['block-precedence-after', C, "    '</user-style-preferences>',\n    USER_PREFERENCES_PRECEDENCE,\n", "    '</user-style-preferences>',\n"],
  ['intro-names-invariants', C, 'never drop or alter a link, path, email, number or name the speaker said', 'never drop a link'],
  ['cold-call-sends-them', C, "buildDictationPolishPrompt(text, terms, version, opts.customInstructions ?? '')", 'buildDictationPolishPrompt(text, terms, version)'],
  ['warm-call-sends-them', P, "buildDictationPolishPrompt(text, terms, entry.version, opts.customInstructions ?? '')", 'buildDictationPolishPrompt(text, terms, entry.version)'],
  // The dictation path.
  ['meetings-excluded', PD, "  return bucket === 'meeting' ? '' : readCustomInstructions().customInstructions", '  return readCustomInstructions().customInstructions'],
  ['route-cold-wired', PD, '{ model, signal: opts.signal, customInstructions })', '{ model, signal: opts.signal })'],
  ['route-warm-wired', PD, '{ signal: opts.signal, customInstructions })', '{ signal: opts.signal })'],
  ['answer-says-sent', PD, '  const used: PolishInstructionsUse = customInstructions ? { customInstructions: true, instructionsHash } : {}', '  const used: PolishInstructionsUse = {}'],
  ['failed-still-says-sent', PD, "polishSkipped: 'failed', ...(prewarm ? { prewarm } : {}), ...used }", "polishSkipped: 'failed', ...(prewarm ? { prewarm } : {}) }"],
  ['finalize-answer-field', PD, '    ...(customInstructions ? { customInstructions, instructionsHash } : {}),\n  })', '  })'],
  ['prompt-draft-answer-field', PD, '    // 6.85.0, additive.\n    ...(customInstructions ? { customInstructions, instructionsHash } : {}),\n', ''],
  ['audit-wired', PD, '      polishInstructions: { on: Boolean(customInstructions), hash: instructionsHash },\n', ''],
  ['audit-row-flag', T, '      custom_instructions: entry.polishInstructions.on,', '      custom_instructions: true,'],
  ['audit-row-hash', T, '...(entry.polishInstructions.hash ? { instructions_hash: entry.polishInstructions.hash } : {}),', ''],
  // Routes and capability.
  ['put-one-key-only', R, " || !Object.keys(body).every(key => key === 'customInstructions')) {", ') {'],
  ['too-long-is-413', R, "clean.error === 'too_long' ? 413 : 400", '400'],
  ['delete-clears', R, "    res.json(view(writeCustomInstructions('')))", '    res.json(view(readCustomInstructions()))'],
  ['view-enabled', R, '    enabled: stored.customInstructions.length > 0,', '    enabled: true,'],
  ['rules-of-version-in-use', R, "    rules: dictationPolishRules(version).join('\\n'),", "    rules: dictationPolishRules('v3').join('\\n'),"],
  ['rules-says-rolled-back', R, '    rolledBack: version !== DEFAULT_DICTATION_POLISH_PROMPT,', '    rolledBack: false,'],
  ['capability-shape', R, '  return { protocol: CUSTOM_INSTRUCTIONS_PROTOCOL, maxChars: CUSTOM_INSTRUCTIONS_MAX_CHARS }', '  return { protocol: CUSTOM_INSTRUCTIONS_PROTOCOL }'],
  ['capability-on-health', H, "customInstructions: customInstructionsCapability() },\n      // 6.67.0", "},\n      // 6.67.0"],
  ['capability-on-models', H, "customInstructions: customInstructionsCapability() },\n      durableQueryJobs", "},\n      durableQueryJobs"],
  ['router-mounted', 'server/index.ts', "app.use('/api', dictationPolishSettingsRouter)\n", ''],
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
const scratch = mkdtempSync(join(tmpdir(), 'dictation-custom-polish-mutations-'))
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
  console.log(`${selected.length - survived.length} of ${selected.length} custom polish mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
