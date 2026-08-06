import { Router } from 'express'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { COS_SCRIPTS_DIR, COS_MODE } from '../lib/python-bridge.js'
import { serverMetrics } from '../lib/server-metrics.js'
import { getServerInstanceId } from '../lib/server-instance-id.js'
import { localFirstMeetingsCapability } from '../lib/local-first-meetings-contract.js'
import { isSileroAvailable } from '../lib/vad-silero.js'
import { speakerModelState, speakerReadiness } from '../lib/speaker-embeddings.js'
import { chunkEmbeddingStoreStats } from '../lib/chunk-embedding-store.js'
import { correctionStoreStats } from '../lib/meeting-corrections.js'
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
import { G2_LENS_VARIANT_CAPABILITY } from '../lib/media-store.js'
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
import { getWhisperPreviewCapability } from '../lib/whisper-preview.js'
import { getTranscriptionProfileStatus } from '../lib/profile.js'
import { getHealthStaticProbes } from '../lib/health-static-probes.js'
import { getEarlyMeetingSyncSnapshot } from '../lib/g2-ops-handoff.js'
import { getProgressiveHqSnapshot } from '../lib/meeting-batch-transcribe.js'
import { getMeetingFinalizationSnapshot } from '../lib/meeting-finalization-jobs.js'

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
    g2LensVariant: G2_LENS_VARIANT_CAPABILITY,
    durableQueryJobs: durableJobs.enabled,
    durableQueryJobsProtocol: durableJobs.protocolVersion,
    localFirstMeetings: localFirstMeetings !== null,
    transcriptionPolicy: transcription.mode,
    liveCues: liveCues.available,
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
    count: unsavedList.filter(item => !item.recovered).length,
    items: unsavedList.slice(0, 10).map(item => ({
      sessionId: item.sessionId,
      ageHours: item.ageHours,
      chunkFiles: item.chunkFiles,
      expiresAt: item.expiresAt,
      recovered: item.recovered,
    })),
  }
  res.json({
    ...checks,
    server_version: managedServerVersion(),
    server_instance_id: getServerInstanceId(),
    boot_id: serverMetrics.bootId,
    generation_id: getServerGenerationId(),
    features,
    voice,
    readiness,
    whisper_health,
    openai_whisper_budget,
    tts_local,
    codex_models,
    cursor_models,
    meeting_sync,
    unsaved_captures,
    chunk_embeddings: chunkEmbeddings,
    speaker_corrections: speakerCorrections,
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
  const cursorOptions = cursorCatalog.options.filter(option => !!option.id)
  res.json({
    ...catalog,
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
