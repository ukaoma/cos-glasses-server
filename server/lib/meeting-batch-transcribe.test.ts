import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BatchResult, BatchSegment } from './batch-transcript-quality.js'
import {
  __progressiveHqTesting,
  mapWordsToSpeakers,
  progressiveMeetingHqEnabled,
  segmentTranscriptChunks,
} from './meeting-batch-transcribe.js'
import { getHighQualityCheckpointFingerprint } from './whisper-local.js'
import type { IndexedTranscriptChunk } from '../routes/transcribe-stream.js'

function wav(pcm = Buffer.alloc(320)): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(pcm.length + 36, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function entries(): IndexedTranscriptChunk[] {
  return [0, 10_000, 20_000, 30_000, 40_000].map((elapsed, chunkIndex) => ({
    chunkIndex,
    chunk: { text: `chunk ${chunkIndex}`, speaker: 'MU', elapsed, similarity: 1 },
  }))
}

describe('progressive meeting HQ checkpoints', () => {
  afterEach(() => {
    __progressiveHqTesting.resetProgressiveSessions()
  })

  it('uses a conservative two-thread ceiling for Balanced on an M1/M2-class CPU', () => {
    expect(__progressiveHqTesting.resolveProgressiveHqPolicy({
      requested: true,
      effectiveTier: 'balanced',
      hqAvailable: true,
      logicalCpus: 8,
    })).toMatchObject({
      enabled: true,
      tier: 'balanced',
      mode: 'balanced-conservative',
      threads: 2,
      reason: null,
    })
    expect(__progressiveHqTesting.resolveProgressiveHqPolicy({
      requested: true,
      effectiveTier: 'balanced',
      hqAvailable: true,
      logicalCpus: 8,
      requestedThreads: 8,
    }).threads).toBe(2)
  })

  it('uses the faster Max policy without exceeding available CPUs', () => {
    expect(__progressiveHqTesting.resolveProgressiveHqPolicy({
      requested: true,
      effectiveTier: 'max',
      hqAvailable: true,
      logicalCpus: 32,
    })).toMatchObject({ mode: 'max-performance', threads: 6 })
    expect(__progressiveHqTesting.resolveProgressiveHqPolicy({
      requested: true,
      effectiveTier: 'max',
      hqAvailable: true,
      logicalCpus: 4,
      requestedThreads: 8,
    }).threads).toBe(4)
  })

  it('reports why progressive HQ is not admitted', () => {
    expect(__progressiveHqTesting.resolveProgressiveHqPolicy({
      requested: false,
      effectiveTier: 'balanced',
      hqAvailable: true,
      logicalCpus: 8,
    })).toMatchObject({ enabled: false, reason: 'disabled_by_flag' })
    expect(__progressiveHqTesting.resolveProgressiveHqPolicy({
      requested: true,
      effectiveTier: 'max',
      hqAvailable: false,
      logicalCpus: 8,
    })).toMatchObject({ enabled: false, reason: 'hq_unavailable' })
  })

  it('stays default-off without the explicit canary flag', () => {
    const prior = process.env.COS_MEETING_PROGRESSIVE_HQ
    try {
      delete process.env.COS_MEETING_PROGRESSIVE_HQ
      expect(progressiveMeetingHqEnabled()).toBe(false)
      process.env.COS_MEETING_PROGRESSIVE_HQ = '0'
      expect(progressiveMeetingHqEnabled()).toBe(false)
    } finally {
      if (prior == null) delete process.env.COS_MEETING_PROGRESSIVE_HQ
      else process.env.COS_MEETING_PROGRESSIVE_HQ = prior
    }
  })
  it('keeps sealed boundaries stable and excludes the open tail', () => {
    const first = segmentTranscriptChunks(entries().slice(0, 4), 30_000, false)
    const appended = segmentTranscriptChunks(entries(), 30_000, false)
    expect(first).toHaveLength(1)
    expect(appended).toHaveLength(1)
    expect(appended[0]).toEqual(first[0])
    expect(segmentTranscriptChunks(entries(), 30_000, true)).toHaveLength(2)
  })

  it('admits a sealed checkpoint only after every chunk has an ASR outcome', () => {
    const segment = segmentTranscriptChunks(entries().slice(0, 4), 30_000, false)[0]!
    expect(__progressiveHqTesting.segmentRangeIsComplete(segment, [0, 1, 2])).toBe(false)
    expect(__progressiveHqTesting.segmentRangeIsComplete(segment, [0, 1, 2, 3])).toBe(true)
  })

  it('admits multiple live sessions instead of pinning the first owner forever', () => {
    const now = 1_000_000
    __progressiveHqTesting.admitProgressiveSession('meeting_first', '/tmp/meeting_first', entries(), [0, 1, 2, 3], now)
    __progressiveHqTesting.admitProgressiveSession('meeting_second', '/tmp/meeting_second', entries(), [0, 1, 2, 3], now + 1)
    expect(__progressiveHqTesting.progressiveSessionIds()).toEqual([
      'meeting_first',
      'meeting_second',
    ])
  })

  it('yields only stale disposable work and resumes it when new input arrives', () => {
    const start = 1_000_000
    const first = __progressiveHqTesting.admitProgressiveSession(
      'meeting_first', '/tmp/meeting_first', entries(), [0, 1, 2, 3], start,
    )
    const firstController = new AbortController()
    first.active = true
    first.controller = firstController
    const second = __progressiveHqTesting.admitProgressiveSession(
      'meeting_second', '/tmp/meeting_second', entries(), [0, 1, 2, 3], start + 45_000,
    )
    const secondController = new AbortController()
    second.active = true
    second.controller = secondController

    __progressiveHqTesting.yieldIdleProgressiveSessions('meeting_second', start + 45_000)
    expect(firstController.signal.aborted).toBe(true)
    expect(secondController.signal.aborted).toBe(false)
    expect(__progressiveHqTesting.progressiveSessionIsIdle(first, start + 45_000)).toBe(true)

    const resumedEntries = entries()
    resumedEntries.push({
      chunkIndex: 5,
      chunk: { text: 'new audio', speaker: 'MU', elapsed: 50_000, similarity: 1 },
    })
    __progressiveHqTesting.admitProgressiveSession(
      'meeting_first', '/tmp/meeting_first', resumedEntries, [0, 1, 2, 3, 4, 5], start + 45_001,
    )
    expect(__progressiveHqTesting.progressiveSessionIsIdle(first, start + 45_001)).toBe(false)
  })

  it('preserves source speaker confidence instead of upgrading labels', () => {
    const source = entries().slice(0, 2)
    source[0]!.chunk.speaker = 'Client Label'
    source[0]!.chunk.similarity = 0
    const segment = segmentTranscriptChunks(source, 30_000, true)[0]!
    expect(mapWordsToSpeakers(
      [{ word: 'hello', start: 0, end: 0.2, probability: 1 }],
      segment,
      source,
    )[0]).toMatchObject({ speaker: 'Client Label', similarity: 0 })
  })

  it('parks a deterministic failed segment by immutable source identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-progressive-hq-'))
    try {
      for (let index = 0; index <= 3; index++) {
        writeFileSync(join(root, `chunk_${String(index).padStart(4, '0')}.wav`), wav(Buffer.alloc(320, index)))
      }
      const segment = segmentTranscriptChunks(entries().slice(0, 4), 30_000, false)[0]!
      const failedIdentity = __progressiveHqTesting.progressiveFailureIdentity(root, segment)
      const state = {
        sessionId: 'meeting_failure_001',
        audioDir: root,
        entries: entries().slice(0, 4),
        asrCompletedIndices: [0, 1, 2, 3],
        queued: false,
        active: false,
        closed: false,
        inputRevision: 1,
        inputSignature: 'first',
        failedIdentity: failedIdentity!,
        failedAttempts: 3,
        retryAfter: 0,
        lastInputAt: Date.now(),
        idleYieldLogged: false,
      }
      expect(__progressiveHqTesting.nextMissingSealedSegment(state)).toBeNull()
      // Unrelated later chunks do not re-enable an unchanged failed segment.
      state.inputRevision = 2
      expect(__progressiveHqTesting.nextMissingSealedSegment(state)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reuses only matching audio, config, and prior-context hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-progressive-hq-'))
    try {
      for (let index = 0; index <= 3; index++) {
        writeFileSync(join(root, `chunk_${String(index).padStart(4, '0')}.wav`), wav(Buffer.alloc(320, index)))
      }
      const segment = segmentTranscriptChunks(entries().slice(0, 4), 30_000, false)[0] as BatchSegment
      const result: BatchResult = { segment, text: 'checkpoint text', words: [], speakerWords: [] }
      const sourceHash = __progressiveHqTesting.segmentSourceHash(root, segment)!
      __progressiveHqTesting.writeProgressiveCheckpoint(root, 'session_001', {
        key: __progressiveHqTesting.checkpointKey(segment),
        sourceHash,
        contextHash: __progressiveHqTesting.contextHash(undefined),
        configFingerprint: getHighQualityCheckpointFingerprint(),
        completedAt: new Date().toISOString(),
        wallTimeMs: 10,
        result,
      })

      expect(__progressiveHqTesting.readProgressiveCheckpoint(root, segment, undefined)?.text)
        .toBe('checkpoint text')
      expect(__progressiveHqTesting.readProgressiveCheckpoint(root, segment, undefined, 'session_001')?.text)
        .toBe('checkpoint text')
      expect(__progressiveHqTesting.readProgressiveCheckpoint(root, segment, undefined, 'session_002'))
        .toBeNull()
      expect(__progressiveHqTesting.readProgressiveCheckpoint(root, segment, 'different context'))
        .toBeNull()
      writeFileSync(join(root, 'chunk_0002.wav'), wav(Buffer.alloc(320, 9)))
      expect(__progressiveHqTesting.readProgressiveCheckpoint(root, segment, undefined)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores a corrupt or incomplete manifest without touching raw audio', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-progressive-hq-'))
    try {
      for (let index = 0; index <= 3; index++) {
        writeFileSync(join(root, `chunk_${String(index).padStart(4, '0')}.wav`), wav())
      }
      writeFileSync(join(root, '_progressive_hq.json'), '{broken')
      const segment = segmentTranscriptChunks(entries().slice(0, 4), 30_000, false)[0]!
      expect(__progressiveHqTesting.readProgressiveCheckpoint(root, segment)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects structurally invalid cached timing and speaker words', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-progressive-hq-'))
    try {
      for (let index = 0; index <= 3; index++) {
        writeFileSync(join(root, `chunk_${String(index).padStart(4, '0')}.wav`), wav())
      }
      const segment = segmentTranscriptChunks(entries().slice(0, 4), 30_000, false)[0] as BatchSegment
      __progressiveHqTesting.writeProgressiveCheckpoint(root, 'session_invalid', {
        key: __progressiveHqTesting.checkpointKey(segment),
        sourceHash: __progressiveHqTesting.segmentSourceHash(root, segment)!,
        contextHash: __progressiveHqTesting.contextHash(undefined),
        configFingerprint: getHighQualityCheckpointFingerprint(),
        completedAt: new Date().toISOString(),
        wallTimeMs: 10,
        result: {
          segment,
          text: 'bad cache',
          words: [{ word: 'bad', start: -1, end: 0, probability: 1 }],
          speakerWords: [{ word: 'bad', start: 0, end: 1, probability: 1 } as any],
        },
      })
      expect(__progressiveHqTesting.readProgressiveCheckpoint(root, segment)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
