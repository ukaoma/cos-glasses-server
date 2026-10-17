import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingStore } from '../lib/meeting-store.js'
import { MeetingFinalizationJobStore } from '../lib/meeting-finalization-jobs.js'
import { initializeServerInstanceId } from '../lib/server-instance-id.js'
import { createStopRequestStore, STOP_REQUEST_CLAIM_WINDOW_MS } from '../lib/meeting-stop-requests.js'
import { createMeetingRouter } from './meeting.js'

// Control asks the glasses to stop a live G2 meeting (Miles 2026-10-17). The Mac never
// saves a live G2 session itself: the phone would keep recording and split the meeting.

const TOKEN = 'stop-request-token'
const roots: string[] = []
const servers: Server[] = []

const opsEnvKeys = ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR'] as const
const previousOpsEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  // A standalone store: never the live COS ops tree.
  for (const key of opsEnvKeys) { previousOpsEnv[key] = process.env[key]; delete process.env[key] }
})

afterEach(async () => {
  for (const key of opsEnvKeys) { if (previousOpsEnv[key] == null) delete process.env[key]; else process.env[key] = previousOpsEnv[key] }
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function harness(opts: { state?: 'active' | 'closed' | 'missing' } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'cos-stop-request-'))
  roots.push(parent)
  initializeServerInstanceId(join(parent, 'server-instance-id'))
  const store = new MeetingStore(join(parent, 'data', 'recordings'))
  let clock = 1_000_000
  const stopRequests = createStopRequestStore({ now: () => clock })
  const emit = vi.fn()
  const deleted = vi.fn()
  const chunk = { text: 'Hello there.', speaker: 'Speaker A', elapsed: 61_000, similarity: 0.9 }
  const sessionState = { value: opts.state ?? 'active' as 'active' | 'closed' | 'missing' }
  const sessions = {
    getTranscript: () => '[Speaker A]: Hello there.',
    getStartTime: () => 1_000,
    getChunks: () => [chunk],
    getChunkEntries: () => [{ chunkIndex: 0, chunk }],
    getProviderCandidates: () => ({}),
    getIntegrity: () => ({ received: 1, stored: 1, maxIndex: 0, expected: 1, missingIndices: [], completeness: 1 }),
    drainAudioWrites: async () => {},
    hasAudio: () => false,
    moveAudioToPending: () => null,
    delete: deleted,
    getState: () => sessionState.value,
  }
  const app = express()
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== TOKEN) { res.status(401).json({ error: 'unauthorized' }); return }
    next()
  })
  app.use(express.json())
  app.use('/api', createMeetingRouter({
    store,
    sessions,
    emit,
    stopRequests,
    finalizationJobs: new MeetingFinalizationJobStore(join(parent, 'data', 'meeting-finalization-jobs')),
    runBatch: async () => { throw new Error('no batch in this test') },
    scheduleBackground: () => {},
  }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-cos-token': TOKEN } })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  return {
    api, emit, deleted, store, sessionState,
    advance: (ms: number) => { clock += ms },
  }
}

const SID = 'g2_meeting_0001'
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

describe('stop request routes', () => {
  it('asks the glasses through the display bus and never saves or closes the session itself', async () => {
    const h = await harness()
    const asked = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({ source: 'control' }))
    expect(asked.status).toBe(202)
    expect(asked.body).toMatchObject({ sessionId: SID, state: 'pending', claimWindowMs: STOP_REQUEST_CLAIM_WINDOW_MS })
    expect(typeof asked.body.requestId).toBe('string')
    expect(h.emit).toHaveBeenCalledTimes(1)
    expect(h.emit).toHaveBeenCalledWith({
      type: 'meeting_stop_requested',
      data: { sessionId: SID, requestId: asked.body.requestId, source: 'control', claimWindowMs: STOP_REQUEST_CLAIM_WINDOW_MS },
    })
    // The request alone changes nothing on the server: the glasses stop and save.
    expect(h.deleted).not.toHaveBeenCalled()
    expect(h.store.findBySessionId(SID)).toBeNull()
  })

  it('a double click asks once: the pending request is reused', async () => {
    const h = await harness()
    const a = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    const b = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    expect(b.body.requestId).toBe(a.body.requestId)
  })

  it('the glasses claim, then the poll says claimed', async () => {
    const h = await harness()
    const { body } = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    h.advance(1_500)
    const claim = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}/claim`, post({ decision: 'accept' }))
    expect(claim.status).toBe(200)
    expect(claim.body.state).toBe('claimed')
    const again = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}/claim`, post({ decision: 'accept' }))
    expect(again.status).toBe(200)
    const poll = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}`)
    expect(poll.body).toMatchObject({ state: 'claimed', claimedAt: 1_001_500 })
  })

  it('a claim after the window is refused, so a late phone or a replayed event never stops it', async () => {
    const h = await harness()
    const { body } = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    h.advance(STOP_REQUEST_CLAIM_WINDOW_MS + 1)
    const claim = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}/claim`, post({ decision: 'accept' }))
    expect(claim.status).toBe(409)
    expect(claim.body.reason).toBe('expired')
    const poll = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}`)
    expect(poll.body.state).toBe('expired')
    // After an expiry a new click is a new request.
    const next = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    expect(next.body.requestId).not.toBe(body.requestId)
  })

  it('a claim exactly at the window still counts', async () => {
    const h = await harness()
    const { body } = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    h.advance(STOP_REQUEST_CLAIM_WINDOW_MS)
    const claim = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}/claim`, post({ decision: 'accept' }))
    expect(claim.status).toBe(200)
  })

  it('the glasses can refuse with a reason Control can word', async () => {
    const h = await harness()
    const { body } = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    const refuse = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}/claim`, post({ decision: 'refuse', reason: 'not_recording' }))
    expect(refuse.status).toBe(200)
    expect(refuse.body).toMatchObject({ state: 'refused', refusal: 'not_recording' })
    const late = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}/claim`, post({ decision: 'accept' }))
    expect(late.status).toBe(409)
    expect(late.body.reason).toBe('refused')
    const bad = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}/claim`, post({ decision: 'refuse', reason: 'because' }))
    expect(bad.status).toBe(400)
    const odd = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}/claim`, post({ decision: 'maybe' }))
    expect(odd.status).toBe(400)
  })

  it('a request id from another session is unknown', async () => {
    const h = await harness()
    const { body } = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    const other = await h.api(`/api/meeting/sessions/g2_other_0002/stop-request/${body.requestId}/claim`, post({ decision: 'accept' }))
    expect(other.status).toBe(404)
    expect((await h.api(`/api/meeting/sessions/g2_other_0002/stop-request/${body.requestId}`)).status).toBe(404)
  })

  it('a meeting that is not recording is not asked about', async () => {
    const h = await harness({ state: 'closed' })
    const asked = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    expect(asked.status).toBe(409)
    expect(asked.body).toMatchObject({ reason: 'not_live', state: 'closed' })
    expect(h.emit).not.toHaveBeenCalled()
  })

  it('a saved meeting answers saved with its receipt, and a Mac recording is refused', async () => {
    const h = await harness()
    const { body } = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    const saved = await h.api('/api/meeting/save', post({ sessionId: SID }))
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const poll = await h.api(`/api/meeting/sessions/${SID}/stop-request/${body.requestId}`)
    expect(poll.body.state).toBe('saved')
    expect(poll.body.saveReceipt.filename).toBe(saved.body.filename)
    const afterSave = await h.api(`/api/meeting/sessions/${SID}/stop-request`, post({}))
    expect(afterSave.status).toBe(200)
    expect(afterSave.body.state).toBe('saved')
    const mac = await h.api('/api/meeting/sessions/mac_0123abcd-0123-4abc-8def-0123456789ab/stop-request', post({}))
    expect(mac.status).toBe(400)
    expect(mac.body.reason).toBe('mac_capture')
    const bad = await h.api('/api/meeting/sessions/a%20b/stop-request', post({}))
    expect(bad.status).toBe(400)
  })
})
