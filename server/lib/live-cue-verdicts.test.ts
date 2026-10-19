import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** A blocking open of a FIFO never returns and no in-process timeout can interrupt it, so FIFO probes run in a child
 *  with a hard kill: a regression fails here in seconds instead of hanging the suite. */
function probeInChild(body: string): { status: number | null; out: string } {
  const mod = fileURLToPath(new URL('./live-cue-verdicts.ts', import.meta.url))
  const r = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
    `const m = await import(${JSON.stringify(mod)}); ${body}`], { encoding: 'utf8', timeout: 8000, env: { ...process.env } })
  return { status: r.status, out: (r.stdout ?? '').trim() }
}
import { tmpdir } from 'node:os'
import {
  LIVE_CUE_VERDICT_LIMITS as L, LiveCueLog, LiveCueVerdictStore, LiveCueVerdicts, VerdictsUnreadableError, cleanNote, cueBefore, isLogRow, type LiveCueLogRow,
} from './live-cue-verdicts.js'

const DAY = 24 * 60 * 60_000
const T0 = Date.parse('2026-10-19T15:00:00Z')

let dir: string
let clock: number
let traces: Array<Record<string, unknown>>
let titles: Record<string, { title: string; source: 'saved' | 'library' }>
let titleCalls: number
let svc: LiveCueVerdicts
const logFile = () => join(dir, 'live-cues-log.jsonl')
const verdictFile = () => join(dir, 'live-cues-verdicts.json')
function row(cueId: string, over: Partial<LiveCueLogRow> = {}): LiveCueLogRow {
  return { v: 1, cueId, sessionId: 'meeting_a', meetingTitle: 'G2 Recording 2026-10-19 1000', createdAt: clock, armedAt: clock - 60_000, kind: 'challenge',
    headline: 'Name who quotes the cap', detail: 'Name who quotes the cap today.', gate: 0.91, sources: [], model: 'claude-sonnet-5-5',
    prompt: 'v3', memorySource: 'cue_memory', kept: 1, before: 'we said the cap', ...over }
}
const id = (n: number) => `0f8fad5b-d9cb-469f-a165-${String(n).padStart(12, '0')}`
const ids = () => svc.deps.log.read().rows.map(r => r.cueId)
const rate = (cueId: string, verdict: Parameters<LiveCueVerdicts['rate']>[0]['verdict'], over: { sessionId?: string; note?: string; live?: string | null } = {}) =>
  svc.rate({ sessionId: over.sessionId ?? 'meeting_a', cueId, verdict, ...(over.note !== undefined ? { note: over.note } : {}) }, over.live ?? null)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cue-verdicts-'))
  clock = T0
  traces = []
  titles = {}
  titleCalls = 0
  svc = new LiveCueVerdicts({
    log: new LiveCueLog(logFile()),
    store: new LiveCueVerdictStore(verdictFile()),
    now: () => clock,
    trace: r => { traces.push(r) },
    resolveTitle: sid => { titleCalls += 1; return titles[sid] ?? null },
  })
})
afterEach(() => { try { chmodSync(verdictFile(), 0o600) } catch { /* absent */ } rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('helpers', () => {
  it('before is whitespace-collapsed and keeps the LAST 400 code points (what was said just before)', () => {
    expect(cueBefore('  a\n\n b\t c  ')).toBe('a b c')
    const said = cueBefore('x'.repeat(500) + ' END')
    expect(said).toHaveLength(400)
    expect(said.endsWith(' END')).toBe(true)
    const emoji = cueBefore('😀'.repeat(401))                       // 802 UTF-16 units: a unit slice would split a pair
    expect(Array.from(emoji)).toHaveLength(400)
    expect(emoji).toBe('😀'.repeat(400))
  })
  it('a note is whitespace-collapsed and truncated at 200 (the lens reason rule)', () => {
    expect(cleanNote(' too\n late ')).toBe('too late')
    expect(cleanNote('n'.repeat(300))).toHaveLength(200)
    expect(cleanNote(undefined)).toBe('')
  })
})

describe('log row schema', () => {
  it('a hand-seeded row (before "", none of the optional fields) is valid', () => {
    const { armedAt: _a, prompt: _p, memorySource: _m, kept: _k, ...seed } = row(id(1), { before: '' })
    expect(isLogRow(seed)).toBe(true)
    expect(isLogRow(row(id(1)))).toBe(true)
    expect(isLogRow(row(id(1), { prompt: 'v4' }))).toBe(true)          // a newer writer's rows are never skipped
    expect(isLogRow(row(id(1), { wouldWithhold: { perMeeting: true, perTopic: false, blockerCueId: id(9) } }))).toBe(true)
    expect(isLogRow(row(id(1), { wouldWithhold: { perMeeting: false, perTopic: false } }))).toBe(true)
  })
  it('every field is checked', () => {
    const bad: Array<Record<string, unknown>> = [
      { v: 2 }, { cueId: '' }, { cueId: 7 }, { sessionId: '' }, { meetingTitle: null }, { createdAt: '1' }, { createdAt: Number.NaN },
      { armedAt: 'x' }, { kind: 'nudge' }, { headline: 1 }, { detail: undefined }, { gate: '0.9' }, { model: null }, { before: null },
      { sources: 'none' }, { sources: [{ id: 'a', date: 'b' }] }, { sources: [null] }, { prompt: 'four' }, { prompt: 'v' }, { prompt: 3 },
      { wouldWithhold: true }, { wouldWithhold: { perMeeting: 'yes', perTopic: false } }, { wouldWithhold: { perMeeting: true } },
      { wouldWithhold: { perMeeting: true, perTopic: false, blockerCueId: 5 } }, { memorySource: 'web' }, { kept: '2' },
    ]
    for (const over of bad) expect(isLogRow({ ...row(id(1)), ...over }), JSON.stringify(over)).toBe(false)
    expect(isLogRow([row(id(1))])).toBe(false)
    expect(isLogRow(null)).toBe(false)
  })
})

describe('cue log', () => {
  it('appends one JSON line per cue, mode 0600, and reads them back', () => {
    svc.logCue(row(id(1)))
    svc.logCue(row(id(2)))
    expect(readFileSync(logFile(), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(statSync(logFile()).mode & 0o777).toBe(0o600)
    expect(svc.deps.log.read()).toEqual({ rows: [row(id(1)), row(id(2))], skipped: 0 })
  })

  it('torn, foreign and invalid lines anywhere are skipped and counted; a fragment without newline does not swallow the next cue', () => {
    svc.logCue(row(id(1)))
    appendFileSync(logFile(), '{"kind":"not a cue"}\n')                             // foreign JSON
    appendFileSync(logFile(), JSON.stringify({ ...row(id(7)), kind: 'nudge' }) + '\n') // a bad seed
    appendFileSync(logFile(), '{"v":1,"cueId":"torn')                              // a partial append, no newline
    expect(svc.deps.log.read()).toMatchObject({ skipped: 3 })
    svc.logCue(row(id(2)))
    expect(svc.deps.log.read()).toMatchObject({ skipped: 3 })
    expect(ids()).toEqual([id(1), id(2)])
  })

  it('parsed rows are cached until the file changes', () => {
    svc.logCue(row(id(1)))
    const first = svc.deps.log.read().rows
    expect(svc.deps.log.read().rows).toBe(first)                  // unchanged file: no reparse
    appendFileSync(logFile(), JSON.stringify(row(id(2))) + '\n')     // a hand seed from outside
    expect(svc.deps.log.read().rows.map(r => r.cueId)).toEqual([id(1), id(2)])
  })

  it('a missing log reads as empty, never a throw', () => {
    expect(svc.deps.log.read()).toEqual({ rows: [], skipped: 0 })
    expect(svc.history({ days: 7, unrated: false, limit: 200 })).toMatchObject({ cues: [], counts: { total: 0 }, truncated: false, skipped: 0 })
  })

  it('a FIFO at the log path is refused at once, never opened blocking (it would freeze the event loop)', () => {
    execFileSync('mkfifo', [logFile()])
    const append = probeInChild(`const log = new m.LiveCueLog(${JSON.stringify(logFile())});
      try { log.append(${JSON.stringify(row(id(1)))}); console.log('appended') } catch (e) { console.log('refused: ' + e.message) }`)
    expect(append).toEqual({ status: 0, out: 'refused: the cue log is not a regular file' })
    const read = probeInChild(`console.log(JSON.stringify(new m.LiveCueLog(${JSON.stringify(logFile())}).read()))`)
    expect(read).toEqual({ status: 0, out: '{"rows":[],"skipped":0}' })
  })

  it('an append failure throws to the caller (the engine traces it)', () => {
    const broken = new LiveCueVerdicts({ ...svc.deps, log: new LiveCueLog(join(dir, 'not-a-dir', 'x')) })
    writeFileSync(join(dir, 'not-a-dir'), 'file in the way')
    expect(() => broken.logCue(row(id(1)))).toThrow()
  })

  it('prune drops cues past 30 days and blanks before past 7 days, by atomic rewrite, mode 0600, no temp file', () => {
    const log = svc.deps.log                                     // straight to the log: logCue's prune would run first
    log.append(row(id(1), { createdAt: T0 - L.retentionMs - 1 }))
    log.append(row(id(2), { createdAt: T0 - L.retentionMs }))
    log.append(row(id(3), { createdAt: T0 - L.beforeRetentionMs - 1 }))
    log.append(row(id(4), { createdAt: T0 - L.beforeRetentionMs }))
    log.append(row(id(5)))
    expect(log.prune(T0)).toMatchObject({ dropped: 1, blanked: 2 })
    expect(log.read().rows.map(r => [r.cueId, r.before])).toEqual([[id(2), ''], [id(3), ''], [id(4), 'we said the cap'], [id(5), 'we said the cap']])
    expect(log.read().rows[0]).toMatchObject({ detail: 'Name who quotes the cap today.', headline: 'Name who quotes the cap' })   // only the excerpt goes
    expect(statSync(logFile()).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    const inode = statSync(logFile()).ino
    expect(log.prune(T0)).toMatchObject({ dropped: 0, blanked: 0 })   // nothing to change: no rewrite (a rename changes the inode)
    expect(statSync(logFile()).ino).toBe(inode)
  })

  it('prunes on first use in the process, then at most once a day', () => {
    svc.deps.log.append(row(id(9), { createdAt: T0 - L.retentionMs - 1 }))   // left by an earlier process
    svc.logCue(row(id(1)))                                                  // first use: prunes id(9)
    expect(ids()).toEqual([id(1)])
    clock += L.retentionMs + 1                                              // id(1) is now past retention
    svc.logCue(row(id(2)))                                                  // over a day since the last prune
    expect(ids()).toEqual([id(2)])
    svc.logCue(row(id(3), { createdAt: clock - L.retentionMs - 5 }))
    clock += L.pruneEveryMs - 1                                             // under a day: the old row stays
    svc.logCue(row(id(4)))
    expect(ids()).toEqual([id(2), id(3), id(4)])
    clock += 1
    svc.logCue(row(id(5)))
    expect(ids()).toEqual([id(2), id(4), id(5)])
  })

  it('the first history read and the first rating in a process prune too', () => {
    svc.deps.log.append(row(id(9), { createdAt: T0 - L.retentionMs - 1 }))
    svc.history({ days: 30, unrated: false, limit: 200 })
    expect(ids()).toEqual([])
    const other = new LiveCueVerdicts({ ...svc.deps })
    svc.deps.log.append(row(id(8), { createdAt: T0 - L.retentionMs - 1 }))
    svc.deps.log.append(row(id(1)))
    other.rate({ sessionId: 'meeting_a', cueId: id(1), verdict: 'useful' }, null)
    expect(ids()).toEqual([id(1)])
  })

  it('verdicts go with their cues; with no log at all they are left alone', () => {
    svc.logCue(row(id(1), { createdAt: T0 - L.retentionMs + 10 }))
    svc.logCue(row(id(2)))
    rate(id(1), 'useful'); rate(id(2), 'late')
    clock += 11
    svc.prune()
    expect(Object.keys(svc.deps.store.read())).toEqual([id(2)])
    rmSync(logFile())
    svc.prune()
    expect(Object.keys(svc.deps.store.read())).toEqual([id(2)])
  })
})

describe('verdicts', () => {
  beforeEach(() => { svc.logCue(row(id(1))) })

  it('rates a cue found only in the log, stores it atomically, and answers { ok, cueId, verdict, vote }', () => {
    expect(rate(id(1), 'late', { note: ' came  after\nthe point ' })).toEqual({ ok: true, response: { ok: true, cueId: id(1), verdict: 'late', vote: null } })
    expect(JSON.parse(readFileSync(verdictFile(), 'utf8'))).toEqual({ v: 1, verdicts: { [id(1)]: { verdict: 'late', note: 'came after the point', at: T0 } } })
    expect(statSync(verdictFile()).mode & 0o777).toBe(0o600)
  })

  it('the trace row never carries the note', () => {
    rate(id(1), 'late', { note: 'private words' })
    expect(traces).toEqual([{ kind: 'feedback', at: new Date(T0).toISOString(), sessionId: 'meeting_a', cueId: id(1), verdict: 'late', knownCue: true, noted: true }])
    expect(JSON.stringify(traces)).not.toContain('private')
  })

  it('a note over 200 characters is truncated, not refused', () => {
    rate(id(1), 'wrong', { note: 'w'.repeat(450) })
    expect(svc.deps.store.read()[id(1)].note).toHaveLength(200)
  })

  it('an unknown cue is unknown_cue, a logged cue under another meeting is cue_session_mismatch, and neither writes', () => {
    expect(rate(id(9), 'useful')).toEqual({ ok: false, error: 'unknown_cue' })
    expect(rate(id(1), 'useful', { sessionId: 'meeting_b' })).toEqual({ ok: false, error: 'cue_session_mismatch' })
    expect(existsSync(verdictFile())).toBe(false)
    expect(traces).toEqual([])
  })

  it('the running engine owns a cue it holds (its log append may have failed), and its meeting wins', () => {
    expect(rate(id(9), 'useful', { live: 'meeting_a' })).toMatchObject({ ok: true })
    expect(rate(id(9), 'useful', { live: 'meeting_b' })).toEqual({ ok: false, error: 'cue_session_mismatch' })
  })

  it('last write wins, and a new verdict without a note drops the old note', () => {
    rate(id(1), 'wrong', { note: 'not what was said' })
    clock += 1000
    rate(id(1), 'useful')
    expect(svc.deps.store.read()[id(1)]).toEqual({ verdict: 'useful', at: T0 + 1000 })
  })

  it('clear removes the verdict and the record when nothing is left', () => {
    rate(id(1), 'repeat', { note: 'again' })
    expect(rate(id(1), 'clear')).toEqual({ ok: true, response: { ok: true, cueId: id(1), verdict: null, vote: null } })
    expect(JSON.parse(readFileSync(verdictFile(), 'utf8'))).toEqual({ v: 1, verdicts: {} })
  })

  it('a lens vote sits beside the verdict and never overwrites it; clear drops verdict and note and keeps the vote', () => {
    rate(id(1), 'obvious', { note: 'knew it' })
    svc.vote('meeting_a', id(1), 'up', null)
    expect(svc.deps.store.read()[id(1)]).toMatchObject({ verdict: 'obvious', note: 'knew it', vote: 'up' })
    rate(id(1), 'useful')
    expect(svc.deps.store.read()[id(1)]).toMatchObject({ verdict: 'useful', vote: 'up' })
    expect(rate(id(1), 'clear', { note: 'ignored' })).toEqual({ ok: true, response: { ok: true, cueId: id(1), verdict: null, vote: 'up' } })
    expect(JSON.parse(readFileSync(verdictFile(), 'utf8')).verdicts[id(1)]).toEqual({ vote: 'up', at: T0 })
  })

  it('a vote for an unknown cue, or a cue under another meeting, is not stored', () => {
    svc.vote('meeting_a', id(9), 'down', null)
    svc.vote('meeting_b', id(1), 'down', null)
    expect(existsSync(verdictFile())).toBe(false)
  })

  it('a corrupt verdicts file fails closed: rate, vote and history throw, and the file stays byte for byte', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const corrupt = '{"v":1,"verdicts":{"' + id(1) + '":{"verdict":"useful","at":1}'
    writeFileSync(verdictFile(), corrupt)
    expect(() => rate(id(1), 'late')).toThrow(VerdictsUnreadableError)
    expect(() => svc.vote('meeting_a', id(1), 'up', null)).toThrow(VerdictsUnreadableError)
    expect(() => svc.history({ days: 7, unrated: false, limit: 200 })).toThrow(VerdictsUnreadableError)
    expect(readFileSync(verdictFile(), 'utf8')).toBe(corrupt)
    expect(readdirSync(dir).filter(f => f.includes('corrupt'))).toEqual([])
    expect(err).toHaveBeenCalled()
  })

  it('a FIFO at the verdicts path fails closed at once instead of blocking', () => {
    execFileSync('mkfifo', [verdictFile()])
    const r = probeInChild(`console.error = () => {}; try { new m.LiveCueVerdictStore(${JSON.stringify(verdictFile())}).read(); console.log('read') } catch (e) { console.log(e.name) }`)
    expect(r).toEqual({ status: 0, out: 'VerdictsUnreadableError' })
  })

  it('a verdicts file of the wrong shape, or one that cannot be read, fails closed the same way', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(verdictFile(), '[]')
    expect(() => rate(id(1), 'late')).toThrow(VerdictsUnreadableError)
    expect(readFileSync(verdictFile(), 'utf8')).toBe('[]')
    writeFileSync(verdictFile(), JSON.stringify({ v: 1, verdicts: {} }))
    chmodSync(verdictFile(), 0o000)
    expect(() => rate(id(1), 'late')).toThrow(VerdictsUnreadableError)
  })
})

describe('history', () => {
  beforeEach(() => {
    svc.logCue(row(id(1), { createdAt: T0 - 8 * DAY }))
    svc.logCue(row(id(3), { createdAt: T0 - 2 * DAY, sessionId: 'meeting_b' }))
    svc.logCue(row(id(2), { createdAt: T0 - 3 * DAY }))
    svc.logCue(row(id(4), { createdAt: T0 - DAY }))
    svc.logCue(row(id(4), { createdAt: T0 - DAY }))         // a duplicate line counts once
    svc.logCue(row(id(6), { createdAt: T0 - DAY + 1, sessionId: 'meeting_c' }))
    appendFileSync(logFile(), 'not json\n')
    rate(id(2), 'useful')
    rate(id(3), 'late', { sessionId: 'meeting_b', note: 'too slow' })
    svc.vote('meeting_a', id(4), 'down', null)
  })
  const q = (over: Partial<{ days: number; sessionIds: string[]; unrated: boolean; limit: number }> = {}) =>
    svc.history({ days: 7, unrated: false, limit: 200, ...over })

  it('oldest first inside the window, with the rating joined, counts by verdict and the skipped line count', () => {
    const h = q()
    expect(h.v).toBe(1)
    expect(h.cues.map(c => c.cueId)).toEqual([id(2), id(3), id(4), id(6)])
    expect(h.cues[0]).toMatchObject({ before: 'we said the cap', meetingTitle: 'G2 Recording 2026-10-19 1000', armedAt: T0 - 60_000, prompt: 'v3',
      memorySource: 'cue_memory', kept: 1, rating: { verdict: 'useful', at: T0 } })
    expect(h.cues[1].rating).toEqual({ verdict: 'late', note: 'too slow', at: T0 })
    expect(h.cues[2].rating).toEqual({ verdict: null, vote: 'down', at: T0 })    // a lens vote alone is unrated
    expect(h.cues[3].rating).toBeNull()
    expect(h.counts).toEqual({ total: 4, rated: 2, unrated: 2, byVerdict: { useful: 1, late: 1, repeat: 0, wrong: 0, obvious: 0 } })
    expect(h.truncated).toBe(false)
    expect(h.skipped).toBe(1)
  })

  it('the title is the saved one when known, else the logged capture title, resolved once per meeting and cached', () => {
    titles = { meeting_b: { title: 'Pricing review with the team', source: 'library' } }
    const h = q()
    expect(h.cues.map(c => [c.title, c.titleSource])).toEqual([
      ['G2 Recording 2026-10-19 1000', 'capture'], ['Pricing review with the team', 'library'], ['G2 Recording 2026-10-19 1000', 'capture'], ['G2 Recording 2026-10-19 1000', 'capture']])
    expect(titleCalls).toBe(3)                                          // meeting_a, meeting_b, meeting_c
    q()
    expect(titleCalls).toBe(3)
    clock += L.titleCacheMs
    q()
    expect(titleCalls).toBe(6)
  })

  it('the shadow wouldWithhold rides along on the history row', () => {
    svc.logCue(row(id(5), { createdAt: T0 - 1000, wouldWithhold: { perMeeting: true, perTopic: true, blockerCueId: id(4) } }))
    expect(q().cues.at(-1)).toMatchObject({ cueId: id(5), wouldWithhold: { perMeeting: true, perTopic: true, blockerCueId: id(4) } })
  })

  it('days widens the window', () => {
    expect(q({ days: 30 }).cues.map(c => c.cueId)).toEqual([id(1), id(2), id(3), id(4), id(6)])
    expect(q({ days: 1 }).cues.map(c => c.cueId)).toEqual([id(4), id(6)])
  })

  it('sessionIds is an exact filter over one or several meetings, and counts follow it', () => {
    const h = q({ sessionIds: ['meeting_b'] })
    expect(h.cues.map(c => c.cueId)).toEqual([id(3)])
    expect(h.counts).toMatchObject({ total: 1, rated: 1, unrated: 0 })
    expect(q({ sessionIds: ['meeting_b', 'meeting_c'] }).cues.map(c => c.cueId)).toEqual([id(3), id(6)])
    expect(q({ sessionIds: ['meeting'] }).cues).toEqual([])
  })

  it('unrated returns only cues with no verdict (a vote alone included), while counts still cover the whole window', () => {
    const h = q({ unrated: true })
    expect(h.cues.map(c => c.cueId)).toEqual([id(4), id(6)])
    expect(h.counts).toMatchObject({ total: 4, rated: 2, unrated: 2 })
  })

  it('limit keeps the NEWEST rows, still oldest first, and says it truncated; counts are not limited', () => {
    const h = q({ limit: 2 })
    expect(h.cues.map(c => c.cueId)).toEqual([id(4), id(6)])
    expect(h.truncated).toBe(true)
    expect(h.counts.total).toBe(4)
    expect(q({ limit: 4 }).truncated).toBe(false)
  })

  it('loggedCues counts a meeting over the whole log, once per cue', () => {
    expect(svc.loggedCues('meeting_a')).toBe(3)
    expect(svc.loggedCues('meeting_z')).toBe(0)
  })
})
