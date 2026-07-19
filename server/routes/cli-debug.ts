import { Router } from 'express'
import { normalizeModelPreference, isClaudeModel } from '../../shared/model-preference.js'
import {
  getClaudeRunConfig,
  listClaudeRuns,
} from '../lib/claude-run-ledger.js'
import {
  getCodexRunConfig,
  listCodexRuns,
} from '../lib/codex-run-ledger.js'
import {
  safeCliDebugResponse,
  safeLegacyClaudeResponse,
  safeLegacyCodexResponse,
} from '../lib/cli-debug-view.js'

export const cliDebugRouter = Router()

function boundedLimit(value: unknown): number {
  const raw = Number(value ?? 20)
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 50) : 20
}

function optionalSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalClaudeModel(value: unknown) {
  const raw = typeof value === 'string' ? normalizeModelPreference(value) : undefined
  return raw && isClaudeModel(raw) ? raw : undefined
}

// Versioned public-safe view consumed by Recovery Center. Global /api auth
// protects this route; it must never be added to the unauthenticated allowlist.
cliDebugRouter.get('/cli/debug', (req, res) => {
  const limit = boundedLimit(req.query.limit)
  const sessionId = optionalSessionId(req.query.sessionId)
  const model = optionalClaudeModel(req.query.model)
  const claudeConfig = getClaudeRunConfig()
  const codexConfig = getCodexRunConfig()
  const claudeRuns = listClaudeRuns(limit, sessionId, model)
  const codexRuns = listCodexRuns(limit, sessionId)
  res.json(safeCliDebugResponse(
    claudeConfig,
    claudeRuns[0],
    codexConfig,
    codexRuns[0],
  ))
})

// Build-210 compatibility. These legacy shapes retain only the fields the old
// panel can render safely; they do not expose raw ledger records.
cliDebugRouter.get('/cli/runs', (req, res) => {
  const limit = boundedLimit(req.query.limit)
  const sessionId = optionalSessionId(req.query.sessionId)
  const model = optionalClaudeModel(req.query.model)
  const config = getClaudeRunConfig()
  res.json(safeLegacyClaudeResponse(config, listClaudeRuns(limit, sessionId, model)))
})

cliDebugRouter.get('/codex/runs', (req, res) => {
  const limit = boundedLimit(req.query.limit)
  const sessionId = optionalSessionId(req.query.sessionId)
  const config = getCodexRunConfig()
  res.json(safeLegacyCodexResponse(config, listCodexRuns(limit, sessionId)))
})
