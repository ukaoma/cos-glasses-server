// Key lanes K1, package P11 (plan v4 3.1, P9's app half): a keyed answer's `done` event carries
// `lane`, `credential`, `profile` and `usd` at the top level, where the app reads them, on both the
// durable runtime's display bus and the legacy SSE route. A subscription answer carries none of
// them: its done payload is the 6.79.0 one. Harness copied from key-lanes-p6-runtime.test.ts.
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

const KEY_META = {
  keyLane: { lane: 'key', credential: { kind: 'openrouter', ref: 'key_000000000000', profileId: 'gpt' } },
  usd: 0.0123,
}
const KEY_FIELDS = ['lane', 'credential', 'profile', 'usd']

/** model-router as P6 wires it: a profile fires onKeyProfileTurn first; the runner reports a tier. */
function routerFake(runnerModel: string) {
  return async (_q: string, sessionId: string, callbacks: any, model: unknown) => {
    const keyed = typeof model === 'string' && model.startsWith('profile:')
    if (keyed) callbacks.onKeyProfileTurn?.(KEY_TURN)
    const reported = keyed ? runnerModel : model
    await callbacks.onStart?.(reported, sessionId, undefined, {})
    await callbacks.onAnswerReady?.('answer')
    await callbacks.onDone?.('answer', reported, undefined, keyed ? KEY_META : {})
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

describe('done carries the keyed answer fields (P11)', () => {
  it('durable runtime: lane, credential, profile and usd on the done event of a keyed answer', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('sonnet'))
    await runJob('profile:gpt')
    const done = mocks.emitDisplay.mock.calls.find(c => c[0].type === 'done')![0]
    expect(done.data).toMatchObject({
      lane: 'key',
      credential: { kind: 'openrouter', ref: 'key_000000000000', profileId: 'gpt' },
      profile: 'gpt',
      usd: 0.0123,
    })
    expect(JSON.stringify(done.data)).not.toMatch(/sk-or-/)
  })

  it('durable runtime: a subscription answer has none of them', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('unused'))
    await runJob('codex-high')
    const done = mocks.emitDisplay.mock.calls.find(c => c[0].type === 'done')![0]
    for (const k of [...KEY_FIELDS, 'keyLane']) expect(done.data, k).not.toHaveProperty(k)
  })
})

describe('legacy SSE route /api/query: done fields (P11)', () => {
  let server: Server
  async function query(model: string): Promise<string> {
    const { queryRouter } = await import('../routes/query.js')
    const app = express()
    app.use(express.json())
    app.use(queryRouter)
    server = await new Promise<Server>(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)) })
    const address = server.address()
    const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
    const res = await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q', model }) })
    const text = await res.text()
    await new Promise<void>(resolve => server.close(() => resolve()))
    return text
  }
  const events = (text: string, name: string) => text.split('\n\n').filter(b => b.startsWith(`event: ${name}`)).map(b => JSON.parse(b.split('data: ')[1]))

  it('a keyed answer streams lane, credential, profile and usd on done', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('sonnet'))
    const done = events(await query('profile:gpt'), 'done')[0]
    expect(done).toMatchObject({ lane: 'key', credential: { kind: 'openrouter', ref: 'key_000000000000', profileId: 'gpt' }, profile: 'gpt', usd: 0.0123 })
  })

  it('a subscription answer streams none of them', async () => {
    mocks.callModelStreaming.mockImplementation(routerFake('unused'))
    const done = events(await query('haiku'), 'done')[0]
    for (const k of [...KEY_FIELDS, 'keyLane']) expect(done, k).not.toHaveProperty(k)
  })
})

describe('keyAnswerDoneFields', () => {
  it('is {} without keyLane and flattens it with one', async () => {
    const { keyAnswerDoneFields } = await import('./key-answer-fields.js')
    expect(keyAnswerDoneFields(undefined)).toEqual({})
    expect(keyAnswerDoneFields({})).toEqual({})
    expect(keyAnswerDoneFields(KEY_META as never)).toEqual({ lane: 'key', credential: KEY_META.keyLane.credential, profile: 'gpt' })
  })
})
