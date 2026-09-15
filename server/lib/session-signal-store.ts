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
//     matching PostToolUse/PostToolUseFailure (same tool name + input fingerprint),
//     PermissionDenied, Stop, UserPromptSubmit, SessionEnd, or the broker's own decision.
//     A parallel auto-allowed Read or a sub-agent's tool must not clear a real prompt.
//  2. A COS-spawned Continue child (`claude -p --resume <id>`) shares the Desktop tab's
//     session id and fires its own SessionStart/Stop/SessionEnd. Events whose spooled
//     ppid is a COS spawn are recorded as `child*` counters and never touch the phase.
//  3. `ended` is recorded here but RANKED in the deriver, which also sees the registry:
//     an ended signal with an alive registry record is a child that ended, not the tab.

import type { HookEnvelope, HookEventName } from './session-hook-events.js'
import { clipText, toolFingerprint, toolTarget } from './session-hook-events.js'

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
  /** Stamped by the newest Stop; the B6 occupancy clause compares it to the transcript. */
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
  /** Hooks have been seen for this session: the row may say `state_source: hook`. */
  hooksSeen: true
}

export interface ReducerContext {
  /** Is this pid (or its parent) a process COS spawned itself? */
  isCosSpawnedPid: (pid: number | null) => boolean
}

const KEEP_WARM_PREFIX = /^(ready|this is an automated local readiness check)/i

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
    hooksSeen: true,
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Waiting kinds a PostToolUse of the same tool resolves without a fingerprint match. */
const TOOL_WAITING: Record<string, WaitingKind> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }

function resolvesWaiting(waiting: WaitingSignal, toolName: string, fingerprint: string): boolean {
  if (waiting.fingerprint && waiting.fingerprint === fingerprint) return true
  // Question/plan tools carry no meaningful input to fingerprint; the tool name is the key.
  return waiting.kind !== 'permission' && waiting.toolName === toolName
}

/**
 * Apply one envelope. Returns a NEW record; the previous one is never mutated, so a
 * subscriber holding the old value sees a consistent snapshot.
 */
export function applyHookEvent(prev: SessionSignal | undefined, env: HookEnvelope, ctx: ReducerContext): SessionSignal {
  const base = prev ? { ...prev } : fresh(env)
  const p = env.payload
  const common = {
    cwd: str(p.cwd) ?? base.cwd,
    transcriptPath: str(p.transcript_path) ?? base.transcriptPath,
    permissionMode: str(p.permission_mode) ?? base.permissionMode,
  }

  // Rule 2: a COS-spawned child on this session id is counted, never applied.
  if (ctx.isCosSpawnedPid(env.ppid)) {
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
        keepWarm: KEEP_WARM_PREFIX.test(prompt),
      }
    }
    case 'PreToolUse': {
      const toolName = str(p.tool_name) ?? ''
      const kind = TOOL_WAITING[toolName]
      if (kind) {
        return {
          ...next,
          turnOpen: true,
          waiting: { kind, detail: toolTarget(p.tool_input, 120), toolName, fingerprint: toolFingerprint(toolName, p.tool_input ?? null), since: env.ts, requestId: null },
        }
      }
      return { ...next, lastTool: toolName || next.lastTool, lastToolAt: env.ts }
    }
    case 'PermissionRequest': {
      const toolName = str(p.tool_name) ?? ''
      const target = toolTarget(p.tool_input)
      return {
        ...next,
        turnOpen: true,
        waiting: {
          kind: 'permission',
          detail: target ? `${toolName} ${target}` : toolName,
          toolName,
          fingerprint: toolFingerprint(toolName, p.tool_input ?? null),
          since: env.ts,
          requestId: null,
        },
      }
    }
    case 'PermissionDenied':
      return { ...next, waiting: null }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const toolName = str(p.tool_name) ?? ''
      const fingerprint = toolFingerprint(toolName, p.tool_input ?? null)
      const waiting = next.waiting && resolvesWaiting(next.waiting, toolName, fingerprint) ? null : next.waiting
      return { ...next, waiting, lastTool: toolName || next.lastTool, lastToolAt: env.ts }
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

export type SignalListener = (signal: SessionSignal, env: HookEnvelope) => void

/** Records older than this after a SessionEnd are dropped; Control keeps its own ledger. */
export const SIGNAL_PRUNE_AFTER_END_MS = 6 * 60 * 60_000

export class SessionSignalStore {
  private readonly signals = new Map<string, SessionSignal>()
  private readonly listeners = new Set<SignalListener>()
  private readonly ctx: ReducerContext

  constructor(ctx: ReducerContext) {
    this.ctx = ctx
  }

  apply(env: HookEnvelope): SessionSignal {
    const next = applyHookEvent(this.signals.get(env.sessionId), env, this.ctx)
    this.signals.set(env.sessionId, next)
    for (const listener of this.listeners) {
      try { listener(next, env) } catch (error) {
        console.error(`[session-signals] listener failed: ${error instanceof Error ? error.message : error}`)
      }
    }
    return next
  }

  /** A permission the broker minted: attach its id so rows can carry `pending_permission_id`. */
  attachPermissionRequestId(sessionId: string, requestId: string | null): void {
    const current = this.signals.get(sessionId)
    if (!current?.waiting || current.waiting.kind !== 'permission') return
    this.signals.set(sessionId, { ...current, waiting: { ...current.waiting, requestId } })
  }

  /** The broker decided (allow or deny): that is resolution evidence. */
  resolveWaiting(sessionId: string): void {
    const current = this.signals.get(sessionId)
    if (!current?.waiting) return
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

  /** Drop records that ended long ago. Never drops a record with an open turn. */
  prune(nowMs = Date.now()): number {
    let dropped = 0
    for (const [id, signal] of this.signals) {
      if (signal.ended && !signal.turnOpen && nowMs - signal.ended.at > SIGNAL_PRUNE_AFTER_END_MS) {
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
