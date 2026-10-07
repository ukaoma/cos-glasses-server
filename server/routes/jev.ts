/**
 * Jev key management (COS Control Settings) and Work session recommendations. Auth comes from the parent /api mount.
 *
 * The key is push-only, like /api/openai-key: validated live against TypeSafe's free model listing, saved to
 * data/jev-key.json (0600), and never returned to any client. The saved key wins over TYPESAFE_API_KEY in the
 * environment (see resolveJevKey); /status says which source is active so Control can show it honestly.
 */
import { Router } from 'express'
import { existsSync, unlinkSync } from 'node:fs'
import { JEV_KEY_FILE, saveJevKey, sharedJevClient, validateJevKey, type JevClient } from '../lib/jev.js'
import { SessionRecommender, parseCandidates } from '../lib/session-recommendation.js'
import { CompletionChecker, readRepliesSince } from '../lib/work-completion.js'
import { isSafeSessionId, type AgentProvider } from '../lib/agent-session-store.js'
import { listBoard } from '../lib/task-store.js'
import { sharedWorkSearchJevClient } from '../lib/work-search.js'
import { isSafeDomainName } from '../lib/domains.js'

/** What the route reads from a meeting review (6.57.1): the server's own record, never client text. */
export interface ReviewForAdvice { source: { title: string; domain: string }; markdown?: string }

export interface JevRouteDependencies {
  jev: JevClient
  recommender: Pick<SessionRecommender, 'recommend'>
  list: typeof listBoard
  validate: typeof validateJevKey
  save: typeof saveJevKey
  /** Looks a meeting review up by its `wr_` id; throws or returns null when it does not exist. Absent when reviews are off. */
  review?: (id: string) => Promise<ReviewForAdvice | null>
  /** 6.58.0: Jev's reading of a reply against a task's Done when. */
  completion: Pick<CompletionChecker, 'check'>
  /** 6.58.0: a session's replies since a time (or its newest reply) from this server's transcripts; null when the
   *  session is not on this Mac. */
  replies: (provider: AgentProvider, sessionId: string, afterMs: number | null) => Promise<string | null>
  /** 6.65.0: Work search keeps its own client and breaker; a newly saved key clears that breaker too. */
  searchJev: Pick<JevClient, 'resetForNewKey'>
}

/** Work identity first: it survives a rename, while a new card's id could equal an old identity's text hash. */
function findTask<T extends { id: string; workIdentity?: string }>(rows: T[], id: string): T | undefined {
  return rows.find(r => r.workIdentity === id) ?? rows.find(r => r.id === id)
}

export function createJevRouter(overrides: Partial<JevRouteDependencies> = {}): Router {
  const jev = overrides.jev ?? sharedJevClient()
  const deps: JevRouteDependencies = { jev, recommender: new SessionRecommender(jev), list: listBoard, validate: validateJevKey, save: saveJevKey,
    completion: new CompletionChecker(jev), replies: (provider, sessionId, afterMs) => readRepliesSince(provider, sessionId, afterMs),
    searchJev: sharedWorkSearchJevClient(), ...overrides }
  const router = Router()
  router.use(['/jev-key', '/work-board/session-recommendation', '/work-board/completion-check'], (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })

  router.get('/jev-key/status', (_req, res) => res.json(deps.jev.status()))

  router.post('/jev-key/set', async (req, res) => {
    const raw = req.body?.key
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(k => k !== 'key') || typeof raw !== 'string') {
      return res.status(400).json({ error: { code: 'invalid_jev_key', message: 'Paste a TypeSafe API key.' } })
    }
    const key = raw.trim()
    if (key.length < 16 || key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key)) {
      return res.status(400).json({ error: { code: 'invalid_jev_key', message: 'That does not look like a TypeSafe API key.' } })
    }
    const check = await deps.validate(key)
    if (!check.ok) return res.status(400).json({ error: { code: 'jev_key_not_accepted', message: check.reason, upstreamStatus: check.status } })
    try { deps.save(key) } catch {
      return res.status(500).json({ error: { code: 'jev_key_not_saved', message: 'The key was valid but could not be saved. Check the server data folder.' } })
    }
    deps.jev.resetForNewKey()
    deps.searchJev.resetForNewKey()
    return res.json({ ok: true, ...deps.jev.status() })
  })

  router.delete('/jev-key', (_req, res) => {
    try { if (existsSync(JEV_KEY_FILE)) unlinkSync(JEV_KEY_FILE) } catch {
      return res.status(500).json({ error: { code: 'jev_key_not_removed', message: 'The saved key could not be removed.' } })
    }
    return res.json({ ok: true, ...deps.jev.status() })
  })

  /** Continue / Fork / New for one task or meeting review. The work comes from the board or the review store; the
   *  client sends only candidate sessions. */
  router.post('/work-board/session-recommendation', async (req, res) => {
    const body = req.body
    const sessions = parseCandidates(body?.sessions)
    const keys = body && typeof body === 'object' ? Object.keys(body).sort().join(',') : ''
    // 6.57.1: a meeting review is named by its id alone (`{reviewId, sessions}`), exactly.
    if (keys === 'reviewId,sessions') {
      if (typeof body.reviewId !== 'string' || !/^wr_[a-f0-9]{32}$/.test(body.reviewId) || !sessions) {
        // Its own code: 6.57.0 answers a review body with invalid_recommendation_request, and Control reads THAT as an old server.
        return res.status(400).json({ error: { code: 'invalid_review_request', message: 'Select an exact meeting review and send at most 80 sessions.' } })
      }
      if (!deps.review) return res.status(404).json({ error: { code: 'reviews_unavailable', message: 'Meeting reviews are not available on this server.' } })
      let review: ReviewForAdvice | null
      try { review = await deps.review(body.reviewId) } catch (e) {  // defensive: the stock lookup reads memory and does not throw
        console.error('[jev] review lookup failed:', e instanceof Error ? e.message : e)
        return res.status(503).json({ error: { code: 'review_store_unavailable', message: 'Meeting reviews could not be read. Try again shortly.' } })
      }
      if (!review) return res.status(404).json({ error: { code: 'review_not_found', message: 'That meeting review changed or was removed. Refresh Work.' } })
      try {
        const title = review.source.title || 'Meeting follow-up'
        return res.json(await deps.recommender.recommend({
          task: { text: [title, review.markdown ?? ''].filter(Boolean).join('\n\n'), domain: review.source.domain, meetings: [title] }, sessions }))
      } catch (e) {
        console.error('[jev] session recommendation failed:', e instanceof Error ? e.message : e)
        return res.json({ provider: 'none', reason: 'recommendation_unavailable' })
      }
    }
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['domain', 'id', 'sessions'].includes(k))
      || typeof body.domain !== 'string' || !isSafeDomainName(body.domain) || typeof body.id !== 'string' || !/^[a-f0-9]{12}$/.test(body.id) || !sessions) {
      return res.status(400).json({ error: { code: 'invalid_recommendation_request', message: 'Select an exact task and send at most 80 sessions.' } })
    }
    try {
      const rows = (await deps.list()).filter(r => r.domain === body.domain)
      const row = findTask(rows, body.id)
      if (!row) return res.status(404).json({ error: { code: 'task_not_found', message: 'That task changed or was removed. Refresh Work.' } })
      const meetings = (row.meetingRefs ?? []).map(ref => ref.title ?? '').filter(Boolean)
      return res.json(await deps.recommender.recommend({ task: { text: row.text || row.title || '', domain: row.domain, meetings }, sessions }))
    } catch (e) {
      console.error('[jev] session recommendation failed:', e instanceof Error ? e.message : e)
      return res.json({ provider: 'none', reason: 'recommendation_unavailable' })  // advice only: never block the workspace
    }
  })
  /** 6.58.0 (Control 0.5.247): did a session finish a board task? Asked when the session's newest reply since the
   *  handoff has no status line and the session is idle. The task comes from the board and the replies from this
   *  server's transcripts; the client sends names and, optionally, `after` (judge replies from then on). An answer is
   *  advice: Control moves a card to QA only on a confident done, never to Complete. */
  router.post('/work-board/completion-check', async (req, res) => {
    const body = req.body
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).filter(k => k !== 'after').sort().join(',') : ''
    const afterMs = body?.after === undefined ? null : typeof body.after === 'string' && body.after.length <= 40 ? Date.parse(body.after) : Number.NaN
    if (keys !== 'domain,id,provider,sessionId' || Number.isNaN(afterMs)
      || typeof body.domain !== 'string' || !isSafeDomainName(body.domain) || typeof body.id !== 'string' || !/^[a-f0-9]{12}$/.test(body.id)
      || !['claude', 'codex', 'cursor'].includes(body.provider) || typeof body.sessionId !== 'string' || !isSafeSessionId(body.sessionId)) {
      return res.status(400).json({ error: { code: 'invalid_completion_request', message: 'Select an exact task and session.' } })
    }
    try {
      const rows = (await deps.list()).filter(r => r.domain === body.domain)
      const row = findTask(rows, body.id)
      if (!row) return res.status(404).json({ error: { code: 'task_not_found', message: 'That task changed or was removed. Refresh Work.' } })
      const reply = await deps.replies(body.provider as AgentProvider, body.sessionId, afterMs)
      if (reply === null) return res.status(404).json({ error: { code: 'session_not_found', message: 'That session is not on this Mac.' } })
      // A task with no Done when (most tasks) is judged against its own text; the answer says which (`basis`).
      return res.json(await deps.completion.check({ task: { text: row.text || row.title || '', doneWhen: (row.doneWhen ?? '').trim() }, reply }))
    } catch (e) {
      console.error('[jev] completion check failed:', e instanceof Error ? e.message : e)
      return res.json({ provider: 'none', reason: 'completion_unavailable' })  // advice only: tracking goes on without it
    }
  })
  return router
}
