// 6.52.0: the permission broker's doors, against a real express server and real sockets,
// wired the way index.ts wires them: the hook's door first (it checks the hook token before
// any body is parsed), then the /api token gate, the global body parser, and the client API.
import { afterEach, describe, expect, it, vi } from 'vitest'

// The hook token must go through the constant-time comparison, not merely be compared:
// the spy is how an execution test can see which comparison ran.
vi.mock('../lib/token-auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/token-auth.js')>()
  return { ...actual, timingSafeTokenEqual: vi.fn(actual.timingSafeTokenEqual) }
})

import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { requireApiToken } from '../lib/api-auth.js'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import {
  PermissionBroker,
  approvalHookOutput,
  brokerSignalSink,
  questionHookOutput,
  readHidIdleSeconds,
  wirePermissionBrokerToSignals,
  type BrokerMode,
  type PermissionBrokerDeps,
} from '../lib/permission-broker.js'
import { SessionSignalStore } from '../lib/session-signal-store.js'
import { deriveSessionState, derivedRowFields } from '../lib/session-state-derive.js'
import { __resetClientLivenessForTests, lastQuestionsPollAt } from '../lib/client-liveness.js'
import { createClientInstanceRouter } from './client-instance.js'
import { PERMISSION_BROKER_HOOK_PATH, createPermissionBrokerHookRouter, createSessionQuestionsRouter } from './permission-broker.js'
import { ASK_INPUT, Q1, Q2, QUESTIONS, SESSION, permissionEnvelope } from '../lib/__fixtures__/permission-broker.js'

const API_TOKEN = 'api-tok'
const HOOK_TOKEN = 'hook-tok'
const FAST_MS = 100

interface Harness {
  base: string
  broker: PermissionBroker
  store: SessionSignalStore
  state: { mode: BrokerMode; admissions: boolean; idle: number | null; timeoutMs: number; idleReads: number; hookToken: string | null; pollAgeMs: number }
}

const servers: Server[] = []
const brokers: PermissionBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) b.stop()
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
})

/**
 * A server wired as index.ts wires it. The broker reads the REAL liveness module, so a
 * client is live only after a real authenticated `GET /api/session-questions?client=glasses`;
 * `live` (default) makes one such poll once the server is up. `gate: false` leaves the /api
 * token gate out, to prove the questions route checks the token itself.
 */
async function start(over: Partial<PermissionBrokerDeps> = {}, opts: { live?: boolean; gate?: boolean; claims?: boolean } = {}): Promise<Harness> {
  __resetClientLivenessForTests()
  const state: Harness['state'] = { mode: 'all', admissions: true, idle: 1_000, timeoutMs: 4_000, idleReads: 0, hookToken: HOOK_TOKEN, pollAgeMs: 0 }
  const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
  const broker = new PermissionBroker({
    now: () => Date.now(),
    mode: () => state.mode,
    admissionsOpen: () => state.admissions,
    lastQuestionsPollAt,
    readDeskIdleSeconds: async () => { state.idleReads++; return state.idle },
    deskIdleSeconds: () => 90,
    timeoutMs: () => state.timeoutMs,
    signals: brokerSignalSink(store),
    pollMs: 25,
    log: () => {},
    ...over,
  })
  brokers.push(broker)
  wirePermissionBrokerToSignals(broker, store)
  const app = express()
  // As index.ts: the hook's door, the /api gate, the global body parser, the claim referee,
  // then the client API.
  app.use(createPermissionBrokerHookRouter({ hookToken: () => state.hookToken, broker }))
  if (opts.gate !== false) app.use('/api', requireApiToken(API_TOKEN))
  app.use(express.json({ limit: '10mb' }))
  if (opts.claims) app.use('/api', createClientInstanceRouter())
  // The poll clock can be set back to make a poll look old without waiting for it.
  app.use('/api', createSessionQuestionsRouter({ broker, apiToken: () => API_TOKEN, now: () => Date.now() - state.pollAgeMs }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  const h: Harness = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, broker, store, state }
  if (opts.live !== false) expect((await list(h)).status).toBe(200)
  return h
}

async function ask(h: Harness, body: unknown, headers: Record<string, string> = { 'x-cos-hook-token': HOOK_TOKEN }, signal?: AbortSignal) {
  const started = performance.now()
  const res = await fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal })
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : null, ms: performance.now() - started }
}

async function list(h: Harness, headers: Record<string, string> = { 'x-cos-token': API_TOKEN }, client: string | null = 'glasses') {
  const res = await fetch(`${h.base}/api/session-questions${client === null ? '' : `?client=${client}`}`, { headers })
  return { status: res.status, body: await res.json() as { enabled: boolean; mode: string; items: Array<Record<string, any>>; pending: number; pollIntervalMs: number; liveWindowMs: number; protocolVersion: number } }
}

async function answer(h: Harness, id: string, body: unknown) {
  const res = await fetch(`${h.base}/api/session-questions/${id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-token': API_TOKEN }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 2_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`condition not met in ${ms} ms: ${JSON.stringify(v).slice(0, 300)}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** A reply that must come soon: a mutant that never releases fails in seconds, not at the test timeout. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no reply within ${ms} ms`)), ms))])
}

/** Post a request that should be parked, and wait until the list shows it. */
async function held(h: Harness, body: unknown, signal?: AbortSignal) {
  const before = (await list(h)).body.items.length
  const reply = ask(h, body, undefined, signal)
  reply.catch(() => {}) // an aborted hook rejects; the test reads that itself when it cares
  const items = (await until(() => list(h), l => l.body.items.length > before)).body.items
  return { reply, item: items[items.length - 1]! }
}

describe('POST /api/permission-requests/ask: everything outside the gate is {} at once', () => {
  it('every fast-path reason answers {} in under 100 ms, and nothing is parked', async () => {
    const h = await start()
    const bash = () => permissionEnvelope('Bash', { command: 'touch x' })
    const cases: Array<[string, () => void, unknown, string]> = [
      ['kill switch', () => { h.state.mode = 'off' }, bash(), 'broker_off'],
      ['drain', () => { h.state.mode = 'all'; h.state.admissions = false }, bash(), 'draining'],
      ['a Cursor envelope', () => { h.state.admissions = true }, permissionEnvelope('Bash', { command: 'touch x' }, { cursor_version: '3.21.13' }), 'cursor'],
      ['not a PermissionRequest', () => {}, { hello: 'world' }, 'malformed'],
      ['approvals off', () => { h.state.mode = 'questions' }, bash(), 'approvals_off'],
      ['a plan approval', () => { h.state.mode = 'all' }, permissionEnvelope('ExitPlanMode', { plan: '# plan' }), 'unsupported_tool'],
      ['no client has polled for questions', () => { __resetClientLivenessForTests() }, bash(), 'no_client'],
      ['a Bash request with the desk active', () => { h.state.idle = 4 }, bash(), 'desk_active'],
      ['the desk unreadable', () => { h.state.idle = null }, bash(), 'desk_unknown'],
    ]
    for (const [name, arrange, body, reason] of cases) {
      arrange()
      if (reason === 'desk_active') await list(h) // live again
      const r = await ask(h, body)
      expect(r.status, name).toBe(200)
      expect(r.body, name).toEqual({})
      expect(r.ms, name).toBeLessThan(FAST_MS)
      expect(h.broker.health().lastFastPath, name).toBe(reason)
    }
    expect(h.broker.health().counters).toMatchObject({ parked: 0, fastPath: { brokerOff: 1, draining: 1, cursor: 1, malformed: 1, approvalsOff: 1, unsupportedTool: 1, noClient: 1, deskActive: 1, deskUnknown: 1 } })
    // The switch and the drain are answered without reading the desk at all.
    expect(h.state.idleReads).toBe(2)
    expect((await list(h)).body.items).toEqual([])
  })

  it.skipIf(process.platform !== 'darwin')('with the REAL desk read (ioreg), an active desk is still under 100 ms', async () => {
    const h = await start({ readDeskIdleSeconds: readHidIdleSeconds, deskIdleSeconds: () => 1e9 })
    await ask(h, permissionEnvelope('Bash', { command: 'ls' })) // warm the connection
    const r = await ask(h, permissionEnvelope('Bash', { command: 'touch x' }))
    expect(r.body).toEqual({})
    expect(r.ms).toBeLessThan(FAST_MS)
    expect(h.broker.health().counters.fastPath.deskActive).toBe(2)
  })

  it('a question whose options share a label is {} at once and never listed (unsupported_input, counted)', async () => {
    const h = await start()
    const twins = { questions: [{ question: 'Deploy where?', header: 'Target', multiSelect: false, options: [{ label: 'Prod', description: 'us-east' }, { label: 'Prod', description: 'eu-west' }] }] }
    const r = await ask(h, permissionEnvelope('AskUserQuestion', twins))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({})
    expect(r.ms).toBeLessThan(FAST_MS)
    expect(h.broker.health()).toMatchObject({ lastFastPath: 'unsupported_input', counters: { parked: 0, fastPath: { unsupportedInput: 1 } } })
    expect((await list(h)).body.items).toEqual([])
  })

  it('a 900 KB Write with no client answers {} in under 100 ms through the real route', async () => {
    const h = await start({}, { live: false })
    const content = 'export const line = "0123456789abcdef"\n'.repeat(23_000)
    expect(content.length).toBeGreaterThan(880_000)
    await ask(h, permissionEnvelope('Bash', { command: 'ls' })) // warm the connection
    const r = await ask(h, permissionEnvelope('Write', { file_path: '/Users/example/big.ts', content }))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({})
    expect(r.ms).toBeLessThan(FAST_MS)
    expect(h.broker.health().lastFastPath).toBe('no_client')
    expect(h.state.idleReads).toBe(0)
  })

  it('a body the parser refuses (not JSON, over 2 MB) is {} with a 4xx, never parked', async () => {
    const h = await start()
    const bad = await fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN }, body: '{not json' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({})
    const big = await fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN }, body: JSON.stringify({ pad: 'x'.repeat(2_200_000) }) })
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({})
    expect(h.broker.health().counters.parked).toBe(0)
  })

  it('refuses without the hook token, with a wrong one, with the API token, and when none is minted', async () => {
    const h = await start()
    const body = permissionEnvelope('AskUserQuestion', ASK_INPUT)
    expect((await ask(h, body, {})).status).toBe(401)
    expect((await ask(h, body, { 'x-cos-hook-token': 'nope' })).status).toBe(401)
    expect((await ask(h, body, { 'x-cos-token': API_TOKEN })).status).toBe(401)
    h.state.hookToken = null
    expect((await ask(h, body)).status).toBe(401)
    expect(h.broker.health().counters.parked).toBe(0)
    // The client API is behind the API token like every /api route.
    expect((await fetch(`${h.base}/api/session-questions`)).status).toBe(401)
  })

  it('checks the hook token BEFORE it parses: a refused request never reaches the parser', async () => {
    const h = await start()
    // Not JSON and over the 2 MB limit: with the token it is a parser refusal (4xx), without
    // it the answer is 401, which the parser could never have produced.
    const post = (headers: Record<string, string>, body: string) => fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    for (const body of ['{not json', `{"pad":"${'x'.repeat(2_200_000)}"}`]) {
      expect((await post({}, body)).status).toBe(401)
      expect((await post({ 'x-cos-hook-token': 'nope' }, body)).status).toBe(401)
      expect((await post({ 'x-cos-token': API_TOKEN }, body)).status).toBe(401)
    }
    expect(h.broker.health().counters.fastPath).toEqual({})
  })

  it('only POST on that path is exempt from the /api gate; every other method still needs the API token', async () => {
    const h = await start()
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const bare = await fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method, headers: { 'x-cos-hook-token': HOOK_TOKEN } })
      expect(bare.status, method).toBe(401)
      expect(await bare.json(), method).toMatchObject({ error: expect.any(String) })
      // With the API token it reaches the router and finds no such route.
      const authed = await fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method, headers: { 'x-cos-token': API_TOKEN } })
      expect(authed.status, method).toBe(404)
    }
    // The 6.52.0 draft's separate door is gone.
    const old = await fetch(`${h.base}/hooks/permission-requests/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN }, body: JSON.stringify(permissionEnvelope('Bash', { command: 'ls' })) })
    expect(old.status).toBe(404)
    expect(h.broker.health().counters.parked).toBe(0)
  })

  it('checks the hook token through the constant-time comparison', async () => {
    const h = await start()
    h.state.mode = 'off'
    vi.mocked(timingSafeTokenEqual).mockClear()
    expect((await ask(h, permissionEnvelope('Bash', { command: 'ls' }))).body).toEqual({})
    expect(vi.mocked(timingSafeTokenEqual)).toHaveBeenCalledWith(HOOK_TOKEN, HOOK_TOKEN)
  })

  it('a hook that leaves during the desk read is never parked', async () => {
    let release: (v: number) => void = () => {}
    let reading = false
    const h = await start({ readDeskIdleSeconds: () => { reading = true; return new Promise<number>(r => { release = r }) } })
    const controller = new AbortController()
    const pending = ask(h, permissionEnvelope('Bash', { command: 'ls' }), undefined, controller.signal).catch(e => e)
    await until(async () => reading, r => r)
    controller.abort()
    await pending
    await new Promise(r => setTimeout(r, 50))
    release(1_000)
    await until(async () => h.broker.health().lastFastPath, r => r === 'hook_gone_early')
    expect(h.broker.health().counters.parked).toBe(0)
  })
})

describe('a parked question or approval', () => {
  it('a question answered from the API reaches the hook as allow + the original input + answers (lists keyed by the original text)', async () => {
    const h = await start()
    const { reply, item } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))
    expect(item).toMatchObject({ sessionId: SESSION, provider: 'claude', kind: 'question', tool: 'AskUserQuestion', questions: QUESTIONS })
    expect(item.id).toMatch(/^pq_[0-9a-f]{24}$/)
    expect(Date.parse(item.deadlineAt) - Date.parse(item.createdAt)).toBeLessThanOrEqual(4_000)
    const a = await answer(h, item.id, { clientAnswerId: 'lens-1', answers: [{ labels: ['Publish', 'Bump'], other: 'and tell Gina' }, { labels: ['Blue'] }] })
    const answers = { [Q1]: ['Bump', 'Publish', 'and tell Gina'], [Q2]: ['Blue'] }
    expect(a).toEqual({ status: 200, body: { ok: true, id: item.id, kind: 'question', answers } })
    const hook = await reply
    expect(hook.status).toBe(200)
    expect(hook.body).toEqual(questionHookOutput(ASK_INPUT, answers))
    expect(hook.body).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { questions: QUESTIONS, metadata: { source: 'canary' }, answers } } },
    })
    // What the script tests for before it prints.
    expect(hook.text.startsWith('{"hookSpecificOutput"')).toBe(true)
    expect(hook.text).not.toContain('updatedPermissions')
    expect((await list(h)).body.items).toEqual([])
  })

  it('an approval: allow once, or deny with the one message; the card is redacted', async () => {
    const h = await start()
    const secret = { command: 'cd /Users/example/repo && curl -H "Authorization: Bearer abcdefghijklmnopqrst" https://x.test', description: 'call the api' }
    const allow = await held(h, permissionEnvelope('Bash', secret))
    expect(allow.item).toMatchObject({ kind: 'approval', tool: 'Bash', approval: { tool: 'Bash' } })
    // The whole command, `cd ... &&` included (B1): only the credential is taken out.
    expect(allow.item.approval.summary).toBe('cd /Users/example/repo && curl -H "Authorization: Bearer [redacted]" https://x.test')
    expect(JSON.stringify(allow.item)).not.toContain('abcdefghijklmnopqrst')
    expect(allow.item).not.toHaveProperty('questions')
    expect(await answer(h, allow.item.id, { clientAnswerId: 'a', decision: 'allow' })).toEqual({ status: 200, body: { ok: true, id: allow.item.id, kind: 'approval', decision: 'allow' } })
    expect((await allow.reply).body).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

    const deny = await held(h, permissionEnvelope('Bash', { command: 'rm -rf build' }))
    expect((await answer(h, deny.item.id, { clientAnswerId: 'd', decision: 'deny' })).status).toBe(200)
    const denied = await deny.reply
    expect(denied.body).toEqual(approvalHookOutput('deny'))
    expect(denied.body).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from COS glasses' } } })
    expect(h.broker.health().counters).toMatchObject({ parked: 2, answered: 2 })
  })

  it('returning to the desk hands it back at once: {} to the hook, 409 handed_to_desk to a late answer', async () => {
    const h = await start()
    const { reply, item } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))
    const touched = Date.now()
    h.state.idle = 0
    const hook = await within(reply)
    expect(hook.body).toEqual({})
    expect(Date.now() - touched).toBeLessThan(1_000)
    expect(await answer(h, item.id, { clientAnswerId: 'late', answers: [{ labels: ['Tag'] }, { labels: ['Red'] }] })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'handed_to_desk' } })
    expect(h.broker.health().counters.handedToDesk).toBe(1)
  })

  it('a drain that starts while it is held hands it back too', async () => {
    const h = await start()
    const { reply } = await held(h, permissionEnvelope('Bash', { command: 'ls' }))
    h.state.admissions = false
    expect((await within(reply)).body).toEqual({})
    expect(h.broker.health().counters.drained).toBe(1)
  })

  it('the deadline answers {} and a late answer is 409 expired', async () => {
    const h = await start()
    h.state.timeoutMs = 400
    const sent = Date.now()
    const { reply, item } = await held(h, permissionEnvelope('Bash', { command: 'ls' }, {}, sent))
    expect((await within(reply)).body).toEqual({})
    expect(Date.now() - sent).toBeGreaterThanOrEqual(380)
    expect(await answer(h, item.id, { clientAnswerId: 'late', decision: 'allow' })).toEqual({ status: 409, body: { error: 'expired' } })
    expect(h.broker.health().counters.expired).toBe(1)
  })

  it('the hook hanging up releases the item at once, and a late answer is 410 hook_gone', async () => {
    const h = await start()
    const controller = new AbortController()
    const { item } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT), controller.signal)
    controller.abort()
    await until(() => list(h), l => l.body.items.length === 0, 1_000)
    expect(h.broker.health().counters).toMatchObject({ hookGone: 1, answered: 0 })
    expect(await answer(h, item.id, { clientAnswerId: 'late', answers: [{ labels: ['Tag'] }, { labels: ['Red'] }] })).toEqual({ status: 410, body: { error: 'hook_gone' } })
  })

  it('first answer wins under two racing answers; the winner\'s retry replays', async () => {
    const h = await start()
    const { reply, item } = await held(h, permissionEnvelope('Bash', { command: 'git push' }))
    const [one, two] = await Promise.all([
      answer(h, item.id, { clientAnswerId: 'lens', decision: 'allow' }),
      answer(h, item.id, { clientAnswerId: 'phone', decision: 'deny' }),
    ])
    const winner = one.status === 200 ? one : two
    const loser = one.status === 200 ? two : one
    expect([one.status, two.status].sort()).toEqual([200, 409])
    expect(loser.body).toEqual({ error: 'already_answered', decision: winner.body.decision })
    expect((await reply).body).toEqual(approvalHookOutput(winner.body.decision as 'allow' | 'deny'))
    const winnerId = winner === one ? 'lens' : 'phone'
    expect(await answer(h, item.id, { clientAnswerId: winnerId, decision: 'allow' })).toEqual({ status: 200, body: { ...winner.body, replay: true } })
    expect(h.broker.health().counters).toMatchObject({ answered: 1, hookGone: 0 })
  })

  it('"Leave for the Mac" (handBack): the hook gets {} at once, a later answer is 409 handed_to_desk, the retry replays, counted', async () => {
    const h = await start()
    const { reply, item } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))
    const sent = Date.now()
    expect(await answer(h, item.id, { clientAnswerId: 'phone-leave-1', handBack: true })).toEqual({ status: 200, body: { ok: true, id: item.id, kind: 'question', handedBack: true } })
    const hook = await within(reply)
    expect(hook.status).toBe(200)
    // `{}` is no decision: Claude Code shows the Mac's own dialog.
    expect(hook.body).toEqual({})
    expect(Date.now() - sent).toBeLessThan(1_000)
    expect(await answer(h, item.id, { clientAnswerId: 'lens-1', answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'handed_to_desk' } })
    expect(await answer(h, item.id, { clientAnswerId: 'phone-leave-1', handBack: true })).toEqual({ status: 200, body: { ok: true, id: item.id, kind: 'question', handedBack: true, replay: true } })
    const after = await list(h)
    expect(after.body.items).toEqual([])
    expect((after.body as unknown as { stats: { counters: Record<string, number> } }).stats.counters).toMatchObject({ handedBack: 1, handedToDesk: 1, answered: 0, hookGone: 0 })

    // An answer first: a hand-back after it is 409 already_answered, with the answer.
    const approval = await held(h, permissionEnvelope('Bash', { command: 'git push' }))
    expect((await answer(h, approval.item.id, { clientAnswerId: 'lens-2', decision: 'deny' })).status).toBe(200)
    expect(await answer(h, approval.item.id, { clientAnswerId: 'phone-leave-2', handBack: true })).toEqual({ status: 409, body: { error: 'already_answered', decision: 'deny' } })
    expect((await approval.reply).body).toEqual(approvalHookOutput('deny'))
  })

  it('handed back, the row still waits on the question (now the Mac\'s dialog) and no longer carries the held id', async () => {
    const h = await start()
    const t = Date.now()
    h.store.apply({ ts: t - 30, ppid: 4242, event: 'UserPromptSubmit', sessionId: SESSION, payload: { session_id: SESSION, prompt: 'ship it' } })
    h.store.apply({ ts: t - 20, ppid: 4242, event: 'PreToolUse', sessionId: SESSION, payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT } })
    h.store.apply({ ts: t - 10, ppid: 4242, event: 'PermissionRequest', sessionId: SESSION, payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT } })
    const row = () => derivedRowFields(deriveSessionState({ signal: h.store.get(SESSION), registry: undefined, transcript: undefined, now: Date.now() }))
    const { reply, item } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, t - 10))
    expect(row()).toMatchObject({ agent_state: 'waiting', waiting_kind: 'question', pending_question_id: item.id })
    expect((await answer(h, item.id, { clientAnswerId: 'leave', handBack: true })).status).toBe(200)
    expect((await within(reply)).body).toEqual({})
    expect(row()).toMatchObject({ agent_state: 'waiting', waiting_kind: 'question' })
    expect(row()).not.toHaveProperty('pending_question_id')
  })

  it('retracted when its own tool runs (the desk answered): {} to the hook, 409 to a late answer', async () => {
    const h = await start()
    const input = { command: 'touch par-a' }
    const sent = Date.now()
    const { reply, item } = await held(h, permissionEnvelope('Bash', input, {}, sent))
    // A parallel auto-allowed tool does not retract it.
    h.store.apply({ ts: sent + 1, ppid: 4242, event: 'PostToolUse', sessionId: SESSION, payload: { session_id: SESSION, tool_name: 'Read', tool_input: { file_path: '/x' } } })
    expect((await list(h)).body.items).toHaveLength(1)
    h.store.apply({ ts: sent + 2, ppid: 4242, event: 'PostToolUse', sessionId: SESSION, payload: { session_id: SESSION, tool_name: 'Bash', tool_input: input } })
    expect((await within(reply)).body).toEqual({})
    expect(await answer(h, item.id, { clientAnswerId: 'late', decision: 'allow' })).toEqual({ status: 409, body: { error: 'handed_to_desk', reason: 'retracted' } })
  })

  it('validates answers, leaves the item answerable after a bad one, and 404s an unknown id', async () => {
    const h = await start()
    const { reply, item } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))
    const bad: Array<[unknown, Record<string, unknown>]> = [
      [{ answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] }, { error: 'invalid_answer', reason: 'client_answer_id' }],
      [{ clientAnswerId: ' spaced', answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] }, { error: 'invalid_answer', reason: 'client_answer_id' }],
      [{ clientAnswerId: 'c', answers: [{ labels: ['Bump'] }] }, { error: 'invalid_answer', reason: 'answers_shape' }],
      [{ clientAnswerId: 'c', answers: [{ labels: ['Bump'] }, { labels: [] }] }, { error: 'invalid_answer', reason: 'unanswered', index: 1 }],
      [{ clientAnswerId: 'c', answers: [{ labels: ['Ship'] }, { labels: ['Blue'] }] }, { error: 'invalid_answer', reason: 'unknown_label', index: 0 }],
      [{ clientAnswerId: 'c', answers: [{ labels: ['Bump'] }, { labels: ['Blue', 'Red'] }] }, { error: 'invalid_answer', reason: 'too_many', index: 1 }],
      [{ clientAnswerId: 'c', decision: 'allow' }, { error: 'invalid_answer', reason: 'answers_shape' }],
    ]
    for (const [body, expected] of bad) expect(await answer(h, item.id, body)).toEqual({ status: 400, body: expected })
    expect(await answer(h, 'pq_000000000000000000000000', { clientAnswerId: 'c', decision: 'allow' })).toEqual({ status: 404, body: { error: 'not_found' } })
    expect(await answer(h, 'PQ_not-an-id', { clientAnswerId: 'c', decision: 'allow' })).toEqual({ status: 404, body: { error: 'not_found' } })
    expect((await list(h)).body.items).toHaveLength(1)
    expect((await answer(h, item.id, { clientAnswerId: 'c', answers: [{ labels: ['Tag'] }, { other: 'Green' }] })).status).toBe(200)
    expect((await reply).body).toEqual(questionHookOutput(ASK_INPUT, { [Q1]: ['Tag'], [Q2]: ['Green'] }))

    const approval = await held(h, permissionEnvelope('Bash', { command: 'ls' }))
    for (const decision of [undefined, 'yes', 'ALLOW']) {
      expect(await answer(h, approval.item.id, { clientAnswerId: 'c', decision })).toEqual({ status: 400, body: { error: 'invalid_answer', reason: 'decision' } })
    }
    expect((await answer(h, approval.item.id, { clientAnswerId: 'c', decision: 'allow' })).status).toBe(200)
  })

  it('the session row reads waiting/question with pending_question_id while held, and not waiting after the answer', async () => {
    const h = await start()
    const t = Date.now()
    h.store.apply({ ts: t - 30, ppid: 4242, event: 'UserPromptSubmit', sessionId: SESSION, payload: { session_id: SESSION, prompt: 'ship it' } })
    h.store.apply({ ts: t - 20, ppid: 4242, event: 'PreToolUse', sessionId: SESSION, payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT } })
    h.store.apply({ ts: t - 10, ppid: 4242, event: 'PermissionRequest', sessionId: SESSION, payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT } })
    const row = () => derivedRowFields(deriveSessionState({ signal: h.store.get(SESSION), registry: undefined, transcript: undefined, now: Date.now() }))
    const { reply, item } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT, {}, t - 10))
    expect(row()).toMatchObject({ agent_state: 'waiting', waiting_kind: 'question', pending_question_id: item.id })
    await answer(h, item.id, { clientAnswerId: 'c', answers: [{ labels: ['Bump'] }, { labels: ['Blue'] }] })
    await reply
    expect(row()).toMatchObject({ agent_state: 'running' })
    expect(row()).not.toHaveProperty('waiting_kind')
    expect(row()).not.toHaveProperty('pending_question_id')
    // The answered tool runs with `answers` in its input (a new fingerprint): still not waiting.
    h.store.apply({ ts: Date.now(), ppid: 4242, event: 'PostToolUse', sessionId: SESSION, payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: { ...ASK_INPUT, answers: { [Q1]: ['Bump'], [Q2]: ['Blue'] } } } })
    expect(row()).toMatchObject({ agent_state: 'running' })
  })
})

describe('liveness and the mount', () => {
  it('a live client-instance claim with NO questions poll takes the fast path (a 6.9.511 app: nothing held)', async () => {
    const h = await start({}, { live: false, claims: true })
    const claim = await fetch(`${h.base}/api/client-instance/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-token': API_TOKEN },
      body: JSON.stringify({ id: 'aaaa0001-lens', bootAt: Date.now() - 1_000, version: '6.9.511' }),
    })
    expect(claim.status).toBe(200)
    // Everything else about the request would park it: away, a question, the broker on.
    for (const body of [permissionEnvelope('AskUserQuestion', ASK_INPUT), permissionEnvelope('Bash', { command: 'touch x' })]) {
      const r = await ask(h, body)
      expect(r.body).toEqual({})
      expect(r.ms).toBeLessThan(FAST_MS)
      expect(h.broker.health().lastFastPath).toBe('no_client')
    }
    expect(lastQuestionsPollAt()).toBeNull()
    expect(h.broker.health().counters.parked).toBe(0)
  })

  it('a questions poll at most 30 s old parks', async () => {
    const h = await start({}, { live: false })
    h.state.pollAgeMs = 29_000
    expect((await list(h)).status).toBe(200)
    const { reply, item } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))
    expect(item.kind).toBe('question')
    expect(h.broker.health().counters.parked).toBe(1)
    h.state.idle = 0 // back at the desk: released
    expect((await within(reply)).body).toEqual({})
  })

  it('a poll older than 30 s takes the fast path; a fresh one parks again', async () => {
    const h = await start({}, { live: false })
    h.state.pollAgeMs = 31_000
    expect((await list(h)).status).toBe(200)
    const r = await ask(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))
    expect(r.body).toEqual({})
    expect(h.broker.health().lastFastPath).toBe('no_client')
    h.state.pollAgeMs = 0
    const { reply } = await held(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))
    h.state.idle = 0
    expect((await within(reply)).body).toEqual({})
  })

  it('only a poll that names an answering client counts: client=glasses or client=phone', async () => {
    const h = await start({}, { live: false })
    for (const client of [null, 'control', 'Glasses', 'pet', '']) {
      const r = await list(h, undefined, client)
      expect(r.status, String(client)).toBe(200)
      expect(lastQuestionsPollAt(), String(client)).toBeNull()
    }
    expect((await ask(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))).body).toEqual({})
    expect(h.broker.health().lastFastPath).toBe('no_client')
    for (const client of ['glasses', 'phone']) {
      __resetClientLivenessForTests()
      expect((await list(h, undefined, client)).status).toBe(200)
      expect(lastQuestionsPollAt(), client).not.toBeNull()
    }
    // The contract rides every answer.
    const r = await list(h, undefined, null)
    expect(r.body).toMatchObject({ enabled: true, mode: 'all', protocolVersion: 1, pollIntervalMs: 10_000, liveWindowMs: 30_000, pending: 0, items: [] })
    const { reply } = await held(h, permissionEnvelope('Bash', { command: 'ls' }))
    expect((await list(h, undefined, 'control')).body.pending).toBe(1)
    h.state.idle = 0
    expect((await within(reply)).body).toEqual({})
  })

  it('a poll with the hook token never counts, even with no /api gate in front of the route', async () => {
    for (const gate of [true, false]) {
      const h = await start({}, { live: false, gate })
      expect((await list(h, { 'x-cos-hook-token': HOOK_TOKEN })).status, `gate=${gate}`).toBe(401)
      expect((await list(h, { 'x-cos-token': HOOK_TOKEN })).status, `gate=${gate}`).toBe(401)
      expect((await list(h, {})).status, `gate=${gate}`).toBe(401)
      expect(lastQuestionsPollAt(), `gate=${gate}`).toBeNull()
      const r = await ask(h, permissionEnvelope('AskUserQuestion', ASK_INPUT))
      expect(r.body, `gate=${gate}`).toEqual({})
      expect(h.broker.health().lastFastPath, `gate=${gate}`).toBe('no_client')
      // The pairing token on the same route does count.
      expect((await list(h)).status).toBe(200)
      expect(lastQuestionsPollAt()).not.toBeNull()
    }
  })

  it('index.ts mounts both hook doors BEFORE the /api gate and the global parser, outside the thread-attach block, and the client API behind the token', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const hook = index.indexOf('app.use(createPermissionBrokerHookRouter({ hookToken: readHookToken, broker: permissionBroker }))')
    const cursor = index.indexOf('  app.use(createCursorStopFollowupRouter({')
    const auth = index.indexOf("app.use('/api', requireApiToken(API_TOKEN))")
    const parser = index.indexOf("app.use(express.json({ limit: '10mb' }))")
    const api = index.indexOf("app.use('/api', createSessionQuestionsRouter({ broker: permissionBroker, apiToken: () => API_TOKEN }))")
    const gate = index.indexOf('if (threadAttachEnabled()) {\n  // 6.51.0: a queued Cursor turn')
    const attach = index.lastIndexOf('if (threadAttachEnabled()) {')
    for (const at of [hook, cursor, auth, parser, api, gate, attach]) expect(at).toBeGreaterThan(-1)
    // Each door once, both ahead of the gate and the parser.
    expect(index.split('createPermissionBrokerHookRouter(').length - 1).toBe(1)
    expect(index.split('createCursorStopFollowupRouter(').length - 1).toBe(1)
    expect(hook).toBeLessThan(auth)
    expect(cursor).toBeLessThan(auth)
    expect(auth).toBeLessThan(parser)
    expect(auth).toBeLessThan(api)
    // The Cursor door keeps its own condition; the broker's door has none.
    expect(gate).toBeLessThan(cursor)
    expect(hook).toBeLessThan(gate)
    expect(api).toBeLessThan(attach)
    expect(index).toContain('wirePermissionBrokerToSignals(permissionBroker, sessionSignalStore)')
    expect(index).toContain('permissionBroker.stop()')
    // The broker's liveness is the questions poll, never the claim referee.
    expect(index).toContain('  lastQuestionsPollAt,\n')
    expect(readFileSync(new URL('./client-instance.ts', import.meta.url), 'utf8')).not.toContain('client-liveness')
    const apiAuth = readFileSync(new URL('../lib/api-auth.ts', import.meta.url), 'utf8')
    expect(apiAuth).not.toContain('session-questions')
    expect(apiAuth).not.toContain('permission-requests')
  })
})
