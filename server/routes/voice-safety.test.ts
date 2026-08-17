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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dataDir = ''
let server: Server | null = null
let baseUrl = ''
let enrollCalls: Array<{ name: string; source: string }> = []
let profiles: Array<{ name: string; embeddings: number[][]; sources: string[] }> = []
let removedNames: string[] = []
let mergeCalls: Array<{ into: string; from: string[]; force?: boolean; dryRun?: boolean }> = []
let mergeSimilarity: Record<string, number> = {}
let directoryForceCalls: boolean[] = []
let opsDir = ''
let savedOperationsDir: string | undefined
let savedMeetingsRoot: string | undefined
let savedScriptsDir: string | undefined

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

async function startServer(opts: { extractionFails?: boolean; enrollFails?: boolean } = {}): Promise<void> {
  vi.resetModules()
  enrollCalls = []
  removedNames = []
  mergeCalls = []
  directoryForceCalls = []
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
      if (opts.enrollFails) return { success: false, dim: 4, error: 'Too similar to existing embedding (>0.95)' }
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
    MERGE_SIMILARITY_FLOOR: 0.55,
    mergeSpeakerProfiles: (into: string, from: string[], o: { force?: boolean; dryRun?: boolean } = {}) => {
      mergeCalls.push({ into, from: [...from], ...o })
      const target = profiles.find(p => p.name === into)
      if (!target) return { into, merged: [], missing: [into], similarity: {}, samplesBefore: 0, samplesAfter: 0, droppedToCap: 0 }
      const merged: string[] = []
      const missing: string[] = []
      const similarity: Record<string, number> = {}
      const refused: Array<{ name: string; similarity: number; floor: number }> = []
      for (const name of from) {
        const src = profiles.find(p => p.name === name)
        if (!src) { missing.push(name); continue }
        const sim = mergeSimilarity[name] ?? 0.9
        similarity[name] = sim
        if (sim < 0.55 && !o.force) { refused.push({ name, similarity: sim, floor: 0.55 }); continue }
        merged.push(name)
      }
      if (!o.dryRun) for (const n of merged) profiles = profiles.filter(p => p.name !== n)
      return {
        into, merged, missing, similarity,
        samplesBefore: target.embeddings.length,
        samplesAfter: target.embeddings.length + merged.length,
        droppedToCap: 0,
        ...(refused.length ? { refused } : {}),
      }
    },
  }))
  vi.doMock('../lib/speaker-trainer.js', () => ({
    trainFromFireflies: async () => ({ trained: 0 }),
    getTrainingStatus: async () => ({ speakers: [] }),
  }))
  vi.doMock('../lib/profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU' }))
  vi.doMock('../lib/voice-directory.js', () => ({
    invalidateVoiceDirectory: vi.fn(),
    getVoiceDirectorySnapshot: async (force: boolean) => {
      directoryForceCalls.push(force)
      return {
        schemaVersion: 1,
        generatedAt: '2026-08-11T12:00:00.000Z',
        owner: 'MU',
        profileCount: 2,
        totalEmbeddings: 34,
        meetingsScanned: 12,
        sidecarsSkipped: 1,
        truncated: false,
        unresolvedMeetings: 3,
        unresolvedSegments: 18,
        profiles: [
          {
            name: 'MU', isOwner: true, embeddings: 20, sources: { manual: 20 }, sourcesAligned: true,
            assertedSegments: 44, candidateSegments: 0, assertedSpeakingMs: 88_000, candidateSpeakingMs: 0,
            speakingTimeSources: { words: 88_000, chunks: 0 }, meetingCount: 4, reviewMeetingCount: 0,
            observedMatch: 0.72, observedMatchSegments: 44,
            reliabilityCounts: { confident: 44, weak: 0, unreliable: 0, unattributed: 0 },
            firstSeen: '2026-08-01', lastSeen: '2026-08-11', appearances: [],
          },
          {
            name: 'Clem Ukaoma', isOwner: false, embeddings: 14, sources: { fireflies: 14 }, sourcesAligned: true,
            assertedSegments: 12, candidateSegments: 3, assertedSpeakingMs: 22_000, candidateSpeakingMs: 5_000,
            speakingTimeSources: { words: 27_000, chunks: 0 }, meetingCount: 2, reviewMeetingCount: 1,
            observedMatch: 0.68, observedMatchSegments: 15,
            reliabilityCounts: { confident: 12, weak: 3, unreliable: 0, unattributed: 0 },
            firstSeen: '2026-08-02', lastSeen: '2026-08-10', appearances: [],
          },
        ],
      }
    },
  }))

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
  // PINNED, not merely absent. merge-profiles now rewrites meeting records under
  // COS_OPERATIONS_DIR, and that variable is exported in every real glasses-server
  // environment -- so a developer running this suite on their own machine would have
  // had route tests rewriting their production meeting library. Relying on the
  // ambient env being unset is luck, not isolation.
  savedOperationsDir = process.env.COS_OPERATIONS_DIR
  savedMeetingsRoot = process.env.COS_MEETINGS_ROOT
  savedScriptsDir = process.env.COS_SCRIPTS_DIR
  opsDir = mkdtempSync(join(tmpdir(), 'cos-voice-ops-'))
  process.env.COS_OPERATIONS_DIR = opsDir
  delete process.env.COS_MEETINGS_ROOT
  delete process.env.COS_SCRIPTS_DIR
  mergeSimilarity = {}
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
  vi.doUnmock('../lib/voice-directory.js')
  delete process.env.COS_DATA_DIR
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  restore('COS_OPERATIONS_DIR', savedOperationsDir)
  restore('COS_MEETINGS_ROOT', savedMeetingsRoot)
  restore('COS_SCRIPTS_DIR', savedScriptsDir)
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  if (opsDir) rmSync(opsDir, { recursive: true, force: true })
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
      expect(res.status, `"${speaker}" must be rejected as an invalid name`).toBe(400)
    }
    expect(enrollCalls).toEqual([])
  })

  it('rejects a separator even when it resolves INSIDE the root', async () => {
    // 'a/b' resolves to <root>/a/b, which passes a prefix/boundary check — so
    // this is the case the name validation itself has to catch. Asserting 400
    // rather than 404 is what distinguishes "rejected the name" from "looked for
    // it and found nothing", and is why the two guards are not redundant.
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    await startServer()
    for (const speaker of ['a/b', 'Clem_Ukaoma/nested']) {
      const res = await httpRequest('POST', '/api/voice/train-g2', { speaker })
      expect(res.status, `"${speaker}" must be rejected by name validation`).toBe(400)
      expect(res.json.error).toBe('invalid speaker name')
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

  it('RETAINS the audio when no embedding could be extracted', async () => {
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    await startServer({ extractionFails: true })

    const res = await httpRequest('POST', '/api/voice/train-g2', { confirmAllSpeakers: true })
    expect(res.json.trained).toBe(0)
    expect(res.json.speakers[0].audioRetained).toBe(true)
    expect(existsSync(join(trainingDir('Clem Ukaoma'), 'c1.wav'))).toBe(true)
  })

  it('RETAINS the audio when extraction worked but every enrollment was refused', async () => {
    // The distinct and more likely case: embeddings extract fine and the >0.95
    // dedup gate rejects all of them. The original code unlinked and rmdir'd
    // unconditionally, so the source audio was destroyed having enrolled
    // nothing — the one outcome from which there is no recovery. The
    // extraction-failure test above cannot reach this branch: it returns early.
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    writeWav(trainingDir('Clem Ukaoma'), 'c2.wav', 2)
    await startServer({ enrollFails: true })

    const res = await httpRequest('POST', '/api/voice/train-g2', { confirmAllSpeakers: true })
    expect(res.json.trained).toBe(0)
    expect(enrollCalls.length).toBe(2)              // it really did try
    expect(res.json.speakers[0].audioRetained).toBe(true)
    expect(readdirSync(trainingDir('Clem Ukaoma'))).toHaveLength(2)
  })

  it('deletes the audio only once something was actually enrolled', async () => {
    // The positive half of the same guard, so "retain always" is not a passing
    // implementation either.
    writeWav(trainingDir('Clem Ukaoma'), 'c1.wav', 1)
    await startServer()
    const res = await httpRequest('POST', '/api/voice/train-g2', { confirmAllSpeakers: true })
    expect(res.json.trained).toBe(1)
    expect(res.json.speakers[0].audioRetained).toBeUndefined()
    expect(existsSync(trainingDir('Clem Ukaoma'))).toBe(false)
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

describe('merge-profiles fails closed', () => {
  it('refuses without confirm and returns a preview, merging nothing', async () => {
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles', { into: 'MU', from: 'Clem Ukaoma' })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('confirmation required')
    expect(res.json.preview.similarity['Clem Ukaoma']).toBeDefined()
    // The preview must be a DRY RUN — a confirmation gate that already merged
    // would be decoration.
    expect(mergeCalls).toEqual([{ into: 'MU', from: ['Clem Ukaoma'], force: false, dryRun: true }])
    expect(profiles.map(p => p.name)).toContain('Clem Ukaoma')
  })

  it('merges on confirm and relabels the absorbed calibration history', async () => {
    writeFileSync(join(dataDir, 'speaker-calibration.jsonl'),
      [
        JSON.stringify({ ts: 't1', speaker: 'Clem Ukaoma', similarity: 0.61 }),
        JSON.stringify({ ts: 't2', speaker: 'MU', similarity: 0.93 }),
      ].join('\n') + '\n')
    await startServer()

    const res = await httpRequest('POST', '/api/voice/merge-profiles', { into: 'MU', from: 'Clem Ukaoma', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.merged).toEqual(['Clem Ukaoma'])
    expect(res.json.calibrationRowsRelabeled).toEqual({ 'Clem Ukaoma': 1 })
    // Relabeled, NOT deleted: after a merge it is one person's history.
    const log = readFileSync(join(dataDir, 'speaker-calibration.jsonl'), 'utf-8')
    expect(log).not.toContain('Clem Ukaoma')
    expect(log.match(/"speaker":"MU"/g)).toHaveLength(2)
  })

  it('409s below the similarity floor and leaves both profiles alone', async () => {
    mergeSimilarity = { 'Clem Ukaoma': 0.41 }
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles', { into: 'MU', from: 'Clem Ukaoma', confirm: true })
    expect(res.status).toBe(409)
    expect(res.json.error).toBe('similarity below the merge floor')
    expect(res.json.report.refused[0]).toMatchObject({ name: 'Clem Ukaoma', similarity: 0.41 })
    expect(profiles.map(p => p.name).sort()).toEqual(['Clem Ukaoma', 'MU'])
  })

  it('force overrides the floor and records that it was forced', async () => {
    mergeSimilarity = { 'Clem Ukaoma': 0.41 }
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'MU', from: 'Clem Ukaoma', confirm: true, force: true })
    expect(res.status).toBe(200)
    expect(res.json.forced).toBe(true)
    expect(res.json.merged).toEqual(['Clem Ukaoma'])
  })

  it('refuses to ABSORB the owner label', async () => {
    // The owner profile is checked first on every chunk in the live path;
    // absorbing it away would silently break identification for the wearer.
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'Clem Ukaoma', from: 'MU', confirm: true })
    expect(res.status).toBe(400)
    expect(res.json.error).toMatch(/owner label "MU"/)
    expect(mergeCalls).toEqual([])
  })

  it('rejects a self-merge and missing arguments', async () => {
    await startServer()
    expect((await httpRequest('POST', '/api/voice/merge-profiles', { into: 'MU', from: 'MU', confirm: true })).status).toBe(400)
    expect((await httpRequest('POST', '/api/voice/merge-profiles', { into: 'MU', confirm: true })).status).toBe(400)
    expect((await httpRequest('POST', '/api/voice/merge-profiles', { from: 'MU', confirm: true })).status).toBe(400)
    expect(mergeCalls).toEqual([])
  })

  it('404s when nothing matched', async () => {
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles', { into: 'Ghost', from: 'Nobody', confirm: true })
    expect(res.status).toBe(404)
    expect(profiles).toHaveLength(2)
  })

  it('dryRun does not relabel the calibration log', async () => {
    const original = JSON.stringify({ ts: 't1', speaker: 'Clem Ukaoma', similarity: 0.61 }) + '\n'
    writeFileSync(join(dataDir, 'speaker-calibration.jsonl'), original)
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles', { into: 'MU', from: 'Clem Ukaoma', dryRun: true })
    expect(res.status).toBe(200)
    expect(res.json.calibrationRowsRelabeled).toEqual({})
    expect(readFileSync(join(dataDir, 'speaker-calibration.jsonl'), 'utf-8')).toBe(original)
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

describe('/voice/directory exposes honest bounded cross-meeting evidence', () => {
  it('keeps training coverage, observed match, and unresolved voices distinct', async () => {
    await startServer()
    const res = await httpRequest('GET', '/api/voice/directory?limit=1&offset=1&refresh=1')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      profileCount: 2,
      totalEmbeddings: 34,
      unresolvedMeetings: 3,
      unresolvedSegments: 18,
      offset: 1,
      limit: 1,
      hasMore: false,
    })
    expect(directoryForceCalls).toEqual([true])
    expect(res.json.profiles).toHaveLength(1)
    expect(res.json.profiles[0]).toMatchObject({
      name: 'Clem Ukaoma',
      embeddings: 14,
      assertedSegments: 12,
      candidateSegments: 3,
      meetingCount: 2,
      reviewMeetingCount: 1,
      observedMatch: 0.68,
      observedMatchSegments: 15,
    })
    expect(res.json.profiles[0]).not.toHaveProperty('confidence')
  })

  it('clamps pagination rather than allowing an unbounded response', async () => {
    await startServer()
    const res = await httpRequest('GET', '/api/voice/directory?limit=999&offset=-8')
    expect(res.status).toBe(200)
    expect(res.json.limit).toBe(100)
    expect(res.json.offset).toBe(0)
    expect(res.json.profiles).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// A merge must reach the MEETINGS, not just the store.
//
// The gap this closes, measured on the real library: the Luke H / Luke Henry split
// had been live since 2026-03-25, the merge fixed identification going forward, and
// 42 meeting records kept rendering two Lukes forever because nothing ever rewrote
// them. The review panel re-reads those strings from disk on every request.
// ---------------------------------------------------------------------------
describe('a merge carries the rename out to the meeting library', () => {
  /** A meeting in the shape the production library actually uses. */
  function meeting(domain: string, month: string, base: string, speaker: string): {
    md: string; sidecar: string
  } {
    const dir = join(opsDir, domain, 'meetings', month)
    mkdirSync(dir, { recursive: true })
    const md = join(dir, `${base}.md`)
    writeFileSync(md, [
      '# Sync', '', '## Attendees', '', `- ${speaker}`, '- MU', '',
      '## Transcript', '', `[${speaker}]:`, 'A thing was said.', '', '[MU]:', 'Agreed.', '',
    ].join('\n'))
    const sidecar = join(dir, `${base}.g2-chunks.json`)
    writeFileSync(sidecar, JSON.stringify({
      chunks: [{ speaker, text: 'A thing was said.' }, { speaker: 'MU', text: 'Agreed.' }],
    }))
    return { md, sidecar }
  }

  it('shows the blast radius in the confirm preview, and rewrites NOTHING yet', async () => {
    // The confirm gate exists so a human sees what a merge does before it happens.
    // Rewriting production meeting records is the largest thing it does, so a preview
    // that omitted it would be hiding the part that matters.
    const { md, sidecar } = meeting('quilt', '2026-08', 'sync', 'Clem Ukaoma')
    await startServer()

    const res = await httpRequest('POST', '/api/voice/merge-profiles', { into: 'MU', from: 'Clem Ukaoma' })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('confirmation required')
    expect(res.json.meetingRewrite.files).toBe(2)
    expect(res.json.meetingRewrite.labels).toBeGreaterThan(0)
    expect(res.json.meetingRewrite.dryRun).toBe(true)

    expect(readFileSync(md, 'utf-8')).toContain('[Clem Ukaoma]:')
    expect(readFileSync(sidecar, 'utf-8')).toContain('Clem Ukaoma')
  })

  it('rewrites both the transcript and the sidecar on confirm, and names the files', async () => {
    const { md, sidecar } = meeting('quilt', '2026-08', 'sync', 'Clem Ukaoma')
    await startServer()

    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'MU', from: 'Clem Ukaoma', confirm: true })
    expect(res.status).toBe(200)

    const after = readFileSync(md, 'utf-8')
    expect(after).toContain('[MU]:')
    expect(after).not.toContain('[Clem Ukaoma]:')
    expect(after).not.toContain('- Clem Ukaoma')
    expect(JSON.parse(readFileSync(sidecar, 'utf-8')).chunks.map((c: {speaker: string}) => c.speaker))
      .toEqual(['MU', 'MU'])

    // Counts alone would not let an operator audit or diff what was touched.
    // realpathSync because the resolver canonicalises, and on macOS the tmpdir is a
    // symlink (/var -> /private/var). Comparing the raw fixture path fails on a
    // difference that has nothing to do with the behaviour under test.
    expect(res.json.meetingRewrite.markdown[0].path).toBe(realpathSync(md))
    expect(res.json.meetingRewrite.sidecars[0].path).toBe(realpathSync(sidecar))
  })

  it('leaves the library untouched on dryRun, all the way down', async () => {
    // Otherwise `dryRun: true` becomes the most dangerous parameter in the API.
    const { md } = meeting('quilt', '2026-08', 'sync', 'Clem Ukaoma')
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'MU', from: 'Clem Ukaoma', dryRun: true })
    expect(res.status).toBe(200)
    expect(res.json.meetingRewrite.dryRun).toBe(true)
    expect(readFileSync(md, 'utf-8')).toContain('[Clem Ukaoma]:')
  })

  it('rewrites NOTHING when the merge itself was refused below the floor', async () => {
    // The rename is only correct BECAUSE the merge concluded they are one person.
    // A 409 means we concluded the opposite.
    mergeSimilarity = { 'Clem Ukaoma': 0.41 }
    const { md } = meeting('quilt', '2026-08', 'sync', 'Clem Ukaoma')
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'MU', from: 'Clem Ukaoma', confirm: true })
    expect(res.status).toBe(409)
    expect(readFileSync(md, 'utf-8')).toContain('[Clem Ukaoma]:')
  })

  it('sweeps every domain and month, and skips iCloud conflict copies', async () => {
    // Desktop-and-Documents sync creates `2026-08 2/` and `sync 2.md`. Rewriting one
    // of those edits a file nothing reads while leaving the real one stale.
    meeting('quilt', '2026-08', 'sync', 'Clem Ukaoma')
    meeting('personal', '2026-07', 'other', 'Clem Ukaoma')
    const conflictMonth = meeting('quilt', '2026-08 2', 'sync', 'Clem Ukaoma')
    const conflictFile = meeting('quilt', '2026-08', 'sync 2', 'Clem Ukaoma')
    await startServer()

    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'MU', from: 'Clem Ukaoma', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.meetingRewrite.files).toBe(4)   // two real meetings x (md + sidecar)
    expect(readFileSync(conflictMonth.md, 'utf-8')).toContain('[Clem Ukaoma]:')
    expect(readFileSync(conflictFile.md, 'utf-8')).toContain('[Clem Ukaoma]:')
  })

  it('still merges when no COS library is configured', async () => {
    // A standalone server with no operations tree is a supported install, not an error.
    delete process.env.COS_OPERATIONS_DIR
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'MU', from: 'Clem Ukaoma', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.merged).toEqual(['Clem Ukaoma'])
    expect(res.json.meetingRewrite.files).toBe(0)
    expect(res.json.meetingRewrite.error).toBeUndefined()
  })

  it('renames ONLY the names that actually merged, never the ones that did not', async () => {
    // THE DATA-CORRUPTION PATH. `from` is what was REQUESTED; `report.merged` is what
    // the store actually absorbed. A name that does not exist as a profile is reported
    // in `missing` and merged into nothing -- but it can still be a real person's
    // speaker label in the meeting library. Fanning out the requested list instead of
    // the merged list would rewrite that person's name to someone else's in every
    // meeting they appear in, off the back of a typo.
    //
    // Found by mutation: swapping `report.merged` for `from` passed all 51 tests.
    const dir = join(opsDir, 'quilt', 'meetings', '2026-08')
    mkdirSync(dir, { recursive: true })
    const other = join(dir, 'other.md')
    writeFileSync(other, ['## Attendees', '', '- Niala Boodhoo', '',
      '## Transcript', '', '[Niala Boodhoo]:', 'Unrelated.', ''].join('\n'))

    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'MU', from: ['Clem Ukaoma', 'Niala Boodhoo'], confirm: true })

    expect(res.status).toBe(200)
    expect(res.json.merged).toEqual(['Clem Ukaoma'])
    expect(res.json.missing).toEqual(['Niala Boodhoo'])
    // Her name survives untouched. She was never merged into anything.
    expect(readFileSync(other, 'utf-8')).toContain('[Niala Boodhoo]:')
  })

  it('counts sidecar labels from the relabelled CHUNKS, not from a truthy result', async () => {
    // `SidecarRelabelResult.changed` is an ARRAY of chunk indices. A first cut read it
    // as a number, which would have reported 0 labels for every sidecar -- a fan-out
    // announcing success while rewriting nothing. Mutation-proven: hardcoding the
    // count to 1 passed the whole suite before this existed.
    const dir = join(opsDir, 'quilt', 'meetings', '2026-08')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'many.g2-chunks.json'), JSON.stringify({
      chunks: [
        { speaker: 'Clem Ukaoma', text: 'one' },
        { speaker: 'MU', text: 'two' },
        { speaker: 'Clem Ukaoma', text: 'three' },
        { speaker: 'Clem Ukaoma', text: 'four' },
      ],
    }))
    await startServer()
    const res = await httpRequest('POST', '/api/voice/merge-profiles',
      { into: 'MU', from: 'Clem Ukaoma', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.meetingRewrite.sidecars[0].labels).toBe(3)
    expect(res.json.meetingRewrite.labels).toBe(3)
  })
})
