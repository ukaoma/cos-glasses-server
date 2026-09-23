// The thread-turn queue's two turn questions, `turnEnded` and `turnOpen` (6.53.3).
//
// Moved out of the composition root (index.ts) unchanged in shape, so the one rule that
// changed in 6.53.3 can be driven by a test against the real `drainDecision`: WHAT a
// cancel on the thread may conclude about a turn that still reads open depends on what the
// cancel was aimed at (review A1, `cancelVoidsOpenTurn` in session-cancel.ts).
//
//   cos_turn   COS killed its own child: nothing written since the cancel ends the turn.
//   desk_run   the run stops at its NEXT tool call, so the hooks' and the transcript's
//              open-turn evidence stands until the desk's own engine says the run is over
//              at or after the cancel (a Stop, StopFailure or SessionEnd, or the registry's
//              idle flip). Until 6.53.2 a desk run inside a long tool read "over" 30 s after
//              the cancel, and a parked follow-up was delivered live into it.
//
// Every read is injected; index.ts wires the real ones. Both answers refuse on doubt: a
// throw is `false` for each, which is what the composition root did before the move.

import { cancelVoidsOpenTurn, type ThreadCancel } from './session-cancel.js'

/** The hook signal fields these questions read (a `SessionSignal` satisfies it). */
export interface TurnEvidenceSignal {
  turnOpen: boolean
  lastEvent: string
  lastEventAt: number
  turnStartedAt: number | null
  stopAt: number | null
  subagentsOpen: number
}

/** The transcript tail's own verdict (`transcriptTurnVerdict`). */
export interface TurnEvidenceVerdict {
  ended: boolean
  reason?: string | null
}

export interface QueueTurnEvidenceDeps {
  /** The hooks' signal for a Claude session; undefined when the hooks are off or silent. */
  signalFor: (threadId: string) => TurnEvidenceSignal | undefined
  /** `registryIdleAfterStop`: true only when the live record flipped idle at or after `stopAt`. */
  registryIdleAfterStop: (threadId: string, stopAt: number) => boolean | null
  /** `deskTurnEndedAt`: when the desk session's engine said its run is over, as it stands now. */
  deskEndedAt: (threadId: string) => number | null
  /** The transcript's mtime, or null when unmeasurable. */
  transcriptMtimeMs: (provider: string, threadId: string) => number | null
  /** The transcript tail's verdict, or null when unreadable. */
  transcriptVerdict: (provider: string, threadId: string) => TurnEvidenceVerdict | null
  /** The cancel on record for the thread (`threadCancel`). */
  threadCancel: (provider: string, threadId: string) => ThreadCancel | null
  /** Past this age a signal or a tail is not evidence any more (OPEN_TURN_CEILING_MS). */
  openTurnCeilingMs: number
  now: () => number
}

export interface QueueTurnEvidence {
  turnEnded: (provider: string, threadId: string) => boolean
  turnOpen: (provider: string, threadId: string) => boolean
}

export function makeQueueTurnEvidence(deps: QueueTurnEvidenceDeps): QueueTurnEvidence {
  const mtime = (provider: string, threadId: string): number | null => {
    const value = deps.transcriptMtimeMs(provider, threadId)
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  /** Read once per question, and only when a cancel is on record (it scans the registry). */
  const deskEnded = (provider: string, threadId: string): (() => number | null) => {
    let cached: number | null | undefined
    return () => {
      if (cached === undefined) cached = provider === 'claude' ? deps.deskEndedAt(threadId) : null
      return cached
    }
  }

  const turnEnded = (provider: string, threadId: string): boolean => {
    if (provider !== 'claude' && provider !== 'codex') return false
    try {
      const signal = provider === 'claude' ? deps.signalFor(threadId) : undefined
      // 6.53.0: a cancel ends the turn when nothing was written since it (a killed COS
      // child leaves its last tool_use unanswered, and no Stop or terminal record follows).
      // 6.53.3: only a cos_turn cancel concludes that; a desk_run cancel needs the desk's
      // own end, stamped at or after the cancel.
      const cancel = deps.threadCancel(provider, threadId)
      if (cancel !== null && cancelVoidsOpenTurn({
        cancel,
        lastActivityAt: mtime(provider, threadId),
        turnStartedAt: signal?.turnStartedAt ?? null,
        deskEndedAt: deskEnded(provider, threadId)(),
      })) return true
      // 6.48.1: the engine's own end of turn: a Stop hook newer than the turn's prompt
      // AND the registry flipped idle after it (the Stop hooks have returned; a prompt
      // typed during them is queued and dequeues only then). The transcript tail
      // answers for everything the hooks did not see. Both refuse on doubt.
      if (provider === 'claude') {
        if (signal && !signal.turnOpen && signal.lastEvent === 'Stop' && typeof signal.stopAt === 'number'
          && signal.stopAt >= (signal.turnStartedAt ?? 0) && signal.subagentsOpen === 0
          && deps.registryIdleAfterStop(threadId, signal.stopAt) === true) return true
      }
      return deps.transcriptVerdict(provider, threadId)?.ended === true
    } catch {
      return false
    }
  }

  // 6.48.1: positive evidence the holder's turn is OPEN, which outranks the 30 s idle
  // backstop (a long tool leaves the transcript untouched while it runs). Bounded: a
  // signal or a tail older than the ceiling is not evidence any more, so a crashed
  // mid-tool session still drains by the backstop rather than holding for the TTL.
  const turnOpen = (provider: string, threadId: string): boolean => {
    if (provider !== 'claude' && provider !== 'codex') return false
    try {
      const now = deps.now()
      const cancel = deps.threadCancel(provider, threadId)
      const ended = deskEnded(provider, threadId)
      if (provider === 'claude') {
        const signal = deps.signalFor(threadId)
        if (signal && signal.turnOpen && now - signal.lastEventAt <= deps.openTurnCeilingMs
          && !(cancel !== null && cancelVoidsOpenTurn({
            cancel,
            lastActivityAt: signal.lastEventAt,
            turnStartedAt: signal.turnStartedAt,
            deskEndedAt: ended(),
          }))) return true
      }
      const verdict = deps.transcriptVerdict(provider, threadId)
      if (!verdict || verdict.ended) return false
      if (verdict.reason !== 'tool_pending' && verdict.reason !== 'prompt_open') return false
      const last = mtime(provider, threadId)
      // 6.53.0 / 6.53.3: a cos_turn cancel with nothing written since discounts a dangling
      // tool_use (the killed child's); a desk_run cancel only once the desk said it ended.
      if (cancel !== null && cancelVoidsOpenTurn({ cancel, lastActivityAt: last, turnStartedAt: null, deskEndedAt: ended() })) return false
      return last !== null && now - last <= deps.openTurnCeilingMs
    } catch {
      return false
    }
  }

  return { turnEnded, turnOpen }
}
