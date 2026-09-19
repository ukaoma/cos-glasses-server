// A queued turn for a Cursor chat, handed to Cursor by its own Stop hook (6.51.0).
//
// ---------------------------------------------------------------------------
// WHY THE STOP HOOK, AND ONLY THE STOP HOOK
// ---------------------------------------------------------------------------
// Cursor has no `queue --thread` and no socket a process outside it can write into. A
// Cursor IDE composer cannot be resumed from outside either: Gate 0 (2026-08-20) found
// `--resume` on an IDE transcript to be a clobber / wrong-store landmine, and that stays
// refused. But Cursor 3.21 runs a `stop` hook when a composer's turn ends, and when the
// hook answers `{"followup_message": "..."}` Cursor submits that text into THE SAME
// composer as the next message (`submitChatMaybeAbortCurrent(composerId, text,
// {isAutoFollowupFromStopHook: true})`, read from the shipped workbench). That is the
// exact shape of "deliver when the current turn ends", from inside the composer.
//
// And the hook is already there: Cursor reads `~/.claude/settings.json` hooks by default
// (its third-party extensibility setting), so the COS session hook installed on 9/15 has
// been running for Cursor composers since then -- 478 Cursor events in the ledger by
// 9/18, stdin = Cursor's own payload (`conversation_id`, `status`, `loop_count`,
// `cursor_version`), environment `CURSOR_VERSION`. Nothing new is installed for Cursor;
// the one script gains one Cursor-only branch.
//
// ---------------------------------------------------------------------------
// WHAT THIS CANNOT DO, SAID PLAINLY
// ---------------------------------------------------------------------------
// It delivers only at the END OF A TURN. An idle composer fires no Stop, so a turn cannot
// be put into it from outside; the queue admits a Cursor turn only while the hooks show
// that composer mid-turn (`native_thread_working`), and a turn that is never claimed
// expires on the queue's ordinary clock and says so. Cursor also caps consecutive hook
// follow-ups (its default loop limit, reset by any message typed in Cursor), so a long
// queue can stop short; the rest waits for the next typed message and its Stop.
//
// ---------------------------------------------------------------------------
// ONE DELIVERER
// ---------------------------------------------------------------------------
// The queue drainer never delivers a Cursor turn (see `drainThread`): a turn could
// otherwise be claimed here and delivered there in the same second. Claiming marks the
// row `delivered` before the text leaves, and a Stop that is not `completed` (aborted,
// error) claims nothing -- a queued sentence must not follow a turn the user just
// stopped.

import { isValidNativeThreadId } from './native-thread-id.js'
import type { QueuedThreadTurn } from './thread-turn-queue.js'

export interface CursorStopFacts {
  conversationId: string
  status: string
  loopCount: number | null
  cursorVersion: string
}

/**
 * The spool envelope the hook posts (`{"ts","ppid","event","payload"}`), read strictly.
 * Null unless it is a Stop from Cursor naming a valid conversation.
 */
export function parseCursorStopEnvelope(body: unknown): CursorStopFacts | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const envelope = body as Record<string, unknown>
  if (envelope.event !== 'Stop') return null
  const payload = envelope.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  // Cursor stamps every hook payload with its version. Claude Code never does, so this
  // is the positive evidence the event came from Cursor and not a Claude Stop.
  if (typeof p.cursor_version !== 'string' || p.cursor_version.trim().length === 0) return null
  const raw = typeof p.conversation_id === 'string' ? p.conversation_id : typeof p.session_id === 'string' ? p.session_id : ''
  const conversationId = raw.trim().toLowerCase()
  if (!isValidNativeThreadId(conversationId)) return null
  const status = typeof p.status === 'string' ? p.status : ''
  const loopCount = typeof p.loop_count === 'number' && Number.isFinite(p.loop_count) ? p.loop_count : null
  return { conversationId, status, loopCount, cursorVersion: p.cursor_version.trim() }
}

/**
 * The next waiting turn, claimed. Pure: returns the new queue and the claimed turn, or
 * null when there is nothing to hand over. Queue order, oldest first.
 */
export function claimNextCursorTurn(
  queue: readonly QueuedThreadTurn[],
  now: number,
): { queue: QueuedThreadTurn[]; turn: QueuedThreadTurn } | null {
  const index = queue.findIndex(t => t.status === 'waiting')
  if (index < 0) return null
  const turn: QueuedThreadTurn = {
    ...queue[index]!,
    status: 'delivered',
    attempts: queue[index]!.attempts + 1,
    reason: 'cursor_stop_hook',
    settledAt: now,
  }
  const next = queue.slice()
  next[index] = turn
  return { queue: next, turn }
}

/**
 * Should this Stop receive a queued turn at all? Only a turn that COMPLETED: Cursor
 * reports `aborted` when the user stops it and `error` when it failed, and neither is a
 * moment to add a sentence. A loop count past the queue's own size means something other
 * than this queue is driving the composer.
 */
export function cursorStopAcceptsFollowup(facts: CursorStopFacts, maxLoop: number): boolean {
  if (facts.status !== 'completed') return false
  if (facts.loopCount !== null && facts.loopCount >= maxLoop) return false
  return true
}
