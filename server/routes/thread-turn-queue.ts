// Routes and drainer for turns spoken at a busy thread.
//
// WHY THE DRAINER CALLS THE SERVER'S OWN ROUTES OVER LOOPBACK, which looks odd until
// you look at what it would otherwise have to copy. Delivery is not "post a prompt": it
// is the occupancy gate, the target fence, the per-target claim, the divergence
// watermark, the idempotency ledger, and the child-pid accounting -- roughly 370 lines
// of ordering in agent-session-bindings.ts, where every branch exists because something
// once went wrong. A second copy of that in a background worker is a second place for
// the gate to drift, and the drift would be invisible until it mattered.
//
// So the drainer re-enters through the front door. The gate runs exactly once, in its
// existing home, and this file cannot weaken it even by accident -- the strongest form
// of "does not weaken the attach gate" available. It costs one loopback request per
// delivered turn, at a volume of a handful per day.
//
// EVERY DEPENDENCY IS INJECTED so the whole path is testable without a live server.

import { Router, type Request, type Response } from 'express'
import { CONTINUE_NOTE_HEADER, continueNoteAcknowledged } from '../lib/continue-plan.js'
import { nativeQueueControl, plainQueueText, type NativeQueueControl } from '../lib/codex-queue-control.js'
import { CLIENT_TURN_ID_RE, COS_SESSION_ID_RE, DEFAULT_MAX_PROMPT_CHARS } from './agent-session-bindings.js'
import {
  admitToQueue, drainDecision, queueableRefusal, queuePosition,
  MAX_DELIVERY_ATTEMPTS, type DrainObservation, type QueuedThreadTurn,
  queueReconcileEnabled, queueResendEnabled, queuedTurnReasonCopy, sessionSteerAvailability, sessionSteerEnabled,
  type SessionSteerAvailability,
} from '../lib/thread-turn-queue.js'
import { readQueue, writeQueue, queuedThreadKeys } from '../lib/thread-turn-queue-store.js'
import type { DeliveryEvidence } from '../lib/queue-turn-evidence.js'
import { continueLiveEnabled } from '../lib/session-peer-inbox-deps.js'
import { PEER_VERIFY_TIMEOUT_MS } from '../lib/session-peer-inbox.js'

export interface ThreadTurnQueueDeps {
  /** Re-runs the FULL occupancy gate. The drainer never decides attachability itself. */
  occupancy: (provider: string, threadId: string) => { attachable: boolean; reason: string | null }
  /** Did the holder's last transcript record end a turn? */
  turnEnded: (provider: string, threadId: string) => boolean
  /** 6.48.1, optional: is the holder's turn positively OPEN right now (see DrainObservation.turnOpen)? */
  turnOpen?: (provider: string, threadId: string) => boolean
  /** The 30s transcript clock, as a backstop. */
  activity: (provider: string, threadId: string) => 'working' | 'idle' | 'unknown'
  /** 6.53.0, optional: until when a cancel holds this thread's parked turns (`cancelHoldUntil`). */
  cancelHoldUntil?: (provider: string, threadId: string) => number | null
  /**
   * Deliver one turn. Production wires this to a loopback attach + turn.
   *
   * Resolves `{ ok: true }` only when the turn was provably admitted. Anything
   * ambiguous must resolve `ok: false` with a reason: an unknown delivery that is
   * retried puts the same sentence into a real conversation twice.
   */
  deliver: (turn: QueuedThreadTurn) => Promise<{
    ok: boolean
    reason?: string
    /** The turn route's OWN `retryable` judgement, when it sent one. Authoritative. */
    serverRetryable?: boolean
    /** 6.78.0: the turn route REPLAYED this key (`replayed: true`) rather than deciding afresh. */
    replayed?: boolean
    /** 6.78.0: the turn route's `deliveryState`; `unknown` on a replay is settled, never retried. */
    deliveryState?: string
  }>
  nativeQueue?: NativeQueueControl
  /**
   * 6.62.0 (W14), optional: is this Cursor id an Agent CLI chat (a `~/.cursor/chats` dir)?
   * Only those are drained from here, and only when the gate, which now includes the
   * chat's 30 s busy window, says free. An IDE composer still leaves only through its own
   * Stop hook. Absent: no Cursor turn is ever drained here, exactly as in 6.61.
   */
  cursorCliChat?: (threadId: string) => boolean
  now: () => number

  // ------------------------------------------------------------- 6.78.0 (P3)
  // Every member is optional. Absent, the queue behaves exactly as 6.77.0 for that member's
  // part: no stamp boot id, no restart reconcile, no steer, no attempt journal.

  /** This server's boot (`serverMetrics.bootId`). A `delivering` row stamped with another boot was cut off. */
  bootId?: string
  /**
   * What happened to a `delivering` row a dead boot left (MVP-B, read by `drainThread`).
   * Production: `makeDeliveryEvidence` over the registry, the transcript and the Codex queue.
   * May be async. A throw is `unknown`.
   */
  deliveryEvidence?: (turn: QueuedThreadTurn) => DeliveryEvidence | Promise<DeliveryEvidence>
  /** Session steer's transport: `makeLiveTurnDeliverer`, the same one the turns route's live hop uses. */
  deliverLiveTurn?: (request: { provider: string; sessionId: string; prompt: string; verifyTimeoutMs?: number; clientTurnId?: string }) => Promise<{ ok: boolean; reason: string }>
  /** Can this Claude session take a steer: is a peer inbox open, and is it held on a prompt? */
  steerProbe?: (provider: string, threadId: string) => { peerInbox: boolean; waitingOnPrompt: boolean }
  /** `COS_CONTINUE_LIVE`. Defaults to `continueLiveEnabled()`, read per request. */
  continueLive?: () => boolean
  /** The attempt journal (the binding registry). The steer path writes `pending` here BEFORE any frame. */
  attempts?: {
    begin: (provider: string, threadId: string, clientTurnId: string, mode: 'turn' | 'steer', now: number) => boolean
    settle: (provider: string, threadId: string, clientTurnId: string, exit: 'sent' | 'not_sent' | 'unknown', now: number) => boolean
  }
}

/**
 * Steer availability for one thread, from the shared rule. A throwing probe is "no channel":
 * the turn is queued, which is always safe.
 */
export function steerAvailabilityFor(deps: Pick<ThreadTurnQueueDeps, 'steerProbe' | 'deliverLiveTurn' | 'continueLive'>, provider: string, threadId: string, gateReason: string | null): SessionSteerAvailability {
  let probe: { peerInbox: boolean; waitingOnPrompt: boolean } = { peerInbox: false, waitingOnPrompt: false }
  if (provider === 'claude' && typeof deps.steerProbe === 'function' && typeof deps.deliverLiveTurn === 'function') {
    try {
      const read = deps.steerProbe(provider, threadId)
      probe = { peerInbox: read?.peerInbox === true, waitingOnPrompt: read?.waitingOnPrompt === true }
    } catch {
      probe = { peerInbox: false, waitingOnPrompt: false }
    }
  }
  let continueLive = false
  try { continueLive = (deps.continueLive ?? (() => continueLiveEnabled()))() === true } catch { continueLive = false }
  return sessionSteerAvailability({ provider, gateReason, continueLive, peerInbox: probe.peerInbox, waitingOnPrompt: probe.waitingOnPrompt })
}

/** Public shape of a queued turn. No prompt echo beyond a short preview. */
export function publicRow(turn: QueuedThreadTurn, position: number): Record<string, unknown> {
  const row: Record<string, unknown> = {
    clientTurnId: turn.clientTurnId,
    status: turn.status,
    queuedAt: turn.queuedAt,
    attempts: turn.attempts,
    position: turn.status === 'waiting' ? position : -1,
    prompt: turn.prompt,
    editable: turn.status === 'waiting',
    owner: 'cos',
    preview: turn.prompt.length > 80 ? `${turn.prompt.slice(0, 79)}…` : turn.prompt,
    ...(turn.reason ? { reason: turn.reason } : {}),
    ...(turn.settledAt ? { settledAt: turn.settledAt } : {}),
  }
  // 6.78.0: additive, and only while a P3 flag is on, so the row is the 6.77 bytes otherwise.
  // `resendable` is the per-row capability: present only when Send again can act on it.
  const reconcile = queueReconcileEnabled()
  const resend = queueResendEnabled()
  if (!reconcile && !resend && !sessionSteerEnabled()) return row
  const reasonCopy = reconcile ? queuedTurnReasonCopy(turn.reason) : null
  return {
    ...row,
    ...(reasonCopy ? { reasonCopy } : {}),
    deliveryState: turn.deliveryState ?? null,
    mode: turn.mode ?? 'queue',
    resendOf: turn.resendOf ?? null,
    resentAs: turn.resentAs ?? null,
    ...(resend && (turn.status === 'refused' || turn.status === 'expired') ? { resendable: true } : {}),
  }
}

/**
 * Is this failed delivery a "not yet" rather than a "no"?
 *
 * CLASSIFIED BY REASON, NEVER BY STATUS. Every attach refusal that is not
 * `invalid_request` (400) or a capability gap (503) comes back 409 -- transient
 * `native_target_busy` and permanent `native_target_fenced` alike -- so a status-based
 * rule would retry a turn whose copy reads "an earlier turn on this thread may or may
 * not have been delivered" up to 1,080 times inside the TTL. That is the one refusal
 * that needs a human.
 *
 * `queueableRefusal` is reused rather than a second list being written: it already
 * encodes "can this condition ever pass", it is tested, and a turn should be retried
 * for exactly the reasons it was allowed to queue for.
 *
 * FAILS CLOSED. An unrecognised reason, an absent reason, or a thrown deliver all
 * return false and spend an attempt. A new refusal added upstream is therefore bounded
 * by default rather than silently retried forever.
 */
/** A throwing turnOpen probe is not evidence either way. */
function safeTurnOpen(deps: ThreadTurnQueueDeps, provider: string, threadId: string): boolean | undefined {
  try { return deps.turnOpen!(provider, threadId) } catch { return undefined }
}

/** A throwing or absent CLI-chat probe means "not a CLI chat": the 6.61 Cursor hold. */
function safeCursorCliChat(deps: ThreadTurnQueueDeps, threadId: string): boolean {
  try { return deps.cursorCliChat ? deps.cursorCliChat(threadId) === true : false } catch { return false }
}

/** A throwing cancel read is no hold: the gate still decides every delivery. */
function safeCancelHold(deps: ThreadTurnQueueDeps, provider: string, threadId: string): number | null {
  try { return deps.cancelHoldUntil ? deps.cancelHoldUntil(provider, threadId) : null } catch { return null }
}

function isRetryableDelivery(outcome: { reason?: string; serverRetryable?: boolean }): boolean {
  // The turn route publishes its own verdict; it outranks our inference either way.
  if (outcome.serverRetryable === false) return false
  if (outcome.serverRetryable === true) return true
  return queueableRefusal(outcome.reason)
}

/**
 * One drain pass over one thread.
 *
 * Exported for the test and for the sweep. Sequential by design: two turns to the same
 * thread must not race, and the second one's readiness is decided AFTER the first has
 * landed, because the first makes the thread busy again.
 */
export async function drainThread(
  provider: string,
  threadId: string,
  deps: ThreadTurnQueueDeps,
): Promise<{ delivered: number; held: number; retired: number }> {
  // 6.78.0: settle what a dead boot left `delivering` BEFORE anything is drained, so a turn
  // proved unsent is sent in this same pass and an unknown one is never sent at all.
  const reconcile = queueReconcileEnabled()
  if (reconcile && typeof deps.deliveryEvidence === 'function') await reconcileDeliveringTurns(provider, threadId, deps)
  const now = deps.now()
  const queue = readQueue(provider, threadId, now)
  if (queue.length === 0) return { delivered: 0, held: 0, retired: 0 }

  let delivered = 0, held = 0, retired = 0
  const persist = (turn: QueuedThreadTurn, durable = false) => {
    const latest = readQueue(provider, threadId, deps.now())
    const index = latest.findIndex(t => t.clientTurnId === turn.clientTurnId)
    if (index >= 0) { latest[index] = turn; writeQueue(provider, threadId, latest, durable ? { durable: true } : {}) }
  }
  let refusedGate: ReturnType<ThreadTurnQueueDeps['occupancy']> | null = null

  for (const snapshot of queue) {
    const turn = readQueue(provider, threadId, deps.now()).find(t => t.clientTurnId === snapshot.clientTurnId)
    if (!turn) continue
    if (turn.status !== 'waiting') continue

    // Reuse only refusal within this synchronous pass. Rechecking a busy thread
    // for every queued row repeats a whole-process descriptor scan. A refusal
    // can delay delivery until the next sweep, but can never authorize a write.
    // Positive verdicts and all checks after a delivery remain fresh.
    //
    // 6.51.0: a Cursor turn is NEVER delivered from here. It leaves through the
    // composer's own Stop hook (`routes/cursor-stop-followup.ts`), which claims it the
    // moment the turn ends; a second deliverer could hand the same sentence over twice.
    // The pass still runs for it so the TTL retires an unclaimed turn honestly.
    //
    // 6.62.0 (W14): an Agent CLI chat is the exception. A `-p` run fires no Stop hook, so
    // nothing else would ever send its parked turn; it drains here once the gate (with the
    // chat's 30 s busy window) reads free, and that quiet window is its turn-ended signal.
    const cliChat = provider === 'cursor' && safeCursorCliChat(deps, threadId)
    const gate: ReturnType<ThreadTurnQueueDeps['occupancy']> = provider === 'cursor' && !cliChat
      ? { attachable: false, reason: 'cursor_stop_hook_delivery' }
      : refusedGate ?? deps.occupancy(provider, threadId)
    if (!gate.attachable) refusedGate = gate
    const seen: DrainObservation = cliChat
      ? {
          attachable: gate.attachable,
          turnEnded: gate.attachable,
          activity: gate.attachable ? 'idle' : 'working',
          reason: gate.reason,
          cancelHoldUntil: safeCancelHold(deps, provider, threadId),
        }
      : {
          attachable: gate.attachable,
          turnEnded: deps.turnEnded(provider, threadId),
          turnOpen: deps.turnOpen ? safeTurnOpen(deps, provider, threadId) : undefined,
          activity: deps.activity(provider, threadId),
          reason: gate.reason,
          cancelHoldUntil: safeCancelHold(deps, provider, threadId),
        }
    const decision = drainDecision(turn, seen, deps.now())

    if (decision === 'hold') { held += 1; continue }
    if (decision === 'expire' || decision === 'give_up') {
      turn.status = decision === 'expire' ? 'expired' : 'refused'
      turn.reason = decision === 'expire' ? 'queued_turn_expired' : 'delivery_attempts_exhausted'
      turn.settledAt = deps.now()
      retired += 1; persist(turn)
      continue
    }

    // ATTEMPT IS RECORDED BEFORE THE CALL, and persisted. A delivery that crashes the
    // process mid-flight must not come back with its attempt count unchanged and try
    // forever; the ceiling only bounds anything if it survives the crash it is bounding.
    turn.attempts += 1
    turn.status = 'delivering'
    // 6.78.0: the stamp the restart reconcile reads. `journal: 1` says this build keeps an
    // attempt record for the delivery that follows; `deliveringBootId` says which boot owns
    // it, so a sweep never touches a row this process is delivering right now. Durable:
    // this is the intent a crash leaves behind.
    if (reconcile) {
      turn.journal = 1
      if (typeof deps.bootId === 'string' && deps.bootId.length > 0) turn.deliveringBootId = deps.bootId
      else delete turn.deliveringBootId
    }
    persist(turn, reconcile)

    let outcome: Awaited<ReturnType<ThreadTurnQueueDeps['deliver']>>
    refusedGate = null
    try {
      outcome = await deps.deliver(turn)
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : 'deliver_threw' }
    }
    refusedGate = null

    if (outcome.ok) {
      turn.status = 'delivered'
      turn.settledAt = deps.now()
      delivered += 1
    } else if (outcome.reason === 'turn_cancelled') {
      // 6.53.0: the person cancelled THIS turn while it was being admitted (the turn route
      // refuses it before the live hop). It is the run they stopped, so it is settled as
      // cancelled here, never put back to wait and sent again after the hold.
      turn.status = 'cancelled'
      turn.reason = 'turn_cancelled'
      turn.settledAt = deps.now()
      retired += 1
    } else if (reconcile && outcome.replayed === true && outcome.deliveryState === 'unknown') {
      // 6.78.0 (V1 W6): the turn route REPLAYED this key as unknown (a receipt, or an
      // ambiguous ledger record). It will answer the same on every retry, by design, so it
      // is settled now as what it is: may have been sent, never sent again.
      turn.status = 'refused'
      turn.reason = 'delivery_unknown_after_restart'
      turn.deliveryState = 'unknown'
      turn.settledAt = deps.now()
      retired += 1
    } else if (isRetryableDelivery(outcome)) {
      // A GATE REFUSAL IS NOT A FAILED DELIVERY, so it must not spend the ceiling --
      // measured cost of getting this wrong: three of the user's turns retired in about
      // two minutes each, never delivered, while the 6h TTL never got to matter.
      //
      // REFUNDED, not deferred. The increment and its fsync stay BEFORE the call
      // (routes:101-103) because that is what survives a crash mid-delivery -- the
      // ceiling only bounds anything if it outlives the crash it is bounding, and a
      // test reads `attempts` off disk from inside the deliver callback to prove it.
      // So the attempt is spent first and given back here, where the outcome is known.
      turn.attempts = Math.max(0, turn.attempts - 1)
      turn.status = 'waiting'
      turn.reason = outcome.reason
      held += 1
    } else if (turn.attempts >= MAX_DELIVERY_ATTEMPTS) {
      turn.status = 'refused'
      turn.reason = outcome.reason ?? 'delivery_failed'
      turn.settledAt = deps.now()
      retired += 1
    } else {
      // Back to waiting for the next sweep. A failure that is not terminal is a
      // failure to deliver NOW, not a failure of the turn.
      turn.status = 'waiting'
      turn.reason = outcome.reason
      held += 1
    }
    persist(turn)
  }
  return { delivered, held, retired }
}

/**
 * 6.78.0 (MVP-B): settle the `delivering` rows a dead boot left on one thread.
 *
 * Today a row the process died delivering holds forever: `drainDecision` only acts on
 * `waiting`, `pruneQueue` keeps it, DELETE refuses it, and the busy-Codex hop stays off for
 * the thread while it exists. Only rows stamped by ANOTHER boot (or by none) are touched, so
 * a sweep cannot settle a row this process is delivering right now.
 *
 * The verdict is `deps.deliveryEvidence`; the one rule it cannot override is enforced here
 * as well: only a row this build stamped (`journal: 1`) and that is not a steer can be put
 * back to wait. Everything else needs positive evidence of delivery or is unknown.
 *   delivered      `delivered`, reason `reconciled_after_restart`
 *   not_delivered  back to `waiting`, reason `requeued_after_restart`, the attempt stays SPENT
 *                  (the ceiling must outlive the crash it bounds)
 *   unknown        `refused`, reason `delivery_unknown_after_restart`, `deliveryState:
 *                  'unknown'`, kept six hours and never resent
 */
export async function reconcileDeliveringTurns(
  provider: string,
  threadId: string,
  deps: ThreadTurnQueueDeps,
): Promise<{ delivered: number; requeued: number; unknown: number }> {
  const counts = { delivered: 0, requeued: 0, unknown: 0 }
  if (typeof deps.deliveryEvidence !== 'function') return counts
  const ownBoot = typeof deps.bootId === 'string' && deps.bootId.length > 0 ? deps.bootId : undefined
  const stranded = readQueue(provider, threadId, deps.now())
    .filter(t => t.status === 'delivering' && !(t.deliveringBootId !== undefined && t.deliveringBootId === ownBoot))
  for (const row of stranded) {
    let verdict: DeliveryEvidence
    try {
      verdict = await deps.deliveryEvidence(row)
    } catch {
      verdict = 'unknown'
    }
    if (verdict !== 'delivered' && verdict !== 'not_delivered') verdict = 'unknown'
    if (verdict === 'not_delivered' && (row.journal !== 1 || row.mode === 'steer')) verdict = 'unknown'
    // Re-read after the await, and only touch the row if it is still the one we judged.
    const latest = readQueue(provider, threadId, deps.now())
    const current = latest.find(t => t.clientTurnId === row.clientTurnId)
    if (!current || current.status !== 'delivering' || current.deliveringBootId !== row.deliveringBootId) continue
    const at = deps.now()
    if (verdict === 'delivered') {
      current.status = 'delivered'
      current.reason = 'reconciled_after_restart'
      current.settledAt = at
      counts.delivered += 1
    } else if (verdict === 'not_delivered') {
      current.status = 'waiting'
      current.reason = 'requeued_after_restart'
      delete current.journal
      delete current.deliveringBootId
      counts.requeued += 1
    } else {
      current.status = 'refused'
      current.reason = 'delivery_unknown_after_restart'
      current.deliveryState = 'unknown'
      current.settledAt = at
      counts.unknown += 1
    }
    writeQueue(provider, threadId, latest, { durable: true })
    console.log(`[thread-turn-queue] reconciled provider=${provider} clientTurnId=${row.clientTurnId} verdict=${verdict} stamped=${row.journal === 1} mode=${row.mode ?? 'queue'}`)
  }
  return counts
}

/** One pass over every thread holding a queue. */
export async function drainAllThreads(deps: ThreadTurnQueueDeps): Promise<number> {
  let delivered = 0
  for (const { provider, threadId } of queuedThreadKeys()) {
    try {
      delivered += (await drainThread(provider, threadId, deps)).delivered
    } catch (error) {
      // One bad thread must not stop the sweep for every other thread.
      console.error(`[thread-turn-queue] drain failed for ${provider}: ${error instanceof Error ? error.message : error}`)
    }
  }
  return delivered
}

/**
 * Session steer (6.78.0, COS_SESSION_STEER): the turn goes INTO the running Claude turn
 * through the session's peer inbox, and lands at its next tool boundary (live probe 3,
 * Claude Code 2.1.302: a COS-format frame written mid-tool folded into the running turn).
 *
 * THE ORDER IS THE SAFETY:
 *   1. the intent row, durably: `delivering`, `mode: 'steer'`, stamped
 *   2. the attempt `pending`, durably, BEFORE any frame
 *   3. `deliverLiveTurn`
 *   4. the verdict, journal first, then the row
 * A crash after 1 leaves a steer row with no positive evidence (the reconcile reads it as
 * unknown, never resends it); after 2, an attempt that never reported back (unknown).
 *
 *   ok                                   200 {state: delivered, reason: steered}
 *   unverified, write_failed, a throw    200 {state: refused, reason: steer_unverified,
 *                                        deliveryState: unknown}: may be in the session,
 *                                        never resent, kept six hours
 *   nothing reached the session          the row waits like any parked turn: 202 with
 *                                        `steerFallback` (or, with fallback none, settled
 *                                        `refused` / `steer_not_sent`)
 */
async function steerTurn(
  _req: Request,
  res: Response,
  deps: ThreadTurnQueueDeps,
  turn: QueuedThreadTurn,
  queue: QueuedThreadTurn[],
  gateReason: string | null,
  fallbackNone: boolean,
): Promise<unknown> {
  const { provider, threadId, clientTurnId, prompt } = turn
  const intent: QueuedThreadTurn = {
    ...turn,
    status: 'delivering',
    attempts: 1,
    mode: 'steer',
    journal: 1,
    ...(typeof deps.bootId === 'string' && deps.bootId.length > 0 ? { deliveringBootId: deps.bootId } : {}),
  }
  const admitted = admitToQueue(queue, intent)
  if (!admitted.ok) return res.status(409).json({ error: admitted.reason })
  writeQueue(provider, threadId, admitted.queue, { durable: true })

  /** Rewrite this row on the CURRENT file: other requests may have changed others meanwhile. */
  const settleRow = (apply: (row: QueuedThreadTurn) => void): QueuedThreadTurn[] => {
    const latest = readQueue(provider, threadId, deps.now())
    const row = latest.find(t => t.clientTurnId === clientTurnId)
    if (row) { apply(row); writeQueue(provider, threadId, latest, { durable: true }) }
    return latest
  }
  const backToWaiting = (row: QueuedThreadTurn): void => {
    row.status = 'waiting'
    row.attempts = 0
    delete row.mode
    delete row.journal
    delete row.deliveringBootId
  }
  const queued202 = (latest: QueuedThreadTurn[], steerFallback: string) => res.status(202).json({
    queued: true,
    clientTurnId,
    position: queuePosition(latest, clientTurnId),
    waitingOn: gateReason,
    steerFallback,
  })

  let begun = false
  try {
    begun = deps.attempts?.begin(provider, threadId, clientTurnId, 'steer', deps.now()) === true
  } catch {
    begun = false
  }
  if (!begun) {
    // Nothing was sent, and nothing may be until the attempt is on record: an ordinary park.
    const latest = settleRow(backToWaiting)
    console.warn(`[thread-turn-queue] steer not attempted provider=${provider} clientTurnId=${clientTurnId}: the attempt journal could not record it; queued`)
    return queued202(latest, 'journal_unavailable')
  }

  let live: { ok: boolean; reason: string } | null = null
  try {
    live = await deps.deliverLiveTurn!({ provider, sessionId: threadId, prompt, verifyTimeoutMs: PEER_VERIFY_TIMEOUT_MS, clientTurnId })
  } catch (error) {
    console.error(`[thread-turn-queue] steer delivery threw: ${error instanceof Error ? error.message : error}`)
    live = null
  }
  const at = deps.now()
  const journal = (exit: 'sent' | 'not_sent' | 'unknown'): void => {
    try { deps.attempts?.settle(provider, threadId, clientTurnId, exit, at) } catch { /* the reconcile reads `pending` as unknown */ }
  }
  console.log(`[thread-turn-queue] steer provider=${provider} clientTurnId=${clientTurnId} hop=${live?.reason ?? 'threw'}`)

  if (live?.ok === true) {
    journal('sent')
    settleRow(row => { row.status = 'delivered'; row.reason = 'steered'; row.settledAt = at })
    return res.status(200).json({ state: 'delivered', reason: 'steered', clientTurnId })
  }
  if (live === null || live.reason === 'unverified' || live.reason === 'write_failed') {
    journal('unknown')
    settleRow(row => { row.status = 'refused'; row.reason = 'steer_unverified'; row.deliveryState = 'unknown'; row.settledAt = at })
    return res.status(200).json({
      state: 'refused',
      reason: 'steer_unverified',
      deliveryState: 'unknown',
      reasonCopy: queuedTurnReasonCopy('steer_unverified'),
    })
  }
  // disabled, no_record, connect_failed, protocol_unsupported, suspect_expired, not_claude:
  // the transport's own word that nothing reached a session.
  journal('not_sent')
  if (fallbackNone) {
    settleRow(row => { row.status = 'refused'; row.reason = 'steer_not_sent'; row.settledAt = at })
    return res.status(200).json({ state: 'refused', reason: 'steer_not_sent', reasonCopy: queuedTurnReasonCopy('steer_not_sent') })
  }
  return queued202(settleRow(backToWaiting), 'no_outside_channel')
}

export function createThreadTurnQueueRouter(deps: ThreadTurnQueueDeps): Router {
  const router = Router()

  // POST — park a turn for a thread that is busy right now.
  router.post('/agent-sessions/:provider/:threadId/queued-turns', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const provider = String(req.params.provider ?? '')
    const threadId = String(req.params.threadId ?? '')
    const body = (req.body ?? {}) as Record<string, unknown>
    const clientTurnId = typeof body.clientTurnId === 'string' ? body.clientTurnId : ''
    const cosSessionId = typeof body.cosSessionId === 'string' ? body.cosSessionId : ''
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    if (!clientTurnId || !cosSessionId || !prompt.trim()) {
      return res.status(400).json({ error: 'invalid_request' })
    }
    // 6.48.1: the attach route refuses an id outside COS_SESSION_ID_RE as invalid_request,
    // which the drainer treats as retryable, so a bad id used to sit in the queue for the
    // whole TTL. Refuse it here, where the client can still fix it.
    if (!COS_SESSION_ID_RE.test(cosSessionId)) {
      return res.status(400).json({ error: 'invalid_request', reason: 'invalid_cos_session_id' })
    }

    // 6.78.0: `mode: 'steer'` asks for the running turn itself (COS_SESSION_STEER). Off, the
    // field is ignored exactly as a 6.77 server ignores it.
    const steerOn = sessionSteerEnabled()
    const wantSteer = steerOn && body.mode === 'steer'
    const fallbackNone = wantSteer && body.fallback === 'none'

    // 6.78.0: REPLAY BEFORE THE GATE. A key this queue already holds answers with what that
    // row is, whatever the thread is doing now: still 409 `duplicate_turn` (the 6.10.644 lens
    // and Control read that code as "parked"), with the row's state, its delivery state and
    // the reason line. Before 6.78 the gate ran first, so a retry of a turn that had since
    // drained on a now-free thread read `thread_free` and was sent a second time.
    if (queueReconcileEnabled() || steerOn) {
      const held = readQueue(provider, threadId, deps.now()).find(t => t.clientTurnId === clientTurnId)
      if (held) {
        const heldCopy = queueReconcileEnabled() ? queuedTurnReasonCopy(held.reason) : null
        return res.status(409).json({
          error: 'duplicate_turn',
          state: held.status,
          ...(held.deliveryState ? { deliveryState: held.deliveryState } : {}),
          ...(heldCopy ? { reasonCopy: heldCopy } : {}),
        })
      }
    }

    // THE GATE DECIDES WHETHER PARKING IS EVEN HONEST. A structural refusal can never
    // clear, and telling someone their turn is queued when it can never run is worse
    // than refusing it. An attachable thread is not queued either -- it is sent now,
    // through the ordinary route, which the client does on this 409.
    const gate = deps.occupancy(provider, threadId)

    // 6.51.0: Cursor queues ONLY a composer its hooks show mid-turn, because the only way
    // in is that turn's Stop hook. An idle composer fires no Stop, so a turn parked there
    // could never run; that stays the 423 it always was, as does every Agent CLI chat.
    if (provider === 'cursor' && gate.reason !== 'native_thread_working') {
      return res.status(423).json({ error: 'unsupported_provider', queueable: false })
    }
    if (gate.attachable) return res.status(409).json({ error: 'thread_free', hint: 'send_now' })
    if (!queueableRefusal(gate.reason)) {
      return res.status(423).json({ error: gate.reason ?? 'probe_failed', queueable: false })
    }

    const now = deps.now()
    const queue = readQueue(provider, threadId, now)
    const turn: QueuedThreadTurn = {
      clientTurnId, cosSessionId, provider, threadId, prompt,
      queuedAt: now, status: 'waiting', attempts: 0,
      // 6.62.0 /qa (Q3): the acknowledgement travels with the row to its drain.
      ...(continueNoteAcknowledged(req.headers[CONTINUE_NOTE_HEADER]) ? { continueNoteAck: true as const } : {}),
    }

    let steerFallback: string | null = null
    if (wantSteer) {
      const availability = steerAvailabilityFor(deps, provider, threadId, gate.reason)
      if (availability.available) return steerTurn(req, res, deps, turn, queue, gate.reason, fallbackNone)
      if (fallbackNone) return res.status(409).json({ error: 'steer_unavailable', reason: availability.reason })
      steerFallback = availability.reason
    }

    const admitted = admitToQueue(queue, turn)
    if (!admitted.ok) return res.status(409).json({ error: admitted.reason })

    writeQueue(provider, threadId, admitted.queue)
    return res.status(202).json({
      queued: true,
      clientTurnId,
      position: queuePosition(admitted.queue, clientTurnId),
      waitingOn: gate.reason,
      ...(steerFallback !== null ? { steerFallback } : {}),
    })
  })

  // POST — Send again (6.78.0, COS_QUEUE_RESEND). A refused or expired row's words, copied
  // ON THE SERVER under a new key. Once only, across every surface: the original records the
  // copy it became (`resentAs`), and a repeat from anywhere answers that row.
  //
  // ONE SYNCHRONOUS READ-MODIFY-WRITE. There is no `await` between reading `resentAs` and
  // writing it, so two taps (lens and phone) in the same tick cannot both pass the check.
  // The new row is admitted even when the thread is free: the drain sends it through the
  // ordinary front door, with every gate.
  router.post('/agent-sessions/:provider/:threadId/queued-turns/:clientTurnId/resend', (req: Request, res: Response, next) => {
    // Off: not a route at all, exactly as on 6.77 (a client reads the 404 as "update the server").
    if (!queueResendEnabled()) return next()
    res.set('Cache-Control', 'private, no-store')
    const provider = String(req.params.provider ?? '')
    const threadId = String(req.params.threadId ?? '')
    const originalId = String(req.params.clientTurnId ?? '')
    const body = (req.body ?? {}) as Record<string, unknown>
    const newId = typeof body.clientTurnId === 'string' ? body.clientTurnId : ''
    const cosSessionId = typeof body.cosSessionId === 'string' ? body.cosSessionId : ''
    if (!CLIENT_TURN_ID_RE.test(newId) || !COS_SESSION_ID_RE.test(cosSessionId)) {
      return res.status(400).json({ error: 'invalid_request' })
    }
    const now = deps.now()
    const queue = readQueue(provider, threadId, now)
    const original = queue.find(t => t.clientTurnId === originalId)
    // Pruned (or never here): nothing to copy, and saying "sent again" would be invented.
    if (!original) return res.status(404).json({ error: 'unknown_turn' })
    if (typeof original.resentAs === 'string' && original.resentAs.length > 0) {
      const again = queue.find(t => t.clientTurnId === original.resentAs)
      return res.status(200).json(again
        ? { ...publicRow(again, queuePosition(queue, again.clientTurnId)), replayed: true }
        : { clientTurnId: original.resentAs, resendOf: original.clientTurnId, replayed: true })
    }
    if (original.status !== 'refused' && original.status !== 'expired') return res.status(409).json({ error: 'not_resendable' })
    // "May not have been sent": a second copy is possible, so the person has to have been told.
    if (original.deliveryState === 'unknown' && body.acknowledge !== 'may_duplicate') {
      return res.status(409).json({ error: 'acknowledge_required' })
    }
    const copy: QueuedThreadTurn = {
      clientTurnId: newId, cosSessionId, provider, threadId,
      prompt: original.prompt,
      queuedAt: now, status: 'waiting', attempts: 0,
      ...(original.continueNoteAck === true ? { continueNoteAck: true as const } : {}),
      resendOf: original.clientTurnId,
    }
    const admitted = admitToQueue(queue, copy)
    if (!admitted.ok) return res.status(409).json({ error: admitted.reason })
    original.resentAs = newId
    writeQueue(provider, threadId, admitted.queue)
    console.log(`[thread-turn-queue] resend provider=${provider} from=${original.clientTurnId} as=${newId} unknown=${original.deliveryState === 'unknown'}`)
    return res.status(200).json(publicRow(copy, queuePosition(admitted.queue, newId)))
  })

  // GET — what is waiting, for the pending row on the lens.
  router.get('/agent-sessions/:provider/:threadId/queued-turns', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const provider = String(req.params.provider ?? '')
    const threadId = String(req.params.threadId ?? '')
    const queue = readQueue(provider, threadId, deps.now())
    let native: Record<string, unknown>[] = []
    if (provider === 'codex') {
      try {
        native = (await (deps.nativeQueue ?? nativeQueueControl).list(threadId)).map((row, position) => {
          const text = plainQueueText(row)
          return { clientTurnId: `codex-native:${row.id}`, status: 'waiting', position, queuedAt: 0,
            attempts: 0, preview: text?.slice(0, 80) ?? 'Message with attachments · manage in Codex',
            ...(text !== null ? { prompt: text } : {}), editable: text !== null, owner: 'codex' }
        })
      } catch { return res.status(503).json({ error: 'native_queue_unavailable' }) }
    }
    // Re-read after the native await: delivery may have changed COS ownership.
    const current = readQueue(provider, threadId, deps.now())
    return res.json({ turns: [...native, ...current.map(t => publicRow(t, queuePosition(current, t.clientTurnId) + native.length))] })
  })

  // Atomic replacement: no cancel-and-requeue window, and the slot is retained.
  router.patch('/agent-sessions/:provider/:threadId/queued-turns/:clientTurnId', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const provider = String(req.params.provider), threadId = String(req.params.threadId), id = String(req.params.clientTurnId)
    const prompt = req.body?.prompt
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > DEFAULT_MAX_PROMPT_CHARS) return res.status(400).json({ error: 'invalid_prompt' })
    if (provider === 'codex' && id.startsWith('codex-native:')) {
      try {
        await (deps.nativeQueue ?? nativeQueueControl).update(threadId, id.slice(13), prompt)
        return res.json({ updated: true })
      } catch { return res.status(409).json({ error: 'queue_edit_unconfirmed' }) }
    }
    const queue = readQueue(provider, threadId, deps.now())
    const row = queue.find(t => t.clientTurnId === id)
    if (!row || row.status !== 'waiting') return res.status(409).json({ error: 'already_delivering' })
    row.prompt = prompt
    writeQueue(provider, threadId, queue)
    return res.json({ updated: true })
  })

  // DELETE — the cancel control, the same affordance the desktop queue offers.
  router.delete('/agent-sessions/:provider/:threadId/queued-turns/:clientTurnId', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const provider = String(req.params.provider ?? '')
    const threadId = String(req.params.threadId ?? '')
    const clientTurnId = String(req.params.clientTurnId ?? '')
    if (provider === 'codex' && clientTurnId.startsWith('codex-native:')) {
      try {
        const cancelled = await (deps.nativeQueue ?? nativeQueueControl).cancel(threadId, clientTurnId.slice(13))
        return res.status(cancelled ? 200 : 409).json(cancelled ? { cancelled: true, clientTurnId, status: 'cancelled' } : { error: 'already_delivering' })
      } catch { return res.status(503).json({ error: 'native_queue_unavailable' }) }
    }
    const now = deps.now()
    const queue = readQueue(provider, threadId, now)
    const row = queue.find(t => t.clientTurnId === clientTurnId)
    if (!row) return res.status(404).json({ error: 'unknown_turn' })
    // A turn already handed to the adapter cannot be recalled, and saying otherwise
    // would be the one lie this whole feature exists to avoid.
    if (row.status === 'delivering') return res.status(409).json({ error: 'already_delivering' })
    if (row.status === 'waiting') {
      row.status = 'cancelled'
      row.settledAt = now
      writeQueue(provider, threadId, queue)
    }
    return res.json({ cancelled: true, clientTurnId, status: row.status })
  })

  return router
}
