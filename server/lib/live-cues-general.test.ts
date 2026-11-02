import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { JevError } from './jev.js'
import { DecisionProviderError } from './decision-provider.js'

const mocks = vi.hoisted(() => ({ engine: vi.fn(), search: vi.fn() }))
vi.mock('./lens-gist-engines.js', async importOriginal => ({ ...(await importOriginal<typeof import('./lens-gist-engines.js')>()), runLensGistEngine: mocks.engine }))
vi.mock('./meeting-ask-web.js', async importOriginal => ({ ...(await importOriginal<typeof import('./meeting-ask-web.js')>()), searchMeetingWeb: mocks.search }))
const G = await import('./live-cues-general.js')
const { LensGistLimitError } = await import('./lens-gist-engines.js')
const { liveCuesV2Model } = await import('./live-cues-v2.js')
type Deps = import('./live-cues-general.js').GeneralCueDeps
type Row = import('./live-cues-general.js').GeneralTickRow
type Insight = import('./live-cues-general.js').GeneralInsight
type Limits = import('./live-cues-general.js').GeneralCueLimits

// Every name here is made up; the module holds none.
const PROFILE = { ownerName: () => 'Zephyrine Quillon', speakerLabel: () => 'ZQX', vocabulary: () => ['Frobnitz', 'retail analytics hub'], domainKeywords: () => ({ quillco_corp: ['Quillco'] }) }
const ROOM = 'The Formula One race weekend is coming to town and everyone is talking about the circuit, the grandstands and the new team.'
const QUERIES = ['Formula One circuit news', 'Formula One grandstands news', 'Formula One paddock news', 'Formula One pit lane news', 'Formula One safety car news',
  'Formula One qualifying news', 'Formula One podium news', 'Formula One tyre news', 'Formula One pole news', 'Formula One chicane news']
const LIMITS: Limits = { intervalSeconds: 300, trigger: 0.6, attemptsPerMeeting: 8, maxCuesPerMeeting: 4, dailyTopicCalls: 60, dailyWebSearches: 30 }
const SOURCE = { id: 'W1', title: 'Grid news', text: 'A new constructor joins the grid next season.', url: 'https://example.org/grid' }
const WRITTEN = JSON.stringify({ headline: 'A new team joins the grid', detail: 'A new constructor joins the grid next season, says the source.', sourceIds: ['W1'] })

interface Sess { sessionId: string; kindSet: 'legacy' | 'extended'; armed: boolean; paused: boolean; domain: string | null; domainUnreadable?: boolean; title: string; transcriptChars: number; text: string; speakerNames?: string[] }
const mac = (sessionId = 'mac_1', over: Partial<Sess> = {}): Sess => ({ sessionId, kindSet: 'extended', armed: true, paused: false, domain: 'work', title: 'Mac Recording 2026-11-01 1200', transcriptChars: 0, text: ROOM, ...over })

const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); mocks.engine.mockReset(); mocks.search.mockReset(); for (const d of dirs.splice(0)) { try { chmodSync(d, 0o700) } catch { /* gone */ } rmSync(d, { recursive: true, force: true }) } })

async function make(opts: { sessions?: Sess[]; deps?: Partial<Deps>; statePath?: string; limits?: Partial<Limits> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cues-general-'))
  dirs.push(dir)
  const statePath = opts.statePath ?? join(dir, 'state.json')
  const clock = { t: Date.parse('2026-11-01T18:00:00Z') }
  const calls = { trigger: 0, topic: 0, search: [] as string[], writer: 0, host: 0 }
  const traces: Row[] = []
  const emitted: Array<{ sessionId: string; insight: Insight }> = []
  const settings = { mode: 'general' as import('./live-cues-general.js').GeneralCueMode, publicTopics: true, homeArea: 'Austin, TX' as string | null, limits: { ...LIMITS, ...opts.limits }, p: 0.9, accept: true }
  const sessions = opts.sessions ?? [mac()]
  const host = {
    candidates: () => { calls.host += 1; return sessions.map(s => ({ ...s, window: (n: number) => s.text.slice(-n) })) },
    emit: (sessionId: string, insight: Insight) => { if (!settings.accept) return false; emitted.push({ sessionId, insight }); return true },
  }
  const reader = { cueMode: () => settings.mode, limits: () => settings.limits, publicTopics: () => settings.publicTopics, homeArea: () => settings.homeArea }
  const deps: Deps = {
    jevTrigger: async () => { calls.trigger += 1; return { pGeneral: settings.p, tokens: 800 } },
    topicModel: async () => { const q = QUERIES[calls.topic % QUERIES.length]; calls.topic += 1; return { text: JSON.stringify({ topic: true, category: 'news', query: q }), costUsd: 0.001 } },
    search: async query => { calls.search.push(query); return { sources: [SOURCE] } },
    writer: async () => { calls.writer += 1; return { text: WRITTEN, costUsd: 0.002 } },
    now: () => clock.t, statePath, trace: r => traces.push(r), profile: PROFILE,
    ...opts.deps,
  }
  const runner = new G.GeneralCueRunner(host, reader, deps)
  await runner.tick()                                        // the meetings become eligible now: each waits one interval
  const h = {
    dir, statePath, clock, calls, traces, emitted, settings, sessions, host, reader, deps, runner,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    advance(ms = 301_000) { clock.t += ms; for (const s of sessions) s.transcriptChars += 2_000 },
    go(ms = 301_000) { h.advance(ms); return runner.tick() },
    writeState(patch: Record<string, unknown>) {
      writeFileSync(statePath, JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-01', topicCalls: 0, webSearches: 0, meetings: {}, breaker: { failures: 0, stage: 0, openUntil: null }, ...patch }))
    },
    fresh: () => new G.GeneralCueRunner(host, reader, deps),
    inFlightNow: () => runner['inFlight'] !== null,
  }
  return h
}
type H = Awaited<ReturnType<typeof make>>
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }

describe('eligibility', () => {
  it('runs for an extended, armed, unpaused meeting in general mode and in all mode', async () => {
    for (const mode of ['general', 'all'] as const) {
      const h = await make()
      h.settings.mode = mode
      expect(await h.go()).toMatchObject({ ran: true, outcome: 'cue' })
      expect(h.calls.trigger).toBe(1)
    }
  })
  it.each([
    ['eligibility: mode focused', (h: H) => { h.settings.mode = 'focused' }, { state: 'off', reason: 'mode_focused' }],
    ['eligibility: legacy meeting (G2) never gets general cues', (h: H) => { h.sessions[0].kindSet = 'legacy' }, { state: 'off', reason: 'not_extended' }],
    ['eligibility: meeting not armed', (h: H) => { h.sessions[0].armed = false }, { state: 'off', reason: 'not_armed' }],
    ['eligibility: meeting paused', (h: H) => { h.sessions[0].paused = true }, { state: 'off', reason: 'paused' }],
    ['eligibility: public topics consent off', (h: H) => { h.settings.publicTopics = false }, { state: 'needs_public_topics', reason: 'public_topics_off' }],
    ['eligibility: personal domain', (h: H) => { h.sessions[0].domain = 'personal' }, { state: 'withheld', reason: 'personal_domain' }],
    ['eligibility: orientation unreadable', (h: H) => { h.sessions[0].domainUnreadable = true }, { state: 'withheld', reason: 'orientation_unreadable' }],
    ['eligibility: personal domain in any case', (h: H) => { h.sessions[0].domain = ' Personal ' }, { state: 'withheld', reason: 'personal_domain' }],
  ])('%s: no model call, no search, no cue', async (_name, change, status) => {
    const h = await make()
    change(h)
    const r = await h.go()
    expect(r.ran).toBe(false)
    expect(h.calls).toMatchObject({ trigger: 0, topic: 0, search: [], writer: 0 })
    expect(h.emitted).toEqual([])
    expect(h.runner.status('mac_1')).toMatchObject({ ...status, cues: 0, attempts: 0 })
  })
  it('an unconfirmed (null) domain is eligible; only a confirmed personal one is not', async () => {
    const h = await make({ sessions: [mac('mac_1', { domain: null })] })
    expect(await h.go()).toMatchObject({ ran: true })
  })
})

describe('tick', () => {
  it('waits one interval after the meeting becomes eligible, then again between attempts', async () => {
    const h = await make()
    h.sessions[0].transcriptChars = 9_000
    h.clock.t += 299_000
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'not_due' })
    h.clock.t += 2_000
    expect(await h.runner.tick()).toMatchObject({ ran: true })
    h.sessions[0].transcriptChars = 20_000
    h.clock.t += 299_000
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'not_due' })
    h.clock.t += 2_000
    expect(await h.runner.tick()).toMatchObject({ ran: true })
  })
  it('uses the interval from the settings, read at every tick', async () => {
    const h = await make({ limits: { intervalSeconds: 120 } })
    h.sessions[0].transcriptChars = 9_000
    h.clock.t += 121_000
    expect(await h.runner.tick()).toMatchObject({ ran: true })
  })
  it('needs about 90 s of new speech: 1,200 new characters since its last tick', async () => {
    const h = await make()
    h.clock.t += 301_000
    h.sessions[0].transcriptChars = 1_199
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'not_due' })
    h.sessions[0].transcriptChars = 1_200
    expect(await h.runner.tick()).toMatchObject({ ran: true })
    h.clock.t += 301_000
    h.sessions[0].transcriptChars = 1_200 + 1_199
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'not_due' })
    h.sessions[0].transcriptChars = 1_200 + 1_200
    expect(await h.runner.tick()).toMatchObject({ ran: true })
  })
  it('a meeting that becomes eligible later (mode switched on mid-meeting) waits a full interval', async () => {
    const h = await make()
    h.settings.mode = 'focused'
    await h.go(3_600_000)
    h.settings.mode = 'general'
    h.sessions[0].transcriptChars = 90_000
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'not_due' })
    expect(await h.go()).toMatchObject({ ran: true })
  })
  it('a meeting that becomes eligible later (unpaused mid-meeting) waits a full interval', async () => {
    const h = await make()
    h.sessions[0].paused = true
    await h.go(3_600_000)
    h.sessions[0].paused = false
    h.sessions[0].transcriptChars = 90_000
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'not_due' })
    expect(await h.go()).toMatchObject({ ran: true })
  })
  it('one attempt in flight server-wide: a second tick while one runs starts nothing', async () => {
    const hold = gate(), entered = gate()
    const h = await make({ sessions: [mac('mac_a'), mac('mac_b')], deps: { search: async q => { entered.release(); await hold.promise; return { sources: [SOURCE] } } } })
    h.advance()
    const first = h.runner.tick()
    const second = h.runner.tick()
    expect(await second).toMatchObject({ ran: false, why: 'busy' })
    await entered.promise
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'busy' })
    expect(h.calls.trigger).toBe(1)
    hold.release()
    expect(await first).toMatchObject({ ran: true, sessionId: 'mac_a', outcome: 'cue' })
    expect(await h.runner.tick()).toMatchObject({ ran: true, sessionId: 'mac_b' })
  })
  it('the meeting that has waited longest goes first', async () => {
    const h = await make({ sessions: [mac('mac_a'), mac('mac_b')] })
    const order: string[] = []
    for (let i = 0; i < 4; i++) order.push((await h.go()).sessionId!)
    expect(order).toEqual(['mac_a', 'mac_b', 'mac_a', 'mac_b'])
  })
  it('a host that throws ends the pass without starting anything', async () => {
    const h = await make()
    h.host.candidates = () => { throw new Error('host is gone') }
    expect(await h.go()).toEqual({ ran: false, why: 'host_error' })
    expect(h.calls.trigger).toBe(0)
  })
  it('forgets a meeting the host no longer lists', async () => {
    const h = await make({ sessions: [mac('mac_a'), mac('mac_b')] })
    h.sessions.pop()
    await h.go()
    h.sessions.push(mac('mac_b'))
    h.sessions[1].transcriptChars = 90_000
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'not_due' })
  })
  it('start polls on a timer, once, and stop ends it and aborts the attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = await make()
    const before = h.calls.host
    h.runner.start()
    h.runner.start()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(h.calls.host - before).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls.host - before).toBe(1)
    h.runner.stop()
    await vi.advanceTimersByTimeAsync(150_000)
    expect(h.calls.host - before).toBe(1)
  })
})

describe('sensitive window', () => {
  it('skips before any model call, charges nothing, and reports withheld with a category code only', async () => {
    const h = await make({ sessions: [mac('mac_1', { text: 'we still owe the IRS and the mortgage payment' })] })
    const r = await h.go()
    expect(r).toMatchObject({ ran: true, outcome: 'no_cue', reason: 'sensitive:finance' })
    expect(h.calls).toMatchObject({ trigger: 0, topic: 0, search: [], writer: 0 })
    expect(() => h.state()).toThrow()                        // nothing was charged, so nothing was written
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'withheld', reason: 'sensitive_window' })
    expect(h.traces.at(-1)).toMatchObject({ pGeneral: null, queryHash: null })
    expect(JSON.stringify(h.traces)).not.toMatch(/mortgage|IRS/i)
  })
  it('vocabulary never skips a window: the owner\'s own terms guard the query, not the room', async () => {
    const h = await make({ sessions: [mac('mac_1', { text: 'we keep coming back to Frobnitz and the retail analytics hub in the roadmap' })] })
    expect(await h.go()).toMatchObject({ outcome: 'cue' })
    expect(h.calls.trigger).toBe(1)
  })
})

describe('trigger', () => {
  it('below the threshold ends the tick before the topic call, and traces P', async () => {
    const h = await make()
    h.settings.p = 0.59
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'trigger_below' })
    expect(h.calls).toMatchObject({ trigger: 1, topic: 0 })
    expect(h.traces.at(-1)).toMatchObject({ pGeneral: 0.59 })
  })
  it('at the threshold it goes on, using the threshold from the settings', async () => {
    const h = await make({ limits: { trigger: 0.45 } })
    h.settings.p = 0.45
    expect(await h.go()).toMatchObject({ outcome: 'cue' })
  })
  it('a non-numeric answer never passes', async () => {
    const h = await make({ deps: { jevTrigger: async () => ({ pGeneral: Number.NaN, tokens: 1 }) } })
    expect(await h.go()).toMatchObject({ reason: 'trigger_below' })
  })
  it('is given the title and the cleaned window of the room', async () => {
    let seen: unknown[] = []
    const h = await make({ deps: { jevTrigger: async (...a) => { seen = a; return { pGeneral: 0.1, tokens: 1 } } } })
    await h.go()
    expect(seen[0]).toBe('Mac Recording 2026-11-01 1200')
    expect(seen[1]).toBe(ROOM)
  })
})

describe('topic and admission', () => {
  it('topic false and an unparseable topic end quietly without a search', async () => {
    for (const [text, reason] of [['{"topic":false}', 'no_topic'], ['not json', 'topic_unparseable']] as const) {
      const h = await make({ deps: { topicModel: async () => ({ text }) } })
      expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason })
      expect(h.calls.search).toEqual([])
    }
  })
  it('window: every dependency sees the room redacted, and the topic call sees the last 2,700 characters (about three minutes)', async () => {
    const seen: { jev: string; topic: string } = { jev: '', topic: '' }
    const text = 'q'.repeat(4_000) + ' my key is sk-abcdefghijklmnop ok'
    const h = await make({ sessions: [mac('mac_1', { text })], deps: {
      jevTrigger: async (_t, window) => { seen.jev = window; return { pGeneral: 0.9, tokens: 1 } },
      topicModel: async (_s, prompt) => { seen.topic = JSON.parse(prompt).window; return { text: '{"topic":false}' } },
    } })
    await h.go()
    expect(seen.jev).toContain('sk-REDACTED')
    expect(seen.jev).not.toContain('sk-abcdefghijklmnop')
    expect(seen.jev.length).toBe(2_700 + 'sk-REDACTED'.length - 'sk-abcdefghijklmnop'.length)
    expect(seen.topic).toBe(seen.jev)
  })
  it('the topic prompt carries the window only, as data', async () => {
    let seen: { system: string; prompt: string } | null = null
    const h = await make({ deps: { topicModel: async (system, prompt) => { seen = { system, prompt }; return { text: '{"topic":false}' } } } })
    await h.go()
    expect(JSON.parse(seen!.prompt)).toEqual({ window: ROOM })
    expect(seen!.system).toContain('Only PUBLIC subjects qualify')
  })
  it.each([
    ['admission: a digit in the query', { text: ROOM, speakerNames: [] }, 'Austin FC 2026 season', 'rejected:digit'],
    ['admission: a deny-list word in the query', { text: ROOM, speakerNames: [] }, 'family court news', 'rejected:deny_word'],
    ['admission: a speaker label from the window', { text: `Marlowe: ${ROOM}`, speakerNames: [] }, 'Marlowe bakery news', 'rejected:name'],
    ['admission: a speaker name the host knows', { text: ROOM, speakerNames: ['Prunella Voss'] }, 'Prunella Voss interview', 'rejected:name'],
    ['admission: an owner term from the profile', { text: ROOM, speakerNames: [] }, 'Quillco product launch', 'rejected:owner_term'],
    ['admission: a whole vocabulary phrase', { text: ROOM, speakerNames: [] }, 'Retail Analytics Hub pricing news', 'rejected:owner_term'],
    ['admission: a vocabulary phrase written without its spaces', { text: ROOM, speakerNames: [] }, 'RetailAnalyticsHub pricing news', 'rejected:owner_term'],
    ['admission: a vocabulary term split differently', { text: ROOM, speakerNames: [] }, 'Frob Nitz review', 'rejected:owner_term'],
    ['admission: the owner\'s own name', { text: ROOM, speakerNames: [] }, 'Zephyrine keynote speech', 'rejected:name'],
  ])('%s is rejected before any search', async (_name, session, query, reason) => {
    const h = await make({ sessions: [mac('mac_1', session)], deps: { topicModel: async () => ({ text: JSON.stringify({ topic: true, category: 'news', query }) }) } })
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason })
    expect(h.calls.search).toEqual([])
    expect(h.traces.at(-1)!.queryHash).toBeNull()                    // a privacy rejection carries no hash at all
  })
  it('a repeat or a length rejection keeps its hash; a privacy rejection never has one', async () => {
    for (const [query, reason, hash] of [['Formula One circuit news', 'rejected:repeat', true], ['alpha beta gamma delta epsilon zeta eta theta iota', 'rejected:too_many_words', true],
      ['a'.repeat(81), 'rejected:too_long', true], ['Austin FC 2026 season', 'rejected:digit', false], ['ten percent growth', 'rejected:number_word', false],
      ['sk-abcdefghijklmnop', 'rejected:secret', false], ['family court news', 'rejected:deny_word', false], ['Zephyrine keynote', 'rejected:name', false],
      ['Quillco launch', 'rejected:owner_term', false]] as const) {
      const h = await make({ deps: { topicModel: async () => ({ text: JSON.stringify({ topic: true, category: 'news', query }) }) } })
      if (reason === 'rejected:repeat') h.runner['noteQuery']('mac_1', 'formula one circuit news', h.clock.t)
      expect(await h.go(), query).toMatchObject({ outcome: 'no_cue', reason })
      if (hash) expect(h.traces.at(-1)!.queryHash, query).toMatch(/^[0-9a-f]{12}$/)
      else expect(h.traces.at(-1)!.queryHash, query).toBeNull()
    }
  })
  it('a local query that fails after the area is added keeps a hash only for a length rejection', async () => {
    const h = await make({ deps: { topicModel: async () => ({ text: '{"topic":true,"category":"local","query":"riverside street food festival lineup tonight"}' }) } })
    h.settings.homeArea = 'San Francisco, CA'
    expect(await h.go()).toMatchObject({ reason: 'rejected_local:too_many_words' })
    expect(h.traces.at(-1)!.queryHash).toMatch(/^[0-9a-f]{12}$/)
  })
  it('admission reads every enrolled voice name: a name only the voice store knows is rejected', async () => {
    const voices: Deps['profile'] = { ...PROFILE, voiceProfileNames: () => ['Prunella Voss', 'Thaddeus Orme'] }
    const h = await make({ deps: { profile: voices, topicModel: async () => ({ text: '{"topic":true,"category":"news","query":"Thaddeus Orme interview"}' }) } })
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'rejected:name' })
    expect(h.calls.search).toEqual([])
  })
  it('names_unavailable: voice names that cannot be read withhold the meeting before any spend', async () => {
    const unreadable: Deps['profile'] = { ...PROFILE, voiceProfileNames: () => { throw new Error('voice store unreadable') } }
    const h = await make({ deps: { profile: unreadable } })
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'names_unavailable' })
    expect(h.calls).toMatchObject({ trigger: 0, topic: 0, search: [], writer: 0 })
    expect(() => h.state()).toThrow()                                  // nothing charged
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'withheld', reason: 'names_unavailable' })
  })
  it('owner term: a query with just one word of a vocabulary term goes on to the search', async () => {
    const h = await make({ deps: { topicModel: async () => ({ text: '{"topic":true,"category":"news","query":"retail industry news"}' }) } })
    expect(await h.go()).toMatchObject({ outcome: 'cue' })
    expect(h.calls.search).toEqual(['retail industry news'])
  })
  it('local: appends the owner\'s home area, admits the longer query again, then searches it', async () => {
    const h = await make({ deps: { topicModel: async () => ({ text: '{"topic":true,"category":"local","query":"street food festival"}' }) } })
    expect(await h.go()).toMatchObject({ outcome: 'cue' })
    expect(h.calls.search).toEqual(['street food festival Austin TX'])
    expect(h.emitted[0].insight).toMatchObject({ category: 'local', query: 'street food festival Austin TX' })
  })
  it('local: the appended query is admitted again and can fail the limits', async () => {
    const h = await make({ deps: { topicModel: async () => ({ text: '{"topic":true,"category":"local","query":"riverside street food festival lineup tonight"}' }) } })
    h.settings.homeArea = 'San Francisco, CA'
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'rejected_local:too_many_words' })
    expect(h.calls.search).toEqual([])
  })
  it('local: without a home area there is nothing to append, so no search', async () => {
    const h = await make({ deps: { topicModel: async () => ({ text: '{"topic":true,"category":"local","query":"street food festival"}' }) } })
    h.settings.homeArea = null
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'local_no_area' })
    expect(h.calls.search).toEqual([])
  })
  it('a news or notable query never gets the home area', async () => {
    const h = await make()
    await h.go()
    expect(h.calls.search).toEqual([QUERIES[0]])
  })
  it('repeat: another meeting cannot search the same query within 30 minutes, and can after', async () => {
    const same = async () => ({ text: '{"topic":true,"category":"news","query":"Formula One circuit news"}' })
    const h = await make({ sessions: [mac('mac_a')], deps: { topicModel: same } })
    expect(await h.go()).toMatchObject({ sessionId: 'mac_a', outcome: 'cue' })
    h.sessions[0].paused = true
    h.sessions.push(mac('mac_b'))
    await h.runner.tick()                                    // the second meeting becomes eligible now
    expect(await h.go()).toMatchObject({ sessionId: 'mac_b', outcome: 'no_cue', reason: 'rejected:repeat' })      // 5 minutes after the first
    expect(await h.go(20 * 60_000)).toMatchObject({ sessionId: 'mac_b', outcome: 'no_cue', reason: 'rejected:repeat' })  // 25 minutes
    expect(await h.go(11 * 60_000)).toMatchObject({ sessionId: 'mac_b', outcome: 'cue' })                         // 36 minutes
  })
  it('repeat: a meeting never searches the same query twice, however long it runs', async () => {
    const same = async () => ({ text: '{"topic":true,"category":"news","query":"Formula One circuit news"}' })
    const h = await make({ deps: { topicModel: same } })
    expect(await h.go()).toMatchObject({ outcome: 'cue' })
    expect(await h.go(40 * 60_000)).toMatchObject({ outcome: 'no_cue', reason: 'rejected:repeat' })
    expect(h.calls.search).toHaveLength(1)
  })
})

describe('caps', () => {
  it('cap: attemptsPerMeeting counts topic calls and stops the meeting before it spends Jev tokens', async () => {
    const h = await make({ limits: { attemptsPerMeeting: 2 } })
    await h.go(); await h.go()
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.calls).toMatchObject({ trigger: 2, topic: 2 })
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'capped', reason: 'meeting_attempts_cap', attempts: 2, cues: 2 })
  })
  it('cap: attempts that never emit a cue still count', async () => {
    const h = await make({ limits: { attemptsPerMeeting: 2 }, deps: { topicModel: async () => ({ text: '{"topic":false}' }) } })
    await h.go(); await h.go()
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.state().meetings.mac_1).toMatchObject({ attempts: 2, cues: 0 })
  })
  it('cap: maxCuesPerMeeting stops a meeting that has shown its cues', async () => {
    const h = await make({ limits: { maxCuesPerMeeting: 1 } })
    await h.go()
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.calls.trigger).toBe(1)
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'capped', reason: 'meeting_cues_cap', cues: 1 })
  })
  it('cap: dailyTopicCalls is shared by every meeting', async () => {
    const h = await make({ sessions: [mac('mac_a'), mac('mac_b')], limits: { dailyTopicCalls: 2 } })
    await h.go(); await h.go()
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.calls.topic).toBe(2)
    expect(h.runner.status('mac_a')).toMatchObject({ state: 'capped', reason: 'daily_topic_cap' })
  })
  it('cap: dailyWebSearches blocks the next attempt before the trigger or the topic call', async () => {
    const h = await make({ limits: { dailyWebSearches: 1 } })
    await h.go()
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.calls).toMatchObject({ trigger: 1, topic: 1 })
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'capped', reason: 'daily_search_cap' })
  })
  it('cap: a charge that finds the cap reached (another path spent it) stops the call', async () => {
    const h = await make({ limits: { dailyWebSearches: 1 } })
    h.settings.p = 0.9
    // The admission read sees room; the charge then finds the last search spent in between.
    const real = h.runner['store'].chargeSearch.bind(h.runner['store'])
    h.runner['store'].chargeSearch = (cap: number) => { h.writeState({ topicCalls: 1, webSearches: 1 }); return real(cap) }
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'cap:daily_cap' })
    expect(h.calls.search).toEqual([])
  })
  it('charge before call: the topic call and the search are paid in the durable file before they start', async () => {
    let atTopic: Record<string, unknown> | null = null, atSearch: Record<string, unknown> | null = null
    let hh: H
    const h = await make({ deps: {
      topicModel: async () => { atTopic = hh.state(); return { text: '{"topic":true,"category":"news","query":"Formula One circuit news"}' } },
      search: async () => { atSearch = hh.state(); return { sources: [SOURCE] } },
    } })
    hh = h
    await h.go()
    expect(atTopic).toMatchObject({ topicCalls: 1, webSearches: 0, meetings: { mac_1: { attempts: 1 } } })
    expect(atSearch).toMatchObject({ topicCalls: 1, webSearches: 1 })
  })
  it('cap: a charge that finds the topic cap reached (another path spent it) stops the call', async () => {
    const h = await make({ limits: { dailyTopicCalls: 1 } })
    const real = h.runner['store'].chargeTopic.bind(h.runner['store'])
    h.runner['store'].chargeTopic = (id: string, caps: { daily: number; perMeeting: number }) => { h.writeState({ topicCalls: 1, triggerCalls: 1 }); return real(id, caps) }
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'cap:daily_cap' })
    expect(h.calls.topic).toBe(0)
  })
  it('charge before call: a call that fails is still charged, never refunded', async () => {
    const h = await make({ deps: { topicModel: async () => { throw new Error('boom') } } })
    expect(await h.go()).toMatchObject({ outcome: 'failure' })
    expect(h.state()).toMatchObject({ topicCalls: 1, meetings: { mac_1: { attempts: 1 } } })
  })
  it('caps are durable: a new runner on the same file keeps the counts, and they are per local day', async () => {
    const h = await make({ limits: { attemptsPerMeeting: 1 } })
    await h.go()
    const again = h.fresh()
    expect(again.status('mac_1')).toMatchObject({ state: 'capped', attempts: 1, cues: 1 })
    expect(h.runner.generalCuesToday()).toMatchObject({ topicCalls: 1, webSearches: 1, breakerOpenUntil: null })
    h.clock.t += 36 * 3_600_000
    expect(h.runner.generalCuesToday()).toMatchObject({ topicCalls: 0, webSearches: 0 })
  })
  it('per-meeting counters expire after a day', async () => {
    const h = await make({ limits: { attemptsPerMeeting: 1 } })
    await h.go()
    h.clock.t += 23 * 3_600_000
    expect(h.runner.status('mac_1')).toMatchObject({ attempts: 1, cues: 1 })
    h.clock.t += 2 * 3_600_000
    expect(h.runner.status('mac_1')).toMatchObject({ attempts: 0, cues: 0 })
  })
  it('today reports the day, both counters and the breaker', async () => {
    const h = await make()
    await h.go()
    expect(h.runner.generalCuesToday()).toEqual({ day: new Intl.DateTimeFormat('en-CA', { timeZone: h.state().zone }).format(new Date(h.clock.t)), topicCalls: 1, webSearches: 1, breakerOpenUntil: null })
  })
})

describe('store', () => {
  const store = (statePath: string, now = () => Date.parse('2026-11-01T18:00:00Z')) => new G.GeneralCueStore(statePath, now)
  const path = () => { const d = mkdtempSync(join(tmpdir(), 'cues-general-store-')); dirs.push(d); return join(d, 'state.json') }
  it('charges a topic call against the daily cap and the meeting cap, refusing at the cap', () => {
    const s = store(path())
    expect(s.chargeTopic('a', { daily: 3, perMeeting: 2 })).toBe('ok')
    expect(s.chargeTopic('a', { daily: 3, perMeeting: 2 })).toBe('ok')
    expect(s.chargeTopic('a', { daily: 3, perMeeting: 2 })).toBe('meeting_cap')
    expect(s.chargeTopic('b', { daily: 3, perMeeting: 2 })).toBe('ok')
    expect(s.chargeTopic('b', { daily: 3, perMeeting: 2 })).toBe('daily_cap')
    expect(s.meeting('a')).toEqual({ attempts: 2, cues: 0 })
    expect(s.today()).toMatchObject({ topicCalls: 3 })
  })
  it('charges a Jev trigger against the daily cap, refusing at the cap', () => {
    const s = store(path())
    expect(s.chargeTrigger(2)).toBe('ok')
    expect(s.chargeTrigger(2)).toBe('ok')
    expect(s.chargeTrigger(2)).toBe('daily_cap')
  })
  it('charges a web search against the daily cap, refusing at the cap', () => {
    const s = store(path())
    expect(s.chargeSearch(2)).toBe('ok')
    expect(s.chargeSearch(2)).toBe('ok')
    expect(s.chargeSearch(2)).toBe('daily_cap')
    expect(s.today()).toMatchObject({ webSearches: 2 })
  })
  it('refuses every charge on an unreadable file', () => {
    const p = path()
    writeFileSync(p, 'garbage')
    const s = store(p)
    expect(s.chargeTopic('a', { daily: 9, perMeeting: 9 })).toBe('unreadable')
    expect(s.chargeSearch(9)).toBe('unreadable')
    expect(s.chargeTrigger(9)).toBe('unreadable')
    expect(s.recordCue('a')).toBe(false)
    expect(s.recordFailure('search')).toBe(false)
    expect(s.meeting('a')).toBeNull()
  })
  it('the state file is private: mode 0600', async () => {
    const { statSync } = await import('node:fs')
    const p = path()
    store(p).chargeSearch(5)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })
  it('a clean attempt writes nothing when there is no streak', () => {
    const p = path()
    const s = store(p)
    s.recordClean(4)
    expect(() => readFileSync(p, 'utf8')).toThrow()
  })
  it('records a cue for its meeting', () => {
    const s = store(path())
    expect(s.recordCue('a')).toBe(true)
    expect(s.meeting('a')).toEqual({ attempts: 0, cues: 1 })
  })
})

describe('trigger cap', () => {
  it('dailyTriggerCap: 300 by default, a whole number from 1 to 2000 from the environment, anything else is the default', () => {
    const cap = (v?: string) => G.dailyTriggerCap(v === undefined ? {} : { COS_LIVE_CUES_GENERAL_DAILY_TRIGGERS: v })
    expect(cap()).toBe(300)
    for (const v of ['1', '2', ' 40 ', '2000']) expect(cap(v), v).toBe(Number(v))
    for (const v of ['', '0', '2001', '-5', '1.5', 'abc', '10000', '1e3']) expect(cap(v), v).toBe(300)
    expect(G.GENERAL_TRIGGER_CAP).toMatchObject({ default: 300, min: 1, max: 2000, env: 'COS_LIVE_CUES_GENERAL_DAILY_TRIGGERS' })
  })
  it('the trigger is charged in the durable file BEFORE the request; the tokens are traced', async () => {
    let seen: Record<string, unknown> | null = null
    let hh: H
    const h = await make({ deps: { jevTrigger: async () => { seen = hh.state(); return { pGeneral: 0.1, tokens: 912 } } } })
    hh = h
    await h.go()
    expect(seen).toMatchObject({ triggerCalls: 1, topicCalls: 0 })
    expect(h.traces[0]).toMatchObject({ jevTokens: 912, reason: 'trigger_below' })
  })
  it('the cap stops the next tick before any Jev request, is shared by every meeting, and shows as capped', async () => {
    const h = await make({ sessions: [mac('mac_a'), mac('mac_b')], deps: { env: { COS_LIVE_CUES_GENERAL_DAILY_TRIGGERS: '2' } } })
    h.settings.p = 0.1
    await h.go(); await h.go()
    expect(h.calls.trigger).toBe(2)
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.calls.trigger).toBe(2)
    expect(h.runner.status('mac_a')).toMatchObject({ state: 'capped', reason: 'daily_trigger_cap' })
    expect(h.traces.at(-1)).toMatchObject({ outcome: 'skip', reason: 'daily_trigger_cap' })
  })
  it('the cap is durable (a new runner keeps it) and resets with the local day', async () => {
    const h = await make({ deps: { env: { COS_LIVE_CUES_GENERAL_DAILY_TRIGGERS: '1' } } })
    h.settings.p = 0.1
    await h.go()
    expect(h.fresh().status('mac_1')).toMatchObject({ state: 'capped', reason: 'daily_trigger_cap' })
    h.clock.t += 36 * 3_600_000
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'waiting' })
    expect(await h.go()).toMatchObject({ ran: true })
    expect(h.calls.trigger).toBe(2)
  })
  it('a charge that finds the cap reached stops the request (the store\'s own check)', async () => {
    const h = await make({ deps: { env: { COS_LIVE_CUES_GENERAL_DAILY_TRIGGERS: '1' } } })
    const real = h.runner['store'].chargeTrigger.bind(h.runner['store'])
    h.runner['store'].chargeTrigger = (cap: number) => { h.writeState({ triggerCalls: 1 }); return real(cap) }
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'cap:trigger_daily_cap' })
    expect(h.calls.trigger).toBe(0)
  })
  it('a legacy state file without the counter reads as zero; a damaged counter is unreadable', async () => {
    const h = await make()
    h.writeState({})
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'waiting' })
    h.writeState({ triggerCalls: -1 })
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'capped', reason: 'state_unreadable' })
    h.writeState({ triggerCalls: 'many' })
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'capped', reason: 'state_unreadable' })
  })
})

describe('fail closed', () => {
  it.each([
    ['unparseable file', () => 'not json {'],
    ['not an object', () => '[]'],
    ['wrong schema version', () => JSON.stringify({ v: 2, zone: 'UTC', day: '2026-11-01', topicCalls: 0, webSearches: 0, meetings: {}, breaker: { failures: 0, stage: 0, openUntil: null } })],
    ['a future day', () => JSON.stringify({ v: 1, zone: 'UTC', day: '2999-01-01', topicCalls: 0, webSearches: 0, meetings: {}, breaker: { failures: 0, stage: 0, openUntil: null } })],
    ['a negative count', () => JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-01', topicCalls: -1, webSearches: 0, meetings: {}, breaker: { failures: 0, stage: 0, openUntil: null } })],
    ['a fractional count', () => JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-01', topicCalls: 0.5, webSearches: 0, meetings: {}, breaker: { failures: 0, stage: 0, openUntil: null } })],
    ['an invalid zone', () => JSON.stringify({ v: 1, zone: 'Mars/Olympus', day: '2026-11-01', topicCalls: 0, webSearches: 0, meetings: {}, breaker: { failures: 0, stage: 0, openUntil: null } })],
    ['a damaged meeting entry (attempts)', () => JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-01', topicCalls: 0, webSearches: 0, meetings: { mac_1: { attempts: 'x', cues: 0, at: Date.parse('2026-11-01T18:00:00Z') } }, breaker: { failures: 0, stage: 0, openUntil: null } })],
    ['a damaged meeting entry (cues)', () => JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-01', topicCalls: 0, webSearches: 0, meetings: { mac_1: { attempts: 0, cues: -2, at: Date.parse('2026-11-01T18:00:00Z') } }, breaker: { failures: 0, stage: 0, openUntil: null } })],
    ['a damaged meeting entry (time)', () => JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-01', topicCalls: 0, webSearches: 0, meetings: { mac_1: { attempts: 0, cues: 0, at: 'now' } }, breaker: { failures: 0, stage: 0, openUntil: null } })],
    ['a damaged breaker', () => JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-01', topicCalls: 0, webSearches: 0, meetings: {}, breaker: { failures: 9, stage: 9, openUntil: null } })],
  ])('an unreadable state file (%s) means no call at all', async (_name, content) => {
    const h = await make()
    writeFileSync(h.statePath, content())
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.calls).toMatchObject({ trigger: 0, topic: 0, search: [], writer: 0 })
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'capped', reason: 'state_unreadable' })
    expect(h.runner.generalCuesToday()).toMatchObject({ topicCalls: Number.MAX_SAFE_INTEGER, webSearches: Number.MAX_SAFE_INTEGER })
  })
  it('a missing file is a fresh day, not an error', async () => {
    const h = await make()
    expect(() => h.state()).toThrow()
    expect(await h.go()).toMatchObject({ ran: true })
  })
  it('a state path that cannot be read as a file (a directory) also means no call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-general-dir-'))
    dirs.push(dir)
    const h = await make({ statePath: dir })
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.calls.trigger).toBe(0)
  })
  it.skipIf(process.getuid?.() === 0)('a state file that cannot be written means no call: the charge is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cues-general-ro-'))
    dirs.push(dir)
    chmodSync(dir, 0o500)
    const h = await make({ statePath: join(dir, 'nested', 'state.json') })
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'cap:trigger_write_failed' })
    expect(h.calls.topic).toBe(0)
  })
})

describe('breaker', () => {
  const searchFails = (): Partial<Deps> => ({ search: async () => ({ sources: [] }) })
  it('three consecutive failures open it for an hour, persisted; no further attempt starts', async () => {
    const h = await make({ deps: searchFails() })
    for (let i = 0; i < 3; i++) expect(await h.go()).toMatchObject({ outcome: 'failure', reason: 'search_no_sources' })
    const opened = h.state().breaker.openUntil
    expect(opened).toBe(h.clock.t + 3_600_000)
    expect(await h.go()).toMatchObject({ ran: false, why: 'blocked' })
    expect(h.calls.trigger).toBe(3)
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'breaker', reason: 'breaker_open' })
    expect(h.runner.generalCuesToday().breakerOpenUntil).toBe(opened)
  })
  it('breaker: open state survives a restart, and closes after the hour', async () => {
    const h = await make({ deps: searchFails() })
    for (let i = 0; i < 3; i++) await h.go()
    expect(h.fresh().status('mac_1')).toMatchObject({ state: 'breaker' })
    h.clock.t += 3_600_001
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'waiting' })
    h.sessions[0].transcriptChars += 5_000
    expect(await h.runner.tick()).toMatchObject({ ran: true })
    expect(h.state().breaker).toEqual({ failures: 1, stage: 3, openUntil: null })
  })
  it('two failures do not open it', async () => {
    const h = await make({ deps: searchFails() })
    await h.go(); await h.go()
    expect(h.state().breaker).toMatchObject({ failures: 2, openUntil: null })
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'waiting' })
  })
  it('a clean attempt that reaches the writer clears the streak', async () => {
    let fail = true
    const h = await make({ deps: { search: async () => ({ sources: fail ? [] : [SOURCE] }) } })
    await h.go(); await h.go()
    fail = false
    expect(await h.go()).toMatchObject({ outcome: 'cue' })
    expect(h.state().breaker).toMatchObject({ failures: 0, stage: 0 })
    fail = true
    await h.go(); await h.go()
    expect(h.state().breaker).toMatchObject({ failures: 2, openUntil: null })
  })
  it('a clean attempt that stops earlier does not clear a search streak: a Jev "no" says nothing about the search provider', async () => {
    const h = await make({ deps: searchFails() })
    await h.go(); await h.go()
    h.settings.p = 0.1
    expect(await h.go()).toMatchObject({ reason: 'trigger_below' })
    expect(h.state().breaker).toMatchObject({ failures: 2 })
    h.settings.p = 0.9
    await h.go()
    expect(h.state().breaker.openUntil).not.toBeNull()
  })
  it('an attempt deeper than the failed stage clears it', async () => {
    let boom = true
    const h = await make({ deps: { topicModel: async () => { if (boom) throw new Error('x'); return { text: '{"topic":false}' } } } })
    await h.go(); await h.go()
    boom = false
    expect(await h.go()).toMatchObject({ reason: 'no_topic' })
    expect(h.state().breaker).toMatchObject({ failures: 0 })
  })
  it('a provider quota error opens it at once', async () => {
    const h = await make({ deps: { topicModel: async () => { throw new LensGistLimitError('limit') } } })
    expect(await h.go()).toMatchObject({ outcome: 'failure', reason: 'quota' })
    expect(h.state().breaker.openUntil).toBe(h.clock.t + 3_600_000)
  })
  it('a search that throws is a failure at the search stage', async () => {
    const h = await make({ deps: { search: async () => { throw new Error('boom') } } })
    expect(await h.go()).toMatchObject({ outcome: 'failure', reason: 'search_error' })
    expect(h.state().breaker).toMatchObject({ failures: 1, stage: 3 })
  })
  it('a writer that throws is a failure at the writer stage; a writer that answers null is not', async () => {
    const h = await make({ deps: { writer: async () => { throw new Error('boom') } } })
    expect(await h.go()).toMatchObject({ outcome: 'failure', reason: 'writer_failed:error' })
    expect(h.state().breaker).toMatchObject({ failures: 1, stage: 4 })
    const n = await make({ deps: { writer: async () => ({ text: 'null' }) } })
    expect(await n.go()).toMatchObject({ outcome: 'no_cue', reason: 'writer_null' })
    expect(n.state().breaker.failures).toBe(0)
  })
  it('a writer that answers null clears a streak of writer failures: it got as deep as the stage that failed', async () => {
    let answer: string | Error = new Error('boom')
    const h = await make({ deps: { writer: async () => { if (answer instanceof Error) throw answer; return { text: answer } } } })
    await h.go(); await h.go()
    expect(h.state().breaker).toMatchObject({ failures: 2, stage: 4 })
    answer = 'null'
    expect(await h.go()).toMatchObject({ reason: 'writer_null' })
    expect(h.state().breaker).toMatchObject({ failures: 0, stage: 0 })
  })
  it('Jev\'s own cap, breaker or missing key is a quiet stop, not a failure', async () => {
    for (const error of [new JevError('jev_cap_reached'), new JevError('jev_breaker_open'), new JevError('jev_not_configured'), new DecisionProviderError('decision_cap_reached')]) {
      const h = await make({ deps: { jevTrigger: async () => { throw error } } })
      expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: error.code })
      expect(h.state()).toMatchObject({ topicCalls: 0, webSearches: 0, breaker: { failures: 0, openUntil: null } })
    }
  })
  it('any other Jev or decision error is a failure at the trigger stage', async () => {
    const h = await make({ deps: { jevTrigger: async () => { throw new JevError('jev_unavailable') } } })
    expect(await h.go()).toMatchObject({ outcome: 'failure', reason: 'trigger_failed:jev_unavailable' })
    expect(h.state().breaker).toMatchObject({ failures: 1, stage: 1 })
  })
})

describe('typed search', () => {
  const abort = () => new AbortController()
  const src = (url: string, id = 'W1') => ({ id, title: `T ${id}`, text: 'body', url })
  it('is ok with at least one https public source, and keeps only https public sources', async () => {
    const r = await G.typedGeneralSearch(async () => ({ sources: [src('http://example.org/a', 'W1'), src('https://10.0.0.1/x', 'W2'), src('https://example.org/b', 'W3'), { id: 'W0', title: 'summary', text: 'no url' }] }), 'q', abort().signal)
    expect(r).toEqual({ ok: true, sources: [{ id: 'W3', title: 'T W3', text: 'body', url: 'https://example.org/b' }] })
  })
  it('uses the cue log\'s https check: a trailing-dot local host and a non-default port are refused, a plain page is kept', async () => {
    const r = await G.typedGeneralSearch(async () => ({ sources: [src('https://printer.local./page', 'W1'), src('https://example.org:8443/x', 'W2'), src('https://localhost./x', 'W3'), src('https://example.org/ok', 'W4')] }), 'q', abort().signal)
    expect(r.ok && r.sources.map(x => x.id)).toEqual(['W4'])
  })
  it('no https source is a failure', async () => {
    expect(await G.typedGeneralSearch(async () => ({ sources: [src('http://example.org/a')] }), 'q', abort().signal)).toEqual({ ok: false, code: 'no_sources' })
    expect(await G.typedGeneralSearch(async () => ({ sources: [] }), 'q', abort().signal)).toEqual({ ok: false, code: 'no_sources' })
  })
  it('a throw is a failure', async () => {
    expect(await G.typedGeneralSearch(async () => { throw new Error('boom') }, 'q', abort().signal)).toEqual({ ok: false, code: 'error' })
  })
  it('the wall times out a search that never answers and aborts the signal it was given', async () => {
    let given: AbortSignal | null = null
    const r = await G.typedGeneralSearch((_q, signal) => { given = signal; return new Promise(() => {}) }, 'q', abort().signal, 20)
    expect(r).toEqual({ ok: false, code: 'timeout' })
    expect(given!.aborted).toBe(true)
  })
  it('the production wall is 60 s', () => { expect(G.LIVE_CUES_GENERAL_LIMITS.searchWallMs).toBe(60_000) })
  it('the caller\'s abort is aborted, not a failure, and reaches the search', async () => {
    const parent = abort()
    let given: AbortSignal | null = null
    const p = G.typedGeneralSearch((_q, signal) => { given = signal; return new Promise(() => {}) }, 'q', parent.signal)
    parent.abort()
    expect(await p).toEqual({ ok: false, code: 'aborted' })
    expect(given!.aborted).toBe(true)
    const done = abort(); done.abort()
    expect(await G.typedGeneralSearch(async () => ({ sources: [src('https://example.org/a')] }), 'q', done.signal)).toEqual({ ok: false, code: 'aborted' })
  })
  it('keeps at most five sources, cuts their text, redacts secrets, and drops duplicate urls', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `W${i + 1}`, title: 'sk-abcdefghijklmnop', text: 'x'.repeat(5_000), url: `https://example.org/${i % 7}` }))
    const r = await G.typedGeneralSearch(async () => ({ sources: many }), 'q', abort().signal)
    expect(r.ok && r.sources.length).toBe(5)
    expect(r.ok && r.sources[0].text.length).toBe(1_200)
    expect(r.ok && r.sources[0].title).toBe('sk-REDACTED')
  })
})

describe('search, writer and emit', () => {
  it('a writer that answers null emits nothing, and the attempt is still clean', async () => {
    const h = await make({ deps: { writer: async () => ({ text: 'null' }) } })
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'writer_null' })
    expect(h.emitted).toEqual([])
    expect(h.state().meetings.mac_1.cues).toBe(0)
  })
  it('number guard: a number the cited source lacks is withheld, never emitted', async () => {
    const h = await make({ deps: { writer: async () => ({ text: JSON.stringify({ headline: 'A new team joins', detail: 'The team will race 25 rounds.', sourceIds: ['W1'] }) }) } })
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'writer_unsupported_number' })
    expect(h.emitted).toEqual([])
  })
  it('the writer gets the query, the category, the https sources and only the last 1,000 characters of the room', async () => {
    let prompt = ''
    const h = await make({ sessions: [mac('mac_1', { text: 'z'.repeat(2_000) + ROOM })], deps: { writer: async (_s, p) => { prompt = p; return { text: 'null' } } } })
    await h.go()
    const p = JSON.parse(prompt)
    expect(p).toMatchObject({ query: QUERIES[0], category: 'news', sources: [{ id: 'W1', url: 'https://example.org/grid' }] })
    expect(p.context.length).toBe(1_000)
    expect(p.context.endsWith(ROOM)).toBe(true)
  })
  it('emit: hands the host one insight with https web sources, the admitted query and its category', async () => {
    const h = await make()
    const r = await h.go()
    expect(r).toMatchObject({ outcome: 'cue', reason: 'emitted' })
    expect(h.emitted).toHaveLength(1)
    const { sessionId, insight } = h.emitted[0]
    expect(sessionId).toBe('mac_1')
    expect(insight).toMatchObject({ headline: 'A new team joins the grid', category: 'news', query: QUERIES[0], windowAt: h.clock.t - 0 })
    expect(insight.sources).toEqual([{ id: `web_${createHash('sha256').update('https://example.org/grid').digest('hex').slice(0, 12)}`, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), title: 'Grid news', kind: 'web', url: 'https://example.org/grid' }])
    expect(insight).toMatchObject({ gate: 0.9 })
    expect('model' in insight).toBe(false)
    expect(h.state().meetings.mac_1).toMatchObject({ attempts: 1, cues: 1 })
  })
  it('emit: a host that does not emit is not counted as a cue', async () => {
    const h = await make()
    h.settings.accept = false
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'not_emitted' })
    expect(h.state().meetings.mac_1.cues).toBe(0)
  })
  it('stale: a cue older than 180 s from its window is dropped, never shown late', async () => {
    let hh: H
    const h = await make({ deps: { writer: async () => { hh.clock.t += 181_000; return { text: WRITTEN } } } })
    hh = h
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'stale' })
    expect(h.emitted).toEqual([])
  })
  it('stale: measured from the window, not from the last step (100 s of search plus 81 s of writer is late)', async () => {
    let hh: H
    const h = await make({ deps: {
      search: async () => { hh.clock.t += 100_000; return { sources: [SOURCE] } },
      writer: async () => { hh.clock.t += 81_000; return { text: WRITTEN } },
    } })
    hh = h
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'stale' })
  })
  it('stale: exactly 180 s is still fresh', async () => {
    let hh: H
    const h = await make({ deps: { writer: async () => { hh.clock.t += 180_000; return { text: WRITTEN } } } })
    hh = h
    expect(await h.go()).toMatchObject({ outcome: 'cue' })
  })
  it.each([
    ['mode switched to focused', (h: H) => { h.settings.mode = 'focused' }],
    ['the meeting turned legacy', (h: H) => { h.sessions[0].kindSet = 'legacy' }],
    ['the meeting was paused', (h: H) => { h.sessions[0].paused = true }],
    ['the meeting went away', (h: H) => { h.sessions.length = 0 }],
  ])('re-check before the search: %s while the topic call ran means no search', async (_name, change) => {
    let hh: H
    const h = await make({ deps: { topicModel: async () => { change(hh); return { text: '{"topic":true,"category":"news","query":"Formula One circuit news"}' } } } })
    hh = h
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'not_eligible' })
    expect(h.calls.search).toEqual([])
    expect(h.state().webSearches).toBe(0)
  })
  it.each([
    ['mode switched to focused', (h: H) => { h.settings.mode = 'focused' }],
    ['the meeting turned legacy', (h: H) => { h.sessions[0].kindSet = 'legacy' }],
    ['the meeting was paused', (h: H) => { h.sessions[0].paused = true }],
    ['the meeting went away', (h: H) => { h.sessions.length = 0 }],
  ])('re-check before emit: %s while the search ran means no insight', async (_name, change) => {
    let hh: H
    const h = await make({ deps: { search: async () => { change(hh); return { sources: [SOURCE] } } } })
    hh = h
    expect(await h.go()).toMatchObject({ outcome: 'no_cue', reason: 'not_eligible' })
    expect(h.emitted).toEqual([])
  })
  it('consent re-check before the search: Public topics withdrawn while the topic call ran cancels the attempt with consent_off, no search, no failure', async () => {
    let hh: H
    const h = await make({ deps: { topicModel: async () => { hh.settings.publicTopics = false; return { text: '{"topic":true,"category":"news","query":"Formula One circuit news"}' } } } })
    hh = h
    expect(await h.go()).toMatchObject({ outcome: 'cancelled', reason: 'consent_off' })
    expect(h.calls.search).toEqual([])
    expect(h.state()).toMatchObject({ webSearches: 0, breaker: { failures: 0, openUntil: null } })
  })
  it('consent re-check before emit: Public topics withdrawn while the search ran cancels with consent_off, nothing emitted', async () => {
    let hh: H
    const h = await make({ deps: { search: async () => { hh.settings.publicTopics = false; return { sources: [SOURCE] } } } })
    hh = h
    expect(await h.go()).toMatchObject({ outcome: 'cancelled', reason: 'consent_off' })
    expect(h.emitted).toEqual([])
    expect(h.state().breaker).toMatchObject({ failures: 0, openUntil: null })
  })
  it('consent withdrawn while a call is in flight: the next tick aborts the attempt with consent_off', async () => {
    const entered = gate()
    let signal: AbortSignal | null = null
    const h = await make({ deps: { search: (_q, s) => { signal = s; entered.release(); return new Promise((_r, reject) => s.addEventListener('abort', () => reject(new Error('aborted')))) } } })
    h.advance()
    const running = h.runner.tick()
    await entered.promise
    h.settings.publicTopics = false
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'busy' })
    expect(signal!.aborted).toBe(true)
    expect(await running).toMatchObject({ outcome: 'cancelled', reason: 'consent_off' })
  })
  it('consent that stays on lets an in-flight attempt finish', async () => {
    const entered = gate(), hold = gate()
    const h = await make({ deps: { search: async () => { entered.release(); await hold.promise; return { sources: [SOURCE] } } } })
    h.advance()
    const running = h.runner.tick()
    await entered.promise
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'busy' })
    hold.release()
    expect(await running).toMatchObject({ outcome: 'cue' })
  })
  it('the writer is sent the tail of the window that passed the sensitive check, not a fresh read of the room', async () => {
    let hh: H, prompt = ''
    const h = await make({ deps: {
      topicModel: async () => { hh.sessions[0].text += ' and then the mortgage payment came up with the lawyer'; return { text: '{"topic":true,"category":"news","query":"Formula One circuit news"}' } },
      writer: async (_s, p) => { prompt = p; return { text: 'null' } },
    } })
    hh = h
    await h.go()
    const context = JSON.parse(prompt).context as string
    expect(context).not.toMatch(/mortgage|lawyer/)
    expect(context).toBe(ROOM)
  })
})

describe('abort', () => {
  /** Runs the attempt to the search, holds it there, and hands back the signal the search was given. */
  async function holdAtSearch(over: Partial<Deps> = {}, sessions?: Sess[]) {
    const entered = gate()
    const seen: { signal: AbortSignal | null } = { signal: null }
    const h = await make({ sessions, deps: { search: (_q, signal) => { seen.signal = signal; entered.release(); return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }, ...over } })
    h.advance()
    const running = h.runner.tick()
    await entered.promise
    return { h, seen, running }
  }
  it('abort on mode change: modeChanged() stops the attempt in flight, and it is a cancel, not a failure', async () => {
    const { h, seen, running } = await holdAtSearch()
    h.settings.mode = 'focused'
    h.runner.modeChanged()
    expect(seen.signal!.aborted).toBe(true)
    expect(await running).toMatchObject({ ran: true, outcome: 'cancelled', reason: 'mode_changed' })
    expect(h.emitted).toEqual([])
    expect(h.state().breaker).toMatchObject({ failures: 0, openUntil: null })
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'mode_off' })
  })
  it('modeChanged() leaves the attempt alone while the mode still allows general cues', async () => {
    const { h, seen, running } = await holdAtSearch()
    h.settings.mode = 'all'
    h.runner.modeChanged()
    expect(seen.signal!.aborted).toBe(false)
    h.runner.abortAll()
    await running
  })
  it('a tick in focused mode also aborts the attempt in flight', async () => {
    const { h, seen, running } = await holdAtSearch()
    h.settings.mode = 'focused'
    expect(await h.runner.tick()).toMatchObject({ ran: false, why: 'mode_off' })
    expect(seen.signal!.aborted).toBe(true)
    expect(await running).toMatchObject({ outcome: 'cancelled' })
  })
  it('abortSession stops only that meeting\'s attempt (end, pause)', async () => {
    const { h, seen, running } = await holdAtSearch({}, [mac('mac_a'), mac('mac_b')])
    expect(h.runner.abortSession('mac_b')).toBe(false)
    expect(seen.signal!.aborted).toBe(false)
    expect(h.runner.abortSession('mac_a', 'paused')).toBe(true)
    expect(await running).toMatchObject({ outcome: 'cancelled', reason: 'paused', sessionId: 'mac_a' })
    expect(h.state().breaker.failures).toBe(0)
  })
  it('abortAll stops whatever is in flight (suspend), and reports nothing to stop when idle', async () => {
    const { h, running } = await holdAtSearch()
    expect(h.runner.abortAll('v2_off')).toBe(true)
    expect(await running).toMatchObject({ outcome: 'cancelled', reason: 'v2_off' })
    expect(h.runner.abortAll()).toBe(false)
    expect(h.runner.abortSession('mac_1')).toBe(false)
  })
  it('endSession aborts the attempt and forgets the meeting\'s queries', async () => {
    const { h, running } = await holdAtSearch()
    h.runner.endSession('mac_1')
    expect(await running).toMatchObject({ outcome: 'cancelled', reason: 'session_ended' })
  })
  it('an abort while the voice names are being read is a cancel, not names_unavailable', async () => {
    const entered = gate()
    const slow = { ...PROFILE, voiceProfileNames: () => { entered.release(); return new Promise<string[]>(() => {}) } }
    const h = await make({ deps: { profile: slow } })
    h.advance()
    const running = h.runner.tick()
    await entered.promise
    h.runner.abortAll('suspended')
    expect(await running).toMatchObject({ outcome: 'cancelled', reason: 'suspended' })
    expect(h.calls.trigger).toBe(0)
    expect(h.runner.status('mac_1')).toMatchObject({ state: 'waiting' })
  })
  it('stop() aborts the attempt in flight', async () => {
    const { h, seen, running } = await holdAtSearch()
    h.runner.stop()
    expect(seen.signal!.aborted).toBe(true)
    expect(await running).toMatchObject({ outcome: 'cancelled', reason: 'stopped' })
  })
  it('the single flight is released after a cancel, so the next tick can run', async () => {
    const { h, running } = await holdAtSearch()
    h.runner.abortAll()
    await running
    h.deps.search = async () => ({ sources: [SOURCE] })
    expect(await h.go()).toMatchObject({ ran: true })
  })
  it('a dependency that ignores its signal can never hold the single flight', async () => {
    const entered = gate()
    const h = await make({ deps: { topicModel: () => { entered.release(); return new Promise(() => {}) } } })
    h.advance()
    const running = h.runner.tick()
    await entered.promise
    h.runner.abortAll()
    expect(await running).toMatchObject({ outcome: 'cancelled' })
    expect(await h.runner.tick()).toMatchObject({ why: expect.not.stringMatching(/busy/) })
  })
  it('the whole attempt has a wall: a hung call becomes a failure at its stage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const entered = gate()
    const h = await make({ deps: { topicModel: () => { entered.release(); return new Promise(() => {}) } } })
    h.advance()
    const running = h.runner.tick()
    await entered.promise
    await vi.advanceTimersByTimeAsync(149_999)
    expect(h.inFlightNow()).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(await running).toMatchObject({ outcome: 'failure', reason: 'wall_timeout' })
    expect(h.state().breaker).toMatchObject({ failures: 1, stage: 2 })
  })
})

describe('trace', () => {
  it('writes one general_tick row per attempt with the contract fields and never the query or the room', async () => {
    const h = await make()
    await h.go()
    expect(h.traces).toHaveLength(1)
    const row = h.traces[0]
    expect(Object.keys(row).sort()).toEqual(['at', 'category', 'jevTokens', 'outcome', 'pGeneral', 'queryHash', 'reason', 'searchMs', 'sessionId', 'sourcesCount', 'type', 'usd', 'writerMs'])
    expect(row).toMatchObject({ type: 'general_tick', sessionId: 'mac_1', pGeneral: 0.9, outcome: 'cue', reason: 'emitted', category: 'news', sourcesCount: 1 })
    expect(row.queryHash).toBe(createHash('sha256').update('formula one circuit news').digest('hex').slice(0, 12))
    const text = JSON.stringify(h.traces)
    for (const word of ['Formula', 'circuit', 'grandstands', 'grid', 'constructor', 'example.org']) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase())
  })
  it('usd is the topic and writer model cost', async () => {
    const h = await make()
    await h.go()
    expect(h.traces[0].usd).toBe(0.003)
  })
  it('usd is null when no model reported a cost', async () => {
    const h = await make({ deps: { topicModel: async () => ({ text: '{"topic":false}' }) } })
    await h.go()
    expect(h.traces[0].usd).toBeNull()
  })
  it('a skip is traced once per reason per meeting every five minutes', async () => {
    const h = await make({ limits: { dailyTopicCalls: 0 } })
    await h.go()
    await h.go(60_000)
    expect(h.traces).toHaveLength(1)
    expect(h.traces[0]).toMatchObject({ outcome: 'skip', reason: 'daily_topic_cap', pGeneral: null, queryHash: null })
    await h.go(250_000)
    expect(h.traces).toHaveLength(2)
  })
  it('a trace that throws never breaks the attempt', async () => {
    const h = await make({ deps: { trace: () => { throw new Error('disk') } } })
    expect(await h.go()).toMatchObject({ outcome: 'cue' })
  })
})

describe('status', () => {
  it('waiting by default; null for a meeting the host does not list', async () => {
    const h = await make()
    expect(h.runner.status('mac_1')).toEqual({ state: 'waiting', cues: 0, attempts: 0 })
    expect(h.runner.status('nope')).toBeNull()
  })
  it('counts attempts and cues', async () => {
    const h = await make()
    await h.go(); await h.go()
    expect(h.runner.status('mac_1')).toEqual({ state: 'waiting', cues: 2, attempts: 2 })
  })
})

describe('real dependencies', () => {
  it('wiring: the topic call runs the claude runner pinned to Haiku, source live-cues-general-topic', async () => {
    mocks.engine.mockResolvedValue({ text: '{"topic":false}', usage: { costUsd: 0.002, inputTokens: 100, outputTokens: 10 }, model: 'claude-haiku-5-5' })
    const signal = new AbortController().signal
    const out = await G.runGeneralTopicModel('SYS', 'PROMPT', signal)
    expect(mocks.engine).toHaveBeenCalledWith('claude', 'claude-haiku-5-5', 'PROMPT', expect.objectContaining({ system: 'SYS', source: 'live-cues-general-topic', signal, timeoutMs: 20_000, maxOutputTokens: 150 }))
    expect(out).toEqual({ text: '{"topic":false}', costUsd: 0.002, inputTokens: 100, outputTokens: 10, model: 'claude-haiku-5-5' })
  })
  it('wiring: the topic model is the id the focused engine maps haiku to', () => {
    expect(G.GENERAL_TOPIC_MODEL).toBe(liveCuesV2Model({ COS_LIVE_CUES_V2_MODEL: 'haiku' } as NodeJS.ProcessEnv))
  })
  it('wiring: the writer runs the model it is given through the same runner, source live-cues-general', async () => {
    mocks.engine.mockResolvedValue({ text: 'null' })
    const signal = new AbortController().signal
    await G.runGeneralWriterModel('claude-sonnet-5-5', 'SYS', 'PROMPT', signal)
    expect(mocks.engine).toHaveBeenCalledWith('claude', 'claude-sonnet-5-5', 'PROMPT', expect.objectContaining({ system: 'SYS', source: 'live-cues-general', signal, timeoutMs: 20_000, maxOutputTokens: 400 }))
  })
  it('wiring: the search is ledgered as live_cues_general', async () => {
    mocks.search.mockResolvedValue({ sources: [], notices: [] })
    const signal = new AbortController().signal
    await G.runGeneralSearch('Formula One circuit news', signal)
    expect(mocks.search).toHaveBeenCalledWith('Formula One circuit news', signal, { auditCaller: 'live_cues_general' })
  })
  it('realGeneralDeps composes the three runners with the engine\'s trigger and writer model', async () => {
    mocks.engine.mockResolvedValue({ text: 'x' })
    mocks.search.mockResolvedValue({ sources: [], notices: [] })
    const trigger = vi.fn(async () => ({ pGeneral: 0.5, tokens: 1 }))
    const deps = G.realGeneralDeps({ jevTrigger: trigger, writerModel: () => 'claude-opus-x', statePath: '/tmp/x.json', now: () => 7 })
    expect(deps.jevTrigger).toBe(trigger)
    expect(deps.now()).toBe(7)
    expect(deps.statePath).toBe('/tmp/x.json')
    const signal = new AbortController().signal
    await deps.writer('S', 'P', signal)
    expect(mocks.engine).toHaveBeenLastCalledWith('claude', 'claude-opus-x', 'P', expect.objectContaining({ source: 'live-cues-general' }))
    await deps.topicModel('S', 'P', signal)
    expect(mocks.engine).toHaveBeenLastCalledWith('claude', 'claude-haiku-5-5', 'P', expect.objectContaining({ source: 'live-cues-general-topic' }))
    await deps.search('q', signal)
    expect(mocks.search).toHaveBeenLastCalledWith('q', signal, { auditCaller: 'live_cues_general' })
  })
})

// 6.97.8: every lookup the general cues hold back is counted in the daily web ledger where it is held back. (The search itself is
// counted inside searchMeetingWeb, tested in web-lookup-ledger-sites.test.ts.)
describe('web lookup ledger: withheld lookups', () => {
  async function ledgerFor(h: H) {
    const L = await import('./web-lookup-ledger.js')
    const ledger = new L.WebLookupLedger(join(h.dir, 'web-ledger.json'), () => h.clock.t)
    L.setWebLedgerForTests(ledger)
    return ledger
  }
  afterEach(async () => { (await import('./web-lookup-ledger.js')).setWebLedgerForTests(null) })
  it('a window with private-life vocabulary counts as personal, once per attempt', async () => {
    const h = await make({ sessions: [mac('mac_1', { text: 'we still owe the IRS and the mortgage payment' })] })
    const ledger = await ledgerFor(h)
    await h.go()
    expect(ledger.today().withheld).toEqual({ total: 1, byReason: { personal: 1 }, byFeature: { cues: 1, ask: 0, factCheck: 0 } })
    await h.go()
    expect(ledger.today().withheld.byReason.personal).toBe(2)
  })
  it('an admission rejection counts under its own reason code, and a clean search counts no withheld lookup', async () => {
    const reject = await make({ deps: { topicModel: async () => ({ text: JSON.stringify({ topic: true, category: 'news', query: 'Austin FC 2026 season' }) }) } })
    const ledger = await ledgerFor(reject)
    await reject.go()
    expect(ledger.today().withheld).toMatchObject({ total: 1, byReason: { rejected_digit: 1 }, byFeature: { cues: 1 } })
    const clean = await make()
    const ledger2 = await ledgerFor(clean)
    expect(await clean.go()).toMatchObject({ outcome: 'cue' })
    expect(ledger2.today().withheld.total).toBe(0)
  })
  it('a lookup that is held back for the home area counts as local_no_area', async () => {
    const h = await make({ deps: { topicModel: async () => ({ text: JSON.stringify({ topic: true, category: 'local', query: 'road closures' }) }) } })
    const ledger = await ledgerFor(h)
    h.settings.homeArea = null
    await h.go()
    expect(ledger.today().withheld.byReason).toEqual({ local_no_area: 1 })
  })
  it('a meeting that is not eligible (mode off) counts nothing: no lookup was proposed', async () => {
    const h = await make()
    const ledger = await ledgerFor(h)
    h.settings.mode = 'focused' as never
    await h.go()
    expect(ledger.today().withheld.total).toBe(0)
  })
})
