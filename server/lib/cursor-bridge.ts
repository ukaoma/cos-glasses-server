// Cursor Agent CLI bridge — ask or full agent (`--force` + `--sandbox disabled`).
// Fail-closed: never fall through to Claude.

import { spawn } from 'node:child_process'
import { logTokenAudit } from './token-audit.js'
import { cleanupModelImageInputs, type ModelImageInput } from './model-image-input.js'
import { buildSystemPrompt, buildLightweightSystemPrompt } from './context-builder.js'
import {
  getHistory,
  addExchange,
  reconcileExchangeByJobIdentity,
  setExchangeAttachments,
  removeExchange,
  formatHistoryForPrompt,
  getOrCreateSession,
  isNewSession,
  markSessionNotified,
  getSessionRaw,
  replaceLastExchangeWithSummary,
  type PromptReference,
} from './conversation.js'
import { notifySessionStart, notifyExchange } from './telegram-notify.js'
import {
  clearCursorEngineSession,
  getCursorEngineSession,
  saveCursorEngineSession,
} from './cursor-engine-sessions.js'
import {
  CURSOR_COMPOSER_MODEL,
  normalizeCursorExecutionMode,
  type CursorExecutionMode,
  type CursorModelPreference,
} from '../../shared/model-preference.js'
import {
  getCursorModelCatalog,
  resolveAgentBinary,
  resolveCursorModelOption,
} from './cursor-model-catalog.js'
import type { CallOptions, StreamCallbacks } from './claude-bridge.js'
import {
  classifyCursorError,
  finishCursorRun,
  getCursorExecutionCwd,
  isCursorPersistenceEnabled,
  startCursorRun,
  updateCursorRun,
  type CursorRunStatus,
} from './cursor-run-ledger.js'
import {
  collectRunOutputImagesBounded,
  createRunOutputImagePublisher,
  type RunOutputImageCollectionStats,
} from './run-output-images.js'
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'
import { terminalProviderAuthFailure } from './provider-terminal-error.js'

const INACTIVITY_MS = 180_000
const WALL_MAX_MS = 900_000
const HEARTBEAT_INTERVAL_MS = 6_000

type Phase = 'context' | 'thinking' | 'generating'

const PHASE_LABELS: Record<Phase, string> = {
  context: 'Loading context...',
  thinking: 'Reasoning...',
  generating: 'Cursor drafting...',
}

export function buildCursorAgentArgs(input: {
  workspace: string
  modelId: string
  executionMode?: CursorExecutionMode
  resumeSessionId?: string
}): string[] {
  const mode = normalizeCursorExecutionMode(input.executionMode)
  const args = [
    '-p',
    '--model', input.modelId,
    '--output-format', 'stream-json',
    '--stream-partial-output',
    '--trust',
    '--workspace', input.workspace,
  ]
  if (mode === 'ask') {
    args.splice(1, 0, '--mode', 'ask')
  } else {
    // Headless glasses need non-interactive tool approval + no sandbox hang.
    args.push('--force', '--sandbox', 'disabled', '--approve-mcps')
  }
  if (input.resumeSessionId) {
    args.push('--resume', input.resumeSessionId)
  }
  // Prompt is written to stdin AFTER durable provider ownership is confirmed.
  return args
}

/** Map Cursor stream-json tool_call events to HUD status / activity lines. */
export function extractCursorToolActivity(event: any): {
  status?: string
  activity?: { kind: 'input' | 'output'; text: string }
  isWrite: boolean
} {
  if (event?.type !== 'tool_call') return { isWrite: false }
  const toolCall = event?.tool_call && typeof event.tool_call === 'object' ? event.tool_call : null
  if (!toolCall) return { isWrite: false }
  const subtype = String(event?.subtype ?? '')

  if (toolCall.editToolCall) {
    const path = String(toolCall.editToolCall?.args?.path || toolCall.editToolCall?.result?.success?.path || '')
    const base = path.split('/').pop() || 'file'
    const writing = subtype === 'started' || subtype === 'completed'
    return {
      isWrite: writing,
      status: writing ? 'Cursor editing files…' : undefined,
      activity: {
        kind: subtype === 'completed' ? 'output' : 'input',
        text: `CURSOR · edit ${base}`,
      },
    }
  }

  const shell = toolCall.shellToolCall || toolCall.bashToolCall || toolCall.terminalToolCall
  if (shell) {
    const cmd = String(shell?.args?.command || shell?.args?.cmd || 'command').slice(0, 80)
    return {
      isWrite: true,
      status: 'Cursor editing files…',
      activity: {
        kind: subtype === 'completed' ? 'output' : 'input',
        text: `CURSOR · shell ${cmd}`,
      },
    }
  }

  const keys = Object.keys(toolCall).filter(k => k.endsWith('ToolCall') || k === 'name')
  const name = keys[0]?.replace(/ToolCall$/, '') || 'tool'
  return {
    isWrite: false,
    activity: {
      kind: subtype === 'completed' ? 'output' : 'input',
      text: `CURSOR · ${name}`,
    },
  }
}

function buildCursorPrompt(systemPrompt: string, fullQuery: string): string {
  return [
    'SYSTEM INSTRUCTIONS',
    systemPrompt,
    '',
    'USER REQUEST',
    fullQuery,
  ].join('\n')
}

/**
 * Extract assistant delta text only when `timestamp_ms` is present.
 * Thinking events and the final assistant flush (no timestamp_ms) are skipped.
 */
export function extractCursorResponseText(event: any): string {
  const type = String(event?.type ?? '').toLowerCase()
  if (type !== 'assistant') return ''
  if (typeof event?.timestamp_ms !== 'number') return ''
  if (event?.model_call_id != null && event.model_call_id !== '') return ''

  const content = event?.message?.content
  if (Array.isArray(content)) {
    let text = ''
    for (const block of content) {
      if (typeof block === 'string') text += block
      else if (typeof block?.text === 'string') text += block.text
    }
    return text
  }
  if (typeof event?.text === 'string') return event.text
  return ''
}

export function extractCursorSessionId(event: any): string | undefined {
  const candidate = event?.session_id ?? event?.sessionId
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

function safeCursorUserError(message: string): string {
  const code = classifyCursorError(message)
  if (code === 'cursor.cli_unavailable') return 'Cursor CLI unavailable. Check server Settings.'
  if (code === 'cursor.auth_error') return 'Cursor auth failed. Run agent login on the Mac.'
  if (code === 'cursor.timeout') return 'Cursor timed out. Retry or start a new chat.'
  if (code === 'cursor.permission_denied') return 'Cursor permission failed.'
  return `Cursor failed (${code}). Retry or check CLI Debug.`
}

export async function callCursorStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  model: CursorModelPreference = CURSOR_COMPOSER_MODEL,
  images?: ModelImageInput[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  const sid = getOrCreateSession(sessionId)
  const history = getHistory(sid)
  const session = getSessionRaw(sid)
  const contextBreaks = session?.contextBreaks ?? []
  const historyPrompt = formatHistoryForPrompt(history, contextBreaks, reference)
  const handoffPrompt = options?.handoffContext?.promptBlock ? `\n\n${options.handoffContext.promptBlock}` : ''
  const contextPrompt = `${historyPrompt}${handoffPrompt}`
  const persistentCursorSession = isCursorPersistenceEnabled()
  const cursorCwd = getCursorExecutionCwd()
  const executionMode = normalizeCursorExecutionMode(options?.cursorExecutionMode)

  await getCursorModelCatalog()
  const resolvedOption = resolveCursorModelOption(model)
  const agentBinary = resolveAgentBinary()
  if (!agentBinary || !resolvedOption?.id) {
    const msg = !agentBinary
      ? 'cursor-bridge: Cursor agent binary not found on PATH or ~/.local/bin/agent.'
      : `cursor-bridge: Cursor model slot ${model} is not resolved.`
    await callbacks.onError(safeCursorUserError(msg))
    return sid
  }

  const engineSession = persistentCursorSession
    ? getCursorEngineSession({ cosSessionId: sid, model, cwd: cursorCwd, executionMode })
    : null

  // Inbound phone photos are not yet wired into Cursor CLI args (Phase 1.5).
  // Outbound run-scoped images still use the Release C publisher so traffic
  // frames and other agent visuals can attach to the assistant message.
  const imageInputs: ModelImageInput[] = images ?? []
  const imagePaths: string[] = imageInputs.map(i => i.path)
  const outputImageBudget = Math.max(0, MAX_ATTACHMENTS_PER_PROMPT - imageInputs.length)
  const startTime = Date.now()
  const run = startCursorRun({
    turnId: options?.turnId,
    clientJobId: options?.clientJobId,
    cosSessionId: sid,
    model,
    cwd: cursorCwd,
    resumed: !!engineSession,
    cursorChatId: engineSession?.cursorSessionId,
    expiresAt: engineSession?.expiresAt,
    cliModel: resolvedOption.id,
    query,
    messageEra: options?.messageEra,
    globalMsgNum: options?.globalMsgNum ?? globalMsgNum,
  })
  let outputImagePublisher: ReturnType<typeof createRunOutputImagePublisher> | null = null
  if (!options?.lightweight && outputImageBudget > 0) {
    try {
      outputImagePublisher = createRunOutputImagePublisher({
        sessionId: sid,
        globalMsgNum,
        runId: run.runId,
        maxImages: outputImageBudget,
      })
    } catch (err) {
      console.error('[cursor-bridge] output image publisher unavailable:', err)
    }
  }

  let cursorChatId: string | undefined = engineSession?.cursorSessionId
  callbacks.onStart?.(model, sid, undefined, {
    cursorRunId: run.runId,
    cursorChatId,
  })

  let phase: Phase = 'context'
  let systemPrompt: string
  try {
    if (options?.lightweight) {
      systemPrompt = buildLightweightSystemPrompt(query, contextPrompt)
    } else {
      callbacks.onToolStatus?.('Loading context...')
      systemPrompt = await buildSystemPrompt(contextPrompt)
    }
    if (executionMode === 'agent') {
      systemPrompt = `${systemPrompt}\n\nCURSOR AGENT MODE: You run in the user's selected local workspace via Cursor Agent. Prefer surgical edits. File and shell tools are allowed. Announce destructive operations briefly in your reply.`
    }
    if (outputImagePublisher) {
      systemPrompt = `${systemPrompt}\n\n${outputImagePublisher.promptInstructions}`
    }
  } catch (err: any) {
    outputImagePublisher?.cleanup()
    finishCursorRun(run.runId, {
      status: 'failed',
      startedAtMs: startTime,
      error: `cursor-bridge: context build failed — ${err?.message ?? 'unknown error'}`,
      exitCode: null,
    })
    cleanupModelImageInputs(imageInputs)
    throw err
  }

  phase = 'thinking'
  callbacks.onToolStatus?.('Reasoning...')

  const isFirstQuery = isNewSession(sid)
  const photoPrefix = imagePaths.length === 1 ? '[Photo]' : imagePaths.length > 1 ? `[${imagePaths.length} Photos]` : ''
  const historyQuery = photoPrefix ? `${photoPrefix} ${query || 'What do you see?'}` : query
  const jobGeneration = options?.jobGeneration ?? options?.generation
  const durableIdentity = options?.clientJobId && Number.isSafeInteger(jobGeneration) && jobGeneration! > 0
    ? { clientJobId: options.clientJobId, generation: jobGeneration! } : undefined
  const inboundAttachments = imageInputs.length > 0 ? imageInputs.map(i => i.attachment) : undefined
  const pendingUserExchange = durableIdentity
    ? reconcileExchangeByJobIdentity(
      sid, durableIdentity, 'user', historyQuery, globalMsgNum, inboundAttachments,
      undefined, model,
    ).exchange
    : addExchange(
      sid, 'user', historyQuery, globalMsgNum, inboundAttachments, durableIdentity, model,
    )

  let fullQuery = query
  if (imagePaths.length > 0) {
    fullQuery = `${query || 'Describe what you see.'}\n\n(Note: glasses photo attachments are not wired for Cursor ask-mode yet.)`
  }

  const prompt = buildCursorPrompt(systemPrompt, fullQuery)
  const args = buildCursorAgentArgs({
    workspace: cursorCwd,
    modelId: resolvedOption.id,
    executionMode,
    resumeSessionId: engineSession?.cursorSessionId,
  })

  const env = { ...process.env }
  delete env.CLAUDECODE
  if (outputImagePublisher) Object.assign(env, outputImagePublisher.env)

  const proc = spawn(agentBinary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: cursorCwd,
  })

  let fullText = ''
  let stderr = ''
  let buffer = ''
  let finalized = false
  let terminalTextError: string | null = null
  let resultText: string | null = null
  let sawCursorWrite = false

  function cleanupImages() {
    cleanupModelImageInputs(imageInputs)
  }

  function cleanup() {
    clearInterval(heartbeat)
    clearTimeout(inactivityTimer)
    clearTimeout(wallTimer)
    options?.abortSignal?.removeEventListener('abort', handleAbort)
  }

  function clearEngineSessionBestEffort(reason: string) {
    if (!engineSession && !cursorChatId) return
    try {
      clearCursorEngineSession(sid, model)
    } catch (error) {
      console.error(`[cursor-bridge] engine session clear failed (${reason}):`, error)
    }
  }

  function saveEngineSessionBestEffort() {
    if (!persistentCursorSession || !cursorChatId) return
    try {
      const saved = saveCursorEngineSession({
        cosSessionId: sid,
        model,
        cursorSessionId: cursorChatId,
        cwd: cursorCwd,
        executionMode,
      })
      updateCursorRun(run.runId, { cursorChatId, expiresAt: saved.expiresAt })
    } catch (error) {
      console.error('[cursor-bridge] engine session save failed:', error)
    }
  }

  function finishRunBestEffort(input: Parameters<typeof finishCursorRun>[1]) {
    try {
      finishCursorRun(run.runId, input)
    } catch (error) {
      console.error('[cursor-bridge] run ledger finalization failed:', error)
    }
  }

  function emitText(text: string) {
    if (!text) return
    phase = 'generating'
    fullText += text
    callbacks.onChunk(text)
  }

  async function finalize(text: string) {
    if (finalized) return
    const responseAuthenticationError = terminalProviderAuthFailure('cursor', text)
    const authenticationError = responseAuthenticationError
      ?? (!text.trim() ? terminalTextError ?? terminalProviderAuthFailure('cursor', stderr) : null)
    if (authenticationError) {
      await finalizeError(authenticationError, 0)
      return
    }
    if (!text.trim()) {
      await finalizeError('cursor-bridge: Cursor completed without a response.', 0)
      return
    }
    finalized = true
    cleanup()
    cleanupImages()

    try {
      const answerOwned = await callbacks.onAnswerReady?.(text)
      if (answerOwned === false) {
        removeExchange(sid, pendingUserExchange)
        clearEngineSessionBestEffort('answer_ownership_lost')
        finishRunBestEffort({
          status: 'failed',
          startedAtMs: startTime,
          error: 'cursor-bridge: durable answer ownership was lost.',
          exitCode: null,
        })
        return
      }
    } catch (error) {
      console.error('[cursor-bridge] durable answer barrier failed:', error)
      removeExchange(sid, pendingUserExchange)
      clearEngineSessionBestEffort('answer_barrier')
      finishRunBestEffort({
        status: 'failed',
        startedAtMs: startTime,
        error: 'cursor-bridge: durable answer persistence failed.',
        exitCode: null,
      })
      try {
        await callbacks.onError('cursor-bridge: durable answer persistence failed.')
      } catch (callbackError) {
        console.error('[cursor-bridge] durable barrier error callback failed:', callbackError)
      }
      return
    }

    const assistantExchange = durableIdentity
      ? reconcileExchangeByJobIdentity(
        sid, durableIdentity, 'assistant', text, globalMsgNum, undefined, undefined, model,
      ).exchange
      : addExchange(sid, 'assistant', text, globalMsgNum, undefined, durableIdentity, model)
    if (imagePaths.length > 0) {
      replaceLastExchangeWithSummary(sid, query, text, imagePaths.length)
    }

    let outputAttachments: MediaAttachmentRef[] = []
    let outputImageStats: RunOutputImageCollectionStats | undefined
    if (outputImagePublisher) {
      callbacks.onToolStatus?.('Preparing images...')
      const preparingHeartbeat = setInterval(() => {
        callbacks.onToolStatus?.('Preparing images...')
      }, HEARTBEAT_INTERVAL_MS)
      preparingHeartbeat.unref?.()
      try {
        outputAttachments = await collectRunOutputImagesBounded(outputImagePublisher, {
          signal: options?.abortSignal,
        })
      } catch (err) {
        console.error('[cursor-bridge] output image collection failed:', err)
      } finally {
        clearInterval(preparingHeartbeat)
        outputImageStats = outputImagePublisher.stats
        outputImagePublisher.cleanup()
      }
      if (outputAttachments.length > 0) {
        setExchangeAttachments(sid, assistantExchange, outputAttachments)
      }
      if (outputImageStats && outputImageStats.rejected > 0) {
        callbacks.onToolStatus?.(outputImageStats.attached > 0
          ? 'Some images could not be attached'
          : 'Image attachment unavailable')
      }
    }

    const totalMs = Date.now() - startTime
    logTokenAudit({
      source: options?.lightweight ? 'g2-voice' : 'g2-query',
      model,
      inputChars: systemPrompt.length + fullQuery.length + contextPrompt.length,
      outputChars: text.length,
      durationMs: totalMs,
      caller: options?.lightweight ? 'voice_query' : 'full_query',
      turnId: options?.turnId,
      runId: run.runId,
      sessionId: sid,
      clientJobId: options?.clientJobId,
      usageKind: 'estimated',
    })
    saveEngineSessionBestEffort()

    finishRunBestEffort({
      status: 'completed',
      startedAtMs: startTime,
      output: text,
      exitCode: 0,
    })
    try {
      const terminalOwned = await callbacks.onDone(text, model, undefined, {
        cursorRunId: run.runId,
        cursorChatId,
        turnId: options?.turnId,
        clientJobId: options?.clientJobId,
        ...(outputAttachments.length > 0 ? { outputAttachments } : {}),
        ...(outputImageStats && outputImageStats.published > 0 ? { outputImageStats } : {}),
      })
      if (terminalOwned === false) return
    } catch (error) {
      console.error('[cursor-bridge] terminal completion callback failed:', error)
    }

    if (isFirstQuery) {
      notifySessionStart(sid, query)
      markSessionNotified(sid)
    }
    notifyExchange(sid, query, text)
  }

  async function finalizeError(msg: string, exitCode?: number | null, status: Exclude<CursorRunStatus, 'running'> = 'failed') {
    if (finalized) return
    finalized = true
    cleanup()
    cleanupImages()
    outputImagePublisher?.cleanup()
    removeExchange(sid, pendingUserExchange)
    clearEngineSessionBestEffort('provider_error')
    finishRunBestEffort({
      status,
      startedAtMs: startTime,
      error: msg,
      exitCode,
    })
    try {
      await callbacks.onError(safeCursorUserError(msg))
    } catch (error) {
      console.error('[cursor-bridge] terminal error callback failed:', error)
    }
  }

  function handleAbort() {
    if (finalized) return
    proc.kill('SIGTERM')
    finalizeError('cursor-bridge: client disconnected before Cursor completed.', null, 'client_disconnected')
  }

  const heartbeat = setInterval(() => {
    if (finalized) return
    callbacks.onToolStatus?.(PHASE_LABELS[phase] ?? 'Processing...')
  }, HEARTBEAT_INTERVAL_MS)

  let inactivityTimer = setTimeout(() => {
    proc.kill('SIGTERM')
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    finalizeError(`No output for ${INACTIVITY_MS / 1000}s (${elapsed}s total). Cursor process killed.`)
  }, INACTIVITY_MS)

  function resetInactivity() {
    clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => {
      proc.kill('SIGTERM')
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      finalizeError(`No output for ${INACTIVITY_MS / 1000}s (${elapsed}s total). Cursor process killed.`)
    }, INACTIVITY_MS)
  }

  const wallTimer = setTimeout(() => {
    proc.kill('SIGTERM')
    if (fullText || resultText) {
      void finalize(resultText || fullText)
    } else {
      finalizeError(`Wall clock limit reached (${WALL_MAX_MS / 1000}s). Cursor process killed.`)
    }
  }, WALL_MAX_MS)

  function handleEvent(event: any) {
    const nextSessionId = extractCursorSessionId(event)
    if (nextSessionId && nextSessionId !== cursorChatId) {
      cursorChatId = nextSessionId
      updateCursorRun(run.runId, { cursorChatId })
    }

    if (event?.type === 'system' && event?.subtype === 'init') {
      callbacks.onToolStatus?.(
        executionMode === 'agent' ? 'Starting Cursor Agent...' : 'Starting Cursor Ask...',
      )
    }

    const toolActivity = extractCursorToolActivity(event)
    if (toolActivity.isWrite) sawCursorWrite = true
    if (toolActivity.status) callbacks.onToolStatus?.(toolActivity.status)
    else if (sawCursorWrite && event?.type === 'assistant') {
      // Keep write flag visible over generic drafting status.
      callbacks.onToolStatus?.('Cursor editing files…')
    }
    if (toolActivity.activity) callbacks.onActivityLine?.(toolActivity.activity)

    const text = extractCursorResponseText(event)
    if (text) {
      const authenticationError = terminalProviderAuthFailure('cursor', text)
      if (authenticationError) terminalTextError = authenticationError
      else emitText(text)
    }

    if (event?.type === 'result') {
      if (event?.subtype === 'success' && event?.is_error !== true) {
        const result = typeof event?.result === 'string' ? event.result : fullText
        resultText = result
        void finalize(result || fullText)
      } else {
        const raw = typeof event?.result === 'string' ? event.result
          : typeof event?.error === 'string' ? event.error
            : 'unknown error'
        const authenticationError = terminalProviderAuthFailure('cursor', raw)
        finalizeError(authenticationError ?? `cursor-bridge: ${raw}`)
      }
    }
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    resetInactivity()
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        handleEvent(JSON.parse(trimmed))
      } catch {
        terminalTextError ??= terminalProviderAuthFailure('cursor', trimmed)
      }
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    resetInactivity()
    stderr += chunk.toString()
  })

  proc.on('close', (code) => {
    if (buffer.trim()) {
      try {
        handleEvent(JSON.parse(buffer.trim()))
      } catch {
        terminalTextError ??= terminalProviderAuthFailure('cursor', buffer.trim())
      }
    }
    if (finalized) return
    if (resultText || fullText) {
      void finalize(resultText || fullText)
      return
    }
    const authenticationError = terminalTextError
      ?? terminalProviderAuthFailure('cursor', stderr, buffer)
    if (authenticationError) {
      finalizeError(authenticationError, code)
      return
    }
    if (code !== 0) {
      finalizeError(`cursor-bridge: exit ${code} — ${stderr.trim().slice(0, 240)}`, code)
    } else {
      finalizeError('cursor-bridge: Cursor completed without a response.')
    }
  })

  proc.on('error', (err) => {
    finalizeError(`cursor-bridge: ${err.message}`)
  })
  proc.stdin.on('error', (err) => {
    finalizeError(`cursor-bridge: stdin failed — ${err.message}`)
  })

  if (options?.abortSignal) {
    if (options.abortSignal.aborted) {
      handleAbort()
      return sid
    }
    options.abortSignal.addEventListener('abort', handleAbort, { once: true })
  }

  try {
    const providerOwned = await callbacks.onProviderProcess?.({
      provider: 'cursor',
      runId: run.runId,
      pid: proc.pid,
      clientJobId: options?.clientJobId,
      generation: options?.jobGeneration ?? options?.generation,
    })
    if (providerOwned === false) {
      proc.kill('SIGTERM')
      finalized = true
      cleanup()
      cleanupImages()
      outputImagePublisher?.cleanup()
      removeExchange(sid, pendingUserExchange)
      clearEngineSessionBestEffort('provider_ownership_lost')
      finishRunBestEffort({
        status: 'failed',
        startedAtMs: startTime,
        error: 'cursor-bridge: durable provider ownership was lost.',
        exitCode: null,
      })
      return sid
    }
    if (finalized) return sid
    proc.stdin.write(prompt)
    proc.stdin.end()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!finalized) {
      proc.kill('SIGTERM')
      await finalizeError(`cursor-bridge: provider start failed — ${message}`)
    }
  }

  return sid
}
