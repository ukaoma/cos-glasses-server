// Transcript cleanup (6.77.0): how it is switched on, which model it uses, and how it stops.
//
// SWITCH. Its own flag, nothing shared:
//   1. env COS_TRANSCRIPT_CLEANUP=1 forces it on, =0 forces it off (source 'env'); a
//      request to change it then answers 409 env_forced.
//   2. the saved setting (transcript-cleanup/settings.json, atomic), which COS Control's
//      toggle writes through POST /api/transcript-cleanup/settings (source 'setting').
//   3. off (source 'default'). Miles turns it on.
// An unreadable settings file reads as no setting: it fails toward off, never toward spending.
//
// MODEL. Haiku unless the setting or env COS_TRANSCRIPT_CLEANUP_MODEL says sonnet. Always a
// pinned model id, never the CLI default (a bare `claude -p` can resolve to Opus).
//
// STOPS (each one a recorded skip, correction_skipped style):
//   switch_off       nothing runs at all: no fuzzy pass, no file, no trace
//   api_key_in_env   ANTHROPIC_API_KEY is set and COS_ALLOW_API_FALLBACK is not 1: the CLI
//                    would bill the API key, not the plan
//   claude_not_found no Claude CLI
//   daily_calls      COS_TRANSCRIPT_CLEANUP_DAILY calls today (default 30), charged BEFORE
//                    the call and never refunded
//   daily_tokens     COS_TRANSCRIPT_CLEANUP_DAILY_TOKENS today (default 400k in plus out)
//   breaker_open     3 failures in a row, or one provider limit, open it for 30 minutes
//                    (60 after a limit); the first meeting after that is one trial call
// Per meeting: one call, at most COS_TRANSCRIPT_CLEANUP_MAX_SPANS spans (default 40, hard
// 80), a 24k-character prompt and a 1,500-token answer. The day is the local calendar day.
// An unreadable or impossible state file reads as a spent day, so a corrupt ledger can
// stop spending but never start it.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { cleanupDir } from './transcript-cleanup-screen.js'
import { CLEANUP_MODEL_IDS, type CleanupModelChoice } from './transcript-cleanup-model.js'
import { SPAN_LIMITS } from './transcript-cleanup-spans.js'

export type CleanupSettingSource = 'env' | 'setting' | 'default'
export interface StoredCleanupSettings { enabled: boolean | null; model: CleanupModelChoice | null }

export class TranscriptCleanupSettings {
  private cache: StoredCleanupSettings | null = null
  constructor(readonly file: string = cleanupDir('settings.json')) {}

  stored(): StoredCleanupSettings {
    if (this.cache) return this.cache
    let value: StoredCleanupSettings = { enabled: null, model: null }
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          value = {
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null,
            model: raw.model === 'haiku' || raw.model === 'sonnet' ? raw.model : null,
          }
        }
      }
    } catch { value = { enabled: null, model: null } }
    this.cache = value
    return value
  }

  /** Atomic and durable; the cached value changes only after the write. */
  save(patch: Partial<{ enabled: boolean; model: CleanupModelChoice }>, now: Date = new Date()): StoredCleanupSettings {
    const current = this.stored()
    const next: StoredCleanupSettings = {
      enabled: patch.enabled ?? current.enabled,
      model: patch.model ?? current.model,
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.file, JSON.stringify({ schema: 1, ...next, updatedAt: now.toISOString() }) + '\n', { mode: 0o600 })
    this.cache = next
    return next
  }
}

export function resolveCleanupSwitch(env: NodeJS.ProcessEnv, settings: TranscriptCleanupSettings | null): { enabled: boolean; source: CleanupSettingSource } {
  if (env.COS_TRANSCRIPT_CLEANUP === '1') return { enabled: true, source: 'env' }
  if (env.COS_TRANSCRIPT_CLEANUP === '0') return { enabled: false, source: 'env' }
  let stored: boolean | null = null
  try { stored = settings ? settings.stored().enabled : null } catch { stored = null }
  if (stored !== null) return { enabled: stored, source: 'setting' }
  return { enabled: false, source: 'default' }
}

export function resolveCleanupModel(env: NodeJS.ProcessEnv, settings: TranscriptCleanupSettings | null): { choice: CleanupModelChoice; id: string; source: CleanupSettingSource } {
  const raw = (env.COS_TRANSCRIPT_CLEANUP_MODEL ?? '').trim().toLowerCase()
  if (raw === 'haiku' || raw === 'sonnet') return { choice: raw, id: CLEANUP_MODEL_IDS[raw], source: 'env' }
  let stored: CleanupModelChoice | null = null
  try { stored = settings ? settings.stored().model : null } catch { stored = null }
  if (stored) return { choice: stored, id: CLEANUP_MODEL_IDS[stored], source: 'setting' }
  return { choice: 'haiku', id: CLEANUP_MODEL_IDS.haiku, source: 'default' }
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = Number(env[name])
  return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), max) : fallback
}

export interface CleanupLimits { dailyCalls: number; dailyTokens: number; maxSpans: number; breakerFailures: number; breakerCooldownMs: number; limitCooldownMs: number }
export function cleanupLimits(env: NodeJS.ProcessEnv = process.env): CleanupLimits {
  return {
    dailyCalls: intEnv(env, 'COS_TRANSCRIPT_CLEANUP_DAILY', 30, 500),
    dailyTokens: intEnv(env, 'COS_TRANSCRIPT_CLEANUP_DAILY_TOKENS', 400_000, 10_000_000),
    maxSpans: Math.max(1, intEnv(env, 'COS_TRANSCRIPT_CLEANUP_MAX_SPANS', SPAN_LIMITS.defaultMaxSpans, SPAN_LIMITS.hardMaxSpans)),
    breakerFailures: 3,
    breakerCooldownMs: 30 * 60_000,
    limitCooldownMs: 60 * 60_000,
  }
}

export interface BudgetState {
  day: string
  calls: number
  tokens: number
  consecutiveFailures: number
  breakerOpenUntil: number | null
}

export function localDay(now: Date): string {
  return now.toLocaleDateString('en-CA')
}

/** The day's spend and the breaker. One small JSON file, rewritten atomically on every change. */
export class TranscriptCleanupBudget {
  constructor(readonly file: string = cleanupDir('state.json'), private readonly now: () => Date = () => new Date()) {}

  read(): BudgetState {
    const day = localDay(this.now())
    const spent: BudgetState = { day, calls: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER, consecutiveFailures: 0, breakerOpenUntil: null }
    try {
      if (!existsSync(this.file)) return { day, calls: 0, tokens: 0, consecutiveFailures: 0, breakerOpenUntil: null }
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BudgetState>
      if (!raw || typeof raw !== 'object' || typeof raw.day !== 'string') return spent
      const failures = Number(raw.consecutiveFailures ?? 0)
      const openUntil = raw.breakerOpenUntil === null || raw.breakerOpenUntil === undefined ? null : Number(raw.breakerOpenUntil)
      const breaker = { consecutiveFailures: Number.isFinite(failures) && failures >= 0 ? failures : 0, breakerOpenUntil: openUntil !== null && Number.isFinite(openUntil) ? openUntil : null }
      // A future day key or a negative count fails toward NOT spending.
      if (raw.day > day) return { ...spent, ...breaker }
      if (raw.day < day) return { day, calls: 0, tokens: 0, ...breaker }
      const calls = Number(raw.calls), tokens = Number(raw.tokens)
      if (!(calls >= 0) || !(tokens >= 0)) return { ...spent, ...breaker }
      return { day, calls, tokens, ...breaker }
    } catch {
      return spent
    }
  }

  private write(state: BudgetState): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.file, JSON.stringify(state) + '\n', { mode: 0o600 })
  }

  /** Why a call may not run now, or null. Read-only. */
  gate(limits: CleanupLimits): 'daily_calls' | 'daily_tokens' | 'breaker_open' | null {
    const s = this.read()
    if (s.breakerOpenUntil !== null && this.now().getTime() < s.breakerOpenUntil) return 'breaker_open'
    if (s.calls >= limits.dailyCalls) return 'daily_calls'
    if (s.tokens >= limits.dailyTokens) return 'daily_tokens'
    return null
  }

  /** Charge one call BEFORE it runs. False when the day is spent. */
  charge(limits: CleanupLimits): boolean {
    const s = this.read()
    if (s.calls >= limits.dailyCalls || s.tokens >= limits.dailyTokens) return false
    this.write({ ...s, calls: s.calls + 1 })
    return true
  }

  recordUsage(tokens: number): void {
    const s = this.read()
    if (s.tokens === Number.MAX_SAFE_INTEGER) return
    this.write({ ...s, tokens: s.tokens + Math.max(0, Math.round(tokens)) })
  }

  recordSuccess(): void {
    const s = this.read()
    if (s.consecutiveFailures === 0 && s.breakerOpenUntil === null) return
    this.write({ ...s, consecutiveFailures: 0, breakerOpenUntil: null })
  }

  /** Returns true when this failure opened the breaker. */
  recordFailure(limits: CleanupLimits, providerLimit: boolean): boolean {
    const s = this.read()
    const failures = s.consecutiveFailures + 1
    const open = providerLimit || failures >= limits.breakerFailures
    const until = open ? this.now().getTime() + (providerLimit ? limits.limitCooldownMs : limits.breakerCooldownMs) : s.breakerOpenUntil
    this.write({ ...s, consecutiveFailures: failures, breakerOpenUntil: until })
    return open
  }
}

let settingsSingleton: TranscriptCleanupSettings | null = null
let budgetSingleton: TranscriptCleanupBudget | null = null
export function transcriptCleanupSettings(): TranscriptCleanupSettings {
  if (!settingsSingleton) settingsSingleton = new TranscriptCleanupSettings()
  return settingsSingleton
}
export function transcriptCleanupBudget(): TranscriptCleanupBudget {
  if (!budgetSingleton) budgetSingleton = new TranscriptCleanupBudget()
  return budgetSingleton
}
