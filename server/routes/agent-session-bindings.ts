// GET  /api/agent-sessions/:provider/:threadId/attachability
// GET  /api/agent-sessions/bindings
// POST /api/agent-sessions/:provider/:threadId/attach
// POST /api/agent-sessions/bindings/:bindingId/turns
//
// The client-facing half of Continue Original Agent Thread. Phase 0 resolved
// plan 4.3 to option B: COS attaches to a native desktop thread ONLY when no
// live process owns it. This router is where the lens and Control ask that
// question, and it is the ONLY thing standing between a "not sure" and a write
// into a conversation somebody else is holding.
//
// FAIL CLOSED, WITHOUT EXCEPTION. Every unknown, throw, missing dependency,
// unreadable row and unrecognised input resolves to not-attachable with a named
// reason. The sibling detector's header lists six inputs where the first version
// turned "I found no owner" into "there is no owner"; this file must not add a
// seventh at the edge. There is exactly one way to reach `attachable: true`:
// a supported provider, a valid id, a detector that demonstrably exists on this
// install, every candidate record parsed, and no owner that is not provably ours.
//
// WHAT THIS ROUTE MAY NOT SAY. Plan 3.3 requires the client-visible reference to
// be non-identifying, and lib/claude-session-registry.ts:117 goes to real trouble
// never to spread a raw registry record toward a lens. So the response body is
// four fields, listed by hand, and carries NO pid, NO native thread id, NO
// filesystem or socket path, NO cwd and NO target lock key. `ownerCount` is the
// entire owner projection. The test asserts the exact key set and that the whole
// serialized body contains no '/' at all, which is a cheap standing proof that
// nothing path-shaped ever leaks through a future edit.
//
// EVERYTHING IS INJECTED. Probes, directories, the clock and the binding registry
// all arrive as dependencies, following `createQueryJobsRouter` (routes/query-jobs.ts,
// registered at index.ts:269). That is what lets the whole verdict surface be
// tested without a real machine, a real Claude install, or a real wall clock.
//
// AUTH AND NETWORK POLICY ARE INHERITED, NOT INVENTED. index.ts applies the IP
// allowlist (:134), CORS (:144) and `requireApiToken` (:157) to everything under
// /api before any router is reached, exactly as `agentSessionsRouter` (:279) and
// `claudeSessionsRouter` (:282) rely on. This router adds no auth of its own and
// must be mounted the same way: `app.use('/api', createAgentSessionBindingsRouter(deps))`.
//
// NO FEATURE FLAG, deliberately. `claude-sessions` is dark by default because it
// projects another product's 0700 state directory onto the wire. This route
// projects a boolean, a reason enum and a count. There is nothing here to gate,
// and a flag would only add a state in which the lens cannot tell "unsafe to
// attach" from "switched off".
//
// ---------------------------------------------------------------- write side
//
// The two POST routes below take the same posture and add four rules of their
// own. They are the first code in this feature that can change a real desktop
// conversation, so read them as "what has to be TRUE before a prompt moves",
// never as "what has to be false before we refuse".
//
//  1. THE OCCUPANCY VERDICT IS A HARD PRECONDITION, TWICE. Plan 4.3 resolved to
//     option B: protocol 1 attaches only to a thread with no live owner. Attach
//     refuses on any doubt the detector can raise, and the turn route RE-RUNS the
//     same detector immediately before delivery (plan 4.3 step 6). A newly
//     appeared owner there is terminal, not a warning — there is no COS-side
//     cross-process lock that could fence a desktop writer, so the only safe
//     response to one appearing is to not deliver.
//
//  2. SELF-RECURSION ORDERING (plan 4.4). A `claude --resume <id>` child writes
//     ITSELF into ~/.claude/sessions/<pid>.json carrying the id we are targeting,
//     so from the next check's point of view our own child is a live foreign
//     owner. The spawn ledger is the only thing that tells them apart and it is
//     keyed pid -> process START, so the order is fixed:
//         re-check -> spawn -> record(pid, MEASURED start) -> prompt -> release
//     The start MUST come from `probes.processStartMs(pid)`. `Date.now()` drifts
//     by up to 992 ms against a 1500 ms tolerance and silently disables
//     self-identification under load, after which the second turn on a thread
//     refuses forever and reads as a detector bug. That is why `onSpawn` returns
//     a boolean: if COS cannot record the child it cannot recognise it, so the
//     adapter must abort BEFORE any prompt byte rather than deliver a turn COS
//     will mistake for someone else's next time.
//
//  3. UNKNOWN DELIVERY IS NOT FAILED DELIVERY. An adapter result this build does
//     not recognise, or a throw, means the prompt MAY have landed in the real
//     thread. It is reported as `deliveryState: 'unknown'` with `retryable:
//     false`, and it FENCES the target so no later turn or re-attach can deliver
//     a second copy (plan 4.6). Only an explicit `{ status: 'aborted' }` — which
//     plan 4.6 item 4 restricts to "the provider demonstrably never opened the
//     session" — is allowed to mean nothing happened.
//
//  4. THE TWO INJECTED MODULES ARE OPTIONAL AND THEIR ABSENCE IS A REFUSAL.
//     `native-head.ts` and `attached-provider-adapter.ts` are being written in
//     parallel, so this router declares the shape it needs and takes it through
//     `deps`. Every new dependency is OPTIONAL in the type — index.ts constructs
//     this router today and must keep compiling — and every route checks for it
//     at request time and answers 503 with a named reason when it is missing.
//     Optional in the type is not optional in behavior.
//
// BODY PARSING IS INHERITED, LIKE AUTH. index.ts installs
// `express.json({ limit: '10mb' })` at :262, before this router at :296, and no
// router in this repo mounts its own parser. So `req.body` arrives parsed. If it
// does not — a future remount above the parser — the POST routes see a non-object
// and answer 400. They never treat an unparsed body as an empty one.

import type { FenceRecord } from '../lib/thread-fence-store.js'
import { execFileSync } from 'node:child_process'
import { fenceLiveness, makePidStartProbe, type FenceLiveness, type FenceLivenessDeps } from '../lib/fence-liveness.js'
import { Router, type Request, type Response } from 'express'
import { createHash, randomUUID } from 'node:crypto'
import {
  threadOccupancy,
  type Occupancy,
  type OccupancyDirs,
  type OccupancyProbes,
  type OccupancyReason,
} from '../lib/thread-occupancy.js'
import {
  BINDING_ID_RE,
  assertUsable,
  boundToMarker,
  isBindableProvider,
  isForkableProvider,
  isExpired,
  isPinned,
  isTerminal,
  targetKey,
  type BindableProvider,
  type ForkableProvider,
  type BindingState,
  type NativeBinding,
} from '../lib/agent-session-binding-store.js'
import type { RegistryCheck, RegistryRejection, RegistryResult } from '../lib/agent-session-binding-registry.js'
import { recordCosSpawn, releaseCosSpawn } from '../lib/agent-session-ownership-store.js'
import { isValidNativeThreadId } from '../lib/native-thread-id.js'

/**
 * Read side of the binding lease store.
 *
 * `list` MUST THROW on a read failure. Returning `[]` would make "I could not
 * read the registry" byte-identical to "nothing is bound", which is the exact
 * absence-inference this feature keeps re-learning. The route turns a throw into
 * an explicit unavailable response so an empty list always means proved-empty.
 */
export interface BindingRegistry {
  /** Every binding the server knows, terminal ones included. Filtering is this route's job. */
  list: () => readonly NativeBinding[]
  /**
   * Idempotency. Optional so a caller can wire a registry without them, but a
   * turns route built on such a registry cannot make a repeated POST safe - the
   * route requires a client key and simply records nothing if these are absent.
   */
  findTurn?: (bindingId: string, turnId: string) => { result: unknown } | null
  recordTurn?: (bindingId: string, turnId: string, result: unknown, now: number) => unknown
  /**
   * Is the durable store behind `list` usable at all?
   *
   * REQUIRED, not optional, and this is the reason: `AgentSessionBindingRegistry`
   * (lib/agent-session-binding-registry.ts:578) returns `[]` from `list()` when it
   * hydrated `degraded`. Forwarding that as a 200 with an empty array would tell an
   * operator "nothing is bound" when the truth is "the store could not be read" —
   * the same absence-inference this whole feature keeps re-learning, relocated to
   * the wiring seam where no amount of care inside the route can catch it. Making
   * it a required member means a router cannot be constructed without an answer.
   * Wire it as `() => registry.hydration.status !== 'degraded'`.
   */
  available: () => boolean

  // -------------------------------------------------------------- write side
  //
  // OPTIONAL IN THE TYPE, REQUIRED IN BEHAVIOR. `AgentSessionBindingRegistry`
  // implements every one of these, so the production wiring at index.ts:296
  // satisfies them by passing the registry itself and needs no edit. They are
  // optional so that a read-only registry — which is what the GET routes were
  // built against — still constructs, and so a build that forgets one gets a
  // named 503 from the write routes instead of a TypeError at request time.

  /**
   * Attach.
   *
   * `AgentSessionBindingRegistry.create` is the ONLY sanctioned way to mint a
   * binding, and the reason is the epoch. It reads `priorEpoch` from the durable
   * per-target high-water ledger itself and returns `caller_supplied_epoch` if a
   * caller tries to pass one. Reading the epoch from a CURRENT in-memory binding
   * — the obvious-looking alternative — reopens the replay window the epoch
   * exists to close: after detach and eviction the next attach would restart at
   * 1, and a prompt queued against the first attach would match it.
   */
  create?: (input: {
    bindingId: string
    cosSessionId: string
    provider: string
    nativeThreadId: string
    workspaceFingerprint: string
    sourceFingerprint: string
    nativeHeadAtAttach?: string | null
    ttlMs: number
    now: number
  }) => RegistryResult
  activate?: (bindingId: string, now: number) => RegistryResult
  /** Frees a target whose attach failed halfway. Never used on a live binding. */
  forceDetach?: (bindingId: string, now: number) => RegistryResult
  get?: (bindingId: string) => NativeBinding | null
  /** The durable epoch/state gate for a client-queued prompt. */
  checkQueuedPrompt?: (
    claim: { bindingId: string; epoch: number; targetKey: string },
    now: number,
  ) => RegistryCheck
  /** A rejection here is FATAL to the turn, per the registry's own caller contract. */
  pin?: (bindingId: string, jobId: string, now: number) => RegistryResult
  unpin?: (bindingId: string, jobId: string, now: number) => RegistryResult
}

/** What attach resolves server-side because plan 4.2 forbids the client sending it. */
export interface TargetResolution {
  workspaceFingerprint: string
  sourceFingerprint: string
}

/**
 * The request handed to the attached provider adapter.
 *
 * Declared here rather than imported because `server/lib/attached-provider-adapter.ts`
 * is being written in parallel. This is the contract the route requires; the
 * wiring may shim a differently-shaped adapter onto it.
 */
export interface AttachedTurnRequest {
  turnId: string
  bindingId: string
  epoch: number
  provider: BindableProvider
  /** Exact private native id. The adapter resumes THIS and nothing prefix-matched. */
  nativeThreadId: string
  workspaceFingerprint: string
  sourceFingerprint: string
  /**
   * The RAW provider revision token read immediately before this call, for an
   * adapter that can re-assert it at the provider. It never reaches the wire:
   * everything this router returns is a digest of it.
   */
  expectedNativeHead: string
  /** Never logged, never persisted by this router, never echoed in a response. */
  prompt: string
  /**
   * Called with the child pid the instant the process exists and BEFORE any
   * prompt byte is written or any `turn/start` is sent.
   *
   * Returns true when COS recorded the spawn and the adapter may proceed. Returns
   * FALSE when COS could not establish the child's process start and therefore
   * cannot recognise it as its own later; the adapter MUST then kill the child
   * and return `{ status: 'aborted' }` without delivering. Delivering anyway
   * produces a turn that COS will read as a live foreign owner on the next check.
   *
   * An adapter that does not spawn a process (a socket-based `thread/resume`)
   * simply never calls it.
   */
  onSpawn: (pid: number) => boolean
}

/**
 * What the adapter may claim.
 *
 * `aborted` is the ONLY value that means "nothing was delivered", and plan 4.6
 * item 4 restricts it to the cases where the provider demonstrably never opened
 * the session: spawn ENOENT, a non-zero exit before any transport handshake, an
 * app-server rejecting `thread/resume`. Everything else — including a throw, a
 * missing status and a status this build does not know — is AMBIGUOUS, because
 * "I did not see the delivery" is not "the delivery did not happen".
 */
export type AttachedTurnResult =
  | { status: 'completed'; nativeRevisionAfter?: string | null }
  | { status: 'aborted'; reason?: string }
  /**
   * The shape `server/lib/attached-provider-adapter.ts` actually returns.
   *
   * Recognised STRUCTURALLY rather than by importing that module, so this router
   * stays standalone and a change over there cannot break this build — it can
   * only stop matching, which lands in the ambiguous default. The mapping mirrors
   * that module's own `attachedDeliveryAmbiguous`: only `not_attempted` and
   * `aborted` are proof that nothing was sent.
   */
  | { ok: boolean; delivery: 'not_attempted' | 'aborted' | 'ambiguous' | 'delivered' }

export interface AgentSessionBindingsDeps {
  /** Shared fence state. Omit and the router owns a private one, which is correct
   *  for tests and wrong for the server -- see the wiring note at its use site. */
  guard?: TargetGuard
  /** Process-start probe behind the fence liveness aggregate. */
  liveness?: FenceLivenessDeps
  /**
   * Durable fence storage. OPTIONAL, and omitting it is what keeps the existing
   * suite in memory: a test that silently began writing the real data home would
   * leak fences between cases and into the running server. Production wires it.
   */
  fencePersistence?: FencePersistence
  probes: OccupancyProbes
  dirs: OccupancyDirs
  /** Epoch ms. Injected so lease expiry is decidable in a test without waiting. */
  now: () => number
  bindings: BindingRegistry
  /**
   * The occupancy detector. Defaults to the real one and should stay that way in
   * production: the seam exists so a test can hand back a SELF-CONTRADICTORY
   * verdict and prove this route still refuses it. Without the seam that guard
   * would be unreachable, and an unreachable guard is an untested guard.
   */
  occupancy?: (
    provider: string,
    threadId: string,
    probes: OccupancyProbes,
    dirs: OccupancyDirs,
  ) => Occupancy

  // -------------------------------------------------------------- write side

  /**
   * The execution fields plan 4.2 forbids the client from sending.
   *
   * Synchronous on purpose. Attach has no target claim held while it runs, so an
   * await here would widen the window between the occupancy verdict and
   * `create()` for nothing; the registry is the arbiter of a concurrent attach
   * either way. Null means "could not resolve", which is a refusal.
   */
  resolveTarget?: (provider: BindableProvider, nativeThreadId: string) => TargetResolution | null

  /**
   * Bounded opaque revision token for the native thread, from
   * `server/lib/native-head.ts`.
   *
   * Wire it as `(p, id) => nativeHead(p, id, realNativeHeadDeps())` so this
   * router never has to know that module's dependency shape. Null means "could
   * not determine", which is a refusal at BOTH attach and turn: with no baseline
   * there is no divergence check, and plan 4.3 is the only thing making a desktop
   * edit visible.
   *
   * The token never reaches the wire. Everything this router returns is
   * `opaqueRevision()` of it, so a token that turns out to be path-shaped or
   * content-bearing cannot leak through this surface.
   */
  nativeHead?: (provider: BindableProvider, threadId: string) => Promise<string | null> | string | null

  /** `deliverAttachedTurn` from `server/lib/attached-provider-adapter.ts`. */
  deliverAttachedTurn?: (request: AttachedTurnRequest) => Promise<unknown> | unknown

  /**
   * The self-recursion ledger. Defaults to the real process-wide one.
   *
   * `record` takes a MEASURED process start, never a wall clock. See rule 2 in
   * the header.
   */
  /** Overrides the env gate. Tests only; production reads threadAttachEnabled(). */
  attachEnabled?: boolean

  ownership?: {
    record: (pid: number, startMs: number) => string
    release: (pid: number) => boolean
  }

  // --------------------------------------------------------------- fork side

  /**
   * `forkThread` from `server/lib/fork-thread.ts`.
   *
   * Wire it as `req => forkThread({ ...req, deps: realForkDeps(watermark) })`.
   * Unwired means the fork route refuses; it never falls back to the attached
   * adapter, which would append to the very thread fork exists to leave alone.
   */
  forkThread?: (request: ForkRouteRequest) => Promise<unknown> | unknown

  /**
   * Absolute directory the forked provider run happens in, or null.
   *
   * SEPARATE from `resolveTarget` on purpose: that one deliberately returns only
   * fingerprints, because plan 3.3 keeps a filesystem path off anything
   * client-visible, and a fork needs a real path to spawn in. Wire it as
   * `(p, id) => resolveAttachedWorkspace(p, id, deps)?.path ?? null`. Null is a
   * refusal — `attached-workspace.ts` records that a wrong cwd makes the provider
   * write a NEW session rather than the one asked for, which for a fork means the
   * copy silently lands in the wrong project.
   */
  resolveForkWorkspace?: (provider: BindableProvider, nativeThreadId: string) => string | null

  /**
   * Where an opaque fork reference is exchanged for the thread it names.
   *
   * Defaults to a per-router instance. Injectable so the follow-on work — teaching
   * attach to accept a `forkRef` instead of a native id in the path — can share
   * one store between the two routes rather than inventing a second.
   */
  forkRefs?: ForkRefStore

  /** Lease TTL for a new binding. */
  attachTtlMs?: number
  /** Upper bound on one prompt. A prompt is not a payload. */
  maxPromptChars?: number
  /** Injected so a test can pin the minted ids. Must return an id matching BINDING_ID_RE. */
  newId?: () => string
}

/**
 * Human-facing footer copy, one line per reason.
 *
 * `Record<OccupancyReason, string>` is the enforcement: adding a member to the
 * union without adding copy here is a compile error, so a new reason cannot ship
 * as a blank footer. The test then drives every one of these through the real
 * route, so a reason that exists in the map but is unreachable also fails.
 *
 * Plan 4.3 fixes the wording of the case that matters: a thread open on the
 * desktop must read as a deliberate safety behavior, not a malfunction, and must
 * offer Fork. No slashes in any string here, so the redaction assertion can be a
 * flat "the body contains no path separator".
 */
export const REASON_COPY: Record<OccupancyReason, string> = {
  // Not a fault and not a busy thread - the write feature is off. The copy says so
  // plainly rather than implying something is wrong, because Fork-only is a
  // supported permanent configuration, not a degraded one (plan 4.9).
  attach_disabled:
    'Continuing a thread on your Mac is turned off. COS is read-only here. Fork it instead.',
  // Held open by another app AND COS has no clock on the thread, so it cannot
  // tell working from idle. Since 6.32.0 an idle holder is continuable, which
  // makes this the "could not measure" case rather than the "someone else is
  // here" case, and the copy says which.
  live_desktop_process:
    'Open on your Mac, and COS cannot tell whether it is still working. It will not write into it. Fork it instead.',
  // Measured, and the answer was yes. Deliberately a different instruction from
  // the line above: this clears on its own within seconds, so the useful advice
  // is to wait, with fork as the fallback rather than the recommendation.
  native_thread_working:
    'Your Mac is writing to this thread right now. Wait a few seconds and try again, or fork it.',
  unsupported_provider:
    'This assistant cannot be continued from COS yet. Fork it instead.',
  invalid_thread_id:
    'That thread reference is not a valid id. Fork it instead.',
  detector_unavailable:
    'COS cannot check for a live owner on this Mac, so it will not continue this thread. Fork it instead.',
  registry_unreadable:
    'COS could not read the session records for this thread, so it will not continue it. Fork it instead.',
  unverifiable_process_start:
    'COS could not confirm which process holds this thread, so it will not continue it. Fork it instead.',
  unverifiable_liveness_socket:
    'COS could not confirm the owning app is still live, so it will not continue this thread. Fork it instead.',
  probe_failed:
    'The live owner check failed, so COS will not continue this thread. Fork it instead.',
}

export const ATTACHABLE_COPY = 'Ready to continue in the original thread.'

/**
 * Copy for a reason string this build does not recognise.
 *
 * Reachable only if the detector returns a value outside its own union, i.e. a
 * bug. The safe rendering of a bug is a refusal with words, never an empty
 * footer and never a silent attach.
 */
export const UNKNOWN_REASON_COPY = 'COS could not establish whether this thread is free. Fork it instead.'

export function reasonCopy(reason: OccupancyReason | null): string {
  if (reason === null) return ATTACHABLE_COPY
  const copy = Object.prototype.hasOwnProperty.call(REASON_COPY, reason) ? REASON_COPY[reason] : undefined
  return typeof copy === 'string' && copy.length > 0 ? copy : UNKNOWN_REASON_COPY
}

/**
 * Every way a write can be refused.
 *
 * Supersets `OccupancyReason` so the attach refusal for a live desktop owner is
 * literally the same value and the same footer line the attachability probe
 * already returns — a lens that renders one renders the other.
 */
export type WriteRefusal =
  | OccupancyReason
  | 'invalid_request'
  | 'binding_registry_unwired'
  | 'binding_registry_degraded'
  | 'binding_registry_unavailable'
  | 'target_unresolvable'
  | 'native_head_unavailable'
  | 'native_thread_changed'
  | 'native_target_busy'
  | 'native_turn_in_progress'
  | 'native_target_fenced'
  | 'attach_failed'
  | 'unknown_binding'
  | 'binding_not_active'
  | 'binding_detached'
  | 'binding_expired'
  | 'stale_epoch'
  | 'target_mismatch'
  | 'binding_unusable'
  | 'pin_failed'
  | 'adapter_unwired'
  | 'provider_never_opened'
  | 'delivery_ambiguous'
  | 'turn_failed'
  // ------------------------------------------------------------------- fork
  //
  // Fork gets its OWN members rather than reusing the ones above, and the reason
  // is entirely in the copy. Every continuation refusal ends with the words "Fork
  // it instead", because fork is the fallback. Reusing one of them on the fork
  // route tells a user whose fork just failed to go and fork it — which reads as
  // a bug, and leaves them with no next step at all. So `unsupported_provider`
  // and `fork_unsupported_provider` are the same condition with different
  // endings, deliberately, and neither route may borrow the other's.
  | 'fork_unwired'
  | 'fork_unsupported_provider'
  | 'fork_invalid_thread_id'
  | 'fork_workspace_unresolvable'
  | 'fork_in_progress'
  | 'fork_failed'
  | 'fork_source_mutated'
  | 'fork_orphan_possible'

/**
 * Footer copy for the refusals that are not occupancy reasons.
 *
 * Same enforcement as `REASON_COPY`: `Record<…, string>` means a new member of
 * the union cannot ship without copy, and the suite drives every key through a
 * real route so a member that has copy but is unreachable fails too. No slashes
 * in any string, which keeps the "nothing this router returns is path-shaped"
 * assertion a flat substring check.
 */
export const WRITE_REASON_COPY: Record<Exclude<WriteRefusal, OccupancyReason>, string> = {
  invalid_request:
    'That request was not something COS could read. Nothing was sent.',
  binding_registry_unwired:
    'This build cannot record a continuation, so it will not start one. Fork it instead.',
  binding_registry_degraded:
    'COS could not read its own continuation records, so it will not continue this thread. Fork it instead.',
  binding_registry_unavailable:
    'COS could not read its own continuation records, so it will not continue this thread. Fork it instead.',
  target_unresolvable:
    'COS could not work out where this thread lives, so it will not continue it. Fork it instead.',
  native_head_unavailable:
    'COS could not read where this thread currently ends, so it will not write to it. Fork it instead.',
  native_thread_changed:
    'This thread changed on your Mac since you attached. Refresh, continue anyway, or fork.',
  native_target_busy:
    'This thread is already attached to another COS chat. Detach that one first.',
  native_turn_in_progress:
    'A COS turn is already running on this thread. Wait for it to finish.',
  native_target_fenced:
    'An earlier turn on this thread may or may not have been delivered. Open the thread on your Mac and check before sending again.',
  attach_failed:
    'COS could not record a continuation for this thread. Fork it instead.',
  unknown_binding:
    'That continuation is no longer on record. Attach again.',
  binding_not_active:
    'That continuation is not live yet. Attach again.',
  binding_detached:
    'That continuation was detached. Attach again.',
  binding_expired:
    'That continuation timed out. Attach again.',
  stale_epoch:
    'This prompt was written against an earlier attach of the same thread. It was not sent. Attach again.',
  target_mismatch:
    'This prompt names a different thread than the continuation it claims. It was not sent.',
  binding_unusable:
    'That continuation cannot run work. Attach again.',
  pin_failed:
    'COS could not hold the continuation open for this turn, so it did not send it.',
  adapter_unwired:
    'This build cannot drive the original thread yet. Fork it instead.',
  provider_never_opened:
    'The assistant never opened the thread, so nothing was sent. You can try again.',
  delivery_ambiguous:
    'COS lost track of this turn after sending it. Open the thread on your Mac and check before sending again.',
  turn_failed:
    'COS could not run this turn. Nothing was sent. You can try again.',

  // Fork copy. No sentence here may end with "Fork it instead" — this IS the fork,
  // and pointing a failed fork back at itself is a dead end rather than an action.
  fork_unwired:
    'This build cannot copy a thread into a new one. Open it on your Mac instead.',
  fork_unsupported_provider:
    'This assistant cannot be copied into a new thread from COS yet.',
  fork_invalid_thread_id:
    'That thread reference is not a valid id, so there is nothing to copy.',
  fork_workspace_unresolvable:
    'COS could not work out where this thread lives, so it will not copy it. Open it on your Mac instead.',
  fork_in_progress:
    'A copy of this thread is already being made. Wait for it to finish.',
  fork_failed:
    'COS could not copy this thread. Your original is untouched. You can try again.',
  // The one outcome this whole feature exists to prevent, reported plainly. No
  // retry offered: the user needs to look at the original before anything else
  // touches it.
  fork_source_mutated:
    'The original thread changed while COS was copying it. Open the original on your Mac and check it before doing anything else.',
  fork_orphan_possible:
    'COS lost track of the copy it was making. Your original is untouched, but a partial copy may exist on your Mac.',
}

export function writeReasonCopy(reason: WriteRefusal): string {
  if (Object.prototype.hasOwnProperty.call(REASON_COPY, reason)) {
    return REASON_COPY[reason as OccupancyReason]
  }
  const copy = Object.prototype.hasOwnProperty.call(WRITE_REASON_COPY, reason)
    ? WRITE_REASON_COPY[reason as Exclude<WriteRefusal, OccupancyReason>]
    : undefined
  return typeof copy === 'string' && copy.length > 0 ? copy : UNKNOWN_REASON_COPY
}

/**
 * Refusals that mean "this build or this machine cannot do it", answered 503.
 *
 * Everything else that is not a malformed request is 409: a conflict with the
 * state of the world, which the user can act on. The split lives in one table so
 * the two routes cannot drift, and so a new refusal defaults to 409 — the
 * conservative choice, since a client is far more likely to auto-retry a 503.
 */
const CAPABILITY_REFUSALS: ReadonlySet<WriteRefusal> = new Set<WriteRefusal>([
  'detector_unavailable',
  'binding_registry_unwired',
  'binding_registry_degraded',
  'binding_registry_unavailable',
  'adapter_unwired',
  'fork_unwired',
])

export function refusalStatus(reason: WriteRefusal): number {
  if (reason === 'invalid_request') return 400
  return CAPABILITY_REFUSALS.has(reason) ? 503 : 409
}

/**
 * Map anything the binding registry can say onto a refusal with copy.
 *
 * `Record<RegistryRejection, WriteRefusal>` is the point: the registry owns that
 * union and can grow it, and this must not compile if it does. Several members
 * are unreachable through these two routes (`invalid_ttl` needs a bad TTL, which
 * this router supplies itself) and collapse onto a generic refusal rather than
 * inventing copy nobody can ever see.
 */
export const REGISTRY_REJECTION_REFUSAL: Record<RegistryRejection, WriteRefusal> = {
  // Value-type rejections.
  invalid_thread_id: 'invalid_thread_id',
  invalid_provider: 'unsupported_provider',
  invalid_binding_id: 'unknown_binding',
  invalid_epoch: 'invalid_request',
  invalid_ttl: 'attach_failed',
  unknown_binding: 'unknown_binding',
  binding_not_active: 'binding_not_active',
  binding_detached: 'binding_detached',
  binding_expired: 'binding_expired',
  stale_epoch: 'stale_epoch',
  target_mismatch: 'target_mismatch',
  missing_target_key: 'invalid_request',
  binding_pinned: 'binding_unusable',
  terminal_state: 'binding_unusable',
  // Registry-level rejections.
  store_unavailable: 'binding_registry_degraded',
  persist_failed: 'attach_failed',
  reentrant_mutation: 'attach_failed',
  target_busy: 'native_target_busy',
  binding_id_in_use: 'attach_failed',
  invalid_job_id: 'pin_failed',
  too_many_pins: 'pin_failed',
  registry_full: 'attach_failed',
  epoch_ledger_full: 'attach_failed',
  caller_supplied_epoch: 'attach_failed',
}

export function registryRefusal(reason: RegistryRejection | null | undefined): WriteRefusal {
  if (typeof reason !== 'string') return 'attach_failed'
  return Object.prototype.hasOwnProperty.call(REGISTRY_REJECTION_REFUSAL, reason)
    ? REGISTRY_REJECTION_REFUSAL[reason]
    : 'attach_failed'
}

/**
 * Bounded, deterministic, non-identifying stand-in for a provider revision token
 * or a `boundTo` marker.
 *
 * WHY NOT THE RAW VALUES. `boundToMarker` is length-prefixed over
 * bindingId + epoch + targetKey, and targetKey embeds the exact private native
 * thread id — so returning the raw marker would put the native id on the wire
 * through the one route whose entire redaction contract says it never does. The
 * revision token comes from a module this one does not own, and plan 4.3 only
 * ASKS that it carry no content or path; asking is not enforcing. A digest makes
 * both true by construction, stays comparable across requests, and the client can
 * hand it back for the Continue Anyway acknowledgement.
 *
 * NOT A CAPABILITY TOKEN. It is a digest of values the attaching client already
 * holds, so it proves recognisability, not authority. Authorization is
 * `requireApiToken` at the app level, exactly as for every other route here.
 */
export function opaqueRevision(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/** Shape of an opaque value coming back from a client. 128 bits of hex, nothing else. */
export const OPAQUE_RE = /^[0-9a-f]{32}$/

export interface AttachabilityBody {
  attachable: boolean
  reason: OccupancyReason | null
  reasonCopy: string
  ownerCount: number
}

/**
 * Project a verdict to the wire, re-checking its internal consistency.
 *
 * The detector is trusted to be correct; it is not trusted to STAY correct. Three
 * shapes are contradictions rather than verdicts, and each one resolves the
 * permissive way if simply forwarded: attachable with a reason, attachable with an
 * owner that is not provably ours, and a non-array owners field. Any of them is a
 * defect upstream, and a defect must not resolve to permissive.
 *
 * THE ONE EXEMPTION, added with the idle-holder relaxation in 6.32.0: a foreign
 * owner is allowed on an attachable verdict when the verdict itself carries
 * `idleHolder === true`. The check is not weakened by this, it is made explicit —
 * before, "attachable" and "no foreign owner" were the same claim, so a detector
 * that flipped `attachable` by mistake was caught here. It still is. What can no
 * longer be caught here is a detector that ALSO sets `idleHolder`, which takes a
 * deliberate edit in `thread-occupancy.ts` rather than an accident, and which the
 * mutation tests over that file cover.
 */
export function projectAttachability(verdict: Occupancy): AttachabilityBody {
  const owners = Array.isArray(verdict?.owners) ? verdict.owners : null
  // Strictly `=== true`. An idleHolder of 1, 'yes', or {} is a malformed verdict,
  // and a malformed verdict must not buy an exemption.
  const foreignOwnerDeclared = verdict?.idleHolder === true
  const sound =
    verdict?.attachable === true &&
    verdict.reason === null &&
    owners !== null &&
    owners.every(owner => owner?.selfOwned === true || foreignOwnerDeclared)
  const reason: OccupancyReason | null = sound ? null : ((verdict?.reason ?? 'probe_failed') as OccupancyReason)
  return {
    attachable: sound,
    reason,
    reasonCopy: reasonCopy(sound ? null : reason),
    // Total owners, self-owned included. Reporting only foreign owners would make
    // the count read lower than reality, and this number exists so a client can
    // never be MORE confident than the server. Attachability is `attachable`,
    // never an inference from this field being zero.
    ownerCount: owners === null ? 0 : owners.length,
  }
}

/** Compile-time exhaustive membership test for a binding state. */
const BINDING_STATES: Record<BindingState, true> = {
  staging: true,
  active: true,
  detaching: true,
  detached: true,
}

function isBindingState(value: unknown): value is BindingState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BINDING_STATES, value)
}

/**
 * Is this registry row trustworthy enough to describe on the wire?
 *
 * Validated with the SHARED id validator, never a local copy: native-thread-id.ts
 * exists because two modules written in the same session disagreed about what an
 * id is, and a truncated id then sailed through occupancy as attachable.
 */
export function isUsableBindingRow(value: unknown): value is NativeBinding {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<NativeBinding>
  if (typeof row.bindingId !== 'string' || !BINDING_ID_RE.test(row.bindingId)) return false
  if (!isBindableProvider(row.provider)) return false
  if (!isValidNativeThreadId(row.nativeThreadId)) return false
  if (!isBindingState(row.state)) return false
  if (!Number.isInteger(row.epoch) || (row.epoch as number) < 1) return false
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)) return false
  if (!Array.isArray(row.pinnedJobs)) return false
  return true
}

export interface BindingSummary {
  bindingId: string
  provider: string
  state: BindingState
  epoch: number
  expiresAt: number
  pinned: boolean
  expired: boolean
}

/**
 * Redacted binding row.
 *
 * Dropped on purpose, each because it is either identifying or forgeable:
 * `nativeThreadId` (the private native id), `targetKey` (the mutex key plan 3.3
 * names explicitly), `cosSessionId` (client-supplied, and SAFE_ID_RE permits '/'
 * inside it), both fingerprints (nothing constrains them to be hashes rather than
 * raw paths), `nativeHeadAtAttach` (an opaque revision nobody needs in a list) and
 * `pinnedJobs` (ids, where a boolean answers the only question a list view asks).
 */
export function projectBinding(binding: NativeBinding, now: number): BindingSummary {
  return {
    bindingId: binding.bindingId,
    provider: binding.provider,
    state: binding.state,
    epoch: binding.epoch,
    expiresAt: binding.expiresAt,
    pinned: isPinned(binding),
    expired: isExpired(binding, now),
  }
}

function occupancyDepsUsable(deps: AgentSessionBindingsDeps): boolean {
  const probes = deps?.probes
  const dirs = deps?.dirs
  return (
    !!probes &&
    typeof probes.dirExists === 'function' &&
    typeof probes.readDir === 'function' &&
    typeof probes.readFile === 'function' &&
    typeof probes.isAlive === 'function' &&
    typeof probes.processStartMs === 'function' &&
    typeof probes.fileExists === 'function' &&
    typeof probes.lockHolders === 'function' &&
    typeof probes.cosSpawnedPids === 'function' &&
    typeof probes.cursorAgentSession === 'function' &&
    !!dirs &&
    typeof dirs.claudeSessionsDir === 'string' &&
    typeof dirs.codexLocksDir === 'string' &&
    typeof dirs.cursorChatsDir === 'string'
  )
}

function bindingDepsUsable(deps: AgentSessionBindingsDeps): boolean {
  return (
    !!deps?.bindings &&
    typeof deps.bindings.list === 'function' &&
    typeof deps.bindings.available === 'function' &&
    typeof deps?.now === 'function'
  )
}

/** Can this build mint and drive a binding at all, or only describe one? */
function bindingWriteDepsUsable(deps: AgentSessionBindingsDeps): boolean {
  const b = deps?.bindings
  return (
    bindingDepsUsable(deps) &&
    typeof b?.create === 'function' &&
    typeof b?.activate === 'function' &&
    typeof b?.forceDetach === 'function' &&
    typeof b?.get === 'function' &&
    typeof b?.checkQueuedPrompt === 'function' &&
    typeof b?.pin === 'function' &&
    typeof b?.unpin === 'function'
  )
}

export const DEFAULT_ATTACH_TTL_MS = 30 * 60_000
export const DEFAULT_MAX_PROMPT_CHARS = 32_000
/** Bindings whose advanced head is remembered. See `acknowledgeHead`. */
export const MAX_TRACKED_HEADS = 512

/** A COS session id may contain ':' and '/', which is exactly why it is never projected. */
export const COS_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/

/** What a fence records about the turn that set it. */
export interface FenceEvidence {
  provider: string
  /** The adapter's verdict, or 'route_error' at the catch site. DISK-ONLY. */
  adapterReason?: string
  /** WHICH site fenced. `adapterReason` cannot substitute: the catch site inherits
   *  whatever the adapter reported, so a fence can read 'ok' there. DISK-ONLY. */
  fenceSite?: 'ambiguous' | 'route_error'
  adapterDetail?: string | null
  exitCode?: number | null
  childReaped?: boolean
  stderrClass?: string
  durationMs?: number
  spawns?: Array<{ pid: number; startMs: number }>
  /** The head BEFORE the ambiguous turn. Null ONLY when the failure happened
   *  before the head was read. */
  headBefore: string | null
  turnId: string
  bindingId: string | null
  now: number
}

export type ReleaseOutcome =
  | { ok: true; row: FenceRecord }
  | { ok: false; reason: 'unknown_fence' | 'persist_failed' }

/** Injected so TargetGuard stays testable in memory; production wires the store. */
export interface FencePersistence {
  load: () => FenceRecord[]
  save: (rows: FenceRecord[]) => void
}

/**
 * One COS turn per native target, and a target that may already hold an
 * undelivered turn stays shut.
 *
 * CLAIMS ARE PROCESS-LOCAL; FENCES ARE DURABLE (6.36.10). The two states fail in
 * opposite directions, which is why only one of them is persisted. Losing a claim
 * on restart is safe — no turn is running after a restart anyway. Losing a FENCE
 * reopens a thread that may already hold an undelivered turn, and the binding
 * registry records what that cost: "the process-local fence re-opened on restart
 * and delivered a second copy." So fences are written through to disk and
 * rehydrated in the constructor, and the ONLY way one leaves the map is an
 * explicit operator release (`releaseFence`).
 *
 * Persistence is INJECTED rather than imported. A test that silently began writing
 * the real data home would leak fences between cases and into the running server,
 * so the suite runs with `null` and stays in memory.
 */
/** The fence question, narrowed for callers that must not touch anything else.
 *  `occupancy` in index.ts reads this so a fenced target holds instead of burning
 *  a delivery attempt; the ATTACH route remains the authority that refuses. */
export interface TargetFenceView {
  fencedReason(targetKey: string): WriteRefusal | null
}

export class TargetGuard {
  /** targetKey -> turnId of the single COS turn allowed to be in flight. */
  private readonly claims = new Map<string, string>()
  /** targetKey -> the fence record. DURABLE as of 6.36.10: persistence is injected
   *  so tests stay in memory and only production touches the data home. */
  private readonly fences = new Map<string, FenceRecord>()
  private readonly persistence: FencePersistence | null
  private persistDegraded = false

  constructor(persistence: FencePersistence | null = null) {
    this.persistence = persistence
    if (persistence === null) return
    // Rehydrate BEFORE the router serves. A fence that died on restart is exactly
    // how a second copy of a turn reached a real transcript.
    try {
      for (const row of persistence.load()) this.fences.set(row.targetKey, row)
    } catch (error) {
      console.error(`[agent-session-bindings] fence rehydrate failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  /** True when the durable write succeeded (or there is nothing to persist to). */
  private persistFences(rows: FenceRecord[]): boolean {
    if (this.persistence === null) return true
    try {
      this.persistence.save(rows)
      this.persistDegraded = false
      return true
    } catch (error) {
      // The in-memory fence still holds for this process, so the thread stays shut
      // NOW; what is lost is survival across a restart. Loud, and surfaced on
      // GET /fences — a silent fallback is indistinguishable from working.
      this.persistDegraded = true
      console.error(`[agent-session-bindings] fence persist FAILED (fences hold in memory only): ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  /** Whether the last durable write failed. Reported, never inferred. */
  degraded(): boolean {
    return this.persistDegraded
  }
  /** bindingId -> the head digest this binding is currently reconciled to. */
  private readonly heads = new Map<string, string>()

  /**
   * Check and set in ONE synchronous step.
   *
   * Plan 4.5 requirement 1 is a "synchronous, non-blocking target reservation
   * check" that returns immediately, and the atomicity is load-bearing: with an
   * await between the read and the write, two turns admitted in the same tick
   * both see a free target. Every caller must reach this before its first await.
   */
  tryClaim(targetKey: string, turnId: string): boolean {
    if (this.claims.has(targetKey)) return false
    this.claims.set(targetKey, turnId)
    return true
  }

  /** Only the holder may release, so a late unwind cannot free someone else's claim. */
  release(targetKey: string, turnId: string): void {
    if (this.claims.get(targetKey) === turnId) this.claims.delete(targetKey)
  }

  /**
   * Write-once: the FIRST reason wins, so a later ambiguity cannot overwrite the
   * evidence chain of an unresolved one.
   *
   * DEFENSIVE, AND UNVERIFIED BY EXECUTION. Both fence sites sit inside the
   * `tryClaim` section, which serialises them per target, and a fenced target is
   * refused at the check before it can reach either site again — so no route can
   * currently fence the same key twice, and a mutation removing this guard passes
   * the whole suite. It is kept because the one path that could reach it (the
   * ambiguous site fences, then the response throws into the catch, which fences
   * `claimedKey` again) would otherwise replace a record carrying `bindingId` with
   * one carrying null. Do not read the passing suite as coverage of this line.
   */
  fence(targetKey: string, reason: WriteRefusal, evidence: FenceEvidence): void {
    if (this.fences.has(targetKey)) return
    this.fences.set(targetKey, {
      targetKey,
      provider: evidence.provider,
      reason,
      headBefore: evidence.headBefore,
      turnId: evidence.turnId,
      bindingId: evidence.bindingId,
      fencedAt: evidence.now,
      adapterReason: evidence.adapterReason,
      fenceSite: evidence.fenceSite,
      adapterDetail: evidence.adapterDetail,
      exitCode: evidence.exitCode,
      childReaped: evidence.childReaped,
      stderrClass: evidence.stderrClass,
      durationMs: evidence.durationMs,
      spawns: evidence.spawns,
    })
    this.persistFences([...this.fences.values()])
  }

  fencedReason(targetKey: string): WriteRefusal | null {
    const row = this.fences.get(targetKey)
    return row === undefined ? null : (row.reason as WriteRefusal)
  }

  /** Every fence, REDACTED for the wire: the raw targetKey embeds the private
   *  native thread id, so callers address a fence by its deterministic digest.
   *
   *  `liveness` is the ONLY evidence field that crosses, and it crosses as an
   *  aggregate: a state plus counts, never a pid. It answers "is a child from this
   *  turn still writing", which is the one thing about a fence a machine can
   *  actually establish. It is NOT a safety verdict and the UI must not render it
   *  as one -- whether the ambiguous turn landed stays unknowable, which is why two
   *  automatic resolvers were rejected (thread-fence-store.ts:40).
   *
   *  The rest of the evidence block stays disk-only. Widening that is a deliberate
   *  contract change, not a side effect of adding this. */
  listFences(deps: FenceLivenessDeps): Array<{ target: string; provider: string; reason: string; headBefore: string | null; turnId: string; fencedAt: number; liveness: FenceLiveness }> {
    return [...this.fences.values()].map(row => ({
      target: opaqueRevision(row.targetKey),
      provider: row.provider,
      reason: row.reason,
      headBefore: row.headBefore,
      turnId: row.turnId,
      fencedAt: row.fencedAt,
      // REQUIRED, not optional. An optional probe meant a `deps === undefined`
      // branch that the route could never take -- a mutation flipping it to
      // `none_running` left the whole 262-test suite green, which is the
      // definition of an unreached line. A caller with no probe must construct a
      // deliberate one rather than fall into a default answer.
      liveness: fenceLiveness(row.spawns, deps),
    }))
  }

  /**
   * The operator release. THE ONLY WAY A FENCE LEAVES THIS MAP.
   *
   * Addressed by digest, never by raw target key. Returns false when no fence
   * matches, so a stale handle reports honestly instead of silently succeeding.
   */
  releaseFence(targetDigest: string): ReleaseOutcome {
    for (const [key, row] of this.fences) {
      // THE authority on which fence a handle names. The route also looks the row
      // up for its preview, but the release decision is made here — a duplicate
      // lookup upstream would leave this comparison enforced by nothing.
      if (opaqueRevision(row.targetKey) !== targetDigest) continue
      // PERSIST FIRST. Reporting a release that was not durably recorded is how an
      // operator is told a thread is open, writes to it, and finds it fenced again
      // after the next restart with no record of why.
      const remaining = [...this.fences.values()].filter(r => r.targetKey !== key)
      if (!this.persistFences(remaining)) return { ok: false, reason: 'persist_failed' }
      this.fences.delete(key)
      return { ok: true, row }
    }
    return { ok: false, reason: 'unknown_fence' }
  }

  /**
   * The head this binding is reconciled to: the attach baseline, then whatever
   * the user acknowledged or a completed turn produced.
   *
   * Without this the SECOND turn on a binding always fails the divergence check,
   * because the first turn moved the head itself.
   */
  acknowledgedHead(bindingId: string): string | null {
    return this.heads.get(bindingId) ?? null
  }

  acknowledgeHead(bindingId: string, digest: string): void {
    // Re-insert so the eviction order is by last use.
    this.heads.delete(bindingId)
    this.heads.set(bindingId, digest)
    while (this.heads.size > MAX_TRACKED_HEADS) {
      const oldest = this.heads.keys().next()
      if (oldest.done) break
      this.heads.delete(oldest.value)
    }
    // Eviction here is safe in a way eviction almost never is in this feature:
    // losing an advance makes the next turn fall back to the ATTACH baseline, so
    // it sees a changed head and asks the user to acknowledge. Strictly more
    // conservative, never less.
  }
}

type Delivery =
  | { kind: 'completed'; after: string | null }
  | { kind: 'aborted' }
  | { kind: 'ambiguous' }

/**
 * Read an adapter result without believing anything it did not say.
 *
 * The default is ambiguous, and every unrecognised shape lands there: null, an
 * array, a missing status, a status from a newer adapter. Only the two literals
 * this build understands are allowed to mean anything.
 */
export function classifyDelivery(result: unknown): Delivery {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { kind: 'ambiguous' }
  const status = (result as { status?: unknown }).status
  if (status === 'completed') {
    const after = (result as { nativeRevisionAfter?: unknown }).nativeRevisionAfter
    return { kind: 'completed', after: typeof after === 'string' && after.length > 0 ? after : null }
  }
  if (status === 'aborted') return { kind: 'aborted' }

  // The adapter module's shape. Read only when `status` said nothing, so a result
  // carrying both is decided by exactly one rule.
  const { ok, delivery } = result as { ok?: unknown; delivery?: unknown }
  if (typeof ok === 'boolean') {
    // Success is not inferred from `ok` alone: a truthy result whose delivery
    // state is anything but `delivered` is a contradiction, and a contradiction
    // is ambiguous rather than done.
    if (ok === true && delivery === 'delivered') {
      const after = (result as { nativeRevisionAfter?: unknown }).nativeRevisionAfter
      return { kind: 'completed', after: typeof after === 'string' && after.length > 0 ? after : null }
    }
    if (ok === false && (delivery === 'not_attempted' || delivery === 'aborted')) return { kind: 'aborted' }
  }
  return { kind: 'ambiguous' }
}

export function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_RE.test(value)
}

// ------------------------------------------------------------------------ fork

/** What the route hands `forkThread`. The client supplies none of these but the prompt. */
export interface ForkRouteRequest {
  provider: ForkableProvider
  nativeThreadId: string
  prompt: string
  /** Resolved server-side. Plan 4.2: the client never sends a path. */
  cwd: string
  policy: 'read_only'
}

export const FORK_REF_TTL_MS = 30 * 60_000
export const MAX_TRACKED_FORK_REFS = 256

/**
 * Opaque handles for freshly forked threads.
 *
 * The fork route must tell the client WHICH thread it created, and it may not put
 * a native thread id on the wire — the redaction contract at the top of this file
 * is absolute about that, and a fork id is exactly as identifying as any other.
 * So the client gets a digest and the server keeps the mapping.
 *
 * NOT A CAPABILITY TOKEN, for the same reason `opaqueRevision` is not: the digest
 * is derived from values, not from a secret, so holding one proves recognisability
 * and nothing else. Authorization remains `requireApiToken` at the app level.
 *
 * Bounded and TTL'd because it is unbounded client-triggered state otherwise.
 * Eviction is safe in the direction that matters: a lost handle means the client
 * must find the thread on the desktop, never that something binds to the wrong one.
 */
export class ForkRefStore {
  private readonly refs = new Map<string, { provider: BindableProvider; nativeThreadId: string; at: number }>()

  remember(provider: BindableProvider, nativeThreadId: string, now: number): string {
    const ref = opaqueRevision(targetKey(provider, nativeThreadId))
    this.refs.delete(ref)
    this.refs.set(ref, { provider, nativeThreadId, at: now })
    while (this.refs.size > MAX_TRACKED_FORK_REFS) {
      const oldest = this.refs.keys().next()
      if (oldest.done) break
      this.refs.delete(oldest.value)
    }
    return ref
  }

  lookup(ref: unknown, now: number): { provider: BindableProvider; nativeThreadId: string } | null {
    if (!isOpaque(ref)) return null
    const row = this.refs.get(ref)
    if (!row) return null
    if (!Number.isFinite(now) || now - row.at > FORK_REF_TTL_MS) {
      this.refs.delete(ref)
      return null
    }
    return { provider: row.provider, nativeThreadId: row.nativeThreadId }
  }
}

/**
 * What a fork attempt actually achieved.
 *
 *   created         a new thread exists and is named
 *   mutated         the ORIGINAL changed — terminal, and the loudest outcome here
 *   orphan_possible something may have been created that nobody can name
 *   failed          provably nothing was created
 */
export type ForkOutcome =
  | { kind: 'created'; newNativeThreadId: string; integrity: 'verified_unchanged' | 'unverified' }
  | { kind: 'mutated' }
  | { kind: 'orphan_possible' }
  | { kind: 'failed' }

/**
 * Read a fork result without believing anything it did not say.
 *
 * Recognised STRUCTURALLY rather than by importing `fork-thread.ts`, matching how
 * this router already reads the attached adapter: a change over there cannot break
 * this build, it can only stop matching — and the default for "stopped matching"
 * is `orphan_possible`, the cautious side. `failed` is claimed ONLY for a result
 * that positively says no child was ever created, because "I do not recognise this"
 * is not "nothing happened".
 */
export function classifyFork(result: unknown, sourceNativeThreadId: string): ForkOutcome {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { kind: 'orphan_possible' }
  const { ok, newNativeThreadId, sourceIntegrity, forkState, reason } = result as Record<string, unknown>

  if (ok === true) {
    // The single invariant this route re-checks itself rather than inheriting.
    // `fork-thread.ts` guarantees the returned id differs from the source, but
    // this router does not import it, so a structurally-matching object from
    // anywhere would otherwise be taken at its word — and the value at stake is
    // whether COS is about to hand the user's LIVE thread back to them labelled
    // as a fresh copy.
    if (!isValidNativeThreadId(newNativeThreadId)) return { kind: 'orphan_possible' }
    if (newNativeThreadId === sourceNativeThreadId) return { kind: 'mutated' }
    if (sourceIntegrity === 'mutated') return { kind: 'mutated' }
    if (sourceIntegrity !== 'verified_unchanged' && sourceIntegrity !== 'unverified') {
      return { kind: 'orphan_possible' }
    }
    return { kind: 'created', newNativeThreadId, integrity: sourceIntegrity }
  }

  if (ok === false) {
    if (reason === 'source_thread_mutated' || sourceIntegrity === 'mutated') return { kind: 'mutated' }
    // Only an explicit "no child was created" earns the clean failure.
    if (forkState === 'none') return { kind: 'failed' }
  }
  return { kind: 'orphan_possible' }
}

export const FORKED_COPY = 'Copied into a new thread. Your original is untouched.'

/**
 * Both fingerprints present, bounded, and strings.
 *
 * They are persisted into the binding and handed to the adapter, and nothing in
 * the type says they are hashes rather than raw paths — the store's own header
 * says so. Bounded because they become JSON in a durable file; never projected,
 * which is why the shape check is all that is needed here.
 */
export function isUsableResolution(value: unknown): value is TargetResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { workspaceFingerprint: w, sourceFingerprint: s } = value as Partial<TargetResolution>
  return (
    typeof w === 'string' && w.length > 0 && w.length <= 1024 &&
    typeof s === 'string' && s.length > 0 && s.length <= 1024
  )
}

/** Parsed body, or null for anything that is not a JSON object — including an unparsed body. */
function plainBody(req: Request): Record<string, unknown> | null {
  const body: unknown = (req as { body?: unknown }).body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Record<string, unknown>
}

export const ATTACHED_COPY = 'Attached. COS is driving the original thread.'
export const TURN_SENT_COPY = 'Sent to the original thread.'

/**
 * The 202 copy. Says QUEUED and not sent, because at this instant the provider has
 * not been spawned — claiming otherwise would be the same silent-success lie the
 * ambiguous path exists to avoid.
 */
export const TURN_QUEUED_COPY = 'Queued to the original thread. It keeps running if you put your phone away.'

/** Status of a turn that is admitted and still running. */
export const TURN_PENDING_COPY = 'Still working on your Mac.'

/**
 * Status of a turn this binding has never heard of.
 *
 * Deliberately NOT phrased as "it failed": an unknown key is far more likely to be
 * a client asking about a turn that never got admitted than a lost one, and
 * telling the user a turn failed is how a retry puts a second copy into a real
 * conversation.
 */
export const TURN_UNKNOWN_COPY = 'COS has no record of that turn. Nothing was sent.'

/**
 * Is writing into a native desktop thread turned on?
 *
 * OFF BY DEFAULT, permanently and by design (plan 4.9). A user who never sets this
 * gets exactly the behavior that existed before this feature: read-only browsing
 * and Fork-only everywhere. That is a supported end state, not a migration step.
 *
 * Same shape as `claudeSessionsEnabled()` in routes/claude-sessions.ts rather than
 * a second flag pattern. Strict `=== '1'`, so any other value including 'true'
 * reads as OFF - a feature that writes into a human's conversation should be hard
 * to turn on by accident.
 */
/** Client-supplied idempotency key. Long enough that a collision is deliberate. */
export const CLIENT_TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

export function threadAttachEnabled(): boolean {
  return process.env.COS_THREAD_ATTACH_ENABLED === '1'
}

export function createAgentSessionBindingsRouter(deps: AgentSessionBindingsDeps): Router {
  const router = Router()
  // Evaluated once at wiring time. Incomplete dependencies are a wiring bug, and
  // the safe response to a wiring bug is a route that refuses with a reason, not
  // a server that will not boot and not a route that guesses.
  // Resolved once at wiring time, like canDetect/canListBindings. Injectable so a
  // test can drive both states without mutating process.env.
  const attachEnabled = deps?.attachEnabled ?? threadAttachEnabled()
  const canDetect = occupancyDepsUsable(deps)
  const canListBindings = bindingDepsUsable(deps)
  const canWriteBindings = bindingWriteDepsUsable(deps)
  const detect = deps?.occupancy ?? threadOccupancy
  // INJECTABLE. index.ts owns the instance because the thread-turn queue is wired
  // BEFORE this router and must be able to see a fence; a second guard created here
  // would be a disconnected copy, and the queue would go on reading an empty one.
  const guard = deps.guard ?? new TargetGuard(deps.fencePersistence ?? null)
  // `ps -o lstart=` is the only start-time keyword macOS ps offers. Injectable so a
  // test drives recycled and unreadable pids without spawning real processes.
  const livenessDeps: FenceLivenessDeps = deps.liveness ?? {
    pidStartMs: makePidStartProbe((pid) => {
      try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
          encoding: 'utf8', timeout: 2_000,
        })
      } catch {
        return null   // not running, or ps refused the pid
      }
    }),
  }
  const ownership = deps?.ownership ?? { record: recordCosSpawn, release: releaseCosSpawn }
  // One per router. Injectable so the follow-on (attach accepting a `forkRef`)
  // shares this instance rather than standing up a second, disconnected one.
  const forkRefs = deps?.forkRefs instanceof ForkRefStore ? deps.forkRefs : new ForkRefStore()
  const attachTtlMs =
    Number.isFinite(deps?.attachTtlMs) && (deps.attachTtlMs as number) > 0
      ? (deps.attachTtlMs as number)
      : DEFAULT_ATTACH_TTL_MS
  const maxPromptChars =
    Number.isInteger(deps?.maxPromptChars) && (deps.maxPromptChars as number) > 0
      ? (deps.maxPromptChars as number)
      : DEFAULT_MAX_PROMPT_CHARS
  const mintId = typeof deps?.newId === 'function' ? deps.newId : () => randomUUID()

  /**
   * One owner for "is this thread free right now", shared by the probe and both
   * writes, including its own try/catch and the self-contradiction re-check.
   *
   * Sharing it is the point. Provider and id validation, the reason precedence
   * between them, and the refusal to trust an unsound verdict all live in exactly
   * one place, so the write routes cannot come to a different conclusion than the
   * probe the user was shown a second earlier.
   */
  const runOccupancy = (provider: string, threadId: string): AttachabilityBody => {
    let verdict: Occupancy
    try {
      verdict = detect(provider, threadId, deps.probes, deps.dirs)
    } catch (error) {
      // `threadOccupancy` already contains its own probe try/catch, so reaching
      // here means the detector itself threw. Logged without the thread id.
      console.error(`[agent-session-bindings] occupancy threw: ${error instanceof Error ? error.message : error}`)
      verdict = { attachable: false, owners: [], reason: 'probe_failed' }
    }
    return projectAttachability(verdict)
  }

  const refuseAttach = (res: Response, reason: WriteRefusal): void => {
    res.status(refusalStatus(reason)).json({
      attached: false,
      reason,
      reasonCopy: writeReasonCopy(reason),
    })
  }

  /** Read a finite clock, or null. A route that cannot tell the time refuses. */
  const readNow = (): number | null => {
    try {
      const value = deps.now()
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    } catch (error) {
      console.error(`[agent-session-bindings] clock threw: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  /**
   * Current head as an opaque digest, or null when it could not be established.
   *
   * Null covers three different upstream events on purpose — the module is
   * unwired, it answered null, or it threw — because all three leave this router
   * without a baseline, and without a baseline plan 4.3 has no divergence check
   * at all. The raw token is returned alongside so the adapter can be handed it;
   * only the digest ever reaches the wire.
   */
  const readHead = async (
    provider: BindableProvider,
    threadId: string,
  ): Promise<{ raw: string; digest: string } | null> => {
    const read = deps.nativeHead
    if (typeof read !== 'function') return null
    try {
      const raw = await read(provider, threadId)
      if (typeof raw !== 'string' || raw.length === 0) return null
      return { raw, digest: opaqueRevision(raw) }
    } catch (error) {
      console.error(`[agent-session-bindings] native head threw: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  // ------------------------------------------------------------------ fences
  //
  // Mounted BEFORE the parameterised routes so `fences` can never be read as a
  // provider. Both are operator surfaces: a fenced thread was previously
  // discoverable only by trying to use it and being refused.
  //
  // A fence is addressed by DIGEST. The raw target key embeds the private native
  // thread id, and the redaction contract at the top of this file is absolute.

  router.get('/agent-sessions/fences', (_req, res) => {
    // A fence list is a liveness answer; a cached one is worse than none.
    res.set('Cache-Control', 'private, no-store')
    // `degraded` is reported, never inferred: a memory-only fence set behaves
    // identically to a durable one until the process restarts, so a silent
    // fallback would be indistinguishable from working.
    res.json({ fences: guard.listFences(livenessDeps), degraded: guard.degraded() })
  })

  router.post('/agent-sessions/fences/release', (req, res) => {
    const body = (req.body ?? {}) as { target?: unknown; confirm?: unknown }
    const target = body.target
    if (typeof target !== 'string' || target.length === 0 || target.length > 256) {
      res.status(400).json({ released: false, reason: 'invalid_request' })
      return
    }
    res.set('Cache-Control', 'private, no-store')
    if (body.confirm !== true) {
      // FAILS CLOSED, like every other destructive COS call. NOTE WHAT THIS IS
      // AND IS NOT: it is a deliberate second call, not proof a human looked.
      // The API token is shared by the phone, the lens and every COS agent
      // session, so nothing is structurally prevented from asserting `confirm`.
      // It stops an accidental release, not an automated one.
      // The preview carries the liveness aggregate too: this is the exact moment a
      // person decides, and "a child from this turn is still running" is the one
      // thing here a machine can tell them.
      const preview = guard.listFences(livenessDeps).find(f => f.target === target) ?? null
      res.status(400).json({ released: false, reason: 'confirmation_required', preview })
      return
    }
    // The guard decides. It re-matches the handle itself rather than trusting a
    // lookup performed up here, and it persists BEFORE it mutates.
    const outcome = guard.releaseFence(target)
    if (!outcome.ok) {
      const status = outcome.reason === 'unknown_fence' ? 404 : 500
      res.status(status).json({ released: false, reason: outcome.reason })
      return
    }
    // THE EVIDENCE DIES WITH THE ROW. `releaseFence` deletes it, and the realistic
    // sequence is: first fence ever lands -> Control's card appears -> it is
    // released -> the distribution this evidence exists to collect is gone. So the
    // release line carries the whole record, not just its identity.
    const ev = outcome.row
    console.warn(`[agent-session-bindings] fence RELEASED by operator target=${target} provider=${ev.provider} fencedAt=${ev.fencedAt} fenceSite=${ev.fenceSite ?? 'unknown'} adapterReason=${ev.adapterReason ?? 'unknown'} detail=${ev.adapterDetail ?? 'none'} exitCode=${ev.exitCode ?? 'null'} childReaped=${ev.childReaped ?? 'unknown'} stderrClass=${ev.stderrClass ?? 'none'} durationMs=${ev.durationMs ?? 'unknown'} spawnCount=${ev.spawns?.length ?? 0}`)
    res.json({ released: true, target, provider: outcome.row.provider })
  })

  router.get('/agent-sessions/:provider/:threadId/attachability', (req, res) => {
    // An occupancy verdict is a liveness answer with a lifetime of roughly now.
    // A cached `attachable: true` is indistinguishable from a stale one, which is
    // the whole failure this feature exists to prevent.
    res.set('Cache-Control', 'private, no-store')

    // Before `canDetect` and before any probe. With no write path there is nothing
    // to protect against, so a disabled install does no filesystem work and cannot
    // fail. It also keeps the surface self-consistent: reporting `attachable: true`
    // while the attach route is unrouted would leave a client unable to tell
    // whether the thread is free or the feature is off.
    if (!attachEnabled) {
      res.json(projectAttachability({ attachable: false, owners: [], reason: 'attach_disabled' }))
      return
    }

    if (!canDetect) {
      // The mechanism does not exist on this install. Distinct from "it ran and
      // found nothing" by design (plan 4.3 wants the reason nameable).
      res.json(projectAttachability({ attachable: false, owners: [], reason: 'detector_unavailable' }))
      return
    }

    // 200 for every verdict, including a bad provider or a malformed id.
    //
    // The route's job is to answer "can I attach?", and "no, because that is not a
    // provider COS can continue" is an answer the footer can render. Following
    // claude-sessions.ts, which returns 200 for the switched-off case for the same
    // reason: a client that gets a 4xx has to invent copy, and invented copy is
    // where "unavailable" quietly becomes "try anyway".
    //
    // Provider and id are validated by `threadOccupancy` BEFORE it touches a
    // filesystem, in that order. Re-checking them here would be a second copy of a
    // rule that already has one owner, and the two copies are exactly how the
    // truncated-id hole opened. The tests pin the ordering behaviorally instead:
    // probes that throw on every call still return `unsupported_provider` /
    // `invalid_thread_id`, which is only possible if nothing was probed.
    res.json(runOccupancy(String(req.params.provider ?? ''), String(req.params.threadId ?? '')))
  })

  router.get('/agent-sessions/bindings', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')

    const unavailable = (reason: string) => {
      // 503, not an empty 200. An empty `bindings` array from this route must
      // always mean "proved there are none"; if it could also mean "could not
      // look", every caller inherits the absence-inference bug.
      res.status(503).json({ bindings: [], available: false, reason, generatedAt: null })
    }

    // Distinct from `binding_registry_unavailable` on purpose, and the mutation
    // pass is why. With one shared reason this branch had NO observable behavior:
    // an unwired registry threw inside the try below and produced the identical
    // response, so deleting the gate changed nothing and the guard was decoration.
    // Separating them gives it a job worth testing and answers the question an
    // operator actually has: a build was wired wrong, not a disk that failed.
    if (!canListBindings) {
      unavailable('binding_registry_unwired')
      return
    }

    let rows: readonly NativeBinding[]
    let now: number
    try {
      // Asked BEFORE the list, because a degraded store answers `list()` with an
      // empty array rather than an error. Anything other than an explicit `true`
      // is unusable: a probe that answers "maybe" is answering no.
      if (deps.bindings.available() !== true) {
        unavailable('binding_registry_degraded')
        return
      }
      rows = deps.bindings.list()
      now = deps.now()
    } catch (error) {
      console.error(`[agent-session-bindings] binding list failed: ${error instanceof Error ? error.message : error}`)
      unavailable('binding_registry_unavailable')
      return
    }

    if (!Array.isArray(rows) || typeof now !== 'number' || !Number.isFinite(now)) {
      unavailable('binding_registry_unavailable')
      return
    }

    const bindings: BindingSummary[] = []
    for (const row of rows) {
      // A malformed row makes the WHOLE listing unavailable rather than a silently
      // shorter one. A list that quietly drops the row it could not parse tells the
      // operator a binding is gone when it may be live and holding a target.
      if (!isUsableBindingRow(row)) {
        unavailable('binding_registry_unreadable')
        return
      }
      if (isTerminal(row)) continue
      bindings.push(projectBinding(row, now))
    }

    res.json({ bindings, available: true, reason: null, generatedAt: now })
  })

  // ---------------------------------------------------------------- attach
  //
  // Registered before the turns route only for tidiness; the two paths end in
  // different literal segments (`attach` vs `turns`) so neither can shadow the
  // other, and neither can shadow `agentSessionsRouter`'s two-segment GETs.
  // Registered ONLY when the feature is on. Not a handler that declines - an
  // unregistered path 404s, so a disabled server holds no reachable write code.
  if (attachEnabled) router.post('/agent-sessions/:provider/:threadId/attach', async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      if (!canDetect) return refuseAttach(res, 'detector_unavailable')
      if (!canWriteBindings) return refuseAttach(res, 'binding_registry_unwired')

      // The only field the client may send. Plan 4.2: no path, cwd, executable,
      // model, target key, permission mode or credentials — the server resolves
      // every execution field itself. Extra keys are ignored rather than rejected
      // so a newer client cannot be broken by an older server, but nothing outside
      // this one field is ever read.
      const body = plainBody(req)
      const cosSessionId = body?.cosSessionId
      if (typeof cosSessionId !== 'string' || !COS_SESSION_ID_RE.test(cosSessionId)) {
        return refuseAttach(res, 'invalid_request')
      }

      const now = readNow()
      if (now === null) return refuseAttach(res, 'binding_registry_unavailable')

      let available: boolean
      try {
        available = deps.bindings.available() === true
      } catch (error) {
        console.error(`[agent-session-bindings] availability threw: ${error instanceof Error ? error.message : error}`)
        return refuseAttach(res, 'binding_registry_unavailable')
      }
      if (!available) return refuseAttach(res, 'binding_registry_degraded')

      const providerParam = String(req.params.provider ?? '')
      const threadIdParam = String(req.params.threadId ?? '')

      // THE HARD PRECONDITION (plan 4.3, option B). Not advisory, not a warning,
      // and not a field on a successful response: a thread with any live owner —
      // or any doubt about whether it has one — is Fork-only, and attach is the
      // gate that makes that true.
      const verdict = runOccupancy(providerParam, threadIdParam)
      if (!verdict.attachable) return refuseAttach(res, verdict.reason ?? 'probe_failed')

      // `runOccupancy` already proved both, provider first. These narrow the types
      // rather than re-deciding the rule — a second copy of the id rule is how the
      // truncated-id hole opened. A failure here is a self-contradicting detector,
      // and a contradiction refuses.
      if (!isBindableProvider(providerParam)) return refuseAttach(res, 'unsupported_provider')
      if (!isValidNativeThreadId(threadIdParam)) return refuseAttach(res, 'invalid_thread_id')

      const key = targetKey(providerParam, threadIdParam)
      const fenced = guard.fencedReason(key)
      // A target holding a turn that may already have been delivered does not open
      // again just because the binding that delivered it is gone. Checked here as
      // well as in the turn route, because a fresh attach is the obvious way around
      // a per-binding fence.
      if (fenced !== null) {
        console.warn(`[agent-session-bindings] fence hit route=attach provider=${providerParam} target=${opaqueRevision(key)}`)
        return refuseAttach(res, fenced)
      }

      const resolve = deps.resolveTarget
      if (typeof resolve !== 'function') return refuseAttach(res, 'target_unresolvable')
      let resolved: TargetResolution | null = null
      try {
        resolved = resolve(providerParam, threadIdParam)
      } catch (error) {
        console.error(`[agent-session-bindings] target resolve threw: ${error instanceof Error ? error.message : error}`)
        resolved = null
      }
      if (!isUsableResolution(resolved)) return refuseAttach(res, 'target_unresolvable')

      // The divergence baseline. No baseline, no attach: plan 4.3 is the only
      // thing that makes a desktop edit visible, and a binding that cannot run it
      // would be a binding whose every turn is unchecked.
      const head = await readHead(providerParam, threadIdParam)
      if (head === null) return refuseAttach(res, 'native_head_unavailable')

      const bindingId = `bnd-${mintId()}`
      if (!BINDING_ID_RE.test(bindingId)) return refuseAttach(res, 'attach_failed')

      // `create` reads the epoch from the DURABLE per-target high-water ledger and
      // refuses a caller-supplied one. Passing `priorEpoch` from a live binding —
      // the shortcut this deliberately cannot express — is what reopens the replay
      // window after a detach and eviction. It also enforces one non-terminal
      // binding per target: a second attach gets `target_busy`, never a re-bind.
      const created = deps.bindings.create!({
        bindingId,
        cosSessionId,
        provider: providerParam,
        nativeThreadId: threadIdParam,
        workspaceFingerprint: resolved!.workspaceFingerprint,
        sourceFingerprint: resolved!.sourceFingerprint,
        nativeHeadAtAttach: head.digest,
        ttlMs: attachTtlMs,
        now,
      })
      if (!created?.binding) return refuseAttach(res, registryRefusal(created?.reason))

      const activated = deps.bindings.activate!(bindingId, now)
      if (!activated?.binding) {
        // A staging binding still HOLDS the target. Leaving it there would make
        // every later attach to this thread fail `target_busy` until the lease
        // expired, with nothing driving it and nothing to detach.
        try {
          deps.bindings.forceDetach!(bindingId, now)
        } catch (error) {
          console.error(`[agent-session-bindings] rollback failed: ${error instanceof Error ? error.message : error}`)
        }
        return refuseAttach(res, registryRefusal(activated?.reason))
      }

      res.status(201).json({
        attached: true,
        reason: null,
        reasonCopy: ATTACHED_COPY,
        bindingId,
        epoch: activated.binding.epoch,
        // Digest, not the marker. `boundToMarker` embeds the targetKey, which
        // embeds the exact private native id, and this router does not put that on
        // the wire. The digest is deterministic, so the client can hand it back and
        // the server recomputes it.
        boundTo: opaqueRevision(boundToMarker(activated.binding)),
        revision: head.digest,
        binding: projectBinding(activated.binding, now),
      })
    } catch (error) {
      console.error(`[agent-session-bindings] attach failed: ${error instanceof Error ? error.message : error}`)
      if (!res.headersSent) refuseAttach(res, 'attach_failed')
    }
  })

  // ------------------------------------------------------------------ fork
  //
  // The action seventeen refusal strings in this feature already recommend, and
  // which until now did not exist anywhere in the server or the app.
  //
  // THERE IS NO OCCUPANCY CHECK IN THIS HANDLER, AND THAT IS THE POINT. Attach and
  // turns both refuse when a live desktop process holds the thread, because they
  // are about to APPEND to it. A fork appends to nothing: it reads the source and
  // writes a NEW thread, verified byte-for-byte on both providers on 2026-08-16. A
  // live owner is therefore not a hazard here — it is the ordinary case, and the
  // reason the user was sent to this route in the first place. Gating fork on
  // occupancy would refuse precisely when it is needed and leave the user with no
  // path at all. Nothing in this handler may grow such a gate.
  //
  // FOR THE SAME REASON it ignores the fence, the binding registry, and
  // `native_target_busy`. A fenced thread is one that may hold an undelivered COS
  // turn, and the fence copy tells the user to go and look at it — forking it is
  // safe and is very often the next thing they want.
  //
  // IT IS STILL GATED ON `COS_THREAD_ATTACH_ENABLED`. Fork does not write into an
  // existing conversation, but it does spawn a provider CLI against the user's
  // workspace on their behalf, which is the same class of authority the flag
  // exists to hold. A disabled server holds no reachable fork code either.
  // UNGATED, deliberately, and this is a correction rather than an oversight.
  //
  // With fork behind the same flag, the SHIPPING DEFAULT was incoherent: seventeen
  // refusal strings say "Fork it instead", the lens drew an enabled Fork row, and
  // the tap got an Express HTML 404 with no reason and no copy. Reproduced.
  //
  // The flag exists to gate WRITING INTO AN EXISTING CONVERSATION. Fork does not do
  // that: it creates a NEW thread and leaves the source byte-identical, measured on
  // a disposable thread (original 75194 bytes before and after, a new transcript
  // carrying the history). So the thing the flag protects is not the thing fork
  // does, and gating it only removed the alternative that every refusal recommends.
  //
  // It is also what "read-only with Fork-only" means as a permanent supported
  // state: browse, and branch off rather than write in.
  router.post('/agent-sessions/:provider/:threadId/fork', async (req, res) => {
    res.set('Cache-Control', 'private, no-store')

    /** The per-source serialisation claim, released in the finally. */
    let claimedForkKey: string | null = null

    const refuseFork = (reason: WriteRefusal, extra: Record<string, unknown> = {}): void => {
      if (res.headersSent) return
      res.status(refusalStatus(reason)).json({
        forked: false,
        forkRef: null,
        sourceIntegrity: null,
        // Default false because every refusal that reaches it directly is
        // pre-spawn. The paths that cannot say it override it explicitly.
        orphanPossible: false,
        retryable: true,
        reason,
        reasonCopy: writeReasonCopy(reason),
        ...extra,
      })
    }

    try {
      const fork = deps.forkThread
      if (typeof fork !== 'function') return refuseFork('fork_unwired')

      const body = plainBody(req)
      // Covers the case where no JSON parser ran at all: an unparsed body is not an
      // empty one.
      if (body === null) return refuseFork('invalid_request')

      const cosSessionId = body.cosSessionId
      if (typeof cosSessionId !== 'string' || !COS_SESSION_ID_RE.test(cosSessionId)) {
        return refuseFork('invalid_request')
      }
      const prompt = body.prompt
      if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > maxPromptChars) {
        return refuseFork('invalid_request')
      }

      const providerParam = String(req.params.provider ?? '')
      const threadIdParam = String(req.params.threadId ?? '')
      // Validated HERE rather than inherited from an occupancy verdict, because
      // this route deliberately never asks for one. The id becomes a spawn
      // argument and a lock key, so `isValidNativeThreadId` is the whole guard.
      if (!isForkableProvider(providerParam)) return refuseFork('fork_unsupported_provider')
      if (!isValidNativeThreadId(threadIdParam)) return refuseFork('fork_invalid_thread_id')

      const now = readNow()
      if (now === null) return refuseFork('fork_failed')

      const resolveWorkspace = deps.resolveForkWorkspace
      if (typeof resolveWorkspace !== 'function') return refuseFork('fork_workspace_unresolvable')
      let cwd: string | null = null
      try {
        cwd = resolveWorkspace(providerParam, threadIdParam)
      } catch (error) {
        console.error(`[agent-session-bindings] fork workspace resolve threw: ${error instanceof Error ? error.message : error}`)
        cwd = null
      }
      // Absolute, checked here as well as in the module. A relative path resolves
      // against the SERVER's cwd, so the copy would land in the wrong project while
      // every response looked correct.
      if (typeof cwd !== 'string' || cwd.length === 0 || !cwd.startsWith('/') || cwd.includes('\0')) {
        return refuseFork('fork_workspace_unresolvable')
      }

      // LAST SYNCHRONOUS STATEMENT BEFORE THE FIRST AWAIT. One fork per source
      // thread at a time: this route spawns a provider CLI, and without a claim a
      // client retry loop spawns one child per request with nothing bounding it.
      // A DISTINCT key namespace from the turn claim, so a fork can never block a
      // continuation or be blocked by one — `targetKey` is length-prefixed and
      // therefore unambiguous, and this prefix cannot collide with one.
      const forkKey = `fork:${targetKey(providerParam, threadIdParam)}`
      if (!guard.tryClaim(forkKey, forkKey)) return refuseFork('fork_in_progress')
      claimedForkKey = forkKey

      let raw: unknown
      try {
        raw = await fork({
          provider: providerParam,
          nativeThreadId: threadIdParam,
          prompt,
          cwd,
          // Text-only, same as the attached path. A fork runs a real model turn
          // against a workspace the user did not hand us explicitly.
          policy: 'read_only',
        })
      } catch (error) {
        console.error(`[agent-session-bindings] fork threw: ${error instanceof Error ? error.message : error}`)
        // A throw from an unknown point cannot prove no child ran.
        return refuseFork('fork_orphan_possible', { orphanPossible: true })
      }

      const outcome = classifyFork(raw, threadIdParam)

      if (outcome.kind === 'mutated') {
        // The original moved. Loudest outcome in the feature, and not retryable:
        // the user needs to look at their own thread before anything else touches it.
        return refuseFork('fork_source_mutated', { orphanPossible: true, retryable: false })
      }
      if (outcome.kind === 'orphan_possible') {
        return refuseFork('fork_orphan_possible', { orphanPossible: true })
      }
      if (outcome.kind === 'failed') return refuseFork('fork_failed')

      // Digest, not the id. The native thread id never crosses this boundary, for
      // a fresh fork exactly as for an existing thread.
      const forkRef = forkRefs.remember(providerParam, outcome.newNativeThreadId, now)

      res.status(201).json({
        forked: true,
        reason: null,
        reasonCopy: FORKED_COPY,
        forkRef,
        // Reported, never assumed. `unverified` means COS could not read the
        // original at both ends — which is not the same as, and must never be
        // rendered as, "confirmed untouched".
        sourceIntegrity: outcome.integrity,
        orphanPossible: false,
      })
    } catch (error) {
      console.error(`[agent-session-bindings] fork route failed: ${error instanceof Error ? error.message : error}`)
      // A bug in this handler cannot prove whether a child ran, so it reports the
      // cautious outcome rather than a clean failure.
      refuseFork('fork_orphan_possible', { orphanPossible: true })
    } finally {
      if (claimedForkKey !== null) guard.release(claimedForkKey, claimedForkKey)
    }
  })

  // ----------------------------------------------------------------- turns
  if (attachEnabled) router.post('/agent-sessions/bindings/:bindingId/turns', async (req, res) => {
    res.set('Cache-Control', 'private, no-store')

    const turnId = mintId()
    /** The target we hold a claim on, released in the finally. */
    let claimedKey: string | null = null
    // Hoisted so the CATCH site can fence with evidence. `binding` and `head` are
    // both declared inside the try, so neither is in scope where the route-error
    // fence is set — without these it would store a fence it can say nothing about.
    let fenceProvider = ''
    let preTurnHeadDigest: string | null = null
    /** Children the adapter reported, released in the finally. */
    // PAIRS, not bare pids. A pid alone cannot be told apart from a recycled one,
    // and `startMs` is measured in the onSpawn closure and was previously discarded.
    const recordedPids: Array<{ pid: number; startMs: number }> = []
    // Hoisted so BOTH fence sites can record what the adapter actually reported.
    // `result` is scoped inside the try; the ambiguous site sits after the catch.
    // NARROW ON PURPOSE. `Partial<FenceEvidence>` would permit provider/headBefore/
    // turnId/bindingId/now, and the spread sits AFTER them at both fence sites — so
    // a future field could silently overwrite the fence's identity. The adapter
    // result literally carries a `provider`, which would write null and fail
    // `isFenceRecord` on the next read, silently un-enforcing the fence.
    let adapterEvidence: Partial<Pick<FenceEvidence,
      'adapterReason' | 'adapterDetail' | 'exitCode' | 'childReaped' | 'stderrClass' | 'durationMs'>> = {}
    let pinnedBindingId: string | null = null
    let requestNow = 0
    /**
     * Has the adapter been ENTERED? Everything after this point is ambiguous on
     * a throw; everything before it is provably undelivered.
     */
    let deliveryAttempted = false
    /** Client idempotency key and its binding. Null until the body is validated. */
    let clientTurnId: string | null = null
    let ledgerBindingId: string | null = null
    /**
     * Has the 202 already gone out, leaving the ledger as the ONLY way to report
     * what happened?
     *
     * A provider turn runs for minutes — up to a 21 minute default — and the phone
     * cannot hold a request open across that: iOS suspends the WebView the moment
     * it is backgrounded. So every gate below runs synchronously, and delivery
     * alone is backgrounded once the last gate passes.
     */
    let queued = false

    const respond = (status: number, payload: Record<string, unknown>): void => {
      if (!res.headersSent) res.status(status).json(payload)
      // Remembered ONLY when the prompt may have reached the provider. A
      // pre-delivery refusal (stale epoch, malformed body, busy target) must stay
      // re-evaluatable: the binding may be fine by the time the client retries, and
      // replaying a stale "no" would be its own bug.
      //
      // `completed` and `ambiguous` are the two that must never run twice. Measured
      // 2026-08-16: two byte-identical POSTs both returned completed and the user's
      // real transcript ended up with two copies of the turn.
      // Once queued, the ledger is the ONLY reporting channel — the 202 is long
      // gone. A post-202 refusal that recorded nothing would leave the status route
      // answering `pending` forever, which reads to the user as a turn still
      // running when it was actually refused minutes ago. Pre-202 refusals keep the
      // old semantics deliberately: they stay re-evaluatable, because the binding
      // may well be fine by the time the client retries.
      const outcome = payload.outcome
      const terminal = outcome === 'completed' || outcome === 'ambiguous' || (queued && outcome === 'refused')
      if (clientTurnId !== null && ledgerBindingId !== null && terminal) {
        try {
          deps.bindings.recordTurn?.(ledgerBindingId, clientTurnId, { ...payload, status }, readNow() ?? requestNow)
        } catch (error) {
          // A ledger failure must not turn a delivered turn into an error response.
          // The cost is a lost idempotency record, never a lost turn.
          console.error(`[agent-session-bindings] turn ledger write failed: ${error instanceof Error ? error.message : error}`)
        }
      }
    }
    const refuseTurn = (reason: WriteRefusal, extra: Record<string, unknown> = {}): void => {
      respond(refusalStatus(reason), {
        turnId,
        outcome: 'refused',
        // Every refusal below is reached BEFORE the adapter is entered, so this
        // default is a statement of fact, not an optimistic guess. The two paths
        // that cannot say it — the ambiguous outcome and the fence — override it.
        deliveryState: 'not_delivered',
        retryable: true,
        changed: false,
        revision: null,
        reason,
        reasonCopy: writeReasonCopy(reason),
        ...extra,
      })
    }
    const reportAmbiguous = (): void => {
      respond(refusalStatus('delivery_ambiguous'), {
        turnId,
        outcome: 'ambiguous',
        // The whole point. "I did not see it land" is not "it did not land", so a
        // client must never read this as a failure it may retry.
        deliveryState: 'unknown',
        retryable: false,
        changed: false,
        revision: null,
        reason: 'delivery_ambiguous',
        reasonCopy: writeReasonCopy('delivery_ambiguous'),
      })
    }

    try {
      if (!canDetect) return refuseTurn('detector_unavailable')
      if (!canWriteBindings) return refuseTurn('binding_registry_unwired')
      const deliver = deps.deliverAttachedTurn
      if (typeof deliver !== 'function') return refuseTurn('adapter_unwired')
      if (typeof deps.nativeHead !== 'function') return refuseTurn('native_head_unavailable')
      if (typeof ownership?.record !== 'function' || typeof ownership?.release !== 'function') {
        // Without the ledger a spawned child cannot be recognised as ours, so the
        // next occupancy check reads it as a live foreign owner and the thread
        // locks itself out. Refusing beats delivering a turn that poisons the next.
        return refuseTurn('adapter_unwired')
      }

      const now = readNow()
      if (now === null) return refuseTurn('binding_registry_unavailable')
      requestNow = now

      let available: boolean
      try {
        available = deps.bindings.available() === true
      } catch (error) {
        console.error(`[agent-session-bindings] availability threw: ${error instanceof Error ? error.message : error}`)
        return refuseTurn('binding_registry_unavailable')
      }
      if (!available) return refuseTurn('binding_registry_degraded')

      const bindingId = String(req.params.bindingId ?? '')
      // A malformed id names no binding. Answered as `unknown_binding` rather than
      // a distinct shape so a prober cannot tell "wrong format" from "no such
      // lease".
      if (!BINDING_ID_RE.test(bindingId)) return refuseTurn('unknown_binding')

      const body = plainBody(req)
      // Covers the case where no JSON parser ran at all: an unparsed body is not
      // an empty one, and must not fall through as a turn with no claims to check.
      if (body === null) return refuseTurn('invalid_request')

      const prompt = body.prompt
      if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > maxPromptChars) {
        return refuseTurn('invalid_request')
      }
      const epoch = body.epoch
      if (!Number.isInteger(epoch) || (epoch as number) < 1) return refuseTurn('invalid_request')
      const claimedTargetKey = body.targetKey
      if (typeof claimedTargetKey !== 'string' || claimedTargetKey.length === 0 || claimedTargetKey.length > 512) {
        return refuseTurn('invalid_request')
      }
      const acknowledged = body.acknowledgedRevision
      if (acknowledged !== undefined && acknowledged !== null && !isOpaque(acknowledged)) {
        return refuseTurn('invalid_request')
      }
      const boundTo = body.boundTo
      if (boundTo !== undefined && boundTo !== null && !isOpaque(boundTo)) return refuseTurn('invalid_request')

      // REQUIRED, not optional. A turn with no idempotency key cannot be made safe:
      // the client cannot tell "delivered but the 200 was lost" from "never
      // arrived", so it will retry, and without a key the server cannot tell that
      // retry from a new turn. Required rather than defaulted because there are no
      // existing callers to break - the feature ships dark.
      const submitted = body.clientTurnId
      if (typeof submitted !== 'string' || !CLIENT_TURN_ID_RE.test(submitted)) {
        return refuseTurn('invalid_request')
      }
      clientTurnId = submitted
      ledgerBindingId = bindingId

      // REPLAY, before any occupancy check, head read, or spawn: if this exact turn
      // already reached a terminal state, hand back what it actually did.
      const already = deps.bindings.findTurn?.(bindingId, clientTurnId) ?? null
      if (already !== null && already.result && typeof already.result === 'object') {
        const { status, ...rest } = already.result as Record<string, unknown>
        if (!res.headersSent) {
          res.status(typeof status === 'number' ? status : 200).json({ ...rest, replayed: true })
        }
        return
      }

      // The client-queued-prompt gate, used rather than reimplemented: it is the
      // one place that orders state before epoch before target, and a second
      // opinion here is how the store's own header says the two drifted apart.
      const gate = deps.bindings.checkQueuedPrompt!({ bindingId, epoch: epoch as number, targetKey: claimedTargetKey }, now)
      if (gate?.ok !== true) return refuseTurn(registryRefusal(gate?.reason))

      const binding = deps.bindings.get!(bindingId)
      if (binding) fenceProvider = binding.provider
      // Only `active` runs work. `staging` is the pre-commit state of the journaled
      // Chat handoff and must never execute against a Chat that can still roll back.
      const usable = assertUsable(binding ?? null, now)
      if (usable.ok !== true || !binding) return refuseTurn(registryRefusal(usable.reason ?? 'unknown_binding'))
      if (binding.targetKey !== claimedTargetKey) return refuseTurn('target_mismatch')
      if (binding.epoch !== epoch) return refuseTurn('stale_epoch')
      if (typeof boundTo === 'string' && boundTo !== opaqueRevision(boundToMarker(binding))) {
        return refuseTurn('target_mismatch')
      }
      if (!isBindableProvider(binding.provider) || !isValidNativeThreadId(binding.nativeThreadId)) {
        return refuseTurn('binding_unusable')
      }

      const key = binding.targetKey
      const fenced = guard.fencedReason(key)
      if (fenced !== null) {
        console.warn(`[agent-session-bindings] fence hit route=turn provider=${binding.provider} target=${opaqueRevision(key)} turnId=${turnId}`)
        return refuseTurn(fenced, { retryable: false, deliveryState: 'unknown' })
      }

      // LAST SYNCHRONOUS STATEMENT BEFORE THE FIRST AWAIT. Check-and-set in one
      // call: with an await between them, two turns admitted in the same tick both
      // see a free target and both deliver.
      if (!guard.tryClaim(key, turnId)) return refuseTurn('native_turn_in_progress')
      claimedKey = key

      // Plan 4.3 step 6. The attach-time verdict is minutes old by now; a desktop
      // session started in the gap is exactly the residual risk option B leaves
      // open, and it is terminal here rather than a warning because COS has no
      // cross-process lock that could fence a live desktop writer.
      const verdict = runOccupancy(binding.provider, binding.nativeThreadId)
      if (!verdict.attachable) return refuseTurn(verdict.reason ?? 'probe_failed')

      const head = await readHead(binding.provider, binding.nativeThreadId)
      if (head === null) return refuseTurn('native_head_unavailable')
      preTurnHeadDigest = head.digest

      // The attach baseline, advanced by each completed turn and by each explicit
      // Continue Anyway. Without the advance the SECOND turn on a binding always
      // reads as diverged, because the first turn is what moved the head.
      const baseline = guard.acknowledgedHead(bindingId) ?? binding.nativeHeadAtAttach
      if (typeof baseline !== 'string' || baseline.length === 0) return refuseTurn('native_head_unavailable')
      if (head.digest !== baseline) {
        // Only a changed/not-changed signal and a new opaque revision. No diff, no
        // content, no path — the client is told THAT it moved, never to what.
        if (acknowledged !== head.digest) {
          return refuseTurn('native_thread_changed', { changed: true, revision: head.digest })
        }
        // Continue Anyway: a new admission carrying the acknowledged revision.
        // Recorded now rather than on completion, because the user acknowledged
        // this revision whatever the turn goes on to do.
        guard.acknowledgeHead(bindingId, head.digest)
      }

      // A failed pin is FATAL, per the registry's own caller contract: an unpinned
      // binding can expire or be detached mid-turn, which defeats the lease.
      const pinned = deps.bindings.pin!(bindingId, turnId, now)
      if (!pinned?.binding) return refuseTurn(registryRefusal(pinned?.reason))
      pinnedBindingId = bindingId

      // THE QUEUE POINT. Every gate is now behind us — body, replay, queued-prompt,
      // lease, target, epoch, fence, claim, occupancy, head baseline, pin — so a
      // refusal still reaches the user immediately and precisely. Only the spawn is
      // backgrounded, because only the spawn takes minutes.
      //
      // Nothing below changes. `respond` already writes to the response only when
      // headers have not been sent, and to the ledger regardless, so each terminal
      // outcome now lands in the ledger and the status route serves it.
      queued = true
      res.status(202).json({
        turnId,
        outcome: 'queued',
        clientTurnId,
        bindingId,
        deliveryState: 'pending',
        retryable: false,
        changed: false,
        revision: null,
        reason: null,
        reasonCopy: TURN_QUEUED_COPY,
      })

      let delivery: Delivery
      deliveryAttempted = true
      try {
        const result = await deliver({
          turnId,
          bindingId,
          epoch: binding.epoch,
          provider: binding.provider,
          nativeThreadId: binding.nativeThreadId,
          workspaceFingerprint: binding.workspaceFingerprint,
          sourceFingerprint: binding.sourceFingerprint,
          expectedNativeHead: head.raw,
          prompt,
          onSpawn: (pid: number): boolean => {
            // THE SELF-RECURSION ORDER. The child registers itself against the id
            // we are targeting, so unless it is in the ledger the next occupancy
            // check reads our own process as a live foreign owner.
            let startMs: number | null = null
            try {
              // MEASURED, never `Date.now()`. The wall clock drifts up to 992 ms
              // against a 1500 ms tolerance, and a near-miss silently disables
              // self-identification instead of failing loudly.
              startMs = deps.probes.processStartMs(pid)
            } catch {
              startMs = null
            }
            if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return false
            let outcome: string
            try {
              outcome = ownership.record(pid, startMs)
            } catch {
              return false
            }
            // The ledger reports WHY it refused. Anything but an accepted claim
            // means this child is unrecognisable to us, so the adapter must abort
            // before the prompt rather than deliver a turn that poisons the next
            // occupancy check.
            if (outcome !== 'recorded') return false
            recordedPids.push({ pid, startMs })
            return true
          },
        })
        // Read the adapter's OWN account before it goes out of scope. This is the
        // whole point of the evidence work: `classifyDelivery` collapses six distinct
        // failures into one word, and the difference between them is what decides
        // whether an automatic resolver could ever be safe. A 21-minute `timeout`
        // means the child ran tool calls; a `provider_exit_nonzero` with a code means
        // it exited on its own. Defensive reads — the adapter is injected in tests.
        // AN UNREADABLE RESULT RECORDS NOTHING, not zeroes. Reading `{}` and
        // deriving `exitCode: null, childReaped: false` states two facts about a
        // child nothing is known about, and writes them indistinguishably from a
        // confirmed-unreaped timeout — corrupting the one discriminator this
        // evidence exists to establish.
        const r = (result !== null && typeof result === 'object')
          ? result as Record<string, unknown>
          : null
        adapterEvidence = r === null ? {} : {
          adapterReason: typeof r.reason === 'string' ? r.reason : (r.ok === true ? 'ok' : undefined),
          adapterDetail: typeof r.detail === 'string' ? r.detail : null,
          exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
          // FROM THE ADAPTER, never derived from exitCode. A signal-killed child
          // reports `code === null`, so deriving it would report "never reaped" for
          // the dominant timeout shape — backwards for the decision this informs.
          childReaped: typeof r.reaped === 'boolean' ? r.reaped : undefined,
          stderrClass: typeof r.stderrClass === 'string' ? r.stderrClass : undefined,
          durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
        }
        delivery = classifyDelivery(result)
      } catch (error) {
        console.error(`[agent-session-bindings] adapter threw: ${error instanceof Error ? error.message : error}`)
        delivery = { kind: 'ambiguous' }
      }

      if (delivery.kind === 'aborted') return refuseTurn('provider_never_opened')

      if (delivery.kind === 'ambiguous') {
        // Plan 4.6: the reservation is HELD, not released. A hand-crafted next
        // admission — the client Retry button that mints a fresh generation and
        // clears every other fence — has to hit something server-side, and this is
        // it. The fence outlives the binding, so re-attaching does not open it.
        //
        // Fenced under its own reason, not this turn's: `delivery_ambiguous`
        // describes what happened to THIS request, while a later caller needs to
        // be told the thread is shut and why it must be inspected first.
        // ONE resolved value for the record AND the log. The previous release
        // fixed exactly this contradiction at the other fence site and this one
        // re-committed it: the record said `unreadable_result` while the log said
        // `unknown`, so an operator grepping for the sentinel found nothing.
        const recordedReason = adapterEvidence.adapterReason ?? 'unreadable_result'
        guard.fence(key, 'native_target_fenced', {
          provider: binding.provider,
          headBefore: head.digest,
          turnId,
          bindingId,
          now: Date.now(),
          ...adapterEvidence,
          // NEVER blank. An unreadable adapter result and "nobody recorded it" are
          // different facts and a missing field cannot tell them apart -- which is
          // the whole reason this evidence exists.
          adapterReason: recordedReason,
          fenceSite: 'ambiguous',
          spawns: [...recordedPids],
        })
        // A fence shuts a thread until a human acts, and until now it wrote NO log
        // line at either site — so a fenced thread was discoverable only by trying
        // to use it (Miles, 2026-08-18). Never log `key`: it embeds the private
        // native thread id, which this router does not emit anywhere.
        console.warn(`[agent-session-bindings] fence set site=ambiguous provider=${binding.provider} target=${opaqueRevision(key)} turnId=${turnId} bindingId=${bindingId} headBefore=${head.digest} adapterReason=${recordedReason} detail=${adapterEvidence.adapterDetail ?? 'none'} exitCode=${adapterEvidence.exitCode ?? 'null'} childReaped=${adapterEvidence.childReaped ?? 'unknown'} stderrClass=${adapterEvidence.stderrClass ?? 'none'} durationMs=${adapterEvidence.durationMs ?? 'unknown'} spawnCount=${recordedPids.length}`)
        return reportAmbiguous()
      }

      let after = delivery.after === null ? null : opaqueRevision(delivery.after)
      if (after === null) {
        // Best effort. If it fails the baseline simply does not advance and the
        // next turn asks for an acknowledgement — conservative, never permissive.
        const reread = await readHead(binding.provider, binding.nativeThreadId)
        after = reread === null ? null : reread.digest
      }
      if (after !== null) guard.acknowledgeHead(bindingId, after)

      // Phase 4 owns Message persistence. Nothing about the prompt or the reply is
      // written, logged or echoed here; the terminal outcome is the whole result.
      respond(200, {
        turnId,
        outcome: 'completed',
        deliveryState: 'delivered',
        retryable: false,
        changed: false,
        revision: after,
        reason: null,
        reasonCopy: TURN_SENT_COPY,
      })
    } catch (error) {
      console.error(`[agent-session-bindings] turn failed: ${error instanceof Error ? error.message : error}`)
      if (deliveryAttempted) {
        // A bug in this route that happened AROUND a delivery is indistinguishable
        // from a delivery.
        if (claimedKey !== null) {
          guard.fence(claimedKey, 'native_target_fenced', {
            provider: fenceProvider,
            headBefore: preTurnHeadDigest,
            turnId,
            bindingId: null,
            now: Date.now(),
            // A bug in THIS route, not a provider outcome. Named rather than left
            // blank so a later reader can tell "the adapter reported nothing" apart
            // from "nobody recorded it". Any adapter evidence captured before the
            // throw is still carried.
            ...adapterEvidence,
            adapterReason: adapterEvidence.adapterReason ?? 'route_error',
            fenceSite: 'route_error',
            spawns: [...recordedPids],
          })
          // `head` is scoped to the try, so `preTurnHeadDigest` is hoisted to the
          // handler specifically to reach this site. It is null ONLY when the throw
          // happened before the head was read. An earlier version of this line
          // hardcoded `unavailable` and so contradicted the record it had just
          // written — an operator would read "no baseline" off a fence that has one.
          console.warn(`[agent-session-bindings] fence set site=route_error target=${opaqueRevision(claimedKey)} turnId=${turnId} headBefore=${preTurnHeadDigest ?? 'unavailable'} adapterReason=${adapterEvidence.adapterReason ?? 'route_error'} detail=${adapterEvidence.adapterDetail ?? 'none'} exitCode=${adapterEvidence.exitCode ?? 'null'} childReaped=${adapterEvidence.childReaped ?? 'unknown'} stderrClass=${adapterEvidence.stderrClass ?? 'none'} durationMs=${adapterEvidence.durationMs ?? 'unknown'} spawnCount=${recordedPids.length}`)
        }
        reportAmbiguous()
      } else {
        refuseTurn('turn_failed')
      }
    } finally {
      for (const { pid } of recordedPids) {
        try {
          ownership.release(pid)
        } catch (error) {
          console.error(`[agent-session-bindings] spawn release failed: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (pinnedBindingId !== null) {
        try {
          deps.bindings.unpin!(pinnedBindingId, turnId, readNow() ?? requestNow)
        } catch (error) {
          console.error(`[agent-session-bindings] unpin failed: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (claimedKey !== null) guard.release(claimedKey, turnId)
    }
  })

  /**
   * What happened to a queued turn.
   *
   * Reads the durable turn ledger, which is the same record the replay path serves,
   * so a poll and a retry can never disagree about what a turn did.
   *
   * Gated with the write routes: this reports on attached turns, and an install
   * that cannot make them has nothing to report on.
   */
  if (attachEnabled) router.get('/agent-sessions/bindings/:bindingId/turns/:clientTurnId', (req, res) => {
    res.set('Cache-Control', 'private, no-store')

    const bindingId = String(req.params.bindingId ?? '')
    const clientTurnId = String(req.params.clientTurnId ?? '')
    if (!BINDING_ID_RE.test(bindingId) || !CLIENT_TURN_ID_RE.test(clientTurnId)) {
      res.status(400).json({ outcome: 'invalid_request', reasonCopy: TURN_UNKNOWN_COPY })
      return
    }

    let entry: { result?: unknown } | null = null
    try {
      entry = deps.bindings.findTurn?.(bindingId, clientTurnId) ?? null
    } catch (error) {
      console.error(`[agent-session-bindings] turn status read failed: ${error instanceof Error ? error.message : error}`)
      // A ledger read that THREW is not a turn that did not happen. Reporting
      // `unknown` here would invite the retry that double-posts.
      res.status(503).json({ outcome: 'unavailable', reasonCopy: TURN_PENDING_COPY })
      return
    }

    if (entry === null) {
      // Genuinely absent. Admitted-and-running is indistinguishable from
      // never-admitted in the ledger alone, so this stays 404 and the copy avoids
      // asserting either.
      res.status(404).json({ outcome: 'unknown', reasonCopy: TURN_UNKNOWN_COPY })
      return
    }

    const stored = entry.result && typeof entry.result === 'object'
      ? entry.result as Record<string, unknown>
      : null
    if (stored === null) {
      res.status(200).json({ outcome: 'pending', reasonCopy: TURN_PENDING_COPY })
      return
    }
    // `status` is the ledger's record of the ORIGINAL response code and must not
    // become this poll's status — a refused turn reported correctly is a successful
    // read.
    // Surfaced under its own name rather than dropped: the code the turn actually
    // produced is exactly what a caller that missed the 202's eventual outcome
    // needs in order to react the way it would have to the original response.
    const { status: recorded, ...rest } = stored
    res.status(200).json({
      ...rest,
      recordedStatus: typeof recorded === 'number' ? recorded : null,
      polled: true,
    })
  })

  return router
}
