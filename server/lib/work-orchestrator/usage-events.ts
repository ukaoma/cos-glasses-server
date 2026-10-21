/**
 * 6.83.0: the two places that learn about plan usage while running jobs (the Claude bridge and the job coordinator)
 * report here. Leaf module, no I/O: bridges stay as light to import (and to mock in tests) as before. The orchestrator
 * runtime registers the sink at boot; until then, and in every test that does not register one, a report is dropped.
 */
import { isProfilePreference } from '../../../shared/key-preference.js'

export interface UsageEventSink {
  limit(provider: 'claude' | 'codex' | 'cursor', message: string, source: string): void
  claudeFrame(frame: unknown): void
}
let sink: UsageEventSink | null = null
export function setUsageEventSink(next: UsageEventSink | null): void { sink = next }

/**
 * A plan-lane job failed with the provider's limit text (code `provider_limit`). A key-lane job (a `lane` on the job,
 * or a key profile as its model) is never counted: its limit is the key's, not the plan's (Q2).
 */
export function noteJobProviderLimit(provider: string | undefined, code: string, message: string, model: unknown, lane: unknown): void {
  try {
    if (code !== 'provider_limit' || lane || isProfilePreference(model)) return
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'cursor') return
    sink?.limit(provider, message, 'provider_limit')
  } catch { /* observation only */ }
}

/** A `rate_limit_event` frame from a plan-lane Claude job (the bridge never calls this for a keyed turn). */
export function noteClaudeRateLimitFrame(frame: unknown): void {
  try { sink?.claudeFrame(frame) } catch { /* observation only */ }
}
