import { createHash } from 'node:crypto'
import { callPython } from './python-bridge.js'
import { redactSecrets } from './lens-gist-engines.js'
import { type MeetingAskCalendarMatch, type MeetingAskOrientation } from '../../shared/meeting-ask.js'
import { domainNames, isSafeDomainName } from './domains.js'
import { resolveCosOperationsDir } from './cos-operations-meetings.js'
import { domainLabel } from './domain-label.js'
import { AskError } from './live-cos-ask.js'
export const meetingDomains = () => domainNames(resolveCosOperationsDir()).map(id => ({id,label:domainLabel(id)}))
export const emptyOrientation = (): MeetingAskOrientation => ({ revision: 0, domain: null, calendar: null })
export function calendarCandidates(raw: unknown, startedAt: number | null): MeetingAskCalendarMatch[] {
  if (startedAt === null || !Number.isFinite(startedAt)) return []
  const data = raw as any
  if (!data || data.is_stale || !Array.isArray(data.today_events)) return []
  const seen = new Set<string>()
  return data.today_events.slice(0, 200).flatMap((event: any) => {
    if (!event || event.is_all_day || typeof event.title !== 'string' || event.title.length > 500) return []
    const start = Date.parse(event.start_time), end = Date.parse(event.end_time)
    // Match the recording's start, never whichever event happens to be current when Ask runs.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 3600000 || startedAt < start - 5 * 60000 || startedAt >= end) return []
    const title = redactSecrets(event.title).trim().slice(0, 180)
    if (!title || /\booo\b|out of office|vacation|\bpto\b/i.test(title)) return []
    const match: MeetingAskCalendarMatch = { id: createHash('sha256').update(JSON.stringify([title, start, end])).digest('hex').slice(0, 24), title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(typeof event.domain === 'string' && isSafeDomainName(event.domain) ? { suggestedDomain: event.domain } : {}) }
    if (seen.has(match.id)) return []
    seen.add(match.id); return [match]
  }).slice(0, 5)
}
export async function meetingCalendar(startedAt: number | null): Promise<{ candidates: MeetingAskCalendarMatch[]; notices: string[] }> {
  if (startedAt === null) return { candidates: [], notices: ['Calendar matching is available for a live recording. Choose a domain for this meeting.'] }
  try {
    const raw = await callPython(['calendar'], 5000) as any
    const candidates = calendarCandidates(raw, startedAt)
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
