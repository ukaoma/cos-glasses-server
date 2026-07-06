// Claude bridge — streaming interface to claude -p with context injection
// Uses streaming-json output, web search tools, conversation history
//
// Timeout strategy:
//   INACTIVITY timeout (resets on any stdout data) — catches truly stalled processes
//   WALL CLOCK max — absolute cap regardless of activity
//   HEARTBEAT — emits progress events during silence so the display stays alive

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { cosBrainDir } from './launch-dir.js'
import { logTokenAudit } from './token-audit.js'
import { buildSystemPrompt, buildLightweightSystemPrompt, buildPrewarmSystemPrompt, getCachedContextInstant } from './context-builder.js'
import { getHistory, addExchange, formatHistoryForPrompt, getOrCreateSession, isNewSession, markSessionNotified, getSessionModel, getSessionRaw, replaceLastExchangeWithSummary, type ModelPreference, type PromptReference } from './conversation.js'
import { notifySessionStart, notifyExchange } from './telegram-notify.js'
import { isClaudeModel, DEFAULT_MODEL, type ClaudeModelPreference } from '../../shared/model-preference.js'
import {
  finishClaudeRun,
  getClaudeEffortLevel,
  startClaudeRun,
  updateClaudeRun,
} from './claude-run-ledger.js'

// Inactivity = no stdout data for this long → kill (catches stalls)
const INACTIVITY_BY_MODEL: Record<ClaudeModelPreference, number> = {
  opus: 180_000,    // 3 minutes — Opus can gap during tool use (WebSearch, reasoning)
  sonnet: 30_000,   // 30 seconds
  haiku: 15_000,    // 15 seconds
}

// Wall clock max = absolute cap even if actively streaming
const WALL_MAX_BY_MODEL: Record<ClaudeModelPreference, number> = {
  opus: 600_000,    // 10 minutes
  sonnet: 120_000,  // 2 minutes
  haiku: 60_000,    // 1 minute
}
const WALL_MAX_EXTENDED_MS = 900_000     // 15 minutes for slash commands / heavy queries

// Heartbeat = emit progress status during silence so client knows we're alive
const HEARTBEAT_INTERVAL_MS = 6_000    // Every 6 seconds

// ─── CLI session persistence ───
// Maps COS session IDs + Claude model → Claude CLI session IDs for process reuse.
// First query in a session spawns fresh. Subsequent queries use --resume
// so the CLI has warm cached context (avoids re-processing system prompt).
const cliSessionMap = new Map<string, string>()

// ─── CLI pre-warm ───
// At server boot, we spawn a throwaway Haiku query to establish a CLI session.
// This pre-warmed session ID is used for the FIRST query in any new COS session,
// eliminating the 2-15s cold start. After that, each session maps to its own CLI session.
let preWarmedCliSessionId: string | null = null
let preWarmInProgress = false

// ─── CLI session disk persistence ───
// Persists CLI session IDs to /tmp (NOT server/data/ — iCloud sync risk).
// Survives server restarts. TTL: 2 hours (matches conversation SESSION_TTL_MS).
const CLI_SESSIONS_FILE = '/tmp/cos-cli-sessions.json'
const CLI_SESSION_TTL_MS = 2 * 60 * 60_000  // 2 hours

interface CliSessionsData {
  preWarmedCliSessionId: string | null
  cliSessionMap: Record<string, { cliSessionId: string; savedAt: number }>
  savedAt: string
}

function cliSessionKey(cosSessionId: string, model: ClaudeModelPreference): string {
  return `${cosSessionId}:${model}`
}

function getAnyCliSessionId(cosSessionId: string): string | undefined {
  for (const [key, cliId] of cliSessionMap) {
    if (key === cosSessionId || key.startsWith(`${cosSessionId}:`)) return cliId
  }
  return undefined
}

function loadCliSessions(): void {
  // Don't restore stale sessions — they have no model affinity tag,
  // so a Haiku session could be reused for an Opus query via --resume,
  // causing model inheritance issues. Fresh pre-warm on boot is sufficient.
  try {
    if (existsSync(CLI_SESSIONS_FILE)) {
      unlinkSync(CLI_SESSIONS_FILE)
      console.log('[claude-bridge] Cleared stale CLI session cache (fresh start)')
    }
  } catch {
    // Ignore — file may not exist
  }
}

let cliSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleCliSessionSave(): void {
  if (cliSaveTimer) return
  cliSaveTimer = setTimeout(() => {
    cliSaveTimer = null
    saveCliSessions()
  }, 500)
}

function saveCliSessions(): void {
  try {
    const mapEntries: Record<string, { cliSessionId: string; savedAt: number }> = {}
    const now = Date.now()
    for (const [cosId, cliId] of cliSessionMap) {
      mapEntries[cosId] = { cliSessionId: cliId, savedAt: now }
    }
    const data: CliSessionsData = {
      preWarmedCliSessionId,
      cliSessionMap: mapEntries,
      savedAt: new Date().toISOString(),
    }
    writeFileSync(CLI_SESSIONS_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('[claude-bridge] Failed to save CLI sessions:', err)
  }
}

// Load persisted sessions on module init
loadCliSessions()

/** Expose CLI session ID for a given COS session (used by API routes) */
export function getCliSessionId(cosSessionId: string): string | undefined {
  const sessionModel = getSessionModel(cosSessionId)
  if (sessionModel && isClaudeModel(sessionModel)) {
    return cliSessionMap.get(cliSessionKey(cosSessionId, sessionModel)) ?? getAnyCliSessionId(cosSessionId)
  }
  return getAnyCliSessionId(cosSessionId)
}

/** Get the best available CLI session ID — mapped session > pre-warmed > undefined */
export function getAvailableCliSessionId(cosSessionId?: string): string | undefined {
  if (cosSessionId) {
    const mapped = getCliSessionId(cosSessionId)
    if (mapped) return mapped
  }
  return preWarmedCliSessionId ?? undefined
}

// ─── Latency logging ───
import { dataPath } from './data-dir.js'
const LATENCY_LOG_FILE = dataPath('latency-log.jsonl')

export interface LatencyEntry {
  timestamp: string
  query: string
  ttfb_ms: number
  total_ms: number
  model: string
  resumed: boolean
  contextInjected: boolean
  cacheHit: boolean
  stream_requested?: boolean
  deduped?: boolean
}

export function logLatency(entry: LatencyEntry): void {
  try {
    appendFileSync(LATENCY_LOG_FILE, JSON.stringify(entry) + '\n')
  } catch { /* ignore — non-critical */ }
}

/**
 * Pre-warm the Claude CLI by running a minimal Haiku query at server boot.
 * Captures the CLI session ID so the first real query can use --resume.
 * Called from index.ts alongside prewarmContext().
 */
export async function preWarmCLI(): Promise<void> {
  if (preWarmInProgress) return
  preWarmInProgress = true

  const start = Date.now()
  console.log('[claude-bridge] Pre-warming CLI session...')

  return new Promise<void>((resolve) => {
    const env = { ...process.env }
    delete env.CLAUDECODE

    const proc = spawn('claude', [
      '-p',
      '--model', DEFAULT_MODEL,  // Must match default query model — --resume inherits session model
      '--effort', getClaudeEffortLevel(),
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--system-prompt', buildPrewarmSystemPrompt(),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: COS_SCRIPTS_DIR ?? cosBrainDir() ?? process.cwd(),
    })

    let buffer = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          if (event.type === 'result' && event.session_id) {
            preWarmedCliSessionId = event.session_id
            scheduleCliSessionSave()
            const elapsed = Date.now() - start
            console.log(`[claude-bridge] CLI pre-warmed in ${elapsed}ms (session: ${event.session_id.slice(0, 12)}...)`)
          }
        } catch { /* ignore */ }
      }
    })

    proc.on('close', () => {
      preWarmInProgress = false
      const elapsed = Date.now() - start
      logTokenAudit({
        source: 'g2-prewarm',
        model: 'opus',
        inputChars: 500,  // system prompt + "ready"
        outputChars: 50,
        durationMs: elapsed,
        caller: 'prewarm',
      })
      if (!preWarmedCliSessionId) {
        console.warn('[claude-bridge] CLI pre-warm completed but no session ID captured')
      }
      resolve()
    })

    proc.on('error', (err) => {
      preWarmInProgress = false
      console.error('[claude-bridge] CLI pre-warm failed:', err.message)
      resolve()
    })

    // 30s safety timeout — don't block server start forever
    setTimeout(() => {
      if (preWarmInProgress) {
        proc.kill('SIGTERM')
        preWarmInProgress = false
        console.warn('[claude-bridge] CLI pre-warm timed out (30s)')
        resolve()
      }
    }, 30_000)

    // Send minimal query and close stdin
    proc.stdin.write('ready')
    proc.stdin.end()
  })
}

function isExtendedQuery(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.startsWith('/')) return true
  if (/\b(morning|sync|briefing|dashboard|compare|analyze|research|summarize)\b/i.test(trimmed)) return true
  // Long queries (100+ chars) tend to be complex
  if (trimmed.length > 100) return true
  return false
}

export interface ModelRunMetadata {
  codexRunId?: string
  codexThreadId?: string
}

export interface StreamCallbacks {
  onChunk: (text: string) => void
  onDone: (fullText: string, model: ModelPreference, cliSessionId?: string, metadata?: ModelRunMetadata) => void
  onError: (error: string) => void
  onToolStatus?: (toolName: string) => void
  onStart?: (model: ModelPreference, sessionId: string, cliSessionId?: string, metadata?: ModelRunMetadata) => void
}

type Phase = 'context' | 'thinking' | 'searching' | 'generating'

const PHASE_LABELS: Record<Phase, string> = {
  context: 'Loading context...',
  thinking: 'Thinking...',
  searching: 'Searching...',
  generating: 'Writing...',
}

/**
 * Call Claude with streaming output, conversation history, and COS context.
 * Returns the session ID for multi-turn tracking.
 */
export interface CallOptions {
  lightweight?: boolean  // Skip async context fetch — use cached context instantly (G2 speed path)
  abortSignal?: AbortSignal
}

export async function callClaudeStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  model?: ClaudeModelPreference,
  images?: string[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  // Get or create session
  const sid = getOrCreateSession(sessionId)
  const history = getHistory(sid)
  const session = getSessionRaw(sid)
  const contextBreaks = session?.contextBreaks ?? []
  const historyPrompt = formatHistoryForPrompt(history, contextBreaks, reference)
  const contextPrompt = historyPrompt

  // Resolve model: per-message > session preference > opus default
  const sessionModel = getSessionModel(sid)
  const resolvedModel: ClaudeModelPreference = model ?? (sessionModel && isClaudeModel(sessionModel) ? sessionModel : 'opus')

  // Notify client immediately — model is known before any async work
  // Pass existing CLI session ID if resuming (new sessions get it after first result)
  const resolvedCliKey = cliSessionKey(sid, resolvedModel)
  let existingCliSession = cliSessionMap.get(resolvedCliKey)
  callbacks.onStart?.(resolvedModel, sid, existingCliSession)

  // Phase: context loading (skipped in lightweight mode)
  let phase: Phase = 'context'

  let systemPrompt: string
  if (options?.lightweight) {
    // G2 speed path — minimal system prompt, context only when needed
    systemPrompt = buildLightweightSystemPrompt(query, contextPrompt)
  } else {
    callbacks.onToolStatus?.('Loading context...')
    // Full COS path — async context with Python subprocess calls
    systemPrompt = await buildSystemPrompt(contextPrompt)
  }

  // Phase: thinking (waiting for Claude to start)
  phase = 'thinking'
  callbacks.onToolStatus?.('Thinking...')

  // ── Vision: save temp image files if provided ──
  const imagePaths: string[] = []
  if (images && images.length > 0) {
    for (const img of images) {
      const id = crypto.randomUUID().slice(0, 8)
      const p = join('/tmp', `cos-vision-${id}.jpg`)
      writeFileSync(p, Buffer.from(img, 'base64'))
      imagePaths.push(p)
    }
  }

  // Check if this is the first query in a new session (before adding exchange)
  const isFirstQuery = isNewSession(sid)

  // Record user message (with [Photo]/[N Photos] prefix for vision queries)
  const photoPrefix = imagePaths.length === 1 ? '[Photo]' : imagePaths.length > 1 ? `[${imagePaths.length} Photos]` : ''
  const historyQuery = photoPrefix ? `${photoPrefix} ${query || 'What do you see?'}` : query
  addExchange(sid, 'user', historyQuery, globalMsgNum)

  // Vision queries need the Read tool to see the image files
  const tools = imagePaths.length > 0 ? 'WebSearch,WebFetch,Read' : 'WebSearch,WebFetch'

  // Prepend image instruction when photos are attached
  let fullQuery: string
  if (imagePaths.length === 1) {
    fullQuery = `The user has shared a photo from their phone camera. First, read the image file at ${imagePaths[0]} to see it. Then respond to their request: ${query || 'Describe what you see in this image concisely.'}`
  } else if (imagePaths.length > 1) {
    const fileList = imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')
    fullQuery = `The user has shared ${imagePaths.length} photos. Read each image file:\n${fileList}\nThen respond to their request: ${query || 'Describe what you see in these images concisely.'}`
  } else {
    fullQuery = query
  }

  // Check if we have a prior CLI session for this COS session.
  // If not, use the pre-warmed session (eliminates 2-15s cold start on first query).
  if (!existingCliSession && preWarmedCliSessionId && resolvedModel === 'opus') {
    // Only Opus queries consume the pre-warmed session (pre-warmed with Opus).
    // Hey Even (Haiku) cold-starts its own session to avoid model contamination.
    existingCliSession = preWarmedCliSessionId
    // Consume the pre-warmed session — next new session will cold start
    // (but by then the first session's CLI session exists for --resume)
    preWarmedCliSessionId = null
    scheduleCliSessionSave()
    console.log(`[claude-bridge] Using pre-warmed CLI session for first query (session: ${sid.slice(0, 8)}...)`)

    // Fire-and-forget: pre-warm a fresh session for the NEXT new COS session
    preWarmCLI().catch(() => {})
  }

  const args = [
    '-p',
    '--model', resolvedModel,
    '--effort', getClaudeEffortLevel(),
    '--output-format', 'stream-json',
    '--verbose',  // Required: stream-json requires --verbose
    '--dangerously-skip-permissions',  // Required: headless CLI mode with no TTY for user prompts
    '--system-prompt', systemPrompt,
  ]

  // Full COS path gets tools + partial messages; lightweight gets web search only
  if (options?.lightweight) {
    if (imagePaths.length > 0) {
      args.push('--allowedTools', tools)
    } else {
      // Lightweight: web search for general questions, no Bash/Read/Write (saves 5-10s)
      args.push('--allowedTools', 'WebSearch,WebFetch')
    }
  } else {
    args.push('--allowedTools', tools, '--include-partial-messages')
  }

  if (existingCliSession) {
    // Resume prior CLI session — reuses cached context, avoids cold start
    args.push('--resume', existingCliSession)
  }

  // Strip CLAUDECODE env var so claude -p doesn't think it's nested
  const env = { ...process.env }
  delete env.CLAUDECODE
  const cliCwd = COS_SCRIPTS_DIR ?? cosBrainDir() ?? process.cwd()
  const inactivityMs = INACTIVITY_BY_MODEL[resolvedModel]
  const defaultWallMax = WALL_MAX_BY_MODEL[resolvedModel]
  const wallMax = isExtendedQuery(query) ? WALL_MAX_EXTENDED_MS : defaultWallMax
  const startTime = Date.now()
  const run = startClaudeRun({
    cosSessionId: sid,
    model: resolvedModel,
    cwd: cliCwd,
    resumed: !!existingCliSession,
    cliSessionId: existingCliSession,
    timeoutMs: inactivityMs,
    wallMaxMs: wallMax,
    query: fullQuery,
  })

  const proc = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: cliCwd,
  })

  let fullText = ''
  let stderr = ''
  let buffer = ''
  let finalized = false        // Guard against double onDone/onError
  let lastActivity = Date.now() // Tracks last stdout data for inactivity timeout
  let receivedStreamEvents = false  // Track if CLI emits stream_event (vs older assistant-only format)

  function cleanupImages() {
    for (const p of imagePaths) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
  }

  function finalize(text: string) {
    if (finalized) return
    finalized = true
    cleanup()
    cleanupImages()

    // Token audit — log every completed claude -p call
    const totalMs = Date.now() - startTime
    const inputEstimate = systemPrompt.length + fullQuery.length + contextPrompt.length
    logTokenAudit({
      source: options?.lightweight ? 'g2-voice' : 'g2-query',
      model: resolvedModel,
      inputChars: inputEstimate,
      outputChars: text.length,
      durationMs: totalMs,
      caller: options?.lightweight ? 'voice_query' : 'full_query',
    })

    addExchange(sid, 'assistant', text, globalMsgNum)

    // Replace photo exchanges with condensed summaries to prevent context rot
    // while preserving enough context for follow-up questions
    if (imagePaths.length > 0) {
      replaceLastExchangeWithSummary(sid, query, text, imagePaths.length)
    }

    finishClaudeRun(run.runId, {
      status: 'completed',
      startedAtMs: startTime,
      output: text,
      exitCode: 0,
    })

    callbacks.onDone(text, resolvedModel, cliSessionMap.get(resolvedCliKey))

    // Telegram notifications — fire and forget
    if (isFirstQuery) {
      notifySessionStart(sid, query)
      markSessionNotified(sid)
    }
    notifyExchange(sid, query, text)
  }

  function finalizeError(msg: string, exitCode?: number | null) {
    if (finalized) return
    finalized = true
    cleanup()
    cleanupImages()
    finishClaudeRun(run.runId, {
      status: 'failed',
      startedAtMs: startTime,
      error: msg,
      exitCode,
    })
    callbacks.onError(msg)
  }

  // ─── Heartbeat: emit phase status during silence ───

  const heartbeat = setInterval(() => {
    if (finalized) return
    // The client owns elapsed-time rendering so repeated heartbeats do not
    // recreate visual pulses or duplicate "(72s)" suffixes.
    const msg = PHASE_LABELS[phase] ?? 'Processing...'
    callbacks.onToolStatus?.(msg)
  }, HEARTBEAT_INTERVAL_MS)

  // ─── Model-aware timeouts ───

  // ─── Inactivity timeout: resets on any stdout data ───

  let inactivityTimer = setTimeout(() => {
    proc.kill('SIGTERM')
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    finalizeError(`No output for ${inactivityMs / 1000}s (${elapsed}s total). Process killed.`)
  }, inactivityMs)

  function resetInactivity() {
    lastActivity = Date.now()
    clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => {
      proc.kill('SIGTERM')
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      finalizeError(`No output for ${inactivityMs / 1000}s (${elapsed}s total). Process killed.`)
    }, inactivityMs)
  }

  // ─── Wall clock max: absolute cap ───

  const wallTimer = setTimeout(() => {
    proc.kill('SIGTERM')
    if (fullText) {
      // Got partial output — deliver what we have
      finalize(fullText)
    } else {
      finalizeError(`Wall clock limit reached (${wallMax / 1000}s). Process killed.`)
    }
  }, wallMax)

  function cleanup() {
    clearInterval(heartbeat)
    clearTimeout(inactivityTimer)
    clearTimeout(wallTimer)
  }

  // ─── Process stdout ───

  proc.stdout.on('data', (chunk: Buffer) => {
    resetInactivity()
    buffer += chunk.toString()

    // Process complete JSON lines
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const event = JSON.parse(trimmed)

        if (event.type === 'stream_event') {
          // Real-time token streaming — fires every few tokens during generation
          receivedStreamEvents = true
          const inner = event.event
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
            phase = 'generating'
            fullText += inner.delta.text
            callbacks.onChunk(inner.delta.text)
          } else if (inner?.type === 'content_block_start' && inner.content_block?.type === 'thinking') {
            phase = 'thinking'
            callbacks.onToolStatus?.('Reasoning...')
          } else if (inner?.type === 'content_block_start' && inner.content_block?.type === 'tool_use' && inner.content_block.name) {
            const toolName = inner.content_block.name
            if (toolName === 'WebSearch' || toolName === 'WebFetch') {
              phase = 'searching'
            }
            callbacks.onToolStatus?.(toolName)
            if (toolName === 'Read') {
              callbacks.onToolStatus?.('Analyzing photo...')
            }
          }
        } else if (event.type === 'assistant') {
          // Fallback: only used if CLI doesn't emit stream_events (older CLI compatibility)
          // Format A (streaming-json): { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
          // Format B (legacy/chunk):   { type: "assistant", subtype: "text", content: "..." }
          if (!receivedStreamEvents) {
            let text = ''
            if (event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text) text += block.text
                if (block.type === 'tool_use' && block.name) {
                  if (block.name === 'WebSearch' || block.name === 'WebFetch') {
                    phase = 'searching'
                  }
                  callbacks.onToolStatus?.(block.name)
                  if (block.name === 'Read') {
                    callbacks.onToolStatus?.('Analyzing photo...')
                  }
                }
              }
            } else if (event.subtype === 'text' && typeof event.content === 'string') {
              text = event.content
            }
            if (text) {
              phase = 'generating'
              fullText += text
              callbacks.onChunk(text)
            }
          }
        } else if (event.type === 'result') {
          // Capture CLI session ID for future --resume (avoids cold start on next query)
          if (event.session_id) {
            cliSessionMap.set(resolvedCliKey, event.session_id)
            scheduleCliSessionSave()
            updateClaudeRun(run.runId, { cliSessionId: event.session_id })
          }
          // Final result — use accumulated text (more reliable than result.result)
          finalize(fullText || event.result || '')
        }
        // tool_use/tool_result/other events still reset inactivity (we got stdout data)
      } catch {
        // Not valid JSON — ignore partial lines
      }
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    // stderr activity also counts — Claude CLI logs progress there
    resetInactivity()
    stderr += chunk.toString()
  })

  proc.on('close', (code) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim())
        if (event.type === 'result') {
          finalize(fullText || event.result || '')
          return
        }
      } catch { /* ignore */ }
    }

    if (code !== 0 && !fullText) {
      finalizeError(`claude-bridge: exit ${code} — ${stderr.trim().slice(0, 200)}`, code)
    } else if (fullText) {
      // If we got text but no explicit result event, still finalize
      finalize(fullText)
    } else {
      cleanup() // No output, no error — just clean up timers
    }
  })

  proc.on('error', (err) => {
    finalizeError(`claude-bridge: ${err.message}`, null)
  })

  // Send query via stdin (fullQuery includes image instruction when vision)
  proc.stdin.write(fullQuery)
  proc.stdin.end()

  return sid
}
