import { Router } from 'express'
import { runProviderProof, type ProofProvider } from '../lib/provider-proof.js'

export const providerProofRouter = Router()

// Authenticated by the global /api token boundary. This performs one real,
// no-tool model turn and exposes no provider output or credentials.
providerProofRouter.post('/diagnostics/provider-proof', async (req, res) => {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address === '127.0.0.1'
    || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return res.status(403).json({ error: 'loopback_required' })
  const provider = req.body?.provider
  if (provider !== 'claude' && provider !== 'codex') {
    return res.status(400).json({ error: 'provider must be claude or codex' })
  }
  const result = await runProviderProof(provider as ProofProvider)
  return res.status(result.ok ? 200 : 503).json(result)
})
