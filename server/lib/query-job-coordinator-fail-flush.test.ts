// 7.0.57: a job that fails keeps every character of its partial answer. failActive used to clear the pending flush
// timer without flushing, so text that arrived inside the flush window was lost on a failure (the thread shows a failed
// chat's partial). By execution, with a flush window far longer than the test, so only the failure can flush it.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./conversation.js', () => ({ getOrCreateSession: () => 'test-conversation' }))
vi.mock('./work-orchestrator/usage-events.js', () => ({ noteJobProviderLimit: () => {}, noteJobAnswered: () => {} }))

import { QueryJobCoordinator } from './query-job-coordinator.js'
import { QueryJobStore } from './query-job-store.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function failAfter(chunks: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'cos-fail-flush-')); roots.push(root)
  const coordinator = new QueryJobCoordinator(new QueryJobStore({ root, bootId: randomUUID() }), async ctx => {
    await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'cursor' })
    for (const chunk of chunks) ctx.callbacks.onChunk(chunk)
    await ctx.callbacks.onError('Cursor stopped after 3 minutes with no progress while it was waiting on a sub-agent. Ask again.')
  }, { resolveSessionId: () => 'resolved-session', partialFlushMs: 600_000, partialFlushChars: 1_000_000 })
  await coordinator.init()
  const job = await coordinator.submit({ clientJobId: randomUUID(), generation: 1, query: 'hello', activityToolMode: 'preview', model: 'cursor-grok' })
  const deadline = Date.now() + 3000
  while ((await coordinator.getSnapshot(job.job.jobId)).status !== 'failed' && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  return coordinator.getSnapshot(job.job.jobId)
}

it('a failure inside the flush window keeps the unflushed partial answer', async () => {
  const snapshot = await failAfter(['Reading ', 'the meeting now.'])
  expect(snapshot.status).toBe('failed')
  expect(snapshot.partialText).toBe('Reading the meeting now.')
})

it('the failed job keeps the plain reason as its error message', async () => {
  const snapshot = await failAfter(['x'])
  expect(snapshot.error?.message).toBe('Cursor stopped after 3 minutes with no progress while it was waiting on a sub-agent. Ask again.')
  expect(snapshot.error?.code).toBe('query_job_failed')
})

it('a failure with no partial text stays empty (nothing invented)', async () => {
  const snapshot = await failAfter([])
  expect(snapshot.partialText).toBe('')
})
