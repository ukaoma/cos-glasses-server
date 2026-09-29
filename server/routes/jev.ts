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
import { listBoard } from '../lib/task-store.js'
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
}

export function createJevRouter(overrides: Partial<JevRouteDependencies> = {}): Router {
  const jev = overrides.jev ?? sharedJevClient()
  const deps: JevRouteDependencies = { jev, recommender: new SessionRecommender(jev), list: listBoard, validate: validateJevKey, save: saveJevKey, ...overrides }
  const router = Router()
  router.use(['/jev-key', '/work-board/session-recommendation'], (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })

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
        return res.status(400).json({ error: { code: 'invalid_recommendation_request', message: 'Select an exact meeting review and send at most 80 sessions.' } })
      }
      if (!deps.review) return res.status(404).json({ error: { code: 'reviews_unavailable', message: 'Meeting reviews are not available on this server.' } })
      try {
        const review = await deps.review(body.reviewId).catch(() => null)
        if (!review) return res.status(404).json({ error: { code: 'review_not_found', message: 'That meeting review changed or was removed. Refresh Work.' } })
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
      // Work identity first: it survives a rename, while a new card's id could equal an old identity's text hash.
      const rows = (await deps.list()).filter(r => r.domain === body.domain)
      const row = rows.find(r => r.workIdentity === body.id) ?? rows.find(r => r.id === body.id)
      if (!row) return res.status(404).json({ error: { code: 'task_not_found', message: 'That task changed or was removed. Refresh Work.' } })
      const meetings = (row.meetingRefs ?? []).map(ref => ref.title ?? '').filter(Boolean)
      return res.json(await deps.recommender.recommend({ task: { text: row.text || row.title || '', domain: row.domain, meetings }, sessions }))
    } catch (e) {
      console.error('[jev] session recommendation failed:', e instanceof Error ? e.message : e)
      return res.json({ provider: 'none', reason: 'recommendation_unavailable' })  // advice only: never block the workspace
    }
  })
  return router
}
