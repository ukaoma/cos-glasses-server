/**
 * 7.0.39 (persistent COS thread, candidate 2): the thread store's job side (lib/cos-thread.ts recordJobStarted,
 * recordJobEnd, storedAnswer). Real files in a temp dir, an injected clock. Placeholder words only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ANSWER_HEAD_CHARS, CosThread, RUNNING_STALE_MS } from './cos-thread.js'

const T0 = Date.parse('2026-11-14T15:00:00.000Z')
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-jobs-')); roots.push(root)
  const dir = join(root, 'cos-thread')
  let now = T0
  const make = () => new CosThread({ dir, now: () => now, context: () => ({ found: true, tokens: 1000 }) })
  return { dir, make, tick: (ms: number) => { now += ms } }
}
const job = (n: number, extra: Record<string, unknown> = {}) =>
  ({ clientJobId: `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`, generation: 1, sessionId: 'thread01', query: `question ${n}`, ...extra })

describe('the thread store, job side', () => {
  it('a started job reads running, and interrupted once it has had no end for 6 hours', () => {
    const h = harness(); const t = h.make()
    t.recordJobStarted(job(1))
    expect(t.historyPage({ limit: 5 }).entries[0]).toMatchObject({ status: 'running', answer: '', full: false, clientJobId: job(1).clientJobId, generation: 1 })
    h.tick(RUNNING_STALE_MS - 1000)
    expect(t.historyPage({ limit: 5 }).entries[0]!.status).toBe('running')
    h.tick(2000)
    expect(t.historyPage({ limit: 5 }).entries[0]!.status).toBe('interrupted')
  })

  it('a long completed answer goes whole to answers/<YYYY-MM>.jsonl (0600), read back only when its hash matches', () => {
    const h = harness(); const t = h.make()
    const text = 'w'.repeat(ANSWER_HEAD_CHARS + 50)
    t.recordJobEnd({ ...job(1), status: 'completed', text })
    expect(t.storedAnswer(job(1).clientJobId)).toBe(text)
    const file = join(h.dir, 'answers', '2026-11.jsonl')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(h.dir, 'answers')).mode & 0o777).toBe(0o700)
    expect(t.historyPage({ limit: 5 }).entries[0]).toMatchObject({ full: false, answerChars: text.length })
    // A file changed under the store: the answer is not served as if it were the one written.
    writeFileSync(file, readFileSync(file, 'utf8').replace('wwww', 'xxxx'))
    expect(t.storedAnswer(job(1).clientJobId)).toBeUndefined()
    expect(h.make().storedAnswer(job(1).clientJobId)).toBeUndefined()
  })

  it('a short answer needs no file; a failed one is never a stored answer', () => {
    const h = harness(); const t = h.make()
    t.recordJobEnd({ ...job(1), status: 'completed', text: 'short' })
    t.recordJobEnd({ ...job(2), status: 'failed', text: 'partial' })
    expect(t.storedAnswer(job(1).clientJobId)).toBe('short')
    expect(t.storedAnswer(job(2).clientJobId)).toBeUndefined()
    expect(t.historyPage({ limit: 5 }).entries.map(e => [e.status, e.answer, e.full])).toEqual([['completed', 'short', true], ['failed', 'partial', false]])
  })

  it('search and the digest read a job chat answer from its answer row', () => {
    const h = harness(); const t = h.make()
    t.recordJobStarted(job(1))
    t.recordJobEnd({ ...job(1), status: 'completed', text: 'the zebra answer' })
    expect(t.search('zebra', 5).hits.map(x => x.answerHead)).toEqual(['the zebra answer'])
    expect(t.view({ isThreadSession: () => false }).next).toMatchObject({ mode: 'fresh', reason: 'thread_only' })
    expect(t.view({ isThreadSession: () => false }).next.digest).toContain('the zebra answer')
    expect(t.view({ isThreadSession: () => true }).next.mode).toBe('continue')
  })

  it('updates cut by the byte cap: newest stops at the last end sent and more is set, so the rest come next (Q1)', () => {
    const h = harness(); const t = h.make()
    for (let n = 1; n <= 3; n++) t.recordJobStarted(job(n))
    const cursor = { place: 3, ends: 0 }
    for (let n = 1; n <= 3; n++) t.recordJobEnd({ ...job(n), status: 'completed', text: `answer ${n}` })
    const first = t.historyPage({ after: cursor.place, afterAnswers: cursor.ends, limit: 40, maxBytes: 10 })
    expect(first.updated.map(e => e.question)).toEqual(['question 1'])
    expect([first.newest, first.more]).toEqual(['c1.3.1', true])
    const second = t.historyPage({ after: 3, afterAnswers: 1, limit: 40, maxBytes: 10 })
    expect(second.updated.map(e => e.question)).toEqual(['question 2'])
    expect([second.newest, second.more]).toEqual(['c1.3.2', true])
    const last = t.historyPage({ after: 3, afterAnswers: 2, limit: 40 })
    expect(last.updated.map(e => e.question)).toEqual(['question 3'])
    expect([last.newest, last.more]).toEqual(['c1.3.3', false])
  })

  it('an answer row naming a file outside answers/YYYY-MM.jsonl is never read (Q1 T7)', () => {
    const h = harness(); const t = h.make()
    t.recordJobEnd({ ...job(1), status: 'completed', text: 'v'.repeat(ANSWER_HEAD_CHARS + 10) })
    expect(t.storedAnswer(job(1).clientJobId)).toHaveLength(ANSWER_HEAD_CHARS + 10)
    const ledger = join(h.dir, 'ledger.jsonl')
    writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('"file":"answers/2026-11.jsonl"', '"file":"answers/../answers/2026-11.jsonl"'))
    expect(h.make().storedAnswer(job(1).clientJobId)).toBeUndefined()
  })

  it('every answer row survives a restart, and a later generation replaces an earlier one', () => {
    const h = harness(); const t = h.make()
    t.recordJobEnd({ ...job(1), status: 'failed', text: 'first try' })
    t.recordJobEnd({ ...job(1), generation: 2, status: 'completed', text: 'second try' })
    t.recordJobEnd({ ...job(1), status: 'completed', text: 'a late end of the first try' })   // an older generation never wins
    const again = h.make()
    expect(again.historyPage({ limit: 5 }).entries).toEqual([expect.objectContaining({ status: 'completed', answer: 'second try', generation: 2 })])
    expect(again.historySize()).toBe(1)
  })
})
