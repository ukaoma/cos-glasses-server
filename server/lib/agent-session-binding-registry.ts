// Durable storage for native thread bindings — the part `agent-session-binding-store.ts`
// deliberately does not have.
//
// That file holds the VALUE TYPE and its pure transitions, and says so in its own
// header: "there is no persistence here yet, and the durable per-target epoch
// high-water mark that the replay defense depends on does not exist." This file is
// that missing half. Without it, three things are lost on every restart:
//
//   1. `pinnedJobs` — so a job running across a restart no longer holds its lease.
//   2. The lease itself — so an attached Chat silently becomes unattached.
//   3. **The epoch.** This is the dangerous one.
//
// WHY THE EPOCH HIGH-WATER MARK IS THE WHOLE POINT OF THIS FILE.
//
// `createBinding` takes `priorEpoch` as an INPUT. If a caller reads that from the
// current in-memory binding, then after detach + eviction (or a restart) the next
// attach to the same target restarts at epoch 1. The prompt queue is CLIENT-owned:
// up to five prompts can sit on the phone holding no server state. A row composed
// against the FIRST attach at epoch 1 then matches the SECOND attach exactly, and
// executes against a conversation the user never intended. The epoch exists to make
// that row rejectable by value, and it can only do that if the floor is durable and
// monotonic. So `epochHighWater` is written on every create, is folded upward from
// every surviving binding at hydration, is NEVER removed by reaping, and never
// decreases. A binding is disposable state; its epoch floor is not.
//
// THE HYDRATION RULE, WHICH IS THE FAIL-CLOSED DECISION THAT MATTERS.
//
// "I could not read the store" is NOT "the store is empty". Starting empty at epoch
// 0 after a corrupt or unreadable file reopens exactly the replay window above, and
// does it silently. So:
//
//   file absent          -> `fresh`.    First boot. The only permissive outcome, and
//                                       it is permissive because there is positive
//                                       evidence nothing was ever written.
//   file unreadable      -> `degraded`. Distinct reason from corrupt: one is a
//   file unparseable     -> `degraded`  permission/IO fault, the other is content.
//   unknown version      -> `degraded`. A newer writer owns this file; clobbering it
//                                       would destroy epoch floors we cannot read.
//   epoch ledger invalid -> `degraded`. The anti-replay state itself is untrustworthy.
//   two blocking owners  -> `degraded`. The one-writer-per-target invariant is broken.
//
// A degraded registry refuses EVERY mutation and resolves EVERY lookup to nothing.
// It is not a soft warning; nothing attaches and nothing runs until a human resolves
// it. And degradation is deliberately STICKY — this file does NOT quarantine the bad
// file the way `loadJsonOrQuarantine` does, because renaming it away would make the
// very next boot read `fresh` and restart at epoch 0. A boot loop into the replay
// window is worse than a hard stop. Recovery is an explicit operator action, and the
// operator needs to understand that moving the file aside resets the floors.
//
// A single malformed RECORD is different and is dropped rather than degrading: its
// epoch contribution is already covered by the ledger (both are written in the same
// atomic commit), so dropping it loses a lease — which fails closed, every prompt
// naming it gets `unknown_binding` — without lowering any floor. That distinction is
// the reason the ledger is a separate top-level field instead of being derived from
// the records at read time.
//
// NOT USED: `loadJsonOrQuarantine` from atomic-fs. It collapses an unreadable file
// into `{status:'missing'}` (see its `readFileSync` catch), which is precisely the
// fail-open this module exists to prevent. Its WRITE half is mandatory and is used.
//
// CONCURRENCY. Callers never hand a `NativeBinding` back in. Every mutator takes a
// `bindingId` and re-reads the authoritative record at call time, so the classic
// read-modify-write loss — two pins computed from the same stale snapshot, one
// silently overwriting the other — is unrepresentable through this API. Every
// mutation body is fully synchronous with no `await` and no user callback before the
// commit, so within this single-threaded process a mutation cannot interleave with
// another. A re-entrancy latch backs that up for the one place user code DOES run
// inside a mutation (`onWarn`) and for any future refactor that introduces an await.
// Returned bindings are frozen, so a caller cannot mutate one and hope it sticks.

import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { isValidNativeThreadId } from './native-thread-id.js'
import {
  BINDING_ID_RE,
  activate as activateBinding,
  beginDetach as beginDetachBinding,
  boundToMarker,
  checkQueuedPrompt as checkQueuedPromptPure,
  createBinding,
  detach as detachBinding,
  forceDetach as forceDetachBinding,
  isBindableProvider,
  isExpired,
  isPinned,
  isTerminal,
  pin as pinBinding,
  renew as renewBinding,
  targetKey as makeTargetKey,
  unpin as unpinBinding,
  verifyBoundTo as verifyBoundToPure,
  type BindingRejection,
  type BindingState,
  type NativeBinding,
  type QueuedPromptClaim,
} from './agent-session-binding-store.js'

export const BINDING_STORE_VERSION = 1

/** Retained bindings, including terminal ones kept for reason reporting. */
export const DEFAULT_MAX_RETAINED_BINDINGS = 512

/**
 * Distinct targets whose epoch floor is remembered.
 *
 * At the cap a NEW target is REFUSED rather than evicted. Evicting a floor is the
 * one operation that can silently lower it, which is the replay bug. There is no
 * safe TTL either: a client-queued prompt can sit on a phone indefinitely, so no
 * age proves a floor is retired. Refusing is honest and loud; evicting is quiet
 * and wrong.
 */
export const DEFAULT_MAX_EPOCH_TARGETS = 10_000

/** Concurrent pins on one binding. Reaching this means a caller is leaking pins. */
export const DEFAULT_MAX_PINS_PER_BINDING = 64

/** How long a dead binding is retained so its rejection reason stays specific. */
export const DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * A pin older than this is treated as leaked.
 *
 * Must stay far above the provider deadline (21 min default) so a slow but live
 * job is never mistaken for a dead one.
 */
/**
 * Completed turns remembered per binding.
 *
 * Bounded because a binding is long-lived and the ledger is rewritten on every
 * commit. Oldest are dropped first, so the newest turn - the one a client is most
 * likely to retry - is the last to age out.
 */
export const MAX_TURNS_PER_BINDING = 64

/** A client turn id must be safe to use as a map key and to log. */
export const TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

export const DEFAULT_STALE_PIN_MS = 24 * 60 * 60 * 1000

/**
 * A job id becomes a JSON object key in this store's persisted `pinnedAt` map and
 * is logged. Bounded and conservative; real ids are `randomUUID()`.
 * Deliberately excludes `/` and a leading dot.
 */
export const PIN_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/

export type RegistryRejection =
  | BindingRejection
  | 'store_unavailable'
  | 'persist_failed'
  | 'reentrant_mutation'
  | 'target_busy'
  | 'binding_id_in_use'
  | 'invalid_job_id'
  | 'too_many_pins'
  | 'registry_full'
  | 'epoch_ledger_full'
  | 'caller_supplied_epoch'

export interface RegistryCheck {
  ok: boolean
  reason: RegistryRejection | null
}

export type RegistryResult =
  | { binding: NativeBinding; reason: null }
  | { binding: null; reason: RegistryRejection }

const noCheck = (reason: RegistryRejection): RegistryCheck => ({ ok: false, reason })
const reject = (reason: RegistryRejection): RegistryResult => ({ binding: null, reason })

export type HydrationStatus = 'fresh' | 'loaded' | 'degraded'

export type DegradedReason =
  | 'store_unreadable'
  | 'store_corrupt'
  | 'unsupported_version'
  | 'invalid_epoch_ledger'
  | 'duplicate_target'

export interface HydrationReport {
  /**
   * `fresh` and `loaded` are NOT the same answer and must not be collapsed.
   * `fresh` means the mechanism has never written here; `loaded` means it ran and
   * found what it found. A `fresh` report on a host that has been attaching for
   * weeks means the data directory moved, and the epoch floors moved with it.
   */
  status: HydrationStatus
  degradedReason: DegradedReason | null
  path: string
  loadedBindings: number
  /** Records rejected by validation. Non-zero deserves an alarm, not a shrug. */
  droppedRecords: number
  epochTargets: number
}

export interface BindingRecord {
  binding: NativeBinding
  createdAt: number
  updatedAt: number
  /** When the binding first reached a terminal state. */
  terminalAt: number | null
  /**
   * When a pin was last actually removed.
   *
   * Retention is measured from when a binding became INERT, not from when its TTL
   * lapsed, and those are different instants for a binding that was pinned across
   * its own expiry. Without this, a job that finishes an hour after the lease
   * expired would see its binding removed in the very next reap, and the client
   * whose queued row drains a second later gets `unknown_binding` instead of the
   * actionable `binding_expired`. Expiry fires no event, so the moment a binding
   * stops being claimed can only be reconstructed from the last unpin.
   */
  lastUnpinAt: number | null
  /**
   * Per-pin age, which `NativeBinding.pinnedJobs` cannot express.
   *
   * The value type's own header names the gap: a job that dies without unpinning
   * makes the binding immortal, and "this shape cannot express" a per-pin age. It
   * is carried HERE, in the registry's envelope, so the gap can be closed without
   * changing a type this module does not own.
   */
  pinnedAt: Readonly<Record<string, number>>
}

export interface ReapReport {
  removed: string[]
  pinsDropped: number
  retained: number
}

export interface CreateBindingRequest {
  bindingId: string
  cosSessionId: string
  provider: string
  nativeThreadId: string
  workspaceFingerprint: string
  sourceFingerprint: string
  nativeHeadAtAttach?: string | null
  ttlMs: number
  now: number
}

export interface BindingRegistryOptions {
  /** Defaults to `$COS_AGENT_BINDING_STORE_FILE` then `<DATA_DIR>/agent-session-bindings.json`. */
  filePath?: string
  onWarn?: (message: string, detail?: unknown) => void
  now?: number
  terminalRetentionMs?: number
  stalePinMs?: number
  maxRetainedBindings?: number
  maxEpochTargets?: number
  maxPinsPerBinding?: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveIntOption(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback
}

function nonNegativeMsOption(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback
}

/**
 * Parse a length-prefixed `targetKey` back into its parts, or null.
 *
 * The point is not decoding — nothing needs the parts. It is that a ledger KEY can
 * be checked for well-formedness at hydration, so a hand-edited or corrupted key
 * cannot quietly become a namespace of its own. A key only counts as well formed
 * when both halves round-trip AND both are values that could have produced it.
 */
export function parseTargetKey(key: unknown): { provider: string; threadId: string } | null {
  if (typeof key !== 'string' || key.length === 0) return null

  const firstColon = key.indexOf(':')
  if (firstColon <= 0) return null
  const providerLenRaw = key.slice(0, firstColon)
  if (!/^\d+$/.test(providerLenRaw)) return null
  const providerLen = Number(providerLenRaw)
  const provider = key.slice(firstColon + 1, firstColon + 1 + providerLen)
  if (provider.length !== providerLen) return null

  const afterProvider = key.slice(firstColon + 1 + providerLen)
  if (!afterProvider.startsWith(':')) return null
  const rest = afterProvider.slice(1)

  const secondColon = rest.indexOf(':')
  if (secondColon <= 0) return null
  const idLenRaw = rest.slice(0, secondColon)
  if (!/^\d+$/.test(idLenRaw)) return null
  const idLen = Number(idLenRaw)
  const threadId = rest.slice(secondColon + 1)
  if (threadId.length !== idLen) return null

  // A key that no legal (provider, threadId) pair could have produced is corrupt,
  // not merely unfamiliar.
  if (!isBindableProvider(provider) || !isValidNativeThreadId(threadId)) return null
  if (makeTargetKey(provider, threadId) !== key) return null

  return { provider, threadId }
}

const BINDING_STATES: readonly BindingState[] = ['staging', 'active', 'detaching', 'detached']

function freezeBinding(binding: NativeBinding): NativeBinding {
  const frozen: NativeBinding = {
    ...binding,
    pinnedJobs: Object.freeze([...binding.pinnedJobs]),
  }
  return Object.freeze(frozen)
}

/** Structural validation of one persisted binding. Anything unexpected is null. */
function validateBinding(value: unknown): NativeBinding | null {
  if (!isPlainObject(value)) return null

  const {
    bindingId, cosSessionId, provider, nativeThreadId, targetKey,
    workspaceFingerprint, sourceFingerprint, nativeHeadAtAttach,
    epoch, state, expiresAt, pinnedJobs,
  } = value

  if (typeof bindingId !== 'string' || !BINDING_ID_RE.test(bindingId)) return null
  if (typeof cosSessionId !== 'string') return null
  if (!isBindableProvider(provider)) return null
  if (!isValidNativeThreadId(nativeThreadId)) return null
  // The key is DERIVED, so a stored key that disagrees with its own parts is a
  // forged or corrupted row — it would alias a target the row does not name.
  if (typeof targetKey !== 'string' || targetKey !== makeTargetKey(provider, nativeThreadId)) return null
  if (typeof workspaceFingerprint !== 'string' || typeof sourceFingerprint !== 'string') return null
  if (nativeHeadAtAttach !== null && typeof nativeHeadAtAttach !== 'string') return null
  if (!Number.isInteger(epoch) || (epoch as number) < 1) return null
  if (typeof state !== 'string' || !BINDING_STATES.includes(state as BindingState)) return null
  if (!Number.isFinite(expiresAt)) return null
  if (!Array.isArray(pinnedJobs)) return null

  const pins: string[] = []
  for (const job of pinnedJobs) {
    if (typeof job !== 'string' || !PIN_JOB_ID_RE.test(job)) return null
    if (!pins.includes(job)) pins.push(job)
  }

  return freezeBinding({
    bindingId,
    cosSessionId,
    provider,
    nativeThreadId,
    targetKey,
    workspaceFingerprint,
    sourceFingerprint,
    nativeHeadAtAttach: (nativeHeadAtAttach ?? null) as string | null,
    epoch: epoch as number,
    state: state as BindingState,
    expiresAt: expiresAt as number,
    pinnedJobs: pins,
  })
}

export function defaultBindingStorePath(): string {
  const override = process.env.COS_AGENT_BINDING_STORE_FILE
  return resolve(override && override.trim().length > 0 ? override : dataPath('agent-session-bindings.json'))
}

interface LoadedState {
  records: Map<string, BindingRecord>
  targets: Map<string, string>
  floors: Map<string, number>
  /** bindingId -> completed turns, oldest first. See TURN LEDGER below. */
  turns: Map<string, TurnRecord[]>
}

/**
 * A turn that already reached a terminal state, remembered so a repeat of the same
 * client turn id replays the answer instead of delivering the prompt again.
 *
 * THE TURN LEDGER, and why it is durable. Measured on 2026-08-16: two byte-identical
 * POSTs both returned `completed`, and the user's real transcript ended up with TWO
 * copies of the turn. The client cannot tell "delivered, but the 200 was lost" from
 * "never arrived" — a dropped connection, a backgrounded phone, a proxy timeout all
 * look the same — so retrying is CORRECT client behavior, and the server is the only
 * side that can make it safe.
 *
 * It lives in the binding store rather than in memory because the same review found
 * the process-local fence re-opened on restart and delivered a second copy. Binding
 * records, epoch floors and pins were all durable; the one piece of state whose loss
 * writes twice into a human's conversation was not.
 */
export interface TurnRecord {
  /** Client-supplied idempotency key. */
  turnId: string
  /** The exact terminal response body, replayed verbatim on a repeat. */
  result: unknown
  /** Epoch ms, for bounded retention. */
  at: number
}

export class AgentSessionBindingRegistry {
  readonly path: string
  readonly hydration: HydrationReport

  private records: Map<string, BindingRecord>
  private targets: Map<string, string>
  private floors: Map<string, number>
  private turns: Map<string, TurnRecord[]>

  private readonly warn: (message: string, detail?: unknown) => void
  private readonly terminalRetentionMs: number
  private readonly stalePinMs: number
  private readonly maxRetainedBindings: number
  private readonly maxEpochTargets: number
  private readonly maxPinsPerBinding: number
  private mutating = false

  private constructor(path: string, hydration: HydrationReport, state: LoadedState, options: BindingRegistryOptions) {
    this.path = path
    this.hydration = Object.freeze(hydration)
    this.records = state.records
    this.targets = state.targets
    this.floors = state.floors
    this.turns = state.turns
    this.warn = options.onWarn ?? ((message, detail) => console.warn(`[binding-registry] ${message}`, detail ?? ''))
    this.terminalRetentionMs = nonNegativeMsOption(options.terminalRetentionMs, DEFAULT_TERMINAL_RETENTION_MS)
    this.stalePinMs = nonNegativeMsOption(options.stalePinMs, DEFAULT_STALE_PIN_MS)
    this.maxRetainedBindings = positiveIntOption(options.maxRetainedBindings, DEFAULT_MAX_RETAINED_BINDINGS)
    this.maxEpochTargets = positiveIntOption(options.maxEpochTargets, DEFAULT_MAX_EPOCH_TARGETS)
    this.maxPinsPerBinding = positiveIntOption(options.maxPinsPerBinding, DEFAULT_MAX_PINS_PER_BINDING)
  }

  /** Hydrate from disk. Never throws: an unusable store yields a degraded registry. */
  static open(options: BindingRegistryOptions = {}): AgentSessionBindingRegistry {
    const path = resolve(options.filePath ?? defaultBindingStorePath())
    const warn = options.onWarn ?? ((message: string, detail?: unknown) =>
      console.warn(`[binding-registry] ${message}`, detail ?? ''))
    const now = Number.isFinite(options.now) ? (options.now as number) : Date.now()

    const empty = (): LoadedState => ({ records: new Map(), targets: new Map(), floors: new Map(), turns: new Map() })
    const degraded = (reason: DegradedReason): AgentSessionBindingRegistry => {
      warn(
        `REFUSING ALL BINDINGS — durable store at ${path} is unusable (${reason}). ` +
        'The file is left in place on purpose: renaming it away would make the next boot ' +
        'look like a first boot and restart every epoch at 1, which re-opens the queued-prompt ' +
        'replay window. Resolve it deliberately.',
      )
      return new AgentSessionBindingRegistry(
        path,
        { status: 'degraded', degradedReason: reason, path, loadedBindings: 0, droppedRecords: 0, epochTargets: 0 },
        empty(),
        options,
      )
    }

    // `existsSync` collapses "definitely absent" with "cannot see it" — EACCES,
    // ELOOP, EIO, a dangling symlink. `fresh` is the ONLY permissive outcome, and
    // this file's header justifies it as "positive evidence nothing was ever
    // written"; existsSync is not that evidence. Measured: a dangling symlink at
    // the store path hydrated `fresh` with epochFloor 0 while the real floor on
    // disk was 9, and the next attach minted epoch 1 — so a prompt queued on the
    // phone from the earlier epoch-1 attach matches by value again. Only ENOENT
    // may mean fresh.
    let storeAbsent: boolean
    try {
      lstatSync(path)
      storeAbsent = false
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return degraded('store_unreadable')
      storeAbsent = true
    }
    if (storeAbsent) {
      return new AgentSessionBindingRegistry(
        path,
        { status: 'fresh', degradedReason: null, path, loadedBindings: 0, droppedRecords: 0, epochTargets: 0 },
        empty(),
        options,
      )
    }

    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (err) {
      // Distinct from corrupt on purpose. A permission or IO fault is an operator
      // problem with a different fix than bad content — and collapsing it into
      // "missing" is the exact fail-open in `loadJsonOrQuarantine`.
      warn(`store unreadable: ${path}`, err)
      return degraded('store_unreadable')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      warn(`store unparseable: ${path}`, err)
      return degraded('store_corrupt')
    }

    if (!isPlainObject(parsed)) return degraded('store_corrupt')
    const root: Record<string, unknown> = parsed
    if (root.version !== BINDING_STORE_VERSION) return degraded('unsupported_version')
    const rawRecords = root.records
    if (!Array.isArray(rawRecords)) return degraded('store_corrupt')
    const rawLedger = root.epochHighWater
    if (!isPlainObject(rawLedger)) return degraded('invalid_epoch_ledger')

    // The ledger is the anti-replay state itself. It is all-or-nothing: a single
    // entry we cannot trust means we cannot prove any floor, so partial acceptance
    // would be a guess dressed as a guarantee.
    const floors = new Map<string, number>()
    for (const [key, value] of Object.entries(rawLedger)) {
      if (parseTargetKey(key) === null) {
        warn(`epoch ledger holds a malformed target key: ${JSON.stringify(key).slice(0, 120)}`)
        return degraded('invalid_epoch_ledger')
      }
      if (!Number.isInteger(value) || (value as number) < 1) {
        warn(`epoch ledger holds a non-epoch value for a target`)
        return degraded('invalid_epoch_ledger')
      }
      floors.set(key, value as number)
    }

    const records = new Map<string, BindingRecord>()
    const targets = new Map<string, string>()
    // Optional by design: a store written before the ledger existed hydrates with
    // no turns and simply has no idempotency history yet, which is correct rather
    // than degraded. Every row is validated; a malformed one is DROPPED rather
    // than trusted, because a bad `result` would be replayed to a client verbatim.
    const turns = new Map<string, TurnRecord[]>()
    const rawTurns = (root as Record<string, unknown>).turns
    if (rawTurns && typeof rawTurns === 'object' && !Array.isArray(rawTurns)) {
      for (const [bindingId, rows] of Object.entries(rawTurns as Record<string, unknown>)) {
        if (!Array.isArray(rows)) continue
        const kept: TurnRecord[] = []
        for (const row of rows) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue
          const r = row as Record<string, unknown>
          if (typeof r.turnId !== 'string' || !TURN_ID_RE.test(r.turnId)) continue
          if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue
          if (r.result === undefined) continue
          kept.push({ turnId: r.turnId, result: r.result, at: r.at })
        }
        if (kept.length > 0) turns.set(bindingId, kept.slice(-MAX_TURNS_PER_BINDING))
      }
    }
    let dropped = 0

    for (const entry of rawRecords as unknown[]) {
      if (!isPlainObject(entry)) { dropped += 1; continue }
      const binding = validateBinding(entry.binding)
      if (!binding) { dropped += 1; continue }
      if (records.has(binding.bindingId)) { dropped += 1; continue }

      const createdAt = Number.isFinite(entry.createdAt) ? (entry.createdAt as number) : now
      const updatedAt = Number.isFinite(entry.updatedAt) ? (entry.updatedAt as number) : createdAt
      const terminalAt = Number.isFinite(entry.terminalAt)
        ? (entry.terminalAt as number)
        : (isTerminal(binding) ? updatedAt : null)

      // A pin whose age we cannot read is aged CONSERVATIVELY (as young as the
      // record's last write). Under-estimating a pin's age delays reaping it;
      // over-estimating would drop the lease out from under a live job.
      const pinnedAt: Record<string, number> = {}
      const storedPins = isPlainObject(entry.pinnedAt) ? entry.pinnedAt : {}
      for (const job of binding.pinnedJobs) {
        const at = storedPins[job]
        pinnedAt[job] = Number.isFinite(at) ? (at as number) : updatedAt
      }

      records.set(binding.bindingId, {
        binding,
        createdAt,
        updatedAt,
        terminalAt,
        lastUnpinAt: Number.isFinite(entry.lastUnpinAt) ? (entry.lastUnpinAt as number) : null,
        pinnedAt: Object.freeze(pinnedAt),
      })

      // Fold every surviving epoch upward. A record can only have been written
      // alongside its ledger entry, so this should be a no-op — but if the two ever
      // disagree, the HIGHER value is the only safe one.
      const floor = floors.get(binding.targetKey) ?? 0
      if (binding.epoch > floor) floors.set(binding.targetKey, binding.epoch)
    }

    for (const record of records.values()) {
      if (!blocksTarget(record.binding, now)) continue
      const held = targets.get(record.binding.targetKey)
      if (held !== undefined) {
        warn(`two live bindings claim one target: ${held} and ${record.binding.bindingId}`)
        return degraded('duplicate_target')
      }
      targets.set(record.binding.targetKey, record.binding.bindingId)
    }

    if (dropped > 0) {
      warn(
        `${dropped} binding record(s) failed validation and were dropped. Their leases are gone ` +
        '(every prompt naming one now rejects as unknown_binding), but their epoch floors are ' +
        'intact in the ledger, so no replay window opened.',
      )
    }

    return new AgentSessionBindingRegistry(
      path,
      {
        status: 'loaded',
        degradedReason: null,
        path,
        loadedBindings: records.size,
        droppedRecords: dropped,
        epochTargets: floors.size,
      },
      { records, targets, floors, turns },
      options,
    )
  }

  // ---------------------------------------------------------------- reads

  available(): boolean {
    return this.hydration.status !== 'degraded'
  }

  /** Why nothing works, or null when the registry is usable. */
  unavailableReason(): DegradedReason | null {
    return this.hydration.degradedReason
  }

  get(bindingId: unknown): NativeBinding | null {
    if (!this.available()) return null
    if (typeof bindingId !== 'string') return null
    return this.records.get(bindingId)?.binding ?? null
  }

  record(bindingId: unknown): BindingRecord | null {
    if (!this.available()) return null
    if (typeof bindingId !== 'string') return null
    return this.records.get(bindingId) ?? null
  }

  /**
   * The single binding currently holding a target, or null.
   *
   * "Holding" means it would block a new attach: pinned in any state, or
   * non-terminal and unexpired. An expired or fully detached binding is still
   * retrievable by id — so its rejection reason stays specific — but it no longer
   * owns the target.
   */
  getByTarget(targetKeyValue: unknown, now: number): NativeBinding | null {
    if (!this.available()) return null
    if (typeof targetKeyValue !== 'string') return null
    const id = this.targets.get(targetKeyValue)
    if (id === undefined) return null
    const record = this.records.get(id)
    if (!record) return null
    return blocksTarget(record.binding, now) ? record.binding : null
  }

  getByThread(provider: unknown, nativeThreadId: unknown, now: number): NativeBinding | null {
    if (!isBindableProvider(provider) || !isValidNativeThreadId(nativeThreadId)) return null
    return this.getByTarget(makeTargetKey(provider, nativeThreadId), now)
  }

  list(): NativeBinding[] {
    if (!this.available()) return []
    return [...this.records.values()].map(r => r.binding)
  }

  /**
   * Highest epoch ever issued for this target, from durable state.
   *
   * Null when the registry is degraded — the honest answer, and distinct from 0
   * ("never issued"). A caller must never read 0 out of a broken store.
   */
  epochFloor(targetKeyValue: unknown): number | null {
    if (!this.available()) return null
    if (typeof targetKeyValue !== 'string') return null
    return this.floors.get(targetKeyValue) ?? 0
  }

  /** Delegates to the pure gate, resolving the binding from durable state. */
  checkQueuedPrompt(claim: QueuedPromptClaim, now: number): RegistryCheck {
    if (!this.available()) return noCheck('store_unavailable')
    if (!isPlainObject(claim) || typeof claim.bindingId !== 'string') return noCheck('unknown_binding')
    return checkQueuedPromptPure(claim, this.records.get(claim.bindingId)?.binding ?? null, now)
  }

  verifyBoundTo(marker: unknown, bindingId: unknown, now: number): RegistryCheck {
    if (!this.available()) return noCheck('store_unavailable')
    return verifyBoundToPure(marker, this.get(bindingId), now)
  }

  /** The marker for a binding this registry actually holds. Null otherwise. */
  markerFor(bindingId: unknown): string | null {
    const binding = this.get(bindingId)
    return binding ? boundToMarker(binding) : null
  }

  // ------------------------------------------------------------- mutations

  /**
   * Attach.
   *
   * `priorEpoch` is NOT an input. It is read from the durable ledger, which is the
   * entire reason this method exists rather than callers using `createBinding`
   * directly. A caller that supplies one is refused outright rather than quietly
   * ignored, because supplying it is the bug.
   */
  create(input: CreateBindingRequest): RegistryResult {
    return this.runMutation(() => {
      if (!isPlainObject(input)) return reject('invalid_binding_id')
      if (Object.prototype.hasOwnProperty.call(input, 'priorEpoch')) {
        this.warn('create() rejected: the epoch comes from durable state, never from the caller')
        return reject('caller_supplied_epoch')
      }

      // Validated BEFORE the target key is computed. The key becomes a mutex key and
      // a ledger key; `SAFE_ID_RE` elsewhere in this repo permits ':' and '/', so an
      // unvalidated id could mint a whole namespace of its own.
      if (!isBindableProvider(input.provider)) return reject('invalid_provider')
      if (!isValidNativeThreadId(input.nativeThreadId)) return reject('invalid_thread_id')
      if (typeof input.bindingId !== 'string' || !BINDING_ID_RE.test(input.bindingId)) {
        return reject('invalid_binding_id')
      }
      if (this.records.has(input.bindingId)) return reject('binding_id_in_use')
      if (!Number.isFinite(input.now)) return reject('invalid_ttl')

      const now = input.now
      const key = makeTargetKey(input.provider, input.nativeThreadId)

      const holderId = this.targets.get(key)
      const holder = holderId === undefined ? undefined : this.records.get(holderId)
      if (holder && blocksTarget(holder.binding, now)) return reject('target_busy')

      const floor = this.floors.get(key) ?? 0
      if (!this.floors.has(key) && this.floors.size >= this.maxEpochTargets) {
        this.warn(`epoch ledger is full (${this.floors.size}); refusing a new target rather than evicting a floor`)
        return reject('epoch_ledger_full')
      }

      const created = createBinding({
        bindingId: input.bindingId,
        cosSessionId: input.cosSessionId,
        provider: input.provider,
        nativeThreadId: input.nativeThreadId,
        workspaceFingerprint: input.workspaceFingerprint,
        sourceFingerprint: input.sourceFingerprint,
        nativeHeadAtAttach: input.nativeHeadAtAttach ?? null,
        priorEpoch: floor,
        ttlMs: input.ttlMs,
        now,
      })
      if (!created.binding) return reject(created.reason)

      const binding = freezeBinding(created.binding)
      const records = new Map(this.records)
      const targets = new Map(this.targets)
      const floors = new Map(this.floors)

      // The stale holder keeps its record (so a queued prompt naming it still gets
      // `binding_expired` / `binding_detached` rather than `unknown_binding`) but
      // gives up the target.
      if (holderId !== undefined) targets.delete(key)

      if (records.size >= this.maxRetainedBindings) {
        const freed = evictOldestDisposable(records, targets, now, records.size - this.maxRetainedBindings + 1)
        if (freed <= 0 || records.size >= this.maxRetainedBindings) {
          this.warn(`registry is full at ${records.size} retained bindings and none are disposable`)
          return reject('registry_full')
        }
      }

      records.set(binding.bindingId, {
        binding,
        createdAt: now,
        updatedAt: now,
        terminalAt: null,
        lastUnpinAt: null,
        pinnedAt: Object.freeze({}),
      })
      targets.set(key, binding.bindingId)
      // Monotonic by construction: `epoch` is floor + 1.
      floors.set(key, Math.max(floor, binding.epoch))

      const failure = this.persist({ records, targets, floors, turns: new Map(this.turns) })
      return failure ? reject(failure) : { binding, reason: null }
    })
  }

  activate(bindingId: unknown, now: number): RegistryResult {
    return this.runMutation(() => {
      const found = this.requireRecord(bindingId)
      if ('reason' in found) return reject(found.reason)
      const { record } = found
      if (!Number.isFinite(now)) return reject('invalid_ttl')
      // Activating a lease that is already dead would publish a usable-looking
      // binding whose every subsequent check fails. Refuse at the transition.
      if (isExpired(record.binding, now)) return reject('binding_expired')

      const next = activateBinding(record.binding)
      if (!next.binding) return reject(next.reason ?? 'terminal_state')
      return this.commitBinding(record, next.binding, now)
    })
  }

  beginDetach(bindingId: unknown, now: number): RegistryResult {
    return this.runMutation(() => {
      const found = this.requireRecord(bindingId)
      if ('reason' in found) return reject(found.reason)
      return this.commitBinding(found.record, beginDetachBinding(found.record.binding), now)
    })
  }

  detach(bindingId: unknown, now: number): RegistryResult {
    return this.runMutation(() => {
      const found = this.requireRecord(bindingId)
      if ('reason' in found) return reject(found.reason)
      const next = detachBinding(found.record.binding)
      if (!next.binding) return reject(next.reason)
      return this.commitBinding(found.record, next.binding, now)
    })
  }

  forceDetach(bindingId: unknown, now: number): RegistryResult {
    return this.runMutation(() => {
      const found = this.requireRecord(bindingId)
      if ('reason' in found) return reject(found.reason)
      return this.commitBinding(found.record, forceDetachBinding(found.record.binding), now)
    })
  }

  renew(bindingId: unknown, ttlMs: number, now: number): RegistryResult {
    return this.runMutation(() => {
      const found = this.requireRecord(bindingId)
      if ('reason' in found) return reject(found.reason)
      return this.commitBinding(found.record, renewBinding(found.record.binding, ttlMs, now), now)
    })
  }

  /**
   * Pin a job to this binding so the TTL cannot expire it.
   *
   * CALLER CONTRACT: a rejection here is FATAL to the turn. An unpinned binding can
   * expire or be detached while the job runs, so a caller that proceeds anyway has
   * defeated the lease. Do not treat a failed pin as advisory.
   */
  pin(bindingId: unknown, jobId: unknown, now: number): RegistryResult {
    return this.runMutation(() => {
      const found = this.requireRecord(bindingId)
      if ('reason' in found) return reject(found.reason)
      const { record } = found
      if (typeof jobId !== 'string' || !PIN_JOB_ID_RE.test(jobId)) return reject('invalid_job_id')
      if (!Number.isFinite(now)) return reject('invalid_ttl')
      if (isTerminal(record.binding)) return reject('terminal_state')
      // Pinning an expired binding would resurrect it into permanent non-expiry.
      if (isExpired(record.binding, now)) return reject('binding_expired')

      if (record.binding.pinnedJobs.includes(jobId)) {
        return { binding: record.binding, reason: null } // idempotent
      }
      if (record.binding.pinnedJobs.length >= this.maxPinsPerBinding) {
        this.warn(`binding ${record.binding.bindingId} already holds ${record.binding.pinnedJobs.length} pins`)
        return reject('too_many_pins')
      }

      const next = pinBinding(record.binding, jobId)
      if (!next.pinnedJobs.includes(jobId)) return reject('terminal_state')
      return this.commitBinding(record, next, now, { pinnedAt: { ...record.pinnedAt, [jobId]: now } })
    })
  }

  unpin(bindingId: unknown, jobId: unknown, now: number): RegistryResult {
    return this.runMutation(() => {
      const found = this.requireRecord(bindingId)
      if ('reason' in found) return reject(found.reason)
      const { record } = found
      if (typeof jobId !== 'string' || !PIN_JOB_ID_RE.test(jobId)) return reject('invalid_job_id')

      const held = record.binding.pinnedJobs.includes(jobId)
      const next = unpinBinding(record.binding, jobId)
      const pinnedAt = { ...record.pinnedAt }
      delete pinnedAt[jobId]
      return this.commitBinding(record, next, now, {
        pinnedAt,
        // Only an actual release starts the inert clock. Unpinning a job that was
        // never pinned is a no-op and must not extend anything.
        lastUnpinAt: held && Number.isFinite(now) ? now : record.lastUnpinAt,
      })
    })
  }

  /**
   * Drop leaked pins, then remove bindings that are dead past their retention.
   *
   * A pinned binding NEVER expires and is never reaped — accepted or running work
   * outranks the TTL. The leak that follows from that is the known gap the value
   * type names: a job that dies without unpinning makes its binding immortal, and
   * an immortal `active` binding is a TTL that stopped meaning anything.
   *
   * The correction is deliberately minimal: drop only the pins that are provably
   * older than any possible live job and let the TTL take authority again. It does
   * NOT force-detach the binding, because a sibling pin may still be live, and
   * killing a lease under a running job is a worse failure than a late reap.
   */
  /**
   * Has this exact client turn already reached a terminal state on this binding?
   *
   * A hit means the prompt was ALREADY handed to the provider, so the caller must
   * replay this result instead of delivering again. Two byte-identical POSTs put
   * two copies of the turn into a real transcript before this existed.
   */
  findTurn(bindingId: unknown, turnId: unknown): TurnRecord | null {
    if (typeof bindingId !== 'string' || typeof turnId !== 'string') return null
    if (!TURN_ID_RE.test(turnId)) return null
    const rows = this.turns.get(bindingId)
    if (!rows) return null
    return rows.find(row => row.turnId === turnId) ?? null
  }

  /**
   * Remember a completed turn so a repeat replays rather than re-delivers.
   *
   * Records the FIRST result for a turn id and never overwrites it: a repeat must
   * see what the original turn actually did, not a later attempt's answer.
   */
  recordTurn(bindingId: unknown, turnId: unknown, result: unknown, now: number): RegistryResult {
    if (typeof bindingId !== 'string' || !this.records.has(bindingId)) return reject('unknown_binding')
    if (typeof turnId !== 'string' || !TURN_ID_RE.test(turnId)) return reject('invalid_job_id')
    if (result === undefined || !Number.isFinite(now)) return reject('invalid_job_id')

    return this.runMutation(() => {
      const binding = this.records.get(bindingId)!.binding
      const existing = this.turns.get(bindingId) ?? []
      // FIRST result wins, never overwritten: a repeat must see what the original
      // turn actually did, not a later attempt's answer.
      if (existing.some(row => row.turnId === turnId)) return { binding, reason: null }
      const turns = new Map(this.turns)
      turns.set(bindingId, [...existing, { turnId, result, at: now }].slice(-MAX_TURNS_PER_BINDING))
      const failure = this.persist({
        records: new Map(this.records),
        targets: new Map(this.targets),
        floors: new Map(this.floors),
        turns,
      })
      return failure ? reject(failure) : { binding, reason: null }
    })
  }

  reap(now: number): ReapReport {
    if (!this.available()) return { removed: [], pinsDropped: 0, retained: 0 }
    if (this.mutating) return { removed: [], pinsDropped: 0, retained: this.records.size }
    if (!Number.isFinite(now)) return { removed: [], pinsDropped: 0, retained: this.records.size }

    this.mutating = true
    try {
      const records = new Map<string, BindingRecord>()
      const removed: string[] = []
      let pinsDropped = 0
      let changed = false

      for (const [id, record] of this.records) {
        let current = record
        const stale = record.binding.pinnedJobs.filter(job => {
          const at = record.pinnedAt[job]
          return typeof at === 'number' && Number.isFinite(at) && now - at >= this.stalePinMs
        })
        if (stale.length > 0) {
          let binding = record.binding
          const pinnedAt = { ...record.pinnedAt }
          for (const job of stale) {
            binding = unpinBinding(binding, job)
            delete pinnedAt[job]
          }
          pinsDropped += stale.length
          changed = true
          current = {
            ...record,
            binding: freezeBinding(binding),
            updatedAt: now,
            pinnedAt: Object.freeze(pinnedAt),
            lastUnpinAt: now,
            terminalAt: record.terminalAt ?? (isTerminal(binding) ? now : null),
          }
          this.warn(
            `dropped ${stale.length} leaked pin(s) from binding ${id} — held longer than ` +
            `${this.stalePinMs}ms, far past any live job. The TTL governs it again.`,
          )
        }

        if (this.isDisposable(current, now)) {
          removed.push(id)
          changed = true
          continue
        }
        records.set(id, current)
      }

      if (!changed) return { removed: [], pinsDropped: 0, retained: this.records.size }

      const targets = new Map<string, string>()
      for (const record of records.values()) {
        if (blocksTarget(record.binding, now)) targets.set(record.binding.targetKey, record.binding.bindingId)
      }

      // Floors are carried forward untouched. Reaping a binding must never lower
      // the epoch its target has already reached — that is the replay window.
      // Turns are carried forward with their bindings; a reaped binding's turns
      // are dropped with it, since a replay of a turn on a removed binding could
      // never be answered anyway.
      const keptTurns = new Map([...this.turns].filter(([id]) => records.has(id)))
      const failure = this.persist({ records, targets, floors: new Map(this.floors), turns: keptTurns })
      if (failure) return { removed: [], pinsDropped: 0, retained: this.records.size }
      return { removed, pinsDropped, retained: records.size }
    } finally {
      this.mutating = false
    }
  }

  // ------------------------------------------------------------- internals

  /**
   * When did this binding stop claiming its target?
   *
   * Null while it still blocks. Otherwise the LATEST of the reasons it could have
   * become inert — terminal, expired, or released — because a binding pinned across
   * its own expiry only became inert at the release, and retention has to run from
   * there for the rejection reason to still be useful to the client.
   */
  private inertSince(record: BindingRecord, now: number): number | null {
    if (blocksTarget(record.binding, now)) return null
    let at = Number.NEGATIVE_INFINITY
    if (isTerminal(record.binding)) at = Math.max(at, record.terminalAt ?? record.updatedAt)
    if (isExpired(record.binding, now)) at = Math.max(at, record.binding.expiresAt)
    if (record.lastUnpinAt !== null) at = Math.max(at, record.lastUnpinAt)
    return Number.isFinite(at) ? at : record.updatedAt
  }

  private isDisposable(record: BindingRecord, now: number): boolean {
    const since = this.inertSince(record, now)
    return since !== null && now - since >= this.terminalRetentionMs
  }

  private requireRecord(bindingId: unknown): { record: BindingRecord } | { reason: RegistryRejection } {
    if (typeof bindingId !== 'string') return { reason: 'unknown_binding' }
    const record = this.records.get(bindingId)
    return record ? { record } : { reason: 'unknown_binding' }
  }

  private commitBinding(
    previous: BindingRecord,
    nextBinding: NativeBinding,
    now: number,
    patch: { pinnedAt?: Record<string, number>; lastUnpinAt?: number | null } = {},
  ): RegistryResult {
    const binding = freezeBinding(nextBinding)
    const pins = patch.pinnedAt ?? { ...previous.pinnedAt }
    // A state change that clears pins (forceDetach) is also a release.
    const cleared = previous.binding.pinnedJobs.length > 0 && binding.pinnedJobs.length === 0
    const lastUnpinAt = patch.lastUnpinAt !== undefined
      ? patch.lastUnpinAt
      : (cleared && Number.isFinite(now) ? now : previous.lastUnpinAt)

    const unchanged =
      binding.state === previous.binding.state &&
      binding.expiresAt === previous.binding.expiresAt &&
      binding.pinnedJobs.length === previous.binding.pinnedJobs.length &&
      binding.pinnedJobs.every((job, i) => job === previous.binding.pinnedJobs[i]) &&
      Object.keys(pins).length === Object.keys(previous.pinnedAt).length &&
      Object.keys(pins).every(job => pins[job] === previous.pinnedAt[job])
    if (unchanged) return { binding: previous.binding, reason: null }

    const records = new Map(this.records)
    records.set(binding.bindingId, {
      ...previous,
      binding,
      updatedAt: Number.isFinite(now) ? now : previous.updatedAt,
      terminalAt: previous.terminalAt ?? (isTerminal(binding) && Number.isFinite(now) ? now : previous.terminalAt),
      lastUnpinAt,
      pinnedAt: Object.freeze(pins),
    })

    const targets = new Map(this.targets)
    if (blocksTarget(binding, now)) targets.set(binding.targetKey, binding.bindingId)
    else if (targets.get(binding.targetKey) === binding.bindingId) targets.delete(binding.targetKey)

    const failure = this.persist({ records, targets, floors: new Map(this.floors), turns: new Map(this.turns) })
    return failure ? reject(failure) : { binding, reason: null }
  }

  /**
   * PERSIST THEN COMMIT.
   *
   * In-memory state is swapped only after the atomic write returns. A failed write
   * therefore leaves memory and disk agreeing on the OLD state instead of leaving a
   * lease that exists in this process and nowhere else — which after a restart would
   * be a silently vanished lease, or worse, a lost epoch bump.
   */
  private persist(next: LoadedState): RegistryRejection | null {
    // MERGE the on-disk epoch floor upward before writing.
    //
    // The floor is the anti-replay backstop and this file's header states it never
    // decreases. In-process that holds. It does NOT hold if anything else ever
    // writes this store: a second reader hydrates a snapshot, issues its own
    // epochs, and its next commit rewrites the whole file from a stale view —
    // measured in review, where a concurrent registry reissued epoch 1 and left the
    // on-disk floor BELOW an epoch already handed out.
    //
    // A second SERVER cannot happen: the instance lock is per-uid and global
    // (/tmp/cos-glasses-server-<uid>.lock), so bootstrap refuses one. But tooling
    // opening the store directly can, and did during review. This makes the floor
    // monotonic against any writer without introducing a lock, because max() of two
    // views is never lower than either.
    try {
      const onDisk = readFileSync(this.path, 'utf-8')
      const parsed: unknown = JSON.parse(onDisk)
      const ledger = (parsed as Record<string, unknown> | null)?.epochHighWater
      if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) {
        for (const [key, value] of Object.entries(ledger as Record<string, unknown>)) {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) continue
          const held = next.floors.get(key) ?? 0
          if (value > held) next.floors.set(key, value)
        }
      }
    } catch {
      // No store yet, or unreadable. Writing our own view is correct for the first
      // case, and for the second the alternative is refusing to persist at all,
      // which would strand a live binding over a stale file we cannot read anyway.
    }

    let json: string
    try {
      json = JSON.stringify({
        version: BINDING_STORE_VERSION,
        epochHighWater: Object.fromEntries([...next.floors.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))),
        // Additive at version 1: an older build ignores this key, a newer build
        // reads its absence as "no history yet". Neither direction corrupts.
        turns: Object.fromEntries([...next.turns.entries()].filter(([, rows]) => rows.length > 0)),
        records: [...next.records.values()].map(record => ({
          binding: record.binding,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          terminalAt: record.terminalAt,
          lastUnpinAt: record.lastUnpinAt,
          pinnedAt: record.pinnedAt,
        })),
      })
    } catch (err) {
      this.warn('refusing to commit: state did not serialize', err)
      return 'persist_failed'
    }

    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      durableAtomicWriteFileSync(this.path, json, { mode: 0o600 })
    } catch (err) {
      this.warn(`refusing to commit: durable write failed for ${this.path}`, err)
      return 'persist_failed'
    }

    this.records = next.records
    this.targets = next.targets
    this.floors = next.floors
    this.turns = next.turns
    return null
  }

  /**
   * The mutation latch.
   *
   * Bodies are synchronous, so two callers cannot interleave inside this process.
   * The one place user code runs mid-mutation is `onWarn`; if a handler re-enters,
   * it is refused rather than allowed to mutate a half-built state.
   */
  private runMutation(body: () => RegistryResult): RegistryResult {
    if (!this.available()) return reject('store_unavailable')
    if (this.mutating) return reject('reentrant_mutation')
    this.mutating = true
    try {
      return body()
    } finally {
      this.mutating = false
    }
  }
}

/**
 * Would this binding block a new attach to its target?
 *
 * Pinned in ANY state blocks, including `detaching` — a draining binding still has
 * a live job writing to that native thread, and letting a second binding attach
 * there is the two-writer hazard the whole feature exists to avoid.
 */
function blocksTarget(binding: NativeBinding, now: number): boolean {
  if (isPinned(binding)) return true
  if (isTerminal(binding)) return false
  return !isExpired(binding, now)
}

/** Evict retained-but-dead records, oldest first. Never touches a blocking one. */
function evictOldestDisposable(
  records: Map<string, BindingRecord>,
  targets: Map<string, string>,
  now: number,
  wanted: number,
): number {
  const candidates = [...records.values()]
    .filter(record => !blocksTarget(record.binding, now))
    .sort((a, b) => a.updatedAt - b.updatedAt)

  let freed = 0
  for (const record of candidates) {
    if (freed >= wanted) break
    records.delete(record.binding.bindingId)
    if (targets.get(record.binding.targetKey) === record.binding.bindingId) {
      targets.delete(record.binding.targetKey)
    }
    freed += 1
  }
  return freed
}
