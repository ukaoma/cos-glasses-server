// Key lanes K1 P5 (plan v4 9.1): Lane C1, direct answers on the Mac.
//
// A key profile with `engine: 'direct'` answers with one OpenAI-style chat-completions call per
// round to the profile's endpoint (OpenRouter, OpenAI, Anthropic's compatible endpoint, or a
// custom compatible URL), with the read-only COS tools when the profile may use them. No CLI, no
// child process.
//
//   Key        This module never sees one. Every request goes through the in-process DirectRelay
//              (registered by P11 from P2's relay): it reserves against the key's daily cap,
//              forwards with the real key, and settles what this module measured. Unregistered,
//              every direct turn is refused before any history, ledger row or request.
//   Tools      Reused from the Ollama path (buildOllamaToolDefs, executeOllamaTool). D7: OFF for
//              any non-loopback endpoint unless the profile opted in (`directTools`). A tool call
//              the model makes when no tools were offered is never executed.
//   Wire       direct-sse.ts. Tool calls arrive as indexed fragments with string arguments; each
//              result goes back as `{ role: 'tool', tool_call_id }`, never Ollama's `tool_name`.
//   Posts      At most 5 per turn (the Ollama MAX_CHAT_POSTS rule): posts 1 to 4 may run a tool
//              batch, post 5 is the closing fetch and its calls are never run. Retries do not count.
//   Retries    Own loop (plan 4.6): 2 retries on 429, 5xx and network errors, honoring
//              Retry-After up to 30 s; a longer Retry-After stops with the 429 line. 401, 402 and
//              model-gone end the turn at once. The relay never retries.
//   Copy       Every key-lane line comes from P8's key-notices.ts (see loadDirectNotices).
//
// HARD RULE: nothing here runs unless a caller hands it a key profile, and the first thing it
// does is check keyLanesActive(). With key lanes off this module is never called and does nothing
// at import beyond what ollama-bridge.ts already loads.

import type { CallOptions, ModelRunMetadata, StreamCallbacks } from './claude-bridge.js'
import {
  addExchange,
  formatHistoryForPrompt,
  getHistory,
  getOrCreateSession,
  getSessionRaw,
  isNewSession,
  markSessionNotified,
  reconcileExchangeByJobIdentity,
  type PromptReference,
} from './conversation.js'
import { cleanupModelImageInputs, type ModelImageInput } from './model-image-input.js'
import { finishDirectRun, startDirectRun } from './ollama-run-ledger.js'
import { notifyExchange, notifySessionStart } from './telegram-notify.js'
import type { ModelPreference } from '../../shared/model-preference.js'
import { profilePreference } from '../../shared/key-preference.js'
import { getCachedContextInstant } from './context-builder.js'
import { getOwnerName } from './profile.js'
import {
  buildOllamaToolDefs,
  executeOllamaTool,
  OLLAMA_NO_TOOLS_SENTENCE,
  ollamaCosPipelineConfigured,
  parseToolArguments,
  type OllamaToolDef,
} from './ollama-tools.js'
import { historyToOllamaMessages } from './ollama-bridge.js'
import { TOOL_HONESTY_CLAUSE, UNTRUSTED_CONTENT_CLAUSE } from './claude-tool-access.js'
import { ollamaTrailOutcome, ollamaTrailStep, type JobTrailDraft } from './job-trail.js'
import { keyLanesActive } from './key-lanes.js'
import * as keyNotices from './key-notices.js'
import { KEY_LANE_REFUSAL_COPY } from './key-notices.js'
import { classifyUpstreamStatus } from './key-relay-errors.js'
import { getPublicKey } from './key-store.js'
import { logTokenAudit } from './token-audit.js'
import { getKeyCatalog, keyModelPrice, keyModelSupportsTools, type KeyCatalog } from './key-catalog.js'
import { DirectSseParser, parseDirectJsonBody, type DirectToolCall } from './direct-sse.js'
import type {
  AnswerKeyFields,
  KeyKind,
  KeyProfile,
  KeyRef,
  PublicKeyRecord,
  RelayFailureKind,
} from './key-relay-contract.js'

// ── Limits ───────────────────────────────────────────────────────────────────

/** Requests per turn, counted as fetches like Ollama's MAX_CHAT_POSTS. Post 5 is the closing fetch. */
export const DIRECT_MAX_POSTS = 5
/** Plan 4.6: C1 retries 429, 5xx and network errors twice. */
export const DIRECT_MAX_RETRIES = 2
/** Plan 4.6: honor Retry-After up to this; a longer one stops the turn with the 429 line. */
export const DIRECT_RETRY_AFTER_MAX_MS = 30_000
/** Wait before a retry when the server sent no Retry-After. */
export const DIRECT_RETRY_BACKOFF_MS = [1_000, 3_000] as const
/** `max_tokens` on every request, so the relay's reservation is bounded (plan 4.5). */
export const DIRECT_MAX_OUTPUT_TOKENS = 4096
const INACTIVITY_MS = 60_000
const WALL_MAX_MS = 180_000
const WALL_HARD_MAX_MS = 300_000
const TOOL_HEARTBEAT_MS = 5_000
const ERROR_BODY_MAX_CHARS = 8_192

// ── Endpoints and D7 ─────────────────────────────────────────────────────────

/**
 * Chat-completions URL per key kind. A custom compatible key uses its own base URL. No Anthropic
 * entry: P1's profile policy (key-profiles.ts engineModelProblem) refuses a direct profile on an
 * Anthropic key, so an Anthropic key here answers "cannot answer direct".
 */
export const DIRECT_ENDPOINTS: Readonly<Partial<Record<KeyKind, string>>> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
}

/** Where a direct turn on this key posts, or null when the key cannot answer direct. */
export function directEndpointFor(key: Pick<PublicKeyRecord, 'kind' | 'baseUrl'>): string | null {
  if (key.kind === 'openai-compatible') {
    if (!key.baseUrl) return null
    try {
      const u = new URL(key.baseUrl)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
      // QA N5: a key saved before the https rule still never posts in the clear to another host.
      if (u.protocol === 'http:' && !isLoopbackEndpoint(u.toString())) return null
      return `${key.baseUrl.replace(/\/+$/, '')}/chat/completions`
    } catch {
      return null
    }
  }
  return Object.prototype.hasOwnProperty.call(DIRECT_ENDPOINTS, key.kind) ? DIRECT_ENDPOINTS[key.kind] ?? null : null
}

/** True only for 127.0.0.0/8, ::1 and `localhost`. Anything unparseable is remote. */
export function isLoopbackEndpoint(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host === 'localhost' || host === '::1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return !!m && m.slice(1).every(o => Number(o) <= 255)
}

/**
 * Decision D7: COS read tools (meetings, memories) are OFF for any non-loopback endpoint unless
 * this profile opted in. A loopback endpoint keeps meeting text on this Mac, so it gets them.
 */
export function directToolsAllowed(profile: Pick<KeyProfile, 'directTools'>, endpoint: string): boolean {
  if (profile.directTools === true) return true
  return isLoopbackEndpoint(endpoint)
}

// ── The relay port (in process; P2's meter and upstream client implement it) ──

/**
 * What a direct turn is bound to. P2's KeyRelay (`issueTurn`) is the HTTP nonce relay for CLI
 * children and its RelayEngine has no `direct`; plan 4.1 puts C1 in process ("calls the same
 * meter and upstream client, no HTTP hop"). This is that in-process door. P11 registers an
 * implementation backed by P2's shared meter, breakers and readKeySecretForRelay().
 */
export interface DirectTurnBinding {
  keyRef: KeyRef
  keyKind: KeyKind
  profileId: string
  turnId: string
  sessionId: string
  /** The profile's model; the relay forwards only this. */
  model: string
  /** The exact chat-completions URL this module decided D7 for. The relay posts only here. */
  endpoint: string
}

/** Why a direct turn or post was refused before any byte went upstream. */
export type DirectRefusalKind = RelayFailureKind | 'breaker_open' | 'lanes_inactive' | 'key_missing'

/** What this module measured for one post. `null` from the caller means none arrived. */
export interface DirectUsage {
  input: number
  output: number
  /** Provider-reported cost (OpenRouter `usage.cost`); the relay prices tokens when absent. */
  costUsd?: number
  generationId?: string
}

export interface DirectRelayPost {
  /** The upstream response, untouched (status, headers, streamed body). */
  response: Response
  /**
   * Call exactly once per post. `null` means no usage arrived (stream cut): the relay settles the
   * full reservation. A non-2xx response is settled as `{ input: 0, output: 0 }` (not billed).
   */
  settle(usage: DirectUsage | null): void
}

export interface DirectRelayTurn {
  /**
   * Reserve against the key's daily cap, then forward `body` to the binding's endpoint with the
   * real key. Never retries. `{ refused }` when the cap, breaker or key says no before sending.
   */
  post(body: Record<string, unknown>, signal: AbortSignal): Promise<DirectRelayPost | { refused: DirectRefusalKind }>
  /** Spent today on this key including open reservations, for the near-cap label. */
  spentTodayUsd?(): number
  close(): void
}

export interface DirectRelay {
  openTurn(binding: DirectTurnBinding): Promise<{ ok: true; turn: DirectRelayTurn } | { ok: false; refused: DirectRefusalKind }>
}

type DirectRelayResolver = () => DirectRelay | Promise<DirectRelay>
let relayResolver: DirectRelayResolver | null = null

/** P11 wires the real relay. Null unregisters (tests). */
export function registerDirectRelay(resolver: DirectRelayResolver | null): void {
  relayResolver = resolver
}

export function directRelayRegistered(): boolean {
  return relayResolver !== null
}

// ── Copy (P8 key-notices.ts) ─────────────────────────────────────────────────

/**
 * The part of P8's `server/lib/key-notices.ts` this lane uses, by its exported names and shapes.
 * P8 is the one source of key-lane strings; the module is imported statically (P11) and these
 * types are kept as the narrow seam tests inject through `options.notices`.
 */
export type DirectNoticeVariant = 'c1-tools-off' | 'c1-tools-on'
export interface DirectNoticeContext {
  variant: DirectNoticeVariant
  profileId: string
  keyKind: KeyKind
  capUsd: number
  modelLabel: string
  costUsd?: number
  spentTodayUsd?: number
  timeZone?: string
}
export type DirectNoticeSeen = Readonly<Record<string, string>>
export type DirectNoticeView =
  | { form: 'first-time'; fingerprint: string; header: string; body: string[]; footer: string; label: string }
  | { form: 'compact'; fingerprint: string; label: string }
export type DirectNoticeErrorId = RelayFailureKind | 'breaker_open' | 'profile_off' | 'profile_removed'
export interface DirectNoticeErrorParams {
  keyKind?: KeyKind
  capUsd?: number
  modelLabel?: string
  profileLabel?: string
  now?: Date
  timeZone?: string
}
export interface DirectNoticeCopy {
  keyLaneNotice(ctx: DirectNoticeContext, seen: DirectNoticeSeen | undefined): DirectNoticeView
  keyNoticeError(id: DirectNoticeErrorId, params?: DirectNoticeErrorParams): string
  keyModelLabel(slug: string): string
}

/** P8's module, imported statically since the P11 merge (it is pure: no file, env, clock or socket). */
export async function loadDirectNotices(): Promise<DirectNoticeCopy | null> {
  return keyNotices
}

/** The direct-only lines, from key-notices.ts (P11 moved them there). */
export const DIRECT_COPY = {
  copyUnavailable: KEY_LANE_REFUSAL_COPY.directCopyUnavailable,
  relayUnavailable: KEY_LANE_REFUSAL_COPY.relayUnavailable,
  wrongEngine: KEY_LANE_REFUSAL_COPY.wrongEngineDirect,
  noEndpoint: KEY_LANE_REFUSAL_COPY.directNoEndpoint,
  scheduled: KEY_LANE_REFUSAL_COPY.scheduled,
  textOnly: KEY_LANE_REFUSAL_COPY.directTextOnly,
  empty: KEY_LANE_REFUSAL_COPY.directEmpty,
  toolCap: KEY_LANE_REFUSAL_COPY.directToolCap,
  cancelled: KEY_LANE_REFUSAL_COPY.directCancelled,
} as const

// ── Status mapping (plan 4.6) ────────────────────────────────────────────────

/**
 * P2's classifyUpstreamStatus (key-relay-errors.ts), the one model-gone pattern. Any other non-2xx
 * it passes through (403 moderation, a plain 400) ends the turn with the upstream-error line, which
 * never counts toward a breaker.
 */
export function classifyDirectStatus(status: number, bodyText = ''): RelayFailureKind | null {
  if (status >= 200 && status < 300) return null
  return classifyUpstreamStatus(status, bodyText) ?? 'upstream_error'
}

const RETRYABLE: ReadonlySet<DirectRefusalKind> = new Set(['rate_limited', 'upstream_error', 'network_error'])

/** Retry-After as milliseconds (seconds or an HTTP date), or null when absent or unreadable. */
export function parseRetryAfterMs(value: string | null | undefined, now: () => number = Date.now): number | null {
  if (!value || !value.trim()) return null
  const v = value.trim()
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000)
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(0, at - now()) : null
}

// ── Messages ─────────────────────────────────────────────────────────────────

export type DirectMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: DirectToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** One tool result, paired to its call by id (OpenAI wire). Never Ollama's `tool_name`. */
export function buildDirectToolMessage(call: DirectToolCall, result: string): DirectMessage {
  return { role: 'tool', tool_call_id: call.id, content: result }
}

/**
 * The direct system prompt. Not buildOllamaSystemPrompt: that one says "READ-ONLY Ollama path"
 * and offers to escalate to Opus or Codex, both wrong here. Same glasses display rules.
 */
export function buildDirectSystemPrompt(input: {
  ownerName: string
  cachedContext: string
  historyPrompt: string
  toolNames: readonly string[]
}): string {
  const owner = input.ownerName.trim() || 'the wearer'
  const parts = [
    `You are COS, ${owner}'s chief of staff, answering on smart glasses.`,
    'Answer in plain text. No markdown, no bullet characters, no emoji.',
    'Aim for 300 to 600 characters. Up to about 2000 when the answer genuinely needs it.',
  ]
  if (input.cachedContext.trim()) {
    parts.push(input.cachedContext.trim())
    parts.push(
      "The context block above is TODAY'S calendar and tasks. It is not the meeting archive. \"No more meetings today\" describes today's schedule only.",
    )
  }
  if (input.historyPrompt.trim()) parts.push(input.historyPrompt.trim())
  if (input.toolNames.length > 0) {
    parts.push([
      'This request runs on a direct, read-only path.',
      `Available tools: ${input.toolNames.join(', ')}. Writes, Bash, MCP, web search, web fetch, and photos are not available here.`,
      'An absent name means it is not on this path. Do not claim a connector is down.',
      'Empty search hits plus a reason report the result of THIS call; they are not proof that no meetings or memories exist.',
      'A read_meeting miss means not found for that path, not that the meeting does not exist.',
      TOOL_HONESTY_CLAUSE,
      UNTRUSTED_CONTENT_CLAUSE,
    ].join('\n'))
  } else {
    parts.push(OLLAMA_NO_TOOLS_SENTENCE)
  }
  return parts.join('\n\n')
}

// ── The turn ─────────────────────────────────────────────────────────────────

export interface DirectCallOptions extends CallOptions {
  /** Tests inject; production uses the registered relay. */
  relay?: DirectRelay
  /** Tests inject; production loads P8's key-notices.ts. */
  notices?: DirectNoticeCopy
  /** Seen-state from `deviation-notices.json`; the caller persists after "got it". */
  noticeSeen?: DirectNoticeSeen
  /** The notice for this answer, before the first chunk (first-time form or compact label). */
  onKeyNotice?: (view: DirectNoticeView) => void
  catalog?: KeyCatalog
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  timeZone?: string
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolveSleep => {
    if (signal.aborted) return resolveSleep()
    const timer = setTimeout(resolveSleep, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolveSleep() }, { once: true })
  })
}

function endpointOrigin(endpoint: string): string {
  try { return new URL(endpoint).origin } catch { return 'invalid' }
}

type PostOutcome =
  | { kind: 'text' }
  | { kind: 'tools'; calls: DirectToolCall[]; text: string }
  | { kind: 'empty' }
  | { kind: 'failed'; failure: DirectRefusalKind | 'tool_overflow'; detail: string }
  | { kind: 'aborted' }

export async function callDirectStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  profile: KeyProfile,
  images?: ModelImageInput[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: DirectCallOptions,
): Promise<string> {
  const sid = getOrCreateSession(sessionId)
  const imageInputs = images ?? []
  // The predicate comes first, before any key-lane file read or import. P8's module is loaded
  // after it only to word the refusal (it is pure: no file, env, clock or socket).
  const active = keyLanesActive()
  const notices = options?.notices ?? await loadDirectNotices()
  const modelLabel = notices ? notices.keyModelLabel(profile.model) : profile.model
  const key = active ? getPublicKey(profile.keyRef) : undefined
  const errorParams = (): DirectNoticeErrorParams => ({
    ...(key ? { keyKind: key.kind, capUsd: key.capUsd } : {}),
    modelLabel,
    profileLabel: profile.label,
    now: new Date(),
    ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
  })
  const lensLine = (id: DirectNoticeErrorId): string => notices ? notices.keyNoticeError(id, errorParams()) : DIRECT_COPY.copyUnavailable
  const refuse = async (line: string): Promise<string> => {
    cleanupModelImageInputs(imageInputs)
    await callbacks.onError(line)
    return sid
  }

  // Every refusal runs here, before history, the run ledger or a request. The subscription is
  // never the fallback.
  if (!active) return refuse(lensLine('profile_off'))
  if (profile.engine !== 'direct') return refuse(DIRECT_COPY.wrongEngine)
  if (!profile.enabled) return refuse(lensLine('profile_off'))
  if (options?.dispatch) return refuse(DIRECT_COPY.scheduled)
  if (!key) return refuse(lensLine('profile_removed'))
  if (!notices) return refuse(DIRECT_COPY.copyUnavailable)
  if (imageInputs.length > 0 || (options?.requestAttachments?.length ?? 0) > 0) return refuse(DIRECT_COPY.textOnly)
  const endpoint = directEndpointFor(key)
  if (!endpoint) return refuse(DIRECT_COPY.noEndpoint)
  let relay: DirectRelay | null = options?.relay ?? null
  if (!relay && relayResolver) {
    try { relay = await relayResolver() } catch { relay = null }
  }
  if (!relay) return refuse(DIRECT_COPY.relayUnavailable)

  const turnId = options?.turnId ?? `direct-${Date.now().toString(36)}`
  let opened: Awaited<ReturnType<DirectRelay['openTurn']>>
  try {
    opened = await relay.openTurn({
      keyRef: profile.keyRef,
      keyKind: key.kind,
      profileId: profile.id,
      turnId,
      sessionId: sid,
      model: profile.model,
      endpoint,
    })
  } catch {
    return refuse(DIRECT_COPY.relayUnavailable)
  }
  if (!opened.ok) return refuse(refusalLine(opened.refused, lensLine))
  const relayTurn = opened.turn

  const catalog = options?.catalog ?? getKeyCatalog()
  catalog.refreshInBackground()
  const catalogModels = catalog.peek()
  const price = keyModelPrice(profile.model, catalogModels)

  // D7, then the pipeline and the model. A model the catalog says cannot call tools gets none.
  const toolsOn = directToolsAllowed(profile, endpoint)
    && ollamaCosPipelineConfigured()
    && keyModelSupportsTools(profile.model, catalogModels) !== false
  // OpenAI's tool schema is the Ollama one (`{ type: 'function', function: {...} }`).
  const toolDefs: OllamaToolDef[] = toolsOn ? buildOllamaToolDefs() : []
  const toolNames = toolDefs.map(def => def.function.name)

  const noticeContext = (extra: { costUsd?: number } = {}): DirectNoticeContext => ({
    variant: toolDefs.length > 0 ? 'c1-tools-on' : 'c1-tools-off',
    profileId: profile.id,
    keyKind: key.kind,
    capUsd: key.capUsd,
    modelLabel,
    ...(relayTurn.spentTodayUsd ? { spentTodayUsd: relayTurn.spentTodayUsd() } : {}),
    ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
    ...extra,
  })

  const history = getHistory(sid)
  const session = getSessionRaw(sid)
  const contextBreaks = session?.contextBreaks ?? []
  const historyPrompt = formatHistoryForPrompt(history, contextBreaks, reference)
  const handoffPrompt = options?.handoffContext?.promptBlock ? `\n\n${options.handoffContext.promptBlock}` : ''
  const systemPrompt = buildDirectSystemPrompt({
    ownerName: getOwnerName(),
    cachedContext: getCachedContextInstant(),
    historyPrompt: `${historyPrompt}${handoffPrompt}`,
    toolNames,
  })

  // A keyed exchange is stamped with its profile (P6 persists it by syntax), never a model slot.
  const exchangeModel = profilePreference(profile.id) as unknown as ModelPreference
  const keyLane: AnswerKeyFields = { lane: 'direct', credential: { kind: key.kind, ref: key.ref, profileId: profile.id } }
  const startTime = Date.now()
  const run = startDirectRun({
    turnId: options?.turnId,
    clientJobId: options?.clientJobId,
    cosSessionId: sid,
    model: profilePreference(profile.id),
    profile: profile.id,
    providerModel: profile.model,
    origin: endpointOrigin(endpoint),
    query,
  })
  const startMeta: ModelRunMetadata = {
    clientJobId: options?.clientJobId,
    generation: options?.generation,
    keyLane,
    directRunId: run.runId,
  }
  callbacks.onStart?.(exchangeModel, sid, undefined, startMeta)
  try { options?.onKeyNotice?.(notices.keyLaneNotice(noticeContext(), options?.noticeSeen)) } catch { /* display only */ }

  const jobGeneration = options?.jobGeneration ?? options?.generation
  const durableIdentity = options?.clientJobId && Number.isSafeInteger(jobGeneration) && jobGeneration! > 0
    ? { clientJobId: options.clientJobId, generation: jobGeneration! } : undefined
  if (durableIdentity) {
    reconcileExchangeByJobIdentity(sid, durableIdentity, 'user', query, globalMsgNum, undefined, undefined, exchangeModel)
  } else {
    addExchange(sid, 'user', query, globalMsgNum, undefined, durableIdentity, exchangeModel)
  }
  if (isNewSession(sid)) {
    notifySessionStart(sid, query)
    markSessionNotified(sid)
  }

  const messages: DirectMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyToOllamaMessages(history, contextBreaks),
    { role: 'user', content: query },
  ]

  const abort = new AbortController()
  const onExternalAbort = () => abort.abort()
  options?.abortSignal?.addEventListener('abort', onExternalAbort, { once: true })
  const sleep = options?.sleep ?? defaultSleep

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  let wallTimer: ReturnType<typeof setTimeout> | undefined
  let toolHeartbeat: ReturnType<typeof setInterval> | undefined
  let timedOut = false
  const clearTimers = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    if (wallTimer) clearTimeout(wallTimer)
    if (toolHeartbeat) { clearInterval(toolHeartbeat); toolHeartbeat = undefined }
  }
  const bumpInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => { timedOut = true; abort.abort() }, INACTIVITY_MS)
  }
  const bumpWall = () => {
    const elapsed = Date.now() - startTime
    const remainingToHardMax = WALL_HARD_MAX_MS - elapsed
    if (remainingToHardMax <= 0) return
    const next = Math.min(remainingToHardMax, Math.max(0, WALL_MAX_MS - elapsed) + 60_000)
    if (wallTimer) clearTimeout(wallTimer)
    wallTimer = setTimeout(() => { timedOut = true; abort.abort() }, next)
  }

  let fullText = ''
  let finalized = false
  const usageTotals = { input: 0, output: 0, usd: 0, measured: false }
  const trail = (draft: JobTrailDraft) => {
    if (!callbacks.onTrail) return
    try { callbacks.onTrail(draft) } catch { /* observation only */ }
  }

  const audit = (text: string) => {
    logTokenAudit({
      source: options?.lightweight ? 'g2-voice' : 'g2-query',
      model: profile.model,
      inputChars: messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0),
      outputChars: text.length,
      durationMs: Date.now() - startTime,
      caller: 'direct_query',
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      runId: run.runId,
      sessionId: sid,
      ...(options?.clientJobId ? { clientJobId: options.clientJobId } : {}),
      usageKind: usageTotals.measured ? 'provider_final' : 'estimated',
      profile: profile.id,
      lane: 'direct',
      credentialKind: key.kind,
      usd: Math.round(usageTotals.usd * 1e6) / 1e6,
    })
  }

  const finalizeError = async (ledgerError: string, line: string) => {
    if (finalized) return
    finalized = true
    clearTimers()
    finishDirectRun(run.runId, { status: 'failed', startedAtMs: startTime, error: ledgerError })
    audit(fullText)
    await callbacks.onError(line)
  }
  const finalizeDone = async () => {
    if (finalized) return
    finalized = true
    clearTimers()
    const text = fullText.trim()
    if (!text) {
      finishDirectRun(run.runId, { status: 'failed', startedAtMs: startTime, error: 'direct-bridge: [empty] no answer' })
      audit('')
      await callbacks.onError(DIRECT_COPY.empty)
      return
    }
    if (durableIdentity) {
      reconcileExchangeByJobIdentity(sid, durableIdentity, 'assistant', text, globalMsgNum, undefined, undefined, exchangeModel)
    } else {
      addExchange(sid, 'assistant', text, globalMsgNum, undefined, durableIdentity, exchangeModel)
    }
    finishDirectRun(run.runId, { status: 'completed', startedAtMs: startTime, output: text })
    audit(text)
    notifyExchange(sid, query, text)
    let keyNotice: DirectNoticeView | undefined
    try { keyNotice = notices.keyLaneNotice(noticeContext({ costUsd: usageTotals.usd }), options?.noticeSeen) } catch { /* display only */ }
    const doneMeta: ModelRunMetadata & { keyNotice?: DirectNoticeView } = {
      clientJobId: options?.clientJobId,
      generation: options?.generation,
      keyLane,
      directRunId: run.runId,
      usd: usageTotals.usd,
      ...(keyNotice ? { keyNotice } : {}),
    }
    await callbacks.onDone(text, exchangeModel, undefined, doneMeta)
  }

  const failureLine = (failure: DirectRefusalKind | 'tool_overflow'): string =>
    failure === 'tool_overflow' ? lensLine('upstream_error') : refusalLine(failure, lensLine)

  let postCount = 0
  let toolsRetried = false
  let sendTools = toolDefs.length > 0

  const settleOnce = (post: DirectRelayPost) => {
    let done = false
    return (usage: DirectUsage | null) => {
      if (done) return
      done = true
      try { post.settle(usage) } catch { /* metering failure never breaks the answer */ }
    }
  }

  /** One request, with the plan 4.6 retry loop around the status. */
  const runPost = async (): Promise<PostOutcome> => {
    postCount += 1
    const body: Record<string, unknown> = {
      model: profile.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: DIRECT_MAX_OUTPUT_TOKENS,
    }
    if (sendTools && toolDefs.length > 0) body.tools = toolDefs

    let attempt = 0
    for (;;) {
      if (abort.signal.aborted) return { kind: 'aborted' }
      bumpInactivity()
      let result: DirectRelayPost | { refused: DirectRefusalKind }
      try {
        result = await relayTurn.post(body, abort.signal)
      } catch (error) {
        if (abort.signal.aborted) return { kind: 'aborted' }
        const detail = error instanceof Error ? error.message.slice(0, 160) : 'network error'
        if (attempt < DIRECT_MAX_RETRIES) {
          await sleep(DIRECT_RETRY_BACKOFF_MS[attempt] ?? 3_000, abort.signal)
          attempt += 1
          continue
        }
        return { kind: 'failed', failure: 'network_error', detail }
      }
      if ('refused' in result) return { kind: 'failed', failure: result.refused, detail: 'refused by relay' }
      const settle = settleOnce(result)
      const response = result.response
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, ERROR_BODY_MAX_CHARS)
        settle({ input: 0, output: 0 })
        // A server that rejects the tools key gets ONE retry without it, first post only, and the
        // retry does not take a post slot (the Ollama rule).
        if (response.status === 400 && body.tools && !toolsRetried && postCount === 1 && /tool/i.test(detail)) {
          toolsRetried = true
          sendTools = false
          delete body.tools
          continue
        }
        const failure = classifyDirectStatus(response.status, detail) ?? 'upstream_error'
        if (RETRYABLE.has(failure) && attempt < DIRECT_MAX_RETRIES) {
          const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'))
          if (retryAfter !== null && retryAfter > DIRECT_RETRY_AFTER_MAX_MS) {
            return { kind: 'failed', failure, detail: `HTTP ${response.status} retry-after ${retryAfter}ms` }
          }
          await sleep(retryAfter ?? DIRECT_RETRY_BACKOFF_MS[attempt] ?? 3_000, abort.signal)
          attempt += 1
          continue
        }
        return { kind: 'failed', failure, detail: `HTTP ${response.status} ${detail.replace(/\s+/g, ' ').slice(0, 160)}` }
      }
      return readStream(response, settle)
    }
  }

  const readStream = async (response: Response, settle: (u: DirectUsage | null) => void): Promise<PostOutcome> => {
    const idPrefix = `call_${run.runId}_${postCount}`
    const roundStart = fullText.length
    const onText = (text: string) => {
      fullText += text
      callbacks.onChunk(text)
    }
    let parser: DirectSseParser
    let streamError: string | null = null
    try {
      const contentType = response.headers.get('content-type') ?? ''
      if (/application\/json/i.test(contentType) && !/event-stream/i.test(contentType)) {
        const parsed = parseDirectJsonBody(await response.text(), idPrefix)
        parser = parsed.parser
        for (const ev of parsed.events) {
          if (ev.type === 'text') onText(ev.text)
          else if (ev.type === 'error') streamError = ev.message
        }
      } else {
        if (!response.body) {
          settle(null)
          return { kind: 'failed', failure: 'upstream_error', detail: 'empty stream' }
        }
        parser = new DirectSseParser(idPrefix)
        const reader = response.body.getReader()
        let ended = false
        while (!ended) {
          const { done, value } = await reader.read()
          if (done) break
          bumpInactivity()
          for (const ev of parser.push(value)) {
            if (ev.type === 'text') onText(ev.text)
            else if (ev.type === 'error') { streamError = ev.message; ended = true }
            else if (ev.type === 'done') ended = true
          }
        }
        if (ended) await reader.cancel().catch(() => undefined)
        else for (const ev of parser.finish()) {
          if (ev.type === 'text') onText(ev.text)
          else if (ev.type === 'error') streamError = ev.message
        }
      }
    } catch (error) {
      settle(null)
      if (abort.signal.aborted) return { kind: 'aborted' }
      return { kind: 'failed', failure: 'network_error', detail: error instanceof Error ? error.message.slice(0, 160) : 'stream failed' }
    }
    if (parser.usage) {
      const usd = parser.usage.costUsd ?? (parser.usage.input * price.inUsdPerM + parser.usage.output * price.outUsdPerM) / 1e6
      usageTotals.input += parser.usage.input
      usageTotals.output += parser.usage.output
      usageTotals.usd += usd
      usageTotals.measured = true
      settle({
        input: parser.usage.input,
        output: parser.usage.output,
        ...(parser.usage.costUsd !== undefined ? { costUsd: parser.usage.costUsd } : {}),
        ...((response.headers.get('x-generation-id') || parser.generationId) ? { generationId: response.headers.get('x-generation-id') || parser.generationId! } : {}),
      })
    } else {
      settle(null)
    }
    const roundText = fullText.slice(roundStart)
    if (streamError) {
      return parser.tools.error()
        ? { kind: 'failed', failure: 'tool_overflow', detail: streamError }
        : { kind: 'failed', failure: 'upstream_error', detail: streamError }
    }
    const calls = parser.tools.calls()
    if (calls.length > 0) return { kind: 'tools', calls, text: roundText }
    return roundText.trim() ? { kind: 'text' } : { kind: 'empty' }
  }

  bumpInactivity()
  wallTimer = setTimeout(() => { timedOut = true; abort.abort() }, WALL_MAX_MS)

  try {
    for (;;) {
      const roundStart = fullText.length
      const round = await runPost()
      if (round.kind === 'aborted') {
        await finalizeError(
          timedOut ? 'direct-bridge: [network_error] timed out' : 'direct-bridge: [cancelled] request aborted',
          timedOut ? lensLine('network_error') : DIRECT_COPY.cancelled,
        )
        return sid
      }
      if (round.kind === 'failed') {
        await finalizeError(`direct-bridge: [${round.failure}] ${round.detail}`, failureLine(round.failure))
        return sid
      }
      if (callbacks.onTrail && (round.kind === 'text' || round.kind === 'tools')) {
        const roundText = fullText.slice(roundStart)
        if (roundText.trim()) trail({ kind: 'prose', text: roundText })
      }
      if (round.kind === 'text') { await finalizeDone(); return sid }
      if (round.kind === 'empty') {
        await finalizeError('direct-bridge: [empty] no answer', DIRECT_COPY.empty)
        return sid
      }

      // D7 backstop: tools were not offered, so a call is never run. The text (if any) stands.
      if (toolDefs.length === 0 || !sendTools) {
        if (round.text.trim()) { await finalizeDone(); return sid }
        await finalizeError('direct-bridge: [empty] tool call without tools', DIRECT_COPY.empty)
        return sid
      }
      // Post 5 is the closing fetch: its calls are not run and there is never a sixth post.
      if (postCount >= DIRECT_MAX_POSTS) {
        await finalizeError('direct-bridge: tool round cap reached without a final answer.', DIRECT_COPY.toolCap)
        return sid
      }

      messages.push({ role: 'assistant', content: round.text.trim() ? round.text : null, tool_calls: round.calls })
      for (const call of round.calls) {
        if (finalized || abort.signal.aborted) break
        const name = call.function.name
        const args = parseToolArguments(call.function.arguments)
        // executeOllamaTool answers any name outside its closed allowlist with `unknown tool`.
        callbacks.onToolStatus?.(name)
        if (callbacks.onTrail) trail(ollamaTrailStep(name, args))
        toolHeartbeat = setInterval(bumpInactivity, TOOL_HEARTBEAT_MS)
        let result: string
        try {
          result = await executeOllamaTool(name, args, abort.signal)
        } finally {
          if (toolHeartbeat) { clearInterval(toolHeartbeat); toolHeartbeat = undefined }
        }
        if (result === 'aborted' || abort.signal.aborted) {
          await finalizeError('direct-bridge: tool call aborted.', timedOut ? lensLine('network_error') : DIRECT_COPY.cancelled)
          return sid
        }
        if (callbacks.onTrail) trail(ollamaTrailOutcome(result))
        messages.push(buildDirectToolMessage(call, result))
      }
      if (finalized) return sid
      if (abort.signal.aborted) {
        await finalizeError('direct-bridge: tool call aborted.', timedOut ? lensLine('network_error') : DIRECT_COPY.cancelled)
        return sid
      }
      bumpWall()
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.slice(0, 160) : 'failed'
    await finalizeError(`direct-bridge: [upstream_error] ${detail}`, lensLine('upstream_error'))
    return sid
  } finally {
    clearTimers()
    options?.abortSignal?.removeEventListener('abort', onExternalAbort)
    try { relayTurn.close() } catch { /* best effort */ }
  }
}

/** The lens line for a refusal kind. */
function refusalLine(kind: DirectRefusalKind, lensLine: (id: DirectNoticeErrorId) => string): string {
  if (kind === 'lanes_inactive') return lensLine('profile_off')
  if (kind === 'key_missing') return lensLine('profile_removed')
  return lensLine(kind)
}
