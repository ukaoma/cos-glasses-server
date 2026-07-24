import { Router } from 'express'
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { COS_SCRIPTS_DIR, COS_MODE, PYTHON_BIN } from '../lib/python-bridge.js'
import { serverMetrics } from '../lib/server-metrics.js'
import { getServerInstanceId } from '../lib/server-instance-id.js'
import { localFirstMeetingsCapability } from '../lib/local-first-meetings-contract.js'
import { isSileroAvailable } from '../lib/vad-silero.js'
import { getAvailableCliSessionId } from '../lib/claude-bridge.js'
import { isWhisperLocalAvailable, getWhisperHealth } from '../lib/whisper-local.js'
import { getOpenAIWhisperBudgetState } from '../lib/openai-whisper-budget.js'
import { getKeyStatus } from '../lib/openai-key.js'
import {
  getCodexModelCatalog,
  getCodexModelCatalogSnapshot,
} from '../lib/codex-model-catalog.js'
import { isMediaProcessingReady } from '../lib/image-safety.js'
import { G2_LENS_VARIANT_CAPABILITY } from '../lib/media-store.js'
import { durableQueryJobsCapability } from '../lib/query-job-feature.js'
import { getQueryJobRuntimeHealth } from '../lib/query-job-runtime.js'
import { getTranscriptionPolicySnapshot } from '../lib/transcription-policy.js'
import { CLI_DEBUG_CAPABILITY } from '../lib/cli-debug-view.js'
import { managedRuntimeCapability, managedServerVersion } from '../lib/managed-runtime.js'
import { getServerGenerationId } from '../lib/managed-runtime.js'
import { maintenanceLifecycle } from '../lib/maintenance-lifecycle.js'

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
  const checks: Record<string, string | number | boolean> = {
    status: 'ok',
    mode: COS_MODE ? 'cos' : 'standalone',
    server: 'ok',
    python: 'unknown',
    claude: 'unknown',
    codex: 'unknown',
    uptime_seconds: Math.floor((Date.now() - serverMetrics.startedAt) / 1000),
    request_count: serverMetrics.requestCount,
  }

  // Feature detection flags
  let claudeAvailable = false
  let codexAvailable = false

  // Check Python venv (COS mode only)
  if (PYTHON_BIN) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(PYTHON_BIN!, ['--version'], { timeout: 5000 }, (err, stdout) => {
          if (err) return reject(err)
          checks.python = stdout.trim()
          resolve()
        })
      })
    } catch {
      checks.python = 'error'
    }
  } else {
    checks.python = 'standalone'
  }

  // Check claude CLI
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) return reject(err)
        checks.claude = stdout.trim()
        claudeAvailable = true
        resolve()
      })
    })
  } catch {
    checks.claude = 'error'
  }

  // Check Codex CLI. The desktop CLI can print benign PATH warnings to stderr,
  // so version extraction uses stdout + stderr and looks for the codex-cli line.
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('codex', ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) return reject(err)
        const combined = `${stdout}\n${stderr}`.trim()
        const versionLine = combined.split('\n').map(line => line.trim()).find(line => /^codex(?:-cli)?\s+/i.test(line))
        checks.codex = versionLine ?? combined.split('\n')[0] ?? 'available'
        codexAvailable = true
        resolve()
      })
    })
  } catch {
    checks.codex = 'error'
  }

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
  const recovery = managedRuntimeCapability()
  const maintenance = maintenanceLifecycle.snapshot()
  const features = {
    claude: claudeAvailable,
    codex: codexAvailable,
    voice: keyStatus.hasKey,
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
  }
  const voice = {
    hasKey: keyStatus.hasKey,
    keySource: keyStatus.source,
  }

  // Whisper-server health + cloud budget — exposed so glasses + dashboards can
  // see whether we're at risk of falling to cloud and how much budget remains.
  const whisper_health = getWhisperHealth()
  const openai_whisper_budget = getOpenAIWhisperBudgetState()

  const codex_models = getCodexModelCatalogSnapshot()
  res.json({
    ...checks,
    server_version: managedServerVersion(),
    server_instance_id: getServerInstanceId(),
    boot_id: serverMetrics.bootId,
    generation_id: getServerGenerationId(),
    features,
    voice,
    whisper_health,
    openai_whisper_budget,
    codex_models,
    capabilities: {
      transcription,
      recovery,
      maintenance: {
        state: maintenance.state,
        admissionsOpen: maintenance.admissionsOpen,
        carriedAcrossBoot: maintenance.operation?.carriedAcrossBoot ?? false,
      },
      cliDebug: CLI_DEBUG_CAPABILITY,
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

// Stable app slots backed by Codex's live model/list catalog. This route is
// authenticated by the global /api middleware; ?refresh=1 forces discovery.
healthRouter.get('/models', async (req, res) => {
  const catalog = await getCodexModelCatalog(req.query.refresh === '1')
  const durableJobs = durableQueryJobStatus()
  const localFirstMeetings = localFirstMeetingsCapability(getServerInstanceId())
  const transcription = getTranscriptionPolicySnapshot()
  res.json({
    ...catalog,
    serverInstanceId: getServerInstanceId(),
    capabilities: {
      durableQueryJobs: {
        enabled: durableJobs.enabled,
        protocolVersion: durableJobs.protocolVersion,
      },
      transcription,
      cliDebug: CLI_DEBUG_CAPABILITY,
      recovery: managedRuntimeCapability(),
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
