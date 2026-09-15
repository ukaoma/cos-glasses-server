// A stored Fireflies key must NOT switch on voice training.
//
// POST /api/voice/train downloads meeting audio and rewrites voice profiles. It
// reads FIREFLIES_API_KEY from the environment or the COS pipeline's own .env,
// and 6.47.0 adds a SECOND place a Fireflies key can live: a key file under the
// data home that a person types into COS Control to import meetings.
//
// Those two must stay separate. Someone connecting Fireflies to import meetings
// has not asked for their voice profiles to be rebuilt from meeting audio, and
// a feature that turns itself on because an unrelated credential appeared is
// exactly the kind of surprise this repo's rules exist to prevent.
//
// THE POSITIVE CONTROL IS THE POINT. A test that only asserts "500" would pass
// if the route died for any reason at all, so the second case proves the same
// route DOES reach the key resolver and the network when a key is in the
// environment. Without it, the first case is decoration.

import express from 'express'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dataDir = ''
let server: Server | null = null
let base = ''
let fetchCalls: string[] = []
const realFetch = globalThis.fetch
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cos-voice-train-key-'))
  fetchCalls = []
  for (const key of ['COS_DATA_DIR', 'COS_SCRIPTS_DIR', 'FIREFLIES_API_KEY']) saved[key] = process.env[key]
  process.env.COS_DATA_DIR = dataDir
  delete process.env.COS_SCRIPTS_DIR
  delete process.env.FIREFLIES_API_KEY
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input))
    // Fail the call: reaching the network is all this needs to prove, and a
    // successful list would walk the trainer into writing progress state.
    return new Response('{}', { status: 500, statusText: 'Server Error' })
  }) as typeof globalThis.fetch
})

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = null
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dataDir, { recursive: true, force: true })
  vi.resetModules()
  vi.doUnmock('../lib/speaker-embeddings.js')
})

async function startVoiceServer(): Promise<void> {
  vi.resetModules()
  // The speaker engine and a 26 MB model are not test dependencies. Everything
  // below this line is production code, including speaker-trainer.ts, which is
  // the module under test here.
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    isEmbeddingAvailable: () => true,
    enrollEmbedding: () => ({ success: true, dim: 4 }),
    extractEmbedding: () => new Float32Array([1, 0, 0, 0]),
    enrollSpeaker: () => ({ success: true, dim: 4 }),
    isEnrolled: () => true,
    getAllSpeakerNames: () => [],
    identifySpeaker: () => null,
    getEmbeddingCount: () => 0,
    removeSpeakerProfile: () => ({ removedProfiles: 0, removedEmbeddings: 0 }),
    readVoiceProfiles: () => ({ profiles: [] }),
    rawCosineSimilarity: () => 0,
    mergeSpeakerProfiles: () => ({ into: '', merged: [], missing: [], similarity: {} }),
    saveProfileStore: () => undefined,
    rebuildAllProfiles: () => undefined,
    clearSpeakerEmbeddings: () => false,
    MERGE_SIMILARITY_FLOOR: 0.55,
    AUTO_ENROLL_CANDIDATE_SIMILARITY: 0.72,
    AUTO_ENROLL_THRESHOLD: 0.88,
  }))
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'Me',
    getTranscriptionProfileStatus: () => ({ ignoredPlaceholderTerms: 0, ignoredPlaceholderCorrection: false }),
  }))
  // ffmpeg is a real binary the trainer shells out to before it resolves a key.
  // Without this the refusal under test could be "no ffmpeg" on a box that
  // happens not to have it, which would pass for the wrong reason.
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execSync: () => Buffer.from('ffmpeg version test'),
  }))

  const { voiceRouter } = await import('./voice.js')
  const app = express()
  app.use(express.json())
  app.use('/api', voiceRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server!.once('listening', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  base = `http://127.0.0.1:${address.port}`
}

async function postTrain(): Promise<{ status: number; body: string }> {
  const response = await realFetch(`${base}/api/voice/train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  })
  return { status: response.status, body: await response.text() }
}

describe('a Fireflies key file does not enable voice training', () => {
  it('refuses when the ONLY key is the imported-meetings key file', async () => {
    const { FirefliesKeyStore } = await import('../lib/fireflies-key.js')
    const store = new FirefliesKeyStore({ path: join(dataDir, 'fireflies-key.json') })
    store.save('ff_import_only_key_0123456789')
    expect(store.key()).toBe('ff_import_only_key_0123456789')

    await startVoiceServer()
    const result = await postTrain()

    expect(result.status).toBe(500)
    expect(result.body).toContain('FIREFLIES_API_KEY not found')
    // The decisive assertion: no meeting audio was ever requested.
    expect(fetchCalls).toEqual([])
  })

  it('positive control: an environment key DOES reach the vendor', async () => {
    process.env.FIREFLIES_API_KEY = 'ff_env_key_for_training_01234'
    await startVoiceServer()
    const result = await postTrain()

    expect(result.status).toBe(500)
    expect(result.body).not.toContain('FIREFLIES_API_KEY not found')
    expect(fetchCalls).toEqual(['https://api.fireflies.ai/graphql'])
  })

  it('the key file writer and the trainer read different places', async () => {
    const trainer = await import('../lib/speaker-trainer.js')
    const source = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../lib/speaker-trainer.ts', import.meta.url), 'utf8',
    ))
    expect(typeof trainer.trainFromFireflies).toBe('function')
    // speaker-trainer.ts stays unchanged in this release: it must not learn
    // about the key file, the data home, or the key store.
    expect(source).not.toContain('fireflies-key')
    expect(source).not.toContain('dataPath')
  })
})
