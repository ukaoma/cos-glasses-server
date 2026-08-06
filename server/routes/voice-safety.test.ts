// Voice route safety contract — the reader path and the two destructive gates.
//
// Executed against a real express server with real files on disk. The speaker
// engine is faked (sherpa-onnx + a 26 MB model are not test dependencies) but
// every path, gate, and delete decision below is the production code.
//
// What this file exists to prevent:
//  1. The reader/writer path split. voice.ts resolved training-audio inside the
//     installed package while transcribe-stream.ts wrote it to the data home, so
//     every one of these endpoints reported an empty system while real audio
//     accumulated. A test that only checked "returns 200" passed throughout.
//  2. An unconfirmed all-speakers train-g2. With the path fixed, that call
//     rewrites every profile and deletes the source WAVs — and enrolling 30
//     samples into a cap-20 profile evicts every pre-existing embedding.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dataDir = ''
let server: Server | null = null
let baseUrl = ''
let enrollCalls: Array<{ name: string; source: string }> = []
let profiles: Array<{ name: string; embeddings: number[][]; sources: string[] }> = []
let removedNames: string[] = []

function trainingDir(speaker: string): string {
  return join(dataDir, 'training-audio', speaker.replace(/\s+/g, '_'))
}

/** A minimal but REAL 16-bit PCM WAV, long enough to look like a chunk. */
function writeWav(dir: string, name: string, seed: number, mtimeMs?: number): string {
  mkdirSync(dir, { recursive: true })
  const samples = 16000
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin(i / (8 + seed)) * 8000), 44 + i * 2)
  const path = join(dir, name)
  writeFileSync(path, buf)
  if (mtimeMs !== undefined) require('node:fs').utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  return path
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d > 0 ? dot / d : 0
}

async function startServer(opts: { extractionFails?: boolean } = {}): Promise<void> {
  vi.resetModules()
  enrollCalls = []
  removedNames = []
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    // Distinct embedding per file so greedy diversity selection has something
    // real to work with.
    extractEmbedding: (buf: Buffer) => {
      if (opts.extractionFails) return null
      const seed = buf.length > 100 ? buf.readInt16LE(2000) : 1
      return new Float32Array([seed / 8000, 1 - seed / 8000, 0.5, Math.abs(seed) / 16000])
    },
    enrollEmbedding: (name: string, _e: Float32Array, source: string) => {
      enrollCalls.push({ name, source })
      return { success: true, dim: 4 }
    },
    getEmbeddingCount: (name: string) => profiles.find(p => p.name === name)?.embeddings.length ?? 0,
    readVoiceProfiles: () => ({ profiles: profiles.map(p => ({ ...p, sources: [...p.sources] })) }),
    removeSpeakerProfile: (name: string) => {
      removedNames.push(name)
      const found = profiles.find(p => p.name === name)
      profiles = profiles.filter(p => p.name !== name)
      return { removedProfiles: found ? 1 : 0, removedEmbeddings: found?.embeddings.length ?? 0 }
    },
    rawCosineSimilarity: cosine,
    enrollSpeaker: () => ({ success: true, dim: 4 }),
    isEnrolled: () => true,
    getAllSpeakerNames: () => profiles.map(p => p.name),
    identifySpeaker: () => null,
  }))
  vi.doMock('../lib/speaker-trainer.js', () => ({
    trainFromFireflies: async () => ({ trained: 0 }),
    getTrainingStatus: async () => ({ speakers: [] }),
  }))
  vi.doMock('../lib/profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU' }))

  const { voiceRouter } = await import('./voice.js')
  const app = express()
  app.use(express.json())
  app.use('/api', voiceRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (!address || typeof address === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
}

function httpRequest(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: payload
        ? { 'Content-Length': String(payload.length), 'Content-Type': 'application/json' }
        : {},
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    if (payload) req.end(payload); else req.end()
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cos-voice-routes-'))
  process.env.COS_DATA_DIR = dataDir
  profiles = [
    { name: 'MU', embeddings: Array.from({ length: 20 }, () => [1, 0, 0, 0]), sources: Array(20).fill('manual') },
    { name: 'Clem Ukaoma', embeddings: Array.from({ length: 14 }, () => [0, 1, 0, 0]), sources: Array(14).fill('fireflies') },
  ]
})

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/speaker-embeddings.js')
  vi.doUnmock('../lib/speaker-trainer.js')
  vi.doUnmock('../lib/profile.js')
  delete process.env.COS_DATA_DIR
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('the reader path reaches the data home, where the writer actually saves', () => {
  it('sees training audio written under COS_DATA_DIR', async () => {
    // transcribe-stream.ts writes exactly here. voice.ts used to look inside the
    // installed package instead, so this returned { speakers: [] } forever.
    writeWav(trainingDir('Clem Ukaoma'), 'chunk1.wav', 1)
    writeWav(trainingDir('Clem Ukaoma'), 'chunk2.wav', 2)
    await startServer()

    const res = await httpRequest('GET', '/api/voice/saved-audio')
    expect(res.status).toBe(200)
    expect(res.json.speakers).toEqual([
      { name: 'Clem Ukaoma', chunks: 2, currentEmbeddings: 14 },
    ])
  })

  it('sees ext-audio written under COS_DATA_DIR', async () => {
    writeWav(join(dataDir, 'ext-audio', 'sess-abc'), 'c1.wav', 3)
    await startServer()
    const res = await httpRequest('GET', '/api/voice/ext-audio')
    expect(res.json.totalChunks).toBe(1)
    expect(res.json.sessions[0].sessionId).toBe('sess-abc')
  })
})

describe('train-g2 fails closed on the unscoped form', () => {
  it('returns 400 with an inventory and changes NOTHING', async () => {
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    writeWav(trainingDir('Nate Williams'), 'c1.wav', 2)
    await startServer()

    const res = await httpRequest('POST', '/api/voice/train-g2', {})
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('confirmation required')
    expect(res.json.totalSpeakers).toBe(2)
    expect(res.json.wouldTrain).toEqual(expect.arrayContaining([
      { speaker: 'Clem Ukaoma', chunks: 1, currentEmbeddings: 14 },
    ]))
    // The two things that make this endpoint dangerous, both verified absent.
    expect(enrollCalls).toEqual([])
    expect(existsSync(join(trainingDir('Clem Ukaoma'), 'c1.wav'))).toBe(true)
  })

  it('proceeds when confirmAllSpeakers is passed', async () => {
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    await startServer()
    const res = await httpRequest('POST', '/api/voice/train-g2', { confirmAllSpeakers: true })
    expect(res.status).toBe(200)
    expect(res.json.trained).toBe(1)
    expect(enrollCalls).toEqual([{ name: 'Clem Ukaoma', source: 'g2-training' }])
    expect(existsSync(trainingDir('Clem Ukaoma'))).toBe(false)   // cleaned up
  })

  it('a scoped call needs no confirmation and touches only that speaker', async () => {
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    writeWav(trainingDir('Nate Williams'), 'c1.wav', 2)
    await startServer()

    const res = await httpRequest('POST', '/api/voice/train-g2', { speaker: 'Clem Ukaoma' })
    expect(res.status).toBe(200)
    expect(enrollCalls.map(c => c.name)).toEqual(['Clem Ukaoma'])
    expect(existsSync(join(trainingDir('Nate Williams'), 'c1.wav'))).toBe(true)
  })

  it('404s a scoped call for a speaker with no saved audio', async () => {
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    await startServer()
    const res = await httpRequest('POST', '/api/voice/train-g2', { speaker: 'Nobody Here' })
    expect(res.status).toBe(404)
    expect(enrollCalls).toEqual([])
  })

  it('rejects a speaker name that tries to escape the audio root', async () => {
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    await startServer()
    for (const speaker of ['../..', 'a/../../etc', '..']) {
      const res = await httpRequest('POST', '/api/voice/train-g2', { speaker })
      expect([400, 404]).toContain(res.status)
    }
    expect(enrollCalls).toEqual([])
  })
})

describe('train-g2 cannot evict an existing profile by volume', () => {
  it('caps enrollment well below the 20-embedding FIFO limit', async () => {
    // 30 saved chunks x enroll = 30 evictions from a cap-20 profile, i.e. every
    // pre-existing embedding replaced by one meeting's audio.
    for (let i = 0; i < 30; i++) writeWav(trainingDir('Clem Ukaoma'), `c${i}.wav`, i)
    await startServer()

    const res = await httpRequest('POST', '/api/voice/train-g2', { confirmAllSpeakers: true })
    expect(res.json.speakers[0].chunks).toBe(30)
    expect(res.json.speakers[0].embeddingsExtracted).toBe(30)
    expect(enrollCalls.length).toBe(10)          // the default cap
    expect(enrollCalls.length).toBeLessThan(20)  // strictly under the FIFO cap
  })

  it('honours an explicit maxPerSpeaker and clamps it to the FIFO cap', async () => {
    for (let i = 0; i < 30; i++) writeWav(trainingDir('Clem Ukaoma'), `c${i}.wav`, i)
    await startServer()
    await httpRequest('POST', '/api/voice/train-g2', { confirmAllSpeakers: true, maxPerSpeaker: 999 })
    expect(enrollCalls.length).toBe(20)
  })
})

describe('train-g2 dry run and the empty-extraction case', () => {
  it('dryRun reports what would happen and deletes nothing', async () => {
    for (let i = 0; i < 5; i++) writeWav(trainingDir('Clem Ukaoma'), `c${i}.wav`, i)
    await startServer()

    const res = await httpRequest('POST', '/api/voice/train-g2', { dryRun: true })
    expect(res.status).toBe(200)
    expect(res.json.dryRun).toBe(true)
    expect(res.json.trained).toBe(0)
    expect(res.json.speakers[0].selected).toBe(5)
    expect(enrollCalls).toEqual([])
    expect(readdirSync(trainingDir('Clem Ukaoma'))).toHaveLength(5)
  })

  it('RETAINS the audio when nothing could be enrolled', async () => {
    // Deleting the source after enrolling zero embeddings is pure data loss —
    // the original code unlinked unconditionally.
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    await startServer({ extractionFails: true })

    const res = await httpRequest('POST', '/api/voice/train-g2', { confirmAllSpeakers: true })
    expect(res.json.trained).toBe(0)
    expect(res.json.speakers[0].audioRetained).toBe(true)
    expect(existsSync(join(trainingDir('Clem Ukaoma'), 'c1.wav'))).toBe(true)
  })
})

describe('enroll-ext fails closed across sessions', () => {
  it('refuses to attribute every session to one person without confirmation', async () => {
    writeWav(join(dataDir, 'ext-audio', 's1'), 'c1.wav', 1)
    writeWav(join(dataDir, 'ext-audio', 's2'), 'c1.wav', 2)
    await startServer()

    const res = await httpRequest('POST', '/api/voice/enroll-ext', { name: 'Chuks' })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('confirmation required')
    expect(res.json.totalSessions).toBe(2)
    expect(enrollCalls).toEqual([])
    expect(existsSync(join(dataDir, 'ext-audio', 's1', 'c1.wav'))).toBe(true)
  })

  it('a scoped sessionId needs no confirmation', async () => {
    writeWav(join(dataDir, 'ext-audio', 's1'), 'c1.wav', 1)
    writeWav(join(dataDir, 'ext-audio', 's2'), 'c1.wav', 2)
    await startServer()

    const res = await httpRequest('POST', '/api/voice/enroll-ext', { name: 'Chuks', sessionId: 's1' })
    expect(res.status).toBe(200)
    expect(enrollCalls.map(c => c.name)).toEqual(['Chuks'])
    expect(existsSync(join(dataDir, 'ext-audio', 's1'))).toBe(false)
    expect(existsSync(join(dataDir, 'ext-audio', 's2', 'c1.wav'))).toBe(true)
  })

  it('proceeds with confirmAllSessions', async () => {
    writeWav(join(dataDir, 'ext-audio', 's1'), 'c1.wav', 1)
    writeWav(join(dataDir, 'ext-audio', 's2'), 'c1.wav', 2)
    await startServer()
    const res = await httpRequest('POST', '/api/voice/enroll-ext', { name: 'Chuks', confirmAllSessions: true })
    expect(res.status).toBe(200)
    expect(res.json.totalChunks).toBe(2)
  })
})

describe('delete-person is confirmed and auditable', () => {
  it('refuses without confirm and reports what would go', async () => {
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    writeFileSync(join(dataDir, 'speaker-calibration.jsonl'),
      [
        JSON.stringify({ ts: 't1', speaker: 'Clem Ukaoma', similarity: 0.6, matched: true }),
        JSON.stringify({ ts: 't2', speaker: 'MU', similarity: 0.9, matched: true }),
        JSON.stringify({ ts: 't3', speaker: 'Clem Ukaoma', similarity: 0.58, matched: true }),
      ].join('\n') + '\n')
    await startServer()

    const res = await httpRequest('POST', '/api/voice/delete-person', { name: 'Clem Ukaoma' })
    expect(res.status).toBe(400)
    expect(res.json.wouldRemove).toEqual({
      profile: 1, embeddings: 14, trainingAudioFiles: 1, calibrationRows: 2,
    })
    // Nothing removed on the refusal path.
    expect(removedNames).toEqual([])
    expect(existsSync(join(trainingDir('Clem Ukaoma'), 'c1.wav'))).toBe(true)
    expect(readFileSync(join(dataDir, 'speaker-calibration.jsonl'), 'utf-8')).toContain('Clem Ukaoma')
  })

  it('sweeps every attributable store and returns per-store counts', async () => {
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    writeWav(trainingDir('Clem Ukaoma'), 'c2.wav', 2)
    writeFileSync(join(dataDir, 'speaker-calibration.jsonl'),
      [
        JSON.stringify({ ts: 't1', speaker: 'Clem Ukaoma', similarity: 0.6, matched: true }),
        JSON.stringify({ ts: 't2', speaker: 'MU', similarity: 0.9, matched: true }),
      ].join('\n') + '\n')
    await startServer()

    const res = await httpRequest('POST', '/api/voice/delete-person', { name: 'Clem Ukaoma', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.removed).toEqual({
      profiles: 1, embeddings: 14, trainingAudioFiles: 2, calibrationRows: 1,
    })
    expect(removedNames).toEqual(['Clem Ukaoma'])
    expect(existsSync(trainingDir('Clem Ukaoma'))).toBe(false)
    const log = readFileSync(join(dataDir, 'speaker-calibration.jsonl'), 'utf-8')
    expect(log).not.toContain('Clem Ukaoma')
    expect(log).toContain('MU')       // the other person's rows survive
    // Names the stores it CANNOT attribute, rather than implying a full sweep.
    expect(res.json.notAttributable).toHaveProperty('extAudio')
  })

  it('rejects a too-short name', async () => {
    await startServer()
    const res = await httpRequest('POST', '/api/voice/delete-person', { name: 'x', confirm: true })
    expect(res.status).toBe(400)
    expect(removedNames).toEqual([])
  })
})

describe('/voice/profiles exposes the store for review', () => {
  it('lists people, counts, provenance, and alignment', async () => {
    profiles[1].sources = ['fireflies', 'auto:s1', 'auto:s2', ...Array(11).fill('manual')]
    await startServer()

    const res = await httpRequest('GET', '/api/voice/profiles')
    expect(res.status).toBe(200)
    expect(res.json.owner).toBe('MU')
    expect(res.json.count).toBe(2)
    expect(res.json.totalEmbeddings).toBe(34)
    const clem = res.json.profiles.find((p: any) => p.name === 'Clem Ukaoma')
    // auto:<sessionId> collapses to one bucket — a poisoned session is visible
    // without publishing session ids.
    expect(clem.sources).toEqual({ fireflies: 1, auto: 2, manual: 11 })
    expect(clem.sourcesAligned).toBe(true)
    expect(res.json.profiles[0].name).toBe('MU')    // sorted by sample count
  })

  it('flags a misaligned sources[] instead of hiding it', async () => {
    profiles[1].sources = ['fireflies']
    await startServer()
    const res = await httpRequest('GET', '/api/voice/profiles')
    expect(res.json.profiles.find((p: any) => p.name === 'Clem Ukaoma').sourcesAligned).toBe(false)
  })
})
