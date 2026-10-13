// 6.71.14: a capture the server finished must not read as a live recording.
//
// THE INCIDENT (Miles's Mac, server 6.71.11, meeting_1791831725740_e5c1fv). Two
// silent chunks arrived and were persisted to active-sessions/<id>.json. The server
// restarted behind a closed startup maintenance gate, so boot recovery was skipped,
// and nothing ran it once the gate opened. The orphaned audio was quarantined,
// auto-recovered and receipted no_speech; the active-session file stayed on disk for
// 17 hours. COS Control (which lists that directory) showed "Live now ... No audio
// for 1054m", and GET /api/meeting/sessions/<id>/status answered `missing`.
//
// The log lines were reported in this order: quarantine, recover, late Ext chunk,
// no_speech receipt. The first two are in server-error.log and the last two in
// server.log, so their relative order is an interleaving; inside server.log the
// chunk precedes the restart. Both orders are pinned here. In the reported order the
// late chunk is ACCEPTED, as in 6.71.13: the phone deletes its local copy on any 410
// `session_closed`, so refusing it would destroy audio the server never decoded.
//
// Driven against the real module and the real routes, with a private data home,
// profile path, HOME and maintenance gate path per test: importing these modules
// runs boot recovery and starts timers. The closed-gate cases use a REAL gate file
// released through the real lifecycle API, whose listeners are delivered on a
// microtask.

import express from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_FIRST_MEETING_IDLE_RETENTION_MS } from '../lib/local-first-meetings-contract.js'
import { STALE_ACTIVE_SESSION_DIR_NAME, STALE_ACTIVE_SESSION_FILE_RETENTION_MS } from '../lib/stale-active-session-files.js'
import { QUARANTINE_MANIFEST, RECOVERED_RECEIPT } from '../lib/unsaved-audio-quarantine.js'

const SID = 'meeting_1791831725740_e5c1fv'
const IDLE = LOCAL_FIRST_MEETING_IDLE_RETENTION_MS
const ENV_KEYS = ['COS_DATA_DIR', 'COS_PROFILE_PATH', 'HOME', 'COS_MAINTENANCE_GATE_PATH', 'COS_API_TOKEN', 'COS_SERVER_GENERATION_ID'] as const
const ASR_MOCKS = ['../lib/whisper-local.js', '../lib/audio-enhance.js', '../lib/speaker-embeddings.js', '../lib/vad-silero.js']
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
let dataDir = ''
let root = ''
const servers: Server[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-stale-session-'))
  dataDir = join(root, 'data')
  mkdirSync(join(root, 'home'), { recursive: true })
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  process.env.COS_DATA_DIR = dataDir
  process.env.COS_PROFILE_PATH = join(root, 'profile.json')
  process.env.HOME = join(root, 'home')
  process.env.COS_MAINTENANCE_GATE_PATH = join(root, 'gate', 'maintenance-gate.json')
  delete process.env.COS_API_TOKEN
  delete process.env.COS_SERVER_GENERATION_ID
  vi.resetModules()
  // ASR is mocked for every test: an accepted chunk must never reach the real
  // whisper-server on this Mac.
  vi.doMock('../lib/whisper-local.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/whisper-local.js')>()),
    transcribeLocal: vi.fn().mockResolvedValue({ text: '', words: [], backend: 'mock' }),
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const mod of ASR_MOCKS) vi.doUnmock(mod)
  vi.doUnmock('../lib/stale-active-session-files.js')
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})

const instanceIdPath = () => join(dataDir, 'server-instance-id')

/**
 * A committed cross-boot maintenance gate, written before import exactly as COS
 * Control leaves it for a successor. `releaseSync()` adopts and releases it through
 * the real lifecycle, which only QUEUES admissions-open listeners on a microtask.
 */
function realClosedGate() {
  const instanceId = randomUUID()
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(instanceIdPath(), `${instanceId}\n`, { mode: 0o600 })
  process.env.COS_SERVER_GENERATION_ID = 'gen-successor-test'
  const nonce = 'n'.repeat(40)
  const gate = {
    version: 2, leaseId: 'lease-test-1', operationId: 'op-test-1', operationKind: 'server_update', scope: 'cross_boot',
    postcondition: 'authorized_successor_adopted', nonceSha256: createHash('sha256').update(nonce, 'utf8').digest('hex'),
    authorizedSuccessorGenerations: ['gen-successor-test'], serverInstanceId: instanceId, sourceBootId: 'boot-before-update',
    sourceGenerationId: 'gen-before-update', startedAt: new Date().toISOString(), expiresAt: null,
  }
  const gatePath = process.env.COS_MAINTENANCE_GATE_PATH!
  mkdirSync(join(gatePath, '..'), { recursive: true, mode: 0o700 })
  chmodSync(join(gatePath, '..'), 0o700)
  writeFileSync(gatePath, JSON.stringify(gate), { mode: 0o600 })
  return {
    /** Resolves the real lifecycle once; the returned release is SYNCHRONOUS. */
    async prepare(): Promise<() => void> {
      const { maintenanceLifecycle } = await import('../lib/maintenance-lifecycle.js')
      const { serverMetrics } = await import('../lib/server-metrics.js')
      const identity = { operationId: gate.operationId, serverInstanceId: instanceId, bootId: serverMetrics.bootId, generationId: 'gen-successor-test' }
      const credentials = { leaseId: gate.leaseId, operationId: gate.operationId, nonce }
      return () => {
        maintenanceLifecycle.adoptDrain(identity, credentials)
        maintenanceLifecycle.releaseDrain(identity, credentials)
      }
    },
    async releaseSync() {
      (await this.prepare())()
    },
  }
}

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve))

async function mount() {
  const stream = await import('./transcribe-stream.js')
  const quarantine = await import('../lib/unsaved-audio-quarantine.js')
  const { initializeServerInstanceId } = await import('../lib/server-instance-id.js')
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { MeetingFinalizationJobStore } = await import('../lib/meeting-finalization-jobs.js')
  const { createMeetingRouter } = await import('./meeting.js')
  initializeServerInstanceId(instanceIdPath())
  const store = new MeetingStore(join(dataDir, 'recordings'))
  const app = express()
  app.use(express.json())
  app.use('/api', stream.transcribeStreamRouter)
  app.use('/api', createMeetingRouter({
    store,
    finalizationJobs: new MeetingFinalizationJobStore(join(dataDir, 'meeting-finalization-jobs')),
    scheduleBackground: () => {},
    emit: vi.fn() as never,
  }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const statusRes = async (id: string) => {
    const res = await fetch(`${base}/api/meeting/sessions/${id}/status`)
    return { code: res.status, body: await res.json() }
  }
  const status = async (id: string) => (await statusRes(id)).body
  const postChunk = (id: string, chunkIndex: number) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const audio = Buffer.alloc(44 + 3 * 32_000, 1)
    const req = request(`${base}/api/transcribe-stream?sessionId=${id}&chunkIndex=${chunkIndex}&speaker=Ext`, {
      method: 'POST',
      headers: { 'Content-Length': String(audio.length), 'Content-Type': 'application/octet-stream' },
    }, res => {
      let text = ''
      res.on('data', part => { text += part })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }))
    })
    req.on('error', reject)
    req.end(audio)
  })
  return { stream, quarantine, store, status, statusRes, postChunk, sessions: stream.__sessionsForTests as Map<string, any> }
}

const activeDir = () => join(dataDir, 'active-sessions')
const activeFile = (id: string) => join(activeDir(), `${id}.json`)
const staleDir = () => join(dataDir, STALE_ACTIVE_SESSION_DIR_NAME)
const audioDir = (id: string) => join(dataDir, 'session-audio', id)
const liveShape = (title = '') => ({ chunks: [], startTime: Date.now(), lastActivityAt: Date.now(), title, receivedIndices: [], asrCompletedIndices: [], emptyCompletions: {}, providerCandidates: {} })

/** What 6.71.11 left on disk: the two silent chunks' audio and their session file. */
function seedLiveCapture(id: string, lastActivityAt: number) {
  mkdirSync(audioDir(id), { recursive: true })
  writeFileSync(join(audioDir(id), 'chunk_0000.wav'), Buffer.alloc(44 + 32_000, 1))
  writeFileSync(join(audioDir(id), 'chunk_0001.wav'), Buffer.alloc(44 + 3_200, 1))
  mkdirSync(activeDir(), { recursive: true })
  writeFileSync(activeFile(id), JSON.stringify({
    sessionId: id, startTime: lastActivityAt - 9_000, lastActivityAt, title: '',
    chunks: [], chunksIndexed: [], receivedIndices: [0, 1], asrCompletedIndices: [0, 1],
    emptyCompletions: {}, maxChunkIndex: 1, providerCandidates: {},
  }))
}

/** A quarantine dir for the id; `receipt` null means held, not yet decoded. */
function seedQuarantine(id: string, receipt: Record<string, unknown> | null, reason = 'idle_expiry_unsaved', at = Date.now()) {
  const dir = join(dataDir, 'unsaved-audio', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'chunk_0000.wav'), Buffer.alloc(64))
  writeFileSync(join(dir, QUARANTINE_MANIFEST), JSON.stringify({
    schemaVersion: 1, sessionId: id, quarantinedAt: new Date(at).toISOString(), reason, chunkFiles: 1, bytes: 64,
  }))
  if (receipt) writeFileSync(join(dir, RECOVERED_RECEIPT), JSON.stringify({ schemaVersion: 1, recoveredAt: new Date(at + 1_000).toISOString(), ...receipt }))
  return dir
}

const NO_SPEECH = { outcome: 'no_speech', chunkFiles: 1, words: 0 }
const messages = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String(c[0]))

describe('the reported order: quarantine, recover, late Ext chunk, no_speech receipt', () => {
  it('the late chunk is accepted as in 6.71.13 (a 410 makes the phone delete its copy); the receipt rides beside the legacy state', async () => {
    const { quarantine, status, postChunk, sessions } = await mount()
    // 1. [cleanup] Quarantined unsaved session-audio
    mkdirSync(audioDir(SID), { recursive: true })
    writeFileSync(join(audioDir(SID), 'chunk_0000.wav'), Buffer.alloc(44 + 32_000, 1))
    writeFileSync(join(audioDir(SID), 'chunk_0001.wav'), Buffer.alloc(44 + 3_200, 1))
    const actions = quarantine.sweepOrphanedSessionAudio(join(dataDir, 'session-audio'), {
      isLive: id => sessions.has(id), hasFreshPreservedMarker: () => false, reason: 'idle_expiry_unsaved',
    })
    expect(actions.map(a => a.action)).toEqual(['quarantined'])
    // 2. [quarantine] Auto-recovered (accepted; the decode is still running)
    const qdir = quarantine.findQuarantineDir(SID)!
    quarantine.registerActiveRecovery(SID, qdir)
    const held = await status(SID)
    expect(held.state, 'state keeps its 6.71.13 values').toBe('missing')
    expect(held.outcome).toBe('quarantined')
    expect(held.disposition).toMatchObject({ kind: 'quarantined', reason: null, recovering: true })

    // 3. [ext-audio] the late chunk: kept, as its own live session.
    const late = await postChunk(SID, 2)
    expect(late.status, JSON.stringify(late.body)).toBe(200)
    expect(sessions.has(SID)).toBe(true)
    const live = await status(SID)
    expect(live.state).toBe('active')
    expect(live.outcome, 'a live session reports itself, not an older quarantine').toBeNull()
    expect(live.disposition).toBeNull()

    // 4. [meeting/orphans] held no speech, receipted as no_speech. Once the tail's
    // session is gone the receipt is what the route reports.
    quarantine.markRecoveredNoSpeech(qdir, 2)
    quarantine.clearActiveRecovery(qdir)
    sessions.delete(SID)
    const done = await status(SID)
    expect(done.state).toBe('missing')
    expect(done.outcome, 'a receipted capture must say so').toBe('receipted')
    expect(done.disposition).toMatchObject({ kind: 'no_speech', reason: 'no_speech', recovering: false, savedFilename: null })
  })

  it('an accepted first chunk for a brand-new id creates the session and its file', async () => {
    const { postChunk, sessions, status } = await mount()
    const first = await postChunk('meeting_brand_new_one', 0)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(sessions.has('meeting_brand_new_one')).toBe(true)
    expect(existsSync(activeFile('meeting_brand_new_one'))).toBe(true)
    expect((await status('meeting_brand_new_one')).state).toBe('active')
  })
})

describe('the real order: chunks persisted, restart behind a closed gate, then release', () => {
  it('real gate: recovery waits, status says recovery_pending (503), and release adopts the session on the microtask', async () => {
    seedLiveCapture(SID, Date.now() - 10 * 60_000)
    const gate = realClosedGate()
    const { stream, statusRes, sessions } = await mount()
    expect(sessions.has(SID), 'recovered behind a closed gate').toBe(false)
    const warn = vi.spyOn(console, 'warn')
    const pending = await statusRes(SID)
    await statusRes(SID)
    expect(messages(warn).filter(m => m.includes('Answering 503 recovery_pending')), 'logged on every poll, or never').toHaveLength(1)
    expect(pending.code).toBe(503)
    expect(pending.body).toMatchObject({ reason: 'recovery_pending', retryable: true })
    expect(pending.body.state, 'a 503 body must not carry a state the phone would read').toBeUndefined()

    const log = vi.spyOn(console, 'log')
    const release = await gate.prepare()
    release()
    expect(stream.durableSessionRecoveryHasRun(), 'ran synchronously; the lifecycle delivers on a microtask').toBe(false)
    await flushMicrotasks()
    expect(stream.durableSessionRecoveryHasRun()).toBe(true)
    expect(sessions.has(SID), 'the persisted session was not adopted after the gate opened').toBe(true)
    expect((await statusRes(SID)).body.state).toBe('active')
    expect(messages(log).join('\n')).toMatch(/Ran deferred durable recovery after the maintenance gate opened/)
  })

  it('a saved meeting is answered normally while recovery is pending, with no outcome or disposition', async () => {
    realClosedGate()
    const { store, statusRes } = await mount()
    store.save({ sessionId: SID, transcript: 'hello there', startTime: Date.now() - 60_000, durationMs: 60_000, chunks: [] })
    seedQuarantine(SID, { savedFilename: 'x.md' })
    const { code, body } = await statusRes(SID)
    expect(code).toBe(200)
    expect(body.state).toBe('saved')
    expect(body.outcome).toBeNull()
    expect(body.disposition).toBeNull()
  })

  it('runs once: a later admissions-open delivery does not re-read disk', async () => {
    const gate = realClosedGate()
    const { sessions } = await mount()
    await gate.releaseSync()
    await flushMicrotasks()
    mkdirSync(activeDir(), { recursive: true })
    writeFileSync(activeFile('meeting_after_release'), JSON.stringify({ sessionId: 'meeting_after_release', startTime: Date.now(), lastActivityAt: Date.now(), chunks: [], receivedIndices: [] }))
    const { maintenanceLifecycle } = await import('../lib/maintenance-lifecycle.js')
    // What a later drain release or cancel in the same process delivers.
    ;(maintenanceLifecycle as unknown as { notifyAdmissionsOpen(): void }).notifyAdmissionsOpen()
    await flushMicrotasks()
    expect(sessions.has('meeting_after_release'), 'recovery ran a second time').toBe(false)
  })

  it('never overwrites a session already live in memory, and does not quarantine its audio', async () => {
    seedLiveCapture(SID, Date.now() - 10 * 60_000)
    const gate = realClosedGate()
    const { sessions } = await mount()
    sessions.set(SID, { ...liveShape('live in memory'), receivedIndices: [0, 1, 2] })
    await gate.releaseSync()
    await flushMicrotasks()
    expect(sessions.get(SID).title, 'the disk copy replaced the live session').toBe('live in memory')
    expect(existsSync(audioDir(SID)), 'the boot orphan sweep quarantined a live session\'s audio').toBe(true)
  })

  it('the file 6.71.11 left for a receipted capture is moved aside at release, not adopted', async () => {
    seedLiveCapture(SID, Date.now() - 10 * 60_000)
    rmSync(audioDir(SID), { recursive: true, force: true })
    seedQuarantine(SID, NO_SPEECH)
    const gate = realClosedGate()
    const { status, sessions } = await mount()
    await gate.releaseSync()
    await flushMicrotasks()
    expect(sessions.has(SID), 'a receipted capture came back as a live session').toBe(false)
    expect(existsSync(activeFile(SID))).toBe(false)
    const reasonFile = readdirSync(staleDir()).find(name => name.endsWith('.reason.json'))!
    expect(JSON.parse(readFileSync(join(staleDir(), reasonFile), 'utf8'))).toMatchObject({ sessionId: SID, reason: 'terminal_capture' })
    expect((await status(SID)).outcome).toBe('receipted')
  })

  it('crash order: audio quarantined before the first persist, then the retry started the session; it is adopted as before', async () => {
    // Chunk 0's WAV landed, the process died before the active-session write, the
    // boot sweep quarantined that WAV, and the phone's retry started the session.
    seedQuarantine(SID, null, 'boot_sweep_unsaved')
    seedLiveCapture(SID, Date.now() - 60_000)
    const { sessions } = await mount()
    expect(sessions.has(SID), 'a merely quarantined capture was treated as finished').toBe(true)
    expect(existsSync(activeFile(SID))).toBe(true)
  })

  it('a capture whose quarantine is not yet decoded is adopted, even when the file is older and has no audio of its own', async () => {
    // Only a decoded outcome (recovered or no_speech) makes a file a leftover.
    seedLiveCapture(SID, Date.now() - 10 * 60_000)
    rmSync(audioDir(SID), { recursive: true, force: true })
    seedQuarantine(SID, null, 'idle_expiry_unsaved', Date.now())
    const { sessions } = await mount()
    expect(sessions.has(SID), 'an undecoded quarantine was treated as finished').toBe(true)
    expect(existsSync(staleDir()) ? readdirSync(staleDir()) : []).toEqual([])
  })

  it('late chunk after receipt, restart: the resumed session is adopted, not moved aside (no split meeting)', async () => {
    // The capture was quarantined and receipted 30 minutes ago; a late chunk then
    // started the session again under the same id, with its own audio, and the
    // server restarted.
    seedQuarantine(SID, NO_SPEECH, 'idle_expiry_unsaved', Date.now() - 30 * 60_000)
    seedLiveCapture(SID, Date.now() - 60_000)
    const { sessions } = await mount()
    expect(sessions.has(SID), 'the resumed session was split off as a finished capture').toBe(true)
    expect(existsSync(activeFile(SID))).toBe(true)
  })

  it('a file newer than the receipt is adopted even when its audio dir is gone', async () => {
    seedQuarantine(SID, NO_SPEECH, 'idle_expiry_unsaved', Date.now() - 30 * 60_000)
    seedLiveCapture(SID, Date.now() - 60_000)
    rmSync(audioDir(SID), { recursive: true, force: true })
    const { sessions } = await mount()
    expect(sessions.has(SID), 'ordering ignored: a newer session file was treated as a leftover').toBe(true)
  })

  it('a file older than the receipt is still adopted when it has chunk audio of its own', async () => {
    seedLiveCapture(SID, Date.now() - 60 * 60_000)
    seedQuarantine(SID, NO_SPEECH, 'idle_expiry_unsaved', Date.now() - 5 * 60_000)
    const { sessions } = await mount()
    expect(sessions.has(SID), 'a session with its own audio was treated as a leftover').toBe(true)
  })

  it('a failed terminal_capture move is logged once and the file is left, not adopted', async () => {
    seedLiveCapture(SID, Date.now() - 10 * 60_000)
    rmSync(audioDir(SID), { recursive: true, force: true })
    seedQuarantine(SID, NO_SPEECH)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(staleDir(), 'not a directory')
    const error = vi.spyOn(console, 'error')
    const { sessions } = await mount()
    expect(sessions.has(SID)).toBe(false)
    expect(existsSync(activeFile(SID))).toBe(true)
    expect(messages(error).filter(m => m.includes(`Could not move the active-session file aside for ${SID}`))).toHaveLength(1)
  })

  it('the minute sweep does nothing while recovery has not run', async () => {
    const gate = realClosedGate()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { stream } = await mount()
    seedLiveCapture(SID, Date.now() - IDLE - 60_000)
    const release = await gate.prepare()
    release() // admissions are open; the recovery listener is still queued
    vi.advanceTimersByTime(60_000)
    expect(stream.durableSessionRecoveryHasRun()).toBe(false)
    expect(existsSync(activeFile(SID)), 'swept before recovery ran').toBe(true)
    expect(existsSync(audioDir(SID)), 'audio quarantined before recovery ran').toBe(true)
  })
})

describe('the stale active-session sweep on the minute path', () => {
  it('moves a not-live file idle past 4 h aside with a reason, and purges expired moved files', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await mount()
    // Seeded after import: boot recovery would otherwise tombstone it first.
    mkdirSync(activeDir(), { recursive: true })
    writeFileSync(activeFile(SID), JSON.stringify({ sessionId: SID, lastActivityAt: Date.now() - IDLE - 60_000, chunks: [] }))
    mkdirSync(staleDir(), { recursive: true })
    const expiredAt = Date.now() - STALE_ACTIVE_SESSION_FILE_RETENTION_MS - 60_000
    writeFileSync(join(staleDir(), `meeting_old_moved.${expiredAt}.json`), '{}')
    writeFileSync(join(staleDir(), `meeting_old_moved.${expiredAt}.reason.json`), '{}')
    const warn = vi.spyOn(console, 'warn')
    const log = vi.spyOn(console, 'log')
    vi.advanceTimersByTime(60_000)
    expect(existsSync(activeFile(SID)), 'the minute interval did not run the sweep').toBe(false)
    const remaining = readdirSync(staleDir())
    const reasonFile = remaining.find(name => name.startsWith(SID) && name.endsWith('.reason.json'))!
    expect(JSON.parse(readFileSync(join(staleDir(), reasonFile), 'utf8'))).toMatchObject({ sessionId: SID, reason: 'not_live_idle_expired' })
    expect(remaining.filter(name => name.startsWith('meeting_old_moved')), 'expired moved files were not purged').toEqual([])
    expect(messages(warn).join('\n')).toMatch(new RegExp(`Moved stale active-session file aside: ${SID} \\(not_live_idle_expired`))
    expect(messages(log).join('\n')).toMatch(/Purged 2 stale active-session file\(s\) past retention/)
  })

  it('the minute loop carries on when the stale sweep throws', async () => {
    vi.doMock('../lib/stale-active-session-files.js', async importOriginal => ({
      ...(await importOriginal<typeof import('../lib/stale-active-session-files.js')>()),
      sweepStaleActiveSessionFiles: () => { throw new Error('boom from the stale sweep') },
    }))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await mount()
    // An empty pending-batch dir is removed by a LATER step of the same tick.
    mkdirSync(join(dataDir, 'pending-batch', 'empty-leftover'), { recursive: true })
    const error = vi.spyOn(console, 'error')
    vi.advanceTimersByTime(60_000)
    expect(messages(error).join('\n')).toMatch(/Stale active-session sweep failed: boom from the stale sweep/)
    expect(existsSync(join(dataDir, 'pending-batch', 'empty-leftover')), 'the rest of the tick did not run').toBe(false)
  })

  it('against the real session map: a live session is kept, a fresh one is kept, a stale one moves', async () => {
    const { stream, sessions } = await mount()
    const now = Date.now()
    const old = now - IDLE - 60_000
    mkdirSync(activeDir(), { recursive: true })
    for (const [id, at] of [['meeting_live_old', old], ['meeting_dead_fresh', now - 60_000], ['meeting_dead_old', old]] as const) {
      writeFileSync(activeFile(id), JSON.stringify({ sessionId: id, lastActivityAt: at, chunks: [] }))
    }
    sessions.set('meeting_live_old', { ...liveShape(), startTime: old, lastActivityAt: old })
    expect(stream.sweepStaleActiveSessionFilesNow(now).map(m => m.sessionId)).toEqual(['meeting_dead_old'])
    expect(existsSync(activeFile('meeting_live_old')), 'a live session file was moved').toBe(true)
  })

  it('a move that fails is logged once per session, not every minute', async () => {
    const { stream } = await mount()
    mkdirSync(activeDir(), { recursive: true })
    writeFileSync(activeFile(SID), JSON.stringify({ sessionId: SID, lastActivityAt: Date.now() - IDLE - 60_000, chunks: [] }))
    writeFileSync(staleDir(), 'not a directory')
    const error = vi.spyOn(console, 'error')
    expect(stream.sweepStaleActiveSessionFilesNow(Date.now()).map(m => m.target)).toEqual([null])
    stream.sweepStaleActiveSessionFilesNow(Date.now())
    expect(existsSync(activeFile(SID))).toBe(true)
    expect(messages(error).filter(m => m.includes(`Could not move stale active-session file aside for ${SID}`))).toHaveLength(1)
  })
})

describe('GET /api/meeting/sessions/:id/status: legacy state, additive outcome', () => {
  it('missing stays missing for a truly unknown id, with no outcome', async () => {
    const { status } = await mount()
    const body = await status('meeting_never_heard_of')
    expect(body.state).toBe('missing')
    expect(body.outcome).toBeNull()
    expect(body.disposition).toBeNull()
  })

  it('recovered when the receipt names a saved file the store does not find; quarantined while only held', async () => {
    const { status } = await mount()
    seedQuarantine('meeting_recovered_one', { savedFilename: '2026-10-12_Recovered_capture.md' })
    seedQuarantine('meeting_held_one', null, 'close_expired')
    const recovered = await status('meeting_recovered_one')
    expect(recovered.state).toBe('missing')
    expect(recovered.outcome).toBe('recovered')
    expect(recovered.disposition).toMatchObject({ kind: 'recovered', reason: 'recovered', savedFilename: '2026-10-12_Recovered_capture.md' })
    const held = await status('meeting_held_one')
    expect(held.outcome).toBe('quarantined')
    expect(held.disposition).toMatchObject({ kind: 'quarantined', quarantineReason: 'close_expired' })
  })

  it('a stranded session closed as expired and then receipted keeps state closed and says receipted', async () => {
    const { stream, status, sessions } = await mount()
    sessions.set('meeting_stranded_one', { ...liveShape(), receivedIndices: [0], asrCompletedIndices: [0] })
    stream.deleteSession('meeting_stranded_one')
    seedQuarantine('meeting_stranded_one', NO_SPEECH)
    const body = await status('meeting_stranded_one')
    expect(body.state, 'phones read closed as terminal-unsaved; it must not change').toBe('closed')
    expect(body.outcome).toBe('receipted')
    expect(body.receivedCount).toBe(1)
  })

  it('outcome table', async () => {
    const { captureOutcome } = await import('./meeting.js')
    const q = { kind: 'quarantined' as const }, n = { kind: 'no_speech' as const }, r = { kind: 'recovered' as const }
    expect(captureOutcome('saved', n)).toBeNull()
    expect(captureOutcome('active', n)).toBeNull()
    expect(captureOutcome('closed', null)).toBeNull()
    expect(captureOutcome('closed', n)).toBe('receipted')
    expect(captureOutcome('missing', r)).toBe('recovered')
    expect(captureOutcome('missing', q)).toBe('quarantined')
  })
})
