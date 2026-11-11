// 2026-11-11 (S1, lanes/S1_queue_hold_diagnosis.md): a waiting row says WHY it is held, as a code the drain decided,
// since when, and when a sweep last decided it. Miles's 08:01:25 note sat "waiting" with no reason for 35 minutes.
// Real drainer, real queue files; the gate, the turn evidence and the peer inbox are fakes.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// HOISTED: DATA_DIR is resolved at import time.
const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-hold-reason-'))
  process.env.COS_DATA_DIR = dir
  return { dir }
})
import { rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { __resetHoldCheckedForTests, drainThread, publicRow, type ThreadTurnQueueDeps } from './thread-turn-queue.js'
import { readQueue, writeQueue } from '../lib/thread-turn-queue-store.js'
import { holdReasonFor, type QueuedThreadTurn } from '../lib/thread-turn-queue.js'

afterAll(() => { rmSync(FIXTURE.dir, { recursive: true, force: true }) })

const FLAGS = ['COS_STEER_MIDTURN', 'COS_SESSION_STEER', 'COS_CONTINUE_LIVE', 'COS_QUEUE_RECONCILE'] as const
const savedEnv: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]))
let threadId = ''
let clock = 1_000_000
beforeEach(() => { threadId = randomUUID(); clock = 1_000_000; __resetHoldCheckedForTests(); for (const k of FLAGS) delete process.env[k] })
afterEach(() => { for (const k of FLAGS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] } })

function row(over: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn {
  return { clientTurnId: `t-${randomUUID()}`, cosSessionId: 'web-test', provider: 'claude', threadId, prompt: 'placeholder', queuedAt: clock, status: 'waiting', attempts: 0, ...over }
}

/** No peer inbox: nothing can go into a running turn, so a plain row waits. */
const NO_INBOX = { steerProbe: () => ({ peerInbox: false, waitingOnPrompt: false }) }

function deps(gate: { attachable: boolean; reason: string | null }, over: Partial<ThreadTurnQueueDeps> = {}): ThreadTurnQueueDeps {
  return {
    occupancy: () => gate,
    turnEnded: () => false,
    activity: () => 'working',
    deliver: async () => ({ ok: true }),
    deliverLiveTurn: async () => ({ ok: true, reason: 'delivered' }),
    steerProbe: () => ({ peerInbox: true, waitingOnPrompt: false }),
    attempts: { begin: () => true, settle: () => true },
    bootId: 'boot-A',
    now: () => clock,
    ...over,
  }
}

const stored = (id: string) => readQueue('claude', threadId, clock).find(t => t.clientTurnId === id)!

describe('holdReasonFor: the code names the branch of drainDecision that held', () => {
  it('cancel hold, then the gate (its own reason), then an open turn, then a turn not yet ended', () => {
    expect(holdReasonFor({ attachable: false, reason: 'native_thread_working', turnEnded: false, activity: 'working', cancelHoldUntil: 2_000 }, 1_000)).toBe('cancel_hold')
    expect(holdReasonFor({ attachable: false, reason: 'native_thread_working', turnEnded: false, activity: 'working' }, 1_000)).toBe('native_thread_working')
    expect(holdReasonFor({ attachable: true, reason: null, turnEnded: true, turnOpen: true, activity: 'idle' }, 1_000)).toBe('turn_open')
    expect(holdReasonFor({ attachable: true, reason: null, turnEnded: false, activity: 'working' }, 1_000)).toBe('turn_not_ended')
  })
  it('a gate reason that is not a short code is never passed on: it reads gate_closed', () => {
    expect(holdReasonFor({ attachable: false, reason: 'Some words with spaces', turnEnded: false, activity: 'working' }, 1)).toBe('gate_closed')
    expect(holdReasonFor({ attachable: false, reason: null, turnEnded: false, activity: 'working' }, 1)).toBe('gate_closed')
  })
})

describe('the drain records the hold reason on the row, and the row shows it', () => {
  it('a held row gets its code and since-time once; the next sweep writes nothing and only advances the check time', async () => {
    const t = row()
    writeQueue('claude', threadId, [t])
    await drainThread('claude', threadId, deps({ attachable: false, reason: 'native_thread_working' }, NO_INBOX))
    expect(stored(t.clientTurnId)).toMatchObject({ status: 'waiting', holdReason: 'native_thread_working', holdSince: 1_000_000 })
    expect(publicRow(stored(t.clientTurnId), 0)).toMatchObject({ waiting_reason: 'native_thread_working', waiting_since: 1_000_000, waiting_checked_at: 1_000_000 })
    const file = `${FIXTURE.dir}/thread-turn-queue`
    const before = statSync(file).mtimeMs
    const written = JSON.stringify(readQueue('claude', threadId, clock))
    clock += 20_000
    await drainThread('claude', threadId, deps({ attachable: false, reason: 'native_thread_working' }, NO_INBOX))
    expect(JSON.stringify(readQueue('claude', threadId, clock))).toBe(written) // no write: the code did not change
    expect(statSync(file).mtimeMs).toBe(before)
    expect(publicRow(stored(t.clientTurnId), 0)).toMatchObject({ waiting_since: 1_000_000, waiting_checked_at: 1_020_000 })
  })

  it('the code follows the decision when it changes: busy, then an open turn', async () => {
    const t = row()
    writeQueue('claude', threadId, [t])
    await drainThread('claude', threadId, deps({ attachable: false, reason: 'native_thread_working' }, NO_INBOX))
    clock += 20_000
    await drainThread('claude', threadId, deps({ attachable: true, reason: null }, { ...NO_INBOX, turnOpen: () => true, turnEnded: () => true, activity: () => 'idle' }))
    expect(stored(t.clientTurnId)).toMatchObject({ holdReason: 'turn_open', holdSince: 1_020_000 })
  })

  it('a row with files that could have gone into the running turn says files_wait_for_turn_end', async () => {
    const files = row({ attachmentIds: ['m_0000000000000001'] })
    writeQueue('claude', threadId, [files])
    await drainThread('claude', threadId, deps({ attachable: false, reason: 'native_thread_working' }))
    expect(stored(files.clientTurnId).holdReason).toBe('files_wait_for_turn_end')
  })

  it('a row with files where nothing could go mid-turn keeps the gate reason (switch off)', async () => {
    process.env.COS_STEER_MIDTURN = '0'
    const files = row({ attachmentIds: ['m_0000000000000001'] })
    writeQueue('claude', threadId, [files])
    await drainThread('claude', threadId, deps({ attachable: false, reason: 'native_thread_working' }))
    expect(stored(files.clientTurnId).holdReason).toBe('native_thread_working')
  })

  it('a row that settled another way (expired) keeps its code in the file but the row no longer shows it', async () => {
    const t = row()
    writeQueue('claude', threadId, [t])
    await drainThread('claude', threadId, deps({ attachable: false, reason: 'native_thread_working' }, NO_INBOX))
    clock += 6 * 3600_000 + 1 // past QUEUED_TURN_TTL_MS
    await drainThread('claude', threadId, deps({ attachable: false, reason: 'native_thread_working' }, NO_INBOX))
    const after = stored(t.clientTurnId)
    expect(after).toMatchObject({ status: 'expired', holdReason: 'native_thread_working' })
    expect(publicRow(after, -1)).not.toHaveProperty('waiting_reason')
  })

  it('a delivered row carries no hold reason, and a row never held shows none', async () => {
    const t = row()
    writeQueue('claude', threadId, [t])
    expect(publicRow(t, 0)).not.toHaveProperty('waiting_reason')
    await drainThread('claude', threadId, deps({ attachable: false, reason: 'native_thread_working' }, NO_INBOX))
    clock += 20_000
    await drainThread('claude', threadId, deps({ attachable: true, reason: null }, { turnEnded: () => true, activity: () => 'idle' }))
    const after = stored(t.clientTurnId)
    expect(after.status).not.toBe('waiting')
    expect(after).not.toHaveProperty('holdReason')
    expect(after).not.toHaveProperty('holdSince')
    expect(publicRow(after, -1)).not.toHaveProperty('waiting_reason')
  })
})
