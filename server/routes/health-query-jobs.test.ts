import express from 'express'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
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

beforeAll(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'cos-public-query-health-'))
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root

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
    })
    expect(body.durable_query_jobs).toMatchObject({
      configured: true,
      enabled: true,
      protocolVersion: 1,
      state: 'ready',
    })
    expect(JSON.stringify(body)).not.toContain(root)
    expect(body.durable_query_jobs).not.toHaveProperty('store')
    expect(body.durable_query_jobs).not.toHaveProperty('retainedIdentities')
    expect(body.features.localFirstMeetings).toBe(true)
    expect(body.capabilities?.localFirstMeetings).toMatchObject({
      protocolVersion: 1,
      idempotentSave: true,
      sessionStatus: true,
      retentionMs: 4 * 60 * 60 * 1000,
    })
    expect(body.capabilities.localFirstMeetings.serverInstanceId).toMatch(/^[0-9a-f-]{36}$/i)
  }, 20_000)

  it('publishes the same authenticated model-catalog capability shape', async () => {
    const response = await fetch(`${base}/api/models`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.capabilities?.durableQueryJobs).toEqual({
      enabled: true,
      protocolVersion: 1,
    })
    expect(body.capabilities?.localFirstMeetings).toMatchObject({
      protocolVersion: 1,
      idempotentSave: true,
      sessionStatus: true,
    })
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
    expect(models.capabilities?.durableQueryJobs).toEqual({
      enabled: false,
      protocolVersion: 1,
    })
  }, 20_000)
})
