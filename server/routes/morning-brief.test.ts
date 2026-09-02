import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { morningBriefPaths } from '../lib/morning-brief-config.js'
import { MorningBriefScheduler } from '../lib/morning-brief-scheduler.js'
import type { QueryJobSnapshot } from '../lib/query-job-types.js'
import { createMorningBriefRouter } from './morning-brief.js'
import { MorningBriefCoverageService } from '../lib/morning-brief-coverage.js'

let root = ''
let server: Server
let base = ''
let scheduler: MorningBriefScheduler
const jobs = new Map<string, QueryJobSnapshot>()
let now = Date.UTC(2026, 8, 1, 11, 0) // Tue 06:00 CDT

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cos-morning-brief-route-'))
  scheduler = new MorningBriefScheduler({
    paths: morningBriefPaths(root),
    submit: async (request) => {
      const job: QueryJobSnapshot = {
        schemaVersion: 1,
        jobId: randomUUID(),
        clientJobId: String(request.clientJobId),
        generation: 1,
        turnId: randomUUID(),
        requestFingerprint: 'fp',
        status: 'running',
        eventSeq: 1,
        oldestEventSeq: 1,
        sessionId: String(request.sessionId),
        messageEra: 'era-test',
        globalMsgNum: Number(request.globalMsgNum),
        attachments: [],
        partialText: '',
        partialTruncated: false,
        activity: [],
        acceptedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        retentionUntil: new Date(now + 7 * 86_400_000).toISOString(),
      }
      jobs.set(job.jobId, job)
      return { job, created: true }
    },
    findByClientGeneration: async () => undefined,
    getSnapshot: async (jobId) => {
      const job = jobs.get(jobId)
      if (!job) throw new Error('missing')
      return job
    },
    createSession: () => 'route-session',
    currentMessageEra: () => 'era-test',
    currentMessageMax: () => 7,
    ownerName: () => 'Jun',
    durableJobsEnabled: () => true,
    admissionsOpen: () => true,
    coverage: new MorningBriefCoverageService({
      meetings: () => ({ count: 2312, newestMonth: '2026-09', layout: 'multi_domain' }),
      skill: name => ({ found: name.replace(/^\//, '') === 'good-morning', where: '.claude/skills' }),
    }, { now: () => now }),
    now: () => now,
    log: () => {},
  })
  scheduler.updateConfig({ timezone: 'America/Chicago' })
  const app = express()
  app.use(express.json())
  app.use('/api', createMorningBriefRouter(() => scheduler))
  server = await new Promise<Server>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  scheduler.stop()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

describe('GET /api/morning-brief', () => {
  it('returns the config, the catalog, the status, and recent runs', async () => {
    const response = await fetch(`${base}/api/morning-brief`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.config).toMatchObject({ enabled: true, time: '07:00', timezone: 'America/Chicago' })
    expect(body.sources.map((source: { id: string }) => source.id)).toContain('skill')
    expect(body.sources[0]).toHaveProperty('description')
    expect(body.status).toMatchObject({ protocolVersion: 1, gate: 'ready', nextRunAt: '2026-09-01T12:00:00.000Z' })
    expect(body.runs).toEqual([])
  })
})

describe('PUT /api/morning-brief', () => {
  it('applies a valid patch and echoes the new state', async () => {
    const response = await fetch(`${base}/api/morning-brief`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ time: '06:30', sources: [{ id: 'skill', enabled: true, options: { name: '/good-morning' } }] }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.config.time).toBe('06:30')
    expect(body.config.sources[0]).toMatchObject({ id: 'skill', enabled: true, options: { name: '/good-morning' } })
    expect(body.status.nextRunAt).toBe('2026-09-01T11:30:00.000Z')
  })

  it('rejects a bad field with 400 and a named code, leaving the config untouched', async () => {
    const response = await fetch(`${base}/api/morning-brief`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ time: 'seven' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_time' } })
    const after = await (await fetch(`${base}/api/morning-brief`)).json() as any
    expect(after.config.time).toBe('06:30')
  })
})

describe('GET /api/morning-brief/preview', () => {
  it('serves the exact prompt as plain text', async () => {
    const response = await fetch(`${base}/api/morning-brief/preview`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    const text = await response.text()
    expect(text).toContain('Morning brief for Jun.')
    expect(text).toContain('SKILL /good-morning')
  })
})

describe('POST /api/morning-brief/run', () => {
  it('admits a brief now with 202, then refuses a second while it runs', async () => {
    const first = await fetch(`${base}/api/morning-brief/run`, { method: 'POST' })
    expect(first.status).toBe(202)
    const body = await first.json() as any
    expect(body.run).toMatchObject({ trigger: 'manual', globalMsgNum: 8, sessionId: 'route-session' })
    expect(body.run.jobId).toBeTruthy()

    const second = await fetch(`${base}/api/morning-brief/run`, { method: 'POST' })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ error: { code: 'brief_in_progress' } })

    const runs = await (await fetch(`${base}/api/morning-brief/runs?limit=5`)).json() as any
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0]).toMatchObject({ status: 'running', globalMsgNum: 8 })

    // Nothing on this surface carries the prompt text.
    const everything = JSON.stringify(await (await fetch(`${base}/api/morning-brief`)).json())
    expect(everything).not.toContain('Morning brief for Jun')
  })
})

describe('coverage (6.43.1)', () => {
  it('GET /morning-brief carries per-source coverage, and PUT reflects a renamed skill without re-probing', async () => {
    const before = await fetch(`${base}/api/morning-brief`).then(r => r.json()) as any
    expect(before.coverage.ttlMs).toBeGreaterThan(0)
    const meetings = before.coverage.sources.find((s: any) => s.id === 'meetings')
    expect(meetings).toMatchObject({ state: 'ready', summary: '2,312 meetings stored, newest Sep 2026.' })
    expect(before.coverage.sources.map((s: any) => s.id)).toEqual(before.config.sources.map((s: any) => s.id))

    const put = await fetch(`${base}/api/morning-brief`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: [{ id: 'skill', enabled: true, options: { name: '/good-morning' } }] }),
    })
    expect(put.status).toBe(200)
    const after = await put.json() as any
    expect(after.coverage.sources.find((s: any) => s.id === 'skill')).toMatchObject({ state: 'ready', summary: '/good-morning found under .claude/skills.' })
    for (const row of after.coverage.sources) expect(JSON.stringify(row)).not.toMatch(/\/Users|tmp/)
  })

  it('GET /morning-brief/coverage answers on its own and honours refresh=1', async () => {
    const res = await fetch(`${base}/api/morning-brief/coverage?refresh=1`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.coverage.sources.length).toBeGreaterThan(0)
  })
})
