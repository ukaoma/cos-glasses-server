// The shared meeting parser.
//
// meeting-store.test.ts already pins this through the store. These cover it
// directly, because the imported library now depends on the same behaviour and
// writes records FOR it: if the writer and the parser ever disagree about a
// field, the row and the record it opens disagree about the meeting.

import { describe, expect, it } from 'vitest'
import { boundedMeetingSource, parseField, parseMeeting, toMeta } from './meeting-parse.js'
import { MEETING_SOURCE_MAX_BYTES } from './meeting-store.js'

const RECORD = [
  '# Weekly planning',
  '',
  '| Field | Value |',
  '|-------|-------|',
  '| **Date** | 2026-09-10 14:30 |',
  '| **Duration** | 47 minutes |',
  '| **Source** | Fireflies |',
  '| **Domain** | imported |',
  '',
  '## Summary',
  '',
  'We agreed the launch date.',
  '',
  '## Action Items',
  '',
  '- Send the brief (**Gina**)',
  '',
  '## Attendees',
  '',
  '- Miles',
  '- Gina',
  '',
  '## Transcript',
  '',
  '[00:01:05] Miles: Lets start.',
  '',
].join('\n')

describe('fields', () => {
  it('reads a table field and a plain field', () => {
    expect(parseField(RECORD, 'Duration')).toBe('47 minutes')
    expect(parseField('**Duration:** 12 minutes', 'Duration')).toBe('12 minutes')
    expect(parseField(RECORD, 'Nothing')).toBe('')
  })

  it('parses a whole record', () => {
    const detail = parseMeeting(RECORD, '2026-09-10_fireflies_0123456789abcdef.md', '2026-09')
    expect(detail.title).toBe('Weekly planning')
    expect(detail.date).toBe('2026-09-10 14:30')
    expect(detail.domain).toBe('imported')
    expect(detail.source).toBe('Fireflies')
    expect(detail.durationMinutes).toBe(47)
    expect(detail.summary).toBe('We agreed the launch date.')
    expect(detail.actionItems).toEqual([{ task: 'Send the brief', owner: 'Gina' }])
    expect(detail.attendees).toEqual(['Miles', 'Gina'])
    expect(detail.transcript).toBe('[00:01:05] Miles: Lets start.')
  })

  it('treats a placeholder summary as no summary', () => {
    const record = RECORD.replace('We agreed the launch date.', '*Standalone recording — canonical transcript shown in meeting detail.*')
    expect(parseMeeting(record, 'x.md', '2026-09').summary).toBe('')
  })

  it('falls back to the filename date when the record has none', () => {
    const detail = parseMeeting('# Untitled\n\n## Transcript\n\nnothing', '2026-09-10_piece_0123456789abcdef.md', '2026-09')
    expect(detail.date).toBe('2026-09-10')
  })
})

describe('meta', () => {
  it('estimates pages from what the reader actually renders', () => {
    const detail = parseMeeting(RECORD, '2026-09-10_fireflies_0123456789abcdef.md', '2026-09')
    const meta = toMeta(detail, 'session-1')
    expect(meta.sessionId).toBe('session-1')
    expect(meta.attendeeCount).toBe(2)
    expect(meta.actionCount).toBe(1)
    expect(meta.detailCharEstimate).toBeGreaterThan(0)
    expect(meta.estimatedDetailPages).toBeGreaterThanOrEqual(1)
    // The transcript is part of the rendered body, so it must count.
    const longer = toMeta({ ...detail, transcript: 'x'.repeat(20_000) })
    expect(longer.estimatedDetailPages!).toBeGreaterThan(meta.estimatedDetailPages!)
  })

  it('omits a session when there is none', () => {
    expect(toMeta(parseMeeting(RECORD, 'a.md', '2026-09'))).not.toHaveProperty('sessionId')
  })
})

describe('bounded source', () => {
  it('returns the whole record under the ceiling', () => {
    expect(boundedMeetingSource('short')).toEqual({ sourceContent: 'short', sourceTruncated: false })
  })

  it('truncates on a character boundary', () => {
    const content = 'é'.repeat(MEETING_SOURCE_MAX_BYTES)
    const result = boundedMeetingSource(content)
    expect(result.sourceTruncated).toBe(true)
    expect(result.sourceContent).not.toContain('�')
    expect(Buffer.byteLength(result.sourceContent)).toBeLessThanOrEqual(MEETING_SOURCE_MAX_BYTES)
  })
})
