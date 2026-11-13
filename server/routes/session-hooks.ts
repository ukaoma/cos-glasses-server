import { installCursorObserver } from '../lib/cursor-observer-installer.js'
import { codexPresent, installCodexHooks, uninstallCodexHooks, type CodexInstallResult } from '../lib/codex-hooks-installer.js'
import { refreshAfterInstall } from '../lib/provider-observe.js'
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
import { API_AUTH_BY_LOCAL } from '../lib/api-auth.js'
import { questionHoldMode } from '../lib/full-hold.js'
import { writeQuestionHoldSetting } from '../lib/question-hold-setting.js'
import { workspaceFromCwd } from '../lib/claude-session-registry.js'

/** The registry entrypoints a person sits at; everything else (`sdk-cli`, unknown) may be a job. */
export function isInteractiveEntrypoint(entrypoint: string | null): boolean {
  return entrypoint === 'claude-desktop' || entrypoint === 'cli'
}

/**
 * 6.62.0: the Codex half of install and uninstall, injectable so a test never touches the
 * real `~/.codex`. Defaults are the real installer, gated on Codex being present at all.
 */
export interface SessionHooksCodexDeps {
  present: () => boolean
  install: (options: { dryRun: boolean }) => CodexInstallResult
  uninstall: (options: { dryRun: boolean }) => CodexInstallResult
  /** Re-read the provider hook files (and Codex trust, in the background) after a write. */
  refresh: () => void
}

const realCodexDeps: SessionHooksCodexDeps = {
  present: () => codexPresent(),
  install: options => installCodexHooks(options),
  uninstall: options => uninstallCodexHooks(options),
  refresh: () => refreshAfterInstall(),
}

/**
 * The Codex half, run AFTER Claude's and the observer's and never able to change their answer
 * (B2): a missing Codex is `skipped`, a refusal or a throw is reported in `codex` and the route
 * still answers as Claude's result says.
 */
export function codexHookStep(deps: SessionHooksCodexDeps, action: 'install' | 'uninstall', dryRun: boolean): Record<string, unknown> {
  try {
    if (!deps.present()) return { ok: true, skipped: 'codex_not_present' }
    const result = action === 'install' ? deps.install({ dryRun }) : deps.uninstall({ dryRun })
    return {
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      changed: result.changed,
      backupPath: result.backupPath,
      status: { state: result.status.state, installed: result.status.installed, scriptOk: result.status.scriptOk },
      ...(dryRun && result.merged ? { merged: result.merged } : {}),
    }
  } catch (error) {
    return { ok: false, reason: 'codex_step_threw', detail: error instanceof Error ? error.name : 'error' }
  }
}

export function createSessionHooksRouter(options: { port: number; codex?: SessionHooksCodexDeps }): Router {
  const router = Router()
  const codex = options.codex ?? realCodexDeps

  router.get('/session-hooks/status', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    res.json({ ok: true, ...sessionHooksHealthFields() })
  })

  // X1, 7.0.34: the question hold's server-side setting, for Control's Settings row (Control 0.5.394). Body
  // `{"mode":"on"|"off"|"default"}`; `default` removes the setting. The Mac app only: a browser session is refused
  // (Control Web shows the state read-only). `COS_QUESTION_FULL_HOLD` in the environment wins over the setting, so
  // while it is set nothing is written and the answer says so (409 `set_by_env`). Turning the hold on or off here
  // changes what Reinstall hooks writes; the status's `state` then says whether a Reinstall is due.
  router.put('/session-hooks/question-hold', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    if (res.locals[API_AUTH_BY_LOCAL] !== 'token') { res.status(403).json({ ok: false, reason: 'web_read_only' }); return }
    const mode = req.body && typeof req.body === 'object' ? (req.body as { mode?: unknown }).mode : undefined
    if (mode !== 'on' && mode !== 'off' && mode !== 'default') { res.status(400).json({ ok: false, reason: 'bad_mode' }); return }
    if (questionHoldMode(process.env).source === 'env') {
      res.status(409).json({ ok: false, reason: 'set_by_env', questionWait: sessionHooksHealthFields().sessionHooks.questionWait ?? null })
      return
    }
    try { writeQuestionHoldSetting(mode) } catch { res.status(500).json({ ok: false, reason: 'write_failed' }); return }
    invalidateHookStatus()
    const hooks = sessionHooksHealthFields().sessionHooks
    res.json({ ok: true, questionWait: hooks.questionWait ?? null, state: hooks.state })
  })

  router.post('/session-hooks/install', (req, res) => {
    const dryRun = req.query.dryRun === '1' || (req.body && typeof req.body === 'object' && (req.body as { dryRun?: unknown }).dryRun === true)
    const result = installClaudeHooks({ port: options.port, deskIdleSeconds: deskIdleSeconds(), dryRun })
    invalidateHookStatus()
    if (!result.ok) {
      res.status(409).json({ ok: false, reason: result.reason ?? 'install_failed', status: result.status })
      return
    }
    const cursorObserver = installCursorObserver({ dryRun })
    const codexStep = codexHookStep(codex, 'install', dryRun)
    if (!dryRun) { try { codex.refresh() } catch { /* health catches up on its own tick */ } }
    if (!cursorObserver.ok) { res.status(409).json({ ok: false, reason: 'cursor_observer_install_failed', cursorObserver, codex: codexStep, status: result.status }); return }
    res.json({ ok: true, cursorObserver, codex: codexStep, changed: result.changed || cursorObserver.changed, scriptCopied: result.scriptCopied, backupPath: result.backupPath, status: result.status, ...(dryRun ? { merged: result.merged } : {}) })
  })

  router.post('/session-hooks/uninstall', (req, res) => {
    const dryRun = req.query.dryRun === '1'
    const result = uninstallClaudeHooks({ dryRun })
    invalidateHookStatus()
    if (!result.ok) {
      res.status(409).json({ ok: false, reason: result.reason ?? 'uninstall_failed', status: result.status })
      return
    }
    const cursorObserver = installCursorObserver({ dryRun, uninstall: true })
    const codexStep = codexHookStep(codex, 'uninstall', dryRun)
    if (!dryRun) { try { codex.refresh() } catch { /* health catches up on its own tick */ } }
    if (!cursorObserver.ok) { res.status(409).json({ ok: false, reason: 'cursor_observer_uninstall_failed', cursorObserver, codex: codexStep, status: result.status }); return }
    res.json({ ok: true, cursorObserver, codex: codexStep, changed: result.changed || cursorObserver.changed, backupPath: result.backupPath, status: result.status, ...(dryRun ? { merged: result.merged } : {}) })
  })

  // Sessions the hooks saw start and end, for Control's scheduled-job ledger. A run
  // shorter than the pet's 20 s poll is recorded here where the poll never saw it.
  router.get('/session-hooks/runs', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const since = Number(req.query.since)
    const sinceMs = Number.isFinite(since) && since > 0 ? since : Date.now() - 24 * 60 * 60_000
    // A Desktop tab or a terminal session is not a run (6.48.1): the ledger wants the
    // `claude -p` jobs (`sdk-cli`). `?all=1` lists every session the hooks saw.
    const all = req.query.all === '1'
    const runs: Array<Record<string, unknown>> = []
    for (const signal of sessionSignalStore.snapshot()) {
      if (signal.observationOnly) continue
      // 6.62.0: Control's scheduled-job ledger lists `claude -p` jobs. A Codex thread (no
      // registry entrypoint at all) or a Cursor composer is never one.
      if (signal.provider !== undefined && signal.provider !== 'claude') continue
      if (signal.firstSeenAt < sinceMs && !(signal.ended && signal.ended.at >= sinceMs)) continue
      if (!all && isInteractiveEntrypoint(signal.entrypoint)) continue
      runs.push({
        session_id: signal.sessionId,
        entrypoint: signal.entrypoint,
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
