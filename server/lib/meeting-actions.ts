/**
 * The merge runner: one queue, every trigger, three modes (6.47.0, WS4).
 *
 * WHAT THIS OWNS. Deciding what the engine's scores MEAN, writing that decision down, and
 * being able to take it back. The engine (WS3) is pure and knows nothing about files; the
 * library (WS2) writes records but decides nothing. This is the layer in between, and it is
 * the only writer of `.actions.json`, `.suggestions.json`, `.tombstones.json`,
 * `.engine-status.json` and the decision files.
 *
 * ONE RUNNER, FIVE TRIGGERS. An import page sealing, a G2 recording finalizing (two paths),
 * an orphan recovering, and a 30 s tick that fires a full pass every six hours. All of them
 * enqueue onto one promise chain. Two engine passes racing would score the same backlog
 * twice and write two actions for one merge, and with a per-action cap they would each spend
 * the whole cap.
 *
 * IT NEVER BLOCKS LIVE CAPTURE (principle 7). The engine runs on a worker thread, and the
 * runner defers entirely while any meeting capture is active. Scoring a backlog is CPU-bound
 * over every capture against every transcript; on the main thread, during a meeting, that
 * competes with chunk writes and transcription.
 *
 * THREE MODES, ONE DECISION PROCEDURE:
 *
 *   imports  the server writes derived records into its own imports root
 *   advise   the server writes NOTHING outside the imports root; the auto tier becomes
 *            would-merge items for a person to look at
 *   apply    the server writes a decision file and the COS pipeline splices it into the
 *            operations tree, additively, archiving what it replaces
 *
 * D14, THE ADVISORY FIRST RUN. On every Mac, recordings that finished BEFORE the engine
 * arrived become suggestions rather than automatic merges. The tier rules were measured only
 * on recordings that already had a merge, so the backlog is precisely the population nobody
 * has measured. Automatic behaviour starts from the moment a person could have seen it.
 *
 * EVERY AUTOMATIC ACTION IS REVERSIBLE (principle 2), and a Revert leaves a tombstone, so
 * the next run cannot immediately redo what was just undone.
 */

import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { discoverMeetingDomains, resolveCosOperationsDir } from './cos-operations-meetings.js'
import {
  DECISION_SCHEMA,
  DecisionError,
  MERGE_RESULT_PREFIX,
  PIPELINE_EXIT_DECISION_INVALID,
  PIPELINE_EXIT_LOCK_BUSY,
  type MergeDecision,
  type MergeDecisionInput,
  type MergePipelineResult,
  deleteDecision,
  isMergePipelineResult,
  listDecisionIds,
  readDecision,
  sha256OfFile,
  writeDecision,
  writeDecisionResult,
} from './meeting-decisions.js'
import {
  type ImportedMeetingLibrary,
  getImportedMeetingLibrary,
  importHash,
  importRecordId,
  importsRoot,
  mergedHash,
  pieceHash,
} from './imported-meeting-library.js'
import {
  acquireMaintenanceWork,
  maintenanceAdmissionsOpen,
  maintenanceLifecycle,
  type MaintenanceWorkLease,
} from './maintenance-lifecycle.js'
import {
  type ActionDirection,
  type ActionMode,
  type ActionsStoreFile,
  type CanonicalInputs,
  type ClockBandStats,
  type EngineRunSummary,
  type HashCacheEntry,
  type MergeActionRecord,
  type MergeSuggestionRecord,
  type PipelineFailureDiagnostics,
  MAX_HASH_CACHE_ENTRIES,
  MeetingActionsStore,
  actionIdFor,
  directionOf,
  getMeetingActionsStore,
  inputPairs,
  isTombstoned,
  isWaitingState,
  pendingStateFor,
  suggestionIdFor,
} from './meeting-actions-store.js'
import {
  type MeetingEngineMacClass,
  type MeetingEngineMode,
  type MeetingEnginePipelineMode,
  meetingEngineIsPipelineMac,
  meetingEngineMode,
  meetingEngineModeDetail,
  writeMergeModeFile,
} from './meeting-engine-mode.js'
import type { FirefliesMeetingInput, FirefliesSentenceInput, G2RecordingInput } from './meeting-engine/evidence.js'
import type { MergeGroup, PairingResult } from './meeting-engine/pairing.js'
import type { SplitPlan } from './meeting-engine/split.js'
import { fingerprintKey, renderPipelinePatch, type DerivedInputFingerprint } from './meeting-engine/render.js'
import { type EngineRequest, type EngineResult, type EngineScoreResult, runEngineInWorker } from './meeting-engine/worker.js'
import { getMeetingStore } from './meeting-store.js'
import { type SuggestionWithSides, withSuggestionSides } from './meeting-suggestion-sides.js'
import { onCorrectionApplied } from './meeting-corrections.js'
import {
  type PipelineAttempt,
  parseResultLine,
  pipelinePath,
  runPipelineCommand,
  PIPELINE_DEFAULT_TIMEOUT_MS,
} from './pipeline-runner.js'

/**
 * How many automatic actions one run may take.
 *
 * COUNTED INSIDE THE RUNNER, not by the caller, because five triggers call it and a cap a
 * caller applies is a cap the other four do not. It exists so the first pass over a backlog
 * of hundreds is something a person can look at and revert, not a wall of changes.
 */
export const MAX_AUTO_ACTIONS_PER_RUN = 25

export const ENGINE_TICK_MS = 30_000
export const ENGINE_DUE_INTERVAL_MS = 6 * 60 * 60_000

/** A pipeline child that could not take the sync lock is retried after this. */
export const PIPELINE_LOCK_RETRY_MS = 2 * 60_000

/** One retry, then the action stays failed for a person to decide about. */
export const PIPELINE_MAX_ATTEMPTS = 2

/** `--merge-engine-status` is asked at most this often. */
export const PIPELINE_STATUS_CACHE_MS = 5 * 60_000

/** Engine work above this many inputs is refused rather than run; nothing hangs silently. */
export const ENGINE_MAX_INPUTS = 5_000

export class ActionRefusedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ActionRefusedError'
  }
}

/** What a G2 recording's files say about itself, beyond what the engine scores. */
export interface G2InputMeta {
  /** Operations-relative `.g2-chunks.json`, in advise and apply mode. */
  sidecarRelPath?: string
  /** Operations-relative standalone scribe. */
  scribeRelPath?: string
  /** Absolute paths, for reading and for imports-mode reverts. */
  sidecarPath?: string
  scribePath?: string
  sha256?: string
  /** The pipeline already merged this capture into that scribe. */
  blendedInto?: string
  claimedParent?: string
  finalizedAtMs?: number
}

export interface FirefliesInputMeta {
  scribeRelPath?: string
  sidecarRelPath?: string
  scribePath?: string
  sha256?: string
  /** The scribe carries `<!-- g2-transcript-blended -->`. */
  blendedMarker?: boolean
  /** ...and a `<!-- merge-action: -->` marker, meaning THIS engine did it. */
  mergeActionId?: string
}

export interface EngineInputs {
  g2: G2RecordingInput[]
  fireflies: FirefliesMeetingInput[]
  g2Meta: Record<string, G2InputMeta>
  firefliesMeta: Record<string, FirefliesInputMeta>
  /** Inputs the collector refused, by reason code. Optional so a test fixture stays small. */
  skipped?: SkipCounts
}

export interface RunOutcome extends EngineRunSummary {
  actions: string[]
  suggestions: string[]
}

export interface MergeRunnerDeps {
  store?: MeetingActionsStore
  library?: ImportedMeetingLibrary
  mode?: () => MeetingEngineMode
  isPipelineMac?: () => boolean
  collectInputs?: (mode: MeetingEngineMode) => EngineInputs | Promise<EngineInputs>
  runEngine?: (request: EngineRequest) => Promise<EngineResult>
  acquireLease?: () => MaintenanceWorkLease
  admissionsOpen?: () => boolean
  /** True while a meeting is being captured. The runner defers entirely. */
  captureActive?: () => boolean
  /** Spawn one pipeline command. Null when this Mac has no pipeline. */
  spawnPipeline?: ((args: readonly string[], options: { actionId?: string }) => Promise<PipelineAttempt>) | null
  now?: () => number
  log?: (line: string) => void
}

// ── Reading the world ─────────────────────────────────────────────────────────

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
/** iCloud conflict copies ("x 2.g2-chunks.json"). Never an input. */
const ICLOUD_DUPLICATE = / \d+(\.[A-Za-z0-9-]+)*\.json$/
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024

/**
 * The only `.fireflies.json` shape this engine scores.
 *
 * `sidecar_version` exists because the first sidecars the pipeline wrote were built AFTER
 * `_clip_superset_bleed` rewrote `source_data['sentences']` in place, so they describe a
 * recording with a whole real meeting cut out of it. `clipped: true` says so outright.
 * Scoring either one pairs a capture against a transcript that is missing the very minutes
 * the capture covers, which reads as "no evidence" and silently loses the merge.
 */
export const FIREFLIES_SIDECAR_VERSION = 1

/**
 * Cap on a scribe read for its markers.
 *
 * `scribeMarkers` was the one unbounded read left in the collector: a whole operations scribe
 * into a string, per Fireflies meeting, per pass, to look for two comment markers. The
 * library's own markdown cap is 9 MiB, so nothing this engine wrote can reach this; what can
 * is a file that is no longer a scribe.
 */
export const MAX_SCRIBE_BYTES = 10 * 1024 * 1024

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > MAX_SIDECAR_BYTES) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Hashes a file, or answers from a cache when nothing about the file has moved. */
export type FileHasher = (path: string) => string | undefined

/** Counted refusals, so an input the engine never scored is never merely absent. */
export type SkipCounts = Record<string, number>

function countSkip(counts: SkipCounts, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Sentences in the shape the engine reads, from either sidecar.
 *
 * Two shapes exist and both are real: the server's own `.import.json` stores the client's
 * camelCase normalization, while the pipeline's `.fireflies.json` stores the vendor's raw
 * snake_case rows. Accepting both here is what lets one engine score both modes.
 */
export function toEngineSentences(rows: unknown): FirefliesSentenceInput[] {
  if (!Array.isArray(rows)) return []
  return rows.map(raw => {
    const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return {
      text: typeof row.text === 'string' ? row.text : '',
      speaker_name: typeof row.speaker_name === 'string'
        ? row.speaker_name
        : typeof row.speakerName === 'string' ? row.speakerName : '',
      start_time: numberOr(row.start_time, numberOr(row.startTime, 0)),
      end_time: numberOr(row.end_time, numberOr(row.endTime, 0)),
    }
  })
}

function g2FromSidecar(doc: Record<string, unknown>, sessionId: string): G2RecordingInput | null {
  const startMs = numberOr(doc.startTime, Number.NaN)
  const durationMs = numberOr(doc.durationMs, Number.NaN)
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs)) return null
  return {
    sessionId,
    startMs,
    durationMs,
    chunks: Array.isArray(doc.chunks) ? (doc.chunks as G2RecordingInput['chunks']) : [],
    batchSegments: Array.isArray(doc.batchSegments) ? (doc.batchSegments as G2RecordingInput['batchSegments']) : [],
    correctionRevision: typeof doc.correctionRevision === 'number' ? doc.correctionRevision : undefined,
    batchApplied: typeof doc.batchApplied === 'boolean' ? doc.batchApplied : undefined,
    title: typeof doc.title === 'string' ? doc.title : undefined,
    domain: typeof doc.domain === 'string' ? doc.domain : undefined,
    finalizedAtMs: startMs + Math.max(0, durationMs),
  }
}

/**
 * `<!-- g2-transcript-blended -->` and friends, from a scribe.
 *
 * BOUNDED, like `readJsonFile`. A file over `MAX_SCRIBE_BYTES` is not read at all and is
 * reported as `oversized`, which the collector turns into a counted refusal rather than a
 * silent `blended: false`. Answering "not blended" for a file nobody read would be worse
 * than refusing it: it is the answer that makes the engine propose merging it.
 */
export function scribeMarkers(path: string): { blended: boolean; mergeActionId?: string; oversized?: boolean } {
  try {
    if (statSync(path).size > MAX_SCRIBE_BYTES) return { blended: false, oversized: true }
    const text = readFileSync(path, 'utf8')
    const mergeAction = text.match(/<!--\s*merge-action:\s*(a_[0-9a-f]{16})\s*-->/)
    return {
      blended: text.includes('<!-- g2-transcript-blended -->'),
      ...(mergeAction ? { mergeActionId: mergeAction[1] } : {}),
    }
  } catch {
    return { blended: false }
  }
}

/** Every G2 recording and imported Fireflies meeting this Mac holds, in imports mode. */
function collectImportsModeInputs(library: ImportedMeetingLibrary, hash: FileHasher): EngineInputs {
  const inputs: EngineInputs & { skipped: SkipCounts } = { g2: [], fireflies: [], g2Meta: {}, firefliesMeta: {}, skipped: {} }
  const store = getMeetingStore()
  let months: string[] = []
  try {
    months = readdirSync(store.root).filter(name => MONTH_PATTERN.test(name)).sort().reverse()
  } catch {
    months = []
  }
  for (const month of months) {
    const monthDir = join(store.root, month)
    let names: string[] = []
    try { names = readdirSync(monthDir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.g2-chunks.json') || ICLOUD_DUPLICATE.test(name)) continue
      const path = join(monthDir, name)
      const doc = readJsonFile(path)
      const sessionId = typeof doc?.sessionId === 'string' ? doc.sessionId : null
      if (!doc || !sessionId) continue
      const recording = g2FromSidecar(doc, sessionId)
      if (!recording) continue
      const scribePath = path.replace(/\.g2-chunks\.json$/, '.md')
      inputs.g2.push(recording)
      inputs.g2Meta[sessionId] = {
        sidecarPath: path,
        ...(existsSync(scribePath) ? { scribePath } : {}),
        sha256: hash(path),
        finalizedAtMs: recording.finalizedAtMs,
        ...(typeof doc.blended_into === 'string' ? { blendedInto: doc.blended_into } : {}),
        ...(Array.isArray(doc.blended_into) && typeof doc.blended_into[0] === 'string' ? { blendedInto: doc.blended_into[0] as string } : {}),
        ...(typeof doc.claimed_parent === 'string' ? { claimedParent: doc.claimed_parent } : {}),
      }
    }
  }

  for (const row of library.list()) {
    if (row.librarySource !== 'imported') continue
    const sidecar = library.readSidecar(row.month, row.filename) as Record<string, unknown> | null
    const firefliesId = typeof sidecar?.firefliesId === 'string' ? sidecar.firefliesId : null
    if (!sidecar || !firefliesId) { countSkip(inputs.skipped, 'import_sidecar_unreadable'); continue }
    inputs.fireflies.push({
      id: firefliesId,
      startMs: numberOr(sidecar.dateMs, 0),
      durationS: numberOr(sidecar.durationSeconds, 0),
      sentences: toEngineSentences(sidecar.sentences),
      title: typeof sidecar.title === 'string' ? sidecar.title : undefined,
      participants: Array.isArray(sidecar.participants) ? (sidecar.participants as string[]) : [],
    })
    inputs.firefliesMeta[firefliesId] = {}
  }
  return inputs
}

/** The operations tree, in advise and apply mode. Read-only in both. */
function collectOperationsInputs(hash: FileHasher): EngineInputs {
  const inputs: EngineInputs & { skipped: SkipCounts } = { g2: [], fireflies: [], g2Meta: {}, firefliesMeta: {}, skipped: {} }
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return inputs

  for (const domain of discoverMeetingDomains(operationsDir)) {
    const base = join(operationsDir, domain, 'meetings')
    let months: string[] = []
    try { months = readdirSync(base).filter(name => MONTH_PATTERN.test(name)).sort().reverse() } catch { continue }
    for (const month of months) {
      const monthDir = join(base, month)
      let names: string[] = []
      try { names = readdirSync(monthDir) } catch { continue }
      for (const name of names) {
        if (ICLOUD_DUPLICATE.test(name)) continue
        const path = join(monthDir, name)

        if (name.endsWith('.g2-chunks.json')) {
          const doc = readJsonFile(path)
          const sessionId = typeof doc?.sessionId === 'string' ? doc.sessionId : null
          if (!doc || !sessionId || inputs.g2Meta[sessionId]) continue
          const recording = g2FromSidecar(doc, sessionId)
          if (!recording) continue
          const scribePath = path.replace(/\.g2-chunks\.json$/, '.md')
          inputs.g2.push(recording)
          const blendedInto = Array.isArray(doc.blended_into)
            ? (typeof doc.blended_into[0] === 'string' ? doc.blended_into[0] as string : undefined)
            : (typeof doc.blended_into === 'string' ? doc.blended_into : undefined)
          inputs.g2Meta[sessionId] = {
            sidecarPath: path,
            sidecarRelPath: relative(operationsDir, path),
            ...(existsSync(scribePath) ? { scribePath, scribeRelPath: relative(operationsDir, scribePath) } : {}),
            sha256: hash(path),
            finalizedAtMs: recording.finalizedAtMs,
            ...(blendedInto ? { blendedInto } : {}),
            ...(typeof doc.claimed_parent === 'string' ? { claimedParent: doc.claimed_parent } : {}),
          }
          continue
        }

        if (name.endsWith('.fireflies.json')) {
          const doc = readJsonFile(path)
          const firefliesId = typeof doc?.id === 'string' ? doc.id : null
          if (!doc || !firefliesId) { countSkip(inputs.skipped, 'fireflies_sidecar_unreadable'); continue }
          if (inputs.firefliesMeta[firefliesId]) continue
          // A sidecar written before the raw-snapshot fix holds the CLIPPED sentences: the
          // pipeline's de-bleed rewrites `source_data['sentences']` in place, so a sidecar
          // built after it describes a recording with a whole real meeting cut out. Scoring
          // one pairs a capture against a transcript missing the minutes that capture
          // covers, which reads as "no evidence" and loses the merge without saying so.
          if (doc.sidecar_version !== FIREFLIES_SIDECAR_VERSION) {
            countSkip(inputs.skipped, 'fireflies_sidecar_version')
            continue
          }
          if (doc.clipped === true) {
            countSkip(inputs.skipped, 'fireflies_sidecar_clipped')
            continue
          }
          const scribePath = path.replace(/\.fireflies\.json$/, '.md')
          const hasScribe = existsSync(scribePath)
          const markers = hasScribe ? scribeMarkers(scribePath) : { blended: false, oversized: false }
          if (markers.oversized) {
            // Nobody read this file, so nobody may say it is unblended. Refusing it keeps a
            // merge that already happened from being proposed a second time.
            countSkip(inputs.skipped, 'fireflies_scribe_oversized')
            continue
          }
          const durationMinutes = numberOr(doc.duration, 0)
          inputs.fireflies.push({
            id: firefliesId,
            startMs: numberOr(doc.date, 0),
            durationS: durationMinutes > 0 ? durationMinutes * 60 : 0,
            sentences: toEngineSentences(doc.sentences),
            title: typeof doc.title === 'string' ? doc.title : basename(scribePath, '.md'),
            participants: Array.isArray(doc.participants) ? (doc.participants as string[]) : [],
          })
          inputs.firefliesMeta[firefliesId] = {
            sidecarRelPath: relative(operationsDir, path),
            ...(hasScribe
              ? { scribePath, scribeRelPath: relative(operationsDir, scribePath), sha256: hash(scribePath) }
              : {}),
            blendedMarker: markers.blended,
            ...(markers.mergeActionId ? { mergeActionId: markers.mergeActionId } : {}),
          }
        }
      }
    }
  }
  return inputs
}

export function collectEngineInputs(
  mode: MeetingEngineMode,
  library: ImportedMeetingLibrary,
  hash: FileHasher = path => sha256OfFile(path) ?? undefined,
): EngineInputs {
  return mode === 'imports' ? collectImportsModeInputs(library, hash) : collectOperationsInputs(hash)
}

// ── Knowing whether anything changed, without reading anything ────────────────
//
// PRINCIPLE 7, THE HALF THAT IS NOT THE WORKER THREAD. The engine scores on a worker, but
// COLLECTING its inputs happened on the main thread and hashed every sidecar it found: on
// this Mac, 817 MB of `.g2-chunks.json` per pass. A pass fires on every G2 finalization,
// every import page, every orphan recovery and every six hours, and most of them have
// nothing new to look at.
//
// Two cheap answers, in order. First: has ANY input file moved since the last collected
// pass? That is a readdir plus a stat per file, no reads at all, and when the answer is no
// the pass does nothing but drive whatever the pipeline still owes. Second, when something
// did move: only the files whose mtime or size changed are re-read, because a sha256 is a
// pure function of bytes and the bytes are what mtime and size describe.

/** The directories a pass would read inputs from, without opening any of them. */
function inputDirectories(mode: MeetingEngineMode, library: ImportedMeetingLibrary): string[] {
  const directories: string[] = []
  if (mode === 'imports') {
    const store = getMeetingStore()
    for (const root of [store.root, library.root]) {
      try {
        for (const month of readdirSync(root)) {
          if (MONTH_PATTERN.test(month)) directories.push(join(root, month))
        }
      } catch { /* a root that is not there holds no inputs */ }
    }
    return directories
  }
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return directories
  for (const domain of discoverMeetingDomains(operationsDir)) {
    const base = join(operationsDir, domain, 'meetings')
    try {
      for (const month of readdirSync(base)) {
        if (MONTH_PATTERN.test(month)) directories.push(join(base, month))
      }
    } catch { /* a domain with no meetings dir holds no inputs */ }
  }
  return directories
}

/** True for the filenames a collector would open. */
function isEngineInputName(name: string): boolean {
  if (ICLOUD_DUPLICATE.test(name)) return false
  return name.endsWith('.g2-chunks.json') || name.endsWith('.fireflies.json') || name.endsWith('.import.json')
}

/**
 * The newest input mtime and how many inputs there are, from stats alone.
 *
 * COUNT AS WELL AS MTIME, because a DELETED file leaves every surviving mtime where it was.
 * Together they move for every change that can alter what a pass would decide.
 */
export function scanInputStamp(
  mode: MeetingEngineMode,
  library: ImportedMeetingLibrary,
): { newestMtimeMs: number; count: number } {
  let newestMtimeMs = 0
  let count = 0
  for (const directory of inputDirectories(mode, library)) {
    let names: string[]
    try { names = readdirSync(directory) } catch { continue }
    for (const name of names) {
      if (!isEngineInputName(name)) continue
      try {
        const stat = statSync(join(directory, name))
        count += 1
        if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs
      } catch { /* vanished between readdir and stat; the next pass sees it */ }
    }
  }
  return { newestMtimeMs, count }
}

// ── The runner ────────────────────────────────────────────────────────────────

function fingerprintsFor(
  inputs: CanonicalInputs,
  g2: Map<string, G2RecordingInput>,
  fireflies: Map<string, FirefliesMeetingInput>,
  g2Meta: Record<string, G2InputMeta>,
  firefliesMeta: Record<string, FirefliesInputMeta>,
): string {
  const rows: DerivedInputFingerprint[] = [
    ...inputs.sessionIds.map(id => ({
      kind: 'g2' as const,
      id,
      sha256: g2Meta[id]?.sha256 ?? null,
      correctionRevision: g2.get(id)?.correctionRevision,
      batchApplied: g2.get(id)?.batchApplied,
    })),
    ...inputs.firefliesIds.map(id => ({
      kind: 'fireflies' as const,
      id,
      sha256: firefliesMeta[id]?.sha256 ?? null,
    })),
  ]
  // Sentence count moves when a transcript is re-fetched even if no file hash exists,
  // so it is folded in for the imports-mode case where there is no scribe to hash.
  const counts = inputs.firefliesIds.map(id => `${id}:${fireflies.get(id)?.sentences.length ?? 0}`).sort().join(',')
  return createHash('sha256').update(`${fingerprintKey(rows)}|${counts}`).digest('hex')
}

function sortedInputs(sessionIds: string[], firefliesIds: string[]): CanonicalInputs {
  return { sessionIds: [...sessionIds].sort(), firefliesIds: [...firefliesIds].sort() }
}

/** The hash a Revert preview hands back, and the applying call has to hand in. */
export function revertPreviewHash(action: MergeActionRecord, currentSha256: Array<string | null>): string {
  return createHash('sha256')
    .update(JSON.stringify({
      id: action.id,
      state: action.state,
      mode: action.mode,
      outputs: action.outputs.map(output => output.path),
      recorded: action.outputSha256,
      current: currentSha256,
    }))
    .digest('hex')
}

export interface RevertPreview {
  actionId: string
  previewHash: string
  state: MergeActionRecord['state']
  mode: ActionMode
  outputs: string[]
  /** Outputs whose bytes changed since the action wrote them. Copied aside, not lost. */
  editedOutputs: string[]
  missingOutputs: string[]
}

export class MeetingMergeRunner {
  private readonly store: MeetingActionsStore
  private readonly library: ImportedMeetingLibrary
  private readonly mode: () => MeetingEngineMode
  private readonly modeDetailFn: (() => ReturnType<typeof meetingEngineModeDetail>) | null
  private readonly isPipelineMac: () => boolean
  private readonly collect: (mode: MeetingEngineMode) => EngineInputs | Promise<EngineInputs>
  /** True when the caller supplies inputs, which makes a filesystem scan meaningless. */
  private readonly collectInjected: boolean
  private readonly engine: (request: EngineRequest) => Promise<EngineResult>
  private readonly acquireLease: () => MaintenanceWorkLease
  private readonly admissionsOpen: () => boolean
  private readonly captureActive: () => boolean
  private readonly spawnPipeline: ((args: readonly string[], options: { actionId?: string }) => Promise<PipelineAttempt>) | null
  private readonly now: () => number
  private readonly log: (line: string) => void

  /** THE queue. Every trigger lands here; nothing runs two passes at once. */
  private chain: Promise<unknown> = Promise.resolve()
  private inFlight = 0
  private lastDueRunAt = 0

  /** sha256 by absolute path, loaded from `.engine-status.json` on the first collected pass. */
  private readonly hashCache = new Map<string, HashCacheEntry>()
  private hashCacheLoaded = false
  /** Paths this pass actually looked at. The cache is rewritten to exactly these. */
  private hashCacheSeen = new Set<string>()
  /** The scan stamp to record IF this pass finishes collecting; dropped if it does not. */
  private pendingInputScan: { newestMtimeMs: number; count: number; mode: MeetingEngineMode } | null = null
  /** Whether this pass actually read inputs, so a bailed pass does not wipe the cache. */
  private collectedThisPass = false
  /** One pass must collect even though nothing moved: a person asked for a retry. */
  private forceNextCollection = false
  /** Operations paths per Fireflies id, remembered from the last collected pass. */
  private firefliesPaths: Record<string, { sidecarRelPath?: string; scribeRelPath?: string }> | null = null
  /** A pass live meeting work turned away, owed to the first tick that finds the way clear. */
  private deferredTrigger: string | null = null

  constructor(deps: MergeRunnerDeps = {}) {
    this.store = deps.store ?? getMeetingActionsStore()
    this.library = deps.library ?? getImportedMeetingLibrary()
    this.mode = deps.mode ?? meetingEngineMode
    // Only the REAL predicate can report a Mac-class change, because only it reads the
    // file and the probe. A test that injects a mode gets a detail derived from that mode,
    // never a claim about a machine it is not describing.
    this.modeDetailFn = deps.mode ? null : meetingEngineModeDetail
    this.isPipelineMac = deps.isPipelineMac ?? meetingEngineIsPipelineMac
    // The change-scan and the hash cache both describe the FILESYSTEM the real collector
    // reads. A caller that supplies its own inputs is describing something else entirely, so
    // for it the scan would answer "nothing changed" about files it never looks at and every
    // pass after the first would do nothing.
    this.collectInjected = deps.collectInputs != null
    this.collect = deps.collectInputs
      ?? ((mode: MeetingEngineMode) => collectEngineInputs(mode, this.library, path => this.hashFor(path)))
    this.engine = deps.runEngine ?? (request => runEngineInWorker(request))
    this.acquireLease = deps.acquireLease ?? (() => acquireMaintenanceWork('meeting_merge'))
    this.admissionsOpen = deps.admissionsOpen ?? maintenanceAdmissionsOpen
    // PRINCIPLE 7, WIRED. This defaulted to `() => false`, which made "the engine never
    // blocks live capture" a claim no code enforced: the production constructor passed no
    // deps at all, so the only thing that ever deferred was a test. `recording_chunk` is the
    // lease every live chunk write takes, and `meeting_save` the one a capture's own save
    // holds, so between them they are the window where the CPU belongs to the meeting.
    this.captureActive = deps.captureActive ?? defaultCaptureActive
    this.spawnPipeline = deps.spawnPipeline === undefined ? defaultPipelineSpawn : deps.spawnPipeline
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((line: string) => console.log(`[meeting-merge] ${line}`))
  }

  // ── Hashing, once per changed file ──────────────────────────────────────────

  private loadHashCache(store: ActionsStoreFile): void {
    if (this.hashCacheLoaded) return
    this.hashCacheLoaded = true
    for (const [path, entry] of Object.entries(store.status.hashCache ?? {})) {
      if (entry && typeof entry.sha256 === 'string' && typeof entry.mtimeMs === 'number' && typeof entry.size === 'number') {
        this.hashCache.set(path, entry)
      }
    }
  }

  /**
   * This file's sha256, read only when the file itself has moved.
   *
   * mtime AND size, not mtime alone: a same-size rewrite within one filesystem timestamp tick
   * is exactly what an atomic replace of a sidecar looks like, and size is the cheap second
   * opinion. Both come from the `statSync` this function has to do anyway.
   */
  private hashFor(path: string): string | undefined {
    let stat
    try { stat = statSync(path) } catch { return undefined }
    this.hashCacheSeen.add(path)
    const cached = this.hashCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.sha256
    const sha256 = sha256OfFile(path)
    if (!sha256) return undefined
    this.hashCache.set(path, { sha256, mtimeMs: stat.mtimeMs, size: stat.size })
    return sha256
  }

  /** What the cache should be persisted as, pruned to what this pass saw. */
  private hashCacheSnapshot(): Record<string, HashCacheEntry> {
    const out: Record<string, HashCacheEntry> = {}
    let kept = 0
    for (const path of this.hashCacheSeen) {
      const entry = this.hashCache.get(path)
      if (!entry) continue
      if (kept >= MAX_HASH_CACHE_ENTRIES) break
      out[path] = entry
      kept += 1
    }
    return out
  }

  busy(): boolean {
    return this.inFlight > 0
  }

  /**
   * Every person-initiated mutation refuses during a committed drain.
   *
   * These routes are `lifecycleOwned` in `index.ts` — they do NOT take the global request
   * lease, because in apply mode one of them holds a 75 s pipeline spawn and the global
   * lease would push a drain past COS Control's 90 s timeout. That exemption is exactly why
   * the refusal has to live here: without it, a mutation admitted during a drain would be
   * silently deferred and answer as though it had happened.
   */
  private assertAdmissions(): void {
    if (!this.admissionsOpen()) {
      throw new ActionRefusedError(
        409,
        'maintenance_drain_active',
        'The server is finishing a maintenance operation. Try again shortly.',
      )
    }
  }

  /** Resolves when everything queued has finished. */
  idle(): Promise<unknown> {
    return this.chain.then(() => this.store.idle())
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight += 1
    const result = this.chain.then(work, work).finally(() => { this.inFlight -= 1 })
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  /** Every trigger calls this. Failures are logged, never thrown at the trigger. */
  trigger(reason: string): void {
    void this.run(reason).catch(error => this.log(`run (${reason}) failed: ${describe(error)}`))
  }

  run(trigger: string): Promise<RunOutcome> {
    return this.enqueue(() => this.execute(trigger))
  }

  /** The 30 s tick: drive waiting pipeline work, and run a full pass every six hours. */
  tick(): { fired: boolean; reason?: string } {
    if (!this.admissionsOpen()) return { fired: false, reason: 'admissions_closed' }
    if (this.busy()) return { fired: false, reason: 'run_in_progress' }
    const now = this.now()
    // BOTH waiting states. `revert_pending` was missing here and in `drivePending`, so an
    // Undo deferred by the sync lock or by a drain sat untouched until the server restarted:
    // the action stayed `revert_pending`, `setMode` refused because something was in flight,
    // and Control showed no way out of it.
    const hasDue = this.store.read().actions.some(action =>
      isWaitingState(action.state) && (action.nextAt ?? 0) <= now)
    if (hasDue) {
      this.trigger('pending_retry')
      return { fired: true, reason: 'pending_retry' }
    }
    // A pass live meeting work turned away (QA round 2). While that work still runs, firing it
    // would only defer again, and so would a due run, so both wait. Once the work is done the
    // owed pass runs under its own trigger, rather than six hours later.
    if (this.deferredTrigger) {
      if (this.captureActive()) return { fired: false, reason: 'capture_active' }
      const owed = this.deferredTrigger
      this.deferredTrigger = null
      this.trigger(owed)
      return { fired: true, reason: 'deferred_pass' }
    }
    if (now - this.lastDueRunAt < ENGINE_DUE_INTERVAL_MS) return { fired: false, reason: 'not_due' }
    this.lastDueRunAt = now
    this.trigger('tick')
    return { fired: true, reason: 'due' }
  }

  /**
   * A speaker mutation landed on a G2 session. Re-derive, do not re-decide.
   *
   * A relabel changes the NAMES on a merged record, not whether the merge was right, so this
   * must never take a new action or surface a new suggestion. It re-runs the render for the
   * actions that already hold this session and rewrites them only if the bytes differ.
   */
  rederive(sessionId: string): Promise<{ rewritten: number }> {
    return this.enqueue(async () => {
      const affected = this.store.read().actions.filter(action =>
        action.state === 'applied' && action.mode === 'imports' && action.inputs.sessionIds.includes(sessionId))
      if (affected.length === 0) return { rewritten: 0 }
      const outcome = await this.execute('rederive', { rederiveOnly: affected.map(action => action.id) })
      return { rewritten: outcome.auto }
    })
  }

  // ── The pass ────────────────────────────────────────────────────────────────

  private async execute(trigger: string, options: { rederiveOnly?: string[] } = {}): Promise<RunOutcome> {
    const mode = this.mode()
    const startedAt = this.now()
    this.hashCacheSeen = new Set<string>()
    this.pendingInputScan = null
    this.collectedThisPass = false
    const summary: RunOutcome = {
      at: new Date(startedAt).toISOString(),
      mode,
      trigger,
      scanned: 0,
      auto: 0,
      suggested: 0,
      wouldMerge: 0,
      none: 0,
      alreadyMerged: 0,
      deferredByCap: 0,
      errors: 0,
      actions: [],
      suggestions: [],
    }

    if (!this.admissionsOpen()) return await this.finishRun({ ...summary, skippedReason: 'maintenance_deferred' })
    // Principle 7. Live meeting work owns the CPU; the backlog can wait 30 seconds. The pass is
    // REMEMBERED, so the tick runs it once that work is done.
    if (this.captureActive()) {
      this.deferredTrigger = trigger
      return await this.finishRun({ ...summary, skippedReason: 'capture_active' })
    }
    // This pass is running now, and every pass is a full pass, so nothing is owed any more.
    this.deferredTrigger = null

    const before = this.store.read()
    this.loadHashCache(before)

    // Waiting pipeline work is driven whatever else this pass decides, INCLUDING on a pass
    // that bails: an apply or an Undo the pipeline still owes must not be held hostage to
    // whether any input file happens to have changed.
    const drivePending = before.actions.filter(action =>
      isWaitingState(action.state) && (action.nextAt ?? 0) <= startedAt)

    // Nothing moved since the last collected pass, so there is nothing to collect. This is
    // the common case on every trigger and it costs one stat per input file.
    const forced = this.forceNextCollection
    this.forceNextCollection = false
    if (!options.rederiveOnly && !this.collectInjected) {
      const stamp = scanInputStamp(mode, this.library)
      const last = before.status.lastInputScan
      if (!forced && last && last.mode === mode && last.newestMtimeMs === stamp.newestMtimeMs && last.count === stamp.count) {
        for (const action of drivePending) {
          const driven = await this.driveWaitingAction(action.id)
          if (!driven.ok) summary.errors += 1
        }
        return await this.finishRun({ ...summary, skippedReason: 'inputs_unchanged' })
      }
      this.pendingInputScan = { ...stamp, mode }
    }

    let inputs: EngineInputs
    try {
      inputs = await this.collect(mode)
    } catch (error) {
      this.log(`input collection failed: ${describe(error)}`)
      this.pendingInputScan = null
      return await this.finishRun({ ...summary, errors: 1, skippedReason: 'inputs_unreadable' })
    }
    this.collectedThisPass = true
    this.rememberFirefliesPaths(inputs)
    if (inputs.skipped && Object.keys(inputs.skipped).length > 0) summary.inputsSkipped = inputs.skipped
    if (inputs.g2.length + inputs.fireflies.length > ENGINE_MAX_INPUTS) {
      return await this.finishRun({ ...summary, skippedReason: 'too_many_inputs' })
    }
    // Anything the pipeline already merged is adopted once and never scored again
    // (v3 blocker 5). Without this the engine re-proposes every merge a person already has.
    const adopted = await this.adoptLegacy(inputs, before)
    summary.alreadyMerged = adopted.size

    const g2ById = new Map(inputs.g2.map(row => [row.sessionId, row]))
    const firefliesById = new Map(inputs.fireflies.map(row => [row.id, row]))

    const scoreable = {
      g2: inputs.g2.filter(row => !adopted.has(`g2:${row.sessionId}`)),
      fireflies: inputs.fireflies.filter(row => !adopted.has(`ff:${row.id}`)),
    }
    summary.scanned = scoreable.g2.length

    let score: EngineScoreResult | null = null
    if (!options.rederiveOnly && scoreable.g2.length > 0 && scoreable.fireflies.length > 0) {
      try {
        const result = await this.engine({ kind: 'score', g2: scoreable.g2, fireflies: scoreable.fireflies })
        if (result.kind !== 'score') throw new Error(`engine returned ${result.kind}`)
        score = result
      } catch (error) {
        this.log(`engine failed: ${describe(error)}`)
        summary.errors += 1
      }
    }

    const boundary = this.advisoryBoundary(mode, before)
    let autoTaken = 0

    if (score) {
      summary.none = score.tierCounts.none
      summary.clockBand = clockBandStatsOf(score.pairings, g2ById, firefliesById)

      for (const group of score.groups) {
        const canonical = sortedInputs(group.sessionIds, [group.primaryFirefliesId, ...group.alternateFirefliesIds])
        const fingerprints = fingerprintsFor(canonical, g2ById, firefliesById, inputs.g2Meta, inputs.firefliesMeta)
        const decision = this.classify(canonical, fingerprints, mode, boundary, inputs, before)
        if (decision === 'skip') continue
        if (decision === 'suggest' || decision === 'would_merge') {
          const id = await this.upsertSuggestion({
            kind: decision === 'would_merge' ? 'would_merge' : 'merge',
            inputs: canonical,
            fingerprints,
            evidence: { K1: group.k1, K2: group.k2 },
          })
          if (id) {
            summary.suggestions.push(id)
            if (decision === 'would_merge') summary.wouldMerge += 1
            else summary.suggested += 1
          }
          continue
        }
        if (autoTaken >= MAX_AUTO_ACTIONS_PER_RUN) { summary.deferredByCap += 1; continue }
        autoTaken += 1
        const taken = await this.takeMergeAction({
          canonical,
          fingerprints,
          tier: 'auto',
          mode,
          group,
          inputs,
          g2ById,
          firefliesById,
        })
        if (taken.ok) { summary.auto += 1; summary.actions.push(taken.id) } else summary.errors += 1
      }

      for (const suggestion of score.suggestions) {
        const canonical = sortedInputs(suggestion.sessionIds, suggestion.firefliesIds)
        if (isTombstoned(before.tombstones, canonical)) continue
        const fingerprints = fingerprintsFor(canonical, g2ById, firefliesById, inputs.g2Meta, inputs.firefliesMeta)
        const id = await this.upsertSuggestion({ kind: 'merge', inputs: canonical, fingerprints, evidence: suggestion.evidence })
        if (id) { summary.suggestions.push(id); summary.suggested += 1 }
      }

      for (const plan of score.splits) {
        const canonical = sortedInputs([], [plan.firefliesId])
        if (isTombstoned(before.tombstones, canonical)) continue
        const fingerprints = fingerprintsFor(canonical, g2ById, firefliesById, inputs.g2Meta, inputs.firefliesMeta)
        const decision = this.classifySplit(plan.firefliesId, canonical, mode, boundary, firefliesById, before)
        if (decision === 'skip') continue
        if (decision === 'auto') {
          if (autoTaken >= MAX_AUTO_ACTIONS_PER_RUN) { summary.deferredByCap += 1; continue }
          autoTaken += 1
          const taken = await this.takeSplitAction({ canonical, fingerprints, tier: 'auto', plan, inputs, g2ById, firefliesById })
          if (taken.ok) { summary.auto += 1; summary.actions.push(taken.id) } else summary.errors += 1
          continue
        }
        const id = await this.upsertSuggestion({
          kind: 'split',
          inputs: canonical,
          fingerprints,
          evidence: { K1: 0, K2: 0, spans: plan.pieces.map(piece => ({ startS: piece.startS, endS: piece.endS })) },
        })
        if (id) { summary.suggestions.push(id); summary.suggested += 1 }
      }
    }

    // Accepted-in-advise items become real actions once the mode is apply (WS4 step 7).
    if (mode === 'apply') {
      for (const suggestion of before.suggestions) {
        if (suggestion.state !== 'confirmed' || suggestion.kind !== 'would_merge') continue
        if (autoTaken >= MAX_AUTO_ACTIONS_PER_RUN) { summary.deferredByCap += 1; continue }
        autoTaken += 1
        const taken = await this.takeMergeAction({
          canonical: suggestion.inputs,
          fingerprints: suggestion.fingerprints,
          tier: 'accepted_suggestion',
          mode,
          inputs,
          g2ById,
          firefliesById,
        })
        if (taken.ok) {
          summary.auto += 1
          summary.actions.push(taken.id)
          await this.markSuggestion(suggestion.id, 'accepted')
        } else summary.errors += 1
      }
    }

    for (const action of drivePending) {
      const driven = await this.driveWaitingAction(action.id)
      if (!driven.ok) summary.errors += 1
    }

    return await this.finishRun(summary)
  }

  /**
   * The D14 boundary: recordings that finished before this only ever become suggestions.
   *
   * In imports mode it is when the engine arrived; in apply mode it is when a person chose
   * apply, because that is the first moment they had seen the advise report.
   */
  private advisoryBoundary(mode: MeetingEngineMode, store: ActionsStoreFile): number {
    if (mode === 'apply') return store.status.applyModeSince ?? store.status.engineInstalledAt ?? this.now()
    return store.status.engineInstalledAt ?? this.now()
  }

  private classify(
    canonical: CanonicalInputs,
    fingerprints: string,
    mode: MeetingEngineMode,
    boundary: number,
    inputs: EngineInputs,
    store: ActionsStoreFile,
  ): 'auto' | 'suggest' | 'would_merge' | 'skip' {
    if (isTombstoned(store.tombstones, canonical)) return 'skip'
    const id = actionIdFor('merge', canonical)
    const existing = store.actions.find(action => action.id === id)
    // `applied` is already covered by the line above; a second check for it was dead code.
    if (existing && existing.state !== 'failed' && existing.state !== 'reverted') return 'skip'
    const suggestion = store.suggestions.find(row => row.id === suggestionIdFor('merge', canonical)
      || row.id === suggestionIdFor('would_merge', canonical))
    if (suggestion?.state === 'dismissed') return 'skip'

    // Advise mode NEVER applies. The auto tier becomes something to look at.
    if (mode === 'advise') return 'would_merge'

    const tooOld = canonical.sessionIds.some(sessionId => (inputs.g2Meta[sessionId]?.finalizedAtMs ?? 0) < boundary)
    return tooOld ? 'suggest' : 'auto'
  }

  /**
   * What to do with a split plan.
   *
   * SPLITS ARE AN IMPORTS-MODE ACTION ONLY. A split writes NEW records, one per piece; in
   * apply mode the pipeline's job is to splice a patch into a scribe that already exists,
   * and there is no additive, revertible way to turn one operations scribe into three. In
   * advise and apply the plan therefore stays a suggestion for a person to look at, which is
   * also what the copy, the changelog and the contract now say.
   *
   * D14 applies here as it does to merges: a recording that finished before the engine
   * arrived is one nobody has measured, so it is only ever offered.
   */
  private classifySplit(
    firefliesId: string,
    canonical: CanonicalInputs,
    mode: MeetingEngineMode,
    boundary: number,
    firefliesById: Map<string, FirefliesMeetingInput>,
    store: ActionsStoreFile,
  ): 'auto' | 'suggest' | 'skip' {
    const id = actionIdFor('split', canonical)
    const existing = store.actions.find(action => action.id === id)
    if (existing && existing.state !== 'failed' && existing.state !== 'reverted') return 'skip'
    const suggestion = store.suggestions.find(row => row.id === suggestionIdFor('split', canonical))
    if (suggestion?.state === 'dismissed' || suggestion?.state === 'accepted') return 'skip'
    if (mode !== 'imports') return 'suggest'
    const source = firefliesById.get(firefliesId)
    if (!source) return 'skip'
    const finishedAtMs = source.startMs + Math.max(0, source.durationS) * 1000
    return finishedAtMs < boundary ? 'suggest' : 'auto'
  }

  /**
   * Record, exactly once, every merge the pipeline already made.
   *
   * Two tells, both written by the old blend path: a G2 sidecar stamped `blended_into` or
   * `claimed_parent`, and a Fireflies scribe carrying the blended marker without one of this
   * engine's own `merge-action` markers. Either makes a `legacy_applied` action, which
   * nothing ever merges, suggests or reverts.
   */
  private async adoptLegacy(inputs: EngineInputs, store: ActionsStoreFile): Promise<Set<string>> {
    const adopted = new Set<string>()
    const newRows: MergeActionRecord[] = []
    const known = new Set(store.actions.map(action => action.id))

    for (const [sessionId, meta] of Object.entries(inputs.g2Meta)) {
      const parent = meta.blendedInto ?? meta.claimedParent
      if (!parent) continue
      adopted.add(`g2:${sessionId}`)
      const canonical = sortedInputs([sessionId], [])
      const id = actionIdFor('legacy', canonical)
      if (known.has(id)) continue
      known.add(id)
      newRows.push({
        id,
        kind: 'merge',
        tier: 'legacy_applied',
        inputs: canonical,
        fingerprints: '',
        outputs: [{ path: parent }],
        outputSha256: [],
        state: 'applied',
        mode: 'apply',
        at: new Date(this.now()).toISOString(),
        legacyParentPath: parent,
      })
    }

    for (const [firefliesId, meta] of Object.entries(inputs.firefliesMeta)) {
      if (!meta.blendedMarker || meta.mergeActionId) continue
      adopted.add(`ff:${firefliesId}`)
      const canonical = sortedInputs([], [firefliesId])
      const id = actionIdFor('legacy', canonical)
      if (known.has(id)) continue
      known.add(id)
      newRows.push({
        id,
        kind: 'merge',
        tier: 'legacy_applied',
        inputs: canonical,
        fingerprints: '',
        outputs: meta.scribeRelPath ? [{ path: meta.scribeRelPath }] : [],
        outputSha256: [],
        state: 'applied',
        mode: 'apply',
        at: new Date(this.now()).toISOString(),
        ...(meta.scribeRelPath ? { legacyParentPath: meta.scribeRelPath } : {}),
      })
    }

    if (newRows.length > 0) {
      await this.store.update(current => { current.actions.push(...newRows) })
    }
    return adopted
  }

  private async upsertSuggestion(input: {
    kind: MergeSuggestionRecord['kind']
    inputs: CanonicalInputs
    fingerprints: string
    evidence: MergeSuggestionRecord['evidence']
  }): Promise<string | null> {
    const id = suggestionIdFor(input.kind, input.inputs)
    return await this.store.update(store => {
      const existing = store.suggestions.find(row => row.id === id)
      // A dismissed input set never reopens, and a decided one is not re-asked.
      if (existing && existing.state !== 'open') return null
      if (existing) {
        existing.fingerprints = input.fingerprints
        existing.evidence = input.evidence
        return id
      }
      store.suggestions.push({
        id,
        kind: input.kind,
        inputs: input.inputs,
        fingerprints: input.fingerprints,
        evidence: input.evidence,
        state: 'open',
        at: new Date(this.now()).toISOString(),
      })
      return id
    })
  }

  private async markSuggestion(id: string, state: MergeSuggestionRecord['state']): Promise<void> {
    await this.store.update(store => {
      const row = store.suggestions.find(item => item.id === id)
      if (!row) return
      row.state = state
      row.decidedAt = new Date(this.now()).toISOString()
    })
  }

  // ── Taking one action ───────────────────────────────────────────────────────

  private async takeMergeAction(input: {
    canonical: CanonicalInputs
    fingerprints: string
    tier: 'auto' | 'accepted_suggestion'
    mode: MeetingEngineMode
    group?: MergeGroup
    inputs: EngineInputs
    g2ById: Map<string, G2RecordingInput>
    firefliesById: Map<string, FirefliesMeetingInput>
  }): Promise<{ ok: boolean; id: string }> {
    const id = actionIdFor('merge', input.canonical)
    const primaryId = input.group?.primaryFirefliesId ?? input.canonical.firefliesIds[0]
    const primary = primaryId ? input.firefliesById.get(primaryId) : undefined
    const captures = input.canonical.sessionIds
      .map(sessionId => input.g2ById.get(sessionId))
      .filter((row): row is G2RecordingInput => row != null)
      .sort((a, b) => a.startMs - b.startMs)
    if (!primary || captures.length === 0) return { ok: false, id }
    const alternates = (input.group?.alternateFirefliesIds ?? input.canonical.firefliesIds.filter(ffId => ffId !== primaryId))
      .map(ffId => input.firefliesById.get(ffId))
      .filter((row): row is FirefliesMeetingInput => row != null)

    let lease: MaintenanceWorkLease
    try {
      lease = this.acquireLease()
    } catch {
      // A drain committed between the engine and the write. Nothing has happened yet;
      // the next run repeats this decision.
      this.log(`action ${id} deferred: maintenance_drain_active`)
      return { ok: false, id }
    }

    try {
      if (input.mode === 'apply') {
        return { ok: await this.writeApplyDecision({ ...input, id, primary, alternates, captures }), id }
      }
      return { ok: await this.writeImportsRecord({ ...input, id, primary, alternates, captures }), id }
    } catch (error) {
      this.log(`action ${id} failed: ${describe(error)}`)
      await this.failAction(id, describe(error), input.canonical, input.fingerprints, input.mode)
      return { ok: false, id }
    } finally {
      lease.release()
    }
  }

  /**
   * Cut one long recording into the meetings it holds, one record per piece.
   *
   * IMPORTS MODE ONLY, and additive like every other action: the original import stays on
   * disk and the pieces supersede it in the list, so Revert is deleting what was added.
   *
   * ALL OR NOTHING. A half-written split is a recording that appears twice, once whole and
   * once in fragments, so a piece that fails to derive takes the whole action down and
   * removes whatever was already written. There is no partial split state to explain.
   */
  /** The engine's own plan for this one recording, re-made from what is on disk now. */
  private async splitPlanFor(source: FirefliesMeetingInput, g2: readonly G2RecordingInput[]): Promise<SplitPlan | null> {
    const result = await this.engine({ kind: 'score', g2: [...g2], fireflies: [source] })
    if (result.kind !== 'score') return null
    return result.splits.find(plan => plan.firefliesId === source.id && plan.split) ?? null
  }

  private async takeSplitAction(input: {
    canonical: CanonicalInputs
    fingerprints: string
    tier: 'auto' | 'accepted_suggestion'
    plan: SplitPlan
    inputs: EngineInputs
    g2ById: Map<string, G2RecordingInput>
    firefliesById: Map<string, FirefliesMeetingInput>
  }): Promise<{ ok: boolean; id: string }> {
    const id = actionIdFor('split', input.canonical)
    const source = input.firefliesById.get(input.plan.firefliesId)
    if (!source || input.plan.pieces.length < 2) return { ok: false, id }

    let lease: MaintenanceWorkLease
    try {
      lease = this.acquireLease()
    } catch {
      this.log(`split ${id} deferred: maintenance_drain_active`)
      return { ok: false, id }
    }

    const sourceRecordId = importRecordId('fireflies', importHash(source.id))
    const written: Array<{ path: string; recordId: string; sidecarPath?: string; markdown: string; pieceIndex: number }> = []
    try {
      for (const piece of input.plan.pieces) {
        const captures = piece.sessionIds
          .map(sessionId => input.g2ById.get(sessionId))
          .filter((row): row is G2RecordingInput => row != null)
        const derived = await this.engine({
          kind: 'derive_piece',
          input: { actionId: id, tier: input.tier, source, piece, pieceCount: input.plan.pieces.length, captures },
        })
        if (derived.kind !== 'derive') throw new Error('engine_result_kind')
        if (!derived.result.ok) throw new Error(derived.result.error)
        const record = derived.result.record
        const result = this.library.writeRecord({
          kind: 'piece',
          hash: pieceHash(sourceRecordId, piece.index),
          dateMs: source.startMs + piece.startS * 1000,
          markdown: record.markdown,
          sidecar: record.sidecar,
        })
        written.push({
          path: result.filepath,
          recordId: importRecordId('piece', pieceHash(sourceRecordId, piece.index)),
          sidecarPath: result.sidecarPath,
          markdown: record.markdown,
          pieceIndex: piece.index,
        })
      }
    } catch (error) {
      for (const piece of written) {
        for (const path of [piece.path, piece.sidecarPath]) {
          if (path) { try { unlinkSync(path) } catch { /* nothing written is the state we wanted */ } }
        }
      }
      lease.release()
      this.log(`split ${id} failed: ${describe(error)}`)
      await this.failAction(id, describe(error), input.canonical, input.fingerprints, 'imports', { kind: 'split' })
      return { ok: false, id }
    }
    lease.release()

    await this.store.update(store => {
      upsertAction(store, {
        id,
        kind: 'split',
        tier: input.tier,
        inputs: input.canonical,
        fingerprints: input.fingerprints,
        outputs: written.map(piece => ({ path: piece.path, recordId: piece.recordId, sidecarPath: piece.sidecarPath })),
        outputSha256: written.map(piece => sha256OfText(piece.markdown)),
        state: 'applied',
        mode: 'imports',
        direction: 'apply',
        at: new Date(this.now()).toISOString(),
      })
    })
    return { ok: true, id }
  }

  /** imports mode: render a derived record and write it through the library. */
  private async writeImportsRecord(input: {
    id: string
    canonical: CanonicalInputs
    fingerprints: string
    tier: 'auto' | 'accepted_suggestion'
    group?: MergeGroup
    primary: FirefliesMeetingInput
    alternates: FirefliesMeetingInput[]
    captures: G2RecordingInput[]
  }): Promise<boolean> {
    const derived = await this.engine({
      kind: 'derive_merge',
      input: {
        actionId: input.id,
        tier: input.tier,
        primary: input.primary,
        alternates: input.alternates,
        captures: input.captures,
        // The GROUP's real K, not zeros. The derived sidecar's `evidence` is the only record
        // of why a merge happened, and a sidecar that says K1 = K2 = 0 says a merge with no
        // evidence behind it took place automatically.
        evidence: { k1: input.group?.k1 ?? 0, k2: input.group?.k2 ?? 0 },
        ...(coarseOffsets(input.group) ? { coarseOffsetMsBySession: coarseOffsets(input.group)! } : {}),
      },
    })
    if (derived.kind !== 'derive') {
      await this.failAction(input.id, 'engine_result_kind', input.canonical, input.fingerprints, 'imports')
      return false
    }
    if (!derived.result.ok) {
      await this.failAction(input.id, derived.result.error, input.canonical, input.fingerprints, 'imports')
      return false
    }
    const record = derived.result.record
    const hash = mergedHash(input.primary.id, input.captures.map(capture => capture.sessionId))
    const written = this.library.writeRecord({
      kind: 'merged',
      hash,
      dateMs: input.primary.startMs,
      markdown: record.markdown,
      sidecar: record.sidecar,
    })
    await this.store.update(store => {
      upsertAction(store, {
        id: input.id,
        kind: 'merge',
        tier: input.tier,
        inputs: input.canonical,
        fingerprints: input.fingerprints,
        outputs: [{ path: written.filepath, recordId: importRecordId('merged', hash), sidecarPath: written.sidecarPath }],
        outputSha256: [sha256OfText(record.markdown)],
        state: 'applied',
        mode: 'imports',
        at: new Date(this.now()).toISOString(),
      })
    })
    return true
  }

  /** apply mode: write the decision file, record the action pending, then drive it. */
  private async writeApplyDecision(input: {
    id: string
    canonical: CanonicalInputs
    fingerprints: string
    tier: 'auto' | 'accepted_suggestion'
    group?: MergeGroup
    primary: FirefliesMeetingInput
    alternates: FirefliesMeetingInput[]
    captures: G2RecordingInput[]
    inputs: EngineInputs
  }): Promise<boolean> {
    const firefliesMeta = input.inputs.firefliesMeta[input.primary.id]
    if (!firefliesMeta?.scribeRelPath || !firefliesMeta.sidecarRelPath || !firefliesMeta.sha256) {
      await this.failAction(input.id, 'fireflies_scribe_missing', input.canonical, input.fingerprints, 'apply')
      return false
    }
    const sidecarRelPathBySession: Record<string, string> = {}
    const decisionInputs: MergeDecisionInput[] = []
    for (const capture of input.captures) {
      const meta = input.inputs.g2Meta[capture.sessionId]
      if (!meta?.sidecarRelPath || !meta.sha256) {
        await this.failAction(input.id, 'g2_sidecar_missing', input.canonical, input.fingerprints, 'apply')
        return false
      }
      sidecarRelPathBySession[capture.sessionId] = meta.sidecarRelPath
      decisionInputs.push({
        kind: 'g2',
        sessionId: capture.sessionId,
        sidecarRelPath: meta.sidecarRelPath,
        ...(meta.scribeRelPath ? { scribeRelPath: meta.scribeRelPath } : {}),
        sha256: meta.sha256,
      })
    }
    decisionInputs.push({
      kind: 'fireflies',
      firefliesId: input.primary.id,
      scribeRelPath: firefliesMeta.scribeRelPath,
      sidecarRelPath: firefliesMeta.sidecarRelPath,
      sha256: firefliesMeta.sha256,
    })

    const patch = renderPipelinePatch({
      actionId: input.id,
      tier: input.tier,
      primary: input.primary,
      alternates: input.alternates,
      captures: input.captures,
      evidence: { k1: input.group?.k1 ?? 0, k2: input.group?.k2 ?? 0 },
      ...(coarseOffsets(input.group) ? { coarseOffsetMsBySession: coarseOffsets(input.group)! } : {}),
      sidecarRelPathBySession,
    })
    const decision: MergeDecision = {
      schema: DECISION_SCHEMA,
      actionId: input.id,
      kind: 'merge',
      inputs: decisionInputs,
      patch,
      speakerMap: patch.speakerMap,
      retire: input.captures
        .map(capture => input.inputs.g2Meta[capture.sessionId]?.scribeRelPath)
        .filter((path): path is string => typeof path === 'string'),
    }
    try {
      writeDecision(decision, this.library.root)
    } catch (error) {
      // A patch that adds nothing would apply cleanly, retire the capture and leave the
      // scribe exactly as it was. The refusal is recorded on the action so a person sees
      // why this one did not happen rather than seeing it quietly not happen.
      const code = error instanceof DecisionError ? error.code : describe(error)
      await this.failAction(input.id, code, input.canonical, input.fingerprints, 'apply')
      return false
    }

    await this.store.update(store => {
      upsertAction(store, {
        id: input.id,
        kind: 'merge',
        tier: input.tier,
        inputs: input.canonical,
        fingerprints: input.fingerprints,
        outputs: [{ path: firefliesMeta.scribeRelPath! }],
        outputSha256: [],
        state: 'pending',
        mode: 'apply',
        // Written down HERE, once, rather than inferred from the state later. A failed
        // apply and a failed revert both come back to a waiting state, and only this field
        // says which command the next drive should spawn.
        direction: 'apply',
        at: new Date(this.now()).toISOString(),
        attempts: 0,
      })
    })
    const driven = await this.drivePipelineAction(input.id)
    return driven.ok
  }

  // ── The pipeline ────────────────────────────────────────────────────────────

  /**
   * Drive one waiting action, whatever kind of Mac wrote it.
   *
   * An `imports`-mode action can also be left waiting — a Revert that claimed the action and
   * then lost the process before it finished deleting. It has no pipeline to spawn, so it is
   * finished here rather than handed to a spawn that would answer `no_pipeline` forever.
   */
  async driveWaitingAction(actionId: string): Promise<{ ok: boolean; state: MergeActionRecord['state']; reason?: string }> {
    const action = this.store.read().actions.find(row => row.id === actionId)
    if (!action) return { ok: false, state: 'failed', reason: 'action_not_found' }
    if (!isWaitingState(action.state)) return { ok: true, state: action.state }
    if (action.mode === 'imports') {
      if (directionOf(action) !== 'revert') return { ok: true, state: action.state }
      await this.revertImportsRecord(action)
      return { ok: true, state: 'reverted' }
    }
    return await this.drivePipelineAction(actionId)
  }

  /**
   * Spawn the pipeline for one waiting action and record what it reported.
   *
   * NO SERVER LOCK AROUND THE SPAWN (v3 blocker 1). The child takes the pipeline's own lock
   * with no retries. Exit 3 means it could not, which is normal while the hourly sync runs:
   * the action stays waiting and comes back in two minutes. Anything else is a real
   * outcome, and every failure names a step so a person can see where it stopped.
   *
   * THE DIRECTION COMES FROM THE ROW, NOT THE STATE. A failed revert is reset to a waiting
   * state so it can be retried; reading the direction back out of that state turned the
   * retry of an Undo into a Redo.
   */
  async drivePipelineAction(actionId: string): Promise<{ ok: boolean; state: MergeActionRecord['state']; reason?: string }> {
    const spawn = this.spawnPipeline
    if (!spawn) return { ok: false, state: 'pending', reason: 'no_pipeline' }
    const action = this.store.read().actions.find(row => row.id === actionId)
    if (!action) return { ok: false, state: 'failed', reason: 'action_not_found' }
    if (!isWaitingState(action.state)) return { ok: true, state: action.state }
    const direction = directionOf(action)
    const waiting = pendingStateFor(direction)

    let lease: MaintenanceWorkLease
    try {
      lease = this.acquireLease()
    } catch {
      await this.deferAction(actionId, 'maintenance_drain_active')
      return { ok: false, state: waiting, reason: 'maintenance_drain_active' }
    }

    let attempt: PipelineAttempt
    try {
      attempt = await spawn(
        direction === 'revert' ? ['--revert-merge-decision', actionId] : ['--apply-merge-decision', actionId],
        { actionId },
      )
    } catch (error) {
      lease.release()
      await this.failAction(actionId, `spawn_failed: ${describe(error)}`, undefined, undefined, undefined, {
        diagnostics: { code: null, signal: null, timedOut: false, elapsedMs: 0, spawnError: describe(error) },
      })
      return { ok: false, state: 'failed', reason: 'spawn_failed' }
    }
    lease.release()

    if (attempt.code === PIPELINE_EXIT_LOCK_BUSY) {
      await this.deferAction(actionId, 'sync_lock_busy')
      return { ok: false, state: waiting, reason: 'sync_lock_busy' }
    }

    const diagnostics = diagnosticsOf(attempt)
    const parsed = parseResultLine<MergePipelineResult>(attempt.resultLines, isMergePipelineResult)
    if (!parsed.ok) {
      // Exit 4 is terminal whatever it printed: the decision does not match the disk, and a
      // retry cannot make it match.
      const terminal = attempt.code === PIPELINE_EXIT_DECISION_INVALID
      const reason = terminal ? 'decision_invalid' : `result_unreadable:${parsed.reason}`
      await this.failAction(actionId, reason, undefined, undefined, undefined, { retryable: !terminal, diagnostics })
      return { ok: false, state: 'failed', reason }
    }

    const result = parsed.value
    writeDecisionResult(actionId, result, this.library.root)

    if (result.status === 'applied' || result.status === 'reverted') {
      await this.store.update(store => {
        const row = store.actions.find(item => item.id === actionId)
        if (!row) return
        row.state = result.status === 'applied' ? 'applied' : 'reverted'
        row.outputs = result.outputs.map(output => ({ path: output.path }))
        row.outputSha256 = result.outputs.map(output => output.sha256)
        delete row.error
        delete row.nextAt
        delete row.diagnostics
      })
      if (result.status === 'reverted') {
        await this.tombstoneAction(actionId)
        deleteDecision(actionId, this.library.root)
      }
      return { ok: true, state: result.status === 'applied' ? 'applied' : 'reverted' }
    }

    const reason = result.error_code ?? result.status
    await this.failAction(actionId, result.step ? `${reason} at ${result.step}` : reason, undefined, undefined, undefined, {
      retryable: true,
      diagnostics,
    })
    return { ok: false, state: 'failed', reason }
  }

  private async deferAction(actionId: string, reason: string): Promise<void> {
    await this.store.update(store => {
      const row = store.actions.find(item => item.id === actionId)
      if (!row) return
      row.nextAt = this.now() + PIPELINE_LOCK_RETRY_MS
      row.error = reason
    })
  }

  private async failAction(
    actionId: string,
    error: string,
    canonical?: CanonicalInputs,
    fingerprints?: string,
    mode?: MeetingEngineMode,
    options: { retryable?: boolean; kind?: 'merge' | 'split'; diagnostics?: PipelineFailureDiagnostics } = {},
  ): Promise<void> {
    await this.store.update(store => {
      const row = store.actions.find(item => item.id === actionId)
      if (!row) {
        if (!canonical) return
        store.actions.push({
          id: actionId,
          kind: options.kind ?? 'merge',
          tier: 'auto',
          inputs: canonical,
          fingerprints: fingerprints ?? '',
          outputs: [],
          outputSha256: [],
          state: 'failed',
          mode: mode === 'apply' ? 'apply' : 'imports',
          direction: 'apply',
          error,
          ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
          at: new Date(this.now()).toISOString(),
        })
        return
      }
      const attempts = (row.attempts ?? 0) + 1
      row.attempts = attempts
      row.error = error
      if (options.diagnostics) row.diagnostics = options.diagnostics
      // Retried once, then it stays failed until a person acts. A pipeline that keeps
      // failing on one decision would otherwise burn a spawn every thirty seconds.
      // A retryable REVERT comes back as a revert: `pendingStateFor` is the only thing
      // standing between "try the Undo again" and "do the merge a second time".
      row.state = options.retryable && attempts < PIPELINE_MAX_ATTEMPTS ? pendingStateFor(directionOf(row)) : 'failed'
      if (isWaitingState(row.state)) row.nextAt = this.now() + PIPELINE_LOCK_RETRY_MS
      else delete row.nextAt
    })
  }

  private async finishRun(summary: RunOutcome): Promise<RunOutcome> {
    const { actions, suggestions, ...run } = summary
    const collected = this.collectedThisPass
    const scan = this.pendingInputScan
    const hashCache = collected ? this.hashCacheSnapshot() : null
    await this.store.update(store => {
      store.status.engineInstalledAt ??= this.now()
      store.status.lastRun = run
      // Recorded only for a pass that actually READ the inputs. A pass that bailed saw
      // nothing, and writing its (empty) view would throw away the cache that made it
      // cheap, so the next pass would read every sidecar again.
      if (collected && scan) store.status.lastInputScan = scan
      if (collected && hashCache) store.status.hashCache = hashCache
      if (!store.status.firstRun && !run.skippedReason) {
        store.status.firstRun = {
          startedAt: run.at,
          completedAt: new Date(this.now()).toISOString(),
          mode: run.mode,
          scanned: run.scanned,
          auto: run.auto,
          wouldMerge: run.wouldMerge,
          suggested: run.suggested,
          none: run.none,
          alreadyMerged: run.alreadyMerged,
          deferredByCap: run.deferredByCap,
          errors: run.errors,
        }
      }
    })
    return summary
  }

  // ── Suggestions ─────────────────────────────────────────────────────────────

  /**
   * Suggestions, each with both sides resolved to something a person can read.
   *
   * SERVER-SIDE, because only the server can do it on the Mac where it matters. A suggestion
   * holds canonical ids; on a pipeline Mac the Fireflies side is a scribe in the operations
   * tree whose path no client knows. The last collected pass already learned that mapping,
   * so it is remembered here rather than re-scanned per request.
   */
  listSuggestions(state?: string): SuggestionWithSides[] {
    const rows = this.store.read().suggestions
    const filtered = state && state !== 'all' ? rows.filter(row => row.state === state) : rows
    return withSuggestionSides(filtered, {
      library: this.library,
      firefliesScribeRelPaths: this.firefliesPathsForSides(),
    })
  }

  /**
   * Operations paths per Fireflies id, from the last collected pass or a fresh scan.
   *
   * A list request must not cost a full collection, and after any pass in advise or apply
   * mode the map is already in hand. It is only rebuilt when this process has not run a pass
   * yet, which is the first request after a restart.
   */
  private firefliesPathsForSides(): Record<string, { sidecarRelPath?: string; scribeRelPath?: string }> {
    if (this.firefliesPaths) return this.firefliesPaths
    const mode = this.mode()
    if (mode === 'imports') return {}
    try {
      this.rememberFirefliesPaths(collectEngineInputs(mode, this.library, () => undefined))
    } catch {
      return {}
    }
    return this.firefliesPaths ?? {}
  }

  private rememberFirefliesPaths(inputs: EngineInputs): void {
    const paths: Record<string, { sidecarRelPath?: string; scribeRelPath?: string }> = {}
    for (const [id, meta] of Object.entries(inputs.firefliesMeta)) {
      if (!meta.sidecarRelPath && !meta.scribeRelPath) continue
      paths[id] = {
        ...(meta.sidecarRelPath ? { sidecarRelPath: meta.sidecarRelPath } : {}),
        ...(meta.scribeRelPath ? { scribeRelPath: meta.scribeRelPath } : {}),
      }
    }
    this.firefliesPaths = paths
  }

  listActions(limit = 100): MergeActionRecord[] {
    const rows = this.store.read().actions
    return rows.slice(-Math.max(1, Math.min(limit, rows.length))).reverse()
  }

  /** One action by id, for a surface that holds a link to it rather than a page of rows. */
  getAction(actionId: string): MergeActionRecord {
    const row = this.store.read().actions.find(action => action.id === actionId)
    if (!row) throw new ActionRefusedError(404, 'action_not_found', 'That action is gone.')
    return row
  }

  /**
   * Put a failed action back in the queue, in the direction it was already going.
   *
   * WHY A ROUTE AND NOT JUST THE NEXT PASS. A merge that failed twice was terminal: nothing
   * re-drove it, the comment on the boot sweep said otherwise, and Control's Retry button
   * only reloaded the list. Two failures on one decision is exactly the case where a person
   * has just fixed the thing that was wrong — a missing file, a full disk, a pipeline that
   * was mid-upgrade — and the only way to say so was to restart the server.
   *
   * A RETRY RESETS THE ATTEMPT BUDGET. The bounded automatic retry exists so a broken
   * decision cannot burn a spawn every thirty seconds; a person asking for one is not that.
   */
  async retryAction(actionId: string): Promise<{ ok: boolean; state: MergeActionRecord['state']; direction: ActionDirection }> {
    // ASYNC so every refusal is a REJECTED PROMISE. A method that returns a promise and
    // sometimes throws synchronously needs two error paths at every call site, and the one
    // a caller forgets turns a 409 into a 500.
    this.assertAdmissions()
    if (this.busy()) {
      throw new ActionRefusedError(409, 'run_in_progress', 'COS is working on meetings right now. Try again shortly.')
    }
    const current = this.getAction(actionId)
    if (isWaitingState(current.state)) {
      throw new ActionRefusedError(409, 'apply_in_flight', 'That one is already queued. Give it a moment.')
    }
    if (current.state !== 'failed') {
      throw new ActionRefusedError(409, 'action_not_failed', 'Only a failed action can be retried.')
    }
    return this.enqueue(async () => {
      const direction = directionOf(current)
      // TWO DIFFERENT RETRIES, because the two modes fail at different layers.
      //
      // An APPLY-mode action failed in the pipeline, so its retry is another spawn: it goes
      // back to its own waiting state and the next pass drives it.
      //
      // An IMPORTS-mode action failed in the DERIVE, so there is no child to spawn and
      // nothing to re-drive. Its retry is the engine taking the decision again, and
      // `classify` already retakes a `failed` row — so the row STAYS failed. Moving it to
      // `pending` would have stranded it forever: nothing drives a pending imports action,
      // and `classify` skips every state except `failed` and `reverted`.
      const state: MergeActionRecord['state'] = current.mode === 'apply' ? pendingStateFor(direction) : 'failed'
      await this.store.update(store => {
        const row = store.actions.find(item => item.id === actionId)
        if (!row || row.state !== 'failed') return
        row.state = state
        row.direction = direction
        row.attempts = 0
        if (isWaitingState(state)) row.nextAt = this.now()
        else delete row.nextAt
        delete row.error
        delete row.diagnostics
      })
      // The next pass would otherwise BAIL: nothing on disk has moved since the last one, and
      // a person asking for a retry is the one case where that is not a reason to do nothing.
      this.forceNextCollection = true
      // Fire and forget, like every other trigger: the route answers now, the pass does it.
      this.trigger('manual_retry')
      return { ok: true, state, direction }
    })
  }

  /**
   * The evidence a HUMAN-accepted merge carries (QA round 2, blocker 1).
   *
   * WHAT WAS WRONG. The accept path called `takeMergeAction` with no `group`, so the derived
   * sidecar recorded K1 = K2 = 0, a merge with no evidence behind it, and alignment had no
   * pairing offset to search around. It fell back to the difference between the two clocks,
   * which on a capture whose clock is minutes off puts the alignment band beside the real
   * anchors: the capture attaches unaligned and no speaker is relabelled, silently.
   *
   * WHERE EACH HALF COMES FROM.
   *   - K1 and K2 from the suggestion's STORED evidence: what the person was shown when they
   *     agreed, from a full scoring pass. Re-scoring against only this suggestion's meetings
   *     would report K2 = 0 for every one-meeting suggestion, because K2 is the best OTHER
   *     meeting and there is no other.
   *   - Offsets from RE-SCORING this suggestion's own captures against its own meetings. An
   *     offset is the dominant bin of the phrases one capture shares with one meeting, so it does
   *     not depend on the other candidates. The fingerprint check before this proved these are
   *     the bytes that were suggested.
   *
   * A scoring failure does not block a merge a person asked for: it proceeds with the stored
   * evidence and no offsets, which is exactly the old alignment, and logs why.
   */
  private async groupForAcceptedMerge(
    suggestion: MergeSuggestionRecord,
    g2ById: Map<string, G2RecordingInput>,
    firefliesById: Map<string, FirefliesMeetingInput>,
  ): Promise<MergeGroup | undefined> {
    const canonical = suggestion.inputs
    const captures = canonical.sessionIds
      .map(sessionId => g2ById.get(sessionId))
      .filter((row): row is G2RecordingInput => row != null)
      .sort((a, b) => a.startMs - b.startMs)
    const meetings = canonical.firefliesIds
      .map(ffId => firefliesById.get(ffId))
      .filter((row): row is FirefliesMeetingInput => row != null)
    if (captures.length === 0 || meetings.length === 0) return undefined

    let pairings: PairingResult[] = []
    try {
      const scored = await this.engine({ kind: 'score', g2: captures, fireflies: meetings })
      if (scored.kind === 'score') pairings = scored.pairings
    } catch (error) {
      this.log(`accepted merge ${suggestion.id}: offsets unavailable: ${describe(error)}`)
    }

    // The primary is the meeting these captures actually paired with, when they name one of
    // this suggestion's own; otherwise the suggestion's first, which is what accept used before.
    const votes = new Map<string, number>()
    for (const pairing of pairings) {
      const primary = pairing.primaryFirefliesId
      if (primary && canonical.firefliesIds.includes(primary)) votes.set(primary, (votes.get(primary) ?? 0) + 1)
    }
    const primaryFirefliesId = [...votes.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0]
      ?? canonical.firefliesIds[0]
    if (!primaryFirefliesId) return undefined

    const offsetMsBySession: Record<string, number | null> = {}
    for (const capture of captures) {
      const pairing = pairings.find(row => row.sessionId === capture.sessionId)
      offsetMsBySession[capture.sessionId] = pairing && pairing.primaryFirefliesId === primaryFirefliesId ? pairing.offsetMs : null
    }
    return {
      primaryFirefliesId,
      alternateFirefliesIds: canonical.firefliesIds.filter(ffId => ffId !== primaryFirefliesId).sort(),
      sessionIds: captures.map(capture => capture.sessionId),
      k1: suggestion.evidence.K1,
      k2: suggestion.evidence.K2,
      offsetMsBySession,
    }
  }

  /** Imports mode: turn a suggestion into a real merge, or a real split. */
  acceptSuggestion(id: string): Promise<{ ok: boolean; actionId: string }> {
    this.assertAdmissions()
    return this.enqueue(async () => {
      const mode = this.mode()
      if (mode === 'advise') {
        throw new ActionRefusedError(409, 'advise_mode', 'COS does not change your pipeline files in this version.')
      }
      const suggestion = this.store.read().suggestions.find(row => row.id === id)
      if (!suggestion) throw new ActionRefusedError(404, 'suggestion_not_found', 'That suggestion is gone.')
      if (suggestion.state === 'dismissed') {
        throw new ActionRefusedError(409, 'suggestion_dismissed', 'That suggestion was dismissed.')
      }
      const kind = suggestion.kind === 'split' ? 'split' : 'merge'
      // A split writes NEW records, one per piece. In apply mode the pipeline splices a
      // patch into a scribe that already exists, and there is no additive, revertible way
      // to turn one operations scribe into three, so the honest answer is a refusal rather
      // than a 200 that did nothing.
      if (kind === 'split' && mode === 'apply') {
        throw new ActionRefusedError(
          409,
          'split_not_supported_in_apply_mode',
          'COS can suggest splitting this recording, but only your pipeline can split a meeting it already filed.',
        )
      }
      if (suggestion.state === 'accepted') {
        return { ok: true, actionId: actionIdFor(kind, suggestion.inputs) }
      }
      const inputs = await this.collect(mode)
      const g2ById = new Map(inputs.g2.map(row => [row.sessionId, row]))
      const firefliesById = new Map(inputs.fireflies.map(row => [row.id, row]))
      const fingerprints = fingerprintsFor(suggestion.inputs, g2ById, firefliesById, inputs.g2Meta, inputs.firefliesMeta)
      // A suggestion shown against one version of the files must not be applied to another:
      // the person agreed to what they were shown.
      if (fingerprints !== suggestion.fingerprints) {
        throw new ActionRefusedError(409, 'suggestion_stale', 'These meetings changed since this was suggested. Look again.')
      }
      if (kind === 'split') {
        const firefliesId = suggestion.inputs.firefliesIds[0]
        const source = firefliesId ? firefliesById.get(firefliesId) : undefined
        if (!source) throw new ActionRefusedError(409, 'suggestion_stale', 'That recording is no longer here. Look again.')
        // Re-planned from the CURRENT recording rather than replayed from the suggestion's
        // stored spans: the fingerprint proves the bytes are the same, and the plan is the
        // engine's to make.
        const plan = await this.splitPlanFor(source, inputs.g2)
        if (!plan) throw new ActionRefusedError(409, 'split_no_longer_planned', 'COS no longer sees more than one meeting in that recording.')
        const taken = await this.takeSplitAction({
          canonical: suggestion.inputs,
          fingerprints,
          tier: 'accepted_suggestion',
          plan,
          inputs,
          g2ById,
          firefliesById,
        })
        if (taken.ok) await this.markSuggestion(id, 'accepted')
        return { ok: taken.ok, actionId: taken.id }
      }
      const group = await this.groupForAcceptedMerge(suggestion, g2ById, firefliesById)
      const taken = await this.takeMergeAction({
        canonical: suggestion.inputs,
        fingerprints,
        tier: 'accepted_suggestion',
        mode,
        ...(group ? { group } : {}),
        inputs,
        g2ById,
        firefliesById,
      })
      if (taken.ok) await this.markSuggestion(id, 'accepted')
      return { ok: taken.ok, actionId: taken.id }
    })
  }

  /** Advise mode: record the answer, change nothing. */
  confirmSuggestion(id: string): Promise<{ ok: boolean }> {
    this.assertAdmissions()
    return this.enqueue(async () => {
      const suggestion = this.store.read().suggestions.find(row => row.id === id)
      if (!suggestion) throw new ActionRefusedError(404, 'suggestion_not_found', 'That suggestion is gone.')
      if (suggestion.state === 'dismissed') {
        throw new ActionRefusedError(409, 'suggestion_dismissed', 'That suggestion was dismissed.')
      }
      if (suggestion.state === 'open') await this.markSuggestion(id, 'confirmed')
      return { ok: true }
    })
  }

  /** Never the same two meetings again. */
  dismissSuggestion(id: string): Promise<{ ok: boolean }> {
    this.assertAdmissions()
    return this.enqueue(async () => {
      const suggestion = this.store.read().suggestions.find(row => row.id === id)
      if (!suggestion) throw new ActionRefusedError(404, 'suggestion_not_found', 'That suggestion is gone.')
      await this.store.update(store => {
        const row = store.suggestions.find(item => item.id === id)
        if (row) {
          row.state = 'dismissed'
          row.decidedAt = new Date(this.now()).toISOString()
        }
        addTombstones(store, suggestion.inputs, id, new Date(this.now()).toISOString())
      })
      return { ok: true }
    })
  }

  // ── Revert ──────────────────────────────────────────────────────────────────

  previewRevert(actionId: string): RevertPreview {
    const action = this.store.read().actions.find(row => row.id === actionId)
    if (!action) throw new ActionRefusedError(404, 'action_not_found', 'That action is gone.')
    if (action.tier === 'legacy_applied') {
      throw new ActionRefusedError(409, 'legacy_action', 'Your pipeline made this merge, so COS does not undo it.')
    }
    const current = action.outputs.map(output => sha256OfFile(output.path))
    return {
      actionId,
      previewHash: revertPreviewHash(action, current),
      state: action.state,
      mode: action.mode,
      outputs: action.outputs.map(output => output.path),
      editedOutputs: action.outputs
        .filter((output, index) => current[index] != null && action.outputSha256[index] != null && current[index] !== action.outputSha256[index])
        .map(output => output.path),
      missingOutputs: action.outputs.filter((_, index) => current[index] == null).map(output => output.path),
    }
  }

  /**
   * Undo one action.
   *
   * COMPARE AND SET. `applied` becomes `revert_pending` inside the mutex, so a double click
   * is a 409 rather than two reverts of one thing, and a second call after it finished is a
   * 200 rather than an error about an action that is already in the state you wanted.
   *
   * THE PREVIEW HASH IS NOT CEREMONY. It covers the outputs' CURRENT bytes, so an edit that
   * landed between the preview and the confirm invalidates the confirm rather than silently
   * deleting the edit.
   */
  revert(actionId: string, options: { dryRun?: boolean; previewHash?: string } = {}): Promise<RevertPreview | { ok: true; state: MergeActionRecord['state']; alreadyReverted?: boolean }> {
    if (!options.dryRun) this.assertAdmissions()
    return this.enqueue(async () => {
      const preview = this.previewRevert(actionId)
      if (options.dryRun) return preview
      if (preview.state === 'reverted') return { ok: true as const, state: 'reverted' as const, alreadyReverted: true }
      if (preview.state === 'revert_pending') {
        throw new ActionRefusedError(409, 'revert_in_progress', 'That undo is already running.')
      }
      if (preview.state !== 'applied') {
        throw new ActionRefusedError(409, 'action_not_revertible', 'Only an applied action can be undone.')
      }
      if (!options.previewHash) {
        throw new ActionRefusedError(400, 'preview_required', 'Ask for the preview first, then send its previewHash.')
      }
      if (options.previewHash !== preview.previewHash) {
        throw new ActionRefusedError(409, 'revert_stale', 'These files changed since the preview. Look again.')
      }

      const claimed = await this.store.update(store => {
        const row = store.actions.find(item => item.id === actionId)
        if (!row || row.state !== 'applied') return false
        row.state = 'revert_pending'
        // The intent, written down. Every later drive of this action reads it, including
        // the one after a `partial` result reset the row to a waiting state.
        row.direction = 'revert'
        row.attempts = 0
        delete row.error
        return true
      })
      if (!claimed) throw new ActionRefusedError(409, 'revert_in_progress', 'That undo is already running.')

      const action = this.store.read().actions.find(row => row.id === actionId)!
      if (action.mode === 'apply') {
        const driven = await this.drivePipelineAction(actionId)
        return { ok: driven.ok as true, state: driven.state }
      }
      await this.revertImportsRecord(action)
      return { ok: true as const, state: 'reverted' as const }
    })
  }

  /**
   * imports mode Revert: delete what was added, keep anything a person changed.
   *
   * A derived record whose bytes no longer match what the action wrote has been edited, and
   * deleting it would destroy that edit with no trace. It is copied into
   * `.reverted/<actionId>/` first. The sources were never touched, so removing the record
   * restores the rows it superseded.
   */
  private async revertImportsRecord(action: MergeActionRecord): Promise<void> {
    for (const [index, output] of action.outputs.entries()) {
      const current = sha256OfFile(output.path)
      if (current && action.outputSha256[index] && current !== action.outputSha256[index]) {
        const keepDir = join(this.store.revertedDir(), action.id)
        try {
          mkdirSync(keepDir, { recursive: true, mode: 0o700 })
          cpSync(output.path, join(keepDir, basename(output.path)))
          if (output.sidecarPath && existsSync(output.sidecarPath)) {
            cpSync(output.sidecarPath, join(keepDir, basename(output.sidecarPath)))
          }
        } catch (error) {
          this.log(`could not keep the edited record for ${action.id}: ${describe(error)}`)
        }
      }
      for (const path of [output.path, output.sidecarPath]) {
        if (!path) continue
        try { unlinkSync(path) } catch { /* already gone is the state we wanted */ }
      }
    }
    await this.store.update(store => {
      const row = store.actions.find(item => item.id === action.id)
      if (row) {
        row.state = 'reverted'
        delete row.error
      }
      addTombstones(store, action.inputs, action.id, new Date(this.now()).toISOString())
    })
  }

  private async tombstoneAction(actionId: string): Promise<void> {
    await this.store.update(store => {
      const row = store.actions.find(item => item.id === actionId)
      if (!row) return
      addTombstones(store, row.inputs, actionId, new Date(this.now()).toISOString())
    })
  }

  /** Every applied action, newest first, under the same preview rule as one. */
  revertAll(options: { dryRun?: boolean; previewHash?: string } = {}): Promise<{
    previewHash: string
    actions: string[]
    reverted?: string[]
    failed?: Array<{ id: string; reason: string }>
  }> {
    if (!options.dryRun) this.assertAdmissions()
    return this.enqueue(async () => {
      const applied = this.store.read().actions
        .filter(row => row.state === 'applied' && row.tier !== 'legacy_applied')
        .reverse()
      const previews = applied.map(row => this.previewRevert(row.id))
      const previewHash = createHash('sha256').update(previews.map(row => row.previewHash).join('|')).digest('hex')
      if (options.dryRun) return { previewHash, actions: applied.map(row => row.id) }
      if (!options.previewHash) {
        throw new ActionRefusedError(400, 'preview_required', 'Ask for the preview first, then send its previewHash.')
      }
      if (options.previewHash !== previewHash) {
        throw new ActionRefusedError(409, 'revert_stale', 'Something changed since the preview. Look again.')
      }
      const reverted: string[] = []
      const failed: Array<{ id: string; reason: string }> = []
      for (const preview of previews) {
        try {
          const claimed = await this.store.update(store => {
            const row = store.actions.find(item => item.id === preview.actionId)
            if (!row || row.state !== 'applied') return false
            row.state = 'revert_pending'
            row.direction = 'revert'
            row.attempts = 0
            delete row.error
            return true
          })
          if (!claimed) { failed.push({ id: preview.actionId, reason: 'not_applied' }); continue }
          const action = this.store.read().actions.find(row => row.id === preview.actionId)!
          if (action.mode === 'apply') {
            const driven = await this.drivePipelineAction(action.id)
            if (driven.ok) reverted.push(action.id)
            else failed.push({ id: action.id, reason: driven.reason ?? 'revert_failed' })
          } else {
            await this.revertImportsRecord(action)
            reverted.push(action.id)
          }
        } catch (error) {
          failed.push({ id: preview.actionId, reason: describe(error) })
        }
      }
      return { previewHash, actions: applied.map(row => row.id), reverted, failed }
    })
  }

  // ── Status and mode ─────────────────────────────────────────────────────────

  /** The mode plus what it was decided from, with a safe shape when a mode is injected. */
  private modeDetail(): ReturnType<typeof meetingEngineModeDetail> {
    if (this.modeDetailFn) return this.modeDetailFn()
    const mode = this.mode()
    return {
      mode,
      observedMacClass: mode === 'imports' ? 'standalone' : 'pipeline',
      macClassChanged: false,
    }
  }

  async status(): Promise<{
    mode: MeetingEngineMode
    isPipelineMac: boolean
    pipelineSees: { mode: string; active: boolean; appliedActions: number } | null
    mismatch: boolean
    /** Advise, with merges the pipeline still honours. Expected after a rollback, not a bug. */
    mergesRemainApplied: boolean
    macClass?: { observed: MeetingEngineMacClass; recorded?: MeetingEngineMacClass; changed: boolean }
    lastRun?: EngineRunSummary
    firstRun?: ActionsStoreFile['status']['firstRun']
    counts: {
      /** Every applied action revert-all would undo: any tier but `legacy_applied`. */
      applied: number
      auto: number
      suggested: number
      none: number
      reverted: number
      pending: number
      revertPending: number
      failed: number
    }
    engineInstalledAt?: number
    running: boolean
  }> {
    const detail = this.modeDetail()
    const mode = detail.mode
    const store = this.store.read()
    const pipelineSees = await this.pipelineStatus(store)
    const counts = {
      // EVERY applied action a person can undo, any tier (QA round 2, blocker 5). Control's
      // Undo-all count added OPEN suggestions to `auto`, so a Mac with suggestions and nothing
      // merged offered "Undo all merges" and then previewed "Undo 0 merges". `legacy_applied`
      // is out for the reason revert-all leaves it out: the pipeline made those merges.
      applied: store.actions.filter(row => row.state === 'applied' && row.tier !== 'legacy_applied').length,
      auto: store.actions.filter(row => row.tier === 'auto' && row.state === 'applied').length,
      suggested: store.suggestions.filter(row => row.state === 'open').length,
      none: store.status.lastRun?.none ?? 0,
      reverted: store.actions.filter(row => row.state === 'reverted').length,
      pending: store.actions.filter(row => row.state === 'pending').length,
      // Its own count. An Undo that cannot finish is the state `setMode` refuses on and the
      // one Control has to be able to name, and rolling it into `pending` hid it.
      revertPending: store.actions.filter(row => row.state === 'revert_pending').length,
      failed: store.actions.filter(row => row.state === 'failed').length,
    }
    // ADVISE PLUS ACTIVE IS NOT A DISAGREEMENT. `merge_engine_active()` stays true while any
    // applied action exists, precisely so the old blend path does not restart over merged
    // scribes after the mode is rolled back. That is the documented rollback state, and
    // reporting it as a mismatch told a person their two halves disagreed when they agreed.
    const mergesRemainApplied = mode === 'advise'
      && pipelineSees != null
      && pipelineSees.active
      && pipelineSees.mode !== 'apply'
      // Only when there IS something applied (QA round 2, blocker 4). An actions file the
      // pipeline cannot read prints `advise / active / 0`: the gate held on over nothing
      // readable. Reading that as the benign rollback state reassured a person whose merge
      // record was gone. It now reports as a mismatch, which Control shows as an alarm.
      && pipelineSees.appliedActions > 0
    const mismatch = pipelineSees != null
      && !mergesRemainApplied
      && ((mode === 'apply') !== (pipelineSees.mode === 'apply' || pipelineSees.active))
    return {
      mode,
      isPipelineMac: mode !== 'imports',
      pipelineSees,
      mismatch,
      mergesRemainApplied,
      macClass: {
        observed: detail.observedMacClass,
        ...(detail.recordedMacClass ? { recorded: detail.recordedMacClass } : {}),
        changed: detail.macClassChanged,
      },
      ...(store.status.lastRun ? { lastRun: store.status.lastRun } : {}),
      ...(store.status.firstRun ? { firstRun: store.status.firstRun } : {}),
      counts,
      ...(store.status.engineInstalledAt ? { engineInstalledAt: store.status.engineInstalledAt } : {}),
      running: this.busy(),
    }
  }

  /** `--merge-engine-status`, at most once every five minutes, null when it cannot be read. */
  private async pipelineStatus(store: ActionsStoreFile): Promise<{ mode: string; active: boolean; appliedActions: number } | null> {
    const spawn = this.spawnPipeline
    if (!spawn) return null
    const seenAt = store.status.pipelineSeenAt ?? 0
    if (this.now() - seenAt < PIPELINE_STATUS_CACHE_MS) return store.status.pipelineSees ?? null
    let value: { mode: string; active: boolean; appliedActions: number } | null = null
    try {
      const attempt = await spawn([PIPELINE_STATUS_ARG], {})
      if (attempt.code === 0) {
        const line = attempt.stdout.split(/\r?\n/).map(row => row.trim()).filter(Boolean).pop() ?? ''
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed?.mode === 'string') {
          value = {
            mode: parsed.mode,
            active: parsed.active === true,
            appliedActions: typeof parsed.applied_actions === 'number' ? parsed.applied_actions : 0,
          }
        }
      }
    } catch {
      value = null
    }
    await this.store.update(current => {
      current.status.pipelineSees = value
      current.status.pipelineSeenAt = this.now()
    })
    return value
  }

  /**
   * Switch a pipeline Mac between advise and apply.
   *
   * REFUSED WHILE ANYTHING IS IN FLIGHT. Changing the mode under a run means the decisions
   * already taken belong to one mode and the writes land under the rules of another.
   */
  setMode(mode: MeetingEnginePipelineMode): Promise<{ mode: MeetingEnginePipelineMode }> {
    this.assertAdmissions()
    if (!this.isPipelineMac()) {
      throw new ActionRefusedError(409, 'not_a_pipeline_mac', 'This Mac has no COS pipeline, so there is no mode to choose.')
    }
    if (mode !== 'advise' && mode !== 'apply') {
      throw new ActionRefusedError(400, 'invalid_mode', 'Mode must be advise or apply.')
    }
    if (this.busy()) {
      throw new ActionRefusedError(409, 'run_in_progress', 'COS is working on meetings right now. Try again shortly.')
    }
    if (this.store.read().actions.some(row => row.state === 'pending' || row.state === 'revert_pending')) {
      throw new ActionRefusedError(409, 'apply_in_flight', 'A merge is still finishing. Try again shortly.')
    }
    writeMergeModeFile(mode, { now: this.now })
    // D14 in apply mode counts from HERE, not from install: a person has now seen the
    // advise report, so what happens after this moment is what they opted into.
    void this.store.update(store => {
      if (mode === 'apply') store.status.applyModeSince = this.now()
    })
    return Promise.resolve({ mode })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether live meeting work owns the CPU right now.
 *
 * Five lease kinds, all work a person is waiting on: `recording_chunk` (every live chunk
 * write), `meeting_save` (a capture's own save), `meeting_batch_finalization` (batch
 * transcription of a finished capture), `orphan_recovery` (a stranded capture being rebuilt)
 * and `one_shot_transcription`. The last three were missing (QA round 2), and each is
 * transcription or rebuild work a backlog score competes with for the same cores.
 *
 * IT GATES PASS START ONLY. A pass already running is not interrupted.
 *
 * THE FINALIZATION TRIGGER IS NOT LOST. `g2_finalized` fires from INSIDE the finalization
 * lease (`routes/meeting.ts`), so its pass now defers. The runner remembers it and the next
 * 30 s tick that finds none of these leases held runs it (`tick()`), not the six-hourly run.
 */
export const CAPTURE_LEASE_KINDS = [
  'recording_chunk',
  'meeting_save',
  'meeting_batch_finalization',
  'orphan_recovery',
  'one_shot_transcription',
] as const

function defaultCaptureActive(): boolean {
  const byKind = maintenanceLifecycle.snapshot().activeByKind as Record<string, number>
  return CAPTURE_LEASE_KINDS.some(kind => (byKind[kind] ?? 0) > 0)
}

/** The alignment offsets pairing measured, or undefined when it measured none. */
function coarseOffsets(group: MergeGroup | undefined): Record<string, number> | null {
  if (!group) return null
  const offsets: Record<string, number> = {}
  for (const [sessionId, offsetMs] of Object.entries(group.offsetMsBySession)) {
    if (typeof offsetMs === 'number' && Number.isFinite(offsetMs)) offsets[sessionId] = offsetMs
  }
  return Object.keys(offsets).length > 0 ? offsets : null
}

/** The trimmed stderr tail a diagnostics row keeps. Enough for a traceback's last frames. */
export const DIAGNOSTIC_STDERR_CHARS = 2_000

/** `COS_MERGE_DECISION_INVALID=<code>`, which the pipeline prints before exiting 4. */
const DECISION_INVALID_LINE = /^COS_MERGE_DECISION_INVALID=.*$/m

/**
 * What a failed child did, from the attempt alone.
 *
 * `Command failed` with an empty stderr is three different bugs — a non-zero exit, a timeout
 * kill, and a failed fork — and a row that records only the message cannot tell them apart
 * afterwards. Every one of them is a separate field here.
 */
function diagnosticsOf(attempt: PipelineAttempt): PipelineFailureDiagnostics {
  const stderr = attempt.stderr.trim()
  const decisionInvalid = attempt.stderr.match(DECISION_INVALID_LINE)?.[0]
    ?? attempt.stdout.match(DECISION_INVALID_LINE)?.[0]
  return {
    code: attempt.code,
    signal: attempt.signal,
    timedOut: attempt.timedOut,
    elapsedMs: attempt.elapsedMs,
    ...(stderr ? { stderr: stderr.slice(-DIAGNOSTIC_STDERR_CHARS) } : {}),
    ...(decisionInvalid ? { decisionInvalid } : {}),
    ...(attempt.spawnError ? { spawnError: attempt.spawnError } : {}),
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * What the clock band did this run.
 *
 * `PAIRING_CLOCK_BAND_S` was chosen from 198 scored recordings on one Mac and nothing made
 * its effect observable anywhere else. These five numbers do: `candidatesZeroed` rising is
 * the band refusing real matches, and the winner skews say how much of the band this Mac's
 * clocks actually use.
 */
function clockBandStatsOf(
  pairings: readonly PairingResult[],
  g2ById: Map<string, G2RecordingInput>,
  firefliesById: Map<string, FirefliesMeetingInput>,
): ClockBandStats {
  let candidates = 0
  let anchorsDropped = 0
  let candidatesZeroed = 0
  const winnerSkews: number[] = []
  for (const pairing of pairings) {
    for (const candidate of pairing.candidates) {
      if (candidate.anchorsOutsideClockBand <= 0) continue
      candidates += 1
      anchorsDropped += candidate.anchorsOutsideClockBand
      if (candidate.k === 0) candidatesZeroed += 1
    }
    if (!pairing.primaryFirefliesId) continue
    const recording = g2ById.get(pairing.sessionId)
    const meeting = firefliesById.get(pairing.primaryFirefliesId)
    if (!recording || !meeting) continue
    winnerSkews.push(Math.abs(recording.startMs - meeting.startMs) / 1000)
  }
  return {
    candidates,
    anchorsDropped,
    candidatesZeroed,
    maxWinnerSkewS: winnerSkews.length > 0 ? Math.round(Math.max(...winnerSkews)) : 0,
    medianWinnerSkewS: Math.round(median(winnerSkews)),
  }
}

function sha256OfText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function upsertAction(store: ActionsStoreFile, record: MergeActionRecord): void {
  const index = store.actions.findIndex(row => row.id === record.id)
  if (index >= 0) store.actions[index] = { ...store.actions[index], ...record }
  else store.actions.push(record)
}

function addTombstones(store: ActionsStoreFile, inputs: CanonicalInputs, source: string, at: string): void {
  const known = new Set(store.tombstones.map(row => [...row.pair].sort().join('|')))
  for (const pair of inputPairs(inputs)) {
    const key = [...pair].sort().join('|')
    if (known.has(key)) continue
    known.add(key)
    store.tombstones.push({ pair, at, source })
  }
}

/** `--merge-engine-status` asks what the PIPELINE sees, so it must not be told what to see. */
export const PIPELINE_STATUS_ARG = '--merge-engine-status'

/** The real spawn. Null on a Mac with no pipeline, which is how imports mode gets no child. */
function defaultPipelineSpawn(args: readonly string[], options: { actionId?: string }): Promise<PipelineAttempt> {
  const scriptsDir = process.env.COS_SCRIPTS_DIR?.trim()
  if (!scriptsDir) return Promise.reject(new Error('COS_SCRIPTS_DIR is not set'))
  const dir = resolve(scriptsDir)
  const script = join(dir, 'sync_meetings.py')
  const pythonBin = process.env.COS_PYTHON_BIN?.trim() || resolve(dir, 'venv/bin/python3')
  if (!existsSync(script) || !existsSync(pythonBin)) {
    return Promise.reject(new Error('COS pipeline is not installed on this Mac'))
  }
  // THE STATUS PROBE RUNS WITH THE INHERITED ENVIRONMENT. Injecting the server's own
  // COS_DATA_DIR made the child resolve the SERVER's mode file, so `pipelineSees` was the
  // server reading itself back and `mismatch` could not be true however far the two halves
  // had actually drifted. The pipeline's own processes — the hourly sync, the watcher —
  // resolve the data dir the way this child now does, which is the thing being compared.
  const isStatusProbe = args[0] === PIPELINE_STATUS_ARG
  return runPipelineCommand({
    pythonBin,
    script,
    args,
    cwd: dir,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PATH: pipelinePath(),
      // Explicit, not inherited, for real WORK: the pipeline resolves the mode file and the
      // decision from these two, and a child that guessed either would act on the wrong
      // Mac's state.
      ...(isStatusProbe ? {} : { COS_DATA_DIR: dirname(importsRoot()) }),
      ...(options.actionId ? { COS_MERGE_DECISION_FILE: join(importsRoot(), 'decisions', `${options.actionId}.json`) } : {}),
    },
    resultPrefix: MERGE_RESULT_PREFIX,
    timeoutMs: PIPELINE_DEFAULT_TIMEOUT_MS,
  })
}

// ── Process-wide runner, scheduler and triggers ───────────────────────────────

let runner: MeetingMergeRunner | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let correctionHookOff: (() => void) | null = null

export function getMeetingMergeRunner(): MeetingMergeRunner {
  // Built on first use, never at import time: the constructor touches the data home.
  runner ??= new MeetingMergeRunner()
  return runner
}

/** Test seam. */
export function resetMeetingMergeRunner(): void {
  runner = null
}

/**
 * The trigger every caller uses. Safe everywhere: it refuses in the wrong mode, defers under
 * a drain or a live capture, and never throws at its caller.
 */
export function triggerMeetingMergeRun(reason: string): void {
  try {
    getMeetingMergeRunner().trigger(reason)
  } catch (error) {
    console.warn(`[meeting-merge] trigger (${reason}) unavailable:`, error)
  }
}

/** A speaker mutation landed. Re-derive the records that hold this session. */
export function triggerMeetingMergeRederive(sessionId: string): void {
  try {
    void getMeetingMergeRunner().rederive(sessionId).catch(() => { /* logged by the runner */ })
  } catch (error) {
    console.warn('[meeting-merge] re-derive unavailable:', error)
  }
}

export function startMeetingMergeScheduler(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => {
    try {
      getMeetingMergeRunner().tick()
    } catch (error) {
      console.error('[meeting-merge] tick failed:', error)
    }
  }, ENGINE_TICK_MS)
  tickTimer.unref?.()
  // ONE central hook, in the ledger every speaker mutation writes to, rather than in each
  // of the three route handlers: a fourth mutation route would otherwise silently not
  // re-derive. `intent` and `failed` rows are not outcomes and are ignored.
  correctionHookOff ??= onCorrectionApplied((sessionId, row) => {
    if (row.phase === 'intent' || row.phase === 'failed') return
    triggerMeetingMergeRederive(sessionId)
  })
}

export function stopMeetingMergeScheduler(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  correctionHookOff?.()
  correctionHookOff = null
}

/**
 * On boot, after the imports sweep: drive whatever a previous process left waiting.
 *
 * WAITING, NOT FAILED. A `failed` action is one that already used its automatic retry, and
 * re-driving it on every restart is how a broken decision spawns a child every time the
 * server comes up. A person retries it through `POST /api/meeting-actions/:id/retry`, which
 * puts it back in the correct direction's waiting state and this sweep's own queue.
 */
export async function redrivePendingMergeActions(): Promise<number> {
  const active = getMeetingMergeRunner()
  const waiting = active.listActions(Number.MAX_SAFE_INTEGER).filter(row => isWaitingState(row.state))
  for (const row of waiting) {
    try { await active.driveWaitingAction(row.id) } catch { /* the tick retries */ }
  }
  return waiting.length
}

/**
 * Decision files with no action behind them.
 *
 * A decision is written BEFORE its action row, so a crash in that window leaves a file
 * holding transcript text that nothing will ever read or delete. The sweep runs on boot,
 * beside the library's own, and only removes ids no action claims.
 */
export function sweepOrphanDecisions(): number {
  const known = new Set(getMeetingMergeRunner().listActions(Number.MAX_SAFE_INTEGER).map(row => row.id))
  let removed = 0
  for (const actionId of listDecisionIds(importsRoot())) {
    if (known.has(actionId)) continue
    deleteDecision(actionId, importsRoot())
    removed += 1
  }
  return removed
}
