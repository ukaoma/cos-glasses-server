import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TTS_BUDGET_FILE = resolve(__dirname, '..', 'data', 'openai-tts-budget.json')
const AUDIO_BYTES = Buffer.from('fake-mp3-audio-body')

let cacheDir: string
let server: Server | null = null
let baseUrl = ''

function purgeBudgetFile(): void {
  try { rmSync(TTS_BUDGET_FILE) } catch {}
  try { rmSync(`${TTS_BUDGET_FILE}.tmp`) } catch {}
}

function mockOpenAITts(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== 'https://api.openai.com/v1/audio/speech') {
      throw new Error(`unexpected fetch: ${url}`)
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(AUDIO_BYTES))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    })
  }))
}

async function startTestServer(): Promise<void> {
  const { ttsRouter } = await import('./tts.js')
  const app = express()
  app.use(express.json())
  app.use('/api', ttsRouter)
  await new Promise<void>((resolveStart) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (!address || typeof address === 'string') throw new Error('server address unavailable')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolveStart()
    })
  })
}

function httpRequest(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body))
  return new Promise((resolveRequest, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolveRequest({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('tts route playback contract', () => {
  beforeEach(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'cos-tts-route-test-'))
    process.env.TTS_DISK_CACHE_DIR = cacheDir
    process.env.TTS_DISK_CACHE_MAX_AGE_DAYS = '0'
    process.env.OPENAI_API_KEY = 'sk-test'
    purgeBudgetFile()
    mockOpenAITts()
    vi.resetModules()
    await startTestServer()
  })

  afterEach(async () => {
    await new Promise<void>((resolveClose) => {
      if (!server) return resolveClose()
      server.close(() => resolveClose())
    })
    server = null
    baseUrl = ''
    vi.unstubAllGlobals()
    vi.resetModules()
    delete process.env.TTS_DISK_CACHE_DIR
    delete process.env.TTS_DISK_CACHE_MAX_AGE_DAYS
    delete process.env.OPENAI_API_KEY
    purgeBudgetFile()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('prepares text to speech and serves playable audio with range support', async () => {
    const prepared = await httpRequest('POST', '/api/tts/prepare', {
      body: { text: 'Hello, this is COS speaking.', voice: 'echo' },
    })
    expect(prepared.status).toBe(200)
    const { url } = JSON.parse(prepared.body.toString()) as { url: string }
    expect(url).toMatch(/^\/api\/tts\/play\//)

    const full = await httpRequest('GET', url)
    expect(full.status).toBe(200)
    expect(full.headers['content-type']).toBe('audio/mpeg')
    expect(full.body.equals(AUDIO_BYTES)).toBe(true)

    const ranged = await httpRequest('GET', url, { headers: { Range: 'bytes=0-3' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe(`bytes 0-3/${AUDIO_BYTES.length}`)
    expect(ranged.body.equals(AUDIO_BYTES.subarray(0, 4))).toBe(true)
  })
})
