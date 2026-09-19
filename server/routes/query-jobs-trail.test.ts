// 6.52.0 QA round 1: the Messages trail rides its own cursor, OFF the job event stream.
//
// An old client (glasses 6.9.511, Control 0.5.238/0.5.239) must receive EXACTLY the 6.51.0
// event stream: the same events, the same `id:` cursor sequence, the same replay_gap
// behaviour past the 256-event ring, and snapshots without `trail`. A client that asks
// (`?trail=1`) gets `trail` frames numbered by a dense `trailSeq` and a correct rebuild
// after a gap. Real express server, real SSE bytes, the real store with an in-memory
// journal and a fixed clock so two runs can be compared byte for byte.

import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { QueryJobStore, type QueryJobJournalStorage } from '../lib/query-job-store.js'
import type { QueryJobCoordinator } from '../lib/query-job-coordinator.js'
import { QUERY_JOB_LIMITS } from '../lib/query-job-types.js'
import { createQueryJobsRouter } from './query-jobs.js'

const CLIENT_JOB_ID = '6a1f3c2e-8b4d-4e5f-9a7b-1c2d3e4f5a6b'
const FIXED = new Date('2026-09-19T12:00:00.000Z')

class MemoryJournal implements QueryJobJournalStorage {
  private readonly files = new Map<string, string>()
  async prepare(): Promise<void> {}
  async listPartitions(): Promise<string[]> { return [...this.files.keys()].sort() }
  async readPartition(_root: string, partition: string): Promise<string> {
    const text = this.files.get(partition)
    if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return text
  }
  async removePartition(_root: string, partition: string): Promise<void> { this.files.delete(partition) }
  async append(_root: string, day: string, line: string): Promise<void> {
    const name = `${day}.jsonl`
    this.files.set(name, `${this.files.get(name) ?? ''}${line}\n`)
  }
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
})

async function harness() {
  const store = new QueryJobStore({ root: '/nonexistent/memory', bootId: 'boot-fixed', storage: new MemoryJournal(), now: () => FIXED })
  await store.init()
  // The router needs only these three from the coordinator.
  const coordinator = {
    subscribe: (...args: Parameters<QueryJobStore['subscribe']>) => store.subscribe(...args),
    getSnapshot: (jobId: string, generation?: number) => store.getSnapshot(jobId, generation),
    getByClientGeneration: (clientJobId: string, generation: number) => store.findByClientGeneration(clientJobId, generation),
  } as unknown as QueryJobCoordinator
  const app = express()
  app.use('/api', createQueryJobsRouter(coordinator, { enabled: () => true, heartbeatMs: 60_000 }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  return { store, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

/**
 * 300 job events (accepted, starting, running, 295 chunks and activity lines, answer_ready,
 * completed). With the trail on, a trail row follows every job event from `running` on,
 * which is more rows than `snapshot.trail` holds.
 */
async function produce(store: QueryJobStore, jobId: string, withTrail: boolean): Promise<number> {
  let trailRows = 0
  const trail = async (i: number) => {
    if (!withTrail) return
    trailRows++
    await store.appendTrail(jobId, i % 3 === 0
      ? { kind: 'tool', verb: 'bash', target: `npm test ${i}`, detail: '' }
      : i % 3 === 1 ? { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: `${i} lines` } } : { kind: 'prose', text: `Step ${i} done.` })
  }
  await store.markStarting(jobId)
  await store.markRunning(jobId, { provider: 'claude', resolvedModel: 'opus' })
  await trail(0)
  let text = ''
  for (let i = 1; i <= 295; i++) {
    if (i % 2 === 0) {
      text += `w${i} `
      await store.appendPartial(jobId, `w${i} `, text)
    } else {
      await store.appendActivity(jobId, 'status', `Using Bash ${i}...`)
    }
    await trail(i)
  }
  await store.markAnswerReady(jobId, text)
  await store.complete(jobId, { text, provider: 'claude', resolvedModel: 'opus' })
  return trailRows
}

async function sse(base: string, jobId: string, query: string): Promise<string> {
  const res = await fetch(`${base}/api/query-jobs/${jobId}/events?generation=1&${query}`)
  expect(res.status).toBe(200)
  return res.text()
}

/** One whole run, seen by the clients an old app is: live from the start, after a gap, and a
 * reconnect inside the ring; plus the JSON snapshot. Ids are the only thing normalized. */
async function oldClientView(withTrail: boolean) {
  const { store, base } = await harness()
  const admitted = await store.admit({ clientJobId: CLIENT_JOB_ID, generation: 1, query: 'q', sessionId: 'session-trail', activityToolMode: 'preview' })
  const jobId = admitted.job.jobId
  // Live: subscribed (headers back) before the first event after `accepted`.
  const live = await fetch(`${base}/api/query-jobs/${jobId}/events?generation=1&after=0`)
  const liveText = live.text()
  const trailRows = await produce(store, jobId, withTrail)
  const views = {
    live: await liveText,
    afterGap: await sse(base, jobId, 'after=0'),
    reconnect: await sse(base, jobId, 'after=150'),
    json: await (await fetch(`${base}/api/query-jobs/${jobId}?generation=1`)).text(),
    byClient: await (await fetch(`${base}/api/query-jobs/by-client/${CLIENT_JOB_ID}?generation=1`)).text(),
  }
  const turnId = admitted.job.turnId
  const norm = (text: string) => text.split(jobId).join('<job>').split(turnId).join('<turn>')
  return { store, base, jobId, trailRows, views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, norm(v)])) as typeof views }
}

describe('an old client sees exactly the 6.51.0 stream with the trail on', () => {
  it('byte-identical events, cursors, replay_gap past 256 and snapshots, trail on vs off', async () => {
    const off = await oldClientView(false)
    const on = await oldClientView(true)
    expect(on.trailRows).toBeGreaterThan(QUERY_JOB_LIMITS.trailEntries)
    expect((await on.store.getSnapshot(on.jobId)).trail?.length).toBe(QUERY_JOB_LIMITS.trailEntries)
    for (const view of ['live', 'afterGap', 'reconnect', 'json', 'byClient'] as const) {
      expect(on.views[view], view).toBe(off.views[view])
    }
    // What those bytes are: 300 events live with ids 1..300; past the 256 ring a snapshot
    // (buffer_overflow) whose job has no `trail`; a reconnect inside the ring replays.
    const ids = [...on.views.live.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]))
    expect(ids).toEqual(Array.from({ length: 300 }, (_v, i) => i + 1))
    expect(on.views.live).not.toContain('event: trail')
    expect(on.views.afterGap).toContain('event: snapshot')
    expect(on.views.afterGap).toContain('"reason":"buffer_overflow"')
    expect(on.views.afterGap).not.toContain('"trail"')
    expect([...on.views.reconnect.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]))).toEqual(Array.from({ length: 150 }, (_v, i) => i + 151))
    expect(on.views.json).not.toContain('"trail"')
    expect(on.views.byClient).not.toContain('"trail"')
  }, 30_000)
})

interface TrailFrame { trailSeq: number; data: Record<string, unknown> }

function framesOf(text: string, type: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n')
    if (!lines.includes(`event: ${type}`)) continue
    const data = lines.find(line => line.startsWith('data: '))
    if (data) out.push(JSON.parse(data.slice(6)))
  }
  return out
}

describe('a client that opts in (?trail=1)', () => {
  it('gets dense trail frames beside the same job events, and a correct rebuild after a gap', async () => {
    const { store, base } = await harness()
    const admitted = await store.admit({ clientJobId: CLIENT_JOB_ID, generation: 1, query: 'q', sessionId: 'session-trail', activityToolMode: 'preview' })
    const jobId = admitted.job.jobId
    const oldClient = await fetch(`${base}/api/query-jobs/${jobId}/events?generation=1&after=0`)
    const opted = await fetch(`${base}/api/query-jobs/${jobId}/events?generation=1&after=0&trail=1&trailAfter=0`)
    const [oldText, optedText] = [oldClient.text(), opted.text()]
    const rows = await produce(store, jobId, true)
    const live = await optedText
    const frames = framesOf(live, 'trail') as unknown as TrailFrame[]
    // Dense 1..n, every row, no job cursor on a trail frame (no `id:` line either).
    expect(frames.map(f => f.trailSeq)).toEqual(Array.from({ length: rows }, (_v, i) => i + 1))
    for (const block of live.split('\n\n').filter(b => b.includes('event: trail'))) expect(block).not.toMatch(/^id: /m)
    expect(frames[0]).not.toHaveProperty('eventSeq')
    // Take the trail frames out and the rest is the old client's stream, byte for byte.
    const withoutTrail = live.split('\n\n').filter(b => !b.includes('event: trail')).join('\n\n')
    expect(withoutTrail).toBe(await oldText)

    // Reconnect far behind: one trail_snapshot holding exactly the newest held entries.
    const behind = await sse(base, jobId, 'after=300&trail=1&trailAfter=5')
    const [snap] = framesOf(behind, 'trail_snapshot')
    expect(snap).toMatchObject({ reason: 'trail_gap', latestTrailSeq: rows, oldestTrailSeq: rows - QUERY_JOB_LIMITS.trailEntries + 1 })
    const rebuilt = (snap!.trail as Array<Record<string, unknown>>).map(({ trailSeq, at: _at, ...data }) => ({ trailSeq, data }))
    expect(rebuilt).toEqual(frames.slice(-QUERY_JOB_LIMITS.trailEntries).map(f => ({ trailSeq: f.trailSeq, data: f.data })))
    expect(framesOf(behind, 'trail')).toEqual([])

    // Reconnect inside the held window: exactly what it missed, in order.
    const near = await sse(base, jobId, `after=300&trail=1&trailAfter=${rows - 10}`)
    expect(framesOf(near, 'trail').map(f => f.trailSeq)).toEqual(Array.from({ length: 10 }, (_v, i) => rows - 9 + i))
    expect(framesOf(near, 'trail_snapshot')).toEqual([])

    // Snapshots carry `trail` only for it.
    const json = await (await fetch(`${base}/api/query-jobs/${jobId}?generation=1&trail=1`)).json() as { job: { trail?: unknown[] } }
    expect(json.job.trail).toHaveLength(QUERY_JOB_LIMITS.trailEntries)
    const gapSnapshot = framesOf(await sse(base, jobId, 'after=0&trail=1&trailAfter=0'), 'snapshot')[0]
    expect(gapSnapshot?.data.job.trail).toHaveLength(QUERY_JOB_LIMITS.trailEntries)
  }, 30_000)

  it('a trail frame both replayed and delivered live is written once', async () => {
    const jobId = '0f0e0d0c-0b0a-4908-8706-050403020100'
    const snapshot = { jobId, clientJobId: CLIENT_JOB_ID, generation: 1, status: 'running', eventSeq: 1, updatedAt: FIXED.toISOString() }
    const entry = (trailSeq: number) => ({ kind: 'prose', text: `entry ${trailSeq}`, trailSeq, at: FIXED.toISOString() })
    const fake = {
      subscribe: async (_j: string, _g: number, _a: number, listener: (event: Record<string, unknown>) => void, trail?: { after: number; listener: (frame: Record<string, unknown>) => void }) => {
        // Entry 2 lands between the listener's registration and the replay snapshot.
        trail?.listener({ type: 'trail', trailSeq: 2, jobId, clientJobId: CLIENT_JOB_ID, generation: 1, at: FIXED.toISOString(), data: { kind: 'prose', text: 'entry 2' } })
        listener({ type: 'completed', eventSeq: 2, jobId, clientJobId: CLIENT_JOB_ID, generation: 1, status: 'completed', at: FIXED.toISOString(), data: {} })
        return {
          replay: { events: [], gap: false, oldestEventSeq: 1, latestEventSeq: 1, snapshot },
          trailReplay: { entries: [entry(1), entry(2)], gap: false, oldestTrailSeq: 1, latestTrailSeq: 2 },
          unsubscribe: () => {},
        }
      },
    } as unknown as QueryJobCoordinator
    const app = express()
    app.use('/api', createQueryJobsRouter(fake, { enabled: () => true }))
    const server = await new Promise<Server>(r => { const s2 = app.listen(0, '127.0.0.1', () => r(s2)) })
    servers.push(server)
    const text = await sse(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, jobId, 'after=1&trail=1&trailAfter=0')
    expect(framesOf(text, 'trail').map(f => f.trailSeq)).toEqual([1, 2])
    expect(text).toContain('event: completed')
  })

  it('a bad trailAfter is refused like a bad event cursor', async () => {
    const { store, base } = await harness()
    const admitted = await store.admit({ clientJobId: CLIENT_JOB_ID, generation: 1, query: 'q', sessionId: 'session-trail' })
    const res = await fetch(`${base}/api/query-jobs/${admitted.job.jobId}/events?generation=1&trail=1&trailAfter=-4`)
    expect(res.status).toBe(400)
    // Without trail=1 the parameter is not read at all: the 6.51.0 request.
    const plain = await fetch(`${base}/api/query-jobs/${admitted.job.jobId}/events?generation=1&trailAfter=-4`)
    expect(plain.status).toBe(200)
    await plain.body?.cancel()
  })
})
