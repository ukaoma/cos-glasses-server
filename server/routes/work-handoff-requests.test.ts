import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkHandoffRequestsRouter, defaultHandoffModel } from './work-handoff-requests.js'
import { WorkHandoffRequestStore, HANDOFF_REQUEST_LIMITS, CLAIM_TIMEOUT_REASON } from '../lib/work-handoff-requests.js'

const servers: Server[] = [], stores: WorkHandoffRequestStore[] = [], roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const REV = 'b'.repeat(64), identity = 'a'.repeat(12)
const row = (workIdentity = identity, patch = {}) => ({ id: workIdentity, domain: 'business', title: 'Board title', text: 'Board text', workIdentity, workRevision: REV, meetingRefs: [], checked: false, ...patch })
async function setup(withStore = true) {
  const clock = { ms: Date.parse('2026-09-30T15:00:00.000Z') }
  let store: WorkHandoffRequestStore | null = null
  if (withStore) { const r = mkdtempSync(join(tmpdir(), 'handoff-route-')); roots.push(r); store = new WorkHandoffRequestStore(r, () => new Date(clock.ms)); stores.push(store) }
  const list = vi.fn(async () => [row(), row('c'.repeat(12))] as any)
  const app = express(); app.use(express.json({ limit: '10mb' }))
  app.use('/api', (req, res, next) => req.header('X-COS-Token') === 'fixture-token' ? next() : res.sendStatus(401))
  app.use('/api', createWorkHandoffRequestsRouter({ store, list, defaultModel: () => 'sonnet' }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/work-board/handoff-requests`
  const headers = { 'X-COS-Token': 'fixture-token', 'Content-Type': 'application/json' }
  const post = (path: string, body?: unknown) => fetch(base + path, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const get = (path = '') => fetch(base + path, { headers })
  return { clock, store, list, base, post, get }
}
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const body = (n = 1, patch: Record<string, unknown> = {}) => ({ clientRequestId: uuid(n), domain: 'business', workIdentity: identity,
  expectedRevision: REV, mode: 'continueSession', sessionId: 'claude:abc-1', note: 'Private note for Control', destinationSource: 'jev', ...patch })
const json = async (response: Response) => ({ status: response.status, body: await response.json() })

it('requires the API token on every route', async () => {
  const s = await setup()
  for (const response of [await fetch(s.base), await fetch(s.base + '/' + uuid(1)), await fetch(s.base, { method: 'POST' }),
    await fetch(s.base + '/' + uuid(1) + '/claim', { method: 'POST' }), await fetch(s.base + '/' + uuid(1) + '/result', { method: 'POST' })]) {
    expect(response.status).toBe(401)
  }
})

it('creates 201, answers a retry 200 from the store without the board, and refuses a changed body 409', async () => {
  const s = await setup()
  const created = await json(await s.post('', body()))
  expect(created.status).toBe(201)
  expect(created.body.request).toMatchObject({ clientRequestId: uuid(1), state: 'pending', mode: 'continueSession', sessionId: 'claude:abc-1',
    note: 'Private note for Control', destinationSource: 'jev', createdAt: '2026-09-30T15:00:00.000Z', expiresAt: '2026-09-30T15:10:00.000Z' })
  expect(created.body.request).not.toHaveProperty('fingerprint')
  expect(s.list).toHaveBeenCalledTimes(1)
  s.list.mockRejectedValue(new Error('bridge down'))
  expect(await json(await s.post('', body()))).toEqual({ status: 200, body: created.body })
  expect(s.list).toHaveBeenCalledTimes(1)
  const conflict = await json(await s.post('', body(1, { note: 'Different words' })))
  expect(conflict).toMatchObject({ status: 409, body: { error: { code: 'request_id_conflict' } } })
})

it('reads the board: revision_changed, task_not_found, work_board_unavailable, then request_pending and daily_cap', async () => {
  const s = await setup()
  expect(await json(await s.post('', body(1, { expectedRevision: 'c'.repeat(64) })))).toMatchObject({ status: 409, body: { error: { code: 'revision_changed' } } })
  expect(await json(await s.post('', body(2, { workIdentity: 'd'.repeat(12) })))).toMatchObject({ status: 404, body: { error: { code: 'task_not_found' } } })
  s.list.mockRejectedValueOnce(new Error('bridge down'))
  expect(await json(await s.post('', body(3)))).toMatchObject({ status: 503, body: { error: { code: 'work_board_unavailable' } } })
  expect((await s.post('', body(4))).status).toBe(201)
  expect(await json(await s.post('', body(5)))).toMatchObject({ status: 409, body: { error: { code: 'request_pending' } } })
  const rows = Array.from({ length: 45 }, (_, i) => row((i + 1).toString(16).padStart(12, '0')))
  s.list.mockResolvedValue(rows as any)
  for (let n = 1; n < 40; n++) expect((await s.post('', body(100 + n, { workIdentity: rows[n].workIdentity }))).status).toBe(201)
  expect(await json(await s.post('', body(200, { workIdentity: rows[44].workIdentity })))).toMatchObject({ status: 429, body: { error: { code: 'daily_cap' } } })
})

it('refuses a malformed request 400 and takes the server default model for a New session', async () => {
  const s = await setup()
  for (const bad of [body(1, { clientRequestId: 'not-a-uuid' }), body(1, { note: 'x'.repeat(2_001) }), body(1, { note: 'bell\u0007' }),
    body(1, { sessionId: undefined }), body(1, { destinationSource: 'mars' }), body(1, { extra: true }), [body()]]) {
    expect(await json(await s.post('', bad))).toMatchObject({ status: 400, body: { error: { code: 'invalid_handoff_request' } } })
  }
  const created = await json(await s.post('', body(2, { mode: 'newSession', sessionId: null })))
  expect(created.body.request).toMatchObject({ mode: 'newSession', model: 'sonnet' }); expect(created.body.request).not.toHaveProperty('sessionId')
})

it('the glasses status view has state and times only; Control lists pending requests in full', async () => {
  const s = await setup()
  await s.post('', body(1)); await s.post('', body(2, { workIdentity: 'c'.repeat(12), mode: 'fork', sessionId: 'codex:t-9' }))
  const status = await json(await s.get('/' + uuid(1).toUpperCase()))
  expect(status).toEqual({ status: 200, body: { request: { clientRequestId: uuid(1), state: 'pending', createdAt: '2026-09-30T15:00:00.000Z', expiresAt: '2026-09-30T15:10:00.000Z' } } })
  const pending = await json(await s.get('?state=pending'))
  expect(pending.body.requests.map((r: any) => [r.clientRequestId, r.mode, r.note])).toEqual([[uuid(1), 'continueSession', 'Private note for Control'], [uuid(2), 'fork', 'Private note for Control']])
  expect((await s.get()).status).toBe(200)
  for (const query of ['?state=done', '?state=pending&limit=5']) expect((await s.get(query)).status).toBe(400)
  expect((await s.get('/' + uuid(9))).status).toBe(404)
  expect((await s.get('/not-a-uuid')).status).toBe(400)
})

it('claim race: two claims at once, exactly one wins', async () => {
  const s = await setup(); await s.post('', body(1))
  const answers = await Promise.all([s.post('/' + uuid(1) + '/claim'), s.post('/' + uuid(1) + '/claim')])
  expect(answers.map(a => a.status).sort()).toEqual([200, 409])
  const winner = await answers.find(a => a.status === 200)!.json()
  expect(winner.request).toMatchObject({ state: 'claimed', claimedAt: '2026-09-30T15:00:00.000Z', note: 'Private note for Control' })
  expect((await answers.find(a => a.status === 409)!.json()).error.code).toBe('already_claimed')
  expect(await json(await s.post('/' + uuid(1) + '/claim', { force: true }))).toMatchObject({ status: 400 })
})

it('an expired request is 410 and never claimable; a claim with no report reads as refused', async () => {
  const s = await setup(); await s.post('', body(1)); await s.post('', body(2, { workIdentity: 'c'.repeat(12) }))
  expect((await s.post('/' + uuid(2) + '/claim', {})).status).toBe(200)
  s.clock.ms += HANDOFF_REQUEST_LIMITS.pendingMs
  expect(await json(await s.post('/' + uuid(1) + '/claim'))).toMatchObject({ status: 410, body: { error: { code: 'request_expired' } } })
  expect((await json(await s.get('/' + uuid(1)))).body.request.state).toBe('expired')
  expect((await json(await s.get('/' + uuid(2)))).body.request).toMatchObject({ state: 'refused', reason: CLAIM_TIMEOUT_REASON, resultAt: '2026-09-30T15:10:00.000Z' })
  expect(await json(await s.post('/' + uuid(2) + '/result', { state: 'sent', receiptId: 'late' }))).toMatchObject({ status: 409, body: { error: { code: 'request_not_claimed' } } })
  expect((await json(await s.get('?state=pending'))).body.requests).toEqual([])
})

it('takes a result only from claimed, repeats it, and refuses a different one', async () => {
  const s = await setup(); await s.post('', body(1))
  expect(await json(await s.post('/' + uuid(1) + '/result', { state: 'sent', receiptId: 'r-1' }))).toMatchObject({ status: 409, body: { error: { code: 'request_not_claimed' } } })
  await s.post('/' + uuid(1) + '/claim')
  const sent = await json(await s.post('/' + uuid(1) + '/result', { state: 'sent', receiptId: 'r-1' }))
  expect(sent.body.request).toMatchObject({ state: 'sent', receiptId: 'r-1' })
  expect(await json(await s.post('/' + uuid(1) + '/result', { state: 'sent', receiptId: 'r-1' }))).toEqual(sent)
  expect((await s.post('/' + uuid(1) + '/result', { state: 'refused', reason: 'no' })).status).toBe(409)
  expect((await s.post('/' + uuid(1) + '/result', { state: 'claimed' })).status).toBe(400)
  expect((await json(await s.get('/' + uuid(1)))).body.request).toMatchObject({ state: 'sent', receiptId: 'r-1' })
})

it('answers 503 on every route when the inbox store did not open', async () => {
  const s = await setup(false)
  for (const response of [await s.get(), await s.get('/' + uuid(1)), await s.post('', body()), await s.post('/' + uuid(1) + '/claim'), await s.post('/' + uuid(1) + '/result', { state: 'sent' })]) {
    expect(await json(response)).toMatchObject({ status: 503, body: { error: { code: 'handoff_requests_unavailable' } } })
  }
})

it('the default model for a New session is COS_G2_DEFAULT_MODEL, else sonnet', () => {
  const prior = process.env.COS_G2_DEFAULT_MODEL
  try {
    process.env.COS_G2_DEFAULT_MODEL = 'opus'; expect(defaultHandoffModel()).toBe('opus')
    process.env.COS_G2_DEFAULT_MODEL = 'nonsense'; expect(defaultHandoffModel()).toBe('sonnet')
    delete process.env.COS_G2_DEFAULT_MODEL; expect(defaultHandoffModel()).toBe('sonnet')
  } finally { if (prior === undefined) delete process.env.COS_G2_DEFAULT_MODEL; else process.env.COS_G2_DEFAULT_MODEL = prior }
})
