import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ available: false, answer: null as unknown, calls: 0 }))
vi.mock('./python-bridge.js', () => ({
  pythonBridgeAvailable: () => bridge.available,
  callPython: async () => { bridge.calls += 1; return bridge.answer },
}))

import {
  calendarStatus, calendarToday, dedupeEvents, endedRecently, isPrepWorthy, parseSnapshot, readCalendar, readSnapshot,
  resetCalendarSourceCache, snapshotToBridgeShape, type CalendarSnapshot, type SnapshotCalendar, type SnapshotEvent,
} from './calendar-source.js'
import { parseFeedItem } from './drop-store.js'
import { prepCandidates } from './ping-sources.js'
import { bridgeOccurrence } from '../routes/welcome-context.js'

const HOUR = 3600_000
// A fixed weekday, 09:00 local.
const NOW = new Date(2026, 10, 9, 9, 0, 0).getTime()
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 9 + dayOffset, h, m, 0).toISOString()

const cal = (over: Partial<SnapshotCalendar> = {}): SnapshotCalendar => ({
  id: 'cal-work', title: 'Work', account: 'miles@example.com', sourceType: 'exchange', shared: false, selected: true, ...over,
})
const ev = (over: Partial<SnapshotEvent> = {}): SnapshotEvent => ({
  calendarId: 'cal-work', eventId: 'evt-1', externalId: 'ext-1', occurrenceStart: at(10), start: at(10), end: at(10, 30),
  allDay: false, floating: false, title: 'Pipeline review', myStatus: 'accepted', isOrganizer: false,
  attendees: [{ name: 'Pat', domain: 'example.com' }], meetingUrl: null, ...over,
})
const snap = (over: Partial<CalendarSnapshot> = {}): CalendarSnapshot => ({
  version: 1, writtenAt: new Date(NOW - 5 * 60_000).toISOString(), windowStart: at(0, 0, -1), windowEnd: at(0, 0, 7),
  access: 'granted', calendars: [cal()], events: [ev()], ...over,
})

let dir: string
let file: string
function writeSnap(s: unknown) {
  writeFileSync(file, JSON.stringify(s))
  resetCalendarSourceCache()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cal-src-'))
  mkdirSync(join(dir, 'calendar'), { recursive: true })
  file = join(dir, 'calendar', 'snapshot.json')
  bridge.available = false
  bridge.answer = { events: [] }
  bridge.calls = 0
  resetCalendarSourceCache()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })

describe('parseSnapshot', () => {
  it('rejects a bad envelope and drops rows for unknown calendars', () => {
    expect(parseSnapshot({ version: 2 })).toBeNull()
    expect(parseSnapshot(null)).toBeNull()
    const s = parseSnapshot({ ...snap(), events: [ev(), ev({ calendarId: 'nope' })] })!
    expect(s.events).toHaveLength(1)
  })
  it('never keeps a full email address as an attendee name (on-device finding 2026-11-07)', () => {
    const s = parseSnapshot({ ...snap(), events: [ev({ attendees: [{ name: 'pat.lee@example.com', domain: 'example.com' }, { name: 'Pat Lee', domain: 'example.com' }] })] })!
    expect(s.events[0].attendees).toEqual([{ name: null, domain: 'example.com' }, { name: 'Pat Lee', domain: 'example.com' }])
    const shape = snapshotToBridgeShape(s, NOW) as { today_events: Array<{ attendees: string[] }> }
    expect(JSON.stringify(shape)).not.toContain('pat.lee@')
  })

  it('keeps meeting links only for allowlisted hosts', () => {
    const s = parseSnapshot({ ...snap(), events: [ev({ meetingUrl: 'https://evil.example/zoom.us' }), ev({ eventId: 'e2', meetingUrl: 'https://acme.zoom.us/j/1' })] })!
    expect(s.events.map(e => e.meetingUrl)).toEqual([null, 'https://acme.zoom.us/j/1'])
  })
  it('a tombstone carries no events whatever the file says (P1-9)', () => {
    const s = parseSnapshot({ ...snap(), access: 'denied' })!
    expect(s.access).toBe('denied')
    expect(s.events).toEqual([])
    expect(s.calendars).toEqual([])
  })
})

describe('staleness rule', () => {
  it('no snapshot file keeps the pre-P1 bridge path', async () => {
    const r = await readCalendar(1000, NOW)
    expect(r.source).toBe('bridge')
    expect(bridge.calls).toBe(1)
    expect(readSnapshot(NOW, file).state).toBe('missing')
  })

  it('<= 2 h uses the snapshot without asking the bridge', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    const s = snap(); writeSnap(s)
    expect(readSnapshot(NOW, file).state).toBe('fresh')
  })

  it('> 2 h with the bridge reading uses the bridge (P1-6)', async () => {
    writeSnap(snap({ writtenAt: new Date(NOW - 3 * HOUR).toISOString() }))
    expect(readSnapshot(NOW, file).state).toBe('aging')
  })

  it('> 24 h, past windowEnd, or denied is none', () => {
    writeSnap(snap({ writtenAt: new Date(NOW - 25 * HOUR).toISOString() }))
    expect(readSnapshot(NOW, file).state).toBe('expired')
    writeSnap(snap({ windowEnd: new Date(NOW - 1000).toISOString() }))
    expect(readSnapshot(NOW, file).state).toBe('expired')
    writeSnap(snap({ access: 'denied' }))
    expect(readSnapshot(NOW, file).state).toBe('denied')
  })

  it('COS_CALENDAR_SNAPSHOT=0 ignores the file', () => {
    writeSnap(snap())
    vi.stubEnv('COS_CALENDAR_SNAPSHOT', '0')
    expect(readSnapshot(NOW, file).state).toBe('missing')
  })
})

describe('selection and dedupe', () => {
  it('an unselected calendar contributes 0 events (P1-2)', () => {
    const s = snap({
      calendars: [cal(), cal({ id: 'cal-ics', title: 'Team ICS', sourceType: 'subscription', selected: false })],
      events: [ev(), ev({ calendarId: 'cal-ics', eventId: 'x', externalId: 'x', title: 'Subscribed event' })],
    })
    const shape = snapshotToBridgeShape(s, NOW) as { today_events: Array<{ title: string }> }
    expect(shape.today_events.map(e => e.title)).toEqual(['Pipeline review'])
    s.calendars[1].selected = true
    const after = snapshotToBridgeShape(s, NOW) as { today_events: Array<{ title: string }> }
    expect(after.today_events.map(e => e.title)).toContain('Subscribed event')
  })

  it('the same meeting on Exchange and Gmail appears once; two holds on one calendar both stay (P1-4)', () => {
    const exchange = ev()
    const gmail = ev({ calendarId: 'cal-gmail', eventId: 'g1', externalId: 'ext-1' })
    expect(dedupeEvents([exchange, gmail])).toHaveLength(1)
    const holdA = ev({ eventId: 'h1', externalId: 'h1', title: 'Busy', attendees: [] })
    const holdB = ev({ eventId: 'h2', externalId: 'h2', title: 'Busy', attendees: [] })
    expect(dedupeEvents([holdA, holdB])).toHaveLength(2)
    // Two identical-looking events on ONE calendar (two interview slots, same panel) are two events.
    const slotA = ev({ eventId: 's1', externalId: 's1', title: 'Interview' })
    const slotB = ev({ eventId: 's2', externalId: 's2', title: 'Interview' })
    expect(dedupeEvents([slotA, slotB])).toHaveLength(2)
    // The same shape on a SECOND calendar with the same attendee domains is the cross-account copy.
    expect(dedupeEvents([slotA, { ...slotB, calendarId: 'cal-gmail' }])).toHaveLength(1)
    // Same title and time on two calendars but no organizer signature: never merged by shape.
    expect(dedupeEvents([holdA, { ...holdB, calendarId: 'cal-gmail' }])).toHaveLength(2)
  })

  // QA 7.0.0 (Codex root-skeptic, root-completionist): the shape fallback keyed on the set of attendee DOMAINS, so two
  // different meetings at one time with different people from one company merged, and which survived was input order.
  it('two different meetings with one title and time, different people from the same company, stay two', () => {
    const a = ev({ eventId: 'w1', externalId: 'ext-a', title: 'Weekly sync', attendees: [{ name: 'Pat Lee', domain: 'example.com' }] })
    const b = ev({ calendarId: 'cal-gmail', eventId: 'w2', externalId: 'ext-b', title: 'Weekly sync', attendees: [{ name: 'Sam Roe', domain: 'example.com' }] })
    expect(dedupeEvents([a, b]).map(e => e.eventId)).toEqual(['w1', 'w2'])
    expect(dedupeEvents([b, a]).map(e => e.eventId)).toEqual(['w2', 'w1'])
    // Domain-only attendees (an email-shaped name was dropped) are no evidence of the same meeting either.
    const c = ev({ eventId: 'w3', externalId: 'ext-c', title: 'Weekly sync', attendees: [{ name: null, domain: 'example.com' }] })
    const d = ev({ calendarId: 'cal-gmail', eventId: 'w4', externalId: 'ext-d', title: 'Weekly sync', attendees: [{ name: null, domain: 'example.com' }] })
    expect(dedupeEvents([c, d])).toHaveLength(2)
  })

  it('the same meeting on two accounts merges on a shared named attendee or the same meeting link, never on time alone', () => {
    const url = 'https://acme.zoom.us/j/123'
    const exchange = ev({ eventId: 'x1', externalId: 'exch-1', title: 'Pipeline Review ', attendees: [{ name: 'Pat Lee', domain: 'example.com' }], meetingUrl: url })
    // Gmail drops the display name and keeps a different external id; the link is the same meeting.
    const gmail = ev({ calendarId: 'cal-gmail', eventId: 'g1', externalId: 'goog-1', title: 'pipeline review', attendees: [{ name: null, domain: 'example.com' }], meetingUrl: url + '?pwd=abc' })
    expect(dedupeEvents([exchange, gmail]).map(e => e.eventId)).toEqual(['x1'])
    const gmailNamed = { ...gmail, meetingUrl: null, attendees: [{ name: 'pat lee', domain: 'EXAMPLE.com' }] }
    expect(dedupeEvents([exchange, gmailNamed]), 'a shared named attendee').toHaveLength(1)
    expect(dedupeEvents([exchange, { ...gmailNamed, end: at(11) }]), 'a different end is another meeting').toHaveLength(2)
    expect(dedupeEvents([exchange, { ...gmail, meetingUrl: 'https://acme.zoom.us/j/999' }]), 'another link, no shared name').toHaveLength(2)
    // On ONE calendar even the same link stays two (two holds, two slots).
    expect(dedupeEvents([exchange, { ...exchange, eventId: 'x2', externalId: 'exch-2' }])).toHaveLength(2)
  })

  it('a weekly meeting has a distinct occurrence per week and a moved one keeps its own (P1-3)', () => {
    const wk1 = bridgeOccurrence({ provider: 'eventkit', calendar_id: 'cal-work', event_id: 'series', external_id: 'ext', occurrence_start: at(10), start_time: at(10) })!
    const wk2 = bridgeOccurrence({ provider: 'eventkit', calendar_id: 'cal-work', event_id: 'series', external_id: 'ext', occurrence_start: at(10, 0, 7), start_time: at(10, 0, 7) })!
    const wk1Moved = bridgeOccurrence({ provider: 'eventkit', calendar_id: 'cal-work', event_id: 'series', external_id: 'ext', occurrence_start: at(10), start_time: at(14) })!
    expect(wk1.key).not.toBe(wk2.key)
    expect(wk1Moved.key).toBe(wk1.key)
  })
})

describe('prep filter (P1-8)', () => {
  it('declined, all-day, multi-day, holiday and family travel never qualify', () => {
    const work = cal()
    expect(isPrepWorthy(ev(), work)).toBe(true)
    expect(isPrepWorthy(ev({ myStatus: 'declined' }), work)).toBe(false)
    expect(isPrepWorthy(ev({ allDay: true }), work)).toBe(false)
    expect(isPrepWorthy(ev({ end: at(10, 0, 2) }), work)).toBe(false)
    expect(isPrepWorthy(ev(), cal({ title: 'US Holidays', sourceType: 'subscription' }))).toBe(false)
    expect(isPrepWorthy(ev(), cal({ sourceType: 'birthdays', title: 'Birthdays' }))).toBe(false)
    expect(isPrepWorthy(ev({ title: 'Flight to Austin (WN 2528)', attendees: [] }), cal({ title: 'Family', sourceType: 'caldav' }))).toBe(false)
    expect(isPrepWorthy(ev({ attendees: [] }), cal({ shared: true }))).toBe(false)
  })

  it('next_event skips a declined meeting for the next real one', () => {
    const s = snap({ events: [ev({ myStatus: 'declined', title: 'Declined sync' }), ev({ eventId: 'e2', externalId: 'e2', start: at(11), occurrenceStart: at(11), end: at(11, 30), title: 'Real meeting' })] })
    const shape = snapshotToBridgeShape(s, NOW) as { next_event: { title: string } | null }
    expect(shape.next_event?.title).toBe('Real meeting')
  })
})

// QA 7.0.0 (Codex root-skeptic): tomorrow ended 24 h after today's midnight, and a DST day is 23 or 25 hours.
describe('tomorrow is a calendar day in local time', () => {
  it('fall back (a 25 h tomorrow): a 23:30 event tomorrow counts, and 00:15 the day after does not', () => {
    vi.stubEnv('TZ', 'America/Chicago')
    const now = new Date(2026, 9, 31, 9, 0).getTime()   // Sat Oct 31; Sun Nov 1 2026 has 25 hours
    const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString()
    const events = [ev({ eventId: 'late', externalId: 'late', start: t(32, 23, 30), occurrenceStart: t(32, 23, 30), end: t(32, 23, 50) }),
      ev({ eventId: 'after', externalId: 'after', start: t(33, 0, 15), occurrenceStart: t(33, 0, 15), end: t(33, 0, 45) })]
    const s = snap({ writtenAt: new Date(now - 60_000).toISOString(), windowStart: t(30, 0), windowEnd: t(38, 0), events })
    expect((snapshotToBridgeShape(s, now) as { tomorrow_events_count: number }).tomorrow_events_count).toBe(1)
  })
  it('spring forward (a 23 h tomorrow): 00:30 the day after is not tomorrow', () => {
    vi.stubEnv('TZ', 'America/Chicago')
    const now = new Date(2026, 2, 7, 9, 0).getTime()   // Sat Mar 7; Sun Mar 8 2026 has 23 hours
    const t = (d: number, h: number, m = 0) => new Date(2026, 2, d, h, m).toISOString()
    const events = [ev({ eventId: 'late', externalId: 'late', start: t(8, 23, 30), occurrenceStart: t(8, 23, 30), end: t(8, 23, 50) }),
      ev({ eventId: 'after', externalId: 'after', start: t(9, 0, 30), occurrenceStart: t(9, 0, 30), end: t(9, 1) })]
    const s = snap({ writtenAt: new Date(now - 60_000).toISOString(), windowStart: t(6, 0), windowEnd: t(14, 0), events })
    expect((snapshotToBridgeShape(s, now) as { tomorrow_events_count: number }).tomorrow_events_count).toBe(1)
  })
})

describe('readCalendar through the data dir', () => {
  it('fresh snapshot answers without the bridge; tombstone gives none within one read (P1-9)', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(snap()))
    mod.resetCalendarSourceCache()
    const r = await mod.readCalendar(1000, NOW)
    expect(r.source).toBe('snapshot')
    expect(bridge.calls).toBe(0)
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify({ ...snap(), access: 'denied', writtenAt: new Date(NOW).toISOString() }))
    mod.resetCalendarSourceCache()
    const denied = await mod.readCalendar(1000, NOW)
    expect(denied.source).toBe('none')
    expect((denied.data as { error?: string }).error).toBe('calendar_access_denied')
  })

  it('aging snapshot defers to a reading bridge, else is labeled stale (P1-6)', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(snap({ writtenAt: new Date(NOW - 3 * HOUR).toISOString() })))
    mod.resetCalendarSourceCache()
    bridge.available = true
    bridge.answer = { today_events: [], data_source: 'cache' }
    expect((await mod.readCalendar(1000, NOW)).source).toBe('bridge')
    bridge.available = false
    const stale = await mod.readCalendar(1000, NOW)
    expect(stale.source).toBe('snapshot-stale')
    expect((stale.data as { is_stale: boolean }).is_stale).toBe(true)
  })

  // QA 7.0.0 (Codex root-user W2): the 3 were taken before all-day and declined events were dropped, so a day of
  // all-day events left Today's "Later" empty while timed meetings were still to come.
  it('today takes the next 5 timed meetings that count: all-day and declined events never use up a slot', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    const allDay = [1, 2, 3].map(i => ev({ eventId: `ad${i}`, externalId: `ad${i}`, allDay: true, start: at(0), occurrenceStart: at(0), end: at(0, 0, 1), title: `All day ${i}` }))
    const declined = ev({ eventId: 'dec', externalId: 'dec', myStatus: 'declined', start: at(9, 30), occurrenceStart: at(9, 30), end: at(10), title: 'Declined' })
    const timed = [11, 12, 13, 14, 15, 16].map(h => ev({ eventId: `t${h}`, externalId: `t${h}`, start: at(h), occurrenceStart: at(h), end: at(h, 30), title: `Meeting ${h}` }))
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(snap({ events: [...allDay, declined, ...timed] })))
    mod.resetCalendarSourceCache()
    const today = await mod.calendarToday(NOW)
    // Today round 2 (Miles 11/09): 5, was 3; remainingCount still counts all six.
    expect(today.next.map(n => n.title)).toEqual(['Meeting 11', 'Meeting 12', 'Meeting 13', 'Meeting 14', 'Meeting 15'])
    expect(today.remainingCount).toBe(6)
  })

  it('a bridge answer without prep_worthy: all-day rows still never use up a slot', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    bridge.available = true
    const row = (title: string, h: number, allDay = false) => ({ title, start_time: at(h), end_time: at(h, 30), is_all_day: allDay, calendar_name: 'Work', meeting_url: null })
    bridge.answer = { today_remaining: [row('AD 1', 0, true), row('AD 2', 0, true), row('AD 3', 0, true), row('Bridge 11', 11), row('Bridge 12', 12)], meetings_remaining_count: 5 }
    const today = await mod.calendarToday(NOW)
    expect(today.source).toBe('bridge')
    expect(today.next.map(n => n.title)).toEqual(['Bridge 11', 'Bridge 12'])
  })

  it('no snapshot and no bridge is "not connected", never an empty day', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    const today = await mod.calendarToday(NOW)
    expect(today.connected).toBe(false)
  })

  it('today returns selected calendars only, the next 5, and status is counts only (P1-7)', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    const events = [10, 11, 12, 13].map(h => ev({ eventId: `e${h}`, externalId: `e${h}`, start: at(h), occurrenceStart: at(h), end: at(h, 30), title: `UNIQUE-SEED-${h}` }))
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(snap({ events })))
    mod.resetCalendarSourceCache()
    const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), err = vi.spyOn(console, 'error')
    const today = await mod.calendarToday(NOW)
    expect(today.connected).toBe(true)
    expect(today.next.map(n => n.title)).toEqual(['UNIQUE-SEED-10', 'UNIQUE-SEED-11', 'UNIQUE-SEED-12', 'UNIQUE-SEED-13'])
    expect(today.remainingCount).toBe(4)
    const status = mod.calendarStatus(NOW)
    expect(status).toMatchObject({ source: 'snapshot', snapshot: 'fresh', access: 'granted', calendars: 1, selected: 1 })
    expect(JSON.stringify(status)).not.toContain('UNIQUE-SEED')
    const logged = [...log.mock.calls, ...warn.mock.calls, ...err.mock.calls].flat().map(String).join('\n')
    expect(logged).not.toContain('UNIQUE-SEED')
  })
})

const feed = (over: Record<string, unknown>) => ({
  id: 'fi_' + 'a'.repeat(32), kind: 'ping', threadId: 'drop-thread', createdAt: new Date(NOW).toISOString(), readAt: null,
  source: 'cos', links: [], state: 'live', key: 'prep:test', ...over,
})

describe('B5: occurrence survives the ping and feed round trip (P1-5)', () => {
  it('a prep ping carries a non-null occurrence through parseFeedItem', () => {
    const occurrence = bridgeOccurrence({ provider: 'eventkit', account: 'miles@example.com', calendar_id: 'cal-work', event_id: 'evt-1', external_id: 'ext-1', occurrence_start: at(9, 10), start_time: at(9, 10) })!
    const [cand] = prepCandidates({ title: 'Pipeline review', time: at(9, 10), occurrence }, NOW, Intl.DateTimeFormat().resolvedOptions().timeZone)
    const prep = cand.actions.find(a => a.id === 'prep')!.prep!
    expect(prep.occurrence?.key).toBe(occurrence.key)
    const item = parseFeedItem(feed({ title: cand.title, line: cand.line, actions: cand.actions }))
    const back = item.actions?.find(a => a.id === 'prep')?.prep
    expect(back?.occurrence?.key).toBe(occurrence.key)
  })

  it('a null occurrence still round-trips as null, and a forged one drops to null', () => {
    const [cand] = prepCandidates({ title: 'Bridge meeting', time: at(9, 10) }, NOW, 'America/Chicago')
    expect(cand.actions[0].prep?.occurrence).toBeNull()
    const item = parseFeedItem(feed({ title: 't', line: 'l', actions: [{ id: 'prep', label: 'Prep me', prep: { title: 't', startsAt: at(9, 10), occurrence: { provider: 'nope' } } }] }))
    expect(item.actions?.[0].prep?.occurrence).toBeNull()
  })
})

// Silence unused-import lint for helpers only some tests call.
void calendarStatus; void calendarToday

// ---------------------------------------------------------------------------
// Week-wide QA (1-8 Nov), calendar findings W20, W21 and W23.
// ---------------------------------------------------------------------------

// W20: Connect with nothing picked wrote a granted snapshot with zero selected calendars, and the server read it as a
// fresh, final, EMPTY day instead of asking the bridge. Granted with nothing selected is "not set up yet".
describe('W20: granted with zero calendars selected is not configured', () => {
  const unpicked = () => snap({ calendars: [cal({ selected: false }), cal({ id: 'cal-fam', title: 'Family', selected: false })] })

  it('readSnapshot reports unselected, never fresh', () => {
    writeSnap(unpicked())
    expect(readSnapshot(NOW, file).state).toBe('unselected')
    writeSnap(snap({ calendars: [], events: [] }))
    expect(readSnapshot(NOW, file).state).toBe('unselected')
    // One pick makes it a real (possibly empty) day again.
    writeSnap(snap({ calendars: [cal({ selected: false }), cal({ id: 'cal-fam', title: 'Family', selected: true })] }))
    expect(readSnapshot(NOW, file).state).toBe('fresh')
  })

  it('readCalendar keeps the previous source (the bridge) until the first selection', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(unpicked()))
    mod.resetCalendarSourceCache()
    bridge.available = true
    bridge.answer = { today_events: [{ title: 'From the bridge' }], today_remaining: [], data_source: 'cache' }
    const r = await mod.readCalendar(1000, NOW)
    expect(r.source).toBe('bridge')
    expect(bridge.calls).toBe(1)
    expect(mod.calendarStatus(NOW)).toMatchObject({ snapshot: 'unselected', selected: 0 })
  })

  it('with no bridge either, Today is "not connected", never an empty connected day', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(unpicked()))
    mod.resetCalendarSourceCache()
    const today = await mod.calendarToday(NOW)
    expect(today.connected).toBe(false)
    expect(today.source).toBe('bridge')
  })
})

// W21: the server read the snapshot unless the switch was 0; calendar_context.py read it only when it was 1. One
// polarity now: on unless COS_CALENDAR_SNAPSHOT is 0 (after trimming). The same table runs against both readers.
const SNAPSHOT_SWITCH_TABLE: Array<[string | undefined, boolean]> = [
  [undefined, true], ['', true], ['1', true], ['0', false], [' 0 ', false], ['0\n', false],
  ['false', true], ['off', true], ['00', true], ['01', true],
]

describe('W21: one COS_CALENDAR_SNAPSHOT polarity', () => {
  it('server: on by default, only 0 turns it off', async () => {
    const { snapshotReadingEnabled } = await import('./calendar-source.js')
    for (const [value, on] of SNAPSHOT_SWITCH_TABLE) {
      const env = value === undefined ? {} : { COS_CALENDAR_SNAPSHOT: value }
      expect(snapshotReadingEnabled(env as NodeJS.ProcessEnv), JSON.stringify(value)).toBe(on)
    }
  })

  const scripts = muScriptsDir()
  it.runIf(scripts !== null)('parity: calendar_context.snapshot_reading_enabled agrees on every row', () => {
    const cases = SNAPSHOT_SWITCH_TABLE.map(([v]) => (v === undefined ? {} : { COS_CALENDAR_SNAPSHOT: v }))
    const code = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(scripts)})`,
      'import calendar_context as c',
      'print(json.dumps([c.snapshot_reading_enabled(e) for e in json.loads(sys.argv[1])]))',
    ].join('\n')
    const out = execFileSync(join(scripts!, 'venv', 'bin', 'python3'), ['-c', code, JSON.stringify(cases)], {
      encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', COS_DATA_DIR: dir },
    })
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual(SNAPSHOT_SWITCH_TABLE.map(([, on]) => on))
  })
  it.runIf(scripts === null)('parity pin skipped: MU operations/scripts not reachable (set COS_SCRIPTS_DIR)', () => {
    // Not a pass: the parity pin could not run here.
    expect(scripts).toBeNull()
  })
})

// W23: family suppression was an exact "Family" title or a shared calendar, so a flight on another editable calendar
// (iCloud "Calendar", a TripIt import) still became Next up and prep.
describe('W23: travel and family events never become prep', () => {
  it('an attendee-less flight on any calendar never qualifies; one with attendees on a work calendar still does', () => {
    const icloud = cal({ id: 'cal-icloud', title: 'Calendar', sourceType: 'caldav' })
    expect(isPrepWorthy(ev({ title: 'Flight to Austin (WN 2528)', attendees: [] }), icloud)).toBe(false)
    expect(isPrepWorthy(ev({ title: 'AA 1146 DFW to AUS', attendees: [] }), cal())).toBe(false)
    expect(isPrepWorthy(ev({ title: 'Flight plan review', attendees: [{ name: 'Gina', domain: 'example.com' }] }), cal())).toBe(true)
    // An attendee-less hold on the owner's own calendar is unchanged.
    expect(isPrepWorthy(ev({ title: 'Focus block', attendees: [] }), cal())).toBe(true)
  })

  it('a family calendar under any name, and travel on it even with attendees, never qualifies', () => {
    expect(isPrepWorthy(ev({ title: 'Dinner', attendees: [] }), cal({ title: 'Ukaoma Family', sourceType: 'caldav' }))).toBe(false)
    expect(isPrepWorthy(ev({ title: 'Dinner', attendees: [] }), cal({ title: 'family calendar ', sourceType: 'caldav' }))).toBe(false)
    expect(isPrepWorthy(ev({ title: 'Flight home (UA 512)', attendees: [{ name: 'Queen', domain: 'example.com' }] }), cal({ title: 'Family', sourceType: 'caldav' }))).toBe(false)
    // A family-calendar event with real attendees that is not travel stays (a school meeting).
    expect(isPrepWorthy(ev({ title: 'Parent teacher conference', attendees: [{ name: 'Ms. Lee', domain: 'school.org' }] }), cal({ title: 'Family', sourceType: 'caldav' }))).toBe(true)
  })

  it('ownership matches the bridge: family calendars are family_shared, attendee-less travel elsewhere is unverified_flight', () => {
    const s = snap({
      calendars: [cal(), cal({ id: 'cal-fam', title: 'Ukaoma Family', sourceType: 'caldav' })],
      events: [
        ev({ eventId: 'f', externalId: 'f', title: 'Flight to KC (WN 100)', attendees: [], start: at(11), occurrenceStart: at(11), end: at(13) }),
        ev({ calendarId: 'cal-fam', eventId: 'd', externalId: 'd', title: 'Dinner', attendees: [], start: at(18), occurrenceStart: at(18), end: at(19) }),
      ],
    })
    const shape = snapshotToBridgeShape(s, NOW) as { today_events: Array<{ title: string; ownership: string }> }
    expect(Object.fromEntries(shape.today_events.map(e => [e.title, e.ownership]))).toEqual({ 'Flight to KC (WN 100)': 'unverified_flight', Dinner: 'family_shared' })
  })

  it('Today counts only the meetings it may list: remainingCount skips declined and travel rows', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    const events = [
      ev({ eventId: 'dec', externalId: 'dec', myStatus: 'declined', start: at(10), occurrenceStart: at(10), end: at(10, 30), title: 'Declined' }),
      ev({ eventId: 'fl', externalId: 'fl', attendees: [], start: at(12), occurrenceStart: at(12), end: at(14), title: 'Flight to Austin (WN 2528)' }),
      ev({ eventId: 'ok', externalId: 'ok', start: at(15), occurrenceStart: at(15), end: at(15, 30), title: 'Real meeting' }),
    ]
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(snap({ events })))
    mod.resetCalendarSourceCache()
    const today = await mod.calendarToday(NOW)
    expect(today.next.map(n => n.title)).toEqual(['Real meeting'])
    expect(today.remainingCount).toBe(1)
  })
})

// Today round 2 (Miles 2026-11-09): endedRecently, meetings that ended within the last 2 hours, so the Today summary
// knows a meeting is over and its prep is past. Read from today_events (past events included).
describe('Today round 2: endedRecently', () => {
  it('lists meetings that ended in the last 2 h, newest end first; not ones still on, older ones, or ones that do not count', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    // NOW is 09:00. Ended 08:30 (30 min ago), ended 07:05 (1 h 55 min ago), ended 06:55 (2 h 5 min ago, too old),
    // still on (08:30 to 09:30), declined and ended 08:45, all-day.
    const events = [
      ev({ eventId: 'a', externalId: 'a', start: at(8), occurrenceStart: at(8), end: at(8, 30), title: 'Weatherford call' }),
      ev({ eventId: 'b', externalId: 'b', start: at(6, 30), occurrenceStart: at(6, 30), end: at(7, 5), title: 'Early sync' }),
      ev({ eventId: 'c', externalId: 'c', start: at(6), occurrenceStart: at(6), end: at(6, 55), title: 'Too old' }),
      ev({ eventId: 'd', externalId: 'd', start: at(8, 30), occurrenceStart: at(8, 30), end: at(9, 30), title: 'Still on' }),
      ev({ eventId: 'e', externalId: 'e', myStatus: 'declined', start: at(8, 15), occurrenceStart: at(8, 15), end: at(8, 45), title: 'Declined' }),
      ev({ eventId: 'f', externalId: 'f', allDay: true, start: at(0), occurrenceStart: at(0), end: at(0, 0, 1), title: 'All day' }),
    ]
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(snap({ events })))
    mod.resetCalendarSourceCache()
    const today = await mod.calendarToday(NOW)
    expect(today.endedRecently).toEqual([
      { title: 'Weatherford call', start: at(8), end: at(8, 30) },
      { title: 'Early sync', start: at(6, 30), end: at(7, 5) },
    ])
    // The one still on is in next, not ended.
    expect(today.next.map(n => n.title)).toEqual(['Still on'])
  })

  it('the 2 h edge: ended exactly 2 h ago is in, a minute more is out; no end means an hour after the start', () => {
    const row = (title: string, start: string, end: string | null) => ({ title, start_time: start, end_time: end, is_all_day: false, prep_worthy: true })
    const out = endedRecently([row('Edge', at(6), at(7)), row('Past edge', at(6), at(6, 59)), row('No end', at(7, 30), null)], NOW)
    expect(out.map(r => r.title)).toEqual(['No end', 'Edge'])
    expect(out[0].end).toBe(at(8, 30))
  })

  it('a bridge answer: endedRecently comes from its today_events; not connected answers none', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    bridge.available = true
    bridge.answer = { today_remaining: [], today_events: [{ title: 'Bridge ended', start_time: at(8), end_time: at(8, 45), is_all_day: false }] }
    expect((await mod.calendarToday(NOW)).endedRecently.map(r => r.title)).toEqual(['Bridge ended'])
    bridge.available = false
    expect((await mod.calendarToday(NOW)).endedRecently).toEqual([])
  })
})

function muScriptsDir(): string | null {
  const candidates = [
    process.env.COS_SCRIPTS_DIR ? resolve(process.env.COS_SCRIPTS_DIR) : null,
    resolve(process.cwd(), '../Ukaoma Chief Of Staff/MU-Chief-Staff/operations/scripts'),
    resolve(homedir(), 'Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff/operations/scripts'),
  ].filter((p): p is string => !!p)
  for (const c of candidates) {
    if (existsSync(join(c, 'calendar_context.py')) && existsSync(join(c, 'venv', 'bin', 'python3'))) return c
  }
  return null
}
