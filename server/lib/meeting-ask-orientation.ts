import { createHash } from 'node:crypto'
import { countsAsMeeting, readCalendar } from './calendar-source.js'
import { callPython, pythonBridgeAvailable } from './python-bridge.js'
import { redactSecrets } from './lens-gist-engines.js'
import { type MeetingAskCalendarMatch, type MeetingAskOrientation } from '../../shared/meeting-ask.js'
import { domainNames, isSafeDomainName } from './domains.js'
import { resolveCosOperationsDir } from './cos-operations-meetings.js'
import { domainLabel } from './domain-label.js'
import { AskError } from './live-cos-ask.js'
export const meetingDomains = () => domainNames(resolveCosOperationsDir()).map(id => ({id,label:domainLabel(id)}))
export const emptyOrientation = (): MeetingAskOrientation => ({ revision: 0, domain: null, calendar: null })
type CandidateEvent = { match: MeetingAskCalendarMatch; event: any }
export function calendarCandidates(raw: unknown, startedAt: number | null): MeetingAskCalendarMatch[] {
  return candidateEvents(raw, startedAt).map(c => c.match)
}
// QA W23: the same prep filter as Next up and Today (countsAsMeeting), so a declined meeting or a family flight that
// covers the recording's start is never offered as "this meeting".
function candidateEvents(raw: unknown, startedAt: number | null): CandidateEvent[] {
  if (startedAt === null || !Number.isFinite(startedAt)) return []
  const data = raw as any
  if (!data || data.is_stale || !Array.isArray(data.today_events)) return []
  const seen = new Set<string>()
  return data.today_events.slice(0, 200).flatMap((event: any): CandidateEvent[] => {
    if (!event || !countsAsMeeting(event) || typeof event.title !== 'string' || event.title.length > 500) return []
    const start = Date.parse(event.start_time), end = Date.parse(event.end_time)
    // Match the recording's start, never whichever event happens to be current when Ask runs.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 3600000 || startedAt < start - 5 * 60000 || startedAt >= end) return []
    const title = redactSecrets(event.title).trim().slice(0, 180)
    if (!title || /\booo\b|out of office|vacation|\bpto\b/i.test(title)) return []
    const match: MeetingAskCalendarMatch = { id: createHash('sha256').update(JSON.stringify([title, start, end])).digest('hex').slice(0, 24), title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(typeof event.domain === 'string' && isSafeDomainName(event.domain) ? { suggestedDomain: event.domain } : {}) }
    if (seen.has(match.id)) return []
    seen.add(match.id); return [{ match, event }]
  }).slice(0, 5)
}
/**
 * QA W21: snapshot rows carry domain: null (the bridge's classifier is Python people context), so ask the bridge's
 * `calendar-classify` for the candidates that lack one: the exact rule its own calendar answer uses
 * (classify_event_by_attendees on title, attendee names and calendar name). Names only over stdin, never addresses or
 * domains. No bridge, an old bridge, a slow one or a bad answer: no suggestion, as before.
 */
export async function classifyWithBridge(rows: Array<{ title: string; attendees: string[]; calendar_name: string | null }>): Promise<Array<string | null> | null> {
  if (!rows.length || !pythonBridgeAvailable()) return null
  const out = await callPython(['calendar-classify'], 3000, JSON.stringify({ events: rows })) as any
  if (!out || !Array.isArray(out.results) || out.results.length !== rows.length) return null
  return out.results.map((r: any) => (r && typeof r.domain === 'string' ? r.domain : null))
}
async function withSuggestedDomains(found: CandidateEvent[], classify = classifyWithBridge): Promise<MeetingAskCalendarMatch[]> {
  const need = found.filter(f => !f.match.suggestedDomain)
  if (!need.length) return found.map(f => f.match)
  let domains: Array<string | null> | null = null
  try {
    domains = await classify(need.map(f => ({
      title: f.match.title,
      attendees: Array.isArray(f.event.attendees) ? f.event.attendees.filter((n: unknown): n is string => typeof n === 'string' && !n.includes('@')).slice(0, 50) : [],
      calendar_name: typeof f.event.calendar_name === 'string' ? f.event.calendar_name : null,
    })))
  } catch { domains = null }
  if (!domains) return found.map(f => f.match)
  need.forEach((f, i) => { const d = domains![i]; if (typeof d === 'string' && isSafeDomainName(d)) f.match.suggestedDomain = d })
  return found.map(f => f.match)
}
export async function meetingCalendar(startedAt: number | null): Promise<{ candidates: MeetingAskCalendarMatch[]; notices: string[] }> {
  if (startedAt === null) return { candidates: [], notices: ['Calendar matching is available for a live recording. Choose a domain for this meeting.'] }
  try {
    const raw = (await readCalendar(5000)).data as any
    const candidates = await withSuggestedDomains(candidateEvents(raw, startedAt))
    return { candidates, notices: candidates.length ? [] : [raw?.error || raw?.is_stale ? 'Calendar context is unavailable or stale. Choose a domain manually.' : 'No calendar event matches this recording. Choose a domain manually.'] }
  } catch { return { candidates: [], notices: ['Calendar context is unavailable. Choose a domain manually.'] } }
}
export function validateOrientationChange(raw: any, current: MeetingAskOrientation, domains: readonly string[]): void {
  if (!raw || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision !== current.revision) throw new AskError('meeting_context_changed', 409)
  if (raw.domain !== null && (typeof raw.domain !== 'string' || !domains.includes(raw.domain))) throw new AskError('invalid_meeting_domain')
  if (raw.calendarId !== null && (typeof raw.calendarId !== 'string' || !/^[a-f0-9]{24}$/.test(raw.calendarId))) throw new AskError('invalid_calendar_match')
}
export function confirmOrientation(raw: any, current: MeetingAskOrientation, candidates: readonly MeetingAskCalendarMatch[], domains = meetingDomains().map(d => d.id)): MeetingAskOrientation {
  validateOrientationChange(raw,current,domains)
  if (!raw || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision !== current.revision) throw new AskError('meeting_context_changed', 409)
  const calendar = raw.calendarId === null ? null : candidates.find(c => c.id === raw.calendarId) ?? (current.calendar?.id === raw.calendarId ? current.calendar : null)
  if (raw.calendarId !== null && !calendar) throw new AskError('calendar_match_unavailable', 409)
  return { revision: current.revision + 1, domain: raw.domain, calendar }
}
