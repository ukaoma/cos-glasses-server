// 7.0.41 (U1; Miles 2026-11-14 "Collapsed, tap to open"): the plan ruler's lines, with the words from the round 2 states
// sheet. Times are in America/Chicago, as on Miles's Mac. The reading on 2026-11-14: Codex 96% used, reset 10:31 PM CST.
import { describe, expect, it } from 'vitest'
import { planPane, planLine, rulerWindow, whenWords, ageWords, estimateFor, PLAN_ESTIMATE_MIN_ELAPSED_MS } from './plan-pane.js'
import type { UsageEntry } from './usage.js'

const TZ = 'America/Chicago'
const NOW = Date.parse('2026-11-14T16:03:55Z') // 10:03:55 AM CST
const blank = (provider: 'claude' | 'codex' | 'cursor', over: Partial<UsageEntry> = {}): UsageEntry => ({ provider, reading: null, observedAt: null, source: 'none',
  lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false, ...over })
const codexWeek = (usedPct: number, over: Partial<UsageEntry> = {}) => blank('codex', { observedAt: NOW, source: 'probe',
  reading: { plan: 'prolite', allowed: true, available: true, windows: [{ kind: 'primary', usedPct, resetsAt: '2026-11-15T04:31:03.000Z', durationMins: 10080 }] }, ...over })
const claudeWeek = (usedPct: number, resetsAt: string, over: Partial<UsageEntry> = {}) => blank('claude', { observedAt: NOW, source: 'probe',
  reading: { plan: 'max', allowed: null, available: true, windows: [{ kind: 'session', usedPct: 99, resetsAt: '2026-11-14T18:00:00Z' }, { kind: 'weekly_all', usedPct, resetsAt }] }, ...over })

describe('the ruler draws only a live, stated reading', () => {
  it('fresh: the week, the used fill, the share of the week gone, and the words from the sheet', () => {
    const l = planLine(codexWeek(96), NOW, TZ)
    expect(l).toMatchObject({ state: 'fresh', usedPct: 96, gonePct: 92.6, windowStart: '2026-11-08T04:31:03.000Z', resetsAt: '2026-11-15T04:31:03.000Z',
      windowWords: 'Nov 7, 10:31 PM to Nov 14, 10:31 PM', short: '96% used, resets tonight', shortLong: '96% used, resets tonight 10:31 PM',
      long: '96% used. 93% of the week gone.', quiet: 'Codex 96% used' })
  })
  it('Claude draws its week across all models, never its 5-hour window', () => {
    expect(rulerWindow('claude', claudeWeek(23, '2026-11-16T08:00:00Z').reading!.windows)!.w.kind).toBe('weekly_all')
    expect(planLine(claudeWeek(23, '2026-11-16T08:00:00Z'), NOW, TZ)).toMatchObject({ usedPct: 23, short: '23% used, resets Mon' })
  })
  it('older than 25 minutes: same ruler, the age replaces the reset', () => {
    expect(planLine(codexWeek(96, { observedAt: NOW - 3 * 3_600_000 }), NOW, TZ)).toMatchObject({ state: 'older', usedPct: 96, short: '96% used, read 3 h ago',
      long: '96% used. 93% of the week gone. Read 3 h ago; it may have moved.' })
  })
  it('limit reached: a full ruler and when it lifts; it beats any percentage', () => {
    expect(planLine(codexWeek(40, { limitUntil: Date.parse('2026-11-15T04:31:03Z'), limitSource: 'provider_limit' }), NOW, TZ))
      .toMatchObject({ state: 'limit', usedPct: 100, gonePct: null, short: 'Limit reached, back tonight 10:31 PM' })
    expect(planLine(codexWeek(40, { reading: { ...codexWeek(40).reading!, allowed: false } }), NOW, TZ)).toMatchObject({ state: 'limit', usedPct: 100 })
  })
  it('a failed, paused, missing or ended reading draws no ruler, so it can never look like 0% used', () => {
    const failed = planLine(claudeWeek(23, '2026-11-16T08:00:00Z', { lastFailure: 'no_limits', lastError: 'Claude gave no plan limits' }), NOW, TZ)
    expect(failed).toMatchObject({ state: 'failed', usedPct: null, gonePct: null, short: 'Read failed, refused by Claude',
      long: 'Read failed: refused by Claude. No number is shown until a read succeeds.', quiet: 'Claude read failed' })
    const paused = planLine(blank('claude', { lastFailure: 'no_limits', holdUntil: Date.parse('2026-11-14T17:05:00Z') }), NOW, TZ)
    expect(paused).toMatchObject({ state: 'paused', usedPct: null, short: 'Paused until 11:05 AM' })
    expect(paused.long).toContain('The last read: refused by Claude.')
    expect(planLine(blank('claude'), NOW, TZ)).toMatchObject({ state: 'not_read', usedPct: null, short: 'Not read today', long: 'Not read yet. Refresh to read it.' })
    // The Oct 23 reading on his Mac: its week reset Oct 26. Not shown as 77% left, or as any number.
    const ended = planLine(claudeWeek(23, '2026-10-26T07:59:59Z', { observedAt: Date.parse('2026-10-23T14:18:57Z') }), NOW, TZ)
    expect(ended).toMatchObject({ state: 'not_read', usedPct: null, gonePct: null, short: 'Not read today' })
    expect(ended.long).toBe('Not read since its window ended (last read Oct 23, 9:18 AM). Refresh to read it.')
  })
  it('Cursor: no plan reading, never a ruler', () => {
    expect(planLine(blank('cursor'), NOW, TZ)).toMatchObject({ state: 'no_plan', usedPct: null, short: 'No plan reading', quiet: 'Cursor no plan reading' })
  })
  it('a failure is named in plain words, never the exception text', () => {
    expect(planLine(blank('codex', { lastFailure: 'error', lastError: 'spawn /Users/someone/x ENOENT' }), NOW, TZ).short).toBe('Read failed, unexpected error')
    expect(planLine(blank('codex', { lastFailure: 'timed_out' }), NOW, TZ).short).toBe('Read failed, no answer in time')
  })
})

describe('the closed row and the estimate', () => {
  it('the closed row shows the tool closest to its limit; the rest in quiet words', () => {
    const pane = planPane([blank('claude', { lastFailure: 'no_limits' }), codexWeek(96), blank('cursor')], NOW, TZ)
    expect(pane).toMatchObject({ protocolVersion: 1, closest: 'codex', others: 'Claude read failed. Cursor no plan reading.', readAt: new Date(NOW).toISOString() })
    expect(pane.lines.map(l => l.provider)).toEqual(['claude', 'codex', 'cursor'])
    expect(planPane([blank('claude'), blank('codex'), blank('cursor')], NOW, TZ)).toMatchObject({ closest: null, readAt: null })
  })
  it('the estimate is labelled by the client and carries its arithmetic: 96% in 6 days 11.5 hours of 7 days', () => {
    expect(planLine(codexWeek(96), NOW, TZ).estimate).toEqual({
      text: "At this week's average pace, Codex reaches its limit about 4:30 PM, before it resets tonight 10:31 PM.",
      arithmetic: 'Worked out from 96% used in 6 days 11.5 hours of 7 days, about 0.6% an hour.' })
  })
  it('no estimate in the first 12 hours, for a failed or ended reading, at the limit, or for Cursor; under pace it says so', () => {
    const start = Date.parse('2026-11-08T04:31:03Z'), reset = Date.parse('2026-11-15T04:31:03Z')
    expect(estimateFor('Codex', 10, start, reset, start + PLAN_ESTIMATE_MIN_ELAPSED_MS - 1, TZ)).toBeNull()
    expect(estimateFor('Codex', 100, start, reset, NOW, TZ)).toBeNull()
    expect(planLine(blank('claude', { lastFailure: 'no_limits' }), NOW, TZ).estimate).toBeNull()
    expect(planLine(blank('cursor'), NOW, TZ).estimate).toBeNull()
    expect(estimateFor('Codex', 50, start, reset, NOW, TZ)!.text).toBe("At this week's average pace, Codex stays under its limit until it resets tonight 10:31 PM.")
  })
  it('reset and age words', () => {
    expect(whenWords('2026-11-15T04:31:03Z', NOW, TZ)).toEqual({ long: 'tonight 10:31 PM', short: 'tonight' })
    expect(whenWords('2026-11-14T21:00:00Z', NOW, TZ)).toEqual({ long: 'today 3:00 PM', short: 'today' })
    expect(whenWords('2026-11-15T16:00:00Z', NOW, TZ).long).toBe('tomorrow 10:00 AM')
    expect(ageWords(new Date(NOW - 25 * 60_000).toISOString(), NOW, TZ)).toBe('25 min ago')
    expect(ageWords('2026-10-23T14:18:57Z', NOW, TZ)).toBe('Oct 23')
  })
})
