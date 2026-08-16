// GET /api/agent-sessions/:provider/:threadId/attachability
// GET /api/agent-sessions/bindings
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

import { Router } from 'express'
import {
  threadOccupancy,
  type Occupancy,
  type OccupancyDirs,
  type OccupancyProbes,
  type OccupancyReason,
} from '../lib/thread-occupancy.js'
import {
  BINDING_ID_RE,
  isBindableProvider,
  isExpired,
  isPinned,
  isTerminal,
  type BindingState,
  type NativeBinding,
} from '../lib/agent-session-binding-store.js'
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
}

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

export function createAgentSessionBindingsRouter(deps: AgentSessionBindingsDeps): Router {
  const router = Router()
  // Evaluated once at wiring time. Incomplete dependencies are a wiring bug, and
  // the safe response to a wiring bug is a route that refuses with a reason, not
  // a server that will not boot and not a route that guesses.
  const canDetect = occupancyDepsUsable(deps)
  const canListBindings = bindingDepsUsable(deps)
  const detect = deps?.occupancy ?? threadOccupancy

  router.get('/agent-sessions/:provider/:threadId/attachability', (req, res) => {
    // An occupancy verdict is a liveness answer with a lifetime of roughly now.
    // A cached `attachable: true` is indistinguishable from a stale one, which is
    // the whole failure this feature exists to prevent.
    res.set('Cache-Control', 'private, no-store')

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
    let verdict: Occupancy
    try {
      verdict = detect(
        String(req.params.provider ?? ''),
        String(req.params.threadId ?? ''),
        deps.probes,
        deps.dirs,
      )
    } catch (error) {
      // `threadOccupancy` already contains its own probe try/catch, so reaching
      // here means the detector itself threw. Logged without the thread id.
      console.error(`[agent-session-bindings] occupancy threw: ${error instanceof Error ? error.message : error}`)
      verdict = { attachable: false, owners: [], reason: 'probe_failed' }
    }
    res.json(projectAttachability(verdict))
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

  return router
}
