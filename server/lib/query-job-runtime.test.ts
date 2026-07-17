import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callModelStreaming: vi.fn(),
  emitDisplay: vi.fn(),
  resolveAttachments: vi.fn(),
  associate: vi.fn(),
  findExchanges: vi.fn(),
  reconcileExchange: vi.fn(),
  removeExchanges: vi.fn(),
  flushConversation: vi.fn(),
  exchanges: [] as Array<Record<string, unknown>>,
}))

vi.mock('./model-router.js', () => ({
  callModelStreaming: mocks.callModelStreaming,
  acquireModelSessionRunLock: vi.fn(async () => () => {}),
}))
vi.mock('./display-bus.js', () => ({ emitDisplay: mocks.emitDisplay }))
vi.mock('./query-attachments.js', () => ({ resolveQueryAttachments: mocks.resolveAttachments }))
vi.mock('./media-store.js', () => ({ getMediaStore: () => ({ associate: mocks.associate }) }))
vi.mock('./conversation.js', () => ({
  getOrCreateSession: (requested?: string) => requested ?? 'runtime-session',
  findExchangesByJobIdentity: mocks.findExchanges,
  reconcileExchangeByJobIdentity: mocks.reconcileExchange,
  removeExchangesByJobIdentity: mocks.removeExchanges,
  flushConversationToDisk: mocks.flushConversation,
}))

const requestRef = {
  id: `m_${'1'.repeat(24)}`,
  kind: 'user_photo' as const,
  mime: 'image/jpeg' as const,
  width: 100,
  height: 100,
  createdAt: '2026-07-17T12:00:00.000Z',
}
const outputRef = {
  id: `m_${'2'.repeat(24)}`,
  kind: 'generated_visual' as const,
  mime: 'image/png' as const,
  width: 288,
  height: 144,
  createdAt: '2026-07-17T12:00:01.000Z',
}

let root = ''

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'cos-public-query-runtime-'))
  process.env.COS_DURABLE_QUERY_JOBS = '1'
  process.env.COS_QUERY_JOB_DIR = root

  mocks.resolveAttachments.mockImplementation(async (body: Record<string, unknown>) => {
    const hasAttachment = Array.isArray(body.attachmentIds) || Array.isArray(body.images)
    return {
      ids: hasAttachment ? [requestRef.id] : [],
      refs: hasAttachment ? [requestRef] : [],
      inputs: Array.isArray(body.attachmentIds)
        ? [{ path: '/provider-only/test-image.jpg', attachment: requestRef, deleteAfterRun: false }]
        : [],
    }
  })
  mocks.associate.mockResolvedValue(undefined)
  mocks.exchanges.length = 0
  mocks.findExchanges.mockImplementation((_sessionId: string, identity: { clientJobId: string; generation: number }) => (
    mocks.exchanges.filter(exchange => exchange.clientJobId === identity.clientJobId
      && exchange.generation === identity.generation)
  ))
  mocks.reconcileExchange.mockImplementation((
    _sessionId: string,
    identity: { clientJobId: string; generation: number },
    role: 'user' | 'assistant',
    content: string,
    globalMsgNum?: number,
    attachments?: unknown[],
  ) => ({
    exchange: (() => {
      const matching = mocks.exchanges.filter(exchange => exchange.role === role
        && exchange.clientJobId === identity.clientJobId
        && exchange.generation === identity.generation)
      const exchange = matching[0] ?? { role, timestamp: Date.now(), ...identity }
      Object.assign(exchange, { content, globalMsgNum, attachments })
      if (matching.length === 0) mocks.exchanges.push(exchange)
      for (const duplicate of matching.slice(1)) mocks.exchanges.splice(mocks.exchanges.indexOf(duplicate), 1)
      return exchange
    })(),
    created: !mocks.exchanges.some(exchange => exchange.role === role
      && exchange.clientJobId === identity.clientJobId
      && exchange.generation === identity.generation),
  }))
  mocks.removeExchanges.mockImplementation((_sessionId: string, identity: { clientJobId: string; generation: number }) => {
    const before = mocks.exchanges.length
    for (let index = mocks.exchanges.length - 1; index >= 0; index--) {
      const exchange = mocks.exchanges[index]
      if (exchange.clientJobId === identity.clientJobId && exchange.generation === identity.generation) {
        mocks.exchanges.splice(index, 1)
      }
    }
    return before - mocks.exchanges.length
  })
  mocks.callModelStreaming.mockImplementation(async (
    _query: string,
    sessionId: string,
    callbacks: Record<string, (...args: any[]) => unknown>,
    _model: unknown,
    _images: unknown,
    _reference: unknown,
    _globalMsgNum: unknown,
    options: Record<string, unknown>,
  ) => {
    await callbacks.onStart?.('codex-frontier', sessionId, undefined, {})
    await callbacks.onProviderProcess?.({
      provider: 'codex',
      runId: 'public-codex-run-1',
      clientJobId: options.clientJobId,
      generation: options.generation,
    })
    callbacks.onChunk?.('durable ')
    await callbacks.onAnswerReady?.('durable answer')
    await callbacks.onDone?.('durable answer', 'codex-frontier', undefined, {
      codexRunId: 'public-codex-run-1',
      outputAttachments: [outputRef],
      outputImageStats: { published: 2, attached: 1, rejected: 1 },
    })
    return sessionId
  })
})

afterEach(async () => {
  delete process.env.COS_DURABLE_QUERY_JOBS
  delete process.env.COS_QUERY_JOB_DIR
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
})

async function waitForCompleted(read: () => Promise<{ status: string }>): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if ((await read()).status === 'completed') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('runtime job did not complete')
}

describe('public durable query runtime', () => {
  it('persists provider ownership and terminal output independently of the display subscriber', async () => {
    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    const clientJobId = randomUUID()
    const prepared = await runtime.preparePublicDurableQueryAdmission({
      clientJobId,
      generation: 1,
      query: 'analyze the attached image',
      sessionId: 'runtime-session',
      model: 'codex-frontier',
      globalMsgNum: 12,
      images: ['base64 bytes must not enter the journal'],
    })
    const admission = await runtime.queryJobCoordinator.submit(prepared)
    await waitForCompleted(() => runtime.queryJobCoordinator.getSnapshot(admission.job.jobId))

    const snapshot = await runtime.queryJobCoordinator.getSnapshot(admission.job.jobId)
    expect(snapshot).toMatchObject({
      status: 'completed',
      clientJobId,
      generation: 1,
      provider: 'codex',
      resolvedModel: 'codex-frontier',
      codexRunId: 'public-codex-run-1',
      response: 'durable answer',
      attachments: [requestRef, outputRef],
      outputImageStats: { published: 2, attached: 1, rejected: 1 },
    })
    const execution = await runtime.queryJobStore.getExecution(admission.job.jobId)
    expect(execution.request).not.toHaveProperty('images')
    expect(JSON.stringify(execution.request)).not.toContain('base64 bytes')
    expect(JSON.stringify(execution.request)).not.toContain('/provider-only/')
    expect(mocks.associate).toHaveBeenCalledWith([requestRef.id], {
      sessionId: 'runtime-session',
      globalMsgNum: 12,
    })
    expect(mocks.emitDisplay).toHaveBeenCalledWith(expect.objectContaining({
      type: 'done',
      data: expect.objectContaining({ clientJobId, generation: 1, text: 'durable answer' }),
    }))
    expect(mocks.reconcileExchange).toHaveBeenCalledTimes(2)
    expect(mocks.flushConversation).toHaveBeenCalledTimes(1)
    expect(mocks.callModelStreaming.mock.calls[0][7]).toMatchObject({
      clientJobId,
      generation: 1,
    })
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })

  it('repairs a completed journal whose conversation projection was lost in a crash', async () => {
    const { QueryJobStore } = await import('./query-job-store.js')
    const clientJobId = randomUUID()
    const seed = new QueryJobStore({ root, bootId: 'crashed-after-terminal' })
    const admitted = await seed.admit({
      clientJobId,
      generation: 1,
      query: 'recover this canonical turn',
      sessionId: 'runtime-session',
      globalMsgNum: 22,
    })
    await seed.markStarting(admitted.job.jobId)
    await seed.markRunning(admitted.job.jobId, { provider: 'codex' })
    await seed.markAnswerReady(admitted.job.jobId, 'recovered answer')
    await seed.complete(admitted.job.jobId, { text: 'recovered answer', provider: 'codex' })
    mocks.exchanges.push(
      { role: 'user', content: 'wrong bridge prompt', clientJobId, generation: 1 },
      {
        role: 'assistant',
        content: 'partial bridge answer',
        attachments: [outputRef],
        clientJobId,
        generation: 1,
      },
    )

    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    expect(mocks.exchanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'recover this canonical turn', clientJobId, generation: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: 'recovered answer',
        attachments: [outputRef],
        clientJobId,
        generation: 1,
      }),
    ]))
    expect(JSON.stringify(mocks.exchanges)).not.toContain('wrong bridge prompt')
    expect(JSON.stringify(mocks.exchanges)).not.toContain('partial bridge answer')
    expect(mocks.flushConversation).toHaveBeenCalled()
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })

  it('finishes and projects an answer-ready journal after a crash without rerunning the provider', async () => {
    const { QueryJobStore } = await import('./query-job-store.js')
    const clientJobId = randomUUID()
    const seed = new QueryJobStore({ root, bootId: 'crashed-during-answer-postprocess' })
    const admitted = await seed.admit({
      clientJobId,
      generation: 1,
      query: 'finish my committed reply',
      sessionId: 'runtime-session',
      messageEra: 'era-answer-ready',
      globalMsgNum: 23,
    })
    await seed.markStarting(admitted.job.jobId)
    await seed.markRunning(admitted.job.jobId, { provider: 'claude', resolvedModel: 'opus' })
    await seed.updateLinkage(admitted.job.jobId, { provider: 'claude', claudeRunId: 'committed-run' })
    await seed.markAnswerReady(admitted.job.jobId, 'committed before restart')

    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    expect(await runtime.queryJobCoordinator.getSnapshot(admitted.job.jobId)).toMatchObject({
      status: 'completed',
      response: 'committed before restart',
      messageEra: 'era-answer-ready',
      provider: 'claude',
      claudeRunId: 'committed-run',
    })
    expect(mocks.callModelStreaming).not.toHaveBeenCalled()
    expect(mocks.exchanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'finish my committed reply', clientJobId, generation: 1 }),
      expect.objectContaining({ role: 'assistant', content: 'committed before restart', clientJobId, generation: 1 }),
    ]))
    expect(mocks.flushConversation).toHaveBeenCalled()
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })

  it('removes bridge-written turns when a crash leaves the journal nonterminal', async () => {
    const { QueryJobStore } = await import('./query-job-store.js')
    const clientJobId = randomUUID()
    const seed = new QueryJobStore({ root, bootId: 'crashed-before-terminal' })
    const admitted = await seed.admit({
      clientJobId,
      generation: 1,
      query: 'must not survive interrupted work',
      sessionId: 'runtime-session',
    })
    await seed.markStarting(admitted.job.jobId)
    mocks.exchanges.push(
      { role: 'user', content: 'must not survive interrupted work', clientJobId, generation: 1 },
      { role: 'assistant', content: 'bridge wrote this before crash', clientJobId, generation: 1 },
    )

    const runtime = await import('./query-job-runtime.js')
    await runtime.initQueryJobRuntime()
    expect((await runtime.queryJobCoordinator.getSnapshot(admitted.job.jobId)).status).toBe('interrupted')
    expect(mocks.exchanges).toEqual([])
    expect(mocks.removeExchanges).toHaveBeenCalled()
    expect(mocks.flushConversation).toHaveBeenCalled()
    await runtime.shutdownQueryJobRuntime('test_shutdown')
  })
})
