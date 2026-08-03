import { afterEach, describe, expect, it, vi } from 'vitest'

describe('Whisper committed model policy', () => {
  afterEach(() => {
    delete process.env.COS_WHISPER_TRANSCRIPTION_TIER
    delete process.env.COS_WHISPER_COMMIT_MODEL
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  it('normalizes only supported public aliases', async () => {
    const { normalizeWhisperCommitRequest, normalizeWhisperTranscriptionTier } = await import('./whisper-local.js')
    expect(normalizeWhisperTranscriptionTier('MAX')).toBe('max')
    expect(normalizeWhisperTranscriptionTier('fast')).toBe('balanced')
    expect(normalizeWhisperCommitRequest('ggml-large-v3.bin')).toBe('large-v3')
    expect(normalizeWhisperCommitRequest('large-v3-turbo')).toBe('turbo')
  })

  it('falls Max back to immutable Turbo when Large-v3 is missing', async () => {
    process.env.COS_WHISPER_TRANSCRIPTION_TIER = 'max'
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: (path: string) => !path.endsWith('/ggml-large-v3.bin'),
    }))
    const { getWhisperCommitCapability } = await import('./whisper-local.js')
    expect(getWhisperCommitCapability()).toMatchObject({
      requestedTier: 'max', effectiveTier: 'balanced',
      requestedModel: 'large-v3', effectiveModel: 'large-v3-turbo',
      configured: true, degraded: true, reason: 'large_v3_model_missing',
    })
  })

  it('keeps the Turbo fallback independent when Max is available', async () => {
    process.env.COS_WHISPER_TRANSCRIPTION_TIER = 'max'
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: () => true,
    }))
    const whisper = await import('./whisper-local.js')
    expect(whisper.WHISPER_TURBO_MODEL_PATH).toMatch(/ggml-large-v3-turbo\.bin$/)
    expect(whisper.WHISPER_LARGE_V3_MODEL_PATH).toMatch(/ggml-large-v3\.bin$/)
    expect(whisper.getWhisperCommitCapability()).toMatchObject({
      requestedTier: 'max', effectiveTier: 'max', effectiveModel: 'large-v3', degraded: false,
    })
  })

  it('reports Max degraded when its immutable Turbo fallback is missing', async () => {
    process.env.COS_WHISPER_TRANSCRIPTION_TIER = 'max'
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: (path: string) => !path.endsWith('/ggml-large-v3-turbo.bin'),
    }))
    const { getWhisperCommitCapability } = await import('./whisper-local.js')
    expect(getWhisperCommitCapability()).toMatchObject({
      requestedTier: 'max', effectiveTier: 'max',
      requestedModel: 'large-v3', effectiveModel: 'large-v3',
      configured: true, degraded: true, reason: 'turbo_model_missing',
    })
  })
})
