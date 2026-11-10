// 7.0.18 (X1, Miles 2026-11-10 07:14, "fold this in ... so I can respond from glasses, web app and desktop"):
// a session whose turn ENDS by asking a question in the Claude desktop app's next-step box.
//
// WHAT HAPPENS: the session calls `mcp__ccd_turn__wrap_up` with `ask` and reply buttons (`actions[].label`),
// then its turn stops. There is no AskUserQuestion and no PermissionRequest, so the permission broker never
// sees it, and the row read idle: the glasses said nothing was waiting (Miles, 07:02).
//
// WHAT COS RECEIVES (canaries C15 on the CLI with a stand-in ccd_turn server, C17 in a real Claude desktop
// Code tab, 2026-11-10): the COS hook spools PostToolUse for every tool, and that payload carries
// `tool_input.ask` and `tool_input.actions` verbatim, plus `prompt_id`; the Stop follows (about 5 s in the
// canary; the PostToolUse hook is async, so either order). PreToolUse is not spooled for this tool.
//
// WHAT THIS FILE DOES: keeps, per session, the newest qualifying ask (only an ask with at least one reply
// button, or `blocked`), marks it asked once the turn has stopped, shows it only after the Mac's desk has
// been idle for the broker's threshold (then latched, so the frozen glasses stay quiet while Miles sits at
// the Mac), and drops it on any reply, a new turn, the session ending, or 8 hours. The words (the ask, 80
// characters; reply labels, 40 each, at most 2) follow COS_WAITING_QUESTION_WORDS; with that at 0 the row
// still says a question waits, with no words. App-action buttons (commit, create PR) are never choices.
//
// THE SWITCH: `COS_TURN_END_ASKS`, read once (the first read, at startup), default in TURN_END_ASKS_DEFAULT.
// Off: nothing here runs, nothing is projected into the ledger, and every row is 7.0.17's.
//
// THE ANSWER is the existing Continue (contract v1, COORD 07:18), with text that never reads as typed at the
// desk. Memory and counters only; nothing here logs a question's words.

import { readSwitch } from './env-switch.js'
import { questionRowText } from './full-hold.js'
import type { HookEnvelope } from './session-hook-events.js'

/** The default when COS_TURN_END_ASKS is unset. One constant, per the lead (Miles chooses the value). */
export const TURN_END_ASKS_DEFAULT = true

/** The Claude desktop app's next-step tool (its `ccd_turn` MCP server). */
export const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'
export const TURN_ASK_MAX_CHARS = 80
export const TURN_ASK_CHOICE_MAX_CHARS = 40
export const TURN_ASK_MAX_CHOICES = 2
/** A question nobody answered in 8 hours is not news the next morning; it stays in the transcript. */
export const TURN_ASK_MAX_AGE_MS = 8 * 60 * 60_000
/** The shortest gap between two desk reads while an ask waits for the latch. */
export const TURN_ASK_DESK_POLL_MS = 3_000
/** When the desk cannot be read, the next try. */
export const TURN_ASK_UNREADABLE_RETRY_MS = 60_000
/** The latch never fires for a desk idle less than this, whatever the setting says (the broker's floor). */
export const TURN_ASK_DESK_IDLE_MIN_S = 30
/** Sessions tracked at once; past it the oldest go. */
export const MAX_TURN_ASKS = 128
/** The registry saying busy this long after the stop means the session runs again. */
export const TURN_ASK_BUSY_GRACE_MS = 5_000

let enabledAtStartup: boolean | null = null

/** `COS_TURN_END_ASKS`, read on the first call (startup) and kept: a change needs a restart. */
export function turnEndAsksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (enabledAtStartup === null) enabledAtStartup = readSwitch(env.COS_TURN_END_ASKS, TURN_END_ASKS_DEFAULT)
  return enabledAtStartup
}

/** Tests only: set the switch, or null to read it again on the next call. */
export function __setTurnEndAsksForTests(value: boolean | null): void {
  enabledAtStartup = value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function rowText(value: unknown, max: number): string {
  const text = questionRowText(value).replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** What is kept of one ask: already cleaned and bounded; empty words when the words switch is off. */
export interface TurnAskCapture { ask: string; choices: string[]; blocked: boolean }

/**
 * A `wrap_up` input read strictly. Null unless it carries a non-blank `ask` AND (at least one reply button
 * or `blocked: true`): an ask with no buttons is the session's suggestion, not a decision it stopped on. A
 * reply button has a `label` and no `action`; a button with an `action` (commit, create PR) is the app's own
 * and never a choice. `words` false keeps the fact and drops every word.
 */
export function captureTurnAsk(toolInput: unknown, words: boolean): TurnAskCapture | null {
  if (!isRecord(toolInput)) return null
  const ask = rowText(toolInput.ask, TURN_ASK_MAX_CHARS)
  if (!ask) return null
  const labels: string[] = []
  if (Array.isArray(toolInput.actions)) {
    for (const action of toolInput.actions) {
      if (!isRecord(action)) continue
      if (action.action !== undefined && action.action !== null && action.action !== '') continue
      const label = rowText(action.label, TURN_ASK_CHOICE_MAX_CHARS)
      if (label) labels.push(label)
    }
  }
  const blocked = toolInput.blocked === true
  if (labels.length === 0 && !blocked) return null
  return { ask: words ? ask : '', choices: words ? labels.slice(0, TURN_ASK_MAX_CHOICES) : [], blocked }
}

/** The ledger's copy (`projectHookPayload`): the capture as stored, so a restart replays it. */
export function projectedTurnAsk(value: unknown): TurnAskCapture | null {
  if (!isRecord(value) || typeof value.ask !== 'string' || !Array.isArray(value.choices)) return null
  const choices = value.choices.filter((c): c is string => typeof c === 'string').slice(0, TURN_ASK_MAX_CHOICES).map(c => rowText(c, TURN_ASK_CHOICE_MAX_CHARS)).filter(Boolean)
  return { ask: rowText(value.ask, TURN_ASK_MAX_CHARS), choices, blocked: value.blocked === true }
}

/** What a row shows (`deriveSessionState` input). */
export interface VisibleTurnAsk { ask: string; choices: string[]; stoppedAt: number }

interface AskState {
  sessionId: string
  promptId: string | null
  capture: TurnAskCapture
  armedAt: number
  stoppedAt: number | null
  visibleAt: number | null
}

export interface TurnEndAskTrackerDeps {
  now(): number
  enabled(): boolean
  /** COS_WAITING_QUESTION_WORDS (default on): the words, or the fact alone. */
  words(): boolean
  readDeskIdleSeconds(): Promise<number | null>
  deskIdleSeconds(): number
  pollMs?: number
}

export type TurnEndAskCounters = { armed: number; shown: number; clearedByReply: number; clearedByTurn: number; agedOut: number }

/** Events that end a session's present: whatever it asked is moot. */
const SESSION_RESETS: ReadonlySet<string> = new Set(['SessionEnd', 'Interrupt', 'StopFailure'])

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export class TurnEndAskTracker {
  private readonly deps: TurnEndAskTrackerDeps
  private readonly asks = new Map<string, AskState>()
  /** The newest Stop per session, for a wrap_up whose (async) PostToolUse lands after it. */
  private readonly lastStop = new Map<string, { at: number; promptId: string | null }>()
  private poll: ReturnType<typeof setTimeout> | null = null
  private pollInFlight = false
  private stopped = false
  readonly counters: TurnEndAskCounters = { armed: 0, shown: 0, clearedByReply: 0, clearedByTurn: 0, agedOut: 0 }

  constructor(deps: TurnEndAskTrackerDeps) {
    this.deps = deps
  }

  /**
   * One applied hook event (the signal store's subscriber: the raw envelope live, the ledger's projection
   * on replay). `signal` is the store's signal after the event; only its registry `entrypoint` is read.
   */
  observe(env: HookEnvelope, child: boolean, signal?: { entrypoint: string | null }): void {
    if (!this.deps.enabled()) return
    const p = env.payload
    // A sub-agent's events are never the session asking you, and never its reply.
    if (str(p.agent_id)) return
    const sessionId = env.sessionId.toLowerCase()
    const current = this.asks.get(sessionId)
    // Any prompt, from the desk or a COS-spawned Continue child, is a reply: the question is answered.
    if (env.event === 'UserPromptSubmit') {
      if (current) { this.asks.delete(sessionId); this.counters.clearedByReply++ }
      return
    }
    // A COS-spawned child's other events are not the session's own turn.
    if (child) return
    if (SESSION_RESETS.has(env.event) || (env.event === 'SessionStart' && p.source !== 'compact')) {
      if (current) { this.asks.delete(sessionId); this.counters.clearedByTurn++ }
      this.lastStop.delete(sessionId)
      return
    }
    if (env.event === 'Stop') {
      const promptId = str(p.prompt_id)
      this.rememberStop(sessionId, env.ts, promptId)
      if (current && current.stoppedAt === null && env.ts >= current.armedAt && (current.promptId === null || promptId === null || current.promptId === promptId)) {
        current.stoppedAt = env.ts
        this.ensurePolling()
      }
      return
    }
    const toolName = typeof p.tool_name === 'string' ? p.tool_name : ''
    if (env.event === 'PostToolUse' && toolName === WRAP_UP_TOOL) {
      // A print run never asks anyone (the broker's own rule: registry entrypoint sdk-cli).
      if (signal?.entrypoint === 'sdk-cli') return
      const capture = p.turn_ask !== undefined ? projectedTurnAsk(p.turn_ask) : captureTurnAsk(p.tool_input, this.deps.words())
      const promptId = str(p.prompt_id)
      if (!capture) {
        // A later wrap_up of the same turn without a qualifying ask disarms the earlier one.
        if (current && current.stoppedAt === null) this.asks.delete(sessionId)
        return
      }
      const stop = this.lastStop.get(sessionId)
      const stoppedAlready = !!stop && env.ts <= stop.at && (stop.promptId === null || promptId === null || stop.promptId === promptId)
      this.asks.set(sessionId, { sessionId, promptId, capture, armedAt: env.ts, stoppedAt: stoppedAlready ? stop!.at : null, visibleAt: null })
      this.counters.armed++
      this.prune()
      if (stoppedAlready) this.ensurePolling()
      return
    }
    // Any other tool step after the stop, from another prompt, is a new turn running: the ask is moot.
    if (current && current.stoppedAt !== null && env.ts > current.stoppedAt && (env.event === 'PreToolUse' || env.event === 'PostToolUse' || env.event === 'PostToolUseFailure' || env.event === 'PermissionRequest')) {
      const promptId = str(p.prompt_id)
      if (promptId === null || current.promptId === null || promptId !== current.promptId) {
        this.asks.delete(sessionId)
        this.counters.clearedByTurn++
      }
    }
  }

  private rememberStop(sessionId: string, at: number, promptId: string | null): void {
    this.lastStop.delete(sessionId)
    this.lastStop.set(sessionId, { at, promptId })
    if (this.lastStop.size > MAX_TURN_ASKS) {
      const oldest = this.lastStop.keys().next().value
      if (oldest !== undefined) this.lastStop.delete(oldest)
    }
  }

  /** The ask a row shows now: stopped, latched visible, not older than the age-out. */
  visibleAsk(sessionId: string, now = this.deps.now()): VisibleTurnAsk | null {
    if (!this.deps.enabled()) return null
    const key = sessionId.toLowerCase()
    const state = this.asks.get(key) ?? (key.length < 36 ? [...this.asks.values()].find(s => s.sessionId.startsWith(key)) : undefined)
    if (!state || state.stoppedAt === null) return null
    if (now - state.stoppedAt > TURN_ASK_MAX_AGE_MS) {
      this.asks.delete(state.sessionId)
      this.counters.agedOut++
      return null
    }
    if (state.visibleAt === null) return null
    return { ask: state.capture.ask, choices: [...state.capture.choices], stoppedAt: state.stoppedAt }
  }

  /** The session's row ended: nothing it asked can still be answered. */
  sessionRowEnded(sessionId: string): void {
    const key = sessionId.toLowerCase()
    for (const state of [...this.asks.values()]) {
      if (state.sessionId === key || (key.length < 36 && state.sessionId.startsWith(key))) { this.asks.delete(state.sessionId); this.counters.clearedByTurn++ }
    }
  }

  private prune(): void {
    const now = this.deps.now()
    for (const state of [...this.asks.values()]) {
      if (state.stoppedAt !== null && now - state.stoppedAt > TURN_ASK_MAX_AGE_MS) { this.asks.delete(state.sessionId); this.counters.agedOut++ }
    }
    while (this.asks.size > MAX_TURN_ASKS) {
      const oldest = [...this.asks.values()].sort((a, b) => a.armedAt - b.armedAt)[0]
      if (!oldest) break
      this.asks.delete(oldest.sessionId)
    }
  }

  private waitingForLatch(): boolean {
    for (const state of this.asks.values()) if (state.stoppedAt !== null && state.visibleAt === null) return true
    return false
  }

  private ensurePolling(): void {
    if (this.poll || this.stopped || !this.waitingForLatch()) return
    this.schedule(this.deps.pollMs ?? TURN_ASK_DESK_POLL_MS)
  }

  private schedule(delayMs: number): void {
    this.stopPolling()
    if (this.stopped) return
    this.poll = setTimeout(() => {
      this.poll = null
      void this.tick().then(next => { if (next !== null) this.schedule(next) })
    }, delayMs)
    this.poll.unref?.()
  }

  private stopPolling(): void {
    if (this.poll) clearTimeout(this.poll)
    this.poll = null
  }

  private thresholdS(): number {
    const configured = Number(this.deps.deskIdleSeconds())
    return Math.max(TURN_ASK_DESK_IDLE_MIN_S, Number.isFinite(configured) ? configured : TURN_ASK_DESK_IDLE_MIN_S)
  }

  /**
   * One desk read while an ask waits: idle at or past the threshold latches every stopped ask visible.
   * Returns when to read again (ms), or null when nothing waits. The desk cannot reach the threshold
   * sooner than (threshold - idle) seconds, so a busy desk is read about once per threshold, not every
   * poll: an unanswered ask on a Mac in use costs one `ioreg` a minute or so, never one every 3 s.
   */
  async tick(): Promise<number | null> {
    this.prune()
    if (!this.waitingForLatch()) return null
    const pollMs = this.deps.pollMs ?? TURN_ASK_DESK_POLL_MS
    if (this.pollInFlight) return pollMs
    this.pollInFlight = true
    let idle: number | null = null
    try { idle = await this.deps.readDeskIdleSeconds() } catch { idle = null } finally { this.pollInFlight = false }
    // Unreadable: nothing is shown (it never guesses the desk is empty); read again later.
    if (idle === null || !Number.isFinite(idle)) return Math.max(pollMs, TURN_ASK_UNREADABLE_RETRY_MS)
    const threshold = this.thresholdS()
    if (idle < threshold) return Math.max(pollMs, Math.ceil((threshold - idle) * 1000))
    const now = this.deps.now()
    for (const state of this.asks.values()) {
      if (state.stoppedAt !== null && state.visibleAt === null) { state.visibleAt = now; this.counters.shown++ }
    }
    return null
  }

  stats(): TurnEndAskCounters & { tracked: number } {
    return { ...this.counters, tracked: this.asks.size }
  }

  stop(): void {
    this.stopped = true
    this.stopPolling()
  }
}
