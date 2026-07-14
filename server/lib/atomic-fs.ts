// Atomic file writes — `writeFileSync` is NOT atomic. Process kill / power
// loss / disk-full / iCloud-sync-mid-write can leave the file truncated or
// corrupt. POSIX `rename` IS atomic (same filesystem), so writing to a `.tmp`
// then renaming guarantees readers always see the old full file or the new
// full file, never a torn middle state.
//
// Use for sessions.json, archive/*.json, and any other durable JSON we can't
// afford to lose.

import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs'

export function atomicWriteFileSync(path: string, data: string | Buffer, options: { mode?: number } = {}): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, options.mode === undefined ? undefined : { mode: options.mode })
  renameSync(tmp, path)
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
