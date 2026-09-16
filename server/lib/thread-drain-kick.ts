// The Stop-driven drain kick (6.48.1).
//
// Before this, a queued follow-up waited for the 20 s sweep AND the holder's 30 s idle
// window: measured 35 s or more from the turn's end to delivery. The hooks now say the
// exact moment a turn ends (Stop), so the queue is drained THEN.
//
// ONE DRAIN IN FLIGHT, EXACTLY ONE FOLLOW-UP. The 20 s timer and the Stop kick share
// this guard, so a Stop landing during a sweep cannot start a second sweep that reads
// the same queue file and delivers the same sentence twice; it schedules one more pass
// after the current one, and a burst of Stops collapses into that one pass.
//
// A kick is spent only when a queue file exists for that session: a Stop on a session
// nobody queued for costs a directory listing and nothing else. The match is the full
// session id: a Claude queue file is always keyed by the full UUID, because the attach
// gate refuses anything else as `invalid_thread_id` before a turn can be queued, and
// every hook envelope carries the full id (QA, 2026-09-15: the 8-character branch this
// used to carry was unreachable).
//
// The sweep itself runs on the NEXT macrotask, never inside the caller: a kick arrives
// from the signal store inside the spool sweep, and the drain's synchronous head (a
// registry scan, a `ps` per owner, a tail read) belongs after that sweep and after the
// stream listeners for the same Stop have written their line.

export interface DrainKickDeps {
  /** The sweep. Resolves the number delivered; rejects are swallowed here. */
  drain: () => Promise<number>
  /** Thread ids with a queue file right now, any provider. */
  queuedThreadIds: () => string[]
}

export interface DrainKick {
  /** Run the sweep, or fold into the one in flight. Resolves when THIS request's pass has run. */
  sweep(): Promise<void>
  /** A session's turn ended: sweep (next macrotask) if a queue names it. Returns true when a sweep was requested. */
  kick(sessionId: string): boolean
  /**
   * Kick once `ready()` answers true, polling every `everyMs` for up to `maxMs`; a kick
   * at Stop time is too early when the engine closes the turn only after its Stop hooks
   * (12-38 s on the release Mac), and nothing fires a hook when they return. Returns
   * false at once when no queue names the session, so an unqueued Stop costs nothing.
   */
  kickWhen(sessionId: string, ready: () => boolean, opts?: { everyMs?: number; maxMs?: number }): boolean
  /** For health: passes run, kicks spent, kicks folded into a running pass, waits open. */
  stats(): { passes: number; kicks: number; folded: number; inFlight: boolean; waiting: number }
}

export const KICK_POLL_MS = 1_000
export const KICK_WAIT_MAX_MS = 60_000

/** The facts the kick plan reads off a session signal after one hook event. */
export interface KickSignalFacts {
  turnOpen: boolean
  subagentsOpen: number
  ended: unknown
  stopAt: number | null
}

/** What one hook event asks of the kick: nothing, a kick now, or a kick once the registry says idle after `stopAt`. */
export type KickPlan = { kind: 'kick' } | { kind: 'kick_when_registry_idle'; stopAt: number } | null

/**
 * The composition root's rule, pure so it is pinned (QA N1, 2026-09-15):
 *
 *  - a COS child's own SessionEnd frees the thread for the NEXT queued turn at once
 *    (without it a chained follow-up waited for the 20 s timer); nothing else a child
 *    does kicks, since its Stop is the turn this server is delivering;
 *  - the tab's Stop kicks once the registry flips idle after it (the Stop hooks have
 *    returned); a Stop with the turn still open, a sub-agent still open, or the session
 *    ended asks nothing;
 *  - a SubagentStop never kicks: a background sub-agent finishing after the Stop is
 *    answered by the model in a turn of its own, whose Stop kicks, and neither the hook
 *    short-circuit nor the B6 clause vouches for a session whose newest event is a
 *    SubagentStop, so a kick there could only fall through to the 30 s backstop.
 */
export function kickPlanFor(signal: KickSignalFacts, event: string, eventTs: number, child: boolean): KickPlan {
  if (child) return event === 'SessionEnd' ? { kind: 'kick' } : null
  if (event !== 'Stop') return null
  if (signal.turnOpen || signal.subagentsOpen > 0 || signal.ended) return null
  return { kind: 'kick_when_registry_idle', stopAt: typeof signal.stopAt === 'number' ? signal.stopAt : eventTs }
}

export function createDrainKick(deps: DrainKickDeps): DrainKick {
  let inFlight: Promise<void> | null = null
  let followUp: Promise<void> | null = null
  const stats = { passes: 0, kicks: 0, folded: 0 }

  const runOnce = async (): Promise<void> => {
    stats.passes++
    try { await deps.drain() } catch { /* the next pass retries; the sweep logs its own errors */ }
  }

  const sweep = (): Promise<void> => {
    if (!inFlight) {
      inFlight = runOnce().finally(() => { inFlight = null })
      return inFlight
    }
    // Exactly one follow-up pass, however many requests arrive while the first runs.
    if (!followUp) {
      stats.folded++
      const current = inFlight
      followUp = current.then(() => { followUp = null; return sweep() })
    } else {
      stats.folded++
    }
    return followUp
  }

  const queueNames = (sessionId: string): boolean => {
    const id = sessionId.toLowerCase()
    return deps.queuedThreadIds().some(t => t.toLowerCase() === id)
  }

  const waits = new Map<string, ReturnType<typeof setInterval>>()

  const kick = (sessionId: string): boolean => {
    if (!queueNames(sessionId)) return false
    stats.kicks++
    setImmediate(() => { void sweep() })
    return true
  }

  return {
    sweep,
    kick,
    kickWhen(sessionId: string, ready: () => boolean, opts = {}): boolean {
      if (!queueNames(sessionId)) return false
      const key = sessionId.toLowerCase()
      const existing = waits.get(key)
      if (existing) { clearInterval(existing); waits.delete(key) }
      let readyNow = false
      try { readyNow = ready() } catch { readyNow = false }
      if (readyNow) return kick(sessionId)
      const everyMs = opts.everyMs ?? KICK_POLL_MS
      const maxMs = opts.maxMs ?? KICK_WAIT_MAX_MS
      const startedAt = Date.now()
      const timer = setInterval(() => {
        let ok = false
        try { ok = ready() } catch { ok = false }
        if (ok || Date.now() - startedAt >= maxMs) {
          clearInterval(timer)
          waits.delete(key)
          // Past the wait the sweep still runs: the gate decides, and the 20 s timer would
          // have anyway. Nothing here can deliver; only the gate can.
          kick(sessionId)
        }
      }, everyMs)
      timer.unref?.()
      waits.set(key, timer)
      return true
    },
    stats: () => ({ ...stats, inFlight: inFlight !== null, waiting: waits.size }),
  }
}
