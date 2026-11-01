// Live cues v3, grounded cues in the engine: the arms, the exclusions, judge B, the writer's context and the trace. The pure
// helpers are in live-cues-v2-grounded.test.ts; classic byte identity is in live-cues-v2-classic-pin.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./jev.js', async (orig) => ({ ...(await orig<typeof import('./jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))

const mod = await import('./live-cues-v2.js')
const contract = await import('../../shared/live-cues-v2.js')
const { GROUNDED_LIMITS } = await import('./live-cues-v2-grounded.js')
const { LiveCuesV2Engine, LiveCuesV2Store, LIVE_CUES_V2_LIMITS: L, cueMemory, liveCuesV2JudgeYes, sourceId } = mod
type Deps = import('./live-cues-v2.js').LiveCuesV2Deps
type MemoryNote = import('./live-cues-v2.js').MemoryNote
type GroundedFile = import('./live-cues-v2-grounded.js').GroundedFile

const SAID = Array.from({ length: 60 }, (_, i) => `said${i}`).join(' ')          // what the room says: said0 said1 ... said59
const WINDOW_TOPIC = ' overage pricing renewal contract Harborview quarter'
const note = (id: string, over: Partial<MemoryNote> = {}): MemoryNote => ({ id, date: '2026-10-01', title: `Past ${id}`, notes: `Summary: ${id} text`, key: `2026-10-01|past ${id.toLowerCase()}`, ...over })

describe('grounded cues in the engine', () => {
  let dir: string
  let clock: number
  let emitted: Array<{ type: string; data: Record<string, unknown> }>
  let traces: Array<Record<string, unknown>>
  let logged: Array<Record<string, unknown>>
  let calls: { memory: number; notes: number; judge: number; judgeB: number; writer: number; files: number; orientation: number; tops: Array<number | undefined>; prompts: string[]; gateTitles: string[]; judgeBTitles: string[]; judgedIds: string[][] }
  let cueMemoryNotes: MemoryNote[]
  let notesFound: MemoryNote[]
  let files: GroundedFile[]
  let orientation: { domain: string | null; title: string | null }
  let yes: Record<string, number>
  let same: Record<string, number>
  let grounding: 'classic' | 'grounded' | null
  let env: NodeJS.ProcessEnv
  let writerText: (prompt: string) => string

  function engine(over: Partial<Deps> = {}) {
    const deps: Deps = {
      gate: async (title) => { calls.gateTitles.push(title); return { pCue: 0.93, kind: 'challenge', lookup: null, tokens: 1000 } },
      memory: async (_w, _b, _s, top) => { calls.memory++; calls.tops.push(top); return { notes: cueMemoryNotes } },
      notes: async () => { calls.notes++; return { notes: notesFound } },
      judge: async () => { calls.judge++; return { probs: { M1: 0.9, none: 0.1 }, tokens: 900 } },
      judgeB: async (title, _w, cands) => {
        calls.judgeB++; calls.judgeBTitles.push(title); calls.judgedIds.push(cands.map(c => c.id))
        return { yes: Object.fromEntries(cands.map(c => [c.id, yes[c.id] ?? 0])), same: Object.fromEntries(cands.map(c => [c.id, same[c.id] ?? 0])), tokens: 2300 }
      },
      files: () => { calls.files++; return files },
      orientation: () => { calls.orientation++; return orientation },
      writer: async (_m, _s, prompt) => { calls.writer++; calls.prompts.push(prompt); return { text: writerText(prompt), costUsd: 0.003, model: 'claude-sonnet-5-5' } },
      emit: (type, data) => {
        if (type === 'coaching_nudge_v2') expect(contract.isLiveCueV2(data), 'every emitted v2 cue passes the shared validator').toBe(true)
        emitted.push({ type, data })
      },
      lease: () => ({ release: () => {} }) as unknown as import('./maintenance-lifecycle.js').MaintenanceWorkLease,
      busy: () => false,
      decisionProvider: () => 'jev',
      decisionState: () => ({ configured: true, breakerOpen: false, capReached: false }),
      memorySource: () => 'cue_memory',
      settings: { stored: () => null, ...(grounding ? { grounding: () => grounding } : {}) },
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
  const cue = () => emitted.find(x => x.type === 'coaching_nudge_v2')?.data
  const promptOf = () => JSON.parse(calls.prompts[0]) as { meetingTitle: string; liveIssue: string; memory: Array<Record<string, string>> }
  async function feed(e: InstanceType<typeof LiveCuesV2Engine>, sessionId = 'meeting_a') {
    e.arm(sessionId)
    await e.feed(sessionId, SAID + WINDOW_TOPIC)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cues-v2-grounding-'))
    clock = Date.parse('2026-10-14T15:00:00Z')
    emitted = []; traces = []; logged = []
    calls = { memory: 0, notes: 0, judge: 0, judgeB: 0, writer: 0, files: 0, orientation: 0, tops: [], prompts: [], gateTitles: [], judgeBTitles: [], judgedIds: [] }
    cueMemoryNotes = [note('M1'), note('M2', { date: '2026-09-20' }), note('M3', { date: '2026-09-10' }), note('M4', { date: '2026-09-01' })]
    notesFound = []; files = []; orientation = { domain: 'quilt', title: null }
    yes = { M1: 0.9, M2: 0.2, M3: 0.1, M4: 0.1, N1: 0.2, F1: 0.2 }; same = {}
    grounding = 'grounded'
    env = { COS_LIVE_CUES_V2: '1' }
    writerText = () => JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: ['M1'] })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('the switch', () => {
    it('classic, unset, or forced to classic by env: judge B, files and orientation never run and the trace says nothing of grounding', async () => {
      for (const [setting, e] of [[null, {}], ['classic', {}], ['grounded', { COS_LIVE_CUES_GROUNDING: 'classic' }]] as const) {
        grounding = setting; env = { COS_LIVE_CUES_V2: '1', ...e }
        calls = { ...calls, judge: 0, judgeB: 0, files: 0, orientation: 0, notes: 0 }; traces = []; emitted = []
        await feed(engine(), 'meeting_a')
        expect({ judge: calls.judge, judgeB: calls.judgeB, files: calls.files, orientation: calls.orientation, notes: calls.notes }, `${setting} ${JSON.stringify(e)}`).toEqual({ judge: 1, judgeB: 0, files: 0, orientation: 0, notes: 0 })
        expect(Object.keys(evaluation()).filter(k => ['grounding', 'judge', 'arms', 'excludedSelf', 'filesError', 'orientationError'].includes(k))).toEqual([])
        expect(evaluation().kept).toBe(1)                                                     // classic keeps its count
      }
    })
    it('only the exact value classic forces: grounded in env does not turn grounding on, and a saved grounded runs it', async () => {
      grounding = null; env = { COS_LIVE_CUES_V2: '1', COS_LIVE_CUES_GROUNDING: 'grounded' }
      await feed(engine())
      expect(calls.judgeB).toBe(0)
      grounding = 'grounded'; env = { COS_LIVE_CUES_V2: '1' }
      await feed(engine(), 'meeting_b')
      expect(calls.judgeB).toBe(1)
    })
    it('the setting is read for each evaluation: switching to grounded applies from the next one', async () => {
      grounding = 'classic'
      const e = engine(); e.arm('meeting_a')
      await e.feed('meeting_a', SAID + WINDOW_TOPIC)
      expect(calls.judgeB).toBe(0)
      grounding = 'grounded'; clock += L.cooldownAfterCueMs + L.minIntervalMs
      await e.feed('meeting_a', SAID + WINDOW_TOPIC)
      expect(calls.judgeB).toBe(1)
    })
  })

  describe('the arms', () => {
    it('cue_memory and the notes start together, neither waiting for the other', async () => {
      const started: string[] = []
      let release!: () => void
      const hold = new Promise<void>(r => { release = r })
      const e = engine({
        memory: async () => { started.push('memory'); await hold; return { notes: cueMemoryNotes } },
        notes: async () => { started.push('notes'); await hold; return { notes: [] } },
      })
      e.arm('meeting_a')
      const done = e.feed('meeting_a', SAID + WINDOW_TOPIC)
      await vi.waitFor(() => expect(started.sort()).toEqual(['memory', 'notes']))
      release()
      await done
      expect(evaluation().outcome).toBe('cue')
    })
    it('cue_memory is asked for eight so the exclusions still leave four; classic is never given a count', async () => {
      await feed(engine())
      expect(calls.tops).toEqual([8])
      expect(GROUNDED_LIMITS.cueMemoryRaw).toBe(8)
      grounding = 'classic'; calls.tops = []
      await feed(engine(), 'meeting_b')
      expect(calls.tops).toEqual([undefined])
    })
    it('a failing cue_memory does not stop the notes, and a failing notes arm does not stop cue_memory; both are traced and neither counts toward the breaker', async () => {
      notesFound = [note('N', { title: 'From notes', key: 'memory:mem-7', date: '2026-09-02' })]
      yes = { N1: 0.9 }
      writerText = () => JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: ['N1'] })
      await feed(engine({ memory: async () => { throw new Error('boom') } }))
      expect(evaluation()).toMatchObject({ memoryError: 'memory_threw', outcome: 'cue', arms: { cue_memory: null }, cueMemorySource: 'notes' })
      expect(evaluation()).not.toHaveProperty('memoryMs')                                       // an arm that threw has no time to report
      expect(cue()!.sources).toMatchObject([{ kind: 'memory', memoryId: 'mem-7' }])
      traces = []; emitted = []
      await feed(engine({ notes: async () => { throw new Error('boom') } }), 'meeting_b')
      expect(evaluation()).toMatchObject({ notesError: 'notes_threw', outcome: 'cue', arms: { notes: null } })
    })
    it('with cue_memory empty, the notes are the memory source', async () => {
      cueMemoryNotes = []
      notesFound = [note('N', { title: 'Mem note', key: 'memory:mem-3', date: '2026-09-05' })]
      yes = { N1: 0.9 }
      writerText = () => JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: ['N1'] })
      await feed(engine())
      expect(evaluation()).toMatchObject({ candidates: 1, cueMemorySource: 'notes', kept: ['N1'] })
      expect(logged[0]).toMatchObject({ memorySource: 'notes', arms: ['notes'] })
    })
    it('files and orientation that throw are traced as codes only and the meeting carries on', async () => {
      const e = engine({
        files: () => { throw Object.assign(new Error('Invalid session id'), { reason: 'invalid_session_id' }) },
        orientation: () => { throw new Error('unreadable') },
      })
      await feed(e)
      expect(evaluation()).toMatchObject({ filesError: 'invalid_session_id', orientationError: 'threw', outcome: 'cue', arms: { files: 0 } })
      expect(e.status('meeting_a').session).toMatchObject({ state: 'active' })
      expect(promptOf().meetingTitle).toMatch(/^G2 Recording /)
    })
  })

  describe('exclusions', () => {
    it('a copy of this meeting in cue_memory\'s answer is dropped before the judge and counted', async () => {
      const copy = note('C', { title: 'Copy of today', date: '2026-10-14', notes: Array.from({ length: 12 }, (_, i) => `said${i}`).join(' ') })
      cueMemoryNotes = [copy, ...cueMemoryNotes]
      await feed(engine())
      expect(calls.judgedIds[0]).toEqual(['M1', 'M2', 'M3', 'M4'])
      expect(evaluation().excludedSelf).toBe(1)
      expect(promptOf().memory.map(m => m.title)).not.toContain('Copy of today')
    })
    it('a library record of this very session, or of another armed session (its twin), is dropped', async () => {
      notesFound = [note('A', { title: 'Own copy', key: 'meeting:standalone:meeting_a', date: '2026-10-14' }), note('B', { title: 'Twin copy', key: 'meeting:standalone:mac_twin', date: '2026-10-14' }),
        note('C', { title: 'Real', key: 'memory:m-real', date: '2026-09-05' })]
      const e = engine(); e.arm('mac_twin'); e.arm('meeting_a')
      await e.feed('meeting_a', SAID + WINDOW_TOPIC)
      expect(calls.judgedIds[0]).toEqual(['M1', 'M2', 'M3', 'M4', 'N1'])
      expect(evaluation().excludedSelf).toBe(2)
    })
    it('a personal note is dropped from a work meeting and kept in a personal one', async () => {
      notesFound = [note('P', { title: 'Family budget', key: 'memory:m-p', domain: 'personal', date: '2026-09-05' })]
      yes = { M1: 0.9, N1: 0.8 }
      await feed(engine())
      expect(calls.judgedIds[0]).toEqual(['M1', 'M2', 'M3', 'M4'])
      orientation = { domain: 'personal', title: null }
      await feed(engine(), 'meeting_b')
      expect(calls.judgedIds[1]).toEqual(['M1', 'M2', 'M3', 'M4', 'N1'])
    })
    it('one meeting found by both arms is judged once', async () => {
      notesFound = [note('D', { title: 'Past M1', date: '2026-10-01', key: 'meeting:ops:quilt:2026-10:m1.md' })]
      await feed(engine())
      expect(calls.judgedIds[0]).toEqual(['M1', 'M2', 'M3', 'M4'])
    })
  })

  describe('files', () => {
    const doc = (id: string, status: string, text = 'Overage pricing renewal contract Harborview terms are twelve percent.'): GroundedFile => ({ id, name: `${id}.pdf`, status, text })
    it('the best passage of a ready file is F1; the trace counts ready files', async () => {
      files = [doc('plan', 'ready'), doc('pending-one', 'pending')]
      yes = { M1: 0.4, F1: 0.9 }
      writerText = () => JSON.stringify({ cue: 'The plan says twelve percent. Confirm the cap.', kind: 'challenge', memoryIds: ['F1'] })
      await feed(engine())
      expect(calls.judgedIds[0]).toEqual(['M1', 'M2', 'M3', 'M4', 'F1'])
      expect(evaluation()).toMatchObject({ arms: { files: 1 }, kept: ['F1'] })
      expect(cue()!.sources).toEqual([{ id: sourceId({ id: 'F1', date: '2026-10-14', title: 'plan.pdf', notes: '', key: 'file:plan' }), date: '2026-10-14', title: 'plan.pdf', kind: 'file', fileId: 'plan' }])
      expect(logged[0]).toMatchObject({ arms: ['cue_memory', 'files'] })
    })
    it('a file alone is traced and logged as memory source none, with the files arm in the cue\'s arms', async () => {
      cueMemoryNotes = []
      files = [doc('plan', 'ready')]
      yes = { F1: 0.9 }
      writerText = () => JSON.stringify({ cue: 'The plan says twelve percent. Confirm the cap.', kind: 'challenge', memoryIds: ['F1'] })
      await feed(engine())
      expect(evaluation()).toMatchObject({ candidates: 1, cueMemorySource: 'none', kept: ['F1'] })
      expect(logged[0]).toMatchObject({ memorySource: 'none', arms: ['files'], kept: 1 })
    })
    it('a secret-held file with text, and a pending one, are never sent to the judge', async () => {
      files = [doc('held', 'secret-held'), doc('wait', 'pending')]
      await feed(engine())
      expect(calls.judgedIds[0]).toEqual(['M1', 'M2', 'M3', 'M4'])
      expect(evaluation().arms).toMatchObject({ files: 0 })
    })
  })

  describe('judge B', () => {
    it('ONE request over every candidate; a candidate is kept at its own yes of 0.65 and not at 0.649; the best two by yes, in that order', async () => {
      yes = { M1: 0.65, M2: 0.649, M3: 0.7, M4: 0.1 }
      writerText = () => JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: ['M1', 'M3', 'M2'] })
      await feed(engine())
      expect(calls.judgeB).toBe(1)
      expect(calls.judge).toBe(0)
      expect(evaluation().kept).toEqual(['M3', 'M1'])
      expect(promptOf().memory.map(m => m.id)).toEqual(['M3', 'M1'])                          // ids keep their kind and are not renumbered
      expect((cue()!.sources as Array<{ title: string }>).map(x => x.title)).toEqual(['Past M1', 'Past M3'])   // the writer cited M1, M3 and M2; M2 was never kept
    })
    it('at most two are kept even when four pass', async () => {
      yes = { M1: 0.9, M2: 0.8, M3: 0.95, M4: 0.7 }
      await feed(engine())
      expect(evaluation().kept).toEqual(['M3', 'M1'])
    })
    it('nothing at or above the bar keeps nothing, and the writer still runs with no memory', async () => {
      yes = { M1: 0.64, M2: 0.5 }
      writerText = () => JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: [] })
      await feed(engine())
      expect(evaluation().kept).toEqual([])
      expect(promptOf().memory).toEqual([])
      expect(cue()!.sources).toEqual([])
    })
    it('no candidates means no judge request', async () => {
      cueMemoryNotes = []
      await feed(engine())
      expect(calls.judgeB).toBe(0)
      expect(evaluation()).toMatchObject({ candidates: 0, cueMemorySource: 'none', kept: [] })
    })
    it('the judge sees the arm-time title, not the calendar title', async () => {
      orientation = { domain: 'quilt', title: 'Harborview renewal' }
      await feed(engine())
      expect(calls.gateTitles[0]).toMatch(/^G2 Recording /)
      expect(calls.judgeBTitles[0]).toBe(calls.gateTitles[0])
    })
    it('COS_LIVE_CUES_V2_JUDGE_YES: unset or empty is 0.65; 0.5 to 0.95 applies; anything else is 0.65 with one log line per value', async () => {
      const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(liveCuesV2JudgeYes({})).toBe(0.65)
      expect(liveCuesV2JudgeYes({ COS_LIVE_CUES_V2_JUDGE_YES: '' })).toBe(0.65)
      expect(liveCuesV2JudgeYes({ COS_LIVE_CUES_V2_JUDGE_YES: '   ' })).toBe(0.65)
      expect(quiet).not.toHaveBeenCalled()                                                      // unset or empty is the default without a word
      quiet.mockRestore()
      expect(liveCuesV2JudgeYes({ COS_LIVE_CUES_V2_JUDGE_YES: '0.5' })).toBe(0.5)
      expect(liveCuesV2JudgeYes({ COS_LIVE_CUES_V2_JUDGE_YES: '0.95' })).toBe(0.95)
      expect(liveCuesV2JudgeYes({ COS_LIVE_CUES_V2_JUDGE_YES: '0.8' })).toBe(0.8)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      for (const raw of ['0.49', '0.96', 'abc', '1']) expect(liveCuesV2JudgeYes({ COS_LIVE_CUES_V2_JUDGE_YES: raw }), raw).toBe(0.65)
      liveCuesV2JudgeYes({ COS_LIVE_CUES_V2_JUDGE_YES: '0.49' })
      expect(warn.mock.calls.filter(c => String(c[0]).includes('COS_LIVE_CUES_V2_JUDGE_YES')).length).toBe(4)   // once per distinct value
      warn.mockRestore()
    })
    it('the engine uses the env bar', async () => {
      env = { COS_LIVE_CUES_V2: '1', COS_LIVE_CUES_V2_JUDGE_YES: '0.8' }
      yes = { M1: 0.79, M2: 0.8 }
      await feed(engine())
      expect(evaluation().kept).toEqual(['M2'])
    })
  })

  describe('the writer and the cue', () => {
    it('a confirmed calendar title is the writer\'s meetingTitle; without one it is the recording title; liveIssue stays empty', async () => {
      orientation = { domain: 'quilt', title: '  Harborview   renewal  ' }
      await feed(engine())
      expect(promptOf()).toMatchObject({ meetingTitle: 'Harborview renewal', liveIssue: '' })
      orientation = { domain: 'quilt', title: '   ' }; calls.prompts = []
      await feed(engine(), 'meeting_b')
      expect(promptOf().meetingTitle).toMatch(/^G2 Recording /)
    })
    it('a very long calendar title is cut at 120 characters', async () => {
      orientation = { domain: null, title: 'T'.repeat(300) }
      await feed(engine())
      expect(promptOf().meetingTitle).toBe('T'.repeat(120))
    })
    it('the cue\'s sources carry kind and locator, the log row carries arms and the memory source, and an unknown id the writer invents cites nothing', async () => {
      notesFound = [note('N', { title: 'Mem note', key: 'memory:mem-1', date: '2026-09-05' })]
      yes = { M1: 0.9, N1: 0.85 }
      writerText = () => JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: ['M1', 'N1', 'X9'] })
      await feed(engine())
      const sources = cue()!.sources as Array<Record<string, string>>
      expect(sources.map(s => [s.kind, s.memoryId ?? null, s.title])).toEqual([['meeting', null, 'Past M1'], ['memory', 'mem-1', 'Mem note']])
      expect(logged[0]).toMatchObject({ arms: ['cue_memory', 'notes'], memorySource: 'cue_memory', kept: 2 })
      expect(logged[0].sources).toEqual(sources)
    })
  })

  describe('the trace', () => {
    it('carries the judge probabilities, kept ids, arm timings and the excluded count, and no text from the room, a note, a file or the calendar', async () => {
      files = [{ id: 'plan', name: 'SecretPlanName.pdf', status: 'ready', text: 'Overage pricing renewal contract Harborview CONFIDENTIAL-PASSAGE.' }]
      orientation = { domain: 'quilt', title: 'Calendar title CLIENT-NAME' }
      notesFound = [note('N', { title: 'Note title XYZ', notes: 'NOTE-BODY-TEXT here', key: 'memory:mem-2', date: '2026-09-04' })]
      same = { M1: 0.4 }
      yes = { M1: 0.91234567, F1: 0.7 }
      await feed(engine())
      const t = evaluation()
      expect(t).toMatchObject({ grounding: 'grounded', kept: ['M1', 'F1'], excludedSelf: 0, arms: { files: 1 }, candidates: 6, judgeTokens: 2300 })
      expect((t.arms as { cue_memory: unknown; notes: unknown }).cue_memory).toEqual(expect.any(Number))
      expect((t.arms as { cue_memory: unknown; notes: unknown }).notes).toEqual(expect.any(Number))
      expect(t.judge).toEqual([
        { id: 'M1', kind: 'meeting', yes: 0.912, same: 0.4 }, { id: 'M2', kind: 'meeting', yes: 0, same: 0 }, { id: 'M3', kind: 'meeting', yes: 0, same: 0 },
        { id: 'M4', kind: 'meeting', yes: 0, same: 0 }, { id: 'N1', kind: 'memory', yes: 0, same: 0 }, { id: 'F1', kind: 'file', yes: 0.7, same: 0 }])
      const text = JSON.stringify(traces)
      for (const secret of ['CONFIDENTIAL-PASSAGE', 'SecretPlanName', 'CLIENT-NAME', 'NOTE-BODY-TEXT', 'Note title XYZ', 'said17', 'Summary: M1', 'Past M1']) expect(text, secret).not.toContain(secret)
    })
    it('the judge usage counts toward today\'s Jev tokens', async () => {
      const e = engine()
      await feed(e)
      expect(e.today()).toMatchObject({ jevTokens: 1000 + 2300 })
    })
    it('a cancel during the arms ends the evaluation as cancelled without a judge request or a writer call', async () => {
      const e = engine({ memory: async (_w, _b, signal) => { e.setPaused('meeting_a', true); void signal; return { notes: cueMemoryNotes } } })
      await feed(e)
      expect(calls.judgeB).toBe(0)
      expect(calls.writer).toBe(0)
      expect(evaluation().outcome).toBe('cancelled')
    })
  })
})

describe('cueMemory top', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cues-v2-mem-top-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  function fake() {
    const script = join(dir, 'cue_memory.py')
    writeFileSync(script, 'import sys, json\nreq = json.loads(sys.stdin.read())\nprint(json.dumps({"notes": [{"id": "M%d" % i, "date": "2026-10-01", "title": "T%d" % i, "notes": "n", "key": "k%d" % i} for i in range(12)], "echo": req["top"]}))\n')
    chmodSync(script, 0o700)
    return { python: '/usr/bin/python3', script, cwd: dir }
  }
  it('asks the script for four and keeps four unless the caller asks for more (grounded cues ask for eight)', async () => {
    const signal = new AbortController().signal
    expect((await cueMemory('w', '2026-10-18', signal, fake())).notes.map(n => n.id)).toEqual(['M0', 'M1', 'M2', 'M3'])
    expect((await cueMemory('w', '2026-10-18', signal, fake(), undefined, 8)).notes.map(n => n.id)).toEqual(['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'])
  })
  it('the request body carries the count it was asked for', async () => {
    const script = join(dir, 'echo.py')
    writeFileSync(script, 'import sys, json\nreq = json.loads(sys.stdin.read())\nprint(json.dumps({"notes": [{"id": "M1", "date": "2026-10-01", "title": "T", "notes": "top=%d" % req["top"], "key": "k"}]}))\n')
    chmodSync(script, 0o700)
    const p = { python: '/usr/bin/python3', script, cwd: dir }
    const signal = new AbortController().signal
    expect((await cueMemory('w', '2026-10-18', signal, p)).notes[0].notes).toBe('top=4')
    expect((await cueMemory('w', '2026-10-18', signal, p, undefined, 8)).notes[0].notes).toBe('top=8')
  })
})
