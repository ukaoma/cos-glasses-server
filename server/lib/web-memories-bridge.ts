import { getOwnerName } from './profile.js'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { getNeedsYouReader, memoryReview, needsYouCount, NEEDS_YOU_TTL_MS, type NeedsYouBlock, type NeedsYouPeek } from './learning-needs-you.js'
import { liveCueVerdicts } from './live-cue-verdicts.js'

/** The build after 7.0.42 (Memories C): the window "meetings to rate" counts, the same 7 days the page shows. */
export const NEEDS_YOU_CUE_DAYS = 7

export interface NeedsYouSummary {
  meetings: number | null; decisions: number | null; quarantineBatch: number | null; total: number | null
  /** The build after 7.0.46: 'not_set_up' (COS_SCRIPTS_DIR unset: no learning pipeline, so no decisions or quarantine rows
   *  at all, and the total is the meetings), 'read' (a good block), or 'unknown' (anything else: no number). */
  learning: 'not_set_up' | 'read' | 'unknown'
  /** How old the block is, in seconds, and whether it is under the 90 s TTL. A saved count past the TTL is never fresh. */
  ageSeconds: number | null
  fresh: boolean | null
}

/**
 * The one "Needs you" number the rail, Today and the Memories page all show (lead 2026-11-14 15:49, F1's option (a)).
 * - decisions: every item the 11-08 predicate says needs review (memoryReview.total, unchanged), minus the memories the
 *   retention pass would quarantine (`gates.prune_ready`), which count as one batch instead.
 * - quarantineBatch: 1 when any are waiting, else 0.
 * - meetings: meetings with a cue to rate in the last NEEDS_YOU_CUE_DAYS, skipped ones left out (null when unreadable).
 * A part that cannot be read is null, and then so is the total: the rail never shows a number built from a guess.
 * The producer's `count` and `gates` both cover every item past the shown cap (learning_events.py needs-you).
 */
export function computeNeedsYou(
  block: NeedsYouBlock | null, meetings: number | null,
  opts: { notSetUp?: boolean; ageMs?: number | null } = {},
): NeedsYouSummary {
  const m = typeof meetings === 'number' && Number.isInteger(meetings) && meetings >= 0 ? meetings : null
  // Lead 22:0x: absent is not unknown, for exactly this one case. No pipeline means nothing to decide and nothing to
  // quarantine, so those rows are not drawn (null, never a 0 that would claim a count was taken) and the total is the
  // meetings alone.
  if (opts.notSetUp === true) return { meetings: m, decisions: null, quarantineBatch: null, total: m, learning: 'not_set_up', ageSeconds: null, fresh: null }
  const all = block ? memoryReview.total(block) : null
  const gates = block && block.gates && typeof block.gates === 'object' && !Array.isArray(block.gates) ? block.gates as Record<string, unknown> : null
  const prune = gates ? (typeof gates.prune_ready === 'number' && Number.isInteger(gates.prune_ready) && gates.prune_ready > 0 ? gates.prune_ready : 0) : null
  const decisions = typeof all === 'number' && prune !== null ? Math.max(0, all - prune) : null
  const quarantineBatch = prune === null ? null : prune > 0 ? 1 : 0
  const total = m !== null && decisions !== null && quarantineBatch !== null ? m + decisions + quarantineBatch : null
  const age = block && typeof opts.ageMs === 'number' && Number.isFinite(opts.ageMs) && opts.ageMs >= 0 ? opts.ageMs : null
  return {
    meetings: m, decisions, quarantineBatch, total, learning: block ? 'read' : 'unknown',
    ageSeconds: age === null ? null : Math.floor(age / 1000), fresh: age === null ? null : age < NEEDS_YOU_TTL_MS,
  }
}

function defaultUnratedMeetings(): number | null {
  try { return liveCueVerdicts().unratedSessionCount(NEEDS_YOU_CUE_DAYS) } catch { return null }
}

export const READ_ONLY_MEMORY_WEB_OPS = new Set([
  'status', 'learning.list', 'learning.review', 'learning.event', 'learning.status',
  'memories.list', 'memories.search', 'memory.detail', 'graph.status', 'profile.owner',
  'graph.search', 'graph.entity', 'graph.passages', 'graph.setup', 'graph.ask',
  'graph.progress', 'memory.guardrails', 'graph.merge.preview', 'graph.merge.status',
  'graph.duplicates', 'cues.summary', 'copy',
])

export const MUTATING_MEMORY_WEB_OPS = new Set([
  'learning.decide', 'profile.owner.set', 'graph.build', 'graph.ingest',
  'graph.setup.sources', 'graph.setup.owner', 'graph.sample', 'graph.setup.embedding',
  'graph.setup.extraction', 'memory.review', 'memory.guardrails.set',
  'memory.guardrails.run', 'graph.merge', 'graph.schedule',
])

const WORKSPACE_READ_ACTIONS = new Set([
  'status', 'graph_overview', 'graph_expand', 'graph_paths', 'graph_resolve',
  'list_explorations', 'get_exploration', 'policy_get', 'memory_page', 'learning_page',
  'review_page', 'get_memory', 'trace_summary', 'source_status', 'current_sources',
  'identity_split_preview', 'identity_status', 'rule_page', 'rule_evaluation',
])

export function isMemoryWebOpReadOnly(op: string, args: Record<string, unknown>): boolean {
  if (READ_ONLY_MEMORY_WEB_OPS.has(op)) return true
  if (op === 'workspace.request') {
    return WORKSPACE_READ_ACTIONS.has(typeof args.action === 'string' ? args.action : '')
  }
  if (op === 'memory.guardrails.run') return args.apply !== true
  return false
}

function boundedInt(val: unknown, fallback: number, low: number, high: number): number {
  const n = typeof val === 'number' ? Math.trunc(val) : typeof val === 'string' ? Number.parseInt(val, 10) : fallback
  return Number.isFinite(n) ? Math.min(Math.max(n, low), high) : fallback
}

function cleanText(val: unknown, limit: number): string {
  return String(typeof val === 'string' ? val : '').slice(0, limit).replace(/\n/g, ' ')
}

const LEARNING_KINDS = new Set([
  'captured', 'proposed', 'promotable', 'saved', 'retrieved', 'used', 'checked',
  'dismissed', 'reverted', 'consolidated', 'previewed', 'accepted', 'pruned',
])

function filterLearningKind(val: unknown): string | null {
  if (typeof val !== 'string' || !val || val.length > 160) return null
  const parts = val.split(',').map(s => s.trim()).filter(Boolean)
  return parts.length > 0 && parts.every(p => LEARNING_KINDS.has(p)) ? parts.join(',') : null
}

export type LoopbackFetchFn = (
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
) => Promise<{ status: number; body: Record<string, any> }>

export async function dispatchMemoriesWebOp(
  op: string,
  args: Record<string, unknown>,
  loopbackFetch: LoopbackFetchFn,
  serverVersion = 'unknown',
  /** Tests: an awaited block read just now. Absent (the server): the non-blocking peek below. */
  readNeedsYou?: () => Promise<NeedsYouBlock | null>,
  countUnratedMeetings: () => number | null = defaultUnratedMeetings,
  /** The build after 7.0.46: what to show at once; the reader refreshes in the background past the TTL. */
  peekNeedsYou: () => NeedsYouPeek = () => getNeedsYouReader().peek(),
  now: () => number = Date.now,
): Promise<{ ok: boolean; message: string; details: Record<string, unknown> }> {
  const reply = (ok: boolean, message: string, details: Record<string, unknown> = {}) => ({ ok, message, details })

  switch (op) {
    case 'workspace.request': {
      const r = await loopbackFetch('/api/context/memory/workspace', { method: 'POST', body: args, timeoutMs: 25_000 })
      return r.status === 200
        ? reply(true, 'Memory workspace', r.body)
        : reply(false, r.body.message || r.body.error || `Workspace error (${r.status})`)
    }
    case 'status': {
      // The build after 7.0.46 (lead 22:0x): never wait on the needs-you CLI here. Its read can take 10 s or more on a
      // loaded Mac, and the whole status (and so the page) waited with it. The peek answers at once.
      const peeked: Promise<NeedsYouPeek> = readNeedsYou
        ? readNeedsYou().catch(() => null).then(b => (b ? { state: 'ok' as const, block: b, at: now() } : { state: 'unknown' as const }))
        : Promise.resolve((() => { try { return peekNeedsYou() } catch { return { state: 'unknown' as const } } })())
      const [ctx, health, peek] = await Promise.all([
        loopbackFetch('/api/context/status', { timeoutMs: 10_000 }),
        loopbackFetch('/api/health', { timeoutMs: 5_000 }),
        peeked,
      ])
      const needsYou = peek.state === 'ok' ? peek.block : null
      const c = ctx.body
      const learning = (c.learning ?? {}) as Record<string, any>
      const graph = (c.graph ?? {}) as Record<string, any>
      const memory = (c.memory ?? {}) as Record<string, any>
      const threads = (c.threads ?? {}) as Record<string, any>
      const owner = getOwnerName()
      return reply(true, 'Status refreshed', {
        runtimeState: 'ready',
        installedVersion: health.body.server_version ?? serverVersion,
        ownerName: owner === 'User' ? null : owner,
        contextScriptsDirectory: COS_SCRIPTS_DIR,
        contextAvailable: c.available === true,
        memoryAvailable: memory.available === true,
        memoryTotal: memory.total ?? 0,
        threadsAvailable: threads.available === true,
        threadsTotal: threads.total ?? 0,
        learningAvailable: learning.available === true,
        // Control's count (the gated needs-you list the helper overlays on the Mac), or null
        // when it cannot be read. Never `learning.to_review`: that is an object of counts, and
        // the page rendered it as "To review (NaN)".
        learningToReview: needsYouCount(needsYou),
        // Every item that needs review past the shown cap, by the same predicate: the "of N" in Today's "Next 7 of N".
        learningToReviewTotal: needsYou ? memoryReview.total(needsYou) : null,
        // The build after 7.0.42 (Memories C): the one number for the rail, Today and the page. The two fields above stay
        // for older clients.
        needsYou: computeNeedsYou(needsYou, (() => { try { return countUnratedMeetings() } catch { return null } })(),
          { notSetUp: peek.state === 'not_set_up', ageMs: peek.state === 'ok' ? Math.max(0, now() - peek.at) : null }),
        learningTotal: learning.total ?? 0,
        learningRewardEnabled: needsYou ? needsYou.reward_enabled === true : learning.reward_enabled === true,
        ...(needsYou ? { needs_you: needsYou } : {}),
        graphAvailable: graph.available === true,
        graphIndexState: graph.index_state ?? null,
        graphEntities: graph.entities ?? null,
        graphRelationships: graph.relationships ?? null,
        context: c,
      })
    }
    case 'learning.list': {
      const limit = boundedInt(args.limit, 50, 1, 50)
      const days = boundedInt(args.days, 90, 1, 3650)
      let path = `/api/context/learning?days=${days}&limit=${limit}`
      const kind = filterLearningKind(args.kind)
      if (kind) path += `&kind=${encodeURIComponent(kind)}`
      if (typeof args.sinceTs === 'string' && args.sinceTs) path += `&since_ts=${encodeURIComponent(args.sinceTs)}`
      if (typeof args.sinceEventId === 'string' && args.sinceEventId) path += `&since_event_id=${encodeURIComponent(args.sinceEventId)}`
      const r = await loopbackFetch(path, { timeoutMs: 15_000 })
      if (r.status !== 200) return reply(false, r.body.message || r.body.error || 'Learning unavailable')
      const rows = Array.isArray(r.body.events) ? r.body.events : []
      return reply(true, rows.length === 0 ? 'No learning yet' : `${rows.length} shown`, {
        state: rows.length === 0 ? 'empty' : 'ready',
        events: rows, shown: rows.length, total: r.body.total ?? null,
        nextCursor: r.body.next_cursor ?? null, coverage: r.body.coverage ?? {}, days,
      })
    }
    case 'learning.review': {
      const limit = boundedInt(args.limit, 200, 1, 200)
      const r = await loopbackFetch(`/api/context/learning/review?limit=${limit}`, { timeoutMs: 15_000 })
      if (r.status !== 200) return reply(false, r.body.message || r.body.error || 'Review list unavailable')
      const rows = Array.isArray(r.body.events) ? r.body.events : []
      return reply(true, rows.length === 0 ? 'Nothing to review' : `${rows.length} to review`, {
        state: rows.length === 0 ? 'empty' : 'ready',
        events: rows, shown: rows.length, total: r.body.total ?? null,
        reviewCount: r.body.review_count ?? r.body.total ?? null, coverage: r.body.coverage ?? {},
      })
    }
    case 'learning.event': {
      const r = await loopbackFetch(`/api/context/learning/${encodeURIComponent(cleanText(args.id, 64))}`, { timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, 'Learning event', r.body) : reply(false, r.body.message || r.body.error || 'Not found')
    }
    case 'learning.status': {
      const r = await loopbackFetch('/api/context/learning/status', { timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, 'Learning status', r.body) : reply(false, r.body.message || r.body.error || 'Unavailable')
    }
    case 'learning.decide': {
      const id = cleanText(args.id, 200), decision = cleanText(args.decision, 16), note = cleanText(args.note, 400)
      const r = await loopbackFetch(`/api/context/learning/${encodeURIComponent(id)}/review`, { method: 'POST', body: { decision, note }, timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, decision === 'dismissed' ? 'Proposal dismissed' : 'Proposal restored', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'memories.list': {
      const limit = boundedInt(args.limit, 50, 1, 50)
      const [listRes, ovRes] = await Promise.all([
        loopbackFetch(`/api/memory?limit=${limit}`, { timeoutMs: 15_000 }),
        loopbackFetch('/api/memory/overview', { timeoutMs: 15_000 }).catch(() => ({ status: 503, body: {} as Record<string, any> })),
      ])
      if (listRes.status !== 200) return reply(false, listRes.body.error || 'Memories unavailable')
      const rows = Array.isArray(listRes.body.items) ? listRes.body.items : []
      return reply(true, rows.length === 0 ? 'No memories yet' : `${rows.length} shown`, {
        state: rows.length === 0 ? 'empty' : 'ready',
        memories: rows, shown: rows.length, total: ovRes.body.total ?? rows.length,
        byType: ovRes.body.by_type ?? {}, root: COS_SCRIPTS_DIR,
      })
    }
    case 'memories.search': {
      const q = cleanText(args.q, 160), limit = boundedInt(args.limit, 20, 1, 50)
      const r = await loopbackFetch(`/api/memory/search?q=${encodeURIComponent(q)}&limit=${limit}`, { timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, 'Memory search', r.body) : reply(false, r.body.message || r.body.error || 'Search failed')
    }
    case 'memory.detail': {
      const r = await loopbackFetch(`/api/memory/${encodeURIComponent(cleanText(args.id, 200))}`, { timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, 'Memory detail', r.body) : reply(false, r.body.message || r.body.error || 'Not found')
    }
    case 'memory.review': {
      const id = cleanText(args.id, 200), decision = cleanText(args.decision, 16), note = cleanText(args.note, 400)
      const r = await loopbackFetch(`/api/context/memory/${encodeURIComponent(id)}/review`, { method: 'POST', body: { decision, note }, timeoutMs: 25_000 })
      return r.status === 200 ? reply(true, decision === 'prune' ? 'Memory pruned' : 'Memory accepted', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'memory.guardrails': {
      const r = await loopbackFetch('/api/context/memory-guardrails', { timeoutMs: 20_000 })
      return r.status === 200 ? reply(true, 'Guardrails', r.body) : reply(false, r.body.message || r.body.error || 'Unavailable')
    }
    case 'memory.guardrails.set': {
      const rawPatch = typeof args.patch === 'string' ? args.patch : JSON.stringify(args.patch ?? {})
      let parsedPatch: unknown = {}
      try { parsedPatch = JSON.parse(rawPatch) } catch { return reply(false, 'Invalid guardrails JSON') }
      const r = await loopbackFetch('/api/context/memory-guardrails', { method: 'PUT', body: parsedPatch, timeoutMs: 20_000 })
      return r.status === 200 ? reply(true, 'Guardrails saved', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'memory.guardrails.run': {
      const payload: Record<string, unknown> = { days: boundedInt(args.days, 30, 1, 3650) }
      if (args.apply === true) payload.apply = true
      if (typeof args.llm === 'boolean') payload.llm = args.llm
      const r = await loopbackFetch('/api/context/memory-guardrails/run', { method: 'POST', body: payload, timeoutMs: payload.llm === false ? 75_000 : 410_000 })
      return r.status === 200 ? reply(true, 'Guardrails scan complete', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'profile.owner': {
      const r = await loopbackFetch('/api/context/profile/owner', { timeoutMs: 10_000 })
      return r.status === 200 ? reply(true, 'Owner profile', r.body) : reply(false, 'Unavailable')
    }
    case 'profile.owner.set': {
      const r = await loopbackFetch('/api/context/profile/owner', {
        method: 'POST', body: { owner_name: cleanText(args.name, 120), expected_owner: cleanText(args.expected, 120) }, timeoutMs: 10_000,
      })
      return r.status === 200 ? reply(true, 'Owner profile updated', r.body) : reply(false, r.body.error || 'Failed')
    }
    case 'graph.status': {
      const r = await loopbackFetch('/api/context/graph/status', { timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, 'Knowledge graph status', r.body) : reply(false, r.body.message || r.body.error || 'Unavailable')
    }
    case 'graph.search': {
      const q = cleanText(args.q, 160), limit = boundedInt(args.limit, 30, 1, 30), offset = boundedInt(args.offset, 0, 0, 100_000)
      const r = await loopbackFetch(`/api/context/graph/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`, { timeoutMs: 20_000 })
      if (r.status !== 200) return reply(false, r.body.message || r.body.error || 'Graph search failed')
      const items = Array.isArray(r.body.items) ? r.body.items : []
      return reply(true, items.length === 0 ? 'No matching entities' : 'Lookup ready', {
        state: items.length === 0 ? 'empty' : 'ready', items, count: items.length,
        total: r.body.total ?? null, indexState: r.body.index_state ?? null,
        matcher: r.body.matcher ?? null, window: r.body.window ?? null, offset, limit,
      })
    }
    case 'graph.entity': {
      const id = cleanText(args.id, 200), limit = boundedInt(args.limit, 30, 1, 30), offset = boundedInt(args.offset, 0, 0, 100_000)
      const r = await loopbackFetch(`/api/context/graph/entity?id=${encodeURIComponent(id)}&offset=${offset}&limit=${limit}`, { timeoutMs: 20_000 })
      if (r.status === 404) return reply(true, 'Entity not found', { found: false, index_state: r.body.error === 'index_missing' ? 'missing' : 'ready' })
      return r.status === 200 ? reply(true, 'Entity', r.body) : reply(false, r.body.message || r.body.error || 'Unavailable')
    }
    case 'graph.passages': {
      const limit = boundedInt(args.limit, 5, 1, 5), source = cleanText(args.source, 200), target = cleanText(args.target, 200), entity = cleanText(args.entity, 200)
      const path = source && target
        ? `/api/context/graph/passages?relationA=${encodeURIComponent(source)}&relationB=${encodeURIComponent(target)}&limit=${limit}`
        : `/api/context/graph/passages?entity=${encodeURIComponent(entity)}&limit=${limit}`
      const r = await loopbackFetch(path, { timeoutMs: 20_000 })
      return r.status === 200 ? reply(true, 'Passages ready', r.body) : reply(false, r.body.message || r.body.error || 'Unavailable')
    }
    case 'graph.build': {
      const r = await loopbackFetch('/api/context/graph/index', { method: 'POST', timeoutMs: 15_000 })
      return r.status === 202 || r.status === 200 ? reply(true, 'Index build started', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.ingest': {
      const r = await loopbackFetch('/api/context/graph/ingest', { method: 'POST', body: { limit: boundedInt(args.limit, 10, 1, 50) }, timeoutMs: 25_000 })
      return r.status === 202 || r.status === 200 ? reply(true, 'Indexing started', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.progress': {
      const r = await loopbackFetch('/api/context/graph/ingest/progress', { timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, 'Ingest progress', r.body) : reply(false, r.body.message || r.body.error || 'Unavailable')
    }
    case 'graph.setup': {
      const r = await loopbackFetch('/api/context/graph/setup', { timeoutMs: 25_000 })
      return r.status === 200 ? reply(true, 'Knowledge setup', r.body) : reply(false, r.body.message || r.body.error || 'Unavailable')
    }
    case 'graph.setup.sources': {
      const r = await loopbackFetch('/api/context/graph/setup/sources', { method: 'POST', body: { action: cleanText(args.action, 16), path: cleanText(args.path, 1000) }, timeoutMs: 20_000 })
      return r.status === 200 ? reply(true, 'Sources updated', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.setup.owner': {
      const r = await loopbackFetch('/api/context/graph/setup/owner', { method: 'POST', body: {}, timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, 'This Mac is now the ingestion owner', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.sample': {
      const r = await loopbackFetch('/api/context/graph/setup/sample', { method: 'POST', body: { limit: boundedInt(args.limit, 3, 1, 3) }, timeoutMs: 95_000 })
      return r.status === 202 || r.status === 200 ? reply(true, 'Sample indexing started', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.ask': {
      const r = await loopbackFetch('/api/context/graph/ask', { method: 'POST', body: { q: cleanText(args.q, 400) }, timeoutMs: 160_000 })
      return r.status === 200 ? reply(true, 'Answered', r.body) : reply(false, r.body.message || r.body.error || 'Graph question failed')
    }
    case 'graph.setup.embedding': {
      const payload: Record<string, unknown> = {}
      if (typeof args.provider === 'string' && args.provider) payload.provider = cleanText(args.provider, 24)
      if (typeof args.local_only === 'boolean') payload.local_only = args.local_only
      if (typeof args.model === 'string' && args.model) payload.model = cleanText(args.model, 120)
      if (args.fetch === true) payload.fetch = true
      const r = await loopbackFetch('/api/context/graph/setup/embedding', { method: 'POST', body: payload, timeoutMs: 95_000 })
      return r.status === 200 ? reply(true, 'Embedding updated', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.setup.extraction': {
      const r = await loopbackFetch('/api/context/graph/setup/extraction', { method: 'POST', body: { tier: cleanText(args.tier, 16) }, timeoutMs: 20_000 })
      return r.status === 200 ? reply(true, 'Extraction updated', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.schedule': {
      const r = await loopbackFetch('/api/context/graph/setup/schedule', { method: 'POST', body: { enabled: args.enabled === true, interval_s: boundedInt(args.intervalS, 3600, 900, 86_400) }, timeoutMs: 25_000 })
      return r.status === 200 ? reply(true, 'Schedule updated', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.merge.preview': {
      const r = await loopbackFetch('/api/context/graph/merge/preview', { method: 'POST', body: { source: cleanText(args.source, 200), target: cleanText(args.target, 200) }, timeoutMs: 25_000 })
      return r.status === 200 ? reply(true, 'Preview ready', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.merge': {
      const source = cleanText(args.source, 200), target = cleanText(args.target, 200)
      const payload: Record<string, unknown> = { source, target, confirm: args.confirm === true }
      if (args.rule && typeof args.rule === 'object') payload.rule = args.rule
      const r = await loopbackFetch('/api/context/graph/merge', { method: 'POST', body: payload, timeoutMs: 25_000 })
      return r.status === 202 || r.status === 200 ? reply(true, `Merging ${source} into ${target}`, r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'graph.merge.status': {
      const r = await loopbackFetch('/api/context/graph/merge', { timeoutMs: 15_000 })
      return r.status === 200 ? reply(true, 'Merge status', r.body) : reply(false, r.body.message || r.body.error || 'Unavailable')
    }
    case 'graph.duplicates': {
      const r = await loopbackFetch(`/api/context/graph/duplicates?limit=${boundedInt(args.limit, 25, 1, 100)}`, { timeoutMs: 35_000 })
      return r.status === 200 ? reply(true, 'Duplicates ready', r.body) : reply(false, r.body.message || r.body.error || 'Failed')
    }
    case 'cues.summary': {
      // Control's CueVerdicts.summary: the cue history read is the capability check. A 200 in the v1 contract means the
      // server keeps the cue log and verdicts, and COS Control Web rates them in Memories (Cues to rate, Rated cues), so
      // the answer is available with the week's counts; anything else is unavailable and the entries hide.
      const r = await loopbackFetch('/api/live-cues/history?days=7&unrated=1&limit=1', { timeoutMs: 10_000 })
      const counts = (r.status === 200 && r.body.v === 1 ? r.body.counts ?? null : null) as Record<string, any> | null
      if (!counts || typeof counts.unrated !== 'number' || typeof counts.rated !== 'number' || typeof counts.total !== 'number') {
        return reply(true, 'Cues', { available: false })
      }
      return reply(true, 'Cues', { available: true, unrated: counts.unrated, rated: counts.rated, total: counts.total })
    }
    case 'copy':
      return reply(true, 'Copied', {})
    default:
      return reply(false, `This page cannot ask for ${op}.`, {})
  }
}
