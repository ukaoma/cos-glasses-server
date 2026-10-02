// QA 6.61.0 (8): boot recovery strips inline hallucinations from a recovered
// chunk's text. Its Nemotron turns must still join to that text, or be dropped.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
afterEach(() => {
  vi.resetModules()
  for (const mod of ['../lib/whisper-local.js', '../lib/audio-enhance.js', '../lib/speaker-embeddings.js', '../lib/vad-silero.js', '../lib/profile.js', '../lib/hallucination-filter.js']) vi.doUnmock(mod)
  delete process.env.COS_DATA_DIR
})

it('a recovered chunk whose text loses words keeps turns that join to the text, or none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-recovery-segments-')); roots.push(root)
  process.env.COS_DATA_DIR = root
  mkdirSync(join(root, 'active-sessions'), { recursive: true })
  const turns = (a: string, b: string) => [
    { speaker: 'MU', text: a, startSec: 0, endSec: 2, similarity: 0.8 },
    { speaker: 'Silas Larson', text: b, startSec: 2, endSec: 5, similarity: 0.7 },
  ]
  const chunks = [
    // Stripping removes "zzqq" and the turns are refitted.
    { i: 0, c: { text: 'alpha bravo zzqq charlie', speaker: 'Silas Larson', elapsed: 6000, similarity: 0.7, segments: turns('alpha bravo zzqq', 'charlie') } },
    // Stripping rewrites a word: the turns cannot be trusted and are dropped.
    { i: 1, c: { text: 'delta echo foxtrot', speaker: 'MU', elapsed: 12000, similarity: 0.8, segments: turns('delta echo', 'foxtrot') } },
  ]
  writeFileSync(join(root, 'active-sessions', 'recovery_segments_001.json'), JSON.stringify({
    sessionId: 'recovery_segments_001', startTime: Date.now() - 60_000, lastActivityAt: Date.now() - 1_000, title: '',
    chunks: chunks.map(e => e.c), chunksIndexed: chunks, receivedIndices: [0, 1], asrCompletedIndices: [0, 1],
    emptyCompletions: {}, maxChunkIndex: 1, providerCandidates: {},
  }))
  vi.doMock('../lib/whisper-local.js', () => ({ transcribeLocal: vi.fn(), applyCorrections: (text: string) => text }))
  vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    AUTO_ENROLL_CANDIDATE_SIMILARITY: 0.72, identifySpeaker: vi.fn(), isEmbeddingAvailable: () => false, autoEnroll: vi.fn(), getEmbeddingCount: () => 0,
  }))
  vi.doMock('../lib/vad-silero.js', () => ({ trimSilence: vi.fn(), isSileroAvailable: () => false }))
  vi.doMock('../lib/profile.js', () => ({ getVocabulary: () => [], getOwnerName: () => 'COS', getWhisperCorrections: () => '', getOwnerSpeakerLabel: () => 'MU' }))
  vi.doMock('../lib/hallucination-filter.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/hallucination-filter.js')>()),
    stripInlineHallucinations: (text: string) => text.replace(' zzqq', '').replace('echo', 'eko'),
  }))
  const stream = await import('./transcribe-stream.js')
  const [first, second] = stream.getSessionChunks('recovery_segments_001')!
  expect(first.text).toBe('alpha bravo charlie')
  expect(first.segments).toEqual([
    { speaker: 'MU', text: 'alpha bravo', startSec: 0, endSec: 2, similarity: 0.8 },
    { speaker: 'Silas Larson', text: 'charlie', startSec: 2, endSec: 5, similarity: 0.7 },
  ])
  expect(second.text).toBe('delta eko foxtrot')
  expect(second.segments).toBeUndefined()
  stream.deleteSession('recovery_segments_001')
})
