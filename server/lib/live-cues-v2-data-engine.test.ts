// The Tableau data arm in the engine: when it is offered, when it is off and why the trace says so, what the judge and the writer
// are given, and what reaches the cue, the cue log and the stream. The pure parts are in live-cues-v2-data.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./jev.js', async (orig) => ({ ...(await orig<typeof import('./jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))

const mod = await import('./live-cues-v2.js')
const contract = await import('../../shared/live-cues-v2.js')
const dataMod = await import('./live-cues-v2-data.js')
const { isLogRow } = await import('./live-cue-verdicts.js')
const { rawFacts, rawSourceFacts } = await import('./__fixtures__/live-cues-v2-data-fixture.js')
const { LiveCuesV2Engine, LiveCuesV2Store, LIVE_CUES_V2_LIMITS: L, liveCuesV2WriterSystem } = mod
type Deps = import('./live-cues-v2.js').LiveCuesV2Deps
type MemoryNote = import('./live-cues-v2.js').MemoryNote

const SAID = Array.from({ length: 60 }, (_, i) => `said${i}`).join(' ')
const OTHER_TOPIC = ' overage pricing renewal contract Harborview quarter'
const SBU_TOPIC = ' SBU closed at 120% of MRR budget, 148 vs 131 locations'
const note = (id: string): MemoryNote => ({ id, date: '2026-10-01', title: `Past ${id}`, notes: `Summary: ${id} text`, key: `2026-10-01|past ${id.toLowerCase()}` })

describe('the Tableau data arm in the engine', () => {
  let dir: string
  let clock: number
  let emitted: Array<{ type: string; data: Record<string, unknown> }>
  let traces: Array<Record<string, unknown>>
  let logged: Array<Record<string, unknown>>
  let judged: string[][]
  let judgedNotes: Array<Array<{ id: string; title: string; notes: string }>>
  let systems: string[]
  let prompts: string[]
  let factsCalls: number
  let read: () => import('./live-cues-v2-data.js').DataFactsRead
  let yes: Record<string, number>
  let orientation: { domain: string | null; title: string | null }
  let grounding: 'classic' | 'grounded'
  let cueMemoryNotes: MemoryNote[]
  let writerText: string
  const env: NodeJS.ProcessEnv = { COS_LIVE_CUES_V2: '1' }

  const okRead = (over: Record<string, unknown> = {}) => () => dataMod.parseDataFacts(rawFacts(over), clock)

  function engine(over: Partial<Deps> = {}) {
    const deps: Deps = {
      gate: async () => ({ pCue: 0.93, kind: 'challenge', lookup: null, tokens: 1000 }),
      memory: async () => ({ notes: cueMemoryNotes }),
      notes: async () => ({ notes: [] }),
      judge: async () => ({ probs: { M1: 0.9, none: 0.1 }, tokens: 900 }),
      judgeB: async (_t, _w, cands) => {
        judged.push(cands.map(c => c.id)); judgedNotes.push(cands.map(c => ({ id: c.id, title: c.title, notes: c.notes })))
        return { yes: Object.fromEntries(cands.map(c => [c.id, yes[c.id] ?? 0])), same: {}, tokens: 2300 }
      },
      files: () => [],
      orientation: () => orientation,
      dataFacts: () => { factsCalls++; return read() },
      writer: async (_m, system, prompt) => { systems.push(system); prompts.push(prompt); return { text: writerText, costUsd: 0.003, model: 'claude-sonnet-5-5' } },
      emit: (type, data) => {
        if (type === 'coaching_nudge_v2') expect(contract.isLiveCueV2(data), 'every emitted v2 cue passes the shared validator').toBe(true)
        emitted.push({ type, data })
      },
      lease: () => ({ release: () => {} }) as unknown as import('./maintenance-lifecycle.js').MaintenanceWorkLease,
      busy: () => false,
      decisionProvider: () => 'jev',
      decisionState: () => ({ configured: true, breakerOpen: false, capReached: false }),
      memorySource: () => 'cue_memory',
      settings: { stored: () => null, grounding: () => grounding },
      warmMemory: () => {},
      now: () => new Date(clock),
      store: new LiveCuesV2Store(join(dir, 'state.json'), () => new Date(clock)),
      trace: row => { traces.push(row) },
      cueLog: row => { logged.push(row as unknown as Record<string, unknown>) },
      env,
      ...over,
    }
    return new LiveCuesV2Engine(deps)
  }
  const evaluation = () => traces.filter(t => t.kind === 'evaluation').at(-1)!
  async function feed(topic: string, e = engine()) { e.arm('meeting_a'); await e.feed('meeting_a', SAID + topic); return e }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cues-v2-data-'))
    clock = Date.parse('2026-11-02T21:30:00Z')
    emitted = []; traces = []; logged = []; judged = []; judgedNotes = []; systems = []; prompts = []; factsCalls = 0
    cueMemoryNotes = []
    yes = { D1: 0.9 }; orientation = { domain: 'quilt', title: null }; grounding = 'grounded'
    read = okRead()
    writerText = JSON.stringify({ cue: 'Tableau Oct 2026, marketing sources only: SBU customers 54 vs 81 budget. Not the same measure as MRR or locations.', kind: 'challenge', memoryIds: ['D1'] })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('offered', () => {
    it('a window that names SBU beside a figure gives the judge D1, the writer the note, and the cue a Tableau source', async () => {
      await feed(SBU_TOPIC)
      expect(judged).toEqual([['D1']])
      expect(judgedNotes[0][0]).toMatchObject({ id: 'D1', title: 'Tableau, Oct 2026 close, marketing sources' })
      expect(judgedNotes[0][0].notes).toContain('SBU (3 of 4 industries): leads 402 vs 428 (94%)')
      const ev = evaluation()
      expect(ev).toMatchObject({ outcome: 'cue', dataArm: 'offered', arms: { data: 1 }, candidates: 1, keptIds: ['D1'] })
      const memory = (JSON.parse(prompts[0]) as { memory: Array<Record<string, string>> }).memory
      expect(memory).toEqual([{ id: 'D1', date: '2026-11-02', title: 'Tableau, Oct 2026 close, marketing sources', notes: judgedNotes[0][0].notes }])
      const cue = emitted.find(x => x.type === 'coaching_nudge_v2')!.data as unknown as import('../../shared/live-cues-v2.js').LiveCueV2
      expect(cue.sources).toEqual([{ id: expect.stringMatching(/^mtg_[0-9a-f]{12}$/), date: '2026-11-02', title: 'Tableau, Oct 2026 close, marketing sources', kind: 'file' }])
      expect(cue.sources[0]).not.toHaveProperty('fileId')
    })
    it('the writer rules carry the scope rule only because a Tableau note was kept, and the pinned rules are untouched', async () => {
      await feed(SBU_TOPIC)
      const base = liveCuesV2WriterSystem(env, 'legacy').system
      expect(systems[0]).toBe(base + dataMod.DATA_WRITER_ADDENDUM)
      expect(systems[0]).toContain('not company revenue, MRR, ARR, location counts')
      expect(systems[0]).toContain('say Tableau, the period, and marketing sources')
      expect(systems[0]).not.toMatch(/[—–]|->|→/)    // no em dashes, en dashes or arrows
    })
    it('offered but not kept: the writer is given no data note and the pinned rules', async () => {
      yes = { D1: 0.2 }
      await feed(SBU_TOPIC)
      expect(judged).toEqual([['D1']])
      expect(evaluation()).toMatchObject({ dataArm: 'offered', arms: { data: 1 }, keptIds: [] })
      expect((JSON.parse(prompts[0]) as { memory: unknown[] }).memory).toEqual([])
      expect(systems[0]).toBe(liveCuesV2WriterSystem(env, 'legacy').system)
    })
    it('the cue log row lists the Tableau source and leaves the data arm out of `arms`, so an older server still reads the row', async () => {
      await feed(SBU_TOPIC)
      expect(logged).toHaveLength(1)
      expect(logged[0].arms).toEqual([])
      expect((logged[0].sources as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: 'file', title: 'Tableau, Oct 2026 close, marketing sources' })
      expect(isLogRow(logged[0])).toBe(true)
      // the reason: this server's own validator refuses an arm it does not list, and so would 6.97.7 for a row with 'data'
      expect(isLogRow({ ...logged[0], arms: ['data'] })).toBe(false)
    })
    it('a Tableau-only cue is flagged dataNote in the log, and the row still passes the validator that ignores the flag', async () => {
      await feed(SBU_TOPIC)
      expect(logged[0]).toMatchObject({ arms: [], dataNote: true })
      expect(isLogRow(logged[0])).toBe(true)
      expect(isLogRow({ ...logged[0], dataNote: 'yes' })).toBe(false)
    })
    it('a cue with no Tableau note carries no dataNote', async () => {
      cueMemoryNotes = [note('M1')]; yes = { M1: 0.9 }
      writerText = JSON.stringify({ cue: 'Renewal terms are not settled yet. Name who owns the quote.', kind: 'challenge', memoryIds: ['M1'] })
      await feed(OTHER_TOPIC)
      expect(logged[0]).not.toHaveProperty('dataNote')
    })
    it('a closed month still serves 10 days after the refresh', async () => {
      clock += 10 * 24 * 3_600_000
      await feed(SBU_TOPIC)
      expect(evaluation()).toMatchObject({ dataArm: 'offered' })
    })
    it('the data candidate sits beside memory candidates; the judge sees both and the cue may cite either', async () => {
      cueMemoryNotes = [note('M1')]
      yes = { M1: 0.9, D1: 0.8 }
      writerText = JSON.stringify({ cue: 'SBU customers are 54 vs 81 budget in Tableau, marketing sources, Oct 2026. Not MRR.', kind: 'challenge', memoryIds: ['D1', 'M1'] })
      await feed(SBU_TOPIC)
      expect(judged).toEqual([['M1', 'D1']])
      expect(evaluation()).toMatchObject({ arms: { data: 1 }, keptIds: ['M1', 'D1'] })
      const cue = emitted.find(x => x.type === 'coaching_nudge_v2')!.data as unknown as import('../../shared/live-cues-v2.js').LiveCueV2
      expect(cue.sources.map(s => s.kind)).toEqual(['file', 'meeting'])
    })
  })

  describe('not offered', () => {
    it('a window that names no group: the arm is on, finds nothing, says no_group, and no data candidate is made', async () => {
      cueMemoryNotes = [note('M1')]; yes = { M1: 0.9 }
      writerText = JSON.stringify({ cue: 'Renewal terms are not settled yet. Name who owns the quote.', kind: 'challenge', memoryIds: ['M1'] })
      await feed(OTHER_TOPIC)
      expect(evaluation()).toMatchObject({ dataArm: 'no_group', arms: { data: 0 } })
      expect(judged).toEqual([['M1']])
      expect(systems[0]).toBe(liveCuesV2WriterSystem(env, 'legacy').system)
    })
    it('a group with no funnel word or figure says no_funnel', async () => {
      await feed(' we visited the liquor store yesterday')
      expect(evaluation()).toMatchObject({ dataArm: 'no_funnel', arms: { data: 0 } })
    })
    it.each([
      ['missing', () => ({ ok: false as const, reason: 'missing' as const }), 'missing'],
      ['unreadable', () => ({ ok: false as const, reason: 'unreadable' as const }), 'unreadable'],
      ['invalid', () => ({ ok: false as const, reason: 'invalid' as const }), 'invalid'],
      ['stale', () => dataMod.parseDataFacts(rawFacts(), Date.parse('2026-11-02T05:41:00-06:00') + 36 * 24 * 3_600_000), 'stale'],
    ])('the file is %s: arm off, traced as %s, the cue pipeline carries on without it', async (_n, makeRead, code) => {
      cueMemoryNotes = [note('M1')]; yes = { M1: 0.9 }
      writerText = JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap.', kind: 'challenge', memoryIds: ['M1'] })
      read = makeRead
      await feed(SBU_TOPIC)
      expect(evaluation()).toMatchObject({ outcome: 'cue', dataArm: code, arms: { data: 0 } })
      expect(judged).toEqual([['M1']])
    })
    it('another confirmed domain is traced as domain even when nothing was said about a group', async () => {
      orientation = { domain: 'personal', title: null }
      await feed(OTHER_TOPIC)
      expect(evaluation()).toMatchObject({ dataArm: 'domain', arms: { data: 0 } })
    })
    it.each([['personal'], ['sprocket_rocket'], ['hermit_crabs'], ['DNP study']])('a %s meeting never gets Quilt numbers', async (domain) => {
      orientation = { domain, title: null }
      await feed(SBU_TOPIC)
      expect(evaluation()).toMatchObject({ dataArm: 'domain', arms: { data: 0 } })
      expect(judged).toEqual([])
    })
    it.each([[null], ['quilt']])('a meeting whose domain is %s is served', async (domain) => {
      orientation = { domain, title: null }
      await feed(SBU_TOPIC)
      expect(evaluation()).toMatchObject({ dataArm: 'offered', arms: { data: 1 } })
    })
    it('a reader that throws is traced and never fails the evaluation', async () => {
      read = () => { throw new Error('disk gone') }
      await feed(SBU_TOPIC)
      expect(evaluation()).toMatchObject({ dataArm: 'threw', arms: { data: 0 } })
      expect(evaluation().outcome).not.toBe('failure')
    })
    it('classic grounding never reads the file and leaves the data fields out of the trace', async () => {
      grounding = 'classic'
      await feed(SBU_TOPIC)
      expect(factsCalls).toBe(0)
      expect(Object.keys(evaluation()).filter(k => ['dataArm', 'dataAgeH', 'arms'].includes(k))).toEqual([])
    })
    it('an engine without the dep (a test, an older build) runs the old three arms and says nothing of data', async () => {
      await feed(SBU_TOPIC, engine({ dataFacts: undefined }))
      expect(evaluation()).not.toHaveProperty('dataArm')
      expect(evaluation().arms).toMatchObject({ data: 0 })
    })
  })

  describe('which meetings get Quilt numbers when no domain is confirmed', () => {
    const FAMILY = ' we should look at the thrift budget, the leads are at 40 percent of plan for the month'
    const SR_CALL = ' your pet leads are 40 this month and the liquor opps look good for the plan'
    beforeEach(() => { orientation = { domain: null, title: null } })

    it('a family chat about a thrift budget does not fire', async () => {
      await feed(FAMILY)
      expect(evaluation()).toMatchObject({ dataArm: 'unconfirmed', arms: { data: 0 } })
      expect(judged).toEqual([])
    })
    it('a Sprocket Rocket call about pet leads does not fire, confirmed or not', async () => {
      await feed(SR_CALL)
      expect(evaluation()).toMatchObject({ dataArm: 'unconfirmed', arms: { data: 0 } })
      orientation = { domain: 'sprocket_rocket', title: null }; traces = []
      await feed(SR_CALL, engine())
      expect(evaluation()).toMatchObject({ dataArm: 'domain', arms: { data: 0 } })
    })
    it('a Quilt brand or SBU named fires, and the trace names the signal', async () => {
      await feed(' ThriftCart leads were 151 against 110')
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'brand', arms: { data: 1 } })
    })
    it('an industry word with a Quilt-domain memory in the same evaluation fires', async () => {
      cueMemoryNotes = [{ ...note('M1'), domain: 'quilt' }]; yes = { M1: 0.2, D1: 0.9 }
      await feed(FAMILY)
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'memory', arms: { data: 1 } })
      expect(judged).toEqual([['M1', 'D1']])
    })
    it.each([['personal'], ['hermit_crabs'], [undefined]])('a memory in the %s domain is no signal', async (domain) => {
      cueMemoryNotes = [{ ...note('M1'), ...(domain ? { domain } : {}) }]
      await feed(FAMILY)
      expect(evaluation()).toMatchObject({ dataArm: 'unconfirmed', arms: { data: 0 } })
    })
    it('a Quilt memory that is this meeting\'s own copy is excluded first and is no signal', async () => {
      cueMemoryNotes = [{ ...note('M1'), domain: 'quilt', sessionId: 'meeting_a' }]
      await feed(FAMILY)
      expect(evaluation()).toMatchObject({ dataArm: 'unconfirmed', excludedSelf: 1 })
    })
    it('an industry word with a Quilt term in the calendar title fires; a generic title does not', async () => {
      orientation = { domain: null, title: 'Quilt weekly forecast' }
      await feed(FAMILY)
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'title' })
      orientation = { domain: null, title: 'Dinner with the Okafors' }; traces = []
      await feed(FAMILY, engine())
      expect(evaluation()).toMatchObject({ dataArm: 'unconfirmed' })
    })
    it('a Quilt-confirmed meeting fires on an industry word alone', async () => {
      orientation = { domain: 'quilt', title: null }
      await feed(FAMILY)
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'quilt' })
    })
    it('an orientation that cannot be read turns the arm off even with a brand named', async () => {
      await feed(SBU_TOPIC, engine({ orientation: () => { throw new Error('journal_unreadable') } }))
      expect(evaluation()).toMatchObject({ dataArm: 'orientation', orientationError: 'threw', arms: { data: 0 } })
    })
  })

  describe('a lead source named in the room', () => {
    const PPC = ' we are doing a refresh on the PPC landing pages for thrift'
    beforeEach(() => { read = () => dataMod.parseDataFacts(rawSourceFacts(), clock) })

    it('gives the judge a D1 about that source, the writer the scope rule for it, and the cue the same Tableau source', async () => {
      await feed(PPC)
      expect(judged).toEqual([['D1']])
      expect(judgedNotes[0][0].notes).toContain('Thrift, Paid Search Non-Brand alone: leads 45, opps 11; Paid Search Brand alone: leads 8, opps 2.')
      expect(judgedNotes[0][0].notes).toContain('Budget line Paid Search Non-Brand (also counts Paid Social): leads 66 vs 47 (140%)')
      expect(evaluation()).toMatchObject({ outcome: 'cue', dataArm: 'offered', arms: { data: 1 }, keptIds: ['D1'] })
      expect(systems[0]).toBe(liveCuesV2WriterSystem(env, 'legacy').system + dataMod.DATA_WRITER_ADDENDUM)
      expect(systems[0]).toContain('covers only that source')
      const cue = emitted.find(x => x.type === 'coaching_nudge_v2')!.data as unknown as import('../../shared/live-cues-v2.js').LiveCueV2
      expect(cue.sources).toEqual([{ id: expect.stringMatching(/^mtg_[0-9a-f]{12}$/), date: '2026-11-02', title: 'Tableau, Oct 2026 close, marketing sources', kind: 'file' }])
      expect(isLogRow(logged[0])).toBe(true)
    })
    it('the trace carries ids, a count and an age, never the source text or the room', async () => {
      await feed(PPC)
      const row = JSON.stringify(evaluation())
      expect(row).not.toContain('Paid Search'); expect(row).not.toContain('landing pages'); expect(row).not.toContain('66 vs 47')
    })
    it('the same gate as the group note: a Quilt meeting, or no confirmed domain with a Quilt signal; never another domain', async () => {
      orientation = { domain: 'personal', title: null }
      await feed(PPC)
      expect(evaluation()).toMatchObject({ dataArm: 'domain', arms: { data: 0 } })
      orientation = { domain: null, title: null }; traces = []
      await feed(PPC, engine())
      expect(evaluation()).toMatchObject({ dataArm: 'unconfirmed', arms: { data: 0 } })        // an industry word and a source are no Quilt signal
      traces = []; await feed(' paid search leads are at 40 this month', engine())
      expect(evaluation()).toMatchObject({ dataArm: 'unconfirmed', arms: { data: 0 } })        // a source alone is never a brand signal
      traces = []; await feed(' the ThriftCart PPC landing pages are at 40 leads', engine())
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'brand' })
      orientation = { domain: 'quilt', title: null }; traces = []
      await feed(' paid search leads are at 40 this month', engine())
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'quilt' })
      expect(judgedNotes.at(-1)![0].notes).toContain('Paid Search alone, largest by leads: Liquor Paid Search Non-Brand leads 64; Thrift Paid Search Non-Brand leads 45.')
    })
    it('no confirmed domain: a Quilt memory does not vouch for a source alone ("the trade show is in 30 days"); a Quilt title does; a group beside the source keeps the old rule', async () => {
      orientation = { domain: null, title: null }
      cueMemoryNotes = [{ ...note('M1'), domain: 'quilt' }]; yes = { M1: 0.2, D1: 0.9 }
      for (const w of [' the google ads plan is 40 percent done', ' the trade show leads are at 30', ' paid search is at 40 this month']) {
        traces = []; judged = []
        await feed(w, engine())
        expect(evaluation(), w).toMatchObject({ dataArm: 'unconfirmed', arms: { data: 0 } })
        expect(judged.flat(), w).not.toContain('D1')
      }
      traces = []; judged = []
      await feed(PPC, engine())                                                           // a group beside the source: memory vouches, as for a group note
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'memory', arms: { data: 1 } })
      orientation = { domain: null, title: 'Quilt weekly forecast' }; traces = []
      await feed(' the google ads plan is 40 percent done', engine())                     // a Quilt term in the title vouches for the source alone
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'title' })
      orientation = { domain: 'quilt', title: null }; traces = []
      await feed(' the google ads plan is 40 percent done', engine())
      expect(evaluation()).toMatchObject({ dataArm: 'offered', dataSignal: 'quilt' })
    })
    it('an older file (no source detail) still serves: rows only, no budget line; with no rows for the group the totals rule decides', async () => {
      read = () => dataMod.parseDataFacts(rawFacts({ sources: rawSourceFacts().sources.map(({ budgetLine: _b, ...r }: Record<string, unknown>) => r) }), clock)
      await feed(PPC)
      expect(judgedNotes[0][0].notes).toContain('Thrift, Paid Search Non-Brand alone: leads 45, opps 11, customers 3; Paid Search Brand alone: leads 8, opps 2, customers 0.')
      expect(judgedNotes[0][0].notes).not.toContain('Budget line')
      read = okRead(); traces = []
      await feed(' we are doing a refresh on the PPC landing pages for thrift', engine())
      expect(evaluation()).toMatchObject({ dataArm: 'no_funnel', arms: { data: 0 } })
      traces = []; await feed(' PPC leads for thrift look low', engine())
      expect(judgedNotes.at(-1)![0].notes).toContain('Thrift: leads 151 vs 110 (137%)')
    })
  })

  it('traces ids, a count and an age: never the candidate text or the room', async () => {
    await feed(SBU_TOPIC)
    const row = JSON.stringify(evaluation())
    expect(row).not.toContain('Tableau Oct 2026 final')
    expect(row).not.toContain('SBU closed')
    expect(row).not.toContain('402 vs 428')
    expect(evaluation().dataAgeH).toBeGreaterThan(0)
  })
  it('the limits did not move', () => {
    expect(L.judgeMaxNotes).toBe(2)
  })
})
