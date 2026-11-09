/**
 * 7.0.4 QA, shared in 7.0.7: the one burst limit for preview refusal and failure logs. The 7.0.4 file and image routes
 * (routes/agent-sessions.ts logPreviewOutcome) and the 7.0.5 preview engine routes (routes/session-preview.ts
 * logPreviewRefusal) both log through it. The same line logs once per 10 seconds, with the count it held back. A line is
 * only fixed words (a route, a reason code, a provider, a part, a kind, a detail code), so the keys stay few.
 */
const lastLogged = new Map<string, { at: number; quiet: number }>()
export const PREVIEW_LOG_WINDOW_MS = 10_000

export function warnPreviewThrottled(key: string, line: string, now = Date.now()): void {
  const last = lastLogged.get(key)
  if (last && now - last.at < PREVIEW_LOG_WINDOW_MS) { last.quiet++; return }
  lastLogged.set(key, { at: now, quiet: 0 })
  console.warn(`${line}${last?.quiet ? ` (+${last.quiet} like it)` : ''}`)
}

/** Tests only: forget the burst window, so each case logs. */
export function resetPreviewLogThrottle(): void { lastLogged.clear() }
