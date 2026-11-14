/**
 * 7.0.39 (persistent COS thread, candidate 2): a chat sent with `cosThread: true` is never lost, whatever happens to
 * the server. A crash is a module reset and a fresh import over the SAME journal and data directories (the first
 * runtime is left as it was, never shut down), so the second boot sees exactly what a restarted server sees. Real job
 * runtime, coordinator, journal, conversation store and thread store; only the model, the display bus and attachment
 * resolution are faked. Placeholder words only.
 */
import express from 'express'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
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

type Callbacks = Record<string, (...args: any[]) => any>
const ANSWER = 'placeholder answer'
const never = () => new Promise<never>(() => {})
const answers = async (_q: string, sessionId: string, c: Callbacks) => {
  await c.onStart?.('opus', sessionId, undefined, { claudeRunId: 'run-2' })
  c.onChunk?.(ANSWER)
  await c.onAnswerReady?.(ANSWER)
  await c.onDone?.(ANSWER, 'opus', 'cli-2', { claudeRunId: 'run-2' })
  return sessionId
}

let root = ''
const cleanup: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'cos-thread-lost-'))
  process.env.COS_DATA_DIR = root
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root
  process.env.COS_DROP_IT = '1'   // the thread exists only while Drop it is on
})
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete process.env.COS_DURABLE_QUERY_JOBS
  delete process.env.COS_QUERY_JOB_DIR
  delete process.env.COS_DROP_IT
  delete process.env.COS_DATA_DIR
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
})

/** One server process: a fresh module graph over the shared directories. `faultyEnd` makes the thread store's first
 * job-end write throw (the crash window between the journal's terminal fsync and the thread write). */
async function boot(model: (q: string, s: string, c: Callbacks) => Promise<string>, options: { faultyEnd?: boolean; noStore?: boolean } = {}) {
  mocks.callModelStreaming.mockImplementation(model)
  const { CosThread, lazyCosThread, __resetCosThreadStoreForTests } = await import('./cos-thread.js')
  const thread = options.noStore ? () => null : lazyCosThread(() => {
    const store = new CosThread({ dir: join(root, 'cos-thread'), context: () => ({ found: true, tokens: 1000 }) })
    if (options.faultyEnd) {
      const real = store.recordJobEnd.bind(store)
      let failed = false
      store.recordJobEnd = end => { if (!failed) { failed = true; throw new Error('disk full') } real(end) }
    }
    return store
  })
  if (options.noStore) __resetCosThreadStoreForTests()
  else thread()  // open now, as a request would, so the boot's re-projection finds it
  const runtime = await import('./query-job-runtime.js')
  await runtime.initQueryJobRuntime()
  const { createQueryJobsRouter } = await import('../routes/query-jobs.js')
  const { sessionsRouter } = await import('../routes/sessions.js')
  const { createCosThreadRouter } = await import('../routes/cos-thread.js')
  const conversation = await import('./conversation.js')
  const app = express(); app.use(express.json())
  app.use('/api', createQueryJobsRouter(runtime.queryJobCoordinator, { enabled: () => true, prepareAdmission: runtime.preparePublicDurableQueryAdmission }))
  app.use('/api', sessionsRouter)
  app.use('/api', createCosThreadRouter({ enabled: () => true, thread, archiveAnswer: () => undefined }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  cleanup.push(() => new Promise<void>(r => server.close(() => r())))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const getJson = (p: string) => fetch(base + p).then(r => r.json() as Promise<any>)
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() as any }))
  const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> => {
    const deadline = Date.now() + 6_000
    for (;;) {
      const v = await read()
      if (ok(v)) return v
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`)
      await new Promise(r => setTimeout(r, 20))
    }
  }
  const entry = async () => (await getJson('/cos-thread/history')).entries.at(-1)
  const rows = async () => (await getJson('/sessions/today/all-messages?limit=100')).messages as unknown[]
  return { runtime, conversation, getJson, post, until, entry, rows, shutdown: () => runtime.shutdownQueryJobRuntime('test_shutdown') }
}
/** A crash: the running process is abandoned as it is, and the next import is a new process over the same disk. */
function crash(): void { vi.resetModules() }
const threadAsk = (query: string) => ({ clientJobId: randomUUID(), generation: 1, query, model: 'opus', source: 'web', cosThread: true })

describe('a cosThread chat is never lost', () => {
  it('(a) a crash right after the 202: the thread keeps the question and follows the journal to its end', async () => {
    const first = await boot(async () => never())   // the provider never answers
    const ask = threadAsk('asked just before a crash')
    const admitted = await first.post('/query-jobs', ask)
    expect(admitted.status).toBe(202)
    crash()
    const second = await boot(answers)
    cleanup.push(second.shutdown)
    // Two outcomes, both right, decided by whether the first process had reached its provider before the crash: still
    // `accepted`, the boot requeues and runs it (completed); already starting, the boot ends it `interrupted`, resumable
    // (the page offers Resume). Either way the question is kept and the thread says what the journal says.
    // The boot may end it `interrupted` and then resume the same generation, so a single read can catch the thread and
    // the journal between the two. Wait until both are at an end and say the same thing, then judge that end.
    const both = async () => ({ e: await second.entry(), job: (await second.getJson(`/query-jobs/${admitted.body.job.jobId}?generation=1`)).job })
    const { e, job } = await second.until(both, v => !!v.e && ['completed', 'failed', 'canceled', 'interrupted'].includes(v.job?.status)
      && v.e.status === (v.job.status === 'canceled' ? 'interrupted' : v.job.status), 'the thread and the journal agreeing on an end')
    expect(e).toMatchObject({ id: `t:${ask.clientJobId}`, question: 'asked just before a crash', generation: 1 })
    expect(['completed', 'interrupted']).toContain(job.status)
    if (job.status === 'completed') expect(e).toMatchObject({ status: 'completed', answer: ANSWER, full: true })
    else expect([e.status, job.interruption?.resumable]).toEqual(['interrupted', true])
    expect(second.conversation.isCosThreadSession(admitted.body.job.sessionId)).toBe(true)
    expect(await second.rows()).toEqual([])
  })

  it('(a2) an interrupted end of a generation is replaced when that same generation is resumed and completes', async () => {
    const { CosThread } = await import('./cos-thread.js')
    const store = new CosThread({ dir: join(root, 'cos-thread-a2'), context: () => ({ found: true, tokens: 1 }) })
    const job = { clientJobId: randomUUID(), generation: 1, sessionId: 'sess-a2-0001', query: 'resumed later' }
    store.recordJobEnd({ ...job, status: 'interrupted', text: '' })
    expect(store.historyPage({ limit: 5 }).entries[0]).toMatchObject({ status: 'interrupted' })
    store.recordJobEnd({ ...job, status: 'completed', text: ANSWER })
    store.recordJobEnd({ ...job, status: 'completed', text: ANSWER })   // the boot's re-projection: no second row
    expect(store.historyPage({ limit: 5 }).entries[0]).toMatchObject({ status: 'completed', answer: ANSWER })
    const again = new CosThread({ dir: join(root, 'cos-thread-a2'), context: () => ({ found: true, tokens: 1 }) })
    expect(again.historyPage({ limit: 5 }).entries[0]).toMatchObject({ status: 'completed', answer: ANSWER })
    expect(again.historyPage({ limit: 5, after: 0, afterAnswers: 0 }).newest).toBe('c1.1.2')
  })

  it('(b) a crash mid-answer: the next boot ends it interrupted and the thread keeps the question and the partial answer', async () => {
    const first = await boot(async (_q, s, c) => {
      await c.onStart?.('opus', s, undefined, { claudeRunId: 'run-1' })
      c.onChunk?.('partial words')
      return never()
    })
    const ask = threadAsk('asked during a crash')
    const admitted = await first.post('/query-jobs', ask)
    await first.until(() => first.getJson(`/query-jobs/${admitted.body.job.jobId}?generation=1`), v => v.job?.partialText === 'partial words', 'the partial on disk')
    expect(await first.entry()).toMatchObject({ status: 'running', question: 'asked during a crash', answer: '' })
    crash()
    const second = await boot(answers)
    cleanup.push(second.shutdown)
    const e = await second.until(second.entry, v => v?.status !== 'running', 'the thread end after reboot')
    expect(e).toMatchObject({ id: `t:${ask.clientJobId}`, question: 'asked during a crash', status: 'interrupted', answer: 'partial words' })
    expect(await second.rows()).toEqual([])
  })

  it('(c) the thread write fails after the journal ended the job: the next boot re-projects it into the thread', async () => {
    const first = await boot(answers, { faultyEnd: true })
    const ask = threadAsk('asked when the disk was full')
    const admitted = await first.post('/query-jobs', ask)
    await first.until(() => first.getJson(`/query-jobs/${admitted.body.job.jobId}?generation=1`), v => v.job?.status === 'completed', 'the job end')
    expect(await first.entry()).toMatchObject({ status: 'running', question: 'asked when the disk was full' })
    crash()
    const second = await boot(answers)
    cleanup.push(second.shutdown)
    const e = await second.until(second.entry, v => v?.status === 'completed', 'the re-projected thread answer')
    expect(e).toMatchObject({ id: `t:${ask.clientJobId}`, answer: ANSWER, full: true })
    expect(await second.rows()).toEqual([])
  })

  it('(d) no thread store when the job ends: the projection fails (counted, retried), and the next boot records it', async () => {
    const first = await boot(answers, { noStore: true })
    const ask = threadAsk('asked while the store could not open')
    const admitted = await first.post('/query-jobs', ask)
    await first.until(() => first.getJson(`/query-jobs/${admitted.body.job.jobId}?generation=1`), v => v.job?.status === 'completed', 'the job end')
    expect(first.runtime.queryJobCoordinator.getHealth().terminalProjectionFailures).toBeGreaterThan(0)
    crash()
    const second = await boot(answers)
    cleanup.push(second.shutdown)
    const e = await second.until(second.entry, v => v?.status === 'completed', 'the thread answer after reboot')
    expect(e).toMatchObject({ id: `t:${ask.clientJobId}`, question: 'asked while the store could not open', answer: ANSWER })
  })
})
