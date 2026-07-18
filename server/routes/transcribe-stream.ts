// POST /api/transcribe-stream — Streaming transcription for continuous meeting capture
// Uses local Whisper (50ms) with OpenAI API fallback.
// Streams speaker-labeled transcript chunks for live meeting capture.

import { Router } from 'express'
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync, rmSync, renameSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getVocabulary, getOwnerName } from '../lib/profile.js'
import { getOpenAIKey } from '../lib/openai-key.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
import { emitDisplay } from '../lib/display-bus.js'
import { errMsg } from '../lib/utils.js'
import { transcribeLocal, isWhisperLocalAvailable, applyCorrections, type WhisperWord } from '../lib/whisper-local.js'
import { enhanceAudio } from '../lib/audio-enhance.js'
import { trimSilence, isSileroAvailable } from '../lib/vad-silero.js'
import { identifySpeaker, isEmbeddingAvailable, autoEnroll, getEmbeddingCount } from '../lib/speaker-embeddings.js'
import {
  assertOpenAIWhisperBudget,
  recordOpenAIWhisperUsage,
  estimateAudioSeconds,
  OpenAIWhisperBudgetExhaustedError,
} from '../lib/openai-whisper-budget.js'
import {
  stripInlineHallucinations as sharedStripInlineHallucinations,
  isFullHallucination as sharedIsFullHallucination,
  clearSessionHallucinationState,
  streamSilenceDropReason,
  isVocabEchoOnly,
} from '../lib/hallucination-filter.js'
import { dataPath } from '../lib/data-dir.js'
import { durableAtomicWriteFileSync } from '../lib/atomic-fs.js'
import {
  LOCAL_FIRST_MEETING_IDLE_RETENTION_MS,
  compressIndexRanges,
  retainedUntilIso,
  type IndexRange,
} from '../lib/local-first-meetings-contract.js'

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe private audio directory: ${path}`)
  }
  try { chmodSync(path, 0o700) } catch { /* individual writes still force 0600 */ }
}

// Silence-hallucination drops (2026-05-29, v5.9.73). Contract in streamSilenceDropReason:
//   brand-URL-only -> dropped ALWAYS (vocab-seeded, never real speech).
//   any-URL-only / repeated-thank-you -> dropped only when isQuiet (rms<150), so a real
//   softly-spoken utterance or a clearly-dictated third-party URL is never dropped.
// Rollback: COS_WHISPER_STRIP_BRAND_URLS=0 (URL drops), COS_WHISPER_THANKYOU_FILTER=0.
const STRIP_BRAND_URLS = process.env.COS_WHISPER_STRIP_BRAND_URLS !== '0'
const THANKYOU_FILTER = process.env.COS_WHISPER_THANKYOU_FILTER !== '0'

// Audio persistence: save G2-mic chunks for speakers who need more training data
const AUDIO_SAVE_DIR = dataPath('training-audio')
ensurePrivateDirectory(AUDIO_SAVE_DIR)
const MAX_SAVED_CHUNKS_PER_SPEAKER = 30  // ~5 min of audio per speaker, cleaned after training

// Unrecognized speaker audio: save Ext chunks for retroactive enrollment
const EXT_AUDIO_DIR = dataPath('ext-audio')
ensurePrivateDirectory(EXT_AUDIO_DIR)
const EXT_AUDIO_TTL_MS = 72 * 60 * 60 * 1000  // 72-hour retention
const MAX_EXT_CHUNKS_PER_SESSION = 40  // cap per session to avoid runaway storage
const extAudioCounts = new Map<string, number>()  // sessionId → chunk count

// ── Hallucination filter — delegated to shared lib (server/lib/hallucination-filter.ts) ──
// Local wrappers preserve existing call-site signatures; shared lib is the single source
// of truth, also used by /api/transcribe (one-shot message query path).
function stripInlineHallucinations(text: string, sessionId: string): string {
  return sharedStripInlineHallucinations(text, sessionId)
}
function isServerHallucination(text: string): boolean {
  return sharedIsFullHallucination(text)
}

// Legacy constants kept empty — the block below used to define them but they now live
// in hallucination-filter.ts. Explicitly deleted (not undefined) so any stray references
// in older code fail loudly at compile time.
// (removed: KNOWN_HALLUCINATIONS, INLINE_HALLUCINATION_THRESHOLD, KNOWN_INLINE_HALLUCINATIONS,
//  inlineNameFrequency, inlineBlocklist, INLINE_NAME_PATTERN, SOUND_DESCRIPTORS,
//  SOUND_DESCRIPTOR_PATTERN, ASTERISK_CAPTION, WHOLE_CHUNK_ASTERISK, FILLER_WORDS)
const _unused_hallucination_constants_placeholder = 0 as const


// Session audio persistence: save all WAV chunks for batch re-transcription at save time
const SESSION_AUDIO_DIR = dataPath('session-audio')
ensurePrivateDirectory(SESSION_AUDIO_DIR)
const PENDING_BATCH_DIR = dataPath('pending-batch')
ensurePrivateDirectory(PENDING_BATCH_DIR)
const MAX_SESSION_AUDIO_BYTES = 500 * 1024 * 1024  // 500MB cap per session (~2hr meeting ≈ 260MB)
const PRESERVED_SESSION_AUDIO_MARKER = '_meeting_save_preserved.marker'
const PRESERVED_SESSION_AUDIO_TTL_MS = 2 * 60 * 60 * 1000
const MAX_CANDIDATE_WAV_BASE64_CHARS = 8 * 1024 * 1024  // stay below server/index.ts 10mb JSON parser cap
const MAX_CANDIDATE_TEXT_CHARS = 8000
const MAX_CANDIDATE_WORDS = 1200
const sessionAudioBytes = new Map<string, number>()  // track per-session byte count
const sessionAudioWrites = new Map<string, Set<Promise<void>>>()

function hasFreshPreservedAudioMarker(dirPath: string): boolean {
  try {
    const marker = resolve(dirPath, PRESERVED_SESSION_AUDIO_MARKER)
    return existsSync(marker) && Date.now() - statSync(marker).mtimeMs <= PRESERVED_SESSION_AUDIO_TTL_MS
  } catch {
    return false
  }
}

// In-memory training audio counts — lazy-initialized from disk on first access per speaker
const trainingAudioCounts = new Map<string, number>()
function getTrainingCount(speakerDir: string): number {
  let count = trainingAudioCounts.get(speakerDir)
  if (count === undefined) {
    try {
      if (existsSync(speakerDir)) {
        count = readdirSync(speakerDir).filter((f: string) => f.endsWith('.wav')).length
      } else {
        count = 0
      }
    } catch {
      count = 0
    }
    trainingAudioCounts.set(speakerDir, count)
  }
  return count
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function candidateKey(record: Pick<ProviderCandidateRecord, 'provider' | 'chunkIndex' | 'audioSha256'>): string {
  return `${record.chunkIndex}:${record.provider}:${record.audioSha256}`
}

function trackSessionAudioWrite(sessionId: string, writeJob: Promise<void>): Promise<void> {
  let writes = sessionAudioWrites.get(sessionId)
  if (!writes) {
    writes = new Set()
    sessionAudioWrites.set(sessionId, writes)
  }
  writes.add(writeJob)
  writeJob.finally(() => {
    writes?.delete(writeJob)
    if (writes && writes.size === 0) sessionAudioWrites.delete(sessionId)
  }).catch(() => {})
  return writeJob
}

export async function drainSessionAudioWrites(sessionId: string): Promise<void> {
  const writes = sessionAudioWrites.get(sessionId)
  if (!writes || writes.size === 0) return
  const settled = await Promise.allSettled([...writes])
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected) throw rejected.reason
}

export const transcribeStreamRouter = Router()

// Session accumulator: sessionId -> { chunks, startTime, title }
export interface TranscriptChunk {
  text: string
  speaker: string
  elapsed: number    // ms since session start
  similarity: number // speaker identification confidence (0-1)
  words?: WhisperWord[] // word-level timestamps from DTW alignment
  asrProvider?: 'server-whisper' | 'iphone-whisperkit-beta'
  backend?: string
  model?: string
  mode?: string
  fallbackReason?: string
  latencyMs?: number
  audioSha256?: string
  canonical?: boolean
}

export interface ProviderCandidateRecord {
  provider: 'iphone-whisperkit-beta'
  chunkIndex: number
  elapsed: number
  audioSha256: string
  text: string
  words?: WhisperWord[]
  latencyMs?: number
  model?: string
  mode?: string
  receivedAt: number
  accepted?: boolean
  fallbackReason?: string
}

interface TranscriptSession {
  chunks: TranscriptChunk[]
  startTime: number
  title: string
  providerCandidates?: Record<string, ProviderCandidateRecord>
  // ── Transfer integrity (lost-chunk detection) ──────────────
  // Every chunkIndex the server received an audio POST for — recorded at
  // ingest BEFORE any text filtering, so a "received but silent" chunk counts
  // as delivered (not a gap). A genuine hole (index in [0, maxChunkIndex] that
  // never arrived = a chunk lost in transit) is the only thing flagged as a gap.
  // Sorted, de-duplicated. See computeGapReport()/analyzeTranscriptGaps().
  receivedIndices?: number[]
  maxChunkIndex?: number
  /** Persisted idle-retention clock. Meeting date/duration still use startTime. */
  lastActivityAt: number
  // Count of consecutive vocab-echo (prompt-regurgitation) chunks. Reset to 0 by
  // any real-content chunk. Used to drop a RUN of echoed brand names while keeping
  // a single loud one-off (which could be a real terse list). See sanitizeStreamTranscript.
  vocabEchoStreak?: number
}

const sessions = new Map<string, TranscriptSession>()
const CLOSED_SESSION_TTL_MS = LOCAL_FIRST_MEETING_IDLE_RETENTION_MS
const CLOSED_SESSIONS_FILE = dataPath('closed-transcript-sessions.json')

interface ClosedTranscriptSession {
  closedAt: number
  lastActivityAt: number
  receivedIndices: number[]
  maxChunkIndex: number
  reason: 'saved' | 'expired' | 'closed'
}

const closedSessionRecords = new Map<string, ClosedTranscriptSession>()

// Incremental chunk persistence — survive server restarts
const CHUNK_PERSIST_DIR = dataPath('active-sessions')
ensurePrivateDirectory(CHUNK_PERSIST_DIR)

function readClosedSessions(): Record<string, ClosedTranscriptSession> {
  if (!existsSync(CLOSED_SESSIONS_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(CLOSED_SESSIONS_FILE, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const normalized: Record<string, ClosedTranscriptSession> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9:_-]{3,96}$/.test(id)) continue
      if (typeof value === 'number' && Number.isFinite(value)) {
        normalized[id] = {
          closedAt: value,
          lastActivityAt: value,
          receivedIndices: [],
          maxChunkIndex: -1,
          reason: 'closed',
        }
        continue
      }
      if (!value || typeof value !== 'object') continue
      const raw = value as Record<string, unknown>
      const closedAt = typeof raw.closedAt === 'number' && Number.isFinite(raw.closedAt) ? raw.closedAt : null
      if (closedAt == null) continue
      const lastActivityAt = typeof raw.lastActivityAt === 'number' && Number.isFinite(raw.lastActivityAt)
        ? raw.lastActivityAt
        : closedAt
      const receivedIndices = Array.isArray(raw.receivedIndices)
        ? Array.from(new Set(
          raw.receivedIndices.filter((entry): entry is number => Number.isInteger(entry) && (entry as number) >= 0),
        )).sort((a, b) => a - b)
        : []
      const maxChunkIndex = typeof raw.maxChunkIndex === 'number' && Number.isInteger(raw.maxChunkIndex)
        ? raw.maxChunkIndex
        : (receivedIndices.at(-1) ?? -1)
      const reason = raw.reason === 'saved' || raw.reason === 'expired' ? raw.reason : 'closed'
      normalized[id] = { closedAt, lastActivityAt, receivedIndices, maxChunkIndex, reason }
    }
    return normalized
  } catch {
    try {
      renameSync(CLOSED_SESSIONS_FILE, `${CLOSED_SESSIONS_FILE}.corrupt.${Date.now()}`)
    } catch {}
    return {}
  }
}

function persistClosedSessions(): void {
  const now = Date.now()
  const merged = readClosedSessions()
  for (const id of deletedSessions) {
    merged[id] = closedSessionRecords.get(id) ?? {
      closedAt: now,
      lastActivityAt: now,
      receivedIndices: [],
      maxChunkIndex: -1,
      reason: 'closed',
    }
  }
  for (const [id, record] of Object.entries(merged)) {
    if (now - record.closedAt > CLOSED_SESSION_TTL_MS) delete merged[id]
  }
  try {
    durableAtomicWriteFileSync(CLOSED_SESSIONS_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 })
  } catch { /* best-effort tombstones; saved receipts remain authoritative */ }
}

function recoverClosedSessions(): void {
  const now = Date.now()
  const closed = readClosedSessions()
  let dirty = false
  for (const [id, record] of Object.entries(closed)) {
    if (now - record.closedAt <= CLOSED_SESSION_TTL_MS) {
      rememberDeletedSession(id)
      closedSessionRecords.set(id, record)
    } else {
      delete closed[id]
      dirty = true
    }
  }
  if (dirty) {
    try {
      durableAtomicWriteFileSync(CLOSED_SESSIONS_FILE, JSON.stringify(closed, null, 2), { mode: 0o600 })
    } catch {}
  }
}

/** Persist a session before acknowledging any chunk. Throws on failure so a
 *  client never interprets a non-durable index as accepted. */
function persistSessionRequired(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) throw makeHttpError(404, 'session not found', 'session_not_found')
  const filePath = resolve(CHUNK_PERSIST_DIR, `${sessionId}.json`)
    // chunksIndexed preserves each chunk's original index (a plain filter()
    // would collapse the sparse array and destroy gap positions on recovery).
    const chunksIndexed: Array<{ i: number; c: TranscriptChunk }> = []
    for (let i = 0; i < session.chunks.length; i++) {
      const c = session.chunks[i]
      if (c && c.text) chunksIndexed.push({ i, c })
    }
  const data = JSON.stringify({
      sessionId,
      startTime: session.startTime,
      lastActivityAt: session.lastActivityAt,
      title: session.title,
      // `chunks` = legacy dense form, kept for backward compatibility with
      // existing readers; `chunksIndexed` preserves original indices so gap
      // detection survives recovery. Recovery prefers chunksIndexed.
      chunks: chunksIndexed.map(e => e.c),
      chunksIndexed,
      receivedIndices: session.receivedIndices ?? [],
      maxChunkIndex: session.maxChunkIndex ?? -1,
      providerCandidates: session.providerCandidates ?? {},
    })
  try {
    durableAtomicWriteFileSync(filePath, data, { mode: 0o600 })
  } catch (error) {
    console.error(`[transcribe-stream] Durable session write failed for ${sessionId}: ${errMsg(error)}`)
    throw makeHttpError(503, 'meeting session persistence unavailable', 'session_persistence_failed')
  }
}

function persistSessionBestEffort(sessionId: string): void {
  try { persistSessionRequired(sessionId) } catch { /* recovery cleanup is non-admission work */ }
}

/** Recover sessions from disk on server restart */
function recoverSessions(): void {
  try {
    if (!existsSync(CHUNK_PERSIST_DIR)) return
    const files = readdirSync(CHUNK_PERSIST_DIR) as string[]
    const recoveredIds = new Set<string>()
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const data = JSON.parse(readFileSync(resolve(CHUNK_PERSIST_DIR, file), 'utf-8'))
        // Reconstruct the (sparse) chunk array. New format keeps original
        // indices via chunksIndexed; legacy format stored a dense `chunks`.
        const indexed: Array<{ i: number; c: TranscriptChunk }> | null =
          Array.isArray(data.chunksIndexed) ? data.chunksIndexed : null
        const legacy: TranscriptChunk[] | null = Array.isArray(data.chunks) ? data.chunks : null
        const hasChunks = (indexed && indexed.length > 0) || (legacy && legacy.length > 0)
        const persistedStat = statSync(resolve(CHUNK_PERSIST_DIR, file))
        const lastActivityAt = typeof data.lastActivityAt === 'number' && Number.isFinite(data.lastActivityAt)
          ? data.lastActivityAt
          : (Number.isFinite(persistedStat.mtimeMs) ? persistedStat.mtimeMs : data.startTime)
        if (data.sessionId && (hasChunks || Array.isArray(data.receivedIndices) || Number.isFinite(lastActivityAt))) {
          // Active retention is idle-based. Long meetings are not purged merely
          // because their original start time is old.
          if (Date.now() - lastActivityAt < LOCAL_FIRST_MEETING_IDLE_RETENTION_MS) {
            const chunks: TranscriptChunk[] = []
            if (indexed) {
              for (const e of indexed) {
                if (e && Number.isInteger(e.i) && e.i >= 0 && e.c) chunks[e.i] = e.c
              }
            } else if (legacy) {
              for (let k = 0; k < legacy.length; k++) if (legacy[k]) chunks[k] = legacy[k]
            }
            // Restore the received-index ledger. A legacy file (pre-feature)
            // has no ledger and no way to know whether a chunk was truly lost,
            // so deriving from stored positions would FALSELY flag a
            // received-but-silent chunk as a gap. Instead, treat a legacy
            // session as contiguous (0..maxStored) → it reports 100%, never a
            // false alarm. New-format files carry their own ledger and are exact.
            const hasLedger = Array.isArray(data.receivedIndices)
            let receivedIndices: number[]
            let maxChunkIndex: number
            if (hasLedger) {
              receivedIndices = Array.from(new Set(
                (data.receivedIndices as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) >= 0),
              )).sort((a, b) => a - b)
              maxChunkIndex = typeof data.maxChunkIndex === 'number' && data.maxChunkIndex >= 0
                ? data.maxChunkIndex
                : (receivedIndices.length > 0 ? receivedIndices[receivedIndices.length - 1] : -1)
            } else {
              let maxStored = -1
              for (let k = 0; k < chunks.length; k++) if (chunks[k]) maxStored = k
              receivedIndices = []
              for (let k = 0; k <= maxStored; k++) receivedIndices.push(k)
              maxChunkIndex = maxStored
            }
            const session: TranscriptSession = {
              chunks,
              startTime: data.startTime,
              title: data.title || '',
              lastActivityAt,
              receivedIndices,
              maxChunkIndex,
              providerCandidates: data.providerCandidates && typeof data.providerCandidates === 'object'
                ? data.providerCandidates
                : {},
            }
            // Retroactively strip inline hallucinations from recovered chunks.
            // Two-pass: (1) scan all chunks to build frequency/blocklist,
            // (2) strip from all chunks using the final blocklist.
            // Single-pass would miss non-seeded names in early chunks.
            for (const chunk of session.chunks) {
              if (chunk?.text) stripInlineHallucinations(chunk.text, data.sessionId)  // pass 1: build blocklist
            }
            let cleaned = 0
            for (const chunk of session.chunks) {
              if (chunk?.text) {
                const stripped = stripInlineHallucinations(chunk.text, data.sessionId)
                if (stripped !== chunk.text) {
                  chunk.text = stripped
                  cleaned++
                }
              }
            }
            sessions.set(data.sessionId, session)
            recoveredIds.add(data.sessionId)
            if (cleaned > 0) {
              console.log(`[session-recovery] Cleaned inline hallucinations from ${cleaned} chunks`)
              persistSessionBestEffort(data.sessionId)  // re-persist cleaned data to disk
            }
            const gaps = computeGapReport(session).missingIndices.length
            console.log(`[session-recovery] Recovered ${session.chunks.filter(c => c && c.text).length} chunks for ${data.sessionId}${gaps > 0 ? ` (${gaps} lost-chunk gap${gaps > 1 ? 's' : ''})` : ''}`)
          } else {
            // A stale unsaved session is a real closed state, not a missing
            // session that a late/zombie client may silently recreate. Keep
            // its exact receive ledger for one tombstone horizon after boot.
            const receivedIndices = Array.isArray(data.receivedIndices)
              ? Array.from(new Set(
                (data.receivedIndices as unknown[])
                  .filter((value): value is number => Number.isInteger(value) && (value as number) >= 0),
              )).sort((left, right) => left - right)
              : []
            const maxChunkIndex = typeof data.maxChunkIndex === 'number' && Number.isInteger(data.maxChunkIndex)
              ? data.maxChunkIndex
              : (receivedIndices.at(-1) ?? -1)
            closedSessionRecords.set(data.sessionId, {
              closedAt: Date.now(),
              lastActivityAt,
              receivedIndices,
              maxChunkIndex,
              reason: 'expired',
            })
            rememberDeletedSession(data.sessionId)
            persistClosedSessions()
            unlinkSync(resolve(CHUNK_PERSIST_DIR, file))
          }
        }
      } catch { /* skip corrupt files */ }
    }
    // Remove orphaned session-audio dirs with no matching recovered session
    try {
      if (existsSync(SESSION_AUDIO_DIR)) {
        for (const dir of readdirSync(SESSION_AUDIO_DIR)) {
          if (!recoveredIds.has(dir) && !hasFreshPreservedAudioMarker(resolve(SESSION_AUDIO_DIR, dir))) {
            rmSync(resolve(SESSION_AUDIO_DIR, dir), { recursive: true, force: true })
            console.log(`[session-recovery] Cleaned orphaned session-audio: ${dir}`)
          }
        }
      }
    } catch {}
  } catch { /* non-critical */ }
}

// Track recently-deleted session IDs so the /diag/client endpoint can return 410 Gone
// to zombie clients still heartbeating into non-existent sessions (spam mitigation).
// Declared BEFORE deleteSession to avoid TDZ hazard (deleteSession references these).
const deletedSessions = new Set<string>()
const DELETED_SESSION_CAP = 50  // keep last 50 deleted IDs, trim older on overflow
function rememberDeletedSession(sessionId: string): void {
  deletedSessions.add(sessionId)
  if (deletedSessions.size <= DELETED_SESSION_CAP) return
  const entries = Array.from(deletedSessions)
  for (const id of entries.slice(0, entries.length - DELETED_SESSION_CAP)) deletedSessions.delete(id)
}
export function isSessionDeleted(sessionId: string): boolean {
  return deletedSessions.has(sessionId)
}

// Recover any sessions from prior server instance.
recoverClosedSessions()
recoverSessions()

// Auto-cleanup sessions idle for the advertised retention horizon.
setInterval(() => {
  const cutoff = Date.now() - LOCAL_FIRST_MEETING_IDLE_RETENTION_MS
  for (const [id, session] of sessions) {
    if (session.lastActivityAt < cutoff) {
      closeTranscriptSession(id, 'expired')
    }
  }
  // Purge orphaned session-audio dirs (no matching active session)
  try {
    for (const dir of readdirSync(SESSION_AUDIO_DIR)) {
      if (!sessions.has(dir) && !hasFreshPreservedAudioMarker(resolve(SESSION_AUDIO_DIR, dir))) {
        rmSync(resolve(SESSION_AUDIO_DIR, dir), { recursive: true, force: true })
      }
    }
  } catch {}
  // Purge stale pending-batch dirs older than 2 hours after move (batch should complete in minutes).
  // Age measured by _batch_pending.marker mtime (set by moveSessionAudioToPending), NOT the first
  // chunk's mtime — chunk files keep their original write-time across the atomic rename, so for
  // meetings > 1 hour, chunk mtimes would always look stale. Fallback: dir mtime for older marker-less dirs.
  try {
    for (const dir of readdirSync(PENDING_BATCH_DIR)) {
      const dirPath = resolve(PENDING_BATCH_DIR, dir)
      try {
        const files = readdirSync(dirPath)
        if (files.length === 0) { rmSync(dirPath, { recursive: true, force: true }); continue }
        // Prefer the marker file mtime over first chunk mtime
        const markerPath = resolve(dirPath, '_batch_pending.marker')
        let ageSource: number
        if (existsSync(markerPath)) {
          ageSource = statSync(markerPath).mtimeMs
        } else {
          // Fallback for pre-v5.4.3 dirs: use directory ctime (changes on rename)
          ageSource = statSync(dirPath).ctimeMs
        }
        if (Date.now() - ageSource > 2 * 60 * 60 * 1000) {
          rmSync(dirPath, { recursive: true, force: true })
          console.log(`[cleanup] Purged stale pending-batch: ${dir}`)
        }
      } catch {}
    }
  } catch {}

  // Purge ext-audio dirs older than 72 hours
  try {
    if (existsSync(EXT_AUDIO_DIR)) {
      for (const dir of readdirSync(EXT_AUDIO_DIR)) {
        const dirPath = resolve(EXT_AUDIO_DIR, dir)
        try {
          const files = readdirSync(dirPath)
          if (files.length === 0) { rmSync(dirPath, { recursive: true, force: true }); continue }
          const { mtimeMs } = statSync(resolve(dirPath, files[0]))
          if (Date.now() - mtimeMs > EXT_AUDIO_TTL_MS) {
            rmSync(dirPath, { recursive: true, force: true })
            extAudioCounts.delete(dir)
            console.log(`[ext-audio] Purged expired ext-audio: ${dir} (>72h)`)
          }
        } catch {}
      }
    }
  } catch {}
  persistClosedSessions()
}, 60_000)

/** Get or create a transcript session */
export function getSession(sessionId: string): TranscriptSession {
  let session = sessions.get(sessionId)
  if (!session) {
    const now = Date.now()
    session = { chunks: [], startTime: now, lastActivityAt: now, title: '', providerCandidates: {} }
    sessions.set(sessionId, session)
  }
  if (!session.providerCandidates) session.providerCandidates = {}
  return session
}

/** Insert a non-negative integer into a sorted array, keeping it sorted and
 *  unique. Common case (a new highest value) is O(1); out-of-order (a retry)
 *  is a binary-search insert. Mutates `arr`. Exported for unit tests. */
export function insertSortedUnique(arr: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0) return
  const last = arr.length > 0 ? arr[arr.length - 1] : -1
  if (value > last) { arr.push(value); return }
  if (value === last) return
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < value) lo = mid + 1
    else hi = mid
  }
  if (arr[lo] !== value) arr.splice(lo, 0, value)
}

/** Record that the server received an audio POST for this chunk index.
 *  Called at ingest before any text filtering, so silent/empty chunks still
 *  count as delivered (not a gap). */
function recordReceivedChunk(session: TranscriptSession, chunkIndex: number): void {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return
  if (!session.receivedIndices) session.receivedIndices = []
  insertSortedUnique(session.receivedIndices, chunkIndex)
  if (session.maxChunkIndex == null || chunkIndex > session.maxChunkIndex) {
    session.maxChunkIndex = chunkIndex
  }
}

export interface TranscriptGapReport {
  received: number          // distinct chunk indices the server got
  stored: number            // chunks that survived filtering (have text)
  maxIndex: number          // highest chunk index seen (-1 if none)
  expected: number          // maxIndex + 1
  missingIndices: number[]  // indices in [0, maxIndex] never received = lost in transit
  completeness: number      // received / expected (1 when nothing expected)
}

/** Pure gap math over a received-index ledger. Exported for unit tests. */
export function analyzeChunkGaps(receivedIndices: number[], maxChunkIndex: number, storedCount = 0): TranscriptGapReport {
  const maxIndex = maxChunkIndex
  const expected = maxIndex + 1
  const recvSet = new Set(receivedIndices.filter(n => Number.isInteger(n) && n >= 0))
  const missingIndices: number[] = []
  for (let i = 0; i <= maxIndex; i++) {
    if (!recvSet.has(i)) missingIndices.push(i)
  }
  const completeness = expected > 0 ? recvSet.size / expected : 1
  return { received: recvSet.size, stored: storedCount, maxIndex, expected, missingIndices, completeness }
}

/** Gap report bound to a live session's ledger + stored-chunk count. */
function computeGapReport(session: TranscriptSession): TranscriptGapReport {
  const received = session.receivedIndices ?? []
  const maxIndex = session.maxChunkIndex ?? (received.length > 0 ? received[received.length - 1] : -1)
  const stored = session.chunks.filter(c => c && c.text).length
  return analyzeChunkGaps(received, maxIndex, stored)
}

/** Transfer-integrity report for a live session — null if the session is gone. */
export function analyzeTranscriptGaps(sessionId: string): TranscriptGapReport | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return computeGapReport(session)
}

/** Get full accumulated transcript for a session (with speaker labels).
 *  With { withGaps: true }, walks the index sequence and inserts an explicit
 *  marker wherever one or more chunks were never received — so permanently
 *  lost audio is visible in the saved transcript instead of silently stitched. */
export function getSessionTranscript(sessionId: string, opts: { withGaps?: boolean } = {}): string | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  const renderChunk = (c: TranscriptChunk): string => (c.speaker ? `[${c.speaker}]: ${c.text}` : c.text)
  if (!opts.withGaps) {
    return session.chunks.map(renderChunk).join('\n')
  }
  const report = computeGapReport(session)
  if (report.missingIndices.length === 0) {
    return session.chunks.map(renderChunk).join('\n')
  }
  const missing = new Set(report.missingIndices)
  const lines: string[] = []
  let gapRun = 0
  const flushGap = (): void => {
    if (gapRun > 0) {
      // Marker is intentionally >40 inner chars so it can't match the
      // bracket-shaped hallucination filter (/^\s*\[[^\]\n]{1,40}\]\s*$/).
      lines.push(`[… audio gap — ${gapRun} chunk${gapRun > 1 ? 's' : ''} lost in transit, not received by server …]`)
      gapRun = 0
    }
  }
  for (let i = 0; i <= report.maxIndex; i++) {
    if (missing.has(i)) { gapRun++; continue }
    flushGap()
    const c = session.chunks[i]
    if (c && c.text) lines.push(renderChunk(c))
  }
  flushGap()
  return lines.join('\n')
}

/** Get structured chunks with timing + speaker confidence (for blended meeting pipeline) */
export function getSessionChunks(sessionId: string): TranscriptChunk[] | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return session.chunks.filter(c => c && c.text)
}

export interface IndexedTranscriptChunk {
  chunkIndex: number
  chunk: TranscriptChunk
}

/** Preserve original raw-WAV indices for post-meeting batch assembly. */
export function getSessionChunkEntries(sessionId: string): IndexedTranscriptChunk[] | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  const entries: IndexedTranscriptChunk[] = []
  for (let chunkIndex = 0; chunkIndex < session.chunks.length; chunkIndex++) {
    const chunk = session.chunks[chunkIndex]
    if (chunk?.text) entries.push({ chunkIndex, chunk })
  }
  return entries
}

/** Get session start time */
export function getSessionStartTime(sessionId: string): number | null {
  return sessions.get(sessionId)?.startTime ?? null
}

/** Move session audio to pending-batch before deletion (batch re-transcription needs it) */
export function moveSessionAudioToPending(sessionId: string): string | null {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return null
  const srcDir = resolve(SESSION_AUDIO_DIR, sessionId)
  if (!existsSync(srcDir)) return null
  let destDir = resolve(PENDING_BATCH_DIR, sessionId)
  try {
    // A prior interrupted finalization can leave the canonical destination in
    // place. Never sacrifice the new raw audio: choose a private unique sibling.
    if (existsSync(destDir)) {
      let suffix = `${Date.now()}_${process.pid}`
      destDir = resolve(PENDING_BATCH_DIR, `${sessionId}_${suffix}`)
      while (existsSync(destDir)) {
        suffix = `${Date.now()}_${process.pid}_${Math.random().toString(16).slice(2, 8)}`
        destDir = resolve(PENDING_BATCH_DIR, `${sessionId}_${suffix}`)
      }
    }
    // Rename is atomic on same filesystem
    renameSync(srcDir, destDir)
    try { chmodSync(destDir, 0o700) } catch {}
    // Write marker file with move timestamp. The cleanup interval checks THIS file's
    // mtime for TTL, not individual chunk files (whose mtimes date from original write).
    // Without this marker, meetings > 1 hour have first chunks older than the 1-hour
    // TTL, causing the interval to purge pending-batch before batch re-transcription
    // can run. Observed 2026-04-13: 103-min meeting lost audio to this race condition.
    try {
      const markerPath = resolve(destDir, '_batch_pending.marker')
      writeFileSync(markerPath, String(Date.now()), { encoding: 'utf-8', mode: 0o600 })
      chmodSync(markerPath, 0o600)
    } catch {}
    return destDir
  } catch (err: unknown) {
    console.warn(`[session-audio] Failed to move to pending-batch: ${errMsg(err)}`)
    return null
  }
}

export function hasSessionAudio(sessionId: string): boolean {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return false
  try { return statSync(resolve(SESSION_AUDIO_DIR, sessionId)).isDirectory() } catch { return false }
}

export function getSessionProviderCandidates(sessionId: string): Record<string, ProviderCandidateRecord> {
  return sessions.get(sessionId)?.providerCandidates ?? {}
}

export interface MeetingSessionStatusSnapshot {
  state: 'active' | 'closed' | 'missing'
  receivedRanges: IndexRange[]
  receivedCount: number
  maxChunkIndex: number
  lastActivityAt: string | null
  retainedUntil: string | null
}

export function getMeetingSessionStatus(sessionId: string): MeetingSessionStatusSnapshot {
  const active = sessions.get(sessionId)
  if (active) {
    const received = active.receivedIndices ?? []
    return {
      state: 'active',
      receivedRanges: compressIndexRanges(received),
      receivedCount: received.length,
      maxChunkIndex: active.maxChunkIndex ?? (received.at(-1) ?? -1),
      lastActivityAt: new Date(active.lastActivityAt).toISOString(),
      retainedUntil: retainedUntilIso(active.lastActivityAt),
    }
  }
  const closed = closedSessionRecords.get(sessionId)
  if (closed) {
    return {
      state: 'closed',
      receivedRanges: compressIndexRanges(closed.receivedIndices),
      receivedCount: closed.receivedIndices.length,
      maxChunkIndex: closed.maxChunkIndex,
      lastActivityAt: new Date(closed.lastActivityAt).toISOString(),
      retainedUntil: new Date(closed.closedAt + CLOSED_SESSION_TTL_MS).toISOString(),
    }
  }
  return {
    state: 'missing',
    receivedRanges: [],
    receivedCount: 0,
    maxChunkIndex: -1,
    lastActivityAt: null,
    retainedUntil: null,
  }
}

function closeTranscriptSession(
  sessionId: string,
  reason: ClosedTranscriptSession['reason'],
  options: { preserveAudio?: boolean } = {},
): void {
  const session = sessions.get(sessionId)
  const now = Date.now()
  const receivedIndices = [...(session?.receivedIndices ?? [])]
  const maxChunkIndex = session?.maxChunkIndex ?? (receivedIndices.at(-1) ?? -1)
  closedSessionRecords.set(sessionId, {
    closedAt: now,
    lastActivityAt: session?.lastActivityAt ?? now,
    receivedIndices,
    maxChunkIndex,
    reason,
  })
  finishClosingTranscriptSession(sessionId, options)
}

/** Delete session after save */
export function deleteSession(sessionId: string, options: { preserveAudio?: boolean } = {}): void {
  closeTranscriptSession(sessionId, 'saved', options)
}

function finishClosingTranscriptSession(sessionId: string, options: { preserveAudio?: boolean }): void {
  sessions.delete(sessionId)
  sessionAudioBytes.delete(sessionId)
  sessionAudioWrites.delete(sessionId)
  // Clean up inline hallucination tracking (was leaking until 4-hour interval fired)
  clearSessionHallucinationState(sessionId)
  // Track as deleted so orphan heartbeats get 410 Gone (prevents zombie client spam)
  rememberDeletedSession(sessionId)
  persistClosedSessions()
  // Clean up persisted file
  try { unlinkSync(resolve(CHUNK_PERSIST_DIR, `${sessionId}.json`)) } catch {}
  // Clean up session audio if it wasn't moved to pending-batch
  const audioDir = resolve(SESSION_AUDIO_DIR, sessionId)
  if (options.preserveAudio && existsSync(audioDir)) {
    try {
      const marker = resolve(audioDir, PRESERVED_SESSION_AUDIO_MARKER)
      writeFileSync(marker, String(Date.now()), { encoding: 'utf8', mode: 0o600 })
      chmodSync(marker, 0o600)
    } catch {}
  } else {
    try { rmSync(audioDir, { recursive: true, force: true }) } catch {}
  }
}

function isIosAsrCandidateEnabled(): boolean {
  return process.env.COS_IOS_ASR_CANDIDATES === '1'
}

function makeHttpError(status: number, message: string, reason?: string): Error & { status?: number; reason?: string } {
  const err = new Error(message) as Error & { status?: number; reason?: string }
  err.status = status
  err.reason = reason
  return err
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
    throw makeHttpError(400, 'invalid sessionId', 'invalid_session_id')
  }
}

function validateChunkIndex(chunkIndex: number): void {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 9999) {
    throw makeHttpError(400, 'invalid chunkIndex', 'invalid_chunk_index')
  }
}

function normalizeCandidateText(value: unknown): string {
  const text = String(value ?? '')
  if (text.length > MAX_CANDIDATE_TEXT_CHARS) {
    throw makeHttpError(413, 'candidate text too large', 'candidate_text_too_large')
  }
  return text
}

function normalizeCandidateWords(value: unknown): WhisperWord[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized: WhisperWord[] = []
  for (const item of value.slice(0, MAX_CANDIDATE_WORDS)) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const word = typeof raw.word === 'string' ? raw.word.trim().slice(0, 80) : ''
    const start = typeof raw.start === 'number' && Number.isFinite(raw.start) ? raw.start : undefined
    const end = typeof raw.end === 'number' && Number.isFinite(raw.end) ? raw.end : undefined
    const probability = typeof raw.probability === 'number' && Number.isFinite(raw.probability)
      ? raw.probability
      : 0
    if (!word || start == null || end == null) continue
    normalized.push({ word, start, end, probability })
  }
  return normalized.length > 0 ? normalized : undefined
}

async function readRawBody(req: AsyncIterable<Buffer | Uint8Array | string>): Promise<Buffer> {
  const buffers: Buffer[] = []
  for await (const chunk of req) {
    buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(buffers)
}

async function persistRawSessionAudioChunk(sessionId: string, chunkIndex: number, audioBuffer: Buffer): Promise<void> {
  const sessionDir = resolve(SESSION_AUDIO_DIR, sessionId)
  ensurePrivateDirectory(sessionDir)
  const chunkPath = resolve(sessionDir, `chunk_${String(chunkIndex).padStart(4, '0')}.wav`)
  const existingSize = existsSync(chunkPath) ? statSync(chunkPath).size : 0
  let currentBytes = sessionAudioBytes.get(sessionId)
  if (currentBytes == null) {
    currentBytes = 0
    try {
      for (const filename of readdirSync(sessionDir)) {
        if (!/^chunk_\d{4}\.wav$/.test(filename)) continue
        currentBytes += statSync(resolve(sessionDir, filename)).size
      }
    } catch (error) {
      throw makeHttpError(503, `meeting audio inventory failed: ${errMsg(error)}`, 'session_audio_persistence_failed')
    }
  }
  const nextBytes = currentBytes - existingSize + audioBuffer.length
  if (nextBytes > MAX_SESSION_AUDIO_BYTES) {
    throw makeHttpError(507, 'meeting audio capacity exceeded', 'meeting_audio_capacity_exceeded')
  }
  try {
    durableAtomicWriteFileSync(chunkPath, audioBuffer, { mode: 0o600 })
  } catch (error) {
    throw makeHttpError(503, `meeting audio persistence failed: ${errMsg(error)}`, 'session_audio_persistence_failed')
  }
  sessionAudioBytes.set(sessionId, Math.max(0, nextBytes))
}

function recentWhisperContext(sessionId: string, session: TranscriptSession): string {
  const recentText = session.chunks
    .filter(c => {
      if (!c?.text) return false
      const words = c.text.toLowerCase().replace(/[.!?,;:'"()\-\n]/g, '').split(/\s+/).filter((w: string) => w)
      if (words.length < 2) return false
      const unique = new Set(words)
      if (unique.size === 1) return false
      const wordCounts = new Map<string, number>()
      for (const w of words) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1)
      const maxCount = Math.max(...wordCounts.values())
      if (maxCount / words.length > 0.7) return false
      return true
    })
    .slice(-5)
    .map(c => c.text)
    .join(' ')
  const cleanedContext = stripInlineHallucinations(recentText, sessionId)
  return cleanedContext.length > 250 ? cleanedContext.slice(-250) : cleanedContext
}

function isCrossChunkRepeat(session: TranscriptSession, text: string): boolean {
  const norm = text.toLowerCase().replace(/[.!?,;:'"()\-\n]/g, '').trim()
  if (norm.length === 0 || norm.split(/\s+/).length > 6) return false
  const recent = session.chunks.slice(-3).filter(c => c?.text)
  const repeats = recent.filter(c =>
    c.text.toLowerCase().replace(/[.!?,;:'"()\-\n]/g, '').trim() === norm
  ).length
  return repeats >= 2
}

function sanitizeStreamTranscript(sessionId: string, session: TranscriptSession, rawText: string, isQuiet = false): { text: string; fallbackReason?: string } {
  let trimmedText = rawText?.trim() || ''
  if (trimmedText) {
    try { trimmedText = stripInlineHallucinations(trimmedText, sessionId) } catch { /* keep raw text */ }
  }
  // Silence-hallucination drops. brand-URL-only fires regardless of isQuiet (brand URLs
  // are vocab-seeded and never a real standalone utterance); generic-URL-only and
  // repeated-thank-you fire only when isQuiet so real soft speech / dictated URLs survive.
  // Dropped chunks return '' and never enter session.chunks, so they don't pollute
  // context priming or cross-chunk-repeat history. See streamSilenceDropReason contract.
  if (trimmedText) {
    const dropReason = streamSilenceDropReason(trimmedText, isQuiet)
    const flagAllows = dropReason === 'thankyou_silence' ? THANKYOU_FILTER : STRIP_BRAND_URLS
    if (dropReason && flagAllows) {
      console.log(`[hallucination] Dropped (${dropReason}, q=${isQuiet ? 1 : 0}): "${trimmedText.slice(0, 60)}"`)
      return { text: '', fallbackReason: dropReason }
    }
  }
  // Vocab-echo (whisper regurgitating its seeded vocab prompt — phantom brand names).
  // Session-aware so we never drop a real one-off: a chunk that is NOTHING but seeded
  // terms is dropped only when (a) the audio is quiet (a silence echo), (b) it's the
  // 2nd+ consecutive such chunk (a RUN — the "repeated multiple times" symptom), or
  // (c) it exactly repeats a recent chunk. A single loud, non-repeating vocab-only
  // chunk is KEPT (it could be a real terse brand/name list). Accepted trade: if a
  // user genuinely dictates a brand list with NO connectives across consecutive
  // chunks ("POS Nation," | "Thrift Cart," | "and IT Retail"), the middle chunk can
  // be dropped — rare (whisper usually bundles a spoken list into one chunk, which
  // is kept) and far less harmful than the phantom-brand spam this prevents.
  if (trimmedText && STRIP_BRAND_URLS && isVocabEchoOnly(trimmedText)) {
    const streak = (session.vocabEchoStreak ?? 0) + 1
    session.vocabEchoStreak = streak
    if (isQuiet || streak >= 2 || isCrossChunkRepeat(session, trimmedText)) {
      console.log(`[hallucination] Dropped (vocab_echo, q=${isQuiet ? 1 : 0}, streak=${streak}): "${trimmedText.slice(0, 60)}"`)
      return { text: '', fallbackReason: 'vocab_echo' }
    }
  } else if (trimmedText) {
    session.vocabEchoStreak = 0
  }
  if (trimmedText && isServerHallucination(trimmedText)) {
    return { text: '', fallbackReason: 'hallucination' }
  }
  if (trimmedText && isCrossChunkRepeat(session, trimmedText)) {
    return { text: '', fallbackReason: 'cross_chunk_repeat' }
  }
  return { text: trimmedText }
}

function storeProviderCandidate(
  session: TranscriptSession,
  record: ProviderCandidateRecord,
): string {
  session.providerCandidates ??= {}
  const key = candidateKey(record)
  session.providerCandidates[key] = record
  return key
}

function canonicalChunkResponse(
  existing: TranscriptChunk,
  sessionId: string,
  chunkIndex: number,
): { text: string; speaker: string; chunkIndex: number; elapsed: number; sessionId: string; backend?: string; asrProvider?: string; fallbackReason?: string } {
  return {
    text: existing.text,
    speaker: existing.speaker,
    chunkIndex,
    elapsed: existing.elapsed,
    sessionId,
    backend: existing.backend,
    asrProvider: existing.asrProvider,
    fallbackReason: existing.fallbackReason,
  }
}

async function transcribeWithServerWhisper(audioBuffer: Buffer, whisperAudio: Buffer, whisperContext: string, isQuiet: boolean): Promise<{ text: string; words?: WhisperWord[]; backend: string }> {
  if (isWhisperLocalAvailable()) {
    try {
      const result = await transcribeLocal(whisperAudio, whisperContext || undefined, isQuiet)
      return { text: result.text, words: result.words, backend: `local-${result.backend}` }
    } catch (err: unknown) {
      console.warn(`[transcribe-stream] Local Whisper failed, falling back to cloud: ${errMsg(err)}`)
      const text = await transcribeViaCloud(whisperAudio)
      return { text, words: undefined, backend: 'cloud' }
    }
  }
  const text = await transcribeViaCloud(whisperAudio)
  return { text, words: undefined, backend: 'cloud' }
}

function identifyChunkSpeaker(audioBuffer: Buffer, sessionId: string, chunkIndex: number, clientSpeaker: string): { speaker: string; similarity: number } {
  const expectedSpeakers = undefined
  const audioDurationSec = Math.max(0, (audioBuffer.length - 44)) / 32000
  if (!isEmbeddingAvailable() || audioDurationSec < 2.0) return { speaker: clientSpeaker, similarity: 0 }

  const tEmb = performance.now()
  const embeddingResult = identifySpeaker(audioBuffer, expectedSpeakers)
  console.log(`[perf] identifySpeaker: ${(performance.now() - tEmb).toFixed(1)}ms`)
  if (!embeddingResult) return { speaker: clientSpeaker, similarity: 0 }

  let speaker = embeddingResult.speaker
  if (speaker !== clientSpeaker) {
    console.log(`[speaker] Embedding: ${speaker} vs Amplitude: ${clientSpeaker} (sim: ${embeddingResult.similarity.toFixed(2)})`)
  }

  if (embeddingResult.similarity >= 0.72 && speaker !== 'Ext') {
    const enrollResult = autoEnroll(speaker, audioBuffer, embeddingResult.similarity, sessionId)
    if (enrollResult.enrolled) {
      console.log(`[speaker] Auto-enrolled ${speaker} from G2 mic (sim: ${embeddingResult.similarity.toFixed(3)})`)
    }
  }

  if (speaker !== 'Ext' && embeddingResult.similarity > 0.50) {
    const embCount = getEmbeddingCount(speaker)
    if (embCount < 20) {
      try {
        const speakerDir = resolve(AUDIO_SAVE_DIR, speaker.replace(/\s+/g, '_'))
        ensurePrivateDirectory(speakerDir)
        const existing = getTrainingCount(speakerDir)
        if (existing < MAX_SAVED_CHUNKS_PER_SPEAKER) {
          const filename = `${sessionId}_chunk${chunkIndex}_sim${embeddingResult.similarity.toFixed(2)}.wav`
          const savePath = resolve(speakerDir, filename)
          writeFile(savePath, audioBuffer, { mode: 0o600 }).catch(err =>
            console.warn(`[training-audio] Async save failed for ${speaker}: ${err.message}`)
          )
          trainingAudioCounts.set(speakerDir, existing + 1)
          console.log(`[training-audio] Saved ${speaker} chunk (sim=${embeddingResult.similarity.toFixed(2)}, ${audioBuffer.length}b, total=${existing + 1})`)
        }
      } catch (audioSaveErr: unknown) {
        console.warn(`[training-audio] Save failed for ${speaker}: ${errMsg(audioSaveErr)}`)
      }
    } else if (chunkIndex % 20 === 0) {
      console.log(`[training-audio] ${speaker} at ${embCount} embeddings (>= 15), skipping save`)
    }
  }

  if (speaker === 'Ext' && audioBuffer.length >= 16000) {
    const extSessionDir = resolve(EXT_AUDIO_DIR, sessionId)
    ensurePrivateDirectory(extSessionDir)
    const extCount = extAudioCounts.get(sessionId) ?? 0
    if (extCount < MAX_EXT_CHUNKS_PER_SESSION) {
      const filename = `ext_chunk${chunkIndex}_${Date.now()}.wav`
      writeFile(resolve(extSessionDir, filename), audioBuffer, { mode: 0o600 }).catch(err =>
        console.warn(`[ext-audio] Save failed: ${err.message}`)
      )
      extAudioCounts.set(sessionId, extCount + 1)
      if (extCount === 0 || (extCount + 1) % 10 === 0) {
        console.log(`[ext-audio] Saved Ext chunk for session ${sessionId} (total=${extCount + 1})`)
      }
    }
  }

  return { speaker, similarity: embeddingResult.similarity }
}

interface StreamCandidateInput {
  provider: 'iphone-whisperkit-beta'
  text: string
  words?: WhisperWord[]
  latencyMs?: number
  model?: string
  mode?: string
}

async function processStreamChunk(opts: {
  sessionId: string
  chunkIndex: number
  clientSpeaker: string
  audioBuffer: Buffer
  candidate?: StreamCandidateInput
  clientElapsed?: number
  /** Original client recording start, applied only before canonical chunks. */
  startTimeOverride?: number
}): Promise<{ text: string; speaker: string; chunkIndex: number; elapsed: number; sessionId: string; backend?: string; asrProvider?: string; fallbackReason?: string }> {
  const { sessionId, chunkIndex, clientSpeaker, audioBuffer, candidate } = opts
  const tReq = performance.now()
  validateSessionId(sessionId)
  validateChunkIndex(chunkIndex)
  if (isSessionDeleted(sessionId)) throw makeHttpError(410, 'session is closed', 'session_closed')
  if (audioBuffer.length < 100) throw makeHttpError(400, 'audio too short', 'audio_too_short')

  const audioSha256 = sha256Hex(audioBuffer)
  const session = getSession(sessionId)
  if (opts.startTimeOverride && session.chunks.filter(Boolean).length === 0) {
    session.startTime = opts.startTimeOverride
  }
  const alreadyCanonical = session.chunks[chunkIndex]

  let candidateRecordKey: string | undefined
  if (candidate) {
    const record: ProviderCandidateRecord = {
      provider: candidate.provider,
      chunkIndex,
      elapsed: Number.isFinite(opts.clientElapsed) ? Number(opts.clientElapsed) : 0,
      audioSha256,
      text: candidate.text ?? '',
      words: candidate.words,
      latencyMs: candidate.latencyMs,
      model: candidate.model,
      mode: candidate.mode,
      receivedAt: Date.now(),
    }
    candidateRecordKey = storeProviderCandidate(session, record)
  }

  // Do not let late duplicate/replayed candidates replace canonical raw audio.
  // Batch re-transcription relies on chunk_000N.wav matching the accepted chunk.
  if (alreadyCanonical?.canonical) {
    session.lastActivityAt = Date.now()
    recordReceivedChunk(session, chunkIndex)
    if (candidate && candidateRecordKey) {
      session.providerCandidates![candidateRecordKey].accepted =
        alreadyCanonical.asrProvider === 'iphone-whisperkit-beta' && alreadyCanonical.audioSha256 === audioSha256
      session.providerCandidates![candidateRecordKey].fallbackReason =
        session.providerCandidates![candidateRecordKey].accepted ? undefined : 'canonical_exists'
    }
    persistSessionRequired(sessionId)
    return canonicalChunkResponse(alreadyCanonical, sessionId, chunkIndex)
  }

  await persistRawSessionAudioChunk(sessionId, chunkIndex, audioBuffer)
  // Commit the received-index ledger only after the canonical raw WAV is
  // durable. A failure is typed non-2xx and a retry remains safe.
  session.lastActivityAt = Date.now()
  recordReceivedChunk(session, chunkIndex)
  persistSessionRequired(sessionId)

  const pcmData = audioBuffer.subarray(44)
  let sumSq = 0
  const nSamples = Math.floor(pcmData.length / 2)
  for (let i = 0; i < nSamples; i++) {
    const s = pcmData.readInt16LE(i * 2)
    sumSq += s * s
  }
  const rms = Math.sqrt(sumSq / Math.max(1, nSamples))
  const isQuiet = rms < 150
  const whisperAudio = isQuiet ? audioBuffer : await enhanceAudio(audioBuffer)
  const whisperContext = recentWhisperContext(sessionId, session)
  console.log(`[perf] whisperContext: ${whisperContext.length}b | session.chunks: ${session.chunks.length}`)

  const speakerPromise = Promise.resolve(identifyChunkSpeaker(audioBuffer, sessionId, chunkIndex, clientSpeaker))

  let rawText = ''
  let words: WhisperWord[] | undefined
  let backend = 'candidate'
  let asrProvider: 'server-whisper' | 'iphone-whisperkit-beta' = 'server-whisper'
  let model: string | undefined
  let mode: string | undefined
  let latencyMs: number | undefined
  let fallbackReason: string | undefined

  if (candidate) {
    rawText = candidate.text ?? ''
    words = candidate.words
    asrProvider = 'iphone-whisperkit-beta'
    model = candidate.model
    mode = candidate.mode
    latencyMs = candidate.latencyMs
  } else {
    const t0 = performance.now()
    const result = await transcribeWithServerWhisper(audioBuffer, whisperAudio, whisperContext, isQuiet)
    console.log(`[perf] whisper total: ${(performance.now() - t0).toFixed(1)}ms`)
    rawText = result.text
    words = result.words
    backend = result.backend
  }

  // Apply deterministic name corrections (whisper_corrections map) on EVERY live
  // path: the iPhone-ASR candidate path and the cloud fallback skip
  // transcribeLocal's internal pass, so without this the lens would show names
  // uncorrected for those sources. Idempotent for the local path.
  rawText = applyCorrections(rawText)

  let sanitized = sanitizeStreamTranscript(sessionId, session, rawText, isQuiet)
  if (candidate && (!sanitized.text || sanitized.fallbackReason)) {
    fallbackReason = sanitized.fallbackReason || 'empty_candidate'
    const result = await transcribeWithServerWhisper(audioBuffer, whisperAudio, whisperContext, isQuiet)
    rawText = applyCorrections(result.text)
    words = result.words
    backend = result.backend
    asrProvider = 'server-whisper'
    sanitized = sanitizeStreamTranscript(sessionId, session, rawText, isQuiet)
  }

  const { speaker, similarity } = await speakerPromise
  // Client time is authoritative for live network jitter and deferred replay.
  const elapsed = Number.isFinite(opts.clientElapsed) && (opts.clientElapsed as number) >= 0
    ? Math.round(opts.clientElapsed as number)
    : Date.now() - session.startTime
  const trimmedText = sanitized.text

  if (!trimmedText) {
    console.log(`[hallucination] Filtered (${sanitized.fallbackReason || fallbackReason || 'empty'}): "${rawText.slice(0, 60)}"`)
    if (candidate && candidateRecordKey && session.providerCandidates?.[candidateRecordKey]) {
      session.providerCandidates[candidateRecordKey].accepted = false
      session.providerCandidates[candidateRecordKey].fallbackReason = sanitized.fallbackReason || fallbackReason || 'empty'
    }
    persistSessionRequired(sessionId)
    return { text: '', speaker: clientSpeaker, chunkIndex, elapsed, sessionId, backend, asrProvider, fallbackReason: sanitized.fallbackReason || fallbackReason }
  }

  const chunk: TranscriptChunk = {
    text: trimmedText,
    speaker,
    elapsed,
    similarity,
    words,
    asrProvider,
    backend,
    model,
    mode,
    fallbackReason,
    latencyMs,
    audioSha256,
    canonical: true,
  }
  const finalExisting = session.chunks[chunkIndex]
  if (finalExisting?.canonical) {
    if (candidate && candidateRecordKey && session.providerCandidates?.[candidateRecordKey]) {
      session.providerCandidates[candidateRecordKey].accepted =
        finalExisting.asrProvider === 'iphone-whisperkit-beta' && finalExisting.audioSha256 === audioSha256
      session.providerCandidates[candidateRecordKey].fallbackReason =
        session.providerCandidates[candidateRecordKey].accepted ? undefined : 'canonical_exists'
    }
    session.lastActivityAt = Date.now()
    persistSessionRequired(sessionId)
    return canonicalChunkResponse(finalExisting, sessionId, chunkIndex)
  }
  session.chunks[chunkIndex] = chunk
  if (candidate && candidateRecordKey) {
    if (session.providerCandidates?.[candidateRecordKey]) {
      session.providerCandidates[candidateRecordKey].accepted = asrProvider === 'iphone-whisperkit-beta'
      session.providerCandidates[candidateRecordKey].fallbackReason = fallbackReason
    }
  }
  const tPersist = performance.now()
  session.lastActivityAt = Date.now()
  persistSessionRequired(sessionId)
  console.log(`[perf] persistSession: ${(performance.now() - tPersist).toFixed(1)}ms (${session.chunks.filter(c => c).length} chunks)`)

  emitDisplay({ type: 'transcript_chunk', data: { text: trimmedText, speaker, chunkIndex, elapsed, sessionId } })

  console.log(`[perf] TOTAL request: ${(performance.now() - tReq).toFixed(1)}ms | chunk #${chunkIndex} | ${audioBuffer.length}b | rms=${Math.round(rms)} q=${isQuiet ? 1 : 0} | ${asrProvider} | "${trimmedText.slice(0, 50)}"`)
  return { text: trimmedText, speaker, chunkIndex, elapsed, sessionId, backend, asrProvider, fallbackReason }
}

function sendStreamError(res: { status: (code: number) => { json: (body: unknown) => unknown } }, err: unknown): unknown {
  if (err instanceof OpenAIWhisperBudgetExhaustedError) {
    console.error(`[transcribe-stream] ${err.message}`)
    return res.status(503).json({
      error: err.message,
      reason: 'openai_whisper_budget_exhausted',
      spent_today_usd: err.spentTodayUsd,
      cap_usd: err.capUsd,
    })
  }
  const status = typeof (err as any)?.status === 'number' ? (err as any).status : 500
  return res.status(status).json({ error: errMsg(err), reason: (err as any)?.reason })
}

transcribeStreamRouter.post('/transcribe-stream', async (req, res) => {
  try {
    const sessionId = (req.query.sessionId as string) || `g2_${Date.now()}`
    const chunkIndex = parseInt((req.query.chunkIndex as string) || '0', 10)
    const clientSpeaker = (req.query.speaker as string) || 'Unknown'
    const clientElapsedRaw = Number(req.query.elapsed)
    const clientElapsed = Number.isFinite(clientElapsedRaw) && clientElapsedRaw >= 0
      ? clientElapsedRaw
      : undefined
    const startTimeRaw = Number(req.query.startTime)
    const startTimeOverride = Number.isFinite(startTimeRaw) && startTimeRaw > 0
      ? startTimeRaw
      : undefined
    const audioBuffer = await readRawBody(req)
    res.json(await processStreamChunk({
      sessionId,
      chunkIndex,
      clientSpeaker,
      audioBuffer,
      clientElapsed,
      startTimeOverride,
    }))
  } catch (err: unknown) {
    sendStreamError(res, err)
  }
})

transcribeStreamRouter.post('/transcribe-stream/offline-sessions/start', async (req, res) => {
  try {
    if (!isIosAsrCandidateEnabled()) throw makeHttpError(403, 'iPhone ASR candidates disabled', 'iphone_asr_disabled')
    const body = req.body ?? {}
    const sessionId = String(body.sessionId ?? '')
    validateSessionId(sessionId)
    if (isSessionDeleted(sessionId)) throw makeHttpError(410, 'session is closed', 'session_closed')
    const session = getSession(sessionId)
    const startTime = typeof body.startTime === 'number' && Number.isFinite(body.startTime)
      ? Number(body.startTime)
      : undefined
    if (startTime && session.chunks.filter(Boolean).length === 0) session.startTime = startTime
    if (typeof body.title === 'string') session.title = body.title.slice(0, 160)
    session.lastActivityAt = Date.now()
    persistSessionRequired(sessionId)
    res.json({ sessionId, startTime: session.startTime, chunks: session.chunks.filter(Boolean).length })
  } catch (err: unknown) {
    sendStreamError(res, err)
  }
})

transcribeStreamRouter.post('/transcribe-stream/offline-sessions/:sessionId/chunks', async (req, res) => {
  try {
    if (!isIosAsrCandidateEnabled()) throw makeHttpError(403, 'iPhone ASR candidates disabled', 'iphone_asr_disabled')
    const sessionId = String(req.params.sessionId ?? '')
    validateSessionId(sessionId)
    if (isSessionDeleted(sessionId)) throw makeHttpError(410, 'session is closed', 'session_closed')
    const body = req.body ?? {}
    const chunkIndex = Number(body.chunkIndex)
    validateChunkIndex(chunkIndex)
    if (chunkIndex > 0 && !sessions.has(sessionId)) {
      throw makeHttpError(404, 'offline session not started', 'session_not_found')
    }
    if (body.provider !== 'iphone-whisperkit-beta') throw makeHttpError(400, 'invalid provider', 'invalid_provider')
    const wavBase64 = String(body.wavBase64 ?? '')
    if (!wavBase64 || wavBase64.length > MAX_CANDIDATE_WAV_BASE64_CHARS) throw makeHttpError(400, 'invalid audio payload', 'invalid_audio')
    const audioBuffer = Buffer.from(wavBase64, 'base64')
    const audioSha256 = sha256Hex(audioBuffer)
    if (String(body.audioSha256 ?? '') !== audioSha256) throw makeHttpError(400, 'audio hash mismatch', 'audio_hash_mismatch')
    const candidate = body.candidate ?? {}
    const result = await processStreamChunk({
      sessionId,
      chunkIndex,
      clientSpeaker: String(body.clientSpeaker ?? 'Unknown'),
      audioBuffer,
      clientElapsed: typeof body.elapsed === 'number' ? body.elapsed : Number(body.elapsed ?? 0),
      candidate: {
        provider: 'iphone-whisperkit-beta',
        text: normalizeCandidateText(candidate.text),
        words: normalizeCandidateWords(candidate.words),
        latencyMs: typeof candidate.latencyMs === 'number' ? candidate.latencyMs : undefined,
        model: typeof candidate.model === 'string' ? candidate.model : undefined,
        mode: typeof candidate.mode === 'string' ? candidate.mode : undefined,
      },
    })
    res.json({ ...result, offlineReplay: true })
  } catch (err: unknown) {
    sendStreamError(res, err)
  }
})

transcribeStreamRouter.post('/transcribe-stream/offline-sessions/:sessionId/finalize', async (req, res) => {
  try {
    if (!isIosAsrCandidateEnabled()) throw makeHttpError(403, 'iPhone ASR candidates disabled', 'iphone_asr_disabled')
    const sessionId = String(req.params.sessionId ?? '')
    validateSessionId(sessionId)
    if (isSessionDeleted(sessionId)) throw makeHttpError(410, 'session is closed', 'session_closed')
    const chunks = getSessionChunks(sessionId)
    if (!chunks || chunks.length === 0) throw makeHttpError(404, 'offline session has no chunks', 'session_not_found')
    await drainSessionAudioWrites(sessionId)
    // Gap-aware assembly: chunks lost in transit surface as inline
    // "[… audio gap …]" markers instead of being silently stitched over.
    const transcript = getSessionTranscript(sessionId, { withGaps: true }) ?? ''
    const transferIntegrity = analyzeTranscriptGaps(sessionId)
    res.json({
      sessionId,
      chunks: chunks.length,
      transcriptChars: transcript.length,
      transcript,
      transferIntegrity,
      readyToSave: true,
    })
  } catch (err: unknown) {
    sendStreamError(res, err)
  }
})

transcribeStreamRouter.post('/transcribe-stream/candidates', async (req, res) => {
  try {
    if (!isIosAsrCandidateEnabled()) throw makeHttpError(403, 'iPhone ASR candidates disabled', 'iphone_asr_disabled')
    const body = req.body ?? {}
    const sessionId = String(body.sessionId ?? '')
    const chunkIndex = Number(body.chunkIndex)
    validateSessionId(sessionId)
    validateChunkIndex(chunkIndex)
    if (isSessionDeleted(sessionId)) throw makeHttpError(410, 'session is closed', 'session_closed')
    if (chunkIndex > 0 && !sessions.has(sessionId)) {
      throw makeHttpError(404, 'session not found', 'session_not_found')
    }
    if (body.provider !== 'iphone-whisperkit-beta') throw makeHttpError(400, 'invalid provider', 'invalid_provider')
    const wavBase64 = String(body.wavBase64 ?? '')
    if (!wavBase64 || wavBase64.length > MAX_CANDIDATE_WAV_BASE64_CHARS) throw makeHttpError(400, 'invalid audio payload', 'invalid_audio')
    const audioBuffer = Buffer.from(wavBase64, 'base64')
    const audioSha256 = sha256Hex(audioBuffer)
    if (String(body.audioSha256 ?? '') !== audioSha256) throw makeHttpError(400, 'audio hash mismatch', 'audio_hash_mismatch')
    const candidate = body.candidate ?? {}
    const result = await processStreamChunk({
      sessionId,
      chunkIndex,
      clientSpeaker: String(body.clientSpeaker ?? 'Unknown'),
      audioBuffer,
      clientElapsed: typeof body.elapsed === 'number' ? body.elapsed : Number(body.elapsed ?? 0),
      candidate: {
        provider: 'iphone-whisperkit-beta',
        text: normalizeCandidateText(candidate.text),
        words: normalizeCandidateWords(candidate.words),
        latencyMs: typeof candidate.latencyMs === 'number' ? candidate.latencyMs : undefined,
        model: typeof candidate.model === 'string' ? candidate.model : undefined,
        mode: typeof candidate.mode === 'string' ? candidate.mode : undefined,
      },
    })
    res.json(result)
  } catch (err: unknown) {
    sendStreamError(res, err)
  }
})

/** Fallback: transcribe via OpenAI Whisper API.
 *  Budget-gated: throws OpenAIWhisperBudgetExhaustedError if today's $5 cap is spent.
 *  A hung whisper-server + long meeting is the exact scenario this guards against —
 *  chunks stay empty on budget-exceeded instead of silently billing per chunk. */
async function transcribeViaCloud(audioBuffer: Buffer): Promise<string> {
  assertOpenAIWhisperBudget()

  const key = getOpenAIKey()
  const audioSeconds = estimateAudioSeconds(audioBuffer)

  const isWav = audioBuffer.length >= 4 && audioBuffer.toString('ascii', 0, 4) === 'RIFF'
  const filename = isWav ? 'recording.wav' : 'recording.webm'
  const mimeType = isWav ? 'audio/wav' : 'audio/webm'

  const boundary = '----COS' + Date.now()
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  const modelPart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`
  const languagePart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen`
  const vocab = getVocabulary()
  const cloudPrompt = vocab.length > 0
    ? [getOwnerName(), ...vocab].join(', ')
    : `${getOwnerName()}, COS Glasses, Even G2`
  const promptPart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${cloudPrompt}`
  const footer = `\r\n--${boundary}--\r\n`

  const body = Buffer.concat([
    Buffer.from(header),
    audioBuffer,
    Buffer.from(modelPart),
    Buffer.from(languagePart),
    Buffer.from(promptPart),
    Buffer.from(footer),
  ])

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })

  if (!response.ok) {
    const errText = await response.text()
    // Don't bill a failed call — API returned non-2xx, no transcription produced.
    throw new Error(`Whisper API: ${errText.slice(0, 200)}`)
  }

  const result = await response.json() as { text: string }
  // Success — count the audio we sent against today's budget.
  recordOpenAIWhisperUsage(audioSeconds)
  return result.text?.trim() || ''
}
