// 7.0.57: a failed thread chat carries its job's own plain reason (job 59a4413f, 2026-11-18: the thread showed only
// "This ask did not finish."). Same harness as cos-thread-jobs.test.ts; bounded inputs only.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CosThread, REASON_CHARS, failureReason } from './cos-thread.js'

const T0 = Date.parse('2026-11-18T14:36:10.000Z')
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-reason-')); roots.push(root)
  const dir = join(root, 'cos-thread')
  const make = () => new CosThread({ dir, now: () => T0, context: () => ({ found: true, tokens: 1000 }) })
  return { make }
}
const job = (n: number) =>
  ({ clientJobId: `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`, generation: 1, sessionId: 'thread01', query: `question ${n}` })
const REASON = 'Cursor stopped after 3 minutes with no progress while it was waiting on a sub-agent. Ask again.'

describe('failureReason', () => {
  it('keeps a plain one-line reason as it is', () => {
    expect(failureReason(REASON)).toBe(REASON)
  })
  it('turns control characters and line breaks into one space and trims', () => {
    expect(failureReason('  Cursor\nstopped\u0000 now . ')).toBe('Cursor stopped now .')
  })
  it('cuts at REASON_CHARS with an ellipsis', () => {
    const out = failureReason('x'.repeat(REASON_CHARS + 40))
    expect(out).toHaveLength(REASON_CHARS)
    expect(out.endsWith('…')).toBe(true)
  })
  it('gives nothing for a value that is not a string', () => {
    expect(failureReason(undefined)).toBe('')
    expect(failureReason(42)).toBe('')
  })
})

describe('the thread store keeps a failed chat\'s reason', () => {
  it('a failed chat shows its partial answer and its reason', () => {
    const h = harness(); const t = h.make()
    t.recordJobStarted(job(1))
    t.recordJobEnd({ ...job(1), status: 'failed', text: 'Reading the meeting now.', reason: REASON })
    expect(t.historyPage({ limit: 5 }).entries[0]).toMatchObject({ status: 'failed', answer: 'Reading the meeting now.', reason: REASON })
  })
  it('a completed or interrupted chat never carries a reason, even if one is passed', () => {
    const h = harness(); const t = h.make()
    t.recordJobEnd({ ...job(1), status: 'completed', text: 'done', reason: REASON })
    t.recordJobEnd({ ...job(2), status: 'interrupted', text: '', reason: REASON })
    for (const entry of t.historyPage({ limit: 5 }).entries) expect(entry).not.toHaveProperty('reason')
  })
  it('a failed chat with no reason has no reason field (the page keeps its fixed words)', () => {
    const h = harness(); const t = h.make()
    t.recordJobEnd({ ...job(1), status: 'failed', text: '' })
    expect(t.historyPage({ limit: 5 }).entries[0]).not.toHaveProperty('reason')
  })
  it('the reason survives a restart (read back from the ledger), bounded', () => {
    const h = harness()
    h.make().recordJobEnd({ ...job(1), status: 'failed', text: '', reason: 'y'.repeat(REASON_CHARS * 2) })
    const entry = h.make().historyPage({ limit: 5 }).entries[0]!
    expect(entry.reason).toHaveLength(REASON_CHARS)
  })
  it('a later generation that completes replaces the failed one, reason and all', () => {
    const h = harness(); const t = h.make()
    t.recordJobEnd({ ...job(1), status: 'failed', text: '', reason: REASON })
    t.recordJobEnd({ ...job(1), generation: 2, status: 'completed', text: 'the answer' })
    expect(t.historyPage({ limit: 5 }).entries[0]).toMatchObject({ status: 'completed', answer: 'the answer', generation: 2 })
    expect(t.historyPage({ limit: 5 }).entries[0]).not.toHaveProperty('reason')
  })
})
