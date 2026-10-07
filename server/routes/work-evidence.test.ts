import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJevRouter } from './jev.js'
import { WorkEvidenceChecker, defaultWorkEvidenceDeps } from '../lib/work-evidence.js'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))) })
const ID = '5755b516df8f'
const OFFER = 'https://bottlepos.com/october-switch-offer'
const row = { domain: 'quilt', id: ID, workIdentity: 'b'.repeat(12), title: 'Launch the October switch offer', text: 'Launch the October switch offer page and ads',
  meetingRefs: [{ recordId: 'r', domain: 'quilt', month: '2026-10', filename: 'm.md', title: 'Pete sync' }] }
const body = { domain: 'quilt', id: ID, follows: [{ provider: 'claude', sessionId: 'ff34d7bf-3338-4462-8234-78f8b86de158', cursor: null }],
  clauses: [`${OFFER} page is live`, 'Facebook ads are running against it'], since: '2026-10-02T23:52:00Z' }

async function setup(overrides: Record<string, unknown> = {}) {
  const evidence = { enabled: vi.fn(() => true), check: vi.fn(async () => ({ provider: 'jev', basis: 'clauses', clauses: [] })) }
  const deps = { jev: { status: vi.fn(), resetForNewKey: vi.fn() }, recommender: { recommend: vi.fn() }, list: vi.fn(async () => [row, { ...row, domain: 'personal', title: 'Other domain' }]),
    validate: vi.fn(async () => ({ ok: true })), save: vi.fn(), searchJev: { resetForNewKey: vi.fn() }, evidenceJev: { resetForNewKey: vi.fn() }, evidence, ...overrides }
  const app = express(); app.use(express.json())
  app.use('/api', (req, res, next) => req.header('X-COS-Token') === 't' ? next() : res.sendStatus(401))
  app.use('/api', createJevRouter(deps as any))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const post = (payload: unknown, token = 't') => fetch(base + '/work-board/evidence-check', { method: 'POST', headers: { 'X-COS-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  return { deps, post, base }
}

it('requires auth, judges the board card (never client text), and is never cached', async () => {
  const s = await setup()
  expect((await s.post(body, 'nope')).status).toBe(401)
  const res = await s.post(body)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(s.deps.evidence.check).toHaveBeenCalledWith(
    { domain: 'quilt', id: ID, follows: body.follows, clauses: body.clauses, since: body.since },
    { id: ID, workIdentity: row.workIdentity, title: row.title, text: row.text, meetingRefs: row.meetingRefs })
  // By Work identity too, in the named domain only.
  expect((await s.post({ ...body, id: row.workIdentity })).status).toBe(200)
  expect((await s.post({ ...body, id: 'c'.repeat(12) })).status).toBe(404)
  expect(await (await s.post({ ...body, domain: 'personal', id: 'd'.repeat(12) })).json()).toMatchObject({ error: { code: 'task_not_found' } })
})

it('refuses any body that is not exactly the contract', async () => {
  const s = await setup()
  for (const bad of [{ ...body, extra: true }, { ...body, follows: undefined }, { ...body, clauses: Array(7).fill('x') }, { ...body, since: 'soon' },
    { ...body, follows: [{ ...body.follows[0], sessionId: '../x' }] }, { ...body, follows: Array(5).fill(0).map((_, i) => ({ ...body.follows[0], sessionId: `${i}0000000-aaaa` })) }]) {
    const res = await s.post(bad)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_evidence_request')
  }
  expect(s.deps.evidence.check).not.toHaveBeenCalled()
  expect(s.deps.list).not.toHaveBeenCalled()
})

it('the master switch answers evidence_disabled before reading the board', async () => {
  const s = await setup()
  s.deps.evidence.enabled.mockReturnValue(false)
  expect(await (await s.post(body)).json()).toEqual({ provider: 'none', reason: 'evidence_disabled' })
  expect(s.deps.list).not.toHaveBeenCalled()
  expect(s.deps.evidence.check).not.toHaveBeenCalled()
})

it('a failure is advice, never an error status', async () => {
  const s = await setup({ list: vi.fn(async () => { throw new Error('bridge down') }) })
  const res = await s.post(body)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ provider: 'none', reason: 'evidence_unavailable' })
})

it('a newly saved key also clears the evidence check\'s own breaker', async () => {
  const s = await setup()
  const res = await fetch(s.base + '/jev-key/set', { method: 'POST', headers: { 'X-COS-Token': 't', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'ts_live_' + 'k'.repeat(32) }) })
  expect(res.status).toBe(200)
  expect(s.deps.evidenceJev.resetForNewKey).toHaveBeenCalledTimes(1)
})

it('end to end through the real checker: Pete\'s card reads 1 of 2', async () => {
  const ask = vi.fn(async (state: any) => {
    const url = state.evidence.findIndex((e: any) => e.source === 'url')
    return { model: 'jev-1.13.0', inputTokens: 1, answers: {
      v0: { probabilities: { met: 0.93, not_met: 0.04, unclear: 0.03 } }, k0: { probabilities: { fact: 0.95, none: 0.05 } }, e0: { probabilities: { [`e${url}`]: 0.9 } },
      v1: { probabilities: { met: 0.05, not_met: 0.85, unclear: 0.1 } }, k1: { probabilities: { intent: 0.8, fact: 0.2 } }, e1: { probabilities: { none: 0.6 } } } }
  })
  const evidence = new WorkEvidenceChecker(defaultWorkEvidenceDeps({
    jev: { ask } as any, findSession: async () => null, enabled: () => true, now: () => Date.parse('2026-10-07T21:32:00Z'),
    fetchUrl: async () => ({ status: 200, finalUrl: OFFER, title: 'Switch to Bottle POS: $3,000 + Free Hardware', markerFound: true }),
    meeting: async () => null, slack: async () => ({ available: false }),
  }))
  const s = await setup({ evidence })
  const answer = await (await s.post(body)).json()
  expect(answer).toMatchObject({ provider: 'jev', basis: 'clauses', sources: ['url'], truncated: false, cached: false, skipped: null,
    clauses: [{ verdict: 'met', kind: 'fact', deterministic: true, evidence: { source: 'url', ref: OFFER } }, { verdict: 'not_met', kind: 'intent', evidence: null, deterministic: false }],
    cursors: [{ provider: 'claude', cursor: null, missing: true }] })
  expect(answer.clauses.filter((c: any) => c.verdict === 'met')).toHaveLength(1)
})

it('index.ts lets the evidence check past the mutation lease and wires the meeting resolver', () => {
  const index = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  expect(index).toContain('if (isReadOnlyApiPost(req.method, req.path)) return next()')
  expect(index).toContain('createJevRouter({ evidence: workEvidence')
  expect(index).toMatch(/meeting: async ref => \{\n\s+const detail = await resolveSavedMeetingDetail\(/)
})
