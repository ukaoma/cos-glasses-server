#!/usr/bin/env tsx
import { installCursorObserver } from '../lib/cursor-observer-installer.js'
// Install, inspect or remove the COS session hook in ~/.claude/settings.json, and (6.62.0) in
// ~/.codex/hooks.json when Codex is on this Mac.
//
//   npx --yes @gotcos/glasses-server@latest --hooks install [--dry-run] [--port 3141] [--codex]
//   npx --yes @gotcos/glasses-server@latest --hooks status
//   npx --yes @gotcos/glasses-server@latest --hooks uninstall [--dry-run] [--codex]
//
// `--codex` acts on Codex ONLY (the rollback runbook's `--hooks uninstall --codex` leaves the
// Claude hooks in place). Without it, Codex rides along when present and never changes the
// exit code: a Codex refusal is reported under `codex` and Claude's answer stands (B2).
//
// Prints one JSON document. Exit 0 on success, 2 on a refusal (unparseable or symlinked
// settings, a missing packaged script), 64 on a bad argument. Never prints the token.

import { hookStatus, hookStatusAdvice, installClaudeHooks, uninstallClaudeHooks } from '../lib/claude-hooks-installer.js'
import { codexHookAdvice, codexHookStatus, codexPresent, installCodexHooks, refreshCodexHookTrust, uninstallCodexHooks } from '../lib/codex-hooks-installer.js'
import { sessionHooksEnabled } from '../lib/session-hooks-runtime.js'

const args = process.argv.slice(2)
const action = args.find(a => !a.startsWith('--'))
const dryRun = args.includes('--dry-run')
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.PORT ?? 3141)
const deskIndex = args.indexOf('--desk-idle-s')
const deskIdleSeconds = deskIndex >= 0 ? Number(args[deskIndex + 1]) : Number(process.env.COS_PERMISSION_BROKER_DESK_IDLE_S ?? 90)

const codexOnly = args.includes('--codex')

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

/** The Codex half: skipped when Codex is not here; with trust read from Codex itself (K3). */
async function codexPart(action: 'status' | 'install' | 'uninstall'): Promise<Record<string, unknown> & { ok: boolean }> {
  if (!codexPresent()) return { ok: true, skipped: 'codex_not_present' }
  const result = action === 'status' ? { ok: true, status: codexHookStatus() }
    : action === 'install' ? installCodexHooks({ dryRun }) : uninstallCodexHooks({ dryRun })
  const trust = result.status.installed && !dryRun ? await refreshCodexHookTrust({ fresh: true }) : null
  const advice = action === 'uninstall' ? null : codexHookAdvice(result.status, trust?.trust ?? 'unknown')
  // QA W4: why the trust word is what it is (a failed read's code, `not_listed`), or null.
  return { ...result, ...(trust ? { trust: trust.trust, trustReason: trust.reason } : {}), ...(advice ? { advice } : {}) }
}

// `serverApplies` says whether the running server would READ the spool into rows: the
// hooks can be installed while the feature is off (COS_CLAUDE_SESSIONS_ENABLED unset),
// and a status that said only "installed" would hide that.
const serverApplies = sessionHooksEnabled()
const flagsNote = serverApplies ? undefined : 'Rows change only when the server runs with COS_CLAUDE_SESSIONS_ENABLED=1 (or COS_SESSION_HOOKS=1).'

if ((action === 'install' || action === 'uninstall') && codexOnly) {
  const codex = await codexPart(action)
  print({ action, dryRun, codexOnly: true, codex })
  process.exit(codex.ok ? 0 : 2)
}
if (action === 'status') {
  const status = hookStatus()
  // 6.53.3: say in words what the state means and what fixes it (`script_outdated` after an
  // update that changed the script, until Install hooks).
  const advice = hookStatusAdvice(status)
  print({ action, serverApplies, ...(flagsNote ? { note: flagsNote } : {}), ...(advice ? { advice } : {}), ...status, codex: await codexPart('status') })
  process.exit(0)
}
if (action === 'install') {
  if (!Number.isFinite(port) || port <= 0) { console.error('Bad --port'); process.exit(64) }
  const result = installClaudeHooks({ port, deskIdleSeconds: Number.isFinite(deskIdleSeconds) ? deskIdleSeconds : 90, dryRun })
  const cursorObserver = result.ok ? installCursorObserver({ dryRun }) : undefined
  const codex = result.ok ? await codexPart('install') : undefined
  print({ action, dryRun, serverApplies, ...(flagsNote ? { note: flagsNote } : {}), ...result, cursorObserver, codex })
  process.exit(result.ok && cursorObserver?.ok ? 0 : 2)
}
if (action === 'uninstall') {
  const result = uninstallClaudeHooks({ dryRun })
  const cursorObserver = result.ok ? installCursorObserver({ dryRun, uninstall: true }) : undefined
  const codex = result.ok ? await codexPart('uninstall') : undefined
  print({ action, dryRun, ...result, cursorObserver, codex })
  process.exit(result.ok && cursorObserver?.ok ? 0 : 2)
}
console.error('Usage: --hooks install|status|uninstall [--dry-run] [--port N] [--desk-idle-s N] [--codex]')
process.exit(64)
