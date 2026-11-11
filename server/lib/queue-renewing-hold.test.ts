// The renewing hold (Q1 2026-11-11 10:17 blocker 3; lead 10:23). Field fact: Miles's queued note was held 124.5 min
// on 7.0.23 (08:01:25 to 10:05:57) while the lead session kept ending and starting turns. Every Claude Code
// `api-request-blob` row (no timestamp, message.role assistant, a copy of answered tool calls) read as an open tool
// (`tool_pending`), and the 30-minute evidence ceiling counts from the transcript's last write, so each new turn's
// writes renewed the hold. Fix A (turnFromTail reads rows by type only) ends it at the first real gap.
//
// A timeline of several turns, swept the way the drain sweeps. REAL turnFromTail, REAL makeQueueTurnEvidence, REAL
// drainDecision, REAL holderActivity (the gate's 30 s transcript clock). The gate's B6 clause (registry idle after a
// Stop) and the hook signal are modelled from the timeline. Structure only: no transcript text from anywhere.
//
// Two kinds of gap between turns, both seen in the lead session's own transcript on 11/11:
//   CLOSED: a cross-session prompt arrives during the Stop hooks (`queue-operation` enqueue, read `prompt_queued`),
//           the hooks return, the queued prompt dequeues and the next turn starts at once. There is no idle moment;
//           the note correctly waits, on every version (Q1's second case).
//   REAL:   nothing arrives; the hooks return and the registry flips idle. The note goes here, with fix A.
import { describe, expect, it } from 'vitest'
import { turnFromTail } from './session-stream-events.js'
import { makeQueueTurnEvidence, type TurnEvidenceSignal } from './queue-turn-evidence.js'
import { drainDecision } from './thread-turn-queue.js'
import { holderActivity } from './thread-occupancy.js'
import { OPEN_TURN_CEILING_MS } from './session-state-derive.js'

const SID = '00000000-0000-4000-8000-0000000000aa'
const T0 = Date.parse('2026-11-11T14:00:00.000Z')
const s = (sec: number) => T0 + sec * 1000

interface Row { at: number; line: string }
interface Hook { at: number; event: 'UserPromptSubmit' | 'Stop' }

/** Build `turns` turns, each with a tool call, its result, the request's blob copy, and an end_turn reply. Every gap
 *  but the last is CLOSED by a cross-session prompt queued during the Stop hooks; the last gap is REAL. */
function timeline(turns: number) {
  const rows: Row[] = []
  const hooks: Hook[] = []
  const registryIdle: number[] = [] // times the registry flipped idle (only after a REAL gap)
  const row = (at: number, r: Record<string, unknown>) => rows.push({ at, line: JSON.stringify(r) })
  const ts = (at: number) => new Date(at).toISOString()
  const toolIds: string[] = []
  let t = 0
  for (let n = 0; n < turns; n++) {
    const id = `toolu_${n}`
    toolIds.push(id)
    if (n === 0) {
      row(s(t), { type: 'queue-operation', operation: 'enqueue', timestamp: ts(s(t)), sessionId: SID })
    }
    row(s(t), { type: 'queue-operation', operation: 'dequeue', timestamp: ts(s(t)), sessionId: SID })
    row(s(t), { type: 'user', timestamp: ts(s(t)), sessionId: SID, message: { role: 'user', content: `placeholder prompt ${n}` } })
    hooks.push({ at: s(t), event: 'UserPromptSubmit' })
    row(s(t + 5), { type: 'assistant', timestamp: ts(s(t + 5)), sessionId: SID, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'SendMessage', input: {} }] } })
    row(s(t + 6), { type: 'user', timestamp: ts(s(t + 6)), sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
    row(s(t + 7), { type: 'api-request', timestamp: ts(s(t + 7)), sessionId: SID, id: `req-${n}`, version: '2.1.317' })
    // The request's copy of the history: every tool call so far, written after their results. No timestamp.
    row(s(t + 7), { type: 'api-request-blob', hash: `h${n}`, sessionId: SID, message: { role: 'assistant', content: toolIds.map(tid => ({ type: 'tool_use', id: tid, name: 'SendMessage', input: {} })) } })
    row(s(t + 9), { type: 'assistant', timestamp: ts(s(t + 9)), sessionId: SID, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'placeholder reply' }] } })
    hooks.push({ at: s(t + 10), event: 'Stop' })
    const last = n === turns - 1
    if (!last) {
      // CLOSED gap: a cross-session prompt is queued while the Stop hooks run (20 s on this Mac).
      row(s(t + 15), { type: 'queue-operation', operation: 'enqueue', timestamp: ts(s(t + 15)), sessionId: SID })
    }
    row(s(t + 30), { type: 'attachment', timestamp: ts(s(t + 30)), sessionId: SID })
    row(s(t + 30), { type: 'system', subtype: 'stop_hook_summary', timestamp: ts(s(t + 30)), sessionId: SID })
    if (last) registryIdle.push(s(t + 30))
    t += 30 // a CLOSED gap: the queued prompt dequeues as the hooks return
  }
  return { rows, hooks, registryIdle, lastWrite: s(t), realGapStartsAt: s(t) }
}

/** One drain sweep at `now`, the way drainThread decides for a Claude session the Desktop app holds. */
function sweep(tl: ReturnType<typeof timeline>, now: number, queuedAt: number) {
  const written = tl.rows.filter(r => r.at <= now)
  const lines = written.map(r => r.line)
  const mtime = written.length ? Math.max(...written.map(r => r.at)) : null
  // The hook signal as the store holds it at `now` (Stop clears turnOpen; a prompt opens a turn).
  const seenHooks = tl.hooks.filter(h => h.at <= now)
  const lastHook = seenHooks[seenHooks.length - 1]
  const lastPrompt = [...seenHooks].reverse().find(h => h.event === 'UserPromptSubmit')
  const lastStop = [...seenHooks].reverse().find(h => h.event === 'Stop')
  const signal: TurnEvidenceSignal | undefined = lastHook && {
    turnOpen: lastHook.event === 'UserPromptSubmit',
    lastEvent: lastHook.event,
    lastEventAt: lastHook.at,
    turnStartedAt: lastPrompt?.at ?? null,
    stopAt: lastStop?.at ?? null,
    subagentsOpen: 0,
  }
  const registryIdleAfterStop = (_id: string, stopAt: number) => tl.registryIdle.some(at => at >= stopAt && at <= now)
  const evidence = makeQueueTurnEvidence({
    signalFor: () => signal,
    registryIdleAfterStop,
    deskEndedAt: () => null,
    transcriptMtimeMs: () => mtime,
    transcriptVerdict: () => turnFromTail('claude', lines),
    threadCancel: () => null,
    openTurnCeilingMs: OPEN_TURN_CEILING_MS,
    now: () => now,
  })
  // The gate for a foreign holder (thread-occupancy.ts readHolderActivity): idle by the 30 s transcript clock, or by
  // the B6 clause (the hooks' Stop, with the registry idle after it).
  let activity = holderActivity(mtime, now)
  if (activity === 'working' && signal && !signal.turnOpen && signal.lastEvent === 'Stop' && typeof signal.stopAt === 'number' && registryIdleAfterStop(SID, signal.stopAt)) activity = 'idle'
  const attachable = activity === 'idle'
  return drainDecision({ status: 'waiting', queuedAt, attempts: 0 }, {
    attachable,
    reason: attachable ? null : 'native_thread_working',
    turnEnded: evidence.turnEnded('claude', SID),
    turnOpen: evidence.turnOpen('claude', SID),
    activity,
  }, now)
}

describe('a queued note held across several turns (the 124.5-minute field hold)', () => {
  const TURNS = 4
  const tl = timeline(TURNS)
  const queuedAt = s(2) // parked during the first turn

  it('holds while the session works and through every gap a cross-session prompt closes (correct on every version)', () => {
    for (let n = 0; n < TURNS; n++) {
      const start = n * 30
      expect(sweep(tl, s(start + 8), queuedAt), `mid-turn ${n}`).toBe('hold')
      if (n < TURNS - 1) {
        // During the Stop hooks, after the cross-session prompt was queued: the tail reads prompt_queued.
        expect(turnFromTail('claude', tl.rows.filter(r => r.at <= s(start + 20)).map(r => r.line)).reason).toBe('prompt_queued')
        expect(sweep(tl, s(start + 20), queuedAt), `closed gap after turn ${n}`).toBe('hold')
      }
    }
  })

  it('goes at the first REAL gap: one sweep after the hooks return, not 30 minutes after the last write', () => {
    const gap = tl.realGapStartsAt
    // The hooks have returned and the registry is idle; the transcript was last written at that moment.
    expect(tl.lastWrite).toBe(gap)
    // Before fix A this sweep, and every sweep until 30 minutes of quiet, held: the blob's copied tool calls read
    // tool_pending, and every turn that wrote in between renewed the ceiling (the field's 124.5 minutes).
    expect(sweep(tl, gap + 20_000, queuedAt)).toBe('deliver')
    expect(sweep(tl, gap + 25 * 60_000, queuedAt)).toBe('deliver')
    expect(turnFromTail('claude', tl.rows.map(r => r.line)).reason).toBe('terminal_stop')
  })
})
