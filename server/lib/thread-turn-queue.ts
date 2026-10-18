// A turn spoken at a thread that is busy right now, held until it is not.
//
// ---------------------------------------------------------------------------
// WHY
// ---------------------------------------------------------------------------
// the user, 2026-08-17, looking at a thread he could not continue: "This thread, the
// COS-glasses server, has actually completed, but it's still locked. Ideally, what would
// happen is if there's a session that's still running, that would just put it into the
// queue the same way that the user has the ability to do so." His example was his own
// desktop: he typed into a running turn and Claude Code queued it, pending, with a
// cancel control.
//
// The thread was not stuck. Measured at the moment he asked: transcript mtime 3s old
// against a 30s window, so `holderActivity` was `working` -- correctly, because a COS
// session was writing to it. That is the trap: while you are talking to an agent in a
// thread, that thread is CONTINUOUSLY working, so Continue is unreachable for exactly
// the thread you most want to continue, and Fork is the only door.
//
// ---------------------------------------------------------------------------
// THIS DOES NOT WEAKEN THE ATTACH GATE, AND THAT IS THE WHOLE DESIGN
// ---------------------------------------------------------------------------
// The gate refuses to WRITE into a thread another process holds. A queue does not
// bypass it -- it defers to it. Nothing here decides a turn may be delivered; delivery
// re-runs the full occupancy check at drain time and can still refuse. So parking is
// safe by construction, and the only reasons that should still refuse outright are the
// ones that can NEVER clear.
//
// That is the split `queueableRefusal` encodes: an occupancy reason describes a
// condition that may pass, a structural reason describes a thread that will never be
// continuable no matter how long anyone waits. Telling someone their turn is queued
// when it can never run is worse than refusing.
//
// ---------------------------------------------------------------------------
// THE WATERMARK EXEMPTION -- the user approved this explicitly
// ---------------------------------------------------------------------------
// A binding carries a content watermark, and a write is refused with
// `native_thread_changed` when the thread's head digest moved since the turn was
// composed. A queued turn drains AFTER more has been written, by definition -- that is
// what it was waiting for -- so the watermark has ALWAYS moved by then. Checked as
// normal, a queue would fail 100% of the time.
//
// So a drained turn re-baselines the watermark at delivery. This is a deliberate,
// scoped exemption, and its justification is the user's intent: queueing means "append
// this to whatever the thread is when it frees", which is exactly what the desktop
// queue does. It is NOT a general relaxation -- an interactive turn still gets the full
// divergence check, because there the user composed against a state they were looking
// at and a silent change is genuinely surprising.
//
// the user, asked directly before this was built: "Yeah, this is a fine exemption."
//
// ---------------------------------------------------------------------------
// WHAT MAKES A TURN READY, AND WHY NOT "IDLE"
// ---------------------------------------------------------------------------
// Thirty seconds of transcript silence is the wrong trigger on its own: a long tool
// call goes quiet mid-turn, and draining there would inject a message into the middle
// of someone's reasoning. The precise signal is the turn ENDING. For Claude that is the
// engine's own Stop hook followed by the registry flipping `idle` (6.48.1; a Desktop
// transcript carries no `result` record, and the Stop alone is 12-38 s early while the
// Stop hooks run), else the transcript's newest assistant record with a terminal
// `stop_reason` and no pending tool (`turnFromTail`); Codex writes `task_complete` /
// `turn_complete`. The idle clock stays as a BACKSTOP for a holder that dies or a
// provider that writes no terminal record, so a queue cannot wedge forever on a missing
// event, and positive evidence of an OPEN turn outranks it. Same reasoning as the
// session-trail handoff, one layer down.

import { readSwitch } from './env-switch.js'

/** Terminal-ish states a queued turn can reach. `waiting` is the only live one. */
export type QueuedTurnStatus =
  | 'waiting'
  | 'delivering'
  | 'delivered'
  | 'refused'
  | 'expired'
  | 'cancelled'

export interface QueuedThreadTurn {
  /** Idempotency key, poll key, and row identity -- the same one the phone's pending
   *  ledger already tracks, so a queued turn needs no new client vocabulary. */
  clientTurnId: string
  cosSessionId: string
  provider: string
  threadId: string
  prompt: string
  queuedAt: number
  status: QueuedTurnStatus
  /** Delivery attempts made. Bounded so a permanently-refusing target cannot spin. */
  attempts: number
  /** The SERVER's reason for a terminal outcome. Never the client's wording. */
  reason?: string
  settledAt?: number
  /**
   * 6.62.0 /qa (Q3): the client that parked this turn sent `X-COS-Continue-Note: 1` (it shows
   * `continue_note`). The drain repeats the header, so a Cursor CLI chat runs Run Everything
   * only for a client that said it would show it. Absent: the 6.61 Ask posture.
   */
  continueNoteAck?: true
  // ---------------------------------------------------------------- 6.78.0 (P3)
  // Every field below is OPTIONAL and written only while its flag is on, so with
  // COS_QUEUE_RECONCILE, COS_QUEUE_RESEND and COS_SESSION_STEER all off a queue file is
  // byte-for-byte what 6.77.0 writes. A 6.77 server reading a 6.78 file ignores them.
  /**
   * Stamped (`1`) when this row entered `delivering` under the attempt journal (6.78.0).
   * Its ABSENCE on a `delivering` row is the whole point: a row with no stamp was written by
   * a build that kept no attempt record, so "no attempt on file" proves nothing about it and
   * the reconcile reads it as unknown, never as unsent.
   */
  journal?: 1
  /** The server boot that moved this row to `delivering`. A different boot means it was cut off. */
  deliveringBootId?: string
  /** `unknown`: COS cannot establish whether the words reached the session. Never resent. */
  deliveryState?: 'unknown'
  /** `steer`: sent into the running turn through the session's peer inbox. Absent: `queue`. */
  mode?: 'steer'
  /** Send again: the row this one was copied from. */
  resendOf?: string
  /** Send again: the row that was copied from this one. Set once, and only once. */
  resentAs?: string
}

// ------------------------------------------------------------------- 6.78.0 flags
//
// Read at CALL time through the one 6.78.0 switch reader (lib/env-switch.ts): `1`, `true`
// or `on` is on, `0`, `false` or `off` is off, anything else is the default (P7 S3: an exact
// `0`/`1` reader here made `COS_QUEUE_RECONCILE=false` read ON). One reader per flag, so
// every caller (routes, registry, drain, health) decides with the same answer in the same tick.
function triStateFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  return readSwitch(env[name], fallback)
}

/** `COS_QUEUE_RECONCILE`: the attempt journal, the restart reconcile, receipts, unknown-row retention and reason copy. Default ON. */
export function queueReconcileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return triStateFlag(env, 'COS_QUEUE_RECONCILE', true)
}

/** `COS_PIN_BOOT_REAP`: release a pin a dead boot left, once its orphan child must be gone (21 min). Default ON. */
export function pinBootReapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return triStateFlag(env, 'COS_PIN_BOOT_REAP', true)
}

/** `COS_QUEUE_RESEND`: Send again on a refused or expired row. Default ON. */
export function queueResendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return triStateFlag(env, 'COS_QUEUE_RESEND', true)
}

/** `COS_SESSION_STEER`: steer a busy Claude session through its peer inbox. Default OFF. */
export function sessionSteerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return triStateFlag(env, 'COS_SESSION_STEER', false)
}

/**
 * Reasons whose outcome COS cannot establish. Such a row is never resent and is kept for
 * UNKNOWN_DELIVERY_RETENTION_MS rather than 30 minutes, because the phone has to be able to
 * read "may not have been sent" for as long as the person might come back to it.
 */
export const UNKNOWN_DELIVERY_REASONS: ReadonlySet<string> = new Set([
  'delivery_unknown_after_restart',
  'steer_unverified',
  'delivery_ambiguous',
])

/** How long a settled row with an unknown outcome stays readable. */
export const UNKNOWN_DELIVERY_RETENTION_MS = 6 * 60 * 60 * 1000

/** The lens body is 62 columns; every reason line fits one. */
export const QUEUED_TURN_REASON_COPY_MAX = 62

/** One line per reason, server-authored. Keys are the reasons a row can carry. */
const QUEUED_TURN_REASON_COPY: Readonly<Record<string, string>> = {
  delivery_unknown_after_restart: 'May not have been sent. Read it, then say it again.',
  steer_unverified: 'May not have been sent. Read it, then say it again.',
  delivery_ambiguous: 'May not have been sent. Read it, then say it again.',
  steered: 'Sent into the running turn.',
  reconciled_after_restart: 'Sent before the server restarted.',
  requeued_after_restart: 'Not sent before the restart. Waiting to send.',
  queued_turn_expired: 'Not sent: the thread stayed busy too long.',
  delivery_attempts_exhausted: 'Not sent: the session refused it five times.',
  turn_cancelled: 'Cancelled before it was sent.',
  steer_not_sent: 'Not sent: the session could not take it mid-turn.',
  native_thread_working: 'Waiting for the current turn to end.',
  live_desktop_process: 'Waiting for the current turn to end.',
  native_target_busy: 'Waiting: another COS turn holds this thread.',
  native_turn_in_progress: 'Waiting: a COS turn is running on this thread.',
  native_target_fenced: 'Waiting: an earlier turn needs a check on your Mac.',
}

/**
 * The reason line for a queue row, or null when there is nothing to say (no reason, or one
 * this build has no words for: a raw code is never shown as if it were a sentence).
 */
export function queuedTurnReasonCopy(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string' || reason.length === 0) return null
  return Object.prototype.hasOwnProperty.call(QUEUED_TURN_REASON_COPY, reason) ? QUEUED_TURN_REASON_COPY[reason] : null
}

/** Every reason with copy, for the column test. */
export function queuedTurnReasonCopyKeys(): string[] {
  return Object.keys(QUEUED_TURN_REASON_COPY)
}

/**
 * How long a waiting turn stays valid.
 *
 * Six hours, not indefinite. A turn is a thing someone SAID, and saying it into a
 * thread twelve hours later is not what they meant -- the context they were replying to
 * is gone. Expiry is reported, never silent.
 */
export const QUEUED_TURN_TTL_MS = 6 * 60 * 60 * 1000

/**
 * TTL for a turn held by a FENCE specifically.
 *
 * Six hours is right for a busy thread: the holder finishes or it never will. A
 * fence is different in kind -- it ends when a PERSON looks, and the only fence this
 * system has ever produced sat for about 40 hours before anyone could clear it,
 * because clearing it needed a terminal. Expiring at six would have thrown the turn
 * away roughly seven times over while the user was still waiting for a working
 * Release button.
 *
 * It still expires. A turn that outlives this is one nobody is coming back for, and
 * silently holding it forever is worse than telling the truth about losing it.
 */
export const FENCE_HELD_TURN_TTL_MS = 72 * 60 * 60 * 1000

/** Waiting turns per thread. Small: this is a queue, not a backlog. */
export const MAX_QUEUED_PER_THREAD = 8

/**
 * Delivery attempts before a turn is given up on.
 *
 * A drain that keeps failing is not going to start working, and a queue that retries
 * forever is a write loop against someone else's session.
 */
export const MAX_DELIVERY_ATTEMPTS = 5

/**
 * Occupancy reasons a turn may WAIT on, versus ones that must refuse now.
 *
 * The distinction is whether the condition can ever pass. `native_thread_working` is
 * the common one and obviously transient. The `unknown`-shaped reasons are included
 * deliberately: they mean the scan could not SEE, which is a refusal for a write but
 * not a reason to discard something the user said -- and delivery re-runs the gate, so
 * a queue on an unmeasurable thread simply never drains and expires honestly.
 *
 * Everything absent from this set is STRUCTURAL: a provider COS cannot continue, a
 * malformed id, or the write feature being switched off. None of those pass with time,
 * and queueing against them would be a lie told politely.
 */
const QUEUEABLE_REFUSALS: ReadonlySet<string> = new Set([
  'native_thread_working',
  // COS'S OWN LEFTOVER BINDING, and the reason this feature did not work for a day.
  // Proven from device diagnostics 2026-08-17: every Continue that reached the server
  // was refused `native_target_busy` ("already attached to another COS chat"), never
  // `native_thread_working`. Selecting Continue SUCCEEDS and mints a binding; if the
  // dictation is not completed the binding lingers to its TTL, and every Continue in
  // that window refuses. Twelve such bindings had stacked up on one thread.
  //
  // It belongs here because it is transient BY CONSTRUCTION -- the binding expires on
  // a clock -- and because it is COS's own bookkeeping, not a foreign process holding
  // the thread. Queueing waits it out, and delivery re-runs the whole gate as always.
  'native_target_busy',
  // Same shape: a COS turn is mid-flight on this thread and will finish.
  'native_turn_in_progress',
  'live_desktop_process',
  'thread_busy',
  'binding_conflict',
  'detector_unavailable',
  'registry_unreadable',
  'unverifiable_process_start',
  'unverifiable_liveness_socket',
  'probe_failed',
  // A FENCE IS CLEARED BY A PERSON, NOT BY A CLOCK -- the one exception in this set.
  //
  // It is queueable because "COS sent a turn and never learned whether it arrived"
  // is precisely the state a queued turn should outlive: the operator checks, releases,
  // and the turn lands. Releasing kicks the drain, so the wait ends on a real event.
  //
  // It is ALSO why the fence had to become visible to `occupancy` (index.ts). Without
  // that, a fenced target reads attachable, the drainer ATTEMPTS, the attach route
  // refuses, and five of those retire the turn in about two minutes -- the identical
  // failure the binding comment above records, and it would have made queue-and-release
  // look like it worked while silently dropping the turn.
  'native_target_fenced',
])

/** Can a turn refused for this reason be parked, or must it refuse now? */
export function queueableRefusal(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && QUEUEABLE_REFUSALS.has(reason)
}

/** What the drainer observed about the thread this tick. */
export interface DrainObservation {
  /** The full occupancy gate re-run. Delivery NEVER happens on a false. */
  attachable: boolean
  /**
   * Did the holder's last transcript record end a turn (`result`, `turn_complete`)?
   * The precise signal, when the provider writes one.
   */
  turnEnded: boolean
  /** The 30s transcript clock. `idle` is the backstop when no terminal record lands. */
  activity: 'working' | 'idle' | 'unknown'
  /**
   * 6.48.1: POSITIVE evidence the turn is still open (a tool_use awaiting its result, a
   * prompt newer than the last reply, or the hooks saying the turn has not stopped),
   * bounded by the caller to a recent window. It outranks the idle backstop: a 40 s tool
   * leaves the transcript untouched for 40 s, and "idle for 30 s" used to deliver a
   * follow-up straight into that live turn (measured 2026-09-15 on the 6.48.1 live proof).
   */
  turnOpen?: boolean
  /** The gate's reason when `attachable` is false. Carried ONLY so a fence -- the one
   *  hold a clock cannot end -- can be given a longer life than a busy thread. */
  reason?: string | null
  /**
   * 6.53.0: until when a cancel on this thread holds its parked turns (epoch ms), or
   * null. The person just said stop; a follow-up parked behind the run must not start it
   * again a second later. It holds, then sends as normal (CANCEL_QUEUE_HOLD_MS, 2 min).
   */
  cancelHoldUntil?: number | null
}

export type DrainDecision = 'deliver' | 'hold' | 'expire' | 'give_up'

/**
 * Should this waiting turn go now?
 *
 * PURE, and every branch resolves. Order matters: expiry and the attempt ceiling are
 * checked BEFORE readiness, so a turn that has run out of time or tries cannot be
 * delivered by a lucky tick.
 */
export function drainDecision(
  turn: Pick<QueuedThreadTurn, 'status' | 'queuedAt' | 'attempts'>,
  seen: DrainObservation,
  now: number,
  ttlMs: number = QUEUED_TURN_TTL_MS,
): DrainDecision {
  if (turn.status !== 'waiting') return 'hold'
  if (!Number.isFinite(now) || !Number.isFinite(turn.queuedAt)) return 'hold'
  // A fence is cleared by a person, so it gets the longer clock. Everything else --
  // including a fence we could not name -- keeps the ordinary one.
  const effectiveTtl = seen.reason === 'native_target_fenced' ? FENCE_HELD_TURN_TTL_MS : ttlMs
  if (now - turn.queuedAt >= effectiveTtl) return 'expire'
  if (turn.attempts >= MAX_DELIVERY_ATTEMPTS) return 'give_up'
  // 6.53.0: AFTER the two retirements, so a hold can never keep alive a turn that ran out
  // of time or tries; BEFORE the gate, because it is a hold whatever the gate says.
  if (typeof seen.cancelHoldUntil === 'number' && Number.isFinite(seen.cancelHoldUntil) && now < seen.cancelHoldUntil) return 'hold'
  // THE GATE, unweakened. Everything below is about WHEN, never about whether.
  if (!seen.attachable) return 'hold'
  // Turn-ended is the precise signal; idle is the backstop for a holder that wrote no
  // terminal record. `working` holds even when attachable, because attachable only says
  // no one else owns it -- it does not say a turn is not mid-flight.
  // Positive evidence the turn is OPEN outranks a terminal record older than it: a prompt
  // queued at the desk during the Stop hooks dequeues after them, and the tail's newest
  // terminal record cannot see it (QA, 2026-09-15).
  if (seen.turnOpen === true) return 'hold'
  if (seen.turnEnded) return 'deliver'
  return seen.activity === 'idle' ? 'deliver' : 'hold'
}

/**
 * Admit a turn to the queue, or say why not.
 *
 * Rejects a duplicate `clientTurnId` rather than parking a second copy: the id is an
 * idempotency key, and a phone that retries after a dropped response must not put the
 * same sentence into a real conversation twice.
 */
export function admitToQueue(
  existing: readonly QueuedThreadTurn[],
  turn: QueuedThreadTurn,
): { ok: true; queue: QueuedThreadTurn[] } | { ok: false; reason: string } {
  if (!turn.clientTurnId || !turn.prompt.trim()) return { ok: false, reason: 'invalid_request' }
  if (existing.some(t => t.clientTurnId === turn.clientTurnId)) {
    return { ok: false, reason: 'duplicate_turn' }
  }
  const waiting = existing.filter(t => t.status === 'waiting')
  if (waiting.length >= MAX_QUEUED_PER_THREAD) return { ok: false, reason: 'queue_full' }
  return { ok: true, queue: [...existing, turn] }
}

/**
 * Drop rows nobody needs any more.
 *
 * Settled rows are kept briefly so the phone's poll can still see the outcome -- a row
 * that vanishes reads as "lost", which is the one answer a pending ledger must never
 * give. Waiting rows are never pruned here; only `drainDecision` retires those, so
 * there is exactly one place a live turn can die.
 */
export function pruneQueue(
  queue: readonly QueuedThreadTurn[],
  now: number,
  settledRetentionMs: number = 30 * 60 * 1000,
): QueuedThreadTurn[] {
  // 6.78.0: a row whose outcome is unknown stays for six hours (COS_QUEUE_RECONCILE). Read
  // once per prune, so one pass cannot keep some rows by the new rule and drop others by the old.
  const keepUnknown = queueReconcileEnabled()
  return queue.filter(t => {
    if (t.status === 'waiting' || t.status === 'delivering') return true
    const settled = typeof t.settledAt === 'number' ? t.settledAt : t.queuedAt
    const unknown = keepUnknown && (t.deliveryState === 'unknown' || (typeof t.reason === 'string' && UNKNOWN_DELIVERY_REASONS.has(t.reason)))
    return now - settled < (unknown ? Math.max(settledRetentionMs, UNKNOWN_DELIVERY_RETENTION_MS) : settledRetentionMs)
  })
}

/** Where a waiting turn sits, for the phone's row copy. `0` when it is next. */
export function queuePosition(queue: readonly QueuedThreadTurn[], clientTurnId: string): number {
  return queue.filter(t => t.status === 'waiting').findIndex(t => t.clientTurnId === clientTurnId)
}

// ------------------------------------------------------------- 6.78.0 session steer

/** Why a busy session cannot take a steer right now (the wire enum, plan v3.1 section 5.3). */
export type SessionSteerUnavailable = 'no_outside_channel' | 'engine_limit' | 'permission_pending'

export type SessionSteerAvailability =
  | { available: true; mode: 'peer_inbox' }
  | { available: false; reason: SessionSteerUnavailable }

/** Occupancy reasons that mean "a session outside COS is running this thread". Only those can be steered. */
const STEERABLE_GATE_REASONS: ReadonlySet<string> = new Set(['native_thread_working', 'live_desktop_process'])

/**
 * Can a turn go INTO the running turn of this thread now (6.78.0, COS_SESSION_STEER)?
 *
 * PURE, one rule for the attach refusal's `steer` field and the queued-turns POST, so the
 * row the lens offers and the answer to the tap agree.
 *   cursor                      engine_limit: the Stop hook is its only door
 *   codex                       no_outside_channel: `turn/steer` lives in an app-server COS does not hold
 *   claude, live hop off        no_outside_channel (`COS_CONTINUE_LIVE=0`)
 *   claude, not a desk run      no_outside_channel: COS's own binding or turn, a fence, or a
 *                               thread nobody could measure; nothing outside COS to fold into
 *   claude, no peer inbox       no_outside_channel
 *   claude, held on a prompt    permission_pending: a session waiting on a dialog reaches no
 *                               tool boundary, and the steer verify window (4 s) is far shorter
 *                               than the hook's wait (630 s); it is queued for the turn's end
 */
export function sessionSteerAvailability(input: {
  provider: string
  gateReason: string | null
  continueLive: boolean
  peerInbox: boolean
  waitingOnPrompt: boolean
}): SessionSteerAvailability {
  if (input.provider === 'cursor') return { available: false, reason: 'engine_limit' }
  if (input.provider !== 'claude') return { available: false, reason: 'no_outside_channel' }
  if (!input.continueLive) return { available: false, reason: 'no_outside_channel' }
  if (typeof input.gateReason !== 'string' || !STEERABLE_GATE_REASONS.has(input.gateReason)) return { available: false, reason: 'no_outside_channel' }
  if (!input.peerInbox) return { available: false, reason: 'no_outside_channel' }
  if (input.waitingOnPrompt) return { available: false, reason: 'permission_pending' }
  return { available: true, mode: 'peer_inbox' }
}
