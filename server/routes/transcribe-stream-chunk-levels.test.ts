// 6.87.0: every live chunk leaves two numbers on the active-session record (level 0 to 1, Silero speech seconds) for
// COS Control's level strip. Quiet chunks included; bounded; restored after a restart; never text, never logged.
// Fictional meeting text only: this repo is public.
import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_LEVELS_LIMIT } from '../lib/chunk-levels.js'

const CANONICAL = 'Juniper said the lantern shipment lands on Thursday'
let speechSeconds = 3.2
let asrText = CANONICAL
let root = ''
let server: Server | null = null
let base = ''
let stream: typeof import('./transcribe-stream.js')
const lines: string[] = []

function post(path: string, body: Buffer): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}
/** A WAV-shaped chunk: a 44-byte header, then three seconds of one PCM16 sample value (RMS == |sample|). */
function wav(sample: number): Buffer {
  const pcm = Buffer.alloc(3 * 32_000)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(sample, i * 2)
  return Buffer.concat([Buffer.alloc(44), pcm])
}
const chunk = (sessionId: string, chunkIndex: number, sample: number) =>
  post(`/api/transcribe-stream?sessionId=${sessionId}&chunkIndex=${chunkIndex}&speaker=MU`, wav(sample))
const sessionFile = (sessionId: string) => JSON.parse(readFileSync(join(root, 'active-sessions', `${sessionId}.json`), 'utf8'))

async function boot(prepare?: (dir: string) => void): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'cos-chunk-levels-'))
  process.env.COS_DATA_DIR = root
  prepare?.(root)
  lines.length = 0
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' ')) })
  }
  vi.resetModules()
  vi.doMock('../lib/server-instance-id.js', () => ({ getServerInstanceId: () => 'server-a' }))
  vi.doMock('../lib/whisper-local.js', () => ({ transcribeLocal: vi.fn(async () => ({ text: asrText, words: [], backend: 'mock' })), applyCorrections: (t: string) => t }))
  vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    AUTO_ENROLL_CANDIDATE_SIMILARITY: 0.72, AUTO_ENROLL_THRESHOLD: 0.88,
    identifySpeaker: vi.fn().mockReturnValue({ speaker: 'MU', similarity: 0.9, embedding: new Float32Array(192) }),
    isEmbeddingAvailable: () => true, autoEnroll: vi.fn().mockReturnValue({ enrolled: false, reason: 'test' }), getEmbeddingCount: () => 3,
  }))
  vi.doMock('../lib/vad-silero.js', () => ({ trimSilence: vi.fn(), isSileroAvailable: () => true, measureSpeechSeconds: vi.fn(() => speechSeconds) }))
  vi.doMock('../lib/profile.js', () => ({ getVocabulary: () => [], getOwnerName: () => 'COS', getWhisperCorrections: () => '', getOwnerSpeakerLabel: () => 'MU' }))
  stream = await import('./transcribe-stream.js')
  const app = express()
  app.use(express.json())
  app.use('/api', stream.transcribeStreamRouter)
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
}

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.restoreAllMocks()
  vi.resetModules()
  for (const m of ['server-instance-id', 'whisper-local', 'audio-enhance', 'speaker-embeddings', 'vad-silero', 'profile']) vi.doUnmock(`../lib/${m}.js`)
  delete process.env.COS_DATA_DIR
  speechSeconds = 3.2
  asrText = CANONICAL
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('per-chunk levels on the active-session record (6.87.0)', () => {
  it('a speech chunk and a quiet chunk each leave {i, level, speechSec}; the numbers come from the quiet gate', async () => {
    await boot()
    speechSeconds = 3.2
    expect((await chunk('levels_live_01', 0, 2000)).json).toMatchObject({ text: CANONICAL })
    speechSeconds = 0.04                                        // quiet: the silence path, no text
    asrText = ''
    await chunk('levels_live_01', 1, 60)
    const file = sessionFile('levels_live_01')
    // RMS 2000 is about -24.3 dBFS: (-24.3 + 60) / 50 = 0.714. RMS 60 is about -54.7 dBFS: 0.105.
    expect(file.chunkLevels).toEqual([
      { i: 0, level: 0.714, speechSec: 3.2 },
      { i: 1, level: 0.105, speechSec: 0.04 },
    ])
    expect(file.emptyCompletions['1']).toBeDefined()          // the quiet chunk really took the silence path
    stream.deleteSession('levels_live_01')
  })

  it('a replayed index keeps one entry, the first answer, like the chunk itself', async () => {
    await boot()
    await chunk('levels_replay_01', 0, 2000)
    speechSeconds = 1.5
    await chunk('levels_replay_01', 0, 2000)
    expect(sessionFile('levels_replay_01').chunkLevels).toEqual([{ i: 0, level: 0.714, speechSec: 3.2 }])
    stream.deleteSession('levels_replay_01')
  })

  it('the levels hold numbers only and add no log line', async () => {
    await boot()
    await chunk('levels_private_01', 0, 2000)
    const file = sessionFile('levels_private_01')
    for (const entry of file.chunkLevels) expect(Object.keys(entry).sort()).toEqual(['i', 'level', 'speechSec'])
    expect(JSON.stringify(file.chunkLevels)).not.toContain('Juniper')
    expect(lines.join('\n')).not.toContain('chunkLevels')
    expect(lines.join('\n')).not.toContain('level=')
    stream.deleteSession('levels_private_01')
  })

  it('a restart restores the levels from the session file and keeps adding to them', async () => {
    await boot(dir => {
      mkdirSync(join(dir, 'active-sessions'), { recursive: true })
      const chunksIndexed = [{ i: 0, c: { text: 'Fern booked the van', speaker: 'MU', elapsed: 6000, similarity: 0.8 } }]
      writeFileSync(join(dir, 'active-sessions', 'levels_restore_01.json'), JSON.stringify({
        sessionId: 'levels_restore_01', startTime: Date.now() - 60_000, lastActivityAt: Date.now() - 1_000, title: '',
        chunks: chunksIndexed.map(e => e.c), chunksIndexed, receivedIndices: [0, 1], asrCompletedIndices: [0, 1],
        emptyCompletions: { 1: { text: '', speaker: 'MU', elapsed: 12000 } }, maxChunkIndex: 1, providerCandidates: {},
        chunkLevels: [{ i: 0, level: 0.6, speechSec: 4.1 }, { i: 1, level: 0.1, speechSec: 0 }, { i: 'x', level: 2, speechSec: 'loud' }],
      }))
    })
    await chunk('levels_restore_01', 2, 2000)
    expect(sessionFile('levels_restore_01').chunkLevels).toEqual([
      { i: 0, level: 0.6, speechSec: 4.1 },
      { i: 1, level: 0.1, speechSec: 0 },
      { i: 2, level: 0.714, speechSec: 3.2 },
    ])
    stream.deleteSession('levels_restore_01')
  })

  it(`a long meeting keeps only the newest ${CHUNK_LEVELS_LIMIT} chunks`, async () => {
    await boot()
    speechSeconds = 0                                           // all quiet: the cheap path
    asrText = ''
    for (let i = 0; i < CHUNK_LEVELS_LIMIT + 3; i++) await chunk('levels_bound_01', i, 60)
    const levels = sessionFile('levels_bound_01').chunkLevels
    expect(levels).toHaveLength(CHUNK_LEVELS_LIMIT)
    expect(levels[0].i).toBe(3)
    expect(levels.at(-1).i).toBe(CHUNK_LEVELS_LIMIT + 2)
    stream.deleteSession('levels_bound_01')
  }, 60_000)
})
