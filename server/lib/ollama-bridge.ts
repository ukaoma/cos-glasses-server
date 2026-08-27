// Direct Ollama chat — POST /api/chat. No Codex --oss, no tools, text only.

import type { CallOptions, StreamCallbacks } from './claude-bridge.js'
import { buildLightweightSystemPrompt } from './context-builder.js'
import {
  addExchange,
  formatHistoryForPrompt,
  getHistory,
  getOrCreateSession,
  getSessionRaw,
  isNewSession,
  markSessionNotified,
  reconcileExchangeByJobIdentity,
  type Exchange,
  type PromptReference,
} from './conversation.js'
import { cleanupModelImageInputs, type ModelImageInput } from './model-image-input.js'
import {
  getOllamaCatalog,
  isOllamaProviderReady,
  ollamaFetch,
} from './ollama-catalog.js'
import {
  classifyOllamaError,
  finishOllamaRun,
  startOllamaRun,
} from './ollama-run-ledger.js'
import { notifyExchange, notifySessionStart } from './telegram-notify.js'
import { OLLAMA_MODEL, type EffortPreference } from '../../shared/model-preference.js'

const INACTIVITY_MS = 60_000
const WALL_MAX_MS = 180_000

/**
 * Thinking follows the REQUESTED EFFORT, not a blanket switch.
 *
 * The default effort ('high' -- every ordinary lens turn) keeps thinking
 * OFF: measured 2026-08-26 on qwen3.5:35b, a hidden chain turned a
 * 2.2-second answer into 98.6 seconds of dead screen at the same visible
 * quality, and a hard prompt can out-run WALL_MAX_MS entirely. Raising the
 * effort raises the thinking budget with it (xhigh -> 'high', max and
 * ultracode -> 'max'), because that is what the escalation MEANS -- the
 * flag benchmark showed a thinking local model matching Opus 5 (10/10)
 * where the same model without thinking scored 6-7. Level strings are
 * accepted by the daemon on Qwen-class models (probed live), and
 * `think: false` is silently tolerated by models WITHOUT the thinking
 * capability (verified against llama3.2:1b -- HTTP 200), so no capability
 * gate is needed.
 *
 * COS_OLLAMA_THINK, when set, PINS the behavior regardless of effort:
 * "1"/"true" always think, "0"/"false" never think, or an explicit level.
 * Anything unrecognized reads as unset and defers to the effort map.
 */
export function resolveOllamaThink(
  raw: string | undefined,
  effort?: EffortPreference,
): boolean | string {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'max') return value
  switch (effort) {
    case 'xhigh': return 'high'
    case 'max':
    case 'ultracode': return 'max'
    default: return false
  }
}
const HISTORY_LIMIT = 20

type OllamaChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export function parseOllamaChatDelta(line: string): { content: string; done: boolean; error?: string } {
  const trimmed = line.trim()
  if (!trimmed) return { content: '', done: false }
  try {
    const event = JSON.parse(trimmed) as {
      error?: unknown
      done?: unknown
      message?: { content?: unknown }
    }
    if (typeof event.error === 'string' && event.error.trim()) {
      return { content: '', done: true, error: event.error.trim() }
    }
    const content = typeof event.message?.content === 'string' ? event.message.content : ''
    return { content, done: event.done === true }
  } catch {
    return { content: '', done: false }
  }
}

export function historyToOllamaMessages(
  exchanges: Exchange[],
  contextBreaks: number[],
  limit = HISTORY_LIMIT,
): OllamaChatMessage[] {
  const lastBreak = contextBreaks.length > 0 ? contextBreaks[contextBreaks.length - 1]! : 0
  const recent = exchanges.filter(ex => ex.timestamp >= lastBreak).slice(-limit)
  const messages: OllamaChatMessage[] = []
  for (const ex of recent) {
    const content = ex.content.trim()
    if (!content) continue
    if (ex.role === 'user') messages.push({ role: 'user', content })
    else messages.push({ role: 'assistant', content })
  }
  return messages
}

function safeOllamaUserError(message: string): string {
  const code = classifyOllamaError(message)
  if (code === 'ollama.unavailable') return 'Ollama is not running. Start ollama serve on this Mac.'
  if (code === 'ollama.no_model') return 'Ollama has no pulled models. Run ollama pull, then retry.'
  if (code === 'ollama.text_only') return 'Ollama is text-only here. Remove the photo and retry.'
  if (code === 'ollama.timeout') return 'Ollama timed out. Retry or pick another model.'
  return `Ollama failed (${code}). Retry or check that ollama serve is running.`
}

export async function callOllamaStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  images?: ModelImageInput[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  const sid = getOrCreateSession(sessionId)
  const imageInputs = images ?? []
  const inboundAttachments = options?.requestAttachments ?? []

  if (imageInputs.length > 0 || inboundAttachments.length > 0) {
    cleanupModelImageInputs(imageInputs)
    await callbacks.onError(safeOllamaUserError('ollama-bridge: Ollama is text-only in this version.'))
    return sid
  }

  await getOllamaCatalog()
  const catalog = await getOllamaCatalog()
  if (!isOllamaProviderReady() || !catalog.model) {
    await callbacks.onError(safeOllamaUserError(
      catalog.error ? `ollama-bridge: ${catalog.error}` : 'ollama-bridge: Ollama is not ready.',
    ))
    return sid
  }

  const history = getHistory(sid)
  const session = getSessionRaw(sid)
  const contextBreaks = session?.contextBreaks ?? []
  const historyPrompt = formatHistoryForPrompt(history, contextBreaks, reference)
  const handoffPrompt = options?.handoffContext?.promptBlock ? `\n\n${options.handoffContext.promptBlock}` : ''
  const systemPrompt = `${buildLightweightSystemPrompt(query, `${historyPrompt}${handoffPrompt}`)}\n\nYou have no tools. Answer from the prompt and conversation only. Plain text.`

  const startTime = Date.now()
  const run = startOllamaRun({
    turnId: options?.turnId,
    clientJobId: options?.clientJobId,
    cosSessionId: sid,
    ollamaModel: catalog.model,
    origin: catalog.origin,
    query,
  })

  callbacks.onStart?.(OLLAMA_MODEL, sid, undefined, { ollamaRunId: run.runId })
  await callbacks.onProviderProcess?.({
    provider: 'ollama',
    runId: run.runId,
    clientJobId: options?.clientJobId,
    generation: options?.jobGeneration ?? options?.generation,
  })

  const jobGeneration = options?.jobGeneration ?? options?.generation
  const durableIdentity = options?.clientJobId && Number.isSafeInteger(jobGeneration) && jobGeneration! > 0
    ? { clientJobId: options.clientJobId, generation: jobGeneration! } : undefined
  if (durableIdentity) {
    reconcileExchangeByJobIdentity(sid, durableIdentity, 'user', query, globalMsgNum, undefined, undefined, OLLAMA_MODEL)
  } else {
    addExchange(sid, 'user', query, globalMsgNum, undefined, durableIdentity, OLLAMA_MODEL)
  }

  if (isNewSession(sid)) {
    notifySessionStart(sid, query)
    markSessionNotified(sid)
  }

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyToOllamaMessages(history, contextBreaks),
    { role: 'user', content: query },
  ]

  const abort = new AbortController()
  const onExternalAbort = () => abort.abort()
  options?.abortSignal?.addEventListener('abort', onExternalAbort, { once: true })

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  let wallTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimers = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    if (wallTimer) clearTimeout(wallTimer)
  }
  const bumpInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => abort.abort(), INACTIVITY_MS)
  }

  let fullText = ''
  let finalized = false
  const finalizeError = async (raw: string) => {
    if (finalized) return
    finalized = true
    clearTimers()
    finishOllamaRun(run.runId, { status: 'failed', startedAtMs: startTime, error: raw })
    await callbacks.onError(safeOllamaUserError(raw))
  }
  const finalizeDone = async () => {
    if (finalized) return
    finalized = true
    clearTimers()
    const text = fullText.trim()
    if (!text) {
      finishOllamaRun(run.runId, { status: 'failed', startedAtMs: startTime, error: 'ollama-bridge: empty response' })
      await callbacks.onError(safeOllamaUserError('ollama-bridge: Ollama completed without a response.'))
      return
    }
    if (durableIdentity) {
      reconcileExchangeByJobIdentity(sid, durableIdentity, 'assistant', text, globalMsgNum, undefined, undefined, OLLAMA_MODEL)
    } else {
      addExchange(sid, 'assistant', text, globalMsgNum, undefined, durableIdentity, OLLAMA_MODEL)
    }
    finishOllamaRun(run.runId, { status: 'completed', startedAtMs: startTime, output: text })
    notifyExchange(sid, query, text)
    await callbacks.onDone(text, OLLAMA_MODEL, undefined, { ollamaRunId: run.runId })
  }

  bumpInactivity()
  wallTimer = setTimeout(() => abort.abort(), WALL_MAX_MS)

  try {
    const response = await ollamaFetch(`${catalog.origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: catalog.model,
        messages,
        stream: true,
        think: resolveOllamaThink(process.env.COS_OLLAMA_THINK, options?.effort),
      }),
      signal: abort.signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 240)
      await finalizeError(`ollama-bridge: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
      return sid
    }
    if (!response.body) {
      await finalizeError('ollama-bridge: empty stream')
      return sid
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bumpInactivity()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const delta = parseOllamaChatDelta(line)
        if (delta.error) {
          await finalizeError(`ollama-bridge: ${delta.error}`)
          return sid
        }
        if (delta.content) {
          fullText += delta.content
          callbacks.onChunk(delta.content)
        }
        if (delta.done) {
          await finalizeDone()
          return sid
        }
      }
    }
    if (buffer.trim()) {
      const delta = parseOllamaChatDelta(buffer)
      if (delta.error) {
        await finalizeError(`ollama-bridge: ${delta.error}`)
        return sid
      }
      if (delta.content) {
        fullText += delta.content
        callbacks.onChunk(delta.content)
      }
    }
    await finalizeDone()
    return sid
  } catch (error: any) {
    const aborted = abort.signal.aborted || options?.abortSignal?.aborted
    await finalizeError(
      aborted
        ? 'ollama-bridge: request aborted'
        : `ollama-bridge: ${error?.message ?? 'fetch failed'}`,
    )
    return sid
  } finally {
    clearTimers()
    options?.abortSignal?.removeEventListener('abort', onExternalAbort)
  }
}
