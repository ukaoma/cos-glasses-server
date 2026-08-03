// Quarantine for unsaved meeting audio.
//
// Until 6.19.0 the session-audio purge (boot sweep + 60s interval) DELETED any
// session-audio directory that was not in the in-memory sessions map and did
// not carry a fresh save-preserved marker. An offline meeting whose deferred
// save never landed therefore lost its full-fidelity audio within a minute of
// the server no longer tracking the session — two real meetings were destroyed
// this way on 2026-08-01. The only surviving fragments were in ext-audio,
// which is a speaker-enrollment store (unrecognized-speaker chunks, hard
// capped), not meeting audio.
//
// The rule now: audio evidence is moved here, never deleted in place. A
// quarantined capture is surfaced on /api/health (unsaved_captures) and can be
// driven to a durable scribe via POST /api/meeting/orphans/:sessionId/recover.
// Quarantine expires on a retention clock (default 72h) — long enough to
// survive a weekend away from the Mac, bounded enough not to grow forever.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'

export const QUARANTINE_MANIFEST = '_quarantine.json'
export const RECOVERED_RECEIPT = '_recovered.json'
const CHUNK_WAV_RE = /^chunk_\d{4}\.wav$/

const DEFAULT_RETENTION_HOURS = 72
const MIN_RETENTION_HOURS = 1
const MAX_RETENTION_HOURS = 720

export interface QuarantineManifest {
  schemaVersion: 1
  sessionId: string
  quarantinedAt: string
  reason: string
  chunkFiles: number
  bytes: number
}

export interface UnsavedCapture {
  sessionId: string
  dirName: string
  quarantinedAt: string | null
  ageHours: number | null
  chunkFiles: number
  bytes: number
  reason: string | null
  expiresAt: string | null
  recovered: boolean
}

export function unsavedAudioRoot(): string {
  return dataPath('unsaved-audio')
}

export function unsavedAudioRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_UNSAVED_AUDIO_RETENTION_HOURS)
  const hours = Number.isFinite(raw)
    ? Math.min(MAX_RETENTION_HOURS, Math.max(MIN_RETENTION_HOURS, raw))
    : DEFAULT_RETENTION_HOURS
  return hours * 60 * 60 * 1000
}

export function countChunkWavs(dirPath: string): number {
  try {
    return readdirSync(dirPath).filter(name => CHUNK_WAV_RE.test(name)).length
  } catch {
    return 0
  }
}

function dirBytes(dirPath: string): number {
  let total = 0
  try {
    for (const name of readdirSync(dirPath)) {
      try { total += statSync(join(dirPath, name)).size } catch { /* skip */ }
    }
  } catch { /* empty */ }
  return total
}

/** Move one session-audio dir into quarantine instead of deleting it.
 *  Returns the quarantine path, or null when the move could not be made
 *  (in which case the SOURCE IS LEFT IN PLACE — never deleted on failure). */
export function quarantineSessionAudio(
  sourceDir: string,
  reason: string,
  root: string = unsavedAudioRoot(),
): string | null {
  const sessionId = basename(sourceDir)
  try {
    if (!existsSync(sourceDir)) return null
    mkdirSync(root, { recursive: true, mode: 0o700 })
    let target = resolve(root, sessionId)
    if (existsSync(target)) target = resolve(root, `${sessionId}.${Date.now()}`)
    renameSync(sourceDir, target)
    const manifest: QuarantineManifest = {
      schemaVersion: 1,
      sessionId,
      quarantinedAt: new Date().toISOString(),
      reason,
      chunkFiles: countChunkWavs(target),
      bytes: dirBytes(target),
    }
    try {
      writeFileSync(resolve(target, QUARANTINE_MANIFEST), `${JSON.stringify(manifest)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    } catch { /* manifest is observability; the audio move already succeeded */ }
    return target
  } catch {
    // Rename failed (cross-device, permissions, race). Leave the source alone —
    // a skipped purge is recoverable, a deleted capture is not.
    return null
  }
}

export type OrphanSweepAction =
  | { dir: string; action: 'kept_live' }
  | { dir: string; action: 'kept_preserved' }
  | { dir: string; action: 'quarantined'; target: string }
  | { dir: string; action: 'quarantine_failed' }
  | { dir: string; action: 'deleted_empty' }

/** Shared sweep for the boot path and the 60s interval. A directory that
 *  still holds chunk audio is quarantined; only chunk-less directories are
 *  deleted. A failed quarantine move keeps the source in place. */
export function sweepOrphanedSessionAudio(
  sessionAudioRoot: string,
  opts: {
    isLive: (sessionId: string) => boolean
    hasFreshPreservedMarker: (dirPath: string) => boolean
    reason: string
    quarantineRoot?: string
  },
): OrphanSweepAction[] {
  const actions: OrphanSweepAction[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(sessionAudioRoot)
  } catch {
    return actions
  }
  for (const dir of entries) {
    const dirPath = resolve(sessionAudioRoot, dir)
    try {
      if (!statSync(dirPath).isDirectory()) continue
    } catch { continue }
    if (opts.isLive(dir)) { actions.push({ dir, action: 'kept_live' }); continue }
    if (opts.hasFreshPreservedMarker(dirPath)) { actions.push({ dir, action: 'kept_preserved' }); continue }
    if (countChunkWavs(dirPath) > 0) {
      const target = quarantineSessionAudio(dirPath, opts.reason, opts.quarantineRoot)
      actions.push(target
        ? { dir, action: 'quarantined', target }
        : { dir, action: 'quarantine_failed' })
      continue
    }
    try {
      rmSync(dirPath, { recursive: true, force: true })
      actions.push({ dir, action: 'deleted_empty' })
    } catch { /* next sweep retries */ }
  }
  return actions
}

function readManifest(dirPath: string): QuarantineManifest | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(dirPath, QUARANTINE_MANIFEST), 'utf8')) as QuarantineManifest
    if (raw?.schemaVersion !== 1 || typeof raw.sessionId !== 'string') return null
    return raw
  } catch {
    return null
  }
}

function quarantinedAtMs(dirPath: string, manifest: QuarantineManifest | null): number | null {
  if (manifest) {
    const parsed = Date.parse(manifest.quarantinedAt)
    if (Number.isFinite(parsed)) return parsed
  }
  try {
    return statSync(dirPath).mtimeMs
  } catch {
    return null
  }
}

/** Everything currently in quarantine, newest first. Recovered captures are
 *  flagged (they linger until the retention clock clears them) so health can
 *  exclude them from the actionable count. */
export function listUnsavedCaptures(
  root: string = unsavedAudioRoot(),
  retentionMs: number = unsavedAudioRetentionMs(),
): UnsavedCapture[] {
  const captures: UnsavedCapture[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return captures
  }
  for (const dir of entries) {
    const dirPath = resolve(root, dir)
    try {
      if (!statSync(dirPath).isDirectory()) continue
    } catch { continue }
    const manifest = readManifest(dirPath)
    const atMs = quarantinedAtMs(dirPath, manifest)
    captures.push({
      sessionId: manifest?.sessionId ?? dir.replace(/\.\d+$/, ''),
      dirName: dir,
      quarantinedAt: atMs != null ? new Date(atMs).toISOString() : null,
      ageHours: atMs != null ? Math.round(((Date.now() - atMs) / 3_600_000) * 10) / 10 : null,
      chunkFiles: manifest?.chunkFiles ?? countChunkWavs(dirPath),
      bytes: manifest?.bytes ?? dirBytes(dirPath),
      reason: manifest?.reason ?? null,
      expiresAt: atMs != null ? new Date(atMs + retentionMs).toISOString() : null,
      recovered: existsSync(resolve(dirPath, RECOVERED_RECEIPT)),
    })
  }
  captures.sort((a, b) => (b.quarantinedAt ?? '').localeCompare(a.quarantinedAt ?? ''))
  return captures
}

/** Retention: quarantined captures past the clock are removed. This is the
 *  ONLY place quarantined audio is ever deleted. */
export function purgeExpiredQuarantine(
  root: string = unsavedAudioRoot(),
  retentionMs: number = unsavedAudioRetentionMs(),
): string[] {
  const purged: string[] = []
  for (const capture of listUnsavedCaptures(root, retentionMs)) {
    const atMs = capture.quarantinedAt ? Date.parse(capture.quarantinedAt) : NaN
    if (!Number.isFinite(atMs)) continue
    if (Date.now() - atMs > retentionMs) {
      try {
        rmSync(resolve(root, capture.dirName), { recursive: true, force: true })
        purged.push(capture.dirName)
      } catch { /* next sweep retries */ }
    }
  }
  return purged
}

/** Resolve the quarantine dir for a sessionId (exact dir or timestamp-suffixed). */
export function findQuarantineDir(
  sessionId: string,
  root: string = unsavedAudioRoot(),
): string | null {
  const exact = resolve(root, sessionId)
  if (existsSync(exact)) return exact
  try {
    for (const dir of readdirSync(root)) {
      if (dir === sessionId || dir.startsWith(`${sessionId}.`)) {
        const dirPath = resolve(root, dir)
        if (statSync(dirPath).isDirectory()) return dirPath
      }
    }
  } catch { /* fall through */ }
  return null
}

export function markRecovered(dirPath: string, savedFilename: string): void {
  try {
    writeFileSync(
      resolve(dirPath, RECOVERED_RECEIPT),
      `${JSON.stringify({ schemaVersion: 1, recoveredAt: new Date().toISOString(), savedFilename })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  } catch { /* receipt is best-effort; findBySessionId remains the true guard */ }
}
