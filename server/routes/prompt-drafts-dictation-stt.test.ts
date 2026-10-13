import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let draftDir = ''
type Plan = { slot: string; engine: 'whisper' | 'parakeet-ultra'; reason: string | null; frontEnd: string; key: string }
const whisperPlans = (): Record<string, Plan> => ({
  preview: { slot: 'preview', engine: 'whisper', reason: null, frontEnd: 'highpass', key: 'preview:turbo' },
  fast: { slot: 'fast', engine: 'whisper', reason: null, frontEnd: 'highpass', key: 'fast:turbo' },
  final: { slot: 'final', engine: 'whisper', reason: null, frontEnd: 'highpass', key: 'final:large-v3' },
})
let plans: Record<string, Plan> = whisperPlans()
let server: Server | null = null
let baseUrl = ''
let transcribeAudioBuffer: ReturnType<typeof vi.fn>
let transcribeWhisperPreview: ReturnType<typeof vi.fn>
let emitDisplay: ReturnType<typeof vi.fn>
let autoCleanDictation: ReturnType<typeof vi.fn>
let currentDictationPlan: ReturnType<typeof vi.fn>
let runParakeetDictation: ReturnType<typeof vi.fn>

class MockNoSpeechDetectedError extends Error {
  constructor(readonly rawText = '') { super('No speech detected') }
}
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
    autoCleanDictation: (autoCleanDictation = vi.fn(async (text: string) => text)),
  }))
  vi.doMock('../lib/display-bus.js', () => {
    emitDisplay = vi.fn((event) => event)
    return { emitDisplay }
  })
  vi.doMock('../lib/dictation-stt.js', () => {
    currentDictationPlan = vi.fn((slot: string) => plans[slot])
    runParakeetDictation = vi.fn(async () => ({ ok: true, text: 'parakeet peek words' }))
    return { currentDictationPlan, runParakeetDictation }
  })
  const { promptDraftsRouter } = await import('./prompt-drafts.js')
  const app = express()
  app.use(express.json({ limit: '20kb' }))
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
      headers: payload ? {
        'Content-Length': String(payload.length),
        'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream',
      } : {},
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


const fastResult = (text: string, extra: Record<string, unknown> = {}) => ({
  text, backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', degraded: false,
  elapsedMs: 20, audioBytes: 3200, engine: 'whisper', dictationKey: 'fast:turbo', ...extra,
})

describe('prompt drafts follow the STT settings (6.73.0)', () => {
  beforeEach(async () => {
    draftDir = mkdtempSync(join(tmpdir(), 'cos-dict-prompt-drafts-'))
    process.env.COS_PROMPT_DRAFT_DIR = draftDir
    process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE = join(draftDir, 'autoclean-count.json')
    process.env.COS_HQ_SPECULATIVE_WARM = '0'
    plans = whisperPlans()
    await startServer()
  })
  afterEach(async () => {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
    server = null
    vi.resetModules()
    for (const m of ['../lib/transcribe-audio.js', '../lib/whisper-local.js', '../lib/whisper-preview.js', '../lib/dictation-clean.js', '../lib/display-bus.js', '../lib/dictation-stt.js']) vi.doUnmock(m)
    delete process.env.COS_PROMPT_DRAFT_DIR
    delete process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE
    delete process.env.COS_HQ_SPECULATIVE_WARM
    if (draftDir) rmSync(draftDir, { recursive: true, force: true })
  })

  async function draftWithWarmChunk(): Promise<string> {
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    await httpRequest('POST', `/api/prompt-drafts/${draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalled())
    return draftId
  }

  it('Fast finalize reuses the warm decode made under the same Preview selection', async () => {
    transcribeAudioBuffer.mockResolvedValue(fastResult('warm words'))
    const draftId = await draftWithWarmChunk()
    expect(transcribeAudioBuffer).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ mode: 'fast', dictationPlan: plans.fast }))
    const calls = transcribeAudioBuffer.mock.calls.length
    const finalized = await httpRequest('POST', `/api/prompt-drafts/${draftId}/finalize?mode=fast&autoclean=0`)
    expect(finalized.json).toMatchObject({ text: 'warm words', engine: 'whisper' })
    expect(transcribeAudioBuffer.mock.calls.length).toBe(calls)
  })

  it('a Preview change between warm and finalize decodes again under the new selection, once', async () => {
    transcribeAudioBuffer.mockResolvedValueOnce(fastResult('turbo words'))
    const draftId = await draftWithWarmChunk()
    plans.fast = { slot: 'fast', engine: 'parakeet-ultra', reason: null, frontEnd: 'highpass', key: 'fast:parakeet' }
    transcribeAudioBuffer.mockResolvedValueOnce(fastResult('parakeet words', { backend: 'parakeet-ultra', engine: 'parakeet-ultra', dictationKey: 'fast:parakeet' }))
    const finalized = await httpRequest('POST', `/api/prompt-drafts/${draftId}/finalize?mode=fast&autoclean=0`)
    expect(finalized.json).toMatchObject({ text: 'parakeet words', engine: 'parakeet-ultra', backend: 'parakeet-ultra', actualQuality: 'fast' })
    expect(transcribeAudioBuffer).toHaveBeenLastCalledWith(expect.any(Buffer), expect.objectContaining({ mode: 'fast', policy: 'automatic', dictationPlan: plans.fast }))
    // The snapshot is taken once per finalize, not per chunk.
    expect(currentDictationPlan.mock.calls.filter(c => c[0] === 'fast').length).toBe(2)
  })

  it('a pre-6.73 record (no sttKey) is reused only under the 6.72.0 default selection', async () => {
    const { isReusableTranscript, recordSttKey } = await import('./prompt-drafts.js')
    const legacy = { text: 'old', hash: 'h', requestedMode: 'fast' as const, actualQuality: 'fast' as const, backend: 'fast-local-server', degraded: false }
    expect(recordSttKey(legacy)).toBe('fast:turbo')
    expect(isReusableTranscript(legacy, 'h', 'fast', 'fast:turbo')).toBe(true)
    expect(isReusableTranscript(legacy, 'h', 'fast', 'fast:parakeet')).toBe(false)
    const hq = { ...legacy, requestedMode: 'hq' as const, actualQuality: 'hq' as const }
    expect(isReusableTranscript(hq, 'h', 'hq', 'final:large-v3')).toBe(true)
    expect(isReusableTranscript(hq, 'h', 'hq', 'final:parakeet-ultra')).toBe(false)
    expect(isReusableTranscript({ ...hq, sttKey: 'final:parakeet-ultra' }, 'h', 'hq', 'final:parakeet-ultra')).toBe(true)
  })

  it('the live preview runs Parakeet when the Preview model is Parakeet, and says so on the event', async () => {
    plans.preview = { slot: 'preview', engine: 'parakeet-ultra', reason: null, frontEnd: 'highpass', key: 'preview:parakeet' }
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    const peek = await httpRequest('POST', `/api/prompt-drafts/${draftId}/peek?chunkIndex=0&peekGen=1`, Buffer.alloc(1600, 3))
    expect(peek.status).toBe(200)
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId, chunkIndex: 0, text: 'parakeet peek words', provisional: true, peekGen: 1, engine: 'parakeet-ultra' },
    }))
    expect(runParakeetDictation).toHaveBeenCalledWith(expect.any(Buffer), plans.preview, 'preview')
    expect(transcribeWhisperPreview).not.toHaveBeenCalled()
  })

  it('a Parakeet preview miss is the 6.72.0 Whisper peek, never a blank', async () => {
    plans.preview = { slot: 'preview', engine: 'parakeet-ultra', reason: null, frontEnd: 'highpass', key: 'preview:parakeet' }
    runParakeetDictation.mockResolvedValueOnce({ ok: false, reason: 'parakeet_busy' })
    transcribeWhisperPreview.mockResolvedValue({ text: 'whisper peek words', backend: 'whisper-preview-server', model: 'large-v3-turbo' })
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    await httpRequest('POST', `/api/prompt-drafts/${draftId}/peek?chunkIndex=0&peekGen=1`, Buffer.alloc(1600, 3))
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId, chunkIndex: 0, text: 'whisper peek words', provisional: true, peekGen: 1, engine: 'whisper' },
    }))
  })

  it('a Whisper preview selection never calls Parakeet', async () => {
    transcribeWhisperPreview.mockResolvedValue({ text: 'whisper peek words', backend: 'whisper-preview-server', model: 'large-v3-turbo' })
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/peek?chunkIndex=0&peekGen=1`, Buffer.alloc(1600, 3))
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalled())
    expect(runParakeetDictation).not.toHaveBeenCalled()
  })
})
