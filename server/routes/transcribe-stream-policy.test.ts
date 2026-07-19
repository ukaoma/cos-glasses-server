import express from 'express'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let root = ''
let server: Server | null = null

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.doUnmock('../lib/whisper-local.js')
  vi.doUnmock('../lib/audio-enhance.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
  vi.doUnmock('../lib/vad-silero.js')
  vi.doUnmock('../lib/profile.js')
  vi.doUnmock('../lib/openai-key.js')
  vi.doUnmock('../lib/openai-whisper-budget.js')
  delete process.env.COS_DATA_DIR
  delete process.env.COS_OPENAI_WHISPER_FALLBACK
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('meeting transcription local-first failure contract', () => {
  it('persists raw audio and never fetches OpenAI when only a key exists', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-stream-local-first-'))
    process.env.COS_DATA_DIR = root
    delete process.env.COS_OPENAI_WHISPER_FALLBACK
    vi.resetModules()
    vi.doMock('../lib/whisper-local.js', () => ({
      transcribeLocal: vi.fn().mockRejectedValue(new Error('local worker down')),
      applyCorrections: (text: string) => text,
    }))
    vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
    vi.doMock('../lib/speaker-embeddings.js', () => ({
      identifySpeaker: vi.fn(),
      isEmbeddingAvailable: () => false,
      autoEnroll: vi.fn(),
      getEmbeddingCount: () => 0,
    }))
    vi.doMock('../lib/vad-silero.js', () => ({ trimSilence: vi.fn(), isSileroAvailable: () => false }))
    vi.doMock('../lib/profile.js', () => ({ getVocabulary: () => [], getOwnerName: () => 'COS' }))
    vi.doMock('../lib/openai-key.js', () => ({
      getKeyStatus: () => ({ hasKey: true, source: 'env' }),
      getOpenAIKey: () => 'configured-but-not-authorized',
      tryGetOpenAIKey: () => true,
    }))
    vi.doMock('../lib/openai-whisper-budget.js', () => ({
      assertOpenAIWhisperBudget: vi.fn(),
      recordOpenAIWhisperUsage: vi.fn(),
      estimateAudioSeconds: (buffer: Buffer) => buffer.length / 32000,
      OpenAIWhisperBudgetExhaustedError: class OpenAIWhisperBudgetExhaustedError extends Error {},
    }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const stream = await import('./transcribe-stream.js')
    const app = express()
    app.use('/api', stream.transcribeStreamRouter)
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const address = server.address()
    const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
    const audio = Buffer.alloc(3200, 1)
    const response = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(`${base}/api/transcribe-stream?sessionId=local_first_001&chunkIndex=0&speaker=MU`, {
        method: 'POST',
        headers: { 'Content-Length': String(audio.length), 'Content-Type': 'application/octet-stream' },
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
        })
      })
      req.on('error', reject)
      req.end(audio)
    })

    expect(response.status).toBe(503)
    expect(response.json).toMatchObject({ reason: 'local_asr_unavailable', retryable: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(stream.getMeetingSessionStatus('local_first_001')).toMatchObject({
      state: 'active',
      receivedCount: 1,
      maxChunkIndex: 0,
    })
    const rawPath = join(root, 'session-audio', 'local_first_001', 'chunk_0000.wav')
    expect(existsSync(rawPath)).toBe(true)
    expect(readFileSync(rawPath)).toEqual(audio)
    stream.deleteSession('local_first_001')
  })
})
