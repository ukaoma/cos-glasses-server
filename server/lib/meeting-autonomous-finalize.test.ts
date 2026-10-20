import { describe, expect, it, vi } from 'vitest'
import {
  AUTONOMOUS_FINALIZE_POLL_MS,
  AUTONOMOUS_FINALIZE_SETTLE_MS,
  createAutonomousFinalizer,
  decideAutonomousFinalize,
  indicesFromRanges,
  type AutonomousFinalizerDeps,
  type SessionLedger,
} from './meeting-autonomous-finalize.js'
import type { StopIntent } from './meeting-stop-intents.js'

// 6.81.0: when may the server save a stopped G2 meeting on its own? Only a complete,
// fully transcribed, quiet capture after an explicit Stop. Every other answer waits,
// stands down, or revokes, and never saves.

const T0 = 10_000_000
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const ledger = (over: Partial<SessionLedger> = {}): SessionLedger => ({
  state: 'active', received: range(5), asrCompleted: range(5), maxChunkIndex: 4, lastActivityAt: T0, ...over,
})
const decide = (over: { final?: number; ledger?: Partial<SessionLedger>; now?: number; alreadySaved?: boolean; saving?: boolean } = {}) =>
  decideAutonomousFinalize({
    intent: { finalChunkIndex: over.final ?? 4, receivedAt: T0 },
    ledger: ledger(over.ledger),
    now: over.now ?? T0 + AUTONOMOUS_FINALIZE_SETTLE_MS,
    alreadySaved: over.alreadySaved ?? false,
    saving: over.saving ?? false,
  })

describe('decideAutonomousFinalize', () => {
  it('finalizes a complete, transcribed capture once it has been quiet for the settle time', () => {
    expect(decide()).toEqual({ action: 'finalize', chunks: 5 })
  })

  it('waits while any chunk 0..final is missing, naming how many', () => {
    const d = decide({ ledger: { received: [0, 1, 3, 4], asrCompleted: [0, 1, 3, 4] } })
    expect(d).toMatchObject({ action: 'wait', reason: 'missing_chunks', missing: [2], missingCount: 1 })
  })

  it('waits for the LAST chunk too (the one a hidden phone still holds)', () => {
    const d = decide({ final: 5 })
    expect(d).toMatchObject({ action: 'wait', reason: 'missing_chunks', missing: [5], missingCount: 1 })
  })

  it('waits while a received chunk has not finished ASR', () => {
    const d = decide({ ledger: { asrCompleted: [0, 1, 2, 4] } })
    expect(d).toMatchObject({ action: 'wait', reason: 'asr_pending', missing: [3], missingCount: 1 })
  })

  it('waits for the settle time after the Stop, so a phone on screen saves first', () => {
    const d = decide({ now: T0 + AUTONOMOUS_FINALIZE_SETTLE_MS - 1 })
    expect(d).toMatchObject({ action: 'wait', reason: 'settling' })
  })

  it('the settle clock restarts with the last chunk arrival (a phone still draining)', () => {
    const lateChunk = T0 + 30_000
    expect(decide({ ledger: { lastActivityAt: lateChunk }, now: lateChunk + AUTONOMOUS_FINALIZE_SETTLE_MS - 1 }))
      .toMatchObject({ action: 'wait', reason: 'settling' })
    expect(decide({ ledger: { lastActivityAt: lateChunk }, now: lateChunk + AUTONOMOUS_FINALIZE_SETTLE_MS }))
      .toEqual({ action: 'finalize', chunks: 5 })
  })

  it('revokes, never saves, when the Mac holds a chunk past the Stop (still recording)', () => {
    expect(decide({ ledger: { received: range(6), asrCompleted: range(6), maxChunkIndex: 5 } }))
      .toEqual({ action: 'revoke', reason: 'chunk_beyond_final', maxChunkIndex: 5 })
  })

  it('a saved meeting is never saved again', () => {
    expect(decide({ alreadySaved: true })).toEqual({ action: 'stand_down', reason: 'already_saved' })
  })

  it('a save in progress (the phone holds the lock) is waited on', () => {
    expect(decide({ saving: true })).toMatchObject({ action: 'wait', reason: 'saving' })
  })

  it('a session closed without a save is left to the stranded and quarantine paths', () => {
    expect(decide({ ledger: { state: 'closed' } })).toEqual({ action: 'stand_down', reason: 'closed_unsaved' })
  })

  it('a Stop with nothing captured stands down', () => {
    expect(decide({ final: -1 })).toEqual({ action: 'stand_down', reason: 'nothing_captured' })
  })

  it('an offline capture whose chunks have not arrived yet waits for the upload', () => {
    const d = decide({ ledger: { state: 'missing', received: [], asrCompleted: [], maxChunkIndex: -1, lastActivityAt: null } })
    expect(d).toMatchObject({ action: 'wait', reason: 'session_unknown', missingCount: 5 })
  })

  it('caps the missing sample at eight indices but counts them all', () => {
    const d = decide({ final: 40, ledger: { received: [0], asrCompleted: [0], maxChunkIndex: 0 } })
    expect(d).toMatchObject({ action: 'wait', reason: 'missing_chunks', missingCount: 40 })
    if (d.action === 'wait') expect(d.missing).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('indicesFromRanges expands inclusive ranges', () => {
    expect(indicesFromRanges([[0, 2], [5, 5]])).toEqual([0, 1, 2, 5])
  })
})

function intent(over: Partial<StopIntent> = {}): StopIntent {
  return {
    sessionId: 'meeting_a', finalChunkIndex: 4, source: 'companion', serverInstanceId: 'srv',
    receivedAt: T0, updatedAt: T0, posts: 1, state: 'waiting', lastWait: null, ...over,
  }
}

function finalizerHarness(over: Partial<AutonomousFinalizerDeps> = {}) {
  let clock = T0 + AUTONOMOUS_FINALIZE_SETTLE_MS
  const intents = new Map<string, StopIntent>([['meeting_a', intent()]])
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const log = vi.fn()
  const save = vi.fn(async () => ({ ok: true as const, filename: 'a.md', sidecarPath: '/x/a.g2-chunks.json', chunkCount: 5, canonicalCount: 5, missingIndices: [] }))
  let current = ledger()
  const deps: AutonomousFinalizerDeps = {
    waiting: () => [...intents.values()].filter(i => i.state === 'waiting'),
    get: id => intents.get(id) ?? null,
    update: (id, patch) => { const prev = intents.get(id); if (prev) intents.set(id, { ...prev, ...patch }) },
    ledger: () => current,
    alreadySaved: () => false,
    saving: () => false,
    save,
    ready: () => true,
    now: () => clock,
    schedule: (fn, ms) => { const entry = { fn, ms, cancelled: false }; scheduled.push(entry); return () => { entry.cancelled = true } },
    log,
    ...over,
  }
  const finalizer = createAutonomousFinalizer(deps)
  return {
    finalizer, intents, scheduled, log, save,
    setLedger: (l: Partial<SessionLedger>) => { current = ledger(l) },
    advance: (ms: number) => { clock += ms },
  }
}

describe('createAutonomousFinalizer', () => {
  it('saves a complete capture and records it as the server\'s save, with counts and wait time', async () => {
    const h = finalizerHarness()
    await h.finalizer.tick('test')
    expect(h.save).toHaveBeenCalledTimes(1)
    expect(h.intents.get('meeting_a')).toMatchObject({ state: 'saved', savedBy: 'server', filename: 'a.md', chunkCount: 5, canonicalCount: 5 })
    expect(h.log).toHaveBeenCalledWith('finalized', expect.objectContaining({
      sessionId: 'meeting_a', reason: 'stop_received_complete', chunks: 5, canonical: 5, gaps: 0, waitedMs: AUTONOMOUS_FINALIZE_SETTLE_MS,
    }))
    // Nothing left waiting, so nothing re-armed.
    expect(h.scheduled).toHaveLength(0)
  })

  it('never decides before durable recovery has run (the ledger proves nothing yet), and re-arms', async () => {
    const h = finalizerHarness({ ready: () => false })
    await h.finalizer.tick('boot')
    expect(h.save).not.toHaveBeenCalled()
    expect(h.intents.get('meeting_a')!.state).toBe('waiting')
    expect(h.scheduled).toHaveLength(1)
    expect(h.scheduled[0].ms).toBe(AUTONOMOUS_FINALIZE_POLL_MS)
  })

  it('waits on a gap, logs the wait once per change (not per poll), and re-arms', async () => {
    const h = finalizerHarness()
    h.setLedger({ received: [0, 1, 2, 3], asrCompleted: [0, 1, 2, 3], maxChunkIndex: 3 })
    await h.finalizer.tick('test')
    await h.finalizer.tick('test')
    expect(h.save).not.toHaveBeenCalled()
    expect(h.log.mock.calls.filter(([event]) => event === 'waiting')).toHaveLength(1)
    expect(h.intents.get('meeting_a')!.lastWait).toMatchObject({ reason: 'missing_chunks', missingCount: 1, missingSample: [4] })
    expect(h.scheduled.length).toBeGreaterThan(0)
    // The tail lands: the next tick saves.
    h.setLedger({})
    await h.finalizer.tick('test')
    expect(h.save).toHaveBeenCalledTimes(1)
  })

  it('a scheduled poll runs a tick when it fires', async () => {
    const h = finalizerHarness()
    h.setLedger({ received: [0, 1, 2, 3], asrCompleted: [0, 1, 2, 3], maxChunkIndex: 3 })
    await h.finalizer.tick('test')
    h.setLedger({})
    const live = h.scheduled.filter(entry => !entry.cancelled)
    expect(live).toHaveLength(1)
    live[0].fn()
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(1))
  })

  it('arm keeps the sooner of two timers', () => {
    const h = finalizerHarness()
    h.finalizer.arm(10_000)
    h.finalizer.arm(20_000)
    expect(h.scheduled.filter(entry => !entry.cancelled).map(entry => entry.ms)).toEqual([10_000])
    h.finalizer.arm(5_000)
    expect(h.scheduled.filter(entry => !entry.cancelled).map(entry => entry.ms)).toEqual([5_000])
  })

  it('revokes on a chunk past the Stop and never saves', async () => {
    const h = finalizerHarness()
    h.setLedger({ received: range(6), asrCompleted: range(6), maxChunkIndex: 5 })
    await h.finalizer.tick('test')
    expect(h.save).not.toHaveBeenCalled()
    expect(h.intents.get('meeting_a')).toMatchObject({ state: 'revoked', reason: 'chunk_beyond_final' })
    expect(h.log).toHaveBeenCalledWith('revoked', expect.objectContaining({ maxChunkIndex: 5, finalChunkIndex: 4 }))
  })

  it('a meeting the phone already saved is recorded as the phone\'s save', async () => {
    const h = finalizerHarness({ alreadySaved: () => true })
    await h.finalizer.tick('test')
    expect(h.save).not.toHaveBeenCalled()
    expect(h.intents.get('meeting_a')).toMatchObject({ state: 'saved', savedBy: 'phone' })
  })

  it('the phone saving between the decision and the lock is the phone\'s save', async () => {
    const h = finalizerHarness({ save: vi.fn(async () => ({ ok: false as const, status: 200, reason: 'already_saved' })) })
    await h.finalizer.tick('test')
    expect(h.intents.get('meeting_a')).toMatchObject({ state: 'saved', savedBy: 'phone' })
    expect(h.log).toHaveBeenCalledWith('stood_down', expect.objectContaining({ reason: 'already_saved' }))
  })

  it('the phone holding the save lock is waited on, and the Stop stays open', async () => {
    const h = finalizerHarness({ save: vi.fn(async () => ({ ok: false as const, status: 409, reason: 'save_in_progress' })) })
    await h.finalizer.tick('test')
    expect(h.intents.get('meeting_a')!.state).toBe('waiting')
    expect(h.scheduled.length).toBe(1)
    // The phone winning the lock is normal, not a failure.
    expect(h.log).not.toHaveBeenCalledWith('finalize_failed', expect.anything())
  })

  it('nothing to save (all silence) stands down', async () => {
    const h = finalizerHarness({ save: vi.fn(async () => ({ ok: false as const, status: 404, reason: 'nothing_to_save' })) })
    await h.finalizer.tick('test')
    expect(h.intents.get('meeting_a')).toMatchObject({ state: 'stood_down', reason: 'nothing_to_save' })
  })

  it('a different server instance stands down', async () => {
    const h = finalizerHarness({ save: vi.fn(async () => ({ ok: false as const, status: 409, reason: 'server_instance_mismatch' })) })
    await h.finalizer.tick('test')
    expect(h.intents.get('meeting_a')).toMatchObject({ state: 'stood_down', reason: 'server_instance_mismatch' })
  })

  it('a failed save is logged and retried, never marked saved', async () => {
    const h = finalizerHarness({ save: vi.fn(async () => ({ ok: false as const, status: 500, reason: 'meeting_save_error' })) })
    await h.finalizer.tick('test')
    expect(h.intents.get('meeting_a')!.state).toBe('waiting')
    expect(h.log).toHaveBeenCalledWith('finalize_failed', expect.objectContaining({ status: 500 }))
    expect(h.scheduled.length).toBe(1)
  })

  it('a save that throws is logged and the Stop stays open for the next poll', async () => {
    const h = finalizerHarness({ save: vi.fn(async () => { throw new Error('disk full') }) })
    await h.finalizer.tick('test')
    expect(h.intents.get('meeting_a')!.state).toBe('waiting')
    expect(h.log).toHaveBeenCalledWith('finalize_failed', expect.objectContaining({ reason: 'disk full' }))
    expect(h.scheduled.length).toBe(1)
  })

  it('a Stop that is no longer waiting (revoked, stood down) is never acted on, even if checked directly', async () => {
    const h = finalizerHarness()
    for (const state of ['revoked', 'stood_down'] as const) {
      h.intents.set('meeting_a', intent({ state }))
      expect(await h.finalizer.check('meeting_a', 'direct')).toBeNull()
    }
    expect(h.save).not.toHaveBeenCalled()
  })

  it('two overlapping checks of one session save once', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const save = vi.fn(async () => { await gate; return { ok: true as const, filename: 'a.md', sidecarPath: '/x', chunkCount: 5, canonicalCount: 5, missingIndices: [] } })
    const h = finalizerHarness({ save })
    const first = h.finalizer.check('meeting_a', 'a')
    const second = await h.finalizer.check('meeting_a', 'b')
    expect(second).toBeNull()
    release()
    await first
    expect(save).toHaveBeenCalledTimes(1)
  })
})
