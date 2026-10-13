#!/usr/bin/env node
// Meeting-wide Fact check mutation gate (6.71.13). Mutations run only in a disposable copy of server/ and shared/;
// the live checkout (which a candidate may be running) is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/fact-check-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/meeting-fact-check.test.ts', 'server/lib/meeting-fact-check-runtime.test.ts', 'server/lib/meeting-fact-check-web.test.ts', 'server/lib/meeting-web-page.test.ts', 'server/lib/meeting-ask-runner-audit.test.ts']
const FC = 'server/lib/meeting-fact-check.ts', RT = 'server/lib/meeting-ask-runtime.ts', ST = 'server/lib/meeting-ask-store.ts'
const WEB = 'server/lib/meeting-ask-web.ts', PG = 'server/lib/meeting-web-page.ts', PR = 'server/lib/profile.ts', RUN = 'server/lib/meeting-ask-runner.ts'
const mutations = [
  // Scope: which questions are meeting-wide, and where the next one starts.
  ['scope-cta', FC, '  if (isFactCheckCTA(question)) return true\n', ''],
  ['scope-words-only', FC, "t.every(w => w === 'factcheck' || SCOPE_WORDS.has(w))", 'true'],
  ['scope-length-cap', FC, "return t.length > 0 && t.length <= 12 && t.includes('factcheck')", "return t.length > 0 && t.includes('factcheck')"],
  ['window-ignores-future-range', FC, '|| r.throughMs > at.elapsedMs) continue', ') continue'],
  ['window-same-meeting', FC, "if (!r || e.status !== 'completed' || e.sessionId !== at.sessionId || ", "if (!r || e.status !== 'completed' || "],
  ['window-same-server', FC, "e.serverInstanceId !== at.serverInstanceId || e.requestId === at.requestId) continue", 'e.requestId === at.requestId) continue'],
  ['window-completed-only', FC, "if (!r || e.status !== 'completed' || e.sessionId", 'if (!r || e.sessionId'],
  ['window-newest', FC, 'if (r.throughMs > from) from = r.throughMs', 'from = r.throughMs'],
  ['scan-after-watermark', FC, '(window.full || t.elapsedMs > window.fromMs)', '(true)'],
  ['scan-budget', FC, '    if (used + cost > budget) break\n', ''],
  ['scan-honest-start', FC, 'scannedFromMs: truncated ? kept[0]?.elapsedMs ?? input.elapsedMs : window.fromMs', 'scannedFromMs: window.fromMs'],
  // Admission: what may reach the web.
  ['admit-private-words', FC, '[claim, query].some(s => PRIVATE_QUERY.test(s) || DOSING.test(s)', '[claim, query].some(s => DOSING.test(s)'],
  ['admit-no-dose', FC, '[claim, query].some(s => PRIVATE_QUERY.test(s) || DOSING.test(s) ||', '[claim, query].some(s => PRIVATE_QUERY.test(s) ||'],
  ['admit-speaker-and-owner-names', FC, '    if (words.some(w => blocked.has(w))) continue\n', ''],
  ['admit-unseen-number', FC, '    if (unseenNumber) continue\n', ''],
  ['admit-two-anchors', FC, '!CLAIM_GENERIC.has(w))).size < 2) continue', '!CLAIM_GENERIC.has(w))).size < 1) continue'],
  ['admit-private-evidence', FC, '    if (selected.some(t => !safe(t))) continue\n', ''],
  ['admit-category', FC, '|| !CATEGORIES.has(category)) continue', ') continue'],
  ['admit-implicit-needs-origin', FC, 'const searched = place && !origin ? null : originQuery(baseQuery, origin)', 'const searched = originQuery(baseQuery, origin)'],
  ['admit-origin-only-implicit', FC, 'const origin = place ? ctx.origin ?? null : null', 'const origin = ctx.origin ?? null'],
  ['admit-dedupe', FC, '    if (out.some(o => o.baseQuery === baseQuery)) continue\n', ''],
  ['admit-max', FC, '    if (out.length >= max) break\n', ''],
  ['admit-compound-from-passage-words', FC, '.some(i => vocab.has(stemWord(w.slice(0, i))) && vocab.has(stemWord(w.slice(i))))', '.some(i => vocab.has(stemWord(w.slice(0, i))))'],
  // Continuation.
  ['continue-length', FC, 'if (!t.length || t.length > 14) return null', 'if (!t.length) return null'],
  ['continue-needs-action', FC, "return action && t.every(w => CONTINUE_WORDS.has(w)) ? { kind: 'rerun' } : null", "return t.every(w => CONTINUE_WORDS.has(w)) ? { kind: 'rerun' } : null"],
  ['continue-request-words-only', FC, "return action && t.every(w => CONTINUE_WORDS.has(w)) ? { kind: 'rerun' } : null", "return action ? { kind: 'rerun' } : null"],
  ['lookup-unsearched-first', FC, 'const claim = claims.find(c => c.query === null) ?? ', 'const claim = '],
  ['lookup-unverified-next', FC, "claims.filter(c => c.verdict === 'unverified').at(-1) ?? ", ''],
  ['already-checked-meeting-wide-only', FC, "&& r.exchange.status === 'completed' && !!r.exchange.factCheckRange && r.exchange.throughMs <= at.elapsedMs)", "&& r.exchange.status === 'completed' && r.exchange.throughMs <= at.elapsedMs)"],
  // Rows.
  ['row-words', FC, "> FACT_ROW_MAX_WORDS) return 'too_verbose'", "> 9999) return 'too_verbose'"],
  ['row-source-unavailable', FC, "  if (row.text.includes('[source unavailable]')) return 'unsupported_citation'\n", ''],
  ['row-verdict', FC, "  if (!verdict) return 'missing_verdict'\n", ''],
  ['row-quote-verbatim', FC, "|| !source.text.includes(quote)) return 'unsupported_citation'", ") return 'unsupported_citation'"],
  ['row-attribution-needs-evidence', FC, "if (source?.kind === 'transcript' && attribution.has(id)) continue", "if (source?.kind === 'transcript') continue"],
  ['row-attribution-transcript-only', FC, "if (source?.kind === 'transcript' && attribution.has(id)) continue", 'if (attribution.has(id)) continue'],
  ['row-attribution-exempt', FC, "    if (source?.kind === 'transcript' && attribution.has(id)) continue\n", ''],
  ['row-page-read', FC, "    if (source.kind === 'web' && !pageWasRead(source)) return 'page_not_read'\n", ''],
  ['row-verdict-needs-read-page', FC, "if (verdict !== 'unverified' && !row.sources.some", 'if (false && !row.sources.some'],
  ['row-no-dose', FC, "  if (DOSE_TEXT.test(row.text)) return 'medical_dose'\n", ''],
  ['rows-one-per-claim', FC, "  if (rows.length !== claims) return 'claim_rows_mismatch'\n", ''],
  ['rows-no-coverage-talk', FC, "if (COVERAGE.test(reason + ' ' + rows.map(r => r.text).join(' '))) return 'invented_coverage'", 'if (false) return \'invented_coverage\''],
  ['rows-short-confidence', FC, "if (reason.trim().split(/\\s+/).length > 16) return 'too_verbose_confidence'", "if (false) return 'too_verbose_confidence'"],
  ['citation-lists-split', FC, ".replace(/\\[((?:[THFW]\\d+)(?:\\s*,\\s*[THFW]\\d+)+)\\]/g, (_m: string, list: string) => list.split(/\\s*,\\s*/).map(id => `[${id}]`).join(''))", ''],
  // Answer call timing and salvage.
  ['repair-only-in-time', FC, '    if (attempt && a.now() > a.repairUntil) break\n', ''],
  ['hedge-second-call-when-slow', FC, '    timer = setTimeout(() => { if (!settled && attempts.length < 2 && !deadline.aborted) launch() }, opts.hedgeMs)\n', ''],
  ['hedge-stops-loser', FC, '      for (const stop of stops) stop.abort()\n', ''],
  ['hedge-orphan-fails-ask', FC, '      if (orphan) reject((orphan as PromiseRejectedResult).reason)\n      else if (win)', '      if (win)'],
  ['hedge-no-second-call-after-orphan', FC, '      if (opts.signal.aborted || (e instanceof AskProcessError && e.terminationUnconfirmed)) { void close(null); return }\n', ''],
  ['stall-noticed', FC, "  if (stalled) notices.push('The fact-check answer ran out of time", "  if (false) notices.push('The fact-check answer ran out of time"],
  ['salvage-by-claim-words', FC, '[...contentWords(r.text)].filter(w => words.has(w)).length >= 2', 'true'],
  ['assumption-always-stated', FC, 'return o && named.length && !named.some(w => said.has(w)) ?', 'return false ?'],
  // Orchestration.
  ['no-range-when-selection-fails', FC, "'Fact check claim selection did not return a usable list.'], undefined)", "'Fact check claim selection did not return a usable list.'], range)"],
  ['named-falls-back', FC, "    if (a.mode === 'named' && !claims.length) return null\n", ''],
  ['named-planner-failure-answers-fast', FC, "      if (a.mode === 'named') return fixedAnswer('I could not prepare that fact check in time", "      if (a.mode === 'named') return null; if (false) return fixedAnswer('I could not prepare that fact check in time"],
  ['search-budget-spent', FC, 'if (budget <= 1000) return', 'if (false) return'],
  ['continuation-reuses-pages', FC, 'const reused = a.continuation ? reusablePages(a.continuation, c, now()) : []', 'const reused: AskSource[] = []'],
  ['reuse-same-query', FC, 'if (!claim.query || claim.query !== previous.claim.query) return []', 'if (!claim.query) return []'],
  ['reuse-fifteen-minutes', FC, '&& now - Date.parse(s.retrievedAt) < 900_000)', ')'],
  ['pages-kept-for-reuse', FC, 'f.c.pages = f.sources.filter(pageWasRead).slice(0, 2)', 'f.c.pages = [].slice(0, 2)'],
  // Medical doses.
  ['owner-area-city-label', PR, 'return HOME_AREA_LABEL.test(value) ? value : null', 'return value || null'],
  // Runtime wiring.
  ['runtime-needs-consent', RT, 'const factMode = factCheckScopeEnabled() && publicTopics && webAvailable', 'const factMode = factCheckScopeEnabled() && webAvailable'],
  ['runtime-kill-switch', RT, 'const factMode = factCheckScopeEnabled() && publicTopics', 'const factMode = publicTopics'],
  ['runtime-retirement-precedence', RT, " && !genericRetirementQuery(normal, priorQuestions) ? this.factCheckMode(journal, input) : null", ' ? this.factCheckMode(journal, input) : null'],
  ['capability-follows-switch', RT, '...(factCheckScopeEnabled() ? { factCheckScope: 1 as const } : {})', '...({ factCheckScope: 1 as const })'],
  ['runtime-range-saved', RT, '...(fact.factCheckRange ? { factCheckRange: fact.factCheckRange } : {})', ''],
  ['runtime-claims-saved', RT, ', { factCheck: { claims: fact.claims } });', ');'],
  ['runtime-continue-mode', RT, "if (pending && intent)\n            return { mode: 'continue' as const", "if (false)\n            return { mode: 'continue' as const"],
  ['runtime-named-mode', RT, "if (factCheckRequest(input.question) && userWebQuery(input.question) !== null)\n            return { mode: 'named' as const };\n", ''],
  ['store-record-patch', ST, '        if (recordPatch.factCheck) record.factCheck = recordPatch.factCheck;\n', ''],
  // QA B1: a typed starting place.
  ['clarify-pure-only', FC, '  if (!low.slice(rest).every(w => CLARIFY_WORDS.has(w) || owner.has(w))) return null\n', ''],
  ['clarify-lead-words-only', FC, 'if (from >= 0 && low.slice(0, from).every(w => LEAD_WORDS.has(w))) {', 'if (from >= 0) {'],
  ['origin-stop-words', FC, '    if (CLARIFY_WORDS.has(low[i]) || FUNC.has(low[i]) || ORIGIN_STOP.has(low[i])) break', '    if (FUNC.has(low[i])) break'],
  ['clarify-implicit-origin-only', FC, "  if (pending.place === 'implicit_origin') {\n    const origin = originClarification(", "  if (true) {\n    const origin = originClarification("],
  ['clarified-origin-used', FC, "const typed = c.intent.kind === 'clarify' ? c.intent.origin : null", 'const typed = null'],
  ['named-origin-place-like', FC, 'return from >= 0 ? placeOrigin(takePlace(raw, low, from + 1).join(\' \'), ctx) : null', "return from >= 0 ? { text: takePlace(raw, low, from + 1).join(' '), source: 'user' } : null"],
  ['continuation-notice-truthful', FC, "notices.push(typed ? `Re-running the fact check of ${which} with the starting point you gave", "notices.push(false ? `Re-running the fact check of ${which} with the starting point you gave"],
  // QA W3.
  ['continue-only-latest-exchange', FC, "&& r.exchange.status === 'completed' && r.exchange.throughMs <= at.elapsedMs)\n    .sort", "&& r.exchange.status === 'completed' && !!r.factCheck?.claims?.length && r.exchange.throughMs <= at.elapsedMs)\n    .sort"],
  ['lookup-ten-minutes', FC, ' || at.elapsedMs - last.exchange.throughMs > CONTINUATION_WINDOW_MS) return null', ') return null'],
  ['lookup-completed-only', FC, "&& r.exchange.status === 'completed' && r.exchange.throughMs <= at.elapsedMs)\n    .sort", '&& r.exchange.throughMs <= at.elapsedMs)\n    .sort'],
  // QA W1 and W2.
  ['stall-has-own-reason', FC, ": stalled ? 'The answer ran out of time before this claim could be checked.'", ": false ? 'The answer ran out of time before this claim could be checked.'"],
  ['watermark-last-scanned-turn', FC, 'throughMs: scan.turns.at(-1)?.elapsedMs ?? window.fromMs', 'throughMs: a.input.elapsedMs'],
  ['overlap-context', FC, 't.elapsedMs > window.fromMs - FACT_CHECK_OVERLAP_MS', 't.elapsedMs > window.fromMs'],
  ['overlap-needs-new-evidence', FC, '    if (ctx.newAfterMs !== undefined && !selected.some(t => t.elapsedMs > ctx.newAfterMs!)) continue\n', ''],
  ['truncation-counts-new-only', FC, 'const truncated = kept.filter(t => window.full || t.elapsedMs > window.fromMs).length < fresh', 'const truncated = kept.length < rows.length'],
  ['nothing-new-skips-planner', FC, "if (!scan.fresh) return fixedAnswer(", 'if (false) return fixedAnswer('],
  ['first-check-wording', FC, "if (!scan.fresh) return fixedAnswer(window.full ? 'Nothing has been said yet to check.' :", "if (!scan.fresh) return fixedAnswer(false ? 'Nothing has been said yet to check.' :"],
  // QA W8.
  ['rescan-words', FC, "const rescan = a.mode === 'scope' && factCheckRescanRequest(a.input.question)", 'const rescan = false'],
  ['rescan-rechecks-all', FC, "const alreadyChecked = a.mode === 'scope' && !rescan ? alreadyCheckedClaims(a.records, a.at) : []", "const alreadyChecked = a.mode === 'scope' ? alreadyCheckedClaims(a.records, a.at) : []"],
  // QA W4.
  ['dose-flag', RT, "if (input.action === 'ask' && doseGuardEnabled() && medicalDosingRequest(input.question)) {", "if (input.action === 'ask' && medicalDosingRequest(input.question)) {"],
  ['dose-answer', RT, "if (input.action === 'ask' && doseGuardEnabled() && medicalDosingRequest(input.question)) {", 'if (false) {'],
  ['phone-area-city-label', FC, 'if (HOME_AREA_LABEL.test(city) && age >= 0 && age <= PHONE_AREA_MAX_AGE_MS) return', 'if (city) return'],
  ['phone-area-fresh-only', FC, 'if (HOME_AREA_LABEL.test(city) && age >= 0 && age <= PHONE_AREA_MAX_AGE_MS) return', 'if (HOME_AREA_LABEL.test(city)) return'],
  // QA W5.
  ['unreadable-hosts-dropped', WEB, '.filter(s => !s.url || !unreadableResultHost(s.url))', ''],
  ['unreadable-subdomains', WEB, "host === h || host.endsWith('.' + h)", 'host === h'],
  // QA W7.
  ['hedge-no-immediate-retry', FC, '      if (ended >= attempts.length) void close(fallback)', '      if (ended >= attempts.length) { if (attempts.length < 2) launch(); else void close(fallback) }'],
  ['hedge-waits-for-running-call', FC, '      if (ended >= attempts.length) void close(fallback)', '      void close(fallback)'],
  ['hedge-label', FC, "out = await hedgedRun((signal, i) => a.run(text, FACT_CHECK_SYSTEM, signal, i ? caller + '_hedge' : caller), {", 'out = await hedgedRun((signal, i) => a.run(text, FACT_CHECK_SYSTEM, signal), {'],
  ['planner-label', FC, "a.run(plannerPrompt, FACT_CHECK_PLANNER_SYSTEM, signal, i ? 'meeting_fact_check_planner_hedge' : 'meeting_fact_check_planner')", 'a.run(plannerPrompt, FACT_CHECK_PLANNER_SYSTEM, signal)'],
  ['runtime-passes-label', RT, ', undefined, caller ? { caller } : undefined)', ')'],
  ['audit-caller-label', RUN, "caller: audit ? audit.caller + (unconfirmed ? ':child_exit_unconfirmed' : failure || code !== 0 ? ':' + (failure ?? 'provider_failed') : '') : auditSource.replace(/-/g, '_')", "caller: audit ? audit.caller : auditSource.replace(/-/g, '_')"],
  // Second QA pass: place-like origins.
  ['state-code-checked', FC, 'return !!m && US_STATE_CODES.has(m[2]) && US_CITIES.has(', 'return !!m && US_CITIES.has('],
  ['listed-city-only', FC, " && US_CITIES.has(factWords(m[1]).join(' '))\n}", '\n}'],
  ['owner-words-not-origin', FC, 'if (words.some(w => ctx.blockedNames.has(w) || ctx.ownerWords?.has(w))) return null', 'if (words.some(w => ctx.blockedNames.has(w))) return null'],
  ['origin-name-block', FC, 'if (words.some(w => ctx.blockedNames.has(w) || ctx.ownerWords?.has(w))) return null', 'if (words.some(w => ctx.ownerWords?.has(w))) return null'],
  ['origin-area-code', FC, "  if (area && /^[A-Z]{2,5}$/.test(text) && placeCodes(area).has(text)) return { text: `${text} (${area})`, source: 'user' }\n", ''],
  ['codes-are-initials', FC, "(/^[A-Z]{2,5}$/.test(text) && placeCodes(place).has(text))", "(/^[A-Z]{2,5}$/.test(text) && [...text.toLowerCase()].every(ch => factWords(place).join('').includes(ch)))"],
  ['tagged-places-only', FC, "return namesTaggedPlace(text, ctx.places) || cityLabel(text) ? { text, source: 'user' } : null", "return cityLabel(text) ? { text, source: 'user' } : null"],
  ['destination-tagged', FC, "  if (dest.length && !namesTaggedPlace(dest.join(' '), ctx.places)) return null\n", ''],
  ['tagged-place-in-passages', FC, 'w.every(y => vocab.has(stemWord(y)) && !blocked.has(y))', 'w.every(y => !blocked.has(y))'],
  ['tagged-place-not-a-name', FC, 'w.every(y => vocab.has(stemWord(y)) && !blocked.has(y))', 'w.every(y => vocab.has(stemWord(y)))'],
  // Second QA pass: dose wording.
  ['dose-needs-medicine', FC, '  if (!MEDICINE.test(q) || NOT_DOSING.test(q)) return false\n', '  if (NOT_DOSING.test(q)) return false\n'],
  ['dose-not-money-or-schedule', FC, '  if (!MEDICINE.test(q) || NOT_DOSING.test(q)) return false\n', '  if (!MEDICINE.test(q)) return false\n'],
  ['dose-what-dose', FC, 'return WHAT_DOSE.test(q) || MODAL_AMOUNT.test(q) || ', 'return MODAL_AMOUNT.test(q) || '],
  ['dose-modal-amount', FC, 'return WHAT_DOSE.test(q) || MODAL_AMOUNT.test(q) || ', 'return WHAT_DOSE.test(q) || '],
  ['dose-intent', FC, '(HOW_MUCH.test(q) && (DOSE_INTENT.test(q) ||', '(HOW_MUCH.test(q) && (true ||'],
  ['dose-named-person', FC, " || /\\bfor\\s+\\p{Lu}\\p{Ll}+/u.test(question)))", '))'],
  // Second QA pass: partial failures.
  ['all-unchecked-no-range', FC, '    if (failed.length === claims.length) {', '    if (false) {'],
  ['stalled-is-unchecked', FC, 'c.checked = !composed.stalled && !!c.query && web.some(', 'c.checked = !!c.query && web.some('],
  ['checked-needs-read-page', FC, 'c.checked = !composed.stalled && !!c.query && web.some(s => webClaim.get(s.id) === c.n && pageWasRead(s))', 'c.checked = !composed.stalled && !!c.query'],
  ['partial-range-trimmed', FC, 'range = { ...range, throughMs: Math.max(range.fromMs, Math.min(range.throughMs, firstFailed - 1)), claims: claims.length - failed.length }', 'range = { ...range }'],
  ['unchecked-retried-later', FC, '.filter(c => c.checked !== false).map(c => c.claim)', '.map(c => c.claim)'],
  // Search and page reading.
  ['search-skips-unreadable-hosts', WEB, 'stdin: JSON.stringify({ query: query.slice(0, 240), blockedDomains: UNREADABLE_RESULT_HOSTS })', 'stdin: JSON.stringify({ query: query.slice(0, 240) })'],
  ['search-stops-at-result', WEB, "JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')); early.abort();", "JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));"],
  ['search-own-cancel-still-throws', WEB, 'if (!early.signal.aborted || signal?.aborted ||', 'if (!early.signal.aborted ||'],
  ['four-candidates', WEB, 'prioritizeWebPages(sources, query).slice(0, 4)', 'prioritizeWebPages(sources, query).slice(0, 2)'],
  ['two-reads-at-most', WEB, 'if (!page || fetched >= 2) return;', 'if (!page) return;'],
  ['stop-waiting-after-two', WEB, 'if (read >= 2 || settled === candidates.length) resolve();', 'if (settled === candidates.length) resolve();'],
  ['relevance-tie-break', WEB, '||b.r-a.r||', '||'],
  ['request-words-not-subjects', WEB, "'im', 'asking', 'ask', 'asked', 'request'", "'ask', 'asked', 'request'"],
  ['focus-reaches-reader', WEB, 'fetchPublicArticle(source.url!, publicAddress, signal, focus)', 'fetchPublicArticle(source.url!, publicAddress, signal)'],
  ['reader-longest-article', PG, "blocks.reduce((a, b) => b.length > a.length ? b : a, '')", "(blocks[0] ?? '')"],
  ['reader-body-fallback', PG, '(best.length >= 400 ? best : cleanText(html))', '(best || cleanText(html))'],
  ['reader-focus-window', PG, '        if (score > top) { top = score; start = i; }\n', ''],
  ['reader-focus-used', PG, "articleText(raw, focus)", 'articleText(raw)'],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const selected = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && selected.length !== names.length) throw new Error('Unknown mutation name in: ' + args.join(' '))

if (args.includes('--check')) {
  // Validate every mutation target without running tests.
  let bad = 0
  for (const [name, file, find, replacement] of mutations) {
    const text = readFileSync(join(root, file), 'utf8'), count = text.split(find).length - 1
    if (count !== 1 || find === replacement) { bad++; console.log(`${name}: ${count} matches in ${file}`) }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets unique`); process.exit(bad ? 1 : 0)
}
const scratch = mkdtempSync(join(tmpdir(), 'fact-check-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = () => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
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
  console.log(`${selected.length - survived.length} of ${selected.length} fact-check mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
