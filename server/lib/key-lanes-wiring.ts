// Key lanes K1, package P11 (plan v4 14.2 row P11, 17): the wiring between the packages.
//
// P2 owns the relay, P3 and P4 the Lane B bridges, P5 the direct lane, P6 the profile router.
// Each left a seam for this file to fill:
//
//   registerLaneBRelay / registerCodexKeyRelay   the shared loopback relay (P2) for keyed CLI turns
//   registerCodexKeyedThreadRecorder             a keyed Codex thread is recorded like a Claude one (P3)
//   registerKeyProfileEngine claude|codex|direct the runner P6's router hands a `profile:<id>` turn to
//   registerDirectRelay                          the in-process door the direct lane posts through
//   installKeyRelaySeams                         the relay's answers on GET /api/key-lanes/status
//
// HARD RULE: wireKeyLanes() does map writes only. No file is read or written, no socket or timer
// is opened, and the direct lane module is not even loaded until a direct profile turn runs. The
// status seams are installed at boot only when keyLanesEnabled(); every registered runner and
// relay resolver refuses (or is never reached) while keyLanesActive() is false, so a server with
// no key takes the 6.79.0 path byte for byte.
import { randomUUID } from 'node:crypto'
import { callClaudeStreaming } from './claude-bridge.js'
import { runCodexKeyProfileTurn } from './codex-bridge.js'
import { registerCodexKeyRelay, registerCodexKeyedThreadRecorder } from './codex-profile-home.js'
import { keyCatalogPeekPrice } from './key-lanes-pricing.js'
import { keyLanesActive, keyLanesEnabled, registerKeyLanesStatusProvider } from './key-lanes.js'
import { registerKeyProfileEngine, type KeyProfileEngineRunner } from './key-profile-routing.js'
import type { KeyProfile, KeyRef, KeyRelay, RelayNonceBinding } from './key-relay-contract.js'
import { KEY_NOTICE_ERROR_IDS, keyModelLabel, keyNoticeError, type KeyNoticeErrorId } from './key-notices.js'
import { getPublicKey } from './key-store.js'
import type { StreamCallbacks } from './claude-bridge.js'
import { breakerScopeFor, classifyUpstreamStatus, countsTowardBreaker, redactSecrets } from './key-relay-errors.js'
import { estimateReserveUsd, getSharedKeyMeter, tokensToUsd, type KeyRelayMeter } from './key-relay-meter.js'
import { getKeyRelay, installKeyRelaySeams, KeyRelayRefusal, type KeyRelayServer, type RelayTurnFailure } from './key-relay.js'
import { readKeySecretForRelay } from './key-store.js'
import { keyedSessionIds, recordKeyedSession } from './keyed-sessions.js'
import { registerLaneBRelay } from './lane-b-env.js'
import type { DirectRefusalKind, DirectRelay, DirectRelayPost, DirectRelayTurn, DirectTurnBinding, DirectUsage } from './direct-bridge.js'

/** The one relay, created on first keyed use with live catalog prices (P5) for the meter. */
export function sharedKeyRelay(): KeyRelayServer {
  return getKeyRelay({ priceFor: keyCatalogPeekPrice, onTurnFailure: recordKeyTurnFailure })
}

// ── Turn failures: the key-notices line, never the CLI's raw error ───────────
// The relay reports the plan 4.6 "ends the turn" rows (cap, 401, 402, model gone) for a turn id,
// and issueTurn refuses a turn before spawn (breaker open, cap used, key gone). The CLI then
// fails with its own wording ("API Error: 402 ..."). The Lane B runners below wrap onError so
// the lens, the durable job and COS Control read the P8 line for that failure instead.

interface KeyTurnFailure { kind: KeyNoticeErrorId; keyRef: KeyRef; scope?: 'key' | 'profile'; id?: string; ends?: boolean }
const KEY_TURN_FAILURES_MAX = 256
const turnFailures = new Map<string, KeyTurnFailure>()

function rememberFailure(turnId: string, failure: KeyTurnFailure): void {
  if (!turnId) return
  // A failure that ended the turn is the reason; a later retry note (429, an ended token) never hides it.
  if (turnFailures.get(turnId)?.ends && !failure.ends) return
  turnFailures.delete(turnId)
  turnFailures.set(turnId, failure)
  while (turnFailures.size > KEY_TURN_FAILURES_MAX) {
    const oldest = turnFailures.keys().next().value
    if (oldest === undefined) break
    turnFailures.delete(oldest)
  }
}

/** The relay's onTurnFailure. */
export function recordKeyTurnFailure(f: RelayTurnFailure): void {
  // QA G4: one line per failure kind (names and kinds only, never a body or a token).
  console.info(`[key-lanes] turn failure kind=${f.kind} status=${f.status} profile=${f.profileId}`)
  const counted = f.kind === 'key_rejected' || f.kind === 'out_of_credit' || f.kind === 'model_gone'
  const scope = f.kind === 'model_gone' ? 'profile' : 'key'
  const ends = f.endsTurn ?? (f.kind === 'cap_refused' || counted)
  rememberFailure(f.turnId, { kind: f.kind, keyRef: f.keyRef, ends, ...(counted ? { scope, id: scope === 'key' ? f.keyRef : f.profileId } : {}) })
}

function refusalId(err: KeyRelayRefusal): KeyNoticeErrorId | null {
  if (err.code === 'breaker_open') return 'breaker_open'
  if (err.kind === 'lanes_inactive') return 'profile_off'
  if (err.code === 'key_missing') return 'profile_removed'
  return (KEY_NOTICE_ERROR_IDS as readonly string[]).includes(err.kind) ? err.kind as KeyNoticeErrorId : null
}

/** The P8 line for a turn the relay failed or refused, once (it is consumed), or null. */
export function keyTurnFailureLine(turnId: string, profile: Pick<KeyProfile, 'label' | 'model'>, now: Date = new Date()): string | null {
  const f = turnFailures.get(turnId)
  if (!f) return null
  turnFailures.delete(turnId)
  // A counted failure that opened its breaker reads as the pause, not as one more rejection.
  const paused = f.scope && f.id && f.kind !== 'breaker_open' && sharedKeyRelay().breakers.isOpen(f.scope, f.id)
  const key = getPublicKey(f.keyRef)
  return keyNoticeError(paused ? 'breaker_open' : f.kind, {
    ...(key ? { keyKind: key.kind, capUsd: key.capUsd } : {}),
    modelLabel: keyModelLabel(profile.model),
    profileLabel: profile.label,
    now,
  })
}

/** The Lane B relay as the bridges see it: the shared relay, with pre-spawn refusals remembered. */
function laneBRelayView(): KeyRelay {
  const relay = sharedKeyRelay()
  return {
    issueTurn: async (binding: RelayNonceBinding, options) => {
      try {
        return await relay.issueTurn(binding, options)
      } catch (err) {
        const id = err instanceof KeyRelayRefusal ? refusalId(err) : null
        if (id) rememberFailure(binding.turnId, { kind: id, keyRef: binding.keyRef, ends: true })
        throw err
      }
    },
    revokeTurn: (turnId, reason) => relay.revokeTurn(turnId, reason),
    revokeAll: reason => relay.revokeAll(reason),
    port: () => relay.port(),
    close: () => relay.close(),
  }
}

/** onError reads the turn's key-notices line when the relay has one; onDone forgets it. */
function withKeyFailureLines(callbacks: StreamCallbacks, turnId: string, profile: KeyProfile): StreamCallbacks {
  turnFailures.delete(turnId)
  return {
    ...callbacks,
    onError: error => callbacks.onError(keyTurnFailureLine(turnId, profile) ?? error),
    onDone: (...args) => { turnFailures.delete(turnId); return callbacks.onDone(...args) },
  }
}

// ── Runners (P6's engine seam) ───────────────────────────────────────────────

/** Lane B Claude (P3): the profile's timeout tier for the clock, its model on `--model`. */
export const runClaudeKeyProfileTurn: KeyProfileEngineRunner = (query, sessionId, callbacks, turn, images, reference, globalMsgNum, options) => {
  // The relay keys failures by turn id, so the turn gets one here when the caller has none.
  const turnId = options?.turnId ?? randomUUID()
  return callClaudeStreaming(query, sessionId, withKeyFailureLines(callbacks, turnId, turn.profile), turn.profile.timeoutTier, images, reference, globalMsgNum, { ...options, turnId, keyProfile: turn.profile })
}

/** Lane B Codex (P4). */
export const runCodexKeyTurn: KeyProfileEngineRunner = (query, sessionId, callbacks, turn, images, reference, globalMsgNum, options) => {
  const turnId = options?.turnId ?? randomUUID()
  return runCodexKeyProfileTurn(query, sessionId, withKeyFailureLines(callbacks, turnId, turn.profile), turn, images, reference, globalMsgNum, { ...options, turnId })
}

/** Lane C1 (P5). The module loads on the first direct turn, never at boot. */
export const runDirectKeyTurn: KeyProfileEngineRunner = async (query, sessionId, callbacks, turn, images, reference, globalMsgNum, options) => {
  const direct = await import('./direct-bridge.js')
  if (!direct.directRelayRegistered()) direct.registerDirectRelay(() => sharedDirectRelay())
  return direct.callDirectStreaming(query, sessionId, callbacks, turn.profile, images, reference, globalMsgNum, options)
}

// ── The direct relay (P5's in-process door over P2's meter, breakers and secret read) ──

export interface DirectRelayAdapterDeps {
  isActive?: () => boolean
  secretFor?: (ref: KeyRef) => string | null
  meter?: KeyRelayMeter
  breakers?: () => KeyRelayServer['breakers']
  priceFor?: (model: string) => { inUsdPerM: number; outUsdPerM: number }
  fetch?: typeof fetch
}

function authHeaders(secret: string): Record<string, string> {
  // OpenRouter, OpenAI, Anthropic's OpenAI-compatible endpoint and custom endpoints all take Bearer.
  return { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'text/event-stream, application/json' }
}

/**
 * A DirectRelay that reserves against the key's daily cap on the shared meter (the same counter
 * Lane B uses), forwards to the binding's endpoint with the real key, and settles what the direct
 * lane measured. It never retries (the lane's own loop does). The key is read at request time and
 * put only in the request headers; an upstream error body is scrubbed of it before the lane sees it.
 */
export function createDirectRelay(deps: DirectRelayAdapterDeps = {}): DirectRelay {
  const isActive = deps.isActive ?? (() => keyLanesActive())
  const secretFor = deps.secretFor ?? readKeySecretForRelay
  const meter = () => deps.meter ?? getSharedKeyMeter()
  const breakers = deps.breakers ?? (() => sharedKeyRelay().breakers)
  const priceFor = deps.priceFor ?? keyCatalogPeekPrice
  const fetchImpl = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))

  const preflight = (b: DirectTurnBinding): DirectRefusalKind | null => {
    if (!isActive()) return 'lanes_inactive'
    if (!secretFor(b.keyRef)) return 'key_missing'
    const br = breakers()
    if (br.isOpen('key', b.keyRef) || br.isOpen('profile', b.profileId)) return 'breaker_open'
    if (meter().atCap(b.keyRef)) return 'cap_refused'
    return null
  }

  return {
    async openTurn(binding) {
      const refused = preflight(binding)
      if (refused) return { ok: false, refused }
      const price = priceFor(binding.model)
      const turn: DirectRelayTurn = {
        async post(body, signal) {
          const refusedNow = preflight(binding)
          if (refusedNow) return { refused: refusedNow }
          const secret = secretFor(binding.keyRef)
          if (!secret) return { refused: 'key_missing' }
          // Only the profile's model goes upstream, whatever the body says.
          const payload = JSON.stringify({ ...body, model: binding.model })
          const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : null
          // QA W2: the direct lane caps each reply at its own max_tokens, so the whole of it is
          // reserved, and a post it does not fit under today's cap is refused (no overshoot).
          const fullUsd = estimateReserveUsd({ bodyBytes: Buffer.byteLength(payload), maxTokens, price })
          if (fullUsd > meter().headroomUsd(binding.keyRef)) return { refused: 'cap_refused' }
          const reserved = meter().reserve({
            keyRef: binding.keyRef,
            turnId: binding.turnId,
            estimateUsd: fullUsd,
            profile: binding.profileId,
            lane: 'direct',
          })
          if (!reserved.ok) return { refused: 'cap_refused' }
          let response: Response
          try {
            response = await fetchImpl(binding.endpoint, { method: 'POST', headers: authHeaders(secret), body: payload, signal, redirect: 'error' })
          } catch (err) {
            meter().settle({ reservationId: reserved.reservationId, usd: 0, tokens: { input: 0, output: 0 } })
            throw err instanceof Error ? new Error(redactSecrets(err.message, [secret])) : err
          }
          const br = breakers()
          if (!response.ok) {
            const text = redactSecrets(await response.text().catch(() => ''), [secret])
            const kind = classifyUpstreamStatus(response.status, text)
            if (countsTowardBreaker(kind)) br.record(breakerScopeFor(kind), breakerScopeFor(kind) === 'key' ? binding.keyRef : binding.profileId, kind, false)
            response = new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
          } else {
            br.record('key', binding.keyRef, null, true)
            br.record('profile', binding.profileId, null, true)
          }
          let settled = false
          const post: DirectRelayPost = {
            response,
            settle(usage: DirectUsage | null) {
              if (settled) return
              settled = true
              if (usage === null) { meter().settleReserved(reserved.reservationId); return }
              const tokens = { input: Math.max(0, usage.input || 0), output: Math.max(0, usage.output || 0) }
              const usd = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
                ? usage.costUsd
                : tokensToUsd(tokens, price)
              meter().settle({ reservationId: reserved.reservationId, usd, tokens, ...(usage.generationId ? { generationId: usage.generationId } : {}) })
            },
          }
          return post
        },
        spentTodayUsd: () => meter().spentTodayUsd(binding.keyRef),
        close() { /* nothing held: each post settles its own reservation */ },
      }
      return { ok: true, turn }
    },
  }
}

let directRelay: DirectRelay | null = null
function sharedDirectRelay(): DirectRelay {
  if (!directRelay) directRelay = createDirectRelay()
  return directRelay
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let wired = false

/** Called once from index.ts. Map writes only; see the HARD RULE above. */
export function wireKeyLanes(): void {
  if (wired) return
  wired = true
  registerLaneBRelay(() => laneBRelayView())
  registerCodexKeyRelay(() => laneBRelayView())
  registerCodexKeyedThreadRecorder(thread => recordKeyedSession({ id: thread.id, engine: 'codex', profileId: thread.profileId, cosSessionId: thread.cosSessionId }))
  registerKeyProfileEngine('claude', runClaudeKeyProfileTurn)
  registerKeyProfileEngine('codex', runCodexKeyTurn)
  registerKeyProfileEngine('direct', runDirectKeyTurn)
  // Read only by GET /api/key-lanes/status, which answers only while lanes are enabled.
  registerKeyLanesStatusProvider({ keyedSessionIds })
  if (keyLanesEnabled()) installKeyRelaySeams()
}

/** Tests only. */
export function __resetKeyLanesWiringForTests(): void {
  wired = false
  directRelay = null
  turnFailures.clear()
}
