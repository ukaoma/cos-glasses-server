// Atomic file writes — `writeFileSync` is NOT atomic. Process kill / power
// loss / disk-full / iCloud-sync-mid-write can leave the file truncated or
// corrupt. POSIX `rename` IS atomic (same filesystem), so writing to a `.tmp`
// then renaming guarantees readers always see the old full file or the new
// full file, never a torn middle state.
//
// Use for sessions.json, archive/*.json, and any other durable JSON we can't
// afford to lose.

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export function atomicWriteFileSync(path: string, data: string | Buffer, options: { mode?: number } = {}): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, options.mode === undefined ? undefined : { mode: options.mode })
  renameSync(tmp, path)
}

/**
 * Publish private durable state without ever exposing a partially-written file.
 *
 * The existing `atomicWriteFileSync` intentionally remains lightweight for
 * high-frequency caches. Meeting finalization uses this stronger variant:
 * bytes and file metadata are fsync'd before rename, the destination mode is
 * forced after publish, and the containing directory is fsync'd where the
 * platform supports it. A randomized exclusive temp name also prevents two
 * independent writers from sharing `<path>.tmp`.
 */
export function durableAtomicWriteFileSync(
  path: string,
  data: string | Buffer,
  options: { mode?: number } = {},
): void {
  const mode = options.mode ?? 0o600
  const dir = dirname(path)
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  let fd: number | null = null

  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      mode,
    )
    writeFileSync(fd, data)
    fchmodSync(fd, mode)
    fsyncSync(fd)
    closeSync(fd)
    fd = null

    // The exclusive temp inode already has its final private mode. Apply chmod
    // before the commit so no failure can be reported after rename succeeded.
    renameSync(tmp, path)

    // Persist the directory entry as well as the file contents. Some virtual
    // filesystems do not support directory fsync; the already-fsync'd file and
    // atomic rename still provide the strongest available behavior there.
    let dirFd: number | null = null
    try {
      dirFd = openSync(dir, constants.O_RDONLY)
      fsyncSync(dirFd)
    } catch {
      // Best available durability on filesystems that reject directory fsync.
    } finally {
      if (dirFd !== null) {
        try { closeSync(dirFd) } catch { /* commit already succeeded */ }
      }
    }
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
    try { unlinkSync(tmp) } catch { /* publish may already have renamed it */ }
    throw error
  }
}

/**
 * Read + JSON.parse with explicit missing-vs-corrupt distinction.
 * - File missing: returns { status: 'missing' } — caller starts fresh silently
 * - Parse succeeds: returns { status: 'ok', data }
 * - Parse fails: quarantines the corrupt file (renames to `.corrupt-<ts>`),
 *   returns { status: 'corrupt', quarantinedAs } so the caller can log loudly
 */
export type LoadResult<T> =
  | { status: 'missing' }
  | { status: 'ok'; data: T }
  | { status: 'corrupt'; quarantinedAs: string; error: unknown }

export function loadJsonOrQuarantine<T>(path: string): LoadResult<T> {
  if (!existsSync(path)) return { status: 'missing' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    return { status: 'missing' } // permission / transient; caller decides
  }
  try {
    const data = JSON.parse(raw) as T
    return { status: 'ok', data }
  } catch (err) {
    const quarantinedAs = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, quarantinedAs)
    } catch {
      /* if rename fails we still want to surface the error */
    }
    return { status: 'corrupt', quarantinedAs, error: err }
  }
}
