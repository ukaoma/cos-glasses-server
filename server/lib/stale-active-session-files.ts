// Active-session files the server no longer owns.
//
// THE INCIDENT (2026-10-12, server 6.71.11). `active-sessions/<id>.json` is written by
// the chunk route while a capture is live, and removed when the session closes. A
// capture of two silent chunks was persisted, then the server restarted behind a
// closed startup maintenance gate. Boot recovery was gated on admissions being open
// and never ran once the controller released the gate, so the file was neither
// adopted into the in-memory session map nor tombstoned. The audio was quarantined,
// recovered and receipted no_speech, and the file stayed: COS Control lists the
// directory directly and showed "Live now ... No audio for 1054m" for 17 hours, and
// the status route answered `missing`.
//
// The deferred recovery fix in routes/transcribe-stream.ts closes that door. This
// sweep is the backstop for any other door: a file whose session is not live and
// that has been idle past the retention horizon is moved aside, never deleted in
// place, with a reason written next to it. The horizon is the same one the session
// itself would be promoted or tombstoned at, so this can never act earlier than the
// server's own definition of "done".

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const STALE_ACTIVE_SESSION_DIR_NAME = 'stale-active-session-files'

/** Moved files carry transcript text, so they are not kept forever either. */
export const STALE_ACTIVE_SESSION_FILE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type StaleActiveSessionReason =
  /** Not in the live session map and idle past the retention horizon. */
  | 'not_live_idle_expired'
  /** Boot recovery found the capture already quarantined, recovered or receipted. */
  | 'terminal_capture'

export interface StaleActiveSessionMove {
  sessionId: string
  reason: StaleActiveSessionReason
  target: string
  lastActivityAt: number | null
  idleMs: number | null
}

const SESSION_FILE_RE = /^([A-Za-z0-9:_-]{3,96})\.json$/
const REASON_SUFFIX = '.reason.json'

/** lastActivityAt from the file, else its mtime; null when neither can be read. */
export function activeSessionFileActivity(filePath: string): number | null {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as { lastActivityAt?: unknown }
    if (typeof data?.lastActivityAt === 'number' && Number.isFinite(data.lastActivityAt)) return data.lastActivityAt
  } catch { /* fall back to mtime: a torn or legacy file still has an age */ }
  try {
    const { mtimeMs } = statSync(filePath)
    return Number.isFinite(mtimeMs) ? mtimeMs : null
  } catch {
    return null
  }
}

/**
 * Move one active-session file into the stale directory with a reason beside it.
 * Returns the new path, or null when the move failed (the source then stays put).
 */
export function moveActiveSessionFileAside(
  sourcePath: string,
  sessionId: string,
  targetDir: string,
  reason: StaleActiveSessionReason,
  now: number,
  detail: { lastActivityAt: number | null; note?: string } = { lastActivityAt: null },
): string | null {
  try {
    if (!existsSync(sourcePath)) return null
    mkdirSync(targetDir, { recursive: true, mode: 0o700 })
    const base = `${sessionId}.${now}`
    const target = resolve(targetDir, `${base}.json`)
    renameSync(sourcePath, target)
    // A rename keeps the old mtime, and the purge below ages files by mtime. Without
    // this a file idle for longer than the retention would be purged on the next tick,
    // which would make the "move, not delete" rule a delete with one minute's delay.
    try { const at = new Date(now); utimesSync(target, at, at) } catch { /* best effort: the file is still moved, not deleted */ }
    const reasonPath = resolve(targetDir, `${base}${REASON_SUFFIX}`)
    try {
      writeFileSync(reasonPath, `${JSON.stringify({
        schemaVersion: 1,
        sessionId,
        reason,
        movedAt: new Date(now).toISOString(),
        lastActivityAt: detail.lastActivityAt != null ? new Date(detail.lastActivityAt).toISOString() : null,
        ...(detail.note ? { note: detail.note } : {}),
      })}\n`, { encoding: 'utf8', mode: 0o600 })
      // Same clock as the moved file, so the pair ages out together.
      const at = new Date(now)
      utimesSync(reasonPath, at, at)
    } catch { /* the reason is observability; the move already happened */ }
    return target
  } catch {
    return null
  }
}

/**
 * One pass over the active-sessions directory. A file is moved aside only when its
 * session is NOT live and it has been idle for at least `idleRetentionMs`. A live
 * session's file is never touched, however old it looks.
 */
export function sweepStaleActiveSessionFiles(opts: {
  dir: string
  targetDir: string
  isLive: (sessionId: string) => boolean
  now: number
  idleRetentionMs: number
}): StaleActiveSessionMove[] {
  const moves: StaleActiveSessionMove[] = []
  let entries: string[]
  try { entries = readdirSync(opts.dir) } catch { return moves }
  for (const name of entries) {
    const match = SESSION_FILE_RE.exec(name)
    if (!match) continue
    const sessionId = match[1]
    if (opts.isLive(sessionId)) continue
    const filePath = resolve(opts.dir, name)
    const lastActivityAt = activeSessionFileActivity(filePath)
    if (lastActivityAt == null) continue
    const idleMs = opts.now - lastActivityAt
    if (idleMs < opts.idleRetentionMs) continue
    const target = moveActiveSessionFileAside(filePath, sessionId, opts.targetDir, 'not_live_idle_expired', opts.now, {
      lastActivityAt,
    })
    if (target) moves.push({ sessionId, reason: 'not_live_idle_expired', target, lastActivityAt, idleMs })
  }
  return moves
}

/** Remove moved files (and their reasons) older than the retention. Returns the count. */
export function purgeExpiredStaleActiveSessionFiles(
  targetDir: string,
  now: number,
  retentionMs: number = STALE_ACTIVE_SESSION_FILE_RETENTION_MS,
): number {
  let removed = 0
  let entries: string[]
  try { entries = readdirSync(targetDir) } catch { return 0 }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const path = resolve(targetDir, name)
    try {
      if (now - statSync(path).mtimeMs <= retentionMs) continue
      rmSync(path, { force: true })
      removed++
    } catch { /* next sweep retries */ }
  }
  return removed
}
