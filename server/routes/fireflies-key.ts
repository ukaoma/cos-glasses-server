// Fireflies key endpoints.
//
//   POST   /api/fireflies-key/set     store the key, then check it
//   GET    /api/fireflies-key/status  configured, source, savedAt, validatedAt, lastCheck
//   DELETE /api/fireflies-key         remove the stored key
//   POST   /api/fireflies-key/check   check now (this is the user-initiated one)
//
// The key is never in a response, and never in a log line. `status` reads the
// remembered check rather than calling the vendor, so a settings pane that
// polls it costs nothing.

import { Router } from 'express'
import { FirefliesKeyError, getFirefliesClient, getFirefliesKeyStore, type FirefliesKeyStore } from '../lib/fireflies-key.js'
import { getFirefliesImporter } from '../lib/meeting-import.js'
import type { FirefliesClient, FirefliesKeyCheck } from '../lib/fireflies-client.js'

export interface FirefliesKeyRouterDeps {
  store: () => FirefliesKeyStore
  client: () => FirefliesClient
  /** Told whenever the stored key changes, so a sticky invalid_key can clear. */
  onKeyChanged?: (event: { configured: boolean }) => void
  /** Told the result of every check, for the same reason. */
  onKeyChecked?: (check: FirefliesKeyCheck) => void
}

export function createFirefliesKeyRouter(deps: FirefliesKeyRouterDeps): Router {
  const router = Router()

  const runCheck = async (): Promise<FirefliesKeyCheck> => {
    const client = deps.client()
    const check = await client.checkKey({ userInitiated: true })
    deps.store().recordCheck(check)
    deps.onKeyChecked?.(check)
    return check
  }

  router.post('/fireflies-key/set', async (req, res) => {
    try {
      const store = deps.store()
      const saved = store.save(req.body?.key)
      deps.client().forgetKeyCheck()
      deps.onKeyChanged?.({ configured: true })
      const check = await runCheck()
      res.json({ ok: true, savedAt: saved.savedAt, status: store.status(), check })
    } catch (error) {
      if (error instanceof FirefliesKeyError) {
        return res.status(error.status).json({ error: { code: error.code, message: error.message } })
      }
      console.error('[fireflies-key] save failed')
      res.status(500).json({ error: { code: 'fireflies_key_save_failed', message: 'The key could not be saved.' } })
    }
  })

  router.get('/fireflies-key/status', (_req, res) => {
    try {
      const status = deps.store().status()
      const cached = deps.client().cachedKeyCheck()
      res.json({ ...status, ...(cached ? { lastCheck: { ...cached, cached: undefined } } : {}) })
    } catch (error) {
      console.error('[fireflies-key] status failed')
      res.status(500).json({ error: { code: 'fireflies_key_unavailable', message: 'The key status could not be read.' } })
    }
  })

  router.delete('/fireflies-key', (_req, res) => {
    try {
      const store = deps.store()
      store.delete()
      deps.client().forgetKeyCheck()
      deps.onKeyChanged?.({ configured: store.status().configured })
      res.json({ ok: true, status: store.status() })
    } catch (error) {
      if (error instanceof FirefliesKeyError) {
        return res.status(error.status).json({ error: { code: error.code, message: error.message } })
      }
      console.error('[fireflies-key] delete failed')
      res.status(500).json({ error: { code: 'fireflies_key_delete_failed', message: 'The key could not be removed.' } })
    }
  })

  router.post('/fireflies-key/check', async (_req, res) => {
    try {
      res.json(await runCheck())
    } catch (error) {
      console.error('[fireflies-key] check failed')
      res.status(500).json({ error: { code: 'fireflies_key_check_failed', message: 'The key could not be checked.' } })
    }
  })

  return router
}

// A sticky invalid_key is what stops the importer from spending a budget on a
// key the vendor already refused, so the two things that can make it wrong - a
// new key, and a check that now succeeds - have to reach the importer from
// here. Without this the only way out of the sticky state is a restart.
export const firefliesKeyRouter = createFirefliesKeyRouter({
  store: getFirefliesKeyStore,
  client: getFirefliesClient,
  onKeyChanged: () => getFirefliesImporter().onKeyChanged(),
  onKeyChecked: check => getFirefliesImporter().onKeyChecked(check),
})
