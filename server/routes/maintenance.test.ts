import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  activeJobs: 0,
  activeSessions: 0,
  restartStatus: 'recovered' as 'recovered' | 'failed',
}))

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
vi.mock('../lib/whisper-local.js', () => ({
  getWhisperHealth: () => ({
    server: true,
    cli: true,
    consecutiveFailures: 0,
    restarting: false,
    circuitOpen: false,
  }),
  restartWhisperServer: async () => state.restartStatus === 'recovered'
    ? { status: 'recovered' }
    : { status: 'failed', error: 'test failure' },
}))
vi.mock('./transcribe-stream.js', () => ({
  getActiveTranscriptionSessionCount: () => state.activeSessions,
}))

let server: Server
let base = ''

beforeAll(async () => {
  const { maintenanceRouter } = await import('./maintenance.js')
  const app = express()
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
  state.restartStatus = 'recovered'
  process.env.COS_MANAGED = '1'
  process.env.COS_SERVER_VERSION = '6.13.0'
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  delete process.env.COS_MANAGED
  delete process.env.COS_SERVER_VERSION
})

describe('managed maintenance contract', () => {
  it('reports restart safety without leaking paths or credentials', async () => {
    const response = await fetch(`${base}/api/maintenance/status`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({
      contractVersion: 1,
      managed: true,
      serverVersion: '6.13.0',
      activeJobs: 0,
      activeTranscriptionSessions: 0,
      durableStoreState: 'ready',
      safeToRestart: true,
    })
    expect(JSON.stringify(body)).not.toMatch(/token|workdir|launchdir/i)
  })

  it('blocks lifecycle actions while durable work or transcription is active', async () => {
    state.activeJobs = 1
    let response = await fetch(`${base}/api/maintenance/status`)
    expect((await response.json() as any).safeToRestart).toBe(false)

    state.activeJobs = 0
    state.activeSessions = 1
    response = await fetch(`${base}/api/maintenance/whisper/restart`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'active_transcription_sessions',
      activeTranscriptionSessions: 1,
      retryable: true,
    })
  })

  it('restarts Whisper only in managed, idle mode', async () => {
    const response = await fetch(`${base}/api/maintenance/whisper/restart`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'recovered',
      whisper: { server: true, circuitOpen: false },
    })
  })
})
