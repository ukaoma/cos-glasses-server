// 6.86.0: the newest preview of a live meeting, kept in memory for COS Control's grey line and served by
// GET /transcribe-stream/provisional. Fictional meeting text only: this repo is public.
import express from 'express'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_PROVISIONAL_LIMITS, LiveProvisionalStore, liveMeetingCapability } from '../lib/live-provisional.js'

const CANONICAL = 'The harbor team agreed to move the kiosk pilot to two stores'
let previewText = 'Marlow will send the kiosk'
let root = ''
let server: Server | null = null
let base = ''
let stream: typeof import('./transcribe-stream.js')
const lines: string[] = []

function send(method: 'GET' | 'POST', path: string, body?: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), ...headers } : headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}
const pin = { 'X-COS-Server-Instance': 'server-a' }
const preview = (sessionId: string, chunkIndex: number, previewGen: number) =>
  send('POST', `/api/transcribe-stream/preview?sessionId=${sessionId}&chunkIndex=${chunkIndex}&previewGen=${previewGen}&serverInstanceId=server-a`, Buffer.alloc(12_800, 1), pin)
const chunk = (sessionId: string, chunkIndex: number) =>
  send('POST', `/api/transcribe-stream?sessionId=${sessionId}&chunkIndex=${chunkIndex}&speaker=MU`, Buffer.alloc(44 + 3 * 32_000, 1))
const provisional = (sessionId: string) => send('GET', `/api/transcribe-stream/provisional?sessionId=${sessionId}`)

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cos-provisional-'))
  process.env.COS_DATA_DIR = root
  process.env.COS_WHISPER_MEETING_PREVIEW = '1'
  previewText = 'Marlow will send the kiosk'
  lines.length = 0
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' ')) })
  }
  vi.resetModules()
  vi.doMock('../lib/whisper-preview.js', () => ({ transcribeWhisperMeetingPreview: vi.fn(async () => ({ text: previewText, model: 'large-v3-turbo', backend: 'whisper-preview-server' })) }))
  vi.doMock('../lib/server-instance-id.js', () => ({ getServerInstanceId: () => 'server-a' }))
  vi.doMock('../lib/whisper-local.js', () => ({ transcribeLocal: vi.fn().mockResolvedValue({ text: CANONICAL, words: [], backend: 'mock' }), applyCorrections: (t: string) => t }))
  vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    AUTO_ENROLL_CANDIDATE_SIMILARITY: 0.72, AUTO_ENROLL_THRESHOLD: 0.88,
    identifySpeaker: vi.fn().mockReturnValue({ speaker: 'MU', similarity: 0.9, embedding: new Float32Array(192) }),
    isEmbeddingAvailable: () => true, autoEnroll: vi.fn().mockReturnValue({ enrolled: false, reason: 'test' }), getEmbeddingCount: () => 3,
  }))
  vi.doMock('../lib/vad-silero.js', () => ({ trimSilence: vi.fn(), isSileroAvailable: () => false }))
  vi.doMock('../lib/profile.js', () => ({ getVocabulary: () => [], getOwnerName: () => 'COS', getWhisperCorrections: () => '', getOwnerSpeakerLabel: () => 'MU' }))
  stream = await import('./transcribe-stream.js')
  const app = express()
  app.use(express.json())
  app.use('/api', stream.transcribeStreamRouter)
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.restoreAllMocks()
  vi.resetModules()
  for (const m of ['whisper-preview', 'server-instance-id', 'whisper-local', 'audio-enhance', 'speaker-embeddings', 'vad-silero', 'profile']) vi.doUnmock(`../lib/${m}.js`)
  delete process.env.COS_DATA_DIR
  delete process.env.COS_WHISPER_MEETING_PREVIEW
  if (root) rmSync(root, { recursive: true, force: true })
})

/** Every file under the data dir, read back, so a test can prove the preview text never reached disk. */
function everythingOnDisk(dir: string): string {
  let out = ''
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    out += statSync(path).isDirectory() ? everythingOnDisk(path) : readFileSync(path, 'latin1')
  }
  return out
}

describe('GET /transcribe-stream/provisional (6.86.0)', () => {
  it('a preview for a session this server does not hold is answered as before and stored nowhere', async () => {
    expect((await preview('provisional_none', 0, 1)).json).toMatchObject({ text: previewText, provisional: true })
    const res = await provisional('provisional_none')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ v: 1, sessionId: 'provisional_none', live: false, provisional: null, serverInstanceId: 'server-a' })
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(stream.getMeetingSessionStatus('provisional_none')).toMatchObject({ state: 'missing' })
  })

  it('a live meeting shows the newest preview of the open chunk; an older one never replaces it; the canonical chunk clears it', async () => {
    expect((await chunk('provisional_live', 0)).json).toMatchObject({ text: CANONICAL })
    await preview('provisional_live', 1, 2)
    const shown = await provisional('provisional_live')
    expect(shown.json).toMatchObject({ v: 1, live: true, provisional: { chunkIndex: 1, previewGen: 2, text: 'Marlow will send the kiosk', model: 'large-v3-turbo', at: expect.any(Number) } })
    previewText = 'an older draft of the same phrase'
    await preview('provisional_live', 1, 1)                     // older generation: ignored
    expect((await provisional('provisional_live')).json.provisional).toMatchObject({ previewGen: 2, text: 'Marlow will send the kiosk' })
    previewText = 'a preview for the chunk that already settled'
    await preview('provisional_live', 0, 9)                     // chunk 0 is canonical already: stale
    expect((await provisional('provisional_live')).json.provisional).toMatchObject({ chunkIndex: 1, text: 'Marlow will send the kiosk' })
    previewText = 'Marlow will send the kiosk quote by Friday'
    await preview('provisional_live', 1, 3)                     // newer generation: replaces
    expect((await provisional('provisional_live')).json.provisional).toMatchObject({ previewGen: 3, text: 'Marlow will send the kiosk quote by Friday' })
    await chunk('provisional_live', 1)                          // the canonical answer for chunk 1
    expect((await provisional('provisional_live')).json).toMatchObject({ live: true, provisional: null })
    // The preview text never reached the session file or any other file.
    expect(everythingOnDisk(root)).not.toContain('kiosk quote')
    expect(everythingOnDisk(root)).not.toContain('Marlow')
    stream.deleteSession('provisional_live')
  })

  it('a closed meeting serves nothing, even a preview held when it closed', async () => {
    await chunk('provisional_closed', 0)
    await preview('provisional_closed', 1, 1)
    expect((await provisional('provisional_closed')).json.provisional).not.toBeNull()
    stream.deleteSession('provisional_closed')
    expect((await provisional('provisional_closed')).json).toMatchObject({ live: false, provisional: null })
    // The close dropped it from memory, not only from the answer.
    const { liveProvisional } = await import('../lib/live-provisional.js')
    expect(liveProvisional().read('provisional_closed')).toBeNull()
    // A late preview after the close is not stored either.
    await preview('provisional_closed', 2, 1)
    expect(liveProvisional().read('provisional_closed')).toBeNull()
    expect((await provisional('provisional_closed')).json).toMatchObject({ live: false, provisional: null })
  })

  it('a session this server does not hold is never served, even if memory held something for it', async () => {
    const { liveProvisional } = await import('../lib/live-provisional.js')
    liveProvisional().record('provisional_ghost', { chunkIndex: 0, previewGen: 1, text: 'held for no live meeting', model: 'm' })
    expect((await provisional('provisional_ghost')).json).toMatchObject({ live: false, provisional: null })
  })

  it('a preview for a chunk that already settled is not stored, even with nothing held', async () => {
    await chunk('provisional_settled', 0)
    await preview('provisional_settled', 0, 1)
    expect((await provisional('provisional_settled')).json).toMatchObject({ live: true, provisional: null })
    stream.deleteSession('provisional_settled')
  })

  it('never logs the provisional or the canonical text', async () => {
    previewText = 'Ondine promised the Saltmarsh rollout plan'
    await chunk('provisional_log', 0)
    await preview('provisional_log', 1, 1)
    await provisional('provisional_log')
    await chunk('provisional_log', 1)
    expect(lines.length).toBeGreaterThan(0)                      // the route did log (timing lines), so absence below means something
    for (const word of ['Ondine', 'Saltmarsh', 'harbor', 'kiosk']) expect(lines.filter(l => l.includes(word)), word).toEqual([])
    stream.deleteSession('provisional_log')
  })

  it('a Mac recording gets the same grey line once COS Control posts its open chunk to the preview route', async () => {
    const mac = 'mac_2c3d4e5f-0000-4000-8000-00000000beef'
    const started = await new Promise<number>((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ captureId: mac, startTime: 1700000000000, sourceType: 'mac_system_audio' }))
      const req = request(`${base}/api/mac-recording/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), ...pin } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
      req.on('error', reject); req.end(body)
    })
    expect(started).toBe(200)
    expect((await provisional(mac)).json).toMatchObject({ live: true, provisional: null })   // no preview posted yet: nothing grey
    previewText = 'the open phrase on this Mac'
    await preview(mac, 0, 1)
    expect((await provisional(mac)).json).toMatchObject({ live: true, provisional: { chunkIndex: 0, previewGen: 1, text: 'the open phrase on this Mac' } })
    stream.deleteSession(mac)
  })

  it('refuses a malformed sessionId', async () => {
    for (const bad of ['', 'ab', 'a b', '../x', 'x'.repeat(97)]) expect((await provisional(encodeURIComponent(bad))).status, bad).toBe(400)
  })
})

describe('LiveProvisionalStore (6.86.0)', () => {
  let now = 1_000_000
  const s = () => new LiveProvisionalStore(() => now)
  beforeEach(() => { now = 1_000_000 })

  it('keeps the last maxChars code points, whitespace collapsed; an empty preview is refused', () => {
    const store = s()
    expect(store.record('a1x', { chunkIndex: 0, previewGen: 1, text: '   ', model: 'm' })).toBe(false)
    const long = 'é'.repeat(LIVE_PROVISIONAL_LIMITS.maxChars) + '  tail  words'
    expect(store.record('a1x', { chunkIndex: 0, previewGen: 1, text: long, model: 'm' })).toBe(true)
    const held = store.read('a1x')!
    expect(Array.from(held.text)).toHaveLength(LIVE_PROVISIONAL_LIMITS.maxChars)
    expect(held.text.endsWith('é tail words')).toBe(true)
  })
  it('a later chunk replaces; the same chunk needs a later previewGen; an earlier chunk never does', () => {
    const store = s()
    store.record('a1x', { chunkIndex: 3, previewGen: 5, text: 'three', model: 'm' })
    expect(store.record('a1x', { chunkIndex: 3, previewGen: 5, text: 'same gen', model: 'm' })).toBe(false)
    expect(store.record('a1x', { chunkIndex: 2, previewGen: 99, text: 'earlier chunk', model: 'm' })).toBe(false)
    expect(store.record('a1x', { chunkIndex: 3, previewGen: 6, text: 'later gen', model: 'm' })).toBe(true)
    expect(store.record('a1x', { chunkIndex: 4, previewGen: 0, text: 'next chunk', model: 'm' })).toBe(true)
    expect(store.read('a1x')?.text).toBe('next chunk')
  })
  it('settle drops a preview for that chunk or an earlier one, never a later one', () => {
    const store = s()
    store.record('a1x', { chunkIndex: 4, previewGen: 0, text: 'four', model: 'm' })
    store.settle('a1x', 3)
    expect(store.read('a1x')?.text).toBe('four')
    store.settle('a1x', 4)
    expect(store.read('a1x')).toBeNull()
  })
  it('an entry older than ttlMs reads as none, and a stale entry no longer blocks an earlier chunk', () => {
    const store = s()
    store.record('a1x', { chunkIndex: 4, previewGen: 0, text: 'four', model: 'm' })
    now += LIVE_PROVISIONAL_LIMITS.ttlMs
    expect(store.read('a1x')?.text).toBe('four')
    now += 1
    expect(store.read('a1x')).toBeNull()
    store.record('b1x', { chunkIndex: 9, previewGen: 0, text: 'nine', model: 'm' })
    now += LIVE_PROVISIONAL_LIMITS.ttlMs + 1
    expect(store.record('b1x', { chunkIndex: 1, previewGen: 0, text: 'one', model: 'm' })).toBe(true)
  })
  it('holds at most maxSessions meetings, evicting the one updated longest ago', () => {
    const store = s()
    for (let i = 0; i < LIVE_PROVISIONAL_LIMITS.maxSessions + 2; i++) { store.record(`m${i}x`, { chunkIndex: 0, previewGen: 0, text: `t${i}`, model: 'm' }); now += 1 }
    expect(store.size()).toBe(LIVE_PROVISIONAL_LIMITS.maxSessions)
    expect(store.read('m0x')).toBeNull()
    expect(store.read('m1x')).toBeNull()
    expect(store.read(`m${LIVE_PROVISIONAL_LIMITS.maxSessions + 1}x`)?.text).toBe(`t${LIVE_PROVISIONAL_LIMITS.maxSessions + 1}`)
  })
  it('an update makes a meeting the newest, so a busy meeting is not the one evicted', () => {
    const store = s()
    for (let i = 0; i < LIVE_PROVISIONAL_LIMITS.maxSessions; i++) { store.record(`m${i}x`, { chunkIndex: 0, previewGen: 0, text: `t${i}`, model: 'm' }); now += 1 }
    store.record('m0x', { chunkIndex: 0, previewGen: 1, text: 'busy', model: 'm' })
    store.record('newx', { chunkIndex: 0, previewGen: 0, text: 'new', model: 'm' })
    expect(store.read('m0x')?.text).toBe('busy')
    expect(store.read('m1x')).toBeNull()
  })
  it('the capability names the route and its bounds', () => {
    expect(liveMeetingCapability()).toEqual({ protocol: 1, macLiveCues: true, provisional: { route: '/api/transcribe-stream/provisional', maxChars: 600, ttlMs: 30_000 } })
  })
})
