/**
 * 6.99.10 (Drop it plan section 12): how many Work items in Your move wait on you, for `waiting` on
 * GET /api/inbox/summary. It is the open-work list GET /api/work-board/activity/open serves (projectOpenWork), counting
 * the items that want an answer or a look (needsInput, attention, done) and leaving out the ones still running: a run
 * in progress is not waiting on you.
 *
 * The summary is polled, and the board is a bridge read, so one count is shared for `ttlMs` and two callers at once
 * share one read. A read that fails answers null (the summary then counts the chat alone) and is not cached, so the
 * next poll tries again.
 */
import { projectOpenWork, readWorkJournal, type OpenWorkGroup } from './work-activity.js'
import { waitingSessionIds } from './work-session-activity.js'

type Journal = ReturnType<typeof readWorkJournal>
type Rows = Parameters<typeof projectOpenWork>[1]

export interface YourMoveCounterDeps {
  journal: () => Journal
  /** The board rows, or null when the board cannot be read in time. */
  rows: () => Promise<Rows | null>
  /** 7.0.1: each linked session's newest activity, so a superseded report is not counted (the open list's own rule). */
  sessionActivity?: (sessionIds: readonly string[]) => Promise<ReadonlyMap<string, number>>
  now?: () => number
  ttlMs?: number
}

export const YOUR_MOVE_TTL_MS = 30_000
const WAITING_GROUPS: readonly OpenWorkGroup[] = ['needsInput', 'attention', 'done']

/** The pure count: open-work items whose group waits on you. */
export function countYourMove(journal: Journal, rows: Rows, nowMs: number, sessionActivityMs?: ReadonlyMap<string, number>): number {
  if (!journal.available) return 0
  return projectOpenWork(journal, rows, nowMs, { sessionActivityMs }).items.filter(item => WAITING_GROUPS.includes(item.group)).length
}

export function createYourMoveCounter(deps: YourMoveCounterDeps): () => Promise<number | null> {
  const now = deps.now ?? (() => Date.now())
  const ttl = deps.ttlMs ?? YOUR_MOVE_TTL_MS
  let cached: { at: number; value: number } | null = null
  let inflight: Promise<number | null> | null = null
  return () => {
    if (cached && now() - cached.at < ttl) return Promise.resolve(cached.value)
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const journal = deps.journal()
        if (!journal.available) return null
        const rows = await deps.rows()
        if (!rows) return null
        const at = now()
        const waiting = deps.sessionActivity && journal.available ? waitingSessionIds(projectOpenWork(journal, rows, at).items) : []
        const activity = waiting.length ? await deps.sessionActivity!(waiting).catch(() => undefined) : undefined
        const value = countYourMove(journal, rows, at, activity)
        cached = { at: now(), value }
        return value
      } catch {
        return null
      } finally {
        inflight = null
      }
    })()
    return inflight
  }
}
