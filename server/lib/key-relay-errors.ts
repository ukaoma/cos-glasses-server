// Key lanes K1 P2 (plan v4 4.6): how the loopback relay maps upstream and relay events to what the
// child sees, which failures count toward the breaker, and the breaker itself.
//
// Pure functions and one small class. Nothing here reads a file, opens a socket or starts a timer,
// so importing it changes nothing for a server with key lanes off.
//
// The relay never retries itself (no double billing). Children retry 429, 5xx and network errors
// on their own budget (CLAUDE_CODE_MAX_RETRIES=2, Codex request_max_retries=2). Only a rejected
// key, an empty credit balance or a model that is gone counts toward the breaker, because those
// are the failures a retry cannot fix.
import type {
  BreakerCountedFailure,
  BreakerScope,
  BreakerState,
  RelayEngine,
  RelayFailureKind,
} from './key-relay-contract.js'
import { BREAKER_LIMITS } from './key-relay-contract.js'

// ── Classification (plan 4.6 table) ──────────────────────────────────────────

const MODEL_GONE_RE = /model[^\n]{0,80}(not found|does not exist|not available|no longer|is not a valid|invalid model)|no endpoints found|unknown model|not a valid model/i

/**
 * The 4.6 row an upstream status lands in, or null when it is passed through with no special
 * action (a 2xx, or a 4xx such as 403 moderation that is neither the key nor the model).
 */
export function classifyUpstreamStatus(status: number, bodyText = ''): RelayFailureKind | null {
  if (status >= 200 && status < 300) return null
  if (status === 401) return 'key_rejected'
  if (status === 402) return 'out_of_credit'
  if (status === 404) return 'model_gone'
  if (status === 400 && MODEL_GONE_RE.test(bodyText)) return 'model_gone'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'upstream_error'
  return null
}

/** Plan 4.6: only 401, 402 and model-gone count. 429, 5xx, network and cap refusals never do. */
export function countsTowardBreaker(kind: RelayFailureKind | null): kind is BreakerCountedFailure {
  return kind === 'key_rejected' || kind === 'out_of_credit' || kind === 'model_gone'
}

/** A rejected key or empty credit opens the KEY breaker; a gone model opens the PROFILE breaker. */
export function breakerScopeFor(kind: BreakerCountedFailure): BreakerScope {
  return kind === 'model_gone' ? 'profile' : 'key'
}

/** The 4.6 rows whose server action is "ends the turn". */
export function endsTurn(kind: RelayFailureKind): boolean {
  return kind === 'cap_refused' || kind === 'key_rejected' || kind === 'out_of_credit' || kind === 'model_gone'
}

// ── Error bodies in the caller's own shape ───────────────────────────────────

/** Relay-made failures (the ones not passed through from upstream). */
export type RelayLocalError =
  | 'nonce_invalid'
  | 'cap_refused'
  | 'model_not_allowed'
  | 'network_error'
  | 'not_found'
  | 'bad_request'
  | 'too_large'
  | 'too_many_in_flight'
  | 'browser_refused'

interface LocalErrorSpec {
  status: number
  anthropicType: string
  openaiType: string
  message: string
}

/** User-facing copy. Plain sentences, no em dashes, no arrows, never a key or a nonce. */
export const RELAY_ERROR_SPECS: Record<RelayLocalError, LocalErrorSpec> = {
  nonce_invalid: { status: 401, anthropicType: 'authentication_error', openaiType: 'invalid_api_key', message: 'This relay token is unknown or has expired.' },
  cap_refused: { status: 402, anthropicType: 'billing_error', openaiType: 'insufficient_quota', message: 'Daily cap reached for this key.' },
  model_not_allowed: { status: 400, anthropicType: 'invalid_request_error', openaiType: 'invalid_request_error', message: 'Model not allowed on this key profile' },
  network_error: { status: 502, anthropicType: 'overloaded_error', openaiType: 'server_error', message: 'The provider could not be reached. Try again.' },
  not_found: { status: 404, anthropicType: 'not_found_error', openaiType: 'invalid_request_error', message: 'Not found.' },
  bad_request: { status: 400, anthropicType: 'invalid_request_error', openaiType: 'invalid_request_error', message: 'The request body is not valid JSON.' },
  too_large: { status: 413, anthropicType: 'request_too_large', openaiType: 'invalid_request_error', message: 'The request is too large.' },
  too_many_in_flight: { status: 429, anthropicType: 'rate_limit_error', openaiType: 'rate_limit_exceeded', message: 'Too many requests at once on this turn.' },
  browser_refused: { status: 403, anthropicType: 'permission_error', openaiType: 'invalid_request_error', message: 'The relay does not answer browsers.' },
}

/** The JSON body for a relay-made failure: Anthropic shape for Claude, OpenAI shape for Codex. */
export function relayErrorBody(engine: RelayEngine | 'unknown', error: RelayLocalError): { status: number; body: string } {
  const spec = RELAY_ERROR_SPECS[error]
  const body = engine === 'codex'
    ? { error: { message: spec.message, type: spec.openaiType, code: error } }
    : { type: 'error', error: { type: spec.anthropicType, message: spec.message } }
  return { status: spec.status, body: JSON.stringify(body) }
}

// ── Redaction ────────────────────────────────────────────────────────────────

export const REDACTED = '[redacted]'

/**
 * Remove every occurrence of each secret from text bound for a child, a log or a ledger. Upstream
 * error bodies are passed through, and a provider or proxy that echoes the Authorization header
 * would otherwise hand the real key to the child.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | null | undefined>): string {
  let out = text
  for (const s of secrets) {
    if (!s || s.length < 8) continue
    // QA N3: the plain form, the JSON-escaped form (a body quoting it), and the URL-encoded form.
    const forms = new Set([s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)])
    for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(REDACTED)
  }
  return out
}

// ── Retry-After ──────────────────────────────────────────────────────────────

/** Seconds from a Retry-After header (delta seconds or an HTTP date), or null. Passed to the child as is. */
export function parseRetryAfterSeconds(value: string | null | undefined, now: () => number = Date.now): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.ceil((at - now()) / 1000))
}

// ── Breaker (plan 4.6) ───────────────────────────────────────────────────────

interface BreakerEntry {
  failures: number
  openedAtMs?: number
}

export type BreakerOpenListener = (scope: BreakerScope, id: string) => void

/**
 * 3 consecutive counted failures open a breaker for 1 h. A success resets the count. A failure
 * that does not count (429, 5xx, network, cap) neither counts nor resets. Reset on key change,
 * successful validation or the Control "Reset" button (the relay calls reset()).
 */
export class RelayBreakers {
  private readonly entries = new Map<string, BreakerEntry>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onOpen: BreakerOpenListener = () => {},
  ) {}

  private key(scope: BreakerScope, id: string): string {
    return `${scope}:${id}`
  }

  private live(scope: BreakerScope, id: string): BreakerEntry | undefined {
    const k = this.key(scope, id)
    const e = this.entries.get(k)
    if (e?.openedAtMs !== undefined && this.now() - e.openedAtMs >= BREAKER_LIMITS.openMs) {
      // Closed again after an hour, with a clean count.
      this.entries.delete(k)
      return undefined
    }
    return e
  }

  /** Record one upstream outcome. Returns true when this call opened the breaker. */
  record(scope: BreakerScope, id: string, kind: RelayFailureKind | null, ok: boolean): boolean {
    const k = this.key(scope, id)
    if (ok) {
      const e = this.live(scope, id)
      if (e && e.openedAtMs === undefined) this.entries.delete(k)
      return false
    }
    if (!countsTowardBreaker(kind)) return false
    const e = this.live(scope, id) ?? { failures: 0 }
    if (e.openedAtMs !== undefined) return false
    e.failures += 1
    if (e.failures >= BREAKER_LIMITS.failures) {
      e.openedAtMs = this.now()
      this.entries.set(k, e)
      this.onOpen(scope, id)
      return true
    }
    this.entries.set(k, e)
    return false
  }

  isOpen(scope: BreakerScope, id: string): boolean {
    return this.live(scope, id)?.openedAtMs !== undefined
  }

  state(scope: BreakerScope, id: string): BreakerState {
    const e = this.live(scope, id)
    if (!e) return { open: false, failures: 0 }
    if (e.openedAtMs === undefined) return { open: false, failures: e.failures }
    return {
      open: true,
      failures: e.failures,
      openedAt: new Date(e.openedAtMs).toISOString(),
      reopensAt: new Date(e.openedAtMs + BREAKER_LIMITS.openMs).toISOString(),
    }
  }

  reset(scope: BreakerScope, id: string): void {
    this.entries.delete(this.key(scope, id))
  }

  clear(): void {
    this.entries.clear()
  }
}
