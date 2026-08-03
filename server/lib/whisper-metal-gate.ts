// GPU admission control for post-meeting batch HQ transcription.
//
// THE PROBLEM: Miles goes meeting -> meeting. Meeting A's post-save HQ polish
// (whisper-cli large-v3) often overlaps Meeting B's live ASR. Both want Metal.
// 6.14.1 fixed the clash bluntly by pinning batch to CPU forever, which taxes
// every idle polish to protect the overlap case.
//
// THE INVARIANT: never Metal+Metal. Live always wins admission. Batch still
// progresses on busy days, just on CPU. Metal is used only when the operator
// has opted in AND nothing live is contending.
//
// NO CIRCULAR IMPORT: transcribe-stream REGISTERS its live-activity probe here;
// this module never imports the stream, and whisper-local imports only this.

import type { ChildProcess } from 'node:child_process'
import { maintenanceLifecycle } from './maintenance-lifecycle.js'

/** Recent-activity window. A session counts as live only if it has been active
 *  inside this window. Anything colder is treated as an ORPHAN and must NOT pin
 *  batch to CPU — proven necessary: an active-sessions file sat untouched for
 *  3+ hours on 2026-07-27, and an "any session in the map" rule would have
 *  pinned batch to CPU until a server restart, silently, forever. */
export const LIVE_ACTIVITY_WINDOW_MS = 180_000

/** Maintenance kinds that own the same Metal family as batch HQ. */
const METAL_FAMILY_WORK_KINDS = [
  'recording_chunk',
  'one_shot_transcription',
  'prompt_draft_warm',
  'prompt_draft_finalize',
] as const

export type BatchDevice = 'metal' | 'cpu'

export type ContentionReason =
  | 'session_recent'
  | 'recording_chunk'
  | 'one_shot_transcription'
  | 'prompt_draft_warm'
  | 'prompt_draft_finalize'
  | 'metal_batch_in_flight'
  | 'canonical_in_flight'

export type DeviceReason =
  | 'force_cpu'
  | 'metal_opt_out'
  | ContentionReason
  | 'idle'

export interface BatchDeviceDecision {
  device: BatchDevice
  reason: DeviceReason
  metalEnabled: boolean
}

// ── Env ──────────────────────────────────────────────────────────────────────

/** Blunt rollback. Wins over everything, and keeps working after the default
 *  eventually flips to Metal-on. */
export function batchHqForceCpu(): boolean {
  return process.env.COS_BATCH_HQ_FORCE_CPU === '1'
}

/** Metal batch is OPT-IN (3B). Default stays always-CPU — today's proven
 *  behavior — until a meeting-to-meeting smoke passes. Read live, not at module
 *  load, so tests and Control-updated env are visible. */
export function batchHqMetalEnabled(): boolean {
  return !batchHqForceCpu() && process.env.COS_BATCH_HQ_METAL === '1'
}

// ── Injected live-activity probe ─────────────────────────────────────────────

type LiveActivityProbe = () => number | null

let liveActivityProbe: LiveActivityProbe | null = null
let canonicalMetalRequests = 0
const previewMetalRequests = new Set<AbortController>()

/** transcribe-stream calls this at module load. Returns the most recent
 *  lastActivityAt across in-memory sessions, or null when there are none. */
export function registerLiveActivityProbe(probe: LiveActivityProbe): void {
  liveActivityProbe = probe
}

/** Test seam — clears the probe and any tracked children. */
export function resetMetalGateForTests(): void {
  liveActivityProbe = null
  metalChildren.clear()
  canonicalMetalRequests = 0
  for (const controller of previewMetalRequests) controller.abort('test_reset')
  previewMetalRequests.clear()
}

function recentSessionActivity(now: number): boolean {
  if (!liveActivityProbe) return false
  let last: number | null = null
  try {
    last = liveActivityProbe()
  } catch {
    // A probe failure must fail SAFE (assume contended): a wrong "idle" starts
    // a Metal batch against a live meeting, which is the one thing this whole
    // module exists to prevent. A wrong "busy" only costs batch speed.
    return true
  }
  if (last == null || !Number.isFinite(last)) return false
  return now - last < LIVE_ACTIVITY_WINDOW_MS
}

function activeMetalFamilyWork(): ContentionReason | null {
  let byKind: Record<string, number>
  try {
    byKind = maintenanceLifecycle.snapshot().activeByKind as Record<string, number>
  } catch {
    return 'recording_chunk' // fail safe, same reasoning as above
  }
  for (const kind of METAL_FAMILY_WORK_KINDS) {
    if ((byKind[kind] ?? 0) > 0) return kind
  }
  return null
}

/** Is something live currently entitled to Metal? */
export function isLiveMetalContended(now: number = Date.now()): { contended: boolean; reason: ContentionReason | null } {
  if (canonicalMetalRequests > 0) return { contended: true, reason: 'canonical_in_flight' }
  const work = activeMetalFamilyWork()
  if (work) return { contended: true, reason: work }
  if (recentSessionActivity(now)) return { contended: true, reason: 'session_recent' }
  if (metalChildren.size > 0) return { contended: true, reason: 'metal_batch_in_flight' }
  return { contended: false, reason: null }
}

export interface MetalPreviewLease {
  signal: AbortSignal
  release: () => void
}

/** Cosmetic preview receives Metal only while canonical work is idle. The
 * registration is synchronous, so a canonical request that begins afterward
 * can abort this request before starting its own inference. */
export function tryAcquireMetalPreview(): MetalPreviewLease | null {
  // Recent session activity is not itself GPU work. Allow preview between
  // canonical chunks, but never alongside an active canonical or HQ Metal job.
  if (canonicalMetalRequests > 0 || metalChildren.size > 0) return null
  const controller = new AbortController()
  previewMetalRequests.add(controller)
  let released = false
  return {
    signal: controller.signal,
    release: () => {
      if (released) return
      released = true
      previewMetalRequests.delete(controller)
    },
  }
}

/** Canonical live transcription always wins. Abort any cosmetic preview first,
 * then hold a synchronous counter so no new preview can enter until release. */
export function beginCanonicalMetal(reason: string): () => void {
  canonicalMetalRequests++
  for (const controller of previewMetalRequests) controller.abort(reason)
  let released = false
  return () => {
    if (released) return
    released = true
    canonicalMetalRequests = Math.max(0, canonicalMetalRequests - 1)
  }
}

export class MetalPreviewContendedError extends Error {
  readonly contended = true
  constructor() {
    super('Whisper preview yielded to canonical transcription')
    this.name = 'MetalPreviewContendedError'
  }
}

/** Device for the NEXT batch segment. Re-evaluated per segment so a meeting
 *  that starts mid-batch moves subsequent segments to CPU without a preempt. */
export function chooseBatchDevice(now: number = Date.now()): BatchDeviceDecision {
  if (batchHqForceCpu()) return { device: 'cpu', reason: 'force_cpu', metalEnabled: false }
  const metalEnabled = batchHqMetalEnabled()
  if (!metalEnabled) return { device: 'cpu', reason: 'metal_opt_out', metalEnabled: false }
  const { contended, reason } = isLiveMetalContended(now)
  if (contended) return { device: 'cpu', reason: reason ?? 'session_recent', metalEnabled: true }
  return { device: 'metal', reason: 'idle', metalEnabled: true }
}

// ── Metal child registry + preempt ───────────────────────────────────────────

interface MetalChildEntry {
  proc: ChildProcess
  /** Set by the owner so the close handler can DISCARD partial output rather
   *  than resolving a truncated transcript into a saved meeting. */
  markPreempted: (reason: string) => void
  escalate?: ReturnType<typeof setTimeout>
}

const metalChildren = new Map<ChildProcess, MetalChildEntry>()

/** whisper-local registers ONLY Metal-device HQ children. CPU children are
 *  deliberately absent: they do not contend for the GPU, so preempting them
 *  would slow batch for no benefit. */
export function registerMetalBatchChild(proc: ChildProcess, markPreempted: (reason: string) => void): void {
  metalChildren.set(proc, { proc, markPreempted })
}

export function unregisterMetalBatchChild(proc: ChildProcess): void {
  const entry = metalChildren.get(proc)
  if (entry?.escalate) clearTimeout(entry.escalate)
  metalChildren.delete(proc)
}

export function metalBatchInFlight(): boolean {
  return metalChildren.size > 0
}

/**
 * Live work needs the GPU: kill every in-flight Metal batch child.
 *
 * Idempotent — a child already preempted is skipped, so the create-path hook
 * and the recording_chunk backstop can both fire without double-killing.
 * Returns how many children were preempted (0 is the overwhelmingly common
 * case: no Metal batch running, or Metal not opted in at all).
 */
export function preemptMetalBatchForLive(reason: string): number {
  if (metalChildren.size === 0) return 0
  let preempted = 0
  for (const entry of [...metalChildren.values()]) {
    if (entry.escalate) continue // already preempted, escalation pending
    preempted++
    // Mark FIRST: the close handler must see the preempt flag before the signal
    // lands, or it could treat a truncated run as a clean exit.
    try { entry.markPreempted(reason) } catch { /* never block the kill */ }
    try { entry.proc.kill('SIGTERM') } catch { /* already exited */ }
    entry.escalate = setTimeout(() => {
      try { entry.proc.kill('SIGKILL') } catch { /* already exited */ }
    }, 2_000)
    entry.escalate.unref?.()
  }
  if (preempted > 0) {
    console.log(`[metal-gate] Preempted ${preempted} Metal batch child(ren) for live work (${reason})`)
  }
  return preempted
}

/** Distinguishable error so the batch pipeline can retry the SAME segment on
 *  CPU instead of treating it as a generic transcription failure. */
export class MetalBatchPreemptedError extends Error {
  readonly preempted = true
  constructor(readonly preemptReason: string) {
    super(`Metal batch preempted by live work (${preemptReason})`)
    this.name = 'MetalBatchPreemptedError'
  }
}

export function isMetalBatchPreempted(error: unknown): error is MetalBatchPreemptedError {
  return error instanceof MetalBatchPreemptedError
    || (typeof error === 'object' && error !== null && (error as { preempted?: boolean }).preempted === true)
}
