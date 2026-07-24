import { Router } from 'express'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteFileSync } from '../lib/atomic-fs.js'
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
    managed: process.env.COS_HARNESS === 'daemon',
  })
})

recoveryRouter.get('/recovery/status', (_req, res) => {
  res.json({
    bootId: serverMetrics.bootId,
    managed: process.env.COS_HARNESS === 'daemon',
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
  if (process.env.COS_HARNESS !== 'daemon') {
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
  // cancel an accepted restart or strand maintenance forever.
  const timer = setTimeout(() => {
    if (process.env.COS_DISABLE_SELF_RESTART === '1') { gate.release(); return }
    try {
      process.kill(process.pid, 'SIGTERM')
    } catch (error) {
      gate.release()
      console.error('[recovery] Failed to signal managed server restart:', error)
    }
  }, 350)
  timer.unref?.()
})
