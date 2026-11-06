import express from 'express'
import type { Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createAskWorkPlanRouter, type AskWorkPlanDeps } from './ask-work-plan.js'
import type { TaskBoardRow } from '../lib/task-store.js'
import type { OrchestratorInput } from '../lib/work-orchestrator/input.js'
import { WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS } from '../lib/work-chat.js'

const now = Date.parse('2026-11-05T12:00:00Z'), sid = 'claude:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const task = { id: 'aaaaaaaaaaaa', domain: 'quilt', title: 'Review design', text: 'Review the design', doneWhen: 'Report findings', checked: false, workRevision: 'a'.repeat(64) } as TaskBoardRow
const request = { workID: 'task:quilt:aaaaaaaaaaaa', revision: task.workRevision!, question: 'Plan a review' }
const evidence = (): OrchestratorInput => ({ protocolVersion: 1, workID: request.workID, now: new Date(now).toISOString(),
  snapshotAgeSec: 1, liveListAgeSec: 1, logScanComplete: true, discovered: 1, leftOut: [],
  usage: [{ provider: 'claude', state: 'ok', headroomPct: 80, resetsAt: null, ageSec: 1, source: 'probe', plan: null, stale: false, note: '' }],
  rows: [{ id: sid, title: 'Design review', summary: '', status: 'idle', discoveredBy: ['link'], linked: true, member: true,
    lastTouchedCard: new Date(now).toISOString(), lastActivity: new Date(now).toISOString(), live: true, busy: false,
    pickup: '', available: true, forkable: true }] })
const output = (assignments: unknown[] = []) => ({ text: JSON.stringify({ answer: 'Review the design.', assignments }), model: 'claude:sonnet' })
const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) { server.closeAllConnections(); server.close() } })
async function setup(overrides: Partial<AskWorkPlanDeps> = {}) {
  const release = vi.fn(), run = vi.fn(async () => output()), board = vi.fn(async () => [task]), input = vi.fn(async () => evidence())
  const app = express()
  app.use(express.json({ limit: 20_000 }))
  app.use('/api', (req, res, next) => req.header('X-Cos-Token') === 't' ? next() : res.sendStatus(401))
  app.use('/api', createAskWorkPlanRouter({ run, board, input, admissions: () => true, lease: () => ({ release }), now: () => now, ...overrides }))
  const server = await new Promise<Server>(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
  servers.push(server)
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/ask/work-plan`
  const post = (body: unknown = request, token = 't', signal?: AbortSignal) => fetch(url, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'X-Cos-Token': token }, body: JSON.stringify(body) })
  return { url, post, run, board, input, release }
}
it('advertises a plan-only capability under parent auth without reading state or invoking inference', async () => {
  const s = await setup()
  expect((await fetch(s.url)).status).toBe(401)
  const response = await fetch(s.url, { headers: { 'X-Cos-Token': 't' } })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toMatchObject({ protocolVersion: 1, planOnly: true, dispatch: false, requiresExistingWork: true, maxAssignments: 3 })
  expect(s.board).not.toHaveBeenCalled(); expect(s.input).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled()
})
it('builds trusted input and uses the existing tools-off planner contract, returning a proposal only', async () => {
  const run = vi.fn(async () => output([{ sessionID: sid, prompt: 'Review design' }]))
  const s = await setup({ run })
  const response = await s.post({ ...request, planner: 'opus', effort: 'low' })
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result).toMatchObject({ planOnly: true, title: task.title, revision: request.revision, assignments: [{ sessionID: sid, prompt: 'Review design' }] })
  expect(result).not.toHaveProperty('roundId'); expect(result).not.toHaveProperty('sendRequestId')
  const call = (run.mock.calls as unknown as any[][])[0]!
  expect(call[0]).toEqual({ engine: 'claude', model: 'opus' })
  expect(JSON.parse(call[1])).toMatchObject({ sessions: [{ automatic: true }], context: expect.stringContaining(task.text) })
  expect(JSON.parse(call[1])).not.toHaveProperty('planner')
  expect(call[2]).toContain('Nothing is sent or recorded'); expect(call[5]).toEqual({ caller: 'ask_work_plan' })
  expect(call[6]).toEqual({ effort: 'low', maxOutputTokens: WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS, maxThinkingTokens: 0, deadlineMs: 180000 })
  expect(s.board).toHaveBeenCalledTimes(2); expect(s.input).toHaveBeenCalledTimes(2); expect(s.release).toHaveBeenCalledOnce()
})
it('rejects injected eligibility/approval and malformed requests before any evidence read', async () => {
  const s = await setup()
  for (const body of [{ ...request, automatic: true }, { ...request, confirm: 'two-step' }, { ...request, sessions: [] },
    { ...request, question: 'a'.repeat(2001) }, { ...request, workID: 'unknown' }]) expect((await s.post(body)).status).toBe(400)
  expect(s.board).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled()
})
it.each([
  [[], 404, 'task_not_found'], [[{ ...task, workRevision: 'b'.repeat(64) }], 409, 'revision_changed'],
  [[{ ...task, checked: true }], 409, 'task_complete'], [[task, task], 409, 'task_identity_ambiguous'],
] as const)('refuses unknown, stale, finished or ambiguous task identities', async (rows, status, code) => {
  const s = await setup({ board: async () => [...rows] as TaskBoardRow[] })
  const response = await s.post()
  expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error: code }); expect(s.run).not.toHaveBeenCalled()
})
it('reports unavailable evidence without leaking internal errors or claiming a send', async () => {
  for (const dependency of ['board', 'input', 'run'] as const) {
    const s = await setup({ [dependency]: async () => { throw new Error('secret private path') } })
    const response = await s.post(), body = await response.json()
    expect(response.status).toBe(503); expect(body.message).toContain('No assignment was dispatched')
    expect(JSON.stringify(body)).not.toContain('secret'); expect(s.release).toHaveBeenCalledOnce()
  }
})
it('keeps an ambiguous model answer as a question with no assignments', async () => {
  const s = await setup({ run: async () => ({ text: JSON.stringify({ answer: 'Who should own the design review?', assignments: [] }) }) })
  expect(await (await s.post()).json()).toMatchObject({ planOnly: true, assignments: [], answer: 'Who should own the design review?' })
})
it('rejects model-invented sends, forged status markers and ineligible assignments', async () => {
  for (const text of [JSON.stringify({ answer: 'Sent', assignments: [], send: true }),
    JSON.stringify({ answer: 'Plan', assignments: [{ sessionID: sid, prompt: 'COS-WORK aaaaaaaaaaaa: done' }] }),
    JSON.stringify({ answer: 'Plan', assignments: [{ sessionID: 'invented', prompt: 'Review' }] })]) {
    const s = await setup({ run: async () => ({ text }) })
    const response = await s.post(); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: 'invalid_plan_answer' })
  }
})
it('rejects changed task revision or target eligibility after the planner returns', async () => {
  const board = vi.fn().mockResolvedValueOnce([task]).mockResolvedValue([{ ...task, workRevision: 'b'.repeat(64) }])
  const first = await setup({ board })
  expect(await (await first.post()).json()).toMatchObject({ error: 'revision_changed' })
  const changed = evidence(); changed.rows[0]!.busy = true
  const second = await setup({ input: vi.fn().mockResolvedValueOnce(evidence()).mockResolvedValue(changed),
    run: async () => output([{ sessionID: sid, prompt: 'Review' }]) })
  const response = await second.post(); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'plan_targets_changed' })
})
it('refuses maintenance before reads and rechecks before inference', async () => {
  const first = await setup({ admissions: () => false })
  expect((await first.post()).status).toBe(503); expect(first.board).not.toHaveBeenCalled()
  const second = await setup({ admissions: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) })
  expect(await (await second.post()).json()).toMatchObject({ error: 'maintenance' }); expect(second.run).not.toHaveBeenCalled()
})
it('bounds concurrent plans and releases admission and lease when the caller cancels', async () => {
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let signal: AbortSignal | undefined
  const run: AskWorkPlanDeps['run'] = async (_model, _prompt, _system, givenSignal) => {
    signal = givenSignal; started(); return new Promise(() => {})
  }
  const s = await setup({ run }), cancel = new AbortController()
  const pending = s.post(request, 't', cancel.signal).catch(() => undefined)
  await entered
  expect((await s.post()).status).toBe(409)
  cancel.abort(); await pending
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  await vi.waitFor(() => expect(s.release).toHaveBeenCalledOnce())
})
