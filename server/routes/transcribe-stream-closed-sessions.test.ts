// 6.53.3 (review D3): a closed session is forgotten once its retention has passed.
//
// THE INCIDENT (2026-09-22). A 12 s meeting (one silent chunk) closed on the Mac at 11:32.
// Its status read `closed` for the rest of the day, because `closedSessionRecords` was
// never evicted in memory (only the persisted file was pruned). The phone's recovery hint
// handled `saved` and `missing` but not `closed`, so on every boot and foreground it POSTed
// save, which can only 404 `session_not_found`, and retried: 11 times across 5 WebView
// instances, each taking the maintenance lease and the save lock. It ended only on restart.
//
// Driven against the real module and the real status and save routes, with the module's
// own data home per test (the liveness suite's pattern: DATA_DIR is read at import).

import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_FIRST_MEETING_IDLE_RETENTION_MS } from '../lib/local-first-meetings-contract.js'

let dataDir = ''
const servers: Server[] = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cos-closed-sessions-'))
  process.env.COS_DATA_DIR = dataDir
  vi.resetModules()
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
  vi.resetModules()
})

// The server's CLOSED_SESSION_TTL_MS IS this constant (transcribe-stream.ts); imported, not
// restated, so a change to the retention moves the test with it.
const RETENTION_MS = LOCAL_FIRST_MEETING_IDLE_RETENTION_MS

/** A session the phone opened and closed with one silent chunk: known, and empty. */
async function closedEmptySession(sessionId: string) {
  const mod: any = await import('./transcribe-stream.js')
  const map: Map<string, any> = mod.__sessionsForTests
  if (!map || !mod.__closedSessionRecordsForTests) throw new Error('test seams missing')
  const now = Date.now()
  map.set(sessionId, {
    chunks: [],
    startTime: now - 12_000,
    title: sessionId,
    lastActivityAt: now - 1_000,
    receivedIndices: [0],
    asrCompletedIndices: [0],
    emptyCompletions: { 0: { text: '', canonical: false } },
  })
  expect(mod.getMeetingSessionStatus(sessionId).state).toBe('active')
  mod.deleteSession(sessionId)
  // The record's own close time, not the test's (they can differ by a millisecond).
  const closedAt: number = mod.__closedSessionRecordsForTests.get(sessionId).closedAt
  return { mod, closedAt }
}

/** The real status and save routes over the real session source. */
async function routes() {
  const { initializeServerInstanceId } = await import('../lib/server-instance-id.js')
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { MeetingFinalizationJobStore } = await import('../lib/meeting-finalization-jobs.js')
  const { createMeetingRouter } = await import('./meeting.js')
  initializeServerInstanceId(join(dataDir, 'server-instance-id'))
  const app = express()
  app.use(express.json())
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
  const save = async (id: string) => {
    const res = await fetch(`${base}/api/meeting/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id }) })
    return { status: res.status, body: await res.json() }
  }
  return { status, save }
}

describe('closed sessions age out (6.53.3, review D3)', () => {
  it('within retention: closed; past retainedUntil: missing, evicted in memory, and the 410 tombstone goes with it', async () => {
    const { mod, closedAt } = await closedEmptySession('yxc7fh-closed')
    const inside = mod.getMeetingSessionStatus('yxc7fh-closed', closedAt + RETENTION_MS)
    expect(inside.state).toBe('closed')
    expect(Date.parse(inside.retainedUntil)).toBe(closedAt + RETENTION_MS)
    expect(mod.isSessionDeleted('yxc7fh-closed')).toBe(true)

    const past = mod.getMeetingSessionStatus('yxc7fh-closed', closedAt + RETENTION_MS + 1)
    expect(past).toMatchObject({ state: 'missing', retainedUntil: null, receivedCount: 0, maxChunkIndex: -1 })
    // EVICTED, not merely reported past its date: a later read at any clock is missing.
    expect(mod.__closedSessionRecordsForTests.has('yxc7fh-closed')).toBe(false)
    expect(mod.getMeetingSessionStatus('yxc7fh-closed', closedAt).state).toBe('missing')
    // What a restart would have done: the tombstone is gone too.
    expect(mod.isSessionDeleted('yxc7fh-closed')).toBe(false)
  })

  it('the minute sweep evicts every expired record, and leaves a fresh one', async () => {
    const { mod } = await closedEmptySession('old-closed-1')
    const fresh = await closedEmptySession('fresh-closed-1')
    // Closed a whole retention earlier than the fresh one.
    mod.__closedSessionRecordsForTests.get('old-closed-1').closedAt = fresh.closedAt - RETENTION_MS - 10
    expect(mod.sweepExpiredClosedSessions(fresh.closedAt)).toBe(1)
    expect([...mod.__closedSessionRecordsForTests.keys()]).toEqual(['fresh-closed-1'])
    expect(mod.sweepExpiredClosedSessions(fresh.closedAt + RETENTION_MS)).toBe(0)
    expect(mod.sweepExpiredClosedSessions(fresh.closedAt + RETENTION_MS + 1)).toBe(1)
    expect(mod.__closedSessionRecordsForTests.size).toBe(0)
  })

  it('an evicted session is not written back to disk, so a restart does not bring it back', async () => {
    const { mod, closedAt } = await closedEmptySession('evicted-then-restart')
    const later = closedAt + RETENTION_MS + 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(mod.getMeetingSessionStatus('evicted-then-restart').state).toBe('missing')
    // Another session closing persists the tombstone file.
    await closedEmptySession('another-close')
    vi.restoreAllMocks()
    vi.resetModules()
    const rebooted: any = await import('./transcribe-stream.js')
    expect(rebooted.getMeetingSessionStatus('evicted-then-restart').state).toBe('missing')
    expect(rebooted.getMeetingSessionStatus('another-close').state).toBe('closed')
  })

  it('save: a KNOWN empty session says nothing_to_save (still 404); one the server never heard of stays session_not_found', async () => {
    const { closedAt } = await closedEmptySession('known-empty')
    const api = await routes()
    const closed = await api.save('known-empty')
    expect(closed.status).toBe(404)
    expect(closed.body).toEqual({ error: 'Nothing to save for session known-empty', reason: 'nothing_to_save', state: 'closed' })

    const mod: any = await import('./transcribe-stream.js')
    mod.__sessionsForTests.set('live-empty', { chunks: [], startTime: Date.now(), title: 'x', lastActivityAt: Date.now() })
    expect((await api.save('live-empty')).body).toMatchObject({ reason: 'nothing_to_save', state: 'active' })

    expect(await api.save('never-heard-of')).toEqual({ status: 404, body: { error: 'No transcript found for session never-heard-of', reason: 'session_not_found' } })

    // Past retention the status route says missing, which app 6.9.465+ settles as terminal,
    // and save is back to the generic reason.
    vi.spyOn(Date, 'now').mockReturnValue(closedAt + RETENTION_MS + 1)
    expect(await api.status('known-empty')).toMatchObject({ sessionId: 'known-empty', state: 'missing', retainedUntil: null, saveReceipt: null })
    expect((await api.save('known-empty')).body).toMatchObject({ reason: 'session_not_found' })
  })
})
