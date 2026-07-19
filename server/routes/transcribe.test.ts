import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

class MockNoSpeechDetectedError extends Error { readonly rawText = '' }
class MockBudgetError extends Error { readonly spentTodayUsd = 5; readonly capUsd = 5 }
class MockUnavailableError extends Error {
  readonly status = 503
  constructor(readonly reason = 'local_asr_unavailable') {
    super('Local transcription unavailable; retry after Whisper recovers')
  }
}

const transcribeAudioBuffer = vi.fn()

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
})
