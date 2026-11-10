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
import { projectHookPayload, type HookEnvelope } from './session-hook-events.js'
import { SessionSignalStore } from './session-signal-store.js'
import { SessionHookLedger } from './session-hook-ledger.js'
import { deriveSessionState, derivedRowFields, derivedStatusFields, type RegistryFacts } from './session-state-derive.js'
import { statusDraftWithDerived } from './session-stream-events.js'
import { __resetSessionHooksForTests, __setTurnEndAskTrackerForTests, deriveForRow, sessionSignalStore, turnEndAskStats } from './session-hooks-runtime.js'

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
})
