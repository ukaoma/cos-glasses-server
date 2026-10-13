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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'

export const STALE_ACTIVE_SESSION_DIR_NAME = 'stale-active-session-files'

/** Moved files carry transcript text, so they are not kept forever either. */
export const STALE_ACTIVE_SESSION_FILE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type StaleActiveSessionReason =
  /** Not in the live session map and idle past the retention horizon. */
  | 'not_live_idle_expired'
  /** Boot recovery found the capture already recovered or receipted no_speech. */
  | 'terminal_capture'

export interface StaleActiveSessionMove {
  sessionId: string
  reason: StaleActiveSessionReason
  /** Where the file went, or null when the move failed and the file stayed put. */
  target: string | null
  lastActivityAt: number | null
  idleMs: number | null
}

const SESSION_FILE_RE = /^([A-Za-z0-9:_-]{3,96})\.json$/
/** `<id>.<move ms>[-n].json` and its `.reason.json`. The move time is in the NAME. */
const MOVED_FILE_RE = /^[A-Za-z0-9:_-]{3,96}\.(\d{13})(?:-\d+)?(?:\.reason)?\.json$/
const REASON_SUFFIX = '.reason.json'

/**
 * When the session in this file was last active, for staleness: the EARLIER of its
 * own `lastActivityAt` and the file's mtime. The file is rewritten on every accepted
 * chunk, so its mtime is a true upper bound; a future-dated or corrupt
 * `lastActivityAt` therefore cannot pin a dead file forever. Null when neither can
 * be read.
 */
export function activeSessionFileActivity(filePath: string): number | null {
  let mtimeMs: number | null = null
  try {
    const stat = statSync(filePath)
    if (Number.isFinite(stat.mtimeMs)) mtimeMs = stat.mtimeMs
  } catch { /* fall through: a missing file has no age */ }
  let recorded: number | null = null
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as { lastActivityAt?: unknown }
    if (typeof data?.lastActivityAt === 'number' && Number.isFinite(data.lastActivityAt)) recorded = data.lastActivityAt
  } catch { /* torn or legacy file: the mtime still gives it an age */ }
  if (recorded == null) return mtimeMs
  if (mtimeMs == null) return recorded
  return Math.min(recorded, mtimeMs)
}

/**
 * Move one active-session file into the stale directory. The reason is written
 * FIRST and atomically, so a moved file never exists without its reason; if the
 * reason cannot be written nothing is moved. Returns the new path, or null when the
 * move did not happen (the source then stays exactly where it was).
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
    // Two moves in the same millisecond must not overwrite each other.
    let base = `${sessionId}.${now}`
    for (let n = 1; existsSync(resolve(targetDir, `${base}.json`)) || existsSync(resolve(targetDir, `${base}${REASON_SUFFIX}`)); n++) {
      base = `${sessionId}.${now}-${n}`
    }
    const target = resolve(targetDir, `${base}.json`)
    atomicWriteFileSync(resolve(targetDir, `${base}${REASON_SUFFIX}`), `${JSON.stringify({
      schemaVersion: 1,
      sessionId,
      reason,
      movedAt: new Date(now).toISOString(),
      lastActivityAt: detail.lastActivityAt != null ? new Date(detail.lastActivityAt).toISOString() : null,
      ...(detail.note ? { note: detail.note } : {}),
    })}\n`, { mode: 0o600 })
    renameSync(sourcePath, target)
    return target
  } catch {
    return null
  }
}

/**
 * One pass over the active-sessions directory. A file is moved aside only when its
 * session is NOT live and it has been idle for at least `idleRetentionMs`. A live
 * session's file is never touched, however old it looks. A failed move is returned
 * with `target: null` so the caller can say so.
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
    // The mtime bound inside activeSessionFileActivity is what defeats a
    // future-dated value. A further min(..., now) would change no decision: a
    // future activity is negative idle, and zero idle is just as far from the horizon.
    const lastActivityAt = activeSessionFileActivity(filePath)
    if (lastActivityAt == null) continue
    const idleMs = opts.now - lastActivityAt
    if (idleMs < opts.idleRetentionMs) continue
    const target = moveActiveSessionFileAside(filePath, sessionId, opts.targetDir, 'not_live_idle_expired', opts.now, {
      lastActivityAt,
    })
    moves.push({ sessionId, reason: 'not_live_idle_expired', target, lastActivityAt, idleMs })
  }
  return moves
}

/**
 * Remove moved files (and their reasons) whose move time, read from the file NAME,
 * is older than the retention. Ages never come from mtime: a rename keeps the old
 * mtime, which would turn "move" into "delete a minute later". A name that does not
 * carry a move time is never removed. Returns the count removed.
 */
export function purgeExpiredStaleActiveSessionFiles(
  targetDir: string,
  now: number,
  retentionMs: number = STALE_ACTIVE_SESSION_FILE_RETENTION_MS,
): number {
  let removed = 0
  let entries: string[]
  try { entries = readdirSync(targetDir) } catch { return 0 }
  for (const name of entries) {
    const match = MOVED_FILE_RE.exec(name)
    if (!match) continue
    if (now - Number(match[1]) <= retentionMs) continue
    try {
      rmSync(resolve(targetDir, name), { force: true })
      removed++
    } catch { /* next sweep retries */ }
  }
  return removed
}
