// 6.78.0 Messages steer through the REAL coordinator and store, with a fake runner that drives
// the job's SteerPort the way the Claude bridge does (compose, open, echoes, results). No
// model-router, no CLI: the session lock is injected (model-router reaches claude-bridge).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./conversation.js', () => ({ getOrCreateSession: () => 'steer-coordinator-session' }))

import { QueryJobCoordinator, QueryJobSteerLimitError, type QueryJobRunner, type QueryJobRunnerContext, type QueryJobSteerOptions } from './query-job-coordinator.js'
import { NodeQueryJobJournalStorage, QueryJobStore } from './query-job-store.js'
import { encodeUserLine, type SteerPort } from './claude-steer.js'
import { QueryJobGenerationMismatchError } from './query-job-store.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cos-steer-coord-'))
  roots.push(root)
  return root
}

const S = () => randomUUID()
const until = async (check: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** One run, as the bridge would drive it. */
interface FakeRun {
  ctx: QueryJobRunnerContext
  port?: SteerPort
  firstLine?: string
  lines: string[]
  /** The CLI replays a line. */
  echo: (steerId: string) => void
  /** Finish with an answer (the bridge's finalize). */
  answer: (text: string) => Promise<void>
}

function harness(options: { steer?: Partial<QueryJobSteerOptions>; providerTimeoutMs?: number; lock?: () => Promise<() => void>; wall?: { startedAt: number; wallMaxMs: number }; storage?: NodeQueryJobJournalStorage; sinkFails?: boolean } = {}) {
  const runs: FakeRun[] = []
  const runner: QueryJobRunner = async ctx => {
    const run: FakeRun = {
      ctx, port: ctx.steer, lines: [],
      echo: steerId => run.port?.events.onDelivered?.(steerId),
      answer: async text => {
        await ctx.callbacks.onAnswerReady(text)
        await ctx.callbacks.onDone({ text })
      },
    }
    runs.push(run)
    await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude', resolvedModel: 'opus' })
    await ctx.callbacks.onProviderProcess({ provider: 'claude', claudeRunId: `run-${runs.length}` })
    if (run.port) {
      const composed = run.port.drainForCompose()
      run.firstLine = composed.length ? `${ctx.request.query} + ${composed.map(s => s.text).join(' | ')}` : ctx.request.query
      run.port.open((line, _id) => { if (options.sinkFails) return false; run.lines.push(line); return true }, options.wall ?? { startedAt: Date.now(), wallMaxMs: 10 * 60_000 })
    } else {
      run.firstLine = ctx.request.query
    }
    await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  return {
    runs,
    make: async (root: string, bootId = 'boot-a') => {
      const store = new QueryJobStore({ root, bootId, ...(options.storage ? { storage: options.storage } : {}) })
      const coordinator = new QueryJobCoordinator(store, runner, {
        partialFlushMs: 0,
        ...(options.providerTimeoutMs ? { providerTimeoutMs: options.providerTimeoutMs } : {}),
        ...(options.lock ? { acquireSessionLock: options.lock } : {}),
        steer: { enabled: () => true, provider: () => 'claude', cliSupported: async () => true, ...options.steer },
      })
      await coordinator.init()
      return { store, coordinator }
    },
  }
}

function request(clientJobId = randomUUID(), generation = 1, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { clientJobId, generation, query: 'read the README', sessionId: 'session-steer-coord', activityToolMode: 'preview', steerable: true, ...extra }
}

async function started(h: ReturnType<typeof harness>, coordinator: QueryJobCoordinator, extra: Record<string, unknown> = {}, count = 1) {
  const { job } = await coordinator.submit(request(randomUUID(), 1, extra))
  await until(() => h.runs.length >= count && h.runs.at(-1)!.firstLine !== undefined)
  return { job, run: h.runs.at(-1)! }
}

describe('accepted, then delivered, then folded (the happy path)', () => {
  it('journals before it writes, writes one line, and folds on the result', async () => {
    const h = harness()
    const { coordinator, store } = await h.make(await tempRoot())
    const { job, run } = await started(h, coordinator)
    expect(run.port).toBeDefined()
    const steerId = S()
    const reply = await coordinator.steer(job.jobId, { generation: 1, steerId, text: 'Also check the tests.' })
    expect(reply).toEqual({ steerId, state: 'accepted', fallback: null, jobStatus: 'running' })
    expect(run.lines).toEqual([encodeUserLine(steerId, 'Also check the tests.')])
    run.echo(steerId)
    run.port!.events.onFolded?.([steerId])
    await run.answer('Read it; the tests pass.')
    const status = await coordinator.steerStatus(job.clientJobId, steerId)
    expect(status).toEqual({ steerId, state: 'folded', fallback: null, jobStatus: 'completed' })
    expect((await store.getSnapshot(job.jobId)).steers!.map(s => s.state)).toEqual(['folded'])
    // The run's port is closed once the job is terminal, whatever the bridge did.
    expect(run.port!.isClosed).toBe(true)
  })
})

describe('ST-2: the steer row is journaled before stdin', () => {
  it('a steer row that cannot be written never reaches stdin', async () => {
    class FailSteer extends NodeQueryJobJournalStorage {
      override append(root: string, day: string, line: string) {
        if (JSON.parse(line).type === 'steer') return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
        return super.append(root, day, line)
      }
    }
    const h = harness({ storage: new FailSteer() })
    const { coordinator } = await h.make(await tempRoot())
    const { job, run } = await started(h, coordinator)
    await expect(coordinator.steer(job.jobId, { generation: 1, steerId: S(), text: 'x' })).rejects.toThrow()
    expect(run.lines).toEqual([])
  })

  it('a crash right after the fsync leaves the steer accepted and no line written', async () => {
    let dieAfterSteer = false
    class DieAfter extends NodeQueryJobJournalStorage {
      override async append(root: string, day: string, line: string) {
        await super.append(root, day, line)
        if (dieAfterSteer && JSON.parse(line).type === 'steer') throw Object.assign(new Error('process died here'), { code: 'EKILLED' })
      }
    }
    const root = await tempRoot()
    const h = harness({ storage: new DieAfter() })
    const { coordinator } = await h.make(root)
    const { job, run } = await started(h, coordinator)
    const steerId = S()
    dieAfterSteer = true
    await expect(coordinator.steer(job.jobId, { generation: 1, steerId, text: 'x' })).rejects.toThrow()
    expect(run.lines).toEqual([])
    const reboot = new QueryJobStore({ root, bootId: 'boot-after' })
    await reboot.init()
    const found = await reboot.findSteer(job.clientJobId, steerId)
    expect(found?.steer.state).toBe('accepted')
    expect(found?.job.status).toBe('interrupted')
  })
})

describe('OO-2: the same steer id twice is one line', () => {
  it('a re-POST of the same id and text replays the state and writes nothing', async () => {
    const h = harness()
    const { coordinator } = await h.make(await tempRoot())
    const { job, run } = await started(h, coordinator)
    const steerId = S()
    const first = await coordinator.steer(job.jobId, { generation: 1, steerId, text: 'x' })
    const again = await coordinator.steer(job.jobId, { generation: 1, steerId, text: 'x' })
    expect(again).toEqual(first)
    expect(run.lines).toHaveLength(1)
    await expect(coordinator.steer(job.jobId, { generation: 1, steerId, text: 'other text' })).rejects.toMatchObject({ code: 'steer_identity_conflict' })
  })

  it('a known steer replays even with a stale generation (the lineage is looked up first)', async () => {
    const h = harness()
    const { coordinator } = await h.make(await tempRoot())
    const { job } = await started(h, coordinator)
    const steerId = S()
    await coordinator.steer(job.jobId, { generation: 1, steerId, text: 'x' })
    expect((await coordinator.steer(job.jobId, { generation: 7, steerId, text: 'x' })).state).toBe('accepted')
    await expect(coordinator.steer(job.jobId, { generation: 7, steerId: S(), text: 'y' })).rejects.toBeInstanceOf(QueryJobGenerationMismatchError)
  })
})

describe('what a steer cannot do', () => {
  it('too_late once the answer is ready or the job ended, with the follow-up fallback', async () => {
    const h = harness()
    const { coordinator } = await h.make(await tempRoot())
    const { job, run } = await started(h, coordinator)
    await run.answer('done')
    expect(await coordinator.steer(job.jobId, { generation: 1, steerId: S(), text: 'x' })).toMatchObject({ state: 'too_late', fallback: 'queue_follow_up', jobStatus: 'completed' })
    expect(run.lines).toEqual([])
  })

  it('a steer the port can no longer write (stdin closing) is journaled too_late and answered so', async () => {
    const h = harness({ sinkFails: true })
    const { coordinator, store } = await h.make(await tempRoot())
    const { job } = await started(h, coordinator)
    const steerId = S()
    expect(await coordinator.steer(job.jobId, { generation: 1, steerId, text: 'x' })).toMatchObject({ state: 'too_late', fallback: 'queue_follow_up', jobStatus: 'running' })
    expect((await store.getSnapshot(job.jobId)).steers!.map(s => s.state)).toEqual(['too_late'])
  })

  it('an ended job is too_late even when its run could never be steered (not unsupported)', async () => {
    const h = harness({ steer: { provider: () => 'codex' } })
    const { coordinator } = await h.make(await tempRoot())
    const { job, run } = await started(h, coordinator)
    await run.answer('done')
    expect((await coordinator.steer(job.jobId, { generation: 1, steerId: S(), text: 'x' })).state).toBe('too_late')
  })

  it('unsupported for a run that is not Claude, or not steerable, with no port at all', async () => {
    const h = harness({ steer: { provider: () => 'codex' } })
    const { coordinator } = await h.make(await tempRoot())
    const { job, run } = await started(h, coordinator)
    expect(run.port).toBeUndefined()
    expect(await coordinator.steer(job.jobId, { generation: 1, steerId: S(), text: 'x' })).toMatchObject({ state: 'unsupported', fallback: 'queue_follow_up' })
    for (const steer of [{ enabled: () => false }, { cliSupported: async () => false }]) {
      const h2 = harness({ steer })
      const { coordinator: c2 } = await h2.make(await tempRoot())
      const { run: r2 } = await started(h2, c2)
      expect(r2.port).toBeUndefined()
    }
    for (const extra of [{ steerable: undefined }, { dispatch: { restricted: true, tools: ['Read'] } }]) {
      const h3 = harness()
      const { coordinator: c3 } = await h3.make(await tempRoot())
      const { job: j3, run: r3 } = await started(h3, c3, extra)
      expect(r3.port, JSON.stringify(extra)).toBeUndefined()
      expect((await c3.steer(j3.jobId, { generation: 1, steerId: S(), text: 'x' })).state).toBe('unsupported')
    }
  })

  it('too_late near the wall clock or the coordinator deadline (max(10 s, 20% of wallMax))', async () => {
    const wall = harness({ wall: { startedAt: Date.now() - 55_000, wallMaxMs: 60_000 } })
    const a = await wall.make(await tempRoot())
    const ja = await started(wall, a.coordinator)
    expect((await a.coordinator.steer(ja.job.jobId, { generation: 1, steerId: S(), text: 'x' })).state).toBe('too_late')
    const deadline = harness({ providerTimeoutMs: 5_000 })
    const b = await deadline.make(await tempRoot())
    const jb = await started(deadline, b.coordinator)
    expect((await b.coordinator.steer(jb.job.jobId, { generation: 1, steerId: S(), text: 'x' })).state).toBe('too_late')
    expect(ja.run.lines.length + jb.run.lines.length).toBe(0)
  })

  it('at most 8 steers per job', async () => {
    const h = harness()
    const { coordinator } = await h.make(await tempRoot())
    const { job } = await started(h, coordinator)
    for (let i = 0; i < 8; i++) await coordinator.steer(job.jobId, { generation: 1, steerId: S(), text: `steer ${i}` })
    await expect(coordinator.steer(job.jobId, { generation: 1, steerId: S(), text: 'one too many' })).rejects.toBeInstanceOf(QueryJobSteerLimitError)
  })

  it('refuses a bad id, empty text and text over 4,000 characters', async () => {
    const h = harness()
    const { coordinator } = await h.make(await tempRoot())
    const { job } = await started(h, coordinator)
    await expect(coordinator.steer(job.jobId, { generation: 1, steerId: 'nope', text: 'x' })).rejects.toMatchObject({ code: 'invalid_steer_id' })
    await expect(coordinator.steer(job.jobId, { generation: 1, steerId: S(), text: '   ' })).rejects.toMatchObject({ code: 'invalid_steer_text' })
    await expect(coordinator.steer(job.jobId, { generation: 1, steerId: S(), text: 'x'.repeat(4_001) })).rejects.toMatchObject({ code: 'steer_text_too_large' })
  })
})

describe('steers sent before the run starts ride in the first line', () => {
  it('a held job (waiting for its session) takes them in its first line, journaled included', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const h = harness({ lock: async () => { await gate; return () => {} } })
    const { coordinator, store } = await h.make(await tempRoot())
    const { job } = await coordinator.submit(request())
    const steerId = S()
    expect((await coordinator.steer(job.jobId, { generation: 1, steerId, text: 'keep it short' })).state).toBe('accepted')
    open()
    await until(() => h.runs[0]?.firstLine !== undefined)
    expect(h.runs[0]!.firstLine).toBe('read the README + keep it short')
    expect(h.runs[0]!.lines).toEqual([])
    await until(() => false, 50).catch(() => {})
    expect((await store.getSnapshot(job.jobId)).steers!.map(s => s.state)).toEqual(['included'])
  })
})

describe('ST-3: carry-forward into generation + 1', () => {
  it('a Resume after an interrupt carries the steers the cut run did not apply; a canceled run carries none', async () => {
    const h = harness()
    const root = await tempRoot()
    const { coordinator, store } = await h.make(root)
    const clientJobId = randomUUID()
    const { job } = await coordinator.submit(request(clientJobId))
    await until(() => h.runs[0]?.firstLine !== undefined)
    const steerId = S()
    await coordinator.steer(job.jobId, { generation: 1, steerId, text: 'also the tests' })
    await coordinator.shutdown('server_shutdown')
    expect((await coordinator.steerStatus(clientJobId, steerId))).toMatchObject({ state: 'not_applied', fallback: null, jobStatus: 'interrupted' })

    const next = harness()
    const second = await next.make(root, 'boot-b')
    await until(() => false, 1).catch(() => {})
    const { job: gen2 } = await second.coordinator.submit({ ...request(clientJobId, 2), sessionId: 'session-steer-coord-2' })
    await until(() => next.runs[0]?.firstLine !== undefined)
    expect(next.runs[0]!.firstLine).toBe('read the README + also the tests')
    await until(() => false, 50).catch(() => {})
    const carried = (await second.store.getSnapshot(gen2.jobId)).steers
    expect(carried).toEqual([expect.objectContaining({ steerId, state: 'included', carriedFrom: 1 })])
    expect(await second.coordinator.steerStatus(clientJobId, steerId)).toMatchObject({ state: 'included', jobStatus: 'running' })

    // Canceled: nothing carried.
    const c = harness()
    const cr = await c.make(await tempRoot())
    const cid = randomUUID()
    const { job: cj } = await cr.coordinator.submit(request(cid))
    await until(() => c.runs[0]?.firstLine !== undefined)
    await cr.coordinator.steer(cj.jobId, { generation: 1, steerId: S(), text: 'never carried' })
    await cr.coordinator.cancel(cj.jobId, 1)
    await cr.coordinator.submit({ ...request(cid, 2), sessionId: 'session-cancel-2' })
    await until(() => c.runs[1]?.firstLine !== undefined)
    expect(c.runs[1]!.firstLine).toBe('read the README')
    void store
  })
})

describe('ST-5: the answer checkpoint survives a deadline in steer mode', () => {
  it('a run past its first whole answer that hits the coordinator deadline completes with it', async () => {
    const h = harness({ providerTimeoutMs: 1_000 })
    const { coordinator, store } = await h.make(await tempRoot())
    const { job } = await coordinator.submit(request())
    await until(() => h.runs[0]?.firstLine !== undefined)
    const run = h.runs[0]!
    // A steer the CLI had not folded when the first result came: the bridge checkpoints.
    const steerId = S()
    // The deadline cut-off would refuse a steer this close to the deadline, so journal it directly.
    await store.appendSteer(job.jobId, { steerId, state: 'accepted', text: 'x', create: true })
    run.ctx.callbacks.onChunk('The whole answer.')
    run.port!.events.onCheckpoint?.('The whole answer.')
    run.ctx.callbacks.onChunk('\n\nhalf of a second')
    await until(() => false, 1_300).catch(() => {})
    await until(() => h.runs.length > 0)
    const snapshot = await store.getSnapshot(job.jobId)
    expect(snapshot).toMatchObject({ status: 'completed', response: 'The whole answer.' })
    expect((await coordinator.steerStatus(job.clientJobId, steerId)).state).toBe('not_applied')
  })
})
