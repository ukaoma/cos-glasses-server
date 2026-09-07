import { Router } from 'express'
import { callPython, contextSourceAvailable, pythonBridgeState } from '../lib/python-bridge.js'
import { searchMemories } from '../lib/context-library-search.js'

/**
 * Is there anything to serve — a Python bridge OR plain files on disk?
 *
 * These routes used to gate on `pythonBridgeAvailable()`, which returned 503
 * before `callPython` was ever reached. That is why "I selected COS Memory and
 * the G2 says Unavailable" was the experience for anyone without a venv and a
 * vector database: the answer was decided two layers above the data.
 */
function contextConfigured(): boolean {
  return contextSourceAvailable() !== null
}
import { normalizeReviewDecision, LEARNING_REVIEW_LIMIT,
  GRAPH_ENTITY_ID_LIMIT,
  LEARNING_EVENT_ID_PATTERN,
  MEMORY_ID_PATTERN,
  normalizeGraphEntity,
  normalizeGraphPassages,
  normalizeGraphSearch,
  normalizeGraphStatus,
  normalizeIndexBuildKickoff,
  normalizeIngestKickoff,
  INGEST_LIMIT_DEFAULT,
  INGEST_LIMIT_MAX,
  normalizeKnowledgeSetup,
  normalizeKnowledgeSources,
  normalizeSampleKickoff,
  normalizeGraphAnswer,
  normalizeIngestProgress,
  KNOWLEDGE_SETUP_SAMPLE_MAX,
  KNOWLEDGE_ASK_MAX_CHARS,
  normalizeLearningEventDetail,
  normalizeLearningEvents,
  normalizeLearningStatus,
  normalizeMemoryDetail,
  normalizeMemoryList,
  normalizeMemoryOverview,
  normalizeContextBrowserStatus,
} from '../lib/cos-context-browser.js'

export const memoryRouter = Router()
let overviewCache: { expiresAt: number; value: ReturnType<typeof normalizeMemoryOverview> } | null = null

memoryRouter.get('/context/status', async (_req, res) => {
  noStore(res)
  if (!contextConfigured()) {
    const state = pythonBridgeState()
    res.json(normalizeContextBrowserStatus({
      available: false, protocol: 1, state,
      memory: { available: false, total: 0, state },
      threads: { available: false, total: 0, active: 0, stale: 0, resolved: 0, state },
    }))
    return
  }
  // Both bridge calls are created in ONE synchronous statement so the second
  // never extends the wall time past the first (8 s worst case, not 9.5 s,
  // against Control's 12 s helper timeout). The base call keeps its exact
  // semantics; the learning/graph blocks are additive and drop silently when
  // the second call is rejected, slow, or answers with an error (an older
  // bridge prints an unknown-command error and exits 1, which rejects).
  const [base, extra] = await Promise.allSettled([
    callPython(['context-status'], 8_000),
    callPython(['context-learning-graph-status'], 1_500),
  ])
  if (base.status === 'rejected') {
    res.json(normalizeContextBrowserStatus({
      available: false, protocol: 1, state: 'bridge_error',
      memory: { available: false, total: 0, state: 'bridge_error', reason: 'bridge_error' },
      threads: { available: false, total: 0, active: 0, stale: 0, resolved: 0, state: 'bridge_error', reason: 'bridge_error' },
    }))
    return
  }
  const extraPayload = extra.status === 'fulfilled' && bridgePayload(extra.value) ? extra.value : null
  const baseValue = bridgePayload(base.value) ? base.value : {}
  res.json(normalizeContextBrowserStatus({
    ...baseValue,
    ...(extraPayload ? { learning: extraPayload.learning, graph: extraPayload.graph } : {}),
  }))
})

/** True only for an object payload that is not an `{ error }` answer. */
/**
 * A bridge answer that is a payload rather than a failure. An `error` KEY is not
 * an error by itself: the graph-passages shape always carries one, `null` on
 * success (graph_context._passages_shape), so only a non-null value counts.
 */
function bridgePayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && bridgeErrorCode(value) === null
}

function bridgeErrorCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('error' in value)) return null
  const error = (value as { error: unknown }).error
  if (error === null || error === undefined) return null
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code
  return 'bridge_error'
}

/**
 * Map a learning/knowledge bridge answer to an HTTP status. Never a 200 for an
 * `{ error }` payload: the file tier answers every learning command with the
 * string-form `cos_pipeline_not_configured`, and an empty object would read as
 * success.
 */
function sendBridgeAnswer(res: import('express').Response, data: unknown, normalize: (value: unknown) => unknown): void {
  const code = bridgeErrorCode(data)
  if (code) {
    const notFound = code.endsWith('_not_found')
    const invalid = code.startsWith('invalid_')
    res.status(notFound ? 404 : invalid ? 400 : 503).json({ error: code })
    return
  }
  const value = normalize(data)
  if (value === null || value === undefined) {
    res.status(404).json({ error: 'record_not_found' })
    return
  }
  res.json(value)
}

function noStore(res: import('express').Response): void {
  res.set('Cache-Control', 'private, no-store')
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

// ── Recent learning (6.44.5) ──

memoryRouter.get('/context/learning/status', async (_req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    sendBridgeAnswer(res, await callPython(['learning-status', '--no-memory'], 8_000), normalizeLearningStatus)
  } catch (error) {
    console.warn('[context] learning bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'learning_unavailable' })
  }
})

memoryRouter.get('/context/learning', async (req, res) => {
  noStore(res)
  const days = boundedInteger(req.query.days, 30, 1, 3650)
  const limit = boundedInteger(req.query.limit, 50, 1, 50)
  const kind = typeof req.query.kind === 'string' ? req.query.kind.replace(/[^a-z,]/g, '').slice(0, 160) : ''
  const sinceTs = typeof req.query.since_ts === 'string' && Number.isFinite(Date.parse(req.query.since_ts)) ? req.query.since_ts.slice(0, 40) : ''
  const sinceId = typeof req.query.since_event_id === 'string' && LEARNING_EVENT_ID_PATTERN.test(req.query.since_event_id) ? req.query.since_event_id : ''
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  const args = ['learning-events', `--days=${days}`, `--limit=${limit}`]
  if (kind) args.push(`--kind=${kind}`)
  if (sinceTs) args.push(`--since-ts=${sinceTs}`)
  if (sinceId) args.push(`--since-event-id=${sinceId}`)
  try {
    sendBridgeAnswer(res, await callPython(args, 8_000), value => normalizeLearningEvents(value, limit))
  } catch (error) {
    console.warn('[context] learning bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'learning_unavailable' })
  }
})

memoryRouter.get('/context/learning/review', async (req, res) => {
  noStore(res)
  // The strict To review set (learning_events.to_review) as event rows, so the
  // chip, Doctor and the list count the same thing. Small set: one page.
  const limit = boundedInteger(req.query.limit, LEARNING_REVIEW_LIMIT, 1, LEARNING_REVIEW_LIMIT)
  const days = req.query.days === undefined ? null : boundedInteger(req.query.days, 3650, 1, 3650)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    const args = ['learning-to-review', `--limit=${limit}`, ...(days ? [`--days=${days}`] : [])]
    sendBridgeAnswer(res, await callPython(args, 8_000), value => normalizeLearningEvents(value, limit, LEARNING_REVIEW_LIMIT))
  } catch (error) {
    console.warn('[context] learning review bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'learning_unavailable' })
  }
})

memoryRouter.post('/context/learning/:id/review', async (req, res) => {
  noStore(res)
  // The one learning write (6.44.7): a review decision on a lesson, appended to
  // the review ledger by the bridge. Dismissed leaves To review, reopened
  // returns; nothing else is touched. The lesson id is a store id, not an event id.
  const lessonId = String(req.params.id)
  const decision = typeof req.body?.decision === 'string' ? req.body.decision : ''
  if (!lessonId || lessonId.length > 200 || CONTROL_CHARACTER.test(lessonId)) { res.status(400).json({ error: 'invalid_lesson_id' }); return }
  if (decision !== 'dismissed' && decision !== 'reopened') { res.status(400).json({ error: 'invalid_decision' }); return }
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 400) : ''
    const answer = await callPython(['learning-decide', `--id=${lessonId}`, `--decision=${decision}`, ...(note ? [`--note=${note}`] : [])], 8_000)
    sendBridgeAnswer(res, answer, value => normalizeReviewDecision(value))
  } catch (error) {
    console.warn('[context] learning decide bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'learning_unavailable' })
  }
})

memoryRouter.get('/context/learning/:id', async (req, res) => {
  noStore(res)
  if (!LEARNING_EVENT_ID_PATTERN.test(req.params.id)) { res.status(400).json({ error: 'invalid_event_id' }); return }
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    sendBridgeAnswer(res, await callPython(['learning-event', `--id=${req.params.id}`], 8_000), normalizeLearningEventDetail)
  } catch (error) {
    console.warn('[context] learning bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'learning_unavailable' })
  }
})

// ── Knowledge graph (6.44.5) ──

memoryRouter.get('/context/graph/status', async (_req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    sendBridgeAnswer(res, await callPython(['graph-status'], 8_000), normalizeGraphStatus)
  } catch (error) {
    console.warn('[context] graph bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

memoryRouter.get('/context/graph/search', async (req, res) => {
  noStore(res)
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (query.length < 2 || query.length > 160 || CONTROL_CHARACTER.test(query)) {
    res.status(400).json({ error: 'q must be 2 to 160 characters', reason: 'invalid_query' })
    return
  }
  const limit = boundedInteger(req.query.limit, 30, 1, 30)
  const offset = boundedInteger(req.query.offset, 0, 0, 100_000)
  const type = typeof req.query.type === 'string' ? req.query.type.replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 40) : ''
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  // One token per value (`--q=...`): a value beginning with `-` is then never
  // read by argparse as a flag (QA 2026-09-06).
  const args = ['graph-search', `--q=${query}`, `--limit=${limit}`, `--offset=${offset}`]
  if (type) args.push(`--type=${type}`)
  try {
    sendBridgeAnswer(res, await callPython(args, 8_000), value => normalizeGraphSearch(value, limit))
  } catch (error) {
    console.warn('[context] graph bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

memoryRouter.get('/context/graph/entity', async (req, res) => {
  noStore(res)
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!id || id.length > GRAPH_ENTITY_ID_LIMIT || CONTROL_CHARACTER.test(id)) {
    res.status(400).json({ error: 'invalid_entity_id' })
    return
  }
  const limit = boundedInteger(req.query.limit, 30, 1, 30)
  const offset = boundedInteger(req.query.offset, 0, 0, 100_000)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    const answer = await callPython(['graph-entity', `--id=${id}`, `--offset=${offset}`, `--limit=${limit}`], 8_000)
    // A no-index or unknown-entity answer is a PAYLOAD from the bridge (found: false);
    // it becomes a 404 with the class Control renders, never a 503 (QA 2026-09-06).
    if (bridgePayload(answer) && answer.found !== true) {
      res.status(404).json({ error: answer.index_state === 'missing' ? 'index_missing' : 'entity_not_found' })
      return
    }
    sendBridgeAnswer(res, answer, value => normalizeGraphEntity(value))
  } catch (error) {
    console.warn('[context] graph bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

memoryRouter.get('/context/graph/passages', async (req, res) => {
  noStore(res)
  const entity = typeof req.query.entity === 'string' ? req.query.entity : ''
  const relationA = typeof req.query.relationA === 'string' ? req.query.relationA : ''
  const relationB = typeof req.query.relationB === 'string' ? req.query.relationB : ''
  const bad = (value: string) => value.length > GRAPH_ENTITY_ID_LIMIT || CONTROL_CHARACTER.test(value)
  if ((!entity && !(relationA && relationB)) || bad(entity) || bad(relationA) || bad(relationB) || (entity && (relationA || relationB))) {
    res.status(400).json({ error: 'invalid_relation' })
    return
  }
  const limit = boundedInteger(req.query.limit, 5, 1, 5)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  const args = entity
    ? ['graph-passages', `--entity=${entity}`, `--limit=${limit}`]
    : ['graph-passages', `--relation-a=${relationA}`, `--relation-b=${relationB}`, `--limit=${limit}`]
  try {
    sendBridgeAnswer(res, await callPython(args, 8_000), normalizeGraphPassages)
  } catch (error) {
    console.warn('[context] graph bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

/**
 * 202 Accepted: the bridge command only SPAWNS the detached build
 * (start_new_session) and returns its receipt at once, so this handler never
 * holds a lock, imports the SDK, or parses GraphML, and returns well inside the
 * drain windows. Poll GET /context/graph/status for `build.state`.
 */
memoryRouter.post('/context/graph/index', async (_req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    const data = await callPython(['graph-index-build', '--reason', 'control'], 5_000)
    const code = bridgeErrorCode(data)
    if (code) { res.status(503).json({ error: code }); return }
    res.status(202).json(normalizeIndexBuildKickoff(data))
  } catch (error) {
    console.warn('[context] graph bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

/**
 * 202 Accepted: start ONE bounded, detached queue ingest on the ingestion
 * owner (`lightrag_indexer.py --process-queue --limit N`). The bridge command
 * only spawns and answers, so this never holds the ingest lock or waits on a
 * model call. A replica answers 409 `not_owner`; a held lock, an empty queue
 * or a spent daily budget come back as a 202 whose flags say why nothing
 * started. Poll GET /context/graph/status for `lock.state` and `queue.pending`.
 */
memoryRouter.post('/context/graph/ingest', async (req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  const raw = (req.body as { limit?: unknown } | undefined)?.limit
  const limit = raw === undefined || raw === null ? INGEST_LIMIT_DEFAULT : Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > INGEST_LIMIT_MAX) {
    res.status(400).json({ error: 'invalid_limit', message: `limit must be an integer from 1 to ${INGEST_LIMIT_MAX}` })
    return
  }
  try {
    const data = await callPython(['graph-ingest-start', `--limit=${limit}`, '--reason=control'], 5_000)
    const code = bridgeErrorCode(data)
    if (code === 'not_owner') {
      const detail = data as { message?: unknown; owner_host?: unknown }
      res.status(409).json({ error: code, message: typeof detail.message === 'string' ? detail.message : undefined, owner_host: typeof detail.owner_host === 'string' ? detail.owner_host : null })
      return
    }
    if (code) { res.status(code.startsWith('invalid_') ? 400 : 503).json({ error: code }); return }
    res.status(202).json(normalizeIngestKickoff(data))
  } catch (error) {
    console.warn('[context] ingest bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

/** Where the current or last Control-started ingest stands (6.44.10). Read-only. */
memoryRouter.get('/context/graph/ingest/progress', async (_req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    const data = await callPython(['graph-ingest-progress'], 10_000)
    const code = bridgeErrorCode(data)
    if (code) { res.status(503).json({ error: code }); return }
    res.json(normalizeIngestProgress(data))
  } catch (error) {
    console.warn('[context] progress bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

// ── Knowledge setup (6.44.9): from zero to a first index, in COS Control ──
//
// Six bridge commands behind one guided path: the readiness checklist, the
// source folders, the owner Mac, three sample documents, one question, and
// the scheduled batches. Every write is bounded and owner-only; a replica
// answers 409 not_owner. Paths and questions ride as single argv tokens.

/** Map a bridge error to the status the setup routes share. */
function sendSetupError(res: import('express').Response, code: string, data: unknown): void {
  const detail = asDetail(data)
  if (code === 'not_owner') { res.status(409).json({ error: code, message: detail.message, owner_host: detail.owner_host ?? null }); return }
  if (code.endsWith('_not_found')) { res.status(404).json({ error: code, message: detail.message }); return }
  if (code.startsWith('invalid_')) { res.status(400).json({ error: code, message: detail.message }); return }
  res.status(503).json({ error: code })
}

function asDetail(data: unknown): { message?: string; owner_host?: string } {
  const d = (typeof data === 'object' && data !== null ? data : {}) as { message?: unknown; owner_host?: unknown }
  return { message: typeof d.message === 'string' ? d.message : undefined, owner_host: typeof d.owner_host === 'string' ? d.owner_host : undefined }
}

memoryRouter.get('/context/graph/setup', async (_req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    const data = await callPython(['graph-setup-status'], 20_000)
    const code = bridgeErrorCode(data)
    if (code) { sendSetupError(res, code, data); return }
    res.json(normalizeKnowledgeSetup(data))
  } catch (error) {
    console.warn('[context] setup bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

/** `{ action: add | remove | enable | disable, path }` → the source list after the change. */
memoryRouter.post('/context/graph/setup/sources', async (req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  const body = (req.body ?? {}) as { action?: unknown; path?: unknown }
  const action = typeof body.action === 'string' ? body.action : ''
  const path = typeof body.path === 'string' ? body.path.trim() : ''
  if (!['add', 'remove', 'enable', 'disable'].includes(action)) { res.status(400).json({ error: 'invalid_action', message: 'action must be add, remove, enable or disable' }); return }
  if (!path || path.length > 1000 || path.includes('\0')) { res.status(400).json({ error: 'invalid_path', message: 'path must be 1 to 1000 characters' }); return }
  try {
    const data = await callPython(['graph-setup-sources', `--action=${action}`, `--path=${path}`], 15_000)
    const code = bridgeErrorCode(data)
    if (code) { sendSetupError(res, code, data); return }
    const source = data as { sources?: unknown }
    res.json({ sources: normalizeKnowledgeSources(source.sources) })
  } catch (error) {
    console.warn('[context] setup bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

memoryRouter.post('/context/graph/setup/owner', async (_req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  try {
    const data = await callPython(['graph-setup-owner', '--this-mac'], 10_000)
    const code = bridgeErrorCode(data)
    if (code) { sendSetupError(res, code, data); return }
    res.json(normalizeKnowledgeSetup({ owner: (data as { owner?: unknown }).owner }).owner === undefined ? {} : { owner: normalizeKnowledgeSetup(data).owner })
  } catch (error) {
    console.warn('[context] setup bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

/** 202: queue up to three sample documents from the enabled sources and start one bounded run. */
memoryRouter.post('/context/graph/setup/sample', async (req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  const raw = (req.body as { limit?: unknown } | undefined)?.limit
  const limit = raw === undefined || raw === null ? KNOWLEDGE_SETUP_SAMPLE_MAX : Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > KNOWLEDGE_SETUP_SAMPLE_MAX) { res.status(400).json({ error: 'invalid_limit', message: `limit must be an integer from 1 to ${KNOWLEDGE_SETUP_SAMPLE_MAX}` }); return }
  try {
    const data = await callPython(['graph-ingest-sample', `--limit=${limit}`, '--reason=control'], 90_000)
    const code = bridgeErrorCode(data)
    if (code) { sendSetupError(res, code, data); return }
    res.status(202).json(normalizeSampleKickoff(data))
  } catch (error) {
    console.warn('[context] sample bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

/** One question to the graph. Two model calls under the query budget; bounded to 150 s. */
memoryRouter.post('/context/graph/ask', async (req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  const q = typeof (req.body as { q?: unknown } | undefined)?.q === 'string' ? ((req.body as { q: string }).q).trim() : ''
  if (q.length < 3 || q.length > KNOWLEDGE_ASK_MAX_CHARS) { res.status(400).json({ error: 'invalid_query', message: `q must be 3 to ${KNOWLEDGE_ASK_MAX_CHARS} characters` }); return }
  try {
    const data = await callPython(['graph-ask', `--q=${q}`], 150_000)
    const code = bridgeErrorCode(data)
    if (code) { sendSetupError(res, code, data); return }
    const answer = normalizeGraphAnswer(data)
    if (!answer) { res.status(503).json({ error: 'graph_no_answer' }); return }
    res.json(answer)
  } catch (error) {
    console.warn('[context] ask bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

/** `{ enabled, interval_s? }` → install or remove the scheduled batch agent on the owner Mac. */
memoryRouter.post('/context/graph/setup/schedule', async (req, res) => {
  noStore(res)
  if (!contextConfigured()) { res.status(503).json({ error: pythonBridgeState() }); return }
  const body = (req.body ?? {}) as { enabled?: unknown; interval_s?: unknown }
  if (typeof body.enabled !== 'boolean') { res.status(400).json({ error: 'invalid_enabled', message: 'enabled must be true or false' }); return }
  const interval = body.interval_s === undefined || body.interval_s === null ? 3600 : Number(body.interval_s)
  if (!Number.isInteger(interval) || interval < 900 || interval > 86_400) { res.status(400).json({ error: 'invalid_interval', message: 'interval_s must be an integer from 900 to 86400' }); return }
  try {
    const data = await callPython(['graph-schedule', `--enabled=${body.enabled}`, `--interval-s=${interval}`], 20_000)
    const code = bridgeErrorCode(data)
    if (code) { sendSetupError(res, code, data); return }
    res.json(normalizeKnowledgeSetup({ schedule: (data as { schedule?: unknown }).schedule ?? data }).schedule)
  } catch (error) {
    console.warn('[context] schedule bridge failure:', (error as Error).message)
    res.status(503).json({ error: 'graph_unavailable' })
  }
})

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

memoryRouter.get('/memory/overview', async (_req, res) => {
  if (!contextConfigured()) {
    res.status(503).json(normalizeMemoryOverview({
      available: false, reason: pythonBridgeState(), total: 0, by_type: {},
    }))
    return
  }
  if (overviewCache && overviewCache.expiresAt > Date.now()) {
    res.json(overviewCache.value)
    return
  }
  try {
    const data = await callPython(['memory-overview'])
    const value = normalizeMemoryOverview(data)
    overviewCache = { expiresAt: Date.now() + 30_000, value }
    res.json(value)
  } catch (error) {
    res.status(503).json({
      available: false,
      collection: 'cos_memory',
      total: 0,
      by_type: {},
      reason: 'memory_bridge_unavailable',
    })
  }
})

memoryRouter.get('/memory/search', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (query.length < 2) {
    res.status(400).json({ error: 'q must be at least 2 characters', reason: 'invalid_query' })
    return
  }
  const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
  res.set('Cache-Control', 'private, no-store')
  try {
    const result = await searchMemories({
      query,
      limit: Number.isFinite(rawLimit) ? rawLimit : 20,
    })
    res.json(result)
  } catch {
    res.status(503).json({ error: 'memory_search_unavailable', reason: 'memory_search_unavailable' })
  }
})

memoryRouter.get('/memory/:id', async (req, res) => {
  if (!MEMORY_ID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: 'invalid_memory_id' })
    return
  }
  if (!contextConfigured()) {
    res.status(503).json({ error: pythonBridgeState() })
    return
  }
  try {
    const data = await callPython(['memory-detail', req.params.id])
    if (data && typeof data === 'object' && 'error' in data) {
      res.status(404).json({ error: 'memory_not_found' })
      return
    }
    const memory = normalizeMemoryDetail(data)
    if (!memory) {
      res.status(404).json({ error: 'memory_not_found' })
      return
    }
    res.json(memory)
  } catch {
    res.status(503).json({ error: 'memory_unavailable' })
  }
})

memoryRouter.get('/memory', async (req, res) => {
  const days = boundedInteger(req.query.days, 30, 1, 3650)
  const limit = boundedInteger(req.query.limit, 20, 1, 50)
  if (!contextConfigured()) {
    res.status(503).json({ error: pythonBridgeState() })
    return
  }
  try {
    const data = await callPython(['memory', '--days', String(days), '--limit', String(limit)])
    // Preserve the legacy top-level array used by released companions.
    res.json(normalizeMemoryList(data, limit))
  } catch {
    res.status(503).json({ error: 'memory_unavailable' })
  }
})
