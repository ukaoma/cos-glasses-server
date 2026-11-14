/**
 * 7.0.39 (persistent thread, candidate 1): the history index of the COS thread store (lib/cos-thread.ts). Real ledger
 * files in a temp dir and an injected clock. Placeholder words only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ANSWER_HEAD_CHARS, archivedAnswer, CosThread, cursorOf, HISTORY_MAX_BYTES, HISTORY_MAX_LIMIT, parseCursor,
  type CosThreadChatEntry,
} from './cos-thread.js'
import { localDay } from './local-day.js'
import { COS_THREAD_HISTORY_CAPABILITY } from './drop-settings.js'
import { COS_THREAD_HISTORY_PROTOCOL } from './cos-thread.js'

const T0 = Date.parse('2026-11-05T15:00:00.000Z')
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })

function harness(answers: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-hist-')); roots.push(root)
  const dir = join(root, 'cos-thread')
  let now = T0
  let ids = 0
  const make = () => new CosThread({
    dir, now: () => now, capTokens: () => 150_000, newId: () => `th_${String(++ids).padStart(4, '0')}`,
    context: () => ({ found: true, tokens: 1000 }),
    answerFor: (sessionId, clientId) => answers[`${sessionId}:${clientId}`],
  })
  return { root, dir, make, tick: (ms = 60_000) => { now += ms } }
}
const cid = (n: number) => `client-${String(n).padStart(4, '0')}`
const ask = (t: CosThread, n: number, extra: Record<string, unknown> = {}) =>
  t.recordTurn({ clientId: cid(n), sessionId: 'sess-0001', query: `question ${n}`, answer: `answer ${n}`, messageNo: 100 + n, ...extra } as any)
const ids = (entries: CosThreadChatEntry[]) => entries.map(e => e.id)

/** Walk the whole history from the newest page back with `older`, the way the page scrolls up. */
function walkBack(t: CosThread, limit: number): string[] {
  let page = t.historyPage({ limit })
  const out = [...ids(page.entries)]
  let guard = 0
  while (page.older && guard++ < 10_000) {
    page = t.historyPage({ before: parseCursor(page.older)!, limit })
    out.unshift(...ids(page.entries))
  }
  return out
}

describe('history pages', () => {
  it('an empty thread: no entries, no older page, the cursor at the start', () => {
    const t = harness().make()
    expect(t.historyPage({ limit: 40 })).toEqual({ protocol: 1, entries: [], older: null, newest: 'c1.0', more: false, updated: [] })
  })

  it('the newest page, oldest to newest, then older pages back to the first chat, across New thread, with no gap or repeat', () => {
    const h = harness(); const t = h.make()
    for (let n = 1; n <= 3; n++) { ask(t, n); h.tick() }
    const first = t.view().thread.id
    t.startNew(); h.tick()
    for (let n = 4; n <= 7; n++) { ask(t, n); h.tick() }
    const page = t.historyPage({ limit: 3 })
    expect(ids(page.entries)).toEqual(['t:' + cid(5), 't:' + cid(6), 't:' + cid(7)])
    expect(page.older).toBe('c1.4')
    expect(page.newest).toBe('c1.7')
    expect(page.more).toBe(false)
    const back = t.historyPage({ before: 4, limit: 3 })
    expect(ids(back.entries)).toEqual(['t:' + cid(2), 't:' + cid(3), 't:' + cid(4)])
    expect(back.entries.map(e => e.threadId)).toEqual([first, first, t.view().thread.id])
    expect(walkBack(t, 2)).toEqual([1, 2, 3, 4, 5, 6, 7].map(n => 't:' + cid(n)))
    // The entry shape the page draws.
    expect(page.entries[0]).toEqual({ id: 't:' + cid(5), at: new Date(T0 + 5 * 60_000).toISOString(), kind: 'chat', question: 'question 5',
      answer: 'answer 5', answerChars: 8, full: true, threadId: t.view().thread.id, status: 'completed', messageNo: 105 })
  })

  it('after= returns what was added since, flags more past the limit, and an empty answer keeps the cursor', () => {
    const h = harness(); const t = h.make()
    ask(t, 1)
    const newest = t.historyPage({ limit: 40 }).newest
    expect(t.historyPage({ after: parseCursor(newest)!, limit: 40 })).toEqual({ protocol: 1, entries: [], older: 'c1.1', newest: 'c1.1', more: false, updated: [] })
    for (let n = 2; n <= 5; n++) ask(t, n)
    const next = t.historyPage({ after: parseCursor(newest)!, limit: 3 })
    expect(ids(next.entries)).toEqual([2, 3, 4].map(n => 't:' + cid(n)))
    expect(next.more).toBe(true)
    const rest = t.historyPage({ after: parseCursor(next.newest)!, limit: 3 })
    expect(ids(rest.entries)).toEqual(['t:' + cid(5)])
    expect(rest.more).toBe(false)
  })

  it('a cursor past the end reads as the end; the limit is held to 1..100', () => {
    const h = harness(); const t = h.make()
    for (let n = 1; n <= 3; n++) ask(t, n)
    expect(ids(t.historyPage({ before: 999, limit: 40 }).entries)).toHaveLength(3)
    expect(t.historyPage({ after: 999, limit: 40 }).entries).toEqual([])
    expect(t.historyPage({ limit: 0 }).entries).toHaveLength(1)
    for (let n = 4; n <= 105; n++) ask(t, n)
    expect(t.historyPage({ limit: 1000 }).entries).toHaveLength(HISTORY_MAX_LIMIT)
  })

  it('the same pages and cursors after a restart: the index is rebuilt from the ledger bytes, multibyte words included', () => {
    const h = harness(); const t = h.make()
    for (let n = 1; n <= 6; n++) ask(t, n, { query: `qüestion ${n} 😀 ${'é'.repeat(n * 7)}` })
    const before = [t.historyPage({ limit: 4 }), t.historyPage({ before: 2, limit: 4 }), t.historyPage({ after: 3, limit: 4 })]
    const again = h.make()
    expect([again.historyPage({ limit: 4 }), again.historyPage({ before: 2, limit: 4 }), again.historyPage({ after: 3, limit: 4 })]).toEqual(before)
    // And a chat added after the restart lands at the right place.
    ask(again, 7, { query: 'after the restart 😀' })
    expect(again.historyPage({ after: 6, limit: 4 }).entries.map(e => e.question)).toEqual(['after the restart 😀'])
    expect(h.make().historyPage({ after: 6, limit: 4 }).entries.map(e => e.question)).toEqual(['after the restart 😀'])
  })

  it('a page stops at 256 KB (at least one entry), and walking back still visits every chat once', () => {
    const h = harness(); const t = h.make()
    for (let n = 1; n <= 30; n++) ask(t, n, { query: `${n} ` + '😀'.repeat(4_000) + 'x'.repeat(10_000) })
    const page = t.historyPage({ limit: 100 })
    const bytes = page.entries.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)), 0)
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.entries.length).toBeLessThan(30)
    expect(bytes).toBeLessThanOrEqual(HISTORY_MAX_BYTES)
    expect(page.older).toBe(cursorOf(30 - page.entries.length))
    expect(walkBack(t, 100)).toEqual(Array.from({ length: 30 }, (_, i) => 't:' + cid(i + 1)))
    const ahead = t.historyPage({ after: 0, limit: 100 })
    expect(ahead.more).toBe(true)
    expect(ahead.entries.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)), 0)).toBeLessThanOrEqual(HISTORY_MAX_BYTES)
  })

  it('full and answerChars: a short answer is whole; one at the 2,000 cap or recorded empty is not', () => {
    const h = harness(); const t = h.make()
    ask(t, 1, { answer: 'short' })
    ask(t, 2, { answer: 'y'.repeat(ANSWER_HEAD_CHARS + 500) })
    ask(t, 3, { answer: undefined })
    const [a, b, c] = t.historyPage({ limit: 40 }).entries
    expect([a!.full, a!.answerChars]).toEqual([true, 5])
    expect([b!.full, b!.answerChars, b!.answer.length]).toEqual([false, null, ANSWER_HEAD_CHARS])
    expect([c!.full, c!.answerChars, c!.answer]).toEqual([false, null, ''])
  })

  it('a repeated clientId is one entry, also when the ledger itself holds the row twice', () => {
    const h = harness(); const t = h.make()
    ask(t, 1); ask(t, 1); ask(t, 2)
    expect(t.historySize()).toBe(2)
    const file = join(h.dir, 'ledger.jsonl')
    const turnRow = readFileSync(file, 'utf8').split('\n').find(l => l.includes(cid(1)))!
    appendFileSync(file, turnRow + '\n')
    const again = h.make()
    expect(again.historySize()).toBe(2)
    expect(ids(again.historyPage({ limit: 40 }).entries)).toEqual([1, 2].map(n => 't:' + cid(n)))
  })

  it('one entry bigger than the byte cap still comes back alone, both ways, so a page is never empty while chats are due', () => {
    const t = harness().make()
    for (let n = 1; n <= 3; n++) ask(t, n)
    expect(ids(t.historyPage({ limit: 40, maxBytes: 10 }).entries)).toEqual(['t:' + cid(3)])
    const ahead = t.historyPage({ after: 0, limit: 40, maxBytes: 10 })
    expect(ids(ahead.entries)).toEqual(['t:' + cid(1)])
    expect(ahead.more).toBe(true)
  })

  it('a turn written in one append with its rollover row (a new session) reads back at once, without a restart', () => {
    const t = harness().make()
    ask(t, 1)
    ask(t, 2, { sessionId: 'sess-0002' })   // a different session: the ledger gets a rollover row and the turn together
    ask(t, 3, { sessionId: 'sess-0003' })
    expect(t.historyPage({ limit: 40 }).entries.map(e => e.question)).toEqual(['question 1', 'question 2', 'question 3'])
    expect(t.entry(cid(3))!.lookup.sessionId).toBe('sess-0003')
  })

  it('a torn last row is skipped and the next chat after reopening is read back correctly', () => {
    const h = harness(); const t = h.make()
    ask(t, 1); ask(t, 2)
    appendFileSync(join(h.dir, 'ledger.jsonl'), '{"kind":"turn","threadId":"th_0001","seg')
    const again = h.make()
    expect(again.historySize()).toBe(2)
    ask(again, 3)
    expect(ids(again.historyPage({ limit: 40 }).entries)).toEqual([1, 2, 3].map(n => 't:' + cid(n)))
    expect(ids(h.make().historyPage({ limit: 40 }).entries)).toEqual([1, 2, 3].map(n => 't:' + cid(n)))
  })

  it('a ledger changed under the index is a 503, never another chat', () => {
    const h = harness(); const t = h.make()
    ask(t, 1); ask(t, 2)
    const file = join(h.dir, 'ledger.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8').replace(cid(1), cid(9)))
    expect(() => t.historyPage({ limit: 40 })).toThrow(expect.objectContaining({ code: 'cos_thread_history_stale', status: 503 }))
    expect(() => t.entry(cid(1))).toThrow(expect.objectContaining({ code: 'cos_thread_history_stale' }))
  })

  it('entry: the chat and what a lookup needs; null when unknown; the live answer through answerFor', () => {
    const t = harness({ [`sess-0001:${cid(2)}`]: 'the whole live answer' }).make()
    ask(t, 1); ask(t, 2, { answer: undefined })
    expect(t.entry('client-9999')).toBeNull()
    const found = t.entry(cid(2))!
    expect(found.entry.id).toBe('t:' + cid(2))
    expect(found.lookup).toEqual({ sessionId: 'sess-0001', clientId: cid(2), messageNo: 102, at: new Date(T0).toISOString(), query: 'question 2' })
    expect(t.liveAnswer(found.lookup)).toBe('the whole live answer')
  })

  it('the history capability number matches the store', () => {
    expect(COS_THREAD_HISTORY_CAPABILITY).toBe(COS_THREAD_HISTORY_PROTOCOL)
  })
})

describe('archivedAnswer: the day archive, read only and bounded', () => {
  const lookup = { sessionId: 'sess-0001', clientId: cid(1), messageNo: 101 as number | null, at: new Date(T0).toISOString(), query: 'question 1' }
  const day = (ms: number) => localDay(ms)
  function archive(files: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), 'cos-thread-arch-')); roots.push(root)
    const dir = join(root, 'archive'); mkdirSync(dir)
    for (const [date, body] of Object.entries(files)) writeFileSync(join(dir, `${date}.json`), typeof body === 'string' ? body : JSON.stringify(body))
    return dir
  }
  const chatDay = (sessionId: string, pairs: Array<[string, string, number | undefined]>) => ({ chats: [{ id: 0, sessionId, exchanges: pairs.flatMap(([q, a, no]) => [
    { role: 'user', content: q, timestamp: T0, ...(no ? { globalMsgNum: no } : {}) }, { role: 'assistant', content: a, timestamp: T0, ...(no ? { globalMsgNum: no } : {}) }]) }] })

  it('finds the answer by session and number on a later day the session was archived on', () => {
    const dir = archive({ [day(T0 + 2 * 86_400_000)]: chatDay('sess-0001', [['question 1', 'other', 100], ['asked in other words', 'the archived answer', 101]]) })
    expect(archivedAnswer(dir, lookup, T0 + 5 * 86_400_000)).toBe('the archived answer')
  })
  it('another session with the same number does not match; no number matches by the question', () => {
    const dir = archive({ [day(T0)]: { chats: [chatDay('sess-other', [['question 1', 'wrong', 101]]).chats[0], chatDay('sess-0001', [['question 1', 'by the words', undefined]]).chats[0]] } })
    expect(archivedAnswer(dir, lookup, T0)).toBeUndefined()
    expect(archivedAnswer(dir, { ...lookup, messageNo: null }, T0)).toBe('by the words')
  })
  it('never reads past today, past the lookahead, a file over its cap, past the total budget, a symlink or bad JSON', () => {
    const later = day(T0 + 3 * 86_400_000)
    const body = chatDay('sess-0001', [['question 1', 'found', 101]])
    expect(archivedAnswer(archive({ [later]: body }), lookup, T0 + 86_400_000)).toBeUndefined()             // later than today
    expect(archivedAnswer(archive({ [later]: body }), lookup, T0 + 9 * 86_400_000, { lookaheadDays: 2 })).toBeUndefined()
    expect(archivedAnswer(archive({ [later]: body }), lookup, T0 + 9 * 86_400_000, { lookaheadDays: 3 })).toBe('found')
    expect(archivedAnswer(archive({ [later]: body }), lookup, T0 + 9 * 86_400_000, { fileMax: 10 })).toBeUndefined()
    expect(archivedAnswer(archive({ [day(T0)]: { chats: [] }, [later]: body }), lookup, T0 + 9 * 86_400_000, { totalMax: 40 })).toBeUndefined()
    expect(archivedAnswer(archive({ [day(T0)]: '{not json', [later]: body }), lookup, T0 + 9 * 86_400_000)).toBe('found')
    const dir = archive({})
    const real = join(dir, '..', 'elsewhere.json'); writeFileSync(real, JSON.stringify(body))
    symlinkSync(real, join(dir, `${day(T0)}.json`))
    expect(archivedAnswer(dir, lookup, T0)).toBeUndefined()
  })
})
