// The queue routes and the drainer, against a real express server and real files.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

// HOISTED, and it has to be. `DATA_DIR` in lib/data-dir.ts is a module-level const
// evaluated at IMPORT time, so setting COS_DATA_DIR in beforeEach is a no-op: every
// test in the file would share whichever directory happened to be set when the store
// was first imported. The first version of this file did exactly that and a cancelled
// row from one test showed up inside another. Isolation is then per-THREAD-ID below,
// which is also closer to production, where many threads share one queue directory.
const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-tq-routes-'))
  process.env.COS_DATA_DIR = dir
  return { dir }
})
import express from 'express'
import { rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { createThreadTurnQueueRouter, drainThread, type ThreadTurnQueueDeps } from './thread-turn-queue.js'
import { readQueue, writeQueue } from '../lib/thread-turn-queue-store.js'
import type { QueuedThreadTurn } from '../lib/thread-turn-queue.js'

let server: Server | null = null
/** Unique per test, so two tests cannot see each other's queue file. */
let threadId = ''
let seq = 0
let baseUrl = ''
let clock = 10_000
let gate = { attachable: false, reason: 'native_thread_working' as string | null }
let ended = false
let activity: 'working' | 'idle' | 'unknown' = 'working'
let delivered: string[] = []
let deliverResult: { ok: boolean; reason?: string } = { ok: true }

function deps(): ThreadTurnQueueDeps {
  return {
    occupancy: () => gate,
    turnEnded: () => ended,
    activity: () => activity,
    deliver: async (t: QueuedThreadTurn) => { delivered.push(t.clientTurnId); return deliverResult },
    now: () => clock,
  }
}

async function start(): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use('/api', createThreadTurnQueueRouter(deps()))
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server!.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise(resolve => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, res => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw || '{}') }) } catch { resolve({ status: res.statusCode ?? 0, json: {} }) } })
    })
    if (data) req.write(data)
    req.end()
  })
}

let POST = ''

beforeEach(() => {
  threadId = `thr-${++seq}`
  POST = `/api/agent-sessions/claude/${threadId}/queued-turns`
  clock = 10_000
  gate = { attachable: false, reason: 'native_thread_working' }
  ended = false; activity = 'working'; delivered = []; deliverResult = { ok: true }
})
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
})
afterAll(() => { rmSync(FIXTURE.dir, { recursive: true, force: true }) })

describe('parking a turn at a busy thread', () => {
  it('accepts it with 202 and a queue position', async () => {
    // The behaviour Miles asked for: "if there's a session that's still running, that
    // would just put it into the queue the same way that the user has the ability to do".
    await start()
    const res = await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'ship it' })
    expect(res.status).toBe(202)
    expect(res.json).toMatchObject({ queued: true, clientTurnId: 'ct-1', position: 0, waitingOn: 'native_thread_working' })
  })

  it('tells the client to send NOW when the thread is actually free', async () => {
    // Queueing a free thread would add a pointless round trip and a wrong pending row.
    gate = { attachable: true, reason: null }
    await start()
    const res = await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'ship it' })
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ error: 'thread_free', hint: 'send_now' })
  })

  it('refuses outright for a reason that can never clear', async () => {
    // Queueing against a structural refusal would be a lie told politely.
    gate = { attachable: false, reason: 'unsupported_provider' }
    await start()
    const res = await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'x' })
    expect(res.status).toBe(423)
    expect(res.json).toMatchObject({ error: 'unsupported_provider', queueable: false })
  })

  it('refuses cursor even when occupancy would otherwise look busy', async () => {
    await start()
    const res = await http('POST', `/api/agent-sessions/cursor/${threadId}/queued-turns`, {
      clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'x',
    })
    expect(res.status).toBe(423)
    expect(res.json).toMatchObject({ error: 'unsupported_provider', queueable: false })
  })

  it('rejects a duplicate id, so a retried request cannot double-post', async () => {
    await start()
    await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'ship it' })
    const again = await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'ship it' })
    expect(again.status).toBe(409)
    expect(again.json.error).toBe('duplicate_turn')
  })

  it('survives a restart, because the phone is pocketed exactly when this matters', async () => {
    await start()
    await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'ship it' })
    // Read back through the STORE, not the router's memory: nothing is held in RAM.
    expect(readQueue('claude', threadId, clock).map(t => t.clientTurnId)).toEqual(['ct-1'])
  })
})

describe('listing and cancelling', () => {
  it('lists what is waiting with a preview and a position', async () => {
    await start()
    await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'ship it' })
    const res = await http('GET', POST)
    expect(res.json.turns[0]).toMatchObject({ clientTurnId: 'ct-1', status: 'waiting', position: 0, preview: 'ship it' })
  })

  it('cancels a waiting turn — the × control on the desktop queue', async () => {
    await start()
    await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'ship it' })
    const res = await http('DELETE', `${POST}/ct-1`)
    expect(res.status).toBe(200)
    expect(readQueue('claude', threadId, clock)[0].status).toBe('cancelled')
  })

  it('refuses to cancel one already handed to the adapter', async () => {
    // It cannot be recalled, and saying otherwise is the one lie this feature must not
    // tell. The row is put into `delivering` DIRECTLY rather than by racing a hanging
    // deliver — a sleep-and-hope test would be flaky and would leave a dangling promise.
    await start()
    await http('POST', POST, { clientTurnId: 'ct-1', cosSessionId: 'cos-1', prompt: 'ship it' })
    const q = readQueue('claude', threadId, clock)
    q[0].status = 'delivering'
    writeQueue('claude', threadId, q)

    const res = await http('DELETE', `${POST}/ct-1`)
    expect(res.status).toBe(409)
    expect(res.json.error).toBe('already_delivering')
    expect(readQueue('claude', threadId, clock)[0].status).toBe('delivering')
  })

  it('404s an unknown turn rather than inventing one', async () => {
    await start()
    expect((await http('DELETE', `${POST}/nope`)).status).toBe(404)
  })
})

describe('the drainer', () => {
  const park = async (id: string) => http('POST', POST, { clientTurnId: id, cosSessionId: 'cos-1', prompt: `p-${id}` })

  it('delivers nothing while the gate refuses, however long it waits', async () => {
    await start(); await park('ct-1')
    clock += 60_000
    const out = await drainThread('claude', threadId, deps())
    expect(out.delivered).toBe(0)
    expect(delivered).toEqual([])
    expect(readQueue('claude', threadId, clock)[0].status).toBe('waiting')
  })

  it('delivers once the turn ends and the gate opens', async () => {
    await start(); await park('ct-1')
    gate = { attachable: true, reason: null }; ended = true
    const out = await drainThread('claude', threadId, deps())
    expect(out.delivered).toBe(1)
    expect(delivered).toEqual(['ct-1'])
    expect(readQueue('claude', threadId, clock)[0].status).toBe('delivered')
  })

  it('records the attempt BEFORE calling deliver, so a crash cannot retry forever', async () => {
    // The ceiling only bounds anything if it survives the crash it is bounding.
    await start(); await park('ct-1')
    gate = { attachable: true, reason: null }; ended = true
    let seenAttempts = -1
    await drainThread('claude', threadId, {
      ...deps(),
      deliver: async () => {
        seenAttempts = readQueue('claude', threadId, clock)[0].attempts
        throw new Error('process died')
      },
    })
    expect(seenAttempts).toBe(1)
  })

  it('returns a failed turn to waiting rather than burning it', async () => {
    await start(); await park('ct-1')
    gate = { attachable: true, reason: null }; ended = true
    deliverResult = { ok: false, reason: 'transient' }
    await drainThread('claude', threadId, deps())
    const row = readQueue('claude', threadId, clock)[0]
    expect(row.status).toBe('waiting')
    expect(row.attempts).toBe(1)
  })

  it('gives up after the attempt ceiling instead of writing in a loop', async () => {
    await start(); await park('ct-1')
    gate = { attachable: true, reason: null }; ended = true
    deliverResult = { ok: false, reason: 'nope' }
    for (let i = 0; i < 8; i++) await drainThread('claude', threadId, deps())
    const row = readQueue('claude', threadId, clock)[0]
    expect(row.status).toBe('refused')
    expect(row.attempts).toBeLessThanOrEqual(5)
  })

  it('re-observes between turns, because delivering one makes the thread busy again', async () => {
    await start(); await park('ct-1'); await park('ct-2')
    gate = { attachable: true, reason: null }; ended = true
    let call = 0
    await drainThread('claude', threadId, {
      ...deps(),
      // The thread goes busy the moment the first turn lands.
      occupancy: () => (call++ === 0 ? { attachable: true, reason: null } : { attachable: false, reason: 'native_thread_working' }),
    })
    expect(delivered).toEqual(['ct-1'])
    expect(readQueue('claude', threadId, clock).find(t => t.clientTurnId === 'ct-2')!.status).toBe('waiting')
  })
})

describe('a gate refusal does not spend the delivery ceiling', () => {
  // THE SCENARIO NOTHING EXERCISED. Occupancy says attachable, the drainer attempts,
  // and the attach ROUTE refuses on checks occupancy does not run. Measured in the
  // field: three of Miles's turns retired with attempts=5 / attach_409 in ~2 minutes,
  // never delivered, while the 6h TTL never got to matter.
  const park = async (id: string) =>
    http('POST', POST, { clientTurnId: id, cosSessionId: 'cos-1', prompt: `p-${id}` })

  const drainWith = async (result: { ok: boolean; reason?: string; serverRetryable?: boolean }) => {
    gate = { attachable: true, reason: null }; ended = true
    deliverResult = result
    await drainThread('claude', threadId, deps())
    return readQueue('claude', threadId, clock)[0]
  }

  it('REFUNDS the attempt for a queueable reason and stays waiting', async () => {
    await start(); await park('ct-1')
    const row = await drainWith({ ok: false, reason: 'native_target_busy' })
    expect(row.status).toBe('waiting')
    expect(row.attempts).toBe(0)
    expect(row.reason).toBe('native_target_busy')
  })

  it('SPENDS the attempt for a refusal that can never clear', async () => {
    // `native_target_fenced` means an earlier turn may or may not have landed. Waiting
    // cannot resolve that, and retrying it risks a second copy in a real conversation.
    await start(); await park('ct-1')
    const row = await drainWith({ ok: false, reason: 'native_target_fenced' })
    expect(row.status).toBe('waiting')
    expect(row.attempts).toBe(1)
  })

  it("obeys the turn route's own retryable verdict over our inference", async () => {
    await start(); await park('ct-1')
    // Queueable by reason, but the server says no. The server wins.
    const row = await drainWith({ ok: false, reason: 'native_target_busy', serverRetryable: false })
    expect(row.attempts).toBe(1)
  })

  it('FAILS CLOSED on an unrecognised reason', async () => {
    // A refusal added upstream must be bounded by default, never retried forever.
    await start(); await park('ct-1')
    expect((await drainWith({ ok: false, reason: 'brand_new_refusal' })).attempts).toBe(1)
  })

  it('FAILS CLOSED when there is no reason at all', async () => {
    // Split from the case above: my first version parked a SECOND turn into the same
    // queue and then read row [0], which had already been drained once — so it read 2
    // and looked like a defect in the code rather than in the fixture.
    await start(); await park('ct-1')
    expect((await drainWith({ ok: false })).attempts).toBe(1)
  })

  it('never survives forever: the ceiling still retires a genuinely failing turn', async () => {
    await start(); await park('ct-1')
    gate = { attachable: true, reason: null }; ended = true
    deliverResult = { ok: false, reason: 'attach_failed' }
    for (let i = 0; i < 8; i++) await drainThread('claude', threadId, deps())
    const row = readQueue('claude', threadId, clock)[0]
    expect(row.status).toBe('refused')
    expect(row.attempts).toBeLessThanOrEqual(5)
  })

  it('keeps the crash-safety property: the attempt is on disk BEFORE the call', async () => {
    // The refund happens after the outcome is known; a crash mid-delivery therefore
    // still leaves the attempt counted, which is what bounds an unbounded retry.
    await start(); await park('ct-1')
    gate = { attachable: true, reason: null }; ended = true
    let onDisk = -1
    await drainThread('claude', threadId, {
      ...deps(),
      deliver: async () => {
        onDisk = readQueue('claude', threadId, clock)[0].attempts
        throw new Error('process died')
      },
    })
    expect(onDisk).toBe(1)
  })
})
