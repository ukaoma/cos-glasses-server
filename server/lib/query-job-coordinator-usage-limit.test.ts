// 6.83.0: a plan-lane job that fails on its provider's usage limit tells the Work orchestrator, with the provider the
// job ran on and the limit text, so the next plan routes around it (canary C1 failure fallback). By execution.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('./conversation.js', () => ({ getOrCreateSession: () => 'test-conversation' }))
vi.mock('./work-orchestrator/runtime.js', () => ({ noteJobProviderLimit: (...args: unknown[]) => { seen.calls.push(args) } }))

import { QueryJobCoordinator } from './query-job-coordinator.js'
import { QueryJobStore } from './query-job-store.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('reports the failing provider, the provider_limit code and the limit text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cos-usage-limit-')); roots.push(root)
  const coordinator = new QueryJobCoordinator(new QueryJobStore({ root, bootId: randomUUID() }), async ctx => {
    await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
    throw Object.assign(new Error("You've hit your usage limit. Try again in 45 minutes."), { code: 'codex.error' })
  }, { resolveSessionId: () => 'resolved-session', partialFlushMs: 0 })
  await coordinator.init()
  const job = await coordinator.submit({ clientJobId: randomUUID(), generation: 1, query: 'hello', activityToolMode: 'preview', model: 'gpt-5' })
  const deadline = Date.now() + 3000
  while ((await coordinator.getSnapshot(job.job.jobId)).status !== 'failed' && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  expect((await coordinator.getSnapshot(job.job.jobId)).error).toMatchObject({ code: 'provider_limit' })
  expect(seen.calls).toEqual([['codex', 'provider_limit', "You've hit your usage limit. Try again in 45 minutes.", 'gpt-5', undefined]])
})
