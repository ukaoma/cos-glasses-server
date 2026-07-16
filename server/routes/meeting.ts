// POST /api/meeting/save — finalize an existing transcribe-stream session into
// the standalone public meeting store. The live transcript and chunk metadata
// are durable before the session is closed; batch improvement runs afterward.

import { rmSync } from 'node:fs'
import { Router } from 'express'
import { emitDisplay } from '../lib/display-bus.js'
import { cleanTranscriptLines } from '../lib/hallucination-filter.js'
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
import { runMeetingBatchPipeline } from '../lib/meeting-batch-transcribe.js'
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
  hasSessionAudio,
  moveSessionAudioToPending,
  type IndexedTranscriptChunk,
  type ProviderCandidateRecord,
  type TranscriptChunk,
  type TranscriptGapReport,
} from './transcribe-stream.js'

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
  ) => Promise<BatchTranscription>
  scheduleBackground?: (task: Promise<void>) => void
  emit?: typeof emitDisplay
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

export function createMeetingRouter(deps: MeetingRouteDependencies = {}): Router {
  const store = deps.store ?? getMeetingStore()
  const sessions = deps.sessions ?? defaultSessionSource
  const runBatch = deps.runBatch ?? runMeetingBatchPipeline
  const scheduleBackground = deps.scheduleBackground ?? (task => { void task })
  const emit = deps.emit ?? emitDisplay
  const router = Router()
  const savingSessions = new Set<string>()

  router.post('/meeting/save', async (req, res) => {
    let lockedSessionId: string | null = null
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

      // A response can be lost after both durable files were committed. Find
      // the sidecar by session ID so client retry/restart is idempotent.
      const alreadySaved = store.findBySessionId(sessionId)
      if (alreadySaved) {
        res.set('Cache-Control', 'private, no-store')
        res.json(publicSaveResponse(alreadySaved, true))
        return
      }
      if (savingSessions.has(sessionId)) {
        res.status(409).json({ error: 'Meeting save already in progress', reason: 'save_in_progress' })
        return
      }
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
      })

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

      res.set('Cache-Control', 'private, no-store')
      res.json(publicSaveResponse(saved))

      if (audioWritesReady && pendingAudioDir && chunkEntries.length > 0) {
        const task = finalizeBatch({
          audioDir: pendingAudioDir,
          entries: chunkEntries.map(entry => ({ ...entry, chunk: { ...entry.chunk } })),
          streamingWordCount: countWords(transcript),
          meetingPath: saved.filepath,
          sidecarPath: saved.sidecarPath,
          runBatch,
        }).catch(error => {
          // Raw audio deliberately remains for the existing two-hour cleanup.
          console.error(
            `[meeting/save] Batch finalization failed for ${sessionId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        })
        scheduleBackground(task)
      }
    } catch (error) {
      if (error instanceof MeetingStoreError) {
        res.status(error.status).json({ error: error.message, reason: error.code })
        return
      }
      console.error('[meeting/save] Finalization failed:', error)
      res.status(500).json({ error: 'Meeting save failed', reason: 'meeting_save_error' })
    } finally {
      if (lockedSessionId) savingSessions.delete(lockedSessionId)
    }
  })

  return router
}

async function finalizeBatch(options: {
  audioDir: string
  entries: IndexedTranscriptChunk[]
  streamingWordCount: number
  meetingPath: string
  sidecarPath: string
  runBatch: NonNullable<MeetingRouteDependencies['runBatch']>
}): Promise<void> {
  const result = await options.runBatch(
    options.audioDir,
    options.entries,
    options.streamingWordCount,
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
    console.warn('[meeting/save] Pending raw audio retained for bounded two-hour cleanup')
  }
}

export const meetingRouter = createMeetingRouter()
