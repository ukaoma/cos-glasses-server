/**
 * Today round 2 (2026-11-09): which calendar rows are distinct, real meetings. ONE helper for the calendar API
 * (calendar-source.ts calendarToday: next, remainingCount, endedRecently) and the Today summary (today-brief.ts
 * withCalendar), so the two never disagree.
 *
 * - Canceled: a title that starts "Canceled:" or "Cancelled:" (how Exchange and Google rename a canceled occurrence),
 *   or a row whose `status` says canceled, or `canceled: true` (the snapshot's EventKit status, when it carries one;
 *   the 11/09 snapshot had no status field on any of its 154 events).
 * - Distinct: the same title (trimmed, case-folded, spaces collapsed) at the same start is one meeting, whichever
 *   calendar it is on. The 11/09 live snapshot had 13 such pairs or triples, 12 of them on ONE Exchange calendar with
 *   different external ids (the same invite delivered twice), so "across calendars" alone would have left 12 of them.
 *   The first row of each wins, so callers keep their own order.
 * No dependencies: the summary imports it without the calendar reader.
 */
export const CANCELED_TITLE = /^\s*(?:canceled|cancelled)\s*:/i
const CANCELED_STATUS = new Set(['canceled', 'cancelled'])

export interface MeetingFields { title: unknown; start: unknown; status?: unknown; canceled?: unknown }

export function isCanceledMeeting(row: MeetingFields): boolean {
  if (row.canceled === true) return true
  if (typeof row.status === 'string' && CANCELED_STATUS.has(row.status.trim().toLowerCase())) return true
  return typeof row.title === 'string' && CANCELED_TITLE.test(row.title)
}

/** The identity of one meeting: its title and its start instant. */
export function meetingKey(row: MeetingFields): string {
  const title = typeof row.title === 'string' ? row.title.trim().toLowerCase().replace(/\s+/g, ' ') : ''
  const start = typeof row.start === 'number' ? row.start : Date.parse(String(row.start ?? ''))
  return `${title}|${Number.isFinite(start) ? start : String(row.start ?? '')}`
}

/** The rows that are real meetings, one per meeting, in the order given. */
export function distinctMeetings<T>(rows: readonly T[], fields: (row: T) => MeetingFields): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    const f = fields(row)
    if (isCanceledMeeting(f)) continue
    const key = meetingKey(f)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/**
 * Prep on every Next up row (Miles typed 2026-11-09 13:00 CST): a calendar hold or status block is not a meeting to
 * prep for. ONE list for the server: /api/calendar/today marks each row `hold`, /api/welcome-context marks nextEvent
 * `hold`, and Control Web and desktop Control read that flag instead of keeping their own copy of the words.
 *
 * A title is a hold when, after leading punctuation ("[Hold] ...", "* Busy"), it starts with one of these words or
 * phrases as a whole word, and it does not name someone with "with" ("Lunch with Jeremy" and "Focus group with the
 * Jewel360 board" are meetings). Case and repeated spaces do not matter. A false "not a hold" only offers Prep on a hold;
 * a false "hold" would hide Prep on a real meeting, so the rule stays narrow.
 */
export const CALENDAR_HOLD_WORDS: readonly string[] = Object.freeze([
  'blocked', 'block', 'busy', 'hold', 'holds', 'focus', 'travel', 'personal', 'private', 'ooo', 'out of office', 'lunch',
  'pto', 'vacation', 'commute', 'dnd', 'do not book', 'do not schedule',
])
// Letters and single spaces only, so the words need no escaping.
const HOLD_START = new RegExp(`^(?:${CALENDAR_HOLD_WORDS.join('|')})(?![a-z0-9])`)

export function isCalendarHold(title: unknown): boolean {
  if (typeof title !== 'string') return false
  const t = title.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[^a-z0-9]+/, '')
  if (!t || !HOLD_START.test(t)) return false
  return !/(?:^|[^a-z0-9])with(?![a-z0-9])/.test(t)
}
