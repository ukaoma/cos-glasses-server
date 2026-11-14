/**
 * 7.0.39 (persistent COS thread, candidate 3): startTimeline (lib/cos-thread-timeline-sources.ts). turn-end-ask.ts is
 * mocked WITH an onTurnAskEvent, as X1's build will export it, so the subscription is exercised before it lands.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ask = vi.hoisted(() => ({ listeners: [] as Array<(e: unknown) => void>, subscribed: 0 }))
vi.mock('./turn-end-ask.js', () => ({
  onTurnAskEvent: (l: (e: unknown) => void) => { ask.subscribed++; ask.listeners.push(l); return () => { ask.listeners.splice(ask.listeners.indexOf(l), 1) } },
}))

const roots: string[] = []
const on = () => true
afterEach(async () => {
  const { __resetTimelineForTests } = await import('./cos-thread-timeline-sources.js')
  __resetTimelineForTests()
  vi.useRealTimers()
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }))
})

describe('startTimeline', () => {
  it('subscribes once, records session questions from the callback, and runs its first sweep after 5 s, then on its schedule', async () => {
    vi.useFakeTimers()
    const { startTimeline, SWEEP_IDLE_MS } = await import('./cos-thread-timeline-sources.js')
    const { CosThread } = await import('./cos-thread.js')
    const root = mkdtempSync(join(tmpdir(), 'cos-tl-start-')); roots.push(root)
    const thread = new CosThread({ dir: join(root, 'cos-thread'), context: () => ({ found: true, tokens: 1 }) })
    let feedReads = 0
    const sources = { feed: () => { feedReads++; return [] } }
    startTimeline(thread, sources, on)
    startTimeline(thread, sources, on)
    expect(ask.subscribed).toBe(1)
    ask.listeners[0]!({ type: 'asked', askKey: 's1:p1', sessionId: 's1', at: Date.now(), question: 'Ship it?' })
    ask.listeners[0]!({ type: 'nonsense' })   // a malformed event is ignored, never thrown
    expect(thread.timeline().crumbs.map(c => [c.kind, c.line])).toEqual([['session_question', 'Ship it?']])
    expect(feedReads).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(feedReads).toBe(1)
    await vi.advanceTimersByTimeAsync(SWEEP_IDLE_MS)
    expect(feedReads).toBe(2)
  })

  it('while a backfill is behind the next sweep comes after 60 s, not 5 minutes', async () => {
    vi.useFakeTimers()
    const { startTimeline, SWEEP_BACKLOG_MS } = await import('./cos-thread-timeline-sources.js')
    const { CosThread } = await import('./cos-thread.js')
    const root = mkdtempSync(join(tmpdir(), 'cos-tl-start-')); roots.push(root)
    const thread = new CosThread({ dir: join(root, 'cos-thread'), context: () => ({ found: true, tokens: 1 }) })
    let reads = 0
    const days = Array.from({ length: 25 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`).reverse()
    startTimeline(thread, { archiveDays: () => days, archiveDay: () => { reads++; return [] } }, on)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads).toBe(10)
    await vi.advanceTimersByTimeAsync(SWEEP_BACKLOG_MS)
    expect(reads).toBe(20)
  })

  it('Drop it off stops it without a restart: no read, no write, no timer, no listener; on again, the next start resumes (Q1, lead 13:0x)', async () => {
    vi.useFakeTimers()
    const { startTimeline, SWEEP_IDLE_MS } = await import('./cos-thread-timeline-sources.js')
    const { CosThread } = await import('./cos-thread.js')
    const root = mkdtempSync(join(tmpdir(), 'cos-tl-start-')); roots.push(root)
    const thread = new CosThread({ dir: join(root, 'cos-thread'), context: () => ({ found: true, tokens: 1 }) })
    let enabled = true
    let feedReads = 0
    const sources = { feed: () => { feedReads++; return [{ kind: 'ping', threadId: `fi_${feedReads}`, createdAt: new Date().toISOString(), readAt: null, source: 'cos', line: `line ${feedReads}`, state: 'live' } as any] } }
    const switchOn = () => enabled
    // A switch that cannot be read reads as off.
    startTimeline(thread, sources, () => { throw new Error('unreadable') })
    expect(ask.listeners).toHaveLength(0)
    // Never started while off.
    enabled = false
    const subscribedBefore = ask.subscribed
    startTimeline(thread, sources, switchOn)
    expect(ask.subscribed).toBe(subscribedBefore)
    await vi.advanceTimersByTimeAsync(5_000 + SWEEP_IDLE_MS)
    expect(feedReads).toBe(0)
    enabled = true
    startTimeline(thread, sources, switchOn)
    await vi.advanceTimersByTimeAsync(5_000)
    expect([feedReads, ask.listeners.length]).toEqual([1, 1])
    const crumbs = thread.timeline().crumbs.length
    // Turned off: a session question is ignored at once, and the next pass reads and writes nothing and stops.
    enabled = false
    ask.listeners[0]!({ type: 'asked', askKey: 's1:p1', sessionId: 's1', at: Date.now(), question: 'Ignored while off?' })
    await vi.advanceTimersByTimeAsync(SWEEP_IDLE_MS)
    expect(feedReads).toBe(1)
    expect(thread.timeline().crumbs).toHaveLength(crumbs)
    expect(ask.listeners).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * SWEEP_IDLE_MS)
    expect(feedReads).toBe(1)
    // On again: the thread routes call startTimeline on their next request, and it resumes.
    enabled = true
    startTimeline(thread, sources, switchOn)
    expect(ask.listeners).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(feedReads).toBe(2)
  })

  it('a sweep that throws is caught and the schedule continues', async () => {
    vi.useFakeTimers()
    const { startTimeline, SWEEP_IDLE_MS } = await import('./cos-thread-timeline-sources.js')
    const { CosThread } = await import('./cos-thread.js')
    const root = mkdtempSync(join(tmpdir(), 'cos-tl-start-')); roots.push(root)
    const thread = new CosThread({ dir: join(root, 'cos-thread'), context: () => ({ found: true, tokens: 1 }) })
    let calls = 0
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    startTimeline(thread, { feed: () => { calls++; throw new Error('boom') } }, on)
    await vi.advanceTimersByTimeAsync(5_000 + SWEEP_IDLE_MS)
    expect(calls).toBe(2)
    expect(err.mock.calls.flat().join(' ')).not.toContain('boom')   // the code only, never a message
    err.mockRestore()
  })
})
