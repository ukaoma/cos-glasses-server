// 2026-11-11 (S1, lanes/S1_queue_hold_diagnosis.md): Claude Code 2.1.300+ writes `api-request-blob` rows into a
// Desktop transcript: no timestamp, `message.role` user, assistant or system, copies of earlier blocks, written AFTER
// the tool results they repeat. turnFromTail read a copied `tool_use` as a new reply, re-opened a tool that had already
// answered, and the queue held a parked turn for an idle session until 30 minutes of quiet (Miles's 08:01:25 note).
//
// The tail below is the SHAPE of the lead session's real tail at 08:07 (record types, key sets, block kinds and order,
// read from the file), with placeholder words. No user text from any transcript is in this file.
import { describe, expect, it } from 'vitest'
import { turnFromTail } from './session-stream-events.js'
import { makeQueueTurnEvidence } from './queue-turn-evidence.js'
import { drainDecision } from './thread-turn-queue.js'

const SID = '00000000-0000-4000-8000-000000000001'
const at = (s: number) => new Date(Date.UTC(2026, 10, 11, 14, 6, s)).toISOString()
const row = (r: Record<string, unknown>) => JSON.stringify(r)

/** queue-operation, prompt, a two-tool reply and its results, then the api-request rows and blobs, then end_turn. */
function realShapedTail(extra: { afterEnd?: string[]; finalToolPending?: boolean } = {}): string[] {
  const lines = [
    row({ type: 'queue-operation', operation: 'enqueue', timestamp: at(3), sessionId: SID }),
    row({ type: 'queue-operation', operation: 'dequeue', timestamp: at(3), sessionId: SID }),
    row({ type: 'user', timestamp: at(3), sessionId: SID, message: { role: 'user', content: 'placeholder prompt' } }),
    row({ type: 'attachment', timestamp: at(11), sessionId: SID }),
    row({ type: 'api-request', timestamp: at(12), sessionId: SID, id: 'req-1', version: '2.1.317' }),
    row({ type: 'assistant', timestamp: at(13), sessionId: SID, message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: '' }, { type: 'tool_use', id: 'toolu_A', name: 'SendMessage', input: {} }, { type: 'tool_use', id: 'toolu_B', name: 'SendMessage', input: {} },
    ] } }),
    row({ type: 'user', timestamp: at(14), sessionId: SID, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' }, { type: 'tool_result', tool_use_id: 'toolu_B', content: 'ok' },
    ] } }),
    row({ type: 'api-request', timestamp: at(15), sessionId: SID, id: 'req-2', version: '2.1.317' }),
    // The blobs: the request's copy of the history, written after the results it repeats. No timestamp.
    row({ type: 'api-request-blob', hash: 'h1', sessionId: SID, message: { role: 'system', content: [{ type: 'text', text: 'placeholder' }] } }),
    row({ type: 'api-request-blob', hash: 'h2', sessionId: SID, message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '' }, { type: 'tool_use', id: 'toolu_A', name: 'SendMessage', input: {} }, { type: 'tool_use', id: 'toolu_B', name: 'SendMessage', input: {} },
    ] } }),
    row({ type: 'api-request-blob', hash: 'h3', sessionId: SID, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' },
    ] } }),
    extra.finalToolPending
      ? row({ type: 'assistant', timestamp: at(16), sessionId: SID, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_C', name: 'Bash', input: {} }] } })
      : row({ type: 'assistant', timestamp: at(16), sessionId: SID, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'placeholder reply' }] } }),
    ...(extra.afterEnd ?? []),
    row({ type: 'attachment', timestamp: at(44), sessionId: SID }),
    row({ type: 'system', subtype: 'stop_hook_summary', timestamp: at(44), sessionId: SID }),
  ]
  return lines
}

describe('turnFromTail and Claude Code request blobs (api-request-blob)', () => {
  it('a turn that ended reads ended, though a blob repeats its answered tool calls after their results', () => {
    expect(turnFromTail('claude', realShapedTail())).toEqual({ ended: true, reason: 'terminal_stop' })
  })

  it('a blob after the reply, of any role, opens nothing', () => {
    const afterEnd = [
      row({ type: 'api-request-blob', hash: 'h4', sessionId: SID, message: { role: 'user', content: [{ type: 'text', text: 'placeholder' }] } }),
      row({ type: 'api-request-blob', hash: 'h5', sessionId: SID, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_D', name: 'Bash', input: {} }] } }),
    ]
    expect(turnFromTail('claude', realShapedTail({ afterEnd }))).toEqual({ ended: true, reason: 'terminal_stop' })
  })

  it('a row type this build does not know fails toward ended, whatever its role', () => {
    const afterEnd = [
      row({ type: 'some-future-row', sessionId: SID, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_E', name: 'Bash', input: {} }] } }),
      row({ sessionId: SID, message: { role: 'user', content: 'placeholder with no type' } }),
    ]
    expect(turnFromTail('claude', realShapedTail({ afterEnd }))).toEqual({ ended: true, reason: 'terminal_stop' })
  })

  it('a real open tool still reads open, and a real prompt after the reply still reads open', () => {
    expect(turnFromTail('claude', realShapedTail({ finalToolPending: true }))).toEqual({ ended: false, reason: 'tool_pending' })
    const prompt = [row({ type: 'user', timestamp: at(50), sessionId: SID, message: { role: 'user', content: 'placeholder next prompt' } })]
    expect(turnFromTail('claude', realShapedTail({ afterEnd: prompt }))).toEqual({ ended: false, reason: 'prompt_open' })
  })

  it('through the queue: the parked turn for an idle session is delivered, not held for 30 minutes', () => {
    const now = Date.parse(at(59)) + 60_000 // a minute after the Stop hooks, well inside the 30-minute ceiling
    const lines = realShapedTail()
    const evidence = makeQueueTurnEvidence({
      signalFor: () => undefined, // hooks silent: the tail is the only evidence, as on a server without hooks
      registryIdleAfterStop: () => null,
      deskEndedAt: () => null,
      transcriptMtimeMs: () => Date.parse(at(44)),
      transcriptVerdict: () => turnFromTail('claude', lines),
      threadCancel: () => null,
      openTurnCeilingMs: 30 * 60_000,
      now: () => now,
    })
    expect(evidence.turnOpen('claude', SID)).toBe(false)
    expect(evidence.turnEnded('claude', SID)).toBe(true)
    const decision = drainDecision({ status: 'waiting', queuedAt: now - 5 * 60_000, attempts: 0 }, {
      attachable: true, turnEnded: evidence.turnEnded('claude', SID), turnOpen: evidence.turnOpen('claude', SID), activity: 'idle',
    }, now)
    expect(decision).toBe('deliver')
  })
})
