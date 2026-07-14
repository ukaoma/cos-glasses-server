import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('fast local transcription ownership', () => {
  let transcribeAudioBuffer: typeof import('./transcribe-audio.js').transcribeAudioBuffer
  let transcribeLocal: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    transcribeLocal = vi.fn(async () => ({ text: 'recovered while speaking', backend: 'mock' }))
    vi.doMock('./whisper-local.js', () => ({
      isWhisperLocalAvailable: () => false,
      transcribeLocal,
      transcribeHighQuality: vi.fn(),
      getWhisperBackend: () => 'mock',
      applyCorrections: (text: string) => text,
    }))
    vi.doMock('./audio-enhance.js', () => ({ enhanceAudio: async (b: Buffer) => b }))
    vi.doMock('./speaker-embeddings.js', () => ({ getAllSpeakerNames: () => [] }))
    ;({ transcribeAudioBuffer } = await import('./transcribe-audio.js'))
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('./whisper-local.js')
    vi.doUnmock('./audio-enhance.js')
    vi.doUnmock('./speaker-embeddings.js')
  })

  it('lets the Whisper owner reconcile stale availability in local-only mode', async () => {
    const result = await transcribeAudioBuffer(Buffer.alloc(3200, 1), {
      mode: 'fast',
      policy: 'local-only',
    })

    expect(transcribeLocal).toHaveBeenCalledTimes(1)
    expect(result.text).toBe('recovered while speaking')
    expect(result.actualQuality).toBe('fast')
  })
})
