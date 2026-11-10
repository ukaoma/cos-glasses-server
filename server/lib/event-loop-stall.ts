/**
 * Event-loop stall detector (S1, 2026-11-09). Logs only when the server's event loop was blocked.
 *
 * Why: COS Control's dictation asks GET /api/transcribe/capabilities with a 5 s timeout. Six
 * dictations (11/03 13:01 CST, 11/04 15:32, and four between 18:12 and 18:32 on 11/04) failed at
 * 5,052 to 5,072 ms with no answer, logged by Control as "refused:unknown". That route is a
 * constant JSON object, so a 5 s silence means the process did not get to it: a blocked event
 * loop, a process mid-restart, or a Mac under memory pressure. Nothing in the server logs could
 * tell those apart. This line can:
 *
 *   [event-loop] stalled 6230 ms (rss 1840 MB, heap 910 MB; 1 stall(s) over 2000 ms since boot)
 *
 * A 500 ms unref'd timer measures its own lateness. A late tick above the threshold is one stall.
 * At most one line per 10 s; stalls in between are counted into the next line.
 */
export const STALL_SAMPLE_MS = 500
export const STALL_THRESHOLD_MS = 2_000
const LOG_EVERY_MS = 10_000

export interface StallMonitor {
  stop(): void
  stats(): { stalls: number; worstMs: number }
}

export function startEventLoopStallMonitor(options: {
  sampleMs?: number
  thresholdMs?: number
  now?: () => number
  log?: (line: string) => void
  memory?: () => { rss: number; heapUsed: number }
} = {}): StallMonitor {
  const sampleMs = options.sampleMs ?? STALL_SAMPLE_MS
  const thresholdMs = options.thresholdMs ?? STALL_THRESHOLD_MS
  const now = options.now ?? (() => performance.now())
  const log = options.log ?? (line => console.warn(line))
  const memory = options.memory ?? (() => process.memoryUsage())
  let last = now()
  let stalls = 0
  let worstMs = 0
  let lastLogAt = -Infinity
  let unlogged = 0
  const timer = setInterval(() => {
    const at = now()
    const lateMs = at - last - sampleMs
    last = at
    if (lateMs < thresholdMs) return
    stalls++
    worstMs = Math.max(worstMs, lateMs)
    if (at - lastLogAt < LOG_EVERY_MS) { unlogged++; return }
    lastLogAt = at
    const m = memory()
    const extra = unlogged ? `; ${unlogged} more since the last line` : ''
    unlogged = 0
    log(`[event-loop] stalled ${Math.round(lateMs)} ms (rss ${Math.round(m.rss / 1e6)} MB, heap ${Math.round(m.heapUsed / 1e6)} MB; `
      + `${stalls} stall(s) over ${thresholdMs} ms since boot${extra})`)
  }, sampleMs)
  timer.unref?.()
  return {
    stop: () => clearInterval(timer),
    stats: () => ({ stalls, worstMs: Math.round(worstMs) }),
  }
}
