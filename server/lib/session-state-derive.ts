// ONE derivation of a session's state, for every surface.
//
// Before 6.48.0 three readers derived state on their own: this server (`running` and
// `running_active` from occupancy and a 30 s transcript window), the Control helper
// (transcript tail + a 15 minute "in flight, then waiting" guess), and the EHPK (four
// states from the row's flags). The pet, the Sessions tab, the phone and the lens could
// disagree about the same tab. This function is the only place a state is decided;
// the rows carry its answer and its provenance.
//
// PRECEDENCE, in order, each with the evidence that makes it yield:
//
//   hook        the engine's own hook events for this session (`session-signal-store`)
//               yields to registry when the registry's status moved more recently and the
//               hooks have been silent for HOOK_SILENCE_MS
//   registry    `~/.claude/sessions/<pid>.json` status busy|idle|waiting with a live pid
//               yields to `ended` after MISS_LIMIT consecutive derives with a dead pid
//   transcript  whatever the transcript tail says (activity clock, in-flight marker)
//
// `ended` from a SessionEnd hook is honoured only when no alive registry record remains:
// a COS Continue child shares the tab's session id and ends while the tab stays open.
//
// The wire key is `agent_state`, never `state`: `state` already exists on every row as
// `running|recent` and Control renders anything else as "Running" (validation round 1).

import type { SessionSignal, WaitingKind } from './session-signal-store.js'

export type AgentState = 'running' | 'waiting' | 'idle' | 'failed' | 'ended'
export type StateSource = 'hook' | 'registry' | 'transcript'

export interface DerivedSessionState {
  agent_state: AgentState
  state_source: StateSource
  /** ISO time of the event that produced the current state. */
  state_since: string
  waiting_kind?: WaitingKind
  waiting_detail?: string
  failure?: string
  last_reply?: string
  pending_permission_id?: string
  /** Consecutive derives that saw a dead registry pid; carried by the caller between polls. */
  deadScans: number
}

/** The registry facts the deriver reads; a projection of the peer record, never the wire. */
export interface RegistryFacts {
  alive: boolean
  status: string | null
  waitingFor: string | null
  statusUpdatedAt: number | null
  lastActiveAt: number | null
}

/** What the transcript tail says, when nothing better is known. */
export interface TranscriptFacts {
  /** The newest assistant record is a tool_use with no result, or a user prompt awaits. */
  inFlight: boolean
  lastActivityAt: number | null
}

export interface DeriveInput {
  signal: SessionSignal | undefined
  registry: RegistryFacts | undefined
  transcript: TranscriptFacts | undefined
  now: number
  /** The previous derive's `deadScans`, so the two-scan rule survives between polls. */
  prevDeadScans?: number
}

/** Harness `MISS_LIMIT`: a pid must be dead on two consecutive scans before a row ends. */
export const MISS_LIMIT = 2
/** Hooks silent this long while the registry moved: the registry wins. */
export const HOOK_SILENCE_MS = 30 * 60_000
/** A turn that has been open this long with no event at all is no longer trusted as running. */
export const OPEN_TURN_CEILING_MS = 30 * 60_000

const iso = (ms: number) => new Date(ms).toISOString()

export function deriveSessionState(input: DeriveInput): DerivedSessionState {
  const { signal, registry, transcript, now } = input
  const prevDead = input.prevDeadScans ?? 0
  const deadScans = registry && !registry.alive ? prevDead + 1 : 0
  const registryMovedLater = !!(registry?.statusUpdatedAt && signal && registry.statusUpdatedAt > signal.lastEventAt)
  const hooksSilent = !!signal && now - signal.lastEventAt > HOOK_SILENCE_MS

  // A dead pid on two scans ends the row whatever the hooks last said, unless a hook
  // event is newer than the registry's last movement (a resumed tab under a new pid).
  if (registry && !registry.alive && deadScans >= MISS_LIMIT && !(signal && registry.lastActiveAt && signal.lastEventAt > registry.lastActiveAt)) {
    return { agent_state: 'ended', state_source: 'registry', state_since: iso(registry.lastActiveAt ?? now), deadScans, ...replyOf(signal) }
  }

  if (signal && !(registryMovedLater && hooksSilent)) {
    const fromHook = deriveFromSignal(signal, registry, now)
    if (fromHook) return { ...fromHook, deadScans }
  }

  if (registry?.alive) {
    const since = iso(registry.statusUpdatedAt ?? registry.lastActiveAt ?? now)
    if (registry.status === 'waiting') {
      return { agent_state: 'waiting', state_source: 'registry', state_since: since, waiting_kind: 'question', waiting_detail: registry.waitingFor ?? '', deadScans, ...replyOf(signal) }
    }
    if (registry.status === 'busy') return { agent_state: 'running', state_source: 'registry', state_since: since, deadScans, ...replyOf(signal) }
    if (registry.status === 'idle') return { agent_state: 'idle', state_source: 'registry', state_since: since, deadScans, ...replyOf(signal) }
  }

  if (transcript) {
    const since = iso(transcript.lastActivityAt ?? now)
    return { agent_state: transcript.inFlight ? 'running' : 'idle', state_source: 'transcript', state_since: since, deadScans, ...replyOf(signal) }
  }

  // Nothing known beyond a signal that was ruled stale above, or nothing at all.
  if (signal) return { agent_state: signal.turnOpen ? 'running' : 'idle', state_source: 'hook', state_since: iso(signal.lastEventAt), deadScans, ...replyOf(signal) }
  return { agent_state: 'idle', state_source: 'transcript', state_since: iso(now), deadScans }
}

function replyOf(signal: SessionSignal | undefined): { last_reply?: string } {
  return signal?.lastReply ? { last_reply: signal.lastReply } : {}
}

function deriveFromSignal(signal: SessionSignal, registry: RegistryFacts | undefined, now: number): Omit<DerivedSessionState, 'deadScans'> | null {
  const reply = replyOf(signal)
  if (signal.ended && !(registry?.alive)) {
    return { agent_state: 'ended', state_source: 'hook', state_since: iso(signal.ended.at), ...reply }
  }
  if (signal.waiting) {
    return {
      agent_state: 'waiting',
      state_source: 'hook',
      state_since: iso(signal.waiting.since),
      waiting_kind: signal.waiting.kind,
      waiting_detail: signal.waiting.detail,
      ...(signal.waiting.requestId ? { pending_permission_id: signal.waiting.requestId } : {}),
      ...reply,
    }
  }
  if (signal.failure && !signal.turnOpen) {
    return { agent_state: 'failed', state_source: 'hook', state_since: iso(signal.failure.at), failure: signal.failure.kind, ...reply }
  }
  if (signal.turnOpen) {
    // An open turn with no event for half an hour is not evidence of work any more;
    // let the registry or the transcript answer.
    if (now - signal.lastEventAt > OPEN_TURN_CEILING_MS) return null
    return { agent_state: 'running', state_source: 'hook', state_since: iso(signal.turnStartedAt ?? signal.lastEventAt), ...reply }
  }
  // A child that ended while the tab is alive reads idle, since the tab's own hooks are
  // what would say otherwise.
  return { agent_state: 'idle', state_source: 'hook', state_since: iso(signal.stopAt ?? signal.lastEventAt), ...reply }
}

/** The additive row fields, ready to spread onto a list or detail entry. */
export function derivedRowFields(derived: DerivedSessionState | undefined): Record<string, unknown> {
  if (!derived) return {}
  return {
    agent_state: derived.agent_state,
    state_source: derived.state_source,
    state_since: derived.state_since,
    ...(derived.waiting_kind ? { waiting_kind: derived.waiting_kind } : {}),
    ...(derived.waiting_detail !== undefined ? { waiting_detail: derived.waiting_detail } : {}),
    ...(derived.failure ? { failure: derived.failure } : {}),
    ...(derived.last_reply ? { last_reply: derived.last_reply } : {}),
    ...(derived.pending_permission_id ? { pending_permission_id: derived.pending_permission_id } : {}),
  }
}
