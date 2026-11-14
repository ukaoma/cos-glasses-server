/**
 * 7.0.41 (U1; Miles 2026-11-14 12:16, "Collapsed, tap to open"): the plan ruler on the Usage view, as data. Control Web
 * and the Mac app draw exactly these words, so both say the same thing. Built from the usage monitor's own entries (the
 * reader Work already uses); this module reads nothing and spawns nothing.
 *
 * What the numbers are: each provider states a percentage of a window used and when that window resets. Never tokens.
 * A reading that failed, is missing, or belongs to a window that has ended draws no ruler, so it can never look like 0%.
 * Cursor states no plan usage that COS reads: "No plan reading".
 */
import { USAGE_STALE_MS, windowLive, type UsageEntry, type UsageFailureCode, type UsageProvider, type UsageWindow } from './usage.js'

export type PlanState = 'fresh' | 'older' | 'limit' | 'paused' | 'failed' | 'not_read' | 'no_plan'
export interface PlanEstimate { text: string; arithmetic: string }
export interface PlanLine {
  provider: UsageProvider
  name: string
  state: PlanState
  /** Percent of the window used; null when no ruler may be drawn. */
  usedPct: number | null
  /** Percent of the window gone (the "now" line); null with no ruler. */
  gonePct: number | null
  windowStart: string | null
  resetsAt: string | null
  /** "Nov 7, 10:31 PM to Nov 14, 10:31 PM", or the reason the window is not known. */
  windowWords: string
  /** The compact row: "96% used, resets tonight". */
  short: string
  /** The compact row with room: "96% used, resets tonight 10:31 PM". */
  shortLong: string
  /** The open row: "96% used. 93% of the week gone." or the state in plain words. */
  long: string
  /** In the closed summary, for a tool that is not the closest to its limit: "Claude not read". */
  quiet: string
  readAt: string | null
  lastGoodAt: string | null
  reason: UsageFailureCode | null
  estimate: PlanEstimate | null
}
export interface PlanPane { protocolVersion: 1; now: string; readAt: string | null; closest: UsageProvider | null; others: string; lines: PlanLine[] }

const NAME: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }
const WEEK_MINS = 7 * 24 * 60
/** No estimate until this much of the window has passed: an average over a few hours says little. */
export const PLAN_ESTIMATE_MIN_ELAPSED_MS = 12 * 3_600_000

/** The window the ruler draws: Claude's week across all models; Codex's longest window. */
export function rulerWindow(provider: UsageProvider, windows: UsageWindow[]): { w: UsageWindow; mins: number } | null {
  if (provider === 'claude') { const w = windows.find(x => x.kind === 'weekly_all'); return w ? { w, mins: WEEK_MINS } : null }
  if (provider === 'codex') {
    const sized = windows.filter(x => typeof x.durationMins === 'number' && x.durationMins > 0)
    const w = sized.sort((a, b) => b.durationMins! - a.durationMins!)[0]
    return w ? { w, mins: w.durationMins! } : null
  }
  return null
}

const fmt = (d: Date, o: Intl.DateTimeFormatOptions, timeZone?: string) => d.toLocaleString('en-US', { ...o, timeZone })
const timeOf = (d: Date, tz?: string) => fmt(d, { hour: 'numeric', minute: '2-digit' }, tz)
const dayKey = (d: Date, tz?: string) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }, tz)
const hourOf = (d: Date, tz?: string) => Number(fmt(d, { hour: 'numeric', hourCycle: 'h23' }, tz))

/** "tonight 10:31 PM", "today 3:00 PM", "tomorrow 9:00 AM", "Sun 2:59 AM", "Nov 21, 3:00 PM"; short drops the time. */
export function whenWords(iso: string, now: number, tz?: string): { long: string; short: string } {
  const t = new Date(iso), n = new Date(now)
  const days = Math.round((Date.parse(dayKey(t, tz)) - Date.parse(dayKey(n, tz))) / 86_400_000)
  const time = timeOf(t, tz)
  if (days === 0) { const w = hourOf(t, tz) >= 17 ? 'tonight' : 'today'; return { long: `${w} ${time}`, short: w } }
  if (days === 1) return { long: `tomorrow ${time}`, short: 'tomorrow' }
  if (days > 1 && days < 7) { const wd = fmt(t, { weekday: 'short' }, tz); return { long: `${wd} ${time}`, short: wd } }
  const md = fmt(t, { month: 'short', day: 'numeric' }, tz)
  return { long: `${md}, ${time}`, short: md }
}
const dateTime = (iso: string, tz?: string) => `${fmt(new Date(iso), { month: 'short', day: 'numeric' }, tz)}, ${timeOf(new Date(iso), tz)}`

/** "25 min ago", "3 h ago", "Oct 23". */
export function ageWords(iso: string, now: number, tz?: string): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return fmt(new Date(iso), { month: 'short', day: 'numeric' }, tz)
}

/** A failure's reason in plain words, never the exception's own text. */
export function failureWords(provider: UsageProvider, code: UsageFailureCode | null | undefined): string {
  switch (code) {
    case 'no_limits': return `refused by ${NAME[provider]}`
    case 'refused': return `refused by ${NAME[provider]}`
    case 'timed_out': return 'no answer in time'
    case 'not_found': return `${NAME[provider]} is not installed on this Mac`
    case 'unknown_shape': return 'an answer COS cannot read'
    case 'exited': return `${NAME[provider]} stopped before answering`
    default: return 'unexpected error'
  }
}

const span = (ms: number) => {
  const h = ms / 3_600_000, d = Math.floor(h / 24), rest = Math.round((h - d * 24) * 2) / 2
  return d ? `${d} day${d === 1 ? '' : 's'}${rest ? ` ${rest} hour${rest === 1 ? '' : 's'}` : ''}` : `${rest} hour${rest === 1 ? '' : 's'}`
}

/** The labelled estimate: only for a live reading, past 12 hours into its window, under 100%. */
export function estimateFor(name: string, usedPct: number, startMs: number, resetMs: number, now: number, tz?: string): PlanEstimate | null {
  const elapsed = now - startMs, total = resetMs - startMs
  if (elapsed < PLAN_ESTIMATE_MIN_ELAPSED_MS || usedPct <= 0 || usedPct >= 100 || total <= 0 || now >= resetMs) return null
  const perHour = usedPct / (elapsed / 3_600_000)
  const fullAt = now + ((100 - usedPct) / perHour) * 3_600_000
  const reset = whenWords(new Date(resetMs).toISOString(), now, tz).long
  const rounded = new Date(Math.round(fullAt / 900_000) * 900_000), at = whenWords(rounded.toISOString(), now, tz)
  // Today: "about 4:30 PM"; another day: "about tomorrow 9:00 AM".
  const atWords = at.short === 'today' || at.short === 'tonight' ? timeOf(rounded, tz) : at.long
  const text = fullAt < resetMs
    ? `At this week's average pace, ${name} reaches its limit about ${atWords}, before it resets ${reset}.`
    : `At this week's average pace, ${name} stays under its limit until it resets ${reset}.`
  const arithmetic = `Worked out from ${Math.round(usedPct)}% used in ${span(elapsed)} of ${span(total)}, about ${perHour < 1 ? perHour.toFixed(1) : Math.round(perHour)}% an hour.`
  return { text, arithmetic }
}

export function planLine(e: UsageEntry, now: number, tz?: string): PlanLine {
  const name = NAME[e.provider]
  const base = { provider: e.provider, name, readAt: e.observedAt ? new Date(e.observedAt).toISOString() : null,
    lastGoodAt: e.observedAt ? new Date(e.observedAt).toISOString() : null, reason: e.lastFailure ?? null, estimate: null as PlanEstimate | null }
  const none = { usedPct: null, gonePct: null, windowStart: null, resetsAt: null }
  if (e.provider === 'cursor') {
    return { ...base, ...none, state: 'no_plan', windowWords: 'Cursor does not report its plan to COS', short: 'No plan reading', shortLong: 'No plan reading',
      long: 'No plan reading. Cursor does not report its plan to COS.', quiet: 'Cursor no plan reading', readAt: null, lastGoodAt: null }
  }
  const found = e.reading?.available ? rulerWindow(e.provider, e.reading.windows) : null
  const live = found && windowLive(found.w, now) && found.w.resetsAt ? found : null
  // A stated limit, from the provider: a full ruler and when it lifts. It beats every percentage (the reader's rule).
  const limitUntil = e.limitUntil && e.limitUntil > now ? e.limitUntil : (e.reading?.allowed === false && live ? Date.parse(live.w.resetsAt!) : null)
  if (limitUntil) {
    const back = whenWords(new Date(limitUntil).toISOString(), now, tz)
    return { ...base, usedPct: 100, gonePct: null, windowStart: null, resetsAt: new Date(limitUntil).toISOString(), state: 'limit',
      windowWords: `At its plan limit until ${back.long}`, short: `Limit reached, back ${back.long}`, shortLong: `Limit reached, back ${back.long}`,
      long: `Limit reached. ${name} says new work waits until ${back.long}.`, quiet: `${name} at its limit` }
  }
  const held = Math.max(e.pausedUntil ?? 0, e.holdUntil ?? 0)
  if (held > now) {
    const at = timeOf(new Date(held), tz)
    const why = e.lastFailure ? ` The last read: ${failureWords(e.provider, e.lastFailure)}.` : ''
    return { ...base, ...none, state: 'paused', windowWords: 'Week not known', short: `Paused until ${at}`, shortLong: `Paused until ${at}`,
      long: `Paused until ${at}. COS waits before asking ${name} again, so a failing read is not repeated.${why} No number is shown until a read succeeds.`, quiet: `${name} paused` }
  }
  if (e.lastFailure) {
    const w = failureWords(e.provider, e.lastFailure)
    return { ...base, ...none, state: 'failed', windowWords: 'Week not known', short: `Read failed, ${w}`, shortLong: `Read failed, ${w}`,
      long: `Read failed: ${w}. No number is shown until a read succeeds.`, quiet: `${name} read failed` }
  }
  if (!live) {
    return { ...base, ...none, state: 'not_read', windowWords: 'Week not known', short: 'Not read today', shortLong: 'Not read today',
      long: found ? `Not read since its window ended${e.observedAt ? ` (last read ${dateTime(new Date(e.observedAt).toISOString(), tz)})` : ''}. Refresh to read it.` : 'Not read yet. Refresh to read it.',
      quiet: `${name} not read` }
  }
  const reset = Date.parse(live.w.resetsAt!), start = reset - live.mins * 60_000
  const used = Math.max(0, Math.min(100, Math.round(live.w.usedPct)))
  const gone = Math.max(0, Math.min(100, Math.round(((now - start) / (reset - start)) * 1000) / 10))
  const when = whenWords(live.w.resetsAt!, now, tz)
  const older = !e.observedAt || now - e.observedAt > USAGE_STALE_MS
  const unit = live.mins === WEEK_MINS ? 'week' : 'window'
  return { ...base, usedPct: used, gonePct: gone, windowStart: new Date(start).toISOString(), resetsAt: new Date(reset).toISOString(),
    state: older ? 'older' : 'fresh', windowWords: `${dateTime(new Date(start).toISOString(), tz)} to ${dateTime(live.w.resetsAt!, tz)}`,
    short: older ? `${used}% used, read ${e.observedAt ? ageWords(new Date(e.observedAt).toISOString(), now, tz) : 'earlier'}` : `${used}% used, resets ${when.short}`,
    shortLong: older ? `${used}% used, read ${e.observedAt ? ageWords(new Date(e.observedAt).toISOString(), now, tz) : 'earlier'}` : `${used}% used, resets ${when.long}`,
    long: `${used}% used. ${Math.round(gone)}% of the ${unit} gone.${older ? ` Read ${e.observedAt ? ageWords(new Date(e.observedAt).toISOString(), now, tz) : 'earlier'}; it may have moved.` : ''}`,
    quiet: `${name} ${used}% used`, estimate: estimateFor(name, used, start, reset, now, tz) }
}

/** The whole pane: one line per provider, the closest to its limit for the closed row, and the rest in quiet words. */
export function planPane(entries: UsageEntry[], now: number, tz?: string): PlanPane {
  const order: UsageProvider[] = ['claude', 'codex', 'cursor']
  const lines = order.map(p => entries.find(e => e.provider === p)).filter((e): e is UsageEntry => !!e).map(e => planLine(e, now, tz))
  const ranked = lines.filter(l => l.usedPct !== null).sort((a, b) => b.usedPct! - a.usedPct!)
  const closest = ranked[0]?.provider ?? null
  const others = lines.filter(l => l.provider !== closest).map(l => l.quiet).join('. ')
  const reads = lines.map(l => l.readAt).filter((r): r is string => !!r).sort()
  return { protocolVersion: 1, now: new Date(now).toISOString(), readAt: reads.length ? reads[reads.length - 1]! : null, closest, others: others ? `${others}.` : '', lines }
}
