// X1 (the one queue): GET /api/session-questions carries `queue` and `queueCount` whatever the full-hold switches say,
// appended after every 7.0.31 key, and the answer route records which surface answered. The client-shape proof for
// Control Web runs its real `panes/questions.js` on this route's real response, with and without the new keys, and
// requires the same cards. (The glasses and Mac app shapes: see HANDOFF_question_wait_8h.md, run against their own
// parsers; neither iterates the response's keys.)
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { requireApiToken } from '../lib/api-auth.js'
import { PermissionBroker, brokerSignalSink } from '../lib/permission-broker.js'
import { SessionSignalStore } from '../lib/session-signal-store.js'
import { createSessionQuestionsRouter } from './permission-broker.js'
import { agentSessionsRouter } from './agent-sessions.js'
import { __resetSessionTitlesForTests, sessionTitleFor } from '../lib/session-title-cache.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ASK_INPUT, Q1, SESSION, permissionEnvelope } from '../lib/__fixtures__/permission-broker.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const QUESTIONS_JS = readFileSync(join(HERE, '..', 'web-control', 'panes', 'questions.js'), 'utf8')
const API_TOKEN = 'x1-queue-token-0123456789abcdef0123'
const servers: Server[] = []
const brokers: PermissionBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) b.stop()
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
})

async function start(fullHold: { questions: boolean; approvals: boolean; questionsByDefault?: boolean } = { questions: false, approvals: false }, questionBlockS = 630) {
  const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
  const broker = new PermissionBroker({
    now: () => Date.now(), mode: () => 'all', admissionsOpen: () => true,
    lastQuestionsPollAt: () => Date.now(), lastLegacyPollAt: () => Date.now(), lastHoldPollAt: () => Date.now(), presenceAgeMs: () => 1_000,
    readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, timeoutMs: () => 110_000, awayHoldMs: () => 600_000, installedHookTimeoutS: () => 630,
    fullHold: () => fullHold, installedHookTimeoutForKindS: kind => (kind === 'question' ? questionBlockS : 630),
    signals: brokerSignalSink(store), pollMs: 60_000,
  })
  brokers.push(broker)
  const app = express()
  app.use('/api', requireApiToken(API_TOKEN))
  app.use(express.json())
  app.use('/api', createSessionQuestionsRouter({
    broker, apiToken: () => API_TOKEN,
    turnEndQueue: () => ({ asks: [{ sessionId: SESSION, ask: 'Ship slide 4?', choices: ['Yes', 'No'], stoppedAt: Date.now() - 60_000 }], answered: [] }),
    titleFor: () => 'Quilt deck',
  }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = async () => (await fetch(`${base}/api/session-questions`, { headers: { 'X-Cos-Token': API_TOKEN } })).json() as Promise<Record<string, any>>
  return { broker, base, get }
}

describe('queue on GET /api/session-questions (switches off)', () => {
  it('lists the at-Mac question, the held approval and the turn-end ask, oldest first, titled, with one count', async () => {
    const h = await start()
    const now = Date.now()
    h.broker.observeHookEvent({ ts: now - 30_000, ppid: 1, sessionId: SESSION, event: 'PreToolUse', payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' } }, false)
    const r = await h.broker.admit({ ...permissionEnvelope('Bash', { command: 'npm publish' }, { tool_use_id: 'toolu_b1' }, now), hookWaitS: 630 })
    if (!r.ok) throw Error(r.reason)
    h.broker.park(r.request, { writable: () => true, reply: () => true })
    const body = await h.get()
    expect(body.queue.map((e: any) => [e.kind, e.where, e.line, e.title])).toEqual([
      ['turn_end', 'here', 'Ship slide 4?', 'Quilt deck'],
      ['question', 'mac', Q1.trim(), 'Quilt deck'],
      ['approval', 'here', 'npm publish', 'Quilt deck'],
    ])
    expect(body.queueCount).toBe(3)
    // The gated 7.0.31 view is unchanged: no `waiting` with the switches off.
    expect('waiting' in body).toBe(false)
  })

  it('the answer route records which surface answered (X-Cos-Client), and the queue says so for two minutes', async () => {
    const h = await start()
    const r = await h.broker.admit({ ...permissionEnvelope('Bash', { command: 'npm publish' }, { tool_use_id: 'toolu_b1' }, Date.now()), hookWaitS: 630 })
    if (!r.ok) throw Error(r.reason)
    const id = h.broker.park(r.request, { writable: () => true, reply: () => true })
    const res = await fetch(`${h.base}/api/session-questions/${id}/answer`, { method: 'POST', headers: { 'X-Cos-Token': API_TOKEN, 'X-Cos-Client': 'glasses', 'content-type': 'application/json' }, body: JSON.stringify({ clientAnswerId: 'g1', decision: 'allow' }) })
    expect(res.status).toBe(200)
    const approval = (await h.get()).queue.find((e: any) => e.kind === 'approval')
    expect(approval).toMatchObject({ state: 'answered', answeredBy: 'glasses' })
  })
})

describe('7.0.34: the question hold on by default, pending per Mac', () => {
  it('unset with old hooks answers the route with exactly the keys of switch-off; reinstalled, it adds the extended view', async () => {
    const keys = async (h: Awaited<ReturnType<typeof start>>) => Object.keys(await h.get()).sort()
    const off = await keys(await start({ questions: false, approvals: false, questionsByDefault: false }))
    const dflt = await keys(await start({ questions: false, approvals: false, questionsByDefault: true }))
    expect(dflt).toEqual(off)
    expect(off).not.toContain('waiting')
    const reinstalled = await keys(await start({ questions: false, approvals: false, questionsByDefault: true }, 28_800))
    expect(reinstalled).toEqual([...off, 'waiting', 'webAnswer'].sort())
  })
})

describe('client shape: Control Web reads the response exactly as before', () => {
  async function render(body: Record<string, unknown>): Promise<{ html: string; count: number }> {
    const host = { hidden: true, innerHTML: '', isConnected: true, addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], contains: () => false }
    let onShell: (() => void) | null = null
    const W = { esc: (s: unknown) => String(s ?? ''), toast: () => {}, showAuth: () => {}, onShell: (fn: () => void) => { onShell = fn },
      api: (path: string) => Promise.resolve(path === '/api/models' ? { capabilities: { sessionQuestions: { enabled: true, webClient: true } } } : {}) }
    const document = { getElementById: (id: string) => (id === 'sq-host' ? host : id === 'app-shell' ? { classList: { contains: () => false } } : null), addEventListener: () => {}, hidden: false, activeElement: null }
    const ctx = vm.createContext({ window: { COSWeb: W, addEventListener: () => {} }, document, fetch: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(body) }),
      console, Date, JSON, Math, Promise, crypto: globalThis.crypto, isFinite, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} })
    vm.runInContext(QUESTIONS_JS, ctx)
    onShell!()
    for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r))
    const Qs = (W as any).sessionQuestions
    return { html: host.innerHTML, count: typeof Qs?.count === 'function' ? Qs.count() : -1 }
  }

  it('the same cards with and without `queue` and `queueCount`', async () => {
    const h = await start()
    const r = await h.broker.admit({ ...permissionEnvelope('Bash', { command: 'npm publish' }, { tool_use_id: 'toolu_b1' }, Date.now()), hookWaitS: 630 })
    if (!r.ok) throw Error(r.reason)
    h.broker.park(r.request, { writable: () => true, reply: () => true })
    const body = await h.get()
    expect(body.queue.length).toBeGreaterThan(0)
    const { queue: _q, queueCount: _c, ...old } = body
    const withQueue = await render(body)
    const without = await render(old)
    expect(withQueue.html).toContain('npm publish')
    expect(withQueue).toEqual(without)
  })
})

describe('the titles the queue reads come from the session list', () => {
  it('a session the list showed is named in the cache, by full and short id', async () => {
    __resetSessionTitlesForTests()
    const home = mkdtempSync(join(tmpdir(), 'x1-queue-titles-'))
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const day = new Date().toISOString().slice(0, 10).split('-').join('/')
    const dir = join(home, '.codex', 'sessions', day)
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    const meta = JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/repo/quilt', timestamp: new Date().toISOString() } })
    const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build the deck' }] } })
    writeFileSync(join(dir, `rollout-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), meta + '\n' + user + '\n')
    writeFileSync(join(home, '.codex', 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Quilt deck thread' }) + '\n')
    const prev = { home: process.env.COS_AGENT_SESSIONS_HOME, codex: process.env.CODEX_HOME }
    process.env.COS_AGENT_SESSIONS_HOME = home
    process.env.CODEX_HOME = join(home, '.codex')
    try {
      const app = express()
      app.use('/api', agentSessionsRouter)
      const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
      servers.push(server)
      expect(sessionTitleFor(id)).toBeNull()
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-sessions`)
      expect(res.status).toBe(200)
      const listed = ((await res.json()).sessions ?? []) as Array<{ session_id: string; display_label: string }>
      const row = listed.find(r => r.session_id === id)
      expect(row).toBeDefined()
      expect(sessionTitleFor(id)).toBe(row!.display_label)
      expect(sessionTitleFor(id.slice(0, 8))).toBe(row!.display_label)
    } finally {
      if (prev.home === undefined) delete process.env.COS_AGENT_SESSIONS_HOME; else process.env.COS_AGENT_SESSIONS_HOME = prev.home
      if (prev.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev.codex
      rmSync(home, { recursive: true, force: true })
      __resetSessionTitlesForTests()
    }
  })
})
