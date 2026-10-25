import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// 6.91.0: this file writes the learned-style, instructions and options stores. A private data dir
// (under the run's isolated one) keeps a file running in another worker from reading them.
const SHARED_DATA_DIR = vi.hoisted(() => {
  const shared = process.env.COS_DATA_DIR
  process.env.COS_DATA_DIR = `${shared ?? '/tmp'}/private-${process.pid}-${Math.random().toString(36).slice(2)}`
  return shared
})
afterAll(() => { if (SHARED_DATA_DIR === undefined) delete process.env.COS_DATA_DIR; else process.env.COS_DATA_DIR = SHARED_DATA_DIR })

let draftDir = ''
let server: Server | null = null
let baseUrl = ''
let transcribeAudioBuffer: ReturnType<typeof vi.fn>
let transcribeWhisperPreview: ReturnType<typeof vi.fn>
let emitDisplay: ReturnType<typeof vi.fn>
let autoCleanDictation: ReturnType<typeof vi.fn>
let logTokenAudit: ReturnType<typeof vi.fn>
let prewarm: {
  start: ReturnType<typeof vi.fn>; take: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn>
}
class MockPrewarmUnavailableError extends Error {}
const WARM_TOKEN = '11111111-2222-3333-4444-555555555555'
const POLISH_ENV = ['COS_DICTATION_AUTOCLEAN_MAX_PER_DAY', 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE',
  'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MEETING', 'COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_PROMPT_DRAFT', 'COS_DICTATION_FILLER_PASS', 'COS_DICTATION_AUTOCLEAN',
  'COS_DICTATION_PREWARM', 'COS_DICTATION_POLISH_SKIP_CLEAN', 'COS_DICTATION_MEANING_GUARD', 'COS_DICTATION_LEARNED_STYLE',
  'COS_DICTATION_REGISTERS', 'COS_DICTATION_POLISH_PROMPT', 'COS_DICTATION_PROMPT_VERSION']

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
  // 6.85.0: the polish audit row, captured (and kept out of any real audit file).
  vi.doMock('../lib/token-audit.js', async (original) => ({ ...(await original<object>()), logTokenAudit: (logTokenAudit = vi.fn()) }))
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
    vi.doUnmock('../lib/token-audit.js')
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
      // 6.91.0, additive: what the model step did and which prompt ran. Haiku runs v3 (canary C1
      // passed on Sonnet only), with no register and no learned style.
      polishOutcome: 'polished',
      polishPrompt: 'v3',
      learnedStyle: false,
    })
    expect(meeting.status).toBe(200)
    expect(meeting.json).toEqual({
      text: 'The forecast is ready [sonnet]',
      surface: 'meeting',
      polished: true,
      // 6.91.0: meeting lines take v3 and no register.
      polishOutcome: 'polished',
      polishPrompt: 'v3',
      learnedStyle: false,
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
    expect(message.json).toEqual({ text: 'Ask Dana about the plan Polished.', surface: 'message', polished: true, polishOutcome: 'polished', polishRegister: 'default', polishPrompt: 'v4', learnedStyle: false })
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
    // 6.91.0: a failed model call says the register it was given, and no polishOutcome.
    expect(failed.json).toEqual({ text: 'Keep this draft.', surface: 'message', polished: false, polishSkipped: 'failed', polishPrompt: 'v3', learnedStyle: false })
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

  // 6.83.1. Synthetic text only.
  it('6.83.1: "forward slash pricing," reaches the model and the skipped path as "/pricing,"; meetings stay faithful', async () => {
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = '1'
    await finalizeText('Track demo, forward slash pricing, forward slash build and price', 'message')
    expect(autoCleanDictation).toHaveBeenLastCalledWith('Track demo, /pricing, forward slash build and price', expect.any(Array), expect.anything())
    const capped = await finalizeText('Go to forward slash pricing.', 'message')
    expect(capped.json).toEqual({ text: 'Go to /pricing.', surface: 'message', polished: true, polishSkipped: 'daily_cap' })
    await finalizeText('Go to forward slash pricing.', 'meeting')
    expect(autoCleanDictation).toHaveBeenLastCalledWith('Go to forward slash pricing.', expect.any(Array), expect.anything())
  })

  it('6.83.1: COS_DICTATION_SPOKEN_PATHS=0 leaves the words for the model', async () => {
    process.env.COS_DICTATION_SPOKEN_PATHS = '0'
    try {
      await finalizeText('Go to forward slash pricing.', 'message')
      expect(autoCleanDictation).toHaveBeenLastCalledWith('Go to forward slash pricing.', expect.any(Array), expect.anything())
    } finally { delete process.env.COS_DICTATION_SPOKEN_PATHS }
  })

  it('6.83.1: a polish that invents a link is refused and the pre-polish text goes out', async () => {
    autoCleanDictation.mockImplementation(async () => 'Check quilt.com for details.')
    const invented = await finalizeText('check our website for details', 'message')
    expect(invented.json).toEqual({
      text: 'check our website for details', surface: 'message', polished: false, polishSkipped: 'link_guard',
      // 6.91.0: the link guard is a guard like the others.
      polishOutcome: 'guarded', guard: 'link', polishRegister: 'default', polishPrompt: 'v4', learnedStyle: false,
    })
    // A link the speaker spelled out is kept.
    autoCleanDictation.mockImplementation(async () => 'Mail sam@example.com today.')
    const spelled = await finalizeText('mail sam at example dot com today', 'message')
    expect(spelled.json).toEqual({ text: 'Mail sam@example.com today.', surface: 'message', polished: true, polishOutcome: 'polished', polishRegister: 'default', polishPrompt: 'v4', learnedStyle: false })
  })

  it('6.83.1: a polish that drops a link the dictionary wrote is refused', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.COS_PROFILE_PATH!, JSON.stringify({ vocabulary: ['Quilt'], whisper_corrections: JSON.stringify({ 'forward slash pricing': '/pricing' }) }))
    const profileModule = await import('../lib/profile.js')
    profileModule.clearProfileCache()
    try {
      autoCleanDictation.mockImplementation(async () => 'Go to the pricing page.')
      const lost = await finalizeText('go to /pricing', 'message')
      expect(lost.json).toMatchObject({ text: 'go to /pricing', polished: false, polishSkipped: 'link_guard' })
      // Any case: "/Pricing" in the answer still holds the dictionary's link.
      autoCleanDictation.mockImplementation(async () => 'Go to /Pricing.')
      expect((await finalizeText('go to /pricing', 'message')).json).toMatchObject({ text: 'Go to /Pricing.', polished: true })
      // A corrected spelling from the vocabulary is not an invented link.
      autoCleanDictation.mockImplementation(async () => 'See quilt.com.')
      expect((await finalizeText('see kwilt dot com', 'message')).json).toMatchObject({ text: 'See quilt.com.', polished: true })
      // A misheard name with no dictionary spelling is still an invented link.
      autoCleanDictation.mockImplementation(async () => 'See quill.com.')
      expect((await finalizeText('see kwilt dot com', 'message')).json).toMatchObject({ polishSkipped: 'link_guard' })
      // The vocabulary handed to the model holds no path: the known spellings are vocabulary only.
      expect(autoCleanDictation).toHaveBeenCalledWith('go to /pricing', ['Quilt'], expect.anything())
      autoCleanDictation.mockImplementation(async () => 'Go to /pricing.')
      expect((await finalizeText('go to /pricing', 'message')).json).toEqual({ text: 'Go to /pricing.', surface: 'message', polished: true, polishOutcome: 'polished', polishRegister: 'default', polishPrompt: 'v4', learnedStyle: false })
    } finally {
      const { rmSync: rm } = await import('node:fs')
      rm(process.env.COS_PROFILE_PATH!, { force: true })
      profileModule.clearProfileCache()
    }
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
    expect(used.json).toEqual({ text: 'Send the deck to Dana Warm.', surface: 'message', polished: true, prewarm: 'used', polishOutcome: 'polished', polishPrompt: 'v3', learnedStyle: false })
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
    // 6.91.0: the model returned its input, which is "unchanged", not a failure.
    expect(missed.json).toEqual({ text: 'Send the deck', surface: 'message', polished: false, prewarm: 'missed', polishOutcome: 'unchanged', polishPrompt: 'v3', learnedStyle: false })
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

  // 6.85.0 "Your polish instructions". Synthetic text only.
  async function withInstructions(value: string, run: () => Promise<void>) {
    const store = await import('../lib/dictation-polish-instructions.js')
    store.writeCustomInstructions(value)
    try { await run() } finally { store.writeCustomInstructions('') }
  }

  it('6.85.0: Mac dictation and G2 messages (surface message) give the model the instructions, cold and warm', async () => {
    const { customInstructionsHash } = await import('../lib/dictation-polish-instructions.js')
    await withInstructions('Use Oxford commas.', async () => {
      autoCleanDictation.mockImplementation(async () => 'Send the deck, notes, and plan.')
      const cold = await finalizeText('send the deck notes and plan', 'message', 'haiku')
      expect(autoCleanDictation).toHaveBeenCalledWith('send the deck notes and plan', expect.any(Array), expect.objectContaining({ customInstructions: 'Use Oxford commas.' }))
      // Additive: a hash of the instructions, never their words.
      expect(cold.json).toEqual({
        text: 'Send the deck, notes, and plan.', surface: 'message', polished: true,
        customInstructions: true, instructionsHash: customInstructionsHash('Use Oxford commas.'),
        polishOutcome: 'polished', polishPrompt: 'v3', learnedStyle: false,
      })
      expect(JSON.stringify(cold.json)).not.toContain('Oxford')
      // The audit row says the instructions were sent, by hash, never their words.
      expect(logTokenAudit).toHaveBeenCalledWith(expect.objectContaining({
        caller: 'dictation_autoclean_message', polishInstructions: { on: true, hash: customInstructionsHash('Use Oxford commas.') },
      }))
      expect(JSON.stringify(logTokenAudit.mock.calls)).not.toContain('Oxford')
      const warm = await finalizeWarm({ text: 'Send the deck to Dana', prewarmToken: WARM_TOKEN })
      expect(prewarm.run).toHaveBeenCalledWith(expect.anything(), 'Send the deck to Dana', expect.any(Array), expect.objectContaining({ customInstructions: 'Use Oxford commas.' }))
      expect(warm.json).toMatchObject({ prewarm: 'used', customInstructions: true })
    })
  })

  it('6.85.0: meeting lines stay on the built-in rules alone', async () => {
    await withInstructions('Use Oxford commas.', async () => {
      const meeting = await finalizeText('The forecast is ready', 'meeting')
      expect(autoCleanDictation).toHaveBeenCalledWith('The forecast is ready', expect.any(Array), expect.objectContaining({ customInstructions: '' }))
      expect(meeting.json).toEqual({ text: 'The forecast is ready', surface: 'meeting', polished: false, polishOutcome: 'unchanged', polishPrompt: 'v3', learnedStyle: false })
    })
  })

  it('6.85.0: prompt drafts (G2 server dictation) give the model the instructions', async () => {
    await withInstructions('Write product names as Bottle POS.', async () => {
      transcribeAudioBuffer.mockResolvedValue({ text: 'Open bottle pos.', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', elapsedMs: 20, audioBytes: 3200 })
      const started = await httpRequest('POST', '/api/prompt-drafts/start')
      await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
      await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalled())
      const result = await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize?mode=fast&autoclean=1&autocleanModel=haiku`)
      expect(result.status).toBe(200)
      expect(autoCleanDictation).toHaveBeenCalledWith('Open bottle pos.', expect.any(Array), expect.objectContaining({ customInstructions: 'Write product names as Bottle POS.' }))
      expect(result.json).toMatchObject({ customInstructions: true, instructionsHash: expect.stringMatching(/^[0-9a-f]{8}$/) })
    })
  })

  it('6.85.0: with no instructions the model gets "" and every answer is unchanged', async () => {
    autoCleanDictation.mockImplementation(async (text: string) => `${text} Polished.`)
    const message = await finalizeText('Ask Dana', 'message')
    expect(autoCleanDictation).toHaveBeenCalledWith('Ask Dana', expect.any(Array), expect.objectContaining({ customInstructions: '' }))
    expect(message.json).toEqual({ text: 'Ask Dana Polished.', surface: 'message', polished: true, polishOutcome: 'polished', polishRegister: 'default', polishPrompt: 'v4', learnedStyle: false })
    expect(logTokenAudit).toHaveBeenCalledWith(expect.objectContaining({ polishInstructions: { on: false, hash: '' } }))
  })

  it('6.85.0: when the model is not called the instructions are not claimed', async () => {
    await withInstructions('Use Oxford commas.', async () => {
      process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = '1'
      await finalizeText('First', 'message')
      expect((await finalizeText('Second', 'message')).json).toEqual({ text: 'Second', surface: 'message', polished: false, polishSkipped: 'daily_cap' })
      // A failed or refused model answer still says the instructions were sent.
      delete process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE
      autoCleanDictation.mockImplementation(async () => { throw new Error('down') })
      expect((await finalizeText('Third', 'message')).json).toMatchObject({ polishSkipped: 'failed', customInstructions: true })
    })
  })

  // 6.91.0 (plan r2): registers, the meaning guard, the learned style and polishOutcome. Synthetic text only.
  const finalizeWith = (body: Record<string, unknown>) =>
    httpRequest('POST', '/api/dictation/finalize', JSON.stringify({ surface: 'message', autocleanModel: 'sonnet', ...body }))
  async function withStyle(rules: unknown[], run: () => Promise<void>, enabled = true) {
    const store = await import('../lib/dictation-learned-style.js')
    store.writeLearnedStyle(enabled, rules as any)
    try { await run() } finally { store.writeLearnedStyle(true, []) }
  }
  const HONESTLY = { id: 'drop-honestly', kind: 'drop_phrase', register: 'all', param: 'honestly', count: 2, lastSeen: null }

  it('6.91.0: with COS_DICTATION_REGISTERS=1 a terminal is literal; the model gets the register, the answer gets the input casing and no added period', async () => {
    process.env.COS_DICTATION_REGISTERS = '1'
    autoCleanDictation.mockImplementation(async () => 'Git status.')
    const result = await finalizeWith({ text: 'git status', context: { app: 'iTerm2' } })
    expect(autoCleanDictation).toHaveBeenLastCalledWith('git status', expect.any(Array), expect.objectContaining({ register: 'literal', learnedStyle: '' }))
    expect(result.json).toEqual({ text: 'git status', surface: 'message', polished: false, polishOutcome: 'unchanged', polishRegister: 'literal', polishPrompt: 'v4', learnedStyle: false })
  })

  it('6.91.0: with registers on, a terminal answer that changed a word is refused: the input goes out, guard literal, polishSkipped failed', async () => {
    process.env.COS_DICTATION_REGISTERS = '1'
    autoCleanDictation.mockImplementation(async () => 'npm run build --watch')
    const result = await finalizeWith({ text: 'npm run build dash dash watch', context: { app: 'Terminal' } })
    expect(result.json).toEqual({
      text: 'npm run build dash dash watch', surface: 'message', polished: false,
      polishSkipped: 'failed', polishOutcome: 'guarded', guard: 'literal', polishRegister: 'literal', polishPrompt: 'v4', learnedStyle: false,
    })
  })

  it('6.91.0: Claude, Cursor, an unknown app and no app are all default, with the same model call', async () => {
    autoCleanDictation.mockImplementation(async (text: string) => text)
    for (const context of [{ app: 'Claude' }, { app: 'Cursor' }, { app: 'Some App' }, undefined, { app: 42 }]) {
      const result = await finalizeWith({ text: 'Send it to Dana.', ...(context ? { context } : {}) })
      expect(result.json.polishRegister, JSON.stringify(context)).toBe('default')
      expect(autoCleanDictation).toHaveBeenLastCalledWith('Send it to Dana.', expect.any(Array), expect.objectContaining({ register: 'default' }))
    }
    // Registers are opt-in: by default a terminal is default too, with the same model call as no app.
    const terminal = await finalizeWith({ text: 'Send it to Dana.', context: { app: 'iTerm2' } })
    expect(terminal.json.polishRegister).toBe('default')
    expect(autoCleanDictation).toHaveBeenLastCalledWith('Send it to Dana.', expect.any(Array), expect.objectContaining({ register: 'default' }))
    process.env.COS_DICTATION_REGISTERS = '0'
    expect((await finalizeWith({ text: 'git status', context: { app: 'iTerm2' } })).json.polishRegister).toBe('default')
  })

  it('6.91.0: an answer that lost a negation is refused; the log carries counts, never words', async () => {
    const warn = vi.spyOn(console, 'warn')
    autoCleanDictation.mockImplementation(async () => 'Merge to main before the review.')
    const result = await finalizeWith({ text: 'never merge to main before the review' })
    expect(result.json).toEqual({
      text: 'never merge to main before the review', surface: 'message', polished: false,
      polishSkipped: 'failed', polishOutcome: 'guarded', guard: 'negation', polishRegister: 'default', polishPrompt: 'v4', learnedStyle: false,
    })
    expect(warn.mock.calls.flat().join(' ')).toContain('auto-clean answer guarded: negation=1/0')
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/merge|review/i)
    expect(logTokenAudit).toHaveBeenLastCalledWith(expect.objectContaining({ polishOutcome: 'guarded', polishGuard: 'negation', polishRegister: 'default' }))
    // Dropped numbers, dates and names too.
    autoCleanDictation.mockImplementation(async () => 'Order cases for Lena.')
    expect((await finalizeWith({ text: 'order 12 cases for Lena' })).json.guard).toBe('number')
    autoCleanDictation.mockImplementation(async () => 'Send it.')
    expect((await finalizeWith({ text: 'send it on Friday' })).json.guard).toBe('date')
    expect((await finalizeWith({ text: 'send it to Priya' })).json.guard).toBe('name')
    // A self-correction is not a drop.
    autoCleanDictation.mockImplementation(async () => 'Order six cases.')
    expect((await finalizeWith({ text: 'order five actually six cases' })).json).toMatchObject({ text: 'Order six cases.', polishOutcome: 'polished' })
    warn.mockRestore()
  })

  it('6.91.0: COS_DICTATION_MEANING_GUARD=0 turns the guard off', async () => {
    process.env.COS_DICTATION_MEANING_GUARD = '0'
    autoCleanDictation.mockImplementation(async () => 'Merge to main.')
    expect((await finalizeWith({ text: 'never merge to main' })).json).toMatchObject({ text: 'Merge to main.', polishOutcome: 'polished' })
  })

  it('6.91.0: meeting lines are untouched: prompt v3, no register, no learned style, no meaning guard', async () => {
    // Registers on, so "no register" is about meetings, not the opt-in default.
    process.env.COS_DICTATION_REGISTERS = '1'
    await withStyle([HONESTLY], async () => {
      autoCleanDictation.mockImplementation(async () => 'Merge to main.')
      const meeting = await finalizeWith({ text: 'never merge to main', surface: 'meeting', context: { app: 'iTerm2' } })
      expect(autoCleanDictation).toHaveBeenLastCalledWith('never merge to main', expect.any(Array), expect.objectContaining({ promptVersion: 'v3', register: 'default', learnedStyle: '', customInstructions: '' }))
      expect(meeting.json).toEqual({ text: 'Merge to main.', surface: 'meeting', polished: true, polishOutcome: 'polished', polishPrompt: 'v3', learnedStyle: false })
    })
  })

  it('6.91.0: messages use the configured prompt (v4 by default, v3 when rolled back)', async () => {
    autoCleanDictation.mockImplementation(async (text: string) => text)
    await finalizeWith({ text: 'Send it.' })
    expect(autoCleanDictation).toHaveBeenLastCalledWith('Send it.', expect.any(Array), expect.objectContaining({ promptVersion: 'v4' }))
    process.env.COS_DICTATION_POLISH_PROMPT = 'v3'
    await finalizeWith({ text: 'Send it.' })
    expect(autoCleanDictation).toHaveBeenLastCalledWith('Send it.', expect.any(Array), expect.objectContaining({ promptVersion: 'v3' }))
  })

  it('6.91.0: the learned style reaches the model by its lines and the answer by its hash only', async () => {
    const store = await import('../lib/dictation-learned-style.js')
    await withStyle([HONESTLY], async () => {
      const { hash } = store.readLearnedStyle()
      autoCleanDictation.mockImplementation(async () => 'The layout is easier to read.')
      const result = await finalizeWith({ text: 'honestly the layout is easier to read' })
      expect(autoCleanDictation).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ learnedStyle: '- Drop "honestly" where the speaker used it as filler.' }))
      expect(result.json).toEqual({
        text: 'The layout is easier to read.', surface: 'message', polished: true,
        polishOutcome: 'polished', polishRegister: 'default', polishPrompt: 'v4', learnedStyle: true, learnedStyleHash: hash,
      })
      expect(logTokenAudit).toHaveBeenLastCalledWith(expect.objectContaining({ learnedStyle: { on: true, hash } }))
      expect(JSON.stringify(logTokenAudit.mock.calls)).not.toContain('honestly')
      // A terminal gets the style by default (registers are opt-in), and never with the literal register.
      autoCleanDictation.mockImplementation(async (text: string) => text)
      const terminalDefault = await finalizeWith({ text: 'git status', context: { app: 'kitty' } })
      expect(terminalDefault.json).toMatchObject({ polishRegister: 'default', learnedStyle: true })
      process.env.COS_DICTATION_REGISTERS = '1'
      const literal = await finalizeWith({ text: 'git status', context: { app: 'kitty' } })
      expect(autoCleanDictation).toHaveBeenLastCalledWith('git status', expect.any(Array), expect.objectContaining({ learnedStyle: '' }))
      expect(literal.json.learnedStyle).toBe(false)
      delete process.env.COS_DICTATION_REGISTERS
      // The server switch turns it off for real.
      process.env.COS_DICTATION_LEARNED_STYLE = '0'
      await finalizeWith({ text: 'honestly send it' })
      expect(autoCleanDictation).toHaveBeenLastCalledWith('honestly send it', expect.any(Array), expect.objectContaining({ learnedStyle: '' }))
      delete process.env.COS_DICTATION_LEARNED_STYLE
    })
    // The person's own switch too, with the rules kept.
    await withStyle([HONESTLY], async () => {
      autoCleanDictation.mockImplementation(async (text: string) => text)
      const off = await finalizeWith({ text: 'honestly send it' })
      expect(autoCleanDictation).toHaveBeenLastCalledWith('honestly send it', expect.any(Array), expect.objectContaining({ learnedStyle: '' }))
      expect(off.json.learnedStyle).toBe(false)
    }, false)
  })

  it('6.91.0: the warm path gets the same register and learned style as the cold one', async () => {
    await withStyle([HONESTLY], async () => {
      const warm = await finalizeWith({ text: 'Send the deck to Dana', prewarmToken: WARM_TOKEN, autocleanModel: 'sonnet' })
      expect(prewarm.run).toHaveBeenCalledWith(expect.anything(), 'Send the deck to Dana', expect.any(Array), expect.objectContaining({
        register: 'default', learnedStyle: '- Drop "honestly" where the speaker used it as filler.', promptVersion: 'v4',
      }))
      expect(warm.json).toMatchObject({ prewarm: 'used', learnedStyle: true, polishRegister: 'default' })
    })
  })

  it('6.91.0: prompt drafts (G2) get the new fields; the guard only on Sonnet v4, so G2 Haiku answers are 6.90.0\'s', async () => {
    transcribeAudioBuffer.mockResolvedValue({ text: 'never merge to main', backend: 'fast-local-test', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', elapsedMs: 20, audioBytes: 3200 })
    autoCleanDictation.mockImplementation(async () => 'Merge to main.')
    const draft = async (model: string) => {
      const started = await httpRequest('POST', '/api/prompt-drafts/start')
      emitDisplay.mockClear()
      await httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/chunks?chunkIndex=0&mode=fast`, Buffer.alloc(3200, 1))
      await vi.waitFor(() => expect(emitDisplay).toHaveBeenCalled())
      return httpRequest('POST', `/api/prompt-drafts/${started.json.draftId}/finalize?mode=fast&autoclean=1&autocleanModel=${model}`)
    }
    // Haiku (the G2 default): prompt v3, no register and no meaning guard: the model's answer goes out.
    const haiku = await draft('haiku')
    expect(haiku.json).toMatchObject({ text: 'Merge to main.', polishOutcome: 'polished', polishPrompt: 'v3', learnedStyle: false })
    expect(haiku.json.guard).toBeUndefined()
    expect(haiku.json.polishSkipped).toBeUndefined()
    expect(haiku.json.polishRegister).toBeUndefined()
    // Sonnet: prompt v4, and the guard refuses the lost negation.
    const sonnet = await draft('sonnet')
    expect(sonnet.json).toMatchObject({ text: 'never merge to main', polishSkipped: 'failed', polishOutcome: 'guarded', guard: 'negation', polishPrompt: 'v4', polishRegister: 'default' })
  })

  it('6.91.0 S1: the meaning guard runs only where v4 runs on Sonnet; every other pair gets 6.90.0\'s answer', async () => {
    // The v3 answer drops a number: never guarded off the canaried pair.
    autoCleanDictation.mockImplementation(async () => 'Order cases for Lena.')
    for (const model of ['haiku', 'luna-5.6-fast', undefined]) {
      const result = await finalizeWith({ text: 'order 12 cases for Lena', autocleanModel: model })
      expect(result.json, String(model)).toEqual({ text: 'Order cases for Lena.', surface: 'message', polished: true, polishOutcome: 'polished', polishPrompt: 'v3', learnedStyle: false })
    }
    // The same answer on Sonnet v4 IS guarded.
    expect((await finalizeWith({ text: 'order 12 cases for Lena' })).json).toMatchObject({ text: 'order 12 cases for Lena', polishOutcome: 'guarded', guard: 'number', polishPrompt: 'v4' })
    // Sonnet on v3 (the environment, or Previous polish) is not canaried either.
    process.env.COS_DICTATION_POLISH_PROMPT = 'v3'
    expect((await finalizeWith({ text: 'order 12 cases for Lena' })).json).toMatchObject({ text: 'Order cases for Lena.', polishOutcome: 'polished', polishPrompt: 'v3' })
    delete process.env.COS_DICTATION_POLISH_PROMPT
    const options = await import('../lib/dictation-polish-options.js')
    options.writePolishOptions('v3')
    try {
      expect((await finalizeWith({ text: 'order 12 cases for Lena' })).json).toMatchObject({ text: 'Order cases for Lena.', polishOutcome: 'polished', polishPrompt: 'v3' })
    } finally { options.writePolishOptions('default') }
    // Haiku forced onto v4 is still not the canaried pair: no guard.
    process.env.COS_DICTATION_POLISH_PROMPT = 'v4'
    expect((await finalizeWith({ text: 'order 12 cases for Lena', autocleanModel: 'haiku' })).json).toMatchObject({ text: 'Order cases for Lena.', polishOutcome: 'polished', polishPrompt: 'v4' })
    // The link guard still runs on every pair, as in 6.83.1.
    delete process.env.COS_DICTATION_POLISH_PROMPT
    autoCleanDictation.mockImplementation(async () => 'Open example.com/pricing now.')
    expect((await finalizeWith({ text: 'open the pricing page now', autocleanModel: 'haiku' })).json).toMatchObject({ text: 'open the pricing page now', polishSkipped: 'link_guard', polishOutcome: 'guarded', guard: 'link' })
  })

  it('6.91.1: on Sonnet v4 with a time-format instruction, the formatted times of C5 b02 and b09 are not guarded', async () => {
    await withInstructions('Write times in the form 10:30 am.', async () => {
      autoCleanDictation.mockImplementation(async () => 'Schedule it for Wednesday at 10:00 am.')
      expect((await finalizeWith({ text: 'schedule it for Tuesday no wait Wednesday at ten' })).json)
        .toMatchObject({ text: 'Schedule it for Wednesday at 10:00 am.', polished: true, polishOutcome: 'polished', polishPrompt: 'v4', customInstructions: true })
      autoCleanDictation.mockImplementation(async () => 'The call is at 10:30 am Central.')
      const b09 = await finalizeWith({ text: 'the call is at nine thirty I mean ten thirty Central' })
      expect(b09.json).toMatchObject({ text: 'The call is at 10:30 am Central.', polishOutcome: 'polished' })
      expect(b09.json.guard).toBeUndefined()
      // A real change of time is still refused.
      autoCleanDictation.mockImplementation(async () => 'The call is at 11:30 am Central.')
      expect((await finalizeWith({ text: 'the call is at ten thirty Central' })).json).toMatchObject({ polishOutcome: 'guarded', guard: 'number' })
    })
  })

  it('6.91.0 S6: an empty model answer is a failed polish, never "unchanged"', async () => {
    autoCleanDictation.mockImplementation(async () => '   ')
    const result = await finalizeWith({ text: 'scratch that' })
    expect(result.json).toMatchObject({ text: 'scratch that', polished: false, polishSkipped: 'failed' })
    expect(result.json.polishOutcome).toBeUndefined()
    expect(logTokenAudit).not.toHaveBeenCalledWith(expect.objectContaining({ polishOutcome: 'unchanged' }))
  })

  it('6.91.0 C6: an old client body works, and a skip path sends no polishOutcome', async () => {
    autoCleanDictation.mockImplementation(async (text: string) => `${text} Done.`)
    // The 0.5.325 to 0.5.343 helper body: text, surface, autocleanModel, context.app, prewarmToken.
    expect((await finalizeWith({ text: 'Send it', context: { app: 'Slack' } })).status).toBe(200)
    process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY_MESSAGE = '1'
    const capped = await finalizeWith({ text: 'Send it again' })
    expect(capped.json).toEqual({ text: 'Send it again', surface: 'message', polished: false, polishSkipped: 'daily_cap' })
  })

  it('6.91.0 C6: an old helper (0.5.343) reading a guarded answer logs fillers_only or skipped, never "applied"', async () => {
    // A port of ProviderStatusCore DictationPolishBridge.answer (skipReasons) and MacDictationCore
    // DictationPolish.choose at ctl-343 30f6d06, the code an old Control runs against this answer.
    const SKIP_REASONS = new Set(['daily_cap', 'breaker_open', 'too_long', 'disabled', 'failed', 'clean', 'link_guard'])
    const oldControl = (heard: string, body: any) => {
      const skipped = typeof body.polishSkipped === 'string' && SKIP_REASONS.has(body.polishSkipped) ? body.polishSkipped : null
      if (body.polished !== true) return skipped ? `skipped:${skipped}` : 'failed:not_polished'
      if (skipped) return body.text === heard ? `skipped:${skipped}` : `fillers_only:${skipped}`
      return body.text === heard ? 'unchanged' : 'applied'
    }
    autoCleanDictation.mockImplementation(async () => 'Merge to main.')
    for (const heard of ['never merge to main', 'um, never merge to main']) {
      const guarded = (await finalizeWith({ text: heard })).json
      expect(guarded.polishOutcome).toBe('guarded')
      const logged = oldControl(heard, guarded)
      expect(logged, heard).toMatch(/^(fillers_only|skipped):failed$/)
    }
    // The filler pass changed it and the guard refused the model: fillers_only:failed, the plan's C6 line.
    expect(oldControl('um, never merge to main', (await finalizeWith({ text: 'um, never merge to main' })).json)).toBe('fillers_only:failed')
  })

  it('6.91.0 option C: Haiku, Luna and an unnamed model run v3 with no register and no learned style, even in a terminal with rules saved', async () => {
    await withStyle([HONESTLY], async () => {
      autoCleanDictation.mockImplementation(async (text: string) => text)
      for (const model of ['haiku', 'luna-5.6-fast', undefined]) {
        const result = await finalizeWith({ text: 'honestly git status', context: { app: 'iTerm2' }, autocleanModel: model })
        expect(autoCleanDictation, String(model)).toHaveBeenLastCalledWith('honestly git status', expect.any(Array), expect.objectContaining({ promptVersion: 'v3', register: 'default', learnedStyle: '' }))
        expect(result.json, String(model)).toMatchObject({ polishPrompt: 'v3', learnedStyle: false })
        expect(result.json.polishRegister, String(model)).toBeUndefined()
      }
      // Sonnet takes v4 and the style; a terminal is default unless registers are on.
      const sonnetTerminal = await finalizeWith({ text: 'honestly git status', context: { app: 'iTerm2' } })
      expect(sonnetTerminal.json).toMatchObject({ polishPrompt: 'v4', polishRegister: 'default', learnedStyle: true })
      process.env.COS_DICTATION_REGISTERS = '1'
      const sonnet = await finalizeWith({ text: 'honestly git status', context: { app: 'iTerm2' } })
      expect(sonnet.json).toMatchObject({ polishPrompt: 'v4', polishRegister: 'literal', learnedStyle: false })
      delete process.env.COS_DICTATION_REGISTERS
      const chat = await finalizeWith({ text: 'honestly send it' })
      expect(chat.json).toMatchObject({ polishPrompt: 'v4', polishRegister: 'default', learnedStyle: true })
    })
  })

  it('6.91.0 option C: the environment and Previous polish override every model; Sonnet on v3 gets no style or register', async () => {
    autoCleanDictation.mockImplementation(async (text: string) => text)
    process.env.COS_DICTATION_POLISH_PROMPT = 'v4'
    // Registers on, so "no register" below is about the model and prompt pair, not the opt-in default.
    process.env.COS_DICTATION_REGISTERS = '1'
    expect((await finalizeWith({ text: 'Send it.', autocleanModel: 'haiku' })).json.polishPrompt).toBe('v4')
    // Haiku on v4 is not a canaried pair: still no register.
    expect((await finalizeWith({ text: 'git status', autocleanModel: 'haiku', context: { app: 'iTerm2' } })).json.polishRegister).toBeUndefined()
    process.env.COS_DICTATION_POLISH_PROMPT = 'v3'
    const sonnetV3 = await finalizeWith({ text: 'git status', context: { app: 'iTerm2' } })
    expect(sonnetV3.json).toMatchObject({ polishPrompt: 'v3', learnedStyle: false })
    expect(sonnetV3.json.polishRegister).toBeUndefined()
    delete process.env.COS_DICTATION_POLISH_PROMPT
    const options = await import('../lib/dictation-polish-options.js')
    options.writePolishOptions('v3')
    try {
      expect((await finalizeWith({ text: 'Send it.' })).json.polishPrompt).toBe('v3')
    } finally { options.writePolishOptions('default') }
    // v1 and v2 are not in the closed set: no polishPrompt at all.
    process.env.COS_DICTATION_POLISH_PROMPT = 'v2'
    expect((await finalizeWith({ text: 'Send it.' })).json.polishPrompt).toBeUndefined()
  })
})
