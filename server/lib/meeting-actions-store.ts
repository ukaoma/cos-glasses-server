/**
 * The four durable stores behind every merge action, and the one mutex that owns them
 * (6.47.0, WS4).
 *
 *   `.actions.json`        what the engine did, and how to undo it
 *   `.suggestions.json`    what it wants a person to decide
 *   `.tombstones.json`     input pairs a person has refused; automation never revisits them
 *   `.engine-status.json`  modes, runs, and the one-per-install first-run report
 *
 * ONE WRITER, ONE MUTEX. Five triggers feed the runner (an import page, two G2 finalization
 * paths, orphan recovery, a 30 s tick) and three routes mutate the same files from HTTP.
 * Read-modify-write on JSON from two of those at once loses one of them silently, which for
 * `.tombstones.json` means a merge a person explicitly refused quietly comes back. Every
 * mutation goes through `update()`, which serializes on one promise chain; nothing here
 * writes a store outside it.
 *
 * IDS ARE DERIVED, NEVER MINTED. An action's id is a hash of its kind and its sorted
 * canonical input ids, so the same merge proposed twice is the same id, and re-running the
 * engine over an unchanged backlog cannot fill the store with duplicates of one decision.
 *
 * CANONICAL IDS. A G2 recording is its `sessionId`; a Fireflies meeting is its vendor id.
 * The same two ids in both modes: an action recorded in imports mode and the same one in
 * apply mode have to be the same action, or a person who switches modes sees their history
 * duplicate itself.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { importsRoot } from './imported-meeting-library.js'
import type { MeetingEngineMode } from './meeting-engine-mode.js'
import { securePrivateDirectory } from './secure-user-config.js'

export const ACTIONS_FILENAME = '.actions.json'
export const SUGGESTIONS_FILENAME = '.suggestions.json'
export const TOMBSTONES_FILENAME = '.tombstones.json'
export const ENGINE_STATUS_FILENAME = '.engine-status.json'

/** Where a derived record is copied when Revert finds it edited since it was written. */
export const REVERTED_DIR_NAME = '.reverted'

export const STORE_SCHEMA = 1

/** Ceiling on remembered rows per store, oldest first. */
export const MAX_ACTIONS = 5_000
export const MAX_SUGGESTIONS = 5_000
export const MAX_TOMBSTONES = 5_000

export type ActionKind = 'merge' | 'split'
export type ActionTier = 'auto' | 'accepted_suggestion' | 'legacy_applied'
export type ActionState = 'pending' | 'applied' | 'failed' | 'revert_pending' | 'reverted'
/** Where the action's effect landed. `imports` writes records; `apply` drives the pipeline. */
export type ActionMode = 'imports' | 'apply'

export interface CanonicalInputs {
  /** G2 `sessionId`s. */
  sessionIds: string[]
  /** Fireflies vendor ids. */
  firefliesIds: string[]
}

export interface ActionOutput {
  /** Absolute path in imports mode; operations-relative in apply mode. */
  path: string
  /** `blended:<h16>` or `imported:fireflies:<h16>` in imports mode; absent in apply mode. */
  recordId?: string
  sidecarPath?: string
}

export interface MergeActionRecord {
  id: string
  kind: ActionKind
  tier: ActionTier
  inputs: CanonicalInputs
  /** The fingerprint key of the inputs when the action was decided. */
  fingerprints: string
  outputs: ActionOutput[]
  /** sha256 of each output's markdown, in `outputs` order. */
  outputSha256: string[]
  state: ActionState
  mode: ActionMode
  error?: string
  /** Epoch ms this action may next be driven. Set on a deferred pipeline apply. */
  nextAt?: number
  at: string
  /** Bounded, so a pipeline that keeps failing does not retry forever. */
  attempts?: number
  /** For a split, which piece this output is. */
  pieceIndex?: number
  /** The parent the pipeline already merged this into, on a `legacy_applied` row. */
  legacyParentPath?: string
}

export type SuggestionKind = 'merge' | 'would_merge' | 'split'
export type SuggestionState = 'open' | 'confirmed' | 'accepted' | 'dismissed'

export interface MergeSuggestionRecord {
  id: string
  kind: SuggestionKind
  inputs: CanonicalInputs
  fingerprints: string
  evidence: { K1: number; K2: number; spans?: Array<{ startS: number; endS: number }> }
  state: SuggestionState
  decidedAt?: string
  at: string
}

/** An unordered pair of canonical ids a person said do not belong together. */
export interface Tombstone {
  pair: [string, string]
  at: string
  /** The action or suggestion the refusal came from. */
  source?: string
}

export interface FirstRunReport {
  startedAt: string
  completedAt?: string
  mode: MeetingEngineMode
  scanned: number
  auto: number
  wouldMerge: number
  suggested: number
  none: number
  alreadyMerged: number
  deferredByCap: number
  errors: number
}

export interface EngineRunSummary {
  at: string
  mode: MeetingEngineMode
  trigger: string
  scanned: number
  auto: number
  suggested: number
  wouldMerge: number
  none: number
  alreadyMerged: number
  deferredByCap: number
  errors: number
  /** Why the run did nothing, when it did nothing. */
  skippedReason?: string
}

export interface EngineStatusFile {
  schema: number
  /** Epoch ms this install first ran the engine. The D14 advisory boundary. */
  engineInstalledAt?: number
  /** Epoch ms the mode last moved to `apply`. The D14 boundary in apply mode. */
  applyModeSince?: number
  firstRun?: FirstRunReport
  lastRun?: EngineRunSummary
  /** Last answer from `sync_meetings.py --merge-engine-status`, and when. */
  pipelineSees?: { mode: string; active: boolean; appliedActions: number } | null
  pipelineSeenAt?: number
}

export interface ActionsStoreFile {
  schema: number
  actions: MergeActionRecord[]
  suggestions: MergeSuggestionRecord[]
  tombstones: Tombstone[]
  status: EngineStatusFile
}

// ── Ids ───────────────────────────────────────────────────────────────────────

function hash16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/**
 * The canonical id list an action or suggestion hashes.
 *
 * Sorted, so the order the engine happened to visit inputs in cannot mint a second id for
 * one decision. Joined with a comma because a G2 session id may itself contain a colon
 * (`normalizeSessionId` allows it), and a separator that can appear inside a part is a
 * separator that can collide.
 */
export function canonicalIdList(inputs: CanonicalInputs): string[] {
  return [
    ...inputs.sessionIds.map(id => `g2:${id}`),
    ...inputs.firefliesIds.map(id => `ff:${id}`),
  ].sort()
}

export function actionIdFor(kind: string, inputs: CanonicalInputs): string {
  return `a_${hash16(`${kind}:${canonicalIdList(inputs).join(',')}`)}`
}

export function suggestionIdFor(kind: string, inputs: CanonicalInputs): string {
  return `s_${hash16(`${kind}:${canonicalIdList(inputs).join(',')}`)}`
}

// ── Tombstones ────────────────────────────────────────────────────────────────

/**
 * Every unordered pair in an input set.
 *
 * A tombstone is a PAIR and not a whole set, so that refusing "this capture is not that
 * meeting" also blocks the three-way merge that would have swept the same wrong pair in with
 * a second capture. Blocking only the exact set is how a refused merge comes back one
 * recording later.
 */
export function inputPairs(inputs: CanonicalInputs): Array<[string, string]> {
  const ids = canonicalIdList(inputs)
  // A set of ONE (a split of a single recording, a legacy adoption of a single capture) has
  // no pair, and an empty pair list is a set nothing can ever block. It is remembered as its
  // own self-pair instead, which blocks exactly the same single-input proposal and nothing
  // wider — refusing "split this recording" must not also refuse merging it.
  if (ids.length === 1) return [[ids[0], ids[0]]]
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]])
  }
  return pairs
}

export function pairKey(pair: readonly [string, string]): string {
  return [...pair].sort().join('|')
}

/** Does any pair in this input set carry a tombstone? */
export function isTombstoned(tombstones: readonly Tombstone[], inputs: CanonicalInputs): boolean {
  if (tombstones.length === 0) return false
  const blocked = new Set(tombstones.map(row => pairKey(row.pair)))
  return inputPairs(inputs).some(pair => blocked.has(pairKey(pair)))
}

// ── The store ─────────────────────────────────────────────────────────────────

export function emptyStore(): ActionsStoreFile {
  return { schema: STORE_SCHEMA, actions: [], suggestions: [], tombstones: [], status: { schema: STORE_SCHEMA } }
}

function readJsonArray<T>(path: string, key: string): T[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const rows = parsed?.[key]
    return Array.isArray(rows) ? (rows as T[]) : []
  } catch {
    // An unreadable store is an empty one for reading purposes. It is NOT emptied on
    // disk: the next write rewrites it, and until then the corrupt bytes stay for a
    // person to look at rather than being silently destroyed by the reader.
    return []
  }
}

/**
 * An async mutex. One chain, so a second caller waits for the first to finish rather than
 * interleaving with it.
 *
 * `run` never rejects the chain itself: a caller's failure is delivered to that caller and
 * the chain continues, because one failed update must not wedge every later one.
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Resolves when everything currently queued has finished. */
  idle(): Promise<unknown> {
    return this.tail
  }
}

export class MeetingActionsStore {
  readonly root: string
  private readonly mutex = new AsyncMutex()

  constructor(options: { root?: string } = {}) {
    this.root = options.root ?? importsRoot()
  }

  private path(filename: string): string {
    return join(this.root, filename)
  }

  actionsPath(): string { return this.path(ACTIONS_FILENAME) }
  suggestionsPath(): string { return this.path(SUGGESTIONS_FILENAME) }
  tombstonesPath(): string { return this.path(TOMBSTONES_FILENAME) }
  statusPath(): string { return this.path(ENGINE_STATUS_FILENAME) }
  revertedDir(): string { return this.path(REVERTED_DIR_NAME) }

  /** A consistent snapshot of all four files. Safe to call outside the mutex. */
  read(): ActionsStoreFile {
    const status = existsSync(this.statusPath())
      ? (() => {
          try {
            const parsed = JSON.parse(readFileSync(this.statusPath(), 'utf8')) as EngineStatusFile
            return parsed && typeof parsed === 'object' ? { ...parsed, schema: STORE_SCHEMA } : { schema: STORE_SCHEMA }
          } catch {
            return { schema: STORE_SCHEMA }
          }
        })()
      : { schema: STORE_SCHEMA }
    return {
      schema: STORE_SCHEMA,
      actions: readJsonArray<MergeActionRecord>(this.actionsPath(), 'actions'),
      suggestions: readJsonArray<MergeSuggestionRecord>(this.suggestionsPath(), 'suggestions'),
      tombstones: readJsonArray<Tombstone>(this.tombstonesPath(), 'tombstones'),
      status,
    }
  }

  /**
   * Read, mutate, write, all inside the mutex.
   *
   * The mutation runs on a snapshot the caller may edit freely; only the files whose rows
   * actually changed are rewritten, so a status poll does not rewrite the action log.
   */
  update<T>(mutate: (store: ActionsStoreFile) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const before = this.read()
      // A DEEP copy, not a spread. Almost every mutation here edits a row in place — an
      // action moving to `applied`, a suggestion to `dismissed` — and a shallow copy shares
      // those row objects with `before`, so the change check compares a value with itself,
      // finds no difference, and writes nothing. Under a spread the store could only ever
      // record rows being ADDED, and every state change was silently dropped.
      const working: ActionsStoreFile = structuredClone(before)
      const result = await mutate(working)
      securePrivateDirectory(this.root)
      this.writeIfChanged(this.actionsPath(), 'actions', before.actions, working.actions.slice(-MAX_ACTIONS))
      this.writeIfChanged(this.suggestionsPath(), 'suggestions', before.suggestions, working.suggestions.slice(-MAX_SUGGESTIONS))
      this.writeIfChanged(this.tombstonesPath(), 'tombstones', before.tombstones, working.tombstones.slice(-MAX_TOMBSTONES))
      const nextStatus = { ...working.status, schema: STORE_SCHEMA }
      if (JSON.stringify(before.status) !== JSON.stringify(nextStatus)) {
        durableAtomicWriteFileSync(this.statusPath(), `${JSON.stringify(nextStatus, null, 2)}\n`, { mode: 0o600 })
      }
      return result
    })
  }

  private writeIfChanged(path: string, key: string, before: unknown[], after: unknown[]): void {
    if (JSON.stringify(before) === JSON.stringify(after)) return
    durableAtomicWriteFileSync(path, `${JSON.stringify({ schema: STORE_SCHEMA, [key]: after }, null, 2)}\n`, { mode: 0o600 })
  }

  /** Resolves when every queued mutation has finished. Tests and shutdown use it. */
  idle(): Promise<unknown> {
    return this.mutex.idle()
  }
}

let store: MeetingActionsStore | null = null

export function getMeetingActionsStore(): MeetingActionsStore {
  store ??= new MeetingActionsStore()
  return store
}

/** Test seam: drop the process-wide store so a later getter rebuilds it. */
export function resetMeetingActionsStore(): void {
  store = null
}
