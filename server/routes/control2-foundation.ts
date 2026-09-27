import { Router } from 'express'
import { FoundationError, FoundationStore } from '../lib/control2-foundation.js'
import { prepareControl2Draft, type Control2DraftArtifact } from '../lib/control2-draft.js'
import { readFileSync } from 'node:fs'

/** Caller provides authentication. No store is constructed while disabled. */
export function createFoundationRouter(options: { enabled: boolean; root?: string; draftEnabled?: boolean; prepareDraft?: typeof prepareControl2Draft }) {
  const router = Router()
  const store = options.enabled && options.root ? new FoundationStore(options.root) : null
  const present = <T extends { capabilities: object }>(snapshot: T) => ({ ...snapshot, capabilities: { ...snapshot.capabilities, manualDraft: options.draftEnabled === true } })
  router.use('/control2/foundation', (req, res, next) => {
    if (!store) return res.status(404).json({ error: { code: 'foundation_disabled' } })
    const address = req.socket.remoteAddress ?? ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return res.status(403).json({ error: { code: 'loopback_required' } })
    next()
  })
  router.get('/control2/foundation', (_req, res) => {
    try { res.json(present(store!.snapshot())) } catch (e) { fail(res, e) }
  })
  router.post('/control2/foundation/replay', (req, res) => {
    try { res.json(present(store!.replay(req.body))) } catch (e) { fail(res, e) }
  })
  router.post('/control2/foundation/draft', async (req, res) => {
    if (!options.draftEnabled) return res.status(403).json({ error: { code: 'draft_disabled' } })
    const abort = new AbortController()
    let finished = false
    const cancel = () => { if (!finished) abort.abort() }
    req.once('aborted', cancel); res.once('close', cancel)
    let artifact: Control2DraftArtifact | undefined
    try {
      const row = store!.snapshot().work.find(w => w.id === req.body?.workId)
      if (!row || row.status !== 'needs_review') throw new FoundationError('draft_source_unavailable', 409)
      if (row.artifact) { finished = true; return res.json(present(store!.snapshot())) }
      const instruction = 'Prepare short plain-text website preview copy for this synthetic foundation exercise. Do not claim changes were deployed. Source evidence: ' + row.sourceExcerpt + '\nOperator criteria: ' + JSON.stringify(row.criteria)
      if (instruction.length > 4000) throw new FoundationError('draft_criteria_exceed_limit', 409)
      artifact = await (options.prepareDraft ?? prepareControl2Draft)({
        instruction,
        signal: abort.signal,
      })
      if (!artifact.checked || artifact.scope !== 'no-tool-text-draft') throw new FoundationError('draft_unchecked', 409)
      if (abort.signal.aborted) throw new FoundationError('draft_canceled', 409)
      const snapshot = store!.recordDraft(row.id, row.revision, readFileSync(artifact.previewPath, 'utf8'), artifact.sha256)
      finished = true; return res.json(present(snapshot))
    } catch (e) { finished = true; return fail(res, e) }
    finally { req.removeListener('aborted', cancel); res.removeListener('close', cancel); artifact?.dispose() }
  })
  router.post('/control2/foundation/publish', (_req, res) => {
    res.status(403).json({ error: { code: 'publication_not_implemented' } })
  })
  return router
}
function fail(res: import('express').Response, error: unknown) {
  if (error instanceof FoundationError) return res.status(error.status).json({ error: { code: error.code } })
  if (error instanceof Error && /^draft_[a-z_]+$/.test(error.message)) return res.status(409).json({ error: { code: error.message } })
  return res.status(500).json({ error: { code: 'foundation_store_failed' } })
}
