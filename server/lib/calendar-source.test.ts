import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ available: false, answer: null as unknown, calls: 0 }))
vi.mock('./python-bridge.js', () => ({
  pythonBridgeAvailable: () => bridge.available,
  callPython: async () => { bridge.calls += 1; return bridge.answer },
}))

import {
  calendarStatus, calendarToday, dedupeEvents, isPrepWorthy, parseSnapshot, readCalendar, readSnapshot,
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

  it('no snapshot and no bridge is "not connected", never an empty day', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    const today = await mod.calendarToday(NOW)
    expect(today.connected).toBe(false)
  })

  it('today returns selected calendars only, the next 3, and status is counts only (P1-7)', async () => {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.resetModules()
    const mod = await import('./calendar-source.js')
    const events = [10, 11, 12, 13].map(h => ev({ eventId: `e${h}`, externalId: `e${h}`, start: at(h), occurrenceStart: at(h), end: at(h, 30), title: `UNIQUE-SEED-${h}` }))
    writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify(snap({ events })))
    mod.resetCalendarSourceCache()
    const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), err = vi.spyOn(console, 'error')
    const today = await mod.calendarToday(NOW)
    expect(today.connected).toBe(true)
    expect(today.next.map(n => n.title)).toEqual(['UNIQUE-SEED-10', 'UNIQUE-SEED-11', 'UNIQUE-SEED-12'])
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
