// Title steer (6.99.0) through the REAL Mac recording routes: start, chunk, rename while recording, save and recover.
// Same boot as mac-library-filing.test.ts (heavy ASR and embedding modules mocked, scratch data dir, module reload per
// test) because importing server modules runs them. Synthetic text only. Nothing reaches a model or the COS library.

import express from 'express'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { wavOf } from '../lib/__fixtures__/nemotron-helpers.js'

const id = 'mac_abcdef01-2345-6789-abcd-0123456789ab'
const savedEnv = { ...process.env }
let root: string, server: Server, base: string
let stream: typeof import('./transcribe-stream.js')
const background: Promise<void>[] = []

async function boot(): Promise<void> {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-mac-title-steer-')))
  process.env.COS_DATA_DIR = join(root, 'COS Glasses.data')
  process.env.HOME = join(root, 'home'); mkdirSync(process.env.HOME, { recursive: true })
  process.env.COS_PROFILE_PATH = join(root, 'profile.json')
  for (const key of ['COS_SCRIPTS_DIR', 'COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT']) delete process.env[key]
  vi.resetModules()
  vi.doMock('../lib/server-instance-id.js', () => ({ getServerInstanceId: () => 'server-mac' }))
  vi.doMock('../lib/whisper-local.js', async original => ({
    ...await original<typeof import('../lib/whisper-local.js')>(),
    transcribeLocal: vi.fn(async () => ({ text: 'ARR passed one hundred million and EBITDA is on plan.', backend: 'server' })),
    transcribeHighQuality: vi.fn(async () => ({ text: 'ARR passed one hundred million and EBITDA is on plan.', backend: 'server' })),
    applyCorrections: (s: string) => s,
  }))
  vi.doMock('../lib/speaker-embeddings.js', async original => ({ ...await original<typeof import('../lib/speaker-embeddings.js')>(), identifySpeaker: vi.fn(() => ({ speaker: 'Ext', similarity: 0.2, embedding: new Float32Array(192) })), extractEmbedding: vi.fn(() => new Float32Array([1, 0])), isEmbeddingAvailable: () => true, autoEnroll: vi.fn(), getEmbeddingCount: () => 0 }))
  vi.doMock('../lib/profile.js', () => ({ loadProfileObject: () => ({}), getDomainKeywords: () => ({}), getVocabulary: () => [], getOwnerName: () => 'COS', getOwnerSpeakerLabel: () => 'MU', getWhisperCorrections: () => '' }))
  vi.doMock('../lib/vad-silero.js', () => ({ isSileroAvailable: () => false, measureSpeechSeconds: () => null, trimSilence: vi.fn() }))
  vi.doMock('../lib/stt-live.js', async original => ({ ...await original<typeof import('../lib/stt-live.js')>(), decideQuiet: () => ({ isQuiet: false, rms: 400, speechSec: 3, gate: 'rms' }), asrFrontEnd: async (b: Buffer) => b }))
  vi.doMock('../lib/nemotron-live.js', async original => ({ ...await original<typeof import('../lib/nemotron-live.js')>(), nemotronLive: { diarize: vi.fn(async () => ({ ok: false, reason: 'embedding_requested' })), record: vi.fn(), snapshot: () => ({}) } }))
  vi.doMock('../lib/meeting-summary-persistence.js', () => ({ enrichStandaloneMeeting: vi.fn(async () => {}) }))
  vi.doMock('../lib/meeting-actions.js', async original => ({ ...await original<typeof import('../lib/meeting-actions.js')>(), triggerMeetingMergeRun: vi.fn() }))
  stream = await import('./transcribe-stream.js')
  const app = express(); app.use(express.json()); app.use('/api', stream.transcribeStreamRouter)
  const { createMeetingRouter } = await import('./meeting.js')
  app.use('/api', createMeetingRouter({ runBatch: async () => ({ transcriptionQuality: 'streaming' }), finalDiarize: vi.fn(async () => ({ applied: false, reason: 'test' } as never)), scheduleBackground: task => { background.push(task) }, emit: vi.fn() }))
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
}

afterEach(async () => {
  await Promise.allSettled(background.splice(0))
  await new Promise<void>(resolve => server?.listening ? server.close(() => resolve()) : resolve())
  vi.resetModules()
  for (const mod of ['server-instance-id', 'whisper-local', 'speaker-embeddings', 'profile', 'vad-silero', 'stt-live', 'nemotron-live', 'meeting-summary-persistence', 'meeting-actions']) vi.doUnmock(`../lib/${mod}.js`)
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  rmSync(root, { recursive: true, force: true })
})

async function call(path: string, body?: unknown, method?: string) {
  const headers: Record<string, string> = { 'X-COS-Server-Instance': 'server-mac' }
  if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? 'audio/wav' : 'application/json'
  const verb = method ?? (body === undefined ? 'GET' : 'POST')
  const response = await fetch(base + path, { method: verb, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body).buffer : JSON.stringify(body) })
  return { status: response.status, json: await response.json() as any }
}
const startRecording = () => call('/mac-recording/start', { captureId: id, startTime: 1793113331911, sourceType: 'mac_system_audio' })
const sendChunk = () => call(`/mac-recording/${id}/chunks?chunkIndex=0&elapsed=6000`, wavOf(6, () => 400))
const steer = (title: string | null, expectedRevision: number) => call('/meeting/title-steer', { sessionId: id, title, expectedRevision }, 'PUT')
const activeFile = () => JSON.parse(readFileSync(join(process.env.COS_DATA_DIR!, 'active-sessions', `${id}.json`), 'utf8')) as Record<string, any>

it('advertises titleSteer 1 on the Mac capabilities route', async () => {
  await boot()
  const caps = await call('/mac-recording/capabilities')
  expect(caps.status).toBe(200)
  expect(caps.json.titleSteer).toBe(1)
})

it('a live Mac recording takes a steer; the active-session record Control reads carries it at once, keeps it through the next chunk, and drops it when cleared', async () => {
  await boot()
  const started = await startRecording()
  expect(started.status).toBe(200)
  expect(started.json.titleSteer).toBeNull()
  expect('titleSteer' in activeFile()).toBe(false)
  const set = await steer('Polling accuracy chat', 0)
  expect(set.status, JSON.stringify(set.json)).toBe(200)
  expect(set.json).toMatchObject({ sessionId: id, title: 'Polling accuracy chat', revision: 1 })
  // Before any further chunk: the record on disk already says so.
  expect(activeFile().titleSteer).toBe('Polling accuracy chat')
  expect(activeFile().sessionId).toBe(id)
  // A chunk rewrites the record from memory; the steer rides along.
  expect((await sendChunk()).status).toBe(200)
  expect(activeFile().titleSteer).toBe('Polling accuracy chat')
  expect(activeFile().chunksIndexed.length).toBeGreaterThan(0)
  // A replayed start (Control relaunched) hears the steer.
  const replay = await startRecording()
  expect(replay.json).toMatchObject({ replayed: true, titleSteer: 'Polling accuracy chat' })
  expect((await call(`/meeting/sessions/${id}/status`)).json.titleSteer).toBe('Polling accuracy chat')
  // Clearing removes the key entirely.
  expect((await steer('', 1)).json).toMatchObject({ title: null, revision: 2 })
  expect('titleSteer' in activeFile()).toBe(false)
  expect((await call(`/meeting/sessions/${id}/status`)).json.titleSteer).toBeNull()
})

it('a recording that is not live is refused: 404 session_not_live before the start, and the steer is not stored', async () => {
  await boot()
  const early = await steer('Too early', 0)
  expect(early.status).toBe(404)
  expect(early.json.reason).toBe('session_not_live')
  expect((await call(`/meeting/title-steer?sessionId=${id}`)).json).toMatchObject({ title: null, revision: 0 })
  expect(existsSync(join(process.env.COS_DATA_DIR!, 'meeting-title-steer.json'))).toBe(false)
})

it('saving a Mac recording with no title files it under the steer and records the steer in the row and the sidecar', async () => {
  await boot()
  await startRecording(); await sendChunk()
  await steer('Polling accuracy chat', 0)
  const saved = await call('/meeting/save', { sessionId: id, expectedChunkCount: 1 })
  expect(saved.status, JSON.stringify(saved.json)).toBe(200)
  await Promise.allSettled(background.splice(0))
  const local = join(process.env.COS_DATA_DIR!, saved.json.filepath)
  const markdown = readFileSync(local, 'utf8')
  expect(markdown.startsWith('# Polling accuracy chat\n')).toBe(true)
  expect(markdown).toContain('| **Source** | Mac System Audio |')
  expect(markdown).toContain('| **Title steer** | Polling accuracy chat |')
  const sidecar = JSON.parse(readFileSync(local.replace(/\.md$/, '.g2-chunks.json'), 'utf8'))
  expect(sidecar).toMatchObject({ title: 'Polling accuracy chat', titleSteer: 'Polling accuracy chat', sourceType: 'mac_system_audio' })
  // The recording is closed: a later rename is refused.
  expect((await steer('Too late', 1)).status).toBe(404)
})

it('a Mac save that sends its own title keeps it and still records the steer', async () => {
  await boot()
  await startRecording(); await sendChunk()
  await steer('Polling accuracy chat', 0)
  const saved = await call('/meeting/save', { sessionId: id, expectedChunkCount: 1, title: 'Polling Accuracy and Weighting Debate (Mac)' })
  expect(saved.status).toBe(200)
  const local = join(process.env.COS_DATA_DIR!, saved.json.filepath)
  const markdown = readFileSync(local, 'utf8')
  expect(markdown.startsWith('# Polling Accuracy and Weighting Debate (Mac)\n')).toBe(true)
  expect(markdown).toContain('| **Title steer** | Polling accuracy chat |')
})

it('a recovered Mac capture (the orphan recovery save) files under the steer too', async () => {
  await boot()
  await startRecording(); await sendChunk()
  await steer('Board prep recovered', 0)
  stream.deleteSession(id, { preserveAudio: true })
  const quarantine = await import('../lib/unsaved-audio-quarantine.js')
  expect(quarantine.quarantineSessionAudio(join(process.env.COS_DATA_DIR!, 'session-audio', id), 'test_mac_recovery')).toBeTruthy()
  const recovery = await call(`/meeting/orphans/${id}/recover`, {})
  expect(recovery.status).toBe(202)
  const { getMeetingStore } = await import('../lib/meeting-store.js')
  await vi.waitFor(() => expect(getMeetingStore().findBySessionId(id)).not.toBeNull(), { timeout: 20_000, interval: 50 })
  await Promise.allSettled(background.splice(0))
  const found = getMeetingStore().findBySessionId(id)!
  const markdown = readFileSync(found.filepath, 'utf8')
  expect(markdown.startsWith('# Board prep recovered\n')).toBe(true)
  expect(markdown).toContain('| **Title steer** | Board prep recovered |')
  expect(JSON.parse(readFileSync(found.sidecarPath, 'utf8')).titleSteer).toBe('Board prep recovered')
}, 60_000)
