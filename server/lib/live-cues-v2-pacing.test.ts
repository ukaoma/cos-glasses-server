import { describe, expect, it } from 'vitest'
import { LIVE_CUES_V2_LIMIT_BOUNDS } from './live-cues-v2-settings.js'
import { PACE_HORIZON_MAX_MS, PACE_HORIZON_MIN_MS, PACE_HORIZON_MS, PACE_MIN_CAP, paceAllowed, paceBurst, paceHorizon, paceRefillMs } from './live-cues-v2-pacing.js'

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

  it('allowed never exceeds the cap, never decreases, and starts at the burst (the whole cap below 5), for every cap the settings accept (1 up to the bound, 50 since 6.99.0)', () => {
    for (let cap = 1; cap <= LIVE_CUES_V2_LIMIT_BOUNDS.maxCuesPerMeeting.max; cap++) {
      expect(paceAllowed(cap, 45_000, 0), `cap ${cap} at 0`).toBe(cap < PACE_MIN_CAP ? cap : paceBurst(cap))
      let last = 0
      for (let m = 0; m <= 240; m++) {
        const a = paceAllowed(cap, 45_000, m * MIN)
        expect(a, `cap ${cap} minute ${m}`).toBeGreaterThanOrEqual(last)
        expect(a).toBeLessThanOrEqual(cap)
        last = a
      }
      expect(paceAllowed(cap, 45_000, 60 * MIN), `cap ${cap} at the horizon`).toBe(cap)
    }
    expect(PACE_MIN_CAP).toBe(5)
  })

  it('6.99.0 cap 50, gap 45 s, one hour: burst 25, one more every 144 s, all 50 open at minute 60; a 3 hour meeting spreads the second 25 over 180 minutes', () => {
    expect(LIVE_CUES_V2_LIMIT_BOUNDS.maxCuesPerMeeting.max).toBe(50)
    expect(paceBurst(50)).toBe(25)
    expect(paceRefillMs(50, 45_000)).toBe(144_000)
    expect([0, 2, 3, 30, 59, 60, 61].map(m => paceAllowed(50, 45_000, m * MIN))).toEqual([25, 25, 26, 37, 49, 50, 50])
    expect(paceRefillMs(50, 45_000, PACE_HORIZON_MAX_MS)).toBe(432_000)
    expect(paceAllowed(50, 45_000, 180 * MIN, PACE_HORIZON_MAX_MS)).toBe(50)
  })

  it('a cap of 4 or fewer is not paced; 5 is', () => {
    expect([1, 2, 3, 4].map(c => paceAllowed(c, 60_000, 0))).toEqual([1, 2, 3, 4])
    expect(paceAllowed(5, 60_000, 0)).toBe(3)
  })

  it('the horizon is the calendar length, clamped to 15 to 180 minutes; anything else is the hour', () => {
    expect(paceHorizon(30 * MIN)).toBe(30 * MIN)
    expect(paceHorizon(5 * MIN)).toBe(PACE_HORIZON_MIN_MS)
    expect(paceHorizon(10 * 60 * MIN)).toBe(PACE_HORIZON_MAX_MS)
    for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(paceHorizon(bad as number | null), String(bad)).toBe(PACE_HORIZON_MS)
    // a 30 minute meeting: refill 30 min / 12 = 2.5 min, the whole cap open at minute 30
    expect(paceRefillMs(25, 60_000, 30 * MIN)).toBe(150_000)
    expect(paceAllowed(25, 60_000, 30 * MIN, 30 * MIN)).toBe(25)
    expect(paceAllowed(25, 60_000, 29 * MIN, 30 * MIN)).toBe(24)
  })

  it('a cap of 1 is open at once; a negative elapsed time is the burst', () => {
    expect(paceAllowed(1, 45_000, 0)).toBe(1)
    expect(paceRefillMs(1, 45_000)).toBe(Number.POSITIVE_INFINITY)
    expect(paceAllowed(25, 45_000, -5 * MIN)).toBe(13)
  })

  it('the 11/02 arithmetic: the three capped meetings (cap 25, gap 60 s) were allowed this many cues at the minute they spent the 25th', () => {
    // Real minutes from the meeting's first evaluation to its 25th cue, from the trace: 17.8, 23.9, 30.4.
    expect([17.8, 23.9, 30.4].map(m => paceAllowed(25, 60_000, m * MIN))).toEqual([16, 17, 19])
  })
})
