import { Router } from 'express'
import {
  LensGistInputError,
  getLensGist,
  lensGistHealth,
  listLensGistEngines,
  normalizeLensGistInput,
  saveLensGistConfig,
} from '../lib/lens-gist.js'
import { errMsg } from '../lib/utils.js'

// Server 6.54.0. The phone asks for the three-line card behind the G2 prompt box
// (lib/lens-gist.ts). Every answer the server gives is a 200 with a `status`, so the
// phone never reads "the server answered no" as "the server is unreachable" (gotchas:
// an HTTP status means the server ANSWERED). Only a malformed request is a 400.
export const lensGistRouter = Router()

lensGistRouter.post('/lens-gist', async (req, res) => {
  let input
  try {
    input = normalizeLensGistInput(req.body)
  } catch (err) {
    res.status(err instanceof LensGistInputError ? err.status : 400).json({ error: errMsg(err) })
    return
  }
  // No abort on disconnect: the phone asks ahead of the hold and may not wait, and the
  // answer is cached for when it asks again.
  try {
    res.json(await getLensGist(input))
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

lensGistRouter.get('/lens-gist/config', async (_req, res) => {
  try {
    res.json({ ...lensGistHealth(), engines: await listLensGistEngines() })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

lensGistRouter.put('/lens-gist/config', (req, res) => {
  try {
    const saved = saveLensGistConfig(req.body ?? {})
    const overridden = !!process.env.COS_LENS_GIST_ENGINE?.trim()
    res.json({ saved: true, effective: saved, ...(overridden ? { overriddenByEnv: 'COS_LENS_GIST_ENGINE' } : {}) })
  } catch (err) {
    res.status(err instanceof LensGistInputError ? err.status : 500).json({ error: errMsg(err) })
  }
})
