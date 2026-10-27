import { describe, it, expect, vi } from 'vitest'
import { hedgedRun, originClarification, namedOrigin, placeOrigin, placeCodes, factCheckRescanRequest, doseGuardEnabled, PHONE_AREA_MAX_AGE_MS, factCheckScopeRequest, factCheckWindow, factCheckScanTurns, admitFactCheckClaims, continuationIntent, lastFactCheckLookup, alreadyCheckedClaims, factRowProblem, factCheckProblem, factCheckSummary, medicalDosingRequest, composeFactCheck, runMeetingFactCheck, focusExcerpt, originQuery, factCheckScopeEnabled, reusablePages, FACT_CHECK_PLANNER_SYSTEM, FACT_CHECK_SYSTEM, defaultOwnerArea } from './meeting-fact-check.js'
import { MEETING_FACT_CHECK_QUESTION, type MeetingAskExchange } from '../../shared/meeting-ask.js'
import { userWebQuery } from './meeting-ask-web.js'
import type { FactCheckClaim } from './meeting-ask-store.js'
import type { AskSource } from './live-cos-ask.js'

// Synthetic meeting. No private content.
const turns = [
  { id: 1, elapsedMs: 70_000, speaker: 'MU', text: 'If I were to say that elephants often grow to be over the' },
  { id: 2, elapsedMs: 76_000, speaker: 'MU', text: 'weight of a car, that would be a fact check question.' },
  { id: 3, elapsedMs: 100_000, speaker: 'Ext', text: 'The average human heart beats about a billion times in a lifetime.' },
  { id: 4, elapsedMs: 130_000, speaker: 'Dana Ortiz', text: 'Dana here, totally unrelated.' },
  { id: 5, elapsedMs: 600_000, speaker: 'MU', text: 'How is it that flying from here to Kansas City' },
  { id: 6, elapsedMs: 606_000, speaker: 'MU', text: 'is only 90 minutes to 2 hours versus driving is like 10 hours?' },
  { id: 7, elapsedMs: 700_000, speaker: 'Ext', text: 'My wife said the kids are asleep.' },
]
const input = (question: string, elapsedMs = 800_000) => ({ sessionId: 'meeting_fc', action: 'ask' as const, question, turns: turns.filter(t => t.elapsedMs <= elapsedMs), history: [], elapsedMs })
const ex = (o: Partial<MeetingAskExchange>): MeetingAskExchange => ({ requestId: 'r_' + Math.random().toString(36).slice(2, 10), sessionId: 'meeting_fc', serverInstanceId: 's1', action: 'ask', question: 'q', status: 'completed', createdAt: '2026-10-13T02:00:00.000Z', updatedAt: '2026-10-13T02:00:00.000Z', selectedModel: { engine: 'claude', model: 'sonnet' }, sources: [], notices: [], throughMs: 0, files: [], ...o })
const at = (elapsedMs: number) => ({ requestId: 'current_1', sessionId: 'meeting_fc', serverInstanceId: 's1', elapsedMs })
const page = (id: string, text: string, extra: Partial<AskSource> = {}): AskSource => ({ id, kind: 'web', title: 'Page', url: 'https://example.org/' + id, text: 'Retrieved page excerpt (may be partial): ' + text + ' '.repeat(220), retrievedAt: new Date().toISOString(), retrievalId: 'ret-' + id, ...extra })

describe('meeting-wide Fact check scope', () => {
  it('treats the CTA and a bare typed Fact check as meeting-wide, never a named or pointed check', () => {
    for (const q of [MEETING_FACT_CHECK_QUESTION, 'Fact check', 'fact-check', 'Run a fact check', 'Fact check the meeting', 'Can you fact check everything said so far?'])
      expect(factCheckScopeRequest(q)).toBe(true)
    for (const q of ['Fact check the flight to kc', 'Can you fact check this', 'Fact check the claim', 'Fact check it', 'What was decided?', 'fact', 'fact check ' + 'the '.repeat(12)])
      expect(factCheckScopeRequest(q)).toBe(false)
  })
  it('starts after the newest completed range at or before this ask, per meeting and server', () => {
    expect(factCheckWindow([], at(500_000))).toEqual({ fromMs: 0, full: true })
    const done = ex({ throughMs: 126_414, factCheckRange: { fromMs: 0, throughMs: 126_414, full: true, claims: 2 } })
    expect(factCheckWindow([done], at(500_000))).toEqual({ fromMs: 126_414, full: false })
    const later = ex({ throughMs: 300_000, factCheckRange: { fromMs: 126_414, throughMs: 300_000, full: false, claims: 0 } })
    expect(factCheckWindow([done, later], at(500_000))).toEqual({ fromMs: 300_000, full: false })
    expect(factCheckWindow([later, done], at(500_000))).toEqual({ fromMs: 300_000, full: false })
    // A range past this ask position, another meeting, another server, a failed exchange or this request does not count.
    expect(factCheckWindow([done, { ...later, factCheckRange: { ...later.factCheckRange!, throughMs: 900_000 } }], at(500_000))).toEqual({ fromMs: 126_414, full: false })
    expect(factCheckWindow([{ ...done, sessionId: 'meeting_other' }], at(500_000)).full).toBe(true)
    expect(factCheckWindow([{ ...done, serverInstanceId: 's2' }], at(500_000)).full).toBe(true)
    expect(factCheckWindow([{ ...done, status: 'failed' }], at(500_000)).full).toBe(true)
    expect(factCheckWindow([{ ...done, requestId: 'current_1' }], at(500_000)).full).toBe(true)
    expect(factCheckWindow([ex({ throughMs: 126_414 })], at(500_000)).full).toBe(true)
  })
  it('scans only what was said after the watermark, newest first within the budget', () => {
    // Turns in the 15 s before the watermark come along as context; only later turns count as new (QA W2).
    expect(factCheckScanTurns(input('x'), { fromMs: 100_000, full: false }).turns.map(t => t.id)).toEqual([3, 4, 5, 6, 7])
    expect(factCheckScanTurns(input('x'), { fromMs: 100_000, full: false }).fresh).toBe(4)
    expect(factCheckScanTurns(input('x'), { fromMs: 120_000, full: false }).turns.map(t => t.id)).toEqual([4, 5, 6, 7])
    expect(factCheckScanTurns(input('x', 700_000), { fromMs: 700_000, full: false })).toEqual({ turns: [], scannedFromMs: 700_000, truncated: false, fresh: 0 })
    // Dropping only overlap context is not a truncation of new content.
    const contextOnly = factCheckScanTurns(input('x'), { fromMs: 100_000, full: false }, 240)
    expect(contextOnly.turns.map(t => t.id)).toEqual([4, 5, 6, 7]); expect(contextOnly.truncated).toBe(false)
    expect(factCheckScanTurns(input('x'), { fromMs: 0, full: true }).turns.map(t => t.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const small = factCheckScanTurns(input('x'), { fromMs: 0, full: true }, 140)
    expect(small.truncated).toBe(true)
    expect(small.turns.map(t => t.id)).toEqual([6, 7])
    expect(small.scannedFromMs).toBe(606_000)
  })
})

describe('claim admission', () => {
  const scanned = turns
  it('admits each claim from its own passages, plural-insensitive, in time order', () => {
    const { claims } = admitFactCheckClaims({ claims: [
      { claim: 'Average human heart beats about a billion times in a lifetime', query: 'average human heart beats lifetime billion', evidenceTurnIds: [3], category: 'science' },
      { claim: 'Elephants often weigh more than a car', query: 'elephant weight vs car weight', evidenceTurnIds: [1, 2], category: 'nature' },
    ] }, input('Fact check'), scanned)
    expect(claims.map(c => [c.n, c.query])).toEqual([[1, 'elephant weight vs car weight'], [2, 'average human heart beats lifetime billion']])
  })
  it('drops a claim with a speaker name, private words, a dose, an unseen number, foreign evidence or too few anchors', () => {
    const one = (claim: Record<string, unknown>, extra: Parameters<typeof admitFactCheckClaims>[3] = {}) => admitFactCheckClaims({ claims: [{ category: 'nature', evidenceTurnIds: [1, 2], claim: 'Elephants outweigh cars', ...claim }] }, input('Fact check'), scanned, extra).claims.length
    expect(one({ query: 'elephant weight car' })).toBe(1)
    expect(one({ query: 'dana elephant weight car' })).toBe(0)
    expect(one({ query: 'elephant weight car', evidenceTurnIds: [7] })).toBe(0)
    expect(one({ query: 'elephant weight car family' })).toBe(0)
    expect(one({ query: 'elephant medication dose car' })).toBe(0)
    expect(one({ query: 'elephant weight car 7000' })).toBe(0)
    expect(one({ query: 'elephant weight car', evidenceTurnIds: [99] })).toBe(0)
    expect(one({ query: 'elephant weight' })).toBe(0)
    expect(one({ query: 'elephant weight car', category: 'gossip' })).toBe(0)
    expect(one({ query: 'elephant weight car hunter' }, { nameWords: ['Hunter Ukamya'] })).toBe(0)
    // Words not in the passages are dropped, not admitted.
    expect(admitFactCheckClaims({ claims: [{ category: 'nature', evidenceTurnIds: [1, 2], claim: 'x', query: 'african elephant weight car' }] }, input('Fact check'), scanned).claims[0].query).toBe('elephant weight car')
  })
  it('adds an implicit origin only from the owner area or typed words, and leaves it unsearched without one', () => {
    const raw = { claims: [{ claim: 'Flying to Kansas City takes 90 minutes to 2 hours; driving takes 10 hours', query: 'to Kansas City flight time 90 minutes vs driving 10 hours', evidenceTurnIds: [5, 6], category: 'travel_time', place: 'implicit_origin' }] }
    const owned = admitFactCheckClaims(raw, input('Fact check'), scanned, { origin: { text: 'Austin, TX', source: 'profile' } }).claims[0]
    expect(owned.query).toBe('austin tx to kansas city flight time 90 minutes vs driving 10 hours')
    expect(owned.origin).toEqual({ text: 'Austin, TX', source: 'profile' })
    const missing = admitFactCheckClaims(raw, input('Fact check'), scanned).claims[0]
    expect(missing.query).toBeNull(); expect(missing.place).toBe('implicit_origin')
    expect(admitFactCheckClaims({ claims: [{ ...raw.claims[0], place: 'none' }] }, input('Fact check'), scanned, { origin: { text: 'Austin, TX', source: 'profile' } }).claims[0].query).toBe('to kansas city flight time 90 minutes vs driving 10 hours')
    expect(originQuery('to kansas city flight time', { text: 'Austin', source: 'user' })).toBe('austin to kansas city flight time')
  })
  it('drops a claim whose own evidence passage is private even when a neighbour has the words', () => {
    const scannedPrivate = [
      { id: 30, elapsedMs: 1000, speaker: 'Ext', text: 'Elephants often outweigh a car.' },
      { id: 31, elapsedMs: 2000, speaker: 'Ext', text: 'My wife says elephants outweigh a car.' },
    ]
    const claim = (ids: number[]) => admitFactCheckClaims({ claims: [{ claim: 'Elephants outweigh cars', query: 'elephant outweigh car', evidenceTurnIds: ids, category: 'nature' }] }, { turns: scannedPrivate }, scannedPrivate).claims.length
    expect(claim([30])).toBe(1)
    expect(claim([31])).toBe(0)
  })
  it('accepts a compound of two passage words, never new letters', () => {
    const heart = (query: string) => admitFactCheckClaims({ claims: [{ claim: 'Heart', query, evidenceTurnIds: [3], category: 'science' }] }, input('Fact check'), scanned).claims[0]?.query
    expect(heart('how many heartbeats average human lifetime')).toBe('how many heartbeats average human lifetime')
    expect(heart('how many heartattacks average human lifetime')).toBeUndefined()
  })
  it('reads a number with thousands separators as one number', () => {
    const roof = [{ id: 20, elapsedMs: 1000, speaker: 'Ext', text: 'The city allocated $750,000 to replace the fire station roof.' }]
    expect(admitFactCheckClaims({ claims: [{ claim: 'City allocated $750,000 for a fire station roof', query: 'city fire station roof 750,000 allocation', evidenceTurnIds: [20], category: 'public_project' }] }, { turns: roof }, roof).claims[0].query).toBe('city fire station roof 750000 allocation')
  })
  it('drops a claim wholly inside the overlap before the watermark, keeps one that continues after it', () => {
    const heart = { claim: 'Heart', query: 'average human heart beats lifetime', evidenceTurnIds: [3], category: 'science' }
    expect(admitFactCheckClaims({ claims: [heart] }, input('Fact check'), scanned, { newAfterMs: 100_000 }).claims).toHaveLength(0)
    expect(admitFactCheckClaims({ claims: [heart] }, input('Fact check'), scanned, { newAfterMs: 99_999 }).claims).toHaveLength(1)
    expect(admitFactCheckClaims({ claims: [{ ...heart, evidenceTurnIds: [3, 4] }] }, input('Fact check'), scanned, { newAfterMs: 100_000 }).claims).toHaveLength(1)
  })
  it('keeps a tagged place only when its words are in the claim\'s passages and it is not a name', () => {
    const raw = { claims: [{ claim: 'Flying to Kansas City takes 90 minutes', query: 'to Kansas City flight time', evidenceTurnIds: [5, 6], category: 'travel_time', place: 'implicit_origin', places: ['Kansas City', 'Paris', 'Dana', 12] }] }
    expect(admitFactCheckClaims(raw, { turns: [...turns, { id: 8, elapsedMs: 607_000, speaker: 'Dana Ortiz', text: 'Dana here.' }] }, [...turns.slice(4, 6), { id: 8, elapsedMs: 607_000, speaker: 'Dana Ortiz', text: 'Dana here.' }]).claims[0].places).toEqual(['Kansas City'])
  })
  it('caps the number of claims and drops duplicates', () => {
    const c = { claim: 'Elephants outweigh cars', query: 'elephant weight car', evidenceTurnIds: [1, 2], category: 'nature' }
    expect(admitFactCheckClaims({ claims: [c, c] }, input('Fact check'), scanned).claims).toHaveLength(1)
    const heart = { claim: 'Heart', query: 'average human heart beats lifetime', evidenceTurnIds: [3], category: 'science' }
    expect(admitFactCheckClaims({ claims: [c, heart] }, input('Fact check'), scanned, { max: 1 }).claims).toHaveLength(1)
    expect(admitFactCheckClaims({ claims: 'nope' }, input('Fact check'), scanned)).toEqual({ claims: [], offered: 0 })
  })
})

describe('pending fact-check continuation', () => {
  const pending = { place: 'implicit_origin' as const, category: 'travel_time', places: ['Kansas City'] }
  const ctx = { ownerArea: { text: 'Austin, TX', source: 'profile' as const }, blockedNames: new Set(['mira', 'elliot', 'sterling', 'hunter', 'ukamya']), ownerWords: new Set(['hunter', 'ukamya', 'mu']) }
  const withClaim = { ...ctx, places: pending.places }
  it('takes a starting place only from a pure clarification, never a name or an ordinary question (QA B1)', () => {
    expect(originClarification('From ATX where mu is based', withClaim)).toEqual({ text: 'ATX (Austin, TX)', source: 'user' })
    expect(originClarification('ATX to KC is the request', withClaim)).toEqual({ text: 'ATX (Austin, TX)', source: 'user' })
    expect(originClarification("I'm flying from Austin", withClaim)).toEqual({ text: 'Austin', source: 'user' })
    expect(originClarification('San Antonio, TX to KC', withClaim)).toEqual({ text: 'San Antonio TX', source: 'user' })
    expect(originClarification('Austin to KC', withClaim)).toEqual({ text: 'Austin', source: 'user' })
    expect(originClarification('from Austin, TX', withClaim)).toEqual({ text: 'Austin TX', source: 'user' })
    // A state suffix must be a real state code, the city a listed one; people, labels and ordinary words are not places.
    for (const q of ['Elliot PM to KC', 'from Talia TX', 'HR to KC', 'time to Kansas', 'from MU', 'MU to KC', 'from Dallas, ZZ'])
      expect(originClarification(q, withClaim)).toBeNull()
    for (const q of ['Mira to send the deck by Friday?', 'What did we hear from Elliot Sterling today?', 'From Elliot', 'From Mira where mu is based', 'from here', 'What did we decide?', 'Dallas to KC', 'ATX to the deck', 'From ATX and send the deck', 'Send the deck from ATX', 'ATX to Paris is the request'])
      expect(originClarification(q, withClaim)).toBeNull()
    // Without a known owner area, an abbreviation is not a place.
    expect(originClarification('From ATX where mu is based', { ...withClaim, ownerArea: null })).toBeNull()
  })
  it('accepts only place-like origins in a named request', () => {
    expect(namedOrigin('Fact check the flight from Dallas, TX to KC', { ...ctx, places: [] })).toEqual({ text: 'Dallas TX', source: 'user' })
    expect(namedOrigin('Fact check what Mira said from Elliot', { ...ctx, places: [] })).toBeNull()
    expect(namedOrigin('Fact check the flight to kc', { ...ctx, places: [] })).toBeNull()
    expect(placeOrigin('DFW', withClaim)).toBeNull()
    expect(placeOrigin('ABQ', withClaim)).toBeNull()
    expect(placeOrigin('KC', withClaim)).toEqual({ text: 'KC', source: 'user' })
    expect(placeOrigin('Kansas', withClaim)).toEqual({ text: 'Kansas', source: 'user' })
    expect(placeOrigin('Mira', { ...withClaim, places: [], blockedNames: new Set(['mira']) })).toBeNull()
    expect(placeOrigin('time', { ...withClaim, places: [] })).toBeNull()
    expect(placeOrigin('KC', { ...withClaim, places: [] })).toBeNull()
    expect(placeCodes('Austin, TX')).toEqual(new Set(['ATX'])); expect(placeCodes('Kansas City, MO')).toEqual(new Set(['KC', 'KCMO']))
    expect(placeCodes('Austin, ZZ')).toEqual(new Set())
    // Initials only: "KS" is not a code of Kansas City. The owner's own name is never a place, even if tagged.
    expect(placeOrigin('KS', withClaim)).toBeNull()
    expect(placeOrigin('Hunter', { ownerArea: null, places: ['Hunter'], blockedNames: new Set(), ownerWords: new Set(['hunter']) })).toBeNull()
    expect(placeOrigin('Hunter', { ownerArea: null, places: ['Hunter'], blockedNames: new Set() })).toEqual({ text: 'Hunter', source: 'user' })
    expect(placeOrigin('Mira', { ownerArea: null, places: ['Mira'], blockedNames: new Set(['mira']) })).toBeNull()
    expect(originQuery('to kansas city flight time', { text: 'ATX (Austin, TX)', source: 'user' })).toBe('atx austin tx to kansas city flight time')
  })
  it('re-runs on request words, clarifies a route origin, and leaves real questions alone', () => {
    for (const q of ['Check it now you', 'Run it omg', "I'm asking you to fact check the claim", 'Do it', 'go ahead and check again'])
      expect(continuationIntent(q, pending, ctx)).toEqual({ kind: 'rerun' })
    expect(continuationIntent('From ATX where mu is based', pending, ctx)).toEqual({ kind: 'clarify', origin: { text: 'ATX (Austin, TX)', source: 'user' } })
    expect(continuationIntent('Mira to send the deck by Friday?', pending, ctx)).toBeNull()
    expect(continuationIntent('What did we hear from Elliot Sterling today?', pending, ctx)).toBeNull()
    expect(continuationIntent('From ATX where mu is based', { ...pending, place: undefined, category: 'travel_time' }, ctx)).toBeNull()
    expect(continuationIntent('Can you fact check this', pending, ctx)).toBeNull()
    expect(continuationIntent('What did the caller say about pricing?', pending, ctx)).toBeNull()
    expect(continuationIntent('What is it?', pending, ctx)).toBeNull()
    expect(continuationIntent('Check the weather in Paris', pending, ctx)).toBeNull()
    expect(continuationIntent('check this now', pending, ctx)).toBeNull()
    expect(continuationIntent('Check it now', null, ctx)).toBeNull()
    expect(continuationIntent('check '.repeat(15), pending, ctx)).toBeNull()
  })
  it('never searches the meta-words of a follow-up', () => {
    expect(userWebQuery("I'm asking you to fact check the claim")).toBeNull()
    expect(userWebQuery('Fact check the flight to kc')).toBe('flight kc')
  })
  it('continues only when the fact check is the latest exchange, within ten meeting minutes, preferring an unsearched or unverified claim', () => {
    const claim = (o: Partial<FactCheckClaim>): FactCheckClaim => ({ n: 1, claim: 'c', baseQuery: 'b', query: 'q', evidenceTurnIds: [1], category: 'nature', atMs: 0, ...o })
    const old = { exchange: ex({ createdAt: '2026-10-13T02:00:00.000Z', throughMs: 100_000 }), factCheck: { claims: [claim({ claim: 'old' })] } }
    const recent = { exchange: ex({ createdAt: '2026-10-13T02:05:00.000Z', throughMs: 600_000 }), factCheck: { claims: [claim({ claim: 'first', atMs: 1, verdict: 'unverified' }), claim({ claim: 'second', atMs: 2, verdict: 'supported' })] } }
    expect(lastFactCheckLookup([old, recent], at(650_000))?.claim.claim).toBe('first')
    recent.factCheck.claims.push(claim({ claim: 'pending', atMs: 0, query: null }))
    expect(lastFactCheckLookup([old, recent], at(650_000))?.claim.claim).toBe('pending')
    expect(lastFactCheckLookup([old, recent], at(600_000 + 10 * 60_000 + 1))).toBeNull()
    expect(lastFactCheckLookup([old], at(100_000 + 10 * 60_000 + 1))).toBeNull()
    expect(lastFactCheckLookup([old], at(650_000))?.claim.claim).toBe('old')
    expect(lastFactCheckLookup([{ ...recent, exchange: { ...recent.exchange, status: 'failed' } }], at(650_000))).toBeNull()
    // An unrelated ask after the check ends the pending check (QA W3).
    const unrelated = { exchange: ex({ createdAt: '2026-10-13T02:06:00.000Z', throughMs: 620_000, question: 'What did Mira say?' }) }
    expect(lastFactCheckLookup([old, recent, unrelated], at(650_000))).toBeNull()
    expect(alreadyCheckedClaims([recent], at(650_000))).toEqual([])
    expect(alreadyCheckedClaims([{ ...recent, exchange: { ...recent.exchange, factCheckRange: { fromMs: 0, throughMs: 600_000, full: true, claims: 3 } } }], at(650_000))).toEqual(['first', 'second', 'pending'])
  })
})

describe('fact-check rows', () => {
  const t1: AskSource = { id: 'T1', kind: 'transcript', title: 'MU · 1:10', text: 'elephants often grow to be over the weight of a car', turnId: 1 }
  const w1 = page('W1', 'An adult African elephant weighs about 6 tonnes.')
  const w2: AskSource = { id: 'W2', kind: 'web', title: 'Web search summary: x', text: 'Elephants weigh several tonnes according to many sites.' }
  const sources = [t1, w1, w2]
  const support = [{ id: 'T1', quote: 'elephants often grow to be over the weight' }, { id: 'W1', quote: 'An adult African elephant weighs about 6 tonnes' }, { id: 'W2', quote: 'Elephants weigh several tonnes' }]
  const row = (text: string) => ({ text, sources: [...text.matchAll(/\[([THFW]\d+)\]/g)].map(m => m[1]) })
  it('holds each row to verdict, verbatim support, read pages, budget and no dose', () => {
    expect(factRowProblem(row('Elephants outweigh a car [T1]: Supported. An adult elephant weighs about 6 tonnes [W1].'), support, sources)).toBeNull()
    expect(factRowProblem(row('Elephants outweigh a car [T1]: Unverified. No readable page was found.'), support, sources)).toBeNull()
    expect(factRowProblem(row('Elephants outweigh a car [T1]. Probably fine.'), support, sources)).toBe('missing_verdict')
    expect(factRowProblem(row('Elephants outweigh a car [T1]: Supported.'), support, sources)).toBe('unverified_verdict')
    expect(factRowProblem(row('Elephants outweigh a car: Supported [W2].'), support, sources)).toBe('page_not_read')
    expect(factRowProblem(row('Elephants outweigh a car: Supported [W1].'), [{ id: 'W1', quote: 'not in the page at all here' }], sources)).toBe('unsupported_citation')
    expect(factRowProblem(row('Elephants: Supported [W1].'), [], sources)).toBe('unsupported_citation')
    expect(factRowProblem(row('Claim [source unavailable]: Unverified.'), support, sources)).toBe('unsupported_citation')
    expect(factRowProblem(row('Dose: Supported [W1]. Give 650 mg.'), support, sources)).toBe('medical_dose')
    expect(factRowProblem(row('Unverified. ' + 'word '.repeat(80)), support, sources)).toBe('too_verbose')
    // A claim's own evidence passage is attribution: no quote needed. Any other transcript ID still needs one.
    expect(factRowProblem(row('Elephants outweigh a car [T1]: Unverified.'), [], sources, new Set(['T1']))).toBeNull()
    expect(factRowProblem(row('Elephants outweigh a car [T1]: Unverified.'), [], sources, new Set(['T9']))).toBe('unsupported_citation')
    expect(factRowProblem(row('Elephants outweigh a car [W1]: Supported [W1].'), [], sources, new Set(['W1']))).toBe('unsupported_citation')
  })
  it('requires one row per claim and a short confidence without coverage talk', () => {
    const rows = [{ label: 'Claim', ...row('Elephants outweigh a car [T1]: Unverified. Not found.') }]
    expect(factCheckProblem({ support, confidence: { reason: 'Clear.' } }, rows, 1, sources)).toBeNull()
    expect(factCheckProblem({ support }, rows, 2, sources)).toBe('claim_rows_mismatch')
    expect(factCheckProblem({ support }, null, 1, sources)).toBe('invalid_sections')
    expect(factCheckProblem({ support, confidence: { reason: 'Only selected passages were used.' } }, rows, 1, sources)).toBe('invented_coverage')
    expect(factCheckProblem({ support, confidence: { reason: 'word '.repeat(17) } }, rows, 1, sources)).toBe('too_verbose_confidence')
    expect(factCheckProblem({ support, confidence: { reason: 'Clear.' } }, [{ label: 'Claim', ...row('No verdict [T1].') }], 1, sources)).toBe('missing_verdict')
  })
  it('summarizes the verdicts the rows actually state and the span scanned', () => {
    const rows = ['A: Supported.', 'B: Mostly supported.', 'C: Contradicted.', 'D: Unverified.', 'E: nothing'].map(text => ({ label: 'Claim', text, sources: [] }))
    expect(factCheckSummary(rows, { fromMs: 0, throughMs: 126_414, full: true, claims: 5 })).toBe('Checked 5 public claims from 0:00 to 2:06: 2 supported, 1 contradicted, 2 unverified.')
    expect(factCheckSummary(rows.slice(2, 3), { fromMs: 126_414, throughMs: 990_000, full: false, claims: 1 })).toBe('Checked 1 public claim new since 2:06: 1 contradicted.')
  })
  it('trims a read page around the claim, verbatim and still marked as read', () => {
    const long = 'Retrieved page excerpt (may be partial): ' + 'filler text. '.repeat(400) + 'Elephants weigh about six tonnes. ' + 'more filler. '.repeat(400)
    const cut = focusExcerpt(long, 'elephant weight', 1000)
    expect(cut.startsWith('Retrieved page excerpt (may be partial): ')).toBe(true)
    expect(cut).toContain('Elephants weigh about six tonnes.')
    expect(cut.length).toBe(1000)
    expect(long).toContain(cut.slice('Retrieved page excerpt (may be partial): '.length))
    expect(focusExcerpt('short', 'x', 1000)).toBe('short')
  })
})

describe('hedged model calls', () => {
  const answer = { text: '{"claims":[]}' }
  it('starts a second call when the first is slow, keeps the first usable answer and stops the other', async () => {
    const signals: AbortSignal[] = []
    const call = vi.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? new Promise<typeof answer>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))) : Promise.resolve(answer) })
    const started = Date.now()
    const out = await hedgedRun(call, { hedgeMs: 10, timeoutMs: 5000, signal: new AbortController().signal })
    expect(out).toEqual({ ...answer, hedged: true }); expect(call).toHaveBeenCalledTimes(2)
    // The slow call is stopped at once, not left to run into the deadline.
    expect(signals[0].aborted).toBe(true); expect(Date.now() - started).toBeLessThan(1000)
  })
  it('never retries a failure or an unusable answer at once; only a still-running call gets a second (QA W7)', async () => {
    const failed = vi.fn().mockRejectedValueOnce(new Error('rate_limited')).mockResolvedValueOnce(answer)
    await expect(hedgedRun(failed, { hedgeMs: 5000, timeoutMs: 2000, signal: new AbortController().signal })).rejects.toThrow('rate_limited')
    expect(failed).toHaveBeenCalledTimes(1)
    const unusable = vi.fn().mockResolvedValueOnce({ text: 'nope' }).mockResolvedValueOnce(answer)
    expect(await hedgedRun(unusable, { hedgeMs: 5000, timeoutMs: 2000, signal: new AbortController().signal, usable: r => r.text !== 'nope' })).toEqual({ text: 'nope', hedged: false })
    expect(unusable).toHaveBeenCalledTimes(1)
    // A first call that failed while the hedge is running waits for the hedge.
    let n = 0
    const slowThenFail = vi.fn((signal: AbortSignal) => ++n === 1 ? new Promise<typeof answer>((_r, reject) => setTimeout(() => reject(new Error('provider_failed')), 30)) : new Promise<typeof answer>(r => setTimeout(() => r(answer), 60)))
    expect((await hedgedRun(slowThenFail, { hedgeMs: 10, timeoutMs: 2000, signal: new AbortController().signal })).hedged).toBe(true)
    // The second call is told it is the hedge, so its token-audit row says so.
    const labels: string[] = []
    const slow = vi.fn((signal: AbortSignal, attempt: number) => { labels.push(attempt ? 'x_hedge' : 'x'); return attempt ? Promise.resolve(answer) : new Promise<typeof answer>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))) })
    await hedgedRun(slow, { hedgeMs: 10, timeoutMs: 2000, signal: new AbortController().signal })
    expect(labels).toEqual(['x', 'x_hedge'])
    const attempts: number[] = []
    const fast = vi.fn(async (_s: AbortSignal, attempt: number) => { attempts.push(attempt); return answer })
    expect((await hedgedRun(fast, { hedgeMs: 5000, timeoutMs: 2000, signal: new AbortController().signal })).hedged).toBe(false)
    expect(attempts).toEqual([0])
  })
  it('fails the ask when a stopped call cannot be confirmed ended, and honours the caller\'s cancel', async () => {
    const { AskProcessError } = await import('./meeting-ask-runner.js')
    let n = 0
    const orphan = vi.fn((signal: AbortSignal) => ++n === 1 ? new Promise<typeof answer>((_r, reject) => signal.addEventListener('abort', () => reject(new AskProcessError('child_exit_unconfirmed', true)))) : Promise.resolve(answer))
    await expect(hedgedRun(orphan, { hedgeMs: 10, timeoutMs: 2000, signal: new AbortController().signal })).rejects.toThrow('child_exit_unconfirmed')
    // A first call whose end cannot be confirmed never gets a second call started beside it.
    const lost = vi.fn().mockRejectedValue(new AskProcessError('child_exit_unconfirmed', true))
    await expect(hedgedRun(lost, { hedgeMs: 5000, timeoutMs: 2000, signal: new AbortController().signal })).rejects.toThrow('child_exit_unconfirmed')
    expect(lost).toHaveBeenCalledTimes(1)
    // An orphaned first call fails the ask at once, without waiting for a still-running hedge.
    let m = 0
    const orphanFirst = vi.fn((signal: AbortSignal) => ++m === 1 ? new Promise<typeof answer>((_r, reject) => setTimeout(() => reject(new AskProcessError('child_exit_unconfirmed', true)), 30)) : new Promise<typeof answer>((_r, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(new Error('cancelled')), 5))))
    const t0 = Date.now()
    await expect(hedgedRun(orphanFirst, { hedgeMs: 5, timeoutMs: 3000, signal: new AbortController().signal })).rejects.toThrow('child_exit_unconfirmed')
    expect(Date.now() - t0).toBeLessThan(1000)
    const caller = new AbortController(); caller.abort()
    const cancelled = vi.fn().mockRejectedValue(new Error('cancelled'))
    await expect(hedgedRun(cancelled, { hedgeMs: 10, timeoutMs: 2000, signal: caller.signal })).rejects.toThrow('cancelled')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
})

describe('medical dosing', () => {
  it('needs a named medicine plus dosing intent; POS work talk, money, counts and schedules never trigger it (QA W4)', () => {
    for (const q of ['whats the dose of tylenol for a child', 'How much Tylenol for Felix?', "how much children's tylenol for 3 year old", 'Can I take 800 mg of ibuprofen?', 'how many advil is safe',
      "How much pain medication for a 400 lb, 5'5 man", 'How much Tylenol can I take?', 'What dose of ibuprofen for my kid?', 'How many mg of Benadryl should I give a 30 lb toddler?', 'How much amoxicillin for a 40 pound child'])
      expect(medicalDosingRequest(q), q).toBe(true)
    for (const q of ['how many tablets should we give the sales team for demos', 'how many units can we give each rep', 'how many units should I take for the demo',
      'How much did I spend on meds', 'How many pills are left in the bottle?', 'When should I take my meds?', 'How much does Tylenol cost?', 'How many people take insulin in the US?',
      'How much ibuprofen is in one Advil tablet?', 'How much does the roof cost?', 'Fact check', 'How many doses of the vaccine did the county order?', "What's the right dosage for a 6 year old?",
      'How much do meds cost for my kid?', 'When can I give my son 2 Tylenol?'])
      expect(medicalDosingRequest(q), q).toBe(false)
  })
})

describe('compose and run', () => {
  const claims = (): FactCheckClaim[] => [
    { n: 1, claim: 'Elephants often weigh more than a car', baseQuery: 'elephant weight vs car weight', query: 'elephant weight vs car weight', evidenceTurnIds: [1, 2], category: 'nature', atMs: 76_000 },
    { n: 2, claim: 'Average heart beats about a billion times in a lifetime', baseQuery: 'average human heart beats lifetime billion', query: 'average human heart beats lifetime billion', evidenceTurnIds: [3], category: 'science', atMs: 100_000 },
  ]
  const transcript: AskSource[] = [{ id: 'T1', kind: 'transcript', title: 'MU · 1:10', text: turns[0].text, turnId: 1 }, { id: 'T2', kind: 'transcript', title: 'Ext · 1:40', text: turns[2].text, turnId: 3 }]
  const web = [page('W1', 'An adult African elephant weighs about 6 tonnes.'), page('W2', 'A human heart beats about 3 billion times in a lifetime.')]
  const webClaim = new Map([['W1', 1], ['W2', 2]])
  const good = JSON.stringify({ sections: [{ label: 'Claim', text: 'Elephants outweigh a car [T1]: Supported. An adult elephant weighs about 6 tonnes [W1].' }, { label: 'Claim', text: 'A billion heartbeats [T2]: Contradicted. About 3 billion in a lifetime [W2].' }], confidence: { level: 'supported', reason: 'Both readable sources state the figures.' }, support: [{ id: 'T1', quote: 'elephants often grow to be over the' }, { id: 'W1', quote: 'An adult African elephant weighs about 6 tonnes' }, { id: 'T2', quote: 'heart beats about a billion times' }, { id: 'W2', quote: 'beats about 3 billion times in a lifetime' }] })
  const args = (run: any, now = () => 0) => ({ mode: 'scope' as const, question: 'Fact check', claims: claims(), transcript, web, webClaim, run, signal: new AbortController().signal, repairUntil: 1000, now })
  it('keeps rows that pass and repairs only while time allows', async () => {
    const run = vi.fn(async (_p: string, _s: string, _signal?: AbortSignal, _caller?: string) => ({ text: good, model: 'claude-sonnet' }))
    const out = await composeFactCheck(args(run))
    expect(run.mock.calls[0][3]).toBe('meeting_fact_check_answer')
    expect(out.rows.map(r => r.text.split(':')[0])).toEqual(['Elephants outweigh a car [T1]', 'A billion heartbeats [T2]'])
    expect(run).toHaveBeenCalledTimes(1); expect(run.mock.calls[0][1]).toBe(FACT_CHECK_SYSTEM)
    const bad = vi.fn().mockResolvedValueOnce({ text: 'not json' }).mockResolvedValueOnce({ text: good })
    expect((await composeFactCheck(args(bad))).rows[1].text).toContain('Contradicted')
    expect(bad).toHaveBeenCalledTimes(2)
    const late = vi.fn(async () => ({ text: 'not json' }))
    const salvaged = await composeFactCheck(args(late, () => 5000))
    // An unusable answer is not retried at once, and no repair round starts after the repair deadline.
    expect(late).toHaveBeenCalledTimes(1)
    expect(salvaged.rows.map(r => r.text)).toEqual(['Elephants often weigh more than a car: Unverified. The pages that could be read did not confirm it.', 'Average heart beats about a billion times in a lifetime: Unverified. The pages that could be read did not confirm it.'])
    const unread = await composeFactCheck({ ...args(late, () => 5000), web: [], webClaim: new Map() })
    expect(unread.rows[0].text).toBe('Elephants often weigh more than a car: Unverified. No readable page was found for it in time.')
  })
  it('repairs a draft that fails the checks only before the repair deadline', async () => {
    const noVerdict = good.replace(': Supported.', '.')
    const early = vi.fn().mockResolvedValueOnce({ text: noVerdict }).mockResolvedValueOnce({ text: good })
    expect((await composeFactCheck(args(early, () => 0))).rows[0].text).toContain('Supported')
    expect(early).toHaveBeenCalledTimes(2)
    expect(JSON.parse(early.mock.calls[1][0]).repairReason).toBe('missing_verdict')
    const tooLate = vi.fn().mockResolvedValueOnce({ text: noVerdict }).mockResolvedValueOnce({ text: good })
    expect((await composeFactCheck(args(tooLate, () => 5000))).rows[0].text).toContain('Unverified')
    expect(tooLate).toHaveBeenCalledTimes(1)
  })
  it('reads a comma list of citations as separate citations', async () => {
    const listed = good.replace('Elephants outweigh a car [T1]: Supported. An adult elephant weighs about 6 tonnes [W1].', 'Elephants outweigh a car [T1, W1]: Supported. An adult elephant weighs about 6 tonnes.')
    const out = await composeFactCheck(args(vi.fn(async () => ({ text: listed })), () => 5000))
    expect(out.rows[0].text).toBe('Elephants outweigh a car [T1][W1]: Supported. An adult elephant weighs about 6 tonnes.')
    expect(out.rows[0].sources).toEqual(['T1', 'W1'])
  })
  it('gives a stalled answer its own reason and never claims pages it did not use (QA W1)', async () => {
    const late = vi.fn().mockRejectedValue(new Error('provider_timeout'))
    const gone = await composeFactCheck({ ...args(late, () => 0), answerUntil: 20_000 })
    expect(late).toHaveBeenCalledTimes(1)
    expect(gone.stalled).toBe(true)
    expect(gone.rows[0].text).toBe('Elephants often weigh more than a car: Unverified. The answer ran out of time before this claim could be checked.')
    expect(gone.notices[0]).toContain('ran out of time')
    expect(gone.rows.every(r => r.text.includes('Unverified'))).toBe(true)
    const aborted = new AbortController(); aborted.abort()
    await expect(composeFactCheck({ ...args(vi.fn().mockRejectedValue(new Error('cancelled'))), signal: aborted.signal })).rejects.toThrow('cancelled')
  })
  it('salvages valid rows by their words, replaces invalid ones, and always states an assumed origin', async () => {
    const partial = JSON.stringify({ sections: [{ label: 'Claim', text: 'A billion heartbeats lifetime [T2]: Contradicted. About 3 billion in a lifetime [W2].' }], support: [{ id: 'T2', quote: 'heart beats about a billion times' }, { id: 'W2', quote: 'beats about 3 billion times in a lifetime' }] })
    const out = await composeFactCheck(args(vi.fn(async () => ({ text: partial })), () => 5000))
    expect(out.rows[0].text).toContain('Elephants often weigh more than a car: Unverified.')
    expect(out.rows[1].text).toContain('Contradicted')
    expect(out.notices.join(' ')).toContain('one claim could not be confirmed')
    const routed = { n: 1, claim: 'Flight to Kansas City takes 90 minutes', baseQuery: 'to kansas city flight time', query: 'austin tx to kansas city flight time', evidenceTurnIds: [5], category: 'travel_time', place: 'implicit_origin' as const, origin: { text: 'Austin, TX', source: 'profile' as const }, atMs: 1 }
    const single = JSON.stringify({ sections: [{ label: 'So what', text: 'Flight takes 90 minutes: Unverified. No route time was found.' }], support: [] })
    const done = await composeFactCheck({ ...args(vi.fn(async () => ({ text: single }))), mode: 'single', claims: [routed], web: [], webClaim: new Map() })
    expect(done.rows[0].text).toBe("Assuming Austin, TX, where you're based (your COS profile), as the starting point. Flight takes 90 minutes: Unverified. No route time was found.")
  })
  it('runs a first meeting-wide check, then only new content, with each admitted query searched once', async () => {
    const plan = { claims: [
      { claim: 'Elephants often weigh more than a car', query: 'elephant weight vs car weight', evidenceTurnIds: [1, 2], category: 'nature' },
      { claim: 'Average heart beats about a billion times in a lifetime', query: 'average human heart beats lifetime billion', evidenceTurnIds: [3], category: 'science' },
    ] }
    // The run path renumbers transcript passages by time: turn 3 is T3 there.
    const goodRun = good.replace('[T2]', '[T3]').replace('"id":"T2"', '"id":"T3"')
    const run = vi.fn(async (_p: string, system: string) => ({ text: system === FACT_CHECK_PLANNER_SYSTEM ? JSON.stringify(plan) : goodRun, model: 'claude-sonnet' }))
    const search = vi.fn(async (q: string) => ({ sources: [q.startsWith('elephant') ? web[0] : web[1]], notices: [] }))
    const first = await runMeetingFactCheck({ mode: 'scope', input: input(MEETING_FACT_CHECK_QUESTION, 126_414), at: at(126_414), records: [], run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    // The watermark is the last scanned turn (1:40), not the ask position (QA W2).
    expect(first!.factCheckRange).toEqual({ fromMs: 0, throughMs: 100_000, full: true, claims: 2 })
    expect(search.mock.calls.map(c => c[0])).toEqual(['elephant weight vs car weight', 'average human heart beats lifetime billion'])
    expect(first!.sections.map(s => s.label)).toEqual(['So what', 'Claim', 'Claim', 'Confidence'])
    expect(first!.sections[0].text).toBe('Checked 2 public claims from 0:00 to 1:40: 1 supported, 1 contradicted.')
    expect(first!.publicWebQuery).toBe('elephant weight vs car weight | average human heart beats lifetime billion')
    expect(first!.claims.map(c => c.verdict)).toEqual(['supported', 'contradicted'])
    const planner = JSON.parse(run.mock.calls[0][0])
    expect(planner.transcript).not.toContain('Dana Ortiz')
    expect(planner.window).toEqual({ from: '0:00', through: '2:06', wholeMeetingSoFar: true })
    const record = { exchange: ex({ throughMs: 126_414, factCheckRange: first!.factCheckRange, sections: first!.sections }), factCheck: { claims: first!.claims } }
    run.mockClear(); search.mockClear()
    run.mockImplementation(async (_p: string, system: string) => ({ text: system === FACT_CHECK_PLANNER_SYSTEM ? '{"claims":[]}' : good, model: 'claude-sonnet' }))
    const second = await runMeetingFactCheck({ mode: 'scope', input: input(MEETING_FACT_CHECK_QUESTION, 140_000), at: at(140_000), records: [record], run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(JSON.parse(run.mock.calls[0][0]).alreadyChecked).toEqual(['Elephants often weigh more than a car', 'Average heart beats about a billion times in a lifetime'])
    expect(JSON.parse(run.mock.calls[0][0]).transcript).not.toContain('elephants')
    expect(JSON.parse(run.mock.calls[0][0]).earlierResults).toHaveLength(2)
    expect(second!.factCheckRange).toEqual({ fromMs: 100_000, throughMs: 130_000, full: false, claims: 0 })
    expect(second!.sections[0].text).toBe('No new checkable public claim was found since 1:40.')
    expect(search).not.toHaveBeenCalled()
    run.mockClear()
    const nothing = await runMeetingFactCheck({ mode: 'scope', input: input(MEETING_FACT_CHECK_QUESTION, 126_414), at: at(126_414), records: [record], run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(nothing!.sections[0].text).toBe('Nothing new to check: nothing was said after the last Fact check at 1:40.')
    expect(run).not.toHaveBeenCalled()
    // "Fact check the whole meeting" rescans from 0:00 and re-checks everything (QA W8).
    run.mockImplementation(async (_p: string, system: string) => ({ text: system === FACT_CHECK_PLANNER_SYSTEM ? JSON.stringify(plan) : goodRun, model: 'claude-sonnet' }))
    const again = await runMeetingFactCheck({ mode: 'scope', input: input('Fact check the whole meeting', 126_414), at: at(126_414), records: [record], run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(JSON.parse(run.mock.calls[0][0]).alreadyChecked).toEqual([])
    expect(again!.factCheckRange).toEqual({ fromMs: 0, throughMs: 100_000, full: true, claims: 2 })
    expect(again!.notices).toContain('Fact check rescanned the whole meeting, as asked.')
    expect(factCheckRescanRequest('Fact check again')).toBe(true); expect(factCheckRescanRequest(MEETING_FACT_CHECK_QUESTION)).toBe(false)
    // A first check with nothing said yet does not name a previous check.
    run.mockClear()
    const empty = await runMeetingFactCheck({ mode: 'scope', input: { ...input('Fact check', 5_000), turns: [] }, at: at(5_000), records: [], run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(empty!.sections[0].text).toBe('Nothing has been said yet to check.')
  })
  it('keeps no range when the answer stalls or no page was read, so the next check covers the span again (QA W1)', async () => {
    const plan = { claims: [{ claim: 'Elephants often weigh more than a car', query: 'elephant weight vs car weight', evidenceTurnIds: [1, 2], category: 'nature' }] }
    const unread = vi.fn(async () => ({ sources: [{ id: 'W1', kind: 'web' as const, title: 'Web search summary: x', text: 'Summary only.' }], notices: [] as string[] }))
    const draft = JSON.stringify({ sections: [{ label: 'Claim', text: 'Elephants outweigh a car [T2]: Unverified. No page was read.' }], confidence: { level: 'low', reason: 'No page was read.' }, support: [] })
    const run = vi.fn(async (_p: string, system: string) => ({ text: system === FACT_CHECK_PLANNER_SYSTEM ? JSON.stringify(plan) : draft }))
    const noRead = await runMeetingFactCheck({ mode: 'scope', input: input('Fact check', 126_414), at: at(126_414), records: [], run, search: unread, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(noRead!.factCheckRange).toBeUndefined()
    expect(noRead!.sections[0].text).toBe('Could not finish checking the claim; tap Fact check again.')
    expect(noRead!.notices).toContain('This Fact check did not finish checking its claims, so the next Fact check covers the same part of the meeting again.')
    const stall = vi.fn(async (_p: string, system: string, _signal?: AbortSignal, _caller?: string) => { if (system === FACT_CHECK_PLANNER_SYSTEM) return { text: JSON.stringify(plan) }; throw new Error('provider_timeout') })
    const readPage = vi.fn(async () => ({ sources: [page('W1', 'An adult African elephant weighs about 6 tonnes.')], notices: [] as string[] }))
    const stalled = await runMeetingFactCheck({ mode: 'scope', input: input('Fact check', 126_414), at: at(126_414), records: [], run: stall, search: readPage, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(stalled!.factCheckRange).toBeUndefined()
    expect(stalled!.sections[1].text).toContain('The answer ran out of time before this claim could be checked.')
    expect(stall.mock.calls.map(c => c[3])).toEqual(['meeting_fact_check_planner', 'meeting_fact_check_answer'])
  })
  it('on a partial failure keeps the range only up to the first unchecked claim and leaves it out of already-checked (QA W3 note 3)', async () => {
    const plan = { claims: [
      { claim: 'Elephants often weigh more than a car', query: 'elephant weight vs car weight', evidenceTurnIds: [1, 2], category: 'nature' },
      { claim: 'Average heart beats about a billion times in a lifetime', query: 'average human heart beats lifetime', evidenceTurnIds: [3], category: 'science' },
    ] }
    const reply = JSON.stringify({ sections: [{ label: 'Claim', text: 'Elephants outweigh a car [T1]: Supported. An adult elephant weighs about 6 tonnes [W1].' }, { label: 'Claim', text: 'A billion heartbeats [T3]: Unverified. No page was read.' }], confidence: { level: 'limited', reason: 'One claim was checked.' }, support: [{ id: 'W1', quote: 'An adult African elephant weighs about 6 tonnes' }] })
    const run = vi.fn(async (_p: string, system: string) => ({ text: system === FACT_CHECK_PLANNER_SYSTEM ? JSON.stringify(plan) : reply }))
    const search = vi.fn(async (q: string) => q.startsWith('elephant') ? { sources: [page('W1', 'An adult African elephant weighs about 6 tonnes.')], notices: [] as string[] } : { sources: [] as AskSource[], notices: ['The public lookup ended before readable pages were returned. This claim remains unverified.'] })
    const out = await runMeetingFactCheck({ mode: 'scope', input: input('Fact check', 126_414), at: at(126_414), records: [], run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(out!.factCheckRange).toEqual({ fromMs: 0, throughMs: 99_999, full: true, claims: 1 })
    expect(out!.claims.map(c => c.checked)).toEqual([true, false])
    expect(out!.notices).toContain('One claim could not be checked from a readable page; the next Fact check retries it.')
    const record = { exchange: ex({ throughMs: 126_414, factCheckRange: out!.factCheckRange, sections: out!.sections }), factCheck: { claims: out!.claims } }
    expect(alreadyCheckedClaims([record], at(200_000))).toEqual(['Elephants often weigh more than a car'])
    // The next check starts before the unchecked claim, so it is listed again.
    expect(factCheckWindow([record.exchange], at(200_000))).toEqual({ fromMs: 99_999, full: false })
    expect(factCheckScanTurns(input('x', 200_000), factCheckWindow([record.exchange], at(200_000))).turns.map(t => t.id)).toContain(3)
  })
  it('skips a lookup once the search budget is spent, and a named check with no admissible claim falls back', async () => {
    const plan = { claims: [{ claim: 'Elephants outweigh cars', query: 'elephant weight vs car weight', evidenceTurnIds: [1, 2], category: 'nature' }] }
    const run = vi.fn(async (_p: string, system: string) => ({ text: system === FACT_CHECK_PLANNER_SYSTEM ? JSON.stringify(plan) : 'not json' }))
    const search = vi.fn()
    const late = await runMeetingFactCheck({ mode: 'scope', input: input('Fact check', 126_414), at: at(126_414), records: [], run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() - 60_000 })
    expect(search).not.toHaveBeenCalled()
    expect(late!.notices.join(' ')).toContain('lookup budget ended')
    const rejected = vi.fn(async (_p: string, system: string) => ({ text: system === FACT_CHECK_PLANNER_SYSTEM ? JSON.stringify({ claims: [{ ...plan.claims[0], query: 'dana elephant weight car' }] }) : 'not json' }))
    expect(await runMeetingFactCheck({ mode: 'named', input: input('Fact check the elephants'), at: at(800_000), records: [], run: rejected, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })).toBeNull()
  })
  it('keeps no range when claim selection fails, and lets a named check fall back', async () => {
    const run = vi.fn(async () => ({ text: 'not json' }))
    const failed = await runMeetingFactCheck({ mode: 'scope', input: input('Fact check', 126_414), at: at(126_414), records: [], run, search: vi.fn(), ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(failed!.factCheckRange).toBeUndefined()
    expect(failed!.sections[0].text).toContain('could not list the claims')
    const named = await runMeetingFactCheck({ mode: 'named', input: input('Fact check the flight to kc'), at: at(800_000), records: [], run, search: vi.fn(), ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(named!.sections[0].text).toContain('could not prepare that fact check in time')
    expect(named!.factCheckRange).toBeUndefined(); expect(named!.claims).toEqual([])
  })
  it('continues a pending route check with the typed origin and reuses only pages read for that same query', async () => {
    const read = page('W9', 'Nonstop flights from Austin to Kansas City take about 1 hour 50 minutes.')
    const pending: FactCheckClaim = { n: 1, claim: 'Flying to Kansas City takes 90 minutes', baseQuery: 'to kansas city flight time', query: 'austin tx to kansas city flight time', evidenceTurnIds: [5, 6], category: 'travel_time', place: 'implicit_origin', origin: { text: 'Austin, TX', source: 'profile' }, atMs: 606_000, retrievalIds: ['ret-W9'], pages: [read] }
    const exchange = ex({ throughMs: 811_966, sources: [read] })
    const search = vi.fn(async (_q: string) => ({ sources: [read], notices: [] as string[] }))
    const reply = JSON.stringify({ sections: [{ label: 'So what', text: 'Flight to Kansas City [T1]: Supported. About 1 hour 50 minutes nonstop [W1].' }], support: [{ id: 'T1', quote: 'flying from here to Kansas City' }, { id: 'W1', quote: 'take about 1 hour 50 minutes' }] })
    const run = vi.fn(async () => ({ text: reply }))
    const clarified = await runMeetingFactCheck({ mode: 'continue', input: input('From ATX where mu is based', 855_689), at: at(855_689), records: [], continuation: { claim: pending, exchange, intent: { kind: 'clarify', origin: { text: 'ATX', source: 'user' } } }, run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(search.mock.calls[0][0]).toBe('atx to kansas city flight time')
    expect(clarified!.claims[0].origin).toEqual({ text: 'ATX', source: 'user' })
    expect(clarified!.sections[0].text.startsWith('Using ATX as the starting point, as you said.')).toBe(true)
    expect(clarified!.factCheckRange).toBeUndefined()
    // The notice names the re-run claim and says the typed place went into the query (QA B1 notice).
    expect(clarified!.notices.join(' ')).toContain('Re-running the fact check of "Flying to Kansas City takes 90 minutes" (said at 10:06) with the starting point you gave, ATX; only that place name was added')
    expect(clarified!.notices.join(' ')).not.toContain('were not searched')
    search.mockClear()
    const rerun = await runMeetingFactCheck({ mode: 'continue', input: input('Run it omg', 900_000), at: at(900_000), records: [], continuation: { claim: pending, exchange, intent: { kind: 'rerun' } }, run, search, ownerArea: () => null, signal: new AbortController().signal, startedAt: Date.now() })
    expect(search).not.toHaveBeenCalled()
    expect(rerun!.notices.join(' ')).toContain('reused readable pages')
    expect(rerun!.notices.join(' ')).toContain('Re-running the fact check of "Flying to Kansas City takes 90 minutes" (said at 10:06) under your public-topic setting. The words of your follow-up were not searched.')
    expect(reusablePages({ claim: pending, exchange }, { ...pending, query: 'other' }, Date.now())).toEqual([])
    expect(reusablePages({ claim: pending, exchange }, pending, Date.now() + 16 * 60_000)).toEqual([])
  })
  it('has a kill switch and reads the owner area from the profile only as a city label', () => {
    expect(factCheckScopeEnabled({})).toBe(true)
    expect(factCheckScopeEnabled({ COS_MEETING_FACT_CHECK_SCOPE: '0' })).toBe(false)
    expect(doseGuardEnabled({})).toBe(true)
    expect(doseGuardEnabled({ COS_MEETING_ASK_DOSE_GUARD: '0' })).toBe(false)
    expect(doseGuardEnabled({ COS_MEETING_FACT_CHECK_SCOPE: '0' })).toBe(true)
    expect(typeof defaultOwnerArea).toBe('function')
  })
})
