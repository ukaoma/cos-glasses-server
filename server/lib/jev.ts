/**
 * Jev (TypeSafe System One): a classifier that answers typed questions with calibrated probabilities. It never
 * writes text. Used for Work session matching (6.57.0); the COS meeting producer uses the same key.
 *
 * Key resolution: data/jev-key.json (saved from COS Control Settings, validated live, never echoed back) wins, then
 * TYPESAFE_API_KEY in the environment (which includes ~/.cos-glasses/.env, loaded at boot), then the COS scripts
 * .env. Unlike the OpenAI key the saved key comes FIRST: Miles's Mac has TYPESAFE_API_KEY in both .env files, so an
 * environment-first order made the Settings key inert (QA 2026-09-28). The COS producer (work_intake.py) resolves
 * in the same order: saved, its environment, then the other .env.
 *
 * Cost controls: a daily input-token cap (COS_JEV_DAILY_TOKENS, default 1,000,000, about $0.04 at $42 per billion),
 * a breaker that opens for an hour after three consecutive failures, and a 20-second request timeout. Every call
 * counts against a ledger in the data directory, so a restart does not reset the cap.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { secureExistingPrivateFile } from './secure-user-config.js'

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1'
export const JEV_MODEL = 'jev-1.13.0'
export const JEV_KEY_FILE = dataPath('jev-key.json')
export const JEV_USAGE_FILE = dataPath('jev-usage.json')
export const JEV_LIMITS = { defaultDailyTokens: 1_000_000, timeoutMs: 20_000, breakerFailures: 3, breakerMs: 3_600_000 } as const

export type JevKeySource = 'env' | 'config' | 'scripts-env' | 'none'
export class JevError extends Error {
  constructor(readonly code: 'jev_not_configured' | 'jev_cap_reached' | 'jev_breaker_open' | 'jev_key_rejected'
    | 'jev_request_rejected' | 'jev_unavailable' | 'jev_bad_answer', message: string = code) { super(message) }
}

interface KeyFile { key: string; savedAt: string; validatedAt?: string }
function readKeyFile(): KeyFile | null {
  if (!existsSync(JEV_KEY_FILE)) return null
  try {
    secureExistingPrivateFile(JEV_KEY_FILE)
    const parsed = JSON.parse(readFileSync(JEV_KEY_FILE, 'utf8')) as Partial<KeyFile>
    return typeof parsed.key === 'string' && parsed.key.trim()
      ? { key: parsed.key.trim(), savedAt: String(parsed.savedAt ?? ''), validatedAt: parsed.validatedAt } : null
  } catch { return null }
}

/** Resolved fresh on every call (a small file read), so a key saved from Control works without a restart. */
export function resolveJevKey(): { key: string; source: Exclude<JevKeySource, 'none'>; savedAt?: string; validatedAt?: string } | null {
  const file = readKeyFile()
  if (file) return { key: file.key, source: 'config', savedAt: file.savedAt, validatedAt: file.validatedAt }
  const env = process.env.TYPESAFE_API_KEY?.trim().replace(/^["']|["']$/g, '')
  if (env) return { key: env, source: 'env' }
  if (COS_SCRIPTS_DIR) {
    for (const path of [resolve(COS_SCRIPTS_DIR, '.env'), resolve(COS_SCRIPTS_DIR, '../../.env')]) {
      try {
        const match = readFileSync(path, 'utf8').match(/^TYPESAFE_API_KEY=(.+)$/m)
        if (match?.[1].trim()) return { key: match[1].trim().replace(/^["']|["']$/g, ''), source: 'scripts-env' }
      } catch { /* next */ }
    }
  }
  return null
}

export function saveJevKey(key: string, now = new Date()): void {
  mkdirSync(dirname(JEV_KEY_FILE), { recursive: true, mode: 0o700 })
  const at = now.toISOString()
  durableAtomicWriteFileSync(JEV_KEY_FILE, JSON.stringify({ key, savedAt: at, validatedAt: at }, null, 2) + '\n', { mode: 0o600 })
}

type Fetch = typeof fetch
/** A 200 from the free model listing proves the key works without spending tokens. */
export async function validateJevKey(key: string, fetchImpl: Fetch = fetch): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  try {
    const res = await fetchImpl(`${JEV_ENDPOINT}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) })
    if (res.ok) return { ok: true }
    return { ok: false, status: res.status, reason: res.status === 401 || res.status === 403 ? 'TypeSafe did not accept this key.' : `TypeSafe returned ${res.status}.` }
  } catch { return { ok: false, status: 0, reason: 'TypeSafe could not be reached. Check the network and try again.' } }
}

function today(now: Date): string { return now.toISOString().slice(0, 10) }
function dailyCap(): number {
  const raw = Number(process.env.COS_JEV_DAILY_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : JEV_LIMITS.defaultDailyTokens
}

export interface JevAnswers { answers: Record<string, { choice?: string; probabilities?: Record<string, number>; noul?: number }>; model?: string; inputTokens: number }

/** One Jev client per process: it owns the breaker and the usage ledger. */
export class JevClient {
  private failures = 0
  private breakerUntil = 0
  private lastError: string | null = null
  /** `cap` is the daily input-token cap for THIS client's ledger. Work search (6.65.0) passes its own; the default is
   *  COS_JEV_DAILY_TOKENS, shared by Work intake advice, session recommendations and completion checks. */
  constructor(private readonly fetchImpl: Fetch = fetch, private readonly now: () => Date = () => new Date(),
              private readonly usageFile = JEV_USAGE_FILE, private readonly cap: () => number = dailyCap) {}

  usedToday(): number {
    try {
      const ledger = JSON.parse(readFileSync(this.usageFile, 'utf8')) as Record<string, number>
      return Number(ledger[today(this.now())]) || 0
    } catch { return 0 }
  }
  private record(tokens: number): void {
    let ledger: Record<string, number> = {}
    try { ledger = JSON.parse(readFileSync(this.usageFile, 'utf8')) } catch { /* fresh */ }
    const day = today(this.now())
    const kept = Object.fromEntries(Object.entries(ledger).filter(([d]) => d >= today(new Date(this.now().getTime() - 31 * 86_400_000))))
    kept[day] = (Number(kept[day]) || 0) + tokens
    mkdirSync(dirname(this.usageFile), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.usageFile, JSON.stringify(kept) + '\n', { mode: 0o600 })
  }
  private fail(code: JevError['code'], countsTowardBreaker: boolean): never {
    this.lastError = code
    if (countsTowardBreaker && ++this.failures >= JEV_LIMITS.breakerFailures) {
      this.breakerUntil = this.now().getTime() + JEV_LIMITS.breakerMs
      this.failures = 0
    }
    throw new JevError(code)
  }

  /** A newly validated key starts clean: failures under the old key must not pause the new one for an hour. */
  resetForNewKey(): void { this.failures = 0; this.breakerUntil = 0; this.lastError = null }

  status(): { configured: boolean; source: JevKeySource; savedAt?: string; validatedAt?: string; usedToday: number; dailyCap: number; breakerOpenUntil: string | null; lastError: string | null } {
    const key = resolveJevKey()
    return { configured: !!key, source: key?.source ?? 'none', savedAt: key?.savedAt, validatedAt: key?.validatedAt,
      usedToday: this.usedToday(), dailyCap: this.cap(),
      breakerOpenUntil: this.breakerUntil > this.now().getTime() ? new Date(this.breakerUntil).toISOString() : null, lastError: this.lastError }
  }

  /** Ask one request. `estimate` is the caller's input-token estimate, checked against the cap BEFORE sending. */
  async ask(state: unknown, questions: Record<string, unknown>, estimate: number): Promise<JevAnswers> {
    const key = resolveJevKey()
    if (!key) throw new JevError('jev_not_configured')
    if (this.breakerUntil > this.now().getTime()) throw new JevError('jev_breaker_open')
    if (this.usedToday() + estimate > this.cap()) this.fail('jev_cap_reached', false)
    let res: Response
    try {
      res = await this.fetchImpl(`${JEV_ENDPOINT}/systemone`, { method: 'POST', signal: AbortSignal.timeout(JEV_LIMITS.timeoutMs),
        headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model: JEV_MODEL, questions }) })
    } catch { return this.fail('jev_unavailable', true) }
    if (res.status === 401 || res.status === 403 || res.status === 402) return this.fail('jev_key_rejected', true)
    if (res.status === 400 || res.status === 413 || res.status === 422) return this.fail('jev_request_rejected', false)
    if (!res.ok) return this.fail('jev_unavailable', true)
    let body: { answers?: JevAnswers['answers']; model?: string; usage?: { input_tokens?: number } }
    try { body = await res.json() } catch { return this.fail('jev_bad_answer', true) }
    const used = Number(body.usage?.input_tokens) || estimate  // count something even if usage is missing
    this.record(used)
    if (!body.answers || typeof body.answers !== 'object') return this.fail('jev_bad_answer', true)
    this.failures = 0; this.lastError = null
    return { answers: body.answers, model: body.model, inputTokens: used }
  }
}

let shared: JevClient | null = null
export function sharedJevClient(): JevClient { return shared ??= new JevClient() }
/** Jev bills by input size; about 2.6 characters per token, measured on COS meeting and task text. */
export function estimateJevTokens(value: unknown): number { return Math.ceil(JSON.stringify(value).length / 2.6) + 1 }
