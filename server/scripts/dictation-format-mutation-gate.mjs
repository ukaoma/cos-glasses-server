#!/usr/bin/env node
// Dictation format mutation gate (6.83.1): correction-only dictionary entries (links, emails,
// paths), the correction pass, the decoder prompt that must never hold them, spoken paths, the
// polish link guard and the v3 prompt. Same runner as dictation-polish-mutation-gate.mjs:
// mutations run only in a disposable copy of server/ and shared/, never in the live checkout.
//
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file.
//   2. The mutated file differs from the original.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build or harness failure is not a kill.
//   4. The file is restored byte for byte before the next mutant.
// Usage: node server/scripts/dictation-format-mutation-gate.mjs [--list | --check] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/glossary-learn.test.ts', 'server/routes/glossary-correction-only.test.ts', 'server/routes/glossary.test.ts',
  'server/lib/dictation-format.test.ts', 'server/routes/prompt-drafts.test.ts', 'server/lib/dictation-clean.test.ts',
  'server/lib/dictation-prewarm.test.ts', 'server/lib/dictation-polish-need.test.ts', 'server/lib/hallucination-vocab-echo.test.ts']
const GL = 'server/lib/glossary-learn.ts', GR = 'server/routes/glossary.ts', W = 'server/lib/whisper-local.ts'
const H = 'server/lib/hallucination-filter.ts', DF = 'server/lib/dictation-format.ts', PD = 'server/routes/prompt-drafts.ts'
const C = 'server/lib/dictation-clean.ts', N = 'server/lib/dictation-polish-need.ts'
const mutations = [
  // Dictionary: a link, email or path is a correction only.
  ['correction-only-detected', GL, '  const correctionOnly = isCorrectionOnly(written)\n', '  const correctionOnly = false\n'],
  ['correction-only-skips-vocabulary', GL, '  const addsVocabulary = !inVocabulary && !correctionOnly\n', '  const addsVocabulary = !inVocabulary\n'],
  ['bare-symbol-refused', GL, '  if (correctionOnly && !/[\\p{L}\\p{N}]/u.test(written)) {', '  if (false) {'],
  ['correction-only-repeat-unchanged', GL, '(inVocabulary || correctionOnly)) return { ok: true, unchanged: true }', 'inVocabulary) return { ok: true, unchanged: true }'],
  ['vocab-cap-only-when-adding', GL, '  if (addsVocabulary && words.vocabulary.length >= MAX_TERMS) {', '  if (!inVocabulary && words.vocabulary.length >= MAX_TERMS) {'],
  ['entry-records-no-vocabulary', GL, '    addedVocabulary: addsVocabulary,', '    addedVocabulary: !inVocabulary,'],
  ['vocabulary-guard-kept', GL, '  if (looksLikeUrlEmailPath(term.value)) {', '  if (false) {'],
  ['forms-are-links-only', GL, '    if (v && isCorrectionOnly(v) && !out.includes(v)) out.push(v)', '    if (v && !out.includes(v)) out.push(v)'],
  ['context-puts-spoken-form-back', GL, '  for (const [heard, written] of pairs) out = out.split(written).join(heard)\n', ''],
  ['context-longest-first', GL, '    .sort((a, b) => b[1].length - a[1].length)\n', ''],
  ['context-skips-path-heard', GL, ' && !isCorrectionOnly(heard))', ')'],
  ['route-says-correction-only', GR, '        ...(correctionOnly ? { correctionOnly: true, note: CORRECTION_ONLY_NOTE } : {}),\n', ''],
  // Decoder prompt and the correction pass.
  ['decoder-context-sanitized', W, '  sanitized = decoderSafeContext(sanitized, getWhisperCorrections())\n', ''],
  ['multiword-separators-flex', W, ".join('[\\\\s-]+')", ".join(' ')"],
  ['replacement-is-literal', W, '    result = result.replace(pattern, () => replacement)', '    result = result.replace(pattern, replacement)'],
  ['containing-key-goes-first', W, '    else out.splice(at, 0, entry)', '    else out.push(entry)'],
  ['containment-is-word-bounded', W, '    const at = out.findIndex(([key]) => mine !== norm(key) && mine.includes(norm(key)))', '    const at = out.findIndex(([key]) => mine !== norm(key) && mine.includes(norm(key).trim()))'],
  ['echo-skips-correction-only', H, '    if (isCorrectionOnly(value)) continue\n', ''],
  // Spoken paths (deterministic).
  ['spoken-path-needs-forward', DF, 'forward[ \\t-]+slash[ \\t]+', '(?:forward[ \\t-]+)?slash[ \\t]+'],
  ['spoken-path-word-start', DF, '/(?<![\\p{L}\\p{N}])forward', '/forward'],
  ['spoken-path-phrase-end', DF, '(?=[ \\t]*(?:[,.;:!?)]|\\n|$))/giu', '/giu'],
  ['spoken-path-article-is-the-key', DF, '    if (ARTICLE_BEFORE.test(text.slice(0, offset))) return match\n', ''],
  ['spoken-path-key-word', DF, '    if (NAMES_THE_KEY.test(word)) return match\n', ''],
  ['spoken-path-lowercase', DF, '    return `/${word.toLowerCase()}`', '    return `/${word}`'],
  ['spoken-paths-switch', DF, "  return !['0', 'false', 'off'].includes((env.COS_DICTATION_SPOKEN_PATHS", "  return true || !['0', 'false', 'off'].includes((env.COS_DICTATION_SPOKEN_PATHS"],
  // Polish link guard.
  ['lost-dictionary-link', DF, "    if (link && input.includes(link) && !output.includes(link)) return 'lost_dictionary_link'", "    if (false) return 'lost_dictionary_link'"],
  ['lost-link-needs-input', DF, '    if (link && input.includes(link) && !output.includes(link))', '    if (link && !output.includes(link))'],
  ['link-letters-said', DF, "    if (pieces.some(piece => !said.includes(piece))) return 'invented_link'\n", ''],
  ['at-said', DF, "    if (lower.includes('@') && !spoken(inputLower, /@|\\bat\\b/)) return 'invented_link'\n", ''],
  ['dot-said', DF, "&& !spoken(inputLower, /\\bdot\\b|[\\p{L}\\p{N}]\\.[\\p{L}\\p{N}]/u)) return 'invented_link'", "&& false) return 'invented_link'"],
  ['dot-said-not-a-period', DF, '/\\bdot\\b|[\\p{L}\\p{N}]\\.[\\p{L}\\p{N}]/u', '/\\.|\\bdot\\b/'],
  ['slash-said', DF, "    if (lower.startsWith('/') && !spoken(inputLower,", "    if (false && !spoken(inputLower,"],
  ['slash-said-not-and-or', DF, '/\\bslash\\b|(?<![\\p{L}\\p{N}])\\/[\\p{L}\\p{N}]|', '/\\bslash\\b|\\/|'],
  ['slug-request-allows-paths', DF, '|\\b(?:slugs?|paths?|urls?)\\b/u', '/u'],
  ['path-token-not-and-or', DF, 'String.raw`(?<![\\p{L}\\p{N}\\/])\\/[', 'String.raw`\\/['],
  ['link-token-trailing-punctuation', DF, ".map(token => token.replace(/[.,;:!?]+$/, ''))", ''],
  // Route wiring.
  ['guard-wired', PD, '    if (linkProblem) {', '    if (false) {'],
  ['guard-gets-dictionary-links', PD, 'polishLinkProblem(cleaned, polished, correctionOnlyForms(getWhisperCorrections()))', 'polishLinkProblem(cleaned, polished, [])'],
  ['spoken-paths-skip-meetings', PD, "  if (opts.bucket !== 'meeting' && spokenPathsEnabled()) cleaned = renderSpokenPaths(cleaned)", '  if (spokenPathsEnabled()) cleaned = renderSpokenPaths(cleaned)'],
  ['spoken-paths-switch-wired', PD, "  if (opts.bucket !== 'meeting' && spokenPathsEnabled()) cleaned = renderSpokenPaths(cleaned)", "  if (opts.bucket !== 'meeting') cleaned = renderSpokenPaths(cleaned)"],
  // v3 prompt.
  ['v3-has-link-rules', C, "    ...(version === 'v3' ? [...SPOKEN_LINK_RULES, ''] : []),", '    ...([] as string[]),'],
  ['v2-has-no-link-rules', C, "    ...(version === 'v3' ? [...SPOKEN_LINK_RULES, ''] : []),", "    ...[...SPOKEN_LINK_RULES, ''],"],
  ['v3-keeps-written-links', C, "    ...(version === 'v3' ? ['- Change a link", "    ...(false ? ['- Change a link"],
  ['need-sees-spoken-links', N, '|slash|backslash|underscore|hyphen|at sign|dot (com|net|org|io|ai|co|dev|app)|all caps|slugs?)', ')'],
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
const scratch = mkdtempSync(join(tmpdir(), 'dictation-format-mutations-'))
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
  console.log(`${selected.length - survived.length} of ${selected.length} dictation format mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
