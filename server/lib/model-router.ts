import { callClaudeStreaming, type CallOptions, type StreamCallbacks } from './claude-bridge.js'
import { callCodexStreaming } from './codex-bridge.js'
import { callCursorStreaming } from './cursor-bridge.js'
import { callOllamaStreaming } from './ollama-bridge.js'
import {
  getOrCreateSession,
  getSessionBinding,
  getSessionModel,
  setSessionModel,
  type ModelPreference,
  type PromptReference,
  type SessionModelBinding,
} from './conversation.js'
import {
  DEFAULT_MODEL,
  isCodexModel,
  isClaudeModel,
  isCursorModel,
  isOllamaModel,
} from '../../shared/model-preference.js'
import {
  getCursorModelCatalog,
  isCursorProviderReady,
  resolveCursorModelOption,
} from './cursor-model-catalog.js'
import {
  getOllamaCatalog,
  isOllamaProviderReady,
} from './ollama-catalog.js'
import type { ModelImageInput } from './model-image-input.js'
import { parsePreference } from '../../shared/key-preference.js'
import {
  closedEnvDefaultModel,
  keyProfileEngineRunner,
  keyProfileUnavailableLine,
  resolveKeyProfileTurn,
  type KeyProfileTurnCallbacks,
} from './key-profile-routing.js'

// Bridges return as soon as their subprocess is spawned, while completion is
// delivered later through callbacks. This keyed tail queue therefore releases
// only on a terminal callback (or an early throw), preventing two turns from
// mutating the same conversation/CLI session concurrently.
const sessionRunTails = new Map<string, Promise<void>>()

export async function acquireModelSessionRunLock(sessionId: string): Promise<() => void> {
  const previous = sessionRunTails.get(sessionId) ?? Promise.resolve()
  let openGate!: () => void
  const gate = new Promise<void>(resolve => { openGate = resolve })
  const tail = previous.catch(() => {}).then(() => gate)
  sessionRunTails.set(sessionId, tail)
  await previous.catch(() => {})

  let released = false
  return () => {
    if (released) return
    released = true
    openGate()
    if (sessionRunTails.get(sessionId) === tail) sessionRunTails.delete(sessionId)
  }
}

// Chat routes to the user's local Claude Code CLI or stable Codex live-catalog
// slots. Any unknown preference falls back to the Claude default
// so chat always works on a stock install.
export async function callModelStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks & KeyProfileTurnCallbacks,
  model?: SessionModelBinding,
  images?: ModelImageInput[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  const sid = getOrCreateSession(sessionId)
  const release = options?.sessionLockHeld ? (() => {}) : await acquireModelSessionRunLock(sid)
  if (options?.abortSignal?.aborted) {
    release()
    throw new Error('model-router: request aborted before the model run started.')
  }

  // Key lanes K1 (plan 5.2): the request model is ACCEPTED here. parsePreference returns exactly
  // normalizeModelPreference for every model slot; only a well formed `profile:<id>` is new.
  const requested = parsePreference(model)
  const sessionModel = getSessionModel(sid)
  // A session bound to a profile reads null from the closed getSessionModel. It is looked up
  // only when nothing else names the model, so every 6.79.0 path stays exactly as it was.
  const bound = requested ?? (sessionModel === null ? parsePreference(getSessionBinding(sid)) : undefined)
  const profileId = bound?.kind === 'profile' ? bound.id : undefined
  if (profileId !== undefined) return await runKeyProfileRoute(query, sid, callbacks, profileId, release, images, reference, globalMsgNum, options)

  // COS_G2_DEFAULT_MODEL is the documented default-model switch (CHANGELOG 6.1.0);
  // it must win over the hardcoded DEFAULT_MODEL on this primary query path, not
  // just the OpenAI-compat surface. A profile id there is ignored (plan 5.2: closed).
  const envDefault = closedEnvDefaultModel(process.env.COS_G2_DEFAULT_MODEL)
  const resolvedModel = (requested?.kind === 'model' ? requested.value : undefined) ?? sessionModel ?? envDefault ?? DEFAULT_MODEL

  setSessionModel(sid, resolvedModel)

  let terminal = false
  const releaseTerminal = () => {
    if (terminal) return
    terminal = true
    release()
  }
  const { onKeyProfileTurn: _onKeyProfileTurn, ...streamCallbacks } = callbacks
  const lockedCallbacks: StreamCallbacks = {
    ...streamCallbacks,
    onDone: async (fullText, completedModel, cliSessionId, metadata) => {
      try {
        return await callbacks.onDone(fullText, completedModel, cliSessionId, metadata)
      } finally {
        releaseTerminal()
      }
    },
    onError: async (error) => {
      try {
        await callbacks.onError(error)
      } finally {
        releaseTerminal()
      }
    },
  }

  try {
    if (options?.dispatch && !isClaudeModel(resolvedModel)) {
      await lockedCallbacks.onError('dispatch_requires_claude')
      return sid
    }
    // Cursor slots fail closed — never fall through to Claude/Codex.
    if (isCursorModel(resolvedModel)) {
      await getCursorModelCatalog()
      const option = resolveCursorModelOption(resolvedModel)
      if (!isCursorProviderReady() || !option?.id) {
        const message = !option?.id
          ? `cursor-bridge: Cursor model slot ${resolvedModel} is not resolved. Check agent models / login.`
          : 'cursor-bridge: Cursor CLI unavailable. Install agent and run agent login.'
        await lockedCallbacks.onError(message)
        return sid
      }
      return await callCursorStreaming(query, sid, lockedCallbacks, resolvedModel, images, reference, globalMsgNum, options)
    }
    if (isOllamaModel(resolvedModel)) {
      await getOllamaCatalog()
      if (!isOllamaProviderReady()) {
        await lockedCallbacks.onError('ollama-bridge: Ollama is not running. Start ollama serve on this Mac.')
        return sid
      }
      return await callOllamaStreaming(query, sid, lockedCallbacks, images, reference, globalMsgNum, options)
    }
    if (isCodexModel(resolvedModel)) {
      return await callCodexStreaming(query, sid, lockedCallbacks, resolvedModel, images, reference, globalMsgNum, options)
    }
    if (isClaudeModel(resolvedModel)) {
      return await callClaudeStreaming(query, sid, lockedCallbacks, resolvedModel, images, reference, globalMsgNum, options)
    }
    return await callClaudeStreaming(query, sid, lockedCallbacks, DEFAULT_MODEL, images, reference, globalMsgNum, options)
  } catch (err) {
    releaseTerminal()
    throw err
  }
}

/**
 * Key lanes K1 (plan 5.2): a turn bound to `profile:<id>`. Refused with a lens line, never
 * answered on the subscription, when lanes are off, the profile is unknown, disabled or keyless,
 * no runner is registered for its engine, or it is a scheduled dispatch.
 */
async function runKeyProfileRoute(
  query: string,
  sid: string,
  callbacks: StreamCallbacks & KeyProfileTurnCallbacks,
  profileId: string,
  release: () => void,
  images?: ModelImageInput[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  let terminal = false
  const releaseTerminal = () => {
    if (terminal) return
    terminal = true
    release()
  }
  const { onKeyProfileTurn, ...streamCallbacks } = callbacks
  const lockedCallbacks: StreamCallbacks = {
    ...streamCallbacks,
    onDone: async (fullText, completedModel, cliSessionId, metadata) => {
      try {
        return await callbacks.onDone(fullText, completedModel, cliSessionId, metadata)
      } finally {
        releaseTerminal()
      }
    },
    onError: async (error) => {
      try {
        await callbacks.onError(error)
      } finally {
        releaseTerminal()
      }
    },
  }
  try {
    if (options?.dispatch) {
      await lockedCallbacks.onError('dispatch_requires_claude')
      return sid
    }
    const resolved = resolveKeyProfileTurn(profileId)
    if (!resolved.ok) {
      await lockedCallbacks.onError(resolved.message)
      return sid
    }
    const runner = keyProfileEngineRunner(resolved.turn.profile.engine)
    if (!runner) {
      await lockedCallbacks.onError(keyProfileUnavailableLine(resolved.turn.profile.label))
      return sid
    }
    // Persisted by syntax (conversation.ts) so the next turn of this session stays on the key,
    // unless this is the one-turn plan-limit offer (QA U9): then the session keeps its model.
    if (!options?.keyTurnOnly) setSessionModel(sid, resolved.turn.binding)
    onKeyProfileTurn?.(resolved.turn)
    return await runner(query, sid, lockedCallbacks, resolved.turn, images, reference, globalMsgNum, options)
  } catch (err) {
    releaseTerminal()
    throw err
  }
}
