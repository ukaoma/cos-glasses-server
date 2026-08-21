// POST /api/meeting/save — finalize an existing transcribe-stream session into
// the standalone public meeting store. The live transcript and chunk metadata
// are durable before the session is closed; batch improvement runs afterward.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { isWorthRecovering } from '../lib/quarantine-auto-recover.js'
import { resolve } from 'node:path'
import { Router } from 'express'
import { emitDisplay } from '../lib/display-bus.js'
import { cleanTranscriptLines } from '../lib/hallucination-filter.js'
import { durableAtomicWriteFileSync } from '../lib/atomic-fs.js'
import { appendCorrection, appliedCorrections, pendingCorrections } from '../lib/meeting-corrections.js'
import { isSampleFromSession, untraceableSampleCount } from '../lib/training-audio-provenance.js'
import { sendAudioFile } from '../lib/send-audio.js'
import { adaptivePlaybackAudio } from '../lib/adaptive-playback-audio.js'
import { chunkDiagnostics } from '../lib/chunk-embedding-diagnostics.js'
import { errMsg } from '../lib/utils.js'
import { confirmedLabels } from '../lib/meeting-corrections.js'
import {
  extAudioChunkPath,
  listExtAudioChunks,
  listMeetingAudioChunks,
  meetingAudioChunkPath,
  meetingAudioRetentionDays,
} from '../lib/meeting-audio-archive.js'
import { readVoiceProfiles, retractEmbeddingsBySource } from '../lib/speaker-embeddings.js'
import { enrolNamedVoice } from '../lib/meeting-relabel-enrolment.js'

/**
 * The label a de-attributed voice takes, numbered within its meeting.
 *
 * NOT a shared `Ext`. De-attributing to one label folded every corrected voice
 * into a single row — on the 2026-08-06 Ditto meeting Miles named five wrong
 * attributions, and collapsing them would have destroyed his ability to tell
 * those five voices apart, which is precisely what he needs playback for next.
 *
 * `Unidentified N` is prefix-matched by isUnattributed(), so the review panel
 * treats the row as unnamed and autoEnroll skips it — a de-attributed stretch
 * cannot re-poison a profile — while staying separable.
 */
function nextDeattributedLabel(existing: string[]): string {
  const used = new Set(
    existing
      .map(s => new RegExp(`^${DEATTRIBUTED_PREFIX} (\\d+)$`).exec(s)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number),
  )
  let n = 1
  while (used.has(n)) n++
  return `${DEATTRIBUTED_PREFIX} ${n}`
}
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
  getStrandedCaptures,
  getTranscriptionSessionLiveness,
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
  findDirectLibraryMeetingBySessionId,
  findCosOperationsMeetingBySessionId,
  resolveCosOperationsDir,
} from '../lib/cos-operations-meetings.js'
import { domainForMeeting, resolveDomains } from '../lib/domains.js'
import { getOwnerSpeakerLabel } from '../lib/profile.js'
import {
  DEATTRIBUTED_PREFIX,
  attachRawChunkIndices,
  isUnattributed,
  reviewMeetingSpeakers,
  type ReviewChunk,
  type SpeakerWordSegment,
} from '../lib/meeting-speaker-review.js'
import {
  parseScribe,
  clipboardSummary,
  clipboardFull,
  meetingDate,
  SHARE_COVERAGE_FLOOR,
} from '../lib/meeting-scribe-content.js'
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

function requestedRecordMatches(requested: unknown, expected: string): boolean {
  return requested == null || requested === '' || requested === expected
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
      // The client's choice wins. When it sends none — the normal case for a G2
      // save — infer from the content instead of filing everything under one
      // domain. Keyword scoring, no model call: this runs on every save, and a
      // per-meeting LLM call would breach the recurring-caller rule.
      const filedDomain = domainForMeeting(
        body?.domain as string | undefined,
        `${(body?.title as string | undefined) ?? ''}\n${transcript}`,
        resolveCosOperationsDir(),
      )
      const saved = store.save({
        sessionId,
        title: body?.title as string | undefined,
        domain: filedDomain,
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
    const direct = operations ? null : findDirectLibraryMeetingBySessionId(sessionId)
    const saved = operations || direct ? null : store.findBySessionId(sessionId)
    if (!operations && !direct && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const sidecarPath = operations?.sidecarPath ?? direct?.sidecarPath ?? saved!.sidecarPath
    const title = operations?.title ?? direct?.title ?? saved!.title
    const domain = operations?.domain ?? direct?.domain ?? saved!.domain
    const filename = operations?.filename ?? direct?.filename ?? saved!.filename

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

    // Raw capture indices, so a phrase can address its own audio. Position in
    // `chunks` is NOT the WAV number — see attachRawChunkIndices.
    const sidecar = (JSON.parse(readFileSync(sidecarPath, 'utf-8')) ?? {}) as Record<string, unknown>
    const withIndices = attachRawChunkIndices(chunks as ReviewChunk[], sidecar.chunkEntries)
    const review = reviewMeetingSpeakers(withIndices, {
      owner: getOwnerSpeakerLabel(),
      // Labels a human already vouched for in this meeting. Without this the
      // floor re-demotes a confirmed name on every reload, and the reviewer
      // confirms the same voice forever.
      confirmed: confirmedLabels(sessionId),
      phrasesPerVoice: Math.max(1, Math.min(6, Number(req.query.phrases) || 3)),
      // The sidecar's own durationMs is the meeting's true end. Deriving it from
      // max(elapsed) uses the START of the last chunk, which made the final
      // timeline span end where it began — a 1.5pt sliver labelled "1s" for what
      // may be a long closing monologue.
      durationMs: typeof sidecar.durationMs === 'number' ? sidecar.durationMs : undefined,
      // Word-level speaker timings from the HQ batch pass, present on 82 of 92
      // measured sidecars. These give REAL voiced time per speaker; without them
      // speaking time falls back to capped chunk deltas, which still carry the
      // sub-ceiling pauses. `speakingTimeSource` on the response says which ran.
      batchSegments: Array.isArray(sidecar.batchSegments)
        ? (sidecar.batchSegments as SpeakerWordSegment[])
        : undefined,
    })
    res.set('Cache-Control', 'private, no-store')
    res.json({
      sessionId,
      title,
      domain,
      filename,
      source: operations ? 'cos_operations' : direct ? 'direct_library' : 'standalone_recordings',
      recordId: operations
        ? `ops:${operations.domain}:${operations.month}:${operations.filename}`
        : direct?.recordId ?? `standalone:${sessionId}`,
      mutable: direct == null,
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
  /**
   * The readable meeting, plus two clipboard forms.
   *
   * Resolution is operations-first, identical to GET /speakers — the same session
   * lives in both trees under different names and the list reads operations, so
   * anything keyed on a session has to resolve there too or the row and this
   * view disagree about the same meeting.
   *
   * The attendee list is REBUILT from the speaker review rather than taken from
   * the scribe's own `## Attendees`, which applies no confidence floor: the
   * 2026-08-06 IJO scribe lists 15 attendees for a 26-minute call including a
   * name already confirmed absent. Copying that verbatim would launder a guess
   * into a fact in whatever the reviewer pastes it into.
   */
  router.get('/meeting/:sessionId/content', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    const operations = cosOperationsMeetingsConfigured()
      ? findCosOperationsMeetingBySessionId(sessionId)
      : null
    const direct = operations ? null : findDirectLibraryMeetingBySessionId(sessionId)
    const saved = operations || direct ? null : store.findBySessionId(sessionId)
    if (!operations && !direct && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const sidecarPath = operations?.sidecarPath ?? direct?.sidecarPath ?? saved!.sidecarPath
    const title = operations?.title ?? direct?.title ?? saved!.title
    const mdPath = operations?.meetingPath ?? direct?.meetingPath ?? sidecarPath.replace(/\.g2-chunks\.json$/, '.md')

    let sidecar: Record<string, unknown>
    try {
      sidecar = (JSON.parse(readFileSync(sidecarPath, 'utf-8')) ?? {}) as Record<string, unknown>
    } catch {
      res.status(422).json({ error: 'Chunk sidecar is missing or unreadable', reason: 'sidecar_unreadable' })
      return
    }
    const rawChunks = Array.isArray(sidecar) ? sidecar : sidecar.chunks
    if (!Array.isArray(rawChunks)) {
      // Mirrors GET /speakers exactly. Coercing to [] returned 200 with an empty
      // floor while still shipping the full verbatim prose and transcript — the
      // worst pairing, and the two routes would have disagreed about the same
      // session (panel 422, copy buttons fine).
      res.status(422).json({ error: 'Chunk sidecar holds no chunk array', reason: 'sidecar_empty' })
      return
    }
    const chunks = rawChunks as ReviewChunk[]

    const review = reviewMeetingSpeakers(attachRawChunkIndices(chunks, sidecar.chunkEntries), {
      owner: getOwnerSpeakerLabel(),
      confirmed: confirmedLabels(sessionId),
      // This route renders no phrases; the default of 3 per voice computed and
      // discarded 48 transcript excerpts on a 16-voice meeting.
      phrasesPerVoice: 1,
      durationMs: typeof sidecar.durationMs === 'number' ? sidecar.durationMs : undefined,
      batchSegments: Array.isArray(sidecar.batchSegments)
        ? (sidecar.batchSegments as SpeakerWordSegment[])
        : undefined,
    })

    // Share is over NAMED speech and totals 100%, matching the panel. The union
    // in attributedSpeakingMs counts crosstalk once, so dividing by it would let
    // the shares exceed 100%.
    const namedTotal = review.voices.reduce((n, v) => (v.nameAsserted ? n + v.speakingMs : n), 0)
    const attendees = review.voices.map(v => ({
      label: v.label,
      asserted: v.nameAsserted,
      speakingMs: v.speakingMs,
      share: v.nameAsserted && namedTotal > 0 ? v.speakingMs / namedTotal : null,
      // WHY the name is asserted, not just that it is. The review has always
      // carried these and this route dropped them, so the clipboard credited
      // "voice matching" for the wearer exemption and for names a human typed.
      isOwner: v.isOwner,
      confirmedByHuman: v.confirmedByHuman,
    }))

    // A missing .md is not fatal — the review and the sidecar still describe the
    // meeting, and a reviewer would rather have who-spoke than a 404.
    let markdown = ''
    try { markdown = readFileSync(mdPath, 'utf-8') } catch { markdown = '' }
    const scribe = parseScribe(markdown)

    const date = meetingDate(sidecar.startTime)
    const durationMin = Math.round((review.durationMs || 0) / 60_000)
    // EXACTLY Control's speakingCoverage: attributed / (attributed + unattributed).
    // Not attributed/voicedMs — voicedMs is the union of everyone, which would
    // give a different number and let the clipboard and the panel disagree about
    // whether a share is trustworthy. Null when there is no voice at all, which
    // suppresses shares rather than dividing by zero.
    const coverageDenominator = review.attributedSpeakingMs + review.unattributedSpeakingMs
    const coverage = coverageDenominator > 0
      ? review.attributedSpeakingMs / coverageDenominator
      : null
    const clip = {
      title: scribe.title || title,
      date,
      durationMin,
      attendees,
      scribe,
      coverage,
      // The UNION, never the sum of per-voice figures — crosstalk is counted once.
      unattributedMs: review.unattributedSpeakingMs,
      voicedMs: review.voicedMs,
      // The overlap note is gated on how long the meeting RAN. Gating on voiced
      // time tripped on 16 of 23 real meetings.
      durationMs: review.durationMs || 0,
      // Names this human explicitly de-attributed. The ledger has recorded
      // `proseStale` on every applied de-attribution since the feature shipped and
      // NOTHING has ever read it: on 2026-08-07 Miles removed "Clem Ukaoma" from a
      // call that was only him and Queen, all 8 label sites were rewritten, and the
      // summary still opened "Miles, Queen, and Clem talk through..." with no
      // indication anywhere in the payload.
      removed: appliedCorrections(sessionId)
        .filter(r => isUnattributed(r.to))
        .map(r => ({ label: r.from, proseStale: r.proseStale === true })),
      // Which business this is. The sibling /speakers route has always carried
      // this and this one dropped it, so a personal 1:1 about someone's
      // compensation was byte-identical to a marketing sync.
      domain: operations?.domain ?? direct?.domain ?? saved?.domain ?? '',
      // Transcript actually captured, whether or not a write-up exists yet. 140
      // of 399 real sidecars have no .md, and the fallback text claimed there was
      // no transcript while holding one.
      capturedChars: chunks.reduce(
        (t, c) => t + (typeof c?.text === 'string' ? c.text.length : 0), 0),
    }

    // Rendered ONCE. Calling each builder twice to measure its own length meant
    // two extra full renders per request, transcript included.
    const summaryText = clipboardSummary(clip)
    const fullText = clipboardFull(clip)

    res.set('Cache-Control', 'private, no-store')
    res.json({
      sessionId,
      title: scribe.title || title,
      date,
      durationMin,
      scribeAvailable: markdown.length > 0,
      attendees,
      speakingTimeSource: review.speakingTimeSource,
      voicedMs: review.voicedMs,
      summary: scribe.summary,
      topics: scribe.topics,
      decisions: scribe.decisions,
      actions: scribe.actions,
      extras: scribe.extras.map(x => ({ heading: x.heading, body: x.body })),
      transcriptChars: scribe.transcript.length,
      // Captured vs written-up are different facts and the panel needs both:
      // transcriptChars is 0 for a meeting with 27,442 characters of speech and
      // no write-up yet.
      capturedChars: clip.capturedChars,
      domain: clip.domain,
      source: operations ? 'cos_operations' : direct ? 'direct_library' : 'standalone_recordings',
      recordId: operations
        ? `ops:${operations.domain}:${operations.month}:${operations.filename}`
        : direct?.recordId ?? `standalone:${sessionId}`,
      mutable: direct == null,
      // So the panel can warn above the write-up, not just the clipboard.
      removedNames: clip.removed,
      coverage,
      sharesReported: coverage !== null && coverage >= SHARE_COVERAGE_FLOOR,
      clipboardSummary: summaryText,
      clipboardFull: fullText,
      // Sizes of the ACTUAL strings, so the button label and the copy
      // confirmation can never quote two different numbers for one click.
      summaryChars: summaryText.length,
      fullChars: fullText.length,
    })
  })

  /**
   * Replay a recorded correction's enrolment — the retroactive path.
   *
   * WHY. Enrolment fires inside `POST /relabel`, so a voice named BEFORE that shipped
   * has a correct transcript and no profile. Kirstyn Blum is the live case: named
   * across two meetings (60 and 109 chunks), 182 mentions in the sidecars, absent from
   * a 77-profile store. Re-running the rename cannot help — she is already a real
   * name there, so the placeholder guard correctly declines.
   *
   * The correction LEDGER already holds exactly what enrolment needs: the original
   * `from`, the `to`, and the precise chunk indices, written at apply time.
   *
   * This runs IN-PROCESS on purpose. The voice store is owned by the running server,
   * which holds it in memory and rewrites it wholesale; an external process that
   * enrols directly has its work silently clobbered on the next persist. That is not
   * hypothetical — an attempt on 2026-08-13 validated cleanly, selected 20 samples,
   * and left the store untouched at its Aug 7 mtime.
   *
   * SAME GATES, no exceptions. It calls `enrolNamedVoice`, so raw-index mapping,
   * refusal when unmappable, voice coherence, the diversity cap and the
   * `correction:<sessionId>` tag all apply identically. A named `from` is still
   * enrolled when `to` is a real person — that is how a wrong existing match
   * becomes a new profile (Nick Gurney → Milo LeBaron). Placeholder targets
   * stay idle.
   *
   * FAILS CLOSED. Without `confirm: true` it reports what it would enrol and writes
   * nothing.
   */
  router.post('/meeting/:sessionId/backfill-enrolment', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    const speaker = typeof req.body?.speaker === 'string' ? req.body.speaker.trim() : ''
    if (!speaker) {
      res.status(400).json({ error: 'speaker is required', reason: 'invalid_label' })
      return
    }

    const operations = cosOperationsMeetingsConfigured()
      ? findCosOperationsMeetingBySessionId(sessionId)
      : null
    const saved = operations ? null : store.findBySessionId(sessionId)
    if (!operations && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const sidecarPath = operations?.sidecarPath ?? saved!.sidecarPath
    let parsedSidecar: Record<string, unknown> | null = null
    try {
      const doc = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as unknown
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) parsedSidecar = doc as Record<string, unknown>
    } catch {
      res.status(422).json({ error: 'Chunk sidecar is missing or unreadable', reason: 'sidecar_unreadable' })
      return
    }

    // Only rows that ACTUALLY landed, and only those that named this speaker.
    const rows = appliedCorrections(sessionId).filter(r => r.to === speaker && r.chunks.length > 0)
    if (rows.length === 0) {
      res.status(404).json({ error: `No applied correction named "${speaker}" in this meeting`, reason: 'no_correction' })
      return
    }

    const confirm = req.body?.confirm === true
    const reports = rows.map(row => ({
      correctionId: row.id,
      from: row.from,
      chunks: row.chunks.length,
      // Dry run still evaluates every gate — a preview that skips them would be a
      // guess about what the real call is going to do.
      report: enrolNamedVoice({
        sessionId, from: row.from, to: speaker, changed: row.chunks, sidecar: parsedSidecar!, dryRun: !confirm,
      }),
    }))

    res.json({
      ok: true,
      speaker,
      confirmed: confirm,
      corrections: reports,
      totals: {
        eligible: reports.filter(r => r.report.attempted > 0).length,
        skippedNamedSource: reports.filter(r => r.report.attempted === 0 && !r.report.skipped).length,
        enrolled: reports.reduce((n, r) => n + r.report.enrolled, 0),
      },
    })
  })

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
    const direct = operations ? null : findDirectLibraryMeetingBySessionId(sessionId)
    if (direct) {
      if (!requestedRecordMatches(req.body?.recordId, direct.recordId || '')) {
        res.status(409).json({ error: 'Meeting source changed; reopen the meeting', reason: 'record_source_mismatch' })
        return
      }
      res.status(409).json({
        error: 'This meeting comes from a read-only library',
        reason: 'direct_library_read_only',
        recordId: direct.recordId,
        mutable: false,
      })
      return
    }
    const saved = operations ? null : store.findBySessionId(sessionId)
    if (!operations && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const selectedRecordId = operations
      ? `ops:${operations.domain}:${operations.month}:${operations.filename}`
      : `standalone:${sessionId}`
    if (!requestedRecordMatches(req.body?.recordId, selectedRecordId)) {
      res.status(409).json({ error: 'Meeting source changed; reopen the meeting', reason: 'record_source_mismatch' })
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

    // Enrol AFTER the sidecar and ledger are durable: the rename is the thing the
    // user asked for, and a voice store that refuses must not undo it.
    //
    // `plan.value.changed` are COMPACTED SIDECAR POSITIONS. They are handed to
    // enrolNamedVoice together with the PARSED SIDECAR precisely so it can convert
    // them to raw capture indices via attachRawChunkIndices — the join 6.27.10 got
    // wrong, enrolling 73 of 103 rows belonging to other people including the
    // device owner. Never pass these positions to anything keyed on raw indices.
    //
    // `sidecarRaw` parses by construction: relabelSidecarJson already parsed it
    // above and returned ok. The catch is for a caller that reorders those steps.
    let parsedSidecar: Record<string, unknown> = {}
    try {
      const doc = JSON.parse(sidecarRaw) as unknown
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) parsedSidecar = doc as Record<string, unknown>
    } catch { /* enrolment refuses on an unusable sidecar; the rename already landed */ }

    const enrolment = enrolNamedVoice({ sessionId, from, to, changed: plan.value.changed, sidecar: parsedSidecar })
    res.json({
      ok: true,
      correctionId: id,
      // Retained for COS Control builds that read the 6.27.10 field name. The
      // `enrolment` block is the honest report: a bare count cannot say whether a
      // profile was created, whether chunks were rejected as a different voice, or
      // whether the whole thing was skipped for a nameable reason.
      enrolledEmbeddings: enrolment.enrolled,
      enrolment,
      ...preview,
    })
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
  /**
   * Confirm the identifier was RIGHT about a label the display floor demoted.
   *
   * Rewrites nothing. The sidecar already carries the label; this records that
   * a human vouched for it so the review stops presenting it as unearned.
   *
   * This exists because "yes, that really is her" was inexpressible. A rename
   * cannot say it — `relabelSidecarJson` rejects `from === to` — so the panel
   * demoted the row, instructed the reviewer to name it, and then offered a
   * candidate list that excluded the very name they wanted. The floor is a
   * guard against the IDENTIFIER over-claiming; it was never meant to overrule
   * a person who was in the room.
   *
   * Meeting-scoped, like every other correction: vouching for a voice in one
   * room says nothing about a different room.
   */
  router.post('/meeting/:sessionId/confirm', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    const label = typeof req.body?.label === 'string' ? req.body.label : ''
    const bad = invalidLabelReason(label)
    if (bad) {
      res.status(400).json({ error: `label: ${bad}`, reason: 'invalid_label' })
      return
    }

    // Same resolution as GET /speakers and the relabel route, so the panel and
    // the confirmation act on the same copy of the meeting.
    const operations = cosOperationsMeetingsConfigured()
      ? findCosOperationsMeetingBySessionId(sessionId)
      : null
    const direct = operations ? null : findDirectLibraryMeetingBySessionId(sessionId)
    if (direct) {
      if (!requestedRecordMatches(req.body?.recordId, direct.recordId || '')) {
        res.status(409).json({ error: 'Meeting source changed; reopen the meeting', reason: 'record_source_mismatch' })
        return
      }
      res.status(409).json({
        error: 'This meeting comes from a read-only library',
        reason: 'direct_library_read_only',
        recordId: direct.recordId,
        mutable: false,
      })
      return
    }
    const saved = operations ? null : store.findBySessionId(sessionId)
    if (!operations && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const selectedRecordId = operations
      ? `ops:${operations.domain}:${operations.month}:${operations.filename}`
      : `standalone:${sessionId}`
    if (!requestedRecordMatches(req.body?.recordId, selectedRecordId)) {
      res.status(409).json({ error: 'Meeting source changed; reopen the meeting', reason: 'record_source_mismatch' })
      return
    }
    const sidecarPath = operations?.sidecarPath ?? saved!.sidecarPath

    // Refuse to confirm a label the meeting does not actually carry. Otherwise
    // a typo becomes a permanent confirmation for a speaker who was never here,
    // and the ledger is append-only.
    let carried = 0
    try {
      const doc = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as Record<string, unknown>
      const rows = Array.isArray(doc.chunks) ? doc.chunks : []
      carried = rows.filter(r => r && typeof r === 'object'
        && (r as Record<string, unknown>).speaker === label).length
    } catch {
      res.status(500).json({ error: 'Could not read the chunk sidecar', reason: 'sidecar_unreadable' })
      return
    }
    if (carried === 0) {
      res.status(409).json({
        error: `No chunk in this meeting is labelled "${label}"`,
        reason: 'label_not_present',
      })
      return
    }

    const ok = appendCorrection(sessionId, {
      id: `confirm-${Date.now()}`,
      phase: 'confirmed',
      at: new Date().toISOString(),
      // `from` and `to` are the same by definition — that is what makes this a
      // confirmation rather than a rename, and why relabel could not express it.
      from: label,
      to: label,
      chunks: [],
      scope: 'meeting',
    })
    if (!ok) {
      res.status(500).json({ error: 'Could not record the confirmation', reason: 'ledger_write_failed' })
      return
    }
    res.json({ confirmed: true, label, segments: carried })
  })

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
    if (isUnattributed(from)) {
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
    const direct = operations ? null : findDirectLibraryMeetingBySessionId(sessionId)
    if (direct) {
      if (!requestedRecordMatches(req.body?.recordId, direct.recordId || '')) {
        res.status(409).json({ error: 'Meeting source changed; reopen the meeting', reason: 'record_source_mismatch' })
        return
      }
      res.status(409).json({
        error: 'This meeting comes from a read-only library',
        reason: 'direct_library_read_only',
        recordId: direct.recordId,
        mutable: false,
      })
      return
    }
    const saved = operations ? null : store.findBySessionId(sessionId)
    if (!operations && !saved) {
      res.status(404).json({ error: 'No saved meeting for this session', reason: 'meeting_not_found' })
      return
    }
    const selectedRecordId = operations
      ? `ops:${operations.domain}:${operations.month}:${operations.filename}`
      : `standalone:${sessionId}`
    if (!requestedRecordMatches(req.body?.recordId, selectedRecordId)) {
      res.status(409).json({ error: 'Meeting source changed; reopen the meeting', reason: 'record_source_mismatch' })
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

    // A NUMBERED unidentified label, unique within this meeting, so removing
    // several wrong names does not merge those voices together.
    let existingSpeakers: string[] = []
    try {
      const parsed = JSON.parse(sidecarRaw) as { speakers?: unknown; chunks?: unknown }
      existingSpeakers = Array.isArray(parsed.speakers)
        ? parsed.speakers.filter((x): x is string => typeof x === 'string')
        : []
      // Also scan the chunks: a previous de-attribution may have left a label
      // that never made it into `speakers`.
      if (Array.isArray(parsed.chunks)) {
        for (const c of parsed.chunks) {
          const sp = (c as { speaker?: unknown } | null)?.speaker
          if (typeof sp === 'string' && !existingSpeakers.includes(sp)) existingSpeakers.push(sp)
        }
      }
    } catch { /* the relabel below reports a corrupt sidecar */ }
    const DEATTRIBUTED_LABEL = nextDeattributedLabel(existingSpeakers)
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
    let markdownUnreadable = false
    if (plan.value.coveredAllWithLabel) {
      try {
        markdownPlan = relabelMeetingMarkdown(
          readFileSync(meetingPath, 'utf-8'), from, DEATTRIBUTED_LABEL,
          // Remove the attendee bullet outright: renaming it would write
          // `- Unidentified 2` into the list as though it were a person.
          { removeAttendee: true },
        )
      } catch { markdownPlan = null; markdownUnreadable = true }
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
      // 39% of operations sidecars have no .md beside them (the document was
      // archived). Without this the response reports sidecar changes and zero
      // markdown changes with no hint the document was never touched.
      markdownSkipped: !plan.value.coveredAllWithLabel
        ? 'partial de-attribution: transcript turns cannot be mapped to chunk indices'
        : markdownUnreadable ? 'meeting markdown unreadable' : null,
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


  // ── Review playback (6.21.18) ─────────────────────────────────────────
  //
  // Miles: "I can quickly play that, and I'm going to hear the voice and know
  // immediately who the speaker is. As a final confirmation."
  //
  // A phrase in the panel is a weaker signal than three seconds of the actual
  // voice. Retention is 7 days (see meeting-audio-archive), so this answers with
  // 404 + a reason once the window has passed rather than pretending the audio
  // was never there.
  router.get('/meeting/:sessionId/audio/:chunkIndex', async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    const chunkIndex = Number(req.params.chunkIndex)
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      res.status(400).json({ error: 'Invalid chunkIndex', reason: 'invalid_chunk_index' })
      return
    }
    // Archive first, then the live ext-audio the capture path already saved for
    // unrecognised speakers. The archive is forward-only, so without this
    // fallback there is nothing to play on any meeting predating 6.21.18 — while
    // 72 hours of unidentified-voice audio is sitting right there, and an
    // unidentified voice is exactly what a reviewer needs to hear.
    const archivedPath = meetingAudioChunkPath(sessionId, chunkIndex)
    const path = archivedPath ?? extAudioChunkPath(sessionId, chunkIndex)
    if (!path) {
      const retained = [...new Set([
        ...listMeetingAudioChunks(sessionId),
        ...listExtAudioChunks(sessionId),
      ])].sort((a, b) => a - b)
      res.status(404).json({
        error: retained.length === 0
          ? 'No audio retained for this meeting'
          : `Chunk ${chunkIndex} is not retained`,
        reason: retained.length === 0 ? 'audio_not_retained' : 'chunk_not_retained',
        // Which chunks CAN be played, so a UI can offer the nearest instead of
        // just failing.
        retainedChunks: retained.length,
        firstRetained: retained[0] ?? null,
        lastRetained: retained[retained.length - 1] ?? null,
      })
      return
    }
    // Canary scope is intentionally narrow: only the week-retained immutable
    // archive gets a derived playback copy. Legacy ext-audio remains byte-for-
    // byte raw. `?raw=1` is the authenticated A/B and emergency per-request
    // escape hatch; the COS Control toggle is the machine-wide rollback.
    const liveRecording = getTranscriptionSessionLiveness().live > 0
    const playback = archivedPath && req.query.raw !== '1' && !liveRecording
      ? await adaptivePlaybackAudio(archivedPath, {
          // Admission is not enough: if a meeting starts while FFmpeg is
          // working, the replay job is preempted and this request hears raw.
          shouldAbort: () => getTranscriptionSessionLiveness().live > 0,
        })
      : { path, mode: 'raw' as const, profile: null }
    res.set('X-COS-Audio-Playback', playback.mode)
    const bypassReason = 'reason' in playback ? playback.reason : undefined
    const bypass = liveRecording
      ? 'live_recording'
      : bypassReason === 'live_recording'
        ? 'live_recording'
        : bypassReason === 'cleanup_busy'
          ? 'cleanup_busy'
          : null
    if (bypass) res.set('X-COS-Audio-Bypass', bypass)
    if (playback.profile) res.set('X-COS-Audio-Profile', playback.profile)
    sendAudioFile(res, playback.path)
  })

  /**
   * Why each chunk was labelled the way it was.
   *
   * Reads the per-chunk embeddings the pipeline has retained since 6.21.15 and
   * scores each one against every enrolled profile RIGHT NOW. Until this route
   * that store had no production reader at all — the data was collected and
   * never looked at.
   *
   * This is what lets a reviewer distinguish "missed by 0.02 against one
   * profile" from "equidistant between three", which is the difference between
   * a fixable near-miss and a genuinely ambiguous voice. On a face-mounted
   * microphone that distinction is most of the signal.
   *
   * Read-only. It scores and reports; it changes no profile and no meeting.
   *
   *   ?chunks=4,17,23   specific chunks (omit for the whole session)
   *   ?limit=50         cap, because each chunk is scored against every profile
   */
  router.get('/meeting/:sessionId/embeddings', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }

    const rawChunks = String(req.query.chunks ?? '').trim()
    const indices: number[] = []
    if (rawChunks) {
      for (const part of rawChunks.split(',')) {
        const value = Number(part.trim())
        // Reject the whole request rather than silently scoring a subset: a
        // caller asking about chunk 17 must not get an answer about chunk 4.
        if (!Number.isInteger(value) || value < 0) {
          res.status(400).json({ error: `Invalid chunk index "${part.trim()}"`, reason: 'invalid_chunk_index' })
          return
        }
        indices.push(value)
      }
    }

    const rawLimit = Number(req.query.limit ?? 50)
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 400) : 50

    try {
      res.json(chunkDiagnostics(sessionId, indices, limit))
    } catch (error) {
      res.status(500).json({ error: errMsg(error), reason: 'diagnostics_failed' })
    }
  })

  /** What audio a meeting still has, so the panel can show play buttons only
   *  where they will work. */
  router.get('/meeting/:sessionId/audio', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    const archived = listMeetingAudioChunks(sessionId)
    const ext = listExtAudioChunks(sessionId)
    const chunks = [...new Set([...archived, ...ext])].sort((a, b) => a - b)
    res.json({
      sessionId,
      retained: chunks.length > 0,
      chunks,
      // Reported separately: ext-audio runs a 72h window, the archive 7 days, so
      // one retention number would be wrong for half the list.
      archivedChunks: archived.length,
      extAudioChunks: ext.length,
      // Config read, not a filesystem walk: this route used to stat every
      // retained chunk to report one number.
      retentionDays: meetingAudioRetentionDays(),
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
    // `stranded` is the state this endpoint used to be blind to: a capture whose
    // phone went away, still live in memory, audio intact, NOT yet quarantined and
    // therefore absent from `items` for a full four hours. That blindness is why
    // two stranded sessions could hold the restart lock on 2026-08-09 while this
    // route answered count: 0.
    const stranded = getStrandedCaptures()
    res.json({
      count: items.filter(isWorthRecovering).length,
      strandedCount: stranded.length,
      stranded,
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
        domain: domainForMeeting(
          typeof body.domain === 'string' && body.domain.trim() ? body.domain : undefined,
          `${typeof body.title === 'string' ? body.title : ''}\n${transcript}`,
          resolveCosOperationsDir(),
        ),
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
