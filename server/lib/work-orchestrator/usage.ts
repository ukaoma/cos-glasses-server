/**
 * 6.83.0 (M3 planner input, canary C1): how much PLAN usage each provider has left (Miles, Q2: plan usage only; a key
 * lane is never a silent fallback). Read without spending any of it.
 *
 *   Claude  `claude -p` stream-json control request `get_usage` with `skip_behaviors` (no turn, no transcript).
 *   Codex   `codex app-server` JSON-RPC `account/rateLimits/read` with `excludeResetCreditDetails`. Never sends
 *           `supportsLunaReserve` (it records experiment exposure); never calls ConsumeAccountRateLimitResetCredit.
 *   Cursor  unknown. Its only usage reader is the interactive TUI (which auto-updates the CLI) or a Keychain token;
 *           Miles has approved neither, so the server reads neither.
 *
 * Read ON DEMAND only (6.83.0 release decision, Miles has not approved a background poll for every user): a plan
 * input (`POST /api/work/orchestrator/input`, the moment a fork or a new session is chosen) re-reads a provider whose
 * reading is older than 2 minutes; `GET /api/work/orchestrator/usage` re-reads one older than 10 minutes (2 with
 * `refresh=1`). Nothing reads usage on a timer unless the owner opts in with `COS_WORK_USAGE_POLL=1` (every 10 minutes).
 * Passive refresh needs no probe: the `rate_limit_event` frames the server's own plan-lane Claude jobs already receive.
 * A `provider_limit` failure marks the provider exhausted until the reset it states (or one hour), and that beats any
 * cached percentage.
 *
 * How it stops: no timer by default; three failed probes in a row pause that provider's probe for an hour. Each probe
 * runs in a fresh empty directory with hooks and MCP off, and is killed by its exact PID after 15 seconds.
 * 7.0.39+: a Claude answer of "limits available" with none (its usage service refused the CLI) holds Claude's probe for
 * 10 minutes, saved across restarts, and counts toward the breaker. Every failed probe logs one line with a code.
 * 7.0.41: every failed probe holds that provider for 10 minutes, whatever the code.
 * 7.0.45: Cursor's plan usage can be read the same way (cursor-plan.ts), only when the server's environment says
 * COS_CURSOR_PLAN_USAGE=1 (a Keychain credential read, so the switch is Miles's typed call). Off, the note above stands:
 * no Keychain read, no network call, and Cursor stays "not read".
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { atomicWriteFileSync } from '../atomic-fs.js'
import { resolveProviderBinary } from '../provider-binary.js'
import { cursorPlanUsageOn, probeCursorUsage, type CursorDetail } from './cursor-plan.js'

export type UsageProvider = 'claude' | 'codex' | 'cursor'
export const USAGE_PROVIDERS: UsageProvider[] = ['claude', 'codex', 'cursor']
/** The opt-in poll's period (`COS_WORK_USAGE_POLL=1` only). */
export const USAGE_POLL_MS = 10 * 60_000
/** Before a plan (it may fork or start a session): a reading older than this is re-read. */
export const USAGE_FRESH_MS = 2 * 60_000
/** An on-demand usage read (GET /usage) answers from a reading younger than this. */
export const USAGE_CACHE_MS = 10 * 60_000
export const USAGE_STALE_MS = 25 * 60_000
export const USAGE_PROBE_TIMEOUT_MS = 15_000
export const USAGE_BREAKER_FAILURES = 3
export const USAGE_BREAKER_MS = 60 * 60_000
export const USAGE_LIMIT_DEFAULT_MS = 60 * 60_000
export const USAGE_LOW_HEADROOM = 15
/** 7.0.39+: after Claude answers "limits available" with no limits (its usage service refused the CLI, HTTP 429 on
 *  2026-11-14), COS waits this long before asking again. The CLI's own hold-off dies with its process, so COS keeps one,
 *  saved with the entry so it survives probes and restarts. */
export const USAGE_NO_LIMITS_HOLD_MS = 10 * 60_000
/** 7.0.41: the same hold after ANY failed read, so reopening the Usage view (or a plan) cannot retry a failing reader
 *  sooner than every 10 minutes (lead, 2026-11-14, after the 429). The 3-failure breaker still pauses it for an hour. */
export const USAGE_FAILURE_HOLD_MS = USAGE_NO_LIMITS_HOLD_MS

/** Why a probe failed, as a code: logged on every failure and served on the usage route (never an account detail). */
export type UsageFailureCode = 'no_limits' | 'unknown_shape' | 'refused' | 'timed_out' | 'exited' | 'not_found' | 'error'
  // 7.0.45, Cursor's read: the Keychain item missing, refused or locked; its sign-in expired (or a 401/403); a redirect; another HTTP status.
  | 'sign_in_missing' | 'keychain_refused' | 'keychain_locked' | 'sign_in_expired' | 'redirected' | 'http_error'
export class UsageProbeError extends Error {
  constructor(readonly code: UsageFailureCode, message: string) { super(message) }
}

/** The only failure words a client may read (route note, Work chat, log): the fixed messages the probes write. Anything
 *  else, such as an exception's own text (it can carry a path with the owner's user name), becomes "unexpected error" and
 *  its detail is kept nowhere. Applied when a failure is stored and again when a view is drawn, so a reason saved by an
 *  older build is checked too. */
const SAFE_FAILURE_TEXT = new Set(['Claude gave no plan limits (its usage service may be refusing reads)', 'codex not found',
  'get_usage refused', 'rateLimits/read refused', 'timed out', 'unknown get_usage shape', 'unknown rateLimits shape', 'unexpected error',
  'not probed inside a test', // runtime.ts's test-only stand-in probe
  // 7.0.45, Cursor (cursor-plan.ts): fixed words only, never the token or a reply.
  'Cursor CLI not found', 'Keychain read timed out', 'Cursor sign-in not found in the Keychain',
  'Keychain locked', 'Keychain read failed', "Cursor's sign-in was not shared with COS", 'Cursor sign-in expired', 'Cursor answered with a redirect', 'unknown Cursor usage shape'])
export function safeFailureText(text: string | null | undefined): string {
  if (!text) return 'unexpected error'
  return SAFE_FAILURE_TEXT.has(text) || /^exited (?:-?\d+|on error) before answering$/.test(text) || /^Cursor answered HTTP \d{1,3}$/.test(text) ? text : 'unexpected error'
}

export interface UsageWindow { kind: string; usedPct: number; resetsAt: string | null; durationMins?: number }
export interface UsageReading {
  plan: string | null
  windows: UsageWindow[]
  /** Codex `ordinaryUsageAllowed`; Claude false only when a window reports a lock. Null: not stated. */
  allowed: boolean | null
  /** Claude `rate_limits_available: false` (an API key or a third-party login): no plan limits to read. */
  available: boolean
  /** 7.0.45: Cursor's extras (its note, Auto-bucket models, on-demand). Never the bar. */
  cursor?: CursorDetail
}
export interface UsageEntry {
  provider: UsageProvider
  reading: UsageReading | null
  observedAt: number | null
  source: 'probe' | 'passive' | 'none'
  lastError: string | null
  failures: number
  pausedUntil: number | null
  /** Exhausted until this time, from a provider_limit failure or a rejected rate-limit frame. */
  limitUntil: number | null
  limitSource: string | null
  warning: boolean
  /** 7.0.39+: when the window an `allowed_warning` frame warned about resets. Past it, the warning no longer counts. */
  warningUntil?: number | null
  /** 7.0.39+: the last failure's code and time; cleared by a good read. */
  lastFailure?: UsageFailureCode | null
  lastFailureAt?: number | null
  /** 7.0.39+: no probe before this time (after a "no limits" answer). Kept across restarts, unlike the breaker's pause. */
  holdUntil?: number | null
  /** 7.0.39+: when a plan-lane COS job on this provider last finished with an answer: free proof that it answers. */
  answeredAt?: number | null
}
export type UsageState = 'ok' | 'low' | 'exhausted' | 'unknown'
/** What the planner sees: one line per provider. */
export interface UsageView { provider: UsageProvider; state: UsageState; headroomPct: number | null; resetsAt: string | null; ageSec: number | null; source: string; plan: string | null; stale: boolean; note: string
  /** 7.0.39+: why the last read failed (null after a good read), and when the last good read was. */
  reason?: UsageFailureCode | null; lastGoodAt?: string | null
  /** 7.0.39+: when a plan-lane COS job on this provider last finished with an answer. */
  answeredAt?: string | null }

/** The windows that bind: Claude's 5-hour session and weekly all-models; every Codex window; Cursor's Auto and API buckets
 *  (7.0.45: headroom is 100 minus the higher of the two; its included total is a note). */
const BINDING: Record<UsageProvider, (kind: string) => boolean> = {
  claude: kind => kind === 'session' || kind === 'weekly_all',
  codex: () => true,
  cursor: kind => kind === 'auto' || kind === 'api',
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const iso = (s: number) => new Date(s * 1000).toISOString()

/** 7.0.39+: what a successful `get_usage` reply means. `no_limits`: the CLI says plan limits apply but gives none, which
 *  is what it answers when its own read of the usage service failed (HTTP 429 on Miles's Mac, 2026-11-14). It is not an
 *  unknown shape and must never read as one. */
export function classifyClaudeUsage(r: unknown): { reading: UsageReading } | { code: 'no_limits' | 'unknown_shape' } {
  const v = r && typeof r === 'object' ? r as Record<string, any> : null
  if (v && v.rate_limits_available === true && v.rate_limits == null) return { code: 'no_limits' }
  const reading = parseClaudeUsage(r)
  return reading ? { reading } : { code: 'unknown_shape' }
}

/** Claude `get_usage` response (`response.response`). Classify on `kind`, never on a label. Null when the shape is not one we know. */
export function parseClaudeUsage(r: unknown): UsageReading | null {
  if (!r || typeof r !== 'object') return null
  const v = r as Record<string, any>
  if (v.rate_limits_available !== true) return typeof v.rate_limits_available === 'boolean' ? { plan: typeof v.subscription_type === 'string' ? v.subscription_type : null, windows: [], allowed: null, available: false } : null
  const limits = v.rate_limits?.limits
  if (!Array.isArray(limits)) return null
  const windows: UsageWindow[] = []
  let locked = false
  for (const l of limits) {
    if (!l || typeof l.kind !== 'string' || !num(l.percent) || l.percent < 0 || l.percent > 1000) return null
    windows.push({ kind: l.kind, usedPct: l.percent, resetsAt: typeof l.resets_at === 'string' && !Number.isNaN(Date.parse(l.resets_at)) ? new Date(Date.parse(l.resets_at)).toISOString() : null })
    if (l.severity === 'locked' || l.severity === 'blocked') locked = true
  }
  return { plan: typeof v.subscription_type === 'string' ? v.subscription_type : null, windows, allowed: locked ? false : null, available: true }
}

/** Codex `account/rateLimits/read` result. `ordinaryUsageAllowed` is authoritative over percentages (its schema says so). */
export function parseCodexUsage(r: unknown): UsageReading | null {
  if (!r || typeof r !== 'object') return null
  const v = r as Record<string, any>
  const limits = v.rateLimitsByLimitId?.codex ?? v.rateLimits
  if (!limits || typeof limits !== 'object') return null
  const windows: UsageWindow[] = []
  for (const [kind, w] of [['primary', limits.primary], ['secondary', limits.secondary]] as const) {
    if (w == null) continue
    if (typeof w !== 'object' || !num(w.usedPercent)) return null
    windows.push({ kind, usedPct: w.usedPercent, resetsAt: num(w.resetsAt) ? iso(w.resetsAt) : null, ...(num(w.windowDurationMins) ? { durationMins: w.windowDurationMins } : {}) })
  }
  const reached = limits.rateLimitReachedType != null || limits.spendControlReached === true
  const allowed = typeof v.ordinaryUsageAllowed === 'boolean' ? v.ordinaryUsageAllowed && !reached : reached ? false : null
  return { plan: typeof limits.planType === 'string' ? limits.planType : null, windows, allowed, available: true }
}

/** A reset time named in a provider's own limit text ("resets 2026-10-21T05:50Z", "resets in 3h", "try again in 20 minutes"). */
export function parseLimitReset(message: string, now: number): number | null {
  const isoMatch = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(message)
  if (isoMatch && !Number.isNaN(Date.parse(isoMatch[1]!))) return Date.parse(isoMatch[1]!)
  const rel = /\b(?:resets?|try again|retry)\s+in\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i.exec(message)
  if (rel) return now + Number(rel[1]) * (/^h/i.test(rel[2]!) ? 3_600_000 : 60_000)
  const epoch = /\bresets?(?:At)?["':\s]+(\d{10})\b/.exec(message)
  if (epoch) return Number(epoch[1]) * 1000
  return null
}

/** A window still counts until its own reset. Past it the percentage describes a window that has ended (7.0.39+: Work was
 *  shown Claude at 77% left from a week that reset 19 days earlier, because nothing checked). No reset given: it counts. */
export function windowLive(w: UsageWindow, now: number): boolean {
  if (!w.resetsAt) return true
  const t = Date.parse(w.resetsAt)
  return Number.isNaN(t) || t > now
}

export function headroomOf(provider: UsageProvider, reading: UsageReading | null, now: number = Date.now()): number | null {
  if (!reading || !reading.available) return null
  const bind = reading.windows.filter(w => BINDING[provider](w.kind) && windowLive(w, now))
  if (!bind.length) return null
  return Math.max(0, Math.round(100 - Math.max(...bind.map(w => w.usedPct))))
}

/** 7.0.45, the on-state words before Cursor's first read: what the Mac will ask. Never a suggestion to allow it always. */
export const CURSOR_FIRST_READ_NOTE = 'not read yet: the first read asks this Mac to share Cursor\'s sign-in from the Keychain with COS (a "security wants to use … cursor-access-token" prompt and your login password)'

export function viewOf(e: UsageEntry, now: number, cursorOn = false): UsageView {
  const ageSec = e.observedAt ? Math.round((now - e.observedAt) / 1000) : null
  const stale = !e.observedAt || now - e.observedAt > USAGE_STALE_MS
  const headroom = headroomOf(e.provider, e.reading, now)
  const allBind = (e.reading?.windows ?? []).filter(w => BINDING[e.provider](w.kind))
  const bind = allBind.filter(w => windowLive(w, now))
  const tightest = bind.length ? bind.reduce((a, b) => (b.usedPct > a.usedPct ? b : a)) : null
  const base = { provider: e.provider, ageSec, source: e.source, plan: e.reading?.plan ?? null, stale,
    reason: e.lastFailure ?? null, lastGoodAt: e.observedAt ? new Date(e.observedAt).toISOString() : null,
    answeredAt: e.answeredAt ? new Date(e.answeredAt).toISOString() : null }
  // A stated limit beats any percentage (canary C1 rule), until the time it names.
  if (e.limitUntil && e.limitUntil > now) {
    return { ...base, state: 'exhausted', headroomPct: 0, resetsAt: new Date(e.limitUntil).toISOString(), source: e.limitSource ?? 'provider_limit', note: 'plan limit reached' }
  }
  if (e.reading?.allowed === false) return { ...base, state: 'exhausted', headroomPct: 0, resetsAt: tightest?.resetsAt ?? null, note: 'the provider says ordinary usage is not allowed now' }
  // Off (the default): exactly as before 7.0.45, whatever an earlier on-period left in the cache.
  if (e.provider === 'cursor' && !cursorOn) return { ...base, state: 'unknown', headroomPct: null, resetsAt: null, note: 'not read: Cursor usage needs its app or a Keychain read, neither approved' }
  // Every window this reading had has reset: its numbers describe a window that is over, so they are not shown.
  if (e.reading?.available && allBind.length && !bind.length) {
    return { ...base, state: 'unknown', headroomPct: null, resetsAt: null, note: `not read since its window ended${e.lastError ? `; last read failed: ${safeFailureText(e.lastError)}` : ''}` }
  }
  if (!e.reading || headroom === null) return { ...base, state: 'unknown', headroomPct: null, resetsAt: null, note: e.reading && !e.reading.available ? 'no plan limits on this login' : e.lastError ? `not read: ${safeFailureText(e.lastError)}` : e.provider === 'cursor' ? CURSOR_FIRST_READ_NOTE : 'not read yet' }
  // A warning holds only until the window it warned about resets; an old frame cannot keep a new week at "low".
  const warned = e.warning && !(typeof e.warningUntil === 'number' && e.warningUntil <= now)
  const state: UsageState = headroom <= 0 ? 'exhausted' : headroom < USAGE_LOW_HEADROOM || warned ? 'low' : 'ok'
  return { ...base, state, headroomPct: headroom, resetsAt: tightest?.resetsAt ?? null, note: stale ? 'reading is old' : '' }
}

// ─── Which provider Work offers first (Miles, verified G2 turn, 2026-11-14) ───
// "Generally I would prefer using Claude unless I set the preference to something else", and an unknown plan reading
// must not push Claude or Codex aside. The order: the preferred provider first whenever it is not exhausted, unknown
// included; except when it is low and the other is ok, then the other first (the rule before this change, kept).
// Exhausted is never usable. Cursor is last and never a target: Work does not start Cursor sessions.
// There is no preference setting yet, so the preference is Claude in code.
export const WORK_DEFAULT_PROVIDER: 'claude' | 'codex' = 'claude'
export interface ProviderChoice { provider: UsageProvider; usable: boolean; why: string }
const NAME: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }

/** "10:52 AM" today, "Oct 23, 9:18 AM" another day, in the server's time zone. */
export function clockWords(iso: string, now: number, timeZone?: string): string {
  const t = new Date(iso), day = (d: Date) => d.toLocaleDateString('en-US', { timeZone })
  const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone })
  return day(t) === day(new Date(now)) ? time : `${t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone })}, ${time}`
}

export function providerOrder(views: Array<Pick<UsageView, 'provider' | 'state' | 'headroomPct' | 'resetsAt'> & Partial<UsageView>>, now: number,
  preference: 'claude' | 'codex' = WORK_DEFAULT_PROVIDER, timeZone?: string): ProviderChoice[] {
  const view = (p: UsageProvider) => views.find(v => v.provider === p)
  const state = (p: UsageProvider) => view(p)?.state ?? 'unknown'
  const usable = (p: UsageProvider) => state(p) !== 'exhausted'
  const other: 'claude' | 'codex' = preference === 'claude' ? 'codex' : 'claude'
  const left = (p: UsageProvider) => view(p)?.headroomPct
  const lowSwap = usable(preference) && state(preference) === 'low' && state(other) === 'ok'
  const order: Array<'claude' | 'codex'> = lowSwap || (!usable(preference) && usable(other)) ? [other, preference] : [preference, other]
  const unknownWords = (p: UsageProvider) => {
    const v = view(p)
    if (v?.answeredAt) return ` Its plan reading is unknown; a COS ${NAME[p]} job finished at ${clockWords(v.answeredAt, now, timeZone)}.`
    if (v?.lastGoodAt) return ` Its plan reading is unknown; COS has not seen it answer since ${clockWords(v.lastGoodAt, now, timeZone)}.`
    return ' Its plan reading is unknown; COS has not seen it answer yet.'
  }
  const detail = (p: UsageProvider) => state(p) === 'low' && left(p) != null ? ` (${left(p)}% of its plan left)` : ''
  const choices: ProviderChoice[] = order.map((p, i) => {
    if (!usable(p)) { const r = view(p)?.resetsAt; return { provider: p, usable: false, why: `${NAME[p]} is at its plan limit${r ? ` until ${clockWords(r, now, timeZone)}` : ''}.` } }
    const unknown = state(p) === 'unknown' ? unknownWords(p) : ''
    if (i === 0 && p === preference) return { provider: p, usable: true, why: `${NAME[p]}, your default${detail(p)}.${unknown}` }
    if (i === 0 && lowSwap) return { provider: p, usable: true, why: `${NAME[p]}, because ${NAME[preference]} is close to its plan limit (${NAME[preference]} ${left(preference)}% left, ${NAME[p]} ${left(p)}% left).` }
    if (i === 0) return { provider: p, usable: true, why: `${NAME[p]}, because ${NAME[preference]} is at its plan limit${detail(p)}.${unknown}` }
    return { provider: p, usable: true, why: `${NAME[p]}, next${detail(p)}.${unknown}` }
  })
  return [...choices, { provider: 'cursor', usable: false, why: 'Cursor comes last: Work does not start Cursor sessions.' }]
}

/** The background poll runs only when the owner opted in: `COS_WORK_USAGE_POLL=1`, nothing else. */
export function usagePollOptedIn(env: NodeJS.ProcessEnv = process.env): boolean { return env.COS_WORK_USAGE_POLL === '1' }

export interface UsageProbes {
  claude: () => Promise<UsageReading>
  codex: () => Promise<UsageReading>
  /** 7.0.45: called only while cursorPlanOn() is true. */
  cursor: () => Promise<UsageReading>
}

/** `cursorPlan` overrides the COS_CURSOR_PLAN_USAGE switch (tests); the server leaves it unset and reads the switch. */
export interface UsageMonitorOptions { path?: string; probes?: Partial<UsageProbes>; now?: () => number; pollEnabled?: boolean; cursorPlan?: boolean }

export class UsageMonitor {
  private entries: Record<UsageProvider, UsageEntry>
  private inflight: Partial<Record<UsageProvider, Promise<void>>> = {}
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number
  private readonly probes: UsageProbes
  constructor(private readonly options: UsageMonitorOptions = {}) {
    this.now = options.now ?? Date.now
    this.probes = { claude: options.probes?.claude ?? probeClaudeUsage, codex: options.probes?.codex ?? probeCodexUsage, cursor: options.probes?.cursor ?? (() => probeCursorUsage()) }
    const blank = (provider: UsageProvider): UsageEntry => ({ provider, reading: null, observedAt: null, source: 'none', lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false })
    this.entries = { claude: blank('claude'), codex: blank('codex'), cursor: blank('cursor') }
    if (options.path) {
      try {
        const saved = JSON.parse(readFileSync(options.path, 'utf8'))
        for (const p of USAGE_PROVIDERS) if (saved?.[p]?.provider === p) this.entries[p] = { ...this.entries[p], ...saved[p], failures: 0, pausedUntil: null }
      } catch { /* none saved yet */ }
    }
  }
  private save(): void {
    if (!this.options.path) return
    try { mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 }); atomicWriteFileSync(this.options.path, JSON.stringify(this.entries)) } catch { /* cache only */ }
  }
  entry(p: UsageProvider): UsageEntry { return this.entries[p] }
  /** 7.0.45: whether Cursor's plan read is on (COS_CURSOR_PLAN_USAGE=1). Off: no probe, no Keychain read, no network. */
  cursorPlanOn(): boolean { return this.options.cursorPlan ?? cursorPlanUsageOn() }
  views(): UsageView[] { const now = this.now(), on = this.cursorPlanOn(); return USAGE_PROVIDERS.map(p => viewOf(this.entries[p], now, on)) }
  /** Probe one provider now (shares a probe already running). Failures count toward the breaker; never throws. */
  refresh(p: 'claude' | 'codex' | 'cursor'): Promise<void> {
    if (p === 'cursor' && !this.cursorPlanOn()) return Promise.resolve() // the switch is checked before anything else
    if (this.inflight[p]) return this.inflight[p]!
    const e = this.entries[p]
    if (e.pausedUntil && e.pausedUntil > this.now()) return Promise.resolve()
    if (e.holdUntil && e.holdUntil > this.now()) return Promise.resolve()
    const run = (async () => {
      try {
        const reading = await this.probes[p]()
        e.reading = reading; e.observedAt = this.now(); e.source = 'probe'; e.lastError = null; e.failures = 0; e.pausedUntil = null; e.warning = false; e.warningUntil = null
        e.lastFailure = null; e.lastFailureAt = null; e.holdUntil = null
        // A fresh reading that says usage is allowed again clears an older limit only when its own reset passed.
        if (e.limitUntil && e.limitUntil <= this.now()) { e.limitUntil = null; e.limitSource = null }
      } catch (error) {
        const now = this.now()
        const code: UsageFailureCode = error instanceof UsageProbeError ? error.code : 'error'
        e.lastError = safeFailureText(String((error as Error)?.message ?? error).slice(0, 120))
        e.lastFailure = code; e.lastFailureAt = now
        e.failures++
        e.holdUntil = now + USAGE_FAILURE_HOLD_MS
        if (e.failures >= USAGE_BREAKER_FAILURES) e.pausedUntil = now + USAGE_BREAKER_MS
        // One line per failed read, a code and times only (no plan, account or reply text). Before 7.0.39 only the breaker's
        // pause was logged, so a failed read (Claude's no_limits on 2026-11-14) left no trace in the server log.
        const until = Math.max(e.pausedUntil ?? 0, e.holdUntil ?? 0)
        console.warn(`[work-orchestrator] usage probe ${p} failed: ${code}; ${e.failures} in a row; last good read ${e.observedAt ? new Date(e.observedAt).toISOString() : 'never'}${until > now ? `; next read after ${new Date(until).toISOString()}` : ''}`)
      } finally { delete this.inflight[p]; this.save() }
    })()
    this.inflight[p] = run
    return run
  }
  /** Re-read any provider whose reading is older than `maxAgeMs` (default 2 minutes), waiting at most `waitMs`. */
  async ensureFresh(maxAgeMs = USAGE_FRESH_MS, waitMs = 16_000): Promise<void> {
    const now = this.now()
    const readable: Array<'claude' | 'codex' | 'cursor'> = this.cursorPlanOn() ? ['claude', 'codex', 'cursor'] : ['claude', 'codex']
    const due = readable.filter(p => !this.entries[p].observedAt || now - this.entries[p].observedAt! > maxAgeMs)
    if (!due.length) return
    await Promise.race([Promise.all(due.map(p => this.refresh(p))), new Promise(r => setTimeout(r, waitMs).unref?.())])
  }
  /** Before a plan (POST /input), which may fork or start a new session: re-read what is older than 2 minutes. */
  async forPlan(): Promise<UsageView[]> { await this.ensureFresh(USAGE_FRESH_MS); return this.views() }
  /** On demand (GET /usage): answer from a reading younger than 10 minutes; `refresh` tightens that to 2. */
  async onDemand(refresh = false): Promise<UsageView[]> { await this.ensureFresh(refresh ? USAGE_FRESH_MS : USAGE_CACHE_MS); return this.views() }
  /** A plan-lane COS job on this provider finished with an answer (never a key-lane job). Saved at most once a minute. */
  noteAnswered(p: UsageProvider): void {
    const e = this.entries[p], now = this.now()
    const due = !e.answeredAt || now - e.answeredAt >= 60_000
    e.answeredAt = now
    if (due) this.save()
  }
  /** A provider refused a plan-lane turn with its limit text. Never called for a key-lane turn. */
  noteLimit(p: UsageProvider, message: string, source = 'provider_limit'): void {
    const now = this.now()
    const until = parseLimitReset(message, now) ?? now + USAGE_LIMIT_DEFAULT_MS
    const e = this.entries[p]
    e.limitUntil = Math.max(e.limitUntil ?? 0, until > now ? until : now + USAGE_LIMIT_DEFAULT_MS); e.limitSource = source
    console.log(`[work-orchestrator] usage ${p} marked exhausted until ${new Date(e.limitUntil).toISOString()} (${source})`)
    this.save()
  }
  /** A `rate_limit_event` frame from one of this server's own plan-lane Claude jobs (C1: free passive refresh). */
  noteClaudeRateLimitEvent(frame: unknown): void {
    const info = (frame as any)?.rate_limit_info
    if (!info || typeof info !== 'object' || typeof info.status !== 'string') return
    const e = this.entries.claude
    if (info.status === 'rejected') {
      const resetMs = num(info.resetsAt) ? info.resetsAt * 1000 : this.now() + USAGE_LIMIT_DEFAULT_MS
      e.limitUntil = Math.max(e.limitUntil ?? 0, resetMs); e.limitSource = 'rate_limit_event'
    } else if (info.status === 'allowed_warning') { e.warning = true; e.warningUntil = num(info.resetsAt) ? info.resetsAt * 1000 : null }
    else if (info.status === 'allowed') { e.warning = false; e.warningUntil = null; if (e.limitSource === 'rate_limit_event' && (e.limitUntil ?? 0) <= this.now()) e.limitUntil = null }
    if (e.source === 'none') e.source = 'passive'
    this.save()
  }
  /** The opt-in background poll. Off unless `pollEnabled` is true or the env says `COS_WORK_USAGE_POLL=1`. */
  start(env: NodeJS.ProcessEnv = process.env): void {
    if (this.timer || !(this.options.pollEnabled ?? usagePollOptedIn(env))) return
    const tick = () => { void this.refresh('claude'); void this.refresh('codex'); void this.refresh('cursor') } // cursor: a no-op while its switch is off
    this.timer = setInterval(tick, USAGE_POLL_MS)
    this.timer.unref?.()
    setTimeout(tick, 30_000).unref?.()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
}

// ─── The real probes ───

interface LineChild { pid?: number; write(line: string): void; end(): void; kill(): void; onLine(fn: (o: Record<string, any>) => void): void; onExit(fn: (code: number | null) => void): void }

function spawnLines(bin: string, args: string[], cwd: string): LineChild {
  const env = { ...process.env }
  delete env.CLAUDECODE
  const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  let buffer = ''
  const lineFns: Array<(o: Record<string, any>) => void> = []
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
      try { const o = JSON.parse(line); if (o && typeof o === 'object') for (const fn of lineFns) fn(o) } catch { /* not JSON */ }
    }
  })
  child.stdin.on('error', () => {})
  return {
    pid: child.pid,
    write: line => { try { child.stdin.write(line + '\n') } catch { /* closed */ } },
    end: () => { try { child.stdin.end() } catch { /* closed */ } },
    // Exact PID: this child, never a pattern.
    kill: () => { try { if (child.exitCode === null) child.kill('SIGTERM') } catch { /* gone */ } },
    onLine: fn => { lineFns.push(fn) },
    onExit: fn => { child.on('exit', fn); child.on('error', () => fn(null)) },
  }
}

export type SpawnLines = (bin: string, args: string[], cwd: string) => LineChild

/** The stdin lines each probe sends, in order. Pinned by tests: no luna reserve, no reset-credit call. */
export const CLAUDE_USAGE_LINES = [
  { type: 'control_request', request_id: 'cos_init', request: { subtype: 'initialize' } },
  { type: 'control_request', request_id: 'cos_usage', request: { subtype: 'get_usage', skip_behaviors: true } },
]
export const CODEX_INIT = { id: 1, method: 'initialize', params: { clientInfo: { name: 'cos', title: null, version: '6.83.0' }, capabilities: null } }
export const CODEX_READ = { id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } }

function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cos-usage-'))
  return fn(dir).finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } })
}

export function probeClaudeUsage(spawnFn: SpawnLines = spawnLines, timeoutMs = USAGE_PROBE_TIMEOUT_MS): Promise<UsageReading> {
  const bin = resolveProviderBinary('claude')
  return withScratch(dir => new Promise((resolve, reject) => {
    const child = spawnFn(bin.ok ? bin.path : 'claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true })], dir)
    let done = false
    const finish = (err: Error | null, value?: UsageReading) => {
      if (done) return
      done = true; clearTimeout(timer); child.end(); setTimeout(() => child.kill(), 2000).unref?.()
      if (err) reject(err); else resolve(value!)
    }
    const timer = setTimeout(() => { child.kill(); finish(new UsageProbeError('timed_out', 'timed out')) }, timeoutMs)
    child.onLine(o => {
      if (o.type !== 'control_response' || o.response?.request_id !== 'cos_usage') return
      if (o.response?.subtype !== 'success') return finish(new UsageProbeError('refused', 'get_usage refused'))
      const c = classifyClaudeUsage(o.response.response)
      if ('reading' in c) finish(null, c.reading)
      else if (c.code === 'no_limits') finish(new UsageProbeError('no_limits', 'Claude gave no plan limits (its usage service may be refusing reads)'))
      else finish(new UsageProbeError('unknown_shape', 'unknown get_usage shape'))
    })
    child.onExit(code => finish(new UsageProbeError('exited', `exited ${code ?? 'on error'} before answering`)))
    for (const line of CLAUDE_USAGE_LINES) child.write(JSON.stringify(line))
  }))
}

export function probeCodexUsage(spawnFn: SpawnLines = spawnLines, timeoutMs = USAGE_PROBE_TIMEOUT_MS): Promise<UsageReading> {
  const bin = resolveProviderBinary('codex')
  if (!bin.ok) return Promise.reject(new UsageProbeError('not_found', 'codex not found'))
  return withScratch(dir => new Promise((resolve, reject) => {
    const child = spawnFn(bin.path, ['app-server'], dir)
    let done = false
    const finish = (err: Error | null, value?: UsageReading) => {
      if (done) return
      done = true; clearTimeout(timer); child.end(); setTimeout(() => child.kill(), 2000).unref?.()
      if (err) reject(err); else resolve(value!)
    }
    const timer = setTimeout(() => { child.kill(); finish(new UsageProbeError('timed_out', 'timed out')) }, timeoutMs)
    child.onLine(o => {
      if (o.id === 1 && !done) { child.write(JSON.stringify({ method: 'initialized' })); child.write(JSON.stringify(CODEX_READ)); return }
      if (o.id !== 2) return
      if (o.error) return finish(new UsageProbeError('refused', 'rateLimits/read refused'))
      const reading = parseCodexUsage(o.result)
      if (reading) finish(null, reading); else finish(new UsageProbeError('unknown_shape', 'unknown rateLimits shape'))
    })
    child.onExit(code => finish(new UsageProbeError('exited', `exited ${code ?? 'on error'} before answering`)))
    child.write(JSON.stringify(CODEX_INIT))
  }))
}
