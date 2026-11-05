import { describe, expect, it } from 'vitest'
import { DEFAULT_BANNER_SOURCES, isQuietHours, PING_BUDGET, PING_SOURCES, planBanners, trimLedger, type BannerCandidate, type BannerRecord, type PingSource } from './ping-budget.js'
import { localClock, taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const local = (day: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return taskInstant(day, h * 60 + m, TZ) }
const ALL = PING_SOURCES
const c = (id: string, source: PingSource, createdAt = 0): BannerCandidate => ({ id, source, createdAt })

describe('planBanners: the interruption budget', () => {
  const WED_10 = local('2026-11-04', '10:00')

  it('pins the decided numbers and the default sources', () => {
    expect(PING_BUDGET).toEqual({ perWeekday: 6, perSource: 2, gapMs: 2_700_000, dayStartMinutes: 360, dayEndMinutes: 1080, firstBannerMinutes: 480 })
    expect(DEFAULT_BANNER_SOURCES).toEqual(['reminder', 'resolution'])
  })

  it('quiet hours follow Control: weekends, before 6:00, from 18:00', () => {
    expect(isQuietHours(local('2026-11-04', '05:59'), TZ)).toBe(true)
    expect(isQuietHours(local('2026-11-04', '06:00'), TZ)).toBe(false)
    expect(isQuietHours(local('2026-11-04', '17:59'), TZ)).toBe(false)
    expect(isQuietHours(local('2026-11-04', '18:00'), TZ)).toBe(true)
    expect(isQuietHours(local('2026-11-07', '12:00'), TZ)).toBe(true)  // Saturday
    expect(isQuietHours(local('2026-11-08', '12:00'), TZ)).toBe(true)  // Sunday
  })

  it('a reminder banners at any hour, alone, and never counts', () => {
    const sat3am = local('2026-11-07', '03:00')
    const plan = planBanners([c('r1', 'reminder'), c('r2', 'reminder')], [], sat3am, TZ)
    expect(plan.banners).toEqual([
      { ids: ['r1'], sources: ['reminder'], merged: false, exempt: true },
      { ids: ['r2'], sources: ['reminder'], merged: false, exempt: true },
    ])
    // Six reminders today do not use up the budget.
    const ledger: BannerRecord[] = Array.from({ length: 6 }, (_, i) => ({ at: WED_10 - (i + 1) * 3_600_000 + 60_000 * 0, sources: ['reminder'], ids: [`r${i}`] }))
    expect(planBanners([c('x', 'resolution')], ledger.filter(b => localClock(b.at, TZ).day === '2026-11-04'), WED_10, TZ).banners).toHaveLength(1)
  })

  it('other sources are off by default; resolutions are on', () => {
    const plan = planBanners([c('a', 'prep'), c('b', 'resolution'), c('d', 'stale')], [], WED_10, TZ)
    expect(plan.banners).toEqual([{ ids: ['b'], sources: ['resolution'], merged: false, exempt: false }])
    expect(plan.silent).toEqual([{ id: 'a', reason: 'source_off' }, { id: 'd', reason: 'source_off' }])
  })

  it('no non-reminder banner in quiet hours or before 8:00', () => {
    expect(planBanners([c('a', 'resolution')], [], local('2026-11-04', '19:00'), TZ).silent).toEqual([{ id: 'a', reason: 'quiet_hours' }])
    expect(planBanners([c('a', 'resolution')], [], local('2026-11-04', '07:30'), TZ).silent).toEqual([{ id: 'a', reason: 'before_first_banner' }])
    expect(planBanners([c('a', 'resolution')], [], local('2026-11-04', '08:00'), TZ).banners).toHaveLength(1)
  })

  it('merges what is due together into one banner, which counts once', () => {
    const plan = planBanners([c('a', 'prep', 1), c('b', 'resolution', 2), c('d', 'agent', 3)], [], WED_10, TZ, ALL)
    expect(plan.banners).toEqual([{ ids: ['b', 'a', 'd'], sources: ['resolution', 'prep', 'agent'], merged: true, exempt: false }])
  })

  it('holds 45 minutes between banners', () => {
    const ledger: BannerRecord[] = [{ at: WED_10 - 44 * 60_000, sources: ['prep'], ids: ['p'] }]
    expect(planBanners([c('a', 'resolution')], ledger, WED_10, TZ, ALL).silent).toEqual([{ id: 'a', reason: 'too_soon' }])
    expect(planBanners([c('a', 'resolution')], ledger, WED_10 + 60_000, TZ, ALL).banners).toHaveLength(1)
  })

  it('caps at 2 banners per source and 6 a weekday', () => {
    const two: BannerRecord[] = [
      { at: local('2026-11-04', '08:00'), sources: ['prep'], ids: ['p1'] },
      { at: local('2026-11-04', '09:00'), sources: ['prep', 'agent'], ids: ['p2', 'a1'] },
    ]
    const plan = planBanners([c('p3', 'prep'), c('a2', 'agent')], two, WED_10, TZ, ALL)
    expect(plan.silent).toEqual([{ id: 'p3', reason: 'source_cap' }])
    expect(plan.banners[0].ids).toEqual(['a2'])
    const six: BannerRecord[] = Array.from({ length: 6 }, (_, i) => ({ at: local('2026-11-04', `0${8}:00`) - i * 60_000, sources: [ALL[1 + (i % 6)]], ids: [`x${i}`] }))
    expect(planBanners([c('a', 'checkin')], six, local('2026-11-04', '15:00'), TZ, ALL).silent).toEqual([{ id: 'a', reason: 'daily_cap' }])
    // Yesterday's banners do not count today.
    const yesterday = six.map(b => ({ ...b, at: b.at - 86_400_000 }))
    expect(planBanners([c('a', 'checkin')], yesterday, local('2026-11-04', '15:00'), TZ, ALL).banners).toHaveLength(1)
  })

  it('trims the ledger to 8 days', () => {
    const now = WED_10
    const kept = trimLedger([{ at: now - 9 * 86_400_000, sources: ['prep'], ids: ['old'] }, { at: now - 86_400_000, sources: ['prep'], ids: ['new'] }], now)
    expect(kept.map(b => b.ids[0])).toEqual(['new'])
  })
})

/**
 * Canary 6 (plan section 9): a fixture week on a fake clock. Every source switched on, a seeded stream of
 * candidates at all hours, a tick every minute. Fails on more than 6 counted banners on a weekday, more than 2 per
 * source, a gap under 45 minutes, or any non-reminder banner in quiet hours.
 */
describe('canary 6: ping caps over a fixture week', () => {
  function rng(seed: number) { return () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 } }

  for (const seed of [1, 7, 42, 2026]) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed)
      const start = local('2026-11-02', '00:00')  // Monday
      const end = start + 7 * 86_400_000
      const ledger: BannerRecord[] = []
      let n = 0, reminders = 0, total = 0
      for (let now = start; now < end; now += 60_000) {
        const due: BannerCandidate[] = []
        // About 40 candidates a day, every source, every hour.
        if (rand() < 40 / 1440) {
          const count = 1 + Math.floor(rand() * 3)
          for (let i = 0; i < count; i++) due.push(c(`i${n++}`, ALL[Math.floor(rand() * ALL.length)], now))
        }
        if (!due.length) continue
        total += due.length
        const plan = planBanners(due, ledger, now, TZ, ALL)
        expect(plan.banners.flatMap(b => b.ids).length + plan.silent.length).toBe(due.length)  // nothing lost
        for (const b of plan.banners) { ledger.push({ at: now, sources: b.sources, ids: b.ids }); if (b.exempt) reminders++ }
      }
      expect(total).toBeGreaterThan(200)
      expect(reminders).toBeGreaterThan(10)  // the exempt path ran
      const counted = ledger.filter(b => b.sources.some(s => s !== 'reminder'))
      expect(counted.length).toBeGreaterThan(10)  // the budget path ran, too
      const byDay = new Map<string, BannerRecord[]>()
      for (const b of counted) {
        const day = localClock(b.at, TZ).day
        byDay.set(day, [...(byDay.get(day) ?? []), b])
        expect(isQuietHours(b.at, TZ)).toBe(false)
        expect(localClock(b.at, TZ).minutes).toBeGreaterThanOrEqual(PING_BUDGET.firstBannerMinutes)
        expect(b.sources).not.toContain('reminder')
      }
      for (const [, list] of byDay) {
        expect(list.length).toBeLessThanOrEqual(6)
        const per = new Map<string, number>()
        for (const b of list) for (const s of b.sources) per.set(s, (per.get(s) ?? 0) + 1)
        for (const [, count] of per) expect(count).toBeLessThanOrEqual(2)
        const times = list.map(b => b.at).sort((a, b) => a - b)
        for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(PING_BUDGET.gapMs)
      }
      // The cap was reached on at least one weekday, so the canary saw it hold.
      expect([...byDay.values()].some(list => list.length === 6 || list.reduce((a, b) => a + b.sources.length, 0) >= 10)).toBe(true)
    })
  }
})
