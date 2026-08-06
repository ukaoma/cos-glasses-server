// POST /api/meeting/save — finalize an existing transcribe-stream session into
// the standalone public meeting store. The live transcript and chunk metadata
// are durable before the session is closed; batch improvement runs afterward.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { Router } from 'express'
import { emitDisplay } from '../lib/display-bus.js'
import { cleanTranscriptLines } from '../lib/hallucination-filter.js'
import { durableAtomicWriteFileSync } from '../lib/atomic-fs.js'
import { appendCorrection, pendingCorrections } from '../lib/meeting-corrections.js'
import { isSampleFromSession, untraceableSampleCount } from '../lib/training-audio-provenance.js'
import { readVoiceProfiles, retractEmbeddingsBySource } from '../lib/speaker-embeddings.js'

/**
 * What a de-attributed voice becomes.
 *
 * `Ext` already means "someone who spoke and was never identified", which is
 * precisely the truth after a false attribution is removed. It is also in the
 * UNATTRIBUTED set, so the review panel treats the row as unnamed, and autoEnroll
 * skips it — a de-attributed stretch cannot re-poison a profile.
 */
const DEATTRIBUTED_LABEL = 'Ext'
import {
  invalidLabelReason,
  relabelMeetingMarkdown,
  relabelSidecarJson,
} from '../lib/meeting-relabel.js'
import {
  getMeetingStore,
  MeetingStore,
  MeetingStoreError,
  type SavedMeeting,
} from '../lib/meeting-store.js'
import {
  canDeletePendingBatchAudio,
  persistBatchDecisionSidecar,
  replaceMeetingTranscriptAtomic,
} from '../lib/meeting-batch-persistence.js'
import {
  BATCH_PENDING_MARKER,
  clearMeetingBatchProgress,
  readMeetingBatchProgress,
  writeMeetingBatchTerminal,
} from '../lib/meeting-batch-progress.js'
import {
  enqueueSerializedHqWork,
  runMeetingBatchPipeline,
  segmentTranscriptChunks,
  stopProgressiveHqSession,
  transcribeSegments,
} from '../lib/meeting-batch-transcribe.js'
import {
  clearActiveRecovery,
  findQuarantineDir,
  listUnsavedCaptures,
  markRecovered,
  registerActiveRecovery,
} from '../lib/unsaved-audio-quarantine.js'
import {
  clearSessionHallucinationState,
  stripInlineHallucinations,
} from '../lib/hallucination-filter.js'
import {
  selectBatchTranscriptForPersistence,
  type BatchTranscription,
} from '../lib/batch-transcript-quality.js'
import {
  analyzeTranscriptGaps,
  deleteSession,
  drainSessionAudioWrites,
  getSessionChunkEntries,
  getSessionChunks,
  getSessionProviderCandidates,
  getSessionStartTime,
  getSessionTranscript,
  getMeetingSessionStatus,
  hasSessionAudio,
  moveSessionAudioToPending,
  type IndexedTranscriptChunk,
  type ProviderCandidateRecord,
  type TranscriptChunk,
  type TranscriptGapReport,
} from './transcribe-stream.js'
import { getServerInstanceId } from '../lib/server-instance-id.js'
import {
  cosOperationsMeetingsConfigured,
  findCosOperationsMeetingBySessionId,
} from '../lib/cos-operations-meetings.js'
import { getOwnerSpeakerLabel } from '../lib/profile.js'
import { UNATTRIBUTED, reviewMeetingSpeakers, type ReviewChunk } from '../lib/meeting-speaker-review.js'
import {
  acquireMaintenanceWork,
  maintenanceAdmissionsOpen,
  type MaintenanceWorkLease,
} from '../lib/maintenance-lifecycle.js'
import {
  claimMeetingInOperations,
  earlyMeetingSyncEnabled,
  handoffMeetingToOperations,
} from '../lib/g2-ops-handoff.js'
import {
  canonicalFinalizationIsComplete,
  MeetingFinalizationJobStore,
  markCanonicalFinalizationState,
  readFinalizationChunkEntries,
  type MeetingFinalizationJob,
} from '../lib/meeting-finalization-jobs.js'

function cosOpsPipelineConfigured(): boolean {
  // Read env live (not the module-load COS_SCRIPTS_DIR const) so unit tests that
  // clear ops env stay standalone, and Control-updated env is visible.
  return Boolean(process.env.COS_SCRIPTS_DIR?.trim())
}

interface MeetingSessionSource {
  getTranscript(sessionId: string): string | null
  getStartTime(sessionId: string): number | null
  getChunks(sessionId: string): TranscriptChunk[] | null
  getChunkEntries(sessionId: string): IndexedTranscriptChunk[] | null
  getProviderCandidates(sessionId: string): Record<string, ProviderCandidateRecord>
  getIntegrity(sessionId: string): TranscriptGapReport | null
  drainAudioWrites(sessionId: string): Promise<void>
  hasAudio(sessionId: string): boolean
  moveAudioToPending(sessionId: string): string | null
  delete(sessionId: string, options?: { preserveAudio?: boolean }): void
}

export interface MeetingRouteDependencies {
  store?: MeetingStore
  sessions?: MeetingSessionSource
  runBatch?: (
    audioDir: string,
    entries: IndexedTranscriptChunk[],
    streamingWordCount: number,
    sessionId?: string,
  ) => Promise<BatchTranscription>
  scheduleBackground?: (task: Promise<void>) => void
  emit?: typeof emitDisplay
  finalizationJobs?: MeetingFinalizationJobStore
}

const activeFinalizationJobs = new Set<string>()
const finalizationRetryCounts = new Map<string, number>()

interface FinalizationRuntime {
  finalizationJobs: MeetingFinalizationJobStore
  runBatch: NonNullable<MeetingRouteDependencies['runBatch']>
  scheduleBackground: (task: Promise<void>) => void
  sessions?: MeetingSessionSource
}

function validReplayEntries(raw: unknown[]): IndexedTranscriptChunk[] | null {
  const entries: IndexedTranscriptChunk[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const candidate = item as { chunkIndex?: unknown; chunk?: unknown }
    if (!Number.isInteger(candidate.chunkIndex) || (candidate.chunkIndex as number) < 0) return null
    if (!candidate.chunk || typeof candidate.chunk !== 'object' || Array.isArray(candidate.chunk)) return null
    const chunk = candidate.chunk as Partial<TranscriptChunk>
    if (typeof chunk.text !== 'string' || typeof chunk.speaker !== 'string') return null
    if (typeof chunk.elapsed !== 'number' || !Number.isFinite(chunk.elapsed)) return null
    if (typeof chunk.similarity !== 'number' || !Number.isFinite(chunk.similarity)) return null
    entries.push({ chunkIndex: candidate.chunkIndex as number, chunk: chunk as TranscriptChunk })
  }
  return entries.length > 0 ? entries : null
}

function scheduleFinalizationJob(job: MeetingFinalizationJob, runtime: FinalizationRuntime): void {
  const key = `${runtime.finalizationJobs.root}:${job.sessionId}`
  if (activeFinalizationJobs.has(key)) return
  activeFinalizationJobs.add(key)

  // Acquire before the foreground save lease can leave scope: there is no
  // zero-count proof gap between pending-audio handoff and queued finalizer.
  const lease = acquireMaintenanceWork('meeting_batch_finalization', {
    allowDuringDrain: true,
    phase: 'queued',
  })
  const task = Promise.resolve().then(async () => {
    lease.setPhase('active')
    let current = runtime.finalizationJobs.get(job.sessionId) ?? job
    if (canonicalFinalizationIsComplete(current)) {
      runtime.finalizationJobs.remove(current.sessionId)
      return
    }
    if (current.phase === 'capture_pending') {
      const source = runtime.sessions ?? defaultSessionSource
      let audioDir = current.audioDir ?? runtime.finalizationJobs.findPendingAudioDir(current.sessionId)
      if (!audioDir && source.hasAudio(current.sessionId)) {
        try { await source.drainAudioWrites(current.sessionId) } catch { /* retain surviving evidence */ }
        audioDir = source.moveAudioToPending(current.sessionId)
        source.delete(current.sessionId, { preserveAudio: !audioDir })
      }
      const rawEntries = readFinalizationChunkEntries(current)
      current = runtime.finalizationJobs.save({
        sessionId: current.sessionId,
        meetingPath: current.meetingPath,
        sidecarPath: current.sidecarPath,
        audioDir,
        streamingWordCount: current.streamingWordCount,
        phase: audioDir && rawEntries?.length ? 'batch_pending' : 'ops_pending',
        claimPending: current.claimPending,
      })
      markCanonicalFinalizationState(current.sidecarPath, current.phase, current.claimPending)
    }

    if (current.claimPending) {
      let claimPending: boolean = current.claimPending
      if (earlyMeetingSyncEnabled()) {
        try {
          await claimMeetingInOperations(current.meetingPath)
          claimPending = false
        } catch (error) {
          // Identity acceleration must never strand canonical HQ/final sync.
          // Keep the durable bit for replay while the final handoff proceeds.
          console.warn(
            `[meeting/save] Early claim deferred for ${current.sessionId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } else {
        // Runtime rollback: disabling the canary must release old claim work.
        claimPending = false
      }
      current = runtime.finalizationJobs.save({
        sessionId: current.sessionId,
        meetingPath: current.meetingPath,
        sidecarPath: current.sidecarPath,
        audioDir: current.audioDir,
        streamingWordCount: current.streamingWordCount,
        phase: current.phase,
        claimPending,
      })
      markCanonicalFinalizationState(current.sidecarPath, current.phase, claimPending)
    }

    if (current.phase === 'batch_pending') {
      if (current.audioDir && existsSync(current.audioDir)) {
        const rawEntries = readFinalizationChunkEntries(current)
        const entries = rawEntries ? validReplayEntries(rawEntries) : null
        if (!entries) throw new Error('Durable finalization sidecar has no valid chunkEntries')
        await finalizeBatch({
          audioDir: current.audioDir,
          entries,
          streamingWordCount: current.streamingWordCount,
          meetingPath: current.meetingPath,
          sidecarPath: current.sidecarPath,
          sessionId: current.sessionId,
          runBatch: runtime.runBatch,
        })
      } else {
        console.warn(`[meeting/save] Pending HQ audio missing for ${current.sessionId}; preserving streaming canonical`)
      }
      current = runtime.finalizationJobs.save({
        sessionId: current.sessionId,
        meetingPath: current.meetingPath,
        sidecarPath: current.sidecarPath,
        audioDir: current.audioDir,
        streamingWordCount: current.streamingWordCount,
        phase: 'ops_pending',
        claimPending: current.claimPending,
      })
      markCanonicalFinalizationState(current.sidecarPath, 'ops_pending', current.claimPending)
    }

    if (cosOpsPipelineConfigured()) {
      await handoffMeetingToOperations(current.meetingPath)
    }
    markCanonicalFinalizationState(current.sidecarPath, 'complete', false)
    runtime.finalizationJobs.remove(current.sessionId)
    finalizationRetryCounts.delete(key)
  }).catch(error => {
    const current = runtime.finalizationJobs.get(job.sessionId) ?? job
    try {
      runtime.finalizationJobs.save({
        sessionId: current.sessionId,
        meetingPath: current.meetingPath,
        sidecarPath: current.sidecarPath,
        audioDir: current.audioDir,
        streamingWordCount: current.streamingWordCount,
        phase: current.phase,
        claimPending: current.claimPending,
        lastError: error instanceof Error ? error.message : String(error),
      })
    } catch { /* keep the original durable job if error annotation fails */ }
    console.error(
      `[meeting/save] Durable finalization retained for retry (${job.sessionId}): `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    const retryCount = finalizationRetryCounts.get(key) ?? 0
    if (retryCount < 2) {
      finalizationRetryCounts.set(key, retryCount + 1)
      const retryRetained = () => {
        if (!maintenanceAdmissionsOpen()) {
          const waitForAdmissions = setTimeout(retryRetained, 30_000)
          waitForAdmissions.unref()
          return
        }
        const retained = runtime.finalizationJobs.get(job.sessionId)
        if (retained) scheduleFinalizationJob(retained, runtime)
      }
      const retry = setTimeout(retryRetained, 60_000 * (retryCount + 1))
      retry.unref()
    }
  }).finally(() => {
    activeFinalizationJobs.delete(key)
    lease.release()
  })
  runtime.scheduleBackground(task)
}

/** Boot hook: replay post-save HQ/operations work whose response already
 * succeeded before a prior process exited. Safe to call more than once. */
export function resumeMeetingFinalizationJobs(): void {
  const finalizationJobs = new MeetingFinalizationJobStore()
  finalizationJobs.reconcileCanonicalSidecars()
  for (const job of finalizationJobs.list()) {
    scheduleFinalizationJob(job, {
      finalizationJobs,
      runBatch: runMeetingBatchPipeline,
      scheduleBackground: task => { void task },
    })
  }
}

const defaultSessionSource: MeetingSessionSource = {
  getTranscript: sessionId => getSessionTranscript(sessionId, { withGaps: true }),
  getStartTime: getSessionStartTime,
  getChunks: getSessionChunks,
  getChunkEntries: getSessionChunkEntries,
  getProviderCandidates: getSessionProviderCandidates,
  getIntegrity: analyzeTranscriptGaps,
  drainAudioWrites: drainSessionAudioWrites,
  hasAudio: hasSessionAudio,
  moveAudioToPending: moveSessionAudioToPending,
  delete: deleteSession,
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function cleanFinalTranscript(transcript: string): string {
  try {
    return process.env.COS_WHISPER_STRIP_BRAND_URLS === '0'
      ? transcript
      : cleanTranscriptLines(transcript)
  } catch {
    return transcript
  }
}

function publicSaveResponse(saved: SavedMeeting, replayed = false): Record<string, unknown> {
  const integrity = saved.transferIntegrity ?? null
  const missingCount = integrity?.missingIndices.length ?? 0
  const completenessPct = integrity
    ? Math.floor(integrity.completeness * 1_000) / 10
    : 100
  return {
    receiptVersion: 1,
    serverInstanceId: getServerInstanceId(),
    saved: true,
    // Keep the build199 string field without leaking an absolute host path.
    filepath: `recordings/${saved.month}/${saved.filename}`,
    filename: saved.filename,
    durationMin: saved.durationMin,
    domain: saved.domain,
    transcriptionQuality: 'streaming',
    ...(replayed ? { replayed: true } : {}),
    transferIntegrity: integrity ? {
      completeness: completenessPct,
      received: integrity.received,
      expected: integrity.expected,
      missingChunks: missingCount,
      missingIndices: integrity.missingIndices.slice(0, 50),
    } : null,
  }
}

function suppliedServerPin(
  req: { get: (name: string) => string | undefined },
  fallback: unknown,
): string | null {
  const header = req.get('X-COS-Server-Instance')?.trim() ?? ''
  const secondary = typeof fallback === 'string' ? fallback.trim() : ''
  if (header && secondary && header !== secondary) return '__conflict__'
  return header || secondary || null
}

export function createMeetingRouter(deps: MeetingRouteDependencies = {}): Router {
  const store = deps.store ?? getMeetingStore()
  const sessions = deps.sessions ?? defaultSessionSource
  const runBatch = deps.runBatch ?? runMeetingBatchPipeline
  const scheduleBackground = deps.scheduleBackground ?? (task => { void task })
  const emit = deps.emit ?? emitDisplay
  const finalizationJobs = deps.finalizationJobs ?? new MeetingFinalizationJobStore()
  const router = Router()
  const savingSessions = new Set<string>()

  router.get('/meeting/sessions/:sessionId/status', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    const serverInstanceId = getServerInstanceId()
    if (!serverInstanceId) {
      res.status(503).json({ error: 'Server identity unavailable', reason: 'server_identity_unavailable' })
      return
    }
    const pin = suppliedServerPin(req, req.query.serverInstanceId)
    if (pin && pin !== serverInstanceId) {
      res.status(409).json({ error: 'Server identity mismatch', reason: 'server_instance_mismatch' })
      return
    }
    const saved = store.findBySessionId(sessionId)
    const live = getMeetingSessionStatus(sessionId)
    res.set('Cache-Control', 'private, no-store')
    res.json({
      sessionId,
      state: saved ? 'saved' : live.state,
      serverInstanceId,
      receivedRanges: live.receivedRanges,
      receivedCount: live.receivedCount,
      asrCompletedRanges: live.asrCompletedRanges,
      asrCompletedCount: live.asrCompletedCount,
      canonicalRanges: live.canonicalRanges,
      canonicalCount: live.canonicalCount,
      maxChunkIndex: live.maxChunkIndex,
      lastActivityAt: live.lastActivityAt,
      retainedUntil: saved ? null : live.retainedUntil,
      saveReceipt: saved ? publicSaveResponse(saved) : null,
    })
  })

  router.post('/meeting/save', async (req, res) => {
    let lockedSessionId: string | null = null
    let maintenanceLease: MaintenanceWorkLease | undefined
    try {
      const body = req.body as Record<string, unknown> | undefined
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId required', reason: 'missing_session_id' })
        return
      }
      if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
        res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
        return
      }
      if (body?.title !== undefined && typeof body.title !== 'string') {
        res.status(400).json({ error: 'Invalid title', reason: 'invalid_title' })
        return
      }
      if (body?.domain !== undefined && typeof body.domain !== 'string') {
        res.status(400).json({ error: 'Invalid domain', reason: 'invalid_domain' })
        return
      }
      const serverInstanceId = getServerInstanceId()
      if (!serverInstanceId) {
        res.status(503).json({ error: 'Server identity unavailable', reason: 'server_identity_unavailable' })
        return
      }
      const pin = suppliedServerPin(req, body?.serverInstanceId)
      if (pin && pin !== serverInstanceId) {
        res.status(409).json({ error: 'Server identity mismatch', reason: 'server_instance_mismatch' })
        return
      }

      // A response can be lost after both durable files were committed. Find
      // the sidecar by session ID so client retry/restart is idempotent.
      const alreadySaved = store.findBySessionId(sessionId)
      if (alreadySaved) {
        finalizationJobs.reconcileCanonicalSidecars()
        const pendingJob = finalizationJobs.get(sessionId)
        if (pendingJob) scheduleFinalizationJob(pendingJob, {
          finalizationJobs,
          runBatch,
          scheduleBackground,
          sessions,
        })
        res.set('Cache-Control', 'private, no-store')
        res.json(publicSaveResponse(alreadySaved, true))
        return
      }
      if (savingSessions.has(sessionId)) {
        res.status(409).json({ error: 'Meeting save already in progress', reason: 'save_in_progress' })
        return
      }
      // Saving/finalizing an already-recording session is a drain
      // continuation. It must remain admitted so existing audio can reach a
      // durable terminal while all genuinely new work is closed.
      maintenanceLease = acquireMaintenanceWork('meeting_save', { allowDuringDrain: true })
      savingSessions.add(sessionId)
      lockedSessionId = sessionId

      const transcript = sessions.getTranscript(sessionId)
      if (!transcript?.trim()) {
        res.status(404).json({
          error: `No transcript found for session ${sessionId}`,
          reason: 'session_not_found',
        })
        return
      }

      const chunks = sessions.getChunks(sessionId) ?? []
      const chunkEntries = sessions.getChunkEntries(sessionId)
        ?? chunks.map((chunk, chunkIndex) => ({ chunkIndex, chunk }))
      const startTime = sessions.getStartTime(sessionId) ?? Date.now()
      const durationFromTimeline = chunks.reduce(
        (maximum, chunk) => Math.max(maximum, chunk?.elapsed ?? 0),
        0,
      )
      const durationMs = durationFromTimeline > 0
        ? durationFromTimeline
        : Math.max(0, Date.now() - startTime)
      const integrity = sessions.getIntegrity(sessionId)
      const needsOperations = cosOpsPipelineConfigured()
      const finalizationRequired = sessions.hasAudio(sessionId) || needsOperations
      const claimPending = needsOperations && earlyMeetingSyncEnabled()

      // Initial canonical text + structured metadata are published before any
      // live state is removed or background work is scheduled.
      const saved = store.save({
        sessionId,
        title: body?.title as string | undefined,
        domain: body?.domain as string | undefined,
        transcript: cleanFinalTranscript(transcript),
        startTime,
        durationMs,
        chunks,
        chunkEntries,
        providerCandidates: sessions.getProviderCandidates(sessionId),
        transferIntegrity: integrity,
        finalizationRequired,
        claimPending,
      })

      // Two-phase replay intent: the canonical sidecar above is the recovery
      // source of truth, and this indexed job is its fast execution ledger.
      let finalizationJob: MeetingFinalizationJob | null = null
      if (finalizationRequired) {
        finalizationJob = finalizationJobs.save({
          sessionId,
          meetingPath: saved.filepath,
          sidecarPath: saved.sidecarPath,
          audioDir: null,
          streamingWordCount: countWords(transcript),
          phase: 'capture_pending',
          claimPending,
        })
      }

      // Progressive HQ is a disposable cache, not a meeting owner. Abort any
      // in-flight prefill before the session-audio directory is atomically
      // renamed so no child can publish into a stale path after Stop.
      await stopProgressiveHqSession(sessionId)

      // Wait for every raw-WAV write before rename. If any write failed, retain
      // surviving audio for recovery but do not run an incomplete batch.
      let audioWritesReady = true
      try {
        await sessions.drainAudioWrites(sessionId)
      } catch (error) {
        audioWritesReady = false
        console.warn(
          `[meeting/save] One or more raw audio writes failed for ${sessionId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const hadSessionAudio = sessions.hasAudio(sessionId)
      // drainAudioWrites uses allSettled, so even its error path has no live
      // writes. Move surviving evidence to the normal two-hour pending store,
      // but do not batch an incomplete capture.
      const pendingAudioDir = hadSessionAudio ? sessions.moveAudioToPending(sessionId) : null
      const preserveSourceAudio = hadSessionAudio && !pendingAudioDir
      sessions.delete(sessionId, { preserveAudio: preserveSourceAudio })
      if (preserveSourceAudio) {
        console.warn(`[meeting/save] Source audio for ${sessionId} retained after failed pending handoff`)
      }

      try {
        emit({
          type: 'recording_stop',
          data: {
            sessionId,
            filename: saved.filename,
            durationMin: saved.durationMin,
            domain: saved.domain,
          },
        })
      } catch (error) {
        console.warn('[meeting/save] Display notification failed after durable save:', error)
      }

      const canBatch = audioWritesReady && pendingAudioDir && chunkEntries.length > 0
      if (canBatch || needsOperations) {
        // The replay record is durable before the response. A lost response,
        // process crash, or macOS update can therefore resume the exact same
        // meeting without minting a second scribe.
        finalizationJob = finalizationJobs.save({
          sessionId,
          meetingPath: saved.filepath,
          sidecarPath: saved.sidecarPath,
          audioDir: canBatch ? pendingAudioDir : null,
          streamingWordCount: countWords(transcript),
          phase: canBatch ? 'batch_pending' : 'ops_pending',
          claimPending,
        })
        markCanonicalFinalizationState(saved.sidecarPath, finalizationJob.phase, claimPending)
      } else if (finalizationJob) {
        markCanonicalFinalizationState(saved.sidecarPath, 'complete', false)
        finalizationJobs.remove(sessionId)
        finalizationJob = null
      }

      res.set('Cache-Control', 'private, no-store')
      res.json(publicSaveResponse(saved))

      if (finalizationJob) {
        scheduleFinalizationJob(finalizationJob, {
          finalizationJobs,
          runBatch,
          scheduleBackground,
          sessions,
        })
      }
    } catch (error) {
      if (error instanceof MeetingStoreError) {
        res.status(error.status).json({ error: error.message, reason: error.code })
        return
      }
      console.error('[meeting/save] Finalization failed:', error)
      res.status(500).json({ error: 'Meeting save failed', reason: 'meeting_save_error' })
    } finally {
      maintenanceLease?.release()
      if (lockedSessionId) savingSessions.delete(lockedSessionId)
    }
  })

  // ── Speaker review (6.21.12) ──────────────────────────────────────────
  // Backs COS Control's naming panel. Read-only: it reports what a saved
  // meeting's sidecar already contains and never writes. Naming, merging, and
  // rebuilding are the /api/voice/* routes, each with its own confirmation.
  //
  // Keyed on sessionId so it can reuse the store's traversal-hardened readers
  // (safeDirectoryRealpath / safeReadFile) instead of reassembling a path from
  // client-supplied domain and filename components.
  router.get('/meeting/:sessionId/speakers', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    // Prefer the COS operations copy when configured. The same session exists in
    // both trees under different names — the standalone store keeps the raw
    // capture name, operations holds the titled copy — and the meetings LIST
    // reads operations. Resolving the store first would show one title on the row
    // and a different one in this panel for the same meeting.
    const operations = cosOperationsMeetingsConfigured()
      ? findCosOperationsMeetingBySessionId(sessionId)
      : null
    const saved = operations ? null : store.findBySessionId(sessionId)
    if (!operations && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const sidecarPath = operations?.sidecarPath ?? saved!.sidecarPath
    const title = operations?.title ?? saved!.title
    const domain = operations?.domain ?? saved!.domain
    const filename = operations?.filename ?? saved!.filename

    let chunks: unknown
    try {
      const raw = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as Record<string, unknown>
      chunks = Array.isArray(raw) ? raw : raw.chunks
    } catch {
      // Defensive: both lookups above already read this sidecar to match the
      // session, so a corrupt file 404s and never reaches here. This covers the
      // narrow race where it becomes unreadable in between. Either
      // way the answer is never 200-with-no-voices, which would read as
      // "nobody spoke" and invite naming voices that were never analysed.
      res.status(422).json({ error: 'Chunk sidecar is missing or unreadable', reason: 'sidecar_unreadable' })
      return
    }
    if (!Array.isArray(chunks)) {
      res.status(422).json({ error: 'Chunk sidecar holds no chunk array', reason: 'sidecar_empty' })
      return
    }

    const review = reviewMeetingSpeakers(chunks as ReviewChunk[], {
      owner: getOwnerSpeakerLabel(),
      phrasesPerVoice: Math.max(1, Math.min(6, Number(req.query.phrases) || 3)),
    })
    res.set('Cache-Control', 'private, no-store')
    res.json({
      sessionId,
      title,
      domain,
      filename,
      source: operations ? 'cos_operations' : 'standalone_recordings',
      ...(saved ? { durationMin: saved.durationMin } : {}),
      ...review,
    })
  })


  // ── Per-meeting speaker relabel (6.21.16) ─────────────────────────────
  //
  // Corrects who a voice was in ONE meeting. Deliberately not a global merge:
  // Miles, on the design — "changing it doesn't mean that all previous chunks
  // should also be moved. It should be meeting by meeting, with the goal of
  // hardening or refining the voice profiles." The identifier mishearing a voice
  // in one room is not evidence that every past attribution was wrong.
  //
  // ORDER IS THE WHOLE DESIGN. The ledger intent is written BEFORE any file is
  // touched, and a failed intent write aborts without mutating anything. A
  // process that dies mid-rewrite therefore leaves a visible pending correction
  // rather than a silently half-relabelled meeting.
  router.post('/meeting/:sessionId/relabel', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }

    const from = typeof req.body?.from === 'string' ? req.body.from : ''
    const to = typeof req.body?.to === 'string' ? req.body.to : ''
    const chunks = Array.isArray(req.body?.chunks)
      ? (req.body.chunks as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
      : []
    if (Array.isArray(req.body?.chunks) && chunks.length !== req.body.chunks.length) {
      res.status(400).json({ error: 'chunks must be non-negative integers', reason: 'invalid_chunks' })
      return
    }
    for (const [which, label] of [['from', from], ['to', to]] as const) {
      const bad = invalidLabelReason(label)
      if (bad) {
        res.status(400).json({ error: `${which}: ${bad}`, reason: 'invalid_label' })
        return
      }
    }
    if (from === to) {
      res.status(400).json({ error: 'from and to are the same label', reason: 'noop_relabel' })
      return
    }

    // Same resolution as GET /speakers — operations tree first when configured,
    // so the panel and the correction act on the same copy of the meeting.
    const operations = cosOperationsMeetingsConfigured()
      ? findCosOperationsMeetingBySessionId(sessionId)
      : null
    const saved = operations ? null : store.findBySessionId(sessionId)
    if (!operations && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const sidecarPath = operations?.sidecarPath ?? saved!.sidecarPath
    const meetingPath = operations?.meetingPath ?? saved!.filepath
    const title = operations?.title ?? saved!.title

    let sidecarRaw: string
    try {
      sidecarRaw = readFileSync(sidecarPath, 'utf-8')
    } catch {
      res.status(422).json({ error: 'Chunk sidecar is missing or unreadable', reason: 'sidecar_unreadable' })
      return
    }

    const plan = relabelSidecarJson(sidecarRaw, from, to, chunks)
    if (!plan.ok) {
      res.status(422).json({ error: plan.error, reason: 'relabel_rejected' })
      return
    }

    // The markdown may only be rewritten when EVERY chunk carrying `from` is
    // covered. Its turn segmentation does not match the sidecar's, so a partial
    // relabel has no way to know which turns the selected chunks became.
    let markdownRaw: string | null = null
    let markdownPlan: ReturnType<typeof relabelMeetingMarkdown> | null = null
    if (plan.value.coveredAllWithLabel) {
      try {
        markdownRaw = readFileSync(meetingPath, 'utf-8')
        markdownPlan = relabelMeetingMarkdown(markdownRaw, from, to)
      } catch {
        markdownRaw = null   // sidecar-only correction; reported in the response
      }
    }
    const md = markdownPlan?.ok ? markdownPlan.value : null

    const surfaces = {
      sidecar: plan.value.changed.length,
      attendees: md?.attendees ?? 0,
      transcript: md?.transcript ?? 0,
    }
    const preview = {
      sessionId,
      title,
      from,
      to,
      scope: 'meeting' as const,
      chunks: plan.value.changed,
      surfaces,
      partial: !plan.value.coveredAllWithLabel,
      remainingWithFrom: plan.value.remainingWithFrom,
      speakersAfter: plan.value.speakers,
      proseStale: md?.proseStale ?? false,
      proseHits: md?.proseHits ?? [],
      markdownSkipped: !plan.value.coveredAllWithLabel
        ? 'partial relabel: transcript turns cannot be mapped to chunk indices'
        : markdownRaw === null ? 'meeting markdown unreadable' : null,
    }

    if (req.body?.dryRun === true || req.body?.confirm !== true) {
      res.status(req.body?.dryRun === true ? 200 : 400).json({
        ...(req.body?.dryRun === true ? {} : { error: 'confirmation required', reason: 'confirmation_required' }),
        message: `Relabelling ${surfaces.sidecar} chunk(s) from "${from}" to "${to}" in this meeting`
          + (preview.proseStale
            ? '. The summary and decisions still name the old speaker and are NOT rewritten — '
              + `prose refers to people by first name (${preview.proseHits.join(', ')}), `
              + 'so substituting it could rewrite a sentence about someone else.'
            : '.'),
        ...preview,
      })
      return
    }

    // A prior correction that never closed means this meeting's files may already
    // be half-written. Refuse rather than layering a second rewrite on top.
    const stalled = pendingCorrections(sessionId)
    if (stalled.length > 0 && req.body?.force !== true) {
      res.status(409).json({
        error: 'a previous correction on this meeting never completed',
        reason: 'correction_pending',
        pending: stalled.map(r => ({ id: r.id, at: r.at, from: r.from, to: r.to })),
        message: 'Its files may be partly rewritten. Re-check the meeting, then pass { force: true } to proceed.',
      })
      return
    }

    const id = `${sessionId}:${from}>${to}:${Date.now().toString(36)}`
    const at = new Date().toISOString()
    // Intent first. If this cannot be written, nothing is mutated — an
    // unrecorded rewrite is the exact failure the ledger exists to prevent.
    if (!appendCorrection(sessionId, { id, phase: 'intent', at, from, to, chunks: plan.value.changed, scope: 'meeting' })) {
      res.status(500).json({
        error: 'could not record the correction, so nothing was changed',
        reason: 'ledger_unwritable',
      })
      return
    }

    try {
      durableAtomicWriteFileSync(sidecarPath, plan.value.json, { mode: 0o600 })
      if (md && (md.attendees > 0 || md.transcript > 0)) {
        durableAtomicWriteFileSync(meetingPath, md.markdown, { mode: 0o600 })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      appendCorrection(sessionId, {
        id, phase: 'failed', at: new Date().toISOString(), from, to,
        chunks: plan.value.changed, scope: 'meeting', error: message,
      })
      res.status(500).json({ error: `relabel failed: ${message}`, reason: 'write_failed' })
      return
    }

    appendCorrection(sessionId, {
      id, phase: 'applied', at: new Date().toISOString(), from, to,
      chunks: plan.value.changed, scope: 'meeting', surfaces,
      proseStale: preview.proseStale,
    })

    res.json({ ok: true, correctionId: id, ...preview })
  })


  // ── De-attribution (6.21.18) ──────────────────────────────────────────
  //
  // The inverse of naming an unknown voice: this voice was NOT that person.
  //
  // Miles, on the 2026-08-06 Ditto meeting: none of the eleven attributed
  // voices were actually in the room, and there was no way to say so. Naming an
  // unknown was possible; un-naming a wrong guess was not.
  //
  // It undoes MORE than a label. When a voice is falsely attributed the
  // identifier may also have auto-enrolled those segments into that person's
  // profile, so the wrong voice is now part of what the system thinks they sound
  // like and will keep matching. Removing only the label fixes the transcript and
  // leaves the profile poisoned — the exact mechanism that grew the phantom
  // "Erick Hernandez" from 3 mislabelled seeds to 18 samples.
  router.post('/meeting/:sessionId/deattribute', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    const from = typeof req.body?.from === 'string' ? req.body.from : ''
    const bad = invalidLabelReason(from)
    if (bad) {
      res.status(400).json({ error: `from: ${bad}`, reason: 'invalid_label' })
      return
    }
    if (UNATTRIBUTED.has(from)) {
      res.status(400).json({ error: `"${from}" is already unattributed`, reason: 'already_unattributed' })
      return
    }
    const chunks = Array.isArray(req.body?.chunks)
      ? (req.body.chunks as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
      : []
    if (Array.isArray(req.body?.chunks) && chunks.length !== req.body.chunks.length) {
      res.status(400).json({ error: 'chunks must be non-negative integers', reason: 'invalid_chunks' })
      return
    }
    // Retracting the training samples is the part that improves accuracy over
    // time, so it defaults ON. Opt out to fix a transcript without touching the
    // profile.
    const retractTraining = req.body?.retractTraining !== false

    const operations = cosOperationsMeetingsConfigured()
      ? findCosOperationsMeetingBySessionId(sessionId)
      : null
    const saved = operations ? null : store.findBySessionId(sessionId)
    if (!operations && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const sidecarPath = operations?.sidecarPath ?? saved!.sidecarPath
    const meetingPath = operations?.meetingPath ?? saved!.filepath
    const title = operations?.title ?? saved!.title

    let sidecarRaw: string
    try {
      sidecarRaw = readFileSync(sidecarPath, 'utf-8')
    } catch {
      res.status(422).json({ error: 'Chunk sidecar is missing or unreadable', reason: 'sidecar_unreadable' })
      return
    }

    // The voice becomes `Ext` — an external speaker who was never identified,
    // which is exactly what an un-named voice is. autoEnroll skips Ext, so a
    // de-attributed stretch cannot re-poison anything.
    const plan = relabelSidecarJson(sidecarRaw, from, DEATTRIBUTED_LABEL, chunks)
    if (!plan.ok) {
      res.status(422).json({ error: plan.error, reason: 'deattribute_rejected' })
      return
    }

    // What this would remove from the profile, and what it CANNOT reach.
    // readVoiceProfiles returns a ProfileStore, not an array.
    const profile = readVoiceProfiles().profiles.find(p => p.name === from)
    const profileSources: Array<string | undefined> = profile
      ? Array.from({ length: profile.embeddings.length }, (_, i) => profile.sources?.[i])
      : []
    const traceable = profileSources.filter(sourceString => isSampleFromSession(sourceString, sessionId)).length
    const untraceable = untraceableSampleCount(profileSources)

    let markdownPlan: ReturnType<typeof relabelMeetingMarkdown> | null = null
    if (plan.value.coveredAllWithLabel) {
      try {
        markdownPlan = relabelMeetingMarkdown(readFileSync(meetingPath, 'utf-8'), from, DEATTRIBUTED_LABEL)
      } catch { markdownPlan = null }
    }
    const md = markdownPlan?.ok ? markdownPlan.value : null

    const surfaces = {
      sidecar: plan.value.changed.length,
      attendees: md?.attendees ?? 0,
      transcript: md?.transcript ?? 0,
    }
    const preview = {
      sessionId,
      title,
      from,
      to: DEATTRIBUTED_LABEL,
      scope: 'meeting' as const,
      chunks: plan.value.changed,
      surfaces,
      partial: !plan.value.coveredAllWithLabel,
      speakersAfter: plan.value.speakers,
      training: {
        retract: retractTraining,
        wouldRetract: retractTraining ? traceable : 0,
        profileSamples: profileSources.length,
        // Honest about reach: samples written before train-g2 started stamping
        // the session cannot be tied to a meeting and survive this.
        untraceable,
      },
      proseStale: md?.proseStale ?? false,
      proseHits: md?.proseHits ?? [],
    }

    if (req.body?.dryRun === true || req.body?.confirm !== true) {
      const notes: string[] = []
      if (retractTraining && traceable > 0) {
        notes.push(`${traceable} training sample(s) from this meeting will be removed from "${from}"`)
      }
      if (retractTraining && traceable === 0) {
        notes.push(`no training sample from this meeting is traceable to "${from}", so the profile is unchanged`)
      }
      if (untraceable > 0) {
        notes.push(`${untraceable} older sample(s) on "${from}" carry no meeting provenance and cannot be retracted`)
      }
      res.status(req.body?.dryRun === true ? 200 : 400).json({
        ...(req.body?.dryRun === true ? {} : { error: 'confirmation required', reason: 'confirmation_required' }),
        message: `Removing "${from}" from ${surfaces.sidecar} segment(s) of this meeting. ${notes.join('. ')}`.trim(),
        ...preview,
      })
      return
    }

    const stalled = pendingCorrections(sessionId)
    if (stalled.length > 0 && req.body?.force !== true) {
      res.status(409).json({
        error: 'a previous correction on this meeting never completed',
        reason: 'correction_pending',
        pending: stalled.map(r => ({ id: r.id, at: r.at, from: r.from, to: r.to })),
      })
      return
    }

    const id = `${sessionId}:${from}>deattributed:${Date.now().toString(36)}`
    const at = new Date().toISOString()
    if (!appendCorrection(sessionId, {
      id, phase: 'intent', at, from, to: DEATTRIBUTED_LABEL, chunks: plan.value.changed, scope: 'meeting',
    })) {
      res.status(500).json({
        error: 'could not record the de-attribution, so nothing was changed',
        reason: 'ledger_unwritable',
      })
      return
    }

    let retracted = 0
    try {
      durableAtomicWriteFileSync(sidecarPath, plan.value.json, { mode: 0o600 })
      if (md && (md.attendees > 0 || md.transcript > 0)) {
        durableAtomicWriteFileSync(meetingPath, md.markdown, { mode: 0o600 })
      }
      // Profile retraction happens AFTER the transcript is corrected: if the
      // write fails, the ledger shows an unclosed intent and the profile has not
      // yet been touched, which is the recoverable order.
      if (retractTraining && traceable > 0) {
        retracted = retractEmbeddingsBySource(from, s => isSampleFromSession(s, sessionId)).removed
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      appendCorrection(sessionId, {
        id, phase: 'failed', at: new Date().toISOString(), from, to: DEATTRIBUTED_LABEL,
        chunks: plan.value.changed, scope: 'meeting', error: message,
      })
      res.status(500).json({ error: `de-attribution failed: ${message}`, reason: 'write_failed' })
      return
    }

    appendCorrection(sessionId, {
      id, phase: 'applied', at: new Date().toISOString(), from, to: DEATTRIBUTED_LABEL,
      chunks: plan.value.changed, scope: 'meeting', surfaces, proseStale: preview.proseStale,
    })

    res.json({
      ok: true,
      correctionId: id,
      ...preview,
      training: { ...preview.training, retracted },
    })
  })

  // ── Unsaved-capture recovery (6.19.0) ─────────────────────────────────
  // Surface-only by decision (Miles, 2026-08-02): the server NEVER drives
  // recovery on its own. It lists what the quarantine holds, and one
  // authenticated POST drives one capture to a durable scribe.
  const recoveringOrphans = new Set<string>()

  router.get('/meeting/orphans', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const items = listUnsavedCaptures()
    // In-flight recovery progress: transcribeSegments writes its progress file
    // into the quarantine dir, invisible to meeting_sync (different root) —
    // surface it here so a long recovery is not a black box.
    const recoveringProgress: Record<string, { segmentsDone: number; segmentsTotal: number } | null> = {}
    for (const id of recoveringOrphans) {
      const dir = findQuarantineDir(id)
      const progress = dir ? readMeetingBatchProgress(dir) : null
      recoveringProgress[id] = progress
        ? { segmentsDone: progress.segmentsDone, segmentsTotal: progress.segmentsTotal }
        : null
    }
    res.json({
      count: items.filter(item => !item.recovered).length,
      recovering: [...recoveringOrphans],
      recoveringProgress,
      items,
    })
  })

  router.post('/meeting/orphans/:sessionId/recover', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    if (body.title !== undefined && typeof body.title !== 'string') {
      res.status(400).json({ error: 'Invalid title', reason: 'invalid_title' })
      return
    }
    if (body.domain !== undefined && typeof body.domain !== 'string') {
      res.status(400).json({ error: 'Invalid domain', reason: 'invalid_domain' })
      return
    }
    // Idempotent: a capture that already reached a durable save replays its
    // receipt — same contract as POST /meeting/save.
    const alreadySaved = store.findBySessionId(sessionId)
    if (alreadySaved) {
      // Stamp the quarantine receipt too, or a saved-but-quarantined capture
      // (e.g. save succeeded but the pending handoff failed, marker expired,
      // sweep quarantined the leftovers — the meeting IS saved) counts as
      // "unsaved" on health forever, a false alarm that trains the user to
      // ignore the one channel built to report real losses.
      const staleQuarantine = findQuarantineDir(sessionId)
      if (staleQuarantine) markRecovered(staleQuarantine, alreadySaved.filename)
      res.set('Cache-Control', 'private, no-store')
      res.json({ accepted: false, alreadySaved: true, receipt: publicSaveResponse(alreadySaved, true) })
      return
    }
    const quarantineDir = findQuarantineDir(sessionId)
    if (!quarantineDir) {
      res.status(404).json({ error: 'No quarantined audio for this session', reason: 'orphan_not_found' })
      return
    }
    if (recoveringOrphans.has(sessionId)) {
      res.status(409).json({ error: 'Recovery already in progress', reason: 'recovery_in_progress' })
      return
    }
    const capture = synthesizeEntriesFromChunkWavs(quarantineDir)
    const entries = capture.entries
    if (entries.length === 0) {
      res.status(422).json({ error: 'Quarantined directory holds no readable chunk audio', reason: 'no_chunk_audio' })
      return
    }

    // Acquire BEFORE marking the session as recovering: if a drain gate makes
    // acquire throw, nothing must linger in recoveringOrphans — a leaked entry
    // would 409 every retry for the exact capture this route exists to save.
    let lease: MaintenanceWorkLease
    try {
      lease = acquireMaintenanceWork('orphan_recovery', { phase: 'queued' })
    } catch {
      res.status(503).json({
        error: 'Server is draining for maintenance — retry after the update completes',
        reason: 'maintenance_drain',
      })
      return
    }
    recoveringOrphans.add(sessionId)
    // Registry drives two protections: meeting_sync renders this as an active
    // row (COS Control warns before an Update Server drain walks into a
    // 20-90 min decode), and purgeExpiredQuarantine will not delete the dir
    // mid-run even at the retention boundary.
    registerActiveRecovery(sessionId, quarantineDir)
    res.status(202).set('Cache-Control', 'private, no-store').json({
      accepted: true,
      sessionId,
      chunkFiles: entries.length,
      note: 'Recovery runs in the background behind the HQ decoder queue — expect minutes for a long meeting '
        + '(watch recoveringProgress on GET /api/meeting/orphans). Speakers are labeled Unknown: no live ASR ever '
        + 'ran for this capture. The capture leaves the unsaved count once its scribe is durable.',
    })

    const task = Promise.resolve().then(async () => {
      lease.setPhase('active')
      const startedAt = Date.now()
      const segments = segmentTranscriptChunks(entries)
      // transcribeSegments carries the batch contract (enhancement, Metal
      // preemption discard + one CPU retry, overlap stripping) but NOT the
      // decoder serialization — that lives in the queue tail. Chain onto it,
      // or two back-to-back recoveries plus a live post-meeting batch would
      // run parallel 16-thread large-v3 decoders on the user's Mac.
      const results = await enqueueSerializedHqWork(
        () => transcribeSegments(quarantineDir, segments, entries),
      )
      // Batch whisper over a dead session has no streaming baseline to
      // compare against (evaluateBatchQuality needs one), but the inline
      // hallucination filter needs none — run the same two-pass the boot
      // session-recovery path uses: pass 1 builds the frequency blocklist
      // across all segments, pass 2 strips with the final blocklist.
      for (const item of results) {
        if (item.text) stripInlineHallucinations(item.text, sessionId)
      }
      for (const item of results) {
        if (item.text) item.text = stripInlineHallucinations(item.text, sessionId)
      }
      clearSessionHallucinationState(sessionId)
      const transcript = cleanFinalTranscript(results.map(item => item.text).join(' '))
      if (!transcript.trim()) {
        throw new Error('recovery produced an empty transcript')
      }
      const recoveredChunks = results.map(item => ({
        text: item.text,
        speaker: 'Unknown',
        elapsed: item.segment.startElapsed,
        similarity: 0,
        words: item.words,
        canonical: true,
      }))
      const saved = store.save({
        sessionId,
        title: typeof body.title === 'string' && body.title.trim() ? body.title : undefined,
        domain: typeof body.domain === 'string' && body.domain.trim() ? body.domain : undefined,
        transcript,
        startTime: capture.startTime,
        durationMs: capture.durationMs,
        chunks: recoveredChunks,
        chunkEntries: recoveredChunks.map((chunk, position) => ({
          chunkIndex: results[position]?.segment.startChunkIdx ?? position,
          chunk,
        })),
        transferIntegrity: null,
      })
      markRecovered(quarantineDir, saved.filename)
      console.log(
        `[meeting/orphans] Recovered ${sessionId} → ${saved.filename} `
        + `(${entries.length} chunks, ${Math.round((Date.now() - startedAt) / 1000)}s)`,
      )
      try {
        emit({
          type: 'recording_stop',
          data: {
            sessionId,
            filename: saved.filename,
            durationMin: saved.durationMin,
            domain: saved.domain,
          },
        })
      } catch { /* display is best-effort */ }
      if (cosOpsPipelineConfigured()) {
        await handoffMeetingToOperations(saved.filepath)
      }
    }).catch(error => {
      // The quarantined audio is untouched on failure — retry stays possible
      // until the retention clock clears it.
      console.error(
        `[meeting/orphans] Recovery failed for ${sessionId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }).finally(() => {
      // transcribeSegments wrote progress + a pending marker into the
      // quarantine dir; the batch pipeline's own finally never runs here, so
      // clean them up or the dir carries stale work files until retention.
      try { clearMeetingBatchProgress(quarantineDir) } catch { /* best-effort */ }
      try { unlinkSync(resolve(quarantineDir, BATCH_PENDING_MARKER)) } catch { /* best-effort */ }
      clearActiveRecovery(quarantineDir)
      recoveringOrphans.delete(sessionId)
      lease.release()
    })
    scheduleBackground(task)
  })

  return router
}

const CHUNK_WAV_NAME = /^chunk_(\d{4})\.wav$/
const WAV_HEADER_BYTES = 44
const PCM_BYTES_PER_MS = 32 // 16 kHz mono 16-bit

interface RecoveredCapture {
  entries: IndexedTranscriptChunk[]
  /** Meeting start ≈ the earliest chunk's write time (chunk files keep their
   *  original mtimes across renames — the pending-batch cleanup relies on the
   *  same property). Falls back to now-minus-duration when mtimes are unusable. */
  startTime: number
  durationMs: number
}

/** Rebuild a chunk timeline for a dead session from its WAV files alone:
 *  index from the filename, duration from PCM byte length, elapsed cumulative.
 *  Text is empty — recovery exists precisely because no ASR ever ran. */
function synthesizeEntriesFromChunkWavs(audioDir: string): RecoveredCapture {
  const rows: Array<{ chunkIndex: number; durationMs: number; mtimeMs: number }> = []
  try {
    for (const name of readdirSync(audioDir)) {
      const match = CHUNK_WAV_NAME.exec(name)
      if (!match) continue
      try {
        const stats = statSync(resolve(audioDir, name))
        rows.push({
          chunkIndex: Number(match[1]),
          durationMs: Math.max(0, Math.round((stats.size - WAV_HEADER_BYTES) / PCM_BYTES_PER_MS)),
          mtimeMs: stats.mtimeMs,
        })
      } catch { /* unreadable chunk — skip */ }
    }
  } catch {
    return { entries: [], startTime: Date.now(), durationMs: 0 }
  }
  rows.sort((a, b) => a.chunkIndex - b.chunkIndex)
  let elapsed = 0
  const entries = rows.map(row => {
    const entry: IndexedTranscriptChunk = {
      chunkIndex: row.chunkIndex,
      chunk: { text: '', speaker: 'Unknown', elapsed, similarity: 0 },
    }
    elapsed += row.durationMs
    return entry
  })
  const durationMs = elapsed
  const earliestMtime = rows.reduce(
    (minimum, row) => (Number.isFinite(row.mtimeMs) && row.mtimeMs > 0 ? Math.min(minimum, row.mtimeMs) : minimum),
    Number.POSITIVE_INFINITY,
  )
  const startTime = Number.isFinite(earliestMtime) && earliestMtime !== Number.POSITIVE_INFINITY
    ? Math.round(earliestMtime)
    : Date.now() - durationMs
  return { entries, startTime, durationMs }
}

async function finalizeBatch(options: {
  audioDir: string
  entries: IndexedTranscriptChunk[]
  streamingWordCount: number
  meetingPath: string
  sidecarPath: string
  sessionId?: string
  runBatch: NonNullable<MeetingRouteDependencies['runBatch']>
}): Promise<void> {
  const result = await options.runBatch(
    options.audioDir,
    options.entries,
    options.streamingWordCount,
    options.sessionId,
  )
  let transcriptApplied = false
  let metadataPersisted = false
  let persistedResult = result

  if (result.transcriptionQuality === 'batch' && result.batchTranscript) {
    const selected = selectBatchTranscriptForPersistence(result.batchTranscript, result.batchSegments)
    const canonicalText = cleanFinalTranscript(selected.text)
    if (canonicalText.trim()) {
      transcriptApplied = replaceMeetingTranscriptAtomic(options.meetingPath, canonicalText)
    } else {
      console.error('[meeting/save] Accepted batch candidate cleaned to empty; canonical text retained')
    }
    // Metadata records the exact selected text that became canonical, while
    // batchSegments retain the full diagnostic evidence.
    persistedResult = { ...result, batchTranscript: canonicalText }
  } else if (result.qualityReport) {
    console.warn(
      `[meeting/save] Batch candidate rejected (${result.qualityReport.reason}); `
      + 'canonical streaming transcript retained',
    )
  }

  try {
    metadataPersisted = persistBatchDecisionSidecar(
      options.sidecarPath,
      persistedResult,
      transcriptApplied,
    )
  } catch (error) {
    console.error(
      '[meeting/save] Batch decision metadata was not durable:',
      error instanceof Error ? error.message : String(error),
    )
  }

  if (canDeletePendingBatchAudio(transcriptApplied, metadataPersisted)) {
    rmSync(options.audioDir, { recursive: true, force: true })
  } else {
    console.warn('[meeting/save] Pending raw audio retained for bounded cleanup')
    // The batch reached a terminal outcome but its WAVs stay behind. Record it
    // so meeting_sync reports "retained", not perpetual active work. Rejected
    // and pipeline-failed runs already wrote their terminal inside runBatch;
    // this covers the accepted-but-not-fully-persisted case.
    if (result.transcriptionQuality === 'batch') {
      writeMeetingBatchTerminal(options.audioDir, {
        outcome: 'accepted',
        reason: transcriptApplied ? 'metadata_persist_failed' : 'transcript_apply_failed',
      })
    }
  }
}

export const meetingRouter = createMeetingRouter()
