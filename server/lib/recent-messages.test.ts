import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RECENT_MESSAGES_DEFAULT_LIMIT, RECENT_MESSAGES_MAX_LIMIT, recentMessagesLimit, selectRecentMessages } from './recent-messages.js'

const row = (sessionId: string, timestamp: number, tag = '') => ({ sessionId, timestamp, tag })

describe('recent messages are a rolling window (6.45.3)', () => {
  it('takes the newest N across live sessions and archived days, chronological, reading only the days it needs', () => {
    const live = [row('live-a', 1_000), row('live-b', 900), row('live-a', 1_100)]
    const reads: string[] = []
    const days = [
      () => { reads.push('d3'); return [row('arc-3', 800), row('arc-3', 850)] },
      () => { reads.push('d2'); return [row('arc-2', 700)] },
      () => { reads.push('d1'); return [row('arc-1', 600)] },
    ]
    const out = selectRecentMessages(live, days, 4)
    expect(out.map(m => m.timestamp)).toEqual([850, 900, 1_000, 1_100])
    expect(reads).toEqual(['d3'])
  })

  it('walks further back when live and the newest day cannot fill the window', () => {
    const days = [() => [row('arc-3', 800)], () => [row('arc-2', 700)], () => [row('arc-1', 600)]]
    const out = selectRecentMessages([row('live', 900)], days, 3)
    expect(out.map(m => m.timestamp)).toEqual([700, 800, 900])
  })

  it('counts a live turn and its archive mirror once', () => {
    const live = [row('s1', 500, 'live')]
    const out = selectRecentMessages(live, [() => [row('s1', 500, 'mirror'), row('s1', 400)]], 30)
    expect(out).toEqual([row('s1', 400), row('s1', 500, 'live')])
  })

  it('never hides a message by the calendar: an old live session still counts', () => {
    const out = selectRecentMessages([row('yesterday', 100)], [], 30)
    expect(out).toEqual([row('yesterday', 100)])
  })

  it('bounds the limit', () => {
    expect(recentMessagesLimit(undefined)).toBe(RECENT_MESSAGES_DEFAULT_LIMIT)
    expect(recentMessagesLimit('0')).toBe(RECENT_MESSAGES_DEFAULT_LIMIT)
    expect(recentMessagesLimit('12')).toBe(12)
    expect(recentMessagesLimit('9999')).toBe(RECENT_MESSAGES_MAX_LIMIT)
  })

  it('the route reads every live session and walks archived days through the window', () => {
    const source = readFileSync(new URL('../routes/sessions.ts', import.meta.url), 'utf8')
    const route = source.slice(source.indexOf("sessionsRouter.get('/sessions/today/all-messages'"), source.indexOf("window: { kind: 'recent', limit }"))
    const liveLoop = route.slice(route.indexOf('const liveSessions = getActiveSessions()'), route.indexOf('const merged = selectRecentMessages('))
    // No calendar test of any spelling may skip a live session inside the window.
    expect(liveLoop).not.toMatch(/todayDate\)\s*continue/)
    expect(liveLoop).not.toMatch(/localDay\(session\.lastActivity\)/)
    expect(liveLoop).toContain('Every live session, whatever day it last spoke')
    expect(route).toContain('listArchiveDateStrings().map(date => () => archivedDay(date))')
    expect(route).toContain('recentMessagesLimit(req.query.limit)')
  })
})
