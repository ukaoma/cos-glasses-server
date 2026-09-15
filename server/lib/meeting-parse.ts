// The meeting markdown parser, shared by MeetingStore and the imported library.
//
// Moved out of meeting-store.ts in 6.47.0, unchanged. Imported records are the
// same markdown shape as every other meeting record on this box, and the one
// thing worse than two libraries would be two parsers: a field the importer
// wrote and this parser read differently is a meeting that lists with the
// wrong date and opens with the wrong duration.
//
// meeting-store.ts re-exports what it used to export, so every existing caller
// and every existing test keeps its import path.

import { basename } from 'node:path'
import { FALLBACK_DOMAIN, domainAbbreviation } from './domains.js'
import type { MeetingActionItem, MeetingDetail, MeetingMeta } from './meeting-store.js'

export const MEETING_SOURCE_MAX_BYTES = 100_000
export const DETAIL_CHUNK_ESTIMATE_CHARS = 1_700

export function parseField(content: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const table = content.match(new RegExp(`\\*\\*${escaped}\\*\\*\\s*\\|\\s*(.+)`, 'i'))
  if (table) return table[1].replace(/\s*\|?\s*$/, '').trim()
  const plain = content.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, 'i'))
  return plain ? plain[1].trim() : ''
}

export function extractSection(content: string, headings: string[], toEnd = false): string {
  for (const heading of headings) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = toEnd
      ? new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*)$`, 'i')
      : new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i')
    const match = content.match(pattern)
    if (match) return match[1].trim()
  }
  return ''
}

export function parseListSection(content: string, headings: string[], limit: number): string[] {
  const section = extractSection(content, headings)
  if (!section) return []
  return section
    .split('\n')
    .filter(line => /^\s*[-*]\s+/.test(line))
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, limit)
}

export function parseActions(content: string): MeetingActionItem[] {
  const section = extractSection(content, ['Action Items', 'Tasks', 'Next Steps'])
  if (!section) return []
  return section
    .split('\n')
    .filter(line => /^\s*(?:[-*]|\[[ xX]\])\s+/.test(line))
    .map(line => {
      const cleaned = line
        .replace(/^\s*[-*]\s+/, '')
        .replace(/^\[[ xX]\]\s*/, '')
        .replace(/`\[REVIEW\]`\s*/i, '')
        .trim()
      const ownerMatch = cleaned.match(/\(\*\*(.+?)\*\*\)\s*$/)
      return {
        task: ownerMatch ? cleaned.replace(ownerMatch[0], '').trim() : cleaned,
        owner: ownerMatch ? ownerMatch[1] : '',
      }
    })
    .filter(item => item.task.length > 0)
    .slice(0, 15)
}

export function parseAttendees(content: string): string[] {
  return parseListSection(content, ['Attendees'], 20).map(line => {
    const match = line.match(/^\*\*(.+?)\*\*/) || line.match(/^([^(]+)/)
    return match ? match[1].trim() : line
  })
}

export function parseDurationMinutes(duration: string): number | undefined {
  if (!duration) return undefined
  const value = duration.toLowerCase()
  const colon = value.match(/\b(\d+):(\d{2})\b/)
  if (colon) return Number(colon[1]) * 60 + Number(colon[2])
  let total = 0
  const hours = value.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/)
  if (hours) total += Math.round(Number(hours[1]) * 60)
  const minutes = value.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/)
  if (minutes) total += Number(minutes[1])
  return total > 0 ? total : undefined
}

/** Return enough canonical source for grounded meeting follow-ups without
 * allowing an unexpectedly large archive record to inflate every response.
 * The boundary backs up over UTF-8 continuation bytes so the prefix never
 * ends with a replacement character. */
export function boundedMeetingSource(content: string): { sourceContent: string; sourceTruncated: boolean } {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length <= MEETING_SOURCE_MAX_BYTES) return { sourceContent: content, sourceTruncated: false }
  let end = MEETING_SOURCE_MAX_BYTES
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return { sourceContent: bytes.subarray(0, end).toString('utf8'), sourceTruncated: true }
}

export function parseMeeting(content: string, filename: string, month: string): MeetingDetail {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const date = parseField(content, 'Date') || filename.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || 'unknown'
  const domain = parseField(content, 'Domain') || FALLBACK_DOMAIN
  const duration = parseField(content, 'Duration')
  const transcript = extractSection(content, ['Transcript'], true)
  const storedSummary = extractSection(content, ['Summary'])
  // A placeholder is not a summary. Until 6.37 this returned the TRANSCRIPT as
  // the summary, which put the transcript in the summary slot on every surface
  // and read as "the summary is broken" — the bug this replaces. The transcript
  // is returned in its own `transcript` field and each surface renders it in
  // its own section. An empty summary is the honest state, and every consumer
  // already handles it: display-pages.ts falls back to 'No summary available.',
  // and COS Control's Copy-summary button correctly disables on empty.
  const summary = !storedSummary || /standalone recording|summary unavailable/i.test(storedSummary)
    ? ''
    : storedSummary
  const topics = parseListSection(content, ['Topics Discussed'], 10)
  const decisions = parseListSection(content, ['Decisions', 'Decisions Made'], 10)
  const actionItems = parseActions(content)
  const attendees = parseAttendees(content)
  const source = boundedMeetingSource(content)

  return {
    filename,
    title: heading || basename(filename, '.md').split('_').slice(1).join(' ') || 'Untitled Meeting',
    date,
    domain,
    // Shared derivation. This was slice(0,2), which rendered sprocket_rocket as
    // "SP" while cos-operations-meetings rendered it "SR" — two schemes in one
    // codebase, disagreeing with each other.
    domainAbbr: domainAbbreviation(domain),
    source: parseField(content, 'Source'),
    duration,
    ...(parseDurationMinutes(duration) !== undefined ? { durationMinutes: parseDurationMinutes(duration) } : {}),
    month,
    summary,
    topics,
    decisions,
    actionItems,
    attendees,
    transcript,
    ...source,
  }
}

export function toMeta(detail: MeetingDetail, sessionId?: string): MeetingMeta {
  // Must mirror what the reader actually renders (display-pages.ts
  // formatMeetingDetailBody), or the list row advertises a page count the
  // reader does not honour. The transcript is part of that body since 6.37;
  // omitting it here reported every standalone meeting as ~1p.
  const detailCharEstimate = [
    detail.title,
    detail.date,
    detail.duration || detail.source,
    detail.summary,
    detail.topics.join('\n'),
    detail.decisions.join('\n'),
    detail.actionItems.map(item => `${item.owner ? `[${item.owner}] ` : ''}${item.task}`).join('\n'),
    detail.attendees.join(', '),
    detail.transcript,
  ].join('\n\n').trim().length
  return {
    filename: detail.filename,
    ...(sessionId ? { sessionId } : {}),
    title: detail.title,
    date: detail.date,
    domain: detail.domain,
    domainAbbr: detail.domainAbbr,
    source: detail.source,
    duration: detail.duration,
    ...(detail.durationMinutes !== undefined ? { durationMinutes: detail.durationMinutes } : {}),
    month: detail.month,
    detailCharEstimate,
    estimatedDetailPages: Math.max(1, Math.ceil(detailCharEstimate / DETAIL_CHUNK_ESTIMATE_CHARS)),
    topicCount: detail.topics.length,
    decisionCount: detail.decisions.length,
    actionCount: detail.actionItems.length,
    attendeeCount: detail.attendees.length,
  }
}
