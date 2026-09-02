import { Router } from 'express'
import { PROOF_PROVIDERS, runProviderProof, type ProofProvider } from '../lib/provider-proof.js'
import {
  acquireMaintenanceWork,
  maintenanceErrorPayload,
  maintenanceOperationCredentialsValid,
  MaintenanceLifecycleError,
} from '../lib/maintenance-lifecycle.js'

export const providerProofRouter = Router()

// Authenticated by the global /api token boundary. This performs one real,
// no-tool model turn and exposes no provider output or credentials.
providerProofRouter.post('/diagnostics/provider-proof', async (req, res) => {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address === '127.0.0.1'
    || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return res.status(403).json({ error: 'loopback_required' })
  const provider = req.body?.provider
  if (!PROOF_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'provider must be claude, codex, or cursor', code: 'provider_unknown' })
  }
  const controllerProof = maintenanceOperationCredentialsValid({
    leaseId: typeof req.headers['x-cos-maintenance-lease'] === 'string'
      ? req.headers['x-cos-maintenance-lease'] : undefined,
    operationId: typeof req.headers['x-cos-maintenance-operation'] === 'string'
      ? req.headers['x-cos-maintenance-operation'] : undefined,
    nonce: typeof req.headers['x-cos-maintenance-nonce'] === 'string'
      ? req.headers['x-cos-maintenance-nonce'] : undefined,
  })
  let lease
  try {
    lease = acquireMaintenanceWork('api_mutation', { allowDuringDrain: controllerProof })
  } catch (error) {
    if (error instanceof MaintenanceLifecycleError) {
      if (error.retryAfterSeconds != null) res.setHeader('Retry-After', String(error.retryAfterSeconds))
      return res.status(error.status).json(maintenanceErrorPayload(error))
    }
    return res.status(500).json({ error: 'maintenance_internal_error', retryable: false })
  }

  const abort = new AbortController()
  let responseFinished = false
  const cancel = () => { if (!responseFinished) abort.abort(new Error('Control proof client disconnected')) }
  req.once('aborted', cancel)
  res.once('finish', () => { responseFinished = true })
  res.once('close', cancel)
  try {
    const result = await runProviderProof(provider as ProofProvider, abort.signal)
    if (abort.signal.aborted) return
    return res.status(result.ok ? 200 : 503).json(result)
  } finally {
    req.removeListener('aborted', cancel)
    res.removeListener('close', cancel)
    lease.release()
  }
})
