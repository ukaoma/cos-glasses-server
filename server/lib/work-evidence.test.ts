import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JEV_KEY_FILE, JEV_USAGE_FILE, JevClient } from './jev.js'
import { LATEST_REPLY_MAX } from './agent-session-store.js'
import { SESSION_TURNS_MAX } from './agent-session-turns.js'
import { SafeFetchError, type SafeFetchResult } from './safe-fetch.js'
import {
  EVIDENCE_LIMITS, WORK_EVIDENCE_USAGE_FILE, WorkEvidenceChecker, clauseUrls, createWorkEvidenceJevClient, decodeCursor, defaultWorkEvidenceDeps,
  distinctiveWords, encodeCursor, markersFor, parseEvidenceRequest, readSessionSince, sameUrl, statusLines, workEvidenceDailyCap, workEvidenceEnabled,
  type EvidenceCard, type EvidenceRequest, type WorkEvidenceDeps,
} from './work-evidence.js'

const CARD_ID = '5755b516df8f'
const OTHER = 'aaaaaaaaaaaa'
const SESSION = 'ff34d7bf-3338-4462-8234-78f8b86de158'
const SESSION_B = '9f3c9a2e-1111-4222-8333-944455556666'
const OFFER = 'https://bottlepos.com/october-switch-offer'
const CLAUSES = [`${OFFER} page is live`, 'Facebook ads are running against it, driving traffic there']
const card: EvidenceCard = { id: CARD_ID, title: 'Launch the October switch offer page and Facebook ads', text: 'Launch the October switch offer page and Facebook ads for Pete',
  meetingRefs: [{ recordId: 'rec-1', domain: 'quilt', month: '2026-10', filename: 'pete.md', title: 'Pete sync' }] }
const req = (over: Partial<EvidenceRequest> = {}): EvidenceRequest => ({ domain: 'quilt', id: CARD_ID, follows: [{ provider: 'claude', sessionId: SESSION, cursor: null }], clauses: CLAUSES, since: '2026-10-02T23:52:00Z', ...over })

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'work evidence.')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })

// --- transcript fixtures (the record shapes the providers write) ----------------------------------------------------
const claudeUser = (text: string, at: string) => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'text', text }] } })
const claudeReply = (text: string, at: string) => JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const claudeTool = (at: string) => JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'x'.repeat(500) } }] } })
const cursorUser = (text: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }] } })
const cursorReply = (text: string) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text }] } })
const minute = (n: number) => new Date(Date.UTC(2026, 9, 3, 0, 0) + n * 60_000).toISOString()
const write = (name: string, lines: string[]) => { const p = join(dir, name); writeFileSync(p, lines.map(l => l + '\n').join('')); return p }
const TAGS = new Set([CARD_ID])

/** A 300-turn Claude session: one reply a minute from 10/03 00:00, the handoff at turn 0. */
function claude300(): string {
  const lines = [claudeUser(`Ship it.\n\nCOS-WORK ${CARD_ID}: <done, needs input or blocked>: <one sentence of evidence>`, minute(0))]
  for (let i = 1; i <= 300; i++) { lines.push(claudeTool(minute(i))); lines.push(claudeReply(`Reply number ${i}.`, minute(i))) }
  return write('claude.jsonl', lines)
}

describe('the request', () => {
  const body = { domain: 'quilt', id: CARD_ID, follows: [{ provider: 'claude', sessionId: SESSION, cursor: null }], clauses: CLAUSES, since: '2026-10-02T23:52:00Z' }
  it('accepts exactly the contract body, and an empty follows or clauses list', () => {
    expect(parseEvidenceRequest(body)).toEqual({ ...body, follows: [{ provider: 'claude', sessionId: SESSION, cursor: null }] })
    expect(parseEvidenceRequest({ ...body, follows: [], clauses: [] })).toMatchObject({ follows: [], clauses: [] })
    const cursor = encodeCursor({ v: 1, id: 'x', o: 10, t: null, p: '' })
    expect(parseEvidenceRequest({ ...body, follows: [{ provider: 'cursor', sessionId: SESSION_B, cursor }] })?.follows[0]?.cursor).toBe(cursor)
  })
  it('refuses every other shape', () => {
    const f = body.follows[0]!
    const bads: unknown[] = [null, [], 'x', { ...body, extra: 1 }, { domain: body.domain, id: body.id, follows: body.follows, clauses: body.clauses },
      { ...body, domain: '../etc' }, { ...body, domain: 7 }, { ...body, id: 'abc' }, { ...body, id: CARD_ID.toUpperCase() },
      { ...body, since: 'yesterday' }, { ...body, since: '2026-13-45T99:00:00Z' }, { ...body, since: 1 },
      { ...body, follows: [f, { ...f, sessionId: SESSION_B }, { ...f, sessionId: '11111111-2222' }, { ...f, sessionId: '33333333-4444' }, { ...f, sessionId: '55555555-6666' }] },
      { ...body, follows: [f, { ...f }] }, { ...body, follows: [{ ...f, provider: 'ollama' }] }, { ...body, follows: [{ ...f, sessionId: '../../x' }] },
      { ...body, follows: [{ provider: 'claude', sessionId: SESSION }] }, { ...body, follows: [{ ...f, extra: 1 }] }, { ...body, follows: [{ ...f, cursor: 'not base64!' }] },
      { ...body, follows: [{ ...f, cursor: encodeCursor({ v: 1, id: 'x', o: 10, t: null, p: '' }).slice(0, -6) + '!!' }] },
      { ...body, follows: [{ ...f, cursor: 'eyJ2IjoyfQ' }] }, { ...body, follows: 'x' },
      { ...body, clauses: Array(7).fill('x') }, { ...body, clauses: ['x'.repeat(301)] }, { ...body, clauses: ['   '] }, { ...body, clauses: [3] }, { ...body, clauses: ['a\u0000b'] }]
    for (const bad of bads) expect(parseEvidenceRequest(bad), JSON.stringify(bad)?.slice(0, 120)).toBeNull()
    expect(parseEvidenceRequest({ ...body, clauses: ['x'.repeat(300)] })).not.toBeNull()
  })
})

describe('text helpers', () => {
  it('reads status lines the way COS Control does', () => {
    const text = `**COS-WORK ${CARD_ID}:** done: the page is live\n- COS-WORK ${OTHER}: blocked: waiting on Jeremy\nCOS-WORK ${CARD_ID}: <done, needs input or blocked>: <one sentence of evidence>\nCOS-WORK ${CARD_ID} done`
    expect(statusLines(text)).toEqual([{ tag: CARD_ID, state: 'done', line: `COS-WORK ${CARD_ID}: done: the page is live` }, { tag: OTHER, state: 'blocked', line: `COS-WORK ${OTHER}: blocked: waiting on Jeremy` }])
  })
  it('finds a clause\'s URLs, compares pages, and builds markers without the host\'s own words', () => {
    expect(clauseUrls(`See ${OFFER}, and (https://bottlepos.com/pricing).`)).toEqual([OFFER, 'https://bottlepos.com/pricing'])
    expect(sameUrl(OFFER, OFFER + '/')).toBe(true)
    expect(sameUrl(OFFER, 'https://www.bottlepos.com/october-switch-offer')).toBe(false)
    expect(sameUrl(OFFER, OFFER + '?v=2')).toBe(false)
    const m = markersFor(CLAUSES[0]!, card.title, OFFER)
    expect(m.words).toEqual(expect.arrayContaining(['october', 'switch', 'offer']))
    expect(m.words).not.toContain('bottlepos')
    expect(m.words).not.toContain('page')
    expect(markersFor('The "Switch to Bottle POS" banner is live at ' + OFFER, card.title, OFFER)).toEqual({ phrases: ['Switch to Bottle POS'] })
    expect(distinctiveWords('the page is live at https://x.com/y')).toEqual([])
  })
})

describe('incremental session reads', () => {
  it('reads every reply since `since`, past the 40-turn read and the 4,000-character reply', async () => {
    const path = claude300()
    const all = await readSessionSince('claude', SESSION, path, null, Date.parse('2026-10-02T23:52:00Z'), TAGS)
    expect(all.replies).toHaveLength(300)
    expect(all.replies.length).toBeGreaterThan(SESSION_TURNS_MAX)
    expect(all.truncated).toBe(false)
    const half = await readSessionSince('claude', SESSION, path, null, Date.parse(minute(251)), TAGS)
    expect(half.replies.map(r => r.text)).toEqual(Array.from({ length: 50 }, (_, i) => `Reply number ${251 + i}.`))
    const long = write('long.jsonl', [claudeReply('A'.repeat(9_000) + ' END', minute(1))])
    const read = await readSessionSince('claude', SESSION, long, null, 0, TAGS)
    expect(read.replies[0]!.text.length).toBeGreaterThan(LATEST_REPLY_MAX)
    expect(read.replies[0]!.text.endsWith('END')).toBe(true)
  })

  it('hands back a cursor and reads only what came after it, whole lines only', async () => {
    const path = claude300()
    const first = await readSessionSince('claude', SESSION, path, null, 0, TAGS)
    const none = await readSessionSince('claude', SESSION, path, first.cursor, 0, TAGS)
    expect(none.replies).toEqual([])
    expect(none.cursor).toBe(first.cursor)
    appendFileSync(path, claudeReply('Page is live, 200 checked.', minute(301)) + '\n' + claudeReply('Half a li', minute(302)).slice(0, 40))
    const next = await readSessionSince('claude', SESSION, path, first.cursor, 0, TAGS)
    expect(next.replies.map(r => r.text)).toEqual(['Page is live, 200 checked.'])  // the half-written line waits
    appendFileSync(path, claudeReply('Half a li', minute(302)).slice(40) + '\n')
    const rest = await readSessionSince('claude', SESSION, path, next.cursor, 0, TAGS)
    expect(rest.replies.map(r => r.text)).toEqual(['Half a li'])
  })

  it('falls back to the cursor\'s time when the transcript was rewritten under it, and refuses another session\'s cursor', async () => {
    const path = claude300()
    const first = await readSessionSince('claude', SESSION, path, null, 0, TAGS)
    // Rewritten: same replies plus one newer, but the bytes before the old offset differ.
    writeFileSync(path, ['{"type":"summary","summary":"compacted"}', claudeReply('Reply number 300.', minute(300)), claudeReply('Newer than the cursor.', minute(305))].map(l => l + '\n').join(''))
    const after = await readSessionSince('claude', SESSION, path, first.cursor, 0, TAGS)
    expect(after.replies.map(r => r.text)).toEqual(['Newer than the cursor.'])
    // The same bytes under another session id: not this session's cursor, so it counts from `since`.
    const other = await readSessionSince('claude', SESSION_B, path, after.cursor, Date.parse(minute(300)), TAGS)
    expect(other.replies.map(r => r.text)).toEqual(['Reply number 300.', 'Newer than the cursor.'])
    expect(decodeCursor('garbage')).toBeNull()
  })

  it('a rewritten transcript longer than the old offset is caught by the bytes before the cursor', async () => {
    const path = write('rw.jsonl', Array.from({ length: 10 }, (_, i) => claudeReply(`Old ${i + 1}.`, minute(i + 1))))
    const first = await readSessionSince('claude', SESSION, path, null, 0, TAGS)
    // Same times, longer words: the old offset now lands mid-way through rewritten replies.
    writeFileSync(path, [...Array.from({ length: 10 }, (_, i) => claudeReply(`Rewritten reply ${i + 1} with many more words in it.`, minute(i + 1))),
      claudeReply('Genuinely new.', minute(11))].map(l => l + '\n').join(''))
    expect(decodeCursor(first.cursor)!.o).toBeLessThan(readFileSync(path).length)
    expect((await readSessionSince('claude', SESSION, path, first.cursor, 0, TAGS)).replies.map(r => r.text)).toEqual(['Genuinely new.'])
  })

  it('says truncated when its byte limit ends before `since` or the cursor', async () => {
    const path = claude300()
    const small = [2_048, 8_192]
    const fromSince = await readSessionSince('claude', SESSION, path, null, Date.parse(minute(1)), TAGS, small)
    expect(fromSince.truncated).toBe(true)
    expect(fromSince.replies.length).toBeGreaterThan(0)
    const near = await readSessionSince('claude', SESSION, path, null, Date.parse(minute(299)), TAGS, small)
    expect(near.truncated).toBe(false)
    expect(near.replies.map(r => r.text)).toEqual(['Reply number 299.', 'Reply number 300.'])
    const start = await readSessionSince('claude', SESSION, write('tiny.jsonl', [claudeReply('only', minute(1))]), null, 0, TAGS)
    const cursorAtZero = encodeCursor({ ...decodeCursor(start.cursor)!, o: 0, p: '' })
    const behind = await readSessionSince('claude', SESSION, path, cursorAtZero, 0, TAGS, small)
    expect(behind.truncated).toBe(true)
  })

  it('a Cursor transcript (no times) counts from the card\'s handoff prompt, then in file order', async () => {
    const path = write('cursor.jsonl', [cursorUser('Earlier unrelated work'), cursorReply('Old: the page is live.'),
      cursorUser(`Do the card.\nCOS-WORK ${CARD_ID}: <done, needs input or blocked>: <one sentence of evidence>`), cursorReply('Working on it.'), cursorReply('Published the page.')])
    const first = await readSessionSince('cursor', SESSION, path, null, 0, TAGS)
    expect(first).toMatchObject({ anchored: true, truncated: false })
    expect(first.replies.map(r => r.text)).toEqual(['Working on it.', 'Published the page.'])
    appendFileSync(path, cursorReply('Ads are running.') + '\n')
    expect((await readSessionSince('cursor', SESSION, path, first.cursor, 0, TAGS)).replies.map(r => r.text)).toEqual(['Ads are running.'])
    // No handoff prompt for this card: not anchored, so untagged replies will not count.
    const stray = write('stray.jsonl', [cursorUser('Something else'), cursorReply('Done with that.')])
    expect(await readSessionSince('cursor', SESSION, stray, null, 0, TAGS)).toMatchObject({ anchored: false, truncated: false })
    // Last written before `since`: nothing new at all.
    utimesSync(path, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    expect((await readSessionSince('cursor', SESSION, path, null, Date.parse('2026-10-02T00:00:00Z'), TAGS)).replies).toEqual([])
  })
})

// --- the checker -------------------------------------------------------------------------------------------------------
type Answers = Record<string, { probabilities: Record<string, number> }>
/** A fake Jev: `judge` sees the state it was sent and returns per-clause [verdict, kind, picked item index or 'none']. */
function fakeJev(judge: (state: any) => Array<[string, string, number | 'none']>) {
  const calls: Array<{ state: any; questions: any; estimate: number }> = []
  const jev = { ask: vi.fn(async (state: any, questions: any, estimate: number) => {
    calls.push({ state, questions, estimate })
    const answers: Answers = {}
    judge(state).forEach(([v, k, e], i) => {
      answers[`v${i}`] = { probabilities: { met: v === 'met' ? 0.93 : 0.03, not_met: v === 'not_met' ? 0.9 : 0.04, unclear: v === 'unclear' ? 0.9 : 0.04 } }
      answers[`k${i}`] = { probabilities: { [k]: 0.9, ...(k === 'none' ? {} : { none: 0.1 }) } }
      answers[`e${i}`] = { probabilities: { [e === 'none' ? 'none' : `e${e}`]: 0.88 } }
    })
    return { answers, model: 'jev-1.13.0', inputTokens: estimate }
  }) }
  return { jev, calls }
}
const urlIndex = (state: any) => state.evidence.findIndex((e: any) => e.source === 'url')
const LIVE: SafeFetchResult = { status: 200, finalUrl: OFFER, title: 'Switch to Bottle POS: $3,000 + Free Hardware', markerFound: true }

function checker(over: Partial<WorkEvidenceDeps> & { sessions?: Record<string, string> } = {}) {
  const sessions = over.sessions ?? {}
  const deps: WorkEvidenceDeps = defaultWorkEvidenceDeps({
    jev: fakeJev(() => []).jev as any,
    findSession: async (_p, id) => sessions[id] ?? null,
    fetchUrl: vi.fn(async () => LIVE),
    meeting: async () => null,
    slack: async () => ({ available: false }),
    enabled: () => true,
    now: () => Date.parse('2026-10-07T21:32:00Z'),
    ...over,
  })
  return { c: new WorkEvidenceChecker(deps), deps }
}

describe('judging', () => {
  it('Pete\'s card: the live page meets clause 1 deterministically, "ready to go live" does not meet clause 2', async () => {
    const path = write('pete.jsonl', [claudeUser(`Launch it.\nCOS-WORK ${CARD_ID}: <done, needs input or blocked>: <x>`, minute(0)),
      claudeReply('Offer page is ready to go live, just need Jeremy to sign off on the Facebook ads.', minute(5))])
    const { jev, calls } = fakeJev(state => [['met', 'fact', urlIndex(state)], ['not_met', 'intent', 0]])
    const { c, deps } = checker({ jev: jev as any, sessions: { [SESSION]: path } })
    const result = await c.check(req(), card)
    expect(result).toMatchObject({ provider: 'jev', model: 'jev-1.13.0', basis: 'clauses', sources: ['session', 'url'], truncated: false, cached: false, skipped: null })
    if (result.provider !== 'jev') throw new Error('no verdict')
    expect(result.clauses[0]).toEqual({ text: CLAUSES[0], verdict: 'met', confidence: 0.93, kind: 'fact', deterministic: true,
      evidence: { source: 'url', ref: OFFER, excerpt: '200 · Switch to Bottle POS: $3,000 + Free Hardware', at: '2026-10-07T21:32:00.000Z' } })
    expect(result.clauses[1]).toMatchObject({ text: CLAUSES[1], verdict: 'not_met', kind: 'intent', deterministic: false, evidence: { source: 'session' } })
    expect(result.cursors).toEqual([{ provider: 'claude', sessionId: SESSION, cursor: expect.any(String) }])
    // One Jev call, three choices per clause, the evidence choice over the numbered items plus none.
    expect(jev.ask).toHaveBeenCalledTimes(1)
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(['e0', 'e1', 'k0', 'k1', 'v0', 'v1'])
    expect(Object.keys(calls[0]!.questions.e0.criteria)).toEqual(['e0', 'e1', 'none'])
    expect(Object.keys(calls[0]!.questions.k1.criteria)).toEqual(['fact', 'intent', 'draft', 'none'])
    expect(Object.keys(calls[0]!.questions.v0.criteria)).toEqual(['met', 'not_met', 'unclear'])
    expect(calls[0]!.state.clauses).toEqual(CLAUSES)
    expect(calls[0]!.state.task.title).toBe(card.title)
    expect(deps.fetchUrl).toHaveBeenCalledWith(OFFER, expect.objectContaining({ words: expect.arrayContaining(['october', 'switch']) }))
  })

  it('only a fact can be met, and only with a picked item', async () => {
    const path = write('s.jsonl', [claudeReply('Ready to go live, waiting on sign-off.', minute(5))])
    for (const [kind, picked, reason] of [['intent', 0, 'not_fact'], ['draft', 0, 'not_fact'], ['none', 0, 'not_fact'], ['fact', 'none', 'no_evidence']] as const) {
      const { jev } = fakeJev(() => [['met', kind, picked]])
      const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path } })
      const result = await c.check(req({ clauses: ['Facebook ads are running'] }), card)
      if (result.provider !== 'jev') throw new Error('no verdict')
      expect(result.clauses[0], `${kind}/${picked}`).toMatchObject({ verdict: 'unclear', reason, confidence: 0.04 })  // Jev's own probability of unclear
    }
    const { jev } = fakeJev(() => [['met', 'fact', 0]])
    const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path } })
    const ok = await c.check(req({ clauses: ['Facebook ads are running'] }), card)
    if (ok.provider !== 'jev') throw new Error('no verdict')
    expect(ok.clauses[0]).toMatchObject({ verdict: 'met', kind: 'fact', deterministic: false })
    expect(ok.clauses[0]!.reason).toBeUndefined()
  })

  it('a clause that names a page cannot be met unless that page\'s check passed, whatever Jev says', async () => {
    const path = write('s.jsonl', [claudeReply('The offer page is live.', minute(5))])
    const failures: Array<() => Promise<SafeFetchResult>> = [
      async () => ({ ...LIVE, status: 404 }), async () => ({ ...LIVE, finalUrl: 'https://bottlepos.com/' }), async () => ({ ...LIVE, markerFound: false }),
      async () => { throw new SafeFetchError('address_blocked') }, async () => { throw new SafeFetchError('timeout') },
    ]
    for (const fetchUrl of failures) {
      // Jev picks the session's "it is live" (a fact) or the failed check itself: neither may meet the clause.
      for (const pick of ['session', 'url'] as const) {
        const { jev } = fakeJev(state => [['met', 'fact', pick === 'url' ? urlIndex(state) : 0]])
        const { c } = checker({ jev: jev as any, fetchUrl, sessions: { [SESSION]: path } })
        const result = await c.check(req({ clauses: [CLAUSES[0]!] }), card)
        if (result.provider !== 'jev') throw new Error('no verdict')
        expect(result.clauses[0]).toMatchObject({ verdict: 'unclear', reason: 'url_not_passed', deterministic: false })
      }
    }
    // A pass is not sufficient on its own: Jev's not_met stands.
    const { jev } = fakeJev(state => [['not_met', 'fact', urlIndex(state)]])
    const { c } = checker({ jev: jev as any })
    const result = await c.check(req({ follows: [], clauses: [`${OFFER} gets 500 visits a day`] }), card)
    if (result.provider !== 'jev') throw new Error('no verdict')
    expect(result.clauses[0]).toMatchObject({ verdict: 'not_met' })
  })

  it('tells Jev the failed check honestly and never says why in a way that leaks the address', async () => {
    const { jev, calls } = fakeJev(() => [['unclear', 'none', 'none']])
    const { c } = checker({ jev: jev as any, fetchUrl: async () => { throw new SafeFetchError('address_blocked') } })
    await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)
    expect(calls[0]!.state.evidence).toEqual([expect.objectContaining({ source: 'url', text: expect.stringContaining('not checked: address_blocked') })])
    expect(calls[0]!.state.evidence[0].text).toContain('did NOT pass')
  })
})

describe('tag scoping', () => {
  const twoFollows = (a: string, b: string) => ({ sessions: { [SESSION]: a, [SESSION_B]: b } })
  const follows = [{ provider: 'claude' as const, sessionId: SESSION, cursor: null }, { provider: 'claude' as const, sessionId: SESSION_B, cursor: null }]

  it('canary 5: with several follows, an untagged "done" reply never counts', async () => {
    const a = write('a.jsonl', [claudeReply('All done, the page is live and ads are running.', minute(5))])
    const b = write('b.jsonl', [claudeReply(`COS-WORK ${OTHER}: done: shipped the other card`, minute(6))])
    const { jev } = fakeJev(() => [['met', 'fact', 0]])
    const { c } = checker({ jev: jev as any, ...twoFollows(a, b) })
    const result = await c.check(req({ follows, clauses: ['Facebook ads are running'] }), card)
    expect(result).toMatchObject({ provider: 'none', reason: 'no_evidence' })
    expect(jev.ask).not.toHaveBeenCalled()
  })

  it('with several follows, only this card\'s own status line counts, not the rest of the reply', async () => {
    const a = write('a.jsonl', [claudeReply(`COS-WORK ${CARD_ID}: done: Facebook ads went live at 3pm\n\nAlso unrelated chatter about pricing.`, minute(5))])
    const b = write('b.jsonl', [claudeReply('Untagged progress.', minute(6))])
    const { jev, calls } = fakeJev(() => [['met', 'fact', 0]])
    const { c } = checker({ jev: jev as any, ...twoFollows(a, b) })
    await c.check(req({ follows, clauses: ['Facebook ads are running'] }), card)
    expect(calls[0]!.state.evidence.map((e: any) => e.text)).toEqual([`COS-WORK ${CARD_ID}: done: Facebook ads went live at 3pm`])
  })

  it('with one follow, untagged replies count, a reply about other cards only does not, and a mixed reply keeps only this card\'s line', async () => {
    const path = write('one.jsonl', [
      claudeReply('Untagged: the ads are running now.', minute(5)),
      claudeReply(`COS-WORK ${OTHER}: done: the other card's ads are running`, minute(6)),
      claudeReply(`COS-WORK ${OTHER}: done: other\nCOS-WORK ${CARD_ID}: needs input: which audience?`, minute(7)),
    ])
    const { jev, calls } = fakeJev(() => [['unclear', 'none', 'none']])
    const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path } })
    await c.check(req({ clauses: ['Facebook ads are running'] }), card)
    expect(calls[0]!.state.evidence.map((e: any) => e.text)).toEqual(['Untagged: the ads are running now.', `COS-WORK ${CARD_ID}: needs input: which audience?`])
  })

  it('accepts the card\'s Work identity as its tag too', async () => {
    const path = write('one.jsonl', [claudeReply(`COS-WORK bbbbbbbbbbbb: done: ads live`, minute(5))])
    const { jev, calls } = fakeJev(() => [['met', 'fact', 0]])
    const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path, [SESSION_B]: path } })
    await c.check(req({ follows, clauses: ['Facebook ads are running'] }), { ...card, workIdentity: 'bbbbbbbbbbbb' })
    expect(calls[0]!.state.evidence).toHaveLength(2)
  })

  it('a Cursor follow without its handoff prompt offers only tagged lines', async () => {
    const path = write('c.jsonl', [cursorUser('Other work'), cursorReply('Done, all live.'), cursorReply(`COS-WORK ${CARD_ID}: done: ads are live`)])
    const { jev, calls } = fakeJev(() => [['met', 'fact', 0]])
    const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path } })
    await c.check(req({ follows: [{ provider: 'cursor', sessionId: SESSION, cursor: null }], clauses: ['Facebook ads are running'], since: '2000-01-01T00:00:00Z' }), card)
    expect(calls[0]!.state.evidence.map((e: any) => e.text)).toEqual([`COS-WORK ${CARD_ID}: done: ads are live`])
  })
})

describe('skipping when nothing is new', () => {
  it('asks Jev once, then repeats the verdicts with skipped and cached while nothing new arrives, cursor or not', async () => {
    const path = write('s.jsonl', [claudeReply('Ready to go live.', minute(5))])
    const { jev } = fakeJev(state => [['met', 'fact', urlIndex(state)], ['not_met', 'intent', 0]])
    const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path } })
    const first = await c.check(req(), card)
    if (first.provider !== 'jev') throw new Error('no verdict')
    const again = await c.check(req(), card)
    expect(again).toMatchObject({ provider: 'jev', skipped: 'no_new_evidence', cached: true, clauses: first.clauses })
    // The advanced cursor offers no session reply at all: still nothing new.
    const advanced = await c.check(req({ follows: [{ provider: 'claude', sessionId: SESSION, cursor: first.cursors[0]!.cursor }] }), card)
    expect(advanced).toMatchObject({ skipped: 'no_new_evidence', cached: true })
    expect(jev.ask).toHaveBeenCalledTimes(1)
    // A new reply is new evidence.
    appendFileSync(path, claudeReply('Jeremy signed off; the ads are running.', minute(9)) + '\n')
    const fresh = await c.check(req({ follows: [{ provider: 'claude', sessionId: SESSION, cursor: first.cursors[0]!.cursor }] }), card)
    expect(fresh).toMatchObject({ skipped: null, cached: false })
    expect(jev.ask).toHaveBeenCalledTimes(2)
    // Changed clauses are a new question.
    await c.check(req({ clauses: [CLAUSES[0]!] }), card)
    expect(jev.ask).toHaveBeenCalledTimes(3)
    // Another card is judged on its own.
    await c.check(req({ id: OTHER }), { ...card, id: OTHER })
    expect(jev.ask).toHaveBeenCalledTimes(4)
  })

  it('a changed page check is new evidence; the check\'s time is not', async () => {
    let now = Date.parse('2026-10-07T21:32:00Z'), status = 200
    const { jev } = fakeJev(state => [['met', 'fact', urlIndex(state)]])
    const { c } = checker({ jev: jev as any, now: () => now, fetchUrl: async () => ({ ...LIVE, status }) })
    await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)
    now += 3_600_000
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toMatchObject({ skipped: 'no_new_evidence' })
    status = 404
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toMatchObject({ skipped: null })
    expect(jev.ask).toHaveBeenCalledTimes(2)
    // The same evidence against reworded clauses is a new question, and so is the title path.
    expect(await c.check(req({ follows: [], clauses: [`${CLAUSES[0]!} and loads on a phone`] }), card)).toMatchObject({ skipped: null })
    expect(jev.ask).toHaveBeenCalledTimes(3)
    expect(await c.check(req({ follows: [], clauses: [`${CLAUSES[0]!} and loads on a phone`] }), card)).toMatchObject({ skipped: 'no_new_evidence' })
    expect(jev.ask).toHaveBeenCalledTimes(3)
  })

  it('a failed Jev call caches nothing', async () => {
    const jev = { ask: vi.fn().mockRejectedValueOnce(new (await import('./jev.js')).JevError('jev_unavailable')).mockResolvedValue({ answers: {
      v0: { probabilities: { met: 0.9, not_met: 0.1 } }, k0: { probabilities: { fact: 0.9 } }, e0: { probabilities: { e0: 0.9 } } }, inputTokens: 1 }) }
    const { c } = checker({ jev: jev as any })
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_unavailable' })
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toMatchObject({ provider: 'jev', skipped: null })
  })
})

describe('sources', () => {
  it('reads the linked meetings by identity, and the Slack sweep when it is available', async () => {
    const meeting = vi.fn(async (ref: { recordId: string }) => ({ recordId: ref.recordId, title: 'Pete sync', date: '2026-10-06', summary: 'Offer page approved.',
      decisions: ['Launch Monday'], actionItems: [{ task: 'Start the ads', owner: 'Graham' }] }))
    const slack = vi.fn(async () => ({ available: true, items: [
      { text: 'ready to go live, just need your sign off', user: 'Miles', channel: 'marketing', ts: '1728321120.000100', permalink: 'https://quilt.slack.com/archives/C1/p1' },
      { text: '', user: 'x' }, { nope: 1 }] }))
    const { jev, calls } = fakeJev(() => [['not_met', 'intent', 1]])
    const { c } = checker({ jev: jev as any, meeting, slack })
    const result = await c.check(req({ follows: [], clauses: ['Facebook ads are running'] }), card)
    expect(slack).toHaveBeenCalledWith({ domain: 'quilt', id: CARD_ID, since: '2026-10-02T23:52:00Z' })
    expect(result).toMatchObject({ sources: ['meeting', 'slack'] })
    expect(calls[0]!.state.evidence).toEqual([
      expect.objectContaining({ source: 'meeting', text: 'Pete sync (2026-10-06). Summary: Offer page approved. Decisions: Launch Monday Action items: Graham: Start the ads' }),
      expect.objectContaining({ source: 'slack', text: 'Miles in #marketing: ready to go live, just need your sign off', at: '2024-10-07T17:12:00.000Z' }),
    ])
    if (result.provider !== 'jev') throw new Error('no verdict')
    expect(result.clauses[0]!.evidence).toMatchObject({ source: 'slack', ref: 'https://quilt.slack.com/archives/C1/p1' })
    // A meeting whose identity changed is not this card's meeting.
    const moved = checker({ jev: fakeJev(() => [['unclear', 'none', 'none']]).jev as any, meeting: async () => ({ recordId: 'other', title: 'x', summary: 'y' }) })
    expect(await moved.c.check(req({ follows: [], clauses: ['Facebook ads are running'] }), card)).toEqual({ provider: 'none', reason: 'no_evidence', cursors: [], truncated: false })
  })

  it('an absent, failed or malformed Slack answer is no Slack evidence', async () => {
    for (const slack of [async () => ({ available: false }), async () => ({}), async () => ({ error: { code: 'cos_pipeline_not_configured' } }),
      async () => { throw new Error('timeout') }, async () => ({ available: true, items: 'x' }), async () => null,
      async () => ({ available: false, items: [{ text: 'ads are running', user: 'Miles', channel: 'x', ts: '1728321120' }] })]) {
      const { c } = checker({ jev: fakeJev(() => [['unclear', 'none', 'none']]).jev as any, slack })
      expect(await c.check(req({ follows: [], clauses: ['Facebook ads are running'] }), card)).toMatchObject({ provider: 'none', reason: 'no_evidence' })
    }
  })

  it('the default Slack source asks the COS bridge for slack-evidence, and a standalone install answers absent', async () => {
    const deps = defaultWorkEvidenceDeps()
    expect(await deps.slack({ domain: 'quilt', id: CARD_ID, since: '2026-10-02T23:52:00Z' })).not.toMatchObject({ available: true })
  })

  it('checks at most 6 URLs in one request', async () => {
    const fetchUrl = vi.fn(async (url: string) => ({ ...LIVE, finalUrl: url }))
    const { c } = checker({ jev: fakeJev(() => Array(2).fill(['unclear', 'none', 'none'])).jev as any, fetchUrl })
    const urls = Array.from({ length: 8 }, (_, i) => `https://bottlepos.com/p${i}`)
    await c.check(req({ follows: [], clauses: [urls.slice(0, 4).join(' '), urls.slice(4).join(' ')] }), card)
    expect(fetchUrl.mock.calls.map(c => c[0])).toEqual(urls.slice(0, 6))
  })

  it('a session that is not on this Mac keeps its cursor and says so', async () => {
    const { c } = checker({ jev: fakeJev(() => [['met', 'fact', 0]]).jev as any })
    const result = await c.check(req({ follows: [{ provider: 'claude', sessionId: SESSION, cursor: null }], clauses: [CLAUSES[0]!] }), card)
    expect(result).toMatchObject({ provider: 'jev', cursors: [{ provider: 'claude', sessionId: SESSION, cursor: null, missing: true }] })
  })

  it('a truncated read is reported', async () => {
    const path = claude300()
    const { c } = checker({ jev: fakeJev(() => [['unclear', 'none', 'none']]).jev as any, sessions: { [SESSION]: path }, windows: [2_048] })
    expect(await c.check(req({ clauses: ['Facebook ads are running'] }), card)).toMatchObject({ truncated: true })
  })

  it('offers at most 8 replies per follow and 10,000 characters, this card\'s lines and on-topic replies first', async () => {
    const lines = [claudeReply(`COS-WORK ${CARD_ID}: needs input: which audience for the ads?`, minute(1))]
    for (let i = 2; i < 40; i++) lines.push(claudeReply(i === 3 ? 'The Facebook campaign is drafted.' : `Unrelated reply ${i}.`, minute(i)))
    const path = write('busy.jsonl', lines)
    const { jev, calls } = fakeJev(() => [['unclear', 'none', 'none']])
    const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path } })
    const result = await c.check(req({ clauses: ['Facebook ads are running'] }), card)
    const texts = calls[0]!.state.evidence.map((e: any) => e.text)
    expect(texts).toHaveLength(EVIDENCE_LIMITS.sessionItemsPerFollow)
    expect(texts[0]).toContain(`COS-WORK ${CARD_ID}`)   // oldest first in the state, and kept despite its age
    expect(texts).toContain('The Facebook campaign is drafted.')
    expect(texts.at(-1)).toBe('Unrelated reply 39.')
    expect(result).toMatchObject({ sessionItemsOmitted: 31 })
    // This card's own line outranks any number of newer on-topic replies.
    const crowded = write('crowded.jsonl', [claudeReply(`COS-WORK ${CARD_ID}: done: the Facebook ads are live`, minute(1)),
      ...Array.from({ length: 12 }, (_, i) => claudeReply(`Facebook note ${i}.`, minute(i + 2)))])
    const ranked = fakeJev(() => [['unclear', 'none', 'none']])
    await checker({ jev: ranked.jev as any, sessions: { [SESSION]: crowded } }).c.check(req({ clauses: ['Facebook ads are running'] }), card)
    expect(ranked.calls[0]!.state.evidence[0].text).toContain(`COS-WORK ${CARD_ID}: done`)
    const big = write('big.jsonl', Array.from({ length: 8 }, (_, i) => claudeReply('Facebook ' + 'w'.repeat(3_000), minute(i))))
    const sized = fakeJev(() => [['unclear', 'none', 'none']])
    await checker({ jev: sized.jev as any, sessions: { [SESSION]: big } }).c.check(req({ clauses: ['Facebook ads are running'] }), card)
    const total = sized.calls[0]!.state.evidence.reduce((n: number, e: any) => n + e.text.length, 0)
    expect(total).toBeLessThanOrEqual(EVIDENCE_LIMITS.sessionChars)
  })
})

describe('redaction', () => {
  it('no credential in an excerpt reaches Jev or the answer', async () => {
    const secret = 'sk-ant-' + 'a1B2'.repeat(10), bearer = 'Bearer ' + 'z9'.repeat(12), slackToken = 'xoxb-' + '1234567890-abcdef'
    const path = write('s.jsonl', [claudeReply(`Set the key ${secret} and header ${bearer}; ads are running.`, minute(5))])
    const slack = async () => ({ available: true, items: [{ text: `token ${slackToken} posted`, user: 'Miles', channel: 'x', ts: '1728321120' }] })
    const meeting = async () => ({ recordId: 'rec-1', title: 'Pete sync', summary: `key ${secret}` })
    const { jev, calls } = fakeJev(() => [['met', 'fact', 0]])
    const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path }, slack, meeting })
    const result = await c.check(req({ clauses: ['Facebook ads are running'] }), card)
    const sent = JSON.stringify(calls[0]), answered = JSON.stringify(result)
    for (const s of [secret, 'z9z9z9z9z9z9z9z9', slackToken]) { expect(sent).not.toContain(s); expect(answered).not.toContain(s) }
    expect(sent).toContain('ads are running')
  })
})

describe('the title path, switch and failures', () => {
  it('with no clauses, judges the card text and names the clause by the card title', async () => {
    const { jev, calls } = fakeJev(() => [['unclear', 'none', 'none']])
    const { c } = checker({ jev: jev as any, slack: async () => ({ available: true, items: [{ text: 'Offer launched', user: 'Miles', channel: 'x', ts: '1728321120' }] }) })
    const result = await c.check(req({ follows: [], clauses: [] }), card)
    expect(result).toMatchObject({ provider: 'jev', basis: 'title', clauses: [{ text: card.title, verdict: 'unclear' }] })
    expect(calls[0]!.state.clauses).toEqual([card.text])
  })

  it('the master switch answers evidence_disabled and reads nothing', async () => {
    const findSession = vi.fn(), fetchUrl = vi.fn(), slack = vi.fn()
    const { c } = checker({ enabled: () => false, findSession, fetchUrl, slack })
    expect(c.enabled()).toBe(false)
    expect(await c.check(req(), card)).toEqual({ provider: 'none', reason: 'evidence_disabled' })
    expect(findSession).not.toHaveBeenCalled(); expect(fetchUrl).not.toHaveBeenCalled(); expect(slack).not.toHaveBeenCalled()
    for (const off of ['0', 'false', 'no', 'off', ' OFF ']) expect(workEvidenceEnabled({ COS_WORK_EVIDENCE: off } as NodeJS.ProcessEnv), off).toBe(false)
    for (const on of [undefined, '', '1', 'true', 'yes']) expect(workEvidenceEnabled({ COS_WORK_EVIDENCE: on } as NodeJS.ProcessEnv), String(on)).toBe(true)
  })

  it('a card with no text has nothing to judge', async () => {
    const { c } = checker()
    expect(await c.check(req(), { ...card, title: '', text: '  ' })).toEqual({ provider: 'none', reason: 'no_task_text' })
  })

  it('an answer outside the offered options is jev_bad_answer, and caches nothing', async () => {
    const jev = { ask: vi.fn(async () => ({ answers: { v0: { probabilities: { met: 0.9 } }, k0: { probabilities: { fact: 0.9 } }, e0: { probabilities: { e7: 0.9 } } }, inputTokens: 1 })) }
    const { c } = checker({ jev: jev as any })
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_bad_answer' })
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_bad_answer' })
    expect(jev.ask).toHaveBeenCalledTimes(2)
  })
})

describe('cost controls', () => {
  const KEY = 'ts_live_' + 'k'.repeat(32)
  beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', KEY); if (existsSync(JEV_KEY_FILE)) unlinkSync(JEV_KEY_FILE) })
  const okFetch = vi.fn(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 5_000 }, answers: {
    v0: { probabilities: { met: 0.9, not_met: 0.1 } }, k0: { probabilities: { fact: 0.9 } }, e0: { probabilities: { e0: 0.9 } } } }), { status: 200 }))

  it('has its own ledger file and its own cap, 300,000 by default, checked before sending', async () => {
    expect(WORK_EVIDENCE_USAGE_FILE).not.toBe(JEV_USAGE_FILE)
    expect(WORK_EVIDENCE_USAGE_FILE.endsWith('jev-work-evidence-usage.json')).toBe(true)
    expect(workEvidenceDailyCap({} as NodeJS.ProcessEnv)).toBe(300_000)
    expect(workEvidenceDailyCap({ COS_WORK_EVIDENCE_DAILY_TOKENS: '9000' } as NodeJS.ProcessEnv)).toBe(9_000)
    expect(workEvidenceDailyCap({ COS_WORK_EVIDENCE_DAILY_TOKENS: 'lots' } as NodeJS.ProcessEnv)).toBe(300_000)
    const usage = join(dir, 'jev-work-evidence-usage.json')
    const client = createWorkEvidenceJevClient(okFetch as any, () => new Date('2026-10-07T12:00:00Z'), usage)
    expect(client.status().dailyCap).toBe(300_000)
    const { c } = checker({ jev: client })
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toMatchObject({ provider: 'jev' })
    expect(JSON.parse(readFileSync(usage, 'utf8'))).toEqual({ '2026-10-07': 5_000 })
    // A small cap stops the next call before it is sent, and says jev_cap.
    vi.stubEnv('COS_WORK_EVIDENCE_DAILY_TOKENS', '5100')
    okFetch.mockClear()
    const capped = checker({ jev: client })
    expect(await capped.c.check(req({ follows: [], clauses: ['Facebook ads are running', CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_cap' })
    expect(okFetch).not.toHaveBeenCalled()
  })

  it('opens its own breaker after three failures and says jev_breaker', async () => {
    const down = vi.fn(async () => new Response('no', { status: 503 }))
    const client = createWorkEvidenceJevClient(down as any, () => new Date('2026-10-07T12:00:00Z'), join(dir, 'u.json'))
    for (let i = 0; i < 3; i++) {
      const { c } = checker({ jev: client })
      expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_unavailable' })
    }
    const { c } = checker({ jev: client })
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_breaker' })
    expect(down).toHaveBeenCalledTimes(3)
    // The shared Jev client is a different object with a different ledger.
    expect(client).not.toBe(new JevClient())
  })
})
