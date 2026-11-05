import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { consolidationModelRunner, inspectConsolidationCheckpoint } from './meeting-consolidation-run.js'
import { parseQueryJobRequest, requestFingerprint } from './query-job-types.js'
import type { callModelStreaming } from './model-router.js'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-run-')); dirs.push(root)
  const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', dir = join(root, runId); mkdirSync(dir)
  const checkpoint = join(dir, 'checkpoint.json')
  const artifact = (name: string, text: string) => {
    const path = join(dir, name); writeFileSync(path, text)
    return { path, sha256: createHash('sha256').update(text).digest('hex') }
  }
  const evidence = artifact('evidence.json', '{"checked":"originals, references, indexes and replay"}')
  const report = artifact('report.md', 'Merged 2 groups. Retained 1 uncertain boundary. Originals preserved.')
  const state = { version: 1, runId, state: 'working', inventoryComplete: true,
    items: [{ id: 'g2-mac-pair', state: 'pending' }, { id: 'overrun', state: 'retained', reason: 'uncertain boundary' }],
    evidence: [evidence], report,
    checks: { originals_preserved: true, references_valid: true, indexes_refreshed: true, idempotency: true } }
  const save = () => writeFileSync(checkpoint, JSON.stringify(state))
  const complete = () => { state.items[0].state = 'applied'; state.state = 'complete'; save() }
  return { root, runId, dir, checkpoint, state, save, complete, report }
}
function callbacks() { return { onStart: vi.fn(), onChunk: vi.fn(), onToolStatus: vi.fn(), onAnswerReady: vi.fn(async () => true), onDone: vi.fn(async (_text: string, _model?: unknown, _cli?: string, _metadata?: unknown) => true), onError: vi.fn() } }
async function run(f: ReturnType<typeof fixture>, base: typeof callModelStreaming, cb = callbacks(), extra: Record<string, unknown> = {}, signal?: AbortSignal) {
  await consolidationModelRunner(base, { root: f.root, workspace: f.root, runId: f.runId, ...extra })(
    'Consolidate my meetings', 'same-session', cb, 'opus', undefined, undefined, 1,
    { abortSignal: signal, sessionLockHeld: true, clientJobId: f.runId, generation: 1 })
  return cb
}
describe('resumable meeting cleanup', () => {
  it('continues a 15-minute timeout and a normal yield in ONE job, publishing only verified report', async () => {
    const f = fixture(), cb = callbacks(); let count = 0
    const base = vi.fn(async (...args: Parameters<typeof callModelStreaming>) => {
      count++; expect(args[1]).toBe('same-session'); expect(args[3]).toBe('opus')
      expect(args[7]).toMatchObject({ maintenancePass: true, sessionLockHeld: true, clientJobId: f.runId, generation: 1 })
      expect(args[0]).toContain(`pass ${count}`)
      // Detached bridges resolve on spawn. The runner must wait for callbacks.
      setTimeout(async () => {
        expect(cb.onDone).not.toHaveBeenCalled(); expect(cb.onAnswerReady).not.toHaveBeenCalled()
        if (count === 1) { f.save(); await args[2].onError('maintenance_pass_timeout') }
        else if (count === 2) { f.state.items[0].state = 'applied'; f.save(); await args[2].onAnswerReady?.('partial'); await args[2].onDone('partial', 'opus') }
        else { f.complete(); await args[2].onDone('provider prose is not the audit', 'opus') }
      }, 5)
      return 'same-session'
    })
    await run(f, base, cb)
    expect(count).toBe(3); expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onDone.mock.calls[0][0]).toBe(readFileSync(f.report.path, 'utf8'))
    expect(cb.onAnswerReady).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(join(f.dir, 'runner.json'), 'utf8')).pass).toBe(3)
  })
  it('does not trust completion prose, timestamps, or a model returning without a checkpoint', async () => {
    const f = fixture(), cb = callbacks()
    const base = vi.fn(async (...a: Parameters<typeof callModelStreaming>) => { await a[2].onDone('All done!', 'opus'); return '' })
    await expect(run(f, base, cb)).rejects.toMatchObject({ code: 'consolidation_stalled' })
    expect(base).toHaveBeenCalledTimes(3); expect(cb.onDone).not.toHaveBeenCalled()
  })
  it('rejects pending items, false verification, missing evidence, changed report and artifact escape', () => {
    const f = fixture(); f.complete()
    const inspect = () => inspectConsolidationCheckpoint(f.checkpoint, f.runId, [f.dir])
    expect(inspect().complete).toBe(true)
    f.state.items[0].state = 'pending'; f.save(); expect(inspect().complete).toBe(false)
    f.complete(); f.state.checks.idempotency = false; f.save(); expect(inspect().complete).toBe(false)
    f.state.checks.idempotency = true; f.save(); writeFileSync(f.report.path, 'forged'); expect(inspect().complete).toBe(false)
    const outside = join(f.root, 'outside'); writeFileSync(outside, 'outside')
    const link = join(f.dir, 'link'); symlinkSync(outside, link)
    f.state.report = { path: link, sha256: createHash('sha256').update('outside').digest('hex') }; f.save()
    expect(inspect().issue).toContain('outside')
    f.state.evidence = []; f.save(); expect(inspect().issue).toContain('missing')
  })
  it('stops honestly on a provider failure and does not substitute models', async () => {
    const f = fixture(), cb = callbacks()
    const base = vi.fn(async (...a: Parameters<typeof callModelStreaming>) => { await a[2].onError('provider quota'); return '' })
    await expect(run(f, base, cb)).rejects.toMatchObject({ code: 'consolidation_provider_failed' })
    expect(base).toHaveBeenCalledTimes(1); expect(cb.onDone).not.toHaveBeenCalled()
  })
  it('honors cancellation between passes and releases its cleanup fence', async () => {
    const f = fixture(), cb = callbacks(), abort = new AbortController()
    const base = vi.fn(async (...a: Parameters<typeof callModelStreaming>) => { f.save(); abort.abort(); await a[2].onError('cancelled'); return '' })
    await run(f, base, cb, {}, abort.signal)
    expect(base).toHaveBeenCalledTimes(1); expect(cb.onDone).not.toHaveBeenCalled()
    const f2 = fixture(); await run(f2, async (...a) => { f2.complete(); await a[2].onDone('finished', 'opus'); return '' })
  })
  it('refuses a concurrent cleanup without starting a second provider', async () => {
    const f = fixture(); let finish!: () => void
    const started = run(f, async (...a) => { finish = () => { f.complete(); void a[2].onDone('done', 'opus') }; return '' })
    const second = vi.fn(); await expect(run(fixture(), second)).rejects.toMatchObject({ code: 'consolidation_busy' })
    expect(second).not.toHaveBeenCalled(); finish(); await started
  })
  it('resumes its persisted pass budget and stops incomplete at overall safeguard', async () => {
    const f = fixture(); f.save()
    writeFileSync(join(f.dir, 'runner.json'), JSON.stringify({ version: 1, runId: f.runId, pass: 47, noProgress: 0, progress: 'missing', startedAt: Date.now() }))
    const cb = callbacks(), base = vi.fn(async (...a: Parameters<typeof callModelStreaming>) => { expect(a[0]).toContain('pass 48'); await a[2].onDone('still working', 'opus'); return '' })
    await expect(run(f, base, cb)).rejects.toMatchObject({ code: 'consolidation_budget_exhausted' })
    expect(base).toHaveBeenCalledTimes(1); expect(cb.onDone).not.toHaveBeenCalled()
  })
})

describe('cleanup admission identity', () => {
  const raw = { clientJobId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', generation: 1, query: 'cleanup', model: 'opus', sessionId: 'cleanup-session' }
  it('requires an explicit supported workflow and fingerprints its distinct execution policy', () => {
    const ordinary = parseQueryJobRequest(raw)
    const cleanup = parseQueryJobRequest({ ...raw, maintenanceWorkflow: 'meeting-consolidation-v1' })
    expect(ordinary).not.toHaveProperty('maintenanceWorkflow')
    expect(requestFingerprint(ordinary)).not.toBe(requestFingerprint(cleanup))
    expect(parseQueryJobRequest(cleanup)).toEqual(cleanup)
    for (const patch of [{ maintenanceWorkflow: 'unknown' }, { model: 'sonnet' }, { steerable: true }, { attachmentIds: ['image-1'] }]) {
      expect(() => parseQueryJobRequest({ ...raw, maintenanceWorkflow: 'meeting-consolidation-v1', ...patch })).toThrow()
    }
  })
})

it('uses the provider-allocated conversation for every subsequent pass', async () => {
  const f = fixture(); let pass = 0
  const base = vi.fn(async (...a: Parameters<typeof callModelStreaming>) => {
    pass++
    expect(a[1]).toBe(pass === 1 ? 'same-session' : 'allocated-session')
    a[2].onStart?.('opus', 'allocated-session')
    if (pass === 1) f.save(); else f.complete()
    await a[2].onDone('progress', 'opus')
    return 'allocated-session'
  })
  await run(f, base)
  expect(pass).toBe(2)
})

it('cannot complete by dropping an earlier pending inventory entry', async () => {
  const f = fixture(); let pass = 0
  const cb = callbacks()
  await run(f, async (...a) => {
    pass++
    if (pass === 1) f.save()
    else if (pass === 2) { f.state.items.shift(); f.state.state = 'complete'; f.save() }
    else {
      expect(a[0]).toContain('Restore previously inventoried entries')
      expect(cb.onDone).not.toHaveBeenCalled()
      f.state.items.unshift({ id: 'g2-mac-pair', state: 'applied' }); f.complete()
    }
    await a[2].onDone('progress', 'opus'); return 'same-session'
  }, cb)
  expect(pass).toBe(3); expect(cb.onDone).toHaveBeenCalledTimes(1)
})

it('bounds total evidence reads so a completed audit cannot monopolize the server', () => {
  const f = fixture(); f.complete()
  const bytes = Buffer.alloc(17 * 1024 * 1024, 65)
  f.state.evidence = ['large-a', 'large-b'].map(name => {
    const path = join(f.dir, name); writeFileSync(path, bytes)
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  f.save()
  const result = inspectConsolidationCheckpoint(f.checkpoint, f.runId, [f.dir])
  expect(result.complete).toBe(false); expect(result.issue).toContain('32 MiB total')
})
