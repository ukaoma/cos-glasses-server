// Key lanes K1, QA B1 (main session decision, 2026-10-19): while key lanes are ENABLED and a key
// is saved, every Claude spawn that can use tools gets deny rules for the key secrets directory,
// as one `--settings` layer (deny rules from every layer apply; a flag layer cannot be turned off
// by a user or project settings file).
//
//   Read, Edit, Write   the directory and everything under it, by its path and its real path
//   Bash                any command line naming the directory or the key file
//
// This narrows, it does not wall off: a process running on this Mac as the same user can still
// read a file the server can read (a Bash line that builds the path, another app, Codex, whose
// sandbox has no read exclusion). That residual risk is stated plainly in key-notices.ts
// (KEY_LANE_SAME_MAC_COPY) and the CHANGELOG; the provider's own spending limit is the real stop.
//
// HARD RULE: with key lanes off this returns [] before touching the disk, so every spawn's argv is
// byte-identical to 6.79.1. Enabled with no key saved, there is nothing to protect: [] too.
import { existsSync, realpathSync } from 'node:fs'
import { keyLanesEnabled } from './key-lanes.js'
import { KEY_SECRETS_DIR, KEY_STORE_FILE, keySecretsDir, keyStorePath } from './key-store.js'

/** The deny rules for the secrets directory (exported for the tests and the real-CLI canary). */
export function keySecretsDenyRules(dir: string = keySecretsDir()): string[] {
  const dirs = new Set([dir])
  try { dirs.add(realpathSync(dir)) } catch { /* not created yet: the plain path still applies */ }
  const rules: string[] = []
  for (const d of dirs) {
    // `//abs/path` is Claude Code's absolute-path form for Read, Edit and Write rules.
    for (const tool of ['Read', 'Edit', 'Write']) rules.push(`${tool}(/${d}/**)`)
  }
  rules.push(`Bash(*${KEY_SECRETS_DIR}*)`, `Bash(*${KEY_STORE_FILE}*)`)
  return rules
}

/** `['--settings', <deny JSON>]` while lanes are enabled and a key is saved, else []. */
export function claudeKeySecretsGuardArgs(): string[] {
  if (!keyLanesEnabled()) return []
  if (!existsSync(keyStorePath())) return []
  return ['--settings', JSON.stringify({ permissions: { deny: keySecretsDenyRules() } })]
}
