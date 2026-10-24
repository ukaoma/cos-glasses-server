// Generic post-meeting transcription. Raw WAV chunks are concatenated into
// larger windows so Whisper gets enough context to improve the live stream.
// The candidate is never canonical until batch-transcript-quality accepts it.

import { isVoiceLabel } from './mac-voice-labels.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  applyCorrections,
  getHighQualityCheckpointFingerprint,
  getHighQualityTranscriptionCapability,
  getWhisperCommitCapability,
  transcribeHighQuality,
  type HighQualityTranscriptionResult,
  type WhisperWord,
} from './whisper-local.js'
import { asrFrontEnd } from './stt-live.js'
import { measureSpeechSeconds } from './vad-silero.js'
import { batchTimestampsEnabled } from './whisper-batch-timing.js'
import { readSttSettings, recordLastSttJob, type FrontEndId, type HqId, type SecondOpinionId } from './stt-settings.js'
import { currentEffectiveStt } from './stt-runtime.js'
import { MAC_CAPTURE_ID } from './mac-recording.js'
import { MacParakeetUnavailableError } from './mac-recording-asr.js'
import { transcribeParakeet, type ParakeetResult, type ParakeetRunOptions } from './parakeet.js'
import { isDeletionProneEngine, resolveHypotheses, RESOLVER_VERSION, type Hypothesis } from './stt-resolver.js'
import { getVocabulary, getWhisperCorrections } from './profile.js'
import { decoderContextWindow } from './glossary-learn.js'

/** 6.83.1: the decoder's priming window, with correction-only forms put back to speech before the cut. */
function decoderWindow(previousText?: string): string | undefined {
  let corrections: Record<string, string> = {}
  try { corrections = getWhisperCorrections() } catch { /* a test double without it reads as none */ }
  return decoderContextWindow(previousText, corrections)
}
import { captureSpeakerMode, policyLabel } from './meeting-speaker-policy.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { isMetalBatchPreempted } from './whisper-metal-gate.js'
import {
  clearMeetingBatchProgress,
  clearMeetingBatchTerminal,
  writeMeetingBatchProgress,
  writeMeetingBatchTerminal,
} from './meeting-batch-progress.js'
import type { IndexedTranscriptChunk } from '../routes/transcribe-stream.js'
import {
  evaluateBatchQuality,
  type BatchResult,
  type BatchSegment,
  type BatchSttSummary,
  type BatchTranscription,
  type SegmentStt,
} from './batch-transcript-quality.js'

const WAV_HEADER_SIZE = 44
const SAMPLE_RATE = 16_000
const BITS_PER_SAMPLE = 16
const NUM_CHANNELS = 1

function refreshPendingLease(audioDir: string): void {
  const marker = join(audioDir, '_batch_pending.marker')
  const now = new Date()
  try {
    if (existsSync(marker)) utimesSync(marker, now, now)
    else writeFileSync(marker, String(Date.now()), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Failure to refresh cannot justify deleting evidence; the persistence gate
    // still retains raw audio unless accepted text + metadata both commit.
  }
}

function createWavHeader(pcmLength: number): Buffer {
  const bytesPerSample = BITS_PER_SAMPLE / 8
  const byteRate = SAMPLE_RATE * NUM_CHANNELS * bytesPerSample
  const header = Buffer.alloc(WAV_HEADER_SIZE)
  header.write('RIFF', 0)
  header.writeUInt32LE(pcmLength + WAV_HEADER_SIZE - 8, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(NUM_CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(NUM_CHANNELS * bytesPerSample, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcmLength, 40)
  return header
}

export function concatenateWavChunks(audioDir: string, startChunk: number, endChunk: number): Buffer {
  const pcmBuffers: Buffer[] = []
  for (let index = startChunk; index <= endChunk; index++) {
    const filename = `chunk_${String(index).padStart(4, '0')}.wav`
    const filepath = resolve(audioDir, filename)
    if (!existsSync(filepath)) continue
    const wav = readFileSync(filepath)
    if (wav.length <= WAV_HEADER_SIZE || wav.toString('ascii', 0, 4) !== 'RIFF') {
      console.warn(`[meeting-batch] ${filename} is not a valid WAV; skipped`)
      continue
    }
    pcmBuffers.push(wav.subarray(WAV_HEADER_SIZE))
  }
  if (pcmBuffers.length === 0) {
    throw new Error(`No valid WAV chunks in range ${startChunk}-${endChunk}`)
  }
  const pcm = Buffer.concat(pcmBuffers)
  return Buffer.concat([createWavHeader(pcm.length), pcm])
}

/** A segment's `speakers` list holds names only: never `Ext`, and (6.90.0) never a Mac `Voice N` placeholder. */
export function isNamedSegmentSpeaker(speaker: string): boolean {
  return Boolean(speaker) && speaker !== 'Ext' && !isVoiceLabel(speaker)
}

/** Group live transcript chunks into roughly 30-second Whisper windows. */
export function segmentTranscriptChunks(
  entries: IndexedTranscriptChunk[],
  targetMs = 30_000,
  includeOpenTail = true,
): BatchSegment[] {
  if (entries.length === 0) return []
  const segments: BatchSegment[] = []
  let segmentStartPosition = 0

  for (let position = 0; position < entries.length; position++) {
    const entry = entries[position]
    const chunk = entry.chunk
    const first = entries[segmentStartPosition]
    if (!first) {
      segmentStartPosition = position
      continue
    }
    // Close before the first chunk captured under a different identity policy.
    // A named Standard chunk must never lend its name to anonymous audio.
    if (position > segmentStartPosition && captureSpeakerMode(chunk.speakerPolicy) !== captureSpeakerMode(first.chunk.speakerPolicy)) {
      const window = entries.slice(segmentStartPosition, position)
      const last = window.at(-1)!
      segments.push({
        startChunkIdx: first.chunkIndex, endChunkIdx: last.chunkIndex,
        startElapsed: first.chunk.elapsed, endElapsed: last.chunk.elapsed,
        speakers: [...new Set(window.map(item => policyLabel(item.chunk, captureSpeakerMode(item.chunk.speakerPolicy)).speaker).filter(isNamedSegmentSpeaker))],
        speakerPolicy: captureSpeakerMode(first.chunk.speakerPolicy),
      })
      segmentStartPosition = position
      continue
    }
    if (chunk.elapsed - first.chunk.elapsed >= targetMs && position > segmentStartPosition) {
      const window = entries.slice(segmentStartPosition, position + 1)
      segments.push({
        startChunkIdx: first.chunkIndex,
        endChunkIdx: entry.chunkIndex,
        startElapsed: first.chunk.elapsed,
        endElapsed: chunk.elapsed,
        speakers: [...new Set(window.map(item => policyLabel(item.chunk, captureSpeakerMode(item.chunk.speakerPolicy)).speaker).filter(isNamedSegmentSpeaker))],
        speakerPolicy: captureSpeakerMode(first.chunk.speakerPolicy),
      })
      segmentStartPosition = position + 1
    }
  }

  if (includeOpenTail && segmentStartPosition < entries.length) {
    const window = entries.slice(segmentStartPosition)
    const first = entries[segmentStartPosition]
    const last = entries.at(-1)
    if (window.length > 0 && first && last) {
      segments.push({
        startChunkIdx: first.chunkIndex,
        endChunkIdx: last.chunkIndex,
        startElapsed: first.chunk.elapsed,
        endElapsed: last.chunk.elapsed,
        speakers: [...new Set(window.map(item => policyLabel(item.chunk, captureSpeakerMode(item.chunk.speakerPolicy)).speaker).filter(isNamedSegmentSpeaker))],
        speakerPolicy: captureSpeakerMode(first.chunk.speakerPolicy),
      })
    }
  }
  return segments
}

export function stripOverlap(newText: string, previousText: string): string {
  const normalize = (value: string): string => value
    .toLowerCase()
    .replace(/[.!?,;:'"()\-\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const previousWords = normalize(previousText).split(' ').filter(Boolean)
  const newWords = normalize(newText).split(' ').filter(Boolean)
  if (previousWords.length < 3 || newWords.length < 3) return newText

  const maxOverlap = Math.min(previousWords.length, newWords.length, 25)
  let overlap = 0
  for (let count = maxOverlap; count >= 3; count--) {
    if (previousWords.slice(-count).join(' ') === newWords.slice(0, count).join(' ')) {
      overlap = count
      break
    }
  }
  if (overlap === 0) return newText
  return newText.trim().split(/\s+/).slice(overlap).join(' ') || newText
}

export function mapWordsToSpeakers(
  words: WhisperWord[],
  segment: BatchSegment,
  entries: IndexedTranscriptChunk[],
): Array<{ word: string; start: number; end: number; speaker: string; similarity: number }> {
  const window = entries.filter(entry => entry.chunkIndex >= segment.startChunkIdx && entry.chunkIndex <= segment.endChunkIdx)
  const policies = new Set(window.map(entry => captureSpeakerMode(entry.chunk.speakerPolicy)))
  const strict = captureSpeakerMode(segment.speakerPolicy) !== 'standard' || [...policies].some(mode => mode !== 'standard')
  // Defensive gate for caller-provided/cached mixed windows, even though the
  // segmenter now splits them. Without precise spans, retain words anonymously.
  const mixedStrict = strict && policies.size > 1
  return words.map(word => {
    const absoluteElapsed = segment.startElapsed + word.start * 1000
    let speaker = segment.speakers[0] || 'Unknown'
    let similarity = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (const entry of entries) {
      if (entry.chunkIndex < segment.startChunkIdx || entry.chunkIndex > segment.endChunkIdx) continue
      const chunk = entry.chunk
      const distance = Math.abs(chunk.elapsed - absoluteElapsed)
      if (distance < bestDistance) {
        bestDistance = distance
        const label = policyLabel(chunk, captureSpeakerMode(chunk.speakerPolicy))
        speaker = label.speaker
        similarity = Number.isFinite(label.similarity) ? label.similarity : 0
      }
    }
    if (bestDistance > 3_500) {
      speaker = strict ? 'Ext' : segment.speakers[0] || 'Unknown'
      similarity = 0
    }
    if (mixedStrict || captureSpeakerMode(segment.speakerPolicy) === 'anonymous') { speaker = 'Ext'; similarity = 0 }
    return { word: word.word, start: word.start, end: word.end, speaker, similarity }
  })
}

const PROGRESSIVE_MANIFEST = '_progressive_hq.json'

interface ProgressiveCheckpoint {
  key: string
  sourceHash: string
  contextHash: string
  configFingerprint: string
  completedAt: string
  wallTimeMs: number
  result: BatchResult
}

interface ProgressiveManifest {
  schemaVersion: 1
  sessionId: string
  checkpoints: Record<string, ProgressiveCheckpoint>
}

function checkpointKey(segment: BatchSegment): string {
  return `${segment.startChunkIdx}-${segment.endChunkIdx}`
}

function contextHash(previousText?: string): string {
  return createHash('sha256').update(previousText?.slice(-250) ?? '').digest('hex')
}

function segmentSourceHash(audioDir: string, segment: BatchSegment): string | null {
  const hash = createHash('sha256')
  for (let index = segment.startChunkIdx; index <= segment.endChunkIdx; index++) {
    const path = resolve(audioDir, `chunk_${String(index).padStart(4, '0')}.wav`)
    if (!existsSync(path)) return null
    const wav = readFileSync(path)
    if (wav.length <= WAV_HEADER_SIZE || wav.toString('ascii', 0, 4) !== 'RIFF') return null
    hash.update(String(index)).update('\0').update(wav)
  }
  return hash.digest('hex')
}

/** The decoder identity a checkpoint was made under: timestamps and front end (6.72.0). */
export interface CheckpointIdentity { timestamps: boolean; frontEnd: FrontEndId }
function currentCheckpointIdentity(): CheckpointIdentity {
  return { timestamps: batchTimestampsEnabled(), frontEnd: readSttSettings().frontEnd }
}

function progressiveFailureIdentity(
  audioDir: string,
  segment: BatchSegment,
  previousText?: string,
  identity: CheckpointIdentity = currentCheckpointIdentity(),
): string | null {
  const sourceHash = segmentSourceHash(audioDir, segment)
  if (!sourceHash) return null
  return createHash('sha256').update([
    checkpointKey(segment), sourceHash, contextHash(previousText), getHighQualityCheckpointFingerprint(identity),
  ].join('\0')).digest('hex')
}

function loadProgressiveManifest(audioDir: string): ProgressiveManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(audioDir, PROGRESSIVE_MANIFEST), 'utf8')) as ProgressiveManifest
    if (parsed?.schemaVersion !== 1 || typeof parsed.sessionId !== 'string' || !parsed.checkpoints) return null
    return parsed
  } catch {
    return null
  }
}

function readProgressiveCheckpoint(
  audioDir: string,
  segment: BatchSegment,
  previousText?: string,
  expectedSessionId?: string,
  identity: CheckpointIdentity = currentCheckpointIdentity(),
): BatchResult | null {
  const cached = readProgressiveCheckpointMetadata(audioDir, segment, previousText, undefined, expectedSessionId, identity)
  if (!cached) return null
  const manifest = loadProgressiveManifest(audioDir)
  const checkpoint = manifest?.checkpoints?.[checkpointKey(segment)]
  if (!checkpoint) return null
  const sourceHash = segmentSourceHash(audioDir, segment)
  if (!sourceHash || checkpoint.sourceHash !== sourceHash) return null
  return cached
}

/** Lightweight cache lookup for admission/status. Raw audio is immutable once
 * durably written, while final Stop/save reuse still performs the full WAV
 * hash validation above. This keeps the 12-second Control health poll cheap. */
function readProgressiveCheckpointMetadata(
  audioDir: string,
  segment: BatchSegment,
  previousText?: string,
  manifest = loadProgressiveManifest(audioDir),
  expectedSessionId?: string,
  identity: CheckpointIdentity = currentCheckpointIdentity(),
): BatchResult | null {
  if (expectedSessionId && manifest?.sessionId !== expectedSessionId) return null
  const checkpoint = manifest?.checkpoints?.[checkpointKey(segment)]
  if (
    !checkpoint
    || checkpoint.contextHash !== contextHash(previousText)
    || checkpoint.configFingerprint !== getHighQualityCheckpointFingerprint(identity)
  ) return null
  const cached = checkpoint.result
  const validWord = (word: unknown, speakerRequired: boolean): boolean => {
    if (!word || typeof word !== 'object') return false
    const item = word as Record<string, unknown>
    return typeof item.word === 'string'
      && typeof item.start === 'number'
      && Number.isFinite(item.start)
      && typeof item.end === 'number'
      && Number.isFinite(item.end)
      && item.start >= 0
      && item.end >= item.start
      && (!speakerRequired || (
        typeof item.speaker === 'string'
        && typeof item.similarity === 'number'
        && Number.isFinite(item.similarity)
        && item.similarity >= 0
        && item.similarity <= 1
      ))
  }
  if (
    cached?.segment?.startChunkIdx !== segment.startChunkIdx
    || cached.segment.endChunkIdx !== segment.endChunkIdx
    || cached.segment.startElapsed !== segment.startElapsed
    || cached.segment.endElapsed !== segment.endElapsed
    || captureSpeakerMode(cached.segment.speakerPolicy) !== captureSpeakerMode(segment.speakerPolicy)
    || !Array.isArray(cached.segment.speakers)
    || cached.segment.speakers.some(speaker => typeof speaker !== 'string')
    || typeof cached.text !== 'string'
    || !Array.isArray(cached.words)
    || cached.words.some(word => !validWord(word, false))
    || !Array.isArray(cached.speakerWords)
    || cached.speakerWords.some(word => !validWord(word, true))
  ) return null
  // Optional 6.72.0 fields: dropped (never trusted) when malformed, so reuse falls back to record-only.
  const spokenOk = Array.isArray(cached.spokenWords) && cached.spokenWords.every(word => validWord(word, false))
  const spansOk = Array.isArray(cached.speechSpans) && cached.speechSpans.every(span => Array.isArray(span) && span.length === 2
    && span.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0) && span[1] >= span[0])
  const { spokenWords: _s, speechSpans: _p, ...rest } = cached
  return { ...rest, ...(spokenOk ? { spokenWords: cached.spokenWords } : {}), ...(spansOk ? { speechSpans: cached.speechSpans } : {}) }
}

function writeProgressiveCheckpoint(
  audioDir: string,
  sessionId: string,
  checkpoint: ProgressiveCheckpoint,
): void {
  const prior = loadProgressiveManifest(audioDir)
  if (prior && prior.sessionId !== sessionId) {
    throw new Error(`Progressive HQ manifest session mismatch (${prior.sessionId} != ${sessionId})`)
  }
  const next: ProgressiveManifest = {
    schemaVersion: 1,
    sessionId,
    checkpoints: { ...(prior?.checkpoints ?? {}), [checkpoint.key]: checkpoint },
  }
  durableAtomicWriteFileSync(
    join(audioDir, PROGRESSIVE_MANIFEST),
    JSON.stringify(next, null, 2),
    { mode: 0o600 },
  )
}

export const __progressiveHqTesting = {
  checkpointKey,
  segmentSourceHash,
  readProgressiveCheckpoint,
  readProgressiveCheckpointMetadata,
  writeProgressiveCheckpoint,
  contextHash,
  segmentRangeIsComplete,
  nextMissingSealedSegment,
  progressiveFailureIdentity,
  resolveProgressiveHqPolicy,
  progressiveSessionIsIdle,
  yieldIdleProgressiveSessions,
  admitProgressiveSession,
  progressiveSessionIds: () => [...progressiveSessions.keys()],
  resetProgressiveSessions: () => {
    for (const state of progressiveSessions.values()) state.controller?.abort()
    progressiveSessions.clear()
    progressiveActiveSessionId = null
  },
}

/** Read-only, default-off candidate for in-meeting Ask evidence. Does not
 * rewrite canonical chunks, run a decoder, or include the open tail. A complete
 * audio/config/context chain is required; any invalid checkpoint leaves the
 * remaining live transcript untouched. */
export function readProgressiveAskRefinements(
  audioDir: string,
  sessionId: string,
  entries: IndexedTranscriptChunk[],
  asrCompletedIndices: number[],
): BatchResult[] {
  if (process.env.COS_MEETING_ASK_HQ_EVIDENCE !== '1'
    || process.env.COS_BATCH_HQ_TIMESTAMPS !== '1'
    || !progressiveMeetingHqEnabled()) return []
  const results: BatchResult[] = []
  let previousText: string | undefined
  for (const segment of segmentTranscriptChunks(entries, 30_000, false)) {
    if (!segmentRangeIsComplete(segment, asrCompletedIndices)) break
    const cached = readProgressiveCheckpoint(audioDir, segment, previousText, sessionId)
    if (!cached) break
    previousText = cached.text
    const originals = entries.filter(e => e.chunkIndex >= segment.startChunkIdx && e.chunkIndex <= segment.endChunkIdx)
    const baseline = originals.map(e => e.chunk.text).join(' ')
    const count = baseline.trim().split(/\s+/).filter(Boolean).length
    const quality = evaluateBatchQuality([cached], count)
    // Runtime checks are conservative corruption guards, not proof of ASR
    // accuracy. Human-corrected facts and latency remain qualification gates.
    const numbers = baseline.match(/\b\d+(?:[.,]\d+)*\b/g) ?? []
    const refinedNumbers = new Set(cached.text.match(/\b\d+(?:[.,]\d+)*\b/g) ?? [])
    if (count >= 8 && quality.accepted && quality.coverageRatio >= 0.85
      && quality.coverageRatio <= 1.75
      && cached.words.filter(word => word.end > word.start).length >= quality.batchWordCount * 0.75
      && numbers.every(number => refinedNumbers.has(number))) results.push(cached)
  }
  return results
}

/** The STT plan one HQ job runs with, frozen when the job starts (6.72.0). A
 *  settings change applies to the next saved meeting, never mid-job. */
export interface HqJobPlan {
  engine: HqId
  secondOpinion: SecondOpinionId
  resolver: boolean
  frontEnd: FrontEndId
  /** Mac canonical Parakeet must never silently substitute Whisper. */
  strictPrimary?: true
}

export function currentHqJobPlan(sessionId?: string): HqJobPlan {
  const selected = readSttSettings()
  if (sessionId && MAC_CAPTURE_ID.test(sessionId) && selected.hq === 'parakeet-ultra') {
    return { engine: selected.hq, secondOpinion: selected.secondOpinion, resolver: selected.resolver, frontEnd: selected.frontEnd, strictPrimary: true }
  }
  const eff = currentEffectiveStt()
  return { engine: eff.hq.engine, secondOpinion: eff.secondOpinion.engine, resolver: eff.resolver, frontEnd: eff.frontEnd }
}

/** Legacy pre-6.72 behaviour, for callers and tests that pass no plan. */
export const LEGACY_HQ_PLAN: Readonly<HqJobPlan> = Object.freeze({ engine: 'large-v3-legacy', secondOpinion: 'off', resolver: false, frontEnd: 'full' })

export interface HqDecodeDeps {
  whisper: typeof transcribeHighQuality
  parakeet: (wav: Buffer, options: ParakeetRunOptions) => Promise<ParakeetResult>
  frontEnd: (audio: Buffer, frontEnd: FrontEndId) => Promise<Buffer>
  vocabulary: () => string[]
  /** Silero speech seconds of a window (null when unmeasured); judges an empty Parakeet primary. */
  speechSeconds?: (wav: Buffer) => number | null
}

// Arrow wrappers, not references: a test that mocks one of these modules
// without every export must still be able to import this one.
const defaultHqDeps: HqDecodeDeps = {
  whisper: (...args) => transcribeHighQuality(...args),
  parakeet: (wav, options) => transcribeParakeet(wav, options),
  frontEnd: (audio, frontEnd) => asrFrontEnd(audio, frontEnd),
  vocabulary: () => getVocabulary(),
  speechSeconds: wav => measureSpeechSeconds(wav),
}

/** A first Parakeet run in a process may compile CoreML (12 to 25 s); later runs are well under a second. */
export const PARAKEET_FIRST_WINDOW_TIMEOUT_MS = 180_000
export const PARAKEET_WINDOW_TIMEOUT_MS = 30_000

interface WholeDecode {
  engine: 'large-v3' | 'large-v3-legacy' | 'parakeet-ultra'
  /** Name-corrected text. */
  text: string
  /** What BatchResult.words carries (Whisper tokens, or Parakeet words), name-corrected. */
  words: WhisperWord[]
  /** Uncorrected spoken words for the resolver; absent when the clocks are not trustworthy. */
  spoken?: WhisperWord[]
  /** Where the primary's own VAD heard speech (window clock); gap fill needs it. */
  speechSpans?: Array<[number, number]>
  timestamps: boolean
}

function errorReason(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error).slice(0, 200)
}

/** Parakeet failures in a row before the job stops calling it (each can cost its deadline). */
export const PARAKEET_JOB_BREAKER_FAILURES = 2

interface JobState {
  parakeetRan: boolean
  parakeetFailures: number
  parakeetStopped: boolean
}

async function decodeWhisperOnce(
  deps: HqDecodeDeps,
  input: Buffer,
  previousText: string | undefined,
  timestamps: boolean,
  segment: BatchSegment,
  audioDir: string,
): Promise<HighQualityTranscriptionResult> {
  try {
    return await deps.whisper(input, decoderWindow(previousText), { priority: 'batch', timestamps })
  } catch (error) {
    // A live meeting took the GPU mid-segment. The truncated Metal output
    // was already discarded upstream (BLOCKER contract) — it is never
    // accepted. Retry this SAME segment once on CPU, which cannot itself be
    // preempted, so a busy day degrades to slow rather than to a silently
    // missing stretch of transcript.
    if (!isMetalBatchPreempted(error)) throw error
    console.log(
      `[meeting-batch] Segment ${segment.startChunkIdx}-${segment.endChunkIdx} preempted off Metal; `
      + 'retrying once on CPU',
    )
    refreshPendingLease(audioDir)
    return deps.whisper(input, decoderWindow(previousText), { priority: 'batch', forceCpu: true, forceCpuReason: 'preempt_retry', timestamps })
  }
}

function asWholeWhisper(result: HighQualityTranscriptionResult, engine: 'large-v3' | 'large-v3-legacy', timestamps: boolean): WholeDecode {
  const ran = result.timestamps ?? timestamps
  return {
    engine,
    text: result.text,
    words: result.words ?? [],
    ...(ran && result.spokenWords ? { spoken: result.spokenWords } : {}),
    ...(ran && result.speechSpans ? { speechSpans: result.speechSpans } : {}),
    timestamps: ran,
  }
}

/**
 * Whisper for one window. A timestamp decode that fails (a VAD-table or clock
 * check, or anything else) is retried once with the legacy decoder, so a
 * timing problem never costs the window's text.
 */
async function decodeWhisperWindow(
  deps: HqDecodeDeps,
  input: Buffer,
  previousText: string | undefined,
  engine: 'large-v3' | 'large-v3-legacy',
  segment: BatchSegment,
  audioDir: string,
): Promise<{ decode: WholeDecode; fallbackReason?: string }> {
  const timestamps = batchTimestampsEnabled(engine)
  try {
    return { decode: asWholeWhisper(await decodeWhisperOnce(deps, input, previousText, timestamps, segment, audioDir), engine, timestamps) }
  } catch (error) {
    if (!timestamps) throw error
    console.warn(`[meeting-batch] Timestamp decode failed for ${segment.startChunkIdx}-${segment.endChunkIdx}; retrying with the legacy decoder: ${errorReason(error)}`)
    const legacy = await decodeWhisperOnce(deps, input, previousText, false, segment, audioDir)
    return { decode: asWholeWhisper(legacy, 'large-v3-legacy', false), fallbackReason: `timestamps_failed: ${errorReason(error)}` }
  }
}

/** A Parakeet window with no words over audio the speech detector says holds speech is a failed decode. */
export const PARAKEET_EMPTY_SPEECH_SEC = 0.5

async function decodeParakeetWindow(
  deps: HqDecodeDeps,
  input: Buffer,
  timeoutMs: number,
  model: 'parakeet-ultra',
  requireWordsOverSpeech: boolean,
): Promise<WholeDecode> {
  const r = await deps.parakeet(input, { model, lane: 'batch', timeoutMs })
  if (requireWordsOverSpeech && !r.text.trim()) {
    const speech = deps.speechSeconds?.(input) ?? null
    if (speech !== null && speech >= PARAKEET_EMPTY_SPEECH_SEC) {
      throw Object.assign(new Error(`Parakeet returned no words over ${speech.toFixed(1)} s of speech`), { reason: 'bad_output' })
    }
  }
  const spoken = r.words.map(w => ({ word: w.word, start: w.start, end: w.end, probability: w.probability ?? 0 }))
  return {
    engine: model,
    text: applyCorrections(r.text),
    words: spoken.map(w => ({ ...w, word: applyCorrections(w.word) })),
    spoken,
    timestamps: true,
  }
}

const isParakeet = (engine: string): boolean => engine.startsWith('parakeet')

function asHypothesis(d: WholeDecode): Hypothesis {
  return { engine: d.engine, text: d.text, ...(d.spoken ? { words: d.spoken } : {}) }
}

function hypothesisRecord(d: WholeDecode): SegmentStt['primary'] {
  return { engine: d.engine, text: d.text, ...(d.spoken ? { words: d.spoken.map(w => ({ word: w.word, start: w.start, end: w.end, probability: w.probability })) } : {}) }
}

function parakeetTimeout(job: JobState): number {
  const t = job.parakeetRan ? PARAKEET_WINDOW_TIMEOUT_MS : PARAKEET_FIRST_WINDOW_TIMEOUT_MS
  job.parakeetRan = true
  return t
}

/** Run Parakeet under the job breaker: after PARAKEET_JOB_BREAKER_FAILURES in a row it is not called again this job. */
async function parakeetGuarded(job: JobState, run: () => Promise<WholeDecode>): Promise<WholeDecode> {
  if (job.parakeetStopped) throw Object.assign(new Error('Parakeet stopped for this job after repeated failures'), { reason: 'job_breaker' })
  try {
    const d = await run()
    job.parakeetFailures = 0
    return d
  } catch (error) {
    job.parakeetFailures++
    if (job.parakeetFailures >= PARAKEET_JOB_BREAKER_FAILURES) {
      job.parakeetStopped = true
      console.warn(`[meeting-batch] Parakeet failed ${job.parakeetFailures} windows in a row; not calling it again this job`)
    }
    throw error
  }
}

/**
 * One HQ window under the job's plan: the primary engine (or a reused
 * progressive checkpoint), then (if planned) the second opinion on the SAME
 * front-end audio, then the resolver. No failure costs the window its text:
 * Parakeet primary failing falls back to Large-v3; Whisper failing outright
 * falls back to a planned Parakeet second opinion as the primary; a failed
 * second opinion leaves the primary exactly as heard.
 */
async function decodeHqWindow(
  input: Buffer,
  previousText: string | undefined,
  segment: BatchSegment,
  entries: IndexedTranscriptChunk[],
  plan: HqJobPlan,
  deps: HqDecodeDeps,
  job: JobState,
  audioDir: string,
  reused?: BatchResult,
): Promise<BatchResult> {
  let primary: WholeDecode
  let fallbackReason: string | undefined
  let usedSecondAsPrimary = false
  const secondModel = plan.secondOpinion === 'parakeet-ultra' ? plan.secondOpinion : null
  if (reused) {
    const ts = batchTimestampsEnabled(plan.engine === 'large-v3-legacy' ? 'large-v3-legacy' : 'large-v3')
    primary = {
      engine: plan.engine === 'large-v3-legacy' ? 'large-v3-legacy' : 'large-v3',
      text: reused.text,
      words: reused.words,
      ...(ts && reused.spokenWords ? { spoken: reused.spokenWords } : {}),
      ...(ts && reused.speechSpans ? { speechSpans: reused.speechSpans } : {}),
      timestamps: ts,
    }
  } else if (plan.engine === 'parakeet-ultra') {
    try {
      primary = await parakeetGuarded(job, () => decodeParakeetWindow(deps, input, parakeetTimeout(job), 'parakeet-ultra', true))
    } catch (error) {
      if (plan.strictPrimary) throw new MacParakeetUnavailableError(error)
      fallbackReason = `parakeet_failed: ${errorReason(error)}`
      console.warn(`[meeting-batch] Parakeet HQ failed for ${segment.startChunkIdx}-${segment.endChunkIdx}; using Large-v3: ${errorReason(error)}`)
      const w = await decodeWhisperWindow(deps, input, previousText, 'large-v3', segment, audioDir)
      primary = w.decode
      if (w.fallbackReason) fallbackReason += `; ${w.fallbackReason}`
    }
  } else {
    try {
      const w = await decodeWhisperWindow(deps, input, previousText, plan.engine, segment, audioDir)
      primary = w.decode
      fallbackReason = w.fallbackReason
    } catch (error) {
      if (!secondModel || job.parakeetStopped) throw error
      // Whisper failed both ways: the planned Parakeet second opinion keeps the window's text.
      primary = await parakeetGuarded(job, () => decodeParakeetWindow(deps, input, parakeetTimeout(job), secondModel, true))
      fallbackReason = `whisper_failed: ${errorReason(error)}`
      usedSecondAsPrimary = true
      console.warn(`[meeting-batch] Whisper failed for ${segment.startChunkIdx}-${segment.endChunkIdx}; Parakeet (${secondModel}) is this window's primary`)
    }
  }

  let second: WholeDecode | null = null
  let secondError: string | undefined
  const secondEngine = plan.secondOpinion
  const sameFamily = secondEngine !== 'off' && isParakeet(secondEngine) === isParakeet(primary.engine)
  if (secondEngine !== 'off' && !sameFamily && !usedSecondAsPrimary) {
    try {
      if (secondEngine === 'large-v3') {
        second = (await decodeWhisperWindow(deps, input, previousText, 'large-v3', segment, audioDir)).decode
      } else {
        second = await parakeetGuarded(job, () => decodeParakeetWindow(deps, input, parakeetTimeout(job), secondEngine, false))
      }
    } catch (error) {
      secondError = errorReason(error)
      console.warn(`[meeting-batch] Second opinion (${secondEngine}) failed for ${segment.startChunkIdx}-${segment.endChunkIdx}; keeping the primary: ${secondError}`)
    }
  }

  let text = primary.text
  let words = primary.words
  let applied = false
  let wordsFromSecond = 0
  let skipped: string | undefined
  let disagreements: SegmentStt['disagreements'] = []
  if (second) {
    // The resolver may change words only when the primary's clocks are real
    // (timestamps on, or Parakeet); otherwise it only records disagreements.
    const apply = plan.resolver && primary.spoken !== undefined
    const resolved = resolveHypotheses(asHypothesis(primary), asHypothesis(second), {
      vocabulary: deps.vocabulary(),
      primaryDeletionProne: isDeletionProneEngine(primary.engine),
      speechSpans: primary.speechSpans ?? null,
      apply,
    })
    skipped = resolved.skipped
    disagreements = resolved.disagreements
    if (apply && resolved.wordsFromSecond > 0 && resolved.timed) {
      applied = true
      wordsFromSecond = resolved.wordsFromSecond
      // Spoken words are uncorrected: join, then correct the text exactly once.
      text = applyCorrections(resolved.text)
      words = resolved.words.map(w => ({ word: applyCorrections(w.word), start: w.start, end: w.end, probability: w.probability ?? 0 }))
    } else {
      // What is saved must say what was applied.
      disagreements = disagreements.map(d => ({ ...d, taken: 'primary' as const }))
    }
  }
  // Only a prompted Whisper decode can echo the previous window's text.
  if (previousText && !isParakeet(primary.engine)) text = stripOverlap(text, previousText)

  const stt: SegmentStt = {
    engine: primary.engine,
    requestedEngine: plan.engine,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(reused ? { reusedCheckpoint: true } : {}),
    frontEnd: plan.frontEnd,
    timestamps: primary.timestamps,
    primary: hypothesisRecord(primary),
    ...(second ? { secondOpinion: hypothesisRecord(second) } : secondError ? { secondOpinion: { engine: secondEngine, text: '', error: secondError } } : {}),
    resolver: { version: RESOLVER_VERSION, enabled: plan.resolver, applied, wordsFromSecond, ...(skipped ? { skipped } : {}) },
    disagreements,
  }
  return {
    segment, text, words, speakerWords: mapWordsToSpeakers(words, segment, entries),
    ...(primary.spoken ? { spokenWords: primary.spoken } : {}),
    ...(primary.speechSpans ? { speechSpans: primary.speechSpans } : {}),
    stt,
  }
}

export async function transcribeSegments(
  audioDir: string,
  segments: BatchSegment[],
  entries: IndexedTranscriptChunk[],
  expectedSessionId: string | undefined,
  plan: HqJobPlan,
  deps: HqDecodeDeps = defaultHqDeps,
): Promise<BatchResult[]> {
  if (expectedSessionId && MAC_CAPTURE_ID.test(expectedSessionId) && plan.engine === 'parakeet-ultra') plan = { ...plan, strictPrimary: true }
  const results: BatchResult[] = []
  const meetingId = basename(audioDir)
  const job: JobState = { parakeetRan: false, parakeetFailures: 0, parakeetStopped: false }
  // A progressive checkpoint holds one Whisper decode made under the same
  // timing mode and front end. It is reused as the primary for a Whisper plan;
  // with a second opinion planned, only the second opinion is decoded.
  const identity: CheckpointIdentity = { timestamps: batchTimestampsEnabled(plan.engine === 'parakeet-ultra' ? 'large-v3' : plan.engine), frontEnd: plan.frontEnd }
  const checkpointsUsable = plan.engine !== 'parakeet-ultra'
  writeMeetingBatchProgress(audioDir, {
    phase: 'hq_polish',
    segmentsDone: 0,
    segmentsTotal: segments.length,
    meetingId,
  })
  for (const segment of segments) {
    try {
      refreshPendingLease(audioDir)
      const previousText = results.at(-1)?.text
      const cached = checkpointsUsable && progressiveMeetingHqEnabled()
        ? readProgressiveCheckpoint(audioDir, segment, previousText, expectedSessionId, identity)
        : null
      if (cached && plan.secondOpinion === 'off') {
        results.push({ ...cached, stt: { engine: plan.engine, requestedEngine: plan.engine, reusedCheckpoint: true, frontEnd: plan.frontEnd, timestamps: identity.timestamps,
          primary: { engine: plan.engine, text: cached.text }, resolver: { version: RESOLVER_VERSION, enabled: plan.resolver, applied: false, wordsFromSecond: 0 }, disagreements: [] } })
        writeMeetingBatchProgress(audioDir, {
          phase: 'hq_polish',
          segmentsDone: results.length,
          segmentsTotal: segments.length,
          meetingId,
        })
        continue
      }
      const combined = concatenateWavChunks(audioDir, segment.startChunkIdx, segment.endChunkIdx)
      const input = await deps.frontEnd(combined, plan.frontEnd)
      results.push(await decodeHqWindow(input, previousText, segment, entries, plan, deps, job, audioDir, cached ?? undefined))
      refreshPendingLease(audioDir)
      writeMeetingBatchProgress(audioDir, {
        phase: 'hq_polish',
        segmentsDone: results.length,
        segmentsTotal: segments.length,
        meetingId,
      })
    } catch (error) {
      // One failed strict Mac window invalidates the HQ candidate; preserve the
      // already canonical Parakeet chunks, rather than accepting partial text.
      if (plan.strictPrimary) throw error
      console.error(
        `[meeting-batch] Segment ${segment.startChunkIdx}-${segment.endChunkIdx} failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      writeMeetingBatchProgress(audioDir, {
        phase: 'hq_polish',
        segmentsDone: results.length,
        segmentsTotal: segments.length,
        meetingId,
      })
    }
  }
  return results
}

/** Orphan recovery's HQ work: the plan is taken when the recovery is accepted
 *  (like a save), and the same plan both decodes and summarizes. */
export function recoveryHqJob(
  quarantineDir: string,
  segments: BatchSegment[],
  entries: IndexedTranscriptChunk[],
  deps: HqDecodeDeps = defaultHqDeps,
  sessionId?: string,
): { plan: HqJobPlan; run: () => Promise<BatchResult[]> } {
  const plan = currentHqJobPlan(sessionId)
  return { plan, run: () => transcribeSegments(quarantineDir, segments, entries, sessionId, plan, deps) }
}

export function summarizeStt(plan: HqJobPlan, results: readonly BatchResult[], segmentsPlanned = results.length): BatchSttSummary {
  return {
    plan: { engine: plan.engine, secondOpinion: plan.secondOpinion, resolver: plan.resolver, frontEnd: plan.frontEnd,
      timestamps: batchTimestampsEnabled(plan.engine === 'parakeet-ultra' ? 'large-v3' : plan.engine) },
    resolverVersion: RESOLVER_VERSION,
    windows: results.length,
    windowsLost: Math.max(0, segmentsPlanned - results.length),
    disagreements: results.reduce((n, r) => n + (r.stt?.disagreements.length ?? 0), 0),
    wordsFromSecond: results.reduce((n, r) => n + (r.stt?.resolver.wordsFromSecond ?? 0), 0),
    secondOpinionFailures: results.filter(r => r.stt?.secondOpinion?.error).length,
    primaryFallbacks: results.filter(r => r.stt?.fallbackReason).length,
    timestampFallbacks: results.filter(r => r.stt?.fallbackReason?.includes('timestamps_failed')).length,
    checkpointsReused: results.filter(r => r.stt?.reusedCheckpoint).length,
    resolverSkipped: results.filter(r => r.stt?.resolver.skipped).length,
  }
}

let batchQueueTail: Promise<void> = Promise.resolve()

/** Chain arbitrary HQ-decoder work onto the same serialization tail the batch
 *  pipeline uses. Orphan recovery MUST go through this: transcribeSegments has
 *  no internal queue, so calling it directly would run a second (or third)
 *  16-thread large-v3 decoder in parallel with a live post-meeting batch. */
export function enqueueSerializedHqWork<T>(work: () => Promise<T>): Promise<T> {
  const job = batchQueueTail.then(work)
  batchQueueTail = job.then(() => undefined, () => undefined)
  return job
}

interface ProgressiveSessionState {
  sessionId: string
  audioDir: string
  entries: IndexedTranscriptChunk[]
  asrCompletedIndices: number[]
  queued: boolean
  active: boolean
  closed: boolean
  controller?: AbortController
  activeDecode?: Promise<void>
  inputRevision: number
  inputSignature: string
  failedIdentity?: string
  failedAttempts: number
  retryAfter: number
  lastInputAt: number
  idleYieldLogged: boolean
}

const progressiveSessions = new Map<string, ProgressiveSessionState>()
let progressiveActiveSessionId: string | null = null
const PROGRESSIVE_IDLE_YIELD_MS = 45_000

interface ProgressiveHqPolicyInput {
  requested: boolean
  effectiveTier: 'balanced' | 'max'
  hqAvailable: boolean
  logicalCpus: number
  requestedThreads?: number
}

export interface ProgressiveHqPolicy {
  requested: boolean
  enabled: boolean
  tier: 'balanced' | 'max'
  mode: 'balanced-conservative' | 'max-performance'
  threads: number
  reason: 'disabled_by_flag' | 'hq_unavailable' | null
}

/** Tier is the user-owned hardware admission signal. Balanced must remain safe
 *  on the lowest supported fanless M1/M2 Air, so it can never exceed two CPU
 *  decoder threads. Max may use six by default, while both tiers remain capped
 *  by the CPUs the OS actually makes available. An env override can lower a
 *  tier but cannot punch through its safety cap. */
function resolveProgressiveHqPolicy(input: ProgressiveHqPolicyInput): ProgressiveHqPolicy {
  const logicalCpus = Number.isFinite(input.logicalCpus)
    ? Math.max(1, Math.floor(input.logicalCpus))
    : 1
  const tierCap = input.effectiveTier === 'max' ? 8 : 2
  const defaultThreads = input.effectiveTier === 'max'
    ? Math.min(6, Math.max(1, logicalCpus - 2))
    : Math.min(2, Math.max(1, Math.floor(logicalCpus / 4)))
  const requestedThreads = Number.isFinite(input.requestedThreads)
    ? Math.max(1, Math.floor(input.requestedThreads!))
    : defaultThreads
  const threads = Math.min(tierCap, logicalCpus, requestedThreads)
  return {
    requested: input.requested,
    enabled: input.requested && input.hqAvailable,
    tier: input.effectiveTier,
    mode: input.effectiveTier === 'max' ? 'max-performance' : 'balanced-conservative',
    threads,
    reason: !input.requested ? 'disabled_by_flag' : !input.hqAvailable ? 'hq_unavailable' : null,
  }
}

function currentProgressiveHqPolicy(): ProgressiveHqPolicy {
  const commit = getWhisperCommitCapability()
  const hq = getHighQualityTranscriptionCapability()
  const rawThreads = Number.parseInt(process.env.COS_MEETING_PROGRESSIVE_HQ_THREADS || '', 10)
  return resolveProgressiveHqPolicy({
    requested: process.env.COS_MEETING_PROGRESSIVE_HQ === '1',
    effectiveTier: commit.effectiveTier,
    hqAvailable: hq.hqAvailable,
    logicalCpus: availableParallelism(),
    requestedThreads: Number.isFinite(rawThreads) ? rawThreads : undefined,
  })
}

export function progressiveMeetingHqEnabled(): boolean {
  return currentProgressiveHqPolicy().enabled
}

function progressiveThreads(): number {
  return currentProgressiveHqPolicy().threads
}

function progressiveSessionIsIdle(state: ProgressiveSessionState, now = Date.now()): boolean {
  return state.lastInputAt > 0 && now - state.lastInputAt >= PROGRESSIVE_IDLE_YIELD_MS
}

/** A stale recording may still be recoverable, but it must not own the CPU-HQ
 *  lane forever. Abort only its disposable checkpoint child; raw WAVs, the
 *  transcript ledger, completed checkpoints, and save/recovery semantics remain
 *  untouched. A later canonical chunk refreshes lastInputAt and resumes it. */
function yieldIdleProgressiveSessions(activeSessionId: string, now = Date.now()): void {
  for (const [sessionId, state] of progressiveSessions) {
    if (sessionId === activeSessionId || state.closed || !progressiveSessionIsIdle(state, now)) continue
    if (!state.idleYieldLogged) {
      console.log(`[meeting-hq-checkpoint] yielding idle session ${sessionId}`)
      state.idleYieldLogged = true
    }
    state.controller?.abort()
  }
}

function segmentRangeIsComplete(segment: BatchSegment, completedIndices: number[]): boolean {
  const completed = new Set(completedIndices)
  for (let index = segment.startChunkIdx; index <= segment.endChunkIdx; index++) {
    if (!completed.has(index)) return false
  }
  return true
}

function nextMissingSealedSegment(
  state: ProgressiveSessionState,
): { segment: BatchSegment; previousText?: string } | null {
  const sealed = segmentTranscriptChunks(state.entries, 30_000, false)
  const manifest = loadProgressiveManifest(state.audioDir)
  let previousText: string | undefined
  for (const segment of sealed) {
    if (!segmentRangeIsComplete(segment, state.asrCompletedIndices)) return null
    const cached = readProgressiveCheckpointMetadata(state.audioDir, segment, previousText, manifest, state.sessionId)
    if (!cached) {
      const identity = progressiveFailureIdentity(state.audioDir, segment, previousText)
      if (!identity) return null
      if (state.failedIdentity === identity && (state.failedAttempts >= 3 || Date.now() < state.retryAfter)) return null
      return { segment, previousText }
    }
    previousText = cached.text
  }
  return null
}

function queueProgressiveWork(sessionId: string, state: ProgressiveSessionState): void {
  if (state.queued || state.active || state.closed || !progressiveMeetingHqEnabled()) return
  if (progressiveSessionIsIdle(state)) return
  if (!nextMissingSealedSegment(state)) return
  state.queued = true

  void enqueueSerializedHqWork(async () => {
    state.queued = false
    if (state.closed || progressiveSessionIsIdle(state) || !progressiveMeetingHqEnabled()) return
    const pending = nextMissingSealedSegment(state)
    if (!pending) return
    const sourceHash = segmentSourceHash(state.audioDir, pending.segment)
    if (!sourceHash) return

    state.active = true
    progressiveActiveSessionId = sessionId
    const controller = new AbortController()
    state.controller = controller
    const started = Date.now()
    state.activeDecode = (async () => {
      if (controller.signal.aborted || state.closed) return
      const combined = concatenateWavChunks(
        state.audioDir,
        pending.segment.startChunkIdx,
        pending.segment.endChunkIdx,
      )
      const identity = currentCheckpointIdentity()
      const enhanced = await asrFrontEnd(combined, identity.frontEnd)
      if (controller.signal.aborted || state.closed) return
      const decoded = await transcribeHighQuality(enhanced, decoderWindow(pending.previousText), {
        priority: 'batch',
        forceCpu: true,
        forceCpuReason: 'progressive_checkpoint',
        threads: progressiveThreads(),
        backgroundCpu: true,
        signal: controller.signal,
        timestamps: identity.timestamps,
      })
      if (controller.signal.aborted || state.closed) return
      const text = pending.previousText
        ? stripOverlap(decoded.text, pending.previousText)
        : decoded.text
      const words = decoded.words ?? []
      const result: BatchResult = {
        segment: pending.segment,
        text,
        words,
        speakerWords: mapWordsToSpeakers(words, pending.segment, state.entries),
        // Kept so the save-time job can reuse this decode as a resolver primary.
        ...(decoded.timestamps && decoded.spokenWords ? { spokenWords: decoded.spokenWords } : {}),
        ...(decoded.timestamps && decoded.speechSpans ? { speechSpans: decoded.speechSpans } : {}),
      }
      writeProgressiveCheckpoint(state.audioDir, sessionId, {
        key: checkpointKey(pending.segment),
        sourceHash,
        contextHash: contextHash(pending.previousText),
        configFingerprint: getHighQualityCheckpointFingerprint(identity),
        completedAt: new Date().toISOString(),
        wallTimeMs: Date.now() - started,
        result,
      })
      state.failedIdentity = undefined
      state.failedAttempts = 0
      state.retryAfter = 0
    })()

    try {
      await state.activeDecode
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') {
        const identity = progressiveFailureIdentity(state.audioDir, pending.segment, pending.previousText)
        if (!identity) return
        state.failedAttempts = state.failedIdentity === identity ? state.failedAttempts + 1 : 1
        state.failedIdentity = identity
        state.retryAfter = Date.now() + [60_000, 120_000, 300_000][Math.min(2, state.failedAttempts - 1)]
        console.warn(
          `[meeting-hq-checkpoint] ${sessionId} ${pending.segment.startChunkIdx}-${pending.segment.endChunkIdx}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } finally {
      state.active = false
      state.controller = undefined
      state.activeDecode = undefined
      if (progressiveActiveSessionId === sessionId) progressiveActiveSessionId = null
      // Each job handles one sealed window, then rejoins the shared FIFO tail.
      // Multiple live meetings therefore make bounded round-robin progress
      // while post-save finalization still uses the same single decoder queue.
      if (!state.closed) queueProgressiveWork(sessionId, state)
    }
  }).catch(error => {
    state.queued = false
    console.warn(
      `[meeting-hq-checkpoint] queue failed for ${sessionId}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

function admitProgressiveSession(
  sessionId: string,
  audioDir: string,
  entries: IndexedTranscriptChunk[],
  asrCompletedIndices: number[],
  now = Date.now(),
): ProgressiveSessionState {
  const existing = progressiveSessions.get(sessionId)
  const state = existing ?? {
    sessionId,
    audioDir,
    entries: [],
    asrCompletedIndices: [],
    queued: false,
    active: false,
    closed: false,
    inputRevision: 0,
    inputSignature: '',
    failedAttempts: 0,
    retryAfter: 0,
    lastInputAt: 0,
    idleYieldLogged: false,
  }
  state.audioDir = audioDir
  state.entries = entries.map(entry => ({ ...entry, chunk: { ...entry.chunk } }))
  state.asrCompletedIndices = [...asrCompletedIndices]
  const inputSignature = createHash('sha256').update(JSON.stringify({
    entries: state.entries.map(entry => ({
      chunkIndex: entry.chunkIndex,
      text: entry.chunk.text,
      speaker: entry.chunk.speaker,
      elapsed: entry.chunk.elapsed,
    })),
    asrCompletedIndices: state.asrCompletedIndices,
  })).digest('hex')
  if (inputSignature !== state.inputSignature) {
    state.inputSignature = inputSignature
    state.inputRevision += 1
    state.lastInputAt = now
    state.idleYieldLogged = false
  }
  progressiveSessions.set(sessionId, state)
  return state
}

/** Coalesced, globally serialized progressive HQ admission after canonical
 *  persistence. Every live session may enqueue one window; no session owns the
 *  lane beyond that bounded unit of work. */
export function scheduleProgressiveHqCheckpoint(
  sessionId: string,
  audioDir: string,
  entries: IndexedTranscriptChunk[],
  asrCompletedIndices: number[],
): void {
  if (!progressiveMeetingHqEnabled()) return
  const now = Date.now()
  const state = admitProgressiveSession(sessionId, audioDir, entries, asrCompletedIndices, now)
  yieldIdleProgressiveSessions(sessionId, now)
  queueProgressiveWork(sessionId, state)
}

/** Stop/save barrier: abort at most one prefill child before audio-dir rename. */
export async function stopProgressiveHqSession(sessionId: string): Promise<void> {
  const state = progressiveSessions.get(sessionId)
  if (!state) return
  state.closed = true
  state.controller?.abort()
  void state.activeDecode?.catch(() => { /* aborted cache work is disposable */ })
  progressiveSessions.delete(sessionId)
}

export function getProgressiveHqSnapshot(): {
  requested: boolean
  enabled: boolean
  tier: 'balanced' | 'max'
  mode: 'balanced-conservative' | 'max-performance'
  threads: number
  reason: 'disabled_by_flag' | 'hq_unavailable' | null
  activeSessionId: string | null
  sessions: Array<{ sessionId: string; sealedDone: number; sealedTotal: number; state: string }>
} {
  const policy = currentProgressiveHqPolicy()
  return {
    ...policy,
    activeSessionId: progressiveActiveSessionId,
    sessions: [...progressiveSessions.entries()].filter(([, state]) => !state.closed).map(([sessionId, state]) => {
      const sealed = segmentTranscriptChunks(state.entries, 30_000, false)
      const manifest = loadProgressiveManifest(state.audioDir)
      let previousText: string | undefined
      let sealedDone = 0
      for (const segment of sealed) {
        const cached = readProgressiveCheckpointMetadata(state.audioDir, segment, previousText, manifest, state.sessionId)
        if (!cached) break
        sealedDone += 1
        previousText = cached.text
      }
      return {
        sessionId,
        sealedDone,
        sealedTotal: sealed.length,
        state: progressiveSessionIsIdle(state)
          ? 'paused_idle'
          : state.active ? 'active' : state.queued ? 'queued' : 'idle',
      }
    }),
  }
}

/** Serialize 16-thread HQ decoders across meetings on a public user's Mac. */
export function runMeetingBatchPipeline(
  audioDir: string,
  entries: IndexedTranscriptChunk[],
  streamingWordCount: number,
  sessionId?: string,
): Promise<BatchTranscription> {
  // Lease immediately, including time spent behind another HQ decoder. Without
  // this, the two-hour cleanup could delete a queued meeting before it starts.
  refreshPendingLease(audioDir)
  // A retry invalidates any prior terminal outcome — live signals must win.
  clearMeetingBatchTerminal(audioDir)
  writeMeetingBatchProgress(audioDir, {
    phase: 'queued',
    segmentsDone: 0,
    segmentsTotal: 0,
    meetingId: basename(audioDir),
  })
  const lease = setInterval(() => refreshPendingLease(audioDir), 60_000)
  lease.unref()
  // Frozen at SAVE time: a settings change applies to the next saved meeting,
  // never to one already queued behind another HQ job.
  const plan = currentHqJobPlan(sessionId)
  const job = batchQueueTail.then(() => runMeetingBatchPipelineNow(
    audioDir,
    entries,
    streamingWordCount,
    sessionId,
    plan,
  )).finally(() => {
    clearInterval(lease)
    clearMeetingBatchProgress(audioDir)
  })
  batchQueueTail = job.then(() => undefined, () => undefined)
  return job
}

async function runMeetingBatchPipelineNow(
  audioDir: string,
  entries: IndexedTranscriptChunk[],
  streamingWordCount: number,
  sessionId: string | undefined,
  plan: HqJobPlan,
): Promise<BatchTranscription> {
  try {
    refreshPendingLease(audioDir)
    if (!existsSync(audioDir)) return { transcriptionQuality: 'streaming' }
    if (!readdirSync(audioDir).some(filename => filename.endsWith('.wav'))) {
      return { transcriptionQuality: 'streaming' }
    }
    const segments = segmentTranscriptChunks(entries)
    if (segments.length === 0) {
      // Terminal too: WAVs exist but nothing is transcribable. Without this,
      // the dir re-creates the exact phantom-active state W2 removes.
      writeMeetingBatchTerminal(audioDir, { outcome: 'failed', reason: 'no_segments' })
      return { transcriptionQuality: 'streaming' }
    }

    writeMeetingBatchProgress(audioDir, {
      phase: 'hq_polish',
      segmentsDone: 0,
      segmentsTotal: segments.length,
      meetingId: basename(audioDir),
    })
    console.log(`[meeting-batch] STT plan: ${JSON.stringify(plan)}`)
    const batchSegments = await transcribeSegments(audioDir, segments, entries, sessionId, plan)
    writeMeetingBatchProgress(audioDir, {
      phase: 'quality_check',
      segmentsDone: segments.length,
      segmentsTotal: segments.length,
      meetingId: basename(audioDir),
    })
    const batchTranscript = batchSegments.map(result => result.text).join(' ')
    const qualityReport = evaluateBatchQuality(batchSegments, streamingWordCount)
    const sttSummary = summarizeStt(plan, batchSegments, segments.length)
    recordLastSttJob({ at: new Date().toISOString(), meeting: basename(audioDir), outcome: qualityReport.accepted ? 'batch' : 'rejected', summary: sttSummary })
    if (!qualityReport.accepted) {
      console.warn(
        `[meeting-batch] Candidate rejected (${qualityReport.reason}): `
        + `${qualityReport.batchWordCount} batch words, `
        + `${qualityReport.streamingWordCount} live words, `
        + `${(qualityReport.duplicateWordRatio * 100).toFixed(1)}% duplicate`,
      )
      // Terminal: the batch RAN and lost. WAVs stay for retry, but status must
      // stop reporting active work (pre-6.19.0 this looked like 12h of
      // "HQ polish · N chunks" with blocksRestart:true after the work ended).
      writeMeetingBatchTerminal(audioDir, { outcome: 'rejected', reason: qualityReport.reason })
      return { transcriptionQuality: 'streaming', qualityReport }
    }

    return { transcriptionQuality: 'batch', batchTranscript, batchSegments, qualityReport, stt: sttSummary }
  } catch (error) {
    console.error(`[meeting-batch] Pipeline failed: ${error instanceof Error ? error.message : String(error)}`)
    writeMeetingBatchTerminal(audioDir, {
      outcome: 'failed',
      reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    })
    if (plan.strictPrimary) throw error
    return { transcriptionQuality: 'streaming' }
  }
}
