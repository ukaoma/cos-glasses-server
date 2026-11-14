/**
 * 7.0.39 (persistent COS thread, candidate 3): the timeline (lib/cos-thread-timeline.ts) and its place in the thread's
 * history (CosThread.timelinePage). Real files in temp dirs, fake sources, an injected clock. Placeholder words only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ARCHIVE_DAYS_PER_SWEEP, MEETING_DAYS_PER_SWEEP, notificationOutcome, readArchiveDayTurns, recordTurnAskEvent, TimelineStore, TimelineSweeper,
  type FeedItemLike, type TimelineSources,
} from './cos-thread-timeline.js'
import { CosThread, parseTimelineCursor } from './cos-thread.js'
import { readFeedFile } from './cos-thread-timeline-sources.js'

const T0 = Date.parse('2026-11-14T15:00:00.000Z')
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })
const tmp = () => { const r = mkdtempSync(join(tmpdir(), 'cos-timeline-')); roots.push(r); return r }
const iso = (ms: number) => new Date(ms).toISOString()
const item = (over: Partial<FeedItemLike> & { id: string }): FeedItemLike =>
  ({ kind: 'ping', threadId: over.id, createdAt: iso(T0), readAt: null, source: 'cos', line: `line ${over.id}`, state: 'live', ...over })

describe('TimelineStore', () => {
  it('adds a crumb once per key, keeps one line of 160, writes an outcome only when it changes, and reloads the same', () => {
    const dir = tmp()
    const s = new TimelineStore(dir, () => T0)
    const crumb = { key: 'fi:a', at: iso(T0), kind: 'notification' as const, line: 'x'.repeat(300) + '\n second line', ref: { type: 'notification' as const, id: 'a', threadId: 'a' } }
    expect(s.add([crumb, crumb])).toBe(1)
    expect(s.add([crumb])).toBe(0)
    expect(s.crumbs[0]!.line).toHaveLength(160)
    // A surface the server does not know is never stored.
    const other = new TimelineStore(tmp())
    other.add([{ key: 'msg:legacy:1', at: iso(T0), kind: 'message', line: 'q', ref: { type: 'message', no: 1, era: 'legacy' }, surface: 'phone' as any }])
    expect(other.get('msg:legacy:1')).not.toHaveProperty('surface')
    expect(s.setOutcomes([{ key: 'fi:a', outcome: 'seen' }])).toBe(1)
    expect(s.setOutcomes([{ key: 'fi:a', outcome: 'seen' }, { key: 'fi:missing', outcome: 'seen' }])).toBe(0)
    expect(s.setOutcomes([{ key: 'fi:a', outcome: 'replied', reply: { type: 'notification', id: 'b' } }])).toBe(1)
    expect(s.outcomeSeq).toBe(2)
    const again = new TimelineStore(dir)
    expect(again.crumbs.map(c => [c.key, c.outcome, c.reply?.id, c.outcomeSeq])).toEqual([['fi:a', 'replied', 'b', 2]])
    expect(again.entry(again.crumbs[0]!)).toMatchObject({ id: `b:${again.crumbs[0]!.id}`, kind: 'notification', outcome: 'replied' })
  })

  it('skips a torn or foreign row, never joins a torn tail, and refuses a symlinked file', () => {
    const dir = tmp()
    const s = new TimelineStore(dir)
    s.add([{ key: 'mt:a', at: iso(T0), kind: 'meeting', line: 'one', ref: { type: 'meeting', domain: 'd', month: '2026-11', filename: 'f.md' } }])
    appendFileSync(join(dir, 'timeline.jsonl'), '{"v":1,"row":"crumb","id":"zz","key":"bad","at":"x"}\n'
      + JSON.stringify({ v: 1, row: 'crumb', id: 'yy', key: 'badref', at: iso(T0), kind: 'meeting', line: 'x', ref: { type: 'meeting', domain: 'd' } }) + '\n{"v":1,"row":"cru')
    const again = new TimelineStore(dir)
    again.add([{ key: 'mt:b', at: iso(T0 + 1000), kind: 'meeting', line: 'two', ref: { type: 'meeting', domain: 'd', month: '2026-11', filename: 'g.md' } }])
    expect(new TimelineStore(dir).crumbs.map(c => c.key)).toEqual(['mt:a', 'mt:b'])
    // An identical outcome row written twice (a crash between write and memory) counts once on reload.
    const dup = tmp()
    const d1 = new TimelineStore(dup)
    d1.add([{ key: 'mt:z', at: iso(T0), kind: 'meeting', line: 'z', ref: { type: 'meeting', domain: 'd', month: '2026-11', filename: 'z.md' } }])
    d1.setOutcomes([{ key: 'mt:z', outcome: 'seen' }])
    const rows = readFileSync(join(dup, 'timeline.jsonl'), 'utf8').trim().split('\n')
    appendFileSync(join(dup, 'timeline.jsonl'), rows.at(-1) + '\n')
    expect(new TimelineStore(dup).outcomeSeq).toBe(1)
    const linked = tmp()
    symlinkSync(join(dir, 'timeline.jsonl'), join(linked, 'timeline.jsonl'))
    expect(() => new TimelineStore(linked)).toThrow('timeline_unsafe')
  })
})

describe('notificationOutcome: what he did, from the feed alone', () => {
  const ping = item({ id: 'p1', createdAt: iso(T0) })
  it('replied, dismissed, acted, seen, or nothing', () => {
    expect(notificationOutcome(ping, [ping])).toBeNull()
    expect(notificationOutcome({ ...ping, readAt: iso(T0 + 1) }, [ping])).toEqual({ outcome: 'seen' })
    expect(notificationOutcome({ ...ping, state: 'done', needsReply: true }, [ping])).toEqual({ outcome: 'dismissed' })
    expect(notificationOutcome({ ...ping, state: 'done', needsReply: true, links: [{ kind: 'reminder' }] }, [ping])).toEqual({ outcome: 'acted' })
    expect(notificationOutcome({ ...ping, state: 'done' }, [ping])).toEqual({ outcome: 'closed' })
    expect(notificationOutcome({ ...ping, kind: 'followup', state: 'done', needsReply: true }, [ping])).toEqual({ outcome: 'closed' })
    const his = item({ id: 'd1', threadId: 'p1', source: 'web', kind: 'drop', createdAt: iso(T0 + 5) })
    expect(notificationOutcome({ ...ping, state: 'done', needsReply: true }, [ping, his])).toEqual({ outcome: 'replied', reply: { type: 'notification', id: 'd1' } })
    const answer = item({ id: 'a1', threadId: 'p1', kind: 'answer', createdAt: iso(T0 + 5) })
    expect(notificationOutcome(ping, [ping, answer])).toEqual({ outcome: 'replied', reply: { type: 'notification', id: 'a1' } })
    const earlier = item({ id: 'd0', threadId: 'p1', source: 'web', kind: 'drop', createdAt: iso(T0 - 5) })
    expect(notificationOutcome(ping, [earlier, ping])).toBeNull()
    const cosLater = item({ id: 'f9', threadId: 'p1', kind: 'followup', createdAt: iso(T0 + 5) })   // COS again, not him
    expect(notificationOutcome(ping, [ping, cosLater])).toBeNull()
  })
})

describe('TimelineSweeper', () => {
  function world() {
    const dir = tmp()
    const store = new TimelineStore(dir, () => T0)
    const feed: FeedItemLike[] = []
    const archive = new Map<string, Array<{ no: number; era: string; query: string; at: number }> | null>()
    const reads: string[] = []
    const meetingCounts = new Map<string, number>()
    const sources: TimelineSources = {
      feed: () => feed,
      liveMessages: () => [{ no: 90, era: 'legacy', query: 'a live question', at: T0, surface: 'web' }, { no: 91, era: 'legacy', query: 'asked somewhere unknown', at: T0 + 1 }],
      archiveDays: () => [...archive.keys()].sort().reverse(),
      archiveDay: d => { reads.push(`a:${d}`); return archive.get(d) ?? null },
      meetingMonths: () => ['2026-11'],
      meetingDayCounts: () => [...meetingCounts.entries()].map(([date, count]) => ({ date, count })),
      meetingsOn: day => { reads.push(`m:${day}`); return Array.from({ length: meetingCounts.get(day) ?? 0 }, (_, i) => ({ domain: 'quilt', month: '2026-11', filename: `${day}_m${i}.md`, title: `meeting ${i}`, date: day, time: '09:30' })) },
    }
    const make = () => new TimelineSweeper(store, dir, sources, () => '2026-11-14')
    return { dir, store, feed, archive, reads, meetingCounts, make }
  }

  it('records only notifications COS sent, then what he did, once per change', () => {
    const w = world()
    w.feed.push(item({ id: 'p1' }), item({ id: 'f1', kind: 'followup' }), item({ id: 'r1', kind: 'receipt' }), item({ id: 'd1', kind: 'drop', source: 'web' }))
    expect(w.make().sweep()).toMatchObject({ notifications: 2, outcomes: 0 })
    w.feed[0] = { ...w.feed[0]!, readAt: iso(T0 + 1) }
    expect(w.make().sweep().outcomes).toBe(1)
    expect(w.make().sweep().outcomes).toBe(0)
    expect(w.store.crumbs.filter(c => c.kind === 'notification').map(c => [c.key, c.outcome])).toEqual([['fi:p1', 'seen'], ['fi:f1', undefined]])
  })

  it('messages: the live ones every pass, the archive a bounded number of days a pass, older days once, today every pass', () => {
    const w = world()
    for (let d = 1; d <= ARCHIVE_DAYS_PER_SWEEP + 2; d++) {
      const date = `2026-10-${String(d).padStart(2, '0')}`
      w.archive.set(date, [{ no: d, era: 'legacy', query: `archived ${d}`, at: Date.parse(`${date}T15:00:00Z`) }])
    }
    w.archive.set('2026-11-14', [{ no: 89, era: 'legacy', query: 'today', at: T0 - 1000 }])
    w.archive.set('2026-10-31', null)   // too big or unreadable: skipped, not retried every pass
    const first = w.make().sweep()
    expect(first.pending).toBe(true)
    expect(first.messages).toBe(2 + ARCHIVE_DAYS_PER_SWEEP - 1)   // live #90 and #91, today #89, then 8 more days (one skipped)
    const second = w.make().sweep()   // a fresh sweeper reads the saved state: no day read twice but today
    expect(second.pending).toBe(false)
    expect(w.reads.filter(r => r === 'a:2026-11-14')).toHaveLength(2)
    expect(w.reads.filter(r => r === 'a:2026-10-31')).toHaveLength(1)
    // The facts, not a sentence: the question's start, the number in the ref, and where only when known (lead 11:5x).
    const live = ['msg:legacy:90', 'msg:legacy:91'].map(k => w.store.get(k)!)
    expect(live.map(c => [c.line, c.ref, c.surface])).toEqual([
      ['a live question', { type: 'message', no: 90, era: 'legacy' }, 'web'],
      ['asked somewhere unknown', { type: 'message', no: 91, era: 'legacy' }, undefined],
    ])
    expect(w.store.entry(live[0]!)).toMatchObject({ kind: 'message', line: 'a live question', surface: 'web' })
    expect(w.store.entry(live[1]!)).not.toHaveProperty('surface')
    expect(w.store.crumbs.filter(c => c.kind === 'message')).toHaveLength(ARCHIVE_DAYS_PER_SWEEP + 2 + 3)
  })

  it('meetings: a day is read again only when its count changes, within a per-pass budget', () => {
    const w = world()
    for (let d = 1; d <= MEETING_DAYS_PER_SWEEP + 3; d++) w.meetingCounts.set(`2026-11-${String(d).padStart(2, '0')}`, 1)
    const first = w.make().sweep()
    expect(first.meetings).toBe(MEETING_DAYS_PER_SWEEP)
    expect(first.pending).toBe(true)
    expect(w.make().sweep().meetings).toBe(3)
    const meetingReads = () => w.reads.filter(r => r.startsWith('m:')).length
    const before = meetingReads()
    expect(w.make().sweep().meetings).toBe(0)
    expect(meetingReads()).toBe(before)   // no day whose count is unchanged is opened again
    w.meetingCounts.set('2026-11-02', 2)
    expect(w.make().sweep().meetings).toBe(1)
    const crumb = w.store.crumbs.find(c => c.kind === 'meeting')!
    expect(crumb.ref).toEqual({ type: 'meeting', domain: 'quilt', month: '2026-11', filename: '2026-11-01_m0.md' })
    expect(crumb.at).toBe(new Date(2026, 10, 1, 9, 30).toISOString())
  })
})

describe('session questions through the turn-end-ask callback', () => {
  it('asked, then settled with his answer; a replay or a repeat adds nothing; a settle with no ask still records it', () => {
    const s = new TimelineStore(tmp(), () => T0)
    const asked = { type: 'asked' as const, askKey: 'sess1:p1', sessionId: 'sess1', at: T0, question: 'Build it?' }
    recordTurnAskEvent(s, asked)
    recordTurnAskEvent(s, asked)
    recordTurnAskEvent(s, { ...asked, type: 'settled', at: T0 + 60_000, outcome: 'answered', by: 'glasses', answer: 'Yes, build it' })
    recordTurnAskEvent(s, { ...asked, type: 'settled', at: T0 + 60_000, outcome: 'answered', by: 'glasses', answer: 'Yes, build it' })
    recordTurnAskEvent(s, { type: 'settled', askKey: 'sess2:p9', sessionId: 'sess2', at: T0, question: null, outcome: 'aged_out' })
    recordTurnAskEvent(s, { type: 'settled', askKey: 'sess3:p1', sessionId: 'sess3', at: T0, question: null, outcome: 'not-an-outcome' })
    expect(s.crumbs.map(c => [c.key, c.line, c.outcome, c.answer, c.by])).toEqual([
      ['ask:sess1:p1', 'Build it?', 'answered', 'Yes, build it', 'glasses'],
      ['ask:sess2:p9', 'A session asked you a question', 'aged_out', undefined, undefined],
      ['ask:sess3:p1', 'A session asked you a question', undefined, undefined, undefined],
    ])
    expect(s.crumbs[0]!.ref).toEqual({ type: 'session', provider: 'claude', id: 'sess1' })
    expect(s.outcomeSeq).toBe(2)
  })
})

describe('readers', () => {
  it('an after= page cut inside the chat ends keeps its ends cursor at the last end it sent, so none is skipped (Q1 T6)', () => {
    const dir = tmp()
    const t = new CosThread({ dir, now: () => T0, context: () => ({ found: true, tokens: 1 }) })
    const job = (n: number) => ({ clientJobId: `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`, generation: 1, sessionId: 'thread01', query: `question ${n}` })
    for (let n = 1; n <= 3; n++) t.recordJobStarted(job(n))
    for (let n = 1; n <= 3; n++) t.recordJobEnd({ ...job(n), status: 'completed', text: `answer ${n}` })
    const seen: string[] = []
    let after = { chats: 3, ends: 0, crumbs: 0, outcomes: 0 }
    for (let i = 0; i < 5; i++) {
      const page = t.timelinePage({ after, limit: 40, maxBytes: 10 })
      seen.push(...page.updated.map(e => (e as { question: string }).question))
      const c = parseTimelineCursor(page.newest)
      after = (c as { after: typeof after }).after
      if (!page.more) break
    }
    expect(seen).toEqual(['question 1', 'question 2', 'question 3'])
    expect(after).toEqual({ chats: 3, ends: 3, crumbs: 0, outcomes: 0 })
  })

  it('readArchiveDayTurns: numbered user turns only; null for missing, too big or a link; bad JSON throws (Q1: retried)', () => {
    const dir = tmp()
    const day = { chats: [{ exchanges: [
      { role: 'user', content: 'numbered', globalMsgNum: 5, messageEra: 'e2', timestamp: T0 },
      { role: 'assistant', content: 'answer', globalMsgNum: 5, timestamp: T0 + 1 },
      { role: 'user', content: 'unnumbered', timestamp: T0 + 2 },
    ] }] }
    writeFileSync(join(dir, '2026-11-13.json'), JSON.stringify(day))
    expect(readArchiveDayTurns(dir, '2026-11-13')).toEqual([{ no: 5, era: 'e2', query: 'numbered', at: T0 }])
    expect(readArchiveDayTurns(dir, '2026-11-13', 10)).toBeNull()
    expect(readArchiveDayTurns(dir, '2026-11-12')).toBeNull()
    writeFileSync(join(dir, '2026-11-11.json'), '{not json')
    expect(() => readArchiveDayTurns(dir, '2026-11-11')).toThrow()
    symlinkSync(join(dir, '2026-11-13.json'), join(dir, '2026-11-10.json'))
    expect(readArchiveDayTurns(dir, '2026-11-10')).toBeNull()
  })

  it('an archive day whose read fails is retried on later passes and given up after three; a known skip is done at once (Q1)', () => {
    const dir = tmp()
    const reads: Record<string, number> = {}
    let healed = false
    const sources: TimelineSources = {
      archiveDays: () => ['2026-11-12', '2026-11-11', '2026-11-10'],
      archiveDay: d => {
        reads[d] = (reads[d] ?? 0) + 1
        if (d === '2026-11-12') { if (!healed) throw new Error('torn'); return [{ no: 7, era: 'e1', query: 'healed', at: T0 }] }
        if (d === '2026-11-11') throw new Error('always bad')
        return null   // too big: a known skip
      },
    }
    const store = new TimelineStore(dir)
    const sweeper = () => new TimelineSweeper(store, dir, sources, () => '2026-11-14')
    sweeper().sweep()
    expect(reads).toEqual({ '2026-11-12': 1, '2026-11-11': 1, '2026-11-10': 1 })
    healed = true
    sweeper().sweep()   // a new sweeper reads the saved state: the retries survive a restart
    expect(store.crumbs.map(c => c.line)).toEqual(['healed'])
    expect(reads).toEqual({ '2026-11-12': 2, '2026-11-11': 2, '2026-11-10': 1 })
    sweeper().sweep()
    sweeper().sweep()
    expect(reads).toEqual({ '2026-11-12': 2, '2026-11-11': 3, '2026-11-10': 1 })
    expect(JSON.parse(readFileSync(join(dir, 'timeline-state.json'), 'utf8'))).not.toHaveProperty('archiveRetries')
  })

  it('today\'s archive day is never given up, however often its read fails: it is read again every pass (Q1 T29)', () => {
    const dir = tmp()
    let reads = 0
    const sources: TimelineSources = { archiveDays: () => ['2026-11-14'], archiveDay: () => { reads++; throw new Error('still being written') } }
    const store = new TimelineStore(dir)
    for (let pass = 1; pass <= 5; pass++) new TimelineSweeper(store, dir, sources, () => '2026-11-14').sweep()
    expect(reads).toBe(5)
    expect(JSON.parse(readFileSync(join(dir, 'timeline-state.json'), 'utf8')).archiveDays).toEqual([])
  })

  it('readFeedFile: the store own rows, a bad row skipped; missing, a wrong version or bad JSON read as empty', () => {
    const dir = tmp()
    const file = join(dir, 'feed.json')
    expect(readFeedFile(file)).toEqual([])
    const good = { id: `fi_${'a'.repeat(32)}`, kind: 'ping', threadId: 'thread-1', createdAt: iso(T0), readAt: null, source: 'cos', line: 'hello', links: [], actions: [], state: 'live', key: 'k1' }
    writeFileSync(file, JSON.stringify({ version: 1, items: [good, { id: 'bad' }] }))
    expect(readFeedFile(file).map(i => i.id)).toEqual([good.id])
    writeFileSync(file, JSON.stringify({ version: 2, items: [good] }))
    expect(readFeedFile(file)).toEqual([])
    writeFileSync(file, '{oops')
    expect(readFeedFile(file)).toEqual([])
  })
})

describe('the history with breadcrumbs (CosThread.timelinePage)', () => {
  function thread() {
    const dir = join(tmp(), 'cos-thread')
    let now = T0
    const t = new CosThread({ dir, now: () => now, context: () => ({ found: true, tokens: 1 }) })
    const chat = (n: number, at: number) => { now = at; t.recordTurn({ clientId: `client-${String(n).padStart(4, '0')}`, sessionId: 'sess-0001', query: `chat ${n}`, answer: `answer ${n}` }) }
    const crumb = (key: string, at: number) => t.timeline().add([{ key, at: iso(at), kind: 'meeting', line: key, ref: { type: 'meeting', domain: 'd', month: '2026-11', filename: `${key}.md` } }])
    return { t, chat, crumb, dir, setNow: (v: number) => { now = v } }
  }

  it('orders chats and crumbs by time, a backfilled crumb at its own time, and pages back through all of them once', () => {
    const h = thread()
    h.chat(1, T0); h.chat(2, T0 + 3000); h.chat(3, T0 + 6000)
    h.crumb('late', T0 + 9000)
    h.crumb('backfilled', T0 + 1000)   // appended last, but older than chat 2
    const page = h.t.timelinePage({ limit: 3 })
    expect(page.entries.map(e => 'question' in e ? e.question : e.line)).toEqual(['chat 2', 'chat 3', 'late'])
    expect(page.newest).toBe('c3.3.0.2.0')
    let all = [...page.entries]
    let cursor = page.older
    let pages = 0   // bounded, so a paging bug fails here instead of spinning
    while (cursor && pages++ < 20) {
      const back = h.t.timelinePage({ limit: 2, before: (parseTimelineCursor(cursor) as { before: { atMs: number; tie: string } }).before })
      all = [...back.entries, ...all]
      cursor = back.older
    }
    expect(all.map(e => 'question' in e ? e.question : e.line)).toEqual(['chat 1', 'backfilled', 'chat 2', 'chat 3', 'late'])
  })

  it('kinds filter; after= returns new chats and crumbs and, in updated, changed outcomes; a cut page counts only what it carried', () => {
    const h = thread()
    h.chat(1, T0)
    h.crumb('m1', T0 + 1000)
    const start = h.t.timelinePage({ limit: 40 })
    expect(h.t.timelinePage({ limit: 40, kinds: ['meeting'] }).entries.map(e => e.kind)).toEqual(['meeting'])
    const a = (parseTimelineCursor(start.newest) as { after: { chats: number; ends: number; crumbs: number; outcomes: number } }).after
    h.chat(2, T0 + 2000)
    h.crumb('m2', T0 + 500)
    h.t.timeline().setOutcomes([{ key: 'm1', outcome: 'seen' }])
    const next = h.t.timelinePage({ limit: 40, after: a })
    expect(next.entries.map(e => 'question' in e ? e.question : e.line)).toEqual(['m2', 'chat 2'])
    expect(next.updated.map(e => 'line' in e ? [e.line, e.outcome] : null)).toEqual([['m1', 'seen']])
    expect([next.newest, next.more]).toEqual(['c3.2.0.2.1', false])
    const cut = h.t.timelinePage({ limit: 40, after: a, maxBytes: 10 })
    expect(cut.entries).toHaveLength(1)
    expect([cut.newest, cut.more]).toEqual(['c3.2.0.1.0', true])
    const rest = h.t.timelinePage({ limit: 40, after: (parseTimelineCursor(cut.newest) as any).after, maxBytes: 10 })
    expect(rest.entries.map(e => 'line' in e ? e.line : null)).toEqual(['m2'])
    const last = h.t.timelinePage({ limit: 40, after: (parseTimelineCursor(rest.newest) as any).after })
    expect([last.entries, last.updated.map(e => 'line' in e ? e.line : null), last.newest, last.more]).toEqual([[], ['m1'], 'c3.2.0.2.1', false])
  })

  it('the chats-only history (no timeline) never shows a crumb and keeps its c1 cursors', () => {
    const h = thread()
    h.chat(1, T0); h.crumb('m1', T0 + 1)
    const page = h.t.historyPage({ limit: 40 })
    expect(page.entries.map(e => e.kind)).toEqual(['chat'])
    expect(page.newest).toBe('c1.1.0')
  })
})
