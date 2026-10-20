// Key lanes K1 P2 (plan v4 section 4): the loopback metering relay.
//
// The ONLY place on the Mac a real provider key is used. A keyed child (Claude Code, Codex) is
// pointed at `http://127.0.0.1:<ephemeral>/relay/{a,o}` and given a per-turn nonce instead of the
// key. For each request the relay checks the nonce, applies the profile's model policy, reserves
// against the key's daily cap, forwards with the real key, streams the answer back byte for byte
// while teeing a copy to a usage parser, and settles the measured cost.
//
//   Bind      127.0.0.1 only, port 0. Never 3141 or 3143 (those face Tailscale), never 0.0.0.0.
//   Start     lazily, by the first issueTurn(). With no keyed turn there is no listener, no
//             socket and no timer. close() when keyLanesActive() turns false.
//   Secret    read through readKeySecretForRelay() at request time, put in the upstream headers,
//             and nowhere else. Upstream error bodies are scrubbed of it before they are passed on.
//   Retries   none here (no double billing). The child retries 429, 5xx and network errors.
//   Breaker   only 401, 402 and model-gone count (key-relay-errors.ts).
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { keyLanesActive, onKeyLanesInactive, registerKeyLanesStatusProvider } from './key-lanes.js'
import { getPublicKey, readKeySecretForRelay } from './key-store.js'
import type {
  BreakerScope,
  BreakerState,
  KeyKind,
  KeyRef,
  KeyRelay,
  RelayEngine,
  RelayFailureKind,
  RelayIssueOptions,
  RelayModelAction,
  RelayNonceBinding,
  RelayRevokeReason,
  RelayTurnHandle,
} from './key-relay-contract.js'
import { KEY_REF_RE, RELAY_BASE_PATHS, RELAY_LIMITS, RELAY_PATHS, RELAY_UPSTREAMS } from './key-relay-contract.js'
import {
  RelayBreakers,
  breakerScopeFor,
  classifyUpstreamStatus,
  countsTowardBreaker,
  endsTurn,
  redactSecrets,
  relayErrorBody,
} from './key-relay-errors.js'
import type { RelayLocalError } from './key-relay-errors.js'
import type { KeyRelayMeter, ModelPrice } from './key-relay-meter.js'
import { defaultPriceFor, getSharedKeyMeter, reserveWithinHeadroomUsd, tokensToUsd } from './key-relay-meter.js'

/** A request past the in-flight cap waits this long for a slot before the busy 429. */
const IN_FLIGHT_WAIT_MS = 120_000

/** Ended nonces remembered (hash only) so a late request reads why; oldest dropped first. */
const ENDED_NONCES_MAX = 256

/** The only address the relay ever listens on. */
export const RELAY_HOST = '127.0.0.1'
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'
const USAGE_POLL_MS = 60_000
const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000
const PREFLIGHT_TIMEOUT_MS = 10_000
const RECONCILE_DELAY_MS = 15_000
const ERROR_BODY_CAP_BYTES = 1024 * 1024
const JSON_USAGE_CAP_BYTES = 8 * 1024 * 1024
const SSE_BUFFER_CAP_CHARS = 1024 * 1024
const LOG_PATH_CHARS = 120

// ── Model policy (plan 4.4) ──────────────────────────────────────────────────

const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable'])

/**
 * Equal to the profile slug forwards. A Claude id or alias (`claude-*`, `opus`, `sonnet`, `haiku`,
 * `fable`, anything ending `[1m]`) on a Claude profile, or a bare OpenAI id (`gpt-*`, `o<n>*`,
 * `codex-*`) on a Codex profile, is rewritten to the slug: the sub-model, small-fast and subagent
 * ids the CLI picks on its own. Anything else is refused.
 */
export function decideRelayModel(requested: unknown, allowedModel: string, engine: RelayEngine): { action: RelayModelAction; model: string; requested: string } {
  if (typeof requested !== 'string' || !requested) return { action: 'reject', model: '', requested: '' }
  if (requested === allowedModel) return { action: 'forward', model: allowedModel, requested }
  if (engine === 'claude') {
    if (/\[1m\]$/i.test(requested)) return { action: 'rewrite', model: allowedModel, requested }
    if (/^claude-/i.test(requested) || CLAUDE_ALIASES.has(requested.toLowerCase())) return { action: 'rewrite', model: allowedModel, requested }
    return { action: 'reject', model: requested, requested }
  }
  if (!requested.includes('/') && /^(gpt-|o\d|codex-)/i.test(requested)) return { action: 'rewrite', model: allowedModel, requested }
  return { action: 'reject', model: requested, requested }
}

/** Which key kinds and model families a Lane B engine may use (plan 4.4). */
export function laneBModelAllowed(engine: RelayEngine, kind: KeyKind, model: string): boolean {
  if (engine === 'claude') {
    if (kind === 'openrouter') return model.startsWith('anthropic/')
    if (kind === 'anthropic') return /^claude-/i.test(model)
    return false
  }
  if (kind === 'openrouter') return model.startsWith('openai/')
  if (kind === 'openai') return !model.includes('/')
  return false
}

// ── Usage parsing (tee of the response) ──────────────────────────────────────

export interface ParsedUsage {
  input: number
  output: number
  costUsd?: number
  /** The final usage event arrived (message_stop / response.completed, or a whole JSON body). */
  complete: boolean
  sawUsage: boolean
  /** Characters of generated text seen, for a partial settle when the stream was cut. */
  deltaChars: number
  /** Canary R9: the cached share of `input`, priced at its own rates (read 0.1x, write 1.25x). */
  cacheRead?: number
  cacheWrite?: number
  /** The provider's message id from message_start (OpenRouter's is the generation id). */
  messageId?: string
}

/** Anthropic prompt-cache prices relative to the input price (canary R9: cache reads dominate keyed turns). */
export const CACHE_READ_PRICE_FACTOR = 0.1
export const CACHE_WRITE_PRICE_FACTOR = 1.25

/** USD for counted tokens with the cached share of the input at its own rates. */
export function cachePricedUsd(t: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, price: ModelPrice): number {
  const read = Math.max(0, t.cacheRead ?? 0), write = Math.max(0, t.cacheWrite ?? 0)
  const plain = Math.max(0, t.input - read - write)
  return (plain * price.inUsdPerM + read * price.inUsdPerM * CACHE_READ_PRICE_FACTOR + write * price.inUsdPerM * CACHE_WRITE_PRICE_FACTOR + Math.max(0, t.output) * price.outUsdPerM) / 1e6
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function costOf(usage: Record<string, unknown> | undefined): number | undefined {
  const c = usage?.cost
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : undefined
}

export class RelayUsageParser {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private jsonBytes = 0
  private jsonChunks: string[] = []
  private dead = false
  readonly usage: ParsedUsage = { input: 0, output: 0, complete: false, sawUsage: false, deltaChars: 0 }

  constructor(private readonly engine: RelayEngine, private readonly sse: boolean) {}

  push(chunk: Uint8Array): void {
    if (this.dead) return
    const text = this.decoder.decode(chunk, { stream: true })
    if (!this.sse) {
      this.jsonBytes += chunk.byteLength
      if (this.jsonBytes > JSON_USAGE_CAP_BYTES) { this.dead = true; this.jsonChunks = []; return }
      this.jsonChunks.push(text)
      return
    }
    this.buffer += text
    let idx: number
    while ((idx = this.buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = this.buffer.slice(0, idx)
      const sep = /\r?\n\r?\n/.exec(this.buffer.slice(idx))
      this.buffer = this.buffer.slice(idx + (sep ? sep[0].length : 2))
      this.onEvent(event)
    }
    if (this.buffer.length > SSE_BUFFER_CAP_CHARS) { this.dead = true; this.buffer = '' }
  }

  finish(): ParsedUsage {
    if (this.dead) return this.usage
    if (!this.sse) {
      this.jsonChunks.push(this.decoder.decode())
      try {
        const body = JSON.parse(this.jsonChunks.join('')) as { usage?: Record<string, unknown>; response?: { usage?: Record<string, unknown> } }
        const u = body.usage ?? body.response?.usage
        if (u && typeof u === 'object') this.applyUsage(u, true)
      } catch { /* not JSON: no usage, the reservation settles in full */ }
      return this.usage
    }
    if (this.buffer.trim()) this.onEvent(this.buffer)
    this.buffer = ''
    return this.usage
  }

  private applyUsage(u: Record<string, unknown>, final: boolean): void {
    const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
    if (input >= this.usage.input) {
      this.usage.cacheRead = num(u.cache_read_input_tokens)
      this.usage.cacheWrite = num(u.cache_creation_input_tokens)
    }
    this.usage.input = Math.max(this.usage.input, input)
    this.usage.output = Math.max(this.usage.output, num(u.output_tokens))
    const cost = costOf(u)
    if (cost !== undefined) this.usage.costUsd = cost
    this.usage.sawUsage = true
    if (final) this.usage.complete = true
  }

  private onEvent(raw: string): void {
    const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') return
    let ev: Record<string, unknown>
    try { ev = JSON.parse(data) as Record<string, unknown> } catch { return }
    const type = ev.type
    if (this.engine === 'claude') {
      if (type === 'message_start') {
        const m = ev.message as { id?: unknown; usage?: Record<string, unknown> } | undefined
        if (typeof m?.id === 'string' && m.id.length <= 128) this.usage.messageId = m.id
        const u = m?.usage
        if (u) this.applyUsage(u, false)
      } else if (type === 'message_delta') {
        const u = ev.usage as Record<string, unknown> | undefined
        if (u) this.applyUsage(u, false)
      } else if (type === 'content_block_delta') {
        const d = ev.delta as Record<string, unknown> | undefined
        for (const k of ['text', 'partial_json', 'thinking']) if (typeof d?.[k] === 'string') this.usage.deltaChars += (d[k] as string).length
      } else if (type === 'message_stop') {
        this.usage.complete = this.usage.sawUsage
      }
      return
    }
    if (typeof type === 'string' && type.endsWith('.delta') && typeof ev.delta === 'string') {
      this.usage.deltaChars += ev.delta.length
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed' || type === 'response.done') {
      const u = (ev.response as { usage?: Record<string, unknown> } | undefined)?.usage
      if (u) this.applyUsage(u, true)
    }
  }
}

/** QA W2: the running cost of a reply mid-stream: input as reported (or the body estimate), output at least the text seen. */
export function streamedUsd(usage: ParsedUsage, price: ModelPrice, bodyBytes: number): { usd: number; tokens: { input: number; output: number } } {
  const input = usage.input > 0 ? usage.input : Math.ceil(Math.max(0, bodyBytes) / 4)
  const output = Math.max(usage.output, Math.ceil(usage.deltaChars / 4))
  const tokens = { input: Math.round(input), output: Math.round(output) }
  // Canary R9: cache reads and writes at their own rates, so a reply that fits is not cut.
  const cached = usage.input > 0 ? { cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : {}
  return { usd: cachePricedUsd({ ...tokens, ...cached }, price), tokens }
}

/** USD for what was parsed, or null when no usage arrived (settle the full reservation). */
export function usageUsd(usage: ParsedUsage, price: ModelPrice): { usd: number; tokens: { input: number; output: number } } | null {
  if (!usage.sawUsage) return null
  const output = usage.complete ? usage.output : Math.max(usage.output, Math.ceil(usage.deltaChars / 4))
  const tokens = { input: Math.round(usage.input), output: Math.round(output) }
  if (usage.complete && usage.costUsd !== undefined) return { usd: usage.costUsd, tokens }
  return { usd: cachePricedUsd({ ...tokens, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }, price), tokens }
}

// ── The relay ────────────────────────────────────────────────────────────────

export type KeyRelayRefusalKind = RelayFailureKind | 'lanes_inactive'

/** Thrown by issueTurn(): the turn must not spawn. P3, P4 map `kind` to the P8 lens line. */
export class KeyRelayRefusal extends Error {
  constructor(readonly kind: KeyRelayRefusalKind, readonly code: string, message: string) {
    super(message)
    this.name = 'KeyRelayRefusal'
  }
}

/**
 * QA N10 / U2: every way a keyed request went wrong, not only the ones that end the turn. A 429,
 * 5xx or network error is retried by the child; reported anyway so a turn that still fails reads
 * why. `nonce_*` is a request on a token the relay already ended; `upstream_refused` a 4xx with
 * no row of its own (403 moderation, a plain 400).
 */
export type RelayTurnFailureKind = RelayFailureKind | 'nonce_expired' | 'nonce_revoked' | 'upstream_refused' | 'relay_busy'

export interface RelayTurnFailure {
  turnId: string
  sessionId: string
  profileId: string
  keyRef: KeyRef
  kind: RelayTurnFailureKind
  status: number
  /** The plan 4.6 "ends the turn" rows (cap, 401, 402, model gone). */
  endsTurn?: boolean
}

export interface KeyRelayDeps {
  now?: () => number
  isActive?: () => boolean
  secretFor?: (ref: KeyRef) => string | null
  keyKindOf?: (ref: KeyRef) => KeyKind | undefined
  /** For the "reset on key change or successful validation" rule. */
  keyValidatedAt?: (ref: KeyRef) => string | undefined
  meter?: KeyRelayMeter
  priceFor?: (model: string) => ModelPrice
  upstreams?: Partial<Record<keyof typeof RELAY_UPSTREAMS, string>>
  /** OpenRouter's key and generation API (usage_daily, pre-spawn check, reconcile). */
  openrouterApiBase?: string
  fetch?: typeof fetch
  usagePollMs?: number
  upstreamHeadersTimeoutMs?: number
  /** How long a request past the in-flight cap waits for a slot (default 120 s). */
  inFlightWaitMs?: number
  /** Delay before the generation-cost reconcile; null turns it off. */
  reconcileDelayMs?: number | null
  log?: (line: string) => void
  /** The 4.6 "ends the turn" rows, so the bridge can stop the child and show the lens line. */
  onTurnFailure?: (failure: RelayTurnFailure) => void
}

interface TurnEntry {
  hash: string
  nonceHead: string
  binding: RelayNonceBinding
  keyKind: KeyKind
  expiresAt: number
  inFlight: number
  controllers: Set<AbortController>
  timer?: ReturnType<typeof setTimeout>
  /** QA (canary, parallel subagents): requests past the in-flight cap wait here, oldest first. */
  waiters: Array<(got: boolean) => void>
}

interface Route {
  engine: RelayEngine
  metered: boolean
  countTokens: boolean
}

const ROUTES: Record<string, Route> = {
  [RELAY_PATHS.anthropicMessages]: { engine: 'claude', metered: true, countTokens: false },
  [RELAY_PATHS.anthropicCountTokens]: { engine: 'claude', metered: false, countTokens: true },
  [RELAY_PATHS.openaiResponses]: { engine: 'codex', metered: true, countTokens: false },
}

const DROP_RESPONSE_HEADERS = new Set([
  'set-cookie', 'set-cookie2', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'upgrade', 'proxy-authenticate', 'proxy-connection', 'trailer',
])
const CLAUDE_PASS_HEADERS = ['accept', 'anthropic-version', 'anthropic-beta', 'user-agent']
const CODEX_PASS_HEADERS = ['accept', 'openai-beta', 'originator', 'session_id', 'conversation_id', 'version', 'user-agent']

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex')
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function bearer(v: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(v ?? '')
  return m ? m[1] : undefined
}

function stamp(secret: string, validatedAt: string | undefined): string {
  return createHash('sha256').update(secret).update('\0').update(validatedAt ?? '').digest('hex')
}

export class KeyRelayServer implements KeyRelay {
  private readonly now: () => number
  private readonly isActive: () => boolean
  private readonly secretFor: (ref: KeyRef) => string | null
  private readonly keyKindOf: (ref: KeyRef) => KeyKind | undefined
  private readonly keyValidatedAt: (ref: KeyRef) => string | undefined
  private readonly meter: KeyRelayMeter
  private readonly priceFor: (model: string) => ModelPrice
  private readonly upstreams: Record<keyof typeof RELAY_UPSTREAMS, string>
  private readonly openrouterApi: string
  private readonly fetchImpl: typeof fetch
  private readonly usagePollMs: number
  private readonly headersTimeoutMs: number
  private readonly reconcileDelayMs: number | null
  private readonly inFlightWaitMs: number
  private readonly log: (line: string) => void
  private readonly onTurnFailure: (failure: RelayTurnFailure) => void
  readonly breakers: RelayBreakers

  private server: http.Server | null = null
  private listening: Promise<void> | null = null
  private readonly turns = new Map<string, TurnEntry>()
  private readonly ended = new Map<string, { binding: RelayNonceBinding; reason: RelayRevokeReason }>()
  private readonly byTurnId = new Map<string, string>()
  private readonly usageReadAt = new Map<KeyRef, number>()
  private readonly keyStamps = new Map<KeyRef, string>()
  private readonly reconcileTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(deps: KeyRelayDeps = {}) {
    this.now = deps.now ?? Date.now
    this.isActive = deps.isActive ?? (() => keyLanesActive())
    this.secretFor = deps.secretFor ?? readKeySecretForRelay
    this.keyKindOf = deps.keyKindOf ?? (ref => getPublicKey(ref)?.kind)
    this.keyValidatedAt = deps.keyValidatedAt ?? (ref => getPublicKey(ref)?.validatedAt)
    this.meter = deps.meter ?? getSharedKeyMeter()
    this.priceFor = deps.priceFor ?? defaultPriceFor
    this.upstreams = { ...RELAY_UPSTREAMS, ...(deps.upstreams ?? {}) }
    this.openrouterApi = (deps.openrouterApiBase ?? OPENROUTER_API_BASE).replace(/\/+$/, '')
    this.fetchImpl = deps.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch)
    this.usagePollMs = deps.usagePollMs ?? USAGE_POLL_MS
    this.headersTimeoutMs = deps.upstreamHeadersTimeoutMs ?? UPSTREAM_HEADERS_TIMEOUT_MS
    this.reconcileDelayMs = deps.reconcileDelayMs === undefined ? RECONCILE_DELAY_MS : deps.reconcileDelayMs
    this.inFlightWaitMs = deps.inFlightWaitMs ?? IN_FLIGHT_WAIT_MS
    this.log = deps.log ?? (line => console.info(line))
    this.onTurnFailure = deps.onTurnFailure ?? (() => {})
    this.breakers = new RelayBreakers(this.now, (scope, id) => this.onBreakerOpen(scope, id))
  }

  // ── KeyRelay contract ──

  port(): number | null {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? (addr as AddressInfo).port : null
  }

  /** The listener's bound address, or null (tests pin 127.0.0.1). */
  address(): string | null {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? (addr as AddressInfo).address : null
  }

  async issueTurn(binding: RelayNonceBinding, options: RelayIssueOptions): Promise<RelayTurnHandle> {
    if (!binding || !KEY_REF_RE.test(binding.keyRef) || (binding.engine !== 'claude' && binding.engine !== 'codex')
      || typeof binding.allowedModel !== 'string' || !binding.allowedModel || typeof binding.turnId !== 'string' || !binding.turnId) {
      throw new KeyRelayRefusal('model_not_allowed', 'bad_binding', 'The key turn is missing its profile details.')
    }
    if (!this.isActive()) throw new KeyRelayRefusal('lanes_inactive', 'lanes_inactive', 'Key lanes are off.')
    const ref = binding.keyRef
    const kind = this.keyKindOf(ref)
    const secret = this.secretFor(ref)
    if (!kind || !secret) throw new KeyRelayRefusal('key_rejected', 'key_missing', 'That key is not saved on this Mac.')
    if (!laneBModelAllowed(binding.engine, kind, binding.allowedModel)) {
      throw new KeyRelayRefusal('model_not_allowed', 'lane_b_model', 'This model runs only on the direct lane.')
    }
    this.checkKeyStamp(ref, secret)
    if (this.breakers.isOpen('key', ref)) throw new KeyRelayRefusal('key_rejected', 'breaker_open', 'This key failed three times in a row. It is paused for an hour.')
    if (this.breakers.isOpen('profile', binding.profileId)) throw new KeyRelayRefusal('model_gone', 'breaker_open', 'This model failed three times in a row. It is paused for an hour.')
    if (kind === 'openrouter') await this.preflight(ref, secret)
    if (this.meter.atCap(ref)) throw new KeyRelayRefusal('cap_refused', 'cap_reached', 'Daily cap reached for this key.')

    await this.ensureListening()
    const previous = this.byTurnId.get(binding.turnId)
    if (previous) this.drop(previous, 'cancel')

    const nonce = randomBytes(RELAY_LIMITS.nonceBytes).toString('base64url')
    const hash = hashNonce(nonce)
    const wallMaxMs = Number.isFinite(options?.wallMaxMs) && options.wallMaxMs > 0 ? options.wallMaxMs : 0
    const entry: TurnEntry = {
      hash,
      nonceHead: nonce.slice(0, RELAY_LIMITS.nonceLogChars),
      binding: { ...binding },
      keyKind: kind,
      expiresAt: this.now() + wallMaxMs + RELAY_LIMITS.wallMaxGraceMs,
      inFlight: 0,
      controllers: new Set(),
      waiters: [],
    }
    this.turns.set(hash, entry)
    this.byTurnId.set(binding.turnId, hash)
    this.scheduleExpiry(entry)
    const origin = `http://${RELAY_HOST}:${this.port()}`
    this.log(`[key-relay] issued nonce=${entry.nonceHead} turn=${binding.turnId} engine=${binding.engine}`)
    return {
      nonce,
      origin,
      childClosed: () => {
        const e = this.turns.get(hash)
        if (!e) return
        e.expiresAt = Math.min(e.expiresAt, this.now() + RELAY_LIMITS.childCloseGraceMs)
        this.scheduleExpiry(e)
      },
      revoke: (reason: RelayRevokeReason) => this.drop(hash, reason),
    }
  }

  revokeTurn(turnId: string, reason: RelayRevokeReason): void {
    const hash = this.byTurnId.get(turnId)
    if (hash) this.drop(hash, reason)
  }

  revokeAll(reason: RelayRevokeReason): void {
    for (const hash of [...this.turns.keys()]) this.drop(hash, reason)
  }

  async close(): Promise<void> {
    this.revokeAll('lanes_inactive')
    for (const t of this.reconcileTimers) clearTimeout(t)
    this.reconcileTimers.clear()
    const server = this.server
    this.server = null
    this.listening = null
    if (!server) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  /** Wait for an in-flight slot on this nonce; true once one is handed over, false on timeout or revoke. */
  private waitForSlot(entry: TurnEntry): Promise<boolean> {
    return new Promise(resolve => {
      let done = false
      const finish = (got: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(got) }
      const timer = setTimeout(() => {
        const i = entry.waiters.indexOf(finish)
        if (i >= 0) entry.waiters.splice(i, 1)
        finish(false)
      }, this.inFlightWaitMs)
      timer.unref?.()
      entry.waiters.push(finish)
    })
  }

  /** QA W2: settled spend today (this reservation excluded) plus what this reply has streamed so far, against the cap. */
  private streamPastCap(ref: KeyRef, reservationId: string, usage: ParsedUsage, price: ModelPrice, bodyBytes: number): boolean {
    const cap = this.meter.capUsd(ref)
    if (cap === null) return true
    const others = this.meter.spentTodayUsd(ref) - (this.meter.reservedUsd(reservationId) ?? 0)
    return others + streamedUsd(usage, price, bodyBytes).usd > cap
  }

  // ── Extras for the status route, Control's Reset button and tests ──

  breakerState(scope: BreakerScope, id: string): BreakerState {
    return this.breakers.state(scope, id)
  }

  resetBreaker(scope: BreakerScope, id: string): void {
    this.breakers.reset(scope, id)
  }

  /** QA W5: every live nonce of one profile (turned off, changed or removed). Returns how many. */
  revokeProfile(profileId: string, reason: RelayRevokeReason = 'cancel'): number {
    let n = 0
    for (const [hash, e] of [...this.turns]) if (e.binding.profileId === profileId) { this.drop(hash, reason); n++ }
    return n
  }

  /** Live nonces (tests and diagnostics; never the nonce itself). */
  liveTurnCount(): number {
    return this.turns.size
  }

  // ── Internals ──

  private drop(hash: string, reason: RelayRevokeReason): void {
    const e = this.turns.get(hash)
    if (!e) return
    this.turns.delete(hash)
    if (this.byTurnId.get(e.binding.turnId) === hash) this.byTurnId.delete(e.binding.turnId)
    // Remembered (hash, binding and reason only) so a late request on it can say why it failed.
    this.ended.set(hash, { binding: e.binding, reason })
    while (this.ended.size > ENDED_NONCES_MAX) {
      const oldest = this.ended.keys().next().value
      if (oldest === undefined) break
      this.ended.delete(oldest)
    }
    if (e.timer) clearTimeout(e.timer)
    for (const c of e.controllers) c.abort()
    e.controllers.clear()
    for (const w of e.waiters.splice(0)) w(false)
    this.log(`[key-relay] revoked nonce=${e.nonceHead} reason=${reason}`)
  }

  private scheduleExpiry(e: TurnEntry): void {
    if (e.timer) clearTimeout(e.timer)
    const ms = Math.max(0, e.expiresAt - this.now())
    e.timer = setTimeout(() => this.drop(e.hash, 'expired'), ms)
    e.timer.unref?.()
  }

  private onBreakerOpen(scope: BreakerScope, id: string): void {
    this.log(`[key-relay] breaker open scope=${scope}`)
    for (const [hash, e] of [...this.turns]) {
      if ((scope === 'key' && e.binding.keyRef === id) || (scope === 'profile' && e.binding.profileId === id)) this.drop(hash, 'breaker_open')
    }
  }

  /** A new secret or a fresh validation for the same ref resets its breakers (plan 4.6). */
  private checkKeyStamp(ref: KeyRef, secret: string): void {
    const s = stamp(secret, this.keyValidatedAt(ref))
    const before = this.keyStamps.get(ref)
    if (before !== undefined && before !== s) {
      this.breakers.reset('key', ref)
      for (const e of this.turns.values()) if (e.binding.keyRef === ref) this.breakers.reset('profile', e.binding.profileId)
    }
    this.keyStamps.set(ref, s)
  }

  private ensureListening(): Promise<void> {
    if (this.listening) return this.listening
    const server = http.createServer((req, res) => { void this.handle(req, res) })
    this.server = server
    this.listening = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, RELAY_HOST, () => {
        server.off('error', reject)
        resolve()
      })
    })
    return this.listening
  }

  /** OpenRouter GET /key: pre-spawn check (plan 7.2) and usage_daily (plan 4.5). */
  private async readKey(ref: KeyRef, secret: string): Promise<{ status: number; data?: Record<string, unknown> } | null> {
    try {
      const r = await this.fetchImpl(`${this.openrouterApi}/key`, {
        headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
        redirect: 'error',
      })
      if (!r.ok) { await r.body?.cancel().catch(() => {}); return { status: r.status } }
      const body = await r.json().catch(() => null) as { data?: Record<string, unknown> } | null
      this.usageReadAt.set(ref, this.now())
      const daily = body?.data?.usage_daily
      if (typeof daily === 'number') this.meter.observeUsageDaily(ref, daily)
      return { status: r.status, ...(body?.data ? { data: body.data } : {}) }
    } catch {
      return null
    }
  }

  private async preflight(ref: KeyRef, secret: string): Promise<void> {
    const r = await this.readKey(ref, secret)
    if (!r) return // Unreachable: let the turn try; the child sees 502 and retries.
    if (r.status === 401 || r.status === 403) {
      this.breakers.record('key', ref, 'key_rejected', false)
      throw new KeyRelayRefusal('key_rejected', 'key_rejected', 'OpenRouter rejected this key.')
    }
    if (r.status === 402) {
      this.breakers.record('key', ref, 'out_of_credit', false)
      throw new KeyRelayRefusal('out_of_credit', 'out_of_credit', 'This OpenRouter key has no credit left.')
    }
    const data = r.data
    if (!data) return
    if (data.limit === null || data.limit === undefined) {
      throw new KeyRelayRefusal('out_of_credit', 'no_credit_limit', 'Set a credit limit on this key at openrouter.ai first.')
    }
    if (typeof data.limit_remaining === 'number' && data.limit_remaining <= 0) {
      this.breakers.record('key', ref, 'out_of_credit', false)
      throw new KeyRelayRefusal('out_of_credit', 'out_of_credit', 'This OpenRouter key has no credit left.')
    }
  }

  private async refreshUsageIfStale(ref: KeyRef, kind: KeyKind, secret: string): Promise<void> {
    if (kind !== 'openrouter') return
    const at = this.usageReadAt.get(ref)
    if (at !== undefined && this.now() - at < this.usagePollMs) return
    await this.readKey(ref, secret)
  }

  private upstreamUrl(entry: TurnEntry, route: Route, search: string): string {
    let base: string
    if (route.engine === 'claude') base = entry.keyKind === 'anthropic' ? this.upstreams.anthropicMessages : this.upstreams.openrouterMessages
    else base = entry.keyKind === 'openai' ? this.upstreams.openaiResponses : this.upstreams.openrouterResponses
    return `${base}${route.countTokens ? '/count_tokens' : ''}${search}`
  }

  private upstreamHeaders(req: IncomingMessage, entry: TurnEntry, secret: string): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', 'accept-encoding': 'identity' }
    for (const name of entry.binding.engine === 'claude' ? CLAUDE_PASS_HEADERS : CODEX_PASS_HEADERS) {
      const v = headerValue(req.headers[name])
      if (v) h[name] = v
    }
    if (entry.binding.engine === 'claude' && !h['anthropic-version']) h['anthropic-version'] = '2023-06-01'
    if (entry.keyKind === 'anthropic') h['x-api-key'] = secret
    else h.authorization = `Bearer ${secret}`
    return h
  }

  private sendLocal(res: ServerResponse, engine: RelayEngine | 'unknown', error: RelayLocalError, extra: Record<string, string> = {}): void {
    if (res.headersSent) { res.destroy(); return }
    const { status, body } = relayErrorBody(engine, error)
    res.writeHead(status, { 'content-type': 'application/json', ...extra })
    res.end(body)
  }

  private fail(entry: TurnEntry | { binding: RelayNonceBinding }, kind: RelayTurnFailureKind, status: number): void {
    const b = entry.binding
    const ends = kind !== 'nonce_expired' && kind !== 'nonce_revoked' && kind !== 'upstream_refused' && kind !== 'relay_busy' && endsTurn(kind)
    try { this.onTurnFailure({ turnId: b.turnId, sessionId: b.sessionId, profileId: b.profileId, keyRef: b.keyRef, kind, status, endsTurn: ends }) } catch { /* a listener never breaks the relay */ }
  }

  private async readBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > RELAY_LIMITS.bodyCapBytes) return null
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let route: Route | undefined
    try {
      const url = new URL(req.url ?? '/', 'http://relay.invalid')
      const path = url.pathname
      if (req.headers.origin !== undefined) { req.resume(); return this.sendLocal(res, 'unknown', 'browser_refused') }
      if (path === RELAY_PATHS.health && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      // Claude Code sends `HEAD /api/hello` under its base URL once per turn (canary R12): a
      // reachability probe. Answered empty, never metered, never logged as a 404.
      if (req.method === 'HEAD' && path === `${RELAY_BASE_PATHS.claude}/api/hello`) {
        req.resume()
        res.writeHead(204)
        res.end()
        return
      }
      route = ROUTES[path]
      if (!route || req.method !== 'POST') {
        this.log(`[key-relay] 404 ${req.method ?? '?'} ${path.slice(0, LOG_PATH_CHARS)}`)
        req.resume()
        return this.sendLocal(res, route?.engine ?? (path.startsWith('/relay/o/') ? 'codex' : 'unknown'), 'not_found')
      }
      const token = bearer(headerValue(req.headers.authorization)) ?? (route.engine === 'claude' ? headerValue(req.headers['x-api-key']) : undefined)
      const entry = token ? this.turns.get(hashNonce(token)) : undefined
      if (entry && !this.isActive()) this.revokeAll('lanes_inactive')
      if (!entry || !this.turns.has(entry.hash) || this.now() >= entry.expiresAt || entry.binding.engine !== route.engine) {
        if (entry && this.now() >= entry.expiresAt) this.drop(entry.hash, 'expired')
        // QA N10: a token this relay ended reports why to its turn (an unknown one, nothing).
        const ended = token ? this.ended.get(hashNonce(token)) : undefined
        if (ended) this.fail({ binding: ended.binding }, ended.reason === 'expired' ? 'nonce_expired' : 'nonce_revoked', 401)
        req.resume()
        return this.sendLocal(res, route.engine, 'nonce_invalid')
      }
      // Canary QA: parallel subagents past the cap wait for a slot (bounded) instead of a 429
      // that ends the turn on the CLI's raw error. Past the wait, the 429 is reported to the turn
      // as relay_busy, which reads as a key-notices line.
      if (entry.inFlight >= RELAY_LIMITS.inFlightPerNonce) {
        const got = await this.waitForSlot(entry)
        if (!got) {
          req.resume()
          if (this.turns.has(entry.hash)) this.fail(entry, 'relay_busy', 429)
          return this.sendLocal(res, route.engine, 'too_many_in_flight', { 'retry-after': '1' })
        }
      } else {
        entry.inFlight += 1
      }
      try {
        await this.forward(req, res, entry, route, url.search)
      } finally {
        // The slot passes straight to the oldest waiter, or is released.
        const next = entry.waiters.shift()
        if (next) next(true)
        else entry.inFlight -= 1
      }
    } catch {
      this.sendLocal(res, route?.engine ?? 'unknown', 'network_error')
    }
  }

  private async forward(req: IncomingMessage, res: ServerResponse, entry: TurnEntry, route: Route, search: string): Promise<void> {
    const raw = await this.readBody(req)
    if (raw === null) {
      res.setHeader('connection', 'close')
      return this.sendLocal(res, route.engine, 'too_large')
    }
    let json: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      json = parsed as Record<string, unknown>
    } catch {
      return this.sendLocal(res, route.engine, 'bad_request')
    }

    const b = entry.binding
    const decision = decideRelayModel(json.model, b.allowedModel, route.engine)
    if (decision.action === 'reject') {
      this.log(`[key-relay] model refused nonce=${entry.nonceHead}`)
      return this.sendLocal(res, route.engine, 'model_not_allowed')
    }
    let body: Buffer = raw
    if (decision.action === 'rewrite') {
      json.model = b.allowedModel
      body = Buffer.from(JSON.stringify(json))
      // QA N6: the requested name comes from the child; only safe characters reach the log line.
      this.log(`[key-relay] model rewritten from=${String(decision.requested).slice(0, 64).replace(/[^A-Za-z0-9._:/@\[\]-]/g, '?')} nonce=${entry.nonceHead}`)
    }

    const secret = this.secretFor(b.keyRef)
    if (!secret || this.breakers.isOpen('key', b.keyRef) || this.breakers.isOpen('profile', b.profileId)) {
      this.drop(entry.hash, secret ? 'breaker_open' : 'remove_all')
      return this.sendLocal(res, route.engine, 'nonce_invalid')
    }

    const price = this.priceFor(b.allowedModel)
    let reservationId: string | null = null
    if (route.metered) {
      await this.refreshUsageIfStale(b.keyRef, entry.keyKind, secret)
      const maxTokens = route.engine === 'claude' ? json.max_tokens : json.max_output_tokens
      // QA W2: the request's own max_tokens, within what the key has left today.
      const estimateUsd = reserveWithinHeadroomUsd({ bodyBytes: body.length, maxTokens: typeof maxTokens === 'number' ? maxTokens : null, price, headroomUsd: this.meter.headroomUsd(b.keyRef) })
      const r = estimateUsd === null
        ? { ok: false as const }
        : this.meter.reserve({ keyRef: b.keyRef, turnId: b.turnId, estimateUsd, profile: b.profileId, lane: 'key' })
      if (!r.ok) {
        this.log(`[key-relay] cap refused nonce=${entry.nonceHead}`)
        this.fail(entry, 'cap_refused', 402)
        return this.sendLocal(res, route.engine, 'cap_refused')
      }
      reservationId = r.reservationId
    }

    const controller = new AbortController()
    entry.controllers.add(controller)
    let childGone = false
    let cutAtCap = false
    res.on('close', () => {
      if (!res.writableFinished) { childGone = true; controller.abort() }
    })
    const headersTimer = setTimeout(() => controller.abort(), this.headersTimeoutMs)
    headersTimer.unref?.()

    try {
      let upstream: Response
      try {
        upstream = await this.fetchImpl(this.upstreamUrl(entry, route, search), {
          method: 'POST',
          headers: this.upstreamHeaders(req, entry, secret),
          body: body as unknown as BodyInit,
          signal: controller.signal,
          redirect: 'error',
        })
      } catch {
        clearTimeout(headersTimer)
        if (reservationId) this.meter.settle({ reservationId, usd: 0, tokens: { input: 0, output: 0 } })
        if (childGone) return
        this.log(`[key-relay] upstream unreachable nonce=${entry.nonceHead}`)
        this.fail(entry, 'network_error', 502)
        return this.sendLocal(res, route.engine, 'network_error')
      }
      clearTimeout(headersTimer)

      const outHeaders: Record<string, string> = {}
      upstream.headers.forEach((value, name) => {
        if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) outHeaders[name] = redactSecrets(value, [secret])
      })

      if (upstream.status >= 400) {
        const text = await this.readBounded(upstream, ERROR_BODY_CAP_BYTES)
        const kind = classifyUpstreamStatus(upstream.status, text)
        if (reservationId) this.meter.settle({ reservationId, usd: 0, tokens: { input: 0, output: 0 } })
        if (kind && countsTowardBreaker(kind)) {
          const scope = breakerScopeFor(kind)
          this.breakers.record(scope, scope === 'key' ? b.keyRef : b.profileId, kind, false)
        }
        this.fail(entry, kind ?? 'upstream_refused', upstream.status)
        this.log(`[key-relay] upstream ${upstream.status} ${kind ?? 'passed'} nonce=${entry.nonceHead}`)
        if (childGone) return
        res.writeHead(upstream.status, outHeaders)
        res.end(redactSecrets(text, [secret]))
        return
      }

      this.breakers.record('key', b.keyRef, null, true)
      this.breakers.record('profile', b.profileId, null, true)
      const contentType = upstream.headers.get('content-type') ?? ''
      const parser = new RelayUsageParser(route.engine, contentType.includes('text/event-stream'))
      res.writeHead(upstream.status, outHeaders)
      res.flushHeaders()
      if (upstream.body) {
        const reader = upstream.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parser.push(value)
            if (childGone) break
            // QA W2: stop a reply whose running cost would take the key past today's cap.
            if (reservationId && this.streamPastCap(b.keyRef, reservationId, parser.usage, price, body.length)) {
              cutAtCap = true
              controller.abort()
              break
            }
            if (!res.write(value)) {
              await new Promise<void>(resolve => {
                const go = () => { res.off('drain', go); res.off('close', go); resolve() }
                res.on('drain', go)
                res.on('close', go)
              })
              if (childGone) break
            }
          }
        } catch {
          // Upstream dropped or we aborted (child gone, revoke): settle what was seen.
        } finally {
          reader.releaseLock()
        }
      }
      if (!childGone && !res.writableEnded) res.end()
      if (!reservationId) return
      if (cutAtCap) {
        const streamed = streamedUsd(parser.usage, price, body.length)
        // Canary R9: the provider's generation id (header, else OpenRouter's message id) so the
        // estimate is reconciled to the real cost like any other request.
        const cutGeneration = upstream.headers.get('x-generation-id') ?? (parser.usage.messageId?.startsWith('gen-') ? parser.usage.messageId : undefined)
        this.meter.settle({ reservationId, usd: streamed.usd, tokens: streamed.tokens, ...(cutGeneration ? { generationId: cutGeneration } : {}) })
        if (cutGeneration && entry.keyKind === 'openrouter') this.scheduleReconcile(entry, cutGeneration, streamed.usd)
        this.log(`[key-relay] cap reached mid-reply, stream cut nonce=${entry.nonceHead}`)
        this.fail(entry, 'cap_refused', 402)
        return
      }
      const usage = usageUsd(parser.finish(), price)
      const generationId = upstream.headers.get('x-generation-id') ?? undefined
      const settledUsd = usage ? usage.usd : (this.meter.reservedUsd(reservationId) ?? 0)
      if (usage) this.meter.settle({ reservationId, usd: usage.usd, tokens: usage.tokens, ...(generationId ? { generationId } : {}) })
      else this.meter.settleReserved(reservationId, { input: 0, output: 0 }, generationId)
      if (generationId && entry.keyKind === 'openrouter') this.scheduleReconcile(entry, generationId, settledUsd)
    } finally {
      clearTimeout(headersTimer)
      entry.controllers.delete(controller)
    }
  }

  private async readBounded(r: Response, cap: number): Promise<string> {
    if (!r.body) return ''
    const reader = r.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > cap) { await reader.cancel().catch(() => {}); break }
        chunks.push(value)
      }
    } catch { /* partial body */ }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8')
  }

  /** Plan 4.5 reconcile from OpenRouter's generation cost, once, after a delay. */
  private scheduleReconcile(entry: TurnEntry, generationId: string, settledUsd: number): void {
    if (this.reconcileDelayMs === null) return
    const b = { ...entry.binding }
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(timer)
      void (async () => {
        const secret = this.secretFor(b.keyRef)
        if (!secret) return
        try {
          const r = await this.fetchImpl(`${this.openrouterApi}/generation?id=${encodeURIComponent(generationId)}`, {
            headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
            signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
            redirect: 'error',
          })
          if (!r.ok) { await r.body?.cancel().catch(() => {}); return }
          const body = await r.json() as { data?: { total_cost?: unknown; native_tokens_prompt?: unknown; native_tokens_completion?: unknown } }
          const total = body?.data?.total_cost
          if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return
          const delta = total - settledUsd
          this.meter.reconcile({
            keyRef: b.keyRef, turnId: b.turnId, profile: b.profileId, lane: 'key', generationId, deltaUsd: delta,
            tokens: { input: num(body.data?.native_tokens_prompt), output: num(body.data?.native_tokens_completion) },
          })
        } catch { /* reconcile is best effort; the settle row stands */ }
      })()
    }, this.reconcileDelayMs)
    timer.unref?.()
    this.reconcileTimers.add(timer)
  }
}

export function createKeyRelay(deps: KeyRelayDeps = {}): KeyRelayServer {
  return new KeyRelayServer(deps)
}

// ── The shared relay and its seams ───────────────────────────────────────────

let shared: KeyRelayServer | null = null
let seamsInstalled = false
const CLOSED_BREAKER: BreakerState = { open: false, failures: 0 }

/**
 * Register the relay's answers for `GET /api/key-lanes/status` and its "lanes went inactive" hook.
 * Map writes only: no file, socket or timer. Called by getKeyRelay(); P11 may also call it at boot
 * behind keyLanesEnabled() so the status route shows today's spend before the first keyed turn.
 */
export function installKeyRelaySeams(): void {
  if (seamsInstalled) return
  seamsInstalled = true
  registerKeyLanesStatusProvider({
    spentTodayUsd: ref => getSharedKeyMeter().spentTodayUsd(ref),
    breaker: ref => shared?.breakerState('key', ref) ?? CLOSED_BREAKER,
  })
  onKeyLanesInactive('key-relay', async reason => {
    const relay = shared
    if (!relay) return
    relay.revokeAll(reason === 'remove_all' ? 'remove_all' : 'lanes_inactive')
    if (reason === 'remove_all') getSharedKeyMeter().clear()
    await relay.close()
  })
}

/**
 * The one relay for this server process (P3, P4 call this on a keyed turn). No listener until
 * issueTurn. `deps` apply only when this call creates it (tests, P11 wiring).
 */
export function getKeyRelay(deps?: KeyRelayDeps): KeyRelayServer {
  if (!shared) shared = createKeyRelay(deps)
  installKeyRelaySeams()
  return shared
}

/**
 * The shared relay when one exists, else null. Routes use this so a Control action never
 * creates the relay (and its deps) early: with no relay there is no live nonce and no open breaker.
 */
export function existingKeyRelay(): KeyRelayServer | null {
  return shared
}

/** Tests only. */
export async function __resetKeyRelayForTests(): Promise<void> {
  if (shared) await shared.close()
  shared = null
  seamsInstalled = false
}
