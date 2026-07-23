import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingStore } from '../lib/meeting-store.js'
import { initializeServerInstanceId } from '../lib/server-instance-id.js'
import type { BatchTranscription } from '../lib/batch-transcript-quality.js'
import { createMeetingRouter } from './meeting.js'
import { createMeetingsRouter } from './meetings.js'

const TOKEN = 'meeting-route-token'
const roots: string[] = []
const servers: Server[] = []

interface HarnessOptions {
  batch: BatchTranscription
  drainError?: Error
  moveFails?: boolean
}

async function harness(options: HarnessOptions) {
  const parent = mkdtempSync(join(tmpdir(), 'cos-meeting-route-'))
  roots.push(parent)
  initializeServerInstanceId(join(parent, 'server-instance-id'))
  const recordingsRoot = join(parent, 'data', 'recordings')
  const pendingAudio = join(parent, 'data', 'pending-batch', 'meeting_route_001')
  mkdirSync(pendingAudio, { recursive: true })
  writeFileSync(join(pendingAudio, 'chunk_0000.wav'), Buffer.from('raw recovery evidence'))
  const store = new MeetingStore(recordingsRoot)
  const background: Promise<void>[] = []
  const deleted = vi.fn()
  const chunks = [
    { text: 'The team reviewed launch evidence and assigned a clear owner.', speaker: 'Speaker A', elapsed: 1_000, similarity: 0.9 },
    { text: 'The follow-up is due next week.', speaker: 'Speaker B', elapsed: 125_000, similarity: 0.8 },
  ]
  const sessions = {
    getTranscript: () => '[Speaker A]: The team reviewed launch evidence and assigned a clear owner.\n[Speaker B]: The follow-up is due next week.',
    getStartTime: () => new Date(2026, 6, 15, 14, 5).getTime(),
    getChunks: () => chunks,
    getChunkEntries: () => [
      { chunkIndex: 0, chunk: chunks[0] },
      { chunkIndex: 2, chunk: chunks[1] },
    ],
    getProviderCandidates: () => ({}),
    getIntegrity: () => ({
      received: 2,
      stored: 2,
      maxIndex: 2,
      expected: 3,
      missingIndices: [1],
      completeness: 2 / 3,
    }),
    drainAudioWrites: async () => {
      if (options.drainError) throw options.drainError
    },
    hasAudio: () => true,
    moveAudioToPending: () => options.moveFails ? null : pendingAudio,
    delete: deleted,
  }

  const app = express()
  // Real server boundary: auth runs before the general JSON parser and routes.
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== TOKEN) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  })
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', createMeetingRouter({
    store,
    sessions,
    runBatch: async () => options.batch,
    scheduleBackground: task => { background.push(task) },
    emit: vi.fn(),
  }))
  app.use('/api', createMeetingsRouter(store))

  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  servers.push(server)
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const api = (path: string, init: RequestInit = {}, auth = true) => fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { 'x-cos-token': TOKEN } : {}),
      ...(init.headers ?? {}),
    },
  })
  return { api, background, deleted, parent, pendingAudio, recordingsRoot, store, server }
}

function acceptedBatch(): BatchTranscription {
  return {
    transcriptionQuality: 'batch',
    batchTranscript: 'The improved batch transcript preserves a complete and varied account of the launch discussion and its assigned owner.',
    batchSegments: [],
    qualityReport: {
      accepted: true,
      reason: 'accepted',
      batchWordCount: 17,
      streamingWordCount: 19,
      coverageRatio: 0.8947,
      timedWordCount: 0,
      timedWordRatio: 0,
      maxRepeatedUnitCount: 0,
      duplicateWordRatio: 0,
    },
  }
}

function rejectedBatch(): BatchTranscription {
  return {
    transcriptionQuality: 'streaming',
    qualityReport: {
      accepted: false,
      reason: 'repetitive-output',
      batchWordCount: 100,
      streamingWordCount: 20,
      coverageRatio: 5,
      timedWordCount: 0,
      timedWordRatio: 0,
      maxRepeatedUnitCount: 20,
      duplicateWordRatio: 0.6,
    },
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('meeting save/list/detail API', () => {
  it('authenticates, saves, lists, details, and idempotently replays an accepted meeting', async () => {
    const h = await harness({ batch: acceptedBatch() })
    expect((await h.api('/api/meeting/save', { method: 'POST', body: '{}' }, false)).status).toBe(401)
    expect((await h.api('/api/meetings', {}, false)).status).toBe(401)

    const savedRes = await h.api('/api/meeting/save', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'meeting_route_001', title: 'Route integration', domain: 'personal' }),
    })
    expect(savedRes.status).toBe(200)
    expect(savedRes.headers.get('cache-control')).toBe('private, no-store')
    const saved = await savedRes.json() as any
    expect(saved).toMatchObject({
      receiptVersion: 1,
      serverInstanceId: expect.any(String),
      saved: true,
      filename: expect.stringMatching(/^2026-07-15_Route_integration_[a-f0-9]{8}\.md$/),
      filepath: expect.stringMatching(/^recordings\/2026-07\//),
      durationMin: 2,
      domain: 'personal',
      transferIntegrity: {
        completeness: 66.6,
        received: 2,
        expected: 3,
        missingChunks: 1,
        missingIndices: [1],
      },
    })
    expect(saved.filepath.startsWith('/')).toBe(false)
    const status = await h.api('/api/meeting/sessions/meeting_route_001/status')
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('private, no-store')
    expect(await status.json()).toMatchObject({
      sessionId: 'meeting_route_001',
      state: 'saved',
      serverInstanceId: saved.serverInstanceId,
      receivedRanges: [],
      receivedCount: 0,
      asrCompletedRanges: [],
      asrCompletedCount: 0,
      canonicalRanges: [],
      canonicalCount: 0,
      maxChunkIndex: -1,
      saveReceipt: {
        receiptVersion: 1,
        filename: saved.filename,
      },
    })
    await Promise.all(h.background)
    expect(h.deleted).toHaveBeenCalledWith('meeting_route_001', { preserveAudio: false })
    expect(existsSync(h.pendingAudio)).toBe(false)

    const listRes = await h.api('/api/meetings?limit=20&domain=all')
    expect(listRes.status).toBe(200)
    expect(listRes.headers.get('cache-control')).toBe('private, no-store')
    const list = await listRes.json() as any
    expect(list.meetings).toHaveLength(1)
    expect(list.meetings[0].filename).toBe(saved.filename)

    const detailPath = `/api/meetings/detail?domain=personal&month=2026-07&filename=${encodeURIComponent(saved.filename)}`
    const detailRes = await h.api(detailPath)
    expect(detailRes.status).toBe(200)
    const detail = await detailRes.json() as any
    expect(detail.summary).toContain('improved batch transcript')
    expect(detail.transcript).toContain('improved batch transcript')
    expect(detail.sourceContent).toContain('# Route integration')
    expect(detail.sourceContent).toContain('## Transcript')
    expect(detail.sourceTruncated).toBe(false)

    const compatibleDetail = await h.api(`/api/meetings/personal/2026-07/${encodeURIComponent(saved.filename)}`)
    expect(compatibleDetail.status).toBe(200)
    expect(await compatibleDetail.json()).toMatchObject({
      sourceContent: expect.stringContaining('## Transcript'),
      sourceTruncated: false,
    })

    const replay = await h.api('/api/meeting/save', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'meeting_route_001' }),
    })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ replayed: true, filename: saved.filename })
    expect(readdirSync(join(h.recordingsRoot, '2026-07')).filter(name => name.endsWith('.md'))).toHaveLength(1)
  })

  it('rejects mismatched status/save pins before any meeting mutation', async () => {
    const h = await harness({ batch: acceptedBatch() })
    const wrongStatus = await h.api('/api/meeting/sessions/meeting_route_001/status?serverInstanceId=wrong-server', {
      headers: { 'x-cos-server-instance': 'wrong-server' },
    })
    expect(wrongStatus.status).toBe(409)
    expect(await wrongStatus.json()).toMatchObject({ reason: 'server_instance_mismatch' })

    const wrongSave = await h.api('/api/meeting/save', {
      method: 'POST',
      headers: { 'x-cos-server-instance': 'wrong-server' },
      body: JSON.stringify({ sessionId: 'meeting_route_001', serverInstanceId: 'wrong-server' }),
    })
    expect(wrongSave.status).toBe(409)
    expect(await wrongSave.json()).toMatchObject({ reason: 'server_instance_mismatch' })
    expect(h.deleted).not.toHaveBeenCalled()
    expect(h.store.findBySessionId('meeting_route_001')).toBeNull()
  })

  it('retains rejected raw audio and canonical streaming text', async () => {
    const h = await harness({ batch: rejectedBatch() })
    const response = await h.api('/api/meeting/save', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'meeting_route_001', title: 'Rejected batch' }),
    })
    const saved = await response.json() as any
    await Promise.all(h.background)
    expect(existsSync(h.pendingAudio)).toBe(true)
    const meetingPath = join(h.recordingsRoot, '2026-07', saved.filename)
    expect(readFileSync(meetingPath, 'utf8')).toContain('The team reviewed launch evidence')
    const sidecar = JSON.parse(readFileSync(meetingPath.replace(/\.md$/, '.g2-chunks.json'), 'utf8'))
    expect(sidecar).toMatchObject({
      transcriptionQuality: 'streaming',
      batchApplied: false,
      batchQualityReport: { reason: 'repetitive-output' },
    })
  })

  it('rejects invalid detail references and preserves source audio when move fails', async () => {
    const h = await harness({ batch: acceptedBatch(), moveFails: true })
    expect((await h.api('/api/meetings/detail?month=2026-07&filename=x.md')).status).toBe(400)
    expect((await h.api('/api/meetings/detail?domain=personal&month=..%2F07&filename=..%2Fsecret.md')).status).toBe(400)

    const response = await h.api('/api/meeting/save', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'meeting_route_001' }),
    })
    expect(response.status).toBe(200)
    expect(h.deleted).toHaveBeenCalledWith('meeting_route_001', { preserveAudio: true })
    expect(h.background).toHaveLength(0)
    expect(existsSync(h.pendingAudio)).toBe(true)
  })

  it('skips batch but closes safely when one raw write failed after settling', async () => {
    const h = await harness({ batch: acceptedBatch(), drainError: new Error('injected write failure') })
    const response = await h.api('/api/meeting/save', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'meeting_route_001' }),
    })
    expect(response.status).toBe(200)
    expect(h.background).toHaveLength(0)
    expect(h.deleted).toHaveBeenCalledWith('meeting_route_001', { preserveAudio: false })
    expect(existsSync(h.pendingAudio)).toBe(true)
  })
})
