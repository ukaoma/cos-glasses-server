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

  it('archives live sessions then starts a new era at max 0', async () => {
    const { resetLiveMessageEra } = await import('./message-era-reset.js')
    const { currentMessageEra } = await import('./message-era.js')
    const released: string[] = []
    const previous = currentMessageEra()
    const result = await resetLiveMessageEra({
      confirm: true,
      now: 1_700_000_000_300,
      activeRuns: 0,
      sessions: [session('abc')],
      archiveAndRelease: async (item) => {
        released.push(item.id)
        return true
      },
    })
    expect(released).toEqual(['abc'])
    expect(result).toMatchObject({
      ok: true,
      previousEra: previous,
      archived: 1,
      max: 0,
    })
    expect(result.era.startsWith('era-')).toBe(true)
    expect(currentMessageEra()).toBe(result.era)
  })

  it('does not rotate the era when archive fails', async () => {
    const { resetLiveMessageEra } = await import('./message-era-reset.js')
    const { currentMessageEra } = await import('./message-era.js')
    const before = currentMessageEra()
    await expect(resetLiveMessageEra({
      confirm: true,
      activeRuns: 0,
      sessions: [session('keep')],
      archiveAndRelease: async () => false,
    })).rejects.toMatchObject({
      code: 'archive_failed',
      status: 503,
    })
    expect(currentMessageEra()).toBe(before)
  })
})
