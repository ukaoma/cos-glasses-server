// Session hooks: status, install, uninstall, and today's runs.
//
// `GET /api/session-hooks/status` is what Control's banner keys off. Five outcomes on
// the client side and this route owns three of them: 200 with `installed` (no banner),
// 200 with `drift`, `missing`, `script_outdated`, `settings_*` (banner with Install). A
// 404 means a server older than 6.48.0 (`route_absent`), and no answer at all is
// `unreachable`; neither is "not installed", and Control must never say so for them.

import { Router } from 'express'
import { installClaudeHooks, uninstallClaudeHooks } from '../lib/claude-hooks-installer.js'
import { deskIdleSeconds, invalidateHookStatus, sessionHooksHealthFields, sessionSignalStore } from '../lib/session-hooks-runtime.js'
import { workspaceFromCwd } from '../lib/claude-session-registry.js'

export function createSessionHooksRouter(options: { port: number }): Router {
  const router = Router()

  router.get('/session-hooks/status', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    res.json({ ok: true, ...sessionHooksHealthFields() })
  })

  router.post('/session-hooks/install', (req, res) => {
    const dryRun = req.query.dryRun === '1' || (req.body && typeof req.body === 'object' && (req.body as { dryRun?: unknown }).dryRun === true)
    const result = installClaudeHooks({ port: options.port, deskIdleSeconds: deskIdleSeconds(), dryRun })
    invalidateHookStatus()
    if (!result.ok) {
      res.status(409).json({ ok: false, reason: result.reason ?? 'install_failed', status: result.status })
      return
    }
    res.json({ ok: true, changed: result.changed, scriptCopied: result.scriptCopied, backupPath: result.backupPath, status: result.status, ...(dryRun ? { merged: result.merged } : {}) })
  })

  router.post('/session-hooks/uninstall', (req, res) => {
    const dryRun = req.query.dryRun === '1'
    const result = uninstallClaudeHooks({ dryRun })
    invalidateHookStatus()
    if (!result.ok) {
      res.status(409).json({ ok: false, reason: result.reason ?? 'uninstall_failed', status: result.status })
      return
    }
    res.json({ ok: true, changed: result.changed, backupPath: result.backupPath, status: result.status, ...(dryRun ? { merged: result.merged } : {}) })
  })

  // Sessions the hooks saw start and end, for Control's scheduled-job ledger. A run
  // shorter than the pet's 20 s poll is recorded here where the poll never saw it.
  router.get('/session-hooks/runs', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const since = Number(req.query.since)
    const sinceMs = Number.isFinite(since) && since > 0 ? since : Date.now() - 24 * 60 * 60_000
    const runs: Array<Record<string, unknown>> = []
    for (const signal of sessionSignalStore.snapshot()) {
      if (signal.firstSeenAt < sinceMs && !(signal.ended && signal.ended.at >= sinceMs)) continue
      runs.push({
        session_id: signal.sessionId,
        started_at: new Date(signal.firstSeenAt).toISOString(),
        ended_at: signal.ended ? new Date(signal.ended.at).toISOString() : null,
        end_reason: signal.ended?.reason ?? null,
        // The registry route reduces cwd to a workspace name on the wire; so does this one.
        workspace: workspaceFromCwd(signal.cwd),
        keep_warm: signal.keepWarm,
        child_events: signal.childEvents,
        last_reply: signal.lastReply || null,
      })
    }
    runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
    res.json({ ok: true, runs, since: new Date(sinceMs).toISOString() })
  })

  return router
}
