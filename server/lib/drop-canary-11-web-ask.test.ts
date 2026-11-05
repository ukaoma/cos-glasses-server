/**
 * Canary 11, both ways (Drop it plan sections 9 and 12, 6.99.10). Through the REAL job runtime, coordinator, store,
 * conversation cache, Messages routes and message counter; only the model router, the display bus and attachment
 * resolution are faked (as in query-job-runtime-trail.test.ts), so nothing reaches a provider.
 *
 *   - A Drop must not move the lens message number, and must not add a row to all-messages or live-chats.
 *   - A web Ask (POST /api/query-jobs with source 'web') must move the message number by exactly one, its answer must be
 *     a Messages turn with that number, and a retry of the same request must not move it again.
 *
 * Plus the unit rules of lib/web-ask-admission.ts.
 */
import express from 'express'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ callModelStreaming: vi.fn(), emitDisplay: vi.fn() }))
vi.mock('./model-router.js', () => ({
  callModelStreaming: mocks.callModelStreaming,
  acquireModelSessionRunLock: vi.fn(async () => () => {}),
}))
vi.mock('./display-bus.js', () => ({ emitDisplay: mocks.emitDisplay, getDisplayBusStats: () => ({}) }))
vi.mock('./query-attachments.js', () => ({ resolveQueryAttachments: vi.fn(async () => ({ ids: [], refs: [], inputs: [] })) }))
vi.mock('./media-store.js', () => ({ getMediaStore: () => ({ associate: vi.fn(async () => {}) }) }))

const ANSWER = 'The Kickoff deck is due Friday.'
async function scriptedRun(_q: string, sessionId: string, callbacks: Record<string, (...args: any[]) => any>): Promise<string> {
  await callbacks.onStart?.('opus', sessionId, undefined, { claudeRunId: 'run-1' })
  callbacks.onChunk?.(ANSWER)
  await callbacks.onAnswerReady?.(ANSWER)
  await callbacks.onDone?.(ANSWER, 'opus', 'cli-1', { claudeRunId: 'run-1' })
  return sessionId
}

let root = ''
const cleanup: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'cos-canary11-'))
  process.env.COS_DATA_DIR = root
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root
  mocks.callModelStreaming.mockImplementation(scriptedRun)
})
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete process.env.COS_DURABLE_QUERY_JOBS
  delete process.env.COS_QUERY_JOB_DIR
  delete process.env.COS_DATA_DIR
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
})

describe('canary 11 both ways: a Drop leaves the message number alone; a web Ask moves it by exactly one', () => {
  it('runs a drop, then two web asks and a replay, against the real Messages routes', async () => {
    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    cleanup.push(() => runtime.shutdownQueryJobRuntime('test_shutdown'))
    const { createQueryJobsRouter } = await import('../routes/query-jobs.js')
    const { sessionsRouter } = await import('../routes/sessions.js')
    const { messageRefRouter } = await import('../routes/message-ref.js')
    const { createDropsRouter } = await import('../routes/drops.js')
    const { DropStore, InboxFeedStore } = await import('./drop-store.js')
    const { DropRouter } = await import('./drop-router.js')
    const { DropService } = await import('./drop-service.js')
    const { fakeWriters, scriptedDecisionClient } = await import('./__fixtures__/drop-fixtures.js')

    const storeRoot = mkdtempSync(join(tmpdir(), 'cos-canary11-drops-'))
    const drops = new DropStore(join(storeRoot, 'drops')), feed = new InboxFeedStore(join(storeRoot, 'inbox'))
    cleanup.push(() => { drops.close(); feed.close(); rmSync(storeRoot, { recursive: true, force: true }) })
    const service = new DropService({ drops, feed, writers: fakeWriters(), router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }) })

    const app = express(); app.use(express.json())
    app.use('/api', createQueryJobsRouter(runtime.queryJobCoordinator, { enabled: () => true, prepareAdmission: runtime.preparePublicDurableQueryAdmission }))
    app.use('/api', sessionsRouter); app.use('/api', messageRefRouter)
    app.use('/api', createDropsRouter({ enabled: () => true, service: () => service }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    cleanup.push(() => new Promise<void>(r => server.close(() => r())))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
    const getJson = (p: string) => fetch(base + p).then(r => r.json() as Promise<any>)
    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() as any }))
    const counter = async () => (await getJson('/message-counter')).max as number
    const rows = async () => (await getJson('/sessions/today/all-messages')).messages as Array<{ no?: number; globalMsgNum?: number; query: string; text: string }>
    const chats = async () => (await getJson('/sessions/today/live-chats')).chats as unknown[]
    const waitDone = async (jobId: string) => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const job = (await getJson(`/query-jobs/${jobId}?generation=1`)).job
        if (job.status === 'completed') return job
        await new Promise(r => setTimeout(r, 15))
      }
      throw new Error('job did not finish')
    }

    // ── A Drop (filed, a question, an undo): nothing moves. ──
    const before = { max: await counter(), rows: await rows(), chats: await chats() }
    const filed = await post('/drops', { dropId: randomUUID(), text: 'Draft the onboarding email sequence for new liquor stores', source: 'web' })
    expect(filed.body.drop.dest).toBe('new_card')
    await post('/drops', { dropId: randomUUID(), text: 'Call Dale about the Kickoff deck', source: 'web' })
    await post(`/drops/${filed.body.drop.id}/undo`, {})
    expect(await counter()).toBe(before.max)
    expect(await rows()).toEqual(before.rows)
    expect(await chats()).toEqual(before.chats)

    // ── A web Ask: exactly one. ──
    const clientJobId = randomUUID()
    const ask = { clientJobId, generation: 1, query: 'When is the Kickoff deck due?', model: 'opus', source: 'web' }
    const admitted = await post('/query-jobs', ask)
    expect(admitted.status).toBe(202)
    expect(admitted.body.job.globalMsgNum).toBe(before.max + 1)
    const done = await waitDone(admitted.body.job.jobId)
    expect(done.response).toBe(ANSWER)
    expect(await counter()).toBe(before.max + 1)
    const after = await rows()
    expect(after.length).toBe(before.rows.length + 1)
    const turn = after.find(m => (m.no ?? m.globalMsgNum) === before.max + 1)
    expect(turn).toMatchObject({ query: 'When is the Kickoff deck due?', text: ANSWER })

    // A retry of the same request (a lost 202) replays: no second number, no second row.
    const replay = await post('/query-jobs', ask)
    expect(replay.status).toBe(202)
    expect(replay.body.job.jobId).toBe(admitted.body.job.jobId)
    expect(await counter()).toBe(before.max + 1)
    expect((await rows()).length).toBe(after.length)

    // A follow-up in the same conversation takes the next number, once.
    const second = await post('/query-jobs', { clientJobId: randomUUID(), generation: 1, query: 'And the board pack?', model: 'opus', source: 'web', sessionId: done.sessionId })
    expect(second.body.job.globalMsgNum).toBe(before.max + 2)
    expect(second.body.job.sessionId).toBe(done.sessionId)
    await waitDone(second.body.job.jobId)
    expect(await counter()).toBe(before.max + 2)
    expect((await rows()).length).toBe(before.rows.length + 2)
  })
})

describe('web Ask admission (lib/web-ask-admission.ts)', () => {
  it('only touches source web: it mints the next number above every number already held, and keeps a live session', async () => {
    const { prepareWebAsk, isWebAsk, resetWebAskMintForTests } = await import('./web-ask-admission.js')
    resetWebAskMintForTests()
    let max = 41, made = 0
    const deps = { currentMax: () => max, activeEra: () => 'era-1', sessionExists: (id: string) => id === 'live-1',
      createSession: () => `new-${++made}`, priorJob: async () => undefined }
    expect(isWebAsk({ source: 'web' })).toBe(true)
    for (const other of [{}, { source: 'g2' }, { source: 'WEB' }, { source: ['web'] }]) expect(isWebAsk(other)).toBe(false)
    const a = await prepareWebAsk({ source: 'web', clientJobId: randomUUID(), generation: 1, query: 'q', globalMsgNum: 9999, sessionId: 'gone' }, deps)
    expect(a).toMatchObject({ globalMsgNum: 42, sessionId: 'new-1', messageEra: 'era-1' })
    expect(a).not.toHaveProperty('source')
    // The counter has not seen #42 yet (not projected, not reserved): the next one still goes above it.
    const b = await prepareWebAsk({ source: 'web', clientJobId: randomUUID(), generation: 1, query: 'q', sessionId: 'live-1' }, deps)
    expect(b).toMatchObject({ globalMsgNum: 43, sessionId: 'live-1' })
    max = 60
    expect((await prepareWebAsk({ source: 'web', clientJobId: randomUUID(), generation: 1, query: 'q' }, deps)).globalMsgNum).toBe(61)
  })

  it('a retry of an admitted job reuses its session and number instead of minting', async () => {
    const { prepareWebAsk, resetWebAskMintForTests } = await import('./web-ask-admission.js')
    resetWebAskMintForTests()
    const id = randomUUID()
    const out = await prepareWebAsk({ source: 'web', clientJobId: id.toUpperCase(), generation: 1, query: 'q' }, {
      currentMax: () => 100, activeEra: () => 'era-1', sessionExists: () => false, createSession: () => 'should-not-be-made',
      priorJob: async (cid, gen) => cid === id && gen === 1 ? { sessionId: 's-7', globalMsgNum: 77, messageEra: 'era-0' } : undefined,
    })
    expect(out).toMatchObject({ sessionId: 's-7', globalMsgNum: 77, messageEra: 'era-0' })
  })
})

// 6.99.10 field bug (Miles, 23:32): Ask COS in the web Ask sheet (app.js askCos) "does nothing". It posted `prompt`
// with a `web_<time>` id and no era, so a Mac with a message era refused it (409 message_era_mismatch). This runs
// askCos's own request body, read out of app.js, against the real routes with an era active.
describe('the web Ask sheet (app.js askCos) is admitted on a Mac with a message era', () => {
  it('sends the request the server accepts; the old request is refused', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs')
    writeFileSync(join(root, 'message-era.json'), JSON.stringify({ v: 1, era: 'era-test-1', startedAt: Date.now() }))
    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    cleanup.push(() => runtime.shutdownQueryJobRuntime('test_shutdown'))
    const { createQueryJobsRouter } = await import('../routes/query-jobs.js')
    const app = express(); app.use(express.json())
    app.use('/api', createQueryJobsRouter(runtime.queryJobCoordinator, { enabled: () => true, prepareAdmission: runtime.preparePublicDurableQueryAdmission }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    cleanup.push(() => new Promise<void>(r => server.close(() => r())))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
    const post = (body: unknown) => fetch(base + '/query-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() as any }))

    const source = readFileSync(new URL('../web-control/app.js', import.meta.url), 'utf8')
    const fn = source.slice(source.indexOf('function askCos('), source.indexOf('// ── Memories'))
    const bodyLiteral = /var body = (\{[^;]*\});/.exec(fn)?.[1]
    expect(bodyLiteral, 'askCos builds its request as `var body = {...};`').toBeTruthy()
    const jobIdSrc = source.slice(source.indexOf('function webJobId('), source.indexOf('function askCos('))
    // eslint-disable-next-line no-new-func
    const build = new Function('prompt', 'crypto', `${jobIdSrc}; return ${bodyLiteral};`)
    const sent = build('Web Ask test: reply OK', globalThis.crypto) as Record<string, unknown>

    const ok = await post(sent)
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300)
    expect(ok.body.job?.messageEra ?? ok.body.messageEra ?? 'era-test-1').toBe('era-test-1')

    const old = await post({ prompt: 'Web Ask test: reply OK', clientJobId: 'web_' + Date.now() })
    expect(old.status).toBeGreaterThanOrEqual(400)

    // 6.99.11: the pinned chat's own Ask (panes/cos-chat.js submitAsk), which the Ask button and P2's "Prep me" use,
    // read out of the pane and sent with the same era active.
    const chat = readFileSync(new URL('../web-control/panes/cos-chat.js', import.meta.url), 'utf8')
    const askFn = chat.slice(chat.indexOf('function submitAsk('), chat.indexOf('var admit ='))
    const chatBody = /var body = (\{[^;]*\});/.exec(askFn)?.[1]
    expect(chatBody, 'submitAsk builds its request as `var body = {...};`').toBeTruthy()
    // eslint-disable-next-line no-new-func
    const chatSent = new Function('a', 'text', `return ${chatBody};`)({ cid: globalThis.crypto.randomUUID() }, 'Prep me for Pete 1:1') as Record<string, unknown>
    const chatOk = await post(chatSent)
    expect(chatOk.status, JSON.stringify(chatOk.body)).toBeLessThan(300)
  })
})
