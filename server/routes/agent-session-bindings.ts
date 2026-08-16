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
  isExpired,
  isPinned,
  isTerminal,
  targetKey,
  type BindableProvider,
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
  live_desktop_process:
    'Open on your Mac. COS will not write into a thread another app is holding. Fork it instead.',
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
 */
export function projectAttachability(verdict: Occupancy): AttachabilityBody {
  const owners = Array.isArray(verdict?.owners) ? verdict.owners : null
  const sound =
    verdict?.attachable === true &&
    verdict.reason === null &&
    owners !== null &&
    owners.every(owner => owner?.selfOwned === true)
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
    !!dirs &&
    typeof dirs.claudeSessionsDir === 'string' &&
    typeof dirs.codexLocksDir === 'string'
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

/**
 * The in-process half of plan 4.5 and 4.6: one COS turn per native target, and a
 * target that may already hold an undelivered turn stays shut.
 *
 * NOT DURABLE, AND THAT IS A STATED GAP. Plan 4.5 wants the reservation
 * persisted in the job journal and rehydrated on boot, and 4.6 item 3 wants the
 * fence to have its own lifecycle and an operator release path. Both belong to
 * Phase 2, which owns that journal. What lives here is the process-lifetime
 * version, which is enough to make the two properties true for a running server
 * and fails in the safe direction on restart: a claim is released (no turn is
 * running after a restart anyway) and a FENCE is lost, which is the one that
 * matters and is why it is called out rather than implied.
 */
class TargetGuard {
  /** targetKey -> turnId of the single COS turn allowed to be in flight. */
  private readonly claims = new Map<string, string>()
  /** targetKey -> why no further turn may be delivered. */
  private readonly fences = new Map<string, WriteRefusal>()
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

  fence(targetKey: string, reason: WriteRefusal): void {
    if (!this.fences.has(targetKey)) this.fences.set(targetKey, reason)
  }

  fencedReason(targetKey: string): WriteRefusal | null {
    return this.fences.get(targetKey) ?? null
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
  const guard = new TargetGuard()
  const ownership = deps?.ownership ?? { record: recordCosSpawn, release: releaseCosSpawn }
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
      if (fenced !== null) return refuseAttach(res, fenced)

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

  // ----------------------------------------------------------------- turns
  if (attachEnabled) router.post('/agent-sessions/bindings/:bindingId/turns', async (req, res) => {
    res.set('Cache-Control', 'private, no-store')

    const turnId = mintId()
    /** The target we hold a claim on, released in the finally. */
    let claimedKey: string | null = null
    /** Children the adapter reported, released in the finally. */
    const recordedPids: number[] = []
    let pinnedBindingId: string | null = null
    let requestNow = 0
    /**
     * Has the adapter been ENTERED? Everything after this point is ambiguous on
     * a throw; everything before it is provably undelivered.
     */
    let deliveryAttempted = false

    const respond = (status: number, payload: Record<string, unknown>): void => {
      if (!res.headersSent) res.status(status).json(payload)
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

      // The client-queued-prompt gate, used rather than reimplemented: it is the
      // one place that orders state before epoch before target, and a second
      // opinion here is how the store's own header says the two drifted apart.
      const gate = deps.bindings.checkQueuedPrompt!({ bindingId, epoch: epoch as number, targetKey: claimedTargetKey }, now)
      if (gate?.ok !== true) return refuseTurn(registryRefusal(gate?.reason))

      const binding = deps.bindings.get!(bindingId)
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
            recordedPids.push(pid)
            return true
          },
        })
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
        guard.fence(key, 'native_target_fenced')
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
        if (claimedKey !== null) guard.fence(claimedKey, 'native_target_fenced')
        reportAmbiguous()
      } else {
        refuseTurn('turn_failed')
      }
    } finally {
      for (const pid of recordedPids) {
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

  return router
}
