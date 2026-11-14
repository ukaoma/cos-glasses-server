/**
 * 6.99.16: the COS thread (lib/cos-thread.ts). Auth comes from the parent /api mount. Every answer is
 * `Cache-Control: private, no-store`. Gated exactly like the Drop it routes (routes/drops.ts): while Drop it is off,
 * every route answers 404 `{ error: { code: 'drop_it_off' } }` and no file is created (the store opens on the first
 * request after the feature is turned on). Advertised as `capabilities.dropIt.thread: { protocol: 1 }` while on.
 *
 *   GET  /cos-thread                    CosThreadAnswer: the thread and what the next Ask should do
 *   POST /cos-thread/new     {}         CosThreadAnswer (next.reason 'manual'): closes this thread, starts another
 *   POST /cos-thread/turn    { clientId, sessionId, query, answer?, messageNo?, provider? }   CosThreadAnswer
 *   GET  /cos-thread/search  ?q&limit   { hits: [{ threadId, sessionId, at, query, answerHead, messageNo }], scanned }
 *   GET  /cos-thread/threads ?limit     { threads: [{ id, startedAt, endedAt, asks, segments, title }] }
 *
 * 7.0.39 (persistent thread, candidate 1), advertised as `capabilities.dropIt.thread.history: 1`:
 *   GET  /cos-thread/history ?before|after&limit
 *        { protocol: 1, entries: [{ id, at, kind: 'chat', question, answer, answerChars, full, threadId, status, messageNo }],
 *          older, newest, more, updated }
 *        Every chat of every thread, past and present, oldest to newest within a page. No cursor: the newest page.
 *        limit 1..100 (default 40); a page also stops at 256 KB. `before` and `after` are cursors this route gave out.
 *   GET  /cos-thread/entry/:id          { entry, source: 'ledger' | 'live' | 'archive' | 'preview' }
 *        One chat (`t:<clientId>`) with its whole answer: the ledger's when it holds all of it, else the live
 *        conversation's, else the day archive's, else the preview with `full: false`.
 */
import { Router, type Response } from 'express'
import {
  archivedAnswer, CosThread, CosThreadError, ENTRY_MAX_ANSWER_CHARS, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, parseCursorParts,
  parseTimelineCursor, parseTurnInput, type CosThreadEntryLookup, type HistoryKind,
} from '../lib/cos-thread.js'
import { dataPath } from '../lib/data-dir.js'
import { isCosThreadSession } from '../lib/conversation.js'
import { startTimeline } from '../lib/cos-thread-timeline-sources.js'
import { CRUMB_KINDS } from '../lib/cos-thread-timeline.js'

export interface CosThreadRouterDependencies {
  enabled: () => boolean
  /** The store, opened on first use. Null when it cannot open. */
  thread: () => CosThread | null
  /** 7.0.39: a chat's whole answer from the day archive. Default: the data dir's archive, read only and size-capped. */
  archiveAnswer?: (lookup: CosThreadEntryLookup) => string | undefined
  /** 7.0.39 candidate 3: start the timeline sweeper when the store first opens. Default: the server's sources. */
  startTimeline?: (thread: CosThread) => void
}
const HISTORY_KINDS: readonly HistoryKind[] = ['chat', ...CRUMB_KINDS]
const ENTRY_ID_RE = /^t:([A-Za-z0-9:_-]{8,80})$/

const fail = (res: Response, error: unknown) => {
  if (error instanceof CosThreadError) return res.status(error.status).json({ error: { code: error.code } })
  console.error('[cos-thread] request failed:', error instanceof Error ? error.name : 'error')
  return res.status(500).json({ error: { code: 'cos_thread_failed' } })
}
/** A whole number in [min, max], the default when absent, or null when present and out of range. */
function intParam(raw: unknown, min: number, max: number, fallback: number): number | null {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

export function createCosThreadRouter(deps: CosThreadRouterDependencies): Router {
  const router = Router()
  router.use('/cos-thread', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (!deps.enabled()) return res.status(404).json({ error: { code: 'drop_it_off', message: 'Drop it is off on this server.' } })
    next()
  })
  const withThread = (res: Response, fn: (t: CosThread) => unknown) => {
    const thread = deps.thread()
    if (!thread) return res.status(503).json({ error: { code: 'cos_thread_unavailable' } })
    // 7.0.39 candidate 3: the timeline sweeper starts with the first request that opens the store (Drop it on).
    try { (deps.startTimeline ?? startTimeline)(thread) } catch { /* the thread works without its breadcrumbs */ }
    try { return fn(thread) } catch (e) { return fail(res, e) }
  }

  // 7.0.39: ?threadOnly=1 from a page that sends cosThread (lib/cos-thread.ts view()).
  router.get('/cos-thread', (req, res) => withThread(res, t => res.json(t.view(req.query.threadOnly === '1' ? { isThreadSession: isCosThreadSession } : {}))))

  router.post('/cos-thread/new', (req, res) => {
    const b = req.body
    if (b !== undefined && (b === null || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length)) {
      return res.status(400).json({ error: { code: 'invalid_request', message: 'Send {}.' } })
    }
    return withThread(res, t => res.json(t.startNew()))
  })

  router.post('/cos-thread/turn', (req, res) => {
    const input = parseTurnInput(req.body)
    if (!input) return res.status(400).json({ error: { code: 'invalid_turn' } })
    return withThread(res, t => res.json(t.recordTurn(input)))
  })

  router.get('/cos-thread/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q.length < 2 || q.length > 200) return res.status(400).json({ error: { code: 'invalid_query', message: 'Search with 2 to 200 characters.' } })
    const limit = intParam(req.query.limit, 1, 50, 20)
    if (limit === null) return res.status(400).json({ error: { code: 'invalid_limit' } })
    return withThread(res, t => res.json(t.search(q, limit)))
  })

  router.get('/cos-thread/history', (req, res) => {
    const limit = intParam(req.query.limit, 1, HISTORY_MAX_LIMIT, HISTORY_DEFAULT_LIMIT)
    if (limit === null) return res.status(400).json({ error: { code: 'invalid_limit' } })
    const { before, after } = req.query
    if (before !== undefined && after !== undefined) return res.status(400).json({ error: { code: 'invalid_cursor', message: 'Send before or after, not both.' } })
    // 7.0.39 candidate 3: ?timeline=1 adds the breadcrumbs, in time order, with c2 (before) and c3 (after) cursors.
    // Without it the answer is exactly candidate 1's: chats only, c1 cursors (a page that does not ask never sees a crumb).
    if (req.query.timeline === '1') {
      let kinds: HistoryKind[] | undefined
      if (req.query.kinds !== undefined) {
        const list = typeof req.query.kinds === 'string' ? req.query.kinds.split(',') : null
        if (!list || !list.length || list.some(k => !(HISTORY_KINDS as readonly string[]).includes(k))) return res.status(400).json({ error: { code: 'invalid_kinds' } })
        kinds = [...new Set(list)] as HistoryKind[]
      }
      const raw = before ?? after
      const cursor = raw === undefined ? undefined : parseTimelineCursor(raw)
      if (cursor === null || (before !== undefined && cursor && !('before' in cursor)) || (after !== undefined && cursor && !('after' in cursor))) {
        return res.status(400).json({ error: { code: 'invalid_cursor' } })
      }
      return withThread(res, t => res.json(t.timelinePage({ limit, ...(kinds ? { kinds } : {}), ...(cursor ?? {}) })))
    }
    const raw = before ?? after
    const parts = raw === undefined ? undefined : parseCursorParts(raw)
    if (parts === null) return res.status(400).json({ error: { code: 'invalid_cursor' } })
    return withThread(res, t => res.json(t.historyPage(after !== undefined
      ? { after: parts!.place, ...(parts!.answers !== undefined ? { afterAnswers: parts!.answers } : {}), limit }
      : { before: parts?.place, limit })))
  })

  router.get('/cos-thread/entry/:id', (req, res) => {
    const m = ENTRY_ID_RE.exec(req.params.id)
    if (!m) return res.status(400).json({ error: { code: 'invalid_entry' } })
    return withThread(res, t => {
      const found = t.entry(m[1]!)
      if (!found) return res.status(404).json({ error: { code: 'entry_not_found' } })
      const { entry, lookup } = found
      if (entry.full) return res.json({ entry, source: 'ledger' })
      // 7.0.39 candidate 2: a completed cosThread chat's whole answer is in the thread store itself.
      const stored = t.storedAnswer(lookup.clientId)
      if (typeof stored === 'string') {
        const cut = stored.length > ENTRY_MAX_ANSWER_CHARS
        return res.json({ entry: { ...entry, answer: cut ? stored.slice(0, ENTRY_MAX_ANSWER_CHARS) : stored, answerChars: stored.length, full: !cut }, source: 'ledger' })
      }
      if (entry.status !== 'completed') return res.json({ entry, source: 'preview' })
      let source: 'live' | 'archive' = 'live'
      let whole = t.liveAnswer(lookup)
      if (typeof whole !== 'string' || !whole) {
        source = 'archive'
        try { whole = (deps.archiveAnswer ?? (l => archivedAnswer(dataPath('archive'), l)))(lookup) } catch { whole = undefined }
      }
      if (typeof whole !== 'string' || !whole) return res.json({ entry, source: 'preview' })
      const cut = whole.length > ENTRY_MAX_ANSWER_CHARS
      return res.json({
        entry: { ...entry, answer: cut ? whole.slice(0, ENTRY_MAX_ANSWER_CHARS) : whole, answerChars: whole.length, full: !cut },
        source,
      })
    })
  })

  router.get('/cos-thread/threads', (req, res) => {
    const limit = intParam(req.query.limit, 1, 100, 20)
    if (limit === null) return res.status(400).json({ error: { code: 'invalid_limit' } })
    return withThread(res, t => res.json(t.list(limit)))
  })

  return router
}
