/**
 * A provider's own words for why it refused a turn. The ONE copy of these patterns:
 * provider proof, the lens gist (via provider-proof), fork classification and the
 * query-job error code all read them, so a usage limit is named the same everywhere.
 * 6.62.1 moved them here so low-level modules can import them without the proof's
 * process machinery. Leaf module: no imports.
 */
export const PROVIDER_QUOTA_RE = /usage[ _]limit|hit your (?:usage |session )?limit|session limit|rate.?limit|too many requests|\b429\b|\bquota\b|resets? (?:at|in) |over capacity|overloaded|\b529\b|plan limit/i
export const PROVIDER_AUTH_RE = /not logged in|please (?:log ?in|sign in)|invalid api key|authentication|unauthori[sz]ed|\b401\b|\b403\b|login required|token (?:has )?expired|no credentials/i
export const PROVIDER_OVERFLOW_RE = /prompt is too long|context window|too many tokens|exceeds the (?:model|context)/i

/** Codes a provider bridge raises when it has nothing better to say. Only these are upgraded. */
const GENERIC_CODES = new Set(['query_job_failed', 'claude.error', 'codex.error', 'cursor.error', 'provider_exit_nonzero'])

/**
 * A generic failure whose message carries the provider's reason gets a code a client
 * can act on: Work showed "claude.error / query_job_failed" for "You've hit your
 * session limit · resets 4pm" on 2026-10-05, so it offered the same exhausted provider.
 */
export function providerFailureCode(code: string, message: string): string {
  if (!GENERIC_CODES.has(code)) return code
  const sample = message.slice(0, 8_000)
  if (PROVIDER_OVERFLOW_RE.test(sample)) return 'provider_context_too_long'
  if (PROVIDER_QUOTA_RE.test(sample)) return 'provider_limit'
  if (PROVIDER_AUTH_RE.test(sample)) return 'provider_auth'
  return code
}
