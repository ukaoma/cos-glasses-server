// 6.82.0: the morning brief golden. Recorded on the unmodified 6.81.0 base (6b2e70b) BEFORE the
// routine registry existed, then asserted unchanged after it. The registry makes the brief
// routine #1; this file is the proof that its settings, its prompt, what a scheduled fire
// submits, and the /api/morning-brief envelope did not move.
//
// Re-record only on a deliberate brief change: COS_UPDATE_GOLDEN=1 npx vitest run <this file>.

import express from 'express'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultMorningBriefConfig, morningBriefPaths } from './morning-brief-config.js'
import { MorningBriefScheduler, type MorningBriefSchedulerDeps } from './morning-brief-scheduler.js'
import type { QueryJobSnapshot } from './query-job-types.js'
import { createMorningBriefRouter } from '../routes/morning-brief.js'

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'morning-brief-golden.json')
const CHICAGO = 'America/Chicago'
const SLOT = Date.UTC(2026, 8, 1, 12, 0) // Tue 2026-09-01 07:00 CDT
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'cos-brief-golden-'))
  roots.push(root)
  const submissions: Array<Record<string, unknown>> = []
  const jobs = new Map<string, QueryJobSnapshot>()
  let now = SLOT
  let n = 0
  const deps: MorningBriefSchedulerDeps = {
    paths: morningBriefPaths(root),
    submit: async request => {
      submissions.push(request)
      const job = {
        schemaVersion: 1, jobId: `job-${++n}`, clientJobId: String(request.clientJobId), generation: 1, turnId: randomUUID(),
        requestFingerprint: 'fp', status: 'running', eventSeq: 1, oldestEventSeq: 1, sessionId: String(request.sessionId),
        attachments: [], partialText: '', partialTruncated: false, activity: [],
        acceptedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), retentionUntil: new Date(now + 86_400_000).toISOString(),
      } as unknown as QueryJobSnapshot
      jobs.set(job.jobId, job)
      return { job, created: true }
    },
    findByClientGeneration: async clientJobId => [...jobs.values()].find(job => job.clientJobId === clientJobId),
    getSnapshot: async jobId => { const job = jobs.get(jobId); if (!job) throw new Error('missing'); return job },
    createSession: () => `session-${submissions.length + 1}`,
    currentMessageEra: () => 'era-golden',
    currentMessageMax: () => 41,
    ownerName: () => 'Jun',
    durableJobsEnabled: () => true,
    admissionsOpen: () => true,
    now: () => now,
    log: () => undefined,
  }
  const scheduler = new MorningBriefScheduler(deps)
  scheduler.updateConfig({ timezone: CHICAGO })
  return { scheduler, submissions, jobs, setNow: (ms: number) => { now = ms } }
}

/** Everything a brief surface shows or sends, with ids and wall times blanked. */
async function capture() {
  const config = defaultMorningBriefConfig(new Date(SLOT))
  const { timezone: _tz, updatedAt: _at, ...defaults } = config
  const h = harness()
  const preview = h.scheduler.previewPrompt('scheduled')
  const status = await h.scheduler.status()
  const tick = await h.scheduler.tick()
  const submission = { ...h.submissions[0], sessionId: '<session>' }
  const app = express()
  app.use(express.json())
  app.use('/api', createMorningBriefRouter(() => h.scheduler))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  try {
    const port = (server.address() as AddressInfo).port
    const body = await (await fetch(`http://127.0.0.1:${port}/api/morning-brief`)).json() as Record<string, unknown>
    const put = await fetch(`http://127.0.0.1:${port}/api/morning-brief`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ time: '25:00' }) })
    const putBody = await put.json()
    const run = await fetch(`http://127.0.0.1:${port}/api/morning-brief/run`, { method: 'POST' })
    const runBody = await run.json() as { run?: Record<string, unknown> }
    return {
      defaults,
      preview,
      status: { ...status, serverTimezone: '<server>' },
      tickFired: tick.fired,
      submission,
      envelopeKeys: Object.keys(body).sort(),
      configKeys: Object.keys(body.config as object).sort(),
      statusKeys: Object.keys(body.status as object).sort(),
      sources: (body.sources as Array<{ id: string; label: string; defaultEnabled: boolean; options: object }>).map(s => ({ id: s.id, label: s.label, defaultEnabled: s.defaultEnabled, options: Object.keys(s.options) })),
      badPut: { status: put.status, body: putBody },
      runNow: { status: run.status, keys: Object.keys(runBody.run ?? {}).sort(), trigger: runBody.run?.trigger, attempt: runBody.run?.attempt },
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

describe('morning brief golden (recorded on 6.81.0)', () => {
  it('settings, prompt, scheduled submission and the /api/morning-brief envelope are unchanged', async () => {
    const actual = JSON.parse(JSON.stringify(await capture()))
    if (process.env.COS_UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    expect(actual).toEqual(golden)
  })
})
