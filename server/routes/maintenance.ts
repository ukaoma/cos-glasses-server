import { Router } from 'express'
import { managedRuntimeCapability, managedServerVersion } from '../lib/managed-runtime.js'
import { getQueryJobRuntimeHealth } from '../lib/query-job-runtime.js'
import { getServerInstanceId } from '../lib/server-instance-id.js'
import { getWhisperHealth, restartWhisperServer } from '../lib/whisper-local.js'
import { getActiveTranscriptionSessionCount } from './transcribe-stream.js'

export const maintenanceRouter = Router()

function statusSnapshot() {
  const jobs = getQueryJobRuntimeHealth()
  const activeTranscriptionSessions = getActiveTranscriptionSessionCount()
  const managed = managedRuntimeCapability()
  return {
    contractVersion: managed.contractVersion,
    managed: managed.managed,
    serverVersion: managedServerVersion(),
    serverInstanceId: getServerInstanceId(),
    activeJobs: jobs.activeRuns,
    activeTranscriptionSessions,
    shuttingDown: jobs.shuttingDown,
    durableStoreState: jobs.store.state,
    safeToRestart: managed.managed
      && jobs.activeRuns === 0
      && activeTranscriptionSessions === 0
      && !jobs.shuttingDown,
    whisper: getWhisperHealth(),
  }
}

maintenanceRouter.get('/maintenance/status', (_req, res) => {
  res.json(statusSnapshot())
})

maintenanceRouter.post('/maintenance/whisper/restart', async (_req, res) => {
  const before = statusSnapshot()
  if (!before.managed) {
    res.status(409).json({ error: 'server_not_managed', retryable: false })
    return
  }
  if (before.activeTranscriptionSessions > 0) {
    res.status(409).json({
      error: 'active_transcription_sessions',
      activeTranscriptionSessions: before.activeTranscriptionSessions,
      retryable: true,
    })
    return
  }
  const result = await restartWhisperServer()
  if (result.status !== 'recovered') {
    res.status(503).json({ error: 'whisper_restart_failed', retryable: true })
    return
  }
  res.json({ status: 'recovered', whisper: getWhisperHealth() })
})
