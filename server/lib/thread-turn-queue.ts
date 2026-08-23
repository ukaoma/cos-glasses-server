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
  /** The gate's reason when `attachable` is false. Carried ONLY so a fence -- the one
   *  hold a clock cannot end -- can be given a longer life than a busy thread. */
  reason?: string | null
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
