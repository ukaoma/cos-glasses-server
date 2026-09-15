import { describe, expect, it } from 'vitest'
import { createDrainKick } from './thread-drain-kick.js'

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
    expect(calls).toBe(1)                      // nothing concurrent
    gates[0].resolve(1)
    await first
    await Promise.resolve(); await Promise.resolve()
    expect(calls).toBe(2)                      // ONE follow-up for three kicks
    gates[1].resolve(0)
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toBe(2)
    expect(kick.stats()).toMatchObject({ passes: 2, kicks: 3, folded: 3, inFlight: false })
  })

  it('a kick is spent only when a queue names the session, by full id or the 8-character prefix, either way round', () => {
    let queued: string[] = []
    let drains = 0
    const kick = createDrainKick({ drain: async () => { drains++; return 0 }, queuedThreadIds: () => queued })
    expect(kick.kick(FULL)).toBe(false)
    expect(drains).toBe(0)
    queued = ['b2c3d4e5-0000-4000-8000-000000000002']
    expect(kick.kick(FULL)).toBe(false)
    queued = [FULL.slice(0, 8)]                 // the registry's short form in the queue file
    expect(kick.kick(FULL)).toBe(true)
    queued = [FULL]
    expect(kick.kick(FULL.slice(0, 8).toUpperCase())).toBe(true)   // a short id from the registry, case-insensitive
    expect(kick.stats().kicks).toBe(2)
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
