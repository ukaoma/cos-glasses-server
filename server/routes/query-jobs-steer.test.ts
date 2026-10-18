// 6.78.0 Messages steer over HTTP: the real router, coordinator and store, a fake runner that
// drives the SteerPort as the Claude bridge does. Every reply and error is checked against the
// wire contract (pi_durable_build/contracts/messages-steer.json, copied byte for byte).
import express from 'express'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/conversation.js', () => ({ getOrCreateSession: () => 'steer-http-session' }))

import { QueryJobCoordinator, type QueryJobRunner } from '../lib/query-job-coordinator.js'
import { QueryJobStore } from '../lib/query-job-store.js'
import type { SteerPort } from '../lib/claude-steer.js'
import { createQueryJobsRouter } from './query-jobs.js'
import { messagesSteerCapability } from '../lib/query-job-feature.js'

const CONTRACT = JSON.parse(readFileSync(join(import.meta.dirname, '../lib/__fixtures__/pi-durable/contracts/messages-steer.json'), 'utf8'))

let root = ''
let coordinator: QueryJobCoordinator
const servers: Server[] = []
let on = ''
let off = ''
const ports = new Map<string, { port: SteerPort; lines: string[]; finish: (text: string) => Promise<void> }>()

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  const address = server.address()
  return typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
}

const runner: QueryJobRunner = async ctx => {
  await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude', resolvedModel: 'opus' })
  await ctx.callbacks.onProviderProcess({ provider: 'claude', claudeRunId: `run-${ctx.jobId.slice(0, 4)}` })
  const lines: string[] = []
  if (ctx.steer) {
    ctx.steer.drainForCompose()
    ctx.steer.open(line => { lines.push(line); return true }, { startedAt: Date.now(), wallMaxMs: 600_000 })
    ports.set(ctx.jobId, {
      port: ctx.steer, lines,
      finish: async text => { await ctx.callbacks.onAnswerReady(text); await ctx.callbacks.onDone({ text }) },
    })
  }
  await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cos-steer-http-'))
  coordinator = new QueryJobCoordinator(new QueryJobStore({ root, bootId: randomUUID() }), runner, {
    resolveSessionId: () => 'steer-http-session',
    partialFlushMs: 0,
    steer: { enabled: () => true, provider: request => request.model === 'codex-frontier' ? 'codex' : 'claude', cliSupported: async () => true },
  })
  await coordinator.init()
  const a = express(); a.use(express.json())
  a.use('/api', createQueryJobsRouter(coordinator, { enabled: () => true, steerEnabled: () => true, heartbeatMs: 1_000 }))
  on = await listen(a)
  const b = express(); b.use(express.json())
  b.use('/api', createQueryJobsRouter(coordinator, { enabled: () => true, steerEnabled: () => false, heartbeatMs: 1_000 }))
  off = await listen(b)
})

afterAll(async () => {
  await coordinator.shutdown('test_shutdown')
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await rm(root, { recursive: true, force: true })
})

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

async function startJob(extra: Record<string, unknown> = {}): Promise<{ jobId: string; clientJobId: string }> {
  const clientJobId = randomUUID()
  const admitted = await post(on, '/query-jobs', { clientJobId, generation: 1, query: 'read the README', steerable: true, ...extra })
  expect(admitted.status).toBe(202)
  const jobId = admitted.body.job.jobId as string
  const deadline = Date.now() + 2_000
  while (!ports.has(jobId) && Date.now() < deadline) {
    const job = (await (await fetch(`${on}/api/query-jobs/${jobId}?generation=1`)).json()).job
    if (job.status === 'running' && !extra.steerable && extra.model) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return { jobId, clientJobId }
}

async function sseText(base: string, jobId: string, query: string, settleMs = 150): Promise<string> {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/query-jobs/${jobId}/events?generation=1&after=0${query}`, { signal: controller.signal })
  const reader = res.body!.getReader()
  let text = ''
  const stop = setTimeout(() => controller.abort(), settleMs)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
  } catch { /* aborted */ }
  clearTimeout(stop)
  return text
}

describe('POST /api/query-jobs/:jobId/steer (contract 5.2)', () => {
  it('accepted, then folded: the reply shapes are the contract\'s', async () => {
    const { jobId, clientJobId } = await startJob()
    const steerId = randomUUID()
    const accepted = await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId, text: CONTRACT.request.text })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toEqual({ ...CONTRACT.replies.accepted, steerId })
    const run = ports.get(jobId)!
    expect(run.lines).toHaveLength(1)
    run.port.events.onFolded?.([steerId])
    await run.finish('answer')
    const status = await fetch(`${on}/api/query-jobs/steers/${steerId}?clientJobId=${clientJobId}`)
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ ...CONTRACT.replies.folded, steerId, jobStatus: 'completed' })
    // After the answer: too_late, with the follow-up fallback.
    const late = await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId: randomUUID(), text: 'too late' })
    expect(late.body).toMatchObject({ state: CONTRACT.replies.too_late.state, fallback: CONTRACT.replies.too_late.fallback, jobStatus: 'completed' })
  })

  it('a Codex run is unsupported with the follow-up fallback', async () => {
    const { jobId } = await startJob({ model: 'codex-frontier' })
    const reply = await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId: randomUUID(), text: 'x' })
    expect(reply.body).toMatchObject({ state: 'unsupported', fallback: 'queue_follow_up' })
    expect(Object.keys(reply.body).sort()).toEqual(Object.keys(CONTRACT.replies.unsupported).sort())
  })

  it('errors are the contract\'s: conflict, generation, not found, limit, unknown, disabled', async () => {
    const { jobId, clientJobId } = await startJob()
    const steerId = randomUUID()
    await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId, text: 'one' })
    const conflict = await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId, text: 'two' })
    expect(conflict).toEqual({ status: CONTRACT.errors.conflict.status, body: CONTRACT.errors.conflict.body })
    const generation = await post(on, `/query-jobs/${jobId}/steer`, { generation: 2, steerId: randomUUID(), text: 'x' })
    expect(generation).toEqual({ status: CONTRACT.errors.generation.status, body: CONTRACT.errors.generation.body })
    const missing = await post(on, `/query-jobs/${randomUUID()}/steer`, { generation: 1, steerId: randomUUID(), text: 'x' })
    expect(missing).toEqual({ status: CONTRACT.errors.not_found.status, body: CONTRACT.errors.not_found.body })
    for (let i = 0; i < 7; i++) await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId: randomUUID(), text: `s${i}` })
    const limit = await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId: randomUUID(), text: 'ninth' })
    expect(limit).toEqual({ status: CONTRACT.errors.limit.status, body: CONTRACT.errors.limit.body })
    const unknown = await fetch(`${on}/api/query-jobs/steers/${randomUUID()}?clientJobId=${clientJobId}`)
    expect({ status: unknown.status, body: await unknown.json() }).toEqual({ status: CONTRACT.errors.lookup_unknown.status, body: CONTRACT.errors.lookup_unknown.body })
    const disabled = await post(off, `/query-jobs/${jobId}/steer`, { generation: 1, steerId: randomUUID(), text: 'x' })
    expect(disabled).toEqual({ status: CONTRACT.errors.disabled.status, body: CONTRACT.errors.disabled.body })
    const disabledLookup = await fetch(`${off}/api/query-jobs/steers/${steerId}?clientJobId=${clientJobId}`)
    expect(disabledLookup.status).toBe(404)
    const bad = await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId: 'not-a-uuid', text: 'x' })
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'invalid_steer_id' } } })
  })
})

describe('steers are opt-in on every read (old clients see the 6.77.0 bytes)', () => {
  it('snapshots carry steers only with ?steer=1, read as a client should see them', async () => {
    const { jobId } = await startJob()
    const steerId = randomUUID()
    await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId, text: 'x' })
    const plain = (await (await fetch(`${on}/api/query-jobs/${jobId}?generation=1`)).json()).job
    expect(plain).not.toHaveProperty('steers')
    const opted = (await (await fetch(`${on}/api/query-jobs/${jobId}?generation=1&steer=1`)).json()).job
    expect(opted.steers).toEqual([expect.objectContaining({ steerId, state: 'accepted', text: 'x' })])
    // The switch off: no steers even when asked.
    const offBody = (await (await fetch(`${off}/api/query-jobs/${jobId}?generation=1&steer=1`)).json()).job
    expect(offBody).toEqual(plain)
    await coordinator.cancel(jobId, 1)
    const ended = (await (await fetch(`${on}/api/query-jobs/${jobId}?generation=1&steer=1`)).json()).job
    expect(ended.steers[0].state).toBe('not_applied')
  })

  it('SSE: `steer` frames with no id line only with ?steer=1; the plain stream has none', async () => {
    const { jobId } = await startJob()
    const steerId = randomUUID()
    await post(on, `/query-jobs/${jobId}/steer`, { generation: 1, steerId, text: 'x' })
    const opted = await sseText(on, jobId, '&steer=1')
    const plain = await sseText(on, jobId, '')
    expect(plain).not.toContain('event: steer')
    expect(plain).not.toContain(steerId)
    const frame = opted.split('\n\n').find(block => block.includes('event: steer'))!
    expect(frame).toBeDefined()
    expect(frame.split('\n').some(line => line.startsWith('id:'))).toBe(CONTRACT.sse_frame.hasIdLine)
    const data = JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    expect(Object.keys(data).sort()).toEqual(Object.keys(CONTRACT.sse_frame.data).sort())
    expect(data).toMatchObject({ steerId, state: 'accepted' })
    // The steer frame did not move the job cursor: every id line is a job event.
    const ids = opted.split('\n').filter(line => line.startsWith('id: ')).map(line => Number(line.slice(4)))
    const plainIds = plain.split('\n').filter(line => line.startsWith('id: ')).map(line => Number(line.slice(4)))
    expect(ids).toEqual(plainIds)
  })
})

describe('the capability (contract `capability`, `capability_off`)', () => {
  it('present only with jobs on, the switch on, and a CLI that passed the probe', () => {
    expect(messagesSteerCapability({ jobsEnabled: true, cliSupported: true }, { COS_MESSAGES_STEER: '1' })).toEqual(CONTRACT.capability.durableQueryJobs.steer)
    expect(messagesSteerCapability({ jobsEnabled: true, cliSupported: true }, {})).toBeUndefined()
    expect(messagesSteerCapability({ jobsEnabled: true, cliSupported: null }, { COS_MESSAGES_STEER: '1' })).toBeUndefined()
    expect(messagesSteerCapability({ jobsEnabled: true, cliSupported: false }, { COS_MESSAGES_STEER: '1' })).toBeUndefined()
    expect(messagesSteerCapability({ jobsEnabled: false, cliSupported: true }, { COS_MESSAGES_STEER: '1' })).toBeUndefined()
    expect(CONTRACT.capability_off.durableQueryJobs).not.toHaveProperty('steer')
  })
})
