// Even speakerRole must not change Whisper text or voiceprint labels.
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
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
  delete process.env.COS_DATA_DIR
  delete process.env.COS_CHUNK_EMBEDDINGS
  delete process.env.COS_EVEN_SPEAKER_ROLE
  if (root) rmSync(root, { recursive: true, force: true })
})

async function mountRoute(identify: (...args: unknown[]) => unknown): Promise<{
  base: string
  stream: typeof import('./transcribe-stream.js')
}> {
  vi.resetModules()
  vi.doMock('../lib/whisper-local.js', () => ({
    transcribeLocal: vi.fn().mockResolvedValue({ text: 'hello there', words: [], backend: 'mock' }),
    applyCorrections: (text: string) => text,
  }))
  vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    identifySpeaker: identify,
    isEmbeddingAvailable: () => true,
    autoEnroll: vi.fn().mockReturnValue({ enrolled: false, reason: 'test' }),
    getEmbeddingCount: () => 3,
  }))
  vi.doMock('../lib/vad-silero.js', () => ({ trimSilence: vi.fn(), isSileroAvailable: () => false }))
  vi.doMock('../lib/profile.js', () => ({
    getVocabulary: () => [],
    getOwnerName: () => 'COS',
    getWhisperCorrections: () => '',
    getOwnerSpeakerLabel: () => 'MU',
  }))

  const stream = await import('./transcribe-stream.js')
  const app = express()
  app.use('/api', stream.transcribeStreamRouter)
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  return {
    base: typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '',
    stream,
  }
}

function postChunk(base: string, query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const audio = Buffer.alloc(44 + 3 * 32_000, 1)
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}/api/transcribe-stream?${query}`,
      {
        method: 'POST',
        headers: { 'Content-Length': String(audio.length), 'Content-Type': 'application/octet-stream' },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c as Buffer))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: Record<string, unknown> = {}
          try { body = JSON.parse(raw) as Record<string, unknown> } catch { body = { raw } }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('error', reject)
    req.end(audio)
  })
}

describe('Even speakerRole is a prior, not a label', () => {
  it('does not override a voiceprint MU label when Even says other', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-even-role-'))
    process.env.COS_DATA_DIR = root
    const identify = vi.fn().mockReturnValue({
      speaker: 'MU', similarity: 0.81, embedding: new Float32Array(192),
    })
    const { base, stream } = await mountRoute(identify)

    const res = await postChunk(
      base,
      'sessionId=even_001&chunkIndex=0&speaker=Ext&eh=0,200,0,200,0,',
    )
    expect(res.status).toBe(200)
    expect(res.body.speaker).toBe('MU')
    expect(res.body.text).toBe('hello there')
    expect(identify).toHaveBeenCalledTimes(1)

    const chunks = stream.getSessionChunks('even_001')
    expect(chunks?.[0].evenHubSpeakerRole).toMatchObject({
      majority: 'other', frames: 200, other: 200,
    })
    stream.deleteSession('even_001')
  })

  it('ignores a malformed eh query instead of failing the chunk', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-even-role-bad-'))
    process.env.COS_DATA_DIR = root
    const { base, stream } = await mountRoute(vi.fn().mockReturnValue({
      speaker: 'Ext', similarity: 0, embedding: new Float32Array(192),
    }))
    const res = await postChunk(base, 'sessionId=even_bad&chunkIndex=0&speaker=MU&eh=nope')
    expect(res.status).toBe(200)
    expect(res.body.speaker).toBe('Ext')
    expect(stream.getSessionChunks('even_bad')?.[0].evenHubSpeakerRole).toBeUndefined()
    stream.deleteSession('even_bad')
  })
})
