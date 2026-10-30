import express from 'express'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_MEETING_BYTES } from '../lib/meeting-file-guards.js'
import { MeetingFinalizationJobStore } from '../lib/meeting-finalization-jobs.js'
import { MeetingStore } from '../lib/meeting-store.js'
import { createStopIntentStore } from '../lib/meeting-stop-intents.js'
import { initializeServerInstanceId } from '../lib/server-instance-id.js'
import { getMeetingSessionStatus } from './transcribe-stream.js'
import { createMeetingRouter } from './meeting.js'

// The installed failure had a closed live ledger and an already committed,
// finalized Mac record. Keep the actual store/status/save routes; only the
// in-memory capture ledger is replaced. No audio, ASR, timers or external calls.
vi.mock('./transcribe-stream.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./transcribe-stream.js')>()
  return {
    ...actual,
    durableSessionRecoveryHasRun: () => true,
    getMeetingSessionStatus: vi.fn((): import('./transcribe-stream.js').MeetingSessionStatusSnapshot => ({
      state: 'closed', receivedRanges: [[0, 881]], receivedCount: 882,
      asrCompletedRanges: [[0, 881]], asrCompletedCount: 882,
      canonicalRanges: [[0, 881]], canonicalCount: 882, maxChunkIndex: 881,
      lastActivityAt: '2027-01-15T08:00:00.000Z', retainedUntil: '2027-01-16T08:00:00.000Z',
    })),
  }
})

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('large finalized meeting save receipts', () => {
  it.each([
    ['Mac', 'mac_5c820d63-4ed8-4a39-8b9c-0072dd4bdf54'],
    ['older G2', 'meeting_large_receipt_legacy'],
  ])('reports saved over a closed %s ledger and replays repeated old-client saves without duplicates', async (source, sessionId) => {
    const root = mkdtempSync(join(tmpdir(), 'cos-large-receipt-'))
    roots.push(root)
    const recordings = join(root, 'data', 'recordings')
    const store = new MeetingStore(recordings)
    const saved = store.save({
      sessionId, title: 'Long call fixture', domain: 'personal',
      transcript: '[Ext]: Fixture transcript.', chunks: [],
      startTime: new Date(2026, 9, 30, 11, 9).getTime(), durationMs: 88 * 60_000,
      transferIntegrity: { received: 882, stored: 882, expected: 882, maxIndex: 881, missingIndices: [], completeness: 1 },
    })
    const sidecar = JSON.parse(readFileSync(saved.sidecarPath, 'utf8'))
    if (source === 'Mac') Object.assign(sidecar, {
      sourceType: 'mac_system_audio',
      captureSource: { version: 1, captureId: sessionId, sessionId, sourceType: 'mac_system_audio', speakerPolicy: 'high-confidence' },
    })
    Object.assign(sidecar, { batchApplied: true, finalizationState: 'complete', batchTranscript: 'x'.repeat(MAX_MEETING_BYTES) })
    writeFileSync(saved.sidecarPath, JSON.stringify(sidecar))
    expect(statSync(saved.sidecarPath).size).toBeGreaterThan(MAX_MEETING_BYTES)
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    const original = [digest(saved.filepath), digest(saved.sidecarPath)]

    const serverInstanceId = initializeServerInstanceId(join(root, 'server-instance-id'))
    const getTranscript = vi.fn(() => null)
    const runBatch = vi.fn(async () => { throw new Error('A receipt replay cannot run ASR') })
    const scheduleBackground = vi.fn()
    const app = express()
    const token = 'isolated-receipt-token'
    app.use('/api', (req, res, next) => {
      if (req.headers['x-cos-token'] !== token) { res.status(401).json({ error: 'unauthorized' }); return }
      next()
    })
    app.use(express.json())
    app.use('/api', createMeetingRouter({
      store: new MeetingStore(recordings),
      sessions: {
        getTranscript, getStartTime: () => null, getChunks: () => [], getChunkEntries: () => [],
        getProviderCandidates: () => ({}), getIntegrity: () => null,
        drainAudioWrites: async () => {}, hasAudio: () => false, moveAudioToPending: () => null, delete: vi.fn(),
      },
      runBatch, scheduleBackground, emit: vi.fn(),
      finalizationJobs: new MeetingFinalizationJobStore(join(root, 'data', 'meeting-finalization-jobs')),
      stopIntents: createStopIntentStore({ path: join(root, 'data', 'meeting-stop-intents.json') }),
      autonomousFinalize: { schedule: () => () => {}, ready: () => false, log: () => {} },
    }))
    const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    servers.push(server)
    const address = server.address()
    if (!address || typeof address !== 'object') throw new Error('Expected an ephemeral test port')
    const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-COS-Token': token, 'X-COS-Server-Instance': serverInstanceId },
    })

    expect(getMeetingSessionStatus(sessionId).state).toBe('closed')
    const status = await api(`/meeting/sessions/${sessionId}/status`)
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('private, no-store')
    const expectedReceipt = {
      receiptVersion: 1, saved: true, serverInstanceId, filename: saved.filename,
      filepath: `recordings/${saved.month}/${saved.filename}`, durationMin: 88,
      transferIntegrity: { completeness: 100, received: 882, expected: 882, missingChunks: 0, missingIndices: [] },
      ...(source === 'Mac' ? { captureId: sessionId, sessionId, sourceType: 'mac_system_audio' } : {}),
    }
    expect(await status.json()).toMatchObject({ state: 'saved', sessionId, saveReceipt: expectedReceipt, retainedUntil: null })
    for (let retry = 0; retry < 2; retry++) {
      // Old clients send only the session id after losing a save response.
      const replay = await api('/meeting/save', { method: 'POST', body: JSON.stringify({ sessionId }) })
      expect(replay.status).toBe(200)
      expect(await replay.json()).toMatchObject({ ...expectedReceipt, replayed: true })
    }
    expect(readdirSync(join(recordings, saved.month)).sort()).toEqual([saved.filename, saved.filename.replace(/\.md$/, '.g2-chunks.json')].sort())
    expect([digest(saved.filepath), digest(saved.sidecarPath)]).toEqual(original)
    expect(getTranscript).not.toHaveBeenCalled()
    expect(runBatch).not.toHaveBeenCalled()
    expect(scheduleBackground).not.toHaveBeenCalled()
  })
})
