// Meeting HQ polish progress for COS Control / health.
// Written next to pending-batch audio so a draining Update can show % complete
// instead of a silent "degraded" row while Whisper chews through a long save.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dataPath } from './data-dir.js'

export const BATCH_PROGRESS_FILENAME = '_batch_progress.json'
export const BATCH_PENDING_MARKER = '_batch_pending.marker'
export const BATCH_TERMINAL_FILENAME = '_batch_terminal.json'

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
  /** Batches that reached a terminal outcome but whose WAVs are deliberately
   *  retained for retry (rejected quality, failed persist). Additive field —
   *  older consumers ignore it. Never counts toward active/blocksRestart. */
  retained: MeetingSyncRetainedMeeting[]
}

export type MeetingBatchOutcome = 'accepted' | 'rejected' | 'failed'

export interface MeetingBatchTerminal {
  schemaVersion: 1
  meetingId: string
  outcome: MeetingBatchOutcome
  reason?: string
  at: string
}

export interface MeetingSyncRetainedMeeting {
  meetingId: string
  outcome: MeetingBatchOutcome
  reason: string | null
  chunkFiles: number
  at: string
  label: string
}

/** Record the batch's terminal outcome next to its retained WAVs. Before this
 *  file existed (≤6.18.8), a rejected batch's dir kept rendering as active
 *  "HQ polish · N chunks" with blocksRestart:true for the full 12h retention —
 *  the status conflated "work running" with "evidence retained". */
export function writeMeetingBatchTerminal(
  audioDir: string,
  input: { outcome: MeetingBatchOutcome; reason?: string; meetingId?: string },
): void {
  const payload: MeetingBatchTerminal = {
    schemaVersion: 1,
    meetingId: input.meetingId ?? basename(audioDir),
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    at: new Date().toISOString(),
  }
  try {
    writeFileSync(join(audioDir, BATCH_TERMINAL_FILENAME), `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch {
    // Status only — never fail the pipeline for a status write.
  }
}

/** A retry invalidates the previous terminal state. */
export function clearMeetingBatchTerminal(audioDir: string): void {
  const path = join(audioDir, BATCH_TERMINAL_FILENAME)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch { /* ignore */ }
}

function readTerminalFile(dir: string): MeetingBatchTerminal | null {
  const path = join(dir, BATCH_TERMINAL_FILENAME)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as MeetingBatchTerminal
    if (raw?.schemaVersion !== 1) return null
    if (raw.outcome !== 'accepted' && raw.outcome !== 'rejected' && raw.outcome !== 'failed') return null
    return raw
  } catch {
    return null
  }
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

/** Public read for surfaces outside this module (orphan recovery progress). */
export function readMeetingBatchProgress(dir: string): MeetingBatchProgress | null {
  return readProgressFile(dir)
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
  const retained: MeetingSyncRetainedMeeting[] = []
  if (!existsSync(root)) {
    return { active: false, percent: null, label: 'Idle', blocksRestart: false, meetings, retained }
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
    return { active: false, percent: null, label: 'Idle', blocksRestart: false, meetings, retained }
  }

  for (const name of dirs) {
    const dir = join(root, name)
    const progress = readProgressFile(dir)
    let chunkFiles = 0
    try {
      chunkFiles = readdirSync(dir).filter(f => f.endsWith('.wav')).length
    } catch { /* ignore */ }

    // A terminal outcome ends the meeting's ACTIVE life. Its WAVs stay for
    // retry, reported as retained — never as running work. The gate is
    // progress==null ONLY: the pending marker is refreshed every segment and
    // every 60s during the run, so it is always fresh the moment a terminal
    // is written — gating on marker freshness left the phantom alive for the
    // first 15 minutes, exactly the post-meeting Update Server window. A
    // genuine retry clears the terminal first (runMeetingBatchPipeline) and
    // immediately writes queued progress, so progress presence is the true
    // live signal.
    const terminal = readTerminalFile(dir)
    if (terminal && progress == null) {
      const reasonSuffix = terminal.reason ? `: ${terminal.reason}` : ''
      retained.push({
        meetingId: terminal.meetingId || name,
        outcome: terminal.outcome,
        reason: terminal.reason ?? null,
        chunkFiles,
        at: terminal.at,
        label: `Retained (${terminal.outcome}${reasonSuffix}) · ${chunkFiles} chunk${chunkFiles === 1 ? '' : 's'}`,
      })
      continue
    }

    // Backfill: a dir with WAVs, no progress, no fresh marker, and NO terminal
    // file is a batch that ended before 6.19.0 existed (or whose terminal
    // write failed). Pre-6.19.0 semantics rendered these as phantom active
    // work with blocksRestart for the rest of the 12h retention — and the
    // first boot after an upgrade is exactly when the user watches COS
    // Control. Classify them as retained with an honest unknown outcome.
    if (progress == null && !markerFresh(dir) && chunkFiles > 0) {
      retained.push({
        meetingId: name,
        outcome: 'failed',
        reason: 'pre-terminal batch (ended before 6.19.0 or terminal write lost)',
        chunkFiles,
        at: new Date(0).toISOString(),
        label: `Retained (unknown outcome) · ${chunkFiles} chunk${chunkFiles === 1 ? '' : 's'}`,
      })
      continue
    }

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
    const label = retained.length > 0
      ? `Idle · ${retained.length} retained batch${retained.length === 1 ? '' : 'es'}`
      : 'Idle'
    return { active: false, percent: null, label, blocksRestart: false, meetings, retained }
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
    retained,
  }
}
