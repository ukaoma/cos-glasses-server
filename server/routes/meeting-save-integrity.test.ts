import express from 'express'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingStore } from '../lib/meeting-store.js'
import { MeetingFinalizationJobStore } from '../lib/meeting-finalization-jobs.js'
import { initializeServerInstanceId } from '../lib/server-instance-id.js'
import { createStopIntentStore } from '../lib/meeting-stop-intents.js'
import { type AutonomousFinalizer, type SessionLedger } from '../lib/meeting-autonomous-finalize.js'
import { createMeetingRouter } from './meeting.js'

// 6.88.0 (lib/transfer-integrity.ts), meeting t2xs9u on 2026-10-23: a recovery save from a relaunched
// COS window finalized the meeting from the Mac's 74 chunks while the window still recording it had
// captured through index 120, and the saved file said "Transfer integrity 100%". At the route level,
// over the real meeting store and save route, with the fake chunk ledger of meeting-autonomous-save
// (copied, not shared, so neither file's harness can drift the other's). Synthetic text only.

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
  const savedMarkdown = () => {
    const root = join(parent, 'data', 'recordings')
    for (const month of readdirSync(root)) {
      for (const name of readdirSync(join(root, month))) if (name.endsWith('.md')) return readFileSync(join(root, month, name), 'utf8')
    }
    return ''
  }
  return {
    savedMarkdown,
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

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const integrityLine = (markdown: string) => markdown.split('\n').find(line => line.startsWith('| **Transfer integrity** |')) ?? ''

describe('6.88.0: the saved file\'s transfer integrity counts what the phone captured', () => {
  it('a Stop said 120 and the Mac holds 0..73: the save says 61.1% with 47 chunks not received, not 100%', async () => {
    const h = await harness()
    for (const i of range(0, 73)) h.fake.arrive(i)
    expect((await h.stop(120)).status).toBe(202)
    const res = await h.phoneSave()
    expect(res.status).toBe(200)
    expect(res.body.transferIntegrity).toMatchObject({ completeness: 61.1, received: 74, expected: 121, missingChunks: 47 })
    expect(res.body.transferIntegrity.missingIndices.slice(0, 3)).toEqual([74, 75, 76])
    expect(integrityLine(h.savedMarkdown())).toContain('61.1%')
    expect(integrityLine(h.savedMarkdown())).toContain('47 chunks not received')
  })

  it('a save that carries finalChunkIndex counts it the same way', async () => {
    const h = await harness()
    for (const i of range(0, 73)) h.fake.arrive(i)
    const res = await h.api('/api/meeting/save', h.post({ sessionId: SID, finalChunkIndex: 120 }))
    expect(res.status).toBe(200)
    expect(res.body.transferIntegrity).toMatchObject({ completeness: 61.1, expected: 121, missingChunks: 47 })
  })

  it('with no word from the phone, nothing changes: 100%', async () => {
    const h = await harness()
    for (const i of range(0, 9)) h.fake.arrive(i)
    const res = await h.phoneSave()
    expect(res.status).toBe(200)
    expect(res.body.transferIntegrity).toMatchObject({ completeness: 100, received: 10, expected: 10, missingChunks: 0 })
    expect(integrityLine(h.savedMarkdown())).toBe('| **Transfer integrity** | 100% |')
  })

  it('a malformed finalChunkIndex is ignored, never trusted', async () => {
    // One fresh meeting per value: a second save of one meeting only replays its first receipt.
    for (const bad of ['120', 12.5, -7, 5_000_000]) {
      const h = await harness()
      for (const i of range(0, 9)) h.fake.arrive(i)
      const res = await h.api('/api/meeting/save', h.post({ sessionId: SID, finalChunkIndex: bad }))
      expect(res.status, String(bad)).toBe(200)
      expect(res.body.replayed, String(bad)).toBeUndefined()
      expect(res.body.transferIntegrity, String(bad)).toMatchObject({ completeness: 100, expected: 10 })
    }
  })
})

describe('6.88.0: an origin-wipe recovery save waits for chunks a phone window still holds', () => {
  it('refuses 409 chunks_outstanding while the Stop says the phone captured more, and saves nothing', async () => {
    const h = await harness()
    for (const i of range(0, 73)) h.fake.arrive(i)
    await h.stop(120)
    const res = await h.api('/api/meeting/save', h.post({ sessionId: SID, recovery: 'origin_wipe' }))
    expect(res).toMatchObject({ status: 409, body: { reason: 'chunks_outstanding', missingCount: 47, finalChunkIndex: 120 } })
    expect(h.store.findBySessionId(SID)).toBeNull()
    expect(h.fake.source.delete).not.toHaveBeenCalled()
  })

  it('refuses on the save\'s own finalChunkIndex too', async () => {
    const h = await harness()
    for (const i of range(0, 73)) h.fake.arrive(i)
    const res = await h.api('/api/meeting/save', h.post({ sessionId: SID, recovery: 'origin_wipe', finalChunkIndex: 120 }))
    expect(res).toMatchObject({ status: 409, body: { reason: 'chunks_outstanding', missingCount: 47 } })
  })

  it('saves once the chunks arrived, at 100%', async () => {
    const h = await harness()
    for (const i of range(0, 73)) h.fake.arrive(i)
    await h.stop(120)
    expect((await h.api('/api/meeting/save', h.post({ sessionId: SID, recovery: 'origin_wipe' }))).status).toBe(409)
    for (const i of range(74, 120)) h.fake.arrive(i)
    const res = await h.api('/api/meeting/save', h.post({ sessionId: SID, recovery: 'origin_wipe', finalChunkIndex: 120 }))
    expect(res.status).toBe(200)
    expect(res.body.transferIntegrity).toMatchObject({ completeness: 100, expected: 121, missingChunks: 0 })
  })

  it('a recovery that waited out its bound (acceptMissing) saves what the Mac has, and says 47 are missing', async () => {
    const h = await harness()
    for (const i of range(0, 73)) h.fake.arrive(i)
    const res = await h.api('/api/meeting/save', h.post({ sessionId: SID, recovery: 'origin_wipe', finalChunkIndex: 120, acceptMissing: true }))
    expect(res.status).toBe(200)
    expect(res.body.transferIntegrity).toMatchObject({ completeness: 61.1, expected: 121, missingChunks: 47 })
  })

  it('a save without recovery is never refused here, whatever the Stop says (every existing caller)', async () => {
    const h = await harness()
    for (const i of range(0, 73)) h.fake.arrive(i)
    await h.stop(120)
    expect((await h.phoneSave()).status).toBe(200)
  })

  it('an already saved meeting answers its receipt, recovery or not', async () => {
    const h = await harness()
    for (const i of range(0, 73)) h.fake.arrive(i)
    expect((await h.phoneSave()).status).toBe(200)
    await h.stop(120).catch(() => null)
    const res = await h.api('/api/meeting/save', h.post({ sessionId: SID, recovery: 'origin_wipe' }))
    expect(res).toMatchObject({ status: 200, body: { saved: true, replayed: true } })
  })
})
