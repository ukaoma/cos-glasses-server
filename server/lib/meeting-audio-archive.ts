// Meeting audio kept long enough for a human to review who was speaking.
//
// WHY IT DID NOT EXIST. Chunk WAVs lived in `session-audio` only until a meeting
// was saved, then moved to `pending-batch` for HQ re-transcription and deleted
// when that finished. Measured 2026-08-06: `session-audio` held 0 files. So the
// review panel could show a phrase but never let anyone HEAR it, and its own
// copy said "naming this needs its audio, which is no longer held."
//
// Miles's decision: keep a week, so review can happen on a weekend rather than
// only within hours of the meeting, and stay under 8 GB.
//
// SIZING IS MEASURED, NOT GUESSED. Real recording volume over the 14 days to
// 2026-08-06 was 3.1 h/day mean, 6.9 h peak. A 7-day window is ~22 hours, which
// at 16 kHz mono 16-bit (32 KB/s) is ~2.5 GB — comfortably inside 8 GB. So the
// audio is kept UNCOMPRESSED and stays usable for re-transcription, not just
// playback. The cap is a runaway backstop: it would take a sustained 10 h/day
// week to reach it.
//
// HARD LINKS, NOT COPIES. Archiving happens at the moment audio moves to
// `pending-batch`, and links the same inodes rather than duplicating them. A
// copy would double disk for the whole batch window — 260 MB for a two-hour
// meeting — and introduce an ordering hazard against the batch purge. With links
// the pipeline can delete its directory whenever it likes and the bytes survive.

import {
  copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'

export const MEETING_AUDIO_DIR = 'meeting-audio'

/** One week, per Miles: review should survive until a weekend. */
export function meetingAudioTtlMs(): number {
  const raw = Number(process.env.COS_MEETING_AUDIO_RETENTION_DAYS)
  const days = Number.isFinite(raw) && raw > 0 ? raw : 7
  return days * 24 * 60 * 60 * 1000
}

/** Total budget for retained meeting audio. Miles: stay under 8 GB. */
export function meetingAudioMaxBytes(): number {
  const raw = Number(process.env.COS_MEETING_AUDIO_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : 8 * 1024 * 1024 * 1024
}

/** Master switch. Default ON — with it off, review has no audio at all. */
export function meetingAudioEnabled(): boolean {
  return process.env.COS_MEETING_AUDIO !== '0'
}

function sessionDir(sessionId: string): string | null {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return null
  const root = dataPath(MEETING_AUDIO_DIR)
  const path = join(root, sessionId.replace(/:/g, '_'))
  return resolve(path).startsWith(resolve(root) + '/') ? path : null
}

/** Chunk WAVs as written by the capture path (`chunk_0000.wav`). */
function isChunkWav(name: string): boolean {
  return /^chunk_\d+\.wav$/.test(name)
}

/** Derived playback copies count against the cap but never define retention age. */
function isDerivedPlaybackWav(name: string): boolean {
  return /^playback_v\d+_\d+\.wav$/.test(name)
}

export interface ArchiveResult {
  linked: number
  /** Files that had to be copied because the link failed (e.g. cross-device). */
  copied: number
  failed: number
  bytes: number
}

/**
 * Bring one session's chunk WAVs into the archive.
 *
 * Never throws: this runs on the save path, and losing review audio must never
 * cost a meeting. Individual failures are counted rather than aborting the rest,
 * because a partially-archived meeting is still partially reviewable.
 */
export function archiveSessionAudio(sessionId: string, sourceDir: string): ArchiveResult {
  const out: ArchiveResult = { linked: 0, copied: 0, failed: 0, bytes: 0 }
  if (!meetingAudioEnabled()) return out
  const dest = sessionDir(sessionId)
  if (!dest || !existsSync(sourceDir)) return out
  let names: string[]
  try {
    names = readdirSync(sourceDir).filter(isChunkWav)
  } catch {
    return out
  }
  if (names.length === 0) return out
  try {
    mkdirSync(dest, { recursive: true, mode: 0o700 })
  } catch {
    return out
  }
  for (const name of names) {
    const from = resolve(sourceDir, name)
    const to = resolve(dest, name)
    if (existsSync(to)) continue
    try {
      linkSync(from, to)
      out.linked++
    } catch {
      // A link can fail across filesystems or if the source vanished mid-sweep.
      // Copy rather than skip: the point is that the audio survives.
      try { copyFileSync(from, to); out.copied++ } catch { out.failed++; continue }
    }
    try { out.bytes += statSync(to).size } catch { /* counted as linked regardless */ }
  }
  return out
}

/** Bytes and age for one archived session. */
function sessionSize(dir: string): {
  bytes: number
  mtimeMs: number
  files: number
  derivedFiles: number
  otherEntries: number
  statFailures: number
  readable: boolean
} {
  let bytes = 0, mtimeMs = 0, files = 0, derivedFiles = 0
  let otherEntries = 0, statFailures = 0, readable = false
  try {
    const names = readdirSync(dir)
    readable = true
    for (const name of names) {
      if (!isChunkWav(name) && !isDerivedPlaybackWav(name)) {
        otherEntries++
        continue
      }
      try {
        const st = statSync(join(dir, name))
        bytes += st.size
        // A replay created six days after capture must not buy the raw evidence
        // another seven days. Only immutable raw chunks determine session age.
        if (isChunkWav(name)) {
          files++
          mtimeMs = Math.max(mtimeMs, st.mtimeMs)
        } else {
          derivedFiles++
        }
      } catch { statFailures++ }
    }
  } catch { /* unreadable dir reports zero */ }
  return { bytes, mtimeMs, files, derivedFiles, otherEntries, statFailures, readable }
}

export interface SweepResult {
  removed: string[]
  retained: string[]
  bytesFreed: number
}

/**
 * Drop sessions past the retention window.
 *
 * A session whose age cannot be read is RETAINED — treating an unreadable stat
 * as ancient would delete the audio a pending review depends on.
 */
export function sweepMeetingAudio(nowMs: number, ttlMs = meetingAudioTtlMs()): SweepResult {
  const root = dataPath(MEETING_AUDIO_DIR)
  const out: SweepResult = { removed: [], retained: [], bytesFreed: 0 }
  if (!existsSync(root)) return out
  let names: string[]
  try { names = readdirSync(root) } catch { return out }
  for (const name of names) {
    const dir = join(root, name)
    const { bytes, mtimeMs, files, derivedFiles, otherEntries, statFailures, readable } = sessionSize(dir)
    // Delete only a provably cache-only directory. Any unknown entry or failed
    // stat may be retained evidence, so ambiguity fails closed to preservation.
    if (readable && files === 0 && derivedFiles > 0 && otherEntries === 0 && statFailures === 0) {
      try { rmSync(dir, { recursive: true, force: true }); out.removed.push(name); out.bytesFreed += bytes }
      catch { out.retained.push(name) }
      continue
    }
    if (mtimeMs <= 0) { out.retained.push(name); continue }
    if (nowMs - mtimeMs > ttlMs) {
      try { rmSync(dir, { recursive: true, force: true }); out.removed.push(name); out.bytesFreed += bytes }
      catch { out.retained.push(name) }
    } else {
      out.retained.push(name)
    }
  }
  return out
}

export interface CapResult {
  evicted: string[]
  bytesBefore: number
  bytesAfter: number
}

/**
 * Evict OLDEST SESSIONS FIRST until the archive fits its budget.
 *
 * Whole sessions, not individual chunks: half a meeting's audio is a confusing
 * artefact, and predictable eviction beats squeezing in a few more megabytes.
 *
 * Note on accounting: while `pending-batch` still holds the same inodes, these
 * hard-linked files are counted at full size in BOTH places, so the total reads
 * high during the batch window. That is deliberately conservative — it can sweep
 * slightly early, never late.
 */
export function enforceMeetingAudioCap(maxBytes = meetingAudioMaxBytes()): CapResult {
  const root = dataPath(MEETING_AUDIO_DIR)
  const out: CapResult = { evicted: [], bytesBefore: 0, bytesAfter: 0 }
  if (!existsSync(root)) return out
  let names: string[]
  try { names = readdirSync(root) } catch { return out }

  const entries = names.map(name => ({ name, ...sessionSize(join(root, name)) }))
  out.bytesBefore = entries.reduce((n, e) => n + e.bytes, 0)
  out.bytesAfter = out.bytesBefore
  if (out.bytesAfter <= maxBytes) return out

  // Oldest first. A session with an unreadable mtime sorts LAST so it is evicted
  // only as a final resort, matching the sweeper's bias toward keeping evidence.
  entries.sort((a, b) => (a.mtimeMs || Number.MAX_SAFE_INTEGER) - (b.mtimeMs || Number.MAX_SAFE_INTEGER))
  for (const e of entries) {
    if (out.bytesAfter <= maxBytes) break
    try {
      rmSync(join(root, e.name), { recursive: true, force: true })
      out.evicted.push(e.name)
      out.bytesAfter -= e.bytes
    } catch { /* leave it counted; the next pass will try again */ }
  }
  return out
}

/** Absolute path to one chunk's WAV, or null when it is not retained. */
export function meetingAudioChunkPath(sessionId: string, chunkIndex: number): string | null {
  const dir = sessionDir(sessionId)
  if (!dir) return null
  // No integer guard: `chunkIndex` is a number, so the interpolation can never
  // contain a path separator, and a nonsense value simply names a file that does
  // not exist. Mutation confirmed an explicit check here is unreachable behind
  // the existence test below.
  const path = resolve(dir, `chunk_${String(chunkIndex).padStart(4, '0')}.wav`)
  if (!resolve(path).startsWith(resolve(dir) + '/')) return null
  return existsSync(path) ? path : null
}

/**
 * Fallback source: audio the capture path saved for an UNRECOGNISED speaker.
 *
 * `ext-audio/<sessionId>/ext_chunk<N>_<ts>.wav` is written live whenever the
 * identifier finds no match, and `<N>` is the same RAW capture index the review
 * addresses. Verified across 14 real meetings: 90-100% of these files correspond
 * to a chunk the sidecar labels `Ext`.
 *
 * This matters because the 7-day archive is FORWARD-ONLY — it starts filling
 * when a meeting is saved under 6.21.18, so on the day of that upgrade there is
 * nothing to play. ext-audio already holds the unidentified voices from the last
 * 72 hours, which is exactly the set a reviewer most needs to hear.
 *
 * Shorter window than the archive (72h vs 7 days), so the listing reports which
 * source a chunk came from rather than implying one retention rule.
 */
export function extAudioChunkPath(sessionId: string, chunkIndex: number): string | null {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return null
  const dir = join(dataPath('ext-audio'), sessionId.replace(/:/g, '_'))
  if (!resolve(dir).startsWith(resolve(dataPath('ext-audio')) + '/') || !existsSync(dir)) return null
  try {
    // Timestamped suffix, so match on the index and take the newest.
    const prefix = `ext_chunk${chunkIndex}_`
    const hits = readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith('.wav')).sort()
    const pick = hits[hits.length - 1]
    if (!pick) return null
    const path = resolve(dir, pick)
    return resolve(path).startsWith(resolve(dir) + '/') ? path : null
  } catch {
    return null
  }
}

/** Raw chunk indices this session has ext-audio for, ascending. */
export function listExtAudioChunks(sessionId: string): number[] {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return []
  const dir = join(dataPath('ext-audio'), sessionId.replace(/:/g, '_'))
  if (!existsSync(dir)) return []
  try {
    const out = new Set<number>()
    for (const n of readdirSync(dir)) {
      const m = /^ext_chunk(\d+)_.*\.wav$/.exec(n)
      if (m) out.add(Number(m[1]))
    }
    return [...out].sort((a, b) => a - b)
  } catch {
    return []
  }
}

/** Chunk indices retained for a session, ascending. */
export function listMeetingAudioChunks(sessionId: string): number[] {
  const dir = sessionDir(sessionId)
  if (!dir || !existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(isChunkWav)
      .map(n => Number(n.slice('chunk_'.length, -'.wav'.length)))
      .filter(n => Number.isInteger(n))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

/**
 * Cached stats for /api/health.
 *
 * The uncached walk statSyncs EVERY retained chunk: a 7-day window at the
 * measured rate is roughly 2,000-3,000 files, and COS Control polls health every
 * 12 seconds — thousands of synchronous stats on the same event loop that ingests
 * live audio. The sibling chunkEmbeddingStoreStats is one stat per session for
 * the same reason. A 30s cache keeps the number useful without the cost.
 */
let statsCache: { at: number; value: ReturnType<typeof computeMeetingAudioStats> } | null = null
const STATS_TTL_MS = 30_000

export function meetingAudioStats(): ReturnType<typeof computeMeetingAudioStats> {
  const now = Date.now()
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value
  const value = computeMeetingAudioStats()
  statsCache = { at: now, value }
  return value
}

/** Invalidate after a sweep or eviction so health does not report stale usage. */
export function invalidateMeetingAudioStats(): void {
  statsCache = null
}

/** Counts for /api/health, so retention can be seen rather than assumed. */
function computeMeetingAudioStats(): {
  enabled: boolean
  sessions: number
  bytes: number
  maxBytes: number
  retentionDays: number
  oldestAgeHours: number | null
} {
  const root = dataPath(MEETING_AUDIO_DIR)
  const retentionDays = Math.round((meetingAudioTtlMs() / (24 * 60 * 60 * 1000)) * 10) / 10
  const base = {
    enabled: meetingAudioEnabled(),
    maxBytes: meetingAudioMaxBytes(),
    retentionDays,
  }
  if (!existsSync(root)) return { ...base, sessions: 0, bytes: 0, oldestAgeHours: null }
  let sessions = 0, bytes = 0, oldest = Number.POSITIVE_INFINITY
  try {
    for (const name of readdirSync(root)) {
      const { bytes: b, mtimeMs, files } = sessionSize(join(root, name))
      if (files === 0) continue
      sessions++
      bytes += b
      if (mtimeMs > 0) oldest = Math.min(oldest, mtimeMs)
    }
  } catch { /* report what we have */ }
  return {
    ...base,
    sessions,
    bytes,
    oldestAgeHours: Number.isFinite(oldest) ? Math.round(((Date.now() - oldest) / 3_600_000) * 10) / 10 : null,
  }
}

/**
 * One retention pass: expire first, then enforce the budget.
 *
 * ORDER IS LOAD-BEARING and that is why this is a named function rather than two
 * calls inline in an interval. Enforcing the cap first would let it EVICT audio
 * that the sweeper was about to expire anyway — counting those bytes against the
 * budget and so evicting extra sessions that were still inside their window. Run
 * the other way round, the cap only ever sees audio a human could still want.
 */
/** Retention window in days — a pure config read, no filesystem. */
export function meetingAudioRetentionDays(): number {
  return Math.round((meetingAudioTtlMs() / (24 * 60 * 60 * 1000)) * 10) / 10
}

export function runMeetingAudioRetention(nowMs = Date.now()): {
  swept: SweepResult
  capped: CapResult
} {
  const swept = sweepMeetingAudio(nowMs)
  const capped = enforceMeetingAudioCap()
  // Usage just changed; do not let health report the pre-sweep figure.
  if (swept.removed.length > 0 || capped.evicted.length > 0) invalidateMeetingAudioStats()
  return { swept, capped }
}
