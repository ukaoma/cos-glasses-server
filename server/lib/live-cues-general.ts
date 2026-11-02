// General live cues (default off): a server-wide runner that now and then looks up ONE interesting public fact, news item or
// local happening for a Mac meeting, outside the focused cue pipeline. Plan: operations/personal/wk44_2026/live-cues-grounding
// (PLAN_live_cues_v3 Track 2, CONTRACT_v3 sections 1, 3, 4, 5).
//
// This is the first automatic path from spoken words to a web search, so it is built to stop, not to try: it runs only for an
// extended (Mac) meeting that is armed and not paused, in cue mode general or all, with the owner's Public topics consent on and
// a domain that is not personal. It NEVER runs inside the focused engine's evaluate() and never touches that engine's
// inFlight, failures, lastCueAt, caps or breaker, so a slow search cannot silence a focused cue (validation 1, 3).
//
// How it stops (every recurring model caller must answer this):
//  - ONE attempt in flight server-wide; a tick per meeting at most every intervalSeconds and only after ~90 s of new speech.
//  - Four durable caps, charged synchronously BEFORE the call they pay for and never refunded: topic calls per meeting
//    (attempts) and per day, web searches per day, cues per meeting. The file is local-day keyed and fails CLOSED: an
//    unreadable file, a future day or a failed write means no call.
//  - A server-wide breaker, persisted: three consecutive failures (or one provider quota error) open it for an hour. A clean
//    attempt clears the streak only when it got at least as deep as the stage that failed, so a Jev "no" says nothing about
//    the search provider. Search failures count (searchMeetingWeb swallows them into empty sources, which the typed wrapper
//    below turns back into a failure).
//  - Its own AbortController, a 60 s wall on the search and a wall on the whole attempt. end, pause, suspend and a mode change
//    abort it (abortSession, abortAll, modeChanged); the session and mode are checked again before the search and before emit.
//  - A cue older than 180 s from its window is dropped, never shown late.
//
// Privacy order inside an attempt: the deterministic sensitive-window skip, then the Jev trigger, then the Haiku topic, then
// admitCueTopic (no digit, deny word, name or repeat), then the search. The query text lives in the emitted cue's log row only;
// a trace row carries a hash. Search cost is not readable (the search process is stopped after result.json), so `usd` is the
// topic and writer model cost only.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { JevError } from './jev.js'
import { DecisionProviderError } from './decision-provider.js'
import { LensGistLimitError, redactSecrets, runLensGistEngine } from './lens-gist-engines.js'
import { searchMeetingWeb } from './meeting-ask-web.js'
import { publicHttpsUrl } from './public-https-url.js'
import {
  GENERAL_INSIGHT_CONTEXT_CHARS, GENERAL_INSIGHT_SOURCE_CHARS, GENERAL_INSIGHT_WRITER_SYSTEM, GENERAL_TOPIC_SYSTEM, generalInsightPrompt, generalTopicPrompt,
  parseGeneralInsight, parseGeneralTopic, type GeneralCueCategory, type InsightSourceIn,
} from './live-cues-general-prompts.js'
import {
  HASHABLE_REJECTIONS, admitCueTopic, blockedNameWords, ownerTermJoins, ownerTermPhrases, queryHash, realProfileNames, sensitiveWindow, withHomeArea, type AdmitReason,
  type ProfileNameSource,
} from './live-cues-general-topic.js'

// ── Limits and shared types (names follow CONTRACT_v3; settings v3 and the shared types land with the modes branch) ──
export const LIVE_CUES_GENERAL_LIMITS = {
  /** How often the runner looks at its meetings. A meeting's own cadence is intervalSeconds. */
  pollMs: 15_000,
  /** ~90 s of speech: the engine's own rate is ~2.5 words a second (live-cues-v2.ts staleWords) at ~5.7 characters a word. The
   *  host counts characters fed since the meeting was armed (monotonic), so a rolling window cannot hide new speech. */
  minNewTranscriptChars: 1_200,
  /** ~3 minutes of speech at that rate; the topic prompt's ceiling is 6,000. */
  topicWindowChars: 2_700,
  searchWallMs: 60_000,
  /** The whole attempt: Jev 20 s + topic 20 s + search 60 s + writer 20 s, with room. */
  attemptWallMs: 150_000,
  /** A cue is dropped when it is older than this from the moment its window was read. */
  staleMs: 180_000,
  queryCacheMs: 30 * 60_000,
  breakerFailures: 3,
  breakerMs: 60 * 60_000,
  modelTimeoutMs: 20_000,
  topicMaxOutputTokens: 150,
  writerMaxOutputTokens: 400,
  /** Per-meeting counters expire after a day, like the focused engine's. */
  counterTtlMs: 24 * 60 * 60_000,
  skipTraceEveryMs: 5 * 60_000,
  /** At most this many search sources reach the writer. */
  writerSources: 5,
} as const
/** The topic model is pinned: a spawn without --model can become Opus (gotchas). Same id live-cues-v2 maps 'haiku' to. */
export const GENERAL_TOPIC_MODEL = 'claude-haiku-5-5'

export type GeneralCueMode = 'focused' | 'general' | 'all'
export type { GeneralCueCategory } from './live-cues-general-prompts.js'
export interface GeneralCueLimits { intervalSeconds: number; trigger: number; attemptsPerMeeting: number; maxCuesPerMeeting: number; dailyTopicCalls: number; dailyWebSearches: number }
export interface GeneralCuesToday { day: string; topicCalls: number; webSearches: number; breakerOpenUntil: number | null }
export type GeneralCueState = 'off' | 'waiting' | 'capped' | 'withheld' | 'breaker' | 'needs_public_topics'
export interface GeneralCueStatus { state: GeneralCueState; reason?: string; cues: number; attempts: number }

/** A cited web source on an insight: kind web, https only, at most two per cue (isLiveCueV2). Fits CueSourceRef. */
export interface GeneralInsightSource { id: string; date: string; title: string; kind: 'web'; url: string }
/** What the host turns into a LiveCueV2 of kind 'insight' (log row `general: {category, query}`). */
export interface GeneralInsight {
  headline: string
  detail: string
  category: GeneralCueCategory
  /** The admitted query. For the cue log row only; never a trace field. */
  query: string
  sources: GeneralInsightSource[]
  /** P(yes) from the trigger, as the cue's admission probability. */
  gate: number
  /** The model the writer reported, when it said. */
  model?: string
  /** When the window this fact was chosen from was read, and when the fact was handed over (ms). */
  windowAt: number
  createdAt: number
}

/** One meeting as the host (the live-cues engine) shows it to the runner. */
export interface GeneralCueCandidate {
  sessionId: string
  /** extended = a Mac recording, the only meeting that may carry an insight. */
  kindSet: 'legacy' | 'extended'
  armed: boolean
  paused: boolean
  /** The CONFIRMED Ask orientation domain, or null when unconfirmed. Never the sidecar default (all 974 saved sidecars say personal). */
  domain: string | null
  /** True when the orientation could not be READ (it threw), as opposed to not being confirmed (domain null). The meeting is then
   *  withheld: an unreadable orientation may be a personal meeting. */
  domainUnreadable?: boolean
  title: string
  /** Cleaned characters fed to this meeting since it was armed. Monotonic: a rolling window's length is not this. */
  transcriptChars: number
  /** The last `chars` characters of the cleaned transcript, as of now. */
  window(chars: number): string
  /** Names the host knows, to keep out of a query: the speakers the ASR path reported and the capitalized words of the calendar
   *  title. (A speaker label that opens a line of the window is read from the window itself.) */
  speakerNames?: readonly string[]
}
export interface GeneralCueHost {
  candidates(): GeneralCueCandidate[]
  /** Emits the insight for the meeting; false when the host did not (meeting gone, log or emit refused). */
  emit(sessionId: string, insight: GeneralInsight): boolean
}
export interface GeneralCueSettingsReader {
  cueMode(): GeneralCueMode
  limits(): GeneralCueLimits
  /** Ask Public topics consent. */
  publicTopics(): boolean
  /** The owner's city-level home area (profile home_city that passes HOME_AREA_LABEL), or null. */
  homeArea(): string | null
}
export interface GeneralModelOut { text: string; costUsd?: number; inputTokens?: number; outputTokens?: number; model?: string }
export interface GeneralSearchSource { id: string; title: string; text: string; url?: string }
export interface GeneralCueDeps {
  /** The Jev (or SubQ) trigger: P(yes) for the room being on a public topic. */
  jevTrigger(title: string, window: string, signal: AbortSignal): Promise<{ pGeneral: number; tokens: number }>
  topicModel(system: string, prompt: string, signal: AbortSignal): Promise<GeneralModelOut>
  /** searchMeetingWeb's shape; the runner types the result. */
  search(query: string, signal: AbortSignal): Promise<{ sources: GeneralSearchSource[]; notices?: string[] }>
  writer(system: string, prompt: string, signal: AbortSignal): Promise<GeneralModelOut>
  now(): number
  statePath: string
  trace?(row: GeneralTickRow): void
  /** Names the owner's profile offers (default: the real profile). */
  profile?: ProfileNameSource
  /** Where the internal daily trigger cap is read from (default process.env). */
  env?: NodeJS.ProcessEnv
}

/** An internal ceiling on Jev trigger calls a local day: not a user setting (so not in the settings contract), env only. The
 *  trigger runs on every tick of every eligible meeting, so it has a cap of its own beside the topic and search caps. */
export const GENERAL_TRIGGER_CAP = { default: 300, min: 1, max: 2000, env: 'COS_LIVE_CUES_GENERAL_DAILY_TRIGGERS' } as const
export function dailyTriggerCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GENERAL_TRIGGER_CAP.env]
  const n = raw !== undefined && /^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  return n >= GENERAL_TRIGGER_CAP.min && n <= GENERAL_TRIGGER_CAP.max ? n : GENERAL_TRIGGER_CAP.default
}

/** CONTRACT_v3 section 5. `reason` is a code, never text from the meeting. */
export interface GeneralTickRow {
  type: 'general_tick'
  at: string
  sessionId: string
  pGeneral: number | null
  outcome: 'cue' | 'no_cue' | 'cancelled' | 'failure' | 'skip'
  reason: string
  category: GeneralCueCategory | null
  queryHash: string | null
  searchMs: number | null
  sourcesCount: number | null
  writerMs: number | null
  usd: number | null
  /** Input tokens of the Jev trigger request (additive to CONTRACT_v3 section 5). */
  jevTokens: number | null
}

// ── Eligibility ─────────────────────────────────────────────────────────────
export type GeneralEligibility = { ok: true } | { ok: false; state: 'off' | 'needs_public_topics' | 'withheld'; reason: string }
const GENERAL_MODES: ReadonlySet<string> = new Set(['general', 'all'])
export function generalModeOn(mode: string): boolean { return GENERAL_MODES.has(mode) }
/** The one place that decides whether a meeting may have general cues; used at every tick and again before the search and emit.
 *
 *  DOMAIN. `c.domain` must come only from the confirmed Ask orientation (MeetingAskStore.orientation(sessionId).domain, null when
 *  unconfirmed). A recording sidecar's domain is NOT a classification: all 974 saved sidecars carry 'personal' as a default,
 *  work calls included. So only a confirmed 'personal' skips the meeting; null proceeds, and the content checks (sensitive
 *  window, admission) still apply to it. An orientation that cannot be READ (`domainUnreadable`) is not null: it is withheld. */
export function generalEligibility(c: GeneralCueCandidate, mode: GeneralCueMode, publicTopics: boolean): GeneralEligibility {
  const off = (reason: string): GeneralEligibility => ({ ok: false, state: 'off', reason })
  if (!generalModeOn(mode)) return off('mode_focused')
  if (c.kindSet !== 'extended') return off('not_extended')
  if (!c.armed) return off('not_armed')
  if (c.paused) return off('paused')
  if (!publicTopics) return { ok: false, state: 'needs_public_topics', reason: 'public_topics_off' }
  if (c.domainUnreadable) return { ok: false, state: 'withheld', reason: 'orientation_unreadable' }
  if (c.domain?.trim().toLowerCase() === 'personal') return { ok: false, state: 'withheld', reason: 'personal_domain' }
  return { ok: true }
}

// ── Durable state ───────────────────────────────────────────────────────────
/** Pipeline stages, deepest last. A clean attempt that reached `depth` clears a failure streak whose deepest stage is <= depth. */
const STAGES = ['trigger', 'topic', 'search', 'writer'] as const
type Stage = typeof STAGES[number]
const stageRank = (s: Stage): number => STAGES.indexOf(s) + 1
interface MeetingCounters { attempts: number; cues: number; at: number }
interface StoredBreaker { failures: number; stage: number; openUntil: number | null }
interface StoreState { v: 1; zone: string; day: string; topicCalls: number; webSearches: number; triggerCalls: number; meetings: Record<string, MeetingCounters>; breaker: StoredBreaker }
type StoreRead = { ok: true; state: StoreState } | { ok: false }
export type ChargeResult = 'ok' | 'unreadable' | 'daily_cap' | 'meeting_cap' | 'write_failed'

function validZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || !zone) return null
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return zone } catch { return null }
}
/** Local calendar day (YYYY-MM-DD) in `zone`. Intl, never toISOString: a UTC key flips the day at 19:00 Central. (The same rule as
 *  live-cues-v2.ts localDay, kept here so this module never imports the engine that imports it.) */
function localDay(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export class GeneralCueStore {
  constructor(private readonly file: string, private readonly now: () => number) {}
  private systemZone(): string { return validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC' }
  private fresh(nowMs: number): StoreState {
    const zone = this.systemZone()
    return { v: 1, zone, day: localDay(nowMs, zone), topicCalls: 0, webSearches: 0, triggerCalls: 0, meetings: {}, breaker: { failures: 0, stage: 0, openUntil: null } }
  }
  /** A missing file is a fresh day. Anything else that is not a valid state (unparseable, wrong shape, a future day, a negative or
   *  fractional count, an unreadable path) is `ok: false`, and every caller treats that as "do not spend". */
  read(): StoreRead {
    const nowMs = this.now()
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')) } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, state: this.fresh(nowMs) }
      return { ok: false }
    }
    if (!isRecord(raw) || raw.v !== 1) return { ok: false }
    const zone = validZone(raw.zone), today = zone ? localDay(nowMs, zone) : ''
    if (!zone || typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day) || raw.day > today) return { ok: false }
    if (!whole(raw.topicCalls) || !whole(raw.webSearches) || !(raw.triggerCalls === undefined || whole(raw.triggerCalls)) || !isRecord(raw.meetings) || !isRecord(raw.breaker)) return { ok: false }
    const b = raw.breaker
    if (!whole(b.failures) || !whole(b.stage) || b.stage > STAGES.length || !(b.openUntil === null || (typeof b.openUntil === 'number' && Number.isFinite(b.openUntil)))) return { ok: false }
    const meetings: Record<string, MeetingCounters> = {}
    for (const [id, m] of Object.entries(raw.meetings)) {
      if (!isRecord(m) || !whole(m.attempts) || !whole(m.cues) || typeof m.at !== 'number' || !Number.isFinite(m.at)) return { ok: false }
      if (m.at >= nowMs - LIVE_CUES_GENERAL_LIMITS.counterTtlMs) meetings[id] = { attempts: m.attempts, cues: m.cues, at: m.at }
    }
    const rolled = raw.day < today
    const open = b.openUntil !== null && b.openUntil > nowMs
    return { ok: true, state: { v: 1, zone, day: today, topicCalls: rolled ? 0 : raw.topicCalls, webSearches: rolled ? 0 : raw.webSearches, triggerCalls: rolled ? 0 : (raw.triggerCalls ?? 0), meetings,
      breaker: open ? { failures: 0, stage: 0, openUntil: b.openUntil as number } : { failures: b.failures, stage: b.stage, openUntil: null } } }
  }
  private write(s: StoreState): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      durableAtomicWriteFileSync(this.file, JSON.stringify(s) + '\n', { mode: 0o600 })
      return true
    } catch { return false }
  }
  /** Charge one topic call (and one attempt for this meeting) BEFORE the call. Never refunded. */
  chargeTopic(sessionId: string, caps: { daily: number; perMeeting: number }): ChargeResult {
    const r = this.read()
    if (!r.ok) return 'unreadable'
    const s = r.state, m = s.meetings[sessionId] ?? { attempts: 0, cues: 0, at: 0 }
    if (s.topicCalls >= caps.daily) return 'daily_cap'
    if (m.attempts >= caps.perMeeting) return 'meeting_cap'
    s.topicCalls += 1
    s.meetings[sessionId] = { ...m, attempts: m.attempts + 1, at: this.now() }
    return this.write(s) ? 'ok' : 'write_failed'
  }
  /** Charge one Jev trigger call BEFORE it is sent. Never refunded. */
  chargeTrigger(cap: number): ChargeResult {
    const r = this.read()
    if (!r.ok) return 'unreadable'
    if (r.state.triggerCalls >= cap) return 'daily_cap'
    r.state.triggerCalls += 1
    return this.write(r.state) ? 'ok' : 'write_failed'
  }
  /** Charge one web search BEFORE it starts. Never refunded. */
  chargeSearch(cap: number): ChargeResult {
    const r = this.read()
    if (!r.ok) return 'unreadable'
    if (r.state.webSearches >= cap) return 'daily_cap'
    r.state.webSearches += 1
    return this.write(r.state) ? 'ok' : 'write_failed'
  }
  recordCue(sessionId: string): boolean {
    const r = this.read()
    if (!r.ok) return false
    const m = r.state.meetings[sessionId] ?? { attempts: 0, cues: 0, at: 0 }
    r.state.meetings[sessionId] = { ...m, cues: m.cues + 1, at: this.now() }
    return this.write(r.state)
  }
  /** One failure at `stage`. Three in a row (or `immediate`, a provider quota error) open the breaker for an hour. */
  recordFailure(stage: Stage, immediate = false): boolean {
    const r = this.read()
    if (!r.ok) return false
    const b = r.state.breaker
    b.failures += 1
    b.stage = Math.max(b.stage, stageRank(stage))
    if (immediate || b.failures >= LIVE_CUES_GENERAL_LIMITS.breakerFailures) r.state.breaker = { failures: 0, stage: 0, openUntil: this.now() + LIVE_CUES_GENERAL_LIMITS.breakerMs }
    return this.write(r.state)
  }
  /** A clean attempt that reached `depth` clears the streak only when it got at least as deep as the deepest stage that failed. */
  recordClean(depth: number): void {
    const r = this.read()
    if (!r.ok) return
    const b = r.state.breaker
    if (b.failures > 0 && depth >= b.stage) { r.state.breaker = { failures: 0, stage: 0, openUntil: null }; this.write(r.state) }
  }
  meeting(sessionId: string): { attempts: number; cues: number } | null {
    const r = this.read()
    if (!r.ok) return null
    const m = r.state.meetings[sessionId]
    return { attempts: m?.attempts ?? 0, cues: m?.cues ?? 0 }
  }
  /** Today for the settings view. An unreadable file reads as spent (saturated), like the focused engine's day. */
  today(): GeneralCuesToday {
    const r = this.read()
    if (!r.ok) return { day: localDay(this.now(), this.systemZone()), topicCalls: Number.MAX_SAFE_INTEGER, webSearches: Number.MAX_SAFE_INTEGER, breakerOpenUntil: null }
    return { day: r.state.day, topicCalls: r.state.topicCalls, webSearches: r.state.webSearches, breakerOpenUntil: r.state.breaker.openUntil }
  }
}

// ── Typed search ────────────────────────────────────────────────────────────
export type GeneralSearchResult =
  | { ok: true; sources: InsightSourceIn[] }
  | { ok: false; code: 'no_sources' | 'timeout' | 'error' | 'aborted' }
const abortError = (): Error => { const e = new Error('aborted'); e.name = 'AbortError'; return e }
const isCancel = (error: unknown, signal: AbortSignal): boolean => signal.aborted || (error instanceof Error && error.name === 'AbortError')
/** Settles when `promise` does, or rejects with an AbortError the moment `signal` aborts: a dependency that ignores its signal
 *  can then never hold the server-wide single flight. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(abortError()) }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(v => { signal.removeEventListener('abort', onAbort); resolve(v) }, e => { signal.removeEventListener('abort', onAbort); reject(e) })
  })
}
/** searchMeetingWeb swallows a failed search into `{sources: []}` plus a notice, so the focused breaker could never see it. This
 *  types the answer: ok needs at least one https source (publicHttpsUrl-checked); no https source, a throw and the 60 s wall are
 *  failures; the caller's own abort is `aborted` (a cancel, not a failure). */
export async function typedGeneralSearch(search: GeneralCueDeps['search'], query: string, parent: AbortSignal, wallMs: number = LIVE_CUES_GENERAL_LIMITS.searchWallMs): Promise<GeneralSearchResult> {
  const own = new AbortController()
  let timedOut = false
  const onAbort = () => own.abort()
  parent.addEventListener('abort', onAbort, { once: true })
  if (parent.aborted) own.abort()
  const timer = setTimeout(() => { timedOut = true; own.abort() }, wallMs)
  timer.unref?.()
  try {
    const out = await raceAbort(search(query, own.signal), own.signal)
    const sources: InsightSourceIn[] = []
    for (const s of out.sources ?? []) {
      const url = publicHttpsUrl(s?.url)
      if (!url || typeof s.id !== 'string' || sources.some(x => x.url === url)) continue
      sources.push({ id: s.id, title: redactSecrets(String(s.title ?? '')).slice(0, 160), text: redactSecrets(String(s.text ?? '')).slice(0, GENERAL_INSIGHT_SOURCE_CHARS), url })
      if (sources.length >= LIVE_CUES_GENERAL_LIMITS.writerSources) break
    }
    return sources.length ? { ok: true, sources } : { ok: false, code: 'no_sources' }
  } catch {
    if (parent.aborted) return { ok: false, code: 'aborted' }
    return { ok: false, code: timedOut ? 'timeout' : 'error' }
  } finally {
    clearTimeout(timer)
    parent.removeEventListener('abort', onAbort)
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────
/** Decision-provider codes that stop quietly (Jev's own cap, breaker or key): not a failure, so not toward the breaker. Kept in
 *  step with QUIET_DECISION_STOPS in live-cues-v2.ts, which this module cannot import (that module imports this one). */
const QUIET_DECISION_CODES: ReadonlySet<string> = new Set(['jev_cap_reached', 'jev_breaker_open', 'jev_not_configured',
  'decision_cap_reached', 'decision_breaker_open', 'decision_not_configured', 'decision_invalid_provider'])
const WALL = 'general_wall'
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000
interface SeenSession { firstSeenAt: number; lastTickAt: number | null; lastTickChars: number; last: { state: GeneralCueState; reason: string } | null }
interface Run { stage: number; usd: number }
export interface GeneralTickResult { ran: boolean; why?: string; sessionId?: string; outcome?: GeneralTickRow['outcome']; reason?: string }

export class GeneralCueRunner {
  private readonly store: GeneralCueStore
  private readonly seen = new Map<string, SeenSession>()
  private inFlight: { sessionId: string; abort: AbortController } | null = null
  /** Normalized queries used by one meeting (its whole life) and by any meeting in the last 30 minutes. In memory only: the
   *  query text is never written to the state file. */
  private readonly meetingQueries = new Map<string, Set<string>>()
  private readonly crossQueries = new Map<string, number>()
  private readonly skipTracedAt = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly host: GeneralCueHost, private readonly settings: GeneralCueSettingsReader, private readonly deps: GeneralCueDeps) {
    this.store = new GeneralCueStore(deps.statePath, () => deps.now())
  }

  // ── Public surface ──
  /** For the settings view (registered with setGeneralCuesTodayProvider by the engine wiring). */
  generalCuesToday(): GeneralCuesToday { return this.store.today() }

  /** The per-meeting status line for Control (CONTRACT section 4), or null when the host does not know the meeting. */
  status(sessionId: string): GeneralCueStatus | null {
    const c = this.host.candidates().find(x => x.sessionId === sessionId)
    if (!c) return null
    const counts = this.store.meeting(sessionId)
    const base = { cues: counts?.cues ?? 0, attempts: counts?.attempts ?? 0 }
    const el = generalEligibility(c, this.settings.cueMode(), this.settings.publicTopics())
    if (!el.ok) return { state: el.state, reason: el.reason, ...base }
    const block = this.blocked(sessionId, this.settings.limits(), this.deps.now())
    if (block) return { state: block.state, reason: block.reason, ...base }
    const last = this.seen.get(sessionId)?.last
    return last ? { state: last.state, reason: last.reason, ...base } : { state: 'waiting', ...base }
  }

  /** Aborts the attempt in flight for this meeting (end, pause, suspend). Returns whether one was running. */
  abortSession(sessionId: string, reason = 'session_ended'): boolean {
    if (this.inFlight?.sessionId !== sessionId) return false
    this.inFlight.abort.abort(reason)
    return true
  }
  /** Aborts whatever is in flight (v2 switched off, shutdown). */
  abortAll(reason = 'suspended'): boolean {
    if (!this.inFlight) return false
    this.inFlight.abort.abort(reason)
    return true
  }
  /** The meeting ended: abort its attempt and forget what the runner holds for it. */
  endSession(sessionId: string): void {
    this.abortSession(sessionId, 'session_ended')
    this.seen.delete(sessionId)
    this.meetingQueries.delete(sessionId)
  }
  /** Call after the cue mode is saved: leaving general mode aborts the attempt in flight at once. */
  modeChanged(): void { if (!generalModeOn(this.settings.cueMode())) this.abortAll('mode_changed') }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, LIVE_CUES_GENERAL_LIMITS.pollMs)
    this.timer.unref?.()
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.abortAll('stopped')
  }

  // ── Tick ──
  /** One pass over the meetings: starts at most ONE attempt, for the meeting that has waited longest. A host that throws ends the pass. */
  async tick(): Promise<GeneralTickResult> {
    const nowMs = this.deps.now()
    const mode = this.settings.cueMode()
    if (!generalModeOn(mode)) { this.abortAll('mode_changed'); this.seen.clear(); return { ran: false, why: 'mode_off' } }
    if (this.inFlight && !this.settings.publicTopics()) this.abortAll('consent_off')       // consent withdrawn: stop what is running
    if (this.inFlight) return { ran: false, why: 'busy' }
    const lim = this.settings.limits(), publicTopics = this.settings.publicTopics()
    let candidates: GeneralCueCandidate[]
    try { candidates = this.host.candidates() } catch { return { ran: false, why: 'host_error' } }
    const present = new Set(candidates.map(c => c.sessionId))
    for (const id of [...this.seen.keys()]) if (!present.has(id)) this.seen.delete(id)
    for (const id of [...this.meetingQueries.keys()]) if (!present.has(id)) this.meetingQueries.delete(id)
    const due: GeneralCueCandidate[] = []
    for (const c of candidates) {
      if (!generalEligibility(c, mode, publicTopics).ok) { this.seen.delete(c.sessionId); continue }
      let rec = this.seen.get(c.sessionId)
      if (!rec) { rec = { firstSeenAt: nowMs, lastTickAt: null, lastTickChars: 0, last: null }; this.seen.set(c.sessionId, rec) }
      if (nowMs - (rec.lastTickAt ?? rec.firstSeenAt) < lim.intervalSeconds * 1000) continue
      if (c.transcriptChars - rec.lastTickChars < LIVE_CUES_GENERAL_LIMITS.minNewTranscriptChars) continue
      due.push(c)
    }
    due.sort((a, b) => (this.seen.get(a.sessionId)!.lastTickAt ?? 0) - (this.seen.get(b.sessionId)!.lastTickAt ?? 0))
    for (const c of due) {
      const block = this.blocked(c.sessionId, lim, nowMs)
      if (block) { this.traceSkip(c.sessionId, block.reason, nowMs); continue }
      return this.attempt(c, lim, nowMs)
    }
    return { ran: false, why: due.length ? 'blocked' : 'not_due' }
  }

  /** Why no attempt may start for this meeting now, or null. Read before the Jev trigger, so a capped meeting costs nothing. */
  private blocked(sessionId: string, lim: GeneralCueLimits, nowMs: number): { state: 'capped' | 'breaker'; reason: string } | null {
    const r = this.store.read()
    if (!r.ok) return { state: 'capped', reason: 'state_unreadable' }
    const s = r.state
    if (s.breaker.openUntil !== null && s.breaker.openUntil > nowMs) return { state: 'breaker', reason: 'breaker_open' }
    if (s.triggerCalls >= dailyTriggerCap(this.deps.env)) return { state: 'capped', reason: 'daily_trigger_cap' }
    if (s.topicCalls >= lim.dailyTopicCalls) return { state: 'capped', reason: 'daily_topic_cap' }
    if (s.webSearches >= lim.dailyWebSearches) return { state: 'capped', reason: 'daily_search_cap' }
    const m = s.meetings[sessionId]
    if (m && m.attempts >= lim.attemptsPerMeeting) return { state: 'capped', reason: 'meeting_attempts_cap' }
    if (m && m.cues >= lim.maxCuesPerMeeting) return { state: 'capped', reason: 'meeting_cues_cap' }
    return null
  }

  private traceSkip(sessionId: string, reason: string, nowMs: number): void {
    const key = `${sessionId}:${reason}`
    if (nowMs - (this.skipTracedAt.get(key) ?? 0) < LIVE_CUES_GENERAL_LIMITS.skipTraceEveryMs) return
    this.skipTracedAt.set(key, nowMs)
    this.writeTrace({ type: 'general_tick', at: new Date(nowMs).toISOString(), sessionId, pGeneral: null, outcome: 'skip', reason, category: null, queryHash: null,
      searchMs: null, sourcesCount: null, writerMs: null, usd: null, jevTokens: null })
  }
  private writeTrace(row: GeneralTickRow): void { try { this.deps.trace?.(row) } catch { /* the trace is best effort */ } }

  private recentQueries(sessionId: string, nowMs: number): Set<string> {
    for (const [q, at] of this.crossQueries) if (nowMs - at >= LIVE_CUES_GENERAL_LIMITS.queryCacheMs) this.crossQueries.delete(q)
    return new Set([...this.crossQueries.keys(), ...(this.meetingQueries.get(sessionId) ?? [])])
  }
  private noteQuery(sessionId: string, normalized: string, nowMs: number): void {
    this.crossQueries.set(normalized, nowMs)
    const set = this.meetingQueries.get(sessionId) ?? new Set<string>()
    set.add(normalized)
    this.meetingQueries.set(sessionId, set)
  }

  /** Public topics consent, right now. Checked on its own right before the search and before emit: if it was withdrawn the attempt
   *  is stopped with the reason consent_off, not left to finish. */
  private consentOk(): boolean { return this.settings.publicTopics() === true }
  /** Consent was withdrawn mid-attempt: abort the attempt with that reason (it ends as a cancel, never a failure). */
  private consentWithdrawn(): never {
    this.inFlight?.abort.abort('consent_off')
    throw abortError()
  }
  /** Is the meeting still eligible right now (session still there, mode and consent unchanged)? Fresh from the host. */
  private live(sessionId: string): boolean {
    const c = this.host.candidates().find(x => x.sessionId === sessionId)
    return !!c && generalEligibility(c, this.settings.cueMode(), this.settings.publicTopics()).ok
  }

  // ── One attempt ──
  private async attempt(c: GeneralCueCandidate, lim: GeneralCueLimits, startedAt: number): Promise<GeneralTickResult> {
    const rec = this.seen.get(c.sessionId)!
    rec.lastTickAt = startedAt
    rec.lastTickChars = c.transcriptChars
    rec.last = null
    const abort = new AbortController()
    this.inFlight = { sessionId: c.sessionId, abort }            // synchronously: nothing awaits between the busy check and here
    const run: Run = { stage: 0, usd: 0 }
    const row: GeneralTickRow = { type: 'general_tick', at: new Date(startedAt).toISOString(), sessionId: c.sessionId, pGeneral: null, outcome: 'no_cue', reason: '',
      category: null, queryHash: null, searchMs: null, sourcesCount: null, writerMs: null, usd: null, jevTokens: null }
    const wall = setTimeout(() => abort.abort(WALL), LIVE_CUES_GENERAL_LIMITS.attemptWallMs)
    wall.unref?.()
    try {
      await this.pipeline(c, lim, abort.signal, row, run, rec, startedAt)
    } catch (error) {
      this.failed(error, abort.signal, row, run)
    } finally {
      clearTimeout(wall)
      this.inFlight = null
      if (run.usd > 0) row.usd = round4(run.usd)
      this.writeTrace(row)
    }
    return { ran: true, sessionId: c.sessionId, outcome: row.outcome, reason: row.reason }
  }

  private done(row: GeneralTickRow, outcome: 'cue' | 'no_cue', reason: string, depth = 0): void {
    row.outcome = outcome
    row.reason = reason
    if (depth > 0) this.store.recordClean(depth)
  }
  private fail(row: GeneralTickRow, stage: Stage, reason: string, immediate = false): void {
    row.outcome = 'failure'
    row.reason = reason
    this.store.recordFailure(stage, immediate)
  }
  private failed(error: unknown, signal: AbortSignal, row: GeneralTickRow, run: Run): void {
    const stage = STAGES[Math.max(1, run.stage) - 1]
    if (signal.aborted && signal.reason === WALL) return this.fail(row, stage, 'wall_timeout')
    if (isCancel(error, signal)) { row.outcome = 'cancelled'; row.reason = typeof signal.reason === 'string' ? signal.reason : 'aborted'; return }
    if ((error instanceof JevError || error instanceof DecisionProviderError) && QUIET_DECISION_CODES.has(error.code)) { row.outcome = 'no_cue'; row.reason = error.code; return }
    if (error instanceof LensGistLimitError) return this.fail(row, stage, 'quota', true)
    const code = error instanceof JevError || error instanceof DecisionProviderError ? error.code : 'error'
    this.fail(row, stage, `${stage}_failed:${code}`)
  }

  private async pipeline(c: GeneralCueCandidate, lim: GeneralCueLimits, signal: AbortSignal, row: GeneralTickRow, run: Run, rec: SeenSession, startedAt: number): Promise<void> {
    const profile = this.deps.profile ?? realProfileNames
    const window = redactSecrets(c.window(LIVE_CUES_GENERAL_LIMITS.topicWindowChars))

    // 1. Deterministic skip, before any model call: a window with private-life vocabulary never leaves the machine. (The owner's
    //    vocabulary does not skip a window: it guards the query, as whole terms, in admission.)
    const sensitive = sensitiveWindow(window)
    if (sensitive) { rec.last = { state: 'withheld', reason: 'sensitive_window' }; return this.done(row, 'no_cue', `sensitive:${sensitive}`) }

    // 1b. The names a query must not carry, read now, before any spend: the owner, every enrolled voice, the speakers the ASR path
    //     reported, the calendar title's capitalized words and the speaker labels in the window. If the voice names cannot be read
    //     the meeting is withheld (fail closed), not searched with fewer names.
    let nameWords: Set<string>
    try { nameWords = await raceAbort(blockedNameWords(window, c.speakerNames ?? [], profile), signal) } catch (error) {
      if (isCancel(error, signal)) throw error
      rec.last = { state: 'withheld', reason: 'names_unavailable' }
      return this.done(row, 'no_cue', 'names_unavailable')
    }

    // 2. Trigger (Jev), under its own daily cap, charged before the request.
    const triggered = this.store.chargeTrigger(dailyTriggerCap(this.deps.env))
    if (triggered !== 'ok') return this.done(row, 'no_cue', `cap:trigger_${triggered}`)
    run.stage = 1
    const trigger = await raceAbort(this.deps.jevTrigger(c.title, window, signal), signal)
    row.jevTokens = Number.isFinite(trigger.tokens) ? trigger.tokens : null
    row.pGeneral = Number.isFinite(trigger.pGeneral) ? Math.round(trigger.pGeneral * 1000) / 1000 : 0
    if (!(trigger.pGeneral >= lim.trigger)) return this.done(row, 'no_cue', 'trigger_below', 1)

    // 3. Topic (pinned Haiku). The call is charged first, in the durable file, and a refusal to charge ends the attempt.
    const charged = this.store.chargeTopic(c.sessionId, { daily: lim.dailyTopicCalls, perMeeting: lim.attemptsPerMeeting })
    if (charged !== 'ok') return this.done(row, 'no_cue', `cap:${charged}`)
    run.stage = 2
    const topicOut = await raceAbort(this.deps.topicModel(GENERAL_TOPIC_SYSTEM, generalTopicPrompt(window), signal), signal)
    run.usd += topicOut.costUsd ?? 0
    const topic = parseGeneralTopic(topicOut.text)
    if (topic === 'unparseable') return this.done(row, 'no_cue', 'topic_unparseable', 2)
    if (!topic.topic) return this.done(row, 'no_cue', 'no_topic', 2)
    row.category = topic.category

    // 4. Admission (deterministic), then the home area for a local query, admitted again as the new string it is.
    const ctx = { nameWords, terms: ownerTermPhrases(profile), joins: ownerTermJoins(profile), recent: this.recentQueries(c.sessionId, startedAt) }
    /** A trace row carries a hash only for a rejection that names nothing private: a repeat or a length. */
    const hashFor = (reason: AdmitReason, q: string): string | null => HASHABLE_REJECTIONS.has(reason) ? queryHash(q) : null
    let admitted = admitCueTopic(topic.query, ctx)
    if (!admitted.ok) { row.queryHash = hashFor(admitted.reason, topic.query); return this.done(row, 'no_cue', `rejected:${admitted.reason}`, 2) }
    if (topic.category === 'local') {
      const withArea = withHomeArea(admitted.query, this.settings.homeArea())
      if (withArea === null) { row.queryHash = queryHash(admitted.query); return this.done(row, 'no_cue', 'local_no_area', 2) }
      const again = admitCueTopic(withArea, ctx)
      if (!again.ok) { row.queryHash = hashFor(again.reason, withArea); return this.done(row, 'no_cue', `rejected_local:${again.reason}`, 2) }
      admitted = again
    }
    row.queryHash = queryHash(admitted.query)

    // 5. Search. The room, the mode or the consent may have changed during the topic call; the daily search is charged before it starts.
    if (!this.consentOk()) return this.consentWithdrawn()
    if (!this.live(c.sessionId)) return this.done(row, 'no_cue', 'not_eligible')
    const paid = this.store.chargeSearch(lim.dailyWebSearches)
    if (paid !== 'ok') return this.done(row, 'no_cue', `cap:${paid}`)
    this.noteQuery(c.sessionId, admitted.normalized, startedAt)
    run.stage = 3
    const t0 = this.deps.now()
    const found = await typedGeneralSearch(this.deps.search, admitted.query, signal)
    row.searchMs = this.deps.now() - t0
    if (!found.ok) {
      if (found.code === 'aborted') throw abortError()
      return this.fail(row, 'search', `search_${found.code}`)
    }
    row.sourcesCount = found.sources.length

    // 6. Writer. The context is the tail of the window that passed the sensitive check, not a fresh read of the room: what the
    //    writer is sent was checked, only for relevance.
    run.stage = 4
    const t1 = this.deps.now()
    const writerOut = await raceAbort(this.deps.writer(GENERAL_INSIGHT_WRITER_SYSTEM, generalInsightPrompt({ query: admitted.query, category: topic.category, sources: found.sources,
      context: window.slice(-GENERAL_INSIGHT_CONTEXT_CHARS) }), signal), signal)
    row.writerMs = this.deps.now() - t1
    run.usd += writerOut.costUsd ?? 0
    const insight = parseGeneralInsight(writerOut.text, found.sources)
    if (typeof insight === 'string') return this.done(row, 'no_cue', `writer_${insight}`, 4)

    // 7. Emit, only if it is still fresh and the meeting is still eligible. A late cue is dropped, never shown.
    if (this.deps.now() - startedAt > LIVE_CUES_GENERAL_LIMITS.staleMs) return this.done(row, 'no_cue', 'stale', 4)
    if (!this.consentOk()) return this.consentWithdrawn()
    if (!this.live(c.sessionId)) return this.done(row, 'no_cue', 'not_eligible', 4)
    const day = new Date(this.deps.now()).toLocaleDateString('en-CA')
    const cited = insight.sourceIds.map(id => found.sources.find(s => s.id === id)!)
    // A web source's id is opaque and stable per page, like a past meeting's: the same url gets the same id in every cue.
    const emitted = this.host.emit(c.sessionId, { headline: insight.headline, detail: insight.detail, category: topic.category, query: admitted.query,
      sources: cited.map(s => ({ id: `web_${createHash('sha256').update(s.url).digest('hex').slice(0, 12)}`, date: day, title: s.title, kind: 'web' as const, url: s.url })),
      gate: row.pGeneral ?? 0, ...(writerOut.model ? { model: writerOut.model } : {}), windowAt: startedAt, createdAt: this.deps.now() })
    if (!emitted) return this.done(row, 'no_cue', 'not_emitted', 4)
    this.store.recordCue(c.sessionId)
    this.done(row, 'cue', 'emitted', 4)
  }
}

// ── Real model calls (the engine wiring in phase 2 composes these) ──────────
function modelOut(run: Awaited<ReturnType<typeof runLensGistEngine>>): GeneralModelOut {
  return { text: run.text, costUsd: run.usage?.costUsd, inputTokens: run.usage?.inputTokens, outputTokens: run.usage?.outputTokens, model: run.model }
}
/** The topic call: the existing claude runner, model pinned to Haiku, audit source live-cues-general-topic. */
export async function runGeneralTopicModel(system: string, prompt: string, signal: AbortSignal): Promise<GeneralModelOut> {
  return modelOut(await runLensGistEngine('claude', GENERAL_TOPIC_MODEL, prompt, { system, timeoutMs: LIVE_CUES_GENERAL_LIMITS.modelTimeoutMs,
    source: 'live-cues-general-topic', maxOutputTokens: LIVE_CUES_GENERAL_LIMITS.topicMaxOutputTokens, signal }))
}
/** The writer call: the same runner and writer model as the focused cues (liveCuesV2Model), audit source live-cues-general. */
export async function runGeneralWriterModel(model: string, system: string, prompt: string, signal: AbortSignal): Promise<GeneralModelOut> {
  return modelOut(await runLensGistEngine('claude', model, prompt, { system, timeoutMs: LIVE_CUES_GENERAL_LIMITS.modelTimeoutMs,
    source: 'live-cues-general', maxOutputTokens: LIVE_CUES_GENERAL_LIMITS.writerMaxOutputTokens, signal }))
}
/** The search, ledgered as live_cues_general in the token audit. */
export function runGeneralSearch(query: string, signal: AbortSignal): ReturnType<GeneralCueDeps['search']> {
  return searchMeetingWeb(query, signal, { auditCaller: 'live_cues_general' })
}
/** Real dependencies. The engine passes its Jev/SubQ trigger and its writer model; nothing here imports the engine. */
export function realGeneralDeps(parts: { jevTrigger: GeneralCueDeps['jevTrigger']; writerModel: () => string; statePath: string; trace?: GeneralCueDeps['trace']; now?: () => number }): GeneralCueDeps {
  return {
    jevTrigger: parts.jevTrigger,
    topicModel: runGeneralTopicModel,
    search: runGeneralSearch,
    writer: (system, prompt, signal) => runGeneralWriterModel(parts.writerModel(), system, prompt, signal),
    now: parts.now ?? (() => Date.now()),
    statePath: parts.statePath,
    ...(parts.trace ? { trace: parts.trace } : {}),
  }
}
