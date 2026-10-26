import { dataPath } from '../lib/data-dir.js'
import { PHONE_CAPTURE_ID, PHONE_SOURCE_TYPE, assertPhoneProvenance, readPhoneRecording, requirePhoneRecording, closePhoneRecording } from '../lib/phone-recording.js'
import { MAC_CAPTURE_ID, readMacRecording, requireMacRecording, macChunkReceipt, closeMacRecording } from '../lib/mac-recording.js'
import { readSpeakerPolicy, writeSpeakerPolicy, isSpeakerMode } from '../lib/meeting-speaker-policy.js'
// POST /api/meeting/save — finalize an existing transcribe-stream session into
// the standalone public meeting store. The live transcript and chunk metadata
// are durable before the session is closed; batch improvement runs afterward.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { isWorthRecovering } from '../lib/quarantine-auto-recover.js'
import { basename, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Router } from 'express'
import { emitDisplay } from '../lib/display-bus.js'
import { createStopRequestStore, isStopRequestRefusal, STOP_REQUEST_CLAIM_WINDOW_MS, type StopRequest, type StopRequestStore } from '../lib/meeting-stop-requests.js'
import { appendAutonomousSaveLog, getStopIntentStore, type StopIntent, type StopIntentStore } from '../lib/meeting-stop-intents.js'
import { chunksOutstanding, parsePhoneFinalChunkIndex, phoneFinalChunkIndex, withPhoneFinalIndex } from '../lib/transfer-integrity.js'
import {
  AUTONOMOUS_FINALIZE_POLL_MS,
  AUTONOMOUS_FINALIZE_SETTLE_MS,
  createAutonomousFinalizer,
  indicesFromRanges,
  type AutonomousFinalizer,
  type AutonomousSaveOutcome,
  type SessionLedger,
} from '../lib/meeting-autonomous-finalize.js'
import { cleanTranscriptLines } from '../lib/hallucination-filter.js'
import { durableAtomicWriteFileSync } from '../lib/atomic-fs.js'
import { appendCorrection, appliedCorrections, pendingCorrections } from '../lib/meeting-corrections.js'
import { triggerMeetingMergeRun } from '../lib/meeting-actions.js'
import { isSampleFromSession, untraceableSampleCount } from '../lib/training-audio-provenance.js'
import { sendAudioFile } from '../lib/send-audio.js'
import { adaptivePlaybackAudio } from '../lib/adaptive-playback-audio.js'
import { chunkDiagnostics } from '../lib/chunk-embedding-diagnostics.js'
import { errMsg } from '../lib/utils.js'
import { setNamingSessionLiveness } from '../lib/held-naming-batches.js'
import { confirmedLabels, confirmedChunks } from '../lib/meeting-corrections.js'
import {
  extAudioChunkPath,
  listExtAudioChunks,
  listMeetingAudioChunks,
  meetingAudioChunkPath,
  meetingAudioRetentionDays,
} from '../lib/meeting-audio-archive.js'
import { readVoiceProfiles, retractEmbeddingsBySource } from '../lib/speaker-embeddings.js'
import { enrolNamedVoice } from '../lib/meeting-relabel-enrolment.js'
import { commitMacVoiceAssignment, planMacVoiceAssignment, type MacAssignPlan } from '../lib/mac-voice-assignment.js'
import { isMacCaptureSidecar, isVoiceLabel } from '../lib/mac-voice-labels.js'

function requireMacRecordingForSave(sessionId: string, expectedChunkCount: unknown): void {
  try {
    requireMacRecording(sessionId)
    assertMacCaptureComplete(sessionId, expectedChunkCount)
  } catch (error) {
    const failure = error as Error & { status?: number; reason?: string }
    throw new MeetingStoreError(failure.message, failure.status ?? 409, failure.reason ?? 'mac_capture_not_started')
  }
}

/**
 * The label a de-attributed voice takes, numbered within its meeting.
 *
 * NOT a shared `Ext`. De-attributing to one label folded every corrected voice
 * into a single row — on the 2026-08-06 Ditto meeting the user named five wrong
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
  persistSttSidecar,
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
  recoveryHqJob,
  summarizeStt,
  segmentTranscriptChunks,
  stopProgressiveHqSession,
  transcribeSegments,
} from '../lib/meeting-batch-transcribe.js'
import {
  clearActiveRecovery,
  findQuarantineDir,
  listUnsavedCaptures,
  markRecovered,
  markRecoveredNoSpeech,
  readCaptureDisposition,
  registerActiveRecovery,
  type CaptureDisposition,
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
  assertMacCaptureComplete,
  discardSilentMacCapture,
  drainSessionAudioWrites,
  durableSessionRecoveryHasRun,
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
  type MeetingLibraryRecord,
  cosOperationsMeetingsConfigured,
  findDirectLibraryMeetingBySessionId,
  findCosOperationsMeetingBySessionId,
  resolveCosOperationsDir,
} from '../lib/cos-operations-meetings.js'
import { derivedSourcesFor, findDerivedRecord } from '../lib/imported-library-rows.js'
import { assertVoiceEvidenceSource } from '../lib/voice-evidence-guard.js'
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
import { enrichStandaloneMeeting } from '../lib/meeting-summary-persistence.js'
import { bootResumeGate, type BootResumeGate } from '../lib/boot-resume.js'
import { recordFinalPassSkip, runNemotronFinalPass, type FinalPassOptions, type FinalPassOutcome } from '../lib/nemotron-final.js'
import { runTranscriptCleanup, type CleanupOutcome } from '../lib/transcript-cleanup.js'
import { sweepTranscriptCleanupData } from '../lib/transcript-cleanup-screen.js'
import type { TranscriptCleanupRouteDeps } from './transcript-cleanup.js'

/** 6.77.0: the post-save transcript cleanup. Injectable so tests never reach a model. */
export type TranscriptCleanupRunner = (input: { sessionId: string; meetingPath: string; sidecarPath: string }) => Promise<CleanupOutcome>

/** 6.61.0: the save-time Nemotron pass. Injectable so tests never spawn the CLI. */
export type FinalDiarize = (options: Pick<FinalPassOptions, 'meetingPath' | 'sidecarPath' | 'audioDir'>) => Promise<FinalPassOutcome>

function cosOpsPipelineConfigured(): boolean {
  // Read env live (not the module-load COS_SCRIPTS_DIR const) so unit tests that
  // clear ops env stay standalone, and Control-updated env is visible.
  return Boolean(process.env.COS_SCRIPTS_DIR?.trim())
}

/**
 * Why a correction left the meeting's markdown alone when it could not read it.
 *
 * 6.61.2: when two meetings declare the same session the lookup chooses neither
 * and the record falls back to the capture, whose own scribe the merge retired.
 * "Unreadable" would send the reader looking for a missing file; the real
 * answer is the duplicate claim, so the response names it.
 */
function markdownUnreadableReason(operations: { mergedScribeConflict?: string[] } | null): string {
  const conflict = operations?.mergedScribeConflict
  return conflict && conflict.length > 1
    ? `no merged meeting chosen: ${conflict.length} meetings declare this session (${conflict.join(', ')})`
    : 'meeting markdown unreadable'
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
  /** 6.53.3: live, closed within its retention, or unknown (`getMeetingSessionStatus`). */
  getState?(sessionId: string): 'active' | 'closed' | 'missing'
  /** 6.81.0: the received/ASR ledger the server's own save of a stopped meeting reads. */
  getLedger?(sessionId: string): SessionLedger
}

const defaultSessionState = (sessionId: string): 'active' | 'closed' | 'missing' => getMeetingSessionStatus(sessionId).state

/** 6.81.0: the live ledger as the autonomous finalizer reads it (the status route's own numbers). */
function defaultSessionLedger(sessionId: string): SessionLedger {
  const status = getMeetingSessionStatus(sessionId)
  const lastActivityAt = status.lastActivityAt ? Date.parse(status.lastActivityAt) : NaN
  return {
    state: status.state,
    received: indicesFromRanges(status.receivedRanges),
    asrCompleted: indicesFromRanges(status.asrCompletedRanges),
    maxChunkIndex: status.maxChunkIndex,
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : null,
  }
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
  finalDiarize?: FinalDiarize
  /** Control's stop requests for live G2 meetings (lib/meeting-stop-requests.ts). */
  stopRequests?: StopRequestStore
  /** 6.77.0: the post-save transcript cleanup (lib/transcript-cleanup.ts). */
  transcriptCleanup?: TranscriptCleanupRunner
  /** 6.81.0: the phone's Stop, durable (lib/meeting-stop-intents.ts). */
  stopIntents?: StopIntentStore
  /** 6.81.0: the server's own save of a stopped meeting. Tests inject the clock, timer and gate. */
  autonomousFinalize?: {
    now?: () => number
    schedule?: (fn: () => void, ms: number) => () => void
    ready?: () => boolean
    log?: (event: string, fields: Record<string, unknown>) => void
    onCreate?: (finalizer: AutonomousFinalizer) => void
  }
}

const activeFinalizationJobs = new Set<string>()
const finalizationRetryCounts = new Map<string, number>()

interface FinalizationRuntime {
  finalizationJobs: MeetingFinalizationJobStore
  runBatch: NonNullable<MeetingRouteDependencies['runBatch']>
  scheduleBackground: (task: Promise<void>) => void
  sessions?: MeetingSessionSource
  finalDiarize?: FinalDiarize
  transcriptCleanup?: TranscriptCleanupRunner
}

/**
 * The cleanup as finalization runs it: a meeting whose session is somehow live again is
 * skipped, and nothing it does can fail the finalization (it never throws; this catch is
 * the last line of defence should that ever change).
 */
async function runCleanupStage(runner: TranscriptCleanupRunner | undefined, input: { sessionId: string; meetingPath: string; sidecarPath: string }, sessions?: MeetingSessionSource): Promise<void> {
  const run = runner ?? (cleanupInput => runTranscriptCleanup(cleanupInput, { sessionLive: id => (sessions?.getState ?? defaultSessionState)(id) === 'active' }))
  try {
    await run(input)
  } catch (error) {
    console.warn(`[meeting/save] transcript cleanup threw; the saved transcript is unchanged: ${error instanceof Error ? error.name : 'error'}`)
  }
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
  const jobStartedAt = Date.now()
  const task = Promise.resolve().then(async () => {
    lease.setPhase('active')
    let current = runtime.finalizationJobs.get(job.sessionId) ?? job
    if (canonicalFinalizationIsComplete(current)) {
      runtime.finalizationJobs.remove(current.sessionId)
      bootResumeGate().forget('meeting_finalization', current.sessionId)
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
          finalDiarize: runtime.finalDiarize ?? runNemotronFinalPass,
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

    // 6.77.0: the transcript is final here (HQ text and the Nemotron relabel are written),
    // and nothing downstream has read it yet: COS operations imports, and the standalone
    // summary describes, the cleaned text. Off unless Miles turns it on.
    await runCleanupStage(runtime.transcriptCleanup, { sessionId: current.sessionId, meetingPath: current.meetingPath, sidecarPath: current.sidecarPath }, runtime.sessions)

    if (cosOpsPipelineConfigured() && !MAC_CAPTURE_ID.test(current.sessionId) && !PHONE_CAPTURE_ID.test(current.sessionId)) {
      await handoffMeetingToOperations(current.meetingPath)
    } else {
      // Standalone: no sync_meetings.py to produce summary/topics/decisions.
      // Runs HERE, after finalizeBatch, because batch HQ replaces the whole
      // transcript (meeting-batch-persistence.ts:7-12) — summarising earlier
      // would describe text the file no longer contains.
      await enrichStandaloneMeeting(current.meetingPath, jobStartedAt)
    }
    markCanonicalFinalizationState(current.sidecarPath, 'complete', false)
    // The capture is finished and its files are durable, so the merge engine may score it.
    // Fire-and-forget by contract: the runner queues, defers under a drain or a live
    // capture, and never throws back at the finalization path.
    if (!MAC_CAPTURE_ID.test(current.sessionId) && !PHONE_CAPTURE_ID.test(current.sessionId)) triggerMeetingMergeRun('g2_finalized')
    runtime.finalizationJobs.remove(current.sessionId)
    // 6.78.0: finished, so its crash-loop count (lib/boot-resume.ts) is done.
    bootResumeGate().forget('meeting_finalization', current.sessionId)
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
 * succeeded before a prior process exited. Safe to call more than once.
 * 6.78.0: `sessionId` resumes one job (the maintenance Retry); the rest are seams for tests. */
export function resumeMeetingFinalizationJobs(options: {
  sessionId?: string
  gate?: BootResumeGate
  finalizationJobs?: MeetingFinalizationJobStore
  schedule?: (job: MeetingFinalizationJob) => void
} = {}): void {
  const finalizationJobs = options.finalizationJobs ?? new MeetingFinalizationJobStore()
  finalizationJobs.reconcileCanonicalSidecars()
  const gate = options.gate ?? bootResumeGate()
  const schedule = options.schedule ?? ((job: MeetingFinalizationJob) => scheduleFinalizationJob(job, {
    finalizationJobs,
    runBatch: runMeetingBatchPipeline,
    scheduleBackground: task => { void task },
  }))
  for (const job of finalizationJobs.list()) {
    if (options.sessionId !== undefined && job.sessionId !== options.sessionId) continue
    // 6.78.0: counted (durably) BEFORE it runs, so a job that kills the process is parked
    // after RESTART_LIMIT crashed boots. A parked job is skipped and stays in its store.
    if (!gate.admit('meeting_finalization', job.sessionId, job.phase)) continue
    schedule(job)
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
  getState: defaultSessionState,
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
    ...(saved.sourceType ? { sourceType: saved.sourceType, sessionId: saved.captureId, captureId: saved.captureId, ...(saved.sourceType === PHONE_SOURCE_TYPE ? { speakerPolicy: 'anonymous' } : {}) } : {}),
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

/**
 * 6.71.14: what became of a capture whose live session is gone, as an ADDITIVE
 * field beside `state`.
 *
 * `state` keeps its 6.71.13 values and precedence (saved > active > closed >
 * missing) on purpose. Phones branch on it (`missing` is recovery-required or a
 * collision, `closed` is terminal-unsaved), and a new value would fall through to
 * their resume path. So the quarantine's answer rides alongside:
 *   receipted    recovery finished and found no speech
 *   recovered    recovery saved a meeting (the store may no longer find it by id)
 *   quarantined  the audio is held and no recovery has finished yet
 * Null when `state` is saved (the receipt is the answer) or active (a live session
 * reports itself), and when the quarantine holds nothing for the id.
 */
export type MeetingCaptureOutcome = 'receipted' | 'recovered' | 'quarantined'

export function captureOutcome(
  state: 'saved' | 'active' | 'closed' | 'missing',
  disposition: Pick<CaptureDisposition, 'kind'> | null,
): MeetingCaptureOutcome | null {
  if (state === 'saved' || state === 'active' || !disposition) return null
  if (disposition.kind === 'no_speech') return 'receipted'
  if (disposition.kind === 'recovered') return 'recovered'
  return 'quarantined'
}

function publicDisposition(disposition: CaptureDisposition | null): Record<string, unknown> | null {
  if (!disposition) return null
  return {
    kind: disposition.kind,
    // Why the capture is terminal: `no_speech` or `recovered`; null while it is only held.
    reason: disposition.kind === 'quarantined' ? null : disposition.kind,
    quarantinedAt: disposition.quarantinedAt,
    quarantineReason: disposition.quarantineReason,
    receiptedAt: disposition.receiptedAt,
    chunkFiles: disposition.chunkFiles,
    savedFilename: disposition.savedFilename,
    recovering: disposition.recovering,
    audioRetainedUntil: disposition.retainedUntil,
  }
}

/** 6.81.0: the Stop the server holds, as the status and stop routes show it. Never a path. */
function publicStopIntent(intent: StopIntent): Record<string, unknown> {
  return {
    finalChunkIndex: intent.finalChunkIndex,
    state: intent.state,
    receivedAt: new Date(intent.receivedAt).toISOString(),
    savedBy: intent.savedBy ?? null,
    savedAt: intent.savedAt ? new Date(intent.savedAt).toISOString() : null,
    reason: intent.reason ?? null,
    waitingFor: intent.state === 'waiting' && intent.lastWait
      ? { reason: intent.lastWait.reason, missingCount: intent.lastWait.missingCount, missingSample: intent.lastWait.missingSample }
      : null,
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
  const finalDiarize = deps.finalDiarize ?? runNemotronFinalPass
  const transcriptCleanup = deps.transcriptCleanup
  const router = Router()
  const savingSessions = new Set<string>()
  const stopRequests = deps.stopRequests ?? createStopRequestStore()
  setNamingSessionLiveness(id => sessions.getStartTime(id) !== null || savingSessions.has(id) || activeFinalizationJobs.has(id))

  // ── 6.81.0: the server finishes a stopped meeting on its own ─────────────────────
  // lib/meeting-stop-intents.ts says what a Stop intent is; lib/meeting-autonomous-
  // finalize.ts says when the server may save (only a complete capture, never early).
  const stopIntents = deps.stopIntents ?? getStopIntentStore()
  const autoDeps = deps.autonomousFinalize ?? {}
  const autoNow = autoDeps.now ?? Date.now
  const ledgerFor = (sessionId: string): SessionLedger => (sessions.getLedger ?? defaultSessionLedger)(sessionId)
  const autoLog = autoDeps.log ?? ((event: string, fields: Record<string, unknown>) => {
    const line = `[meeting/auto-save] ${event} ${String(fields.sessionId ?? '')} ${JSON.stringify(fields)}`
    if (event === 'finalize_failed' || event === 'revoked' || event === 'late_chunk_refused') console.warn(line)
    else console.log(line)
    appendAutonomousSaveLog(event, fields)
  })

  /** Someone saved a meeting the phone had told us about before the server did: theirs, not ours. */
  const notePhoneSavedFirst = (sessionId: string, savedBy: 'phone' | 'other') => {
    const intent = stopIntents.get(sessionId)
    if (!intent || intent.state !== 'waiting') return
    const at = autoNow()
    stopIntents.update(sessionId, { state: 'saved', savedBy, savedAt: at, lastWait: null })
    autoLog(savedBy === 'phone' ? 'phone_saved' : 'client_saved', { sessionId, waitedMs: at - intent.receivedAt, finalChunkIndex: intent.finalChunkIndex })
  }
  /** The phone came back after the server saved on its own. Logged once, with how it showed up. */
  const notePhoneAfterAutonomousSave = (sessionId: string, via: string) => {
    const intent = stopIntents.get(sessionId)
    if (!intent || intent.state !== 'saved' || intent.savedBy !== 'server' || intent.phoneConfirmedAt) return
    const at = autoNow()
    stopIntents.update(sessionId, { phoneConfirmedAt: at, phoneConfirmedBy: via })
    autoLog('phone_confirmed', { sessionId, via, sinceSaveMs: at - (intent.savedAt ?? at), lateReplays: intent.lateReplays ?? 0, lateRefused: intent.lateRefused ?? 0 })
  }

  const autonomousSave = async (intent: StopIntent): Promise<AutonomousSaveOutcome> => {
    // The phone pinned one server instance. A different one (a reinstall) is not its Mac.
    if (intent.serverInstanceId !== getServerInstanceId()) return { ok: false, status: 409, reason: 'server_instance_mismatch' }
    const entries = sessions.getChunkEntries(intent.sessionId) ?? []
    const canonicalCount = entries.filter(entry => entry?.chunk?.text).length
    const integrity = sessions.getIntegrity(intent.sessionId)
    let status = 0
    let payload: Record<string, unknown> = {}
    const saved = await performSave(
      intent.sessionId,
      { ...(intent.title ? { title: intent.title } : {}), ...(intent.domain ? { domain: intent.domain } : {}) },
      (code, body) => { status = code; payload = body },
      'server',
    )
    if (!saved || status !== 200) return { ok: false, status, reason: String(payload.reason ?? 'meeting_save_error') }
    // Someone saved it between the decision and the lock: theirs, not ours.
    if (payload.replayed === true) return { ok: false, status: 200, reason: 'already_saved' }
    return {
      ok: true,
      filename: saved.filename,
      sidecarPath: saved.sidecarPath,
      chunkCount: intent.finalChunkIndex + 1,
      canonicalCount,
      missingIndices: integrity?.missingIndices ?? [],
    }
  }

  const autonomousFinalizer = createAutonomousFinalizer({
    waiting: () => stopIntents.waiting(),
    get: sessionId => stopIntents.get(sessionId),
    update: (sessionId, patch) => { stopIntents.update(sessionId, patch) },
    ledger: ledgerFor,
    alreadySaved: sessionId => store.findBySessionId(sessionId) !== null,
    saving: sessionId => savingSessions.has(sessionId),
    save: autonomousSave,
    ready: autoDeps.ready ?? (() => maintenanceAdmissionsOpen() && durableSessionRecoveryHasRun()),
    now: autoNow,
    schedule: autoDeps.schedule ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    }),
    log: autoLog,
  })
  autoDeps.onCreate?.(autonomousFinalizer)

  let recoveryPendingLogged = false
  router.get('/meeting/sessions/:sessionId/status', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    let phoneProvenanceState: 'admitted' | 'not_admitted' | undefined
    if (sessionId.startsWith('phone_')) {
      try {
        if (readPhoneRecording(sessionId)) { requirePhoneRecording(sessionId); phoneProvenanceState = 'admitted' }
        else if (existsSync(dataPath('session-audio', sessionId)) || existsSync(dataPath('meeting-audio', sessionId)) || existsSync(dataPath('pending-batch', sessionId)) || existsSync(dataPath('active-sessions', sessionId + '.json')) || findQuarantineDir(sessionId)) requirePhoneRecording(sessionId)
        else { assertPhoneProvenance(sessionId, req.query); phoneProvenanceState = 'not_admitted' }
      } catch (error) { const e = error as Error & { status?: number; reason?: string }; res.status(e.status ?? 409).json({ error: e.message, reason: e.reason }); return }
    }
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
    if (phoneProvenanceState === 'admitted' && readPhoneRecording(sessionId)?.closedAt && !saved) { res.status(409).json({ error: 'Saved iPhone metadata is incomplete; audio is retained', reason: 'phone_saved_metadata_unreadable' }); return }
    // 6.71.14: before durable recovery has run (a boot behind a closed or stuck
    // maintenance gate), a persisted meeting is not in memory YET, and answering
    // `missing` would tell the phone the Mac lost it. Every phone status caller
    // treats a thrown non-2xx as defer-and-retry (the uploader's finalize defers;
    // origin-loss recovery backs off), so say "not yet" instead. A saved meeting
    // is already authoritative and is answered as usual.
    if (!saved && !durableSessionRecoveryHasRun()) {
      if (!recoveryPendingLogged) {
        recoveryPendingLogged = true
        console.warn('[meeting/status] Answering 503 recovery_pending: durable session recovery has not run (maintenance gate closed)')
      }
      res.set('Cache-Control', 'private, no-store')
      res.set('Retry-After', '5')
      res.status(503).json({
        error: 'Meeting session recovery has not run yet; retry shortly',
        reason: 'recovery_pending',
        retryable: true,
      })
      return
    }
    const live = getMeetingSessionStatus(sessionId)
    const state = saved ? 'saved' : live.state
    // A saved meeting or a live session is the truth for itself; the quarantine is
    // read only when neither is.
    const disposition = state === 'saved' || state === 'active' ? null : readCaptureDisposition(sessionId)
    // 6.81.0: a pinned status read is the phone; one after the server saved on its own is its return.
    if (saved && pin) notePhoneAfterAutonomousSave(sessionId, 'status')
    const intent = stopIntents.get(sessionId)
    res.set('Cache-Control', 'private, no-store')
    res.json({
      sessionId,
      ...(phoneProvenanceState ? { sourceType: PHONE_SOURCE_TYPE, speakerPolicy: 'anonymous', provenanceState: phoneProvenanceState } : {}),
      state,
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
      // 6.71.14, additive: what became of a capture whose audio reached quarantine
      // (null otherwise). Older clients ignore both.
      outcome: captureOutcome(state, disposition),
      disposition: publicDisposition(disposition),
      // 6.81.0, additive: the Stop the server holds for this meeting, if any. Older clients ignore it.
      stopIntent: intent ? publicStopIntent(intent) : null,
    })
  })

  // ── 6.83.2: discard a stranded Mac capture that held no sound ──────────────────────
  // POST /meeting/sessions/:id/discard {confirm: true, serverInstanceId}. COS Control offers it only for a capture the
  // server called no_speech or whose audio was all zeros; the server re-checks everything itself
  // (transcribe-stream.ts discardSilentMacCapture) and never touches a capture with speech. Without `confirm: true`
  // it answers 400 confirmation_required with what it WOULD do, and changes nothing.
  router.post('/meeting/sessions/:sessionId/discard', async (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    res.set('Cache-Control', 'private, no-store')
    if (!MAC_CAPTURE_ID.test(sessionId)) {
      res.status(400).json({ error: 'Only a Mac recording can be discarded here', reason: 'not_mac_capture' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const serverInstanceId = getServerInstanceId()
    if (!serverInstanceId) {
      res.status(503).json({ error: 'Server identity unavailable', reason: 'server_identity_unavailable' })
      return
    }
    const pin = suppliedServerPin(req, body.serverInstanceId)
    if (!pin) {
      res.status(400).json({ error: 'Server identity pin required', reason: 'server_identity_pin_required' })
      return
    }
    if (pin !== serverInstanceId) {
      res.status(409).json({ error: 'Server identity mismatch', reason: 'server_instance_mismatch' })
      return
    }
    if (store.findBySessionId(sessionId)) {
      res.status(409).json({ error: 'This recording is saved as a meeting', reason: 'already_saved' })
      return
    }
    if (savingSessions.has(sessionId)) {
      res.status(409).json({ error: 'This recording is being saved', reason: 'saving' })
      return
    }
    const confirmed = body.confirm === true
    const result = await discardSilentMacCapture(sessionId, { dryRun: !confirmed })
    if (!result.ok && result.reason === 'session_not_found') {
      // Already discarded (a retry after a lost answer): the quarantine says so, and the answer is the same.
      const disposition = readCaptureDisposition(sessionId)
      if (disposition?.quarantineReason === 'discarded_no_sound') {
        res.json({ sessionId, discarded: true, replayed: true, quarantined: disposition.dirName, retainedUntil: disposition.retainedUntil })
        return
      }
      res.status(404).json({ error: 'The server holds no live session for this recording', reason: 'session_not_found' })
      return
    }
    if (!result.ok) {
      const message: Record<string, string> = {
        has_speech: 'This recording has speech; save it instead',
        asr_in_progress: 'Audio is still being transcribed; try again in a moment',
        chunk_in_progress: 'An audio chunk is still arriving; try again in a moment',
        not_idle: 'This recording is still receiving audio',
        not_mac_capture: 'Only a Mac recording can be discarded here',
      }
      res.status(409).json({ error: message[result.reason ?? ''] ?? 'Not discarded', reason: result.reason, receivedCount: result.receivedCount })
      return
    }
    if (!confirmed) {
      res.status(400).json({
        error: 'Confirmation required', reason: 'confirmation_required',
        preview: { sessionId, chunkFiles: result.chunkFiles, receivedCount: result.receivedCount, retentionHours: 24 },
      })
      return
    }
    console.warn(`[meeting/discard] Discarded no-sound Mac capture ${sessionId}: ${result.receivedCount} chunk(s) received, audio quarantined for 24 h`)
    res.json({ sessionId, discarded: true, replayed: false, quarantined: result.quarantined ? basename(result.quarantined) : null,
      chunkFiles: result.chunkFiles, receivedCount: result.receivedCount, retainedUntil: result.retainedUntil })
  })

  // ── Stop a live G2 meeting from the Mac (COS Control) ────────────────────────────
  // The Mac never saves a live G2 session itself (lib/meeting-stop-requests.ts says why).
  // It asks the glasses: POST records the request and puts `meeting_stop_requested` on the
  // display bus; the companion claims it within the claim window and runs its own Stop;
  // Control polls GET until the meeting is saved, or says no glasses answered.
  const stopRequestBody = (request: StopRequest, extra: Record<string, unknown> = {}) => ({
    sessionId: request.sessionId,
    requestId: request.requestId,
    state: request.state,
    requestedAt: request.requestedAt,
    claimedAt: request.claimedAt,
    refusal: request.refusal,
    claimWindowMs: STOP_REQUEST_CLAIM_WINDOW_MS,
    ...extra,
  })
  const stopRequestSessionId = (req: { params: Record<string, unknown> }, res: { status(code: number): { json(body: unknown): void } }): string | null => {
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return null
    }
    if (sessionId.startsWith('phone_')) {
      res.status(400).json({ error: 'Stop this recording on iPhone', reason: 'phone_capture_stop_on_iphone' })
      return null
    }
    if (MAC_CAPTURE_ID.test(sessionId)) {
      // A Mac recording stops from Control itself; it has no glasses to ask.
      res.status(400).json({ error: 'A Mac recording stops from Record on Mac', reason: 'mac_capture' })
      return null
    }
    return sessionId
  }

  router.post('/meeting/sessions/:sessionId/stop-request', (req, res) => {
    const sessionId = stopRequestSessionId(req, res)
    if (!sessionId) return
    res.set('Cache-Control', 'private, no-store')
    const saved = store.findBySessionId(sessionId)
    if (saved) {
      res.json({ sessionId, state: 'saved', saveReceipt: publicSaveResponse(saved, true) })
      return
    }
    if (savingSessions.has(sessionId)) {
      res.json({ sessionId, state: 'finalizing' })
      return
    }
    const live = (sessions.getState ?? defaultSessionState)(sessionId)
    if (live !== 'active') {
      res.status(409).json({ error: 'This meeting is not recording', reason: 'not_live', state: live })
      return
    }
    const body = req.body as Record<string, unknown> | undefined
    const source = typeof body?.source === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(body.source) ? body.source : 'control'
    const request = stopRequests.request(sessionId, source)
    try {
      emit({
        type: 'meeting_stop_requested',
        data: { sessionId, requestId: request.requestId, source, claimWindowMs: STOP_REQUEST_CLAIM_WINDOW_MS },
      })
    } catch (error) {
      console.warn('[meeting/stop-request] Display notification failed:', error)
    }
    console.log(`[meeting/stop-request] ${source} asked the glasses to stop ${sessionId} (${request.requestId})`)
    res.status(202).json(stopRequestBody(request))
  })

  // The companion's answer: `accept` claims the request (then it stops), `refuse` says why not.
  router.post('/meeting/sessions/:sessionId/stop-request/:requestId/claim', (req, res) => {
    const sessionId = stopRequestSessionId(req, res)
    if (!sessionId) return
    res.set('Cache-Control', 'private, no-store')
    const requestId = String(req.params.requestId ?? '')
    const body = req.body as Record<string, unknown> | undefined
    const decision = body?.decision
    if (decision !== 'accept' && decision !== 'refuse') {
      res.status(400).json({ error: 'decision must be accept or refuse', reason: 'invalid_decision' })
      return
    }
    if (decision === 'refuse' && !isStopRequestRefusal(body?.reason)) {
      res.status(400).json({ error: 'Unknown refusal reason', reason: 'invalid_refusal' })
      return
    }
    const result = decision === 'accept'
      ? stopRequests.claim(sessionId, requestId)
      : stopRequests.refuse(sessionId, requestId, body!.reason as Parameters<StopRequestStore['refuse']>[2])
    if (!result.ok) {
      const status = result.reason === 'unknown_request' ? 404 : 409
      res.status(status).json({ error: 'Stop request is not open', reason: result.reason })
      return
    }
    console.log(`[meeting/stop-request] glasses ${decision === 'accept' ? 'claimed' : 'refused'} ${result.request.requestId}${result.request.refusal ? ` (${result.request.refusal})` : ''}`)
    res.json(stopRequestBody(result.request))
  })

  // Control's poll. A saved meeting answers `saved` with its receipt, whatever the request says.
  router.get('/meeting/sessions/:sessionId/stop-request/:requestId', (req, res) => {
    const sessionId = stopRequestSessionId(req, res)
    if (!sessionId) return
    res.set('Cache-Control', 'private, no-store')
    const request = stopRequests.get(sessionId, String(req.params.requestId ?? ''))
    if (!request) {
      res.status(404).json({ error: 'Unknown stop request', reason: 'unknown_request' })
      return
    }
    const saved = store.findBySessionId(sessionId)
    if (saved) {
      res.json(stopRequestBody(request, { state: 'saved', saveReceipt: publicSaveResponse(saved, true) }))
      return
    }
    res.json(stopRequestBody(request, savingSessions.has(sessionId) ? { finalizing: true } : {}))
  })

  // ── 6.81.0: the phone's Stop ──────────────────────────────────────────────────────
  // POST /meeting/sessions/:id/stop {finalChunkIndex, serverInstanceId}. One small fetch the
  // phone can send the moment Stop is pressed, before any IndexedDB work, so a phone that is
  // off screen still tells the Mac. It never closes the session and never refuses a chunk:
  // the server saves on its own only once it holds every chunk 0..finalChunkIndex.
  router.post('/meeting/sessions/:sessionId/stop', (req, res) => {
    try { assertPhoneProvenance(String(req.params.sessionId ?? ''), req.body) } catch (error) { const e = error as Error & { status?: number; reason?: string }; res.status(e.status ?? 400).json({ error: e.message, reason: e.reason }); return }
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    if (MAC_CAPTURE_ID.test(sessionId)) {
      res.status(400).json({ error: 'A Mac recording stops from Record on Mac', reason: 'mac_capture' })
      return
    }
    const body = req.body as Record<string, unknown> | undefined
    const finalChunkIndex = body?.finalChunkIndex
    if (!Number.isInteger(finalChunkIndex) || (finalChunkIndex as number) < -1 || (finalChunkIndex as number) > 1_000_000) {
      res.status(400).json({ error: 'finalChunkIndex must be a whole number, -1 or more', reason: 'invalid_final_chunk_index' })
      return
    }
    if ((body?.title !== undefined && typeof body.title !== 'string') || (body?.domain !== undefined && typeof body.domain !== 'string')) {
      res.status(400).json({ error: 'title and domain must be strings', reason: 'invalid_metadata' })
      return
    }
    const serverInstanceId = getServerInstanceId()
    if (!serverInstanceId) {
      res.status(503).json({ error: 'Server identity unavailable', reason: 'server_identity_unavailable' })
      return
    }
    // Required, not optional: only a phone pinned to THIS Mac may hand it a Stop.
    const pin = suppliedServerPin(req, body?.serverInstanceId)
    if (!pin) {
      res.status(400).json({ error: 'Server identity pin required', reason: 'server_identity_pin_required' })
      return
    }
    if (pin !== serverInstanceId) {
      res.status(409).json({ error: 'Server identity mismatch', reason: 'server_instance_mismatch' })
      return
    }
    res.set('Cache-Control', 'private, no-store')
    const saved = store.findBySessionId(sessionId)
    if (saved) {
      notePhoneAfterAutonomousSave(sessionId, 'stop_retry')
      res.json({ sessionId, state: 'saved', saveReceipt: publicSaveResponse(saved, true) })
      return
    }
    const ready = (autoDeps.ready ?? (() => maintenanceAdmissionsOpen() && durableSessionRecoveryHasRun()))()
    // Before recovery has run the ledger is empty by construction, so it proves nothing:
    // record the Stop and let the finalizer judge it once the gate opens.
    const ledger = ready ? ledgerFor(sessionId) : null
    if (ledger?.state === 'closed') {
      res.status(409).json({ error: 'This meeting is closed without a save', reason: 'not_live', state: 'closed' })
      return
    }
    if (ledger && ledger.maxChunkIndex > (finalChunkIndex as number)) {
      // The Mac holds audio past the phone's last chunk. Never take that Stop.
      res.status(409).json({ error: 'The Mac holds chunks past finalChunkIndex', reason: 'final_index_behind_server', maxChunkIndex: ledger.maxChunkIndex })
      return
    }
    const source = typeof body?.source === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(body.source) ? body.source : 'companion'
    let result: ReturnType<StopIntentStore['record']>
    try {
      result = stopIntents.record({
        sessionId,
        finalChunkIndex: finalChunkIndex as number,
        source,
        ...(typeof body?.title === 'string' && body.title.trim() ? { title: body.title.slice(0, 160) } : {}),
        ...(typeof body?.domain === 'string' && body.domain.trim() ? { domain: body.domain } : {}),
        serverInstanceId,
      })
    } catch (error) {
      // Not durable means not received: the phone must keep its own Stop path.
      console.error(`[meeting/auto-save] Could not record the Stop for ${sessionId}: ${error instanceof Error ? error.message : error}`)
      res.status(503).json({ error: 'Stop could not be recorded; retry', reason: 'stop_persistence_failed', retryable: true })
      return
    }
    if (!result.ok) {
      res.json({ sessionId, state: 'saved', stopIntent: publicStopIntent(result.intent) })
      return
    }
    const intent = result.intent
    if (result.created || result.raised) {
      autoLog(result.created ? 'stop_received' : 'stop_raised', {
        sessionId, source, finalChunkIndex: intent.finalChunkIndex, posts: intent.posts,
        received: ledger?.received.length ?? null, replaced: intent.replaced ?? null,
      })
    }
    void autonomousFinalizer.tick('stop_received')
    res.status(202).json({
      sessionId,
      state: 'stop_received',
      finalChunkIndex: intent.finalChunkIndex,
      receivedAt: new Date(intent.receivedAt).toISOString(),
      posts: intent.posts,
      autonomousSave: { settleMs: AUTONOMOUS_FINALIZE_SETTLE_MS, pollMs: AUTONOMOUS_FINALIZE_POLL_MS },
    })
  })

  /**
   * The save itself, shared by the phone's POST /meeting/save and the server's own save of a
   * stopped meeting (6.81.0). One body so the two can never drift: the same lock, the same
   * idempotent receipt, the same durable sidecar-then-job order, and the same maintenance
   * lease order (the finalization job's lease is taken before the save lease is released).
   *
   * `respond` is called exactly once, before any background work is scheduled, as the route
   * always did. `origin` changes only bookkeeping: who is recorded as having saved, and the
   * phone-confirmed line when the phone replays a save the server already made.
   */
  async function performSave(
    sessionId: string,
    body: Record<string, unknown> | undefined,
    respond: (status: number, payload: Record<string, unknown>, noStore?: boolean) => void,
    origin: 'phone' | 'client' | 'server',
  ): Promise<SavedMeeting | null> {
    let lockedSessionId: string | null = null
    let maintenanceLease: MaintenanceWorkLease | undefined
    try {
      // A response can be lost after both durable files were committed. Find
      // the sidecar by session ID so client retry/restart is idempotent.
      if (sessionId.startsWith('phone_')) {
        try { requirePhoneRecording(sessionId) } catch (error) { const failure = error as Error & { status?: number; reason?: string }; throw new MeetingStoreError(failure.message, failure.status ?? 409, failure.reason ?? 'phone_capture_provenance_missing') }
      }
      const alreadySaved = store.findBySessionId(sessionId)
      if (alreadySaved) {
        finalizationJobs.reconcileCanonicalSidecars()
        const pendingJob = finalizationJobs.get(sessionId)
        // 6.78.0: a replayed save never re-runs a job parked for crash-looping the server.
        if (pendingJob && !bootResumeGate().isParked('meeting_finalization', sessionId)) scheduleFinalizationJob(pendingJob, {
          transcriptCleanup,
          finalizationJobs,
          runBatch,
          scheduleBackground,
          sessions,
          finalDiarize,
        })
        if (origin === 'phone') notePhoneAfterAutonomousSave(sessionId, 'save_replay')
        respond(200, publicSaveResponse(alreadySaved, true), true)
        return alreadySaved
      }
      if (PHONE_CAPTURE_ID.test(sessionId) && requirePhoneRecording(sessionId).closedAt) throw new MeetingStoreError('Saved iPhone source metadata is incomplete; audio is retained', 409, 'phone_saved_metadata_unreadable')
      if (MAC_CAPTURE_ID.test(sessionId)) {
        requireMacRecordingForSave(sessionId, body?.expectedChunkCount)
      }
      // 6.88.0 (lib/transfer-integrity.ts): how far a phone window said it captured, from its Stop or
      // from this save (glasses 6.10.652). The saved file's integrity counts against it.
      const phoneFinal = phoneFinalChunkIndex(stopIntents.get(sessionId)?.finalChunkIndex, parsePhoneFinalChunkIndex(body?.finalChunkIndex))
      // An origin-wipe recovery never finalizes a meeting a phone window still holds chunks for, unless
      // it says it waited them out. A save without `recovery` is never refused here.
      if (body?.recovery === 'origin_wipe' && body?.acceptMissing !== true) {
        const report = sessions.getIntegrity(sessionId)
        const outstanding = report ? chunksOutstanding(report, phoneFinal) : 0
        if (outstanding > 0) {
          respond(409, {
            error: 'A phone window captured chunks this Mac does not hold yet',
            reason: 'chunks_outstanding',
            missingCount: outstanding,
            finalChunkIndex: phoneFinal,
          })
          return null
        }
      }
      if (savingSessions.has(sessionId)) {
        respond(409, { error: 'Meeting save already in progress', reason: 'save_in_progress' })
        return null
      }
      // Saving/finalizing an already-recording session is a drain
      // continuation. It must remain admitted so existing audio can reach a
      // durable terminal while all genuinely new work is closed.
      maintenanceLease = acquireMaintenanceWork('meeting_save', { allowDuringDrain: true })
      savingSessions.add(sessionId)
      lockedSessionId = sessionId

      const transcript = sessions.getTranscript(sessionId)
      if (!transcript?.trim()) {
        // 6.53.3 (review D3): a session the server KNOWS (live, or closed within its
        // retention) that holds no transcript is not one it never heard of. Its own reason
        // lets a client stop asking ("nothing to save") instead of retrying a 404 all day.
        // Still 404, so every existing client reads it exactly as before.
        const known = (sessions.getState ?? defaultSessionState)(sessionId)
        respond(404, known === 'active' || known === 'closed'
          ? { error: `Nothing to save for session ${sessionId}`, reason: 'nothing_to_save', state: known }
          : { error: `No transcript found for session ${sessionId}`, reason: 'session_not_found' })
        return null
      }

      const chunks = sessions.getChunks(sessionId) ?? []
      const chunkEntries = sessions.getChunkEntries(sessionId)
        ?? chunks.map((chunk, chunkIndex) => ({ chunkIndex, chunk }))
      const startTime = sessions.getStartTime(sessionId) ?? Date.now()
      const macRecording = readMacRecording(sessionId)
      const phoneRecording = readPhoneRecording(sessionId)
      const durationFromTimeline = macRecording
        ? macChunkReceipt(sessionId, Number(body?.expectedChunkCount) - 1)?.endElapsed ?? 0
        : chunks.reduce(
        (maximum, chunk) => Math.max(maximum, (chunk?.elapsed ?? 0) + (PHONE_CAPTURE_ID.test(sessionId) ? chunk?.audioDurationMs ?? 0 : 0)),
        0,
      )
      const durationMs = durationFromTimeline > 0
        ? durationFromTimeline
        : Math.max(0, Date.now() - startTime)
      const integrity = withPhoneFinalIndex(sessions.getIntegrity(sessionId), phoneFinal)
      const needsOperations = cosOpsPipelineConfigured() && !macRecording && !phoneRecording
      // Standalone saves need a finalization pass too, for summary enrichment.
      // Before 6.37 a standalone save with no audio nulled the job below and
      // never reached the ops_pending slot, so enrichment could never run.
      const standaloneEnrichmentRequired = !needsOperations
      const finalizationRequired =
        sessions.hasAudio(sessionId) || needsOperations || standaloneEnrichmentRequired
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
      // 6.81.0: who saved. A pinned save is the phone's; an unpinned one (the stranded sweep's
      // own POST, a manual curl) is someone else's. Either closes a waiting Stop. The server's
      // own save is recorded by its finalizer.
      if (origin !== 'server') notePhoneSavedFirst(sessionId, origin === 'phone' ? 'phone' : 'other')

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
            // 6.81.0, additive: the server saved this on its own after the phone's Stop.
            ...(origin === 'server' ? { savedBy: 'server' } : {}),
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
        if (!readMacRecording(sessionId) && !PHONE_CAPTURE_ID.test(sessionId)) triggerMeetingMergeRun('g2_finalized')
        finalizationJobs.remove(sessionId)
        bootResumeGate().forget('meeting_finalization', sessionId)
        finalizationJob = null
      }

      respond(200, publicSaveResponse(saved), true)

      if (finalizationJob) {
        scheduleFinalizationJob(finalizationJob, {
          finalizationJobs,
          runBatch,
          scheduleBackground,
          sessions,
          finalDiarize,
          transcriptCleanup,
        })
      }
      return saved
    } catch (error) {
      if (error instanceof MeetingStoreError) {
        respond(error.status, { error: error.message, reason: error.code })
        return null
      }
      console.error('[meeting/save] Finalization failed:', error)
      respond(500, { error: 'Meeting save failed', reason: 'meeting_save_error' })
      return null
    } finally {
      maintenanceLease?.release()
      if (lockedSessionId) savingSessions.delete(lockedSessionId)
    }
  }

  router.post('/meeting/save', async (req, res) => {
    let responded = false
    const respond = (status: number, payload: Record<string, unknown>, noStore = false) => {
      if (responded) return
      responded = true
      if (noStore) res.set('Cache-Control', 'private, no-store')
      res.status(status).json(payload)
    }
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
      try { assertPhoneProvenance(sessionId, body) } catch (error) { const e = error as Error & { status?: number; reason?: string }; respond(e.status ?? 400, { error: e.message, reason: e.reason }); return }
      const serverInstanceId = getServerInstanceId()
      if (!serverInstanceId) {
        res.status(503).json({ error: 'Server identity unavailable', reason: 'server_identity_unavailable' })
        return
      }
      const pin = suppliedServerPin(req, body?.serverInstanceId)
      if ((MAC_CAPTURE_ID.test(sessionId) || PHONE_CAPTURE_ID.test(sessionId)) && !pin) {
        res.status(400).json({ error: 'Server identity pin required', reason: 'server_identity_pin_required' })
        return
      }
      if (pin && pin !== serverInstanceId) {
        res.status(409).json({ error: 'Server identity mismatch', reason: 'server_instance_mismatch' })
        return
      }
      // Only the phone pins its saves (the local-first contract); the stranded sweep does not.
      await performSave(sessionId, body, respond, pin && req.get('X-COS-Recording-Origin') !== 'stranded-sweep' ? 'phone' : 'client')
    } catch (error) {
      console.error('[meeting/save] Finalization failed:', error)
      respond(500, { error: 'Meeting save failed', reason: 'meeting_save_error' })
    }
  })

  // ── Record identity for the speaker surfaces (6.47.0) ─────────────────
  //
  // One resolver, because the speakers and content routes each carried their own
  // copy of the same three literals and the two had already drifted apart once.
  // `source` and `mutable` always describe the CAPTURE — the file that holds the
  // chunks and the one a correction would rewrite — even when the caller reached
  // it through a merged record's row. `blendedRecordId` is what says "you opened
  // the merged row", so Control can label the panel without pretending the merge
  // is the thing being edited.
  function speakerRecordIdentity(
    sessionId: string,
    operations: { domain: string; month: string; filename: string } | null,
    direct: MeetingLibraryRecord | null,
    blendedRecordId?: string,
  ): {
    source: 'cos_operations' | 'direct_library' | 'standalone_recordings'
    recordId: string
    mutable: boolean
    blendedRecordId?: string
  } {
    return {
      source: operations ? 'cos_operations' : direct ? 'direct_library' : 'standalone_recordings',
      recordId: operations
        ? `ops:${operations.domain}:${operations.month}:${operations.filename}`
        : direct?.recordId ?? `standalone:${sessionId}`,
      mutable: direct == null,
      ...(blendedRecordId ? { blendedRecordId } : {}),
    }
  }

  /**
   * `?recordId=blended:<h16>` on a read: the caller opened the merged row.
   *
   * Confirmed against the record's OWN inputs rather than trusted, so a wrong or
   * stale id is simply ignored instead of labelling an unrelated capture as part
   * of a merge. Any capture the merge holds is accepted, not only the earliest,
   * because a merge of two captures has two ways in and both are legitimate.
   */
  function blendedRecordFor(value: unknown, sessionId: string): string | undefined {
    if (typeof value !== 'string' || !value.startsWith('blended:')) return undefined
    const record = findDerivedRecord(value)
    if (!record || record.kind !== 'merge') return undefined
    return record.g2SessionIds.includes(sessionId) ? record.recordId : undefined
  }

  /**
   * Refuse a mutation aimed at an imported or derived record.
   *
   * A derived record is a FUNCTION of its inputs: the next re-derive rewrites it,
   * so an edit here would be silently discarded. The refusal names the capture to
   * correct instead, which is the whole point of answering 409 rather than 404.
   */
  function refuseDerivedMutation(recordId: unknown): { status: number; body: Record<string, unknown> } | null {
    const refusal = assertVoiceEvidenceSource([recordId])
    if (!refusal) return null
    const record = typeof recordId === 'string' ? findDerivedRecord(recordId) : null
    const sourceRecordId = record
      ? derivedSourcesFor(record, store).find(source => source.kind === 'g2')?.recordId
      : undefined
    return {
      status: refusal.status,
      body: { ...refusal.body, mutable: false, ...(sourceRecordId ? { sourceRecordId } : {}) },
    }
  }

  /**
   * 6.61.0 (QA W2): refuse a correction while the meeting is finalizing.
   *
   * The Nemotron final pass rewrites the sidecar and the transcript inside the
   * finalization job, after a CLI run of tens of seconds. A relabel or a
   * deattribution landing in that window would race it (the pass also re-reads
   * both files and stands down, but the edit and the pass should not interleave
   * at all). Same rule held naming uses: while a finalization job exists for the
   * session the answer is 409, and a retry after it finishes works.
   */
  function finalizingRefusal(sessionId: string): { status: number; body: Record<string, unknown> } | null {
    const running = [...activeFinalizationJobs].some(key => key.endsWith(`:${sessionId}`))
    if (!running && !finalizationJobs.get(sessionId)) return null
    return {
      status: 409,
      body: { error: 'Meeting is finalizing; retry after it finishes', reason: 'meeting_finalizing', retryable: true },
    }
  }

  // ── Speaker review (6.21.12) ──────────────────────────────────────────
  // Backs COS Control's naming panel. Read-only: it reports what a saved
  // meeting's sidecar already contains and never writes. Naming, merging, and
  // rebuilding are the /api/voice/* routes, each with its own confirmation.
  //
  // Keyed on sessionId so it can reuse the store's traversal-hardened readers
  function reviewRevision(meetingPath: string, sidecarPath: string): string {
    const hash = createHash('sha256')
    for (const path of [meetingPath, sidecarPath]) {
      let text: string | null = null
      try { text = readFileSync(path, 'utf-8') } catch { /* missing content is part of the revision */ }
      hash.update(JSON.stringify(text))
    }
    return hash.digest('hex')
  }

  function selectedReadMatches(requested: unknown, sessionId: string, actual: string): boolean {
    return requestedRecordMatches(requested, actual) || blendedRecordFor(requested, sessionId) !== undefined
  }

  function sourceRevisionRefusal(sessionId: string, body: any): { status: number; body: Record<string, unknown> } | null {
    const ops = cosOperationsMeetingsConfigured() ? findCosOperationsMeetingBySessionId(sessionId) : null
    if (ops?.mergedScribeConflict?.length) return { status: 409, body: { reason: 'record_source_mismatch', error: markdownUnreadableReason(ops) } }
    if (body?.expectedRevision == null) return null // older clients keep their existing record guard
    const saved = ops ? null : store.findBySessionId(sessionId)
    if (!ops && !saved) return { status: 409, body: { reason: 'record_source_mismatch', error: 'Meeting source changed; reopen the meeting' } }
    const actual = reviewRevision(ops?.meetingPath ?? saved!.filepath, ops?.sidecarPath ?? saved!.sidecarPath)
    if (typeof body.expectedRevision !== 'string' || body.expectedRevision !== actual) return { status: 409, body: { reason: 'record_source_mismatch', error: 'Meeting changed since review; reopen before correcting it' } }
    return null
  }

  // (safeDirectoryRealpath / safeReadFile) instead of reassembling a path from
  // client-supplied domain and filename components.
  router.get('/meeting/:sessionId/speaker-policy', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) { res.status(400).json({ error: 'Invalid session ID' }); return }
    if (sessions.getStartTime(sessionId) === null && !findCosOperationsMeetingBySessionId(sessionId) && !store.findBySessionId(sessionId)) {
      res.status(404).json({ error: 'Meeting not found' }); return
    }
    res.set('Cache-Control', 'private, no-store').json(readSpeakerPolicy(sessionId))
  })
  router.post('/meeting/:sessionId/speaker-policy', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (MAC_CAPTURE_ID.test(sessionId) && req.body?.mode !== 'high-confidence') { res.status(409).json({ reason: 'mac_capture_policy_locked', error: 'The Mac pilot requires high-confidence voice identity' }); return }
    const refusal = assertVoiceEvidenceSource([sessionId]) ?? refuseDerivedMutation(req.body?.recordId)
    if (refusal) { res.status(refusal.status).json(refusal.body); return }
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId) || !isSpeakerMode(req.body?.mode) || typeof req.body?.expectedPolicyRevision !== 'string') {
      res.status(400).json({ error: 'A valid session, mode and policy revision are required' }); return
    }
    const operations = findCosOperationsMeetingBySessionId(sessionId)
    const saved = operations ? null : store.findBySessionId(sessionId)
    if (!operations && !saved && sessions.getStartTime(sessionId) === null) { res.status(404).json({ error: 'Meeting not found' }); return }
    if (operations || saved) {
      const selected = operations ? `ops:${operations.domain}:${operations.month}:${operations.filename}` : `standalone:${sessionId}`
      if (req.body?.recordId !== selected) { res.status(409).json({ error: 'Reopen the selected meeting' }); return }
      const sourceRefusal = sourceRevisionRefusal(sessionId, req.body) ?? finalizingRefusal(sessionId)
      if (sourceRefusal) { res.status(sourceRefusal.status).json(sourceRefusal.body); return }
    }
    try {
      writeSpeakerPolicy(sessionId, req.body.mode, req.body.expectedPolicyRevision)
      res.json({ ...readSpeakerPolicy(sessionId), message: 'Matching changed for new audio. Existing names are unchanged.' })
    } catch (error) { res.status(409).json({ error: String(error) }); }
  })

  router.get('/meeting/:sessionId/speakers', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' })
      return
    }
    // BEFORE the lookup. The sessionId pattern allows colons, so `blended:<h16>`
    // and `imported:fireflies:<h16>` are shaped like sessions and would otherwise
    // fall through to a store scan that answers 404 — the wrong answer, because
    // the record exists and simply is not a capture.
    const identityRefusal = assertVoiceEvidenceSource([sessionId])
    if (identityRefusal) {
      res.status(identityRefusal.status).json(identityRefusal.body)
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
    const identity = speakerRecordIdentity(sessionId, operations, direct, blendedRecordFor(req.query.recordId, sessionId))
    if (!selectedReadMatches(req.query.recordId, sessionId, identity.recordId)) {
      res.status(409).json({ error: 'Meeting source changed; reopen the selected meeting', reason: 'record_source_mismatch' })
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
      confirmedChunks: confirmedChunks(sessionId),
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
      ...identity,
      speakerPolicy: readSpeakerPolicy(sessionId),
      reviewIdentityVersion: 1,
      sourceRevision: reviewRevision(operations?.meetingPath ?? direct?.meetingPath ?? saved!.filepath, sidecarPath),
      ...(operations?.mergedScribeConflict?.length ? { mutable: false, identityConflict: operations.mergedScribeConflict } : {}),
      ...(saved ? { durationMin: saved.durationMin } : {}),
      ...review,
    })
  })


  // ── Per-meeting speaker relabel (6.21.16) ─────────────────────────────
  //
  // Corrects who a voice was in ONE meeting. Deliberately not a global merge:
  // the user, on the design — "changing it doesn't mean that all previous chunks
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
    const identityRefusal = assertVoiceEvidenceSource([sessionId])
    if (identityRefusal) {
      res.status(identityRefusal.status).json(identityRefusal.body)
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
    const identity = speakerRecordIdentity(sessionId, operations, direct, blendedRecordFor(req.query.recordId, sessionId))
    if (!selectedReadMatches(req.query.recordId, sessionId, identity.recordId)) {
      res.status(409).json({ error: 'Meeting source changed; reopen the selected meeting', reason: 'record_source_mismatch' })
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
      confirmedChunks: confirmedChunks(sessionId),
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
      // NOTHING has ever read it: on 2026-08-07 the user removed "Morgan Example" from a
      // call that had only two participants, all 8 label sites were rewritten, and the
      // summary still opened "the user, Sam, and Morgan talk through..." with no
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
      ...identity,
      reviewIdentityVersion: 1,
      sourceRevision: reviewRevision(operations?.meetingPath ?? direct?.meetingPath ?? saved!.filepath, sidecarPath),
      ...(operations?.mergedScribeConflict?.length ? { mutable: false, identityConflict: operations.mergedScribeConflict } : {}),
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
    // Enrolment writes to the voice store, so the same two gates as the other
    // corrections: the session must be a capture, and the record aimed at must
    // not be a derived one.
    const evidenceRefusal = assertVoiceEvidenceSource([sessionId]) ?? refuseDerivedMutation(req.body?.recordId) ?? sourceRevisionRefusal(sessionId, req.body)
    if (evidenceRefusal) {
      res.status(evidenceRefusal.status).json(evidenceRefusal.body)
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
    // A merged G2 session is NOT refused here: it is a real capture with real
    // audio, and relabelling it is how its profile gets better. Only an imported
    // or derived IDENTITY is refused.
    const evidenceRefusal = assertVoiceEvidenceSource([sessionId]) ?? refuseDerivedMutation(req.body?.recordId) ?? sourceRevisionRefusal(sessionId, req.body) ?? finalizingRefusal(sessionId)
    if (evidenceRefusal) {
      res.status(evidenceRefusal.status).json(evidenceRefusal.body)
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

    // 6.93.0: a Mac recording voice assigned to an EXISTING voice profile. Opt-in per
    // request (`assignVoiceProfile: true`); without it a Mac rename stays text only.
    // Planned BEFORE anything is written: the preview shows exactly what would be added,
    // and a confirm that would add nothing is refused with the rename unapplied.
    let macAssign: MacAssignPlan | null = null
    if (req.body?.assignVoiceProfile === true) {
      let parsedForAssign: Record<string, unknown> = {}
      try {
        const doc = JSON.parse(sidecarRaw) as unknown
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) parsedForAssign = doc as Record<string, unknown>
      } catch { /* relabelSidecarJson already parsed it */ }
      if (!isMacCaptureSidecar(parsedForAssign, sessionId)) {
        res.status(400).json({ error: 'assignVoiceProfile applies to Mac recordings only; a glasses rename already trains the profile', reason: 'not_mac_capture' })
        return
      }
      if (!isVoiceLabel(from)) {
        res.status(400).json({ error: 'Only an unnamed Voice N can be assigned to a voice profile', reason: 'not_a_voice_label' })
        return
      }
      macAssign = planMacVoiceAssignment({ sessionId, from, to, changed: plan.value.changed, sidecar: parsedForAssign })
      if (macAssign.report.skipped === 'unknown_profile') {
        res.status(404).json({ error: `"${to}" is not an enrolled voice profile, so nothing was changed`, reason: 'unknown_profile', enrolment: macAssign.report })
        return
      }
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
        : markdownRaw === null ? markdownUnreadableReason(operations) : null,
    }

    if (req.body?.dryRun === true || req.body?.confirm !== true) {
      res.status(req.body?.dryRun === true ? 200 : 400).json({
        ...(req.body?.dryRun === true ? {} : { error: 'confirmation required', reason: 'confirmation_required' }),
        ...(macAssign ? { enrolment: macAssign.report } : {}),
        message: `Relabelling ${surfaces.sidecar} chunk(s) from "${from}" to "${to}" in this meeting`
          + (macAssign
            ? macAssign.report.skipped === null
              ? `, and adding up to ${macAssign.report.enrolled} voice sample(s) to ${to}'s profile`
              : ', with no voice samples added'
            : '')
          + (preview.proseStale
            ? '. The summary and decisions still name the old speaker and are NOT rewritten — '
              + `prose refers to people by first name (${preview.proseHits.join(', ')}), `
              + 'so substituting it could rewrite a sentence about someone else.'
            : '.'),
        ...preview,
      })
      return
    }

    // Assigning to a profile with nothing to add is refused whole: the person asked for
    // samples, so a rename that silently adds none is not what they confirmed.
    if (macAssign && macAssign.report.skipped !== null) {
      res.status(422).json({
        error: 'No usable audio from this voice can be added to that profile, so nothing was changed',
        reason: 'nothing_to_enrol',
        enrolment: macAssign.report,
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

    const enrolment = macAssign
      ? commitMacVoiceAssignment(sessionId, macAssign)
      : enrolNamedVoice({ sessionId, from, to, changed: plan.value.changed, sidecar: parsedSidecar })
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
  // the user, on the 2026-08-06 Ditto meeting: none of the eleven attributed
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
    const evidenceRefusal = assertVoiceEvidenceSource([sessionId]) ?? refuseDerivedMutation(req.body?.recordId) ?? sourceRevisionRefusal(sessionId, req.body)
    if (evidenceRefusal) {
      res.status(evidenceRefusal.status).json(evidenceRefusal.body)
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
    const evidenceRefusal = assertVoiceEvidenceSource([sessionId]) ?? refuseDerivedMutation(req.body?.recordId) ?? sourceRevisionRefusal(sessionId, req.body) ?? finalizingRefusal(sessionId)
    if (evidenceRefusal) {
      res.status(evidenceRefusal.status).json(evidenceRefusal.body)
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
        : markdownUnreadable ? markdownUnreadableReason(operations) : null,
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
  // the user: "I can quickly play that, and I'm going to hear the voice and know
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
  // Surface-only by decision (the user, 2026-08-02): the server NEVER drives
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
    if (sessionId.startsWith('phone_')) { try { requirePhoneRecording(sessionId) } catch (error) { const e = error as Error & { status?: number; reason?: string }; res.status(e.status ?? 409).json({ error: e.message, reason: e.reason }); return } }
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
    const macCapture = readMacRecording(sessionId)
    const phoneCapture = readPhoneRecording(sessionId)
    const entries = capture.entries.map(entry => {
      if (phoneCapture) return { ...entry, chunk: { ...entry.chunk, speaker: 'Ext', speakerPolicy: 'anonymous' as const, sourceType: PHONE_SOURCE_TYPE } }
      if (!macCapture) return entry
      const receipt = macChunkReceipt(sessionId, entry.chunkIndex)
      return { ...entry, chunk: { ...entry.chunk, speaker: 'Ext', speakerPolicy: 'high-confidence' as const,
        ...(receipt ? { elapsed: receipt.endElapsed - receipt.durationMs, audioDurationMs: receipt.durationMs } : {}) } }
    })
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
      const hqJob = recoveryHqJob(quarantineDir, segments, entries, undefined, sessionId)
      const plan = hqJob.plan
      const results = await enqueueSerializedHqWork(hqJob.run)
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
        // SILENCE IS AN OUTCOME, NOT A FAILURE.
        //
        // This used to throw, which left the capture in the unsaved list and
        // retried it forever -- 1,131 times for one 33-second capture on
        // 2026-08-25, alternating with the auto-recover path claiming success,
        // while the panel showed only "1 recoverable" and the error went to
        // stderr. The user sees a Recover button that does nothing, because it
        // literally cannot succeed on audio with no speech in it.
        //
        // Receipt it and let it clear. The audio stays on disk for its full
        // retention window, so a capture wrongly judged silent is not lost.
        markRecoveredNoSpeech(quarantineDir, entries.length)
        if (macCapture) closeMacRecording(sessionId)
        if (phoneCapture) closePhoneRecording(sessionId)
        console.log(
          `[meeting/orphans] ${sessionId} held no speech `
          + `(${entries.length} chunks, ${Math.round((Date.now() - startedAt) / 1000)}s) `
          + '— receipted as no_speech; audio retained until retention expires',
        )
        return
      }
      const recoveredChunks = results.map(item => ({
        text: item.text,
        speaker: macCapture || phoneCapture ? 'Ext' : 'Unknown',
        ...(phoneCapture ? { speakerPolicy: 'anonymous' as const, sourceType: PHONE_SOURCE_TYPE } : {}),
        ...(macCapture ? { speakerPolicy: 'high-confidence' as const } : {}),
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
        startTime: macCapture?.startTime ?? phoneCapture?.startTime ?? capture.startTime,
        durationMs: macCapture ? Math.max(...entries.map(e => e.chunk.elapsed + (e.chunk.audioDurationMs ?? 0))) : capture.durationMs,
        chunks: recoveredChunks,
        chunkEntries: recoveredChunks.map((chunk, position) => ({
          chunkIndex: results[position]?.segment.startChunkIdx ?? position,
          chunk,
        })),
        transferIntegrity: null,
      })
      try { persistSttSidecar(saved.sidecarPath, results, summarizeStt(plan, results, segments.length)) } catch (error) {
        console.warn(`[meeting/orphans] ${sessionId}: STT hypotheses not saved: ${error instanceof Error ? error.message : error}`)
      }
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
      await runCleanupStage(transcriptCleanup, { sessionId, meetingPath: saved.filepath, sidecarPath: saved.sidecarPath }, sessions)
      if (cosOpsPipelineConfigured() && !macCapture && !phoneCapture) {
        await handoffMeetingToOperations(saved.filepath)
      } else {
        // Orphan recovery is its own path and never reaches
        // scheduleFinalizationJob, so a recovered standalone meeting would
        // otherwise stay permanently un-enriched.
        // Full wall from here, not a shared finalization budget: recovery
        // already holds the long-running orphan_recovery lease that COS
        // Control surfaces and warns on before committing a drain.
        await enrichStandaloneMeeting(saved.filepath, Date.now())
      }
      if (!macCapture && !phoneCapture) triggerMeetingMergeRun('orphan_recovered')
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
  finalDiarize?: FinalDiarize
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

  // 6.61.0: the Nemotron final pass relabels the transcript just persisted,
  // while the raw chunk audio still exists and BEFORE this job reaches
  // ops_pending, so COS sync (sync_meetings.py --g2-import-file, run by the
  // handoff after this function returns) only ever imports the relabelled
  // meeting. It never throws and writes nothing unless every word survives;
  // on any failure the meeting stays exactly as saved above.
  // Skipped when the batch text landed but its sidecar did not: the two would
  // disagree about which transcript is canonical. Counted and logged like any
  // other skip, so health shows it.
  if (options.finalDiarize && transcriptApplied && !metadataPersisted) {
    recordFinalPassSkip('metadata_not_persisted', 'the batch transcript was applied but its sidecar was not written')
  } else if (options.finalDiarize) {
    try {
      await options.finalDiarize({
        meetingPath: options.meetingPath,
        sidecarPath: options.sidecarPath,
        audioDir: options.audioDir,
      })
    } catch (error) {
      console.warn(`[diarizer] final pass threw; the saved transcript is unchanged: ${error instanceof Error ? error.message : String(error)}`)
    }
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

let defaultAutonomousFinalizer: AutonomousFinalizer | null = null
export const meetingRouter = createMeetingRouter({ autonomousFinalize: { onCreate: finalizer => { defaultAutonomousFinalizer = finalizer } } })

/**
 * 6.81.0: at boot (once admissions open), pick up every Stop the server was holding when it
 * last exited and check it again. A Stop is durable, so a restart between the Stop and the
 * last chunk loses nothing: the finalizer waits for recovery, then for the chunks.
 */
export function resumeAutonomousMeetingSaves(): void {
  void defaultAutonomousFinalizer?.tick('boot')
}

/** 6.77.0: what the transcript cleanup routes need from the meeting layer. */
export function transcriptCleanupRouteDeps(store: MeetingStore = getMeetingStore()): TranscriptCleanupRouteDeps {
  return {
    sessionState: id => defaultSessionState(id),
    sessionStartedAt: id => getSessionStartTime(id),
    findMeeting: id => {
      const meeting = store.findBySessionId(id)
      return meeting ? { meetingPath: meeting.filepath, sidecarPath: meeting.sidecarPath } : null
    },
  }
}

/**
 * Boot: delete cleanup data (screen context and ledgers) whose meeting is gone, and screen
 * text past its retention. Deferred and unref'd, so it never delays startup or a restart.
 */
export function scheduleTranscriptCleanupSweep(delayMs = 90_000): void {
  const timer = setTimeout(() => {
    try {
      const store = getMeetingStore()
      const jobs = new MeetingFinalizationJobStore()
      const result = sweepTranscriptCleanupData({
        now: Date.now(),
        known: id => defaultSessionState(id) !== 'missing' || Boolean(jobs.get(id)) || store.findBySessionId(id) !== null,
      })
      if (result.screenDeleted || result.ledgersDeleted) {
        console.log(`[transcript-cleanup] swept ${result.screenDeleted} screen and ${result.ledgersDeleted} ledger files`)
      }
    } catch { /* the next boot sweeps again */ }
  }, delayMs)
  timer.unref()
}
