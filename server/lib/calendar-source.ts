// Calendar source (PH plan P1, 2026-11-07).
//
// COS Control reads macOS Calendar through EventKit (Exchange, iCloud, every
// Google account, subscribed ICS) and writes a local snapshot to
// dataPath('calendar', 'snapshot.json'). This module is the ONE reader of that
// snapshot. It applies a single staleness rule and hands callers the same dict
// shape the starter-kit bridge's `calendar` command returns, so the four
// existing callers swap one call and nothing else.
//
// Staleness rule (plan P1):
//   snapshot age <= 2 h                         -> snapshot
//   older than 2 h and the bridge reads          -> bridge
//   older than 2 h, bridge does not read         -> snapshot, labeled "as of"
//   older than 24 h, past windowEnd, or denied   -> none
// No snapshot file at all keeps today's behaviour exactly: the bridge. So does a
// granted snapshot with no calendar picked yet (QA W20): Connect before the first
// pick is "not set up", never an empty day.
//
// Privacy: event titles never go to a log line from here. Errors log the
// reason code only.

import { lstatSync, readFileSync } from 'node:fs'
import { dataPath } from './data-dir.js'
import { callPython, pythonBridgeAvailable } from './python-bridge.js'

export const SNAPSHOT_FRESH_MS = 2 * 3600_000
export const SNAPSHOT_MAX_AGE_MS = 24 * 3600_000
export const SNAPSHOT_MAX_BYTES = 4_000_000

export type CalendarAccess = 'granted' | 'denied' | 'restricted' | 'notDetermined'
export type CalendarSourceType = 'exchange' | 'caldav' | 'subscription' | 'birthdays' | 'local' | 'other'

export interface SnapshotCalendar {
  id: string
  title: string
  account: string | null
  sourceType: CalendarSourceType
  /** Shared or family calendars: events with no attendees there are not the owner's meetings. */
  shared: boolean
  selected: boolean
}

export interface SnapshotAttendee { name: string | null; domain: string | null }

export interface SnapshotEvent {
  calendarId: string
  /** EKEvent.eventIdentifier (device-local). */
  eventId: string | null
  /** calendarItemExternalIdentifier (server-side id, stable across devices). */
  externalId: string | null
  /** The occurrence's ORIGINAL start (EKEvent.occurrenceDate), so a moved occurrence keeps its key. */
  occurrenceStart: string
  start: string
  end: string | null
  allDay: boolean
  /** timeZone == nil in EventKit. */
  floating: boolean
  title: string
  myStatus: 'accepted' | 'declined' | 'tentative' | 'pending' | 'none'
  isOrganizer: boolean
  attendees: SnapshotAttendee[]
  /** Allowlisted hosts only (zoom.us, teams.microsoft.com, meet.google.com). */
  meetingUrl: string | null
}

export interface CalendarSnapshot {
  version: 1
  writtenAt: string
  windowStart: string
  windowEnd: string
  access: CalendarAccess
  calendars: SnapshotCalendar[]
  events: SnapshotEvent[]
}

export type CalendarSourceName = 'snapshot' | 'snapshot-stale' | 'bridge' | 'none'

export interface SnapshotRead {
  /** 'missing' means no file: callers fall back to the bridge, as before P1. */
  state: 'missing' | 'invalid' | 'denied' | 'unselected' | 'fresh' | 'aging' | 'expired'
  snapshot: CalendarSnapshot | null
  ageMs: number | null
}

const SOURCE_TYPES: readonly CalendarSourceType[] = ['exchange', 'caldav', 'subscription', 'birthdays', 'local', 'other']
const STATUSES = ['accepted', 'declined', 'tentative', 'pending', 'none'] as const
const ACCESS: readonly CalendarAccess[] = ['granted', 'denied', 'restricted', 'notDetermined']
const MEETING_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(zoom\.us|teams\.microsoft\.com|meet\.google\.com)(\/|$)/i

export function snapshotPath(): string {
  return dataPath('calendar', 'snapshot.json')
}

const str = (v: unknown, max = 512): string | null => typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 64) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Validate an untrusted snapshot. Bad rows are dropped; a bad envelope rejects the whole file. */
export function parseSnapshot(raw: unknown): CalendarSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return null
  const writtenAt = iso(o.writtenAt), windowStart = iso(o.windowStart), windowEnd = iso(o.windowEnd)
  const access = ACCESS.includes(o.access as CalendarAccess) ? o.access as CalendarAccess : null
  if (!writtenAt || !access) return null
  if (access !== 'granted') {
    // A tombstone carries no calendars or events, whatever the file says.
    return { version: 1, writtenAt, windowStart: windowStart ?? writtenAt, windowEnd: windowEnd ?? writtenAt, access, calendars: [], events: [] }
  }
  if (!windowStart || !windowEnd || !Array.isArray(o.calendars) || !Array.isArray(o.events)) return null
  const calendars: SnapshotCalendar[] = []
  for (const c of o.calendars.slice(0, 500)) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const id = str(r.id), title = str(r.title, 300)
    if (!id || title === null) continue
    calendars.push({
      id,
      title,
      account: str(r.account, 300),
      sourceType: SOURCE_TYPES.includes(r.sourceType as CalendarSourceType) ? r.sourceType as CalendarSourceType : 'other',
      shared: r.shared === true,
      selected: r.selected === true,
    })
  }
  const known = new Set(calendars.map(c => c.id))
  const events: SnapshotEvent[] = []
  for (const e of o.events.slice(0, 5000)) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const calendarId = str(r.calendarId), start = iso(r.start), occurrenceStart = iso(r.occurrenceStart) ?? start
    const title = typeof r.title === 'string' ? r.title.slice(0, 500) : null
    if (!calendarId || !known.has(calendarId) || !start || !occurrenceStart || title === null) continue
    const attendees = Array.isArray(r.attendees)
      ? r.attendees.slice(0, 200).flatMap((a): SnapshotAttendee[] => {
        if (!a || typeof a !== 'object') return []
        const x = a as Record<string, unknown>
        // macOS fills a participant's name with their address when there is no display name. Names only, never an
        // address: a name that looks like one is dropped (the domain stays). Same rule as Control's attendeeName.
        const name = str(x.name, 200)
        return [{ name: name && !name.includes('@') ? name : null, domain: str(x.domain, 253) }]
      })
      : []
    const url = typeof r.meetingUrl === 'string' && r.meetingUrl.length <= 2048 && MEETING_HOSTS.test(r.meetingUrl) ? r.meetingUrl : null
    events.push({
      calendarId,
      eventId: str(r.eventId),
      externalId: str(r.externalId),
      occurrenceStart,
      start,
      end: iso(r.end),
      allDay: r.allDay === true,
      floating: r.floating === true,
      title,
      myStatus: STATUSES.includes(r.myStatus as never) ? r.myStatus as SnapshotEvent['myStatus'] : 'none',
      isOrganizer: r.isOrganizer === true,
      attendees,
      meetingUrl: url,
    })
  }
  return { version: 1, writtenAt, windowStart, windowEnd, access, calendars, events }
}

let cache: { mtimeMs: number; size: number; snapshot: CalendarSnapshot | null } | null = null

/** Test seam. */
export function resetCalendarSourceCache(): void { cache = null }

/**
 * Server-side switch: COS_CALENDAR_SNAPSHOT=0 ignores the snapshot and uses the bridge as before. On by default; only
 * `0` (after trimming) turns it off, so `false` or `off` leave it on. QA W21: calendar_context.py once read the
 * snapshot only when the switch was 1, the opposite default. Its `snapshot_reading_enabled` now has this polarity, and
 * calendar-source.test.ts runs one table against both readers.
 */
export function snapshotReadingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_CALENDAR_SNAPSHOT?.trim() !== '0'
}

export function readSnapshot(now = Date.now(), path = snapshotPath()): SnapshotRead {
  if (!snapshotReadingEnabled()) return { state: 'missing', snapshot: null, ageMs: null }
  let st
  try { st = lstatSync(path) } catch { return { state: 'missing', snapshot: null, ageMs: null } }
  if (!st.isFile() || st.size > SNAPSHOT_MAX_BYTES) return { state: 'invalid', snapshot: null, ageMs: null }
  let snapshot: CalendarSnapshot | null
  if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    snapshot = cache.snapshot
  } else {
    try { snapshot = parseSnapshot(JSON.parse(readFileSync(path, 'utf8'))) } catch { snapshot = null }
    cache = { mtimeMs: st.mtimeMs, size: st.size, snapshot }
  }
  if (!snapshot) return { state: 'invalid', snapshot: null, ageMs: null }
  const ageMs = Math.max(0, now - Date.parse(snapshot.writtenAt))
  if (snapshot.access !== 'granted') return { state: 'denied', snapshot, ageMs }
  // QA W20: granted with nothing picked is not configured. Keep the previous source until the first selection.
  if (!snapshot.calendars.some(c => c.selected)) return { state: 'unselected', snapshot, ageMs }
  if (ageMs > SNAPSHOT_MAX_AGE_MS || now > Date.parse(snapshot.windowEnd)) return { state: 'expired', snapshot, ageMs }
  if (ageMs <= SNAPSHOT_FRESH_MS) return { state: 'fresh', snapshot, ageMs }
  return { state: 'aging', snapshot, ageMs }
}

// ---------------------------------------------------------------------------
// Selection, dedupe and the prep filter
// ---------------------------------------------------------------------------

const HOLIDAY_OR_BIRTHDAY = /\b(holidays?|birthdays?)\b/i
/** A family calendar under any name ("Family", "Ukaoma Family", "Family calendar"). */
const FAMILY_TITLE = /\bfamily\b/i
/** Travel-shaped titles: the bridge's own `looks_like_flight` (calendar_context CalendarEvent.to_dict), case-folded. */
const TRAVEL_TITLE = /\bflight\b|\b(wn|aa|ua|dl|as|b6|nk|f9)\s*\d{2,4}\b/i

/** A calendar other people write to: shared, a family calendar by name. Its events are not the owner's by default. */
export function isFamilyCalendar(calendar: SnapshotCalendar): boolean {
  return calendar.shared || FAMILY_TITLE.test(calendar.title)
}

export function isTravelShaped(e: SnapshotEvent): boolean {
  return TRAVEL_TITLE.test(e.title)
}

/** Events from selected calendars only, deduped across accounts. Order: start time. */
export function selectedEvents(snapshot: CalendarSnapshot): SnapshotEvent[] {
  const selected = new Set(snapshot.calendars.filter(c => c.selected).map(c => c.id))
  const rows = snapshot.events.filter(e => selected.has(e.calendarId))
  rows.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  return dedupeEvents(rows)
}

/**
 * The same meeting invited on Exchange and on Gmail shows up twice. Merge only a true duplicate of the same meeting on
 * another calendar: the external id and occurrence match, or the title (trimmed, case-folded), start and end all match
 * AND the two share a named attendee or the same meeting link. Two events from the SAME calendar are never merged: two
 * 10:00 "Busy" holds are two holds. QA 7.0.0: the shape fallback once keyed on the set of attendee DOMAINS, so two
 * different "Weekly sync" meetings at one time with different people from one company merged into one.
 */
export function dedupeEvents(rows: SnapshotEvent[]): SnapshotEvent[] {
  const out: SnapshotEvent[] = []
  const byExternal = new Map<string, SnapshotEvent>()
  const byShape = new Map<string, SnapshotEvent[]>()
  for (const e of rows) {
    const extKey = e.externalId ? `${e.externalId}|${e.occurrenceStart}` : null
    const shapeKey = `${e.title.trim().toLowerCase()}|${e.start}|${e.end ?? ''}`
    const byId = extKey ? byExternal.get(extKey) : undefined
    const dup = (byId && byId.calendarId !== e.calendarId) ||
      (byShape.get(shapeKey) ?? []).some(p => p.calendarId !== e.calendarId && sameMeeting(p, e))
    if (dup) continue
    out.push(e)
    if (extKey && !byExternal.has(extKey)) byExternal.set(extKey, e)
    const bucket = byShape.get(shapeKey)
    if (bucket) bucket.push(e); else byShape.set(shapeKey, [e])
  }
  return out
}

/** Same-shaped events that are one meeting: a shared named attendee (name and domain) or the same meeting link. */
function sameMeeting(a: SnapshotEvent, b: SnapshotEvent): boolean {
  const la = meetingLink(a.meetingUrl), lb = meetingLink(b.meetingUrl)
  if (la && la === lb) return true
  const named = (e: SnapshotEvent) => new Set(e.attendees.filter(x => !!x.name && !!x.name.trim()).map(x => `${x.name!.trim().toLowerCase()}|${(x.domain ?? '').toLowerCase()}`))
  const na = named(a)
  if (!na.size) return false
  for (const k of named(b)) if (na.has(k)) return true
  return false
}

/** A meeting link without its query or fragment (a Zoom pwd, a tracking tag), lower-cased host, no trailing slash. */
function meetingLink(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
  } catch { return null }
}

export function isMultiDay(e: SnapshotEvent): boolean {
  if (!e.end) return false
  return Date.parse(e.end) - Date.parse(e.start) > 24 * 3600_000
}

/**
 * Whether an event may become next(), prep, Today's list or Meeting Ask's match. Declined, all-day, multi-day,
 * birthday and holiday calendars, and shared-calendar events with no attendees never qualify (shared-calendar flights
 * are not the owner's travel).
 *
 * QA W23, the family rule. It was an exact "Family" title or a shared calendar, so a flight on another editable
 * calendar (iCloud "Calendar", a TripIt import) still qualified. Now:
 *   - a family calendar matches by word ("Ukaoma Family"), not by exact title;
 *   - a travel-shaped event (the bridge's flight rule) with no attendees never qualifies, on any calendar;
 *   - a travel-shaped event on a family or shared calendar never qualifies, even with attendees (a flight a relative
 *     invited the owner to is still their travel, not a meeting).
 * A non-travel event with real attendees on a family calendar (a school meeting) still qualifies, and an
 * attendee-less hold on the owner's own calendar is unchanged.
 */
export function isPrepWorthy(e: SnapshotEvent, calendar: SnapshotCalendar | undefined): boolean {
  if (e.myStatus === 'declined' || e.allDay || isMultiDay(e)) return false
  if (!calendar) return false
  if (calendar.sourceType === 'birthdays' || HOLIDAY_OR_BIRTHDAY.test(calendar.title)) return false
  const sharedLike = isFamilyCalendar(calendar) || calendar.sourceType === 'subscription'
  const travel = isTravelShaped(e)
  if (sharedLike && (travel || e.attendees.length === 0)) return false
  if (travel && e.attendees.length === 0) return false
  return true
}

// ---------------------------------------------------------------------------
// Bridge-shaped output
// ---------------------------------------------------------------------------

/**
 * One event in the starter-kit bridge's dict shape, plus the occurrence fields bridgeOccurrence reads.
 *
 * `domain` and `matched_person` stay null here: the bridge's classifier (people_context.classify_event_by_attendees)
 * lives in Python people context, which this standalone server does not have. Meeting Ask, the one caller that needs a
 * domain, asks the bridge's `calendar-classify` for its candidates (QA W21, meeting-ask-orientation.ts).
 */
export function bridgeEvent(e: SnapshotEvent, calendar: SnapshotCalendar | undefined): Record<string, unknown> {
  const start = Date.parse(e.start)
  const end = e.end ? Date.parse(e.end) : NaN
  return {
    title: e.title,
    start_time: e.start,
    end_time: e.end,
    location: null,
    is_all_day: e.allDay,
    duration_minutes: e.allDay || !Number.isFinite(end) ? 60 : Math.round((end - start) / 60_000),
    domain: null,
    matched_person: null,
    attendees: e.attendees.map(a => a.name).filter((n): n is string => !!n),
    calendar_name: calendar?.title ?? null,
    // The bridge's ownership words: family calendars, then travel it cannot verify, then the owner's own.
    ownership: calendar && isFamilyCalendar(calendar) ? 'family_shared' : isTravelShaped(e) && e.attendees.length === 0 ? 'unverified_flight' : 'miles',
    meeting_url: e.meetingUrl,
    prep_worthy: isPrepWorthy(e, calendar),
    // Occurrence identity for prep (welcome-context bridgeOccurrence reads these keys).
    provider: 'eventkit',
    account: calendar?.account ?? null,
    calendar_id: e.calendarId,
    event_id: e.eventId,
    external_id: e.externalId,
    occurrence_start: e.occurrenceStart,
  }
}

function localDayBounds(now: number): { start: number; end: number } {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return { start, end }
}

/** The bridge `calendar` dict, built from a snapshot. `stale` marks an aging snapshot used because the bridge is down. */
export function snapshotToBridgeShape(snapshot: CalendarSnapshot, now = Date.now(), stale = false): Record<string, unknown> {
  const cals = new Map(snapshot.calendars.map(c => [c.id, c]))
  const { start: dayStart, end: dayEnd } = localDayBounds(now)
  const events = selectedEvents(snapshot)
  const endOf = (e: SnapshotEvent) => (e.end ? Date.parse(e.end) : Date.parse(e.start) + 3600_000)
  const today = events.filter(e => { const s = Date.parse(e.start); return s >= dayStart && s < dayEnd })
  const remaining = today.filter(e => endOf(e) > now)
  const timed = (e: SnapshotEvent) => isPrepWorthy(e, cals.get(e.calendarId))
  const current = remaining.find(e => timed(e) && Date.parse(e.start) <= now && endOf(e) > now) ?? null
  const next = events.find(e => timed(e) && Date.parse(e.start) > now) ?? null
  // Tomorrow ends at the NEXT local midnight, not 24 h after this one (a DST day is 23 or 25 hours). QA 7.0.0.
  const tomorrowEnd = localDayBounds(dayEnd).end
  const tomorrow = events.filter(e => { const s = Date.parse(e.start); return s >= dayEnd && s < tomorrowEnd })
  const asDict = (e: SnapshotEvent) => bridgeEvent(e, cals.get(e.calendarId))
  const ageMinutes = Math.max(0, (now - Date.parse(snapshot.writtenAt)) / 60_000)
  return {
    current_event: current ? asDict(current) : null,
    next_event: next ? asDict(next) : null,
    minutes_until_next: next ? Math.max(0, Math.round((Date.parse(next.start) - now) / 60_000)) : null,
    today_events: today.map(asDict),
    today_remaining: remaining.map(asDict),
    tomorrow_events_count: tomorrow.length,
    week_events_count: events.filter(e => Date.parse(e.start) >= dayStart).length,
    meetings_today_count: today.length,
    meetings_remaining_count: remaining.length,
    is_in_meeting: current !== null,
    free_until: next ? next.start : null,
    data_source: stale ? 'eventkit_stale' : 'eventkit',
    cached_at: snapshot.writtenAt,
    cache_age_minutes: Math.round(ageMinutes * 10) / 10,
    is_stale: stale,
  }
}

/** The no-calendar answer. `error` makes calendarAnswerWasRead() report "not connected", never an empty day. */
export function noCalendarShape(reason: string): Record<string, unknown> {
  return { error: reason, today_events: [], today_remaining: [], next_event: null, meetings_today_count: 0, meetings_remaining_count: 0, data_source: 'none', is_stale: false }
}

export interface CalendarRead {
  source: CalendarSourceName
  data: unknown
  /** Snapshot age when the snapshot was used or considered. */
  ageMs: number | null
}

let lastSource: CalendarSourceName | null = null

/**
 * The one call the four callers make instead of callPython(['calendar']).
 * Returns the bridge dict shape whichever source answered.
 */
export async function readCalendar(timeoutMs = 30_000, now = Date.now()): Promise<CalendarRead> {
  const snap = readSnapshot(now)
  const done = (r: CalendarRead): CalendarRead => { lastSource = r.source; return r }
  if (snap.state === 'missing' || snap.state === 'invalid' || snap.state === 'unselected') {
    // Pre-P1 behaviour, unchanged. Unselected (QA W20): Connect with nothing picked keeps this source too.
    return done({ source: 'bridge', data: await callPython(['calendar'], timeoutMs), ageMs: null })
  }
  if (snap.state === 'denied') return done({ source: 'none', data: noCalendarShape('calendar_access_denied'), ageMs: snap.ageMs })
  if (snap.state === 'fresh') return done({ source: 'snapshot', data: snapshotToBridgeShape(snap.snapshot!, now), ageMs: snap.ageMs })
  // aging or expired: the bridge wins when it really reads.
  if (pythonBridgeAvailable()) {
    try {
      const data = await callPython(['calendar'], timeoutMs)
      if (data && typeof data === 'object' && !Array.isArray(data) && !('error' in data)) {
        return done({ source: 'bridge', data, ageMs: snap.ageMs })
      }
    } catch { /* fall through to the labeled snapshot */ }
  }
  if (snap.state === 'aging') return done({ source: 'snapshot-stale', data: snapshotToBridgeShape(snap.snapshot!, now, true), ageMs: snap.ageMs })
  return done({ source: 'none', data: noCalendarShape('calendar_snapshot_expired'), ageMs: snap.ageMs })
}

/** Counts only, for the authenticated /api/models capabilities. Never titles. */
export function calendarStatus(now = Date.now()): {
  source: CalendarSourceName | 'unknown'
  snapshot: SnapshotRead['state']
  ageMs: number | null
  access: CalendarAccess | null
  calendars: number
  selected: number
} {
  const snap = readSnapshot(now)
  return {
    source: lastSource ?? 'unknown',
    snapshot: snap.state,
    ageMs: snap.ageMs,
    access: snap.snapshot?.access ?? null,
    calendars: snap.snapshot?.calendars.length ?? 0,
    selected: snap.snapshot?.calendars.filter(c => c.selected).length ?? 0,
  }
}

/**
 * A bridge-shaped row that may be listed as a meeting: timed, and not marked unworthy by the prep filter. A bridge row
 * without prep_worthy counts (the bridge already drops declined and skips all-day). Today and Meeting Ask both use it.
 */
export function countsAsMeeting(row: Record<string, unknown> | null | undefined): boolean {
  return !!row && row.is_all_day !== true && row.prep_worthy !== false
}

/**
 * Today for Control Web and desktop: selected calendars only, the next 3 timed meetings that count. QA 7.0.0: all-day
 * and non-prep events (declined, holidays, attendee-less shared events) are filtered out BEFORE the 3 are taken, so they
 * never use up the slots Today's "Later" shows. QA W23: remainingCount counts the same rows, so a declined meeting or
 * a family flight is not "remaining".
 */
export async function calendarToday(now = Date.now()): Promise<{
  connected: boolean
  source: CalendarSourceName
  asOf: string | null
  stale: boolean
  remainingCount: number
  next: Array<{ title: string; start: string; end: string | null; allDay: boolean; calendar: string | null; meetingUrl: string | null }>
}> {
  const read = await readCalendar(8_000, now)
  const data = read.data as Record<string, unknown> | null
  const connected = !!data && typeof data === 'object' && !('error' in data) && (read.source !== 'bridge' || pythonBridgeAvailable())
  const rows = connected && Array.isArray(data!.today_remaining) ? data!.today_remaining as Array<Record<string, unknown>> : []
  const counted = rows.filter(countsAsMeeting)
  const next = counted.slice(0, 3).map(r => ({
    title: typeof r.title === 'string' ? r.title : 'Event',
    start: String(r.start_time ?? ''),
    end: typeof r.end_time === 'string' ? r.end_time : null,
    allDay: r.is_all_day === true,
    calendar: typeof r.calendar_name === 'string' ? r.calendar_name : null,
    meetingUrl: typeof r.meeting_url === 'string' ? r.meeting_url : null,
  }))
  return {
    connected,
    source: read.source,
    asOf: typeof data?.cached_at === 'string' ? data.cached_at : null,
    stale: data?.is_stale === true,
    remainingCount: connected ? counted.length : 0,
    next,
  }
}
