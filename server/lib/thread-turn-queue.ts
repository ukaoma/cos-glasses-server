// A turn spoken at a thread that is busy right now, held until it is not.
//
// ---------------------------------------------------------------------------
// WHY
// ---------------------------------------------------------------------------
// Miles, 2026-08-17, looking at a thread he could not continue: "This thread, the
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
// THE WATERMARK EXEMPTION -- Miles approved this explicitly
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
// Miles, asked directly before this was built: "Yeah, this is a fine exemption."
//
// ---------------------------------------------------------------------------
// WHAT MAKES A TURN READY, AND WHY NOT "IDLE"
// ---------------------------------------------------------------------------
// Thirty seconds of transcript silence is the wrong trigger on its own: a long tool
// call goes quiet mid-turn, and draining there would inject a message into the middle
// of someone's reasoning. The precise signal is the turn ENDING, which is observable in
// the transcript itself -- Claude writes a `result` record, Codex a `task_complete` /
// `turn_complete`. The idle clock stays as a BACKSTOP for a holder that dies or a
// provider that writes no terminal record, so a queue cannot wedge forever on a missing
// event. Same reasoning as the session-trail handoff, one layer down.

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
}

/**
 * How long a waiting turn stays valid.
 *
 * Six hours, not indefinite. A turn is a thing someone SAID, and saying it into a
 * thread twelve hours later is not what they meant -- the context they were replying to
 * is gone. Expiry is reported, never silent.
 */
export const QUEUED_TURN_TTL_MS = 6 * 60 * 60 * 1000

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
  'live_desktop_process',
  'thread_busy',
  'binding_conflict',
  'detector_unavailable',
  'registry_unreadable',
  'unverifiable_process_start',
  'unverifiable_liveness_socket',
  'probe_failed',
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
  if (now - turn.queuedAt >= ttlMs) return 'expire'
  if (turn.attempts >= MAX_DELIVERY_ATTEMPTS) return 'give_up'
  // THE GATE, unweakened. Everything below is about WHEN, never about whether.
  if (!seen.attachable) return 'hold'
  // Turn-ended is the precise signal; idle is the backstop for a holder that wrote no
  // terminal record. `working` holds even when attachable, because attachable only says
  // no one else owns it -- it does not say a turn is not mid-flight.
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
  return queue.filter(t => {
    if (t.status === 'waiting' || t.status === 'delivering') return true
    const settled = typeof t.settledAt === 'number' ? t.settledAt : t.queuedAt
    return now - settled < settledRetentionMs
  })
}

/** Where a waiting turn sits, for the phone's row copy. `0` when it is next. */
export function queuePosition(queue: readonly QueuedThreadTurn[], clientTurnId: string): number {
  return queue.filter(t => t.status === 'waiting').findIndex(t => t.clientTurnId === clientTurnId)
}
