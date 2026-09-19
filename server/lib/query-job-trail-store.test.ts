// The Messages trail in the durable journal (6.52.0), against real partition files.

import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { QueryJobStore, type QueryJobTrailFrame } from './query-job-store.js'
import { QUERY_JOB_LIMITS, type QueryJobEventType } from './query-job-types.js'
// The 6.51.0 store itself, byte for byte but for two import paths (see the fixture header).
import { QueryJobStore as QueryJobStore6510 } from './__fixtures__/query-job-store-6.51.0.js'

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
  it('numbers the trail densely however it interleaves with chunks and activity, and never takes a job eventSeq', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
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

    // The job's own events are dense and trail-free: the replay ring holds no trail row.
    const replay = await store.replay(jobId, 1, 0)
    expect(replay.events.map(event => event.type)).not.toContain('trail')
    expect(replay.events.map(event => event.eventSeq)).toEqual(replay.events.map((_e, i) => i + 1))
    expect(replay.snapshot.eventSeq).toBe(9)
    expect(replay.snapshot.trail?.map(entry => entry.trailSeq)).toEqual([1, 2, 3, 4])
    expect(replay.snapshot.trail?.[1]).toMatchObject({ kind: 'tool', verb: 'read', target: 'config.json', call: 'toolu_01Read' })
    expect(replay.snapshot.trail?.[0]).not.toHaveProperty('eventSeq')
    // In the journal each trail row carries the eventSeq of the event it follows.
    const rows = (await journalLines(root)).map(line => `${line.eventSeq}:${line.type}`)
    expect(rows).toEqual(['1:accepted', '2:starting', '3:running', '4:chunk', '4:trail', '5:tool_status', '5:trail', '6:activity_line', '7:chunk', '8:activity_line', '8:trail', '9:chunk', '9:trail'])
    const firstTrail = (await journalLines(root)).find(line => line.type === 'trail')!
    expect(firstTrail.eventData).toEqual({ kind: 'prose', text: 'I will check the config.', trailSeq: 1 })
  })

  it('a job subscriber never sees a trail row; a trail subscriber sees each once, by trailSeq', async () => {
    const store = new QueryJobStore({ root: await tempRoot(), bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    await store.appendTrail(jobId, { kind: 'prose', text: 'before' })
    const events: string[] = []
    const plain = await store.subscribe(jobId, 1, 3, event => { events.push(event.type) })
    const frames: QueryJobTrailFrame[] = []
    const opted = await store.subscribe(jobId, 1, 3, () => {}, { after: 0, listener: frame => { frames.push(frame) } })
    expect(plain.trailReplay).toBeUndefined()
    expect(opted.trailReplay).toMatchObject({ gap: false, oldestTrailSeq: 1, latestTrailSeq: 1 })
    expect(opted.trailReplay?.entries.map(e => e.trailSeq)).toEqual([1])
    await store.appendTrail(jobId, { kind: 'tool', verb: 'bash', target: 'ls', detail: '' })
    await store.appendPartial(jobId, 'x', 'x')
    await store.appendTrail(jobId, { kind: 'prose', text: 'after' })
    expect(events).toEqual(['chunk'])
    expect(frames.map(f => [f.type, f.trailSeq, f.data.kind])).toEqual([['trail', 2, 'tool'], ['trail', 3, 'prose']])
    expect(frames[0]).not.toHaveProperty('eventSeq')
    plain.unsubscribe()
    opted.unsubscribe()
    // A replay holds exactly the entries after the cursor, in order.
    const later = await store.subscribe(jobId, 1, 0, () => {}, { after: 1, listener: () => {} })
    expect(later.trailReplay).toMatchObject({ gap: false, oldestTrailSeq: 1, latestTrailSeq: 3 })
    expect(later.trailReplay?.entries.map(e => e.trailSeq)).toEqual([2, 3])
    later.unsubscribe()
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

  it('rollback mid-run then roll forward: no eventSeq is ever reused, the job ends terminal once, and the trail survives', async () => {
    const root = await tempRoot()
    const writer = new QueryJobStore({ root, bootId: 'boot-a' })
    await writer.init()
    const jobId = await runningJob(writer)
    await writer.appendTrail(jobId, { kind: 'prose', text: 'working on it' })
    await writer.appendPartial(jobId, 'part', 'part')
    await writer.appendTrail(jobId, { kind: 'tool', verb: 'read', target: 'a.ts', detail: '' })
    // The server dies here, mid-run, with trail rows as the journal's newest records.

    // The REAL 6.51.0 store boots on this journal (the rollback).
    const rolledBack = new QueryJobStore6510({ root, bootId: 'boot-b' })
    const oldHealth = await rolledBack.init()
    expect(oldHealth.malformedRows).toBe(2)
    expect((await rolledBack.getSnapshot(jobId)).status).toBe('interrupted')

    // Roll forward: every job eventSeq in the journal is unique, so nothing is skipped as
    // a duplicate and nothing is interrupted twice.
    const forward = new QueryJobStore({ root, bootId: 'boot-c' })
    const health = await forward.init()
    expect(health.malformedRows).toBe(0)
    const snapshot = await forward.getSnapshot(jobId)
    expect(snapshot.status).toBe('interrupted')
    expect(snapshot.eventSeq).toBe(5)
    expect(snapshot.trail?.map(entry => entry.kind)).toEqual(['prose', 'tool'])
    const lines = (await journalLines(root)).filter(line => line.jobId === jobId)
    expect(lines.map(line => `${line.eventSeq}:${line.type}`)).toEqual(['1:accepted', '2:starting', '3:running', '3:trail', '4:chunk', '4:trail', '5:interrupted'])
    const jobEventSeqs = lines.filter(line => line.type !== 'trail').map(line => line.eventSeq)
    expect(new Set(jobEventSeqs).size).toBe(jobEventSeqs.length)
    // The next trail row continues the dense count.
    expect((await forward.replay(jobId, 1, 0)).events.map(event => event.eventSeq)).toEqual([1, 2, 3, 4, 5])
  })

  it('the real 6.51.0 store reads a completed 6.52.0 job whole: only malformedRows rises', async () => {
    const root = await tempRoot()
    const writer = new QueryJobStore({ root, bootId: 'boot-a' })
    await writer.init()
    const jobId = await runningJob(writer)
    await writer.appendTrail(jobId, { kind: 'prose', text: 'looking' })
    await writer.appendPartial(jobId, 'The answer', 'The answer')
    await writer.appendTrail(jobId, { kind: 'tool', verb: 'bash', target: 'ls', detail: '' })
    await writer.markAnswerReady(jobId, 'The answer')
    await writer.complete(jobId, { text: 'The answer', provider: 'claude', resolvedModel: 'opus' })
    const current = await writer.getSnapshot(jobId)
    const currentReplay = await writer.replay(jobId, 1, 0)

    const old = new QueryJobStore6510({ root, bootId: 'boot-b' })
    const health = await old.init()
    expect(health.malformedRows).toBe(2)
    const rolledBack = await old.getSnapshot(jobId)
    const { trail: _trail, ...withoutTrail } = current
    expect(rolledBack).toEqual(withoutTrail)
    // And its event stream is the one this build serves an old client.
    expect((await old.replay(jobId, 1, 0)).events).toEqual(currentReplay.events)
  })

  it('a trail row is applied only to its own generation, and never after the job is terminal', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    await store.appendTrail(jobId, { kind: 'prose', text: 'one' })
    await store.complete(jobId, { text: 'done' })
    const partition = (await readdir(root)).find(name => name.endsWith('.jsonl'))!
    const rows = (await readFile(join(root, partition), 'utf8')).split('\n').filter(Boolean)
    const at = rows.findIndex(line => JSON.parse(line).type === 'trail')
    const row = JSON.parse(rows[at]!)
    // Crafted rows a journal could hold: another generation's while the job runs, and one
    // of this generation after the terminal.
    rows.splice(at + 1, 0, JSON.stringify({ ...row, recordId: randomUUID(), generation: 2, eventData: { kind: 'prose', text: 'other generation', trailSeq: 2 } }))
    rows.push(JSON.stringify({ ...row, recordId: randomUUID(), eventData: { kind: 'prose', text: 'after the end', trailSeq: 2 } }))
    await writeFile(join(root, partition), `${rows.join('\n')}\n`)
    const reader = new QueryJobStore({ root, bootId: 'boot-b' })
    await reader.init()
    const snapshot = await reader.getSnapshot(jobId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.trail?.map(entry => (entry as { text: string }).text)).toEqual(['one'])
  })

  it('applies trail rows idempotently by trailSeq: a duplicated row changes nothing', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    await store.appendTrail(jobId, { kind: 'prose', text: 'one' })
    await store.appendTrail(jobId, { kind: 'prose', text: 'two' })
    const lines = await journalLines(root)
    const partition = (await readdir(root)).find(name => name.endsWith('.jsonl'))!
    const dup = lines.find(line => line.type === 'trail' && line.eventData.trailSeq === 1)!
    await appendFile(join(root, partition), `${JSON.stringify({ ...dup, recordId: randomUUID() })}\n`)
    const reader = new QueryJobStore({ root, bootId: 'boot-b' })
    const health = await reader.init()
    expect(health.malformedRows).toBe(0)
    const snapshot = await reader.getSnapshot(jobId)
    expect(snapshot.trail?.map(entry => [entry.trailSeq, (entry as { text: string }).text])).toEqual([[1, 'one'], [2, 'two']])
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
    // A subscriber behind the held window gets the whole held trail to rebuild from.
    const behind = await store.subscribe(jobId, 1, 0, () => {}, { after: 2, listener: () => {} })
    expect(behind.trailReplay).toMatchObject({ gap: true, reason: 'trail_gap', oldestTrailSeq: 6, latestTrailSeq: 6 })
    expect(behind.trailReplay?.entries.map(e => e.trailSeq)).toEqual([6])
    behind.unsubscribe()
    const ahead = await store.subscribe(jobId, 1, 0, () => {}, { after: 9, listener: () => {} })
    expect(ahead.trailReplay).toMatchObject({ gap: true, reason: 'cursor_ahead' })
    ahead.unsubscribe()
  })

  it('the real bounds: 200 entries and 32,000 characters by default', async () => {
    expect(QUERY_JOB_LIMITS.trailEntries).toBe(200)
    expect(QUERY_JOB_LIMITS.trailChars).toBe(32_000)
    const store = new QueryJobStore({ root: await tempRoot(), bootId: 'boot-a' })
    await store.init()
    const jobId = await runningJob(store)
    for (let i = 0; i < QUERY_JOB_LIMITS.trailEntries + 5; i++) await store.appendTrail(jobId, { kind: 'prose', text: `step ${i}` })
    let trail = (await store.getSnapshot(jobId)).trail!
    expect(trail).toHaveLength(QUERY_JOB_LIMITS.trailEntries)
    expect(trail[0]!.trailSeq).toBe(6)
    // 20 entries of 2,000 characters is 40,000: the character bound bites first.
    for (let i = 0; i < 20; i++) await store.appendTrail(jobId, { kind: 'prose', text: 'y'.repeat(2_000) })
    trail = (await store.getSnapshot(jobId)).trail!
    const chars = trail.reduce((sum, entry) => sum + ((entry as { text?: string }).text?.length ?? 0), 0)
    expect(chars).toBeLessThanOrEqual(QUERY_JOB_LIMITS.trailChars)
    expect(chars).toBeGreaterThan(QUERY_JOB_LIMITS.trailChars - 2_000)
  }, 30_000)

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
