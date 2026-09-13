// 6.45.4 — the held-voice routes, driven end to end over a real data dir: real
// ext-audio wavs, the real chunk-embedding bank, the real cache. Only the ONNX
// extractor and the profile store are stood in for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DIM = 192
let dataDir = ''
let server: Server | null = null
let baseUrl = ''
let extractCalls: number[] = []
let enrollCalls: Array<{ name: string; source: string; skipDedup: boolean }> = []
let profiles: Array<{ name: string; embeddings: number[][]; sources: string[] }> = []

/** A wav is 48 bytes of one fill byte; the fill byte IS the voice axis, so a
 *  fallback extraction produces a vector on that axis. */
function wavFor(axis: number): Buffer { return Buffer.alloc(48, axis) }
function vec(axis: number, wobbleAxis: number, wobble = 0.15): Float32Array {
  const v = new Float32Array(DIM); v[axis] = 1; v[wobbleAxis] = wobble; return v
}
function wavPath(sessionId: string, chunk: number): string {
  const dir = join(dataDir, 'ext-audio', sessionId)
  return join(dir, readdirSync(dir).find(f => f.startsWith(`ext_chunk${chunk}_`)) ?? `ext_chunk${chunk}_missing.wav`)
}

function seedWav(sessionId: string, chunk: number, axis: number): void {
  const dir = join(dataDir, 'ext-audio', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `ext_chunk${chunk}_${1000 + chunk}.wav`), wavFor(axis))
}

async function seedBank(sessionId: string, chunk: number, axis: number, wobbleAxis: number): Promise<void> {
  const { appendChunkEmbedding } = await import('../lib/chunk-embedding-store.js')
  expect(appendChunkEmbedding(sessionId, { i: chunk, speaker: 'Ext', similarity: 0, embedding: vec(axis, wobbleAxis) })).toBe(true)
}

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU', getVocabulary: () => [], getOwnerName: () => 'Miles', getTranscriptionProfileStatus: () => ({}),
  }))
  vi.doMock('../lib/speaker-embeddings.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/speaker-embeddings.js')>()
    return {
      ...real,
      extractEmbedding: (buf: Buffer) => {
        const axis = buf[0]
        extractCalls.push(axis)
        // axis 255 stands for audio the model cannot embed at all
        return axis === 255 ? null : vec(axis, 150 + (extractCalls.length % 40))
      },
      enrollEmbedding: (name: string, emb: Float32Array, source: string, skipDedup: boolean) => {
        enrollCalls.push({ name, source, skipDedup })
        let p = profiles.find(x => x.name === name)
        if (!p) { p = { name, embeddings: [], sources: [] }; profiles.push(p) }
        p.embeddings.push(Array.from(emb)); p.sources.push(source)
        return { success: true, dim: DIM }
      },
      readVoiceProfiles: () => ({ profiles: profiles.map(p => ({ ...p, sources: [...p.sources] })) }),
      getEmbeddingCount: (name: string) => profiles.find(p => p.name === name)?.embeddings.length ?? 0,
    }
  })
  vi.doMock('../lib/voice-directory.js', () => ({ getVoiceDirectorySnapshot: async () => ({}), invalidateVoiceDirectory: () => {} }))
  const { voiceRouter } = await import('./voice.js')
  const app = express()
  app.use(express.json())
  app.use('/api', voiceRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const a = server!.address()
      if (!a || typeof a === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${a.port}`
      resolve()
    })
  })
}

function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, res => {
      const parts: Buffer[] = []
      res.on('data', c => parts.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(parts).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cos-held-groups-'))
  process.env.COS_DATA_DIR = dataDir
  extractCalls = []
  enrollCalls = []
  profiles = []
})
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  const { __resetHeldEmbeddingSweepForTests } = await import('../lib/held-voice-groups.js')
  __resetHeldEmbeddingSweepForTests()
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
  vi.doUnmock('../lib/profile.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
  vi.doUnmock('../lib/voice-directory.js')
  vi.resetModules()
})

/** Voice 0 in three meetings, voice 1 in two, one artifact — all banked. */
async function seedCrowd(): Promise<void> {
  seedWav('meeting_a', 0, 0); seedWav('meeting_a', 3, 0); seedWav('meeting_a', 7, 1)
  seedWav('meeting_b', 1, 0); seedWav('meeting_b', 2, 1); seedWav('meeting_b', 30, 100)
  seedWav('meeting_c', 0, 0)
  await seedBank('meeting_a', 0, 0, 20); await seedBank('meeting_a', 3, 0, 21); await seedBank('meeting_a', 7, 1, 22)
  await seedBank('meeting_b', 1, 0, 23); await seedBank('meeting_b', 2, 1, 24); await seedBank('meeting_b', 30, 100, 101)
  await seedBank('meeting_c', 0, 0, 26)
}

describe('GET /api/voice/held-groups', () => {
  it('groups banked samples across meetings and decodes no audio when the bank has them all', async () => {
    await seedCrowd()
    await startServer()
    const { status, json } = await call('GET', '/api/voice/held-groups')
    expect(status).toBe(200)
    expect(json).toMatchObject({ sessions: 3, samples: 7, embedded: 7, pending: 0, unusable: 0 })
    expect(json.groups.map((g: any) => g.sampleCount)).toEqual([4, 2])
    expect(json.groups[0].sessions).toEqual(['meeting_a', 'meeting_b', 'meeting_c'])
    expect(json.loose).toEqual([{ sessionId: 'meeting_b', chunkIndex: 30 }])
    expect(extractCalls).toEqual([])
  })

  it('answers an empty window honestly', async () => {
    await startServer()
    const { status, json } = await call('GET', '/api/voice/held-groups')
    expect(status).toBe(200)
    expect(json).toMatchObject({ groups: [], loose: [], sessions: 0, samples: 0, embedded: 0, pending: 0 })
  })

  it('decodes a sample the bank does not hold, once, and remembers it in the cache', async () => {
    seedWav('meeting_old', 0, 4); seedWav('meeting_old', 1, 4); seedWav('meeting_old', 2, 255)
    await startServer()
    const first = await call('GET', '/api/voice/held-groups')
    expect(first.json).toMatchObject({ samples: 3, embedded: 2, unusable: 1, pending: 0 })
    expect(first.json.groups).toHaveLength(1)
    expect(extractCalls).toEqual([4, 4, 255])
    expect(existsSync(join(dataDir, 'held-voice-embeddings', 'meeting_old.json'))).toBe(true)
    const second = await call('GET', '/api/voice/held-groups')
    expect(second.json).toMatchObject({ samples: 3, embedded: 2 })
    // The two that decoded are cached; the one the model could not embed is
    // retried, because "null" also means "model not loaded yet".
    expect(extractCalls).toEqual([4, 4, 255, 255])
  })
})

describe('the decode budget', () => {
  it('reports what it could not afford as pending and the sweep finishes it', async () => {
    process.env.COS_DATA_DIR = dataDir
    for (let i = 0; i < 6; i++) seedWav('meeting_slow', i, 4)
    vi.resetModules()
    let calls = 0
    vi.doMock('../lib/speaker-embeddings.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../lib/speaker-embeddings.js')>()),
      extractEmbedding: () => { calls++; return vec(4, 150 + calls) },
      readVoiceProfiles: () => ({ profiles: [] }),
    }))
    const lib = await import('../lib/held-voice-groups.js')
    // A clock that jumps 400 ms per read: with a 1000 ms budget, only the first
    // couple of decodes fit before the deadline is seen.
    let t = 0
    const collected = lib.collectHeldSamples({ budgetMs: 1000, now: () => (t += 400) })
    expect(collected.pending.length).toBeGreaterThan(0)
    expect(collected.samples.length + collected.pending.length).toBe(6)
    const before = calls
    const rest = lib.collectHeldSamples({ budgetMs: Infinity })
    expect(rest.pending).toEqual([])
    expect(rest.samples).toHaveLength(6)
    // Only the ones that were pending were decoded now; the rest came from cache.
    expect(calls - before).toBe(collected.pending.length)
    lib.__resetHeldEmbeddingSweepForTests()
  })
})

describe('POST /api/voice/held-groups/enroll', () => {
  it('writes only the coherent core, appends to an existing profile, and leaves the odd sample held', async () => {
    await seedCrowd()
    profiles = [{ name: 'Chris', embeddings: [Array.from(vec(0, 5, 0.75))], sources: ['manual'] }]
    await startServer()
    // Voice 0's four samples plus one of voice 1, submitted as if they were one group.
    const members = [
      { sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 3 },
      { sessionId: 'meeting_b', chunkIndex: 1 }, { sessionId: 'meeting_c', chunkIndex: 0 },
      { sessionId: 'meeting_a', chunkIndex: 7 },
    ]
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members })
    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, speaker: 'Chris', created: false, submitted: 5, resolved: 5, coherent: 4, enrolled: 4, deleted: 4, profileEmbeddings: 5 })
    expect(json.leftBehind).toEqual([{ sessionId: 'meeting_a', chunkIndex: 7 }])
    expect(json.message).toContain('Added to Chris from 4 of 5 samples')
    expect(enrollCalls).toHaveLength(4)
    expect(enrollCalls.every(c => c.name === 'Chris' && c.source === 'ext-group')).toBe(true)
    // The core's wavs are gone; the left-behind one and the untouched voice-1 sample remain.
    expect(existsSync(wavPath('meeting_a', 0))).toBe(false)
    expect(existsSync(wavPath('meeting_c', 0))).toBe(false)
    expect(existsSync(wavPath('meeting_a', 7))).toBe(true)
    expect(existsSync(wavPath('meeting_b', 2))).toBe(true)
    // Nothing that was not in the request was touched.
    expect(existsSync(wavPath('meeting_b', 30))).toBe(true)
  })

  it('creates a new profile from one sample — naming sample by sample is allowed', async () => {
    await seedCrowd()
    await startServer()
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Queen', members: [{ sessionId: 'meeting_b', chunkIndex: 30 }] })
    expect(status).toBe(200)
    expect(json).toMatchObject({ created: true, coherent: 1, enrolled: 1, deleted: 1, leftBehind: [] })
    expect(json.message).toBe('Created Queen from 1 sample.')
    expect(existsSync(wavPath('meeting_b', 30))).toBe(false)
  })

  it('counts a member once however many times it is listed, and reports the ones not held', async () => {
    await seedCrowd()
    await startServer()
    const members = [
      { sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: '0' },
      { sessionId: 'meeting_zzz', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 99 },
    ]
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members })
    expect(status).toBe(200)
    expect(json).toMatchObject({ submitted: 3, resolved: 1, coherent: 1, enrolled: 1, deleted: 1 })
    expect(json.missing).toEqual([{ sessionId: 'meeting_a', chunkIndex: 99 }, { sessionId: 'meeting_zzz', chunkIndex: 0 }])
    expect(enrollCalls).toHaveLength(1)
    const discard = await call('POST', '/api/voice/held-groups/discard', {
      members: [{ sessionId: 'meeting_b', chunkIndex: 30 }, { sessionId: 'meeting_b', chunkIndex: 30 }],
    })
    expect(discard.json).toMatchObject({ removed: 1, missing: [] })
  })

  it('refuses a set that does not sound like one person and deletes nothing', async () => {
    await seedCrowd()
    await startServer()
    const members = [{ sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 7 }, { sessionId: 'meeting_b', chunkIndex: 30 }]
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Nobody', members })
    expect(status).toBe(409)
    expect(json).toMatchObject({ success: false, reason: 'incoherent', submitted: 3, resolved: 3 })
    expect(enrollCalls).toEqual([])
    expect(existsSync(wavPath('meeting_a', 0))).toBe(true)
    expect(existsSync(wavPath('meeting_a', 7))).toBe(true)
    expect(existsSync(wavPath('meeting_b', 30))).toBe(true)
  })

  it('rejects a sentence for a name and a malformed member list before touching anything', async () => {
    await seedCrowd()
    await startServer()
    const sentence = await call('POST', '/api/voice/held-groups/enroll', { name: 'I think this is the guy from accounting', members: [{ sessionId: 'meeting_a', chunkIndex: 0 }] })
    expect(sentence.status).toBe(400)
    expect(sentence.json.success).toBe(false)
    const bad = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members: [{ sessionId: '../etc', chunkIndex: 0 }] })
    expect(bad.status).toBe(400)
    expect(bad.json.reason).toBe('invalid_members')
    const none = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members: [{ sessionId: 'meeting_zzz', chunkIndex: 0 }] })
    expect(none.status).toBe(404)
    expect(none.json.reason).toBe('no_samples')
    expect(enrollCalls).toEqual([])
    expect(existsSync(wavPath('meeting_a', 0))).toBe(true)
  })
})

describe('POST /api/voice/held-groups/discard', () => {
  it('removes exactly the named samples and reports the ones that were not there', async () => {
    await seedCrowd()
    await startServer()
    const { status, json } = await call('POST', '/api/voice/held-groups/discard', {
      members: [{ sessionId: 'meeting_b', chunkIndex: 30 }, { sessionId: 'meeting_b', chunkIndex: 31 }],
    })
    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, removed: 1, missing: [{ sessionId: 'meeting_b', chunkIndex: 31 }] })
    expect(existsSync(wavPath('meeting_b', 30))).toBe(false)
    expect(existsSync(wavPath('meeting_b', 1))).toBe(true)
    const after = await call('GET', '/api/voice/held-groups')
    expect(after.json.loose).toEqual([])
    expect(after.json.samples).toBe(6)
  })
})
