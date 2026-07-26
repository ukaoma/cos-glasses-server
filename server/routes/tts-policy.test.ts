import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireApiToken } from '../lib/api-auth.js'

const synthesizeLocalTts = vi.fn()
const isLocalTtsReady = vi.fn(() => true)
const recordOpenAITtsUsage = vi.fn()

vi.mock('../lib/tts-local.js', () => ({
  isLocalTtsReady,
  synthesizeLocalTts,
  recordLocalTtsFallbackToOpenAI: vi.fn(),
}))

vi.mock('../lib/openai-key.js', () => ({
  getOpenAIKey: () => 'test-openai-key',
  tryGetOpenAIKey: () => 'test-openai-key',
}))

vi.mock('../lib/openai-tts-budget.js', () => ({
  assertOpenAITtsBudget: () => undefined,
  recordOpenAITtsUsage,
  OpenAITtsBudgetExhaustedError: class extends Error {},
  getOpenAITtsBudgetState: () => ({ usdToday: 0, capUsd: 5 }),
}))

vi.mock('../lib/display-bus.js', () => ({ emitDisplay: vi.fn() }))

let server: Server
let base = ''
let cacheDir = ''
const nativeFetch = globalThis.fetch
const TOKEN = 'test-tts-token'
const AUTH_JSON_HEADERS = {
  'Content-Type': 'application/json',
  'x-cos-token': TOKEN,
}

beforeAll(async () => {
  process.env.COS_TTS_ENGINE = 'local_first'
  cacheDir = mkdtempSync(join(tmpdir(), 'cos-tts-policy-'))
  process.env.TTS_DISK_CACHE_DIR = cacheDir
  process.env.TTS_DISK_CACHE_MAX_AGE_DAYS = '0'
  const { ttsRouter } = await import('./tts.js')
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use(express.json())
  app.use('/api', ttsRouter)
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  delete process.env.COS_TTS_ENGINE
  delete process.env.TTS_DISK_CACHE_DIR
  delete process.env.TTS_DISK_CACHE_MAX_AGE_DAYS
  rmSync(cacheDir, { recursive: true, force: true })
})

beforeEach(() => {
  synthesizeLocalTts.mockReset()
  recordOpenAITtsUsage.mockReset()
  isLocalTtsReady.mockReturnValue(true)
  vi.unstubAllGlobals()
})

describe('TTS preparation authority', () => {
  it('does not start OpenAI until the live playback request owns cancellation', async () => {
    const transport = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(base)) return nativeFetch(input, init)
      throw new Error(`unexpected detached network request: ${url}`)
    })
    vi.stubGlobal('fetch', transport)

    const response = await fetch(`${base}/api/tts/prepare`, {
      method: 'POST',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({
        text: 'A cloud request must remain lazy until playback.',
        engine: 'openai',
      }),
    })

    expect(response.status).toBe(200)
    expect((await response.json() as { url?: string }).url).toMatch(/^\/api\/tts\/play\//)
    expect(transport.mock.calls.every(([input]) => String(input).startsWith(base))).toBe(true)
    expect(synthesizeLocalTts).not.toHaveBeenCalled()
  })

  it('warms Kokoro locally but never starts a cloud fallback in the background', async () => {
    synthesizeLocalTts.mockRejectedValueOnce(new Error('local canary failure'))
    const transport = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(base)) return nativeFetch(input, init)
      throw new Error(`unexpected detached network request: ${url}`)
    })
    vi.stubGlobal('fetch', transport)

    const response = await fetch(`${base}/api/tts/prepare`, {
      method: 'POST',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({
        text: 'A local preparation failure must wait for live playback.',
        engine: 'local',
      }),
    })

    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(synthesizeLocalTts).toHaveBeenCalledTimes(1))
    expect(transport.mock.calls.every(([input]) => String(input).startsWith(base))).toBe(true)
  })

  it('protects prepare but lets a native player fetch its short-lived URL without headers', async () => {
    const audio = Buffer.from('ID3-kokoro-test-audio')
    synthesizeLocalTts.mockResolvedValue(audio)

    const unauthenticatedPrepare = await fetch(`${base}/api/tts/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'This request must stay protected.', engine: 'local' }),
    })
    expect(unauthenticatedPrepare.status).toBe(401)

    const prepared = await fetch(`${base}/api/tts/prepare`, {
      method: 'POST',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({ text: 'Play this Kokoro response natively.', engine: 'local' }),
    })
    expect(prepared.status).toBe(200)
    const { url } = await prepared.json() as { url: string }
    expect(url).toMatch(/^\/api\/tts\/play\/[0-9a-f-]{36}$/i)

    const playback = await fetch(`${base}${url}`)
    expect(playback.status).toBe(200)
    expect(playback.headers.get('content-type')).toBe('audio/mpeg')
    expect(Buffer.from(await playback.arrayBuffer())).toEqual(audio)

    const refill = await fetch(`${base}${url}`, { headers: { Range: 'bytes=0-2' } })
    expect(refill.status).toBe(206)
    expect(refill.headers.get('content-range')).toBe(`bytes 0-2/${audio.length}`)
    expect(Buffer.from(await refill.arrayBuffer())).toEqual(audio.subarray(0, 3))
  })

  it('returns 404 for an unknown but well-formed playback capability', async () => {
    const response = await fetch(`${base}/api/tts/play/00000000-0000-4000-8000-000000000000`)
    expect(response.status).toBe(404)
  })

  it('expires the bearer capability after its 60-second playback window', async () => {
    const startedAt = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    synthesizeLocalTts.mockResolvedValue(Buffer.from('ID3-expiring-audio'))
    try {
      const prepared = await fetch(`${base}/api/tts/prepare`, {
        method: 'POST',
        headers: AUTH_JSON_HEADERS,
        body: JSON.stringify({ text: 'Expire this prepared audio URL.', engine: 'local' }),
      })
      expect(prepared.status).toBe(200)
      const { url } = await prepared.json() as { url: string }

      now.mockReturnValue(startedAt + 60_001)
      expect((await fetch(`${base}${url}`)).status).toBe(404)
    } finally {
      now.mockRestore()
    }
  })

  it('keeps every non-playback TTS route authenticated', async () => {
    const response = await fetch(`${base}/api/tts/voices`)
    expect(response.status).toBe(401)
  })
})

describe('legacy streaming contract', () => {
  it('forwards OpenAI audio chunks without buffering the complete body', async () => {
    const encoder = new TextEncoder()
    const transport = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(base)) return nativeFetch(input, init)
      if (url === 'https://api.openai.com/v1/audio/speech') {
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('first-'))
            controller.enqueue(encoder.encode('second'))
            controller.close()
          },
        }), { status: 200 }))
      }
      throw new Error(`unexpected network request: ${url}`)
    })
    vi.stubGlobal('fetch', transport)

    const response = await fetch(`${base}/api/tts/stream`, {
      method: 'POST',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({
        text: 'Stream this response.',
        engine: 'openai',
        format: 'mp3',
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('transfer-encoding')).toBe('chunked')
    expect(await response.text()).toBe('first-second')
    expect(recordOpenAITtsUsage).toHaveBeenCalledTimes(1)
  })
})
