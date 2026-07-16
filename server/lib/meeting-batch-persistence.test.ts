import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canDeletePendingBatchAudio,
  persistBatchDecisionSidecar,
  replaceMeetingTranscriptAtomic,
} from './meeting-batch-persistence.js'
import type { BatchTranscription } from './batch-transcript-quality.js'

function withFiles(run: (meetingPath: string, sidecarPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cos-meeting-batch-'))
  const meetingPath = join(dir, 'meeting.md')
  const sidecarPath = join(dir, 'meeting.g2-chunks.json')
  writeFileSync(
    meetingPath,
    '# Meeting\n\n| **Transcription quality** | streaming |\n\n## Summary\n\nPending.\n\n## Transcript\n\n[Speaker A]: canonical streaming text\n',
  )
  writeFileSync(sidecarPath, JSON.stringify({ chunks: [{ text: 'canonical streaming text' }] }))
  try { run(meetingPath, sidecarPath) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function acceptedBatch(): BatchTranscription {
  return {
    transcriptionQuality: 'batch',
    batchTranscript: '[Speaker A]: improved batch text',
    batchSegments: [],
    qualityReport: {
      accepted: true,
      reason: 'accepted',
      batchWordCount: 5,
      streamingWordCount: 5,
      coverageRatio: 1,
      timedWordCount: 0,
      timedWordRatio: 0,
      maxRepeatedUnitCount: 0,
      duplicateWordRatio: 0,
    },
  }
}

describe('meeting batch persistence', () => {
  it('durably applies accepted text, updates markdown metadata, and records the decision', () => withFiles((meetingPath, sidecarPath) => {
    const batch = acceptedBatch()
    const applied = replaceMeetingTranscriptAtomic(meetingPath, batch.batchTranscript!)
    const metadata = persistBatchDecisionSidecar(sidecarPath, batch, applied)
    const markdown = readFileSync(meetingPath, 'utf8')
    expect(markdown).toContain('[Speaker A]: improved batch text')
    expect(markdown).toContain('| **Transcription quality** | batch |')
    expect(JSON.parse(readFileSync(sidecarPath, 'utf8'))).toMatchObject({
      transcriptionQuality: 'batch',
      batchApplied: true,
    })
    expect(statSync(meetingPath).mode & 0o777).toBe(0o600)
    expect(statSync(sidecarPath).mode & 0o777).toBe(0o600)
    expect(canDeletePendingBatchAudio(applied, metadata)).toBe(true)
  }))

  it('records rejection without changing canonical text and preserves raw audio', () => withFiles((meetingPath, sidecarPath) => {
    const before = readFileSync(meetingPath, 'utf8')
    const rejected: BatchTranscription = {
      transcriptionQuality: 'streaming',
      qualityReport: {
        accepted: false,
        reason: 'repetitive-output',
        batchWordCount: 100,
        streamingWordCount: 100,
        coverageRatio: 1,
        timedWordCount: 0,
        timedWordRatio: 0,
        maxRepeatedUnitCount: 12,
        duplicateWordRatio: 0.5,
      },
    }
    const metadata = persistBatchDecisionSidecar(sidecarPath, rejected, false)
    expect(readFileSync(meetingPath, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(sidecarPath, 'utf8'))).toMatchObject({
      transcriptionQuality: 'streaming',
      batchApplied: false,
      batchQualityReport: { reason: 'repetitive-output' },
    })
    expect(canDeletePendingBatchAudio(false, metadata)).toBe(false)
  }))

  it('fails closed when the transcript marker, sidecar, or metadata JSON is invalid', () => withFiles((meetingPath, sidecarPath) => {
    writeFileSync(meetingPath, '# Meeting\n\nNo transcript marker.\n')
    expect(replaceMeetingTranscriptAtomic(meetingPath, 'candidate')).toBe(false)
    expect(canDeletePendingBatchAudio(false, true)).toBe(false)

    rmSync(sidecarPath, { force: true })
    expect(persistBatchDecisionSidecar(sidecarPath, acceptedBatch(), true)).toBe(false)

    writeFileSync(sidecarPath, '{not-json')
    expect(() => persistBatchDecisionSidecar(sidecarPath, acceptedBatch(), true)).toThrow()
    expect(canDeletePendingBatchAudio(true, false)).toBe(false)
  }))
})
