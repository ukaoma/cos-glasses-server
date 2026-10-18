// 6.78.0 (P3) INTEGRATION: the real queue router, the real bindings router, the real binding
// registry on a real file, and the drainer's real loopback deliver over HTTP. Only the edges
// are faked: the occupancy verdict, the native head, and the two delivery hops (which count).
//
// THE PROPERTY (V2 B2, V3 B3). The drainer posts the turns route with the parked row's OWN
// key while that row is `delivering`. Receipts must therefore never count a waiting or
// delivering row, or the queue refuses its own delivery and a parked turn never lands. With
// receipts on, a parked turn lands EXACTLY ONCE, and every retry of the key after that is a
// replay. The mutation gate drops the status filter and this file must fail.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-receipts-int-'))
  process.env.COS_DATA_DIR = dir
  return { dir }
})
import express from 'express'
import { mkdirSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAgentSessionBindingsRouter, type AgentSessionBindingsDeps, type BindingRegistry } from './agent-session-bindings.js'
import { createThreadTurnQueueRouter, drainThread, type ThreadTurnQueueDeps } from './thread-turn-queue.js'
import { AgentSessionBindingRegistry } from '../lib/agent-session-binding-registry.js'
import { targetKey } from '../lib/agent-session-binding-store.js'
import { makeTurnReceiptLookup } from '../lib/queue-turn-evidence.js'
import { deliverQueuedTurnOverLoopback } from '../lib/thread-turn-queue-deliver.js'
import { readQueue } from '../lib/thread-turn-queue-store.js'
import type { Occupancy } from '../lib/thread-occupancy.js'

afterAll(() => { rmSync(FIXTURE.dir, { recursive: true, force: true }) })

const FLAGS = ['COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER'] as const
const savedEnv: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]))

let thread = ''
let storeFile = ''
let clock = 1_790_000_000_000
let busy = true
let spawns: string[] = []
let frames: string[] = []
let live: () => Promise<{ ok: boolean; reason: string }> = async () => ({ ok: false, reason: 'no_record' })
let server: ReturnType<ReturnType<typeof express>['listen']> | null = null
let port = 0
let seq = 0

beforeEach(() => {
  thread = randomUUID()
  const home = join(FIXTURE.dir, `.cos-glasses-${thread.slice(0, 8)}`, 'data')
  mkdirSync(home, { recursive: true })
  storeFile = join(home, 'agent-session-bindings.json')
  clock = 1_790_000_000_000
  busy = true
  spawns = []
  frames = []
  live = async () => ({ ok: false, reason: 'no_record' })
  for (const k of FLAGS) delete process.env[k]
})
afterEach(async () => {
  for (const k of FLAGS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())) }
  server = null
})

function wire(r: AgentSessionBindingRegistry): BindingRegistry {
  return {
    list: () => r.list(), available: () => r.available(), create: input => r.create(input), activate: (id, now) => r.activate(id, now),
    forceDetach: (id, now) => r.forceDetach(id, now), get: id => r.get(id), checkQueuedPrompt: (claim, now) => r.checkQueuedPrompt(claim, now),
    pin: (id, job, now, extras) => r.pin(id, job, now, extras), unpin: (id, job, now, extras) => r.unpin(id, job, now, extras),
    findTurn: (id, turnId) => r.findTurn(id, turnId), recordTurn: (id, turnId, result, now) => r.recordTurn(id, turnId, result, now),
    orphanPinHold: (p, t, now) => r.orphanPinHold(p, t, now),
  }
}

/** One server process: a registry instance (its boot), both routers, one port. */
async function boot(bootId: string): Promise<{ registry: AgentSessionBindingRegistry; queueDeps: ThreadTurnQueueDeps }> {
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = null }
  const registry = AgentSessionBindingRegistry.open({ filePath: storeFile, onWarn: () => {}, bootId, now: clock })
  const occupancy = (): Occupancy => (busy ? { attachable: false, owners: [], reason: 'native_thread_working' } : { attachable: true, owners: [], reason: null })
  const bindingDeps: AgentSessionBindingsDeps = {
    probes: {
      isAlive: () => true, processStartMs: () => clock, fileExists: () => true, dirExists: () => true, readDir: () => [], readFile: () => '{}',
      lockHolders: () => [], cosSpawnedPids: () => new Map(), cursorAgentSession: () => null,
    },
    dirs: { claudeSessionsDir: '/x/.claude/sessions', codexLocksDir: '/x/.codex', cursorChatsDir: '/x/.cursor' },
    now: () => clock,
    bindings: wire(registry),
    attachEnabled: true,
    occupancy,
    resolveTarget: () => ({ workspaceFingerprint: 'w', sourceFingerprint: 's' }),
    nativeHead: () => 'head-1',
    deliverLiveTurn: async request => { frames.push(request.clientTurnId ?? ''); return live() },
    deliverAttachedTurn: async request => { spawns.push(request.turnId); return { status: 'completed', nativeRevisionAfter: 'head-1' } },
    ownership: { record: () => 'recorded', release: () => true },
    newId: () => `i${++seq}`,
    turnReceipt: makeTurnReceiptLookup({
      queueRows: (p, t) => readQueue(p, t, clock),
      attempt: (p, t, id) => registry.attemptFor(p, t, id),
      bootId,
    }),
  }
  const queueDeps: ThreadTurnQueueDeps = {
    occupancy: (p, t) => (busy ? { attachable: false, reason: 'native_thread_working' }
      : registry.attachBlocked(p, t, clock) ? { attachable: false, reason: 'native_target_busy' } : { attachable: true, reason: null }),
    turnEnded: () => true,
    activity: () => 'idle',
    deliver: t => deliverQueuedTurnOverLoopback(t, port, 'tok'),
    now: () => clock,
    bootId,
  }
  const app = express()
  app.use(express.json())
  app.use('/api', createThreadTurnQueueRouter(queueDeps))
  app.use('/api', createAgentSessionBindingsRouter(bindingDeps))
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server!.once('listening', () => r()))
  port = (server!.address() as AddressInfo).port
  return { registry, queueDeps }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** What the phone does: attach, then send the turn under its key. */
async function phoneSend(clientTurnId: string, prompt: string): Promise<{ status: number; body: any }> {
  clock += 91_000 // past IDLE_LEASE_YIELD_MS, so a fresh attach supersedes an idle lease
  const a = await post(`/api/agent-sessions/claude/${thread}/attach`, { cosSessionId: 'cos-phone' })
  if (a.status !== 201) return a
  return post(`/api/agent-sessions/bindings/${a.body.bindingId}/turns`, { clientTurnId, prompt, epoch: a.body.epoch, targetKey: targetKey('claude', thread) })
}

const settle = () => new Promise(r => setTimeout(r, 30))

describe('receipts ON: the drain lands a parked turn EXACTLY ONCE (RC-1)', () => {
  it('parked, drained over loopback, delivered once; every later retry of the key is a replay', async () => {
    const { queueDeps } = await boot('boot-1')
    const key = `ct-${randomUUID()}`
    const parked = await post(`/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: key, cosSessionId: 'cos-phone', prompt: 'also check the footer' })
    expect(parked.status).toBe(202)

    busy = false
    clock += 91_000
    const pass = await drainThread('claude', thread, queueDeps)
    await settle()
    expect(pass.delivered).toBe(1)
    expect(spawns).toHaveLength(1)
    expect(readQueue('claude', thread, clock).find(t => t.clientTurnId === key)?.status).toBe('delivered')

    clock += 60_000
    await drainThread('claude', thread, queueDeps)
    const retry = await phoneSend(key, 'also check the footer')
    expect(retry.body.replayed).toBe(true)
    const repark = await post(`/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: key, cosSessionId: 'cos-phone', prompt: 'also check the footer' })
    expect(repark).toMatchObject({ status: 409, body: { error: 'duplicate_turn', state: 'delivered' } })
    await settle()
    expect(spawns).toHaveLength(1)
  })
})

describe('an unverified live frame: never a second copy (OO-3, V1 W6)', () => {
  it('the drain: live_unverified, then the next pass replays unknown and settles it; nothing is spawned', async () => {
    live = async () => ({ ok: false, reason: 'unverified' })
    const { queueDeps } = await boot('boot-1')
    const key = `ct-${randomUUID()}`
    await post(`/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: key, cosSessionId: 'cos-phone', prompt: 'ship it' })
    busy = false
    clock += 91_000
    await drainThread('claude', thread, queueDeps)
    expect(readQueue('claude', thread, clock).find(t => t.clientTurnId === key)).toMatchObject({ status: 'waiting', reason: 'live_unverified' })
    clock += 91_000
    await drainThread('claude', thread, queueDeps)
    expect(readQueue('claude', thread, clock).find(t => t.clientTurnId === key)).toMatchObject({ status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown' })
    clock += 91_000
    await drainThread('claude', thread, queueDeps)
    await settle()
    expect(frames).toEqual([key])
    expect(spawns).toEqual([])
  })

  it('the phone, after a live_unverified and a restart: the retry is a receipt replay, never a second frame', async () => {
    busy = false
    live = async () => ({ ok: false, reason: 'unverified' })
    await boot('boot-1')
    const key = `ct-${randomUUID()}`
    const first = await phoneSend(key, 'deploy the fix')
    expect(first).toMatchObject({ status: 409, body: { reason: 'live_unverified', retryable: true } })
    live = async () => ({ ok: true, reason: 'delivered' })
    await boot('boot-2')
    const retry = await phoneSend(key, 'deploy the fix')
    expect(retry).toMatchObject({ status: 409, body: { outcome: 'ambiguous', deliveryState: 'unknown', replayed: true, receipt: 'attempt' } })
    await settle()
    expect(frames).toEqual([key])
    expect(spawns).toEqual([])
  })

  it('the phone, when the process died INSIDE the hop: the pin holds 21 minutes, then the key replays unknown', async () => {
    busy = false
    live = () => new Promise(() => { /* the process dies inside the hop */ })
    await boot('boot-1')
    const key = `ct-${randomUUID()}`
    void phoneSend(key, 'deploy the fix').catch(() => {})
    const until = Date.now() + 3_000
    while (frames.length === 0 && Date.now() < until) await settle()
    expect(frames).toEqual([key])
    const pinnedAt = clock
    live = async () => ({ ok: true, reason: 'delivered' })
    const { queueDeps } = await boot('boot-2')
    // The retry meets the dead boot's pin: refused, queueable, with when it frees.
    const held = await phoneSend(key, 'deploy the fix')
    expect(held).toMatchObject({ status: 409, body: { attached: false, reason: 'native_target_busy' } })
    expect(held.body.reasonCopy).toMatch(/^An earlier run may still be running · frees \d{1,2}:\d{2}$/)
    // The lens parks it under the same key; the drain holds while the pin does.
    expect((await post(`/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: key, cosSessionId: 'cos-phone', prompt: 'deploy the fix' })).status).toBe(202)
    await drainThread('claude', thread, queueDeps)
    expect(readQueue('claude', thread, clock).find(t => t.clientTurnId === key)?.status).toBe('waiting')
    // 31 minutes after the pin (P7 S6): released with an ambiguous record; the drain's own post replays it.
    clock = pinnedAt + 31 * 60_000
    await drainThread('claude', thread, queueDeps)
    expect(readQueue('claude', thread, clock).find(t => t.clientTurnId === key)).toMatchObject({ status: 'refused', reason: 'delivery_unknown_after_restart', deliveryState: 'unknown' })
    await settle()
    expect(frames).toEqual([key])
    expect(spawns).toEqual([])
  })
})
