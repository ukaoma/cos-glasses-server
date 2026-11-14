/**
 * 7.0.39 (persistent COS thread, candidate 3): the server's own stores as timeline sources (cos-thread-timeline.ts), and
 * the sweeper's schedule. Kept out of cos-thread.ts so that module imports nothing heavy. Started once per process by
 * the thread routes on first use (routes/cos-thread.ts), so a server with Drop it off never sweeps.
 *
 * Read only: the inbox feed file (parsed with the store's own parser, never through its writer lock), the live
 * conversations (getActiveSessions, which already leaves the thread's out), archive day files (size-capped), and the
 * meeting store's day counts and day lists. Session questions come from X1's turn-end-ask callback when the build has
 * it. Nothing here calls a model or logs a word.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import * as turnEndAsk from './turn-end-ask.js'
import { dataPath } from './data-dir.js'
import { localDay } from './local-day.js'
import { getActiveSessions, getSessionRaw } from './conversation.js'
import { getMeetingStore } from './meeting-store.js'
import { DROP_LIMITS, parseFeedItem } from './drop-store.js'
import { LEGACY_MESSAGE_ERA } from './message-era.js'
import type { CosThread } from './cos-thread.js'
import {
  archiveDayDates, readArchiveDayTurns, recordTurnAskEvent, TimelineSweeper,
  type FeedItemLike, type TimelineSources, type TurnAskEventLike,
} from './cos-thread-timeline.js'

/** Every 60 s while a backfill is still behind, else every 5 minutes. */
export const SWEEP_BACKLOG_MS = 60_000
export const SWEEP_IDLE_MS = 5 * 60_000

/** The inbox feed, read only. A missing, unsafe or unreadable file reads as empty: the chat is never blocked by this. */
export function readFeedFile(file = dataPath('inbox', 'feed.json')): FeedItemLike[] {
  try {
    if (!existsSync(file)) return []
    const st = lstatSync(file)
    if (!st.isFile() || st.size > DROP_LIMITS.fileBytes) return []
    const journal = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; items?: unknown[] }
    if (journal?.version !== 1 || !Array.isArray(journal.items)) return []
    const out: FeedItemLike[] = []
    for (const raw of journal.items) { try { out.push(parseFeedItem(raw)) } catch { /* a bad row is skipped */ } }
    return out
  } catch { return [] }
}

export function serverTimelineSources(): TimelineSources {
  const archive = dataPath('archive')
  const meetings = () => getMeetingStore()
  return {
    feed: () => readFeedFile(),
    liveMessages: () => getActiveSessions().flatMap(s => {
      const surface = getSessionRaw(s.id)?.surface
      return s.exchanges
        .filter(e => e.role === 'user' && Number.isSafeInteger(e.globalMsgNum))
        .map(e => ({ no: e.globalMsgNum as number, era: (e as { messageEra?: string }).messageEra ?? LEGACY_MESSAGE_ERA, query: e.content, at: e.timestamp,
          ...(surface === 'web' ? { surface: 'web' as const } : {}) }))
    }),
    archiveDays: () => archiveDayDates(archive),
    archiveDay: date => readArchiveDayTurns(archive, date),
    meetingMonths: () => meetings().listMonths(),
    meetingDayCounts: month => meetings().listDayCounts(month),
    meetingsOn: day => meetings().list({ day, limit: 200 }).map(m => ({ domain: m.domain, month: m.month, filename: m.filename, title: m.title, date: m.date, ...(m.time ? { time: m.time } : {}) })),
  }
}

let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null

/** Starts the sweeper (and the session-question listener) once per process. Idempotent; never throws. */
export function startTimeline(thread: CosThread, sources: TimelineSources = serverTimelineSources()): void {
  if (started) return
  started = true
  try {
    const store = thread.timeline()
    const sweeper = new TimelineSweeper(store, thread.dir(), sources, () => localDay())
    const run = () => {
      let pending = false
      try { pending = sweeper.sweep().pending } catch (e) { console.error('[cos-thread] timeline sweep failed:', e instanceof Error ? e.name : 'error') }
      timer = setTimeout(run, pending ? SWEEP_BACKLOG_MS : SWEEP_IDLE_MS)
      timer.unref?.()
    }
    timer = setTimeout(run, 5_000)
    timer.unref?.()
    // X1's callback (turn-end-ask.ts onTurnAskEvent), only when this build has it. Replayed asks dedupe on their key.
    const subscribe = (turnEndAsk as unknown as { onTurnAskEvent?: (l: (e: TurnAskEventLike) => void) => () => void }).onTurnAskEvent
    if (typeof subscribe === 'function') {
      unsubscribe = subscribe(e => { try { recordTurnAskEvent(store, e) } catch { /* the breadcrumb is lost, never the ask */ } })
    }
  } catch (e) {
    console.error('[cos-thread] timeline unavailable:', e instanceof Error ? e.name : 'error')
  }
}

/** Tests only. */
export function __resetTimelineForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  unsubscribe?.()
  unsubscribe = null
  started = false
}
