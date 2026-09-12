// 6.45.3 — "Recent" is a rolling window of the newest messages, not a calendar day.
//
// Miles, 2026-09-12: "The recent messages should just be a rolling count of 30,
// where, as messages age out of that top 30, they're no longer present in the
// recent tab. At any rate, we should never end up in a situation where messages
// are hidden." The old view was keyed on the local day, so at 07:00 the answer
// was empty while ten turns from the previous evening sat in the live store.
//
// The window is assembled from every live session (era-filtered) and then from
// archived days newest-first, only as many days as it takes to fill the window.
// Live copies and their archive mirrors are the same turn: dedup on
// `sessionId|timestamp`, the key the day view has used since the NTP-skew fix.

export interface RecentMessageCandidate {
  sessionId?: string
  timestamp: number
}

export const RECENT_MESSAGES_DEFAULT_LIMIT = 30
export const RECENT_MESSAGES_MAX_LIMIT = 100

export function recentMessagesLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n) || n < 1) return RECENT_MESSAGES_DEFAULT_LIMIT
  return Math.min(RECENT_MESSAGES_MAX_LIMIT, Math.floor(n))
}

/**
 * The newest `limit` messages, chronological (oldest first, like the day view).
 * `archiveDaysNewestFirst` is consulted lazily, one day at a time, and only
 * while the window is not yet full.
 */
export function selectRecentMessages<T extends RecentMessageCandidate>(
  live: T[],
  archiveDaysNewestFirst: Iterable<() => T[]>,
  limit: number,
): T[] {
  const seen = new Set<string>()
  const keyOf = (m: RecentMessageCandidate) => `${m.sessionId ?? ''}|${m.timestamp}`
  const candidates: T[] = []
  const take = (rows: T[]) => {
    for (const row of rows) {
      const key = keyOf(row)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(row)
    }
  }
  take(live)
  for (const readDay of archiveDaysNewestFirst) {
    if (candidates.length >= limit) break
    take(readDay())
  }
  candidates.sort((a, b) => a.timestamp - b.timestamp)
  return candidates.length > limit ? candidates.slice(candidates.length - limit) : candidates
}
