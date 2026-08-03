import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('adaptive Whisper preview selection', () => {
  afterEach(() => {
    delete process.env.COS_WHISPER_PREVIEW_MODEL
    delete process.env.COS_WHISPER_REALTIME_MODEL
    delete process.env.COS_WHISPER_TRANSCRIPTION_TIER
    delete process.env.COS_WHISPER_COMMIT_MODEL
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
      getWhisperCommitCapability: () => ({
        requestedTier: 'balanced', effectiveTier: 'balanced',
        requestedModel: 'turbo', effectiveModel: 'large-v3-turbo',
        ready: true, configured: true, degraded: false, reason: null,
        promptPolicy: 'full-vocabulary',
      }),
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
    const execFile = vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: any, stdout: string) => void) => {
      const error = Object.assign(new Error('no listeners'), { code: 1 })
      callback(error, '')
    })
    vi.doMock('node:child_process', () => ({ spawn: vi.fn(() => child), execFile }))
    const transcribeLocal = vi.fn().mockResolvedValue({ text: 'Turbo commit-quality fallback', backend: 'server' })
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (text: string) => text,
      getWhisperCommitCapability: () => ({
        requestedTier: 'balanced', effectiveTier: 'balanced',
        requestedModel: 'turbo', effectiveModel: 'large-v3-turbo',
        ready: true, configured: true, degraded: false, reason: null,
        promptPolicy: 'full-vocabulary',
      }),
      getWhisperHealth: () => ({ server: true }),
      transcribeLocal,
    }))
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('port clear'))
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = init.body as FormData
        expect(body.get('prompt')).toBeNull()
        throw new Error('small worker inference failed')
      })
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
      expect.any(Buffer), undefined, undefined, { affectsCircuit: false, promptPolicy: 'none' },
    )
  })

  it('uses the resident Large-v3 commit worker for Max preview without spawning a third model', async () => {
    process.env.COS_WHISPER_TRANSCRIPTION_TIER = 'max'
    const spawn = vi.fn()
    vi.doMock('node:child_process', () => ({ spawn, execFile: vi.fn() }))
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: () => true,
    }))
    const transcribeLocal = vi.fn().mockResolvedValue({ text: 'Large-v3 preview and commit', backend: 'server' })
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (text: string) => text,
      getWhisperCommitCapability: () => ({
        requestedTier: 'max', effectiveTier: 'max',
        requestedModel: 'large-v3', effectiveModel: 'large-v3',
        ready: true, configured: true, degraded: false, reason: null,
        promptPolicy: 'full-vocabulary',
      }),
      getWhisperHealth: () => ({ server: true }),
      transcribeLocal,
    }))

    const preview = await import('./whisper-preview.js')
    await preview.startWhisperPreviewServer()
    expect(spawn).not.toHaveBeenCalled()
    expect(preview.getWhisperPreviewCapability()).toMatchObject({
      requested: 'turbo',
      requestedTier: 'max',
      effectiveTier: 'max',
      effectiveModel: 'large-v3',
      committedModel: 'large-v3',
      promptPolicy: 'none',
    })
    await expect(preview.transcribeWhisperPreview(Buffer.alloc(3200, 1))).resolves.toEqual({
      text: 'Large-v3 preview and commit', model: 'large-v3', backend: 'whisper-server',
    })
    expect(transcribeLocal).toHaveBeenCalledWith(
      expect.any(Buffer), undefined, undefined, { affectsCircuit: false, promptPolicy: 'none' },
    )
  })

  it('reaps a verified orphaned Small.en worker and replaces it with an owned child', async () => {
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
    const spawn = vi.fn(() => child)
    let lsofCalls = 0
    const execFile = vi.fn((file: string, _args: string[], _options: unknown, callback: (error: any, stdout: string) => void) => {
      if (file.endsWith('lsof')) {
        lsofCalls++
        if (lsofCalls === 1) callback(null, '4321\n')
        else callback(Object.assign(new Error('no listeners'), { code: 1 }), '')
        return
      }
      callback(null, `4321 1 /opt/homebrew/bin/whisper-server -m ${process.env.HOME}/.local/share/whisper-models/ggml-small.en.bin --port 8177\n`)
    })
    vi.doMock('node:child_process', () => ({ spawn, execFile }))
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (text: string) => text,
      getWhisperCommitCapability: () => ({
        requestedTier: 'balanced', effectiveTier: 'balanced',
        requestedModel: 'turbo', effectiveModel: 'large-v3-turbo',
        ready: true, configured: true, degraded: false, reason: null,
        promptPolicy: 'full-vocabulary',
      }),
      getWhisperHealth: () => ({ server: true }),
      transcribeLocal: vi.fn(),
    }))
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        expect((init.body as FormData).get('prompt')).toBeNull()
        return { ok: true, json: async () => ({ text: 'orphan worker reused' }) }
      }))

    const preview = await import('./whisper-preview.js')
    await preview.startWhisperPreviewServer()
    expect(kill).toHaveBeenCalledWith(4321, 'SIGKILL')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(preview.getWhisperPreviewCapability()).toMatchObject({
      effectiveModel: 'small.en', ready: true, reason: null,
    })
    await expect(preview.transcribeWhisperPreview(Buffer.alloc(3200, 1))).resolves.toMatchObject({
      text: 'orphan worker reused', model: 'small.en', backend: 'whisper-preview-server',
    })
  })

  it('never contacts or kills an unrelated listener on the preview port', async () => {
    process.env.COS_WHISPER_PREVIEW_MODEL = 'small.en'
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: () => true,
    }))
    const spawn = vi.fn()
    const execFile = vi.fn((file: string, _args: string[], _options: unknown, callback: (error: any, stdout: string) => void) => {
      callback(null, file.endsWith('lsof')
        ? '9876\n'
        : '9876 1 /usr/local/bin/unrelated-health-service --port 8177\n')
    })
    vi.doMock('node:child_process', () => ({ spawn, execFile }))
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (text: string) => text,
      getWhisperCommitCapability: () => ({
        requestedTier: 'balanced', effectiveTier: 'balanced',
        requestedModel: 'turbo', effectiveModel: 'large-v3-turbo',
        ready: true, configured: true, degraded: false, reason: null,
        promptPolicy: 'full-vocabulary',
      }),
      getWhisperHealth: () => ({ server: true }),
      transcribeLocal: vi.fn(),
    }))

    const preview = await import('./whisper-preview.js')
    await preview.startWhisperPreviewServer()
    expect(preview.getWhisperPreviewCapability()).toMatchObject({
      effectiveModel: 'large-v3-turbo', degraded: true, reason: 'preview_port_busy',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
