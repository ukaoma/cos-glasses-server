#!/usr/bin/env node
// 6.92.0 dictation parity Wave A mutation gate (plan r3): the keyed and slow polish breakers, the
// prewarm route on the keyed breaker, prompt edit's switch, cap, own counter, breaker, refusals and
// text runner, the filler pass's language gate and token exemptions, the options answer's
// meaningGuard, and the eval harness limits. The runner is the 6.91.0 voice-style gate's:
//
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file, and the mutated file differs.
//   2. The mutated file still PARSES (esbuild). One that does not is INVALID, never a kill.
//   3. A KILL counts only when the test NAMED for that mutant fails (its 5th field, a substring of
//      exactly one test's "file > describe > test"). SURVIVED, MISATTRIBUTED, INVALID and CRASHED
//      each fail the gate.
//   4. The file is restored byte for byte before the next mutant.
// Each mutant runs the named test's file only; the baseline runs all.
// Usage: node server/scripts/dictation-parity-6920-mutation-gate.mjs [--list | --check | --discover] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { transformSync } from 'esbuild'


const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/dictation-polish-breakers.test.ts', 'server/lib/claude-circuit.test.ts', 'server/routes/prompt-drafts.test.ts',
  'server/routes/prompt-edit.test.ts', 'server/routes/prompt-edit-g2-contract.test.ts', 'server/lib/claude-text-runner.test.ts',
  'server/lib/key-lanes-spawn-census.test.ts', 'server/lib/dictation-fillers.test.ts', 'server/lib/dictation-fillers-fixture.test.ts',
  'server/lib/dictation-meaning-guard.test.ts', 'server/routes/dictation-polish-settings.test.ts', 'server/scripts/dictation-eval-harness.test.ts',
  'server/lib/dictation-polish-budget.test.ts']
const PL = 'server/lib/dictation-polish-pipeline.ts', PD = 'server/routes/prompt-drafts.ts'
const PE = 'server/lib/prompt-edit.ts', PR = 'server/routes/prompt-edit.ts', CT = 'server/lib/claude-text-runner.ts'
const F = 'server/lib/dictation-fillers.ts', G = 'server/lib/dictation-meaning-guard.ts', R = 'server/routes/dictation-polish-settings.ts'
const FE = 'server/scripts/dictation-format-eval.ts', CE = 'server/scripts/dictation-custom-polish-eval.ts'
const BEFORE = 'const TOUCH_BEFORE = /[/.@_:#$]$/'
const AFTER = 'const TOUCH_AFTER = /^(?:[/@_#$]|[.:][\\p{L}\\p{N}])/u'
const BK = 'a filler right after a path or handle character is kept', AK = 'a filler right before a path or code character is kept'
const mutations = [
  // A-W0a: an abort is neutral to the failure breaker; the slow breaker; keyed by (model, bucket group).
  ['abort-neutral', PL, "    if (opts.signal?.aborted) {\n      // 6.92.0: the client went away", "    if (false) {\n      // 6.92.0: the client went away", '2 client aborts leave the failure breaker closed'],
  ['abort-then-error-counts-one', PL, '    } else {\n      breakers.failure.recordFailure()', '    } else {\n      breakers.failure.recordFailure(); breakers.failure.recordFailure()', 'an abort followed by an error counts 1'],
  ['slow-threshold-4', PL, 'envPositiveInt(env.COS_DICTATION_SLOW_BREAKER_ABORTS, 4)', 'envPositiveInt(env.COS_DICTATION_SLOW_BREAKER_ABORTS, 5)', '4 aborts with at least 4 s of model time open the slow breaker'],
  ['slow-open-5-minutes', PL, 'envPositiveInt(env.COS_DICTATION_SLOW_BREAKER_MS, 300_000)', 'envPositiveInt(env.COS_DICTATION_SLOW_BREAKER_MS, 600_000)', '4 aborts with at least 4 s of model time open the slow breaker'],
  ['slow-env-read', PL, 'cooldownMs: () => slowBreakerMs()', 'cooldownMs: 300_000', 'COS_DICTATION_SLOW_BREAKER_ABORTS and _MS set the threshold'],
  ['slow-counted', PL, '      if (durationMs >= SLOW_ABORT_MIN_MODEL_MS) breakers.slow.recordFailure()\n', '', '4 aborts with at least 4 s of model time open the slow breaker'],
  ['slow-consulted', PL, '  return breakers.failure.isOpen() || breakers.slow.isOpen()', '  return breakers.failure.isOpen()', '4 aborts with at least 4 s of model time open the slow breaker'],
  ['slow-reset-on-success', PL, '    breakers.slow.recordSuccess()\n', '', 'a success between aborts resets the slow count'],
  ['model-time-4s', PL, 'export const SLOW_ABORT_MIN_MODEL_MS = 4_000', 'export const SLOW_ABORT_MIN_MODEL_MS = 0', 'an abort under 4 s of model time does not count'],
  ['model-time-inclusive', PL, '      if (durationMs >= SLOW_ABORT_MIN_MODEL_MS)', '      if (durationMs > SLOW_ABORT_MIN_MODEL_MS)', 'an abort under 4 s of model time does not count'],
  ['aborted-audit-row', PL, "        polishOutcome: 'aborted',\n", '', 'an abort writes an audit row with outcome aborted'],
  ['bucket-key-meeting', PL, "  return bucket === 'meeting' ? 'meeting' : 'dictation'", "  return 'dictation'", 'a meeting failure leaves the message breaker closed'],
  ['bucket-key-drafts-with-messages', PL, "  return bucket === 'meeting' ? 'meeting' : 'dictation'", "  return bucket === 'message' ? 'dictation' : 'meeting'", 'message and prompt_draft are one group'],
  ['prewarm-keyed', PD, '  if (polishBreakerOpen(model, surface)) return res.status(409)', "  if (polishBreakerOpen(model, 'message')) return res.status(409)", 'prewarm refuses when it could not be used'],
  // A-W0b: prompt edit's switch, cap, own counter, breaker, refusals and runner.
  ['edit-switch', PE, "  if (!promptEditEnabled(env)) return 'off'", "  if (false) return 'off'", 'COS_PROMPT_EDIT=0 answers 503'],
  ['edit-switch-default-on', PE, '  return readSwitch(env.COS_PROMPT_EDIT, true)', '  return readSwitch(env.COS_PROMPT_EDIT, false)', 'COS_PROMPT_EDIT=0 answers 503'],
  ['edit-cap', PE, "  if (promptEditCountToday() >= promptEditDailyCap(env)) return 'cap'", "  if (false) return 'cap'", 'the daily cap (COS_PROMPT_EDIT_DAILY_CAP'],
  ['edit-cap-at-limit', PE, "  if (promptEditCountToday() >= promptEditDailyCap(env)) return 'cap'", "  if (promptEditCountToday() > promptEditDailyCap(env)) return 'cap'", 'the daily cap (COS_PROMPT_EDIT_DAILY_CAP'],
  ['edit-cap-default-200', PE, 'export const PROMPT_EDIT_DEFAULT_DAILY_CAP = 200', 'export const PROMPT_EDIT_DEFAULT_DAILY_CAP = 300', 'the daily cap (COS_PROMPT_EDIT_DAILY_CAP'],
  ['edit-call-counted', PR, '  recordPromptEditCall()\n', '', 'the daily cap (COS_PROMPT_EDIT_DAILY_CAP'],
  ['edit-own-counter', PE, "export const PROMPT_EDIT_COUNT_FILE = '.prompt_edit_count.json'", "export const PROMPT_EDIT_COUNT_FILE = '.dictation_autoclean_count.json'", 'the daily cap (COS_PROMPT_EDIT_DAILY_CAP'],
  ['edit-breaker', PE, "  if (promptEditBreaker.isOpen()) return 'paused'", "  if (false) return 'paused'", '3 CLI failures open the breaker'],
  ['edit-breaker-3', PE, 'export const PROMPT_EDIT_BREAKER_FAILURES = 3', 'export const PROMPT_EDIT_BREAKER_FAILURES = 4', '3 CLI failures open the breaker'],
  ['edit-breaker-counts', PR, '    promptEditBreaker.recordFailure()\n', '', '3 CLI failures open the breaker'],
  ['edit-breaker-success', PR, '    promptEditBreaker.recordSuccess()\n', '', '3 CLI failures open the breaker'],
  ['edit-abort-neutral', PR, '    if (abort.signal.aborted) {', '    if (false) {', 'a client abort is neutral to the breaker'],
  ['edit-refusal-text-plain', PR, "  res.status(status).type('text/plain').send(body)", '  res.status(status).json({ error: body })', 'COS_PROMPT_EDIT=0 answers 503'],
  ['edit-500-no-tails', PR, "    refuse(res, 'failed')\n  }\n})", '    res.status(500).json({ error: String(err) })\n  }\n})', 'a failure answers 500'],
  ['edit-refusal-short', PE, "  cap: { status: 429, body: 'Edit limit reached' },", "  cap: { status: 429, body: 'Prompt edit paused until tomorrow (daily limit).' },", 'cap: the lens footer is 40 characters or fewer'],
  ['edit-runs-isolated', PE, '  return runClaudeText(buildPromptEditPrompt(input), {', '  return spawnClaudeText(buildPromptEditPrompt(input), {', 'prompt edit runs through the tool-less text runner'],
  ['runner-no-tools', CT, "    '--tools', '', '--settings'", "    '--settings'", 'isolation pin'],
  ['runner-scratch-cwd', CT, 'env: claudeTextEnv(binary.path), cwd: workspace,', 'env: claudeTextEnv(binary.path), cwd: process.cwd(),', 'runs the binary with that argv in a scratch directory'],
  ['runner-keeps-env', CT, '  const out = { ...env }\n  delete out.CLAUDECODE', "  const out = { ...env }\n  delete out.ANTHROPIC_API_KEY\n  delete out.CLAUDECODE", 'keeps the environment as spawnClaudeText did'],
  // A-W10: the language gate.
  ['gate-wired', F, '  return fillerTextLooksEnglish(text) ? stripDisfluencies(text) : text', '  return stripDisfluencies(text)', 'the server filler step is gated'],
  // QA fix: the filler gate has its own function; the meaning guard keeps 6.91.1's looksEnglish.
  ['gate-short-replies', G, '  const english = tokens.filter(t => ENGLISH.has(t.low) || SHORT_REPLY_ENGLISH.has(t.low)).length', '  const english = tokens.filter(t => ENGLISH.has(t.low)).length', 'a short English reply or command counts as English evidence'],
  ['gate-long-text-ratio', G, '  if (!looksEnglish(text)) return false\n', '', 'a short text with foreign function words is not English'],
  ['guard-names-keep-6911-language', G, '  const withNames = looksEnglish(cleaned)', '  const withNames = fillerTextLooksEnglish(cleaned)', '"um thanks Dana" polished to "Thanks." is refused for the name'],
  // QA S1: the abort's model time is stamped in the listener.
  ['abort-time-stamped', PL, '      const durationMs = (abortedAt ?? Date.now()) - startedAt', '      const durationMs = Date.now() - startedAt', 'the model time is stamped at the abort'],
  // Forces the gate open (an English word ahead of the text, sliced off after): the pipeline must call the gated step.
  ['gate-in-pipeline', PL, 'cleaned = stripFillersIfEnglish(cleaned)', "cleaned = stripFillersIfEnglish('the ' + cleaned).slice(4)", 'a German or Portuguese message reaches the model as said'],
  ['gate-foreign-words', G, '  if (foreign > 0) return english > foreign', '  if (false) return english > foreign', 'a short text with foreign function words is not English'],
  ['gate-all-caps-not-foreign', G, ' && !(t.raw.length > 1 && t.raw === t.raw.toUpperCase())).length', ').length', 'a short text with foreign function words is not English'],
  ['gate-inline-um-er', G, '  if (inlineAmbiguous) return english > 0', '  if (false) return english > 0', 'an inline um or er needs an English function word'],
  ['gate-paused-is-hesitation', G, '&& i + 1 < tokens.length && !tokens[i + 1].pause)', '&& i + 1 < tokens.length)', 'an inline um or er needs an English function word'],
  // A-W10: the token exemptions, one character at a time.
  ['touch-before-slash', F, BEFORE, 'const TOUCH_BEFORE = /[.@_:#$]$/', `${BK} (before /)`],
  ['touch-before-dot', F, BEFORE, 'const TOUCH_BEFORE = /[/@_:#$]$/', `${BK} (before .)`],
  ['touch-before-at', F, BEFORE, 'const TOUCH_BEFORE = /[/._:#$]$/', `${BK} (before @)`],
  ['touch-before-underscore', F, BEFORE, 'const TOUCH_BEFORE = /[/.@:#$]$/', `${BK} (before _)`],
  ['touch-before-colon', F, BEFORE, 'const TOUCH_BEFORE = /[/.@_#$]$/', `${BK} (before :)`],
  ['touch-before-hash', F, BEFORE, 'const TOUCH_BEFORE = /[/.@_:$]$/', `${BK} (before #)`],
  ['touch-before-dollar', F, BEFORE, 'const TOUCH_BEFORE = /[/.@_:#]$/', `${BK} (before $)`],
  ['touch-before-wired', F, '      || TOUCH_BEFORE.test(out + before)\n', '', `${BK} (before /)`],
  ['touch-after-slash', F, AFTER, 'const TOUCH_AFTER = /^(?:[@_#$]|[.:][\\p{L}\\p{N}])/u', `${AK} (after /)`],
  ['touch-after-at', F, AFTER, 'const TOUCH_AFTER = /^(?:[/_#$]|[.:][\\p{L}\\p{N}])/u', `${AK} (after @)`],
  ['touch-after-underscore', F, AFTER, 'const TOUCH_AFTER = /^(?:[/@#$]|[.:][\\p{L}\\p{N}])/u', `${AK} (after _)`],
  ['touch-after-hash', F, AFTER, 'const TOUCH_AFTER = /^(?:[/@_$]|[.:][\\p{L}\\p{N}])/u', `${AK} (after #)`],
  ['touch-after-dollar', F, AFTER, 'const TOUCH_AFTER = /^(?:[/@_#]|[.:][\\p{L}\\p{N}])/u', `${AK} (after $)`],
  ['touch-after-dot', F, AFTER, 'const TOUCH_AFTER = /^(?:[/@_#$]|[:][\\p{L}\\p{N}])/u', `${AK} (after . and a letter)`],
  ['touch-after-colon', F, AFTER, 'const TOUCH_AFTER = /^(?:[/@_#$]|[.][\\p{L}\\p{N}])/u', `${AK} (after : and a digit)`],
  ['touch-after-needs-alnum', F, AFTER, 'const TOUCH_AFTER = /^(?:[/@_#$]|[.:])/u', 'a sentence-final period, ellipsis or colon is not a token character'],
  ['touch-after-wired', F, '      || TOUCH_AFTER.test(after)\n', '', `${AK} (after /)`],
  // A-W2: the options answer.
  ['options-meaning-guard-flag', R, '    meaningGuard: meaningGuardEnabled(),', '    meaningGuard: true,', 'the options answer says meaningGuard'],
  ['options-style-pairs', R, 'filter(model => styleAndRegisterApply(model, effectiveByModel[model]))', "filter(model => model === 'sonnet')", 'the options answer says meaningGuard'],
  // A-W0c: the harness defaults.
  ['format-default-fits', FE, 'export const FORMAT_DEFAULT_MAX_CALLS = 50', 'export const FORMAT_DEFAULT_MAX_CALLS = 40', 'the format default --max-calls is at least'],
  ['custom-default-fits', CE, 'export const CUSTOM_POLISH_DEFAULT_MAX_CALLS = 205', 'export const CUSTOM_POLISH_DEFAULT_MAX_CALLS = 200', 'the custom-polish default fits its cap'],
]

const DISCOVER_FILES = {}

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name, , , , check] of mutations) console.log(`${name}  <- ${check ?? '(no check)'}`); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const selected = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && selected.length !== names.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
const discover = args.includes('--discover')

let badTargets = 0
for (const [name, file, find, replacement] of mutations) {
  const text = readFileSync(join(root, file), 'utf8'), count = text.split(find).length - 1
  if (count !== 1 || find === replacement) { badTargets++; console.log(`${name}: ${count} matches in ${file}`) }
}
if (badTargets) { console.log(`${mutations.length - badTargets} of ${mutations.length} targets unique`); process.exit(1) }

/** Parse only (esbuild, no type check): a mutant that does not parse is INVALID. */
function parses(file, text) {
  try { transformSync(text, { loader: file.endsWith('.ts') ? 'ts' : 'js', format: 'esm', logLevel: 'silent' }); return null }
  catch (err) { return String(err?.errors?.[0]?.text ?? err?.message ?? err).split('\n')[0] }
}

// The parse check itself must be able to fail: the 31c59dd gate counted exactly this shape (an object
// spread with a bare object in it) as a kill.
if (parses('x.ts', 'const used = {\n  ...a,\n    { polishRegister: register },\n}') === null || parses('x.ts', 'const n: number = 1') !== null) {
  throw new Error('parse self-test failed')
}
console.log('parse self-test: rejects a bare object in a spread list, accepts plain TypeScript')

const scratch = mkdtempSync(join(tmpdir(), 'dictation-parity-6920-mutations-'))
// --check and --discover end with process.exit, which skips `finally`: remove the copy on exit too.
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'server/models/silero_vad.onnx'), join(scratch, 'server/models/silero_vad.onnx'))
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  cpSync(join(root, 'managed-runtime-contract.json'), join(scratch, 'managed-runtime-contract.json'))
  // 6.92.0: dictation-polish-budget.test.ts checks every key is documented there.
  cpSync(join(root, '.env.example'), join(scratch, '.env.example'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const report = join(scratch, 'vitest-report.json')
  const scratchReal = realpathSync(scratch)
  /** Run vitest on these files; the per-test results from its JSON report, or null when there is none. */
  const run = files => {
    rmSync(report, { force: true })
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`, ...files], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json'),
        COS_MAINTENANCE_GATE_PATH: join(scratch, 'gate', 'maintenance-gate.json'),
      },
      encoding: 'utf8', timeout: 300000,
    })
    if (result.error || !existsSync(report)) return { status: result.status, error: result.error?.message ?? 'no report', tests: null }
    const json = JSON.parse(readFileSync(report, 'utf8'))
    const tests = json.testResults.flatMap(file => {
      // The report names files by real path (/private/var/... for a /var/... temp dir).
      const rel = file.name.startsWith(scratchReal + '/') ? file.name.slice(scratchReal.length + 1)
        : file.name.startsWith(scratch + '/') ? file.name.slice(scratch.length + 1) : file.name
      // A file that failed to load has no tests: report it as one failed entry, never as a kill.
      if (!file.assertionResults.length && file.status === 'failed') return [{ name: `${rel} (file failed to load)`, status: 'failed' }]
      return file.assertionResults.map(a => ({ name: [rel, ...a.ancestorTitles, a.title].join(' > '), status: a.status }))
    })
    return { status: result.status, error: null, tests }
  }

  const baseline = run(tests)
  if (baseline.status !== 0 || !baseline.tests || baseline.tests.some(t => t.status === 'failed')) {
    const failing = (baseline.tests ?? []).filter(t => t.status === 'failed').map(t => t.name)
    throw new Error('Baseline failed; a gate over a red suite proves nothing: ' + (baseline.error ?? failing.join(' | ')))
  }
  const passed = baseline.tests.filter(t => t.status === 'passed').length
  console.log(`baseline green (${passed} tests passed in ${tests.length} files)`)

  // Every named check names exactly one test that ran green in the baseline.
  if (!discover) {
    let unnamed = 0
    for (const [name, , , , check] of selected) {
      const hits = typeof check === 'string' && check ? baseline.tests.filter(t => t.name.includes(check)) : []
      if (hits.length !== 1 || hits[0].status !== 'passed') { unnamed++; console.log(`${name}: check ${JSON.stringify(check)} names ${hits.length} tests`) }
    }
    if (unnamed) throw new Error(`${unnamed} mutants have no single named check`)
    if (args.includes('--check')) { console.log(`${mutations.length} of ${mutations.length} targets unique; ${selected.length} named checks each name one green test`); process.exit(0) }
  }

  const tally = { KILLED: [], SURVIVED: [], MISATTRIBUTED: [], INVALID: [], CRASHED: [] }
  for (const [name, file, find, replacement, check] of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    if (original.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}`)
    const mutated = original.replace(find, () => replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    const parseError = parses(file, mutated)
    if (parseError) { tally.INVALID.push(name); console.log(`INVALID        ${name}  (does not parse: ${parseError})`); continue }
    writeFileSync(target, mutated)
    const checkFile = discover ? null : baseline.tests.find(t => t.name.includes(check)).name.split(' > ')[0]
    let result = run(discover ? DISCOVER_FILES[file] ?? tests : [checkFile])
    if (discover && result.tests && !result.tests.some(t => t.status === 'failed') && DISCOVER_FILES[file]) result = run(tests)
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    if (!result.tests) { tally.CRASHED.push(name); console.log(`CRASHED        ${name}  (${result.error})`); continue }
    const failed = result.tests.filter(t => t.status === 'failed').map(t => t.name)
    if (discover) { console.log(`${failed.length ? 'FAILS' : 'SURVIVED'}  ${name}${failed.map(f => '\n    ' + f).join('')}`); (failed.length ? tally.KILLED : tally.SURVIVED).push(name); continue }
    if (failed.some(f => f.includes(check))) { tally.KILLED.push(name); console.log(`KILLED         ${name}  <- ${check}`); continue }
    if (!failed.length) { tally.SURVIVED.push(name); console.log(`SURVIVED       ${name}  (named: ${check})`); continue }
    tally.MISATTRIBUTED.push(name); console.log(`MISATTRIBUTED  ${name}  (named: ${check}; failed: ${failed.slice(0, 2).join(' | ')})`)
  }
  const bad = selected.length - tally.KILLED.length
  console.log(`${tally.KILLED.length} killed by their named check, ${tally.SURVIVED.length} survived, ${tally.MISATTRIBUTED.length} misattributed, `
    + `${tally.INVALID.length} invalid, ${tally.CRASHED.length} crashed`)
  if (discover) process.exit(0)
  if (bad) { for (const k of ['SURVIVED', 'MISATTRIBUTED', 'INVALID', 'CRASHED']) if (tally[k].length) console.log(`${k}: ${tally[k].join(', ')}`); process.exitCode = 1 }
  else console.log(`PASS dictation parity 6.92.0 mutation gate: ${selected.length} of ${selected.length}, each killed by its named check, green baseline`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
