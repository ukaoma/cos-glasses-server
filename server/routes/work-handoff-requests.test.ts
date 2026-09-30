import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkHandoffRequestsRouter, defaultHandoffModel, isLoopbackRequest } from './work-handoff-requests.js'
import { WorkHandoffRequestStore } from '../lib/work-handoff-requests.js'
import { requireApiToken } from '../lib/api-auth.js'
import { controlSnapshotRevision, readWorkJournal, type WorkJournalRead } from '../lib/work-activity.js'
import { createWorkBoardReader } from '../lib/work-board-reader.js'
import { TaskRunError, type TaskBoardRow } from '../lib/task-store.js'

const servers: Server[] = [], stores: WorkHandoffRequestStore[] = [], roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const TOKEN = 'fixture-token-0123456789abcdef', identity = 'a'.repeat(12)
const C1 = 'claude:11111111-2222-4333-8444-555555555555', X1 = 'codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const row = (workIdentity = identity, patch = {}) => ({ id: workIdentity, domain: 'business', title: 'Board title', text: 'Board text ' + workIdentity, workIdentity,
  workRevision: 'e'.repeat(64), meetingRefs: [], checked: false, ...patch })
const REV = controlSnapshotRevision(row())
function journalWith(receipts: unknown[]): () => WorkJournalRead {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-journal-'))); roots.push(dir)
  const journalPath = join(dir, 'handoffs.json'); writeFileSync(journalPath, JSON.stringify({ version: 2, receipts, sessions: [], drafts: [] }), { mode: 0o600 })
  return () => readWorkJournal({ journalPath })
}
const receipt = (patch: Record<string, unknown>) => ({ id: 'r-new', workID: `task:business:${identity}`, workTitle: 'x', sourceRevision: 'r', mode: 'continueSession',
  provider: 'claude', modelID: '', sessionID: C1, sessionTitle: 't', status: 'completed', detail: 'd', prompt: 'p', createdAt: 200, ...patch })
async function setup(options: { withStore?: boolean; local?: boolean; journal?: () => WorkJournalRead; boardTimeoutMs?: number } = {}) {
  const clock = { ms: Date.parse('2026-09-30T15:00:00.000Z') }
  let store: WorkHandoffRequestStore | null = null
  if (options.withStore !== false) { const r = mkdtempSync(join(tmpdir(), 'handoff-route-')); roots.push(r); store = new WorkHandoffRequestStore(r, () => new Date(clock.ms)); stores.push(store) }
  const list = vi.fn(async () => [row(), row('c'.repeat(12)), row('d'.repeat(12), { checked: true })] as any)
  const readBoard = createWorkBoardReader<TaskBoardRow>(() => list(), { timeoutMs: options.boardTimeoutMs ?? 5_000, now: () => clock.ms })
  const app = express(); app.use('/api', requireApiToken(TOKEN)); app.use(express.json({ limit: '10mb' }))
  app.use('/api', createWorkHandoffRequestsRouter({ store, list, readBoard, defaultModel: () => 'sonnet', journal: options.journal ?? journalWith([]),
    ...(options.local === false ? { isLocal: () => false } : {}) }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/work-board/handoff-requests`
  const headers = { 'X-COS-Token': TOKEN, 'Content-Type': 'application/json' }
  const post = (path: string, body?: unknown) => fetch(base + path, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const get = (path = '') => fetch(base + path, { headers })
  const claim = async (id: string) => (await (await post('/' + id + '/claim')).json()).claimToken as string
  return { clock, store, list, base, post, get, claim }
}
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const body = (n = 1, patch: Record<string, unknown> = {}) => ({ clientRequestId: uuid(n), domain: 'business', workIdentity: identity,
  expectedTaskRevision: REV, intent: 'start', mode: 'continueSession', sessionId: C1, note: 'Private note for Control', destinationSource: 'jev', ...patch })
const json = async (response: Response) => ({ status: response.status, body: await response.json() })

it('requires the real API token on every route', async () => {
  const s = await setup()
  for (const response of [await fetch(s.base), await fetch(s.base + '/' + uuid(1)), await fetch(s.base, { method: 'POST' }),
    await fetch(s.base + '/' + uuid(1) + '/claim', { method: 'POST' }), await fetch(s.base + '/' + uuid(1) + '/result', { method: 'POST' }),
    await fetch(s.base, { headers: { 'X-COS-Token': 'wrong' } })]) {
    expect(response.status).toBe(401)
  }
})

it('answers COS Control\'s routes only on this Mac; the glasses routes work over the network', async () => {
  const s = await setup({ local: false })
  expect((await s.post('', body())).status).toBe(201)
  expect((await s.get('/' + uuid(1))).status).toBe(200)
  for (const response of [await s.get('?state=pending'), await s.post('/' + uuid(1) + '/claim'), await s.post('/' + uuid(1) + '/result', { state: 'sent', receiptId: 'r', claimToken: 'a'.repeat(32) })]) {
    expect(await json(response)).toMatchObject({ status: 403, body: { error: { code: 'local_only' } } })
  }
  expect(s.store!.consumerSeenAt()).toBeNull()
  expect(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } } as never)).toBe(true)
  expect(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } } as never)).toBe(true)
  expect(isLoopbackRequest({ socket: { remoteAddress: '::1' } } as never)).toBe(true)
  for (const address of ['100.64.0.7', '192.168.1.20', '::ffff:10.0.0.2', '', undefined]) expect(isLoopbackRequest({ socket: { remoteAddress: address } } as never)).toBe(false)
})

it('creates 201, answers a retry 200 from the store without the board, and refuses a changed body 409', async () => {
  const s = await setup()
  const created = await json(await s.post('', body()))
  expect(created.status).toBe(201)
  expect(created.body.request).toMatchObject({ clientRequestId: uuid(1), state: 'pending', intent: 'start', mode: 'continueSession', sessionId: C1,
    note: 'Private note for Control', destinationSource: 'jev', expectedTaskRevision: REV, createdAt: '2026-09-30T15:00:00.000Z', expiresAt: '2026-09-30T15:10:00.000Z' })
  expect(created.body.request).not.toHaveProperty('fingerprint')
  expect(s.list).toHaveBeenCalledTimes(1)
  // Past the board read's 2 s age, with the board down: the retry never needs it.
  s.list.mockRejectedValue(new Error('bridge down')); s.clock.ms += 3_000
  expect(await json(await s.post('', body()))).toEqual({ status: 200, body: created.body })
  expect(s.list).toHaveBeenCalledTimes(1)
  expect(await json(await s.post('', body(1, { note: 'Different words' })))).toMatchObject({ status: 409, body: { error: { code: 'request_id_conflict' } } })
})

it('checks the task itself: revision_changed only when THIS task changed, task_complete, task_not_found', async () => {
  const s = await setup()
  expect(await json(await s.post('', body(1, { expectedTaskRevision: 'c'.repeat(64) })))).toMatchObject({ status: 409, body: { error: { code: 'revision_changed' } } })
  expect(await json(await s.post('', body(2, { workIdentity: 'f'.repeat(12) })))).toMatchObject({ status: 404, body: { error: { code: 'task_not_found' } } })
  expect(await json(await s.post('', body(3, { workIdentity: 'd'.repeat(12), expectedTaskRevision: controlSnapshotRevision(row('d'.repeat(12))) }))))
    .toMatchObject({ status: 409, body: { error: { code: 'task_complete' } } })
  // Another card (or the domain file's revision) changing does not matter: the row's own revision is the one checked.
  s.list.mockResolvedValue([row(identity, { workRevision: 'f'.repeat(64) }), row('c'.repeat(12), { text: 'Edited' })] as any)
  s.clock.ms += 3_000
  const calls = s.list.mock.calls.length
  expect((await s.post('', body(4))).status).toBe(201)
  expect(s.list.mock.calls.length).toBe(calls + 1)   // a fresh board read, not the cached one
  expect(await json(await s.post('', body(5)))).toMatchObject({ status: 409, body: { error: { code: 'request_pending' } } })
})

it('a board that fails or takes longer than 5 s is 503 work_board_unavailable with its cause, and nothing is created', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const s = await setup({ boardTimeoutMs: 50 })
  s.list.mockRejectedValueOnce(new TaskRunError(503, 'cos_pipeline_not_configured', 'x'))
  expect(await json(await s.post('', body(1)))).toMatchObject({ status: 503, body: { error: { code: 'work_board_unavailable', cause: 'cos_pipeline_not_configured' } } })
  s.list.mockImplementation(() => new Promise(() => {}))
  s.clock.ms += 3_000
  expect(await json(await s.post('', body(2)))).toMatchObject({ status: 503, body: { error: { code: 'work_board_unavailable', cause: 'work_board_timeout' } } })
  expect((await s.get('/' + uuid(1))).status).toBe(404); expect((await s.get('/' + uuid(2))).status).toBe(404)
  expect(warn.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([
    `[work-handoff-requests] create ${uuid(1)}: 503 work_board_unavailable (cos_pipeline_not_configured)`,
    `[work-handoff-requests] create ${uuid(2)}: 503 work_board_unavailable (work_board_timeout)`]))
})

it('a reply names the item\'s newest receipt, on the session it went to', async () => {
  const journal = journalWith([receipt({ id: 'r-old', createdAt: 100 }), receipt({}), receipt({ id: 'r-other-item', workID: 'task:business:' + 'c'.repeat(12), createdAt: 300 }),
    receipt({ id: 'r-fork', workID: 'task:business:' + 'c'.repeat(12), mode: 'fork', sessionID: X1, sourceSessionID: X1, createdAt: 400 })])
  const s = await setup({ journal })
  const reply = (n: number, patch: Record<string, unknown>) => s.post('', body(n, { intent: 'reply', replyTo: 'r-new', ...patch }))
  expect(await json(await reply(1, { replyTo: 'r-old' }))).toMatchObject({ status: 409, body: { error: { code: 'reply_target_invalid', message: expect.stringContaining('newer') } } })
  expect(await json(await reply(2, { replyTo: 'r-other-item' }))).toMatchObject({ status: 409, body: { error: { code: 'reply_target_invalid' } } })
  expect(await json(await reply(3, { replyTo: 'r-missing' }))).toMatchObject({ status: 409, body: { error: { code: 'reply_target_invalid' } } })
  expect(await json(await reply(4, { sessionId: 'claude:22222222-2222-4333-8444-555555555555' }))).toMatchObject({ status: 409, body: { error: { code: 'reply_target_invalid' } } })
  // A Fork that never got its own session names no session to continue.
  const cRev = controlSnapshotRevision(row('c'.repeat(12)))
  expect(await json(await s.post('', body(5, { intent: 'notDone', replyTo: 'r-fork', workIdentity: 'c'.repeat(12), expectedTaskRevision: cRev, sessionId: X1 }))))
    .toMatchObject({ status: 409, body: { error: { code: 'reply_target_invalid' } } })
  const ok = await json(await reply(6, { intent: 'notDone' }))
  expect(ok).toMatchObject({ status: 201, body: { request: { intent: 'notDone', replyTo: 'r-new', mode: 'continueSession' } } })
  const noHistory = await setup({ journal: () => ({ available: false, reason: 'isolated' }) })
  expect(await json(await noHistory.post('', body(1, { intent: 'reply', replyTo: 'r-new' })))).toMatchObject({ status: 503, body: { error: { code: 'work_history_unavailable' } } })
})

it('refuses a malformed request 400, takes the server default model for a New session, and says when the daily cap resets', async () => {
  const s = await setup()
  for (const bad of [body(1, { clientRequestId: 'not-a-uuid' }), body(1, { note: 'x'.repeat(2_001) }), body(1, { note: 'bell\u0007' }),
    body(1, { sessionId: undefined }), body(1, { destinationSource: 'mars' }), body(1, { extra: true }), [body()], body(1, { intent: undefined })]) {
    expect(await json(await s.post('', bad))).toMatchObject({ status: 400, body: { error: { code: 'invalid_handoff_request' } } })
  }
  const created = await json(await s.post('', body(2, { mode: 'newSession', sessionId: null })))
  expect(created.body.request).toMatchObject({ mode: 'newSession', model: 'sonnet' }); expect(created.body.request).not.toHaveProperty('sessionId')
  const rows = Array.from({ length: 45 }, (_, i) => row((i + 1).toString(16).padStart(12, '0')))
  s.list.mockResolvedValue(rows as any); s.clock.ms += 3_000
  for (let n = 1; n < 40; n++) expect((await s.post('', body(100 + n, { workIdentity: rows[n].workIdentity, expectedTaskRevision: controlSnapshotRevision(rows[n]) }))).status).toBe(201)
  const capped = await s.post('', body(200, { workIdentity: rows[44].workIdentity, expectedTaskRevision: controlSnapshotRevision(rows[44]) }))
  const answer = await json(capped)
  expect(answer).toMatchObject({ status: 429, body: { error: { code: 'daily_cap', resetsAt: expect.any(String) } } })
  expect(Number(capped.headers.get('retry-after'))).toBeGreaterThan(0)
})

it('the glasses status view has state and times only; Control lists pending requests in full with the quarantine count, which turns requests on', async () => {
  const s = await setup()
  await s.post('', body(1)); await s.post('', body(2, { workIdentity: 'c'.repeat(12), expectedTaskRevision: controlSnapshotRevision(row('c'.repeat(12))), mode: 'fork', sessionId: X1 }))
  expect(await json(await s.get('/' + uuid(1).toUpperCase())))
    .toEqual({ status: 200, body: { request: { clientRequestId: uuid(1), state: 'pending', createdAt: '2026-09-30T15:00:00.000Z', expiresAt: '2026-09-30T15:10:00.000Z' } } })
  expect(s.store!.consumerSeenAt()).toBeNull()
  expect((await s.get()).status).toBe(200); expect(s.store!.consumerSeenAt()).toBeNull()
  const pending = await json(await s.get('?state=pending'))
  expect(pending.body.quarantined).toBe(0)
  expect(pending.body.requests.map((r: any) => [r.clientRequestId, r.mode, r.note])).toEqual([[uuid(1), 'continueSession', 'Private note for Control'], [uuid(2), 'fork', 'Private note for Control']])
  expect(s.store!.consumerSeenAt()).toBe(s.clock.ms)
  for (const query of ['?state=done', '?state=pending&limit=5']) expect((await s.get(query)).status).toBe(400)
  expect((await s.get('/' + uuid(9))).status).toBe(404)
  expect((await s.get('/not-a-uuid')).status).toBe(400)
})

it('claim race: two claims at once, exactly one wins and gets the token; the same token claims again', async () => {
  const s = await setup(); await s.post('', body(1))
  const answers = await Promise.all([s.post('/' + uuid(1) + '/claim'), s.post('/' + uuid(1) + '/claim')])
  expect(answers.map(a => a.status).sort()).toEqual([200, 409])
  const winner = await answers.find(a => a.status === 200)!.json()
  expect(winner.request).toMatchObject({ state: 'claimed', claimedAt: '2026-09-30T15:00:00.000Z', claimExpiresAt: '2026-09-30T15:10:00.000Z', note: 'Private note for Control' })
  expect(winner.claimToken).toMatch(/^[a-f0-9]{32}$/); expect(winner.request).not.toHaveProperty('claimToken')
  expect((await answers.find(a => a.status === 409)!.json()).error.code).toBe('already_claimed')
  expect(await json(await s.post('/' + uuid(1) + '/claim', { claimToken: winner.claimToken }))).toMatchObject({ status: 200, body: { claimToken: winner.claimToken } })
  expect(await json(await s.post('/' + uuid(1) + '/claim', { claimToken: 'f'.repeat(32) }))).toMatchObject({ status: 409 })
  expect(await json(await s.post('/' + uuid(1) + '/claim', { force: true }))).toMatchObject({ status: 400 })
  expect((await json(await s.get('?state=claimed'))).body.requests[0]).not.toHaveProperty('claimToken')
})

it('an expired request is 410 and never claimable; a claim with no report is unconfirmed and takes one late result', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const s = await setup(); await s.post('', body(1)); await s.post('', body(2, { workIdentity: 'c'.repeat(12), expectedTaskRevision: controlSnapshotRevision(row('c'.repeat(12))) }))
  const token = await s.claim(uuid(2))
  s.clock.ms += 10 * 60_000
  expect(await json(await s.post('/' + uuid(1) + '/claim'))).toMatchObject({ status: 410, body: { error: { code: 'request_expired' } } })
  expect((await json(await s.get('/' + uuid(1)))).body.request.state).toBe('expired')
  expect((await json(await s.get('/' + uuid(2)))).body.request).toMatchObject({ state: 'unconfirmed', claimExpiresAt: '2026-09-30T15:10:00.000Z' })
  expect(await json(await s.post('/' + uuid(2) + '/result', { state: 'sent', receiptId: 'late', claimToken: token }))).toMatchObject({ status: 200, body: { request: { state: 'sent', receiptId: 'late' } } })
  expect(await json(await s.post('/' + uuid(2) + '/result', { state: 'refused', reason: 'no', claimToken: token }))).toMatchObject({ status: 409, body: { error: { code: 'request_not_claimed' } } })
  expect((await json(await s.get('?state=pending'))).body.requests).toEqual([])
  const lines = warn.mock.calls.map(call => String(call[0]))
  expect(lines).toEqual(expect.arrayContaining([`[work-handoff-requests] claim ${uuid(1)}: 410 request_expired`, `[work-handoff-requests] result ${uuid(2)}: 409 request_not_claimed`]))
  expect(lines.join('\n')).not.toContain('Private note')
})

it('takes a result only from claimed under its token, repeats it, and refuses a different one', async () => {
  const s = await setup(); await s.post('', body(1))
  expect(await json(await s.post('/' + uuid(1) + '/result', { state: 'sent', receiptId: 'r-1', claimToken: 'a'.repeat(32) }))).toMatchObject({ status: 409, body: { error: { code: 'request_not_claimed' } } })
  const token = await s.claim(uuid(1))
  expect(await json(await s.post('/' + uuid(1) + '/result', { state: 'sent', receiptId: 'r-1', claimToken: 'a'.repeat(32) }))).toMatchObject({ status: 409, body: { error: { code: 'claim_token_mismatch' } } })
  expect((await s.post('/' + uuid(1) + '/result', { state: 'sent', claimToken: token })).status).toBe(400)
  const sent = await json(await s.post('/' + uuid(1) + '/result', { state: 'sent', receiptId: 'r-1', claimToken: token }))
  expect(sent.body.request).toMatchObject({ state: 'sent', receiptId: 'r-1' })
  expect(await json(await s.post('/' + uuid(1) + '/result', { state: 'sent', receiptId: 'r-1', claimToken: token }))).toEqual(sent)
  expect((await s.post('/' + uuid(1) + '/result', { state: 'refused', reason: 'no', claimToken: token })).status).toBe(409)
  expect((await s.post('/' + uuid(1) + '/result', { state: 'claimed', claimToken: token })).status).toBe(400)
  expect((await json(await s.get('/' + uuid(1)))).body.request).toMatchObject({ state: 'sent', receiptId: 'r-1' })
})

it('answers 503 on every route when the inbox store did not open', async () => {
  const s = await setup({ withStore: false })
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
