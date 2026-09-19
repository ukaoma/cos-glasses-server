import express from 'express'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/conversation.js', () => ({
  getOrCreateSession: () => 'health-session',
}))

let root = ''
let server: Server
let base = ''
let shutdown: (() => Promise<void>) | undefined
let meetingLibrary = ''

beforeAll(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'cos-public-query-health-'))
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root
  meetingLibrary = join(root, 'private-user-library')
  await mkdir(join(meetingLibrary, '2026-08'), { recursive: true })
  await writeFile(join(meetingLibrary, '2026-08', 'private.md'), '# Private meeting\n')
  process.env.COS_MEETINGS_ROOT = meetingLibrary

  const runtime = await import('../lib/query-job-runtime.js')
  await runtime.initQueryJobRuntime()
  shutdown = () => runtime.shutdownQueryJobRuntime('test_shutdown')
  const identity = await import('../lib/server-instance-id.js')
  identity.initializeServerInstanceId(join(root, 'server-instance-id'))
  const { healthRouter } = await import('./health.js')
  const app = express()
  app.use('/api', healthRouter)
  server = await new Promise<Server>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await shutdown?.()
  delete process.env.COS_DURABLE_QUERY_JOBS
  delete process.env.COS_QUERY_JOB_DIR
  delete process.env.COS_MEETINGS_ROOT
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
})

describe('public durable-query capability health', () => {
  it('advertises the protocol only after its journal is ready without exposing its path', async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.features).toMatchObject({
      durableQueryJobs: true,
      durableQueryJobsProtocol: 1,
      cursor: expect.any(Boolean),
    })
    expect(body.cursor_models).toMatchObject({
      source: expect.any(String),
      options: [
        expect.objectContaining({ preference: 'cursor-grok' }),
        expect.objectContaining({ preference: 'cursor-composer' }),
      ],
    })
    expect(body.cursor_models).not.toHaveProperty('agentBinary')
    expect(body.durable_query_jobs).toMatchObject({
      configured: true,
      enabled: true,
      protocolVersion: 1,
      state: 'ready',
    })
    expect(JSON.stringify(body)).not.toContain(root)
    expect(body.meeting_library).toEqual({ layout: 'direct', ready: true, warningCount: 0 })
    expect(JSON.stringify(body)).not.toContain(meetingLibrary)
    expect(body.durable_query_jobs).not.toHaveProperty('store')
    // 6.52.0: the trail readers' counters, counts and a timestamp only.
    expect(body.messages_trail).toEqual({
      enabled: true,
      linesRead: expect.any(Number),
      entriesEmitted: expect.any(Number),
      readerErrors: expect.any(Number),
      lastErrorAt: expect.toSatisfy((value: unknown) => value === null || typeof value === 'string'),
    })
    expect(body.durable_query_jobs).not.toHaveProperty('retainedIdentities')
    expect(body.features.localFirstMeetings).toBe(true)
    expect(body.features.transcriptionPolicy).toBe('local-only')
    expect(body.capabilities?.transcription).toMatchObject({
      mode: 'local-only',
      localRequired: true,
      openaiFallbackConfigured: false,
      openaiFallbackReady: false,
    })
    expect(body.capabilities?.transcription?.hq).toEqual({
      hqAvailable: expect.any(Boolean),
      model: expect.toSatisfy((value: unknown) => value === null || value === 'large-v3'),
      backend: expect.toSatisfy((value: unknown) => value === null || value === 'whisper-cli'),
      reason: expect.toSatisfy((value: unknown) => value === null || typeof value === 'string'),
    })
    expect(body.capabilities?.recovery).toEqual({
      status: false,
      restartWhisper: false,
      restartServer: false,
      maintenanceDrain: false,
      lifecycleProof: false,
      managed: false,
      contractVersion: 2,
    })
    expect(body.capabilities?.cliDebug).toEqual({
      schemaVersion: 1,
      providers: { claude: true, codex: true, cursor: true },
      metadataOnly: true,
    })
    expect(typeof body.cli_session_available).toBe('boolean')
    expect(body).not.toHaveProperty('cli_session_id')
    expect(body.capabilities?.localFirstMeetings).toMatchObject({
      protocolVersion: 1,
      idempotentSave: true,
      sessionStatus: true,
      pinnedServerIdentity: true,
      asrCompletionStatus: true,
      retentionMs: 4 * 60 * 60 * 1000,
    })
    expect(body.capabilities.localFirstMeetings.serverInstanceId).toMatch(/^[0-9a-f-]{36}$/i)
  }, 20_000)

  it('publishes the same authenticated model-catalog capability shape', async () => {
    const response = await fetch(`${base}/api/models`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(typeof body.cursorReady).toBe('boolean')
    expect(typeof body.ollamaReady).toBe('boolean')
    expect(body.ollama).toEqual(expect.objectContaining({
      origin: expect.any(String),
      model: expect.any(String),
    }))
    expect(body.cursor?.options).toEqual([
      expect.objectContaining({ preference: 'cursor-grok' }),
      expect.objectContaining({ preference: 'cursor-composer' }),
    ])
    // 6.52.0 adds `trail` deliberately: the app reads it here to choose the trail view.
    expect(body.capabilities?.durableQueryJobs).toEqual({
      enabled: true,
      protocolVersion: 1,
      trail: true,
    })
    // 6.52.0: the session questions contract, beside the trail. No broker is registered in
    // this harness, so it reads off; the numbers are the client contract.
    expect(body.capabilities?.sessionQuestions).toEqual({
      enabled: false,
      mode: 'off',
      protocolVersion: 1,
      pollIntervalMs: 10_000,
      liveWindowMs: 30_000,
    })
    expect(body.capabilities?.localFirstMeetings).toMatchObject({
      protocolVersion: 1,
      idempotentSave: true,
      sessionStatus: true,
      pinnedServerIdentity: true,
      asrCompletionStatus: true,
    })
    expect(body.capabilities?.transcription).toMatchObject({
      mode: 'local-only',
      localRequired: true,
      openaiFallbackConfigured: false,
      openaiFallbackReady: false,
    })
    expect(body.capabilities?.transcription?.hq).toEqual({
      hqAvailable: expect.any(Boolean),
      model: expect.toSatisfy((value: unknown) => value === null || value === 'large-v3'),
      backend: expect.toSatisfy((value: unknown) => value === null || value === 'whisper-cli'),
      reason: expect.toSatisfy((value: unknown) => value === null || typeof value === 'string'),
    })
    expect(body.capabilities?.recovery).toEqual({
      status: false,
      restartWhisper: false,
      restartServer: false,
      maintenanceDrain: false,
      lifecycleProof: false,
      managed: false,
      contractVersion: 2,
    })
    expect(body.capabilities?.cliDebug).toEqual({
      schemaVersion: 1,
      providers: { claude: true, codex: true, cursor: true },
      metadataOnly: true,
    })
  }, 20_000)

  it('advertises the trail as off when COS_MESSAGES_TRAIL=0, jobs still on', async () => {
    process.env.COS_MESSAGES_TRAIL = '0'
    try {
      const response = await fetch(`${base}/api/models`)
      const body = await response.json() as any
      expect(body.capabilities?.durableQueryJobs).toEqual({ enabled: true, protocolVersion: 1, trail: false })
    } finally {
      delete process.env.COS_MESSAGES_TRAIL
    }
  }, 20_000)

  it('advertises session questions from the registered broker, and public health never says how many are held', async () => {
    const { PermissionBroker, registerPermissionBroker, CLIENT_LIVE_WINDOW_MS, QUESTIONS_POLL_INTERVAL_MS } = await import('../lib/permission-broker.js')
    const broker = new PermissionBroker({
      now: () => Date.now(), mode: () => 'questions', admissionsOpen: () => true, lastQuestionsPollAt: () => null,
      readDeskIdleSeconds: async () => 1_000, deskIdleSeconds: () => 90, timeoutMs: () => 110_000, log: () => {},
    })
    registerPermissionBroker(broker)
    try {
      const models = await (await fetch(`${base}/api/models`)).json() as any
      expect(models.capabilities?.sessionQuestions).toEqual({
        enabled: true, mode: 'questions', protocolVersion: 1, pollIntervalMs: QUESTIONS_POLL_INTERVAL_MS, liveWindowMs: CLIENT_LIVE_WINDOW_MS,
      })
      const health = await (await fetch(`${base}/api/health`)).json() as any
      expect(health.permissionBroker).toMatchObject({ enabled: true, mode: 'questions', lastFastPath: null, lastQuestionsPollAt: null })
      expect(health.permissionBroker).not.toHaveProperty('pending')
      expect(Object.keys(health.permissionBroker.counters).sort()).toEqual([
        'answered', 'deskUnreadable', 'drained', 'expired', 'fastPath', 'handedToDesk', 'hookGone', 'invalidAnswer', 'noClient', 'parked', 'retracted',
      ])
    } finally {
      broker.stop()
      registerPermissionBroker(null)
    }
  }, 20_000)

  it('fails closed on both capability surfaces once shutdown begins', async () => {
    await shutdown?.()

    const healthResponse = await fetch(`${base}/api/health`)
    expect(healthResponse.status).toBe(200)
    const health = await healthResponse.json() as any
    expect(health.features.durableQueryJobs).toBe(false)
    expect(health.durable_query_jobs).toMatchObject({
      configured: true,
      enabled: false,
      state: 'ready',
    })

    const modelResponse = await fetch(`${base}/api/models`)
    expect(modelResponse.status).toBe(200)
    const models = await modelResponse.json() as any
    // A server that cannot take jobs cannot offer their trail either.
    expect(models.capabilities?.durableQueryJobs).toEqual({
      enabled: false,
      protocolVersion: 1,
      trail: false,
    })
  }, 20_000)
})
