#!/usr/bin/env tsx
// Install, inspect or remove the COS session hook in ~/.claude/settings.json.
//
//   npx --yes @gotcos/glasses-server@latest --hooks install [--dry-run] [--port 3141]
//   npx --yes @gotcos/glasses-server@latest --hooks status
//   npx --yes @gotcos/glasses-server@latest --hooks uninstall [--dry-run]
//
// Prints one JSON document. Exit 0 on success, 2 on a refusal (unparseable or symlinked
// settings, a missing packaged script), 64 on a bad argument. Never prints the token.

import { hookStatus, installClaudeHooks, uninstallClaudeHooks } from '../lib/claude-hooks-installer.js'
import { sessionHooksEnabled } from '../lib/session-hooks-runtime.js'

const args = process.argv.slice(2)
const action = args.find(a => !a.startsWith('--'))
const dryRun = args.includes('--dry-run')
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.PORT ?? 3141)
const deskIndex = args.indexOf('--desk-idle-s')
const deskIdleSeconds = deskIndex >= 0 ? Number(args[deskIndex + 1]) : Number(process.env.COS_PERMISSION_BROKER_DESK_IDLE_S ?? 90)

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

// `serverApplies` says whether the running server would READ the spool into rows: the
// hooks can be installed while the feature is off (COS_CLAUDE_SESSIONS_ENABLED unset),
// and a status that said only "installed" would hide that.
const serverApplies = sessionHooksEnabled()
const flagsNote = serverApplies ? undefined : 'Rows change only when the server runs with COS_CLAUDE_SESSIONS_ENABLED=1 (or COS_SESSION_HOOKS=1).'

if (action === 'status') {
  print({ action, serverApplies, ...(flagsNote ? { note: flagsNote } : {}), ...hookStatus() })
  process.exit(0)
}
if (action === 'install') {
  if (!Number.isFinite(port) || port <= 0) { console.error('Bad --port'); process.exit(64) }
  const result = installClaudeHooks({ port, deskIdleSeconds: Number.isFinite(deskIdleSeconds) ? deskIdleSeconds : 90, dryRun })
  print({ action, dryRun, serverApplies, ...(flagsNote ? { note: flagsNote } : {}), ...result })
  process.exit(result.ok ? 0 : 2)
}
if (action === 'uninstall') {
  const result = uninstallClaudeHooks({ dryRun })
  print({ action, dryRun, ...result })
  process.exit(result.ok ? 0 : 2)
}
console.error('Usage: --hooks install|status|uninstall [--dry-run] [--port N] [--desk-idle-s N]')
process.exit(64)
