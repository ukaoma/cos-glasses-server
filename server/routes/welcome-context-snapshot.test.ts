import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// PH plan P1: fetchNextEvent through the EventKit snapshot. The calendar source is mocked: these
// tests pin what welcome-context does with each source, not how the source picks one.
const src = vi.hoisted(() => ({ read: { source: 'snapshot', data: {} as unknown, ageMs: 0 } as { source: string; data: unknown; ageMs: number | null } }))
vi.mock('../lib/calendar-source.js', () => ({
  readCalendar: async () => src.read,
  calendarToday: async () => ({ connected: false, source: 'none', asOf: null, stale: false, remainingCount: 0, next: [], endedRecently: [] }),
}))
vi.mock('../lib/python-bridge.js', () => ({
  pythonBridgeAvailable: () => false,
  callPython: async () => { throw new Error('the bridge must not be asked when the snapshot answered') },
}))

import { _resetWelcomeContextCachesForTests, fetchNextEvent } from './welcome-context.js'

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
const row = (over: Record<string, unknown>) => ({
  title: 'Real meeting', start_time: inMin(30), end_time: inMin(60), is_all_day: false,
  provider: 'eventkit', account: 'a@example.com', calendar_id: 'cal-work', event_id: 'e1', external_id: 'x1',
  occurrence_start: inMin(30), prep_worthy: true, ...over,
})

beforeEach(() => _resetWelcomeContextCachesForTests())
afterEach(() => _resetWelcomeContextCachesForTests())

describe('fetchNextEvent with the EventKit snapshot', () => {
  it('a snapshot read counts as a calendar read without the bridge, and carries the occurrence', async () => {
    src.read = { source: 'snapshot', ageMs: 1000, data: { today_remaining: [row({})] } }
    const r = await fetchNextEvent()
    expect(r.read).toBe(true)
    expect(r.event?.title).toBe('Real meeting')
    expect(r.event?.occurrence?.provider).toBe('eventkit')
  })

  it('skips a row the snapshot marked not prep-worthy (declined, family travel)', async () => {
    src.read = { source: 'snapshot', ageMs: 1000, data: { today_remaining: [row({ title: 'Flight to Austin', prep_worthy: false }), row({ event_id: 'e2', title: 'Pipeline review' })] } }
    const r = await fetchNextEvent()
    expect(r.event?.title).toBe('Pipeline review')
  })

  it("source 'none' (denied or expired) is never a read", async () => {
    src.read = { source: 'none', ageMs: null, data: { error: 'calendar_access_denied', today_remaining: [] } }
    const r = await fetchNextEvent()
    expect(r.read).toBe(false)
    expect(r.event).toBeNull()
  })
})
