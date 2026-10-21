// 6.82.0 Routines: any COS skill on a schedule (Miles, 2026-10-20, Q4: "Pick a skill, a time
// and days; each routine has its own cap and off switch").
//
// The morning brief stays exactly what it was (its own config file, scheduler and golden) and is
// listed as routine #1 by the registry. Everything here is the SECOND kind: a skill routine.
//
// HOW A SKILL ROUTINE STOPS (every new provider caller answers this):
//  - its own off switch (`enabled`), and the master switch COS_ROUTINES=0 for all of them;
//  - its own daily cap: admitted runs per local day, scheduled and Run now together;
//  - a server-wide ceiling across every skill routine per day (ROUTINE_LIMITS.globalRunsPerDay);
//  - a breaker: N consecutive failed runs open it for a cooldown, and nothing fires while it is open;
//  - one scheduled slot per selected day, at most `scheduledAttemptsPerDay` submit attempts;
//  - inert while durable jobs are off or maintenance admissions are closed (as the brief).
// It runs on a cheap model (sonnet) unless the routine names another, and never on a key lane.

import { createHash, randomBytes } from 'node:crypto'
import { durableAtomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { ensurePrivateDir, isValidTimezone, serverTimezone } from './morning-brief-config.js'
import { KEY_PROFILE_REJECT_CODE, KEY_PROFILE_SCHEDULED_REJECT, keyProfileRejectApplies } from './key-profile-rejects.js'
import {
  normalizeEffortPreference,
  normalizeModelPreference,
  type EffortPreference,
  type ModelPreference,
} from '../../shared/model-preference.js'

export const ROUTINES_PROTOCOL_VERSION = 1 as const

export const ROUTINE_LIMITS = Object.freeze({
  /** Skill routines one server holds (the morning brief is not counted). */
  maxRoutines: 12,
  nameChars: 60,
  instructionChars: 1_000,
  skillNameChars: 64,
  dailyCapDefault: 2,
  dailyCapMin: 1,
  dailyCapMax: 10,
  /** Every skill routine together, per local day of the server zone. */
  globalRunsPerDay: 40,
  breakerFailuresDefault: 3,
  breakerFailuresMin: 1,
  breakerFailuresMax: 10,
  cooldownMinutesDefault: 6 * 60,
  cooldownMinutesMin: 15,
  cooldownMinutesMax: 7 * 24 * 60,
  catchUpMinutesDefault: 3 * 60,
  catchUpMinutesMax: 12 * 60,
  /** Submit attempts for one scheduled slot before the day is given up (as the brief). */
  scheduledAttemptsPerDay: 3,
  attemptSpacingMs: 2 * 60_000,
  retainedRuns: 240,
})

/** Unless a routine names another model, it runs here: the server's fast default, never Opus. */
export const ROUTINE_DEFAULT_MODEL: ModelPreference = 'sonnet'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
/** A skill's loader identity (`good-morning`, `customer-marketing:intel`). No slash, no path. */
export const ROUTINE_SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
/** Routine ids double as the job origin id (QUERY_JOB_ORIGIN_ID_RE) and never equal `morning-brief`. */
export const ROUTINE_ID_RE = /^routine-[0-9a-f]{10}$/

export class RoutineConfigError extends Error {
  constructor(readonly code: string, message = code, readonly status = 400) {
    super(message)
    this.name = 'RoutineConfigError'
  }
}

export interface RoutineBreakerSettings {
  /** Consecutive failed runs that open the breaker. */
  failures: number
  /** How long it stays open. */
  cooldownMinutes: number
}

export interface SkillRoutine {
  id: string
  kind: 'skill'
  name: string
  /** Skill loader identity, without the slash. */
  skill: string
  /** Optional words added after the skill call. */
  instruction: string
  enabled: boolean
  time: string
  timezone: string
  days: number[]
  catchUpMinutes: number
  /** Admitted runs per local day, scheduled and Run now together. */
  dailyCap: number
  model: ModelPreference
  effort?: EffortPreference
  breaker: RoutineBreakerSettings
  createdAt: string
  updatedAt: string
}

export interface RoutineBreakerState {
  consecutiveFailures: number
  /** Set while the breaker is open. Nothing fires before this instant. */
  openUntil?: string
  openedAt?: string
  lastFailure?: { code: string; message: string; at: string }
}

export type RoutineTrigger = 'scheduled' | 'manual'

export interface RoutineRun {
  id: string
  routineId: string
  day: string
  trigger: RoutineTrigger
  attempt: number
  firedAt: string
  clientJobId: string
  generation: 1
  sessionId: string
  messageEra?: string
  globalMsgNum?: number
  jobId?: string
  submitError?: { code: string; message: string }
  lastKnownStatus?: string
  /** Set once the run's result has been counted by the breaker (exactly once per run). */
  outcome?: 'completed' | 'failed' | 'canceled'
}

export interface RoutinesFile {
  v: 1
  routines: SkillRoutine[]
  breakers: Record<string, RoutineBreakerState>
}

export interface RoutinesLedger {
  v: 1
  runs: RoutineRun[]
}

export interface RoutineStorePaths {
  routines: string
  runs: string
}

export function routinePaths(root?: string): RoutineStorePaths {
  const configured = root ?? process.env.COS_ROUTINES_DIR?.trim()
  const base = configured ? configured : dataPath('routines')
  return { routines: `${base}/routines.json`, runs: `${base}/runs.json` }
}

/** Master switch. Only an explicit `0`, `false`, `off` or `no` turns every skill routine off. */
export function routinesEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.COS_ROUTINES?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

export function newRoutineId(): string {
  return `routine-${randomBytes(5).toString('hex')}`
}

/** Deterministic client id for one routine's scheduled slot, so a retry after a crashed submit
 * admits as the SAME job (the brief's rule, keyed by routine as well). */
export function routineScheduledClientJobId(routineId: string, day: string, timezone: string): string {
  const digest = createHash('sha256').update(`routine|${routineId}|${timezone}|${day}`).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL_RE, '').replace(/\r\n?/g, '\n').trim().slice(0, maxChars)
}

function intIn(raw: unknown, min: number, max: number, code: string, label: string): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RoutineConfigError(code, `${label} must be ${min} to ${max}.`)
  return n
}

function normalizeDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new RoutineConfigError('invalid_days', 'days must be a list of weekday numbers, 0 (Sunday) to 6.')
  return [...new Set(raw
    .map(value => (typeof value === 'number' ? value : Number(value)))
    .filter(value => Number.isInteger(value) && value >= 0 && value <= 6))]
    .sort((a, b) => a - b)
}

export function normalizeSkillName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/^\//, '') : ''
  if (!ROUTINE_SKILL_RE.test(name)) throw new RoutineConfigError('invalid_skill', 'Pick a skill from this COS workspace.')
  return name
}

export interface RoutinePatchContext {
  now: Date
  /** True when the skill is in this workspace's catalog. A routine can only name one that is. */
  skillExists: (name: string) => boolean
}

/**
 * Create or edit a skill routine from an untrusted body. Every field is validated and an invalid
 * one throws (a settings screen that shows Saved over a rejected time is the failure this guards).
 * `current` absent means create: `skill` is required and everything else takes its default.
 */
export function applyRoutinePatch(current: SkillRoutine | null, raw: unknown, ctx: RoutinePatchContext): SkillRoutine {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RoutineConfigError('invalid_patch', 'Expected a JSON object.')
  const patch = raw as Record<string, unknown>
  const at = ctx.now.toISOString()
  const base: SkillRoutine = current
    ? { ...current, days: [...current.days], breaker: { ...current.breaker } }
    : {
        id: newRoutineId(),
        kind: 'skill',
        name: '',
        skill: '',
        instruction: '',
        enabled: true,
        time: '08:00',
        timezone: serverTimezone(),
        days: [1, 2, 3, 4, 5],
        catchUpMinutes: ROUTINE_LIMITS.catchUpMinutesDefault,
        dailyCap: ROUTINE_LIMITS.dailyCapDefault,
        model: ROUTINE_DEFAULT_MODEL,
        breaker: { failures: ROUTINE_LIMITS.breakerFailuresDefault, cooldownMinutes: ROUTINE_LIMITS.cooldownMinutesDefault },
        createdAt: at,
        updatedAt: at,
      }
  if (!current && !('skill' in patch)) throw new RoutineConfigError('invalid_skill', 'Pick a skill from this COS workspace.')
  if ('skill' in patch) {
    const skill = normalizeSkillName(patch.skill)
    if (!ctx.skillExists(skill)) throw new RoutineConfigError('unknown_skill', `/${skill} is not a skill in this COS workspace.`)
    base.skill = skill
  }
  if ('name' in patch) {
    if (patch.name != null && typeof patch.name !== 'string') throw new RoutineConfigError('invalid_name', 'name must be text.')
    base.name = cleanText(patch.name, ROUTINE_LIMITS.nameChars)
  }
  if (!base.name) base.name = `/${base.skill}`
  if ('instruction' in patch) {
    if (patch.instruction != null && typeof patch.instruction !== 'string') throw new RoutineConfigError('invalid_instruction', 'instruction must be text.')
    base.instruction = cleanText(patch.instruction, ROUTINE_LIMITS.instructionChars)
  }
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw new RoutineConfigError('invalid_enabled', 'enabled must be true or false.')
    base.enabled = patch.enabled
  }
  if ('time' in patch) {
    const time = typeof patch.time === 'string' ? patch.time.trim() : ''
    if (!TIME_RE.test(time)) throw new RoutineConfigError('invalid_time', 'time must be HH:MM in 24-hour form, e.g. 08:00.')
    base.time = time
  }
  if ('timezone' in patch) {
    if (!isValidTimezone(patch.timezone)) throw new RoutineConfigError('invalid_timezone', 'timezone must be an IANA zone such as America/Chicago.')
    base.timezone = patch.timezone
  }
  if ('days' in patch) base.days = normalizeDays(patch.days)
  if ('catchUpMinutes' in patch) {
    base.catchUpMinutes = intIn(patch.catchUpMinutes, 0, ROUTINE_LIMITS.catchUpMinutesMax, 'invalid_catch_up', 'catchUpMinutes')
  }
  if ('dailyCap' in patch) {
    base.dailyCap = intIn(patch.dailyCap, ROUTINE_LIMITS.dailyCapMin, ROUTINE_LIMITS.dailyCapMax, 'invalid_daily_cap', 'dailyCap')
  }
  if ('model' in patch) {
    if (patch.model == null || patch.model === '') {
      base.model = ROUTINE_DEFAULT_MODEL
    } else {
      const model = normalizeModelPreference(patch.model)
      // A scheduled routine always runs on the subscription, never a key lane (Decision Q2).
      if (!model && keyProfileRejectApplies(patch.model)) throw new RoutineConfigError(KEY_PROFILE_REJECT_CODE, KEY_PROFILE_SCHEDULED_REJECT)
      if (!model) throw new RoutineConfigError('invalid_model', 'Unknown model preference.')
      base.model = model
    }
  }
  if ('effort' in patch) {
    if (patch.effort == null || patch.effort === '') {
      delete base.effort
    } else {
      const effort = normalizeEffortPreference(patch.effort)
      if (!effort) throw new RoutineConfigError('invalid_effort', 'Unknown effort preference.')
      base.effort = effort
    }
  }
  if ('breaker' in patch) {
    const b = patch.breaker
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new RoutineConfigError('invalid_breaker', 'breaker must be an object.')
    const rec = b as Record<string, unknown>
    if ('failures' in rec) base.breaker.failures = intIn(rec.failures, ROUTINE_LIMITS.breakerFailuresMin, ROUTINE_LIMITS.breakerFailuresMax, 'invalid_breaker_failures', 'breaker.failures')
    if ('cooldownMinutes' in rec) base.breaker.cooldownMinutes = intIn(rec.cooldownMinutes, ROUTINE_LIMITS.cooldownMinutesMin, ROUTINE_LIMITS.cooldownMinutesMax, 'invalid_breaker_cooldown', 'breaker.cooldownMinutes')
  }
  base.updatedAt = at
  return base
}

/** Coerce a stored routine. A damaged field takes its default; a routine with no usable id or skill is dropped. */
export function coerceRoutine(raw: unknown): SkillRoutine | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ROUTINE_ID_RE.test(r.id)) return null
  if (typeof r.skill !== 'string' || !ROUTINE_SKILL_RE.test(r.skill)) return null
  const num = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value)
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback
  }
  const breaker = (r.breaker && typeof r.breaker === 'object' ? r.breaker : {}) as Record<string, unknown>
  const model = normalizeModelPreference(r.model)
  const effort = normalizeEffortPreference(r.effort)
  const now = new Date().toISOString()
  let days: number[]
  try { days = normalizeDays(r.days) } catch { days = [1, 2, 3, 4, 5] }
  return {
    id: r.id,
    kind: 'skill',
    name: cleanText(r.name, ROUTINE_LIMITS.nameChars) || `/${r.skill}`,
    skill: r.skill,
    instruction: cleanText(r.instruction, ROUTINE_LIMITS.instructionChars),
    enabled: typeof r.enabled === 'boolean' ? r.enabled : false,
    time: typeof r.time === 'string' && TIME_RE.test(r.time) ? r.time : '08:00',
    timezone: isValidTimezone(r.timezone) ? r.timezone : serverTimezone(),
    days,
    catchUpMinutes: num(r.catchUpMinutes, 0, ROUTINE_LIMITS.catchUpMinutesMax, ROUTINE_LIMITS.catchUpMinutesDefault),
    dailyCap: num(r.dailyCap, ROUTINE_LIMITS.dailyCapMin, ROUTINE_LIMITS.dailyCapMax, ROUTINE_LIMITS.dailyCapDefault),
    model: model ?? ROUTINE_DEFAULT_MODEL,
    ...(effort ? { effort } : {}),
    breaker: {
      failures: num(breaker.failures, ROUTINE_LIMITS.breakerFailuresMin, ROUTINE_LIMITS.breakerFailuresMax, ROUTINE_LIMITS.breakerFailuresDefault),
      cooldownMinutes: num(breaker.cooldownMinutes, ROUTINE_LIMITS.cooldownMinutesMin, ROUTINE_LIMITS.cooldownMinutesMax, ROUTINE_LIMITS.cooldownMinutesDefault),
    },
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
  }
}

function coerceBreaker(raw: unknown): RoutineBreakerState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const failures = Number(r.consecutiveFailures)
  const state: RoutineBreakerState = { consecutiveFailures: Number.isSafeInteger(failures) && failures > 0 ? failures : 0 }
  if (typeof r.openUntil === 'string' && Number.isFinite(Date.parse(r.openUntil))) state.openUntil = r.openUntil
  if (typeof r.openedAt === 'string') state.openedAt = r.openedAt
  const last = r.lastFailure as Record<string, unknown> | undefined
  if (last && typeof last.code === 'string' && typeof last.at === 'string') {
    state.lastFailure = { code: last.code.slice(0, 64), message: String(last.message ?? '').slice(0, 300), at: last.at }
  }
  return state
}

export function loadRoutinesFile(paths: RoutineStorePaths): { file: RoutinesFile; quarantinedAs?: string } {
  const loaded = loadJsonOrQuarantine<unknown>(paths.routines)
  if (loaded.status !== 'ok' || !loaded.data || typeof loaded.data !== 'object') {
    return { file: { v: 1, routines: [], breakers: {} }, ...(loaded.status === 'corrupt' ? { quarantinedAs: loaded.quarantinedAs } : {}) }
  }
  const data = loaded.data as { routines?: unknown; breakers?: unknown }
  const seen = new Set<string>()
  const routines: SkillRoutine[] = []
  for (const entry of Array.isArray(data.routines) ? data.routines : []) {
    const routine = coerceRoutine(entry)
    if (!routine || seen.has(routine.id)) continue
    seen.add(routine.id)
    routines.push(routine)
  }
  const breakers: Record<string, RoutineBreakerState> = {}
  const rawBreakers = data.breakers && typeof data.breakers === 'object' ? data.breakers as Record<string, unknown> : {}
  for (const id of seen) if (rawBreakers[id]) breakers[id] = coerceBreaker(rawBreakers[id])
  return { file: { v: 1, routines: routines.slice(0, ROUTINE_LIMITS.maxRoutines), breakers } }
}

export function saveRoutinesFile(paths: RoutineStorePaths, file: RoutinesFile): void {
  ensurePrivateDir(paths.routines)
  durableAtomicWriteFileSync(paths.routines, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

function isRoutineRun(value: unknown): value is RoutineRun {
  if (!value || typeof value !== 'object') return false
  const run = value as Record<string, unknown>
  return typeof run.id === 'string'
    && typeof run.routineId === 'string'
    && typeof run.day === 'string'
    && (run.trigger === 'scheduled' || run.trigger === 'manual')
    && typeof run.firedAt === 'string'
    && typeof run.clientJobId === 'string'
    && typeof run.sessionId === 'string'
}

export function loadRoutinesLedger(paths: RoutineStorePaths): RoutinesLedger {
  const loaded = loadJsonOrQuarantine<unknown>(paths.runs)
  if (loaded.status !== 'ok' || !loaded.data || typeof loaded.data !== 'object') return { v: 1, runs: [] }
  const raw = (loaded.data as { runs?: unknown }).runs
  return { v: 1, runs: (Array.isArray(raw) ? raw : []).filter(isRoutineRun) }
}

export function saveRoutinesLedger(paths: RoutineStorePaths, ledger: RoutinesLedger): void {
  ensurePrivateDir(paths.runs)
  const runs = ledger.runs.slice(-ROUTINE_LIMITS.retainedRuns)
  durableAtomicWriteFileSync(paths.runs, `${JSON.stringify({ v: 1, runs }, null, 2)}\n`, { mode: 0o600 })
}

/** The prompt a skill routine's durable job carries. Deterministic for (routine, day) so a crash
 * resume re-admits the same job. Unattended: it never sends, publishes or deletes. */
export function composeSkillRoutinePrompt(routine: Pick<SkillRoutine, 'name' | 'skill' | 'instruction'>, day: string, ownerName: string, trigger: RoutineTrigger): string {
  const who = ownerName.trim() || 'the owner'
  const lines = [
    `Scheduled COS routine "${routine.name}" for ${day} (${trigger === 'manual' ? 'Run now' : 'on schedule'}).`,
    `Run the /${routine.skill} skill from this COS workspace and give ${who} its result.`,
    ...(routine.instruction ? ['', `Also: ${routine.instruction}`] : []),
    '',
    'Nobody is watching this run. Read and summarise freely, and write only the files this skill keeps on this Mac.',
    'Do not send email, Slack or any message, publish, deploy, push, delete data, or spend money. If the skill needs one of those, stop and say what it would do.',
    'If the skill is missing or a source it needs is unavailable, say so in one plain line instead of guessing.',
    'Answer in plain text with short lines, so it reads on the glasses.',
  ]
  return lines.join('\n')
}

/** 6.82.0: the token-audit caller for a job a routine started (`routine:<id>`), '' for every other
 * job, whose callers stay exactly what they were. */
export function routineAuditCaller(request: { origin?: { kind: string; id: string } }): string {
  return request.origin?.kind === 'routine' ? `routine:${request.origin.id}` : ''
}
