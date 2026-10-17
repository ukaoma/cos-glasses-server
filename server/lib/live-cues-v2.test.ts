import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./jev.js', async (orig) => ({ ...(await orig<typeof import('./jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))

const mod = await import('./live-cues-v2.js')
const { LiveCuesV2Engine, LiveCuesV2Store, LIVE_CUES_V2_LIMITS, cueHeadline, localWeekStart, parseWriterCue, pyJson, unsupportedNumbers } = mod
type Deps = import('./live-cues-v2.js').LiveCuesV2Deps

const words = (n: number, w = 'budget') => Array.from({ length: n }, () => w).join(' ')

describe('pure helpers', () => {
  it('headline is the first sentence when it fits, else a word cut with an ellipsis, never over 64', () => {
    expect(cueHeadline('Name an owner for the redirect. The client asked twice.')).toBe('Name an owner for the redirect')
    const long = cueHeadline('The rebrand add-on lists five hundred and fifty pages while staging only has a fraction of them cloned so far')
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long.endsWith('…')).toBe(true)
  })
  it('number guard: invented multi-digit numbers and dollar amounts fail; spoken ones and single digits pass', () => {
    expect(unsupportedNumbers('Cap categories at 12 by Nov 15', 'we have twelve categories', [])).toEqual(['12', '15'])
    expect(unsupportedNumbers('The $8,700 gap', 'off by $8,700 on one budget', [])).toEqual([])
    expect(unsupportedNumbers('Pick 1 owner', 'nobody owns it', [])).toEqual([])
    // The memory note's date counts as support ("Jun 29" from a 2026-06-29 note); a different day does not.
    expect(unsupportedNumbers('Jun 29 review found 62%', 'organic', [{ id: 'M1', date: '2026-06-29', title: 't', notes: '62% of comp' }])).toEqual([])
    expect(unsupportedNumbers('Jun 30 review found 62%', 'organic', [{ id: 'M1', date: '2026-06-29', title: 't', notes: '62% of comp' }])).toEqual(['30'])
  })
  it('parseWriterCue rejects null, junk, long and unsupported numbers, and keeps only kept memory ids', () => {
    const kept = [{ id: 'M1', date: '2026-10-01', title: 'Q4', notes: 'Summary: 12% cut' }]
    expect(parseWriterCue('null', 'challenge', 'w', kept)).toBe('null')
    expect(parseWriterCue('no json here', 'challenge', 'w', kept)).toBe('unparseable')
    expect(parseWriterCue(JSON.stringify({ cue: 'x'.repeat(221) }), 'challenge', 'w', kept)).toBe('too_long')
    expect(parseWriterCue(JSON.stringify({ cue: 'Ship by the 30th' }), 'challenge', 'ship soon', kept, true)).toBe('unsupported_number')
    expect(parseWriterCue(JSON.stringify({ cue: 'Ship by the 30th' }), 'challenge', 'ship soon', kept)).toMatchObject({ numberFlags: ['30'] })
    const ok = parseWriterCue('```json\n' + JSON.stringify({ cue: 'Keep the 12% cut — it held', kind: 'reinforce', memoryIds: ['M1', 'M9'] }) + '\n```', 'challenge', 'w', kept)
    expect(ok).toEqual({ detail: 'Keep the 12% cut - it held', kind: 'reinforce', memoryIds: ['M1'], numberFlags: [] })
  })
  it('pyJson matches Python json.dumps byte for byte (the replay built prompts with it)', () => {
    expect(pyJson({ meetingTitle: 'G2 Recording 2026-10-17 1100', liveIssue: '', suggestedKind: 'challenge', previousCues: ['Set a date — now'],
      memory: [{ id: 'M1', date: '2026-10-01', title: 'Q4 plan', notes: 'Summary: 12% cut' }], window: "we'll ship by Friday\nno owner yet" }))
      .toBe('{"meetingTitle": "G2 Recording 2026-10-17 1100", "liveIssue": "", "suggestedKind": "challenge", "previousCues": ["Set a date \\u2014 now"], "memory": [{"id": "M1", "date": "2026-10-01", "title": "Q4 plan", "notes": "Summary: 12% cut"}], "window": "we\'ll ship by Friday\\nno owner yet"}')
  })
  it('local week starts Monday in the stored zone: Sunday 19:30 Central is still last week (the old UTC key flipped here)', () => {
    expect(localWeekStart(new Date('2026-10-19T00:30:00Z'), 'America/Chicago')).toBe('2026-10-12')
    expect(localWeekStart(new Date('2026-10-19T05:10:00Z'), 'America/Chicago')).toBe('2026-10-19')
    expect(localWeekStart(new Date('2026-10-18T12:00:00Z'), 'UTC')).toBe('2026-10-12')
  })
})

describe('durable store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cues-v2-store-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const at = (iso: string) => () => new Date(iso)
  it('charges until the cap, then refuses; a new local week starts at zero', () => {
    const s = new LiveCuesV2Store(join(dir, 's.json'), at('2026-10-14T15:00:00Z'))
    expect(s.charge(2)).toBe(true); expect(s.charge(2)).toBe(true); expect(s.charge(2)).toBe(false)
    expect(new LiveCuesV2Store(join(dir, 's.json'), at('2026-10-21T15:00:00Z')).charge(2)).toBe(true)
  })
  it('an unreadable ledger or a future week key fails closed for the week', () => {
    writeFileSync(join(dir, 'bad.json'), '{not json')
    expect(new LiveCuesV2Store(join(dir, 'bad.json'), at('2026-10-14T15:00:00Z')).charge(300)).toBe(false)
    writeFileSync(join(dir, 'f.json'), JSON.stringify({ zone: 'UTC', weekStart: '2027-01-04', writerCalls: 0, ended: {}, paused: {} }))
    expect(new LiveCuesV2Store(join(dir, 'f.json'), at('2026-10-14T15:00:00Z')).charge(300)).toBe(false)
  })
  it('tombstones survive a new store instance and expire after 7 days; pause round-trips', () => {
    new LiveCuesV2Store(join(dir, 't.json'), at('2026-10-14T15:00:00Z')).end('meeting_a')
    expect(new LiveCuesV2Store(join(dir, 't.json'), at('2026-10-15T15:00:00Z')).isEnded('meeting_a')).toBe(true)
    expect(new LiveCuesV2Store(join(dir, 't.json'), at('2026-10-22T16:00:00Z')).isEnded('meeting_a')).toBe(false)
    const p = new LiveCuesV2Store(join(dir, 'p.json'), at('2026-10-14T15:00:00Z'))
    p.setPaused('m', true); expect(p.isPaused('m')).toBe(true); p.setPaused('m', false); expect(p.isPaused('m')).toBe(false)
  })
})

describe('engine', () => {
  let dir: string
  let clock: number
  let emitted: Array<{ type: string; data: Record<string, unknown> }>
  let traces: Array<Record<string, unknown>>
  let calls: { gate: number; memory: number; judge: number; writer: number; prompts: string[] }
  let pCue: number
  let writerText: () => Promise<string>
  let env: NodeJS.ProcessEnv
  function engine(over: Partial<Deps> = {}) {
    const deps: Deps = {
      gate: async () => { calls.gate++; return { pCue, kind: 'challenge', lookup: null, tokens: 1000 } },
      memory: async () => { calls.memory++; return [
        { id: 'M1', date: '2026-10-01', title: 'Kept A', notes: 'Summary: redirect pricing 12% overage' },
        { id: 'M2', date: '2026-09-20', title: 'Dropped', notes: 'Summary: unrelated' },
        { id: 'M3', date: '2026-09-01', title: 'Kept B', notes: 'Summary: client asked for a cap' }] },
      judge: async () => { calls.judge++; return { probs: { M1: 0.91, M2: 0.79, M3: 0.85, none: 0.02 }, tokens: 900 } },
      writer: async (_m, _s, prompt) => { calls.writer++; calls.prompts.push(prompt); return { text: await writerText(), costUsd: 0.003, model: 'claude-sonnet-5-5' } },
      emit: (type, data) => { emitted.push({ type, data }) },
      lease: () => ({ release: () => {} }) as unknown as import('./maintenance-lifecycle.js').MaintenanceWorkLease,
      now: () => new Date(clock),
      store: new LiveCuesV2Store(join(dir, 'state.json'), () => new Date(clock)),
      trace: row => { traces.push(row) },
      env,
      ...over,
    }
    return new LiveCuesV2Engine(deps)
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cues-v2-engine-'))
    clock = Date.parse('2026-10-14T15:00:00Z')
    emitted = []; traces = []; calls = { gate: 0, memory: 0, judge: 0, writer: 0, prompts: [] }
    pCue = 0.9
    writerText = async () => JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: ['M1'] })
    env = { COS_LIVE_CUES: '1', COS_LIVE_CUES_V2: '1' }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('does nothing when either master switch is off', async () => {
    env = { COS_LIVE_CUES: '1' }
    const e = engine()
    await e.feed('meeting_a', words(80))
    expect(calls.gate).toBe(0)
    expect(e.capability()).toMatchObject({ available: false, reason: 'master_flag_off', protocol: 2 })
  })

  it('a cue runs gate, memory, judge (keeps >= 0.8, max 2, re-numbered) and ONE writer, then emits v2 and v1 with one cueId', async () => {
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(45))
    expect(calls).toMatchObject({ gate: 1, memory: 1, judge: 1, writer: 1 })
    const prompt = JSON.parse(calls.prompts[0]) as { memory: Array<{ id: string; title: string }> }
    expect(prompt.memory.map(m => [m.id, m.title])).toEqual([['M1', 'Kept A'], ['M2', 'Kept B']])
    expect(emitted.map(x => x.type)).toEqual(['coaching_nudge_v2', 'coaching_nudge'])
    const [v2, v1] = emitted.map(x => x.data)
    expect(v1.cueId).toBe(v2.cueId)
    expect(v1.nudge).toBe(v2.headline)
    expect(v2).toMatchObject({ protocol: 2, kind: 'challenge', sources: [{ id: 'M1', date: '2026-10-01', title: 'Kept A' }] })
    expect(traces.at(-1)).toMatchObject({ outcome: 'cue', kept: 2, candidates: 3 })
  })

  it('the judge keeps at most two notes even when three pass, in rank order', async () => {
    const e = engine({ judge: async () => { calls.judge++; return { probs: { M1: 0.95, M2: 0.9, M3: 0.85 }, tokens: 900 } } }); e.arm('meeting_a')
    await e.feed('meeting_a', words(45))
    const prompt = JSON.parse(calls.prompts[0]) as { memory: Array<{ title: string }> }
    expect(prompt.memory.map(m => m.title)).toEqual(['Kept A', 'Dropped'])
  })

  it('below the gate threshold nothing else runs (default 0.8)', async () => {
    pCue = 0.79
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(45))
    expect(calls).toMatchObject({ gate: 1, memory: 0, judge: 0, writer: 0 })
    expect(traces.at(-1)?.outcome).toBe('gate_silent')
  })

  it('cadence: under 40 new words, or within 20 s of the last evaluation, does not evaluate', async () => {
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(39)); expect(calls.gate).toBe(0)
    await e.feed('meeting_a', words(5)); expect(calls.gate).toBe(1)
    pCue = 0.1
    clock += LIVE_CUES_V2_LIMITS.minIntervalMs - 1
    await e.feed('meeting_a', words(60)); expect(calls.gate).toBe(1)
    clock += LIVE_CUES_V2_LIMITS.cooldownAfterCueMs
    await e.feed('meeting_a', words(1)); expect(calls.gate).toBe(2)
  })

  it('Stop tombstones the meeting: trailing chunks never re-arm it, even with auto-arm on', async () => {
    env.COS_LIVE_CUES_AUTO = '1'
    const e = engine(); e.arm('meeting_a')
    e.end('meeting_a')
    await e.feed('meeting_a', words(90))
    expect(calls.gate).toBe(0)
    expect(() => e.arm('meeting_a')).toThrow(/ended/)
    expect(e.status('meeting_a').session).toMatchObject({ ended: true })
  })

  it('pause mid-flight cancels without counting a failure, and a paused meeting is not evaluated', async () => {
    let release!: () => void
    const seen: { signal: AbortSignal | null } = { signal: null }
    writerText = () => new Promise(r => { release = () => r(JSON.stringify({ cue: 'Name an owner today.' })) })
    const e = engine({ writer: async (_m, _s, prompt, signal) => { calls.writer++; calls.prompts.push(prompt); seen.signal = signal; return { text: await writerText() } } }); e.arm('meeting_a')
    const run = e.feed('meeting_a', words(45))
    await vi.waitFor(() => expect(calls.writer).toBe(1))
    e.setPaused('meeting_a', true)
    expect(seen.signal?.aborted).toBe(true)   // the writer process is told to stop now, not after it finishes
    release(); await run
    expect(emitted).toEqual([])
    expect(traces.at(-1)?.outcome).toBe('cancelled')
    clock += 60_000
    await e.feed('meeting_a', words(60))
    expect(calls.gate).toBe(1)
  })

  it('three real writer failures open the breaker; the next window is not evaluated', async () => {
    writerText = async () => { throw new Error('claude exited 1') }
    const e = engine(); e.arm('meeting_a')
    for (let i = 0; i < 3; i++) { await e.feed('meeting_a', words(45)); clock += 60_000 }
    expect(calls.writer).toBe(3)
    await e.feed('meeting_a', words(45))
    expect(calls.gate).toBe(3)
  })

  it('the weekly ceiling is charged before the writer and never refunded', async () => {
    env.COS_LIVE_CUES_V2_WEEKLY = '1'
    writerText = async () => 'null'
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(45)); clock += 60_000
    await e.feed('meeting_a', words(45))
    expect(calls.writer).toBe(1)
    expect(traces.at(-1)?.outcome).toBe('budget_exhausted')
  })

  it('an invented number is traced by default and withheld when enforced; a stale cue (room moved on) is dropped', async () => {
    writerText = async () => JSON.stringify({ cue: 'Lock the 45 page cap by the 30th.' })
    const e0 = engine({ store: new LiveCuesV2Store(join(dir, 'state0.json'), () => new Date(clock)) }); e0.arm('meeting_z')
    await e0.feed('meeting_z', words(45))
    expect(emitted.map(x => x.type)).toEqual(['coaching_nudge_v2', 'coaching_nudge'])
    expect(traces.at(-1)).toMatchObject({ outcome: 'cue', numberFlags: 2 })
    emitted = []
    env.COS_LIVE_CUES_V2_NUMBER_GUARD = 'withhold'
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(45))
    expect(emitted).toEqual([])
    expect(traces.at(-1)?.outcome).toBe('withheld_unsupported_number')
    delete env.COS_LIVE_CUES_V2_NUMBER_GUARD

    const e2 = engine({ store: new LiveCuesV2Store(join(dir, 'state2.json'), () => new Date(clock)) })
    e2.arm('meeting_b')
    writerText = async () => { void e2.feed('meeting_b', words(130)); return JSON.stringify({ cue: 'Name an owner today.' }) }
    await e2.feed('meeting_b', words(45))
    expect(emitted).toEqual([])
    expect(traces.at(-1)?.outcome).toBe('stale')
  })

  it('refuses to run with an Anthropic API key in the environment unless API fallback is approved', () => {
    env.ANTHROPIC_API_KEY = 'sk-test'
    expect(engine().capability()).toMatchObject({ available: false, reason: 'api_key_in_env' })
    env.COS_ALLOW_API_FALLBACK = '1'
    expect(engine().capability()).toMatchObject({ available: true })
  })

  it('feedback is recorded with whether the cue is known; no transcript text is traced', async () => {
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(45, 'secretword'))
    const cueId = String(emitted[0].data.cueId)
    expect(e.recordFeedback({ sessionId: 'meeting_a', cueId, vote: 'down', reason: '  wrong   client ' })).toEqual({ ok: true, knownCue: true })
    expect(traces.at(-1)).toMatchObject({ kind: 'feedback', vote: 'down', reason: 'wrong client', knownCue: true })
    expect(JSON.stringify(traces)).not.toContain('secretword')
  })
})
