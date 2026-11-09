import { describe, expect, it } from 'vitest'
import { CALENDAR_HOLD_WORDS, distinctMeetings, isCalendarHold, isCanceledMeeting, meetingKey } from './calendar-meetings.js'

// Today round 2 follow-up: one helper for "is this a distinct, real meeting", shared by the calendar API and the summary.
describe('calendar-meetings', () => {
  const f = (r: { title: string; start: string; status?: string; canceled?: boolean }) => r
  it('canceled: a "Canceled:" or "Cancelled:" title, a canceled status, or canceled: true; nothing else', () => {
    expect(isCanceledMeeting({ title: 'Canceled: Consolidated Forecast', start: '' })).toBe(true)
    expect(isCanceledMeeting({ title: '  cancelled:  Sync', start: '' })).toBe(true)
    expect(isCanceledMeeting({ title: 'Sync', start: '', status: 'Canceled' })).toBe(true)
    expect(isCanceledMeeting({ title: 'Sync', start: '', canceled: true })).toBe(true)
    expect(isCanceledMeeting({ title: 'Why we canceled: a review', start: '' })).toBe(false)
    expect(isCanceledMeeting({ title: 'Sync', start: '', status: 'confirmed' })).toBe(false)
  })
  it('the same title (case, spaces) at the same instant is one meeting; another start is another; order is kept', () => {
    const rows = [
      f({ title: 'Consolidated Forecast - Funnel Analysis', start: '2026-11-09T15:30:00.000Z' }),
      f({ title: 'consolidated  forecast - funnel analysis ', start: '2026-11-09T15:30:00Z' }),
      f({ title: 'Canceled: Consolidated Forecast', start: '2026-11-09T16:30:00Z' }),
      f({ title: 'Consolidated Forecast - Funnel Analysis', start: '2026-11-09T17:30:00Z' }),
      f({ title: 'Weatherford - CatchUp', start: '2026-11-09T14:30:00Z' }),
    ]
    expect(distinctMeetings(rows, r => r).map(r => r.start)).toEqual(['2026-11-09T15:30:00.000Z', '2026-11-09T17:30:00Z', '2026-11-09T14:30:00Z'])
    expect(meetingKey({ title: 'A', start: '2026-11-09T15:30:00Z' })).toBe(meetingKey({ title: ' a ', start: Date.parse('2026-11-09T15:30:00Z') }))
  })

  // Prep on every Next up row (Miles 11/09): no Prep on a hold or status block. One list, read by the API's `hold`.
  it('a hold: the title starts with a hold word or phrase, whole word, any case, after leading punctuation', () => {
    for (const t of ['Blocked', 'Busy', 'Hold', 'HOLD - pricing', '[Hold] Weatherford', 'Focus', 'Focus time', 'Travel', 'Travel to Waco',
      'Personal', 'OOO', 'Out of office', 'Lunch', '  lunch  ', 'Do not book', 'PTO', 'Commute', '* Busy']) expect(isCalendarHold(t), t).toBe(true)
  })
  it('not a hold: a real meeting, a hold word inside a longer word or later in the title, or a named "with"', () => {
    for (const t of ['Weatherford - CatchUp', 'Pipeline review', 'Holdings call', 'Busybody sync', 'Unblocked review', 'Review the hold queue',
      'Lunch with Jeremy', 'Focus group with the Jewel360 board', 'Travel with Queen', '', '   ']) expect(isCalendarHold(t), t).toBe(false)
    expect(isCalendarHold(undefined)).toBe(false)
    expect(isCalendarHold(42)).toBe(false)
  })
  it('the list names every status block Miles named', () => {
    for (const w of ['blocked', 'busy', 'hold', 'focus', 'travel', 'personal', 'ooo', 'lunch']) expect(CALENDAR_HOLD_WORDS).toContain(w)
  })
})
