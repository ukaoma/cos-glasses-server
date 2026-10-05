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
import { codexConfigPath, readCodexConfigText } from './codex-session-posture.js'

/** The production wiring: live catalogs, live stores, read-only. */
export function realContinueFactsDeps(): ContinueFactsDeps {
  return {
    codexFallbackSandbox: () => getCodexTrustMode(),
    isKnownCodexModel: id => isKnownCodexModel(id),
    codexModelLabel: id => codexModelDisplayName(id),
    codexConfigText: () => {
      const home = process.env.COS_AGENT_SESSIONS_HOME?.trim()
      return readCodexConfigText(home ? join(home, '.codex', 'config.toml') : codexConfigPath())
    },
    isKnownCursorModel: id => isKnownCursorModel(id),
    cursorModelLabel: id => cursorModelDisplayName(id),
    cursorChatDir: threadId => resolveCursorAgentSession(threadId, agentSessionRoots().cursorChats)?.dir ?? null,
    get cursorComposerDb() {
      return agentSessionRoots().cursorComposerDb
    },
  }
}
