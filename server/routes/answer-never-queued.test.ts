// X1 (7.0.38): an answer is never queued. A turn-end answer parked behind a busy session lands after that turn,
// whatever the session asks by then, and the drain carries no ask id, so the turns route's ask check never sees it
// (CONFIRM_named_answer_7037.md, path A; Miles's own second tap at 07:01 on 11/14 would have been delivered twice).
// The queue's doors refuse the answer's words, and the drain settles a row queued before the guard, never delivering it.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-answer-never-queued-'))
  process.env.COS_DATA_DIR = dir
  return { dir }
})
import express from 'express'
import { rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { createThreadTurnQueueRouter, drainThread, type ThreadTurnQueueDeps } from './thread-turn-queue.js'
import { readQueue, writeQueue } from '../lib/thread-turn-queue-store.js'
import {
  QUEUED_TURN_REASON_COPY_MAX, TURN_END_ANSWER_NOT_QUEUED, TURN_END_ANSWER_NOT_QUEUED_COPY, queuedTurnReasonCopy,
  type QueuedThreadTurn,
} from '../lib/thread-turn-queue.js'

const WEB = 'Answer sent from COS Control Web through COS, not typed in this session: Approved'
const MAC = 'Answer sent from COS Control on the Mac through COS, not typed in this session: Commands run, go'
const QUOTED = 'He wrote "Answer sent from COS Control Web through COS, not typed in this session: Approved" earlier. Keep going.'

let server: Server | null = null
let threadId = ''
let seq = 0
let baseUrl = ''
let clock = 10_000
let gate = { attachable: false, reason: 'native_thread_working' as string | null }
let ended = false
let activity: 'working' | 'idle' | 'unknown' = 'working'
let delivered: string[] = []

function deps(): ThreadTurnQueueDeps {
  return {
    occupancy: () => gate,
    turnEnded: () => ended,
    activity: () => activity,
    deliver: async (t: QueuedThreadTurn) => { delivered.push(t.clientTurnId); return { ok: true } },
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
const row = (clientTurnId: string, prompt: string, extra: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn => ({
  clientTurnId, cosSessionId: 'cos-1', provider: 'claude', threadId, prompt, queuedAt: clock, status: 'waiting', attempts: 0, ...extra,
})

beforeEach(() => {
  threadId = `thr-anq-${++seq}`
  POST = `/api/agent-sessions/claude/${threadId}/queued-turns`
  clock = 10_000
  gate = { attachable: false, reason: 'native_thread_working' }
  ended = false; activity = 'working'; delivered = []
})
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
})
afterAll(() => { rmSync(FIXTURE.dir, { recursive: true, force: true }) })

describe('X1 7.0.38: an answer is never queued', () => {
  it('the door: a turn-end answer behind a busy session is refused with its own reason and plain words, and nothing is queued', async () => {
    await start()
    for (const [id, prompt] of [['ct-anq-web-0001', WEB], ['ct-anq-mac-0001', MAC]] as const) {
      const res = await http('POST', POST, { clientTurnId: id, cosSessionId: 'cos-1', prompt })
      expect(res.status).toBe(409)
      expect(res.json).toEqual({ error: TURN_END_ANSWER_NOT_QUEUED, reasonCopy: 'Not sent. The session is working.' })
    }
    expect(readQueue('claude', threadId, clock)).toEqual([])
  })

  it('the door: another COS turn holding the thread (native_target_busy) refuses it the same way', async () => {
    await start()
    gate = { attachable: false, reason: 'native_target_busy' }
    const res = await http('POST', POST, { clientTurnId: 'ct-anq-busy-0001', cosSessionId: 'cos-1', prompt: WEB })
    expect(res.json.error).toBe(TURN_END_ANSWER_NOT_QUEUED)
    expect(readQueue('claude', threadId, clock)).toEqual([])
  })

  it('a free thread still answers thread_free, so the answer is sent now through the turns route and its ask check', async () => {
    await start()
    gate = { attachable: true, reason: null }
    const res = await http('POST', POST, { clientTurnId: 'ct-anq-free-0001', cosSessionId: 'cos-1', prompt: WEB })
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ error: 'thread_free', hint: 'send_now' })
  })

  it('a typed message is queued exactly as before, including one quoting the answer words mid-text', async () => {
    await start()
    const plain = await http('POST', POST, { clientTurnId: 'ct-anq-typed-0001', cosSessionId: 'cos-1', prompt: 'Run the readiness check next.' })
    const quoted = await http('POST', POST, { clientTurnId: 'ct-anq-typed-0002', cosSessionId: 'cos-1', prompt: QUOTED })
    expect(plain.status).toBe(202)
    expect(quoted.status).toBe(202)
    expect(readQueue('claude', threadId, clock).map(t => t.clientTurnId)).toEqual(['ct-anq-typed-0001', 'ct-anq-typed-0002'])
  })

  it('Send again never copies an answer into a new waiting row', async () => {
    await start()
    writeQueue('claude', threadId, [row('ct-anq-old-0001', WEB, { status: 'refused', reason: 'delivery_attempts_exhausted', settledAt: clock })])
    const res = await http('POST', `${POST}/ct-anq-old-0001/resend`, { clientTurnId: 'ct-anq-old-0002', cosSessionId: 'cos-1' })
    expect(res.status).toBe(409)
    expect(res.json).toEqual({ error: TURN_END_ANSWER_NOT_QUEUED, reasonCopy: TURN_END_ANSWER_NOT_QUEUED_COPY })
    expect(readQueue('claude', threadId, clock).map(t => t.clientTurnId)).toEqual(['ct-anq-old-0001'])
  })

  it('an edit cannot turn a waiting row into an answer', async () => {
    await start()
    await http('POST', POST, { clientTurnId: 'ct-anq-edit-0001', cosSessionId: 'cos-1', prompt: 'first words' })
    const res = await http('PATCH', `${POST}/ct-anq-edit-0001`, { prompt: WEB })
    expect(res.status).toBe(409)
    expect(res.json.error).toBe(TURN_END_ANSWER_NOT_QUEUED)
    expect(readQueue('claude', threadId, clock)[0]).toMatchObject({ prompt: 'first words', status: 'waiting' })
  })

  it('the drain: an answer queued before the guard is settled "Not sent" and never delivered, and the typed row behind it still goes', async () => {
    writeQueue('claude', threadId, [row('ct-anq-pre-0001', WEB), row('ct-anq-pre-0002', 'typed, behind it')])
    gate = { attachable: true, reason: null }; ended = true; activity = 'idle'
    const out = await drainThread('claude', threadId, deps())
    expect(delivered).toEqual(['ct-anq-pre-0002'])
    expect(out).toMatchObject({ delivered: 1, retired: 1 })
    const settled = readQueue('claude', threadId, clock).find(t => t.clientTurnId === 'ct-anq-pre-0001')!
    expect(settled).toMatchObject({ status: 'refused', reason: TURN_END_ANSWER_NOT_QUEUED })
    expect(queuedTurnReasonCopy(settled.reason)).toBe('Not sent: an answer to a question is never sent late.')
  })

  it('the drain settles it while the session is still busy too: it is never held to be sent later', async () => {
    writeQueue('claude', threadId, [row('ct-anq-pre-0003', MAC)])
    const out = await drainThread('claude', threadId, deps())
    expect(delivered).toEqual([])
    expect(out).toMatchObject({ held: 0, retired: 1 })
    expect(readQueue('claude', threadId, clock)[0]).toMatchObject({ status: 'refused', reason: TURN_END_ANSWER_NOT_QUEUED })
  })

  it('Send anyway (lead 07:20): the button\'s mark lets its quoted answer wait in line, and the drain delivers it', async () => {
    await start()
    const quoted = WEB + '. This answers your earlier question “Approve the plan?”. You have taken a turn since asking it.'
    const res = await http('POST', POST, { clientTurnId: 'ct-anq-sa-0001', cosSessionId: 'cos-1', prompt: quoted, turnEndSendAnyway: true })
    expect(res.status).toBe(202)
    expect(readQueue('claude', threadId, clock)[0]).toMatchObject({ clientTurnId: 'ct-anq-sa-0001', status: 'waiting', turnEndSendAnyway: true })
    gate = { attachable: true, reason: null }; ended = true; activity = 'idle'
    await drainThread('claude', threadId, deps())
    expect(delivered).toEqual(['ct-anq-sa-0001'])
  })

  it('the mark is never inferred, never truthy-ish, and never copied: words alone, "true" as a string, and Send again all refuse', async () => {
    await start()
    const quoted = WEB + '. This answers your earlier question “Approve the plan?”. You have taken a turn since asking it.'
    for (const [id, extra] of [['ct-anq-sa-0002', {}], ['ct-anq-sa-0003', { turnEndSendAnyway: 'true' }], ['ct-anq-sa-0004', { turnEndSendAnyway: 1 }]] as const) {
      const res = await http('POST', POST, { clientTurnId: id, cosSessionId: 'cos-1', prompt: quoted, ...extra })
      expect(res.json.error).toBe(TURN_END_ANSWER_NOT_QUEUED)
    }
    writeQueue('claude', threadId, [row('ct-anq-sa-0005', quoted, { status: 'refused', reason: 'delivery_attempts_exhausted', settledAt: clock, turnEndSendAnyway: true })])
    const again = await http('POST', `${POST}/ct-anq-sa-0005/resend`, { clientTurnId: 'ct-anq-sa-0006', cosSessionId: 'cos-1' })
    expect(again.json.error).toBe(TURN_END_ANSWER_NOT_QUEUED)
  })

  it('the mark on a typed message is dropped, not stored: only words that need it carry it', async () => {
    await start()
    const res = await http('POST', POST, { clientTurnId: 'ct-anq-sa-0007', cosSessionId: 'cos-1', prompt: 'typed', turnEndSendAnyway: true })
    expect(res.status).toBe(202)
    expect('turnEndSendAnyway' in readQueue('claude', threadId, clock)[0]!).toBe(false)
  })

  it('the row\'s reason line fits the queue column', () => {
    expect(TURN_END_ANSWER_NOT_QUEUED_COPY.length).toBeLessThanOrEqual(QUEUED_TURN_REASON_COPY_MAX)
    expect(queuedTurnReasonCopy(TURN_END_ANSWER_NOT_QUEUED)!.length).toBeLessThanOrEqual(QUEUED_TURN_REASON_COPY_MAX)
  })
})
