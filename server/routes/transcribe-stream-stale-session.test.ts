// 6.71.14: a capture the server finished must not come back as a live session.
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
// chunk precedes the restart. Both orders are pinned here: the reported one (a chunk
// arriving after quarantine must be refused, not recreate a live record) and the
// real one (deferred recovery after the gate opens).
//
// Driven against the real module and the real routes, with a private data home,
// profile path, HOME and maintenance gate path per test: importing these modules
// runs boot recovery and starts timers.

import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_FIRST_MEETING_IDLE_RETENTION_MS } from '../lib/local-first-meetings-contract.js'

const SID = 'meeting_1791831725740_e5c1fv'
const ENV_KEYS = ['COS_DATA_DIR', 'COS_PROFILE_PATH', 'HOME', 'COS_MAINTENANCE_GATE_PATH', 'COS_API_TOKEN'] as const
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
  vi.resetModules()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.doUnmock('../lib/maintenance-lifecycle.js')
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})

/** A gate the test opens by hand, standing in for COS Control's release. */
function closedGate() {
  const gate = { open: false, listeners: new Set<() => void>() }
  vi.doMock('../lib/maintenance-lifecycle.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../lib/maintenance-lifecycle.js')>()
    return {
      ...actual,
      maintenanceAdmissionsOpen: () => gate.open,
      onMaintenanceAdmissionsOpen: (listener: () => void) => {
        gate.listeners.add(listener)
        return () => { gate.listeners.delete(listener) }
      },
    }
  })
  return {
    gate,
    release() {
      gate.open = true
      for (const listener of [...gate.listeners]) listener()
    },
  }
}

async function mount() {
  const stream = await import('./transcribe-stream.js')
  const quarantine = await import('../lib/unsaved-audio-quarantine.js')
  const { initializeServerInstanceId } = await import('../lib/server-instance-id.js')
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { MeetingFinalizationJobStore } = await import('../lib/meeting-finalization-jobs.js')
  const { createMeetingRouter } = await import('./meeting.js')
  initializeServerInstanceId(join(dataDir, 'server-instance-id'))
  const app = express()
  app.use(express.json())
  app.use('/api', stream.transcribeStreamRouter)
  app.use('/api', createMeetingRouter({
    store: new MeetingStore(join(dataDir, 'recordings')),
    finalizationJobs: new MeetingFinalizationJobStore(join(dataDir, 'meeting-finalization-jobs')),
    scheduleBackground: () => {},
    emit: vi.fn() as never,
  }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const status = async (id: string) => (await fetch(`${base}/api/meeting/sessions/${id}/status`)).json()
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
  return { stream, quarantine, status, postChunk, sessions: stream.__sessionsForTests as Map<string, any> }
}

const activeFile = (id: string) => join(dataDir, 'active-sessions', `${id}.json`)
const staleDir = () => join(dataDir, 'stale-active-session-files')

/** What 6.71.11 left on disk: the two silent chunks' audio and their session file. */
function seedLiveCapture(id: string, lastActivityAt: number) {
  const audioDir = join(dataDir, 'session-audio', id)
  mkdirSync(audioDir, { recursive: true })
  writeFileSync(join(audioDir, 'chunk_0000.wav'), Buffer.alloc(44 + 32_000, 1))
  writeFileSync(join(audioDir, 'chunk_0001.wav'), Buffer.alloc(44 + 3_200, 1))
  mkdirSync(join(dataDir, 'active-sessions'), { recursive: true })
  writeFileSync(activeFile(id), JSON.stringify({
    sessionId: id, startTime: lastActivityAt - 9_000, lastActivityAt, title: '',
    chunks: [], chunksIndexed: [], receivedIndices: [0, 1], asrCompletedIndices: [0, 1],
    emptyCompletions: {}, maxChunkIndex: 1, providerCandidates: {},
  }))
}

/** A capture already quarantined and receipted no_speech, without its session-audio dir. */
function seedReceiptedQuarantine(id: string) {
  const dir = join(dataDir, 'unsaved-audio', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'chunk_0000.wav'), Buffer.alloc(64))
  writeFileSync(join(dir, 'chunk_0001.wav'), Buffer.alloc(64))
  writeFileSync(join(dir, '_quarantine.json'), JSON.stringify({
    schemaVersion: 1, sessionId: id, quarantinedAt: new Date().toISOString(), reason: 'idle_expiry_unsaved', chunkFiles: 2, bytes: 128,
  }))
  writeFileSync(join(dir, '_recovered.json'), JSON.stringify({ schemaVersion: 1, recoveredAt: new Date().toISOString(), outcome: 'no_speech', chunkFiles: 2, words: 0 }))
}

describe('the reported order: quarantine, recover, late Ext chunk, no_speech receipt', () => {
  it('a chunk after quarantine is refused with 410 and recreates no live record; the receipt reads receipted', async () => {
    const { stream, quarantine, status, postChunk, sessions } = await mount()
    // 1. [cleanup] Quarantined unsaved session-audio
    const audioDir = join(dataDir, 'session-audio', SID)
    mkdirSync(audioDir, { recursive: true })
    writeFileSync(join(audioDir, 'chunk_0000.wav'), Buffer.alloc(44 + 32_000, 1))
    writeFileSync(join(audioDir, 'chunk_0001.wav'), Buffer.alloc(44 + 3_200, 1))
    const actions = quarantine.sweepOrphanedSessionAudio(join(dataDir, 'session-audio'), {
      isLive: id => sessions.has(id), hasFreshPreservedMarker: () => false, reason: 'idle_expiry_unsaved',
    })
    expect(actions.map(a => a.action)).toEqual(['quarantined'])
    // 2. [quarantine] Auto-recovered (accepted; the decode is still running)
    const qdir = quarantine.findQuarantineDir(SID)!
    quarantine.registerActiveRecovery(SID, qdir)
    const held = await status(SID)
    expect(held.state).toBe('quarantined')
    expect(held.disposition).toMatchObject({ kind: 'quarantined', reason: null, recovering: true, chunkFiles: 2 })

    // 3. [ext-audio] the late chunk
    const warn = vi.spyOn(console, 'warn')
    const late = await postChunk(SID, 2)
    expect(late.status).toBe(410)
    expect(late.body.reason).toBe('session_closed')
    expect(sessions.has(SID), 'a live session was recreated for a quarantined capture').toBe(false)
    expect(existsSync(activeFile(SID)), 'an active-session file was recreated').toBe(false)
    expect(existsSync(audioDir), 'a new session-audio dir was started').toBe(false)
    expect(warn.mock.calls.map(c => String(c[0])).join('\n'))
      .toMatch(new RegExp(`Refused late chunk for ${SID} chunk 2: capture already quarantined; no live session recreated`))

    // 4. [meeting/orphans] held no speech, receipted as no_speech
    quarantine.markRecoveredNoSpeech(qdir, 2)
    quarantine.clearActiveRecovery(qdir)
    const done = await status(SID)
    expect(done.state, 'a receipted capture must not read as missing').toBe('receipted')
    expect(done.disposition).toMatchObject({ kind: 'no_speech', reason: 'no_speech', recovering: false, savedFilename: null })
    expect(typeof done.disposition.receiptedAt).toBe('string')
    expect(done.saveReceipt).toBeNull()
    // Still refused, and there is nothing for the sweep to move or for Control to list.
    expect((await postChunk(SID, 3)).status).toBe(410)
    expect(stream.sweepStaleActiveSessionFilesNow(Date.now() + 5 * 60 * 60 * 1000)).toEqual([])
    expect(existsSync(join(dataDir, 'active-sessions')) ? readdirSync(join(dataDir, 'active-sessions')) : []).toEqual([])
  })

  it('a session that is live is never refused, even with an older quarantine for its id', async () => {
    // ASR is mocked: this chunk is accepted, and must never reach the real whisper-server.
    vi.doMock('../lib/whisper-local.js', () => ({
      transcribeLocal: vi.fn().mockResolvedValue({ text: '', words: [], backend: 'mock' }),
      applyCorrections: (text: string) => text,
    }))
    vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
    vi.doMock('../lib/speaker-embeddings.js', async importOriginal => ({
      ...(await importOriginal<typeof import('../lib/speaker-embeddings.js')>()),
      identifySpeaker: () => null, isEmbeddingAvailable: () => false,
    }))
    vi.doMock('../lib/vad-silero.js', () => ({ trimSilence: vi.fn(), isSileroAvailable: () => false }))
    try {
      const { quarantine, sessions, postChunk, status } = await mount()
      seedReceiptedQuarantine(SID)
      sessions.set(SID, { chunks: [], startTime: Date.now(), lastActivityAt: Date.now(), title: '', receivedIndices: [], asrCompletedIndices: [], emptyCompletions: {}, providerCandidates: {} })
      expect(quarantine.readCaptureDisposition(SID)?.kind).toBe('no_speech')
      const accepted = await postChunk(SID, 0)
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
      const body = await status(SID)
      expect(body.state).toBe('active')
      expect(body.disposition, 'a live session reports itself, not an older quarantine').toBeNull()
    } finally {
      for (const m of ['../lib/whisper-local.js', '../lib/audio-enhance.js', '../lib/speaker-embeddings.js', '../lib/vad-silero.js']) vi.doUnmock(m)
    }
  })
})

describe('the offline-session start route', () => {
  it('refuses to open a session for a receipted capture', async () => {
    process.env.COS_IOS_ASR_CANDIDATES = '1'
    try {
      const { stream } = await mount()
      seedReceiptedQuarantine(SID)
      const app = express()
      app.use(express.json())
      app.use('/api', stream.transcribeStreamRouter)
      const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
      servers.push(server)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const res = await fetch(`http://127.0.0.1:${port}/api/transcribe-stream/offline-sessions/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: SID }),
      })
      expect(res.status).toBe(410)
      expect((await res.json()).reason).toBe('session_closed')
      expect(stream.__sessionsForTests.has(SID)).toBe(false)
      expect(existsSync(activeFile(SID))).toBe(false)
    } finally {
      delete process.env.COS_IOS_ASR_CANDIDATES
    }
  })
})

describe('the real order: chunks persisted, restart behind a closed gate, then release', () => {
  it('recovery waits for the gate and then adopts the persisted session (before 6.71.14 it never ran)', async () => {
    seedLiveCapture(SID, Date.now() - 10 * 60_000)
    const { gate, release } = closedGate()
    const { stream, status, sessions } = await mount()
    expect(stream.__durableSessionRecoveryRanForTests()).toBe(false)
    expect(sessions.has(SID)).toBe(false)
    expect(gate.listeners.size, 'nothing is waiting for the gate to open').toBe(1)

    const log = vi.spyOn(console, 'log')
    release()
    expect(stream.__durableSessionRecoveryRanForTests()).toBe(true)
    expect(sessions.has(SID), 'the persisted session was not adopted after the gate opened').toBe(true)
    expect((await status(SID)).state).toBe('active')
    expect(log.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/Ran deferred durable recovery after the maintenance gate opened/)
    // Once only: a later open (a second drain released in the same process) must not
    // re-run recovery. A file that appears afterwards is the stale sweep's to judge.
    writeFileSync(activeFile('meeting_after_release'), JSON.stringify({ sessionId: 'meeting_after_release', startTime: Date.now(), lastActivityAt: Date.now(), chunks: [], receivedIndices: [] }))
    release()
    expect(sessions.has('meeting_after_release'), 'recovery ran a second time').toBe(false)
  })

  it('deferred recovery never overwrites a session that is already live in memory', async () => {
    seedLiveCapture(SID, Date.now() - 10 * 60_000)
    const { release } = closedGate()
    const { sessions } = await mount()
    sessions.set(SID, { chunks: [], startTime: Date.now(), lastActivityAt: Date.now(), title: 'live in memory', receivedIndices: [0, 1, 2], asrCompletedIndices: [], emptyCompletions: {}, providerCandidates: {} })
    release()
    expect(sessions.get(SID).title, 'the disk copy replaced the live session').toBe('live in memory')
    expect(sessions.get(SID).receivedIndices).toEqual([0, 1, 2])
  })

  it('the file 6.71.11 left for a receipted capture is moved aside at release, not adopted', async () => {
    seedLiveCapture(SID, Date.now() - 10 * 60_000)
    rmSync(join(dataDir, 'session-audio', SID), { recursive: true, force: true })
    seedReceiptedQuarantine(SID)
    const { release } = closedGate()
    const { status, sessions } = await mount()
    release()
    expect(sessions.has(SID), 'a receipted capture came back as a live session').toBe(false)
    expect(existsSync(activeFile(SID))).toBe(false)
    const moved = readdirSync(staleDir())
    const reasonFile = moved.find(name => name.endsWith('.reason.json'))!
    expect(JSON.parse(readFileSync(join(staleDir(), reasonFile), 'utf8'))).toMatchObject({ sessionId: SID, reason: 'terminal_capture' })
    expect((await status(SID)).state).toBe('receipted')
  })

  it('the minute sweep does nothing while recovery has not run', async () => {
    const { gate } = closedGate()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { stream } = await mount()
    gate.open = true // open, but the release notification has not been delivered yet
    seedLiveCapture(SID, Date.now() - LOCAL_FIRST_MEETING_IDLE_RETENTION_MS - 60_000)
    vi.advanceTimersByTime(60_000)
    expect(stream.__durableSessionRecoveryRanForTests()).toBe(false)
    expect(existsSync(activeFile(SID)), 'swept before recovery ran').toBe(true)
    expect(existsSync(join(dataDir, 'session-audio', SID)), 'audio quarantined before recovery ran').toBe(true)
  })
})

describe('the stale active-session sweep', () => {
  it('the minute interval moves a not-live file idle past 4 h aside, with a reason', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { stream } = await mount()
    expect(stream.__durableSessionRecoveryRanForTests()).toBe(true)
    // Seeded after import: boot recovery would otherwise tombstone it first.
    mkdirSync(join(dataDir, 'active-sessions'), { recursive: true })
    writeFileSync(activeFile(SID), JSON.stringify({ sessionId: SID, lastActivityAt: Date.now() - LOCAL_FIRST_MEETING_IDLE_RETENTION_MS - 60_000, chunks: [] }))
    const warn = vi.spyOn(console, 'warn')
    vi.advanceTimersByTime(60_000)
    expect(existsSync(activeFile(SID)), 'the minute interval did not run the sweep').toBe(false)
    const reasonFile = readdirSync(staleDir()).find(name => name.endsWith('.reason.json'))!
    expect(JSON.parse(readFileSync(join(staleDir(), reasonFile), 'utf8'))).toMatchObject({ sessionId: SID, reason: 'not_live_idle_expired' })
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(new RegExp(`Moved stale active-session file aside: ${SID} \\(not_live_idle_expired`))
  })

  it('against the real session map: a live session is kept, a fresh one is kept, a stale one moves', async () => {
    const { stream, sessions } = await mount()
    const now = Date.now()
    const old = now - LOCAL_FIRST_MEETING_IDLE_RETENTION_MS - 60_000
    mkdirSync(join(dataDir, 'active-sessions'), { recursive: true })
    for (const [id, at] of [['meeting_live_old', old], ['meeting_dead_fresh', now - 60_000], ['meeting_dead_old', old]] as const) {
      writeFileSync(activeFile(id), JSON.stringify({ sessionId: id, lastActivityAt: at, chunks: [] }))
    }
    sessions.set('meeting_live_old', { chunks: [], startTime: old, lastActivityAt: old, title: '', receivedIndices: [], asrCompletedIndices: [], emptyCompletions: {}, providerCandidates: {} })
    expect(stream.sweepStaleActiveSessionFilesNow(now).map(m => m.sessionId)).toEqual(['meeting_dead_old'])
    expect(existsSync(activeFile('meeting_live_old')), 'a live session file was moved').toBe(true)
    expect(existsSync(activeFile('meeting_dead_fresh'))).toBe(true)
    expect(existsSync(activeFile('meeting_dead_old'))).toBe(false)
  })
})

describe('GET /api/meeting/sessions/:id/status for a capture that left the live map', () => {
  function quarantineOnly(id: string, receipt: Record<string, unknown> | null) {
    const dir = join(dataDir, 'unsaved-audio', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'chunk_0000.wav'), Buffer.alloc(64))
    writeFileSync(join(dir, '_quarantine.json'), JSON.stringify({ schemaVersion: 1, sessionId: id, quarantinedAt: new Date().toISOString(), reason: 'close_expired', chunkFiles: 1, bytes: 64 }))
    if (receipt) writeFileSync(join(dir, '_recovered.json'), JSON.stringify({ schemaVersion: 1, recoveredAt: new Date().toISOString(), ...receipt }))
  }

  it('missing stays missing for a truly unknown id, with no disposition', async () => {
    const { status } = await mount()
    const body = await status('meeting_never_heard_of')
    expect(body.state).toBe('missing')
    expect(body.disposition).toBeNull()
  })

  it('recovered when the receipt names a saved file the store does not find; quarantined while only held', async () => {
    const { status } = await mount()
    quarantineOnly('meeting_recovered_one', { savedFilename: '2026-10-12_Recovered_capture.md' })
    quarantineOnly('meeting_held_one', null)
    const recovered = await status('meeting_recovered_one')
    expect(recovered.state).toBe('recovered')
    expect(recovered.disposition).toMatchObject({ kind: 'recovered', reason: 'recovered', savedFilename: '2026-10-12_Recovered_capture.md' })
    const held = await status('meeting_held_one')
    expect(held.state).toBe('quarantined')
    expect(held.disposition).toMatchObject({ kind: 'quarantined', quarantineReason: 'close_expired' })
  })

  it('a stranded session closed as expired and then receipted no_speech reads receipted, not closed', async () => {
    const { stream, status, sessions } = await mount()
    const now = Date.now()
    sessions.set('meeting_stranded_one', { chunks: [], startTime: now - 20_000, lastActivityAt: now - 10_000, title: '', receivedIndices: [0], asrCompletedIndices: [0], emptyCompletions: {}, providerCandidates: {} })
    stream.deleteSession('meeting_stranded_one')
    expect((await status('meeting_stranded_one')).state).toBe('closed')
    quarantineOnly('meeting_stranded_one', { outcome: 'no_speech', chunkFiles: 1, words: 0 })
    const body = await status('meeting_stranded_one')
    expect(body.state).toBe('receipted')
    // The ledger from the closed record is still reported alongside.
    expect(body.receivedCount).toBe(1)
  })

  it('precedence table', async () => {
    const { reportedSessionState } = await import('./meeting.js')
    const q = { kind: 'quarantined' as const }, n = { kind: 'no_speech' as const }, r = { kind: 'recovered' as const }
    expect(reportedSessionState(true, 'missing', n)).toBe('saved')
    expect(reportedSessionState(true, 'active', null)).toBe('saved')
    expect(reportedSessionState(false, 'active', n)).toBe('active')
    expect(reportedSessionState(false, 'closed', n)).toBe('receipted')
    expect(reportedSessionState(false, 'closed', r)).toBe('recovered')
    expect(reportedSessionState(false, 'closed', q)).toBe('closed')
    expect(reportedSessionState(false, 'closed', null)).toBe('closed')
    expect(reportedSessionState(false, 'missing', q)).toBe('quarantined')
    expect(reportedSessionState(false, 'missing', null)).toBe('missing')
  })
})
