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
let transcribeWhisperPreview: ReturnType<typeof vi.fn>
let emitDisplay: ReturnType<typeof vi.fn>

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
  vi.doMock('../lib/whisper-local.js', () => ({
    applyCorrections: (text: string) => text,
    getHighQualityTranscriptionCapability: () => ({
      hqAvailable: true,
      model: 'large-v3',
      backend: 'whisper-cli',
      reason: null,
    }),
  }))
  vi.doMock('../lib/whisper-preview.js', () => {
    transcribeWhisperPreview = vi.fn()
    return { transcribeWhisperPreview }
  })
  vi.doMock('../lib/dictation-clean.js', () => ({
    AUTOCLEAN_MAX_CHARS: 8000,
    autoCleanDictation: async (text: string) => text,
  }))
  vi.doMock('../lib/display-bus.js', () => {
    emitDisplay = vi.fn((event) => event)
    return { emitDisplay }
  })
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
    delete process.env.COS_HQ_SPECULATIVE_WARM
    await startServer()
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
    server = null
    vi.resetModules()
    vi.doUnmock('../lib/transcribe-audio.js')
    vi.doUnmock('../lib/whisper-local.js')
    vi.doUnmock('../lib/whisper-preview.js')
    vi.doUnmock('../lib/dictation-clean.js')
    vi.doUnmock('../lib/display-bus.js')
    delete process.env.COS_PROMPT_DRAFT_DIR
    delete process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE
    delete process.env.COS_HQ_SPECULATIVE_WARM
    if (draftDir) rmSync(draftDir, { recursive: true, force: true })
  })

  it('acknowledges durable audio, speculative HQ-warms, and finalizes from HQ cache', async () => {
    transcribeAudioBuffer.mockImplementation(async (_buf: Buffer, opts?: { mode?: string; policy?: string }) => {
      if (opts?.mode === 'hq') {
        return {
          text: 'hq polished text', backend: 'hq-large-v3', mode: 'hq', requestedMode: 'hq',
          actualQuality: 'hq', degraded: false, elapsedMs: 80, audioBytes: 3200,
        }
      }
      return {
        text: 'warm text', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast',
        actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
      }
    })

    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const uploaded = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 1))
    expect(uploaded.status).toBe(200)
    expect(uploaded.json).toMatchObject({ acked: true, transcriptPending: true, receivedChunkIndexes: [0] })
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId: started.json.draftId, chunkIndex: 0, text: 'warm text' },
    }))
    await vi.waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      { mode: 'hq', policy: 'local-only' },
    ))

    const beforeFinalize = transcribeAudioBuffer.mock.calls.length
    const finalized = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize`)
    expect(finalized.status).toBe(200)
    expect(finalized.json).toMatchObject({ text: 'hq polished text', recovered: true, chunkCount: 1, missingChunks: [] })
    // Finalize reused HQ warm cache — no extra automatic decode.
    expect(transcribeAudioBuffer.mock.calls.length).toBe(beforeFinalize)
    expect(transcribeAudioBuffer).toHaveBeenCalledWith(expect.any(Buffer), { mode: 'fast', policy: 'local-only' })
    expect(transcribeAudioBuffer).not.toHaveBeenCalledWith(expect.any(Buffer), { mode: 'hq', policy: 'automatic' })
    // HQ text never painted to HUD
    expect(emitDisplay).not.toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId: started.json.draftId, chunkIndex: 0, text: 'hq polished text' },
    })
  })

  it('does not speculative-HQ-warm when mode=fast', async () => {
    transcribeAudioBuffer.mockResolvedValue({
      text: 'fast only', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast',
      actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
    })

    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 50))
    expect(transcribeAudioBuffer).toHaveBeenCalledWith(expect.any(Buffer), { mode: 'fast', policy: 'local-only' })
    expect(transcribeAudioBuffer).not.toHaveBeenCalledWith(expect.any(Buffer), { mode: 'hq', policy: 'local-only' })
  })

  it('retries finalize when HQ warm degraded but large-v3 is still available', async () => {
    let hqCalls = 0
    transcribeAudioBuffer.mockImplementation(async (_buf: Buffer, opts?: { mode?: string; policy?: string }) => {
      if (opts?.mode === 'hq') {
        hqCalls += 1
        // Warm (local-only) degrades; finalize (automatic) still cannot get HQ —
        // but we must not silently reuse the warm turbo without retrying.
        return {
          text: 'turbo fallback', backend: 'fast-cli-turbo', mode: 'hq', requestedMode: 'hq',
          actualQuality: 'fast', degraded: true, degradationReason: 'hq_decode_failed',
          elapsedMs: 35, audioBytes: 3200,
        }
      }
      return {
        text: 'warm text', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast',
        actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
      }
    })

    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    await httpRequest('POST', `/api/prompt-drafts/${draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 1))
    await vi.waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      { mode: 'hq', policy: 'local-only' },
    ))
    const finalized = await httpRequest('POST', `/api/prompt-drafts/${draftId}/finalize`)

    expect(finalized.status).toBe(200)
    expect(finalized.json).toMatchObject({
      text: 'turbo fallback',
      requestedMode: 'hq',
      actualQuality: 'fast',
      degraded: true,
      backend: 'fast-cli-turbo',
    })
    expect(hqCalls).toBeGreaterThanOrEqual(2)
    expect(transcribeAudioBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      { mode: 'hq', policy: 'automatic' },
    )
  })

  it('keeps HQ warm text when a late Fast warm finishes after HQ', async () => {
    let resolveFast!: (value: any) => void
    const fastPromise = new Promise(resolve => { resolveFast = resolve })
    transcribeAudioBuffer.mockImplementation(async (_buf: Buffer, opts?: { mode?: string }) => {
      if (opts?.mode === 'hq') {
        return {
          text: 'hq polished text', backend: 'hq-large-v3', mode: 'hq', requestedMode: 'hq',
          actualQuality: 'hq', degraded: false, elapsedMs: 80, audioBytes: 3200,
        }
      }
      return fastPromise
    })

    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    await httpRequest('POST', `/api/prompt-drafts/${draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 1))
    await vi.waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      { mode: 'hq', policy: 'local-only' },
    ))

    // Late Fast warm resolves after HQ is already cached.
    resolveFast({
      text: 'turbo live preview', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast',
      actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
    })
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalled())

    const beforeFinalize = transcribeAudioBuffer.mock.calls.length
    const finalized = await httpRequest('POST', `/api/prompt-drafts/${draftId}/finalize`)
    expect(finalized.status).toBe(200)
    expect(finalized.json).toMatchObject({
      text: 'hq polished text',
      requestedMode: 'hq',
      actualQuality: 'hq',
      degraded: false,
    })
    expect(transcribeAudioBuffer.mock.calls.length).toBe(beforeFinalize)
  })

  it('awaits in-flight HQ warm on finalize instead of double-decoding', async () => {
    let resolveHq!: (value: any) => void
    const hqPromise = new Promise(resolve => { resolveHq = resolve })
    transcribeAudioBuffer.mockImplementation(async (_buf: Buffer, opts?: { mode?: string }) => {
      if (opts?.mode === 'hq') return hqPromise
      return {
        text: 'warm text', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast',
        actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
      }
    })

    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    await httpRequest('POST', `/api/prompt-drafts/${draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 1))
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalled())
    await vi.waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      { mode: 'hq', policy: 'local-only' },
    ))

    const finalizePromise = httpRequest('POST', `/api/prompt-drafts/${draftId}/finalize`)
    // Let finalize reach the in-flight await
    await new Promise(r => setTimeout(r, 30))
    const callsWhileWaiting = transcribeAudioBuffer.mock.calls.length
    resolveHq({
      text: 'hq from warm', backend: 'hq-large-v3', mode: 'hq', requestedMode: 'hq',
      actualQuality: 'hq', degraded: false, elapsedMs: 90, audioBytes: 3200,
    })
    const finalized = await finalizePromise
    expect(finalized.status).toBe(200)
    expect(finalized.json.text).toBe('hq from warm')
    // No second HQ decode with automatic while warm was in flight
    expect(transcribeAudioBuffer.mock.calls.length).toBe(callsWhileWaiting)
    expect(transcribeAudioBuffer).not.toHaveBeenCalledWith(expect.any(Buffer), { mode: 'hq', policy: 'automatic' })
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

  it('never publishes stale warm text after a chunk index is replaced', async () => {
    // Isolate Fast-warm race without speculative HQ competing for mock order.
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
    server = null
    process.env.COS_HQ_SPECULATIVE_WARM = '0'
    await startServer()

    let resolveFirst!: (value: any) => void
    transcribeAudioBuffer
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({
        text: 'replacement words', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
      })

    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    const first = await httpRequest('POST', `/api/prompt-drafts/${draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 1))
    const replacement = await httpRequest('POST', `/api/prompt-drafts/${draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 2))
    expect(first.status).toBe(200)
    expect(replacement.status).toBe(200)

    resolveFirst({
      text: 'stale words', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
    })

    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId, chunkIndex: 0, text: 'replacement words' },
    }))
    expect(emitDisplay).not.toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId, chunkIndex: 0, text: 'stale words' },
    })
  })

  it('peek emits provisional text without advancing the recovery ledger', async () => {
    transcribeWhisperPreview.mockResolvedValue({
      text: 'peek words', backend: 'whisper-preview-server', model: 'small.en',
    })
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    const peek = await httpRequest(
      'POST',
      `/api/prompt-drafts/${draftId}/peek?chunkIndex=0&peekGen=1`,
      Buffer.alloc(1600, 3),
    )
    expect(peek.status).toBe(200)
    expect(peek.json).toMatchObject({ draftId, chunkIndex: 0, peekGen: 1, accepted: true })

    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId, chunkIndex: 0, text: 'peek words', provisional: true, peekGen: 1 },
    }))
    expect(transcribeWhisperPreview).toHaveBeenCalledWith(expect.any(Buffer))
    expect(transcribeAudioBuffer).not.toHaveBeenCalled()

    const meta = await httpRequest('GET', `/api/prompt-drafts/${draftId}`)
    expect(meta.json.receivedChunkIndexes ?? []).toEqual([])
    expect(meta.json.warmTranscripts ?? {}).toEqual({})
  })

  it('peek drop-while-busy returns 204 when a peek is already in flight', async () => {
    let resolvePeek!: (value: any) => void
    transcribeWhisperPreview.mockReturnValueOnce(new Promise(resolve => { resolvePeek = resolve }))
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    const first = httpRequest(
      'POST',
      `/api/prompt-drafts/${draftId}/peek?chunkIndex=0&peekGen=1`,
      Buffer.alloc(800, 1),
    )
    await new Promise(r => setTimeout(r, 20))
    const busy = await httpRequest(
      'POST',
      `/api/prompt-drafts/${draftId}/peek?chunkIndex=0&peekGen=2`,
      Buffer.alloc(800, 2),
    )
    expect(busy.status).toBe(204)
    resolvePeek({ text: 'first peek', backend: 'whisper-preview-server', model: 'small.en' })
    expect((await first).status).toBe(200)
  })
})
