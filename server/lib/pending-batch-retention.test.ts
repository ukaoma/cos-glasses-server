import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingFinalizationJob } from './meeting-finalization-jobs.js'
import { PENDING_BATCH_STALE_MS, WAITING_JOB_AUDIO_HOLD_MS, sweepStalePendingBatch } from './pending-batch-retention.js'

const NOW = Date.parse('2026-10-31T19:30:00.000Z')
const ID = 'mac_c5c9b8ff-3977-4490-9dd8-de20ef131bb6'
let data = ''
let root = ''

function pending(name: string, ageMs: number): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'chunk_0000.wav'), 'audio')
  const marker = join(dir, '_batch_pending.marker')
  writeFileSync(marker, '1')
  const at = (NOW - ageMs) / 1000
  utimesSync(marker, at, at)
  return dir
}

function job(over: Partial<MeetingFinalizationJob> = {}): MeetingFinalizationJob {
  return {
    schemaVersion: 1, sessionId: ID, meetingPath: join(data, 'recordings', 'm.md'), sidecarPath: join(data, 'recordings', 'm.g2-chunks.json'),
    audioDir: join(root, ID), streamingWordCount: 10, phase: 'batch_pending', claimPending: false,
    createdAt: new Date(NOW - 20 * 60 * 60 * 1000).toISOString(), updatedAt: new Date(NOW).toISOString(), ...over,
  }
}

const STALE = PENDING_BATCH_STALE_MS + 1_000

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'cos.pending-batch-')) // a dot in the path, like ~/.cos-glasses
  root = join(data, 'pending-batch')
  mkdirSync(root)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); rmSync(data, { recursive: true, force: true }) })

describe('sweepStalePendingBatch', () => {
  it('keeps a stale directory while its saved meeting is waiting on HQ', () => {
    const dir = pending(ID, STALE)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [job()] })
    expect(existsSync(join(dir, 'chunk_0000.wav'))).toBe(true)
  })

  it('purges a stale directory nobody is waiting on', () => {
    const dir = pending(ID, STALE)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [] })
    expect(existsSync(dir)).toBe(false)
  })

  it('a job past HQ does not hold its audio', () => {
    const dir = pending(ID, STALE)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [job({ phase: 'ops_pending' })] })
    expect(existsSync(dir)).toBe(false)
  })

  it('the hold ends: a job that can never finish does not keep disk forever', () => {
    const dir = pending(ID, STALE)
    const old = new Date(NOW - WAITING_JOB_AUDIO_HOLD_MS - 1_000).toISOString()
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [job({ createdAt: old })] })
    expect(existsSync(dir)).toBe(false)
  })

  it('holds a suffixed audio directory by the name the job points at', () => {
    const name = `${ID}_retry`
    const dir = pending(name, STALE)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [job({ audioDir: join(root, name) })] })
    expect(existsSync(dir)).toBe(true)
  })

  it('leaves a directory younger than 12 hours alone', () => {
    const dir = pending(ID, PENDING_BATCH_STALE_MS - 1_000)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [] })
    expect(existsSync(dir)).toBe(true)
  })

  it('still retains a stale directory while a batch lease is held', () => {
    const dir = pending(ID, STALE)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: true, jobs: [] })
    expect(existsSync(dir)).toBe(true)
  })

  it('still removes an empty directory', () => {
    const dir = join(root, 'empty')
    mkdirSync(dir)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [] })
    expect(existsSync(dir)).toBe(false)
  })

  it('a directory name a job store would refuse is still swept, not skipped forever', () => {
    const dir = pending('odd.name', STALE)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [job()] })
    expect(existsSync(dir)).toBe(false)
  })

  it('an unreadable job date keeps the audio', () => {
    const dir = pending(ID, STALE)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [job({ createdAt: 'not a date' })] })
    expect(existsSync(dir)).toBe(true)
  })

  it('holds by session id when the job has lost its audio pointer', () => {
    const dir = pending(ID, STALE)
    sweepStalePendingBatch(root, { now: NOW, batchBusy: false, jobs: [job({ audioDir: null })] })
    expect(existsSync(dir)).toBe(true)
  })

  it('with no jobs passed it reads the real store under the data dir', async () => {
    const prior = process.env.COS_DATA_DIR
    process.env.COS_DATA_DIR = data
    try {
      vi.resetModules()
      const jobs = await import('./meeting-finalization-jobs.js')
      const retention = await import('./pending-batch-retention.js')
      const dir = pending(ID, STALE)
      const other = pending('mac_other-session', STALE)
      new jobs.MeetingFinalizationJobStore().save({ sessionId: ID, meetingPath: join(data, 'recordings', 'm.md'), sidecarPath: join(data, 'recordings', 'm.g2-chunks.json'), audioDir: dir, streamingWordCount: 1, phase: 'batch_pending', claimPending: false })
      // The store stamps createdAt with the real clock; sweep at that clock with both markers aged past it.
      const now = Date.now()
      for (const d of [dir, other]) { const at = (now - STALE) / 1000; utimesSync(join(d, '_batch_pending.marker'), at, at) }
      retention.sweepStalePendingBatch(root, { now, batchBusy: false })
      expect(existsSync(dir)).toBe(true)
      expect(existsSync(other)).toBe(false)
    } finally {
      if (prior === undefined) delete process.env.COS_DATA_DIR; else process.env.COS_DATA_DIR = prior
      vi.resetModules()
    }
  })
})

it('the cleanup timer sweeps through this module and has no loop of its own', () => {
  const route = readFileSync(new URL('../routes/transcribe-stream.ts', import.meta.url), 'utf8')
  expect(route.match(/sweepStalePendingBatch\(PENDING_BATCH_DIR, \{ now: Date\.now\(\), batchBusy \}\)/g)).toHaveLength(1)
  expect(route).not.toContain('Purged stale pending-batch')
})
