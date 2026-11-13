// 7.0.33 A2 (Anand round 2, slide 10): a message carries when the question was asked (queryTimestamp) beside when COS
// answered (timestamp), so Control Web can put a small time under each. Executes the archive read against a scratch
// COS_DATA_DIR with fake time; the live route builds the same field from the same exchange (checked by its source).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let tmp = ''
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); tmp = mkdtempSync(join(tmpdir(), 'cos-msgtimes-')); process.env.COS_DATA_DIR = tmp })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.resetModules(); delete process.env.COS_DATA_DIR; rmSync(tmp, { recursive: true, force: true }) })

describe('a message has both times', () => {
  it('an archived message: queryTimestamp is the question\'s, timestamp the answer\'s', async () => {
    const asked = new Date(2026, 8, 11, 23, 40, 0).getTime(), answered = asked + 95_000
    vi.setSystemTime(asked)
    const conversation = await import('./conversation.js')
    const archive = await import('./archive.js')
    await vi.advanceTimersByTimeAsync(0)
    const id = conversation.createSession()
    conversation.addExchange(id, 'user', 'When is the pricing review?', 7)
    vi.setSystemTime(answered)
    conversation.addExchange(id, 'assistant', 'Thursday at ten.', 7)
    vi.setSystemTime(new Date(2026, 8, 12, 0, 0, 5).getTime())
    conversation.__resetArchiveMirrorForTests()
    expect(await conversation.ensureArchiveMirrorForDay()).toBe(true)
    const day = archive.loadArchive('2026-09-11')!
    const ex = day.chats.flatMap((c: any) => c.exchanges)
    const msgs = archive.getArchiveDayMessages('2026-09-11')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.timestamp).toBe(ex.find((e: any) => e.role === 'assistant').timestamp)
    expect(msgs[0]!.queryTimestamp).toBe(ex.find((e: any) => e.role === 'user').timestamp)
    expect(msgs[0]!.queryTimestamp).toBeLessThan(msgs[0]!.timestamp)
  })
  it('the live route sends the same field from the question\'s own exchange', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'sessions.ts'), 'utf8')
    expect(src).toContain('...(Number.isFinite(ex.timestamp) ? { queryTimestamp: ex.timestamp } : {}),')
  })
})
