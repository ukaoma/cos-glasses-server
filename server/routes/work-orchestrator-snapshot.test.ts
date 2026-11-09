import express from 'express'
import type { Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkOrchestratorRouter, ORCHESTRATOR_BODY_BYTES, type WorkOrchestratorDeps } from './work-orchestrator.js'
import type { TaskBoardRow } from '../lib/task-store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '../lib/work-orchestrator/snapshot.js'
import { UsageMonitor } from '../lib/work-orchestrator/usage.js'
import type { OrchestratorParts } from '../lib/work-orchestrator/runtime.js'
import { readAskWorkPlanInput } from './ask-work-plan.js'

const now = Date.parse('2026-11-06T12:00:00Z')
const serverInstanceId = '11111111-1111-4111-8111-111111111111'
const workID = 'task:quilt:aaaaaaaaaaaa', revision = 'b'.repeat(64)
const sessionID = 'claude:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const task = { id: 'aaaaaaaaaaaa', domain: 'quilt', title: 'Review design', text: 'Review design', checked: false, workRevision: revision } as TaskBoardRow
const snapshot = () => ({ version: 1, controlVersion: '0.5.375', sentAt: now / 1000,
  links: [{ sessionID, workID, at: now / 1000 }], receipts: [],
  live: { checkedAt: now / 1000, rows: [{ id: sessionID, title: 'Design', summary: '', status: 'idle', busy: false, waitingOnUser: false, appOwned: true }] } })
const body = () => ({ workID, revision, serverInstanceId, snapshot: snapshot() })
const servers: Server[] = []
const scratch: string[] = []
afterEach(() => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); server.close() }
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
async function setup(given: Partial<WorkOrchestratorDeps> = {}) {
  const putSnapshot = vi.fn(), input = vi.fn(async () => { throw new Error('discovery must never run') }),
    usage = vi.fn(async () => { throw new Error('usage must never refresh') }), board = vi.fn(async () => [task]), release = vi.fn()
  const responseClosed = vi.fn()
  const app = express(); app.use(express.json({ limit: 6_000_000 }))
  app.use((_req, res, next) => { res.on('close', responseClosed); next() })
  app.use('/api', (req, res, next) => req.header('X-Cos-Token') === 't' ? next() : res.sendStatus(401))
  app.use('/api', createWorkOrchestratorRouter({ putSnapshot, input, usage, board, now: () => now,
    serverInstanceId: () => serverInstanceId, admissions: () => true, lease: () => ({ release }), ...given }))
  const server = await new Promise<Server>(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) }); servers.push(server)
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/work/orchestrator/snapshot`
  const post = (value: unknown = body(), token = 't', signal?: AbortSignal) => fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Cos-Token': token }, body: JSON.stringify(value) })
  return { post, putSnapshot, input, usage, board, release, responseClosed }
}

it('publishes only a validated snapshot bound to this server and canonical revision, without discovery or usage calls', async () => {
  const s = await setup()
  expect((await s.post(body(), 'bad')).status).toBe(401); expect(s.putSnapshot).not.toHaveBeenCalled()
  const response = await s.post()
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ protocolVersion: 1, accepted: true, workID, revision, serverInstanceId })
  expect(s.putSnapshot).toHaveBeenCalledOnce()
  expect(s.putSnapshot.mock.calls[0]![0]).toMatchObject({ version: 1, receivedAt: now / 1000,
    links: [{ sessionID, workID }], live: { rows: [{ id: sessionID, appOwned: true }] } })
  expect(s.board).toHaveBeenCalledOnce(); expect(s.input).not.toHaveBeenCalled(); expect(s.usage).not.toHaveBeenCalled()
  expect(s.release).toHaveBeenCalledOnce()
})
it('7.0.13: leaves out a live row with a short Claude id, stores the rest and reports the count; a bad link still refuses', async () => {
  const s = await setup(), request = body() as any
  request.snapshot.live.rows.unshift({ ...request.snapshot.live.rows[0], id: 'claude:deadbeef' })
  const response = await s.post(request)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ protocolVersion: 1, accepted: true, workID, revision, serverInstanceId, droppedLiveRows: 1 })
  expect(s.putSnapshot).toHaveBeenCalledOnce(); expect(s.putSnapshot.mock.calls[0]![0].live.rows.map((r: any) => r.id)).toEqual([sessionID])
  const badLink = body() as any
  badLink.snapshot.links[0].sessionID = 'claude:deadbeef'
  const refused = await s.post(badLink)
  expect(refused.status).toBe(400); expect(await refused.json()).toEqual({ error: 'invalid_snapshot' })
  expect(s.putSnapshot).toHaveBeenCalledOnce()
})
it('rejects injected top-level capability fields and strips non-schema fields from paired-client evidence', async () => {
  const s = await setup()
  expect((await s.post({ ...body(), automatic: true })).status).toBe(400)
  expect((await s.post({ ...body(), newSessionProviders: ['claude'] })).status).toBe(400)
  const request = body() as any
  request.snapshot.receivedAt = now / 1000 + 99999
  request.snapshot.capabilities = { automatic: true }
  request.snapshot.live.rows[0].automatic = true; request.snapshot.live.rows[0].forkable = true
  expect((await s.post(request)).status).toBe(200)
  const saved = s.putSnapshot.mock.calls[0]![0]
  expect(saved.receivedAt).toBe(now / 1000); expect(saved).not.toHaveProperty('capabilities')
  expect(saved.live.rows[0]).not.toHaveProperty('automatic'); expect(saved.live.rows[0]).not.toHaveProperty('forkable')
  expect(saved.live.rows[0].appOwned).toBe(true)
})
it.each([
  [() => ({ ...body(), snapshot: { ...snapshot(), version: 9 } }), 400, 'invalid_snapshot'],
  [() => ({ ...body(), snapshot: { ...snapshot(), links: Array.from({ length: 4001 }, () => snapshot().links[0]) } }), 400, 'invalid_snapshot'],
  [() => ({ ...body(), snapshot: { ...snapshot(), unknown: 'a'.repeat(ORCHESTRATOR_BODY_BYTES) } }), 413, 'snapshot_too_large'],
  [() => ({ ...body(), revision: 'invalid' }), 400, 'invalid_snapshot_binding'],
  [() => ({ ...body(), serverInstanceId: 'invalid' }), 400, 'invalid_snapshot_binding'],
] as const)('refuses malformed or oversized uploads before reading the board', async (request, status, error) => {
  const s = await setup(), response = await s.post(request())
  expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error })
  expect(s.board).not.toHaveBeenCalled(); expect(s.putSnapshot).not.toHaveBeenCalled()
})
it.each([
  [[], 404, 'task_not_found'], [[task, task], 409, 'task_identity_ambiguous'],
  [[{ ...task, workRevision: 'c'.repeat(64) }], 409, 'revision_changed'],
  [[{ ...task, checked: true }], 409, 'task_complete'],
  [[{ ...task, workRevision: undefined }], 503, 'task_metadata_unavailable'],
] as const)('does not replace cache for missing, ambiguous, stale, completed or unversioned cards', async (rows, status, error) => {
  const s = await setup({ board: async () => [...rows] as TaskBoardRow[] }), response = await s.post()
  expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error })
  expect(s.putSnapshot).not.toHaveBeenCalled(); expect(s.input).not.toHaveBeenCalled(); expect(s.usage).not.toHaveBeenCalled()
  expect(s.release).toHaveBeenCalledOnce()
})
it('fails closed on absent or mismatched server identity without even reading the board', async () => {
  for (const [id, status, error] of [[null, 503, 'server_instance_unavailable'], ['22222222-2222-4222-8222-222222222222', 409, 'server_instance_changed']] as const) {
    const s = await setup({ serverInstanceId: () => id }), response = await s.post()
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error })
    expect(s.putSnapshot).not.toHaveBeenCalled(); expect(s.board).not.toHaveBeenCalled()
  }
})
it('rechecks identity and maintenance after the board await before replacing the cache', async () => {
  const id = vi.fn().mockReturnValueOnce(serverInstanceId).mockReturnValue('22222222-2222-4222-8222-222222222222')
  const s = await setup({ serverInstanceId: id })
  expect(await (await s.post()).json()).toMatchObject({ error: 'server_instance_changed' }); expect(s.putSnapshot).not.toHaveBeenCalled()
  const closed = await setup({ admissions: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) })
  expect(await (await closed.post()).json()).toMatchObject({ error: 'maintenance' }); expect(closed.putSnapshot).not.toHaveBeenCalled()
  expect(closed.release).toHaveBeenCalledOnce()
})
it('refuses maintenance before reads and returns safe errors on board/cache failure', async () => {
  const closed = await setup({ admissions: () => false })
  expect((await closed.post()).status).toBe(503); expect(closed.board).not.toHaveBeenCalled()
  for (const dependency of ['board', 'putSnapshot'] as const) {
    const s = await setup({ [dependency]: () => { throw new Error('private error') } })
    const response = await s.post(), text = await response.text()
    expect(response.status).toBe(503); expect(text).not.toContain('private error'); expect(s.release).toHaveBeenCalledOnce()
    expect(s.input).not.toHaveBeenCalled(); expect(s.usage).not.toHaveBeenCalled()
  }
})
it('holds the lease through a disconnected board read, then releases without writing the cache', async () => {
  let started!: () => void, finishBoard!: (rows: TaskBoardRow[]) => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const s = await setup({ board: async () => { started(); return new Promise(resolve => { finishBoard = resolve }) } })
  const cancel = new AbortController(), pending = s.post(body(), 't', cancel.signal).catch(() => undefined)
  await entered
  cancel.abort(); await pending
  await vi.waitFor(() => expect(s.responseClosed).toHaveBeenCalledOnce())
  expect(s.release).not.toHaveBeenCalled(); expect(s.putSnapshot).not.toHaveBeenCalled()
  finishBoard([task])
  await vi.waitFor(() => expect(s.release).toHaveBeenCalledOnce())
  expect(s.putSnapshot).not.toHaveBeenCalled(); expect(s.input).not.toHaveBeenCalled(); expect(s.usage).not.toHaveBeenCalled()
})
it('feeds the actual snapshot cache and downstream cached Ask runtime without provider probes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-snapshot-only-')); scratch.push(root)
  const path = join(root, 'snapshot.json'), store = new SnapshotStore(path)
  const s = await setup({ putSnapshot: value => store.put(value) })
  const request = body()
  request.snapshot.links = []; request.snapshot.live.rows = []
  expect((await s.post(request)).status).toBe(200)
  const restored = new SnapshotStore(path)
  expect(restored.get()).toEqual(store.get())
  const claude = vi.fn(async () => { throw new Error('must not probe') }), codex = vi.fn(async () => { throw new Error('must not probe') })
  const usage = new UsageMonitor({ probes: { claude, codex }, pollEnabled: false }), forPlan = vi.spyOn(usage, 'forPlan')
  const tags = { refresh: async () => ({ complete: true }), hits: () => [], skippedSessions: () => new Set(), pathOf: () => null } as unknown as OrchestratorParts['tags']
  const evidence = await readAskWorkPlanInput(workID, [], { usage, tags, snapshot: () => restored.get() })
  expect(evidence).toMatchObject({ workID, rows: [], logScanComplete: true })
  expect(evidence.snapshotAgeSec).not.toBeNull()
  expect(forPlan).not.toHaveBeenCalled(); expect(claude).not.toHaveBeenCalled(); expect(codex).not.toHaveBeenCalled()
  expect(s.input).not.toHaveBeenCalled(); expect(s.usage).not.toHaveBeenCalled()
})
