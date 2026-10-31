// How long a saved meeting's pending HQ audio stays in pending-batch.
//
// A directory is stale 12 hours after its _batch_pending.marker was last refreshed, and normally
// goes then. A saved meeting still waiting on HQ is the exception: deleting its audio finishes the
// job on streaming text the next time it resumes, which made "audio is preserved for retry" untrue
// (2026-10-16 and 2026-10-29). It keeps its audio until a person or a fix can finish it, and for a
// bounded time, so one job that can never finish does not hold disk forever.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { MeetingFinalizationJobStore, type MeetingFinalizationJob } from './meeting-finalization-jobs.js'

export const PENDING_BATCH_STALE_MS = 12 * 60 * 60 * 1000
export const WAITING_JOB_AUDIO_HOLD_MS = 30 * 24 * 60 * 60 * 1000

/** Directory names of meetings still waiting on HQ, inside the hold. */
export function pendingBatchDirsHeldForJobs(jobs: readonly MeetingFinalizationJob[], now: number): Set<string> {
  const held = new Set<string>()
  for (const job of jobs) {
    if (job.phase !== 'batch_pending') continue
    // An unreadable date cannot prove the hold ended, so the audio stays.
    const created = Date.parse(job.createdAt)
    if (Number.isFinite(created) && now - created > WAITING_JOB_AUDIO_HOLD_MS) continue
    held.add(job.sessionId)
    if (job.audioDir) held.add(basename(job.audioDir))
  }
  return held
}

export function sweepStalePendingBatch(root: string, options: {
  now: number
  batchBusy: boolean
  jobs?: readonly MeetingFinalizationJob[]
}): void {
  const held = pendingBatchDirsHeldForJobs(options.jobs ?? new MeetingFinalizationJobStore().list(), options.now)
  for (const dir of readdirSync(root)) {
    const dirPath = resolve(root, dir)
    try {
      const files = readdirSync(dirPath)
      if (files.length === 0) { rmSync(dirPath, { recursive: true, force: true }); continue }
      // Prefer the marker file mtime over first chunk mtime
      const markerPath = resolve(dirPath, '_batch_pending.marker')
      // Fallback for pre-v5.4.3 dirs: use directory ctime (changes on rename)
      const ageSource = existsSync(markerPath) ? statSync(markerPath).mtimeMs : statSync(dirPath).ctimeMs
      if (options.now - ageSource <= PENDING_BATCH_STALE_MS) continue
      if (held.has(dir)) {
        console.warn(`[cleanup] Retaining pending-batch for a saved meeting waiting on HQ: ${dir}`)
        continue
      }
      if (options.batchBusy) {
        console.warn(`[cleanup] Retaining stale pending-batch while batch lease held: ${dir}`)
        continue
      }
      rmSync(dirPath, { recursive: true, force: true })
      console.log(`[cleanup] Purged stale pending-batch: ${dir}`)
    } catch {}
  }
}
