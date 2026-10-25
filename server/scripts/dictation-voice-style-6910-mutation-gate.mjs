#!/usr/bin/env node
// 6.91.0 "dictation that learns your voice" mutation gate (plan r2 and the QA fix pass): the meaning
// guard, the register table and the literal check, the learned-style setting (validate, cap, switch,
// templates, revision, routes), the prompt order and blocks, the pipeline wiring and the capability.
// Mutations run only in a disposable copy of server/ and shared/, never in the live checkout.
//
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file, and the mutated file differs.
//   2. The mutated file still PARSES (esbuild). One that does not is INVALID, never a kill.
//   3. A KILL counts only when the test NAMED for that mutant fails (its 5th field, a substring of
//      exactly one test's "file > describe > test"). Anything else fails the gate on its own line:
//      SURVIVED (all green), MISATTRIBUTED (other tests failed, not the named one), INVALID, CRASHED
//      (no test report: a harness, import or build failure).
//   4. The file is restored byte for byte before the next mutant.
// Each mutant runs the named test's file only (its kill is that test failing); the baseline runs all.
// Usage: node server/scripts/dictation-voice-style-6910-mutation-gate.mjs [--list | --check | --discover] [name...]
//   --check     targets unique, and every named check names exactly one test (runs the baseline).
//   --discover  prints the tests each mutant fails (to pick a check): the mutated file's own suites
//               first (DISCOVER_FILES), every target file when those stay green.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { transformSync } from 'esbuild'

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
  ['guard-neg-not-folds', G, "if (t.low === 'not' || t.low === 'cannot' || /n't$/.test(t.low) || BARE_NT.has(t.low)) items.push", "if (t.low === 'not' || BARE_NT.has(t.low)) items.push", "negation: a dropped n't"],
  // 6.91.0 S2: "dont" and "cant" are the NEG token too.
  ['guard-bare-nt', G, "/n't$/.test(t.low) || BARE_NT.has(t.low)) items.push", "/n't$/.test(t.low)) items.push", "every apostrophe-less form is the same NEG token as the written one"],
  ['guard-neg-words', G, "      else if (NEG_WORDS.has(t.low)) items.push({ kind: 'negation', key: t.low, pos: i })\n", '', "negation: \"never merge\" becomes \"merge\""],
  ['guard-neg-marker-phrases-excluded', G, '    if (!negCover.has(i)) {', '    if (true) {', "never mind is a marker, not a negation"],
  ['guard-comma-no-is-marker', G, "    if (tokens[i].low === 'no' && i > 0 && tokens[i].pause && tokens[i + 1]?.pause) {", '    if (false) {', "b07 \", no,\" is a marker, not a negation"],
  ['guard-digits', G, "    if (/^\\d+$/.test(t.low)) {\n      let value", "    if (false) {\n      let value", "number: digits"],
  // 6.91.0 S2: a digit and a scale word are one number ("$2 million"), and the scale word is consumed.
  ['guard-digit-scale-multiplies', G, "      while (SCALES.has(tokens[i + 1]?.low ?? '')) { value *= SCALES.get(tokens[i + 1].low)!; i++ }\n", '', "a digit and a scale word (2 million dollars)"],
  ['guard-digit-scale-consumed', G, "{ value *= SCALES.get(tokens[i + 1].low)!; i++ }", "{ value *= SCALES.get(tokens[i + 1].low)!; break }", "a digit and a scale word (2 million dollars)"],
  ['guard-digits-in-words', G, "    if (/\\p{L}/u.test(t.low) && /\\d/.test(t.low)) {", '    if (false) {', "a dictionary term with digits (the digits count first)"],
  ['guard-number-words', G, '    const run = numberRun(tokens, i)\n    if (run) {', '    const run = numberRun(tokens, i)\n    if (false) {', "number: a spoken number changed"],
  ['guard-tens-split', G, "      if (last === 'ones' || last === 'tens') break", "      if (last === 'tens') break", "a spoken time"],
  ['guard-scale-multiplies', G, '      else { total += (group || 1) * s; group = 0 }', '      else { total += s; group = 0 }', "k for thousand"],
  // 6.91.0 S2: an ordinal ends a spoken number ("twenty fifth" is 25), after tens or a scale word.
  ['guard-ordinal-ends-run', G, '    if (ORDINALS.has(w)) {\n      const v = ORDINALS.get(w)!', '    if (false) {\n      const v = ORDINALS.get(w)!', "a compound ordinal (October 25th)"],
  ['guard-ordinal-after-scale', G, "      if (!((last === 'tens' && v < 10) || last === 'scale')) break", "      if (!(last === 'tens' && v < 10)) break", "an ordinal after a scale word"],
  ['guard-ordinal-after-and', G, '(ONES.has(next) || TENS.has(next) || ORDINALS.has(next))) continue', '(ONES.has(next) || TENS.has(next))) continue', "an ordinal after a scale word"],
  ['guard-teen-ordinals', G, "['thirteenth', 13], ", '', "a teen ordinal"],
  ['guard-ordinals', G, "    if (ORDINALS.has(t.low)) { items.push({ kind: 'number', key: String(ORDINALS.get(t.low)), pos: i }); continue }\n", '', "number: an ordinal"],
  ['guard-unit-words', G, "    if (NUMBER_WORDS.has(t.low)) { items.push({ kind: 'number', key: NUMBER_WORDS.get(t.low)!, pos: i }); continue }\n", '', "an amount in words and symbols"],
  ['guard-symbols', G, "    if (SYMBOLS.has(t.raw)) { items.push({ kind: 'number', key: SYMBOLS.get(t.raw)!, pos: i }); continue }\n", '', "an amount in words and symbols"],
  ['guard-am-pm', G, "      items.push({ kind: 'number', key: t.low, pos: i }); continue\n", '      continue\n', "number: am and pm"],
  ['guard-oclock-is-time', G, "    .replace(/\\s?o'?clock\\b/gi, ':00')\n", '', "a time with o'clock"],
  ['guard-thousands-separator', G, "    .replace(/(\\d),(?=\\d{3}\\b)/g, '$1')\n", '', "thousands separators"],
  ['guard-dates', G, "    if (date && (!DATE_NEEDS_CAPITAL.has(t.low) || /^\\p{Lu}/u.test(t.raw))) {", '    if (false) {', "date: a weekday"],
  ['guard-may-needs-capital', G, "    if (date && (!DATE_NEEDS_CAPITAL.has(t.low) || /^\\p{Lu}/u.test(t.raw))) {", '    if (date) {', "\"may\" the verb is not a date"],
  ['guard-names-mid-sentence', G, "      if (!t.sentenceStart || midCapital.has(fold(t.low))) items.push({ kind: 'name', key: fold(t.low), pos: i })", '      if (false) items.push({ kind: \'name\', key: fold(t.low), pos: i })', "name: a mid-sentence capital"],
  ['guard-sentence-start-not-name', G, "      if (!t.sentenceStart || midCapital.has(fold(t.low))) items.push", '      if (true) items.push', "sentence-initial capitals are not names"],
  // A lone "I" is already excluded by the two-letter floor; the contractions are what NOT_NAMES adds.
  ['guard-i-forms-not-names', G, "const NOT_NAMES = new Set(['i', \"i'm\", \"i'll\", ", "const NOT_NAMES = new Set(['i', ", "\"I'm\" and \"I'll\" are not names"],
  ['guard-dictionary-names', G, "        if (phrase.every((w, k) => fold(tokens[i + k].low) === w)) items.push({ kind: 'name', key: phrase.join(' '), pos: i })", '        if (false) items.push({ kind: \'name\', key: phrase.join(\' \'), pos: i })', "name: a dictionary term in lowercase"],
  ['guard-english-skips-names', G, '  const withNames = looksEnglish(cleaned)', '  const withNames = true', "a dictation that is not English skips the name check, never the others"],
  ['guard-short-text-is-english', G, '  if (words.length < 12) return true', '  if (words.length < 2) return true', "a dictation that is not English skips the name check, never the others"],
  // Meaning guard: comparison and exemptions.
  ['guard-joined-numbers', G, '    if (parts && !inKeys.get(\'number\')!.has(key)) { parts.forEach(p => keptByJoin.add(p)); joinedOut.add(key) }', '    if (false) { parts!.forEach(p => keptByJoin.add(p)); joinedOut.add(key) }', "a year spoken in pairs"],
  ['guard-name-joined-word', G, '    if (outWords.some(w => outJoined.has(w) && w.includes(flat))) return true\n', '', "a name joined into one word"],
  ['guard-name-fold-both-sides', G, '    if (outWords.includes(fold(flat))) return true', '    if (outWords.includes(flat)) return true', "a dictionary phrase joined into a domain"],
  ['guard-name-dictionary-respell', G, '      if (knownFlat.includes(w)) return levenshtein(flat, w) <= Math.max(2, Math.floor(flat.length / 2))\n', '', "a name re-spelled to the dictionary"],
  ['guard-name-near-respell', G, '      return /\\p{Lu}/u.test(t.raw) && levenshtein(flat, w) <= Math.max(1, Math.floor(flat.length / 4))', '      return false', "a near re-spelling of a mis-heard name"],
  ['guard-respell-not-a-heard-word', G, '      if (inTokenSet.has(w)) return false\n', '', "name: dropped beside a similar name"],
  ['guard-negation-never-exempt', G, "    if (item.kind === 'negation') return false\n", '', "a negation is never excused by a correction"],
  ['guard-exempt-needs-marker-after', G, '      if (start <= item.pos || start - item.pos > DROP_TO_MARKER) continue', '      if (start - item.pos > DROP_TO_MARKER) continue', "the marker must come after the dropped token, and the replacement must survive"],
  ['guard-exempt-needs-same-kind', G, '      const replaced = input.items.some(r => r.kind === item.kind && r.key !== item.key', '      const replaced = input.items.some(r => r.key !== item.key', "a correction excuses only a same-kind replacement the answer kept"],
  ['guard-exempt-replacement-kept', G, "        && (r.kind === 'name' ? nameKept(r.key) : outKeys.get(r.kind)!.has(r.key)))", '        )', "the marker must come after the dropped token, and the replacement must survive"],
  ['guard-exemptions-at-all', G, '    if (occurrences.every(exempt)) continue\n', '', "\"five, actually six\" keeps only six"],
  ['guard-drops-counted', G, '    dropped[item.kind]++\n', '', "number: digits"],
  ['guard-added-negation', G, "    for (const key of outKeys.get('negation')!) if (!inKeys.get('negation')!.has(key)) added.negation++\n", '', "with a correction marker, negations are compared as sets (a correction may drop a repeat)"],
  ['guard-added-number', G, "  for (const key of outNumbers) if (!inKeys.get('number')!.has(key) && !joinedOut.has(key) && !listOnly.has(key)) added.number++\n", '', "symmetric: a negation or number the speaker never said trips it too"],
  // 6.91.0 S3: with no marker, negations are counted (a stutter once); with one, compared as sets.
  ['guard-negation-counts', G, '  const countNegations = spans.length === 0', '  const countNegations = false', "with no correction marker, negations are counted: losing one of two trips"],
  ['guard-negation-count-dropped', G, "    for (const [key, n] of inCounts) if ((outCounts.get(key) ?? 0) < n) dropped.negation += n - (outCounts.get(key) ?? 0)\n", '', "with no correction marker, negations are counted: losing one of two trips"],
  ['guard-negation-count-added', G, "    for (const [key, n] of outCounts) if ((inCounts.get(key) ?? 0) < n) added.negation += n - (inCounts.get(key) ?? 0)\n", '', "with no correction marker, negations are counted: losing one of two trips"],
  ['guard-negation-counts-skip-sets', G, "    if (item.kind === 'negation' && countNegations) continue\n", '', "counts only, never a word"],
  ['guard-stutter-counts-once', G, '    if (!(previous && previous.key === item.key && item.pos === previous.pos + 1)) counts.set', '    if (true) counts.set', "a stutter (the same negation twice in a row) counts once"],
  ['guard-counts-only-without-markers', G, '  const countNegations = spans.length === 0', '  const countNegations = true', "with a correction marker, negations are compared as sets (a correction may drop a repeat)"],
  // 6.91.0 S3: bare "wait" is a verb; bare "actually" needs a guarded word within 3.
  ['guard-bare-wait-not-marker', G, '      if (bare && phrase[0] === BARE_WAIT) continue\n', '', "a bare \"wait\" is an ordinary verb and excuses nothing; set off by punctuation it is a marker"],
  ['guard-bare-needs-no-punctuation', G, '        && !tokens[i].pause && !tokens[i + 1]?.pause\n', '\n', "a bare \"wait\" is an ordinary verb and excuses nothing; set off by punctuation it is a marker"],
  ['guard-bare-actually-reach', G, 'reach: bare ? BARE_MARKER_TO_REPLACEMENT : MARKER_TO_REPLACEMENT, bare })', 'reach: MARKER_TO_REPLACEMENT, bare })', "a bare \"actually\" excuses a drop only with the replacement within 3 words"],
  ['guard-bare-actually-needs-guarded-word', G, "    .filter(span => !span.bare || input.items.some(r => r.kind !== 'negation' && r.pos > span.end && r.pos - span.end <= span.reach))\n", '\n', "\"I actually think\" is an adverb, not a marker, so negations are still counted"],
  // 6.91.0 S9: a list the speaker asked for, and spoken clock times.
  ['guard-list-asked', G, '  if (LIST_ASKED.test(cleaned)) {', '  if (false) {', "a numbered list the speaker asked for: its line-start numbers are not added numbers"],
  ['guard-list-any-list', G, '  if (LIST_ASKED.test(cleaned)) {', '  if (true) {', "without a list ask, or anywhere but a line start, a new number still trips"],
  ['guard-list-line-start-only', G, "const listMarker = /^\\d+$/.test(m[0]) && /(?:^|\\n)[ \\t]*$/.test(text.slice(0, m.index)) && ", "const listMarker = /^\\d+$/.test(m[0]) && ", "without a list ask, or anywhere but a line start, a new number still trips"],
  ['guard-list-only-every', G, '.every(i => i.list)) listOnly.add(key)', '.some(i => i.list)) listOnly.add(key)', "without a list ask, or anywhere but a line start, a new number still trips"],
  ['guard-spoken-times', G, '  return spokenTimes(text)\n', '  return text\n', "spoken clock times match their digits"],
  ['guard-half-past', G, "    .replace(HALF_PAST, (all, h: string) => { const hour = hourOf(h); return hour === null ? all : `${hour}:30` })\n", '', "spoken clock times match their digits"],
  ['guard-quarter-past', G, "    .replace(QUARTER_PAST, (all, h: string) => { const hour = hourOf(h); return hour === null ? all : `${hour}:15` })\n", '', "spoken clock times match their digits"],
  ['guard-quarter-to-subtracts', G, '`${hour === 1 ? 12 : hour - 1}:45`', '`${hour}:45`', "spoken clock times match their digits"],
  ['guard-quarter-to-one-wraps', G, '`${hour === 1 ? 12 : hour - 1}:45`', '`${hour - 1}:45`', "spoken clock times match their digits"],
  ['guard-switch', G, "  return !(raw === '0' || raw === 'false' || raw === 'off')", '  return true', "COS_DICTATION_MEANING_GUARD: on unless 0, false or off"],
  // Registers and the literal check.
  ['register-literal-table', RG, "export const LITERAL_APPS: readonly string[] = ['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'WezTerm', 'Alacritty', 'kitty']", "export const LITERAL_APPS: readonly string[] = ['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'WezTerm', 'Alacritty', 'kitty', 'Claude']", "is exactly the seven terminals, and with registers on every one of them is literal"],
  ['register-case-insensitive', RG, "  return LITERAL.has(app.trim().toLowerCase()) ? 'literal' : 'default'", "  return LITERAL.has(app.trim()) ? 'literal' : 'default'", "is exactly the seven terminals, and with registers on every one of them is literal"],
  ['register-trims', RG, "  return LITERAL.has(app.trim().toLowerCase()) ? 'literal' : 'default'", "  return LITERAL.has(app.toLowerCase()) ? 'literal' : 'default'", "matches the exact name, ignoring case and surrounding space"],
  ['register-context-app', RG, '  return registerForApp((context as { app?: unknown } | null | undefined)?.app, env)', "  return registerForApp(undefined, env)", "reads context.app without trusting the shape of context"],
  // 6.91.0: the literal register is opt-in (terminal targets are mostly AI prompts in prose).
  ['registers-default-off', RG, '  return readSwitch(env.COS_DICTATION_REGISTERS, false)', '  return readSwitch(env.COS_DICTATION_REGISTERS, true)', "off by default: every terminal is default unless COS_DICTATION_REGISTERS is 1, true or on"],
  ['registers-map-published', RG, "  return Object.fromEntries(LITERAL_APPS.map(app => [app, 'literal' as const]))", '  return {}', "the map is published whether or not it applies"],
  ['route-registers-enabled-field', R, '    registers: publishedRegisters(),\n    registersEnabled: registersEnabled(),', '    registers: publishedRegisters(),', "GET is empty and on by default, and publishes kinds, the allowlist and the register map"],
  ['rules-registers-enabled-field', R, '    stylePairs,\n    registersEnabled: registersEnabled(),', '    stylePairs,', "shows the rules in use (v4 by default), the system prompt, and every block as the model sees it"],
  ['rules-register-block-opt-in', R, "registerBlocks: styled && registersEnabled() && version === 'v4'", "registerBlocks: styled && version === 'v4'", "shows the rules in use (v4 by default), the system prompt, and every block as the model sees it"],
  ['register-switch', RG, "  if (!registersEnabled(env) || typeof app !== 'string') return 'default'", "  if (typeof app !== 'string') return 'default'", "off by default: every terminal is default unless COS_DICTATION_REGISTERS is 1, true or on"],
  ['literal-words-equal', RG, '  if (a.length !== b.length || a.some((w, i) => w.lower !== b[i].lower)) return null', '  if (a.length !== b.length) return null', "refuses a swapped word of the same count"],
  ['literal-keeps-negations', RG, "const LITERAL_DROPPABLE = new Set(['um',", "const LITERAL_DROPPABLE = new Set(['not', 'um',", "never drops a negation or number as if it were a filler"],
  ['literal-no-added-period', RG, "  if (/\\.\\s*$/.test(out) && !/\\.\\s*$/.test(input)) out = out.replace(/\\.(\\s*)$/, '$1')\n", '', "keeps the answer when only punctuation, case, fillers and stutters changed, with the input casing put back"],
  ['literal-input-casing', RG, '    out += answer.slice(last, w.start) + (forms ? forms[Math.min(k, forms.length - 1)] : answer.slice(w.start, w.end))', '    out += answer.slice(last, w.start) + answer.slice(w.start, w.end)', "keeps the answer when only punctuation, case, fillers and stutters changed, with the input casing put back"],
  // Learned style: validation, cap, switch, store.
  ['style-kinds-closed', LS, "    if (typeof kind !== 'string' || !(LEARNED_STYLE_KINDS as readonly string[]).includes(kind)) return", "    if (typeof kind !== 'string') return", "refuses an unknown kind (400)"],
  ['style-register-all-only', LS, "    if (typeof register !== 'string' || !(LEARNED_STYLE_REGISTERS as readonly string[]).includes(register)) {", "    if (typeof register !== 'string') {", "refuses a register other than all (400)"],
  ['style-param-allowlist', LS, "    if (typeof param !== 'string' || !allowed.includes(param)) return", "    if (typeof param !== 'string') return", "refuses a phrase off the allowlist (400)"],
  ['style-id-pattern', LS, "    if (typeof id !== 'string' || !RULE_ID.test(id) || ids.has(id)) return", "    if (typeof id !== 'string' || ids.has(id)) return", "refuses a bad id (400)"],
  ['style-unknown-keys', LS, " || !Object.keys(rule).every(key => RULE_KEYS.has(key))) {", ') {', "refuses an unknown key (text is the server's) (400)"],
  ['style-count-integer', LS, "    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1_000_000) return", "    if (typeof n !== 'number') return", "refuses a negative count (400)"],
  ['style-last-seen-date', LS, "      if (typeof lastSeen !== 'string' || lastSeen.length > 40 || Number.isNaN(Date.parse(lastSeen))) {", "      if (typeof lastSeen !== 'string') {", "refuses an unreadable lastSeen (400)"],
  ['style-one-rule-per-meaning', LS, "    if (meanings.has(meaning)) return { ok: false, status: 400, error: meanings.get(meaning) === param ? 'duplicate_rule' : 'conflicting_rules', index }\n", '', "refuses the same phrase twice (400)"],
  ['style-max-rules-413', LS, "  if (raw.length > LEARNED_STYLE_MAX_RULES) return { ok: false, status: 413, error: 'too_many_rules', max: LEARNED_STYLE_MAX_RULES }\n", '', "over 20 rules is 413, never truncated"],
  ['style-allowlist-no-like', LS, "  'honestly', 'literally', 'pretty much',", "  'honestly', 'literally', 'like', 'pretty much',", "refuses a phrase off the allowlist (400)"],
  ['style-switch', LS, '  return readSwitch(env.COS_DICTATION_LEARNED_STYLE, true)', '  return true', "COS_DICTATION_LEARNED_STYLE: on unless 0, false or off"],
  ['style-person-switch', LS, "  if (!stored.enabled || register === 'literal' || !stored.rules.length) return ''", "  if (register === 'literal' || !stored.rules.length) return ''", "enabled:false keeps the rules and stops them applying"],
  ['style-never-literal', LS, "  if (!stored.enabled || register === 'literal' || !stored.rules.length) return ''", "  if (!stored.enabled || !stored.rules.length) return ''", "a literal target never gets learned style"],
  ['style-template-drop', LS, '  if (rule.kind === \'drop_phrase\') return `Drop "${rule.param}" where the speaker used it as filler.`', '  if (rule.kind === \'drop_phrase\') return `Drop ${rule.param}.`', "renders each kind from its template, never from client text"],
  ['style-read-revalidates', LS, '    const clean = validateLearnedStyleRules(parsed?.rules)', "    const clean = { ok: true as const, rules: (parsed?.rules ?? []) as LearnedStyleRule[] }", "a hand-edited file is validated again on read; a bad one reads as empty and logs a code, never the contents"],
  ['style-file-private', LS, "{ mode: 0o600 })\n  return copy(stored)", "{ mode: 0o644 })\n  return copy(stored)", "saves 0600, reads back with its hash, and Reset deletes the file"],
  ['style-reset-deletes', LS, '  if (!rules.length && enabled) {', '  if (false) {', "saves 0600, reads back with its hash, and Reset deletes the file"],
  // Routes and capability.
  ['route-server-owned-400', R, "  if (owned) return res.status(400).json({ error: 'server_owned_field', field: owned })\n", '', "server-owned fields are 400; unknown keys are 400; a bad rule is 400 with its index"],
  ['route-strict-keys', R, "  if (!keys.every(key => STYLE_PUT_KEYS.has(key)) || !('rules' in body || 'enabled' in body)) {", "  if (!('rules' in body || 'enabled' in body)) {", "server-owned fields are 400; unknown keys are 400; a bad rule is 400 with its index"],
  // 6.91.0 S4: the conditional PUT is on `revision`, which covers the rules and the switch.
  ['route-base-revision-409', R, "  if (typeof body.baseRevision === 'string' && body.baseRevision !== current.revision) {", '  if (false) {', "S4: baseRevision: a match saves, a stale one is 409 with the current revision, and a stale \"on\" cannot undo a newer Off"],
  ['route-base-revision-format', R, "!/^[0-9a-f]{8}$/.test(body.baseRevision)", "!/^(?:[0-9a-f]{8})?$/.test(body.baseRevision)", "server-owned fields are 400; unknown keys are 400; a bad rule is 400 with its index"],
  ['route-revision-in-view', R, '    revision: stored.revision,\n', '', "S4: revision covers the rules AND the switch; hash stays the text alone"],
  ['route-revision-server-owned', R, "const SERVER_OWNED = new Set(['text', 'hash', 'revision', 'updatedAt'])", "const SERVER_OWNED = new Set(['text', 'hash', 'updatedAt'])", "server-owned fields are 400; unknown keys are 400; a bad rule is 400 with its index"],
  ['route-base-hash-gone', R, "const STYLE_PUT_KEYS = new Set(['enabled', 'rules', 'baseRevision'])", "const STYLE_PUT_KEYS = new Set(['enabled', 'rules', 'baseRevision', 'baseHash'])", "server-owned fields are 400; unknown keys are 400; a bad rule is 400 with its index"],
  ['style-revision-covers-switch', LS, "update(`${enabled ? 'on' : 'off'}\\n${text}`, 'utf8')", "update(text, 'utf8')", "S4: the revision is 8 hex of the text and the switch, so Off is a new revision with the same hash"],
  // 6.91.0 S5: Reset keeps the switch; an Off with no rules is kept as a file.
  ['route-delete-keeps-switch', R, '    res.json(styleView(writeLearnedStyle(readLearnedStyle().enabled, [])))', '    res.json(styleView(writeLearnedStyle(true, [])))', "S5: Reset clears the rules and keeps the switch as it was: an Off stays off"],
  ['style-off-empty-kept', LS, '  if (!rules.length && enabled) {', '  if (!rules.length) {', "S5: Reset clears the rules and keeps the switch as it was: an Off stays off"],
  // 6.91.0 S12: each 500 path logs one line, a code only.
  ['route-500-logs-put', R, "    console.warn(`[dictation-polish] learned_style_not_saved put (${errorCode(err)})`)\n", '', "S12: a save that fails is 500 and logs one line with a code only, never the path or a rule"],
  ['route-500-logs-delete', R, "    console.warn(`[dictation-polish] learned_style_not_saved delete (${errorCode(err)})`)\n", '', "S12: a save that fails is 500 and logs one line with a code only, never the path or a rule"],
  ['route-500-logs-options', R, "    console.warn(`[dictation-polish] options_not_saved (${errorCode(err)})`)\n", '', "S12: a save that fails is 500 and logs one line with a code only, never the path or a rule"],
  ['route-500-code-only', R, "  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,23}$/.test(code) ? code : 'error'", '  return String((err as { message?: unknown } | null)?.message ?? err)', "S12: a save that fails is 500 and logs one line with a code only, never the path or a rule"],
  ['route-enabled-alone-keeps-rules', R, '  let rules = current.rules\n', '  let rules: typeof current.rules = []\n', "enabled:false keeps the rules; enabled alone toggles without resending them"],
  ['route-registers-published', R, '    registers: publishedRegisters(),\n', '    registers: {},\n', "GET is empty and on by default, and publishes kinds, the allowlist and the register map"],
  ['route-options-env-wins', O, "  if ((DICTATION_POLISH_PROMPT_VERSIONS as readonly string[]).includes(raw)) return { version: raw as DictationPolishPromptVersion, source: 'env' }", '', "says v2 and rolled back under COS_DICTATION_POLISH_PROMPT=v2; v3 keeps the literal block and has no closing line"],
  ['route-options-v3-applies', O, "  if (readPolishOptions().promptVersion === 'v3') return { version: 'v3', source: 'option' }\n", '', "default is v4; PUT v3 rolls the prompt back; PUT default restores it and deletes the file"],
  ['route-options-strict', R, "    || !(POLISH_PROMPT_OPTIONS as readonly string[]).includes(body.promptVersion)) {", ') {', "anything but {promptVersion: \"default\" | \"v3\"} is 400"],
  ['capability-enabled-is-switch', R, '  return { protocol: LEARNED_STYLE_PROTOCOL, maxChars: LEARNED_STYLE_MAX_CHARS, maxRules: LEARNED_STYLE_MAX_RULES, enabled: learnedStyleEnabled() }', '  return { protocol: LEARNED_STYLE_PROTOCOL, maxChars: LEARNED_STYLE_MAX_CHARS, maxRules: LEARNED_STYLE_MAX_RULES, enabled: true }', "COS_DICTATION_LEARNED_STYLE=0: the routes still answer and say so; the capability says enabled false"],
  // Prompt assembly.
  ['prompt-default-v4', O, "export const DEFAULT_DICTATION_POLISH_PROMPT: DictationPolishPromptVersion = 'v4'", "export const DEFAULT_DICTATION_POLISH_PROMPT: DictationPolishPromptVersion = 'v3'", "shows the rules in use (v4 by default), the system prompt, and every block as the model sees it"],
  ['prompt-register-block-in', C, '    ...registerBlock(version, extras.register),\n', '', "every golden case is byte-identical to the 6.91.0 fixture: plain, literal, and with instructions and a learned style"],
  ['prompt-register-v3-v4-only', C, "  return register === 'literal' && (version === 'v3' || version === 'v4') ? [...LITERAL_REGISTER_RULES, ''] : []", "  return register === 'literal' ? [...LITERAL_REGISTER_RULES, ''] : []", "v1 to v3 with no extras stay byte-identical to 6.83.1 and 6.90.0, and ignore a register they do not know"],
  ['prompt-style-block-in', C, '    ...(literal ? [] : learnedStyleBlock(extras.learnedStyle)),\n', '', "every golden case is byte-identical to the 6.91.0 fixture: plain, literal, and with instructions and a learned style"],
  ['prompt-literal-excludes-style', C, '    ...(literal ? [] : learnedStyleBlock(extras.learnedStyle)),\n', '    ...learnedStyleBlock(extras.learnedStyle),\n', "rules, then the literal block, then the user preferences, then (v4) the closing line, then spellings, then the dictation"],
  ['prompt-style-after-preferences', C, '    ...userPreferencesBlock(customInstructions),\n    ...(literal ? [] : learnedStyleBlock(extras.learnedStyle)),\n', '    ...(literal ? [] : learnedStyleBlock(extras.learnedStyle)),\n    ...userPreferencesBlock(customInstructions),\n', "every golden case is byte-identical to the 6.91.0 fixture: plain, literal, and with instructions and a learned style"],
  ['prompt-closing-v4-only', C, "    ...(version === 'v4' ? [literal ? V4_LITERAL_CLOSING_RULE : V4_CLOSING_RULE, ''] : []),", "    ...[literal ? V4_LITERAL_CLOSING_RULE : V4_CLOSING_RULE, ''],", "v1 to v3 with no extras stay byte-identical to 6.83.1 and 6.90.0, and ignore a register they do not know"],
  ['prompt-style-tags-stripped', C, "      .replace(PROMPT_TAG, '').replace(/^\\s*-\\s*/, '')", ".replace(/^\\s*-\\s*/, '')", "the learned-style block is sanitized again: prompt tags, controls and invisible characters never reach the prompt; over the cap is off"],
  ['prompt-style-cap', C, '  if (!value || value.length > LEARNED_STYLE_MAX_CHARS) return []', '  if (!value) return []', "the learned-style block is sanitized again: prompt tags, controls and invisible characters never reach the prompt; over the cap is off"],
  ['prompt-no-em-dash-rule', C, "  '- Add an em dash or an arrow unless the speaker said it.',\n", '', "every golden case is byte-identical to the 6.91.0 fixture: plain, literal, and with instructions and a learned style"],
  ['prompt-never-mind-marker', C, '"make that", "scratch that", "never mind").', '"make that", "scratch that").', "every golden case is byte-identical to the 6.91.0 fixture: plain, literal, and with instructions and a learned style"],
  ['instructions-strip-style-tag', I, '(?:user-style-preferences|learned-style|known-spellings|dictation)', '(?:user-style-preferences|known-spellings|dictation)', "the user instructions cannot open or close a learned-style block (the tag is stripped in both sanitizers)"],
  ['warm-message-version', P, '  return wanted && DICTATION_POLISH_SYSTEM_PROMPTS[wanted] === DICTATION_POLISH_SYSTEM_PROMPTS[started] ? wanted : started', '  return started', "6.91.0: a message may use another version only when the system prompts match (meeting lines take v3 on a v4 process)"],
  // Pipeline wiring.
  ['pipeline-meeting-v3', PL, "  return bucket === 'meeting' && version === 'v4' ? 'v3' : version", '  return version', "meeting lines get the v3 prompt with no blocks, even with a style saved and v4 configured"],
  // 6.91.0 option C: v4 by default on Sonnet only; style and register only where canaried.
  ['option-c-sonnet-only', O, '  return model !== undefined && V4_DEFAULT_MODELS.includes(model) ? DEFAULT_DICTATION_POLISH_PROMPT : \'v3\'', '  return DEFAULT_DICTATION_POLISH_PROMPT', "shows the rules in use (v4 by default), the system prompt, and every block as the model sees it"],
  ['option-c-model-passed', PL, '  const version = wanted ?? dictationPolishPromptVersion(process.env, model)', '  const version = wanted ?? dictationPolishPromptVersion(process.env)', "C6 golden (option C): a Haiku dictation outside a terminal with no learned style gets the 6.90.0 prompt byte for byte; so does Luna, and so does Haiku in a terminal with rules saved"],
  ['option-c-cold-model-default', C, '  const version = opts.promptVersion ?? dictationPolishPromptVersion(process.env, model)', '  const version = opts.promptVersion ?? dictationPolishPromptVersion(process.env)', "6.91.0: v4 is the default prompt; v3, v2 and v1 restore earlier prompts byte for byte"],
  ['option-c-canaried-pair', O, "  return model === 'sonnet' && version === 'v4'", '  return true', "shows the rules in use (v4 by default), the system prompt, and every block as the model sees it"],
  ['option-c-canaried-gates-style', PL, "  const style = canaried ? learnedStyleFor(opts.bucket, register) : { lines: '', hash: '' }", '  const style = learnedStyleFor(opts.bucket, register)', "C6 golden (option C): a Haiku dictation outside a terminal with no learned style gets the 6.90.0 prompt byte for byte; so does Luna, and so does Haiku in a terminal with rules saved"],
  ['option-c-canaried-gates-register', PL, "  const register: DictationRegister = canaried ? opts.register ?? 'default' : 'default'", "  const register: DictationRegister = opts.register ?? 'default'", "C6 golden (option C): a Haiku dictation outside a terminal with no learned style gets the 6.90.0 prompt byte for byte; so does Luna, and so does Haiku in a terminal with rules saved"],
  ['option-c-register-field-gated', PL, '    ...(canaried ? { polishRegister: register } : {}),\n    ...(promptVersion', '    ...{ polishRegister: register },\n    ...(promptVersion', "6.91.0 option C: Haiku, Luna and an unnamed model run v3 with no register and no learned style, even in a terminal with rules saved"],
  ['polish-prompt-field', PL, "    ...(promptVersion === 'v3' || promptVersion === 'v4' ? { polishPrompt: promptVersion } : {}),", '    ...{},', "6.91.0 option C: Haiku, Luna and an unnamed model run v3 with no register and no learned style, even in a terminal with rules saved"],
  ['polish-prompt-closed-set', PL, "    ...(promptVersion === 'v3' || promptVersion === 'v4' ? { polishPrompt: promptVersion } : {}),", '    ...{ polishPrompt: promptVersion as PolishPrompt },', "6.91.0 option C: the environment and Previous polish override every model; Sonnet on v3 gets no style or register"],
  ['route-polish-prompt-field', PD, '    ...(result.polishPrompt ? { polishPrompt: result.polishPrompt } : {}),\n', '', "6.91.0 option C: Haiku, Luna and an unnamed model run v3 with no register and no learned style, even in a terminal with rules saved"],
  ['rules-prompt-by-model', R, '    promptByModel,\n', '', "shows the rules in use (v4 by default), the system prompt, and every block as the model sees it"],
  ['pipeline-meeting-no-style', PL, "  if (bucket === 'meeting' || !learnedStyleEnabled()) return { lines: '', hash: '' }", "  if (!learnedStyleEnabled()) return { lines: '', hash: '' }", "learnedStyleFor never gives meeting lines the style, even with rules saved and on"],
  ['pipeline-meeting-no-guard', PL, "  if (canaried && bucket !== 'meeting') {\n    // 6.91.0: a terminal", "  if (canaried) {\n    // 6.91.0: a terminal", "guardPolishAnswer never guards a meeting line, even when called as the canaried pair"],
  // 6.91.0 S1: the literal check and the meaning guard only on the canaried pair.
  ['pipeline-guard-canaried-only', PL, "  if (canaried && bucket !== 'meeting') {\n    // 6.91.0: a terminal", "  if (bucket !== 'meeting') {\n    // 6.91.0: a terminal", "6.91.0 S1: the meaning guard runs only where v4 runs on Sonnet; every other pair gets 6.90.0's answer"],
  ['pipeline-guard-gets-canaried', PL, '    const guarded = guardPolishAnswer(cleaned, polished, opts.bucket, register, canaried)', '    const guarded = guardPolishAnswer(cleaned, polished, opts.bucket, register, true)', "6.91.0 S1: the meaning guard runs only where v4 runs on Sonnet; every other pair gets 6.90.0's answer"],
  // 6.91.0 S6: an empty answer is a failed polish.
  ['pipeline-empty-is-failed', PL, "    if (!polished) throw new Error('Auto-clean returned empty text')\n", '', "6.91.0 S6: an empty model answer is a failed polish, never \"unchanged\""],
  // 6.91.0 S11: each server switch on its own.
  ['pipeline-style-switch', PL, "  if (bucket === 'meeting' || !learnedStyleEnabled()) return { lines: '', hash: '' }", "  if (bucket === 'meeting') return { lines: '', hash: '' }", "COS_DICTATION_LEARNED_STYLE=0 alone: rules saved and on, yet no style block and learnedStyle false"],
  ['pipeline-guard-switch', PL, '    if (meaningGuardEnabled()) {', '    if (true) {', "COS_DICTATION_MEANING_GUARD=0 alone: the answer that lost a negation goes out"],
  ['registers-switch-read', RG, '  return readSwitch(env.COS_DICTATION_REGISTERS, false)', '  return false', "COS_DICTATION_REGISTERS=1 alone: a terminal gets the literal register (and no style); unset, the default one with the style"],
  ['pipeline-literal-check', PL, "    if (register === 'literal') {", '    if (false) {', "6.91.0: with COS_DICTATION_REGISTERS=1 a terminal is literal; the model gets the register, the answer gets the input casing and no added period"],
  ['pipeline-guard-wired', PL, '    if (meaningGuardEnabled()) {', '    if (false) {', "guardPolishAnswer never guards a meeting line, even when called as the canaried pair"],
  ['pipeline-guard-says-failed', PL, "        return { text: cleaned, outcome: 'guarded', guard: problem.kind, polishSkipped: 'failed' }", "        return { text: cleaned, outcome: 'guarded', guard: problem.kind }", "COS_DICTATION_MEANING_GUARD=0 alone: the answer that lost a negation goes out"],
  ['pipeline-guard-sends-cleaned', PL, "        return { text: cleaned, outcome: 'guarded', guard: problem.kind, polishSkipped: 'failed' }", "        return { text: answer, outcome: 'guarded', guard: problem.kind, polishSkipped: 'failed' }", "COS_DICTATION_MEANING_GUARD=0 alone: the answer that lost a negation goes out"],
  ['pipeline-unchanged-outcome', PL, "  return { text: answer, outcome: answer !== cleaned ? 'polished' : 'unchanged' }", "  return { text: answer, outcome: 'polished' }", "6.91.0: with COS_DICTATION_REGISTERS=1 a terminal is literal; the model gets the register, the answer gets the input casing and no added period"],
  ['pipeline-link-outcome', PL, "    return { text: cleaned, outcome: 'guarded', guard: 'link', polishSkipped: 'link_guard' }", "    return { text: cleaned, outcome: 'polished', polishSkipped: 'link_guard' }", "6.83.1: a polish that invents a link is refused and the pre-polish text goes out"],
  ['pipeline-style-to-model', PL, '  const promptExtras = { customInstructions, learnedStyle: style.lines, register, promptVersion }', "  const promptExtras = { customInstructions, learnedStyle: '', register, promptVersion }", "COS_DICTATION_LEARNED_STYLE=0 alone: rules saved and on, yet no style block and learnedStyle false"],
  ['pipeline-style-hash-answer', PL, '    ...(style.lines ? { learnedStyle: true, learnedStyleHash: style.hash } : { learnedStyleOff: true }),', '    ...{ learnedStyleOff: true as const },', "COS_DICTATION_LEARNED_STYLE=0 alone: rules saved and on, yet no style block and learnedStyle false"],
  ['pipeline-style-false-answer', PL, '    ...(style.lines ? { learnedStyle: true, learnedStyleHash: style.hash } : { learnedStyleOff: true }),', '    ...(style.lines ? { learnedStyle: true, learnedStyleHash: style.hash } : {}),', "COS_DICTATION_LEARNED_STYLE=0 alone: rules saved and on, yet no style block and learnedStyle false"],
  ['pipeline-audit-codes', PL, "      polishOutcome: guarded.outcome, ...(guarded.guard ? { polishGuard: guarded.guard } : {}),\n", '', "6.91.0: an answer that lost a negation is refused; the log carries counts, never words"],
  ['route-register-from-context', PD, '    register: registerFromContext(req.body?.context),\n', '', "6.91.0: with COS_DICTATION_REGISTERS=1 a terminal is literal; the model gets the register, the answer gets the input casing and no added period"],
  ['route-outcome-field', PD, '    ...(result.polishOutcome ? { polishOutcome: result.polishOutcome } : {}),\n', '', "6.91.0: an answer that lost a negation is refused; the log carries counts, never words"],
  ['route-guard-field', PD, '    ...(result.guard ? { guard: result.guard } : {}),\n', '', "6.83.1: a polish that invents a link is refused and the pre-polish text goes out"],
  ['route-register-field', PD, '    ...(result.polishRegister ? { polishRegister: result.polishRegister } : {}),\n', '', "6.91.0: Claude, Cursor, an unknown app and no app are all default, with the same model call"],
  ['route-style-field', PD, '    ...(result.learnedStyle ? { learnedStyle: true, learnedStyleHash: result.learnedStyleHash } : result.learnedStyleOff ? { learnedStyle: false } : {}),', '    ...(result.learnedStyleOff ? { learnedStyle: false } : {}),', "6.91.0: the learned style reaches the model by its lines and the answer by its hash only"],
  ['audit-row-codes', T, "    ...(entry.polishRegister ? { polish_register: entry.polishRegister } : {}),\n", '', "codes and a hash only, after every older key, and only when the polish caller sets them"],
]

// Discovery only: the suites that test each source file most directly.
const DISCOVER_FILES = {
  [G]: ['server/lib/dictation-meaning-guard.test.ts'],
  [RG]: ['server/lib/dictation-register.test.ts', 'server/lib/dictation-polish-prompt-v4.test.ts'],
  [LS]: ['server/lib/dictation-learned-style.test.ts', 'server/routes/dictation-polish-settings.test.ts'],
  [C]: ['server/lib/dictation-polish-prompt-v4.test.ts', 'server/lib/dictation-clean.test.ts'],
  [PL]: ['server/lib/dictation-polish-prompt-v4.test.ts', 'server/routes/prompt-drafts.test.ts'],
  [PD]: ['server/routes/prompt-drafts.test.ts'],
  [R]: ['server/routes/dictation-polish-settings.test.ts'],
  [O]: ['server/routes/dictation-polish-settings.test.ts', 'server/lib/dictation-polish-prompt-v4.test.ts'],
  [P]: ['server/lib/dictation-prewarm.test.ts'],
  [T]: ['server/lib/token-audit-key-fields.test.ts'],
  [I]: ['server/lib/dictation-polish-custom-prompt.test.ts', 'server/routes/dictation-polish-settings.test.ts'],
}

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

const scratch = mkdtempSync(join(tmpdir(), 'dictation-voice-style-mutations-'))
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
  else console.log(`PASS voice-style mutation gate: ${selected.length} of ${selected.length}, each killed by its named check, green baseline`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
