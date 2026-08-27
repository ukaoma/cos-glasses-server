// Direct Ollama chat — POST /api/chat. Optional read-only COS tools. No Codex --oss. Text only.

import type { CallOptions, StreamCallbacks } from './claude-bridge.js'
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
  ollamaModelSupportsTools,
} from './ollama-catalog.js'
import {
  classifyOllamaError,
  finishOllamaRun,
  startOllamaRun,
} from './ollama-run-ledger.js'
import { notifyExchange, notifySessionStart } from './telegram-notify.js'
import { OLLAMA_MODEL, type EffortPreference } from '../../shared/model-preference.js'
import { getCachedContextInstant } from './context-builder.js'
import { getOwnerName } from './profile.js'
import {
  buildOllamaSystemPrompt,
  buildOllamaToolDefs,
  executeOllamaTool,
  ollamaCosPipelineConfigured,
  ollamaToolStatusLabel,
  parseToolArguments,
} from './ollama-tools.js'

const INACTIVITY_MS = 60_000
const WALL_MAX_MS = 180_000
/** A turn may EXTEND past the 180s wall while tools run, but never past this. */
const WALL_HARD_MAX_MS = 300_000
/** POSTs to /api/chat per turn. Counted as fetches, not as "rounds" in prose:
 *  POSTs 1-4 may execute a tool batch, POST 5 is the closing fetch. */
const MAX_CHAT_POSTS = 5
/** While a tool runs there is no NDJSON, so inactivity must be bumped on a
 *  timer or a slow search trips the 60s idle abort. */
const TOOL_HEARTBEAT_MS = 5_000

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

/** One tool call as the daemon streams it. `arguments` is an OBJECT on the
 *  live probe, though the wire format also permits a JSON string. */
export interface OllamaToolCall {
  id?: string
  function: { name: string; arguments: unknown }
}

/**
 * Parse one NDJSON line.
 *
 * `toolCalls` is OMITTED, not set to undefined or [], when a line carries no
 * calls. Existing tests assert `toEqual({ content: 'Hi', done: false })` on an
 * exact object, and an always-present key fails them — which would be a real
 * signal that every consumer now has to think about tool calls, so the shape
 * stays honest instead.
 *
 * Calls can ride the `done: true` line as easily as a mid-stream one, so this
 * reads them on every line and the READER accumulates across lines (the live
 * C3 shape puts calls on line 1 and an empty done on line 2).
 */
export function parseOllamaChatDelta(line: string): {
  content: string
  done: boolean
  error?: string
  toolCalls?: OllamaToolCall[]
} {
  const trimmed = line.trim()
  if (!trimmed) return { content: '', done: false }
  try {
    const event = JSON.parse(trimmed) as {
      error?: unknown
      done?: unknown
      message?: { content?: unknown; tool_calls?: unknown }
    }
    if (typeof event.error === 'string' && event.error.trim()) {
      return { content: '', done: true, error: event.error.trim() }
    }
    const content = typeof event.message?.content === 'string' ? event.message.content : ''
    const raw = event.message?.tool_calls
    const calls: OllamaToolCall[] = Array.isArray(raw)
      ? raw.flatMap(entry => {
          const row = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
          const name = typeof row?.function?.name === 'string' ? row.function.name.trim() : ''
          if (!name) return []
          return [{
            ...(typeof row.id === 'string' && row.id ? { id: row.id } : {}),
            function: { name, arguments: row.function?.arguments },
          }]
        })
      : []
    return {
      content,
      done: event.done === true,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    }
  } catch {
    return { content: '', done: false }
  }
}

/** In-loop only. Never written to history. */
export type OllamaLoopMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: OllamaToolCall[] }
  | { role: 'tool'; content: string; tool_name: string; tool_call_id?: string }

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
  if (code === 'ollama.tool_cap') {
    return 'The local model hit its tool round cap without finishing an answer. Rephrase, or ask a narrower question.'
  }
  if (code === 'ollama.tool_abort') return 'That tool call was cancelled before it finished.'
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
  // Tools are advertised only when the pulled tag says it can call them AND
  // the COS pipeline is really on disk. Either missing means no `tools` key at
  // all and the original no-tools sentence, so a standalone npm install is
  // unchanged by this release.
  const modelSupportsTools = await ollamaModelSupportsTools(catalog.model)
  const toolDefs = modelSupportsTools && ollamaCosPipelineConfigured() ? buildOllamaToolDefs() : []
  const toolNames = toolDefs.map(def => def.function.name)
  const systemPrompt = buildOllamaSystemPrompt({
    ownerName: getOwnerName(),
    // ALWAYS, never keyword-gated: the old path omitted the calendar unless the
    // query happened to match schedule|meeting|..., so "what's left today"
    // answered with no calendar at all. Cached read, so it cannot block.
    cachedContext: getCachedContextInstant(),
    historyPrompt: `${historyPrompt}${handoffPrompt}`,
    toolNames,
  })

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

  // Wider than OllamaChatMessage on purpose, and used ONLY for this turn's
  // array. Tool turns are never persisted: Exchange.role stays user|assistant,
  // and historyToOllamaMessages drops empty content — which would silently eat
  // the C3 assistant turn whose content is '' and whose payload is the calls.
  const messages: OllamaLoopMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyToOllamaMessages(history, contextBreaks),
    { role: 'user', content: query },
  ]

  const abort = new AbortController()
  const onExternalAbort = () => abort.abort()
  options?.abortSignal?.addEventListener('abort', onExternalAbort, { once: true })

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  let wallTimer: ReturnType<typeof setTimeout> | undefined
  // Tracked here so clearTimers can kill it: a heartbeat still ticking after
  // finalize would keep bumping a dead turn's inactivity timer.
  let toolHeartbeat: ReturnType<typeof setInterval> | undefined
  const clearTimers = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    if (wallTimer) clearTimeout(wallTimer)
    if (toolHeartbeat) { clearInterval(toolHeartbeat); toolHeartbeat = undefined }
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

  /**
   * Extend the wall while a tool runs, never past the hard max.
   *
   * Clears and RE-ARMS: leaving the original 180s timer armed would abort the
   * turn on schedule no matter how much time was granted. Remaining time is
   * min(hardMax - elapsed, current + 60s), so extension cannot outrun the cap.
   */
  const bumpWall = () => {
    const elapsed = Date.now() - startTime
    const remainingToHardMax = WALL_HARD_MAX_MS - elapsed
    if (remainingToHardMax <= 0) return
    const current = Math.max(0, WALL_MAX_MS - elapsed)
    const next = Math.min(remainingToHardMax, current + 60_000)
    if (wallTimer) clearTimeout(wallTimer)
    wallTimer = setTimeout(() => abort.abort(), next)
  }

  let postCount = 0
  let toolsRetried = false

  /** One POST + its stream. Returns what the round produced. */
  const runChatPost = async (sendTools: boolean): Promise<
    | { kind: 'text' }
    | { kind: 'tools'; calls: OllamaToolCall[] }
    | { kind: 'empty' }
    | { kind: 'handled' }
  > => {
    postCount += 1
    const body: Record<string, unknown> = {
      model: catalog.model,
      messages,
      stream: true,
      think: resolveOllamaThink(process.env.COS_OLLAMA_THINK, options?.effort),
    }
    if (sendTools && toolDefs.length > 0) body.tools = toolDefs

    // First-byte grace on EVERY post: a silent think (effort xhigh/max) emits
    // nothing for a long time, and without this the 60s idle abort fires
    // before the first token rather than during a stall.
    bumpInactivity()
    const response = await ollamaFetch(`${catalog.origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 240)
      // A daemon that rejects the tools key gets ONE retry without it, and only
      // on the first POST of the turn. A later-round 400 is a real failure, and
      // the retry deliberately does not consume a cap slot.
      if (
        response.status === 400 && sendTools && body.tools && !toolsRetried && postCount === 1
        && /tool/i.test(detail)
      ) {
        toolsRetried = true
        postCount -= 1
        console.warn(`[ollama-bridge] tools rejected by ${catalog.model}: ${detail.slice(0, 120)}`)
        return runChatPost(false)
      }
      await finalizeError(`ollama-bridge: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
      return { kind: 'handled' }
    }
    if (!response.body) {
      await finalizeError('ollama-bridge: empty stream')
      return { kind: 'handled' }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawText = false
    // Accumulated across NDJSON LINES: the live shape puts calls on line 1 and
    // an empty done:true on line 2, so judging the done line alone sees nothing.
    const calls: OllamaToolCall[] = []

    const absorb = (line: string): 'error' | 'done' | 'ok' => {
      const delta = parseOllamaChatDelta(line)
      if (delta.error) return 'error'
      if (delta.toolCalls) calls.push(...delta.toolCalls)
      if (delta.content) {
        sawText = true
        fullText += delta.content
        callbacks.onChunk(delta.content)
      }
      return delta.done ? 'done' : 'ok'
    }

    let streamDone = false
    while (!streamDone) {
      const { done, value } = await reader.read()
      if (done) break
      bumpInactivity()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const outcome = absorb(line)
        if (outcome === 'error') {
          await finalizeError(`ollama-bridge: ${parseOllamaChatDelta(line).error}`)
          return { kind: 'handled' }
        }
        if (outcome === 'done') { streamDone = true; break }
      }
    }
    if (!streamDone && buffer.trim()) {
      const outcome = absorb(buffer)
      if (outcome === 'error') {
        await finalizeError(`ollama-bridge: ${parseOllamaChatDelta(buffer).error}`)
        return { kind: 'handled' }
      }
    }

    if (calls.length > 0) return { kind: 'tools', calls }
    return sawText ? { kind: 'text' } : { kind: 'empty' }
  }

  try {
    for (;;) {
      const round = await runChatPost(toolDefs.length > 0)
      if (round.kind === 'handled') return sid
      if (round.kind === 'text') { await finalizeDone(); return sid }

      if (round.kind === 'empty') {
        await finalizeError('ollama-bridge: Ollama completed without a response.')
        return sid
      }

      // POST 5 is the closing fetch. Calls returned there are NOT executed and
      // there is never a sixth POST, even if text came with them.
      if (postCount >= MAX_CHAT_POSTS) {
        await finalizeError('ollama-bridge: tool round cap reached without a final answer.')
        return sid
      }

      // The assistant turn carries the calls with empty content. It must be
      // appended as-is; dropping empty content here loses the call payload.
      messages.push({ role: 'assistant', content: '', tool_calls: round.calls })

      // Sequential. A batch runs to completion before the next POST, and a
      // late promise from an aborted call is ignored rather than appended.
      for (const call of round.calls) {
        if (finalized || abort.signal.aborted) break
        const name = call.function.name
        callbacks.onToolStatus?.(name)
        toolHeartbeat = setInterval(bumpInactivity, TOOL_HEARTBEAT_MS)
        let result: string
        try {
          result = await executeOllamaTool(name, parseToolArguments(call.function.arguments), abort.signal)
        } finally {
          if (toolHeartbeat) { clearInterval(toolHeartbeat); toolHeartbeat = undefined }
        }
        if (result === 'aborted' || abort.signal.aborted) {
          await finalizeError('ollama-bridge: tool call aborted.')
          return sid
        }
        messages.push({
          role: 'tool',
          content: result,
          tool_name: name,
          ...(call.id ? { tool_call_id: call.id } : {}),
        })
      }
      if (finalized) return sid
      // An abort that lands BETWEEN calls must end the turn. Without this the
      // loop simply fell out of the batch and issued another POST, so a
      // cancelled turn kept talking to the daemon until it hit the cap.
      if (abort.signal.aborted) {
        await finalizeError('ollama-bridge: tool call aborted.')
        return sid
      }
      bumpWall()
    }
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
