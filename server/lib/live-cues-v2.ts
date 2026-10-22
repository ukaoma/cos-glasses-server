// Live cues v2 (MVP, default off): Jev gate -> rank-fusion memory -> Jev relevance judge -> ONE tools-off Claude writer.
//
// Evidence and thresholds: docs/PLAN-live-cues-v2-mvp.md. Every recurring model caller must answer how it stops; here:
// the master switch COS_LIVE_CUES_V2=1 (default off; independent of the v1 COS_LIVE_CUES flag, so turning v2 off can never
// re-enable the v1 Composer path), a per-meeting cap (25 cues, 50 writer calls; persisted, so a restart does not reset
// it), a weekly writer ceiling checked BEFORE the gate and charged before the call, never refunded (local week in the zone
// stored at first use), the Jev client's own daily token cap and breaker, a 3-failure breaker per meeting (cancel, pause,
// end, stale and maintenance are NOT failures), single flight per meeting, a 20 s cadence floor, a 45 s cooldown after a
// cue, a 45 s wall per evaluation, and no evaluation while a user's own query runs. Each evaluation writes one trace row
// without transcript text; a skip (paused, breaker, meeting cap, weekly budget, busy) writes one `skip` row per reason
// per meeting at most every 5 minutes, so the trace can tell those apart from silence.
//
// 6.76.2: the switch is also a runtime setting (live-cues-v2-settings.ts; env COS_LIVE_CUES_V2=1 still forces it on), the
// gate and the judge run on Jev, or on SubQ when COS_DECISION_PROVIDER_CUES=subq or SubQ is the only key (each with its
// own daily cap and breaker; resolveCuesDecisionProvider), and
// when cue_memory.py is unavailable, fails or times out the memory arm searches the owner's own COS notes and meetings
// instead (live-cues-v2-notes.ts; local keyword search, no model call). Each evaluation traces `cueMemorySource`.

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { emitDisplay, onDisplay } from './display-bus.js'
import { acquireMaintenanceWork, MaintenanceLifecycleError, maintenanceLifecycle, type MaintenanceWorkLease } from './maintenance-lifecycle.js'
import { JevClient, JevError, estimateJevTokens, resolveJevKey, type JevAnswers } from './jev.js'
import { DecisionProviderError, SubqDecisionClient, trackSubqDecisionClient, type DecisionClient } from './decision-provider.js'
import type { DecisionProvider } from './decision-settings.js'
import { resolveSubqKey } from './subq-key.js'
import {
  LIVE_CUES_V2_LIMIT_BOUNDS, LIVE_CUES_V2_LIMIT_NAMES, liveCuesV2EnvForced, liveCuesV2Settings, resolveLiveCuesV2,
  type LiveCuesV2LimitName, type LiveCuesV2SettingReader, type LiveCuesV2SettingSource, type LiveCuesV2StoredLimits,
} from './live-cues-v2-settings.js'
import { notesMemory } from './live-cues-v2-notes.js'
import { meetingLibraryConfigured } from './cos-operations-meetings.js'
import { getMeetingStore } from './meeting-store.js'
import { LensGistLimitError, runLensGistEngine } from './lens-gist-engines.js'
import { resolveProviderBinary } from './provider-binary.js'
import { COS_SCRIPTS_DIR, PYTHON_BIN, contextSourceAvailable } from './python-bridge.js'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { terminateProviderProcess } from './provider-process-lifecycle.js'
import { cueBefore, liveCueVerdicts, type LiveCueLogRow } from './live-cue-verdicts.js'
import { repeatOf, wouldWithhold } from './live-cues-filter.js'
import { errMsg } from './utils.js'
import { CUE_GATE_QUESTIONS, CUE_JUDGE_INSTRUCTIONS, CUE_JUDGE_NONE, CUE_WRITER_SYSTEM_V2, CUE_WRITER_SYSTEM_V3 } from './live-cues-v2-prompts.js'
import { CUE_WRITER_SYSTEM_V4 } from './live-cues-v2-prompts-kinds.js'
import { MAC_CAPTURE_ID } from './mac-recording.js'
import {
  CUE_DETAIL_MAX, CUE_FEEDBACK_REASON_MAX, CUE_HEADLINE_MAX, CUE_KINDS, LEGACY_CUE_KINDS, LIVE_CUES_V2_PROTOCOL, isLiveCueV2, legacyCueKind,
  type CueKind, type CueKindSet, type CueSourceRef, type LiveCueV1Compat, type LiveCueV2, type LiveCuesV2Capability, type LiveCuesV2MemorySource,
  type LiveCuesV2SessionStatus, type LiveCuesV2StatusResponse, type LiveCuesV2StopReason,
} from '../../shared/live-cues-v2.js'

// ── Limits ──────────────────────────────────────────────────────────────────
export const LIVE_CUES_V2_LIMITS = {
  minNewWords: 40,
  minIntervalMs: 20_000,
  cooldownAfterCueMs: 45_000,
  /** A cue is stale when the room moved on while it was being written: more than ~24 s of speech at ~2.5 words/s,
   *  or more than 30 s of wall time (the pipeline's worst case is ~28 s: 20 s writer, 6 s memory, two Jev calls). */
  staleWords: 60,
  staleMs: 30_000,
  windowWords: 400,
  windowChars: 2_200,
  /** 25 a meeting (Miles 2026-10-19: 10 ran out 10 minutes into an HC call). Writer calls stay at twice the cue cap so
   *  discarded drafts cannot end a meeting's cues early, and the weekly default keeps the same ~15 capped meetings. */
  maxCuesPerMeeting: 25,
  maxWriterCallsPerMeeting: 50,
  defaultWeeklyWriterCalls: 750,
  breakerFailures: 3,
  judgeKeep: 0.8,
  judgeMaxNotes: 2,
  defaultGate: 0.8,
  memoryTimeoutMs: 6_000,
  /** Hard wall for one evaluation, far under Control's 90 s drain (a held live_cue_pipeline lease past it fails Update). */
  pipelineWallMs: 45_000,
  /** A skip reason is traced at most once per meeting per window of this length. */
  skipTraceEveryMs: 5 * 60_000,
  writerTimeoutMs: 20_000,
  writerMaxOutputTokens: 600,
  sessionTtlMs: 4 * 60 * 60_000,
  tombstoneTtlMs: 7 * 24 * 60 * 60_000,
  counterTtlMs: 24 * 60 * 60_000,
  /** ~1.2k gate tokens per evaluation, at most 3 a minute: ~216k an hour, so 1.5M covers ~7 meeting hours (~$0.06). */
  defaultJevDailyTokens: 1_500_000,
  /** The same ceiling for SubQ, on its own ledger (subq-cues-usage.json). SubQ reserves a byte-based estimate before each
   *  call and records the input tokens it reports. */
  defaultSubqDailyTokens: 1_500_000,
} as const

/** On when env COS_LIVE_CUES_V2=1 forces it, else when the saved runtime setting says so (6.76.2). Off by default. */
export function liveCuesV2Enabled(env: NodeJS.ProcessEnv = process.env, settings: LiveCuesV2SettingReader | null = liveCuesV2Settings()): boolean {
  return resolveLiveCuesV2(env, settings).enabled
}
/** The gate from env alone, or null when env does not set a usable one (unchanged acceptance: 0.3 to 0.99). */
function envGate(env: NodeJS.ProcessEnv): number | null {
  const raw = Number(env.COS_LIVE_CUES_V2_GATE)
  return env.COS_LIVE_CUES_V2_GATE !== undefined && env.COS_LIVE_CUES_V2_GATE.trim() !== '' && Number.isFinite(raw) && raw >= 0.3 && raw <= 0.99 ? raw : null
}
export function liveCuesV2Gate(env: NodeJS.ProcessEnv = process.env): number {
  return envGate(env) ?? LIVE_CUES_V2_LIMITS.defaultGate
}
/** 6.79.0 tuning knobs for Friday's rated-cue review. Unset (or empty, which a managed env may pass for an unset optional
 *  variable) is the calibrated default with no log. Anything else outside the accepted form falls back to the default with
 *  one log line per distinct value per process: the knobs are read on every transcript feed. */
const knobWarned = new Set<string>()
function knobFallback<T>(name: string, raw: string, fallback: T, accepted: string): T {
  if (!knobWarned.has(`${name}=${raw}`)) {
    knobWarned.add(`${name}=${raw}`)
    console.warn(`[live-cues-v2] ${name}=${JSON.stringify(raw)} is not ${accepted}; using the default`)
  }
  return fallback
}
/** A whole-number env knob (6.79.2 limits): null when unset or empty, the value when inside [min, max], else null with
 *  one log line per value (the saved setting or the default then applies). */
function envWhole(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | null {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return null
  const n = /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  return n >= min && n <= max ? n : knobFallback<number | null>(name, raw, null, `a whole number from ${min} to ${max}`)
}
/** The cooldown from env alone (whole seconds 20..900), or null when unset, empty or invalid (one log line per value). */
function envCooldownSeconds(env: NodeJS.ProcessEnv): number | null {
  const raw = env.COS_LIVE_CUES_V2_COOLDOWN_S
  if (raw === undefined || raw.trim() === '') return null
  const seconds = /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN     // whole seconds only
  return seconds >= 20 && seconds <= 900 ? seconds : knobFallback<number | null>('COS_LIVE_CUES_V2_COOLDOWN_S', raw, null, 'whole seconds from 20 to 900')
}
export function liveCuesV2CooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = envCooldownSeconds(env)
  return seconds === null ? LIVE_CUES_V2_LIMITS.cooldownAfterCueMs : seconds * 1000
}

/** One resolved limit: where its value came from, and whether COS Control may change it (an env var locks it). */
export interface LiveCuesV2Limit { value: number; source: LiveCuesV2SettingSource; locked: boolean; min: number; max: number; default: number }
export type LiveCuesV2Limits = Record<LiveCuesV2LimitName, LiveCuesV2Limit>
/** 6.79.2: env wins and locks; else the saved setting; else the default. Read on every evaluation, so a saved change
 *  applies from the next one with no restart. */
export function resolveLiveCuesV2Limits(env: NodeJS.ProcessEnv = process.env, settings: LiveCuesV2SettingReader | null = liveCuesV2Settings()): LiveCuesV2Limits {
  let saved: LiveCuesV2StoredLimits = {}
  try { saved = settings?.limits?.() ?? {} } catch { saved = {} }
  const fromEnv: Record<LiveCuesV2LimitName, number | null> = {
    gate: envGate(env),
    maxCuesPerMeeting: envWhole(env, LIVE_CUES_V2_LIMIT_BOUNDS.maxCuesPerMeeting.env, 1, 25),
    cooldownSeconds: envCooldownSeconds(env),
    dailyWriterCalls: envWhole(env, LIVE_CUES_V2_LIMIT_BOUNDS.dailyWriterCalls.env, 1, 500),
  }
  const out = {} as LiveCuesV2Limits
  for (const name of LIVE_CUES_V2_LIMIT_NAMES) {
    const b = LIVE_CUES_V2_LIMIT_BOUNDS[name]
    const e = fromEnv[name], v = saved[name]
    out[name] = e !== null ? { value: e, source: 'env', locked: true, min: b.min, max: b.max, default: b.default }
      : v !== undefined ? { value: v, source: 'setting', locked: false, min: b.min, max: b.max, default: b.default }
        : { value: b.default, source: 'default', locked: false, min: b.min, max: b.max, default: b.default }
  }
  return out
}
export function liveCuesV2JudgeKeep(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COS_LIVE_CUES_V2_JUDGE_KEEP
  if (raw === undefined || raw.trim() === '') return LIVE_CUES_V2_LIMITS.judgeKeep
  const keep = Number(raw)
  return keep >= 0.5 && keep <= 0.95 ? keep : knobFallback('COS_LIVE_CUES_V2_JUDGE_KEEP', raw, LIVE_CUES_V2_LIMITS.judgeKeep, 'a number from 0.5 to 0.95')
}
/** COS_LIVE_CUES_V2_REPEAT_OVERLAP: the repeat rule's threshold, 0.3 to 0.9, or null (off, today's behaviour) when unset
 *  or empty. Any other value leaves the rule off, with one log line per value. RESULTS_filter.md: 0.5 withheld no useful
 *  cue on any receipt; 0.4 withheld three. */
export function liveCuesV2RepeatOverlap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.COS_LIVE_CUES_V2_REPEAT_OVERLAP
  if (raw === undefined || raw.trim() === '') return null
  const t = Number(raw)
  return t >= 0.3 && t <= 0.9 ? t : knobFallback<number | null>('COS_LIVE_CUES_V2_REPEAT_OVERLAP', raw, null, 'a number from 0.3 to 0.9 (the repeat rule stays off)')
}
export function liveCuesV2Model(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.COS_LIVE_CUES_V2_MODEL ?? '').trim().toLowerCase()
  if (raw === 'haiku') return 'claude-haiku-5-5'
  if (raw === 'sonnet' || raw === '') return 'claude-sonnet-5-5'
  return /^claude-[a-z0-9.-]{3,40}$/.test(raw) ? raw : 'claude-sonnet-5-5'
}
/** The writer rules. A meeting with the extended kinds (6.86.0) always runs v4: v2 and v3 only know reinforce and challenge.
 *  Every other meeting is unchanged: COS_LIVE_CUES_V2_PROMPT=v2 picks v2, anything else v3. */
export function liveCuesV2WriterSystem(env: NodeJS.ProcessEnv = process.env, kinds: CueKindSet = 'legacy'): { version: 'v2' | 'v3' | 'v4'; system: string } {
  if (kinds === 'extended') return { version: 'v4', system: CUE_WRITER_SYSTEM_V4 }
  return (env.COS_LIVE_CUES_V2_PROMPT ?? '').trim() === 'v2' ? { version: 'v2', system: CUE_WRITER_SYSTEM_V2 } : { version: 'v3', system: CUE_WRITER_SYSTEM_V3 }
}
/** 6.86.0: which kinds a meeting gets when its armer does not say. A Mac recording (`mac_` capture id) is read only by COS
 *  Control, which shows any kind, so it gets the extended set; every other meeting keeps the two legacy kinds, because a
 *  companion that validates `kind` drops a cue whose kind it does not know. */
export function defaultCueKindSet(sessionId: string): CueKindSet {
  return MAC_CAPTURE_ID.test(sessionId) ? 'extended' : 'legacy'
}
/** 6.86.0: env COS_LIVE_CUES_V2_MAC=0 refuses live cues on Mac recordings (reason mac_cues_off) without touching glasses
 *  meetings. Unset or anything else: Mac recordings may be armed, under the same switch and limits as every meeting. */
export function liveCuesV2MacAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.COS_LIVE_CUES_V2_MAC ?? '').trim() !== '0'
}
export function liveCuesV2WeeklyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_LIVE_CUES_V2_WEEKLY)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : LIVE_CUES_V2_LIMITS.defaultWeeklyWriterCalls
}
function jevDailyCap(): number {
  const raw = Number(process.env.COS_LIVE_CUES_JEV_DAILY_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : LIVE_CUES_V2_LIMITS.defaultJevDailyTokens
}
function subqDailyCap(): number {
  const raw = Number(process.env.COS_LIVE_CUES_SUBQ_DAILY_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : LIVE_CUES_V2_LIMITS.defaultSubqDailyTokens
}

/**
 * Which classifier runs the gate and the judge. Cues do NOT follow COS Control's saved decision provider or
 * COS_DECISION_PROVIDER (Miles 2026-10-17): the 0.8 gate and judge thresholds were calibrated on Jev, there is no SubQ
 * replay, and SubQ would receive the live transcript window. SubQ runs cues only when env COS_DECISION_PROVIDER_CUES=subq
 * says so, or when SubQ is the only decision key on this Mac; otherwise Jev. Any other value of that env throws
 * decision_invalid_provider: never silently Jev.
 */
export function resolveCuesDecisionProvider(env: NodeJS.ProcessEnv = process.env,
  keys: { jev: () => boolean; subq: () => boolean } = { jev: () => !!resolveJevKey(), subq: () => !!resolveSubqKey() }): { provider: DecisionProvider; source: 'env' | 'only_key' | 'default' } {
  const raw = env.COS_DECISION_PROVIDER_CUES
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase()
    if (v !== 'jev' && v !== 'subq') throw new DecisionProviderError('decision_invalid_provider')
    return { provider: v, source: 'env' }
  }
  if (!keys.jev() && keys.subq()) return { provider: 'subq', source: 'only_key' }
  return { provider: 'jev', source: 'default' }
}

// ── Python-style JSON (the replay built every prompt with json.dumps; keep byte parity) ──
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-￿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return '[' + value.map(pyJson).join(', ') + ']'
  return '{' + Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => `${pyJson(k)}: ${pyJson(v)}`).join(', ') + '}'
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────
/** A note as the writer sees it ({id, date, title, notes}; the same keys the replay sent). `key` is the stable meeting
 *  identity from cue_memory.py; it never reaches the prompt. */
export interface MemoryNote { id: string; date: string; title: string; notes: string; key?: string }

/** A cue's headline: the first sentence when it fits, otherwise cut at a word with an ellipsis. Never empty. */
export function cueHeadline(detail: string): string {
  const clean = detail.replace(/\s+/g, ' ').trim()
  const first = (clean.split(/(?<=[.!?])\s/)[0] ?? '').replace(/[.]$/, '').trim()
  if (first && first.length <= CUE_HEADLINE_MAX) return first
  const cut = clean.slice(0, CUE_HEADLINE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  const head = (space > 30 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')
  return head ? head + '…' : clean.slice(0, CUE_HEADLINE_MAX)
}

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?%?k?/gi
/** Every multi-digit number (or any dollar amount) in the cue must appear in the window or the memory notes, dates included.
 *  A substring check: it catches invented figures and dates, not a number that happens to sit inside a longer one. */
export function unsupportedNumbers(cue: string, window: string, memory: MemoryNote[]): string[] {
  const hay = (window + ' ' + memory.map(m => `${m.notes} ${m.date}`).join(' ')).toLowerCase().replace(/[$,%]/g, '')
  const bad: string[] = []
  for (const n of cue.match(NUMBER) ?? []) {
    const digits = n.toLowerCase().replace(/[$,%]/g, '').replace(/k$/, '')
    if (digits.length < 2 && !n.startsWith('$')) continue
    if (digits && !hay.includes(digits)) bad.push(n)
  }
  return bad
}

export interface ParsedCue { detail: string; kind: CueKind; memoryIds: string[]; numberFlags: string[] }
export type CueRejection = 'null' | 'unparseable' | 'empty' | 'too_long' | 'unsupported_number'
/** `enforceNumbers` withholds a cue whose numbers are not in the source. Off by default: on the held-out replay the
 *  guard fired on 3 v3 cues and only 1 was unsupported (ASR writes "300 000" and "a hundred"), so it is traced, not enforced. */
/** `allowed` is the meeting's kind set (6.86.0): a kind outside it, or none, falls back to the gate's kind, so a legacy
 *  meeting can never carry decision, promise or followUp even when the writer answers with one. */
export function parseWriterCue(raw: string, fallbackKind: CueKind, window: string, kept: MemoryNote[], enforceNumbers = false,
  allowed: readonly CueKind[] = LEGACY_CUE_KINDS): ParsedCue | CueRejection {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!text || text === 'null') return 'null'
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end < start) return 'unparseable'
  let value: Record<string, unknown>
  try { value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown> } catch { return 'unparseable' }
  const cue = typeof value.cue === 'string' ? value.cue.replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim() : ''
  if (!cue) return 'empty'
  if (cue.length > CUE_DETAIL_MAX) return 'too_long'
  const numberFlags = unsupportedNumbers(cue, window, kept)
  if (enforceNumbers && numberFlags.length) return 'unsupported_number'
  const kind: CueKind = typeof value.kind === 'string' && (allowed as readonly string[]).includes(value.kind) ? value.kind as CueKind : fallbackKind
  const ids = new Set(kept.map(m => m.id))
  const memoryIds = Array.isArray(value.memoryIds) ? [...new Set(value.memoryIds.filter((x): x is string => typeof x === 'string' && ids.has(x)))] : []
  return { detail: cue, kind, memoryIds, numberFlags }
}

/** A stable, opaque id for a past meeting (the same meeting gets the same id in every cue). */
export function sourceId(note: MemoryNote): string {
  return 'mtg_' + createHash('sha256').update(note.key || `${note.date}|${note.title}`).digest('hex').slice(0, 12)
}

/** Local Monday (YYYY-MM-DD) in `zone`. Intl, never toISOString: a UTC key flips the week at 19:00 Central. */
export function localWeekStart(now: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'))
  const local = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))))
  local.setUTCDate(local.getUTCDate() - Math.max(0, dow))
  return local.toISOString().slice(0, 10)
}

// ── Durable state: weekly ceiling, tombstones, pauses, per-meeting counters ─────
interface MeetingCounters { cues: number; writerCalls: number; at: number }
/** 6.79.2: usage on the local calendar day (in the stored zone), for the daily writer ceiling and COS Control's readout. */
export interface LiveCuesV2DayUsage { writerCalls: number; writerTokensIn: number; writerTokensOut: number; cues: number; jevTokens: number }
const DAY_FIELDS = ['writerCalls', 'writerTokensIn', 'writerTokensOut', 'cues', 'jevTokens'] as const
interface DurableState {
  zone: string; weekStart: string; writerCalls: number
  ended: Record<string, number>; paused: Record<string, boolean>; pauseSeq: Record<string, number>
  meetings: Record<string, MeetingCounters>
  day: string; today: LiveCuesV2DayUsage
  /** 6.86.0: meetings armed with resume (Mac recordings): a restarted server re-arms them on their next chunk, with the
   *  kind set they were armed with. Cleared at end; expires with the counters (24 h). */
  resume: Record<string, { at: number; kinds: CueKindSet }>
}
/** Local calendar day (YYYY-MM-DD) in `zone`. Intl, never toISOString: a UTC key flips the day at 19:00 Central. */
export function localDay(now: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
const zeroDay = (): LiveCuesV2DayUsage => ({ writerCalls: 0, writerTokensIn: 0, writerTokensOut: 0, cues: 0, jevTokens: 0 })
/** Saturated writer calls: an unreadable, future-dated or malformed day fails toward NOT spending, like the week. */
const spentDay = (): LiveCuesV2DayUsage => ({ ...zeroDay(), writerCalls: Number.MAX_SAFE_INTEGER })
function validZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || !zone) return null
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return zone } catch { return null }
}
export class LiveCuesV2Store {
  constructor(private readonly file: string, private readonly now: () => Date) {}
  read(): DurableState {
    const nowMs = this.now().getTime()
    try {
      let raw: unknown = {}
      if (existsSync(this.file)) raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
      const s = raw as Partial<DurableState>
      const zone = validZone(s.zone) ?? (s.zone === undefined ? (validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC') : null)
      if (!zone) throw new Error('invalid zone')
      const week = localWeekStart(this.now(), zone)
      const keep = <T>(m: unknown, ok: (v: T) => boolean): Record<string, T> =>
        Object.fromEntries(Object.entries(m && typeof m === 'object' ? m as Record<string, T> : {}).filter(([, v]) => ok(v)))
      const ended = keep<number>(s.ended, at => typeof at === 'number' && at >= nowMs - LIVE_CUES_V2_LIMITS.tombstoneTtlMs)
      const meetings = keep<MeetingCounters>(s.meetings, c => !!c && typeof c.at === 'number' && c.at >= nowMs - LIVE_CUES_V2_LIMITS.counterTtlMs)
      const live = (id: string) => id in meetings || !(id in ended)
      const paused = keep<boolean>(s.paused, v => v === true)
      const resume = keep<{ at: number; kinds: CueKindSet }>(s.resume, r => !!r && typeof r === 'object' && typeof r.at === 'number'
        && r.at >= nowMs - LIVE_CUES_V2_LIMITS.counterTtlMs && (r.kinds === 'legacy' || r.kinds === 'extended'))
      const pauseSeq = keep<number>(s.pauseSeq, v => typeof v === 'number' && Number.isFinite(v))
      for (const id of Object.keys(paused)) if (!live(id) && !(id in meetings)) delete paused[id]
      const sameWeek = s.weekStart === week
      const futureWeek = typeof s.weekStart === 'string' && s.weekStart > week
      const calls = Number(s.writerCalls ?? 0)
      // A future week key or a negative/non-numeric count fails toward NOT spending: the week is saturated.
      const saturated = futureWeek || (sameWeek && !(calls >= 0))
      const day = localDay(this.now(), zone)
      const t = (s.today ?? {}) as Partial<Record<string, unknown>>
      let today: LiveCuesV2DayUsage
      if (s.day === undefined || (typeof s.day === 'string' && s.day < day)) today = zeroDay()
      else if (s.day !== day) today = spentDay()                                   // a future or malformed day
      else today = DAY_FIELDS.every(f => t[f] === undefined || Number(t[f]) >= 0)
        ? Object.fromEntries(DAY_FIELDS.map(f => [f, Number(t[f] ?? 0)])) as unknown as LiveCuesV2DayUsage
        : spentDay()
      return { zone, weekStart: week, writerCalls: saturated ? Number.MAX_SAFE_INTEGER : sameWeek ? calls : 0, ended, paused, pauseSeq, meetings, day, today, resume }
    } catch {
      // An unreadable file fails closed for this week and this day (no spending) but keeps cues off nothing else.
      const zone = validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC'
      return { zone, weekStart: localWeekStart(this.now(), zone), writerCalls: Number.MAX_SAFE_INTEGER, ended: {}, paused: {}, pauseSeq: {}, meetings: {},
        day: localDay(this.now(), zone), today: spentDay(), resume: {} }
    }
  }
  private write(s: DurableState): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.file, JSON.stringify(s) + '\n', { mode: 0o600 })
  }
  /** Charge one writer call BEFORE the call. Never refunded. False when the week is spent. */
  charge(cap: number, sessionId: string): boolean {
    const s = this.read()
    if (s.writerCalls >= cap) return false
    s.writerCalls += 1
    s.today.writerCalls += 1
    const m = s.meetings[sessionId] ?? { cues: 0, writerCalls: 0, at: 0 }
    s.meetings[sessionId] = { ...m, writerCalls: m.writerCalls + 1, at: this.now().getTime() }
    this.write(s)
    return true
  }
  recordCue(sessionId: string): void {
    const s = this.read()
    const m = s.meetings[sessionId] ?? { cues: 0, writerCalls: 0, at: 0 }
    s.meetings[sessionId] = { ...m, cues: m.cues + 1, at: this.now().getTime() }
    s.today.cues += 1
    this.write(s)
  }
  /** Tokens one evaluation spent (writer in and out, the decision provider's gate and judge). One write; nothing when zero. */
  recordUsage(u: { writerTokensIn?: number; writerTokensOut?: number; jevTokens?: number }): void {
    const add = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0)
    const inc = { writerTokensIn: add(u.writerTokensIn), writerTokensOut: add(u.writerTokensOut), jevTokens: add(u.jevTokens) }
    if (!inc.writerTokensIn && !inc.writerTokensOut && !inc.jevTokens) return
    const s = this.read()
    s.today.writerTokensIn += inc.writerTokensIn; s.today.writerTokensOut += inc.writerTokensOut; s.today.jevTokens += inc.jevTokens
    this.write(s)
  }
  /** Today's usage (local day in the stored zone). A saturated (fail-closed) day reads its writer calls as the sentinel. */
  today(): { day: string } & LiveCuesV2DayUsage { const s = this.read(); return { day: s.day, ...s.today } }
  dailyWriterCalls(): number { return this.read().today.writerCalls }
  counters(sessionId: string): { cues: number; writerCalls: number } {
    const m = this.read().meetings[sessionId]
    return { cues: m?.cues ?? 0, writerCalls: m?.writerCalls ?? 0 }
  }
  /** The durable per-meeting counters, or null once they expired (24 h) or never existed. */
  meetingCounters(sessionId: string): { cues: number; writerCalls: number } | null {
    const m = this.read().meetings[sessionId]
    return m ? { cues: m.cues, writerCalls: m.writerCalls } : null
  }
  weeklyUsed(): number { return this.read().writerCalls }
  end(sessionId: string): void { const s = this.read(); s.ended[sessionId] = this.now().getTime(); delete s.paused[sessionId]; delete s.resume[sessionId]; this.write(s) }
  /** 6.86.0: remember an armed meeting so a restarted server re-arms it on its next chunk. One write, only when new. */
  setResume(sessionId: string, kinds: CueKindSet): void {
    const s = this.read()
    if (sessionId in s.ended || s.resume[sessionId]?.kinds === kinds) return
    s.resume[sessionId] = { at: this.now().getTime(), kinds }
    this.write(s)
  }
  /** The kind set a meeting was armed with for resume, or null. */
  resumeKinds(sessionId: string): CueKindSet | null { return this.read().resume[sessionId]?.kinds ?? null }
  isEnded(sessionId: string): boolean { return sessionId in this.read().ended }
  /** Applies only when `seq` is absent or newer than the last applied one. */
  setPaused(sessionId: string, paused: boolean, seq?: number): { applied: boolean; paused: boolean; pauseSeq: number } {
    const s = this.read()
    const last = s.pauseSeq[sessionId] ?? 0
    if (seq !== undefined && seq <= last) return { applied: false, paused: s.paused[sessionId] === true, pauseSeq: last }
    if (paused) s.paused[sessionId] = true; else delete s.paused[sessionId]
    if (seq !== undefined) s.pauseSeq[sessionId] = seq
    this.write(s)
    return { applied: true, paused, pauseSeq: seq ?? last }
  }
  isPaused(sessionId: string): boolean { return this.read().paused[sessionId] === true }
  pauseSeq(sessionId: string): number { return this.read().pauseSeq[sessionId] ?? 0 }
}

// ── Dependencies (real by default, faked in tests) ──────────────────────────
export interface GateResult { pCue: number; kind: CueKind; lookup: Record<string, number> | null; tokens: number }
export interface MemoryResult { notes: MemoryNote[]; denseError?: string; indexAgeH?: number }
/** cueMemory() codes that mean the script did not answer (missing, failed or timed out), so the notes fallback runs. A dense
 *  error the script itself reports (its keyword arm still answered) is not one, nor is an empty answer: on Miles's Mac an
 *  empty cue_memory answer means "no related meeting", and searching his notes instead would change that path. */
export const CUE_MEMORY_FAILURES: ReadonlySet<string> = new Set(['no_cue_memory_script', 'memory_timeout', 'spawn_failed', 'output_limit', 'bad_output', 'memory_threw'])
export function cueMemoryFailed(mem: MemoryResult): boolean { return !!mem.denseError && CUE_MEMORY_FAILURES.has(mem.denseError) }
export interface LiveCuesV2Deps {
  gate(title: string, window: string, signal: AbortSignal, provider: DecisionProvider): Promise<GateResult>
  /** cue_memory.py (Miles's COS scripts). */
  memory(window: string, before: string, signal: AbortSignal): Promise<MemoryResult>
  /** The owner's own COS notes and meetings, used only when `memory` did not answer. Local search, no model call. */
  notes(window: string, before: string, signal: AbortSignal, sessionId: string): Promise<MemoryResult>
  judge(title: string, window: string, notes: MemoryNote[], signal: AbortSignal, provider: DecisionProvider): Promise<{ probs: Record<string, number>; tokens: number }>
  writer(model: string, system: string, prompt: string, signal: AbortSignal): Promise<{ text: string; costUsd?: number; inputTokens?: number; outputTokens?: number; model?: string }>
  emit(type: 'coaching_nudge' | 'coaching_nudge_v2', data: Record<string, unknown>): void
  lease(): MaintenanceWorkLease | null
  /** True while the user's own query runs (Ask, a durable query): cues wait rather than compete for the provider. */
  busy(): boolean
  /** The configured decision provider for cues. Throws DecisionProviderError('decision_invalid_provider'). */
  decisionProvider(): DecisionProvider
  /** That provider's cue client: key present, daily cap, breaker. For an honest capability. */
  decisionState(provider: DecisionProvider): { configured: boolean; breakerOpen: boolean; capReached: boolean }
  /** Where past notes would come from now, for the capability. */
  memorySource(): LiveCuesV2MemorySource
  /** The saved runtime switch (null when none). */
  settings: LiveCuesV2SettingReader
  warmMemory(): void
  now(): Date
  store: LiveCuesV2Store
  trace(row: Record<string, unknown>): void
  /** 6.79.0: the durable cue log (live-cues-log.jsonl) that verdicts are recorded against. May throw; never the trace,
   *  which must stay free of transcript text. */
  cueLog?(row: LiveCueLogRow): void
  env: NodeJS.ProcessEnv
}

function cleanWindow(text: string): string {
  return text.replace(/^\[\d+\]\s*/gm, '').replace(/\*\*?Speaker \d+:?\*\*?:?|Speaker \d+:/g, '')
}

/** The gate and the judge over any decision client. Jev and SubQ take the same request (state plus `choice` questions with
 *  keyed criteria) and answer the same shape (answers.<name>.probabilities and .choice); SubQ also validates every answer
 *  against the questions before it returns. Prompts are byte-identical on both. */
export function cueDecisionCalls(client: Pick<DecisionClient, 'ask'>) {
  return {
    async gate(title: string, window: string, signal: AbortSignal): Promise<GateResult> {
      const state = { meetingTitle: title, window: window.slice(-LIVE_CUES_V2_LIMITS.windowChars) }
      const res: JevAnswers = await client.ask(state, CUE_GATE_QUESTIONS as unknown as Record<string, unknown>, estimateJevTokens({ state, CUE_GATE_QUESTIONS }), { signal })
      const a = res.answers ?? {}
      const kind = a.kind?.choice === 'reinforce' ? 'reinforce' : 'challenge'
      return { pCue: Number(a.act?.probabilities?.cue ?? 0), kind, lookup: a.lookup?.probabilities ?? null, tokens: res.inputTokens }
    },
    async judge(title: string, window: string, notes: MemoryNote[], signal: AbortSignal): Promise<{ probs: Record<string, number>; tokens: number }> {
      const criteria: Record<string, string> = Object.fromEntries(notes.map(m => [m.id, `${m.date} ${m.title}: ${m.notes.slice(0, 300)}`]))
      criteria.none = CUE_JUDGE_NONE
      const state = { meetingTitle: title, window: window.slice(-LIVE_CUES_V2_LIMITS.windowChars) }
      const questions = { same: { type: 'choice', instructions: CUE_JUDGE_INSTRUCTIONS, criteria } }
      const res = await client.ask(state, questions, estimateJevTokens({ state, questions }), { signal })
      return { probs: res.answers?.same?.probabilities ?? {}, tokens: res.inputTokens }
    },
  }
}

/** Is there anything of the owner's own to search when cue_memory.py is absent: the memory bridge or memory files, a
 *  configured meeting library, or this server's own saved recordings. */
function notesAvailable(): boolean {
  try { if (contextSourceAvailable() !== null) return true } catch { /* next */ }
  try { if (meetingLibraryConfigured()) return true } catch { /* next */ }
  try { return getMeetingStore().listMonths().length > 0 } catch { return false }
}

function realDeps(): LiveCuesV2Deps {
  const jev = new JevClient(fetch, () => new Date(), dataPath('jev-cues-usage.json'), jevDailyCap)
  const subq = trackSubqDecisionClient(new SubqDecisionClient(fetch, () => new Date(), dataPath('subq-cues-usage.json'), () => resolveSubqKey()?.key, subqDailyCap))
  const calls = (provider: DecisionProvider) => cueDecisionCalls(provider === 'subq' ? subq : jev)
  const traceFile = dataPath('live-cues-trace.jsonl')
  let memorySourceCache: { at: number; value: LiveCuesV2MemorySource } | null = null
  return {
    gate: (title, window, signal, provider) => calls(provider).gate(title, window, signal),
    memory: (window, before, signal) => cueMemory(window, before, signal),
    async notes(window, before, signal, sessionId) {
      const r = await notesMemory(window, before, signal, { sessionId })
      return { notes: r.notes, ...(r.error ? { denseError: r.error } : {}) }
    },
    judge: (title, window, notes, signal, provider) => calls(provider).judge(title, window, notes, signal),
    decisionProvider: () => resolveCuesDecisionProvider(process.env).provider,
    decisionState(provider) {
      if (provider === 'subq') {
        const st = subq.status()
        return { configured: st.configured, breakerOpen: st.breakerOpenUntil !== null, capReached: st.usedToday >= st.dailyCap }
      }
      const st = jev.status()
      return { configured: !!resolveJevKey(), breakerOpen: !!st.breakerOpenUntil, capReached: st.usedToday >= st.dailyCap }
    },
    memorySource() {
      // /api/health polls the capability: probe the disk at most once a minute.
      const nowMs = Date.now()
      if (memorySourceCache && nowMs - memorySourceCache.at < 60_000) return memorySourceCache.value
      const value: LiveCuesV2MemorySource = cueMemoryPaths() ? 'cue_memory' : notesAvailable() ? 'notes' : 'none'
      memorySourceCache = { at: nowMs, value }
      return value
    },
    settings: liveCuesV2Settings(),
    async writer(model, system, prompt, signal) {
      const run = await runLensGistEngine('claude', model, prompt, { system, timeoutMs: LIVE_CUES_V2_LIMITS.writerTimeoutMs, source: 'live-cues-v2', maxOutputTokens: LIVE_CUES_V2_LIMITS.writerMaxOutputTokens, signal })
      return { text: run.text, costUsd: run.usage?.costUsd, inputTokens: run.usage?.inputTokens, outputTokens: run.usage?.outputTokens, model: run.model }
    },
    emit: (type, data) => emitDisplay({ type, data }),
    lease: () => acquireMaintenanceWork('live_cue_pipeline'),
    busy() {
      const active = maintenanceLifecycle.snapshot().activeByKind as Record<string, number>
      return ['durable_query', 'legacy_query', 'openai_query', 'meeting_ask'].some(kind => (active[kind] ?? 0) > 0)
    },
    warmMemory: () => warmCueMemory(),
    now: () => new Date(),
    store: new LiveCuesV2Store(dataPath('live-cues-v2-state.json'), () => new Date()),
    trace(row) {
      try { mkdirSync(dirname(traceFile), { recursive: true, mode: 0o700 }); appendFileSync(traceFile, JSON.stringify(row) + '\n', { mode: 0o600 }) } catch { /* trace is best effort */ }
    },
    cueLog: row => liveCueVerdicts().logCue(row),
    env: process.env,
  }
}

export interface CueMemoryPaths { python: string; script: string; cwd: string }
function cueMemoryPaths(): CueMemoryPaths | null {
  const python = PYTHON_BIN, scriptsDir = COS_SCRIPTS_DIR
  if (!python || !scriptsDir) return null
  const script = resolve(scriptsDir, 'cue_memory.py')
  return existsSync(script) && existsSync(python) ? { python, script, cwd: scriptsDir } : null
}

/** Starts a background index refresh when the cache is stale (non-blocking; the script locks and skips if fresh). */
export function warmCueMemory(): void {
  const p = cueMemoryPaths()
  if (!p) return
  try {
    const proc = spawn(p.python, [p.script, '--warm'], { cwd: p.cwd, detached: true, stdio: 'ignore' })
    proc.on('error', () => { /* warm is best effort */ })
    proc.unref()
  } catch { /* warm is best effort */ }
}

/** Rank-fusion retrieval through COS scripts/cue_memory.py. Transcript text goes over stdin, never argv. Non-fatal. */
export function cueMemory(window: string, before: string, signal: AbortSignal, p: CueMemoryPaths | null = cueMemoryPaths(), timeoutMs: number = LIVE_CUES_V2_LIMITS.memoryTimeoutMs): Promise<MemoryResult> {
  if (!p) return Promise.resolve({ notes: [], denseError: 'no_cue_memory_script' })
  const paths = p
  return new Promise(resolveNotes => {
    let proc: ChildProcess, out = '', settled = false
    const done = (r: MemoryResult) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolveNotes(r) }
    const kill = () => { if (proc) void terminateProviderProcess(proc).catch(() => {}) }
    const onAbort = () => { kill(); done({ notes: [] }) }
    const timer = setTimeout(() => { kill(); done({ notes: [], denseError: 'memory_timeout' }) }, timeoutMs)
    try {
      proc = spawn(paths.python, [paths.script, '--stdin'], { cwd: paths.cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch { done({ notes: [], denseError: 'spawn_failed' }); return }
    signal.addEventListener('abort', onAbort, { once: true })
    proc.stdout?.on('data', b => { out += String(b); if (out.length > 200_000) { kill(); done({ notes: [], denseError: 'output_limit' }) } })
    proc.on('error', () => done({ notes: [], denseError: 'spawn_failed' }))
    proc.on('close', () => {
      try {
        const res = JSON.parse(out) as { notes?: MemoryNote[]; timing?: { dense_error?: string }; index?: { ageHours?: number } }
        const notes = (res.notes ?? []).filter(n => n && typeof n.id === 'string' && typeof n.notes === 'string').slice(0, 4)
        done({ notes, denseError: res.timing?.dense_error, indexAgeH: res.index?.ageHours })
      } catch { done({ notes: [], denseError: 'bad_output' }) }
    })
    proc.stdin?.on('error', () => { /* child exited early */ })
    proc.stdin?.end(JSON.stringify({ queries: [window.slice(-600)], keywordText: window, before, top: 4 }))
  })
}

// ── Engine ──────────────────────────────────────────────────────────────────
interface Session {
  sessionId: string
  title: string
  armedAt: number
  lastSeenAt: number
  chunks: string[]
  wordsSinceEval: number
  lastEvalAt: number
  lastCueAt: number
  inFlight: AbortController | null
  cues: LiveCueV2[]
  evaluations: number
  failures: number
  breaker: boolean
  /** The last reason cues were not produced, cleared by the next evaluation that runs the writer. */
  stopReason: LiveCuesV2StopReason | null
  skipTracedAt: Record<string, number>
  /** 6.86.0: the kinds this meeting's cues may carry, fixed at arm. */
  kinds: CueKindSet
}

/** 6.86.0: how a meeting is armed. `kinds` defaults by session (defaultCueKindSet); `resume` makes a restarted server re-arm
 *  it on its next chunk (the Mac recording start passes it). */
export interface LiveCuesV2ArmOptions { kinds?: CueKindSet; resume?: boolean }

export class LiveCuesV2ArmError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = 'LiveCuesV2ArmError' }
}

function isCancel(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

/** Decision-provider codes that stop cues quietly with a reason (not a failure, so not toward the meeting breaker). The
 *  provider's own breaker and cap already bound these; counting them would also end the meeting's cues. */
export const QUIET_DECISION_STOPS: ReadonlySet<string> = new Set(['jev_cap_reached', 'jev_breaker_open', 'jev_not_configured',
  'decision_cap_reached', 'decision_breaker_open', 'decision_not_configured', 'decision_invalid_provider'])
/** Abort reason when v2 is switched off at runtime. */
export const V2_OFF = 'v2_off'

export class LiveCuesV2Engine {
  private readonly sessions = new Map<string, Session>()
  constructor(private readonly deps: LiveCuesV2Deps) {}

  private enabled(): boolean { return liveCuesV2Enabled(this.deps.env, this.deps.settings) }
  /** 6.79.2: the spend limits as they stand now (env, else COS Control's saved values, else the defaults). The writer
   *  cap per meeting stays twice the cue cap. */
  private limits(): { gate: number; maxCues: number; writerCap: number; cooldownMs: number; dailyWriterCalls: number } {
    const r = resolveLiveCuesV2Limits(this.deps.env, this.deps.settings)
    return { gate: r.gate.value, maxCues: r.maxCuesPerMeeting.value, writerCap: 2 * r.maxCuesPerMeeting.value,
      cooldownMs: r.cooldownSeconds.value * 1000, dailyWriterCalls: r.dailyWriterCalls.value }
  }
  /** Today's usage for COS Control (local day in the stored zone). */
  today(): { day: string } & LiveCuesV2DayUsage { return this.deps.store.today() }

  capability(): LiveCuesV2Capability {
    const model = liveCuesV2Model(this.deps.env)
    let memory: LiveCuesV2MemorySource = 'none'
    try { memory = this.deps.memorySource() } catch { memory = 'none' }
    let provider: DecisionProvider | null = null
    try { provider = this.deps.decisionProvider() } catch { provider = null }
    const tail = { protocol: LIVE_CUES_V2_PROTOCOL, model, memory, ...(provider ? { decisionProvider: provider } : {}) }
    const off = (reason: string): LiveCuesV2Capability => ({ available: false, reason, ...tail })
    try {
      if (!this.enabled()) return off('master_flag_off')
      if (this.deps.env.ANTHROPIC_API_KEY && this.deps.env.COS_ALLOW_API_FALLBACK !== '1') return off('api_key_in_env')
      if (!provider) return off('decision_invalid_provider')
      const st = this.deps.decisionState(provider)
      // jev_not_configured keeps its 6.75 meaning (Jev chosen, no Jev key) only when a SubQ key exists; with no key for
      // the chosen provider otherwise, the reason is decision_not_configured.
      if (!st.configured) return off(provider === 'jev' && this.deps.decisionState('subq').configured ? 'jev_not_configured' : 'decision_not_configured')
      if (!resolveProviderBinary('claude').ok) return off('claude_not_found')
      if (this.deps.store.weeklyUsed() >= liveCuesV2WeeklyCap(this.deps.env)) return off('budget_exhausted')
      if (st.capReached) return off(provider === 'jev' ? 'jev_cap_reached' : 'decision_cap_reached')
      if (st.breakerOpen) return off(provider === 'jev' ? 'jev_breaker_open' : 'decision_breaker_open')
      return { available: true, ...tail }
    } catch {
      return off('unavailable')
    }
  }

  /** Idempotent. A repeat start for an armed meeting keeps its counters and its kinds; an ended meeting cannot be re-armed.
   *  `kinds` (6.86.0, additive) is the kind list this meeting's cues may carry. */
  arm(sessionId: string, opts: LiveCuesV2ArmOptions = {}): { armed: true; sessionId: string; protocol: 2; cuesGenerated: number; paused: boolean; pauseSeq: number; kinds: CueKind[] } {
    this.reap()
    const cap = this.capability()
    if (!cap.available) throw new LiveCuesV2ArmError(cap.reason ?? 'unavailable', cap.reason === 'master_flag_off' ? 403 : 503, `Live cues v2 unavailable: ${cap.reason}.`)
    const mac = MAC_CAPTURE_ID.test(sessionId)
    if (mac && !liveCuesV2MacAllowed(this.deps.env)) throw new LiveCuesV2ArmError('mac_cues_off', 403, 'Live cues are switched off for Mac recordings (COS_LIVE_CUES_V2_MAC=0).')
    if (this.deps.store.isEnded(sessionId)) throw new LiveCuesV2ArmError('meeting_ended', 409, 'This meeting has ended; live cues cannot be re-armed for it.')
    const existing = this.sessions.get(sessionId)
    const nowMs = this.deps.now().getTime()
    const answer = (cues: number, kinds: CueKindSet) => ({ armed: true as const, sessionId, protocol: 2 as const, cuesGenerated: cues, paused: this.deps.store.isPaused(sessionId),
      pauseSeq: this.deps.store.pauseSeq(sessionId), kinds: [...(kinds === 'extended' ? CUE_KINDS : LEGACY_CUE_KINDS)] })
    if (existing) {
      existing.lastSeenAt = nowMs
      if (opts.resume) this.deps.store.setResume(sessionId, existing.kinds)
      return answer(existing.cues.length, existing.kinds)
    }
    const kinds = opts.kinds ?? defaultCueKindSet(sessionId)
    const d = this.deps.now()
    const title = `${mac ? 'Mac' : 'G2'} Recording ${d.toLocaleDateString('en-CA')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    this.sessions.set(sessionId, { sessionId, title, armedAt: nowMs, lastSeenAt: nowMs, chunks: [], wordsSinceEval: 0, lastEvalAt: 0, lastCueAt: 0,
      inFlight: null, cues: [], evaluations: 0, failures: 0, breaker: false, stopReason: null, skipTracedAt: {}, kinds })
    if (opts.resume) this.deps.store.setResume(sessionId, kinds)
    this.deps.warmMemory()
    return answer(this.deps.store.counters(sessionId).cues, kinds)
  }

  /** Stop or save: tombstone FIRST (so trailing chunks cannot revive it), then abort any evaluation in flight. */
  end(sessionId: string): { nudgesGenerated: number; nudges: Array<Record<string, unknown>>; protocol: 2; cues: LiveCueV2[] } {
    this.deps.store.end(sessionId)
    const s = this.sessions.get(sessionId)
    s?.inFlight?.abort()
    const cues = s ? [...s.cues] : []
    return { nudgesGenerated: cues.length, protocol: 2, cues,
      // v1 readers know two types: an extended kind is shown as its legacy kind there (the cues keep the real one).
      nudges: cues.map(c => ({ nudge: c.headline, type: legacyCueKind(c.kind), priority: 2, timestamp: c.createdAt, cueId: c.cueId })) }
  }

  setPaused(sessionId: string, paused: boolean, seq?: number): { ok: true; paused: boolean; applied: boolean; pauseSeq: number } {
    const r = this.deps.store.setPaused(sessionId, paused, seq)
    if (r.applied && paused) this.sessions.get(sessionId)?.inFlight?.abort()
    return { ok: true, ...r }
  }

  status(sessionId: string): LiveCuesV2StatusResponse {
    const s = this.sessions.get(sessionId)
    const ended = this.deps.store.isEnded(sessionId)
    const paused = this.deps.store.isPaused(sessionId)
    if (!s && !ended) return { protocol: 2, enabled: this.enabled(), session: null }
    const counters = this.deps.store.counters(sessionId)
    const reason = s ? this.stopReasonOf(s, counters) : null
    const session: LiveCuesV2SessionStatus = {
      sessionId, state: ended ? 'ended' : paused ? 'paused' : reason ? 'stopped' : 'active', ...(reason && !ended && !paused ? { reason } : {}),
      paused, ended, pauseSeq: this.deps.store.pauseSeq(sessionId), cues: s ? [...s.cues] : [], evaluations: s?.evaluations ?? 0, writerCalls: counters.writerCalls,
    }
    return { protocol: 2, enabled: this.enabled(), session }
  }

  private stopReasonOf(s: Session, counters: { cues: number; writerCalls: number }): LiveCuesV2StopReason | null {
    const lim = this.limits()
    if (s.breaker) return 'breaker_open'
    if (counters.cues >= lim.maxCues || counters.writerCalls >= lim.writerCap) return 'meeting_cap'
    // The daily ceiling reads as budget_exhausted on the wire: the shared stop-reason union (pinned with the companion's
    // copy) has no daily_cap. The trace says daily_cap.
    if (this.deps.store.weeklyUsed() >= liveCuesV2WeeklyCap(this.deps.env) || this.deps.store.dailyWriterCalls() >= lim.dailyWriterCalls) return 'budget_exhausted'
    return s.stopReason
  }

  /** The cue, if this process emitted it and still holds it, under whichever meeting. */
  findCue(cueId: string): LiveCueV2 | null {
    for (const s of this.sessions.values()) { const cue = s.cues.find(c => c.cueId === cueId); if (cue) return cue }
    return null
  }

  recordFeedback(input: { sessionId: string; cueId: string; vote: 'up' | 'down'; reason?: string }): { ok: true; knownCue: boolean } {
    const knownCue = !!this.sessions.get(input.sessionId)?.cues.some(c => c.cueId === input.cueId)
    const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, CUE_FEEDBACK_REASON_MAX)
    this.deps.trace({ kind: 'feedback', at: this.deps.now().toISOString(), sessionId: input.sessionId, cueId: input.cueId, vote: input.vote, knownCue, ...(reason ? { reason } : {}) })
    return { ok: true, knownCue }
  }

  /** From the ASR path: fire-and-forget, never awaited. All gates live here. */
  async feed(sessionId: string, text: string, asrDegraded = false): Promise<void> {
    if (!this.enabled()) return
    if (this.deps.store.isEnded(sessionId)) return                    // tombstone before any auto-arm
    let s = this.sessions.get(sessionId)
    if (!s) {
      // 6.86.0: a meeting armed with resume (a Mac recording) is re-armed with its kinds after a server restart.
      const resume = this.deps.store.resumeKinds(sessionId)
      if (this.deps.env.COS_LIVE_CUES_AUTO !== '1' && !resume) return
      try { this.arm(sessionId, resume ? { kinds: resume } : {}) } catch { return }
      if (resume) this.deps.trace({ kind: 'resume', at: this.deps.now().toISOString(), sessionId, kindSet: resume })
      s = this.sessions.get(sessionId)
      if (!s) return
    }
    const nowMs = this.deps.now().getTime()
    s.lastSeenAt = nowMs
    const words = text.trim().split(/\s+/).filter(Boolean)
    if (words.length) {
      s.chunks.push(text.trim())
      s.wordsSinceEval += words.length
      let total = s.chunks.reduce((n, c) => n + c.split(/\s+/).length, 0)
      while (s.chunks.length > 1 && total > LIVE_CUES_V2_LIMITS.windowWords) { total -= s.chunks[0].split(/\s+/).length; s.chunks.shift() }
    }
    const L = LIVE_CUES_V2_LIMITS
    if (s.inFlight || asrDegraded) return
    if (s.breaker) return this.traceSkip(s, 'breaker_open', nowMs)
    if (this.deps.store.isPaused(sessionId)) return this.traceSkip(s, 'paused', nowMs)
    if (s.wordsSinceEval < L.minNewWords) return
    const lim = this.limits()
    if (nowMs - s.lastEvalAt < L.minIntervalMs || nowMs - s.lastCueAt < lim.cooldownMs) return
    const counters = this.deps.store.counters(sessionId)
    if (counters.cues >= lim.maxCues || counters.writerCalls >= lim.writerCap) return this.traceSkip(s, 'meeting_cap', nowMs)
    if (this.deps.store.weeklyUsed() >= liveCuesV2WeeklyCap(this.deps.env)) return this.traceSkip(s, 'budget_exhausted', nowMs)  // before the gate
    if (this.deps.store.dailyWriterCalls() >= lim.dailyWriterCalls) return this.traceSkip(s, 'daily_cap', nowMs)              // before the gate
    if (this.deps.busy()) return this.traceSkip(s, 'busy', nowMs)
    await this.evaluate(s)
  }

  private traceSkip(s: Session, reason: string, nowMs: number): void {
    if (nowMs - (s.skipTracedAt[reason] ?? 0) < LIVE_CUES_V2_LIMITS.skipTraceEveryMs) return
    s.skipTracedAt[reason] = nowMs
    this.deps.trace({ kind: 'skip', at: new Date(nowMs).toISOString(), sessionId: s.sessionId, reason })
  }

  private async evaluate(s: Session): Promise<void> {
    const L = LIVE_CUES_V2_LIMITS
    const started = this.deps.now().getTime()
    const abort = new AbortController()
    s.inFlight = abort
    s.evaluations += 1
    s.lastEvalAt = started
    s.wordsSinceEval = 0
    const window = cleanWindow(s.chunks.join('\n')).slice(-L.windowChars)
    // 6.79.0: what was said up to this evaluation, speaker labels kept, for the cue log's `before` (never a model input).
    const said = s.chunks.join('\n').replace(/^\[\d+\]\s*/gm, '')
    const trace: Record<string, unknown> = { kind: 'evaluation', at: new Date(started).toISOString(), sessionId: s.sessionId, n: s.evaluations }
    let lease: MaintenanceWorkLease | null = null
    let wallHit = false
    const wall = setTimeout(() => { wallHit = true; abort.abort() }, L.pipelineWallMs)
    wall.unref?.()
    try {
      try { lease = this.deps.lease() } catch (e) { if (e instanceof MaintenanceLifecycleError) { trace.outcome = 'maintenance'; return } throw e }
      // One provider per evaluation: a settings change applies from the next one, never between the gate and the judge.
      const provider = this.deps.decisionProvider()
      trace.decisionProvider = provider
      const t0 = Date.now()
      const gate = await this.deps.gate(s.title, window, abort.signal, provider)
      const pCue = Number.isFinite(gate.pCue) ? gate.pCue : 0
      Object.assign(trace, { gateMs: Date.now() - t0, pCue: round(pCue), cueKind: gate.kind, lookup: gate.lookup, gateTokens: gate.tokens })
      if (pCue < this.limits().gate) { trace.outcome = 'gate_silent'; s.stopReason = null; return }
      if (abort.signal.aborted) { trace.outcome = 'cancelled'; return }

      const t1 = Date.now()
      const before = new Date(started + 86_400_000).toLocaleDateString('en-CA')
      let mem: MemoryResult = await this.deps.memory(window, before, abort.signal).catch((): MemoryResult => ({ notes: [], denseError: 'memory_threw' }))
      Object.assign(trace, { memoryMs: Date.now() - t1, ...(mem.denseError ? { memoryError: mem.denseError } : {}), ...(mem.indexAgeH !== undefined ? { indexAgeH: mem.indexAgeH } : {}) })
      let source: LiveCuesV2MemorySource = 'cue_memory'
      if (cueMemoryFailed(mem) && !abort.signal.aborted) {
        // cue_memory.py did not answer: search the owner's own COS (no model call), inside its own 3 s budget.
        const tn = Date.now()
        const found: MemoryResult = await this.deps.notes(window, before, abort.signal, s.sessionId).catch((): MemoryResult => ({ notes: [], denseError: 'notes_threw' }))
        Object.assign(trace, { notesMs: Date.now() - tn, ...(found.denseError ? { notesError: found.denseError } : {}) })
        mem = { notes: found.notes }
        source = 'notes'
      }
      Object.assign(trace, { candidates: mem.notes.length, cueMemorySource: mem.notes.length ? source : 'none' })
      let kept: MemoryNote[] = []
      if (mem.notes.length && !abort.signal.aborted) {
        const t2 = Date.now()
        const judged = await this.deps.judge(s.title, window, mem.notes, abort.signal, provider)
        Object.assign(trace, { judgeMs: Date.now() - t2, judgeTokens: judged.tokens })
        kept = mem.notes.filter(m => (judged.probs[m.id] ?? 0) >= liveCuesV2JudgeKeep(this.deps.env)).slice(0, L.judgeMaxNotes).map((m, i) => ({ ...m, id: `M${i + 1}` }))
      }
      trace.kept = kept.length
      if (abort.signal.aborted) { trace.outcome = 'cancelled'; return }

      // 6.79.2: limits lowered while this evaluation ran apply before the writer is charged.
      const lim = this.limits(), counters = this.deps.store.counters(s.sessionId)
      if (counters.cues >= lim.maxCues || counters.writerCalls >= lim.writerCap) { trace.outcome = 'meeting_cap'; return }
      if (this.deps.store.dailyWriterCalls() >= lim.dailyWriterCalls) { trace.outcome = 'daily_cap'; s.stopReason = 'budget_exhausted'; return }
      if (!this.deps.store.charge(liveCuesV2WeeklyCap(this.deps.env), s.sessionId)) { trace.outcome = 'budget_exhausted'; s.stopReason = 'budget_exhausted'; return }
      const { version, system } = liveCuesV2WriterSystem(this.deps.env, s.kinds)
      if (s.kinds === 'extended') trace.kindSet = 'extended'
      const model = liveCuesV2Model(this.deps.env)
      const previous = s.cues.slice(-3).map(c => c.detail)
      const promptMemory = kept.map(m => ({ id: m.id, date: m.date, title: m.title, notes: m.notes }))  // the replay's exact keys
      const prompt = pyJson({ meetingTitle: s.title, liveIssue: '', suggestedKind: gate.kind, previousCues: previous, memory: promptMemory, window })
      const t3 = Date.now()
      const out = await this.deps.writer(model, system, prompt, abort.signal)
      Object.assign(trace, { writerMs: Date.now() - t3, prompt: version, model: out.model ?? model, writerUsd: out.costUsd, writerIn: out.inputTokens, writerOut: out.outputTokens })
      if (abort.signal.aborted) { trace.outcome = 'cancelled'; return }
      s.failures = 0
      s.stopReason = null

      const parsed = parseWriterCue(out.text, gate.kind, window, kept, this.deps.env.COS_LIVE_CUES_V2_NUMBER_GUARD === 'withhold',
        s.kinds === 'extended' ? CUE_KINDS : LEGACY_CUE_KINDS)
      if (typeof parsed === 'string') { trace.outcome = parsed === 'null' ? 'writer_null' : `withheld_${parsed}`; return }
      const elapsed = this.deps.now().getTime() - started
      if (s.wordsSinceEval > L.staleWords || elapsed > L.staleMs) { trace.outcome = 'stale'; return }
      if (this.deps.store.isEnded(s.sessionId) || this.deps.store.isPaused(s.sessionId) || !this.enabled()) { trace.outcome = 'cancelled'; return }

      const sources: CueSourceRef[] = parsed.memoryIds.map(id => kept.find(m => m.id === id)).filter((m): m is MemoryNote => !!m)
        .map(m => ({ id: sourceId(m), date: m.date, title: m.title }))
      const cue: LiveCueV2 = { protocol: 2, cueId: randomUUID(), sessionId: s.sessionId, headline: cueHeadline(parsed.detail), detail: parsed.detail,
        kind: parsed.kind, sources, gate: round(pCue), createdAt: this.deps.now().getTime(), model: out.model ?? model }
      if (!isLiveCueV2(cue)) { trace.outcome = 'withheld_invalid'; return }       // never emit what the companion would drop
      // 6.79.0 repeat rule, off unless COS_LIVE_CUES_V2_REPEAT_OVERLAP is set: a cue that repeats an earlier SHOWN cue of
      // this meeting is not logged, emitted or counted (the writer call already counted). Ids and the overlap only.
      const repeatT = liveCuesV2RepeatOverlap(this.deps.env)
      const repeat = repeatT === null ? null : repeatOf(cue.detail, s.cues, repeatT)
      if (repeat) { Object.assign(trace, { outcome: 'withheld_repeat', repeatOf: repeat.blocker, repeatOverlap: repeat.overlap }); return }
      // 6.79.0: logged before it is held or emitted, so a rating that arrives at once finds it. Its own try/catch: a log
      // failure is traced on this evaluation and is never a writer failure or a step toward the breaker.
      try {
        this.deps.cueLog?.({ v: 1, cueId: cue.cueId, sessionId: s.sessionId, meetingTitle: s.title, createdAt: cue.createdAt, armedAt: s.armedAt, kind: cue.kind,
          headline: cue.headline, detail: cue.detail, gate: cue.gate, sources: cue.sources, model: cue.model, prompt: version,
          memorySource: mem.notes.length ? source : 'none', kept: kept.length, wouldWithhold: wouldWithhold(cue.detail, s.cues), before: cueBefore(said) })
      } catch (error) {
        trace.cueLogError = (error as NodeJS.ErrnoException)?.code ?? 'append_failed'
        console.warn(`[live-cues-v2] cue log append failed: ${errMsg(error)}`)
      }
      s.cues.push(cue)
      s.lastCueAt = cue.createdAt
      this.deps.store.recordCue(s.sessionId)
      this.deps.emit('coaching_nudge_v2', cue as unknown as Record<string, unknown>)
      const v1: LiveCueV1Compat = { nudge: cue.headline, type: legacyCueKind(cue.kind), priority: 2, cueId: cue.cueId, sessionId: s.sessionId, protocol: 2 }
      this.deps.emit('coaching_nudge', v1 as unknown as Record<string, unknown>)
      Object.assign(trace, { outcome: 'cue', cueId: cue.cueId, cueChars: cue.detail.length, sources: sources.length, ...(parsed.numberFlags.length ? { numberFlags: parsed.numberFlags.length } : {}) })
    } catch (error) {
      if (wallHit) { trace.outcome = 'failure'; trace.error = 'wall_timeout'; s.failures += 1; if (s.failures >= L.breakerFailures) s.breaker = true; return }
      if (isCancel(error, abort.signal)) { trace.outcome = 'cancelled'; return }
      if ((error instanceof JevError || error instanceof DecisionProviderError) && QUIET_DECISION_STOPS.has(error.code)) {
        trace.outcome = error.code
        s.stopReason = error.code as LiveCuesV2StopReason
        return
      }
      trace.outcome = 'failure'
      trace.error = error instanceof JevError || error instanceof DecisionProviderError ? error.code : error instanceof LensGistLimitError ? 'writer_quota' : 'writer_error'
      s.failures += 1
      if (error instanceof LensGistLimitError || s.failures >= L.breakerFailures) s.breaker = true
    } finally {
      clearTimeout(wall)
      // 6.79.2: today's spend for COS Control, from the numbers this evaluation traced. One write; best effort.
      try {
        this.deps.store.recordUsage({ writerTokensIn: trace.writerIn as number | undefined, writerTokensOut: trace.writerOut as number | undefined,
          jevTokens: (Number(trace.gateTokens) || 0) + (Number(trace.judgeTokens) || 0) })
      } catch { /* the readout is best effort; the trace row still has the numbers */ }
      if (wallHit && trace.outcome === 'cancelled') { trace.outcome = 'failure'; trace.error = 'wall_timeout'; s.failures += 1; if (s.failures >= L.breakerFailures) s.breaker = true }
      if (trace.outcome === 'cancelled' && abort.signal.reason === V2_OFF) trace.cancelReason = V2_OFF
      s.inFlight = null
      try { lease?.release() } catch { /* released */ }
      trace.totalMs = this.deps.now().getTime() - started
      this.deps.trace(trace)
    }
  }

  private reap(): void {
    const nowMs = this.deps.now().getTime()
    for (const [id, s] of this.sessions) if (!s.inFlight && nowMs - s.lastSeenAt > LIVE_CUES_V2_LIMITS.sessionTtlMs) this.sessions.delete(id)
  }

  shutdown(): void { for (const s of this.sessions.values()) s.inFlight?.abort(); this.sessions.clear() }

  /** v2 switched off at runtime (6.76.2): abort every evaluation in flight, so no half-written cue is emitted and every
   *  lease is released. Sessions are kept (no new evaluation starts while off), so switching back on resumes a running
   *  meeting from its next evaluation. */
  suspend(): number {
    let aborted = 0
    for (const s of this.sessions.values()) if (s.inFlight) { s.inFlight.abort(V2_OFF); aborted += 1 }
    return aborted
  }

  /** Was this meeting armed under v2 in this process? Its stop and status stay v2 even after v2 is switched off. */
  knows(sessionId: string): boolean { return this.sessions.has(sessionId) }
}

function round(n: number): number { return Math.round(n * 1000) / 1000 }

// ── Singleton wiring ────────────────────────────────────────────────────────
let engine: LiveCuesV2Engine | null = null
let unsubscribe: (() => void) | null = null
export function liveCuesV2(): LiveCuesV2Engine {
  if (!engine) {
    engine = new LiveCuesV2Engine(realDeps())
    // A saved meeting ends its cues even when the phone never sent Stop (orphan recovery, Control save).
    unsubscribe = onDisplay(event => {
      const sid = event.type === 'recording_stop' ? event.data?.sessionId : null
      // Also when v2 was switched off mid-meeting: a meeting it armed still ends, so it never lingers as active.
      if (typeof sid === 'string' && sid && (liveCuesV2Enabled() || engine?.knows(sid))) engine?.end(sid)
    })
  }
  return engine
}
/** The engine if it exists, without creating one (a v1-only server never builds the v2 clients). */
export function peekLiveCuesV2(): LiveCuesV2Engine | null { return engine }
export function liveCuesV2Capability(): LiveCuesV2Capability { return liveCuesV2().capability() }

/** 6.86.0: what POST /api/mac-recording/start answers under `liveCues` when COS Control asked for cues. Never throws:
 *  a refusal is a reason code and the recording starts regardless. */
export type MacLiveCuesAnswer =
  | { armed: true; kinds: CueKind[]; cuesGenerated: number; paused: boolean; pauseSeq: number }
  | { armed: false; reason: string }
/** Arms live cues for a Mac recording, under the same switch, caps and limits as every meeting, with the extended kinds and
 *  resume (a restarted server re-arms it on its next chunk). With v2 off the answer is master_flag_off and the engine is
 *  never built: a Mac recording never reaches the v1 Composer path. */
export function armMacLiveCues(sessionId: string, env: NodeJS.ProcessEnv = process.env): MacLiveCuesAnswer {
  if (!liveCuesV2Enabled(env)) return { armed: false, reason: 'master_flag_off' }
  if (!liveCuesV2MacAllowed(env)) return { armed: false, reason: 'mac_cues_off' }
  try {
    const a = liveCuesV2().arm(sessionId, { resume: true })
    return { armed: true, kinds: a.kinds, cuesGenerated: a.cuesGenerated, paused: a.paused, pauseSeq: a.pauseSeq }
  } catch (error) {
    return { armed: false, reason: error instanceof LiveCuesV2ArmError ? error.code : 'unavailable' }
  }
}

/** GET/POST /api/live-cues/v2/settings (COS Control's toggle). */
export interface LiveCuesV2SettingsResponse { enabled: boolean; source: LiveCuesV2SettingSource; capability: LiveCuesV2Capability }
export function liveCuesV2SettingsView(env: NodeJS.ProcessEnv = process.env): LiveCuesV2SettingsResponse {
  const r = resolveLiveCuesV2(env, liveCuesV2Settings())
  return { enabled: r.enabled, source: r.source, capability: liveCuesV2Capability() }
}
/** Save the switch. Off while env forces it on is refused and changes nothing. Turning it off ends cue evaluation for running
 *  meetings at once; turning it on applies from each meeting's next evaluation. */
export function setLiveCuesV2Enabled(enabled: boolean, env: NodeJS.ProcessEnv = process.env): { ok: true; view: LiveCuesV2SettingsResponse } | { ok: false; error: 'env_forced' } {
  const r = applyLiveCuesV2Settings({ enabled, limits: {} }, env)
  if (!r.ok) return { ok: false, error: 'env_forced' }
  return { ok: true, view: liveCuesV2SettingsView(env) }
}

/** GET /api/live-cues/v2/settings?v=2 and POST {v: 2, ...} (6.79.2): the v1 body plus the spend limits and today's usage.
 *  Without v=2 the routes answer exactly the v1 body, so an older COS Control is unaffected. */
export interface LiveCuesV2SettingsResponseV2 extends LiveCuesV2SettingsResponse {
  v: 2
  limits: LiveCuesV2Limits
  /** Always twice the cue cap. */
  writerCallsPerMeeting: number
  today: { day: string } & LiveCuesV2DayUsage
}
export function liveCuesV2SettingsViewV2(env: NodeJS.ProcessEnv = process.env): LiveCuesV2SettingsResponseV2 {
  const limits = resolveLiveCuesV2Limits(env, liveCuesV2Settings())
  return { ...liveCuesV2SettingsView(env), v: 2, limits, writerCallsPerMeeting: 2 * limits.maxCuesPerMeeting.value, today: liveCuesV2().today() }
}

/** Save the switch and any limits in ONE write, after every check passed: nothing is saved when any part is refused.
 *  Turning v2 off stops evaluations in flight; limits apply from each meeting's next evaluation. */
export function applyLiveCuesV2Settings(patch: { enabled?: boolean; limits: LiveCuesV2StoredLimits }, env: NodeJS.ProcessEnv = process.env):
  { ok: true } | { ok: false; error: 'env_forced' } | { ok: false; error: 'env_locked'; fields: LiveCuesV2LimitName[] } {
  if (patch.enabled === false && liveCuesV2EnvForced(env)) return { ok: false, error: 'env_forced' }
  const current = resolveLiveCuesV2Limits(env, liveCuesV2Settings())
  const locked = (Object.keys(patch.limits) as LiveCuesV2LimitName[]).filter(name => current[name].locked)
  if (locked.length) return { ok: false, error: 'env_locked', fields: locked }
  const wasOn = liveCuesV2Enabled(env)
  liveCuesV2Settings().update(patch)
  if (wasOn && !liveCuesV2Enabled(env)) {
    const aborted = engine?.suspend() ?? 0
    console.log(`[live-cues-v2] switched off by setting; ${aborted} evaluation(s) stopped`)
  } else if (!wasOn && liveCuesV2Enabled(env)) {
    console.log('[live-cues-v2] switched on by setting')
  }
  const changed = Object.entries(patch.limits).map(([k, v]) => `${k}=${v}`).join(' ')
  if (changed) console.log(`[live-cues-v2] limits saved: ${changed}`)
  return { ok: true }
}
/** What /api/health, /api/models and the status route advertise: NOTHING while v2 is switched off, so a 6.10.642
 *  companion treats the server exactly like a v1 server (v1 cues keep their own capability and indicator). */
export function liveCuesV2Advertised(env: NodeJS.ProcessEnv = process.env): LiveCuesV2Capability | undefined {
  return liveCuesV2Enabled(env) ? liveCuesV2Capability() : undefined
}
/** 6.79.0: a meeting's durable cue and writer-call counters for the history route, read without building the engine. */
export function liveCuesV2MeetingCounters(sessionId: string): { cues: number; writerCalls: number } | null {
  return new LiveCuesV2Store(dataPath('live-cues-v2-state.json'), () => new Date()).meetingCounters(sessionId)
}
export function shutdownLiveCuesV2(): void { engine?.shutdown(); unsubscribe?.(); unsubscribe = null; engine = null }
