import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JEV_KEY_FILE, JEV_USAGE_FILE, JevClient, JevError } from './jev.js'
import { LATEST_REPLY_MAX } from './agent-session-store.js'
import { SESSION_TURNS_MAX } from './agent-session-turns.js'
import { SafeFetchError, type SafeFetchResult } from './safe-fetch.js'
import {
  EVIDENCE_LIMITS, EVIDENCE_REFUSALS, EVIDENCE_REQUEST_LIMITS, WORK_EVIDENCE_USAGE_FILE, WorkEvidenceChecker, clauseUrls, createWorkEvidenceJevClient, decodeCursor, defaultWorkEvidenceDeps,
  distinctiveWords, encodeCursor, markersFor, parseEvidenceRequest, readSessionSince, sameUrl, statusLines, workEvidenceAvailable, workEvidenceDailyCap, workEvidenceEnabled,
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
      evidence: { source: 'url', ref: OFFER, excerpt: '200 · Switch to Bottle POS: $3,000 + Free Hardware', at: '2026-10-07T21:32:00.000Z' },
      supporting: [{ source: 'url', ref: OFFER, at: '2026-10-07T21:32:00.000Z' }] })
    expect(result.clauses[1]).toMatchObject({ text: CLAUSES[1], verdict: 'not_met', kind: 'intent', deterministic: false, evidence: { source: 'session' }, supporting: [] })
    expect(result.cursors).toEqual([{ provider: 'claude', sessionId: SESSION, cursor: expect.any(String) }])
    // One Jev call, four choices per clause; the evidence and support choices are over the numbered items plus none.
    expect(jev.ask).toHaveBeenCalledTimes(1)
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(['e0', 'e1', 'k0', 'k1', 's0', 's1', 'v0', 'v1'])
    expect(Object.keys(calls[0]!.questions.e0.criteria)).toEqual(['e0', 'e1', 'none'])
    expect(Object.keys(calls[0]!.questions.s1.criteria)).toEqual(['e0', 'e1', 'none'])
    expect(calls[0]!.questions.s1.instructions).toContain('clauses[1]')
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
    expect(await capped.c.check(req({ follows: [], clauses: ['Facebook ads are running', CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_cap', retryAt: '2026-10-08T00:00:00.000Z' })
    expect(okFetch).not.toHaveBeenCalled()
    // A spent day is refused before anything is read.
    vi.stubEnv('COS_WORK_EVIDENCE_DAILY_TOKENS', '5000')
    const fetchUrl = vi.fn(async () => LIVE), slack = vi.fn(async () => ({ available: false })), findSession = vi.fn(async () => null)
    const spent = checker({ jev: client, fetchUrl, slack, findSession })
    expect(await spent.c.check(req(), card)).toEqual({ provider: 'none', reason: 'jev_cap', retryAt: '2026-10-08T00:00:00.000Z' })
    expect(fetchUrl).not.toHaveBeenCalled(); expect(slack).not.toHaveBeenCalled(); expect(findSession).not.toHaveBeenCalled()
  })

  it('opens its own breaker after three failures and says jev_breaker', async () => {
    const down = vi.fn(async () => new Response('no', { status: 503 }))
    const client = createWorkEvidenceJevClient(down as any, () => new Date('2026-10-07T12:00:00Z'), join(dir, 'u.json'))
    for (let i = 0; i < 3; i++) {
      const { c } = checker({ jev: client })
      expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_unavailable' })
    }
    const fetchUrl = vi.fn(async () => LIVE), slack = vi.fn(async () => ({ available: false }))
    const { c } = checker({ jev: client, fetchUrl, slack })
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_breaker', retryAt: '2026-10-07T13:00:00.000Z' })
    expect(down).toHaveBeenCalledTimes(3)
    // An open breaker is refused before the page check or the Slack read.
    expect(fetchUrl).not.toHaveBeenCalled(); expect(slack).not.toHaveBeenCalled()
    // The shared Jev client is a different object with a different ledger.
    expect(client).not.toBe(new JevClient())
  })
})

// --- QA round (2026-10-07): limits, capability, refusals, gap walking, supporting items ------------------------------
describe('limits (one module; COS Control must match these)', () => {
  it('pins the request limits, the UTF-16 unit, the cursor bound and the 4 KB cursor prefix', () => {
    expect(EVIDENCE_REQUEST_LIMITS).toEqual({ follows: 4, clauses: 6, clauseChars: 300, clauseUnit: 'utf16', cursorChars: 512, supporting: 4 })
    expect(Object.isFrozen(EVIDENCE_REQUEST_LIMITS)).toBe(true)
    expect(EVIDENCE_LIMITS).toMatchObject({ follows: 4, clauses: 6, clauseChars: 300, cursorChars: 512, supporting: 4, prefixBytes: 4096 })
  })
  it('counts a clause in UTF-16 units: 150 emoji fit, 150 emoji and a letter do not', () => {
    const body = { domain: 'quilt', id: CARD_ID, follows: [], since: '2026-10-02T23:52:00Z' }
    expect('😀'.repeat(150).length).toBe(300)
    expect(parseEvidenceRequest({ ...body, clauses: ['😀'.repeat(150)] })).not.toBeNull()
    expect(parseEvidenceRequest({ ...body, clauses: ['😀'.repeat(150) + 'a'] })).toBeNull()
    expect(parseEvidenceRequest({ ...body, clauses: ['é'.repeat(300)] })).not.toBeNull()  // 300 BMP characters are 300 units
  })
  it('the widest cursor the format can produce is far inside cursorChars, and a bad anchor flag is refused', () => {
    const widest = encodeCursor({ v: 1, id: 'f'.repeat(12), o: Number.MAX_SAFE_INTEGER, t: new Date(8.64e15).toISOString(), p: 'f'.repeat(16), a: 1 })
    expect(widest.length).toBeLessThan(200)
    expect(decodeCursor(widest)).toMatchObject({ a: 1 })
    expect(decodeCursor(encodeCursor({ v: 1, id: 'x', o: 1, t: null, p: '', a: 2 } as any))).toBeNull()
  })
  it('the npm package leaves out every mutation gate, this one included', () => {
    const root = join(import.meta.dirname, '..', '..')
    const files: string[] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files
    const gates = readdirSync(join(root, 'server', 'scripts')).filter(f => f.endsWith('-mutation-gate.mjs') || f === 'mutation-gate.mjs')
    expect(gates).toContain('work-evidence-mutation-gate.mjs')
    for (const gate of gates) expect(files, gate).toContain(`!server/scripts/${gate}`)
  })
})

describe('capability and refusals', () => {
  it('advertises the check only when the switch is on and a key resolves', () => {
    expect(workEvidenceAvailable({} as NodeJS.ProcessEnv, () => true)).toBe(true)
    expect(workEvidenceAvailable({} as NodeJS.ProcessEnv, () => false)).toBe(false)
    expect(workEvidenceAvailable({ COS_WORK_EVIDENCE: '0' } as NodeJS.ProcessEnv, () => true)).toBe(false)
    expect(EVIDENCE_REFUSALS).toEqual({ disabled: 'evidence_disabled', notConfigured: 'jev_not_configured', cap: 'jev_cap', breaker: 'jev_breaker' })
  })
  it('with no key, refuses before reading any source', async () => {
    const findSession = vi.fn(async () => null), fetchUrl = vi.fn(async () => LIVE), slack = vi.fn(async () => ({ available: false }))
    const ask = vi.fn()
    const status = () => ({ configured: false, source: 'none' as const, usedToday: 0, dailyCap: 300_000, breakerOpenUntil: null, lastError: null })
    const { c } = checker({ jev: { ask, status } as any, findSession, fetchUrl, slack })
    expect(await c.check(req(), card)).toEqual({ provider: 'none', reason: 'jev_not_configured' })
    expect(findSession).not.toHaveBeenCalled(); expect(fetchUrl).not.toHaveBeenCalled(); expect(slack).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled()
  })
  it('a breaker that opens during the call says when to ask again', async () => {
    const ok = { configured: true, source: 'env' as const, usedToday: 0, dailyCap: 300_000, breakerOpenUntil: null, lastError: null }
    const status = vi.fn().mockReturnValueOnce(ok).mockReturnValue({ ...ok, breakerOpenUntil: '2026-10-07T22:32:00.000Z' })
    const ask = vi.fn(async () => { throw new JevError('jev_breaker_open') })
    const { c } = checker({ jev: { ask, status } as any })
    expect(await c.check(req({ follows: [], clauses: [CLAUSES[0]!] }), card)).toEqual({ provider: 'none', reason: 'jev_breaker', retryAt: '2026-10-07T22:32:00.000Z' })
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe('truncated reads walk forward through the gap', () => {
  const small = [2_048, 8_192]
  /** Every read until one is not truncated; each truncated cursor must point inside the file, never at its end. */
  async function walk(provider: 'claude' | 'cursor', path: string, cursor: string | null, sinceMs: number) {
    const size = statSync(path).size, reads = []
    for (let i = 0; i < 400; i++) {
      const read = await readSessionSince(provider, SESSION, path, cursor, sinceMs, TAGS, small)
      reads.push(read)
      if (read.truncated) expect(decodeCursor(read.cursor)!.o, `read ${i}`).toBeLessThan(size)
      if (read.truncated) expect(decodeCursor(read.cursor)!.o, `read ${i} moved`).toBeGreaterThan(cursor ? decodeCursor(cursor)!.o : -1)
      cursor = read.cursor
      if (!read.truncated) return reads
    }
    throw new Error('the walk never finished')
  }

  it('from a cursor far behind: every reply exactly once, in order, over several checks', async () => {
    const path = claude300()
    const start = await readSessionSince('claude', SESSION, write('tiny.jsonl', [claudeReply('only', minute(1))]), null, 0, TAGS)
    const behind = encodeCursor({ ...decodeCursor(start.cursor)!, o: 0, p: '' })
    const reads = await walk('claude', path, behind, 0)
    expect(reads.length).toBeGreaterThan(2)
    expect(reads.flatMap(r => r.replies.map(x => x.text))).toEqual(Array.from({ length: 300 }, (_, i) => `Reply number ${i + 1}.`))
    expect(decodeCursor(reads.at(-1)!.cursor)!.o).toBe(statSync(path).size)
  })

  it('from `since` older than the largest window: starts at `since` (found by bisection), not at the newest window', async () => {
    const path = claude300()
    const reads = await walk('claude', path, null, Date.parse(minute(100)))
    expect(reads[0]!.truncated).toBe(true)
    expect(reads[0]!.replies[0]!.text).toBe('Reply number 100.')
    expect(reads.flatMap(r => r.replies.map(x => x.text))).toEqual(Array.from({ length: 201 }, (_, i) => `Reply number ${i + 100}.`))
  })

  it('a stale cursor with a time older than the largest window resumes after that time', async () => {
    const path = claude300()
    const stale = encodeCursor({ v: 1, id: decodeCursor((await readSessionSince('claude', SESSION, path, null, 0, TAGS)).cursor)!.id, o: 10, t: minute(200), p: 'nope' })
    const reads = await walk('claude', path, stale, 0)
    expect(reads.flatMap(r => r.replies.map(x => x.text))).toEqual(Array.from({ length: 100 }, (_, i) => `Reply number ${i + 201}.`))
  })

  it('a Cursor transcript whose handoff is older than the newest window: walks from the top, counting only after the handoff', async () => {
    const filler = Array.from({ length: 60 }, (_, i) => cursorReply(`Before the handoff ${i}. ` + 'x'.repeat(150)))
    const after = Array.from({ length: 80 }, (_, i) => cursorReply(`After ${i}. ` + 'y'.repeat(150)))
    const path = write('cursor-big.jsonl', [...filler, cursorUser(`Do the card.\nCOS-WORK ${CARD_ID}: <done, needs input or blocked>: <x>`), ...after])
    const reads = await walk('cursor', path, null, 0)
    // The first read is still before the handoff: nothing untagged counts, and the cursor says the anchor is pending.
    expect(reads[0]).toMatchObject({ anchored: false, truncated: true })
    expect(decodeCursor(reads[0]!.cursor)!.a).toBe(1)
    const anchoredAt = reads.findIndex(r => r.anchored && r.replies.some(x => x.text.startsWith('After')))
    expect(anchoredAt).toBeGreaterThan(0)
    expect(reads.slice(anchoredAt).flatMap(r => r.replies.map(x => x.text.split('.')[0]))).toEqual(Array.from({ length: 80 }, (_, i) => `After ${i}`))
    // Once the handoff is read, the flag is gone.
    expect(decodeCursor(reads.at(-1)!.cursor)!.a).toBeUndefined()
  })

  it('a line longer than the window is stepped over, and the walk still reaches what follows it', async () => {
    const path = write('giant.jsonl', [claudeReply('First.', minute(1)), claudeReply('G'.repeat(20_000), minute(2)), claudeReply('After the giant.', minute(3))])
    const start = await readSessionSince('claude', SESSION, write('tiny.jsonl', [claudeReply('only', minute(1))]), null, 0, TAGS)
    const reads = await walk('claude', path, encodeCursor({ ...decodeCursor(start.cursor)!, o: 0, p: '' }), 0)
    expect(reads.flatMap(r => r.replies.map(x => x.text))).toEqual(['First.', 'After the giant.'])
  })

  it('the cursor fits only while the 4 KB before it are unchanged', async () => {
    const path = write('prefix.jsonl', Array.from({ length: 10 }, (_, i) => claudeReply(`Old ${i + 1}.`, minute(i + 1))))
    const first = await readSessionSince('claude', SESSION, path, null, 0, TAGS)
    const bytes = readFileSync(path, 'utf8')
    const at = bytes.indexOf('Old 5.')
    expect(bytes.length - at).toBeGreaterThan(64)
    expect(bytes.length - at).toBeLessThan(4096)
    // Same length: reply 5 reworded and re-timed after the cursor's time. Only a check of more than 64 bytes sees it.
    writeFileSync(path, bytes.replace('Old 5.', 'New 5.').replace(minute(5), minute(20)))
    expect(readFileSync(path).length).toBe(Buffer.byteLength(bytes))
    expect((await readSessionSince('claude', SESSION, path, first.cursor, 0, TAGS)).replies.map(r => r.text)).toEqual(['New 5.'])
  })

  it('the checker passes the gap cursor back, so the next check continues inside it', async () => {
    const path = claude300()
    const { c } = checker({ jev: fakeJev(() => [['unclear', 'none', 'none']]).jev as any, sessions: { [SESSION]: path }, windows: small })
    const result = await c.check(req({ clauses: ['Facebook ads are running'], since: minute(100) }), card)
    expect(result).toMatchObject({ provider: 'jev', truncated: true })
    if (result.provider !== 'jev') throw new Error('no verdict')
    expect(decodeCursor(result.cursors[0]!.cursor)!.o).toBeLessThan(statSync(path).size)
  })
})

describe('supporting items and evidence times', () => {
  /** Jev answers clause 0 with [verdict, kind, picked] and the support distribution given (item index to probability). */
  function supportJev(v: string, k: string, e: number | 'none', support: (state: any) => Record<string, number>) {
    return { ask: vi.fn(async (state: any) => ({ model: 'jev-1.13.0', inputTokens: 1, answers: {
      v0: { probabilities: { met: v === 'met' ? 0.92 : 0.04, not_met: v === 'not_met' ? 0.9 : 0.03, unclear: v === 'unclear' ? 0.9 : 0.04 } },
      k0: { probabilities: { [k]: 0.9 } }, e0: { probabilities: { [e === 'none' ? 'none' : `e${e}`]: 0.9 } }, s0: { probabilities: support(state) } } })) }
  }
  const sources = (meeting: boolean) => ({
    meeting: async () => meeting ? { recordId: 'rec-1', title: 'Pete sync', date: '2026-10-06', summary: 'The ads went live Monday.' } : null,
    slack: async () => ({ available: true, items: [{ text: 'ads are live', user: 'Miles', channel: 'mkt', ts: '1791331200', permalink: 'https://quilt.slack.com/archives/C1/p2' }] }),
  })
  const idx = (state: any, source: string) => state.evidence.findIndex((e: any) => e.source === source)

  it('a met clause lists the picked item first, then each item Jev names above the floor; never a failed page check', async () => {
    const path = write('s.jsonl', [claudeReply(`COS-WORK ${CARD_ID}: done: the Facebook ads are live`, minute(5))])
    const jev = supportJev('met', 'fact', 0, state => ({ [`e${idx(state, 'slack')}`]: 0.4, [`e${idx(state, 'meeting')}`]: 0.3, [`e${idx(state, 'url')}`]: 0.2, e0: 0.05, none: 0.05 }))
    const { c } = checker({ jev: jev as any, sessions: { [SESSION]: path }, fetchUrl: async () => ({ ...LIVE, status: 404 }), ...sources(true) })
    const result = await c.check(req({ clauses: [`Facebook ads are running and ${OFFER} still answers`] }), card)
    if (result.provider !== 'jev') throw new Error('no verdict')
    // url_not_passed: the clause names a page whose check failed, so it is not met and supports nothing.
    expect(result.clauses[0]).toMatchObject({ verdict: 'unclear', reason: 'url_not_passed', supporting: [] })
    // No page in the clause: the picked session line first, then Slack (0.4), then the meeting (0.3); e0 again is not repeated.
    const met = checker({ jev: supportJev('met', 'fact', 0, state => ({ [`e${idx(state, 'slack')}`]: 0.4, [`e${idx(state, 'meeting')}`]: 0.3, e0: 0.2, none: 0.1 })) as any,
      sessions: { [SESSION]: path }, ...sources(true) })
    const ok = await met.c.check(req({ clauses: ['Facebook ads are running'] }), card)
    if (ok.provider !== 'jev') throw new Error('no verdict')
    expect(ok.clauses[0]!.verdict).toBe('met')
    expect(ok.clauses[0]!.supporting).toEqual([
      { source: 'session', ref: `claude:${SESSION}`, at: minute(5) },
      { source: 'slack', ref: 'https://quilt.slack.com/archives/C1/p2', at: '2026-10-07T00:00:00.000Z' },
      { source: 'meeting', ref: 'meeting:quilt/2026-10/pete.md', at: '2026-10-06T00:00:00.000Z' },
    ])
  })

  it('supporting names each item once, at most 4, skips answers below the floor, and is empty unless met', async () => {
    const lines = Array.from({ length: 7 }, (_, i) => claudeReply(`Ads report ${i}: the Facebook ads are running.`, minute(i + 1)))
    const path = write('many.jsonl', lines)
    const many = (state: any) => Object.fromEntries(state.evidence.map((e: any, i: number) => [`e${e.n}`, i === 6 ? 0.1 : 0.15]))
    const { c } = checker({ jev: supportJev('met', 'fact', 2, many) as any, sessions: { [SESSION]: path } })
    const result = await c.check(req({ clauses: ['Facebook ads are running'] }), card)
    if (result.provider !== 'jev') throw new Error('no verdict')
    const s0 = result.clauses[0]!.supporting
    expect(s0).toHaveLength(4)
    expect(s0[0]).toEqual({ source: 'session', ref: `claude:${SESSION}`, at: minute(3) })   // the picked item, once
    expect(new Set(s0.map(x => x.at)).size).toBe(4)
    expect(s0.map(x => x.at)).not.toContain(minute(7))   // p 0.10 is under the 0.15 floor
    // Two items, one below the floor: only the picked one and the one above it.
    const few = checker({ jev: supportJev('met', 'fact', 0, () => ({ e1: 0.5, e2: 0.14 })) as any, sessions: { [SESSION]: path } })
    const r2 = await few.c.check(req({ clauses: ['Facebook ads are running'] }), card)
    if (r2.provider !== 'jev') throw new Error('no verdict')
    expect(r2.clauses[0]!.supporting.map(x => x.at)).toEqual([minute(1), minute(2)])
    for (const [v, k] of [['not_met', 'intent'], ['unclear', 'none'], ['met', 'draft']] as const) {
      const other = checker({ jev: supportJev(v, k, 0, () => ({ e1: 0.9 })) as any, sessions: { [SESSION]: path } })
      const r = await other.c.check(req({ clauses: ['Facebook ads are running'] }), card)
      if (r.provider !== 'jev') throw new Error('no verdict')
      expect(r.clauses[0]!.supporting, `${v}/${k}`).toEqual([])
    }
  })

  it('a met page check supports, a failed one never does even when Jev names it', async () => {
    const path = write('s.jsonl', [claudeReply('The offer page is live.', minute(5))])
    // Two pages: the clause names one that passes; the other (failing) page is named in another clause.
    const fetchUrl = async (url: string) => url === OFFER ? LIVE : { ...LIVE, finalUrl: url, status: 500 }
    const { c } = checker({ jev: { ask: vi.fn(async (state: any) => {
      const pass = state.evidence.findIndex((e: any) => e.source === 'url' && e.text.includes(OFFER)), fail = state.evidence.findIndex((e: any) => e.source === 'url' && e.text.includes('/pricing'))
      return { inputTokens: 1, model: 'jev', answers: {
        v0: { probabilities: { met: 0.9, not_met: 0.05, unclear: 0.05 } }, k0: { probabilities: { fact: 0.9 } }, e0: { probabilities: { e0: 0.9 } },
        s0: { probabilities: { [`e${pass}`]: 0.4, [`e${fail}`]: 0.4 } },
        v1: { probabilities: { met: 0.1, not_met: 0.8, unclear: 0.1 } }, k1: { probabilities: { none: 0.9 } }, e1: { probabilities: { none: 0.9 } } } }
    }) } as any, fetchUrl, sessions: { [SESSION]: path } })
    const result = await c.check(req({ clauses: [`${OFFER} page is live`, 'https://bottlepos.com/pricing shows the offer'] }), card)
    if (result.provider !== 'jev') throw new Error(JSON.stringify(result))
    expect(result.clauses[0]!.verdict).toBe('met')
    expect(result.clauses[0]!.supporting.map(x => `${x.source} ${x.ref}`)).toEqual([`session claude:${SESSION}`, `url ${OFFER}`])
  })

  it('evidence with no time of its own carries the time of the check that judged it, and a replay keeps it', async () => {
    const path = write('c.jsonl', [cursorUser(`Do the card.\nCOS-WORK ${CARD_ID}: <done, needs input or blocked>: <x>`), cursorReply('The Facebook ads are running now.')])
    let now = Date.parse('2026-10-07T21:32:00Z')
    const { c } = checker({ jev: supportJev('met', 'fact', 0, () => ({ e0: 0.9 })) as any, sessions: { [SESSION]: path }, now: () => now })
    const follows = [{ provider: 'cursor' as const, sessionId: SESSION, cursor: null }]
    const first = await c.check(req({ follows, clauses: ['Facebook ads are running'], since: '2000-01-01T00:00:00Z' }), card)
    if (first.provider !== 'jev') throw new Error('no verdict')
    expect(first.clauses[0]!.evidence!.at).toBe('2026-10-07T21:32:00.000Z')
    expect(first.clauses[0]!.supporting).toEqual([{ source: 'session', ref: `cursor:${SESSION}`, at: '2026-10-07T21:32:00.000Z' }])
    now += 3_600_000
    const again = await c.check(req({ follows, clauses: ['Facebook ads are running'], since: '2000-01-01T00:00:00Z' }), card)
    expect(again).toMatchObject({ skipped: 'no_new_evidence' })
    if (again.provider !== 'jev') throw new Error('no verdict')
    expect(again.clauses[0]!.evidence!.at).toBe('2026-10-07T21:32:00.000Z')
  })

  it('a support answer outside the offered options is jev_bad_answer; an absent one means only the picked item', async () => {
    const path = write('s.jsonl', [claudeReply('The Facebook ads are running.', minute(5))])
    const bad = checker({ jev: supportJev('met', 'fact', 0, () => ({ e9: 0.9 })) as any, sessions: { [SESSION]: path } })
    expect(await bad.c.check(req({ clauses: ['Facebook ads are running'] }), card)).toEqual({ provider: 'none', reason: 'jev_bad_answer' })
    const { jev } = fakeJev(() => [['met', 'fact', 0]])
    const absent = checker({ jev: jev as any, sessions: { [SESSION]: path } })
    const r = await absent.c.check(req({ clauses: ['Facebook ads are running'] }), card)
    if (r.provider !== 'jev') throw new Error('no verdict')
    expect(r.clauses[0]!.supporting).toEqual([{ source: 'session', ref: `claude:${SESSION}`, at: minute(5) }])
  })
})
