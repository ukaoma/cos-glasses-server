// Transcript cleanup routes (6.77.0). Token-authenticated by the global /api X-Cos-Token
// middleware (index.ts) like every other /api route; nothing here is public.
//
// Settings (COS Control's toggle, later):
//   GET  /transcript-cleanup/settings                  { enabled, source, model, modelSource, limits, today }
//   POST /transcript-cleanup/settings { enabled?, model? }   same shape; 409 env_forced when env pins the value
// Screen context (COS Control supplies on-screen text during a meeting, later):
//   POST   /meeting/:sessionId/screen-context { lines: [{ at, text, app? }] }  counts of what was stored
//   GET    /meeting/:sessionId/screen-context            counts only, never the text
//   DELETE /meeting/:sessionId/screen-context            { deleted }
// The cleanup ledger of one meeting:
//   GET  /meeting/:sessionId/transcript-cleanup          { runs, edits }  (edits carry original and replacement words)
//   POST /meeting/:sessionId/transcript-cleanup/undo { editId } | { runId }
// Dictionary suggestions (COS Control's Dictionary tab, later):
//   GET  /transcript-cleanup/suggestions?status=pending|all
//   POST /transcript-cleanup/suggestions/:id/accept { correction? }
//   POST /transcript-cleanup/suggestions/:id/dismiss

import { Router } from 'express'
import { appendScreenContext, deleteScreenContext, ScreenContextError, SESSION_ID, screenContextStats } from '../lib/transcript-cleanup-screen.js'
import { alreadyCleaned, ledgerView, readLedger, readTranscriptSection, sha256, undoCleanupEdits } from '../lib/transcript-cleanup-ledger.js'
import { cleanupLimits, resolveCleanupModel, resolveCleanupSwitch, transcriptCleanupBudget, transcriptCleanupSettings, type TranscriptCleanupBudget, type TranscriptCleanupSettings } from '../lib/transcript-cleanup-state.js'
import { SUGGESTION_ID, suggestionStore, type DictionarySuggestion, type SuggestionStore } from '../lib/transcript-cleanup-suggestions.js'
import { getVocabulary } from '../lib/profile.js'
import { readFileSync } from 'node:fs'

export const TRANSCRIPT_CLEANUP_PROTOCOL = 1

type GlossaryOutcome = { status: number; body: unknown }

export interface TranscriptCleanupRouteDeps {
  env?: NodeJS.ProcessEnv
  now?: () => Date
  settings?: TranscriptCleanupSettings
  budget?: TranscriptCleanupBudget
  suggestions?: SuggestionStore
  /** 'active' while the meeting is being recorded. */
  sessionState?: (sessionId: string) => 'active' | 'closed' | 'missing'
  sessionStartedAt?: (sessionId: string) => number | null
  /** The saved meeting's files, or null. */
  findMeeting?: (sessionId: string) => { meetingPath: string; sidecarPath: string } | null
  addVocabulary?: (term: string) => Promise<GlossaryOutcome>
  learnCorrection?: (body: { heard: string; written: string; source: 'meeting' }) => Promise<GlossaryOutcome>
  vocabulary?: () => string[]
}

/** Health and capability shape. Codes only: /api/health is public. */
export function transcriptCleanupAdvertised(env: NodeJS.ProcessEnv = process.env, settings: TranscriptCleanupSettings = transcriptCleanupSettings()): { protocol: number; enabled: boolean } {
  let enabled = false
  try { enabled = resolveCleanupSwitch(env, settings).enabled } catch { enabled = false }
  return { protocol: TRANSCRIPT_CLEANUP_PROTOCOL, enabled }
}

function suggestionView(s: DictionarySuggestion, vocabulary: string[]): DictionarySuggestion & { inVocabulary: boolean } {
  const lower = s.written.trim().toLowerCase()
  return { ...s, inVocabulary: vocabulary.some(v => v.trim().toLowerCase() === lower) }
}

export function createTranscriptCleanupRouter(deps: TranscriptCleanupRouteDeps = {}): Router {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const settings = deps.settings ?? transcriptCleanupSettings()
  const budget = deps.budget ?? transcriptCleanupBudget()
  const suggestions = deps.suggestions ?? suggestionStore()
  const sessionState = deps.sessionState ?? (() => 'missing' as const)
  const sessionStartedAt = deps.sessionStartedAt ?? (() => null)
  const findMeeting = deps.findMeeting ?? (() => null)
  const vocabulary = deps.vocabulary ?? (() => { try { return getVocabulary() } catch { return [] } })
  const addVocabulary = deps.addVocabulary ?? (async term => (await import('./glossary.js')).glossaryAddVocabulary(term))
  const learnCorrection = deps.learnCorrection ?? (async body => (await import('./glossary.js')).glossaryLearnCorrection(body))
  const router = Router()

  const settingsView = () => {
    const sw = resolveCleanupSwitch(env, settings)
    const model = resolveCleanupModel(env, settings)
    const limits = cleanupLimits(env)
    const state = budget.read()
    return {
      protocol: TRANSCRIPT_CLEANUP_PROTOCOL,
      enabled: sw.enabled,
      source: sw.source,
      model: model.choice,
      modelId: model.id,
      modelSource: model.source,
      limits: { dailyCalls: limits.dailyCalls, dailyTokens: limits.dailyTokens, maxSpansPerMeeting: limits.maxSpans },
      today: {
        calls: Math.min(state.calls, Number.MAX_SAFE_INTEGER),
        tokens: Math.min(state.tokens, Number.MAX_SAFE_INTEGER),
        breakerOpenUntil: state.breakerOpenUntil !== null && state.breakerOpenUntil > now().getTime() ? new Date(state.breakerOpenUntil).toISOString() : null,
      },
    }
  }

  router.get('/transcript-cleanup/settings', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    try { return res.json(settingsView()) } catch { return res.status(503).json({ error: 'settings_unavailable' }) }
  })

  router.post('/transcript-cleanup/settings', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const body = req.body as { enabled?: unknown; model?: unknown } | undefined
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'invalid_request' })
    const hasEnabled = body.enabled !== undefined, hasModel = body.model !== undefined
    if ((!hasEnabled && !hasModel) || (hasEnabled && typeof body.enabled !== 'boolean') || (hasModel && body.model !== 'haiku' && body.model !== 'sonnet')) {
      return res.status(400).json({ error: 'invalid_request' })
    }
    if (hasEnabled && (env.COS_TRANSCRIPT_CLEANUP === '1' || env.COS_TRANSCRIPT_CLEANUP === '0') && body.enabled !== (env.COS_TRANSCRIPT_CLEANUP === '1')) {
      return res.status(409).json({ error: 'env_forced' })
    }
    if (hasModel && (env.COS_TRANSCRIPT_CLEANUP_MODEL === 'haiku' || env.COS_TRANSCRIPT_CLEANUP_MODEL === 'sonnet') && body.model !== env.COS_TRANSCRIPT_CLEANUP_MODEL) {
      return res.status(409).json({ error: 'env_forced' })
    }
    try {
      settings.save({ ...(hasEnabled ? { enabled: body.enabled as boolean } : {}), ...(hasModel ? { model: body.model as 'haiku' | 'sonnet' } : {}) }, now())
      return res.json(settingsView())
    } catch {
      return res.status(500).json({ error: 'settings_write_failed' })
    }
  })

  const sessionParam = (raw: string | undefined): string | null => (raw && SESSION_ID.test(raw) ? raw : null)

  /** A late flush right after stop is welcome until the cleanup has run on the saved meeting. */
  function screenAdmission(sessionId: string): { ok: true } | { ok: false; status: number; error: string } {
    if (sessionState(sessionId) === 'active') return { ok: true }
    const meeting = findMeeting(sessionId)
    if (!meeting) return { ok: false, status: 404, error: 'unknown_session' }
    const done = readLedger(sessionId).rows.some(r => r.kind === 'run' && (r.phase === 'done' || r.phase === 'skipped'))
    return done ? { ok: false, status: 409, error: 'cleanup_done' } : { ok: true }
  }

  router.post('/meeting/:sessionId/screen-context', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = sessionParam(req.params.sessionId)
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' })
    const admission = screenAdmission(sessionId)
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error })
    try {
      const result = appendScreenContext(sessionId, req.body, { now: now().getTime(), sessionStartedAt: sessionStartedAt(sessionId) })
      return res.json({ ok: true, protocol: TRANSCRIPT_CLEANUP_PROTOCOL, ...result })
    } catch (error) {
      if (error instanceof ScreenContextError) return res.status(error.status).json({ error: error.code })
      return res.status(503).json({ error: 'screen_context_unavailable' })
    }
  })

  router.get('/meeting/:sessionId/screen-context', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = sessionParam(req.params.sessionId)
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' })
    return res.json({ protocol: TRANSCRIPT_CLEANUP_PROTOCOL, ...screenContextStats(sessionId) })
  })

  router.delete('/meeting/:sessionId/screen-context', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = sessionParam(req.params.sessionId)
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' })
    try { return res.json({ deleted: deleteScreenContext(sessionId) }) } catch { return res.status(500).json({ error: 'delete_failed' }) }
  })

  router.get('/meeting/:sessionId/transcript-cleanup', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = sessionParam(req.params.sessionId)
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' })
    const view = ledgerView(sessionId)
    let current: string | null = null
    const meeting = findMeeting(sessionId)
    if (meeting) {
      try { const section = readTranscriptSection(readFileSync(meeting.meetingPath, 'utf8')); current = section === null ? null : sha256(section) } catch { current = null }
    }
    return res.json({ protocol: TRANSCRIPT_CLEANUP_PROTOCOL, ...view, cleanedCurrent: current !== null && alreadyCleaned(sessionId, current) })
  })

  router.post('/meeting/:sessionId/transcript-cleanup/undo', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = sessionParam(req.params.sessionId)
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' })
    const body = (req.body ?? {}) as { editId?: unknown; runId?: unknown }
    const editId = typeof body.editId === 'string' && /^te_[0-9a-f]{16}$/.test(body.editId) ? body.editId : undefined
    const runId = typeof body.runId === 'string' && /^tc_[0-9a-f]{16}$/.test(body.runId) ? body.runId : undefined
    if (!editId === !runId) return res.status(400).json({ error: 'editId_or_runId_required' })
    const meeting = findMeeting(sessionId)
    if (!meeting) return res.status(404).json({ error: 'meeting_missing' })
    const result = undoCleanupEdits({ sessionId, meetingPath: meeting.meetingPath, sidecarPath: meeting.sidecarPath, editId, runId, now })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    return res.json({ reverted: result.reverted })
  })

  router.get('/transcript-cleanup/suggestions', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending'
    if (status !== 'pending' && status !== 'all') return res.status(400).json({ error: 'invalid_status' })
    const vocab = vocabulary()
    const list = suggestions.list().filter(s => status === 'all' || s.status === 'pending')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(s => suggestionView(s, vocab))
    return res.json({ protocol: TRANSCRIPT_CLEANUP_PROTOCOL, suggestions: list })
  })

  router.post('/transcript-cleanup/suggestions/:id/accept', async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const id = req.params.id
    if (!SUGGESTION_ID.test(id)) return res.status(400).json({ error: 'invalid_suggestion_id' })
    const body = (req.body ?? {}) as { correction?: unknown }
    if (body.correction !== undefined && typeof body.correction !== 'boolean') return res.status(400).json({ error: 'invalid_request' })
    const suggestion = suggestions.get(id)
    if (!suggestion) return res.status(404).json({ error: 'suggestion_not_found' })
    if (suggestion.status === 'dismissed') return res.status(409).json({ error: 'suggestion_dismissed' })
    try {
      const heard = suggestion.heard.find(h => h.trim().toLowerCase() !== suggestion.written.trim().toLowerCase())
      const outcome = body.correction === true && heard
        ? await learnCorrection({ heard, written: suggestion.written, source: 'meeting' })
        : await addVocabulary(suggestion.written)
      if (outcome.status !== 200) return res.status(outcome.status).json(outcome.body)
      const accepted = suggestions.setStatus(id, 'accepted', now().toISOString()) ?? suggestion
      const out = outcome.body as { unchanged?: boolean; glossary?: unknown; entry?: unknown }
      return res.json({ suggestion: suggestionView(accepted, vocabulary()), unchanged: out.unchanged === true, glossary: out.glossary ?? null, entry: out.entry ?? null })
    } catch {
      return res.status(500).json({ error: 'accept_failed' })
    }
  })

  router.post('/transcript-cleanup/suggestions/:id/dismiss', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const id = req.params.id
    if (!SUGGESTION_ID.test(id)) return res.status(400).json({ error: 'invalid_suggestion_id' })
    try {
      const dismissed = suggestions.setStatus(id, 'dismissed', now().toISOString())
      if (!dismissed) return res.status(404).json({ error: 'suggestion_not_found' })
      return res.json({ suggestion: suggestionView(dismissed, vocabulary()) })
    } catch {
      return res.status(500).json({ error: 'dismiss_failed' })
    }
  })

  return router
}

