import { existsSync, readFileSync } from 'node:fs'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import type { BatchTranscription } from './batch-transcript-quality.js'

/** Replace only the final canonical transcript section. Missing markers fail closed. */
export function replaceMeetingTranscriptAtomic(meetingPath: string, transcript: string): boolean {
  const content = readFileSync(meetingPath, 'utf8')
  if (!/## Transcript\n\n[\s\S]*$/.test(content)) return false
  const updated = content
    .replace(/\| \*\*Transcription quality\*\* \| [^|\n]+ \|/i, '| **Transcription quality** | batch |')
    .replace(/## Transcript\n\n[\s\S]*$/, `## Transcript\n\n${transcript}\n`)
  durableAtomicWriteFileSync(meetingPath, updated, { mode: 0o600 })
  return true
}

/** Persist the batch decision without ever storing a rejected candidate as canonical. */
export function persistBatchDecisionSidecar(
  sidecarPath: string,
  batchResult: BatchTranscription,
  batchApplied: boolean,
): boolean {
  if (!existsSync(sidecarPath)) return false
  const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const sidecar = parsed as Record<string, unknown>
  sidecar.transcriptionQuality = batchApplied ? 'batch' : 'streaming'
  sidecar.batchApplied = batchApplied
  if (batchResult.qualityReport) sidecar.batchQualityReport = batchResult.qualityReport

  if (batchApplied) {
    sidecar.batchTranscript = batchResult.batchTranscript
    sidecar.batchSegments = batchResult.batchSegments?.map(result => ({
      startChunkIdx: result.segment.startChunkIdx,
      endChunkIdx: result.segment.endChunkIdx,
      startElapsed: result.segment.startElapsed,
      endElapsed: result.segment.endElapsed,
      text: result.text,
      words: result.words,
      speakerWords: result.speakerWords,
    }))
  } else {
    delete sidecar.batchTranscript
    delete sidecar.batchSegments
  }

  durableAtomicWriteFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), { mode: 0o600 })
  return true
}

/** Raw audio is disposable only after canonical text and decision metadata are durable. */
export function canDeletePendingBatchAudio(batchApplied: boolean, metadataPersisted: boolean): boolean {
  return batchApplied && metadataPersisted
}
