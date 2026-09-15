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
// nobody queued for costs a directory listing and nothing else. Queue thread ids can be
// the 8-character registry form when the transcript could not be resolved, so the
// match is full id OR prefix, mirroring `getByPrefix`.

export interface DrainKickDeps {
  /** The sweep. Resolves the number delivered; rejects are swallowed here. */
  drain: () => Promise<number>
  /** Thread ids with a queue file right now, any provider. */
  queuedThreadIds: () => string[]
}

export interface DrainKick {
  /** Run the sweep, or fold into the one in flight. Resolves when THIS request's pass has run. */
  sweep(): Promise<void>
  /** A session's turn ended: sweep if any queue names it (full id or 8-char prefix). Returns true when a sweep was requested. */
  kick(sessionId: string): boolean
  /** For health: passes run, kicks spent, kicks folded into a running pass. */
  stats(): { passes: number; kicks: number; folded: number; inFlight: boolean }
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
    const prefix = id.slice(0, 8)
    return deps.queuedThreadIds().some(t => {
      const tid = t.toLowerCase()
      return tid === id || (tid.length === 8 && tid === prefix) || (id.length === 8 && tid.slice(0, 8) === id)
    })
  }

  return {
    sweep,
    kick(sessionId: string): boolean {
      if (!queueNames(sessionId)) return false
      stats.kicks++
      void sweep()
      return true
    },
    stats: () => ({ ...stats, inFlight: inFlight !== null }),
  }
}
