import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let draftDir = ''
let server: Server | null = null
let baseUrl = ''
let transcribeAudioBuffer: ReturnType<typeof vi.fn>

class MockNoSpeechDetectedError extends Error { readonly rawText = '' }
class MockBudgetError extends Error { readonly spentTodayUsd = 5; readonly capUsd = 5 }
class MockUnavailableError extends Error {
  readonly status = 503
  constructor(readonly reason = 'local_asr_unavailable') { super('local audio preserved') }
}

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/transcribe-audio.js', () => {
    transcribeAudioBuffer = vi.fn()
    return {
      transcribeAudioBuffer,
      resolveTranscribeMode: (raw: unknown) => String(raw ?? '').toLowerCase() === 'fast' ? 'fast' : 'hq',
      NoSpeechDetectedError: MockNoSpeechDetectedError,
      OpenAIWhisperBudgetExhaustedError: MockBudgetError,
      TranscriptionUnavailableError: MockUnavailableError,
    }
  })
  vi.doMock('../lib/whisper-local.js', () => ({ applyCorrections: (text: string) => text }))
  vi.doMock('../lib/dictation-clean.js', () => ({
    AUTOCLEAN_MAX_CHARS: 8000,
    autoCleanDictation: async (text: string) => text,
  }))
  const { promptDraftsRouter } = await import('./prompt-drafts.js')
  const app = express()
  app.use('/api', promptDraftsRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (!address || typeof address === 'string') throw new Error('server address unavailable')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
}

function httpRequest(method: string, path: string, body?: Buffer | string): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body)
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: payload ? { 'Content-Length': String(payload.length), 'Content-Type': 'application/octet-stream' } : {},
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    if (payload) req.end(payload); else req.end()
  })
}

describe('public prompt draft recovery contract', () => {
  beforeEach(async () => {
    draftDir = mkdtempSync(join(tmpdir(), 'cos-public-prompt-drafts-'))
    process.env.COS_PROMPT_DRAFT_DIR = draftDir
    process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE = join(draftDir, 'autoclean-count.json')
    await startServer()
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
    server = null
    vi.resetModules()
    vi.doUnmock('../lib/transcribe-audio.js')
    vi.doUnmock('../lib/whisper-local.js')
    vi.doUnmock('../lib/dictation-clean.js')
    delete process.env.COS_PROMPT_DRAFT_DIR
    delete process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE
    if (draftDir) rmSync(draftDir, { recursive: true, force: true })
  })

  it('acknowledges durable audio, warms locally, and finalizes independently', async () => {
    transcribeAudioBuffer
      .mockResolvedValueOnce({ text: 'warm text', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200 })
      .mockResolvedValueOnce({ text: 'final recovered text', backend: 'hq-local-test', mode: 'hq', requestedMode: 'hq', actualQuality: 'hq', degraded: false, elapsedMs: 80, audioBytes: 3200 })

    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const uploaded = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 1))
    expect(uploaded.status).toBe(200)
    expect(uploaded.json).toMatchObject({ acked: true, transcriptPending: true, receivedChunkIndexes: [0] })

    const finalized = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize`)
    expect(finalized.status).toBe(200)
    expect(finalized.json).toMatchObject({ text: 'final recovered text', recovered: true, chunkCount: 1, missingChunks: [] })
    expect(transcribeAudioBuffer).toHaveBeenCalledWith(expect.any(Buffer), { mode: 'fast', policy: 'local-only' })
    expect(transcribeAudioBuffer).toHaveBeenCalledWith(expect.any(Buffer), { mode: 'hq', policy: 'automatic' })
  })

  it('keeps acknowledged audio retryable when every transcription backend is unavailable', async () => {
    transcribeAudioBuffer.mockRejectedValue(new MockUnavailableError())
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    const uploaded = await httpRequest('POST', `/api/prompt-drafts/${draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 1))
    expect(uploaded.status).toBe(200)

    const finalized = await httpRequest('POST', `/api/prompt-drafts/${draftId}/finalize`)
    expect(finalized.status).toBe(503)
    expect(finalized.json).toMatchObject({ reason: 'local_asr_unavailable', retryable: true, draftPreserved: true })

    const recovered = await httpRequest('GET', `/api/prompt-drafts/${draftId}`)
    expect(recovered.status).toBe(200)
    expect(recovered.json.receivedChunkIndexes).toEqual([0])
  })
})
