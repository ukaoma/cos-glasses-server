import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createStaticProbeCache, parseCursorAboutVersion, probeClaude } from './health-static-probes.js'

describe('health static probes', () => {
  it('extracts the real Cursor version instead of the About heading', () => {
    expect(parseCursorAboutVersion(`
      About Cursor CLI

      CLI Version         2026.07.23-e383d2b
      Model               Composer 2.5 Fast
    `)).toBe('2026.07.23-e383d2b')
    expect(parseCursorAboutVersion('About Cursor CLI\nModel Composer')).toBeUndefined()
    expect(parseCursorAboutVersion('CLI Version: 2026.08.03+canary.1')).toBe('2026.08.03+canary.1')
  })

  it('deduplicates cold probes and serves stale data while refreshing', async () => {
    let now = 1_000
    let revision = 0
    let releaseSecondProbe = () => {}
    const secondProbeGate = new Promise<void>(resolve => { releaseSecondProbe = resolve })
    const load = vi.fn(async () => {
      const value = ++revision
      if (value === 2) await secondProbeGate
      return value
    })
    const cache = createStaticProbeCache(load, () => 30_000, () => now)

    const [first, sameColdProbe] = await Promise.all([cache.get(), cache.get()])
    expect([first, sameColdProbe]).toEqual([1, 1])
    expect(load).toHaveBeenCalledTimes(1)

    now += 30_001
    await expect(cache.get()).resolves.toBe(1)
    await expect(cache.get()).resolves.toBe(1)
    expect(load).toHaveBeenCalledTimes(2)
    releaseSecondProbe()
    await vi.waitFor(async () => expect(await cache.get()).toBe(2))

    now += 1
    await expect(cache.get()).resolves.toBe(2)
  })
})


describe('Claude managed-service health', () => {
  it('finds an explicit binary outside PATH and reports invalid overrides honestly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-claude-health-'))
    const binary = join(root, 'claude')
    const oldPath = process.env.PATH
    const oldBinary = process.env.COS_CLAUDE_BIN
    try {
      writeFileSync(binary, '#!/bin/sh\necho "2.1.294 (Claude Code)"\n', { mode: 0o755 })
      process.env.PATH = '/usr/bin:/bin'
      process.env.COS_CLAUDE_BIN = binary
      await expect(probeClaude()).resolves.toEqual({ value: '2.1.294 (Claude Code)', available: true })
      process.env.COS_CLAUDE_BIN = join(root, 'missing')
      await expect(probeClaude()).resolves.toEqual({ value: 'unresolved (env_override_unusable)', available: false })
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
      if (oldBinary === undefined) delete process.env.COS_CLAUDE_BIN; else process.env.COS_CLAUDE_BIN = oldBinary
      rmSync(root, { recursive: true, force: true })
    }
  })
})
