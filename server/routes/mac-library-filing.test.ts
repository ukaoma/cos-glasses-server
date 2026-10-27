// 6.94.0: a Mac recording saved through the real routes is filed into the COS meeting library.
//
// The operations tree is a temp path with spaces, dots and domain folders, and sync_meetings.py
// is the contract fake (lib/__fixtures__/fake-sync-meetings.ts), so nothing reaches a model,
// Qdrant or LightRAG. The standalone summary is mocked; its CALL ORDER relative to the filing is
// what these tests pin. Importing server modules runs them, so the data dir, HOME and profile
// path are scratch directories set before the first import.

import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { wavOf } from '../lib/__fixtures__/nemotron-helpers.js'
import { readFakeInvocations, writeFakeSyncMeetings } from '../lib/__fixtures__/fake-sync-meetings.js'

const id = 'mac_abcdef01-2345-6789-abcd-0123456789ab'
const CAPS = { schema: 1, g2_import: 1, mac_import: 1, mac_twins: 2 }
const savedEnv = { ...process.env }
let root: string, ops: string, scripts: string, server: Server, base: string
const background: Promise<void>[] = []
const order: string[] = []

async function boot(options: { phone?: boolean } = {}): Promise<void> {
  vi.resetModules()
  if (options.phone) {
    vi.doMock('../lib/meeting-batch-transcribe.js', async original => ({ ...await original<typeof import('../lib/meeting-batch-transcribe.js')>(), scheduleProgressiveHqCheckpoint: vi.fn() }))
    vi.doMock('../lib/parakeet.js', async original => ({ ...await original<typeof import('../lib/parakeet.js')>(), parakeetInstalled: () => ({ installed: true, bytes: 1 }), transcribeParakeet: vi.fn(async () => ({ model: 'parakeet-ultra', text: 'We reviewed the launch plan.', words: [{ word: 'We', start: 0, end: 0.4 }], processingSec: 0.1, wallMs: 120 })) }))
  }
  vi.doMock('../lib/server-instance-id.js', () => ({ getServerInstanceId: () => 'server-mac' }))
  vi.doMock('../lib/whisper-local.js', () => ({ transcribeLocal: vi.fn(async () => ({ text: 'ARR passed one hundred million and EBITDA is on plan.', backend: 'server' })), applyCorrections: (s: string) => s }))
  vi.doMock('../lib/speaker-embeddings.js', async original => ({ ...await original<typeof import('../lib/speaker-embeddings.js')>(), identifySpeaker: vi.fn(() => ({ speaker: 'Ext', similarity: 0.2, embedding: new Float32Array(192) })), extractEmbedding: vi.fn(() => new Float32Array([1, 0])), isEmbeddingAvailable: () => true, autoEnroll: vi.fn(), getEmbeddingCount: () => 0 }))
  vi.doMock('../lib/profile.js', () => ({ loadProfileObject: () => ({}), getDomainKeywords: () => ({}), getVocabulary: () => [], getOwnerName: () => 'COS', getOwnerSpeakerLabel: () => 'MU', getWhisperCorrections: () => '' }))
  vi.doMock('../lib/vad-silero.js', () => ({ isSileroAvailable: () => false, measureSpeechSeconds: () => null, trimSilence: vi.fn() }))
  vi.doMock('../lib/stt-live.js', async original => ({ ...await original<typeof import('../lib/stt-live.js')>(), decideQuiet: () => ({ isQuiet: false, rms: 400, speechSec: 3, gate: 'rms' }), asrFrontEnd: async (b: Buffer) => b }))
  vi.doMock('../lib/nemotron-live.js', async original => ({ ...await original<typeof import('../lib/nemotron-live.js')>(), nemotronLive: { diarize: vi.fn(async () => ({ ok: false, reason: 'embedding_requested' })), record: vi.fn(), snapshot: () => ({}) } }))
  vi.doMock('../lib/meeting-summary-persistence.js', () => ({ enrichStandaloneMeeting: vi.fn(async () => { order.push('standalone-summary') }) }))
  vi.doMock('../lib/meeting-actions.js', async original => ({ ...await original<typeof import('../lib/meeting-actions.js')>(), triggerMeetingMergeRun: vi.fn((reason: string) => { order.push(`merge:${reason}`) }) }))
  if (options.phone) {
    const stt = await import('../lib/stt-settings.js')
    stt.writeSttSettings({ ...stt.readSttSettings(), hq: 'parakeet-ultra' })
  }
  const stream = await import('./transcribe-stream.js')
  const app = express(); app.use(express.json()); app.use('/api', stream.transcribeStreamRouter)
  const { createMeetingRouter } = await import('./meeting.js')
  app.use('/api', createMeetingRouter({ runBatch: async () => ({ transcriptionQuality: 'streaming' }), finalDiarize: vi.fn(async () => ({ applied: false, reason: 'test' } as never)), scheduleBackground: task => { background.push(task) }, emit: vi.fn() }))
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
}

async function stop(): Promise<void> {
  await Promise.allSettled(background.splice(0))
  await new Promise<void>(resolve => server?.listening ? server.close(() => resolve()) : resolve())
}

async function call(path: string, body?: unknown) {
  const headers: Record<string, string> = { 'X-COS-Server-Instance': 'server-mac' }
  if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? 'audio/wav' : 'application/json'
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body).buffer : JSON.stringify(body) })
  return { status: response.status, json: await response.json() as any }
}

async function recordAndSave() {
  expect((await call('/mac-recording/start', { captureId: id, startTime: 1793113331911, sourceType: 'mac_system_audio' })).status).toBe(200)
  expect((await call(`/mac-recording/${id}/chunks?chunkIndex=0&elapsed=6000`, wavOf(6, () => 400))).status).toBe(200)
  const saved = await call('/meeting/save', { sessionId: id, expectedChunkCount: 1 })
  expect(saved.status).toBe(200)
  await Promise.allSettled(background.splice(0))
  return saved
}

function library(): string[] {
  const out: string[] = []
  for (const domain of ['quilt', 'personal']) {
    for (const month of existsSync(join(ops, domain, 'meetings')) ? readdirSync(join(ops, domain, 'meetings')) : []) {
      for (const name of readdirSync(join(ops, domain, 'meetings', month))) out.push(`${domain}/${month}/${name}`)
    }
  }
  return out.sort()
}

function setup(capabilities: Record<string, unknown> | undefined): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-mac-library-route-')))
  ops = join(root, 'Ukaoma Chief Of Staff', 'MU-Chief.Staff', 'operations')
  for (const domain of ['quilt', 'personal']) mkdirSync(join(ops, domain, 'meetings', '2026-10'), { recursive: true })
  scripts = join(ops, 'scripts')
  writeFakeSyncMeetings(scripts, capabilities === undefined ? {} : { capabilities })
  process.env.COS_DATA_DIR = join(root, 'COS Glasses.data')
  process.env.HOME = join(root, 'home'); mkdirSync(process.env.HOME, { recursive: true })
  process.env.COS_PROFILE_PATH = join(root, 'profile.json')
  process.env.COS_SCRIPTS_DIR = scripts
  delete process.env.COS_OPERATIONS_DIR
  order.length = 0
}

afterEach(async () => {
  await stop()
  vi.resetModules()
  for (const mod of ['meeting-batch-transcribe', 'parakeet', 'server-instance-id', 'whisper-local', 'speaker-embeddings', 'profile', 'vad-silero', 'stt-live', 'nemotron-live', 'meeting-summary-persistence', 'meeting-actions', 'g2-enrichment-runner']) vi.doUnmock(`../lib/${mod}.js`)
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  rmSync(root, { recursive: true, force: true })
})

it('files a saved Mac recording after its standalone summary, once, through --mac-import-file only', async () => {
  setup(CAPS)
  await boot()
  const saved = await recordAndSave()
  const local = join(process.env.COS_DATA_DIR!, saved.json.filepath)
  expect(readFakeInvocations(scripts)).toEqual([
    { args: ['--capabilities'], importRoot: null },
    { args: ['--mac-import-file', local, '--quiet'], importRoot: join(process.env.COS_DATA_DIR!, 'recordings') },
  ])
  expect(order).toEqual(['standalone-summary'])
  expect(library()).toEqual([
    'quilt/2026-10/2026-10-27_Q4_Plan_and_Investor_Process_(Mac).g2-chunks.json',
    'quilt/2026-10/2026-10-27_Q4_Plan_and_Investor_Process_(Mac).md',
  ])
  // The local recording is exactly what 6.93.0 wrote: Mac source, standalone placeholder, no G2 markers.
  const markdown = readFileSync(local, 'utf8')
  expect(markdown).toContain('| **Source** | Mac System Audio |')
  expect(markdown).not.toContain('G2 Glasses')
  expect(markdown).not.toContain('g2-needs-domain-review')
})

it('files only after the capture finalization is complete and its job removed', async () => {
  setup(CAPS)
  process.env.FAKE_SYNC_PROBE_DIR = join(process.env.COS_DATA_DIR!, 'meeting-finalization-jobs')
  await boot()
  await recordAndSave()
  const filing = readFakeInvocations(scripts).filter(call => call.args[0] === '--mac-import-file')
  expect(filing).toHaveLength(1)
  expect(filing[0].probe).toEqual([])
})

it('never files twice across a re-save and a restart', async () => {
  setup(CAPS)
  await boot()
  const saved = await recordAndSave()
  const replay = await call('/meeting/save', { sessionId: id, expectedChunkCount: 1 })
  expect(replay.json).toMatchObject({ saved: true, replayed: true, filename: saved.json.filename })
  await Promise.allSettled(background.splice(0))
  await stop()
  await boot()
  const afterRestart = await call('/meeting/save', { sessionId: id, expectedChunkCount: 1 })
  expect(afterRestart.json).toMatchObject({ saved: true, replayed: true, filename: saved.json.filename })
  await Promise.allSettled(background.splice(0))
  expect(readFakeInvocations(scripts).filter(call => call.args[0] === '--mac-import-file')).toHaveLength(1)
  expect(library()).toHaveLength(2)
})

it('stays standalone against a sync_meetings.py without the capability and never labels the file G2', async () => {
  setup(undefined)
  await boot()
  const saved = await recordAndSave()
  expect(readFakeInvocations(scripts)).toEqual([])
  expect(library()).toEqual([])
  expect(order).toEqual(['standalone-summary'])
  const markdown = readFileSync(join(process.env.COS_DATA_DIR!, saved.json.filepath), 'utf8')
  expect(markdown).toContain('| **Source** | Mac System Audio |')
  expect(markdown).not.toContain('G2 Glasses')
})

it('a failed filing is logged and never fails the capture, which stays saved and finished', async () => {
  setup(CAPS)
  writeFakeSyncMeetings(scripts, { capabilities: CAPS, macImportExit: 2 })
  // One attempt instead of the production 0 s, 15 s, 60 s ladder.
  vi.doMock('../lib/g2-enrichment-runner.js', async original => {
    const real = await original<typeof import('../lib/g2-enrichment-runner.js')>()
    return { ...real, runG2EnrichmentWithRetry: (options: Parameters<typeof real.runG2EnrichmentWithRetry>[0], deps?: Parameters<typeof real.runG2EnrichmentWithRetry>[1]) => real.runG2EnrichmentWithRetry({ ...options, retryDelaysMs: [0] }, deps) }
  })
  await boot()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const saved = await recordAndSave()
    expect((await call(`/meeting/sessions/${id}/status`)).json).toMatchObject({ state: 'saved' })
    expect(warn.mock.calls.some(args => String(args[0]).includes(`Mac recording ${id} was not filed into the library`))).toBe(true)
    expect(existsSync(join(process.env.COS_DATA_DIR!, saved.json.filepath))).toBe(true)
    expect(library()).toEqual([])
    expect(readFakeInvocations(scripts).filter(call => call.args[0] === '--mac-import-file')).toHaveLength(1)
  } finally {
    warn.mockRestore()
  }
})

function filingLogs(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(args => String(args[0])).filter(line => /Mac recording .* (filed into|stays standalone|was not filed)/.test(line))
}

it('without COS operations a Mac recording is untouched and nothing about filing is logged', async () => {
  setup(CAPS)
  delete process.env.COS_SCRIPTS_DIR
  await boot()
  const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn')
  try {
    await recordAndSave()
    expect(order).toEqual(['standalone-summary'])
    expect(filingLogs(log)).toEqual([])
    expect(filingLogs(warn)).toEqual([])
    expect(readFakeInvocations(scripts)).toEqual([])
  } finally {
    log.mockRestore(); warn.mockRestore()
  }
})

it('an iPhone microphone meeting is never offered to the Mac filing, with operations configured', async () => {
  setup(CAPS)
  process.env.COS_IPHONE_MICROPHONE_MEETINGS = '1'
  await boot({ phone: true })
  const phone = 'phone_abcdef01-2345-6789-abcd-0123456789ab'
  const source = { sourceType: 'iphone_microphone', speakerPolicy: 'anonymous' }
  const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn')
  try {
    const query = new URLSearchParams({ sessionId: phone, chunkIndex: '0', elapsed: '0', startTime: '1793113331911', speaker: 'Ext', ...source })
    expect((await call('/transcribe-stream?' + query, wavOf(6, () => 400))).status).toBe(200)
    const saved = await call('/meeting/save', { sessionId: phone, ...source, finalChunkIndex: 0 })
    expect(saved.status).toBe(200)
    await Promise.allSettled(background.splice(0))
    expect(order).toEqual(['standalone-summary'])
    expect(filingLogs(log)).toEqual([])
    expect(filingLogs(warn)).toEqual([])
    expect(readFakeInvocations(scripts)).toEqual([])
    expect(library()).toEqual([])
  } finally {
    log.mockRestore(); warn.mockRestore()
  }
})
