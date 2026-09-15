/**
 * The merge engine's worker-thread entry, and the in-process orchestration it runs
 * (6.47.0, WS3).
 *
 * PURE ABOVE THE THREAD BOUNDARY. `runEngine` touches no filesystem, no network and no
 * clock: the runner (WS4) snapshots the inputs, posts them here, and writes the results.
 *
 * WHY A WORKER. Scoring a backlog is CPU-bound — trigrams over every capture against every
 * candidate transcript. On the main thread that competes with live capture: chunk writes,
 * transcription and the display bus all wait behind it. The engine never blocks a meeting.
 *
 * LOADING A `.ts` WORKER. Node 24 strips types natively but does NOT map a `./x.js`
 * specifier to `x.ts`, so a bare `new Worker(url)` fails on the engine's own imports, and
 * `execArgv: ['--import', 'tsx/esm']` does not fix it (measured: all three of bare,
 * resolved and inherited execArgv fail to resolve the sibling import). Registering tsx's
 * hooks INSIDE the worker before importing this file does work, with or without a loader
 * in the parent, so the worker starts from a small bootstrap that does exactly that.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import type { FirefliesMeetingInput, G2RecordingInput } from './evidence.js'
import {
  type MergeGroup,
  type MergeTier,
  type PairingResult,
  groupAutoMerges,
  scoreRecording,
} from './pairing.js'
import {
  type SplitPlan,
  LONG_RECORDING_S,
  splitPlanFor,
} from './split.js'
import type { AttributeMode } from './attribute.js'
import {
  type DeriveResult,
  type MergeDeriveInput,
  type PieceDeriveInput,
  renderMergedRecord,
  renderSplitPiece,
} from './render.js'

/** How long one engine job may run before the caller stops waiting on the thread. */
export const ENGINE_WORKER_TIMEOUT_MS = 300_000

export interface EngineSuggestion {
  kind: 'merge' | 'split'
  sessionIds: string[]
  firefliesIds: string[]
  evidence: { K1: number; K2: number }
}

export interface EngineScoreRequest {
  kind: 'score'
  g2: G2RecordingInput[]
  fireflies: FirefliesMeetingInput[]
  options?: { attributeMode?: AttributeMode }
}

export interface EngineDeriveMergeRequest {
  kind: 'derive_merge'
  input: MergeDeriveInput
}

export interface EngineDerivePieceRequest {
  kind: 'derive_piece'
  input: PieceDeriveInput
}

export type EngineRequest = EngineScoreRequest | EngineDeriveMergeRequest | EngineDerivePieceRequest

export interface EngineScoreResult {
  kind: 'score'
  pairings: PairingResult[]
  /** One merged record per meeting, holding every capture of it. */
  groups: MergeGroup[]
  /** Long recordings that hold more than one meeting. */
  splits: SplitPlan[]
  suggestions: EngineSuggestion[]
  tierCounts: Record<MergeTier, number>
}

export interface EngineDeriveResult {
  kind: 'derive'
  result: DeriveResult
}

export type EngineResult = EngineScoreResult | EngineDeriveResult

/**
 * Score every capture, group the automatic merges, and plan the splits.
 *
 * Split beats merge on a long recording: when a recorder ran across three meetings, merging
 * a capture into the whole three hours would file that meeting under the wrong title and
 * bury it. The exception is a capture that covers the recording, which means they are the
 * same meeting after all.
 */
export function runEngine(request: EngineRequest): EngineResult {
  if (request.kind === 'derive_merge') return { kind: 'derive', result: renderMergedRecord(request.input) }
  if (request.kind === 'derive_piece') return { kind: 'derive', result: renderSplitPiece(request.input) }
  if (request.kind !== 'score') throw new Error(`unknown engine request kind: ${String((request as { kind?: unknown }).kind)}`)

  const pairings = request.g2.map(recording => scoreRecording(recording, request.fireflies))
  const splits: SplitPlan[] = []
  for (const meeting of request.fireflies) {
    if (meeting.durationS < LONG_RECORDING_S) continue
    const meetingStart = meeting.startMs
    const meetingEnd = meeting.startMs + meeting.durationS * 1000
    const inside = request.g2.filter(recording =>
      recording.startMs + recording.durationMs > meetingStart && recording.startMs < meetingEnd)
    if (inside.length === 0) continue
    const plan = splitPlanFor(meeting, inside)
    if (plan.split) splits.push(plan)
  }
  const splitIds = new Set(splits.map(plan => plan.firefliesId))
  const groups = groupAutoMerges(pairings, request.g2).filter(group => !splitIds.has(group.primaryFirefliesId))

  const suggestions: EngineSuggestion[] = []
  for (const pairing of pairings) {
    if (pairing.tier !== 'suggest' || !pairing.primaryFirefliesId) continue
    suggestions.push({
      kind: 'merge',
      sessionIds: [pairing.sessionId],
      firefliesIds: [pairing.primaryFirefliesId],
      evidence: { K1: pairing.k1, K2: pairing.k2 },
    })
  }
  const tierCounts: Record<MergeTier, number> = { auto_merge: 0, suggest: 0, none: 0 }
  for (const pairing of pairings) tierCounts[pairing.tier] += 1

  return { kind: 'score', pairings, groups, splits, suggestions, tierCounts }
}

interface WorkerEnvelope {
  id: number
  request: EngineRequest
}

interface WorkerReply {
  id: number
  ok: boolean
  result?: EngineResult
  error?: string
}

if (!isMainThread && parentPort) {
  const port = parentPort
  port.on('message', (envelope: WorkerEnvelope) => {
    try {
      port.postMessage({ id: envelope.id, ok: true, result: runEngine(envelope.request) } satisfies WorkerReply)
    } catch (error) {
      port.postMessage({ id: envelope.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerReply)
    }
  })
}

/**
 * Where tsx's loader API lives, as an absolute URL.
 *
 * Two ways, because neither works everywhere: `import.meta.resolve` is absent under the
 * test runner's transform, and `createRequire` is the one that survives it. A `.js` worker
 * (a future build step) needs no loader at all.
 */
function tsxRegistrationUrl(workerUrl: URL): string | null {
  if (!workerUrl.pathname.endsWith('.ts')) return null
  try {
    if (typeof import.meta.resolve === 'function') return import.meta.resolve('tsx/esm/api')
  } catch {
    // fall through to require resolution
  }
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
  } catch {
    return null
  }
}

/**
 * Start the engine worker.
 *
 * The bootstrap runs as CommonJS (`eval`), so it uses dynamic import rather than top-level
 * await, and both URLs are absolute: a bare specifier would resolve against the process
 * working directory, which for an installed server is wherever the user started it.
 */
export function createEngineWorker(): Worker {
  const workerUrl = new URL(import.meta.url)
  const tsxUrl = tsxRegistrationUrl(workerUrl)
  const bootstrap = `
    const workerUrl = ${JSON.stringify(workerUrl.href)}
    const tsxUrl = ${JSON.stringify(tsxUrl)}
    ;(async () => {
      if (tsxUrl) {
        const tsx = await import(tsxUrl)
        tsx.register()
      }
      await import(workerUrl)
    })().catch(error => { throw error })
  `
  return new Worker(bootstrap, { eval: true })
}

/** Run one engine job on a worker thread and shut the thread down. */
export function runEngineInWorker(
  request: EngineRequest,
  options: { timeoutMs?: number } = {},
): Promise<EngineResult> {
  const timeoutMs = options.timeoutMs ?? ENGINE_WORKER_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = createEngineWorker()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('meeting engine worker timed out'))
    }, timeoutMs)
    timer.unref?.()
    const done = (action: () => void) => {
      clearTimeout(timer)
      void worker.terminate()
      action()
    }
    worker.on('message', (reply: WorkerReply) => {
      if (reply.ok && reply.result) done(() => resolve(reply.result as EngineResult))
      else done(() => reject(new Error(reply.error ?? 'meeting engine worker failed')))
    })
    worker.on('error', error => done(() => reject(error)))
    worker.on('exit', code => {
      if (code !== 0) done(() => reject(new Error(`meeting engine worker exited with ${code}`)))
    })
    worker.postMessage({ id: 1, request } satisfies WorkerEnvelope)
  })
}
