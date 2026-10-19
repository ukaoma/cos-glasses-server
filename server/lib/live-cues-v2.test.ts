import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./jev.js', async (orig) => ({ ...(await orig<typeof import('./jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))

const mod = await import('./live-cues-v2.js')
const prompts = await import('./live-cues-v2-prompts.js')
const contract = await import('../../shared/live-cues-v2.js')
const { JevError, JEV_MODEL, jevCancelled } = await import('./jev.js')
const { LensGistLimitError } = await import('./lens-gist-engines.js')
const { MaintenanceLifecycleError } = await import('./maintenance-lifecycle.js')
const { DecisionProviderError } = await import('./decision-provider.js')
const { LiveCuesV2Engine, LiveCuesV2Store, LIVE_CUES_V2_LIMITS: L, cueHeadline, cueMemory, localWeekStart, parseWriterCue, pyJson, sourceId, unsupportedNumbers } = mod
const { isLiveCueV2, CUE_HEADLINE_MAX, CUE_DETAIL_MAX } = contract
type Deps = import('./live-cues-v2.js').LiveCuesV2Deps

const words = (n: number, w = 'budget') => Array.from({ length: n }, () => w).join(' ')
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' && v.startsWith('FILE:') ? readFileSync(v.slice(5)) : JSON.stringify(v)).digest('hex')

describe('pins', () => {
  it('the prompts are the exact strings the dev and held-out replays measured (regenerate with cue_rrf_replay/generate_server_prompts.py)', () => {
    expect(sha(prompts.CUE_GATE_QUESTIONS)).toBe('d56f6d203da47c47693349189f7e27df516333dc1afb0a14ea86fcb9dcbd51f5')
    expect(sha(prompts.CUE_JUDGE_INSTRUCTIONS)).toBe('47933f3ef6f75cadcd0ae635e6b6ba43311fdc3ca4d4882de63dcab40f3852ef')
    expect(sha(prompts.CUE_JUDGE_NONE)).toBe('d62ab46522f2d4e1c080e770812936549ea3c169439ceada4795394180460f57')
    expect(sha(prompts.CUE_WRITER_SYSTEM_V2)).toBe('c485da99f38e74ad51e4bf537578c488876542e43419e5db0608db567fcdc301')
    expect(sha(prompts.CUE_WRITER_SYSTEM_V3)).toBe('62acbdb54d6d2aad0f21b00e7920960b98dc2e723ae075294d5e800e7e5b53f7')
  })
  it('the wire contract matches the companion copy byte for byte (src/lib/live-cues-v2-contract.ts pins the same hash)', () => {
    // 6.76.2: optional capability fields memory and decisionProvider, and four decision_* stop reasons (additive; was df08c712...).
    expect(sha('FILE:' + new URL('../../shared/live-cues-v2.ts', import.meta.url).pathname)).toBe('174728e74100f9ab8067bb7980a15742da73a6155cef0e5eea62c1d7e1a031f7')
  })
  it('the gate threshold was calibrated on jev-1.13.0; a model change needs a new replay', () => {
    expect(JEV_MODEL).toBe('jev-1.13.0')
  })
  it('calibrated thresholds are pinned to their evidence (pooled dev + held-out: gate 0.8 kept 110/113 silent, admitted 51/59 required; judge 0.8)', () => {
    expect(L.defaultGate).toBe(0.8)
    expect(L.judgeKeep).toBe(0.8)
    expect(L.judgeMaxNotes).toBe(2)
  })
  it('per-meeting and weekly caps are the 6.78.2 decision (Miles 2026-10-19: 25 cues; writer calls twice the cues)', () => {
    expect(L.maxCuesPerMeeting).toBe(25)
    expect(L.maxWriterCallsPerMeeting).toBe(2 * L.maxCuesPerMeeting)
    expect(L.defaultWeeklyWriterCalls).toBe(750)
    expect(mod.liveCuesV2WeeklyCap({})).toBe(750)
  })
  it('every v2 flag is forwarded by the managed runtime contract', () => {
    const c = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    for (const key of ['COS_LIVE_CUES_V2', 'COS_LIVE_CUES_V2_GATE', 'COS_LIVE_CUES_V2_MODEL', 'COS_LIVE_CUES_V2_PROMPT', 'COS_LIVE_CUES_V2_WEEKLY', 'COS_LIVE_CUES_V2_NUMBER_GUARD', 'COS_LIVE_CUES_JEV_DAILY_TOKENS'])
      expect(c.optionalEnvironment, key).toContain(key)
  })
})

describe('jev client cancel', () => {
  it('a caller abort throws a cancel and never grows the Jev breaker; a real network error still counts', async () => {
    const { JevClient } = await import('./jev.js')
    const dir = mkdtempSync(join(tmpdir(), 'cues-v2-jev-'))
    const savedKey = process.env.TYPESAFE_API_KEY
    process.env.TYPESAFE_API_KEY = 'test-key-not-real'   // the client resolves its key internally; a throwaway env key lets it reach fetch
    const abortingFetch = ((_u: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => {
      if (init.signal.aborted) reject(new Error('aborted')); init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    const c = new JevClient(abortingFetch, () => new Date(), join(dir, 'u.json'), () => 1e9)
    for (let i = 0; i < 4; i++) {
      const ac = new AbortController(); ac.abort()
      await expect(c.ask({}, {}, 1, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    }
    expect(c.status().breakerOpenUntil).toBeNull()
    const failing = new JevClient((async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch, () => new Date(), join(dir, 'u2.json'), () => 1e9)
    for (let i = 0; i < 3; i++) await expect(failing.ask({}, {}, 1)).rejects.toMatchObject({ code: 'jev_unavailable' })
    expect(failing.status().breakerOpenUntil).not.toBeNull()
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('pure helpers', () => {
  it('headline: first sentence when it fits, else a word cut with an ellipsis; never empty, never over the max', () => {
    expect(cueHeadline('Name an owner for the redirect. The client asked twice.')).toBe('Name an owner for the redirect')
    const long = cueHeadline('The rebrand add-on lists five hundred and fifty pages while staging only has a fraction of them cloned so far')
    expect(long.length).toBeLessThanOrEqual(CUE_HEADLINE_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(cueHeadline('. x').length).toBeGreaterThan(0)
  })
  it('number guard: invented multi-digit numbers and dollar amounts flag; spoken ones, memory dates and single digits pass', () => {
    expect(unsupportedNumbers('Cap categories at 12 by Nov 15', 'we have twelve categories', [])).toEqual(['12', '15'])
    expect(unsupportedNumbers('The $8,700 gap', 'off by $8,700 on one budget', [])).toEqual([])
    expect(unsupportedNumbers('Pick 1 owner', 'nobody owns it', [])).toEqual([])
    expect(unsupportedNumbers('Jun 29 review found 62%', 'organic', [{ id: 'M1', date: '2026-06-29', title: 't', notes: '62% of comp' }])).toEqual([])
    expect(unsupportedNumbers('Jun 30 review found 62%', 'organic', [{ id: 'M1', date: '2026-06-29', title: 't', notes: '62% of comp' }])).toEqual(['30'])
  })
  it('parseWriterCue rejects null, junk and long cues; flags or withholds invented numbers; keeps unique kept memory ids', () => {
    const kept = [{ id: 'M1', date: '2026-10-01', title: 'Q4', notes: 'Summary: 12% cut' }, { id: 'M2', date: '2026-09-01', title: 'Q3', notes: 'x' }]
    expect(parseWriterCue('null', 'challenge', 'w', kept)).toBe('null')
    expect(parseWriterCue('no json here', 'challenge', 'w', kept)).toBe('unparseable')
    expect(parseWriterCue(JSON.stringify({ cue: 'x'.repeat(CUE_DETAIL_MAX + 1) }), 'challenge', 'w', kept)).toBe('too_long')
    expect(parseWriterCue(JSON.stringify({ cue: 'Ship by the 30th' }), 'challenge', 'ship soon', kept, true)).toBe('unsupported_number')
    expect(parseWriterCue(JSON.stringify({ cue: 'Ship by the 30th' }), 'challenge', 'ship soon', kept)).toMatchObject({ numberFlags: ['30'] })
    const ok = parseWriterCue('```json\n' + JSON.stringify({ cue: 'Keep the 12% cut — it held', kind: 'reinforce', memoryIds: ['M1', 'M9', 'M1', 'M2'] }) + '\n```', 'challenge', 'w', kept)
    expect(ok).toEqual({ detail: 'Keep the 12% cut - it held', kind: 'reinforce', memoryIds: ['M1', 'M2'], numberFlags: [] })
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
  it('a source id is stable per meeting and opaque', () => {
    const a = sourceId({ id: 'M1', date: '2026-10-01', title: 'Q4', notes: '', key: 'quilt/2026-10-01_Q4.md' })
    expect(a).toBe(sourceId({ id: 'M2', date: 'x', title: 'y', notes: 'z', key: 'quilt/2026-10-01_Q4.md' }))
    expect(a).toMatch(/^mtg_[0-9a-f]{12}$/)
  })
  it('isLiveCueV2 rejects a source without an id, an over-long headline, or a third source', () => {
    const cue = { protocol: 2, cueId: 'c1', sessionId: 'm', headline: 'Name an owner', detail: 'Name an owner today.', kind: 'challenge',
      sources: [{ id: 'mtg_1', date: '2026-10-01', title: 'Q4' }], gate: 0.9, createdAt: 1, model: 'claude-sonnet-5-5' }
    expect(isLiveCueV2(cue)).toBe(true)
    expect(isLiveCueV2({ ...cue, sources: [{ date: '2026-10-01', title: 'Q4' }] })).toBe(false)
    expect(isLiveCueV2({ ...cue, headline: 'x'.repeat(CUE_HEADLINE_MAX + 1) })).toBe(false)
    expect(isLiveCueV2({ ...cue, sources: [cue.sources[0], cue.sources[0], cue.sources[0]] })).toBe(false)
  })
})

describe('durable store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cues-v2-store-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const at = (iso: string) => () => new Date(iso)
  it('charges until the cap, then refuses; a new local week starts at zero; per-meeting counters persist', () => {
    const s = new LiveCuesV2Store(join(dir, 's.json'), at('2026-10-14T15:00:00Z'))
    expect(s.charge(2, 'm')).toBe(true); expect(s.charge(2, 'm')).toBe(true); expect(s.charge(2, 'm')).toBe(false)
    s.recordCue('m')
    expect(new LiveCuesV2Store(join(dir, 's.json'), at('2026-10-14T16:00:00Z')).counters('m')).toEqual({ cues: 1, writerCalls: 2 })
    expect(new LiveCuesV2Store(join(dir, 's.json'), at('2026-10-21T15:00:00Z')).charge(2, 'n')).toBe(true)
  })
  it('an unreadable ledger, a null file, an invalid zone or a future week key fails closed for the week', () => {
    for (const [name, body] of [['bad', '{not json'], ['null', 'null'], ['zone', JSON.stringify({ zone: 'Mars/Olympus', weekStart: '2026-10-12', writerCalls: 0 })],
      ['future', JSON.stringify({ zone: 'UTC', weekStart: '2027-01-04', writerCalls: 0 })]] as const) {
      writeFileSync(join(dir, `${name}.json`), body)
      expect(new LiveCuesV2Store(join(dir, `${name}.json`), at('2026-10-14T15:00:00Z')).charge(300, 'm'), name).toBe(false)
    }
  })
  it('tombstones survive a new store instance and expire after 7 days; pause applies only newer sequences', () => {
    new LiveCuesV2Store(join(dir, 't.json'), at('2026-10-14T15:00:00Z')).end('meeting_a')
    expect(new LiveCuesV2Store(join(dir, 't.json'), at('2026-10-15T15:00:00Z')).isEnded('meeting_a')).toBe(true)
    expect(new LiveCuesV2Store(join(dir, 't.json'), at('2026-10-22T16:00:00Z')).isEnded('meeting_a')).toBe(false)
    const p = new LiveCuesV2Store(join(dir, 'p.json'), at('2026-10-14T15:00:00Z'))
    expect(p.setPaused('m', true, 2)).toEqual({ applied: true, paused: true, pauseSeq: 2 })
    expect(p.setPaused('m', false, 1)).toEqual({ applied: false, paused: true, pauseSeq: 2 })   // an older post arriving late loses
    expect(p.setPaused('m', false, 3)).toEqual({ applied: true, paused: false, pauseSeq: 3 })
  })
})

describe('cueMemory subprocess', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cues-v2-mem-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  function fake(body: string) {
    const script = join(dir, 'cue_memory.py'); writeFileSync(script, body); chmodSync(script, 0o700)
    return { python: '/usr/bin/python3', script, cwd: dir }
  }
  it('sends the window on stdin (never argv) and maps notes, the dense error and the index age', async () => {
    const p = fake(`import sys, json\nreq = json.loads(sys.stdin.read())\nassert sys.argv[1:] == ['--stdin']\nprint(json.dumps({"notes": [{"id": "M1", "date": "2026-10-01", "title": "Q4", "notes": "n", "key": "k1"}], "timing": {"dense_error": "QdrantDown"}, "index": {"ageHours": 3.5}, "echo": req["keywordText"][:5]}))\n`)
    const r = await cueMemory('secret window text', '2026-10-18', new AbortController().signal, p)
    expect(r).toEqual({ notes: [{ id: 'M1', date: '2026-10-01', title: 'Q4', notes: 'n', key: 'k1' }], denseError: 'QdrantDown', indexAgeH: 3.5 })
  })
  it('a hung script is killed at the timeout and reported, not mistaken for "no relevant meetings"', async () => {
    const p = fake('import time\ntime.sleep(30)\n')
    const r = await cueMemory('w', '2026-10-18', new AbortController().signal, p, 400)
    expect(r).toEqual({ notes: [], denseError: 'memory_timeout' })
  })
  it('bad output is reported as such', async () => {
    expect(await cueMemory('w', '2026-10-18', new AbortController().signal, fake('print("not json")\n'))).toEqual({ notes: [], denseError: 'bad_output' })
  })
})

describe('engine', () => {
  let dir: string
  let clock: number
  let emitted: Array<{ type: string; data: Record<string, unknown> }>
  let traces: Array<Record<string, unknown>>
  let calls: { gate: number; memory: number; notes: number; judge: number; writer: number; prompts: string[]; providers: string[]; judged: string[][] }
  let storedSetting: boolean | null
  let provider: 'jev' | 'subq'
  let states: Record<'jev' | 'subq', { configured: boolean; breakerOpen: boolean; capReached: boolean }>
  let notesFound: Array<{ id: string; date: string; title: string; notes: string; key: string }>
  let pCue: number
  let writerText: () => Promise<string>
  let busy: boolean
  let env: NodeJS.ProcessEnv
  function engine(over: Partial<Deps> = {}) {
    const deps: Deps = {
      gate: async (_t, _w, _s, p) => { calls.gate++; calls.providers.push(`gate:${p}`); return { pCue, kind: 'challenge', lookup: null, tokens: 1000 } },
      memory: async () => { calls.memory++; return { notes: [
        { id: 'M1', date: '2026-10-01', title: 'Kept A', notes: 'Summary: redirect pricing 12% overage', key: 'a.md' },
        { id: 'M2', date: '2026-09-20', title: 'Dropped', notes: 'Summary: unrelated', key: 'b.md' },
        { id: 'M3', date: '2026-09-01', title: 'Kept B', notes: 'Summary: client asked for a cap', key: 'c.md' }] } },
      notes: async () => { calls.notes++; return { notes: notesFound } },
      judge: async (_t, _w, notes, _s, p) => { calls.judge++; calls.providers.push(`judge:${p}`); calls.judged.push(notes.map(n => n.title)); return { probs: { M1: 0.91, M2: 0.79, M3: 0.85, none: 0.02 }, tokens: 900 } },
      writer: async (_m, _s, prompt) => { calls.writer++; calls.prompts.push(prompt); return { text: await writerText(), costUsd: 0.003, model: 'claude-sonnet-5-5' } },
      emit: (type, data) => {
        if (type === 'coaching_nudge_v2') expect(isLiveCueV2(data), 'every emitted v2 cue passes the shared validator').toBe(true)
        emitted.push({ type, data })
      },
      lease: () => ({ release: () => {} }) as unknown as import('./maintenance-lifecycle.js').MaintenanceWorkLease,
      busy: () => busy,
      decisionProvider: () => provider,
      decisionState: p => states[p],
      memorySource: () => 'cue_memory',
      settings: { stored: () => storedSetting },
      warmMemory: () => {},
      now: () => new Date(clock),
      store: new LiveCuesV2Store(join(dir, 'state.json'), () => new Date(clock)),
      trace: row => { traces.push(row) },
      env,
      ...over,
    }
    return new LiveCuesV2Engine(deps)
  }
  const evaluations = () => traces.filter(t => t.kind === 'evaluation')
  const next = () => { clock += L.cooldownAfterCueMs + L.minIntervalMs }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cues-v2-engine-'))
    clock = Date.parse('2026-10-14T15:00:00Z')
    emitted = []; traces = []; calls = { gate: 0, memory: 0, notes: 0, judge: 0, writer: 0, prompts: [], providers: [], judged: [] }
    storedSetting = null; provider = 'jev'; notesFound = []
    states = { jev: { configured: true, breakerOpen: false, capReached: false }, subq: { configured: false, breakerOpen: false, capReached: false } }
    pCue = 0.9; busy = false
    writerText = async () => JSON.stringify({ cue: 'Overage is 12% with no cap set. Name who quotes the cap today.', kind: 'challenge', memoryIds: ['M1', 'M1'] })
    env = { COS_LIVE_CUES_V2: '1' }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('does nothing when v2 is off, and v2 no longer needs the v1 COS_LIVE_CUES flag', async () => {
    env = { COS_LIVE_CUES: '1' }
    const e = engine()
    await e.feed('meeting_a', words(L.minNewWords * 2))
    expect(calls.gate).toBe(0)
    expect(e.capability()).toMatchObject({ available: false, reason: 'master_flag_off', protocol: 2 })
    env = { COS_LIVE_CUES_V2: '1' }
    expect(engine().capability()).toMatchObject({ available: true })
  })

  it('a cue runs gate, memory, judge (keeps >= 0.8, max 2, re-numbered) and ONE writer, then emits v2 and v1 with one cueId', async () => {
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(calls).toMatchObject({ gate: 1, memory: 1, judge: 1, writer: 1 })
    const prompt = JSON.parse(calls.prompts[0]) as { memory: Array<Record<string, string>> }
    expect(prompt.memory.map(m => [m.id, m.title])).toEqual([['M1', 'Kept A'], ['M2', 'Kept B']])
    expect(Object.keys(prompt.memory[0])).toEqual(['id', 'date', 'title', 'notes'])     // the replay's keys; the meeting key never reaches the prompt
    expect(emitted.map(x => x.type)).toEqual(['coaching_nudge_v2', 'coaching_nudge'])
    const [v2, v1] = emitted.map(x => x.data)
    expect(v1.cueId).toBe(v2.cueId)
    expect(v1.nudge).toBe(v2.headline)
    expect(v2.sources).toEqual([{ id: sourceId({ id: 'M1', date: '2026-10-01', title: 'Kept A', notes: '', key: 'a.md' }), date: '2026-10-01', title: 'Kept A' }])
    expect(evaluations().at(-1)).toMatchObject({ outcome: 'cue', kept: 2, candidates: 3 })
  })

  it('6.79.0: every cue is logged once BEFORE it is held or emitted, with the Friday fields and the last 400 characters said (labels kept)', async () => {
    const logged: Array<Record<string, unknown>> = []
    let e!: InstanceType<typeof LiveCuesV2Engine>
    e = engine({ cueLog: row => {
      expect(emitted).toEqual([])                                        // not emitted yet
      expect(e.findCue(String(row.cueId))).toBeNull()                    // not held yet: a rating that arrives at once finds the log
      logged.push(row as unknown as Record<string, unknown>)
    } })
    e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords) + '\n\n  the  cap  ' + words(120, 'tail') + '\n[7] Speaker 2: agreed on the cap')
    const cue = emitted[0].data
    expect(logged).toHaveLength(1)
    expect(logged[0]).toEqual({ v: 1, cueId: cue.cueId, sessionId: 'meeting_a', meetingTitle: expect.stringMatching(/^G2 Recording /), createdAt: cue.createdAt,
      armedAt: clock, kind: cue.kind, headline: cue.headline, detail: cue.detail, gate: cue.gate, sources: cue.sources, model: cue.model,
      prompt: 'v3', memorySource: 'cue_memory', kept: 2, before: expect.any(String) })
    expect(logged[0].before).toHaveLength(400)
    expect(logged[0].before).toMatch(/ tail Speaker 2: agreed on the cap$/)
    expect(logged[0].before).not.toMatch(/\s{2}/)
    expect(emitted.map(x => x.type)).toEqual(['coaching_nudge_v2', 'coaching_nudge'])
    expect(JSON.stringify(traces)).not.toContain('agreed on the cap')    // the excerpt never reaches the trace
    expect(evaluations().at(-1)).not.toHaveProperty('cueLogError')
    expect(e.findCue(String(cue.cueId))).toMatchObject({ sessionId: 'meeting_a' })
    expect(e.findCue('0f8fad5b-d9cb-469f-a165-70867728950e')).toBeNull()
  })

  it('6.79.0: the notes fallback, an empty memory and the writer rules version are logged as they were', async () => {
    const logged: Array<Record<string, unknown>> = []
    notesFound = [{ id: 'M1', date: '2026-10-01', title: 'Notes', notes: 'Summary: redirect pricing 12% overage', key: 'n.md' }]
    const e = engine({ memory: async () => ({ notes: [], denseError: 'no_cue_memory_script' }), cueLog: row => { logged.push(row as unknown as Record<string, unknown>) } })
    e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(logged[0]).toMatchObject({ memorySource: 'notes', kept: 1, prompt: 'v3' })
    notesFound = []; next(); env.COS_LIVE_CUES_V2_PROMPT = 'v2'
    await e.feed('meeting_a', words(L.minNewWords))
    expect(logged[1]).toMatchObject({ memorySource: 'none', kept: 0, prompt: 'v2' })
  })

  it('6.79.0: a cue log failure is traced on the evaluation, never withholds the cue, and is never a writer failure or a breaker step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    let n = 0
    const e = engine({ cueLog: () => { n += 1; throw Object.assign(new Error('disk full'), n === 1 ? { code: 'ENOSPC' } : {}) } }); e.arm('meeting_a')
    for (let i = 0; i < L.breakerFailures + 1; i++) { await e.feed('meeting_a', words(L.minNewWords)); next() }
    expect(evaluations().map(t => t.outcome)).toEqual(Array(L.breakerFailures + 1).fill('cue'))
    expect(evaluations().map(t => t.cueLogError)).toEqual(['ENOSPC', ...Array(L.breakerFailures).fill('append_failed')])
    expect(evaluations().some(t => 'error' in t)).toBe(false)
    expect(emitted.filter(x => x.type === 'coaching_nudge_v2')).toHaveLength(L.breakerFailures + 1)
    expect(e.status('meeting_a').session).toMatchObject({ state: 'active' })
    expect(e.status('meeting_a').session?.cues).toHaveLength(L.breakerFailures + 1)
    expect(warn).toHaveBeenCalledTimes(L.breakerFailures + 1)
  })

  it('the judge keeps at most two notes even when three pass, in rank order', async () => {
    const e = engine({ judge: async () => { calls.judge++; return { probs: { M1: 0.95, M2: 0.9, M3: 0.85 }, tokens: 900 } } }); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect((JSON.parse(calls.prompts[0]) as { memory: Array<{ title: string }> }).memory.map(m => m.title)).toEqual(['Kept A', 'Dropped'])
  })

  it('below the gate threshold (or a non-numeric gate) nothing else runs', async () => {
    pCue = L.defaultGate - 0.01
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    pCue = Number.NaN; clock += L.minIntervalMs
    await e.feed('meeting_a', words(L.minNewWords))
    expect(calls).toMatchObject({ gate: 2, memory: 0, judge: 0, writer: 0 })
    expect(evaluations().map(t => t.outcome)).toEqual(['gate_silent', 'gate_silent'])
  })

  it('cadence: the word floor, the 20 s interval and the 45 s cooldown after a cue are separate gates', async () => {
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords - 1)); expect(calls.gate).toBe(0)
    await e.feed('meeting_a', words(1)); expect(calls.gate).toBe(1)        // cue emitted at t0
    clock += L.minIntervalMs + 1                                          // past the interval, inside the cooldown
    await e.feed('meeting_a', words(L.minNewWords)); expect(calls.gate).toBe(1)
    clock += L.cooldownAfterCueMs
    await e.feed('meeting_a', words(1)); expect(calls.gate).toBe(2)
    pCue = 0.1; clock += L.minIntervalMs - 1                               // no cue last time: only the interval applies
    await e.feed('meeting_a', words(L.minNewWords)); expect(calls.gate).toBe(2)
  })

  it('single flight: a feed during a long evaluation never starts a second one, even past the interval', async () => {
    let release!: () => void
    writerText = () => new Promise(r => { release = () => r(JSON.stringify({ cue: 'Name an owner today.' })) })
    const e = engine(); e.arm('meeting_a')
    const run = e.feed('meeting_a', words(L.minNewWords))
    await vi.waitFor(() => expect(calls.writer).toBe(1))
    clock += L.minIntervalMs + L.cooldownAfterCueMs
    await e.feed('meeting_a', words(L.minNewWords))
    expect(calls.gate).toBe(1)
    release(); await run
  })

  it('Stop tombstones the meeting: trailing chunks never re-arm it, even with auto-arm on', async () => {
    env.COS_LIVE_CUES_AUTO = '1'
    const e = engine(); e.arm('meeting_a')
    e.end('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords * 2))
    expect(calls.gate).toBe(0)
    expect(() => e.arm('meeting_a')).toThrow(/ended/)
    expect(e.status('meeting_a').session).toMatchObject({ ended: true, state: 'ended' })
  })

  it('pause mid-flight aborts the writer, emits nothing, and a paused meeting is skipped with one trace row', async () => {
    let release!: () => void
    const seen: { signal: AbortSignal | null } = { signal: null }
    writerText = () => new Promise(r => { release = () => r(JSON.stringify({ cue: 'Name an owner today.' })) })
    const e = engine({ writer: async (_m, _s, prompt, signal) => { calls.writer++; calls.prompts.push(prompt); seen.signal = signal; return { text: await writerText() } } }); e.arm('meeting_a')
    const run = e.feed('meeting_a', words(L.minNewWords))
    await vi.waitFor(() => expect(calls.writer).toBe(1))
    e.setPaused('meeting_a', true, 1)
    expect(seen.signal?.aborted).toBe(true)
    release(); await run
    expect(emitted).toEqual([])
    expect(evaluations().at(-1)?.outcome).toBe('cancelled')
    next(); await e.feed('meeting_a', words(L.minNewWords))
    next(); await e.feed('meeting_a', words(L.minNewWords))
    expect(calls.gate).toBe(1)
    expect(traces.filter(t => t.kind === 'skip' && t.reason === 'paused')).toHaveLength(1)   // rate limited
    expect(e.status('meeting_a').session).toMatchObject({ state: 'paused', pauseSeq: 1 })
  })

  it('cancels and maintenance never count toward the breaker; only three real failures open it', async () => {
    // Two cancels (the meeting is paused while the gate runs), then one real failure: the breaker must stay closed.
    let seq = 0
    const box: { e: InstanceType<typeof LiveCuesV2Engine> | null } = { e: null }
    let pauseInGate = true
    box.e = engine({ gate: async (_t, _w, signal) => {
      calls.gate++
      if (pauseInGate) { box.e!.setPaused('meeting_c', true, ++seq); if (signal.aborted) throw jevCancelled() }
      return { pCue, kind: 'challenge', lookup: null, tokens: 1 }
    } })
    const e = box.e
    e.arm('meeting_c')
    for (let i = 0; i < 2; i++) { await e.feed('meeting_c', words(L.minNewWords)); e.setPaused('meeting_c', false, ++seq); next() }
    expect(evaluations().map(t => t.outcome)).toEqual(['cancelled', 'cancelled'])
    expect(calls.writer).toBe(0)
    pauseInGate = false
    writerText = async () => { throw new Error('claude exited 1') }
    await e.feed('meeting_c', words(L.minNewWords)); next()
    expect(e.status('meeting_c').session?.state).toBe('active')           // 2 cancels + 1 failure: still closed
    await e.feed('meeting_c', words(L.minNewWords)); next()
    await e.feed('meeting_c', words(L.minNewWords)); next()
    expect(e.status('meeting_c').session).toMatchObject({ state: 'stopped', reason: 'breaker_open' })
    const writersAtBreaker = calls.writer
    await e.feed('meeting_c', words(L.minNewWords))
    expect(calls.writer).toBe(writersAtBreaker)
    expect(evaluations().filter(t => t.outcome === 'failure').every(t => t.error === 'writer_error')).toBe(true)
    // Maintenance drain: no lease, no evaluation work, and not a failure.
    const m = engine({ lease: () => { throw new MaintenanceLifecycleError('maintenance_draining', 'maintenance draining', { status: 503 }) } }); m.arm('meeting_m')
    await m.feed('meeting_m', words(L.minNewWords))
    expect(evaluations().at(-1)?.outcome).toBe('maintenance')
    expect(m.status('meeting_m').session?.state).toBe('active')
  })

  it('a writer quota error opens the breaker at once; Jev cap and breaker codes stop quietly with a reason, not a failure', async () => {
    writerText = async () => { throw new LensGistLimitError('quota') }
    const q = engine(); q.arm('meeting_q')
    await q.feed('meeting_q', words(L.minNewWords))
    expect(q.status('meeting_q').session).toMatchObject({ state: 'stopped', reason: 'breaker_open' })
    const j = engine({ gate: async () => { calls.gate++; throw new JevError('jev_cap_reached') } }); j.arm('meeting_j')
    await j.feed('meeting_j', words(L.minNewWords))
    expect(evaluations().at(-1)?.outcome).toBe('jev_cap_reached')
    expect(j.status('meeting_j').session).toMatchObject({ state: 'stopped', reason: 'jev_cap_reached' })
    clock += L.minIntervalMs
    await j.feed('meeting_j', words(L.minNewWords))
    expect(calls.gate).toBe(3)                                            // not a breaker failure: it keeps trying
  })

  it('the weekly ceiling is checked before the gate and charged before the writer, never refunded', async () => {
    env.COS_LIVE_CUES_V2_WEEKLY = '1'
    writerText = async () => 'null'
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords)); next()
    await e.feed('meeting_a', words(L.minNewWords))
    expect(calls).toMatchObject({ gate: 1, writer: 1 })                  // the spent week spends no gate tokens either
    expect(traces.at(-1)).toMatchObject({ kind: 'skip', reason: 'budget_exhausted' })
    expect(e.capability()).toMatchObject({ available: false, reason: 'budget_exhausted' })
  })

  it('per-meeting caps hold across a restart (counters are durable)', async () => {
    const e = engine(); e.arm('meeting_a')
    for (let i = 0; i < L.maxCuesPerMeeting; i++) { await e.feed('meeting_a', words(L.minNewWords)); next() }
    expect(emitted.filter(x => x.type === 'coaching_nudge_v2')).toHaveLength(L.maxCuesPerMeeting)
    const restarted = engine(); restarted.arm('meeting_a')
    await restarted.feed('meeting_a', words(L.minNewWords))
    expect(calls.writer).toBe(L.maxCuesPerMeeting)
    expect(restarted.status('meeting_a').session).toMatchObject({ state: 'stopped', reason: 'meeting_cap' })
  })

  it('no evaluation while the user runs their own query', async () => {
    busy = true
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(calls.gate).toBe(0)
    expect(traces.at(-1)).toMatchObject({ kind: 'skip', reason: 'busy' })
  })

  it('stale: a cue is dropped when the room moved on (words) or the evaluation took too long (time)', async () => {
    const e = engine(); e.arm('meeting_b')
    writerText = async () => { void e.feed('meeting_b', words(L.staleWords + 1)); return JSON.stringify({ cue: 'Name an owner today.' }) }
    await e.feed('meeting_b', words(L.minNewWords))
    expect(evaluations().at(-1)?.outcome).toBe('stale')
    next()
    writerText = async () => { clock += L.staleMs + 1; return JSON.stringify({ cue: 'Name an owner today.' }) }
    await e.feed('meeting_b', words(L.minNewWords))
    expect(evaluations().at(-1)?.outcome).toBe('stale')
    expect(emitted).toEqual([])
  })

  it('an invented number is traced by default and withheld when enforced', async () => {
    writerText = async () => JSON.stringify({ cue: 'Lock the 45 page cap by the 30th.' })
    const e0 = engine(); e0.arm('meeting_z')
    await e0.feed('meeting_z', words(L.minNewWords))
    expect(evaluations().at(-1)).toMatchObject({ outcome: 'cue', numberFlags: 2 })
    env.COS_LIVE_CUES_V2_NUMBER_GUARD = 'withhold'
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(evaluations().at(-1)?.outcome).toBe('withheld_unsupported_number')
  })

  it('a cue the shared validator would reject is withheld, never emitted (a malformed retrieved note)', async () => {
    const e = engine({ memory: async () => ({ notes: [{ id: 'M1', date: 20261001 as unknown as string, title: 'Odd', notes: 'n', key: 'odd.md' }] }),
      judge: async () => ({ probs: { M1: 0.95 }, tokens: 1 }) })
    writerText = async () => JSON.stringify({ cue: 'Keep the cap from the last call.', memoryIds: ['M1'] })
    e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(evaluations().at(-1)?.outcome).toBe('withheld_invalid')
    expect(emitted).toEqual([])
  })

  it('an evaluation that outlives the wall is aborted and counted as a failure, so its lease is released before the drain timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const e = engine({ writer: (_m, _s, _p, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))) })
      e.arm('meeting_w')
      const run = e.feed('meeting_w', words(L.minNewWords))
      await vi.advanceTimersByTimeAsync(L.pipelineWallMs + 1)
      await run
      expect(evaluations().at(-1)).toMatchObject({ outcome: 'failure', error: 'wall_timeout' })
    } finally { vi.useRealTimers() }
  })

  it('memory errors are traced, and the cue still runs without memory', async () => {
    const e = engine({ memory: async () => ({ notes: [], denseError: 'memory_timeout' }) }); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(evaluations().at(-1)).toMatchObject({ outcome: 'cue', candidates: 0, memoryError: 'memory_timeout', kept: 0, cueMemorySource: 'none' })
    expect(calls.judge).toBe(0)
  })

  it('capability is honest about the API key, the Jev cap and the Jev breaker', () => {
    env.ANTHROPIC_API_KEY = 'sk-test'
    expect(engine().capability()).toMatchObject({ available: false, reason: 'api_key_in_env' })
    env.COS_ALLOW_API_FALLBACK = '1'
    expect(engine().capability()).toMatchObject({ available: true })
    states.jev.capReached = true
    expect(engine().capability()).toMatchObject({ available: false, reason: 'jev_cap_reached' })
    states.jev = { configured: true, capReached: false, breakerOpen: true }
    expect(engine().capability()).toMatchObject({ available: false, reason: 'jev_breaker_open' })
  })

  it('feedback is recorded with whether the cue is known; no transcript text is traced, even on a writer failure', async () => {
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords, 'secretword'))
    const cueId = String(emitted[0].data.cueId)
    expect(e.recordFeedback({ sessionId: 'meeting_a', cueId, vote: 'down', reason: '  wrong   client ' })).toEqual({ ok: true, knownCue: true })
    expect(traces.at(-1)).toMatchObject({ kind: 'feedback', vote: 'down', reason: 'wrong client', knownCue: true })
    writerText = async () => { throw new Error('claude exited 1: secretword secretword') }
    next(); await e.feed('meeting_a', words(L.minNewWords, 'secretword'))
    expect(JSON.stringify(traces)).not.toContain('secretword')
  })

  // ── 6.76.2: notes fallback ────────────────────────────────────────────────
  const POOL = { id: 'M1', date: '2026-10-10', title: 'Pool resurfacing', notes: 'Delgado quoted 18500 and wants a deposit by Friday.', key: 'memory:mem_pool_1' }
  const OTHER = { id: 'M2', date: '2026-10-02', title: 'Unrelated', notes: 'School pickup rota.', key: 'meeting:standalone:x' }
  const notesJudge = async (_t: string, _w: string, notes: Array<{ title: string }>, _s: AbortSignal, p: string) => {
    calls.judge++; calls.providers.push(`judge:${p}`); calls.judged.push(notes.map(n => n.title)); return { probs: { M1: 0.93, M2: 0.1, none: 0.05 }, tokens: 1 }
  }

  it('notes fallback: every way cue_memory.py fails (missing, timeout, spawn, bad output, output limit, a throw) searches the owner\'s notes, and those go through the same judge and writer', async () => {
    const failures = ['no_cue_memory_script', 'memory_timeout', 'spawn_failed', 'bad_output', 'output_limit', 'THROW'] as const
    expect([...mod.CUE_MEMORY_FAILURES].sort()).toEqual(['bad_output', 'memory_threw', 'memory_timeout', 'no_cue_memory_script', 'output_limit', 'spawn_failed'])
    for (const [i, failure] of failures.entries()) {
      notesFound = [POOL, OTHER]
      writerText = async () => JSON.stringify({ cue: 'Delgado wants the deposit by Friday. Decide on the pebble finish first.', kind: 'challenge', memoryIds: ['M1'] })
      const asked: Array<[string, string]> = []
      const e = engine({ memory: async () => { calls.memory++; if (failure === 'THROW') throw new Error('boom'); return { notes: [], denseError: failure } }, judge: notesJudge,
        notes: async (_w, before, _s, sessionId) => { calls.notes++; asked.push([before, sessionId]); return { notes: notesFound } } })
      const sid = `meeting_f${i}`
      e.arm(sid)
      const before = { notes: calls.notes, judge: calls.judge, prompts: calls.prompts.length }
      await e.feed(sid, words(L.minNewWords))
      expect(calls.notes - before.notes, failure).toBe(1)
      expect(asked, failure).toEqual([['2026-10-15', sid]])                        // the same date bound as cue_memory.py; the live meeting is excluded by id
      expect(calls.judge - before.judge, failure).toBe(1)
      expect(calls.judged.at(-1), failure).toEqual(['Pool resurfacing', 'Unrelated'])
      const prompt = JSON.parse(calls.prompts.at(-1)!) as { memory: Array<Record<string, string>> }
      expect(prompt.memory, failure).toEqual([{ id: 'M1', date: '2026-10-10', title: 'Pool resurfacing', notes: POOL.notes }])   // judge kept M1 only; writer keys unchanged
      expect(evaluations().at(-1), failure).toMatchObject({ outcome: 'cue', cueMemorySource: 'notes', candidates: 2, kept: 1, memoryError: failure === 'THROW' ? 'memory_threw' : failure })
      const cue = emitted.filter(x => x.type === 'coaching_nudge_v2').at(-1)!.data
      expect(cue.sources, failure).toEqual([{ id: sourceId(POOL), date: '2026-10-10', title: 'Pool resurfacing' }])
    }
  })

  it('cue_memory.py is preferred whenever it answers: with notes, empty, or with its own dense error the notes arm never runs', async () => {
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(evaluations().at(-1)).toMatchObject({ cueMemorySource: 'cue_memory', candidates: 3 })
    const empty = engine({ memory: async () => ({ notes: [] }) }); empty.arm('meeting_b')
    await empty.feed('meeting_b', words(L.minNewWords))
    expect(evaluations().at(-1)).toMatchObject({ cueMemorySource: 'none', candidates: 0 })
    const dense = engine({ memory: async () => ({ notes: [{ ...POOL }], denseError: 'dense_timeout' }), judge: notesJudge }); dense.arm('meeting_c')
    await dense.feed('meeting_c', words(L.minNewWords))
    expect(evaluations().at(-1)).toMatchObject({ cueMemorySource: 'cue_memory', candidates: 1, memoryError: 'dense_timeout' })
    expect(calls.notes).toBe(0)
  })

  it('a notes arm that finds nothing is traced as none with its own error, and no note text reaches the trace', async () => {
    const e = engine({ memory: async () => ({ notes: [], denseError: 'no_cue_memory_script' }), notes: async () => { calls.notes++; return { notes: [], denseError: 'notes_timeout' } } }); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(evaluations().at(-1)).toMatchObject({ outcome: 'cue', cueMemorySource: 'none', candidates: 0, notesError: 'notes_timeout' })
    expect(calls.judge).toBe(0)
    notesFound = [{ ...POOL, notes: 'secretnote secretnote' }]
    const f = engine({ memory: async () => ({ notes: [], denseError: 'no_cue_memory_script' }), judge: notesJudge }); f.arm('meeting_b')
    await f.feed('meeting_b', words(L.minNewWords))
    expect(evaluations().at(-1)).toMatchObject({ cueMemorySource: 'notes' })
    expect(JSON.stringify(traces)).not.toContain('secretnote')
  })

  // ── 6.76.2: runtime switch ────────────────────────────────────────────────
  it('the saved setting turns v2 on without the env flag, and env COS_LIVE_CUES_V2=1 forces it on over a saved off', async () => {
    env = {}
    expect(engine().capability()).toMatchObject({ available: false, reason: 'master_flag_off', memory: 'cue_memory', decisionProvider: 'jev' })
    storedSetting = true
    const e = engine(); expect(e.capability()).toMatchObject({ available: true }); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(calls.gate).toBe(1)
    expect(e.status('meeting_a').enabled).toBe(true)
    storedSetting = false
    expect(engine().capability()).toMatchObject({ available: false, reason: 'master_flag_off' })
    env = { COS_LIVE_CUES_V2: '1' }
    expect(engine().capability()).toMatchObject({ available: true })
    expect(mod.liveCuesV2Enabled({ COS_LIVE_CUES_V2: '0' }, { stored: () => true })).toBe(true)     // only '1' forces; anything else defers to the setting
    expect(mod.liveCuesV2Enabled({ COS_LIVE_CUES_V2: '0' }, { stored: () => null })).toBe(false)
  })

  it('switching off mid-meeting stops the evaluation in flight cleanly; nothing runs while off; switching on resumes at the next evaluation', async () => {
    env = {}; storedSetting = true
    let released = 0
    let release!: () => void
    const seen: { signal: AbortSignal | null } = { signal: null }
    writerText = () => new Promise(r => { release = () => r(JSON.stringify({ cue: 'Name an owner today.' })) })
    const e = engine({
      lease: () => ({ release: () => { released++ } }) as unknown as import('./maintenance-lifecycle.js').MaintenanceWorkLease,
      writer: async (_m, _s, prompt, signal) => { calls.writer++; calls.prompts.push(prompt); seen.signal = signal; return { text: await writerText() } },
    })
    e.arm('meeting_a')
    const run = e.feed('meeting_a', words(L.minNewWords))
    await vi.waitFor(() => expect(calls.writer).toBe(1))
    storedSetting = false
    expect(e.suspend()).toBe(1)
    expect(seen.signal?.aborted).toBe(true)
    release(); await run
    expect(emitted).toEqual([])
    expect(evaluations().at(-1)).toMatchObject({ outcome: 'cancelled', cancelReason: 'v2_off' })
    expect(released).toBe(1)
    expect(e.suspend()).toBe(0)                                            // nothing left in flight: no stuck state
    next(); await e.feed('meeting_a', words(L.minNewWords))
    expect(calls.gate).toBe(1)
    expect(e.status('meeting_a')).toMatchObject({ enabled: false, session: { state: 'active' } })
    storedSetting = true
    writerText = async () => JSON.stringify({ cue: 'Name an owner today.' })
    next(); await e.feed('meeting_a', words(L.minNewWords))
    expect(calls.gate).toBe(2)
    expect(emitted.map(x => x.type)).toEqual(['coaching_nudge_v2', 'coaching_nudge'])
    expect(evaluations().at(-1)).toMatchObject({ outcome: 'cue' })
  })

  it('a cue whose writer finished after v2 went off is never emitted, even when no abort reached the writer', async () => {
    env = {}; storedSetting = true
    writerText = async () => { storedSetting = false; return JSON.stringify({ cue: 'Name an owner today.' }) }
    const e = engine(); e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(emitted).toEqual([])
    expect(evaluations().at(-1)?.outcome).toBe('cancelled')
  })

  // ── 6.76.2: decision provider ─────────────────────────────────────────────
  it('gate and judge run on the configured provider, one provider per evaluation; a change applies from the next one', async () => {
    provider = 'subq'; states.subq.configured = true
    const e = engine({ gate: async (_t, _w, _s, p) => { calls.gate++; calls.providers.push(`gate:${p}`); provider = 'jev'; return { pCue, kind: 'challenge', lookup: null, tokens: 1 } } })
    e.arm('meeting_a')
    await e.feed('meeting_a', words(L.minNewWords))
    expect(calls.providers).toEqual(['gate:subq', 'judge:subq'])          // switched during the gate: the judge kept the snapshot
    expect(evaluations().at(-1)).toMatchObject({ decisionProvider: 'subq', outcome: 'cue' })
    next(); await e.feed('meeting_a', words(L.minNewWords))
    expect(calls.providers.slice(2)).toEqual(['gate:jev', 'judge:jev'])
    expect(evaluations().at(-1)).toMatchObject({ decisionProvider: 'jev' })
  })

  it('capability names the provider and gives each provider an honest reason', () => {
    states = { jev: { configured: false, breakerOpen: false, capReached: false }, subq: { configured: false, breakerOpen: false, capReached: false } }
    expect(engine().capability()).toEqual({ available: false, reason: 'decision_not_configured', protocol: 2, model: 'claude-sonnet-5-5', memory: 'cue_memory', decisionProvider: 'jev' })
    states.subq.configured = true                                          // Jev chosen explicitly, only a SubQ key: the 6.75 reason
    expect(engine().capability()).toMatchObject({ available: false, reason: 'jev_not_configured', decisionProvider: 'jev' })
    provider = 'subq'; states = { jev: { configured: true, breakerOpen: false, capReached: false }, subq: { configured: false, breakerOpen: false, capReached: false } }
    expect(engine().capability()).toMatchObject({ available: false, reason: 'decision_not_configured', decisionProvider: 'subq' })
    states.subq = { configured: true, breakerOpen: false, capReached: true }
    expect(engine().capability()).toMatchObject({ available: false, reason: 'decision_cap_reached', decisionProvider: 'subq' })
    states.subq = { configured: true, breakerOpen: true, capReached: false }
    expect(engine().capability()).toMatchObject({ available: false, reason: 'decision_breaker_open', decisionProvider: 'subq' })
    states.subq = { configured: true, breakerOpen: false, capReached: false }
    expect(engine().capability()).toEqual({ available: true, protocol: 2, model: 'claude-sonnet-5-5', memory: 'cue_memory', decisionProvider: 'subq' })
    states.jev = { configured: true, breakerOpen: true, capReached: true }  // the other provider's state never leaks in
    expect(engine().capability()).toMatchObject({ available: true })
    const bad = engine({ decisionProvider: () => { throw new DecisionProviderError('decision_invalid_provider') }, memorySource: () => 'notes' }).capability()
    expect(bad).toEqual({ available: false, reason: 'decision_invalid_provider', protocol: 2, model: 'claude-sonnet-5-5', memory: 'notes' })
  })

  it('provider errors at run time: cap, breaker, missing key and an invalid choice stop quietly with a reason; other provider errors count toward the breaker', async () => {
    for (const code of ['decision_cap_reached', 'decision_breaker_open', 'decision_not_configured'] as const) {
      const e = engine({ gate: async () => { calls.gate++; throw new DecisionProviderError(code) } }); e.arm(`meeting_${code}`)
      await e.feed(`meeting_${code}`, words(L.minNewWords))
      expect(evaluations().at(-1)?.outcome).toBe(code)
      expect(e.status(`meeting_${code}`).session).toMatchObject({ state: 'stopped', reason: code })
      for (let i = 0; i < L.breakerFailures; i++) { next(); await e.feed(`meeting_${code}`, words(L.minNewWords)) }
      expect(e.status(`meeting_${code}`).session?.reason).toBe(code)       // never the meeting breaker
    }
    let invalid = false
    const inv = engine({ decisionProvider: () => { if (invalid) throw new DecisionProviderError('decision_invalid_provider'); return 'jev' } }); inv.arm('meeting_inv')
    invalid = true                                                         // the choice became unreadable after the meeting armed
    const gatesBefore = calls.gate
    await inv.feed('meeting_inv', words(L.minNewWords))
    expect(calls.gate).toBe(gatesBefore)
    expect(evaluations().at(-1)?.outcome).toBe('decision_invalid_provider')
    expect(inv.status('meeting_inv').session).toMatchObject({ state: 'stopped', reason: 'decision_invalid_provider' })
    const down = engine({ gate: async () => { calls.gate++; throw new DecisionProviderError('decision_unavailable') } }); down.arm('meeting_down')
    for (let i = 0; i < L.breakerFailures; i++) { await down.feed('meeting_down', words(L.minNewWords)); next() }
    expect(down.status('meeting_down').session).toMatchObject({ state: 'stopped', reason: 'breaker_open' })
    expect(evaluations().at(-1)).toMatchObject({ outcome: 'failure', error: 'decision_unavailable' })
  })
})

describe('decision provider selection and clients (6.76.2)', () => {
  const noKeys = { jev: () => false, subq: () => false }
  const bothKeys = { jev: () => true, subq: () => true }
  const onlySubq = { jev: () => false, subq: () => true }
  const { resolveCuesDecisionProvider, cueDecisionCalls } = mod
  it('cues use SubQ only when COS_DECISION_PROVIDER_CUES=subq or SubQ is the only key; the global decision setting and env are ignored', () => {
    expect(resolveCuesDecisionProvider({}, noKeys)).toEqual({ provider: 'jev', source: 'default' })
    expect(resolveCuesDecisionProvider({}, bothKeys)).toEqual({ provider: 'jev', source: 'default' })
    expect(resolveCuesDecisionProvider({}, { jev: () => true, subq: () => false })).toEqual({ provider: 'jev', source: 'default' })
    expect(resolveCuesDecisionProvider({}, onlySubq)).toEqual({ provider: 'subq', source: 'only_key' })
    expect(resolveCuesDecisionProvider({ COS_DECISION_PROVIDER: 'subq' }, bothKeys)).toEqual({ provider: 'jev', source: 'default' })   // global env ignored
    expect(resolveCuesDecisionProvider({ COS_DECISION_PROVIDER_CUES: ' SubQ ' }, bothKeys)).toEqual({ provider: 'subq', source: 'env' })
    expect(resolveCuesDecisionProvider({ COS_DECISION_PROVIDER_CUES: 'subq' }, noKeys)).toEqual({ provider: 'subq', source: 'env' })   // explicit, even without a key
    expect(resolveCuesDecisionProvider({ COS_DECISION_PROVIDER_CUES: 'jev' }, onlySubq)).toEqual({ provider: 'jev', source: 'env' })     // explicit Jev beats only-key
    expect(() => resolveCuesDecisionProvider({ COS_DECISION_PROVIDER_CUES: 'gpt' }, bothKeys)).toThrow('decision_invalid_provider')
    expect(() => resolveCuesDecisionProvider({ COS_DECISION_PROVIDER_CUES: '' }, bothKeys)).toThrow('decision_invalid_provider')
  })

  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cues-v2-decision-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const gateAnswers = {
    act: { type: 'choice', choice: 'cue', probabilities: { cue: 0.9, silent: 0.1 }, confidence: 0.9 },
    lookup: { type: 'choice', choice: 'past_meetings', probabilities: { none: 0.2, past_meetings: 0.7, public_fact: 0.1 }, confidence: 0.7 },
    kind: { type: 'choice', choice: 'reinforce', probabilities: { reinforce: 0.6, challenge: 0.4 }, confidence: 0.6 },
  }
  const judgeAnswers = { same: { type: 'choice', choice: 'M1', probabilities: { M1: 0.85, M2: 0.1, none: 0.05 }, confidence: 0.85 } }
  const notes = [{ id: 'M1', date: '2026-10-10', title: 'Pool resurfacing', notes: 'Delgado quoted 18500' }, { id: 'M2', date: '2026-10-02', title: 'Other', notes: 'x' }]
  function recordingFetch(answers: () => unknown, extra: Record<string, unknown>) {
    const bodies: Array<Record<string, unknown>> = []
    const f = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ answers: answers(), usage: { input_tokens: 500 }, ...extra }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { f, bodies }
  }
  it('SubQ takes the same gate and judge questions and its validated answers read the same way', async () => {
    const { SubqDecisionClient, SUBQ_MODEL } = await import('./decision-provider.js')
    let answers: unknown = gateAnswers
    const { f, bodies } = recordingFetch(() => answers, { model: SUBQ_MODEL })
    const subq = new SubqDecisionClient(f, () => new Date('2026-10-17T15:00:00Z'), join(dir, 'subq.json'), () => 'test-key-not-real', () => 1e9)
    const calls = cueDecisionCalls(subq)
    const gate = await calls.gate('G2 Recording', 'we should pick the pebble finish', new AbortController().signal)
    expect(gate).toEqual({ pCue: 0.9, kind: 'reinforce', lookup: { none: 0.2, past_meetings: 0.7, public_fact: 0.1 }, tokens: 500 })
    expect(bodies[0]).toMatchObject({ model: SUBQ_MODEL, state: { meetingTitle: 'G2 Recording', window: 'we should pick the pebble finish' } })
    expect(bodies[0].questions).toEqual(prompts.CUE_GATE_QUESTIONS)
    answers = judgeAnswers
    const judged = await calls.judge('G2 Recording', 'pebble finish', notes, new AbortController().signal)
    expect(judged).toEqual({ probs: { M1: 0.85, M2: 0.1, none: 0.05 }, tokens: 500 })
    expect(Object.keys((bodies[1].questions as { same: { criteria: Record<string, string> } }).same.criteria)).toEqual(['M1', 'M2', 'none'])
    answers = { same: { type: 'choice', choice: 'M1', probabilities: { M1: 1 }, confidence: 1 } }     // a label missing: SubQ refuses it
    await expect(calls.judge('t', 'w', notes, new AbortController().signal)).rejects.toMatchObject({ code: 'decision_bad_answer' })
  })
  it('Jev takes the identical requests (same questions, same state) and reads the same way', async () => {
    const { JevClient, JEV_MODEL: model } = await import('./jev.js')
    const savedKey = process.env.TYPESAFE_API_KEY
    process.env.TYPESAFE_API_KEY = 'test-key-not-real'   // the client resolves its key internally
    onTestFinished(() => { if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey })
    let answers: unknown = gateAnswers
    const { f, bodies } = recordingFetch(() => answers, { model })
    const jev = new JevClient(f, () => new Date('2026-10-17T15:00:00Z'), join(dir, 'jev.json'), () => 1e9)
    const calls = cueDecisionCalls(jev)
    expect(await calls.gate('G2 Recording', 'we should pick the pebble finish', new AbortController().signal)).toEqual({ pCue: 0.9, kind: 'reinforce', lookup: { none: 0.2, past_meetings: 0.7, public_fact: 0.1 }, tokens: 500 })
    expect(bodies[0]).toMatchObject({ model, state: { meetingTitle: 'G2 Recording', window: 'we should pick the pebble finish' } })
    expect(bodies[0].questions).toEqual(prompts.CUE_GATE_QUESTIONS)
    answers = judgeAnswers
    expect(await calls.judge('G2 Recording', 'pebble finish', notes, new AbortController().signal)).toEqual({ probs: { M1: 0.85, M2: 0.1, none: 0.05 }, tokens: 500 })
  })
  it('SubQ keeps its own daily cap and breaker for cues, reports them honestly, and a newly saved key clears its breaker', async () => {
    const { SubqDecisionClient, trackSubqDecisionClient, resetSubqDecisionClients } = await import('./decision-provider.js')
    const now = () => new Date('2026-10-17T15:00:00Z')
    const ledger = join(dir, 'subq-cues.json')
    writeFileSync(ledger, JSON.stringify({ '2026-10-17': 1000 }) + '\n', { mode: 0o600 })
    const capped = new SubqDecisionClient((async () => { throw new Error('must not be called') }) as unknown as typeof fetch, now, ledger, () => 'k', () => 1000)
    expect(capped.status()).toEqual({ configured: true, usedToday: 1000, dailyCap: 1000, breakerOpenUntil: null })
    await expect(cueDecisionCalls(capped).gate('t', 'w', new AbortController().signal)).rejects.toMatchObject({ code: 'decision_cap_reached' })
    writeFileSync(ledger, '{not json')
    expect(capped.status()).toMatchObject({ usedToday: 1000, dailyCap: 1000 })              // an unreadable ledger reads as spent
    const failing = trackSubqDecisionClient(new SubqDecisionClient((async () => new Response('', { status: 500 })) as unknown as typeof fetch, now, join(dir, 'subq-b.json'), () => 'k', () => 1e9))
    for (let i = 0; i < 3; i++) await expect(cueDecisionCalls(failing).gate('t', 'w', new AbortController().signal)).rejects.toMatchObject({ code: 'decision_unavailable' })
    expect(failing.status().breakerOpenUntil).not.toBeNull()
    await expect(cueDecisionCalls(failing).gate('t', 'w', new AbortController().signal)).rejects.toMatchObject({ code: 'decision_breaker_open' })
    resetSubqDecisionClients()
    expect(failing.status().breakerOpenUntil).toBeNull()
    expect(new SubqDecisionClient(fetch, now, join(dir, 'c.json'), () => undefined, () => 1).status().configured).toBe(false)
  })
})
