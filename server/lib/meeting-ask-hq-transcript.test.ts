import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('./whisper-local.js', () => ({
  getHighQualityCheckpointFingerprint: () => 'canary-config',
  getHighQualityTranscriptionCapability: () => ({ hqAvailable: true }),
  getWhisperCommitCapability: () => ({ effectiveTier: 'max' }),
  transcribeHighQuality: vi.fn(() => { throw new Error('Ask must not decode audio') }),
}))
import { __progressiveHqTesting as cache, readProgressiveAskRefinements, segmentTranscriptChunks } from './meeting-batch-transcribe.js'
import { meetingAskTranscript } from './meeting-ask-hq-transcript.js'
import { meetingEvidence } from './live-cos-ask.js'
import type { IndexedTranscriptChunk } from '../routes/transcribe-stream.js'

const originalEnv = { ...process.env }
const roots: string[] = []
afterEach(() => {
  for (const key of ['COS_BATCH_HQ_TIMESTAMPS', 'COS_MEETING_ASK_HQ_EVIDENCE', 'COS_MEETING_PROGRESSIVE_HQ']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ask-hq-cache-')); roots.push(root)
  const texts = [
    'Nina will send the revised quote on Friday.',
    'The budget is 14000 and cannot exceed that.',
    'Omar will review the contract before we sign.',
    'The launch date is tentative pending legal approval.',
    'We have not approved the additional annual expense.',
    'Please confirm delivery with the supplier this afternoon.',
    'Latest correction: the review moved to next Monday.',
  ]
  const entries: IndexedTranscriptChunk[] = texts.map((text, chunkIndex) => ({ chunkIndex, chunk: {
    text, speaker: 'Nina', elapsed: chunkIndex * 6000, similarity: 0.9,
  } }))
  for (let i = 0; i < 6; i++) {
    const wav = Buffer.alloc(364, i); wav.write('RIFF', 0)
    writeFileSync(join(root, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
  }
  const segment = segmentTranscriptChunks(entries, 30000, false)[0]
  const text = texts.slice(0, 6).join(' ')
  const words = text.split(/\s+/).map((word, index) => ({ word, start: index / 3, end: (index + 1) / 3, probability: 0.9 }))
  const result = { segment, text, words, speakerWords: [] }
  const seed = (candidate = result, sessionId = 'meeting_canary') => cache.writeProgressiveCheckpoint(root, sessionId, {
    key: cache.checkpointKey(segment), sourceHash: cache.segmentSourceHash(root, segment)!,
    contextHash: cache.contextHash(undefined), configFingerprint: 'canary-config',
    completedAt: new Date().toISOString(), wallTimeMs: 100, result: candidate,
  })
  seed()
  process.env.COS_BATCH_HQ_TIMESTAMPS = '1'
  process.env.COS_MEETING_ASK_HQ_EVIDENCE = '1'
  process.env.COS_MEETING_PROGRESSIVE_HQ = '1'
  const read = (indices = [0, 1, 2, 3, 4, 5, 6]) => readProgressiveAskRefinements(root, 'meeting_canary', entries, indices)
  return { root, entries, result, seed, read }
}
describe('in-meeting Ask HQ evidence canary', () => {
  it('requires all opt-ins and never triggers a decode or deletes the latest correction', () => {
    const f = fixture()
    const refined = f.read()
    expect(refined).toHaveLength(1)
    const snapshot = meetingAskTranscript(f.entries, refined)
    expect(snapshot.turns.map(t => t.id)).toEqual([0, 6])
    expect(snapshot.turns.at(-1)!.text).toContain('next Monday')
    const evidence = meetingEvidence({ sessionId: 'meeting_canary', action: 'ask', question: 'What is the budget?', elapsedMs: 40000, turns: snapshot.turns, history: [] })
    expect(evidence.sources[0]).toMatchObject({ turnId: 0 })
    expect(evidence.sources[0].text).toContain('14000')
    for (const flag of ['COS_BATCH_HQ_TIMESTAMPS', 'COS_MEETING_ASK_HQ_EVIDENCE', 'COS_MEETING_PROGRESSIVE_HQ']) {
      process.env[flag] = '0'; expect(f.read()).toEqual([]); process.env[flag] = '1'
    }
  })
  it('rejects missing audio, changed audio, incomplete ASR and another meeting cache', () => {
    const f = fixture()
    expect(f.read([0, 1, 2, 4, 5, 6])).toEqual([])
    rmSync(join(f.root, '_progressive_hq.json'))
    f.seed(f.result, 'meeting_other'); expect(f.read()).toEqual([])
    rmSync(join(f.root, '_progressive_hq.json'))
    f.seed(); writeFileSync(join(f.root, 'chunk_0001.wav'), 'changed'); expect(f.read()).toEqual([])
    rmSync(join(f.root, 'chunk_0002.wav')); expect(f.read()).toEqual([])
  })
  it('holds shortened, repeated, unclocked or number-changing candidates', () => {
    const f = fixture()
    for (const change of [
      { text: 'Nina sends Friday' }, { text: f.result.text.replace('14000', '40000') },
      { words: [] }, { text: Array(8).fill(f.result.text).join(' ') },
    ]) { f.seed({ ...f.result, ...change }); expect(f.read()).toEqual([]) }
  })
  it('withholds speaker identity on mixed passages and keeps original snapshots immutable', () => {
    const f = fixture(); f.entries[2].chunk.speaker = 'Omar'
    const original = JSON.stringify(f.entries)
    const snapshot = meetingAskTranscript(f.entries, f.read())
    expect(snapshot.turns[0].speaker).toBe('Unidentified')
    expect(snapshot.notices).not.toEqual([])
    expect(JSON.stringify(f.entries)).toBe(original)
    expect(meetingAskTranscript(f.entries).turns).toHaveLength(7)
  })
})
