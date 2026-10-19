// Key lanes K1, package P6 (plan v4 5.2): the durable runtime (query-job-runtime.ts :170 :181
// :207 :121) and the legacy SSE route (routes/query.ts :96) ACCEPT a profile: they pass
// `profile:<id>` to model-router untouched, and report the binding, not the runner's tier, as the
// turn's model and linkage. A model slot keeps the 6.79.0 linkage byte for byte.
import express from 'express'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callModelStreaming: vi.fn(),
  emitDisplay: vi.fn(),
  reconcileExchange: vi.fn(),
}))
vi.mock('./model-router.js', () => ({
  callModelStreaming: mocks.callModelStreaming,
  acquireModelSessionRunLock: vi.fn(async () => () => {}),
}))
vi.mock('./display-bus.js', () => ({ emitDisplay: mocks.emitDisplay }))
vi.mock('./query-attachments.js', () => ({ resolveQueryAttachments: vi.fn(async () => ({ ids: [], refs: [], inputs: [] })) }))
vi.mock('./media-store.js', () => ({ getMediaStore: () => ({ associate: vi.fn() }) }))
vi.mock('./conversation.js', () => ({
  getOrCreateSession: (requested?: string) => requested ?? 'runtime-session',
  findExchangesByJobIdentity: () => [],
  reconcileExchangeByJobIdentity: mocks.reconcileExchange,
  removeExchangesByJobIdentity: () => 0,
  flushConversationToDisk: () => {},
}))

const KEY_TURN = {
  binding: 'profile:gpt',
  keyKind: 'openrouter',
  profile: { id: 'gpt', label: 'GPT Key', engine: 'codex', model: 'openai/gpt-5.5', keyRef: 'key_000000000000', enabled: true, timeoutTier: 'sonnet', offerOnV1: false, directTools: false, createdAt: '', updatedAt: '' },
}

/** model-router as P6 wires it: a profile fires onKeyProfileTurn first; the runner reports a tier. */
function routerFake(runnerModel: string) {
  return async (_q: string, sessionId: string, callbacks: any, model: unknown) => {
    const keyed = typeof model === 'string' && model.startsWith('profile:')
    if (keyed) callbacks.onKeyProfileTurn?.(KEY_TURN)
    const reported = keyed ? runnerModel : model
    await callbacks.onStart?.(reported, sessionId, undefined, {})
    await callbacks.onAnswerReady?.('answer')
    await callbacks.onDone?.('answer', reported, undefined, {})
    return sessionId
  }
}

let root = ''
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'key-lanes-p6-runtime-'))
  process.env.HOME = root
  process.env.COS_DATA_DIR = root
  process.env.COS_PROFILE_PATH = join(root, 'profile.json')
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root
  mocks.reconcileExchange.mockImplementation(() => ({ exchange: {}, created: true }))
})
afterEach(async () => {
  delete process.env.COS_DURABLE_QUERY_JOBS
  delete process.env.COS_QUERY_JOB_DIR
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
})

async function runJob(model: string) {
  const runtime = await import('./query-job-runtime.js')
  await runtime.initQueryJobRuntime()
  const admission = await runtime.queryJobCoordinator.submit(await runtime.preparePublicDurableQueryAdmission({
    clientJobId: randomUUID(), generation: 1, query: 'q', sessionId: 'runtime-session', model,
  }))
  const deadline = Date.now() + 3_000
  let snap = await runtime.queryJobCoordinator.getSnapshot(admission.job.jobId)
  while (snap.status !== 'completed' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10))
    snap = await runtime.queryJobCoordinator.getSnapshot(admission.job.jobId)
  }
  await runtime.shutdownQueryJobRuntime('test_shutdown')
  return snap
}

describe('durable runtime (Accept)', () => {
  it('a profile goes to model-router as profile:<id>; linkage and the bus carry the binding and the engine', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('sonnet'))
    const snap = await runJob('profile:gpt')
    expect(mocks.callModelStreaming.mock.calls[0][3]).toBe('profile:gpt')
    expect(snap).toMatchObject({ status: 'completed', provider: 'codex', resolvedModel: 'profile:gpt' })
    const start = mocks.emitDisplay.mock.calls.find(c => c[0].type === 'start')![0]
    const done = mocks.emitDisplay.mock.calls.find(c => c[0].type === 'done')![0]
    expect(start.data.model).toBe('profile:gpt')
    expect(done.data.model).toBe('profile:gpt')
    // Terminal projection stamps both exchanges by syntax (:170, :181).
    expect(mocks.reconcileExchange.mock.calls.map(c => c[7])).toEqual(['profile:gpt', 'profile:gpt'])
  })

  it('a model slot keeps the 6.79.0 linkage, bus model and stamps, and never offers onKeyProfileTurn', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('unused'))
    const snap = await runJob('codex-high')
    expect(mocks.callModelStreaming.mock.calls[0][3]).toBe('codex-frontier')
    expect(mocks.callModelStreaming.mock.calls[0][2]).not.toHaveProperty('onKeyProfileTurn')
    expect(snap).toMatchObject({ provider: 'codex', resolvedModel: 'codex-frontier' })
    expect(mocks.emitDisplay.mock.calls.find(c => c[0].type === 'start')![0].data.model).toBe('codex-frontier')
    expect(mocks.reconcileExchange.mock.calls.map(c => c[7])).toEqual(['codex-frontier', 'codex-frontier'])
  })

  it('no model: model-router may still find a session binding, so the callback is offered', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('unused'))
    await runJob('')
    expect(mocks.callModelStreaming.mock.calls[0][3]).toBeUndefined()
    expect(typeof mocks.callModelStreaming.mock.calls[0][2].onKeyProfileTurn).toBe('function')
  })
})

describe('legacy SSE route /api/query (Accept)', () => {
  let server: Server
  let base = ''
  async function query(model: string): Promise<string> {
    const { queryRouter } = await import('../routes/query.js')
    const app = express()
    app.use(express.json())
    app.use(queryRouter)
    server = await new Promise<Server>(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)) })
    const address = server.address()
    base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
    const res = await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q', model }) })
    const text = await res.text()
    await new Promise<void>(resolve => server.close(() => resolve()))
    return text
  }
  const events = (text: string, name: string) => text.split('\n\n').filter(b => b.startsWith(`event: ${name}`)).map(b => JSON.parse(b.split('data: ')[1]))

  it('a profile is passed through and the stream names the binding', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('sonnet'))
    const text = await query('profile:gpt')
    expect(mocks.callModelStreaming.mock.calls[0][3]).toBe('profile:gpt')
    expect(events(text, 'start')[0].model).toBe('profile:gpt')
    expect(events(text, 'done')[0].model).toBe('profile:gpt')
  })

  it('a model slot streams exactly as before', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('unused'))
    const text = await query('haiku')
    expect(mocks.callModelStreaming.mock.calls[0][3]).toBe('haiku')
    expect(mocks.callModelStreaming.mock.calls[0][2]).not.toHaveProperty('onKeyProfileTurn')
    expect(events(text, 'start')[0]).toEqual({ model: 'haiku' })
  })
})
