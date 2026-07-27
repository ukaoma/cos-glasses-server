import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('message-number eras (public)', () => {
  const prevData = process.env.COS_DATA_DIR
  let dir = ''

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'cos-message-era-'))
    process.env.COS_DATA_DIR = dir
  })

  afterEach(() => {
    if (prevData === undefined) delete process.env.COS_DATA_DIR
    else process.env.COS_DATA_DIR = prevData
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps unstamped historical exchanges in the legacy era and isolates a reset', async () => {
    const {
      exchangeBelongsToEra,
      LEGACY_MESSAGE_ERA,
      createMessageEra,
      currentMessageEra,
    } = await import('./message-era.js')

    expect(exchangeBelongsToEra({}, LEGACY_MESSAGE_ERA)).toBe(true)
    expect(exchangeBelongsToEra({ messageEra: LEGACY_MESSAGE_ERA }, LEGACY_MESSAGE_ERA)).toBe(true)
    expect(exchangeBelongsToEra({ messageEra: 'era-new' }, LEGACY_MESSAGE_ERA)).toBe(false)

    expect(currentMessageEra()).toBe(LEGACY_MESSAGE_ERA)
    const next = createMessageEra(1_700_000_000_000)
    expect(next.era.startsWith('era-')).toBe(true)
    expect(currentMessageEra()).toBe(next.era)
    expect(exchangeBelongsToEra({ messageEra: next.era }, next.era)).toBe(true)
    expect(exchangeBelongsToEra({}, next.era)).toBe(false)
    expect(exchangeBelongsToEra({ messageEra: 'era-old' }, next.era)).toBe(false)
  })

  it('persists era under COS_DATA_DIR so npx upgrades keep the namespace', async () => {
    const mod = await import('./message-era.js')
    const created = mod.createMessageEra(1_700_000_000_100)
    mod.__resetMessageEraCacheForTests()
    expect(mod.currentMessageEra()).toBe(created.era)

    writeFileSync(join(dir, 'message-era.json'), JSON.stringify({
      v: 1, era: 'era-manual', startedAt: 42,
    }))
    mod.__resetMessageEraCacheForTests()
    expect(mod.currentMessageEra()).toBe('era-manual')
  })

  it('picks up an on-disk era rewrite without an explicit cache clear (reset CLI vs live server)', async () => {
    const mod = await import('./message-era.js')
    const first = mod.createMessageEra(1_700_000_000_200)
    expect(mod.currentMessageEra()).toBe(first.era)

    // Simulate reset-message-era.ts writing from another process while this
    // module keeps its prior in-memory cache — mtime change must reload.
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(dir, 'message-era.json'), JSON.stringify({
      v: 1, era: 'era-from-other-process', startedAt: 99,
    }))
    expect(mod.currentMessageEra()).toBe('era-from-other-process')
  })
})
