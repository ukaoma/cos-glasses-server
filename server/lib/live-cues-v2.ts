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
import { liveCuesV2EnvForced, liveCuesV2Settings, resolveLiveCuesV2, type LiveCuesV2SettingReader, type LiveCuesV2SettingSource } from './live-cues-v2-settings.js'
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
import { errMsg } from './utils.js'
import { CUE_GATE_QUESTIONS, CUE_JUDGE_INSTRUCTIONS, CUE_JUDGE_NONE, CUE_WRITER_SYSTEM_V2, CUE_WRITER_SYSTEM_V3 } from './live-cues-v2-prompts.js'
import {
  CUE_DETAIL_MAX, CUE_FEEDBACK_REASON_MAX, CUE_HEADLINE_MAX, LIVE_CUES_V2_PROTOCOL, isLiveCueV2,
  type CueKind, type CueSourceRef, type LiveCueV1Compat, type LiveCueV2, type LiveCuesV2Capability, type LiveCuesV2MemorySource,
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
export function liveCuesV2Gate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_LIVE_CUES_V2_GATE)
  return Number.isFinite(raw) && raw >= 0.3 && raw <= 0.99 ? raw : LIVE_CUES_V2_LIMITS.defaultGate
}
/** 6.79.0 tuning knobs for Friday's rated-cue review. Defaults are the calibrated values above. The range check is the
 *  whole guard: unset or non-numeric (NaN fails every comparison), empty (0) and Infinity all fall outside it. */
export function liveCuesV2CooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_LIVE_CUES_V2_COOLDOWN_S)
  return raw >= 20 && raw <= 900 ? Math.round(raw * 1000) : LIVE_CUES_V2_LIMITS.cooldownAfterCueMs
}
export function liveCuesV2JudgeKeep(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_LIVE_CUES_V2_JUDGE_KEEP)
  return raw >= 0.3 && raw <= 0.99 ? raw : LIVE_CUES_V2_LIMITS.judgeKeep
}
export function liveCuesV2Model(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.COS_LIVE_CUES_V2_MODEL ?? '').trim().toLowerCase()
  if (raw === 'haiku') return 'claude-haiku-5-5'
  if (raw === 'sonnet' || raw === '') return 'claude-sonnet-5-5'
  return /^claude-[a-z0-9.-]{3,40}$/.test(raw) ? raw : 'claude-sonnet-5-5'
}
export function liveCuesV2WriterSystem(env: NodeJS.ProcessEnv = process.env): { version: 'v2' | 'v3'; system: string } {
  return (env.COS_LIVE_CUES_V2_PROMPT ?? '').trim() === 'v2' ? { version: 'v2', system: CUE_WRITER_SYSTEM_V2 } : { version: 'v3', system: CUE_WRITER_SYSTEM_V3 }
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
export function parseWriterCue(raw: string, fallbackKind: CueKind, window: string, kept: MemoryNote[], enforceNumbers = false): ParsedCue | CueRejection {
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
  const kind: CueKind = value.kind === 'reinforce' || value.kind === 'challenge' ? value.kind : fallbackKind
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
interface DurableState {
  zone: string; weekStart: string; writerCalls: number
  ended: Record<string, number>; paused: Record<string, boolean>; pauseSeq: Record<string, number>
  meetings: Record<string, MeetingCounters>
}
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
      const pauseSeq = keep<number>(s.pauseSeq, v => typeof v === 'number' && Number.isFinite(v))
      for (const id of Object.keys(paused)) if (!live(id) && !(id in meetings)) delete paused[id]
      const sameWeek = s.weekStart === week
      const futureWeek = typeof s.weekStart === 'string' && s.weekStart > week
      const calls = Number(s.writerCalls ?? 0)
      // A future week key or a negative/non-numeric count fails toward NOT spending: the week is saturated.
      const saturated = futureWeek || (sameWeek && !(calls >= 0))
      return { zone, weekStart: week, writerCalls: saturated ? Number.MAX_SAFE_INTEGER : sameWeek ? calls : 0, ended, paused, pauseSeq, meetings }
    } catch {
      // An unreadable file fails closed for this week (no spending) but keeps cues off nothing else.
      const zone = validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC'
      return { zone, weekStart: localWeekStart(this.now(), zone), writerCalls: Number.MAX_SAFE_INTEGER, ended: {}, paused: {}, pauseSeq: {}, meetings: {} }
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
    const m = s.meetings[sessionId] ?? { cues: 0, writerCalls: 0, at: 0 }
    s.meetings[sessionId] = { ...m, writerCalls: m.writerCalls + 1, at: this.now().getTime() }
    this.write(s)
    return true
  }
  recordCue(sessionId: string): void {
    const s = this.read()
    const m = s.meetings[sessionId] ?? { cues: 0, writerCalls: 0, at: 0 }
    s.meetings[sessionId] = { ...m, cues: m.cues + 1, at: this.now().getTime() }
    this.write(s)
  }
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
  end(sessionId: string): void { const s = this.read(); s.ended[sessionId] = this.now().getTime(); delete s.paused[sessionId]; this.write(s) }
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
}

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

  /** Idempotent. A repeat start for an armed meeting keeps its counters; an ended meeting cannot be re-armed. */
  arm(sessionId: string): { armed: true; sessionId: string; protocol: 2; cuesGenerated: number; paused: boolean; pauseSeq: number } {
    this.reap()
    const cap = this.capability()
    if (!cap.available) throw new LiveCuesV2ArmError(cap.reason ?? 'unavailable', cap.reason === 'master_flag_off' ? 403 : 503, `Live cues v2 unavailable: ${cap.reason}.`)
    if (this.deps.store.isEnded(sessionId)) throw new LiveCuesV2ArmError('meeting_ended', 409, 'This meeting has ended; live cues cannot be re-armed for it.')
    const existing = this.sessions.get(sessionId)
    const nowMs = this.deps.now().getTime()
    const answer = (cues: number) => ({ armed: true as const, sessionId, protocol: 2 as const, cuesGenerated: cues, paused: this.deps.store.isPaused(sessionId), pauseSeq: this.deps.store.pauseSeq(sessionId) })
    if (existing) { existing.lastSeenAt = nowMs; return answer(existing.cues.length) }
    const d = this.deps.now()
    const title = `G2 Recording ${d.toLocaleDateString('en-CA')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    this.sessions.set(sessionId, { sessionId, title, armedAt: nowMs, lastSeenAt: nowMs, chunks: [], wordsSinceEval: 0, lastEvalAt: 0, lastCueAt: 0,
      inFlight: null, cues: [], evaluations: 0, failures: 0, breaker: false, stopReason: null, skipTracedAt: {} })
    this.deps.warmMemory()
    return answer(this.deps.store.counters(sessionId).cues)
  }

  /** Stop or save: tombstone FIRST (so trailing chunks cannot revive it), then abort any evaluation in flight. */
  end(sessionId: string): { nudgesGenerated: number; nudges: Array<Record<string, unknown>>; protocol: 2; cues: LiveCueV2[] } {
    this.deps.store.end(sessionId)
    const s = this.sessions.get(sessionId)
    s?.inFlight?.abort()
    const cues = s ? [...s.cues] : []
    return { nudgesGenerated: cues.length, protocol: 2, cues,
      nudges: cues.map(c => ({ nudge: c.headline, type: c.kind, priority: 2, timestamp: c.createdAt, cueId: c.cueId })) }
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
    const L = LIVE_CUES_V2_LIMITS
    if (s.breaker) return 'breaker_open'
    if (counters.cues >= L.maxCuesPerMeeting || counters.writerCalls >= L.maxWriterCallsPerMeeting) return 'meeting_cap'
    if (this.deps.store.weeklyUsed() >= liveCuesV2WeeklyCap(this.deps.env)) return 'budget_exhausted'
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
      if (this.deps.env.COS_LIVE_CUES_AUTO !== '1') return
      try { this.arm(sessionId) } catch { return }
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
    if (nowMs - s.lastEvalAt < L.minIntervalMs || nowMs - s.lastCueAt < liveCuesV2CooldownMs(this.deps.env)) return
    const counters = this.deps.store.counters(sessionId)
    if (counters.cues >= L.maxCuesPerMeeting || counters.writerCalls >= L.maxWriterCallsPerMeeting) return this.traceSkip(s, 'meeting_cap', nowMs)
    if (this.deps.store.weeklyUsed() >= liveCuesV2WeeklyCap(this.deps.env)) return this.traceSkip(s, 'budget_exhausted', nowMs)  // before the gate
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
      if (pCue < liveCuesV2Gate(this.deps.env)) { trace.outcome = 'gate_silent'; s.stopReason = null; return }
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

      if (!this.deps.store.charge(liveCuesV2WeeklyCap(this.deps.env), s.sessionId)) { trace.outcome = 'budget_exhausted'; s.stopReason = 'budget_exhausted'; return }
      const { version, system } = liveCuesV2WriterSystem(this.deps.env)
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

      const parsed = parseWriterCue(out.text, gate.kind, window, kept, this.deps.env.COS_LIVE_CUES_V2_NUMBER_GUARD === 'withhold')
      if (typeof parsed === 'string') { trace.outcome = parsed === 'null' ? 'writer_null' : `withheld_${parsed}`; return }
      const elapsed = this.deps.now().getTime() - started
      if (s.wordsSinceEval > L.staleWords || elapsed > L.staleMs) { trace.outcome = 'stale'; return }
      if (this.deps.store.isEnded(s.sessionId) || this.deps.store.isPaused(s.sessionId) || !this.enabled()) { trace.outcome = 'cancelled'; return }

      const sources: CueSourceRef[] = parsed.memoryIds.map(id => kept.find(m => m.id === id)).filter((m): m is MemoryNote => !!m)
        .map(m => ({ id: sourceId(m), date: m.date, title: m.title }))
      const cue: LiveCueV2 = { protocol: 2, cueId: randomUUID(), sessionId: s.sessionId, headline: cueHeadline(parsed.detail), detail: parsed.detail,
        kind: parsed.kind, sources, gate: round(pCue), createdAt: this.deps.now().getTime(), model: out.model ?? model }
      if (!isLiveCueV2(cue)) { trace.outcome = 'withheld_invalid'; return }       // never emit what the companion would drop
      // 6.79.0: logged before it is held or emitted, so a rating that arrives at once finds it. Its own try/catch: a log
      // failure is traced on this evaluation and is never a writer failure or a step toward the breaker.
      try {
        this.deps.cueLog?.({ v: 1, cueId: cue.cueId, sessionId: s.sessionId, meetingTitle: s.title, createdAt: cue.createdAt, armedAt: s.armedAt, kind: cue.kind,
          headline: cue.headline, detail: cue.detail, gate: cue.gate, sources: cue.sources, model: cue.model, prompt: version,
          memorySource: mem.notes.length ? source : 'none', kept: kept.length, before: cueBefore(said) })
      } catch (error) {
        trace.cueLogError = (error as NodeJS.ErrnoException)?.code ?? 'append_failed'
        console.warn(`[live-cues-v2] cue log append failed: ${errMsg(error)}`)
      }
      s.cues.push(cue)
      s.lastCueAt = cue.createdAt
      this.deps.store.recordCue(s.sessionId)
      this.deps.emit('coaching_nudge_v2', cue as unknown as Record<string, unknown>)
      const v1: LiveCueV1Compat = { nudge: cue.headline, type: cue.kind, priority: 2, cueId: cue.cueId, sessionId: s.sessionId, protocol: 2 }
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

/** GET/POST /api/live-cues/v2/settings (COS Control's toggle). */
export interface LiveCuesV2SettingsResponse { enabled: boolean; source: LiveCuesV2SettingSource; capability: LiveCuesV2Capability }
export function liveCuesV2SettingsView(env: NodeJS.ProcessEnv = process.env): LiveCuesV2SettingsResponse {
  const r = resolveLiveCuesV2(env, liveCuesV2Settings())
  return { enabled: r.enabled, source: r.source, capability: liveCuesV2Capability() }
}
/** Save the switch. Off while env forces it on is refused and changes nothing. Turning it off ends cue evaluation for running
 *  meetings at once; turning it on applies from each meeting's next evaluation. */
export function setLiveCuesV2Enabled(enabled: boolean, env: NodeJS.ProcessEnv = process.env): { ok: true; view: LiveCuesV2SettingsResponse } | { ok: false; error: 'env_forced' } {
  if (!enabled && liveCuesV2EnvForced(env)) return { ok: false, error: 'env_forced' }
  const wasOn = liveCuesV2Enabled(env)
  liveCuesV2Settings().save(enabled)
  if (wasOn && !liveCuesV2Enabled(env)) {
    const aborted = engine?.suspend() ?? 0
    console.log(`[live-cues-v2] switched off by setting; ${aborted} evaluation(s) stopped`)
  } else if (!wasOn && liveCuesV2Enabled(env)) {
    console.log('[live-cues-v2] switched on by setting')
  }
  return { ok: true, view: liveCuesV2SettingsView(env) }
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
