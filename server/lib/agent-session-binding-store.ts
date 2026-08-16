// The operational lease that says "this COS Chat is driving that desktop thread".
//
// Phase 1 of Continue Original Agent Thread. A binding is NOT historical
// provenance — it is a lease with a state, an expiry, and an epoch. Provenance
// is stamped into the job at admission and read from there forever after
// (plan 3.4). Reading the CURRENT binding to describe a FINISHED turn is the bug
// this separation exists to prevent.
//
// NAMING: this file holds the binding VALUE TYPE and its transitions. It is not
// a store — there is no persistence here yet, and the durable per-target epoch
// high-water mark that the replay defense depends on does not exist. Until it
// does, `priorEpoch` is caller-supplied and the anti-replay guarantee is only as
// good as whatever the caller reads it from. That gap is deliberate and named
// rather than implied.
//
// WHY AN EPOCH AND NOT JUST AN ID. The prompt queue is client-owned: up to five
// prompts can sit in an attached Chat holding no server state at all. If the
// binding expires or the user detaches, those rows are still on the phone and
// will eventually be submitted. Without an epoch, a prompt composed against
// binding N can land on a re-attach of the SAME target and execute against a
// conversation the user never intended.
//
// KEY ALIASING IS A REAL RISK, NOT A THEORETICAL ONE. `SAFE_ID_RE` in
// query-job-types.ts is `/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/`, which permits both
// `:` and `/` inside a session id, so `provider + ':' + id` is forgeable. Every
// composite identifier in this file is LENGTH-PREFIXED, which is injective for
// all string content. That applies to `boundToMarker` too: an earlier version
// built it by dot-joining three fields sixteen lines below a comment banning
// exactly that, and its safety rested on the incidental fact that a targetKey
// never contains `.` before its first `:`. Do not reintroduce concatenation.
//
// STATES ARE AN ALLOWLIST. Only `active` may run work. An earlier version
// rejected `detached`/`detaching` by denylist, which silently let `staging` —
// the pre-commit state of the journaled Chat handoff (plan 4.8) — execute real
// turns against a Chat that might still be rolled back.

import { isValidNativeThreadId } from './native-thread-id.js'
import type { AgentProvider } from './agent-session-store.js'

export type BindingState = 'staging' | 'active' | 'detaching' | 'detached'

/** Providers that can carry a binding. Cursor is Fork-only (plan 2.5). */
export const BINDABLE_PROVIDERS = ['claude', 'codex'] as const
export type BindableProvider = (typeof BINDABLE_PROVIDERS)[number]

export interface NativeBinding {
  bindingId: string
  cosSessionId: string
  /** Narrowed to the bindable subset so an unbindable provider is unrepresentable. */
  provider: BindableProvider
  /** Exact private native thread id. Never prefix-matched, never truncated. */
  nativeThreadId: string
  /** Injective mutex key. */
  targetKey: string
  workspaceFingerprint: string
  sourceFingerprint: string
  /** Opaque revision token observed at attach. Null when unsupported. */
  nativeHeadAtAttach: string | null
  /** Increments per attach to the same target. Positive integer. */
  epoch: number
  state: BindingState
  /** Epoch ms. Ignored while pinned. */
  expiresAt: number
  pinnedJobs: readonly string[]
}

export type BindingRejection =
  | 'invalid_thread_id'
  | 'invalid_provider'
  | 'invalid_binding_id'
  | 'invalid_epoch'
  | 'invalid_ttl'
  | 'unknown_binding'
  | 'binding_not_active'
  | 'binding_detached'
  | 'binding_expired'
  | 'stale_epoch'
  | 'target_mismatch'
  | 'missing_target_key'
  | 'binding_pinned'
  | 'terminal_state'

export interface BindingCheck {
  ok: boolean
  reason: BindingRejection | null
}

const OK: BindingCheck = { ok: true, reason: null }
const no = (reason: BindingRejection): BindingCheck => ({ ok: false, reason })

/** A bindingId must be safe to embed in a marker and to log. */
export const BINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isBindableProvider(value: unknown): value is BindableProvider {
  return typeof value === 'string' && (BINDABLE_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Injective composite key: `<len>:<provider>:<len>:<threadId>`.
 *
 * Length-prefixing is what makes it unforgeable. With plain `a:b`, provider `x`
 * with id `y:z` collides with provider `x:y` and id `z`. With lengths the parse
 * is unambiguous for every possible content.
 *
 * NOTE: this function validates nothing — the safety property lives in the
 * callers, all of which validate first.
 */
export function targetKey(provider: string, nativeThreadId: string): string {
  return `${provider.length}:${provider}:${nativeThreadId.length}:${nativeThreadId}`
}

export interface CreateBindingInput {
  bindingId: string
  cosSessionId: string
  provider: string
  nativeThreadId: string
  workspaceFingerprint: string
  sourceFingerprint: string
  nativeHeadAtAttach?: string | null
  /**
   * Highest epoch previously issued FOR THIS TARGET, from durable state.
   *
   * Reading this from the current in-memory binding rather than a persisted
   * high-water mark reopens the replay window: after detach and eviction the
   * next attach restarts at 1 and a queued row from the first attach matches.
   */
  priorEpoch?: number
  ttlMs: number
  now: number
}

export type CreateBindingResult =
  | { binding: NativeBinding; reason: null }
  | { binding: null; reason: BindingRejection }

export function createBinding(input: CreateBindingInput): CreateBindingResult {
  if (!isBindableProvider(input.provider)) return { binding: null, reason: 'invalid_provider' }
  if (!isValidNativeThreadId(input.nativeThreadId)) return { binding: null, reason: 'invalid_thread_id' }
  if (typeof input.bindingId !== 'string' || !BINDING_ID_RE.test(input.bindingId)) {
    return { binding: null, reason: 'invalid_binding_id' }
  }
  const prior = input.priorEpoch ?? 0
  if (!Number.isInteger(prior) || prior < 0) return { binding: null, reason: 'invalid_epoch' }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) return { binding: null, reason: 'invalid_ttl' }
  if (!Number.isFinite(input.now)) return { binding: null, reason: 'invalid_ttl' }

  return {
    binding: {
      bindingId: input.bindingId,
      cosSessionId: input.cosSessionId,
      provider: input.provider,
      nativeThreadId: input.nativeThreadId,
      targetKey: targetKey(input.provider, input.nativeThreadId),
      workspaceFingerprint: input.workspaceFingerprint,
      sourceFingerprint: input.sourceFingerprint,
      nativeHeadAtAttach: input.nativeHeadAtAttach ?? null,
      epoch: prior + 1,
      state: 'staging',
      expiresAt: input.now + input.ttlMs,
      pinnedJobs: [],
    },
    reason: null,
  }
}

export function isTerminal(binding: NativeBinding): boolean {
  return binding.state === 'detached' || binding.state === 'detaching'
}

/**
 * staging -> active. Refused from any other state.
 *
 * Without this guard `activate(detach(b))` resurrects a detached binding, which
 * QA verified against the first version.
 */
export function activate(binding: NativeBinding): { binding: NativeBinding | null; reason: BindingRejection | null } {
  if (binding.state !== 'staging') return { binding: null, reason: 'terminal_state' }
  return { binding: { ...binding, state: 'active' }, reason: null }
}

/** active -> detaching. The drain step that makes `detaching` reachable. */
export function beginDetach(binding: NativeBinding): NativeBinding {
  return isTerminal(binding) ? binding : { ...binding, state: 'detaching' }
}

export function pin(binding: NativeBinding, jobId: string): NativeBinding {
  // A terminal binding must not be re-pinned into permanent non-expiry.
  if (isTerminal(binding) || binding.pinnedJobs.includes(jobId)) return binding
  return { ...binding, pinnedJobs: [...binding.pinnedJobs, jobId] }
}

export function unpin(binding: NativeBinding, jobId: string): NativeBinding {
  return { ...binding, pinnedJobs: binding.pinnedJobs.filter(id => id !== jobId) }
}

export function isPinned(binding: NativeBinding): boolean {
  return binding.pinnedJobs.length > 0
}

/**
 * A pinned binding NEVER expires. Accepted or running work outranks the TTL.
 *
 * Known gap: `pinnedJobs` carries no timestamps, so a job that dies without
 * unpinning makes the binding immortal. A reaper needs per-pin ages; this shape
 * cannot express one.
 */
export function isExpired(binding: NativeBinding, now: number): boolean {
  if (isPinned(binding)) return false
  return now >= binding.expiresAt
}

/** Extend a lease. Never shortens, and never revives a terminal binding. */
export function renew(binding: NativeBinding, ttlMs: number, now: number): NativeBinding {
  if (isTerminal(binding) || !Number.isFinite(ttlMs) || !Number.isFinite(now)) return binding
  const next = now + ttlMs
  return next > binding.expiresAt ? { ...binding, expiresAt: next } : binding
}

/** Detach is refused while work is active (plan 3.4). */
export function canDetach(binding: NativeBinding): BindingCheck {
  return isPinned(binding) ? no('binding_pinned') : OK
}

/**
 * Detach, honoring `canDetach`.
 *
 * The first version exported an unguarded mutator next to its guard, so
 * `detach(pinnedBinding)` silently dropped the pins and orphaned the live job
 * the guard existed to protect.
 */
export function detach(
  binding: NativeBinding,
): { binding: NativeBinding; reason: null } | { binding: null; reason: BindingRejection } {
  const gate = canDetach(binding)
  if (!gate.ok) return { binding: null, reason: gate.reason! }
  return { binding: { ...binding, state: 'detached', pinnedJobs: [] }, reason: null }
}

/** Force-detach after an explicit user cancel that reached terminal state. */
export function forceDetach(binding: NativeBinding): NativeBinding {
  return { ...binding, state: 'detached', pinnedJobs: [] }
}

/**
 * The single gate every execution path must clear.
 *
 * `checkQueuedPrompt` and `verifyBoundTo` both delegate here so they cannot
 * disagree — the first version had the full set of checks in one and a bare
 * string comparison in the other, so a detached or expired binding passed
 * `verifyBoundTo` cleanly.
 */
export function assertUsable(binding: NativeBinding | null, now: number): BindingCheck {
  if (!binding) return no('unknown_binding')
  if (binding.state === 'detached' || binding.state === 'detaching') return no('binding_detached')
  // Allowlist: only `active` runs work. `staging` is pre-commit (plan 4.8).
  if (binding.state !== 'active') return no('binding_not_active')
  if (isExpired(binding, now)) return no('binding_expired')
  return OK
}

export interface QueuedPromptClaim {
  bindingId: string
  epoch: number
  /** Required. The strongest cross-target guard must not be opt-in. */
  targetKey: string
}

/**
 * Can this client-queued prompt still run?
 *
 * The queue lives on the phone and holds no server state, so a row can outlive
 * the binding it was composed against. Every rejection here is a row that would
 * otherwise either 409 opaquely or execute as a plain COS turn — the silent
 * Continue-to-ordinary downgrade the product contract bans (plan 4.2).
 */
export function checkQueuedPrompt(
  claim: QueuedPromptClaim,
  binding: NativeBinding | null,
  now: number,
): BindingCheck {
  if (!binding) return no('unknown_binding')
  if (claim.bindingId !== binding.bindingId) return no('unknown_binding')
  if (typeof claim.targetKey !== 'string' || claim.targetKey.length === 0) return no('missing_target_key')

  // State before epoch: detached is the more actionable answer for a user whose
  // queue drained after they detached.
  const usable = assertUsable(binding, now)
  if (!usable.ok && usable.reason !== 'binding_expired') return usable

  // Epoch before expiry: a re-attach is a different and more dangerous fault
  // than a timeout, and collapsing it into 'expired' hides that the target moved.
  if (claim.epoch !== binding.epoch) return no('stale_epoch')
  if (claim.targetKey !== binding.targetKey) return no('target_mismatch')
  return usable.ok ? OK : usable
}

/**
 * Opaque marker persisted INTO the request so a re-admission is recognizable.
 *
 * Without it, a re-admission through the generic route carries no attachment
 * fields at all — the binding lives in the route path and 4.2 forbids the client
 * sending execution fields — so the generic route's rejection cannot fire and an
 * attached turn degrades silently into an ordinary one.
 *
 * Length-prefixed for the same reason `targetKey` is.
 */
export function boundToMarker(binding: NativeBinding): string {
  const epoch = String(binding.epoch)
  return [
    `${binding.bindingId.length}:${binding.bindingId}`,
    `${epoch.length}:${epoch}`,
    `${binding.targetKey.length}:${binding.targetKey}`,
  ].join('')
}

/** Verify a marker AND that the binding it names may still run work. */
export function verifyBoundTo(marker: unknown, binding: NativeBinding | null, now: number): BindingCheck {
  const usable = assertUsable(binding, now)
  if (!usable.ok) return usable
  if (typeof marker !== 'string' || marker !== boundToMarker(binding!)) return no('target_mismatch')
  return OK
}

/** Is this request an attached turn at all? Used to reject it on generic routes. */
export function carriesBoundTo(request: Record<string, unknown> | null | undefined): boolean {
  return typeof request?.boundTo === 'string' && request.boundTo.length > 0
}
