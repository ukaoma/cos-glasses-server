// 6.62.0 release gate (QA W15): the provider parity suite. ONE scripted turn (a prompt, tool
// events, a quiet gap inside the five-minute cap, a quiet gap past it, the end of the turn)
// replayed as Claude, Codex and Cursor through the REAL path every row takes:
//
//   applyHookEvent (the reducer)  ->  deriveSessionState  ->  runningHintFor  ->  withRunning
//
// asserting the same `running`, `running_active` and `agent_state` at each step wherever the
// engines allow it, and asserting the HONEST difference wherever they do not (an engine
// limit). The occupancy each engine really has is modelled as it is in the list route:
// a Claude Desktop tab and a Codex Desktop thread are HELD by a desk process (a registry
// record, a writer lock); a Cursor IDE composer has no process occupancy at all.

import { describe, expect, it } from 'vitest'
import type { HookEnvelope, HookEventName, HookProvider } from '../lib/session-hook-events.js'
import type { OccupiedScan } from '../lib/occupied-threads.js'
import { applyHookEvent, type SessionSignal } from '../lib/session-signal-store.js'
import { OPEN_TURN_CEILING_MS, deriveSessionState, type RegistryFacts } from '../lib/session-state-derive.js'
import { HOOK_ACTIVE_CAP_MS } from '../lib/codex-rollout-state.js'
import { cancelTargetFor } from '../lib/session-cancel.js'
import { runningHintFor, withRunning } from './agent-sessions.js'

const ENGINES: readonly HookProvider[] = ['claude', 'codex', 'cursor']
const ID: Record<HookProvider, string> = {
  claude: 'a1b2c3d4-0000-4000-8000-00000000abcd',
  codex: '01a10c4b-0000-7000-8000-00000000c0de',
  cursor: '8c149bba-82b6-4b73-9f2f-eb26e72a72a9',
}
const noSpawn = { isCosSpawnedPid: () => false }
const T0 = 1_790_000_000_000

/** One hook event as each engine's hook delivers it (the payload keys the server reads). */
function event(engine: HookProvider, ts: number, name: HookEventName, extra: Record<string, unknown> = {}): HookEnvelope {
  const id = ID[engine]
  const own = engine === 'codex'
    ? { transcript_path: `/Users/me/.codex/sessions/2026/10/05/rollout-${id}.jsonl`, turn_id: 't1' }
    : engine === 'cursor' ? { conversation_id: id, cursor_version: '2026.10.01' } : { transcript_path: `/Users/me/.claude/projects/p/${id}.jsonl` }
  return { ts, ppid: 4242, event: name, sessionId: id, provider: engine, ...(engine === 'codex' ? { stamped: true as const } : {}), payload: { session_id: id, ...own, ...extra } }
}

/** The scripted turn, minus its ending. */
const TURN: Array<[number, HookEventName, Record<string, unknown>]> = [
  [0, 'UserPromptSubmit', { prompt: 'Fix the queue' }],
  [5_000, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }],
  [20_000, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/repo/queue.ts' } }],
]
const LAST = T0 + 20_000

/** The occupancy each engine has while its desk app is open (see the header). */
function scanFor(engine: HookProvider): OccupiedScan {
  const id = ID[engine]
  return engine === 'cursor'
    ? { occupied: new Map(), degraded: false }
    : { occupied: new Map([[id, { threadId: id, owners: 1, foreignOwners: 1, activeRecently: false }]]), degraded: false }
}

/** Registry facts as the list route passes them: Codex's writer-lock holder; none for this Claude tab. */
function registryFor(engine: HookProvider): RegistryFacts | undefined {
  return engine === 'codex' ? { alive: true, status: null, waitingFor: null, statusUpdatedAt: null, lastActiveAt: null } : undefined
}

/** The turn as heard up to `until` (every event, by default), plus an ending. */
function replay(engine: HookProvider, ending: Array<[number, HookEventName, Record<string, unknown>]> = [], until = Infinity): SessionSignal {
  let signal: SessionSignal | undefined
  for (const [at, name, extra] of [...TURN, ...ending]) {
    if (T0 + at > until) break
    signal = applyHookEvent(signal, event(engine, T0 + at, name, extra), noSpawn)
  }
  return signal!
}

/** The three wire fields the lens and the phone read, at `now`, through the real path. */
function wire(engine: HookProvider, signal: SessionSignal, now: number, registry = registryFor(engine)) {
  const derived = deriveSessionState({ signal, registry, transcript: undefined, now })
  const hint = runningHintFor(engine, derived, signal.lastEventAt, now)
  const row = withRunning({ session_id: ID[engine] }, scanFor(engine), hint)
  return { agent_state: derived.agent_state, running: row.running, running_active: row.running_active, running_foreign: row.running_foreign }
}

function across(signalOf: (engine: HookProvider) => SessionSignal, now: number) {
  return Object.fromEntries(ENGINES.map(engine => [engine, wire(engine, signalOf(engine), now)])) as Record<HookProvider, ReturnType<typeof wire>>
}

describe('one scripted turn, three engines: the same working hint (QA W15)', () => {
  const open = (engine: HookProvider) => replay(engine)
  const working = { agent_state: 'running', running: true, running_active: true, running_foreign: true }

  it('just after the prompt and during the tool events: running, active, everywhere', () => {
    for (const now of [T0 + 1_000, T0 + 6_000, LAST + 1_000]) {
      const states = across(engine => replay(engine, [], now), now)
      for (const engine of ENGINES) expect(states[engine], `${engine} at +${now - T0} ms`).toEqual(working)
    }
  })

  it('a quiet gap inside the cap (90 s with no event: a long think or a slow tool): still active everywhere', () => {
    const states = across(open, LAST + 90_000)
    for (const engine of ENGINES) expect(states[engine], engine).toEqual(working)
  })

  it('a quiet gap past the cap: OPEN and quiet everywhere (held, not active), still running by the hooks', () => {
    const states = across(open, LAST + HOOK_ACTIVE_CAP_MS + 60_000)
    const openQuiet = { agent_state: 'running', running: true, running_active: false, running_foreign: true }
    for (const engine of ENGINES) expect(states[engine], engine).toEqual(openQuiet)
  })

  it('the turn ends with a Stop: idle and not active everywhere', () => {
    const states = across(engine => replay(engine, [[60_000, 'Stop', { last_assistant_message: 'Fixed.' }]]), T0 + 61_000)
    for (const engine of ENGINES) {
      expect(states[engine].agent_state, engine).toBe('idle')
      expect(states[engine].running_active, engine).toBe(false)
    }
    // ENGINE LIMIT: a Claude tab and a Codex Desktop thread stay OPEN in their desk app after
    // the turn (a registry record, a writer lock); an IDE composer has no process occupancy, so
    // once its hooks say the turn is over it reads not running.
    expect([states.claude.running, states.codex.running, states.cursor.running]).toEqual([true, true, false])
  })
})

describe('the engine limits, asserted as the honest difference (QA W15)', () => {
  it('Esc: Codex says so (Interrupt, idle at once); Claude needs its registry; Cursor has neither and reads open', () => {
    const now = LAST + 2_000
    const codex = wire('codex', replay('codex', [[21_000, 'Interrupt', {}]]), now)
    expect(codex).toMatchObject({ agent_state: 'idle', running_active: false })
    // Claude fires nothing on Esc: its registry moving to idle after the last hook event ends it.
    const claudeSignal = replay('claude')
    expect(wire('claude', claudeSignal, now, { alive: true, status: 'idle', waitingFor: null, statusUpdatedAt: LAST + 1_000, lastActiveAt: LAST + 1_000 })).toMatchObject({ agent_state: 'idle', running_active: false })
    // Cursor fires nothing on Esc either, and has no registry: active until the cap, then open
    // and quiet until the 30-minute ceiling, then not running.
    const cursor = replay('cursor')
    expect(wire('cursor', cursor, now)).toMatchObject({ agent_state: 'running', running: true, running_active: true })
    expect(wire('cursor', cursor, LAST + HOOK_ACTIVE_CAP_MS + 1_000)).toMatchObject({ agent_state: 'running', running: true, running_active: false })
    expect(wire('cursor', cursor, LAST + OPEN_TURN_CEILING_MS + 1_000)).toMatchObject({ running: false, running_active: false })
  })

  it('a SessionEnd then a new prompt: Codex and Cursor revive at once; a Claude tab revives through its SessionStart', () => {
    const ended = (engine: HookProvider) => replay(engine, [[30_000, 'SessionEnd', { reason: 'other' }], [40_000, 'UserPromptSubmit', { prompt: 'again' }]])
    const now = T0 + 41_000
    expect(deriveSessionState({ signal: ended('codex'), registry: undefined, transcript: undefined, now }).agent_state).toBe('running')
    expect(deriveSessionState({ signal: ended('cursor'), registry: undefined, transcript: undefined, now }).agent_state).toBe('running')
    expect(deriveSessionState({ signal: ended('claude'), registry: undefined, transcript: undefined, now }).agent_state).toBe('ended')
    const resumed = replay('claude', [[30_000, 'SessionEnd', { reason: 'other' }], [35_000, 'SessionStart', { source: 'resume' }], [40_000, 'UserPromptSubmit', { prompt: 'again' }]])
    expect(deriveSessionState({ signal: resumed, registry: undefined, transcript: undefined, now }).agent_state).toBe('running')
  })

  it('cancel at the desk mid-turn: the same desk_run once each engine\'s hooks can stop it, the honest refusal until then', () => {
    const facts = (engine: HookProvider, extra: Record<string, unknown> = {}) =>
      ({ provider: engine, threadId: ID[engine], cosTurnInFlight: false, runningOutsideCos: true, hooksEnabled: true, hooksReady: true, codexHooksReady: true, cursorHooksReady: true, threadHookSeen: true, ...extra })
    for (const engine of ENGINES) expect(cancelTargetFor(facts(engine)), engine).toBe('desk_run')
    // Codex: hooks not yet trusted in Codex. Cursor: only an earlier script. Either: no hook of
    // that engine seen for the thread yet. Claude: its own words (Install hooks).
    expect(cancelTargetFor(facts('codex', { codexHooksReady: false }))).toBe('unsupported')
    expect(cancelTargetFor(facts('cursor', { cursorHooksReady: false }))).toBe('unsupported')
    expect(cancelTargetFor(facts('codex', { threadHookSeen: false }))).toBe('unsupported')
    expect(cancelTargetFor(facts('cursor', { threadHookSeen: false }))).toBe('unsupported')
    expect(cancelTargetFor(facts('claude', { hooksReady: false }))).toBe('hooks_outdated')
    expect(cancelTargetFor(facts('claude', { threadHookSeen: false, codexHooksReady: false, cursorHooksReady: false }))).toBe('desk_run')
  })
})
