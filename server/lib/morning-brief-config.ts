// Morning brief — configuration, source catalog, and the runs ledger.
//
// WHY THE SERVER OWNS THIS. The brief has to exist before the wearer opens
// anything: the companion WebView is suspended or dead at 07:00, and Even Hub
// wipes its storage on every close. The only process awake at that hour is the
// glasses server, so the schedule, the source list, and the record of what
// fired live here, under the data home, and every surface (COS Control, the
// companion, curl) reads and writes the same file through /api/morning-brief.
//
// WHY SOURCES ARE DECLARATIVE. The server does not read calendars, Slack, or
// the knowledge graph. The user's own COS brain does, through whatever skills
// and connectors it already has. So a "source" here is an instruction the
// composer turns into one section of the prompt, and a user personalises the
// brief by choosing sources and their windows rather than by editing prose.
// Miles (2026-09-01): "the user should be able to define the different sources
// that will be pulled into their brief so that it's as useful as possible."

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import {
  normalizeEffortPreference,
  normalizeModelPreference,
  type EffortPreference,
  type ModelPreference,
} from '../../shared/model-preference.js'

export const MORNING_BRIEF_PROTOCOL_VERSION = 1 as const
export const MORNING_BRIEF_CONFIG_VERSION = 1 as const

export const MORNING_BRIEF_LIMITS = Object.freeze({
  /** How late after the slot a missed fire may still happen (Mac was asleep). */
  maxCatchUpMinutes: 12 * 60,
  defaultCatchUpMinutes: 3 * 60,
  /** Free-text option ceiling. The whole prompt is bounded separately. */
  instructionChars: 1_000,
  skillNameChars: 64,
  /** "Run now" presses per local day. The scheduled fire is on top of this. */
  manualRunsPerDay: 5,
  /** Submission attempts for one scheduled slot before the day is given up. */
  scheduledAttemptsPerDay: 3,
  /** Minimum spacing between those attempts. */
  attemptSpacingMs: 2 * 60_000,
  /** Ledger retention. */
  retainedRuns: 60,
})

export type MorningBriefSourceId =
  | 'calendar'
  | 'meetings'
  | 'tasks'
  | 'waiting'
  | 'knowledge'
  | 'reflection'
  | 'health'
  | 'reading'
  | 'pulse'
  | 'skill'
  | 'custom'

export type MorningBriefOptionSpec =
  | { type: 'boolean'; default: boolean; label: string }
  | { type: 'integer'; default: number; min: number; max: number; label: string; unit?: string }
  | { type: 'text'; default: string; maxChars: number; label: string; placeholder?: string }

export interface MorningBriefSourceSpec {
  id: MorningBriefSourceId
  label: string
  /** One sentence a settings screen can show. */
  description: string
  defaultEnabled: boolean
  options: Record<string, MorningBriefOptionSpec>
}

export type MorningBriefSourceOptions = Record<string, boolean | number | string>

export interface MorningBriefSource {
  id: MorningBriefSourceId
  enabled: boolean
  options: MorningBriefSourceOptions
}

export interface MorningBriefConfig {
  v: typeof MORNING_BRIEF_CONFIG_VERSION
  enabled: boolean
  /** 24h wall-clock "HH:MM" in `timezone`. */
  time: string
  /** IANA zone. Defaults to the Mac's zone at first load. */
  timezone: string
  /** 0 = Sunday … 6 = Saturday. */
  days: number[]
  catchUpMinutes: number
  model?: ModelPreference
  effort?: EffortPreference
  /** Ordered: section order in the brief. */
  sources: MorningBriefSource[]
  /** Appended to every brief, after the sections. */
  closingInstruction: string
  updatedAt: string
}

/**
 * The catalog. Order here is the DEFAULT section order and the order a
 * settings screen lists them. Every id is stable: it is persisted in the
 * config file and appears in the prompt, so renaming one is a migration.
 */
export const MORNING_BRIEF_SOURCES: readonly MorningBriefSourceSpec[] = Object.freeze<MorningBriefSourceSpec[]>([
  {
    id: 'calendar',
    label: 'Calendar',
    description: "Today's meetings and the first commitment of the day, from any calendar this COS can read.",
    defaultEnabled: true,
    options: {
      includeTomorrow: { type: 'boolean', default: false, label: 'Include tomorrow' },
    },
  },
  {
    id: 'meetings',
    label: 'Meetings',
    description: 'Decisions, deadlines, and owed items from recently synced meetings.',
    defaultEnabled: true,
    options: {
      lookbackDays: { type: 'integer', default: 3, min: 1, max: 14, label: 'Look back', unit: 'days' },
      horizonDays: { type: 'integer', default: 7, min: 1, max: 30, label: 'Due within', unit: 'days' },
    },
  },
  {
    id: 'tasks',
    label: 'Tasks',
    description: 'Open tasks due or overdue inside the horizon, from the task files this COS keeps.',
    defaultEnabled: true,
    options: {
      horizonDays: { type: 'integer', default: 7, min: 1, max: 30, label: 'Due within', unit: 'days' },
      includeOverdue: { type: 'boolean', default: true, label: 'Include overdue' },
    },
  },
  {
    id: 'waiting',
    label: 'Waiting on you',
    description: 'Unanswered mentions and asks across Slack, email, and other connected channels.',
    defaultEnabled: true,
    options: {
      lookbackDays: { type: 'integer', default: 7, min: 1, max: 30, label: 'Look back', unit: 'days' },
    },
  },
  {
    id: 'knowledge',
    label: 'Knowledge graph',
    description: 'Threads, people, and relationships that moved recently in memory or the knowledge graph.',
    defaultEnabled: false,
    options: {
      lookbackDays: { type: 'integer', default: 7, min: 1, max: 30, label: 'Look back', unit: 'days' },
    },
  },
  {
    id: 'reflection',
    label: 'Reflection',
    description: 'The recurring theme from recent reflections or corrections, and one behaviour to carry today.',
    defaultEnabled: false,
    options: {},
  },
  {
    id: 'health',
    label: 'Health',
    description: "Last night's sleep and readiness, when a health source is connected.",
    defaultEnabled: false,
    options: {},
  },
  {
    id: 'reading',
    label: 'Opening reading',
    description: 'A short public-domain reading matched to the date.',
    defaultEnabled: false,
    options: {
      text: { type: 'text', default: 'proverbs', maxChars: 64, label: 'Text', placeholder: 'proverbs' },
    },
  },
  {
    id: 'pulse',
    label: 'Metrics pulse',
    description: 'A daily read of the numbers you steer by, from a connected dashboard or report.',
    defaultEnabled: false,
    options: {
      instruction: {
        type: 'text',
        default: '',
        maxChars: MORNING_BRIEF_LIMITS.instructionChars,
        label: 'What to pull',
        placeholder: 'e.g. Leads and opportunities month-to-date by focus industry, versus last month',
      },
    },
  },
  {
    id: 'skill',
    label: 'Workspace skill',
    description: "Run one of this COS's own skills and use its output as the brief.",
    defaultEnabled: false,
    options: {
      name: { type: 'text', default: '', maxChars: MORNING_BRIEF_LIMITS.skillNameChars, label: 'Skill', placeholder: '/good-morning' },
    },
  },
  {
    id: 'custom',
    label: 'Custom section',
    description: 'Your own instruction for one more section.',
    defaultEnabled: false,
    options: {
      instruction: {
        type: 'text',
        default: '',
        maxChars: MORNING_BRIEF_LIMITS.instructionChars,
        label: 'Instruction',
        placeholder: 'e.g. List the three customer renewals closest to their date',
      },
    },
  },
])

const SOURCE_BY_ID = new Map(MORNING_BRIEF_SOURCES.map(spec => [spec.id, spec]))
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const SKILL_NAME_RE = /^\/?[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export class MorningBriefConfigError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = 'MorningBriefConfigError'
  }
}

export function serverTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (zone && isValidTimezone(zone)) return zone
  } catch { /* fall through */ }
  return 'UTC'
}

export function isValidTimezone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim() || zone.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export function defaultSources(): MorningBriefSource[] {
  return MORNING_BRIEF_SOURCES.map(spec => ({
    id: spec.id,
    enabled: spec.defaultEnabled,
    options: defaultOptions(spec),
  }))
}

function defaultOptions(spec: MorningBriefSourceSpec): MorningBriefSourceOptions {
  const out: MorningBriefSourceOptions = {}
  for (const [key, option] of Object.entries(spec.options)) out[key] = option.default
  return out
}

export function defaultMorningBriefConfig(now = new Date()): MorningBriefConfig {
  return {
    v: MORNING_BRIEF_CONFIG_VERSION,
    // On by default: the brief IS the start-of-day promise of the product, and
    // one bounded provider run per local day is the cost. Off is one toggle.
    enabled: true,
    time: '07:00',
    timezone: serverTimezone(),
    days: [1, 2, 3, 4, 5],
    catchUpMinutes: MORNING_BRIEF_LIMITS.defaultCatchUpMinutes,
    sources: defaultSources(),
    closingInstruction: '',
    updatedAt: now.toISOString(),
  }
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL_RE, '').replace(/\r\n?/g, '\n').trim().slice(0, maxChars)
}

function normalizeOptions(spec: MorningBriefSourceSpec, raw: unknown, previous?: MorningBriefSourceOptions): MorningBriefSourceOptions {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const out: MorningBriefSourceOptions = {}
  for (const [key, option] of Object.entries(spec.options)) {
    const candidate = key in input ? input[key] : previous?.[key]
    switch (option.type) {
      case 'boolean':
        out[key] = typeof candidate === 'boolean' ? candidate : option.default
        break
      case 'integer': {
        const n = typeof candidate === 'number' ? candidate : Number(candidate)
        out[key] = Number.isSafeInteger(n) ? Math.min(option.max, Math.max(option.min, n)) : option.default
        break
      }
      case 'text': {
        const text = cleanText(candidate, option.maxChars)
        if (spec.id === 'skill' && key === 'name' && text && !SKILL_NAME_RE.test(text)) {
          throw new MorningBriefConfigError('invalid_skill_name', 'A skill name is a slash name like /good-morning.')
        }
        out[key] = text || option.default
        break
      }
    }
  }
  return out
}

/**
 * Normalise an untrusted source list against the catalog. Order is preserved
 * for known ids, unknown ids are dropped, and every catalog id missing from the
 * input is appended with its defaults — so a config written by an older build
 * gains new sources DISABLED rather than silently on.
 */
export function normalizeSources(raw: unknown, previous?: MorningBriefSource[]): MorningBriefSource[] {
  const previousById = new Map((previous ?? []).map(source => [source.id, source]))
  const seen = new Set<MorningBriefSourceId>()
  const out: MorningBriefSource[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string') continue
    const spec = SOURCE_BY_ID.get(id as MorningBriefSourceId)
    if (!spec || seen.has(spec.id)) continue
    seen.add(spec.id)
    const prior = previousById.get(spec.id)
    const enabledRaw = (entry as { enabled?: unknown }).enabled
    out.push({
      id: spec.id,
      enabled: typeof enabledRaw === 'boolean' ? enabledRaw : prior?.enabled ?? spec.defaultEnabled,
      options: normalizeOptions(spec, (entry as { options?: unknown }).options, prior?.options),
    })
  }
  for (const spec of MORNING_BRIEF_SOURCES) {
    if (seen.has(spec.id)) continue
    const prior = previousById.get(spec.id)
    out.push(prior
      ? { id: spec.id, enabled: prior.enabled, options: normalizeOptions(spec, prior.options) }
      : { id: spec.id, enabled: spec.defaultEnabled, options: defaultOptions(spec) })
  }
  return out
}

function normalizeDays(raw: unknown, fallback: number[]): number[] {
  if (!Array.isArray(raw)) return fallback
  return [...new Set(raw
    .map(value => (typeof value === 'number' ? value : Number(value)))
    .filter(value => Number.isInteger(value) && value >= 0 && value <= 6))]
    .sort((a, b) => a - b)
}

/**
 * Apply an untrusted patch to a known-good config. Every field is validated;
 * an invalid field throws rather than silently keeping the old value, because
 * a settings screen that shows "Saved" over a rejected time is the failure
 * this is guarding against.
 */
export function applyMorningBriefPatch(current: MorningBriefConfig, raw: unknown, now = new Date()): MorningBriefConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MorningBriefConfigError('invalid_patch', 'Expected a JSON object.')
  }
  const patch = raw as Record<string, unknown>
  const next: MorningBriefConfig = { ...current, sources: current.sources.map(source => ({ ...source, options: { ...source.options } })) }

  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw new MorningBriefConfigError('invalid_enabled', 'enabled must be true or false.')
    next.enabled = patch.enabled
  }
  if ('time' in patch) {
    const time = typeof patch.time === 'string' ? patch.time.trim() : ''
    if (!TIME_RE.test(time)) throw new MorningBriefConfigError('invalid_time', 'time must be HH:MM in 24-hour form, e.g. 07:00.')
    next.time = time
  }
  if ('timezone' in patch) {
    if (!isValidTimezone(patch.timezone)) throw new MorningBriefConfigError('invalid_timezone', 'timezone must be an IANA zone such as America/Chicago.')
    next.timezone = patch.timezone
  }
  if ('days' in patch) {
    if (!Array.isArray(patch.days)) throw new MorningBriefConfigError('invalid_days', 'days must be a list of weekday numbers, 0 (Sunday) to 6.')
    next.days = normalizeDays(patch.days, current.days)
  }
  if ('catchUpMinutes' in patch) {
    const minutes = Number(patch.catchUpMinutes)
    if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > MORNING_BRIEF_LIMITS.maxCatchUpMinutes) {
      throw new MorningBriefConfigError('invalid_catch_up', `catchUpMinutes must be 0 to ${MORNING_BRIEF_LIMITS.maxCatchUpMinutes}.`)
    }
    next.catchUpMinutes = minutes
  }
  if ('model' in patch) {
    if (patch.model == null || patch.model === '') {
      delete next.model
    } else {
      const model = normalizeModelPreference(patch.model)
      if (!model) throw new MorningBriefConfigError('invalid_model', 'Unknown model preference.')
      next.model = model
    }
  }
  if ('effort' in patch) {
    if (patch.effort == null || patch.effort === '') {
      delete next.effort
    } else {
      const effort = normalizeEffortPreference(patch.effort)
      if (!effort) throw new MorningBriefConfigError('invalid_effort', 'Unknown effort preference.')
      next.effort = effort
    }
  }
  if ('sources' in patch) {
    if (!Array.isArray(patch.sources)) throw new MorningBriefConfigError('invalid_sources', 'sources must be a list.')
    next.sources = normalizeSources(patch.sources, current.sources)
  }
  if ('closingInstruction' in patch) {
    if (patch.closingInstruction != null && typeof patch.closingInstruction !== 'string') {
      throw new MorningBriefConfigError('invalid_closing', 'closingInstruction must be text.')
    }
    next.closingInstruction = cleanText(patch.closingInstruction, MORNING_BRIEF_LIMITS.instructionChars)
  }
  next.updatedAt = now.toISOString()
  return next
}

/** Coerce whatever is on disk into a valid config. Never throws: a damaged
 * field falls back to its default so one bad byte cannot silence the brief. */
export function coerceMorningBriefConfig(raw: unknown, now = new Date()): MorningBriefConfig {
  const base = defaultMorningBriefConfig(now)
  if (!raw || typeof raw !== 'object') return base
  const input = raw as Record<string, unknown>
  const time = typeof input.time === 'string' && TIME_RE.test(input.time.trim()) ? input.time.trim() : base.time
  const catchUp = Number(input.catchUpMinutes)
  const model = normalizeModelPreference(input.model)
  const effort = normalizeEffortPreference(input.effort)
  let sources: MorningBriefSource[]
  try { sources = normalizeSources(input.sources) } catch { sources = base.sources }
  return {
    v: MORNING_BRIEF_CONFIG_VERSION,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    time,
    timezone: isValidTimezone(input.timezone) ? input.timezone : base.timezone,
    days: normalizeDays(input.days, base.days),
    catchUpMinutes: Number.isSafeInteger(catchUp) && catchUp >= 0 && catchUp <= MORNING_BRIEF_LIMITS.maxCatchUpMinutes
      ? catchUp : base.catchUpMinutes,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    sources,
    closingInstruction: cleanText(input.closingInstruction, MORNING_BRIEF_LIMITS.instructionChars),
    updatedAt: typeof input.updatedAt === 'string' && !Number.isNaN(Date.parse(input.updatedAt))
      ? input.updatedAt : base.updatedAt,
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

export interface MorningBriefStorePaths {
  config: string
  runs: string
}

export function morningBriefPaths(root?: string): MorningBriefStorePaths {
  const configuredRoot = root ?? process.env.COS_MORNING_BRIEF_DIR?.trim()
  const base = configuredRoot ? configuredRoot : dataPath('morning-brief')
  return { config: `${base}/config.json`, runs: `${base}/runs.json` }
}

function ensurePrivateDir(file: string): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch { /* best effort */ }
}

export function loadMorningBriefConfig(paths: MorningBriefStorePaths, now = new Date()): { config: MorningBriefConfig; fresh: boolean; quarantinedAs?: string } {
  const loaded = loadJsonOrQuarantine<unknown>(paths.config)
  if (loaded.status === 'ok') return { config: coerceMorningBriefConfig(loaded.data, now), fresh: false }
  const config = defaultMorningBriefConfig(now)
  return loaded.status === 'corrupt'
    ? { config, fresh: true, quarantinedAs: loaded.quarantinedAs }
    : { config, fresh: true }
}

export function saveMorningBriefConfig(paths: MorningBriefStorePaths, config: MorningBriefConfig): void {
  ensurePrivateDir(paths.config)
  durableAtomicWriteFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

// ── Runs ledger ───────────────────────────────────────────────────────────────

export type MorningBriefTrigger = 'scheduled' | 'manual'

export interface MorningBriefRun {
  /** Stable ledger id. */
  id: string
  /** Local calendar day (YYYY-MM-DD in the config timezone) the run belongs to. */
  day: string
  trigger: MorningBriefTrigger
  attempt: number
  firedAt: string
  clientJobId: string
  generation: 1
  sessionId: string
  messageEra?: string
  globalMsgNum?: number
  /** Present once the coordinator accepted the job. */
  jobId?: string
  /** Present when submission itself failed (the job never existed). */
  submitError?: { code: string; message: string }
  /** Terminal state copied from the job when last observed. */
  lastKnownStatus?: string
}

export interface MorningBriefLedger {
  v: 1
  runs: MorningBriefRun[]
}

export function loadMorningBriefLedger(paths: MorningBriefStorePaths): MorningBriefLedger {
  const loaded = loadJsonOrQuarantine<unknown>(paths.runs)
  if (loaded.status !== 'ok' || !loaded.data || typeof loaded.data !== 'object') return { v: 1, runs: [] }
  const raw = (loaded.data as { runs?: unknown }).runs
  const runs = (Array.isArray(raw) ? raw : []).filter(isRunRecord)
  return { v: 1, runs }
}

function isRunRecord(value: unknown): value is MorningBriefRun {
  if (!value || typeof value !== 'object') return false
  const run = value as Record<string, unknown>
  return typeof run.id === 'string'
    && typeof run.day === 'string'
    && (run.trigger === 'scheduled' || run.trigger === 'manual')
    && typeof run.firedAt === 'string'
    && typeof run.clientJobId === 'string'
    && typeof run.sessionId === 'string'
}

export function saveMorningBriefLedger(paths: MorningBriefStorePaths, ledger: MorningBriefLedger): void {
  ensurePrivateDir(paths.runs)
  const runs = ledger.runs.slice(-MORNING_BRIEF_LIMITS.retainedRuns)
  durableAtomicWriteFileSync(paths.runs, `${JSON.stringify({ v: 1, runs }, null, 2)}\n`, { mode: 0o600 })
}

/** Public shape: the config plus the catalog, never the prompt. */
export function describeMorningBriefSources(): readonly MorningBriefSourceSpec[] {
  return MORNING_BRIEF_SOURCES
}
