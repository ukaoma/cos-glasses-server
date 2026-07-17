// Codex bridge — streaming-compatible interface to `codex exec --json`.
// Concrete GPT ids resolve from Codex's live model catalog at run time.

import { spawn, spawnSync } from 'node:child_process'
import { logTokenAudit } from './token-audit.js'
import { cleanupModelImageInputs, type ModelImageInput } from './model-image-input.js'
import { buildSystemPrompt, buildLightweightSystemPrompt } from './context-builder.js'
import {
  getHistory,
  addExchange,
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
  clearCodexEngineSession,
  getCodexEngineSession,
  saveCodexEngineSession,
  type CodexEngineSession,
} from './codex-engine-sessions.js'
import {
  CODEX_HIGH_MODEL,
  type CodexModelPreference,
  type EffortPreference,
} from '../../shared/model-preference.js'
import {
  getCodexModelCatalog,
  resolveCodexEffortForModel,
  resolveCodexModelOption,
  resolveCodexServiceTier,
  type CodexModelOption,
} from './codex-model-catalog.js'
import type { CallOptions, StreamCallbacks } from './claude-bridge.js'
import {
  classifyCodexError,
  extractCodexThreadId,
  finishCodexRun,
  getCodexExecutionCwd,
  isCodexPersistenceEnabled,
  getCodexTrustMode,
  startCodexRun,
  updateCodexRun,
  type CodexRunStatus,
} from './codex-run-ledger.js'
import { codexActivityPreviewLines } from './activity-preview.js'
import {
  collectRunOutputImagesBounded,
  createRunOutputImagePublisher,
  isRunOutputImagePublisherCommand,
  type RunOutputImageCollectionStats,
} from './run-output-images.js'
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'

const INACTIVITY_MS = 180_000
const WALL_MAX_MS = 900_000
const HEARTBEAT_INTERVAL_MS = 6_000

type Phase = 'context' | 'thinking' | 'generating'

const PHASE_LABELS: Record<Phase, string> = {
  context: 'Loading context...',
  thinking: 'Reasoning...',
  generating: 'Writing...',
}

// Sandbox policy for `codex exec`. This public server NEVER runs codex
// unsandboxed — that would let a remote glasses query execute arbitrary commands
// on the host. Default: read-only (safe for chat). COS_CODEX_SANDBOX=workspace-write
// permits writes within the working directory only. Full host access is
// intentionally not exposed by this server.
function codexSandboxArgs(): string[] {
  const mode = process.env.COS_CODEX_SANDBOX === 'workspace-write' ? 'workspace-write' : 'read-only'
  return ['--sandbox', mode, '--skip-git-repo-check']
}

let addDirSupported: boolean | undefined

/** Older Codex CLIs do not expose --add-dir. Probe lazily and disable only
 * output publishing when unavailable; chat remains read-only and functional. */
export function codexSupportsAdditionalDir(): boolean {
  if (addDirSupported !== undefined) return addDirSupported
  try {
    const result = spawnSync('codex', ['exec', '--help'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    addDirSupported = result.status === 0 && `${result.stdout}\n${result.stderr}`.includes('--add-dir')
  } catch {
    addDirSupported = false
  }
  return addDirSupported
}

export function buildCodexExecArgs(input: {
  codexCwd: string
  imagePaths?: string[]
  persistentCodexSession: boolean
  codexThreadId?: string
  model?: CodexModelPreference
  resolvedModel?: CodexModelOption
  effort?: EffortPreference
  publisherWritableDirectory?: string
}): string[] {
  const imagePaths = input.imagePaths ?? []
  const resolvedModel = input.resolvedModel
    ?? resolveCodexModelOption(input.model ?? CODEX_HIGH_MODEL)
  const reasoningEffort = resolveCodexEffortForModel(resolvedModel, input.effort)
  const serviceTier = resolveCodexServiceTier(resolvedModel)
  // Sandbox + publisher capability are global `codex exec` options and MUST
  // appear before the `resume` subcommand. The publisher grants write access
  // only to its random run directory; the rest of the host stays read-only.
  const args = ['exec', ...codexSandboxArgs()]
  if (input.publisherWritableDirectory) {
    args.push('--add-dir', input.publisherWritableDirectory)
  }

  const appendModelConfig = () => {
    if (resolvedModel.id) args.push('--model', resolvedModel.id)
    args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)
    if (serviceTier) args.push('-c', `service_tier="${serviceTier}"`)
  }

  if (input.codexThreadId) {
    args.push(
      'resume',
      '--json',
      '--all',
    )
    appendModelConfig()
    for (const p of imagePaths) args.push('--image', p)
    args.push(input.codexThreadId, '-')
    return args
  }

  args.push(
    '--json',
    '--cd', input.codexCwd,
  )
  appendModelConfig()
  if (!input.persistentCodexSession) args.push('--ephemeral')
  for (const p of imagePaths) args.push('--image', p)
  args.push('-')
  return args
}

function buildCodexPrompt(systemPrompt: string, fullQuery: string): string {
  return [
    'SYSTEM INSTRUCTIONS',
    systemPrompt,
    '',
    'USER REQUEST',
    fullQuery,
  ].join('\n')
}

/** Extract only observable assistant response text. Reasoning/tool payloads
 * must remain invisible even if a future Codex JSON shape also has delta or
 * content fields. */
export function extractCodexResponseText(event: any): string {
  const item = event?.item ?? event?.payload ?? event?.message ?? event
  const eventType = String(event?.type ?? '').toLowerCase()
  const itemType = String(item?.type ?? '').toLowerCase()
  const assistantEvent = /(?:^|[._-])(agent_message|assistant_message|output_text)(?:$|[._-])/.test(eventType)
    || /^(?:agent_message|assistant_message|output_text)$/.test(itemType)
  if (!assistantEvent) return ''

  if (typeof event?.delta === 'string') return event.delta
  if (typeof event?.text === 'string') return event.text
  if (typeof item?.text === 'string') return item.text

  const content = item?.content ?? event?.content
  if (Array.isArray(content)) {
    let text = ''
    for (const block of content) {
      if (typeof block === 'string') text += block
      const blockType = String(block?.type ?? '').toLowerCase()
      if (/(?:reasoning|thinking|tool|command|input)/.test(blockType)) continue
      if (typeof block?.output_text === 'string') text += block.output_text
      else if (typeof block?.text === 'string') text += block.text
      else if (typeof block?.content === 'string') text += block.content
    }
    return text
  }

  if (typeof item?.result === 'string') return item.result
  return ''
}

function toolStatus(event: any): string | undefined {
  const type = String(event?.type ?? '')
  const item = event?.item ?? event?.payload
  const itemType = String(item?.type ?? '')
  const name = item?.name ?? item?.tool_name

  if (type === 'thread.started') return 'Starting Codex...'
  if (type === 'turn.started') return 'Reasoning...'
  if (/patch/i.test(type) || /patch/i.test(itemType)) return 'Applying patch...'
  if (/command|exec|shell/i.test(type) || /command|exec|shell/i.test(itemType)) return 'Using shell...'
  if (/tool/i.test(type) || /tool/i.test(itemType)) {
    if (typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,24}$/.test(name)) return name
    return 'Using tool...'
  }
  return undefined
}

function safeCodexUserError(message: string): string {
  const code = classifyCodexError(message)
  if (code === 'codex.cli_unavailable') return 'Codex CLI unavailable. Check server Settings.'
  if (code === 'codex.auth_error') return 'Codex auth failed. Run codex login on the Mac.'
  if (code === 'codex.timeout') return 'Codex timed out. Retry or start a new chat.'
  if (code === 'codex.permission_denied') return 'Codex permission failed. Check COS_CODEX_SANDBOX and the work directory.'
  return `Codex failed (${code}). Retry or check Codex Debug.`
}

export async function callCodexStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  model: CodexModelPreference = CODEX_HIGH_MODEL,
  images?: ModelImageInput[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  const sid = getOrCreateSession(sessionId)
  // Refresh is TTL-cached and coalesced, so every run sees the newest known
  // catalog without creating duplicate app-server discovery processes.
  await getCodexModelCatalog()
  if (options?.abortSignal?.aborted) {
    throw new Error('codex-bridge: client disconnected before Codex started.')
  }
  const history = getHistory(sid)
  const session = getSessionRaw(sid)
  const contextBreaks = session?.contextBreaks ?? []
  const historyPrompt = formatHistoryForPrompt(history, contextBreaks, reference)
  const contextPrompt = historyPrompt
  const persistentCodexSession = isCodexPersistenceEnabled()
  const codexCwd = getCodexExecutionCwd()
  const codexTrustMode = getCodexTrustMode()
  const resolvedCodexModel = resolveCodexModelOption(model)
  const resolvedCodexEffort = resolveCodexEffortForModel(resolvedCodexModel, options?.effort)
  const engineSession = persistentCodexSession
    ? getCodexEngineSession({ cosSessionId: sid, model, cwd: codexCwd, trustMode: codexTrustMode })
    : null
  const imageInputs: ModelImageInput[] = images ?? []
  const imagePaths = imageInputs.map(input => input.path)
  const outputImageBudget = Math.max(0, MAX_ATTACHMENTS_PER_PROMPT - imageInputs.length)
  const startTime = Date.now()
  const run = startCodexRun({
    cosSessionId: sid,
    model,
    cwd: codexCwd,
    ephemeral: !persistentCodexSession,
    resumed: !!engineSession,
    trustMode: codexTrustMode,
    codexThreadId: engineSession?.codexThreadId,
    expiresAt: engineSession?.expiresAt,
    cliModel: resolvedCodexModel.id || 'codex-cli-default',
    reasoningEffort: resolvedCodexEffort,
    query,
  })
  let outputImagePublisher: ReturnType<typeof createRunOutputImagePublisher> | null = null
  if (!options?.lightweight && outputImageBudget > 0 && codexSupportsAdditionalDir()) {
    try {
      outputImagePublisher = createRunOutputImagePublisher({
        sessionId: sid,
        globalMsgNum,
        runId: run.runId,
        maxImages: outputImageBudget,
      })
    } catch (err) {
      console.error('[codex-bridge] output image publisher unavailable:', err)
    }
  }
  let codexThreadId: string | undefined = engineSession?.codexThreadId
  callbacks.onStart?.(model, sid, undefined, {
    codexRunId: run.runId,
    codexThreadId,
    clientJobId: options?.clientJobId,
    generation: options?.generation,
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
  } catch (err: any) {
    outputImagePublisher?.cleanup()
    finishCodexRun(run.runId, {
      status: 'failed',
      startedAtMs: startTime,
      error: `codex-bridge: context build failed — ${err?.message ?? 'unknown error'}`,
      exitCode: null,
    })
    throw err
  }
  if (outputImagePublisher) systemPrompt = `${systemPrompt}\n\n${outputImagePublisher.promptInstructions}`

  phase = 'thinking'
  callbacks.onToolStatus?.('Reasoning...')

  const isFirstQuery = isNewSession(sid)
  const photoPrefix = imagePaths.length === 1 ? '[Photo]' : imagePaths.length > 1 ? `[${imagePaths.length} Photos]` : ''
  const historyQuery = photoPrefix ? `${photoPrefix} ${query || 'What do you see?'}` : query
  const exchangeProvenance = {
    clientJobId: options?.clientJobId,
    generation: options?.generation,
  }
  const pendingUserExchange = addExchange(
    sid,
    'user',
    historyQuery,
    globalMsgNum,
    undefined,
    exchangeProvenance,
  )

  let fullQuery: string
  if (imagePaths.length === 1) {
    fullQuery = `The user has shared a photo from their phone camera. Use the attached image, then respond to their request: ${query || 'Describe what you see in this image concisely.'}`
  } else if (imagePaths.length > 1) {
    fullQuery = `The user has shared ${imagePaths.length} photos from their phone camera. Use the attached images, then respond to their request: ${query || 'Describe what you see in these images concisely.'}`
  } else {
    fullQuery = query
  }

  const prompt = buildCodexPrompt(systemPrompt, fullQuery)
  const args = buildCodexExecArgs({
    codexCwd,
    imagePaths,
    persistentCodexSession,
    codexThreadId: engineSession?.codexThreadId,
    model,
    resolvedModel: resolvedCodexModel,
    effort: options?.effort,
    publisherWritableDirectory: outputImagePublisher?.writableDirectory,
  })

  const env = { ...process.env }
  delete env.CLAUDECODE
  if (outputImagePublisher) Object.assign(env, outputImagePublisher.env)

  const proc = spawn('codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: codexCwd,
  })

  let fullText = ''
  let stderr = ''
  let buffer = ''
  let finalized = false
  let lastActivity = Date.now()
  const emittedBlocks = new Set<string>()

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
    if (!engineSession) return
    try {
      clearCodexEngineSession(sid, model)
    } catch (error) {
      console.error(`[codex-bridge] engine session clear failed (${reason}):`, error)
    }
  }

  function saveEngineSessionBestEffort() {
    if (!persistentCodexSession || !codexThreadId) return
    try {
      const saved = saveCodexEngineSession({
        cosSessionId: sid,
        model,
        codexThreadId,
        cwd: codexCwd,
        trustMode: codexTrustMode,
      })
      updateCodexRun(run.runId, { codexThreadId, expiresAt: saved.expiresAt })
    } catch (error) {
      // The resumable-thread cache is an optimization. Its filesystem failure
      // must never suppress the durable query terminal callback.
      console.error('[codex-bridge] engine session save failed:', error)
    }
  }

  function finishRunBestEffort(input: Parameters<typeof finishCodexRun>[1]) {
    try {
      finishCodexRun(run.runId, input)
    } catch (error) {
      console.error('[codex-bridge] run ledger finalization failed:', error)
    }
  }

  function emitText(text: string) {
    if (!text || emittedBlocks.has(text)) return
    emittedBlocks.add(text)
    phase = 'generating'
    fullText += text
    callbacks.onChunk(text)
  }

  async function finalize(text: string) {
    if (finalized) return
    finalized = true
    cleanup()
    cleanupImages()

    // The coordinator persists the final provider text before conversation
    // mutation, condensation, or output-image normalization can stall/crash.
    try {
      const answerOwned = await callbacks.onAnswerReady?.(text)
      if (answerOwned === false) {
        outputImagePublisher?.cleanup()
        removeExchange(sid, pendingUserExchange)
        clearEngineSessionBestEffort('answer_ownership_lost')
        finishRunBestEffort({
          status: 'failed',
          startedAtMs: startTime,
          error: 'codex-bridge: durable answer ownership was lost.',
          exitCode: null,
        })
        return
      }
    } catch (error) {
      console.error('[codex-bridge] durable answer barrier failed:', error)
      outputImagePublisher?.cleanup()
      removeExchange(sid, pendingUserExchange)
      clearEngineSessionBestEffort('answer_barrier')
      finishRunBestEffort({
        status: 'failed',
        startedAtMs: startTime,
        error: 'codex-bridge: durable answer persistence failed.',
        exitCode: null,
      })
      try {
        await callbacks.onError('codex-bridge: durable answer persistence failed.')
      } catch (callbackError) {
        console.error('[codex-bridge] durable barrier error callback failed:', callbackError)
      }
      return
    }

    const assistantExchange = addExchange(
      sid,
      'assistant',
      text,
      globalMsgNum,
      undefined,
      exchangeProvenance,
    )
    if (imagePaths.length > 0) {
      replaceLastExchangeWithSummary(sid, query, text, imagePaths.length)
    }

    let outputAttachments: MediaAttachmentRef[] = []
    let outputImageStats: RunOutputImageCollectionStats | undefined
    if (outputImagePublisher) {
      callbacks.onToolStatus?.('Preparing images...')
      const preparingHeartbeat = setInterval(() => callbacks.onToolStatus?.('Preparing images...'), HEARTBEAT_INTERVAL_MS)
      preparingHeartbeat.unref?.()
      try {
        outputAttachments = await collectRunOutputImagesBounded(outputImagePublisher, {
          signal: options?.abortSignal,
        })
      } catch (err) {
        console.error('[codex-bridge] output image collection failed:', err)
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
        codexRunId: run.runId,
        codexThreadId,
        clientJobId: options?.clientJobId,
        generation: options?.generation,
        ...(outputAttachments.length > 0 ? { outputAttachments } : {}),
        ...(outputImageStats && outputImageStats.published > 0 ? { outputImageStats } : {}),
      })
      if (terminalOwned === false) return
    } catch (error) {
      console.error('[codex-bridge] terminal completion callback failed:', error)
    }

    if (isFirstQuery) {
      notifySessionStart(sid, query)
      markSessionNotified(sid)
    }
    notifyExchange(sid, query, text)
  }

  async function finalizeError(msg: string, exitCode?: number | null, status: Exclude<CodexRunStatus, 'running'> = 'failed') {
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
      await callbacks.onError(safeCodexUserError(msg))
    } catch (error) {
      console.error('[codex-bridge] terminal error callback failed:', error)
    }
  }

  function handleAbort() {
    if (finalized) return
    proc.kill('SIGTERM')
    finalizeError('codex-bridge: client disconnected before Codex completed.', null, 'client_disconnected')
  }

  const heartbeat = setInterval(() => {
    if (finalized) return
    callbacks.onToolStatus?.(PHASE_LABELS[phase] ?? 'Processing...')
  }, HEARTBEAT_INTERVAL_MS)

  let inactivityTimer = setTimeout(() => {
    proc.kill('SIGTERM')
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    finalizeError(`No output for ${INACTIVITY_MS / 1000}s (${elapsed}s total). Codex process killed.`)
  }, INACTIVITY_MS)

  function resetInactivity() {
    lastActivity = Date.now()
    clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => {
      proc.kill('SIGTERM')
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      finalizeError(`No output for ${INACTIVITY_MS / 1000}s (${elapsed}s total). Codex process killed.`)
    }, INACTIVITY_MS)
  }

  const wallTimer = setTimeout(() => {
    proc.kill('SIGTERM')
    if (fullText) {
      void finalize(fullText)
    } else {
      finalizeError(`Wall clock limit reached (${WALL_MAX_MS / 1000}s). Codex process killed.`)
    }
  }, WALL_MAX_MS)

  function handleEvent(event: any) {
    const nextThreadId = extractCodexThreadId(event)
    if (nextThreadId && nextThreadId !== codexThreadId) {
      codexThreadId = nextThreadId
      updateCodexRun(run.runId, { codexThreadId })
    }

    const status = toolStatus(event)
    if (status) callbacks.onToolStatus?.(status)

    const command = event?.item?.command ?? event?.item?.input ?? event?.payload?.command ?? event?.payload?.input
    if (!isRunOutputImagePublisherCommand(command)) {
      for (const preview of codexActivityPreviewLines(event)) callbacks.onActivityLine?.(preview)
    }

    const text = extractCodexResponseText(event)
    if (text) emitText(text)

    const type = String(event?.type ?? '')
    if (type === 'turn.completed') {
      void finalize(fullText)
    } else if (type === 'turn.failed' || type === 'error') {
      finalizeError(`codex-bridge: ${event?.error ?? event?.message ?? 'unknown error'}`)
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
        // Ignore non-JSON status lines from older CLI builds.
      }
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    resetInactivity()
    stderr += chunk.toString()
  })

  proc.on('close', (code) => {
    if (buffer.trim()) {
      try { handleEvent(JSON.parse(buffer.trim())) } catch { /* ignore */ }
    }
    if (finalized) return
    if (code !== 0) {
      finalizeError(`codex-bridge: exit ${code} — ${stderr.trim().slice(0, 240)}`, code)
    } else if (fullText) {
      void finalize(fullText)
    } else {
      finalizeError('codex-bridge: Codex completed without a response.')
    }
  })

  proc.on('error', (err) => {
    finalizeError(`codex-bridge: ${err.message}`)
  })
  proc.stdin.on('error', (err) => {
    finalizeError(`codex-bridge: stdin failed — ${err.message}`)
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
      provider: 'codex',
      runId: run.runId,
      pid: proc.pid,
      clientJobId: options?.clientJobId,
      generation: options?.generation,
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
        error: 'codex-bridge: durable provider ownership was lost.',
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
      await finalizeError(`codex-bridge: provider start failed — ${message}`)
    }
  }

  return sid
}
