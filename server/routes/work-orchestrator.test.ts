// 6.83.0 Work orchestrator routes and the planner contract, by execution: the snapshot push and input route, the
// orchestrator-only schema and assignment kinds, the old-client golden, every plan logged, and the toadstone journey
// (fake sessions and logs in the shapes of 2026-10-20: a planner that saw no sessions must now see both).
import express from 'express'
import { describe, expect, it, vi } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { type Server } from 'node:http'
import { createWorkOrchestratorRouter, readUsage } from './work-orchestrator.js'
import { UsageMonitor, parseClaudeUsage, parseCodexUsage } from '../lib/work-orchestrator/usage.js'
import { orchestratorInputFor } from '../lib/work-orchestrator/runtime.js'
import { createWorkChatRouter, planLogRow } from './work-chat.js'
import { parseWorkChatInput, parseWorkChatAnswer, WORK_CHAT_SYSTEM, WORK_CHAT_ORCHESTRATOR_RULES, WORK_CHAT_OUTPUT_TOKENS, WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS } from '../lib/work-chat.js'
import { parseSnapshot, type ControlSnapshot } from '../lib/work-orchestrator/snapshot.js'
import { TagIndex } from '../lib/work-orchestrator/tag-index.js'
import { buildOrchestratorInput } from '../lib/work-orchestrator/input.js'
import { appendPlanLog } from '../lib/work-orchestrator/plan-log.js'
import { fakeHome, claudeLog, codexLog, TEMPLATE_LINE } from '../lib/work-orchestrator/__fixtures__/fake-home.js'

const CARD = 'task:quilt:420a0114f1a9'
const SBU = 'claude:32386d7e-f751-41c5-a185-a0d731416a01'
const GROWTH = 'codex:01a1384c-0b2e-7a10-9c3e-5d6f7a8b9c0d'
const NOW = Date.parse('2026-10-20T21:29:00Z')
const usage = [
  { provider: 'claude', state: 'ok', headroomPct: 45, resetsAt: '2026-10-26T08:00:00.000Z', ageSec: 60, source: 'probe', plan: 'max', stale: false, note: '' },
  { provider: 'codex', state: 'low', headroomPct: 8, resetsAt: '2026-10-27T11:51:14.000Z', ageSec: 60, source: 'probe', plan: 'prolite', stale: false, note: '' },
  { provider: 'cursor', state: 'unknown', headroomPct: null, resetsAt: null, ageSec: null, source: 'none', plan: null, stale: true, note: 'not read' },
] as const
const base = { workID: CARD, revision: 'a'.repeat(64), question: 'Can you look into the toadstone plan?', context: 'Evidence only', history: [], updates: [], mode: 'plan' as const }
const row = (id: string, over: Record<string, unknown> = {}) => ({ id, title: 'T', summary: '', status: 'idle', automatic: !id.startsWith('cursor:'), ...over })

async function listen(app: express.Express) {
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  return { server, url: `http://127.0.0.1:${(server.address() as any).port}/api` }
}

describe('the plan contract', () => {
  it('an old client gets 6.81.0\'s system prompt, output budget and parser, byte for byte', async () => {
    // SHA-256 of WORK_CHAT_SYSTEM at 6b2e70b (6.81.0), 2,512 characters: `git show 6b2e70b:server/lib/work-chat.ts`.
    expect(createHash('sha256').update(WORK_CHAT_SYSTEM).digest('hex')).toBe('5ed53cdc24e408784409d464825f3433a854c769b7badf8e5c30af239f8204bb')
    expect(WORK_CHAT_OUTPUT_TOKENS).toBe(4946)
    const run = vi.fn(async () => ({ text: JSON.stringify({ answer: 'Continue it.', assignments: [{ sessionID: SBU, prompt: 'Review it.' }] }), model: 'claude:opus' }))
    const logged: any[] = []
    const app = express(); app.use(express.json({ limit: '1mb' }))
    app.use('/api', createWorkChatRouter({ run, admissions: () => true, lease: () => ({ release() {} }) as any, planLog: r => logged.push(r) }))
    const s = await listen(app)
    try {
      const body = { ...base, sessions: [row(SBU)] }
      const answer = await (await fetch(s.url + '/work/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
      expect(answer.assignments).toEqual([{ sessionID: SBU, prompt: 'Review it.' }])
      const call = (run.mock.calls[0] as any)
      expect(call[2]).toBe(WORK_CHAT_SYSTEM)
      expect(call[6].maxOutputTokens).toBe(WORK_CHAT_OUTPUT_TOKENS)
      expect(JSON.parse(call[1])).toEqual({ ...body })
      expect(logged).toEqual([expect.objectContaining({ orchestrator: false, outcome: 'planned', assignments: [{ mode: 'continue', target: SBU }], sessions: [{ id: SBU, automatic: true }] })])
      // Orchestrator keys from an old client are refused, as 6.81.0 refused any unknown key.
      expect((await fetch(s.url + '/work/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, now: new Date().toISOString() }) })).status).toBe(400)
      expect((await fetch(s.url + '/work/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, sessions: [row(SBU, { pickup: 'x' })] }) })).status).toBe(400)
    } finally { s.server.close() }
  })
  it('an orchestrator plan carries the rules and may fork or start a new session', async () => {
    const input = parseWorkChatInput({ ...base, orchestrator: true, now: new Date(NOW).toISOString(), usage, newSessionProviders: ['claude'],
      leftOut: [{ id: GROWTH, title: 'Growth', reason: 'more than 12 sessions on this card' }],
      sessions: [row(SBU, { discoveredBy: ['link'], linked: true, live: true, pickup: 'Stopped after a reply.', available: true, forkable: true }),
        row(GROWTH, { automatic: false, discoveredBy: ['continued'], live: false, available: false, reason: 'not_in_session_list', forkable: true, lastTouchedCard: '2026-10-14T10:00:00.000Z', lastActivity: null })] })
    const ok = parseWorkChatAnswer(JSON.stringify({ answer: 'Fork growth, start one on Claude.', assignments: [
      { mode: 'fork', sessionID: GROWTH, prompt: 'Pick up the pilot decision.' },
      { mode: 'newSession', provider: 'claude', prompt: 'Draft the canaries.' },
      { sessionID: SBU, prompt: 'Review the toadstone plan.' }] }), input)
    expect(ok.assignments).toEqual([{ sessionID: GROWTH, prompt: 'Pick up the pilot decision.', mode: 'fork' },
      { prompt: 'Draft the canaries.', mode: 'newSession', provider: 'claude' }, { sessionID: SBU, prompt: 'Review the toadstone plan.' }])
    const bad = (a: unknown) => () => parseWorkChatAnswer(JSON.stringify({ answer: 'x', assignments: [a] }), input)
    expect(bad({ sessionID: GROWTH, prompt: 'continue a non-automatic row' })).toThrow('invalid_assignment')
    expect(bad({ mode: 'newSession', provider: 'codex', prompt: 'not offered' })).toThrow('invalid_assignment')
    expect(bad({ mode: 'newSession', provider: 'claude', sessionID: SBU, prompt: 'both' })).toThrow('invalid_assignment')
    expect(bad({ mode: 'teleport', sessionID: SBU, prompt: 'x' })).toThrow('invalid_assignment')
    expect(bad({ sessionID: SBU, provider: 'claude', prompt: 'x' })).toThrow('invalid_assignment')
    const noFork = parseWorkChatInput({ ...base, orchestrator: true, now: new Date(NOW).toISOString(), sessions: [row(SBU, { forkable: false })] })
    expect(() => parseWorkChatAnswer(JSON.stringify({ answer: 'x', assignments: [{ mode: 'fork', sessionID: SBU, prompt: 'x' }] }), noFork)).toThrow('invalid_assignment')
    // An old-client input never accepts the new kinds, even if a model wrote them.
    const old = parseWorkChatInput({ ...base, sessions: [row(SBU)] })
    expect(() => parseWorkChatAnswer(JSON.stringify({ answer: 'x', assignments: [{ mode: 'fork', sessionID: SBU, prompt: 'x' }] }), old)).toThrow('invalid_assignment')
    expect(() => parseWorkChatInput({ ...base, orchestrator: true, sessions: [] })).toThrow('invalid_orchestrator')
    expect(() => parseWorkChatInput({ ...base, orchestrator: true, now: new Date().toISOString(), sessions: [row(SBU, { reason: 'bored' })] })).toThrow('invalid_session')
    expect(() => parseWorkChatInput({ ...base, orchestrator: true, now: new Date().toISOString(), sessions: [row('cursor:01a1384c-0b2e-7a10-9c3e-5d6f7a8b9c0d', { forkable: true })] })).toThrow('invalid_session')
    expect(WORK_CHAT_ORCHESTRATOR_RULES).toMatch(/Never say this task has no sessions when rows or leftOut are present/)
    expect(WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS).toBeGreaterThan(WORK_CHAT_OUTPUT_TOKENS)
  })
  it('a plan the model answered badly is logged as invalid_answer, and nothing is dispatched', async () => {
    const logged: any[] = []
    const app = express(); app.use(express.json({ limit: '1mb' }))
    app.use('/api', createWorkChatRouter({ run: async () => ({ text: 'not json' }) as any, admissions: () => true, lease: () => ({ release() {} }) as any, planLog: r => logged.push(r) }))
    const s = await listen(app)
    try {
      const res = await fetch(s.url + '/work/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, sessions: [] }) })
      expect(res.status).toBe(503)
      expect(logged).toEqual([expect.objectContaining({ outcome: 'invalid_answer', assignments: [] })])
    } finally { s.server.close() }
  })
  it('logs every plan with sessions, what was left out, usage age, and no prompt text; a failed plan too', () => {
    const input = parseWorkChatInput({ ...base, orchestrator: true, now: new Date(NOW).toISOString(), usage, leftOut: [{ id: GROWTH, title: 'G', reason: 'over' }],
      sessions: [row(SBU, { discoveredBy: ['link'], available: true })] })
    const r = planLogRow(input, 'invalid_answer', null, 1234, new Date(NOW))
    expect(r).toMatchObject({ orchestrator: true, outcome: 'invalid_answer', leftOut: [{ id: GROWTH, reason: 'over' }], usageAgeSec: { claude: 60, codex: 60, cursor: null },
      usageState: { claude: 'ok', codex: 'low', cursor: 'unknown' }, sessions: [{ id: SBU, automatic: true, available: true, discoveredBy: ['link'] }], ms: 1234 })
    expect(JSON.stringify(r)).not.toContain('toadstone')
    const h = fakeHome(), path = join(h.dataDir, 'work-orchestrator', 'plans.jsonl')
    for (let i = 0; i < 3; i++) appendPlanLog(path, r)
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3)
  })
})

describe('the input route', () => {
  it('stores Control\'s snapshot before building the input, refuses a bad one whole', async () => {
    const put = vi.fn(), input = vi.fn(async (workID: string) => ({ protocolVersion: 1, workID, rows: [], leftOut: [] } as any))
    const app = express(); app.use(express.json({ limit: '10mb' })); app.use('/api', createWorkOrchestratorRouter({ putSnapshot: put, input, usage: async () => [], now: () => NOW }))
    const s = await listen(app)
    const post = (body: unknown) => fetch(s.url + '/work/orchestrator/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const snapshot = { version: 1, controlVersion: '0.5.333', sentAt: NOW / 1000, links: [{ sessionID: SBU, workID: CARD, at: NOW / 1000 }], receipts: [], live: null }
      expect((await post({ workID: CARD, snapshot, meetingWorkIDs: ['meeting:ops:quilt:2026-10:x'] })).status).toBe(200)
      expect(put).toHaveBeenCalledOnce(); expect(put.mock.calls[0]![0].links).toHaveLength(1)
      expect(input).toHaveBeenCalledWith(CARD, ['meeting:ops:quilt:2026-10:x'])
      expect((await post({ workID: CARD, snapshot: { ...snapshot, version: 9 } })).status).toBe(400)
      expect(put).toHaveBeenCalledOnce()
      expect((await post({ workID: 'task:quilt:nothex' })).status).toBe(400)
      expect((await post({ workID: CARD, extra: 1 })).status).toBe(400)
      expect(input).toHaveBeenCalledTimes(1)
      expect((await post({ workID: CARD })).status).toBe(200)
      const caps = await (await fetch(s.url + '/work/orchestrator/usage')).json()
      expect(caps.protocolVersion).toBe(1)
    } finally { s.server.close() }
  })
})

describe('the toadstone journey (2026-10-20)', () => {
  it('finds both sessions, plans with them, and never says there are no sessions', async () => {
    // What was true at 21:29: one confirmed link (claude 2026 SBU/XBU), the Codex "Quilt Growth System Evolution" session
    // on the card by handoff history only, Codex at 8% weekly, and Control's planner saw zero sessions.
    const h = fakeHome()
    claudeLog(h, '-Users-x-MU-Chief-Staff', SBU.slice(7), [
      { role: 'user', text: 'Use 2026 SBU / XBU (liquor, jewelry) etc.' + TEMPLATE_LINE('420a0114f1a9'), at: '2026-10-20T20:31:00Z' },
      { role: 'assistant', text: 'Unpublishing the HubDB table behind the proposal pages next. Should I check the other domains?', at: '2026-10-20T21:20:00Z' }])
    codexLog(h, GROWTH.slice(6), [
      { role: 'user', text: 'Walk the Bottle pilot.' + TEMPLATE_LINE('420a0114f1a9'), at: '2026-10-14T15:00:00Z' },
      { role: 'assistant', text: 'Brief at operations/quilt/wk42_2026/growth-system-evolution/REVIEW_BRIEF.md. Pilot proposed, not decided.', at: '2026-10-14T16:00:00Z' }], 'cli', '2026/10/14')
    const snapshot: ControlSnapshot = parseSnapshot({ version: 1, controlVersion: '0.5.333', sentAt: NOW / 1000,
      links: [{ sessionID: SBU, workID: CARD, at: NOW / 1000 - 3600 }],
      receipts: [{ id: 'r1', workID: CARD, mode: 'continueSession', provider: 'codex', sessionID: GROWTH, sourceSessionID: GROWTH, forkChildID: null, status: 'canceled', createdAt: NOW / 1000 - 120 }],
      live: { checkedAt: NOW / 1000 - 5, rows: [{ id: SBU, title: '2026 SBU /XBU (Liquor, Jewelry & Grocery', status: 'busy', busy: true, summary: '' }] } }, NOW)
    const index = new TagIndex({ roots: h.roots, path: join(h.dataDir, 'work-orchestrator', 'tag-index.json') })
    await index.refresh()
    const built = await buildOrchestratorInput(CARD, [], { snapshot, hits: index.hits(), usage: usage as any, pathOf: async sid => index.pathOf(sid), now: NOW, home: h.home })
    expect(built.rows.map(r => r.id).sort()).toEqual([GROWTH, SBU].sort())
    expect(built.rows.find(r => r.id === SBU)).toMatchObject({ linked: true, live: true, busy: true, available: true, discoveredBy: ['link', 'prompt'] })
    expect(built.rows.find(r => r.id === GROWTH)).toMatchObject({ linked: false, live: false, available: false, reason: 'not_in_session_list', forkable: true, discoveredBy: ['continued', 'prompt'] })
    expect(built.rows.find(r => r.id === GROWTH)!.pickup).toContain('REVIEW_BRIEF.md')
    // Control's side (WorkOrchestrator.swift): automatic only for a live Claude or Codex row that is not app owned.
    const sessions = built.rows.map(r => ({ id: r.id, title: r.title, summary: r.summary, status: r.status, automatic: r.live && !r.reason,
      discoveredBy: r.discoveredBy, linked: r.linked, member: r.member, lastTouchedCard: r.lastTouchedCard, lastActivity: r.lastActivity,
      live: r.live, busy: r.busy, pickup: r.pickup, available: r.available, ...(r.reason ? { reason: r.reason } : {}), forkable: r.forkable }))
    const body = { ...base, orchestrator: true, now: built.now, usage: built.usage, leftOut: built.leftOut, newSessionProviders: ['claude', 'codex'], sessions }
    // A stand-in planner that follows the one rule under test: it may say "no sessions" only when it was given none.
    const run = vi.fn(async (_m: unknown, prompt: string) => {
      const p = JSON.parse(prompt)
      if (!p.sessions.length && !(p.leftOut ?? []).length) return { text: JSON.stringify({ answer: 'This task has no sessions yet.', assignments: [] }) }
      const growth = p.sessions.find((s: any) => s.id === GROWTH)
      return { text: JSON.stringify({ answer: `2026 SBU/XBU is current on this task; Growth System Evolution is ${growth.reason} and Codex is low on usage, so its context goes to a fork only if needed.`,
        assignments: [{ sessionID: SBU, prompt: 'Review the toadstone plan against the SBU/XBU work.' }] }) }
    })
    const logged: any[] = []
    const app = express(); app.use(express.json({ limit: '1mb' }))
    app.use('/api', createWorkChatRouter({ run: run as any, admissions: () => true, lease: () => ({ release() {} }) as any, planLog: r => logged.push(r) }))
    const s = await listen(app)
    try {
      const res = await fetch(s.url + '/work/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(res.status).toBe(200)
      const answer = await res.json()
      expect(answer.answer).not.toMatch(/no sessions/i)
      expect(answer.answer).toContain('not_in_session_list')
      expect(answer.assignments).toEqual([{ sessionID: SBU, prompt: 'Review the toadstone plan against the SBU/XBU work.' }])
      expect((run.mock.calls[0] as any)[2]).toBe(WORK_CHAT_SYSTEM + '\n\n' + WORK_CHAT_ORCHESTRATOR_RULES)
      expect(JSON.parse((run.mock.calls[0] as any)[1]).now).toBe(new Date(NOW).toISOString())
      expect(logged[0]).toMatchObject({ orchestrator: true, outcome: 'planned', usageState: { codex: 'low' },
        sessions: expect.arrayContaining([expect.objectContaining({ id: GROWTH, automatic: false, reason: 'not_in_session_list' })]) })
      // The same card through the 6.81.0 path (only confirmed links in a fresh list): the planner saw nothing.
      const before = await fetch(s.url + '/work/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, sessions: [] }) })
      expect((await before.json()).answer).toBe('This task has no sessions yet.')
    } finally { s.server.close() }
  })
})

describe('usage is read on demand, never on a timer by default (6.83.0 release)', () => {
  const fixture = (name: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'work-orchestrator', '__fixtures__', name), 'utf8'))
  function monitor(clock: { now: number }) {
    const claude = vi.fn(async () => parseClaudeUsage(fixture('claude-get-usage-2026-10-20.json'))!)
    const codex = vi.fn(async () => parseCodexUsage(fixture('codex-rate-limits-2026-10-20.json'))!)
    return { m: new UsageMonitor({ probes: { claude, codex }, now: () => clock.now }), calls: () => [claude.mock.calls.length, codex.mock.calls.length] }
  }
  it('GET /usage reads when the reading is over 10 minutes old, and refresh=1 when it is over 2', async () => {
    const clock = { now: NOW }, { m, calls } = monitor(clock)
    const app = express(); app.use('/api', createWorkOrchestratorRouter({ usage: refresh => readUsage(refresh, m), now: () => clock.now }))
    const s = await listen(app)
    const get = async (q = '') => (await fetch(s.url + '/work/orchestrator/usage' + q)).json()
    try {
      const first = await get()
      expect(calls()).toEqual([1, 1])
      expect(first.usage.find((u: any) => u.provider === 'claude')).toMatchObject({ state: 'ok', source: 'probe', ageSec: 0 })
      clock.now += 5 * 60_000
      await get(); expect(calls()).toEqual([1, 1])
      await get('?refresh=1'); expect(calls()).toEqual([2, 2])
      clock.now += 11 * 60_000
      await get(); expect(calls()).toEqual([3, 3])
    } finally { s.server.close() }
  })
  it('a plan input re-reads usage older than 2 minutes before it answers, and uses what it just read', async () => {
    const clock = { now: NOW }, { m, calls } = monitor(clock), h = fakeHome()
    const tags = new TagIndex({ roots: h.roots, path: join(h.dataDir, 'work-orchestrator', 'tag-index.json') })
    const parts = { tags, usage: m, snapshot: () => null }
    const first = await orchestratorInputFor(CARD, [], parts)
    expect(calls()).toEqual([1, 1])
    expect(first.usage.find(u => u.provider === 'codex')).toMatchObject({ state: 'low', headroomPct: 8, ageSec: 0 })
    clock.now += 60_000
    await orchestratorInputFor(CARD, [], parts); expect(calls()).toEqual([1, 1])
    clock.now += 90_000
    const later = await orchestratorInputFor(CARD, [], parts)
    expect(calls()).toEqual([2, 2])
    expect(later.usage.find(u => u.provider === 'claude')).toMatchObject({ ageSec: 0 })
  })
})
