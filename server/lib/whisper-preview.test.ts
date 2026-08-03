import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('adaptive Whisper preview selection', () => {
  afterEach(() => {
    delete process.env.COS_WHISPER_PREVIEW_MODEL
    delete process.env.COS_WHISPER_REALTIME_MODEL
    vi.unstubAllGlobals()
    vi.doUnmock('node:fs')
    vi.doUnmock('node:child_process')
    vi.doUnmock('./whisper-local.js')
    vi.resetModules()
  })

  it('normalizes friendly setup aliases without changing committed Turbo', async () => {
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: () => false,
    }))
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (text: string) => text,
      getWhisperHealth: () => ({ server: true }),
      transcribeLocal: vi.fn(),
    }))
    const preview = await import('./whisper-preview.js')
    expect(preview.normalizeWhisperPreviewRequest()).toBe('turbo')
    expect(preview.normalizeWhisperPreviewRequest('adaptive')).toBe('auto')
    expect(preview.normalizeWhisperPreviewRequest('small')).toBe('small.en')
    expect(preview.normalizeWhisperPreviewRequest('large-v3-turbo')).toBe('turbo')
    expect(preview.normalizeWhisperPreviewRequest('disabled')).toBe('off')
    process.env.COS_WHISPER_PREVIEW_MODEL = 'small.en'
    expect(preview.getWhisperPreviewCapability()).toMatchObject({
      requested: 'small.en',
      effectiveModel: 'large-v3-turbo',
      ready: true,
      degraded: true,
      reason: 'small_model_missing',
      committedModel: 'large-v3-turbo',
    })
  })

  it('uses Small.en only for preview and falls back through non-circuit Turbo', async () => {
    process.env.COS_WHISPER_PREVIEW_MODEL = 'small.en'
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: () => true,
    }))
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    })
    vi.doMock('node:child_process', () => ({ spawn: vi.fn(() => child) }))
    const transcribeLocal = vi.fn().mockResolvedValue({ text: 'Turbo commit-quality fallback', backend: 'server' })
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (text: string) => text,
      getWhisperHealth: () => ({ server: true }),
      transcribeLocal,
    }))
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('port clear'))
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('small worker inference failed'))
    vi.stubGlobal('fetch', fetchMock)

    const preview = await import('./whisper-preview.js')
    await preview.startWhisperPreviewServer()
    expect(preview.getWhisperPreviewCapability()).toMatchObject({
      effectiveModel: 'small.en', ready: true, committedModel: 'large-v3-turbo',
    })
    await expect(preview.transcribeWhisperPreview(Buffer.alloc(3200, 1))).resolves.toEqual({
      text: 'Turbo commit-quality fallback', model: 'large-v3-turbo', backend: 'whisper-server',
    })
    expect(transcribeLocal).toHaveBeenCalledWith(
      expect.any(Buffer), undefined, undefined, { affectsCircuit: false },
    )
  })
})
