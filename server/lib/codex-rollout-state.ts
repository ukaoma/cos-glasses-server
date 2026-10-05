// What a Codex rollout's tail says about the thread RIGHT NOW (6.62.0, plan 1.3 and 1.9), for
// the session rows: is a turn open, and when did the newest context compaction finish.
//
// A DISPLAY HINT ONLY. The write gate keeps its own reading (`codex-turn-clock.ts`, the
// occupancy probe); nothing here can let a Continue through or hold one back.
//
// The turn rule is the queue's (`transcriptTurnVerdict` / `turnFromTail('codex')`): a
// `task_started` opens a turn, `task_complete` / `turn_complete` / `turn_aborted` close it.
// It reads the last 512 KiB synchronously, so it is MEMOIZED on (path, mtime, size): a steady
// list poll re-reads nothing, and only a rollout that changed is read again. A rollout not
// written inside the hook-active cap is never read at all: whatever its tail says, it is not
// working now (the cap decides), and a cold list stays free.

import { statSync } from 'node:fs'
import { turnFromTail, type TurnFromTail } from './session-stream-events.js'
import { TURN_END_TAIL_BYTES, readTranscriptTailLines } from './thread-turn-queue-store.js'

/** Hook or transcript evidence counts as "working" for this long after the last event (plan 1.1-1.3, W5). */
export const HOOK_ACTIVE_CAP_MS = 5 * 60_000

export interface CodexRolloutFacts {
  /** The tail's verdict; null when the tail was not read (cold) or could not be. */
  reason: TurnFromTail['reason'] | null
  /** A turn is open in the tail AND the file was written inside the cap. */
  open: boolean
  mtimeMs: number
  /** When the newest `ContextCompaction` item completed, from the tail; null when none is there. */
  compactedAt: number | null
}

const MEMO_MAX = 256
const memo = new Map<string, { mtimeMs: number; size: number; reason: TurnFromTail['reason'] | null; compactedAt: number | null }>()
let reads = 0

/**
 * The newest completed context compaction in a tail. Codex writes the `ContextCompaction` item
 * (and its `compacted` replacement) only when a compaction is OVER: nothing in a rollout marks
 * one starting, so this can close a compaction the PreCompact hook opened, never open one.
 */
export function newestCompactionAt(lines: readonly string[]): number | null {
  let newest: number | null = null
  for (const line of lines) {
    if (!line.includes('ContextCompaction')) continue
    let record: Record<string, unknown>
    try { record = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const payload = record.payload as Record<string, unknown> | undefined
    const item = payload?.item as Record<string, unknown> | undefined
    if (record.type !== 'event_msg' || payload?.type !== 'item_completed' || item?.type !== 'ContextCompaction') continue
    const at = typeof payload.completed_at_ms === 'number' ? payload.completed_at_ms : Date.parse(String(record.timestamp))
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at
  }
  return newest
}

export function codexRolloutFacts(path: string | null | undefined, now = Date.now()): CodexRolloutFacts | null {
  if (!path) return null
  let mtimeMs: number
  let size: number
  try {
    const st = statSync(path)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  const fresh = now - mtimeMs <= HOOK_ACTIVE_CAP_MS
  if (!fresh) return { reason: null, open: false, mtimeMs, compactedAt: null }
  let hit = memo.get(path)
  if (!hit || hit.mtimeMs !== mtimeMs || hit.size !== size) {
    const lines = readTranscriptTailLines(path, TURN_END_TAIL_BYTES)
    reads++
    hit = { mtimeMs, size, reason: lines === null ? null : turnFromTail('codex', lines).reason, compactedAt: lines === null ? null : newestCompactionAt(lines) }
    memo.delete(path)
    if (memo.size >= MEMO_MAX) {
      const oldest = memo.keys().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    memo.set(path, hit)
  }
  return { reason: hit.reason, open: hit.reason === 'prompt_open', mtimeMs, compactedAt: hit.compactedAt }
}

/** Test seams. */
export function __resetCodexRolloutStateForTests(): void {
  memo.clear()
  reads = 0
}
export function codexRolloutReads(): number {
  return reads
}
