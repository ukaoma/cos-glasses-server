/**
 * Work chat on COS Control Web: plans the web makes go through the lens-round contract with source "web"
 * (routes/work-lens-rounds.ts, lib/work-lens-rounds.ts). These tests sit apart from work-lens-rounds.test.ts on purpose:
 * that file is unchanged and still passes, which is the proof that the lens path is the same, byte for byte.
 */
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { type Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkLensRoundsRouter, type WorkLensRoundsDeps } from './work-lens-rounds.js'
import { createWorkChatRouter } from './work-chat.js'
import { LensRoundStore, parseLensRound, sameRoundContent } from '../lib/work-lens-rounds.js'
import type { ControlSnapshot } from '../lib/work-orchestrator/snapshot.js'

const WORK = 'task:quilt:420a0114f1a9'
const S1 = 'claude:11111111-1111-4111-8111-111111111111'
const UUID = '00000001-0000-4000-8000-000000000000'
const lensId = (u = UUID) => `lens-${u}`
const webId = (u = UUID) => `web-${u}`
const plan = (extra: Record<string, unknown> = {}) => ({
  v: 1, workID: WORK, clientRoundId: webId(), question: 'Ship the fix and update the doc', answer: 'Two sessions: the fix, then the doc.',
  planner: 'opus', effort: 'high', orchestrator: true,
  assignments: [
    { id: 'a1', mode: 'continue', sessionID: S1, provider: 'claude', prompt: 'Fix the bug in work-chat.ts' },
    { id: 'a2', mode: 'newSession', provider: 'codex', prompt: 'Update docs/work-orchestrator.md' },
  ],
  source: 'web', createdAt: '2026-11-06T23:20:00.000Z', ...extra,
})
const lensPlan = (extra: Record<string, unknown> = {}) => plan({ clientRoundId: lensId(), source: 'lens', ...extra })
const snap = (): ControlSnapshot => ({ version: 1, controlVersion: '0.5.375', sentAt: 0, receivedAt: 0, live: null,
  links: [{ sessionID: S1, workID: WORK, at: 1 }], receipts: [] })

interface Harness { store: LensRoundStore; post: (p: string, b?: unknown) => Promise<{ status: number; body: any }>; get: (p: string) => Promise<{ status: number; body: any }> }
const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })
async function setup(opts: { path?: string | null; extra?: Partial<WorkLensRoundsDeps> } = {}): Promise<Harness> {
  const clock = { t: Date.parse('2026-11-06T23:21:00.000Z') }
  const store = new LensRoundStore(opts.path ?? null, () => clock.t)
  const app = express(); app.use(express.json({ limit: '10mb' }))
  app.use('/api', createWorkChatRouter({ run: (async () => ({ text: '{}' })) as any, admissions: () => true, lease: () => ({ release() {} }) as any,
    planLog: () => {}, lensPlansControl: () => store.controlStatus() }))
  app.use('/api', createWorkLensRoundsRouter({ store, snapshot: () => snap(), admissions: () => true, isLocal: () => true, knownWork: async () => true,
    lease: () => ({ release() {} }), ...opts.extra }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const url = `http://127.0.0.1:${(server.address() as any).port}/api`
  const headers = { 'content-type': 'application/json' }
  const read = async (r: Response) => ({ status: r.status, body: await r.json() as any })
  return { store,
    post: async (p, b) => read(await fetch(url + p, { method: 'POST', headers, body: b === undefined ? undefined : JSON.stringify(b) })),
    get: async p => read(await fetch(url + p)) }
}

describe('what the web asks before it shows Work chat', () => {
  it('GET /api/work/chat/web-plans says webPlans 1; GET /api/work/chat carries no new field', async () => {
    const h = await setup()
    expect(await h.get('/work/chat/web-plans')).toEqual({ status: 200, body: { protocolVersion: 1, webPlans: 1, sources: ['lens', 'web'] } })
    const caps = (await h.get('/work/chat')).body
    expect(caps).not.toHaveProperty('webPlans')
    expect(Object.keys(caps)).toEqual(['protocolVersion', 'planner', 'planners', 'effort', 'efforts', 'automaticProviders', 'maxAssignments', 'contextItems', 'maxContextItems',
      'queueRounds', 'references', 'maxReferences', 'orchestrator', 'lensPlans', 'lensPlansControl'])
  })
})

describe('a web round is recorded, viewed and listed as web, and only as web', () => {
  it('records 201, answers the same plan again 200 with the same body, and refuses the id for a different plan 409', async () => {
    const h = await setup()
    const first = await h.post('/work/chat/lens-rounds', plan())
    expect(first.status).toBe(201)
    expect(await h.post('/work/chat/lens-rounds', plan())).toEqual({ status: 200, body: first.body })
    // createdAt is when the plan was made; a retry may carry it again unchanged or not, and it is the same plan.
    expect(await h.post('/work/chat/lens-rounds', plan({ createdAt: '2026-11-06T23:20:05.000Z' }))).toEqual({ status: 200, body: first.body })
    for (const changed of [{ question: 'changed text' }, { answer: 'Another answer.' }, { planner: 'sonnet' }, { effort: 'low' },
      { assignments: [{ id: 'a1', mode: 'continue', sessionID: S1, provider: 'claude', prompt: 'A different prompt' }] }]) {
      const r = await h.post('/work/chat/lens-rounds', plan(changed))
      expect([r.status, r.body.error], JSON.stringify(changed)).toEqual([409, 'round_id_conflict'])
    }
    expect(h.store.find(first.body.roundId)).toMatchObject({ question: 'Ship the fix and update the doc', assignments: [{ prompt: 'Fix the bug in work-chat.ts' }, { mode: 'newSession' }] })
  })
  it('a lens repeat keeps the lens rule: the stored round is answered 200 whatever the repeat carries', async () => {
    const h = await setup()
    const first = await h.post('/work/chat/lens-rounds', lensPlan())
    expect(await h.post('/work/chat/lens-rounds', lensPlan({ question: 'changed text' }))).toEqual({ status: 200, body: first.body })
  })
  it('a web round never passes as a lens round, and a lens round never as a web one', async () => {
    const h = await setup()
    // The same uuid under each prefix is two rounds, each with its own source.
    const web = await h.post('/work/chat/lens-rounds', plan())
    const lens = await h.post('/work/chat/lens-rounds', lensPlan())
    expect(web.status).toBe(201); expect(lens.status).toBe(201)
    expect(web.body.roundId).not.toBe(lens.body.roundId)
    expect((await h.get(`/work/chat/lens-rounds/${web.body.roundId}`)).body.source).toBe('web')
    expect((await h.get(`/work/chat/lens-rounds/${lens.body.roundId}`)).body).not.toHaveProperty('source')
    // A web id with source lens, a lens id with source web: refused, never stored.
    for (const [body, field] of [[plan({ source: 'lens' }), 'clientRoundId'], [lensPlan({ source: 'web' }), 'clientRoundId'],
      [plan({ source: 'glasses' }), 'source'], [plan({ source: undefined }), 'source']] as const) {
      const r = await h.post('/work/chat/lens-rounds', body)
      expect([r.status, r.body.error, r.body.field], JSON.stringify(body.source)).toEqual([400, 'invalid_lens_round', field])
    }
    const box = (await h.get('/work/chat/lens-inbox?since=0')).body
    expect(box.rounds.map((r: { roundId: string; source?: string }) => [r.roundId, r.source ?? null]).sort())
      .toEqual([[web.body.roundId, 'web'], [lens.body.roundId, null]].sort())
  })
  it('validates a web- id exactly as strictly as a lens- id', async () => {
    const h = await setup()
    const bad = ['web-', 'web-00000001', `web-${'abcdef01-0000-4000-8000-0000000000ab'.toUpperCase()}`, `web-${UUID}0`, ` web-${UUID}`, `web-${UUID.replace(/-/g, '')}`, `web_${UUID}`, `WEB-${UUID}`]
    for (const id of bad) {
      const web = await h.post('/work/chat/lens-rounds', plan({ clientRoundId: id }))
      const lens = await h.post('/work/chat/lens-rounds', lensPlan({ clientRoundId: id.replace(/web/i, m => (m === 'WEB' ? 'LENS' : 'lens')) }))
      expect([web.status, web.body.field], id).toEqual([400, 'clientRoundId'])
      expect([lens.status, lens.body.field], id).toEqual([400, 'clientRoundId'])
    }
  })
  it('keeps source web across a restart; a lens round is written with no source key at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-rounds-')), path = join(dir, 'work-lens-rounds.json')
    const a = new LensRoundStore(path, () => 1_000_000)
    const web = a.record(parseLensRound(plan()), null).round
    const lens = a.record(parseLensRound(lensPlan()), null).round
    const file = JSON.parse(readFileSync(path, 'utf8'))
    expect(file.rounds.find((r: { roundId: string }) => r.roundId === lens.roundId)).not.toHaveProperty('source')
    const b = new LensRoundStore(path, () => 1_000_000)
    expect(b.find(web.roundId)?.source).toBe('web')
    expect(b.find(lens.roundId)).not.toHaveProperty('source')
  })
  it('sameRoundContent compares the plan, not when it was made', () => {
    const s = new LensRoundStore(null, () => 1)
    const r = s.record(parseLensRound(plan()), null).round
    expect(sameRoundContent(r, parseLensRound(plan({ createdAt: '2026-11-07T00:00:00.000Z' })))).toBe(true)
    expect(sameRoundContent(r, parseLensRound(plan({ assignments: [{ id: 'a1', mode: 'fork', sessionID: S1, provider: 'claude', prompt: 'Fix the bug in work-chat.ts' }] })))).toBe(false)
  })
})

describe('a web round is sent only by COS Control, only with the two-step confirm', () => {
  it('428 without the confirm, 423 without COS Control, 202 once, then send_in_progress; the send carries the web round', async () => {
    const h = await setup()
    const id = (await h.post('/work/chat/lens-rounds', plan())).body.roundId
    expect(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1 })).toMatchObject({ status: 428, body: { error: 'confirmation_required' } })
    expect(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-11-06T23:22:00.000Z' }))
      .toMatchObject({ status: 423, body: { error: 'control_not_connected' } })
    expect(h.store.find(id)?.sends).toHaveLength(0)
    await h.get('/work/chat/lens-inbox?since=0')
    expect(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-11-06T23:22:00.000Z', assignmentIds: ['a1'] }))
      .toMatchObject({ status: 202, body: { state: 'send_requested' } })
    expect(await h.post(`/work/chat/lens-rounds/${id}/send`, { v: 1, confirm: 'two-step', confirmedAt: '2026-11-06T23:22:01.000Z' }))
      .toMatchObject({ status: 409, body: { error: 'send_in_progress' } })
    expect((await h.get(`/work/chat/lens-rounds/${id}`)).body).toMatchObject({ state: 'send_requested', source: 'web' })
    const pick = (await h.get('/work/chat/lens-inbox?since=0')).body
    expect(pick.sends).toEqual([expect.objectContaining({ roundId: id, assignmentIds: ['a1'], confirm: 'two-step', round: expect.objectContaining({ source: 'web' }) })])
  })
})
