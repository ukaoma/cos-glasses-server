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
 *   GET  /inbox/summary                                                                 { unread, lastLine, lastAt, version }
 *   GET  /inbox/feed      ?after&limit                                                  { items, version, more }
 *   POST /inbox/read      { through }                                                   { unread, version }
 *   POST /inbox/action    { itemId, action: 'choose:<id>' | 'undo' }                    DropAnswer
 */
import { Router, type Response } from 'express'
import { DropError, DropService, type DropInput, type HistoryStatus } from '../lib/drop-service.js'
import { DROP_DESTS, DROP_KINDS, DropStore, DropStoreError, InboxFeedStore, type DropDest, type DropKind } from '../lib/drop-store.js'
import { dropItCapability, dropItEnabled, dropItEnvValue, writeDropItSetting } from '../lib/drop-settings.js'
import { dropDailyCap, dropRouterEnabled } from '../lib/drop-router.js'

export interface DropsRouterDependencies {
  /** The service, opened on first use. Null when its stores cannot open (locked, unsafe, unreadable). */
  service: () => DropService | null
  enabled: () => boolean
  routerStatus?: () => { on: boolean; dailyCap: number; usedToday?: number; breakerOpenUntil?: string | null }
  writeSetting?: (enabled: boolean) => void
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
      if (!isRecord(t) || typeof t.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(t.id) || typeof t.label !== 'string' || t.label.length > 200
        || (t.domain !== undefined && (typeof t.domain !== 'string' || t.domain.length > 64))) return bad(res, 'invalid_move')
      target = { id: t.id, label: t.label, ...(typeof t.domain === 'string' ? { domain: t.domain } : {}) }
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
    try { return res.json(service.summary()) } catch (e) { return send(res, e) }
  }))
  router.get('/inbox/feed', (req, res) => withService(res, async service => {
    const after = typeof req.query.after === 'string' ? req.query.after : undefined
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return bad(res, 'invalid_limit')
    try { await service.syncAsks() } catch { /* the chat still reads */ }
    try { return res.json(service.feed({ after, limit })) } catch (e) { return send(res, e) }
  }))
  router.post('/inbox/read', (req, res) => withService(res, service => {
    if (!isRecord(req.body) || typeof req.body.through !== 'string') return bad(res, 'invalid_read')
    try { return res.json(service.markRead(req.body.through)) } catch (e) { return send(res, e) }
  }))
  router.post('/inbox/action', (req, res) => withService(res, async service => {
    const b = req.body
    if (!isRecord(b) || typeof b.itemId !== 'string' || typeof b.action !== 'string') return bad(res, 'invalid_action')
    try {
      if (b.action.startsWith('choose:')) return res.json(await service.choose(b.itemId, b.action.slice('choose:'.length)))
      if (b.action === 'undo') {
        return res.json(await service.undo(service.threadOf(b.itemId)))
      }
      return bad(res, 'invalid_action')
    } catch (e) { return send(res, e) }
  }))
  return router
}

export { dropItEnabled }
