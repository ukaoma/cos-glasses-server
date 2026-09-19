// Phase 1: a Continue turn's own stdout, teed onto the session stream.
//
// `buildClaudeAttachedArgs` already spawns with `--output-format stream-json
// --verbose`, and `attached-provider-adapter.ts` already holds that stdout. It reads
// it for one purpose — proving the returned session id matches the target — and
// discards everything else. This module is the second reader.
//
// THE ID SCAN IS UNTOUCHABLE. It is what aborts a turn whose child cannot be
// identified, and it is mutation-tested. So the tee is wired as a SEPARATE `data`
// listener, registered AFTER the scanner, holding no state the scanner can see, and
// wrapped so it cannot throw into `emit()`. The scanner therefore runs first on every
// chunk and its behaviour is unchanged whether or not this module exists. When no
// observer is supplied the adapter registers no second listener at all, which is the
// path every existing test already exercises.
//
// This module owns line assembly and publication. It does NOT own the grammar (that
// is `session-stream-events.ts`, pure) or the transport (that is the SSE route).

import {
  draftsFromLine,
  type SessionStreamDraft,
  type SessionStreamProvider,
} from './session-stream-events.js'
import { beginAttachedTurn, publishSessionStream, sessionStreamKey } from './session-stream-bus.js'
import { releaseAfterTranscriptCatchUp } from './session-transcript-watcher.js'

/**
 * Ceiling on the incomplete trailing line held between chunks.
 *
 * A provider emitting one enormous line must not grow this without bound. Mirrors the
 * 1 MB carry cap the adapter's own scanner already applies to the same stream, so the
 * two readers cannot disagree about what is pathological.
 */
export const MAX_LINE_CARRY_CHARS = 1_000_000

export interface LineAssembler {
  /** Complete lines contained in everything pushed so far. */
  push(chunk: string): string[]
  /** The trailing partial line, if a caller wants it at end of stream. */
  flush(): string[]
}

/**
 * Split a byte stream into lines across chunk boundaries.
 *
 * Separate from the adapter's identical-looking logic on purpose: sharing it would
 * mean the tee and the id scanner touch one piece of mutable state, which is exactly
 * the coupling that would let a tee bug reach the scan.
 */
export function createLineAssembler(maxCarry: number = MAX_LINE_CARRY_CHARS): LineAssembler {
  let carry = ''
  return {
    push(chunk: string): string[] {
      if (typeof chunk !== 'string' || chunk.length === 0) return []
      carry += chunk
      const parts = carry.split('\n')
      carry = parts.pop() ?? ''
      if (carry.length > maxCarry) carry = ''
      return parts
    },
    flush(): string[] {
      const rest = carry
      carry = ''
      return rest.trim().length > 0 ? [rest] : []
    },
  }
}

export interface AttachedTurnStream {
  /** Wire this as the adapter's `observeStdout`. Never throws. */
  observeStdout(chunk: string): void
  /**
   * Call exactly once when the turn settles, whatever its outcome. Never throws.
   *
   * The terminal status is published before this returns. The hold-off lifts once the
   * session's transcript watcher is at end of file (6.52.0 QA round 2): at once when no
   * watcher tails the session, within `CATCH_UP_TIMEOUT_MS` otherwise. The promise
   * settles then and never rejects; callers need not await it.
   */
  finish(outcome: 'done' | 'idle'): Promise<void>
}

export interface AttachedTurnStreamOptions {
  provider: SessionStreamProvider
  sessionId: string
  /** Injected for tests. Production uses the module bus. */
  publish?: (key: string, draft: SessionStreamDraft) => void
}

/**
 * Open a stream for one attached turn.
 *
 * Publishes `status: working` immediately, so a client that subscribes mid-turn is not
 * left guessing, then one event per grammar-recognised stdout record, then exactly one
 * terminal `status` on `finish`.
 *
 * `finish` is idempotent and MUST be called on every exit path including failure. It
 * is what lifts the duplicate-suppression gate; leaving it held would make the session
 * permanently silent for Phase 2, which is a far worse failure than a duplicated line.
 */
export function createAttachedTurnStream(options: AttachedTurnStreamOptions): AttachedTurnStream {
  const key = sessionStreamKey(options.provider, options.sessionId)
  const publish = options.publish ?? ((k, draft) => { publishSessionStream(k, draft) })
  const assembler = createLineAssembler()
  const endTurn = beginAttachedTurn(key)
  let finished = false
  let released: Promise<void> = Promise.resolve()

  const emit = (draft: SessionStreamDraft) => {
    try {
      publish(key, draft)
    } catch {
      /* publication is observation; it never affects the turn that produced it */
    }
  }

  emit({ kind: 'status', state: 'working' })

  return {
    observeStdout(chunk: string): void {
      try {
        for (const line of assembler.push(chunk)) {
          for (const draft of draftsFromLine(options.provider, line)) emit(draft)
        }
      } catch {
        /* a malformed chunk costs its own events and nothing else */
      }
    },
    finish(outcome: 'done' | 'idle'): Promise<void> {
      if (finished) return released
      finished = true
      try {
        for (const line of assembler.flush()) {
          for (const draft of draftsFromLine(options.provider, line)) emit(draft)
        }
      } catch {
        /* fall through: the terminal status and the gate release matter more */
      }
      emit({ kind: 'status', state: outcome })
      // NOT released here. The CLI wrote this turn's records to the transcript as well,
      // and the watcher reads the hold-off only when it reads: released now, its next
      // check would show the last lines again and put `working` after this `done`
      // (6.52.0 QA round 2). The watcher module brings every watcher on this session to
      // end of file while the hold still applies, then releases, within a bound.
      try {
        released = releaseAfterTranscriptCatchUp(key, endTurn)
      } catch {
        try {
          endTurn()
        } catch {
          /* the gate is a Map delete; there is no failure mode to report */
        }
      }
      return released
    },
  }
}
