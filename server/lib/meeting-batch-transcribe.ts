// Generic post-meeting transcription. Raw WAV chunks are concatenated into
// larger windows so Whisper gets enough context to improve the live stream.
// The candidate is never canonical until batch-transcript-quality accepts it.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { enhanceAudio } from './audio-enhance.js'
import {
  getHighQualityCheckpointFingerprint,
  getHighQualityTranscriptionCapability,
  getWhisperCommitCapability,
  transcribeHighQuality,
  type WhisperWord,
} from './whisper-local.js'
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
  type BatchTranscription,
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
    if (chunk.elapsed - first.chunk.elapsed >= targetMs && position > segmentStartPosition) {
      const window = entries.slice(segmentStartPosition, position + 1)
      segments.push({
        startChunkIdx: first.chunkIndex,
        endChunkIdx: entry.chunkIndex,
        startElapsed: first.chunk.elapsed,
        endElapsed: chunk.elapsed,
        speakers: [...new Set(window.map(item => item.chunk.speaker).filter(speaker => speaker && speaker !== 'Ext'))],
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
        speakers: [...new Set(window.map(item => item.chunk.speaker).filter(speaker => speaker && speaker !== 'Ext'))],
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
        speaker = chunk.speaker
        similarity = Number.isFinite(chunk.similarity) ? chunk.similarity : 0
      }
    }
    if (bestDistance > 3_500) {
      speaker = segment.speakers[0] || 'Unknown'
      similarity = 0
    }
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

function progressiveFailureIdentity(
  audioDir: string,
  segment: BatchSegment,
  previousText?: string,
): string | null {
  const sourceHash = segmentSourceHash(audioDir, segment)
  if (!sourceHash) return null
  return createHash('sha256').update([
    checkpointKey(segment), sourceHash, contextHash(previousText), getHighQualityCheckpointFingerprint(),
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
): BatchResult | null {
  const cached = readProgressiveCheckpointMetadata(audioDir, segment, previousText, undefined, expectedSessionId)
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
): BatchResult | null {
  if (expectedSessionId && manifest?.sessionId !== expectedSessionId) return null
  const checkpoint = manifest?.checkpoints?.[checkpointKey(segment)]
  if (
    !checkpoint
    || checkpoint.contextHash !== contextHash(previousText)
    || checkpoint.configFingerprint !== getHighQualityCheckpointFingerprint()
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
    || !Array.isArray(cached.segment.speakers)
    || cached.segment.speakers.some(speaker => typeof speaker !== 'string')
    || typeof cached.text !== 'string'
    || !Array.isArray(cached.words)
    || cached.words.some(word => !validWord(word, false))
    || !Array.isArray(cached.speakerWords)
    || cached.speakerWords.some(word => !validWord(word, true))
  ) return null
  return cached
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
}

export async function transcribeSegments(
  audioDir: string,
  segments: BatchSegment[],
  entries: IndexedTranscriptChunk[],
  expectedSessionId?: string,
): Promise<BatchResult[]> {
  const results: BatchResult[] = []
  const meetingId = basename(audioDir)
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
      const cached = progressiveMeetingHqEnabled()
        ? readProgressiveCheckpoint(audioDir, segment, previousText, expectedSessionId)
        : null
      if (cached) {
        results.push(cached)
        writeMeetingBatchProgress(audioDir, {
          phase: 'hq_polish',
          segmentsDone: results.length,
          segmentsTotal: segments.length,
          meetingId,
        })
        continue
      }
      const combined = concatenateWavChunks(audioDir, segment.startChunkIdx, segment.endChunkIdx)
      const enhanced = await enhanceAudio(combined)
      let result
      try {
        result = await transcribeHighQuality(enhanced, previousText?.slice(-250), { priority: 'batch' })
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
        result = await transcribeHighQuality(enhanced, previousText?.slice(-250), {
          priority: 'batch',
          forceCpu: true,
          forceCpuReason: 'preempt_retry',
        })
      }
      const text = previousText ? stripOverlap(result.text, previousText) : result.text
      const words = result.words ?? []
      results.push({
        segment,
        text,
        words,
        speakerWords: mapWordsToSpeakers(words, segment, entries),
      })
      refreshPendingLease(audioDir)
      writeMeetingBatchProgress(audioDir, {
        phase: 'hq_polish',
        segmentsDone: results.length,
        segmentsTotal: segments.length,
        meetingId,
      })
    } catch (error) {
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
}

const progressiveSessions = new Map<string, ProgressiveSessionState>()
let progressiveActiveSessionId: string | null = null
let progressiveOwnerSessionId: string | null = null

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
  if (progressiveActiveSessionId && progressiveActiveSessionId !== sessionId) return
  if (!nextMissingSealedSegment(state)) return
  state.queued = true

  void enqueueSerializedHqWork(async () => {
    state.queued = false
    if (state.closed || !progressiveMeetingHqEnabled()) return
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
      const enhanced = await enhanceAudio(combined)
      if (controller.signal.aborted || state.closed) return
      const decoded = await transcribeHighQuality(enhanced, pending.previousText?.slice(-250), {
        priority: 'batch',
        forceCpu: true,
        forceCpuReason: 'progressive_checkpoint',
        threads: progressiveThreads(),
        backgroundCpu: true,
        signal: controller.signal,
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
      }
      writeProgressiveCheckpoint(state.audioDir, sessionId, {
        key: checkpointKey(pending.segment),
        sourceHash,
        contextHash: contextHash(pending.previousText),
        configFingerprint: getHighQualityCheckpointFingerprint(),
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

/** Coalesced, global-single-flight progressive HQ admission after canonical persistence. */
export function scheduleProgressiveHqCheckpoint(
  sessionId: string,
  audioDir: string,
  entries: IndexedTranscriptChunk[],
  asrCompletedIndices: number[],
): void {
  if (!progressiveMeetingHqEnabled()) return
  if (progressiveOwnerSessionId && progressiveOwnerSessionId !== sessionId) return
  progressiveOwnerSessionId ??= sessionId
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
  }
  progressiveSessions.set(sessionId, state)
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
  if (progressiveOwnerSessionId === sessionId) progressiveOwnerSessionId = null
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
        state: state.active ? 'active' : state.queued ? 'queued' : 'idle',
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
  const job = batchQueueTail.then(() => runMeetingBatchPipelineNow(
    audioDir,
    entries,
    streamingWordCount,
    sessionId,
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
  sessionId?: string,
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
    const batchSegments = await transcribeSegments(audioDir, segments, entries, sessionId)
    writeMeetingBatchProgress(audioDir, {
      phase: 'quality_check',
      segmentsDone: segments.length,
      segmentsTotal: segments.length,
      meetingId: basename(audioDir),
    })
    const batchTranscript = batchSegments.map(result => result.text).join(' ')
    const qualityReport = evaluateBatchQuality(batchSegments, streamingWordCount)
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

    return { transcriptionQuality: 'batch', batchTranscript, batchSegments, qualityReport }
  } catch (error) {
    console.error(`[meeting-batch] Pipeline failed: ${error instanceof Error ? error.message : String(error)}`)
    writeMeetingBatchTerminal(audioDir, {
      outcome: 'failed',
      reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    })
    return { transcriptionQuality: 'streaming' }
  }
}
