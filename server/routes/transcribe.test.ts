import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

class MockNoSpeechDetectedError extends Error { readonly rawText = '' }
class MockBudgetError extends Error { readonly spentTodayUsd = 5; readonly capUsd = 5 }
class MockUnavailableError extends Error {
  readonly status = 503
  constructor(readonly reason = 'local_asr_unavailable', message = 'Local transcription unavailable; retry after Whisper recovers', readonly hint?: { action: string; retryable: boolean; detail: string }) {
    super(message)
  }
}
class MockBenchmarkRefused extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) { super(message) }
}

const transcribeAudioBuffer = vi.fn()
const runDictationBenchmark = vi.fn()

vi.mock('../lib/dictation-benchmark.js', () => ({
  BENCHMARK_MAX_BYTES: 3_840_044,
  BenchmarkRefusedError: MockBenchmarkRefused,
  runDictationBenchmark,
  parseBenchmarkEngines: (raw: unknown) => raw === undefined ? ['whisper', 'parakeet-ultra'] : raw === 'whisper' ? ['whisper'] : null,
}))

vi.mock('../lib/transcribe-audio.js', () => ({
  transcribeAudioBuffer,
  resolveTranscribeMode: () => 'hq',
  NoSpeechDetectedError: MockNoSpeechDetectedError,
  OpenAIWhisperBudgetExhaustedError: MockBudgetError,
  TranscriptionUnavailableError: MockUnavailableError,
}))

let server: Server
let base = ''

beforeAll(async () => {
  const { transcribeRouter } = await import('./transcribe.js')
  const app = express()
  app.use('/api', transcribeRouter)
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('one-shot transcription availability contract', () => {
  it('advertises desktop capability before microphone audio is transferred; version stays 1 for older Control', async () => {
    const response = await fetch(`${base}/api/transcribe/capabilities`)
    expect(response.status).toBe(200)
    // COS Control 0.5.316 and earlier accept desktopDictationVersion == 1 exactly.
    expect(await response.json()).toEqual({ desktopDictationVersion: 1, desktopDictationVersions: [1, 2], requiredEngines: ['parakeet-ultra', 'local'], localOnly: true, dictionary: 'cos', benchmark: 1 })
  })

  it('old helper contract (COS Control 0.5.316 main.swift:15397) is byte for byte: version exactly 1, localOnly true, Parakeet answers parakeet-ultra', async () => {
    const raw = await (await fetch(`${base}/api/transcribe/capabilities`)).text()
    const body = JSON.parse(raw)
    // The old helper reads these with `as? Int == 1` and `as? Bool == true`.
    expect(Number.isInteger(body.desktopDictationVersion) && body.desktopDictationVersion === 1).toBe(true)
    expect(raw).toContain('"desktopDictationVersion":1,')
    expect(body.localOnly).toBe(true)
    expect(raw).toContain('"localOnly":true')
    expect(body.requiredEngines).toContain('parakeet-ultra')
    transcribeAudioBuffer.mockResolvedValueOnce({ text: 'words', engine: 'parakeet-ultra', backend: 'parakeet-ultra', elapsedMs: 1, audioBytes: 3200 })
    const ok = await (await fetch(`${base}/api/transcribe?mode=fast&requiredEngine=parakeet-ultra`, { method: 'POST', body: Buffer.alloc(3200, 1) })).json()
    expect(ok.engine).toBe('parakeet-ultra')
    expect(ok.text).toBe('words')
  })

  it('pins local Parakeet for the desktop caller without changing legacy mode', async () => {
    transcribeAudioBuffer.mockResolvedValueOnce({ text: 'desktop words', engine: 'parakeet-ultra', elapsedMs: 10, audioBytes: 3200 })
    const response = await fetch(`${base}/api/transcribe?requiredEngine=parakeet-ultra`, { method: 'POST', body: Buffer.alloc(3200, 1) })
    expect(response.status).toBe(200)
    expect(transcribeAudioBuffer).toHaveBeenLastCalledWith(expect.any(Buffer), expect.objectContaining({ requiredEngine: 'parakeet-ultra', policy: 'local-only', affectsCircuit: false }))
  })

  it('refuses unknown engines and overlong microphone payloads before decoding', async () => {
    const before = transcribeAudioBuffer.mock.calls.length
    const invalid = await fetch(`${base}/api/transcribe?requiredEngine=other`, { method: 'POST', body: Buffer.alloc(3200, 1) })
    expect(invalid.status).toBe(400)
    const oversized = await fetch(`${base}/api/transcribe?requiredEngine=parakeet-ultra`, { method: 'POST', body: Buffer.alloc(3_840_046, 1) })
    expect(oversized.status).toBe(413)
    expect(transcribeAudioBuffer.mock.calls.length).toBe(before)
  })
  it('returns requested and actual quality without replacing legacy fields', async () => {
    transcribeAudioBuffer.mockResolvedValueOnce({
      text: 'fallback transcript',
      backend: 'fast-cli-turbo',
      mode: 'hq',
      requestedMode: 'hq',
      actualQuality: 'fast',
      degraded: true,
      degradationReason: 'large_v3_model_missing',
      elapsedMs: 10,
      audioBytes: 3200,
    })
    const response = await fetch(`${base}/api/transcribe`, {
      method: 'POST',
      body: Buffer.alloc(3200, 1),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      text: 'fallback transcript',
      backend: 'fast-cli-turbo',
      mode: 'hq',
      requestedMode: 'hq',
      actualQuality: 'fast',
      degraded: true,
      degradationReason: 'large_v3_model_missing',
    })
  })

  it('returns a typed retryable 503 instead of a generic 500', async () => {
    transcribeAudioBuffer.mockRejectedValueOnce(new MockUnavailableError())
    const response = await fetch(`${base}/api/transcribe`, {
      method: 'POST',
      body: Buffer.alloc(3200, 1),
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Local transcription unavailable; retry after Whisper recovers',
      reason: 'local_asr_unavailable',
      retryable: true,
    })
  })

  it('requiredEngine=local is Mac dictation: local only, the setting echoed, the fallback named', async () => {
    transcribeAudioBuffer.mockResolvedValueOnce({ text: 'whisper words', engine: 'whisper', engineReason: 'parakeet_warming', fallbackReason: 'parakeet_warming', dictationSetting: 'auto', backend: 'fast-local-server', mode: 'fast', requestedMode: 'fast', actualQuality: 'fast', degraded: false, elapsedMs: 10, audioBytes: 3200 })
    const response = await fetch(`${base}/api/transcribe?mode=fast&requiredEngine=local`, { method: 'POST', body: Buffer.alloc(3200, 1) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text: 'whisper words', engine: 'whisper', fallbackReason: 'parakeet_warming', dictationSetting: 'auto' })
    expect(transcribeAudioBuffer).toHaveBeenLastCalledWith(expect.any(Buffer), expect.objectContaining({ requiredEngine: 'local', policy: 'local-only', affectsCircuit: false }))
    const big = await fetch(`${base}/api/transcribe?requiredEngine=local`, { method: 'POST', body: Buffer.alloc(3_840_045, 1) })
    expect(big.status).toBe(413)
    const twice = await fetch(`${base}/api/transcribe?requiredEngine=local&requiredEngine=local`, { method: 'POST', body: Buffer.alloc(3200, 1) })
    expect(twice.status).toBe(400)
  })

  it('a Mac dictation failure carries the action and an honest retryable', async () => {
    transcribeAudioBuffer.mockRejectedValueOnce(new MockUnavailableError('no_local_engine', 'No dictation engine is ready on this Mac. Install Parakeet in Transcription settings.', { action: 'install_parakeet', retryable: false, detail: 'whisper_missing' }))
    const response = await fetch(`${base}/api/transcribe?requiredEngine=local`, { method: 'POST', body: Buffer.alloc(3200, 1) })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'No dictation engine is ready on this Mac. Install Parakeet in Transcription settings.', reason: 'no_local_engine', retryable: false, action: 'install_parakeet', detail: 'whisper_missing' })
  })

  it('the old Parakeet refusal body is byte for byte the 6.73 one', async () => {
    transcribeAudioBuffer.mockRejectedValueOnce(new MockUnavailableError('parakeet_unavailable', 'Parakeet is not ready. Select Parakeet for dictation in Transcription settings and retry.'))
    const response = await fetch(`${base}/api/transcribe?mode=fast&requiredEngine=parakeet-ultra`, { method: 'POST', body: Buffer.alloc(3200, 1) })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe(JSON.stringify({ error: 'Parakeet is not ready. Select Parakeet for dictation in Transcription settings and retry.', reason: 'parakeet_unavailable', retryable: true }))
  })

  it('benchmark: runs with the engines asked for, refuses bad input, and maps refusals', async () => {
    runDictationBenchmark.mockResolvedValueOnce({ audioSeconds: 30, results: [{ engine: 'whisper', model: 'large-v3-turbo', ran: true, elapsedMs: 900, rtf: 0.03, peakRssBytes: null, text: 'words' }] })
    const ok = await fetch(`${base}/api/transcribe/benchmark?engines=whisper`, { method: 'POST', body: Buffer.alloc(3200, 1) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ audioSeconds: 30, results: [{ engine: 'whisper', rtf: 0.03 }] })
    expect(runDictationBenchmark).toHaveBeenLastCalledWith(expect.any(Buffer), ['whisper'])
    expect((await fetch(`${base}/api/transcribe/benchmark?engines=cloud`, { method: 'POST', body: Buffer.alloc(3200, 1) })).status).toBe(400)
    expect((await fetch(`${base}/api/transcribe/benchmark`, { method: 'POST', body: Buffer.alloc(3_840_045, 1) })).status).toBe(413)
    runDictationBenchmark.mockRejectedValueOnce(new MockBenchmarkRefused(409, 'recording_live', 'A recording is live. Run the check after it is saved.'))
    const live = await fetch(`${base}/api/transcribe/benchmark`, { method: 'POST', body: Buffer.alloc(3200, 1) })
    expect(live.status).toBe(409)
    expect(await live.json()).toEqual({ error: 'A recording is live. Run the check after it is saved.', reason: 'recording_live' })
    expect(runDictationBenchmark).toHaveBeenCalledTimes(2)
  })
})
