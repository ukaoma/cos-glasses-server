import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
const nativeFetch = globalThis.fetch

beforeAll(async () => {
  process.env.COS_TTS_ENGINE = 'local_first'
  const { ttsRouter } = await import('./tts.js')
  const app = express()
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'A local preparation failure must wait for live playback.',
        engine: 'local',
      }),
    })

    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(synthesizeLocalTts).toHaveBeenCalledTimes(1))
    expect(transport.mock.calls.every(([input]) => String(input).startsWith(base))).toBe(true)
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
      headers: { 'Content-Type': 'application/json' },
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
