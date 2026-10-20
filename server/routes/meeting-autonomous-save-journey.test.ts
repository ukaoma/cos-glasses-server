// 6.81.0 journey, against the REAL chunk route, the REAL session map and the REAL save route.
//
// The phone records a G2 meeting, the wearer presses Stop with the phone in a pocket, and
// the companion never comes back on screen. Before 6.81.0 nothing saved that meeting until
// the phone did (or the 4 h stranded sweep). Here the phone sends only what a hidden
// WebView can still send (chunk uploads and one Stop POST); it never calls /meeting/save.
//
// Only ASR is mocked, so no chunk reaches the whisper-server on this Mac. Each test has its
// own data home, profile path, HOME and maintenance gate path: importing these modules runs
// boot recovery and starts timers (the stale-session suite's pattern).

import express from 'express'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SID = 'meeting_1792513168486_qbbgyq'
const ENV_KEYS = ['COS_DATA_DIR', 'COS_PROFILE_PATH', 'HOME', 'COS_MAINTENANCE_GATE_PATH', 'COS_API_TOKEN', 'COS_SERVER_GENERATION_ID', 'COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR'] as const
const ASR_MOCKS = ['../lib/whisper-local.js', '../lib/audio-enhance.js', '../lib/speaker-embeddings.js', '../lib/vad-silero.js']
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
let dataDir = ''
let root = ''
const servers: Server[] = []
let asrCalls = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-auto-save-journey-'))
  dataDir = join(root, 'data')
  mkdirSync(join(root, 'home'), { recursive: true })
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  process.env.COS_DATA_DIR = dataDir
  process.env.COS_PROFILE_PATH = join(root, 'profile.json')
  process.env.HOME = join(root, 'home')
  process.env.COS_MAINTENANCE_GATE_PATH = join(root, 'gate', 'maintenance-gate.json')
  for (const key of ['COS_API_TOKEN', 'COS_SERVER_GENERATION_ID', 'COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR'] as const) delete process.env[key]
  asrCalls = 0
  vi.resetModules()
  vi.doMock('../lib/whisper-local.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/whisper-local.js')>()),
    transcribeLocal: vi.fn(async () => {
      asrCalls++
      return { text: `We agreed to ship the pricing page on Thursday, point ${asrCalls}.`, words: [], backend: 'mock' }
    }),
  }))
  vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
  vi.doMock('../lib/speaker-embeddings.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/speaker-embeddings.js')>()),
    identifySpeaker: () => null, isEmbeddingAvailable: () => false,
  }))
  vi.doMock('../lib/vad-silero.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/vad-silero.js')>()),
    trimSilence: vi.fn(), isSileroAvailable: () => false,
  }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const mod of ASR_MOCKS) vi.doUnmock(mod)
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})

/** 3 s of loud 16 kHz mono PCM: not silence, so the quiet gate sends it to (mocked) ASR. */
function speechWav(): Buffer {
  const samples = 16_000 * 3
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8)
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 7) * 12_000), 44 + i * 2)
  return wav
}

async function mount() {
  const stream = await import('./transcribe-stream.js')
  const { initializeServerInstanceId } = await import('../lib/server-instance-id.js')
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { MeetingFinalizationJobStore } = await import('../lib/meeting-finalization-jobs.js')
  const { getStopIntentStore } = await import('../lib/meeting-stop-intents.js')
  const { AUTONOMOUS_FINALIZE_SETTLE_MS } = await import('../lib/meeting-autonomous-finalize.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const serverInstanceId = initializeServerInstanceId(join(dataDir, 'server-instance-id'))
  const store = new MeetingStore(join(dataDir, 'recordings'))
  let offset = 0
  let finalizer: { tick(trigger?: string): Promise<void> } | null = null
  const log = vi.fn()
  const app = express()
  app.use(express.json())
  app.use('/api', stream.transcribeStreamRouter)
  app.use('/api', createMeetingRouter({
    store,
    finalizationJobs: new MeetingFinalizationJobStore(join(dataDir, 'meeting-finalization-jobs')),
    scheduleBackground: () => {},
    runBatch: async () => { throw new Error('no batch in this journey') },
    finalDiarize: async () => ({ applied: false, reason: 'test' }) as never,
    transcriptCleanup: async () => ({ applied: false, reason: 'test' }) as never,
    emit: vi.fn() as never,
    autonomousFinalize: {
      now: () => Date.now() + offset,
      schedule: () => () => {},
      log,
      onCreate: created => { finalizer = created },
    },
  }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const json = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'X-COS-Server-Instance': serverInstanceId } })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  // The phone's local-first upload: the same route and query a hidden WebView's fetch uses.
  const uploadChunk = (chunkIndex: number) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const audio = speechWav()
    const req = request(`${base}/api/transcribe-stream?sessionId=${SID}&chunkIndex=${chunkIndex}&speaker=MU&elapsed=${chunkIndex * 3_000}`, {
      method: 'POST',
      headers: { 'Content-Length': String(audio.length), 'Content-Type': 'application/octet-stream', 'X-COS-Server-Instance': serverInstanceId },
    }, res => {
      let text = ''
      res.on('data', part => { text += part })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }))
    })
    req.on('error', reject)
    req.end(audio)
  })
  const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })
  const meetingFiles = () => {
    const dir = join(dataDir, 'recordings')
    try { return readdirSync(dir).flatMap(month => readdirSync(join(dir, month)).filter(name => name.endsWith('.md'))) } catch { return [] }
  }
  return {
    stream, store, log, json, uploadChunk, post, meetingFiles, intents: getStopIntentStore(),
    stop: (finalChunkIndex: number) => json(`/api/meeting/sessions/${SID}/stop`, post({ finalChunkIndex })),
    skipSettle: () => { offset += AUTONOMOUS_FINALIZE_SETTLE_MS + 1_000 },
    tick: () => finalizer!.tick('journey'),
  }
}

describe('journey (real routes): phone hidden after Stop, never saves', () => {
  it('the Mac waits for the held last chunk, merges it, saves ONE meeting, and answers the phone\'s late replays', async () => {
    const m = await mount()
    // While recording, three chunks reached the Mac.
    for (const i of [0, 1, 2]) expect((await m.uploadChunk(i)).body).toMatchObject({ asrCompleted: true, canonical: true })
    // Stop with the phone in a pocket: chunk 3 is still held on the phone (IndexedDB suspended).
    const stop = await m.stop(3)
    expect(stop.status).toBe(202)
    m.skipSettle()
    await m.tick()
    expect(m.meetingFiles()).toEqual([])
    expect(m.intents.get(SID)!.lastWait).toMatchObject({ reason: 'missing_chunks', missingSample: [3] })
    expect(m.stream.getMeetingSessionStatus(SID).state).toBe('active')

    // The held chunk finally uploads (one background fetch): it lands in the SAME live session.
    expect((await m.uploadChunk(3)).body).toMatchObject({ canonical: true, chunkIndex: 3 })
    m.skipSettle()
    await m.tick()

    const files = m.meetingFiles()
    expect(files).toHaveLength(1)
    const savedMeeting = m.store.findBySessionId(SID)!
    const sidecar = JSON.parse(readFileSync(savedMeeting.sidecarPath, 'utf-8'))
    expect(sidecar.chunkEntries.map((entry: { chunkIndex: number }) => entry.chunkIndex)).toEqual([0, 1, 2, 3])
    expect(savedMeeting.transferIntegrity?.missingIndices).toEqual([])
    expect(m.intents.get(SID)).toMatchObject({ state: 'saved', savedBy: 'server', chunkCount: 4, canonicalCount: 4 })
    expect(m.log).toHaveBeenCalledWith('finalized', expect.objectContaining({ sessionId: SID, chunks: 4, gaps: 0 }))
    expect(m.stream.isSessionDeleted(SID)).toBe(true)

    // The phone comes back. Chunk 2's answer was lost while it was hidden, so it re-sends it:
    // the saved meeting holds it and answers with its text (before 6.81.0: 410, a collision).
    const asrBefore = asrCalls
    const replay = await m.uploadChunk(2)
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ sessionId: SID, chunkIndex: 2, asrCompleted: true, canonical: true, text: sidecar.chunkEntries[2].chunk.text })
    expect(asrCalls).toBe(asrBefore) // a replay never re-transcribes
    expect(m.intents.get(SID)).toMatchObject({ lateReplays: 1, phoneConfirmedBy: 'chunk_replay' })

    // A chunk the saved meeting never held is still refused, and counted.
    const stray = await m.uploadChunk(9)
    expect(stray.status).toBe(410)
    expect(m.intents.get(SID)).toMatchObject({ lateRefused: 1 })

    // The phone's own finalize: status says saved with the receipt, save replays it. Still one meeting.
    const status = await m.json(`/api/meeting/sessions/${SID}/status`)
    expect(status.body).toMatchObject({ state: 'saved', saveReceipt: { saved: true, filename: savedMeeting.filename } })
    const phoneSave = await m.json('/api/meeting/save', m.post({ sessionId: SID }))
    expect(phoneSave.body).toMatchObject({ saved: true, replayed: true, filename: savedMeeting.filename })
    expect(m.meetingFiles()).toHaveLength(1)
  })

  it('scope: a meeting the PHONE saved still refuses a late chunk with 410, exactly as before', async () => {
    const m = await mount()
    for (const i of [0, 1]) await m.uploadChunk(i)
    // The phone sent its Stop AND saved itself (the normal, on-screen path).
    expect((await m.stop(1)).status).toBe(202)
    expect((await m.json('/api/meeting/save', m.post({ sessionId: SID }))).body).toMatchObject({ saved: true })
    expect(m.intents.get(SID)).toMatchObject({ state: 'saved', savedBy: 'phone' })
    expect((await m.uploadChunk(1)).status).toBe(410)
    // Not even counted as a late chunk: the replay path is only for the server's own saves.
    expect(m.intents.get(SID)!.lateRefused).toBeUndefined()
  })

  it('a phone racing the Mac on the real save route still yields one meeting', async () => {
    const m = await mount()
    for (const i of [0, 1, 2]) await m.uploadChunk(i)
    await m.stop(2)
    m.skipSettle()
    const [, phone] = await Promise.all([m.tick(), m.json('/api/meeting/save', m.post({ sessionId: SID }))])
    if (phone.status === 409) expect(phone.body.reason).toBe('save_in_progress')
    else expect(phone.body).toMatchObject({ saved: true })
    await m.tick()
    expect(m.meetingFiles()).toHaveLength(1)
    expect(m.intents.get(SID)!.state).toBe('saved')
  })
})
