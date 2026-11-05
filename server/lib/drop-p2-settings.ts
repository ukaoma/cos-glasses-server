/**
 * Drop it P2 settings (Miles, 2026-11-04 23:39): how COS reaches out, so it can be tuned and steered.
 *
 * Every value here is read by the code that does the thing (ping-budget, ping-engine, ping-sources, drop-when,
 * reminder-scheduler, drop-p2-runtime), and each has a test proving it changes behaviour. Defaults are the decided
 * values (plan section 10), so a Mac with no settings file behaves exactly as 6.99.11 was built.
 *
 * Stored beside Drop it's switch, in its own file (`data/drop-p2-settings.json`, 0600, atomic), so the P1 settings
 * file and its `{ enabled }` route stay as COS Control 0.5.371 reads them. Validation clamps a number into range and
 * replaces a value it cannot read with the default; it never refuses a whole save for one bad field, but the PUT route
 * refuses a body that is not an object or names an unknown section.
 *
 * Steer is words, not a model: "Ping me about" and "Leave alone" are each up to 300 characters, matched as whole
 * words of 3 or more letters (canary 9: the ping path calls no model).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import type { BudgetOptions, PingSource } from './ping-budget.js'

export const P2_SETTINGS_PROTOCOL = 1
export const P2_SETTINGS_FILE = () => dataPath('drop-p2-settings.json')

/** The polled ping sources he can switch off one by one. Reminders and follow-ups have their own sections. */
export const P2_PING_SOURCES = ['prep', 'agent', 'followups', 'stale', 'signals'] as const
export type P2PingSource = typeof P2_PING_SOURCES[number]
export const P2_FOLLOWUP_KINDS = ['card', 'handoff', 'session', 'thread'] as const
export type P2FollowupKind = typeof P2_FOLLOWUP_KINDS[number]
/** What may banner. `reminder` and `resolution` (follow-ups to his own drops) are on by default; the rest land silently. */
export const P2_BANNER_KINDS = ['reminder', 'resolution', 'prep', 'agent', 'followups', 'stale', 'checkin'] as const

export interface P2Settings {
  pings: {
    on: boolean
    dailyCap: number
    perSource: number
    gapMinutes: number
    quietStart: string
    quietEnd: string
    weekendsQuiet: boolean
    firstBanner: string
    sources: Record<P2PingSource, boolean>
  }
  followUps: { on: boolean; kinds: Record<P2FollowupKind, boolean> }
  checkin: { on: boolean; weekday: number; time: string }
  reminders: { defaultTime: string; snoozeMinutes: number; banners: boolean; lensPush: boolean }
  banners: Record<(typeof P2_BANNER_KINDS)[number], boolean>
  steer: { about: string; leaveAlone: string }
}

export const P2_LIMITS = {
  dailyCap: [0, 20], perSource: [1, 10], gapMinutes: [0, 240], snoozeMinutes: [5, 24 * 60], steerChars: 300,
} as const

export const P2_DEFAULTS: P2Settings = {
  pings: { on: true, dailyCap: 6, perSource: 2, gapMinutes: 45, quietStart: '18:00', quietEnd: '06:00', weekendsQuiet: true, firstBanner: '08:00',
    sources: { prep: true, agent: true, followups: true, stale: true, signals: true } },
  followUps: { on: true, kinds: { card: true, handoff: true, session: true, thread: true } },
  checkin: { on: true, weekday: 1, time: '09:00' },
  reminders: { defaultTime: '09:00', snoozeMinutes: 60, banners: true, lensPush: true },
  banners: { reminder: true, resolution: true, prep: false, agent: false, followups: false, stale: false, checkin: false },
  steer: { about: '', leaveAlone: '' },
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const bool = (v: unknown, d: boolean) => typeof v === 'boolean' ? v : d
const int = (v: unknown, [lo, hi]: readonly [number, number], d: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d
const time = (v: unknown, d: string) => typeof v === 'string' && TIME.test(v) ? v : d
const text = (v: unknown, d: string) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, P2_LIMITS.steerChars) : d
function flags<K extends string>(v: unknown, keys: readonly K[], d: Record<K, boolean>): Record<K, boolean> {
  const out = { ...d }
  if (isRecord(v)) for (const k of keys) out[k] = bool(v[k], d[k])
  return out
}

/** Read any object as settings: unknown fields are dropped, numbers clamped, unreadable values left at `base`. */
export function normalizeP2Settings(raw: unknown, base: P2Settings = P2_DEFAULTS): P2Settings {
  const r = isRecord(raw) ? raw : {}
  const p = isRecord(r.pings) ? r.pings : {}, f = isRecord(r.followUps) ? r.followUps : {}, c = isRecord(r.checkin) ? r.checkin : {}
  const m = isRecord(r.reminders) ? r.reminders : {}, s = isRecord(r.steer) ? r.steer : {}
  return {
    pings: {
      on: bool(p.on, base.pings.on),
      dailyCap: int(p.dailyCap, P2_LIMITS.dailyCap, base.pings.dailyCap),
      perSource: int(p.perSource, P2_LIMITS.perSource, base.pings.perSource),
      gapMinutes: int(p.gapMinutes, P2_LIMITS.gapMinutes, base.pings.gapMinutes),
      quietStart: time(p.quietStart, base.pings.quietStart),
      quietEnd: time(p.quietEnd, base.pings.quietEnd),
      weekendsQuiet: bool(p.weekendsQuiet, base.pings.weekendsQuiet),
      firstBanner: time(p.firstBanner, base.pings.firstBanner),
      sources: flags(p.sources, P2_PING_SOURCES, base.pings.sources),
    },
    followUps: { on: bool(f.on, base.followUps.on), kinds: flags(f.kinds, P2_FOLLOWUP_KINDS, base.followUps.kinds) },
    checkin: { on: bool(c.on, base.checkin.on), weekday: int(c.weekday, [0, 6], base.checkin.weekday), time: time(c.time, base.checkin.time) },
    reminders: {
      defaultTime: time(m.defaultTime, base.reminders.defaultTime),
      snoozeMinutes: int(m.snoozeMinutes, P2_LIMITS.snoozeMinutes, base.reminders.snoozeMinutes),
      banners: bool(m.banners, base.reminders.banners),
      lensPush: bool(m.lensPush, base.reminders.lensPush),
    },
    banners: flags(r.banners, P2_BANNER_KINDS, base.banners),
    steer: { about: text(s.about, base.steer.about), leaveAlone: text(s.leaveAlone, base.steer.leaveAlone) },
  }
}

/** Apply a partial PUT onto the current settings: only the fields it names change. */
export function mergeP2Settings(current: P2Settings, patch: unknown): P2Settings {
  return normalizeP2Settings(patch, current)
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
/** The numbers the budget and quiet hours read, in the units they use. */
export function budgetFrom(s: P2Settings): BudgetOptions {
  return {
    perWeekday: s.pings.dailyCap, perSource: s.pings.perSource, gapMs: s.pings.gapMinutes * 60_000,
    quietStartMinutes: minutes(s.pings.quietStart), quietEndMinutes: minutes(s.pings.quietEnd),
    weekendsQuiet: s.pings.weekendsQuiet, firstBannerMinutes: minutes(s.pings.firstBanner),
  }
}
export const timeMinutes = minutes

/** The kinds that may banner, as the budget reads them. Reminder banners also need the reminders switch. */
export function bannerSourcesFrom(s: P2Settings): PingSource[] {
  return P2_BANNER_KINDS.filter(k => s.banners[k] && (k !== 'reminder' || s.reminders.banners)) as PingSource[]
}

/** Whole words of 3 or more letters, lowercased, at most 40: what the steer boxes match. */
export function steerWords(textValue: string): string[] {
  const out = new Set<string>()
  for (const w of textValue.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && !STEER_STOP.has(w)) out.add(w)
    if (out.size >= 40) break
  }
  return [...out]
}
const STEER_STOP = new Set('the and for with from about that this those these any all ping pings me my you your not dont leave alone please stuff things don won can'.split(' '))
/** True when `line` contains any of `words` as a whole word. */
export function matchesSteer(line: string, words: readonly string[]): boolean {
  if (!words.length) return false
  const have = new Set(line.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u))
  return words.some(w => have.has(w))
}

/** Read the settings file, or the defaults when it is missing, unsafe or unreadable. Never throws. */
export function readP2Settings(file = P2_SETTINGS_FILE()): P2Settings {
  try {
    if (!existsSync(file)) return P2_DEFAULTS
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024) return P2_DEFAULTS
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return normalizeP2Settings(isRecord(raw) && raw.v === P2_SETTINGS_PROTOCOL ? raw.settings : null)
  } catch { return P2_DEFAULTS }
}

export function writeP2Settings(settings: P2Settings, file = P2_SETTINGS_FILE()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(file, JSON.stringify({ v: P2_SETTINGS_PROTOCOL, settings: normalizeP2Settings(settings) }, null, 2) + '\n')
  try { chmodSync(file, 0o600) } catch { /* best effort: the folder is 0700 */ }
}

/** A cache so the engine's minute tick does not re-read the file each time; a write through this module clears it. */
export function createP2SettingsReader(file = P2_SETTINGS_FILE(), ttlMs = 15_000, now: () => number = Date.now) {
  let cached: { at: number; settings: P2Settings } | null = null
  return {
    read(): P2Settings {
      if (cached && now() - cached.at < ttlMs) return cached.settings
      cached = { at: now(), settings: readP2Settings(file) }
      return cached.settings
    },
    write(next: P2Settings): P2Settings { writeP2Settings(next, file); cached = { at: now(), settings: normalizeP2Settings(next) }; return cached.settings },
  }
}
