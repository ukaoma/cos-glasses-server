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

import { randomBytes } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { CONTINUE_NOTE_HEADER, continueNoteAcknowledged } from '../lib/continue-plan.js'
import { nativeQueueControl, plainQueueText, type NativeQueueControl } from '../lib/codex-queue-control.js'
import { CLIENT_TURN_ID_RE, COS_SESSION_ID_RE, DEFAULT_MAX_PROMPT_CHARS } from './agent-session-bindings.js'
import {
  admitToQueue, drainDecision, holdReasonFor, queueableRefusal, queuePosition,
  MAX_DELIVERY_ATTEMPTS, type DrainObservation, type QueuedThreadTurn,
  queueReconcileEnabled, queueResendEnabled, queuedTurnReasonCopy, sessionSteerAvailability, sessionSteerEnabled,
  steerMidturnEnabled, type SessionSteerAvailability,
} from '../lib/thread-turn-queue.js'
import { readQueue, writeQueue, queuedThreadKeys } from '../lib/thread-turn-queue-store.js'
import type { DeliveryEvidence } from '../lib/queue-turn-evidence.js'
import { continueLiveEnabled } from '../lib/session-peer-inbox-deps.js'
import { PEER_VERIFY_TIMEOUT_MS } from '../lib/session-peer-inbox.js'
import { attachmentsDigest, FOOTER_LINE_REFUSED_COPY, hasFooterShapedLine, sealMatches, stripG2TurnFooter, TURN_ID_IN_USE_COPY, unvouched, type G2TurnProvenance, type OriginVerdict } from '../lib/g2-turn-provenance.js'
import { defaultTurnAttachmentStore, keepTurnAttachments, parseTurnAttachmentIds, TURN_ATTACHMENT_COPY, turnAttachmentManifest, type TurnAttachmentStore } from '../lib/session-turn-attachments.js'

/**
 * G2 authority Tier 1 (6.99.29, Codex audit of e4758a6): the verdict a parked turn's files allow, and
 * the attachment digest its origin is sealed to. Files whose content cannot be read leave the turn
 * unvouched (it still parks); no files is the empty digest and reads nothing.
 */
async function sealFiles(ids: readonly string[] | undefined, verdict: OriginVerdict, store: TurnAttachmentStore | undefined): Promise<{ verdict: OriginVerdict; attachments: string; manifest: ReadonlyArray<{ id: string; sha256: string }> | null }> {
  if (!Array.isArray(ids) || ids.length === 0) return { verdict, attachments: '', manifest: [] }
  const manifest = await turnAttachmentManifest(ids, store)
  if (!manifest.ok) return { verdict: unvouched(verdict, 'attachments_unsealable'), attachments: '', manifest: null }
  return { verdict, attachments: attachmentsDigest(manifest.manifest), manifest: manifest.manifest }
}

export interface ThreadTurnQueueDeps {
  /** 11/07: the media store a parked turn's `attachmentIds` are checked against. Absent: the real store. Tests pass a fake. */
  turnAttachmentStore?: TurnAttachmentStore
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
  /**
   * G2 authority Tier 1, with web origin (6.99.29), optional: the origin of each parked turn is
   * captured here (and again on an edit or a Send again, each judged by its own request) and carried to
   * its drain, forgotten on any settle; a steer and a native Codex queue edit are ledgered and
   * footed like a turn. Absent: the 6.99.28 behaviour.
   */
  provenance?: G2TurnProvenance
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
  /**
   * Steer mid-turn (COS_STEER_MIDTURN), optional: ask for a drain pass for this thread now, so a
   * turn parked at a busy session that can take it mid-turn goes in within seconds instead of at
   * the next 20 s sweep. Production: the shared drain kick (one pass in flight, ever). Absent: the
   * sweep still delivers it, only later.
   */
  kickDrain?: (threadId: string) => void
}

/**
 * Can this thread take a parked turn mid-turn right now (COS_STEER_MIDTURN)? The same shared rule
 * as Session steer, plus the switch and the two members the drain's steer needs. Never throws.
 */
export function midTurnAvailabilityFor(deps: Pick<ThreadTurnQueueDeps, 'steerProbe' | 'deliverLiveTurn' | 'continueLive' | 'attempts'>, provider: string, threadId: string, gateReason: string | null): SessionSteerAvailability | null {
  if (!steerMidturnEnabled()) return null
  if (typeof deps.deliverLiveTurn !== 'function' || !deps.attempts) return { available: false, reason: 'no_outside_channel' }
  return steerAvailabilityFor(deps, provider, threadId, gateReason)
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

/**
 * When a sweep last decided each held row (epoch ms), in memory only: the row file is written when its hold
 * reason CHANGES, not every 20 s. Bounded; a settled row is forgotten.
 */
const holdCheckedAt = new Map<string, number>()
const HOLD_CHECKED_MAX = 1_000
export function __resetHoldCheckedForTests(): void { holdCheckedAt.clear() }

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
    // 11/07: how many files wait with the words (never their ids or paths). Absent without files.
    ...(Array.isArray(turn.attachmentIds) && turn.attachmentIds.length > 0 ? { attachments: turn.attachmentIds.length } : {}),
    // 2026-11-11: why a waiting row is held (a code), since when, and when a sweep last decided it. Additive.
    ...(turn.status === 'waiting' && typeof turn.holdReason === 'string' ? {
      waiting_reason: turn.holdReason,
      ...(typeof turn.holdSince === 'number' ? { waiting_since: turn.holdSince } : {}),
      ...(holdCheckedAt.has(turn.clientTurnId) ? { waiting_checked_at: holdCheckedAt.get(turn.clientTurnId) } : {}),
    } : {}),
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
 * The verdict a drain hop with no parked origin is judged by: the loopback call it is. The front
 * door reaches the same verdict through `originOf` on the drainer's own request (local socket,
 * token shown), so a steered turn and a front-door turn are ledgered alike. Never footed.
 */
function localDrainVerdict(at: number): OriginVerdict {
  return {
    origin: { remote: '127.0.0.1', loopback: true, ownAddress: true, clientInstance: null, client: 'local', tokenPresented: true, webSession: false },
    verifiedOrigin: false,
    reason: 'local_socket',
    judgedAt: at,
  }
}

/** What one mid-turn attempt did to its row: delivered, settled some other way, or left waiting. */
type MidTurnOutcome = 'delivered' | 'settled' | 'held' | 'held_files'

/**
 * Steer mid-turn (COS_STEER_MIDTURN, Miles 2026-11-07): put ONE waiting row into the running turn
 * of a busy Claude desk session through its peer inbox. Claude Code takes the frame at once (its
 * `enqueue` row is the proof `deliverLiveTurn` waits for) and folds it in at its next tool step.
 *
 * Called only by `drainThread`, only for a row the drain would otherwise hold behind a busy gate,
 * and only in FIFO order (the caller stops at the first row that holds).
 *
 * WHO MAY BE STEERED: a row never attempted (`attempts === 0`: no front-door attempt, no earlier
 * steer, no restart requeue, so nothing about it is unknown), with no files (the peer inbox
 * carries words only), on a thread the shared steer rule says can take it now.
 *
 * PROVENANCE IS CHECKED HERE AS THE TURNS ROUTE CHECKS IT, because this hop does not go through
 * that front door: footer-shaped words are refused, the parked origin is carried (a single-use
 * carry token, spent in this process), its seal must name this provider, thread and no files,
 * a turn id held for another turn is refused, and only the server writes the footer. A refusal
 * settles the row `refused` with its own reason, so it reads "Not sent" with the reason line.
 *
 * NEVER TWICE, in the same order as `steerTurn`: the intent row (`delivering`, `mode: 'steer'`,
 * `journal: 1`, this boot) durably, then the attempt `pending`, then the frame, then the
 * verdict, journal first. Unverified, a failed write or a throw: `refused`, `steer_unverified`,
 * `deliveryState: 'unknown'`, never resent. Nothing reached the session: back to waiting, the
 * attempt given back, so the turn-end front door sends it as before.
 *
 * NO AWAIT BEFORE THE INTENT ROW IS WRITTEN: the caller read this row as `waiting` in the same
 * synchronous step, so a cancel cannot slip between that read and the `delivering` write.
 */
async function steerHeldTurn(
  provider: string,
  threadId: string,
  turn: QueuedThreadTurn,
  gateReason: string | null,
  deps: ThreadTurnQueueDeps,
): Promise<MidTurnOutcome> {
  if (turn.status !== 'waiting' || turn.attempts !== 0) return 'held'
  const availability = midTurnAvailabilityFor(deps, provider, threadId, gateReason)
  if (!availability || !availability.available) return 'held'
  // Files never go into a running turn (the peer inbox carries words only). Checked AFTER availability, so
  // `held_files` means exactly this: the turn could have gone in now but for its files (the row's hold reason).
  if (Array.isArray(turn.attachmentIds) && turn.attachmentIds.length > 0) return 'held_files'
  const { clientTurnId, prompt } = turn

  const rewrite = (apply: (row: QueuedThreadTurn) => void): QueuedThreadTurn | null => {
    const latest = readQueue(provider, threadId, deps.now())
    const row = latest.find(t => t.clientTurnId === clientTurnId)
    if (!row) return null
    apply(row)
    writeQueue(provider, threadId, latest, { durable: true })
    return row
  }
  const refuse = (reason: string): MidTurnOutcome => {
    const at = deps.now()
    rewrite(row => { row.status = 'refused'; row.reason = reason; row.settledAt = at })
    deps.provenance?.forgetQueued(provider, threadId, clientTurnId)
    console.warn(`[thread-turn-queue] mid-turn refused provider=${provider} clientTurnId=${clientTurnId} reason=${reason}`)
    return 'settled'
  }

  // The front door's provenance gates, in its order.
  let verdict: OriginVerdict | null = null
  if (deps.provenance) {
    if (hasFooterShapedLine(prompt)) return refuse('footer_line_refused')
    const token = deps.provenance.issueCarry({ provider, threadId, clientTurnId, prompt })
    const carried = token ? deps.provenance.takeCarry(token, clientTurnId, prompt) : null
    // No carry could be made: leave it for the front door, which decides with its own carry.
    if (carried === null) return 'held'
    if (carried.seal !== null && !sealMatches(carried.seal, { provider, threadId, attachments: '' })) return refuse('queued_turn_tampered')
    verdict = carried.verdict ?? localDrainVerdict(deps.now())
    if (deps.provenance.reusesTurnId(clientTurnId, { prompt, verdict, provider, sessionId: threadId }, { continues: true })) return refuse('turn_id_in_use')
  }
  const sent = deps.provenance && verdict ? deps.provenance.footed(prompt, clientTurnId, verdict, provider) : prompt
  const ledger = (via: string): void => {
    if (deps.provenance && verdict) deps.provenance.record({ turnId: clientTurnId, prompt, verdict, provider, sessionId: threadId, via, continues: true })
  }

  // 1. The intent row, durably.
  const intent = rewrite(row => {
    row.status = 'delivering'
    row.attempts = 1
    row.mode = 'steer'
    row.journal = 1
    if (typeof deps.bootId === 'string' && deps.bootId.length > 0) row.deliveringBootId = deps.bootId
    else delete row.deliveringBootId
  })
  if (!intent) return 'held'
  const backToWaiting = (row: QueuedThreadTurn): void => {
    row.status = 'waiting'
    row.attempts = 0
    delete row.mode
    delete row.journal
    delete row.deliveringBootId
  }

  // 2. The attempt `pending`, durably, before any frame.
  let begun = false
  try { begun = deps.attempts!.begin(provider, threadId, clientTurnId, 'steer', deps.now()) === true } catch { begun = false }
  if (!begun) {
    rewrite(backToWaiting)
    console.warn(`[thread-turn-queue] mid-turn not attempted provider=${provider} clientTurnId=${clientTurnId}: the attempt journal could not record it`)
    return 'held'
  }

  // 3. The frame.
  const startedAt = deps.now()
  let live: { ok: boolean; reason: string } | null = null
  try {
    live = await deps.deliverLiveTurn!({ provider, sessionId: threadId, prompt: sent, verifyTimeoutMs: PEER_VERIFY_TIMEOUT_MS, clientTurnId })
  } catch (error) {
    console.error(`[thread-turn-queue] mid-turn delivery threw: ${error instanceof Error ? error.message : error}`)
    live = null
  }
  const at = deps.now()
  const journal = (exit: 'sent' | 'not_sent' | 'unknown'): void => {
    try { deps.attempts!.settle(provider, threadId, clientTurnId, exit, at) } catch { /* the reconcile reads `pending` as unknown */ }
  }
  console.log(`[thread-turn-queue] mid-turn provider=${provider} clientTurnId=${clientTurnId} hop=${live?.reason ?? 'threw'} ms=${Math.max(0, at - startedAt)} waitedMs=${Math.max(0, at - turn.queuedAt)}`)

  // 4. The verdict, journal first, then the row.
  if (live?.ok === true) {
    journal('sent')
    ledger('drain-steer')
    rewrite(row => { row.status = 'delivered'; row.reason = 'steered'; row.settledAt = at })
    deps.provenance?.forgetQueued(provider, threadId, clientTurnId)
    return 'delivered'
  }
  if (live === null || live.reason === 'unverified' || live.reason === 'write_failed') {
    journal('unknown')
    ledger('drain-steer-unverified')
    rewrite(row => { row.status = 'refused'; row.reason = 'steer_unverified'; row.deliveryState = 'unknown'; row.settledAt = at })
    deps.provenance?.forgetQueued(provider, threadId, clientTurnId)
    return 'settled'
  }
  // The transport's own word that nothing reached a session: the row waits for the turn end.
  journal('not_sent')
  rewrite(backToWaiting)
  return 'held'
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
  // G2 authority Tier 1 (QA 6.99.29): a parked origin is forgotten on ANY settle (delivered,
  // cancelled, refused, expired, given up). Only a row still `waiting` keeps it for its next attempt.
  const forgetIfSettled = (turn: QueuedThreadTurn): void => {
    if (turn.status !== 'waiting') deps.provenance?.forgetQueued(provider, threadId, turn.clientTurnId)
  }

  // Steer mid-turn (COS_STEER_MIDTURN): FIFO per thread. Once a row ahead cannot go in mid-turn
  // (or is still being delivered), nothing behind it may jump it; it waits for the turn end too.
  let midTurnOrderHeld = false

  for (const snapshot of queue) {
    const turn = readQueue(provider, threadId, deps.now()).find(t => t.clientTurnId === snapshot.clientTurnId)
    if (!turn) continue
    if (turn.status === 'delivering') midTurnOrderHeld = true
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

    if (decision === 'hold') {
      // Steer mid-turn: never during a cancel hold (the person said stop), only for the first
      // rows in order, and only where the shared steer rule says this session can take it now,
      // which also means the hold is the busy GATE: the rule answers only for a refusal that
      // names a desk run (an attachable thread has no reason). Anything else holds as before.
      const cancelHeld = typeof seen.cancelHoldUntil === 'number' && Number.isFinite(seen.cancelHoldUntil) && deps.now() < seen.cancelHoldUntil
      let reason = holdReasonFor(seen, deps.now())
      if (!midTurnOrderHeld && !cancelHeld) {
        const outcome = await steerHeldTurn(provider, threadId, turn, gate.reason, deps)
        if (outcome === 'delivered') { holdCheckedAt.delete(turn.clientTurnId); delivered += 1; continue }
        if (outcome === 'settled') { holdCheckedAt.delete(turn.clientTurnId); retired += 1; continue }
        if (outcome === 'held_files') reason = 'files_wait_for_turn_end'
      }
      // The hold reason: written only when it changes; the check time is kept in memory (2026-11-11).
      const at = deps.now()
      if (turn.holdReason !== reason) { turn.holdReason = reason; turn.holdSince = at; persist(turn) }
      holdCheckedAt.delete(turn.clientTurnId)
      holdCheckedAt.set(turn.clientTurnId, at)
      while (holdCheckedAt.size > HOLD_CHECKED_MAX) holdCheckedAt.delete(holdCheckedAt.keys().next().value!)
      midTurnOrderHeld = true
      held += 1
      continue
    }
    if (decision === 'expire' || decision === 'give_up') {
      turn.status = decision === 'expire' ? 'expired' : 'refused'
      turn.reason = decision === 'expire' ? 'queued_turn_expired' : 'delivery_attempts_exhausted'
      turn.settledAt = deps.now()
      retired += 1; persist(turn)
      forgetIfSettled(turn)
      holdCheckedAt.delete(turn.clientTurnId)
      continue
    }

    // ATTEMPT IS RECORDED BEFORE THE CALL, and persisted. A delivery that crashes the
    // process mid-flight must not come back with its attempt count unchanged and try
    // forever; the ceiling only bounds anything if it survives the crash it is bounding.
    turn.attempts += 1
    turn.status = 'delivering'
    // No longer held: the reason belonged to the wait that just ended.
    delete turn.holdReason
    delete turn.holdSince
    holdCheckedAt.delete(turn.clientTurnId)
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
    forgetIfSettled(turn)
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
  // Without its own boot id this process cannot tell a row it is delivering right now (the
  // drain and the steer path stamp only with one) from a row a dead boot left, so it
  // touches nothing: a row in flight must never be judged.
  const ownBoot = typeof deps.bootId === 'string' && deps.bootId.length > 0 ? deps.bootId : null
  if (ownBoot === null) return counts
  const stranded = readQueue(provider, threadId, deps.now())
    .filter(t => t.status === 'delivering' && t.deliveringBootId !== ownBoot)
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
  verdict: OriginVerdict | null = null,
): Promise<unknown> {
  const { provider, threadId, clientTurnId, prompt } = turn
  // G2 authority Tier 1 (6.99.29): a steer goes straight into the running session through its peer
  // inbox, so it is a delivery of its own and carries the footer like a turn.
  const steerPrompt = deps.provenance && verdict ? deps.provenance.footed(prompt, clientTurnId, verdict, provider) : prompt
  const ledgerSteer = (via: string): void => {
    if (deps.provenance && verdict) deps.provenance.record({ turnId: clientTurnId, prompt, verdict, provider, sessionId: threadId, via })
  }
  const intent: QueuedThreadTurn = {
    ...turn,
    status: 'delivering',
    attempts: 1,
    mode: 'steer',
    journal: 1,
    ...(typeof deps.bootId === 'string' && deps.bootId.length > 0 ? { deliveringBootId: deps.bootId } : {}),
  }
  const admitted = admitToQueue(queue, intent)
  if (!admitted.ok) {
    deps.provenance?.forgetQueued(provider, threadId, clientTurnId)
    return res.status(409).json({ error: admitted.reason })
  }
  writeQueue(provider, threadId, admitted.queue, { durable: true })

  /** Rewrite this row on the CURRENT file: other requests may have changed others meanwhile. */
  const settleRow = (apply: (row: QueuedThreadTurn) => void): QueuedThreadTurn[] => {
    const latest = readQueue(provider, threadId, deps.now())
    const row = latest.find(t => t.clientTurnId === clientTurnId)
    if (row) { apply(row); writeQueue(provider, threadId, latest, { durable: true }) }
    // G2 authority Tier 1 (QA 6.99.29): a steer that settled (delivered or refused) forgets its
    // parked origin; one put back to wait keeps it for the drain.
    if (!row || row.status !== 'waiting') deps.provenance?.forgetQueued(provider, threadId, clientTurnId)
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
    live = await deps.deliverLiveTurn!({ provider, sessionId: threadId, prompt: steerPrompt, verifyTimeoutMs: PEER_VERIFY_TIMEOUT_MS, clientTurnId })
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
    ledgerSteer('steer')
    settleRow(row => { row.status = 'delivered'; row.reason = 'steered'; row.settledAt = at })
    return res.status(200).json({ state: 'delivered', reason: 'steered', clientTurnId })
  }
  if (live === null || live.reason === 'unverified' || live.reason === 'write_failed') {
    journal('unknown')
    ledgerSteer('steer-unverified')
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

    // G2 authority Tier 1 (QA 6.99.29): only the server writes a verify footer. Words carrying
    // anything footer-shaped are refused where they were typed (this is also the steer's door).
    if (deps.provenance && hasFooterShapedLine(prompt)) {
      return res.status(400).json({ error: 'footer_line_refused', reasonCopy: FOOTER_LINE_REFUSED_COPY })
    }

    // 11/07 (Control Web attach): files with the words, as media-store ids. Absent is the old row, byte for byte.
    const attach = parseTurnAttachmentIds(body.attachmentIds)
    if (!attach.ok) return res.status(400).json({ error: 'invalid_request', reason: 'invalid_attachments' })

    // 6.78.0: `mode: 'steer'` asks for the running turn itself (COS_SESSION_STEER). Off, the
    // field is ignored exactly as a 6.77 server ignores it.
    const steerOn = sessionSteerEnabled()
    // A steer goes through the session's peer inbox, which carries words only: a turn with files always parks.
    const wantSteer = steerOn && body.mode === 'steer' && attach.ids.length === 0
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

    // G2 authority Tier 1 (6.99.29): who parked these words, judged on this request's own socket,
    // token and cookie. A turn id this server already holds a record for, for a different turn, is
    // never reused (QA 6.99.29: it would overwrite that record).
    let verdict = deps.provenance ? deps.provenance.originOf(req) : null
    if (deps.provenance && verdict && deps.provenance.reusesTurnId(clientTurnId, { prompt, verdict, provider, sessionId: threadId })) {
      return res.status(409).json({ error: 'turn_id_in_use', reasonCopy: TURN_ID_IN_USE_COPY })
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

    // 11/07: every file must be readable now, and is kept past the 4 hour staged TTL while the turn waits. A file
    // that is gone refuses the park here, where the words are still in the box, never later at the drain.
    if (attach.ids.length > 0) {
      const store = deps.turnAttachmentStore ?? defaultTurnAttachmentStore()
      const kept = await keepTurnAttachments(attach.ids, `session-turn:${clientTurnId}`, store)
      if (!kept.ok) return res.status(409).json({ error: kept.code, attachmentError: kept.code, reasonCopy: TURN_ATTACHMENT_COPY[kept.code] })
    }

    const now = deps.now()
    const queue = readQueue(provider, threadId, now)
    const turn: QueuedThreadTurn = {
      clientTurnId, cosSessionId, provider, threadId, prompt,
      queuedAt: now, status: 'waiting', attempts: 0,
      // 6.62.0 /qa (Q3): the acknowledgement travels with the row to its drain.
      ...(continueNoteAcknowledged(req.headers[CONTINUE_NOTE_HEADER]) ? { continueNoteAck: true as const } : {}),
      ...(attach.ids.length > 0 ? { attachmentIds: attach.ids } : {}),
    }

    // Held in memory with the words' hash, sealed to this provider, thread and these files (each id
    // with its content hash), so the drain can carry it (QUEUED_ORIGIN_TTL_MS at most).
    if (deps.provenance && verdict) {
      const sealed = await sealFiles(attach.ids, verdict, deps.turnAttachmentStore)
      // 6.99.31: a signed web turn is judged here, once parking is decided, against this provider and
      // thread (where it will drain), these exact words and these files. No envelope: unchanged.
      verdict = deps.provenance.acceptWebKey(sealed.verdict, { provider, sessionId: threadId, turnId: clientTurnId, words: prompt, attachments: sealed.manifest })
      deps.provenance.noteQueued(provider, threadId, clientTurnId, prompt, verdict, sealed.attachments)
    }

    let steerFallback: string | null = null
    if (wantSteer) {
      const availability = steerAvailabilityFor(deps, provider, threadId, gate.reason)
      if (availability.available) return steerTurn(req, res, deps, turn, queue, gate.reason, fallbackNone, verdict)
      if (fallbackNone) return res.status(409).json({ error: 'steer_unavailable', reason: availability.reason })
      steerFallback = availability.reason
    }

    const admitted = admitToQueue(queue, turn)
    if (!admitted.ok) {
      deps.provenance?.forgetQueued(provider, threadId, clientTurnId)
      return res.status(409).json({ error: admitted.reason })
    }

    writeQueue(provider, threadId, admitted.queue)
    if (deps.provenance && verdict) deps.provenance.record({ turnId: clientTurnId, prompt, verdict, provider, sessionId: threadId, via: 'queue' })
    // Steer mid-turn (COS_STEER_MIDTURN): the park answer stays the 202 every client reads (a
    // lens that sees anything else says "could not queue"); the drain is asked to run now, and it
    // puts the words into the running turn. `landsAt` (additive, only with the switch on) tells a
    // client which line to show: `next_step` only when this row is first in line, has no files,
    // and the session can take it now; `turn_end` otherwise.
    const midTurn = midTurnAvailabilityFor(deps, provider, threadId, gate.reason)
    let landsAt: 'next_step' | 'turn_end' | null = null
    if (midTurn) {
      const firstInLine = queuePosition(admitted.queue, clientTurnId) === 0 && !admitted.queue.some(t => t.status === 'delivering')
      landsAt = midTurn.available && firstInLine && attach.ids.length === 0 ? 'next_step' : 'turn_end'
      if (landsAt === 'next_step') {
        try { deps.kickDrain?.(threadId) } catch { /* the 20 s sweep still delivers it */ }
      }
    }
    return res.status(202).json({
      queued: true,
      clientTurnId,
      position: queuePosition(admitted.queue, clientTurnId),
      waitingOn: gate.reason,
      ...(steerFallback !== null ? { steerFallback } : {}),
      ...(landsAt !== null ? { landsAt } : {}),
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
  router.post('/agent-sessions/:provider/:threadId/queued-turns/:clientTurnId/resend', async (req: Request, res: Response, next) => {
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
    // G2 authority Tier 1 (QA 6.99.29): the copy's words go to a session, so they meet the footer
    // rule like any typed words, and its id may not be one this server already holds a record for.
    if (deps.provenance && hasFooterShapedLine(original.prompt)) {
      return res.status(400).json({ error: 'footer_line_refused', reasonCopy: FOOTER_LINE_REFUSED_COPY })
    }
    if (deps.provenance && deps.provenance.holds(newId)) return res.status(409).json({ error: 'turn_id_in_use', reasonCopy: TURN_ID_IN_USE_COPY })
    // Judged now, from THIS request (Codex re-audit of 910eb90, P1): never inherited from the row.
    const resendVerdict = deps.provenance ? deps.provenance.resendVerdict(req) : null
    // "May not have been sent": a second copy is possible, so the person has to have been told.
    if (original.deliveryState === 'unknown' && body.acknowledge !== 'may_duplicate') {
      return res.status(409).json({ error: 'acknowledge_required' })
    }
    const copy: QueuedThreadTurn = {
      clientTurnId: newId, cosSessionId, provider, threadId,
      prompt: original.prompt,
      queuedAt: now, status: 'waiting', attempts: 0,
      ...(original.continueNoteAck === true ? { continueNoteAck: true as const } : {}),
      // 11/07: Send again sends the same files; the turns route refuses it there if one has gone.
      ...(Array.isArray(original.attachmentIds) && original.attachmentIds.length > 0 ? { attachmentIds: [...original.attachmentIds] } : {}),
      resendOf: original.clientTurnId,
    }
    const admitted = admitToQueue(queue, copy)
    if (!admitted.ok) return res.status(409).json({ error: admitted.reason })
    original.resentAs = newId
    writeQueue(provider, threadId, admitted.queue)
    // G2 authority Tier 1 (Codex re-audit of 910eb90, P1): the row's words and files are mutable, so
    // the copy NEVER inherits the original row's authority (that let a local caller change a refused
    // G2 row and mint a new vouched turn from it). It carries the origin of the request that sent it
    // again: a verified glasses or phone client is vouched on its own socket and instance, like any
    // new turn; anyone else is recorded unvouched ('resend_not_reverified'), with no footer. The
    // original id is kept only as the record's `resendOf` annotation.
    if (deps.provenance && resendVerdict) {
      // After the write: the read-modify-write above stays one synchronous step. Sealed to the copy's files.
      const sealed = await sealFiles(copy.attachmentIds, resendVerdict, deps.turnAttachmentStore)
      // 6.99.31: Send again from the phone needs a fresh signature over the copy (its new id, the words,
      // the files); without one the copy stays unvouched ('resend_not_reverified').
      const copyVerdict = deps.provenance.acceptWebKey(sealed.verdict, { provider, sessionId: threadId, turnId: newId, words: copy.prompt, attachments: sealed.manifest })
      deps.provenance.noteQueued(provider, threadId, newId, copy.prompt, copyVerdict, sealed.attachments)
      deps.provenance.record({ turnId: newId, prompt: copy.prompt, verdict: copyVerdict, provider, sessionId: threadId, via: 'queue-resend', resendOf: original.clientTurnId })
    }
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
          // G2 authority Tier 1: the lens and the web show (and edit) the words, never the verify footer.
          const plain = plainQueueText(row)
          const text = plain === null ? null : stripG2TurnFooter(plain).text
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
    // G2 authority Tier 1 (QA 6.99.29): an edit is typed words like any other.
    if (deps.provenance && hasFooterShapedLine(prompt)) {
      return res.status(400).json({ error: 'footer_line_refused', reasonCopy: FOOTER_LINE_REFUSED_COPY })
    }
    if (provider === 'codex' && id.startsWith('codex-native:')) {
      try {
        // G2 authority Tier 1: the edit replaces the text in the Codex app's own queue, so it is a
        // delivery of its own, under an id minted here (the native row id is not ours).
        let sent = prompt
        if (deps.provenance) {
          const verdict = deps.provenance.originOf(req)
          const editId = `cnedit-${randomBytes(12).toString('hex')}`
          sent = deps.provenance.footed(prompt, editId, verdict, provider)
          deps.provenance.record({ turnId: editId, prompt, verdict, provider, sessionId: threadId, via: 'codex-native-edit' })
        }
        await (deps.nativeQueue ?? nativeQueueControl).update(threadId, id.slice(13), sent)
        return res.json({ updated: true })
      } catch { return res.status(409).json({ error: 'queue_edit_unconfirmed' }) }
    }
    const queue = readQueue(provider, threadId, deps.now())
    const row = queue.find(t => t.clientTurnId === id)
    if (!row || row.status !== 'waiting') return res.status(409).json({ error: 'already_delivering' })
    // The words are now whoever edited them: their origin replaces the parked one. Only over a record
    // that is still parked (QA 6.99.29): a row written into the queue file under a delivered turn's id
    // cannot be edited over that turn's record.
    const verdict = deps.provenance ? deps.provenance.originOf(req) : null
    if (deps.provenance && verdict && deps.provenance.reusesTurnId(id, { prompt, verdict, provider, sessionId: threadId }, { continues: true })) {
      return res.status(409).json({ error: 'turn_id_in_use', reasonCopy: TURN_ID_IN_USE_COPY })
    }
    row.prompt = prompt
    writeQueue(provider, threadId, queue)
    if (deps.provenance && verdict) {
      // Sealed to the row's files as they are now (an edit changes only the words).
      const sealed = await sealFiles(row.attachmentIds, verdict, deps.turnAttachmentStore)
      // 6.99.31: an edit needs a fresh signature over the new words (same id, same files), or it is unvouched.
      const editVerdict = deps.provenance.acceptWebKey(sealed.verdict, { provider, sessionId: threadId, turnId: id, words: prompt, attachments: sealed.manifest })
      deps.provenance.noteQueued(provider, threadId, id, prompt, editVerdict, sealed.attachments)
      // The queue's own row, re-judged: it continues the record parked under this id.
      deps.provenance.record({ turnId: id, prompt, verdict: editVerdict, provider, sessionId: threadId, via: 'queue-edit', continues: true })
    }
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
      deps.provenance?.forgetQueued(provider, threadId, clientTurnId)
    }
    return res.json({ cancelled: true, clientTurnId, status: row.status })
  })

  return router
}
