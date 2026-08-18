// The queue that lets a turn survive a busy thread.
//
// THE PROPERTY THAT MATTERS MOST is that this does not weaken the attach gate. Several
// tests below exist only to prove a negative: no path through the queue delivers into a
// thread the gate refuses. If one of them ever goes green after being mutated, the
// feature has become the thing it was designed not to be.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  admitToQueue, drainDecision, queueableRefusal, pruneQueue, queuePosition,
  MAX_DELIVERY_ATTEMPTS, MAX_QUEUED_PER_THREAD, QUEUED_TURN_TTL_MS,
  type QueuedThreadTurn, type DrainObservation,
} from './thread-turn-queue.js'

let dataDir = ''
let saved: string | undefined
beforeEach(() => {
  saved = process.env.COS_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'cos-turnqueue-'))
  process.env.COS_DATA_DIR = dataDir
})
afterEach(() => {
  if (saved === undefined) delete process.env.COS_DATA_DIR; else process.env.COS_DATA_DIR = saved
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

const turn = (over: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn => ({
  clientTurnId: 'ct-1', cosSessionId: 'cos-1', provider: 'claude', threadId: 'thr-1',
  prompt: 'ship it', queuedAt: 1_000, status: 'waiting', attempts: 0, ...over,
})
const seen = (over: Partial<DrainObservation> = {}): DrainObservation =>
  ({ attachable: true, turnEnded: true, activity: 'idle', ...over })

describe('the queue never delivers into a thread the gate refuses', () => {
  it('HOLDS whenever the gate says no, however ready everything else looks', () => {
    // The load-bearing assertion of the whole feature.
    for (const extra of [{}, { turnEnded: true }, { activity: 'idle' as const }]) {
      expect(drainDecision(turn(), seen({ attachable: false, ...extra }), 2_000)).toBe('hold')
    }
  })

  it('holds while the holder is mid-turn, even though the gate allows it', () => {
    // Attachable only says nobody else OWNS the thread. It does not say a turn is not
    // in flight, and injecting into the middle of one is the failure mode that made
    // 30s-of-silence the wrong trigger on its own.
    expect(drainDecision(turn(), seen({ turnEnded: false, activity: 'working' }), 2_000)).toBe('hold')
  })

  it('holds on an unmeasurable clock rather than guessing', () => {
    expect(drainDecision(turn(), seen({ turnEnded: false, activity: 'unknown' }), 2_000)).toBe('hold')
  })
})

describe('when a turn does go', () => {
  it('delivers on the terminal record, which is the precise signal', () => {
    expect(drainDecision(turn(), seen({ turnEnded: true, activity: 'working' }), 2_000)).toBe('deliver')
  })

  it('delivers on the idle backstop when no terminal record ever lands', () => {
    // A holder that dies, or a provider that writes no terminal row, must not wedge
    // the queue forever.
    expect(drainDecision(turn(), seen({ turnEnded: false, activity: 'idle' }), 2_000)).toBe('deliver')
  })
})

describe('a turn cannot outlive its meaning, or retry forever', () => {
  it('expires rather than saying something six hours late', () => {
    const t = turn({ queuedAt: 0 })
    expect(drainDecision(t, seen(), QUEUED_TURN_TTL_MS - 1)).toBe('deliver')
    expect(drainDecision(t, seen(), QUEUED_TURN_TTL_MS)).toBe('expire')
  })

  it('expiry and the attempt ceiling are checked BEFORE readiness', () => {
    // Otherwise a lucky tick delivers a turn that had already run out of time or tries.
    expect(drainDecision(turn({ queuedAt: 0 }), seen(), QUEUED_TURN_TTL_MS)).toBe('expire')
    expect(drainDecision(turn({ attempts: MAX_DELIVERY_ATTEMPTS }), seen(), 2_000)).toBe('give_up')
  })

  it('never re-decides a turn that already settled', () => {
    for (const status of ['delivered', 'refused', 'expired', 'cancelled', 'delivering'] as const) {
      expect(drainDecision(turn({ status }), seen(), 2_000)).toBe('hold')
    }
  })

  it('holds rather than throwing on a non-finite clock', () => {
    expect(drainDecision(turn(), seen(), Number.NaN)).toBe('hold')
    expect(drainDecision(turn({ queuedAt: Number.NaN }), seen(), 2_000)).toBe('hold')
  })
})

describe('what may be queued at all', () => {
  it('parks the occupancy reasons, which can pass', () => {
    for (const r of ['native_thread_working', 'live_desktop_process', 'thread_busy', 'probe_failed']) {
      expect(queueableRefusal(r), r).toBe(true)
    }
  })

  it('refuses the structural ones outright, because they never clear', () => {
    // Telling someone their turn is queued when it can never run is worse than
    // refusing it.
    for (const r of ['unsupported_provider', 'invalid_thread_id', 'attach_disabled', 'native_thread_changed']) {
      expect(queueableRefusal(r), r).toBe(false)
    }
    expect(queueableRefusal(null)).toBe(false)
    expect(queueableRefusal(undefined)).toBe(false)
  })
})

describe('admission', () => {
  it('refuses a duplicate id rather than saying the same sentence twice', () => {
    const first = admitToQueue([], turn())
    expect(first.ok).toBe(true)
    const again = admitToQueue((first as { queue: QueuedThreadTurn[] }).queue, turn())
    expect(again).toEqual({ ok: false, reason: 'duplicate_turn' })
  })

  it('caps the queue, counting only what is still waiting', () => {
    const full = Array.from({ length: MAX_QUEUED_PER_THREAD }, (_, i) => turn({ clientTurnId: `ct-${i}` }))
    expect(admitToQueue(full, turn({ clientTurnId: 'new' }))).toEqual({ ok: false, reason: 'queue_full' })
    // Settled rows do not count against the cap.
    const settled = full.map(t => ({ ...t, status: 'delivered' as const }))
    expect(admitToQueue(settled, turn({ clientTurnId: 'new' })).ok).toBe(true)
  })

  it('rejects an empty prompt', () => {
    expect(admitToQueue([], turn({ prompt: '   ' })).ok).toBe(false)
  })
})

describe('the pending row keeps its meaning', () => {
  it('keeps a settled row visible for a while, because vanishing reads as lost', () => {
    const settled = turn({ status: 'delivered', settledAt: 1_000 })
    expect(pruneQueue([settled], 1_000 + 60_000)).toHaveLength(1)
    expect(pruneQueue([settled], 1_000 + 31 * 60_000)).toHaveLength(0)
  })

  it('never prunes a live row, whatever the clock says', () => {
    expect(pruneQueue([turn({ queuedAt: 0 })], 1e12)).toHaveLength(1)
    expect(pruneQueue([turn({ status: 'delivering', queuedAt: 0 })], 1e12)).toHaveLength(1)
  })

  it('numbers the waiting rows and ignores the settled ones', () => {
    const q = [turn({ clientTurnId: 'a', status: 'delivered' }), turn({ clientTurnId: 'b' }), turn({ clientTurnId: 'c' })]
    expect(queuePosition(q, 'b')).toBe(0)
    expect(queuePosition(q, 'c')).toBe(1)
  })
})
