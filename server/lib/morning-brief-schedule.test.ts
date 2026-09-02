import { describe, expect, it } from 'vitest'
import { defaultMorningBriefConfig, type MorningBriefRun } from './morning-brief-config.js'
import {
  decideScheduledFire,
  localClock,
  nextScheduledFire,
  shiftDay,
  zonedInstant,
} from './morning-brief-schedule.js'

const CHICAGO = 'America/Chicago'

function config(overrides: Partial<ReturnType<typeof defaultMorningBriefConfig>> = {}) {
  return { ...defaultMorningBriefConfig(new Date('2026-09-01T00:00:00Z')), timezone: CHICAGO, ...overrides }
}

function run(overrides: Partial<MorningBriefRun>): MorningBriefRun {
  return {
    id: 'r1',
    day: '2026-09-01',
    trigger: 'scheduled',
    attempt: 1,
    firedAt: '2026-09-01T12:00:05.000Z',
    clientJobId: '00000000-0000-4000-8000-000000000000',
    generation: 1,
    sessionId: 's1',
    ...overrides,
  }
}

describe('localClock', () => {
  it('reads the wall clock in the configured zone, not UTC', () => {
    // 2026-09-01 12:00Z is 07:00 CDT on a Tuesday.
    const clock = localClock(Date.UTC(2026, 8, 1, 12, 0), CHICAGO)
    expect(clock).toEqual({ day: '2026-09-01', minutes: 7 * 60, weekday: 2, time: '07:00' })
  })

  it('crosses midnight by zone: a late UTC evening is still the same local day', () => {
    // 2026-09-02 03:30Z is 22:30 CDT on 2026-09-01.
    const clock = localClock(Date.UTC(2026, 8, 2, 3, 30), CHICAGO)
    expect(clock.day).toBe('2026-09-01')
    expect(clock.time).toBe('22:30')
  })

  it('never reports hour 24 at midnight', () => {
    const clock = localClock(Date.UTC(2026, 8, 1, 5, 0), CHICAGO)
    expect(clock.time).toBe('00:00')
    expect(clock.minutes).toBe(0)
  })
})

describe('zonedInstant', () => {
  it('is the inverse of localClock across the DST fall-back morning', () => {
    // 2026-11-01 is the US fall-back day. 07:00 CST that morning is 13:00Z.
    const instant = zonedInstant('2026-11-01', 7 * 60, CHICAGO)
    expect(new Date(instant).toISOString()).toBe('2026-11-01T13:00:00.000Z')
    expect(localClock(instant, CHICAGO)).toMatchObject({ day: '2026-11-01', time: '07:00' })
  })

  it('is the inverse of localClock across the DST spring-forward morning', () => {
    // 2026-03-08 is the US spring-forward day. 07:00 CDT that morning is 12:00Z.
    const instant = zonedInstant('2026-03-08', 7 * 60, CHICAGO)
    expect(new Date(instant).toISOString()).toBe('2026-03-08T12:00:00.000Z')
  })

  it('handles a zone east of UTC', () => {
    const instant = zonedInstant('2026-09-01', 7 * 60, 'Asia/Singapore')
    expect(new Date(instant).toISOString()).toBe('2026-08-31T23:00:00.000Z')
  })
})

describe('shiftDay', () => {
  it('rolls across month and year boundaries', () => {
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('nextScheduledFire', () => {
  it('is today when the slot has not passed', () => {
    const now = Date.UTC(2026, 8, 1, 11, 0) // Tue 06:00 CDT
    expect(nextScheduledFire(config(), now)).toBe('2026-09-01T12:00:00.000Z')
  })

  it('skips to the next selected weekday once the slot has passed', () => {
    const now = Date.UTC(2026, 8, 4, 13, 0) // Fri 08:00 CDT
    expect(nextScheduledFire(config(), now)).toBe('2026-09-07T12:00:00.000Z') // Monday
  })

  it('honours a custom day set and a custom time', () => {
    const now = Date.UTC(2026, 8, 1, 11, 0) // Tue
    expect(nextScheduledFire(config({ days: [6], time: '09:30' }), now)).toBe('2026-09-05T14:30:00.000Z') // Saturday
  })

  it('is null when disabled or when no day is selected', () => {
    const now = Date.UTC(2026, 8, 1, 11, 0)
    expect(nextScheduledFire(config({ enabled: false }), now)).toBeNull()
    expect(nextScheduledFire(config({ days: [] }), now)).toBeNull()
  })
})

describe('decideScheduledFire', () => {
  const slot = Date.UTC(2026, 8, 1, 12, 0) // Tue 07:00 CDT

  it('does not fire before the slot', () => {
    expect(decideScheduledFire(config(), [], slot - 60_000)).toEqual({ fire: false, reason: 'before_slot' })
  })

  it('fires at the slot with attempt 1 and the local day', () => {
    expect(decideScheduledFire(config(), [], slot)).toEqual({ fire: true, day: '2026-09-01', attempt: 1 })
  })

  it('fires late inside the catch-up window (the Mac was asleep at 07:00)', () => {
    expect(decideScheduledFire(config(), [], slot + 2 * 3_600_000)).toEqual({ fire: true, day: '2026-09-01', attempt: 1 })
  })

  it('does not fire once the catch-up window has closed', () => {
    expect(decideScheduledFire(config(), [], slot + 4 * 3_600_000)).toEqual({ fire: false, reason: 'window_closed' })
  })

  it('does not fire on a weekend with the default days', () => {
    const saturday = Date.UTC(2026, 8, 5, 12, 0)
    expect(decideScheduledFire(config(), [], saturday)).toEqual({ fire: false, reason: 'not_a_brief_day' })
  })

  it('does not fire when disabled', () => {
    expect(decideScheduledFire(config({ enabled: false }), [], slot)).toEqual({ fire: false, reason: 'disabled' })
  })

  it('fires exactly once per local day: an accepted run blocks every later tick', () => {
    const runs = [run({ jobId: 'job-1' })]
    expect(decideScheduledFire(config(), runs, slot + 30_000)).toEqual({ fire: false, reason: 'already_fired' })
    expect(decideScheduledFire(config(), runs, slot + 60 * 60_000)).toEqual({ fire: false, reason: 'already_fired' })
  })

  it("yesterday's run does not block today", () => {
    const runs = [run({ day: '2026-08-31', jobId: 'job-0' })]
    expect(decideScheduledFire(config(), runs, slot)).toEqual({ fire: true, day: '2026-09-01', attempt: 1 })
  })

  it('a manual run does not count as the scheduled fire', () => {
    const runs = [run({ trigger: 'manual', jobId: 'job-m' })]
    expect(decideScheduledFire(config(), runs, slot)).toEqual({ fire: true, day: '2026-09-01', attempt: 1 })
  })

  it('a row with no job id and no error is in flight for two minutes, then resumed by identity', () => {
    const pending = run({ firedAt: new Date(slot).toISOString() })
    expect(decideScheduledFire(config(), [pending], slot + 30_000)).toEqual({ fire: false, reason: 'in_flight' })
    expect(decideScheduledFire(config(), [pending], slot + 3 * 60_000)).toEqual({
      fire: true, day: '2026-09-01', attempt: 1, resume: pending,
    })
  })

  it('a failed submission backs off, retries with the next attempt, then gives the day up', () => {
    const failed1 = run({ firedAt: new Date(slot).toISOString(), submitError: { code: 'x', message: 'x' } })
    expect(decideScheduledFire(config(), [failed1], slot + 30_000)).toEqual({ fire: false, reason: 'backoff' })
    expect(decideScheduledFire(config(), [failed1], slot + 3 * 60_000)).toEqual({ fire: true, day: '2026-09-01', attempt: 2 })
    const failed3 = run({ id: 'r3', attempt: 3, firedAt: new Date(slot + 6 * 60_000).toISOString(), submitError: { code: 'x', message: 'x' } })
    expect(decideScheduledFire(config(), [failed1, failed3], slot + 20 * 60_000)).toEqual({ fire: false, reason: 'attempts_exhausted' })
  })
})
