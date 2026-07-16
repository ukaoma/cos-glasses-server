// Generic post-meeting transcription. Raw WAV chunks are concatenated into
// larger windows so Whisper gets enough context to improve the live stream.
// The candidate is never canonical until batch-transcript-quality accepts it.

import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { enhanceAudio } from './audio-enhance.js'
import { transcribeHighQuality, type WhisperWord } from './whisper-local.js'
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
export function segmentTranscriptChunks(entries: IndexedTranscriptChunk[], targetMs = 30_000): BatchSegment[] {
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

  if (segmentStartPosition < entries.length) {
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

function stripOverlap(newText: string, previousText: string): string {
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

function mapWordsToSpeakers(
  words: WhisperWord[],
  segment: BatchSegment,
  entries: IndexedTranscriptChunk[],
): Array<{ word: string; start: number; end: number; speaker: string }> {
  return words.map(word => {
    const absoluteElapsed = segment.startElapsed + word.start * 1000
    let speaker = segment.speakers[0] || 'Unknown'
    let bestDistance = Number.POSITIVE_INFINITY
    for (const entry of entries) {
      if (entry.chunkIndex < segment.startChunkIdx || entry.chunkIndex > segment.endChunkIdx) continue
      const chunk = entry.chunk
      const distance = Math.abs(chunk.elapsed - absoluteElapsed)
      if (distance < bestDistance) {
        bestDistance = distance
        speaker = chunk.speaker
      }
    }
    if (bestDistance > 3_500) speaker = segment.speakers[0] || 'Unknown'
    return { word: word.word, start: word.start, end: word.end, speaker }
  })
}

async function transcribeSegments(
  audioDir: string,
  segments: BatchSegment[],
  entries: IndexedTranscriptChunk[],
): Promise<BatchResult[]> {
  const results: BatchResult[] = []
  for (const segment of segments) {
    try {
      refreshPendingLease(audioDir)
      const combined = concatenateWavChunks(audioDir, segment.startChunkIdx, segment.endChunkIdx)
      const enhanced = await enhanceAudio(combined)
      const previousText = results.at(-1)?.text
      const result = await transcribeHighQuality(enhanced, previousText?.slice(-250))
      const text = previousText ? stripOverlap(result.text, previousText) : result.text
      const words = result.words ?? []
      results.push({
        segment,
        text,
        words,
        speakerWords: mapWordsToSpeakers(words, segment, entries),
      })
      refreshPendingLease(audioDir)
    } catch (error) {
      console.error(
        `[meeting-batch] Segment ${segment.startChunkIdx}-${segment.endChunkIdx} failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return results
}

let batchQueueTail: Promise<void> = Promise.resolve()

/** Serialize 16-thread HQ decoders across meetings on a public user's Mac. */
export function runMeetingBatchPipeline(
  audioDir: string,
  entries: IndexedTranscriptChunk[],
  streamingWordCount: number,
): Promise<BatchTranscription> {
  // Lease immediately, including time spent behind another HQ decoder. Without
  // this, the two-hour cleanup could delete a queued meeting before it starts.
  refreshPendingLease(audioDir)
  const lease = setInterval(() => refreshPendingLease(audioDir), 60_000)
  lease.unref()
  const job = batchQueueTail.then(() => runMeetingBatchPipelineNow(
    audioDir,
    entries,
    streamingWordCount,
  )).finally(() => clearInterval(lease))
  batchQueueTail = job.then(() => undefined, () => undefined)
  return job
}

async function runMeetingBatchPipelineNow(
  audioDir: string,
  entries: IndexedTranscriptChunk[],
  streamingWordCount: number,
): Promise<BatchTranscription> {
  try {
    refreshPendingLease(audioDir)
    if (!existsSync(audioDir)) return { transcriptionQuality: 'streaming' }
    if (!readdirSync(audioDir).some(filename => filename.endsWith('.wav'))) {
      return { transcriptionQuality: 'streaming' }
    }
    const segments = segmentTranscriptChunks(entries)
    if (segments.length === 0) return { transcriptionQuality: 'streaming' }

    const batchSegments = await transcribeSegments(audioDir, segments, entries)
    const batchTranscript = batchSegments.map(result => result.text).join(' ')
    const qualityReport = evaluateBatchQuality(batchSegments, streamingWordCount)
    if (!qualityReport.accepted) {
      console.warn(
        `[meeting-batch] Candidate rejected (${qualityReport.reason}): `
        + `${qualityReport.batchWordCount} batch words, `
        + `${qualityReport.streamingWordCount} live words, `
        + `${(qualityReport.duplicateWordRatio * 100).toFixed(1)}% duplicate`,
      )
      return { transcriptionQuality: 'streaming', qualityReport }
    }

    return { transcriptionQuality: 'batch', batchTranscript, batchSegments, qualityReport }
  } catch (error) {
    console.error(`[meeting-batch] Pipeline failed: ${error instanceof Error ? error.message : String(error)}`)
    return { transcriptionQuality: 'streaming' }
  }
}
