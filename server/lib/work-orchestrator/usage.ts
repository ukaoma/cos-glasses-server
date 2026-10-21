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
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { atomicWriteFileSync } from '../atomic-fs.js'
import { resolveProviderBinary } from '../provider-binary.js'

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

export interface UsageWindow { kind: string; usedPct: number; resetsAt: string | null; durationMins?: number }
export interface UsageReading {
  plan: string | null
  windows: UsageWindow[]
  /** Codex `ordinaryUsageAllowed`; Claude false only when a window reports a lock. Null: not stated. */
  allowed: boolean | null
  /** Claude `rate_limits_available: false` (an API key or a third-party login): no plan limits to read. */
  available: boolean
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
}
export type UsageState = 'ok' | 'low' | 'exhausted' | 'unknown'
/** What the planner sees: one line per provider. */
export interface UsageView { provider: UsageProvider; state: UsageState; headroomPct: number | null; resetsAt: string | null; ageSec: number | null; source: string; plan: string | null; stale: boolean; note: string }

/** The windows that bind: Claude's 5-hour session and weekly all-models; every Codex window; Cursor's included. */
const BINDING: Record<UsageProvider, (kind: string) => boolean> = {
  claude: kind => kind === 'session' || kind === 'weekly_all',
  codex: () => true,
  cursor: kind => kind === 'included',
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const iso = (s: number) => new Date(s * 1000).toISOString()

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

export function headroomOf(provider: UsageProvider, reading: UsageReading | null): number | null {
  if (!reading || !reading.available) return null
  const bind = reading.windows.filter(w => BINDING[provider](w.kind))
  if (!bind.length) return null
  return Math.max(0, Math.round(100 - Math.max(...bind.map(w => w.usedPct))))
}

export function viewOf(e: UsageEntry, now: number): UsageView {
  const ageSec = e.observedAt ? Math.round((now - e.observedAt) / 1000) : null
  const stale = !e.observedAt || now - e.observedAt > USAGE_STALE_MS
  const headroom = headroomOf(e.provider, e.reading)
  const bind = (e.reading?.windows ?? []).filter(w => BINDING[e.provider](w.kind))
  const tightest = bind.length ? bind.reduce((a, b) => (b.usedPct > a.usedPct ? b : a)) : null
  const base = { provider: e.provider, ageSec, source: e.source, plan: e.reading?.plan ?? null, stale }
  // A stated limit beats any percentage (canary C1 rule), until the time it names.
  if (e.limitUntil && e.limitUntil > now) {
    return { ...base, state: 'exhausted', headroomPct: 0, resetsAt: new Date(e.limitUntil).toISOString(), source: e.limitSource ?? 'provider_limit', note: 'plan limit reached' }
  }
  if (e.reading?.allowed === false) return { ...base, state: 'exhausted', headroomPct: 0, resetsAt: tightest?.resetsAt ?? null, note: 'the provider says ordinary usage is not allowed now' }
  if (e.provider === 'cursor' && !e.reading) return { ...base, state: 'unknown', headroomPct: null, resetsAt: null, note: 'not read: Cursor usage needs its app or a Keychain read, neither approved' }
  if (!e.reading || headroom === null) return { ...base, state: 'unknown', headroomPct: null, resetsAt: null, note: e.reading && !e.reading.available ? 'no plan limits on this login' : e.lastError ? `not read: ${e.lastError}` : 'not read yet' }
  const state: UsageState = headroom <= 0 ? 'exhausted' : headroom < USAGE_LOW_HEADROOM || e.warning ? 'low' : 'ok'
  return { ...base, state, headroomPct: headroom, resetsAt: tightest?.resetsAt ?? null, note: stale ? 'reading is old' : '' }
}

/** The background poll runs only when the owner opted in: `COS_WORK_USAGE_POLL=1`, nothing else. */
export function usagePollOptedIn(env: NodeJS.ProcessEnv = process.env): boolean { return env.COS_WORK_USAGE_POLL === '1' }

export interface UsageProbes {
  claude: () => Promise<UsageReading>
  codex: () => Promise<UsageReading>
}

export interface UsageMonitorOptions { path?: string; probes?: Partial<UsageProbes>; now?: () => number; pollEnabled?: boolean }

export class UsageMonitor {
  private entries: Record<UsageProvider, UsageEntry>
  private inflight: Partial<Record<UsageProvider, Promise<void>>> = {}
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number
  private readonly probes: UsageProbes
  constructor(private readonly options: UsageMonitorOptions = {}) {
    this.now = options.now ?? Date.now
    this.probes = { claude: options.probes?.claude ?? probeClaudeUsage, codex: options.probes?.codex ?? probeCodexUsage }
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
  views(): UsageView[] { const now = this.now(); return USAGE_PROVIDERS.map(p => viewOf(this.entries[p], now)) }
  /** Probe one provider now (shares a probe already running). Failures count toward the breaker; never throws. */
  refresh(p: 'claude' | 'codex'): Promise<void> {
    if (this.inflight[p]) return this.inflight[p]!
    const e = this.entries[p]
    if (e.pausedUntil && e.pausedUntil > this.now()) return Promise.resolve()
    const run = (async () => {
      try {
        const reading = await this.probes[p]()
        e.reading = reading; e.observedAt = this.now(); e.source = 'probe'; e.lastError = null; e.failures = 0; e.pausedUntil = null; e.warning = false
        // A fresh reading that says usage is allowed again clears an older limit only when its own reset passed.
        if (e.limitUntil && e.limitUntil <= this.now()) { e.limitUntil = null; e.limitSource = null }
      } catch (error) {
        e.lastError = String((error as Error)?.message ?? error).slice(0, 120)
        e.failures++
        if (e.failures >= USAGE_BREAKER_FAILURES) {
          e.pausedUntil = this.now() + USAGE_BREAKER_MS
          console.warn(`[work-orchestrator] usage probe ${p} paused for 1 h after ${e.failures} failures: ${e.lastError}`)
        }
      } finally { delete this.inflight[p]; this.save() }
    })()
    this.inflight[p] = run
    return run
  }
  /** Re-read any provider whose reading is older than `maxAgeMs` (default 2 minutes), waiting at most `waitMs`. */
  async ensureFresh(maxAgeMs = USAGE_FRESH_MS, waitMs = 16_000): Promise<void> {
    const now = this.now()
    const due = (['claude', 'codex'] as const).filter(p => !this.entries[p].observedAt || now - this.entries[p].observedAt! > maxAgeMs)
    if (!due.length) return
    await Promise.race([Promise.all(due.map(p => this.refresh(p))), new Promise(r => setTimeout(r, waitMs).unref?.())])
  }
  /** Before a plan (POST /input), which may fork or start a new session: re-read what is older than 2 minutes. */
  async forPlan(): Promise<UsageView[]> { await this.ensureFresh(USAGE_FRESH_MS); return this.views() }
  /** On demand (GET /usage): answer from a reading younger than 10 minutes; `refresh` tightens that to 2. */
  async onDemand(refresh = false): Promise<UsageView[]> { await this.ensureFresh(refresh ? USAGE_FRESH_MS : USAGE_CACHE_MS); return this.views() }
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
    } else if (info.status === 'allowed_warning') e.warning = true
    else if (info.status === 'allowed') { e.warning = false; if (e.limitSource === 'rate_limit_event' && (e.limitUntil ?? 0) <= this.now()) e.limitUntil = null }
    if (e.source === 'none') e.source = 'passive'
    this.save()
  }
  /** The opt-in background poll. Off unless `pollEnabled` is true or the env says `COS_WORK_USAGE_POLL=1`. */
  start(env: NodeJS.ProcessEnv = process.env): void {
    if (this.timer || !(this.options.pollEnabled ?? usagePollOptedIn(env))) return
    const tick = () => { void this.refresh('claude'); void this.refresh('codex') }
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
    const timer = setTimeout(() => { child.kill(); finish(new Error('timed out')) }, timeoutMs)
    child.onLine(o => {
      if (o.type !== 'control_response' || o.response?.request_id !== 'cos_usage') return
      if (o.response?.subtype !== 'success') return finish(new Error('get_usage refused'))
      const reading = parseClaudeUsage(o.response.response)
      if (reading) finish(null, reading); else finish(new Error('unknown get_usage shape'))
    })
    child.onExit(code => finish(new Error(`exited ${code ?? 'on error'} before answering`)))
    for (const line of CLAUDE_USAGE_LINES) child.write(JSON.stringify(line))
  }))
}

export function probeCodexUsage(spawnFn: SpawnLines = spawnLines, timeoutMs = USAGE_PROBE_TIMEOUT_MS): Promise<UsageReading> {
  const bin = resolveProviderBinary('codex')
  if (!bin.ok) return Promise.reject(new Error('codex not found'))
  return withScratch(dir => new Promise((resolve, reject) => {
    const child = spawnFn(bin.path, ['app-server'], dir)
    let done = false
    const finish = (err: Error | null, value?: UsageReading) => {
      if (done) return
      done = true; clearTimeout(timer); child.end(); setTimeout(() => child.kill(), 2000).unref?.()
      if (err) reject(err); else resolve(value!)
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error('timed out')) }, timeoutMs)
    child.onLine(o => {
      if (o.id === 1 && !done) { child.write(JSON.stringify({ method: 'initialized' })); child.write(JSON.stringify(CODEX_READ)); return }
      if (o.id !== 2) return
      if (o.error) return finish(new Error('rateLimits/read refused'))
      const reading = parseCodexUsage(o.result)
      if (reading) finish(null, reading); else finish(new Error('unknown rateLimits shape'))
    })
    child.onExit(code => finish(new Error(`exited ${code ?? 'on error'} before answering`)))
    child.write(JSON.stringify(CODEX_INIT))
  }))
}
