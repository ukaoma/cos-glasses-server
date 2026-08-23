import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionToArchive } from './archive.js'

describe('resetLiveMessageEra', () => {
  const prevData = process.env.COS_DATA_DIR
  let dir = ''

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'cos-message-era-reset-'))
    process.env.COS_DATA_DIR = dir
  })

  afterEach(() => {
    if (prevData === undefined) delete process.env.COS_DATA_DIR
    else process.env.COS_DATA_DIR = prevData
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function session(id = 'live'): SessionToArchive {
    return {
      id,
      exchanges: [
        { role: 'user', content: 'old q', timestamp: 1, globalMsgNum: 835 },
        { role: 'assistant', content: 'old a', timestamp: 2, globalMsgNum: 835 },
      ],
      contextBreaks: [],
      createdAt: 1,
      lastActivity: 2,
    }
  }

  it('refuses without confirm and does not rotate the era', async () => {
    const { resetLiveMessageEra, MessageEraResetError } = await import('./message-era-reset.js')
    const { currentMessageEra } = await import('./message-era.js')
    const before = currentMessageEra()
    await expect(resetLiveMessageEra({ confirm: false, activeRuns: 0 })).rejects.toMatchObject({
      code: 'confirmation_required',
      status: 400,
    })
    await expect(resetLiveMessageEra({ confirm: false, activeRuns: 0 })).rejects.toBeInstanceOf(MessageEraResetError)
    expect(currentMessageEra()).toBe(before)
  })

  it('refuses while a query is in flight', async () => {
    const { resetLiveMessageEra } = await import('./message-era-reset.js')
    const { currentMessageEra } = await import('./message-era.js')
    const before = currentMessageEra()
    await expect(resetLiveMessageEra({ confirm: true, activeRuns: 1 })).rejects.toMatchObject({
      code: 'query_in_flight',
      status: 409,
    })
    expect(currentMessageEra()).toBe(before)
  })

  // 6.36.19 inverted this. It used to end every live session before rotating,
  // which is what made "reset the message count" also empty CHAT and kill the
  // conversation in progress. The thread must now survive the reset.
  it('rotates the era and never releases a live session', async () => {
    const { resetLiveMessageEra } = await import('./message-era-reset.js')
    const { currentMessageEra } = await import('./message-era.js')
    const released: string[] = []
    const previous = currentMessageEra()
    const result = await resetLiveMessageEra({
      confirm: true,
      now: 1_700_000_000_300,
      activeRuns: 0,
      sessions: [session('abc')],
      // Injected on purpose: if any future edit reintroduces the archive step,
      // this records the call and the assertion below fails.
      archiveAndRelease: async (item) => {
        released.push(item.id)
        return true
      },
    })
    expect(released).toEqual([])
    expect(result).toMatchObject({
      ok: true,
      previousEra: previous,
      archived: 0,
      max: 0,
    })
    expect(result.era.startsWith('era-')).toBe(true)
    expect(currentMessageEra()).toBe(result.era)
  })

  // Replaces "does not rotate the era when archive fails". There is no archive
  // step left to fail, so the 503 archive_failed path is gone rather than moved.
  // A refusing archiveAndRelease must no longer be able to block the rotation.
  it('rotates even when a supplied archiveAndRelease would have refused', async () => {
    const { resetLiveMessageEra } = await import('./message-era-reset.js')
    const { currentMessageEra } = await import('./message-era.js')
    const before = currentMessageEra()
    const result = await resetLiveMessageEra({
      confirm: true,
      activeRuns: 0,
      sessions: [session('keep')],
      archiveAndRelease: async () => false,
    })
    expect(result.ok).toBe(true)
    expect(result.archived).toBe(0)
    expect(result.previousEra).toBe(before)
    expect(currentMessageEra()).toBe(result.era)
    expect(currentMessageEra()).not.toBe(before)
  })
})
