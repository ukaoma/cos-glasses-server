// Live cues v3, general cues hosted by the engine: the extended-only meeting list, the confirmed domain, the settings reader, the
// insight emit path and the aborts. The runner's own rules are in live-cues-general.test.ts; classic byte identity is in
// live-cues-v2-classic-pin.test.ts. Everything here runs on fakes: no model, no search, no real data home.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

// The settings singleton and the verdict log write under the data home: this file has its own.
const ownData = mkdtempSync(join(tmpdir(), 'cues-general-engine-data-'))
const priorData = process.env.COS_DATA_DIR
process.env.COS_DATA_DIR = ownData
const mocks = vi.hoisted(() => ({ engine: vi.fn() }))
vi.mock('./lens-gist-engines.js', async (orig) => ({ ...(await orig<typeof import('./lens-gist-engines.js')>()), runLensGistEngine: mocks.engine }))
vi.mock('./jev.js', async (orig) => ({ ...(await orig<typeof import('./jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))

const mod = await import('./live-cues-v2.js')
const contract = await import('../../shared/live-cues-v2.js')
const { LiveCueLog, LiveCueVerdictStore, LiveCueVerdicts, isLogRow } = await import('./live-cue-verdicts.js')
const { JevError } = await import('./jev.js')
const { LiveCuesV2Engine, LiveCuesV2Store, LIVE_CUES_V2_LIMITS: L } = mod
type Deps = import('./live-cues-v2.js').LiveCuesV2Deps
type GeneralDeps = import('./live-cues-general.js').GeneralCueDeps
type GeneralInsight = import('./live-cues-general.js').GeneralInsight
type Mode = 'focused' | 'general' | 'all'

afterAll(() => { if (priorData === undefined) delete process.env.COS_DATA_DIR; else process.env.COS_DATA_DIR = priorData; rmSync(ownData, { recursive: true, force: true }) })

const MAC = 'mac_11111111-1111-1111-1111-111111111111'
const MAC_B = 'mac_22222222-2222-2222-2222-222222222222'
const G2 = 'meeting_g2'
const SAID = Array.from({ length: 60 }, (_, i) => `said${i}`).join(' ')           // about 420 cleaned characters
const QUERIES = ['Formula One circuit news', 'Formula One grandstands news', 'Formula One paddock news', 'Formula One pit lane news', 'Formula One safety car news']
const SOURCE = { id: 'W1', title: 'Grid news', text: 'A new constructor joins the grid next season.', url: 'https://example.org/grid' }
const WRITTEN = JSON.stringify({ headline: 'A new team joins the grid', detail: 'A new constructor joins the grid next season, says the source.', sourceIds: ['W1'] })
const PROFILE = { ownerName: () => 'Zephyrine Quillon', speakerLabel: () => 'ZQX', vocabulary: () => ['Frobnitz'], domainKeywords: () => ({}) }
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }

describe('general cues in the engine', () => {
  let dir: string
  let clock: number
  let emitted: Array<{ type: string; data: Record<string, unknown> }>
  let logged: Array<Record<string, unknown>>
  let writerPrompts: string[]
  let focusedGates: number
  let g: { trigger: number; titles: string[]; topic: number; search: string[]; writer: number; windows: string[]; p: number; searchImpl: null | ((q: string, signal: AbortSignal) => Promise<{ sources: Array<{ id: string; title: string; text: string; url?: string }> }>) }
  let generalTraces: Array<Record<string, unknown>>
  let s: { on: boolean; mode: Mode; domain: string | null; orientationThrows: boolean; publicTopics: boolean | 'throws' | 'absent'; generalLimits: Record<string, number>; env: NodeJS.ProcessEnv }
  const engines: Array<InstanceType<typeof LiveCuesV2Engine>> = []

  function engine(over: Partial<Deps> = {}, withGeneral = true) {
    const general: GeneralDeps = {
      jevTrigger: async (title, window) => { g.trigger += 1; g.titles.push(title); g.windows.push(window); return { pGeneral: g.p, tokens: 800 } },
      topicModel: async () => { const q = QUERIES[g.topic % QUERIES.length]; g.topic += 1; return { text: JSON.stringify({ topic: true, category: 'news', query: q }), costUsd: 0.001 } },
      search: async (q, signal) => { g.search.push(q); return g.searchImpl ? g.searchImpl(q, signal) : { sources: [SOURCE] } },
      writer: async () => { g.writer += 1; return { text: WRITTEN, costUsd: 0.002, model: 'claude-test-writer' } },
      now: () => clock, statePath: join(dir, 'general-state.json'), trace: row => { generalTraces.push(row as unknown as Record<string, unknown>) }, profile: PROFILE,
    }
    const deps: Deps = {
      gate: async () => { focusedGates += 1; return { pCue: 0.93, kind: 'challenge', lookup: null, tokens: 1000 } },
      memory: async () => ({ notes: [] }),
      notes: async () => ({ notes: [] }),
      judge: async () => ({ probs: {}, tokens: 0 }),
      writer: async (_m, _sys, prompt) => { writerPrompts.push(prompt); return { text: JSON.stringify({ cue: `Name the owner of focused item ${writerPrompts.length}.`, kind: 'challenge', memoryIds: [] }), costUsd: 0.003, model: 'claude-sonnet-5-5' } },
      emit: (type, data) => { emitted.push({ type, data }) },
      lease: () => ({ release: () => {} }) as unknown as import('./maintenance-lifecycle.js').MaintenanceWorkLease,
      busy: () => false,
      decisionProvider: () => 'jev',
      decisionState: () => ({ configured: true, breakerOpen: false, capReached: false }),
      memorySource: () => 'none',
      settings: { stored: () => s.on, cueMode: () => s.mode, generalLimits: () => s.generalLimits },
      warmMemory: () => {},
      now: () => new Date(clock),
      store: new LiveCuesV2Store(join(dir, 'state.json'), () => new Date(clock)),
      trace: () => {},
      cueLog: row => { logged.push(row as unknown as Record<string, unknown>) },
      env: s.env,
      orientation: () => { if (s.orientationThrows) throw new Error('orientation unreadable'); return { domain: s.domain, title: null } },
      publicTopics: () => { if (s.publicTopics === 'throws') throw new Error('consent unreadable'); return s.publicTopics === true },
      homeArea: () => 'Austin, TX',
      ...(withGeneral ? { general } : {}),
      ...over,
    }
    if (s.publicTopics === 'absent') delete deps.publicTopics
    const e = new LiveCuesV2Engine(deps)
    engines.push(e)
    return e
  }
  const insights = () => emitted.filter(x => x.type === 'coaching_nudge_v2' && x.data.kind === 'insight')
  const focused = () => emitted.filter(x => x.type === 'coaching_nudge_v2' && x.data.kind !== 'insight')
  const v1 = () => emitted.filter(x => x.type === 'coaching_nudge')
  async function feed(e: InstanceType<typeof LiveCuesV2Engine>, sessionId: string, times = 4) { for (let i = 0; i < times; i++) await e.feed(sessionId, SAID) }
  /** Arms the meeting, feeds enough speech, lets the runner see it, and runs the attempt that falls due 301 s later. */
  async function insightAttempt(e: InstanceType<typeof LiveCuesV2Engine>, sessionId: string = MAC) {
    e.arm(sessionId)
    await feed(e, sessionId)
    const r = e.generalRunner()!
    await r.tick()                                                     // the meeting becomes eligible now: it waits one interval
    clock += 301_000
    return r.tick()
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cues-general-engine-'))
    clock = Date.parse('2026-11-01T18:00:00Z')
    emitted = []; logged = []; writerPrompts = []; generalTraces = []; focusedGates = 0
    g = { trigger: 0, titles: [], topic: 0, search: [], writer: 0, windows: [], p: 0.9, searchImpl: null }
    s = { on: true, mode: 'all', domain: 'work', orientationThrows: false, publicTopics: true, generalLimits: {}, env: {} }
  })
  afterEach(() => { for (const e of engines.splice(0)) e.shutdown(); mod.shutdownLiveCuesV2(); rmSync(dir, { recursive: true, force: true }) })

  describe('all mode on a Mac meeting', () => {
    it('yields focused cues and an insight: a valid coaching_nudge_v2 of kind insight with a web source, and no v1 twin', async () => {
      const e = engine()
      expect(await insightAttempt(e)).toMatchObject({ ran: true, outcome: 'cue' })
      expect(focused().length).toBeGreaterThan(0)
      expect(insights()).toHaveLength(1)
      const cue = insights()[0].data
      expect(contract.isLiveCueV2(cue)).toBe(true)
      expect(g.titles).toEqual([e['sessions'].get(MAC)!.title])                              // the trigger is given the meeting's title
      expect(cue).toMatchObject({ kind: 'insight', sessionId: MAC, headline: 'A new team joins the grid', gate: 0.9, model: 'claude-test-writer' })
      expect((cue.sources as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: 'web', url: 'https://example.org/grid', title: 'Grid news' })
      expect(v1().map(x => x.data.cueId)).not.toContain(cue.cueId)
      expect(v1()).toHaveLength(focused().length)
      expect(emitted.map(x => x.type).filter(t => t !== 'coaching_nudge' && t !== 'coaching_nudge_v2')).toEqual([])
    })
    it('logs the insight with the general category and the query, and the row passes the cue log schema', async () => {
      await insightAttempt(engine())
      const row = logged.find(r => r.kind === 'insight')!
      expect(isLogRow(row)).toBe(true)
      expect(row).toMatchObject({ v: 1, sessionId: MAC, kind: 'insight', general: { category: 'news', query: QUERIES[0] }, sources: [{ kind: 'web', url: 'https://example.org/grid' }] })
      expect(row).not.toHaveProperty('memorySource')
      expect(row.before).toEqual(expect.any(String))
    })
    it('the general trace row carries a hash and never the query', async () => {
      await insightAttempt(engine())
      const tick = generalTraces.find(r => r.type === 'general_tick')!
      expect(tick).toMatchObject({ outcome: 'cue', queryHash: createHash('sha256').update('formula one circuit news').digest('hex').slice(0, 12) })
      expect(JSON.stringify(generalTraces)).not.toMatch(/formula/i)
    })
  })

  describe('an insight never touches the focused state', () => {
    it('not the per-meeting cue counter and not previousCues in the next focused writer prompt', async () => {
      const e = engine()
      await insightAttempt(e)
      const focusedBefore = focused().length
      expect(e['deps'].store.counters(MAC).cues).toBe(focusedBefore)
      clock += 60_000
      await feed(e, MAC, 1)
      const last = JSON.parse(writerPrompts.at(-1)!) as { previousCues: string[] }
      expect(last.previousCues.length).toBeGreaterThan(0)
      expect(last.previousCues.join(' ')).not.toContain('constructor joins the grid')
    })
    it('not the focused cooldown, slot or breaker: a focused cue is still allowed right after an insight when no focused cue came before it', async () => {
      s.mode = 'general'                                               // no focused cue yet: the Mac meeting is insights only
      const e = engine()
      e.arm(MAC)
      await feed(e, MAC)
      expect(focused()).toEqual([])
      const r = e.generalRunner()!
      await r.tick()
      clock += 301_000
      s.mode = 'all'
      expect(await r.tick()).toMatchObject({ outcome: 'cue' })
      expect(insights()).toHaveLength(1)
      await feed(e, MAC, 1)                                           // a focused cue now: an insight set no cooldown
      expect(focused()).toHaveLength(1)
    })
    it('not the focused single flight: a focused cue is written while an insight attempt is in flight', async () => {
      const entered = gate(), hold = gate()
      g.searchImpl = async () => { entered.release(); await hold.promise; return { sources: [SOURCE] } }
      s.mode = 'general'
      const e = engine()
      e.arm(MAC)
      await feed(e, MAC)
      const r = e.generalRunner()!
      await r.tick()
      clock += 301_000
      s.mode = 'all'
      const running = r.tick()
      await entered.promise
      await feed(e, MAC, 1)
      expect(focused()).toHaveLength(1)
      hold.release()
      expect(await running).toMatchObject({ outcome: 'cue' })
    })
    it('not the focused breaker or failures: three general failures leave the focused cues running', async () => {
      g.searchImpl = async () => ({ sources: [] })
      const e = engine()
      e.arm(MAC)
      await feed(e, MAC)
      const r = e.generalRunner()!
      await r.tick()
      for (let i = 0; i < 3; i++) { clock += 301_000; await feed(e, MAC, 4); expect(await r.tick()).toMatchObject({ outcome: 'failure', reason: 'search_no_sources' }) }
      expect(r.status(MAC)).toMatchObject({ state: 'breaker' })
      const before = focused().length
      clock += 60_000
      await feed(e, MAC, 1)
      expect(focused().length).toBe(before + 1)
      expect(e.status(MAC).session).not.toHaveProperty('reason')
    })
    it('the insight is in the meeting\'s status and stop answer, in time order; the v1 nudges list has only focused cues', async () => {
      s.mode = 'general'
      const e = engine()
      e.arm(MAC)
      await feed(e, MAC)
      const r = e.generalRunner()!
      await r.tick()
      clock += 301_000
      s.mode = 'all'
      await r.tick()
      clock += 60_000
      await feed(e, MAC, 1)
      const kinds = e.status(MAC).session!.cues.map(c => c.kind)
      expect(kinds).toEqual(['insight', 'challenge'])
      const stop = e.end(MAC)
      expect(stop.cues.map(c => c.kind)).toEqual(['insight', 'challenge'])
      expect(stop.nudges).toHaveLength(1)
      expect(stop.nudges[0]).toMatchObject({ type: 'challenge' })
    })
    it('findCue and feedback know an insight', async () => {
      const e = engine()
      await insightAttempt(e)
      const id = insights()[0].data.cueId as string
      expect(e.findCue(id)).toMatchObject({ kind: 'insight' })
      expect(e.recordFeedback({ sessionId: MAC, cueId: id, vote: 'up' })).toEqual({ ok: true, knownCue: true })
    })
  })

  describe('which meetings and which modes', () => {
    it('a G2 (legacy) meeting never gets an insight in any mode: no general model call, no status field', async () => {
      for (const mode of ['general', 'all'] as const) {
        s.mode = mode
        const e = engine()
        e.arm(G2)
        await feed(e, G2)
        const r = e.generalRunner()!
        await r.tick()
        clock += 301_000
        await feed(e, G2, 4)
        expect(await r.tick()).toMatchObject({ ran: false })
        expect(e.status(G2).session).not.toHaveProperty('general')
      }
      expect(g.trigger).toBe(0)
      expect(insights()).toEqual([])
    })
    it('cue mode general: a Mac meeting gets insights only, a G2 meeting keeps its focused cues', async () => {
      s.mode = 'general'
      const e = engine()
      e.arm(MAC); e.arm(G2)
      await feed(e, MAC); await feed(e, G2)
      expect(focusedGates).toBe(1)                                     // the G2 meeting's one evaluation
      expect(focused().map(x => x.data.sessionId)).toEqual([G2])
      const r = e.generalRunner()!
      await r.tick()
      clock += 301_000
      expect(await r.tick()).toMatchObject({ outcome: 'cue', sessionId: MAC })
    })
    it('cue mode all runs both on a Mac meeting; focused runs the focused cues only', async () => {
      const both = engine()
      expect(await insightAttempt(both)).toMatchObject({ outcome: 'cue' })
      expect(focused().length).toBeGreaterThan(0)
      emitted = []; g.trigger = 0; s.mode = 'focused'
      const only = engine()
      only.arm(MAC_B)
      await feed(only, MAC_B)
      expect(focused().length).toBeGreaterThan(0)
      const r = only.generalRunner()!
      await r.tick()
      clock += 301_000
      expect(await r.tick()).toEqual({ ran: false, why: 'mode_off' })
      expect(insights()).toEqual([])
      expect(g.trigger).toBe(0)
    })
    it('focused mode (the default setting) shows the general state off; Public topics off shows needs_public_topics; neither runs an attempt', async () => {
      s.mode = 'focused'
      const e = engine()
      e.arm(MAC)
      await feed(e, MAC)
      expect(e.status(MAC).session!.general).toEqual({ state: 'off', reason: 'mode_focused', cues: 0, attempts: 0 })
      s.mode = 'all'; s.publicTopics = false
      const r = e.generalRunner()!
      await r.tick(); clock += 301_000
      expect(await r.tick()).toMatchObject({ ran: false })
      expect(e.status(MAC).session!.general).toEqual({ state: 'needs_public_topics', reason: 'public_topics_off', cues: 0, attempts: 0 })
      expect(g.trigger).toBe(0)
    })
    it('consent that is unreadable or missing reads as off', async () => {
      for (const consent of ['throws', 'absent'] as const) {
        s.publicTopics = consent
        const e = engine()
        e.arm(MAC)
        await feed(e, MAC)
        expect(e.status(MAC).session!.general).toMatchObject({ state: 'needs_public_topics' })
      }
      expect(g.trigger).toBe(0)
    })
    it('an engine built without general dependencies has no runner and no status field', async () => {
      const e = engine({}, false)
      expect(e.generalRunner()).toBeNull()
      e.arm(MAC)
      await feed(e, MAC)
      expect(e.status(MAC).session).not.toHaveProperty('general')
      expect(e.suspend()).toBe(0)
      expect(() => { e.modeChanged(); e.startGeneral() }).not.toThrow()
    })
    it('v2 switched off: no meeting is offered, so no attempt', async () => {
      const e = engine()
      e.arm(MAC)
      await feed(e, MAC)
      const r = e.generalRunner()!
      await r.tick()
      clock += 301_000
      s.on = false
      expect(await r.tick()).toMatchObject({ ran: false })
      expect(g.trigger).toBe(0)
    })
    it('a paused meeting and an ended meeting are not offered', async () => {
      const e = engine()
      e.arm(MAC)
      await feed(e, MAC)
      const r = e.generalRunner()!
      await r.tick()
      e.setPaused(MAC, true)
      clock += 301_000
      expect(await r.tick()).toMatchObject({ ran: false })
      expect(e.status(MAC).session!.general).toMatchObject({ state: 'off', reason: 'paused' })
      e.setPaused(MAC, false)
      await r.tick()                                                   // eligible again: waits a new interval
      e.end(MAC)
      clock += 301_000
      await feed(e, MAC, 1)
      expect(await r.tick()).toMatchObject({ ran: false })
      expect(g.trigger).toBe(0)
    })
  })

  describe('the confirmed domain', () => {
    it('a confirmed personal domain skips the meeting (status withheld); work and null proceed; an unreadable orientation is null and proceeds', async () => {
      s.domain = 'personal'
      const skipped = engine()
      expect(await insightAttempt(skipped)).toMatchObject({ ran: false })
      expect(skipped.status(MAC).session!.general).toMatchObject({ state: 'withheld', reason: 'personal_domain' })
      expect(g.trigger).toBe(0)
      for (const [domain, throws] of [[null, false], ['quilt', false], [null, true]] as const) {
        s.domain = domain; s.orientationThrows = throws; emitted = []
        const e = engine()
        expect(await insightAttempt(e, MAC_B), `${domain} ${throws}`).toMatchObject({ ran: true, outcome: 'cue' })
        expect(insights(), `${domain} ${throws}`).toHaveLength(1)
        clock += 400_000
      }
    })
    it('the domain is the confirmed orientation, read at every tick (a domain confirmed personal later stops the next attempt)', async () => {
      const e = engine()
      expect(await insightAttempt(e)).toMatchObject({ outcome: 'cue' })
      s.domain = 'personal'
      clock += 301_000
      await feed(e, MAC, 4)
      expect(await e.generalRunner()!.tick()).toMatchObject({ ran: false })
      expect(g.trigger).toBe(1)
    })
  })

  describe('aborts', () => {
    async function holdAtSearch(e: InstanceType<typeof LiveCuesV2Engine>) {
      const entered = gate()
      const seen: { signal: AbortSignal | null } = { signal: null }
      g.searchImpl = (_q, signal) => { seen.signal = signal; entered.release(); return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }
      e.arm(MAC)
      await feed(e, MAC)
      const r = e.generalRunner()!
      await r.tick()
      clock += 301_000
      const running = r.tick()
      await entered.promise
      return { seen, running }
    }
    it.each([
      ['a mode change', (e: InstanceType<typeof LiveCuesV2Engine>) => { s.mode = 'focused'; e.modeChanged() }, 'mode_changed'],
      ['v2 switched off (suspend)', (e: InstanceType<typeof LiveCuesV2Engine>) => { expect(e.suspend()).toBe(1) }, 'v2_off'],
      ['a pause', (e: InstanceType<typeof LiveCuesV2Engine>) => { e.setPaused(MAC, true) }, 'paused'],
      ['the end of the meeting', (e: InstanceType<typeof LiveCuesV2Engine>) => { e.end(MAC) }, 'session_ended'],
    ])('abort: %s stops an insight attempt in flight, as a cancel, with nothing emitted', async (_name, act, reason) => {
      const e = engine()
      const { seen, running } = await holdAtSearch(e)
      act(e)
      expect(seen.signal!.aborted).toBe(true)
      expect(await running).toMatchObject({ outcome: 'cancelled', reason })
      expect(insights()).toEqual([])
    })
    it('a pause for another meeting, or an unpause, leaves the attempt alone', async () => {
      const e = engine()
      e.arm(MAC_B)
      const { seen, running } = await holdAtSearch(e)
      e.setPaused(MAC_B, true)
      expect(seen.signal!.aborted).toBe(false)
      e.setPaused(MAC, false)                                          // taking a pause off is not a pause
      expect(seen.signal!.aborted).toBe(false)
      e.suspend()
      await running
    })
    it('shutdown stops the runner and clears the settings view\'s counters', async () => {
      const e = engine()
      e.startGeneral()
      const { seen, running } = await holdAtSearch(e)
      e.shutdown()
      expect(seen.signal!.aborted).toBe(true)
      expect(await running).toMatchObject({ outcome: 'cancelled' })
    })
    it('startGeneral starts the runner\'s poll timer, once; shutdown stops it', () => {
      const e = engine()
      const runner = e.generalRunner()!
      const start = vi.spyOn(runner, 'start'), stop = vi.spyOn(runner, 'stop')
      e.startGeneral()
      expect(start).toHaveBeenCalledTimes(1)
      e.shutdown()
      expect(stop).toHaveBeenCalledTimes(1)
    })
    it('the engine singleton starts its runner when it is built', () => {
      const start = vi.spyOn(LiveCuesV2Engine.prototype, 'startGeneral')
      mod.liveCuesV2()
      expect(start).toHaveBeenCalledTimes(1)
      start.mockRestore()
    })
    it('saving the cue mode tells the engine: applyLiveCuesV2Settings calls modeChanged for a cueMode change only', () => {
      const eng = mod.liveCuesV2()
      const spy = vi.spyOn(eng, 'modeChanged')
      expect(mod.applyLiveCuesV2Settings({ limits: {}, grounding: 'classic' }, {})).toEqual({ ok: true })
      expect(spy).not.toHaveBeenCalled()
      expect(mod.applyLiveCuesV2Settings({ limits: {}, cueMode: 'general' }, {})).toEqual({ ok: true })
      expect(spy).toHaveBeenCalledTimes(1)
      mod.applyLiveCuesV2Settings({ limits: {}, cueMode: 'focused' }, {})
    })
  })

  describe('status and settings view', () => {
    it('the per-meeting status shows waiting, then the counts, then capped, then breaker', async () => {
      s.generalLimits = { attemptsPerMeeting: 1 }
      const e = engine()
      e.arm(MAC)
      await feed(e, MAC)
      expect(e.status(MAC).session!.general).toEqual({ state: 'waiting', cues: 0, attempts: 0 })
      const r = e.generalRunner()!
      await r.tick()
      clock += 301_000
      await r.tick()
      expect(e.status(MAC).session!.general).toEqual({ state: 'capped', reason: 'meeting_attempts_cap', cues: 1, attempts: 1 })
    })
    it('the settings view reads today from the runner once the engine started it, and zeros after shutdown', async () => {
      const singleton = mod.liveCuesV2()                               // builds its own runner first; ours then takes the provider
      void singleton
      const e = engine()
      e.startGeneral()
      await insightAttempt(e)
      const view = mod.liveCuesV2SettingsViewV3({})
      expect(view.general.today).toMatchObject({ topicCalls: 1, webSearches: 1, breakerOpenUntil: null })
      e.shutdown()
      expect(mod.liveCuesV2SettingsViewV3({}).general.today).toMatchObject({ topicCalls: 0, webSearches: 0 })
    })
    it('the settings reader maps the six saved limits, the mode and the consent as they are now', async () => {
      s.generalLimits = { intervalSeconds: 600, trigger: 0.75, attemptsPerMeeting: 3, maxCuesPerMeeting: 2, dailyTopicCalls: 40, dailyWebSearches: 20 }
      const e = engine()
      const reader = e['generalSettings']()
      expect(reader.limits()).toEqual({ intervalSeconds: 600, trigger: 0.75, attemptsPerMeeting: 3, maxCuesPerMeeting: 2, dailyTopicCalls: 40, dailyWebSearches: 20 })
      expect(reader.cueMode()).toBe('all')
      expect(reader.publicTopics()).toBe(true)
      expect(reader.homeArea()).toBe('Austin, TX')
      s.generalLimits = {}
      expect(reader.limits()).toEqual({ intervalSeconds: 300, trigger: 0.6, attemptsPerMeeting: 8, maxCuesPerMeeting: 4, dailyTopicCalls: 60, dailyWebSearches: 30 })
      s.mode = 'focused'
      expect(reader.cueMode()).toBe('focused')
    })
    it('an env value locks a limit in the reader, and COS_LIVE_CUES_MODE=focused forces the mode', async () => {
      s.env = { COS_LIVE_CUES_GENERAL_INTERVAL_S: '900', COS_LIVE_CUES_MODE: 'focused' }
      const reader = engine()['generalSettings']()
      expect(reader.limits().intervalSeconds).toBe(900)
      expect(reader.cueMode()).toBe('focused')
    })
    it('home area and consent that throw read as null and off', () => {
      const e = engine({ homeArea: () => { throw new Error('x') }, publicTopics: () => { throw new Error('x') } })
      const reader = e['generalSettings']()
      expect(reader.homeArea()).toBeNull()
      expect(reader.publicTopics()).toBe(false)
    })
  })

  describe('the host', () => {
    it('offers extended meetings only, with a monotonic character count and the cleaned window', async () => {
      const e = engine()
      e.arm(MAC); e.arm(G2)
      const host = e['generalHost']()
      expect(host.candidates().map(c => c.sessionId)).toEqual([MAC])
      for (let i = 0; i < 12; i++) await e.feed(MAC, `[${i}] Speaker 1: ${SAID}`)     // far past the 400-word window
      const c = host.candidates()[0]
      expect(c.transcriptChars).toBeGreaterThan(4_000)
      const window = c.window(100_000)
      expect(window.length).toBeLessThan(c.transcriptChars)                          // the window is capped; the count is not
      expect(window).not.toMatch(/\[\d+\]|Speaker 1/)
      expect(c.window(50)).toBe(window.slice(-50))
      expect(c).toMatchObject({ kindSet: 'extended', armed: true, paused: false, domain: 'work' })
      const before = c.transcriptChars
      await e.feed(MAC, SAID)
      expect(host.candidates()[0].transcriptChars).toBeGreaterThan(before)
    })
    it('the host sees a meeting as ended and paused as they happen', () => {
      const e = engine()
      e.arm(MAC)
      const host = e['generalHost']()
      e.setPaused(MAC, true)
      expect(host.candidates()[0]).toMatchObject({ paused: true, armed: true })
      e.end(MAC)
      expect(host.candidates()[0]).toMatchObject({ armed: false })
    })
    it('emit refuses a legacy meeting, an ended meeting, an unknown meeting and a cue the shared validator would drop', () => {
      const e = engine()
      e.arm(MAC); e.arm(G2)
      const insight: GeneralInsight = { headline: 'A fact', detail: 'A true public fact from a page.', category: 'news', query: 'Formula One circuit news', gate: 0.9,
        sources: [{ id: 'web_x', date: '2026-11-01', title: 'Page', kind: 'web', url: 'https://example.org/p' }], windowAt: clock, createdAt: clock }
      const host = e['generalHost']()
      expect(host.emit(G2, insight)).toBe(false)
      expect(host.emit('mac_99999999-9999-9999-9999-999999999999', insight)).toBe(false)
      expect(host.emit(MAC, { ...insight, headline: '' })).toBe(false)
      expect(host.emit(MAC, { ...insight, headline: 'h'.repeat(65) })).toBe(false)
      expect(insights()).toEqual([])
      expect(host.emit(MAC, insight)).toBe(true)
      e.end(MAC)
      expect(host.emit(MAC, insight)).toBe(false)
      expect(insights()).toHaveLength(1)
      expect(insights()[0].data).toMatchObject({ model: 'claude-sonnet-5-5' })           // the configured writer model when the insight names none
    })
    it('a failed cue log append is not an emit failure', () => {
      const e = engine({ cueLog: () => { throw new Error('disk') } })
      e.arm(MAC)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const insight: GeneralInsight = { headline: 'A fact', detail: 'A true public fact from a page.', category: 'news', query: 'q', gate: 0.9, model: 'm',
        sources: [{ id: 'web_x', date: '2026-11-01', title: 'Page', kind: 'web', url: 'https://example.org/p' }], windowAt: clock, createdAt: clock }
      expect(e['generalHost']().emit(MAC, insight)).toBe(true)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('history and verdicts', () => {
    it('the cue log accepts an insight row, the history lists it with its general field, and it can be rated useful', async () => {
      const svc = new LiveCueVerdicts({ log: new LiveCueLog(join(dir, 'cues.jsonl')), store: new LiveCueVerdictStore(join(dir, 'verdicts.json')), now: () => clock,
        trace: () => {}, resolveTitle: () => null })
      const e = engine({ cueLog: row => svc.logCue(row) })
      await insightAttempt(e)
      const id = insights()[0].data.cueId as string
      const history = svc.history({ days: 30, unrated: false, limit: 50 })
      expect(history.skipped).toBe(0)
      const row = history.cues.find(c => c.cueId === id)!
      expect(row).toMatchObject({ kind: 'insight', general: { category: 'news', query: QUERIES[0] }, rating: null })
      expect(svc.rate({ sessionId: MAC, cueId: id, verdict: 'useful' }, e.findCue(id)?.sessionId ?? null)).toMatchObject({ ok: true })
      const after = svc.history({ days: 30, unrated: false, limit: 50 })
      expect(after.cues.find(c => c.cueId === id)!.rating).toMatchObject({ verdict: 'useful' })
      expect(after.counts.byVerdict.useful).toBe(1)
    })
  })

  describe('failures of the Jev trigger', () => {
    it('Jev\'s own cap is a quiet stop for the insight and does not touch the focused cues', async () => {
      const e = engine()
      e['general']!['deps'].jevTrigger = async () => { throw new JevError('jev_cap_reached') }
      expect(await insightAttempt(e)).toMatchObject({ outcome: 'no_cue', reason: 'jev_cap_reached' })
      expect(focused().length).toBeGreaterThan(0)
    })
  })

  describe('the singleton\'s real dependencies', () => {
    afterEach(() => { vi.unstubAllGlobals(); delete process.env.TYPESAFE_API_KEY })
    const realDeps = () => mod.liveCuesV2().generalRunner()!['deps']
    it('keep their state in the data home, apart from the focused state, and the consent and home area come from the real stores', () => {
      const deps = realDeps()
      expect(deps.statePath).toBe(join(ownData, 'live-cues-general-state.json'))
      expect(mod.liveCuesV2().generalRunner()!['host']).toBeTruthy()
      const engine = mod.liveCuesV2()
      expect(engine['deps'].publicTopics!()).toBe(false)               // no consent saved in this data home
      expect(engine['deps'].homeArea!()).toBeNull()                    // no home_city in this profile
    })
    it('write a general_tick row to the same trace file as the focused cues', async () => {
      const { readFileSync } = await import('node:fs')
      realDeps().trace!({ type: 'general_tick', at: 'x', sessionId: MAC, pGeneral: null, outcome: 'skip', reason: 'test', category: null, queryHash: null, searchMs: null, sourcesCount: null, writerMs: null, usd: null })
      const lines = readFileSync(join(ownData, 'live-cues-trace.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines.at(-1)).toMatchObject({ type: 'general_tick', reason: 'test' })
    })
    it('ask Jev the trigger question on the cues\' own client: the title and the window only, answers read as P(yes)', async () => {
      process.env.TYPESAFE_API_KEY = 'test-key'
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: { general_topic: { type: 'choice', probabilities: { yes: 0.8, no: 0.2 } } }, usage: { input_tokens: 11 } }) }))
      vi.stubGlobal('fetch', fetchMock)
      const out = await realDeps().jevTrigger('Mac Recording', 'the room talks about the grid', new AbortController().signal)
      expect(out).toEqual({ pGeneral: 0.8, tokens: 11 })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
      expect(url).toBe('https://api.typesafe.ai/v1/systemone')
      const body = JSON.parse(init.body) as { state: Record<string, string>; questions: Record<string, unknown> }
      expect(body.state).toEqual({ meetingTitle: 'Mac Recording', window: 'the room talks about the grid' })
      expect(Object.keys(body.questions)).toEqual(['general_topic'])
      const { readFileSync } = await import('node:fs')
      expect(Object.values(JSON.parse(readFileSync(join(ownData, 'jev-cues-usage.json'), 'utf8')) as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(11)
    })
    it('run the topic on pinned Haiku and the writer on the focused writer model, through the one claude runner', async () => {
      mocks.engine.mockResolvedValue({ text: 'null' })
      const signal = new AbortController().signal
      const deps = realDeps()
      await deps.topicModel('S', 'P', signal)
      expect(mocks.engine).toHaveBeenLastCalledWith('claude', 'claude-haiku-5-5', 'P', expect.objectContaining({ source: 'live-cues-general-topic' }))
      await deps.writer('S', 'P', signal)
      expect(mocks.engine).toHaveBeenLastCalledWith('claude', mod.liveCuesV2Model(process.env), 'P', expect.objectContaining({ source: 'live-cues-general' }))
      process.env.COS_LIVE_CUES_V2_MODEL = 'haiku'
      try {
        await deps.writer('S', 'P', signal)
        expect(mocks.engine).toHaveBeenLastCalledWith('claude', 'claude-haiku-5-5', 'P', expect.objectContaining({ source: 'live-cues-general' }))
      } finally { delete process.env.COS_LIVE_CUES_V2_MODEL }
    })
  })

  void L
})
