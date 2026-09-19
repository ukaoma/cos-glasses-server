// When did the Codex engine close this thread's turn? (6.51.0)
//
// Read from the rollout itself, never from its mtime: the engine writes `task_complete`
// (or `turn_complete`) as the turn's last record and `task_started` as the next turn's
// first, so the NEWEST of those markers in the tail is the answer. The tail rule is the
// drain's own (`transcriptTurnVerdict`), so the gate and the drain cannot disagree about
// the same file.

import { statSync } from 'node:fs'
import { transcriptPathFor, type NativeHeadDeps } from './native-head.js'
import { transcriptTurnVerdict } from './thread-turn-queue-store.js'

/**
 * The rollout's mtime when its newest turn marker closed a turn; null on any doubt (no
 * rollout, an unreadable tail, a tail with no marker, or a turn that is open).
 */
export function readCodexTurnEndedAtMs(
  threadId: string,
  nativeHeadDeps: NativeHeadDeps,
  deps: {
    pathFor?: typeof transcriptPathFor
    verdict?: typeof transcriptTurnVerdict
    mtimeMs?: (path: string) => number | null
  } = {},
): number | null {
  try {
    const path = (deps.pathFor ?? transcriptPathFor)('codex', threadId, nativeHeadDeps)
    if (!path) return null
    const verdict = (deps.verdict ?? transcriptTurnVerdict)('codex', path)
    if (!verdict || verdict.ended !== true || verdict.reason !== 'codex_complete') return null
    const mtime = (deps.mtimeMs ?? ((p: string) => statSync(p).mtimeMs))(path)
    return typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : null
  } catch {
    return null
  }
}
