import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { refreshLocalTtsHealth, synthesizeLocalTts } from './tts-local.js'

describe('local TTS cancellation safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves a caller abort so the route cannot fall through to OpenAI', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal
      if (signal?.aborted) throw signal.reason
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))

    const controller = new AbortController()
    controller.abort()

    await expect(synthesizeLocalTts({
      text: 'cancel me',
      voice: 'am_echo',
      format: 'mp3',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails closed for an unowned AbortError instead of calling it a timeout', async () => {
    const abortError = new Error('fetch aborted')
    abortError.name = 'AbortError'
    vi.stubGlobal('fetch', vi.fn(async () => { throw abortError }))

    await expect(synthesizeLocalTts({
      text: 'abort safely',
      voice: 'am_echo',
      format: 'mp3',
    })).rejects.toBe(abortError)
  })
})

describe('local TTS sidecar identity', () => {
  it('requires the COS protocol and a boot-scoped bearer token for liveness', async () => {
    const healthFetch = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/)
      return new Response(JSON.stringify({
        ready: true,
        protocol: 'cos-tts-v1',
        engine: 'kokoro',
        voice: 'am_echo',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', healthFetch)

    await refreshLocalTtsHealth()

    expect(healthFetch).toHaveBeenCalledTimes(1)
  })

  it('validates an inherited venv and schedules bounded startup recovery', () => {
    const source = readFileSync(new URL('./tts-local.ts', import.meta.url), 'utf8')
    expect(source).toContain('assert (sys.version_info.major, sys.version_info.minor) in ((3, 11), (3, 12))')
    expect(source).toContain('import fastapi, mlx_audio, misaki, numpy, soundfile, uvicorn')
    expect(source).toContain('scheduleLocalTtsRetry()')
    expect(source).toContain('Math.min(300_000')
  })
})
