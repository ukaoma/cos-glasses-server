import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeetingAskRuntime, meetingAskCapabilities } from './meeting-ask-runtime.js'
import { MeetingAskStore } from './meeting-ask-store.js'
import { FACT_CHECK_PLANNER_SYSTEM, FACT_CHECK_SYSTEM, MEDICAL_DOSING_ANSWER } from './meeting-fact-check.js'
import { PUBLIC_TOPIC_SYSTEM } from './meeting-public-topic.js'
import { MEETING_FACT_CHECK_QUESTION } from '../../shared/meeting-ask.js'

// Synthetic meeting only.
const turns = [
  { id: 1, elapsedMs: 70_000, speaker: 'MU', text: 'If I were to say that elephants often grow to be over the weight of a car' },
  { id: 2, elapsedMs: 100_000, speaker: 'Ext', text: 'The average human heart beats about a billion times in a lifetime.' },
  { id: 3, elapsedMs: 600_000, speaker: 'MU', text: 'How is it that flying from here to Kansas City' },
  { id: 4, elapsedMs: 606_000, speaker: 'MU', text: 'is only 90 minutes to 2 hours versus driving is like 10 hours?' },
]
const page = (url: string, text: string) => ({ id: 'W1', kind: 'web' as const, title: 'Page', url, text: 'Retrieved page excerpt (may be partial): ' + text + ' '.repeat(220), retrievedAt: new Date().toISOString(), retrievalId: 'ret-' + url })
let n = 0
const submit = (question: string, elapsedMs: number) => ({ requestId: `request_fc_${++n}_abcdef`, sessionId: 'meeting_fc', serverInstanceId: 'server-one', action: 'ask' as const, question, elapsedMs, turns: turns.filter(t => t.elapsedMs <= elapsedMs) })
function fixture(plans: Record<string, unknown>, compose: (prompt: any) => unknown, overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fc-runtime-')), store = new MeetingAskStore(dir)
  store.setPublicTopics(true)
  const run = vi.fn(async (_m: unknown, prompt: string, system: string) => {
    if (system === FACT_CHECK_PLANNER_SYSTEM) return { text: JSON.stringify(plans[JSON.parse(prompt).mode] ?? { claims: [] }), model: 'claude-sonnet' }
    if (system === FACT_CHECK_SYSTEM) return { text: JSON.stringify(compose(JSON.parse(prompt))), model: 'claude-sonnet' }
    if (system === PUBLIC_TOPIC_SYSTEM) return { text: '{"publicTopic":false}', model: 'claude-sonnet' }
    return { text: JSON.stringify({ sections: [{ label: 'So what', text: 'Plain answer [T1]' }], confidence: { level: 'limited', reason: 'Only the transcript.' } }), model: 'claude-sonnet' }
  })
  const webSearch = vi.fn(async (query: string) => ({ sources: [page('https://example.org/' + query.split(' ')[0], `Reference page about ${query}. Nonstop flights take about 1 hour 50 minutes; elephants weigh about 6 tonnes; hearts beat about 3 billion times.`)], notices: [] as string[] }))
  const runtime = new MeetingAskRuntime({ reviewAnswers: false, finalized: () => ({ sources: [], notices: [] }), domains: () => [], store, identity: () => 'server-one', admissions: () => true, lease: () => ({ release() {}, id: 'lease', kind: 'meeting_ask' } as any), catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'sonnet', models: ['sonnet'] }], run, search: async () => ({ sources: [], notices: [] }), webSearch, webCapability: () => ({ available: true, engine: 'claude' }), ownerArea: () => ({ text: 'Austin, TX', source: 'profile' as const }), wearer: () => 'Pat Example', ...overrides } as any)
  return { runtime, store, run, webSearch, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
async function done(f: ReturnType<typeof fixture>, id: string) {
  for (let i = 0; i < 200; i++) { const e = f.runtime.get(id); if (!['pending', 'running'].includes(e.status)) return e; await new Promise(r => setTimeout(r, 2)) }
  throw Error('never terminal')
}
const scopePlan = { claims: [
  { claim: 'Elephants often weigh more than a car', query: 'elephant weight vs car weight', evidenceTurnIds: [1], category: 'nature' },
  { claim: 'Average heart beats about a billion times in a lifetime', query: 'average human heart beats lifetime', evidenceTurnIds: [2], category: 'science' },
] }
const rowsFor = (p: any) => ({ sections: p.claims.map((c: any) => ({ label: p.rowLabel, text: `${c.claim} [${c.saidIn[0]}]: Supported. A read page agrees [${c.webSourceIds[0]}].` })), confidence: { level: 'supported', reason: 'Read pages state the figures.' }, support: p.claims.map((c: any) => ({ id: c.webSourceIds[0], quote: 'Reference page about' })) })
afterEach(() => { delete process.env.COS_MEETING_FACT_CHECK_SCOPE })

describe('6.71.13 Fact check through the durable runtime', () => {
  it('advertises factCheckScope unless the kill switch is set', async () => {
    const f = fixture({}, rowsFor)
    try {
      expect((await f.runtime.config()).capabilities.factCheckScope).toBe(1)
      expect(meetingAskCapabilities().factCheckScope).toBe(1)
      process.env.COS_MEETING_FACT_CHECK_SCOPE = '0'
      expect((await f.runtime.config()).capabilities.factCheckScope).toBeUndefined()
    } finally { f.cleanup() }
  })
  it('checks the whole meeting first, persists the range, and the next check scans only new content', async () => {
    const f = fixture({ scope: scopePlan }, rowsFor)
    try {
      const first = submit(MEETING_FACT_CHECK_QUESTION, 126_414)
      await f.runtime.submit(first)
      const e = await done(f, first.requestId)
      expect(e.status).toBe('completed')
      expect(e.factCheckRange).toEqual({ fromMs: 0, throughMs: 126_414, full: true, claims: 2 })
      expect(e.sections!.map(s => s.label)).toEqual(['So what', 'Claim', 'Claim', 'Confidence'])
      expect(f.webSearch.mock.calls.map(c => c[0])).toEqual(['elephant weight vs car weight', 'average human heart beats lifetime'])
      // Durable: a fresh store over the same directory reads the watermark and the server-only claims.
      const reread = new MeetingAskStore(f.dir).get(first.requestId)!
      expect(reread.exchange.factCheckRange?.throughMs).toBe(126_414)
      expect(reread.factCheck?.claims.map(c => c.claim)).toEqual(['Elephants often weigh more than a car', 'Average heart beats about a billion times in a lifetime'])
      f.run.mockClear()
      const second = submit('Fact check', 700_000)
      await f.runtime.submit(second)
      const next = await done(f, second.requestId)
      const planner = JSON.parse(f.run.mock.calls.find(c => c[2] === FACT_CHECK_PLANNER_SYSTEM)![1])
      expect(planner.window).toEqual({ from: '2:06', through: '11:40', wholeMeetingSoFar: false })
      expect(planner.transcript).not.toContain('elephants')
      expect(planner.alreadyChecked).toHaveLength(2)
      expect(next.factCheckRange).toEqual({ fromMs: 126_414, throughMs: 700_000, full: false, claims: 0 })
    } finally { f.cleanup() }
  })
  it('keeps the 6.71.12 path behind the kill switch and without public-topic consent', async () => {
    process.env.COS_MEETING_FACT_CHECK_SCOPE = '0'
    const off = fixture({ scope: scopePlan }, rowsFor)
    try {
      const r = submit(MEETING_FACT_CHECK_QUESTION, 126_414)
      await off.runtime.submit(r)
      const e = await done(off, r.requestId)
      expect(e.factCheckRange).toBeUndefined()
      expect(off.run.mock.calls.some(c => c[2] === FACT_CHECK_PLANNER_SYSTEM)).toBe(false)
      expect(off.run.mock.calls.some(c => c[2] === PUBLIC_TOPIC_SYSTEM)).toBe(true)
    } finally { off.cleanup() }
    delete process.env.COS_MEETING_FACT_CHECK_SCOPE
    const noConsent = fixture({ scope: scopePlan }, rowsFor)
    try {
      noConsent.store.setPublicTopics(false)
      const r = submit(MEETING_FACT_CHECK_QUESTION, 126_414)
      await noConsent.runtime.submit(r)
      expect((await done(noConsent, r.requestId)).factCheckRange).toBeUndefined()
      expect(noConsent.webSearch).not.toHaveBeenCalled()
    } finally { noConsent.cleanup() }
  })
  it('assumes the owner area for an implicit origin, and follow-ups continue the check without searching their own words', async () => {
    const named = { claims: [{ claim: 'Flying to Kansas City takes 90 minutes to 2 hours; driving takes 10 hours', query: 'to Kansas City flight time vs driving time', evidenceTurnIds: [3, 4], category: 'travel_time', place: 'implicit_origin' }] }
    const single = (p: any) => ({ sections: [{ label: 'So what', text: `Route claim [${p.claims[0].saidIn[0]}]: Mixed. Flights take about 1 hour 50 minutes [${p.claims[0].webSourceIds[0]}].` }], confidence: { level: 'limited', reason: 'Drive time is not on the page.' }, support: [{ id: p.claims[0].webSourceIds[0], quote: 'Nonstop flights take about 1 hour 50 minutes' }] })
    const f = fixture({ named }, single)
    try {
      const q3 = submit('Fact check the flight to kc', 811_966)
      await f.runtime.submit(q3)
      const e3 = await done(f, q3.requestId)
      expect(f.webSearch.mock.calls[0][0]).toBe('austin tx to kansas city flight time vs driving time')
      expect(e3.answer).toContain("Assuming Austin, TX, where you're based (your COS profile)")
      expect(e3.factCheckRange).toBeUndefined()
      expect(e3.notices.join(' ')).toContain('only that place name was added')
      const q4 = submit('From ATX where mu is based', 855_689)
      await f.runtime.submit(q4)
      const e4 = await done(f, q4.requestId)
      expect(f.webSearch.mock.calls[1][0]).toBe('atx austin tx to kansas city flight time vs driving time')
      expect(e4.answer).toContain('Using ATX (Austin, TX) as the starting point, as you said.')
      for (const [q, at] of [["I'm asking you to fact check the claim", 917_703], ['Check it now you', 1_013_144], ['Run it omg', 1_041_315]] as const) {
        const r = submit(q, at)
        await f.runtime.submit(r)
        const e = await done(f, r.requestId)
        expect(e.status).toBe('completed')
        expect(e.publicWebQuery).toBe('atx austin tx to kansas city flight time vs driving time')
        expect(e.notices.join(' ')).not.toContain('withheld')
      }
      // Reused pages: no further search, and no search ever carried the follow-up's own words.
      expect(f.webSearch).toHaveBeenCalledTimes(2)
      expect(f.webSearch.mock.calls.flat().join(' ')).not.toMatch(/\b(?:asking|check it|omg|claim)\b/i)
    } finally { f.cleanup() }
  })
  it('answers a dose question with fixed safety information and no model or web call', async () => {
    const f = fixture({}, rowsFor)
    try {
      const r = submit("How much pain medication for a 400 lb, 5'5 man", 700_000)
      await f.runtime.submit(r)
      const e = await done(f, r.requestId)
      expect(e.status).toBe('completed')
      expect(e.sections![0].text).toBe(MEDICAL_DOSING_ANSWER)
      expect(e.answer).not.toMatch(/\d+\s*mg/i)
      expect(f.run).not.toHaveBeenCalled(); expect(f.webSearch).not.toHaveBeenCalled()
    } finally { f.cleanup() }
  })
})
