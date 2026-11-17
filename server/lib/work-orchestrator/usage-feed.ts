/**
 * 7.0.54 (U1; Miles 2026-11-17 06:55, "getting usage of all systems", "Claude desktop vs the CLI"): Claude's plan use from
 * readings Claude itself already has, by where it was read. COS makes no network call and reads no token or cookie here.
 *
 *   claude-cli.json      written by the terminal Claude Code status line (its `rate_limits`: the 5-hour and 7-day windows
 *                        from the reply headers it already received), tagged cli. The status line change is Miles's typed
 *                        call (~/.claude/settings.json); until then this file does not exist and the probe is the only source.
 *   claude-desktop.json  written through POST /api/usage/feed/claude-desktop by a desktop session, with the Claude Desktop
 *                        app's own usage tool reply (its plan, each weekly window, per model). No timer writes it.
 *
 * Both files live in the data folder (usage-feed/). They are read when the plan pane is built, and every field is checked:
 * a percent outside 0 to 100, an unreadable time or a file over 16 KB is not a reading. A reading is shown with its age;
 * it is never shown as current once it is old (plan-pane.ts, the same 25 minutes as the probe).
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../atomic-fs.js'
import { dataPath } from '../data-dir.js'
import type { UsageEntry, UsageWindow } from './usage.js'

export type FeedSource = 'cli' | 'desktop'
export const feedDir = (): string => dataPath('usage-feed')
export const feedPath = (source: FeedSource, dir: string = feedDir()): string => join(dir, `claude-${source}.json`)
export const MAX_FEED_BYTES = 16 * 1024
const MAX_WINDOWS = 10

export interface FeedWindow { label: string; kind: 'session' | 'weekly_all' | 'weekly_scoped' | 'other'; usedPct: number; resetsAt: string | null }
export interface FeedReading { source: FeedSource; at: string; plan: string | null; windows: FeedWindow[] }
export class FeedError extends Error { constructor(readonly code: string) { super(code) } }

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null)
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v.trim() : null)

/** 0 to 100, or the reading is refused. */
function percent(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new FeedError('bad_percent')
  return v
}
/** An ISO time, or epoch seconds or milliseconds (the status line's resets_at). Null when not stated; anything else refuses. */
function isoOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000
    if (ms > 8.64e15) throw new FeedError('bad_time') // past the last date JavaScript can hold (Q1 07:38: was a 503)
    return new Date(ms).toISOString()
  }
  if (typeof v === 'string' && v.length <= 40) { const t = Date.parse(v); if (!Number.isNaN(t)) return new Date(t).toISOString() }
  throw new FeedError('bad_time')
}
function at(v: unknown): string {
  const t = isoOrNull(v)
  if (!t) throw new FeedError('bad_time')
  return t
}
/** The desktop app's labels: "Weekly · all models" is the plan's week; "Weekly · <model>" a per-model week. */
export function desktopKind(label: string): FeedWindow['kind'] {
  if (/^weekly\s*·\s*all models$/i.test(label)) return 'weekly_all'
  if (/^weekly\s*·\s*/i.test(label)) return 'weekly_scoped'
  if (/5[- ]hour|session/i.test(label)) return 'session'
  return 'other'
}

/** The status line feed, as its snippet writes it: {v: 1, source: "cli", at, five_hour?, seven_day?}. */
export function parseCliFeed(raw: unknown): FeedReading {
  const o = obj(raw)
  if (!o || o.v !== 1 || o.source !== 'cli') throw new FeedError('bad_shape')
  const windows: FeedWindow[] = []
  for (const [key, label, kind] of [['five_hour', '5-hour', 'session'], ['seven_day', 'Weekly · all models', 'weekly_all']] as const) {
    if (o[key] === undefined || o[key] === null) continue
    const w = obj(o[key])
    if (!w) throw new FeedError('bad_shape')
    windows.push({ label, kind, usedPct: percent(w.used_percentage), resetsAt: isoOrNull(w.resets_at) })
  }
  if (!windows.length) throw new FeedError('no_windows')
  return { source: 'cli', at: at(o.at), plan: null, windows }
}

/** A saved desktop reading, as writeDesktopFeed writes it. */
export function parseDesktopFeed(raw: unknown): FeedReading {
  const o = obj(raw)
  if (!o || o.v !== 1 || o.source !== 'desktop' || !Array.isArray(o.windows)) throw new FeedError('bad_shape')
  return { source: 'desktop', at: at(o.at), plan: o.plan === null ? null : text(o.plan, 60) ?? (() => { throw new FeedError('bad_plan') })(), windows: desktopWindows(o.windows) }
}

function desktopWindows(list: unknown[]): FeedWindow[] {
  if (!list.length || list.length > MAX_WINDOWS) throw new FeedError('no_windows')
  return list.map(raw => {
    const w = obj(raw)
    const label = w ? text(w.label, 60) : null
    if (!w || !label) throw new FeedError('bad_label')
    return { label, kind: desktopKind(label), usedPct: percent(w.percentUsed ?? w.usedPct), resetsAt: isoOrNull(w.resetsAt) }
  })
}

/** The Claude Desktop app's usage tool reply (the whole reply, or its `plan` part) to a desktop reading. Only the plan's
 *  name and its windows are kept: the reply's session context and anything else are dropped. */
export function desktopReadingFromTool(body: unknown, now: number): FeedReading {
  const whole = obj(body)
  const plan = obj(whole?.plan) && obj(whole?.plan)!.windows ? obj(whole!.plan)! : whole
  if (!plan) throw new FeedError('bad_shape')
  if (plan.status !== 'ok') throw new FeedError(plan.status === 'not_applicable' ? 'not_applicable' : 'not_ok')
  if (!Array.isArray(plan.windows)) throw new FeedError('no_windows')
  const name = plan.plan === undefined || plan.plan === null ? null : text(plan.plan, 60)
  if (plan.plan !== undefined && plan.plan !== null && !name) throw new FeedError('bad_plan')
  return { source: 'desktop', at: new Date(now).toISOString(), plan: name, windows: desktopWindows(plan.windows) }
}

/** Atomic, owner-only. Only the checked fields are written. */
export function writeDesktopFeed(reading: FeedReading, dir: string = feedDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const out = { v: 1, source: 'desktop', at: reading.at, plan: reading.plan,
    windows: reading.windows.map(w => ({ label: w.label, percentUsed: w.usedPct, resetsAt: w.resetsAt })) }
  atomicWriteFileSync(feedPath('desktop', dir), JSON.stringify(out), { mode: 0o600 })
}

export type FeedRead = { reading: FeedReading; problem: null } | { reading: null; problem: 'missing' | 'unreadable' }
/** Never throws: a missing file is "missing"; anything that fails a check is "unreadable", with no detail kept. */
export function readFeed(source: FeedSource, dir: string = feedDir()): FeedRead {
  const path = feedPath(source, dir)
  try {
    if (statSync(path).size > MAX_FEED_BYTES) return { reading: null, problem: 'unreadable' }
  } catch { return { reading: null, problem: 'missing' } }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { reading: source === 'cli' ? parseCliFeed(raw) : parseDesktopFeed(raw), problem: null }
  } catch { return { reading: null, problem: 'unreadable' } }
}

/** A feed reading as a usage entry the plan pane can draw: its windows, its read time, no failure and no hold of its own. */
export function feedEntry(reading: FeedReading, base: Pick<UsageEntry, 'provider'>): UsageEntry {
  const windows: UsageWindow[] = reading.windows.filter(w => w.kind !== 'other').map(w => ({ kind: w.kind, usedPct: w.usedPct, resetsAt: w.resetsAt }))
  return { provider: base.provider, reading: { plan: reading.plan, windows, allowed: null, available: true }, observedAt: Date.parse(reading.at),
    source: 'passive', lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false }
}
