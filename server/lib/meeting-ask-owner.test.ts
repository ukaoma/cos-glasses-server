import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchOwnerName, nameWordMatches, personQuestion, personLookupQuery, ownerNotes, ownerCardFromProfile, ownerCardSource, searchedDisclosure, type OwnerCard } from './meeting-ask-owner.js'
import { clearProfileCache } from './profile.js'
import { createLiveAsk, normalizeAsk, type AskInput, type AskSource } from './live-cos-ask.js'
import { MeetingAskRuntime, meetingAskTimingLine } from './meeting-ask-runtime.js'
import { MeetingAskStore } from './meeting-ask-store.js'
import { exportMeetingAsk, meetingPosition } from '../routes/meeting-ask.js'
import { meetingAskFromLine } from '../../shared/meeting-ask.js'

// 6.76.0 field report (Queen, 2026-10-17): "Who is Queen Ukaoma?" on her own COS, heard as "Queen Ukoma",
// was answered "These sources say nothing about who Queen Ukaoma is" from one transcript passage.
const QUEEN: OwnerCard = { name: 'Queen Ukaoma', speakerLabel: 'QU', homeArea: 'Austin, TX', notes: null }
const input = (question: string, extra: Record<string, unknown> = {}): AskInput => normalizeAsk({ sessionId: 'meeting_owner_test', action: 'ask', question, elapsedMs: 210666, turns: [{ id: 1, speaker: 'You', elapsedMs: 200000, text: 'So who is Queen Ukoma anyway, the glasses keep asking.' }], ...extra })
const answer = (text: string) => ({ text: JSON.stringify({ sections: [{ label: 'So what', text }], confidence: { level: 'limited', reason: 'Profile only.' }, searchQuery: null }), model: 'claude-sonnet-5-5' })
const memory = (text: string): AskSource => ({ id: 'H1', kind: 'memory', title: 'Pregnancy with Isaiah', text, memoryId: 'm1', domain: 'personal' })

describe('owner name matching (ASR variants)', () => {
  it('reads Ukoma, Yukoma and Ukaoma as the owner surname, and refuses unrelated words', () => {
    for (const heard of ['Ukaoma', 'Ukoma', 'Yukoma', 'UKAOMA', 'Ukaomá']) expect(nameWordMatches(heard, 'Ukaoma'), heard).toBe(true)
    for (const heard of ['Uma', 'Yoga', 'Okra', 'Kumar', 'Yukomaxx', 'Queens']) expect(nameWordMatches(heard, 'Ukaoma'), heard).toBe(false)
    // Names shorter than four letters must match exactly: Ann is not Anne, Ian is not Jan.
    // One edit below seven letters, two from seven: Okama is two edits from Ukaoma; Swarup two from Swaroop.
    expect(nameWordMatches('Okama', 'Ukaoma')).toBe(false); expect(nameWordMatches('Swarup', 'Swaroop')).toBe(true)
    expect(nameWordMatches('Ann', 'Anne')).toBe(false); expect(nameWordMatches('Ian', 'Jan')).toBe(false); expect(nameWordMatches('ann', 'Ann')).toBe(true)
  })
  it('matches the full name, a lead-in surname, and an exact first-name subject, never another person', () => {
    expect(matchOwnerName('Who is Queen Ukoma?', 'Queen Ukaoma')).toEqual({ heard: 'Queen Ukoma', owner: 'Queen Ukaoma' })
    expect(matchOwnerName('who is Yukoma', 'Queen Ukaoma')?.owner).toBe('Queen Ukaoma')
    expect(matchOwnerName('Who is Queen?', 'Queen Ukaoma')?.heard).toBe('Queen')
    expect(matchOwnerName('Queen Ukaoma, what did she say?', 'Queen Ukaoma')?.owner).toBe('Queen Ukaoma')
    // Same surname, different first name: a family member, not the owner.
    expect(matchOwnerName('Who is Isaiah Ukaoma?', 'Queen Ukaoma')).toBeNull()
    // Miles's COS: Queen is not the owner there.
    expect(matchOwnerName('Who is Queen Ukaoma?', 'Miles Ukaoma')).toBeNull()
    expect(matchOwnerName('The queen of England visited', 'Queen Ukaoma')).toBeNull()
    expect(matchOwnerName('Who is Queen Ukoma?', null)).toBeNull()
    expect(matchOwnerName('Who is Queen Ukoma?', '')).toBeNull()
  })
})

describe('person and self-history questions', () => {
  it('finds who questions and the owner\'s own history, not role or process questions', () => {
    expect(personQuestion('Who is Queen Ukoma?')).toEqual({ kind: 'who', subject: 'Queen Ukoma' })
    expect(personQuestion("Who's Nate from 119?")).toEqual({ kind: 'who', subject: 'Nate from 119' })
    expect(personQuestion('Tell me about Swaroop')).toEqual({ kind: 'who', subject: 'Swaroop' })
    expect(personQuestion('What was going on with me when I was pregnant with Isaiah?')).toEqual({ kind: 'self' })
    expect(personQuestion('Who am I?')).toEqual({ kind: 'self' })
    for (const q of ['Who is speaking right now?', 'Who is responsible for the draft?', 'Who is going to send it?', 'What did Maya commit to?', 'Who is the client?']) expect(personQuestion(q), q).toBeNull()
  })
  it('searches the owner by the profile spelling and a self question by its content words', () => {
    const owner = matchOwnerName('Who is Queen Ukoma?', 'Queen Ukaoma')
    expect(personLookupQuery('Who is Queen Ukoma?', personQuestion('Who is Queen Ukoma?')!, owner, 'Queen Ukaoma')).toBe('Queen Ukaoma')
    expect(personLookupQuery('What was going on with me when I was pregnant with Isaiah?', { kind: 'self' }, null, 'Queen Ukaoma')).toBe('pregnant Isaiah')
    expect(personLookupQuery('Who am I?', { kind: 'self' }, null, 'Queen Ukaoma')).toBe('Queen Ukaoma')
    expect(personLookupQuery('Who is Nate?', { kind: 'who', subject: 'Nate' }, null, null)).toBe('Nate')
  })
})

describe('owner card from the profile', () => {
  const path = process.env.COS_PROFILE_PATH!
  afterEach(() => { rmSync(path, { force: true }); clearProfileCache() })
  it('is null without a real owner name, so the Ask is unchanged', () => {
    clearProfileCache(); expect(ownerCardFromProfile()).toBeNull()
    writeFileSync(path, JSON.stringify({ owner_name: 'Your Name' })); clearProfileCache(); expect(ownerCardFromProfile()).toBeNull()
  })
  it('carries the name, label, home area and notes, and drops address, phone and email sentences', () => {
    writeFileSync(path, JSON.stringify({ owner_name: 'Queen Ukaoma', owner_speaker_label: 'QU', home_city: 'Austin, TX', system_prompt_context: 'Married to Miles. Mother of Amira and Isaiah. Lives at 1204 Oak Hollow Drive. Doctoral candidate, finishing in December. Call 512 555 0199 anytime. Email queen@example.com.' }))
    clearProfileCache()
    const card = ownerCardFromProfile()!
    expect(card).toMatchObject({ name: 'Queen Ukaoma', speakerLabel: 'QU', homeArea: 'Austin, TX' })
    expect(card.notes).toBe('Married to Miles. Mother of Amira and Isaiah. Doctoral candidate, finishing in December.')
    const source = ownerCardSource(card, 'H1')
    expect(source).toMatchObject({ id: 'H1', kind: 'profile' })
    expect(source.text).toContain('This COS belongs to Queen Ukaoma.')
    expect(source.text).not.toMatch(/Oak Hollow|555|example\.com/)
    expect(ownerNotes('Zip 78641 is home. Loves tea.')).toBe('Loves tea.')
  })
  it('the lens From line names the profile when it is cited', () => {
    expect(meetingAskFromLine([{ label: 'So what', text: 'x [H1]', sources: ['H1'] }], [ownerCardSource(QUEEN, 'H1')])).toBe('COS profile')
  })
})

describe('Live COS Ask with the owner card', () => {
  it('passes the card as a citable profile source, reads the ASR spelling as the owner, and returns the cited card', async () => {
    const search = vi.fn(async () => ({ sources: [], notices: [] }))
    const run = vi.fn(async (_p: string) => answer('Queen Ukaoma owns this COS and is the wearer [H1].'))
    const result = await createLiveAsk({ requireHaiku: false, run, search, now: () => 5000, owner: () => QUEEN })(input('Who is Queen Ukoma?'))
    const prompt = JSON.parse(run.mock.calls[0][0])
    expect(prompt.owner).toEqual({ name: 'Queen Ukaoma', sourceId: 'H1' })
    expect(prompt.ownerMatch).toEqual({ heard: 'Queen Ukoma', readAs: 'Queen Ukaoma' })
    expect(prompt.evidence.find((s: AskSource) => s.id === 'H1')).toMatchObject({ kind: 'profile' })
    expect(result.sources.map(s => s.kind)).toEqual(['profile'])
    expect(result.notices).toContain('Read "Queen Ukoma" in your question as Queen Ukaoma, the owner of this COS.')
  })
  it('without a profile name changes nothing: no card, no owner keys', async () => {
    const run = vi.fn(async (_p: string) => answer('Maya will send the draft [T1].'))
    await createLiveAsk({ requireHaiku: false, run, search: vi.fn(async () => ({ sources: [], notices: [] })), now: () => 5000, owner: () => null })(input('What did Maya commit to?'))
    const prompt = JSON.parse(run.mock.calls[0][0])
    expect(prompt).not.toHaveProperty('owner'); expect(prompt).not.toHaveProperty('ownerMatch'); expect(prompt).not.toHaveProperty('cosLookups')
    expect(prompt.evidence.some((s: AskSource) => s.kind === 'profile')).toBe(false)
  })
  it('gives the card to typed questions only, never to presets', async () => {
    const run = vi.fn(async (_p: string) => answer('Summary [T1].'))
    await createLiveAsk({ requireHaiku: false, run, search: vi.fn(), now: () => 5000, owner: () => QUEEN })(input('', { action: 'summary' }))
    expect(JSON.parse(run.mock.calls[0][0]).evidence.some((s: AskSource) => s.kind === 'profile')).toBe(false)
  })
})

describe('person questions always look in COS first', () => {
  it('searches COS for the owner before the first model call, in every domain, and saves the planner hop', async () => {
    const calls: string[] = []
    const search = vi.fn(async (q: string, _s?: string, scope?: string, options?: { anyDomain?: boolean }) => { calls.push(`search:${q}:${scope}:${options?.anyDomain}`); return { sources: [memory('Queen keeps the family calendar.')], notices: [] } })
    const run = vi.fn(async (_p: string) => { calls.push('answer'); return answer('Queen Ukaoma owns this COS [H1] and keeps the family calendar [H2].') })
    const result = await createLiveAsk({ requireHaiku: false, run, search, now: () => 5000, owner: () => QUEEN })(input('Who is Queen Ukoma?'))
    expect(calls).toEqual(['search:Queen Ukaoma:cos:true', 'answer'])
    const prompt = JSON.parse(run.mock.calls[0][0])
    expect(prompt.cosLookups).toEqual([{ query: 'Queen Ukaoma', searched: 'COS memories and earlier meetings', results: 1 }])
    expect(prompt.searchAllowed).toBe(true)
    expect(result.sources.map(s => s.kind).sort()).toEqual(['memory', 'profile'])
  })
  it('runs for a self-history question with the owner\'s words, and for another person without a profile', async () => {
    const search = vi.fn(async () => ({ sources: [memory('In spring 2023 Queen was pregnant with Isaiah and writing her proposal.')], notices: [] }))
    const run = vi.fn(async () => answer('You were pregnant with Isaiah while writing your proposal [H2].'))
    await createLiveAsk({ requireHaiku: false, run, search, now: () => 5000, owner: () => QUEEN })(input('What was going on with me when I was pregnant with Isaiah?'))
    expect(search).toHaveBeenCalledWith('pregnant Isaiah', 'meeting_owner_test', 'cos', { anyDomain: true })
    const other = vi.fn(async () => ({ sources: [], notices: [] }))
    await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('Nate is not described here [T1].')), search: other, now: () => 5000 })(input('Who is Nate?'))
    expect(other).toHaveBeenCalledWith('Nate', 'meeting_owner_test', 'cos', { anyDomain: true })
  })
  it('never forces a lookup for a preset, the fixed retirement rule, or a consented public-topic check', async () => {
    const search = vi.fn(async () => ({ sources: [], notices: [] }))
    await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('Ask about Nate [T1].')), search, now: () => 5000 })(input('Who is Nate?', { action: 'questions' }))
    expect(search).not.toHaveBeenCalled()
    await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('The rule [T1].')), search, now: () => 5000, evidenceQuestion: 'retirement rule' })(input('Who is Nate?'))
    expect(search).not.toHaveBeenCalled()
    const web = vi.fn(async () => ({ sources: [{ id: 'W1', kind: 'web' as const, title: 'Nate', text: 'Nate article', url: 'https://example.com' }], notices: [] }))
    await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('The article [W1].')), search: web, now: () => 5000, webAvailable: true, publicTopicQuery: true, explicitWebQuery: 'Nate article' })(input('Who is Nate?'))
    expect(web.mock.calls.map(c => (c as unknown[])[2])).toEqual(['web'])
  })
  it('does not search for an ordinary meeting question', async () => {
    const search = vi.fn()
    await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('Maya will send it [T1].')), search, now: () => 5000, owner: () => QUEEN })(input('What did Maya commit to?'))
    expect(search).not.toHaveBeenCalled()
  })
  it('the forced lookup takes one of the two lookups, and never reaches the web', async () => {
    // Lookups that find something, so emptyCosLookup cannot be what closes the budget.
    const search = vi.fn(async () => ({ sources: [memory('Queen hosts the family dinners.')], notices: [] }))
    const run = vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ sections: [], searchQuery: 'Queen family', searchScope: 'cos' }) })
      .mockResolvedValue(answer('Queen Ukaoma owns this COS [H1].'))
    const result = await createLiveAsk({ requireHaiku: false, run, search, now: () => 5000, owner: () => QUEEN, webAvailable: false })(input('Who is Queen Ukoma?'))
    expect(search.mock.calls.map(c => (c as unknown[])[2])).toEqual(['cos', 'cos'])
    expect(JSON.parse(run.mock.calls[1][0]).searchAllowed).toBe(false)
    expect(result.timings!.phases.map(p => p.phase)).toEqual(['cos_search', 'plan', 'cos_search', 'answer'])
  })
})

describe('an empty COS lookup is never proof of absence', () => {
  it('says what was searched in the answer and the notices', async () => {
    const search = vi.fn(async () => ({ sources: [], notices: ['No relevant COS history was found.'] }))
    const run = vi.fn(async () => answer('These sources say nothing about who Queen Ukaoma is [T1].'))
    const result = await createLiveAsk({ requireHaiku: false, run, search, now: () => 5000 })(input('Who is Queen Ukaoma?'))
    const lead = result.sections.find(s => s.label === 'So what')!
    expect(lead.text).toContain(searchedDisclosure(['Queen Ukaoma']))
    expect(lead.text).toContain('COS searched memories and earlier meetings for "Queen Ukaoma" and found no match')
    expect(result.notices).toContain(searchedDisclosure(['Queen Ukaoma']))
    expect(result.notices).not.toContain('No relevant COS history was found.')
  })
  it('does not repeat the disclosure when the answer already says what COS searched', async () => {
    const text = 'COS searched for Queen Ukaoma and these sources say nothing about her [T1].'
    const result = await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer(text)), search: vi.fn(async () => ({ sources: [], notices: [] })), now: () => 5000 })(input('Who is Queen Ukaoma?'))
    expect(result.sections[0].text).toBe(text)
  })
  it('leaves an answer that does not claim absence alone, and adds nothing when the lookup found something', async () => {
    const empty = vi.fn(async () => ({ sources: [], notices: [] }))
    const plain = await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('The speaker asked about Queen Ukoma [T1].')), search: empty, now: () => 5000 })(input('Who is Queen Ukaoma?'))
    expect(plain.sections[0].text).toBe('The speaker asked about Queen Ukoma [T1].')
    expect(plain.notices).toContain(searchedDisclosure(['Queen Ukaoma']))
    const found = await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('These sources say nothing about her job [H1].')), search: vi.fn(async () => ({ sources: [memory('Queen is a doctoral candidate.')], notices: [] })), now: () => 5000 })(input('Who is Queen Ukaoma?'))
    expect(found.sections[0].text).not.toContain('COS searched')
  })
  it('still lets the planner reach the gated web after an empty forced lookup', async () => {
    const search = vi.fn(async (_q: string, _s?: string, scope?: string) => ({ sources: scope === 'web' ? [{ id: 'W1', kind: 'web' as const, title: 'Alt Coin Daily', text: 'A crypto channel.', url: 'https://example.com' }] : [], notices: [] }))
    const run = vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ sections: [], searchQuery: 'alt coin daily', searchScope: 'web' }) })
      .mockResolvedValue(answer('Alt Coin Daily is a crypto channel [W1].'))
    await createLiveAsk({ requireHaiku: false, run, search, now: () => 5000, webAvailable: true })(input('Who is alt coin daily?'))
    expect(JSON.parse(run.mock.calls[0][0]).searchAllowed).toBe(true)
    expect(search.mock.calls.map(c => c[2])).toEqual(['cos', 'web'])
  })
})

describe('per-phase timing', () => {
  it('times every phase, marks the forced lookup, and keeps a failed phase in the caller\'s list', async () => {
    let t = 0
    const clock = () => (t += 100)
    const search = vi.fn(async () => ({ sources: [memory('Queen keeps the calendar.')], notices: [] }))
    const review = vi.fn(async () => ({ text: JSON.stringify({ sections: [{ label: 'So what', text: 'Queen Ukaoma owns this COS [H1].' }], confidence: { level: 'supported', reason: 'Profile states it.' }, support: [{ id: 'H1', quote: 'This COS belongs to Queen Ukaoma.' }] }) }))
    const result = await createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('Queen Ukaoma owns this COS [H1].')), review, search, now: () => 5000, clock, owner: () => QUEEN })(input('Who is Queen Ukoma?'))
    expect(result.timings!.phases.map(p => [p.phase, p.ms, p.forced ?? false, p.results])).toEqual([['cos_search', 100, true, 1], ['answer', 100, false, undefined], ['review', 100, false, undefined]])
    expect(result.timings!.totalMs).toBeGreaterThan(300)
    const phases: any[] = []
    await expect(createLiveAsk({ requireHaiku: false, run: vi.fn(async () => { throw new Error('provider_timeout') }), search, now: () => 5000, clock, phases })(input('Who is Queen Ukaoma?'))).rejects.toThrow('provider_timeout')
    expect(phases.map(p => [p.phase, p.failed ?? false])).toEqual([['cos_search', false], ['answer', true]])
  })
  it('labels a model call that led to an explicit web lookup as plan, and a cached reply carries no timings', async () => {
    const search = vi.fn(async () => ({ sources: [{ id: 'W1', kind: 'web' as const, title: 'Rates', text: 'Rates today.', url: 'https://example.com' }], notices: [] }))
    const ask = createLiveAsk({ requireHaiku: false, run: vi.fn(async () => answer('Rates are cited [W1].')), search, now: () => 5000, webAvailable: true, explicitWebQuery: 'mortgage rates today' })
    const first = await ask(input('Search the web for mortgage rates today'))
    expect(first.timings!.phases.map(p => p.phase)).toEqual(['plan', 'web_search', 'answer'])
    const again = await ask(input('Search the web for mortgage rates today'))
    expect(again.cached).toBe(true); expect(again).not.toHaveProperty('timings')
  })
  it('the durable runtime journals timings, logs one numbers-only line, and keeps them on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-owner-')), lines: string[] = []
    try {
      const make = (run: any) => new MeetingAskRuntime({ reviewAnswers: false, finalized: () => ({ sources: [], notices: [] }), store: new MeetingAskStore(dir), identity: () => 'server-one', admissions: () => true, lease: () => ({ release() {} } as any), catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'sonnet', models: ['sonnet'] }] as any, run, search: async () => ({ sources: [], notices: [] }), webCapability: () => ({ available: false, reason: 'test' }) as any, owner: () => QUEEN, logTimings: (l: string) => lines.push(l) })
      const settle = async (rt: MeetingAskRuntime, id: string) => { for (let i = 0; i < 200 && ['pending', 'running'].includes(rt.get(id).status); i++) await new Promise(r => setTimeout(r, 2)); return rt.get(id) }
      const ok = make(vi.fn(async () => answer('Queen Ukaoma owns this COS [H1].')))
      const question = 'Who is Queen Ukoma?'
      await ok.submit({ requestId: 'request_owner_ok', sessionId: 'meeting_owner_rt', serverInstanceId: 'server-one', action: 'ask', question, elapsedMs: 210666, turns: [{ id: 0, elapsedMs: 0, speaker: 'You', text: 'Who is Queen Ukoma anyway.' }] } as any)
      const done = await settle(ok, 'request_owner_ok')
      expect(done.status).toBe('completed')
      expect(done.sources.some(s => s.kind === 'profile')).toBe(true)
      expect(done.timings!.phases.map(p => p.phase)).toEqual(['cos_search', 'answer'])
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^\[meeting-ask\] timing request_owner_ok ask completed total=\d+ms cos_search\(forced\)=\d+\/0 answer=\d+$/)
      expect(lines[0]).not.toContain('Queen')
      const bad = make(vi.fn(async () => { throw new Error('boom') }))
      await bad.submit({ requestId: 'request_owner_bad', sessionId: 'meeting_owner_rt', serverInstanceId: 'server-one', action: 'ask', question, elapsedMs: 220000, turns: [{ id: 0, elapsedMs: 0, speaker: 'You', text: 'Who is Queen Ukoma anyway.' }] } as any)
      const failed = await settle(bad, 'request_owner_bad')
      expect(failed.status).toBe('failed')
      expect(failed.timings!.phases.map(p => [p.phase, p.failed ?? false])).toEqual([['cos_search', false], ['answer', true]])
      expect(lines[1]).toMatch(/ ask failed:provider_unavailable total=\d+ms cos_search\(forced\)=\d+\/0 answer\(failed\)=\d+$/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('the runtime searches every domain for the forced lookup and the confirmed domain otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-owner-dom-'))
    try {
      const store = new MeetingAskStore(dir)
      store.putOrientation('meeting_owner_dom', { revision: 1, domain: 'quilt', calendar: null } as any)
      const search = vi.fn(async (..._a: unknown[]) => ({ sources: [], notices: [] }))
      const run = vi.fn().mockResolvedValueOnce({ text: JSON.stringify({ sections: [], searchQuery: 'Queen pricing', searchScope: 'cos' }) }).mockResolvedValue(answer('Queen Ukaoma owns this COS [H1].'))
      const rt = new MeetingAskRuntime({ reviewAnswers: false, finalized: () => ({ sources: [], notices: [] }), domains: () => [{ id: 'quilt', label: 'Quilt' }], store, identity: () => 'server-one', admissions: () => true, lease: () => ({ release() {} } as any), catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'sonnet', models: ['sonnet'] }] as any, run, search: search as any, webCapability: () => ({ available: false, reason: 'test' }) as any, owner: () => QUEEN, logTimings: () => {} })
      await rt.submit({ requestId: 'request_owner_dom', sessionId: 'meeting_owner_dom', serverInstanceId: 'server-one', action: 'ask', question: 'Who is Queen Ukoma?', elapsedMs: 1000, turns: [{ id: 0, elapsedMs: 0, speaker: 'You', text: 'Pricing again.' }] } as any)
      for (let i = 0; i < 200 && ['pending', 'running'].includes(rt.get('request_owner_dom').status); i++) await new Promise(r => setTimeout(r, 2))
      expect(search.mock.calls.map(c => [c[0], c[4]])).toEqual([['Queen Ukaoma', undefined], ['Queen pricing', 'quilt']])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the export says what throughMs is', () => {
  it('reads the meeting position as a clock and the answer time separately', () => {
    expect(meetingPosition(210666)).toBe('3:30'); expect(meetingPosition(288457)).toBe('4:48'); expect(meetingPosition(3_723_000)).toBe('1:02:03')
    const text = exportMeetingAsk([{ requestId: 'r1', sessionId: 'meeting_x', serverInstanceId: 's', action: 'ask', question: 'Who is Queen Ukoma?', status: 'completed', createdAt: 'c', updatedAt: 'u', selectedModel: { engine: 'claude', model: 'sonnet' }, model: 'claude-sonnet-5-5', sources: [], notices: [], throughMs: 210666, files: [], timings: { totalMs: 6400, phases: [{ phase: 'cos_search', ms: 900, forced: true, results: 0 }, { phase: 'answer', ms: 5500 }] } } as any], [])
    expect(text).toContain('Transcript through: 3:30 into the meeting')
    expect(text).toContain('Answer time: 6.4 s (cos search (always for person questions) 0.9 s, answer 5.5 s)')
    expect(text).not.toContain('210666 ms')
    expect(meetingAskTimingLine('r', 'ask', 'completed', { totalMs: 5, phases: [] })).toBe('[meeting-ask] timing r ask completed total=5ms')
  })
})
