import express from 'express'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingStore } from '../lib/meeting-store.js'
import { MeetingFinalizationJobStore } from '../lib/meeting-finalization-jobs.js'
import { initializeServerInstanceId } from '../lib/server-instance-id.js'
import { createStopIntentStore } from '../lib/meeting-stop-intents.js'
import { AUTONOMOUS_FINALIZE_SETTLE_MS, type AutonomousFinalizer, type SessionLedger } from '../lib/meeting-autonomous-finalize.js'
import { createMeetingRouter } from './meeting.js'

// 6.81.0, Miles 2026-10-20: "if the application isn't in the foreground, it can fail to save
// the meetings". The phone tells the Mac its meeting stopped (POST .../stop) and the Mac
// finishes the save itself once it holds every chunk. These are the journeys at the route
// level, over the real meeting store and the real save route, with a fake chunk ledger the
// test drives the way a phone's uploads would:
//   - phone hidden after Stop: no phone save ever arrives, the Mac saves on its own;
//   - phone returns late with missing chunks: they merge into the SAME session first;
//   - phone and Mac racing: one meeting.

const TOKEN = 'auto-save-token'
const roots: string[] = []
const servers: Server[] = []
const opsEnvKeys = ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR'] as const
const previousOpsEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const key of opsEnvKeys) { previousOpsEnv[key] = process.env[key]; delete process.env[key] }
})
afterEach(async () => {
  for (const key of opsEnvKeys) { if (previousOpsEnv[key] == null) delete process.env[key]; else process.env[key] = previousOpsEnv[key] }
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SID = 'meeting_1792523229449_mip9qb'

/** A chunk ledger that behaves like the live session map: chunks arrive, ASR completes, Save closes. */
function fakeSessions(clock: () => number) {
  const texts = new Map<number, string>()
  const received = new Set<number>()
  const asr = new Set<number>()
  let state: SessionLedger['state'] = 'missing'
  let lastActivityAt: number | null = null
  const ordered = () => [...texts.entries()].sort((a, b) => a[0] - b[0])
  const chunk = (index: number, text: string) => ({ text, speaker: 'MU', elapsed: index * 10_000, similarity: 0.9 })
  const source = {
    getTranscript: () => (state === 'active' ? ordered().filter(([, text]) => text).map(([, text]) => `[MU]: ${text}`).join('\n') : null),
    getStartTime: () => (state === 'active' ? 1_000 : null),
    getChunks: () => ordered().filter(([, text]) => text).map(([index, text]) => chunk(index, text)),
    getChunkEntries: () => ordered().filter(([, text]) => text).map(([index, text]) => ({ chunkIndex: index, chunk: chunk(index, text) })),
    getProviderCandidates: () => ({}),
    getIntegrity: () => {
      const max = Math.max(-1, ...received)
      const missingIndices = Array.from({ length: max + 1 }, (_, i) => i).filter(i => !received.has(i))
      return { received: received.size, stored: texts.size, maxIndex: max, expected: max + 1, missingIndices, completeness: max < 0 ? 1 : received.size / (max + 1) }
    },
    drainAudioWrites: async () => {},
    hasAudio: () => false,
    moveAudioToPending: () => null,
    delete: vi.fn(() => { state = 'closed' }),
    getState: () => state,
    getLedger: (): SessionLedger => ({
      state,
      received: [...received].sort((a, b) => a - b),
      asrCompleted: [...asr].sort((a, b) => a - b),
      maxChunkIndex: Math.max(-1, ...received),
      lastActivityAt,
    }),
  }
  return {
    source,
    /** One phone upload: received, transcribed, canonical. */
    arrive(index: number, text = `chunk ${index}.`) {
      state = 'active'
      received.add(index); asr.add(index); texts.set(index, text)
      lastActivityAt = clock()
    },
    /** Received, ASR still running. */
    receiveOnly(index: number) { state = 'active'; received.add(index); lastActivityAt = clock() },
    finishAsr(index: number, text = `chunk ${index}.`) { asr.add(index); texts.set(index, text) },
  }
}

async function harness(opts: { ready?: boolean; intentsPath?: string; parent?: string } = {}) {
  const parent = opts.parent ?? mkdtempSync(join(tmpdir(), 'cos-auto-save-'))
  if (!opts.parent) roots.push(parent)
  const serverInstanceId = initializeServerInstanceId(join(parent, 'server-instance-id'))
  const store = new MeetingStore(join(parent, 'data', 'recordings'))
  let clock = 1_800_000_000_000
  const now = () => clock
  const fake = fakeSessions(now)
  const emit = vi.fn()
  const ready = { value: opts.ready ?? true }
  const log = vi.fn()
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const intentsPath = opts.intentsPath ?? join(parent, 'data', 'meeting-stop-intents.json')
  const stopIntents = createStopIntentStore({ path: intentsPath, now })
  let finalizer: AutonomousFinalizer | null = null
  const app = express()
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== TOKEN) { res.status(401).json({ error: 'unauthorized' }); return }
    next()
  })
  app.use(express.json())
  app.use('/api', createMeetingRouter({
    store,
    sessions: fake.source,
    emit,
    stopIntents,
    finalizationJobs: new MeetingFinalizationJobStore(join(parent, 'data', 'meeting-finalization-jobs')),
    runBatch: async () => { throw new Error('no batch in this test') },
    scheduleBackground: () => {},
    autonomousFinalize: {
      now,
      // Timers are recorded and fired by the test, never by wall time.
      schedule: (fn, ms) => { const entry = { fn, ms, cancelled: false }; scheduled.push(entry); return () => { entry.cancelled = true } },
      ready: () => ready.value,
      log,
      onCreate: created => { finalizer = created },
    },
  }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const api = async (path: string, init: RequestInit & { pin?: string | null } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-cos-token': TOKEN }
    const pin = init.pin === undefined ? serverInstanceId : init.pin
    if (pin) headers['X-COS-Server-Instance'] = pin
    const res = await fetch(`${base}${path}`, { ...init, headers })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })
  const stop = (finalChunkIndex: number, extra: Record<string, unknown> = {}) => api(`/api/meeting/sessions/${SID}/stop`, post({ finalChunkIndex, ...extra }))
  const phoneSave = () => api('/api/meeting/save', post({ sessionId: SID }))
  const status = () => api(`/api/meeting/sessions/${SID}/status`)
  const savedFiles = () => {
    try {
      return readdirSync(join(parent, 'data', 'recordings')).flatMap(month => readdirSync(join(parent, 'data', 'recordings', month)).filter(name => name.endsWith('.md')))
    } catch { return [] }
  }
  return {
    api, post, stop, phoneSave, status, store, fake, emit, log, ready, stopIntents, serverInstanceId, parent, intentsPath, savedFiles,
    advance: (ms: number) => { clock += ms },
    tick: async () => { await finalizer!.tick('test') },
    /** Fire every armed timer once, as wall time passing would, and let its tick finish. */
    fireTimers: async () => {
      const due = scheduled.filter(entry => !entry.cancelled)
      for (const entry of due) { entry.cancelled = true; entry.fn() }
      await new Promise(resolve => setTimeout(resolve, 50))
    },
    armedTimers: () => scheduled.filter(entry => !entry.cancelled),
    finalizerRef: () => finalizer!,
    events: () => log.mock.calls.map(([event]) => event as string),
  }
}

describe('POST /meeting/sessions/:id/stop (the phone\'s Stop)', () => {
  it('records the Stop durably, answers 202, and never saves or closes the session by itself', async () => {
    const h = await harness()
    for (const i of [0, 1, 2]) h.fake.arrive(i)
    const res = await h.stop(2)
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ sessionId: SID, state: 'stop_received', finalChunkIndex: 2, posts: 1, autonomousSave: { settleMs: AUTONOMOUS_FINALIZE_SETTLE_MS } })
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'waiting', finalChunkIndex: 2, serverInstanceId: h.serverInstanceId })
    // The Stop's own check runs inside the settle window, so nothing is saved yet.
    expect(h.fake.source.delete).not.toHaveBeenCalled()
    expect(h.store.findBySessionId(SID)).toBeNull()
    expect(h.events()).toContain('stop_received')
  })

  it('requires the server pin: only a phone pinned to this Mac may hand it a Stop', async () => {
    const h = await harness()
    expect((await h.api(`/api/meeting/sessions/${SID}/stop`, { ...h.post({ finalChunkIndex: 1 }), pin: null })).body.reason).toBe('server_identity_pin_required')
    const wrong = await h.api(`/api/meeting/sessions/${SID}/stop`, { ...h.post({ finalChunkIndex: 1 }), pin: 'another-mac' })
    expect(wrong).toMatchObject({ status: 409, body: { reason: 'server_instance_mismatch' } })
    expect(h.stopIntents.get(SID)).toBeNull()
  })

  it('validates the final index and refuses a Mac capture id', async () => {
    const h = await harness()
    for (const bad of [-2, 1.5, '3', null]) {
      expect((await h.stop(bad as number)).body.reason).toBe('invalid_final_chunk_index')
    }
    expect((await h.api('/api/meeting/sessions/mac_12345678-1234-1234-1234-123456789abc/stop', h.post({ finalChunkIndex: 1 }))).body.reason).toBe('mac_capture')
  })

  it('refuses a Stop whose final index is behind what the Mac already holds (never finalize a live recording)', async () => {
    const h = await harness()
    for (const i of [0, 1, 2, 3]) h.fake.arrive(i)
    const res = await h.stop(2)
    expect(res).toMatchObject({ status: 409, body: { reason: 'final_index_behind_server', maxChunkIndex: 3 } })
    expect(h.stopIntents.get(SID)).toBeNull()
  })

  it('a repeat Stop (a hidden phone retrying) is the same Stop; a higher index raises it', async () => {
    const h = await harness()
    h.fake.arrive(0)
    await h.stop(3)
    const again = await h.stop(3)
    expect(again.body).toMatchObject({ state: 'stop_received', finalChunkIndex: 3, posts: 2 })
    expect((await h.stop(5)).body.finalChunkIndex).toBe(5)
    expect((await h.stop(4)).body.finalChunkIndex).toBe(5)
  })

  it('a Stop for an already saved meeting answers its receipt', async () => {
    const h = await harness()
    h.fake.arrive(0)
    expect((await h.phoneSave()).status).toBe(200)
    const res = await h.stop(0)
    expect(res).toMatchObject({ status: 200, body: { state: 'saved', saveReceipt: { saved: true, replayed: true } } })
  })

  it('records a Stop that arrives before recovery has run, and judges it only once the gate opens', async () => {
    const h = await harness({ ready: false })
    const res = await h.stop(1)
    expect(res.status).toBe(202)
    h.fake.arrive(0); h.fake.arrive(1)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    expect(h.store.findBySessionId(SID)).toBeNull()
    h.ready.value = true
    await h.tick()
    expect(h.store.findBySessionId(SID)).not.toBeNull()
  })

  it('status carries the Stop additively', async () => {
    const h = await harness()
    h.fake.arrive(0)
    expect((await h.status()).body.stopIntent).toBeNull()
    await h.stop(1)
    await h.tick()
    const body = (await h.status()).body
    expect(body.stopIntent).toMatchObject({ finalChunkIndex: 1, state: 'waiting', savedBy: null, waitingFor: { reason: 'missing_chunks', missingCount: 1, missingSample: [1] } })
  })
})

describe('journey: the phone goes off screen after Stop and never saves', () => {
  it('the Mac saves the complete meeting on its own once it is quiet, and logs why', async () => {
    const h = await harness()
    for (let i = 0; i <= 5; i++) h.fake.arrive(i)
    await h.stop(5)
    // The Stop itself armed the check; nobody calls the finalizer by hand in this journey.
    await vi.waitFor(() => expect(h.armedTimers()).toHaveLength(1))
    expect(h.armedTimers()[0].ms).toBeLessThanOrEqual(AUTONOMOUS_FINALIZE_SETTLE_MS)
    // Inside the settle window: the phone gets first chance.
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS - 1)
    await h.fireTimers()
    expect(h.store.findBySessionId(SID)).toBeNull()
    h.advance(1)
    await h.fireTimers()
    const saved = h.store.findBySessionId(SID)
    expect(saved).not.toBeNull()
    expect(h.savedFiles()).toHaveLength(1)
    expect(h.fake.source.delete).toHaveBeenCalledTimes(1)
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'saved', savedBy: 'server', chunkCount: 6, canonicalCount: 6 })
    expect(h.log).toHaveBeenCalledWith('finalized', expect.objectContaining({
      sessionId: SID, reason: 'stop_received_complete', chunks: 6, canonical: 6, gaps: 0, waitedMs: AUTONOMOUS_FINALIZE_SETTLE_MS,
    }))
    // The lens and Control hear the same recording_stop a phone save sends, marked as the server's.
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'recording_stop', data: expect.objectContaining({ sessionId: SID, savedBy: 'server' }) }))
    // The status the phone reads when it comes back is `saved` with the receipt.
    const status = await h.status()
    expect(status.body).toMatchObject({ state: 'saved', saveReceipt: { saved: true }, stopIntent: { state: 'saved', savedBy: 'server' } })
    expect(h.log).toHaveBeenCalledWith('phone_confirmed', expect.objectContaining({ sessionId: SID, via: 'status' }))
  })

  it('an unpinned status read (COS Control, not the phone) is not the phone confirming', async () => {
    const h = await harness()
    for (let i = 0; i <= 1; i++) h.fake.arrive(i)
    await h.stop(1)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    await h.api(`/api/meeting/sessions/${SID}/status`, { pin: null })
    expect(h.stopIntents.get(SID)!.phoneConfirmedAt).toBeUndefined()
    await h.status()
    expect(h.stopIntents.get(SID)).toMatchObject({ phoneConfirmedBy: 'status' })
  })

  it('a Stop pinned to another server instance (a reinstall) is never saved here', async () => {
    const h = await harness()
    for (let i = 0; i <= 1; i++) h.fake.arrive(i)
    h.stopIntents.record({ sessionId: SID, finalChunkIndex: 1, source: 'companion', serverInstanceId: 'an-older-install' })
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    expect(h.store.findBySessionId(SID)).toBeNull()
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'stood_down', reason: 'server_instance_mismatch' })
  })

  it('the phone\'s later save is a replay of the same meeting (one meeting, logged as confirmed)', async () => {
    const h = await harness()
    for (let i = 0; i <= 2; i++) h.fake.arrive(i)
    await h.stop(2)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    const first = h.store.findBySessionId(SID)!
    const replay = await h.phoneSave()
    expect(replay).toMatchObject({ status: 200, body: { saved: true, replayed: true, filename: first.filename } })
    expect(h.savedFiles()).toEqual([first.filename])
    expect(h.stopIntents.get(SID)).toMatchObject({ phoneConfirmedBy: 'save_replay' })
  })

  it('a Stop the server held across a restart is still saved (durable)', async () => {
    const h = await harness()
    for (let i = 0; i <= 2; i++) h.fake.arrive(i)
    await h.stop(2)
    // A new router over the same data home: what a restart does. The fake ledger is fresh, so
    // replay the chunks into it as boot recovery would.
    const reborn = await harness({ parent: h.parent, intentsPath: h.intentsPath })
    for (let i = 0; i <= 2; i++) reborn.fake.arrive(i)
    reborn.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await reborn.tick()
    expect(reborn.store.findBySessionId(SID)).not.toBeNull()
  })

  it('a Stop with nothing but silence stands down (the phone says so on the lens)', async () => {
    const h = await harness()
    h.fake.receiveOnly(0)
    h.fake.finishAsr(0, '')
    await h.stop(0)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    expect(h.store.findBySessionId(SID)).toBeNull()
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'stood_down' })
  })
})

describe('journey: the phone returns late with chunks the Mac lacks', () => {
  it('waits on the gap, merges the late chunks into the SAME session, then saves ONE meeting with all of them', async () => {
    const h = await harness()
    // Hidden phone: chunks 0..3 and 6 reached the Mac, 4, 5 and the held last chunk 7 did not.
    for (const i of [0, 1, 2, 3, 6]) h.fake.arrive(i)
    await h.stop(7)
    h.advance(10 * 60_000)
    await h.tick()
    expect(h.store.findBySessionId(SID)).toBeNull()
    expect(h.stopIntents.get(SID)!.lastWait).toMatchObject({ reason: 'missing_chunks', missingCount: 3, missingSample: [4, 5, 7] })
    // An hour later, still nothing: the Mac keeps waiting (never saves with a gap).
    h.advance(60 * 60_000)
    await h.tick()
    expect(h.store.findBySessionId(SID)).toBeNull()
    expect(h.fake.source.delete).not.toHaveBeenCalled()
    // The phone comes back and uploads the tail into the same live session.
    for (const i of [4, 5, 7]) h.fake.arrive(i, `late ${i}.`)
    await h.tick()
    expect(h.store.findBySessionId(SID)).toBeNull() // settling after the last arrival
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    const saved = h.store.findBySessionId(SID)!
    expect(saved).not.toBeNull()
    expect(h.savedFiles()).toEqual([saved.filename])
    expect(saved.transferIntegrity?.missingIndices).toEqual([])
    const detail = h.store.detail(saved.domain, saved.month, saved.filename)
    for (const i of [4, 5, 7]) expect(detail.transcript).toContain(`late ${i}.`)
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'saved', savedBy: 'server', chunkCount: 8, canonicalCount: 8 })
  })

  it('waits while a received chunk is still in ASR', async () => {
    const h = await harness()
    h.fake.arrive(0)
    h.fake.receiveOnly(1)
    await h.stop(1)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    expect(h.store.findBySessionId(SID)).toBeNull()
    expect(h.stopIntents.get(SID)!.lastWait).toMatchObject({ reason: 'asr_pending' })
    h.fake.finishAsr(1)
    await h.tick()
    expect(h.store.findBySessionId(SID)).not.toBeNull()
  })

  it('a chunk past the Stop revokes it: the meeting is still recording and is never saved by the Mac', async () => {
    const h = await harness()
    for (const i of [0, 1]) h.fake.arrive(i)
    await h.stop(1)
    h.fake.arrive(2)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    expect(h.store.findBySessionId(SID)).toBeNull()
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'revoked', reason: 'chunk_beyond_final' })
    // The phone's next Stop is a new one.
    expect((await h.stop(2)).status).toBe(202)
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'waiting', finalChunkIndex: 2, replaced: 'revoked' })
  })
})

describe('journey: the phone and the Mac save at the same time', () => {
  it('the phone saving first wins; the Mac stands down; one meeting', async () => {
    const h = await harness()
    for (let i = 0; i <= 3; i++) h.fake.arrive(i)
    await h.stop(3)
    expect((await h.phoneSave()).body).toMatchObject({ saved: true })
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'saved', savedBy: 'phone' })
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    expect(h.savedFiles()).toHaveLength(1)
    expect(h.events()).toContain('phone_saved')
    expect(h.events()).not.toContain('finalized')
  })

  it('an unpinned save (the stranded sweep\'s own POST) closes the Stop as someone else\'s, not the phone\'s', async () => {
    const h = await harness()
    for (let i = 0; i <= 1; i++) h.fake.arrive(i)
    await h.stop(1)
    expect((await h.api('/api/meeting/save', { ...h.post({ sessionId: SID }), pin: null })).body).toMatchObject({ saved: true })
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'saved', savedBy: 'other' })
    expect(h.events()).toContain('client_saved')
    expect(h.events()).not.toContain('phone_saved')
  })

  it('both at once: one save runs, the other replays its receipt; one meeting', async () => {
    const h = await harness()
    for (let i = 0; i <= 3; i++) h.fake.arrive(i)
    await h.stop(3)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    const [server, phone] = await Promise.all([h.tick(), h.phoneSave()])
    void server
    expect([200, 409]).toContain(phone.status)
    if (phone.status === 409) {
      expect(phone.body.reason).toBe('save_in_progress')
      // The phone retries (its uploader defers on 409) and gets the same meeting.
      expect((await h.phoneSave()).body).toMatchObject({ saved: true, replayed: true })
    }
    await h.tick()
    expect(h.savedFiles()).toHaveLength(1)
    expect(h.fake.source.delete).toHaveBeenCalledTimes(1)
    expect(h.stopIntents.get(SID)!.state).toBe('saved')
  })

  it('the phone saving between the Mac\'s decision and its save is recorded as the phone\'s save', async () => {
    const h = await harness()
    for (let i = 0; i <= 1; i++) h.fake.arrive(i)
    await h.stop(1)
    expect((await h.phoneSave()).body).toMatchObject({ saved: true })
    // Make the Stop look open again and hide the receipt from the decision only, as if the
    // phone's save had landed in the gap between the decision and the save lock.
    h.stopIntents.update(SID, { state: 'waiting', savedBy: undefined })
    const realFind = h.store.findBySessionId.bind(h.store)
    let calls = 0
    vi.spyOn(h.store, 'findBySessionId').mockImplementation(id => (calls++ === 0 ? null : realFind(id)))
    const liveLedger = { state: 'active' as const, received: [0, 1], asrCompleted: [0, 1], maxChunkIndex: 1, lastActivityAt: 0 }
    vi.spyOn(h.fake.source, 'getLedger').mockReturnValueOnce(liveLedger)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    await h.tick()
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'saved', savedBy: 'phone' })
    expect(h.events()).not.toContain('finalized')
    expect(h.savedFiles()).toHaveLength(1)
  })

  it('the Mac holding the lock answers the phone save_in_progress, never a second meeting', async () => {
    const h = await harness()
    for (let i = 0; i <= 1; i++) h.fake.arrive(i)
    await h.stop(1)
    h.advance(AUTONOMOUS_FINALIZE_SETTLE_MS)
    // Hold the Mac's save open on its audio drain so the phone's save lands mid-save.
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    h.fake.source.drainAudioWrites = async () => { await gate }
    const server = h.tick()
    await vi.waitFor(() => expect(h.store.findBySessionId(SID)).not.toBeNull())
    // The sidecar is durable already, so the phone gets the receipt (idempotent), not a second save.
    const phone = await h.phoneSave()
    expect(phone.body).toMatchObject({ saved: true, replayed: true })
    release()
    await server
    expect(h.savedFiles()).toHaveLength(1)
    expect(h.stopIntents.get(SID)).toMatchObject({ state: 'saved', savedBy: 'server' })
    // The phone's next pinned status read is its confirmation.
    await h.status()
    expect(h.stopIntents.get(SID)).toMatchObject({ phoneConfirmedBy: 'status' })
  })
})
