// The production wiring for `session-continue-facts.ts`: live catalogs and live stores,
// read-only. A module of its own so the resolver's tests never import the live catalogs
// (which read ~/.codex and the repo's model cache at import).
//
// Roots are read PER CALL, not captured at construction, so `COS_AGENT_SESSIONS_HOME` (the
// session store's own override, which the route tests set) decides every path here too,
// the Codex config included.

import { join } from 'node:path'
import type { ContinueFactsDeps } from './session-continue-facts.js'
import { agentSessionRoots } from './agent-session-store.js'
import { getCodexTrustMode } from './codex-run-ledger.js'
import { codexModelDisplayName, isKnownCodexModel } from './codex-model-catalog.js'
import { cursorModelDisplayName, isKnownCursorModel } from './cursor-model-catalog.js'
import { resolveCursorAgentSession } from './cursor-agent-store.js'
import {
  codexConfigPath,
  codexFolderTrusted,
  codexGitTrustRoot,
  codexGitTrustRootSync,
  readCodexConfigText,
  type GitRunner,
  type GitRunnerSync,
} from './codex-session-posture.js'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Homebrew's git first: `/usr/bin/git` without the developer tools opens an install dialog. */
const GIT_BIN = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].find(path => existsSync(path)) ?? '/usr/bin/git'
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }

export const realGitRunner: GitRunner = (args, cwd, timeoutMs) => new Promise((resolve, reject) => {
  execFile(GIT_BIN, [...args], { cwd, timeout: timeoutMs, encoding: 'utf8', env: GIT_ENV, maxBuffer: 256 * 1024 }, (error, stdout) => {
    if (error) reject(error)
    else resolve(String(stdout))
  })
})

export const realGitRunnerSync: GitRunnerSync = (args, cwd, timeoutMs) =>
  String(execFileSync(GIT_BIN, [...args], { cwd, timeout: timeoutMs, encoding: 'utf8', env: GIT_ENV, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }))

function liveCodexConfigText(): string | null {
  const home = process.env.COS_AGENT_SESSIONS_HOME?.trim()
  return readCodexConfigText(home ? join(home, '.codex', 'config.toml') : codexConfigPath())
}

/**
 * 6.62.0 /qa (W5, N1): the adapter's SPAWN-TIME re-check for a full-access Codex plan, read
 * fresh from the config (the git root usually comes from the plan's cache seconds before).
 */
export function codexFolderTrustedNow(cwd: string): boolean {
  try {
    return codexFolderTrusted(cwd, codexGitTrustRootSync(cwd, realGitRunnerSync), liveCodexConfigText())
  } catch {
    return false
  }
}

/** The production wiring: live catalogs, live stores, read-only. */
export function realContinueFactsDeps(): ContinueFactsDeps {
  return {
    codexFallbackSandbox: () => getCodexTrustMode(),
    isKnownCodexModel: id => isKnownCodexModel(id),
    codexModelLabel: id => codexModelDisplayName(id),
    codexConfigText: () => liveCodexConfigText(),
    codexGitTrustRoot: cwd => codexGitTrustRoot(cwd, realGitRunner),
    isKnownCursorModel: id => isKnownCursorModel(id),
    cursorModelLabel: id => cursorModelDisplayName(id),
    cursorChatDir: threadId => resolveCursorAgentSession(threadId, agentSessionRoots().cursorChats)?.dir ?? null,
    get cursorComposerDb() {
      return agentSessionRoots().cursorComposerDb
    },
  }
}
