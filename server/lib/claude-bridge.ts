// Claude bridge — streaming interface to claude -p with context injection
// Uses streaming-json output, web search tools, conversation history
//
// Timeout strategy:
//   INACTIVITY timeout (resets on any stdout data) — catches truly stalled processes
//   WALL CLOCK max — absolute cap regardless of activity
//   HEARTBEAT — emits progress events during silence so the display stays alive

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { cleanupModelImageInputs, type ModelImageInput } from './model-image-input.js'
import { resolveProviderWorkDir } from './launch-dir.js'
import { logTokenAudit } from './token-audit.js'
import { buildSystemPrompt, buildLightweightSystemPrompt, buildPrewarmSystemPrompt, getCachedContextInstant } from './context-builder.js'
import { getHistory, addExchange, setExchangeAttachments, removeExchange, formatHistoryForPrompt, getOrCreateSession, isNewSession, markSessionNotified, getSessionModel, getSessionRaw, replaceLastExchangeWithSummary, type ModelPreference, type PromptReference } from './conversation.js'
import { notifySessionStart, notifyExchange } from './telegram-notify.js'
import {
  isClaudeModel,
  DEFAULT_MODEL,
  resolveClaudeCliModelId,
  resolveCliEffortFlag,
  ULTRACODE_KEYWORD,
  type ClaudeModelPreference,
  type EffortPreference,
} from '../../shared/model-preference.js'
import {
  finishClaudeRun,
  getClaudeEffortLevel,
  startClaudeRun,
  updateClaudeRun,
  type ClaudeRunStatus,
} from './claude-run-ledger.js'
import {
  claudeToolInputPreview,
  claudeToolResultPreviewLines,
  type ActivityPreviewLine,
} from './activity-preview.js'
import {
  collectRunOutputImagesBounded,
  createRunOutputImagePublisher,
  isRunOutputImagePublisherCommand,
  type RunOutputImageCollectionStats,
} from './run-output-images.js'
import {
  attachmentHistoryPrefix,
  defaultAttachmentRequest,
  MAX_ATTACHMENTS_PER_PROMPT,
  mediaCategoryOf,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'
import {
  buildClaudeToolList,
  claudeMcpConfigArgs,
  claudeToolCapabilityPrompt,
  readOnlyCapabilityPrompt,
} from './claude-tool-access.js'
import { terminalProviderAuthFailure } from './provider-terminal-error.js'
import { claudePermissionArgs, getClaudeTrustMode } from './claude-permissions.js'
import { terminateProviderProcess } from './provider-process-lifecycle.js'
import { teeJobTrail, type JobTrailDraft } from './job-trail.js'
import { claudeSupportsSessionName } from './claude-cli-support.js'
import { applyTurnRequestEnv, createTurnRequestBinding, spawnWithTurnRequest } from './turn-request.js'
import { STEER_REAPER_MS, STEER_SETTLE_MS, SteerTracker, composeFirstContent, encodeUserLine, steerClock, type SteerPort } from './claude-steer.js'
import { randomUUID } from 'node:crypto'
// Key lanes K1 P3 (plan v4 7): Lane B Claude. Every use below sits behind `options.keyProfile`;
// without one, argv, env, session keys and the pre-warm handoff are the b7c620e ones.
import { profilePreference } from '../../shared/key-preference.js'
import type { AnswerKeyFields, KeyKind, KeyProfile, RelayTurnHandle } from './key-relay-contract.js'
import { applyLaneBClaudeEnv, LANE_B_COPY, laneBClaudePreflight, laneBRelay } from './lane-b-env.js'
import { recordKeyedSession } from './keyed-sessions.js'
import { getSharedKeyMeter } from './key-relay-meter.js'
import { claudeKeySecretsGuardArgs } from './key-secrets-guard.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Inactivity = no stdout data for this long → kill (catches stalls)
const INACTIVITY_BY_MODEL: Record<ClaudeModelPreference, number> = {
  opus: 180_000,    // 3 minutes — Opus can gap during tool use (WebSearch, reasoning)
  fable: 180_000,   // 3 minutes — premium thinker, same gap tolerance as Opus
  sonnet: 30_000,   // 30 seconds
  haiku: 15_000,    // 15 seconds
}

// Wall clock max = absolute cap even if actively streaming
const WALL_MAX_BY_MODEL: Record<ClaudeModelPreference, number> = {
  opus: 600_000,    // 10 minutes
  fable: 900_000,   // 15 minutes — deepest model, longest single-turn runs
  sonnet: 120_000,  // 2 minutes
  haiku: 60_000,    // 1 minute
}
const WALL_MAX_EXTENDED_MS = 900_000     // 15 minutes for slash commands / heavy queries
const WALL_MAX_DEEP_EFFORT_MS = 1_200_000 // 20 minutes for max/ultracode

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

/** Key lanes (plan v4 7.1): a keyed turn's CLI session is its own key, never `${sid}:${tier}`. */
export function keyedCliSessionKey(cosSessionId: string, tier: ClaudeModelPreference, profileId: string): string {
  return `${cosSessionId}:${tier}:p:${profileId}`
}

function getAnyCliSessionId(cosSessionId: string): string | undefined {
  for (const [key, cliId] of cliSessionMap) {
    if (key === cosSessionId || key.startsWith(`${cosSessionId}:`)) {
      // Key lanes: a keyed CLI session is never handed out here (handoff, health, Continue). Only
      // the keyed turn itself reaches it, through its own exact key.
      if (key.includes(':p:', cosSessionId.length)) continue
      return cliId
    }
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
 * Pre-warm the Claude CLI by running a minimal default-model query at boot.
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
    // 'ready' is not a user query: no turn-request file, and never an inherited path.
    applyTurnRequestEnv(env, null)

    const proc = spawn('claude', [
      '-p',
      '--model', resolveClaudeCliModelId(DEFAULT_MODEL),
      '--effort', getClaudeEffortLevel(),
      '--output-format', 'stream-json',
      '--verbose',
      ...claudePermissionArgs(getClaudeTrustMode(), null),
      ...claudeKeySecretsGuardArgs(),
      '--system-prompt', buildPrewarmSystemPrompt(),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: resolveProviderWorkDir({ scriptsDir: COS_SCRIPTS_DIR }),
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
          if (event.type === 'result' && event.session_id && !claudeResultErrorMessage(event)) {
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
        model: DEFAULT_MODEL,
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
  claudeRunId?: string
  clientJobId?: string
  generation?: number
  turnId?: string
  codexRunId?: string
  codexThreadId?: string
  cursorRunId?: string
  cursorChatId?: string
  ollamaRunId?: string
  outputAttachments?: MediaAttachmentRef[]
  outputImageStats?: RunOutputImageCollectionStats
  /** Key lanes (plan v4 3.1): present only on a keyed turn. The `model` beside it is then the timeout tier. */
  keyLane?: AnswerKeyFields
  /** Key lanes (P11): what this keyed answer cost on the key, settled by the relay. Keyed turns only. */
  usd?: number
  /** Key lanes (P5): the direct lane's run ledger id. Direct turns only. */
  directRunId?: string
}

/** Public-safe provider launch metadata for durable job coordination. It
 * deliberately exposes no ChildProcess object, kill handle, paths, or env. */
export interface ProviderProcessMetadata {
  provider: 'claude' | 'codex' | 'cursor' | 'ollama'
  runId: string
  pid?: number
  clientJobId?: string
  generation?: number
}

export interface StreamCallbacks {
  onChunk: (text: string) => void
  onAnswerReady?: (fullText: string) => boolean | void | Promise<boolean | void>
  onDone: (fullText: string, model: ModelPreference, cliSessionId?: string, metadata?: ModelRunMetadata) => boolean | void | Promise<boolean | void>
  onError: (error: string) => void | Promise<void>
  onToolStatus?: (toolName: string) => void
  onActivityLine?: (line: ActivityPreviewLine) => void
  onStart?: (model: ModelPreference, sessionId: string, cliSessionId?: string, metadata?: ModelRunMetadata) => void
  onProviderProcess?: (metadata: ProviderProcessMetadata) => boolean | void | Promise<boolean | void>
  /** 6.52.0: readable steps of a durable Messages job (lib/job-trail.ts). Optional, and
   * absent on every path that is not a durable job with the trail on. */
  onTrail?: (draft: JobTrailDraft) => void
  /**
   * 6.58.2: the provider named its own session, at the start of the run. Claude announces
   * its session id in the first stream event; before this the id reached the job only with
   * the result, so COS Control could not show a New session from Work while it ran.
   */
  onNativeSession?: (linkage: { cliSessionId: string; provider?: 'claude' | 'codex' | 'cursor' }) => void
}

/** Claude CLI can emit `subtype: success` with `is_error: true`; the boolean
 * is authoritative and must win before session ids or result text are saved. */
export function claudeResultErrorMessage(event: any): string | null {
  if (event?.type !== 'result') return null
  const raw = typeof event?.result === 'string' ? event.result
    : typeof event?.error === 'string' ? event.error
    : typeof event?.error?.message === 'string' ? event.error.message
      : typeof event?.message === 'string' ? event.message
        : ''
  const authFailure = terminalProviderAuthFailure('claude', raw, event?.error)
  if (authFailure) return authFailure
  if (event?.is_error !== true && event?.subtype !== 'error') return null
  const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 240)
  return detail ? `claude-bridge: ${detail}` : 'claude-bridge: Claude CLI returned an error result.'
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
  effort?: EffortPreference
  clientJobId?: string
  generation?: number
  /** Alias used by Cursor/durable-job callers; preferred over `generation`. */
  jobGeneration?: number
  turnId?: string
  surface?: 'query' | 'openai_compat' | 'unknown'
  messageEra?: string
  globalMsgNum?: number
  requestAttachments?: MediaAttachmentRef[]
  /** Provider-neutral quoted document data, rebuilt from private derivatives
   * for this execution only. Never persisted in history or job records. */
  attachmentPromptBlock?: string
  /** Optional prompt block prepended for handoff-style context. */
  handoffContext?: { promptBlock?: string }
  /** Cursor ask vs full agent. Omitted → ask. */
  cursorExecutionMode?: import('../../shared/model-preference.js').CursorExecutionMode
  /** Durable coordinator already owns the per-session provider lease. */
  sessionLockHeld?: boolean
  /** Read-only scheduled-task dispatch. Same shape as QueryJobRequest.dispatch. */
  dispatch?: { restricted: true; tools: readonly string[] }
  /** 6.58.2: `claude --name` for a session this COS session starts fresh (QueryJobRequest.sessionName). */
  sessionName?: string
  /**
   * 6.78.0 Messages steer: the job's steer port. Present only when the coordinator decided the
   * run is steerable (lib/claude-steer.ts). Absent, every argument and every stdin byte is the
   * 6.77.0 one. A dispatch never steers.
   */
  steer?: SteerPort
  /**
   * Key lanes K1 (plan v4 7): run this turn on a saved key profile (Lane B Claude) through the
   * loopback relay. The profile's timeoutTier sets the timeouts and its model goes on `--model`;
   * the `model` argument is ignored. Absent, every argument, env name, session key and stdin
   * byte is the b7c620e one. Refused (onError, nothing spawned) when lanes are not active, the
   * profile is off or not a Claude profile, its key is gone, a Claude settings file would bypass
   * the relay, no relay is registered, or this is a dispatch.
   */
  keyProfile?: KeyProfile
  /** Key lanes (QA U9): run this one profile turn without binding the session to the profile. */
  keyTurnOnly?: boolean
}

export async function callClaudeStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  model?: ClaudeModelPreference,
  images?: ModelImageInput[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  // Get or create session
  const sid = getOrCreateSession(sessionId)
  // Key lanes: every check a keyed turn needs runs here, before history, the run ledger or a
  // process. A refusal ends the turn with its lens line; the subscription is never the fallback.
  const keyProfile = options?.keyProfile
  let keyKind: KeyKind | null = null
  if (keyProfile) {
    const preflight = laneBClaudePreflight({
      profile: keyProfile,
      dispatch: !!options?.dispatch,
      cwd: resolveProviderWorkDir({ scriptsDir: COS_SCRIPTS_DIR }),
    })
    if (!preflight.ok) {
      await callbacks.onError(preflight.message)
      return sid
    }
    keyKind = preflight.keyKind
  }
  const keyLane: AnswerKeyFields | null = keyProfile && keyKind
    ? { lane: 'key', credential: { kind: keyKind, ref: keyProfile.keyRef, profileId: keyProfile.id } }
    : null
  const history = getHistory(sid)
  const session = getSessionRaw(sid)
  const contextBreaks = session?.contextBreaks ?? []
  const historyPrompt = formatHistoryForPrompt(history, contextBreaks, reference)
  const contextPrompt = historyPrompt

  // Resolve model: per-message > session preference > public-server default.
  const sessionModel = getSessionModel(sid)
  const resolvedModel: ClaudeModelPreference = keyProfile ? keyProfile.timeoutTier : (model
    ?? (sessionModel && isClaudeModel(sessionModel) ? sessionModel : DEFAULT_MODEL))
  const resolvedEffort = options?.effort
  const cliEffortFlag = resolvedEffort ? resolveCliEffortFlag(resolvedEffort) : getClaudeEffortLevel()

  // Notify client immediately — model is known before any async work
  // Pass existing CLI session ID if resuming (new sessions get it after first result)
  const resolvedCliKey = keyProfile ? keyedCliSessionKey(sid, resolvedModel, keyProfile.id) : cliSessionKey(sid, resolvedModel)
  // A keyed exchange is stamped with its profile (P6 persists it by syntax), never with the tier.
  const exchangeModel = keyProfile ? profilePreference(keyProfile.id) as unknown as ModelPreference : resolvedModel
  let existingCliSession = options?.dispatch ? undefined : cliSessionMap.get(resolvedCliKey)
  // 6.58.2: decided before the pre-warmed session below stands in: a COS session that has no
  // Claude session of its own yet starts one here, and only that one may be named.
  const startsOwnCliSession = !existingCliSession
  callbacks.onStart?.(resolvedModel, sid, existingCliSession, {
    clientJobId: options?.clientJobId,
    generation: options?.generation,
    ...(keyLane ? { keyLane } : {}),
  })

  // Phase: context loading (skipped in lightweight mode)
  let phase: Phase = 'context'

  const imageInputs: ModelImageInput[] = images ?? []
  const imagePaths = imageInputs.map(input => input.path)
  const outputImageBudget = Math.max(0, MAX_ATTACHMENTS_PER_PROMPT - imageInputs.length)
  let outputImagePublisher: ReturnType<typeof createRunOutputImagePublisher> | null = null
  if (!options?.lightweight && outputImageBudget > 0) {
    try {
      outputImagePublisher = createRunOutputImagePublisher({
        sessionId: sid,
        globalMsgNum,
        messageEra: options?.messageEra,
        maxImages: outputImageBudget,
      })
    } catch (err) {
      console.error('[claude-bridge] output image publisher unavailable:', err)
    }
  }

  let systemPrompt: string
  try {
    if (options?.lightweight) {
      // G2 speed path — minimal system prompt, context only when needed
      systemPrompt = buildLightweightSystemPrompt(query, contextPrompt)
    } else {
      callbacks.onToolStatus?.('Loading context...')
      // Full COS path — async context with Python subprocess calls
      systemPrompt = await buildSystemPrompt(contextPrompt)
    }
  } catch (err) {
    outputImagePublisher?.cleanup()
    throw err
  }
  const allowedToolList = buildClaudeToolList({
    publisherTool: outputImagePublisher?.claudeAllowedTool,
  })
  let mcpConfigArgs: string[] = []
  if (!options?.dispatch) {
    try {
      mcpConfigArgs = claudeMcpConfigArgs()
    } catch (err) {
      outputImagePublisher?.cleanup()
      throw err
    }
  }
  systemPrompt = options?.dispatch
    ? `${systemPrompt}\n\n${readOnlyCapabilityPrompt('scheduled task dispatch', 'Read, Grep and Glob only; no writes, no shell, no web', 'the task owner on the Mac')}`
    : `${systemPrompt}\n\n${claudeToolCapabilityPrompt(allowedToolList)}`
  if (outputImagePublisher) systemPrompt = `${systemPrompt}\n\n${outputImagePublisher.promptInstructions}`

  // Phase: thinking (waiting for Claude to start)
  phase = 'thinking'
  callbacks.onToolStatus?.('Thinking...')

  // Check if this is the first query in a new session (before adding exchange)
  const isFirstQuery = isNewSession(sid)

  // Record user message (with [Photo]/[N Photos] prefix for vision queries)
  const requestRefs = options?.requestAttachments ?? imageInputs.map(input => input.attachment)
  const historyPrefix = attachmentHistoryPrefix(requestRefs)
  const defaultRequest = defaultAttachmentRequest(requestRefs) || 'What do you see?'
  const historyQuery = historyPrefix ? `${historyPrefix} ${query || defaultRequest}` : query
  const inboundAttachments = requestRefs.length > 0 ? requestRefs : undefined
  const exchangeProvenance = {
    clientJobId: options?.clientJobId,
    generation: options?.generation,
  }
  const pendingUserExchange = addExchange(
    sid,
    'user',
    historyQuery,
    globalMsgNum,
    inboundAttachments,
    exchangeProvenance,
    exchangeModel,
  )

  // Vision queries need the Read tool to see the image files
  const tools = allowedToolList.join(',')

  // Prepend image instruction when photos are attached
  const hasNonImageAttachment = requestRefs.some(ref => mediaCategoryOf(ref) !== 'image')
  let fullQuery: string
  if (imagePaths.length > 0 && hasNonImageAttachment) {
    const fileList = imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')
    fullQuery = `The user shared attachments represented by ${imagePaths.length} image or video/PDF still frame${imagePaths.length === 1 ? '' : 's'}. Read each file:\n${fileList}\nThen respond to their request: ${query || defaultRequest}`
  } else if (imagePaths.length === 1) {
    fullQuery = `The user has shared a photo from their phone camera. First, read the image file at ${imagePaths[0]} to see it. Then respond to their request: ${query || 'Describe what you see in this image concisely.'}`
  } else if (imagePaths.length > 1) {
    const fileList = imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')
    fullQuery = `The user has shared ${imagePaths.length} photos. Read each image file:\n${fileList}\nThen respond to their request: ${query || 'Describe what you see in these images concisely.'}`
  } else {
    fullQuery = query || defaultRequest
  }
  if (options?.attachmentPromptBlock) fullQuery = `${fullQuery}\n\n${options.attachmentPromptBlock}`

  // Check if we have a prior CLI session for this COS session.
  // If not, use the pre-warmed session (eliminates 2-15s cold start on first query).
  // Restricted dispatch never steals the pre-warmed unrestricted session.
  // 6.58.2: nor does a named New session (COS Control Work). The warmed session opens with the
  // boot prompt "ready" under the glasses prompt; a session someone will open in the Claude app
  // under its task's name starts clean.
  // Key lanes: a keyed turn never takes the warmed subscription session.
  if (!options?.dispatch && !options?.sessionName && !existingCliSession && preWarmedCliSessionId && resolvedModel === DEFAULT_MODEL && !keyProfile) {
    // Only the default model consumes the pre-warmed session.
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
    '--model', resolveClaudeCliModelId(resolvedModel),
    '--effort', cliEffortFlag,
    '--output-format', 'stream-json',
    '--verbose',  // Required: stream-json requires --verbose
    '--system-prompt', systemPrompt,
    ...(options?.dispatch ? [] : mcpConfigArgs),
  ]
  // Key lanes (plan 7.1): a keyed turn names the profile slug on --model (never ANTHROPIC_MODEL, no [1m]).
  if (keyProfile) args[2] = keyProfile.model

  // Full and lightweight paths share the same explicit MCP selector contract.
  if (options?.dispatch) {
    args.push(
      '--restricted',
      '--tools', options.dispatch.tools.join(','),
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--no-session-persistence',
      '--include-partial-messages',
    )
  } else if (options?.lightweight) {
    args.push(...claudePermissionArgs(getClaudeTrustMode(), tools))
  } else {
    args.push(...claudePermissionArgs(getClaudeTrustMode(), tools), '--include-partial-messages')
  }
  // QA B1: deny the key secrets dir while lanes are on and a key is saved ([] otherwise). A keyed
  // turn's layer also forces agent teams off over any settings file (canary R12).
  args.push(...claudeKeySecretsGuardArgs(keyProfile ? { laneB: true } : {}))

  if (existingCliSession) {
    // Resume prior CLI session — reuses cached context, avoids cold start
    args.push('--resume', existingCliSession)
  }
  // 6.58.2: name the session this COS session starts (never a Continue, never a dispatch), when
  // the installed CLI takes --name. The `=` form keeps a name that starts with a dash a value.
  if (startsOwnCliSession && !options?.dispatch && options?.sessionName && await claudeSupportsSessionName()) {
    args.push(`--name=${options.sessionName}`)
  }
  // 6.78.0 steer: the prompt becomes one stream-json line and stdin stays open for steers.
  // These two flags and nothing else (plan P4); the CLI probe passed before the port existed.
  const steerPort = options?.dispatch ? undefined : options?.steer
  if (steerPort) args.push('--input-format', 'stream-json', '--replay-user-messages')

  // Strip CLAUDECODE env var so claude -p doesn't think it's nested
  const env = { ...process.env }
  delete env.CLAUDECODE
  if (outputImagePublisher) Object.assign(env, outputImagePublisher.env)
  const cliCwd = resolveProviderWorkDir({ scriptsDir: COS_SCRIPTS_DIR })
  const inactivityMs = INACTIVITY_BY_MODEL[resolvedModel]
  const defaultWallMax = WALL_MAX_BY_MODEL[resolvedModel]
  const effortWallMax = resolvedEffort === 'max' || resolvedEffort === 'ultracode'
    ? Math.max(defaultWallMax, WALL_MAX_DEEP_EFFORT_MS)
    : defaultWallMax
  const wallMax = isExtendedQuery(query) ? Math.max(WALL_MAX_EXTENDED_MS, effortWallMax) : effortWallMax
  // Key lanes: one nonce per turn from the relay (P2 contract), then the child env points at it.
  // Only the child's copy is written. A relay that cannot issue ends the turn before spawn.
  let keyTurn: RelayTurnHandle | null = null
  const keyTurnId = keyProfile ? options?.turnId ?? randomUUID() : null
  if (keyProfile) {
    try {
      const relay = await laneBRelay()
      keyTurn = await relay.issueTurn({
        keyRef: keyProfile.keyRef,
        profileId: keyProfile.id,
        turnId: keyTurnId!,
        sessionId: sid,
        engine: 'claude',
        allowedModel: keyProfile.model,
      }, { wallMaxMs: wallMax })
      applyLaneBClaudeEnv(env, { origin: keyTurn.origin, nonce: keyTurn.nonce, slug: keyProfile.model, profileId: keyProfile.id })
    } catch (err) {
      keyTurn?.revoke('cancel')
      outputImagePublisher?.cleanup()
      cleanupModelImageInputs(imageInputs)
      removeExchange(sid, pendingUserExchange)
      console.error(`[claude-bridge] key relay refused the turn: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`)
      await callbacks.onError(LANE_B_COPY.relayUnavailable)
      return sid
    }
  }
  const keyAuditFields = keyProfile && keyKind ? { profile: keyProfile.id, lane: 'key' as const, credentialKind: keyKind } : {}
  const startTime = Date.now()
  // 6.78.0 steer (P7 S7): the wall clock's start on the monotonic steer clock, next to the
  // wall timer it describes, so the coordinator's cut-off reads the same clock after a sleep.
  const steerStartedAt = steerClock()
  const run = startClaudeRun({
    cosSessionId: sid,
    model: resolvedModel,
    cwd: cliCwd,
    resumed: !!existingCliSession,
    cliSessionId: existingCliSession,
    timeoutMs: inactivityMs,
    wallMaxMs: wallMax,
    query: fullQuery,
    effortLevel: resolvedEffort ?? getClaudeEffortLevel(),
    cliModelId: keyProfile ? keyProfile.model : resolveClaudeCliModelId(resolvedModel),
  })

  // Ultracode is a CLI-only orchestration keyword; history/chat keeps the
  // original user text so the keyword never appears on the lens.
  const promptText = resolvedEffort === 'ultracode'
    ? `${fullQuery}\n\n${ULTRACODE_KEYWORD}`
    : fullQuery
  // 6.78.0 steer: steers that arrived before the first line ride in it (never in request.query
  // or the fingerprint). They are journaled `included` once the line is written.
  const cliQuery = steerPort ? composeFirstContent(promptText, steerPort.drainForCompose()) : promptText
  // The COS UserPromptSubmit hook sees `cliQuery` (image preamble, attachment block and
  // all). This private file hands it the user's own words, bound by the hash of exactly
  // what goes on stdin; the file dies with the child. See lib/turn-request.ts.
  const turnRequest = createTurnRequestBinding({ userText: query, prompt: cliQuery, turnId: options?.turnId })
  applyTurnRequestEnv(env, turnRequest)

  const proc = spawnWithTurnRequest(turnRequest, () => spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: cliCwd,
    detached: true,
  }))

  let fullText = ''
  let stderr = ''
  let buffer = ''
  let finalized = false        // Guard against double onDone/onError
  let terminationRequested = false // Forced terminal callbacks wait for confirmed process close
  let terminalTextError: string | null = null
  let lastActivity = Date.now() // Tracks last stdout data for inactivity timeout
  let receivedStreamEvents = false  // Track if CLI emits stream_event (vs older assistant-only format)
  // 6.78.0 steer state (all inert without a port).
  // The prompt line's uuid is the job's turn id when it is one (the plan's wire shape), so a
  // result's user_message_uuids names the turn; anything else gets a fresh uuid.
  const steerTracker = steerPort
    ? new SteerTracker(typeof options?.turnId === 'string' && UUID_RE.test(options.turnId) ? options.turnId.toLowerCase() : randomUUID())
    : null
  let steerSettling = false            // a result left a steer uncovered: the settle window is open
  let steerSettleTimer: ReturnType<typeof setTimeout> | null = null
  let steerNeedsSeparator = false      // text after such a result is a second turn
  let steerCheckpoint: string | null = null
  let steerStdinEnded = false
  let steerReaper: ReturnType<typeof setTimeout> | null = null
  let steerKilled = false
  let childClosed = false
  function endSteerStdin() {
    if (!steerPort || steerStdinEnded) return
    steerStdinEnded = true
    steerPort.close()
    try { proc.stdin.end() } catch { /* the child is gone */ }
  }
  /**
   * 6.78.0 (P7 S2): the run ended with steer lines written that no result covered. Ending
   * stdin would let the CLI run those queued lines unwatched (up to the 15 s reaper), and a
   * later --resume of its session would inherit them while the job reads them not_applied,
   * so the client sends them again. Instead: the port closes, the child is killed, and the
   * CLI session mapping is dropped so the next Ask starts a fresh session.
   */
  function abandonUncoveredSteers() {
    keyTurn?.revoke('steer_abort')
    steerStdinEnded = true
    steerPort!.close()
    if (cliSessionMap.delete(resolvedCliKey)) scheduleCliSessionSave()
    if (childClosed || terminationRequested || steerKilled) return
    steerKilled = true
    void terminateProviderProcess(proc)
  }
  /** A finished steer-mode run whose child has not exited by now is terminated (stdin is closed). */
  function armSteerReaper() {
    if (!steerPort || steerReaper || childClosed || steerKilled) return
    steerReaper = setTimeout(() => {
      if (!childClosed && !terminationRequested) void terminateProviderProcess(proc)
    }, STEER_REAPER_MS)
    steerReaper.unref?.()
  }
  /** Second-turn text keeps the partial a prefix of the answer: one separator first. */
  function steerSeparator() {
    if (!steerNeedsSeparator) return
    steerNeedsSeparator = false
    if (!fullText) return
    fullText += '\n\n'
    callbacks.onChunk('\n\n')
  }
  const toolInputs = new Map<number, { name: string; json: string }>()

  function cleanupImages() {
    cleanupModelImageInputs(imageInputs)
  }

  function abandonLostDurableOwnership(message: string) {
    finalized = true
    cleanup()
    cleanupImages()
    outputImagePublisher?.cleanup()
    removeExchange(sid, pendingUserExchange)
    if (cliSessionMap.delete(resolvedCliKey)) scheduleCliSessionSave()
    finishClaudeRun(run.runId, {
      status: 'failed',
      startedAtMs: startTime,
      error: message,
      exitCode: null,
    })
  }

  async function finalize(text: string) {
    if (finalized) return
    const responseAuthFailure = terminalProviderAuthFailure('claude', text)
    const authFailure = responseAuthFailure
      ?? (!text.trim() ? terminalTextError ?? terminalProviderAuthFailure('claude', stderr) : null)
    if (authFailure) {
      await finalizeError(authFailure, 0)
      return
    }
    finalized = true
    cleanup()
    armSteerReaper()
    cleanupImages()

    // The coordinator persists the final provider text before conversation
    // mutation, condensation, or output-image normalization can stall/crash.
    try {
      const answerOwned = await callbacks.onAnswerReady?.(text)
      if (answerOwned === false) {
        abandonLostDurableOwnership('claude-bridge: durable answer ownership was lost.')
        return
      }
    } catch (error) {
      console.error('[claude-bridge] durable answer barrier failed:', error)
      outputImagePublisher?.cleanup()
      removeExchange(sid, pendingUserExchange)
      if (cliSessionMap.delete(resolvedCliKey)) scheduleCliSessionSave()
      finishClaudeRun(run.runId, {
        status: 'failed',
        startedAtMs: startTime,
        error: 'claude-bridge: durable answer persistence failed.',
        exitCode: null,
      })
      try {
        await callbacks.onError('claude-bridge: durable answer persistence failed.')
      } catch (callbackError) {
        console.error('[claude-bridge] durable barrier error callback failed:', callbackError)
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
      exchangeModel,
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
        console.error('[claude-bridge] output image collection failed:', err)
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

    // Token audit — log every completed claude -p call
    const totalMs = Date.now() - startTime
    const inputEstimate = systemPrompt.length + fullQuery.length + contextPrompt.length
    // Key lanes (P11): this turn's settled spend on the key. Keyed turns only.
    const keyUsdFields = keyTurnId ? { usd: Math.round(getSharedKeyMeter().turnSettledUsd(keyTurnId) * 1e6) / 1e6 } : {}
    logTokenAudit({
      source: options?.lightweight ? 'g2-voice' : 'g2-query',
      model: resolvedModel,
      inputChars: inputEstimate,
      outputChars: text.length,
      durationMs: totalMs,
      caller: options?.lightweight ? 'voice_query' : 'full_query',
      ...keyAuditFields,
      ...keyUsdFields,
    })

    finishClaudeRun(run.runId, {
      status: 'completed',
      startedAtMs: startTime,
      output: text,
      exitCode: 0,
    })

    const terminalOwned = await callbacks.onDone(text, resolvedModel, cliSessionMap.get(resolvedCliKey), {
      claudeRunId: run.runId,
      clientJobId: options?.clientJobId,
      generation: options?.generation,
      ...(outputAttachments.length > 0 ? { outputAttachments } : {}),
      ...(outputImageStats && outputImageStats.published > 0 ? { outputImageStats } : {}),
      ...(keyLane ? { keyLane, ...keyUsdFields } : {}),
    })
    if (terminalOwned === false) return

    // Telegram notifications — fire and forget
    if (isFirstQuery) {
      notifySessionStart(sid, query)
      markSessionNotified(sid)
    }
    notifyExchange(sid, query, text)
  }

  async function finalizeError(
    msg: string,
    exitCode?: number | null,
    status: Exclude<ClaudeRunStatus, 'running'> = 'failed',
  ) {
    if (finalized) return
    finalized = true
    cleanup()
    armSteerReaper()
    cleanupImages()
    outputImagePublisher?.cleanup()
    removeExchange(sid, pendingUserExchange)
    // A failed/cancelled resumed CLI turn may already exist in Claude's own
    // session transcript even though COS history was rolled back. Never resume
    // that potentially contaminated CLI session on retry.
    if (cliSessionMap.delete(resolvedCliKey)) scheduleCliSessionSave()
    finishClaudeRun(run.runId, {
      status,
      startedAtMs: startTime,
      error: msg,
      exitCode,
    })
    await callbacks.onError(msg)
  }

  async function terminateForTerminal(
    reason: string,
    onClosed: (result: Awaited<ReturnType<typeof terminateProviderProcess>>) => void | Promise<void>,
  ) {
    if (finalized || terminationRequested) return
    terminationRequested = true
    cleanup()
    const result = await terminateProviderProcess(proc)
    if (!result.closed) {
      console.error(`[claude-bridge] provider did not close after SIGKILL (${reason}); retaining lifecycle ownership`)
      return
    }
    await onClosed(result)
  }

  function handleAbort() {
    keyTurn?.revoke('cancel')
    void terminateForTerminal('client disconnect', result => finalizeError(
        'claude-bridge: client disconnected before Claude completed.',
        result.code,
        'client_disconnected',
      ))
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
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    void terminateForTerminal('inactivity timeout', result => finalizeError(
      `No output for ${inactivityMs / 1000}s (${elapsed}s total). Process killed.`,
      result.code,
    ))
  }, inactivityMs)

  function resetInactivity() {
    lastActivity = Date.now()
    clearTimeout(inactivityTimer)
    // 6.78.0 steer: the inactivity timer pauses during the settle window; output resets the settle.
    if (steerSettling) {
      armSteerSettle()
      return
    }
    inactivityTimer = setTimeout(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      void terminateForTerminal('inactivity timeout', result => finalizeError(
        `No output for ${inactivityMs / 1000}s (${elapsed}s total). Process killed.`,
        result.code,
      ))
    }, inactivityMs)
  }

  /**
   * 6.78.0 steer: a result covered the prompt but not every steer. Wait for the next result,
   * at most STEER_SETTLE_MS of quiet; then close stdin (the CLI runs anything queued and
   * exits) and let the close finish the run with what it has.
   */
  function armSteerSettle() {
    if (steerSettleTimer) clearTimeout(steerSettleTimer)
    steerSettleTimer = setTimeout(() => {
      steerSettleTimer = null
      steerSettling = false
      endSteerStdin()
      if (!finalized) resetInactivity()
    }, STEER_SETTLE_MS)
    steerSettleTimer.unref?.()
  }
  function enterSteerSettle() {
    steerSettling = true
    clearTimeout(inactivityTimer)
    armSteerSettle()
  }

  // ─── Wall clock max: absolute cap ───

  const wallTimer = setTimeout(() => {
    void terminateForTerminal('wall timeout', result => {
      // 6.78.0 steer: a steered run past its first whole answer completes with that answer.
      if (steerCheckpoint !== null) return finalize(steerCheckpoint)
      if (fullText) {
        // Got partial output — deliver only after the process tree is closed.
        return finalize(fullText)
      }
      return finalizeError(`Wall clock limit reached (${wallMax / 1000}s). Process killed.`, result.code)
    })
  }, wallMax)

  function cleanup() {
    clearInterval(heartbeat)
    clearTimeout(inactivityTimer)
    clearTimeout(wallTimer)
    options?.abortSignal?.removeEventListener('abort', handleAbort)
    // 6.78.0 steer: every terminal path closes the port and stdin.
    if (steerSettleTimer) clearTimeout(steerSettleTimer)
    steerSettleTimer = null
    steerSettling = false
    if (steerTracker && steerTracker.uncovered().length > 0) {
      abandonUncoveredSteers()
      return
    }
    endSteerStdin()
  }

  // ─── Process stdout ───

  // 6.58.2: onNativeSession fires once per run.
  let nativeSessionAnnounced = false
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

        // 6.58.2: the first event that carries the session id (a hook or init line, before any
        // answer text) links the run and the job to it. At completion the result's id is
        // recorded as before, so the finished job names the session the result names.
        if (!nativeSessionAnnounced && !options?.dispatch && typeof event.session_id === 'string' && event.session_id) {
          nativeSessionAnnounced = true
          // Key lanes (plan 7.3): recorded before any answer text, so Continue, Fork, attach and
          // handoff refuse this transcript from the moment it exists.
          if (keyProfile) recordKeyedSession({ id: event.session_id, engine: 'claude', profileId: keyProfile.id, cosSessionId: sid })
          updateClaudeRun(run.runId, { cliSessionId: event.session_id })
          callbacks.onNativeSession?.({ cliSessionId: event.session_id })
        }

        if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
          updateClaudeRun(run.runId, { resolvedModelId: event.model })
        } else if (event.type === 'stream_event') {
          // Real-time token streaming — fires every few tokens during generation
          receivedStreamEvents = true
          const inner = event.event
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
            phase = 'generating'
            steerSeparator()
            fullText += inner.delta.text
            callbacks.onChunk(inner.delta.text)
          } else if (inner?.type === 'content_block_start' && inner.content_block?.type === 'thinking') {
            phase = 'thinking'
            callbacks.onToolStatus?.('Reasoning...')
          } else if (inner?.type === 'content_block_start' && inner.content_block?.type === 'tool_use' && inner.content_block.name) {
            const toolName = inner.content_block.name
            if (typeof inner.index === 'number') toolInputs.set(inner.index, { name: toolName, json: '' })
            if (toolName === 'WebSearch' || toolName === 'WebFetch') {
              phase = 'searching'
            }
            callbacks.onToolStatus?.(toolName)
            if (toolName === 'Read') {
              callbacks.onToolStatus?.('Analyzing photo...')
            }
          } else if (inner?.type === 'content_block_delta' && inner.delta?.type === 'input_json_delta' && typeof inner.index === 'number') {
            const current = toolInputs.get(inner.index)
            if (current && typeof inner.delta.partial_json === 'string') current.json += inner.delta.partial_json
          } else if (inner?.type === 'content_block_stop' && typeof inner.index === 'number') {
            const current = toolInputs.get(inner.index)
            if (current) {
              if (!isRunOutputImagePublisherCommand(current.json)) {
                const preview = claudeToolInputPreview(current.name, current.json)
                if (preview) callbacks.onActivityLine?.(preview)
              }
              toolInputs.delete(inner.index)
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
              // Withhold only strongly machine-shaped provider auth output so
              // credentials cannot flash through onChunk. Human sign-in
              // instructions do not match the terminal classifier.
              const authFailure = terminalProviderAuthFailure('claude', text)
              if (authFailure) terminalTextError = authFailure
              else {
                phase = 'generating'
                steerSeparator()
                fullText += text
                callbacks.onChunk(text)
              }
            }
          }
        } else if (event.type === 'user') {
          // 6.78.0 steer: the CLI replaying a steer line means it has it.
          const delivered = steerTracker?.onUserEvent(event)
          if (delivered) steerPort!.events.onDelivered?.(delivered)
          for (const preview of claudeToolResultPreviewLines(event)) callbacks.onActivityLine?.(preview)
        } else if (event.type === 'result') {
          const resultError = claudeResultErrorMessage(event)
          if (resultError) {
            finalizeError(resultError)
            continue
          }
          // Capture CLI session ID for future --resume (avoids cold start on next query)
          if (event.session_id && !options?.dispatch) {
            if (keyProfile) recordKeyedSession({ id: event.session_id, engine: 'claude', profileId: keyProfile.id, cosSessionId: sid })
            cliSessionMap.set(resolvedCliKey, event.session_id)
            scheduleCliSessionSave()
            updateClaudeRun(run.runId, { cliSessionId: event.session_id })
          }
          // 6.78.0 steer: a result finishes the run only when it (with the ones before it)
          // covers every line written. A result that leaves a steer uncovered checkpoints the
          // answer the first time it covers the prompt, and the run waits.
          if (steerTracker && !finalized) {
            const verdict = steerTracker.onResult(event)
            if (verdict.folded.length > 0) steerPort!.events.onFolded?.(verdict.folded)
            if (verdict.action === 'wait') {
              if (verdict.checkpoint) {
                const checkpoint: string = fullText || event.result || ''
                steerCheckpoint = checkpoint
                steerPort!.events.onCheckpoint?.(checkpoint)
              }
              steerNeedsSeparator = true
              enterSteerSettle()
              continue
            }
            // finish, or finish with steering off (the CLI named no uuids): no more steers.
            steerPort!.close()
          }
          // Final result — use accumulated text (more reliable than result.result)
          void finalize(fullText || event.result || '')
        }
        // tool_use/tool_result/other events still reset inactivity (we got stdout data)
      } catch {
        // Older CLI builds can emit a terminal auth error as plain text while
        // still exiting 0. Remember only the canonical classification.
        terminalTextError ??= terminalProviderAuthFailure('claude', trimmed)
      }
    }
  })

  // 6.52.0: the Messages trail, a SECOND stdout reader registered after the one above, so
  // that handler sees every chunk first and nothing it decides can change. Without an
  // `onTrail` (legacy /api/query, openai-compat, COS_MESSAGES_TRAIL=0) this attaches nothing.
  teeJobTrail(proc.stdout, 'claude', callbacks.onTrail)

  proc.stderr.on('data', (chunk: Buffer) => {
    // stderr activity also counts — Claude CLI logs progress there
    resetInactivity()
    stderr += chunk.toString()
  })

  proc.on('close', (code) => {
    childClosed = true
    keyTurn?.childClosed()
    if (steerReaper) clearTimeout(steerReaper)
    steerPort?.close()
    if (terminationRequested) return
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim())
        if (event.type === 'result') {
          const resultError = claudeResultErrorMessage(event)
          if (resultError) {
            finalizeError(resultError, code)
            return
          }
          void finalize(fullText || event.result || '')
          return
        }
      } catch { /* ignore */ }
    }

    if (fullText) {
      // If we got text but no explicit result event, still finalize. A sole,
      // machine-shaped auth response is classified inside finalize.
      void finalize(fullText)
    } else {
      const authFailure = terminalTextError ?? terminalProviderAuthFailure('claude', stderr, buffer)
      if (authFailure) {
        finalizeError(authFailure, code)
      } else if (code !== 0) {
        finalizeError(`claude-bridge: exit ${code} — ${stderr.trim().slice(0, 200)}`, code)
      } else {
        finalizeError('claude-bridge: Claude completed without a response.', code)
      }
    }
  })

  proc.on('error', (err) => {
    keyTurn?.revoke('child_close')
    if (terminationRequested) return
    finalizeError(`claude-bridge: ${err.message}`, null)
  })
  proc.stdin.on('error', (err) => {
    if (terminationRequested) return
    finalizeError(`claude-bridge: stdin failed — ${err.message}`, null)
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
      provider: 'claude',
      runId: run.runId,
      pid: proc.pid,
      clientJobId: options?.clientJobId,
      generation: options?.generation,
    })
    if (providerOwned === false) {
      await terminateForTerminal('provider ownership lost', () => {
        abandonLostDurableOwnership('claude-bridge: durable provider ownership was lost.')
      })
      return sid
    }
    if (finalized) return sid
    if (steerPort && steerTracker) {
      // 6.78.0 steer: the prompt is one stream-json line; stdin stays open. Steers offered
      // after the compose are written right behind it, then every later one as it comes.
      proc.stdin.write(encodeUserLine(steerTracker.promptUuid, cliQuery))
      steerPort.open((line, steerId) => {
        if (finalized || steerStdinEnded || !proc.stdin.writable) return false
        proc.stdin.write(line)
        steerTracker.noteWritten(steerId)
        return true
      }, { startedAt: steerStartedAt, wallMaxMs: wallMax })
    } else {
      proc.stdin.write(cliQuery)
      proc.stdin.end()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!finalized) {
      await terminateForTerminal('provider start failure', result => finalizeError(
        `claude-bridge: provider start failed — ${message}`,
        result.code,
      ))
    }
  }

  return sid
}
