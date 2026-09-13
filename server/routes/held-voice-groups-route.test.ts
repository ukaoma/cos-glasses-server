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
let enrollSucceeds = true
let modelAvailable = true
let profiles: Array<{ name: string; embeddings: number[][]; sources: string[] }> = []

/** A wav is 48 bytes of one fill byte; the fill byte IS the voice axis, so a
 *  fallback extraction produces a vector on that axis. */
function wavFor(axis: number): Buffer { return Buffer.alloc(48, axis) }
function vec(axis: number, wobbleAxis: number, wobble = 0.15): Float32Array {
  const v = new Float32Array(DIM); v[axis] = 1; v[wobbleAxis] = wobble; return v
}
function wavPath(sessionId: string, chunk: number): string {
  const dir = join(dataDir, 'ext-audio', sessionId)
  if (!existsSync(dir)) return join(dir, `ext_chunk${chunk}_missing.wav`)
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

function mockSpeakerEmbeddings(): void {
  vi.doMock('../lib/speaker-embeddings.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/speaker-embeddings.js')>()
    return {
      ...real,
      isEmbeddingAvailable: () => modelAvailable,
      extractEmbedding: (buf: Buffer) => {
        const axis = buf[0]
        extractCalls.push(axis)
        // axis 255 stands for audio the model cannot embed at all
        return axis === 255 ? null : vec(axis, 150 + (extractCalls.length % 40))
      },
      enrollEmbedding: (name: string, emb: Float32Array, source: string, skipDedup: boolean) => {
        enrollCalls.push({ name, source, skipDedup })
        if (!enrollSucceeds) return { success: false, dim: DIM, error: 'refused' }
        let p = profiles.find(x => x.name === name)
        if (!p) { p = { name, embeddings: [], sources: [] }; profiles.push(p) }
        p.embeddings.push(Array.from(emb)); p.sources.push(source)
        return { success: true, dim: DIM }
      },
      readVoiceProfiles: () => ({ profiles: profiles.map(p => ({ ...p, sources: [...p.sources] })) }),
      getEmbeddingCount: (name: string) => profiles.find(p => p.name === name)?.embeddings.length ?? 0,
    }
  })
}

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU', getVocabulary: () => [], getOwnerName: () => 'Miles', getTranscriptionProfileStatus: () => ({}),
  }))
  mockSpeakerEmbeddings()
  vi.doMock('../lib/voice-directory.js', () => ({ getVoiceDirectorySnapshot: async () => ({}), invalidateVoiceDirectory: () => {} }))
  const { voiceRouter } = await import('./voice.js')
  const app = express()
  app.use(express.json({ limit: '2mb' }))
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
  enrollSucceeds = true
  modelAvailable = true
  profiles = []
})
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  const { __resetHeldEmbeddingSweepForTests } = await import('../lib/held-voice-groups.js')
  __resetHeldEmbeddingSweepForTests()
  vi.useRealTimers()
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
const VOICE0 = [
  { sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 3 },
  { sessionId: 'meeting_b', chunkIndex: 1 }, { sessionId: 'meeting_c', chunkIndex: 0 },
]

describe('GET /api/voice/held-groups', () => {
  it('groups banked samples across meetings and decodes no audio when the bank has them all', async () => {
    await seedCrowd()
    await startServer()
    const { status, json } = await call('GET', '/api/voice/held-groups')
    expect(status).toBe(200)
    expect(json).toMatchObject({ sessions: 3, samples: 7, embedded: 7, pending: 0, unusable: 0, speakerModel: true })
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
    seedWav('meeting_old', 5, 4)  // a new wav changes the fingerprint, so the memo is not served
    const second = await call('GET', '/api/voice/held-groups')
    expect(second.json).toMatchObject({ samples: 4, embedded: 3, unusable: 1 })
    // Two decoded samples and the refusal are cached; only the new wav decodes.
    expect(extractCalls).toEqual([4, 4, 255, 4])
  })

  it('with the speaker model not loaded, unbanked samples are pending (not unusable), nothing decodes, and the sweep does not arm', async () => {
    modelAvailable = false
    seedWav('meeting_old', 0, 4); seedWav('meeting_old', 1, 4)
    seedWav('meeting_a', 0, 0); await seedBank('meeting_a', 0, 0, 20)
    await startServer()
    const { json } = await call('GET', '/api/voice/held-groups')
    expect(json).toMatchObject({ samples: 3, embedded: 1, pending: 2, unusable: 0, speakerModel: false })
    expect(extractCalls).toEqual([])
    const { __heldSweepArmedForTests } = await import('../lib/held-voice-groups.js')
    expect(__heldSweepArmedForTests()).toBe(false)
  })

  it('memoises an unchanged window briefly and forgets it after a discard', async () => {
    await seedCrowd()
    await startServer()
    const a = await call('GET', '/api/voice/held-groups')
    const b = await call('GET', '/api/voice/held-groups')
    expect(b.json.generatedAt).toBe(a.json.generatedAt)
    await call('POST', '/api/voice/held-groups/discard', { members: [{ sessionId: 'meeting_b', chunkIndex: 30 }], confirm: true })
    const c = await call('GET', '/api/voice/held-groups')
    expect(c.json.samples).toBe(6)
    expect(c.json.loose).toEqual([])
  })
})

describe('the decode budget and the sweep', () => {
  it('reports what it could not afford as pending; a tick finishes it; a stalled tick reports no progress', async () => {
    for (let i = 0; i < 6; i++) seedWav('meeting_slow', i, 4)
    await startServer()
    const lib = await import('../lib/held-voice-groups.js')
    // A clock that jumps 400 ms per read: with a 1000 ms budget, only the first
    // couple of decodes fit before the deadline is seen.
    let t = 0
    const collected = lib.collectHeldSamples({ budgetMs: lib.HELD_EXTRACTION_BUDGET_MS, now: () => (t += 400) })
    expect(collected.pending.length).toBeGreaterThan(0)
    expect(collected.samples.length + collected.pending.length).toBe(6)
    const before = extractCalls.length
    const stalled = lib.runHeldEmbeddingSweepTick(0)   // no budget: nothing decodes
    expect(stalled).toEqual({ pending: collected.pending.length, progressed: true })  // first reading
    expect(lib.runHeldEmbeddingSweepTick(0).progressed).toBe(false)  // still the same count: no progress
    const done = lib.runHeldEmbeddingSweepTick(Infinity)
    expect(done).toEqual({ pending: 0, progressed: true })
    expect(extractCalls.length - before).toBe(collected.pending.length)
  })

  it('the scheduled sweep runs off the request path and disarms when nothing is pending', async () => {
    for (let i = 0; i < 4; i++) seedWav('meeting_slow', i, 4)
    await startServer()
    const lib = await import('../lib/held-voice-groups.js')
    vi.useFakeTimers()
    let t = 0
    lib.collectHeldSamples({ budgetMs: 0, now: () => (t += 1) })
    expect(extractCalls).toEqual([])
    lib.scheduleHeldEmbeddingSweep()
    expect(lib.__heldSweepArmedForTests()).toBe(true)
    await vi.advanceTimersByTimeAsync(lib.SWEEP_GAP_MS + 5)
    expect(extractCalls).toHaveLength(4)
    expect(lib.__heldSweepArmedForTests()).toBe(false)
  })
})

describe('POST /api/voice/held-groups/enroll', () => {
  it('fails closed: without confirm it previews exactly what would change and touches nothing', async () => {
    await seedCrowd()
    profiles = [{ name: 'Chris', embeddings: [Array.from(vec(0, 5, 0.75))], sources: ['manual'] }]
    await startServer()
    const members = [...VOICE0, { sessionId: 'meeting_a', chunkIndex: 7 }]
    const refused = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members })
    expect(refused.status).toBe(400)
    expect(refused.json).toMatchObject({ success: false, reason: 'confirmation_required' })
    expect(refused.json.preview).toMatchObject({ created: false, submitted: 5, resolved: 5, distinct: 5, coherent: 4, selected: 4, leftBehind: [{ sessionId: 'meeting_a', chunkIndex: 7 }] })
    expect(refused.json.message).toContain('Would add to Chris from 4 of 5 held samples')
    const dry = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members, dryRun: true })
    expect(dry.status).toBe(200)
    expect(dry.json).toMatchObject({ success: true, dryRun: true, enrolled: 0, deleted: 0, coherent: 4 })
    expect(enrollCalls).toEqual([])
    expect(existsSync(wavPath('meeting_a', 0))).toBe(true)
  })

  it('writes only the coherent core, appends to an existing profile, stamps each sample with its meeting, and leaves the odd sample held', async () => {
    await seedCrowd()
    profiles = [{ name: 'Chris', embeddings: [Array.from(vec(0, 5, 0.75))], sources: ['manual'] }]
    await startServer()
    const members = [...VOICE0, { sessionId: 'meeting_a', chunkIndex: 7 }]
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members, confirm: true })
    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, speaker: 'Chris', created: false, submitted: 5, resolved: 5, coherent: 4, enrolled: 4, deleted: 4, profileEmbeddings: 5, dryRun: false })
    expect(json.leftBehind).toEqual([{ sessionId: 'meeting_a', chunkIndex: 7 }])
    expect(json.message).toContain('Added to Chris from 4 of 5 samples')
    expect(enrollCalls).toHaveLength(4)
    expect(enrollCalls.every(c => c.name === 'Chris' && c.skipDedup)).toBe(true)
    expect(enrollCalls.map(c => c.source).sort()).toEqual(['ext-group:meeting_a', 'ext-group:meeting_a', 'ext-group:meeting_b', 'ext-group:meeting_c'])
    // The core's wavs are gone; the left-behind one and the untouched voice-1 sample remain.
    expect(existsSync(wavPath('meeting_a', 0))).toBe(false)
    expect(existsSync(wavPath('meeting_c', 0))).toBe(false)
    expect(existsSync(wavPath('meeting_a', 7))).toBe(true)
    expect(existsSync(wavPath('meeting_b', 2))).toBe(true)
    expect(existsSync(wavPath('meeting_b', 30))).toBe(true)
  })

  it('creates a new profile from one sample — naming sample by sample is allowed', async () => {
    await seedCrowd()
    await startServer()
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Queen', members: [{ sessionId: 'meeting_b', chunkIndex: 30 }], confirm: true })
    expect(status).toBe(200)
    expect(json).toMatchObject({ created: true, coherent: 1, enrolled: 1, deleted: 1, leftBehind: [] })
    expect(json.message).toBe('Created Queen from 1 sample.')
    expect(existsSync(wavPath('meeting_b', 30))).toBe(false)
  })

  it('folds duplicate chunks before selecting, and caps the diverse subset at the correction maximum', async () => {
    // 25 distinct chunks of one voice in one meeting, plus the first five banked
    // again under a second id (a recording started twice).
    for (let i = 0; i < 25; i++) { seedWav('meeting_long', i, 0); await seedBank('meeting_long', i, 0, 40 + i) }
    for (let i = 0; i < 5; i++) { seedWav('meeting_long_dup', i, 0); await seedBank('meeting_long_dup', i, 0, 40 + i) }
    await startServer()
    const { MAX_ENROL_PER_CORRECTION } = await import('../lib/voice-enrolment-selection.js')
    const members = [
      ...Array.from({ length: 25 }, (_, i) => ({ sessionId: 'meeting_long', chunkIndex: i })),
      ...Array.from({ length: 5 }, (_, i) => ({ sessionId: 'meeting_long_dup', chunkIndex: i })),
    ]
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Ralph', members, confirm: true })
    expect(status).toBe(200)
    expect(json).toMatchObject({ submitted: 30, resolved: 30, distinct: 25, coherent: 30, selected: MAX_ENROL_PER_CORRECTION, enrolled: MAX_ENROL_PER_CORRECTION, deleted: 30 })
    expect(enrollCalls).toHaveLength(MAX_ENROL_PER_CORRECTION)
    expect(readdirSync(join(dataDir, 'ext-audio', 'meeting_long')).filter(f => f.endsWith('.wav'))).toEqual([])
  })

  it('refuses a set that does not sound like one person and deletes nothing', async () => {
    await seedCrowd()
    await startServer()
    const members = [{ sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 7 }, { sessionId: 'meeting_b', chunkIndex: 30 }]
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Nobody', members, confirm: true })
    expect(status).toBe(409)
    expect(json).toMatchObject({ success: false, reason: 'incoherent', submitted: 3, resolved: 3 })
    expect(enrollCalls).toEqual([])
    expect(existsSync(wavPath('meeting_a', 0))).toBe(true)
    expect(existsSync(wavPath('meeting_a', 7))).toBe(true)
    expect(existsSync(wavPath('meeting_b', 30))).toBe(true)
  })

  it('with the speaker model not loaded it refuses before touching anything, and says so', async () => {
    await seedCrowd()
    modelAvailable = false
    await startServer()
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members: VOICE0, confirm: true })
    expect(status).toBe(503)
    expect(json).toMatchObject({ success: false, reason: 'speaker_model_unavailable', coherent: 4 })
    expect(enrollCalls).toEqual([])
    expect(existsSync(wavPath('meeting_a', 0))).toBe(true)
    // the preview still works without the model
    const dry = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members: VOICE0, dryRun: true })
    expect(dry.status).toBe(200)
  })

  it('when the store refuses every sample it reports failure and deletes nothing', async () => {
    await seedCrowd()
    enrollSucceeds = false
    await startServer()
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members: VOICE0, confirm: true })
    expect(status).toBe(409)
    expect(json).toMatchObject({ success: false, reason: 'nothing_enrolled' })
    expect(enrollCalls).toHaveLength(4)
    expect(existsSync(wavPath('meeting_a', 0))).toBe(true)
  })

  it('counts a member once however many times it is listed, and reports the ones not held', async () => {
    await seedCrowd()
    await startServer()
    const members = [
      { sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: '0' },
      { sessionId: 'meeting_zzz', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 99 },
    ]
    const { status, json } = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members, confirm: true })
    expect(status).toBe(200)
    expect(json).toMatchObject({ submitted: 3, resolved: 1, coherent: 1, enrolled: 1, deleted: 1 })
    expect(json.missing).toEqual([{ sessionId: 'meeting_a', chunkIndex: 99 }, { sessionId: 'meeting_zzz', chunkIndex: 0 }])
    expect(enrollCalls).toHaveLength(1)
    const discard = await call('POST', '/api/voice/held-groups/discard', {
      members: [{ sessionId: 'meeting_b', chunkIndex: 30 }, { sessionId: 'meeting_b', chunkIndex: 30 }], confirm: true,
    })
    expect(discard.json).toMatchObject({ removed: 1, missing: [] })
  })

  it('rejects a sentence for a name, a malformed member list, and a list past the cap before touching anything', async () => {
    await seedCrowd()
    await startServer()
    const { MAX_HELD_MEMBERS_PER_REQUEST } = await import('../lib/held-voice-groups.js')
    const sentence = await call('POST', '/api/voice/held-groups/enroll', { name: 'I think this is the guy from accounting', members: [{ sessionId: 'meeting_a', chunkIndex: 0 }], confirm: true })
    expect(sentence.status).toBe(400)
    expect(sentence.json.success).toBe(false)
    const bad = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members: [{ sessionId: '../etc', chunkIndex: 0 }], confirm: true })
    expect(bad.status).toBe(400)
    expect(bad.json.reason).toBe('invalid_members')
    const float = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members: [{ sessionId: 'meeting_a', chunkIndex: 1.5 }], confirm: true })
    expect(float.json.reason).toBe('invalid_members')
    const tooMany = await call('POST', '/api/voice/held-groups/discard', {
      members: Array.from({ length: MAX_HELD_MEMBERS_PER_REQUEST + 1 }, (_, i) => ({ sessionId: 'meeting_a', chunkIndex: i })), confirm: true,
    })
    expect(tooMany.status).toBe(400)
    expect(tooMany.json.reason).toBe('too_many_members')
    const none = await call('POST', '/api/voice/held-groups/enroll', { name: 'Chris', members: [{ sessionId: 'meeting_zzz', chunkIndex: 0 }], confirm: true })
    expect(none.status).toBe(404)
    expect(none.json.reason).toBe('no_samples')
    expect(enrollCalls).toEqual([])
    expect(existsSync(wavPath('meeting_a', 0))).toBe(true)
  })
})

describe('POST /api/voice/held-groups/discard', () => {
  it('fails closed without confirm, then removes exactly the named samples and reports the ones that were not there', async () => {
    await seedCrowd()
    await startServer()
    const members = [{ sessionId: 'meeting_b', chunkIndex: 30 }, { sessionId: 'meeting_b', chunkIndex: 31 }]
    const refused = await call('POST', '/api/voice/held-groups/discard', { members })
    expect(refused.status).toBe(400)
    expect(refused.json).toMatchObject({ reason: 'confirmation_required', wouldRemove: 1, missing: [{ sessionId: 'meeting_b', chunkIndex: 31 }] })
    expect(existsSync(wavPath('meeting_b', 30))).toBe(true)
    const { status, json } = await call('POST', '/api/voice/held-groups/discard', { members, confirm: true })
    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, removed: 1, missing: [{ sessionId: 'meeting_b', chunkIndex: 31 }] })
    expect(existsSync(wavPath('meeting_b', 30))).toBe(false)
    expect(existsSync(wavPath('meeting_b', 1))).toBe(true)
    const after = await call('GET', '/api/voice/held-groups')
    expect(after.json.loose).toEqual([])
    expect(after.json.samples).toBe(6)
  })

  it('removes a decoded sample from the cache as well as the disk', async () => {
    seedWav('meeting_old', 0, 4); seedWav('meeting_old', 1, 4)
    await startServer()
    await call('GET', '/api/voice/held-groups')
    const cache = join(dataDir, 'held-voice-embeddings', 'meeting_old.json')
    expect(Object.keys(JSON.parse(String(await import('node:fs').then(fs => fs.readFileSync(cache, 'utf8')))))).toEqual(['0', '1'])
    await call('POST', '/api/voice/held-groups/discard', { members: [{ sessionId: 'meeting_old', chunkIndex: 0 }], confirm: true })
    expect(Object.keys(JSON.parse(String(await import('node:fs').then(fs => fs.readFileSync(cache, 'utf8')))))).toEqual(['1'])
  })
})
