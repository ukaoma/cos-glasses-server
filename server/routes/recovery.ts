import { Router } from 'express'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteFileSync } from '../lib/atomic-fs.js'
import { scheduleManagedServerRestart } from '../lib/managed-restart.js'
import { isManagedRuntime } from '../lib/managed-runtime.js'
import { acquireMaintenance, getRecoveryActivityStatus } from '../lib/recovery-activity.js'
import { getWhisperHealth, restartWhisperServer } from '../lib/whisper-local.js'
import { serverMetrics } from '../lib/server-metrics.js'

export const recoveryRouter = Router()
const COOLDOWN_MS = 60_000
const cooldownPath = resolve(import.meta.dirname, '../data/.recovery_restart.json')

function lastRestartAt(): number {
  try { return Number(JSON.parse(readFileSync(cooldownPath, 'utf8'))?.at) || 0 } catch { return 0 }
}

recoveryRouter.get('/live', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    status: 'ok', bootId: serverMetrics.bootId, pid: process.pid,
    uptimeSeconds: Math.round((Date.now() - serverMetrics.startedAt) / 1000),
    // COS Control LaunchAgent sets COS_MANAGED=1 with COS_HARNESS=foreground.
    // Do not require COS_HARNESS=daemon — that false-negative blocked phone Restart.
    managed: isManagedRuntime(),
  })
})

recoveryRouter.get('/recovery/status', (_req, res) => {
  res.json({
    bootId: serverMetrics.bootId,
    managed: isManagedRuntime(),
    whisper: getWhisperHealth(),
    asr: { hqActive: false, hqQueued: 0, fastRestarting: false }, // public build: no HQ/fast ASR scheduler in this server
    activity: getRecoveryActivityStatus(),
  })
})

recoveryRouter.post('/recovery/whisper/restart', async (_req, res) => {
  const gate = acquireMaintenance()
  if (!gate.ok) {
    gate.release()
    return res.status(409).json({ error: 'Recovery blocked by active work', reason: 'recovery_busy', busy: gate.busy })
  }
  try {
    const result = await restartWhisperServer()
    res.status(result.status === 'failed' ? 503 : 200).json(result)
  } finally { gate.release() }
})

recoveryRouter.post('/recovery/server/restart', (_req, res) => {
  if (!isManagedRuntime()) {
    return res.status(409).json({ error: 'Server is not managed by the COS LaunchAgent', reason: 'restart_unmanaged' })
  }
  const elapsed = Date.now() - lastRestartAt()
  if (elapsed < COOLDOWN_MS) {
    return res.status(429).json({ error: 'Restart cooldown active', reason: 'restart_cooldown', retryAfterMs: COOLDOWN_MS - elapsed })
  }
  const gate = acquireMaintenance()
  if (!gate.ok) {
    gate.release()
    return res.status(409).json({ error: 'Restart blocked by active work', reason: 'recovery_busy', busy: gate.busy })
  }
  atomicWriteFileSync(cooldownPath, JSON.stringify({ at: Date.now(), bootId: serverMetrics.bootId }))
  res.status(202).json({ accepted: true, oldBootId: serverMetrics.bootId })
  // Schedule independently of the response socket. The phone may change
  // network/close the sheet immediately after receiving 202; that must not
  // cancel an accepted restart. Maintenance is in-process only — it dies with us.
  //
  // Do NOT SIGTERM→exit(0): Control's LaunchAgent KeepAlive is
  // SuccessfulExit:false, so a clean exit leaves the service STOPPED and the
  // phone shows "Restart requested; reconnect is taking longer than expected."
  scheduleManagedServerRestart({
    onError: (error) => {
      gate.release()
      console.error('[recovery] Failed to schedule managed server restart:', error)
    },
  })
})
