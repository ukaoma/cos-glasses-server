// X1: the full hold over the real routes and real sockets: the hook's door holds a question with no
// client live, the questions route lists it (and adds `waiting` and `webAnswer` only while a switch is
// on), the web door answers only with a touch, and an approval only with a confirm id the server gave.
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PermissionBroker, brokerSignalSink, wirePermissionBrokerToSignals } from '../lib/permission-broker.js'
import { SessionSignalStore } from '../lib/session-signal-store.js'
import { PERMISSION_BROKER_HOOK_PATH, createPermissionBrokerHookRouter, createSessionQuestionsRouter } from './permission-broker.js'
import { ASK_INPUT, SESSION, permissionEnvelope } from '../lib/__fixtures__/permission-broker.js'
import type { FullHoldSwitches } from '../lib/full-hold.js'

const API_TOKEN = 'api-tok-x1'
const HOOK_TOKEN = 'hook-tok-x1'
const servers: Server[] = []
const brokers: PermissionBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) b.stop()
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
})

async function start(switches: FullHoldSwitches, opts: { desk?: number } = {}) {
  const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
  const broker = new PermissionBroker({
    now: () => Date.now(), mode: () => 'all', admissionsOpen: () => true,
    lastQuestionsPollAt: () => null, lastLegacyPollAt: () => null, lastHoldPollAt: () => null, presenceAgeMs: () => null,
    readDeskIdleSeconds: async () => opts.desk ?? 1_000, deskIdleSeconds: () => 90, timeoutMs: () => 110_000,
    awayHoldMs: () => 600_000, installedHookTimeoutS: () => 3600, installedHookTimeoutForKindS: () => 3600,
    fullHold: () => switches, engineFor: () => ({ entrypoint: 'claude-desktop', version: '2.1.317', host: 'desktop-app' }),
    signals: brokerSignalSink(store), pollMs: 25, log: () => {},
  })
  brokers.push(broker)
  wirePermissionBrokerToSignals(broker, store)
  const app = express()
  app.use(createPermissionBrokerHookRouter({ hookToken: () => HOOK_TOKEN, broker }))
  app.use(express.json())
  // The web door: in production the signed cookie (`webSessionCookieAuthorized`); here a header stands in for it.
  app.use('/api', createSessionQuestionsRouter({ broker, apiToken: () => API_TOKEN, webSessionAuthorized: req => req.headers['x-test-web'] === '1', fromThisMac: () => false }))
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>(r => server.once('listening', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, broker, store }
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const web = { 'x-test-web': '1' }
const app = { 'x-cos-token': API_TOKEN }

async function hook(base: string, body: Record<string, unknown>) {
  const controller = new AbortController()
  const reply = fetch(base + PERMISSION_BROKER_HOOK_PATH, { ...json(body), headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN }, signal: controller.signal }).then(r => r.json()).catch(() => null)
  return { reply, abort: () => controller.abort() }
}
async function until<T>(read: () => Promise<T | undefined>, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await read(); if (v !== undefined) return v; await new Promise(r => setTimeout(r, 20)) }
  throw Error('timed out')
}
async function list(base: string, headers: Record<string, string> = app) {
  return (await fetch(`${base}/api/session-questions`, { headers })).json() as Promise<Record<string, unknown>>
}

describe('the questions route under the full hold', () => {
  it('with every switch off it has 7.0.13\'s keys exactly', async () => {
    const { base } = await start({ questions: false, approvals: false })
    const body = await list(base)
    expect(Object.keys(body).sort()).toEqual(['awayHoldMs', 'awayRecentClientMs', 'enabled', 'items', 'liveWindowMs', 'mode', 'pending', 'pollIntervalMs', 'protocolVersion', 'serverStartedAt', 'settled', 'stats', 'waitingAtMac', 'waitingAtMacForgottenBefore'])
  })

  it('holds a question with no client live, lists it as held with its words, and a web answer with a touch reaches the hook', async () => {
    const { base, store } = await start({ questions: true, approvals: false })
    const payload = { tool_use_id: 'toolu_route_q' }
    store.apply({ ts: Date.now(), ppid: 1, sessionId: SESSION, event: 'PreToolUse', payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, ...payload } }, false)
    const held = await hook(base, { ...permissionEnvelope('AskUserQuestion', ASK_INPUT, payload, Date.now()), hookWaitS: 3600, askHold: 1 })
    const listed = await until(async () => { const b = await list(base); return (b.items as unknown[]).length ? b : undefined })
    const item = (listed.items as Record<string, unknown>[])[0]!
    expect(item).toMatchObject({ toolUseId: 'toolu_route_q', fullHold: true, answerable: true })
    expect(listed.webAnswer).toEqual({ touchRequired: true, touchMaxMs: 60_000, confirmApprovals: true })
    expect((listed.waiting as Record<string, unknown>[])).toEqual([expect.objectContaining({ state: 'held', heldId: item.id, toolUseId: 'toolu_route_q' })])
    const answers = [{ labels: ['Bump'] }, { labels: ['Blue'] }]
    const noTouch = await fetch(`${base}/api/session-questions/${item.id}/answer`, { ...json({ clientAnswerId: 'w', answers }), headers: { 'content-type': 'application/json', ...web } })
    expect([noTouch.status, await noTouch.json()]).toEqual([403, { error: 'web_touch_required' }])
    const ok = await fetch(`${base}/api/session-questions/${item.id}/answer`, { ...json({ clientAnswerId: 'w', answers, presenceAgeMs: 50 }), headers: { 'content-type': 'application/json', ...web } })
    expect(ok.status).toBe(200)
    expect(await held.reply).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  })

  it('a web approval: confirm (web door only), then answer with the id; the token door needs no confirm', async () => {
    const { base } = await start({ questions: false, approvals: true })
    const held = await hook(base, { ...permissionEnvelope('Bash', { command: 'git push' }, { tool_use_id: 'toolu_route_b' }, Date.now()), hookWaitS: 3600 })
    const listed = await until(async () => { const b = await list(base); return (b.items as unknown[]).length ? b : undefined })
    const id = (listed.items as Record<string, unknown>[])[0]!.id
    const byToken = await fetch(`${base}/api/session-questions/${id}/confirm`, { ...json({ decision: 'allow', presenceAgeMs: 0 }), headers: { 'content-type': 'application/json', ...app } })
    expect([byToken.status, await byToken.json()]).toEqual([400, { error: 'invalid_confirm', reason: 'surface' }])
    const noConfirm = await fetch(`${base}/api/session-questions/${id}/answer`, { ...json({ clientAnswerId: 'w', decision: 'allow', presenceAgeMs: 0 }), headers: { 'content-type': 'application/json', ...web } })
    expect([noConfirm.status, await noConfirm.json()]).toEqual([403, { error: 'confirm_required' }])
    const confirm = await (await fetch(`${base}/api/session-questions/${id}/confirm`, { ...json({ decision: 'allow', presenceAgeMs: 0 }), headers: { 'content-type': 'application/json', ...web } })).json() as Record<string, unknown>
    const ok = await fetch(`${base}/api/session-questions/${id}/answer`, { ...json({ clientAnswerId: 'w', decision: 'allow', presenceAgeMs: 0, confirmId: confirm.confirmId }), headers: { 'content-type': 'application/json', ...web } })
    expect(ok.status).toBe(200)
    expect(await held.reply).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  })

  it('with both hold switches off a question at the Mac adds nothing to the route, and /confirm is 404', async () => {
    const { base, store } = await start({ questions: false, approvals: false })
    store.apply({ ts: Date.now(), ppid: 1, sessionId: SESSION, event: 'PreToolUse', payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_w' } }, false)
    const body = await list(base)
    expect('waiting' in body || 'webAnswer' in body).toBe(false)
    const confirm = await fetch(`${base}/api/session-questions/pq_000000000000000000000001/confirm`, { ...json({ decision: 'allow', presenceAgeMs: 0 }), headers: { 'content-type': 'application/json', ...web } })
    expect([confirm.status, await confirm.json()]).toEqual([404, { error: 'not_found' }])
  })

  it('index.ts wires the switches from the environment, the engine from the registry, and leaves the 6.60.0 timeout line as it was', async () => {
    const { readFileSync } = await import('node:fs')
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    expect(index).toContain('  fullHold: () => fullHoldSwitches(process.env),')
    expect(index).toContain('  engineFor: (sessionId, ppid) => engineForHookProcess(sessionId, ppid),')
    expect(index).toContain('  engineStatus: (sessionId, pid) => registryStatusForPid(pid, sessionId),')
    expect(index).toContain('  installedHookTimeoutS: () => cachedHookStatus().permissionHookTimeoutS,')
  })

  it('answered at the desk: the PostToolUse answers the held hook request {} at once, over the real socket', async () => {
    const { base, broker, store } = await start({ questions: true, approvals: false })
    const payload = { tool_use_id: 'toolu_desk' }
    const held = await hook(base, { ...permissionEnvelope('AskUserQuestion', ASK_INPUT, payload, Date.now()), hookWaitS: 3600, askHold: 1 })
    await until(async () => (broker.pendingCount() ? true : undefined))
    const t0 = Date.now()
    store.apply({ ts: Date.now(), ppid: 1, sessionId: SESSION, event: 'PostToolUse', payload: { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, ...payload } }, false)
    expect(await held.reply).toEqual({})
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(broker.settledList()[0]).toMatchObject({ resolution: 'retracted' })
  })

  it('the hook leaving settles the held item (hook_gone), as before', async () => {
    const { base, broker } = await start({ questions: true, approvals: false })
    const held = await hook(base, { ...permissionEnvelope('AskUserQuestion', ASK_INPUT, { tool_use_id: 'toolu_gone' }, Date.now()), hookWaitS: 3600, askHold: 1 })
    await until(async () => (broker.pendingCount() ? true : undefined))
    held.abort()
    await until(async () => (broker.pendingCount() === 0 ? true : undefined))
    expect(broker.settledList()[0]).toMatchObject({ resolution: 'hook_gone' })
  })
})
