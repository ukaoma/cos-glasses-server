// 6.97.0: how far a Codex thread's rollout has been written, for the audit only. Codex's usage is a
// running total for the thread, so charging a resumed turn the difference is only honest if nothing
// else ran on the thread since. The rollout's size is the one thing that shows a desktop run.
//
// Any write moves it, including ones that are not a turn. That direction is safe: the row stays estimated.
import { statSync } from 'node:fs'
import { realNativeHeadDeps, transcriptPathFor, type NativeHeadDeps } from './native-head.js'
import { registerCodexRolloutProbe } from './provider-usage.js'

/** A located rollout stays put, so a turn start costs one stat, not a walk of the sessions tree. */
const rolloutPaths = new Map<string, string>()
const ROLLOUT_PATHS_MAX = 512

/** Bytes written so far, or null for UNKNOWN: no rollout found, or it moved or was compressed. Never throws. */
export function codexRolloutSize(threadId: string, deps?: NativeHeadDeps): number | null {
  try {
    const known = rolloutPaths.get(threadId)
    if (known) {
      try {
        return statSync(known).size
      } catch {
        rolloutPaths.delete(threadId)
      }
    }
    const path = transcriptPathFor('codex', threadId, deps ?? realNativeHeadDeps())
    if (!path) return null
    rolloutPaths.set(threadId, path)
    if (rolloutPaths.size > ROLLOUT_PATHS_MAX) rolloutPaths.delete(rolloutPaths.keys().next().value!)
    return statSync(path).size
  } catch {
    return null
  }
}

/** Called once at boot, in production only. */
export function installCodexRolloutProbe(): void {
  registerCodexRolloutProbe(threadId => codexRolloutSize(threadId))
}

export function _resetCodexRolloutPathsForTest(): void {
  rolloutPaths.clear()
}
