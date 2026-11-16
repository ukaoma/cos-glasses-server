/**
 * Drop it P2 (plan PLAN_drop_it_2026-11-04 section 5): the ping engine.
 *
 * Reads existing signals only (ping-sources.ts). Runs no script, calls no model (canary 9 pins the import graph).
 * Every item lands silently in the pinned COS chat; ping-budget.ts decides which also banner.
 *
 * One delivery path for every source, polled or pushed:
 * 1. Drop what was already posted (its key is in the feed), consumed by a digest, already held, or expired.
 * 2. Quiet hours (Control's rule): work pings are held, not created. Reminders he set and resolutions of his own
 *    drops post at once (a resolution silently; the budget never banners it in quiet hours).
 * 3. From 8:00 on a weekday, what was held posts as ONE "While you were off" item. A held item whose source no
 *    longer reports it (the thread moved, the meeting started) is dropped as expired.
 * 4. The budget picks the banners. The ledger is written BEFORE any banner is shown, so a crash between the two
 *    can lose a banner but never repeat one.
 *
 * Nothing here logs words: only counts.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { acquireServerInstanceLock, type ServerInstanceLock } from './server-instance-lock.js'
import { localClock } from './morning-brief-schedule.js'
import { DEFAULT_BANNER_SOURCES, DEFAULT_BUDGET, isQuietHours, PING_SOURCES, planBanners, trimLedger, bannerTitle, type BannerRecord, type BudgetOptions, type PingSource } from './ping-budget.js'
import { bannerSourcesFrom, budgetFrom, matchesSteer, steerWords, timeMinutes, type P2Settings } from './drop-p2-settings.js'
import { SESSION_LINK_PROVIDERS, type SessionLinkProvider } from './drop-store.js'
import {
  agentCandidate, checkinCandidates, digestCandidate, followupCandidates, prepCandidates, signalCandidates, staleCandidates,
  type IntakeRow, type PingCandidate, type SignalRow, type ThreadRow,
} from './ping-sources.js'

/** Sources posted at once even in quiet hours (plan section 5). */
const ANY_HOUR: ReadonlySet<PingSource> = new Set<PingSource>(['reminder', 'resolution'])
/** Sources the engine polls; a held one of these that the next read no longer reports has expired. */
const POLLED: ReadonlySet<PingSource> = new Set<PingSource>(['prep', 'followups', 'stale', 'checkin'])
export const PING_STATE_LIMITS = { held: 200, consumed: 5_000, consumedDays: 30, fileBytes: 4_000_000, replies: 256 } as const

export interface PingSnapshot {
  nextEvent?: { title?: unknown; time?: unknown; occurrence?: unknown } | null
  intakeOpen?: readonly IntakeRow[] | null
  threads?: readonly ThreadRow[] | null
  signals?: readonly SignalRow[] | null
}

export interface PingState {
  ledger: BannerRecord[]
  held: PingCandidate[]
  /** Keys a digest carried, so they never post again on their own. */
  consumed: Array<{ key: string; at: number }>
  /** 7.0.52 B: Reply ready items posted while mergeReplies is on, waiting for their merged banner. Absent when none. */
  replies?: HeldReply[]
}

/** A Reply ready item waiting for the merged banner: its feed id and key, its session, the provider from the link, when it ended, its line. */
export interface HeldReply { feedId: string; key: string; sessionId: string; provider?: SessionLinkProvider; at: number; line: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseState(raw: unknown): PingState {
  const state: PingState = { ledger: [], held: [], consumed: [] }
  if (!isRecord(raw)) return state
  if (Array.isArray(raw.ledger)) for (const b of raw.ledger) {
    if (!isRecord(b) || typeof b.at !== 'number' || !Array.isArray(b.sources) || !Array.isArray(b.ids)) continue
    const sources = b.sources.filter((s): s is PingSource => (PING_SOURCES as readonly string[]).includes(s as string))
    if (sources.length) state.ledger.push({ at: b.at, sources, ids: b.ids.filter((i): i is string => typeof i === 'string').slice(0, 50), ...(b.replies === true ? { replies: true as const } : {}) })
  }
  if (Array.isArray(raw.held)) for (const h of raw.held.slice(0, PING_STATE_LIMITS.held)) {
    if (isRecord(h) && typeof h.key === 'string' && typeof h.line === 'string' && (PING_SOURCES as readonly string[]).includes(h.source as string)) state.held.push(h as unknown as PingCandidate)
  }
  if (Array.isArray(raw.consumed)) for (const c of raw.consumed) {
    if (isRecord(c) && typeof c.key === 'string' && typeof c.at === 'number') state.consumed.push({ key: c.key, at: c.at })
  }
  if (Array.isArray(raw.replies)) {
    const replies: HeldReply[] = []
    for (const r of raw.replies.slice(-PING_STATE_LIMITS.replies)) {
      if (!isRecord(r) || typeof r.feedId !== 'string' || typeof r.key !== 'string' || typeof r.sessionId !== 'string' || !r.sessionId || typeof r.at !== 'number' || !Number.isFinite(r.at) || typeof r.line !== 'string') continue
      const provider = (SESSION_LINK_PROVIDERS as readonly unknown[]).includes(r.provider) ? r.provider as SessionLinkProvider : undefined
      replies.push({ feedId: r.feedId, key: r.key, sessionId: r.sessionId, ...(provider ? { provider } : {}), at: r.at, line: r.line })
    }
    if (replies.length) state.replies = replies
  }
  return state
}

/** `data/pings/state.json`: the banner ledger, held items and consumed keys. One writer, 0700 folder, 0600 file. */
export class PingStateStore {
  private state: PingState
  private readonly path: string
  private readonly lock: ServerInstanceLock
  private closed = false
  constructor(root: string) {
    const dir = resolve(root)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('ping_store_unsafe')
    this.path = join(dir, 'state.json')
    this.lock = acquireServerInstanceLock({ lockDir: join(dir, 'writer.lock') })
    let raw: unknown = null
    try {
      if (existsSync(this.path)) {
        const f = lstatSync(this.path)
        if (f.isFile() && !f.isSymbolicLink() && f.size <= PING_STATE_LIMITS.fileBytes && !(f.mode & 0o077)) raw = JSON.parse(readFileSync(this.path, 'utf8'))
      }
    } catch { raw = null }  // a damaged state file costs at most a repeated digest key check: the feed keys still hold
    this.state = parseState(isRecord(raw) && raw.version === 1 ? raw : null)
  }
  read(): PingState { return structuredClone(this.state) }
  write(next: PingState, nowMs: number): void {
    if (this.closed) throw new Error('ping_store_closed')
    const cutoff = nowMs - PING_STATE_LIMITS.consumedDays * 86_400_000
    const state: PingState = {
      ledger: trimLedger(next.ledger, nowMs),
      held: next.held.slice(-PING_STATE_LIMITS.held),
      consumed: next.consumed.filter(c => c.at >= cutoff).slice(-PING_STATE_LIMITS.consumed),
      // Only when some wait, so the file is byte-identical to before while mergeReplies is off.
      ...(next.replies?.length ? { replies: next.replies.slice(-PING_STATE_LIMITS.replies) } : {}),
    }
    durableAtomicWriteFileSync(this.path, JSON.stringify({ version: 1, ...state }) + '\n')
    this.state = state
  }
  close(): void { if (this.closed) return; this.closed = true; this.lock.release() }
}

/** Where items land: the pinned chat's feed. `post` is idempotent on the key and returns the feed item id. */
export interface PingFeedSink {
  hasKey(key: string): boolean
  post(candidate: PingCandidate): string
}
/**
 * `sessions` (7.0.52 A): the sessions the banner announces, one entry per session, when every item in it is a session ping
 * (bannerSessions). The phone opens that session's reader when there is one and it names its provider; never a guess.
 */
export interface PingBanner { feedIds: string[]; title: string; line: string; sources: PingSource[]; exempt: boolean; notifyId?: string; sessions?: BannerSession[]; replies?: true }
export interface BannerSession { id: string; provider?: SessionLinkProvider }

/**
 * 7.0.52 C: a Reply ready item, by the exact title and fixed sentence agentCandidate writes for one. A finished or stopped
 * item never matches (its line says "finished" or "stopped on", even when its own label is "Reply ready").
 */
const REPLY_READY_LINE = /^(?:Claude|Codex|Cursor|Grok|Your agent) has a reply ready\.$/
export const isReplyReady = (c: PingCandidate): boolean => c.source === 'agent' && c.title === 'Reply ready' && REPLY_READY_LINE.test(c.line)

/**
 * The sessions a banner announces, or undefined when any item is not a session ping (then nothing is named and the tap
 * keeps today's target). One entry per session id, in order; its provider only when every item for it names the same one
 * the reader serves, so a conflict never picks one.
 */
export function bannerSessions(items: readonly PingCandidate[]): BannerSession[] | undefined {
  if (!items.length) return undefined
  const entries: Array<{ id: string; provider?: unknown }> = []
  for (const item of items) {
    const link = item.source === 'agent' ? item.links.find(l => l.kind === 'session') : undefined
    if (!link || typeof link.id !== 'string' || !link.id) return undefined
    entries.push({ id: link.id, provider: link.provider })
  }
  return distinctSessions(entries)
}

/** One entry per session id, in order; its provider only when every entry for it names the same one the reader serves. */
function distinctSessions(entries: ReadonlyArray<{ id: string; provider?: unknown }>): BannerSession[] {
  const out = new Map<string, { provider: SessionLinkProvider | undefined; conflict: boolean }>()
  for (const e of entries) {
    const provider = (SESSION_LINK_PROVIDERS as readonly unknown[]).includes(e.provider) ? e.provider as SessionLinkProvider : undefined
    const seen = out.get(e.id)
    if (!seen) out.set(e.id, { provider, conflict: false })
    else if (seen.provider !== provider) seen.conflict = true
  }
  return [...out].map(([id, s]) => (s.provider && !s.conflict ? { id, provider: s.provider } : { id }))
}

export interface PingEngineDeps {
  state: Pick<PingStateStore, 'read' | 'write'>
  feed: PingFeedSink
  /** Reads the polled sources. Each field it cannot read is left out, and that source stays quiet this tick. */
  read: () => Promise<PingSnapshot>
  /** Shows a banner (macOS notification; a reminder also pushes to the lens). Called only after the ledger write. */
  banner: (b: PingBanner) => void
  /** A second destination for the exact chosen banners, after the durable ledger; never a new budget decision. */
  phoneBanner?: (b: PingBanner) => void | Promise<void>
  now?: () => number
  timezone: () => string
  enabled?: () => readonly PingSource[]
  /** 6.99.11 settings. When given, they decide the budget, quiet hours, sources, check-in, steer and banners. */
  settings?: () => P2Settings
}

export interface PingTickResult { posted: number; held: number; released: number; expired: number; banners: number }

export class PingEngine {
  private readonly now: () => number
  constructor(private readonly deps: PingEngineDeps) { this.now = deps.now ?? (() => Date.now()) }

  /** Poll the sources and deliver. Never throws: a source that fails is skipped. */
  async tick(): Promise<PingTickResult> {
    const nowMs = this.now(), tz = this.deps.timezone()
    let snap: PingSnapshot = {}
    try { snap = await this.deps.read() } catch { snap = {} }
    const polled: PingCandidate[] = []
    const safely = (fn: () => PingCandidate[]) => { try { polled.push(...fn()) } catch { /* one bad source never stops the others */ } }
    const set = this.settingsNow()
    const src = set?.pings.sources
    const pingsOn = set ? set.pings.on : true
    if (pingsOn && (src?.prep ?? true)) safely(() => prepCandidates(snap.nextEvent, nowMs, tz))
    if (pingsOn && (src?.followups ?? true)) safely(() => followupCandidates(snap.intakeOpen, nowMs))
    if (pingsOn && (src?.stale ?? true)) safely(() => staleCandidates(snap.threads, nowMs, tz))
    if (pingsOn && (src?.signals ?? true)) safely(() => signalCandidates(snap.signals, nowMs))
    if (set ? set.checkin.on : true) safely(() => checkinCandidates(nowMs, tz, set ? { weekday: set.checkin.weekday, minutes: timeMinutes(set.checkin.time) } : undefined))
    // Sources this snapshot could read: a held item from a source we could not read this tick is kept, not expired.
    const read = new Set<PingSource>(['checkin'])
    if (snap.nextEvent !== undefined) read.add('prep')
    if (snap.intakeOpen !== undefined) read.add('followups')
    if (snap.threads !== undefined && snap.signals !== undefined) read.add('stale')
    return this.deliver(polled, nowMs, tz, { keys: new Set(polled.map(c => c.key)), sources: read })
  }

  /** Deliver pushed candidates now: a reminder that fired, a resolution, an agent that finished. */
  push(candidates: PingCandidate[]): PingTickResult {
    const nowMs = this.now()
    return this.deliver(candidates, nowMs, this.deps.timezone(), null)
  }

  /** A pushed agent event, through the template. Off with the pings switch or the agent source switch. */
  pushAgent(ev: Parameters<typeof agentCandidate>[0]): PingTickResult {
    const set = this.settingsNow()
    if (set && (!set.pings.on || !set.pings.sources.agent)) return { posted: 0, held: 0, released: 0, expired: 0, banners: 0 }
    const c = agentCandidate(ev)
    return c ? this.push([c]) : { posted: 0, held: 0, released: 0, expired: 0, banners: 0 }
  }

  private settingsNow(): P2Settings | null {
    try { return this.deps.settings?.() ?? null } catch { return null }
  }

  /**
   * 7.0.52 B: the merged Reply ready banner, or why not. Returns null when nothing changed (nothing waits, before the first banner
   * of the day, or the gap since the last merged banner has not passed), false when what waited was dropped with no banner, or the
   * banner (its ledger record is already pushed). Called on every delivery, so on the engine's 60 s tick at the latest: a release
   * can be up to a minute after the gap ends.
   * - Quiet hours (and weekends when quiet): no banner now or later; what waited is already in the chat. Replies that arrive in
   *   quiet hours never get here: they are held for the "While you were off" item as before.
   * - The gap is measured from the last merged reply banner only (a clock that went back waits for at most one gap).
   * - At release a reply whose item is no longer in the chat (purged) is dropped; several replies of one session count once.
   *   Zero left: no banner. Not tonight (the lead, 16:42; a named 7.0.53 follow-up): a re-check against the session's state, so a
   *   reply he has already answered at the desk can still be announced.
   * - Title and line, which the Mac banner shows: one session "Reply ready" and its own line ("Claude has a reply ready."); several
   *   "N sessions replied" and "N sessions have a reply ready." Never a title or reply text.
   */
  private releaseReplies(state: PingState, nowMs: number, tz: string, budget: BudgetOptions): PingBanner | false | null {
    const held = state.replies ?? []
    if (!held.length) return null
    if (isQuietHours(nowMs, tz, budget)) { delete state.replies; return false }
    if (localClock(nowMs, tz).minutes < budget.firstBannerMinutes) return null
    const last = state.ledger.reduce((m, b) => (b.replies === true ? Math.max(m, b.at) : m), -Infinity)
    if (nowMs - last < budget.gapMs) return null
    delete state.replies
    const live = held.filter(r => this.deps.feed.hasKey(r.key))
    if (!live.length) return false
    const sessions = distinctSessions(live.map(r => ({ id: r.sessionId, provider: r.provider })))
    const n = sessions.length
    const feedIds = live.map(r => r.feedId)
    state.ledger.push({ at: nowMs, sources: ['agent'], ids: feedIds, replies: true })
    return {
      feedIds, sources: ['agent'], exempt: false, sessions, replies: true,
      title: n === 1 ? 'Reply ready' : `${n} sessions replied`,
      line: n === 1 ? live[live.length - 1].line : `${n} sessions have a reply ready.`,
    }
  }

  private deliver(incoming: PingCandidate[], nowMs: number, tz: string, current: { keys: Set<string>; sources: Set<PingSource> } | null): PingTickResult {
    const result: PingTickResult = { posted: 0, held: 0, released: 0, expired: 0, banners: 0 }
    const set = this.settingsNow()
    const budget: BudgetOptions = set ? budgetFrom(set) : DEFAULT_BUDGET
    const leaveAlone = set ? steerWords(set.steer.leaveAlone) : [], about = set ? steerWords(set.steer.about) : []
    const words = (c: PingCandidate) => `${c.title ?? ''} ${c.line}`
    // "Leave alone" mutes a ping by its words. Never a reminder he set, never a follow-up to his own drop.
    if (leaveAlone.length) incoming = incoming.filter(c => c.source === 'reminder' || c.source === 'resolution' || !matchesSteer(words(c), leaveAlone))
    const state = this.deps.state.read()
    const consumed = new Set(state.consumed.map(c => c.key))
    const heldKeys = new Set(state.held.map(h => h.key))
    const quiet = isQuietHours(nowMs, tz, budget)
    const posted: Array<{ candidate: PingCandidate; feedId: string }> = []
    let changed = false

    const seen = new Set<string>()
    for (const c of incoming) {
      if (seen.has(c.key)) continue
      seen.add(c.key)
      if (this.deps.feed.hasKey(c.key) || consumed.has(c.key) || heldKeys.has(c.key)) continue
      if (c.expiresAt !== undefined && c.expiresAt <= nowMs) { result.expired++; continue }
      if (quiet && !ANY_HOUR.has(c.source)) {
        state.held.push(c); heldKeys.add(c.key); result.held++; changed = true
        continue
      }
      posted.push({ candidate: c, feedId: this.deps.feed.post(c) }); result.posted++
    }

    // Release what quiet hours held, as one item, from 8:00 on a weekday.
    if (!quiet && state.held.length && localClock(nowMs, tz).minutes >= budget.firstBannerMinutes) {
      const live = state.held.filter(h => {
        if (h.expiresAt !== undefined && h.expiresAt <= nowMs) return false
        if (current && POLLED.has(h.source) && current.sources.has(h.source) && !current.keys.has(h.key)) return false
        return !this.deps.feed.hasKey(h.key)
      })
      result.expired += state.held.length - live.length
      const digest = digestCandidate(live, nowMs, tz)
      if (digest && !this.deps.feed.hasKey(digest.key)) {
        posted.push({ candidate: digest, feedId: this.deps.feed.post(digest) }); result.posted++
      }
      result.released = live.length
      for (const h of state.held) state.consumed.push({ key: h.key, at: nowMs })
      state.held = []; changed = true
    }

    // 7.0.52 B: with mergeReplies on (and agent banners allowed), a Reply ready item never goes through the budget. It waits in
    // state.replies for ONE merged banner, released at most once per gapMinutes (releaseReplies; ping-budget.ts counted: not
    // counted against the daily or per-source caps). Off: everything goes to the budget exactly as before.
    const enabled = set ? bannerSourcesFrom(set) : this.deps.enabled?.() ?? DEFAULT_BANNER_SOURCES
    const mergeReplies = set?.pings.mergeReplies === true && enabled.includes('agent')
    const waits = (p: { candidate: PingCandidate }) => isReplyReady(p.candidate) && p.candidate.links.some(l => l.kind === 'session' && !!l.id)
    let forBudget = posted
    if (mergeReplies) {
      const replies = posted.filter(waits)
      if (replies.length) {
        forBudget = posted.filter(p => !waits(p))
        const held = state.replies ?? []
        for (const p of replies) {
          const link = p.candidate.links.find(l => l.kind === 'session' && !!l.id)!
          const provider = (SESSION_LINK_PROVIDERS as readonly unknown[]).includes(link.provider) ? link.provider : undefined
          held.push({ feedId: p.feedId, key: p.candidate.key, sessionId: link.id, ...(provider ? { provider } : {}), at: p.candidate.createdAt, line: p.candidate.line })
        }
        state.replies = held.slice(-PING_STATE_LIMITS.replies); changed = true
      }
    } else if (state.replies?.length) { delete state.replies; changed = true }   // switched off: what waited is in the chat
    const banners: PingBanner[] = []
    if (forBudget.length) {
      // "Ping me about": a ping whose words match may banner although its kind is silent. The caps still hold.
      const promoted = new Set(about.length ? forBudget.filter(p => matchesSteer(words(p.candidate), about)).map(p => p.feedId) : [])
      const plan = planBanners(forBudget.map(p => ({ id: p.feedId, source: p.candidate.source, createdAt: p.candidate.createdAt })), state.ledger, nowMs, tz, enabled, budget, promoted)
      banners.push(...plan.banners.map(b => {
        const items = b.ids.map(id => forBudget.find(p => p.feedId === id)!.candidate)
        return {
          feedIds: b.ids, sources: b.sources, exempt: b.exempt, title: bannerTitle(items.length, items[0].title ?? 'COS'),
          line: items.length === 1 ? items[0].line : items.map(i => i.title ?? i.line).join(', '),
          ...(items.length === 1 && items[0].notifyId ? { notifyId: items[0].notifyId } : {}),
          ...((s => (s ? { sessions: s } : {}))(bannerSessions(items))),
          ...(items.every(isReplyReady) ? { replies: true as const } : {}),
        }
      }))
      for (const b of plan.banners) state.ledger.push({ at: nowMs, sources: b.sources, ids: b.ids })
      if (plan.banners.length) changed = true
    }
    if (mergeReplies) {
      const merged = this.releaseReplies(state, nowMs, tz, budget)
      if (merged !== null) { changed = true; if (merged) banners.push(merged) }
    }
    // The ledger is written before any banner is shown: a crash between them can lose a banner, never repeat one.
    if (changed) { this.deps.state.write(state, nowMs); changed = false }
    for (const b of banners) {
      try { this.deps.banner(b); result.banners++ } catch { /* a notifier failure never fails delivery: the item is in the chat */ }
      try { void Promise.resolve(this.deps.phoneBanner?.(structuredClone(b))).catch(() => {}) } catch { /* phone failure is independent of the Mac and feed */ }
    }
    if (changed) this.deps.state.write(state, nowMs)
    if (result.posted || result.held || result.released || result.banners) {
      console.log(`[pings] posted=${result.posted} held=${result.held} released=${result.released} expired=${result.expired} banners=${result.banners}`)
    }
    return result
  }
}
