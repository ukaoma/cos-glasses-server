// Live cues v2 runtime switch (6.76.2). COS Control offers an on/off toggle; the choice is kept in this server's own data
// dir and applies without a restart. Resolution order:
//   1. env COS_LIVE_CUES_V2=1 forces v2 on (source 'env'); a request to turn it off is refused (409 env_forced).
//   2. the saved setting (source 'setting').
//   3. off (source 'default').
// Only the exact value '1' forces. Any other env value (unset, '0', 'true') defers to the setting, as it always read as off.
// An unreadable or malformed settings file reads as no setting, so it fails toward off, never toward spending.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export type LiveCuesV2SettingSource = 'env' | 'setting' | 'default'

/** What the engine and the routes need from the store: the saved choice, or null when there is none. */
export interface LiveCuesV2SettingReader { stored(): boolean | null }

export class LiveCuesV2Settings implements LiveCuesV2SettingReader {
  /** Loaded once; only this server writes the file, and every write goes through save(). */
  private cache: { value: boolean | null } | null = null
  constructor(readonly file: string) {}

  stored(): boolean | null {
    if (this.cache) return this.cache.value
    let value: boolean | null = null
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { enabled?: unknown }).enabled === 'boolean') {
          value = (raw as { enabled: boolean }).enabled
        }
      }
    } catch { value = null }
    this.cache = { value }
    return value
  }

  /** Atomic and durable. The in-memory value changes only after the file is written, so a failed write changes nothing. */
  save(enabled: boolean, now: Date = new Date()): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.file, JSON.stringify({ schema: 1, enabled, updatedAt: now.toISOString() }) + '\n', { mode: 0o600 })
    this.cache = { value: enabled }
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
