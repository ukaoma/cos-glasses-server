#!/usr/bin/env node
// 6.91.0 "dictation that learns your voice" mutation gate (plan r2): the meaning guard, the
// register table and the literal check, the learned-style setting (validate, cap, switch,
// templates, routes), the prompt order and blocks, the pipeline wiring and the capability.
// Same runner as dictation-custom-polish-mutation-gate.mjs: mutations run only in a disposable
// copy of server/ and shared/, never in the live checkout.
//
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file.
//   2. The mutated file differs from the original.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build or harness failure is not a kill.
//   4. The file is restored byte for byte before the next mutant.
// Usage: node server/scripts/dictation-voice-style-6910-mutation-gate.mjs [--list | --check] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/dictation-meaning-guard.test.ts', 'server/lib/dictation-register.test.ts', 'server/lib/dictation-learned-style.test.ts',
  'server/lib/dictation-polish-prompt-v4.test.ts', 'server/lib/dictation-clean.test.ts', 'server/lib/dictation-prewarm.test.ts',
  'server/routes/prompt-drafts.test.ts', 'server/routes/dictation-polish-settings.test.ts', 'server/routes/health.test.ts',
  'server/routes/health-6890-parity.test.ts', 'server/lib/token-audit-key-fields.test.ts', 'server/lib/dictation-polish-custom-prompt.test.ts']
const G = 'server/lib/dictation-meaning-guard.ts', RG = 'server/lib/dictation-register.ts', LS = 'server/lib/dictation-learned-style.ts'
const C = 'server/lib/dictation-clean.ts', PL = 'server/lib/dictation-polish-pipeline.ts', PD = 'server/routes/prompt-drafts.ts'
const R = 'server/routes/dictation-polish-settings.ts', O = 'server/lib/dictation-polish-options.ts', P = 'server/lib/dictation-prewarm.ts'
const T = 'server/lib/token-audit.ts', I = 'server/lib/dictation-polish-instructions.ts'
const mutations = [
  // Meaning guard: what counts.
  ['guard-neg-not-folds', G, "if (t.low === 'not' || t.low === 'cannot' || /n't$/.test(t.low)) items.push", "if (t.low === 'not') items.push"],
  ['guard-neg-words', G, "      else if (NEG_WORDS.has(t.low)) items.push({ kind: 'negation', key: t.low, pos: i })\n", ''],
  ['guard-neg-marker-phrases-excluded', G, '    if (!negCover.has(i)) {', '    if (true) {'],
  ['guard-comma-no-is-marker', G, "    if (tokens[i].low === 'no' && i > 0 && tokens[i].pause && tokens[i + 1]?.pause) {", '    if (false) {'],
  ['guard-digits', G, "    if (/^\\d+$/.test(t.low)) {\n      let value", "    if (false) {\n      let value"],
  ['guard-k-thousand', G, "      if (tokens[i + 1]?.low === 'k') value *= 1000\n", ''],
  ['guard-digits-in-words', G, "    if (/\\p{L}/u.test(t.low) && /\\d/.test(t.low)) {", '    if (false) {'],
  ['guard-number-words', G, '    const run = numberRun(tokens, i)\n    if (run) {', '    const run = numberRun(tokens, i)\n    if (false) {'],
  ['guard-tens-split', G, "      if (last === 'ones' || last === 'tens') break", "      if (last === 'tens') break"],
  ['guard-scale-multiplies', G, '      else { total += (group || 1) * s; group = 0 }', '      else { total += s; group = 0 }'],
  ['guard-ordinals', G, "    if (ORDINALS.has(t.low)) { items.push({ kind: 'number', key: String(ORDINALS.get(t.low)), pos: i }); continue }\n", ''],
  ['guard-unit-words', G, "    if (NUMBER_WORDS.has(t.low)) { items.push({ kind: 'number', key: NUMBER_WORDS.get(t.low)!, pos: i }); continue }\n", ''],
  ['guard-symbols', G, "    if (SYMBOLS.has(t.raw)) { items.push({ kind: 'number', key: SYMBOLS.get(t.raw)!, pos: i }); continue }\n", ''],
  ['guard-am-pm', G, "      items.push({ kind: 'number', key: t.low, pos: i }); continue\n", '      continue\n'],
  ['guard-oclock-is-time', G, "    .replace(/\\s?o'?clock\\b/gi, ':00')\n", ''],
  ['guard-thousands-separator', G, "    .replace(/(\\d),(?=\\d{3}\\b)/g, '$1')\n", ''],
  ['guard-dates', G, "    if (date && (!DATE_NEEDS_CAPITAL.has(t.low) || /^\\p{Lu}/u.test(t.raw))) {", '    if (false) {'],
  ['guard-may-needs-capital', G, "    if (date && (!DATE_NEEDS_CAPITAL.has(t.low) || /^\\p{Lu}/u.test(t.raw))) {", '    if (date) {'],
  ['guard-names-mid-sentence', G, "      if (!t.sentenceStart || midCapital.has(fold(t.low))) items.push({ kind: 'name', key: fold(t.low), pos: i })", '      if (false) items.push({ kind: \'name\', key: fold(t.low), pos: i })'],
  ['guard-sentence-start-not-name', G, "      if (!t.sentenceStart || midCapital.has(fold(t.low))) items.push", '      if (true) items.push'],
  // A lone "I" is already excluded by the two-letter floor; the contractions are what NOT_NAMES adds.
  ['guard-i-forms-not-names', G, "const NOT_NAMES = new Set(['i', \"i'm\", \"i'll\", ", "const NOT_NAMES = new Set(['i', "],
  ['guard-dictionary-names', G, "        if (phrase.every((w, k) => fold(tokens[i + k].low) === w)) items.push({ kind: 'name', key: phrase.join(' '), pos: i })", '        if (false) items.push({ kind: \'name\', key: phrase.join(\' \'), pos: i })'],
  ['guard-english-skips-names', G, '  const withNames = looksEnglish(cleaned)', '  const withNames = true'],
  ['guard-short-text-is-english', G, '  if (words.length < 12) return true', '  if (words.length < 2) return true'],
  // Meaning guard: comparison and exemptions.
  ['guard-joined-numbers', G, '    if (parts && !inKeys.get(\'number\')!.has(key)) { parts.forEach(p => keptByJoin.add(p)); joinedOut.add(key) }', '    if (false) { parts!.forEach(p => keptByJoin.add(p)); joinedOut.add(key) }'],
  ['guard-name-joined-word', G, '    if (outWords.some(w => outJoined.has(w) && w.includes(flat))) return true\n', ''],
  ['guard-name-fold-both-sides', G, '    if (outWords.includes(fold(flat))) return true', '    if (outWords.includes(flat)) return true'],
  ['guard-name-dictionary-respell', G, '      if (knownFlat.includes(w)) return levenshtein(flat, w) <= Math.max(2, Math.floor(flat.length / 2))\n', ''],
  ['guard-name-near-respell', G, '      return /\\p{Lu}/u.test(t.raw) && levenshtein(flat, w) <= Math.max(1, Math.floor(flat.length / 4))', '      return false'],
  ['guard-respell-not-a-heard-word', G, '      if (inTokenSet.has(w)) return false\n', ''],
  ['guard-negation-never-exempt', G, "    if (item.kind === 'negation') return false\n", ''],
  ['guard-exempt-needs-marker-after', G, '      if (start <= item.pos || start - item.pos > DROP_TO_MARKER) continue', '      if (start - item.pos > DROP_TO_MARKER) continue'],
  ['guard-exempt-needs-same-kind', G, '      const replaced = input.items.some(r => r.kind === item.kind && r.key !== item.key', '      const replaced = input.items.some(r => r.key !== item.key'],
  ['guard-exempt-replacement-kept', G, "        && (r.kind === 'name' ? nameKept(r.key) : outKeys.get(r.kind)!.has(r.key)))", '        )'],
  ['guard-exemptions-at-all', G, '    if (occurrences.every(exempt)) continue\n', ''],
  ['guard-drops-counted', G, '    dropped[item.kind]++\n', ''],
  ['guard-added-negation', G, "  for (const key of outKeys.get('negation')!) if (!inKeys.get('negation')!.has(key)) added.negation++\n", ''],
  ['guard-added-number', G, "  for (const key of outNumbers) if (!inKeys.get('number')!.has(key) && !joinedOut.has(key)) added.number++\n", ''],
  ['guard-switch', G, "  return !(raw === '0' || raw === 'false' || raw === 'off')", '  return true'],
  // Registers and the literal check.
  ['register-literal-table', RG, "export const LITERAL_APPS: readonly string[] = ['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'WezTerm', 'Alacritty', 'kitty']", "export const LITERAL_APPS: readonly string[] = ['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'WezTerm', 'Alacritty', 'kitty', 'Claude']"],
  ['register-case-insensitive', RG, "  return LITERAL.has(app.trim().toLowerCase()) ? 'literal' : 'default'", "  return LITERAL.has(app.trim()) ? 'literal' : 'default'"],
  ['register-trims', RG, "  return LITERAL.has(app.trim().toLowerCase()) ? 'literal' : 'default'", "  return LITERAL.has(app.toLowerCase()) ? 'literal' : 'default'"],
  ['register-context-app', RG, '  return registerForApp((context as { app?: unknown } | null | undefined)?.app, env)', "  return registerForApp(undefined, env)"],
  // 6.91.0: the literal register is opt-in (terminal targets are mostly AI prompts in prose).
  ['registers-default-off', RG, '  return readSwitch(env.COS_DICTATION_REGISTERS, false)', '  return readSwitch(env.COS_DICTATION_REGISTERS, true)'],
  ['registers-map-published', RG, "  return Object.fromEntries(LITERAL_APPS.map(app => [app, 'literal' as const]))", '  return {}'],
  ['route-registers-enabled-field', R, '    registers: publishedRegisters(),\n    registersEnabled: registersEnabled(),', '    registers: publishedRegisters(),'],
  ['rules-registers-enabled-field', R, '    stylePairs,\n    registersEnabled: registersEnabled(),', '    stylePairs,'],
  ['rules-register-block-opt-in', R, "registerBlocks: styled && registersEnabled() && version === 'v4'", "registerBlocks: styled && version === 'v4'"],
  ['register-switch', RG, "  if (!registersEnabled(env) || typeof app !== 'string') return 'default'", "  if (typeof app !== 'string') return 'default'"],
  ['literal-words-equal', RG, '  if (a.length !== b.length || a.some((w, i) => w.lower !== b[i].lower)) return null', '  if (a.length !== b.length) return null'],
  ['literal-keeps-negations', RG, "const LITERAL_DROPPABLE = new Set(['um',", "const LITERAL_DROPPABLE = new Set(['not', 'um',"],
  ['literal-no-added-period', RG, "  if (/\\.\\s*$/.test(out) && !/\\.\\s*$/.test(input)) out = out.replace(/\\.(\\s*)$/, '$1')\n", ''],
  ['literal-input-casing', RG, '    out += answer.slice(last, w.start) + (forms ? forms[Math.min(k, forms.length - 1)] : answer.slice(w.start, w.end))', '    out += answer.slice(last, w.start) + answer.slice(w.start, w.end)'],
  // Learned style: validation, cap, switch, store.
  ['style-kinds-closed', LS, "    if (typeof kind !== 'string' || !(LEARNED_STYLE_KINDS as readonly string[]).includes(kind)) return", "    if (typeof kind !== 'string') return"],
  ['style-register-all-only', LS, "    if (typeof register !== 'string' || !(LEARNED_STYLE_REGISTERS as readonly string[]).includes(register)) {", "    if (typeof register !== 'string') {"],
  ['style-param-allowlist', LS, "    if (typeof param !== 'string' || !allowed.includes(param)) return", "    if (typeof param !== 'string') return"],
  ['style-id-pattern', LS, "    if (typeof id !== 'string' || !RULE_ID.test(id) || ids.has(id)) return", "    if (typeof id !== 'string' || ids.has(id)) return"],
  ['style-unknown-keys', LS, " || !Object.keys(rule).every(key => RULE_KEYS.has(key))) {", ') {'],
  ['style-count-integer', LS, "    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1_000_000) return", "    if (typeof n !== 'number') return"],
  ['style-last-seen-date', LS, "      if (typeof lastSeen !== 'string' || lastSeen.length > 40 || Number.isNaN(Date.parse(lastSeen))) {", "      if (typeof lastSeen !== 'string') {"],
  ['style-one-rule-per-meaning', LS, "    if (meanings.has(meaning)) return { ok: false, status: 400, error: meanings.get(meaning) === param ? 'duplicate_rule' : 'conflicting_rules', index }\n", ''],
  ['style-max-rules-413', LS, "  if (raw.length > LEARNED_STYLE_MAX_RULES) return { ok: false, status: 413, error: 'too_many_rules', max: LEARNED_STYLE_MAX_RULES }\n", ''],
  ['style-allowlist-no-like', LS, "  'honestly', 'literally', 'pretty much',", "  'honestly', 'literally', 'like', 'pretty much',"],
  ['style-switch', LS, '  return readSwitch(env.COS_DICTATION_LEARNED_STYLE, true)', '  return true'],
  ['style-person-switch', LS, "  if (!stored.enabled || register === 'literal' || !stored.rules.length) return ''", "  if (register === 'literal' || !stored.rules.length) return ''"],
  ['style-never-literal', LS, "  if (!stored.enabled || register === 'literal' || !stored.rules.length) return ''", "  if (!stored.enabled || !stored.rules.length) return ''"],
  ['style-template-drop', LS, '  if (rule.kind === \'drop_phrase\') return `Drop "${rule.param}" where the speaker used it as filler.`', '  if (rule.kind === \'drop_phrase\') return `Drop ${rule.param}.`'],
  ['style-read-revalidates', LS, '    const clean = validateLearnedStyleRules(parsed?.rules)', "    const clean = { ok: true as const, rules: (parsed?.rules ?? []) as LearnedStyleRule[] }"],
  ['style-file-private', LS, "{ mode: 0o600 })\n  return copy(stored)", "{ mode: 0o644 })\n  return copy(stored)"],
  ['style-reset-deletes', LS, '  if (!rules.length && enabled) {', '  if (false) {'],
  // Routes and capability.
  ['route-server-owned-400', R, "  if (owned) return res.status(400).json({ error: 'server_owned_field', field: owned })\n", ''],
  ['route-strict-keys', R, "  if (!keys.every(key => STYLE_PUT_KEYS.has(key)) || !('rules' in body || 'enabled' in body)) {", "  if (!('rules' in body || 'enabled' in body)) {"],
  ['route-base-hash-409', R, "  if (typeof body.baseHash === 'string' && body.baseHash !== current.hash) {", '  if (false) {'],
  ['route-enabled-alone-keeps-rules', R, '  let rules = current.rules\n', '  let rules: typeof current.rules = []\n'],
  ['route-registers-published', R, '    registers: publishedRegisters(),\n', '    registers: {},\n'],
  ['route-options-env-wins', O, "  if ((DICTATION_POLISH_PROMPT_VERSIONS as readonly string[]).includes(raw)) return { version: raw as DictationPolishPromptVersion, source: 'env' }", ''],
  ['route-options-v3-applies', O, "  if (readPolishOptions().promptVersion === 'v3') return { version: 'v3', source: 'option' }\n", ''],
  ['route-options-strict', R, "    || !(POLISH_PROMPT_OPTIONS as readonly string[]).includes(body.promptVersion)) {", ') {'],
  ['capability-enabled-is-switch', R, '  return { protocol: LEARNED_STYLE_PROTOCOL, maxChars: LEARNED_STYLE_MAX_CHARS, maxRules: LEARNED_STYLE_MAX_RULES, enabled: learnedStyleEnabled() }', '  return { protocol: LEARNED_STYLE_PROTOCOL, maxChars: LEARNED_STYLE_MAX_CHARS, maxRules: LEARNED_STYLE_MAX_RULES, enabled: true }'],
  // Prompt assembly.
  ['prompt-default-v4', O, "export const DEFAULT_DICTATION_POLISH_PROMPT: DictationPolishPromptVersion = 'v4'", "export const DEFAULT_DICTATION_POLISH_PROMPT: DictationPolishPromptVersion = 'v3'"],
  ['prompt-register-block-in', C, '    ...registerBlock(version, extras.register),\n', ''],
  ['prompt-register-v3-v4-only', C, "  return register === 'literal' && (version === 'v3' || version === 'v4') ? [...LITERAL_REGISTER_RULES, ''] : []", "  return register === 'literal' ? [...LITERAL_REGISTER_RULES, ''] : []"],
  ['prompt-style-block-in', C, '    ...(literal ? [] : learnedStyleBlock(extras.learnedStyle)),\n', ''],
  ['prompt-literal-excludes-style', C, '    ...(literal ? [] : learnedStyleBlock(extras.learnedStyle)),\n', '    ...learnedStyleBlock(extras.learnedStyle),\n'],
  ['prompt-style-after-preferences', C, '    ...userPreferencesBlock(customInstructions),\n    ...(literal ? [] : learnedStyleBlock(extras.learnedStyle)),\n', '    ...(literal ? [] : learnedStyleBlock(extras.learnedStyle)),\n    ...userPreferencesBlock(customInstructions),\n'],
  ['prompt-closing-v4-only', C, "    ...(version === 'v4' ? [literal ? V4_LITERAL_CLOSING_RULE : V4_CLOSING_RULE, ''] : []),", "    ...[literal ? V4_LITERAL_CLOSING_RULE : V4_CLOSING_RULE, ''],"],
  ['prompt-style-tags-stripped', C, "      .replace(PROMPT_TAG, '').replace(/^\\s*-\\s*/, '')", ".replace(/^\\s*-\\s*/, '')"],
  ['prompt-style-cap', C, '  if (!value || value.length > LEARNED_STYLE_MAX_CHARS) return []', '  if (!value) return []'],
  ['prompt-no-em-dash-rule', C, "  '- Add an em dash or an arrow unless the speaker said it.',\n", ''],
  ['prompt-never-mind-marker', C, '"make that", "scratch that", "never mind").', '"make that", "scratch that").'],
  ['instructions-strip-style-tag', I, '(?:user-style-preferences|learned-style|known-spellings|dictation)', '(?:user-style-preferences|known-spellings|dictation)'],
  ['warm-message-version', P, '  return wanted && DICTATION_POLISH_SYSTEM_PROMPTS[wanted] === DICTATION_POLISH_SYSTEM_PROMPTS[started] ? wanted : started', '  return started'],
  // Pipeline wiring.
  ['pipeline-meeting-v3', PL, "  return bucket === 'meeting' && version === 'v4' ? 'v3' : version", '  return version'],
  // 6.91.0 option C: v4 by default on Sonnet only; style and register only where canaried.
  ['option-c-sonnet-only', O, '  return model !== undefined && V4_DEFAULT_MODELS.includes(model) ? DEFAULT_DICTATION_POLISH_PROMPT : \'v3\'', '  return DEFAULT_DICTATION_POLISH_PROMPT'],
  ['option-c-model-passed', PL, '  const version = wanted ?? dictationPolishPromptVersion(process.env, model)', '  const version = wanted ?? dictationPolishPromptVersion(process.env)'],
  ['option-c-cold-model-default', C, '  const version = opts.promptVersion ?? dictationPolishPromptVersion(process.env, model)', '  const version = opts.promptVersion ?? dictationPolishPromptVersion(process.env)'],
  ['option-c-canaried-pair', O, "  return model === 'sonnet' && version === 'v4'", '  return true'],
  ['option-c-canaried-gates-style', PL, "  const style = canaried ? learnedStyleFor(opts.bucket, register) : { lines: '', hash: '' }", '  const style = learnedStyleFor(opts.bucket, register)'],
  ['option-c-canaried-gates-register', PL, "  const register: DictationRegister = canaried ? opts.register ?? 'default' : 'default'", "  const register: DictationRegister = opts.register ?? 'default'"],
  ['option-c-register-field-gated', PL, '    ...(canaried ? { polishRegister: register } : {}),\n    ...(promptVersion', '    { polishRegister: register },\n    ...(promptVersion'],
  ['polish-prompt-field', PL, "    ...(promptVersion === 'v3' || promptVersion === 'v4' ? { polishPrompt: promptVersion } : {}),", '    ...{},'],
  ['polish-prompt-closed-set', PL, "    ...(promptVersion === 'v3' || promptVersion === 'v4' ? { polishPrompt: promptVersion } : {}),", '    ...{ polishPrompt: promptVersion as PolishPrompt },'],
  ['route-polish-prompt-field', PD, '    ...(result.polishPrompt ? { polishPrompt: result.polishPrompt } : {}),\n', ''],
  ['rules-prompt-by-model', R, '    promptByModel,\n', ''],
  ['pipeline-meeting-no-style', PL, "  if (bucket === 'meeting' || !learnedStyleEnabled()) return { lines: '', hash: '' }", "  if (!learnedStyleEnabled()) return { lines: '', hash: '' }"],
  ['pipeline-meeting-no-guard', PL, "  if (bucket !== 'meeting') {\n    // 6.91.0: a terminal", "  if (true) {\n    // 6.91.0: a terminal"],
  ['pipeline-literal-check', PL, "    if (register === 'literal') {", '    if (false) {'],
  ['pipeline-guard-wired', PL, '    if (meaningGuardEnabled()) {', '    if (false) {'],
  ['pipeline-guard-says-failed', PL, "        return { text: cleaned, outcome: 'guarded', guard: problem.kind, polishSkipped: 'failed' }", "        return { text: cleaned, outcome: 'guarded', guard: problem.kind }"],
  ['pipeline-guard-sends-cleaned', PL, "        return { text: cleaned, outcome: 'guarded', guard: problem.kind, polishSkipped: 'failed' }", "        return { text: answer, outcome: 'guarded', guard: problem.kind, polishSkipped: 'failed' }"],
  ['pipeline-unchanged-outcome', PL, "  return { text: answer, outcome: answer !== cleaned ? 'polished' : 'unchanged' }", "  return { text: answer, outcome: 'polished' }"],
  ['pipeline-link-outcome', PL, "    return { text: cleaned, outcome: 'guarded', guard: 'link', polishSkipped: 'link_guard' }", "    return { text: cleaned, outcome: 'polished', polishSkipped: 'link_guard' }"],
  ['pipeline-style-to-model', PL, '  const promptExtras = { customInstructions, learnedStyle: style.lines, register, promptVersion }', "  const promptExtras = { customInstructions, learnedStyle: '', register, promptVersion }"],
  ['pipeline-style-hash-answer', PL, '    ...(style.lines ? { learnedStyle: true, learnedStyleHash: style.hash } : { learnedStyleOff: true }),', '    ...{ learnedStyleOff: true as const },'],
  ['pipeline-style-false-answer', PL, '    ...(style.lines ? { learnedStyle: true, learnedStyleHash: style.hash } : { learnedStyleOff: true }),', '    ...(style.lines ? { learnedStyle: true, learnedStyleHash: style.hash } : {}),'],
  ['pipeline-audit-codes', PL, "      polishOutcome: guarded.outcome, ...(guarded.guard ? { polishGuard: guarded.guard } : {}),\n", ''],
  ['route-register-from-context', PD, '    register: registerFromContext(req.body?.context),\n', ''],
  ['route-outcome-field', PD, '    ...(result.polishOutcome ? { polishOutcome: result.polishOutcome } : {}),\n', ''],
  ['route-guard-field', PD, '    ...(result.guard ? { guard: result.guard } : {}),\n', ''],
  ['route-register-field', PD, '    ...(result.polishRegister ? { polishRegister: result.polishRegister } : {}),\n', ''],
  ['route-style-field', PD, '    ...(result.learnedStyle ? { learnedStyle: true, learnedStyleHash: result.learnedStyleHash } : result.learnedStyleOff ? { learnedStyle: false } : {}),', '    ...(result.learnedStyleOff ? { learnedStyle: false } : {}),'],
  ['audit-row-codes', T, "    ...(entry.polishRegister ? { polish_register: entry.polishRegister } : {}),\n", ''],
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
const scratch = mkdtempSync(join(tmpdir(), 'dictation-voice-style-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
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
    const mutated = original.replace(find, () => replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    const result = run(), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(m => m[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { survived.push(name); console.log(`${name} SURVIVED${result.error ? ' (harness: ' + result.error.message + ')' : ''}`); continue }
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${selected.length - survived.length} of ${selected.length} voice-style mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
