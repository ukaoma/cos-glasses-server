/**
 * 6.59.0: one board read shared by the glasses' Work routes, bounded in time.
 *
 * The board comes from the COS task bridge, one process per domain, and can take several seconds (QA measured about
 * 12 s with four domains). The glasses give up on a request after about 8 to 10 s, so the activity, open-work and
 * handoff-request routes wait at most `timeoutMs` (5 s) and then answer without the board (503 for a request, which
 * then creates nothing). A read that outlives its caller keeps running and fills the cache, so the next call is fast.
 * Concurrent callers share one read. GET /api/work-board keeps its own unbounded read (COS Control waits for it) and
 * primes this cache with what it read.
 */
export const WORK_BOARD_READ_LIMITS = { timeoutMs: 5_000, savedDestinationMs: 3_000 } as const

export class WorkBoardTimeoutError extends Error {
  constructor() { super('work_board_timeout') }
}

export interface WorkBoardReader<Row> {
  /** Rows no older than `maxAgeMs`, from the cache, a read already running, or a new read; rejects after `timeoutMs`. */
  read(maxAgeMs: number, timeoutMs?: number): Promise<Row[]>
  /** Keep rows another reader just read (GET /api/work-board). */
  prime(rows: Row[], readStartedAt: number): void
}

export function createWorkBoardReader<Row>(list: () => Promise<Row[]>, options: { timeoutMs?: number; now?: () => number } = {}): WorkBoardReader<Row> {
  const defaultTimeoutMs = options.timeoutMs ?? WORK_BOARD_READ_LIMITS.timeoutMs, now = options.now ?? Date.now
  let cache: { at: number; rows: Row[] } | undefined
  let inflight: { at: number; promise: Promise<Row[]> } | undefined
  const keep = (rows: Row[], at: number) => { if (!cache || at >= cache.at) cache = { at, rows } }
  return {
    read(maxAgeMs, timeoutMs = defaultTimeoutMs) {
      const started = now()
      if (cache && started - cache.at <= maxAgeMs) return Promise.resolve(cache.rows)
      if (!inflight || started - inflight.at > maxAgeMs) {
        const at = started
        const promise = Promise.resolve().then(list).then(rows => { keep(rows, at); return rows })
        inflight = { at, promise }
        promise.catch(() => {}).finally(() => { if (inflight?.promise === promise) inflight = undefined })
      }
      const running = inflight.promise
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WorkBoardTimeoutError()), timeoutMs) })
      return Promise.race([running, bound]).finally(() => clearTimeout(timer))
    },
    prime(rows, readStartedAt) { keep(rows, readStartedAt) },
  }
}
