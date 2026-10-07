/**
 * POST /api/work/search (6.65.0): which board card the user means, by meaning. Auth comes from the parent /api mount.
 *
 * Body `{ query, domain?, scope?, ids? }`. The cards come from the board read /api/tasks serves; the client sends a
 * view (domain, scope) or exact card ids, never task text. A search that cannot run answers 200 with
 * `{ available: false, reason, message }`, so Control keeps its word search. See lib/work-search.ts.
 */
import { Router } from 'express'
import { listBoard } from '../lib/task-store.js'
import { isSafeDomainName } from '../lib/domains.js'
import { queryLength, sharedWorkSearchJevClient, selectCandidates, unavailable, workSearchEnabled, WorkSearcher, WORK_SEARCH_LIMITS,
  WORK_SEARCH_SCOPES, type WorkSearchResult, type WorkSearchScope } from '../lib/work-search.js'

export interface WorkSearchRouteDependencies {
  searcher: Pick<WorkSearcher, 'search'>
  list: () => ReturnType<typeof listBoard>
  enabled: () => boolean
}

const BODY_KEYS = new Set(['query', 'domain', 'scope', 'ids'])
const TASK_ID = /^[a-f0-9]{12}$/
/** One log line per degrade reason per 10 minutes: Control falls back quietly, so the server says why. */
export const WORK_SEARCH_LOG_EVERY_MS = 10 * 60_000

export function createWorkSearchRouter(overrides: Partial<WorkSearchRouteDependencies> = {}): Router {
  const deps: WorkSearchRouteDependencies = { searcher: new WorkSearcher(sharedWorkSearchJevClient()), list: () => listBoard(),
    enabled: () => workSearchEnabled(), ...overrides }
  const router = Router()
  const logged = new Map<string, number>()
  const answer = (res: import('express').Response, result: WorkSearchResult) => {
    if (!result.available) {
      const at = Date.now(), last = logged.get(result.reason)
      if (last === undefined || at - last >= WORK_SEARCH_LOG_EVERY_MS) {
        logged.set(result.reason, at)
        console.warn(`[work-search] meaning search unavailable: ${result.reason}`)
      }
    }
    return res.json(result)
  }
  router.use('/work/search', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })

  router.post('/work/search', async (req, res) => {
    const body = req.body
    const bad = () => res.status(400).json({ error: { code: 'invalid_search_request',
      message: `Send a query of ${WORK_SEARCH_LIMITS.queryMin} to ${WORK_SEARCH_LIMITS.queryMax} characters, and optionally a domain, a scope or card ids.` } })
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !BODY_KEYS.has(k))) return bad()
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    const length = queryLength(query)
    if (length < WORK_SEARCH_LIMITS.queryMin || length > WORK_SEARCH_LIMITS.queryMax) return bad()
    if (body.domain !== undefined && (typeof body.domain !== 'string' || !isSafeDomainName(body.domain))) return bad()
    if (body.scope !== undefined && !(WORK_SEARCH_SCOPES as readonly unknown[]).includes(body.scope)) return bad()
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id: unknown) => typeof id !== 'string' || !TASK_ID.test(id)))) return bad()
    if (!deps.enabled()) return answer(res, unavailable('search_off'))
    const ids: string[] | undefined = body.ids ? [...new Set<string>(body.ids)] : undefined
    // Refused before reading the board: a Choice cannot hold them, and a cut list would silently miss cards.
    if (ids && ids.length > WORK_SEARCH_LIMITS.maxCandidates) return answer(res, unavailable('too_many_candidates'))
    let rows: Awaited<ReturnType<typeof listBoard>>
    try { rows = await deps.list() } catch (e) {
      console.error('[work-search] board read failed:', e instanceof Error ? e.message : e)
      return res.status(503).json({ error: { code: 'work_board_unavailable', message: 'Work board is unavailable. Refresh before searching.' } })
    }
    const candidates = selectCandidates(rows, { domain: body.domain, scope: body.scope as WorkSearchScope | undefined, ids })
    if (!candidates) return answer(res, unavailable('too_many_candidates'))
    try {
      return answer(res, await deps.searcher.search(query, candidates))
    } catch (e) {
      console.error('[work-search] search failed:', e instanceof Error ? e.message : e)
      return answer(res, unavailable('jev_unavailable'))
    }
  })
  return router
}
