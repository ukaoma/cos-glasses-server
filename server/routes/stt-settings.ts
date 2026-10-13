// Speech-to-text settings (6.72.0). Token-protected by the /api middleware.
//
//   GET  /api/stt-settings                    the settings, every option with availability, Parakeet status
//   PUT  /api/stt-settings                    partial body: {"hq":"parakeet-ultra"}, {"resolver":false}, ...
//   POST /api/stt-settings/parakeet/install   install the pinned Parakeet CLI and models (202; poll GET)
//        body {} | {"localSource":"/abs/path"} | {"localSource":"...","allowDownload":true}
//   DELETE /api/stt-settings/parakeet/install cancel a running install (nothing partial is kept)
//
// Clients find the route with GET: a 404 means an older server, so they hide the switcher.
// The contract is shared with COS Control and the phone (see README "Speech-to-text settings").

import { Router } from 'express'
import { errMsg } from '../lib/utils.js'
import { cancelParakeetInstall, installParakeet, parakeetInstalled, parakeetInstallRunning, type InstallOptions } from '../lib/parakeet.js'
import { currentSttCapabilities, ensurePreviewWarm, parakeetStatus } from '../lib/stt-runtime.js'
import {
  applySettingsPatch, readLastSttJob, readSttSettings, settingsView, SttSettingsError, writeSttSettings,
  type SttCapabilities,
} from '../lib/stt-settings.js'

export interface SttSettingsRouterDeps {
  recordingLive: () => boolean
  capabilities?: () => SttCapabilities
  install?: (options: InstallOptions) => Promise<void>
  onChanged?: () => void
}

export function createSttSettingsRouter(deps: SttSettingsRouterDeps): Router {
  const router = Router()
  const caps = deps.capabilities ?? currentSttCapabilities
  const install = deps.install ?? installParakeet
  const view = () => settingsView(readSttSettings(), caps(), parakeetStatus(deps.recordingLive()), readLastSttJob())

  router.get('/stt-settings', (_req, res) => {
    try { res.json(view()) } catch (err) { res.status(500).json({ error: errMsg(err) }) }
  })

  router.put('/stt-settings', (req, res) => {
    try {
      const next = applySettingsPatch(readSttSettings(), req.body, caps())
      writeSttSettings(next)
      ensurePreviewWarm()
      deps.onChanged?.()
      res.json(view())
    } catch (err) {
      if (err instanceof SttSettingsError) return void res.status(400).json({ error: err.message })
      res.status(500).json({ error: errMsg(err) })
    }
  })

  router.post('/stt-settings/parakeet/install', (req, res) => {
    try {
      if (deps.recordingLive()) return void res.status(409).json({ error: 'A recording is live. Install Parakeet after it is saved.' })
      if (parakeetInstalled().installed && !parakeetInstallRunning()) return void res.status(200).json({ started: false, ...view() })
      const body = (req.body ?? {}) as { localSource?: unknown; allowDownload?: unknown }
      const raw = body.localSource
      if (raw !== undefined && (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 1024)) {
        return void res.status(400).json({ error: 'localSource must be an absolute path.' })
      }
      if (body.allowDownload !== undefined && typeof body.allowDownload !== 'boolean') return void res.status(400).json({ error: 'allowDownload must be true or false.' })
      // Only bytes whose SHA-256 matches the pinned manifest are ever copied from it.
      // A named localSource that lacks a file fails plainly unless allowDownload is true.
      const options: InstallOptions = raw ? { localSources: [raw], requireLocal: body.allowDownload !== true } : {}
      if (!parakeetInstallRunning()) {
        void install(options).then(() => { ensurePreviewWarm(); deps.onChanged?.() }).catch(error => {
          console.warn(`[stt] Parakeet install failed: ${errMsg(error)}`)
        })
      }
      res.status(202).json({ started: true, ...view() })
    } catch (err) {
      res.status(500).json({ error: errMsg(err) })
    }
  })

  router.delete('/stt-settings/parakeet/install', (_req, res) => {
    try {
      const cancelled = cancelParakeetInstall()
      res.status(cancelled ? 202 : 200).json({ cancelled, ...view() })
    } catch (err) {
      res.status(500).json({ error: errMsg(err) })
    }
  })

  return router
}
