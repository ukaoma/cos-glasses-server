/**
 * 7.0.39 (persistent COS thread, candidate 4): COS's look-back (CosThread.lookback) and the one line that names it
 * (lookbackPointer). Where the line goes (after the quoted digest, on a thread conversation's first chat) is proved through
 * the real job runtime in cos-thread-only.test.ts. Real files in temp dirs, an injected clock. Placeholder words only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildDigest, CosThread, LOOKBACK_MAX_BYTES, LOOKBACK_MAX_LIMIT, LOOKBACK_TEXT_CHARS, lookbackPointer,
  parseTimelineCursor, type LookbackChatEntry,
} from './cos-thread.js'
import type { CrumbEntry } from './cos-thread-timeline.js'
import { COS_THREAD_LOOKBACK_CAPABILITY, dropItCapability } from './drop-settings.js'
import { COS_THREAD_LOOKBACK_PROTOCOL } from './cos-thread.js'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-14T15:00:00.000Z')
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-lookback-')); roots.push(root)
  const dir = join(root, 'cos-thread')
  let now = T0
  let ids = 0
  const make = () => new CosThread({
    dir, now: () => now, capTokens: () => 150_000, newId: () => `th_${String(++ids).padStart(4, '0')}`,
    context: () => ({ found: true, tokens: 1000 }),
  })
  return { dir, make, at: (ms: number) => { now = ms }, tick: (ms: number) => { now += ms } }
}
const cid = (n: number) => `client-${String(n).padStart(4, '0')}`
const ask = (t: CosThread, n: number, extra: Record<string, unknown> = {}) =>
  t.recordTurn({ clientId: cid(n), sessionId: 'sess-0001', query: `question ${n}`, answer: `answer ${n}`, ...extra } as any)
const meeting = (key: string, atMs: number) =>
  ({ key, at: new Date(atMs).toISOString(), kind: 'meeting' as const, line: `meeting ${key}`, ref: { type: 'meeting' as const, domain: 'quilt', month: '2026-11', filename: `${key}.md` } })
const labels = (es: Array<LookbackChatEntry | CrumbEntry>) => es.map(e => e.kind === 'chat' ? (e as LookbackChatEntry).question : e.line)

describe('the look-back line', () => {
  it('names the route on this server\'s port and the token variable, never the token', () => {
    expect(lookbackPointer({ PORT: '3199', COS_API_TOKEN: 'not-a-real-token' })).toContain('http://127.0.0.1:3199/api/cos-thread/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD')
    expect(lookbackPointer({ PORT: '3199', COS_API_TOKEN: 'not-a-real-token' })).not.toContain('not-a-real-token')
    expect(lookbackPointer({ COS_API_TOKEN: 'x' })).toContain('X-Cos-Token: $COS_API_TOKEN')
    // Same port rule as index.ts: unset or not a port number reads as 3141.
    expect(lookbackPointer({})).toContain('127.0.0.1:3141/')
    expect(lookbackPointer({ PORT: '31a1' })).toContain('127.0.0.1:3141/')
    expect(lookbackPointer({ PORT: '' })).toContain('127.0.0.1:3141/')
    // One line, short: about 50 tokens.
    expect(lookbackPointer({})).not.toContain('\n')
    expect(lookbackPointer({}).length).toBeLessThan(240)
    // A fuzzy time asks for a span, not one day (the 8-days-old proof: "a week ago" read as one day found nothing).
    expect(lookbackPointer({})).toContain('a few days either side')
  })

  it('the digest itself is candidate 3\'s: no look-back line in it, fresh or continued', () => {
    const h = harness(); const t = h.make()
    ask(t, 1)
    expect(t.view().next).toMatchObject({ mode: 'continue', digest: null })
    const fresh = t.view({ isThreadSession: () => false }).next.digest!
    expect(fresh).toBe(buildDigest([{ query: 'question 1', answerHead: 'answer 1', messageNo: null }], []))
    expect(fresh).not.toContain('cos-thread/timeline')
  })

  it('is advertised as dropIt.thread.lookback while Drop it is on', () => {
    expect(COS_THREAD_LOOKBACK_CAPABILITY).toBe(COS_THREAD_LOOKBACK_PROTOCOL)
    expect(dropItCapability({ COS_DROP_IT: '1' }).thread).toMatchObject({ lookback: 1 })
    expect(dropItCapability({})).not.toHaveProperty('thread')
  })
})

describe('CosThread.lookback', () => {
  /** Chats 9, 8 (twice), 1 day before T0; a meeting 8 days before; a chat in a closed thread 8 days before. */
  function seeded() {
    const h = harness(); const t = h.make()
    h.at(T0 - 9 * DAY); ask(t, 1)
    h.at(T0 - 8 * DAY); ask(t, 2)
    h.at(T0 - 8 * DAY + 60_000); ask(t, 3)
    t.startNew()
    h.at(T0 - 8 * DAY + 120_000); ask(t, 4, { sessionId: 'sess-0002' })
    h.at(T0 - DAY); ask(t, 5, { sessionId: 'sess-0002' })
    h.at(T0)
    t.timeline().add([meeting('m8', T0 - 8 * DAY + 30_000), meeting('m1', T0 - DAY + 1)])
    return { h, t }
  }

  it('reads one window of every thread\'s chats and breadcrumbs, oldest first, from inclusive and to exclusive', () => {
    const { t } = seeded()
    const page = t.lookback({ fromMs: T0 - 8 * DAY, toMs: T0 - 8 * DAY + 120_000, limit: 50 })
    expect(labels(page.entries)).toEqual(['question 2', 'meeting m8', 'question 3'])
    expect(page.older).toBeNull()
    const chats = page.entries.filter(e => e.kind === 'chat') as LookbackChatEntry[]
    expect(chats.map(c => c.threadId)).toEqual(['th_0001', 'th_0001'])
    expect(chats[0]).toEqual({
      id: `t:${cid(2)}`, at: new Date(T0 - 8 * DAY).toISOString(), kind: 'chat', threadId: 'th_0001', question: 'question 2',
      answer: 'answer 2', answerChars: 8, full: true, status: 'completed', messageNo: null,
    })
    // Across New thread: the chat in the next thread carries its own threadId.
    const wider = t.lookback({ fromMs: T0 - 8 * DAY, toMs: T0 - 7 * DAY, limit: 50 })
    expect(labels(wider.entries)).toEqual(['question 2', 'meeting m8', 'question 3', 'question 4'])
    expect((wider.entries[3] as LookbackChatEntry).threadId).toBe('th_0002')
    expect(t.lookback({ fromMs: T0 - DAY, toMs: T0 - DAY + 1, limit: 50 }).entries.map(e => e.kind)).toEqual(['chat'])
    expect(t.lookback({ fromMs: T0 - DAY + 1, toMs: T0, limit: 50 }).entries.map(e => e.kind)).toEqual(['meeting'])
    expect(t.lookback({ fromMs: T0, toMs: T0 + DAY, limit: 50 }).entries).toEqual([])
  })

  it('the newest `limit` first, then `older` walks back through the window and stops at its start', () => {
    const { t } = seeded()
    const all = { fromMs: T0 - 10 * DAY, toMs: T0 }
    const first = t.lookback({ ...all, limit: 2 })
    expect(labels(first.entries)).toEqual(['question 5', 'meeting m1'])
    const before = parseTimelineCursor(first.older)
    expect(before && 'before' in before).toBe(true)
    const second = t.lookback({ ...all, limit: 2, ...(before as { before: { atMs: number; tie: string } }) })
    expect(labels(second.entries)).toEqual(['question 3', 'question 4'])
    const third = t.lookback({ ...all, limit: 3, ...(parseTimelineCursor(second.older) as any) })
    expect(labels(third.entries)).toEqual(['question 1', 'question 2', 'meeting m8'])
    expect(third.older).toBeNull()
    // A cursor that sits after the window reads the window's newest page; one before it reads nothing.
    expect(labels(t.lookback({ ...all, limit: 1, before: { atMs: T0 + DAY, tie: 't0' } }).entries)).toEqual(['meeting m1'])
    expect(t.lookback({ ...all, limit: 1, before: { atMs: T0 - 20 * DAY, tie: 't0' } })).toEqual({ protocol: 1, entries: [], older: null })
    // The limit is held to 1..200.
    expect(t.lookback({ ...all, limit: 0 }).entries).toHaveLength(1)
    expect(t.lookback({ ...all, limit: 10_000 }).entries).toHaveLength(7)
    expect(LOOKBACK_MAX_LIMIT).toBe(200)
  })

  it('limit is capped at 200 on a long window', () => {
    const h = harness(); const t = h.make()
    t.timeline().add(Array.from({ length: 201 }, (_, i) => meeting(`k${String(i + 1).padStart(3, '0')}`, T0 - DAY + (i + 1) * 1000)))
    const page = t.lookback({ fromMs: T0 - 2 * DAY, toMs: T0, limit: 10_000, maxBytes: 10 * 1024 * 1024 })
    expect(page.entries).toHaveLength(200)
    expect((page.entries[0] as CrumbEntry).line).toBe('meeting k002')
    expect(page.older).not.toBeNull()
  })

  it('stops at the byte cap with at least one entry, and walking back still visits each entry once', () => {
    const h = harness()
    const long = 'w'.repeat(LOOKBACK_TEXT_CHARS)
    h.at(T0 - DAY + 1000); ask(h.make(), 1, { query: `1 ${long}`, answer: long })
    // 89 more as ONE append of rows cloned from the real one, then the store reopened from the ledger (no 89 durable writes).
    const ledger = join(h.dir, 'ledger.jsonl')
    const real = readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.kind === 'turn')
    appendFileSync(ledger, Array.from({ length: 89 }, (_, i) => JSON.stringify({ ...real, clientId: cid(i + 2), at: new Date(T0 - DAY + (i + 2) * 1000).toISOString(), query: `${i + 2} ${long}` }) + '\n').join(''))
    rmSync(join(h.dir, 'state.json'), { force: true })
    const t = h.make()
    expect(t.historySize()).toBe(90)
    const win = { fromMs: T0 - 2 * DAY, toMs: T0 }
    const page = t.lookback({ ...win, limit: 200 })
    const bytes = Buffer.byteLength(JSON.stringify(page.entries))
    expect(page.entries.length).toBeLessThan(90)
    expect(bytes).toBeLessThanOrEqual(LOOKBACK_MAX_BYTES)
    expect(t.lookback({ ...win, limit: 200, maxBytes: 10 }).entries).toHaveLength(1)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0   // bounded, so a paging bug fails here instead of spinning
    do {
      const p = t.lookback({ ...win, limit: 200, ...(cursor ? parseTimelineCursor(cursor) as any : {}) })
      seen.unshift(...p.entries.map(e => e.id))
      cursor = p.older
    } while (cursor && ++pages < 20)
    expect(seen).toHaveLength(90)
    expect(new Set(seen).size).toBe(90)
  })

  it('cuts a chat\'s question and answer to 300 characters, keeps the answer\'s length, and filters by kind', () => {
    const h = harness(); const t = h.make()
    h.at(T0 - DAY)
    ask(t, 1, { query: 'q'.repeat(500), answer: 'a'.repeat(400) })
    ask(t, 2, { query: 'q'.repeat(LOOKBACK_TEXT_CHARS), answer: 'a'.repeat(LOOKBACK_TEXT_CHARS) })
    t.timeline().add([meeting('m', T0 - DAY + 5)])
    const [one, two, m] = t.lookback({ fromMs: T0 - 2 * DAY, toMs: T0, limit: 50 }).entries as [LookbackChatEntry, LookbackChatEntry, CrumbEntry]
    expect(one.question).toBe('q'.repeat(LOOKBACK_TEXT_CHARS - 1) + '…')
    expect(one.answer).toBe('a'.repeat(LOOKBACK_TEXT_CHARS - 1) + '…')
    expect([one.answerChars, one.full]).toEqual([400, false])
    expect([two.question.length, two.answer.length, two.answerChars, two.full]).toEqual([LOOKBACK_TEXT_CHARS, LOOKBACK_TEXT_CHARS, LOOKBACK_TEXT_CHARS, true])
    expect(m).toMatchObject({ kind: 'meeting', line: 'meeting m', ref: { type: 'meeting', filename: 'm.md' } })
    expect(t.lookback({ fromMs: T0 - 2 * DAY, toMs: T0, limit: 50, kinds: ['meeting'] }).entries.map(e => e.kind)).toEqual(['meeting'])
    expect(t.lookback({ fromMs: T0 - 2 * DAY, toMs: T0, limit: 50, kinds: ['chat'] }).entries.map(e => e.kind)).toEqual(['chat', 'chat'])
  })

  it('a running job chat reads running, then interrupted once stale; the page never reads an answer file', () => {
    const h = harness(); const t = h.make()
    h.at(T0 - DAY)
    t.recordJobStarted({ clientJobId: 'cccccccc-0000-4000-8000-000000000001', generation: 1, sessionId: 'thread01', query: 'a running one' })
    h.at(T0 - DAY + 1000)
    expect(t.lookback({ fromMs: T0 - 2 * DAY, toMs: T0, limit: 5 }).entries[0]).toMatchObject({ status: 'running', answer: '', answerChars: null, full: false })
    h.at(T0)
    expect(t.lookback({ fromMs: T0 - 2 * DAY, toMs: T0, limit: 5 }).entries[0]).toMatchObject({ status: 'interrupted' })
  })
})
