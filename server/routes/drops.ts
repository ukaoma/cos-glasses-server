/**
 * Drop it P1 routes (plan sections 1 to 3 and 6). Auth comes from the parent /api mount. All answers are
 * `Cache-Control: private, no-store`.
 *
 * Off by default (lib/drop-settings.ts): while off, every route here except /drops/settings answers
 * 404 `{ error: { code: 'drop_it_off' } }`, and no drop or feed file is created. The stores open on the first request
 * after the feature is turned on. GET /api/sessions/today/all-messages, /live-chats and /api/message-counter are not
 * touched by anything here.
 *
 *   GET  /drops/settings                      { protocol, enabled, source, router }
 *   PUT  /drops/settings  { enabled }         same answer
 *   POST /drops           { dropId, text, source, hint?: { sessionId, label? }, file? }  DropAnswer
 *   GET  /drops           ?q&kind&status&limit&before                                   History
 *   GET  /drops/:id                                                                     DropAnswer
 *   POST /drops/:id/undo                                                                DropAnswer
 *   POST /drops/:id/move  { dest, target?: { id, label, domain? } }                     DropAnswer
 *   POST /drops/:id/ask   { clientJobId, generation }                                   DropAnswer
 *   POST /drops/:id/sent                                                                DropAnswer
 *   GET  /inbox/summary                                                                 { unread, waiting, lastLine, lastAt, version }
 *   GET  /inbox/feed      ?after&limit                                                  { items, version, more }
 *   POST /inbox/read      { through }                                                   { unread, waiting, version }
 *   POST /inbox/action    { itemId, action: 'choose:<id>' | 'undo' }                    DropAnswer
 *   POST /inbox/action    { itemId, action: 'dismiss' }                                 { unread, waiting, version }
 *   P2:
 *   POST /inbox/action    { itemId, action: 'when:tomorrow_9' | 'when:monday_9' | 'when:<ISO>' }  DropAnswer
 *   POST /inbox/action    { itemId, action: 'reminder_done' | 'snooze_1h' | 'snooze_tomorrow' }  { item, drop, unread, waiting, version }
 *   GET  /inbox/banners   ?bootId&seq                                                   { bootId, seq, banners }
 *   GET  /drops/reminders                                                               { reminders: [{ id, at, title, notifyId }] }
 *   POST /drops/search    { q }                                                         DropSearchResult
 *
 * `waiting` (6.99.10, plan section 12) is a plain whole number: live questions, live items marked needsReply, and the
 * Work items in Your move. It clears only when answered, done or dismissed; `unread` clears when the chat is opened.
 */
import { Router, type Response } from 'express'
import { DropError, DropService, type DropInput, type HistoryStatus } from '../lib/drop-service.js'
import { DROP_DESTS, DROP_KINDS, DropStore, DropStoreError, InboxFeedStore, parseLink, type DropDest, type DropKind } from '../lib/drop-store.js'
import { dropItCapability, dropItEnabled, dropItEnvValue, writeDropItSetting } from '../lib/drop-settings.js'
import { dropDailyCap, dropRouterEnabled } from '../lib/drop-router.js'
import type { DropP2Runtime } from '../lib/drop-p2-runtime.js'
import type { DropHistorySearcher } from '../lib/drop-history-search.js'
import { pendingReminders } from '../lib/reminder-scheduler.js'
import { unavailable } from '../lib/work-search.js'
import { mergeP2Settings, P2_DEFAULTS, P2_SETTINGS_PROTOCOL, type P2Settings } from '../lib/drop-p2-settings.js'

export interface DropsRouterDependencies {
  /** The service, opened on first use. Null when its stores cannot open (locked, unsafe, unreadable). */
  service: () => DropService | null
  enabled: () => boolean
  routerStatus?: () => { on: boolean; dailyCap: number; usedToday?: number; breakerOpenUntil?: string | null }
  writeSetting?: (enabled: boolean) => void
  /**
   * 6.99.10: how many Work items are in Your move, or null when the board cannot be read. Counted into `waiting`.
   * Optional: without it `waiting` counts the chat alone. It must answer quickly (index.ts caches it).
   */
  yourMove?: () => Promise<number | null>
  /** P2: the pings, reminders and follow-ups runtime, when it is running. Its banner outbox is what Control reads. */
  p2?: () => DropP2Runtime | null
  /** P2: History search by meaning. Absent: the search answers search_off and word search carries on. */
  search?: () => DropHistorySearcher | null
  /** 6.99.11: P2 settings (drop-p2-settings.ts createP2SettingsReader). Absent: GET answers the defaults, PUT 503. */
  p2Settings?: { read(): P2Settings; write(next: P2Settings): P2Settings }
}
const P2_SECTIONS = new Set(['pings', 'followUps', 'checkin', 'reminders', 'banners', 'steer'])

/** How long the summary waits for the Your move count before answering without it. */
export const YOUR_MOVE_WAIT_MS = 1_500
async function boundedYourMove(read: (() => Promise<number | null>) | undefined): Promise<number | null> {
  if (!read) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([read().catch(() => null), new Promise<null>(done => { timer = setTimeout(() => done(null), YOUR_MOVE_WAIT_MS) })])
  } finally { if (timer) clearTimeout(timer) }
}

const HISTORY_STATUSES: readonly HistoryStatus[] = ['open', 'in_progress', 'done', 'undone']
const send = (res: Response, error: unknown) => {
  if (error instanceof DropError || error instanceof DropStoreError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message === error.code ? undefined : error.message } })
  }
  console.error('[drops] request failed:', error instanceof Error ? error.name : 'error')
  return res.status(500).json({ error: { code: 'drop_failed' } })
}
const bad = (res: Response, code: string, message?: string) => res.status(400).json({ error: { code, ...(message ? { message } : {}) } })
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Opens the two stores once, on the first request that needs them. */
export function lazyDropService(open: () => DropService): () => DropService | null {
  let service: DropService | null = null
  return () => {
    if (service) return service
    try { service = open() } catch (e) {
      console.error('[drops] store unavailable:', e instanceof DropStoreError ? e.code : e instanceof Error ? e.name : 'error')
      return null
    }
    return service
  }
}
export function openDropService(dataRoot: (part: string) => string, deps: Omit<ConstructorParameters<typeof DropService>[0], 'drops' | 'feed'>): DropService {
  const drops = new DropStore(dataRoot('drops'))
  let feed: InboxFeedStore
  try { feed = new InboxFeedStore(dataRoot('inbox')) } catch (e) { drops.close(); throw e }
  return new DropService({ ...deps, drops, feed })
}

export function createDropsRouter(deps: DropsRouterDependencies): Router {
  const router = Router()
  router.use(['/drops', '/inbox'], (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })

  const settingsView = () => ({ ...dropItCapability(), router: deps.routerStatus?.() ?? { on: dropRouterEnabled(), dailyCap: dropDailyCap() } })
  router.get('/drops/settings', (_req, res) => res.json(settingsView()))
  router.put('/drops/settings', (req, res) => {
    if (!isRecord(req.body) || typeof req.body.enabled !== 'boolean' || Object.keys(req.body).length !== 1) return bad(res, 'invalid_settings', 'Send { "enabled": true } or { "enabled": false }.')
    try { (deps.writeSetting ?? writeDropItSetting)(req.body.enabled) } catch {
      return res.status(503).json({ error: { code: 'settings_unwritable' } })
    }
    // An environment value wins (COS_DROP_IT); the answer says so through `source`.
    return res.json({ ...settingsView(), ...(dropItEnvValue() !== null ? { savedButEnvWins: true } : {}) })
  })

  // 6.99.11 P2 settings, readable and writable while Drop it is off (as the switch is), so they can be set first.
  const p2View = (settings: P2Settings) => ({ protocol: P2_SETTINGS_PROTOCOL, settings, defaults: P2_DEFAULTS })
  router.get('/drops/settings/p2', (_req, res) => res.json(p2View(deps.p2Settings?.read() ?? P2_DEFAULTS)))
  router.put('/drops/settings/p2', (req, res) => {
    const body = req.body
    if (!isRecord(body) || !Object.keys(body).length || Object.keys(body).some(k => !P2_SECTIONS.has(k)) || Object.values(body).some(v => !isRecord(v))) {
      return bad(res, 'invalid_settings', 'Send one or more sections: pings, followUps, checkin, reminders, banners, steer.')
    }
    if (!deps.p2Settings) return res.status(503).json({ error: { code: 'settings_unwritable' } })
    try { return res.json(p2View(deps.p2Settings.write(mergeP2Settings(deps.p2Settings.read(), body)))) } catch {
      return res.status(503).json({ error: { code: 'settings_unwritable' } })
    }
  })

  // Everything else exists only while the feature is on.
  router.use(['/drops', '/inbox'], (_req, res, next) => {
    if (!deps.enabled()) return res.status(404).json({ error: { code: 'drop_it_off', message: 'Drop it is off on this server.' } })
    next()
  })
  const withService = (res: Response, fn: (s: DropService) => unknown) => {
    const service = deps.service()
    if (!service) return res.status(503).json({ error: { code: 'drop_store_unavailable' } })
    return fn(service)
  }

  router.post('/drops', (req, res) => withService(res, async service => {
    const b = req.body
    if (!isRecord(b) || Object.keys(b).some(k => !['dropId', 'text', 'source', 'hint', 'file'].includes(k))) return bad(res, 'invalid_drop')
    try { return res.json(await service.submit(b as unknown as DropInput)) } catch (e) { return send(res, e) }
  }))

  router.get('/drops', (req, res) => withService(res, async service => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined
    const kind = req.query.kind, status = req.query.status
    if (q !== undefined && q.length > 200) return bad(res, 'invalid_query')
    if (kind !== undefined && !(DROP_KINDS as readonly unknown[]).includes(kind)) return bad(res, 'invalid_kind')
    if (status !== undefined && !(HISTORY_STATUSES as readonly unknown[]).includes(status)) return bad(res, 'invalid_status')
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return bad(res, 'invalid_limit')
    const before = typeof req.query.before === 'string' ? req.query.before : undefined
    try { return res.json(await service.history({ q: q || undefined, kind: kind as DropKind | undefined, status: status as HistoryStatus | undefined, limit, before })) }
    catch (e) { return send(res, e) }
  }))

  // P2, registered before /drops/:id so 'reminders' is never read as a drop id.
  router.get('/drops/reminders', (_req, res) => withService(res, async service => {
    try { return res.json({ reminders: pendingReminders(service.p2Stores().drops) }) } catch (e) { return send(res, e) }
  }))
  router.get('/drops/:id', (req, res) => withService(res, service => {
    try { return res.json(service.get(req.params.id)) } catch (e) { return send(res, e) }
  }))
  router.post('/drops/:id/undo', (req, res) => withService(res, async service => {
    try { return res.json(await service.undo(req.params.id)) } catch (e) { return send(res, e) }
  }))
  router.post('/drops/:id/move', (req, res) => withService(res, async service => {
    const b = req.body
    if (!isRecord(b) || !(DROP_DESTS as readonly unknown[]).includes(b.dest)) return bad(res, 'invalid_move')
    let target: { id: string; label: string; domain?: string } | undefined
    if (b.target !== undefined) {
      const t = b.target
      if (!isRecord(t)) return bad(res, 'invalid_move')
      target = { id: t.id as string, label: t.label as string, ...(t.domain !== undefined ? { domain: t.domain as string } : {}) }
      // The store's own link rule (length, no control characters, id shape), checked before anything is undone or written.
      try { parseLink({ kind: 'card', ...target }) } catch { return bad(res, 'invalid_move', 'That destination cannot be used.') }
    }
    const dest = b.dest as DropDest
    if ((dest === 'new_card' && !target?.domain) || ((dest === 'existing_card') && (!target?.domain)) || ((dest === 'thread' || dest === 'session') && !target)) return bad(res, 'invalid_move', 'This destination needs a target.')
    // A new card takes its domain as its target id.
    const resolved = dest === 'new_card' && target ? { ...target, id: target.domain! } : target
    try { return res.json(await service.move(req.params.id, { dest, target: resolved })) } catch (e) { return send(res, e) }
  }))
  router.post('/drops/:id/ask', (req, res) => withService(res, async service => {
    const b = req.body
    if (!isRecord(b) || typeof b.clientJobId !== 'string' || !Number.isSafeInteger(b.generation)) return bad(res, 'invalid_ask_link')
    try { return res.json(await service.linkAsk(req.params.id, b.clientJobId, b.generation as number)) } catch (e) { return send(res, e) }
  }))
  router.post('/drops/:id/sent', (req, res) => withService(res, async service => {
    try { return res.json(await service.holdSent(req.params.id)) } catch (e) { return send(res, e) }
  }))

  router.get('/inbox/summary', (_req, res) => withService(res, async service => {
    try { await service.syncAsks() } catch { /* a summary never fails for a lookup */ }
    const yourMove = await boundedYourMove(deps.yourMove)
    try { return res.json(service.summary({ yourMove })) } catch (e) { return send(res, e) }
  }))
  router.get('/inbox/feed', (req, res) => withService(res, async service => {
    const after = typeof req.query.after === 'string' ? req.query.after : undefined
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return bad(res, 'invalid_limit')
    try { await service.syncAsks() } catch { /* the chat still reads */ }
    try { return res.json(service.feed({ after, limit })) } catch (e) { return send(res, e) }
  }))
  router.post('/inbox/read', (req, res) => withService(res, async service => {
    if (!isRecord(req.body) || typeof req.body.through !== 'string') return bad(res, 'invalid_read')
    let out: { unread: number; waiting: number; version: number }
    try { out = service.markRead(req.body.through) } catch (e) { return send(res, e) }
    // The same `waiting` the summary gives, Work's Your move included.
    const yourMove = await boundedYourMove(deps.yourMove)
    return res.json({ ...out, waiting: service.summary({ yourMove }).waiting })
  }))
  router.post('/inbox/action', (req, res) => withService(res, async service => {
    const b = req.body
    if (!isRecord(b) || typeof b.itemId !== 'string' || typeof b.action !== 'string') return bad(res, 'invalid_action')
    try {
      if (b.action.startsWith('choose:')) return res.json(await service.choose(b.itemId, b.action.slice('choose:'.length)))
      if (b.action === 'undo') {
        return res.json(await service.undo(service.threadOf(b.itemId)))
      }
      if (b.action.startsWith('when:')) return res.json(await service.setReminderTime(b.itemId, b.action.slice('when:'.length)))
      if (b.action === 'reminder_done' || b.action === 'snooze_1h' || b.action === 'snooze_tomorrow') {
        const out = service.reminderAction(b.itemId, b.action)
        const yourMove = await boundedYourMove(deps.yourMove)
        const sum = service.summary({ yourMove })
        return res.json({ ...out, unread: sum.unread, waiting: sum.waiting, version: sum.version })
      }
      if (b.action === 'dismiss') {
        const out = service.dismiss(b.itemId)
        const yourMove = await boundedYourMove(deps.yourMove)
        return res.json({ ...out, waiting: service.summary({ yourMove }).waiting })
      }
      return bad(res, 'invalid_action')
    } catch (e) { return send(res, e) }
  }))
  // ── P2 ──
  router.get('/inbox/banners', (req, res) => withService(res, async () => {
    const runtime = deps.p2?.()
    if (!runtime) return res.status(503).json({ error: { code: 'pings_unavailable' } })
    const bootId = typeof req.query.bootId === 'string' ? req.query.bootId : undefined
    const seq = typeof req.query.seq === 'string' && /^\d{1,9}$/.test(req.query.seq) ? Number(req.query.seq) : undefined
    return res.json(runtime.banners({ bootId, seq }))
  }))
  router.post('/drops/search', (req, res) => withService(res, async service => {
    const searcher = deps.search?.()
    if (!searcher) return res.json(unavailable('search_off'))
    const q = isRecord(req.body) ? req.body.q : undefined
    try { return res.json(await searcher.search(q, service.p2Stores().drops.list())) } catch (e) { return send(res, e) }
  }))
  return router
}

export { dropItEnabled }
