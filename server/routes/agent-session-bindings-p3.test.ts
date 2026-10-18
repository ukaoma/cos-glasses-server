// 6.78.0 (P3) on the attach and turns routes, against the REAL binding registry on a real
// file (inside a `.cos-glasses/data` dot directory, as in production):
//   - the attempt journal is on disk BEFORE any frame or spawn, and its exit is recorded
//     for every way a turn can end
//   - receipts: a key already sent (or that may have been) is replayed, never sent again;
//     a queue row the drainer is delivering is never a receipt
//   - the attach refusal's `steer` field, and the "frees h:mm" copy for a dead boot's pin
import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createAgentSessionBindingsRouter,
  orphanPinWaitCopy,
  REASON_COPY,
  type AgentSessionBindingsDeps,
  type BindingRegistry,
} from './agent-session-bindings.js'
import { AgentSessionBindingRegistry } from '../lib/agent-session-binding-registry.js'
import { targetKey } from '../lib/agent-session-binding-store.js'
import { makeTurnReceiptLookup } from '../lib/queue-turn-evidence.js'
import { sessionSteerAvailability, type QueuedThreadTurn } from '../lib/thread-turn-queue.js'
import { QUERY_JOB_ORPHAN_FENCE_MS } from '../lib/query-job-store.js'
import type { Occupancy } from '../lib/thread-occupancy.js'

const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const CODEX = '019fc80a-cc79-7921-8541-298e71695afd'
const KEY = targetKey('claude', SID)
const NOW = 1_786_000_000_000
const CONTRACT = JSON.parse(readFileSync(new URL('../lib/__fixtures__/pi-durable-contracts/session-steer.json', import.meta.url), 'utf8'))
const FLAGS = ['COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER'] as const
const savedEnv: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]))

const roots: string[] = []
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

let storeFile = ''
let seq = 0
let base = ''
let server: ReturnType<ReturnType<typeof express>['listen']> | null = null
let attempts: string[] = []
/** Advanced past IDLE_LEASE_YIELD_MS by every attach, so a second attach supersedes the idle first. */
let clock = NOW

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'cos-bind-p3-'))
  roots.push(root)
  const home = join(root, '.cos-glasses', 'data')
  mkdirSync(home, { recursive: true })
  storeFile = join(home, 'agent-session-bindings.json')
  attempts = []
  clock = NOW
  for (const k of FLAGS) delete process.env[k]
})
afterEach(async () => {
  for (const k of FLAGS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())) }
  server = null
})

const open = (bootId = 'boot-live') => AgentSessionBindingRegistry.open({ filePath: storeFile, now: NOW, onWarn: () => {}, bootId, pinBootReap: () => process.env.COS_PIN_BOOT_REAP !== '0' })
const disk = () => JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, any>

/** The real registry, every method forwarded WITH its extras. */
function wire(r: AgentSessionBindingRegistry): BindingRegistry {
  return {
    list: () => r.list(),
    available: () => r.available(),
    create: input => r.create(input),
    activate: (id, now) => r.activate(id, now),
    forceDetach: (id, now) => r.forceDetach(id, now),
    get: id => r.get(id),
    checkQueuedPrompt: (claim, now) => r.checkQueuedPrompt(claim, now),
    pin: (id, job, now, extras) => r.pin(id, job, now, extras),
    unpin: (id, job, now, extras) => r.unpin(id, job, now, extras),
    findTurn: (id, turnId) => r.findTurn(id, turnId),
    recordTurn: (id, turnId, result, now) => r.recordTurn(id, turnId, result, now),
    orphanPinHold: (p, t, now) => r.orphanPinHold(p, t, now),
  }
}

const free: Occupancy = { attachable: true, owners: [], reason: null }
const working: Occupancy = { attachable: false, owners: [], reason: 'native_thread_working' }

function deps(r: AgentSessionBindingsDeps['bindings'], over: Partial<AgentSessionBindingsDeps> = {}): AgentSessionBindingsDeps {
  return {
    probes: {
      isAlive: () => true, processStartMs: () => NOW, fileExists: () => true, dirExists: () => true, readDir: () => [], readFile: () => '{}',
      lockHolders: () => [], cosSpawnedPids: () => new Map(), cursorAgentSession: () => null,
    },
    dirs: { claudeSessionsDir: '/x/.claude/sessions', codexLocksDir: '/x/.codex', cursorChatsDir: '/x/.cursor' },
    now: () => clock,
    bindings: r,
    attachEnabled: true,
    occupancy: () => free,
    resolveTarget: () => ({ workspaceFingerprint: 'w', sourceFingerprint: 's' }),
    nativeHead: () => 'head-1',
    deliverAttachedTurn: async () => ({ status: 'completed', nativeRevisionAfter: 'head-1' }),
    ownership: { record: () => 'recorded', release: () => true },
    newId: () => `n${++seq}`,
    ...over,
  }
}

async function start(d: AgentSessionBindingsDeps): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentSessionBindingsRouter(d))
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server!.once('listening', () => r()))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function attach(provider = 'claude', thread = SID): Promise<{ bindingId: string; epoch: number }> {
  clock += 91_000
  const a = await post(`/api/agent-sessions/${provider}/${thread}/attach`, { cosSessionId: 'cos-1' })
  expect(a.status).toBe(201)
  return { bindingId: a.body.bindingId, epoch: a.body.epoch }
}

async function turn(clientTurnId: string, prompt = 'also check the footer'): Promise<{ status: number; body: any }> {
  const a = await attach()
  return post(`/api/agent-sessions/bindings/${a.bindingId}/turns`, { clientTurnId, prompt, epoch: a.epoch, targetKey: KEY })
}

/** Wait for the background spawn to record its outcome (the attempt exit lands with the unpin). */
async function settledExit(id: string): Promise<string | undefined> {
  const until = Date.now() + 3_000
  for (;;) {
    const exit = open().attemptFor('claude', SID, id)?.attempt?.exit
    if ((exit && exit !== 'pending') || Date.now() > until) return exit
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('the attempt is on disk before any frame or spawn, and records how the turn ended', () => {
  it('spawn path: pending with the pin (and its metadata) when the adapter is entered; sent once it completed', async () => {
    const r = open()
    let seenAttempt: unknown = null, seenMeta: unknown = null
    await start(deps(wire(r), {
      deliverAttachedTurn: async req => {
        const raw = disk()
        seenAttempt = raw.attempts?.[KEY]?.['ct-spawn-0001']
        seenMeta = raw.records.find((x: any) => x.binding.bindingId === req.bindingId)?.pinMeta
        return { status: 'completed', nativeRevisionAfter: 'head-1' }
      },
    }))
    expect((await turn('ct-spawn-0001')).status).toBe(202)
    expect(await settledExit('ct-spawn-0001')).toBe('sent')
    expect(seenAttempt).toMatchObject({ bootId: 'boot-live', mode: 'turn', exit: 'pending' })
    expect(Object.values(seenMeta as Record<string, unknown>)).toEqual([{ clientTurnId: 'ct-spawn-0001', bootId: 'boot-live' }])
  })

  it('live path: pending when the frame goes out; sent on a verified delivery', async () => {
    const r = open()
    let seen: unknown = null
    await start(deps(wire(r), {
      deliverLiveTurn: async () => { seen = disk().attempts?.[KEY]?.['ct-live-00001']; return { ok: true, reason: 'delivered' } },
    }))
    expect((await turn('ct-live-00001')).status).toBe(200)
    expect(seen).toMatchObject({ exit: 'pending' })
    expect(open().attemptFor('claude', SID, 'ct-live-00001')?.attempt?.exit).toBe('sent')
  })

})

describe('every exit, one key per case', () => {
  const cases: Array<[string, Partial<AgentSessionBindingsDeps>, string]> = [
    ['unverified live frame', { deliverLiveTurn: async () => ({ ok: false, reason: 'unverified' }) }, 'unknown'],
    ['live write failure', { deliverLiveTurn: async () => ({ ok: false, reason: 'write_failed' }) }, 'unknown'],
    ['live throw then completed spawn', { deliverLiveTurn: async () => { throw new Error('bug') } }, 'sent'],
    ['no live session then a spawn that never opened', { deliverLiveTurn: async () => ({ ok: false, reason: 'no_record' }), deliverAttachedTurn: async () => ({ status: 'aborted' }) }, 'not_sent'],
    ['live throw then a spawn that never opened', { deliverLiveTurn: async () => { throw new Error('bug') }, deliverAttachedTurn: async () => ({ status: 'aborted' }) }, 'unknown'],
    ['ambiguous spawn', { deliverAttachedTurn: async () => ({ ok: false, delivery: 'ambiguous' }) }, 'unknown'],
    ['adapter throws', { deliverAttachedTurn: async () => { throw new Error('adapter') } }, 'unknown'],
  ]
  cases.forEach(([name, over, exit], i) => {
    it(`${name}: ${exit}`, async () => {
      await start(deps(wire(open()), over))
      const id = `ct-every-exit-${i}`
      await turn(id)
      expect(await settledExit(id)).toBe(exit)
    })
  })

  it('flags off: no pin metadata and no attempts in the store, ever', async () => {
    process.env.COS_QUEUE_RECONCILE = '0'
    process.env.COS_PIN_BOOT_REAP = '0'
    let raw: Record<string, any> = {}
    await start(deps(wire(open()), { deliverAttachedTurn: async () => { raw = disk(); return { status: 'completed' } } }))
    await turn('ct-flags-off-1')
    await new Promise(r => setTimeout(r, 50))
    expect(raw.attempts).toBeUndefined()
    expect(raw.records.every((x: any) => x.pinMeta === undefined)).toBe(true)
    expect(disk().attempts).toBeUndefined()
  })
})

describe('receipts: replayed, never sent again', () => {
  function receiptDeps(r: AgentSessionBindingRegistry, rows: () => QueuedThreadTurn[], over: Partial<AgentSessionBindingsDeps> = {}) {
    let deliveries = 0
    const d = deps(wire(r), {
      deliverAttachedTurn: async () => { deliveries++; return { status: 'completed' } },
      turnReceipt: makeTurnReceiptLookup({ queueRows: () => rows(), attempt: (p, t, id) => r.attemptFor(p, t, id), bootId: 'boot-live' }),
      ...over,
    })
    return { d, count: () => deliveries }
  }
  const qrow = (status: QueuedThreadTurn['status'], over: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn => ({
    clientTurnId: 'ct-receipt-row1', cosSessionId: 'cos-1', provider: 'claude', threadId: SID, prompt: 'p', queuedAt: NOW, status, attempts: 1, ...over,
  })

  it('an attempt that may have been sent is replayed as the ambiguous outcome', async () => {
    const r = open()
    r.beginAttempt('claude', SID, 'ct-receipt-unk1', 'turn', NOW)
    r.settleAttempt('claude', SID, 'ct-receipt-unk1', 'unknown', NOW)
    const { d, count } = receiptDeps(r, () => [])
    await start(d)
    const res = await turn('ct-receipt-unk1')
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ outcome: 'ambiguous', deliveryState: 'unknown', retryable: false, reason: 'delivery_ambiguous', replayed: true, receipt: 'attempt' })
    expect(count()).toBe(0)
  })

  it("a dead boot's pending attempt is unknown; this boot's own pending is left to the claim", async () => {
    const dead = open('boot-dead')
    dead.beginAttempt('claude', SID, 'ct-receipt-dead', 'turn', NOW)
    const r = open()
    const { d, count } = receiptDeps(r, () => [])
    await start(d)
    expect((await turn('ct-receipt-dead')).body).toMatchObject({ outcome: 'ambiguous', receipt: 'attempt' })
    r.beginAttempt('claude', SID, 'ct-receipt-mine', 'turn', NOW)
    expect((await turn('ct-receipt-mine')).status).toBe(202)
    expect(count()).toBe(1)
  })

  it('a delivered queue row replays completed; a refused unknown row replays ambiguous', async () => {
    const r = open()
    let rows: QueuedThreadTurn[] = [qrow('delivered', { clientTurnId: 'ct-receipt-del1' })]
    const { d, count } = receiptDeps(r, () => rows)
    await start(d)
    expect(await turn('ct-receipt-del1')).toMatchObject({ status: 200, body: { outcome: 'completed', replayed: true, receipt: 'queue' } })
    rows = [qrow('refused', { clientTurnId: 'ct-receipt-unk2', deliveryState: 'unknown' })]
    expect(await turn('ct-receipt-unk2')).toMatchObject({ status: 409, body: { outcome: 'ambiguous', receipt: 'queue' } })
    expect(count()).toBe(0)
  })

  it('a WAITING or DELIVERING row (the drainer posting its own key) is not a receipt: it is delivered', async () => {
    const r = open()
    let rows: QueuedThreadTurn[] = [qrow('delivering', { clientTurnId: 'ct-receipt-own1', journal: 1 })]
    const { d, count } = receiptDeps(r, () => rows)
    await start(d)
    expect((await turn('ct-receipt-own1')).status).toBe(202)
    rows = [qrow('waiting', { clientTurnId: 'ct-receipt-own2' })]
    expect((await turn('ct-receipt-own2')).status).toBe(202)
    expect(count()).toBe(2)
  })

  it('a receipt lookup that throws fails closed (unknown), and COS_QUEUE_RECONCILE off ignores receipts', async () => {
    const r = open()
    const { d, count } = receiptDeps(r, () => [], { turnReceipt: () => { throw new Error('journal') } })
    await start(d)
    expect((await turn('ct-receipt-thr1')).body).toMatchObject({ outcome: 'ambiguous', replayed: true })
    expect(count()).toBe(0)
    process.env.COS_QUEUE_RECONCILE = '0'
    expect((await turn('ct-receipt-off1')).status).toBe(202)
    expect(count()).toBe(1)
  })
})

describe('the attach refusal: `steer` (COS_SESSION_STEER) and the dead-boot copy', () => {
  const steer = (provider: string, _t: string, gateReason: string): ReturnType<typeof sessionSteerAvailability> =>
    sessionSteerAvailability({ provider, gateReason, continueLive: true, peerInbox: true, waitingOnPrompt: false })

  it('flag on: claude peer_inbox, codex no_outside_channel (the contract bodies)', async () => {
    process.env.COS_SESSION_STEER = '1'
    await start(deps(wire(open()), { occupancy: () => working, sessionSteer: steer }))
    const claude = await post(`/api/agent-sessions/claude/${SID}/attach`, { cosSessionId: 'cos-1' })
    expect(claude.status).toBe(409)
    expect(claude.body).toEqual(CONTRACT.attach_refusal)
    const codex = await post(`/api/agent-sessions/codex/${CODEX}/attach`, { cosSessionId: 'cos-1' })
    expect(codex.body).toEqual(CONTRACT.attach_refusal_codex)
  })

  it('flag off: no `steer` key at all, whatever is wired (the contract flag-off body)', async () => {
    await start(deps(wire(open()), { occupancy: () => working, sessionSteer: steer }))
    const res = await post(`/api/agent-sessions/claude/${SID}/attach`, { cosSessionId: 'cos-1' })
    expect(res.body).toEqual(CONTRACT.attach_refusal_flag_off)
    expect(res.body.reasonCopy).toBe(REASON_COPY.native_thread_working)
  })

  it("a dead boot's pin: native_target_busy, 'frees h:mm', until 21 minutes after it was taken", async () => {
    const dead = open('boot-dead')
    const created = dead.create({ bindingId: 'bnd-dead', cosSessionId: 'cos-1', provider: 'claude', nativeThreadId: SID, workspaceFingerprint: 'w', sourceFingerprint: 's', ttlMs: 60_000, now: NOW })
    expect(created.reason).toBeNull()
    dead.activate('bnd-dead', NOW)
    dead.pin('bnd-dead', 'job-dead', NOW, { pinMeta: { clientTurnId: 'ct-dead-turn1' } })
    let now = NOW + 60_000
    await start(deps(wire(open()), { now: () => now }))
    const held = await post(`/api/agent-sessions/claude/${SID}/attach`, { cosSessionId: 'cos-1' })
    expect(held.status).toBe(409)
    expect(held.body).toEqual({ attached: false, reason: 'native_target_busy', reasonCopy: orphanPinWaitCopy(NOW + QUERY_JOB_ORPHAN_FENCE_MS) })
    expect(held.body.reasonCopy).toMatch(/^An earlier run may still be running · frees \d{1,2}:\d{2}$/)
    expect(held.body.reasonCopy.length).toBeLessThanOrEqual(62)
    now = NOW + QUERY_JOB_ORPHAN_FENCE_MS
    expect((await post(`/api/agent-sessions/claude/${SID}/attach`, { cosSessionId: 'cos-1' })).status).toBe(201)
  })

  it('orphanPinWaitCopy rounds UP to the minute, on a 12-hour clock', () => {
    const at = new Date(2026, 9, 18, 19, 51, 1).getTime()
    expect(orphanPinWaitCopy(at)).toBe('An earlier run may still be running · frees 7:52')
    expect(orphanPinWaitCopy(new Date(2026, 9, 18, 0, 5, 0).getTime())).toBe('An earlier run may still be running · frees 12:05')
  })
})

