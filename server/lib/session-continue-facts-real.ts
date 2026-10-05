// The production wiring for `session-continue-facts.ts`: live catalogs and live stores,
// read-only. A module of its own so the resolver's tests never import the live catalogs
// (which read ~/.codex and the repo's model cache at import).

import type { ContinueFactsDeps } from './session-continue-facts.js'
import { agentSessionRoots } from './agent-session-store.js'
import { getCodexTrustMode } from './codex-run-ledger.js'
import { codexModelDisplayName, isKnownCodexModel } from './codex-model-catalog.js'
import { cursorModelDisplayName, isKnownCursorModel } from './cursor-model-catalog.js'
import { resolveCursorAgentSession } from './cursor-agent-store.js'

/** The production wiring: live catalogs, live stores, read-only. */
export function realContinueFactsDeps(): ContinueFactsDeps {
  const roots = agentSessionRoots()
  return {
    codexFallbackSandbox: () => getCodexTrustMode(),
    isKnownCodexModel: id => isKnownCodexModel(id),
    codexModelLabel: id => codexModelDisplayName(id),
    isKnownCursorModel: id => isKnownCursorModel(id),
    cursorModelLabel: id => cursorModelDisplayName(id),
    cursorChatDir: threadId => resolveCursorAgentSession(threadId, roots.cursorChats)?.dir ?? null,
    cursorComposerDb: roots.cursorComposerDb,
  }
}
