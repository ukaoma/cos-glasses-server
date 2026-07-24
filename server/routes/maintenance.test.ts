import { createHash } from 'node:crypto'
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ activeJobs: 0, activeSessions: 0 }))

vi.mock('../lib/query-job-runtime.js', () => ({
  getQueryJobRuntimeHealth: () => ({
    activeRuns: state.activeJobs,
    shuttingDown: false,
    store: { state: 'ready' },
  }),
}))
vi.mock('../lib/server-instance-id.js', () => ({
  getServerInstanceId: () => '11111111-1111-4111-8111-111111111111',
}))
vi.mock('../lib/server-metrics.js', () => ({
  serverMetrics: {
    bootId: '22222222-2222-4222-8222-222222222222',
    startedAt: Date.now(),
    requestCount: 0,
  },
}))
vi.mock('../lib/whisper-local.js', () => ({
  getWhisperHealth: () => ({
    server: true,
    cli: true,
    consecutiveFailures: 0,
    restarting: false,
    circuitOpen: false,
  }),
}))
vi.mock('./transcribe-stream.js', () => ({
  getActiveTranscriptionSessionCount: () => state.activeSessions,
}))

let server: Server
let base = ''
let dataDir = ''
let activeLease = ''
const operationId = 'operation-route-test'
const nonce = 'route_controller_nonce_0123456789abcdefABCDEF'
const nonceSha256 = createHash('sha256').update(nonce, 'utf8').digest('hex')
const identity = {
  serverInstanceId: '11111111-1111-4111-8111-111111111111',
  bootId: '22222222-2222-4222-8222-222222222222',
  generationId: 'generation-test-42',
  operationId,
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cos-maintenance-route-'))
  process.env.COS_DATA_DIR = dataDir
  process.env.COS_MANAGED = '1'
  process.env.COS_SERVER_VERSION = '6.13.0'
  process.env.COS_SERVER_GENERATION_ID = 'generation-test-42'
  const { maintenanceRouter } = await import('./maintenance.js')
  const app = express()
  app.use(express.json())
  app.use('/api', maintenanceRouter)
  server = await new Promise<Server>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

beforeEach(() => {
  state.activeJobs = 0
  state.activeSessions = 0
})

function proofHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-COS-Maintenance-Lease': activeLease,
    'X-COS-Maintenance-Operation': operationId,
    'X-COS-Maintenance-Nonce': nonce,
  }
}

afterEach(async () => {
  if (!activeLease) return
  await fetch(`${base}/api/maintenance/drain/cancel`, {
    method: 'POST', headers: proofHeaders(), body: JSON.stringify(identity),
  })
  activeLease = ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.COS_DATA_DIR
  delete process.env.COS_MANAGED
  delete process.env.COS_SERVER_VERSION
  delete process.env.COS_SERVER_GENERATION_ID
})

async function beginDrain() {
  const response = await fetch(`${base}/api/maintenance/drain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...identity,
      operationKind: 'server_update',
      scope: 'cross_boot',
      postcondition: 'authorized_successor_adopted',
      nonceSha256,
      authorizedSuccessorGenerations: ['generation-next', 'generation-test-42'],
    }),
  })
  const body = await response.json() as any
  activeLease = body.leaseId
  return { response, body }
}

describe('managed maintenance rev4 contract', () => {
  it('requires credentialed source proof for safe bootout', async () => {
    let response = await fetch(`${base}/api/maintenance/status`)
    let body = await response.json() as any
    expect(body).toMatchObject({
      contractVersion: 2,
      managed: true,
      generationId: 'generation-test-42',
      serverInstanceId: identity.serverInstanceId,
      bootId: identity.bootId,
      safeToRestart: false,
      lifecycle: { state: 'accepting', admissionsOpen: true },
    })

    ;({ response, body } = await beginDrain())
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      leaseId: activeLease,
      safeToRestart: false,
      lifecycle: {
        state: 'draining',
        admissionsOpen: false,
        operation: {
          version: 2,
          operationId,
          nonceSha256,
          authorizedSuccessorGenerations: ['generation-next', 'generation-test-42'],
          expiresAt: null,
        },
      },
    })

    response = await fetch(`${base}/api/maintenance/status`, { headers: proofHeaders() })
    body = await response.json() as any
    expect(body).toMatchObject({
      safeToRestart: true,
      lifecycle: {
        restartProof: {
          valid: true,
          leaseMatches: true,
          operationMatches: true,
          nonceMatches: true,
          sourceIdentityMatches: true,
        },
      },
    })
    expect(JSON.stringify(body)).not.toContain(nonce)
  })

  it('keeps proof unsafe while work or a recording session remains', async () => {
    state.activeJobs = 1
    let result = await beginDrain()
    let response = await fetch(`${base}/api/maintenance/status`, { headers: proofHeaders() })
    expect((await response.json() as any).safeToRestart).toBe(false)
    await fetch(`${base}/api/maintenance/drain/cancel`, {
      method: 'POST', headers: proofHeaders(), body: JSON.stringify(identity),
    })
    activeLease = ''

    state.activeJobs = 0
    state.activeSessions = 1
    result = await beginDrain()
    response = await fetch(`${base}/api/maintenance/status`, { headers: proofHeaders() })
    const body = await response.json() as any
    expect(body.safeToRestart).toBe(false)
    expect(body.lifecycle.activeByKind.recording_session).toBe(1)
  })

  it('fails typed on incomplete operation acquisition and removes Whisper mutation', async () => {
    let response = await fetch(`${base}/api/maintenance/drain`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(identity),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_maintenance_operation' })

    response = await fetch(`${base}/api/maintenance/whisper/restart`, { method: 'POST' })
    expect(response.status).toBe(404)
  })
})
