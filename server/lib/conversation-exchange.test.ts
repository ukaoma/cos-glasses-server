import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmp = ''

beforeEach(() => {
  vi.useFakeTimers()
  tmp = mkdtempSync(join(tmpdir(), 'cos-conversation-'))
  process.env.COS_DATA_DIR = tmp
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.COS_DATA_DIR
  rmSync(tmp, { recursive: true, force: true })
})

describe('conversation exchange identity', () => {
  it('returns the inserted object and removes only that exact duplicate', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.createSession()
    const first = conversation.addExchange(sid, 'user', 'identical prompt', 42)
    const second = conversation.addExchange(sid, 'user', 'identical prompt', 42)

    expect(first).not.toBe(second)
    expect(conversation.getHistory(sid)).toEqual([first, second])
    expect(conversation.removeExchange(sid, second)).toBe(true)
    expect(conversation.removeExchange(sid, second)).toBe(false)
    expect(conversation.getHistory(sid)).toEqual([first])

    await vi.advanceTimersByTimeAsync(500)
  })
})
