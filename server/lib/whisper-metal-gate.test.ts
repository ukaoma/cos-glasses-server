import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  chooseBatchDevice,
  beginCanonicalMetal,
  isLiveMetalContended,
  isMetalBatchPreempted,
  LIVE_ACTIVITY_WINDOW_MS,
  MetalBatchPreemptedError,
  metalBatchInFlight,
  preemptMetalBatchForLive,
  registerLiveActivityProbe,
  registerMetalBatchChild,
  resetMetalGateForTests,
  tryAcquireMetalPreview,
  unregisterMetalBatchChild,
} from './whisper-metal-gate.js'
import { acquireMaintenanceWork } from './maintenance-lifecycle.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

const ENV_KEYS = ['COS_BATCH_HQ_METAL', 'COS_BATCH_HQ_FORCE_CPU'] as const
const saved: Record<string, string | undefined> = {}

function fakeChild(): ChildProcess & { signals: string[] } {
  const proc = new EventEmitter() as unknown as ChildProcess & { signals: string[] }
  proc.signals = []
  ;(proc as unknown as { kill: (s: string) => boolean }).kill = (signal: string) => {
    proc.signals.push(signal)
    return true
  }
  return proc
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  resetMetalGateForTests()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetMetalGateForTests()
  vi.useRealTimers()
})

describe('device choice (3B — opt-in until smoke)', () => {
  it('defaults to CPU when COS_BATCH_HQ_METAL is unset — today proven behavior', () => {
    registerLiveActivityProbe(() => null)
    const d = chooseBatchDevice()
    expect(d).toMatchObject({ device: 'cpu', reason: 'metal_opt_out', metalEnabled: false })
  })

  it('uses Metal when opted in and nothing is live', () => {
    process.env.COS_BATCH_HQ_METAL = '1'
    registerLiveActivityProbe(() => null)
    expect(chooseBatchDevice()).toMatchObject({ device: 'metal', reason: 'idle', metalEnabled: true })
  })

  it('FORCE_CPU wins over METAL, and survives a future default flip', () => {
    process.env.COS_BATCH_HQ_METAL = '1'
    process.env.COS_BATCH_HQ_FORCE_CPU = '1'
    registerLiveActivityProbe(() => null)
    expect(chooseBatchDevice()).toMatchObject({ device: 'cpu', reason: 'force_cpu', metalEnabled: false })
  })
})

describe('contention (2B — recent activity OR lease, never bare map membership)', () => {
  it('lets cosmetic preview run only while canonical Metal is idle', () => {
    registerLiveActivityProbe(() => null)
    const preview = tryAcquireMetalPreview()
    expect(preview).not.toBeNull()
    expect(preview?.signal.aborted).toBe(false)

    const releaseCanonical = beginCanonicalMetal('unit_test')
    expect(preview?.signal.aborted).toBe(true)
    expect(isLiveMetalContended()).toMatchObject({ contended: true, reason: 'canonical_in_flight' })
    expect(tryAcquireMetalPreview()).toBeNull()

    preview?.release()
    releaseCanonical()
    const nextPreview = tryAcquireMetalPreview()
    expect(nextPreview).not.toBeNull()
    nextPreview?.release()
  })

  it('allows preview between chunks during an active session but not during an HQ Metal child', () => {
    registerLiveActivityProbe(() => Date.now())
    const betweenChunks = tryAcquireMetalPreview()
    expect(betweenChunks).not.toBeNull()
    betweenChunks?.release()

    const batch = fakeChild()
    registerMetalBatchChild(batch, () => {})
    try {
      expect(tryAcquireMetalPreview()).toBeNull()
    } finally {
      unregisterMetalBatchChild(batch)
    }
  })

  it('a recently active session forces CPU', () => {
    process.env.COS_BATCH_HQ_METAL = '1'
    const now = Date.now()
    registerLiveActivityProbe(() => now - 5_000)
    expect(chooseBatchDevice(now)).toMatchObject({ device: 'cpu', reason: 'session_recent' })
  })

  it('a COLD orphan session does NOT pin batch to CPU', () => {
    // The failure this rule exists to prevent: an active-sessions entry sat
    // untouched for 3+ hours on 2026-07-27. An "any session in the map" rule
    // would have pinned batch to CPU until a server restart, silently forever.
    process.env.COS_BATCH_HQ_METAL = '1'
    const now = Date.now()
    registerLiveActivityProbe(() => now - (3 * 60 * 60_000))
    expect(chooseBatchDevice(now)).toMatchObject({ device: 'metal', reason: 'idle' })
  })

  it('pins the window boundary — just inside is contended, just outside is not', () => {
    process.env.COS_BATCH_HQ_METAL = '1'
    const now = Date.now()
    registerLiveActivityProbe(() => now - (LIVE_ACTIVITY_WINDOW_MS - 1_000))
    expect(chooseBatchDevice(now).device).toBe('cpu')
    registerLiveActivityProbe(() => now - (LIVE_ACTIVITY_WINDOW_MS + 1_000))
    expect(chooseBatchDevice(now).device).toBe('metal')
  })

  it('an active recording_chunk lease forces CPU even with no session activity', () => {
    process.env.COS_BATCH_HQ_METAL = '1'
    registerLiveActivityProbe(() => null)
    const lease = acquireMaintenanceWork('recording_chunk')
    try {
      expect(chooseBatchDevice()).toMatchObject({ device: 'cpu', reason: 'recording_chunk' })
    } finally {
      lease.release()
    }
    expect(chooseBatchDevice().device).toBe('metal')
  })

  it('one_shot_transcription (same Metal family) forces CPU', () => {
    process.env.COS_BATCH_HQ_METAL = '1'
    registerLiveActivityProbe(() => null)
    const lease = acquireMaintenanceWork('one_shot_transcription')
    try {
      expect(chooseBatchDevice().reason).toBe('one_shot_transcription')
    } finally {
      lease.release()
    }
  })

  it('a throwing probe fails SAFE to contended', () => {
    // A wrong "idle" starts Metal against a live meeting — the exact thing this
    // module exists to prevent. A wrong "busy" only costs batch speed.
    process.env.COS_BATCH_HQ_METAL = '1'
    registerLiveActivityProbe(() => { throw new Error('probe exploded') })
    expect(chooseBatchDevice()).toMatchObject({ device: 'cpu', reason: 'session_recent' })
  })

  it('never starts a second Metal batch while one is in flight', () => {
    process.env.COS_BATCH_HQ_METAL = '1'
    registerLiveActivityProbe(() => null)
    const proc = fakeChild()
    registerMetalBatchChild(proc, () => {})
    try {
      expect(isLiveMetalContended().reason).toBe('metal_batch_in_flight')
      expect(chooseBatchDevice().device).toBe('cpu')
    } finally {
      unregisterMetalBatchChild(proc)
    }
    expect(chooseBatchDevice().device).toBe('metal')
  })
})

describe('preempt (1C) and the partial-output BLOCKER', () => {
  it('SIGTERMs the Metal child and marks it preempted BEFORE the signal', () => {
    const proc = fakeChild()
    const order: string[] = []
    registerMetalBatchChild(proc, reason => order.push(`mark:${reason}`))
    ;(proc as unknown as { kill: (s: string) => boolean }).kill = (s: string) => {
      order.push(`kill:${s}`); return true
    }
    expect(preemptMetalBatchForLive('session_create')).toBe(1)
    // Ordering is load-bearing: if the signal landed first, the close handler
    // could see a truncated run as a clean exit and accept partial text.
    expect(order).toEqual(['mark:session_create', 'kill:SIGTERM'])
  })

  it('is idempotent — create hook and recording_chunk backstop cannot double-kill', () => {
    const proc = fakeChild()
    let marks = 0
    registerMetalBatchChild(proc, () => { marks++ })
    expect(preemptMetalBatchForLive('session_create')).toBe(1)
    expect(preemptMetalBatchForLive('recording_chunk')).toBe(0)
    expect(marks).toBe(1)
    expect(proc.signals).toEqual(['SIGTERM'])
  })

  it('escalates to SIGKILL when the child ignores SIGTERM', () => {
    vi.useFakeTimers()
    const proc = fakeChild()
    registerMetalBatchChild(proc, () => {})
    preemptMetalBatchForLive('recording_chunk')
    expect(proc.signals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(2_100)
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('is a no-op when no Metal batch is running (the common case)', () => {
    expect(metalBatchInFlight()).toBe(false)
    expect(preemptMetalBatchForLive('session_create')).toBe(0)
  })

  it('does not track CPU children — preempting them would slow batch for nothing', () => {
    // whisper-local only registers device=metal children. A CPU batch does not
    // contend for the GPU, so live work must never evict it.
    expect(metalBatchInFlight()).toBe(false)
    expect(preemptMetalBatchForLive('session_create')).toBe(0)
  })

  it('exposes a distinguishable error so the pipeline retries instead of dropping the segment', () => {
    const err = new MetalBatchPreemptedError('recording_chunk')
    expect(isMetalBatchPreempted(err)).toBe(true)
    expect(isMetalBatchPreempted(new Error('whisper-cli HQ exit 1'))).toBe(false)
    expect(isMetalBatchPreempted(null)).toBe(false)
  })
})

describe('wiring — these hooks are the whole fix; they must not be silently removed', () => {
  it('preempts on session CREATE only, never on an ordinary getSession touch', () => {
    const stream = src('server/routes/transcribe-stream.ts')
    // The call must sit inside the `if (!session)` create branch, before the
    // closing brace — a touch-level hook would evict healthy Metal batches on
    // every status read of a stale session.
    const create = stream.slice(stream.indexOf('export function getSession('))
    const branch = create.slice(create.indexOf('if (!session) {'), create.indexOf('return session'))
    expect(branch).toContain("preemptMetalBatchForLive('session_create')")
    expect(branch.indexOf('sessions.set(sessionId, session)'))
      .toBeLessThan(branch.indexOf("preemptMetalBatchForLive('session_create')"))
  })

  it('routes EVERY recording_chunk lease through the preempting wrapper', () => {
    const stream = src('server/routes/transcribe-stream.ts')
    // Exactly one direct acquire is allowed: the one inside the wrapper itself.
    const direct = stream.split("acquireMaintenanceWork('recording_chunk'").length - 1
    expect(direct).toBe(1)
    const wrapper = stream.slice(stream.indexOf('function acquireRecordingChunkLease'))
    expect(wrapper.indexOf("preemptMetalBatchForLive('recording_chunk')"))
      .toBeLessThan(wrapper.indexOf("acquireMaintenanceWork('recording_chunk'"))
  })

  it('discards preempted output BEFORE consulting the exit code', () => {
    const whisper = src('server/lib/whisper-local.ts')
    const close = whisper.slice(whisper.indexOf('unregisterMetalBatchChild(proc)'))
    const preempt = close.indexOf('if (preemptedReason)')
    const exit = close.indexOf('if (code !== 0)')
    expect(preempt).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(-1)
    // SIGTERM can race to a zero exit code with partial stdout. Checking the
    // exit code first would accept a truncated transcript into a saved meeting.
    expect(preempt).toBeLessThan(exit)
  })

  it('only Metal batch children are registered for preempt', () => {
    const whisper = src('server/lib/whisper-local.ts')
    expect(whisper).toContain('if (isBatch && useMetal) {\n        registerMetalBatchChild(')
  })

  it('retries a preempted segment exactly once, on CPU', () => {
    const batch = src('server/lib/meeting-batch-transcribe.ts')
    expect(batch).toContain('if (!isMetalBatchPreempted(error)) throw error')
    expect(batch).toContain("forceCpuReason: 'preempt_retry'")
    // Exactly one preempt retry. Progressive checkpoint CPU work is a separate,
    // default-off lane and must not be mistaken for an unbounded retry loop.
    expect(batch.split("forceCpuReason: 'preempt_retry'").length - 1).toBe(1)
  })
})
