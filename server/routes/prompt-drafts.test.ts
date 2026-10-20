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
let autoCleanDictation: ReturnType<typeof vi.fn>
let prewarm: {
  start: ReturnType<typeof vi.fn>; take: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn>
}
class MockPrewarmUnavailableError extends Error {}
const WARM_TOKEN = '11111111-2222-3333-4444-555555555555'
const POLISH_ENV = ['COS_DICTATION_AUTOCLEAN_MAX_PER_DAY', 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE',
  'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING', 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_PROMPT_DRAFT', 'COS_DICTATION_FILLER_PASS', 'COS_DICTATION_AUTOCLEAN',
  'COS_DICTATION_PREWARM', 'COS_DICTATION_POLISH_SKIP_CLEAN']

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
  vi.doMock('../lib/dictation-prewarm.js', () => {
    prewarm = {
      start: vi.fn(() => ({ token: WARM_TOKEN, expiresMs: 150000 })),
      take: vi.fn((token: string, model: string) => token === WARM_TOKEN ? { token, model } : null),
      run: vi.fn(async (_entry: unknown, text: string) => `${text} Warm.`),
      discard: vi.fn((token: string) => token === WARM_TOKEN),
    }
    return {
      startPolishPrewarm: prewarm.start, takePolishPrewarm: prewarm.take, runWarmPolish: prewarm.run,
      discardPolishPrewarm: prewarm.discard, PrewarmUnavailableError: MockPrewarmUnavailableError,
      prewarmEnabled: () => !['0', 'false', 'off'].includes((process.env.COS_DICTATION_PREWARM ?? '').toLowerCase()),
      isPrewarmModel: (model: string) => model === 'haiku' || model === 'sonnet',
    }
  })
  vi.doMock('../lib/display-bus.js', () => {
    emitDisplay = vi.fn((event) => event)
    return { emitDisplay }
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
    vi.doUnmock('../lib/dictation-prewarm.js')
    delete process.env.COS_PROMPT_DRAFT_DIR
    delete process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE
    delete process.env.COS_HQ_SPECULATIVE_WARM
    for (const key of POLISH_ENV) delete process.env[key]
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
      expect.objectContaining({ mode: 'hq', policy: 'local-only' }),
    ))

    const beforeFinalize = transcribeAudioBuffer.mock.calls.length
    const finalized = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize`)
    expect(finalized.status).toBe(200)
    expect(finalized.json).toMatchObject({ text: 'hq polished text', recovered: true, chunkCount: 1, missingChunks: [] })
    // Finalize reused HQ warm cache — no extra automatic decode.
    expect(transcribeAudioBuffer.mock.calls.length).toBe(beforeFinalize)
    expect(transcribeAudioBuffer).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ mode: 'fast', policy: 'local-only' }))
    expect(transcribeAudioBuffer).not.toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ mode: 'hq', policy: 'automatic' }))
    // HQ text never painted to HUD
    expect(emitDisplay).not.toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId: started.json.draftId, chunkIndex: 0, text: 'hq polished text' },
    })
  })

  it('finalizes phone-local Message and Meeting text through the existing polish engine', async () => {
    autoCleanDictation.mockImplementation(async (text: string, _vocabulary: unknown, opts: { model?: string }) => {
      return `${text.replace('Silus', 'Silas')} [${opts.model}]`
    })

    const message = await httpRequest('POST', '/api/dictation/finalize', JSON.stringify({
      text: 'Ask Silus about the plan',
      surface: 'message',
      autocleanModel: 'haiku',
    }))
    const meeting = await httpRequest('POST', '/api/dictation/finalize', JSON.stringify({
      text: 'The forecast is ready',
      surface: 'meeting',
      autocleanModel: 'sonnet',
    }))

    expect(message.status).toBe(200)
    expect(message.json).toEqual({
      text: 'Ask Silas about the plan [haiku]',
      surface: 'message',
      polished: true,
    })
    expect(meeting.status).toBe(200)
    expect(meeting.json).toEqual({
      text: 'The forecast is ready [sonnet]',
      surface: 'meeting',
      polished: true,
    })
    expect(autoCleanDictation).toHaveBeenCalledTimes(2)
  })

  it('routes Luna explicitly, defaults to Haiku, and rejects unknown text models', async () => {
    for (const model of ['luna-5.6-fast', undefined]) {
      const result = await httpRequest('POST', '/api/dictation/finalize', JSON.stringify({
        text: 'Keep this draft.', surface: 'message', autocleanModel: model,
      }))
      expect(result.status).toBe(200)
      expect(autoCleanDictation).toHaveBeenLastCalledWith('Keep this draft.', expect.any(Array), expect.objectContaining({ model: model ?? 'haiku' }))
    }
    const invalid = await httpRequest('POST', '/api/dictation/finalize', JSON.stringify({
      text: 'Keep this draft.', surface: 'meeting', autocleanModel: 'unknown',
    }))
    expect(invalid.status).toBe(400)
    expect(autoCleanDictation).toHaveBeenCalledTimes(2)
  })

  it('preserves text after Luna failures and keeps Sonnet available independently', async () => {
    autoCleanDictation.mockImplementation(async (text: string, _terms: unknown, opts: { model: string }) => {
      if (opts.model === 'luna-5.6-fast') throw new Error('Cursor unavailable')
      return text + ' Polished.'
    })
    for (let i = 0; i < 10; i++) {
      const result = await httpRequest('POST', '/api/dictation/finalize', JSON.stringify({
        text: 'Keep this draft.', surface: 'message', autocleanModel: 'luna-5.6-fast',
      }))
      expect(result.json.text).toBe('Keep this draft.')
    }
    const result = await httpRequest('POST', '/api/dictation/finalize', JSON.stringify({
      text: 'Keep this draft.', surface: 'meeting', autocleanModel: 'sonnet',
    }))
    expect(result.json.text).toBe('Keep this draft. Polished.')
  })

  it.each(['finalize', 'retry'])('passes Luna to audio-draft %s without changing transcription', async (action) => {
    transcribeAudioBuffer.mockResolvedValue({ text: 'Keep this draft.', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', elapsedMs: 20, audioBytes: 3200 })
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalled())
    const result = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/${action}?mode=fast&autoclean=1&autocleanModel=luna-5.6-fast`)
    expect(result.status).toBe(200)
    expect(autoCleanDictation).toHaveBeenCalledWith('Keep this draft.', expect.any(Array), expect.objectContaining({ model: 'luna-5.6-fast' }))
  })

  it('rejects invalid or oversized phone-local finalizer payloads', async () => {
    const invalidSurface = await httpRequest('POST', '/api/dictation/finalize', JSON.stringify({
      text: 'hello',
      surface: 'other',
    }))
    const oversized = await httpRequest('POST', '/api/dictation/finalize', JSON.stringify({
      text: 'x'.repeat(8001),
      surface: 'message',
    }))

    expect(invalidSurface.status).toBe(400)
    expect(invalidSurface.json.error).toBe('invalid_surface')
    expect(oversized.status).toBe(413)
    expect(oversized.json).toMatchObject({ error: 'text_too_large', maxChars: 8000 })
    expect(autoCleanDictation).not.toHaveBeenCalled()
  })

  // 6.79.1. Synthetic text only.
  const finalizeText = (text: string, surface: 'message' | 'meeting', autocleanModel = 'sonnet') =>
    httpRequest('POST', '/api/dictation/finalize', JSON.stringify({ text, surface, autocleanModel }))

  it('6.79.1: meeting lines spend their own daily budget, never Mac dictation\'s', async () => {
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING = '2'
    autoCleanDictation.mockImplementation(async (text: string) => `${text} Polished.`)
    const meeting = []
    for (let i = 0; i < 3; i++) meeting.push(await finalizeText('The forecast is ready', 'meeting'))
    expect(meeting.map(r => r.json.polishSkipped)).toEqual([undefined, undefined, 'daily_cap'])
    expect(meeting[2].json).toEqual({ text: 'The forecast is ready', surface: 'meeting', polished: false, polishSkipped: 'daily_cap' })
    const message = await finalizeText('Ask Dana about the plan', 'message')
    expect(message.json).toEqual({ text: 'Ask Dana about the plan Polished.', surface: 'message', polished: true })
    expect(autoCleanDictation).toHaveBeenCalledTimes(3)
  })

  it('6.79.1: the pre-6.79.1 cap still sets the message budget; the per-bucket variable wins', async () => {
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY = '1'
    autoCleanDictation.mockImplementation(async (text: string) => `${text} Polished.`)
    expect((await finalizeText('First note', 'message')).json.polishSkipped).toBeUndefined()
    expect((await finalizeText('Second note', 'message')).json).toEqual({
      text: 'Second note', surface: 'message', polished: false, polishSkipped: 'daily_cap',
    })
    // The legacy variable is the message fallback only: meeting keeps its own default.
    expect((await finalizeText('Meeting line', 'meeting')).json.polishSkipped).toBeUndefined()
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = '3'
    expect((await finalizeText('Third note', 'message')).json.polishSkipped).toBeUndefined()
    expect(autoCleanDictation).toHaveBeenCalledTimes(3)
  })

  it('6.79.1: prompt drafts spend their own budget', async () => {
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_PROMPT_DRAFT = '1'
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = '1'
    autoCleanDictation.mockImplementation(async (text: string) => `${text} Polished.`)
    transcribeAudioBuffer.mockResolvedValue({ text: 'Keep this draft.', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', elapsedMs: 20, audioBytes: 3200 })
    const drafts = []
    for (let i = 0; i < 2; i++) {
      const started = await httpRequest('POST', '/api/prompt-drafts/start')
      await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
      drafts.push(await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize?mode=fast&autoclean=1&autocleanModel=haiku`))
    }
    expect(drafts[0].json.text).toBe('Keep this draft. Polished.')
    expect(drafts[0].json.polishSkipped).toBeUndefined()
    expect(drafts[1].json).toMatchObject({ text: 'Keep this draft.', polishSkipped: 'daily_cap' })
    expect((await finalizeText('Ask Dana', 'message')).json.polishSkipped).toBeUndefined()
  })

  it('6.79.1: says why the model did not polish: disabled, breaker open, failed', async () => {
    transcribeAudioBuffer.mockResolvedValue({ text: 'Keep this draft.', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', elapsedMs: 20, audioBytes: 3200 })
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
    const disabled = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize?mode=fast`)
    expect(disabled.json).toMatchObject({ text: 'Keep this draft.', polishSkipped: 'disabled' })

    autoCleanDictation.mockImplementation(async () => { throw new Error('provider down') })
    const failed = await finalizeText('Keep this draft.', 'message', 'luna-5.6-fast')
    expect(failed.json).toEqual({ text: 'Keep this draft.', surface: 'message', polished: false, polishSkipped: 'failed' })
    let skipped: string | undefined
    for (let i = 0; i < 10 && skipped !== 'breaker_open'; i++) skipped = (await finalizeText('Keep this draft.', 'message', 'luna-5.6-fast')).json.polishSkipped
    expect(skipped).toBe('breaker_open')
    const calls = autoCleanDictation.mock.calls.length
    expect((await finalizeText('Keep this draft.', 'message', 'luna-5.6-fast')).json.polishSkipped).toBe('breaker_open')
    expect(autoCleanDictation).toHaveBeenCalledTimes(calls)
  })

  it('6.79.1: prompt drafts over the polish size say too_long', async () => {
    const long = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' ')
    transcribeAudioBuffer.mockResolvedValue({ text: long, backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', elapsedMs: 20, audioBytes: 3200 })
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
    const result = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize?mode=fast&autoclean=1`)
    expect(result.json.polishSkipped).toBe('too_long')
    expect(autoCleanDictation).not.toHaveBeenCalled()
  })

  it('6.79.1: strips um and uh from messages and prompt drafts before the model, and when it is skipped; never from meetings', async () => {
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = '1'
    const message = await finalizeText('Um, ask Dana about, uh, the plan', 'message')
    expect(autoCleanDictation).toHaveBeenLastCalledWith('Ask Dana about, the plan', expect.any(Array), expect.anything())
    expect(message.json.text).toBe('Ask Dana about, the plan')
    // Budget spent: the model is skipped, the fillers still go.
    const capped = await finalizeText('So, um, we ship Friday', 'message')
    expect(capped.json).toEqual({ text: 'So, we ship Friday', surface: 'message', polished: true, polishSkipped: 'daily_cap' })
    // A meeting line reaches the model exactly as heard.
    await finalizeText('Um, the forecast, uh, is ready', 'meeting')
    expect(autoCleanDictation).toHaveBeenLastCalledWith('Um, the forecast, uh, is ready', expect.any(Array), expect.anything())
    // Prompt drafts with autoclean off still lose their fillers.
    transcribeAudioBuffer.mockResolvedValue({ text: 'Uh, send the deck to Chris.', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', elapsedMs: 20, audioBytes: 3200 })
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
    const draft = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize?mode=fast`)
    expect(draft.json).toMatchObject({ text: 'Send the deck to Chris.', polishSkipped: 'disabled' })
  })

  it('6.79.1: COS_DICTATION_FILLER_PASS=0 sends the text to the model as heard', async () => {
    process.env.COS_DICTATION_FILLER_PASS = '0'
    await finalizeText('Um, ask Dana', 'message')
    expect(autoCleanDictation).toHaveBeenLastCalledWith('Um, ask Dana', expect.any(Array), expect.anything())
  })

  // 6.79.2. Synthetic text only.
  const finalizeWarm = (body: Record<string, unknown>) =>
    httpRequest('POST', '/api/dictation/finalize', JSON.stringify({ surface: 'message', autocleanModel: 'haiku', ...body }))

  it('6.79.2: prewarm answers a token; finalize with it uses the warm process, once, on its own budget', async () => {
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = '1'
    const warm = await httpRequest('POST', '/api/dictation/polish/prewarm', JSON.stringify({ model: 'haiku' }))
    expect(warm.json).toEqual({ token: WARM_TOKEN, expiresMs: 150000 })
    expect(prewarm.start).toHaveBeenCalledWith('haiku')
    const used = await finalizeWarm({ text: 'Send the deck to Dana', prewarmToken: WARM_TOKEN })
    expect(used.json).toEqual({ text: 'Send the deck to Dana Warm.', surface: 'message', polished: true, prewarm: 'used' })
    expect(prewarm.take).toHaveBeenCalledWith(WARM_TOKEN, 'haiku')
    expect(prewarm.run).toHaveBeenCalledWith({ token: WARM_TOKEN, model: 'haiku' }, 'Send the deck to Dana', expect.any(Array), expect.anything())
    expect(autoCleanDictation).not.toHaveBeenCalled()
    expect(prewarm.discard).not.toHaveBeenCalled()
    // The warm call spent the message budget like a cold one.
    expect((await finalizeWarm({ text: 'Second note' })).json.polishSkipped).toBe('daily_cap')
  })

  it('6.79.2: a dead warm process falls back to one cold call; a failure after sending does not', async () => {
    prewarm.run.mockRejectedValueOnce(new MockPrewarmUnavailableError('gone'))
    const missed = await finalizeWarm({ text: 'Send the deck', prewarmToken: WARM_TOKEN })
    expect(missed.json).toEqual({ text: 'Send the deck', surface: 'message', polished: false, prewarm: 'missed' })
    expect(autoCleanDictation).toHaveBeenCalledTimes(1)

    prewarm.run.mockRejectedValueOnce(new Error('Warm polish returned an unsuccessful result'))
    const failed = await finalizeWarm({ text: 'Send the deck', prewarmToken: WARM_TOKEN })
    expect(failed.json).toMatchObject({ polishSkipped: 'failed', prewarm: 'missed' })
    expect(autoCleanDictation).toHaveBeenCalledTimes(1)

    // An unknown token (expired, evicted, another model) is a plain cold call.
    const unknown = await finalizeWarm({ text: 'Send the deck', prewarmToken: '99999999-2222-3333-4444-555555555555' })
    expect(unknown.json).toMatchObject({ prewarm: 'missed' })
    expect(autoCleanDictation).toHaveBeenCalledTimes(2)
  })

  it('6.79.2: when the model is not called, the warm process is discarded', async () => {
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = '1'
    await finalizeWarm({ text: 'First note' })
    const capped = await finalizeWarm({ text: 'Second note', prewarmToken: WARM_TOKEN })
    expect(capped.json).toMatchObject({ polishSkipped: 'daily_cap', prewarm: 'discarded' })
    expect(prewarm.discard).toHaveBeenCalledWith(WARM_TOKEN)
    expect(prewarm.take).not.toHaveBeenCalled()
  })

  it('6.79.2: no prewarm field without a token; a malformed token is 400', async () => {
    expect(await finalizeWarm({ text: 'Plain' })).toMatchObject({ json: { text: 'Plain', surface: 'message', polished: false } })
    expect((await finalizeWarm({ text: 'Plain' })).json.prewarm).toBeUndefined()
    for (const bad of ['../../etc', 42, 'x'.repeat(36)]) {
      const result = await finalizeWarm({ text: 'Plain', prewarmToken: bad })
      expect(result.status, String(bad)).toBe(400)
      expect(result.json.error).toBe('invalid_prewarm_token')
    }
  })

  it('6.79.2: prewarm refuses when it could not be used, and never spawns then', async () => {
    const ask = (body: object) => httpRequest('POST', '/api/dictation/polish/prewarm', JSON.stringify(body))
    expect((await ask({ model: 'luna-5.6-fast' })).json).toEqual({ error: 'prewarm_unavailable', reason: 'model' })
    expect((await ask({ model: 'typo' })).status).toBe(400)
    expect((await ask({ model: 'haiku', surface: 'other' })).status).toBe(400)
    process.env.COS_DICTATION_PREWARM = '0'
    expect((await ask({ model: 'haiku' })).json).toEqual({ error: 'prewarm_unavailable', reason: 'disabled' })
    delete process.env.COS_DICTATION_PREWARM
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING = '1'
    await finalizeText('A meeting line', 'meeting')
    expect((await ask({ model: 'haiku', surface: 'meeting' })).json).toEqual({ error: 'prewarm_unavailable', reason: 'daily_cap' })
    autoCleanDictation.mockImplementation(async () => { throw new Error('down') })
    for (let i = 0; i < 10; i++) await finalizeText('Note', 'message', 'sonnet')
    expect((await ask({ model: 'sonnet' })).json).toEqual({ error: 'prewarm_unavailable', reason: 'breaker_open' })
    expect(prewarm.start).not.toHaveBeenCalled()
    prewarm.start.mockImplementationOnce(() => { throw new Error('no cli') })
    expect((await ask({})).json).toEqual({ error: 'prewarm_unavailable', reason: 'cli' })
    expect(prewarm.start).toHaveBeenCalledWith('haiku')
  })

  it('6.79.2: DELETE discards a warm process', async () => {
    expect((await httpRequest('DELETE', `/api/dictation/polish/prewarm/${WARM_TOKEN}`)).json).toEqual({ discarded: true })
    expect((await httpRequest('DELETE', '/api/dictation/polish/prewarm/unknown')).json).toEqual({ discarded: false })
  })

  it('6.79.2: COS_DICTATION_POLISH_SKIP_CLEAN=1 sends clean text without the model; default calls it', async () => {
    const clean = 'Send the deck to Dana before lunch.'
    expect((await finalizeText(clean, 'message')).json.polishSkipped).toBeUndefined()
    expect(autoCleanDictation).toHaveBeenCalledTimes(1)
    process.env.COS_DICTATION_POLISH_SKIP_CLEAN = '1'
    expect((await finalizeText(clean, 'message')).json).toEqual({ text: clean, surface: 'message', polished: false, polishSkipped: 'clean' })
    // The filler pass runs first: what it removed counts as a change.
    expect((await finalizeText('Um, send the deck to Dana.', 'message')).json).toEqual({
      text: 'Send the deck to Dana.', surface: 'message', polished: true, polishSkipped: 'clean',
    })
    expect(autoCleanDictation).toHaveBeenCalledTimes(1)
    // Anything the model is needed for still reaches it.
    await finalizeText('Order five, actually six cases.', 'message')
    expect(autoCleanDictation).toHaveBeenCalledTimes(2)
  })

  it('6.45.4: drops an invented closing sentence from the committed chunk and keeps the prompt', async () => {
    transcribeAudioBuffer.mockImplementation(async () => ({
      text: 'Send the deck to Chris. I am going to go to the bathroom.',
      words: [
        { word: 'Send', start: 0.0, end: 0.2, probability: 0.9 }, { word: 'the', start: 0.3, end: 0.4, probability: 0.9 },
        { word: 'deck', start: 0.5, end: 0.7, probability: 0.9 }, { word: 'to', start: 0.9, end: 1.0, probability: 0.9 },
        { word: 'Chris', start: 1.1, end: 1.4, probability: 0.8 }, { word: '.', start: 1.5, end: 1.6, probability: 0.9 },
        { word: 'I', start: 4.5, end: 4.6, probability: 0.3 }, { word: 'am', start: 4.6, end: 4.7, probability: 0.2 },
        { word: 'going', start: 4.8, end: 4.9, probability: 0.2 }, { word: 'to', start: 5.0, end: 5.1, probability: 0.2 },
        { word: 'go', start: 5.1, end: 5.2, probability: 0.2 }, { word: 'to', start: 5.2, end: 5.3, probability: 0.2 },
        { word: 'the', start: 5.3, end: 5.4, probability: 0.2 }, { word: 'bath', start: 5.4, end: 5.5, probability: 0.2 },
        { word: 'room', start: 5.5, end: 5.6, probability: 0.2 }, { word: '.', start: 5.6, end: 5.7, probability: 0.2 },
      ],
      backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
    }))
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId: started.json.draftId, chunkIndex: 0, text: 'Send the deck to Chris.' },
    }))
    const finalized = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize?mode=fast`)
    expect(finalized.status).toBe(200)
    expect(finalized.json.text).toBe('Send the deck to Chris.')
  })

  it('6.45.4: a chunk that is only a filler is refused as no speech, and a real prompt with the same words is kept', async () => {
    // Keyed on the audio's length: the route may re-wrap the bytes it hands
    // the decoder, so the first byte is not a reliable tag. Chunk 0 is short.
    transcribeAudioBuffer.mockImplementation(async (buf: Buffer) => ({
      text: buf.length < 4800 ? 'Thanks for watching.' : 'Summarize the Bottle POS notes and put the risks up front.',
      backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', degraded: false, elapsedMs: 20, audioBytes: 3200,
    }))
    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 7))
    await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=1&mode=fast`, Buffer.alloc(6400, 8))
    await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalledWith({
      type: 'prompt_transcript',
      data: { draftId: started.json.draftId, chunkIndex: 1, text: 'Summarize the Bottle POS notes and put the risks up front.' },
    }))
    const finalized = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize?mode=fast`)
    expect(finalized.status).toBe(200)
    expect(finalized.json.text).toBe('Summarize the Bottle POS notes and put the risks up front.')
    expect(emitDisplay).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ text: 'Thanks for watching.' }) }))
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
    expect(transcribeAudioBuffer).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ mode: 'fast', policy: 'local-only' }))
    expect(transcribeAudioBuffer).not.toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ mode: 'hq', policy: 'local-only' }))
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
      expect.objectContaining({ mode: 'hq', policy: 'local-only' }),
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
      expect.objectContaining({ mode: 'hq', policy: 'automatic' }),
    )
  })

  it('retains Fast text when Large-v3 emits a caption-credit hallucination', async () => {
    transcribeAudioBuffer.mockImplementation(async (_buf: Buffer, opts?: { mode?: string }) => {
      if (opts?.mode === 'hq') {
        throw new MockNoSpeechDetectedError('CLOSED CAPTIONING PROVIDED BY AEVERINE ZINN DIGITAL MEDIA GROUP')
      }
      return {
        text: 'Likelihood of Grok releasing their model', backend: 'fast-local-test',
        mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', degraded: false,
        elapsedMs: 20, audioBytes: 3200,
      }
    })

    const started = await httpRequest('POST', '/api/prompt-drafts/start')
    const draftId = started.json.draftId
    await httpRequest('POST', `/api/prompt-drafts/${draftId}/chunks?chunkIndex=0`, Buffer.alloc(3200, 1))
    await vi.waitFor(() => expect(transcribeAudioBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ mode: 'hq', policy: 'local-only' }),
    ))

    const finalized = await httpRequest('POST', `/api/prompt-drafts/${draftId}/finalize`)

    expect(finalized.status).toBe(200)
    expect(finalized.json).toMatchObject({
      text: 'Likelihood of Grok releasing their model',
      requestedMode: 'hq',
      actualQuality: 'fast',
      degraded: true,
      degradationReason: 'hq_caption_credit_hallucination',
    })
    expect(finalized.json.text).not.toMatch(/caption(?:ing|s)?\s+provided\s+by/i)
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
      expect.objectContaining({ mode: 'hq', policy: 'local-only' }),
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
      expect.objectContaining({ mode: 'hq', policy: 'local-only' }),
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
    expect(transcribeAudioBuffer).not.toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ mode: 'hq', policy: 'automatic' }))
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
      data: { draftId, chunkIndex: 0, text: 'peek words', provisional: true, peekGen: 1, engine: 'whisper' },
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
