// OpenAI TTS daily budget — hard $/day ceiling for gpt-4o-mini-tts.
//
// Mirror of openai-whisper-budget.ts. Voice-mode playback can rack up cost
// quickly if a user (or a runaway script) keeps re-speaking long responses,
// so every call goes through assertOpenAITtsBudget() BEFORE the OpenAI call,
// and recordOpenAITtsUsage() ticks the ledger only AFTER a successful first
// byte from OpenAI (so failed/aborted requests don't count).
//
// Cost: gpt-4o-mini-tts is billed per character of input text, ~$0.60/1M chars
// = $0.0000006 per char. Default $2 cap = ~3.3M chars/day (~30 hours of speech).
//
// State is persisted atomically to server/data/openai-tts-budget.json. Reset is
// lazy: when a read finds a date != today's localDay(), it starts fresh.

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { localDay } from './local-day.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUDGET_FILE = resolve(__dirname, '..', 'data', 'openai-tts-budget.json')

/** OpenAI gpt-4o-mini-tts pricing (2024-2025): ~$0.60 per 1M input characters. */
export const USD_PER_CHAR = 0.6 / 1_000_000

/** Daily hard cap in USD. Tunable via env (OPENAI_TTS_DAILY_CAP_USD) — default $2. */
export const DAILY_USD_CAP = Number(process.env.OPENAI_TTS_DAILY_CAP_USD ?? 2)

/** Warn threshold — logs once when we cross this fraction of the cap. */
const WARN_FRACTION = 0.8

export class OpenAITtsBudgetExhaustedError extends Error {
  public readonly spentTodayUsd: number
  public readonly capUsd: number
  public readonly charsToday: number
  public readonly callsToday: number

  constructor(state: BudgetState) {
    const msg =
      `OpenAI TTS daily budget exhausted: $${state.usdToday.toFixed(4)}/$${DAILY_USD_CAP.toFixed(2)} ` +
      `(${state.charsToday.toLocaleString()} chars across ${state.callsToday} calls today). ` +
      `Recovery: raise OPENAI_TTS_DAILY_CAP_USD, or wait for local midnight.`
    super(msg)
    this.name = 'OpenAITtsBudgetExhaustedError'
    this.spentTodayUsd = state.usdToday
    this.capUsd = DAILY_USD_CAP
    this.charsToday = state.charsToday
    this.callsToday = state.callsToday
  }
}

interface BudgetState {
  /** Local-tz YYYY-MM-DD — when this doesn't equal localDay() on next read, we reset. */
  date: string
  /** Cumulative input characters billed today. */
  charsToday: number
  /** Number of successful TTS calls today (diagnostics). */
  callsToday: number
  /** Derived: USD spent today. Recomputed on every write from charsToday. */
  usdToday: number
  /** Whether we've already logged the 80% warning today (so we don't spam). */
  warnedAt80: boolean
}

function fresh(): BudgetState {
  return { date: localDay(), charsToday: 0, callsToday: 0, usdToday: 0, warnedAt80: false }
}

function read(): BudgetState {
  if (!existsSync(BUDGET_FILE)) return fresh()
  const r = loadJsonOrQuarantine<BudgetState>(BUDGET_FILE)
  if (r.status !== 'ok') return fresh()
  if (r.data.date !== localDay()) return fresh()
  return r.data
}

function write(state: BudgetState): void {
  try {
    atomicWriteFileSync(BUDGET_FILE, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[openai-tts-budget] Failed to persist budget state:', err)
  }
}

/**
 * Throw BEFORE making any OpenAI TTS call if today's budget is already spent.
 * Caller surfaces a 429 to the client; the UI keeps rendering the message text
 * and only the audio playback is suppressed.
 */
export function assertOpenAITtsBudget(): void {
  const state = read()
  if (state.usdToday >= DAILY_USD_CAP) {
    throw new OpenAITtsBudgetExhaustedError(state)
  }
}

/**
 * Record a successful TTS call. `charCount` is the number of input characters
 * actually sent to OpenAI (after trimming/stripping markdown).
 */
export function recordOpenAITtsUsage(charCount: number): void {
  if (charCount <= 0) return
  const state = read()
  const before = state.usdToday
  state.charsToday += charCount
  state.callsToday += 1
  state.usdToday = state.charsToday * USD_PER_CHAR

  const warnThreshold = DAILY_USD_CAP * WARN_FRACTION
  if (before < warnThreshold && state.usdToday >= warnThreshold && !state.warnedAt80) {
    console.warn(
      `[openai-tts-budget] WARN — $${state.usdToday.toFixed(4)}/$${DAILY_USD_CAP.toFixed(2)} ` +
      `(${((state.usdToday / DAILY_USD_CAP) * 100).toFixed(0)}%) today across ${state.callsToday} calls.`,
    )
    state.warnedAt80 = true
  }

  if (state.usdToday >= DAILY_USD_CAP) {
    console.error(
      `[openai-tts-budget] HARD CAP REACHED — $${state.usdToday.toFixed(4)}/$${DAILY_USD_CAP.toFixed(2)} today. ` +
      `All further OpenAI TTS calls will throw until local midnight.`,
    )
  }

  write(state)
}

/** Status snapshot for diagnostics / health endpoints. */
export function getOpenAITtsBudgetState(): BudgetState & {
  capUsd: number
  remainingUsd: number
  percentUsed: number
} {
  const state = read()
  return {
    ...state,
    capUsd: DAILY_USD_CAP,
    remainingUsd: Math.max(0, DAILY_USD_CAP - state.usdToday),
    percentUsed: Math.round((state.usdToday / DAILY_USD_CAP) * 100),
  }
}
