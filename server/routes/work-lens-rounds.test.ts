import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { type Server } from 'node:http'
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkLensRoundsRouter, knownWorkFrom, type WorkLensRoundsDeps } from './work-lens-rounds.js'
import { createWorkChatRouter } from './work-chat.js'
import { LensRoundStore, LENS_ROUNDS_MAX, LENS_ROUND_TTL_MS, LENS_SEND_PICKUP_MS, LENS_SEND_REPORT_MS, cardSessionsOf, planIsStale, sendOutcome,
  parseLensRound, type LensRound } from '../lib/work-lens-rounds.js'
import type { ControlSnapshot } from '../lib/work-orchestrator/snapshot.js'
import { defaultLensRoundStore } from '../lib/work-lens-rounds.js'
import { dataPath } from '../lib/data-dir.js'

const WORK = 'task:quilt:420a0114f1a9'
const S1 = 'claude:11111111-1111-4111-8111-111111111111'
const S2 = 'codex:22222222-2222-4222-8222-222222222222'
const S3 = 'claude:33333333-3333-4333-8333-333333333333'
const uuid = (n: number) => `lens-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const round = (n = 1, extra: Record<string, unknown> = {}) => ({
  v: 1, workID: WORK, clientRoundId: uuid(n), question: 'Ship the fix and update the doc', answer: 'Two sessions: the fix, then the doc.',
  planner: 'opus', effort: 'high', orchestrator: true,
  assignments: [
    { id: 'a1', mode: 'continue', sessionID: S1, provider: 'claude', prompt: 'Fix the bug in work-chat.ts', contextItemIDs: ['req', 'task'] },
    { id: 'a2', mode: 'newSession', provider: 'codex', prompt: 'Update docs/work-orchestrator.md', contextItemIDs: ['req', 'task', 'cos'] },
  ],
  source: 'lens', createdAt: '2026-10-21T14:20:00.000Z', ...extra,
})
const snap = (links: string[], receipts: { sessionID: string; mode?: string; sourceSessionID?: string | null; forkChildID?: string | null }[] = []): ControlSnapshot => ({
  version: 1, controlVersion: '0.5.333', sentAt: 0, receivedAt: 0, live: null,
  links: links.map(sessionID => ({ sessionID, workID: WORK, at: 1 })),
  receipts: receipts.map((r, i) => ({ id: `r${i}`, workID: WORK, mode: (r.mode ?? 'continueSession') as any, provider: 'claude', sessionID: r.sessionID,
    sourceSessionID: r.sourceSessionID ?? null, forkChildID: r.forkChildID ?? null, status: 'sent', createdAt: 1 })),
})

interface Harness { url: string; server: Server; clock: { t: number }; store: LensRoundStore; state: { snapshot: ControlSnapshot | null; local: boolean; admissions: boolean; leaseFails: boolean; known: boolean | 'throw' }
  post: (path: string, body?: unknown) => Promise<Response>; get: (path: string) => Promise<Response>; leases: { taken: number; released: number } }
const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

async function setup(opts: { path?: string | null; extra?: Partial<WorkLensRoundsDeps> } = {}): Promise<Harness> {
  const clock = { t: Date.parse('2026-10-21T14:21:00.000Z') }
  const store = new LensRoundStore(opts.path ?? null, () => clock.t)
  const state = { snapshot: snap([S1]) as ControlSnapshot | null, local: true, admissions: true, leaseFails: false, known: true as boolean | 'throw' }
  const leases = { taken: 0, released: 0 }
  const app = express(); app.use(express.json({ limit: '10mb' }))
  app.use('/api', (req, res, next) => req.header('X-Cos-Token') === 't' ? next() : res.status(401).json({ error: 'unauthorized' }))
  app.use('/api', createWorkChatRouter({ run: (async () => ({ text: '{}' })) as any, admissions: () => true, lease: () => ({ release() {} }) as any,
    planLog: () => {}, lensPlansControl: () => store.controlStatus() }))
  app.use('/api', createWorkLensRoundsRouter({
    store, snapshot: () => state.snapshot, admissions: () => state.admissions, isLocal: () => state.local,
    knownWork: async () => { if (state.known === 'throw') throw new Error('board down'); return state.known as boolean },
    lease: () => { if (state.leaseFails) throw new Error('drain'); leases.taken++; return { release() { leases.released++ } } },
    ...opts.extra,
  }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const url = `http://127.0.0.1:${(server.address() as any).port}/api`
  const headers = { 'content-type': 'application/json', 'X-Cos-Token': 't' }
  return { url, server, clock, store, state, leases,
    post: (path, body) => fetch(url + path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    get: path => fetch(url + path, { headers }) }
}
const json = async (r: Response) => ({ status: r.status, body: await r.json() as any })
const poll = async (h: Harness, q = '') => json(await h.get('/work/chat/lens-inbox' + q))
const recordAndHistory = async (h: Harness, n = 1, autoSendCard?: boolean) => {
  const rec = await json(await h.post('/work/chat/lens-rounds', round(n)))
  await h.post(`/work/chat/lens-rounds/${rec.body.roundId}/history`, { state: 'in_history', ...(autoSendCard !== undefined ? { autoSendCard } : {}) })
  return rec.body.roundId as string
}

describe('record a lens-made plan', () => {
  it('records 201, answers a repeat of the same clientRoundId 200 with the same body, and never echoes prompts on GET', async () => {
    const h = await setup()
    const first = await json(await h.post('/work/chat/lens-rounds', round()))
    expect(first.status).toBe(201)
    expect(first.body).toEqual({ roundId: expect.stringMatching(/^lr_[a-f0-9]{16}$/), workID: WORK, state: 'recorded', control: { connected: false } })
    const again = await json(await h.post('/work/chat/lens-rounds', round(1, { question: 'changed text' })))
    expect(again).toEqual({ status: 200, body: first.body })
    const view = await json(await h.get(`/work/chat/lens-rounds/${first.body.roundId}`))
    expect(view.status).toBe(200)
    expect(view.body).toMatchObject({ roundId: first.body.roundId, workID: WORK, state: 'recorded', inHistory: false, autoSendCard: false,
      assignments: [{ id: 'a1', state: 'pending', sessionID: S1 }, { id: 'a2', state: 'pending' }] })
    expect(JSON.stringify(view.body)).not.toContain('Fix the bug')
    expect(typeof view.body.updatedAt).toBe('string')
  })
  it('refuses a malformed plan 400 invalid_lens_round with the field, an unknown card 404, an oversized body 413', async () => {
    const h = await setup()
    const cases: [Record<string, unknown>, string][] = [
      [{ v: 2 }, 'v'], [{ workID: 'task:quilt:xyz' }, 'workID'], [{ clientRoundId: 'abc' }, 'clientRoundId'], [{ question: ' ' }, 'question'],
      [{ question: 'q'.repeat(4001) }, 'question'], [{ answer: 'a'.repeat(6001) }, 'answer'], [{ planner: 'haiku' }, 'planner'], [{ source: 'phone' }, 'source'],
      [{ createdAt: 'yesterday' }, 'createdAt'],
      [{ assignments: [{ id: 'a2', mode: 'continue', sessionID: S1, prompt: 'x' }] }, 'assignments.id'],
      [{ assignments: [{ id: 'a1', mode: 'continue', prompt: 'x' }] }, 'assignments.sessionID'],
      [{ assignments: [{ id: 'a1', mode: 'newSession', provider: 'cursor', prompt: 'x' }] }, 'assignments.provider'],
      [{ assignments: [{ id: 'a1', mode: 'continue', sessionID: S1, prompt: 'p'.repeat(6001) }] }, 'assignments.prompt'],
      [{ assignments: [1, 2, 3, 4].map(i => ({ id: `a${i}`, mode: 'continue', sessionID: S1, prompt: 'x' })) }, 'assignments'],
    ]
    for (const [patch, field] of cases) {
      const r = await json(await h.post('/work/chat/lens-rounds', { ...round(), ...patch }))
      expect([r.status, r.body.error, r.body.field], JSON.stringify(patch)).toEqual([400, 'invalid_lens_round', field])
      expect(typeof r.body.message).toBe('string')
    }
    h.state.known = false
    expect(await json(await h.post('/work/chat/lens-rounds', round(2)))).toMatchObject({ status: 404, body: { error: 'unknown_work' } })
    h.state.known = 'throw'
    expect(await json(await h.post('/work/chat/lens-rounds', round(3)))).toMatchObject({ status: 503, body: { error: 'work_board_unavailable' } })
    h.state.known = true
    const huge = await json(await h.post('/work/chat/lens-rounds', { ...round(4), pad: 'x'.repeat(300_000) }))
    expect(huge).toMatchObject({ status: 413, body: { error: 'lens_round_too_large' } })
  })
  it('a repeat is answered from the store even when the card has since left the board', async () => {
    const h = await setup()
    const first = await json(await h.post('/work/chat/lens-rounds', round()))
    h.state.known = false
    expect(await json(await h.post('/work/chat/lens-rounds', round()))).toEqual({ status: 200, body: first.body })
  })
  it('knows a card from COS Control’s snapshot first and the Work board second', async () => {
    let reads = 0
    const board = { read: async () => { reads++; return [{ domain: 'quilt', id: 'x', workIdentity: '420a0114f1a9' }] as any }, begin: () => ({}) as any, prime() {}, invalidate() {} }
    expect(await knownWorkFrom(() => snap([S1]), board)(WORK)).toBe(true); expect(reads).toBe(0)
    expect(await knownWorkFrom(() => null, board)(WORK)).toBe(true); expect(reads).toBe(1)
    expect(await knownWorkFrom(() => null, board)('task:quilt:000000000000')).toBe(false)
  })
})

describe('send this plan', () => {
  it('without confirm and without card Auto-send is 428; confirmed with no COS Control poll in 60 s is 423 and the plan stays recorded', async () => {
    const h = await setup()
    const id = await recordAndHistory(h)
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1 }))).toMatchObject({ status: 428, body: { error: 'confirmation_required' } })
    const confirmed = { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, confirmed))).toMatchObject({ status: 423, body: { error: 'control_not_connected' } })
    await poll(h); h.clock.t += 61_000
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, confirmed))).toMatchObject({ status: 423, body: { error: 'control_not_connected' } })
    expect((await json(await h.get(`/work/chat/lens-rounds/${id}`))).body.state).toBe('in_history')
  })
  it('journey: record, Control writes history, confirmed send, Control picks it up once, reports, sent; a second send is already_sent', async () => {
    const h = await setup()
    const rec = await json(await h.post('/work/chat/lens-rounds', round()))
    const id = rec.body.roundId
    // COS Control polls: the round lands in its inbox with the full plan (prompts included), and Control is now connected.
    const first = await poll(h, '?since=0&autoSend=0')
    expect(first.status).toBe(200)
    expect(first.body.rounds).toHaveLength(1)
    expect(first.body.rounds[0]).toMatchObject({ roundId: id, workID: WORK, question: 'Ship the fix and update the doc', planner: 'opus', effort: 'high',
      assignments: [{ id: 'a1', mode: 'continue', sessionID: S1, prompt: 'Fix the bug in work-chat.ts', contextItemIDs: ['req', 'task'] }, { id: 'a2', mode: 'newSession', provider: 'codex' }] })
    expect(first.body.cursor).toBe(1)
    // The cursor moves past it: a poll with that cursor does not list it again, a fresh Control (since 0) does.
    expect((await poll(h, `?since=${first.body.cursor}`)).body.rounds).toHaveLength(0)
    expect((await poll(h)).body.rounds).toHaveLength(1)
    const caps = await json(await h.get('/work/chat'))
    expect(caps.body).toMatchObject({ lensPlans: 1, lensPlansControl: { connected: true, lastSeenSec: 0, autoSend: false } })
    expect((await json(await h.post(`/work/chat/lens-rounds/${id}/history`, { state: 'in_history' })))).toMatchObject({ status: 200, body: { state: 'in_history', inHistory: true } })
    expect((await poll(h)).body.rounds).toHaveLength(0)
    const sent = await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }))
    expect(sent).toEqual({ status: 202, body: { sendRequestId: expect.stringMatching(/^ls_[a-f0-9]{16}$/), state: 'send_requested' } })
    expect((await json(await h.get(`/work/chat/lens-rounds/${id}`))).body.state).toBe('send_requested')
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' })))
      .toMatchObject({ status: 409, body: { error: 'send_in_progress' } })
    const pick = await poll(h)
    expect(pick.body.sends).toEqual([expect.objectContaining({ sendRequestId: sent.body.sendRequestId, roundId: id, workID: WORK, assignmentIds: ['a1', 'a2'],
      confirm: 'two-step', autoSend: false, round: expect.objectContaining({ roundId: id }) })])
    expect((await poll(h)).body.sends).toHaveLength(0) // listed once: listing is the pick-up
    expect((await json(await h.get(`/work/chat/lens-rounds/${id}`))).body.state).toBe('sending')
    const sid = sent.body.sendRequestId
    const partial = await json(await h.post(`/work/chat/lens-send/${sid}/result`, { assignments: [{ id: 'a1', state: 'held', detail: 'Waits for earlier work' }] }))
    expect(partial.body).toMatchObject({ state: 'sending', assignments: [{ id: 'a1', state: 'held', detail: 'Waits for earlier work' }, { id: 'a2', state: 'pending' }] })
    const done = await json(await h.post(`/work/chat/lens-send/${sid}/result`, { assignments: [
      { id: 'a1', state: 'sent', receiptId: 'rcpt-1' }, { id: 'a2', state: 'delivered', receiptId: 'rcpt-2', sessionID: S3 }] }))
    expect(done.body).toMatchObject({ state: 'sent', assignments: [{ id: 'a1', state: 'sent', receiptId: 'rcpt-1', sessionID: S1 }, { id: 'a2', state: 'delivered', receiptId: 'rcpt-2', sessionID: S3 }] })
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:23:00.000Z' })))
      .toMatchObject({ status: 409, body: { error: 'already_sent' } })
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, assignmentIds: ['a1'], confirm: 'two-step', confirmedAt: '2026-10-21T14:23:00.000Z' })))
      .toMatchObject({ status: 409, body: { error: 'already_sent' } })
  })
  it('a partly sent plan sends the rest; the sessions it created do not make it stale', async () => {
    const h = await setup()
    const id = await recordAndHistory(h); await poll(h)
    const s1 = (await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }))).body.sendRequestId
    await poll(h)
    const part = await json(await h.post(`/work/chat/lens-send/${s1}/result`, { assignments: [{ id: 'a1', state: 'sent', receiptId: 'r1' }, { id: 'a2', state: 'failed', detail: 'Codex is at its limit', sessionID: S3 }] }))
    expect(part.body.state).toBe('partly_sent')
    h.state.snapshot = snap([S1, S3]) // the failed New session still left a session behind on the card
    const again = await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:24:00.000Z' }))
    expect(again.status).toBe(202)
    const pick = await poll(h)
    expect(pick.body.sends[0].assignmentIds).toEqual(['a2'])
  })
  it('Auto-send on for the card: a send without confirm is accepted and marked auto-send; the capability carries the global hint', async () => {
    const h = await setup()
    const id = await recordAndHistory(h, 1, true)
    await poll(h, '?autoSend=1')
    expect((await json(await h.get('/work/chat'))).body.lensPlansControl).toMatchObject({ connected: true, autoSend: true })
    expect((await json(await h.get(`/work/chat/lens-rounds/${id}`))).body.autoSendCard).toBe(true)
    const r = await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1 }))
    expect(r.status).toBe(202)
    expect((await poll(h)).body.sends[0]).toMatchObject({ confirm: null, autoSend: true })
  })
  it('Auto-send turned off again on the Mac: a send without confirm is 428 again', async () => {
    const h = await setup()
    const id = await recordAndHistory(h, 1, true)
    await h.post(`/work/chat/lens-rounds/${id}/history`, { state: 'in_history', autoSendCard: false })
    await poll(h)
    expect((await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1 }))).status).toBe(428)
  })
  it('plan_stale when the card’s sessions changed since the plan (a new link, a fork child, a session gone); unknown is never stale', async () => {
    const h = await setup()
    const id = await recordAndHistory(h); await poll(h)
    const body = { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }
    for (const changed of [snap([S1, S2]), snap([S2]), snap([S1], [{ sessionID: S1, mode: 'fork', sourceSessionID: S1, forkChildID: S2 }]), snap([])]) {
      h.state.snapshot = changed
      expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, body))).toMatchObject({ status: 409, body: { error: 'plan_stale' } })
    }
    h.state.snapshot = snap([S1], [{ sessionID: S1 }]) // a Continue receipt to a session already on the card is not a change
    expect((await h.post(`/work/chat/lens-rounds/${id}/send`, body)).status).toBe(202)
  })
  it('a send request not picked up in 10 minutes is expired, and can be asked for again', async () => {
    const h = await setup()
    const id = await recordAndHistory(h); await poll(h)
    const body = { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }
    expect((await h.post(`/work/chat/lens-rounds/${id}/send`, body)).status).toBe(202)
    h.clock.t += LENS_SEND_PICKUP_MS - 1000
    expect((await json(await h.get(`/work/chat/lens-rounds/${id}`))).body.state).toBe('send_requested')
    h.clock.t += 2000
    expect((await json(await h.get(`/work/chat/lens-rounds/${id}`))).body.state).toBe('expired')
    // An expired request is never handed to COS Control later.
    expect((await poll(h)).body.sends).toHaveLength(0)
    expect((await h.post(`/work/chat/lens-rounds/${id}/send`, body)).status).toBe(202)
  })
  it('a picked-up assignment COS Control never reports is failed after 15 minutes, so the lens stops polling', async () => {
    const h = await setup()
    const id = await recordAndHistory(h); await poll(h)
    const sid = (await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }))).body.sendRequestId
    await poll(h)
    await h.post(`/work/chat/lens-send/${sid}/result`, { assignments: [{ id: 'a1', state: 'sent' }] })
    h.clock.t += LENS_SEND_REPORT_MS + 1000
    const v = (await json(await h.get(`/work/chat/lens-rounds/${id}`))).body
    expect(v).toMatchObject({ state: 'partly_sent', assignments: [{ id: 'a1', state: 'sent' }, { id: 'a2', state: 'failed', detail: 'COS Control did not report this send.' }] })
  })
  it('a round is kept 14 days, then 404', async () => {
    const h = await setup()
    const id = (await json(await h.post('/work/chat/lens-rounds', round()))).body.roundId
    h.clock.t += LENS_ROUND_TTL_MS - 1000
    expect((await h.get(`/work/chat/lens-rounds/${id}`)).status).toBe(200)
    h.clock.t += 2000
    expect(await json(await h.get(`/work/chat/lens-rounds/${id}`))).toMatchObject({ status: 404, body: { error: 'unknown_round' } })
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' })))
      .toMatchObject({ status: 404, body: { error: 'unknown_round' } })
  })
  it('validates the send body', async () => {
    const h = await setup()
    const id = await recordAndHistory(h); await poll(h)
    for (const [b, field] of [[{ v: 2 }, 'v'], [{ assignmentIds: [] }, 'assignmentIds'], [{ assignmentIds: ['a9'], confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }, 'assignmentIds'],
      [{ confirm: 'one-step' }, 'confirm'], [{ confirm: 'two-step' }, 'confirmedAt']] as const) {
      expect(await json(await h.post(`/work/chat/lens-rounds/${id}/send`, b))).toMatchObject({ status: 400, body: { error: 'invalid_lens_round', field } })
    }
  })
})

describe('stop', () => {
  it('202 and COS Control gets the stop with the send it belongs to; reports stopped; 423 without Control', async () => {
    const h = await setup()
    const id = await recordAndHistory(h)
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/stop`, { assignmentIds: ['a1'] }))).toMatchObject({ status: 423, body: { error: 'control_not_connected' } })
    await poll(h)
    const sid = (await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }))).body.sendRequestId
    await poll(h)
    await h.post(`/work/chat/lens-send/${sid}/result`, { assignments: [{ id: 'a1', state: 'sent', receiptId: 'r1' }, { id: 'a2', state: 'held' }] })
    const stop = await json(await h.post(`/work/chat/lens-rounds/${id}/stop`, { assignmentIds: ['a2'] }))
    expect(stop).toEqual({ status: 202, body: { stopRequestId: expect.stringMatching(/^lst_[a-f0-9]{16}$/), state: 'stop_requested' } })
    const inbox = await poll(h)
    expect(inbox.body.stops).toEqual([expect.objectContaining({ stopRequestId: stop.body.stopRequestId, roundId: id, assignmentIds: ['a2'], sendRequestId: sid })])
    expect((await poll(h)).body.stops).toHaveLength(0)
    const after = await json(await h.post(`/work/chat/lens-send/${sid}/result`, { assignments: [{ id: 'a2', state: 'stopped', detail: 'Stopped from the lens' }] }))
    expect(after.body).toMatchObject({ state: 'partly_sent', assignments: [{ id: 'a1', state: 'sent' }, { id: 'a2', state: 'stopped' }] })
    expect(await json(await h.post(`/work/chat/lens-rounds/${id}/stop`, { assignmentIds: ['a7'] }))).toMatchObject({ status: 400, body: { field: 'assignmentIds' } })
  })
})

describe('COS Control routes, auth and maintenance', () => {
  it('inbox, history and result answer only this Mac', async () => {
    const h = await setup()
    const id = (await json(await h.post('/work/chat/lens-rounds', round()))).body.roundId
    h.state.local = false
    expect(await json(await h.get('/work/chat/lens-inbox'))).toMatchObject({ status: 403, body: { error: 'local_only' } })
    expect((await h.post(`/work/chat/lens-rounds/${id}/history`, { state: 'in_history' })).status).toBe(403)
    expect((await h.post('/work/chat/lens-send/ls_0000000000000000/result', { assignments: [{ id: 'a1', state: 'sent' }] })).status).toBe(403)
    // A phone poll never counts as COS Control being connected.
    expect((await json(await h.get('/work/chat'))).body.lensPlansControl.connected).toBe(false)
    // The lens routes themselves work from the network.
    expect((await h.get(`/work/chat/lens-rounds/${id}`)).status).toBe(200)
  })
  it('a result for a send that was never picked up is refused; an unknown send 404; bad states 400', async () => {
    const h = await setup()
    const id = await recordAndHistory(h); await poll(h)
    const sid = (await json(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }))).body.sendRequestId
    expect(await json(await h.post(`/work/chat/lens-send/${sid}/result`, { assignments: [{ id: 'a1', state: 'sent' }] }))).toMatchObject({ status: 409, body: { error: 'send_not_picked_up' } })
    await poll(h)
    expect(await json(await h.post('/work/chat/lens-send/ls_0123456789abcdef/result', { assignments: [{ id: 'a1', state: 'sent' }] }))).toMatchObject({ status: 404, body: { error: 'unknown_send' } })
    expect(await json(await h.post(`/work/chat/lens-send/${sid}/result`, { assignments: [{ id: 'a1', state: 'done' }] }))).toMatchObject({ status: 400, body: { field: 'assignments.state' } })
    expect((await h.post(`/work/chat/lens-rounds/${id}/history`, { state: 'sent' })).status).toBe(400)
    expect((await h.get('/work/chat/lens-inbox?since=abc')).status).toBe(400)
  })
  it('401 without the token; 503 maintenance while admissions are closed or the lease is refused; every lease is released', async () => {
    const h = await setup()
    expect((await fetch(h.url + '/work/chat/lens-rounds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(round()) })).status).toBe(401)
    h.state.admissions = false
    for (const r of [await h.post('/work/chat/lens-rounds', round()), await h.get('/work/chat/lens-rounds/lr_0123456789abcdef'), await h.get('/work/chat/lens-inbox')]) {
      expect(await json(r)).toMatchObject({ status: 503, body: { error: 'maintenance', message: expect.any(String) } })
    }
    h.state.admissions = true; h.state.leaseFails = true
    expect(await json(await h.post('/work/chat/lens-rounds', round()))).toMatchObject({ status: 503, body: { error: 'maintenance' } })
    h.state.leaseFails = false
    await h.post('/work/chat/lens-rounds', round()); await h.post('/work/chat/lens-rounds', { v: 9 })
    expect(h.leases.taken).toBe(2); expect(h.leases.released).toBe(2)
  })
})

describe('the existing Work chat routes are unchanged', () => {
  it('GET /api/work/chat keeps every earlier field and only adds lensPlans and lensPlansControl', async () => {
    const h = await setup()
    const caps = (await json(await h.get('/work/chat'))).body
    expect(caps).toEqual({ protocolVersion: 1, planner: 'sonnet', planners: ['sonnet', 'opus'], effort: expect.any(String), efforts: expect.any(Array),
      automaticProviders: ['claude', 'codex'], maxAssignments: 3, contextItems: true, maxContextItems: 40, queueRounds: true, references: true, maxReferences: 6,
      orchestrator: 1, lensPlans: 1, lensPlansControl: { connected: false, lastSeenSec: null, autoSend: false } })
  })
  it('POST /api/work/chat still answers a plan and never records a lens round', async () => {
    const h = await setup()
    const r = await h.post('/work/chat', { workID: WORK, revision: 'a'.repeat(64), question: 'What next?', context: '', sessions: [], history: [], updates: [], mode: 'plan' })
    expect(r.status).not.toBe(404)
    expect((await poll(h)).body.rounds).toHaveLength(0)
  })
})

describe('store: storage, bounds and pure rules', () => {
  it('writes data atomically at 0600 and reads it back after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lens-rounds-')), path = join(dir, 'work-lens-rounds.json')
    let t = 1_000_000
    const a = new LensRoundStore(path, () => t)
    const { round: r } = a.record(parseLensRound(round()), [S1])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const b = new LensRoundStore(path, () => t)
    expect(b.find(r.roundId)).toMatchObject({ roundId: r.roundId, cardSessions: [S1], assignments: [{ prompt: 'Fix the bug in work-chat.ts' }, { mode: 'newSession' }] })
    expect(b.replay(uuid(1))?.roundId).toBe(r.roundId)
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([])
  })
  it('the process-wide store is in memory inside a test: recording never writes the data file', () => {
    const p = dataPath('work-lens-rounds.json'), before = existsSync(p) ? readFileSync(p, 'utf8') : null
    defaultLensRoundStore().record(parseLensRound(round(900)), null)
    expect(existsSync(p) ? readFileSync(p, 'utf8') : null).toBe(before)
  })
  it('moves an unreadable file aside rather than overwriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lens-rounds-')), path = join(dir, 'work-lens-rounds.json')
    writeFileSync(path, '{not json')
    const s = new LensRoundStore(path, () => 42)
    expect(existsSync(path + '.unreadable-42')).toBe(true)
    s.record(parseLensRound(round()), null)
    expect(readFileSync(path + '.unreadable-42', 'utf8')).toBe('{not json')
  })
  it('keeps at most 200 rounds, dropping the oldest idle one first', () => {
    let t = 1
    const s = new LensRoundStore(null, () => t)
    const first = s.record(parseLensRound(round(1)), null).round
    s.markInHistory(first.roundId, true)
    s.inbox(0, false)
    s.requestSend(first.roundId, { confirm: 'two-step', confirmedAt: '2026-10-21T14:22:00.000Z' }, { cardSessions: null, controlConnected: true })
    const second = s.record(parseLensRound(round(2)), null).round
    for (let i = 3; i <= LENS_ROUNDS_MAX + 1; i++) s.record(parseLensRound(round(i)), null)
    expect(s.find(first.roundId)).toBeDefined() // a send in flight is never dropped for room
    expect(s.find(second.roundId)).toBeUndefined()
    const box = s.inbox(0, false)
    expect(box.rounds.length + box.sends.length).toBe(50) // never more than 50 in all
  })
  it('cardSessionsOf, planIsStale and sendOutcome', () => {
    expect(cardSessionsOf(null, WORK)).toBeNull()
    expect(cardSessionsOf(snap([S2], [{ sessionID: S1, mode: 'fork', sourceSessionID: S1, forkChildID: null }, { sessionID: S3 }]), WORK)).toEqual([S3, S2].sort())
    const r = { cardSessions: [S1], assignments: [{ sessionID: S1 }, { reportedSessionID: S3 }] } as unknown as LensRound
    expect(planIsStale(r, null)).toBe(false)
    expect(planIsStale(r, [S1])).toBe(false)
    expect(planIsStale(r, [])).toBe(true) // the plan's target left the card
    expect(planIsStale(r, [S1, S2])).toBe(true)
    expect(planIsStale(r, [S1, S3])).toBe(false) // the round's own New session
    expect(sendOutcome(['sent', 'delivered'])).toBe('sent')
    expect(sendOutcome(['sent', 'failed'])).toBe('partly_sent')
    expect(sendOutcome(['refused', 'stopped'])).toBe('refused')
  })
})
