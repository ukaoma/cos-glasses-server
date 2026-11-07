import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNeedsYouReader, needsYouCount, NEEDS_YOU_STALE_FLAG_LIMIT_MS, NEEDS_YOU_TIMEOUT_MS, NEEDS_YOU_TTL_MS, parseJsonObject } from './learning-needs-you.js'
import { dispatchMemoriesWebOp } from './web-memories-bridge.js'

function scriptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-needs-you-'))
  writeFileSync(join(dir, 'cos_python'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(dir, 'learning_events.py'), '')
  return dir
}

describe('needs-you count for the web Memories page', () => {
  it('reads the CLI JSON, keeps Control\'s keys, and caps the count by the limit', async () => {
    const dir = scriptsDir()
    const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = []
    try {
      const reader = createNeedsYouReader({
        scriptsDir: dir,
        run: async (file, args, timeoutMs) => {
          calls.push({ file, args, timeoutMs })
          return { code: 0, stdout: 'warming up\n{"count": 83, "limit": 7, "reward_enabled": true, "items": [1,2,3,4,5,6,7], "noise": 1}\n' }
        },
      })
      const block = await reader.read()
      expect(block).toEqual({ count: 83, limit: 7, reward_enabled: true, items: [1, 2, 3, 4, 5, 6, 7] })
      expect(needsYouCount(block)).toBe(7)
      expect(calls).toEqual([{ file: join(dir, 'cos_python'), args: [join(dir, 'learning_events.py'), 'needs-you'], timeoutMs: NEEDS_YOU_TIMEOUT_MS }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caches for the TTL, runs once for concurrent reads, and reads again after the TTL', async () => {
    const dir = scriptsDir()
    let clock = 1_000
    let runs = 0
    try {
      const reader = createNeedsYouReader({ scriptsDir: dir, now: () => clock, run: async () => { runs += 1; return { code: 0, stdout: '{"count": 2}' } } })
      await Promise.all([reader.read(), reader.read(), reader.read()])
      expect(runs).toBe(1)
      clock += NEEDS_YOU_TTL_MS - 1
      await reader.read()
      expect(runs).toBe(1)
      clock += 2
      await reader.read()
      expect(runs).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers null, never a guess, when the CLI is missing, fails, or prints no count', async () => {
    expect(await createNeedsYouReader({ scriptsDir: null }).read()).toBeNull()
    expect(await createNeedsYouReader({ scriptsDir: join(tmpdir(), 'cos-no-such-dir-xyz') }).read()).toBeNull()
    const dir = scriptsDir()
    try {
      expect(await createNeedsYouReader({ scriptsDir: dir, run: async () => ({ code: 1, stdout: '{"count": 5}' }) }).read()).toBeNull()
      expect(await createNeedsYouReader({ scriptsDir: dir, run: async () => ({ code: 0, stdout: 'not json' }) }).read()).toBeNull()
      expect(await createNeedsYouReader({ scriptsDir: dir, run: async () => ({ code: 0, stdout: '{"gates": {}}' }) }).read()).toBeNull()
      expect(await createNeedsYouReader({ scriptsDir: dir, run: async () => { throw new Error('spawn failed') } }).read()).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(parseJsonObject('[1,2]')).toBeNull()
    expect(needsYouCount(null)).toBeNull()
    expect(needsYouCount({ items: [1, 2, 3] })).toBe(3)
    expect(needsYouCount({ count: 4 })).toBe(4)
  })

  it('matches Control: 90 s and one hour, never caches a failure, falls back to the last good count', async () => {
    // Control's helper constants (main.swift 10969-10970), pinned here so a change is deliberate.
    expect(NEEDS_YOU_TTL_MS).toBe(90_000)
    expect(NEEDS_YOU_STALE_FLAG_LIMIT_MS).toBe(3_600_000)
    expect(NEEDS_YOU_TIMEOUT_MS).toBe(10_000)
    const dir = scriptsDir()
    let clock = 0
    let mode: 'ok' | 'fail' = 'ok'
    let runs = 0
    try {
      const reader = createNeedsYouReader({ scriptsDir: dir, now: () => clock, run: async () => { runs += 1; return mode === 'ok' ? { code: 0, stdout: '{"count": 9, "limit": 7, "reward_enabled": true}' } : { code: 1, stdout: '' } } })
      expect(await reader.read()).toEqual({ count: 9, limit: 7, reward_enabled: true })
      mode = 'fail'
      clock += NEEDS_YOU_TTL_MS + 1
      // A failed read returns the last good block and is not cached: the next read tries again.
      expect(await reader.read()).toEqual({ count: 9, limit: 7, reward_enabled: true })
      expect(await reader.read()).toEqual({ count: 9, limit: 7, reward_enabled: true })
      expect(runs).toBe(3)
      // Past an hour the stale block keeps its count but loses the reward flag.
      clock = NEEDS_YOU_STALE_FLAG_LIMIT_MS + 1
      expect(await reader.read()).toEqual({ count: 9, limit: 7 })
      // Recovery replaces the stale block.
      mode = 'ok'
      expect(await reader.read()).toEqual({ count: 9, limit: 7, reward_enabled: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bridge status carries a number or null as learningToReview, never the to_review object', async () => {
    const loopback = async (path: string) => path === '/api/health'
      ? { status: 200, body: { server_version: '6.99.3' } }
      : { status: 200, body: { available: true, learning: { available: true, to_review: { patterns: 3, task_proposals: 80 }, total: 90 }, memory: {}, threads: {}, graph: {} } }
    const withCount = await dispatchMemoriesWebOp('status', {}, loopback, 'x', async () => ({ count: 83, limit: 7, reward_enabled: true }))
    expect(withCount.details.learningToReview).toBe(7)
    expect(withCount.details.learningRewardEnabled).toBe(true)
    expect(withCount.details.needs_you).toEqual({ count: 83, limit: 7, reward_enabled: true })
    const without = await dispatchMemoriesWebOp('status', {}, loopback, 'x', async () => null)
    expect(without.details.learningToReview).toBeNull()
    expect(without.details).not.toHaveProperty('needs_you')
  })

  // Control Web now rates cues in Memories, so cues.summary reports the history contract instead of always hiding the
  // entries (web-memories-bridge-cues.test.ts covers both answers). An answer outside the v1 contract stays hidden.
  it('cues.summary uses Control\'s keys and is available only for a v1 history answer', async () => {
    const outside = async () => ({ status: 200, body: { counts: { unrated: 4, rated: 9 } } })
    expect((await dispatchMemoriesWebOp('cues.summary', {}, outside, 'x', async () => null)).details).toEqual({ available: false })
    const v1 = async () => ({ status: 200, body: { v: 1, counts: { unrated: 4, rated: 9, total: 13 } } })
    expect((await dispatchMemoriesWebOp('cues.summary', {}, v1, 'x', async () => null)).details).toEqual({ available: true, unrated: 4, rated: 9, total: 13 })
  })
})
