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
const tests = ['server/lib/meeting-fact-check.test.ts', 'server/lib/meeting-fact-check-runtime.test.ts', 'server/lib/meeting-fact-check-web.test.ts', 'server/lib/meeting-web-page.test.ts']
const FC = 'server/lib/meeting-fact-check.ts', RT = 'server/lib/meeting-ask-runtime.ts', ST = 'server/lib/meeting-ask-store.ts'
const WEB = 'server/lib/meeting-ask-web.ts', PG = 'server/lib/meeting-web-page.ts', PR = 'server/lib/profile.ts'
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
  ['origin-stop-words', FC, '    if (ORIGIN_STOP.has(lw) || FUNC.has(lw) || CONTINUE_WORDS.has(lw)) break\n', ''],
  ['continue-length', FC, 'if (!t.length || t.length > 14) return null', 'if (!t.length) return null'],
  ['continue-needs-action', FC, "return action && t.every(w => CONTINUE_WORDS.has(w)) ? { kind: 'rerun' } : null", "return t.every(w => CONTINUE_WORDS.has(w)) ? { kind: 'rerun' } : null"],
  ['continue-request-words-only', FC, "return action && t.every(w => CONTINUE_WORDS.has(w)) ? { kind: 'rerun' } : null", "return action ? { kind: 'rerun' } : null"],
  ['clarify-route-claims-only', FC, "if (pending.place === 'implicit_origin' || pending.category === 'travel_time') {", 'if (true) {'],
  ['lookup-ten-minutes', FC, ' && at.elapsedMs - r.exchange.throughMs <= CONTINUATION_WINDOW_MS)', ')'],
  ['lookup-completed-only', FC, "&& r.exchange.status === 'completed' && !!r.factCheck?.claims?.length", '&& !!r.factCheck?.claims?.length'],
  ['lookup-unsearched-first', FC, 'const claim = claims.find(c => c.query === null) ?? ', 'const claim = '],
  ['lookup-unverified-next', FC, "claims.filter(c => c.verdict === 'unverified').at(-1) ?? ", ''],
  ['already-checked-meeting-wide-only', FC, "&& r.exchange.status === 'completed' && !!r.exchange.factCheckRange && r.exchange.throughMs <= at.elapsedMs)", "&& r.exchange.status === 'completed' && r.exchange.throughMs <= at.elapsedMs)"],
  ['typed-origin-used', FC, "const typed = c.intent.kind === 'clarify' ? resolveTypedOrigin(c.intent.origin, a.ownerArea()) : null", 'const typed = null'],
  ['abbreviation-letters-in-order', FC, 'if (at === abbreviation.length) return', 'if (true) return'],
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
  ['hedge-retry-after-failure', FC, '      if (attempts.length < 2 && !deadline.aborted) { clearTimeout(timer); launch(); return }\n', ''],
  ['hedge-unusable-retried', FC, 'if (opts.usable && !opts.usable(r)) fail(', 'if (false) fail('],
  ['hedge-stops-loser', FC, '      for (const stop of stops) stop.abort()\n', ''],
  ['hedge-orphan-fails-ask', FC, '      if (orphan) reject((orphan as PromiseRejectedResult).reason)\n      else if (win)', '      if (win)'],
  ['hedge-at-most-two', FC, '      if (attempts.length < 2 && !deadline.aborted) { clearTimeout(timer); launch(); return }', '      if (attempts.length < 3 && !deadline.aborted) { clearTimeout(timer); launch(); return }'],
  ['hedge-no-second-call-after-orphan', FC, '      if (opts.signal.aborted || (e instanceof AskProcessError && e.terminationUnconfirmed)) { void close(null); return }\n', ''],
  ['stall-noticed', FC, "  if (stalled) notices.push('The fact-check answer ran out of time", "  if (false) notices.push('The fact-check answer ran out of time"],
  ['salvage-by-claim-words', FC, '[...contentWords(r.text)].filter(w => words.has(w)).length >= 2', 'true'],
  ['assumption-always-stated', FC, 'return o && named.length && !named.some(w => said.has(w)) ?', 'return false ?'],
  // Orchestration.
  ['no-range-when-selection-fails', FC, "'Fact check claim selection did not return a usable list.'], undefined)", "'Fact check claim selection did not return a usable list.'], range)"],
  ['named-falls-back', FC, "    if (a.mode === 'named' && !claims.length) return null\n", ''],
  ['named-planner-failure-answers-fast', FC, "      if (a.mode === 'named') return fixedAnswer('I could not prepare that fact check in time", "      if (a.mode === 'named') return null; if (false) return fixedAnswer('I could not prepare that fact check in time"],
  ['nothing-new-skips-planner', FC, 'if (!scan.turns.length) return fixedAnswer(`Nothing new', 'if (false) return fixedAnswer(`Nothing new'],
  ['search-budget-spent', FC, 'if (budget <= 1000) return', 'if (false) return'],
  ['continuation-reuses-pages', FC, 'const reused = a.continuation ? reusablePages(a.continuation, c, now()) : []', 'const reused: AskSource[] = []'],
  ['reuse-same-query', FC, 'if (!claim.query || claim.query !== previous.claim.query) return []', 'if (!claim.query) return []'],
  ['reuse-fifteen-minutes', FC, '&& now - Date.parse(s.retrievedAt) < 900_000)', ')'],
  ['pages-kept-for-reuse', FC, 'f.c.pages = f.sources.filter(pageWasRead).slice(0, 2)', 'f.c.pages = [].slice(0, 2)'],
  // Medical doses.
  ['dose-detected', FC, 'export function medicalDosingRequest(question: string): boolean {\n  const q = question.toLowerCase()\n  return ', 'export function medicalDosingRequest(question: string): boolean {\n  const q = question.toLowerCase()\n  return false && '],
  ['dose-needs-a-person', FC, "\n    && /\\b(?:\\d+\\s*(?:lb|lbs|pounds?|kg|kilos?)|weighs?|weight|man|woman|child|kid|baby|patient|person|adult|him|her|me|i|my|give|take)\\b/.test(q)", ''],
  ['owner-area-city-label', PR, 'return HOME_AREA_LABEL.test(value) ? value : null', 'return value || null'],
  ['phone-area-city-label', FC, "if (HOME_AREA_LABEL.test(city)) return { text: city, source: 'phone_area' }", "if (city) return { text: city, source: 'phone_area' }"],
  // Runtime wiring.
  ['runtime-needs-consent', RT, 'const factMode = factCheckScopeEnabled() && publicTopics && webAvailable', 'const factMode = factCheckScopeEnabled() && webAvailable'],
  ['runtime-kill-switch', RT, 'const factMode = factCheckScopeEnabled() && publicTopics', 'const factMode = publicTopics'],
  ['runtime-retirement-precedence', RT, " && !genericRetirementQuery(normal, priorQuestions) ? this.factCheckMode(journal, input) : null", ' ? this.factCheckMode(journal, input) : null'],
  ['runtime-dose-answer', RT, "if (input.action === 'ask' && medicalDosingRequest(input.question)) {", 'if (false) {'],
  ['capability-follows-switch', RT, '...(factCheckScopeEnabled() ? { factCheckScope: 1 as const } : {})', '...({ factCheckScope: 1 as const })'],
  ['runtime-range-saved', RT, '...(fact.factCheckRange ? { factCheckRange: fact.factCheckRange } : {})', ''],
  ['runtime-claims-saved', RT, ', { factCheck: { claims: fact.claims } });', ');'],
  ['runtime-continue-mode', RT, "if (pending && intent)\n            return { mode: 'continue' as const", "if (false)\n            return { mode: 'continue' as const"],
  ['runtime-named-mode', RT, "if (factCheckRequest(input.question) && userWebQuery(input.question) !== null)\n            return { mode: 'named' as const };\n", ''],
  ['store-record-patch', ST, '        if (recordPatch.factCheck) record.factCheck = recordPatch.factCheck;\n', ''],
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
