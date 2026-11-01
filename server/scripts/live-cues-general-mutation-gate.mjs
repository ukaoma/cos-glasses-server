#!/usr/bin/env node
// General live cues mutation gate: the runner, the topic admission and the prompts/parsers, plus the optional audit caller on the
// web search. Mutations run only in a disposable copy of the checkout; the live checkout is never rewritten.
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
const ALL = [...RUN_T, ...TOPIC_T, ...PROMPTS_T, ...WEB_T, 'server/lib/meeting-ask-web.test.ts']
const RUN = 'server/lib/live-cues-general.ts', TOPIC = 'server/lib/live-cues-general-topic.ts', PROMPTS = 'server/lib/live-cues-general-prompts.ts'
const WEB = 'server/lib/meeting-ask-web.ts'
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
  m('sensitive-skip-profile-world', RUN, ['sensitiveWindow(window, profileWorldWords(profile))', 'sensitiveWindow(window)'], RUN_T, "owner's own world"),
  m('sensitive-skip-before-trigger', RUN, [
    ["    const sensitive = sensitiveWindow(window, profileWorldWords(profile))\n    if (sensitive) { rec.last = { state: 'withheld', reason: 'sensitive_window' }; return this.done(row, 'no_cue', `sensitive:${sensitive}`) }\n", ''],
    ["    const trigger = await raceAbort(this.deps.jevTrigger(c.title, window, signal), signal)\n", "    const sensitive = sensitiveWindow(window, profileWorldWords(profile))\n    const trigger = await raceAbort(this.deps.jevTrigger(c.title, window, signal), signal)\n    if (sensitive) { rec.last = { state: 'withheld', reason: 'sensitive_window' }; return this.done(row, 'no_cue', `sensitive:${sensitive}`) }\n"]], RUN_T, 'sensitive window'),
  m('window-redacted', RUN, ['const window = redactSecrets(c.window(LIVE_CUES_GENERAL_LIMITS.topicWindowChars))', 'const window = c.window(LIVE_CUES_GENERAL_LIMITS.topicWindowChars)'], RUN_T, 'redacted'),
  m('window-three-minutes', RUN, ['topicWindowChars: 2_700', 'topicWindowChars: 6_000'], RUN_T, 'last 2,700 characters'),
  m('sensitive-whole-words', TOPIC, ['`\\\\b(?:${words.map', '`(?:${words.map'], TOPIC_T, 'look-alike'),
  m('sensitive-category-loop', TOPIC, ['for (const [category, re] of SENSITIVE) if (re.test(text)) return category', 'void SENSITIVE'], TOPIC_T, 'skips a'),
  m('sensitive-profile-words', TOPIC, ["if (profileWords.size && factWords(text).some(w => profileWords.has(w) || profileWords.has(stemWord(w)))) return 'profile'", 'void profileWords'], TOPIC_T, "owner's own world"),
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
  m('admit-number-word', TOPIC, ["if (NUMBER_WORD.test(query)) return { ok: false, reason: 'number_word' }", ''], TOPIC_T, 'number word'),
  m('admit-characters', TOPIC, ["if (!QUERY_CHARS.test(query)) return { ok: false, reason: 'characters' }", ''], TOPIC_T, 'operators, quotes and urls'),
  m('admit-url', TOPIC, ["if (URLISH.test(query)) return { ok: false, reason: 'url' }", ''], TOPIC_T, 'operators, quotes and urls'),
  m('admit-secret', TOPIC, ["if (query !== redactSecrets(query)) return { ok: false, reason: 'secret' }", ''], TOPIC_T, 'rejects a secret'),
  m('admit-deny-list', TOPIC, ['if (PRIVATE_QUERY.test(query) || SENSITIVE_ALL.test(query))', 'if (false)'], TOPIC_T, 'deny-list word'),
  m('admit-deny-list-ask-words', TOPIC, ['if (PRIVATE_QUERY.test(query) || SENSITIVE_ALL.test(query))', 'if (SENSITIVE_ALL.test(query))'], TOPIC_T, 'deny-list word'),
  m('admit-deny-list-private-life', TOPIC, ['if (PRIVATE_QUERY.test(query) || SENSITIVE_ALL.test(query))', 'if (PRIVATE_QUERY.test(query))'], TOPIC_T, 'deny-list word'),
  m('admit-name', TOPIC, ["if (factWords(query).some(w => ctx.nameWords.has(w) || ctx.nameWords.has(stemWord(w)))) return { ok: false, reason: 'name' }", ''], TOPIC_T, 'name word'),
  m('admit-name-plural', TOPIC, ['ctx.nameWords.has(w) || ctx.nameWords.has(stemWord(w))', 'ctx.nameWords.has(w)'], TOPIC_T, 'name word'),
  m('admit-repeat', TOPIC, ["if (ctx.recent.has(normalized)) return { ok: false, reason: 'repeat' }", ''], TOPIC_T, 'repeat'),
  m('admit-repeat-normalized', TOPIC, ['if (ctx.recent.has(normalized))', 'if (ctx.recent.has(query))'], TOPIC_T, 'repeat'),
  m('names-owner-and-label', TOPIC, ['try { names.push(src.ownerName(), src.speakerLabel()) } catch { /* no profile */ }', ''], TOPIC_T, "owner's own name"),
  m('names-window-labels', TOPIC, ['names.push(m[1])', 'void m'], TOPIC_T, 'speaker labels that open window lines'),
  m('names-generic-labels', TOPIC, ['names.filter(n => !GENERIC_LABELS.has(n.trim().toLowerCase()))', 'names'], TOPIC_T, 'speaker labels that open window lines'),
  m('names-profile-world', TOPIC, [', ...profileWorldWords(src)])', '])'], TOPIC_T, 'speaker labels that open window lines'),
  m('names-world-excludes-owner', TOPIC, ['terms.push(...src.vocabulary())', 'terms.push(...src.vocabulary(), src.ownerName())'], TOPIC_T, 'never skip a whole window'),
  m('local-area-label-check', TOPIC, ['if (!label || !HOME_AREA_LABEL.test(label)) return null', 'if (!label) return null'], TOPIC_T, 'appends nothing unless'),
  m('local-area-comma', TOPIC, ["label.replace(/,/g, '')", 'label'], TOPIC_T, 'without its comma'),
  m('hash-12-hex', TOPIC, ['.digest(\'hex\').slice(0, 12)', ".digest('hex').slice(0, 16)"], TOPIC_T, 'first 12 hex'),
  // ── Admission, as the runner applies it ──
  m('run-admission-names', RUN, ['nameWords: blockedNameWords(window, c.speakerNames ?? [], profile)', 'nameWords: new Set<string>()'], RUN_T, 'admission:'),
  m('run-admission-host-speakers', RUN, ['blockedNameWords(window, c.speakerNames ?? [], profile)', 'blockedNameWords(window, [], profile)'], RUN_T, 'speaker name the host knows'),
  m('run-admission-repeats', RUN, ['recent: this.recentQueries(c.sessionId, startedAt)', 'recent: new Set<string>()'], RUN_T, 'repeat:'),
  m('run-admission-rejection-ends', RUN, ["if (!admitted.ok) { row.queryHash = queryHash(topic.query); return this.done(row, 'no_cue', `rejected:${admitted.reason}`, 2) }", ''], RUN_T, 'admission:'),
  m('run-repeat-cross-session-expiry', RUN, ['for (const [q, at] of this.crossQueries) if (nowMs - at >= LIVE_CUES_GENERAL_LIMITS.queryCacheMs) this.crossQueries.delete(q)\n', '\n'], RUN_T, 'repeat: another meeting'),
  m('run-repeat-cross-session-30min', RUN, ['queryCacheMs: 30 * 60_000', 'queryCacheMs: 10 * 60_000'], RUN_T, 'repeat: another meeting'),
  m('run-repeat-cross-session-cache', RUN, ['this.crossQueries.set(normalized, nowMs)\n', '\n'], RUN_T, 'repeat: another meeting'),
  m('run-repeat-per-meeting', RUN, ['...(this.meetingQueries.get(sessionId) ?? [])', '...[]'], RUN_T, 'never searches the same query twice'),
  m('run-repeat-noted-before-search', RUN, ['    this.noteQuery(c.sessionId, admitted.normalized, startedAt)\n', '\n'], RUN_T, 'repeat:'),
  m('run-local-only', RUN, ["if (topic.category === 'local') {", 'if (true) {'], RUN_T, 'never gets the home area'),
  m('run-local-no-area', RUN, ["if (withArea === null) { row.queryHash = queryHash(admitted.query); return this.done(row, 'no_cue', 'local_no_area', 2) }", ''], RUN_T, 'without a home area'),
  m('run-local-readmit', RUN, ["if (!again.ok) { row.queryHash = queryHash(withArea); return this.done(row, 'no_cue', `rejected_local:${again.reason}`, 2) }", ''], RUN_T, 'appended query is admitted again'),
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
  m('cap-topic-charge-refusal-ends', RUN, ["    if (charged !== 'ok') return this.done(row, 'no_cue', `cap:${charged}`)\n", '\n'], RUN_T, 'cannot be written'),
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
  m('search-https-only', RUN, ["!url.startsWith('https://') || ", ''], RUN_T, 'only https public sources'),
  m('search-public-urls-only', RUN, ["typeof s?.url === 'string' ? publicWebUrl(s.url) : null", "typeof s?.url === 'string' ? s.url : null"], RUN_T, 'only https public sources'),
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
  m('writer-gets-context', RUN, ['context: c.window(GENERAL_INSIGHT_CONTEXT_CHARS)', "context: ''"], RUN_T, 'last 1,000 characters'),
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
  m('trace-hash-of-rejected', RUN, ["row.queryHash = queryHash(topic.query); return this.done(row, 'no_cue', `rejected:", "return this.done(row, 'no_cue', `rejected:"], RUN_T, 'admission:'),
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
