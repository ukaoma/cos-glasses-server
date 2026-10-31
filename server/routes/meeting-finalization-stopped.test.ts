// 6.97.0: a saved meeting's finalization that has stopped trying must not hold Restart, Update Server or
// Sync now. COS Control disables all three on `meeting_sync.active`, `meeting_sync.blocksRestart` and
// `capabilities.meetingLifecycle.finalization.pending`, so each is asserted, in both directions: a job
// that is working still blocks. Real pipeline wiring, real stores in a scratch data home; the decode is faked.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SHARED = vi.hoisted(() => {
  const shared = { dataDir: process.env.COS_DATA_DIR, profile: process.env.COS_PROFILE_PATH }
  process.env.COS_DATA_DIR = `${shared.dataDir ?? '/tmp'}/private-finalization-stopped-${process.pid}-${Math.random().toString(36).slice(2)}`
  process.env.COS_PROFILE_PATH = `${process.env.COS_DATA_DIR}/.cos-profile.json`
  return shared
})
afterAll(() => {
  rmSync(process.env.COS_DATA_DIR!, { recursive: true, force: true })
  for (const [key, value] of [['COS_DATA_DIR', SHARED.dataDir], ['COS_PROFILE_PATH', SHARED.profile]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

import { resumeMeetingFinalizationJobs, scheduleFinalizationJob } from './meeting.js'
import { FINALIZATION_STOPPED_RETRY_MS, getMeetingFinalizationSnapshot, MeetingFinalizationJobStore, type MeetingFinalizationJob } from '../lib/meeting-finalization-jobs.js'
import { BATCH_PROGRESS_FILENAME, getMeetingSyncSnapshot } from '../lib/meeting-batch-progress.js'
import { sweepStalePendingBatch, PENDING_BATCH_STALE_MS } from '../lib/pending-batch-retention.js'
import { maintenanceLifecycle } from '../lib/maintenance-lifecycle.js'
import { dataPath } from '../lib/data-dir.js'

const NOW = Date.parse('2026-10-31T17:00:00.000Z')
const jobs = () => new MeetingFinalizationJobStore()
let n = 0

function savedJob(over: Partial<MeetingFinalizationJob> = {}): MeetingFinalizationJob {
  const sessionId = `meeting_1700000000000_stop${++n}`
  const audioDir = dataPath('pending-batch', sessionId)
  const recordings = dataPath('recordings')
  mkdirSync(audioDir, { recursive: true })
  mkdirSync(recordings, { recursive: true })
  writeFileSync(join(audioDir, 'chunk_0000.wav'), 'audio')
  writeFileSync(join(audioDir, 'chunk_0001.wav'), 'audio')
  const meetingPath = join(recordings, `${sessionId}.md`), sidecarPath = join(recordings, `${sessionId}.g2-chunks.json`)
  writeFileSync(meetingPath, '# Meeting\n\n## Transcript\n\nThe live words.\n')
  writeFileSync(sidecarPath, JSON.stringify({ sessionId, finalizationState: 'batch_pending', chunkEntries: [{ chunkIndex: 0, chunk: { text: 'The live words.', speaker: 'Me', elapsed: 0, similarity: 1 } }] }))
  return jobs().save({ sessionId, meetingPath, sidecarPath, audioDir, streamingWordCount: 3, phase: 'batch_pending', claimPending: false, ...over })
}

/** A decode that fails until told otherwise, or that holds until released. */
function decoder() {
  let release: ((value: unknown) => void) | null = null
  const fn = vi.fn(async () => {
    if (decoder.hold) await new Promise(resolve => { release = resolve })
    throw new Error('decode failed')
  })
  return { fn, release: () => release?.(undefined) }
}
decoder.hold = false

function runtime(run: unknown) {
  const background: Promise<void>[] = []
  return {
    background,
    value: {
      finalizationJobs: jobs(),
      runBatch: run as never,
      scheduleBackground: (task: Promise<void>) => { background.push(task) },
      transcriptCleanup: async () => {},
    } as any,
  }
}
const settle = async (r: ReturnType<typeof runtime>) => { await Promise.all(r.background.splice(0)); await vi.advanceTimersByTimeAsync(0) }
/** `safeToRestart` (routes/maintenance.ts) is managed, a valid proof, and no lease held. This is the lease. */
const leases = () => maintenanceLifecycle.snapshot({}).activeByKind.meeting_batch_finalization ?? 0
/** The three things COS Control's meetingWorkBlockingRestart reads. */
const lock = () => {
  const sync = getMeetingSyncSnapshot()
  const finalization = getMeetingFinalizationSnapshot()
  return { active: sync.active, blocksRestart: sync.blocksRestart, pending: finalization.pending }
}
const LOCKED = { active: true, blocksRestart: true, pending: 1 }
const UNLOCKED = { active: false, blocksRestart: false, pending: 0 }
const gate = (admit = true) => ({ admit: vi.fn(() => admit) }) as any
const resume = (r: ReturnType<typeof runtime>, over: Record<string, unknown> = {}) =>
  resumeMeetingFinalizationJobs({ finalizationJobs: r.value.finalizationJobs, gate: gate(), schedule: (job: MeetingFinalizationJob) => scheduleFinalizationJob(job, r.value), now: NOW, version: '6.97.0', ...over } as any)

beforeEach(() => {
  decoder.hold = false
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  rmSync(dataPath('meeting-finalization-jobs'), { recursive: true, force: true })
  rmSync(dataPath('pending-batch'), { recursive: true, force: true })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function exhaust(job: MeetingFinalizationJob): Promise<{ r: ReturnType<typeof runtime>; run: ReturnType<typeof decoder> }> {
  const run = decoder(), r = runtime(run.fn)
  scheduleFinalizationJob(job, r.value)
  await settle(r)
  await vi.advanceTimersByTimeAsync(60_000)
  await settle(r)
  await vi.advanceTimersByTimeAsync(120_000)
  await settle(r)
  return { r, run }
}

describe('a job that used up its retries', () => {
  it('still blocks while it is retrying: three attempts, 60 s and 120 s apart', async () => {
    const job = savedJob()
    const run = decoder(), r = runtime(run.fn)
    scheduleFinalizationJob(job, r.value)
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(1)
    expect(lock()).toEqual(LOCKED)
    expect(jobs().get(job.sessionId)!.stopped).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(2)
    expect(lock()).toEqual(LOCKED)
    await vi.advanceTimersByTimeAsync(120_000)
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(3)
    expect(lock()).toEqual(UNLOCKED)
  })
  it('then unlocks everything Control reads, and says what is true', async () => {
    const job = savedJob()
    const { run } = await exhaust(job)
    expect(lock()).toEqual(UNLOCKED)
    expect(leases()).toBe(0)
    const stored = jobs().get(job.sessionId)!
    expect(stored.stopped).toMatchObject({ reason: 'retries_exhausted' })
    expect(stored.lastError).toContain('decode failed')
    const sync = getMeetingSyncSnapshot()
    expect(sync.percent).toBeNull()
    expect(sync.meetings).toHaveLength(1)
    expect(sync.meetings[0]).toMatchObject({ meetingId: job.sessionId, phase: 'stopped', chunkFiles: 2, percent: null })
    expect(sync.label).toBe('HQ polish stopped · audio kept · retries later')
    expect(sync.meetings[0]!.label).toBe(sync.label)
    expect(sync.label).not.toMatch(/retrying|do not|syncing/i)
    const health = getMeetingFinalizationSnapshot()
    expect(health).toMatchObject({ pending: 0, failed: 0 })
    expect(sync.meetings.filter(m => m.phase === 'stopped')).toHaveLength(1)
    // Nothing is left running: no timer fires another attempt.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(run.fn).toHaveBeenCalledTimes(3)
  })
  it('keeps its audio and job file, and the sweep does not take them', async () => {
    const job = savedJob()
    await exhaust(job)
    expect(existsSync(join(job.audioDir!, 'chunk_0000.wav'))).toBe(true)
    // Past the 12 hours that would purge any other directory, and nothing else holds it.
    const later = Date.now() + PENDING_BATCH_STALE_MS + 60_000
    sweepStalePendingBatch(dataPath('pending-batch'), { now: later, batchBusy: false, jobs: jobs().list() })
    expect(existsSync(join(job.audioDir!, 'chunk_0000.wav'))).toBe(true)
    expect(jobs().get(job.sessionId)).not.toBeNull()
    // The same sweep does purge a directory no job holds, so the assertion above can fail.
    const loose = dataPath('pending-batch', 'no-job-holds-this')
    mkdirSync(loose, { recursive: true })
    writeFileSync(join(loose, 'chunk_0000.wav'), 'audio')
    sweepStalePendingBatch(dataPath('pending-batch'), { now: later, batchBusy: false, jobs: jobs().list() })
    expect(existsSync(loose)).toBe(false)
  })
  it('a progress file or fresh marker its last attempt left behind does not read as work', async () => {
    const job = savedJob()
    await exhaust(job)
    writeFileSync(join(job.audioDir!, BATCH_PROGRESS_FILENAME), JSON.stringify({ schemaVersion: 1, meetingId: job.sessionId, phase: 'hq_polish', segmentsDone: 1, segmentsTotal: 9, updatedAt: 'x', startedAt: 'x' }))
    writeFileSync(join(job.audioDir!, '_batch_pending.marker'), '')
    expect(lock()).toEqual(UNLOCKED)
    expect(getMeetingSyncSnapshot().meetings).toHaveLength(1)
  })
})

describe('an attempt that is running', () => {
  it('holds every lock, and the drain lease, for as long as it runs', async () => {
    decoder.hold = true
    const job = savedJob({ lastError: 'an earlier failure' })
    const run = decoder(), r = runtime(run.fn)
    resume(r)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.fn).toHaveBeenCalledTimes(1)
    expect(lock()).toEqual(LOCKED)
    expect(leases()).toBe(1)
    run.release()
    await settle(r)
    expect(lock()).toEqual(UNLOCKED)
    expect(leases()).toBe(0)
    expect(jobs().get(job.sessionId)!.stopped).toMatchObject({ reason: 'retries_exhausted' })
  })
  it('a job in the middle of being tried again is work: starting an attempt clears its stop', async () => {
    decoder.hold = true
    const job = savedJob()
    jobs().markStopped(jobs().get(job.sessionId)!, 'retries_exhausted', '6.96.9', new Date(NOW))
    expect(lock()).toEqual(UNLOCKED)
    const run = decoder(), r = runtime(run.fn)
    resume(r)
    await vi.advanceTimersByTimeAsync(0)
    expect(jobs().get(job.sessionId)!.stopped).toBeUndefined()
    expect(lock()).toEqual(LOCKED)
    run.release()
    await settle(r)
  })
  it('a job with no failure at all still blocks, as before', () => {
    savedJob()
    expect(lock()).toEqual(LOCKED)
    expect(getMeetingSyncSnapshot().label).toBe('HQ polish · pending handoff')
  })
  it('a stop this build cannot read does not unlock anything', () => {
    const job = savedJob()
    writeFileSync(join(dataPath('meeting-finalization-jobs'), `${job.sessionId}.json`), JSON.stringify({ ...jobs().get(job.sessionId), stopped: { reason: 'something-new', at: 'whenever' } }))
    expect(lock()).toEqual(LOCKED)
  })
  it('a stopped job beside a working one: the working one holds the lock and names the label, and both show', async () => {
    decoder.hold = true
    const stopped = savedJob()
    jobs().markStopped(jobs().get(stopped.sessionId)!, 'retries_exhausted', '6.97.0', new Date(NOW))
    const working = savedJob()
    const sync = getMeetingSyncSnapshot()
    expect(sync).toMatchObject({ active: true, blocksRestart: true, label: 'HQ polish · pending handoff' })
    expect(sync.meetings.map(m => [m.meetingId, m.phase])).toEqual([[working.sessionId, 'hq_polish'], [stopped.sessionId, 'stopped']])
    expect(getMeetingFinalizationSnapshot()).toMatchObject({ pending: 1 })
  })
})

describe('what a later start does with a stopped job', () => {
  const stoppedJob = (version: string | null, at: number) => {
    const job = savedJob({ lastError: 'decode failed' })
    return jobs().markStopped(jobs().get(job.sessionId)!, 'retries_exhausted', version, new Date(at))
  }
  it('the same version inside 6 hours: nothing runs, no lock, no timer, not counted by the boot gate', async () => {
    const job = stoppedJob('6.97.0', NOW - FINALIZATION_STOPPED_RETRY_MS + 60_000)
    const run = decoder(), r = runtime(run.fn), g = gate()
    resume(r, { gate: g })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(run.fn).not.toHaveBeenCalled()
    expect(g.admit).not.toHaveBeenCalled()
    expect(lock()).toEqual(UNLOCKED)
    expect(jobs().get(job.sessionId)!.stopped).toBeDefined()
  })
  it('6 hours on: exactly one attempt, no timers, then stopped again with a fresh clock', async () => {
    const job = stoppedJob('6.97.0', NOW - FINALIZATION_STOPPED_RETRY_MS)
    const before = jobs().get(job.sessionId)!.stopped!.at
    const run = decoder(), r = runtime(run.fn)
    resume(r)
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(1)
    expect(lock()).toEqual(UNLOCKED)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(run.fn).toHaveBeenCalledTimes(1)
    expect(jobs().get(job.sessionId)!.stopped!.at).not.toBe(before)
  })
  it('another server version, which may have the fix: tried at once', async () => {
    stoppedJob('6.96.9', NOW)
    const run = decoder(), r = runtime(run.fn)
    resume(r)
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(1)
  })
  it('a person\'s Retry of that one job runs at once', async () => {
    const job = stoppedJob('6.97.0', NOW)
    const run = decoder(), r = runtime(run.fn)
    resume(r, { sessionId: job.sessionId })
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(1)
  })
  it('a job that failed before this version wrote stops down: one attempt, then stopped', async () => {
    const job = savedJob({ lastError: 'failed on 6.96.4' })
    expect(lock()).toEqual(LOCKED)
    const run = decoder(), r = runtime(run.fn)
    resume(r)
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(1)
    expect(lock()).toEqual(UNLOCKED)
    expect(jobs().get(job.sessionId)!.stopped).toMatchObject({ reason: 'retries_exhausted' })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(run.fn).toHaveBeenCalledTimes(1)
  })
  it('a job interrupted with no failure keeps its full budget', async () => {
    savedJob()
    const run = decoder(), r = runtime(run.fn)
    resume(r)
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(1)
    expect(lock()).toEqual(LOCKED)
    await vi.advanceTimersByTimeAsync(60_000)
    await settle(r)
    expect(run.fn).toHaveBeenCalledTimes(2)
  })
  it('a job the boot gate parked for crash-looping: unlocked, says so, promises nothing', () => {
    const job = savedJob()
    const r = runtime(decoder().fn)
    resume(r, { gate: gate(false) })
    expect(lock()).toEqual(UNLOCKED)
    expect(jobs().get(job.sessionId)!.stopped).toMatchObject({ reason: 'crash_parked' })
    expect(getMeetingSyncSnapshot().label).toBe('HQ polish stopped after crashes · audio kept')
  })
  it('a parked job is the boot gate\'s call: the 6-hour clock does not hold it back', () => {
    const job = savedJob()
    jobs().markStopped(jobs().get(job.sessionId)!, 'crash_parked', '6.97.0', new Date(NOW))
    const g = gate(false)
    resume(runtime(decoder().fn), { gate: g })
    expect(g.admit).toHaveBeenCalledTimes(1)
  })
})

describe('what a stop records', () => {
  it('the server version that gave up, which is what lets a fixed version try at once', async () => {
    const saved = process.env.COS_SERVER_VERSION
    process.env.COS_SERVER_VERSION = '6.97.0'
    try {
      const job = savedJob()
      await exhaust(job)
      expect(jobs().get(job.sessionId)!.stopped!.version).toBe('6.97.0')
    } finally {
      if (saved === undefined) delete process.env.COS_SERVER_VERSION; else process.env.COS_SERVER_VERSION = saved
    }
  })
  it('stopping and starting again both keep the failure, so a crash mid-attempt still gets one try per start', () => {
    const job = savedJob({ lastError: 'decode failed' })
    jobs().markStopped(jobs().get(job.sessionId)!, 'retries_exhausted', null)
    expect(jobs().get(job.sessionId)).toMatchObject({ lastError: 'decode failed', stopped: { reason: 'retries_exhausted' } })
    jobs().clearStopped(job.sessionId)
    const cleared = jobs().get(job.sessionId)!
    expect(cleared.lastError).toBe('decode failed')
    expect(cleared.stopped).toBeUndefined()
  })
  it('a later save drops it, because any save is the job moving again', () => {
    const job = savedJob()
    const stopped = jobs().markStopped(jobs().get(job.sessionId)!, 'retries_exhausted', null)
    expect(stopped.stopped).toBeDefined()
    const { schemaVersion: _a, createdAt: _b, updatedAt: _c, stopped: _d, ...fields } = stopped
    expect(jobs().save(fields).stopped).toBeUndefined()
  })
})

describe('the fragment COS Control reads', () => {
  it('is exactly this for one stopped job', async () => {
    const job = savedJob()
    await exhaust(job)
    const sync = getMeetingSyncSnapshot()
    const { updatedAt: _ignored, ...row } = sync.meetings[0]!
    expect({ ...sync, meetings: [row] }).toEqual({
      active: false,
      percent: null,
      label: 'HQ polish stopped · audio kept · retries later',
      blocksRestart: false,
      meetings: [{ meetingId: job.sessionId, phase: 'stopped', percent: null, segmentsDone: null, segmentsTotal: null, chunkFiles: 2, label: 'HQ polish stopped · audio kept · retries later' }],
      retained: [],
    })
    const { lastError: _error, ...finalization } = getMeetingFinalizationSnapshot()
    expect(finalization).toEqual({ pending: 0, failed: 0, oldestUpdatedAt: null, malformed: 0 })
  })
  it('finalization keeps the keys older clients know: the stop shows in the rows, not as a new key', async () => {
    await exhaust(savedJob())
    expect(Object.keys(getMeetingFinalizationSnapshot())).toEqual(['pending', 'failed', 'oldestUpdatedAt', 'lastError', 'malformed'])
  })
})
