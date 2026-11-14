/**
 * 7.0.39 (persistent COS thread, candidate 2; docs/cos-thread.md): a chat sent with `cosThread: true` stays in the
 * thread. Through the REAL job runtime, coordinator, journal, conversation store, Messages, archive and counter routes
 * and the thread store; only the model router, the display bus and attachment resolution are faked (the canary-11
 * harness, drop-canary-11-web-ask.test.ts), so nothing reaches a provider. Placeholder words only.
 */
import express from 'express'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

const ANSWER = 'placeholder answer'
const LONG = 'L'.repeat(5000) + ' end'
/** The model, by the question's first word: ok, long, fail. */
async function scriptedRun(q: string, sessionId: string, callbacks: Record<string, (...args: any[]) => any>): Promise<string> {
  await callbacks.onStart?.('opus', sessionId, undefined, { claudeRunId: 'run-1' })
  if (q.startsWith('fail')) {
    callbacks.onChunk?.('partial words')
    // Past the coordinator's partial flush (50 ms): it drops a partial not yet flushed when a job fails (as today).
    await new Promise(r => setTimeout(r, 150))
    await callbacks.onError?.('provider failed')
    return sessionId
  }
  const text = q.startsWith('long') ? LONG : ANSWER
  callbacks.onChunk?.(text)
  await callbacks.onAnswerReady?.(text)
  await callbacks.onDone?.(text, 'opus', 'cli-1', { claudeRunId: 'run-1' })
  return sessionId
}

let root = ''
const cleanup: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'cos-thread-only-'))
  process.env.COS_DATA_DIR = root
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root
  process.env.COS_DROP_IT = '1'   // the thread exists only while Drop it is on
  mocks.callModelStreaming.mockImplementation(scriptedRun)
})
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete process.env.COS_DURABLE_QUERY_JOBS
  delete process.env.COS_QUERY_JOB_DIR
  delete process.env.COS_DROP_IT
  delete process.env.COS_DATA_DIR
  // retries: an abandoned runtime (a simulated crash) may still be writing into it
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  vi.resetModules()
})

async function harness() {
  const { CosThread, lazyCosThread } = await import('./cos-thread.js')
  const thread = lazyCosThread(() => new CosThread({ dir: join(root, 'cos-thread'), context: () => ({ found: true, tokens: 1000 }) }))
  const runtime = await import('./query-job-runtime.js')
  await runtime.initQueryJobRuntime()
  cleanup.push(() => runtime.shutdownQueryJobRuntime('test_shutdown'))
  const { createQueryJobsRouter } = await import('../routes/query-jobs.js')
  const { sessionsRouter } = await import('../routes/sessions.js')
  const { messageRefRouter } = await import('../routes/message-ref.js')
  const { archiveRouter } = await import('../routes/archive.js')
  const { createCosThreadRouter } = await import('../routes/cos-thread.js')
  const conversation = await import('./conversation.js')
  const app = express(); app.use(express.json({ limit: '1mb' }))
  app.use('/api', createQueryJobsRouter(runtime.queryJobCoordinator, { enabled: () => true, prepareAdmission: runtime.preparePublicDurableQueryAdmission }))
  app.use('/api', sessionsRouter, messageRefRouter, archiveRouter)
  app.use('/api', createCosThreadRouter({ enabled: () => true, thread, archiveAnswer: () => undefined }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  cleanup.push(() => new Promise<void>(r => server.close(() => r())))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const get = (p: string) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() as any }))
  const getJson = async (p: string) => (await get(p)).body
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() as any }))
  const waitEnd = async (jobId: string, generation = 1) => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const job = (await getJson(`/query-jobs/${jobId}?generation=${generation}`)).job
      if (['completed', 'failed', 'canceled', 'interrupted'].includes(job.status)) return job
      await new Promise(r => setTimeout(r, 15))
    }
    throw new Error('job did not finish')
  }
  /** Everything a public client reads that a thread chat must not touch. */
  const lists = async () => ({
    max: (await getJson('/message-counter')).max as number,
    rows: (await getJson('/sessions/today/all-messages?limit=100')).messages,
    chats: (await getJson('/sessions/today/live-chats')).chats,
    recent: (await getJson('/sessions/recent')),
  })
  const busFor = (clientJobId: string) => mocks.emitDisplay.mock.calls.filter(([e]) => e?.data?.clientJobId === clientJobId).map(([e]) => e.type)
  return { runtime, thread, conversation, get, getJson, post, waitEnd, lists, busFor }
}
const threadAsk = (query: string, extra: Record<string, unknown> = {}) =>
  ({ clientJobId: randomUUID(), generation: 1, query, model: 'opus', source: 'web', cosThread: true, ...extra })

describe('a chat sent with cosThread stays in the thread', () => {
  it('takes no number, touches no list or the display bus, and lands in the thread with its whole answer', async () => {
    const h = await harness()
    // Control: a plain web Ask is numbered, listed and on the bus, as today.
    const plainId = randomUUID()
    const plain = await h.post('/query-jobs', { clientJobId: plainId, generation: 1, query: 'ok plain', model: 'opus', source: 'web' })
    expect(plain.status).toBe(202)
    await h.waitEnd(plain.body.job.jobId)
    expect(h.busFor(plainId)).toEqual(['start', 'done'])
    // The plain web Ask's own turn says so (the timeline's surface), recorded per turn at its admission.
    expect(h.conversation.getSessionRaw(plain.body.job.sessionId)?.webAsks).toEqual([`${plain.body.job.messageEra}:${plain.body.job.globalMsgNum}`])
    const { serverTimelineSources } = await import('./cos-thread-timeline-sources.js')
    expect(serverTimelineSources().liveMessages!().map(m => [m.query, m.surface])).toEqual([['ok plain', 'web']])
    const before = await h.lists()
    expect(before.rows).toHaveLength(1)

    const ask = threadAsk('long question')
    const admitted = await h.post('/query-jobs', ask)
    expect(admitted.status).toBe(202)
    expect(admitted.body.job.globalMsgNum).toBeUndefined()
    const done = await h.waitEnd(admitted.body.job.jobId)
    expect(done.status).toBe('completed')
    expect(h.conversation.isCosThreadSession(done.sessionId)).toBe(true)
    expect(h.conversation.getSessionRaw(done.sessionId)?.webAsks).toBeUndefined()
    expect(await h.lists()).toEqual(before)
    expect(h.busFor(ask.clientJobId)).toEqual([])

    const history = await h.getJson('/cos-thread/history')
    expect(history.entries.map((e: any) => e.id)).toEqual([`t:${ask.clientJobId}`])   // the plain Ask is not in the thread
    const entry = history.entries.at(-1)
    expect(entry).toMatchObject({ id: `t:${ask.clientJobId}`, question: 'long question', status: 'completed', full: false,
      answerChars: LONG.length, clientJobId: ask.clientJobId, generation: 1 })
    expect(entry.answer).toHaveLength(2000)
    const whole = await h.getJson(`/cos-thread/entry/t:${ask.clientJobId}`)
    expect(whole).toMatchObject({ source: 'ledger', entry: { full: true, answerChars: LONG.length } })
    expect(whole.entry.answer).toBe(LONG)

    // A follow-up continues the same thread conversation, still in no list and not on the bus.
    const next = threadAsk('ok follow-up', { sessionId: done.sessionId })
    const second = await h.post('/query-jobs', next)
    expect(second.body.job.sessionId).toBe(done.sessionId)
    await h.waitEnd(second.body.job.jobId)
    expect(await h.lists()).toEqual(before)
    expect(h.busFor(next.clientJobId)).toEqual([])
    expect((await h.getJson('/cos-thread?threadOnly=1')).next).toMatchObject({ mode: 'continue', sessionId: done.sessionId })

    // Never archived: the snapshot route, clear and end all leave the thread conversation out.
    const snap = await h.post('/archive/now', {})
    expect(snap.body.archived).toBe(1)
    await h.conversation.endSession(done.sessionId)
    const other = threadAsk('ok in another thread conversation')
    const otherDone = await h.waitEnd((await h.post('/query-jobs', other)).body.job.jobId)
    expect(otherDone.sessionId).not.toBe(done.sessionId)
    await h.conversation.clearSession(otherDone.sessionId)
    expect(h.conversation.getSessionRaw(otherDone.sessionId)).toBeUndefined()
    const archive = join(root, 'archive')
    const text = existsSync(archive) ? readdirSync(archive).filter(f => f.endsWith('.json')).map(f => readFileSync(join(archive, f), 'utf8')).join('') : ''
    expect(text).toContain(plain.body.job.sessionId)
    expect(text).not.toContain(done.sessionId)
    expect(text).not.toContain(otherDone.sessionId)
    expect(text).not.toContain('long question')
    expect(text).not.toContain('another thread conversation')
  })

  it('refuses the marker off the web, a thread conversation named by anything else, and a marker that is not true', async () => {
    const h = await harness()
    const ask = threadAsk('ok first')
    const done = await h.waitEnd((await h.post('/query-jobs', ask)).body.job.jobId)
    const bad = [
      [{ clientJobId: randomUUID(), generation: 1, query: 'ok glasses', model: 'opus', cosThread: true }, 400, 'cos_thread_web_only'],
      [{ clientJobId: randomUUID(), generation: 1, query: 'ok glasses', model: 'opus', sessionId: done.sessionId }, 409, 'thread_session_web_only'],
      [{ clientJobId: randomUUID(), generation: 1, query: 'ok plain', model: 'opus', source: 'web', sessionId: done.sessionId }, 409, 'thread_session_web_only'],
      [{ clientJobId: randomUUID(), generation: 1, query: 'ok plain', model: 'opus', source: 'web', cosThread: 'yes' }, 400, 'invalid_cos_thread'],
    ] as const
    for (const [body, status, code] of bad) {
      const out = await h.post('/query-jobs', body)
      expect(out.status, code).toBe(status)
      expect(out.body.error.code, code).toBe(code)
    }
    // Drop it off: no thread, so no thread Ask (Q1). Nothing is created.
    process.env.COS_DROP_IT = '0'
    const sessionsBefore = h.conversation.getRecentSessions(24 * 3600_000).length
    const off = await h.post('/query-jobs', threadAsk('ok while off'))
    expect([off.status, off.body.error.code]).toEqual([409, 'cos_thread_off'])
    expect(h.conversation.getRecentSessions(24 * 3600_000).length).toBe(sessionsBefore)
    expect((await h.getJson('/cos-thread/history')).entries.map((e: any) => e.question)).not.toContain('ok while off')
    process.env.COS_DROP_IT = '1'
    // A thread Ask naming an ordinary conversation never runs in it: it gets a thread conversation of its own.
    const plain = h.conversation.createSession()
    const odd = await h.post('/query-jobs', threadAsk('ok aimed at a plain one', { sessionId: plain }))
    expect(odd.status).toBe(202)
    expect(odd.body.job.sessionId).not.toBe(plain)
    expect(h.conversation.isCosThreadSession(odd.body.job.sessionId)).toBe(true)
    expect(h.conversation.isCosThreadSession(plain)).toBe(false)
  })

  it('a replay is one turn and one conversation; a failure keeps the question; a Retry is the same entry', async () => {
    const h = await harness()
    const ask = threadAsk('fail first try')
    const admitted = await h.post('/query-jobs', ask)
    const replay = await h.post('/query-jobs', ask)
    expect(replay.body.job.jobId).toBe(admitted.body.job.jobId)
    const failed = await h.waitEnd(admitted.body.job.jobId)
    expect(failed.status).toBe('failed')
    let entries = (await h.getJson('/cos-thread/history')).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ question: 'fail first try', status: 'failed', answer: 'partial words', generation: 1 })
    expect(h.conversation.getSessionRaw(failed.sessionId)?.exchanges ?? []).toEqual([])
    expect(h.busFor(ask.clientJobId)).toEqual([])
    // Retry: the next generation of the same clientJobId (the model now answers).
    mocks.callModelStreaming.mockImplementation((q: string, s: string, c: any) => scriptedRun('ok ' + q, s, c))
    const retry = await h.post('/query-jobs', { ...ask, generation: 2 })
    expect(retry.status).toBe(202)
    expect(retry.body.job.sessionId).toBe(failed.sessionId)
    await h.waitEnd(retry.body.job.jobId, 2)
    entries = (await h.getJson('/cos-thread/history')).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ status: 'completed', answer: ANSWER, full: true, generation: 2 })
  })

  it('an open pane sees a chat end through after= (updated), replaced by id', async () => {
    const h = await harness()
    const ask = threadAsk('ok watched')
    const admitted = await h.post('/query-jobs', ask)
    await h.waitEnd(admitted.body.job.jobId)
    // A pane that read the history while the chat ran: model its cursor as one taken before the answer row existed.
    const page = await h.getJson('/cos-thread/history')
    const [place] = page.newest.slice(3).split('.')
    const out = await h.getJson(`/cos-thread/history?after=c1.${place}.0`)
    expect(out.entries).toEqual([])
    expect(out.updated.map((e: any) => [e.id, e.status])).toEqual([[`t:${ask.clientJobId}`, 'completed']])
    expect((await h.getJson(`/cos-thread/history?after=${page.newest}`)).updated).toEqual([])
  })

  it('surface is per turn (Q1 T16, lead 13:0x): a web turn, then a glasses turn and a Mac turn in the same conversation, gives one web stamp and two absents', async () => {
    const h = await harness()
    const web = await h.post('/query-jobs', { clientJobId: randomUUID(), generation: 1, query: 'ok on the web', model: 'opus', source: 'web' })
    expect(web.status).toBe(202)
    await h.waitEnd(web.body.job.jobId)
    const { sessionId, globalMsgNum, messageEra } = web.body.job
    // The glasses and the Mac continue that conversation with their own numbers and no source (they send nothing that
    // says which they are).
    for (const [n, query] of [[1, 'ok from the glasses'], [2, 'ok from the Mac']] as const) {
      const turn = await h.post('/query-jobs', { clientJobId: randomUUID(), generation: 1, query, model: 'opus', sessionId, globalMsgNum: globalMsgNum + n, messageEra })
      expect(turn.status).toBe(202)
      await h.waitEnd(turn.body.job.jobId)
    }
    const { serverTimelineSources } = await import('./cos-thread-timeline-sources.js')
    const rows = serverTimelineSources().liveMessages!().filter(m => m.query.startsWith('ok '))
    expect(rows.map(m => [m.query, m.surface])).toEqual([['ok on the web', 'web'], ['ok from the glasses', undefined], ['ok from the Mac', undefined]])
    // A second web turn in the same conversation is stamped too; marking a turn twice keeps one entry.
    const again = await h.post('/query-jobs', { clientJobId: randomUUID(), generation: 1, query: 'ok on the web again', model: 'opus', source: 'web', sessionId })
    await h.waitEnd(again.body.job.jobId)
    h.conversation.markWebAsk(sessionId, messageEra, globalMsgNum)
    expect(h.conversation.getSessionRaw(sessionId)?.webAsks).toEqual([`${messageEra}:${globalMsgNum}`, `${messageEra}:${again.body.job.globalMsgNum}`])
    // The era is part of the turn's identity (Q1 T33), and only a positive whole number is ever recorded (Q1 T34).
    expect(h.conversation.isWebAsk(sessionId, messageEra, globalMsgNum)).toBe(true)
    expect(h.conversation.isWebAsk(sessionId, `${messageEra}-other`, globalMsgNum)).toBe(false)
    const listed = h.conversation.getSessionRaw(sessionId)!.webAsks!.length
    for (const bad of [0, -1, 1.5, Number.NaN]) h.conversation.markWebAsk(sessionId, messageEra, bad)
    h.conversation.markWebAsk('no-such-session', messageEra, 7)
    expect(h.conversation.getSessionRaw(sessionId)!.webAsks).toHaveLength(listed)
    expect(h.conversation.getSessionRaw('no-such-session')).toBeUndefined()
    // It keeps the newest WEB_ASKS_KEPT.
    for (let n = 1; n <= h.conversation.WEB_ASKS_KEPT + 5; n++) h.conversation.markWebAsk(sessionId, 'cap', n)
    const kept = h.conversation.getSessionRaw(sessionId)!.webAsks!
    expect([kept.length, kept[0], kept.at(-1)]).toEqual([h.conversation.WEB_ASKS_KEPT, 'cap:6', `cap:${h.conversation.WEB_ASKS_KEPT + 5}`])
  })

  it('candidate 4: a thread conversation\'s first chat carrying the digest gets the look-back line after the box; a continued one, a plain web Ask and a client flag do not', async () => {
    const h = await harness()
    const digest = { query: 'Summary carried over from earlier in this COS thread', response: 'Earlier: placeholder words.' }
    const refs = () => mocks.callModelStreaming.mock.calls.map(c => c[5])
    const first = await h.post('/query-jobs', threadAsk('ok first', { reference: digest }))
    expect(first.status).toBe(202)
    const done = await h.waitEnd(first.body.job.jobId)
    expect(done.status).toBe('completed')
    expect(refs()[0]).toEqual({ ...digest, lookback: true })
    // Printed after the quoted box, never inside it.
    const prompt = h.conversation.formatHistoryForPrompt([], [], refs()[0])
    const [box, after] = prompt.split(h.conversation.LOOKBACK_HEADER)
    expect(box).toContain('REFERENCED SOURCE DATA')
    expect(box).not.toContain('cos-thread/timeline')
    expect(after).toContain('/api/cos-thread/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD')
    expect(after).toContain('$COS_API_TOKEN')
    // A continued chat in that conversation: its reference passes as sent, so it costs nothing more.
    const again = await h.post('/query-jobs', threadAsk('ok again', { sessionId: done.sessionId, reference: digest }))
    await h.waitEnd(again.body.job.jobId)
    expect(refs()[1]).toEqual(digest)
    expect(h.conversation.formatHistoryForPrompt([], [], refs()[1])).not.toContain(h.conversation.LOOKBACK_HEADER)
    // A plain web Ask: unchanged, and a client cannot set the flag (admission rebuilds the reference).
    const plain = await h.post('/query-jobs', { clientJobId: randomUUID(), generation: 1, query: 'ok plain', model: 'opus', source: 'web', reference: { ...digest, lookback: true } })
    await h.waitEnd(plain.body.job.jobId)
    expect(refs()[2]).toEqual(digest)
    // A thread's first chat with no digest: nothing to put a line after.
    const bare = await h.post('/query-jobs', threadAsk('ok bare'))
    await h.waitEnd(bare.body.job.jobId)
    expect(refs()[3]).toBeUndefined()
    // A glasses chat that carries a reference (a recalled message), in a conversation of its own: unchanged.
    const glasses = await h.post('/query-jobs', { clientJobId: randomUUID(), generation: 1, query: 'ok glasses recall', model: 'opus', sessionId: plain.body.job.sessionId, globalMsgNum: plain.body.job.globalMsgNum + 1, messageEra: plain.body.job.messageEra, reference: digest })
    expect(glasses.status).toBe(202)
    await h.waitEnd(glasses.body.job.jobId)
    expect(refs()[4]).toEqual(digest)
    // A Work job, a routine, anything else: its conversation is not a thread conversation, so the reference passes as is.
    for (const sessionId of ['work0001', plain.body.job.sessionId, 'gone0001']) {
      expect(h.runtime.referenceForRun({ sessionId, reference: digest })).toBe(digest)
    }
    expect(h.runtime.referenceForRun({ sessionId: done.sessionId, reference: undefined })).toBeUndefined()
  })

  it('threadOnly: a thread whose conversation is not a thread one starts fresh with the digest; an older page continues as before', async () => {
    const h = await harness()
    // A turn the 7.0.37 page recorded in an ordinary (numbered) conversation.
    const sid = h.conversation.createSession()
    await h.post('/cos-thread/turn', { clientId: 'web-00000001', sessionId: sid, query: 'an older ask', answer: 'an older answer', messageNo: 7 })
    const old = await h.getJson('/cos-thread')
    expect(old.next).toMatchObject({ mode: 'continue', sessionId: sid })
    const fresh = await h.getJson('/cos-thread?threadOnly=1')
    expect(fresh.next).toMatchObject({ mode: 'fresh', reason: 'thread_only', sessionId: null })
    expect(fresh.next.digest).toContain('an older ask')
  })
})
