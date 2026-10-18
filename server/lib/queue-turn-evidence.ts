// The thread-turn queue's two turn questions, `turnEnded` and `turnOpen` (6.53.3).
//
// Moved out of the composition root (index.ts) unchanged in shape, so the one rule that
// changed in 6.53.3 can be driven by a test against the real `drainDecision`: WHAT a
// cancel on the thread may conclude about a turn that still reads open depends on what the
// cancel was aimed at (review A1, `cancelVoidsOpenTurn` in session-cancel.ts).
//
//   cos_turn   COS killed its own child: nothing written since the cancel ends the turn.
//   desk_run   the run stops at its NEXT tool call, so the hooks' and the transcript's
//              open-turn evidence stands until the desk's own engine says the run is over
//              at or after the cancel (a Stop, StopFailure or SessionEnd, or the registry's
//              idle flip). Until 6.53.2 a desk run inside a long tool read "over" 30 s after
//              the cancel, and a parked follow-up was delivered live into it.
//
// Every read is injected; index.ts wires the real ones. Both answers refuse on doubt: a
// throw is `false` for each, which is what the composition root did before the move.

import { cancelVoidsOpenTurn, type ThreadCancel } from './session-cancel.js'
import { unwrapPeerMessage } from './session-stream-events.js'
import type { TurnAttemptLookup } from './agent-session-binding-registry.js'
import type { QueuedThreadTurn } from './thread-turn-queue.js'

/** The hook signal fields these questions read (a `SessionSignal` satisfies it). */
export interface TurnEvidenceSignal {
  turnOpen: boolean
  lastEvent: string
  lastEventAt: number
  turnStartedAt: number | null
  stopAt: number | null
  subagentsOpen: number
}

/** The transcript tail's own verdict (`transcriptTurnVerdict`). */
export interface TurnEvidenceVerdict {
  ended: boolean
  reason?: string | null
}

export interface QueueTurnEvidenceDeps {
  /** The hooks' signal for a Claude session; undefined when the hooks are off or silent. */
  signalFor: (threadId: string) => TurnEvidenceSignal | undefined
  /** `registryIdleAfterStop`: true only when the live record flipped idle at or after `stopAt`. */
  registryIdleAfterStop: (threadId: string, stopAt: number) => boolean | null
  /** `deskTurnEndedAt`: when the desk session's engine said its run is over, as it stands now. */
  deskEndedAt: (threadId: string) => number | null
  /** The transcript's mtime, or null when unmeasurable. */
  transcriptMtimeMs: (provider: string, threadId: string) => number | null
  /** The transcript tail's verdict, or null when unreadable. */
  transcriptVerdict: (provider: string, threadId: string) => TurnEvidenceVerdict | null
  /** The cancel on record for the thread (`threadCancel`). */
  threadCancel: (provider: string, threadId: string) => ThreadCancel | null
  /** Past this age a signal or a tail is not evidence any more (OPEN_TURN_CEILING_MS). */
  openTurnCeilingMs: number
  now: () => number
}

export interface QueueTurnEvidence {
  turnEnded: (provider: string, threadId: string) => boolean
  turnOpen: (provider: string, threadId: string) => boolean
}

export function makeQueueTurnEvidence(deps: QueueTurnEvidenceDeps): QueueTurnEvidence {
  const mtime = (provider: string, threadId: string): number | null => {
    const value = deps.transcriptMtimeMs(provider, threadId)
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  /** Read once per question, and only when a cancel is on record (it scans the registry). */
  const deskEnded = (provider: string, threadId: string): (() => number | null) => {
    let cached: number | null | undefined
    return () => {
      if (cached === undefined) cached = provider === 'claude' ? deps.deskEndedAt(threadId) : null
      return cached
    }
  }

  const turnEnded = (provider: string, threadId: string): boolean => {
    if (provider !== 'claude' && provider !== 'codex') return false
    try {
      const signal = provider === 'claude' ? deps.signalFor(threadId) : undefined
      // 6.53.0: a cancel ends the turn when nothing was written since it (a killed COS
      // child leaves its last tool_use unanswered, and no Stop or terminal record follows).
      // 6.53.3: only a cos_turn cancel concludes that; a desk_run cancel needs the desk's
      // own end, stamped at or after the cancel.
      const cancel = deps.threadCancel(provider, threadId)
      if (cancel !== null && cancelVoidsOpenTurn({
        cancel,
        lastActivityAt: mtime(provider, threadId),
        turnStartedAt: signal?.turnStartedAt ?? null,
        deskEndedAt: deskEnded(provider, threadId)(),
      })) return true
      // 6.48.1: the engine's own end of turn: a Stop hook newer than the turn's prompt
      // AND the registry flipped idle after it (the Stop hooks have returned; a prompt
      // typed during them is queued and dequeues only then). The transcript tail
      // answers for everything the hooks did not see. Both refuse on doubt.
      if (provider === 'claude') {
        if (signal && !signal.turnOpen && signal.lastEvent === 'Stop' && typeof signal.stopAt === 'number'
          && signal.stopAt >= (signal.turnStartedAt ?? 0) && signal.subagentsOpen === 0
          && deps.registryIdleAfterStop(threadId, signal.stopAt) === true) return true
      }
      return deps.transcriptVerdict(provider, threadId)?.ended === true
    } catch {
      return false
    }
  }

  // 6.48.1: positive evidence the holder's turn is OPEN, which outranks the 30 s idle
  // backstop (a long tool leaves the transcript untouched while it runs). Bounded: a
  // signal or a tail older than the ceiling is not evidence any more, so a crashed
  // mid-tool session still drains by the backstop rather than holding for the TTL.
  const turnOpen = (provider: string, threadId: string): boolean => {
    if (provider !== 'claude' && provider !== 'codex') return false
    try {
      const now = deps.now()
      const cancel = deps.threadCancel(provider, threadId)
      const ended = deskEnded(provider, threadId)
      if (provider === 'claude') {
        const signal = deps.signalFor(threadId)
        if (signal && signal.turnOpen && now - signal.lastEventAt <= deps.openTurnCeilingMs
          && !(cancel !== null && cancelVoidsOpenTurn({
            cancel,
            lastActivityAt: signal.lastEventAt,
            turnStartedAt: signal.turnStartedAt,
            deskEndedAt: ended(),
          }))) return true
      }
      const verdict = deps.transcriptVerdict(provider, threadId)
      if (!verdict || verdict.ended) return false
      if (verdict.reason !== 'tool_pending' && verdict.reason !== 'prompt_open') return false
      const last = mtime(provider, threadId)
      // 6.53.0 / 6.53.3: a cos_turn cancel with nothing written since discounts a dangling
      // tool_use (the killed child's); a desk_run cancel only once the desk said it ended.
      if (cancel !== null && cancelVoidsOpenTurn({ cancel, lastActivityAt: last, turnStartedAt: null, deskEndedAt: ended() })) return false
      return last !== null && now - last <= deps.openTurnCeilingMs
    } catch {
      return false
    }
  }

  return { turnEnded, turnOpen }
}

// =====================================================================================
// 6.78.0 (P3): WHAT HAPPENED TO A TURN A RESTART CUT OFF, AND WHETHER A KEY WAS ALREADY SENT
// =====================================================================================
//
// Delivering a prompt is NOT replay-safe: a second copy lands in a real conversation. So
// every answer below comes from POSITIVE evidence, and absence of evidence is "unknown",
// never "not sent", with exactly one exception that is itself a positive fact: a row the
// 6.78 drain stamped (`journal: 1`) whose attempt journal holds no attempt at all. The
// journal is written in the same commit as the pin, and nothing is sent before the pin, so
// that absence proves the turn never reached a delivery hop.


/** What a `delivering` row from a dead boot is settled as. */
export type DeliveryEvidence = 'delivered' | 'not_delivered' | 'unknown'

/** A transcript row this far before the attempt still counts (one Mac, one clock; a writer may stamp before it appends). */
export const EVIDENCE_BACKDATE_MS = 2_000

/** The facts the reconcile decides on, each read by the caller. */
export interface ReconcileFacts {
  row: Pick<QueuedThreadTurn, 'queuedAt' | 'journal' | 'mode'>
  /** `outcome` of the terminal ledger record for this key on the target, or null when there is none. */
  ledgerOutcome: string | null
  /** An exact, wrapper-aware transcript match after the attempt began. */
  transcriptMatch: boolean
  /** A Codex native queue row with the same text. */
  codexQueueMatch: boolean
  /** The attempt journal's answer, or null when the journal could not be read. */
  attempt: TurnAttemptLookup | null
}

/**
 * THE RECONCILE ORDER (plan v3.1 P3, V3 W4). Pure, every branch resolves:
 *   1. a `completed` or `queued` ledger record, or an attempt that exited `sent`: delivered
 *   2. an exact transcript match after the attempt began: delivered (it may upgrade an ambiguous record)
 *   3. a Codex queue row with the same text: delivered
 *   4. an ambiguous ledger record, an unstamped (legacy) row, a steer row, or an unreadable
 *      journal, with none of the above: unknown
 *   5. not_delivered ONLY when the attempt says `not_sent`, or a stamped turn row has no
 *      attempt at all and the journal cannot have shed one; anything else is unknown
 */
export function reconcileVerdict(facts: ReconcileFacts): DeliveryEvidence {
  if (facts.ledgerOutcome === 'completed' || facts.ledgerOutcome === 'queued') return 'delivered'
  if (facts.attempt?.attempt?.exit === 'sent') return 'delivered'
  if (facts.transcriptMatch) return 'delivered'
  if (facts.codexQueueMatch) return 'delivered'
  if (facts.ledgerOutcome === 'ambiguous') return 'unknown'
  if (facts.row.journal !== 1) return 'unknown'
  if (facts.row.mode === 'steer') return 'unknown'
  if (facts.attempt === null) return 'unknown'
  const attempt = facts.attempt.attempt
  if (attempt !== null) return attempt.exit === 'not_sent' ? 'not_delivered' : 'unknown'
  const shed = facts.attempt.evictedThrough
  if (shed !== null && shed >= facts.row.queuedAt) return 'unknown'
  return 'not_delivered'
}

function rowTime(row: Record<string, unknown>): number | null {
  if (typeof row.timestamp !== 'string') return null
  const ms = Date.parse(row.timestamp)
  return Number.isFinite(ms) ? ms : null
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'tool_result') return null
    if (typeof b.text === 'string' && (b.type === 'text' || b.type === 'input_text' || b.type === undefined)) parts.push(b.text)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/** The words, as typed or out of Claude Code's peer wrapper, equal the prompt exactly. */
function sameWords(text: string | null, want: string): boolean {
  if (text === null) return false
  if (text.trim() === want) return true
  return unwrapPeerMessage(text) === want
}

/**
 * Does this transcript tail show the session took exactly these words, at or after
 * `sinceMs`? WRAPPER-AWARE AND EXACT: the whole prompt, trimmed, either as typed or inside
 * Claude Code's peer-message wrapper. A prefix, a substring or a row without a timestamp is
 * never evidence, because a false "delivered" loses a turn the person is waiting on.
 *
 *   claude  a user row (including the `isMeta` peer row), an `enqueue` queue-operation,
 *           a `queued_command` attachment
 *   codex   an `event_msg` user_message, or a user `response_item` message
 */
export function transcriptShowsPrompt(provider: string, lines: readonly string[] | null, prompt: string, sinceMs: number): boolean {
  const want = typeof prompt === 'string' ? prompt.trim() : ''
  if (!want || !lines || !Number.isFinite(sinceMs)) return false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = typeof lines[i] === 'string' ? lines[i].trim() : ''
    if (!line.startsWith('{')) continue
    let row: Record<string, unknown>
    try { row = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (!row || typeof row !== 'object') continue
    const at = rowTime(row)
    if (at === null || at < sinceMs) continue
    if (provider === 'claude') {
      if (row.type === 'user') {
        const message = row.message as Record<string, unknown> | undefined
        if (message && typeof message === 'object' && sameWords(textOf(message.content), want)) return true
      } else if (row.type === 'queue-operation' && row.operation === 'enqueue') {
        if (sameWords(textOf(row.content), want)) return true
      } else if (row.type === 'attachment') {
        const attachment = row.attachment as Record<string, unknown> | undefined
        if (attachment && attachment.type === 'queued_command' && sameWords(textOf(attachment.prompt ?? attachment.content), want)) return true
      }
    } else if (provider === 'codex') {
      const payload = row.payload as Record<string, unknown> | undefined
      if (!payload || typeof payload !== 'object') continue
      if (row.type === 'event_msg' && payload.type === 'user_message' && sameWords(typeof payload.message === 'string' ? payload.message : null, want)) return true
      if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && sameWords(textOf(payload.content), want)) return true
    }
  }
  return false
}

/** Where `makeDeliveryEvidence` reads each fact. Every read may throw; a throw is unknown. */
export interface DeliveryEvidenceDeps {
  /** The terminal ledger record's `outcome` for this key on the target, or null. */
  ledgerOutcome: (provider: string, threadId: string, clientTurnId: string) => string | null
  attempt: (provider: string, threadId: string, clientTurnId: string) => TurnAttemptLookup | null
  /** The thread's transcript tail as lines, or null when unreadable. */
  transcriptLines: (provider: string, threadId: string) => readonly string[] | null
  /** The plain text of every row in the Codex app's own queue for this thread. */
  codexQueueTexts?: (threadId: string) => Promise<readonly string[]> | readonly string[]
}

/** `ThreadTurnQueueDeps.deliveryEvidence`, built from the real reads. Never throws. */
export function makeDeliveryEvidence(deps: DeliveryEvidenceDeps): (turn: QueuedThreadTurn) => Promise<DeliveryEvidence> {
  return async turn => {
    try {
      const ledgerOutcome = deps.ledgerOutcome(turn.provider, turn.threadId, turn.clientTurnId)
      const attempt = deps.attempt(turn.provider, turn.threadId, turn.clientTurnId)
      const since = (attempt?.attempt?.at ?? turn.queuedAt) - EVIDENCE_BACKDATE_MS
      const transcriptMatch = (turn.provider === 'claude' || turn.provider === 'codex')
        && transcriptShowsPrompt(turn.provider, deps.transcriptLines(turn.provider, turn.threadId), turn.prompt, since)
      let codexQueueMatch = false
      if (!transcriptMatch && turn.provider === 'codex' && typeof deps.codexQueueTexts === 'function') {
        const texts = await deps.codexQueueTexts(turn.threadId)
        codexQueueMatch = texts.some(text => typeof text === 'string' && text.trim() === turn.prompt.trim())
      }
      return reconcileVerdict({ row: turn, ledgerOutcome, transcriptMatch, codexQueueMatch, attempt })
    } catch {
      return 'unknown'
    }
  }
}

/** A key the turns route must replay instead of sending. */
export interface TurnReceipt {
  kind: 'delivered' | 'unknown'
  source: 'queue' | 'attempt' | 'transcript'
}

/**
 * Which queue rows are receipts. ONLY a row whose outcome is settled: delivered, or refused
 * with an unknown outcome. Never `waiting` or `delivering`: the drainer posts the turns route
 * with the row's OWN key while the row is `delivering`, so counting that row would make the
 * queue refuse its own delivery (V2 B2, V3 B3).
 */
export function isReceiptRow(row: Pick<QueuedThreadTurn, 'status' | 'deliveryState'>): boolean {
  return row.status === 'delivered' || (row.status === 'refused' && row.deliveryState === 'unknown')
}

export interface TurnReceiptDeps {
  queueRows: (provider: string, threadId: string) => readonly QueuedThreadTurn[]
  attempt: (provider: string, threadId: string, clientTurnId: string) => TurnAttemptLookup | null
  transcriptLines?: (provider: string, threadId: string) => readonly string[] | null
  /** This process's boot: a `pending` attempt of THIS boot is a turn in flight, not an orphan. */
  bootId: string
}

/**
 * The turns POST's receipt check (6.78.0), after the ledger replay and before the claim.
 *
 *   queue row delivered                    delivered
 *   queue row refused, delivery unknown    unknown
 *   attempt sent                           delivered
 *   attempt unknown, or pending from a     unknown, unless the transcript now shows the
 *   dead boot                              exact words after it began (then delivered)
 *   anything else (no row, not_sent,       null: not a receipt; the route's own gates
 *   pending in this boot)                  decide (a turn in flight meets the claim)
 */
export function makeTurnReceiptLookup(deps: TurnReceiptDeps): (provider: string, threadId: string, clientTurnId: string, prompt: string) => TurnReceipt | null {
  return (provider, threadId, clientTurnId, prompt) => {
    const row = deps.queueRows(provider, threadId).find(t => t.clientTurnId === clientTurnId)
    if (row && isReceiptRow(row)) return { kind: row.status === 'delivered' ? 'delivered' : 'unknown', source: 'queue' }
    const lookup = deps.attempt(provider, threadId, clientTurnId)
    const attempt = lookup?.attempt ?? null
    if (attempt === null) return null
    if (attempt.exit === 'sent') return { kind: 'delivered', source: 'attempt' }
    const unknown = attempt.exit === 'unknown' || (attempt.exit === 'pending' && attempt.bootId !== deps.bootId)
    if (!unknown) return null
    if (typeof deps.transcriptLines === 'function') {
      let lines: readonly string[] | null = null
      try { lines = deps.transcriptLines(provider, threadId) } catch { lines = null }
      if (transcriptShowsPrompt(provider, lines, prompt, attempt.at - EVIDENCE_BACKDATE_MS)) return { kind: 'delivered', source: 'transcript' }
    }
    return { kind: 'unknown', source: 'attempt' }
  }
}
