// 6.72.0 wire-up: the live chunk route keeps the silence TEXT drops (repeated
// thank-you, URL-only) on the pre-6.72 RMS test, even when the Silero quiet gate
// calls the chunk quiet. A real POST through the real express route, models faked.
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { wavOf } from '../lib/__fixtures__/nemotron-helpers.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.resetModules()
  for (const mod of ['../lib/whisper-local.js', '../lib/audio-enhance.js', '../lib/speaker-embeddings.js', '../lib/vad-silero.js', '../lib/profile.js', '../lib/nemotron-live.js', '../lib/stt-live.js']) vi.doUnmock(mod)
  delete process.env.COS_DATA_DIR
})

const TEXT = 'Thank you. Thank you.'
const AUDIO = wavOf(6, () => 400)

async function mount(quiet: { isQuiet: boolean; rms: number }) {
  vi.resetModules()
  const root = mkdtempSync(join(tmpdir(), 'cos-quiet-route-'))
  roots.push(root)
  process.env.COS_DATA_DIR = root
  vi.doMock('../lib/whisper-local.js', () => ({
    transcribeLocal: vi.fn().mockResolvedValue({ text: TEXT, backend: 'server' }),
    applyCorrections: (text: string) => text,
  }))
  vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    AUTO_ENROLL_CANDIDATE_SIMILARITY: 0.72,
    AUTO_ENROLL_THRESHOLD: 0.88,
    identifySpeaker: () => ({ speaker: 'MU', similarity: 0.9 }),
    isEmbeddingAvailable: () => true,
    autoEnroll: vi.fn().mockReturnValue({ enrolled: false, reason: 'test' }),
    getEmbeddingCount: () => 3,
  }))
  vi.doMock('../lib/vad-silero.js', () => ({ trimSilence: vi.fn(), isSileroAvailable: () => false, measureSpeechSeconds: () => null }))
  vi.doMock('../lib/profile.js', () => ({
    getVocabulary: () => [],
    getOwnerName: () => 'COS',
    getWhisperCorrections: () => '',
    getOwnerSpeakerLabel: () => 'MU',
  }))
  vi.doMock('../lib/stt-live.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/stt-live.js')>()),
    decideQuiet: () => ({ ...quiet, speechSec: 0.2, gate: 'silero' }),
  }))
  vi.doMock('../lib/nemotron-live.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/nemotron-live.js')>()),
    nemotronLive: { diarize: vi.fn(async () => ({ ok: false, reason: 'embedding_requested' })), record: vi.fn(), snapshot: () => ({}) },
  }))
  const stream = await import('./transcribe-stream.js')
  const app = express()
  app.use('/api', stream.transcribeStreamRouter)
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const address = server.address()
  return typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
}

function post(base: string, sessionId: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/transcribe-stream?sessionId=${sessionId}&chunkIndex=0&speaker=MU&elapsed=6000`, {
      method: 'POST',
      headers: { 'Content-Length': String(AUDIO.length), 'Content-Type': 'application/octet-stream' },
    }, res => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.end(AUDIO)
  })
}

describe('live quiet gate in the chunk route (6.72.0)', () => {
  it('Silero calls a loud chunk quiet: the thank-you text is kept (drops stay on RMS)', async () => {
    const base = await mount({ isQuiet: true, rms: 400 })
    const body = await post(base, 'quiet_route_loud')
    expect(body.text).toBe(TEXT)
  })

  it('a truly quiet chunk (RMS under 150) still drops the thank-you hallucination', async () => {
    const base = await mount({ isQuiet: true, rms: 80 })
    const body = await post(base, 'quiet_route_soft')
    expect(body.text).toBe('')
  })
})
