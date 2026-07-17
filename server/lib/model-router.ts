import { callClaudeStreaming, type CallOptions, type StreamCallbacks } from './claude-bridge.js'
import { callCodexStreaming } from './codex-bridge.js'
import {
  getOrCreateSession,
  getSessionModel,
  setSessionModel,
  type ModelPreference,
  type PromptReference,
} from './conversation.js'
import { DEFAULT_MODEL, isCodexModel, isClaudeModel, normalizeModelPreference } from '../../shared/model-preference.js'
import type { ModelImageInput } from './model-image-input.js'

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
  callbacks: StreamCallbacks,
  model?: ModelPreference,
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

  const sessionModel = getSessionModel(sid)
  // COS_G2_DEFAULT_MODEL is the documented default-model switch (CHANGELOG 6.1.0);
  // it must win over the hardcoded DEFAULT_MODEL on this primary query path, not
  // just the OpenAI-compat surface.
  const envDefault = normalizeModelPreference(process.env.COS_G2_DEFAULT_MODEL)
  const resolvedModel = normalizeModelPreference(model) ?? sessionModel ?? envDefault ?? DEFAULT_MODEL

  setSessionModel(sid, resolvedModel)

  let terminal = false
  const releaseTerminal = () => {
    if (terminal) return
    terminal = true
    release()
  }
  const lockedCallbacks: StreamCallbacks = {
    ...callbacks,
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
