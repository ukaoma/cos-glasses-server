// 6.51.0: a queued Cursor turn leaves through the composer's own Stop hook.
// The pure rules, then the route against a real express server and real queue files.
import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from 'vitest'

// Hoisted for the same reason as thread-turn-queue.test.ts: the store's data dir is read
// at import time.
vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  process.env.COS_DATA_DIR = mkdtempSync(join(tmpdir(), 'cos-cursor-stop-'))
})
import express from 'express'
import type { Server } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimNextCursorTurn, cursorStopAcceptsFollowup, cursorStopIsFresh, parseCursorStopEnvelope } from '../lib/cursor-stop-followup.js'
import { CURSOR_STOP_FOLLOWUP_PATH, createCursorStopFollowupRouter } from './cursor-stop-followup.js'
import { readQueue, writeQueue } from '../lib/thread-turn-queue-store.js'
import type { QueuedThreadTurn } from '../lib/thread-turn-queue.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})
// The data home `vi.hoisted` made above, before any const here existed.
if (process.env.COS_DATA_DIR) trackedTemp(process.env.COS_DATA_DIR)

const CONV = 'd1728e99-1007-4957-b36b-34df7d525e14'
// The route's clock reads 9_000; a hook that started half a second earlier is fresh.
const envelope = (payload: Record<string, unknown> = {}, event = 'Stop', ts: unknown = 8_500) => ({
  ts, ppid: 2, event,
  payload: { conversation_id: CONV, session_id: CONV, hook_event_name: 'stop', status: 'completed', loop_count: 0, cursor_version: '3.21.13', ...payload },
})
const turn = (id: string, over: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn => ({
  clientTurnId: id, cosSessionId: 'cos-1', provider: 'cursor', threadId: CONV, prompt: `prompt ${id}`,
  queuedAt: 1_000, status: 'waiting', attempts: 0, ...over,
})

describe('parseCursorStopEnvelope', () => {
  it('reads a Cursor Stop', () => {
    expect(parseCursorStopEnvelope(envelope())).toEqual({ conversationId: CONV, status: 'completed', loopCount: 0, cursorVersion: '3.21.13', hookStartedAtMs: 8_500 })
  })
  it('a missing or non-numeric stamp reads null, never a number', () => {
    for (const ts of [null, '8500', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseCursorStopEnvelope(envelope({}, 'Stop', ts))?.hookStartedAtMs).toBeNull()
    }
    // (An undefined argument would take the fresh default; drop the key instead.)
    const { ts: _dropped, ...unstamped } = envelope()
    expect(parseCursorStopEnvelope(unstamped)?.hookStartedAtMs).toBeNull()
  })
  it('falls back to session_id, and lowercases the id', () => {
    expect(parseCursorStopEnvelope(envelope({ conversation_id: undefined, session_id: CONV.toUpperCase() }))?.conversationId).toBe(CONV)
  })
  it('refuses anything that is not positively a Cursor Stop naming a valid conversation', () => {
    expect(parseCursorStopEnvelope(envelope({ cursor_version: undefined }))).toBeNull() // a Claude Stop
    expect(parseCursorStopEnvelope(envelope({ cursor_version: '  ' }))).toBeNull()
    expect(parseCursorStopEnvelope(envelope({}, 'PostToolUse'))).toBeNull()
    expect(parseCursorStopEnvelope(envelope({ conversation_id: '../x', session_id: '../x' }))).toBeNull()
    for (const bad of [null, undefined, 'x', [], { event: 'Stop' }, { event: 'Stop', payload: [] }]) {
      expect(parseCursorStopEnvelope(bad)).toBeNull()
    }
  })
})

describe('cursorStopIsFresh', () => {
  it('only within 2 s of the hook starting, and never from a clock that ran ahead', () => {
    expect(cursorStopIsFresh(10_000, 10_000)).toBe(true)
    expect(cursorStopIsFresh(10_000, 12_000)).toBe(true)
    expect(cursorStopIsFresh(10_000, 12_001)).toBe(false)
    expect(cursorStopIsFresh(10_000, 5_000)).toBe(true)
    expect(cursorStopIsFresh(10_000, 4_999)).toBe(false)
    expect(cursorStopIsFresh(null, 10_000)).toBe(false)
    expect(cursorStopIsFresh(Number.NaN, 10_000)).toBe(false)
    expect(cursorStopIsFresh(10_000, Number.NaN)).toBe(false)
  })
})

describe('cursorStopAcceptsFollowup', () => {
  const facts = (over: Record<string, unknown> = {}) => ({ conversationId: CONV, status: 'completed', loopCount: 0, cursorVersion: '3', hookStartedAtMs: 1, ...over })
  it('only a completed turn, under the loop cap', () => {
    expect(cursorStopAcceptsFollowup(facts(), 8)).toBe(true)
    expect(cursorStopAcceptsFollowup(facts({ loopCount: null }), 8)).toBe(true)
    expect(cursorStopAcceptsFollowup(facts({ status: 'aborted' }), 8)).toBe(false)
    expect(cursorStopAcceptsFollowup(facts({ status: 'error' }), 8)).toBe(false)
    expect(cursorStopAcceptsFollowup(facts({ status: '' }), 8)).toBe(false)
    expect(cursorStopAcceptsFollowup(facts({ loopCount: 8 }), 8)).toBe(false)
  })
})

describe('claimNextCursorTurn', () => {
  it('claims the oldest waiting turn, marks it delivered, and leaves the rest', () => {
    const queue = [turn('a', { status: 'cancelled' }), turn('b'), turn('c')]
    const claimed = claimNextCursorTurn(queue, 5_000)!
    expect(claimed.turn).toMatchObject({ clientTurnId: 'b', status: 'delivered', attempts: 1, reason: 'cursor_stop_hook', settledAt: 5_000 })
    expect(claimed.queue.map(t => `${t.clientTurnId}:${t.status}`)).toEqual(['a:cancelled', 'b:delivered', 'c:waiting'])
    expect(queue[1]!.status).toBe('waiting') // pure: the input is untouched
  })
  it('nothing waiting is nothing claimed', () => {
    expect(claimNextCursorTurn([turn('a', { status: 'delivered' })], 1)).toBeNull()
    expect(claimNextCursorTurn([], 1)).toBeNull()
  })
})

describe(`POST ${CURSOR_STOP_FOLLOWUP_PATH}`, () => {
  let server: Server | null = null
  let base = ''
  let token: string | null = 'hook-tok'
  const writes: Array<{ threadId: string; statuses: string[] }> = []

  beforeEach(async () => {
    token = 'hook-tok'
    writes.length = 0
    writeQueue('cursor', CONV, [])
    const app = express()
    app.use(createCursorStopFollowupRouter({
      hookToken: () => token,
      readQueue,
      writeQueue: (provider, threadId, queue) => { writes.push({ threadId, statuses: queue.map(t => t.status) }); writeQueue(provider, threadId, queue) },
      now: () => 9_000,
    }))
    await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
    const addr = server!.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterEach(() => { server?.close(); server = null })

  const post = async (body: unknown, headers: Record<string, string> = { 'x-cos-hook-token': 'hook-tok' }) => {
    const res = await fetch(`${base}${CURSOR_STOP_FOLLOWUP_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  it('hands over queued turns one Stop at a time, oldest first, writing the claim first', async () => {
    writeQueue('cursor', CONV, [turn('one'), turn('two')])
    expect(await post(envelope())).toEqual({ status: 200, body: { followup_message: 'prompt one' } })
    expect(await post(envelope({ loop_count: 1 }))).toEqual({ status: 200, body: { followup_message: 'prompt two' } })
    expect(await post(envelope({ loop_count: 2 }))).toEqual({ status: 200, body: {} })
    expect(readQueue('cursor', CONV, 9_000).map(t => t.status)).toEqual(['delivered', 'delivered'])
    expect(writes.map(w => w.statuses)).toEqual([['delivered', 'waiting'], ['delivered', 'delivered']])
  })

  it('an aborted or failed turn gets nothing, and nothing is written', async () => {
    writeQueue('cursor', CONV, [turn('one')])
    expect((await post(envelope({ status: 'aborted' }))).body).toEqual({})
    expect((await post(envelope({ status: 'error' }))).body).toEqual({})
    expect(writes).toEqual([])
    expect(readQueue('cursor', CONV, 9_000)[0]!.status).toBe('waiting')
  })

  it('a Claude Stop, or anything that is not a Cursor Stop, is answered {} and touches nothing', async () => {
    writeQueue('cursor', CONV, [turn('one')])
    expect((await post(envelope({ cursor_version: undefined }))).body).toEqual({})
    expect((await post({ hello: 'world' })).body).toEqual({})
    expect(writes).toEqual([])
  })

  it('refuses without the hook token, with a wrong one, and when none is minted', async () => {
    writeQueue('cursor', CONV, [turn('one')])
    expect((await post(envelope(), {})).status).toBe(401)
    expect((await post(envelope(), { 'x-cos-hook-token': 'nope' })).status).toBe(401)
    expect((await post(envelope(), { 'x-cos-token': 'hook-tok' })).status).toBe(401)
    token = null
    expect((await post(envelope())).status).toBe(401)
    expect(writes).toEqual([])
    expect(readQueue('cursor', CONV, 9_000)[0]!.status).toBe('waiting')
  })

  it('6.52.0: checks the hook token BEFORE the body is parsed (the route now sits ahead of the global parser)', async () => {
    writeQueue('cursor', CONV, [turn('one')])
    const raw = (headers: Record<string, string>, body: string) => fetch(`${base}${CURSOR_STOP_FOLLOWUP_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    // Not JSON, and over the route's own 2 MB limit: without the token the answer is 401,
    // which a parser that ran first could never have produced.
    for (const body of ['{not json', `{"pad":"${'x'.repeat(2_200_000)}"}`]) {
      expect((await raw({}, body)).status).toBe(401)
      expect((await raw({ 'x-cos-hook-token': 'nope' }, body)).status).toBe(401)
    }
    // With the token the parser runs, and refuses.
    expect((await raw({ 'x-cos-hook-token': 'hook-tok' }, '{not json')).status).toBe(400)
    expect((await raw({ 'x-cos-hook-token': 'hook-tok' }, `{"pad":"${'x'.repeat(2_200_000)}"}`)).status).toBe(413)
    expect(writes).toEqual([])
    expect(readQueue('cursor', CONV, 9_000)[0]!.status).toBe('waiting')
  })

  it('never claims for a hook that already hung up (the reply would go nowhere)', () => {
    writeQueue('cursor', CONV, [turn('one')])
    const router = createCursorStopFollowupRouter({ hookToken: () => 'hook-tok', readQueue, writeQueue: () => { throw new Error('must not write') }, now: () => 9_000 })
    const layer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> }).stack
      .find(l => l.route?.path === CURSOR_STOP_FOLLOWUP_PATH)!
    const handler = layer.route!.stack[layer.route!.stack.length - 1]!.handle
    let replied: unknown = 'nothing'
    const res = { set: () => res, status: () => res, json: (b: unknown) => { replied = b; return res }, writableEnded: false }
    handler({ headers: { 'x-cos-hook-token': 'hook-tok' }, body: envelope(), socket: { destroyed: true } }, res)
    expect(replied).toBe('nothing')
    expect(readQueue('cursor', CONV, 9_000)[0]!.status).toBe('waiting')
  })

  it('a Stop more than 2 s old, or unstamped, claims nothing and leaves the turn waiting', async () => {
    writeQueue('cursor', CONV, [turn('one')])
    expect(await post(envelope({}, 'Stop', 6_999))).toEqual({ status: 200, body: {} })
    const { ts: _dropped, ...unstamped } = envelope()
    expect(await post(unstamped)).toEqual({ status: 200, body: {} })
    expect(await post(envelope({}, 'Stop', null))).toEqual({ status: 200, body: {} })
    expect(await post(envelope({}, 'Stop', 15_000))).toEqual({ status: 200, body: {} })
    expect(writes).toEqual([])
    expect(readQueue('cursor', CONV, 9_000)[0]!.status).toBe('waiting')
    // The boundary itself still claims.
    expect(await post(envelope({}, 'Stop', 7_000))).toEqual({ status: 200, body: { followup_message: 'prompt one' } })
  })

  it('a Stop that reaches a blocked server after the hook gave up is never claimed (real curl, QA B2)', async () => {
    const started = Date.now()
    writeQueue('cursor', CONV, [turn('one', { queuedAt: started })])
    const app = express()
    app.use(createCursorStopFollowupRouter({ hookToken: () => 'hook-tok', readQueue, writeQueue, now: () => Date.now() }))
    const live = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    try {
      const addr = live.address()
      const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}${CURSOR_STOP_FOLLOWUP_PATH}`
      const file = join(trackedTemp(mkdtempSync(join(tmpdir(), 'cos-cursor-b2-'))), 'envelope.json')
      writeFileSync(file, JSON.stringify(envelope({}, 'Stop', started)))
      // The hook's own curl, with a 1 s wait standing in for its 3 s.
      const curl = spawn('/usr/bin/curl', ['-s', '--connect-timeout', '1', '--max-time', '1',
        '-H', 'X-Cos-Hook-Token: hook-tok', '-H', 'content-type: application/json', '--data-binary', `@${file}`, url])
      let out = ''
      curl.stdout.on('data', c => { out += c })
      const exited = new Promise<number | null>(r => curl.on('close', r))
      // A busy server: nothing runs on this loop until well after curl has given up.
      const until = Date.now() + 2_600
      while (Date.now() < until) { /* blocked */ }
      expect(await exited).not.toBe(0)
      await new Promise(r => setTimeout(r, 400))
      expect(out).toBe('')
      expect(readQueue('cursor', CONV, Date.now())[0]!.status).toBe('waiting')
    } finally {
      live.close()
    }
  }, 15_000)

  it('only ever reads the cursor queue: a Claude queue under the same id is never handed over', async () => {
    writeQueue('claude', CONV, [turn('claude-one', { provider: 'claude' })])
    expect((await post(envelope())).body).toEqual({})
    expect(readQueue('claude', CONV, 9_000)[0]!.status).toBe('waiting')
  })
})
