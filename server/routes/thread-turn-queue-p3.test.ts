// 6.78.0 (P3, Sessions) against the real queue router, the real drainer and real queue files:
// the restart reconcile, the row stamp, the replayed-unknown mapping, the extended rows,
// replay-before-gate, Send again and Session steer. Wire bodies are checked against the
// binding contract fixture (plan v3.1 section 5.3).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// HOISTED, as in thread-turn-queue.test.ts: DATA_DIR is resolved at import time.
const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-tq-p3-'))
  process.env.COS_DATA_DIR = dir
  return { dir }
})
import express from 'express'
import { readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { request, type Server } from 'node:http'
import { afterAll } from 'vitest'
import { createThreadTurnQueueRouter, drainThread, publicRow, reconcileDeliveringTurns, type ThreadTurnQueueDeps } from './thread-turn-queue.js'
import { readQueue, writeQueue } from '../lib/thread-turn-queue-store.js'
import { QUEUED_TURN_TTL_MS, UNKNOWN_DELIVERY_RETENTION_MS, type QueuedThreadTurn } from '../lib/thread-turn-queue.js'
import type { DeliveryEvidence } from '../lib/queue-turn-evidence.js'
import { REASON_COPY } from './agent-session-bindings.js'

afterAll(() => { rmSync(FIXTURE.dir, { recursive: true, force: true }) })

const CONTRACT = JSON.parse(readFileSync(new URL('../lib/__fixtures__/pi-durable-contracts/session-steer.json', import.meta.url), 'utf8'))
const FLAGS = ['COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER', 'COS_CONTINUE_LIVE'] as const
const savedEnv: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]))

let server: Server | null = null
let baseUrl = ''
let threadId = ''
let clock = 10_000
let gate: { attachable: boolean; reason: string | null } = { attachable: false, reason: 'native_thread_working' }
let delivered: string[] = []
let calls: string[] = []

beforeEach(() => {
  threadId = randomUUID()
  clock = 10_000
  gate = { attachable: false, reason: 'native_thread_working' }
  delivered = []
  calls = []
  for (const k of FLAGS) delete process.env[k]
})
afterEach(async () => {
  for (const k of FLAGS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())) }
  server = null
})

function deps(over: Partial<ThreadTurnQueueDeps> = {}): ThreadTurnQueueDeps {
  return {
    occupancy: () => gate,
    turnEnded: () => true,
    activity: () => 'idle',
    deliver: async t => { delivered.push(t.clientTurnId); return { ok: true } },
    now: () => clock,
    ...over,
  }
}

async function start(d: ThreadTurnQueueDeps): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use('/api', createThreadTurnQueueRouter(d))
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server!.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  return new Promise(resolve => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, res => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => { let json: any = {}; try { json = JSON.parse(raw || '{}') } catch { json = {} } resolve({ status: res.statusCode ?? 0, json, text: raw }) })
    })
    // A request the test abandons (a hop that never returns) is closed with the server.
    req.on('error', () => resolve({ status: 0, json: {}, text: '' }))
    if (data) req.write(data)
    req.end()
  })
}

const base = () => `/api/agent-sessions/claude/${threadId}/queued-turns`
const row = (over: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn => ({
  clientTurnId: `ct-${randomUUID()}`, cosSessionId: 'cos-1', provider: 'claude', threadId, prompt: 'also check the footer',
  queuedAt: clock, status: 'waiting', attempts: 0, ...over,
})
const onDisk = (id: string) => readQueue('claude', threadId, clock).find(t => t.clientTurnId === id)

// ----------------------------------------------------------------------------- reconcile

describe('the drain stamps a row as it enters delivering (COS_QUEUE_RECONCILE)', () => {
  it('journal: 1 and the boot, durably, BEFORE the deliver call; flag off: the 6.77 row', async () => {
    gate = { attachable: true, reason: null }
    const turn = row()
    writeQueue('claude', threadId, [turn])
    let seen: QueuedThreadTurn | undefined
    await drainThread('claude', threadId, deps({ bootId: 'boot-A', deliver: async t => { seen = onDisk(t.clientTurnId); return { ok: true } } }))
    expect(seen).toMatchObject({ status: 'delivering', journal: 1, deliveringBootId: 'boot-A', attempts: 1 })

    process.env.COS_QUEUE_RECONCILE = '0'
    const legacy = row()
    writeQueue('claude', threadId, [legacy])
    await drainThread('claude', threadId, deps({ bootId: 'boot-A', deliver: async t => { seen = onDisk(t.clientTurnId); return { ok: true } } }))
    expect(seen?.status).toBe('delivering')
    expect(seen && 'journal' in seen).toBe(false)
    expect(seen && 'deliveringBootId' in seen).toBe(false)
  })
})

describe('the restart reconcile settles what a dead boot left delivering', () => {
  const stranded = (over: Partial<QueuedThreadTurn> = {}) => row({ status: 'delivering', attempts: 1, journal: 1, deliveringBootId: 'boot-dead', ...over })

  it('not_delivered: back to waiting with the attempt SPENT, and sent exactly once in the same pass', async () => {
    gate = { attachable: true, reason: null }
    const t = stranded()
    writeQueue('claude', threadId, [t])
    let attemptsAtSend = -1
    await drainThread('claude', threadId, deps({ bootId: 'boot-live', deliveryEvidence: () => 'not_delivered', deliver: async x => { delivered.push(x.clientTurnId); attemptsAtSend = onDisk(x.clientTurnId)!.attempts; return { ok: true } } }))
    expect(delivered).toEqual([t.clientTurnId])
    expect(attemptsAtSend).toBe(2)
    expect(onDisk(t.clientTurnId)?.status).toBe('delivered')
  })

  it('delivered: settled delivered, reason reconciled_after_restart, never sent', async () => {
    const t = stranded()
    writeQueue('claude', threadId, [t])
    await drainThread('claude', threadId, deps({ bootId: 'boot-live', deliveryEvidence: () => 'delivered' }))
    expect(delivered).toEqual([])
    expect(onDisk(t.clientTurnId)).toMatchObject({ status: 'delivered', reason: 'reconciled_after_restart' })
  })

  it('unknown: refused, delivery_unknown_after_restart, kept six hours, NEVER resent, and cancel no longer 409s', async () => {
    const t = stranded()
    writeQueue('claude', threadId, [t])
    const d = deps({ bootId: 'boot-live', deliveryEvidence: () => 'unknown' })
    await start(d)
    await drainThread('claude', threadId, d)
    expect(onDisk(t.clientTurnId)).toMatchObject({ status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown' })
    for (let i = 0; i < 4; i++) { clock += QUEUED_TURN_TTL_MS / 4; await drainThread('claude', threadId, d) }
    expect(delivered).toEqual([])
    clock = 10_000 + 60 * 60 * 1000
    expect(onDisk(t.clientTurnId)?.status).toBe('refused')
    expect((await http('DELETE', `${base()}/${t.clientTurnId}`)).status).toBe(200)
    clock = 10_000 + UNKNOWN_DELIVERY_RETENTION_MS + 1
    expect(onDisk(t.clientTurnId)).toBeUndefined()
  })

  it('a row this boot is delivering is never touched, whatever the evidence says', async () => {
    const t = stranded({ deliveringBootId: 'boot-live' })
    writeQueue('claude', threadId, [t])
    let asked = 0
    await drainThread('claude', threadId, deps({ bootId: 'boot-live', deliveryEvidence: () => { asked++; return 'not_delivered' } }))
    expect(asked).toBe(0)
    expect(onDisk(t.clientTurnId)?.status).toBe('delivering')
  })

  it('with no boot id of its own the reconcile touches nothing: it cannot tell its own row in flight', async () => {
    const own = row({ status: 'delivering', attempts: 1, journal: 1 })
    const dead = stranded()
    writeQueue('claude', threadId, [own, dead])
    let asked = 0
    const counts = await reconcileDeliveringTurns('claude', threadId, deps({ deliveryEvidence: () => { asked++; return 'unknown' } }))
    expect(counts).toEqual({ delivered: 0, requeued: 0, unknown: 0 })
    expect(asked).toBe(0)
    expect(onDisk(own.clientTurnId)?.status).toBe('delivering')
    expect(onDisk(dead.clientTurnId)?.status).toBe('delivering')
  })

  it('a legacy (unstamped) row reads unknown even when the evidence says not_delivered', async () => {
    const t = row({ status: 'delivering', attempts: 1 })
    writeQueue('claude', threadId, [t])
    await drainThread('claude', threadId, deps({ bootId: 'boot-live', deliveryEvidence: () => 'not_delivered' }))
    expect(delivered).toEqual([])
    expect(onDisk(t.clientTurnId)).toMatchObject({ status: 'refused', deliveryState: 'unknown' })
  })

  it('a steer row reads unknown even when the evidence says not_delivered', async () => {
    const t = stranded({ mode: 'steer' })
    writeQueue('claude', threadId, [t])
    await drainThread('claude', threadId, deps({ bootId: 'boot-live', deliveryEvidence: () => 'not_delivered' }))
    expect(delivered).toEqual([])
    expect(onDisk(t.clientTurnId)).toMatchObject({ status: 'refused', deliveryState: 'unknown', mode: 'steer' })
  })

  it('a throwing or nonsense verdict is unknown', async () => {
    const a = stranded(), b = stranded()
    writeQueue('claude', threadId, [a, b])
    const counts = await reconcileDeliveringTurns('claude', threadId, deps({ bootId: 'boot-live', deliveryEvidence: (t: QueuedThreadTurn) => { if (t.clientTurnId === a.clientTurnId) throw new Error('boom'); return 'maybe' as DeliveryEvidence } }))
    expect(counts).toEqual({ delivered: 0, requeued: 0, unknown: 2 })
  })

  it('flag off: no reconcile, the row stays delivering exactly as on 6.77', async () => {
    process.env.COS_QUEUE_RECONCILE = '0'
    const t = stranded()
    writeQueue('claude', threadId, [t])
    await drainThread('claude', threadId, deps({ bootId: 'boot-live', deliveryEvidence: () => 'not_delivered' }))
    expect(onDisk(t.clientTurnId)?.status).toBe('delivering')
  })
})

describe('the drain maps a REPLAYED unknown straight to refused (V1 W6)', () => {
  it('one attempt, settled delivery_unknown_after_restart, never retried', async () => {
    gate = { attachable: true, reason: null }
    const t = row()
    writeQueue('claude', threadId, [t])
    let sends = 0
    const d = deps({ deliver: async () => { sends++; return { ok: false, reason: 'delivery_ambiguous', serverRetryable: false, replayed: true, deliveryState: 'unknown' } } })
    await drainThread('claude', threadId, d)
    expect(onDisk(t.clientTurnId)).toMatchObject({ status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown' })
    clock += 60_000; await drainThread('claude', threadId, d)
    expect(sends).toBe(1)
  })

  it('flag off: the 6.77 handling (back to waiting, attempt spent)', async () => {
    process.env.COS_QUEUE_RECONCILE = '0'
    gate = { attachable: true, reason: null }
    const t = row()
    writeQueue('claude', threadId, [t])
    await drainThread('claude', threadId, deps({ deliver: async () => ({ ok: false, reason: 'delivery_ambiguous', serverRetryable: false, replayed: true, deliveryState: 'unknown' }) }))
    expect(onDisk(t.clientTurnId)).toMatchObject({ status: 'waiting', attempts: 1 })
  })
})

// ----------------------------------------------------------------------------- rows

describe('publicRow: reason copy, delivery state, mode, resend links and resendable', () => {
  const SIX_SEVEN = ['attempts', 'clientTurnId', 'editable', 'owner', 'position', 'preview', 'prompt', 'queuedAt', 'reason', 'settledAt', 'status']

  it('flags on: the contract queue_row for a refused unknown row', () => {
    const r = row({ clientTurnId: CONTRACT.queue_row.clientTurnId, status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown', settledAt: clock })
    expect(publicRow(r, -1)).toMatchObject(CONTRACT.queue_row)
  })

  it('resendable only on refused or expired rows, and only with COS_QUEUE_RESEND on', () => {
    for (const status of ['waiting', 'delivering', 'delivered', 'cancelled'] as const) expect(publicRow(row({ status }), 0), status).not.toHaveProperty('resendable')
    expect(publicRow(row({ status: 'expired', reason: 'queued_turn_expired', settledAt: clock }), -1)).toMatchObject({ resendable: true })
    process.env.COS_QUEUE_RESEND = '0'
    expect(publicRow(row({ status: 'refused', settledAt: clock }), -1)).not.toHaveProperty('resendable')
  })

  it('all four flags off: exactly the 6.77 keys', () => {
    for (const k of ['COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER']) process.env[k] = '0'
    const r = row({ status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown', settledAt: clock, resendOf: 'x', mode: 'steer' })
    expect(Object.keys(publicRow(r, -1)).sort()).toEqual(SIX_SEVEN)
  })
})

describe('replay before the gate: a held key answers 409 duplicate_turn with its state', () => {
  it('a turn already delivered is not re-parked or sent again when the thread has since freed', async () => {
    const t = row({ status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown', settledAt: clock })
    writeQueue('claude', threadId, [t])
    gate = { attachable: true, reason: null }
    await start(deps())
    const again = await http('POST', base(), { clientTurnId: t.clientTurnId, cosSessionId: 'cos-1', prompt: t.prompt })
    expect(again.status).toBe(409)
    expect(again.json).toEqual({ ...CONTRACT.replies.duplicate.body })
  })

  it('flags off: the gate runs first, as on 6.77 (thread_free)', async () => {
    for (const k of ['COS_QUEUE_RECONCILE', 'COS_SESSION_STEER']) process.env[k] = '0'
    const t = row({ status: 'delivered', settledAt: clock })
    writeQueue('claude', threadId, [t])
    gate = { attachable: true, reason: null }
    await start(deps())
    const again = await http('POST', base(), { clientTurnId: t.clientTurnId, cosSessionId: 'cos-1', prompt: t.prompt })
    expect(again.status).toBe(409)
    expect(again.json).toEqual({ error: 'thread_free', hint: 'send_now' })
  })
})

// ----------------------------------------------------------------------------- Send again

describe('Send again: POST .../queued-turns/:clientTurnId/resend', () => {
  const resend = (id: string, body: Record<string, unknown>) => http('POST', `${base()}/${id}/resend`, body)
  const fresh = () => `ct-${randomUUID()}`

  it('copies the words on the server, once only across two surfaces at the same moment', async () => {
    const t = row({ status: 'refused', reason: 'delivery_attempts_exhausted', settledAt: clock })
    writeQueue('claude', threadId, [t])
    await start(deps())
    const [a, b] = await Promise.all([
      resend(t.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-lens', prompt: 'ignored' }),
      resend(t.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-phone' }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.json.clientTurnId).toBe(b.json.clientTurnId)
    const copies = readQueue('claude', threadId, clock).filter(x => x.resendOf === t.clientTurnId)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ prompt: t.prompt, status: 'waiting', attempts: 0 })
    expect(onDisk(t.clientTurnId)?.resentAs).toBe(copies[0].clientTurnId)
    expect(a.json).toMatchObject({ ...CONTRACT.resend.replies.ok.body, clientTurnId: copies[0].clientTurnId, resendOf: t.clientTurnId })
  })

  it('a repeat from anywhere answers the first copy', async () => {
    const t = row({ status: 'expired', reason: 'queued_turn_expired', settledAt: clock })
    writeQueue('claude', threadId, [t])
    await start(deps())
    const first = await resend(t.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-1' })
    const second = await resend(t.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-1' })
    expect(second.json.clientTurnId).toBe(first.json.clientTurnId)
    expect(second.json.replayed).toBe(true)
  })

  it('an unknown outcome needs acknowledge: may_duplicate', async () => {
    const t = row({ status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown', settledAt: clock })
    writeQueue('claude', threadId, [t])
    await start(deps())
    const refused = await resend(t.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-1' })
    expect(refused.status).toBe(409)
    expect(refused.json).toEqual(CONTRACT.resend.replies.acknowledge_required.body)
    expect(readQueue('claude', threadId, clock)).toHaveLength(1)
    const ok = await resend(t.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-1', acknowledge: 'may_duplicate' })
    expect(ok.status).toBe(200)
  })

  it('only refused or expired rows; a pruned row is 404 unknown_turn', async () => {
    const waiting = row(), done = row({ status: 'delivered', settledAt: clock })
    writeQueue('claude', threadId, [waiting, done])
    await start(deps())
    expect((await resend(waiting.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-1' })).json).toEqual(CONTRACT.resend.replies.not_resendable.body)
    expect((await resend(done.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-1' })).status).toBe(409)
    const gone = await resend('ct-pruned-0001', { clientTurnId: fresh(), cosSessionId: 'cos-1' })
    expect(gone.status).toBe(404)
    expect(gone.json).toEqual(CONTRACT.resend.replies.unknown_turn.body)
    expect((await resend(waiting.clientTurnId, { clientTurnId: 'bad id', cosSessionId: 'cos-1' })).status).toBe(400)
  })

  it('the copy is admitted even when the thread is free, and the drain sends it', async () => {
    const t = row({ status: 'refused', reason: 'delivery_attempts_exhausted', settledAt: clock })
    writeQueue('claude', threadId, [t])
    gate = { attachable: true, reason: null }
    const d = deps()
    await start(d)
    const copy = await resend(t.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-1' })
    expect(copy.status).toBe(200)
    await drainThread('claude', threadId, d)
    expect(delivered).toEqual([copy.json.clientTurnId])
  })

  it('COS_QUEUE_RESEND off: the route does not exist, as on 6.77', async () => {
    process.env.COS_QUEUE_RESEND = '0'
    const t = row({ status: 'refused', settledAt: clock })
    writeQueue('claude', threadId, [t])
    await start(deps())
    const res = await resend(t.clientTurnId, { clientTurnId: fresh(), cosSessionId: 'cos-1' })
    expect(res.status).toBe(404)
    expect(res.text).toContain('Cannot POST')
  })
})

// ----------------------------------------------------------------------------- steer

describe('Session steer (COS_SESSION_STEER): mode steer on the queued-turns POST', () => {
  const body = (over: Record<string, unknown> = {}) => ({ ...CONTRACT.post.body, clientTurnId: `ct-${randomUUID()}`, ...over })
  type Live = { ok: boolean; reason: string }
  function steerDeps(live: () => Promise<Live>, over: Partial<ThreadTurnQueueDeps> = {}): ThreadTurnQueueDeps {
    return deps({
      bootId: 'boot-live',
      continueLive: () => true,
      steerProbe: () => ({ peerInbox: true, waitingOnPrompt: false }),
      attempts: {
        begin: (_p, _t, id) => { calls.push(`begin:${id}:${onDisk(id)?.status}:${onDisk(id)?.mode}:${onDisk(id)?.journal}`); return true },
        settle: (_p, _t, id, exit) => { calls.push(`settle:${exit}`); return true },
      },
      deliverLiveTurn: async request => { calls.push(`deliver:${request.clientTurnId}`); return live() },
      ...over,
    })
  }

  it('the order: intent row (delivering, steer, stamped), then attempt pending, then the frame; 200 steered', async () => {
    process.env.COS_SESSION_STEER = '1'
    await start(steerDeps(async () => ({ ok: true, reason: 'delivered' })))
    const b = body()
    const res = await http('POST', base(), b)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ...CONTRACT.replies.steered.body, clientTurnId: b.clientTurnId })
    expect(calls).toEqual([`begin:${b.clientTurnId}:delivering:steer:1`, `deliver:${b.clientTurnId}`, 'settle:sent'])
    expect(onDisk(b.clientTurnId)).toMatchObject({ status: 'delivered', reason: 'steered', mode: 'steer' })
  })

  it('an unverified frame, a write failure or a throw: refused, unknown, never resent', async () => {
    process.env.COS_SESSION_STEER = '1'
    for (const live of [async () => ({ ok: false, reason: 'unverified' }), async () => ({ ok: false, reason: 'write_failed' }), async (): Promise<Live> => { throw new Error('socket') }]) {
      if (server) { await new Promise<void>(r => server!.close(() => r())); server = null }
      calls = []
      await start(steerDeps(live))
      const b = body()
      const res = await http('POST', base(), b)
      expect(res.status).toBe(200)
      expect(res.json).toEqual(CONTRACT.replies.unverified.body)
      expect(calls.at(-1)).toBe('settle:unknown')
      expect(onDisk(b.clientTurnId)).toMatchObject({ status: 'refused', reason: 'steer_unverified', deliveryState: 'unknown' })
      const again = await http('POST', base(), b)
      expect(again.status).toBe(409)
      expect(again.json).toEqual(CONTRACT.replies.duplicate.body)
    }
  })

  it('nothing reached the session: an ordinary parked turn, 202 with steerFallback, attempt not_sent', async () => {
    process.env.COS_SESSION_STEER = '1'
    const d = steerDeps(async () => ({ ok: false, reason: 'no_record' }))
    await start(d)
    const b = body()
    const res = await http('POST', base(), b)
    expect(res.status).toBe(202)
    expect(res.json).toEqual({ queued: true, clientTurnId: b.clientTurnId, position: 0, waitingOn: 'native_thread_working', steerFallback: 'no_outside_channel' })
    expect(calls.at(-1)).toBe('settle:not_sent')
    expect(onDisk(b.clientTurnId)).toMatchObject({ status: 'waiting', attempts: 0 })
    expect(onDisk(b.clientTurnId)).not.toHaveProperty('mode')
  })

  it('held on a permission prompt: queued, never framed (the contract fallback_queued)', async () => {
    process.env.COS_SESSION_STEER = '1'
    await start(steerDeps(async () => ({ ok: true, reason: 'delivered' }), { steerProbe: () => ({ peerInbox: true, waitingOnPrompt: true }) }))
    const res = await http('POST', base(), { ...CONTRACT.post.body })
    expect(res.status).toBe(202)
    expect(res.json).toEqual(CONTRACT.replies.fallback_queued.body)
    expect(calls).toEqual([])
  })

  it('requires COS_CONTINUE_LIVE and a peer inbox; Codex and Cursor fall back', async () => {
    process.env.COS_SESSION_STEER = '1'
    await start(steerDeps(async () => ({ ok: true, reason: 'delivered' }), { continueLive: () => false }))
    expect((await http('POST', base(), body())).json.steerFallback).toBe('no_outside_channel')
    await new Promise<void>(r => server!.close(() => r())); server = null
    await start(steerDeps(async () => ({ ok: true, reason: 'delivered' }), { steerProbe: () => ({ peerInbox: false, waitingOnPrompt: false }) }))
    expect((await http('POST', base(), body())).json.steerFallback).toBe('no_outside_channel')
    expect((await http('POST', `/api/agent-sessions/codex/${threadId}/queued-turns`, body())).json.steerFallback).toBe('no_outside_channel')
    expect((await http('POST', `/api/agent-sessions/cursor/${threadId}/queued-turns`, body())).json.steerFallback).toBe('engine_limit')
    expect(calls).toEqual([])
  })

  it('an attempt the journal could not record is never framed: queued, journal_unavailable', async () => {
    process.env.COS_SESSION_STEER = '1'
    await start(steerDeps(async () => ({ ok: true, reason: 'delivered' }), { attempts: { begin: () => false, settle: () => true } }))
    const b = body()
    const res = await http('POST', base(), b)
    expect(res.json.steerFallback).toBe('journal_unavailable')
    expect(calls).toEqual([])
    expect(onDisk(b.clientTurnId)).toMatchObject({ status: 'waiting', attempts: 0 })
  })

  it('fallback none: 409 steer_unavailable without a row, or refused steer_not_sent', async () => {
    process.env.COS_SESSION_STEER = '1'
    await start(steerDeps(async () => ({ ok: false, reason: 'connect_failed' }), { steerProbe: () => ({ peerInbox: true, waitingOnPrompt: true }) }))
    const b = body({ fallback: 'none' })
    expect(await http('POST', base(), b)).toMatchObject({ status: 409, json: { error: 'steer_unavailable', reason: 'permission_pending' } })
    expect(onDisk(b.clientTurnId)).toBeUndefined()
    await new Promise<void>(r => server!.close(() => r())); server = null
    await start(steerDeps(async () => ({ ok: false, reason: 'connect_failed' })))
    const c = body({ fallback: 'none' })
    expect(await http('POST', base(), c)).toMatchObject({ status: 200, json: { state: 'refused', reason: 'steer_not_sent' } })
    expect(onDisk(c.clientTurnId)).toMatchObject({ status: 'refused', reason: 'steer_not_sent' })
  })

  it('flag off: `mode: steer` is ignored and the 202 is the 6.77 body', async () => {
    await start(steerDeps(async () => ({ ok: true, reason: 'delivered' })))
    const b = body()
    const res = await http('POST', base(), b)
    expect(res.status).toBe(202)
    expect(res.json).toEqual({ queued: true, clientTurnId: b.clientTurnId, position: 0, waitingOn: 'native_thread_working' })
    expect(calls).toEqual([])
  })

  it('a crash between the intent row and the frame (SS-1b) settles unknown at the next boot and is never resent', async () => {
    process.env.COS_SESSION_STEER = '1'
    await start(steerDeps(() => new Promise(() => { /* the process dies inside the hop */ })))
    const b = body()
    void http('POST', base(), b)
    const until = Date.now() + 3_000
    while (Date.now() < until && !calls.some(c => c.startsWith('deliver:'))) await new Promise(r => setTimeout(r, 10))
    expect(onDisk(b.clientTurnId)).toMatchObject({ status: 'delivering', mode: 'steer', journal: 1, deliveringBootId: 'boot-live' })
    // Next boot: the real reconcile rule, no positive evidence.
    const { makeDeliveryEvidence } = await import('../lib/queue-turn-evidence.js')
    const evidence = makeDeliveryEvidence({ ledgerOutcome: () => null, attempt: () => ({ attempt: { bootId: 'boot-live', at: clock, mode: 'steer', exit: 'pending' }, evictedThrough: null }), transcriptLines: () => [] })
    gate = { attachable: true, reason: null }
    await drainThread('claude', threadId, deps({ bootId: 'boot-next', deliveryEvidence: evidence }))
    expect(delivered).toEqual([])
    expect(onDisk(b.clientTurnId)).toMatchObject({ status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown' })
  })
})

describe('the contract fixture keeps the real 6.77 values for pre-existing fields', () => {
  it('202 waitingOn is the gate reason and position counts from 0; the attach copy is the server\'s own', () => {
    expect(CONTRACT.replies.fallback_queued.body.waitingOn).toBe('native_thread_working')
    expect(CONTRACT.replies.fallback_queued.body.position).toBe(0)
    expect(CONTRACT.attach_refusal.reasonCopy).toBe(REASON_COPY.native_thread_working)
    expect(CONTRACT.copy.unknown.length).toBeLessThanOrEqual(CONTRACT.copy.maxColumns)
  })
})
