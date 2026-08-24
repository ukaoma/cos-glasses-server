import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SESSION_IDLE_MS, SESSION_MAX_LIFETIME_MS, initialGraceMs } from '../lib/tts-cache.js'
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

  // THE SECURITY PROPERTY, restated for the grace window and NOT weakened.
  //
  // An unread capability used to die SESSION_IDLE_MS after it was minted. That
  // is why playback stopped at segment 5 of 9 on 2026-08-23: every segment is
  // minted at /prepare, but the client cannot touch segment 5 until segment 4
  // starts playing, 147s later. The session was already deleted, and the 404
  // reached iOS as NotSupportedError.
  //
  // An unread capability now lives for a grace window DERIVED from how long the
  // whole reply takes to speak at the slowest voice and slowest rate. What must
  // not change is that it still expires on its own, without anyone reading it,
  // and that once read it falls back to the tight idle window. Both are pinned.
  // A REALISTIC multi-segment reply, not a 30-character prompt.
  //
  // The short string gave this suite ~6 seconds of discriminating power and
  // never exercised a reply long enough to need a grace at all. Worse, once
  // SESSION_IDLE_MS was re-derived from the slow voice, a 30-char reply's grace
  // became SMALLER than the idle window, so the test asserted a distinction that
  // no longer existed. The grace only means something for a reply whose playback
  // outlasts the idle window.
  const SPOKEN = Array.from(
    { length: 150 },
    (_, i) => `Sentence ${i} of a long spoken reply about nothing in particular.`,
  ).join(' ')

  it('keeps an unread capability alive until its turn could plausibly come', async () => {
    const startedAt = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    synthesizeLocalTts.mockResolvedValue(Buffer.from('ID3-expiring-audio'))
    try {
      const prepared = await fetch(`${base}/api/tts/prepare`, {
        method: 'POST', headers: AUTH_JSON_HEADERS,
        body: JSON.stringify({ text: SPOKEN, engine: 'local' }),
      })
      expect(prepared.status).toBe(200)
      const { url } = await prepared.json() as { url: string }

      // Past the idle window, where the old flat deadline would have 404'd.
      // Assert the premise first: a reply this long must have a grace that
      // actually exceeds the window, or the test proves nothing.
      expect(initialGraceMs(SPOKEN.length), 'this reply needs a grace to test')
        .toBeGreaterThan(SESSION_IDLE_MS)
      now.mockReturnValue(startedAt + SESSION_IDLE_MS + 1)
      expect((await fetch(`${base}${url}`)).status, 'this 404 was the bug').toBe(200)
    } finally {
      now.mockRestore()
    }
  })

  it('still expires an unread capability, on the derived grace', async () => {
    const startedAt = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    synthesizeLocalTts.mockResolvedValue(Buffer.from('ID3-expiring-audio'))
    try {
      const prepared = await fetch(`${base}/api/tts/prepare`, {
        method: 'POST', headers: AUTH_JSON_HEADERS,
        body: JSON.stringify({ text: SPOKEN, engine: 'local' }),
      })
      const { url } = await prepared.json() as { url: string }

      // Two assertions, because the first one alone is self-referential: it
      // computes its boundary from the same helper it is testing, so ANY value
      // -- including 24 hours -- would pass it. The second bounds the grace
      // against something the helper does not control.
      now.mockReturnValue(startedAt + initialGraceMs(SPOKEN.length) + 1)
      expect((await fetch(`${base}${url}`)).status, 'an unused capability must die').toBe(404)

      // A 30-character prompt is seconds of speech. Its capability must not be
      // valid for anywhere near an hour, whatever the derivation says.
      // Bounded against something initialGraceMs does not control: the ceiling.
      expect(
        initialGraceMs(SPOKEN.length),
        'a capability must never be minted beyond the absolute ceiling',
      ).toBeLessThanOrEqual(SESSION_MAX_LIFETIME_MS)
    } finally {
      now.mockRestore()
    }
  })

  // REWRITTEN. This asserted that one read collapses the capability to the idle
  // window -- which was the defect: the client's warm reads a segment one whole
  // segment before it plays it, so collapsing on that read revoked the grace and
  // lost the segment. The SECURITY property is unchanged and restated below:
  // reading must not EXTEND a capability's life. It may only decline to shorten
  // it.
  it('reading a capability does not extend its life', async () => {
    const startedAt = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    synthesizeLocalTts.mockResolvedValue(Buffer.from('ID3-expiring-audio'))
    try {
      const prepared = await fetch(`${base}/api/tts/prepare`, {
        method: 'POST', headers: AUTH_JSON_HEADERS,
        body: JSON.stringify({ text: SPOKEN, engine: 'local' }),
      })
      const { url } = await prepared.json() as { url: string }

      const grace = initialGraceMs(SPOKEN.length)

      // Read it repeatedly across its whole life. None of these may buy it a
      // single millisecond beyond the grace it was minted with.
      for (let t = 1_000; t < grace - 1_000; t += 30_000) {
        now.mockReturnValue(startedAt + t)
        expect((await fetch(`${base}${url}`)).status).toBe(200)
      }

      // Past the original grace, plus an idle window. A capability that could be
      // held open by polling would still answer here.
      now.mockReturnValue(startedAt + grace + SESSION_IDLE_MS + 1)
      expect(
        (await fetch(`${base}${url}`)).status,
        'polling must not hold a bearer capability open',
      ).toBe(404)
    } finally {
      now.mockRestore()
    }
  })

  it('keeps every non-playback TTS route authenticated', async () => {
    const response = await fetch(`${base}/api/tts/voices`)
    expect(response.status).toBe(401)
  })

  // The cap is PER BACKEND, and nothing else in the suite covered it -- a mutation
  // putting the OpenAI limit back on the local path passed every existing test.
  //
  // The bug: 4000 is OpenAI's input limit, and it was applied up front, before the
  // engine was chosen. Kokoro has no such limit, so local speech was cut off at
  // ~3-4 pages by a rule belonging to an API it was not using. Long replies just
  // stopped mid-thought.
  //
  // Structural, because exercising the local generator needs a live sidecar. It
  // still fails on the mutation that matters, which a shared cap would not.
  it('caps per backend: OpenAI at its API limit, local far above it', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./tts.ts', import.meta.url).pathname, 'utf8')
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')

    // No cap before the backend is known: that is where the defect lived.
    expect(code).not.toMatch(/const capped = trimToCap\(/)

    // The local generator uses the local bound, and never the OpenAI one.
    const localStart = code.indexOf('async function generateLocalIntoCache')
    expect(localStart).toBeGreaterThan(-1)
    const localBody = code.slice(localStart, code.indexOf('async function', localStart + 10))
    expect(localBody).toContain('trimToCap(text, MAX_LOCAL_TTS_CHARS)')
    expect(localBody).not.toContain('MAX_OPENAI_TTS_CHARS')

    // Both OpenAI entry points: the cached generator and the streaming sibling.
    // Capping only one of them truncates silently through the other.
    expect(code.match(/trimToCap\([^,]+, MAX_OPENAI_TTS_CHARS\)/g) ?? []).toHaveLength(2)
  })

  // The shape the client depends on. A long reply must come back as MANY
  // segments, not the prefix/tail pair whose race iOS lost by under a second.
  it('returns every segment, and keeps url/tailUrl for older clients', async () => {
    const long = 'The quick brown fox jumps over the lazy dog. '.repeat(160)  // ~7k chars
    const res = await fetch(`${base}/api/tts/prepare`, {
      method: 'POST',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({ text: long, fast: true, engine: 'local' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(Array.isArray(body.urls)).toBe(true)
    // ~7k chars at 250 + 900-char chunks is around 8 segments. The point is that
    // it is well past two -- two is what failed.
    expect(body.urls.length).toBeGreaterThan(4)
    expect(body.chunks).toBe(body.urls.length)
    for (const u of body.urls) expect(u).toMatch(/^\/api\/tts\/play\/[0-9a-f-]{36}$/)
    // Every segment is a DISTINCT session; a repeated uuid would replay one chunk.
    expect(new Set(body.urls).size).toBe(body.urls.length)

    // Backward compatibility: a client older than 6.8.428 reads these two and
    // plays a degraded-but-not-silent two segments.
    expect(body.url).toBe(body.urls[0])
    expect(body.tailUrl).toBe(body.urls[1])
  })

  it('returns a single segment for a short reply, still with urls', async () => {
    const res = await fetch(`${base}/api/tts/prepare`, {
      method: 'POST',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({ text: 'Hi.', fast: true, engine: 'local' }),
    })
    const body = await res.json()
    expect(body.urls).toHaveLength(1)
    expect(body.url).toBe(body.urls[0])
    expect(body.tailUrl).toBeUndefined()
  })

  it('offers both English accents, and every id it offers is one the server accepts', async () => {
    const { KOKORO_VOICE_OPTIONS, KOKORO_EN_GB_VOICE_OPTIONS, isKokoroVoiceId } =
      await import('../lib/tts-engine.js')
    const local = [
      ...KOKORO_VOICE_OPTIONS.map(v => ({ ...v, accent: 'en-US' })),
      ...KOKORO_EN_GB_VOICE_OPTIONS.map(v => ({ ...v, accent: 'en-GB' })),
    ]
    expect(local).toHaveLength(28)
    expect(local.filter(v => v.accent === 'en-GB')).toHaveLength(8)
    // American stays first so `local[0]` is still the historical default.
    expect(local[0].id).toBe('am_echo')
    // THE CONTRACT: never offer a voice the route would refuse.
    for (const v of local) expect(isKokoroVoiceId(v.id), v.id).toBe(true)
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
