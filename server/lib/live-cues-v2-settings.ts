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

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export type LiveCuesV2SettingSource = 'env' | 'setting' | 'default'

/** COS Control's live-cue spend limits (6.79.2). Bounds are inclusive; integer fields take whole numbers only. */
export const LIVE_CUES_V2_LIMIT_BOUNDS = {
  gate: { min: 0.5, max: 0.95, default: 0.8, integer: false, env: 'COS_LIVE_CUES_V2_GATE' },
  maxCuesPerMeeting: { min: 1, max: 25, default: 25, integer: true, env: 'COS_LIVE_CUES_V2_MAX_PER_MEETING' },
  cooldownSeconds: { min: 20, max: 900, default: 45, integer: true, env: 'COS_LIVE_CUES_V2_COOLDOWN_S' },
  dailyWriterCalls: { min: 1, max: 500, default: 150, integer: true, env: 'COS_LIVE_CUES_V2_DAILY_WRITER_CALLS' },
} as const
export type LiveCuesV2LimitName = keyof typeof LIVE_CUES_V2_LIMIT_BOUNDS
export const LIVE_CUES_V2_LIMIT_NAMES = Object.keys(LIVE_CUES_V2_LIMIT_BOUNDS) as LiveCuesV2LimitName[]
export type LiveCuesV2StoredLimits = Partial<Record<LiveCuesV2LimitName, number>>

/** Inside the bounds, and whole where the field is whole. */
export function limitInBounds(name: LiveCuesV2LimitName, value: unknown): value is number {
  const b = LIVE_CUES_V2_LIMIT_BOUNDS[name]
  return typeof value === 'number' && Number.isFinite(value) && value >= b.min && value <= b.max && (!b.integer || Number.isInteger(value))
}

/** What the engine and the routes need from the store: the saved choice, or null when there is none, and (6.79.2) the
 *  saved limits. `limits` is optional so a reader without it means "no saved limits". */
export interface LiveCuesV2SettingReader { stored(): boolean | null; limits?(): LiveCuesV2StoredLimits }

export class LiveCuesV2Settings implements LiveCuesV2SettingReader {
  /** Loaded once; only this server writes the file, and every write goes through update(). */
  private cache: { value: boolean | null; limits: LiveCuesV2StoredLimits } | null = null
  constructor(readonly file: string) {}

  private load(): { value: boolean | null; limits: LiveCuesV2StoredLimits } {
    if (this.cache) return this.cache
    let value: boolean | null = null
    const limits: LiveCuesV2StoredLimits = {}
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const r = raw as Record<string, unknown>
          if (typeof r.enabled === 'boolean') value = r.enabled
          for (const name of LIVE_CUES_V2_LIMIT_NAMES) if (limitInBounds(name, r[name])) limits[name] = r[name] as number
        }
      }
    } catch { value = null }
    this.cache = { value, limits }
    return this.cache
  }

  stored(): boolean | null { return this.load().value }
  limits(): LiveCuesV2StoredLimits { return { ...this.load().limits } }

  /** Atomic and durable. The in-memory value changes only after the file is written, so a failed write changes nothing. */
  save(enabled: boolean, now: Date = new Date()): void { this.update({ enabled }, now) }

  /** One write for any mix of the switch and the limits; unnamed fields keep their saved values. */
  update(patch: { enabled?: boolean; limits?: LiveCuesV2StoredLimits }, now: Date = new Date()): void {
    const current = this.load()
    const value = patch.enabled ?? current.value
    const limits = { ...current.limits, ...patch.limits }
    const hasLimits = Object.keys(limits).length > 0
    const body = { schema: hasLimits ? 2 : 1, ...(value === null ? {} : { enabled: value }), ...limits, updatedAt: now.toISOString() }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.file, JSON.stringify(body) + '\n', { mode: 0o600 })
    this.cache = { value, limits }
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

let singleton: LiveCuesV2Settings | null = null
export function liveCuesV2Settings(): LiveCuesV2Settings {
  if (!singleton) singleton = new LiveCuesV2Settings(dataPath('live-cues-v2-settings.json'))
  return singleton
}
