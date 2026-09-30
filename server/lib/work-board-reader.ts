/**
 * 6.59.0: one board read shared by the glasses' Work routes, bounded in time.
 *
 * The board comes from the COS task bridge, one process per domain. It usually answers in about 0.1 s (88 to 101 ms
 * measured on 2026-09-30), but the bridge's own timeout is 12 s, and the glasses give up on a request after about 8 to
 * 10 s. So the activity, open-work and handoff-request routes wait at most `timeoutMs` (5 s) and then answer without
 * the board (503 for a request, which then creates nothing). A read that outlives its caller keeps running and fills
 * the cache, so the next call is fast. Concurrent callers share one read.
 *
 * The cache's age counts from the moment a read FINISHED, so a slow read is still served afterwards. A read that began
 * before the one already cached never replaces it, and `invalidate()` (after a Work stage or meeting write) drops the
 * cache and every read that began before it. GET /api/work-board keeps its own unbounded read (COS Control waits for
 * it) and primes this cache with what it read.
 */
export const WORK_BOARD_READ_LIMITS = { timeoutMs: 5_000, savedDestinationMs: 3_000 } as const

export class WorkBoardTimeoutError extends Error {
  constructor() { super('work_board_timeout') }
}

/** When a read began, and which invalidation it began after. */
export interface WorkBoardReadToken { startedAt: number; generation: number }
export interface WorkBoardReader<Row> {
  /** Rows whose read finished no more than `maxAgeMs` ago, a read already running, or a new read; rejects after `timeoutMs`. */
  read(maxAgeMs: number, timeoutMs?: number): Promise<Row[]>
  /** Mark the start of a read made elsewhere (GET /api/work-board), to hand to `prime`. */
  begin(): WorkBoardReadToken
  /** Keep the rows of a read made elsewhere. */
  prime(rows: Row[], token: WorkBoardReadToken): void
  /** The board was just written: nothing read before now may be served. */
  invalidate(): void
}

export function createWorkBoardReader<Row>(list: () => Promise<Row[]>, options: { timeoutMs?: number; now?: () => number } = {}): WorkBoardReader<Row> {
  const defaultTimeoutMs = options.timeoutMs ?? WORK_BOARD_READ_LIMITS.timeoutMs, now = options.now ?? Date.now
  let generation = 0
  let cache: { startedAt: number; endedAt: number; rows: Row[] } | undefined
  let inflight: { generation: number; promise: Promise<Row[]> } | undefined
  const keep = (rows: Row[], token: WorkBoardReadToken) => {
    if (token.generation !== generation) return           // it began before a write: it may show the board as it was
    if (cache && token.startedAt < cache.startedAt) return  // a newer read is already cached
    cache = { startedAt: token.startedAt, endedAt: now(), rows }
  }
  return {
    read(maxAgeMs, timeoutMs = defaultTimeoutMs) {
      const at = now()
      if (cache && at - cache.endedAt <= maxAgeMs) return Promise.resolve(cache.rows)
      if (!inflight || inflight.generation !== generation) {
        const token = { startedAt: at, generation }
        const promise = Promise.resolve().then(list).then(rows => { keep(rows, token); return rows })
        inflight = { generation, promise }
        promise.catch(() => {}).finally(() => { if (inflight?.promise === promise) inflight = undefined })
      }
      const running = inflight.promise
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WorkBoardTimeoutError()), timeoutMs) })
      return Promise.race([running, bound]).finally(() => clearTimeout(timer))
    },
    begin() { return { startedAt: now(), generation } },
    prime(rows, token) { keep(rows, token) },
    invalidate() { generation++; cache = undefined },
  }
}
