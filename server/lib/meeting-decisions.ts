/**
 * Decision files: one per action, the only thing the pipeline reads (6.47.0, WS4).
 *
 * WHY ONE FILE PER ACTION (v3 blocker 12). The first design had the server and the pipeline
 * both writing `merge-decisions.json`. Two writers on one JSON file is a lost update waiting
 * for a slow disk, and neither side can tell afterwards which write survived. Here the
 * server writes `decisions/<actionId>.json` and nothing else touches it; the pipeline reads
 * it, does its work, and reports through stdout. The server then writes the report back into
 * the same file under `result`, so a later Revert can read what actually happened rather
 * than what was intended.
 *
 * WHY THE RENDERED CONTENT LIVES HERE AND NOT IN `.actions.json`. The patch holds transcript
 * text — the whole G2 capture, alternate transcripts. `.actions.json` is read on every
 * status poll and every list; putting megabytes of transcript in it would make a status call
 * cost a transcript read, and would put meeting content in a file whose purpose is
 * bookkeeping. The action record names the decision; the decision holds the content.
 *
 * MODE 0600 IN A 0700 DIRECTORY. These files contain meeting transcripts.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { importsRoot } from './imported-meeting-library.js'
import type { PipelinePatch } from './meeting-engine/render.js'
import { securePrivateDirectory } from './secure-user-config.js'

export const DECISIONS_DIR_NAME = 'decisions'
export const DECISION_SCHEMA = 1

/** The prefix the pipeline prints its one report line with. */
export const MERGE_RESULT_PREFIX = 'COS_MERGE_RESULT='

/**
 * Exit codes, as the pipeline command defines them (WS8b).
 *
 * 3 is NOT a failure. It means another pipeline process held the sync lock, which happens
 * every hour when the scheduled sync runs; the action stays `pending` and is retried.
 */
export const PIPELINE_EXIT_LOCK_BUSY = 3
/** The decision does not match the files on disk. Terminal: retrying cannot help. */
export const PIPELINE_EXIT_DECISION_INVALID = 4
/** A step failed part way, or the whole apply failed. Retried once. */
export const PIPELINE_EXIT_PARTIAL_OR_FAILED = 5

/** `a_` plus 16 hex. Enforced before the id reaches a path. */
export const ACTION_ID_PATTERN = /^a_[0-9a-f]{16}$/

export type MergeDecisionKind = 'merge' | 'split'

export interface MergeDecisionG2Input {
  kind: 'g2'
  sessionId: string
  /** Operations-relative path of the `.g2-chunks.json`. */
  sidecarRelPath: string
  /** Operations-relative path of the standalone G2 scribe, when one exists. */
  scribeRelPath?: string
  sha256: string
}

export interface MergeDecisionFirefliesInput {
  kind: 'fireflies'
  firefliesId: string
  /** Operations-relative path of the Fireflies scribe the patch is spliced into. */
  scribeRelPath: string
  /** Operations-relative path of its `.fireflies.json` sentences sidecar. */
  sidecarRelPath: string
  sha256: string
}

export type MergeDecisionInput = MergeDecisionG2Input | MergeDecisionFirefliesInput

export interface MergeDecisionResultOutput { path: string; sha256: string }
export interface MergeDecisionResultArchive { original: string; archive: string; sha256: string }
export interface MergeDecisionResultStamp { sidecar: string; blended_into: string }

export type MergePipelineStatus = 'applied' | 'reverted' | 'partial' | 'failed'

export interface MergePipelineResult {
  schema: number
  action_id: string
  status: MergePipelineStatus
  outputs: MergeDecisionResultOutput[]
  archived: MergeDecisionResultArchive[]
  retired: MergeDecisionResultArchive[]
  stamps: MergeDecisionResultStamp[]
  transcript_map: 'applied' | 'skipped'
  step?: string
  error_code?: string
}

export interface MergeDecision {
  schema: number
  actionId: string
  kind: MergeDecisionKind
  inputs: MergeDecisionInput[]
  patch: PipelinePatch
  speakerMap: PipelinePatch['speakerMap']
  /** Operations-relative G2 scribe paths the pipeline archives and removes. */
  retire: string[]
  /** Written back by the server after the pipeline reports. */
  result?: MergePipelineResult
}

export class DecisionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'DecisionError'
  }
}

export function assertActionId(actionId: string): string {
  if (!ACTION_ID_PATTERN.test(actionId)) {
    throw new DecisionError('Invalid action id', 'invalid_action_id')
  }
  return actionId
}

export function decisionsDir(root: string = importsRoot()): string {
  return join(root, DECISIONS_DIR_NAME)
}

export function decisionPath(actionId: string, root?: string): string {
  return join(decisionsDir(root), `${assertActionId(actionId)}.json`)
}

export function sha256OfFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Does this patch add anything at all?
 *
 * A patch with no sections, no rows and no markers is a decision the pipeline can apply
 * successfully while changing nothing: it archives the Fireflies scribe, retires the G2
 * standalone, writes the same bytes back, and reports `applied`. The capture disappears from
 * the list and nothing takes its place. That is the one outcome an additive design must not
 * be able to produce, and the cheapest place to make it impossible is the writer, which
 * every apply and every re-drive goes through.
 */
export function patchIsEmpty(patch: Pick<PipelinePatch, 'sections' | 'rows' | 'markers'> | null | undefined): boolean {
  if (!patch) return true
  return (patch.sections?.length ?? 0) === 0
    && (patch.rows?.length ?? 0) === 0
    && (patch.markers?.length ?? 0) === 0
}

/** Write one decision. The directory is created 0700 and the file 0600 every time. */
export function writeDecision(decision: MergeDecision, root?: string): string {
  if (patchIsEmpty(decision.patch)) {
    throw new DecisionError('A merge decision must add something to the scribe', 'patch_empty')
  }
  const path = decisionPath(decision.actionId, root)
  securePrivateDirectory(decisionsDir(root))
  durableAtomicWriteFileSync(path, `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600 })
  return path
}

export function readDecision(actionId: string, root?: string): MergeDecision | null {
  const path = decisionPath(actionId, root)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MergeDecision>
    if (parsed?.schema !== DECISION_SCHEMA || parsed.actionId !== actionId) return null
    return parsed as MergeDecision
  } catch {
    return null
  }
}

/**
 * Record what the pipeline reported, in the decision it was given.
 *
 * Revert reads this, not the action record: the archive paths and their sha256 are what let
 * a restore prove it is putting back the same bytes that were moved aside.
 */
export function writeDecisionResult(actionId: string, result: MergePipelineResult, root?: string): boolean {
  const decision = readDecision(actionId, root)
  if (!decision) return false
  writeDecision({ ...decision, result }, root)
  return true
}

export function deleteDecision(actionId: string, root?: string): void {
  try { unlinkSync(decisionPath(actionId, root)) } catch { /* already gone */ }
}

export function listDecisionIds(root?: string): string[] {
  try {
    return readdirSync(decisionsDir(root))
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(id => ACTION_ID_PATTERN.test(id))
      .sort()
  } catch {
    return []
  }
}

/**
 * Is this a report the server may act on?
 *
 * Deliberately strict about the three fields a Revert depends on and permissive about the
 * rest: a pipeline that grows a field must not make every apply unreadable, but one that
 * omits `archived` has not told us how to undo what it did.
 */
export function isMergePipelineResult(value: unknown): value is MergePipelineResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (row.schema !== DECISION_SCHEMA) return false
  if (typeof row.action_id !== 'string' || !ACTION_ID_PATTERN.test(row.action_id)) return false
  if (row.status !== 'applied' && row.status !== 'reverted' && row.status !== 'partial' && row.status !== 'failed') return false
  if (row.transcript_map !== 'applied' && row.transcript_map !== 'skipped') return false
  for (const key of ['outputs', 'archived', 'retired', 'stamps']) {
    if (!Array.isArray(row[key])) return false
  }
  return true
}
