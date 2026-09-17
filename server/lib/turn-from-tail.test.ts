// `turnFromTail` (6.48.1): the transcript's own turn-end rule, executed on record
// shapes copied from real Desktop transcripts on this Mac (2026-09-15): assistant
// records carry `message.stop_reason` (`tool_use` while tools run, `end_turn` at the
// end), tool results ride user records, bookkeeping rows have no message.

import { describe, expect, it } from 'vitest'
import { draftsFromLine, turnFromTail } from './session-stream-events.js'
import { withHookTurnClock, type HookTurnSignal } from './occupancy-probes.js'
import type { OccupancyProbes } from './thread-occupancy.js'

const j = (o: unknown) => JSON.stringify(o)
const user = (text: string, extra: Record<string, unknown> = {}) => j({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra })
const toolUse = (id: string) => j({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
const toolResult = (id: string) => j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const endTurn = (text = 'done') => j({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
const bookkeeping = [j({ type: 'last-prompt' }), j({ type: 'mode' }), j({ type: 'system', subtype: 'x' }), j({ type: 'attachment' })]

describe('turnFromTail', () => {
  it('a terminal stop_reason with every tool answered ends the turn; bookkeeping rows after it change nothing', () => {
    expect(turnFromTail('claude', [user('hi'), toolUse('t1'), toolResult('t1'), endTurn(), ...bookkeeping])).toEqual({ ended: true, reason: 'terminal_stop' })
    for (const stop of ['stop_sequence', 'max_tokens', 'refusal']) {
      const line = j({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'x' }] } })
      expect(turnFromTail('claude', [user('hi'), line]).ended).toBe(true)
    }
  })

  it('a tool_use awaiting its result keeps the turn open, even after a terminal stop on a later record', () => {
    expect(turnFromTail('claude', [user('hi'), toolUse('t1')])).toEqual({ ended: false, reason: 'tool_pending' })
    expect(turnFromTail('claude', [user('hi'), toolUse('t1'), endTurn()])).toEqual({ ended: false, reason: 'tool_pending' })
    expect(turnFromTail('claude', [user('hi'), toolUse('t1'), toolResult('t1')])).toEqual({ ended: false, reason: 'tool_pending' })
  })

  it('a user prompt after the reply reopens it, a task-notification included; meta and compact rows do not', () => {
    expect(turnFromTail('claude', [user('hi'), endTurn(), user('and this?')])).toEqual({ ended: false, reason: 'prompt_open' })
    expect(turnFromTail('claude', [user('hi'), endTurn(), user('<task-notification><task-id>x</task-id></task-notification>')])).toEqual({ ended: false, reason: 'prompt_open' })
    expect(turnFromTail('claude', [user('hi'), endTurn(), user('<system-reminder>ctx</system-reminder>', { isMeta: true })])).toEqual({ ended: true, reason: 'terminal_stop' })
    expect(turnFromTail('claude', [user('hi'), endTurn(), user('summary', { isCompactSummary: true })])).toEqual({ ended: true, reason: 'terminal_stop' })
  })

  it('a prompt QUEUED during the Stop hooks keeps the turn open; a cross-session message (isMeta, promptSource system) is a prompt', () => {
    // QA 2026-09-15: Claude writes a `queue-operation` row for a prompt typed while the
    // Stop hooks run, dequeues it when they return, then writes the user row.
    const enqueue = j({ type: 'queue-operation', operation: 'enqueue', timestamp: 'x' })
    const dequeue = j({ type: 'queue-operation', operation: 'dequeue', timestamp: 'y' })
    expect(turnFromTail('claude', [user('hi'), endTurn(), enqueue])).toEqual({ ended: false, reason: 'prompt_queued' })
    expect(turnFromTail('claude', [user('hi'), endTurn(), enqueue, dequeue, user('queued one')])).toEqual({ ended: false, reason: 'prompt_open' })
    expect(turnFromTail('claude', [user('hi'), endTurn(), user('Another Claude session sent a message: hello', { isMeta: true, promptSource: 'system' })])).toEqual({ ended: false, reason: 'prompt_open' })
    expect(turnFromTail('claude', [user('hi'), endTurn(), user('ctx', { isMeta: true, promptSource: 'user' })])).toEqual({ ended: true, reason: 'terminal_stop' })
  })

  it('an interrupt ends the turn without a reply; a print-mode result row ends it too', () => {
    expect(turnFromTail('claude', [user('hi'), toolUse('t1'), user('[Request interrupted by user for tool use]')])).toEqual({ ended: true, reason: 'interrupted' })
    expect(turnFromTail('claude', [user('hi'), toolUse('t1'), j({ type: 'result', subtype: 'success' })])).toEqual({ ended: true, reason: 'result_row' })
  })

  it('no evidence is not ended, and garbage costs nothing', () => {
    expect(turnFromTail('claude', [])).toEqual({ ended: false, reason: 'no_evidence' })
    expect(turnFromTail('claude', ['not json', '{"type":"attachment"}', ''])).toEqual({ ended: false, reason: 'no_evidence' })
  })

  it('codex keeps its event rule', () => {
    expect(turnFromTail('codex', [j({ type: 'event_msg', payload: { type: 'task_started' } })])).toEqual({ ended: false, reason: 'prompt_open' })
    expect(turnFromTail('codex', [j({ type: 'event_msg', payload: { type: 'task_started' } }), j({ type: 'event_msg', payload: { type: 'task_complete' } })])).toEqual({ ended: true, reason: 'codex_complete' })
  })

  it('agrees with the live feed wherever the feed states an end (a print-mode result row), and says more where it cannot', () => {
    const printRun = [j({ type: 'system', subtype: 'init' }), user('hi'), endTurn(), j({ type: 'result', subtype: 'success' })]
    const feedEnded = printRun.flatMap(l => draftsFromLine('claude', l)).filter(d => d.kind === 'status').at(-1)
    expect(feedEnded).toEqual({ kind: 'status', state: 'done' })
    expect(turnFromTail('claude', printRun).ended).toBe(true)
    // A Desktop tail has no result row: the feed cannot say ended, the tail rule can.
    const desktop = [user('hi'), toolUse('t1'), toolResult('t1'), endTurn(), ...bookkeeping]
    expect(desktop.flatMap(l => draftsFromLine('claude', l)).some(d => d.kind === 'status' && d.state === 'done')).toBe(false)
    expect(turnFromTail('claude', desktop).ended).toBe(true)
  })
})

describe('withHookTurnClock', () => {
  const base: OccupancyProbes = {
    isAlive: () => true, processStartMs: () => null, fileExists: () => false, dirExists: () => false,
    readDir: () => [], readFile: () => null, lockHolders: () => [], cosSpawnedPids: () => new Map(),
  }
  const FULL = 'a1b2c3d4-0000-4000-8000-000000000001'
  const signal = (over: Partial<HookTurnSignal> = {}): HookTurnSignal => ({
    lastEvent: 'Stop', turnOpen: false, subagentsOpen: 0, ended: null, stopAt: 1_000, ...over,
  })
  const idle = () => true

  it('answers the Stop time only when the store vouches: no turn since the Stop, no sub-agent open, not ended', () => {
    const probe = withHookTurnClock(base, () => signal(), idle).holderTurnEndedAtMs!
    expect(probe('claude', FULL)).toBe(1_000)
    expect(withHookTurnClock(base, () => signal({ lastEvent: 'PostToolUse' }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
    expect(withHookTurnClock(base, () => signal({ lastEvent: 'UserPromptSubmit' }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
    expect(withHookTurnClock(base, () => signal({ lastEvent: 'SubagentStart' }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
    expect(withHookTurnClock(base, () => signal({ lastEvent: 'PermissionRequest' }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
    expect(withHookTurnClock(base, () => signal({ turnOpen: true }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
    expect(withHookTurnClock(base, () => signal({ subagentsOpen: 1 }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
    expect(withHookTurnClock(base, () => signal({ ended: { at: 1, reason: 'other' } }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
    expect(withHookTurnClock(base, () => undefined, idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
  })

  it("the desk's own bookkeeping after a Stop is not a turn (6.50.2): an away-summary sub-agent stopping, or an idle notification, keeps the vouch", () => {
    // Miles, 2026-09-17 07:00:47: five sends refused native_thread_working. Claude
    // Desktop had written an `away_summary` system row to the transcript 11 s earlier
    // (the note it drops when you come back to a tab) and its sub-agent fired
    // SubagentStop; the newest event was no longer 'Stop', so the probe went strict and
    // the 30 s transcript window held. Clicking away and waiting was the only way out.
    for (const lastEvent of ['SubagentStop', 'Notification'] as const) {
      expect(withHookTurnClock(base, () => signal({ lastEvent }), idle).holderTurnEndedAtMs!('claude', FULL)).toBe(1_000)
      // The other guards still hold behind it.
      expect(withHookTurnClock(base, () => signal({ lastEvent, turnOpen: true }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
      expect(withHookTurnClock(base, () => signal({ lastEvent, subagentsOpen: 1 }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
      expect(withHookTurnClock(base, () => signal({ lastEvent, stopAt: null }), idle).holderTurnEndedAtMs!('claude', FULL)).toBeNull()
    }
  })

  it('and only when the REGISTRY vouches too: idle at or after the Stop is the engine\'s end of turn; busy, or no record, is strict', () => {
    // The Stop hook is not the end of the turn: the COS repo's Stop hooks run 12-38 s
    // and the engine flips the registry idle only when they have returned. A prompt
    // typed during them flips it busy instead. QA round, 2026-09-15.
    const asked: Array<[string, number]> = []
    const vouch = (answer: boolean | null) => withHookTurnClock(base, () => signal({ stopAt: 5_000 }), (id, at) => { asked.push([id, at]); return answer }).holderTurnEndedAtMs!
    expect(vouch(true)('claude', FULL)).toBe(5_000)
    expect(vouch(false)('claude', FULL)).toBeNull()
    expect(vouch(null)('claude', FULL)).toBeNull()
    // Asked with the session AND the Stop instant, so the record must have moved after it.
    expect(asked).toEqual([[FULL, 5_000], [FULL, 5_000], [FULL, 5_000]])
  })

  it('never answers for codex, nor for an id that is not a full Claude session id', () => {
    const asked: string[] = []
    const probe = withHookTurnClock(base, id => { asked.push(id); return signal() }, idle).holderTurnEndedAtMs!
    expect(probe('codex', FULL)).toBeNull()
    expect(probe('claude', FULL.slice(0, 8))).toBeNull()
    expect(asked).toEqual([])
  })
})
