// Live Cues engine — arm/disarm, transcript window, gates, single-flight,
// per-meeting counters, breaker, and the pipeline itself.
//
// Cost containment is the design center. Every recurring LLM caller must
// answer how it stops; here the answers are: per-meeting cap (8), single-flight,
// 60s floor, 30s cooldown, consecutive-failure breaker, weekly ceiling, the
// LightRAG reserve, and the COS_LIVE_CUES master switch. Every skip logs its
// reason — a silent cap is the same defect class as a silent fallback.

import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { emitDisplay } from './display-bus.js'
import {
  acquireMaintenanceWork,
  MaintenanceLifecycleError,
  maintenanceLifecycle,
  type MaintenanceWorkLease,
} from './maintenance-lifecycle.js'
import { getCursorModelCatalog, resolveCursorModelOption } from './cursor-model-catalog.js'
import { CURSOR_COMPOSER_MODEL } from '../../shared/model-preference.js'
import { composerAsk } from './live-cues-cursor.js'
import { lightragExploreHop, semanticSearchHop } from './live-cues-memory.js'
import {
  buildInsightPrompt,
  buildPlannerPrompt,
  isInsightResult,
  isPlannerResult,
  parseJsonReply,
} from './live-cues-prompt.js'
import {
  liveCuesCapability,
  liveCuesEnabled,
  liveCuesGraphEnabled,
  liveCuesModelSupported,
  registerLiveCuesBudgetProbe,
} from './live-cues-capability.js'
import { terminateProviderProcess } from './provider-process-lifecycle.js'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

// ── Gates ────────────────────────────────────────────────────────────────────
const MIN_BUFFER_WORDS = 40
const FLOOR_BETWEEN_STARTS_MS = 60_000
const COOLDOWN_AFTER_CUE_MS = 30_000
const MAX_PIPELINES_PER_MEETING = 8
// Must stay under COS Control's 90s drain timeout: a held live_cue_pipeline
// lease past the drain window hard-fails every Update Server to Repair.
const PIPELINE_WALL_MS = 60_000
const STALE_CUE_WORDS = 120
const BUFFER_CAP_WORDS = 400
const SESSION_TTL_MS = 4 * 60 * 60_000
const MAX_CONSECUTIVE_FAILURES = 3
const INSIGHT_RESERVE_MS = 15_000
const STAGE_MAX_MS = 15_000
const WEEKLY_COMPOSER_CEILING = 250

// Signal pre-filter, ported by symbol from the app engine's COACHING_SIGNALS
// (coaching-engine.ts:178-185 — six patterns; commitments, metrics, agreement,
// action items, promises, substantive questions).
const COACHING_SIGNALS = [
  /\b(i'll|we'll|we should|let's|i will|i can|by friday|by monday|next week|tomorrow|deadline|due)\b/i,
  /\b(how much|what's the|numbers?|percent|budget|revenue|pipeline|conversion|leads?|opps?)\b/i,
  /\b(agree|sounds good|yeah let's|sure thing|okay let's|go ahead|approved?)\b/i,
  /\b(action item|follow up|circle back|check in|send me|share the|can you)\b/i,
  /\b(committed?|promised?|guarantee|timeline|milestone|deliverable)\b/i,
  /\?(.{5,})/,
]

export interface LiveCueNudge {
  nudge: string
  type: string
  priority: number
  timestamp: number
  degraded?: boolean
  degradationReason?: string
}

interface LiveCueSession {
  sessionId: string
  armedAt: number
  lastSeenAt: number
  modelId: string
  pipelinesUsed: number
  inFlight: boolean
  lastPipelineStartAt: number
  lastCueAt: number
  consecutiveFailures: number
  breakerTripped: boolean
  bufferWords: string[]
  wordsSincePipelineStart: number
  nudges: LiveCueNudge[]
  activeProcs: Set<ChildProcess>
  lease: MaintenanceWorkLease | null
  leaseHeldOpen: boolean
}

export class LiveCuesArmError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = 'LiveCuesArmError'
  }
}

const sessions = new Map<string, LiveCueSession>()

function skip(sessionId: string, reason: string, detail = ''): void {
  console.log(`[live-cues] skip: ${reason}${detail ? ` ${detail}` : ''} (${sessionId})`)
}

// ── Weekly Composer ceiling (persisted; survives restarts) ───────────────────
interface WeeklyBudget { weekStart: string; composerCalls: number }

function currentWeekStart(): string {
  const now = new Date()
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((day + 6) % 7))
  return monday.toISOString().slice(0, 10)
}

function budgetPath(): string {
  return dataPath('live-cues-budget.json')
}

function readWeeklyBudget(): WeeklyBudget {
  try {
    if (existsSync(budgetPath())) {
      const parsed = JSON.parse(readFileSync(budgetPath(), 'utf-8')) as WeeklyBudget
      if (parsed.weekStart === currentWeekStart()) return parsed
    }
  } catch { /* corrupted budget file resets */ }
  return { weekStart: currentWeekStart(), composerCalls: 0 }
}

function recordComposerCalls(count: number): void {
  const budget = readWeeklyBudget()
  budget.composerCalls += count
  try {
    atomicWriteFileSync(budgetPath(), JSON.stringify(budget))
  } catch { /* budget persistence is best-effort */ }
}

export function weeklyBudgetExhausted(): boolean {
  return readWeeklyBudget().composerCalls >= WEEKLY_COMPOSER_CEILING
}

registerLiveCuesBudgetProbe(weeklyBudgetExhausted)

// ── Session lifecycle ────────────────────────────────────────────────────────
function reapStaleSessions(): void {
  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    if (!session.inFlight && now - session.lastSeenAt > SESSION_TTL_MS) {
      sessions.delete(sessionId)
    }
  }
}

/** Idempotent arm. A repeat start for an armed session returns the EXISTING
 *  counter and never resets — reconnect fires this repeatedly by design. */
export async function armLiveCues(sessionId: string): Promise<{ armed: true; sessionId: string; pipelinesUsed: number }> {
  reapStaleSessions()
  if (!liveCuesEnabled()) throw new LiveCuesArmError('disabled', 403, 'Live cues are disabled (COS_LIVE_CUES).')
  if (!liveCuesModelSupported()) {
    throw new LiveCuesArmError('live_cues_model_unsupported', 403, 'Only cursor-composer is supported for live cues.')
  }
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.lastSeenAt = Date.now()
    return { armed: true, sessionId, pipelinesUsed: existing.pipelinesUsed }
  }
  const capability = liveCuesCapability()
  if (!capability.available) {
    throw new LiveCuesArmError(capability.reason ?? 'unavailable', 503, `Live cues unavailable: ${capability.reason}.`)
  }
  // Resolve the catalog ONCE at arm time. The per-pipeline path reads only the
  // cached id: getCursorModelCatalog() short-circuits on isCursorProviderReady()
  // (which needs BOTH slots), so an unresolved grok slot would otherwise
  // re-spawn `agent models` (7s) on every ask.
  await getCursorModelCatalog()
  const option = resolveCursorModelOption(CURSOR_COMPOSER_MODEL)
  if (!option?.id) throw new LiveCuesArmError('no_composer', 503, 'Composer model id did not resolve.')
  sessions.set(sessionId, {
    sessionId,
    armedAt: Date.now(),
    lastSeenAt: Date.now(),
    modelId: option.id,
    pipelinesUsed: 0,
    inFlight: false,
    lastPipelineStartAt: 0,
    lastCueAt: 0,
    consecutiveFailures: 0,
    breakerTripped: false,
    bufferWords: [],
    wordsSincePipelineStart: 0,
    nudges: [],
    activeProcs: new Set(),
    lease: null,
    leaseHeldOpen: false,
  })
  console.log(`[live-cues] armed ${sessionId} (model ${option.id})`)
  return { armed: true, sessionId, pipelinesUsed: 0 }
}

export function disarmLiveCues(sessionId: string): { nudgesGenerated: number; nudges: LiveCueNudge[] } {
  const session = sessions.get(sessionId)
  if (!session) return { nudgesGenerated: 0, nudges: [] }
  const result = { nudgesGenerated: session.nudges.length, nudges: [...session.nudges] }
  if (!session.inFlight) sessions.delete(sessionId)
  else session.lastSeenAt = 0 // reaped once the pipeline settles
  console.log(`[live-cues] disarmed ${sessionId} (${result.nudgesGenerated} nudges)`)
  return result
}

export function getLiveCuesStatus(): Array<{
  sessionId: string
  pipelinesUsed: number
  inFlight: boolean
  breakerTripped: boolean
  nudgesGenerated: number
}> {
  return [...sessions.values()].map(session => ({
    sessionId: session.sessionId,
    pipelinesUsed: session.pipelinesUsed,
    inFlight: session.inFlight,
    breakerTripped: session.breakerTripped,
    nudgesGenerated: session.nudges.length,
  }))
}

// ── Feed ─────────────────────────────────────────────────────────────────────
function userQueryInFlight(): boolean {
  const activeByKind = maintenanceLifecycle.snapshot().activeByKind as Record<string, number>
  return (activeByKind.durable_query ?? 0) > 0
    || (activeByKind.legacy_query ?? 0) > 0
    || (activeByKind.openai_query ?? 0) > 0
}

/** Fire-and-forget from the ASR path. Declared async so every throw becomes a
 *  rejection; the call site's .catch(() => {}) absorbs it (a bare `void` on a
 *  rejecting promise is an unhandled rejection, which Node throws on). */
export async function feedLiveCueTranscript(
  sessionId: string,
  text: string,
  asrDegraded = false,
): Promise<void> {
  let session = sessions.get(sessionId)
  if (!session) {
    if (process.env.COS_LIVE_CUES_AUTO === '1' && liveCuesEnabled()) {
      try {
        await armLiveCues(sessionId)
        session = sessions.get(sessionId)
      } catch {
        return
      }
    }
    if (!session) return
  }
  session.lastSeenAt = Date.now()

  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length) {
    session.bufferWords.push(...words)
    session.wordsSincePipelineStart += words.length
    if (session.bufferWords.length > BUFFER_CAP_WORDS) {
      session.bufferWords.splice(0, session.bufferWords.length - BUFFER_CAP_WORDS)
    }
  }

  // Gates — single-flight FIRST, then cheap checks, each logged on skip.
  if (session.inFlight) { skip(sessionId, 'pipeline_in_flight'); return }
  if (session.breakerTripped) { skip(sessionId, 'breaker_tripped'); return }
  if (asrDegraded) { skip(sessionId, 'capture_degraded'); return }
  if (session.pipelinesUsed >= MAX_PIPELINES_PER_MEETING) { skip(sessionId, 'meeting_cap'); return }
  if (session.bufferWords.length < MIN_BUFFER_WORDS) { skip(sessionId, 'word_floor', `${session.bufferWords.length}w`); return }
  const now = Date.now()
  if (now - session.lastPipelineStartAt < FLOOR_BETWEEN_STARTS_MS) { skip(sessionId, 'floor_60s'); return }
  if (now - session.lastCueAt < COOLDOWN_AFTER_CUE_MS) { skip(sessionId, 'cooldown'); return }
  const windowText = session.bufferWords.join(' ')
  if (!COACHING_SIGNALS.some(pattern => pattern.test(windowText))) { skip(sessionId, 'signal_prefilter'); return }
  if (weeklyBudgetExhausted()) { skip(sessionId, 'budget_exhausted'); return }
  if (userQueryInFlight()) { skip(sessionId, 'provider_busy'); return }

  await runPipeline(session, windowText)
}

// ── Pipeline ─────────────────────────────────────────────────────────────────
async function runPipeline(session: LiveCueSession, windowText: string): Promise<void> {
  // Counter and stamps move at START, not completion — two chunks racing a
  // completion-time stamp both pass the floor and both launch.
  session.inFlight = true
  session.pipelinesUsed += 1
  session.lastPipelineStartAt = Date.now()
  session.wordsSincePipelineStart = 0
  session.bufferWords = []

  let lease: MaintenanceWorkLease | null = null
  try {
    lease = acquireMaintenanceWork('live_cue_pipeline')
  } catch (error) {
    session.inFlight = false
    if (error instanceof MaintenanceLifecycleError) {
      skip(session.sessionId, 'maintenance_drain_active')
      return
    }
    throw error
  }
  session.lease = lease

  const deadline = Date.now() + PIPELINE_WALL_MS
  const remaining = () => deadline - Date.now()
  const onProcess = (proc: ChildProcess) => {
    session.activeProcs.add(proc)
    proc.once('close', () => session.activeProcs.delete(proc))
  }
  let treeProvenClosed = true
  let composerCalls = 0

  try {
    // Stage 1 — planner
    const planner = await composerAsk({
      prompt: buildPlannerPrompt(windowText),
      modelId: session.modelId,
      caller: 'live-cues-planner',
      timeoutMs: Math.min(STAGE_MAX_MS, remaining() - INSIGHT_RESERVE_MS),
      onProcess,
    })
    composerCalls += 1
    if (!planner.ok) {
      treeProvenClosed = planner.treeClosed
      recordFailure(session, `planner:${planner.reason}`)
      return
    }
    const plan = parseJsonReply(planner.text, isPlannerResult)
    if (!plan) { recordSuccessNoCue(session, 'planner_null'); return }

    // Stage 2 — Qdrant
    let degraded = false
    let degradationReason: string | undefined
    let snippets: string[] = []
    if (remaining() > INSIGHT_RESERVE_MS) {
      const hop1 = await semanticSearchHop(plan.query)
      if (hop1.ok) snippets = hop1.snippets
      else { degraded = true; degradationReason = hop1.reason }
    } else {
      degraded = true
      degradationReason = 'wall_budget'
    }

    // Stage 3 — LightRAG (optional, budgeted, reserve-guarded)
    let graphContext: string | null = null
    if (liveCuesGraphEnabled() && plan.entity && remaining() > INSIGHT_RESERVE_MS + 5_000) {
      const hop2 = await lightragExploreHop(plan.entity, onProcess)
      if (hop2.ok) graphContext = hop2.text
      else {
        treeProvenClosed = treeProvenClosed && hop2.treeClosed
        degraded = true
        degradationReason = degradationReason ?? hop2.reason
      }
    } else if (liveCuesGraphEnabled() && plan.entity) {
      degraded = true
      degradationReason = degradationReason ?? 'wall_budget'
    }

    // Stage 4 — insight
    const insightBudget = Math.min(INSIGHT_RESERVE_MS, remaining())
    if (insightBudget < 3_000) { recordFailure(session, 'wall_budget'); return }
    const insight = await composerAsk({
      prompt: buildInsightPrompt({ transcriptWindow: windowText, memorySnippets: snippets, graphContext }),
      modelId: session.modelId,
      caller: 'live-cues-insight',
      timeoutMs: insightBudget,
      onProcess,
    })
    composerCalls += 1
    if (!insight.ok) {
      treeProvenClosed = treeProvenClosed && insight.treeClosed
      recordFailure(session, `insight:${insight.reason}`)
      return
    }
    const cue = parseJsonReply(insight.text, isInsightResult)
    if (!cue) { recordSuccessNoCue(session, 'insight_null'); return }

    // Staleness: a cue about a topic the room has left reads as broken.
    if (session.wordsSincePipelineStart > STALE_CUE_WORDS) {
      skip(session.sessionId, 'cue_stale', `${session.wordsSincePipelineStart}w advanced`)
      session.consecutiveFailures = 0
      return
    }

    const nudge: LiveCueNudge = {
      nudge: cue.nudge.slice(0, 85),
      type: cue.type.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'insight',
      priority: Math.max(1, Math.min(3, Math.round(cue.priority))),
      timestamp: Date.now(),
      ...(degraded ? { degraded: true, degradationReason } : {}),
    }
    session.nudges.push(nudge)
    session.lastCueAt = Date.now()
    session.consecutiveFailures = 0
    emitDisplay({
      type: 'coaching_nudge',
      data: {
        nudge: nudge.nudge,
        type: nudge.type,
        priority: nudge.priority,
        ...(nudge.degraded ? { degraded: true, degradationReason: nudge.degradationReason } : {}),
      },
    })
    console.log(`[live-cues] cue ${session.pipelinesUsed}/${MAX_PIPELINES_PER_MEETING} (${nudge.type}${degraded ? ', degraded' : ''}): "${nudge.nudge}"`)
  } finally {
    if (composerCalls > 0) recordComposerCalls(composerCalls)
    session.inFlight = false
    if (session.lastSeenAt === 0) sessions.delete(session.sessionId) // disarmed mid-flight
    // provider-process-lifecycle contract: release the lease ONLY when the
    // process tree is proven dead. Otherwise hold it so Control cannot restart
    // the server over a live subprocess, and log loudly.
    if (treeProvenClosed) {
      lease.release()
      session.lease = null
    } else {
      session.leaseHeldOpen = true
      console.error(`[live-cues] lease HELD OPEN for ${session.sessionId}: process tree not proven dead`)
    }
  }
}

function recordFailure(session: LiveCueSession, reason: string): void {
  session.consecutiveFailures += 1
  console.warn(`[live-cues] pipeline failed (${reason}) ${session.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} (${session.sessionId})`)
  if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    session.breakerTripped = true
    console.warn(`[live-cues] breaker tripped — cues disabled for ${session.sessionId}`)
  }
}

function recordSuccessNoCue(session: LiveCueSession, reason: string): void {
  session.consecutiveFailures = 0
  console.log(`[live-cues] no cue (${reason}) (${session.sessionId})`)
}

// ── Shutdown ─────────────────────────────────────────────────────────────────
/** Called from gracefulShutdown inside its 8s force-exit budget. Single-flight
 *  guarantees at most one live tree per session. */
export async function shutdownLiveCues(): Promise<void> {
  const terminations: Promise<unknown>[] = []
  for (const session of sessions.values()) {
    for (const proc of session.activeProcs) {
      terminations.push(terminateProviderProcess(proc))
    }
  }
  if (terminations.length) {
    console.log(`[live-cues] shutdown: terminating ${terminations.length} in-flight process tree(s)`)
    await Promise.allSettled(terminations)
  }
  for (const session of sessions.values()) {
    session.lease?.release()
    session.lease = null
  }
  sessions.clear()
}
