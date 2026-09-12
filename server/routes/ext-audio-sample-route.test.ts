// 6.45.3 — a held (ext-audio) session can be listened to chunk by chunk before it is named.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dataDir = ''
let server: Server | null = null
let baseUrl = ''

function seedHeld(sessionId: string, files: Array<[string, number]>): void {
  const dir = join(dataDir, 'ext-audio', sessionId)
  mkdirSync(dir, { recursive: true })
  for (const [name, fill] of files) writeFileSync(join(dir, name), Buffer.alloc(48, fill))
}

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU', getVocabulary: () => [], getOwnerName: () => 'Miles', getTranscriptionProfileStatus: () => ({}),
  }))
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

function get(path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET' }, res => {
      const parts: Buffer[] = []
      res.on('data', c => parts.push(Buffer.from(c)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cos-ext-audio-'))
  process.env.COS_DATA_DIR = dataDir
})
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
  vi.resetModules()
})

describe('held voice samples by chunk (6.45.3)', () => {
  it('lists the chunk indices a session holds and serves the one asked for', async () => {
    seedHeld('meeting_1', [['ext_chunk0_100.wav', 1], ['ext_chunk5_200.wav', 6], ['ext_chunk12_300.wav', 13]])
    await startServer()
    const listing = JSON.parse((await get('/api/voice/ext-audio')).body.toString())
    expect(listing.sessions).toHaveLength(1)
    expect(listing.sessions[0]).toMatchObject({ sessionId: 'meeting_1', chunks: 3, chunkIndices: [0, 5, 12] })

    const five = await get('/api/voice/ext-audio/meeting_1/sample?chunk=5')
    expect(five.status).toBe(200)
    expect(five.body[0]).toBe(6)
    const twelve = await get('/api/voice/ext-audio/meeting_1/sample?chunk=12')
    expect(twelve.body[0]).toBe(13)
  })

  it('still serves the newest chunk without a chunk parameter, and names a missing or bad chunk', async () => {
    seedHeld('meeting_2', [['ext_chunk0_100.wav', 1], ['ext_chunk1_200.wav', 2]])
    await startServer()
    const newest = await get('/api/voice/ext-audio/meeting_2/sample')
    expect(newest.status).toBe(200)
    expect(newest.body.length).toBe(48)
    const missing = await get('/api/voice/ext-audio/meeting_2/sample?chunk=7')
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body.toString()).reason).toBe('no_ext_audio_chunk')
    const bad = await get('/api/voice/ext-audio/meeting_2/sample?chunk=-1')
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body.toString()).reason).toBe('invalid_chunk')
  })
})
