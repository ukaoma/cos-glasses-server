// The signal store: what the hooks have said about each Claude session, reduced to
// one record per full session id.
//
// POSITIVE SIGNALS ONLY. Before 6.48.0 every state on a session row was inferred: a
// registry pid that answers signal 0, a transcript mtime inside a window, a tool_use
// block with no result behind it. This store holds what the engine itself announced
// through its hooks (session started, prompt submitted, permission wanted, turn stopped,
// session ended), and `session-state-derive.ts` ranks it above every inference.
//
// The reducer is PURE (`applyHookEvent`), so a recorded sequence of envelopes replays
// into a deterministic record and the fixtures under `__fixtures__/session-hooks-6.48.0`
// are the specification. Three rules that came out of the validation rounds:
//
//  1. A `waiting` entry clears only on RESOLUTION EVIDENCE for that request: the
//     matching PostToolUse/PostToolUseFailure/PermissionDenied (same tool name + input
//     fingerprint), or a turn boundary (Stop, StopFailure, UserPromptSubmit, SessionEnd, a
//     non-compact SessionStart), or the broker's own decision. A parallel auto-allowed
//     Read or a sub-agent's tool must not clear a real prompt. The deriver adds two more
//     clearers it can see and this store cannot: a registry status that moved after the
//     wait, and transcript activity newer than the wait.
//  2. A COS-spawned Continue child (`claude -p --resume <id>`) shares the Desktop tab's
//     session id and fires its own SessionStart/Stop/SessionEnd. Events whose spooled
//     ppid is a COS spawn are recorded as `child*` counters and never touch the phase.
//  3. `ended` is recorded here but RANKED in the deriver, which also sees the registry:
//     an ended signal with an alive registry record is a child that ended, not the tab.

import type { HookEnvelope, HookEventName } from './session-hook-events.js'
import { clipText, toolFingerprint, toolTarget } from './session-hook-events.js'
import { isKeepWarmSessionTitle } from './agent-session-store.js'

export type WaitingKind = 'permission' | 'question' | 'plan' | 'mcp_input'

export interface WaitingSignal {
  kind: WaitingKind
  /** "Bash git push", "Use the API error text in the form?", "" */
  detail: string
  toolName: string
  /** sha256(tool_name + canonical tool_input); '' when the event carried no tool. */
  fingerprint: string
  since: number
  /** The broker's minted id when a permission request is pending there. */
  requestId: string | null
}

export interface FailureSignal {
  kind: string
  at: number
}

export interface SessionSignal {
  sessionId: string
  firstSeenAt: number
  lastEventAt: number
  lastEvent: HookEventName
  cwd: string | null
  transcriptPath: string | null
  permissionMode: string | null
  model: string | null
  /** A prompt was submitted and no Stop/StopFailure/SessionEnd has closed it. */
  turnOpen: boolean
  turnStartedAt: number | null
  promptId: string | null
  /** Stamped by the newest Stop: `state_since` for an idle row, and the instant the B6 occupancy clause and the drain gate compare with the registry's `statusUpdatedAt` (6.48.1). */
  stopAt: number | null
  waiting: WaitingSignal | null
  failure: FailureSignal | null
  lastReply: string
  lastTool: string | null
  lastToolAt: number | null
  subagentsOpen: number
  ended: { at: number; reason: string } | null
  /** The prompt prefix Control already suppresses as a readiness check. */
  keepWarm: boolean
  compactions: number
  /** Events from a COS-spawned child on this id, kept out of the phase. */
  childEvents: number
  /**
   * The registry's `entrypoint` for this session (`claude-desktop`, `cli`, `sdk-cli`), read
   * from `~/.claude/sessions` while the process is alive; null until seen. A `claude -p` job
   * registers as `sdk-cli` (measured 2026-09-15), which is how `/runs` tells a job from a tab.
   */
  entrypoint: string | null
  /** Hooks have been seen for this session: the row may say `state_source: hook`. */
  hooksSeen: true
}

export interface ReducerContext {
  /** Is this pid (or its parent) a process COS spawned itself? Consulted only when the
   *  envelope was not already classified at ingest (`child`). */
  isCosSpawnedPid: (pid: number | null) => boolean
}

/** The tool fields the reducer reads: the live payload's, or the ledger's projection on replay. */
function toolFacts(p: Record<string, unknown>): { name: string; target: string; fingerprint: string } {
  const name = typeof p.tool_name === 'string' ? p.tool_name : ''
  const projectedTarget = typeof p.tool_target === 'string' ? p.tool_target : null
  const projectedFingerprint = typeof p.tool_fingerprint === 'string' ? p.tool_fingerprint : null
  return {
    name,
    target: projectedTarget ?? toolTarget(p.tool_input),
    fingerprint: projectedFingerprint ?? toolFingerprint(name, p.tool_input ?? null),
  }
}

function fresh(env: HookEnvelope): SessionSignal {
  return {
    sessionId: env.sessionId,
    firstSeenAt: env.ts,
    lastEventAt: env.ts,
    lastEvent: env.event,
    cwd: null,
    transcriptPath: null,
    permissionMode: null,
    model: null,
    turnOpen: false,
    turnStartedAt: null,
    promptId: null,
    stopAt: null,
    waiting: null,
    failure: null,
    lastReply: '',
    lastTool: null,
    lastToolAt: null,
    subagentsOpen: 0,
    ended: null,
    keepWarm: false,
    compactions: 0,
    childEvents: 0,
    entrypoint: null,
    hooksSeen: true,
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/**
 * 6.48.1. A tool runs only inside a turn, so a MAIN-THREAD tool event (no `agent_id`) is
 * evidence the turn is open even when its UserPromptSubmit was never seen: a tab adopted
 * mid-turn when the hooks were installed (2.1.272 reloads hooks on the settings change,
 * measured 2026-09-15 16:16) read `idle` from the hooks while the registry said busy. A
 * sub-agent's tool events carry `agent_id` and say nothing about the main thread, and a
 * tool event after SessionEnd is a child's, never the tab's.
 */
function turnOpenedByTool(prev: SessionSignal, p: Record<string, unknown>, at: number): Partial<SessionSignal> {
  if (prev.turnOpen || prev.ended || str(p.agent_id)) return {}
  return { turnOpen: true, turnStartedAt: prev.turnStartedAt ?? at }
}

/** Waiting kinds a PostToolUse of the same tool resolves without a fingerprint match. */
const TOOL_WAITING: Record<string, WaitingKind> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }

/** The tool whose PermissionRequest is a question card, not an approval (6.52.0). */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * 6.52.0: the permission broker's id survives a re-announcement of the SAME request. The
 * async PreToolUse can land after the PermissionRequest (and the spool after the broker
 * parked it), and either rewrite of `waiting` would otherwise drop the id the rows carry.
 */
function keptRequestId(prev: WaitingSignal | null, fingerprint: string): string | null {
  return prev?.requestId && fingerprint && prev.fingerprint === fingerprint ? prev.requestId : null
}

function resolvesWaiting(waiting: WaitingSignal, event: HookEventName, toolName: string, fingerprint: string): boolean {
  if (waiting.fingerprint && waiting.fingerprint === fingerprint) return true
  // Question/plan tools carry no meaningful input to fingerprint; the tool name is the key.
  if (waiting.kind !== 'permission') return waiting.toolName === toolName
  // A permission dialog is one at a time (canary 11: hooks run serially), and only a
  // denied PROMPT fires PermissionDenied, so a denial naming the waiting tool is that
  // prompt's denial even when the dialog rewrote the input. PostToolUse of the same name
  // is not: a parallel auto-allowed Bash must not clear a prompt that still stands.
  return event === 'PermissionDenied' && waiting.toolName === toolName
}

/**
 * Apply one envelope. Returns a NEW record; the previous one is never mutated, so a
 * subscriber holding the old value sees a consistent snapshot.
 */
export function applyHookEvent(prev: SessionSignal | undefined, env: HookEnvelope, ctx: ReducerContext, child?: boolean): SessionSignal {
  const base = prev ? { ...prev } : fresh(env)
  const p = env.payload
  const common = {
    cwd: str(p.cwd) ?? base.cwd,
    transcriptPath: str(p.transcript_path) ?? base.transcriptPath,
    permissionMode: str(p.permission_mode) ?? base.permissionMode,
  }

  // Rule 2: a COS-spawned child on this session id is counted, never applied. The verdict
  // is taken at ingest (and remembered on the ledger row) because the spawn ledger forgets
  // a pid the moment the child exits.
  if (child ?? ctx.isCosSpawnedPid(env.ppid)) {
    return { ...base, ...common, childEvents: base.childEvents + 1 }
  }

  const next: SessionSignal = { ...base, ...common, lastEventAt: Math.max(base.lastEventAt, env.ts), lastEvent: env.event }

  switch (env.event) {
    case 'SessionStart': {
      const source = str(p.source) ?? 'startup'
      next.model = str(p.model) ?? next.model
      if (source === 'compact') { next.compactions += 1; return next }
      // startup | resume | clear | fork: a fresh conversation surface, nothing in flight.
      return { ...next, turnOpen: false, turnStartedAt: null, waiting: null, failure: null, ended: null, subagentsOpen: 0 }
    }
    case 'UserPromptSubmit': {
      const prompt = clipText(p.prompt)
      return {
        ...next,
        turnOpen: true,
        turnStartedAt: env.ts,
        promptId: str(p.prompt_id),
        waiting: null,
        failure: null,
        // The same predicate the session list uses to hide readiness checks.
        keepWarm: prompt.length > 0 && isKeepWarmSessionTitle(prompt),
      }
    }
    case 'PreToolUse': {
      const tool = toolFacts(p)
      const kind = TOOL_WAITING[tool.name]
      if (kind) {
        return {
          ...next,
          turnOpen: true,
          waiting: { kind, detail: tool.target, toolName: tool.name, fingerprint: tool.fingerprint, since: env.ts, requestId: keptRequestId(next.waiting, tool.fingerprint) },
        }
      }
      return { ...next, ...turnOpenedByTool(next, p, env.ts), lastTool: tool.name || next.lastTool, lastToolAt: env.ts }
    }
    case 'PermissionRequest': {
      const tool = toolFacts(p)
      return {
        ...next,
        turnOpen: true,
        waiting: {
          // 6.52.0: an AskUserQuestion stays a QUESTION through its PermissionRequest. As
          // `permission` it cleared only on a fingerprint match, and the answered tool's
          // PostToolUse carries `answers` in its input, so the row could stay waiting.
          kind: tool.name === ASK_USER_QUESTION_TOOL ? 'question' : 'permission',
          detail: tool.target ? `${tool.name} ${tool.target}` : tool.name,
          toolName: tool.name,
          fingerprint: tool.fingerprint,
          since: env.ts,
          requestId: keptRequestId(next.waiting, tool.fingerprint),
        },
      }
    }
    case 'PermissionDenied':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const tool = toolFacts(p)
      const waiting = next.waiting && resolvesWaiting(next.waiting, env.event, tool.name, tool.fingerprint) ? null : next.waiting
      const ran = env.event !== 'PermissionDenied'
      return { ...next, ...turnOpenedByTool(next, p, env.ts), waiting, ...(ran ? { lastTool: tool.name || next.lastTool, lastToolAt: env.ts } : {}) }
    }
    case 'Notification': {
      const type = str(p.notification_type) ?? ''
      if (type === 'idle_prompt') return { ...next, turnOpen: false }
      if (next.waiting) return next // a dialog already owns the attention; never downgrade its kind
      const message = clipText(p.message, 120)
      const kind: WaitingKind | null =
        type === 'permission_prompt' ? 'permission'
        : type === 'agent_needs_input' ? 'question'
        : type === 'elicitation_dialog' ? 'mcp_input'
        : null
      if (!kind) return next
      return { ...next, turnOpen: true, waiting: { kind, detail: message, toolName: '', fingerprint: '', since: env.ts, requestId: null } }
    }
    case 'Stop':
      return {
        ...next,
        turnOpen: false,
        stopAt: env.ts,
        waiting: null,
        lastReply: clipText(p.last_assistant_message) || next.lastReply,
      }
    case 'StopFailure':
      return {
        ...next,
        turnOpen: false,
        waiting: null,
        failure: { kind: str(p.matcher) ?? str(p.error_type) ?? (clipText(p.error, 60) || 'unknown'), at: env.ts },
      }
    case 'SubagentStart':
      return { ...next, subagentsOpen: next.subagentsOpen + 1 }
    case 'SubagentStop':
      return { ...next, subagentsOpen: Math.max(0, next.subagentsOpen - 1) }
    case 'PostCompact':
      return { ...next, compactions: next.compactions + 1 }
    case 'PostModelSwitch':
      return { ...next, model: str(p.to_model) ?? next.model }
    case 'SessionEnd':
      return { ...next, turnOpen: false, waiting: null, ended: { at: env.ts, reason: str(p.reason) ?? 'other' } }
  }
}

export type SignalListener = (signal: SessionSignal, env: HookEnvelope, child: boolean) => void

/** Records older than this after a SessionEnd are dropped; Control keeps its own ledger. */
export const SIGNAL_PRUNE_AFTER_END_MS = 6 * 60 * 60_000
/** A record with no event at all for this long is a tab that died without a SessionEnd. */
export const SIGNAL_PRUNE_SILENT_MS = 24 * 60 * 60_000

export class SessionSignalStore {
  private readonly signals = new Map<string, SessionSignal>()
  private readonly listeners = new Set<SignalListener>()
  private readonly ctx: ReducerContext

  constructor(ctx: ReducerContext) {
    this.ctx = ctx
  }

  apply(env: HookEnvelope, child?: boolean): SessionSignal {
    const next = applyHookEvent(this.signals.get(env.sessionId), env, this.ctx, child)
    this.signals.set(env.sessionId, next)
    const isChild = child ?? this.ctx.isCosSpawnedPid(env.ppid)
    for (const listener of this.listeners) {
      try { listener(next, env, isChild) } catch (error) {
        console.error(`[session-signals] listener failed: ${error instanceof Error ? error.message : error}`)
      }
    }
    return next
  }

  /** The registry's entrypoint, once the runtime has read it; a no-op for an unknown session. */
  setEntrypoint(sessionId: string, entrypoint: string | null): void {
    const current = this.signals.get(sessionId)
    if (!current || !entrypoint || current.entrypoint === entrypoint) return
    this.signals.set(sessionId, { ...current, entrypoint })
  }

  /**
   * The permission broker (6.52.0) attaches its item id so rows can carry
   * `pending_permission_id` (an approval) or `pending_question_id` (an AskUserQuestion).
   * Widened to `question` in 6.52.0. With a fingerprint, only the wait for THAT request
   * takes the id: a different dialog now standing must never advertise it. True when set.
   */
  attachPermissionRequestId(sessionId: string, requestId: string | null, fingerprint?: string): boolean {
    const current = this.signals.get(sessionId)
    if (!current?.waiting || (current.waiting.kind !== 'permission' && current.waiting.kind !== 'question')) return false
    if (fingerprint !== undefined && current.waiting.fingerprint !== fingerprint) return false
    this.signals.set(sessionId, { ...current, waiting: { ...current.waiting, requestId } })
    return true
  }

  /** The broker let go of a request without deciding it: drop its id, keep the wait. */
  detachPermissionRequestId(sessionId: string, requestId: string): void {
    const current = this.signals.get(sessionId)
    if (!current?.waiting || current.waiting.requestId !== requestId) return
    this.signals.set(sessionId, { ...current, waiting: { ...current.waiting, requestId: null } })
  }

  /**
   * The broker decided (allow or deny): that is resolution evidence. With `match` (6.52.0),
   * only the wait that carries the broker's id, or that is the same request by fingerprint,
   * is cleared; a different dialog standing now is left alone.
   */
  resolveWaiting(sessionId: string, match?: { requestId: string; fingerprint: string }): void {
    const current = this.signals.get(sessionId)
    if (!current?.waiting) return
    if (match && current.waiting.requestId !== match.requestId && current.waiting.fingerprint !== match.fingerprint) return
    this.signals.set(sessionId, { ...current, waiting: null })
  }

  get(sessionId: string): SessionSignal | undefined {
    return this.signals.get(sessionId.toLowerCase())
  }

  /** Eight-char prefix lookup for the registry's short ids. Two matches means no answer. */
  getByPrefix(prefix: string): SessionSignal | undefined {
    const needle = prefix.toLowerCase()
    let found: SessionSignal | undefined
    for (const [id, signal] of this.signals) {
      if (!id.startsWith(needle)) continue
      if (found) return undefined
      found = signal
    }
    return found
  }

  subscribe(listener: SignalListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Drop records that ended long ago, and records silent for a day (a tab that died with no SessionEnd). */
  prune(nowMs = Date.now()): number {
    let dropped = 0
    for (const [id, signal] of this.signals) {
      const endedLongAgo = !!signal.ended && !signal.turnOpen && nowMs - signal.ended.at > SIGNAL_PRUNE_AFTER_END_MS
      const silentForADay = nowMs - signal.lastEventAt > SIGNAL_PRUNE_SILENT_MS
      if (endedLongAgo || silentForADay) {
        this.signals.delete(id)
        dropped++
      }
    }
    return dropped
  }

  size(): number {
    return this.signals.size
  }

  /** Every record, newest event first. A copy: callers cannot reach the map. */
  snapshot(): SessionSignal[] {
    return [...this.signals.values()].sort((a, b) => b.lastEventAt - a.lastEventAt)
  }

  newestEventAt(): number | null {
    let newest: number | null = null
    for (const signal of this.signals.values()) {
      if (newest === null || signal.lastEventAt > newest) newest = signal.lastEventAt
    }
    return newest
  }

  __resetForTests(): void {
    this.signals.clear()
    this.listeners.clear()
  }
}
