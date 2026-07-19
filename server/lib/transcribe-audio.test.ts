import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('fast local transcription ownership', () => {
  let transcribeAudioBuffer: typeof import('./transcribe-audio.js').transcribeAudioBuffer
  let transcribeLocal: ReturnType<typeof vi.fn>
  let getKeyStatus: ReturnType<typeof vi.fn>
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    delete process.env.COS_OPENAI_WHISPER_FALLBACK
    transcribeLocal = vi.fn(async () => ({ text: 'recovered while speaking', backend: 'mock' }))
    getKeyStatus = vi.fn(() => ({ hasKey: true, source: 'env' }))
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.doMock('./whisper-local.js', () => ({
      isWhisperLocalAvailable: () => false,
      transcribeLocal,
      transcribeHighQuality: vi.fn(),
      getWhisperBackend: () => 'mock',
      applyCorrections: (text: string) => text,
    }))
    vi.doMock('./audio-enhance.js', () => ({ enhanceAudio: async (b: Buffer) => b }))
    vi.doMock('./speaker-embeddings.js', () => ({ getAllSpeakerNames: () => [] }))
    vi.doMock('./openai-whisper-budget.js', () => ({
      assertOpenAIWhisperBudget: vi.fn(),
      recordOpenAIWhisperUsage: vi.fn(),
      estimateAudioSeconds: (buffer: Buffer) => buffer.length / 32000,
      OpenAIWhisperBudgetExhaustedError: class OpenAIWhisperBudgetExhaustedError extends Error {},
    }))
    vi.doMock('./openai-key.js', () => ({
      getKeyStatus,
      tryGetOpenAIKey: () => getKeyStatus().hasKey,
      getOpenAIKey: () => 'test-openai-key',
    }))
    ;({ transcribeAudioBuffer } = await import('./transcribe-audio.js'))
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('./whisper-local.js')
    vi.doUnmock('./audio-enhance.js')
    vi.doUnmock('./speaker-embeddings.js')
    vi.doUnmock('./openai-whisper-budget.js')
    vi.doUnmock('./openai-key.js')
    vi.unstubAllGlobals()
    delete process.env.COS_OPENAI_WHISPER_FALLBACK
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

  it('never fetches OpenAI when a key exists but fallback is not explicitly enabled', async () => {
    transcribeLocal.mockRejectedValueOnce(new Error('local worker down'))

    await expect(transcribeAudioBuffer(Buffer.alloc(3200, 1), {
      mode: 'fast',
      policy: 'automatic',
    })).rejects.toMatchObject({ reason: 'local_asr_unavailable', status: 503 })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never fetches OpenAI when the flag is enabled without a key', async () => {
    process.env.COS_OPENAI_WHISPER_FALLBACK = '1'
    getKeyStatus.mockReturnValue({ hasKey: false, source: 'none' })
    transcribeLocal.mockRejectedValueOnce(new Error('local worker down'))

    await expect(transcribeAudioBuffer(Buffer.alloc(3200, 1), {
      mode: 'fast',
      policy: 'automatic',
    })).rejects.toMatchObject({ reason: 'openai_key_missing', status: 503 })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses OpenAI only when the exact flag and a key are both configured', async () => {
    process.env.COS_OPENAI_WHISPER_FALLBACK = '1'
    transcribeLocal.mockRejectedValueOnce(new Error('local worker down'))
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'explicit cloud result' }),
    })

    const result = await transcribeAudioBuffer(Buffer.alloc(3200, 1), {
      mode: 'fast',
      policy: 'automatic',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(result).toMatchObject({ text: 'explicit cloud result', backend: 'cloud', actualQuality: 'cloud' })
  })
})
