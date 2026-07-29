// Meeting HQ polish progress for COS Control / health.
// Written next to pending-batch audio so a draining Update can show % complete
// instead of a silent "degraded" row while Whisper chews through a long save.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dataPath } from './data-dir.js'

export const BATCH_PROGRESS_FILENAME = '_batch_progress.json'
export const BATCH_PENDING_MARKER = '_batch_pending.marker'

export type MeetingBatchPhase =
  | 'queued'
  | 'hq_polish'
  | 'quality_check'
  | 'persisting'
  | 'done'

export interface MeetingBatchProgress {
  schemaVersion: 1
  meetingId: string
  phase: MeetingBatchPhase
  segmentsDone: number
  segmentsTotal: number
  chunkFiles?: number
  updatedAt: string
  startedAt: string
}

export interface MeetingSyncMeeting {
  meetingId: string
  phase: MeetingBatchPhase | 'pending'
  percent: number | null
  segmentsDone: number | null
  segmentsTotal: number | null
  chunkFiles: number
  label: string
  updatedAt: string | null
}

export interface MeetingSyncSnapshot {
  active: boolean
  percent: number | null
  label: string
  blocksRestart: boolean
  meetings: MeetingSyncMeeting[]
}

function pendingBatchRoot(): string {
  return dataPath('pending-batch')
}

function clampPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

function labelFor(meeting: Omit<MeetingSyncMeeting, 'label'>): string {
  if (meeting.percent != null && meeting.segmentsTotal != null && meeting.segmentsTotal > 0) {
    return `HQ polish ${meeting.percent}% (${meeting.segmentsDone}/${meeting.segmentsTotal})`
  }
  if (meeting.chunkFiles > 0) {
    return `HQ polish · ${meeting.chunkFiles} chunk${meeting.chunkFiles === 1 ? '' : 's'}`
  }
  return 'HQ polish · pending'
}

export function writeMeetingBatchProgress(
  audioDir: string,
  input: {
    phase: MeetingBatchPhase
    segmentsDone: number
    segmentsTotal: number
    meetingId?: string
    startedAt?: string
  },
): void {
  const meetingId = input.meetingId ?? basename(audioDir)
  const path = join(audioDir, BATCH_PROGRESS_FILENAME)
  let startedAt = input.startedAt
  if (!startedAt && existsSync(path)) {
    try {
      const prior = JSON.parse(readFileSync(path, 'utf8')) as MeetingBatchProgress
      if (typeof prior.startedAt === 'string') startedAt = prior.startedAt
    } catch { /* replace */ }
  }
  const payload: MeetingBatchProgress = {
    schemaVersion: 1,
    meetingId,
    phase: input.phase,
    segmentsDone: Math.max(0, input.segmentsDone),
    segmentsTotal: Math.max(0, input.segmentsTotal),
    updatedAt: new Date().toISOString(),
    startedAt: startedAt ?? new Date().toISOString(),
  }
  try {
    const wavs = readdirSync(audioDir).filter(name => name.endsWith('.wav')).length
    payload.chunkFiles = wavs
  } catch { /* optional */ }
  try {
    writeFileSync(path, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Progress is observability only — never fail HQ polish for a status write.
  }
}

export function clearMeetingBatchProgress(audioDir: string): void {
  const path = join(audioDir, BATCH_PROGRESS_FILENAME)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch { /* ignore */ }
}

function readProgressFile(dir: string): MeetingBatchProgress | null {
  const path = join(dir, BATCH_PROGRESS_FILENAME)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as MeetingBatchProgress
    if (raw?.schemaVersion !== 1) return null
    if (typeof raw.meetingId !== 'string') return null
    if (typeof raw.segmentsTotal !== 'number' || typeof raw.segmentsDone !== 'number') return null
    return raw
  } catch {
    return null
  }
}

function markerFresh(dir: string, maxAgeMs = 15 * 60_000): boolean {
  const marker = join(dir, BATCH_PENDING_MARKER)
  if (!existsSync(marker)) return false
  try {
    return Date.now() - statSync(marker).mtimeMs <= maxAgeMs
  } catch {
    return false
  }
}

/** Snapshot of pending HQ polish work for /api/health and COS Control. */
export function getMeetingSyncSnapshot(
  root: string = pendingBatchRoot(),
): MeetingSyncSnapshot {
  const meetings: MeetingSyncMeeting[] = []
  if (!existsSync(root)) {
    return { active: false, percent: null, label: 'Idle', blocksRestart: false, meetings }
  }

  let dirs: string[] = []
  try {
    dirs = readdirSync(root).filter(name => {
      try {
        return statSync(join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return { active: false, percent: null, label: 'Idle', blocksRestart: false, meetings }
  }

  for (const name of dirs) {
    const dir = join(root, name)
    const progress = readProgressFile(dir)
    let chunkFiles = 0
    try {
      chunkFiles = readdirSync(dir).filter(f => f.endsWith('.wav')).length
    } catch { /* ignore */ }

    const active = markerFresh(dir) || progress != null
    if (!active && chunkFiles === 0) continue

    if (progress) {
      const percent = progress.segmentsTotal > 0
        ? clampPercent(progress.segmentsDone, progress.segmentsTotal)
        : null
      const row: Omit<MeetingSyncMeeting, 'label'> = {
        meetingId: progress.meetingId || name,
        phase: progress.phase,
        percent,
        segmentsDone: progress.segmentsTotal > 0 ? progress.segmentsDone : null,
        segmentsTotal: progress.segmentsTotal > 0 ? progress.segmentsTotal : null,
        chunkFiles: progress.chunkFiles ?? chunkFiles,
        updatedAt: progress.updatedAt,
      }
      meetings.push({ ...row, label: labelFor(row) })
      continue
    }

    if (!markerFresh(dir) && chunkFiles === 0) continue
    const row: Omit<MeetingSyncMeeting, 'label'> = {
      meetingId: name,
      phase: 'pending',
      percent: null,
      segmentsDone: null,
      segmentsTotal: null,
      chunkFiles,
      updatedAt: null,
    }
    meetings.push({ ...row, label: labelFor(row) })
  }

  if (meetings.length === 0) {
    return { active: false, percent: null, label: 'Idle', blocksRestart: false, meetings }
  }

  const withPercent = meetings.filter(m => m.percent != null)
  const percent = withPercent.length === meetings.length
    ? Math.round(withPercent.reduce((sum, m) => sum + (m.percent ?? 0), 0) / meetings.length)
    : null

  const label = meetings.length === 1
    ? meetings[0]!.label
    : `${meetings.length} meetings syncing` + (percent != null ? ` · ${percent}%` : '')

  return {
    active: true,
    percent,
    label,
    blocksRestart: true,
    meetings,
  }
}
