import { Router } from 'express'
import {
  buildHandoffPromptContext,
  claimHandoff,
  createHandoff,
  getHandoff,
  getLatestHandoff,
  type HandoffCreateInput,
} from '../lib/handoff-store.js'
import { getAvailableCliSessionId } from '../lib/claude-bridge.js'
import { getCodexExecutionCwd, getCodexTrustMode } from '../lib/codex-run-ledger.js'
import { normalizeHandoffCode } from '../../shared/handoff-intent.js'
import { anyKeyedSessions, isKeyedCosSession, isKeyedSession, KEYED_SESSION_REFUSAL } from '../lib/keyed-sessions.js'

export const handoffsRouter = Router()

function runtimeExpiresAt(): string {
  return new Date(Date.now() + 2 * 60 * 60_000).toISOString()
}

/**
 * Key lanes K1 (plan v4 7.1, 7.3): a handoff carries a CLI session id that another surface
 * resumes, on the subscription. One that ran on a key is refused in K1. With no keyed session
 * ever recorded this is one failed stat and the route is the b7c620e one.
 */
function keyedHandoff(body: Record<string, any> | null | undefined, resolvedCliSessionId?: string): boolean {
  if (!anyKeyedSessions()) return false
  const runtime = body?.runtime && typeof body.runtime === 'object' ? body.runtime : {}
  return isKeyedCosSession(body?.sessionId)
    || isKeyedSession(runtime.claude?.cliSessionId)
    || isKeyedSession(runtime.codex?.codexThreadId)
    || isKeyedSession(resolvedCliSessionId)
}

function enrichRuntime(body: Record<string, any>): HandoffCreateInput {
  const input: HandoffCreateInput = { ...body }
  const runtime = body.runtime && typeof body.runtime === 'object' ? { ...body.runtime } : {}

  if (runtime.codex?.codexThreadId) {
    runtime.codex = {
      ...runtime.codex,
      cwd: runtime.codex.cwd ?? getCodexExecutionCwd(),
      trustMode: runtime.codex.trustMode ?? getCodexTrustMode(),
      expiresAt: runtime.codex.expiresAt ?? runtimeExpiresAt(),
    }
  }

  if (runtime.claude?.cliSessionId) {
    runtime.claude = {
      ...runtime.claude,
      expiresAt: runtime.claude.expiresAt ?? runtimeExpiresAt(),
    }
  } else if (typeof body.sessionId === 'string') {
    const cliSessionId = getAvailableCliSessionId(body.sessionId)
    if (cliSessionId) {
      runtime.claude = {
        cliSessionId,
        model: typeof body.model === 'string' ? body.model : undefined,
        expiresAt: runtimeExpiresAt(),
      }
    }
  }

  if (runtime.codex || runtime.claude) input.runtime = runtime
  return input
}

handoffsRouter.post('/handoffs', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const input = enrichRuntime(body)
    if (keyedHandoff(body, (input.runtime as any)?.claude?.cliSessionId)) return res.status(409).json(KEYED_SESSION_REFUSAL)
    const handoff = await createHandoff(input)
    res.status(201).json({ handoff, context: buildHandoffPromptContext(handoff) })
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'handoff create failed' })
  }
})

handoffsRouter.get('/handoffs/latest', async (req, res) => {
  try {
    const handoff = await getLatestHandoff({
      source: typeof req.query.source === 'string' ? req.query.source : undefined,
      target: typeof req.query.target === 'string' ? req.query.target : undefined,
      createdBy: typeof req.query.createdBy === 'string' ? req.query.createdBy : undefined,
      deviceId: typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined,
    })
    if (!handoff) return res.status(404).json({ error: 'handoff not found' })
    res.json({ handoff, context: buildHandoffPromptContext(handoff) })
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'handoff lookup failed' })
  }
})

handoffsRouter.get('/handoffs/:code', async (req, res) => {
  const code = normalizeHandoffCode(req.params.code)
  if (!code) return res.status(404).json({ error: 'handoff not found' })
  try {
    const handoff = await getHandoff(code)
    if (!handoff) return res.status(404).json({ error: 'handoff not found' })
    res.json({ handoff, context: buildHandoffPromptContext(handoff) })
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'handoff lookup failed' })
  }
})

handoffsRouter.post('/handoffs/:code/claim', async (req, res) => {
  const code = normalizeHandoffCode(req.params.code)
  if (!code) return res.status(404).json({ error: 'handoff not found' })
  try {
    const claimedBy = typeof req.body?.claimedBy === 'string' ? req.body.claimedBy : 'unknown'
    // Key lanes: a handoff saved before its session was known to be keyed is not claimed either.
    if (anyKeyedSessions() && keyedHandoff((await getHandoff(code)) as Record<string, any> | null)) {
      return res.status(409).json(KEYED_SESSION_REFUSAL)
    }
    const handoff = await claimHandoff(code, claimedBy)
    if (!handoff) return res.status(404).json({ error: 'handoff not found' })
    res.json({ handoff, context: buildHandoffPromptContext(handoff) })
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'handoff claim failed' })
  }
})
