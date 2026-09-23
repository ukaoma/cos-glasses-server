// Cancel a session run from the lens (6.53.0): the decisions, the copy, the ledger, and
// the per-thread cancel time the turn queue reads.
//
// Miles, 2026-09-21: "a cancel button ... If there's a current run that's going, it
// essentially clicks the cancel button ... similar to when they're at the desktop."
//
// WHO OWNS THE RUN DECIDES WHAT A CANCEL CAN DO (plan PLAN_g2_cancel_run_529_653):
//   cos_turn     a Continue COS itself spawned (`claude -p --resume`, `codex exec resume`,
//                `cursor-agent`). The route aborts its own child: immediate, every provider.
//   desk_run     Claude Code at the desk (a Desktop tab, a terminal, a Continue delivered
//                live into the open window). A halt marker plus the synchronous PreToolUse
//                hook stops it at its NEXT tool call (canaries C1b, C5, C10).
//   unsupported  the Codex app or Cursor. Nothing outside the app can reach the run.
//   hooks_*      a desk Claude run on a Mac whose hooks cannot stop it yet.
//
// `cancelTargetFor` is the ONE function that decides, and both the cancel route and the
// attachability body's `cancel` field call it, so the row the lens shows and the answer
// the tap gets cannot disagree (plan validation B4).

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './data-dir.js'

export type CancelTarget = 'cos_turn' | 'desk_run' | 'unsupported' | 'hooks_outdated' | 'hooks_disabled'

export interface CancelFacts {
  provider: string
  /** A COS turn is in flight on this thread (the route's own in-flight map). */
  cosTurnInFlight: boolean
  /** A run outside COS is working on this thread right now. */
  runningOutsideCos: boolean
  /** `sessionHooksEnabled()`: the hook signal store is applied at all. */
  hooksEnabled: boolean
  /** The hooks installed on this Mac carry the 6.53.0 script and subscription. */
  hooksReady: boolean
}

/**
 * PURE, and the precedence is the point:
 *   1. COS's own turn first. It is the one run COS can end at once, and a marker would
 *      also stop it only at its next tool (R3), so aborting the child is always better.
 *   2. Nothing running: null. The lens shows no row at all.
 *   3. Codex and Cursor cannot be stopped from outside their app.
 *   4. A desk Claude run needs the hooks applied AND the new script installed; either
 *      missing is its own answer, because the fixes differ (a setting vs Install hooks).
 */
export function cancelTargetFor(facts: CancelFacts): CancelTarget | null {
  if (facts.cosTurnInFlight === true) return 'cos_turn'
  if (facts.runningOutsideCos !== true) return null
  if (facts.provider !== 'claude') return 'unsupported'
  if (facts.hooksEnabled !== true) return 'hooks_disabled'
  if (facts.hooksReady !== true) return 'hooks_outdated'
  return 'desk_run'
}

/**
 * `/api/health` `features.sessionCancel` (6.53.0). `cosTurn` is true in every 6.53 build: the
 * route aborts its own child. `deskClaude` says whether a desk Claude run can be stopped
 * NOW: the hooks applied AND the 6.53 script and subscription installed. False until
 * Install hooks after the update, which is the rollout step Control's banner asks for.
 */
export function sessionCancelFeature(hooksEnabled: boolean, hooksInstalled: boolean): { cosTurn: true; deskClaude: boolean } {
  return { cosTurn: true, deskClaude: hooksEnabled === true && hooksInstalled === true }
}

/** Refusal codes on the cancel route, with the lens's own words (app 6.9.529 matches). */
export type CancelRefusal = 'not_running' | 'cancel_unsupported' | 'hooks_outdated' | 'hooks_disabled' | 'cancel_failed' | 'invalid_request'

export const CANCEL_REASON_COPY: Record<Exclude<CancelRefusal, 'cancel_unsupported'>, string> = {
  not_running: 'Nothing running now.',
  hooks_outdated: 'Install hooks in COS Control, then retry.',
  hooks_disabled: 'Session hooks are off on the Mac.',
  cancel_failed: 'Could not cancel. Check the Mac.',
  invalid_request: 'That cancel was not something COS could read. Nothing was stopped.',
}

/** Where an unsupported run lives, named so the user knows where to stop it. */
export function cancelUnsupportedCopy(provider: string): string {
  if (provider === 'codex') return 'Runs in Codex on your Mac. Stop it there.'
  if (provider === 'cursor') return 'Runs in Cursor on your Mac. Stop it there.'
  return 'Runs on your Mac. Stop it there.'
}

export function cancelRefusalCopy(reason: CancelRefusal, provider: string): string {
  return reason === 'cancel_unsupported' ? cancelUnsupportedCopy(provider) : CANCEL_REASON_COPY[reason]
}

/** Client-supplied idempotency key for one tap. The app mints `cc<time><random>`. */
export const CLIENT_CANCEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/

// ---------------------------------------------------------------------------
// The queue hold (plan validation: "Parked turns hold for 2 minutes after a cancel")
// ---------------------------------------------------------------------------

/**
 * How long turns parked on a thread wait after a cancel before they send as normal. The
 * person just said stop; a queued follow-up firing a second later would start the run
 * they stopped all over again. Two minutes is long enough to decide, short enough that
 * a turn they still want is not lost, and the lens says how many are held.
 */
export const CANCEL_QUEUE_HOLD_MS = 2 * 60_000

/** Past this a cancel time can no longer change a decision (the open-turn ceiling is 30 min). */
export const CANCEL_MEMORY_MS = 60 * 60_000
const MAX_REMEMBERED_CANCELS = 256

/**
 * One cancel on record for a thread (6.53.3): WHEN, and WHAT it was aimed at. The target
 * decides what the cancel may conclude about a turn that still reads open (see
 * `cancelVoidsOpenTurn`). Null is an older caller that did not say; it is read as a desk
 * run, the reading that concludes the least.
 */
export interface ThreadCancel {
  at: number
  target: CancelTarget | null
}

// In memory on purpose: every reader is a hold of minutes, and a restart that forgets
// one lets the queue drain by the gate's ordinary rules, which is the pre-6.53 behaviour.
const cancelsByThread = new Map<string, ThreadCancel>()
const cancelKey = (provider: string, threadId: string) => `${provider}:${threadId.toLowerCase()}`

export function noteThreadCancelled(provider: string, threadId: string, at: number, target: CancelTarget | null = null): void {
  if (!Number.isFinite(at)) return
  const key = cancelKey(provider, threadId)
  cancelsByThread.delete(key)
  cancelsByThread.set(key, { at, target })
  if (cancelsByThread.size > MAX_REMEMBERED_CANCELS) {
    for (const [k, when] of cancelsByThread) {
      if (at - when.at > CANCEL_MEMORY_MS) cancelsByThread.delete(k)
    }
    while (cancelsByThread.size > MAX_REMEMBERED_CANCELS) {
      const oldest = cancelsByThread.keys().next()
      if (oldest.done) break
      cancelsByThread.delete(oldest.value)
    }
  }
}

export function threadCancelledAt(provider: string, threadId: string): number | null {
  return cancelsByThread.get(cancelKey(provider, threadId))?.at ?? null
}

/** 6.53.3: the cancel on record for the thread, with its target; null when none. A copy. */
export function threadCancel(provider: string, threadId: string): ThreadCancel | null {
  const found = cancelsByThread.get(cancelKey(provider, threadId))
  return found ? { at: found.at, target: found.target } : null
}

/** Until when the thread's parked turns hold, or null when no cancel is on record. */
export function cancelHoldUntil(provider: string, threadId: string): number | null {
  const at = threadCancelledAt(provider, threadId)
  return at === null ? null : at + CANCEL_QUEUE_HOLD_MS
}

/**
 * Does a cancel END the turn the transcript or the hooks still show open?
 *
 * Yes when the cancel is at least as new as the session's last row (or event): nothing
 * has happened since the stop, so a dangling `tool_use` is the killed child's, not a live
 * tool. Without this a cancelled COS turn's unanswered tool call reads `tool_pending` for
 * the whole 30-minute open-turn ceiling and holds every parked turn behind it (plan R1).
 * Anything written AFTER the cancel is live evidence again, and the ordinary rules decide.
 */
export function cancelEndsTurn(cancelledAt: number | null, lastRowAt: number | null): boolean {
  if (cancelledAt === null || !Number.isFinite(cancelledAt)) return false
  if (lastRowAt === null || !Number.isFinite(lastRowAt)) return true
  return cancelledAt >= lastRowAt
}

/** What `cancelVoidsOpenTurn` weighs for one piece of open-turn evidence. */
export interface OpenTurnEvidence {
  /** The cancel on record for the thread (`threadCancel`), or null. */
  cancel: ThreadCancel | null
  /** When the evidence was last written: the hook's newest event, or the transcript mtime. */
  lastActivityAt: number | null
  /** When the turn the evidence belongs to STARTED (the hook's UserPromptSubmit); null when unknown. */
  turnStartedAt: number | null
  /**
   * When the desk session's own engine said the run is over, as it stands NOW: the
   * registry's `idle` flip (`statusUpdatedAt`), or the hooks' Stop / StopFailure /
   * SessionEnd while no turn is open. Null when nothing says so.
   */
  deskEndedAt: number | null
}

/**
 * 6.53.3 (review A1): may the cancel on record discount evidence that the thread's turn
 * is still OPEN?
 *
 *   cos_turn   COS killed its own child. Nothing written since the cancel means the turn
 *              is over: the dangling `tool_use` is the dead child's (6.53.0, `cancelEndsTurn`).
 *   desk_run   A halt marker stops a desk run only at its NEXT tool call, so a run inside a
 *              long tool writes nothing for minutes and is still running. Silence proves
 *              nothing here. Only the engine's own end, stamped at or after the cancel and
 *              after the turn began, closes it. Until 6.53.2 the cos_turn rule applied to
 *              both, and a turn parked behind a cancelled desk run was delivered live into
 *              the run the person had just stopped (and its UserPromptSubmit then deleted
 *              the marker, so the cancel was lost).
 *   null       An older caller that did not say: read as desk_run, which concludes least.
 */
export function cancelVoidsOpenTurn(evidence: OpenTurnEvidence): boolean {
  const { cancel } = evidence
  if (cancel === null || !Number.isFinite(cancel.at)) return false
  if (cancel.target === 'cos_turn') return cancelEndsTurn(cancel.at, evidence.lastActivityAt)
  const ended = evidence.deskEndedAt
  if (ended === null || !Number.isFinite(ended) || ended < cancel.at) return false
  const started = evidence.turnStartedAt
  return started === null || !Number.isFinite(started) || ended >= started
}

export function __resetThreadCancelsForTests(): void {
  cancelsByThread.clear()
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface SessionCancelLedgerRow {
  at: string
  provider: string
  threadId: string
  /** What the cancel was aimed at, or null when nothing was running. */
  target: CancelTarget | null
  /** `accepted`, or the refusal code. */
  outcome: 'accepted' | CancelRefusal
  clientCancelId: string
}

export function sessionCancelLedgerPath(): string {
  return dataPath('session-cancel.jsonl')
}

/**
 * One line per cancel, appended (O_APPEND: a line either lands whole or not at all, as the
 * other jsonl ledgers here). A failed write is logged and dropped: a ledger must never turn
 * a cancel that worked into an error.
 */
export function appendSessionCancelLedger(row: SessionCancelLedgerRow, path = sessionCancelLedgerPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  } catch (error) {
    console.warn(`[session-cancel] ledger write skipped: ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : error}`)
  }
}
