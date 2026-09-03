// Morning brief — pure schedule arithmetic in the user's zone.
//
// No dependency: Node's Intl is enough to read a wall clock in an IANA zone,
// and the two operations the scheduler needs — "what local day and minute is
// it now" and "when is HH:MM on day D as an instant" — are both derivable from
// it. Kept free of timers and I/O so the fire/no-fire decision is a table of
// inputs a test can enumerate: the Mac asleep through the slot, a weekend, a
// zone change, a DST morning, a second tick in the same minute.

import type { MorningBriefConfig, MorningBriefRun } from './morning-brief-config.js'
import { MORNING_BRIEF_LIMITS } from './morning-brief-config.js'

export interface LocalClock {
  /** YYYY-MM-DD in the zone. */
  day: string
  /** Minutes since local midnight, 0..1439. */
  minutes: number
  /** 0 = Sunday … 6 = Saturday, in the zone. */
  weekday: number
  /** HH:MM in the zone. */
  time: string
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone)
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    formatterCache.set(timezone, cached)
  }
  return cached
}

/** Read the wall clock at `nowMs` in `timezone`. */
export function localClock(nowMs: number, timezone: string): LocalClock {
  const parts = formatter(timezone).formatToParts(new Date(nowMs))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  // `hourCycle: 'h23'` is honoured by modern ICU, but "24" has been observed
  // from older builds at midnight. Normalise defensively.
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAY_INDEX[get('weekday')] ?? new Date(nowMs).getUTCDay(),
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  }
}

export function parseTime(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/** Shift a YYYY-MM-DD key by whole days (calendar arithmetic, zone-agnostic). */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + delta))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/**
 * The instant at which `day` reaches `minutes` past midnight in `timezone`.
 * Two-pass offset correction: read the zone's wall clock at a UTC guess, apply
 * the difference, and re-check once so a DST transition between the guess and
 * the target lands on the right side. A non-existent local time local-clocks
 * ~60 min early on the old offset (02:30 CDT gap → 01:30; 02:00 → 01:00);
 * 03:00 lands on 03:00 CDT. `taskInstant` adds 60 min when earlier:
 * 02:00→03:00, 02:30→03:30.
 */
export function zonedInstant(day: string, minutes: number, timezone: string): number {
  const [y, m, d] = day.split('-').map(Number)
  let guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60)
  for (let pass = 0; pass < 2; pass++) {
    const clock = localClock(guess, timezone)
    const dayDelta = daysBetween(clock.day, day)
    const diffMinutes = dayDelta * 1440 + (minutes - clock.minutes)
    if (diffMinutes === 0) break
    guess += diffMinutes * 60_000
  }
  return guess
}

/** Instant for a task runAt. If the rendered local (day, minutes) is earlier
 * than requested (spring-forward gap), add 60 minutes up to three times.
 * Fall back to the first zonedInstant. */
export function taskInstant(day: string, minutes: number, timezone: string): number {
  const first = zonedInstant(day, minutes, timezone)
  let instant = first
  for (let pass = 0; pass < 3; pass++) {
    const clock = localClock(instant, timezone)
    const earlier = clock.day < day || (clock.day === day && clock.minutes < minutes)
    if (!earlier) return instant
    instant += 60 * 60_000
  }
  return first
}

function daysBetween(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split('-').map(Number)
  const [ty, tm, td] = toDay.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/** ISO instant of the next scheduled fire at or after `nowMs`, or null when
 * the brief is disabled or no weekday is selected. */
export function nextScheduledFire(config: MorningBriefConfig, nowMs: number): string | null {
  if (!config.enabled || config.days.length === 0) return null
  const target = parseTime(config.time)
  const clock = localClock(nowMs, config.timezone)
  for (let offset = 0; offset <= 7; offset++) {
    const day = shiftDay(clock.day, offset)
    const instant = zonedInstant(day, target, config.timezone)
    const weekday = localClock(instant, config.timezone).weekday
    if (!config.days.includes(weekday)) continue
    if (instant >= nowMs) return new Date(instant).toISOString()
  }
  return null
}

export type FireDecision =
  | { fire: true; day: string; attempt: number; resume?: MorningBriefRun }
  | { fire: false; reason: 'disabled' | 'not_a_brief_day' | 'before_slot' | 'window_closed' | 'already_fired' | 'in_flight' | 'attempts_exhausted' | 'backoff' }

/**
 * Should the scheduled brief fire on this tick? The ledger is the memory: one
 * completed submission per local day, bounded retries for a submission that
 * failed (coordinator shutting down, store degraded), and a row that has no
 * job id and no error is a crash between ledger write and admission — resumed
 * by client identity rather than re-run.
 */
export function decideScheduledFire(
  config: MorningBriefConfig,
  runs: readonly MorningBriefRun[],
  nowMs: number,
): FireDecision {
  if (!config.enabled) return { fire: false, reason: 'disabled' }
  const clock = localClock(nowMs, config.timezone)
  if (!config.days.includes(clock.weekday)) return { fire: false, reason: 'not_a_brief_day' }
  const target = parseTime(config.time)
  if (clock.minutes < target) return { fire: false, reason: 'before_slot' }
  if (clock.minutes - target > config.catchUpMinutes) return { fire: false, reason: 'window_closed' }

  const today = runs.filter(run => run.day === clock.day && run.trigger === 'scheduled')
  const accepted = today.find(run => run.jobId)
  if (accepted) return { fire: false, reason: 'already_fired' }
  const last = today.at(-1)
  if (!last) return { fire: true, day: clock.day, attempt: 1 }
  const lastAt = Date.parse(last.firedAt)
  if (!last.submitError) {
    // Ledger row exists, no job id, no error: submission never reported back.
    // Give it a moment (the write happens just before submit), then resume by
    // identity so a lost admission is adopted instead of duplicated.
    if (Number.isFinite(lastAt) && nowMs - lastAt < MORNING_BRIEF_LIMITS.attemptSpacingMs) {
      return { fire: false, reason: 'in_flight' }
    }
    return { fire: true, day: clock.day, attempt: last.attempt, resume: last }
  }
  if (last.attempt >= MORNING_BRIEF_LIMITS.scheduledAttemptsPerDay) return { fire: false, reason: 'attempts_exhausted' }
  if (Number.isFinite(lastAt) && nowMs - lastAt < MORNING_BRIEF_LIMITS.attemptSpacingMs) {
    return { fire: false, reason: 'backoff' }
  }
  return { fire: true, day: clock.day, attempt: last.attempt + 1 }
}
