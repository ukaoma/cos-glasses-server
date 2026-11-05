import { describe, expect, it } from 'vitest'
import { parseWhen, snoozeTargets, whenLabel, whenSuggestions, WHEN_DEFAULTS, WHEN_MAX_AHEAD_MS } from './drop-when.js'
import { taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
/** Local wall-clock instant in Chicago. */
const local = (day: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return taskInstant(day, h * 60 + m, TZ) }
// Wednesday 2026-11-04, 10:00 AM CST (after the Nov 1 DST end).
const WED_10AM = local('2026-11-04', '10:00')
const WED_4PM = local('2026-11-04', '16:00')

describe('parseWhen: reminder times read from his words (plan section 7)', () => {
  const rows: Array<[string, number, string, string | null, string?]> = [
    // [text, now, expected local day, expected HH:MM (null = asks), reason]
    ['remind me Thursday to send Gina the JCK numbers', WED_10AM, '2026-11-05', '09:00'],
    ['remind me Wednesday to call the bank', WED_10AM, '2026-11-11', '09:00'],            // today's weekday means next week
    ['remind me next wednesday to call the bank', WED_10AM, '2026-11-11', '09:00'],
    ['remind me friday at 3 to send the deck', WED_10AM, '2026-11-06', '15:00'],           // later day: 1 to 6 read as afternoon
    ['remind me friday at 8 to stretch', WED_10AM, '2026-11-06', '08:00'],                 // later day: 7 to 11 read as morning
    ['remind me at 3 to call Pete', WED_10AM, '2026-11-04', '15:00'],                      // bare hour: the next one
    ['remind me at 3 to call Pete', WED_4PM, '2026-11-05', '03:00'],
    ['remind me at 3:30 to call Pete', WED_10AM, '2026-11-04', '15:30'],
    ['remind me at 3pm to call Pete', WED_10AM, '2026-11-04', '15:00'],
    ['remind me at 3pm to call Pete', WED_4PM, '2026-11-05', '15:00'],                     // a time with no day: the next time the clock shows it
    ['call Pete 3:30 p.m.', WED_10AM, '2026-11-04', '15:30'],
    ['call Pete at 15:00', WED_10AM, '2026-11-04', '15:00'],
    ['call Pete at 09:15', WED_10AM, '2026-11-05', '09:15'],
    ['remind me today at 3pm', WED_10AM, '2026-11-04', '15:00'],
    ['remind me today at 3pm', WED_4PM, '', null, 'past'],                                 // explicit day already past: refused, never moved
    ['remind me tonight to take out the trash', WED_10AM, '2026-11-04', '20:00'],
    ['remind me tonight at 8 to take out the trash', WED_10AM, '2026-11-04', '20:00'],
    ['remind me tomorrow', WED_10AM, '2026-11-05', '09:00'],
    ['remind me tomorrow morning to email Silas', WED_10AM, '2026-11-05', '09:00'],
    ['remind me tomorrow afternoon', WED_10AM, '2026-11-05', '14:00'],
    ['remind me tomorrow evening at 7', WED_10AM, '2026-11-05', '19:00'],
    ['remind me tomorrow evening at 7:15', WED_10AM, '2026-11-05', '19:15'],
    ['remind me tomorrow evening at 07:15', WED_10AM, '2026-11-05', '07:15'],              // a zero-padded 24-hour clock is taken as said
    ['remind me this afternoon', WED_10AM, '2026-11-04', '14:00'],
    ['remind me this morning', WED_10AM, '', null, 'past'],
    ['remind me at noon', WED_10AM, '2026-11-04', '12:00'],
    ['remind me next week about the QBR', WED_10AM, '2026-11-09', '09:00'],
    ['remind me Nov 12 to renew', WED_10AM, '2026-11-12', '09:00'],
    ['remind me November 12th at 2pm to renew', WED_10AM, '2026-11-12', '14:00'],
    ['remind me Oct 3 to renew', WED_10AM, '2027-10-03', '09:00'],                          // a past date this year means next year
    ['remind me on 2026-12-01 to file', WED_10AM, '2026-12-01', '09:00'],
    ['remind me in 3 days to check the test', WED_10AM, '2026-11-07', '10:00'],
    ['remind me in 2 weeks at 9am', WED_10AM, '2026-11-18', '09:00'],
    ['remind me to call mom', WED_10AM, '', null, 'none'],
    ['remind me to send 3 follow-ups', WED_10AM, '', null, 'none'],                         // a number is not a time
    ['remind me at 30% battery', WED_10AM, '', null, 'none'],
    ['remind me on 2026-02-30', WED_10AM, '', null, 'none'],                                // not a date
    ['remind me 2028-01-01', WED_10AM, '', null, 'too_far'],
  ]
  it.each(rows)('%s', (text, now, day, hhmm, reason) => {
    const r = parseWhen(text, now, TZ)
    if (hhmm === null) {
      expect(r.at).toBeNull()
      expect(r.reason).toBe(reason)
    } else {
      expect(r.reason).toBeUndefined()
      expect(r.at).toBe(local(day, hhmm))
    }
  })

  it('reads minute and hour offsets from now exactly', () => {
    expect(parseWhen('remind me in 20 minutes to stand up', WED_10AM, TZ).at).toBe(WED_10AM + 20 * 60_000)
    expect(parseWhen('remind me in an hour', WED_10AM, TZ).at).toBe(WED_10AM + 3_600_000)
    expect(parseWhen('in two hours check the oven', WED_10AM, TZ).at).toBe(WED_10AM + 2 * 3_600_000)
  })

  it('keeps what it is about, without the time words or "remind me to"', () => {
    expect(parseWhen('remind me Thursday to send Gina the JCK numbers', WED_10AM, TZ).about).toBe('send Gina the JCK numbers')
    expect(parseWhen('Remind me at 3pm to call Pete', WED_10AM, TZ).about).toBe('call Pete')
    expect(parseWhen('send the deck to Jeremy tomorrow morning', WED_10AM, TZ).about).toBe('send the deck to Jeremy')
    expect(parseWhen('remind me to call mom', WED_10AM, TZ).about).toBe('call mom')
  })

  it('labels the receipt in his words', () => {
    expect(parseWhen('remind me at 3pm', WED_10AM, TZ).label).toBe('today 3:00 PM')
    expect(parseWhen('remind me tomorrow', WED_10AM, TZ).label).toBe('tomorrow 9:00 AM')
    expect(parseWhen('remind me Friday', WED_10AM, TZ).label).toBe('Fri 9:00 AM')
    expect(parseWhen('remind me Nov 12', WED_10AM, TZ).label).toBe('Thu Nov 12 9:00 AM')
    expect(parseWhen('remind me Oct 3', WED_10AM, TZ).label).toBe('Sun Oct 3, 2027 9:00 AM')
    expect(whenLabel(local('2026-11-04', '00:05'), WED_10AM - 12 * 3_600_000, TZ)).toBe('tomorrow 12:05 AM')
  })

  it('lands on 9:00 local across a DST change (spring forward 2027-03-14)', () => {
    const sat = local('2027-03-13', '10:00')
    expect(parseWhen('remind me Monday', sat, TZ).at).toBe(local('2027-03-15', '09:00'))
    // 02:30 does not exist on 3/14; it lands an hour later, never earlier than he asked.
    const r = parseWhen('remind me tomorrow at 2:30am', sat, TZ)
    expect(r.at).toBe(local('2027-03-14', '03:30'))
  })

  it('never throws on junk, and caps the read at 2,000 characters', () => {
    for (const junk of ['', '   ', 'at', 'in', 'in 0 minutes', '99:99', '\u0000', 'x'.repeat(10_000) + ' tomorrow']) {
      expect(() => parseWhen(junk, WED_10AM, TZ)).not.toThrow()
    }
    expect(parseWhen('x'.repeat(10_000) + ' tomorrow', WED_10AM, TZ).at).toBeNull()
    expect(parseWhen(undefined as unknown as string, WED_10AM, TZ).at).toBeNull()
  })

  it('pins the defaults and the one-year ceiling', () => {
    expect(WHEN_DEFAULTS).toEqual({ dayMinutes: 540, morning: 540, afternoon: 840, evening: 1080, tonight: 1200, noon: 720 })
    expect(WHEN_MAX_AHEAD_MS).toBe(366 * 86_400_000)
    expect(parseWhen('remind me in 52 weeks', WED_10AM, TZ).at).not.toBeNull()
    expect(parseWhen('remind me in 53 weeks', WED_10AM, TZ).reason).toBe('too_far')
  })
})

describe('whenSuggestions and snoozeTargets', () => {
  it('offers Tomorrow 9:00 and Monday 9:00, without a duplicate on Sunday', () => {
    expect(whenSuggestions(WED_10AM, TZ)).toEqual([
      { id: 'tomorrow_9', label: 'Tomorrow 9:00', at: local('2026-11-05', '09:00') },
      { id: 'monday_9', label: 'Monday 9:00', at: local('2026-11-09', '09:00') },
    ])
    const sunday = local('2026-11-08', '10:00')
    expect(whenSuggestions(sunday, TZ).map(s => s.id)).toEqual(['tomorrow_9'])
  })
  it('snoozes an hour, or to tomorrow 9:00', () => {
    expect(snoozeTargets(WED_4PM, TZ)).toEqual({ hour: WED_4PM + 3_600_000, tomorrow9: local('2026-11-05', '09:00') })
  })
})
