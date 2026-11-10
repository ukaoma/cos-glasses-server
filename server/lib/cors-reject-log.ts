/**
 * Log a rejected CORS origin (S1, 2026-11-09).
 *
 * The scan of 10/26 to 11/09 found 22 "Error: CORS blocked" lines with nothing else, so no one
 * could tell a COS client bug from a probe. This logs the ORIGIN only (an Origin header is a
 * scheme, host and port; never a header dump, cookie or token), once per origin per hour, with a
 * running count, and caps how many distinct origins it remembers so a scanner cannot grow it.
 */
const ONE_HOUR_MS = 60 * 60_000
export const CORS_REJECT_ORIGIN_CAP = 200
const seen = new Map<string, { count: number; lastLoggedAt: number }>()
let overflow = 0

/** An origin made safe for one log line: printable ASCII, no spaces, at most 200 characters. */
export function sanitizeOrigin(origin: string): string {
  const clean = origin.replace(/[^\x21-\x7e]/g, '?')
  return clean.length > 200 ? `${clean.slice(0, 200)}…(${clean.length} chars)` : clean
}

export type CorsRejectReason = 'not_allowed' | 'check_failed'

export function noteCorsRejection(
  origin: string,
  reason: CorsRejectReason,
  now = Date.now(),
  log: (line: string) => void = line => console.warn(line),
): boolean {
  const key = sanitizeOrigin(origin)
  let entry = seen.get(key)
  if (!entry) {
    if (seen.size >= CORS_REJECT_ORIGIN_CAP) {
      overflow++
      if (overflow === 1 || overflow % 100 === 0) {
        log(`[cors] blocked ${overflow} request(s) from origins beyond the first ${CORS_REJECT_ORIGIN_CAP} distinct ones (not listed)`)
      }
      return false
    }
    entry = { count: 0, lastLoggedAt: 0 }
    seen.set(key, entry)
  }
  entry.count++
  if (entry.lastLoggedAt && now - entry.lastLoggedAt < ONE_HOUR_MS) return false
  entry.lastLoggedAt = now
  log(`[cors] blocked origin=${key} reason=${reason} (${entry.count} from this origin since boot)`)
  return true
}

export function __resetCorsRejectLogForTests(): void {
  seen.clear()
  overflow = 0
}
