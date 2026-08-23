import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    const previous = currentMessageEra()
    const result = await resetLiveMessageEra({
      confirm: true,
      now: 1_700_000_000_300,
      activeRuns: 0,
    })
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
  it('rotates with no archive step to block it', async () => {
    const { resetLiveMessageEra } = await import('./message-era-reset.js')
    const { currentMessageEra } = await import('./message-era.js')
    const before = currentMessageEra()
    const result = await resetLiveMessageEra({ confirm: true, activeRuns: 0 })
    expect(result.ok).toBe(true)
    expect(result.archived).toBe(0)
    expect(result.previousEra).toBe(before)
    expect(currentMessageEra()).toBe(result.era)
    expect(currentMessageEra()).not.toBe(before)
  })

  // The previous canary injected an archiveAndRelease and asserted it was never
  // called. That only ever caught a regression routed THROUGH the callback --
  // and the code this replaced called endSession() directly as its default,
  // which such a recorder never sees. Pin the structural property instead.
  //
  // Importing ./conversation.js is not merely unused code: its module scope runs
  // loadFromDisk() and a boot runDailyArchiveMirror(). In the one-shot CLI that
  // means a second process concurrently rewriting the archives the live server
  // owns, and appendToArchive appends rather than upserts.
  it('never imports ./conversation.js — its module scope rewrites archives', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./message-era-reset.ts', import.meta.url), 'utf8')
      // Strip comments first: this file explains the rule in prose, and a
      // substring check would match the explanation and pass regardless.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n')
    expect(src).not.toMatch(/from\s+['"]\.\/conversation\.js['"]/)
    expect(src).not.toMatch(/\bendSession\b/)
    expect(src).not.toMatch(/\bgetActiveSessions\b/)
  })
})
