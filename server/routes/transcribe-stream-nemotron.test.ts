// 6.61.0 wire-up: a real POST through the real express route, with only the
// models faked. Proves the chunk response gains `segments` while every legacy
// field older glasses read stays exactly as it was, that the segments are
// stored on the chunk, and that a Nemotron fallback answers like 6.60.
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { activityOf, wavOf } from '../lib/__fixtures__/nemotron-helpers.js'
import type { LiveDiarizeOutcome } from '../lib/nemotron-live.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.resetModules()
  for (const mod of ['../lib/whisper-local.js', '../lib/audio-enhance.js', '../lib/speaker-embeddings.js', '../lib/vad-silero.js', '../lib/profile.js', '../lib/nemotron-live.js', '../lib/display-bus.js']) vi.doUnmock(mod)
  delete process.env.COS_DATA_DIR
})

const TEXT = 'Yeah I agree with that. So the bookings month came in light again.'
// MU speaks the first 2.6 s (positive samples), Silas the rest (negative samples).
const AUDIO = wavOf(6, t => (t < 2.8 ? 400 : -400))

async function mount(outcome: LiveDiarizeOutcome, trackSimilarity = 0.83) {
  vi.resetModules()
  const root = mkdtempSync(join(tmpdir(), 'cos-nemotron-route-'))
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
    // The whole (mixed) chunk sounds most like MU; each track's own audio is named by its sign.
    identifySpeaker: (wav: Buffer) => wav.length >= 44 + 5 * 32_000
      ? { speaker: 'MU', similarity: 0.61 }
      : wav.readInt16LE(44) >= 0 ? { speaker: 'MU', similarity: trackSimilarity } : { speaker: 'Silas Larson', similarity: 0.77 },
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
  const record = vi.fn()
  const diarize = vi.fn(async () => outcome)
  const displayed: Array<{ type: string; data: Record<string, unknown> }> = []
  vi.doMock('../lib/display-bus.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/display-bus.js')>()),
    emitDisplay: (event: { type: string; data: Record<string, unknown> }) => { displayed.push(event) },
  }))
  vi.doMock('../lib/nemotron-live.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/nemotron-live.js')>()),
    nemotronLive: { diarize, record, snapshot: () => ({}) },
  }))
  const stream = await import('./transcribe-stream.js')
  const app = express()
  app.use('/api', stream.transcribeStreamRouter)
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  return { base, stream, record, diarize, displayed }
}

function post(base: string, sessionId: string, chunkIndex: number): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/transcribe-stream?sessionId=${sessionId}&chunkIndex=${chunkIndex}&speaker=MU&elapsed=${chunkIndex * 6000}`, {
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

const run = () => ({ ...activityOf(6, [[0, 0, 2.6], [5, 3, 6]]), loadSec: 0.1, audioSec: 6, wallMs: 140 })

describe('the live chunk response with Nemotron', () => {
  it('adds segments in time order and keeps the legacy fields intact', async () => {
    const { base, stream, record, diarize, displayed } = await mount({ ok: true, run: run() })
    const body = await post(base, 'nemotron_route_a', 0)
    // Legacy fields, exactly as 6.60 returned them.
    expect(body).toMatchObject({ text: TEXT, chunkIndex: 0, elapsed: 0, sessionId: 'nemotron_route_a', asrCompleted: true, canonical: true })
    expect(typeof body.speaker).toBe('string')
    // `speaker` is the dominant track's name (Silas holds 3.0 s against 2.6 s).
    expect(body.speaker).toBe('Silas Larson')
    // The contract shared with COS Glasses 6.9.567.
    expect(body.segments).toEqual([
      { speaker: 'MU', text: expect.any(String), startSec: expect.any(Number), endSec: expect.any(Number), similarity: 0.83 },
      { speaker: 'Silas Larson', text: expect.any(String), startSec: expect.any(Number), endSec: expect.any(Number), similarity: 0.77 },
    ])
    expect(body.segments.map((s: any) => s.text).join(' ')).toBe(body.text)
    expect(body.segments[0].endSec).toBeLessThanOrEqual(body.segments[1].startSec)
    // Nemotron read the durable chunk WAV the server had already written.
    expect(diarize.mock.calls[0]).toEqual([join(process.env.COS_DATA_DIR!, 'session-audio', 'nemotron_route_a', 'chunk_0000.wav')])
    expect(record).toHaveBeenCalledWith({ sessionId: 'nemotron_route_a', chunkIndex: 0 }, expect.objectContaining({ outcome: 'nemotron', segments: 2 }))
    // Stored on the chunk, so the saved meeting keeps them.
    const stored = stream.getSessionChunks('nemotron_route_a')![0]
    expect(stored.segments).toEqual(body.segments)
    // The whole-chunk voiceprint said MU; it stays recoverable on the chunk.
    expect(stored.diarizer).toMatchObject({ engine: 'nemotron', tracks: 2, timing: 'estimated', voiceprintSpeaker: 'MU', voiceprintSimilarity: 0.61 })
    expect(stored.speaker).toBe('Silas Larson')
    expect(stored.similarity).toBe(0.77)
    // The HUD event carries the same turns.
    expect(displayed.find(event => event.type === 'transcript_chunk')?.data).toMatchObject({ speaker: 'Silas Larson', segments: body.segments })
    expect(stream.getSessionTranscript('nemotron_route_a')).toBe(`[Silas Larson]: ${TEXT}`)
    // A replayed upload of the same canonical chunk returns the same segments.
    const replay = await post(base, 'nemotron_route_a', 0)
    expect(replay.segments).toEqual(body.segments)
  })

  it('6.61.1: the wearer\'s own profile (owner_speaker_label) guards a split chunk: a weak wearer match is Ext', async () => {
    const { base, stream, record } = await mount({ ok: true, run: run() }, 0.6)
    const body = await post(base, 'nemotron_route_guard', 0)
    expect(body.segments.map((s: any) => s.speaker)).toEqual(['Ext', 'Silas Larson'])
    expect(stream.getSessionChunks('nemotron_route_guard')![0].diarizer).toMatchObject({ ownerGuard: ['weak_owner'] })
    expect(record).toHaveBeenCalledWith({ sessionId: 'nemotron_route_guard', chunkIndex: 0 }, expect.objectContaining({ ownerGuard: { client_label: 0, weak_owner: 1 } }))
  })

  it('a Nemotron fallback answers exactly like 6.60: the voiceprint label, no segments', async () => {
    const { base, stream, record } = await mount({ ok: false, reason: 'timeout', detail: 'no result within 1500 ms' })
    const body = await post(base, 'nemotron_route_b', 0)
    expect(body).toMatchObject({ text: TEXT, speaker: 'MU', canonical: true })
    expect(body.segments).toBeUndefined()
    expect(stream.getSessionChunks('nemotron_route_b')![0]).toMatchObject({ speaker: 'MU', similarity: 0.61, diarizer: { engine: 'voiceprint', fallback: 'timeout' } })
    expect(record).toHaveBeenCalledWith({ sessionId: 'nemotron_route_b', chunkIndex: 0 }, expect.objectContaining({ outcome: 'voiceprint', reason: 'timeout' }))
  })

  it('the voiceprint selected by config leaves the chunk record exactly as 6.60 wrote it', async () => {
    const { base, stream, record } = await mount({ ok: false, reason: 'embedding_requested' })
    const body = await post(base, 'nemotron_route_c', 0)
    expect(body.segments).toBeUndefined()
    const stored = stream.getSessionChunks('nemotron_route_c')![0]
    expect(stored.diarizer).toBeUndefined()
    expect(stored.segments).toBeUndefined()
    expect(record).not.toHaveBeenCalled()
  })
})
