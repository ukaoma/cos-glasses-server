// Live cues v2 runtime switch (6.76.2). COS Control offers an on/off toggle; the choice is kept in this server's own data
// dir and applies without a restart. Resolution order:
//   1. env COS_LIVE_CUES_V2=1 forces v2 on (source 'env'); a request to turn it off is refused (409 env_forced).
//   2. the saved setting (source 'setting').
//   3. off (source 'default').
// Only the exact value '1' forces. Any other env value (unset, '0', 'true') defers to the setting, as it always read as off.
// An unreadable or malformed settings file reads as no setting, so it fails toward off, never toward spending.
//
// 6.79.2: the same file holds COS Control's spend limits (gate, cues per meeting, cooldown, writer calls per local day).
// Each saved value is validated on read; one out of bounds reads as unset (the default), never as a looser limit. An env
// var for a limit wins over the saved value and locks it. A file holding only `enabled` is still written as schema 1, so
// a 6.79.1 server reads it exactly as before; any limit makes it schema 2, which 6.79.1 also reads (it looks only at
// `enabled`).
//
// Live cues v3: the same file also holds the cue mode (focused | general | all), grounded cues (classic | grounded) and the
// six general-cue limits. A file holding any of them is schema 3; an older server that rewrites the file drops them, which
// reads as focused and classic, the safe values. A saved value that is malformed or outside its enum or bounds reads as
// unset. Env can only force the SAFE value (COS_LIVE_CUES_MODE=focused, COS_LIVE_CUES_GROUNDING=classic); any other value
// defers to the setting, so a managed env can never switch general or grounded cues on behind COS Control's back.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export type LiveCuesV2SettingSource = 'env' | 'setting' | 'default'

/** COS Control's live-cue spend limits (6.79.2). Bounds are inclusive; integer fields take whole numbers only. */
export const LIVE_CUES_V2_LIMIT_BOUNDS = {
  gate: { min: 0.5, max: 0.95, default: 0.8, integer: false, env: 'COS_LIVE_CUES_V2_GATE' },
  // 6.99.0: the ceiling is 50 (Miles 2026-11-03, longer meetings); the default stays 25. Everything that clamps or validates this reads `.max`.
  maxCuesPerMeeting: { min: 1, max: 50, default: 25, integer: true, env: 'COS_LIVE_CUES_V2_MAX_PER_MEETING' },
  cooldownSeconds: { min: 20, max: 900, default: 45, integer: true, env: 'COS_LIVE_CUES_V2_COOLDOWN_S' },
  dailyWriterCalls: { min: 1, max: 500, default: 150, integer: true, env: 'COS_LIVE_CUES_V2_DAILY_WRITER_CALLS' },
} as const
export type LiveCuesV2LimitName = keyof typeof LIVE_CUES_V2_LIMIT_BOUNDS
export const LIVE_CUES_V2_LIMIT_NAMES = Object.keys(LIVE_CUES_V2_LIMIT_BOUNDS) as LiveCuesV2LimitName[]
export type LiveCuesV2StoredLimits = Partial<Record<LiveCuesV2LimitName, number>>

/** Live cues v3 (cue mode). `focused` is today's cues; `general` adds nothing to focused cues but runs only insight cues; `all` runs both. */
export const LIVE_CUES_CUE_MODES = ['focused', 'general', 'all'] as const
export type LiveCuesCueMode = typeof LIVE_CUES_CUE_MODES[number]
export const LIVE_CUES_GROUNDINGS = ['classic', 'grounded'] as const
export type LiveCuesGrounding = typeof LIVE_CUES_GROUNDINGS[number]
export const isCueMode = (v: unknown): v is LiveCuesCueMode => typeof v === 'string' && (LIVE_CUES_CUE_MODES as readonly string[]).includes(v)
export const isGrounding = (v: unknown): v is LiveCuesGrounding => typeof v === 'string' && (LIVE_CUES_GROUNDINGS as readonly string[]).includes(v)

/** The six general-cue limits. `field` is the name on the wire (POST body and settings file); the key is the name in the
 *  `general.limits` view. Bounds are inclusive; integer fields take whole numbers only. */
export const LIVE_CUES_GENERAL_LIMIT_BOUNDS = {
  intervalSeconds: { field: 'generalIntervalSeconds', min: 120, max: 1800, default: 300, integer: true, env: 'COS_LIVE_CUES_GENERAL_INTERVAL_S' },
  trigger: { field: 'generalTrigger', min: 0.4, max: 0.9, default: 0.6, integer: false, env: 'COS_LIVE_CUES_GENERAL_TRIGGER' },
  attemptsPerMeeting: { field: 'generalAttemptsPerMeeting', min: 1, max: 30, default: 8, integer: true, env: 'COS_LIVE_CUES_GENERAL_ATTEMPTS' },
  maxCuesPerMeeting: { field: 'generalMaxCuesPerMeeting', min: 1, max: 12, default: 4, integer: true, env: 'COS_LIVE_CUES_GENERAL_MAX_PER_MEETING' },
  dailyTopicCalls: { field: 'generalDailyTopicCalls', min: 1, max: 200, default: 60, integer: true, env: 'COS_LIVE_CUES_GENERAL_DAILY_TOPIC_CALLS' },
  dailyWebSearches: { field: 'generalDailyWebSearches', min: 1, max: 100, default: 30, integer: true, env: 'COS_LIVE_CUES_GENERAL_DAILY_WEB_SEARCHES' },
} as const
export type LiveCuesGeneralLimitName = keyof typeof LIVE_CUES_GENERAL_LIMIT_BOUNDS
export const LIVE_CUES_GENERAL_LIMIT_NAMES = Object.keys(LIVE_CUES_GENERAL_LIMIT_BOUNDS) as LiveCuesGeneralLimitName[]
export type LiveCuesGeneralStoredLimits = Partial<Record<LiveCuesGeneralLimitName, number>>
export function generalLimitInBounds(name: LiveCuesGeneralLimitName, value: unknown): value is number {
  return withinBounds(LIVE_CUES_GENERAL_LIMIT_BOUNDS[name], value)
}

/** Inside the bounds, and whole where the field is whole. */
function withinBounds(b: { min: number; max: number; integer: boolean }, value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= b.min && value <= b.max && (!b.integer || Number.isInteger(value))
}
export function limitInBounds(name: LiveCuesV2LimitName, value: unknown): value is number {
  return withinBounds(LIVE_CUES_V2_LIMIT_BOUNDS[name], value)
}

/** What the engine and the routes need from the store: the saved choice, or null when there is none, and (6.79.2) the
 *  saved limits. `limits` is optional so a reader without it means "no saved limits". */
export interface LiveCuesV2SettingReader {
  stored(): boolean | null
  limits?(): LiveCuesV2StoredLimits
  /** Live cues v3, all optional: a reader without them means focused, classic and the default general limits. */
  cueMode?(): LiveCuesCueMode | null
  grounding?(): LiveCuesGrounding | null
  generalLimits?(): LiveCuesGeneralStoredLimits
}

interface Loaded { value: boolean | null; limits: LiveCuesV2StoredLimits; cueMode: LiveCuesCueMode | null; grounding: LiveCuesGrounding | null; general: LiveCuesGeneralStoredLimits }

export class LiveCuesV2Settings implements LiveCuesV2SettingReader {
  /** Loaded once; only this server writes the file, and every write goes through update(). */
  private cache: Loaded | null = null
  constructor(readonly file: string) {}

  private load(): Loaded {
    if (this.cache) return this.cache
    let value: boolean | null = null
    const limits: LiveCuesV2StoredLimits = {}
    let cueMode: LiveCuesCueMode | null = null, grounding: LiveCuesGrounding | null = null
    const general: LiveCuesGeneralStoredLimits = {}
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const r = raw as Record<string, unknown>
          if (typeof r.enabled === 'boolean') value = r.enabled
          for (const name of LIVE_CUES_V2_LIMIT_NAMES) if (limitInBounds(name, r[name])) limits[name] = r[name] as number
          if (isCueMode(r.cueMode)) cueMode = r.cueMode
          if (isGrounding(r.grounding)) grounding = r.grounding
          for (const name of LIVE_CUES_GENERAL_LIMIT_NAMES) {
            const field = LIVE_CUES_GENERAL_LIMIT_BOUNDS[name].field
            if (generalLimitInBounds(name, r[field])) general[name] = r[field] as number
          }
        }
      }
    } catch { value = null }
    this.cache = { value, limits, cueMode, grounding, general }
    return this.cache
  }

  stored(): boolean | null { return this.load().value }
  limits(): LiveCuesV2StoredLimits { return { ...this.load().limits } }
  cueMode(): LiveCuesCueMode | null { return this.load().cueMode }
  grounding(): LiveCuesGrounding | null { return this.load().grounding }
  generalLimits(): LiveCuesGeneralStoredLimits { return { ...this.load().general } }

  /** Atomic and durable. The in-memory value changes only after the file is written, so a failed write changes nothing. */
  save(enabled: boolean, now: Date = new Date()): void { this.update({ enabled }, now) }

  /** One write for any mix of the switch, the limits and (v3) the cue mode, grounding and general limits; unnamed fields
   *  keep their saved values, the v3 ones included. */
  update(patch: { enabled?: boolean; limits?: LiveCuesV2StoredLimits; cueMode?: LiveCuesCueMode; grounding?: LiveCuesGrounding; general?: LiveCuesGeneralStoredLimits },
    now: Date = new Date()): void {
    const current = this.load()
    const value = patch.enabled ?? current.value
    const limits = { ...current.limits, ...patch.limits }
    const cueMode = patch.cueMode ?? current.cueMode
    const grounding = patch.grounding ?? current.grounding
    const general = { ...current.general, ...patch.general }
    const hasLimits = Object.keys(limits).length > 0
    const hasV3 = cueMode !== null || grounding !== null || Object.keys(general).length > 0
    const generalFields = Object.fromEntries(LIVE_CUES_GENERAL_LIMIT_NAMES.filter(n => general[n] !== undefined).map(n => [LIVE_CUES_GENERAL_LIMIT_BOUNDS[n].field, general[n]]))
    const body = { schema: hasV3 ? 3 : hasLimits ? 2 : 1, ...(value === null ? {} : { enabled: value }), ...limits,
      ...(cueMode === null ? {} : { cueMode }), ...(grounding === null ? {} : { grounding }), ...generalFields, updatedAt: now.toISOString() }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.file, JSON.stringify(body) + '\n', { mode: 0o600 })
    this.cache = { value, limits, cueMode, grounding, general }
  }
}

export function liveCuesV2EnvForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_LIVE_CUES_V2 === '1'
}

export function resolveLiveCuesV2(env: NodeJS.ProcessEnv, settings: LiveCuesV2SettingReader | null): { enabled: boolean; source: LiveCuesV2SettingSource } {
  if (liveCuesV2EnvForced(env)) return { enabled: true, source: 'env' }
  let stored: boolean | null = null
  try { stored = settings ? settings.stored() : null } catch { stored = null }
  if (stored !== null) return { enabled: stored, source: 'setting' }
  return { enabled: false, source: 'default' }
}

/** Where a v3 mode came from. `env` only ever means the safe value was forced, so it is locked. */
export interface LiveCuesV2Mode<T extends string> { value: T; source: LiveCuesV2SettingSource; locked: boolean }
/** COS_LIVE_CUES_MODE=focused forces focused; any other env value, a missing or malformed saved value, or a reader that
 *  throws, reads through to the saved mode, then to focused. */
export function resolveLiveCuesCueMode(env: NodeJS.ProcessEnv, settings: LiveCuesV2SettingReader | null): LiveCuesV2Mode<LiveCuesCueMode> {
  if (env.COS_LIVE_CUES_MODE === 'focused') return { value: 'focused', source: 'env', locked: true }
  let stored: LiveCuesCueMode | null = null
  try { const v = settings?.cueMode?.(); stored = isCueMode(v) ? v : null } catch { stored = null }
  return stored !== null ? { value: stored, source: 'setting', locked: false } : { value: 'focused', source: 'default', locked: false }
}
/** COS_LIVE_CUES_GROUNDING=classic forces classic, the same way. */
export function resolveLiveCuesGrounding(env: NodeJS.ProcessEnv, settings: LiveCuesV2SettingReader | null): LiveCuesV2Mode<LiveCuesGrounding> {
  if (env.COS_LIVE_CUES_GROUNDING === 'classic') return { value: 'classic', source: 'env', locked: true }
  let stored: LiveCuesGrounding | null = null
  try { const v = settings?.grounding?.(); stored = isGrounding(v) ? v : null } catch { stored = null }
  return stored !== null ? { value: stored, source: 'setting', locked: false } : { value: 'classic', source: 'default', locked: false }
}

let singleton: LiveCuesV2Settings | null = null
export function liveCuesV2Settings(): LiveCuesV2Settings {
  if (!singleton) singleton = new LiveCuesV2Settings(dataPath('live-cues-v2-settings.json'))
  return singleton
}
