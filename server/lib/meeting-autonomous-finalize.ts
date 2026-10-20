// The server finishes a stopped G2 meeting on its own (6.81.0).
//
// Miles, 2026-10-20: "if the application isn't in the foreground, it can fail to save the
// meetings". Once the phone has told the server its meeting stopped (lib/meeting-stop-
// intents.ts) and the server holds every chunk it captured, nothing is left that needs the
// phone, so the server runs the same save the phone would have run. The phone, when it
// comes back on screen, finds a saved meeting and adopts the receipt.
//
// THE ONE RULE: NEVER SAVE A CAPTURE THAT IS NOT COMPLETE. The server saves on its own only
// when its ledger holds every index 0..N (N = the phone's last captured index) and every one
// of them has finished ASR. A gap means audio exists only on the phone, so the server waits
// and the session stays live: the phone's late upload lands in the SAME session (the merge)
// and the next check saves. There is no shorter timeout that saves with the gap, because a
// save closes the session, and a chunk that arrives after the close is refused (410) and the
// phone reads "server closed, local audio pending" as a collision it cannot resolve: the
// meeting splits or the tail is lost. A gap that never fills is handed to the existing
// stranded sweeper at its existing 4 h horizon, exactly as before this release. Waiting
// costs only time; saving early costs audio.
//
// Why a settle delay as well: a phone that is on screen saves within a few seconds of Stop.
// The server stands back for AUTONOMOUS_FINALIZE_SETTLE_MS after the Stop and after the last
// chunk arrived, so a healthy phone's own save is the normal path and the server's is the
// fallback. Both racing is safe anyway (one save lock, an idempotent save route), but not
// racing is quieter.

import type { StopIntent } from './meeting-stop-intents.js'

/** Quiet time after the Stop and after the last chunk before the server saves on its own. */
export const AUTONOMOUS_FINALIZE_SETTLE_MS = 45_000
/** How often a waiting Stop is checked again. Cheap: an in-memory ledger read. */
export const AUTONOMOUS_FINALIZE_POLL_MS = 15_000
/** Missing indices kept in a log line. */
const MISSING_SAMPLE = 8

export interface SessionLedger {
  state: 'active' | 'closed' | 'missing'
  received: readonly number[]
  asrCompleted: readonly number[]
  maxChunkIndex: number
  /** ms since epoch of the last chunk arrival, or null. */
  lastActivityAt: number | null
}

export type AutonomousWaitReason = 'settling' | 'missing_chunks' | 'asr_pending' | 'session_unknown' | 'saving' | 'not_ready'
export type AutonomousStandDownReason = 'already_saved' | 'closed_unsaved' | 'nothing_captured' | 'server_instance_mismatch'

export type AutonomousDecision =
  | { action: 'finalize'; chunks: number }
  | { action: 'wait'; reason: AutonomousWaitReason; missing: number[]; missingCount: number; retryInMs: number }
  | { action: 'revoke'; reason: 'chunk_beyond_final'; maxChunkIndex: number }
  | { action: 'stand_down'; reason: AutonomousStandDownReason }

function missingFrom(finalIndex: number, have: readonly number[]): { sample: number[]; count: number } {
  const present = new Set(have)
  const sample: number[] = []
  let count = 0
  for (let index = 0; index <= finalIndex; index++) {
    if (present.has(index)) continue
    count++
    if (sample.length < MISSING_SAMPLE) sample.push(index)
  }
  return { sample, count }
}

/**
 * What to do with a waiting Stop right now. Pure: every input is passed in.
 *
 * Order matters and each step is pinned by a test: a saved meeting is never saved again, a
 * chunk past the Stop means the meeting is still recording (revoke, never save), and only a
 * complete, fully transcribed, quiet capture is saved.
 */
export function decideAutonomousFinalize(input: {
  intent: Pick<StopIntent, 'finalChunkIndex' | 'receivedAt'>
  ledger: SessionLedger
  now: number
  alreadySaved: boolean
  saving: boolean
}): AutonomousDecision {
  const { intent, ledger, now } = input
  if (input.alreadySaved) return { action: 'stand_down', reason: 'already_saved' }
  if (input.saving) return { action: 'wait', reason: 'saving', missing: [], missingCount: 0, retryInMs: AUTONOMOUS_FINALIZE_POLL_MS }
  // A session closed WITHOUT a save receipt (expired, quarantined) is the stranded and
  // quarantine paths' to finish. Saving here would race them.
  if (ledger.state === 'closed') return { action: 'stand_down', reason: 'closed_unsaved' }
  if (intent.finalChunkIndex < 0) return { action: 'stand_down', reason: 'nothing_captured' }
  // The server holds audio the phone says it never captured: the phone resumed after this
  // Stop, or the Stop is stale. Either way the meeting may still be recording.
  if (ledger.maxChunkIndex > intent.finalChunkIndex) {
    return { action: 'revoke', reason: 'chunk_beyond_final', maxChunkIndex: ledger.maxChunkIndex }
  }
  // An offline capture: the Stop arrived before any chunk did. Wait for the upload.
  if (ledger.state === 'missing') {
    return { action: 'wait', reason: 'session_unknown', missing: [], missingCount: intent.finalChunkIndex + 1, retryInMs: AUTONOMOUS_FINALIZE_POLL_MS }
  }
  const absent = missingFrom(intent.finalChunkIndex, ledger.received)
  if (absent.count > 0) {
    return { action: 'wait', reason: 'missing_chunks', missing: absent.sample, missingCount: absent.count, retryInMs: AUTONOMOUS_FINALIZE_POLL_MS }
  }
  const pending = missingFrom(intent.finalChunkIndex, ledger.asrCompleted)
  if (pending.count > 0) {
    return { action: 'wait', reason: 'asr_pending', missing: pending.sample, missingCount: pending.count, retryInMs: AUTONOMOUS_FINALIZE_POLL_MS }
  }
  const quietSince = Math.max(intent.receivedAt, ledger.lastActivityAt ?? 0)
  const settleLeft = quietSince + AUTONOMOUS_FINALIZE_SETTLE_MS - now
  if (settleLeft > 0) {
    return { action: 'wait', reason: 'settling', missing: [], missingCount: 0, retryInMs: Math.min(settleLeft, AUTONOMOUS_FINALIZE_POLL_MS) }
  }
  return { action: 'finalize', chunks: intent.finalChunkIndex + 1 }
}

/** Expand `[start, end]` ranges (the status route's shape) into indices. */
export function indicesFromRanges(ranges: ReadonlyArray<readonly [number, number]>): number[] {
  const out: number[] = []
  for (const [start, end] of ranges) for (let index = start; index <= end; index++) out.push(index)
  return out
}

export type AutonomousSaveOutcome =
  | { ok: true; filename: string; sidecarPath: string; chunkCount: number; canonicalCount: number; missingIndices: number[] }
  | { ok: false; status: number; reason: string }

export interface AutonomousFinalizerDeps {
  waiting(): StopIntent[]
  get(sessionId: string): StopIntent | null
  update(sessionId: string, patch: Partial<StopIntent>): void
  ledger(sessionId: string): SessionLedger
  alreadySaved(sessionId: string): boolean
  saving(sessionId: string): boolean
  save(intent: StopIntent): Promise<AutonomousSaveOutcome>
  /** Maintenance admissions open AND durable session recovery has run. */
  ready(): boolean
  now(): number
  /** Returns a cancel function. Production timers are unref'd so they never hold the process. */
  schedule(fn: () => void, ms: number): () => void
  log(event: string, fields: Record<string, unknown>): void
}

export interface AutonomousFinalizer {
  /** Check one session now (a Stop arrived, a boot). Never throws. */
  check(sessionId: string, trigger: string): Promise<AutonomousDecision | null>
  /** Check every waiting Stop, then re-arm while any remain. */
  tick(trigger?: string): Promise<void>
  /** Make sure a tick is scheduled. */
  arm(ms?: number): void
}

export function createAutonomousFinalizer(deps: AutonomousFinalizerDeps): AutonomousFinalizer {
  const inFlight = new Set<string>()
  let cancel: (() => void) | null = null
  let armedFor = Infinity

  const arm = (ms = AUTONOMOUS_FINALIZE_POLL_MS) => {
    const due = deps.now() + Math.max(0, ms)
    if (cancel && armedFor <= due) return
    cancel?.()
    armedFor = due
    cancel = deps.schedule(() => {
      cancel = null
      armedFor = Infinity
      void finalizer.tick('poll')
    }, Math.max(0, ms))
  }

  const check = async (sessionId: string, trigger: string): Promise<AutonomousDecision | null> => {
    if (inFlight.has(sessionId)) return null
    const intent = deps.get(sessionId)
    if (!intent || intent.state !== 'waiting') return null
    // A boot behind a closed maintenance gate has not adopted the persisted sessions yet,
    // so "the server holds no chunks" is not evidence of anything. Wait, never decide.
    if (!deps.ready()) {
      return { action: 'wait', reason: 'not_ready', missing: [], missingCount: 0, retryInMs: AUTONOMOUS_FINALIZE_POLL_MS }
    }
    inFlight.add(sessionId)
    try {
      const now = deps.now()
      const decision = decideAutonomousFinalize({
        intent,
        ledger: deps.ledger(sessionId),
        now,
        alreadySaved: deps.alreadySaved(sessionId),
        saving: deps.saving(sessionId),
      })
      if (decision.action === 'stand_down') {
        // A save the phone (or anyone) already made is the phone's save, not ours.
        deps.update(sessionId, decision.reason === 'already_saved'
          ? { state: 'saved', savedBy: intent.savedBy ?? 'phone', savedAt: intent.savedAt ?? now }
          : { state: 'stood_down', reason: decision.reason })
        deps.log('stood_down', { sessionId, reason: decision.reason, trigger, waitedMs: now - intent.receivedAt })
        return decision
      }
      if (decision.action === 'revoke') {
        deps.update(sessionId, { state: 'revoked', reason: decision.reason })
        deps.log('revoked', { sessionId, reason: decision.reason, finalChunkIndex: intent.finalChunkIndex, maxChunkIndex: decision.maxChunkIndex, trigger })
        return decision
      }
      if (decision.action === 'wait') {
        const last = intent.lastWait
        // One line per change of state, not one per poll.
        if (!last || last.reason !== decision.reason || last.missingCount !== decision.missingCount) {
          deps.update(sessionId, { lastWait: { reason: decision.reason, missingCount: decision.missingCount, missingSample: decision.missing, at: now } })
          deps.log('waiting', { sessionId, reason: decision.reason, missingCount: decision.missingCount, missingSample: decision.missing, finalChunkIndex: intent.finalChunkIndex, trigger })
        }
        return decision
      }
      const outcome = await deps.save(intent)
      const at = deps.now()
      if (outcome.ok) {
        deps.update(sessionId, {
          state: 'saved', savedBy: 'server', savedAt: at,
          filename: outcome.filename, sidecarPath: outcome.sidecarPath,
          chunkCount: outcome.chunkCount, canonicalCount: outcome.canonicalCount, lastWait: null,
        })
        deps.log('finalized', {
          sessionId, reason: 'stop_received_complete', trigger,
          finalChunkIndex: intent.finalChunkIndex, chunks: outcome.chunkCount, canonical: outcome.canonicalCount,
          gaps: outcome.missingIndices.length, filename: outcome.filename,
          waitedMs: at - intent.receivedAt, phoneConfirmed: false,
        })
        return decision
      }
      // The phone saved between the decision and the lock: its save, not ours.
      if (outcome.reason === 'already_saved') {
        deps.update(sessionId, { state: 'saved', savedBy: 'phone', savedAt: at, lastWait: null })
        deps.log('stood_down', { sessionId, reason: 'already_saved', trigger, waitedMs: at - intent.receivedAt })
        return { action: 'stand_down', reason: 'already_saved' }
      }
      // The phone pinned another server instance: this Mac is not where it meant to save.
      if (outcome.reason === 'server_instance_mismatch') {
        deps.update(sessionId, { state: 'stood_down', reason: outcome.reason })
        deps.log('stood_down', { sessionId, reason: outcome.reason, trigger })
        return { action: 'stand_down', reason: 'server_instance_mismatch' }
      }
      // The phone's own save holds the lock: it wins, and the next check reads its receipt.
      if (outcome.status === 409 && outcome.reason === 'save_in_progress') {
        return { action: 'wait', reason: 'saving', missing: [], missingCount: 0, retryInMs: AUTONOMOUS_FINALIZE_POLL_MS }
      }
      // Nothing to save (every chunk was silence): the phone's own Stop says so on the lens.
      if (outcome.status === 404) {
        deps.update(sessionId, { state: 'stood_down', reason: outcome.reason })
        deps.log('stood_down', { sessionId, reason: outcome.reason, trigger })
        return { action: 'stand_down', reason: 'nothing_captured' }
      }
      deps.log('finalize_failed', { sessionId, status: outcome.status, reason: outcome.reason, trigger })
      return { action: 'wait', reason: 'saving', missing: [], missingCount: 0, retryInMs: AUTONOMOUS_FINALIZE_POLL_MS }
    } catch (error) {
      deps.log('finalize_failed', { sessionId, status: 500, reason: error instanceof Error ? error.message.slice(0, 200) : 'error', trigger })
      return null
    } finally {
      inFlight.delete(sessionId)
    }
  }

  const finalizer: AutonomousFinalizer = {
    check,
    async tick(trigger = 'poll') {
      let soonest = Infinity
      for (const intent of deps.waiting()) {
        const decision = await check(intent.sessionId, trigger)
        if (decision?.action === 'wait') soonest = Math.min(soonest, decision.retryInMs)
        else if (decision === null && deps.get(intent.sessionId)?.state === 'waiting') soonest = Math.min(soonest, AUTONOMOUS_FINALIZE_POLL_MS)
      }
      if (Number.isFinite(soonest)) arm(soonest)
    },
    arm,
  }
  return finalizer
}
