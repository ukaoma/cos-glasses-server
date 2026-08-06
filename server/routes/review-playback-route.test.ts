// Playback for review: can a human actually HEAR the voice?
//
// Driven over real HTTP and asserted on the returned BYTES, not on a status code.
// A 200 that serves the wrong chunk is worse than a 404 — the reviewer confirms
// an identity against audio that belongs to someone else.
//
// The 404 paths carry equal weight. Once the 7-day window passes the audio is
// genuinely gone, and the response has to say so with a reason rather than
// implying the meeting never had any.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root = ''
let dataDir = ''
let server: Server | null = null
let baseUrl = ''

const MONTH = '2026-08'
const STEM = '2026-08-05_Lead_Ops_Review_abc12345'

function seedMeeting(sessionId: string): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), '# Lead Ops Review\n')
  writeFileSync(join(dir, `${STEM}.g2-chunks.json`), JSON.stringify({
    sessionId,
    chunks: [{ text: 'a', speaker: 'MU', elapsed: 0, similarity: 0.8 }],
  }))
}

/** Retained review audio, with a distinct byte pattern per chunk so a
 *  wrong-chunk response is detectable rather than merely plausible. */
function seedReviewAudio(sessionId: string, chunks: number[]): void {
  const dir = join(dataDir, 'meeting-audio', sessionId)
  mkdirSync(dir, { recursive: true })
  for (const i of chunks) {
    writeFileSync(join(dir, `chunk_${String(i).padStart(4, '0')}.wav`), Buffer.alloc(64, i + 1))
  }
}

function seedSpeakerAudio(tree: 'training-audio' | 'ext-audio', key: string, files: Array<[string, number]>): void {
  const dir = join(dataDir, tree, key.replace(/\s+/g, '_'))
  mkdirSync(dir, { recursive: true })
  for (const [name, fill] of files) writeFileSync(join(dir, name), Buffer.alloc(48, fill))
}

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU',
    getVocabulary: () => [],
    getOwnerName: () => 'Miles',
    getTranscriptionProfileStatus: () => ({}),
  }))
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const { voiceRouter } = await import('./voice.js')
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingRouter({ store: new MeetingStore(root) }))
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

function get(path: string): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET' }, res => {
      const parts: Buffer[] = []
      res.on('data', c => parts.push(Buffer.from(c)))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        type: String(res.headers['content-type'] ?? ''),
        body: Buffer.concat(parts),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}
const json = (r: { body: Buffer }) => JSON.parse(r.body.toString())

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-play-'))
  dataDir = mkdtempSync(join(tmpdir(), 'cos-play-data-'))
  process.env.COS_DATA_DIR = dataDir
})
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  delete process.env.COS_DATA_DIR
  for (const d of [root, dataDir]) if (d) rmSync(d, { recursive: true, force: true })
})

const HTTP_TEST_TIMEOUT = 30_000

describe('playing one meeting segment', () => {
  it('serves the EXACT chunk requested', async () => {
    seedMeeting('meeting_p1')
    seedReviewAudio('meeting_p1', [0, 1, 2, 3])
    await startServer()

    const res = await get('/api/meeting/meeting_p1/audio/2')
    expect(res.status).toBe(200)
    expect(res.type).toContain('audio/wav')
    // Byte-checked: chunk 2 was filled with 3. Serving a neighbour would still
    // be a 200 with plausible audio, and the reviewer would confirm an identity
    // against the wrong voice.
    expect(res.body).toEqual(Buffer.alloc(64, 3))
  })

  it('404s a chunk that is not retained, and says what IS', async () => {
    seedMeeting('meeting_p2')
    seedReviewAudio('meeting_p2', [5, 6, 7])
    await startServer()

    const res = await get('/api/meeting/meeting_p2/audio/1')
    expect(res.status).toBe(404)
    const b = json(res)
    expect(b.reason).toBe('chunk_not_retained')
    // So a UI can offer the nearest playable segment instead of a dead end.
    expect(b.firstRetained).toBe(5)
    expect(b.lastRetained).toBe(7)
  })

  it('distinguishes "window passed" from "chunk missing"', async () => {
    // After 7 days the audio is genuinely gone. Reporting that as a missing
    // chunk would imply the meeting never had audio at all.
    seedMeeting('meeting_p3')
    await startServer()

    const res = await get('/api/meeting/meeting_p3/audio/0')
    expect(res.status).toBe(404)
    expect(json(res).reason).toBe('audio_not_retained')
    expect(json(res).retainedChunks).toBe(0)
  })

  it('rejects a traversing session id or a nonsense index', async () => {
    seedMeeting('meeting_p4')
    seedReviewAudio('meeting_p4', [0])
    await startServer()

    expect((await get('/api/meeting/..%2F..%2Fetc/audio/0')).status).toBe(400)
    for (const bad of ['-1', '1.5', 'two']) {
      const res = await get(`/api/meeting/meeting_p4/audio/${bad}`)
      expect(res.status, bad).toBe(400)
      expect(json(res).reason).toBe('invalid_chunk_index')
    }
  })

  it('lists what a meeting has, so play buttons appear only where they work', async () => {
    seedMeeting('meeting_p5')
    seedReviewAudio('meeting_p5', [0, 4, 9])
    await startServer()

    const res = await get('/api/meeting/meeting_p5/audio')
    expect(res.status).toBe(200)
    const b = json(res)
    expect(b.retained).toBe(true)
    expect(b.chunks).toEqual([0, 4, 9])
    expect(b.retentionDays).toBe(7)
  })

  it('reports retained:false rather than an error for a meeting with no audio', async () => {
    seedMeeting('meeting_p6')
    await startServer()
    const b = json(await get('/api/meeting/meeting_p6/audio'))
    expect(b.retained).toBe(false)
    expect(b.chunks).toEqual([])
  })
}, HTTP_TEST_TIMEOUT)

describe('playing a stored profile — no retention change needed', () => {
  it('serves the NEWEST training sample for a named person', async () => {
    // "Is this really Navaz?" is answered by playing Navaz's own profile sample.
    // Newest, because it is the most representative of the current profile.
    // Names chosen so ALPHABETICAL order is the OPPOSITE of mtime order: `aaa`
    // is the OLDER file. With them the other way round, "take the first entry"
    // and "take the newest" happen to agree and the test proves nothing.
    seedSpeakerAudio('training-audio', 'Navaz Sharif', [
      ['aaa_meeting_old_chunk1_sim0.60.wav', 1],
      ['zzz_meeting_new_chunk2_sim0.71.wav', 2],
    ])
    const dir = join(dataDir, 'training-audio', 'Navaz_Sharif')
    const { utimesSync } = await import('node:fs')
    utimesSync(join(dir, 'aaa_meeting_old_chunk1_sim0.60.wav'), 1000, 1000)
    utimesSync(join(dir, 'zzz_meeting_new_chunk2_sim0.71.wav'), 2_000_000, 2_000_000)
    await startServer()

    const res = await get('/api/voice/profiles/Navaz%20Sharif/sample')
    expect(res.status).toBe(200)
    expect(res.type).toContain('audio/wav')
    expect(res.body).toEqual(Buffer.alloc(48, 2))
  })

  it('handles a name with a space, matching the on-disk directory form', async () => {
    seedSpeakerAudio('training-audio', 'Chris Krubeck', [['meeting_a_chunk1_sim0.8.wav', 7]])
    await startServer()
    expect((await get('/api/voice/profiles/Chris%20Krubeck/sample')).status).toBe(200)
  })

  it('404s a profile with no retained audio and says why', async () => {
    // A profile built from Fireflies seeds has no audio at all. Reporting that
    // as an unknown person would be wrong — the profile exists.
    await startServer()
    const res = await get('/api/voice/profiles/Gina%20Obert/sample')
    expect(res.status).toBe(404)
    expect(json(res).reason).toBe('no_sample_audio')
    expect(json(res)).toHaveProperty('embeddings')
  })

  it('never serves a file for a traversing speaker name', async () => {
    await startServer()
    // Two different defences, and it matters which is which. An ENCODED
    // traversal reaches the handler and speakerDirPath rejects it (400). A bare
    // `..` never arrives at all — express normalises the URL path first, so the
    // router 404s. Asserting 400 for both would claim a guard that is not the
    // one actually protecting that case.
    const encoded = await get('/api/voice/profiles/..%2F..%2Fetc/sample')
    expect(encoded.status).toBe(400)
    expect(JSON.parse(encoded.body.toString()).reason).toBe('invalid_speaker')

    const bare = await get('/api/voice/profiles/../sample')
    expect(bare.status).not.toBe(200)
    expect(bare.type).not.toContain('audio/wav')
  })
}, HTTP_TEST_TIMEOUT)

describe('playing an unidentified voice', () => {
  it('serves ext-audio for a session', async () => {
    seedSpeakerAudio('ext-audio', 'meeting_e1', [['chunk_0001.wav', 9]])
    await startServer()
    const res = await get('/api/voice/ext-audio/meeting_e1/sample')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(Buffer.alloc(48, 9))
  })

  it('404s when the 72-hour window has passed', async () => {
    await startServer()
    const res = await get('/api/voice/ext-audio/meeting_gone/sample')
    expect(res.status).toBe(404)
    expect(json(res).reason).toBe('no_ext_audio')
  })
}, HTTP_TEST_TIMEOUT)
