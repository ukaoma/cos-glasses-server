// S1 (2026-11-09): the event-loop stall detector, on a fake clock.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startEventLoopStallMonitor } from './event-loop-stall.js'

afterEach(() => { vi.useRealTimers() })

describe('event-loop stall detector (S1)', () => {
  function rig() {
    vi.useFakeTimers()
    let clock = 0
    const lines: string[] = []
    const monitor = startEventLoopStallMonitor({
      now: () => clock, log: l => lines.push(l), memory: () => ({ rss: 1_840e6, heapUsed: 910e6 }),
    })
    /** One timer tick that fired `late` ms after it was due. */
    const tick = (late = 0) => { clock += 500 + late; vi.advanceTimersByTime(500) }
    return { monitor, lines, tick }
  }

  it('says nothing while the loop keeps time, or is merely a little late', () => {
    const { monitor, lines, tick } = rig()
    for (let i = 0; i < 100; i++) tick(i % 2 ? 1_500 : 20)
    expect(lines).toEqual([])
    expect(monitor.stats()).toEqual({ stalls: 0, worstMs: 0 })
    monitor.stop()
  })

  it('logs a stall over 2 s with its length and memory, and rate-limits the rest', () => {
    const { monitor, lines, tick } = rig()
    tick(); tick(6_230)
    expect(lines).toEqual(['[event-loop] stalled 6230 ms (rss 1840 MB, heap 910 MB; 1 stall(s) over 2000 ms since boot)'])
    tick(2_500) // inside 10 s of the last line: counted, not logged
    for (let i = 0; i < 8; i++) tick() // 4 s more: now past 10 s since the first line
    tick(3_000)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('[event-loop] stalled 3000 ms (rss 1840 MB, heap 910 MB; 3 stall(s) over 2000 ms since boot; 1 more since the last line)')
    expect(monitor.stats()).toEqual({ stalls: 3, worstMs: 6230 })
    monitor.stop()
  })
})
