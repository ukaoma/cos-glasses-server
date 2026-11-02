import { describe, expect, it } from 'vitest'
import { PACE_HORIZON_MS, paceAllowed, paceBurst, paceRefillMs } from './live-cues-v2-pacing.js'

const MIN = 60_000

describe('cue pacing (6.97.8)', () => {
  it('the defaults: cap 25, gap 60 s: burst 13, one more every 5 minutes, all 25 open at minute 60', () => {
    expect(paceBurst(25)).toBe(13)
    expect(paceRefillMs(25, 60_000)).toBe(5 * MIN)
    const at = (m: number) => paceAllowed(25, 60_000, m * MIN)
    expect([0, 4, 5, 10, 24, 25, 30, 45, 49, 50, 55, 59, 60, 61, 600].map(at)).toEqual([13, 13, 14, 15, 17, 18, 19, 22, 22, 23, 24, 24, 25, 25, 25])
    expect(PACE_HORIZON_MS).toBe(60 * MIN)
  })

  it('the gap is a floor on the refill: a gap longer than the horizon spread slows it, a shorter one does not speed it', () => {
    expect(paceRefillMs(25, 45_000)).toBe(5 * MIN)
    expect(paceRefillMs(25, 10 * MIN)).toBe(10 * MIN)
  })

  it('allowed never exceeds the cap, never decreases, and starts at the burst, for every cap the settings accept (1 to 25)', () => {
    for (let cap = 1; cap <= 25; cap++) {
      expect(paceAllowed(cap, 45_000, 0), `cap ${cap} at 0`).toBe(paceBurst(cap))
      let last = 0
      for (let m = 0; m <= 240; m++) {
        const a = paceAllowed(cap, 45_000, m * MIN)
        expect(a, `cap ${cap} minute ${m}`).toBeGreaterThanOrEqual(last)
        expect(a).toBeLessThanOrEqual(cap)
        last = a
      }
      expect(paceAllowed(cap, 45_000, 60 * MIN), `cap ${cap} at the horizon`).toBe(cap)
    }
  })

  it('a cap of 1 is open at once; a negative or zero elapsed time is the burst', () => {
    expect(paceAllowed(1, 45_000, 0)).toBe(1)
    expect(paceRefillMs(1, 45_000)).toBe(Number.POSITIVE_INFINITY)
    expect(paceAllowed(25, 45_000, -5 * MIN)).toBe(13)
  })

  it('the 11/02 arithmetic: the three capped meetings (cap 25, gap 60 s) were allowed this many cues at the minute they spent the 25th', () => {
    // Real minutes from the meeting's first evaluation to its 25th cue, from the trace: 17.8, 23.9, 30.4.
    expect([17.8, 23.9, 30.4].map(m => paceAllowed(25, 60_000, m * MIN))).toEqual([16, 17, 19])
  })
})
