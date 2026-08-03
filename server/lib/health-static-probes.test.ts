import { describe, expect, it, vi } from 'vitest'
import { createStaticProbeCache, parseCursorAboutVersion } from './health-static-probes.js'

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
