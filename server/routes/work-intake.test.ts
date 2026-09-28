import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkIntakeRouter, intakeCardText, LINK_RACE_RETRIES } from './work-intake.js'
import { WorkIntakeStore } from '../lib/work-intake-store.js'
import { TaskBridgeError } from '../lib/task-store.js'

const servers: Server[] = [], stores: WorkIntakeStore[] = [], roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const meeting = { domain: 'quilt', month: '2026-09', filename: '2026-09-24_Bottle_QA.md', recordId: 'ops:quilt:2026-09:2026-09-24_Bottle_QA.md', title: 'Producer title' }
const id = (n: number) => 'wi_' + n.toString(16).padStart(32, '0')
const ask = (n = 1) => ({ id: id(n), kind: 'ask', status: 'ask', meeting, confidence: 0.9, model: 'jev-1.13.0', text: 'Fix the H1', owner: 'Ryan Hopkins', ownerIsMiles: false, pull: null })
const link = (n = 2) => ({ id: id(n), kind: 'link', status: 'suggested', meeting, confidence: 0.7, model: 'jev-1.13.0',
  task: { domain: 'quilt', id: 'a'.repeat(12), workIdentity: 'b'.repeat(12), text: 'Monitor launch' }, relation: 'advanced' })
const row = (extra: Record<string, unknown> = {}) => ({ domain: 'quilt', id: 'e'.repeat(12), workIdentity: 'b'.repeat(12), text: 'Monitor launch Monday (renamed)',
  workRevision: 'f'.repeat(64), meetingRefs: [] as Array<{ recordId: string }>, ...extra })

async function setup(overrides: Record<string, unknown> = {}, withStore = true) {
  let store: WorkIntakeStore | null = null
  if (withStore) { const r = mkdtempSync(join(tmpdir(), 'intake-route-')); roots.push(r); store = new WorkIntakeStore(r); stores.push(store) }
  const deps = {
    store, list: vi.fn(async () => [row()] as any), capabilities: vi.fn(async () => ({ linkWrites: true, cardCreation: true })),
    link: vi.fn(async () => {}), capture: vi.fn(async () => ({ created: true, id: 'c'.repeat(12), linked: true, checked: false, archived: false, delegated: false })),
    resolveMeeting: vi.fn(async () => ({ recordId: meeting.recordId, title: 'Canonical title' }) as any), ...overrides,
  }
  const app = express(); app.use(express.json({ limit: '1mb' }))
  app.use('/api', (req, res, next) => req.header('X-COS-Token') === 't' ? next() : res.sendStatus(401))
  app.use('/api', createWorkIntakeRouter(deps as any))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/work-intake`
  const call = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-COS-Token': 't', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { deps, store, base, call }
}

it('requires auth, and answers 503 without a store instead of failing the server', async () => {
  const s = await setup({}, false)
  expect((await fetch(s.base)).status).toBe(401)
  const res = await s.call('')
  expect(res.status).toBe(503)
  expect((await res.json()).error.code).toBe('work_intake_unavailable')
})

it('lists open items with counts and capabilities, and validates producer batches', async () => {
  const s = await setup()
  expect((await s.call('/items', { items: [ask(), link()] })).status).toBe(200)
  const body = await (await s.call('')).json()
  expect(body).toMatchObject({ schemaVersion: 1, counts: { ask: 1, suggested: 1, review: 0 }, capabilities: { linkWrites: true, cardCreation: true }, quarantined: 0 })
  expect(body.items).toHaveLength(2)
  expect((await s.call('/items', { items: [ask()], extra: 1 })).status).toBe(400)
  const partial = await s.call('/items', { items: [{ ...ask(3), kind: 'nope' }, ask(4)] })
  expect(partial.status).toBe(200)
  expect(await partial.json()).toEqual({ ok: true, inserted: 1, updated: 0, sticky: 0, rejected: [{ id: id(3), code: 'invalid_intake_item' }] })
  expect((await s.call('/items', { items: 'nope' })).status).toBe(400)
})

it('accepting a link finds the task by Work identity after a rename and uses the current text and revision', async () => {
  const s = await setup(); s.store!.upsert([link()])
  const res = await s.call(`/${id(2)}/resolve`, { action: 'accept' })
  expect(res.status).toBe(200)
  expect((await res.json()).item).toMatchObject({ status: 'accepted', resolution: { by: 'user', taskId: 'e'.repeat(12) } })
  expect(s.deps.link).toHaveBeenCalledExactlyOnceWith('quilt', 'e'.repeat(12), 'Monitor launch Monday (renamed)', 'f'.repeat(64),
    { domain: 'quilt', month: '2026-09', filename: meeting.filename, recordId: meeting.recordId, title: 'Canonical title' })
})

it.each([
  ['the meeting now resolves to another record', { resolveMeeting: vi.fn(async () => ({ recordId: 'ops:other', title: 'x' })) }, 'meeting_identity_changed'],
  ['the meeting cannot be read', { resolveMeeting: vi.fn(async () => { throw new Error('404') }) }, 'meeting_unavailable'],
  ['the task is gone', { list: vi.fn(async () => []) }, 'intake_task_changed'],
  ['the task already has eight links', { list: vi.fn(async () => [row({ meetingRefs: Array.from({ length: 8 }, (_, i) => ({ recordId: 'r' + i })) })]) }, 'meeting_links_full'],
  ['the board is read-only', { capabilities: vi.fn(async () => ({ linkWrites: false, cardCreation: false })) }, 'work_board_read_only'],
])('refuses a link accept when %s, and the item stays open', async (_name, overrides, code) => {
  const s = await setup(overrides); s.store!.upsert([link()])
  const res = await s.call(`/${id(2)}/resolve`, { action: 'accept' })
  expect(res.status).toBe(409)
  expect((await res.json()).error.code).toBe(code)
  expect(s.deps.link).not.toHaveBeenCalled()
  expect(s.store!.get(id(2))!.status).toBe('suggested')
})

it('an already-linked task is accepted without a write, and a revision race is retried with a fresh row', async () => {
  const linked = await setup({ list: vi.fn(async () => [row({ meetingRefs: [{ recordId: meeting.recordId }] })]) }); linked.store!.upsert([link()])
  expect((await linked.call(`/${id(2)}/resolve`, { action: 'accept' })).status).toBe(200)
  expect(linked.deps.link).not.toHaveBeenCalled()
  const race = vi.fn().mockRejectedValueOnce(new TaskBridgeError('task_revision_changed', 'changed')).mockResolvedValueOnce(undefined)
  const s = await setup({ link: race }); s.store!.upsert([link()])
  expect((await s.call(`/${id(2)}/resolve`, { action: 'accept' })).status).toBe(200)
  expect(race).toHaveBeenCalledTimes(2)
  expect(s.deps.list).toHaveBeenCalledTimes(2)
})

it('accepting an ask creates one linked card in the meeting domain; collisions with closed work and old bridges refuse', async () => {
  const s = await setup(); s.store!.upsert([ask()])
  const res = await s.call(`/${id(1)}/resolve`, { action: 'accept' })
  expect((await res.json()).item).toMatchObject({ status: 'accepted', resolution: { taskId: 'c'.repeat(12) } })
  expect(s.deps.capture).toHaveBeenCalledExactlyOnceWith('quilt', 'Fix the H1 (from Ryan Hopkins)', expect.objectContaining({ recordId: meeting.recordId, title: 'Canonical title' }))
  const clash = await setup({ capture: vi.fn(async () => ({ created: false, id: 'c'.repeat(12), linked: false, checked: true, archived: false, delegated: false })) })
  clash.store!.upsert([ask()])
  const refused = await clash.call(`/${id(1)}/resolve`, { action: 'accept' })
  expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe('intake_text_collision')
  expect(clash.store!.get(id(1))!.status).toBe('ask'); expect(clash.deps.link).not.toHaveBeenCalled()
  const old = await setup({ capabilities: vi.fn(async () => ({ linkWrites: true, cardCreation: false })) }); old.store!.upsert([ask()])
  expect((await (await old.call(`/${id(1)}/resolve`, { action: 'accept' })).json()).error.code).toBe('card_creation_unavailable')
  expect(old.deps.capture).not.toHaveBeenCalled()
})

it('dismiss needs no bridge, and bad actions are refused', async () => {
  const s = await setup({ capabilities: vi.fn(async () => { throw new Error('should not be asked') }) }); s.store!.upsert([ask()])
  expect((await (await s.call(`/${id(1)}/resolve`, { action: 'dismiss' })).json()).item.status).toBe('dismissed')
  expect((await s.call(`/${id(1)}/resolve`, { action: 'maybe' })).status).toBe(400)
  expect((await s.call(`/${id(1)}/resolve`, { action: 'accept', extra: 1 })).status).toBe(400)
  expect((await s.call(`/wi_nope/resolve`, { action: 'dismiss' })).status).toBe(400)
})

it('an ask whose words are already an open task links that task instead of refusing; a linked twin is success', async () => {
  const open = await setup({ capture: vi.fn(async () => ({ created: false, id: 'c'.repeat(12), linked: false, checked: false, archived: false, delegated: false })),
    list: vi.fn(async () => [row({ id: 'c'.repeat(12), workIdentity: 'c'.repeat(12), text: 'Fix the H1 (from Ryan Hopkins)' })]) })
  open.store!.upsert([ask()])
  expect((await (await open.call(`/${id(1)}/resolve`, { action: 'accept' })).json()).item.resolution.taskId).toBe('c'.repeat(12))
  expect(open.deps.link).toHaveBeenCalledExactlyOnceWith('quilt', 'c'.repeat(12), 'Fix the H1 (from Ryan Hopkins)', 'f'.repeat(64), expect.objectContaining({ recordId: meeting.recordId }))
  const twin = await setup({ capture: vi.fn(async () => ({ created: false, id: 'c'.repeat(12), linked: true, checked: false, archived: false, delegated: false })) })
  twin.store!.upsert([ask()])
  expect((await twin.call(`/${id(1)}/resolve`, { action: 'accept' })).status).toBe(200)
  expect(twin.deps.link).not.toHaveBeenCalled()
})

it('a task bridge that did not answer says so, instead of reading as an old server', async () => {
  const s = await setup({ capabilities: vi.fn(async () => ({ linkWrites: false, cardCreation: false, bridgeUnavailable: true as const })) })
  s.store!.upsert([ask()])
  const res = await s.call(`/${id(1)}/resolve`, { action: 'accept' })
  expect(res.status).toBe(503); expect((await res.json()).error.code).toBe('task_bridge_unavailable')
  expect(s.deps.capture).not.toHaveBeenCalled(); expect(s.store!.get(id(1))!.status).toBe('ask')
})

it('a read-only board is reported before the meeting is read', async () => {
  const s = await setup({ capabilities: vi.fn(async () => ({ linkWrites: false, cardCreation: false })), resolveMeeting: vi.fn(async () => { throw new Error('gone') }) })
  s.store!.upsert([link(), ask()])
  expect((await (await s.call(`/${id(2)}/resolve`, { action: 'accept' })).json()).error.code).toBe('work_board_read_only')
  expect((await (await s.call(`/${id(1)}/resolve`, { action: 'accept' })).json()).error.code).toBe('card_creation_unavailable')
  expect(s.deps.resolveMeeting).not.toHaveBeenCalled()
})

it(`retries a revision race exactly ${LINK_RACE_RETRIES} times, then refuses and leaves the item open`, async () => {
  const race = vi.fn(async () => { throw new TaskBridgeError('task_revision_changed', 'changed') })
  const s = await setup({ link: race }); s.store!.upsert([link()])
  const res = await s.call(`/${id(2)}/resolve`, { action: 'accept' })
  expect(res.status).toBe(409); expect((await res.json()).error.code).toBe('task_revision_changed')
  expect(race).toHaveBeenCalledTimes(LINK_RACE_RETRIES + 1)
  expect(s.store!.get(id(2))!.status).toBe('suggested')
})

it('finds the task by id when its Work identity changed, and refuses a row without a revision', async () => {
  const byId = await setup({ list: vi.fn(async () => [row({ id: 'a'.repeat(12), workIdentity: 'd'.repeat(12) })]) }); byId.store!.upsert([link()])
  expect((await byId.call(`/${id(2)}/resolve`, { action: 'accept' })).status).toBe(200)
  expect(byId.deps.link).toHaveBeenCalledWith('quilt', 'a'.repeat(12), expect.any(String), 'f'.repeat(64), expect.any(Object))
  const noRev = await setup({ list: vi.fn(async () => [row({ workRevision: '' })]) }); noRev.store!.upsert([link()])
  expect((await (await noRev.call(`/${id(2)}/resolve`, { action: 'accept' })).json()).error.code).toBe('intake_task_changed')
})

it('maps a missing task to 404, and logs an unexpected failure as a 503', async () => {
  const gone = await setup({ link: vi.fn(async () => { throw new TaskBridgeError('task_not_found', 'gone') }) }); gone.store!.upsert([link()])
  expect((await gone.call(`/${id(2)}/resolve`, { action: 'accept' })).status).toBe(404)
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const boom = await setup({ link: vi.fn(async () => { throw new Error('python traceback') }) }); boom.store!.upsert([link()])
    const res = await boom.call(`/${id(2)}/resolve`, { action: 'accept' })
    expect(res.status).toBe(503); expect((await res.json()).error.code).toBe('work_intake_unavailable')
    expect(logged).toHaveBeenCalledWith('[work-intake] resolve failed:', 'python traceback')
  } finally { logged.mockRestore() }
})

it('writes whose item an accepted ask was, ahead of any due date', () => {
  expect(intakeCardText({ text: 'Fix the H1', owner: 'Ryan Hopkins', ownerIsMiles: false })).toBe('Fix the H1 (from Ryan Hopkins)')
  expect(intakeCardText({ text: 'Fix the H1 — Due: 2026-09-24', owner: 'Ryan', ownerIsMiles: false })).toBe('Fix the H1 (from Ryan) — Due: 2026-09-24')
  expect(intakeCardText({ text: 'Build the strip', owner: 'MU', ownerIsMiles: true })).toBe('Build the strip')
  expect(intakeCardText({ text: 'Book the venue', owner: null, ownerIsMiles: false })).toBe('Book the venue')
})
