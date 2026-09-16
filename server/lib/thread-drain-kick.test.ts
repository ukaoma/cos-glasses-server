import { describe, expect, it } from 'vitest'
import { createDrainKick, kickPlanFor } from './thread-drain-kick.js'

const FULL = 'a1b2c3d4-0000-4000-8000-000000000001'

function deferred(): { promise: Promise<number>; resolve: (n: number) => void } {
  let resolve!: (n: number) => void
  const promise = new Promise<number>(r => { resolve = r })
  return { promise, resolve }
}

describe('the Stop-driven drain kick', () => {
  it('a kick during a running pass folds into exactly one follow-up pass, never a concurrent one', async () => {
    const gates = [deferred(), deferred(), deferred()]
    let calls = 0
    const kick = createDrainKick({ drain: () => gates[calls++].promise, queuedThreadIds: () => [FULL] })
    const first = kick.sweep()                 // the 20 s timer
    expect(kick.stats().inFlight).toBe(true)
    expect(kick.kick(FULL)).toBe(true)         // a Stop lands mid-sweep
    expect(kick.kick(FULL)).toBe(true)         // and another
    expect(kick.kick(FULL)).toBe(true)
    expect(calls).toBe(1)                      // nothing concurrent, and nothing ran INSIDE the kick
    await new Promise(r => setImmediate(r))    // the kicks' sweeps run on the next macrotask
    expect(calls).toBe(1)                      // still folded behind the pass in flight
    gates[0].resolve(1)
    await first
    await Promise.resolve(); await Promise.resolve()
    expect(calls).toBe(2)                      // ONE follow-up for three kicks
    gates[1].resolve(0)
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toBe(2)
    expect(kick.stats()).toMatchObject({ passes: 2, kicks: 3, folded: 3, inFlight: false })
  })

  it('a kick is spent only when a queue names the session by its full id (case-insensitive); a prefix is not a match', async () => {
    // A Claude queue file is always keyed by the full UUID: the attach gate refuses an
    // 8-character id as `invalid_thread_id` before anything can be queued, and every
    // hook envelope carries the full session id. QA 2026-09-15 found the prefix branch
    // this used to carry unreachable; it is gone, so a prefix must NOT spend a kick.
    let queued: string[] = []
    let drains = 0
    const kick = createDrainKick({ drain: async () => { drains++; return 0 }, queuedThreadIds: () => queued })
    expect(kick.kick(FULL)).toBe(false)
    expect(drains).toBe(0)
    queued = ['b2c3d4e5-0000-4000-8000-000000000002']
    expect(kick.kick(FULL)).toBe(false)
    queued = [FULL.slice(0, 8)]
    expect(kick.kick(FULL)).toBe(false)
    queued = [FULL]
    expect(kick.kick(FULL.slice(0, 8))).toBe(false)
    expect(kick.kick(FULL.toUpperCase())).toBe(true)
    expect(drains).toBe(0)                     // the sweep is deferred off the caller's stack
    await new Promise(r => setImmediate(r))
    expect(drains).toBe(1)
    expect(kick.stats().kicks).toBe(1)
  })

  it('kickWhen polls the readiness until it answers true, then kicks once; a session nobody queued for is refused at once', async () => {
    let ready = false
    let drains = 0
    const kick = createDrainKick({ drain: async () => { drains++; return 0 }, queuedThreadIds: () => [FULL] })
    expect(kick.kickWhen('b2c3d4e5-0000-4000-8000-000000000002', () => true)).toBe(false)
    expect(kick.kickWhen('b2c3d4e5-0000-4000-8000-000000000002', () => false, { everyMs: 5, maxMs: 1_000 })).toBe(false)
    expect(kick.stats().waiting).toBe(0)       // and no poll was started for it
    expect(kick.kickWhen(FULL, () => ready, { everyMs: 5, maxMs: 1_000 })).toBe(true)
    expect(kick.stats()).toMatchObject({ waiting: 1, kicks: 0 })
    await new Promise(r => setTimeout(r, 20))
    expect(drains).toBe(0)                     // not ready: nothing kicked
    ready = true
    await new Promise(r => setTimeout(r, 30))
    expect(kick.stats()).toMatchObject({ waiting: 0, kicks: 1 })
    expect(drains).toBe(1)
  })

  it('kickWhen gives up after maxMs and kicks anyway: the gate decides, and the 20 s timer would have', async () => {
    let drains = 0
    const kick = createDrainKick({ drain: async () => { drains++; return 0 }, queuedThreadIds: () => [FULL] })
    expect(kick.kickWhen(FULL, () => false, { everyMs: 5, maxMs: 25 })).toBe(true)
    await new Promise(r => setTimeout(r, 60))
    expect(kick.stats()).toMatchObject({ waiting: 0, kicks: 1 })
    expect(drains).toBe(1)
  })

  it('a second kickWhen for the same session replaces the first wait, so a burst of Stops keeps one poll', async () => {
    const kick = createDrainKick({ drain: async () => 0, queuedThreadIds: () => [FULL] })
    kick.kickWhen(FULL, () => false, { everyMs: 5, maxMs: 1_000 })
    kick.kickWhen(FULL, () => false, { everyMs: 5, maxMs: 1_000 })
    expect(kick.stats().waiting).toBe(1)
  })

  it('kickPlanFor: a tab Stop with the turn closed waits for the registry; a child SessionEnd kicks now; everything else asks nothing', () => {
    const closed = { turnOpen: false, subagentsOpen: 0, ended: null, stopAt: 5_000 }
    expect(kickPlanFor(closed, 'Stop', 5_001, false)).toEqual({ kind: 'kick_when_registry_idle', stopAt: 5_000 })
    // No stopAt on the signal (a salvaged Stop): the event's own stamp.
    expect(kickPlanFor({ ...closed, stopAt: null }, 'Stop', 5_001, false)).toEqual({ kind: 'kick_when_registry_idle', stopAt: 5_001 })
    expect(kickPlanFor({ ...closed, turnOpen: true }, 'Stop', 5_001, false)).toBeNull()
    expect(kickPlanFor({ ...closed, subagentsOpen: 1 }, 'Stop', 5_001, false)).toBeNull()
    expect(kickPlanFor({ ...closed, ended: { at: 1, reason: 'other' } }, 'Stop', 5_001, false)).toBeNull()
    // A SubagentStop is not a kick (the model answers the notification in a turn of its own).
    expect(kickPlanFor(closed, 'SubagentStop', 5_001, false)).toBeNull()
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'SessionEnd', 'PermissionRequest']) expect(kickPlanFor(closed, event, 5_001, false)).toBeNull()
    // A COS child: only its SessionEnd, which frees the thread for the next queued turn.
    expect(kickPlanFor(closed, 'SessionEnd', 5_001, true)).toEqual({ kind: 'kick' })
    expect(kickPlanFor(closed, 'Stop', 5_001, true)).toBeNull()
    expect(kickPlanFor({ ...closed, turnOpen: true }, 'SessionEnd', 5_001, true)).toEqual({ kind: 'kick' })
  })

  it('a rejecting drain is swallowed and the next sweep still runs', async () => {
    let n = 0
    const kick = createDrainKick({ drain: async () => { n++; if (n === 1) throw new Error('boom'); return 0 }, queuedThreadIds: () => [FULL] })
    await kick.sweep()
    await kick.sweep()
    expect(n).toBe(2)
    expect(kick.stats().passes).toBe(2)
  })
})
