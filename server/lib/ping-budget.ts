/**
 * Drop it P2 (plan PLAN_drop_it_2026-11-04 section 5, decided in section 10): which pings may interrupt.
 *
 * Every ping lands silently in the pinned COS chat. This module only decides which of them also get a banner
 * (a macOS notification, and for reminders a lens push). Pure: the ledger of past banners, the clock and the
 * zone are inputs, so canary 6 can drive a fixture week on a fake clock.
 *
 * The budget (Miles, 2026-11-04 15:08, "go with your picks"):
 * - 6 banners a weekday, at most 2 per source, at least 45 minutes apart.
 * - Reminders he set are exempt: they banner at any hour and do not count against the budget.
 * - Quiet hours follow Control's rule (C Models.swift:14394-14399): after 6 PM, before 6 AM, and weekends.
 *   No other banner then. Items held over quiet hours post at 6:00 as one "While you were off" item, and the
 *   first banner of a weekday is allowed at 8:00.
 * - On by default for reminders and his own drops' resolutions; other sources are off until he turns them on
 *   (the first-week review of the tap-through rate).
 * - Several due at once merge into one "N updates" banner, which counts once.
 */
import { localClock } from './morning-brief-schedule.js'

export const PING_SOURCES = ['reminder', 'resolution', 'prep', 'agent', 'followups', 'stale', 'checkin'] as const
export type PingSource = typeof PING_SOURCES[number]
/** Ranking (plan section 5): reminder, his own resolution, prep, agent finished, follow-ups, stale or red, check-in. */
export const PING_RANK: Record<PingSource, number> = { reminder: 0, resolution: 1, prep: 2, agent: 3, followups: 4, stale: 5, checkin: 6 }

export const PING_BUDGET = {
  perWeekday: 6,
  perSource: 2,
  gapMs: 45 * 60_000,
  /** Control's quiet hours: a weekday from 6:00 to 18:00 is work time. */
  dayStartMinutes: 6 * 60,
  dayEndMinutes: 18 * 60,
  /** The first non-reminder banner of a weekday waits until 8:00. */
  firstBannerMinutes: 8 * 60,
} as const

/** Decided 2026-11-04: banners on for reminders and his own drops' resolutions; the rest off for the first week. */
export const DEFAULT_BANNER_SOURCES: readonly PingSource[] = ['reminder', 'resolution']

export interface BannerRecord {
  /** Epoch ms the banner was shown. */
  at: number
  /** Every source the banner carried (a merged banner carries several). */
  sources: PingSource[]
  /** The feed item ids it announced. */
  ids: string[]
}
export interface BannerCandidate { id: string; source: PingSource; createdAt: number }
export interface BannerPlan {
  /** Banners to show now, each with the ids it announces. One merged banner has `merged: true`. */
  banners: Array<{ ids: string[]; sources: PingSource[]; merged: boolean; exempt: boolean }>
  /** Candidates that stay silent in the chat, with the reason. */
  silent: Array<{ id: string; reason: SilentReason }>
}
export type SilentReason = 'source_off' | 'quiet_hours' | 'before_first_banner' | 'daily_cap' | 'source_cap' | 'too_soon'

/** Control's quiet rule at `nowMs` in `timezone`: weekends, before 6:00 and from 18:00. */
export function isQuietHours(nowMs: number, timezone: string): boolean {
  const c = localClock(nowMs, timezone)
  if (c.weekday === 0 || c.weekday === 6) return true
  return c.minutes < PING_BUDGET.dayStartMinutes || c.minutes >= PING_BUDGET.dayEndMinutes
}

/** The local day's non-exempt banners in the ledger (reminders never count). */
function counted(ledger: readonly BannerRecord[], nowMs: number, timezone: string): BannerRecord[] {
  const today = localClock(nowMs, timezone).day
  return ledger.filter(b => b.at <= nowMs && localClock(b.at, timezone).day === today && b.sources.some(s => s !== 'reminder'))
}

/**
 * Decide which `candidates` banner now. Reminders always banner (one each, never merged, never counted). The rest
 * pass the source switch, quiet hours, 8:00, the daily cap, the per-source cap and the 45-minute gap, in that
 * order; those that pass merge into one banner. The caller records each banner in the ledger before showing it.
 */
export function planBanners(
  candidates: readonly BannerCandidate[],
  ledger: readonly BannerRecord[],
  nowMs: number,
  timezone: string,
  enabled: readonly PingSource[] = DEFAULT_BANNER_SOURCES,
): BannerPlan {
  const plan: BannerPlan = { banners: [], silent: [] }
  const sorted = [...candidates].sort((a, b) => PING_RANK[a.source] - PING_RANK[b.source] || b.createdAt - a.createdAt)
  const rest: BannerCandidate[] = []
  for (const c of sorted) {
    if (c.source === 'reminder') {
      // Exempt: any hour, never counted. A reminder is still subject to his switch (on by default).
      if (enabled.includes('reminder')) plan.banners.push({ ids: [c.id], sources: ['reminder'], merged: false, exempt: true })
      else plan.silent.push({ id: c.id, reason: 'source_off' })
    } else rest.push(c)
  }
  if (!rest.length) return plan

  const silence = (list: BannerCandidate[], reason: SilentReason) => { for (const c of list) plan.silent.push({ id: c.id, reason }) }
  const on = rest.filter(c => enabled.includes(c.source))
  silence(rest.filter(c => !enabled.includes(c.source)), 'source_off')
  if (!on.length) return plan
  if (isQuietHours(nowMs, timezone)) { silence(on, 'quiet_hours'); return plan }
  if (localClock(nowMs, timezone).minutes < PING_BUDGET.firstBannerMinutes) { silence(on, 'before_first_banner'); return plan }

  const today = counted(ledger, nowMs, timezone)
  if (today.length >= PING_BUDGET.perWeekday) { silence(on, 'daily_cap'); return plan }
  const last = today.reduce((max, b) => Math.max(max, b.at), -Infinity)
  if (nowMs - last < PING_BUDGET.gapMs) { silence(on, 'too_soon'); return plan }

  const perSource = new Map<PingSource, number>()
  for (const b of today) for (const s of new Set(b.sources)) perSource.set(s, (perSource.get(s) ?? 0) + 1)
  const pass: BannerCandidate[] = []
  for (const c of on) {
    if ((perSource.get(c.source) ?? 0) >= PING_BUDGET.perSource) plan.silent.push({ id: c.id, reason: 'source_cap' })
    else pass.push(c)
  }
  if (!pass.length) return plan
  const sources = [...new Set(pass.map(c => c.source))]
  plan.banners.push({ ids: pass.map(c => c.id), sources, merged: pass.length > 1, exempt: false })
  return plan
}

/** The banner's words. One item uses its own title; several say how many ("3 updates"). */
export function bannerTitle(count: number, single: string): string {
  return count <= 1 ? single : `${count} updates`
}

/** A ledger trimmed to the last 8 days: enough for any weekday's count and the weekly stale rule. */
export function trimLedger(ledger: readonly BannerRecord[], nowMs: number): BannerRecord[] {
  return ledger.filter(b => nowMs - b.at <= 8 * 86_400_000 && b.at <= nowMs + 60_000)
}
