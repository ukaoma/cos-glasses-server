import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { meetingVoiceReview, parseSidecarListHead } from './meeting-voice-review.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cos-voice-review-'))
  process.env.COS_DATA_DIR = dir
})

afterEach(() => {
  delete process.env.COS_DATA_DIR
  vi.resetModules()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('parseSidecarListHead', () => {
  it('reads sessionId and speakers from the sidecar head without chunks', () => {
    const head = '{"schemaVersion":2,"sessionId":"meeting_1787_abc","speakers":["Ext","MU","Peter"],"chunks":['
    expect(parseSidecarListHead(head)).toEqual({
      sessionId: 'meeting_1787_abc',
      speakers: ['Ext', 'MU', 'Peter'],
    })
  })

  it('returns no speakers when the array is absent', () => {
    expect(parseSidecarListHead('{"sessionId":"meeting_x","chunks":[')).toEqual({
      sessionId: 'meeting_x',
      speakers: [],
    })
  })
})

describe('meetingVoiceReview', () => {
  it('counts Ext as still needing a name', () => {
    const review = meetingVoiceReview(['Ext', 'MU', 'Peter', 'Ext'])
    expect(review.voices).toBe(3)
    expect(review.unattributedVoices).toBe(1)
    expect(review.namedVoices).toBe(2)
    expect(review.humanTouched).toBe(false)
  })

  it('counts Unidentified N as unattributed', () => {
    expect(meetingVoiceReview(['Unidentified 1', 'Gina']).unattributedVoices).toBe(1)
  })

  it('marks a meeting touched when the ledger has an applied row', async () => {
    mkdirSync(join(dir, 'meeting-corrections'), { recursive: true })
    writeFileSync(
      join(dir, 'meeting-corrections', 'meeting_t.jsonl'),
      `${JSON.stringify({
        id: 'c1',
        phase: 'applied',
        at: '2026-08-21T14:00:00.000Z',
        from: 'Ext',
        to: 'Milo LeBaron',
        chunks: [1],
        scope: 'meeting',
      })}\n`,
    )
    vi.resetModules()
    const fresh = await import('./meeting-voice-review.js')
    expect(fresh.meetingVoiceReview(['Milo LeBaron', 'MU'], 'meeting_t').humanTouched).toBe(true)
  })

  it('does not treat a lone intent as a completed review', async () => {
    mkdirSync(join(dir, 'meeting-corrections'), { recursive: true })
    writeFileSync(
      join(dir, 'meeting-corrections', 'meeting_i.jsonl'),
      `${JSON.stringify({
        id: 'c1',
        phase: 'intent',
        at: '2026-08-21T14:00:00.000Z',
        from: 'Ext',
        to: 'Milo LeBaron',
        chunks: [1],
        scope: 'meeting',
      })}\n`,
    )
    vi.resetModules()
    const fresh = await import('./meeting-voice-review.js')
    expect(fresh.meetingVoiceReview(['Ext'], 'meeting_i').humanTouched).toBe(false)
  })
})
