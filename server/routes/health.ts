import { Router } from 'express'
import { isWorthRecovering } from '../lib/quarantine-auto-recover.js'
import { claudeSessionsEnabled } from './claude-sessions.js'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { COS_SCRIPTS_DIR, COS_MODE } from '../lib/python-bridge.js'
import { serverMetrics } from '../lib/server-metrics.js'
import { getServerInstanceId } from '../lib/server-instance-id.js'
import { localFirstMeetingsCapability } from '../lib/local-first-meetings-contract.js'
import { isSileroAvailable } from '../lib/vad-silero.js'
import { profileProvenanceSummary, speakerModelState, speakerReadiness } from '../lib/speaker-embeddings.js'
import { chunkEmbeddingStoreStats } from '../lib/chunk-embedding-store.js'
import { correctionStoreStats } from '../lib/meeting-corrections.js'
import { meetingAudioStats } from '../lib/meeting-audio-archive.js'
import { adaptivePlaybackStatus } from '../lib/adaptive-playback-audio.js'
import { getAvailableCliSessionId } from '../lib/claude-bridge.js'
import {
  isWhisperLocalAvailable,
  getWhisperHealth,
  getHighQualityTranscriptionCapability,
} from '../lib/whisper-local.js'
import { getOpenAIWhisperBudgetState } from '../lib/openai-whisper-budget.js'
import { getKeyStatus } from '../lib/openai-key.js'
import {
  getCodexModelCatalog,
  getCodexModelCatalogSnapshot,
} from '../lib/codex-model-catalog.js'
import {
  getCursorModelCatalog,
  getCursorModelCatalogSnapshot,
  isCursorProviderReady,
} from '../lib/cursor-model-catalog.js'
import { isMediaProcessingReady } from '../lib/image-safety.js'
import {
  MAX_OTHER_MEDIA_BYTES,
  MAX_VIDEO_MEDIA_BYTES,
  getMediaLimits,
  getRichMediaProcessingCapabilities,
} from '../lib/rich-media-safety.js'
import { G2_LENS_VARIANT_CAPABILITY } from '../lib/media-store.js'
// The flag lives beside the endpoints it describes, so it cannot drift from
// whether they are actually registered.
import { MEDIA_CHUNKED_UPLOAD_ENABLED } from './media.js'
import { durableQueryJobsCapability } from '../lib/query-job-feature.js'
import { getQueryJobRuntimeHealth } from '../lib/query-job-runtime.js'
import { getTranscriptionPolicySnapshot } from '../lib/transcription-policy.js'
import { CLI_DEBUG_CAPABILITY } from '../lib/cli-debug-view.js'
import { managedRuntimeCapability, managedServerVersion } from '../lib/managed-runtime.js'
import { getServerGenerationId } from '../lib/managed-runtime.js'
import { maintenanceLifecycle } from '../lib/maintenance-lifecycle.js'
import { getLocalTtsHealth, refreshLocalTtsHealth } from '../lib/tts-local.js'
import { liveCuesCapability } from '../lib/live-cues-capability.js'
import { getMeetingSyncSnapshot } from '../lib/meeting-batch-progress.js'
import { listUnsavedCaptures } from '../lib/unsaved-audio-quarantine.js'
import { getStrandedCaptures } from './transcribe-stream.js'
import { getWhisperPreviewCapability } from '../lib/whisper-preview.js'
import { getTranscriptionProfileStatus } from '../lib/profile.js'
import { getHealthStaticProbes } from '../lib/health-static-probes.js'
import { getEarlyMeetingSyncSnapshot } from '../lib/g2-ops-handoff.js'
import { getProgressiveHqSnapshot } from '../lib/meeting-batch-transcribe.js'
import { getMeetingFinalizationSnapshot } from '../lib/meeting-finalization-jobs.js'
import { resolveMeetingLibrary } from '../lib/cos-operations-meetings.js'
import { videoUploadV2Capability } from '../lib/video-upload-v2.js'
import { MAX_MODEL_IMAGE_INPUTS } from '../lib/query-attachments.js'
// Continue-vs-Fork is decided before a thread is named, so it cannot be
// discovered from the per-thread attachability probe. ABSENT MEANS DISABLED on
// all three fields: an older server omits them and every client must read that as
// off. The rule, and the only sanctioned reader of it, live in the module.
import {
  threadAttachCapability,
  threadAttachHealthFields,
} from '../lib/thread-attach-capability.js'

export const healthRouter = Router()

function durableQueryJobStatus() {
  const configured = durableQueryJobsCapability()
  const runtime = getQueryJobRuntimeHealth()
  return {
    configured: configured.enabled,
    enabled: configured.enabled
      && runtime.store.state === 'ready'
      && !runtime.shuttingDown,
    protocolVersion: configured.protocolVersion,
    activeRuns: runtime.activeRuns,
    shuttingDown: runtime.shuttingDown,
    callbackPersistenceFailures: runtime.callbackPersistenceFailures,
    terminalProjectionFailures: runtime.terminalProjectionFailures,
    store: {
      state: runtime.store.state,
      hydratedJobs: runtime.store.hydratedJobs,
      retainedIdentities: runtime.store.retainedIdentities,
      subscribers: runtime.store.subscribers,
      malformedRows: runtime.store.malformedRows,
      journalFailures: runtime.store.journalFailures,
      interruptedOnBoot: runtime.store.interruptedOnBoot,
      lastErrorCode: runtime.store.lastErrorCode,
      lastSuccessfulWriteAt: runtime.store.lastSuccessfulWriteAt,
      rootFingerprint: runtime.store.rootFingerprint,
      counts: runtime.store.counts,
    },
  }
}

healthRouter.get('/health', async (_req, res) => {
  const [, staticProbes] = await Promise.all([
    refreshLocalTtsHealth(),
    getHealthStaticProbes(),
  ])
  const checks: Record<string, string | number | boolean> = {
    status: 'ok',
    mode: COS_MODE ? 'cos' : 'standalone',
    server: 'ok',
    python: staticProbes.python,
    claude: staticProbes.claude,
    codex: staticProbes.codex,
    cursor: staticProbes.cursor,
    uptime_seconds: Math.floor((Date.now() - serverMetrics.startedAt) / 1000),
    request_count: serverMetrics.requestCount,
  }

  // Feature detection flags
  const claudeAvailable = staticProbes.claudeAvailable
  const codexAvailable = staticProbes.codexAvailable
  const cursorAvailable = staticProbes.cursorAvailable

  // Check session cache freshness (COS mode only)
  if (COS_SCRIPTS_DIR) {
    try {
      const cacheFile = resolve(COS_SCRIPTS_DIR, '.session_index_cache_COS-Glasses.json')
      checks.last_cache_write = statSync(cacheFile).mtime.toISOString()
    } catch {
      checks.last_cache_write = 'missing'
    }
  }

  checks.silero_vad = isSileroAvailable() ? 'active' : 'disabled'

  // Speaker diarization is opt-in (the ~26 MB voiceprint model ships outside the
  // npm tarball), so publish its state rather than letting the amplitude
  // fallback masquerade as working diarization. Availability only — the resolved
  // path is a local filesystem detail and health is unauthenticated.
  const speakerId = speakerModelState()
  checks.speaker_id = speakerId.state

  // Visible so the correction loop can be seen banking evidence rather than
  // trusted to be. Counts only — no session ids on an unauthenticated surface.
  const chunkEmbeddings = chunkEmbeddingStoreStats()
  // `pending` is the number that matters here: an intent that never closed means
  // some meeting's files may be half-rewritten.
  const speakerCorrections = correctionStoreStats()
  const reviewAudio = {
    ...meetingAudioStats(),
    adaptivePlayback: adaptivePlaybackStatus(),
  }
  // `noHumanSample` is the one to read: a profile with no human-verified sample
  // is trained entirely on labels the system chose for itself.
  const voiceProvenance = speakerId.state === 'active' ? profileProvenanceSummary() : null

  // Health is unauthenticated. Publish only availability; the actual CLI
  // session id is a resumable runtime handle and belongs on authenticated
  // query/debug surfaces.
  const cliSid = getAvailableCliSessionId()
  checks.cli_session_available = Boolean(cliSid)

  // Feature summary for client capability detection.
  // v5.9.5 — voice.hasKey reflects the centralized resolver (env > saved file >
  // COS scripts .env), not just process.env, so a key configured via the
  // Settings panel correctly reports voice as available without a server
  // restart. The nested voice block also exposes the source so future wizard
  // work can decide whether to prompt for a key.
  const keyStatus = getKeyStatus()
  const durableJobs = durableQueryJobStatus()
  const localFirstMeetings = localFirstMeetingsCapability(getServerInstanceId())
  const transcription = getTranscriptionPolicySnapshot()
  const transcriptionHq = getHighQualityTranscriptionCapability()
  const transcriptionLive = getWhisperPreviewCapability()
  const transcriptionProfile = getTranscriptionProfileStatus()
  const recovery = managedRuntimeCapability()
  const maintenance = maintenanceLifecycle.snapshot()
  const tts_local = getLocalTtsHealth()
  // Computed once per request; the same value feeds features.liveCues and
  // capabilities.liveCues so the two surfaces can never disagree.
  const liveCues = liveCuesCapability()
  const richMedia = await getRichMediaProcessingCapabilities()
  const videoUploadV2 = videoUploadV2Capability(richMedia.video)
  // Upload limits are published so the client never carries its own byte caps:
  // cos-glasses-app and cos-glasses-server are separate repos that have already
  // diverged, so a constant in both is guaranteed to drift. Absent means an
  // older server, and the client falls back to single-shot.
  const mediaLimits = await getMediaLimits({ chunkedUploadEnabled: MEDIA_CHUNKED_UPLOAD_ENABLED })
  const features = {
    claude: claudeAvailable,
    codex: codexAvailable,
    cursor: cursorAvailable,
    voice: keyStatus.hasKey || tts_local.ready,
    cos_pipeline: COS_MODE,
    whisper: isWhisperLocalAvailable(),
    promptRecovery: true,
    meetingFinalization: true,
    iphoneAsrCandidates: process.env.COS_IOS_ASR_CANDIDATES === '1',
    mediaProcessingReady: await isMediaProcessingReady(),
    pdfProcessingReady: richMedia.pdf,
    videoProcessingReady: richMedia.video,
    g2LensVariant: G2_LENS_VARIANT_CAPABILITY,
    durableQueryJobs: durableJobs.enabled,
    durableQueryJobsProtocol: durableJobs.protocolVersion,
    localFirstMeetings: localFirstMeetings !== null,
    transcriptionPolicy: transcription.mode,
    liveCues: liveCues.available,
    // Published so a CLIENT toggle can read its own state cheaply.
    //
    // COS Control's "Show Claude sessions" checkbox sourced its state from
    // GET /api/claude-sessions -- the call that also lists every session -- and the
    // panel never made that call. The box therefore rendered OFF whatever the
    // setting was, and the setting was ON: Miles enabled it four times against a
    // control that could only ever show him false.
    //
    // This is a pure env read, so it costs nothing on a health poll, and health is
    // what every other toggle on that screen already reads.
    claudeSessions: claudeSessionsEnabled(),
  }
  const voice = {
    available: keyStatus.hasKey || tts_local.ready,
    hasKey: keyStatus.hasKey,
    keySource: keyStatus.source,
    localReady: tts_local.ready,
    engine: tts_local.engine,
  }

  // Whisper-server health + cloud budget — exposed so glasses + dashboards can
  // see whether we're at risk of falling to cloud and how much budget remains.
  const whisper_health = getWhisperHealth()
  const whisperReadiness = !whisper_health.serverConfigured
    ? 'not_configured'
    : whisper_health.server
      ? 'ready'
      : whisper_health.startupState === 'preflight' || whisper_health.startupState === 'loading'
        ? 'starting'
        : 'degraded'
  // A configured-but-broken voiceprint model is a fault, not a preference. The
  // full reasoning, including why 'unavailable' must NOT degrade, lives with
  // speakerReadiness() so it is testable rather than an inline ternary here.
  const speakerReadinessState = speakerReadiness(speakerId.state)
  const readiness = {
    // /api/health remains a liveness endpoint and intentionally returns HTTP
    // 200 while the server can answer. This separate field prevents an HTTP-
    // green response from hiding a configured local subsystem failure.
    status: whisperReadiness === 'degraded' || speakerReadinessState === 'degraded' ? 'degraded' : 'ready',
    admissions: maintenance.admissionsOpen ? 'open' : 'maintenance',
    whisper: whisperReadiness,
    whisperError: whisper_health.lastError,
    localTts: tts_local.ready ? 'ready' : 'unavailable',
    // Asserted, not merely reported: `speaker_id` above says what the state IS,
    // this says whether that state is acceptable.
    speakerId: speakerReadinessState,
  }
  const openai_whisper_budget = getOpenAIWhisperBudgetState()
  const codex_models = getCodexModelCatalogSnapshot()
  // Unauthenticated /api/health publishes Cursor slot capability only; concrete
  // agent binary paths stay on the authenticated /api/models surface.
  const cursorSnapshot = getCursorModelCatalogSnapshot()
  const { agentBinary: _cursorAgentBinary, ...cursor_models } = cursorSnapshot
  const meeting_sync = getMeetingSyncSnapshot()
  const progressiveHq = getProgressiveHqSnapshot()
  // Quarantined unsaved captures (6.19.0). Compact on this unauthenticated
  // surface — same exposure level as meeting_sync's meetingIds. Full detail
  // plus the recover action live on the authenticated /api/meeting/orphans.
  const unsavedList = listUnsavedCaptures()
  const unsaved_captures = {
    count: unsavedList.filter(isWorthRecovering).length,
    items: unsavedList.slice(0, 10).map(item => ({
      sessionId: item.sessionId,
      ageHours: item.ageHours,
      chunkFiles: item.chunkFiles,
      expiresAt: item.expiresAt,
      recovered: item.recovered,
    })),
  }
  // Captures that stopped receiving audio but are NOT yet quarantined, so they do
  // not appear in unsaved_captures for up to four hours. This is the state COS
  // Control could not see on 2026-08-09: its panel read "2 recording(s) active.
  // Restart is locked." while both had been silent for 184 and 24 minutes. Compact
  // here; full detail on the authenticated orphans route.
  const strandedList = getStrandedCaptures()
  const stranded_captures = {
    count: strandedList.length,
    items: strandedList.slice(0, 10).map(item => ({
      sessionId: item.sessionId,
      idleMinutes: item.idleMinutes,
      capturedMinutes: item.capturedMinutes,
      chunks: item.chunks,
      promotesAt: item.promotesAt,
      hasDraft: item.draftPath != null,
    })),
  }
  const meetingLibrary = resolveMeetingLibrary()
  // Read per request. In production this is the same answer the bindings router
  // resolved at boot — server/bootstrap.js populates process.env before either
  // module is imported — so the two cannot disagree.
  //
  // NAMED GAP: route registration IS resolved once, at wiring time. Something
  // mutating process.env after boot would make this field lead the routes. The
  // blast radius is a Continue button that 404s, never a write: the attach route
  // is its own gate and an unregistered route cannot be talked into running.
  const threadAttach = threadAttachCapability()
  res.json({
    ...checks,
    server_version: managedServerVersion(),
    ...threadAttachHealthFields(threadAttach),
    server_instance_id: getServerInstanceId(),
    boot_id: serverMetrics.bootId,
    generation_id: getServerGenerationId(),
    mediaLimits,
    features,
    voice,
    readiness,
    whisper_health,
    openai_whisper_budget,
    tts_local,
    codex_models,
    cursor_models,
    meeting_sync,
    meeting_library: {
      layout: meetingLibrary.layout,
      ready: meetingLibrary.layout !== 'invalid_explicit_root',
      warningCount: meetingLibrary.warnings.length,
    },
    unsaved_captures,
    stranded_captures,
    chunk_embeddings: chunkEmbeddings,
    speaker_corrections: speakerCorrections,
    review_audio: reviewAudio,
    ...(voiceProvenance ? { voice_provenance: voiceProvenance } : {}),
    capabilities: {
      transcription: {
        ...transcription,
        live: transcriptionLive,
        hq: transcriptionHq,
        profile: transcriptionProfile,
      },
      recovery,
      maintenance: {
        state: maintenance.state,
        admissionsOpen: maintenance.admissionsOpen,
        carriedAcrossBoot: maintenance.operation?.carriedAcrossBoot ?? false,
      },
      cliDebug: CLI_DEBUG_CAPABILITY,
      liveCues,
      richMedia: {
        text: true,
        pdf: richMedia.pdf,
        video: richMedia.video,
        maxAttachments: 5,
        // Sourced from the constants rather than restated here: video now has a
        // HIGHER cap than everything else, so a single hardcoded number on this
        // surface would tell a client to refuse a video the server accepts.
        maxBytesPerAttachment: MAX_OTHER_MEDIA_BYTES,
        maxVideoBytesPerAttachment: MAX_VIDEO_MEDIA_BYTES,
        maxVideoMinutes: 20,
        maxStillFrames: 8,
        videoUploadV2: {
          available: videoUploadV2.available,
          protocol: videoUploadV2.protocol,
          reason: videoUploadV2.reason,
        },
      },
      meetingLifecycle: {
        earlySyncClaim: getEarlyMeetingSyncSnapshot(),
        progressiveHq,
        finalization: getMeetingFinalizationSnapshot(),
      },
      ...(localFirstMeetings ? { localFirstMeetings } : {}),
    },
    // /api/health is intentionally unauthenticated for setup diagnostics.
    // Publish capability only; job counts, retention identities, subscriber
    // counts, and the storage fingerprint remain internal.
    durable_query_jobs: {
      configured: durableJobs.configured,
      enabled: durableJobs.enabled,
      protocolVersion: durableJobs.protocolVersion,
      state: durableJobs.store.state,
    },
  })
})

// Stable app slots backed by Codex + Cursor live catalogs. Authenticated by
// global /api middleware; ?refresh=1 forces discovery.
healthRouter.get('/models', async (req, res) => {
  const forceRefresh = req.query.refresh === '1'
  const catalog = await getCodexModelCatalog(forceRefresh)
  const cursorCatalog = await getCursorModelCatalog(forceRefresh)
  const durableJobs = durableQueryJobStatus()
  const localFirstMeetings = localFirstMeetingsCapability(getServerInstanceId())
  const transcription = getTranscriptionPolicySnapshot()
  const transcriptionHq = getHighQualityTranscriptionCapability()
  const transcriptionLive = getWhisperPreviewCapability()
  const transcriptionProfile = getTranscriptionProfileStatus()
  const progressiveHq = getProgressiveHqSnapshot()
  const richMedia = await getRichMediaProcessingCapabilities()
  const videoUploadV2 = videoUploadV2Capability(richMedia.video)
  const cursorOptions = cursorCatalog.options.filter(option => !!option.id)
  // Same helper and the same three key names as /api/health, for the reason
  // liveCues carries three lines below: the companion's 15s liveness poll reads
  // THIS surface and Main.ts states outright that /api/health alone is not used,
  // so a capability published only there is invisible to the phone.
  const threadAttach = threadAttachCapability()
  res.json({
    ...catalog,
    ...threadAttachHealthFields(threadAttach),
    options: [
      ...(catalog.options ?? []),
      ...cursorOptions,
    ],
    cursor: cursorCatalog,
    cursorReady: isCursorProviderReady(),
    serverInstanceId: getServerInstanceId(),
    capabilities: {
      durableQueryJobs: {
        enabled: durableJobs.enabled,
        protocolVersion: durableJobs.protocolVersion,
      },
      transcription: {
        ...transcription,
        live: transcriptionLive,
        hq: transcriptionHq,
        profile: transcriptionProfile,
      },
      meetingLifecycle: {
        earlySyncClaim: getEarlyMeetingSyncSnapshot(),
        progressiveHq,
        finalization: getMeetingFinalizationSnapshot(),
      },
      cliDebug: CLI_DEBUG_CAPABILITY,
      recovery: managedRuntimeCapability(),
      // Same helper as /api/health — the companion's 15s liveness poll reads
      // THIS surface, so a value present only on /api/health leaves the
      // live-cues indicator blind.
      liveCues: liveCuesCapability(),
      richMedia: {
        video: richMedia.video,
        maxPromptVisuals: MAX_MODEL_IMAGE_INPUTS,
        videoUploadV2: {
          ...videoUploadV2,
          // The first private train deliberately admits only one video and no
          // other visual attachment. This keeps a server fallback at its
          // proven 16-frame policy inside the provider-wide 16-image ceiling.
          promptAdmission: {
            maxVideos: 1,
            maxOtherVisualsWithVideo: 0,
          },
        },
      },
      ...(localFirstMeetings ? { localFirstMeetings } : {}),
    },
  })
})
// GET /api/cli-session — returns current CLI session ID for cross-device resume
healthRouter.get('/cli-session', (req, res) => {
  const cosSessionId = req.query.sid as string | undefined
  const cliSid = getAvailableCliSessionId(cosSessionId)
  res.json({ cliSessionId: cliSid ?? null })
})
