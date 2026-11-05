/**
 * Drop it P2 (plan PLAN_drop_it_2026-11-04 section 7): when a reminder fires, read from his own words.
 *
 * Deterministic. No model, no network, no clock of its own: `now` and the zone are inputs, so every case is a
 * row in a table. What it reads:
 * - days: today, tonight, tomorrow, this morning/afternoon/evening, weekdays, "next week", ISO dates, "Nov 12";
 * - times: "3pm", "3:30 p.m.", "15:00", "at 3", noon, midnight, morning (9:00), afternoon (14:00), evening (18:00);
 * - offsets: "in 20 minutes", "in an hour", "in 3 days", "in 2 weeks".
 *
 * Defaults (plan section 7):
 * - A day alone means 9:00 (tonight means 20:00).
 * - Today's weekday means next week ("Thursday" said on a Thursday is a week out).
 * - A bare hour means the next one: "at 3" at 10 AM is 3 PM today; at 4 PM it is 3 AM tomorrow. On a later day,
 *   1 to 6 read as afternoon and 7 to 11 as morning.
 * - A time with no day is the next time the clock shows it.
 * - Nothing found: `at` is null and COS asks once (Tomorrow 9:00, Monday 9:00, Pick a time).
 * - An explicit day and time already past ("today 3pm" at 4 PM) is refused as `past`, never moved silently.
 */
import { localClock, shiftDay, taskInstant } from './morning-brief-schedule.js'

export const WHEN_DEFAULTS = { dayMinutes: 9 * 60, morning: 9 * 60, afternoon: 14 * 60, evening: 18 * 60, tonight: 20 * 60, noon: 12 * 60 } as const
/** The furthest a reminder may be set: a year out. Past that it is a typo, so COS asks. */
export const WHEN_MAX_AHEAD_MS = 366 * 86_400_000

export type WhenReason = 'none' | 'past' | 'too_far'
export interface WhenResult {
  /** Epoch ms of the fire, or null when COS must ask. */
  at: number | null
  reason?: WhenReason
  /** What the reminder is about, with "remind me", the time words and a joining "to" taken out. */
  about: string
  /** The receipt's words for the time: "today 3:00 PM", "tomorrow 9:00 AM", "Thu 9:00 AM", "Nov 12 9:00 AM". */
  label?: string
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6 }
const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type Span = [number, number]
type DayPart = 'morning' | 'afternoon' | 'evening' | 'tonight'
interface Found { span: Span }

const PATTERNS = {
  iso: /\b(\d{4})-(\d{2})-(\d{2})\b/,
  monthDay: /\b(?:on\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/,
  offset: /\bin\s+(an?|one|two|three|\d{1,3})\s+(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/,
  relDay: /\b(today|tonight|tomorrow|tmrw|this\s+(?:morning|afternoon|evening))\b/,
  nextWeek: /\bnext\s+week\b/,
  weekday: /\b(?:(?:next|this|on)\s+)?(sunday|monday|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday)\b/,
  ampm: /\b(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?=[^a-z]|$)/,
  clock24: /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/,
  bareHour: /\bat\s+(\d{1,2})\b(?!\s*(?:%|percent|[:.]\d))/,
  noon: /\b(?:at\s+)?(noon|midnight)\b/,
  part: /\b(?:in\s+the\s+)?(morning|afternoon|evening)\b/,
} as const

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 }

function find(re: RegExp, text: string, taken: Span[]): (RegExpExecArray & Found) | null {
  const global = new RegExp(re.source, 'g')
  for (let m = global.exec(text); m; m = global.exec(text)) {
    const span: Span = [m.index, m.index + m[0].length]
    if (taken.some(([a, b]) => span[0] < b && a < span[1])) continue
    return Object.assign(m, { span })
  }
  return null
}

function daysBetween(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split('-').map(Number), [ty, tm, td] = toDay.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}
function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}
const pad = (n: number) => String(n).padStart(2, '0')

/** "3:00 PM" for minutes past midnight. */
export function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`
}

/** The receipt's words for an instant, relative to now: today, tomorrow, a weekday within six days, else the date. */
export function whenLabel(atMs: number, nowMs: number, timezone: string): string {
  const at = localClock(atMs, timezone), now = localClock(nowMs, timezone)
  const ahead = daysBetween(now.day, at.day)
  const [y, mo, d] = at.day.split('-').map(Number)
  const day = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : ahead > 1 && ahead < 7 ? SHORT_DAY[at.weekday]
    : `${SHORT_DAY[at.weekday]} ${SHORT_MONTH[mo - 1]} ${d}${y !== Number(now.day.slice(0, 4)) ? `, ${y}` : ''}`
  return `${day} ${clockLabel(at.minutes)}`
}

function about(text: string, spans: Span[]): string {
  let out = text
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + ' ' + out.slice(b)
  out = out.replace(/\s+/g, ' ').trim()
  out = out.replace(/^(?:please\s+)?(?:remind\s+me|reminder|set\s+a\s+reminder|don'?t\s+let\s+me\s+forget)(?:\s*[:,-])?\s*/i, '')
  out = out.replace(/^(?:at|on|by)\s+/i, '').replace(/^(?:to|that|about)\s+/i, '').replace(/\s+(?:at|on|by)$/i, '')
  out = out.replace(/^[\s,.:;-]+|[\s,;:-]+$/g, '')
  return out
}

/**
 * Read a reminder time out of `text`. `nowMs` and `timezone` decide what "today", "Thursday" and "at 3" mean.
 * Never throws; anything it cannot read gives `at: null` and a reason.
 */
export function parseWhen(text: string, nowMs: number, timezone: string): WhenResult {
  const source = typeof text === 'string' ? text.slice(0, 2_000) : ''
  const lower = source.toLowerCase()
  const now = localClock(nowMs, timezone)
  const taken: Span[] = []
  const take = (m: (RegExpExecArray & Found) | null) => { if (m) taken.push(m.span); return m }

  // Times first, so "3:30" is never read as part of a date and "at 3" is not taken by the offset rule.
  let minutes: number | null = null
  let bareHour: number | null = null
  const ampm = take(find(PATTERNS.ampm, lower, taken))
  if (ampm) {
    const h = Number(ampm[1]), m = ampm[2] ? Number(ampm[2]) : 0
    if (h >= 1 && h <= 12) minutes = ((h % 12) + (ampm[3].startsWith('p') ? 12 : 0)) * 60 + m
  }
  let bareMinute = 0
  if (minutes === null) {
    const c = take(find(PATTERNS.clock24, lower, taken))
    // "15:00" and "09:30" are a 24-hour clock; "3:30" with no am/pm is a bare hour like "at 3".
    if (c && (Number(c[1]) > 12 || c[1].length === 2 && c[1].startsWith('0'))) minutes = Number(c[1]) * 60 + Number(c[2])
    else if (c) { bareHour = Number(c[1]); bareMinute = Number(c[2]) }
  }
  if (minutes === null) {
    const n = take(find(PATTERNS.noon, lower, taken))
    if (n) minutes = n[1] === 'noon' ? WHEN_DEFAULTS.noon : 0
  }
  if (minutes === null && bareHour === null) {
    const b = find(PATTERNS.bareHour, lower, taken)
    if (b && Number(b[1]) >= 0 && Number(b[1]) <= 23) { take(b); bareHour = Number(b[1]) }
  }

  // Offsets ("in 20 minutes") are a whole answer on their own unless they name days or weeks.
  const off = take(find(PATTERNS.offset, lower, taken))
  if (off) {
    const n = NUMBER_WORDS[off[1]] ?? Number(off[1]), unit = off[2]
    if (n >= 1) {
      if (/^(?:min|hour|hr)/.test(unit)) {
        const at = nowMs + n * (unit.startsWith('h') ? 3_600_000 : 60_000)
        return finish(source, taken, at, nowMs, timezone)
      }
      const day = shiftDay(now.day, n * (unit.startsWith('w') ? 7 : 1))
      return resolve(day, minutes ?? (bareHour !== null ? pmBias(bareHour) + bareMinute : now.minutes))
    }
  }

  // The day.
  let day: string | null = null
  let part: DayPart | null = null
  const iso = take(find(PATTERNS.iso, lower, taken))
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3])
    if (validDate(y, m, d)) day = `${y}-${pad(m)}-${pad(d)}`
  }
  if (!day) {
    const md = find(PATTERNS.monthDay, lower, taken)
    if (md) {
      const m = MONTHS[md[1].slice(0, 3)], d = Number(md[2])
      let y = md[3] ? Number(md[3]) : Number(now.day.slice(0, 4))
      if (validDate(y, m, d)) {
        take(md)
        let candidate = `${y}-${pad(m)}-${pad(d)}`
        if (!md[3] && daysBetween(now.day, candidate) < 0) { y += 1; candidate = validDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : candidate }
        day = candidate
      }
    }
  }
  if (!day) {
    const rel = take(find(PATTERNS.relDay, lower, taken))
    if (rel) {
      const word = rel[1]
      if (word === 'today') day = now.day
      else if (word === 'tonight') { day = now.day; part = 'tonight' }
      else if (word === 'tomorrow' || word === 'tmrw') day = shiftDay(now.day, 1)
      else { day = now.day; part = word.replace(/^this\s+/, '') as DayPart }
    }
  }
  if (!day && take(find(PATTERNS.nextWeek, lower, taken))) {
    // Next week means its Monday (the weekly check-in's day), 9:00 unless he gave a time.
    const toMonday = ((8 - now.weekday) % 7) || 7
    day = shiftDay(now.day, toMonday)
  }
  if (!day) {
    const wd = take(find(PATTERNS.weekday, lower, taken))
    if (wd) {
      const target = WEEKDAYS[wd[1]]
      const ahead = ((target - now.weekday) + 7) % 7 || 7  // today's weekday means next week
      day = shiftDay(now.day, ahead)
    }
  }
  if (!part) {
    const p = find(PATTERNS.part, lower, taken)
    if (p && (day || minutes !== null || bareHour !== null)) { take(p); part = p[1] as DayPart }
  }

  if (!day && minutes === null && bareHour === null && !part) return { at: null, reason: 'none', about: about(source, taken) }

  // A bare hour: the next time the clock shows it, or, on a later day, its daytime reading.
  if (minutes === null && bareHour !== null) {
    if (part === 'afternoon' || part === 'evening' || part === 'tonight') minutes = (bareHour % 12 + 12) * 60
    else if (part === 'morning') minutes = (bareHour % 12) * 60
    else if (bareHour > 12) minutes = bareHour * 60
    else if (!day || day === now.day) {
      const options = [bareHour % 12 * 60, (bareHour % 12 + 12) * 60].sort((a, b) => a - b)
      const next = options.find(o => o + bareMinute > now.minutes)
      if (next !== undefined) { minutes = next; day = day ?? now.day }
      else if (!day) { minutes = options[0]; day = shiftDay(now.day, 1) }
      else minutes = options[1]  // "today at 3" after 3 PM: refused as past below
    } else minutes = pmBias(bareHour)
    minutes += bareMinute
  }
  if (minutes === null) minutes = part ? WHEN_DEFAULTS[part] : WHEN_DEFAULTS.dayMinutes

  // A time with no day: the next time the clock shows it.
  if (!day) day = minutes > now.minutes ? now.day : shiftDay(now.day, 1)
  return resolve(day, minutes)

  function pmBias(h: number): number { return h >= 13 ? h * 60 : h === 12 ? 12 * 60 : h >= 7 ? h * 60 : (h + 12) * 60 }
  function resolve(d: string, mins: number): WhenResult {
    const at = taskInstant(d, mins, timezone)
    // Only an explicit day can land in the past ("today 3pm" at 4 PM): it is refused, never moved silently.
    if (at <= nowMs) return { at: null, reason: 'past', about: about(source, taken) }
    return finish(source, taken, at, nowMs, timezone)
  }
}

function finish(source: string, taken: Span[], at: number, nowMs: number, timezone: string): WhenResult {
  if (at - nowMs > WHEN_MAX_AHEAD_MS) return { at: null, reason: 'too_far', about: about(source, taken) }
  return { at, about: about(source, taken), label: whenLabel(at, nowMs, timezone) }
}

/** The three times COS offers when it could not read one (plan section 7): Tomorrow 9:00 and Monday 9:00. */
export function whenSuggestions(nowMs: number, timezone: string): Array<{ id: string; label: string; at: number }> {
  const now = localClock(nowMs, timezone)
  const tomorrow = taskInstant(shiftDay(now.day, 1), WHEN_DEFAULTS.dayMinutes, timezone)
  const toMonday = ((8 - now.weekday) % 7) || 7
  const monday = taskInstant(shiftDay(now.day, toMonday), WHEN_DEFAULTS.dayMinutes, timezone)
  const out = [{ id: 'tomorrow_9', label: 'Tomorrow 9:00', at: tomorrow }]
  if (monday !== tomorrow) out.push({ id: 'monday_9', label: 'Monday 9:00', at: monday })
  return out
}

/** Snooze targets for a fired reminder: one hour from now, and tomorrow 9:00. */
export function snoozeTargets(nowMs: number, timezone: string): { hour: number; tomorrow9: number } {
  const now = localClock(nowMs, timezone)
  return { hour: nowMs + 3_600_000, tomorrow9: taskInstant(shiftDay(now.day, 1), WHEN_DEFAULTS.dayMinutes, timezone) }
}

