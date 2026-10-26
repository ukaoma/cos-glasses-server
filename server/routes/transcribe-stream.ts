import { matchMacLiveVoice, macAnonymousProjection, type MacLiveVoiceState } from '../lib/mac-live-voices.js'
import { isVoiceLabel, macVoiceLabelsEnabled } from '../lib/mac-voice-labels.js'
import { MacParakeetUnavailableError, transcribeMacParakeet } from '../lib/mac-recording-asr.js'
import { getMeetingStore } from '../lib/meeting-store.js'
import { appendAutonomousSaveLog, getStopIntentStore, savedChunkReplay, type StopIntent } from '../lib/meeting-stop-intents.js'
import { MAC_AUDIO, MAC_CAPTURE_ID, closeMacRecording, persistMacChunkReceipt, macError, registerMacRecording, requireMacRecording, readMacRecording, validateMacWav } from '../lib/mac-recording.js'
import { AUTO_ENROLL_THRESHOLD } from '../lib/voiceprint-floor.js'
import { readSpeakerPolicy, policyLabel, type SpeakerMode } from '../lib/meeting-speaker-policy.js'
// POST /api/transcribe-stream — Streaming transcription for continuous meeting capture
// Uses local Whisper. OpenAI API fallback is disabled by default and requires
// both COS_OPENAI_WHISPER_FALLBACK=1 and a configured key.
// Streams speaker-labeled transcript chunks for live meeting capture.

import { Router } from 'express'
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync, rmSync, renameSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getVocabulary, getOwnerName, getOwnerSpeakerLabel, getWhisperCorrections } from '../lib/profile.js'
import { decoderContextWindow } from '../lib/glossary-learn.js'
import { getOpenAIKey } from '../lib/openai-key.js'
import { getTranscriptionPolicySnapshot, isOpenAIWhisperFallbackReady } from '../lib/transcription-policy.js'
import { STRANDED_STALE_MS } from '../lib/stranded-sessions.js'
import {
  clearStrandedDraft,
  listStrandedDrafts,
  releaseStrandedState,
  restoresAtBoot,
  shouldCloseAfterFailedPromote,
  sweepStrandedSessions,
  promoteStrandedSession,
  writeStrandedDraft,
} from '../lib/stranded-session-actions.js'
import { getSessionHeartbeat } from '../lib/session-heartbeats.js'
import {
  MAX_AUTO_RECOVER_ATTEMPTS,
  autoRecoverExhausted,
  clearRecoverAttempts,
  noteRecoverAttempt,
  pickQuarantineToRecover,
  requestQuarantineRecovery,
} from '../lib/quarantine-auto-recover.js'
import { TranscriptionUnavailableError } from '../lib/transcribe-audio.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
import { emitDisplay } from '../lib/display-bus.js'
import { errMsg } from '../lib/utils.js'
import { transcribeLocal, applyCorrections, type WhisperWord } from '../lib/whisper-local.js'
import { trimSilence, isSileroAvailable } from '../lib/vad-silero.js'
import { identifySpeaker, extractEmbedding, isEmbeddingAvailable, autoEnroll, AUTO_ENROLL_CANDIDATE_SIMILARITY } from '../lib/speaker-embeddings.js'
import { nemotronLive, resolveLiveLabels, resplitSegments, type ChunkSpeakerSegment } from '../lib/nemotron-live.js'
import { VOICEPRINT_MIN_AUDIO_SEC } from '../lib/voiceprint-floor.js'
import {
  assertOpenAIWhisperBudget,
  recordOpenAIWhisperUsage,
  estimateAudioSeconds,
  OpenAIWhisperBudgetExhaustedError,
} from '../lib/openai-whisper-budget.js'
import {
  stripInlineHallucinations as sharedStripInlineHallucinations,
  stripInlineHallucinationsOneShot,
  isFullHallucination as sharedIsFullHallucination,
  clearSessionHallucinationState,
  streamSilenceDropReason,
  isVocabEchoOnly,
} from '../lib/hallucination-filter.js'
import { transcribeMeetingPreview } from '../lib/stt-runtime.js'
import { decideQuiet, asrFrontEnd, silenceDropsAllowed } from '../lib/stt-live.js'
import { readSttSettings } from '../lib/stt-settings.js'
import { dataPath } from '../lib/data-dir.js'
import { ageHours, partitionExpiredAudio } from '../lib/audio-retention.js'
import {
  appendChunkEmbedding,
  sweepExpiredChunkEmbeddings,
} from '../lib/chunk-embedding-store.js'
import {
  evenSpeakerRoleMode,
  formatEvenRoleAgreement,
  parseEvenHubSpeakerRoleBody,
  parseEvenHubSpeakerRoleQuery,
  warnEvenSpeakerRoleApplyNotImplemented,
  type EvenSpeakerRoleHistogram,
} from '../lib/even-hub-speaker-role.js'
import { archiveSessionAudio, runMeetingAudioRetention } from '../lib/meeting-audio-archive.js'
import {
  DISCARDED_RETENTION_MS,
  countChunkWavs,
  listUnsavedCaptures,
  purgeExpiredQuarantine,
  quarantineSessionAudio,
  readCaptureDisposition,
  sweepOrphanedSessionAudio,
  type QuarantineReceipt,
} from '../lib/unsaved-audio-quarantine.js'
import {
  STALE_ACTIVE_SESSION_DIR_NAME,
  moveActiveSessionFileAside,
  purgeExpiredStaleActiveSessionFiles,
  sweepStaleActiveSessionFiles,
  type StaleActiveSessionMove,
} from '../lib/stale-active-session-files.js'
import { durableAtomicWriteFileSync } from '../lib/atomic-fs.js'
import { saveTrainingAudioSample } from '../lib/training-audio-save.js'
import {
  LOCAL_FIRST_MEETING_IDLE_RETENTION_MS,
  compressIndexRanges,
  retainedUntilIso,
  type IndexRange,
} from '../lib/local-first-meetings-contract.js'
import { getServerInstanceId } from '../lib/server-instance-id.js'
import {
  acquireMaintenanceWork,
  maintenanceAdmissionsOpen,
  maintenanceLifecycle,
  onMaintenanceAdmissionsOpen,
  type MaintenanceWorkLease,
} from '../lib/maintenance-lifecycle.js'
import { feedLiveCueTranscript } from '../lib/live-cues-engine.js'
import { armMacLiveCues, type MacLiveCuesAnswer } from '../lib/live-cues-v2.js'
import { liveProvisional } from '../lib/live-provisional.js'
import { chunkLevel, restoreChunkLevels, withChunkLevel, type ChunkLevel } from '../lib/chunk-levels.js'
import { preemptMetalBatchForLive, registerLiveActivityProbe } from '../lib/whisper-metal-gate.js'
import {
  scheduleProgressiveHqCheckpoint,
  stopProgressiveHqSession,
} from '../lib/meeting-batch-transcribe.js'

/** Preempt hook 2 of 2 (1C): the recording_chunk backstop. Live audio is
 *  arriving, so any Metal batch must yield the GPU now. This covers recovery,
 *  reconnect, and restart adoption — paths that reach chunk upload WITHOUT
 *  going through session creation. Idempotent with the create hook.
 *
 *  Every recording_chunk lease goes through here rather than calling
 *  acquireMaintenanceWork directly, so a future call site cannot silently skip
 *  the preempt. Preempt runs BEFORE acquire so the GPU frees even if the drain
 *  gate rejects the lease. */
function acquireRecordingChunkLease(options: { allowDuringDrain?: boolean }): MaintenanceWorkLease {
  preemptMetalBatchForLive('recording_chunk')
  return acquireMaintenanceWork('recording_chunk', options)
}

/** Live-activity probe for the Metal gate (2B). Reports the most recent
 *  lastActivityAt across in-memory sessions; the gate applies its own
 *  180s window so a cold orphan cannot pin batch to CPU. Registered here to
 *  keep the dependency one-way (stream -> gate), avoiding a circular import. */
registerLiveActivityProbe(() => {
  let newest: number | null = null
  for (const session of sessions.values()) {
    const at = session.lastActivityAt
    if (typeof at === 'number' && Number.isFinite(at) && (newest === null || at > newest)) newest = at
  }
  return newest
})

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
//   any-URL-only / repeated-thank-you / quiet vocab echo -> dropped only when the chunk
//   is RMS-quiet (rms<150), so a real softly-spoken utterance or a clearly-dictated
//   third-party URL is never dropped. 6.72.0 keeps these TEXT drops on the RMS test on
//   purpose: the Silero quiet gate (under 0.5 s of speech) also fires on a chunk holding
//   one short real name, and dropping that as a "vocab echo" would delete real speech.
//   The Silero gate decides only the prompt and the front end.
// Rollback: COS_WHISPER_STRIP_BRAND_URLS=0 (URL drops), COS_WHISPER_THANKYOU_FILTER=0.
const STRIP_BRAND_URLS = process.env.COS_WHISPER_STRIP_BRAND_URLS !== '0'
const THANKYOU_FILTER = process.env.COS_WHISPER_THANKYOU_FILTER !== '0'
const MEETING_PREVIEW_MAX_BYTES = 512 * 1024
let meetingPreviewBusy = false

// DEFAULT ON as of 6.21.22 (the user, 2026-08-06: "I want it to default to being
// on... it's stable and makes meetings so much better"). Opt-OUT now, matching
// STRIP_BRAND_URLS / THANKYOU_FILTER above: set COS_WHISPER_MEETING_PREVIEW=0
// to disable. The committed Large-v3 transcript remains authoritative and
// atomically replaces the provisional line — this gate only controls whether
// the low-latency Turbo lane is offered at all.
function meetingTurboPreviewEnabled(): boolean {
  return process.env.COS_WHISPER_MEETING_PREVIEW !== '0'
}

// Audio persistence: save G2-mic chunks for speakers who need more training data
const AUDIO_SAVE_DIR = dataPath('training-audio')
ensurePrivateDirectory(AUDIO_SAVE_DIR)
// Age bound. The count cap above is NOT a retention policy: a speaker who never
// gets trained keeps 30 WAVs of their voice indefinitely, and the only cleanup
// path was a manual /voice/train-g2 call. ext-audio has had a 72h sweep since it
// was introduced; this closes the same gap for training audio. Deliberately
// longer than ext-audio's window because these chunks are the raw material for
// deliberate enrollment, not opportunistic retroactive matching.
const TRAINING_AUDIO_TTL_MS = 14 * 24 * 60 * 60 * 1000  // 14 days

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
// Readable text for a capture that stopped receiving audio. A sidecar, never a
// meeting — see lib/stranded-session-actions.ts for why it stays out of the store.
const STRANDED_DRAFT_DIR = dataPath('stranded-drafts')
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
  /** Capture-time policy survives batch and final passes; absent means legacy Standard. */
  speakerPolicy?: SpeakerMode
  words?: WhisperWord[] // word-level timestamps from DTW alignment
  asrProvider?: 'server-whisper' | 'server-parakeet' | 'iphone-whisperkit-beta'
  backend?: string
  model?: string
  mode?: string
  fallbackReason?: string
  latencyMs?: number
  audioSha256?: string
  canonical?: boolean
  evenHubSpeakerRole?: EvenSpeakerRoleHistogram
  audioDurationMs?: number
  /** 6.61.0: who spoke when inside this chunk, in time order. Present when
   *  Nemotron separated the chunk's voices; `speaker` is then the dominant name. */
  segments?: ChunkSpeakerSegment[]
  /** 6.61.0: which path labelled the chunk. Absent when COS_DIARIZER selects the voiceprint. */
  diarizer?: ChunkDiarizerInfo
}

export interface ChunkDiarizerInfo {
  engine: 'nemotron' | 'voiceprint'
  /** Why Nemotron did not label this chunk although it was requested. */
  fallback?: string
  /** The whole-chunk voiceprint label, kept when the dominant track's name differs. */
  voiceprintSpeaker?: string
  voiceprintSimilarity?: number
  tracks?: number
  timing?: 'words' | 'estimated'
  ms?: number
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
  /** Bounded anonymous acoustic anchors; active capture only, never training. */
  macLiveVoices?: MacLiveVoiceState
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
  /** Durable ASR terminal outcomes. Raw receive alone never implies completion. */
  asrCompletedIndices?: number[]
  /** Exact replay records for silent/filtered ASR completions. */
  emptyCompletions?: Record<string, EmptyTranscriptCompletion>
  maxChunkIndex?: number
  /** 6.87.0: two numbers per chunk (level 0 to 1, Silero speech seconds) for Control's level strip. Never text. */
  chunkLevels?: ChunkLevel[]
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
  asrCompletedIndices: number[]
  canonicalIndices: number[]
  maxChunkIndex: number
  reason: 'saved' | 'expired' | 'closed'
}

interface EmptyTranscriptCompletion {
  text: ''
  speaker: string
  elapsed: number
  backend?: string
  asrProvider?: string
  model?: string
  latencyMs?: number
  fallbackReason?: string
  audioSha256?: string
  canonical: false
}

interface StreamChunkCompletionResponse {
  text: string
  speaker: string
  chunkIndex: number
  elapsed: number
  sessionId: string
  serverInstanceId: string
  asrCompleted: true
  canonical: boolean
  backend?: string
  asrProvider?: string
  model?: string
  latencyMs?: number
  fallbackReason?: string
  /** 6.61.0, additive: the chunk's speaker turns in time order. Their texts
   *  joined with one space equal `text`; `speaker` stays the dominant name. */
  segments?: ChunkSpeakerSegment[]
}

const closedSessionRecords = new Map<string, ClosedTranscriptSession>()

/** Conservative lifecycle count used by the local service manager. A restart
 * is unsafe while any live transcription session owns audio state. */
export function getActiveTranscriptionSessionCount(): number {
  return sessions.size
}

/**
 * How long a session may go silent before it stops BLOCKING a restart.
 *
 * Not a retention policy and not a reap: the session, its chunks and its
 * recoverability are untouched. This decides one thing — whether it still
 * counts toward the maintenance drain gate.
 *
 * Sized against the reasons a LIVE recording legitimately goes quiet: the phone
 * backgrounded and buffering to IndexedDB, a network drop, a long pause. Those
 * run to minutes. It sits deliberately far below
 * LOCAL_FIRST_MEETING_IDLE_RETENTION_MS (4h), which governs how long chunks stay
 * recoverable and is far too long to hold a restart on.
 *
 * DERIVED, never a second literal. `STRANDED_STALE_MS` is the one definition of
 * "this recording has gone quiet", and the stranded sweeper, the drain gate and
 * the batch-abort check must all mean the same thing by it. Two independent
 * numbers here is exactly the defect this release fixes: on 2026-08-09 the
 * session counter reported two active recordings while /api/meeting/orphans
 * reported none, because two subsystems disagreed on what a live recording is.
 */
export const RECORDING_SESSION_STALE_MS = STRANDED_STALE_MS

/**
 * How long an EMPTY session may hold the restart lock.
 *
 * The 30-minute grace above protects a real recording that has gone briefly quiet — a
 * backgrounded phone buffering to IndexedDB, a network drop, a long pause. A session
 * that has produced NO canonical text has nothing to protect, so it must not lock
 * Install, Repair, Restart and Update Server for half an hour.
 *
 * Observed 2026-08-10: meeting_1786393815060_tp693w started, took ONE 5.6s chunk that
 * transcribed to empty, stopped 6.2s later, then blocked every restart for 30 minutes.
 *
 * WHY THIS CANNOT REAP A LIVE RECORDING. `lastActivityAt` is bumped on chunk ARRIVAL
 * in processStreamChunk, before any text filtering, so a live recording in a silent
 * room keeps arriving every ~10s and never goes idle — its silent chunks land in
 * `emptyCompletions`, not `chunks`. Gating on emptiness ALONE would kill exactly that
 * session; gating on emptiness AND idleness cannot. Two minutes is comfortably more
 * than one chunk interval, so a recording that has just started is safe.
 */
export const EMPTY_SESSION_STALE_MS = 2 * 60_000

export interface TranscriptionSessionLiveness {
  /** Sessions still plausibly recording. These block a restart. */
  live: number
  /** Sessions silent past the threshold. Surfaced, NOT counted, NOT deleted. */
  stale: number
  /** Which ones, least-silent first, so an operator can act on a name. */
  staleSessions: Array<{ sessionId: string; silentForMs: number; chunks: number }>
}

/**
 * Split active sessions into live and stale.
 *
 * WHY THIS EXISTS. The maintenance gate counts `sessions.size` and blocks every
 * restart while it is non-zero. A session that leaks — the phone drops
 * mid-recording and never sends a close — pins that count at 1 indefinitely, so
 * Install, Repair, Restart and Update Server all drain, time out and fail with
 * no user-visible reason. Observed twice on 2026-08-06 (servers 6.21.20 and
 * 6.21.22); the second phantom had been silent 54 minutes and the only way
 * through was to finalize it as a real meeting, which it was not.
 *
 * THE DISCRIMINATOR IS `lastActivityAt`, NOT `oldestWorkStartedAt`. The obvious
 * reading — "activeTotal >= 1 with oldestWorkStartedAt null means leaked" — is
 * WRONG and would strand healthy recordings. `recording_session` reaches the
 * gate through `extraActiveByKind` (routes/maintenance.ts), and the snapshot's
 * `oldestStartedAtMs` loop walks only tracked `work` entries, so an extra count
 * never contributes a timestamp. EVERY recording session therefore reports
 * `oldestWorkStartedAt: null`, healthy or leaked. Only the session's own
 * `lastActivityAt` tells them apart.
 */
/**
 * The live session map, for tests only.
 *
 * Exposed because the liveness split is pure logic over `lastActivityAt` but
 * the map is module-private, and a test that cannot seed it can only assert the
 * empty case. An earlier draft of the liveness test guarded on this symbol
 * existing and silently no-opped four of its six cases — passing green while
 * exercising nothing. Never guard a test on its own seam; make the seam real.
 */
export const __sessionsForTests = sessions

/** 6.53.3: the closed-session records, for tests only (same reasoning as above). */
export const __closedSessionRecordsForTests = closedSessionRecords

export interface StrandedCapture {
  sessionId: string
  /** Minutes since the last ACK'd chunk. */
  idleMinutes: number
  /** Minutes of audio actually captured before it went quiet. */
  capturedMinutes: number
  chunks: number
  transcriptState: 'ready' | 'processing' | 'no_speech'
  canSave: boolean
  /** When the sweeper will save this on the user's behalf. */
  promotesAt: string
  /** Readable draft on disk, once the capture has been stale long enough. */
  draftPath: string | null
  draftBytes: number | null
}

/**
 * Captures that stopped receiving audio but have NOT been saved yet.
 *
 * This is the row that was missing. `/api/meeting/orphans` listed only
 * QUARANTINED directories, and a stranded session is not quarantined until the
 * 4-hour cutoff — so on 2026-08-09 it answered `count: 0` while two sessions sat
 * stranded for 184 and 24 minutes holding the restart lock. Nothing is wrong with
 * the quarantine list; it was simply blind to the state that matters most, the one
 * where the audio is still live and still rescuable.
 *
 * Reuses `getTranscriptionSessionLiveness().staleSessions` rather than re-deriving
 * staleness, so this view and the maintenance drain gate can never disagree.
 */
export function getStrandedCaptures(now = Date.now()): StrandedCapture[] {
  const drafts = new Map(listStrandedDrafts(STRANDED_DRAFT_DIR).map(d => [d.sessionId, d]))
  return getTranscriptionSessionLiveness(now).staleSessions.flatMap(stale => {
    const session = sessions.get(stale.sessionId)
    const lastActivityAt = session?.lastActivityAt ?? now - stale.silentForMs
    const draft = drafts.get(stale.sessionId) ?? null
    const received = session?.receivedIndices ?? []
    // An empty session shell is not evidence that audio was lost. Leave its
    // ledger open so a backgrounded phone can still upload before retention.
    if (!stale.chunks && !received.length && !hasSessionAudio(stale.sessionId)) return []
    const completed = new Set(session?.asrCompletedIndices ?? [])
    const noSpeech = !stale.chunks && received.length > 0 && received.every(index => completed.has(index))
    const transcriptState: StrandedCapture['transcriptState'] = stale.chunks ? 'ready' : noSpeech ? 'no_speech' : 'processing'
    return [{
      sessionId: stale.sessionId,
      idleMinutes: Math.round(stale.silentForMs / 60_000),
      capturedMinutes: Math.round(
        Math.max(0, lastActivityAt - (session?.startTime ?? lastActivityAt)) / 60_000,
      ),
      chunks: stale.chunks,
      transcriptState,
      canSave: transcriptState === 'ready',
      promotesAt: new Date(lastActivityAt + LOCAL_FIRST_MEETING_IDLE_RETENTION_MS).toISOString(),
      draftPath: draft?.path ?? null,
      draftBytes: draft?.bytes ?? null,
    }]
  })
}

export function getTranscriptionSessionLiveness(now = Date.now()): TranscriptionSessionLiveness {
  let live = 0
  const staleSessions: TranscriptionSessionLiveness['staleSessions'] = []
  for (const [sessionId, session] of sessions) {
    const silentForMs = now - session.lastActivityAt
    // Canonical text, not array length: the array is sparse and silent chunks carry no
    // text, which is exactly the shape an aborted recording leaves behind.
    const canonicalChunks = session.chunks.filter(chunk => chunk && chunk.text).length
    const emptyAndIdle = canonicalChunks === 0 && silentForMs >= EMPTY_SESSION_STALE_MS
    if (silentForMs >= RECORDING_SESSION_STALE_MS || emptyAndIdle) {
      staleSessions.push({ sessionId, silentForMs, chunks: canonicalChunks })
    } else {
      live++
    }
  }
  staleSessions.sort((a, b) => a.silentForMs - b.silentForMs)
  return { live, stale: staleSessions.length, staleSessions }
}

// Incremental chunk persistence — survive server restarts
const CHUNK_PERSIST_DIR = dataPath('active-sessions')
ensurePrivateDirectory(CHUNK_PERSIST_DIR)
/** 6.71.14: where an active-session file the server no longer owns is moved, never deleted in place. */
const STALE_ACTIVE_SESSION_DIR = dataPath(STALE_ACTIVE_SESSION_DIR_NAME)

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
          asrCompletedIndices: [],
          canonicalIndices: [],
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
      const asrCompletedIndices = Array.isArray(raw.asrCompletedIndices)
        ? Array.from(new Set(raw.asrCompletedIndices.filter(
          (entry): entry is number => Number.isInteger(entry) && (entry as number) >= 0,
        ))).sort((a, b) => a - b)
        : []
      const canonicalIndices = Array.isArray(raw.canonicalIndices)
        ? Array.from(new Set(raw.canonicalIndices.filter(
          (entry): entry is number => Number.isInteger(entry) && (entry as number) >= 0,
        ))).sort((a, b) => a - b)
        : []
      const reason = raw.reason === 'saved' || raw.reason === 'expired' ? raw.reason : 'closed'
      normalized[id] = {
        closedAt,
        lastActivityAt,
        receivedIndices,
        asrCompletedIndices,
        canonicalIndices,
        maxChunkIndex,
        reason,
      }
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
      asrCompletedIndices: [],
      canonicalIndices: [],
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
      asrCompletedIndices: session.asrCompletedIndices ?? [],
      emptyCompletions: session.emptyCompletions ?? {},
      maxChunkIndex: session.maxChunkIndex ?? -1,
      providerCandidates: session.providerCandidates ?? {},
      chunkLevels: session.chunkLevels ?? [],
      ...(session.macLiveVoices !== undefined ? { macLiveVoices: session.macLiveVoices } : {}),
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

/**
 * 6.71.14: one pass of the stale active-session sweep, against the real session
 * map. Exported so a test drives the exact wiring the minute interval runs.
 */
export function sweepStaleActiveSessionFilesNow(now: number): StaleActiveSessionMove[] {
  const moves = sweepStaleActiveSessionFiles({
    dir: CHUNK_PERSIST_DIR,
    targetDir: STALE_ACTIVE_SESSION_DIR,
    isLive: id => sessions.has(id),
    now,
    idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS,
  })
  for (const move of moves) {
    if (move.target) {
      staleMoveFailuresLogged.delete(move.sessionId)
      console.warn(
        `[cleanup] Moved stale active-session file aside: ${move.sessionId} `
        + `(${move.reason}, idle ${Math.round((move.idleMs ?? 0) / 60_000)}m, not live) \u2192 ${move.target}`,
      )
    } else {
      logStaleMoveFailure(move.sessionId, `[cleanup] Could not move stale active-session file aside for ${move.sessionId} (${move.reason}); it stays in active-sessions`)
    }
  }
  const purged = purgeExpiredStaleActiveSessionFiles(STALE_ACTIVE_SESSION_DIR, now)
  if (purged > 0) console.log(`[cleanup] Purged ${purged} stale active-session file(s) past retention`)
  return moves
}

/** A failed move repeats every minute; say so once per session id, not every tick. */
const staleMoveFailuresLogged = new Set<string>()
function logStaleMoveFailure(sessionId: string, message: string): void {
  if (staleMoveFailuresLogged.has(sessionId)) return
  staleMoveFailuresLogged.add(sessionId)
  if (staleMoveFailuresLogged.size > 500) staleMoveFailuresLogged.delete(staleMoveFailuresLogged.values().next().value as string)
  console.error(message)
}

/**
 * 6.71.14: is this active-session file the leftover of a capture that is already
 * decoded (recovered or receipted no_speech), rather than a session that RESUMED
 * under the same id after that capture was quarantined?
 *
 * A late chunk is accepted (the phone deletes its copy on a 410), so a session can
 * restart under an id whose older quarantine dir is already receipted. Its file is
 * then newer than the quarantine and its own audio sits in session-audio/<id>.
 * Only a file that is no newer than the quarantine AND has no chunk audio of its
 * own is the leftover; anything else is adopted as 6.71.13 would, so a meeting is
 * never split across a restart.
 */
function isTerminalCaptureFile(sessionId: string, recordedLastActivityAt: unknown, filePath: string): boolean {
  const disposition = readCaptureDisposition(sessionId)
  if (!disposition || (disposition.kind !== 'no_speech' && disposition.kind !== 'recovered')) return false
  const terminalAtIso = disposition.quarantinedAt ?? disposition.receiptedAt
  const terminalAt = terminalAtIso ? Date.parse(terminalAtIso) : NaN
  if (!Number.isFinite(terminalAt)) return false
  let fileActivity = typeof recordedLastActivityAt === 'number' && Number.isFinite(recordedLastActivityAt)
    ? recordedLastActivityAt
    : NaN
  if (!Number.isFinite(fileActivity)) {
    try { fileActivity = statSync(filePath).mtimeMs } catch { return false }
  }
  if (terminalAt < fileActivity) return false
  return countChunkWavs(resolve(SESSION_AUDIO_DIR, sessionId)) === 0
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
        // 6.71.14: recovery can now run after boot (deferred behind a closed
        // maintenance gate). A session already in memory owns its file; the disk
        // copy must never overwrite it.
        if (typeof data.sessionId === 'string' && sessions.has(data.sessionId)) continue
        // A capture whose quarantined audio was already decoded to a terminal
        // outcome (a saved recovery or a no_speech receipt) is done. Adopting its
        // file would bring back a live session for it; tombstoning would delete the
        // file. Move it aside instead. Plain `quarantined` (never decoded) is NOT
        // done: a crash between a chunk's first WAV write and its first
        // active-session persist quarantines the audio, and the phone's retry then
        // starts the session again. That file is adopted exactly as before.
        if (typeof data.sessionId === 'string' && isTerminalCaptureFile(data.sessionId, data.lastActivityAt, resolve(CHUNK_PERSIST_DIR, file))) {
          const terminal = readCaptureDisposition(data.sessionId)!
          const target = moveActiveSessionFileAside(
            resolve(CHUNK_PERSIST_DIR, file), data.sessionId, STALE_ACTIVE_SESSION_DIR, 'terminal_capture', Date.now(),
            { lastActivityAt: typeof data.lastActivityAt === 'number' ? data.lastActivityAt : null },
          )
          if (target) console.warn(`[session-recovery] ${data.sessionId} was already ${terminal.kind}; moved its active-session file aside: ${target}`)
          else logStaleMoveFailure(data.sessionId, `[session-recovery] Could not move the active-session file aside for ${data.sessionId} (already ${terminal.kind}); left in place, not adopted`)
          continue
        }
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
          if (restoresAtBoot(data.sessionId, Date.now() - lastActivityAt, LOCAL_FIRST_MEETING_IDLE_RETENTION_MS)) {
            const chunks: TranscriptChunk[] = []
            if (indexed) {
              for (const e of indexed) {
                if (e && Number.isInteger(e.i) && e.i >= 0 && e.c) chunks[e.i] = { ...e.c, canonical: true }
              }
            } else if (legacy) {
              for (let k = 0; k < legacy.length; k++) if (legacy[k]) chunks[k] = { ...legacy[k], canonical: true }
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
            const emptyCompletions: Record<string, EmptyTranscriptCompletion> = {}
            if (data.emptyCompletions && typeof data.emptyCompletions === 'object') {
              for (const [key, value] of Object.entries(data.emptyCompletions as Record<string, unknown>)) {
                if (!/^\d+$/.test(key) || !value || typeof value !== 'object') continue
                const item = value as Partial<EmptyTranscriptCompletion>
                if (item.text !== '' || typeof item.speaker !== 'string' || typeof item.elapsed !== 'number') continue
                emptyCompletions[key] = { ...item, text: '', canonical: false } as EmptyTranscriptCompletion
              }
            }
            const canonical: number[] = []
            for (let k = 0; k < chunks.length; k++) if (chunks[k]?.text) canonical.push(k)
            const asrCompletedIndices = Array.isArray(data.asrCompletedIndices)
              ? Array.from(new Set(
                (data.asrCompletedIndices as unknown[]).filter(
                  (n): n is number => Number.isInteger(n) && (n as number) >= 0,
                ),
              )).sort((a, b) => a - b)
              : []
            // Canonical chunks and durable empty completion records are always
            // terminal ASR outcomes. Never infer completion from raw receive.
            for (const index of canonical) insertSortedUnique(asrCompletedIndices, index)
            for (const key of Object.keys(emptyCompletions)) insertSortedUnique(asrCompletedIndices, Number(key))
            const session: TranscriptSession = {
              chunks,
              startTime: data.startTime,
              title: data.title || '',
              lastActivityAt,
              receivedIndices,
              asrCompletedIndices,
              emptyCompletions,
              maxChunkIndex,
              providerCandidates: data.providerCandidates && typeof data.providerCandidates === 'object'
                ? data.providerCandidates
                : {},
              chunkLevels: restoreChunkLevels(data.chunkLevels),
              ...(data.macLiveVoices !== undefined && MAC_CAPTURE_ID.test(data.sessionId) ? { macLiveVoices: data.macLiveVoices } : {}),
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
                  // 6.61.0: the stored turns must still join to the text.
                  if (chunk.segments) {
                    const refit = resplitSegments(chunk.segments, stripped)
                    if (refit?.length) chunk.segments = refit
                    else delete chunk.segments
                  }
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
            const canonicalIndices = Array.isArray(data.chunksIndexed)
              ? (data.chunksIndexed as Array<{ i?: unknown; c?: TranscriptChunk }>)
                .filter(entry => Number.isInteger(entry?.i) && (entry.i as number) >= 0 && entry.c?.text)
                .map(entry => entry.i as number)
              : []
            const asrCompletedIndices = Array.isArray(data.asrCompletedIndices)
              ? Array.from(new Set((data.asrCompletedIndices as unknown[]).filter(
                (value): value is number => Number.isInteger(value) && (value as number) >= 0,
              ))).sort((left, right) => left - right)
              : [...canonicalIndices]
            for (const index of canonicalIndices) insertSortedUnique(asrCompletedIndices, index)
            closedSessionRecords.set(data.sessionId, {
              closedAt: Date.now(),
              lastActivityAt,
              receivedIndices,
              asrCompletedIndices,
              canonicalIndices,
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
    // Orphaned session-audio dirs with no matching recovered session: audio
    // evidence is QUARANTINED, never deleted (6.19.0 — two meetings were
    // destroyed here on 2026-08-01 when their deferred saves never landed).
    // Only chunk-less dirs are removed.
    try {
      if (existsSync(SESSION_AUDIO_DIR)) {
        const actions = sweepOrphanedSessionAudio(SESSION_AUDIO_DIR, {
          // `|| sessions.has`: deferred recovery (6.71.14) can run while sessions
          // are live in memory; their audio is not orphaned.
          isLive: id => recoveredIds.has(id) || sessions.has(id),
          hasFreshPreservedMarker: hasFreshPreservedAudioMarker,
          reason: 'boot_sweep_unsaved',
        })
        for (const entry of actions) {
          if (entry.action === 'quarantined') {
            console.warn(`[session-recovery] Quarantined unsaved session-audio: ${entry.dir} → ${entry.target}`)
          } else if (entry.action === 'deleted_empty') {
            console.log(`[session-recovery] Cleaned empty session-audio: ${entry.dir}`)
          } else if (entry.action === 'quarantine_failed') {
            console.error(`[session-recovery] Quarantine move failed, source retained: ${entry.dir}`)
          }
        }
      }
      purgeExpiredQuarantine()
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

// A committed cross-boot maintenance operation owns durable state until the
// trusted controller adopts the candidate. Boot recovery must not mutate or
// promote sessions while that gate is closed.
//
// 6.71.14: and once that gate opens, recovery MUST still run. Until 6.71.13 this was
// a module-scope `if` evaluated once at import: a boot behind a closed gate (every
// managed update) skipped it for the life of the process. Persisted sessions were
// never adopted or tombstoned, and the closed-session tombstones were never
// restored. On 2026-10-12 that left `active-sessions/<id>.json` for a receipted
// capture on disk for 17 hours, reported as live by COS Control and `missing` by
// the status route.
let durableSessionRecoveryRan = false
function runDurableSessionRecovery(trigger: 'boot' | 'admissions_open'): void {
  if (durableSessionRecoveryRan) return
  durableSessionRecoveryRan = true
  recoverClosedSessions()
  recoverSessions()
  if (trigger === 'admissions_open') {
    console.log(`[session-recovery] Ran deferred durable recovery after the maintenance gate opened (${sessions.size} live session(s))`)
  }
}
if (maintenanceAdmissionsOpen()) {
  runDurableSessionRecovery('boot')
} else {
  // Delivered on every later open; the flag above makes every delivery after the
  // first a no-op, so disk is never re-read over a live session map.
  onMaintenanceAdmissionsOpen(() => runDurableSessionRecovery('admissions_open'))
}

/**
 * 6.71.14: has durable session recovery run in this process yet? Until it has, the
 * in-memory map does not yet hold the persisted sessions, so "not in memory" is not
 * evidence of anything. The status route answers 503 `recovery_pending` instead of
 * `missing` while this is false.
 */
export function durableSessionRecoveryHasRun(): boolean {
  return durableSessionRecoveryRan
}

/**
 * Quarantined audio has no live session, so it needs its own pass.
 *
 * This closes the hole 6.23.0 left open: `recoverSessions()` tombstones any session
 * already past the 4-hour cutoff at boot, so a restart while a capture is stranded
 * means the promote above never runs and the audio lands here instead — preserved
 * for 72 hours, but not a meeting, and only recoverable by hand. One per tick.
 */
const autoRecoverState = {
  attempts: new Map<string, number>(),
  inFlight: new Set<string>(),
}

function autoRecoverOneQuarantinedCapture(): void {
  const token = process.env.COS_API_TOKEN ?? ''
  if (!token) return
  const picked = pickQuarantineToRecover(listUnsavedCaptures(), autoRecoverState)
  if (!picked) return
  const sessionId = picked.sessionId
  autoRecoverState.inFlight.add(sessionId)
  noteRecoverAttempt(autoRecoverState, sessionId)
  void requestQuarantineRecovery(sessionId, {
    port: parseInt(process.env.PORT ?? '3141', 10),
    token,
  })
    .then(result => {
      if (result.ok) {
        console.warn(
          `[quarantine] Auto-recovered ${sessionId} \u2192 ${result.filename ?? 'saved'} `
          + `(${picked.chunkFiles} chunks, speakers unlabeled — no live ASR ran on it)`,
        )
        clearRecoverAttempts(autoRecoverState, sessionId)
        return
      }
      // 409 means a manual recovery already owns it, which is not a failure and
      // should not burn the budget.
      if (result.status === 409) {
        clearRecoverAttempts(autoRecoverState, sessionId)
        return
      }
      const attempts = autoRecoverState.attempts.get(sessionId) ?? 0
      console.error(
        `[quarantine] Auto-recovery failed for ${sessionId} `
        + `(${result.status} ${result.reason ?? ''}), attempt ${attempts}/${MAX_AUTO_RECOVER_ATTEMPTS}`
        + `${autoRecoverExhausted(autoRecoverState, sessionId)
          ? ' — giving up, audio stays quarantined and recoverable by hand' : ''}`,
      )
    })
    .finally(() => autoRecoverState.inFlight.delete(sessionId))
}

/** Sessions with an auto-save in flight, so a later tick cannot start a second. */
const promotingStranded = new Set<string>()

/**
 * Hard backstop for a capture whose save keeps failing.
 *
 * Without it a session that the save route refuses transiently, forever, would
 * live in memory forever. At twice the cutoff it takes the historical disposition
 * — close and quarantine — so the audio is at least preserved on the unsaved-audio
 * clock rather than held hostage by a retry loop.
 */
const STRANDED_PROMOTE_GIVE_UP_MS = 2 * LOCAL_FIRST_MEETING_IDLE_RETENTION_MS

/**
 * Turn an unattended capture into a meeting, and fall back to the old behavior if
 * that proves impossible.
 *
 * Fire-and-forget on purpose: the sweep tick must not await an HQ finalization
 * that can run for minutes. `promotingStranded` is what keeps the next tick from
 * starting a duplicate.
 */
function promoteStrandedCapture(sessionId: string, lastActivityAt: number): void {
  if (promotingStranded.has(sessionId)) return
  promotingStranded.add(sessionId)
  void promoteStrandedSession(sessionId, {
    port: parseInt(process.env.PORT ?? '3141', 10),
    token: process.env.COS_API_TOKEN ?? '',
  })
    .then(result => {
      if (result.ok) {
        console.warn(
          `[stranded] Auto-saved unattended capture ${sessionId} \u2192 ${result.filename ?? 'saved'}`,
        )
        clearStrandedDraft(STRANDED_DRAFT_DIR, sessionId)
        return
      }
      // Delegated, not restated: closing means the capture becomes quarantined
      // audio instead of a meeting, which is the outcome this release exists to
      // prevent, so the rule lives in a module a test can reach.
      const idleForMs = Date.now() - lastActivityAt
      if (!shouldCloseAfterFailedPromote(result, idleForMs, STRANDED_PROMOTE_GIVE_UP_MS)) {
        console.warn(
          `[stranded] Auto-save deferred for ${sessionId} `
          + `(${result.status} ${result.reason ?? ''}); retrying next sweep`,
        )
        return
      }
      console.error(
        `[stranded] Auto-save failed for ${sessionId} (${result.status} ${result.reason ?? ''}); `
        + 'closing as expired so the audio reaches quarantine',
      )
      if (sessions.has(sessionId)) closeTranscriptSession(sessionId, 'expired')
    })
    .finally(() => promotingStranded.delete(sessionId))
}

// Auto-cleanup sessions idle for the advertised retention horizon.
setInterval(() => {
  if (!maintenanceAdmissionsOpen()) return
  // 6.71.14: the sweeps below judge a session dead by its absence from the
  // in-memory map. Before recovery has adopted the persisted sessions that map is
  // empty by construction, so sweeping then would quarantine a live capture.
  if (!durableSessionRecoveryRan) return
  // A capture whose phone went away must still become a meeting. This loop used
  // to close every idle session as 'expired', which quarantined its audio and
  // produced NO meeting — recoverable for 72h, but only by whoever thought to
  // look. See lib/stranded-sessions.ts for why staleness may not close a session
  // early and why the cutoff is unchanged.
  sweepStrandedSessions({
    now: Date.now(),
    token: process.env.COS_API_TOKEN ?? '',
    draftDir: STRANDED_DRAFT_DIR,
    sessions: [...sessions].map(([id, session]) => [id, {
      lastActivityAt: session.lastActivityAt,
      startTime: session.startTime,
      chunkCount: session.chunks.filter(Boolean).length,
    }] as const),
    getHeartbeat: getSessionHeartbeat,
    getTranscript: id => getSessionTranscript(id),
    onPromote: promoteStrandedCapture,
  })
  // Orphaned session-audio dirs (no matching active session): quarantine any
  // dir still holding chunk audio; delete only chunk-less dirs. Quarantine
  // itself expires on the unsaved-audio retention clock, the ONLY place
  // quarantined audio is ever deleted.
  try {
    const actions = sweepOrphanedSessionAudio(SESSION_AUDIO_DIR, {
      isLive: id => sessions.has(id),
      hasFreshPreservedMarker: hasFreshPreservedAudioMarker,
      reason: 'idle_expiry_unsaved',
    })
    for (const entry of actions) {
      if (entry.action === 'quarantined') {
        console.warn(`[cleanup] Quarantined unsaved session-audio: ${entry.dir} → ${entry.target}`)
      } else if (entry.action === 'quarantine_failed') {
        console.error(`[cleanup] Quarantine move failed, source retained: ${entry.dir}`)
      }
    }
    purgeExpiredQuarantine()
  } catch (error) {
    // Was a bare `catch {}`. That is what made the auto-recover failure below
    // undiagnosable: three minutes of watching a live server produced no recovery, no
    // log, and nothing to reason about, because any throw in this block vanished.
    console.error(`[cleanup] Orphan-audio sweep failed: ${error instanceof Error ? error.message : error}`)
  }
  // 6.71.14: its own try, for the same reason as auto-recovery below. An
  // active-session file whose session is not live and has been idle past the
  // retention horizon is moved aside; COS Control reads that directory directly
  // and would otherwise show it as a live recording indefinitely.
  try {
    sweepStaleActiveSessionFilesNow(Date.now())
  } catch (error) {
    console.error(`[cleanup] Stale active-session sweep failed: ${error instanceof Error ? error.message : error}`)
  }
  // DELIBERATELY ITS OWN TRY. This used to sit inside the block above, one line after
  // purgeExpiredQuarantine, so a throw anywhere in that sweep meant auto-recovery
  // silently never ran — which is exactly what happened in production on 6.23.1
  // through 6.24.2. Recovering quarantined audio has nothing to do with sweeping
  // orphaned session-audio dirs and must not depend on it succeeding.
  try {
    autoRecoverOneQuarantinedCapture()
  } catch (error) {
    console.error(`[quarantine] Auto-recover pass failed: ${error instanceof Error ? error.message : error}`)
  }
  // Purge stale pending-batch dirs. HQ large-v3 on long meetings + Control
  // restart can exceed 2h (2026-07-27: two sessions purged before batch).
  // Use 12h, and never purge while a meeting_batch_finalization lease is held.
  // Age measured by _batch_pending.marker mtime (set by moveSessionAudioToPending), NOT the first
  // chunk's mtime — chunk files keep their original write-time across the atomic rename, so for
  // meetings > 1 hour, chunk mtimes would always look stale. Fallback: dir mtime for older marker-less dirs.
  try {
    const batchBusy = ((maintenanceLifecycle.snapshot().activeByKind as Record<string, number>)
      .meeting_batch_finalization ?? 0) > 0
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
        if (Date.now() - ageSource > 12 * 60 * 60 * 1000) {
          if (batchBusy) {
            console.warn(`[cleanup] Retaining stale pending-batch while batch lease held: ${dir}`)
            continue
          }
          rmSync(dirPath, { recursive: true, force: true })
          console.log(`[cleanup] Purged stale pending-batch: ${dir}`)
        }
      } catch {}
    }
  } catch {}

  // Meeting audio for review: 7-day window, then an 8 GB budget as a backstop.
  // Order matters — sweep expiry FIRST so the cap only ever evicts audio still
  // inside its window instead of racing the sweeper for the same files.
  try {
    const { swept, capped } = runMeetingAudioRetention()
    if (swept.removed.length > 0) {
      console.log(`[meeting-audio] Retention swept ${swept.removed.length} session(s), freed ${(swept.bytesFreed / 1e6).toFixed(1)} MB`)
    }
    if (capped.evicted.length > 0) {
      console.warn(
        `[meeting-audio] Over budget — evicted ${capped.evicted.length} oldest session(s): `
        + `${(capped.bytesBefore / 1e9).toFixed(2)} GB -> ${(capped.bytesAfter / 1e9).toFixed(2)} GB`,
      )
    }
  } catch { /* non-critical */ }

  // Purge training-audio WAVs past the retention window. Per file, not per
  // directory: chunks for one speaker accumulate over weeks, so an
  // all-or-nothing directory check would either keep month-old audio alive
  // because one chunk is fresh, or delete today's capture because the directory
  // is old.
  try {
    if (existsSync(AUDIO_SAVE_DIR)) {
      const now = Date.now()
      for (const dir of readdirSync(AUDIO_SAVE_DIR)) {
        const dirPath = resolve(AUDIO_SAVE_DIR, dir)
        try {
          if (!statSync(dirPath).isDirectory()) continue
          const candidates = readdirSync(dirPath)
            .filter(f => f.endsWith('.wav'))
            .map(name => {
              let mtimeMs = 0
              try { mtimeMs = statSync(resolve(dirPath, name)).mtimeMs } catch {}
              return { name, mtimeMs }
            })
          const { expired, retained } = partitionExpiredAudio(candidates, now, TRAINING_AUDIO_TTL_MS)
          for (const file of expired) {
            try { unlinkSync(resolve(dirPath, file.name)) } catch {}
          }
          if (expired.length > 0) {
            const oldest = Math.min(...expired.map(f => f.mtimeMs))
            console.log(
              `[training-audio] Purged ${expired.length} expired chunk(s) for ${dir}`,
              `(oldest ${ageHours(oldest, now)}h, ${retained.length} retained)`,
            )
          }
          if (retained.length === 0 && readdirSync(dirPath).length === 0) {
            try { rmSync(dirPath, { recursive: true, force: true }) } catch {}
          }
        } catch {}
      }
    }
  } catch {}

  // Sweep expired chunk embeddings. Same shape as the audio sweeps, but a
  // separate window: these are non-invertible timbre vectors, not speech, and
  // the correction loop needs them to survive a weekend.
  try {
    const swept = sweepExpiredChunkEmbeddings(Date.now())
    if (swept.removed.length > 0) {
      console.log(`[chunk-embeddings] Purged ${swept.removed.length} expired session file(s), ${swept.retained.length} retained`)
    }
  } catch {}

  // Purge ext-audio dirs older than 72 hours
  try {
    if (existsSync(EXT_AUDIO_DIR)) {
      for (const dir of readdirSync(EXT_AUDIO_DIR)) {
        const dirPath = resolve(EXT_AUDIO_DIR, dir)
        try {
          const files = readdirSync(dirPath)
          // 6.45.4: an emptied session (every held sample named or discarded)
          // frees its per-session cap too, so the next stranger can be held.
          if (files.length === 0) { rmSync(dirPath, { recursive: true, force: true }); extAudioCounts.delete(dir); continue }
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
  // 6.53.3 (review D3): the in-memory records age out with the file's.
  try { sweepExpiredClosedSessions(Date.now()) } catch {}
  persistClosedSessions()
}, 60_000)

/** Get or create a transcript session */
export function getSession(sessionId: string): TranscriptSession {
  let session = sessions.get(sessionId)
  if (!session) {
    const now = Date.now()
    session = {
      chunks: [],
      startTime: now,
      lastActivityAt: now,
      title: '',
      providerCandidates: {},
      receivedIndices: [],
      asrCompletedIndices: [],
      emptyCompletions: {},
    }
    sessions.set(sessionId, session)
    // Preempt hook 1 of 2 (1C). CREATE ONLY — deliberately inside the `!session`
    // branch, never on an ordinary getSession() touch, or a status read of a
    // stale session would falsely evict a healthy Metal batch.
    preemptMetalBatchForLive('session_create')
  }
  if (!session.providerCandidates) session.providerCandidates = {}
  if (!session.receivedIndices) session.receivedIndices = []
  if (!session.asrCompletedIndices) session.asrCompletedIndices = []
  if (!session.emptyCompletions) session.emptyCompletions = {}
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

function recordAsrCompleted(session: TranscriptSession, chunkIndex: number, sessionId: string): void {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return
  if (!session.asrCompletedIndices) session.asrCompletedIndices = []
  insertSortedUnique(session.asrCompletedIndices, chunkIndex)
  // 6.86.0: the canonical answer replaces the grey provisional line for this chunk (live-provisional.ts).
  liveProvisional().settle(sessionId, chunkIndex)
}

/** 6.86.0: keep the newest preview of a LIVE meeting for COS Control's grey line. Only a session this server holds (a
 *  close removes it from `sessions`), and only while that chunk is still open: a preview that lands after its chunk (or a
 *  later one) settled is stale. Memory only; never logged. */
function noteLiveProvisional(sessionId: string, chunkIndex: number, previewGen: number, text: string, model: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  const completed = session.asrCompletedIndices ?? []
  if (completed.length && chunkIndex <= completed[completed.length - 1]) return
  liveProvisional().record(sessionId, { chunkIndex, previewGen, text, model })
}

function canonicalIndices(session: TranscriptSession): number[] {
  const result: number[] = []
  for (let index = 0; index < session.chunks.length; index++) {
    if (session.chunks[index]?.text) result.push(index)
  }
  return result
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
  const maxIndex = Math.max(
    session.chunks.length - 1,
    ...Object.keys(session.emptyCompletions ?? {}).map(Number).filter(Number.isInteger),
  )
  for (let chunkIndex = 0; chunkIndex <= maxIndex; chunkIndex++) {
    const chunk = session.chunks[chunkIndex]
    if (chunk?.text) {
      entries.push({ chunkIndex, chunk })
      continue
    }
    const empty = session.emptyCompletions?.[String(chunkIndex)]
    if (empty) {
      entries.push({
        chunkIndex,
        chunk: {
          text: '',
          speaker: empty.speaker || 'Ext',
          elapsed: empty.elapsed,
          similarity: 0,
          backend: empty.backend,
          ...(empty.model ? { model: empty.model } : {}),
          ...(empty.latencyMs !== undefined ? { latencyMs: empty.latencyMs } : {}),
          asrProvider: empty.asrProvider === 'server-parakeet'
            ? 'server-parakeet'
            : empty.asrProvider === 'iphone-whisperkit-beta'
            ? 'iphone-whisperkit-beta'
            : empty.asrProvider === 'server-whisper'
              ? 'server-whisper'
              : undefined,
          fallbackReason: empty.fallbackReason,
        },
      })
    }
  }
  return entries
}

/** Private local path for guarded progressive HQ cache work. */
export function getSessionAudioDirectory(sessionId: string): string | null {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return null
  const path = resolve(SESSION_AUDIO_DIR, sessionId)
  return existsSync(path) ? path : null
}

/** Snapshot the durable ASR-completion ledger for progressive HQ admission.
 * Includes canonical and intentionally empty/silent chunks. */
export function getSessionAsrCompletedIndices(sessionId: string): number[] {
  return [...(sessions.get(sessionId)?.asrCompletedIndices ?? [])]
}

function scheduleSessionProgressiveHq(sessionId: string): void {
  // Progressive checkpoints are Whisper-only and may not bypass a Mac's
  // explicit Parakeet choice, even if the separate HQ canary is enabled.
  if (MAC_CAPTURE_ID.test(sessionId) && readSttSettings().hq === 'parakeet-ultra') return
  // Preserve the default-off contract at the route boundary. In addition to
  // avoiding any cache work, this keeps legacy/local-first transcription
  // independent of the progressive HQ capability surface when the canary is
  // disabled (including partial test and recovery environments).
  if (process.env.COS_MEETING_PROGRESSIVE_HQ !== '1') return
  const audioDir = getSessionAudioDirectory(sessionId)
  if (!audioDir) return
  scheduleProgressiveHqCheckpoint(
    sessionId,
    audioDir,
    getSessionChunkEntries(sessionId) ?? [],
    getSessionAsrCompletedIndices(sessionId),
  )
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
    // Retain a reviewable copy BEFORE the rename. Hard links, so this costs no
    // extra disk and the audio outlives the batch pipeline's own cleanup — which
    // is what used to end the audio's life entirely (session-audio held 0 files
    // on 2026-08-06, so the review panel could never play anything back).
    try {
      const archived = archiveSessionAudio(sessionId, srcDir)
      if (archived.linked + archived.copied > 0) {
        console.log(
          `[meeting-audio] Retained ${archived.linked + archived.copied} chunk(s) for review: ${sessionId}`
          + (archived.copied ? ` (${archived.copied} copied, link unavailable)` : '')
          + (archived.failed ? ` — ${archived.failed} failed` : ''),
        )
      }
    } catch { /* review audio is never worth failing a save for */ }
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
  asrCompletedRanges: IndexRange[]
  asrCompletedCount: number
  canonicalRanges: IndexRange[]
  canonicalCount: number
  maxChunkIndex: number
  lastActivityAt: string | null
  retainedUntil: string | null
}

/**
 * 6.53.3 (review D3): forget a closed session once its retention has passed, in memory as
 * well as on disk. Until 6.53.2 only the persisted file was pruned, so a closed session read
 * `closed` until the next restart, and a phone whose recovery hint named it POSTed save
 * (which can only 404) on every boot and foreground, all day. Past `retainedUntil` the
 * server now answers exactly as it would after a restart: `missing`, which every app since
 * 6.9.465 settles as terminal ("the server no longer retains it").
 */
function evictExpiredClosedSession(sessionId: string, now: number): boolean {
  const closed = closedSessionRecords.get(sessionId)
  if (!closed || now - closed.closedAt <= CLOSED_SESSION_TTL_MS) return false
  closedSessionRecords.delete(sessionId)
  deletedSessions.delete(sessionId)
  return true
}

export function sweepExpiredClosedSessions(now = Date.now()): number {
  let evicted = 0
  for (const id of [...closedSessionRecords.keys()]) if (evictExpiredClosedSession(id, now)) evicted++
  return evicted
}

export function getMeetingSessionStatus(sessionId: string, now = Date.now()): MeetingSessionStatusSnapshot {
  evictExpiredClosedSession(sessionId, now)
  const active = sessions.get(sessionId)
  if (active) {
    const received = active.receivedIndices ?? []
    const asrCompleted = active.asrCompletedIndices ?? []
    const canonical = canonicalIndices(active)
    return {
      state: 'active',
      receivedRanges: compressIndexRanges(received),
      receivedCount: received.length,
      asrCompletedRanges: compressIndexRanges(asrCompleted),
      asrCompletedCount: asrCompleted.length,
      canonicalRanges: compressIndexRanges(canonical),
      canonicalCount: canonical.length,
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
      asrCompletedRanges: compressIndexRanges(closed.asrCompletedIndices),
      asrCompletedCount: closed.asrCompletedIndices.length,
      canonicalRanges: compressIndexRanges(closed.canonicalIndices),
      canonicalCount: closed.canonicalIndices.length,
      maxChunkIndex: closed.maxChunkIndex,
      lastActivityAt: new Date(closed.lastActivityAt).toISOString(),
      retainedUntil: new Date(closed.closedAt + CLOSED_SESSION_TTL_MS).toISOString(),
    }
  }
  return {
    state: 'missing',
    receivedRanges: [],
    receivedCount: 0,
    asrCompletedRanges: [],
    asrCompletedCount: 0,
    canonicalRanges: [],
    canonicalCount: 0,
    maxChunkIndex: -1,
    lastActivityAt: null,
    retainedUntil: null,
  }
}

/** 6.83.2: a close that quarantines under its own reason, clock and terminal receipt (the Mac discard). */
type CloseQuarantine = { reason: string; retentionMs?: number; receipt?: QuarantineReceipt }

function closeTranscriptSession(
  sessionId: string,
  reason: ClosedTranscriptSession['reason'],
  options: { preserveAudio?: boolean; quarantine?: CloseQuarantine } = {},
): string | null {
  // Progressive HQ is disposable cache state. Every terminal session path —
  // save, expiry, quarantine, or abandonment — must release the single owner.
  void stopProgressiveHqSession(sessionId)
  const session = sessions.get(sessionId)
  const now = Date.now()
  const receivedIndices = [...(session?.receivedIndices ?? [])]
  const asrCompletedIndices = [...(session?.asrCompletedIndices ?? [])]
  const canonical = session ? canonicalIndices(session) : []
  const maxChunkIndex = session?.maxChunkIndex ?? (receivedIndices.at(-1) ?? -1)
  closedSessionRecords.set(sessionId, {
    closedAt: now,
    lastActivityAt: session?.lastActivityAt ?? now,
    receivedIndices,
    asrCompletedIndices,
    canonicalIndices: canonical,
    maxChunkIndex,
    reason,
  })
  return finishClosingTranscriptSession(sessionId, { ...options, closeReason: reason })
}

/** Delete session after save */
export function deleteSession(sessionId: string, options: { preserveAudio?: boolean } = {}): void {
  closeTranscriptSession(sessionId, 'saved', options)
}

/** Where a close put the session's chunk audio (the quarantine dir), or null when it moved none. */
function finishClosingTranscriptSession(
  sessionId: string,
  options: { preserveAudio?: boolean; closeReason?: ClosedTranscriptSession['reason']; quarantine?: CloseQuarantine },
): string | null {
  sessions.delete(sessionId)
  sessionAudioBytes.delete(sessionId)
  sessionAudioWrites.delete(sessionId)
  liveProvisional().clear(sessionId)
  // Clean up inline hallucination tracking (was leaking until 4-hour interval fired)
  clearSessionHallucinationState(sessionId)
  // Track as deleted so orphan heartbeats get 410 Gone (prevents zombie client spam)
  rememberDeletedSession(sessionId)
  // A session that reached ANY terminal state keeps neither a liveness veto nor a
  // draft. Leaving the draft would advertise an unsaved capture that is now saved,
  // which is the false-alarm that trains the user to ignore the channel.
  releaseStrandedState(STRANDED_DRAFT_DIR, sessionId)
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
  } else if (options.closeReason === 'saved') {
    // Saved sessions moved their audio to pending-batch (or explicitly
    // preserved it above); a leftover dir here is residue, safe to delete.
    // UNLESS chunks are still present — hasAudio() returns false on a
    // transient statSync error, which makes preserveAudio false while the
    // move never ran. Chunk-bearing evidence goes to quarantine, never rmSync.
    if (countChunkWavs(audioDir) > 0) {
      const target = quarantineSessionAudio(audioDir, 'close_saved_residual_chunks')
      if (target) console.warn(`[transcribe-stream] Saved-close left chunk audio behind; quarantined: ${sessionId} → ${target}`)
      return target
    } else {
      try { rmSync(audioDir, { recursive: true, force: true }) } catch {}
    }
  } else if (existsSync(audioDir)) {
    // Any non-saved close (expired, error, …) with chunk audio still on disk
    // is an unsaved capture. Quarantine it — never delete evidence (6.19.0).
    if (countChunkWavs(audioDir) > 0) {
      const quarantine = options.quarantine
      const target = quarantineSessionAudio(audioDir, quarantine?.reason ?? `close_${options.closeReason ?? 'unknown'}`, undefined,
        quarantine ? { retentionMs: quarantine.retentionMs, receipt: quarantine.receipt } : {})
      if (target) console.warn(`[transcribe-stream] Quarantined unsaved session-audio on close: ${sessionId} → ${target}`)
      else console.error(`[transcribe-stream] Quarantine move failed on close, source retained: ${sessionId}`)
      return target
    } else {
      try { rmSync(audioDir, { recursive: true, force: true }) } catch {}
    }
  }
  return null
}

// ── 6.83.2: discard a stranded Mac capture that holds no sound ─────────────────────
// Miles, 2026-10-21: Record on Mac captured a 21-minute Zoom call as 211 chunks of exact zeros (macOS returns
// zeros, not an error, when system audio recording is not allowed). The save refused it (no_speech), and the
// capture then sat in the stranded list with a Save that can never work. COS Control asks the server to let it go.
//
// What it may touch: a Mac capture (Control is its only uploader, so nothing else will send it a chunk) that is in
// memory, holds NO canonical chunk (no transcribed text, so no speech), has finished ASR on every chunk it received
// (an in-flight chunk could still become speech), is idle past EMPTY_SESSION_STALE_MS, and has no chunk upload in
// progress. Anything else is refused and left exactly as it was. The audio is never deleted here: it moves into the
// existing quarantine with a terminal no_speech receipt and a 24-hour clock (DISCARDED_RETENTION_MS).
export type MacDiscardRefusal =
  | 'session_not_found' | 'not_mac_capture' | 'has_speech' | 'asr_in_progress' | 'not_idle' | 'chunk_in_progress'

export interface MacDiscardResult {
  ok: boolean
  reason?: MacDiscardRefusal
  sessionId: string
  /** The quarantine dir the audio moved into, or null when the capture held no chunk audio. */
  quarantined: string | null
  chunkFiles: number
  receivedCount: number
  retainedUntil: string | null
}

export const MAC_DISCARD_IDLE_MS = EMPTY_SESSION_STALE_MS

/** Why a session may not be discarded, or null when it may. Pure over the session's ledger. */
export function macDiscardRefusal(input: {
  sessionId: string
  present: boolean
  canonicalCount: number
  receivedIndices: number[]
  asrCompletedIndices: number[]
  silentForMs: number
  chunkInProgress: boolean
}): MacDiscardRefusal | null {
  if (!MAC_CAPTURE_ID.test(input.sessionId)) return 'not_mac_capture'
  if (!input.present) return 'session_not_found'
  if (input.canonicalCount > 0) return 'has_speech'
  const completed = new Set(input.asrCompletedIndices)
  if (input.receivedIndices.some(index => !completed.has(index))) return 'asr_in_progress'
  if (input.chunkInProgress) return 'chunk_in_progress'
  if (input.silentForMs < MAC_DISCARD_IDLE_MS) return 'not_idle'
  return null
}

export async function discardSilentMacCapture(sessionId: string, options: { now?: number; dryRun?: boolean } = {}): Promise<MacDiscardResult> {
  const now = options.now ?? Date.now()
  const refusalFor = () => {
    const session = sessions.get(sessionId)
    return {
      session,
      refusal: macDiscardRefusal({
        sessionId,
        present: !!session,
        canonicalCount: session ? canonicalIndices(session).length : 0,
        receivedIndices: session?.receivedIndices ?? [],
        asrCompletedIndices: session?.asrCompletedIndices ?? [],
        silentForMs: session ? now - session.lastActivityAt : 0,
        chunkInProgress: macChunkLocks.has(sessionId),
      }),
    }
  }
  const empty = (reason: MacDiscardRefusal, receivedCount = 0): MacDiscardResult =>
    ({ ok: false, reason, sessionId, quarantined: null, chunkFiles: 0, receivedCount, retainedUntil: null })
  const first = refusalFor()
  if (first.refusal) return empty(first.refusal, first.session?.receivedIndices?.length ?? 0)
  if (options.dryRun) {
    const audioDir = getSessionAudioDirectory(sessionId)
    return { ok: true, sessionId, quarantined: null, chunkFiles: audioDir ? countChunkWavs(audioDir) : 0,
      receivedCount: first.session?.receivedIndices?.length ?? 0, retainedUntil: null }
  }
  // Every chunk write this session started reaches disk before its directory moves.
  await drainSessionAudioWrites(sessionId)
  // Ask again after the await: a chunk may have arrived meanwhile.
  const second = refusalFor()
  if (second.refusal) return empty(second.refusal, second.session?.receivedIndices?.length ?? 0)
  const receivedCount = second.session?.receivedIndices?.length ?? 0
  const quarantined = closeTranscriptSession(sessionId, 'closed', {
    quarantine: {
      reason: 'discarded_no_sound',
      retentionMs: DISCARDED_RETENTION_MS,
      receipt: { outcome: 'no_speech', discarded: true, note: 'Discarded from COS Control: no sound was captured. Audio retained until its 24-hour clock clears it.' },
    },
  })
  // A late chunk or a replayed start for this capture answers 410 from here on.
  closeMacRecording(sessionId)
  return {
    ok: true,
    sessionId,
    quarantined,
    chunkFiles: quarantined ? countChunkWavs(quarantined) : 0,
    receivedCount,
    retainedUntil: quarantined ? new Date(Date.now() + DISCARDED_RETENTION_MS).toISOString() : null,
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

function assertPinnedServerIdentity(headerValue: unknown, queryValue: unknown): string {
  const headerPin = typeof headerValue === 'string' ? headerValue.trim() : ''
  const queryPin = typeof queryValue === 'string' ? queryValue.trim() : ''
  if (headerPin && queryPin && headerPin !== queryPin) {
    throw makeHttpError(409, 'conflicting server identity pins', 'server_instance_mismatch')
  }
  const supplied = headerPin || queryPin
  const serverInstanceId = getServerInstanceId()
  // Omission is the legacy route contract. Capability-admitted clients pin.
  if (!supplied) return serverInstanceId ?? ''
  if (!serverInstanceId) throw makeHttpError(503, 'server identity unavailable', 'server_identity_unavailable')
  if (supplied !== serverInstanceId) {
    throw makeHttpError(409, 'server identity mismatch', 'server_instance_mismatch')
  }
  return serverInstanceId
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

async function readBoundedRawBody(
  req: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number,
): Promise<Buffer> {
  const buffers: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw makeHttpError(413, 'audio chunk too large', 'chunk_too_large')
    buffers.push(buffer)
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
  // 6.83.1: correction-only forms ("/pricing") go back to speech BEFORE the 250-character cut.
  return decoderContextWindow(cleanedContext, decoderCorrections()) ?? ''
}

/** The corrections map for the decoder window; a test double without it reads as none. */
function decoderCorrections(): Record<string, string> {
  try { return getWhisperCorrections() } catch { return {} }
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
      console.log(`[hallucination] Dropped (${dropReason}, q=${isQuiet ? 1 : 0}): chars=${trimmedText.length}`)
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
      console.log(`[hallucination] Dropped (vocab_echo, q=${isQuiet ? 1 : 0}, streak=${streak}): chars=${trimmedText.length}`)
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
): StreamChunkCompletionResponse {
  const serverInstanceId = getServerInstanceId() ?? ''
  return {
    text: existing.text,
    speaker: existing.speaker,
    chunkIndex,
    elapsed: existing.elapsed,
    sessionId,
    serverInstanceId,
    asrCompleted: true,
    canonical: true,
    backend: existing.backend,
    asrProvider: existing.asrProvider,
    ...(existing.model ? { model: existing.model } : {}),
    ...(existing.latencyMs !== undefined ? { latencyMs: existing.latencyMs } : {}),
    fallbackReason: existing.fallbackReason,
    ...(existing.segments?.length ? { segments: existing.segments } : {}),
  }
}

function emptyChunkResponse(
  existing: EmptyTranscriptCompletion,
  sessionId: string,
  chunkIndex: number,
): StreamChunkCompletionResponse {
  const serverInstanceId = getServerInstanceId() ?? ''
  return {
    ...existing,
    chunkIndex,
    sessionId,
    serverInstanceId,
    asrCompleted: true,
    canonical: false,
  }
}

async function transcribeWithServerWhisper(audioBuffer: Buffer, whisperAudio: Buffer, whisperContext: string, isQuiet: boolean): Promise<{ text: string; words?: WhisperWord[]; backend: string }> {
  // The worker owns reconciliation of stale health. Always attempt local ASR
  // once; an availability snapshot must not divert meeting audio to cloud.
  try {
    const result = await transcribeLocal(whisperAudio, whisperContext || undefined, isQuiet)
    return { text: result.text, words: result.words, backend: `local-${result.backend}` }
  } catch (err: unknown) {
    if (!isOpenAIWhisperFallbackReady()) {
      const fallback = getTranscriptionPolicySnapshot()
      console.warn(`[transcribe-stream] Local Whisper unavailable; preserving chunk for retry: ${errMsg(err)}`)
      throw new TranscriptionUnavailableError(
        fallback.openaiFallbackConfigured ? 'openai_key_missing' : 'local_asr_unavailable',
        fallback.openaiFallbackConfigured
          ? 'Local transcription is unavailable; audio is preserved for retry and the configured OpenAI fallback has no key'
          : 'Local transcription is unavailable; audio is preserved for retry',
      )
    }
    console.warn(`[transcribe-stream] Local Whisper failed; using explicitly enabled OpenAI fallback: ${errMsg(err)}`)
    const text = await transcribeViaCloud(whisperAudio)
    return { text, words: undefined, backend: 'cloud' }
  }
}

/** 6.90.0 calibration tags for Mac audio: the whole-chunk shadow score, and one Nemotron track. */
export const MAC_SHADOW_EVENT = 'mac-shadow'
export const MAC_TRACK_EVENT = 'mac-nemotron-track'

/** The wearer's label for the 6.61.1 owner guard; null when the profile cannot say. */
function ownerLabelOrNull(): string | null {
  try { return getOwnerSpeakerLabel() } catch { return null }
}

function identifyChunkSpeaker(audioBuffer: Buffer, sessionId: string, chunkIndex: number, clientSpeaker: string, policy: SpeakerMode): { speaker: string; similarity: number } {
  if (policy === 'anonymous') return { speaker: 'Ext', similarity: 0 }
  const expectedSpeakers = undefined
  const audioDurationSec = Math.max(0, (audioBuffer.length - 44)) / 32000
  if (!isEmbeddingAvailable() || audioDurationSec < VOICEPRINT_MIN_AUDIO_SEC) return policyLabel({ speaker: clientSpeaker, similarity: 0 }, policy)

  const tEmb = performance.now()
  const embeddingResult = identifySpeaker(audioBuffer, expectedSpeakers, { minSimilarity: policy === 'high-confidence' ? AUTO_ENROLL_THRESHOLD : undefined, ...(MAC_CAPTURE_ID.test(sessionId) ? { prioritizeOwner: false, event: 'mac-system-audio', shadowEvent: MAC_SHADOW_EVENT } : {}) })
  console.log(`[perf] identifySpeaker: ${(performance.now() - tEmb).toFixed(1)}ms`)
  if (!embeddingResult) return policyLabel({ speaker: clientSpeaker, similarity: 0 }, policy)

  // Bank the embedding before anything else can return. This is the only moment
  // it exists: identifySpeaker computes it per chunk and nothing else keeps it,
  // so a correction made later has no acoustic evidence without this write.
  // Deliberately includes 'Ext' — an unidentified voice is the case with no
  // other way to be trained. Mac playback is recognition-only: never bank
  // its voiceprints or create auxiliary training-audio copies.
  if (embeddingResult.embedding && !MAC_CAPTURE_ID.test(sessionId)) {
    appendChunkEmbedding(sessionId, {
      i: chunkIndex,
      speaker: policyLabel(embeddingResult, policy).speaker,
      similarity: embeddingResult.similarity,
      embedding: embeddingResult.embedding,
    })
  }

  let speaker = policyLabel(embeddingResult, policy).speaker
  if (speaker !== clientSpeaker) {
    console.log(`[speaker] Embedding: ${speaker} vs Amplitude: ${clientSpeaker} (sim: ${embeddingResult.similarity.toFixed(2)})`)
  }

  if (policy === 'standard' && embeddingResult.similarity >= AUTO_ENROLL_CANDIDATE_SIMILARITY && speaker !== 'Ext') {
    const enrollResult = autoEnroll(speaker, audioBuffer, embeddingResult.similarity, sessionId)
    if (enrollResult.enrolled) {
      console.log(`[speaker] Auto-enrolled ${speaker} from G2 mic (sim: ${embeddingResult.similarity.toFixed(3)})`)
    }
  }

  if (policy === 'standard' && speaker !== 'Ext' && embeddingResult.similarity > 0.50) {
    // Audio has its own count and TTL. A full profile still needs examples
    // from new meetings; deleting/expiring old audio immediately frees a slot.
    try {
      const speakerDir = resolve(AUDIO_SAVE_DIR, speaker.replace(/\s+/g, '_'))
      ensurePrivateDirectory(speakerDir)
      const filename = `${sessionId}_chunk${chunkIndex}_sim${embeddingResult.similarity.toFixed(2)}.wav`
      saveTrainingAudioSample(speakerDir, filename, audioBuffer).then(saved => {
        if (saved) console.log(`[training-audio] Saved ${speaker} chunk (sim=${embeddingResult.similarity.toFixed(2)}, ${audioBuffer.length}b)`)
      }).catch(err => console.warn(`[training-audio] Async save failed for ${speaker}: ${err.message}`))
    } catch (audioSaveErr: unknown) {
      console.warn(`[training-audio] Save failed for ${speaker}: ${errMsg(audioSaveErr)}`)
    }
  }

  if (speaker === 'Ext' && audioBuffer.length >= 16000 && !MAC_CAPTURE_ID.test(sessionId)) {
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

/**
 * 6.81.0: the phone re-sends a chunk after the server saved its meeting on its own.
 *
 * WHY. The server saves a stopped meeting itself only once it holds every chunk, so any chunk
 * the phone still lists as unconfirmed is one whose upload reached the Mac and whose answer
 * was lost while the phone was off screen. Before 6.81.0 such a replay was refused 410 and the
 * phone, holding a closed meeting with "unconfirmed" audio, called it a collision and kept the
 * audio forever. The saved meeting already holds that chunk, so it answers with the saved
 * text, exactly as a live session answers a replayed index, and the phone adopts the receipt.
 *
 * ONLY for meetings the SERVER saved after a Stop: every other closed session answers 410 as
 * before. A chunk the saved meeting never held is still refused, and is logged loudly, because
 * the finalizer's rule (never save an incomplete capture) says it cannot happen.
 */
function replayAfterAutonomousSave(sessionId: string, chunkIndex: number): StreamChunkCompletionResponse | null {
  let intent: StopIntent | null
  try { intent = getStopIntentStore().get(sessionId) } catch { return null }
  if (!intent || intent.state !== 'saved' || intent.savedBy !== 'server' || !intent.sidecarPath) return null
  const closed = closedSessionRecords.get(sessionId)
  const replay = savedChunkReplay(intent.sidecarPath, chunkIndex, closed?.asrCompletedIndices ?? [])
  const store = getStopIntentStore()
  if (!replay) {
    store.update(sessionId, { lateRefused: (intent.lateRefused ?? 0) + 1 })
    const fields = { sessionId, chunkIndex, finalChunkIndex: intent.finalChunkIndex, lateRefused: (intent.lateRefused ?? 0) + 1 }
    console.warn(`[meeting/auto-save] late_chunk_refused ${sessionId} ${JSON.stringify(fields)}`)
    appendAutonomousSaveLog('late_chunk_refused', fields)
    return null
  }
  const at = Date.now()
  store.update(sessionId, {
    lateReplays: (intent.lateReplays ?? 0) + 1,
    ...(intent.phoneConfirmedAt ? {} : { phoneConfirmedAt: at, phoneConfirmedBy: 'chunk_replay' }),
  })
  const fields = { sessionId, chunkIndex, kind: replay.kind, lateReplays: (intent.lateReplays ?? 0) + 1, sinceSaveMs: at - (intent.savedAt ?? at) }
  console.log(`[meeting/auto-save] late_replay ${sessionId} ${JSON.stringify(fields)}`)
  appendAutonomousSaveLog('late_replay', fields)
  if (!intent.phoneConfirmedAt) appendAutonomousSaveLog('phone_confirmed', { sessionId, via: 'chunk_replay', sinceSaveMs: at - (intent.savedAt ?? at) })
  if (replay.kind === 'canonical') return canonicalChunkResponse(replay.chunk as unknown as TranscriptChunk, sessionId, chunkIndex)
  return emptyChunkResponse({ text: '', speaker: 'Ext', elapsed: 0, canonical: false }, sessionId, chunkIndex)
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
  audioDurationMs?: number
  evenHubSpeakerRole?: EvenSpeakerRoleHistogram
}): Promise<StreamChunkCompletionResponse> {
  const { sessionId, chunkIndex, clientSpeaker, audioBuffer, candidate } = opts
  const evenHubSpeakerRole = evenSpeakerRoleMode() === 'off' ? undefined : opts.evenHubSpeakerRole
  if (evenHubSpeakerRole) warnEvenSpeakerRoleApplyNotImplemented()
  const tReq = performance.now()
  validateSessionId(sessionId)
  validateChunkIndex(chunkIndex)
  if (isSessionDeleted(sessionId)) {
    // 6.81.0: a meeting the server saved on its own answers a chunk it already holds.
    const replay = replayAfterAutonomousSave(sessionId, chunkIndex)
    if (replay) return replay
    throw makeHttpError(410, 'session is closed', 'session_closed')
  }
  if (audioBuffer.length < 100) throw makeHttpError(400, 'audio too short', 'audio_too_short')

  const audioSha256 = sha256Hex(audioBuffer)
  const session = getSession(sessionId)
  if (opts.startTimeOverride && session.chunks.filter(Boolean).length === 0) {
    session.startTime = opts.startTimeOverride
  }
  const alreadyCanonical = session.chunks[chunkIndex]
  const alreadyEmpty = session.emptyCompletions?.[String(chunkIndex)]

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
  if (alreadyCanonical?.text) {
    session.lastActivityAt = Date.now()
    recordReceivedChunk(session, chunkIndex)
    recordAsrCompleted(session, chunkIndex, sessionId)
    if (candidate && candidateRecordKey) {
      session.providerCandidates![candidateRecordKey].accepted =
        alreadyCanonical.asrProvider === 'iphone-whisperkit-beta' && alreadyCanonical.audioSha256 === audioSha256
      session.providerCandidates![candidateRecordKey].fallbackReason =
        session.providerCandidates![candidateRecordKey].accepted ? undefined : 'canonical_exists'
    }
    persistSessionRequired(sessionId)
    return canonicalChunkResponse(alreadyCanonical, sessionId, chunkIndex)
  }
  if (alreadyEmpty) {
    session.lastActivityAt = Date.now()
    recordReceivedChunk(session, chunkIndex)
    recordAsrCompleted(session, chunkIndex, sessionId)
    persistSessionRequired(sessionId)
    return emptyChunkResponse(alreadyEmpty, sessionId, chunkIndex)
  }

  // Pin identity policy at acceptance, before persistence, ASR or diarization
  // yields. A later loosening applies to the next chunk, never this audio.
  const capturePolicy = MAC_CAPTURE_ID.test(sessionId) ? (requireMacRecording(sessionId), 'high-confidence' as const) : readSpeakerPolicy(sessionId).mode
  await persistRawSessionAudioChunk(sessionId, chunkIndex, audioBuffer)
  // Commit the received-index ledger only after the canonical raw WAV is
  // durable. A failure is typed non-2xx and a retry remains safe.
  session.lastActivityAt = Date.now()
  recordReceivedChunk(session, chunkIndex)
  persistSessionRequired(sessionId)

  // 6.61.0: Nemotron reads the durable WAV just written, in parallel with
  // Whisper, on the Neural Engine, inside its own budget. It is started before
  // the synchronous voiceprint so the process is already running while that
  // blocks. diarize() never throws; a fallback returns a reason.
  const diarizeStartedAt = performance.now()
  const diarizePromise = nemotronLive.diarize(
    resolve(SESSION_AUDIO_DIR, sessionId, `chunk_${String(chunkIndex).padStart(4, '0')}.wav`),
  )

  // 6.72.0: the quiet gate and the ASR front end follow the STT settings, read
  // per chunk so a change applies from the next chunk. Defaults: Silero speech
  // seconds (RMS 150 fired on 1% of G2 chunks) and highpass only (the full
  // chain lifted faint background speech over the VAD). Playback audio is
  // separate and unchanged.
  const stt = readSttSettings()
  const quiet = decideQuiet(audioBuffer, stt.quietGate)
  const rms = quiet.rms
  const isQuiet = quiet.isQuiet
  // 6.87.0: the level strip's two numbers, on the record every terminal path below persists. Not text, never logged.
  session.chunkLevels = withChunkLevel(session.chunkLevels, chunkLevel(chunkIndex, rms, quiet.speechSec))
  const whisperAudio = isQuiet ? audioBuffer : await asrFrontEnd(audioBuffer, stt.frontEnd)
  const whisperContext = recentWhisperContext(sessionId, session)
  console.log(`[perf] whisperContext: ${whisperContext.length}b | session.chunks: ${session.chunks.length}`)

  const speakerPromise = Promise.resolve(identifyChunkSpeaker(audioBuffer, sessionId, chunkIndex, clientSpeaker, capturePolicy))

  let rawText = ''
  let words: WhisperWord[] | undefined
  let backend = 'candidate'
  let asrProvider: 'server-whisper' | 'server-parakeet' | 'iphone-whisperkit-beta' = 'server-whisper'
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
  } else if (MAC_CAPTURE_ID.test(sessionId) && stt.hq === 'parakeet-ultra') {
    // Use the stored choice directly. effectiveStt/preview intentionally fall
    // back when unavailable, which is not an acceptable canonical Mac commit.
    const result = await transcribeMacParakeet(whisperAudio, quiet.speechSec)
    rawText = result.text
    words = result.words
    backend = result.backend
    asrProvider = result.asrProvider
    model = result.model
    latencyMs = result.latencyMs
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

  // Text drops stay on the pre-6.72 RMS test (see the contract above).
  const dropQuiet = silenceDropsAllowed(quiet)
  let sanitized = sanitizeStreamTranscript(sessionId, session, rawText, dropQuiet)
  if (candidate && (!sanitized.text || sanitized.fallbackReason)) {
    fallbackReason = sanitized.fallbackReason || 'empty_candidate'
    const result = await transcribeWithServerWhisper(audioBuffer, whisperAudio, whisperContext, isQuiet)
    rawText = applyCorrections(result.text)
    words = result.words
    backend = result.backend
    asrProvider = 'server-whisper'
    sanitized = sanitizeStreamTranscript(sessionId, session, rawText, dropQuiet)
  }

  const voiceprint = await speakerPromise
  if (evenHubSpeakerRole) {
    console.log(formatEvenRoleAgreement({
      chunkIndex,
      even: evenHubSpeakerRole,
      amp: clientSpeaker,
      emb: voiceprint.speaker,
      similarity: voiceprint.similarity,
    }))
  }
  // Client time is authoritative for live network jitter and deferred replay.
  const elapsed = Number.isFinite(opts.clientElapsed) && (opts.clientElapsed as number) >= 0
    ? Math.round(opts.clientElapsed as number)
    : Date.now() - session.startTime
  const trimmedText = sanitized.text

  // Stage continuity alongside this chunk. Empty/losing results cannot mutate
  // the session's anchors. Accepted canonical chunks commit both in one durable
  // active-session write; a failed write returns non-2xx and replay retries it.
  let nextMacLiveVoices = session.macLiveVoices === undefined ? undefined : structuredClone(session.macLiveVoices)
  // Nemotron separates the voices; the voiceprint names each one. Any fallback
  // keeps today's whole-chunk voiceprint label. Only chunks with text count.
  const labels = trimmedText
    ? await resolveLiveLabels({
        diarize: diarizePromise,
        startedAt: diarizeStartedAt,
        text: trimmedText,
        words,
        audio: audioBuffer,
        voiceprint,
        clientSpeaker,
        owner: ownerLabelOrNull(),
        ...(MAC_CAPTURE_ID.test(sessionId) && macVoiceLabelsEnabled() ? {
          anonymousVoice: (wav: Buffer) => {
            // Fail closed after an upgrade/recovery lacking acoustic anchors:
            // never reuse Voice 1 for an unrelated person from a later chunk.
            if (!nextMacLiveVoices && session.chunks.some(c => isVoiceLabel(c?.speaker) || c?.segments?.some(s => isVoiceLabel(s.speaker)))) return null
            nextMacLiveVoices ??= { version: 1, anchors: [] }
            return matchMacLiveVoice(nextMacLiveVoices, extractEmbedding(wav), chunkIndex, audioSha256)
          },
        } : {}),
        identify: wav => {
          const policy = capturePolicy
          if (policy === 'anonymous') return { speaker: 'Ext', similarity: 0 }
          // 6.90.0: a Mac track is never checked against the wearer first (the wearer
          // is not in Mac playback) and is tagged so its calibration rows are separable.
          const mac = MAC_CAPTURE_ID.test(sessionId)
          const named = identifySpeaker(wav, undefined, {
            event: mac ? MAC_TRACK_EVENT : 'nemotron-track',
            minSimilarity: policy === 'high-confidence' ? AUTO_ENROLL_THRESHOLD : undefined,
            ...(mac ? { prioritizeOwner: false } : {}),
          })
          return named ? policyLabel({ speaker: named.speaker, similarity: named.similarity }, policy) : null
        },
      })
    : { speaker: voiceprint.speaker, similarity: voiceprint.similarity }
  if (labels.record) nemotronLive.record({ sessionId, chunkIndex }, labels.record)
  // Strict named identity is unchanged. Only this server's successful Mac
  // Nemotron path can retain an anonymous label at similarity zero.
  const project = <T extends { speaker: string; similarity?: number }>(value: T): T => {
    const strict = policyLabel(value, capturePolicy)
    return MAC_CAPTURE_ID.test(sessionId) && labels.diarizer?.engine === 'nemotron' && macVoiceLabelsEnabled()
      ? macAnonymousProjection(value, strict) : strict
  }
  const { speaker, similarity } = project(labels)
  if (labels.segments) labels.segments = labels.segments.map(project)

  if (!trimmedText) {
    console.log(`[hallucination] Filtered (${sanitized.fallbackReason || fallbackReason || 'empty'}): chars=${rawText.length}`)
    if (candidate && candidateRecordKey && session.providerCandidates?.[candidateRecordKey]) {
      session.providerCandidates[candidateRecordKey].accepted = false
      session.providerCandidates[candidateRecordKey].fallbackReason = sanitized.fallbackReason || fallbackReason || 'empty'
    }
    const emptyCompletion: EmptyTranscriptCompletion = {
      text: '',
      speaker: clientSpeaker,
      elapsed,
      backend,
      asrProvider,
      ...(model ? { model } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      fallbackReason: sanitized.fallbackReason || fallbackReason,
      audioSha256,
      canonical: false,
    }
    session.emptyCompletions ??= {}
    session.emptyCompletions[String(chunkIndex)] = emptyCompletion
    recordAsrCompleted(session, chunkIndex, sessionId)
    persistSessionRequired(sessionId)
    scheduleSessionProgressiveHq(sessionId)
    return emptyChunkResponse(emptyCompletion, sessionId, chunkIndex)
  }

  const chunk: TranscriptChunk = {
    text: trimmedText,
    speakerPolicy: capturePolicy,
    ...(opts.audioDurationMs !== undefined ? { audioDurationMs: opts.audioDurationMs } : {}),
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
    evenHubSpeakerRole,
    ...(labels.segments?.length ? { segments: labels.segments } : {}),
    ...(labels.diarizer ? { diarizer: labels.diarizer } : {}),
  }
  const finalExisting = session.chunks[chunkIndex]
  if (finalExisting?.text) {
    if (candidate && candidateRecordKey && session.providerCandidates?.[candidateRecordKey]) {
      session.providerCandidates[candidateRecordKey].accepted =
        finalExisting.asrProvider === 'iphone-whisperkit-beta' && finalExisting.audioSha256 === audioSha256
      session.providerCandidates[candidateRecordKey].fallbackReason =
        session.providerCandidates[candidateRecordKey].accepted ? undefined : 'canonical_exists'
    }
    session.lastActivityAt = Date.now()
    recordAsrCompleted(session, chunkIndex, sessionId)
    persistSessionRequired(sessionId)
    return canonicalChunkResponse(finalExisting, sessionId, chunkIndex)
  }
  session.chunks[chunkIndex] = chunk
  if (nextMacLiveVoices !== undefined) session.macLiveVoices = nextMacLiveVoices
  recordAsrCompleted(session, chunkIndex, sessionId)
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

  scheduleSessionProgressiveHq(sessionId)

  emitDisplay({
    type: 'transcript_chunk',
    data: { text: trimmedText, speaker, chunkIndex, elapsed, sessionId, ...(chunk.segments ? { segments: chunk.segments } : {}) },
  })
  // Live Cues feed — fire-and-forget, NEVER awaited: transcription must not
  // block on a cue, and no LLM runs on this path. .catch() is required — a
  // bare `void` on a rejecting promise is an unhandled rejection, which Node
  // throws on by default. All gates live inside the feed.
  // The ASR await above lets a late chunk land after Stop or save; a closed session never feeds cues.
  if (!isSessionDeleted(sessionId)) void feedLiveCueTranscript(sessionId, trimmedText, Boolean(fallbackReason)).catch(() => {})

  // 6.85.0: timing and the character count only. This line runs for every chunk, so the meeting
  // text itself never goes to the server log (transcribe-stream-log-privacy.test.ts).
  console.log(`[perf] TOTAL request: ${(performance.now() - tReq).toFixed(1)}ms | chunk #${chunkIndex} | ${audioBuffer.length}b | rms=${Math.round(rms)} q=${isQuiet ? 1 : 0} gate=${quiet.gate}${quiet.speechSec === null ? '' : ` speech=${quiet.speechSec.toFixed(2)}s`} fe=${stt.frontEnd} | ${asrProvider} | chars=${trimmedText.length}`)
  return canonicalChunkResponse(chunk, sessionId, chunkIndex)
}

function sendStreamError(res: { status: (code: number) => { json: (body: unknown) => unknown } }, err: unknown): unknown {
  if (err instanceof MacParakeetUnavailableError) {
    return res.status(err.status).json({ error: err.message, reason: err.reason, retryable: true, model: err.model })
  }
  if (err instanceof TranscriptionUnavailableError) {
    console.warn(`[transcribe-stream] ${err.message}`)
    return res.status(err.status).json({
      error: err.message,
      reason: err.reason,
      retryable: true,
    })
  }
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

/**
 * Meeting preview (on unless COS_WHISPER_MEETING_PREVIEW=0).
 *
 * This route deliberately owns no meeting session, recovery ledger, speaker
 * attribution, or persistence. It accepts a pinned copy of the still-open
 * phrase and returns provisional text from the preview engine the STT settings
 * choose (6.72.0: Whisper Turbo, or Parakeet Ultra when selected, warm, and the
 * client lists `parakeet-ultra` in `previewModels`; every other client gets
 * Turbo). Any contention or failure is a 204 cosmetic miss; the canonical
 * /transcribe-stream upload remains the only durable and speaker-attributed result.
 */
transcribeStreamRouter.post('/transcribe-stream/preview', async (req, res) => {
  try {
    if (!meetingTurboPreviewEnabled() || !maintenanceAdmissionsOpen()) {
      return void res.status(204).send()
    }

    const headerPin = req.get('X-COS-Server-Instance')?.trim() ?? ''
    const queryPin = typeof req.query.serverInstanceId === 'string'
      ? req.query.serverInstanceId.trim()
      : ''
    if (!headerPin && !queryPin) {
      throw makeHttpError(400, 'server identity pin required', 'server_identity_pin_required')
    }
    const serverInstanceId = assertPinnedServerIdentity(headerPin, queryPin)
    const sessionId = String(req.query.sessionId ?? '')
    validateSessionId(sessionId)
    const chunkIndex = Number(req.query.chunkIndex)
    validateChunkIndex(chunkIndex)
    const previewGen = Number(req.query.previewGen)
    if (!Number.isInteger(previewGen) || previewGen < 0 || previewGen > 1_000_000_000) {
      throw makeHttpError(400, 'invalid previewGen', 'invalid_preview_generation')
    }

    const audio = await readBoundedRawBody(req, MEETING_PREVIEW_MAX_BYTES)
    if (audio.length < 100) throw makeHttpError(400, 'audio too short', 'audio_too_short')
    if (!maintenanceAdmissionsOpen() || meetingPreviewBusy) {
      return void res.status(204).send()
    }

    meetingPreviewBusy = true
    try {
      // 6.72.0: the models this client accepts. Absent (every phone before 6.10.639): Turbo only.
      const rawModels = typeof req.query.previewModels === 'string' ? req.query.previewModels.slice(0, 200) : ''
      const accepted = rawModels.split(',').map(m => m.trim()).filter(Boolean).slice(0, 8)
      const result = await transcribeMeetingPreview(audio, accepted)
      if (!result) return void res.status(204).send()
      const cleaned = stripInlineHallucinationsOneShot(result.text.trim()).trim()
      if (!cleaned || sharedIsFullHallucination(cleaned)) {
        return void res.status(204).send()
      }
      noteLiveProvisional(sessionId, chunkIndex, previewGen, cleaned, result.model)
      return void res.json({
        sessionId,
        chunkIndex,
        previewGen,
        text: cleaned,
        provisional: true,
        model: result.model,
        backend: result.backend,
        serverInstanceId,
      })
    } finally {
      meetingPreviewBusy = false
    }
  } catch (err: unknown) {
    sendStreamError(res, err)
  }
})

/**
 * 6.86.0: GET /transcribe-stream/provisional?sessionId=<id>. The newest provisional text of a live meeting, for COS
 * Control's grey line (live-provisional.ts). Token-authenticated like every /api route; private, no-store. Memory only:
 * a restart, a save or a settled chunk empties it. `live` is false when this server holds no open session by that id.
 */
transcribeStreamRouter.get('/transcribe-stream/provisional', (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : ''
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return void res.status(400).json({ error: 'invalid sessionId', reason: 'invalid_session_id' })
  const live = sessions.has(sessionId)
  const held = live ? liveProvisional().read(sessionId) : null
  res.json({ v: 1, sessionId, live, provisional: held, serverInstanceId: getServerInstanceId() })
})

/** Unlike the received ledger, only these canonical completions acknowledge ASR.
 * A native stop supplies the total captured chunks, including its last tail. */
export function assertMacCaptureComplete(sessionId: string, expectedChunkCount: unknown): void {
  if (!Number.isInteger(expectedChunkCount) || Number(expectedChunkCount) < 1 || Number(expectedChunkCount) > 10000) {
    throw macError(400, 'mac_chunk_count_required', 'Mac save requires the total captured chunk count')
  }
  const session = sessions.get(sessionId)
  const expected = Number(expectedChunkCount)
  const missingIndices: number[] = []
  for (let index = 0; index < expected; index++) {
    if (!session?.chunks[index] && !session?.emptyCompletions?.[String(index)]) missingIndices.push(index)
  }
  if (missingIndices.length || (session?.maxChunkIndex ?? -1) >= expected) {
    throw Object.assign(macError(409, 'mac_capture_incomplete', 'Mac audio is not fully acknowledged; retry pending chunks before saving'), { missingIndices })
  }
}

// Manual Mac pilot: independent from iPhone candidate and cue rollout gates.
transcribeStreamRouter.get('/mac-recording/capabilities', (_req, res) => {
  // 6.83.2: `discard` advertises POST /api/meeting/sessions/:id/discard for a stranded no-sound capture. Older
  // servers omit it, and COS Control then discards only its own local copy and says so.
  res.set('Cache-Control', 'private, no-store').json({ available: true, ...MAC_AUDIO, serverInstanceId: getServerInstanceId(), discard: true })
})
function requireMacPin(req: { get(name: string): string | undefined }): string {
  const pin = req.get('X-COS-Server-Instance')?.trim()
  if (!pin) throw macError(400, 'server_identity_pin_required', 'Server identity pin required')
  return assertPinnedServerIdentity(pin, undefined)
}
transcribeStreamRouter.post('/mac-recording/start', (req, res) => {
  let lease: MaintenanceWorkLease | undefined
  try {
    const serverInstanceId = requireMacPin(req)
    if (typeof req.body?.captureId !== 'string' || !MAC_CAPTURE_ID.test(req.body.captureId)) throw macError(400, 'invalid_capture_id', 'Invalid Mac capture ID')
    // 6.86.0: `liveCues: true` asks for live cues on this recording (COS Control's live meeting view). Checked before
    // anything is written, so a bad body admits nothing.
    if (req.body.liveCues !== undefined && typeof req.body.liveCues !== 'boolean') throw macError(400, 'invalid_live_cues', 'liveCues must be true or false')
    if (isSessionDeleted(req.body.captureId) || getMeetingStore().findBySessionId(req.body.captureId)) throw macError(410, 'session_closed', 'Capture is closed')
    // An existing non-Mac session may not acquire new source metadata.
    if (sessions.has(req.body.captureId) && !readMacRecording(req.body.captureId)) throw macError(409, 'mac_capture_conflict', 'Capture ID already exists')
    lease = acquireRecordingChunkLease({ allowDuringDrain: sessions.has(req.body.captureId) })
    const { recording, replayed } = registerMacRecording(req.body)
    const session = getSession(recording.sessionId)
    if (!session.chunks.some(Boolean)) session.startTime = recording.startTime
    persistSessionRequired(recording.sessionId)
    // Arming happens only after the recording is admitted, and its answer never fails the start (armMacLiveCues returns a
    // reason code instead of throwing). Without `liveCues: true` the answer is byte for byte what 6.85.0 sent.
    let liveCues: MacLiveCuesAnswer | undefined
    if (req.body.liveCues === true) {
      try { liveCues = armMacLiveCues(recording.sessionId) } catch { liveCues = { armed: false, reason: 'unavailable' } }
    }
    res.json({ ...MAC_AUDIO, ...recording, replayed, serverInstanceId, ...(liveCues ? { liveCues } : {}) })
  } catch (error) { sendStreamError(res, error) } finally { lease?.release() }
})
const macChunkLocks = new Set<string>()
transcribeStreamRouter.post('/mac-recording/:captureId/chunks', async (req, res) => {
  let lease: MaintenanceWorkLease | undefined
  let locked = false
  const id = String(req.params.captureId ?? '')
  try {
    requireMacPin(req)
    const recording = requireMacRecording(id)
    if (isSessionDeleted(id)) throw macError(410, 'session_closed', 'Capture is closed')
    const chunkIndex = Number(req.query.chunkIndex)
    validateChunkIndex(chunkIndex)
    const elapsed = Number(req.query.elapsed)
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 24 * 60 * 60 * 1000) throw macError(400, 'invalid_elapsed', 'Valid capture elapsed time required')
    if (macChunkLocks.has(id)) throw macError(409, 'mac_chunk_in_progress', 'Another chunk is processing; retry the same chunk after its receipt')
    macChunkLocks.add(id); locked = true
    lease = acquireRecordingChunkLease({ allowDuringDrain: sessions.has(id) })
    const audio = await readBoundedRawBody(req, MAC_AUDIO.maxChunkBytes)
    const duration = validateMacWav(audio)
    if (elapsed < duration) throw macError(400, 'invalid_elapsed', 'Chunk end precedes its duration')
    const session = getSession(id)
    persistMacChunkReceipt(id, { chunkIndex, endElapsed: elapsed, durationMs: duration, audioSha256: sha256Hex(audio) })
    const prior = session.chunks[chunkIndex] ?? session.emptyCompletions?.[String(chunkIndex)]
    if (prior?.audioSha256 && prior.audioSha256 !== sha256Hex(audio)) throw macError(409, 'mac_chunk_conflict', 'Chunk index already holds different audio')
    res.json(await processStreamChunk({ sessionId: id, chunkIndex, clientSpeaker: 'Ext', audioBuffer: audio, clientElapsed: elapsed - duration, audioDurationMs: duration, startTimeOverride: recording.startTime }))
  } catch (error) { sendStreamError(res, error) } finally { if (locked) macChunkLocks.delete(id); lease?.release() }
})

transcribeStreamRouter.post('/transcribe-stream', async (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    // Reject a wrong Mac before consuming or persisting any upload bytes.
    assertPinnedServerIdentity(req.get('X-COS-Server-Instance'), req.query.serverInstanceId)
    const sessionId = (req.query.sessionId as string) || `g2_${Date.now()}`
    if (sessionId.startsWith('mac_')) throw macError(400, 'mac_transport_required', 'Use the Mac recording transport for Mac captures')
    maintenanceLease = acquireRecordingChunkLease({
      allowDuringDrain: sessions.has(sessionId),
    })
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
      evenHubSpeakerRole: parseEvenHubSpeakerRoleQuery(req.query.eh),
    }))
  } catch (err: unknown) {
    sendStreamError(res, err)
  } finally {
    maintenanceLease?.release()
  }
})

transcribeStreamRouter.post('/transcribe-stream/offline-sessions/start', async (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    if (!isIosAsrCandidateEnabled()) throw makeHttpError(403, 'iPhone ASR candidates disabled', 'iphone_asr_disabled')
    const body = req.body ?? {}
    const sessionId = String(body.sessionId ?? '')
    validateSessionId(sessionId)
    maintenanceLease = acquireRecordingChunkLease({
      allowDuringDrain: sessions.has(sessionId),
    })
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
  } finally {
    maintenanceLease?.release()
  }
})

transcribeStreamRouter.post('/transcribe-stream/offline-sessions/:sessionId/chunks', async (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    if (!isIosAsrCandidateEnabled()) throw makeHttpError(403, 'iPhone ASR candidates disabled', 'iphone_asr_disabled')
    const sessionId = String(req.params.sessionId ?? '')
    validateSessionId(sessionId)
    maintenanceLease = acquireRecordingChunkLease({
      allowDuringDrain: sessions.has(sessionId),
    })
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
      evenHubSpeakerRole: parseEvenHubSpeakerRoleBody(body.evenHubSpeakerRole),
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
  } finally {
    maintenanceLease?.release()
  }
})

transcribeStreamRouter.post('/transcribe-stream/offline-sessions/:sessionId/finalize', async (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    if (!isIosAsrCandidateEnabled()) throw makeHttpError(403, 'iPhone ASR candidates disabled', 'iphone_asr_disabled')
    const sessionId = String(req.params.sessionId ?? '')
    validateSessionId(sessionId)
    maintenanceLease = acquireRecordingChunkLease({
      allowDuringDrain: sessions.has(sessionId),
    })
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
  } finally {
    maintenanceLease?.release()
  }
})

transcribeStreamRouter.post('/transcribe-stream/candidates', async (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    if (!isIosAsrCandidateEnabled()) throw makeHttpError(403, 'iPhone ASR candidates disabled', 'iphone_asr_disabled')
    const body = req.body ?? {}
    const sessionId = String(body.sessionId ?? '')
    const chunkIndex = Number(body.chunkIndex)
    validateSessionId(sessionId)
    maintenanceLease = acquireRecordingChunkLease({
      allowDuringDrain: sessions.has(sessionId),
    })
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
      evenHubSpeakerRole: parseEvenHubSpeakerRoleBody(body.evenHubSpeakerRole),
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
  } finally {
    maintenanceLease?.release()
  }
})

/** Fallback: transcribe via OpenAI Whisper API.
 *  Budget-gated: throws OpenAIWhisperBudgetExhaustedError if today's $5 cap is spent.
 *  A hung whisper-server + long meeting is the exact scenario this guards against —
 *  chunks stay empty on budget-exceeded instead of silently billing per chunk. */
async function transcribeViaCloud(audioBuffer: Buffer): Promise<string> {
  if (!isOpenAIWhisperFallbackReady()) {
    const fallback = getTranscriptionPolicySnapshot()
    throw new TranscriptionUnavailableError(
      fallback.openaiFallbackConfigured ? 'openai_key_missing' : 'local_asr_unavailable',
      fallback.openaiFallbackConfigured
        ? 'Local transcription is unavailable; audio is preserved for retry and the configured OpenAI fallback has no key'
        : 'Local transcription is unavailable; audio is preserved for retry',
    )
  }

  const key = getOpenAIKey()
  assertOpenAIWhisperBudget()
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
