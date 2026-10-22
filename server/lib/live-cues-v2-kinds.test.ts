// 6.86.0: decision, promise and followUp cue kinds, opt-in per meeting; live cues on Mac recordings (arm, resume, kill
// switch, same limits). Fictional meeting text only: this repo is public.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./jev.js', async (orig) => ({ ...(await orig<typeof import('./jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))

const mod = await import('./live-cues-v2.js')
const prompts = await import('./live-cues-v2-prompts.js')
const kindsPrompt = await import('./live-cues-v2-prompts-kinds.js')
const contract = await import('../../shared/live-cues-v2.js')
const { dataPath } = await import('./data-dir.js')
const verdicts = await import('./live-cue-verdicts.js')
const { LiveCuesV2Engine, LiveCuesV2Store, LIVE_CUES_V2_LIMITS: L, parseWriterCue, liveCuesV2WriterSystem, defaultCueKindSet, liveCuesV2MacAllowed } = mod
const { isCueKind, isLiveCueV2, legacyCueKind, CUE_KINDS, LEGACY_CUE_KINDS } = contract
type Deps = import('./live-cues-v2.js').LiveCuesV2Deps

const MAC = 'mac_0f8fad5b-d9cb-469f-a165-70867728950e'
const G2 = 'g2_1760000000000'
const words = (n: number, w = 'budget') => Array.from({ length: n }, () => w).join(' ')
const sha = (v: string) => createHash('sha256').update(v).digest('hex')

describe('6.86.0 cue kinds: the contract', () => {
  it('knows five kinds; the legacy two are a subset; anything else is not a kind', () => {
    expect([...CUE_KINDS]).toEqual(['reinforce', 'challenge', 'decision', 'promise', 'followUp'])
    expect([...LEGACY_CUE_KINDS]).toEqual(['reinforce', 'challenge'])
    for (const k of CUE_KINDS) expect(isCueKind(k), k).toBe(true)
    for (const k of ['Decision', 'followup', 'follow_up', 'urgent', '', null, undefined, 3]) expect(isCueKind(k), String(k)).toBe(false)
  })
  it('isLiveCueV2 takes the new kinds and still refuses an unknown one', () => {
    const cue = { protocol: 2, cueId: 'c1', sessionId: MAC, headline: 'The pilot moves to two stores', detail: 'The pilot moves to two stores.', kind: 'decision',
      sources: [], gate: 0.9, createdAt: 1, model: 'claude-sonnet-5-5' }
    expect(isLiveCueV2(cue)).toBe(true)
    expect(isLiveCueV2({ ...cue, kind: 'followUp' })).toBe(true)
    expect(isLiveCueV2({ ...cue, kind: 'urgent' })).toBe(false)
  })
  it('a v1 reader is shown a legacy kind for every kind: decision and promise read as reinforce, followUp as challenge', () => {
    expect(CUE_KINDS.map(legacyCueKind)).toEqual(['reinforce', 'challenge', 'reinforce', 'reinforce', 'challenge'])
  })
  it('the cue log accepts the new kinds and still skips an unknown one', () => {
    const row = { v: 1, cueId: 'c1', sessionId: MAC, meetingTitle: 'Mac Recording 2026-10-22 1500', createdAt: 1, kind: 'promise', headline: 'h', detail: 'd',
      gate: 0.9, sources: [], model: 'm', prompt: 'v4', before: '' }
    expect(verdicts.isLogRow(row)).toBe(true)
    expect(verdicts.isLogRow({ ...row, kind: 'followUp' })).toBe(true)
    expect(verdicts.isLogRow({ ...row, kind: 'urgent' })).toBe(false)
  })
})

describe('6.86.0 writer v4', () => {
  it('is v3 with rules 3 and 4 and the schema kind list swapped, nothing else (v2 and v3 stay the measured strings)', () => {
    const v4 = kindsPrompt.CUE_WRITER_SYSTEM_V4
    expect(v4).not.toBe(prompts.CUE_WRITER_SYSTEM_V3)
    const back = v4.replace(kindsPrompt.V4_RULE_3, kindsPrompt.V3_RULE_3).replace(kindsPrompt.V4_RULE_4, kindsPrompt.V3_RULE_4).replace(kindsPrompt.V4_SCHEMA_KIND, kindsPrompt.V3_SCHEMA_KIND)
    expect(back).toBe(prompts.CUE_WRITER_SYSTEM_V3)
    expect(v4).toContain('"kind":"reinforce|challenge|decision|promise|followUp"')
    expect(v4).toContain('at most 200 characters')
    expect(v4).not.toMatch(/[\u2014\u2013]/)
    expect(sha(v4)).toBe('d3a0e56e38f007df3f3753b396f84c8d2d8add6cfb1191975204c5141839cc39')
  })
  it('an extended meeting always runs v4; a legacy meeting keeps v3, or v2 when COS_LIVE_CUES_V2_PROMPT=v2', () => {
    expect(liveCuesV2WriterSystem({}, 'extended')).toEqual({ version: 'v4', system: kindsPrompt.CUE_WRITER_SYSTEM_V4 })
    expect(liveCuesV2WriterSystem({ COS_LIVE_CUES_V2_PROMPT: 'v2' }, 'extended').version).toBe('v4')
    expect(liveCuesV2WriterSystem({}, 'legacy')).toEqual({ version: 'v3', system: prompts.CUE_WRITER_SYSTEM_V3 })
    expect(liveCuesV2WriterSystem({ COS_LIVE_CUES_V2_PROMPT: 'v2' })).toEqual({ version: 'v2', system: prompts.CUE_WRITER_SYSTEM_V2 })
  })
  it('parseWriterCue keeps a kind only inside the meeting set; outside it, or unknown, the gate kind stands', () => {
    const answer = (kind: string) => JSON.stringify({ cue: 'The room agreed the pilot runs in two stores.', kind })
    expect(parseWriterCue(answer('decision'), 'challenge', 'w', [])).toMatchObject({ kind: 'challenge' })            // default: legacy
    expect(parseWriterCue(answer('decision'), 'reinforce', 'w', [], false, LEGACY_CUE_KINDS)).toMatchObject({ kind: 'reinforce' })
    expect(parseWriterCue(answer('decision'), 'challenge', 'w', [], false, CUE_KINDS)).toMatchObject({ kind: 'decision' })
    expect(parseWriterCue(answer('followUp'), 'challenge', 'w', [], false, CUE_KINDS)).toMatchObject({ kind: 'followUp' })
    expect(parseWriterCue(answer('urgent'), 'reinforce', 'w', [], false, CUE_KINDS)).toMatchObject({ kind: 'reinforce' })
    expect(parseWriterCue(answer('challenge'), 'reinforce', 'w', [])).toMatchObject({ kind: 'challenge' })
  })
  it('defaults: a real Mac capture id is extended; a glasses id, or a malformed mac_ id, is legacy', () => {
    expect(defaultCueKindSet(MAC)).toBe('extended')
    expect(defaultCueKindSet(G2)).toBe('legacy')
    expect(defaultCueKindSet('mac_notacapture')).toBe('legacy')
  })
  it('COS_LIVE_CUES_V2_MAC is forwarded by the managed runtime contract', () => {
    const c = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    expect(c.optionalEnvironment).toContain('COS_LIVE_CUES_V2_MAC')
  })
  it('COS_LIVE_CUES_V2_MAC=0 is the only value that refuses Mac arming', () => {
    expect(liveCuesV2MacAllowed({})).toBe(true)
    expect(liveCuesV2MacAllowed({ COS_LIVE_CUES_V2_MAC: '1' })).toBe(true)
    expect(liveCuesV2MacAllowed({ COS_LIVE_CUES_V2_MAC: ' 0 ' })).toBe(false)
  })
})

describe('6.86.0 engine: kinds per meeting, Mac recordings', () => {
  let dir: string
  let clock: number
  let emitted: Array<{ type: string; data: Record<string, unknown> }>
  let traces: Array<Record<string, unknown>>
  let systems: string[]
  let logged: Array<Record<string, unknown>>
  let writerKind: string
  let env: NodeJS.ProcessEnv
  let storedSetting: boolean | null
  let limits: Record<string, number>
  let store: InstanceType<typeof LiveCuesV2Store>
  let gateCalls: number
  function engine(over: Partial<Deps> = {}) {
    const deps: Deps = {
      gate: async () => { gateCalls++; return { pCue: 0.9, kind: 'challenge', lookup: null, tokens: 1000 } },
      memory: async () => ({ notes: [] }),
      notes: async () => ({ notes: [] }),
      judge: async () => ({ probs: {}, tokens: 0 }),
      writer: async (_m, system) => { systems.push(system); return { text: JSON.stringify({ cue: 'The room agreed the pilot runs in two stores first.', kind: writerKind, memoryIds: [] }), model: 'claude-sonnet-5-5' } },
      emit: (type, data) => {
        if (type === 'coaching_nudge_v2') expect(isLiveCueV2(data)).toBe(true)
        emitted.push({ type, data })
      },
      lease: () => ({ release: () => {} }) as unknown as import('./maintenance-lifecycle.js').MaintenanceWorkLease,
      busy: () => false,
      decisionProvider: () => 'jev',
      decisionState: () => ({ configured: true, breakerOpen: false, capReached: false }),
      memorySource: () => 'cue_memory',
      settings: { stored: () => storedSetting, limits: () => limits },
      warmMemory: () => {},
      now: () => new Date(clock),
      store,
      trace: row => { traces.push(row) },
      cueLog: row => { logged.push(row as unknown as Record<string, unknown>) },
      env,
      ...over,
    }
    return new LiveCuesV2Engine(deps)
  }
  const evaluations = () => traces.filter(t => t.kind === 'evaluation')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cues-v2-kinds-'))
    clock = Date.parse('2026-10-22T15:00:00Z')
    emitted = []; traces = []; systems = []; logged = []; writerKind = 'decision'; storedSetting = null; limits = {}; gateCalls = 0
    env = { COS_LIVE_CUES_V2: '1' }
    store = new LiveCuesV2Store(join(dir, 'state.json'), () => new Date(clock))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a Mac recording is armed with the five kinds, runs v4, and its decision cue reaches v2 as decision and v1 as reinforce', async () => {
    const e = engine()
    const armed = e.arm(MAC)
    expect(armed).toMatchObject({ armed: true, sessionId: MAC, kinds: [...CUE_KINDS] })
    await e.feed(MAC, words(L.minNewWords))
    expect(systems).toEqual([kindsPrompt.CUE_WRITER_SYSTEM_V4])
    expect(emitted.map(x => x.type)).toEqual(['coaching_nudge_v2', 'coaching_nudge'])
    expect(emitted[0].data).toMatchObject({ kind: 'decision', sessionId: MAC })
    expect(emitted[1].data).toMatchObject({ type: 'reinforce', cueId: emitted[0].data.cueId })
    expect(logged[0]).toMatchObject({ kind: 'decision', prompt: 'v4', meetingTitle: expect.stringMatching(/^Mac Recording /) })
    expect(evaluations().at(-1)).toMatchObject({ outcome: 'cue', prompt: 'v4', kindSet: 'extended' })
    expect(e.status(MAC).session?.cues[0].kind).toBe('decision')
    // The stop answer's v1 nudges carry the legacy type; the cues keep the real kind.
    const stop = e.end(MAC)
    expect(stop.nudges[0]).toMatchObject({ type: 'reinforce' })
    expect(stop.cues[0].kind).toBe('decision')
  })

  it('a followUp on a Mac recording reads as challenge to a v1 reader', async () => {
    writerKind = 'followUp'
    const e = engine(); e.arm(MAC)
    await e.feed(MAC, words(L.minNewWords))
    expect(emitted.map(x => [x.type, x.data.kind ?? x.data.type])).toEqual([['coaching_nudge_v2', 'followUp'], ['coaching_nudge', 'challenge']])
  })

  it('a glasses meeting keeps the legacy kinds and v3: a writer that answers promise is shown the gate kind', async () => {
    writerKind = 'promise'
    const e = engine()
    expect(e.arm(G2)).toMatchObject({ kinds: ['reinforce', 'challenge'] })
    await e.feed(G2, words(L.minNewWords))
    expect(systems).toEqual([prompts.CUE_WRITER_SYSTEM_V3])
    expect(emitted[0].data).toMatchObject({ kind: 'challenge' })
    expect(logged[0]).toMatchObject({ kind: 'challenge', prompt: 'v3', meetingTitle: expect.stringMatching(/^G2 Recording /) })
    expect(evaluations().at(-1)).not.toHaveProperty('kindSet')
  })

  it('a glasses meeting armed with kinds extended gets them; a repeat arm keeps the kinds the meeting started with', async () => {
    const e = engine()
    expect(e.arm(G2, { kinds: 'extended' })).toMatchObject({ kinds: [...CUE_KINDS] })
    expect(e.arm(G2)).toMatchObject({ kinds: [...CUE_KINDS] })
    expect(e.arm(MAC, { kinds: 'legacy' })).toMatchObject({ kinds: ['reinforce', 'challenge'] })
    expect(e.arm(MAC, { kinds: 'extended' })).toMatchObject({ kinds: ['reinforce', 'challenge'] })
  })

  it('COS_LIVE_CUES_V2_MAC=0 refuses a Mac recording (403 mac_cues_off) and leaves glasses meetings alone', async () => {
    env = { COS_LIVE_CUES_V2: '1', COS_LIVE_CUES_V2_MAC: '0' }
    const e = engine()
    expect(() => e.arm(MAC)).toThrow(expect.objectContaining({ code: 'mac_cues_off', status: 403 }))
    expect(e.arm(G2)).toMatchObject({ armed: true })
    // Not by auto-arm either.
    env.COS_LIVE_CUES_AUTO = '1'
    await e.feed(MAC, words(L.minNewWords))
    expect(gateCalls).toBe(0)
    expect(e.knows(MAC)).toBe(false)
  })

  it('the master switch off: a Mac recording cannot be armed and a feed spends nothing', async () => {
    env = {}
    const e = engine()
    expect(() => e.arm(MAC)).toThrow(expect.objectContaining({ code: 'master_flag_off' }))
    await e.feed(MAC, words(L.minNewWords))
    expect(gateCalls).toBe(0)
  })

  it('a Mac recording obeys the limits COS Control saves: the daily writer ceiling stops it before the gate', async () => {
    limits = { dailyWriterCalls: 1 }
    const e = engine(); e.arm(MAC)
    await e.feed(MAC, words(L.minNewWords))
    expect(gateCalls).toBe(1)
    clock += L.cooldownAfterCueMs + L.minIntervalMs
    await e.feed(MAC, words(L.minNewWords))
    expect(gateCalls).toBe(1)
    expect(traces.filter(t => t.kind === 'skip').map(t => t.reason)).toContain('daily_cap')
    // And the per-meeting cue cap.
    limits = { maxCuesPerMeeting: 1 }
    clock += L.cooldownAfterCueMs + L.minIntervalMs
    await e.feed(MAC, words(L.minNewWords))
    expect(gateCalls).toBe(1)
    expect(e.status(MAC).session).toMatchObject({ state: 'stopped', reason: 'meeting_cap' })
  })

  it('resume: a Mac recording armed with resume is re-armed after a restart with its kinds; without resume it is not', async () => {
    engine().arm(MAC, { resume: true })
    engine().arm(G2)                                            // no resume
    expect(store.resumeKinds(MAC)).toBe('extended')
    expect(store.resumeKinds(G2)).toBeNull()
    const restarted = engine()                                   // same durable store, empty memory
    await restarted.feed(G2, words(L.minNewWords))
    expect(restarted.knows(G2)).toBe(false)
    await restarted.feed(MAC, words(L.minNewWords))
    expect(restarted.knows(MAC)).toBe(true)
    expect(traces.find(t => t.kind === 'resume')).toEqual({ kind: 'resume', at: new Date(clock).toISOString(), sessionId: MAC, kindSet: 'extended' })
    expect(emitted[0].data).toMatchObject({ kind: 'decision', sessionId: MAC })
    // A legacy meeting resumed keeps legacy.
    engine().arm(G2.replace('g2_', 'g2_9'), { resume: true, kinds: 'legacy' })
    expect(store.resumeKinds(G2.replace('g2_', 'g2_9'))).toBe('legacy')
  })

  it('resume re-arms with the kinds the meeting was armed with, not the default for its id', async () => {
    const opted = 'g2_1760000000777'
    engine().arm(opted, { resume: true, kinds: 'extended' })
    const restarted = engine()
    await restarted.feed(opted, words(L.minNewWords))
    expect(emitted[0].data).toMatchObject({ kind: 'decision', sessionId: opted })
  })

  it('a later arm with resume (the Mac start re-asked) records resume for a meeting already armed without it', () => {
    const e = engine()
    e.arm(MAC)
    expect(store.resumeKinds(MAC)).toBeNull()
    e.arm(MAC, { resume: true })
    expect(store.resumeKinds(MAC)).toBe('extended')
  })

  it('the store never records resume for an ended meeting', () => {
    store.end(MAC)
    store.setResume(MAC, 'extended')
    expect(store.resumeKinds(MAC)).toBeNull()
  })

  it('resume ends with the meeting: after Stop or save a restarted server does not re-arm it', async () => {
    const e = engine(); e.arm(MAC, { resume: true })
    e.end(MAC)
    expect(store.resumeKinds(MAC)).toBeNull()
    const restarted = engine()
    await restarted.feed(MAC, words(L.minNewWords))
    expect(restarted.knows(MAC)).toBe(false)
    expect(gateCalls).toBe(0)
  })

  it('resume records expire with the counters (24 h) and a malformed one is dropped', () => {
    engine().arm(MAC, { resume: true })
    clock += L.counterTtlMs + 1
    expect(store.resumeKinds(MAC)).toBeNull()
    const file = join(dir, 'state.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.resume = { [MAC]: { at: clock, kinds: 'everything' }, other_x: { at: clock, kinds: 'extended' } }
    writeFileSync(file, JSON.stringify(raw))
    expect(store.resumeKinds(MAC)).toBeNull()
    expect(store.resumeKinds('other_x')).toBe('extended')
  })
})

describe('6.86.0 armMacLiveCues (the Mac recording start)', () => {
  // The singleton writes under the suite's isolated COS_DATA_DIR (vitest.config.ts), resolved at import.
  const saved = { ...process.env }
  afterEach(() => { mod.shutdownLiveCuesV2(); process.env = { ...saved } })

  it('v2 off answers master_flag_off and never builds the engine (so never the v1 Composer path)', () => {
    expect(mod.armMacLiveCues(MAC, {})).toEqual({ armed: false, reason: 'master_flag_off' })
    expect(mod.peekLiveCuesV2()).toBeNull()
  })
  it('the Mac kill switch answers mac_cues_off and never builds the engine', () => {
    expect(mod.armMacLiveCues(MAC, { COS_LIVE_CUES_V2: '1', COS_LIVE_CUES_V2_MAC: '0' })).toEqual({ armed: false, reason: 'mac_cues_off' })
    expect(mod.peekLiveCuesV2()).toBeNull()
  })
  it('v2 on arms with the five kinds and resume; an ended meeting answers meeting_ended instead of throwing', () => {
    process.env.COS_LIVE_CUES_V2 = '1'; delete process.env.ANTHROPIC_API_KEY
    expect(mod.armMacLiveCues(MAC, process.env)).toEqual({ armed: true, kinds: [...CUE_KINDS], cuesGenerated: 0, paused: false, pauseSeq: 0 })
    expect(mod.liveCuesV2().knows(MAC)).toBe(true)
    expect(new LiveCuesV2Store(dataPath('live-cues-v2-state.json'), () => new Date()).resumeKinds(MAC)).toBe('extended')
    mod.liveCuesV2().end(MAC)
    expect(mod.armMacLiveCues(MAC, process.env)).toEqual({ armed: false, reason: 'meeting_ended' })
  })
})
