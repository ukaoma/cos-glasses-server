// The Messages trail in the durable journal (6.52.0), against real partition files.

import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { QueryJobStore } from './query-job-store.js'
import type { QueryJobEventType } from './query-job-types.js'

/** The hydration allowlist exactly as 6.51.0 shipped it (query-job-store.ts at b58af26):
 * no `trail`. A store built with it reads a journal the way a rolled-back server does. */
const ALLOWLIST_6_51_0: QueryJobEventType[] = [
  'accepted', 'starting', 'running', 'answer_ready', 'completed', 'failed', 'canceled', 'interrupted',
  'chunk', 'tool_status', 'activity_line', 'acknowledged',
]

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cos-query-trail-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function request(activityToolMode = 'preview'): Record<string, unknown> {
  return {
    clientJobId: randomUUID(),
    generation: 1,
    query: 'durable prompt',
    sessionId: 'session-trail-1',
    activityToolMode,
  }
}

async function runningJob(store: QueryJobStore, mode = 'preview'): Promise<string> {
  const admitted = await store.admit(request(mode))
  await store.markStarting(admitted.job.jobId)
  await store.markRunning(admitted.job.jobId, { provider: 'claude', resolvedModel: 'opus' })
  return admitted.job.jobId
}

async function journalLines(root: string): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = []
  for (const name of (await readdir(root)).filter(file => file.endsWith('.jsonl')).sort()) {
    for (const line of (await readFile(join(root, name), 'utf8')).split('\n')) {
      if (line.trim()) out.push(JSON.parse(line))
    }
  }
  return out
}

describe('trail rows in the durable journal', () => {
  it('numbers the trail densely however it interleaves with chunks and activity; eventSeq stays the shared job cursor', async () => {
    const store = new QueryJobStore({ root: await tempRoot(), bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    await store.appendPartial(jobId, 'I will ', 'I will ')
    await store.appendTrail(jobId, { kind: 'prose', text: 'I will check the config.' })
    await store.appendActivity(jobId, 'status', 'Using Read...')
    await store.appendTrail(jobId, { kind: 'tool', verb: 'read', target: 'config.json', detail: '', call: 'toolu_01Read' })
    await store.appendActivity(jobId, 'input', 'File: config.json')
    await store.appendPartial(jobId, 'check.', 'I will check.')
    await store.appendActivity(jobId, 'output', '{"port": 3141}')
    await store.appendTrail(jobId, { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '12 lines', call: 'toolu_01Read' } })
    await store.appendPartial(jobId, ' Done', 'I will check. Done')
    await store.appendTrail(jobId, { kind: 'prose', text: 'Port 3141.' })

    const replay = await store.replay(jobId, 1, 0)
    const trail = replay.events.filter(event => event.type === 'trail')
    expect(trail.map(event => event.data.trailSeq)).toEqual([1, 2, 3, 4])
    // The job cursor is NOT dense across trail rows: a reducer fed eventSeq would paint gaps.
    const eventSeqs = trail.map(event => event.eventSeq)
    expect(eventSeqs.some((seq, index) => index > 0 && seq !== eventSeqs[index - 1] + 1)).toBe(true)
    expect(replay.snapshot.trail?.map(entry => entry.trailSeq)).toEqual([1, 2, 3, 4])
    expect(replay.snapshot.trail?.map(entry => entry.eventSeq)).toEqual(eventSeqs)
    expect(replay.snapshot.trail?.[1]).toMatchObject({ kind: 'tool', verb: 'read', target: 'config.json', call: 'toolu_01Read' })
    expect(trail[0].data).toEqual({ kind: 'prose', text: 'I will check the config.', trailSeq: 1 })
  })

  it('keeps snapshot.trail across a restart with malformedRows 0, and the next row continues the count', async () => {
    const root = await tempRoot()
    const first = new QueryJobStore({ root, bootId: 'boot-a' })
    await first.init()
    const jobId = await runningJob(first)
    await first.appendTrail(jobId, { kind: 'prose', text: 'step one' })
    await first.appendTrail(jobId, { kind: 'tool', verb: 'bash', target: 'npm test', detail: '' })
    await first.markAnswerReady(jobId, 'answer')
    // answer_ready is not terminal: a late trail row still lands, numbered 3.
    await first.appendTrail(jobId, { kind: 'status', state: 'working', detail: 'tests passed; awaiting next instruction' })
    const before = await first.getSnapshot(jobId)

    const second = new QueryJobStore({ root, bootId: 'boot-b' })
    const health = await second.init()
    expect(health.malformedRows).toBe(0)
    const after = await second.getSnapshot(jobId)
    // The restart commits the durable answer; the trail it rebuilt is the same trail.
    expect(after.status).toBe('completed')
    expect(after.trail).toEqual(before.trail)
    expect(after.trail?.map(entry => entry.trailSeq)).toEqual([1, 2, 3])
  })

  it('an old parser (the 6.51.0 allowlist) skips trail rows as malformed and still loads every job whole', async () => {
    const root = await tempRoot()
    const writer = new QueryJobStore({ root, bootId: 'boot-a' })
    await writer.init()
    const jobId = await runningJob(writer)
    await writer.appendTrail(jobId, { kind: 'prose', text: 'looking' })
    await writer.appendPartial(jobId, 'The answer', 'The answer')
    await writer.appendActivity(jobId, 'status', 'Using Bash...')
    await writer.appendTrail(jobId, { kind: 'tool', verb: 'bash', target: 'ls', detail: '' })
    await writer.appendTrail(jobId, { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '3 lines' } })
    await writer.markAnswerReady(jobId, 'The answer')
    await writer.complete(jobId, { text: 'The answer', provider: 'claude', resolvedModel: 'opus' })
    const plainJob = (await writer.admit(request())).job.jobId
    const current = await writer.getSnapshot(jobId)

    const old = new QueryJobStore({ root, bootId: 'boot-b', journalEventTypes: ALLOWLIST_6_51_0 })
    const health = await old.init()
    expect(health.malformedRows).toBe(3)
    expect(health.hydratedJobs).toBe(2)
    const rolledBack = await old.getSnapshot(jobId)
    expect(rolledBack).not.toHaveProperty('trail')
    const { trail: _trail, ...withoutTrail } = current
    expect(rolledBack).toEqual(withoutTrail)
    expect(rolledBack.response).toBe('The answer')
    expect((await old.getSnapshot(plainJob)).status).toBe('interrupted')
  })

  it('rollback mid-run then roll forward: the job still ends terminal and the trail survives', async () => {
    const root = await tempRoot()
    const writer = new QueryJobStore({ root, bootId: 'boot-a' })
    await writer.init()
    const jobId = await runningJob(writer)
    await writer.appendTrail(jobId, { kind: 'prose', text: 'working on it' })
    await writer.appendTrail(jobId, { kind: 'tool', verb: 'read', target: 'a.ts', detail: '' })
    // The server dies here, mid-run, with trail rows as the journal's newest records.

    const rolledBack = new QueryJobStore({ root, bootId: 'boot-b', journalEventTypes: ALLOWLIST_6_51_0 })
    await rolledBack.init()
    expect((await rolledBack.getSnapshot(jobId)).status).toBe('interrupted')

    // The rolled-back boot numbered its interrupt after the last row IT could read, so it
    // reuses a trail row's eventSeq; this build skips that duplicate and interrupts again.
    const forward = new QueryJobStore({ root, bootId: 'boot-c' })
    const health = await forward.init()
    expect(health.malformedRows).toBe(0)
    const snapshot = await forward.getSnapshot(jobId)
    expect(snapshot.status).toBe('interrupted')
    expect(snapshot.trail?.map(entry => entry.kind)).toEqual(['prose', 'tool'])
    const types = (await journalLines(root)).filter(line => line.jobId === jobId).map(line => `${line.eventSeq}:${line.type}`)
    expect(types).toEqual(['1:accepted', '2:starting', '3:running', '4:trail', '5:trail', '4:interrupted', '6:interrupted'])
  })

  it('a job with no trail rows keeps the exact 6.51.0 snapshot and journal shape', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    await store.appendPartial(jobId, 'hi', 'hi')
    await store.appendActivity(jobId, 'status', 'Using Read...')
    await store.markAnswerReady(jobId, 'hi')
    await store.complete(jobId, { text: 'hi' })
    const snapshot = await store.getSnapshot(jobId)
    expect(snapshot).not.toHaveProperty('trail')
    expect(Object.keys(snapshot).sort()).toEqual([
      'acceptedAt', 'activity', 'answerReadyAt', 'attachments', 'clientJobId', 'completedAt', 'eventSeq',
      'generation', 'jobId', 'oldestEventSeq', 'partialText', 'partialTruncated', 'provider', 'requestFingerprint',
      'resolvedModel', 'response', 'responseTruncated', 'retentionUntil', 'schemaVersion', 'sessionId', 'startedAt',
      'status', 'turnId', 'updatedAt',
    ])
    const lines = await journalLines(root)
    expect(lines.map(line => line.type)).toEqual(['accepted', 'starting', 'running', 'chunk', 'tool_status', 'answer_ready', 'completed'])
    for (const line of lines) expect(line.schemaVersion).toBe(1)
  })

  it('redacts at the journal boundary: the partition bytes never hold the secret or the local path', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    await store.appendTrail(jobId, {
      kind: 'prose',
      text: 'I will call it with Authorization: Bearer abcdefghijklmnop0123456789\nand read /Users/someone/private/notes.md next.',
    })
    await store.appendTrail(jobId, { kind: 'tool', verb: 'bash', target: 'export API_KEY=sk-live-0123456789abcdefghij && ./deploy', detail: '' })
    const bytes = (await Promise.all((await readdir(root)).map(name => readFile(join(root, name), 'utf8')))).join('\n')
    for (const secret of ['abcdefghijklmnop0123456789', '/Users/someone', 'sk-live-0123456789abcdefghij']) {
      expect(bytes).not.toContain(secret)
    }
    const trail = (await store.getSnapshot(jobId)).trail!
    expect(trail[0]).toMatchObject({ kind: 'prose', text: expect.stringContaining('I will call it with') })
    expect((trail[0] as { text: string }).text).toContain('\n')
  })

  it('bounds snapshot.trail by entries and by characters, oldest first, the newest always kept', async () => {
    const store = new QueryJobStore({ root: await tempRoot(), bootId: 'boot-a', maxTrailEntries: 3, maxTrailChars: 25 })
    await store.init()
    const jobId = await runningJob(store)
    for (const text of ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']) await store.appendTrail(jobId, { kind: 'prose', text })
    expect((await store.getSnapshot(jobId)).trail?.map(entry => entry.trailSeq)).toEqual([3, 4, 5])
    await store.appendTrail(jobId, { kind: 'prose', text: 'x'.repeat(22) })
    expect((await store.getSnapshot(jobId)).trail?.map(entry => entry.trailSeq)).toEqual([6])
    // The replay ring still holds every row; only the snapshot page is bounded.
    const replay = await store.replay(jobId, 1, 0)
    expect(replay.events.filter(event => event.type === 'trail')).toHaveLength(6)
  })

  it('writes nothing, and never throws, for an empty draft or a job that is already terminal', async () => {
    const store = new QueryJobStore({ root: await tempRoot(), bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    const empty = await store.appendTrail(jobId, { kind: 'prose', text: '   ' })
    expect(empty.applied).toBe(false)
    const prompt = await store.appendTrail(jobId, { kind: 'prompt', text: 'the words a person typed' })
    expect(prompt.applied).toBe(false)
    await store.complete(jobId, { text: 'done' })
    const late = await store.appendTrail(jobId, { kind: 'prose', text: 'too late' })
    expect(late.applied).toBe(false)
    const snapshot = await store.getSnapshot(jobId)
    expect(snapshot).not.toHaveProperty('trail')
  })

  it('counts a trail row whose data is not a trail entry as malformed on hydration', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    await store.appendTrail(jobId, { kind: 'prose', text: 'fine' })
    await store.complete(jobId, { text: 'ok' })
    const lines = await journalLines(root)
    const good = lines.find(line => line.type === 'trail')!
    const partition = (await readdir(root)).find(name => name.endsWith('.jsonl'))!
    await appendFile(join(root, partition), `${JSON.stringify({ ...good, recordId: randomUUID(), eventSeq: 99, eventData: { trailSeq: 2, kind: 'prompt', text: 'x' } })}\n`)
    const reader = new QueryJobStore({ root, bootId: 'boot-b' })
    const health = await reader.init()
    expect(health.malformedRows).toBe(1)
    expect((await reader.getSnapshot(jobId)).trail?.map(entry => entry.trailSeq)).toEqual([1])
  })
})
