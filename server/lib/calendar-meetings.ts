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
