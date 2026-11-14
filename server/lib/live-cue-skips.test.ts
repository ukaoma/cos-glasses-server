/**
 * The build after 7.0.42 (Memories C, lead 2026-11-14 15:58 and 16:03): "Skip this meeting" (lib/live-cue-skips.ts) and
 * the meetings-to-rate count it feeds (LiveCueVerdicts.unratedSessionCount, status needsYou.meetings). Real files in a
 * temp dir, an injected clock. Placeholder words only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LiveCueSkipStore, MAX_MEETING_SKIPS, SKIP_TTL_MS, SkipsUnreadableError } from './live-cue-skips.js'
import { LiveCueLog, LiveCueVerdicts, LiveCueVerdictStore, VerdictsUnreadableError, type LiveCueLogRow } from './live-cue-verdicts.js'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-14T15:00:00.000Z')
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })
const tmp = () => { const r = mkdtempSync(join(tmpdir(), 'cue-skips-')); roots.push(r); return r }

let n = 0
const cueId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const row = (sessionId: string, createdAt: number, extra: Partial<LiveCueLogRow> = {}): LiveCueLogRow => ({
  v: 1, cueId: cueId(), sessionId, meetingTitle: 'G2 Recording', createdAt, armedAt: createdAt - 60_000, kind: 'challenge',
  headline: 'Name the owner', detail: 'Name the owner today.', gate: 0.88, sources: [], model: 'm', before: '', ...extra,
} as LiveCueLogRow)

function harness() {
  const dir = tmp()
  let now = T0
  const clock = () => now
  const skips = new LiveCueSkipStore(join(dir, 'live-cues-skips.json'), clock)
  const v = new LiveCueVerdicts({
    log: new LiveCueLog(join(dir, 'live-cues-log.jsonl')), store: new LiveCueVerdictStore(join(dir, 'live-cues-verdicts.json')),
    now: clock, trace: () => {}, resolveTitle: () => null, skips,
  })
  const log = (r: LiveCueLogRow) => { v.logCue(r); return r }
  return { dir, v, skips, log, at: (ms: number) => { now = ms }, file: join(dir, 'live-cues-skips.json') }
}

describe('the skip store', () => {
  it('skips, re-skips at the new time, clears, and survives a restart; the file is 0600', () => {
    const h = harness()
    expect(h.skips.skip('meeting_a')).toEqual({ ok: true, sessionId: 'meeting_a', skippedAt: T0 })
    expect(statSync(h.file).mode & 0o777).toBe(0o600)
    h.at(T0 + 1000)
    expect(h.skips.skip('meeting_a')).toEqual({ ok: true, sessionId: 'meeting_a', skippedAt: T0 + 1000 })
    expect(new LiveCueSkipStore(h.file, () => T0 + 2000).read()).toEqual({ meeting_a: T0 + 1000 })
    expect(h.skips.clear('meeting_a')).toEqual({ ok: true, sessionId: 'meeting_a', skippedAt: null })
    expect(h.skips.read()).toEqual({})
  })

  it('clearing a meeting that is not skipped writes nothing', () => {
    const h = harness()
    expect(h.skips.clear('meeting_a')).toEqual({ ok: true, sessionId: 'meeting_a', skippedAt: null })
    expect(() => statSync(h.file)).toThrow()
  })

  it('a skip expires 7 days after it was made, and is dropped from the file on the next write', () => {
    const h = harness()
    h.skips.skip('old')
    h.at(T0 + SKIP_TTL_MS - 1)
    expect(Object.keys(h.skips.read())).toEqual(['old'])
    h.at(T0 + SKIP_TTL_MS)
    expect(h.skips.read()).toEqual({})
    h.skips.skip('new')
    expect(Object.keys(JSON.parse(readFileSync(h.file, 'utf8')).skips)).toEqual(['new'])
  })

  it('refuses a new skip past MAX_MEETING_SKIPS live ones, writing nothing; re-skipping one already there still works', () => {
    const h = harness()
    const skips: Record<string, { at: number }> = {}
    for (let i = 0; i < MAX_MEETING_SKIPS; i++) skips[`m${i}`] = { at: T0 }
    writeFileSync(h.file, JSON.stringify({ v: 1, skips }))
    const before = readFileSync(h.file, 'utf8')
    expect(h.skips.skip('one_more')).toEqual({ ok: false, error: 'skips_full' })
    expect(readFileSync(h.file, 'utf8')).toBe(before)
    expect(h.skips.skip('m0').ok).toBe(true)
    // Expired skips do not count toward the cap.
    h.at(T0 + SKIP_TTL_MS)
    expect(h.skips.skip('one_more').ok).toBe(true)
  })

  it('an unreadable or foreign file throws (never "no skips") and is left as it is', () => {
    const h = harness()
    for (const text of ['{not json', JSON.stringify({ v: 2, skips: {} }), JSON.stringify({ v: 1, skips: [] }), JSON.stringify(null)]) {
      writeFileSync(h.file, text)
      expect(() => h.skips.read()).toThrow(SkipsUnreadableError)
      expect(() => h.skips.skip('meeting_a')).toThrow(SkipsUnreadableError)
      expect(readFileSync(h.file, 'utf8')).toBe(text)
    }
  })

  it('a malformed entry is left out, the rest kept', () => {
    const h = harness()
    writeFileSync(h.file, JSON.stringify({ v: 1, skips: { good: { at: T0 }, bad: { at: 'x' }, none: null } }))
    expect(h.skips.read()).toEqual({ good: T0 })
  })
})

describe('meetings to rate (unratedSessionCount)', () => {
  it('counts meetings with an unrated cue in the window, once each; rated, held, duplicate and old cues do not count', () => {
    const h = harness()
    h.log(row('a', T0 - DAY)); h.log(row('a', T0 - DAY + 1))
    const rated = h.log(row('b', T0 - DAY))
    h.log(row('c', T0 - DAY, { held: true }))
    h.log(row('d', T0 - 8 * DAY))
    h.v.rate({ sessionId: 'b', cueId: rated.cueId, verdict: 'useful' }, null)
    expect(h.v.unratedSessionCount(7)).toBe(1)
    const dup = h.log(row('e', T0 - DAY))
    h.v.rate({ sessionId: 'e', cueId: dup.cueId, verdict: 'late' }, null)
    h.log({ ...dup, createdAt: T0 - 1000 })   // the same cue logged again: still one cue, still rated
    expect(h.v.unratedSessionCount(7)).toBe(1)
  })

  it('a skip covers the cues shown before it; a cue logged one millisecond after brings the meeting back', () => {
    const h = harness()
    h.log(row('a', T0 - 5000))
    h.log(row('b', T0 - 5000))
    expect(h.v.unratedSessionCount(7)).toBe(2)
    h.at(T0)
    expect(h.v.skipMeeting('a').ok).toBe(true)
    expect(h.v.unratedSessionCount(7)).toBe(1)
    h.log(row('a', T0))                       // logged at the same millisecond as the skip: still covered
    expect(h.v.unratedSessionCount(7)).toBe(1)
    h.log(row('a', T0 + 1))                   // one millisecond later: the meeting is back
    expect(h.v.unratedSessionCount(7)).toBe(2)
    expect(h.v.clearSkip('a').ok).toBe(true)
    expect(h.v.unratedSessionCount(7)).toBe(2)
  })

  it('the same cue logged again after the skip does not bring the meeting back (history keeps its first showing)', () => {
    const h = harness()
    const first = h.log(row('a', T0 - 5000))
    h.at(T0)
    h.v.skipMeeting('a')
    h.log({ ...first, createdAt: T0 + 1000 })   // re-logged later (a cue shown again): one cue, first shown before the skip
    expect(h.v.unratedSessionCount(7)).toBe(0)
  })

  it('counts past a thousand unrated cues by meeting (no page limit)', () => {
    const h = harness()
    for (let i = 0; i < 1100; i++) h.log(row(`m${i % 3}`, T0 - DAY + i))
    expect(h.v.unratedSessionCount(7)).toBe(3)
    // The page's own list agrees, meeting for meeting, while it fits.
    const page = h.v.history({ days: 7, unrated: true, limit: 1000 })
    expect(new Set(page.cues.map(c => c.sessionId)).size).toBe(3)
  })

  it('equals the meetings the page lists from history, skipped ones left out', () => {
    const h = harness()
    for (const [s, t] of [['a', 1], ['b', 2], ['c', 3], ['c', 4]] as const) h.log(row(s, T0 - DAY + t))
    h.v.skipMeeting('b')
    const page = h.v.history({ days: 7, unrated: true, limit: 1000 })
    const skips = h.v.liveSkips()
    const listed = new Set(page.cues.filter(c => !(c.sessionId in skips && c.createdAt <= skips[c.sessionId]!)).map(c => c.sessionId))
    expect(h.v.unratedSessionCount(7)).toBe(listed.size)
    expect([...listed].sort()).toEqual(['a', 'c'])
  })

  it('an unreadable verdicts or skips file throws, never a count', () => {
    const h = harness()
    h.log(row('a', T0 - DAY))
    writeFileSync(h.file, '{not json')
    expect(() => h.v.unratedSessionCount(7)).toThrow(SkipsUnreadableError)
    rmSync(h.file)
    writeFileSync(join(h.dir, 'live-cues-verdicts.json'), '{not json')
    expect(() => h.v.unratedSessionCount(7)).toThrow(VerdictsUnreadableError)
  })

  it('skips only a meeting with a shown cue in the 7-day window; nothing can seed other ids', () => {
    const h = harness()
    h.log(row('held_only', T0 - DAY, { held: true }))
    h.log(row('too_old', T0 - SKIP_TTL_MS - 1))
    h.log(row('real', T0 - DAY))
    for (const id of ['never_seen', 'held_only', 'too_old']) {
      expect(h.v.skipMeeting(id)).toEqual({ ok: false, error: 'unknown_meeting' })
      expect(h.v.clearSkip(id)).toEqual({ ok: false, error: 'unknown_meeting' })
    }
    expect(() => statSync(h.file)).toThrow()
    expect(h.v.skipMeeting('real').ok).toBe(true)
    expect(Object.keys(h.v.liveSkips())).toEqual(['real'])
    expect(h.v.liveSkips(['other'])).toEqual({})
  })

  it('without a skips store the count works and the skip methods refuse', () => {
    const dir = tmp()
    const v = new LiveCueVerdicts({ log: new LiveCueLog(join(dir, 'l.jsonl')), store: new LiveCueVerdictStore(join(dir, 'v.json')), now: () => T0, trace: () => {}, resolveTitle: () => null })
    v.logCue(row('a', T0 - DAY))
    expect(v.unratedSessionCount(7)).toBe(1)
    expect(v.skipMeeting('a')).toEqual({ ok: false, error: 'unknown_meeting' })
    expect(v.liveSkips()).toEqual({})
  })
})
