// The Messages trail through the REAL job runner, coordinator and store (6.52.0). Only the
// model router, the display bus and the conversation cache are faked, as in
// query-job-runtime.test.ts, so what is asserted is what a durable job actually journals.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callModelStreaming: vi.fn(),
  emitDisplay: vi.fn(),
  reconcileExchange: vi.fn(),
  flushConversation: vi.fn(),
}))

vi.mock('./model-router.js', () => ({
  callModelStreaming: mocks.callModelStreaming,
  acquireModelSessionRunLock: vi.fn(async () => () => {}),
}))
vi.mock('./display-bus.js', () => ({ emitDisplay: mocks.emitDisplay }))
vi.mock('./query-attachments.js', () => ({
  resolveQueryAttachments: vi.fn(async () => ({ ids: [], refs: [], inputs: [] })),
}))
vi.mock('./media-store.js', () => ({ getMediaStore: () => ({ associate: vi.fn(async () => {}) }) }))
vi.mock('./conversation.js', () => ({
  getOrCreateSession: (requested?: string) => requested ?? 'runtime-session',
  findExchangesByJobIdentity: () => [],
  reconcileExchangeByJobIdentity: mocks.reconcileExchange,
  removeExchangesByJobIdentity: () => 0,
  flushConversationToDisk: mocks.flushConversation,
}))

const ANSWER = 'I will check the config. Port 3141.'

/** A provider run as a bridge reports it: status, chunks, activity and trail, interleaved.
 * Every trail string carries TRAIL-ONLY so a leak onto any other channel is findable. */
async function scriptedRun(
  _query: string,
  sessionId: string,
  callbacks: Record<string, (...args: any[]) => any>,
  _model: unknown, _images: unknown, _reference: unknown, _globalMsgNum: unknown,
  options: Record<string, unknown>,
): Promise<string> {
  await callbacks.onStart?.('opus', sessionId, undefined, { claudeRunId: 'claude-run-1' })
  await callbacks.onProviderProcess?.({ provider: 'claude', runId: 'claude-run-1', clientJobId: options.clientJobId, generation: options.generation })
  callbacks.onToolStatus?.('Thinking...')
  callbacks.onTrail?.({ kind: 'prose', text: 'TRAIL-ONLY: I will check the config.' })
  callbacks.onChunk?.('I will check the config.')
  callbacks.onToolStatus?.('Read')
  callbacks.onActivityLine?.({ kind: 'input', text: 'File: config.json' })
  callbacks.onTrail?.({ kind: 'tool', verb: 'read', target: 'TRAIL-ONLY-config.json', detail: '', call: 'toolu_01Read' })
  callbacks.onActivityLine?.({ kind: 'output', text: '{"port": 3141}' })
  callbacks.onTrail?.({ kind: 'status', state: 'working', tool_outcome: { ok: false, detail: 'TRAIL-ONLY ENOENT raw', call: 'toolu_01Read' } })
  callbacks.onToolStatus?.('Read')
  callbacks.onTrail?.({ kind: 'status', state: 'working', detail: 'TRAIL-ONLY step line' })
  callbacks.onChunk?.(' Port 3141.')
  callbacks.onTrail?.({ kind: 'prose', text: 'TRAIL-ONLY: Port 3141.' })
  await callbacks.onAnswerReady?.(ANSWER)
  await callbacks.onDone?.(ANSWER, 'opus', 'cli-session-1', { claudeRunId: 'claude-run-1' })
  return sessionId
}

let root = ''

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'cos-trail-runtime-'))
  process.env.COS_DATA_DIR = root
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root
  delete process.env.COS_MESSAGES_TRAIL
  mocks.reconcileExchange.mockImplementation(() => ({ exchange: {}, created: true }))
  mocks.callModelStreaming.mockImplementation(scriptedRun)
})

afterEach(async () => {
  delete process.env.COS_DURABLE_QUERY_JOBS
  delete process.env.COS_QUERY_JOB_DIR
  delete process.env.COS_DATA_DIR
  delete process.env.COS_MESSAGES_TRAIL
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
})

type Runtime = typeof import('./query-job-runtime.js')

async function runJob(runtime: Runtime, activityToolMode: 'off' | 'status' | 'preview') {
  const admission = await runtime.queryJobCoordinator.submit({
    clientJobId: randomUUID(),
    generation: 1,
    query: 'what port does the config use?',
    sessionId: 'runtime-session',
    model: 'opus',
    attachmentIds: [],
    attachmentRefs: [],
    activityToolMode,
  })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if ((await runtime.queryJobCoordinator.getSnapshot(admission.job.jobId)).status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const snapshot = await runtime.queryJobCoordinator.getSnapshot(admission.job.jobId)
  expect(snapshot.status).toBe('completed')
  const replay = await runtime.queryJobStore.replay(admission.job.jobId, 1, 0)
  return { snapshot, events: replay.events }
}

describe('the Messages trail through the durable job runtime', () => {
  it('journals the trail with a dense trailSeq among chunks, tool status and activity, and never puts it on the display bus', async () => {
    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    const { snapshot, events } = await runJob(runtime, 'preview')

    const trail = events.filter(event => event.type === 'trail')
    expect(trail.map(event => event.data.trailSeq)).toEqual([1, 2, 3, 4, 5])
    const seqs = events.map(event => event.eventSeq)
    const trailPositions = trail.map(event => seqs.indexOf(event.eventSeq))
    // Interleaved for real: other job events sit between trail rows.
    expect(trailPositions.some((position, index) => index > 0 && position !== trailPositions[index - 1] + 1)).toBe(true)
    expect(snapshot.trail?.map(entry => entry.trailSeq)).toEqual([1, 2, 3, 4, 5])
    expect(snapshot.trail?.map(entry => entry.kind)).toEqual(['prose', 'tool', 'status', 'status', 'prose'])

    const bus = JSON.stringify(mocks.emitDisplay.mock.calls)
    expect(mocks.emitDisplay.mock.calls.length).toBeGreaterThan(0)
    expect(bus).not.toContain('TRAIL-ONLY')
    expect(mocks.emitDisplay.mock.calls.some(([event]) => event?.type === 'trail')).toBe(false)
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })

  it("applies the job's own activityToolMode: off keeps no steps, status keeps steps but hides raw failure text", async () => {
    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()

    const off = await runJob(runtime, 'off')
    expect(off.snapshot.trail?.map(entry => entry.kind === 'status' && 'detail' in entry ? 'step-line' : entry.kind))
      .toEqual(['prose', 'step-line', 'prose'])
    expect(off.snapshot.trail?.map(entry => entry.trailSeq)).toEqual([1, 2, 3])

    const status = await runJob(runtime, 'status')
    expect(status.snapshot.trail?.map(entry => entry.kind)).toEqual(['prose', 'tool', 'status', 'status', 'prose'])
    expect(status.snapshot.trail?.[2]).toMatchObject({ tool_outcome: { ok: false, detail: 'error', call: 'toolu_01Read' } })

    const preview = await runJob(runtime, 'preview')
    expect(preview.snapshot.trail?.[2]).toMatchObject({ tool_outcome: { ok: false, detail: 'TRAIL-ONLY ENOENT raw' } })
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })

  it('leaves the answer, the history projection, the display events and every non-trail event exactly as without it', async () => {
    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()

    const withTrail = await runJob(runtime, 'preview')
    const withTrailBus = mocks.emitDisplay.mock.calls.splice(0)
    const withTrailHistory = mocks.reconcileExchange.mock.calls.splice(0)

    process.env.COS_MESSAGES_TRAIL = '0'
    const withoutTrail = await runJob(runtime, 'preview')
    const withoutTrailBus = mocks.emitDisplay.mock.calls.splice(0)
    const withoutTrailHistory = mocks.reconcileExchange.mock.calls.splice(0)

    expect(withoutTrail.snapshot).not.toHaveProperty('trail')
    expect(withTrail.snapshot.response).toBe(ANSWER)
    expect(withoutTrail.snapshot.response).toBe(ANSWER)
    expect(withTrail.snapshot.partialText).toBe(withoutTrail.snapshot.partialText)
    expect(withTrail.snapshot.activity.map(({ kind, text, repeatCount }) => ({ kind, text, repeatCount })))
      .toEqual(withoutTrail.snapshot.activity.map(({ kind, text, repeatCount }) => ({ kind, text, repeatCount })))

    // Identity and timing differ per job; everything else must match field for field.
    const ids = new Set<string>()
    for (const run of [withTrail, withoutTrail]) {
      for (const key of ['jobId', 'clientJobId', 'turnId', 'requestFingerprint'] as const) ids.add(run.snapshot[key])
    }
    const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => {
      if (typeof item === 'string' && ids.has(item)) return '<id>'
      if (key === 'at' || key.endsWith('At') || key === 'eventSeq' || key === 'retentionUntil') return '<t>'
      return item
    }))
    const nonTrail = (events: typeof withTrail.events) => scrub(events
      .filter(event => event.type !== 'trail')
      .map(event => ({ type: event.type, status: event.status, data: event.data })))
    expect(nonTrail(withTrail.events)).toEqual(nonTrail(withoutTrail.events))
    expect(scrub(withTrailBus)).toEqual(scrub(withoutTrailBus))
    expect(scrub(withTrailHistory)).toEqual(scrub(withoutTrailHistory))
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })

  it('COS_MESSAGES_TRAIL=0 hands the bridges no trail callback at all', async () => {
    process.env.COS_MESSAGES_TRAIL = '0'
    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    const { snapshot, events } = await runJob(runtime, 'preview')
    const bridgeCallbacks = mocks.callModelStreaming.mock.calls[0][2] as Record<string, unknown>
    expect(bridgeCallbacks).not.toHaveProperty('onTrail')
    expect(snapshot).not.toHaveProperty('trail')
    expect(events.some(event => event.type === 'trail')).toBe(false)
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })

  it('hands the bridges a trail callback by default', async () => {
    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    await runJob(runtime, 'status')
    expect(typeof (mocks.callModelStreaming.mock.calls[0][2] as Record<string, unknown>).onTrail).toBe('function')
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })
})
