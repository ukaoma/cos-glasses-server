// 6.78.0 G-off for the query-job HTTP surface: with Messages steer off, and for any client that
// does not ask for steers, every response body and every SSE byte is the 6.77.0 one. The
// golden file was recorded by running THIS file, unchanged, inside a `git archive` of 6.77.0
// (aa87c9d) with COS_ROUTE_GOLDEN_OUT set; it imports only what 6.77.0 already had.
import express from 'express'
import type { Server } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/conversation.js', () => ({ getOrCreateSession: () => 'identity-http-session' }))

import { QueryJobCoordinator, type QueryJobRunner } from '../lib/query-job-coordinator.js'
import { QueryJobStore } from '../lib/query-job-store.js'
import { createQueryJobsRouter } from './query-jobs.js'

const GOLDEN = join(import.meta.dirname, '../lib/__fixtures__/pi-durable/query-jobs-routes-off-6.77.0.json')
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g
const CLIENT = ['0e5a9c1d-2222-4222-8222-000000000001', '0e5a9c1d-2222-4222-8222-000000000002']

function normalizer(): (text: string) => string {
  const seen = new Map<string, string>()
  return text => text
    .replace(UUID_RE, id => CLIENT.includes(id) ? id : (seen.get(id) ?? (seen.set(id, `<id:${seen.size + 1}>`), seen.get(id)!)))
    .replace(TIME_RE, '<time>')
}

async function scenario(routerOptions: Record<string, unknown>): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), 'cos-routes-identity-'))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const runner: QueryJobRunner = async ctx => {
    await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude', resolvedModel: 'opus' })
    await ctx.callbacks.onProviderProcess({ provider: 'claude', claudeRunId: 'identity-run' })
    ctx.callbacks.onToolStatus('Using Read...')
    ctx.callbacks.onTrail({ kind: 'tool', verb: 'read', target: 'README.md', detail: '', call: 'toolu_identity_1' })
    ctx.callbacks.onChunk('Part one. ')
    if (ctx.request.clientJobId === CLIENT[0]) {
      await held
      ctx.callbacks.onChunk('Part two.')
      await ctx.callbacks.onAnswerReady('Part one. Part two.')
      await ctx.callbacks.onDone({ text: 'Part one. Part two.' })
    } else {
      await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
    }
  }
  const coordinator = new QueryJobCoordinator(new QueryJobStore({ root, bootId: 'boot-identity' }), runner, { resolveSessionId: () => 'identity-http-session', partialFlushMs: 0 })
  await coordinator.init()
  const app = express(); app.use(express.json())
  app.use('/api', createQueryJobsRouter(coordinator, { enabled: () => true, heartbeatMs: 60_000, ...routerOptions }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const out: Record<string, string> = {}
  const call = async (name: string, path: string, init?: RequestInit) => {
    const res = await fetch(`${base}/api${path}`, init)
    out[name] = `${res.status} ${await res.text()}`
    return out[name]!
  }
  try {
    const admit = (clientJobId: string) => call(`admit:${clientJobId.slice(-1)}`, '/query-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientJobId, generation: 1, query: 'read the README', activityToolMode: 'preview' }),
    })
    const first = JSON.parse((await admit(CLIENT[0]!)).slice(4)).job.jobId as string
    await new Promise(resolve => setTimeout(resolve, 80))
    // A live stream that sees the end, for a plain client and a trail client.
    const stream = (name: string, query: string) => fetch(`${base}/api/query-jobs/${first}/events?generation=1&after=0${query}`)
      .then(async res => { out[name] = `${res.status} ${await res.text()}` })
    const plain = stream('sse:plain', '')
    const trail = stream('sse:trail', '&trail=1&trailAfter=0')
    await new Promise(resolve => setTimeout(resolve, 80))
    release()
    await Promise.all([plain, trail])
    await call('get', `/query-jobs/${first}?generation=1`)
    await call('get:trail', `/query-jobs/${first}?generation=1&trail=1`)
    await call('by-client', `/query-jobs/by-client/${CLIENT[0]}?generation=1`)
    await call('sse:replay', `/query-jobs/${first}/events?generation=1&after=2`)
    await call('ack', `/query-jobs/${first}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: 1 }) })
    const second = JSON.parse((await admit(CLIENT[1]!)).slice(4)).job.jobId as string
    await new Promise(resolve => setTimeout(resolve, 80))
    await call('cancel', `/query-jobs/${second}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: 1 }) })
    await call('missing', `/query-jobs/by-client/0e5a9c1d-2222-4222-8222-00000000000f?generation=1`)
  } finally {
    await coordinator.shutdown('test_shutdown')
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
  const norm = normalizer()
  return Object.fromEntries(Object.entries(out).map(([key, value]) => [key, norm(value)]))
}

describe('the query-job routes with steer off, or a client that does not ask (G-off)', () => {
  it('every body and SSE byte equals the 6.77.0 recording', async () => {
    const recorded = await scenario({})
    if (process.env.COS_ROUTE_GOLDEN_OUT) {
      writeFileSync(process.env.COS_ROUTE_GOLDEN_OUT, `${JSON.stringify({ _source: process.env.COS_ROUTE_GOLDEN_SOURCE ?? 'unknown', responses: recorded }, null, 2)}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    expect(golden._source).toBe('6.77.0 aa87c9d')
    expect(Object.keys(recorded)).toEqual(Object.keys(golden.responses))
    for (const key of Object.keys(golden.responses)) expect(recorded[key], key).toBe(golden.responses[key])
    // The same with the steer switch ON: a client that does not ask sees nothing new.
    const switchedOn = await scenario({ steerEnabled: () => true })
    for (const key of Object.keys(golden.responses)) expect(switchedOn[key], `steer on: ${key}`).toBe(golden.responses[key])
  })
})
