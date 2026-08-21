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
import {
  admitToQueue, drainDecision, queueableRefusal, queuePosition,
  MAX_DELIVERY_ATTEMPTS, type DrainObservation, type QueuedThreadTurn,
} from '../lib/thread-turn-queue.js'
import { readQueue, writeQueue, queuedThreadKeys } from '../lib/thread-turn-queue-store.js'

export interface ThreadTurnQueueDeps {
  /** Re-runs the FULL occupancy gate. The drainer never decides attachability itself. */
  occupancy: (provider: string, threadId: string) => { attachable: boolean; reason: string | null }
  /** Did the holder's last transcript record end a turn? */
  turnEnded: (provider: string, threadId: string) => boolean
  /** The 30s transcript clock, as a backstop. */
  activity: (provider: string, threadId: string) => 'working' | 'idle' | 'unknown'
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
  }>
  now: () => number
}

/** Public shape of a queued turn. No prompt echo beyond a short preview. */
function publicRow(turn: QueuedThreadTurn, position: number): Record<string, unknown> {
  return {
    clientTurnId: turn.clientTurnId,
    status: turn.status,
    queuedAt: turn.queuedAt,
    attempts: turn.attempts,
    position: turn.status === 'waiting' ? position : -1,
    preview: turn.prompt.length > 80 ? `${turn.prompt.slice(0, 79)}…` : turn.prompt,
    ...(turn.reason ? { reason: turn.reason } : {}),
    ...(turn.settledAt ? { settledAt: turn.settledAt } : {}),
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
  const now = deps.now()
  const queue = readQueue(provider, threadId, now)
  if (queue.length === 0) return { delivered: 0, held: 0, retired: 0 }

  let delivered = 0, held = 0, retired = 0
  let dirty = false

  for (const turn of queue) {
    if (turn.status !== 'waiting') continue

    // Observed FRESH for each turn: delivering one makes the thread busy again, so a
    // verdict from the top of the loop would be stale by the second item.
    const gate = deps.occupancy(provider, threadId)
    const seen: DrainObservation = {
      attachable: gate.attachable,
      turnEnded: deps.turnEnded(provider, threadId),
      activity: deps.activity(provider, threadId),
    }
    const decision = drainDecision(turn, seen, deps.now())

    if (decision === 'hold') { held += 1; continue }
    if (decision === 'expire' || decision === 'give_up') {
      turn.status = decision === 'expire' ? 'expired' : 'refused'
      turn.reason = decision === 'expire' ? 'queued_turn_expired' : 'delivery_attempts_exhausted'
      turn.settledAt = deps.now()
      retired += 1; dirty = true
      continue
    }

    // ATTEMPT IS RECORDED BEFORE THE CALL, and persisted. A delivery that crashes the
    // process mid-flight must not come back with its attempt count unchanged and try
    // forever; the ceiling only bounds anything if it survives the crash it is bounding.
    turn.attempts += 1
    turn.status = 'delivering'
    writeQueue(provider, threadId, queue)
    dirty = true

    let outcome: { ok: boolean; reason?: string; serverRetryable?: boolean }
    try {
      outcome = await deps.deliver(turn)
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : 'deliver_threw' }
    }

    if (outcome.ok) {
      turn.status = 'delivered'
      turn.settledAt = deps.now()
      delivered += 1
    } else if (isRetryableDelivery(outcome)) {
      // A GATE REFUSAL IS NOT A FAILED DELIVERY, so it must not spend the ceiling --
      // measured cost of getting this wrong: three of Miles's turns retired in about
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
  }

  if (dirty) writeQueue(provider, threadId, queue)
  return { delivered, held, retired }
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

export function createThreadTurnQueueRouter(deps: ThreadTurnQueueDeps): Router {
  const router = Router()

  // POST — park a turn for a thread that is busy right now.
  router.post('/agent-sessions/:provider/:threadId/queued-turns', (req: Request, res: Response) => {
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

    if (provider === 'cursor') {
      return res.status(423).json({ error: 'unsupported_provider', queueable: false })
    }

    // THE GATE DECIDES WHETHER PARKING IS EVEN HONEST. A structural refusal can never
    // clear, and telling someone their turn is queued when it can never run is worse
    // than refusing it. An attachable thread is not queued either -- it is sent now,
    // through the ordinary route, which the client does on this 409.
    const gate = deps.occupancy(provider, threadId)
    if (gate.attachable) return res.status(409).json({ error: 'thread_free', hint: 'send_now' })
    if (!queueableRefusal(gate.reason)) {
      return res.status(423).json({ error: gate.reason ?? 'probe_failed', queueable: false })
    }

    const now = deps.now()
    const queue = readQueue(provider, threadId, now)
    const admitted = admitToQueue(queue, {
      clientTurnId, cosSessionId, provider, threadId, prompt,
      queuedAt: now, status: 'waiting', attempts: 0,
    })
    if (!admitted.ok) return res.status(409).json({ error: admitted.reason })

    writeQueue(provider, threadId, admitted.queue)
    return res.status(202).json({
      queued: true,
      clientTurnId,
      position: queuePosition(admitted.queue, clientTurnId),
      waitingOn: gate.reason,
    })
  })

  // GET — what is waiting, for the pending row on the lens.
  router.get('/agent-sessions/:provider/:threadId/queued-turns', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const provider = String(req.params.provider ?? '')
    const threadId = String(req.params.threadId ?? '')
    const queue = readQueue(provider, threadId, deps.now())
    return res.json({ turns: queue.map(t => publicRow(t, queuePosition(queue, t.clientTurnId))) })
  })

  // DELETE — the cancel control, the same affordance the desktop queue offers.
  router.delete('/agent-sessions/:provider/:threadId/queued-turns/:clientTurnId', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const provider = String(req.params.provider ?? '')
    const threadId = String(req.params.threadId ?? '')
    const clientTurnId = String(req.params.clientTurnId ?? '')
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
