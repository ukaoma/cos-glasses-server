// Week-wide QA (1-8 Nov) W21 and W23, the Meeting Ask half.
// W23: Meeting Ask matched every row of today_events, so a declined meeting (or a family flight) covering the
// recording's start was offered as "this meeting". It now runs the same prep filter as Next up and Today.
// W21: the snapshot's bridge-shaped rows carry domain: null (the classifier lives in people context, in Python), so a
// snapshot match never had a suggested domain. Meeting Ask now asks the bridge's own classifier for its candidates.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ available: false, calls: [] as Array<{ args: string[]; input?: string }>, answer: null as unknown, calendar: null as unknown }))
vi.mock('./python-bridge.js', () => ({
  pythonBridgeAvailable: () => bridge.available,
  callPython: async (args: string[], _t?: number, input?: string) => {
    bridge.calls.push({ args, input })
    return args[0] === 'calendar' ? bridge.calendar : bridge.answer
  },
}))

import { calendarCandidates } from './meeting-ask-orientation.js'

const START = Date.parse('2026-10-11T19:36:00Z')
const row = (over: Record<string, unknown> = {}) => ({
  title: 'Pricing review', start_time: '2026-10-11T19:30:00Z', end_time: '2026-10-11T20:00:00Z', is_all_day: false,
  attendees: ['Gina'], calendar_name: 'Work', ...over,
})

describe('W23: Meeting Ask runs the prep filter on today_events', () => {
  it('a declined meeting covering the recording start is never offered; the real one is', () => {
    const data = { today_events: [row({ title: 'Declined sync', prep_worthy: false }), row({ title: 'Real sync', prep_worthy: true })] }
    expect(calendarCandidates(data, START).map(c => c.title)).toEqual(['Real sync'])
  })
  it('a bridge row without prep_worthy still counts (the bridge already dropped declined)', () => {
    expect(calendarCandidates({ today_events: [row()] }, START).map(c => c.title)).toEqual(['Pricing review'])
  })
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '.cos-ask-cal-'))
  mkdirSync(join(dir, 'calendar'), { recursive: true })
  bridge.available = false
  bridge.calls = []
  bridge.answer = null
  bridge.calendar = null
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.useRealTimers() })

function writeSnapshot(now: number, events: unknown[]) {
  const iso = (ms: number) => new Date(ms).toISOString()
  writeFileSync(join(dir, 'calendar', 'snapshot.json'), JSON.stringify({
    version: 1, writtenAt: iso(now - 60_000), windowStart: iso(now - 86_400_000), windowEnd: iso(now + 7 * 86_400_000), access: 'granted',
    calendars: [{ id: 'cal-work', title: 'Work', account: 'm', sourceType: 'exchange', shared: false, selected: true }],
    events,
  }))
}

describe('W21: a snapshot match gets the bridge classifier\'s suggested domain', () => {
  // A local-time weekday so "today" holds the event whatever TZ the runner uses.
  const now = new Date(2026, 10, 9, 10, 5).getTime()
  const start = new Date(2026, 10, 9, 10, 0).toISOString(), end = new Date(2026, 10, 9, 10, 30).toISOString()
  const event = { calendarId: 'cal-work', eventId: 'e1', externalId: 'x1', occurrenceStart: start, start, end, allDay: false, floating: false,
    title: 'Pipeline review', myStatus: 'accepted', isOrganizer: false, attendees: [{ name: 'Gina', domain: 'example.com' }], meetingUrl: null }

  async function load() {
    vi.stubEnv('COS_DATA_DIR', dir)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    vi.resetModules()
    return import('./meeting-ask-orientation.js')
  }

  it('asks calendar-classify once over stdin with names only, and uses a safe domain it returns', async () => {
    writeSnapshot(now, [event])
    const mod = await load()
    bridge.available = true
    bridge.answer = { results: [{ domain: 'hermit_crabs', matched_person: 'Gina' }] }
    const { candidates } = await mod.meetingCalendar(now)
    expect(candidates.map(c => [c.title, c.suggestedDomain])).toEqual([['Pipeline review', 'hermit_crabs']])
    expect(bridge.calls.map(c => c.args)).toEqual([['calendar-classify']])
    const sent = JSON.parse(bridge.calls[0].input!)
    expect(sent).toEqual({ events: [{ title: 'Pipeline review', attendees: ['Gina'], calendar_name: 'Work' }] })
    expect(bridge.calls[0].input).not.toContain('example.com')
  })

  it('no bridge, a bad answer or an unsafe domain leaves the match without a suggestion', async () => {
    writeSnapshot(now, [event])
    const mod = await load()
    expect((await mod.meetingCalendar(now)).candidates[0].suggestedDomain).toBeUndefined()
    expect(bridge.calls).toHaveLength(0)
    bridge.available = true
    // Misaligned (more or fewer results than candidates) is refused whole, never matched up by position.
    for (const answer of [null, { error: 'unknown command' }, { results: [] }, { results: [{ domain: '../etc' }] }, { results: [{ domain: 'quilt' }, { domain: 'personal' }] }]) {
      bridge.answer = answer
      const { candidates } = await mod.meetingCalendar(now)
      expect(candidates).toHaveLength(1)
      expect(candidates[0].suggestedDomain, JSON.stringify(answer)).toBeUndefined()
    }
  })

  it('a bridge row that carries a domain is not asked again; one without sends names only, never an address', async () => {
    const mod = await load()   // no snapshot file: the bridge answers the calendar
    bridge.available = true
    const row = { title: 'Pipeline review', start_time: start, end_time: end, is_all_day: false, calendar_name: 'Work' }
    bridge.calendar = { today_events: [{ ...row, domain: 'quilt', attendees: ['Gina'] }] }
    bridge.answer = { results: [{ domain: 'personal' }] }
    expect((await mod.meetingCalendar(now)).candidates[0].suggestedDomain).toBe('quilt')
    expect(bridge.calls.map(c => c.args[0])).toEqual(['calendar'])
    bridge.calls = []
    bridge.calendar = { today_events: [{ ...row, attendees: ['Gina', 'gina@example.com'] }] }
    expect((await mod.meetingCalendar(now)).candidates[0].suggestedDomain).toBe('personal')
    const sent = bridge.calls.find(c => c.args[0] === 'calendar-classify')!
    expect(JSON.parse(sent.input!).events[0].attendees).toEqual(['Gina'])
  })
})
