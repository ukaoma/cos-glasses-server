// Live cues v3: with grounding classic (the default) every Jev request, writer prompt, trace row, cue and cue log row is
// byte for byte what 6.97.4 produced. The expected strings below were captured from the unmodified 6.97.4 engine before any
// v3 code existed; a change here is a change to what the classifier, the writer and the log see, and needs a new replay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./jev.js', async (orig) => ({ ...(await orig<typeof import('./jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))

const mod = await import('./live-cues-v2.js')
const { JEV_MODEL } = await import('./jev.js')
const { LiveCuesV2Engine, LiveCuesV2Store, cueDecisionCalls } = mod
type Deps = import('./live-cues-v2.js').LiveCuesV2Deps
type JevAnswers = import('./jev.js').JevAnswers

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const words = (n: number) => Array.from({ length: n }, (_, i) => `budget${i % 7}`).join(' ')
const TIMING = new Set(['at', 'gateMs', 'memoryMs', 'judgeMs', 'writerMs', 'totalMs', 'notesMs'])
/** The arm-time title carries the local hour, so it varies with the machine's zone. */
const noTitleClock = (s: string) => s.replace(/G2 Recording \d{4}-\d{2}-\d{2} \d{4}/g, 'G2 Recording <local time>')

describe('classic grounding is byte for byte 6.97.4', () => {
  let dir: string
  let clock: number
  let requests: Array<{ state: unknown; questions: unknown }>
  let writerCalls: Array<{ model: string; system: string; prompt: string }>
  let traces: Array<Record<string, unknown>>
  let emitted: Array<{ type: string; data: Record<string, unknown> }>
  let logged: Array<Record<string, unknown>>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cues-v2-classic-'))
    clock = Date.parse('2026-10-14T15:00:00Z')
    requests = []; writerCalls = []; traces = []; emitted = []; logged = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const client = {
    async ask(state: unknown, questions: Record<string, unknown>): Promise<JevAnswers> {
      requests.push({ state, questions })
      if ('act' in questions) return { answers: { act: { type: 'choice' as const, choice: 'cue', probabilities: { cue: 0.93, silent: 0.07 } }, kind: { type: 'choice' as const, choice: 'challenge', probabilities: { reinforce: 0.2, challenge: 0.8 } },
        lookup: { type: 'choice' as const, choice: 'past_meetings', probabilities: { none: 0.1, past_meetings: 0.8, public_fact: 0.1 } } }, inputTokens: 1100 }
      return { answers: { same: { type: 'choice' as const, choice: 'M1', probabilities: { M1: 0.91, M2: 0.79, M3: 0.85, none: 0.02 } } }, inputTokens: 1200 }
    },
  }
  function engine(settings: Deps['settings'], envOver: NodeJS.ProcessEnv = {}) {
    const calls = cueDecisionCalls(client)
    const deps: Deps = {
      gate: (t, w, s) => calls.gate(t, w, s),
      memory: async () => ({ notes: [
        { id: 'M1', date: '2026-10-01', title: 'Kept A', notes: 'Summary: redirect pricing 12% overage', key: '2026-10-01|kept a' },
        { id: 'M2', date: '2026-09-20', title: 'Dropped', notes: 'Summary: unrelated', key: '2026-09-20|dropped' },
        { id: 'M3', date: '2026-09-01', title: 'Kept B', notes: 'Summary: client asked for a cap', key: '2026-09-01|kept b' }] }),
      notes: async () => ({ notes: [] }),
      judge: (t, w, notes, s) => calls.judge(t, w, notes, s),
      writer: async (model, system, prompt) => { writerCalls.push({ model, system, prompt }); return { text: JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: ['M1', 'M2'] }), costUsd: 0.003, model: 'claude-sonnet-5-5' } },
      emit: (type, data) => { emitted.push({ type, data }) },
      lease: () => ({ release: () => {} }) as unknown as import('./maintenance-lifecycle.js').MaintenanceWorkLease,
      busy: () => false,
      decisionProvider: () => 'jev',
      decisionState: () => ({ configured: true, breakerOpen: false, capReached: false }),
      memorySource: () => 'cue_memory',
      settings,
      warmMemory: () => {},
      now: () => new Date(clock),
      store: new LiveCuesV2Store(join(dir, 'state.json'), () => new Date(clock)),
      trace: row => { traces.push(row) },
      cueLog: row => { logged.push(row as unknown as Record<string, unknown>) },
      env: { COS_LIVE_CUES_V2: '1', ...envOver },
    }
    return new LiveCuesV2Engine(deps)
  }
  /** Everything one cue run produced, with the wall-clock fields and the random cue id taken out. */
  async function run(settings: Deps['settings'], envOver: NodeJS.ProcessEnv = {}) {
    requests = []; writerCalls = []; traces = []; emitted = []; logged = []; clock = Date.parse('2026-10-14T15:00:00Z')
    const e = engine(settings, envOver)
    e.arm('meeting_a')
    await e.feed('meeting_a', words(40))
    const evaluation = traces.find(t => t.kind === 'evaluation')!
    const cue = emitted.find(x => x.type === 'coaching_nudge_v2')!.data
    const row = logged[0]
    const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !TIMING.has(k) && k !== 'cueId'))
    return {
      requests: sha(JSON.stringify(requests.map(r => ({ state: r.state, model: JEV_MODEL, questions: r.questions })))),
      requestCount: requests.length,
      writer: writerCalls.map(w => ({ model: w.model, system: sha(w.system), prompt: noTitleClock(w.prompt) })),
      trace: noTitleClock(JSON.stringify(strip(evaluation))),
      cue: noTitleClock(JSON.stringify(strip(cue))),
      log: noTitleClock(JSON.stringify(strip(row))),
      emittedTypes: emitted.map(x => x.type),
    }
  }

  const GOLDEN = {
    requests: '5ca98699691ce4cafa69ac709c2e6728254bb6e2b5721437ac26b7d41baecc52',
    requestCount: 2,
    writer: [{ model: 'claude-sonnet-5-5', system: '626548bdf00d5ae60ec7879ffd3b8746686844b8f6ebd839977fff3e3cb4377c',
      prompt: '{"meetingTitle": "G2 Recording <local time>", "liveIssue": "", "suggestedKind": "challenge", "previousCues": [], "memory": [{"id": "M1", "date": "2026-10-01", "title": "Kept A", "notes": "Summary: redirect pricing 12% overage"}, {"id": "M2", "date": "2026-09-01", "title": "Kept B", "notes": "Summary: client asked for a cap"}], "window": "budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4"}' }],
    trace: '{"kind":"evaluation","sessionId":"meeting_a","n":1,"decisionProvider":"jev","pCue":0.93,"cueKind":"challenge","lookup":{"none":0.1,"past_meetings":0.8,"public_fact":0.1},"gateTokens":1100,"candidates":3,"cueMemorySource":"cue_memory","judgeTokens":1200,"kept":2,"prompt":"v3","model":"claude-sonnet-5-5","writerUsd":0.003,"outcome":"cue","cueChars":62,"sources":2}',
    cue: '{"protocol":2,"sessionId":"meeting_a","headline":"Overage is 12% with no cap set","detail":"Overage is 12% with no cap set. Name who quotes the cap today.","kind":"challenge","sources":[{"id":"mtg_e6dae82d127a","date":"2026-10-01","title":"Kept A"},{"id":"mtg_857deacda7cb","date":"2026-09-01","title":"Kept B"}],"gate":0.93,"createdAt":1791990000000,"model":"claude-sonnet-5-5"}',
    log: '{"v":1,"sessionId":"meeting_a","meetingTitle":"G2 Recording <local time>","createdAt":1791990000000,"armedAt":1791990000000,"kind":"challenge","headline":"Overage is 12% with no cap set","detail":"Overage is 12% with no cap set. Name who quotes the cap today.","gate":0.93,"sources":[{"id":"mtg_e6dae82d127a","date":"2026-10-01","title":"Kept A"},{"id":"mtg_857deacda7cb","date":"2026-09-01","title":"Kept B"}],"model":"claude-sonnet-5-5","prompt":"v3","memorySource":"cue_memory","kept":2,"wouldWithhold":{"perMeeting":false,"perTopic":false},"before":"budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4 budget5 budget6 budget0 budget1 budget2 budget3 budget4"}',
    emittedTypes: ['coaching_nudge_v2', 'coaching_nudge'],
  }

  it('default settings (no grounding field at all)', async () => {
    const got = await run({ stored: () => null })
    expect(got).toEqual(GOLDEN)
  })

  it('grounding saved as classic, saved as something malformed, or saved as grounded but forced to classic by env: the same bytes', async () => {
    expect(await run({ stored: () => null, grounding: () => 'classic' })).toEqual(GOLDEN)
    expect(await run({ stored: () => null, grounding: () => 'turbo' as unknown as 'classic' })).toEqual(GOLDEN)
    expect(await run({ stored: () => null, grounding: () => null })).toEqual(GOLDEN)
    expect(await run({ stored: () => null, grounding: () => { throw new Error('unreadable') } })).toEqual(GOLDEN)
    expect(await run({ stored: () => null, grounding: () => 'grounded' }, { COS_LIVE_CUES_GROUNDING: 'classic' })).toEqual(GOLDEN)
  })
})
