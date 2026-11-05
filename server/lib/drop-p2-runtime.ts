/**
 * Drop it P2: the parts running together. One object the server starts beside the P1 drop service.
 *
 * - The ping engine polls its sources every minute (prep needs a minute's grain for its 15-minute window).
 * - The reminder tick runs every 30 seconds.
 * - The resolution poll reads the board, the Work journal and the thread cache every 2 minutes; the server's own card
 *   writes and session turn ends call in at once (`onCardWrite`, `onSessionTurn`).
 * - Banners go to an outbox Control reads (`banners(after)`), each once per boot cursor; a reminder banner also goes to
 *   the lens as a `cos_ping` display event.
 *
 * Every reader is injected, so a test runs it on fixtures and a fake clock, and a reader that throws only quiets its
 * source for that tick. Each loop is single flight: a slow board read never stacks a second one. Timers never hold the
 * process open. Logs are counts only.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DropRecord, InboxFeedStore } from './drop-store.js'
import { PingEngine, type PingBanner, type PingSnapshot, type PingStateStore } from './ping-engine.js'
import { DEFAULT_BANNER_SOURCES, type PingSource } from './ping-budget.js'
import type { IntakeRow, ThreadRow, SignalRow, PingCandidate } from './ping-sources.js'
import { feedSink } from './ping-feed-sink.js'
import { createReminderScheduler, pendingReminders, applyReminderAction, type ReminderAction, type ReminderStore } from './reminder-scheduler.js'
import { cardWriteResolutions, pollResolutions, RESOLUTION_POLL_MS, sessionTurnResolutions, type CardSnapshot, type HandoffSnapshot, type SessionState, type ThreadSnapshot } from './drop-resolution.js'

export const P2_TIMING = { pingTickMs: 60_000, reminderTickMs: 30_000, resolutionPollMs: RESOLUTION_POLL_MS, outbox: 50 } as const
/** The COS caches are a few hundred KB; anything far larger is not the cache this reads. */
const CACHE_MAX_BYTES = 8 * 1024 * 1024

export interface BoardRowLite { id: string; domain: string; workIdentity?: string; workStage?: string; checked?: boolean }
export interface JournalReceiptLite { id: string; workID?: string | null; status: string; result?: string | null }

export interface DropP2Deps {
  drops: ReminderStore & { list(): DropRecord[] }
  feed: Pick<InboxFeedStore, 'byKey' | 'insert'>
  pingState: Pick<PingStateStore, 'read' | 'write'>
  timezone: () => string
  now?: () => number
  /** The next calendar event; undefined when the calendar could not be read. */
  nextEvent?: () => Promise<{ title?: unknown; time?: unknown } | null | undefined>
  /** Open Work intake items; undefined when the store is not available. */
  intakeOpen?: () => IntakeRow[] | undefined
  /** operations/scripts, for the thread and signal caches (read only; no script is run). */
  scriptsDir?: string | null
  /** The board; throwing means it could not be read, and the poll infers nothing from it. */
  board?: () => Promise<BoardRowLite[]>
  /** Work journal receipts; undefined when the journal is not available. */
  journal?: () => JournalReceiptLite[] | undefined
  /** Publishes a lens event (display bus). */
  emitLens?: (event: { type: 'cos_ping'; data: Record<string, unknown> }) => void
  enabled?: () => readonly PingSource[]
  bootId?: string
}

export interface OutboxBanner extends PingBanner { seq: number; at: string }

/** The journal's validated raw receipts (work-activity readWorkJournal) as the few fields the poll reads. */
export function journalReceiptsLite(records: ReadonlyArray<Record<string, unknown>>): JournalReceiptLite[] {
  const out: JournalReceiptLite[] = []
  for (const r of records) {
    if (typeof r?.id !== 'string' || typeof r.status !== 'string') continue
    out.push({ id: r.id, status: r.status, workID: typeof r.workID === 'string' ? r.workID : null, result: typeof r.result === 'string' ? r.result : null })
  }
  return out
}

/** Read one array out of a COS cache file, or undefined when the file is missing, unsafe, too large or unreadable. */
export function readCacheArray(dir: string | null | undefined, file: string, key: string): unknown[] | undefined {
  if (!dir) return undefined
  const path = join(dir, file)
  try {
    if (!existsSync(path)) return undefined
    const st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink() || st.size > CACHE_MAX_BYTES) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const list = parsed?.[key]
    return Array.isArray(list) ? list : undefined
  } catch { return undefined }
}

export function createDropP2Runtime(deps: DropP2Deps) {
  const now = deps.now ?? (() => Date.now())
  const bootId = deps.bootId ?? randomBytes(8).toString('hex')
  const outbox: OutboxBanner[] = []
  let seq = 0

  const banner = (b: PingBanner) => {
    outbox.push({ ...b, seq: ++seq, at: new Date(now()).toISOString() })
    if (outbox.length > P2_TIMING.outbox) outbox.shift()
    if (b.exempt && b.sources.includes('reminder')) {
      try { deps.emitLens?.({ type: 'cos_ping', data: { title: b.title, line: b.line, feedIds: b.feedIds, ...(b.notifyId ? { notifyId: b.notifyId } : {}) } }) }
      catch { /* the lens is a second screen: the chat and the Mac banner already have it */ }
    }
  }

  const threadsNow = () => readCacheArray(deps.scriptsDir, '.threads_cache.json', 'threads') as ThreadRow[] | undefined
  const signalsNow = () => readCacheArray(deps.scriptsDir, '.signals_cache.json', 'signals') as SignalRow[] | undefined

  const engine = new PingEngine({
    state: deps.pingState,
    feed: feedSink(deps.feed, now),
    banner,
    now,
    timezone: deps.timezone,
    enabled: deps.enabled ?? (() => DEFAULT_BANNER_SOURCES),
    read: async (): Promise<PingSnapshot> => {
      const snap: PingSnapshot = {}
      try { const e = await deps.nextEvent?.(); if (e !== undefined) snap.nextEvent = e } catch { /* calendar unread */ }
      try { const i = deps.intakeOpen?.(); if (i !== undefined) snap.intakeOpen = i } catch { /* intake unread */ }
      const threads = threadsNow(), signals = signalsNow()
      // Each cache on its own: a missing signals cache must not quiet stale threads. The engine counts the stale source
      // as read (and so may expire a held item) only when both were read.
      if (threads !== undefined) snap.threads = threads
      if (signals !== undefined) snap.signals = signals
      return snap
    },
  })

  const reminders = createReminderScheduler({ store: deps.drops, deliver: c => engine.push(c), now, intervalMs: P2_TIMING.reminderTickMs })

  async function resolutionSnapshot() {
    const snap: { cards?: Map<string, CardSnapshot>; handoffs?: Map<string, HandoffSnapshot[]>; threads?: Map<string, ThreadSnapshot> } = {}
    try {
      const rows = await deps.board?.()
      if (rows) snap.cards = new Map(rows.map(r => [`${r.domain}:${r.workIdentity ?? r.id}`, { workStage: r.workStage, checked: r.checked }]))
    } catch { /* board unread: nothing is inferred from it */ }
    try {
      const receipts = deps.journal?.()
      if (receipts) {
        snap.handoffs = new Map()
        for (const r of receipts) {
          const m = typeof r.workID === 'string' ? /^task:([^:]+):(.+)$/.exec(r.workID) : null
          if (!m) continue
          const key = `${m[1]}:${m[2]}`
          snap.handoffs.set(key, [...(snap.handoffs.get(key) ?? []), { id: r.id, status: r.status, result: r.result ?? null }])
        }
      }
    } catch { /* journal unread */ }
    const threads = threadsNow()
    if (threads) snap.threads = new Map(threads.filter(t => typeof t?.id === 'string').map(t => [t.id as string, { is_resolved: t.is_resolved === true, is_stale: t.is_stale === true }]))
    return snap
  }

  let polling = false, ticking = false
  async function pollOnce(): Promise<number> {
    if (polling) return 0
    polling = true
    try {
      const drops = deps.drops.list()
      if (!drops.length) return 0
      const found = pollResolutions(drops, await resolutionSnapshot(), now())
      return found.length ? engine.push(found).posted : 0
    } catch { return 0 } finally { polling = false }
  }
  async function pingOnce() {
    if (ticking) return
    ticking = true
    try { await engine.tick() } catch { /* never throws by contract; belt and braces */ } finally { ticking = false }
  }

  const timers: Array<ReturnType<typeof setInterval>> = []
  return {
    bootId,
    engine,
    start() {
      if (timers.length) return
      reminders.start()
      void pingOnce(); void pollOnce()
      for (const [fn, ms] of [[pingOnce, P2_TIMING.pingTickMs], [pollOnce, P2_TIMING.resolutionPollMs]] as const) {
        const t = setInterval(() => { void fn() }, ms); t.unref?.(); timers.push(t)
      }
    },
    stop() { reminders.stop(); for (const t of timers.splice(0)) clearInterval(t) },
    tickReminders: () => reminders.tick(),
    pingOnce,
    pollOnce,
    /** The server's own card write (work-board, tasks routes): the same rule as the poll, at once. */
    onCardWrite(domain: string, workIdentity: string, row: CardSnapshot | null) {
      try { const c = cardWriteResolutions(deps.drops.list(), domain, workIdentity, row, now()); if (c.length) engine.push(c) } catch { /* the poll will see it */ }
    },
    onSessionTurn(sessionId: string, outcome: SessionState) {
      try { const c = sessionTurnResolutions(deps.drops.list(), sessionId, outcome, now()); if (c.length) engine.push(c) } catch { /* nothing else watches a held session; it stays open in History */ }
    },
    pushAgent: (ev: Parameters<PingEngine['pushAgent']>[0]) => engine.pushAgent(ev),
    push: (c: PingCandidate[]) => engine.push(c),
    /** Banners since a cursor. A cursor from another boot starts over from what this boot holds. */
    banners(after: { bootId?: string; seq?: number } = {}): { bootId: string; seq: number; banners: OutboxBanner[] } {
      const from = after.bootId === bootId && Number.isSafeInteger(after.seq) ? after.seq! : 0
      return { bootId, seq, banners: outbox.filter(b => b.seq > from) }
    },
    pendingReminders: () => pendingReminders(deps.drops),
    reminderAction: (dropId: string, action: ReminderAction) => applyReminderAction(deps.drops, dropId, action, now()),
  }
}
export type DropP2Runtime = ReturnType<typeof createDropP2Runtime>
