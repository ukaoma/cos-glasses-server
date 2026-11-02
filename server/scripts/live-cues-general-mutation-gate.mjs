#!/usr/bin/env node
// General live cues mutation gate: the runner, the topic admission and the prompts/parsers, the optional audit caller on the web
// search, and the engine's hosting of the runner (the extended-only meeting list, the confirmed domain, the settings reader, the
// insight emit path, the aborts and the settings-view wiring). Mutations run only in a disposable copy of the checkout; the live
// checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous (--check does only this step).
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name") and its name contains the behaviour the mutant breaks (`by`); a build
//      error, a harness failure or an unrelated test failing is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/live-cues-general-mutation-gate.mjs [--list] [--check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RUN_T = ['server/lib/live-cues-general.test.ts']
const TOPIC_T = ['server/lib/live-cues-general-topic.test.ts']
const PROMPTS_T = ['server/lib/live-cues-general-prompts.test.ts']
const WEB_T = ['server/lib/meeting-fact-check-web.test.ts']
const ENGINE_T = ['server/lib/live-cues-general-engine.test.ts']
// The engine's own suites must stay green too: the classic pin (a default engine is byte for byte 6.97.4), the focused engine,
// the kinds, the grounded cues and the settings.
const ENGINE_SUITES = ['server/lib/live-cues-v2-classic-pin.test.ts', 'server/lib/live-cues-v2.test.ts', 'server/lib/live-cues-v2-kinds.test.ts', 'server/lib/live-cues-v2-grounding.test.ts',
  'server/lib/live-cues-v2-settings.test.ts', 'server/routes/live-cues-v3-settings-route.test.ts']
const NAMES_T = ['server/lib/live-cues-general-real-names.test.ts']
// The routes and the v1 engine that import the general cues' module graph with partial mocks of the profile and the data home.
const GRAPH_SUITES = ['server/lib/live-cues-engine.test.ts', 'server/routes/transcribe-stream-log-privacy.test.ts']
const ALL = [...RUN_T, ...TOPIC_T, ...PROMPTS_T, ...WEB_T, ...ENGINE_T, ...NAMES_T, ...ENGINE_SUITES, ...GRAPH_SUITES, 'server/lib/meeting-ask-web.test.ts']
const LIVE_ENGINE = 'server/lib/live-cues-engine.ts', TRANSCRIBE = 'server/routes/transcribe-stream.ts'
const RUN = 'server/lib/live-cues-general.ts', TOPIC = 'server/lib/live-cues-general-topic.ts', PROMPTS = 'server/lib/live-cues-general-prompts.ts'
const WEB = 'server/lib/meeting-ask-web.ts', ENGINE = 'server/lib/live-cues-v2.ts'
// `by`: the killing test's full name must contain this (case-insensitive), so a mutant is killed by a test that names its behaviour.
const m = (name, file, edits, tests, by) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests, by })

// The six category lists in the sensitive-window vocabulary, each replaced by a list that matches nothing.
const topicSource = readFileSync(join(root, TOPIC), 'utf8')
const categoryMutants = ['health', 'family', 'finance', 'legal', 'school', 'funeral'].map(cat => {
  const line = new RegExp(`  \\['${cat}', wordsRe\\(\\[[^\\n]*?\\]\\)\\],?\\n(?=  \\[|\\]\\))`, 's').exec(topicSource)
  const block = new RegExp(`  \\['${cat}', wordsRe\\(\\[(?:[^\\]]|\\n)*?\\]\\)\\],\\n`).exec(topicSource)
  const found = block?.[0] ?? line?.[0]
  if (!found) throw new Error(`Cannot find the ${cat} vocabulary in ${TOPIC}`)
  return m(`sensitive-category-${cat}`, TOPIC, [found, `  ['${cat}', wordsRe(['qqqneverqqq'])],\n`], TOPIC_T, `skips a ${cat} window`)
})


// Each stem of the widened sensitive vocabulary, taken out on its own: the test with that stem in its name must fail.
const WIDENED_STEMS = ['chemo*', 'ob gyn', 'c section', 'adhd', 'psychiatr*', 'psycholog*', 'pediatric*', 'hospice', 'pharmac*', 'autis*', 'irs', 'installment*', 'escrow', 'credit score',
  'pension*', 'insurance', 'husband*', 'wives', 'moms', 'parent*', 'grandma*', 'aunt*', 'uncle*', 'cousin*', 'nephew*', 'niece*', 'dnp', 'dissertation*', 'nursery', 'die', 'dies', 'died', 'dying']
const stemMutants = WIDENED_STEMS.map(stem => m(`vocab-${stem.replace(/[^a-z]+/g, '-')}`, TOPIC, [`'${stem}',`, ''], TOPIC_T, `(${stem})`))
// And each of the number words the review named.
const NUMBER_WORDS = ['zero', 'hundreds', 'thousands', 'millions', 'billions', 'dozen', 'half', 'first', 'third', 'fifth', 'tenth']
const numberMutants = NUMBER_WORDS.map(word => m(`number-${word}`, TOPIC, [`'${word}',`, ''], TOPIC_T, 'ordinals, plurals of the big numbers'))

const mutations = [
  // ── Eligibility, every term ──
  m('elig-mode', RUN, ["if (!generalModeOn(mode)) return off('mode_focused')", "if (false) return off('mode_focused')"], RUN_T, 'eligibility: mode focused'),
  m('elig-extended-only', RUN, ["if (c.kindSet !== 'extended') return off('not_extended')", "if (false) return off('not_extended')"], RUN_T, 'eligibility: legacy meeting'),
  m('elig-armed', RUN, ["if (!c.armed) return off('not_armed')", "if (false) return off('not_armed')"], RUN_T, 'eligibility: meeting not armed'),
  m('elig-paused', RUN, ["if (c.paused) return off('paused')", "if (false) return off('paused')"], RUN_T, 'eligibility: meeting paused'),
  m('elig-public-topics', RUN, ["if (!publicTopics) return { ok: false, state: 'needs_public_topics', reason: 'public_topics_off' }", "if (false) return { ok: false, state: 'needs_public_topics', reason: 'public_topics_off' }"], RUN_T, 'eligibility: public topics consent off'),
  m('elig-personal-domain', RUN, ["if (c.domain?.trim().toLowerCase() === 'personal')", 'if (false)'], RUN_T, 'eligibility: personal domain'),
  m('elig-personal-case-and-space', RUN, ["c.domain?.trim().toLowerCase() === 'personal'", "c.domain === 'personal'"], RUN_T, 'personal domain in any case'),
  m('elig-unknown-domain-eligible', RUN, ["if (c.domain?.trim().toLowerCase() === 'personal')", "if (c.domain === null || c.domain?.trim().toLowerCase() === 'personal')"], RUN_T, 'unconfirmed (null) domain is eligible'),
  m('elig-recheck-before-search', RUN, ["if (!this.live(c.sessionId)) return this.done(row, 'no_cue', 'not_eligible')\n", "if (false) return this.done(row, 'no_cue', 'not_eligible')\n"], RUN_T, 're-check before the search'),
  m('elig-recheck-before-emit', RUN, ["if (!this.live(c.sessionId)) return this.done(row, 'no_cue', 'not_eligible', 4)", "if (false) return this.done(row, 'no_cue', 'not_eligible', 4)"], RUN_T, 're-check before emit'),
  m('live-reads-fresh-mode', RUN, ['generalEligibility(c, this.settings.cueMode(), this.settings.publicTopics()).ok\n  }', 'generalEligibility(c, "general", true).ok\n  }'], RUN_T, 're-check before'),
  // ── Tick ──
  m('tick-interval', RUN, ['if (nowMs - (rec.lastTickAt ?? rec.firstSeenAt) < lim.intervalSeconds * 1000) continue', 'if (false) continue'], RUN_T, 'waits one interval'),
  m('tick-interval-from-settings', RUN, ['< lim.intervalSeconds * 1000) continue', '< 300_000) continue'], RUN_T, 'interval from the settings'),
  m('tick-first-seen-now', RUN, ['rec = { firstSeenAt: nowMs, lastTickAt: null', 'rec = { firstSeenAt: 0, lastTickAt: null'], RUN_T, 'waits one interval'),
  m('tick-ineligible-forgotten', RUN, ['if (!generalEligibility(c, mode, publicTopics).ok) { this.seen.delete(c.sessionId); continue }', 'if (!generalEligibility(c, mode, publicTopics).ok) { continue }'], RUN_T, 'unpaused mid-meeting'),
  m('tick-mode-off-forgets', RUN, ["{ this.abortAll('mode_changed'); this.seen.clear(); return { ran: false, why: 'mode_off' } }", "{ this.abortAll('mode_changed'); return { ran: false, why: 'mode_off' } }"], RUN_T, 'mode switched on mid-meeting'),
  m('tick-mode-off-aborts', RUN, ["{ this.abortAll('mode_changed'); this.seen.clear(); return { ran: false, why: 'mode_off' } }", "{ this.seen.clear(); return { ran: false, why: 'mode_off' } }"], RUN_T, 'a tick in focused mode also aborts'),
  m('tick-min-new-speech', RUN, ['if (c.transcriptChars - rec.lastTickChars < LIVE_CUES_GENERAL_LIMITS.minNewTranscriptChars) continue', 'if (false) continue'], RUN_T, '90 s of new speech'),
  m('tick-min-new-speech-edge', RUN, ['rec.lastTickChars < LIVE_CUES_GENERAL_LIMITS.minNewTranscriptChars', 'rec.lastTickChars <= LIVE_CUES_GENERAL_LIMITS.minNewTranscriptChars'], RUN_T, '90 s of new speech'),
  m('tick-min-new-speech-since-last-tick', RUN, ['    rec.lastTickChars = c.transcriptChars\n', '\n'], RUN_T, '90 s of new speech'),
  m('tick-min-new-speech-1200', RUN, ['minNewTranscriptChars: 1_200', 'minNewTranscriptChars: 600'], RUN_T, '90 s of new speech'),
  m('tick-oldest-first', RUN, ['due.sort((a, b) => (this.seen.get(a.sessionId)!.lastTickAt ?? 0) - (this.seen.get(b.sessionId)!.lastTickAt ?? 0))', 'due.sort(() => 0)'], RUN_T, 'waited longest'),
  m('tick-single-flight', RUN, ["if (this.inFlight) return { ran: false, why: 'busy' }", 'if (false) return { ran: false, why: "busy" }'], RUN_T, 'one attempt in flight server-wide'),
  m('tick-single-flight-released', RUN, ['      this.inFlight = null\n      if (run.usd > 0)', '      if (run.usd > 0)'], RUN_T, 'released after a cancel'),
  m('tick-host-error-ends-pass', RUN, ["catch { return { ran: false, why: 'host_error' } }", "catch { throw new Error('host_error') }"], RUN_T, 'host that throws'),
  m('tick-forgets-vanished-meeting', RUN, ['for (const id of [...this.seen.keys()]) if (!present.has(id)) this.seen.delete(id)\n', '\n'], RUN_T, 'no longer lists'),
  m('start-idempotent', RUN, ['    if (this.timer) return\n    this.timer = setInterval', '    this.timer = setInterval'], RUN_T, 'start polls on a timer'),
  m('poll-15s', RUN, ['pollMs: 15_000', 'pollMs: 1_000'], RUN_T, 'start polls on a timer'),
  m('stop-aborts', RUN, ["    this.timer = null\n    this.abortAll('stopped')", '    this.timer = null'], RUN_T, 'stop() aborts'),
  // ── Sensitive window ──
  m('sensitive-skip-runs', RUN, ['if (sensitive) { rec.last', 'if (false) { rec.last'], RUN_T, 'sensitive window'),
  m('window-skip-ignores-vocabulary', RUN, ['const sensitive = sensitiveWindow(window)', "const sensitive = sensitiveWindow(window) ?? (/frobnitz/i.test(window) ? 'funeral' : null)"], RUN_T, 'vocabulary never skips a window'),
  m('sensitive-skip-before-trigger', RUN, [
    ["    const sensitive = sensitiveWindow(window)\n    if (sensitive) { rec.last = { state: 'withheld', reason: 'sensitive_window' }; return this.done(row, 'no_cue', `sensitive:${sensitive}`) }\n", ''],
    ["    const trigger = await raceAbort(this.deps.jevTrigger(c.title, window, signal), signal)\n", "    const sensitive = sensitiveWindow(window)\n    const trigger = await raceAbort(this.deps.jevTrigger(c.title, window, signal), signal)\n    if (sensitive) { rec.last = { state: 'withheld', reason: 'sensitive_window' }; return this.done(row, 'no_cue', `sensitive:${sensitive}`) }\n"]], RUN_T, 'sensitive window'),
  m('window-redacted', RUN, ['const window = redactSecrets(c.window(LIVE_CUES_GENERAL_LIMITS.topicWindowChars))', 'const window = c.window(LIVE_CUES_GENERAL_LIMITS.topicWindowChars)'], RUN_T, 'redacted'),
  m('window-three-minutes', RUN, ['topicWindowChars: 2_700', 'topicWindowChars: 6_000'], RUN_T, 'last 2,700 characters'),
  m('sensitive-whole-words', TOPIC, ['`\\\\b(?:${words.map', '`(?:${words.map'], TOPIC_T, 'look-alike'),
  m('sensitive-category-loop', TOPIC, ['for (const [category, re] of SENSITIVE) if (re.test(t)) return category', 'void SENSITIVE'], TOPIC_T, 'skips a'),
  ...categoryMutants,
  // ── Trigger ──
  m('trigger-threshold', RUN, ['if (!(trigger.pGeneral >= lim.trigger))', 'if (false)'], RUN_T, 'below the threshold'),
  m('trigger-threshold-edge', RUN, ['trigger.pGeneral >= lim.trigger', 'trigger.pGeneral > lim.trigger'], RUN_T, 'at the threshold'),
  m('trigger-nan-never-passes', RUN, ['if (!(trigger.pGeneral >= lim.trigger))', 'if (trigger.pGeneral < lim.trigger)'], RUN_T, 'non-numeric'),
  m('trigger-gets-title', RUN, ['this.deps.jevTrigger(c.title, window, signal)', "this.deps.jevTrigger('', window, signal)"], RUN_T, 'given the title'),
  m('trigger-wording-instructions', PROMPTS, ['Is the room on a topic where an interesting public fact', 'Is the room on a topic where a public fact'], PROMPTS_T, 'wording the offline replay measured'),
  m('trigger-wording-yes', PROMPTS, ['where one interesting public fact would be worth a glance now.', 'where a public fact would be worth a glance.'], PROMPTS_T, 'wording the offline replay measured'),
  m('trigger-wording-no', PROMPTS, ['or too vague for a public fact to add anything.', 'or too vague.'], PROMPTS_T, 'wording the offline replay measured'),
  m('trigger-question-key', PROMPTS, ['  general_topic: {\n    type', '  topic: {\n    type'], PROMPTS_T, 'wording the offline replay measured'),
  m('trigger-reads-yes', PROMPTS, ['probabilities?.yes', 'probabilities?.no'], PROMPTS_T, 'trigger question'),
  m('trigger-window-2200', PROMPTS, ['redactSecrets(window).slice(-GENERAL_TRIGGER_WINDOW_CHARS)', 'redactSecrets(window)'], PROMPTS_T, '2,200'),
  m('trigger-window-redacted', PROMPTS, ['window: redactSecrets(window).slice(-GENERAL_TRIGGER_WINDOW_CHARS)', 'window: window.slice(-GENERAL_TRIGGER_WINDOW_CHARS)'], PROMPTS_T, '2,200'),
  m('trigger-nonfinite-is-zero', PROMPTS, ['return { pGeneral: Number.isFinite(p) ? p : 0, tokens: res.inputTokens }', 'return { pGeneral: p, tokens: res.inputTokens }'], PROMPTS_T, 'missing or non-finite'),
  // ── Topic parser ──
  m('topic-parse-boolean', PROMPTS, ["typeof v.topic !== 'boolean'", 'v.topic === undefined'], PROMPTS_T, 'is strict'),
  m('topic-parse-category', PROMPTS, ["|| !(GENERAL_CATEGORIES as readonly string[]).includes(v.category)", ''], PROMPTS_T, 'is strict'),
  m('topic-parse-query', PROMPTS, ["if (typeof v.query !== 'string' || !v.query.trim() || v.query.length > TOPIC_RAW_MAX) return 'unparseable'", ''], PROMPTS_T, 'is strict'),
  // ── Admission ──
  m('admit-empty', TOPIC, ["if (!query) return { ok: false, reason: 'empty' }", ''], TOPIC_T, 'empty query'),
  m('admit-too-long', TOPIC, ['if (query.length > GENERAL_QUERY_MAX_CHARS)', 'if (false)'], TOPIC_T, '80 characters'),
  m('admit-too-long-edge', TOPIC, ['if (query.length > GENERAL_QUERY_MAX_CHARS)', 'if (query.length >= GENERAL_QUERY_MAX_CHARS)'], TOPIC_T, '80 characters'),
  m('admit-max-chars-80', TOPIC, ['GENERAL_QUERY_MAX_CHARS = 80', 'GENERAL_QUERY_MAX_CHARS = 100'], TOPIC_T, '80 characters'),
  m('admit-too-many-words', TOPIC, ['if (query.split(\' \').length > GENERAL_QUERY_MAX_WORDS)', 'if (false)'], TOPIC_T, '8 words'),
  m('admit-max-words-8', TOPIC, ['GENERAL_QUERY_MAX_WORDS = 8', 'GENERAL_QUERY_MAX_WORDS = 12'], TOPIC_T, '8 words'),
  m('admit-digit', TOPIC, ["if (/\\p{Nd}/u.test(query)) return { ok: false, reason: 'digit' }", ''], TOPIC_T, 'rejects any digit'),
  m('admit-digit-ascii-only', TOPIC, ['/\\p{Nd}/u.test(query)', '/[0-9]/.test(query)'], TOPIC_T, 'rejects any digit'),
  m('admit-number-word', TOPIC, ["if (NUMBER_WORD.test(folded)) return { ok: false, reason: 'number_word' }", ''], TOPIC_T, 'number word'),
  m('admit-characters', TOPIC, ["if (!QUERY_CHARS.test(query)) return { ok: false, reason: 'characters' }", ''], TOPIC_T, 'operators, quotes and urls'),
  m('admit-url', TOPIC, ["if (URLISH.test(folded)) return { ok: false, reason: 'url' }", ''], TOPIC_T, 'operators, quotes and urls'),
  m('admit-secret', TOPIC, ["if (query !== redactSecrets(query)) return { ok: false, reason: 'secret' }", ''], TOPIC_T, 'rejects a secret'),
  m('admit-deny-list', TOPIC, ['if (PRIVATE_QUERY.test(folded) || SENSITIVE_ALL.test(folded))', 'if (false)'], TOPIC_T, 'deny-list word'),
  m('admit-deny-list-ask-words', TOPIC, ['if (PRIVATE_QUERY.test(folded) || SENSITIVE_ALL.test(folded))', 'if (SENSITIVE_ALL.test(folded))'], TOPIC_T, 'deny-list word'),
  m('admit-deny-list-private-life', TOPIC, ['if (PRIVATE_QUERY.test(folded) || SENSITIVE_ALL.test(folded))', 'if (PRIVATE_QUERY.test(folded))'], TOPIC_T, 'deny-list word'),
  m('admit-name', TOPIC, ["if (words.some(w => ctx.nameWords.has(w) || ctx.nameWords.has(stemWord(w)))) return { ok: false, reason: 'name' }", ''], TOPIC_T, 'name word'),
  m('admit-name-plural', TOPIC, ['ctx.nameWords.has(w) || ctx.nameWords.has(stemWord(w))', 'ctx.nameWords.has(w)'], TOPIC_T, 'name word'),
  m('admit-repeat', TOPIC, ["if (ctx.recent.has(normalized)) return { ok: false, reason: 'repeat' }", ''], TOPIC_T, 'repeat'),
  m('admit-repeat-normalized', TOPIC, ['if (ctx.recent.has(normalized))', 'if (ctx.recent.has(query))'], TOPIC_T, 'repeat'),
  m('names-owner-and-label', TOPIC, ['try { names.push(src.ownerName(), src.speakerLabel()) } catch { /* no profile */ }', ''], TOPIC_T, 'collects the owner and their label'),
  m('names-window-labels', TOPIC, ['names.push(m[1])', 'void m'], TOPIC_T, 'speaker labels that open window lines'),
  m('names-generic-labels', TOPIC, ['names.filter(n => !isGenericSpeakerLabel(n))', 'names'], TOPIC_T, 'never a generic label'),
  m('names-no-vocabulary-words', TOPIC, ['try { names.push(src.ownerName(), src.speakerLabel()) } catch { /* no profile */ }', 'try { names.push(src.ownerName(), src.speakerLabel(), ...src.vocabulary()) } catch { /* no profile */ }'], TOPIC_T, 'word by word'),
  m('names-no-domain-keyword-words', TOPIC, ['try { names.push(src.ownerName(), src.speakerLabel()) } catch { /* no profile */ }', 'try { names.push(src.ownerName(), src.speakerLabel(), ...Object.values(src.domainKeywords()).flat()) } catch { /* no profile */ }'], TOPIC_T, 'word by word'),
  m('admit-owner-term', TOPIC, ["  if (ctx.terms.some(t => padded.includes(` ${t.join(' ')} `))) return { ok: false, reason: 'owner_term' }\n", ''], TOPIC_T, 'owner term: rejects a query that carries a WHOLE'),
  m('admit-owner-term-in-order', TOPIC, ["ctx.terms.some(t => padded.includes(` ${t.join(' ')} `))", 'ctx.terms.some(t => t.every(w => padded.includes(` ${w} `)))'], TOPIC_T, 'owner term: a query with just one word'),
  m('admit-owner-term-not-per-word', TOPIC, ["ctx.terms.some(t => padded.includes(` ${t.join(' ')} `))", 'ctx.terms.some(t => t.some(w => padded.includes(` ${w} `)))'], TOPIC_T, 'owner term: a query with just one word'),
  m('admit-owner-term-word-boundary', TOPIC, ["padded.includes(` ${t.join(' ')} `)", "padded.includes(t.join(' '))"], TOPIC_T, 'owner term: matches whole words'),
  m('admit-owner-term-stemmed', TOPIC, ["const padded = ` ${words.map(stemWord).join(' ')} `", "const padded = ` ${words.join(' ')} `"], TOPIC_T, 'owner term: matches whole words'),
  m('terms-from-vocabulary', TOPIC, ["export function ownerTermPhrases(src: ProfileNameSource = realProfileNames): string[][] {\n  const raw: string[] = []\n  try { raw.push(...src.vocabulary()) } catch { /* no vocabulary */ }\n", "export function ownerTermPhrases(src: ProfileNameSource = realProfileNames): string[][] {\n  const raw: string[] = []\n"], TOPIC_T, 'lists every vocabulary term'),
  m('joins-from-vocabulary', TOPIC, ["export function ownerTermJoins(src: ProfileNameSource = realProfileNames): string[] {\n  const raw: string[] = []\n  try { raw.push(...src.vocabulary()) } catch { /* no vocabulary */ }\n", "export function ownerTermJoins(src: ProfileNameSource = realProfileNames): string[] {\n  const raw: string[] = []\n"], TOPIC_T, 'also lists each term with its spaces taken out'),
  m('terms-from-domain-keyword-values', TOPIC, ["...(Array.isArray(words) ? words.filter(w => typeof w === 'string') : [])) } catch { /* none */ }\n  const seen", ") } catch { /* none */ }\n  const seen"], TOPIC_T, 'lists every vocabulary term'),
  m('joins-from-domain-keyword-values', TOPIC, ["...(Array.isArray(words) ? words.filter(w => typeof w === 'string') : [])) } catch { /* none */ }\n  return [...new Set", ") } catch { /* none */ }\n  return [...new Set"], TOPIC_T, 'also lists each term with its spaces taken out'),
  m('terms-from-domain-names', TOPIC, ["raw.push(domain.replace(/_/g, ' '), ...(Array.isArray(words) ? words.filter(w => typeof w === 'string') : [])) } catch { /* none */ }\n  const seen", "raw.push(...(Array.isArray(words) ? words.filter(w => typeof w === 'string') : [])) } catch { /* none */ }\n  const seen"], TOPIC_T, 'lists every vocabulary term'),
  m('joins-from-domain-names', TOPIC, ["raw.push(domain.replace(/_/g, ' '), ...(Array.isArray(words) ? words.filter(w => typeof w === 'string') : [])) } catch { /* none */ }\n  return [...new Set", "raw.push(...(Array.isArray(words) ? words.filter(w => typeof w === 'string') : [])) } catch { /* none */ }\n  return [...new Set"], TOPIC_T, 'also lists each term with its spaces taken out'),
  m('terms-stemmed', TOPIC, ['const words = factWords(fold(term)).map(stemWord), key', 'const words = factWords(fold(term)), key'], TOPIC_T, 'lists every vocabulary term'),
  m('terms-min-three-characters', TOPIC, ["if (key.replace(/ /g, '').length < 3 || seen.has(key)) continue", 'if (seen.has(key)) continue'], TOPIC_T, 'ignores a term under three characters'),
  m('terms-deduped', TOPIC, ["if (key.replace(/ /g, '').length < 3 || seen.has(key)) continue", "if (key.replace(/ /g, '').length < 3) continue"], TOPIC_T, 'ignores a term under three characters'),
  m('local-area-label-check', TOPIC, ['if (!label || !HOME_AREA_LABEL.test(label)) return null', 'if (!label) return null'], TOPIC_T, 'appends nothing unless'),
  m('local-area-comma', TOPIC, ["label.replace(/,/g, '')", 'label'], TOPIC_T, 'without its comma'),
  m('hash-12-hex', TOPIC, ['.digest(\'hex\').slice(0, 12)', ".digest('hex').slice(0, 16)"], TOPIC_T, 'first 12 hex'),
  // ── Admission, as the runner applies it ──
  m('run-admission-names', RUN, ['nameWords, terms: ownerTermPhrases(profile)', 'nameWords: new Set<string>(), terms: ownerTermPhrases(profile)'], RUN_T, 'admission:'),
  m('run-admission-host-speakers', RUN, ['blockedNameWords(window, c.speakerNames ?? [], profile)', 'blockedNameWords(window, [], profile)'], RUN_T, 'speaker name the host knows'),
  m('run-admission-terms', RUN, ['terms: ownerTermPhrases(profile), ', 'terms: [], '], RUN_T, 'admission: a whole vocabulary phrase'),
  m('run-admission-joins', RUN, ['joins: ownerTermJoins(profile), ', 'joins: [], '], RUN_T, 'a vocabulary phrase written without its spaces'),
  m('run-admission-whole-phrase', RUN, ['terms: ownerTermPhrases(profile), ', 'terms: ownerTermPhrases(profile).map(t => [t[0]]), '], RUN_T, 'owner term: a query with just one word'),
  m('run-admission-repeats', RUN, ['recent: this.recentQueries(c.sessionId, startedAt)', 'recent: new Set<string>()'], RUN_T, 'repeat:'),
  m('run-admission-rejection-ends', RUN, ["if (!admitted.ok) { row.queryHash = hashFor(admitted.reason, topic.query); return this.done(row, 'no_cue', `rejected:${admitted.reason}`, 2) }", ''], RUN_T, 'admission:'),
  m('run-repeat-cross-session-expiry', RUN, ['for (const [q, at] of this.crossQueries) if (nowMs - at >= LIVE_CUES_GENERAL_LIMITS.queryCacheMs) this.crossQueries.delete(q)\n', '\n'], RUN_T, 'repeat: another meeting'),
  m('run-repeat-cross-session-30min', RUN, ['queryCacheMs: 30 * 60_000', 'queryCacheMs: 10 * 60_000'], RUN_T, 'repeat: another meeting'),
  m('run-repeat-cross-session-cache', RUN, ['this.crossQueries.set(normalized, nowMs)\n', '\n'], RUN_T, 'repeat: another meeting'),
  m('run-repeat-per-meeting', RUN, ['...(this.meetingQueries.get(sessionId) ?? [])', '...[]'], RUN_T, 'never searches the same query twice'),
  m('run-repeat-noted-before-search', RUN, ['    this.noteQuery(c.sessionId, admitted.normalized, startedAt)\n', '\n'], RUN_T, 'repeat:'),
  m('run-local-only', RUN, ["if (topic.category === 'local') {", 'if (true) {'], RUN_T, 'never gets the home area'),
  m('run-local-no-area', RUN, ["if (withArea === null) { row.queryHash = queryHash(admitted.query); return this.done(row, 'no_cue', 'local_no_area', 2) }", ''], RUN_T, 'without a home area'),
  m('run-local-readmit', RUN, ["if (!again.ok) { row.queryHash = hashFor(again.reason, withArea); return this.done(row, 'no_cue', `rejected_local:${again.reason}`, 2) }", ''], RUN_T, 'appended query is admitted again'),
  m('run-local-uses-settings-area', RUN, ['withHomeArea(admitted.query, this.settings.homeArea())', "withHomeArea(admitted.query, 'Austin, TX')"], RUN_T, 'local:'),
  // ── Caps ──
  m('cap-daily-topic', RUN, ['if (s.topicCalls >= lim.dailyTopicCalls) return', 'if (false) return'], RUN_T, 'dailyTopicCalls'),
  m('cap-daily-topic-edge', RUN, ['s.topicCalls >= lim.dailyTopicCalls', 's.topicCalls > lim.dailyTopicCalls'], RUN_T, 'dailyTopicCalls'),
  m('cap-daily-search', RUN, ['if (s.webSearches >= lim.dailyWebSearches) return', 'if (false) return'], RUN_T, 'dailyWebSearches'),
  m('cap-daily-search-edge', RUN, ['s.webSearches >= lim.dailyWebSearches', 's.webSearches > lim.dailyWebSearches'], RUN_T, 'dailyWebSearches'),
  m('cap-attempts-per-meeting', RUN, ['if (m && m.attempts >= lim.attemptsPerMeeting) return', 'if (false) return'], RUN_T, 'attemptsPerMeeting'),
  m('cap-attempts-per-meeting-edge', RUN, ['m.attempts >= lim.attemptsPerMeeting', 'm.attempts > lim.attemptsPerMeeting'], RUN_T, 'attemptsPerMeeting'),
  m('cap-max-cues', RUN, ['if (m && m.cues >= lim.maxCuesPerMeeting) return', 'if (false) return'], RUN_T, 'maxCuesPerMeeting'),
  m('cap-max-cues-edge', RUN, ['m.cues >= lim.maxCuesPerMeeting', 'm.cues > lim.maxCuesPerMeeting'], RUN_T, 'maxCuesPerMeeting'),
  m('cap-blocked-before-trigger', RUN, ['      const block = this.blocked(c.sessionId, lim, nowMs)\n      if (block) { this.traceSkip(c.sessionId, block.reason, nowMs); continue }\n', ''], RUN_T, 'cap:'),
  m('cap-attempt-counted', RUN, ['attempts: m.attempts + 1, at: this.now() }', 'attempts: m.attempts, at: this.now() }'], RUN_T, 'attemptsPerMeeting'),
  m('cap-topic-store-daily', RUN, ["if (s.topicCalls >= caps.daily) return 'daily_cap'", ''], RUN_T, 'charges a topic call against'),
  m('cap-topic-store-meeting', RUN, ["if (m.attempts >= caps.perMeeting) return 'meeting_cap'", ''], RUN_T, 'charges a topic call against'),
  m('cap-search-store-daily', RUN, ["if (r.state.webSearches >= cap) return 'daily_cap'", ''], RUN_T, 'charges a web search against'),
  m('cap-topic-charged-counts-daily', RUN, ['    s.topicCalls += 1\n', '\n'], RUN_T, 'charges a topic call against'),
  m('cap-search-charged-counts-daily', RUN, ['    r.state.webSearches += 1\n', '\n'], RUN_T, 'charges a web search against'),
  m('cap-cue-recorded', RUN, ['    this.store.recordCue(c.sessionId)\n', '\n'], RUN_T, 'maxCuesPerMeeting'),
  m('cap-cue-recorded-in-store', RUN, ['cues: m.cues + 1, at: this.now() }', 'cues: m.cues, at: this.now() }'], RUN_T, 'records a cue'),
  m('cap-topic-charged-before-call', RUN, [
    ["    const charged = this.store.chargeTopic(c.sessionId, { daily: lim.dailyTopicCalls, perMeeting: lim.attemptsPerMeeting })\n    if (charged !== 'ok') return this.done(row, 'no_cue', `cap:${charged}`)\n    run.stage = 2\n", '    run.stage = 2\n'],
    ['    run.usd += topicOut.costUsd ?? 0\n', "    run.usd += topicOut.costUsd ?? 0\n    this.store.chargeTopic(c.sessionId, { daily: lim.dailyTopicCalls, perMeeting: lim.attemptsPerMeeting })\n"]], RUN_T, 'charge before call: the topic call and the search'),
  m('cap-topic-charge-refusal-ends', RUN, ["    if (charged !== 'ok') return this.done(row, 'no_cue', `cap:${charged}`)\n", '\n'], RUN_T, 'finds the topic cap reached'),
  m('cap-search-charged-before-call', RUN, [
    ["    const paid = this.store.chargeSearch(lim.dailyWebSearches)\n    if (paid !== 'ok') return this.done(row, 'no_cue', `cap:${paid}`)\n", ''],
    ['    row.searchMs = this.deps.now() - t0\n', '    row.searchMs = this.deps.now() - t0\n    this.store.chargeSearch(lim.dailyWebSearches)\n']], RUN_T, 'charge before call: the topic call and the search'),
  m('cap-search-charge-refusal-ends', RUN, ["    if (paid !== 'ok') return this.done(row, 'no_cue', `cap:${paid}`)\n", '\n'], RUN_T, 'finds the cap reached'),
  m('cap-failed-call-still-charged', RUN, ['    s.topicCalls += 1\n    s.meetings[sessionId] = { ...m, attempts: m.attempts + 1, at: this.now() }\n    return this.write(s) ?', '    return this.write(s) ?'], RUN_T, 'charge before call'),
  // ── Fail closed, durable ──
  m('state-unreadable-blocks', RUN, ["if (!r.ok) return { state: 'capped', reason: 'state_unreadable' }", ''], RUN_T, 'unreadable state file'),
  m('state-only-enoent-is-fresh', RUN, ["      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, state: this.fresh(nowMs) }\n      return { ok: false }\n", '      return { ok: true, state: this.fresh(nowMs) }\n'], RUN_T, 'unparseable file'),
  m('state-schema-version', RUN, ['if (!isRecord(raw) || raw.v !== 1) return { ok: false }', 'if (!isRecord(raw)) return { ok: false }'], RUN_T, 'wrong schema version'),
  m('state-future-day', RUN, ['|| raw.day > today) return { ok: false }', ') return { ok: false }'], RUN_T, 'a future day'),
  m('state-whole-numbers', RUN, ['Number.isSafeInteger(v) && v >= 0', 'Number.isSafeInteger(v)'], RUN_T, 'a negative count'),
  m('state-integer-counts', RUN, ['Number.isSafeInteger(v) && v >= 0', 'typeof v === "number" && v >= 0'], RUN_T, 'a fractional count'),
  m('state-valid-zone', RUN, ["const zone = validZone(raw.zone), today = zone ? localDay(nowMs, zone) : ''\n    if (!zone ||", "const zone = String(raw.zone), today = localDay(nowMs, 'UTC')\n    if ("], RUN_T, 'an invalid zone'),
  m('state-meeting-attempts-valid', RUN, ['!whole(m.attempts) || ', ''], RUN_T, 'a damaged meeting entry (attempts)'),
  m('state-meeting-cues-valid', RUN, ['!whole(m.cues) || ', ''], RUN_T, 'a damaged meeting entry (cues)'),
  m('state-meeting-time-valid', RUN, ["|| typeof m.at !== 'number' || !Number.isFinite(m.at)) return { ok: false }", ') return { ok: false }'], RUN_T, 'a damaged meeting entry (time)'),
  m('state-breaker-valid', RUN, ['|| b.stage > STAGES.length', ''], RUN_T, 'a damaged breaker'),
  m('state-day-rollover', RUN, ['const rolled = raw.day < today', 'const rolled = false'], RUN_T, 'per local day'),
  m('state-meeting-ttl', RUN, ['if (m.at >= nowMs - LIVE_CUES_GENERAL_LIMITS.counterTtlMs) meetings[id] =', 'meetings[id] ='], RUN_T, 'counters expire after a day'),
  m('state-meeting-ttl-24h', RUN, ['counterTtlMs: 24 * 60 * 60_000', 'counterTtlMs: 12 * 60 * 60_000'], RUN_T, 'counters expire after a day'),
  m('state-breaker-closes-lazily', RUN, ['const open = b.openUntil !== null && b.openUntil > nowMs', 'const open = b.openUntil !== null'], RUN_T, 'closes after the hour'),
  m('state-write-private', RUN, ["durableAtomicWriteFileSync(this.file, JSON.stringify(s) + '\\n', { mode: 0o600 })", "durableAtomicWriteFileSync(this.file, JSON.stringify(s) + '\\n', { mode: 0o644 })"], RUN_T, 'state file is private'),
  m('state-write-failure-is-false', RUN, ['    } catch { return false }\n  }\n  /** Charge one topic call', '    } catch { return true }\n  }\n  /** Charge one topic call'], RUN_T, 'cannot be written'),
  m('state-clean-writes-only-on-streak', RUN, ['if (b.failures > 0 && depth >= b.stage) {', 'if (depth >= b.stage) {'], RUN_T, 'writes nothing when there is no streak'),
  m('state-persisted-across-runners', RUN, ['this.store = new GeneralCueStore(deps.statePath, () => deps.now())', 'this.store = new GeneralCueStore(deps.statePath + Math.random(), () => deps.now())'], RUN_T, 'caps are durable'),
  // ── Breaker ──
  m('breaker-opens-at-three', RUN, ['b.failures >= LIVE_CUES_GENERAL_LIMITS.breakerFailures', 'b.failures > LIVE_CUES_GENERAL_LIMITS.breakerFailures'], RUN_T, 'three consecutive failures'),
  m('breaker-not-at-two', RUN, ['b.failures >= LIVE_CUES_GENERAL_LIMITS.breakerFailures', 'b.failures >= 2'], RUN_T, 'two failures do not open it'),
  m('breaker-one-hour', RUN, ['openUntil: this.now() + LIVE_CUES_GENERAL_LIMITS.breakerMs }', 'openUntil: this.now() + 60_000 }'], RUN_T, 'three consecutive failures'),
  m('breaker-one-hour-constant', RUN, ['breakerMs: 60 * 60_000', 'breakerMs: 30 * 60_000'], RUN_T, 'three consecutive failures'),
  m('breaker-blocks-attempts', RUN, ["if (s.breaker.openUntil !== null && s.breaker.openUntil > nowMs) return { state: 'breaker', reason: 'breaker_open' }", ''], RUN_T, 'three consecutive failures'),
  m('breaker-quota-at-once', RUN, ['if (immediate || b.failures >=', 'if (b.failures >='], RUN_T, 'quota error opens it at once'),
  m('breaker-quota-detected', RUN, ["return this.fail(row, stage, 'quota', true)", "return this.fail(row, stage, 'quota', false)"], RUN_T, 'quota error opens it at once'),
  m('breaker-failure-recorded', RUN, ['    this.store.recordFailure(stage, immediate)\n', '\n'], RUN_T, 'three consecutive failures'),
  m('breaker-search-failure-counts', RUN, ["return this.fail(row, 'search', `search_${found.code}`)", "return this.done(row, 'no_cue', `search_${found.code}`)"], RUN_T, 'three consecutive failures'),
  m('breaker-deepest-stage', RUN, ['b.stage = Math.max(b.stage, stageRank(stage))', 'b.stage = 0'], RUN_T, 'stops earlier does not clear'),
  m('breaker-clean-needs-depth', RUN, ['if (b.failures > 0 && depth >= b.stage)', 'if (b.failures > 0)'], RUN_T, 'stops earlier does not clear'),
  m('breaker-clean-depth-edge', RUN, ['depth >= b.stage', 'depth > b.stage'], RUN_T, 'deeper than the failed stage'),
  m('breaker-clean-recorded', RUN, ['    if (depth > 0) this.store.recordClean(depth)\n', '\n'], RUN_T, 'reaches the writer clears the streak'),
  m('breaker-writer-null-is-clean', RUN, ["if (typeof insight === 'string') return this.done(row, 'no_cue', `writer_${insight}`, 4)", "if (typeof insight === 'string') return this.done(row, 'no_cue', `writer_${insight}`)"], RUN_T, 'answers null clears a streak of writer failures'),
  m('breaker-quiet-jev-stops', RUN, ['&& QUIET_DECISION_CODES.has(error.code)) {', '&& false) {'], RUN_T, 'quiet stop'),
  m('breaker-quiet-sees-decision-errors', RUN, ['if ((error instanceof JevError || error instanceof DecisionProviderError) && QUIET', 'if ((error instanceof JevError) && QUIET'], RUN_T, 'quiet stop'),
  m('breaker-cancel-is-not-failure', RUN, ['if (isCancel(error, signal)) {', 'if (false) {'], RUN_T, 'cancel, not a failure'),
  m('breaker-wall-is-failure', RUN, ["if (signal.aborted && signal.reason === WALL) return this.fail(row, stage, 'wall_timeout')", ''], RUN_T, 'has a wall'),
  m('breaker-stage-of-failure', RUN, ["const stage = STAGES[Math.max(1, run.stage) - 1]", 'const stage = STAGES[0]'], RUN_T, 'at the writer stage'),
  m('wall-150s', RUN, ['attemptWallMs: 150_000', 'attemptWallMs: 150_000_000'], RUN_T, 'has a wall'),
  m('wall-armed', RUN, ['const wall = setTimeout(() => abort.abort(WALL), LIVE_CUES_GENERAL_LIMITS.attemptWallMs)', 'const wall = setTimeout(() => {}, LIVE_CUES_GENERAL_LIMITS.attemptWallMs)'], RUN_T, 'has a wall'),
  // ── Search ──
  m('search-source-url-check', RUN, ['const url = publicHttpsUrl(s?.url)', "const url = typeof s?.url === 'string' ? s.url : null"], RUN_T, 'only https public sources'),
  m('search-source-cue-log-check', RUN, ['const url = publicHttpsUrl(s?.url)', "const url = typeof s?.url === 'string' && s.url.startsWith('https://') ? s.url : null"], RUN_T, 'cue log\'s https check'),
  m('search-no-sources-is-failure', RUN, ["return sources.length ? { ok: true, sources } : { ok: false, code: 'no_sources' }", 'return { ok: true, sources }'], RUN_T, 'no https source is a failure'),
  m('search-throw-is-failure', RUN, ["return { ok: false, code: timedOut ? 'timeout' : 'error' }", "return { ok: false, code: 'timeout' }"], RUN_T, 'a throw is a failure'),
  m('search-wall-60s', RUN, ['searchWallMs: 60_000', 'searchWallMs: 600_000'], RUN_T, 'production wall is 60 s'),
  m('search-wall-fires', RUN, ['timedOut = true; own.abort() }, wallMs)', 'timedOut = true }, wallMs)'], RUN_T, 'wall times out'),
  m('search-parent-abort-is-cancel', RUN, ["if (parent.aborted) return { ok: false, code: 'aborted' }", ''], RUN_T, "caller's abort"),
  m('search-parent-abort-reaches-search', RUN, ["parent.addEventListener('abort', onAbort, { once: true })", ''], RUN_T, "caller's abort"),
  m('search-five-sources', RUN, ['writerSources: 5', 'writerSources: 8'], RUN_T, 'at most five sources'),
  m('search-source-text-cut', RUN, ['.slice(0, GENERAL_INSIGHT_SOURCE_CHARS)', ''], RUN_T, 'at most five sources'),
  m('search-source-redacted', RUN, ["title: redactSecrets(String(s.title ?? '')).slice(0, 160)", "title: String(s.title ?? '').slice(0, 160)"], RUN_T, 'at most five sources'),
  m('search-race-abort', RUN, ["const onAbort = () => reject(abortError())", 'const onAbort = () => {}'], RUN_T, 'ignores its signal'),
  // ── Writer and emit ──
  m('writer-gets-context', RUN, ['context: window.slice(-GENERAL_INSIGHT_CONTEXT_CHARS) })', "context: '' })"], RUN_T, 'tail of the window that passed'),
  m('writer-context-from-checked-window', RUN, ['context: window.slice(-GENERAL_INSIGHT_CONTEXT_CHARS) })', 'context: c.window(GENERAL_INSIGHT_CONTEXT_CHARS) })'], RUN_T, 'tail of the window that passed'),
  m('writer-parse-enforced', RUN, ["if (typeof insight === 'string') return this.done(row, 'no_cue', `writer_${insight}`, 4)", ''], RUN_T, 'number guard'),
  m('emit-stale-dropped', RUN, ["if (this.deps.now() - startedAt > LIVE_CUES_GENERAL_LIMITS.staleMs) return this.done(row, 'no_cue', 'stale', 4)", ''], RUN_T, 'stale: a cue older than 180 s'),
  m('emit-stale-edge', RUN, ['this.deps.now() - startedAt > LIVE_CUES_GENERAL_LIMITS.staleMs', 'this.deps.now() - startedAt >= LIVE_CUES_GENERAL_LIMITS.staleMs'], RUN_T, 'exactly 180 s'),
  m('emit-stale-180s', RUN, ['staleMs: 180_000', 'staleMs: 600_000'], RUN_T, 'stale: a cue older than 180 s'),
  m('emit-stale-from-window', RUN, ['this.deps.now() - startedAt > LIVE_CUES_GENERAL_LIMITS.staleMs', 'this.deps.now() - t1 > LIVE_CUES_GENERAL_LIMITS.staleMs'], RUN_T, 'measured from the window'),
  m('emit-not-emitted-not-counted', RUN, ["if (!emitted) return this.done(row, 'no_cue', 'not_emitted', 4)", ''], RUN_T, 'does not emit is not counted'),
  m('emit-web-sources', RUN, ["kind: 'web' as const, url: s.url }", "kind: 'web' as const, url: s.url.replace('https://', 'http://') }"], RUN_T, 'emit: hands the host one insight'),
  m('emit-carries-query-and-category', RUN, ['category: topic.category, query: admitted.query,', "category: 'news', query: '',"], RUN_T, 'emit: hands the host one insight'),
  // ── Abort ──
  m('abort-mode-change', RUN, ["modeChanged(): void { if (!generalModeOn(this.settings.cueMode())) this.abortAll('mode_changed') }", 'modeChanged(): void { }'], RUN_T, 'abort on mode change'),
  m('abort-mode-change-only-when-off', RUN, ["if (!generalModeOn(this.settings.cueMode())) this.abortAll('mode_changed') }", "this.abortAll('mode_changed') }"], RUN_T, 'leaves the attempt alone'),
  m('abort-session-scoped', RUN, ['if (this.inFlight?.sessionId !== sessionId) return false', ''], RUN_T, "stops only that meeting's attempt"),
  m('abort-session-aborts', RUN, ['    this.inFlight.abort.abort(reason)\n    return true\n  }\n  /** Aborts whatever', '    return true\n  }\n  /** Aborts whatever'], RUN_T, "stops only that meeting's attempt"),
  m('abort-all', RUN, ['    this.inFlight.abort.abort(reason)\n    return true\n  }\n  /** The meeting ended', '    return true\n  }\n  /** The meeting ended'], RUN_T, 'abortAll stops whatever is in flight'),
  m('abort-end-session', RUN, ["    this.abortSession(sessionId, 'session_ended')\n    this.seen.delete(sessionId)", '    this.seen.delete(sessionId)'], RUN_T, 'endSession aborts'),
  // ── Trace ──
  m('trace-no-query-text', RUN, ['row.queryHash = queryHash(admitted.query)\n\n', 'row.queryHash = admitted.query\n\n'], RUN_T, 'never the query'),
  m('hash-only-for-benign-rejections', RUN, ['HASHABLE_REJECTIONS.has(reason) ? queryHash(q) : null', 'queryHash(q)'], RUN_T, 'keeps its hash'),
  m('hash-set-adds-a-private-reason', TOPIC, ["new Set(['repeat', 'too_long', 'too_many_words'])", "new Set(['repeat', 'too_long', 'too_many_words', 'digit'])"], TOPIC_T, 'a trace may carry a query hash only'),
  m('hash-set-drops-repeat', TOPIC, ["new Set(['repeat', 'too_long', 'too_many_words'])", "new Set(['too_long', 'too_many_words'])"], TOPIC_T, 'a trace may carry a query hash only'),
  m('trace-usd-sums-topic-and-writer', RUN, ['    run.usd += writerOut.costUsd ?? 0\n', '\n'], RUN_T, 'usd is the topic and writer model cost'),
  m('trace-skip-throttled', RUN, ['if (nowMs - (this.skipTracedAt.get(key) ?? 0) < LIVE_CUES_GENERAL_LIMITS.skipTraceEveryMs) return', 'if (false) return'], RUN_T, 'skip is traced once'),
  m('trace-skip-5min', RUN, ['skipTraceEveryMs: 5 * 60_000', 'skipTraceEveryMs: 60 * 60_000'], RUN_T, 'skip is traced once'),
  m('trace-best-effort', RUN, ['try { this.deps.trace?.(row) } catch { /* the trace is best effort */ }', 'this.deps.trace?.(row)'], RUN_T, 'trace that throws'),
  m('trace-pgeneral-recorded', RUN, ['row.pGeneral = Number.isFinite(trigger.pGeneral) ? Math.round(trigger.pGeneral * 1000) / 1000 : 0', 'row.pGeneral = null'], RUN_T, 'traces P'),
  // ── Status ──
  m('status-capped-reason', RUN, ["if (block) return { state: block.state, reason: block.reason, ...base }", ''], RUN_T, 'cap:'),
  // ── Real model calls ──
  m('wiring-topic-pinned-haiku', RUN, ["GENERAL_TOPIC_MODEL = 'claude-haiku-5-5'", "GENERAL_TOPIC_MODEL = 'claude-opus-5-5'"], RUN_T, 'wiring: the topic'),
  m('wiring-topic-source', RUN, ["source: 'live-cues-general-topic'", "source: 'live-cues-general'"], RUN_T, 'wiring: the topic call'),
  m('wiring-topic-runner', RUN, ["runLensGistEngine('claude', GENERAL_TOPIC_MODEL, prompt,", "runLensGistEngine('claude', 'claude-sonnet-5-5', prompt,"], RUN_T, 'wiring: the topic call'),
  m('wiring-writer-source', RUN, ["source: 'live-cues-general', maxOutputTokens: LIVE_CUES_GENERAL_LIMITS.writerMaxOutputTokens", "source: 'live-cues-v2', maxOutputTokens: LIVE_CUES_GENERAL_LIMITS.writerMaxOutputTokens"], RUN_T, 'wiring: the writer'),
  m('wiring-search-audit-caller', RUN, ["searchMeetingWeb(query, signal, { auditCaller: 'live_cues_general' })", 'searchMeetingWeb(query, signal)'], RUN_T, 'wiring: the search'),
  m('wiring-model-timeout', RUN, ['modelTimeoutMs: 20_000', 'modelTimeoutMs: 120_000'], RUN_T, 'wiring: the topic call'),
  m('wiring-output-caps', RUN, ['topicMaxOutputTokens: 150', 'topicMaxOutputTokens: 4000'], RUN_T, 'wiring: the topic call'),
  m('wiring-real-deps', RUN, ["topicModel: runGeneralTopicModel,", 'topicModel: (system, prompt, signal) => runGeneralWriterModel("claude-opus-5-5", system, prompt, signal),'], RUN_T, 'realGeneralDeps'),
  m('web-audit-caller-passed', WEB, ['options?.auditCaller ? { caller: options.auditCaller } : undefined', 'undefined'], WEB_T, 'audit caller'),
  m('web-audit-caller-default-untouched', WEB, ['options?.auditCaller ? { caller: options.auditCaller } : undefined', "{ caller: options?.auditCaller ?? 'meeting_ask_web' }"], WEB_T, 'audit caller'),
  // ── The engine hosts the runner ──
  m('host-extended-only', ENGINE, ["          if (s.kinds !== 'extended') continue\n", ''], ENGINE_T, 'offers extended meetings only'),
  m('host-needs-v2-on', ENGINE, ['        if (!this.enabled()) return []\n        const out: GeneralCueCandidate[] = []', '        const out: GeneralCueCandidate[] = []'], ENGINE_T, 'v2 switched off'),
  m('host-domain-from-orientation', ENGINE, ['domain = o?.domain ?? null; calendarTitle', 'domain = null; calendarTitle'], ENGINE_T, 'confirmed personal domain skips'),
  m('host-domain-unreadable-withholds', ENGINE, ['} catch { domainUnreadable = true }', '} catch { domain = null }'], ENGINE_T, 'cannot be READ'),
  m('host-armed-means-not-ended', ENGINE, ['armed: !this.deps.store.isEnded(s.sessionId)', 'armed: true'], ENGINE_T, 'ended'),
  m('host-paused', ENGINE, ['paused: this.deps.store.isPaused(s.sessionId), domain,', 'paused: false, domain,'], ENGINE_T, 'paused'),
  m('host-chars-counted', ENGINE, ['      s.charsFed += cleanWindow(text.trim()).length\n', ''], ENGINE_T, 'monotonic character count'),
  m('host-chars-offered', ENGINE, ['transcriptChars: s.charsFed', 'transcriptChars: 0'], ENGINE_T, 'monotonic character count'),
  m('host-window-cleaned', ENGINE, ["window: chars => cleanWindow(s.chunks.join('\\n')).slice(-chars)", "window: chars => s.chunks.join('\\n').slice(-chars)"], ENGINE_T, 'cleaned window'),
  m('host-window-tail', ENGINE, ["window: chars => cleanWindow(s.chunks.join('\\n')).slice(-chars)", "window: chars => cleanWindow(s.chunks.join('\\n')).slice(0, chars)"], ENGINE_T, 'cleaned window'),
  m('host-title', ENGINE, ['title: s.title, transcriptChars', "title: '', transcriptChars"], ENGINE_T, 'yields focused cues and an insight'),
  // ── The settings reader ──
  m('reader-interval', ENGINE, ['intervalSeconds: r.intervalSeconds.value, trigger', 'intervalSeconds: r.trigger.value, trigger'], ENGINE_T, 'maps the six saved limits'),
  m('reader-trigger', ENGINE, ['trigger: r.trigger.value,', 'trigger: r.intervalSeconds.value,'], ENGINE_T, 'maps the six saved limits'),
  m('reader-attempts', ENGINE, ['attemptsPerMeeting: r.attemptsPerMeeting.value,', 'attemptsPerMeeting: r.maxCuesPerMeeting.value,'], ENGINE_T, 'maps the six saved limits'),
  m('reader-max-cues', ENGINE, ['maxCuesPerMeeting: r.maxCuesPerMeeting.value,', 'maxCuesPerMeeting: r.attemptsPerMeeting.value,'], ENGINE_T, 'maps the six saved limits'),
  m('reader-daily-topic', ENGINE, ['dailyTopicCalls: r.dailyTopicCalls.value, dailyWebSearches', 'dailyTopicCalls: r.dailyWebSearches.value, dailyWebSearches'], ENGINE_T, 'maps the six saved limits'),
  m('reader-daily-search', ENGINE, ['dailyWebSearches: r.dailyWebSearches.value }', 'dailyWebSearches: r.dailyTopicCalls.value }'], ENGINE_T, 'maps the six saved limits'),
  m('reader-mode', ENGINE, ['cueMode: () => this.cueMode(),', "cueMode: () => 'general',"], ENGINE_T, 'maps the six saved limits'),
  m('reader-mode-from-resolved', ENGINE, ['private cueMode(): LiveCuesCueMode { return resolveLiveCuesCueMode(this.deps.env, this.deps.settings).value }', "private cueMode(): LiveCuesCueMode { return resolveLiveCuesCueMode({}, this.deps.settings).value }"], ENGINE_T, 'COS_LIVE_CUES_MODE=focused forces the mode'),
  m('reader-limits-resolved-with-env', ENGINE, ['const r = resolveLiveCuesGeneralLimits(this.deps.env, this.deps.settings)\n        return { intervalSeconds', 'const r = resolveLiveCuesGeneralLimits({}, this.deps.settings)\n        return { intervalSeconds'], ENGINE_T, 'locks a limit in the reader'),
  m('reader-consent-exact', ENGINE, ['return this.deps.publicTopics?.() === true }', 'return this.deps.publicTopics?.() !== false }'], ENGINE_T, 'unreadable or missing reads as off'),
  m('reader-consent-unreadable-is-off', ENGINE, ['return this.deps.publicTopics?.() === true } catch { return false } }', 'return this.deps.publicTopics?.() === true } catch { return true } }'], ENGINE_T, 'unreadable or missing reads as off'),
  m('reader-home-unreadable-is-null', ENGINE, ['return this.deps.homeArea?.() ?? null } catch { return null } }', "return this.deps.homeArea?.() ?? null } catch { return 'Austin, TX' } }"], ENGINE_T, 'throw read as null and off'),
  // ── The insight emit path ──
  m('emit-extended-only', ENGINE, ["if (!s || s.kinds !== 'extended' || this.deps.store.isEnded(sessionId)) return false", 'if (!s || this.deps.store.isEnded(sessionId)) return false'], ENGINE_T, 'emit refuses a legacy meeting'),
  m('emit-not-after-end', ENGINE, ["if (!s || s.kinds !== 'extended' || this.deps.store.isEnded(sessionId)) return false", "if (!s || s.kinds !== 'extended') return false"], ENGINE_T, 'emit refuses a legacy meeting'),
  m('emit-known-meeting', ENGINE, ["if (!s || s.kinds !== 'extended' || this.deps.store.isEnded(sessionId)) return false", "if (s!.kinds !== 'extended' || this.deps.store.isEnded(sessionId)) return false"], ENGINE_T, 'emit refuses a legacy meeting'),
  m('emit-validated', ENGINE, ['if (!isLiveCueV2(cue)) return false                                 // never emit what the companion would drop\n    const log', 'const log'], ENGINE_T, 'emit refuses a legacy meeting'),
  m('emit-kind-insight', ENGINE, ["headline: insight.headline, detail: insight.detail, kind: 'insight',", "headline: insight.headline, detail: insight.detail, kind: 'reinforce',"], ENGINE_T, 'yields focused cues and an insight'),
  m('emit-gate', ENGINE, ['gate: round(insight.gate), createdAt', 'gate: 0, createdAt'], ENGINE_T, 'yields focused cues and an insight'),
  m('emit-model-default', ENGINE, ['model: insight.model ?? liveCuesV2Model(this.deps.env) }', "model: insight.model ?? 'x' }"], ENGINE_T, 'emit refuses a legacy meeting'),
  m('emit-model-from-insight', ENGINE, ['model: insight.model ?? liveCuesV2Model(this.deps.env) }', 'model: liveCuesV2Model(this.deps.env) }'], ENGINE_T, 'yields focused cues and an insight'),
  m('emit-no-v1-twin', ENGINE, ["    s.insights.push(cue)\n    this.deps.emit('coaching_nudge_v2', cue as unknown as Record<string, unknown>)\n    return true", "    s.insights.push(cue)\n    this.deps.emit('coaching_nudge_v2', cue as unknown as Record<string, unknown>)\n    this.deps.emit('coaching_nudge', { nudge: cue.headline, type: 'challenge', priority: 2, cueId: cue.cueId, sessionId, protocol: 2 })\n    return true"], ENGINE_T, 'no v1 twin'),
  m('emit-own-list', ENGINE, ['    s.insights.push(cue)\n', '    s.cues.push(cue)\n'], ENGINE_T, 'previousCues'),
  m('emit-held', ENGINE, ['    s.insights.push(cue)\n', ''], ENGINE_T, 'in time order'),
  m('emit-sse', ENGINE, ["    s.insights.push(cue)\n    this.deps.emit('coaching_nudge_v2', cue as unknown as Record<string, unknown>)", '    s.insights.push(cue)'], ENGINE_T, 'yields focused cues and an insight'),
  m('emit-logged-general', ENGINE, ['general: { category: insight.category, query: insight.query },', 'general: { category: insight.category, query: "" },'], ENGINE_T, 'logs the insight with the general category'),
  m('emit-logged-sources', ENGINE, ['detail: cue.detail, gate: cue.gate,\n        sources: cue.sources, model', 'detail: cue.detail, gate: cue.gate,\n        sources: [], model'], ENGINE_T, 'logs the insight with the general category'),
  m('emit-log-failure-tolerated', ENGINE, ['      console.warn(`[live-cues-v2] insight log append failed: ${errMsg(error)}`)', '      throw error'], ENGINE_T, 'failed cue log append is not an emit failure'),
  m('emit-sets-cooldown', ENGINE, ['    s.insights.push(cue)\n    this.deps.emit', '    s.insights.push(cue); s.lastCueAt = cue.createdAt\n    this.deps.emit'], ENGINE_T, 'not the focused cooldown'),
  m('emit-counts-as-focused-cue', ENGINE, ['    s.insights.push(cue)\n    this.deps.emit', '    s.insights.push(cue); this.deps.store.recordCue(sessionId)\n    this.deps.emit'], ENGINE_T, 'per-meeting cue counter'),
  m('emit-takes-focused-slot', ENGINE, ['    s.insights.push(cue)\n    this.deps.emit', '    s.insights.push(cue); s.inFlight = new AbortController()\n    this.deps.emit'], ENGINE_T, 'still allowed right after an insight'),
  m('emit-trips-focused-breaker', ENGINE, ['    s.insights.push(cue)\n    this.deps.emit', '    s.insights.push(cue); s.failures = 3; s.breaker = true\n    this.deps.emit'], ENGINE_T, 'still allowed right after an insight'),
  // ── Cue mode and the focused cues ──
  m('mode-general-focused-off', ENGINE, ['    if (this.focusedOff(s)) return ', '    if (false) return '], ENGINE_T, 'cue mode general: a Mac meeting gets insights only'),
  m('mode-general-only-mac', ENGINE, ["return s.kinds === 'extended' && this.cueMode() === 'general' }", "return this.cueMode() === 'general' }"], ENGINE_T, 'a G2 meeting keeps its focused cues'),
  m('mode-general-only-in-general', ENGINE, ["return s.kinds === 'extended' && this.cueMode() === 'general' }", "return s.kinds === 'extended' }"], ENGINE_T, 'yields focused cues and an insight'),
  m('mode-all-keeps-focused', ENGINE, ["return s.kinds === 'extended' && this.cueMode() === 'general' }", "return s.kinds === 'extended' && this.cueMode() !== 'focused' }"], ENGINE_T, 'cue mode all runs both'),
  // ── Status ──
  m('status-general-field', ENGINE, ['      ...(general ? { general } : {}),\n', ''], ENGINE_T, 'shows the general state off'),
  m('status-general-read', ENGINE, ['general = this.general?.status(sessionId) ?? null', 'general = null'], ENGINE_T, 'shows the general state off'),
  m('status-cues-merged', ENGINE, ['cues: s ? this.allCues(s) : []', 'cues: s ? [...s.cues] : []'], ENGINE_T, 'in time order'),
  m('status-cues-in-time-order', ENGINE, ['[...s.cues, ...s.insights].sort((a, b) => a.createdAt - b.createdAt)', '[...s.cues, ...s.insights]'], ENGINE_T, 'in time order'),
  m('end-cues-merged', ENGINE, ['const cues = s ? this.allCues(s) : []', 'const cues = s ? [...s.cues] : []'], ENGINE_T, 'in time order'),
  m('end-v1-nudges-only-focused', ENGINE, ['const nudges = cues.flatMap(c => (isCueKind(c.kind) ?', 'const nudges = cues.flatMap(c => (true ?'], ENGINE_T, 'in time order'),
  m('end-nudges-generated-counts-nudges', ENGINE, ['return { nudgesGenerated: nudges.length, protocol: 2, cues, nudges }', 'return { nudgesGenerated: cues.length, protocol: 2, cues, nudges }'], ENGINE_T, 'the v1 nudges list has only focused cues'),
  m('find-cue-insights', ENGINE, ['    for (const s of this.sessions.values()) { const cue = s.insights.find(c => c.cueId === cueId); if (cue) return cue }\n', ''], ENGINE_T, 'findCue and feedback know an insight'),
  m('feedback-insights', ENGINE, ['held.cues.some(c => c.cueId === input.cueId) || held.insights.some(c => c.cueId === input.cueId))', 'held.cues.some(c => c.cueId === input.cueId))'], ENGINE_T, 'findCue and feedback know an insight'),
  // ── Hooks ──
  m('hook-end', ENGINE, ['    this.general?.endSession(sessionId)\n', ''], ENGINE_T, 'the end of the meeting'),
  m('hook-pause', ENGINE, ["this.general?.abortSession(sessionId, 'paused')", 'void 0'], ENGINE_T, 'a pause stops an insight attempt'),
  m('hook-pause-only-when-paused', ENGINE, ['if (r.applied && paused) {', 'if (r.applied) {'], ENGINE_T, 'or an unpause, leaves the attempt alone'),
  m('hook-suspend', ENGINE, ['    if (this.general?.abortAll(V2_OFF)) aborted += 1\n', ''], ENGINE_T, 'v2 switched off (suspend)'),
  m('hook-suspend-counts', ENGINE, ['if (this.general?.abortAll(V2_OFF)) aborted += 1', 'this.general?.abortAll(V2_OFF)'], ENGINE_T, 'v2 switched off (suspend)'),
  m('hook-mode-changed', ENGINE, ['  modeChanged(): void { this.general?.modeChanged() }', '  modeChanged(): void { }'], ENGINE_T, 'a mode change stops an insight attempt'),
  m('hook-shutdown-stops-runner', ENGINE, ['if (this.general) { this.general.stop(); setGeneralCuesTodayProvider(null) }', 'if (this.general) { setGeneralCuesTodayProvider(null) }'], ENGINE_T, 'shutdown stops the runner'),
  m('hook-shutdown-clears-today', ENGINE, ['if (this.general) { this.general.stop(); setGeneralCuesTodayProvider(null) }', 'if (this.general) { this.general.stop() }'], ENGINE_T, 'zeros after shutdown'),
  m('hook-start-registers-today', ENGINE, ['    setGeneralCuesTodayProvider(() => this.general!.generalCuesToday())\n', ''], ENGINE_T, 'settings view reads today from the runner'),
  m('hook-start-polls', ENGINE, ['    this.general.start()\n  }', '  }'], ENGINE_T, 'startGeneral starts'),
  m('hook-singleton-starts', ENGINE, ['    engine.startGeneral()\n', ''], ENGINE_T, 'singleton starts its runner'),
  m('hook-settings-save-mode-changed', ENGINE, ['  if (patch.cueMode !== undefined) engine?.modeChanged()', '  void 0'], ENGINE_T, 'saving the cue mode tells the engine'),
  m('hook-settings-save-only-cue-mode', ENGINE, ['  if (patch.cueMode !== undefined) engine?.modeChanged()', '  engine?.modeChanged()'], ENGINE_T, 'saving the cue mode tells the engine'),
  m('hook-no-runner-without-deps', ENGINE, ['this.general = deps.general ? new GeneralCueRunner(this.generalHost(), this.generalSettings(), deps.general) : null', 'this.general = new GeneralCueRunner(this.generalHost(), this.generalSettings(), deps.general ?? ({} as never))'], ENGINE_T, 'without general dependencies'),
  // ── Real dependencies ──
  m('real-state-file', ENGINE, ["statePath: dataPath('live-cues-general-state.json')", "statePath: dataPath('live-cues-v2-state.json')"], ENGINE_T, 'keep their state in the data home'),
  m('real-writer-model', ENGINE, ['writerModel: () => liveCuesV2Model(process.env),', "writerModel: () => 'claude-opus-5-5',"], ENGINE_T, 'run the topic on pinned Haiku'),
  m('real-trace-file', ENGINE, ['trace: row => trace(row as unknown as Record<string, unknown>),', 'trace: () => {},'], ENGINE_T, 'write a general_tick row'),
  m('real-trigger-question', ENGINE, ['.trigger(title, window, signal)', '.trigger(window, title, signal)'], ENGINE_T, 'ask Jev the trigger question'),
  m('real-consent', ENGINE, ['publicTopics: () => new MeetingAskStore().publicTopics(),', 'publicTopics: () => true,'], ENGINE_T, 'keep their state in the data home'),
  m('real-home-area', ENGINE, ['homeArea: () => getOwnerHomeArea(),', "homeArea: () => 'Austin, TX',"], ENGINE_T, 'keep their state in the data home'),
  // ── Round 2 (review): names, wider lists, normalization ──
  ...stemMutants,
  ...numberMutants,
  m('norm-fold-accents', TOPIC, [".normalize('NFKD').replace(/\\p{M}/gu, '')\n    .replace(/\\b(?:", "\n    .replace(/\\b(?:"], TOPIC_T, 'reads the window normalized'),
  m('norm-acronym-dots', TOPIC, ["    .replace(/\\b(?:\\p{L}\\.){2,}\\p{L}?/gu, m => m.replace(/\\./g, ''))\n", ''], TOPIC_T, 'reads the window normalized'),
  m('norm-hyphens-and-slashes', TOPIC, [".replace(/[-_\\u2010-\\u2015/]+/g, ' ')", ''], TOPIC_T, 'reads the window normalized'),
  m('sensitive-reads-normalized', TOPIC, ['const t = normalizeForMatch(text)', 'const t = text'], TOPIC_T, 'reads the window normalized'),
  m('admit-nfkc', TOPIC, ["const query = raw.normalize('NFKC').replace(/\\s+/g, ' ').trim()", "const query = raw.replace(/\\s+/g, ' ').trim()"], TOPIC_T, 'reads the query after NFKC'),
  m('admit-latin-only', TOPIC, ["/^[\\p{Script=Latin}\\p{M}][\\p{Script=Latin}\\p{M}'’.&\\- ]*$/u", "/^[\\p{L}\\p{M}][\\p{L}\\p{M}'’.&\\- ]*$/u"], TOPIC_T, 'allows Latin script only'),
  m('admit-deny-reads-normalized', TOPIC, ['SENSITIVE_ALL.test(folded)) return', 'SENSITIVE_ALL.test(query)) return'], TOPIC_T, 'reads the deny list on the normalized query'),
  m('admit-owner-join', TOPIC, ["  if (ctx.joins.some(j => grams.has(stemWord(j)))) return { ok: false, reason: 'owner_term' }\n", ''], TOPIC_T, 'written without its spaces'),
  m('admit-owner-join-pairs', TOPIC, ['for (let n = 1; n <= 2; n++)', 'for (let n = 1; n <= 1; n++)'], TOPIC_T, 'written without its spaces'),
  m('admit-owner-join-single-words', TOPIC, ['for (let n = 1; n <= 2; n++)', 'for (let n = 2; n <= 2; n++)'], TOPIC_T, 'written without its spaces'),
  m('names-voice-profiles', TOPIC, ['  if (src.voiceProfileNames) names.push(...await src.voiceProfileNames())\n', ''], TOPIC_T, 'every word of every enrolled voice profile name'),
  m('names-voice-awaited', TOPIC, ['names.push(...await src.voiceProfileNames())', 'names.push(...(src.voiceProfileNames() as string[]))'], TOPIC_T, 'REJECTS when the voice profile names cannot be read'),
  m('names-fold-accents', TOPIC, ['return new Set([...words, ...[...words].map(fold)])', 'return new Set([...words])'], TOPIC_T, 'every word of every enrolled voice profile name'),
  m('generic-label-numbered', TOPIC, ['(?:speaker|guest|voice)\\s*\\d*', '(?:speaker|guest|voice)'], TOPIC_T, 'never a generic label'),
  m('cached-names-window', TOPIC, ['if (cache && t - cache.at < ttlMs) return cache.names', 'if (false) return cache!.names'], TOPIC_T, 'reads once inside the window'),
  m('cached-names-edge', TOPIC, ['t - cache.at < ttlMs', 't - cache.at <= ttlMs'], TOPIC_T, 'reads once inside the window'),
  m('cached-names-five-minutes', TOPIC, ['ttlMs = 5 * 60_000', 'ttlMs = 60_000'], TOPIC_T, 'the default window is five minutes'),
  m('real-voice-names-read', TOPIC, ['.readVoiceProfiles().profiles.map(p => p.name)', '.readVoiceProfiles().profiles.map(p => "")'], NAMES_T, 'reads every enrolled voice profile name'),
  m('real-owner-name-thunk', TOPIC, ['ownerName: () => getOwnerName(),', "ownerName: () => 'User',"], NAMES_T, 'reads the owner'),
  m('real-vocabulary-thunk', TOPIC, ['vocabulary: () => getVocabulary(),', 'vocabulary: () => [],'], NAMES_T, 'reads the owner'),
  // ── Round 2: eligibility, the trigger cap, consent, names in the pipeline ──
  m('elig-orientation-unreadable', RUN, ["  if (c.domainUnreadable) return { ok: false, state: 'withheld', reason: 'orientation_unreadable' }\n", ''], RUN_T, 'eligibility: orientation unreadable'),
  m('trigger-cap-default', RUN, ['default: 300, min: 1, max: 2000', 'default: 500, min: 1, max: 2000'], RUN_T, 'dailyTriggerCap'),
  m('trigger-cap-max', RUN, ['default: 300, min: 1, max: 2000', 'default: 300, min: 1, max: 5000'], RUN_T, 'dailyTriggerCap'),
  m('trigger-cap-min', RUN, ['default: 300, min: 1, max: 2000', 'default: 300, min: 0, max: 2000'], RUN_T, 'dailyTriggerCap'),
  m('trigger-cap-digits', RUN, ['/^\\d{1,5}$/.test(raw.trim())', '/^\\d{1,3}$/.test(raw.trim())'], RUN_T, 'dailyTriggerCap'),
  m('trigger-cap-charged-before-call', RUN, [
    ["    const triggered = this.store.chargeTrigger(dailyTriggerCap(this.deps.env))\n    if (triggered !== 'ok') return this.done(row, 'no_cue', `cap:trigger_${triggered}`)\n    run.stage = 1\n    const trigger = await raceAbort(this.deps.jevTrigger(c.title, window, signal), signal)\n",
      "    run.stage = 1\n    const trigger = await raceAbort(this.deps.jevTrigger(c.title, window, signal), signal)\n    this.store.chargeTrigger(dailyTriggerCap(this.deps.env))\n"]], RUN_T, 'charged in the durable file BEFORE the request'),
  m('trigger-cap-refusal-ends', RUN, ["    if (triggered !== 'ok') return this.done(row, 'no_cue', `cap:trigger_${triggered}`)\n", ''], RUN_T, 'finds the cap reached stops the request'),
  m('trigger-cap-env-at-charge', RUN, ['this.store.chargeTrigger(dailyTriggerCap(this.deps.env))', 'this.store.chargeTrigger(dailyTriggerCap({}))'], RUN_T, 'finds the cap reached stops the request'),
  m('trigger-cap-blocks-tick', RUN, ["if (s.triggerCalls >= dailyTriggerCap(this.deps.env)) return { state: 'capped', reason: 'daily_trigger_cap' }", 'void 0'], RUN_T, 'the cap stops the next tick'),
  m('trigger-cap-blocks-tick-edge', RUN, ['s.triggerCalls >= dailyTriggerCap(this.deps.env)', 's.triggerCalls > dailyTriggerCap(this.deps.env)'], RUN_T, 'the cap stops the next tick'),
  m('store-trigger-counted', RUN, ['    r.state.triggerCalls += 1\n', ''], RUN_T, 'charges a Jev trigger against the daily cap'),
  m('store-trigger-cap-check', RUN, ["    if (r.state.triggerCalls >= cap) return 'daily_cap'\n", ''], RUN_T, 'charges a Jev trigger against the daily cap'),
  m('store-trigger-day-rollover', RUN, ['triggerCalls: rolled ? 0 : (raw.triggerCalls ?? 0)', 'triggerCalls: raw.triggerCalls ?? 0'], RUN_T, 'resets with the local day'),
  m('store-trigger-legacy-file', RUN, ['!(raw.triggerCalls === undefined || whole(raw.triggerCalls))', '!whole(raw.triggerCalls)'], RUN_T, 'legacy state file'),
  m('store-trigger-validated', RUN, ['(raw.triggerCalls === undefined || whole(raw.triggerCalls))', 'true'], RUN_T, 'a damaged counter is unreadable'),
  m('trace-jev-tokens', RUN, ['row.jevTokens = Number.isFinite(trigger.tokens) ? trigger.tokens : null', 'row.jevTokens = null'], RUN_T, 'tokens are traced'),
  m('consent-recheck-before-search', RUN, ["    if (!this.consentOk()) return this.consentWithdrawn()\n    if (!this.live(c.sessionId)) return this.done(row, 'no_cue', 'not_eligible')\n", "    if (!this.live(c.sessionId)) return this.done(row, 'no_cue', 'not_eligible')\n"], RUN_T, 'consent re-check before the search'),
  m('consent-recheck-before-emit', RUN, ["    if (!this.consentOk()) return this.consentWithdrawn()\n    if (!this.live(c.sessionId)) return this.done(row, 'no_cue', 'not_eligible', 4)", "    if (!this.live(c.sessionId)) return this.done(row, 'no_cue', 'not_eligible', 4)"], RUN_T, 'consent re-check before emit'),
  m('consent-reason', RUN, ["this.inFlight?.abort.abort('consent_off')\n    throw abortError()", "this.inFlight?.abort.abort('x')\n    throw abortError()"], RUN_T, 'consent re-check before the search'),
  m('consent-aborts-the-attempt', RUN, ["    this.inFlight?.abort.abort('consent_off')\n    throw abortError()", '    throw abortError()'], RUN_T, 'consent re-check before the search'),
  m('consent-tick-aborts-in-flight', RUN, ["    if (this.inFlight && !this.settings.publicTopics()) this.abortAll('consent_off')       // consent withdrawn: stop what is running\n", ''], RUN_T, 'next tick aborts the attempt with consent_off'),
  m('consent-tick-only-when-off', RUN, ['if (this.inFlight && !this.settings.publicTopics()) this.abortAll', 'if (this.inFlight) this.abortAll'], RUN_T, 'consent that stays on lets an in-flight attempt finish'),
  m('names-unavailable-fails-closed', RUN, ["      rec.last = { state: 'withheld', reason: 'names_unavailable' }\n      return this.done(row, 'no_cue', 'names_unavailable')\n", "      nameWords = new Set<string>()\n"], RUN_T, 'names_unavailable: voice names that cannot be read'),
  m('names-abort-is-a-cancel', RUN, ['      if (isCancel(error, signal)) throw error\n', ''], RUN_T, 'an abort while the voice names are being read'),
  m('names-read-before-any-spend', RUN, [
    ["    let nameWords: Set<string>\n    try { nameWords = await raceAbort(blockedNameWords(window, c.speakerNames ?? [], profile), signal) } catch (error) {\n      if (isCancel(error, signal)) throw error\n      rec.last = { state: 'withheld', reason: 'names_unavailable' }\n      return this.done(row, 'no_cue', 'names_unavailable')\n    }\n", ''],
    ["    if (!(trigger.pGeneral >= lim.trigger)) return this.done(row, 'no_cue', 'trigger_below', 1)\n", "    if (!(trigger.pGeneral >= lim.trigger)) return this.done(row, 'no_cue', 'trigger_below', 1)\n    let nameWords: Set<string>\n    try { nameWords = await raceAbort(blockedNameWords(window, c.speakerNames ?? [], profile), signal) } catch (error) {\n      if (isCancel(error, signal)) throw error\n      rec.last = { state: 'withheld', reason: 'names_unavailable' }\n      return this.done(row, 'no_cue', 'names_unavailable')\n    }\n"]], RUN_T, 'names_unavailable: voice names that cannot be read'),
  // ── Round 2: the engine ──
  m('host-speakers-offered', ENGINE, ['speakerNames: [...s.speakers, ...titleNames]', 'speakerNames: [...titleNames]'], ENGINE_T, 'a speaker the ASR path reported'),
  m('host-title-names-offered', ENGINE, ['speakerNames: [...s.speakers, ...titleNames]', 'speakerNames: [...s.speakers]'], ENGINE_T, 'calendar title'),
  m('host-title-names-pattern', ENGINE, ["match(/\\p{Lu}[\\p{L}'’-]{2,}/gu)", "match(/\\p{Lu}[\\p{L}'’-]{20,}/gu)"], ENGINE_T, 'calendar title'),
  m('feed-notes-speakers', ENGINE, ['    this.noteSpeakers(s, speakers)\n', ''], ENGINE_T, 'a speaker the ASR path reported'),
  m('speakers-bounded', ENGINE, ['|| s.speakers.size >= SPEAKER_NAMES_MAX) continue', ') continue'], ENGINE_T, 'stops at 200 names'),
  m('speakers-bound-200', ENGINE, ['SPEAKER_NAMES_MAX = 200', 'SPEAKER_NAMES_MAX = 20'], ENGINE_T, 'stops at 200 names'),
  m('speakers-length-limit', ENGINE, ['name.length > 60 || ', ''], ENGINE_T, 'remembers each speaker once'),
  m('speakers-not-generic', ENGINE, ['|| isGenericSpeakerLabel(name) ', ''], ENGINE_T, 'remembers each speaker once'),
  m('speakers-trimmed', ENGINE, ["raw.replace(/\\s+/g, ' ').trim() : ''", "raw : ''"], ENGINE_T, 'remembers each speaker once'),
  m('feed-forwards-speakers', LIVE_ENGINE, ['liveCuesV2().feed(sessionId, text, asrDegraded, speakers)', 'liveCuesV2().feed(sessionId, text, asrDegraded)'], ENGINE_T, 'hands the speakers to the engine'),
  m('asr-call-site-segments', TRANSCRIBE, ['[speaker, ...(chunk.segments ?? []).map(segment => segment.speaker)]', '[speaker]'], ENGINE_T, 'the ASR call site reports'),
  m('asr-call-site-speaker', TRANSCRIBE, ['[speaker, ...(chunk.segments ?? []).map(segment => segment.speaker)]', '[...(chunk.segments ?? []).map(segment => segment.speaker)]'], ENGINE_T, 'the ASR call site reports'),
  m('emit-sources-https-checked', ENGINE, ['    if (!insight.sources.length || urls.some(u => u === null)) return false\n', ''], ENGINE_T, 'emit sends sources through the cue log'),
  m('emit-sources-need-one', ENGINE, ['if (!insight.sources.length || urls.some(u => u === null)) return false', 'if (urls.some(u => u === null)) return false'], ENGINE_T, 'emit sends sources through the cue log'),
  m('emit-sources-normalized', ENGINE, ['({ ...src, url: urls[i]! })', '({ ...src })'], ENGINE_T, 'emit sends sources through the cue log'),
  // ── Prompts ──
  m('insight-number-guard', PROMPTS, ["if (unsupportedSearchNumbers(`${headline} ${detail}`, cited.map(s => `${s.title} ${s.text}`).join(' ')).length) return 'unsupported_number'", ''], PROMPTS_T, 'number guard'),
  m('insight-number-guard-cited-only', PROMPTS, ['cited.map(s => `${s.title} ${s.text}`)', 'sources.map(s => `${s.title} ${s.text}`)'], PROMPTS_T, 'number guard'),
  m('insight-number-guard-whole-numbers', PROMPTS, ['(?<!\\\\d)${digits', '${digits'], PROMPTS_T, 'matches whole numbers'),
  m('insight-number-guard-commas', PROMPTS, [String.raw`.replace(/(?<=\d),(?=\d)/g, '')`, ''], PROMPTS_T, 'number guard'),
  m('insight-number-guard-dollar-percent', PROMPTS, [String.raw`n.replace(/[$,]/g, '')`, String.raw`n.replace(/[,]/g, '')`], PROMPTS_T, 'number guard'),
  m('insight-cites-at-most-two', PROMPTS, ['.slice(0, GENERAL_INSIGHT_MAX_SOURCES) : []', ' : []'], PROMPTS_T, 'at most two sources'),
  m('insight-needs-a-source', PROMPTS, ["if (!sourceIds.length) return 'no_source'", ''], PROMPTS_T, 'without a source'),
  m('insight-too-long', PROMPTS, ['if (headline.length > CUE_HEADLINE_MAX || detail.length > CUE_DETAIL_MAX) return', 'if (false) return'], PROMPTS_T, 'too long'),
  m('insight-too-long-edge', PROMPTS, ['headline.length > CUE_HEADLINE_MAX', 'headline.length >= CUE_HEADLINE_MAX'], PROMPTS_T, 'too long'),
  m('insight-detail-edge', PROMPTS, ['detail.length > CUE_DETAIL_MAX', 'detail.length >= CUE_DETAIL_MAX'], PROMPTS_T, 'too long'),
  m('insight-empty', PROMPTS, ["if (!headline || !detail) return 'empty'", ''], PROMPTS_T, 'too long, or without a source'),
  m('insight-dashes', PROMPTS, ["x.replace(/[—–]/g, '-')", 'x'], PROMPTS_T, 'dashes'),
  m('insight-context-1000', PROMPTS, ['.slice(-GENERAL_INSIGHT_CONTEXT_CHARS) })', ' })'], PROMPTS_T, 'last 1,000 characters'),
  m('insight-context-redacted', PROMPTS, ['context: redactSecrets(input.context)', 'context: input.context'], PROMPTS_T, 'last 1,000 characters'),
  m('topic-prompt-redacted', PROMPTS, ['JSON.stringify({ window: redactSecrets(window) })', 'JSON.stringify({ window })'], PROMPTS_T, 'redacted window'),
  m('topic-prompt-own-business', PROMPTS, ["  '3. Never the wearer\\'s own company, brands, customers, deals, finances, metrics, plans or staff, nor their employer\\'s: if the topic is that business, return {\"topic\":false}.',\n", ''], PROMPTS_T, 'wearer'),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const selected = names.length ? mutations.filter(({ name }) => names.includes(name)) : mutations
if (names.length && selected.length !== names.length) throw new Error('Unknown mutation name in: ' + names.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

/** Applies a mutation's edits to a source text, proving each target appears exactly once and the text changed. */
function mutate(name, file, original, edits) {
  let mutated = original
  for (const [find, replacement] of edits) {
    if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 90)}`)
    mutated = mutated.replace(find, () => replacement)
  }
  if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
  return mutated
}

if (args.includes('--check')) {
  const bad = []
  for (const { name, file, edits } of selected) { try { mutate(name, file, readFileSync(join(root, file), 'utf8'), edits) } catch (e) { bad.push(e.message) } }
  if (bad.length) { console.log(bad.join('\n')); process.exit(1) }
  console.log(`${selected.length} mutation targets each match exactly once`)
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'cues-general-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'memory-runtime']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
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
  for (const { name, file, edits, tests, by } of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    const mutated = mutate(name, file, original, edits)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    const named = killers.filter(k => k.toLowerCase().includes(by.toLowerCase()))
    if (!named.length) { console.log(`${name} killed, but not by a test naming "${by}": ${killers.slice(0, 3).join(' | ')}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${named.slice(0, 2).join(' | ')}${named.length > 2 ? ` (+${named.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} general live cues mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
