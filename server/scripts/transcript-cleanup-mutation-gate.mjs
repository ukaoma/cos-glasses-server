#!/usr/bin/env node
// Transcript cleanup 6.77.0 mutation gate: span selection, the deterministic fixes, the edit guards, the ledger, the stop
// conditions, the screen-context store and route, the dictionary suggestions and the save wiring. Mutations run only in a
// disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/transcript-cleanup-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB = ['server/lib/transcript-cleanup.test.ts', 'server/lib/transcript-cleanup-spans.test.ts']
const ROUTE = ['server/routes/transcript-cleanup.test.ts']
const MEETING = ['server/routes/meeting.test.ts']
const WIRE = ['server/routes/health.test.ts', 'server/routes/transcribe.test.ts', 'server/lib/transcript-cleanup-provider.test.ts']
const ALL = [...LIB, ...ROUTE, ...MEETING, ...WIRE]
const RUN = 'server/lib/transcript-cleanup.ts', SPANS = 'server/lib/transcript-cleanup-spans.ts', TEXT = 'server/lib/transcript-cleanup-text.ts'
const MODEL = 'server/lib/transcript-cleanup-model.ts', LEDGER = 'server/lib/transcript-cleanup-ledger.ts', STATE = 'server/lib/transcript-cleanup-state.ts'
const SCREEN = 'server/lib/transcript-cleanup-screen.ts', SUG = 'server/lib/transcript-cleanup-suggestions.ts', CTX = 'server/lib/transcript-cleanup-context.ts'
const R = 'server/routes/transcript-cleanup.ts', MEET = 'server/routes/meeting.ts'
const m = (name, file, edits, tests = LIB) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Switch, model, stops ──
  m('switch-checked-first', RUN, ['if (!resolveCleanupSwitch(deps.env, deps.settings).enabled) return', 'if (false) return']),
  m('env-0-forces-off', STATE, ["  if (env.COS_TRANSCRIPT_CLEANUP === '0') return { enabled: false, source: 'env' }\n", '']),
  m('env-1-forces-on', STATE, ["  if (env.COS_TRANSCRIPT_CLEANUP === '1') return { enabled: true, source: 'env' }\n", '']),
  m('default-off', STATE, ["  return { enabled: false, source: 'default' }", "  return { enabled: true, source: 'default' }"], [...LIB, ...ROUTE]),
  m('default-model-haiku', STATE, ["return { choice: 'haiku', id: CLEANUP_MODEL_IDS.haiku, source: 'default' }", "return { choice: 'sonnet', id: CLEANUP_MODEL_IDS.sonnet, source: 'default' }"], [...LIB, ...ROUTE]),
  m('setting-model-read', STATE, ["  if (stored) return { choice: stored, id: CLEANUP_MODEL_IDS[stored], source: 'setting' }\n", '']),
  m('env-model-wins', STATE, ["  if (raw === 'haiku' || raw === 'sonnet') return { choice: raw, id: CLEANUP_MODEL_IDS[raw], source: 'env' }\n", '']),
  m('charge-before-call', RUN, ["else if (!deps.budget.charge(limits)) modelSkipped = 'daily_calls'", "else if (false) modelSkipped = 'daily_calls'"]),
  m('gate-breaker', STATE, ["    if (s.breakerOpenUntil !== null && this.now().getTime() < s.breakerOpenUntil) return 'breaker_open'\n", '']),
  m('gate-daily-calls', STATE, ["    if (s.calls >= limits.dailyCalls) return 'daily_calls'\n", '']),
  m('gate-daily-tokens', STATE, ["    if (s.tokens >= limits.dailyTokens) return 'daily_tokens'\n", '']),
  m('usage-recorded', RUN, ['          deps.budget.recordUsage(trace.inputTokens + trace.outputTokens)\n', '']),
  m('provider-limit-opens-breaker', STATE, ['const open = providerLimit || failures >= limits.breakerFailures', 'const open = failures >= limits.breakerFailures']),
  m('breaker-after-three', STATE, ['    breakerFailures: 3,', '    breakerFailures: 4,']),
  m('success-closes-breaker', STATE, ['    this.write({ ...s, consecutiveFailures: 0, breakerOpenUntil: null })', '    return']),
  m('unreadable-state-is-spent', STATE, ['    } catch {\n      return spent\n', '    } catch {\n      return { day, calls: 0, tokens: 0, consecutiveFailures: 0, breakerOpenUntil: null }\n']),
  m('future-day-is-spent', STATE, ['      if (raw.day > day) return { ...spent, ...breaker }\n', '']),
  m('negative-count-is-spent', STATE, ['      if (!(calls >= 0) || !(tokens >= 0)) return { ...spent, ...breaker }\n', '']),
  m('failure-recorded', RUN, ['          deps.budget.recordFailure(limits, limit)\n', '']),
  m('api-key-guard', RUN, ["else if (deps.env.ANTHROPIC_API_KEY && deps.env.COS_ALLOW_API_FALLBACK !== '1') modelSkipped = 'api_key_in_env'", "else if (false) modelSkipped = 'api_key_in_env'"]),
  m('claude-cli-guard', RUN, ["else if (!deps.claudeAvailable()) modelSkipped = 'claude_not_found'", "else if (false) modelSkipped = 'claude_not_found'"]),
  m('live-session-skipped', RUN, ["    if (live) return finish({ status: 'skipped', reason: 'session_live', applied: 0 })", "    if (false) return finish({ status: 'skipped', reason: 'session_live', applied: 0 })"]),
  m('span-cap-per-meeting', RUN, ['{ maxSpans: limits.maxSpans, fixed:', '{ maxSpans: 80, fixed:']),
  m('idempotent-rerun', RUN, ["    if (alreadyCleaned(input.sessionId, inputSha)) return finish({ status: 'skipped', reason: 'already_done', applied: 0 })", "    if (false) return finish({ status: 'skipped', reason: 'already_done', applied: 0 })"]),
  m('ledger-intent-first', RUN, ["    if (!appendLedger(input.sessionId, [{ kind: 'run', runId, phase: 'intent', at: at(), inputSha }])) {", "    if (!appendLedger(input.sessionId, [{ kind: 'run', runId, phase: 'intent', at: at(), inputSha }]) && false) {"]),
  m('prompt-size-cap', MODEL, ['    if (prompt.length + block.length + 1 > MODEL_LIMITS.promptChars) break\n', '']),
  m('screen-lines-in-prompt', MODEL, ['const screen = screenLinesFor(pack.screen, span.atMs, span.near, { max: MODEL_LIMITS.screenLinesPerSpan })', 'const screen: typeof pack.screen = []']),
  m('owner-in-prompt', MODEL, ['  if (pack.owner) {\n    head.push', '  if (false) {\n    head.push']),
  m('parse-scans-past-first-object', MODEL, ["    i = text.indexOf('{', i + 1)", '    i = -1']),
  m('parse-string-aware', MODEL, ["        else if (c === '\"') inString = false", '']),

  m('notes-exclude-this-meeting', RUN, ['if (!hit.recordId || hit.sessionId === sessionId) continue', 'if (!hit.recordId) continue']),
  m('notes-bridge-when-memory-empty', RUN, ['      if (!memoryHits && !signal.aborted) {', '      if (!signal.aborted) {']),
  m('notes-in-prompt', MODEL, ['  for (const n of pack.notes) head.push', '  for (const n of [] as typeof pack.notes) head.push']),
  m('notes-snippet-bounded', CTX, [
    ["snippet: redactSecrets(n.snippet).replace(/\\s+/g, ' ').slice(0, CONTEXT_LIMITS.noteChars) }\n    pack.notes.push(note)", "snippet: n.snippet }\n    pack.notes.push(note)"]]),
  m('notes-snippet-clipped-in-prompt', MODEL, ['${quote(n.title)}: ${clip(n.snippet, 280)}`)', '${quote(n.title)}: ${n.snippet}`)']),

  // ── Span selection ──
  m('parakeet-floor', SPANS, ["  if (engine.startsWith('parakeet')) return LOW_CONFIDENCE.parakeet\n", '']),
  m('fillers-never-doubtful', SPANS, [' && !FILLERS.has(t.key)) flag(t.i, ', ') flag(t.i, ']),
  m('near-name-needs-unsure', SPANS, ['const unsure = input.probability === undefined || input.probability < NEAR_NAME_UNSURE', 'const unsure = true']),
  m('near-name-inflection-skip', SPANS, ['    if (inflectionOf(key, t.key)) continue\n', '']),
  m('exact-join-is-a-hit', SPANS, ['    if (d === 0 && !input.join) return null', '    if (d === 0) return null']),
  m('join-no-function-words', SPANS, ['group.some(g => g.key.length > 5 || FUNCTION_WORDS.has(g.key))', 'group.some(g => g.key.length > 5)']),
  m('join-pieces-short', SPANS, ['group.some(g => g.key.length > 5 || FUNCTION_WORDS.has(g.key))', 'group.some(g => FUNCTION_WORDS.has(g.key))']),
  m('sounds-alike-onset', TEXT, ['  if (vowelOnset(fa) !== vowelOnset(fb)) return false\n', '']),
  m('sounds-alike-two-consonants', TEXT, ['  if (sa.length < 2 || sa !== sb) return false', '  if (sa !== sb) return false']),
  m('oov-not-at-sentence-start', SPANS, ['if (fixed.has(t.i) || t.sentenceStart || !/^\\p{Lu}/u.test(t.core)', 'if (fixed.has(t.i) || !/^\\p{Lu}/u.test(t.core)']),
  m('repeat-needs-three', SPANS, ['if (reps >= (unit === 1 ? 4 : 3)) found', 'if (reps >= 2) found']),
  m('merge-stops-at-clause', SPANS, ['      if (tokens.slice(to - 1, next).some(t => /[,.;:!?]["\')\\]]*$/.test(t.raw))) break\n', '']),
  m('merge-stays-in-line', SPANS, ['      if (tokens[next].line !== tokens[from].line || next - to > 1', '      if (next - to > 1']),
  m('span-word-cap', SPANS, ['  maxSpanWords: 6,', '  maxSpanWords: 8,']),
  m('names-ranked-first', SPANS, ["(d.reasons.has('near_name') ? 4 : 0)", "(d.reasons.has('near_name') ? 0 : 0)"]),
  m('align-by-folded-word', TEXT, ['if (words[k].word === token.raw || fold(words[k].word) === token.key)', 'if (words[k].word === token.raw)']),
  m('word-time-on-meeting-clock', TEXT, ['Math.round(startTime + startElapsed + s * 1000)', 'Math.round(startTime + s * 1000)']),

  // ── Deterministic fixes ──
  m('fix-capitalised-only', SPANS, ['if (!/^\\p{Lu}/u.test(base) || allLower.has(base.toLowerCase()) || known.has(fold(base))) continue', 'if (allLower.has(base.toLowerCase()) || known.has(fold(base))) continue']),
  m('fix-never-a-known-spelling', SPANS, ['if (!/^\\p{Lu}/u.test(base) || allLower.has(base.toLowerCase()) || known.has(fold(base))) continue', 'if (!/^\\p{Lu}/u.test(base) || allLower.has(base.toLowerCase())) continue']),
  m('fix-strong-only-when-unsure', SPANS, ['let replacement = unsure ? fuzzyReplacementFor(base, strong, allLower) : null', 'let replacement = fuzzyReplacementFor(base, strong, allLower)']),
  m('fix-sentence-opener-only-unsure', SPANS, ['    if (token.sentenceStart && !unsure) continue\n', '']),
  m('fix-no-inflection', SPANS, ['if (replacement === null || replacement === base || inflectionOf(base, replacement)) continue', 'if (replacement === null || replacement === base) continue']),
  m('fix-no-attendee-targets', RUN, ['const strongTargets = [...pack.vocabulary, ...pack.corrections.map(c => c.written), ...(pack.owner ? [pack.owner.name] : [])]', 'const strongTargets = [...pack.vocabulary, ...pack.corrections.map(c => c.written), ...pack.speakers, ...(pack.owner ? [pack.owner.name] : [])]']),

  // ── Edit guards ──
  m('only-sent-ids', MODEL, ['const byId = new Map(spans.filter(s => sentIds.includes(s.id)).map(s => [s.id, s]))', 'const byId = new Map(spans.map(s => [s.id, s]))']),
  m('duplicate-rejected', MODEL, ["    if (seen.has(id)) { reject('duplicate'); continue }\n", '']),
  m('bracket-is-unsafe', MODEL, ["/[\\u0000-\\u001f\\u007f\\[\\]]/.test(edit!.text", "/[\\u0000-\\u001f\\u007f]/.test(edit!.text"]),
  m('no-op-rejected', MODEL, ["    if (text === span.text) { reject('no_op'); continue }\n", '']),
  m('word-count-cap', MODEL, ['newWords.length > spanWords.length + 1 ||', 'newWords.length > spanWords.length + 9 ||']),
  m('char-length-cap', MODEL, [' || text.length > span.text.length * 2 + 8) {', ') {']),
  m('repeat-shrinks-to-own-run', MODEL, ["      if (!isRun) { reject('longer_than_span'); continue }\n", '']),
  m('outside-span-before', MODEL, ['(beforeLast && firstNew === beforeLast && !spanKeys.has(beforeLast)) || ', '']),
  m('outside-span-after', MODEL, [' || (afterFirst && lastNew === afterFirst && !spanKeys.has(afterFirst))', '']),
  m('numbers-unchanged', MODEL, ["    if (numbers(text) !== numbers(span.text)) { reject('number_unit'); continue }\n", '']),
  m('negations-unchanged', MODEL, ["    if (negationCount(text) !== negationCount(span.text)) { reject('negation'); continue }\n", '']),
  m('added-content-rejected', MODEL, ["    if (unsupported.length) { reject('added_content'); continue }\n", '']),
  m('context-terms-admit', MODEL, ['const knownTerm = (w: string) => pack.terms.has(fold(w))', 'const knownTerm = (_w: string) => false']),

  // ── Ledger and writes ──
  m('overlap-dropped', LEDGER, ['      if (e.start < cursor || e.end > source.length || e.start >= e.end) continue', '      if (e.end > source.length || e.start >= e.end) continue']),
  m('commit-refuses-changed-files', LEDGER, ["  if (markdownNow !== options.markdown || sidecarNow !== options.sidecarText) throw new CleanupWriteError('changed_during_cleanup')\n", '']),
  m('failed-markdown-restores-sidecar', LEDGER, ['    try { write(options.sidecarPath, options.sidecarText) } catch { /* the two files now disagree; say so */ }\n', '']),
  m('batch-transcript-kept-canonical', LEDGER, ["sidecar.batchTranscript.replace(/\\n+$/, '') === oldSection) sidecar.batchTranscript = options.transcript", "sidecar.batchTranscript.replace(/\\n+$/, '') === oldSection) sidecar.batchTranscript = sidecar.batchTranscript"]),
  m('lifecycle-revision-bumped', LEDGER, ['  sidecar.lifecycleRevision = Number(sidecar.lifecycleRevision ?? 0) + 1\n', '']),
  m('undo-refuses-stale', LEDGER, ["    if (at < 0) return { ok: false, status: 409, error: 'stale' }\n", '']),
  m('undo-exact-offsets', LEDGER, ['    if (untouched.get(line.index) && line.text.slice(edit.offset, edit.offset + edit.replacement.length) === edit.replacement) at = edit.offset', '    if (false) at = edit.offset']),
  m('undo-records-revert', LEDGER, ["  appendLedger(options.sessionId, targets.map(t => ({ kind: 'revert' as const, editId: t.id, at: now })))\n", '']),

  // ── Screen context ──
  m('screen-secrets-held', SCREEN, ['    if (imageTextHasSecrets(o.text) || imageTextHasSecrets(text)) { result.held++; continue }\n', ''], [...LIB, ...ROUTE]),
  m('screen-line-truncated', SCREEN, ['    if (text.length > SCREEN_LIMITS.charsPerLine) { text = text.slice(0, SCREEN_LIMITS.charsPerLine); result.truncated++ }\n', '']),
  m('screen-duplicates', SCREEN, ["    if (recent.some(r => norm(r.text) === key && Math.abs(r.at - at) <= SCREEN_LIMITS.duplicateWindowMs)) { result.duplicates++; continue }\n", '']),
  m('screen-clock-bounds', SCREEN, ['at === null || at < earliest || at > latest ||', 'at === null ||']),
  m('screen-meeting-line-cap', SCREEN, ['if (result.stored >= SCREEN_LIMITS.linesPerMeeting || storedBytes', 'if (storedBytes']),
  m('screen-request-line-cap', SCREEN, ["  if (lines.length > SCREEN_LIMITS.linesPerRequest) throw new ScreenContextError('too_many_lines', 413)\n", ''], [...LIB, ...ROUTE]),
  m('screen-request-byte-cap', SCREEN, ["  if (requestBytes > SCREEN_LIMITS.bytesPerRequest) throw new ScreenContextError('request_too_large', 413)\n", ''], [...LIB, ...ROUTE]),
  m('screen-path-confined', SCREEN, [
    ['  if (!SESSION_ID.test(sessionId)) return null\n', ''],
    ["  return resolve(path).startsWith(resolve(dir) + '/') ? path : null", '  return path']]),
  m('route-unknown-session-404', R, ["    if (!meeting) return { ok: false, status: 404, error: 'unknown_session' }\n", ''], ROUTE),
  m('route-cleanup-done-409', R, ["    return done ? { ok: false, status: 409, error: 'cleanup_done' } : { ok: true }", '    return { ok: true }'], ROUTE),
  m('route-env-forced-409', R, ["    if (hasEnabled && (env.COS_TRANSCRIPT_CLEANUP === '1' || env.COS_TRANSCRIPT_CLEANUP === '0') && body.enabled !== (env.COS_TRANSCRIPT_CLEANUP === '1')) {", '    if (false) {'], ROUTE),
  m('sweep-keeps-known', SCREEN, ['        try { gone = !opts.known(sessionId) } catch { gone = false }', '        gone = true'], ROUTE),
  m('sweep-screen-retention', SCREEN, ["      const expired = kind === 'screen' && age > retentionMs", '      const expired = false'], ROUTE),

  // ── Dictionary suggestions ──
  m('suggestion-needs-evidence', SUG, ['if (!written || written.length > 100 || !input.evidence.length) return null', 'if (!written || written.length > 100) return null'], [...LIB, ...ROUTE]),
  m('suggestion-not-for-dictionary-words', SUG, ['    if (input.inDictionary(written)) return null\n', ''], ROUTE),
  m('suggestion-dismissed-stays-out', SUG, ["    if (existing && existing.status !== 'pending') return null\n", ''], ROUTE),
  m('suggestion-dedupe-case', SUG, ['const existing = list.find(s => same(s.written, written))', 'const existing = list.find(s => s.written === written)'], ROUTE),
  m('orchestrator-skips-dictionary-terms', RUN, [
    ['      if (!term || inDictionary(term) || heardKeys.has(term.key)) continue', '      if (!term || heardKeys.has(term.key)) continue'],
    ["        if (deps.suggestions.record({ written: term.display, heard: edit.original, evidence, sessionId, at, inDictionary: w => dictionary.has(w.trim().toLowerCase()) })) recorded++", "        if (deps.suggestions.record({ written: term.display, heard: edit.original, evidence, sessionId, at, inDictionary: () => false })) recorded++"]]),
  m('orchestrator-longest-term', RUN, ['      if (parts.every(p => covered.has(p))) continue\n', '']),
  m('evidence-maps-screen', CTX, ["['screen', 'screen'], ", '']),
  m('accept-uses-vocabulary-writer', R, ['        : await addVocabulary(suggestion.written)', "        : { status: 200, body: { unchanged: false, glossary: null } }"], ROUTE),
  m('accept-correction-path', R, ["const outcome = body.correction === true && heard", 'const outcome = false && heard'], ROUTE),
  m('accept-refuses-dismissed', R, ["    if (suggestion.status === 'dismissed') return res.status(409).json({ error: 'suggestion_dismissed' })\n", ''], ROUTE),

  // ── Save wiring and capability ──
  m('cleanup-stage-in-finalization', MEET, ['    await runCleanupStage(runtime.transcriptCleanup, { sessionId: current.sessionId, meetingPath: current.meetingPath, sidecarPath: current.sidecarPath }, runtime.sessions)\n', ''], MEETING),
  m('cleanup-stage-never-fails-save', MEET, ['  try {\n    await run(input)\n  } catch (error) {', '  {\n    await run(input)\n  } if (false) { const error = null as unknown;'], MEETING),
  m('health-says-off', R, ['  return { protocol: TRANSCRIPT_CLEANUP_PROTOCOL, enabled }', '  return { protocol: TRANSCRIPT_CLEANUP_PROTOCOL, enabled: true }'], [...ROUTE, ...WIRE]),
  m('capabilities-advertised', 'server/routes/transcribe.ts', ['    transcriptCleanup: { protocol: 1, suggestions: 1, screenContext: 1 },\n', ''], WIRE),
  m('provider-source-tag', RUN, ["source: 'transcript-cleanup', maxOutputTokens: opts.maxOutputTokens", "source: 'lens_gist', maxOutputTokens: opts.maxOutputTokens"], WIRE),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length && !args.includes('--check') ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && !args.includes('--check') && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
// --check: every target matches exactly once and changes its file. Runs no tests.
if (args.includes('--check')) {
  let bad = 0
  for (const { name, file, edits } of mutations) {
    let text = readFileSync(join(root, file), 'utf8')
    const original = text
    for (const [find, replacement] of edits) {
      const n = text.split(find).length - 1
      if (n !== 1) { console.log(`${name}: matches ${n} times in ${file}: ${find.slice(0, 90)}`); bad++ }
      else text = text.replace(find, () => replacement)
    }
    if (text === original) { console.log(`${name}: no change`); bad++ }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'transcript-cleanup-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
  let killed = 0
  for (const { name, file, edits, tests } of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    let mutated = original
    for (const [find, replacement] of edits) {
      if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 80)}`)
      mutated = mutated.replace(find, () => replacement)
    }
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} transcript cleanup 6.77.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
