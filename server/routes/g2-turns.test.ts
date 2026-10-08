// G2 authority Tier 1 (unreleased): the read-only endpoint, and the queue, drain and Cursor
// Stop paths, each against a real express server. The glasses' address is this Mac's LAN
// address with the own-address list narrowed (the socket is real; only the list is injected).
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'

// Hoisted: the queue store reads its data dir at import time (see thread-turn-queue.test.ts).
vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  process.env.COS_DATA_DIR = mkdtempSync(join(tmpdir(), 'cos-g2-turns-'))
})
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireApiToken } from '../lib/api-auth.js'
import { describeG2Turn, g2TurnFooter, G2TurnLedger, G2TurnProvenance, turnTextSha256 } from '../lib/g2-turn-provenance.js'
import { deliverQueuedTurnOverLoopback } from '../lib/thread-turn-queue-deliver.js'
import { readQueue, writeQueue } from '../lib/thread-turn-queue-store.js'
import type { QueuedThreadTurn } from '../lib/thread-turn-queue.js'
import { createG2TurnsRouter } from './g2-turns.js'
import { createThreadTurnQueueRouter, type ThreadTurnQueueDeps } from './thread-turn-queue.js'
import { CURSOR_STOP_FOLLOWUP_PATH, createCursorStopFollowupRouter } from './cursor-stop-followup.js'

const LAN = Object.values(networkInterfaces()).flat().find(e => e && e.family === 'IPv4' && !e.internal)?.address ?? null
const INSTANCE = 'muytwk3t-lafw'
const G2H = { 'x-cos-client-instance': INSTANCE, 'x-cos-client': 'glasses' }
const TOKEN = 'api-token-test'
const roots: string[] = []
const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())) })
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  if (process.env.COS_DATA_DIR) rmSync(process.env.COS_DATA_DIR, { recursive: true, force: true })
})

function g2(paired = true): G2TurnProvenance {
  const dir = mkdtempSync(join(tmpdir(), 'g2-prov-'))
  roots.push(dir)
  return new G2TurnProvenance({
    ledger: new G2TurnLedger(join(dir, 'g2-turn-ledger.jsonl')),
    pairedInstance: device => (paired && device === LAN ? INSTANCE : null),
    ownAddresses: () => ({ addresses: new Set(['127.0.0.1', '::1']), bridgeSubnets: [] }),
  })
}

async function listen(app: express.Express, host: string): Promise<string> {
  const server = await new Promise<Server>(r => { const l = app.listen(0, host, () => r(l)) })
  servers.push(server)
  return `http://${host}:${(server.address() as AddressInfo).port}`
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('GET /api/g2-turns/:turnId', () => {
  async function endpoint(p: G2TurnProvenance) {
    const app = express()
    app.use('/api', requireApiToken(TOKEN))
    app.use('/api', createG2TurnsRouter({ provenance: p }))
    return listen(app, '127.0.0.1')
  }
  const auth = { 'x-cos-token': TOKEN }

  it('needs the API token', async () => {
    const base = await endpoint(g2())
    expect((await call(base, 'GET', '/api/g2-turns/ct-g2-00000001')).status).toBe(401)
    expect((await call(base, 'GET', '/api/g2-turns/ct-g2-00000001', undefined, { 'x-cos-token': 'wrong' })).status).toBe(401)
  })
  it('validates the id strictly', async () => {
    const base = await endpoint(g2())
    for (const bad of ['short', 'has%20space0000', '-leadingdash0000', `${'a'.repeat(129)}`, '..%2F..%2Fetc%2Fpasswd']) {
      const res = await call(base, 'GET', `/api/g2-turns/${bad}`, undefined, auth)
      expect(res.status, bad).toBe(400)
      expect(res.json, bad).toEqual({ found: false, error: 'invalid_turn_id' })
    }
  })
  it('404s an unknown turn', async () => {
    const res = await call(await endpoint(g2()), 'GET', '/api/g2-turns/ct-g2-unknown01', undefined, auth)
    expect(res).toEqual({ status: 404, json: { found: false, turnId: 'ct-g2-unknown01' } })
  })
  it('answers a recorded turn with the contract fields', async () => {
    const p = g2()
    p.record({ turnId: 'ct-g2-known0001', prompt: 'words', verdict: p.originOf({ socket: { remoteAddress: LAN ?? '100.81.195.27' }, headers: G2H }), provider: 'claude', sessionId: 'sid-1', via: 'live' })
    const res = await call(await endpoint(p), 'GET', '/api/g2-turns/ct-g2-known0001', undefined, auth)
    expect(res.status).toBe(200)
    expect(Object.keys(res.json).sort()).toEqual(['ageMs', 'createdAt', 'found', 'origin', 'sealed', 'target', 'textSha256', 'turnId', 'verifiedOrigin', 'via'])
    expect(res.json).toMatchObject({ found: true, turnId: 'ct-g2-known0001', textSha256: turnTextSha256('words'), target: { provider: 'claude', sessionId: 'sid-1' } })
    expect(typeof res.json.ageMs).toBe('number')
  })
})

describe.skipIf(!LAN)('the queue paths', () => {
  let seq = 0
  let deliverFn: ThreadTurnQueueDeps['deliver'] = async () => ({ ok: true })
  function queueApp(p: G2TurnProvenance, extra: Partial<ThreadTurnQueueDeps> = {}) {
    const app = express()
    app.use(express.json())
    app.use('/api', createThreadTurnQueueRouter({
      occupancy: () => ({ attachable: false, reason: 'native_thread_working' }),
      turnEnded: () => false,
      activity: () => 'working',
      deliver: t => deliverFn(t),
      now: () => 10_000,
      provenance: p,
      ...extra,
    }))
    return app
  }

  it('parking a turn records its origin (ledger via queue) and keeps it for the drain', async () => {
    const p = g2()
    const thread = `thr-g2-${++seq}`
    const base = await listen(queueApp(p), LAN!)
    const res = await call(base, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: 'ct-g2-queue-001', cosSessionId: 'cos-1', prompt: 'later please' }, G2H)
    expect(res.status).toBe(202)
    expect(await describeG2Turn(p, 'ct-g2-queue-001', Date.now())).toMatchObject({ via: 'queue', verifiedOrigin: true, target: { provider: 'claude', sessionId: thread } })
    expect(p.queuedVerdict('claude', thread, 'ct-g2-queue-001', 'later please')?.verifiedOrigin).toBe(true)
  })

  it('an edit from this Mac makes the parked words local; a cancel forgets them', async () => {
    const p = g2()
    const thread = `thr-g2-${++seq}`
    const remote = await listen(queueApp(p), LAN!)
    const local = await listen(queueApp(p), '127.0.0.1')
    await call(remote, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: 'ct-g2-queue-002', cosSessionId: 'cos-1', prompt: 'later please' }, G2H)
    expect((await call(local, 'PATCH', `/api/agent-sessions/claude/${thread}/queued-turns/ct-g2-queue-002`, { prompt: 'something else' }, G2H)).status).toBe(200)
    expect(p.queuedVerdict('claude', thread, 'ct-g2-queue-002', 'something else')?.verifiedOrigin).toBe(false)
    expect(p.issueCarry({ provider: 'claude', threadId: thread, clientTurnId: 'ct-g2-queue-002', prompt: 'something else' })).not.toBeNull()
    expect(await describeG2Turn(p, 'ct-g2-queue-002', Date.now())).toMatchObject({ via: 'queue-edit', verifiedOrigin: false })
    await call(local, 'DELETE', `/api/agent-sessions/claude/${thread}/queued-turns/ct-g2-queue-002`)
    expect(p.queuedVerdict('claude', thread, 'ct-g2-queue-002', 'something else')).toBeNull()
  })

  it('a native Codex edit from the glasses is footed and ledgered; the listing shows the words without the footer', async () => {
    const p = g2()
    const thread = `thr-g2-${++seq}`
    const native = [{ id: 'native-one', input: [{ type: 'text', text: 'whole message' }] }]
    const base = await listen(queueApp(p, { nativeQueue: {
      list: async () => native as never,
      update: async (_t: string, id: string, prompt: string) => { native.find(r => r.id === id)!.input[0].text = prompt },
      cancel: async () => true,
    } as never }), LAN!)
    const path = `/api/agent-sessions/codex/${thread}/queued-turns`
    expect((await call(base, 'PATCH', `${path}/codex-native:native-one`, { prompt: 'changed words' }, G2H)).json.updated).toBe(true)
    const sent = native[0].input[0].text
    const id = /\[COS-G2 turn (cnedit-[0-9a-f]{24}) /.exec(sent)?.[1]
    expect(sent).toBe(`changed words\n${g2TurnFooter(id!)}`)
    expect(await describeG2Turn(p, id!, Date.now())).toMatchObject({ via: 'codex-native-edit', verifiedOrigin: true, textSha256: turnTextSha256('changed words') })
    expect((await call(base, 'GET', path)).json.turns[0]).toMatchObject({ prompt: 'changed words' })
  })
})

describe('the drain hop carries the token, and only on the turn leg', () => {
  it('sends X-Cos-Turn-Carry with the turn POST when the issuer has one', async () => {
    const seen: Array<{ url: string; carry: unknown }> = []
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', carry: req.headers['x-cos-turn-carry'] })
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(req.url?.endsWith('/attach') ? { bindingId: 'bnd-1', epoch: 3 } : { outcome: 'queued' }))
        res.statusCode = 200
      })
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const turn = { clientTurnId: 'ct-g2-drain-001', cosSessionId: 'cos-1', provider: 'claude', threadId: 'a1b2c3d4-0000-4000-8000-000000000001', prompt: 'p', queuedAt: 1, status: 'delivering', attempts: 1 } as QueuedThreadTurn
    expect(await deliverQueuedTurnOverLoopback(turn, port, 'tok', () => 'carry-token-1')).toEqual({ ok: true })
    expect(seen.map(s => s.carry)).toEqual([undefined, 'carry-token-1'])
    seen.length = 0
    expect(await deliverQueuedTurnOverLoopback(turn, port, 'tok', () => null)).toEqual({ ok: true })
    expect(await deliverQueuedTurnOverLoopback(turn, port, 'tok', () => { throw new Error('x') })).toEqual({ ok: true })
    expect(seen.map(s => s.carry)).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('the Cursor Stop hand-off', () => {
  const CONV = 'd1728e99-1007-4957-b36b-34df7d525e14'
  const envelope = { ts: 8_500, ppid: 2, event: 'Stop', payload: { conversation_id: CONV, session_id: CONV, hook_event_name: 'stop', status: 'completed', loop_count: 0, cursor_version: '3.21.13' } }
  async function stopApp(p: G2TurnProvenance) {
    const app = express()
    app.use(createCursorStopFollowupRouter({ hookToken: () => 'hook-tok', readQueue, writeQueue, now: () => 9_000, provenance: p }))
    return listen(app, '127.0.0.1')
  }
  const park = (id: string, prompt: string) => writeQueue('cursor', CONV, [
    { clientTurnId: id, cosSessionId: 'cos-1', provider: 'cursor', threadId: CONV, prompt, queuedAt: 1_000, status: 'waiting', attempts: 0 },
  ])

  it('foots and ledgers a parked G2 turn with the origin captured when it was parked', async () => {
    const p = g2()
    park('ct-g2-cursor-01', 'from the lens')
    p.noteQueued('cursor', CONV, 'ct-g2-cursor-01', 'from the lens', p.originOf({ socket: { remoteAddress: LAN ?? '100.81.195.27' }, headers: G2H }))
    const res = await call(await stopApp(p), 'POST', CURSOR_STOP_FOLLOWUP_PATH, envelope, { 'x-cos-hook-token': 'hook-tok' })
    expect(res.json).toEqual({ followup_message: `from the lens\n${g2TurnFooter('ct-g2-cursor-01')}` })
    expect(await describeG2Turn(p, 'ct-g2-cursor-01', Date.now())).toMatchObject({ via: 'cursor-stop-followup', target: { provider: 'cursor', sessionId: CONV } })
  })

  it('a turn whose parked words changed on disk goes out unfooted, ledgered local', async () => {
    const p = g2()
    park('ct-g2-cursor-02', 'tampered text')
    p.noteQueued('cursor', CONV, 'ct-g2-cursor-02', 'original text', p.originOf({ socket: { remoteAddress: LAN ?? '100.81.195.27' }, headers: G2H }))
    const res = await call(await stopApp(p), 'POST', CURSOR_STOP_FOLLOWUP_PATH, envelope, { 'x-cos-hook-token': 'hook-tok' })
    expect(res.json).toEqual({ followup_message: 'tampered text' })
    expect(await describeG2Turn(p, 'ct-g2-cursor-02', Date.now())).toMatchObject({ verifiedOrigin: false, origin: { client: 'local' } })
  })
})
