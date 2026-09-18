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
      expect.any(Buffer), undefined, undefined, {
        affectsCircuit: false,
        promptPolicy: 'none',
        metalPriority: 'preview',
      },
    )
  })

  it('uses an isolated Turbo worker for Max preview while Large-v3 remains canonical', async () => {
    process.env.COS_WHISPER_TRANSCRIPTION_TIER = 'max'
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    })
    const spawn = vi.fn(() => child)
    const execFile = vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: any, stdout: string) => void) => {
      callback(Object.assign(new Error('no listeners'), { code: 1 }), '')
    })
    vi.doMock('node:child_process', () => ({ spawn, execFile }))
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: () => true,
    }))
    const transcribeLocal = vi.fn()
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
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockImplementation(async (_url: string, init: RequestInit) => {
        expect((init.body as FormData).get('prompt')).toBeNull()
        return { ok: true, json: async () => ({ text: 'Turbo provisional preview' }) }
      }))

    const preview = await import('./whisper-preview.js')
    await preview.startWhisperPreviewServer()
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('whisper-server'),
      expect.arrayContaining([
        '-m', expect.stringContaining('ggml-large-v3-turbo.bin'),
        '--port', '8177',
      ]),
      { stdio: 'ignore', detached: false },
    )
    expect(preview.getWhisperPreviewCapability()).toMatchObject({
      requested: 'turbo',
      requestedTier: 'max',
      effectiveTier: 'max',
      effectiveModel: 'large-v3-turbo',
      committedModel: 'large-v3',
      backend: 'whisper-preview-server',
      previewDegraded: false,
      promptPolicy: 'none',
    })
    await expect(preview.transcribeWhisperPreview(Buffer.alloc(3200, 1))).resolves.toEqual({
      text: 'Turbo provisional preview', model: 'large-v3-turbo', backend: 'whisper-preview-server',
    })
    await expect(preview.transcribeWhisperMeetingPreview(Buffer.alloc(3200, 1))).resolves.toEqual({
      text: 'Turbo provisional preview', model: 'large-v3-turbo', backend: 'whisper-preview-server',
    })
    const { beginCanonicalMetal } = await import('./whisper-metal-gate.js')
    const releaseCanonical = beginCanonicalMetal('test_commit')
    await expect(preview.transcribeWhisperPreview(Buffer.alloc(3200, 1))).resolves.toEqual({
      text: '', model: 'large-v3-turbo', backend: 'whisper-preview-server',
    })
    await expect(preview.transcribeWhisperMeetingPreview(Buffer.alloc(3200, 1))).resolves.toBeNull()
    releaseCanonical()
    expect(transcribeLocal).not.toHaveBeenCalled()
  })

  it('reuses the primary Turbo worker when preview and commit select the same model', async () => {
    process.env.COS_WHISPER_PREVIEW_MODEL = 'turbo'
    const spawn = vi.fn()
    vi.doMock('node:child_process', () => ({ spawn, execFile: vi.fn() }))
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: () => true,
    }))
    const transcribeLocal = vi.fn().mockResolvedValue({ text: 'Primary Turbo preview', backend: 'server' })
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (text: string) => text,
      WHISPER_TURBO_MODEL_PATH: `${process.env.HOME}/.local/share/whisper-models/ggml-large-v3-turbo.bin`,
      getWhisperCommitCapability: () => ({
        requestedTier: 'balanced', effectiveTier: 'balanced',
        requestedModel: 'turbo', effectiveModel: 'large-v3-turbo',
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
      requested: 'turbo', effectiveModel: 'large-v3-turbo',
      committedModel: 'large-v3-turbo', backend: 'whisper-server',
      previewDegraded: false,
    })
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

// 6.50.2: one failed request against a LIVE Turbo sidecar used to switch the meeting preview
// off until the server restarted (34 h on 2026-09-17/18). Every test here drives the real
// module through spawn and fetch fakes and a fake clock.
describe('the meeting preview recovers from a failed request (6.50.2)', () => {
  afterEach(() => {
    delete process.env.COS_WHISPER_TRANSCRIPTION_TIER
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('node:fs')
    vi.doUnmock('node:child_process')
    vi.doUnmock('./whisper-local.js')
    vi.resetModules()
  })

  async function bootTurbo(inference: (call: number) => Promise<unknown>) {
    process.env.COS_WHISPER_TRANSCRIPTION_TIER = 'max'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_789_700_000_000)
    const children: Array<EventEmitter & { exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> }> = []
    const spawn = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() })
      child.kill.mockImplementation(() => { child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('close', null)); return true })
      children.push(child)
      return child
    })
    const execFile = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: any, out: string) => void) => cb(Object.assign(new Error('no listeners'), { code: 1 }), ''))
    vi.doMock('node:child_process', () => ({ spawn, execFile }))
    vi.doMock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), existsSync: () => true }))
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (text: string) => text,
      getWhisperCommitCapability: () => ({
        requestedTier: 'max', effectiveTier: 'max', requestedModel: 'large-v3', effectiveModel: 'large-v3',
        ready: true, configured: true, degraded: false, reason: null, promptPolicy: 'full-vocabulary',
      }),
      getWhisperHealth: () => ({ server: true }),
      transcribeLocal: vi.fn(),
    }))
    let inferenceCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true }
      inferenceCalls++
      return inference(inferenceCalls)
    }))
    const preview = await import('./whisper-preview.js')
    await preview.startWhisperPreviewServer()
    return { preview, spawn, children, calls: () => inferenceCalls }
  }
  const ok = (text: string) => ({ ok: true, json: async () => ({ text }) })
  const audio = () => Buffer.alloc(3200, 1)

  it('a timeout against a live sidecar is a cooldown, and the next request after it gets text', async () => {
    const { preview, calls, spawn } = await bootTurbo(async n => {
      if (n === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      return ok('back again')
    })
    await expect(preview.transcribeWhisperMeetingPreview(audio())).resolves.toBeNull()
    // Inside the cooldown: a quiet miss that does not even reach the sidecar.
    vi.setSystemTime(Date.now() + preview.PREVIEW_FAILURE_COOLDOWN_MS - 1)
    await expect(preview.transcribeWhisperMeetingPreview(audio())).resolves.toBeNull()
    expect(calls()).toBe(1)
    // After it: the lane is live again. Before 6.50.2 this stayed null until a restart.
    vi.setSystemTime(Date.now() + 2)
    await expect(preview.transcribeWhisperMeetingPreview(audio())).resolves.toEqual({
      text: 'back again', model: 'large-v3-turbo', backend: 'whisper-preview-server',
    })
    expect(calls()).toBe(2)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('a success resets the failure count, so scattered misses never add up to a recycle', async () => {
    const { preview, spawn, children } = await bootTurbo(async n => {
      if (n % 2 === 1) throw new Error('fetch failed')
      return ok('fine')
    })
    for (let i = 0; i < 12; i++) {
      await preview.transcribeWhisperMeetingPreview(audio())
      vi.setSystemTime(Date.now() + preview.PREVIEW_FAILURE_COOLDOWN_MS + 1)
    }
    // A recycle kills the child SYNCHRONOUSLY inside the failing request; the respawn is
    // async, so the kill is the observation that cannot race the assertion.
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('PREVIEW_RECYCLE_AFTER_FAILURES in a row recycles a live but broken sidecar, and it answers again', async () => {
    let broken = true
    const { preview, spawn, children } = await bootTurbo(async () => {
      if (broken) throw new Error('fetch failed')
      return ok('recycled')
    })
    for (let i = 0; i < preview.PREVIEW_RECYCLE_AFTER_FAILURES; i++) {
      await preview.transcribeWhisperMeetingPreview(audio())
      vi.setSystemTime(Date.now() + preview.PREVIEW_FAILURE_COOLDOWN_MS + 1)
    }
    // The recycle stops the old child and starts a new one.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(children[0].kill).toHaveBeenCalled()
    broken = false
    await vi.waitFor(async () => {
      await expect(preview.transcribeWhisperMeetingPreview(audio())).resolves.toMatchObject({ text: 'recycled' })
    })
  })

  it('a sidecar that exited is restarted from the request path, backing off, never more than once per window', async () => {
    const { preview, spawn, children } = await bootTurbo(async () => ok('restarted'))
    // It exits on its own (crash, kill): the close handler marks it gone.
    children[0].exitCode = 1
    children[0].emit('close', 1)
    await expect(preview.transcribeWhisperMeetingPreview(audio())).resolves.toBeNull()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => {
      await expect(preview.transcribeWhisperMeetingPreview(audio())).resolves.toMatchObject({ text: 'restarted' })
    })
    // A success reset the backoff. Now it dies and keeps dying with no success between.
    const kill = (i: number) => { children[i].exitCode = 1; children[i].emit('close', 1) }
    kill(1)
    for (let i = 0; i < 5; i++) await preview.transcribeWhisperMeetingPreview(audio())
    expect(spawn).toHaveBeenCalledTimes(2)
    // One base window later: restart #2, and the window doubles.
    vi.setSystemTime(Date.now() + preview.PREVIEW_RESTART_BASE_MS + 1)
    await preview.transcribeWhisperMeetingPreview(audio())
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3))
    kill(2)
    // Another base window is NOT enough any more: the model is not reloaded every minute.
    vi.setSystemTime(Date.now() + preview.PREVIEW_RESTART_BASE_MS + 1)
    await preview.transcribeWhisperMeetingPreview(audio())
    // A restart spawns asynchronously (port probe first), so a NEGATIVE needs the loop to
    // settle before it is read, or a wrongful spawn lands after the assertion.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(spawn).toHaveBeenCalledTimes(3)
    // The doubled window is.
    vi.setSystemTime(Date.now() + preview.PREVIEW_RESTART_BASE_MS)
    await preview.transcribeWhisperMeetingPreview(audio())
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4))
  })

  it('a foreign listener on the port is never re-probed from the request path', async () => {
    // The start refuses a port someone else owns (reason preview_port_busy). A restart could
    // not change that, so requests must not re-run the lsof/ps probe each time.
    process.env.COS_WHISPER_TRANSCRIPTION_TIER = 'max'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_789_700_000_000)
    vi.doMock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), existsSync: () => true }))
    const spawn = vi.fn()
    const execFile = vi.fn((file: string, _a: string[], _o: unknown, cb: (e: any, out: string) => void) => {
      cb(null, file.endsWith('lsof') ? '9876\n' : '9876 1 /usr/local/bin/unrelated-health-service --port 8177\n')
    })
    vi.doMock('node:child_process', () => ({ spawn, execFile }))
    vi.stubGlobal('fetch', vi.fn())
    vi.doMock('./whisper-local.js', () => ({
      applyCorrections: (t: string) => t,
      getWhisperCommitCapability: () => ({ requestedTier: 'max', effectiveTier: 'max', requestedModel: 'large-v3', effectiveModel: 'large-v3', ready: true, configured: true, degraded: false, reason: null, promptPolicy: 'full-vocabulary' }),
      getWhisperHealth: () => ({ server: true }),
      transcribeLocal: vi.fn(),
    }))
    const preview = await import('./whisper-preview.js')
    await preview.startWhisperPreviewServer()
    expect(preview.getWhisperPreviewCapability()).toMatchObject({ reason: 'preview_port_busy' })
    const probesAtBoot = execFile.mock.calls.length
    expect(probesAtBoot).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) {
      await expect(preview.transcribeWhisperMeetingPreview(audio())).resolves.toBeNull()
      vi.setSystemTime(Date.now() + preview.PREVIEW_RESTART_MAX_MS + 1)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(execFile.mock.calls.length).toBe(probesAtBoot)
    expect(spawn).not.toHaveBeenCalled()
  })
})
