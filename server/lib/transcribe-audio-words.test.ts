// 6.45.4 — the interactive HQ decode asks whisper for token clocks and the
// result carries them. QA 2026-09-12: without `words: true` the batch-only gate
// in whisper-local left `result.words` undefined on every prompt, so the tail
// guard's confidence rule could never fire; this executes the wiring.
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('./whisper-local.js')
  vi.doUnmock('./profile.js')
  vi.doUnmock('./speaker-embeddings.js')
})

describe('transcribeAudioBuffer words passthrough', () => {
  it('passes words: true to the interactive HQ decode and returns the words it gets back', async () => {
    const transcribeHighQuality = vi.fn(async () => ({
      text: 'Send the deck to Chris.',
      words: [{ word: 'Send', start: 0, end: 0.2, probability: 0.9 }, { word: '.', start: 1.5, end: 1.6, probability: 0.9 }],
      actualQuality: 'hq' as const, backend: 'whisper-cli' as const, degraded: false,
    }))
    vi.doMock('./whisper-local.js', () => ({
      transcribeHighQuality,
      transcribeLocal: vi.fn(async () => { throw new Error('fast path must not run') }),
      getWhisperBackend: () => 'whisper-cli',
      applyCorrections: (t: string) => t,
    }))
    vi.doMock('./profile.js', () => ({ getVocabulary: () => [], getOwnerName: () => 'Miles', getWhisperCorrections: () => ({}), getOwnerSpeakerLabel: () => 'MU' }))
    vi.doMock('./speaker-embeddings.js', () => ({
    AUTO_ENROLL_CANDIDATE_SIMILARITY: 0.72, AUTO_ENROLL_THRESHOLD: 0.88, getAllSpeakerNames: () => [] }))
    const { transcribeAudioBuffer } = await import('./transcribe-audio.js')
    const result = await transcribeAudioBuffer(Buffer.alloc(3200, 1), { mode: 'hq', policy: 'local-only' })
    expect(transcribeHighQuality).toHaveBeenCalledWith(expect.any(Buffer), undefined, expect.objectContaining({ priority: 'interactive', words: true }))
    expect(result.words).toHaveLength(2)
    expect(result.words?.[0]).toMatchObject({ word: 'Send', probability: 0.9 })
  })

  it('whisper-local honours the words flag outside batch priority', async () => {
    // The spawn itself cannot run here; pin the one line that decides whether
    // `-ojf` is requested, and that it is no longer batch-only.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./whisper-local.ts', import.meta.url), 'utf8')
    expect(src).toContain("const captureWords = opts.priority === 'batch' || opts.words === true")
    expect(src.match(/if \(captureWords\) \{\s*args\.push\('-ojf', '-of', outBase\)/)).not.toBeNull()
  })
})
