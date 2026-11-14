// 7.0.18 (X1, Miles 2026-11-10 07:14): a session whose turn ends by asking, through the Claude desktop
// app's next-step box (`mcp__ccd_turn__wrap_up` with `ask` and reply buttons). Every noise bound the
// lead named as a must-have at 07:20 has a test here: only an ask with reply buttons or blocked, one per
// turn, the desk latch, never print runs, COS-spawned children or sub-agents, the 8 hour age-out, and
// the counters. The payload shapes are canary C17's (a real desktop Code tab, 2026-11-10 07:16).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_TURN_ASKS, TURN_ASK_BUSY_GRACE_MS, TURN_ASK_DESK_IDLE_MIN_S, TURN_ASK_MAX_AGE_MS, TURN_ASK_UNREADABLE_RETRY_MS, TURN_END_ASKS_DEFAULT,
  TurnEndAskTracker, WRAP_UP_TOOL, __setTurnEndAsksForTests, captureTurnAsk, projectedTurnAsk, turnEndAsksEnabled,
} from './turn-end-ask.js'
import { isMachineOnlyPrompt, projectHookPayload, type HookEnvelope } from './session-hook-events.js'
import { SessionSignalStore } from './session-signal-store.js'
import { SessionHookLedger } from './session-hook-ledger.js'
import { deriveSessionState, derivedRowFields, derivedStatusFields, type RegistryFacts } from './session-state-derive.js'
import { statusDraftWithDerived } from './session-stream-events.js'
import { __resetSessionHooksForTests, __setTurnEndAskTrackerForTests, deriveForRow, openTurnEndAsk, sessionSignalStore, startSessionHooksRuntime, turnEndAskAnswered, turnEndAskStats } from './session-hooks-runtime.js'
import { dataPath } from './data-dir.js'
import { personTurnMarker } from './turn-footer.js'
import { DEAD_GRACE_MS } from './session-state-derive.js'
import { mkdirSync, writeFileSync } from 'node:fs'

const SID = '7a1e0c55-1111-4222-8333-444455556666'
const PROMPT = 'aebe20a1-0000-4000-8000-00000000c017'
const T0 = 1_794_316_583_690
/** C17's tool_input, verbatim apart from the recap marker. */
const C17_INPUT = { recap: 'RECAP-NEVER-KEPT canary for the turn-end ask.', ask: 'Canary: which color?', actions: [{ label: 'Red' }, { label: 'Blue' }] }

function env(event: HookEnvelope['event'], ts: number, payload: Record<string, unknown> = {}, sessionId = SID): HookEnvelope {
  return { ts, ppid: 4242, event, sessionId, payload: { session_id: sessionId, ...payload } }
}
const wrapUp = (ts: number, input: unknown = C17_INPUT, extra: Record<string, unknown> = {}) =>
  env('PostToolUse', ts, { tool_name: WRAP_UP_TOOL, tool_input: input, tool_response: { ok: 'RESPONSE-NEVER-KEPT' }, prompt_id: PROMPT, tool_use_id: 'toolu_c17', mcp_server: { name: 'ccd_turn', source: 'sdk' }, ...extra })
const stop = (ts: number, promptId: string | null = PROMPT) => env('Stop', ts, { last_assistant_message: 'done', ...(promptId ? { prompt_id: promptId } : {}) })

interface Rig { tracker: TurnEndAskTracker; store: SessionSignalStore; clock: { now: number }; desk: { idle: number | null; reads: number }; words: { on: boolean } }

function rig(opts: { threshold?: number; entrypoint?: string | null; pollMs?: number } = {}): Rig {
  const clock = { now: T0 }
  const desk = { idle: 0 as number | null, reads: 0 }
  const words = { on: true }
  const tracker = new TurnEndAskTracker({
    now: () => clock.now,
    enabled: () => true,
    words: () => words.on,
    readDeskIdleSeconds: async () => { desk.reads++; return desk.idle },
    deskIdleSeconds: () => opts.threshold ?? 90,
    pollMs: opts.pollMs ?? 3_600_000, // tests drive tick() themselves
  })
  const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
  store.subscribe((signal, e, child) => tracker.observe(e, child, opts.entrypoint !== undefined ? { entrypoint: opts.entrypoint } : signal))
  trackers.push(tracker)
  return { tracker, store, clock, desk, words }
}
const trackers: TurnEndAskTracker[] = []
afterEach(() => { for (const t of trackers.splice(0)) t.stop() })

/** Arm, stop and latch: the ask a row would show. */
async function asked(r: Rig, at = T0): Promise<void> {
  r.store.apply(wrapUp(at), false)
  r.store.apply(stop(at + 4_700), false)
  r.clock.now = at + 4_700
  r.desk.idle = 120
  await r.tracker.tick()
}

describe('the switch: COS_TURN_END_ASKS, read once at startup', () => {
  const saved = process.env.COS_TURN_END_ASKS
  afterEach(() => { if (saved === undefined) delete process.env.COS_TURN_END_ASKS; else process.env.COS_TURN_END_ASKS = saved; __setTurnEndAsksForTests(null) })

  it('defaults ON (Miles 07:20, "On for everyone"); 0 turns it off', () => {
    expect(TURN_END_ASKS_DEFAULT).toBe(true)
    __setTurnEndAsksForTests(null)
    delete process.env.COS_TURN_END_ASKS
    expect(turnEndAsksEnabled()).toBe(true)
    for (const off of ['0', 'false', 'off']) {
      __setTurnEndAsksForTests(null)
      process.env.COS_TURN_END_ASKS = off
      expect(turnEndAsksEnabled()).toBe(false)
    }
  })

  it('listed in the managed runtime contract and .env.example, commented out at its non-default value (the S6 lesson)', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    expect(contract.optionalEnvironment).toContain('COS_TURN_END_ASKS')
    expect(example).toContain('\n# COS_TURN_END_ASKS=0\n')
    expect(example).not.toMatch(/^COS_TURN_END_ASKS=/m)
  })

  it('is read once: a change after startup takes a restart', () => {
    __setTurnEndAsksForTests(null)
    process.env.COS_TURN_END_ASKS = '0'
    expect(turnEndAsksEnabled()).toBe(false)
    process.env.COS_TURN_END_ASKS = '1'
    expect(turnEndAsksEnabled()).toBe(false)
  })
})

describe('captureTurnAsk: what qualifies and what is kept', () => {
  it('C17: the ask and both reply labels; never the recap', () => {
    const capture = captureTurnAsk(C17_INPUT, true)
    expect(capture).toEqual({ ask: 'Canary: which color?', choices: ['Red', 'Blue'], blocked: false })
    expect(JSON.stringify(capture)).not.toContain('RECAP')
  })

  it('an ask with no reply button and not blocked is the session\'s suggestion, not a decision: null', () => {
    expect(captureTurnAsk({ ask: 'Want me to keep going?' }, true)).toBeNull()
    expect(captureTurnAsk({ ask: 'Want me to keep going?', actions: [] }, true)).toBeNull()
    expect(captureTurnAsk({ ask: 'Commit?', actions: [{ action: 'commit', label: 'Commit' }] }, true)).toBeNull()
    expect(captureTurnAsk({ ask: 'Pick', actions: [{ label: '   ' }, { label: 7 }, null, 'Red'] }, true)).toBeNull()
  })

  it('blocked with no buttons qualifies (the app\'s "waiting on you" mark)', () => {
    expect(captureTurnAsk({ ask: 'Which repo?', blocked: true }, true)).toEqual({ ask: 'Which repo?', choices: [], blocked: true })
    expect(captureTurnAsk({ ask: 'Which repo?', blocked: 'true' }, true)).toBeNull()
  })

  it('app-action buttons are never choices; at most 2 reply labels', () => {
    const capture = captureTurnAsk({ ask: 'Ship it?', actions: [{ action: 'commit', label: 'Commit' }, { label: 'Yes' }, { action: 'create_pr' }, { label: 'No' }, { label: 'Later' }] }, true)
    expect(capture?.choices).toEqual(['Yes', 'No'])
  })

  it('a blank or missing ask, or no input at all: null', () => {
    for (const input of [{ actions: [{ label: 'A' }] }, { ask: '  ​\u0007 ', actions: [{ label: 'A' }] }, { ask: 42, actions: [{ label: 'A' }] }, null, 'ask', [C17_INPUT]]) {
      expect(captureTurnAsk(input, true)).toBeNull()
    }
  })

  it('bounded and cleaned: 80 for the ask, 40 per label, control and format characters out, whitespace folded', () => {
    const long = 'x'.repeat(200)
    const capture = captureTurnAsk({ ask: `Deploy‮\n  now?\u0007 ${long}`, actions: [{ label: `Ok​ ${long}` }] }, true)!
    expect(capture.ask.length).toBe(80)
    expect(capture.ask.startsWith('Deploy now? xxx')).toBe(true)
    expect(capture.ask.endsWith('…')).toBe(true)
    expect(capture.choices[0].length).toBe(40)
    expect(capture.choices[0].startsWith('Ok xxx')).toBe(true)
    expect(captureTurnAsk({ ask: 'y'.repeat(80), actions: [{ label: 'z'.repeat(40) }] }, true)).toEqual({ ask: 'y'.repeat(80), choices: ['z'.repeat(40)], blocked: false })
  })

  it('words off (COS_WAITING_QUESTION_WORDS=0): the fact stays, every word goes; qualification unchanged', () => {
    expect(captureTurnAsk(C17_INPUT, false)).toEqual({ ask: '', choices: [], blocked: false })
    expect(captureTurnAsk({ ask: 'Want me to?' }, false)).toBeNull()
  })

  it('projectedTurnAsk reads the ledger copy back, bounded again', () => {
    expect(projectedTurnAsk({ ask: 'Q?', choices: ['A', 'B', 'C', 5], blocked: true })).toEqual({ ask: 'Q?', choices: ['A', 'B'], blocked: true })
    expect(projectedTurnAsk({ ask: 'z'.repeat(300), choices: ['w'.repeat(300)] })).toEqual({ ask: 'z'.repeat(79) + '…', choices: ['w'.repeat(39) + '…'], blocked: false })
    for (const bad of [null, 'x', { choices: [] }, { ask: 'Q?' }, { ask: 5, choices: [] }]) expect(projectedTurnAsk(bad)).toBeNull()
  })
})

describe('the ledger projection (rollback to 7.0.17 reads it)', () => {
  const savedWords = process.env.COS_WAITING_QUESTION_WORDS
  afterEach(() => { __setTurnEndAsksForTests(null); if (savedWords === undefined) delete process.env.COS_WAITING_QUESTION_WORDS; else process.env.COS_WAITING_QUESTION_WORDS = savedWords })
  const payload = () => ({ ...wrapUp(T0).payload })

  it('switch on: an additive turn_ask {ask, choices, blocked}; tool_target as before; never recap or tool_response', () => {
    __setTurnEndAsksForTests(true)
    const projected = projectHookPayload('PostToolUse', payload())
    expect(projected.turn_ask).toEqual({ ask: 'Canary: which color?', choices: ['Red', 'Blue'], blocked: false })
    expect(projected.tool_target).toBe('')
    const text = JSON.stringify(projected)
    expect(text).not.toContain('RECAP')
    expect(text).not.toContain('RESPONSE-NEVER-KEPT')
    expect(text).not.toContain('recap')
  })

  it('switch off: the projection is 7.0.17\'s, key for key', () => {
    __setTurnEndAsksForTests(true)
    const on = projectHookPayload('PostToolUse', payload())
    __setTurnEndAsksForTests(false)
    const off = projectHookPayload('PostToolUse', payload())
    expect('turn_ask' in off).toBe(false)
    const { turn_ask: _ignored, ...rest } = on
    expect(off).toEqual(rest)
  })

  it('only on a PostToolUse of wrap_up, and only for a qualifying ask; words follow COS_WAITING_QUESTION_WORDS', () => {
    __setTurnEndAsksForTests(true)
    expect('turn_ask' in projectHookPayload('PreToolUse', payload())).toBe(false)
    expect('turn_ask' in projectHookPayload('PostToolUseFailure', payload())).toBe(false)
    expect('turn_ask' in projectHookPayload('PostToolUse', { ...payload(), tool_name: 'mcp__other__wrap_up' })).toBe(false)
    expect('turn_ask' in projectHookPayload('PostToolUse', { ...payload(), tool_input: { ask: 'Keep going?' } })).toBe(false)
    process.env.COS_WAITING_QUESTION_WORDS = '0'
    expect(projectHookPayload('PostToolUse', payload()).turn_ask).toEqual({ ask: '', choices: [], blocked: false })
  })

  it('a 7.0.18 row replays through the ledger and store (both unchanged since 7.0.17) exactly as the row without turn_ask', () => {
    __setTurnEndAsksForTests(true)
    const dir = mkdtempSync(join(tmpdir(), 'x1-turn-ask-ledger-'))
    try {
      const signals: unknown[] = []
      for (const withAsk of [true, false]) {
        __setTurnEndAsksForTests(withAsk)
        const ledger = new SessionHookLedger(join(dir, `ledger-${withAsk}.jsonl`))
        ledger.append('k1', wrapUp(T0))
        ledger.append('k2', stop(T0 + 4_700))
        const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
        const replay = ledger.replay(0, (e, _k, child) => { store.apply(e, child) })
        expect(replay.applied).toBe(2)
        signals.push(store.get(SID))
      }
      expect(signals[0]).toEqual(signals[1])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the tracker: arms, asks, latches', () => {
  it('C17 order (PostToolUse then Stop 4.7 s later): nothing shows until the desk is idle past the threshold, then it latches', async () => {
    const r = rig()
    r.store.apply(wrapUp(T0), false)
    expect(r.tracker.visibleAsk(SID, T0)).toBeNull()
    r.store.apply(stop(T0 + 4_700), false)
    r.clock.now = T0 + 5_000
    expect(r.tracker.visibleAsk(SID)).toBeNull()
    r.desk.idle = 89
    expect(await r.tracker.tick()).toBe(3_600_000)
    expect(r.tracker.visibleAsk(SID)).toBeNull()
    r.desk.idle = 90
    expect(await r.tracker.tick()).toBeNull()
    expect(r.tracker.visibleAsk(SID)).toEqual({ ask: 'Canary: which color?', choices: ['Red', 'Blue'], stoppedAt: T0 + 4_700 })
    // Latched: Miles returning to the desk does not take it back.
    r.desk.idle = 0
    expect(await r.tracker.tick()).toBeNull()
    expect(r.tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
    expect(r.tracker.stats()).toMatchObject({ armed: 1, shown: 1, tracked: 1 })
  })

  it('a busy desk is read again only when it could have reached the threshold, never sooner than the poll', async () => {
    const r = rig({ pollMs: 500 })
    r.store.apply(wrapUp(T0), false)
    r.store.apply(stop(T0 + 100), false)
    for (const [idle, next] of [[0, 90_000], [10, 80_000], [89, 1_000], [89.9, 500]] as const) {
      r.desk.idle = idle
      expect(await r.tracker.tick()).toBe(next)
    }
    r.tracker.stop()
  })

  it('the Stop first (the PostToolUse hook is async): asked at once', async () => {
    const r = rig()
    r.store.apply(stop(T0 + 4_700), false)
    r.store.apply(wrapUp(T0), false)
    r.desk.idle = 300
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID)?.stoppedAt).toBe(T0 + 4_700)
  })

  it('a Stop of another prompt, or an earlier Stop, does not ask', async () => {
    const r = rig()
    r.store.apply(stop(T0 - 60_000), false)
    r.store.apply(wrapUp(T0), false)
    r.store.apply(stop(T0 + 1_000, 'other-prompt'), false)
    r.desk.idle = 300
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID, T0 + 2_000)).toBeNull()
    r.store.apply(stop(T0 + 2_000), false)
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID, T0 + 2_000)?.stoppedAt).toBe(T0 + 2_000)
  })

  it('a Stop older than the wrap_up, ingested after it, does not ask', async () => {
    const r = rig()
    r.store.apply(wrapUp(T0), false)
    r.store.apply(stop(T0 - 1_000, null), false)
    r.desk.idle = 300
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID, T0 + 2_000)).toBeNull()
  })

  it('a Stop of the other prompt that came FIRST does not ask either', async () => {
    const r = rig()
    r.store.apply(stop(T0 + 1_000, 'other-prompt'), false)
    r.store.apply(wrapUp(T0), false)
    r.desk.idle = 300
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID, T0 + 2_000)).toBeNull()
  })

  it('the threshold is never below 30 s, and a bad setting reads as 30', async () => {
    for (const [setting, idle, shows] of [[5, 29, false], [5, 30, true], [Number.NaN, 30, true], [Number.NaN, 29, false], [120, 119, false], [120, 120, true]] as const) {
      const r = rig({ threshold: setting })
      r.store.apply(wrapUp(T0), false)
      r.store.apply(stop(T0 + 100), false)
      r.desk.idle = idle
      await r.tracker.tick()
      expect(r.tracker.visibleAsk(SID, T0 + 200) !== null).toBe(shows)
      expect(TURN_ASK_DESK_IDLE_MIN_S).toBe(30)
    }
  })

  it('an unreadable desk never shows it, and is read again a minute later', async () => {
    const r = rig()
    r.store.apply(wrapUp(T0), false)
    r.store.apply(stop(T0 + 100), false)
    r.desk.idle = null
    expect(await r.tracker.tick()).toBe(Math.max(3_600_000, TURN_ASK_UNREADABLE_RETRY_MS))
    expect(r.tracker.visibleAsk(SID, T0 + 200)).toBeNull()
  })

  it('no desk read while nothing waits for the latch', async () => {
    const r = rig()
    expect(await r.tracker.tick()).toBeNull()
    r.store.apply(wrapUp(T0), false)
    expect(await r.tracker.tick()).toBeNull()
    expect(r.desk.reads).toBe(0)
  })

  it('a replayed (projected) row arms like a live one, words as stored', async () => {
    __setTurnEndAsksForTests(true)
    try {
      const r = rig()
      const live = wrapUp(T0)
      r.store.apply({ ...live, payload: projectHookPayload('PostToolUse', live.payload) }, false)
      r.store.apply({ ...stop(T0 + 100), payload: projectHookPayload('Stop', stop(T0 + 100).payload) }, false)
      r.desk.idle = 300
      await r.tracker.tick()
      expect(r.tracker.visibleAsk(SID, T0 + 200)).toEqual({ ask: 'Canary: which color?', choices: ['Red', 'Blue'], stoppedAt: T0 + 100 })
    } finally {
      __setTurnEndAsksForTests(null)
    }
  })

  it('a replayed wrap_up row with no turn_ask (switch was off, or it did not qualify) arms nothing', async () => {
    __setTurnEndAsksForTests(false)
    try {
      const r = rig()
      const live = wrapUp(T0)
      r.store.apply({ ...live, payload: projectHookPayload('PostToolUse', live.payload) }, false)
      r.store.apply(stop(T0 + 100), false)
      r.desk.idle = 300
      await r.tracker.tick()
      expect(r.tracker.visibleAsk(SID, T0 + 200)).toBeNull()
    } finally {
      __setTurnEndAsksForTests(null)
    }
  })

  it('words off: the row still says a question waits, with no words', async () => {
    const r = rig()
    r.words.on = false
    await asked(r)
    expect(r.tracker.visibleAsk(SID)).toEqual({ ask: '', choices: [], stoppedAt: T0 + 4_700 })
  })

  it('a short (8-character) row id finds it; another session\'s id does not', async () => {
    const r = rig()
    await asked(r)
    expect(r.tracker.visibleAsk(SID.slice(0, 8))?.ask).toBe('Canary: which color?')
    expect(r.tracker.visibleAsk(SID.toUpperCase())?.ask).toBe('Canary: which color?')
    expect(r.tracker.visibleAsk('00000000-1111-4222-8333-444455556666')).toBeNull()
  })

  it('one per session: a later ask replaces the earlier one', async () => {
    const r = rig()
    await asked(r)
    r.store.apply(env('UserPromptSubmit', T0 + 10_000, { prompt: 'Red', prompt_id: 'p2' }), false)
    r.store.apply(wrapUp(T0 + 20_000, { ask: 'Second?', actions: [{ label: 'Yes' }] }, { prompt_id: 'p2' }), false)
    r.store.apply(stop(T0 + 21_000, 'p2'), false)
    r.clock.now = T0 + 21_000
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID)).toEqual({ ask: 'Second?', choices: ['Yes'], stoppedAt: T0 + 21_000 })
    expect(r.tracker.stats().tracked).toBe(1)
  })
})

describe('never for print runs, COS-spawned children or sub-agents', () => {
  it('a print run (registry entrypoint sdk-cli) never arms; mcp_server.source sdk from a desktop tab does', async () => {
    const print = rig({ entrypoint: 'sdk-cli' })
    await asked(print)
    expect(print.tracker.visibleAsk(SID)).toBeNull()
    expect(print.tracker.stats().armed).toBe(0)
    const desktop = rig({ entrypoint: 'claude-desktop' })
    await asked(desktop)
    expect(desktop.tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
  })

  it('a COS-spawned child\'s wrap_up never arms, and its Stop never asks', async () => {
    const r = rig()
    r.store.apply(wrapUp(T0), true)
    r.store.apply(stop(T0 + 100), false)
    r.desk.idle = 300
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID, T0 + 200)).toBeNull()
    r.store.apply(wrapUp(T0 + 1_000), false)
    r.store.apply(stop(T0 + 1_100), true)
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID, T0 + 1_200)).toBeNull()
  })

  it('a sub-agent\'s events never arm, ask, or clear', async () => {
    const r = rig()
    r.store.apply(wrapUp(T0, C17_INPUT, { agent_id: 'sub-1' }), false)
    r.store.apply(stop(T0 + 100), false)
    r.desk.idle = 300
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID, T0 + 200)).toBeNull()
    await asked(r, T0 + 1_000)
    r.store.apply(env('UserPromptSubmit', T0 + 9_000, { agent_id: 'sub-1', prompt: 'x' }), false)
    r.store.apply(env('PreToolUse', T0 + 9_100, { agent_id: 'sub-1', tool_name: 'Bash', prompt_id: 'p9' }), false)
    expect(r.tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
  })

  it('an ask armed while on is not shown once the switch reads off', async () => {
    const on = { v: true }
    const tracker = new TurnEndAskTracker({ now: () => T0 + 200, enabled: () => on.v, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, pollMs: 3_600_000 })
    trackers.push(tracker)
    tracker.observe(wrapUp(T0), false)
    tracker.observe(stop(T0 + 100), false)
    await tracker.tick()
    expect(tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
    on.v = false
    expect(tracker.visibleAsk(SID)).toBeNull()
  })

  it('the tracker does nothing at all while its switch reads off', async () => {
    const tracker = new TurnEndAskTracker({ now: () => T0, enabled: () => false, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90 })
    trackers.push(tracker)
    tracker.observe(wrapUp(T0), false)
    tracker.observe(stop(T0 + 100), false)
    expect(await tracker.tick()).toBeNull()
    expect(tracker.visibleAsk(SID, T0 + 200)).toBeNull()
    expect(tracker.stats().armed).toBe(0)
  })
})

describe('what clears it', () => {
  it('UserPromptSubmit: any reply, from the desk or a COS Continue child', async () => {
    for (const child of [false, true]) {
      const r = rig()
      await asked(r)
      r.store.apply(env('UserPromptSubmit', T0 + 60_000, { prompt: 'Red' }), child)
      expect(r.tracker.visibleAsk(SID)).toBeNull()
      expect(r.tracker.stats()).toMatchObject({ clearedByReply: 1, tracked: 0 })
    }
  })

  it('SessionStart (not compact), SessionEnd, Interrupt, StopFailure', async () => {
    for (const [event, extra] of [['SessionStart', { source: 'resume' }], ['SessionStart', { source: 'startup' }], ['SessionEnd', { reason: 'exit' }], ['Interrupt', {}], ['StopFailure', { error: 'x' }]] as const) {
      const r = rig()
      await asked(r)
      r.store.apply(env(event, T0 + 60_000, extra), false)
      expect(r.tracker.visibleAsk(SID)).toBeNull()
      expect(r.tracker.stats().clearedByTurn).toBe(1)
    }
  })

  it('SessionStart compact keeps it', async () => {
    const r = rig()
    await asked(r)
    r.store.apply(env('SessionStart', T0 + 60_000, { source: 'compact' }), false)
    expect(r.tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
  })

  it('a COS child\'s SessionEnd or tool step is not the tab\'s new turn', async () => {
    const r = rig()
    await asked(r)
    r.store.apply(env('PreToolUse', T0 + 60_000, { tool_name: 'Bash', prompt_id: 'child-p' }), true)
    r.store.apply(env('SessionEnd', T0 + 61_000, { reason: 'exit' }), true)
    expect(r.tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
  })

  it('a new turn\'s tool step (another prompt, after the stop) clears; the same prompt\'s late events do not', async () => {
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'] as const) {
      const r = rig()
      await asked(r)
      r.store.apply(env(event, T0 + 5_000, { tool_name: 'Read', prompt_id: PROMPT }), false)
      expect(r.tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
      r.store.apply(env(event, T0 + 4_000, { tool_name: 'Read', prompt_id: 'p-new' }), false)
      expect(r.tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
      r.store.apply(env(event, T0 + 60_000, { tool_name: 'Read', prompt_id: 'p-new' }), false)
      expect(r.tracker.visibleAsk(SID)).toBeNull()
      expect(r.tracker.stats().clearedByTurn).toBe(1)
    }
  })

  it('a tool step with no prompt id after the stop is a new turn', async () => {
    const r = rig()
    await asked(r)
    r.store.apply(env('PreToolUse', T0 + 60_000, { tool_name: 'Read' }), false)
    expect(r.tracker.visibleAsk(SID)).toBeNull()
  })

  it('a later wrap_up of the same turn without a qualifying ask disarms the earlier one', async () => {
    const r = rig()
    r.store.apply(wrapUp(T0), false)
    r.store.apply(wrapUp(T0 + 1_000, { recap: 'Done.' }), false)
    r.store.apply(stop(T0 + 2_000), false)
    r.desk.idle = 300
    await r.tracker.tick()
    expect(r.tracker.visibleAsk(SID, T0 + 3_000)).toBeNull()
  })

  it('a wrap_up without an ask after the stop leaves the asked one alone (it belongs to no new turn)', async () => {
    const r = rig()
    await asked(r)
    r.store.apply(wrapUp(T0 + 4_800, { recap: 'x' }, { prompt_id: PROMPT }), false)
    expect(r.tracker.visibleAsk(SID)?.ask).toBe('Canary: which color?')
  })

  it('the row ending', async () => {
    const r = rig()
    await asked(r)
    r.tracker.sessionRowEnded(SID.slice(0, 8))
    expect(r.tracker.visibleAsk(SID)).toBeNull()
    expect(r.tracker.stats().clearedByTurn).toBe(1)
  })

  it('8 hours after the stop', async () => {
    const r = rig()
    await asked(r)
    const stoppedAt = T0 + 4_700
    expect(r.tracker.visibleAsk(SID, stoppedAt + TURN_ASK_MAX_AGE_MS)?.ask).toBe('Canary: which color?')
    expect(r.tracker.visibleAsk(SID, stoppedAt + TURN_ASK_MAX_AGE_MS + 1)).toBeNull()
    expect(r.tracker.stats()).toMatchObject({ agedOut: 1, tracked: 0 })
    expect(TURN_ASK_MAX_AGE_MS).toBe(8 * 60 * 60_000)
  })

  it('an ask that aged out before the desk was ever idle is dropped by the next read, never shown', async () => {
    const r = rig()
    r.store.apply(wrapUp(T0), false)
    r.store.apply(stop(T0 + 100), false)
    r.clock.now = T0 + 100 + TURN_ASK_MAX_AGE_MS + 1
    r.desk.idle = 300
    expect(await r.tracker.tick()).toBeNull()
    expect(r.tracker.stats()).toMatchObject({ shown: 0, agedOut: 1, tracked: 0 })
    expect(r.desk.reads).toBe(0)
  })

  it(`at most ${MAX_TURN_ASKS} sessions are tracked; the oldest go first`, () => {
    const r = rig()
    for (let i = 0; i <= MAX_TURN_ASKS; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      r.tracker.observe(env('PostToolUse', T0 + i, wrapUp(0).payload, id), false)
    }
    expect(r.tracker.stats().tracked).toBe(MAX_TURN_ASKS)
  })
})

describe('the row: an idle verdict becomes the asked-you wait, nothing else does', () => {
  const ask = { ask: 'Canary: which color?', choices: ['Red', 'Blue'], stoppedAt: T0 + 4_700 }
  const now = T0 + 200_000

  function idleSignal(): ReturnType<SessionSignalStore['get']> {
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    store.apply(env('UserPromptSubmit', T0 - 10_000, { prompt: 'go', prompt_id: PROMPT }), false)
    store.apply(wrapUp(T0), false)
    store.apply(stop(T0 + 4_700), false)
    return store.get(SID)
  }

  it('the contract row: waiting, question, the ask, the stop time, waiting_source turn_end, the choices; no pending ids', () => {
    const derived = deriveSessionState({ signal: idleSignal(), registry: undefined, transcript: undefined, now, turnEndAsk: ask })
    expect(derived).toMatchObject({
      agent_state: 'waiting', state_source: 'hook', state_since: new Date(T0 + 4_700).toISOString(),
      waiting_kind: 'question', waiting_detail: 'Canary: which color?', waiting_source: 'turn_end', waiting_choices: ['Red', 'Blue'],
    })
    const row = derivedRowFields(derived)
    expect(row).toMatchObject({ agent_state: 'waiting', waiting_source: 'turn_end', waiting_choices: ['Red', 'Blue'] })
    expect('pending_question_id' in row || 'pending_permission_id' in row).toBe(false)
    expect(derivedStatusFields(derived)).toMatchObject({ waiting_source: 'turn_end', waiting_choices: ['Red', 'Blue'] })
    // X1 7.0.36: the ask's identity rides with it on the row and the status, so an answer can name it.
    expect(derived.waiting_ask_id).toBe(`turn_end:${T0 + 4_700}`)
    expect(row).toMatchObject({ waiting_ask_id: `turn_end:${T0 + 4_700}` })
    expect(derivedStatusFields(derived)).toMatchObject({ waiting_ask_id: `turn_end:${T0 + 4_700}` })
    // The wait is dated by the ask's own stop, not by whatever the idle verdict was dated by.
    const other = deriveSessionState({ signal: idleSignal(), registry: undefined, transcript: undefined, now, turnEndAsk: { ...ask, stoppedAt: T0 + 1_234 } })
    expect(other.state_since).toBe(new Date(T0 + 1_234).toISOString())
  })

  it('without an ask the row is exactly the idle one (7.0.17)', () => {
    const signal = idleSignal()
    const base = deriveSessionState({ signal, registry: undefined, transcript: undefined, now })
    expect(base.agent_state).toBe('idle')
    expect(deriveSessionState({ signal, registry: undefined, transcript: undefined, now, turnEndAsk: null })).toEqual(base)
    expect(deriveSessionState({ signal, registry: undefined, transcript: undefined, now, turnEndAsk: undefined })).toEqual(base)
    const row = derivedRowFields(base)
    expect('waiting_source' in row || 'waiting_choices' in row).toBe(false)
  })

  it('never over running, a real wait, failed or ended', () => {
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    store.apply(env('UserPromptSubmit', now - 1_000, { prompt: 'go', prompt_id: 'p2' }), false)
    expect(deriveSessionState({ signal: store.get(SID), registry: undefined, transcript: undefined, now, turnEndAsk: ask }).agent_state).toBe('running')
    store.apply(env('PreToolUse', now - 500, { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Real?' }] }, prompt_id: 'p2' }), false)
    const real = deriveSessionState({ signal: store.get(SID), registry: undefined, transcript: undefined, now, turnEndAsk: ask })
    expect(real.agent_state).toBe('waiting')
    expect(real.waiting_source).toBeUndefined()
    store.apply(env('SessionEnd', now - 100, { reason: 'exit' }), false)
    expect(deriveSessionState({ signal: store.get(SID), registry: undefined, transcript: undefined, now, turnEndAsk: ask }).agent_state).toBe('ended')
    const failed = new SessionSignalStore({ isCosSpawnedPid: () => false })
    failed.apply(env('StopFailure', now - 100, { error: 'rate_limit' }), false)
    expect(deriveSessionState({ signal: failed.get(SID), registry: undefined, transcript: undefined, now, turnEndAsk: ask }).agent_state).toBe('failed')
  })

  it('a print run\'s signal (entrypoint sdk-cli) never shows one', () => {
    const signal = { ...idleSignal()!, entrypoint: 'sdk-cli' }
    expect(deriveSessionState({ signal, registry: undefined, transcript: undefined, now, turnEndAsk: ask }).agent_state).toBe('idle')
    expect(deriveSessionState({ signal: { ...signal, entrypoint: 'claude-desktop' }, registry: undefined, transcript: undefined, now, turnEndAsk: ask }).agent_state).toBe('waiting')
  })

  it('the registry busy again after the stop is a new turn; busy within the grace is the stop\'s own write', () => {
    const reg = (status: string, at: number): RegistryFacts => ({ alive: true, status, waitingFor: null, statusUpdatedAt: at, lastActiveAt: at })
    const signal = idleSignal()
    const at = (r: RegistryFacts, n: number) => deriveSessionState({ signal, registry: r, transcript: undefined, now: n, turnEndAsk: ask })
    // Registry busy later than the signal's last event and the stop+grace: the hooks have not caught up yet, it runs.
    expect(at(reg('busy', ask.stoppedAt + TURN_ASK_BUSY_GRACE_MS + 1), now).agent_state).toBe('idle')
    // Busy written within the grace of the stop: the stop's own write, still asked.
    expect(at(reg('busy', ask.stoppedAt + TURN_ASK_BUSY_GRACE_MS), now).agent_state).toBe('waiting')
    // A dead registry record (the tab gone, before the two-scan rule ends it) does not veto.
    expect(at({ ...reg('busy', ask.stoppedAt + 60_000), alive: false }, now).agent_state).toBe('waiting')
    expect(at(reg('idle', ask.stoppedAt + 60_000), now).agent_state).toBe('waiting')
  })

  it('the stream reads it idle (finished work), with the row fields riding along', () => {
    const derived = deriveSessionState({ signal: idleSignal(), registry: undefined, transcript: undefined, now, turnEndAsk: ask })
    const draft = statusDraftWithDerived({ kind: 'status', state: 'idle' }, derivedStatusFields(derived))
    expect(draft).toMatchObject({ state: 'idle', agent_state: 'waiting', waiting_source: 'turn_end', waiting_choices: ['Red', 'Blue'], waiting_detail: 'Canary: which color?' })
    // An ordinary wait still reads working on the stream.
    const plain = statusDraftWithDerived({ kind: 'status', state: 'idle' }, { ...derivedStatusFields(derived), waiting_source: undefined })
    expect(plain.state).toBe('working')
  })
})

describe('the runtime: deriveForRow and the counters', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved.e = process.env.COS_CLAUDE_SESSIONS_ENABLED
    saved.h = process.env.COS_SESSION_HOOKS
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    delete process.env.COS_SESSION_HOOKS
    __resetSessionHooksForTests()
  })
  afterEach(() => {
    __resetSessionHooksForTests()
    if (saved.e === undefined) delete process.env.COS_CLAUDE_SESSIONS_ENABLED; else process.env.COS_CLAUDE_SESSIONS_ENABLED = saved.e
    if (saved.h === undefined) delete process.env.COS_SESSION_HOOKS; else process.env.COS_SESSION_HOOKS = saved.h
  })

  function feed(): void {
    sessionSignalStore.apply(env('UserPromptSubmit', T0 - 10_000, { prompt: 'go', prompt_id: PROMPT }), false)
    sessionSignalStore.apply(wrapUp(T0), false)
    sessionSignalStore.apply(stop(T0 + 4_700), false)
  }

  it('switch off (no tracker): the row is 7.0.17\'s and there are no counters', () => {
    feed()
    const derived = deriveForRow({ sessionId: SID, now: T0 + 200_000 })
    expect(derived?.agent_state).toBe('idle')
    expect(derived && 'waiting_source' in derived).toBe(false)
    expect(turnEndAskStats()).toBeNull()
  })

  it('switch on: the row turns waiting once latched; a derive that ends the row clears it', async () => {
    const tracker = new TurnEndAskTracker({ now: () => T0 + 200_000, enabled: () => true, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, pollMs: 3_600_000 })
    trackers.push(tracker)
    __setTurnEndAskTrackerForTests(tracker)
    const off = sessionSignalStore.subscribe((signal, e, child) => tracker.observe(e, child, signal))
    try {
      feed()
      expect(deriveForRow({ sessionId: SID, now: T0 + 200_000 })?.agent_state).toBe('idle')
      await tracker.tick()
      expect(deriveForRow({ sessionId: SID, now: T0 + 200_000 })).toMatchObject({ agent_state: 'waiting', waiting_source: 'turn_end', waiting_detail: 'Canary: which color?' })
      expect(turnEndAskStats()).toMatchObject({ armed: 1, shown: 1, tracked: 1 })
      sessionSignalStore.apply(env('SessionEnd', T0 + 300_000, { reason: 'exit' }), false)
      expect(deriveForRow({ sessionId: SID, now: T0 + 300_000 })?.agent_state).toBe('ended')
      expect(turnEndAskStats()).toMatchObject({ tracked: 0, clearedByTurn: 1 })
    } finally {
      off()
    }
  })

  it('X1 7.0.39: personTurnMarker counts a mark only where a real turn has it: a whole footer line, or the answer words at the start', () => {
    const g2 = '[COS-G2 turn ctg2-00000001 · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ctg2-00000001 --session <your session id> --provider claude]'
    const web = g2.replace(/COS-G2/, 'COS-WEB')
    expect(personTurnMarker(`Yes, ship it\n${g2}`)).toBe('g2_footer')
    expect(personTurnMarker(`Approved\n${web}`)).toBe('web_footer')
    // A relayed dictation: Claude Desktop's own notes follow the footer inside the block (seen on every peer message of 11/14).
    expect(personTurnMarker(`<cross-session-message from="local_relay">\nYes\n${g2}\n\n<artifact-content-authored-by-others/>\nThe session that sent this message has handled Artifact content.\n</cross-session-message>`)).toBe('g2_footer')
    // The answer words need no mark: a real answer is bare, so typed words (his) before any mark is read.
    for (const bare of ['Answer sent from COS Control Web through COS, not typed in this session: Yes', '<system-reminder>x</system-reminder>\nAnswer sent from COS Control on the Mac through COS, not typed in this session: No']) {
      expect(isMachineOnlyPrompt(bare)).toBe(false)
    }
    for (const quote of [
      'the footer looks like [COS-G2 turn ctg2-00000001 · verify: x] in a quote',      // mid-line
      '[COS-G2 turn …] footer',                                                         // no id, no verify
      'a\n[cos-g2 turn ctg2-00000001 · verify: x]',                                     // not the case COS writes
      '[COS-G2 turn ct1 · verify: x]',                                                  // an id COS never makes
      '[COS-G2 turn ctg2-00000001]',                                                    // an id, at a line start, but no verify part
      'Quoting it:\n[COS-WEB turn ctweb-0000001] was the footer',                     // the same on a later line
      'Answer sent from COS Control Web through COS, not typed in this session: Yes',   // bare: his, but no mark needed
      '<cross-session-message from="x">Answer sent from COS Control Web through COS, not typed in this session: Yes</cross-session-message>',
      'Commands run, go', 'through COS', 'COS-G2', 42, null,
    ]) {
      expect(personTurnMarker(quote)).toBeNull()
    }
  })

  it('X1 7.0.38: the ledger keeps one boolean, set from the WHOLE prompt, so a replay of clipped words still knows', () => {
    const blocksOnly = '<cross-session-message from="local_1">' + 'x'.repeat(900) + '</cross-session-message>'
    const typedAfter = '<system-reminder>' + 'y'.repeat(900) + '</system-reminder>\nYes, ship it'
    expect(projectHookPayload('UserPromptSubmit', { session_id: SID, prompt: blocksOnly })).toMatchObject({ prompt_machine_only: true })
    const typed = projectHookPayload('UserPromptSubmit', { session_id: SID, prompt: typedAfter })
    expect('prompt_machine_only' in typed).toBe(false)
    expect(String(typed.prompt).length).toBeLessThan(typedAfter.length)
    expect('prompt_machine_only' in projectHookPayload('UserPromptSubmit', { session_id: SID, prompt: 'Commands run, go' })).toBe(false)
    // A whole footer line inside a block is his turn: no boolean. A quote of the marks inside a block is not: stamped.
    const footerLine = '[COS-G2 turn ctg2-00000001 · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ctg2-00000001 --session <your session id> --provider claude]'
    expect('prompt_machine_only' in projectHookPayload('UserPromptSubmit', { session_id: SID, prompt: `<cross-session-message from="g">Yes\n${footerLine}</cross-session-message>` })).toBe(false)
    for (const quote of ['Yes [COS-G2 turn ct1]', 'Answer sent from COS Control Web through COS, not typed in this session: Yes']) {
      expect(projectHookPayload('UserPromptSubmit', { session_id: SID, prompt: `<cross-session-message from="g">${quote}</cross-session-message>` })).toMatchObject({ prompt_machine_only: true })
    }
  })

  it('X1 7.0.38: a prompt the machine wrote clears the ask as moved on, never as answered; one he typed is still his answer', async () => {
    // Each round asks anew at its own time, so no round can lean on an earlier round's record (the 08:0x gate found
    // two mutants alive because every round reused one stop time and round 1's "answered" satisfied the rest).
    const clock = { now: T0 }
    const tracker = new TurnEndAskTracker({ now: () => clock.now, enabled: () => true, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, pollMs: 3_600_000 })
    trackers.push(tracker)
    __setTurnEndAskTrackerForTests(tracker)
    const off = sessionSignalStore.subscribe((signal, e, child) => tracker.observe(e, child, signal))
    let round = 0
    /** One round: the session asks at its own time, then `prompt` arrives; returns how the tracker cleared the ask. */
    const roundWith = async (prompt: string, child = false) => {
      const base = T0 + (++round) * 3_600_000
      const pid = `p-round-${round}`
      sessionSignalStore.apply(env('UserPromptSubmit', base - 10_000, { prompt: 'go', prompt_id: pid }), false)
      sessionSignalStore.apply(wrapUp(base, C17_INPUT, { prompt_id: pid }), false)
      sessionSignalStore.apply(stop(base + 4_700, pid), false)
      clock.now = base + 200_000
      await tracker.tick()
      const open = openTurnEndAsk(SID, clock.now)
      expect(open?.stoppedAt).toBe(base + 4_700)
      const before = turnEndAskStats()!
      sessionSignalStore.apply(env('UserPromptSubmit', base + 210_000, { prompt, prompt_id: `${pid}-next` }), child)
      clock.now = base + 211_000
      expect(openTurnEndAsk(SID, clock.now)).toBeNull()
      const after = turnEndAskStats()!
      return {
        answered: turnEndAskAnswered(SID, open!.stoppedAt, clock.now),
        byTurn: after.clearedByTurn - before.clearedByTurn,
        byReply: after.clearedByReply - before.clearedByReply,
      }
    }
    try {
      for (const machine of [
        '<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>\n',
        '<cross-session-message from="local_1">Lead to X1: go</cross-session-message>',
        '<task-notification>\n<task-id>b1</task-id></task-notification>',
        '<system-reminder>\nThe session was compacted.</system-reminder>',
        '<scheduled-task name="nightly">run</scheduled-task>',
        '<agent-message from="a1">done</agent-message>',
      ]) {
        expect(await roundWith(machine)).toEqual({ answered: null, byTurn: 1, byReply: 0 })
      }
      // The lead's condition (07:29): his own words bundled with harness blocks are still his answer, and so is anything
      // that cannot be shown to be blocks only (text before the first block, an unclosed or clipped block).
      for (const typed of [
        '<bash-input>ls</bash-input>',
        'Commands run, go',
        'Note <cross-session-message from="x"> quoted mid-text',
        'Approved <system-reminder>x</system-reminder>',
        'Approved\n<cross-session-message from="local_1">go</cross-session-message>',
        '<system-reminder>\nThe session was compacted.</system-reminder>\nYes, ship it',
        '<system-reminder>a</system-reminder><task-notification>b</task-notification> Approved',
        '<cross-session-message from="local_1">Lead to X1: clipped mid-blo…',
        '<system-reminder>a</system-reminder><cross-session-message from="local_1">unclosed',
      ]) {
        const r = await roundWith(typed)
        expect(r.answered).toMatchObject({ by: 'mac' })
        expect([r.byTurn, r.byReply]).toEqual([0, 1])
      }
      // Lead 08:02, tightened in 7.0.39: a turn Miles made through COS is never machine only, whatever wraps it; a
      // peer message that only QUOTES a mark is the session moving on. A real dictation carries a whole footer line
      // (footed() puts it on its own line), and Claude Desktop may append its own notes after it inside the block.
      const wrap = (inner: string) => `<cross-session-message from="local_relay">\n${inner}\n\n<artifact-content-authored-by-others/>\nThe session that sent this message has handled Artifact content written by people other than you.\n</cross-session-message>`
      const footer = (tag: string, id: string) => `[${tag} turn ${id} · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ${id} --session <your session id> --provider claude]`
      for (const [mark, inner, surface] of [
        ['g2 dictation', `Yes, ship it\n${footer('COS-G2', 'ctg2-00000001')}`, 'glasses'],
        ['web footer', `Approved\n${footer('COS-WEB', 'ctweb-0000001')}`, 'mac'],
      ] as const) {
        const r = await roundWith(wrap(inner))
        expect({ mark, by: (r.answered as { by?: string } | null)?.by }).toEqual({ mark, by: surface })
        expect([r.byTurn, r.byReply]).toEqual([0, 1])
      }
      // A G2 dictation after a reminder block is his too.
      const afterReminder = await roundWith('<system-reminder>x</system-reminder>\n' + wrap(`Approved\n${footer('COS-G2', 'ctg2-00000002')}`))
      expect(afterReminder.answered).toMatchObject({ by: 'glasses' })
      // Quotes of every mark in a peer message: moved on, never answered (the button stays on the page).
      for (const quote of [
        'Lead to X1: G2 turns carry a [COS-G2 turn …] footer; verify it before acting.',
        'Q1: the footer line reads `[COS-G2 turn ctg2-00000001 · verify: …]` in the log.',
        'Q1 to X1: the footer started\n[COS-G2 turn ctg2-00000001] and then the verify command',
        'Lead to X1: the web sends "Answer sent from COS Control Web through COS, not typed in this session: Approved".',
        'Answer sent from COS Control on the Mac through COS, not typed in this session: Not yet',
        'Answer sent from COS Glasses through COS, not typed in this session: Yes',
      ]) {
        expect(await roundWith(wrap(quote))).toEqual({ answered: null, byTurn: 1, byReply: 0 })
      }
      // Q1 S17: a COS-spawned Continue child carries words someone sent through COS. Blocks or not, it is a reply by COS.
      const child = await roundWith('<cross-session-message from="local_1">Lead to X1: go</cross-session-message>', true)
      expect(child.answered).toMatchObject({ by: 'cos' })
      expect([child.byTurn, child.byReply]).toEqual([0, 1])
    } finally {
      off()
    }
  })

  it('X1 7.0.36: openTurnEndAsk names the same ask the row shows (waiting_ask_id), and a new prompt clears it', async () => {
    expect(openTurnEndAsk(SID)).toBeNull()
    const tracker = new TurnEndAskTracker({ now: () => T0 + 200_000, enabled: () => true, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, pollMs: 3_600_000 })
    trackers.push(tracker)
    __setTurnEndAskTrackerForTests(tracker)
    const off = sessionSignalStore.subscribe((signal, e, child) => tracker.observe(e, child, signal))
    try {
      feed()
      await tracker.tick()
      const row = deriveForRow({ sessionId: SID, now: T0 + 200_000 })
      const open = openTurnEndAsk(SID, T0 + 200_000)
      expect(open).toMatchObject({ ask: 'Canary: which color?', choices: ['Red', 'Blue'] })
      expect(row?.waiting_ask_id).toBe(`turn_end:${open!.stoppedAt}`)
      sessionSignalStore.apply(env('UserPromptSubmit', T0 + 210_000, { prompt: 'Commands run, go', prompt_id: 'p-next' }), false)
      expect(openTurnEndAsk(SID, T0 + 210_000)).toBeNull()
      // Who answered it is kept for the ask's life, past the 2 minute display window: typed at the Mac.
      expect(turnEndAskAnswered(SID, open!.stoppedAt, T0 + 210_000 + 30 * 60_000)).toMatchObject({ by: 'mac', answeredAt: T0 + 210_000 })
      expect(turnEndAskAnswered(SID, open!.stoppedAt + 1, T0 + 210_000)).toBeNull()
      expect(turnEndAskAnswered(SID, open!.stoppedAt, open!.stoppedAt + 8 * 60 * 60_000 + 1)).toBeNull()
    } finally {
      off()
    }
  })

  it('a row the registry ends (dead pid on two scans, no SessionEnd) drops its ask', async () => {
    const tracker = new TurnEndAskTracker({ now: () => T0 + 200_000, enabled: () => true, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, pollMs: 3_600_000 })
    trackers.push(tracker)
    __setTurnEndAskTrackerForTests(tracker)
    const off = sessionSignalStore.subscribe((signal, e, child) => tracker.observe(e, child, signal))
    try {
      feed()
      await tracker.tick()
      const dead: RegistryFacts = { alive: false, status: 'idle', waitingFor: null, statusUpdatedAt: T0 + 5_000, lastActiveAt: T0 + 5_000 }
      const t = T0 + 200_000
      expect(deriveForRow({ sessionId: SID, registry: dead, now: t })?.agent_state).toBe('waiting')
      expect(deriveForRow({ sessionId: SID, registry: dead, now: t + DEAD_GRACE_MS })?.agent_state).toBe('ended')
      expect(turnEndAskStats()).toMatchObject({ tracked: 0, clearedByTurn: 1 })
    } finally {
      off()
    }
  })

  describe('startSessionHooksRuntime: the switch read at startup, and an ask that survives a restart', () => {
    const savedEnv: Record<string, string | undefined> = {}
    const KEYS = ['COS_GLASSES_HOME', 'COS_SESSION_HOOKS_SPOOL_DIR', 'COS_CLAUDE_SESSIONS_DIR'] as const
    let home = ''
    beforeEach(() => {
      for (const k of KEYS) savedEnv[k] = process.env[k]
      home = mkdtempSync(join(tmpdir(), 'x1-turn-ask-runtime-'))
      process.env.COS_GLASSES_HOME = home
      process.env.COS_SESSION_HOOKS_SPOOL_DIR = join(home, 'spool')
      process.env.COS_CLAUDE_SESSIONS_DIR = join(home, 'sessions')
      mkdirSync(join(home, 'sessions'), { recursive: true })
    })
    afterEach(() => {
      __setTurnEndAsksForTests(null)
      for (const k of KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
      rmSync(home, { recursive: true, force: true })
      try { rmSync(dataPath('session-hook-events.jsonl'), { force: true }) } catch { /* none */ }
    })

    function ledgerWithAsk(): number {
      const now = Date.now()
      const row = (ts: number, event: string, payload: Record<string, unknown>) => JSON.stringify({ key: `${ts}-1-${event}.json`, ts, ppid: 1, event, session_id: SID, entrypoint: 'claude-desktop', payload: { session_id: SID, ...payload } })
      writeFileSync(dataPath('session-hook-events.jsonl'), [
        row(now - 60_000, 'UserPromptSubmit', { prompt: 'go', prompt_id: PROMPT }),
        row(now - 50_000, 'PostToolUse', { tool_name: WRAP_UP_TOOL, prompt_id: PROMPT, turn_ask: { ask: 'Canary: which color?', choices: ['Red', 'Blue'], blocked: false } }),
        row(now - 45_000, 'Stop', { prompt_id: PROMPT, last_assistant_message: 'done' }),
      ].join('\n') + '\n')
      return now - 45_000
    }

    it('off: no tracker, no counters, the replayed row is idle', () => {
      __setTurnEndAsksForTests(false)
      ledgerWithAsk()
      const runtime = startSessionHooksRuntime({ port: 3141 })
      try {
        expect(turnEndAskStats()).toBeNull()
        expect(deriveForRow({ sessionId: SID })?.agent_state).toBe('idle')
      } finally {
        runtime.stop()
      }
    })

    it('on: the ask asked before the restart is armed and stopped again from the ledger', () => {
      __setTurnEndAsksForTests(true)
      ledgerWithAsk()
      const runtime = startSessionHooksRuntime({ port: 3141 })
      try {
        expect(turnEndAskStats()).toMatchObject({ armed: 1, tracked: 1 })
      } finally {
        runtime.stop()
      }
    })
  })
})
