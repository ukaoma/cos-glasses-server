// Speech-to-text settings (6.72.0). Token-protected by the /api middleware.
//
//   GET  /api/stt-settings                    the settings, every option with availability, Parakeet status
//   PUT  /api/stt-settings                    partial body: {"hq":"parakeet-ultra"}, {"resolver":false}, ...
//   POST /api/stt-settings/parakeet/install   install the pinned Parakeet CLI and models (202; poll GET)
//        body {} | {"localSource":"/abs/path"} | {"localSource":"...","allowDownload":true}
//        6.74.0: {"cliPath":"/Applications/COS Control.app/Contents/Helpers/fluidaudiocli","allowDownload":true}
//        507 insufficient_disk, 422 cli_untrusted. allowDownload:false without localSource never downloads.
//   DELETE /api/stt-settings/parakeet/install cancel a running install (nothing partial is kept)
//   POST /api/stt-settings/parakeet/cli       6.74.0: COS Control registers its signed CLI and gets the verdict
//
// Clients find the route with GET: a 404 means an older server, so they hide the switcher.
// The contract is shared with COS Control and the phone (see README "Speech-to-text settings").

import { Router } from 'express'
import { errMsg } from '../lib/utils.js'
import {
  cancelParakeetInstall, findPinnedCli, installParakeet, parakeetDiskCheck, parakeetInstalled, parakeetInstallRunning, type InstallOptions,
} from '../lib/parakeet.js'
import { isCliPathShape, offerControlCli, trustCli, type CliTrust } from '../lib/parakeet-cli-trust.js'
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
  /** 6.74.0, tests: the disk precheck and the CLI verdict. */
  diskCheck?: () => { ok: boolean; freeBytes: number | null; requiredBytes: number }
  trust?: (path: string) => Promise<CliTrust>
  pinned?: (path: string) => Promise<boolean>
}

export function createSttSettingsRouter(deps: SttSettingsRouterDeps): Router {
  const router = Router()
  const caps = deps.capabilities ?? currentSttCapabilities
  const install = deps.install ?? installParakeet
  const diskCheck = deps.diskCheck ?? (() => parakeetDiskCheck())
  const trust = deps.trust ?? (path => trustCli(path))
  const pinned = deps.pinned ?? (async (path: string) => (await findPinnedCli([path])) !== null)
  const cliVerdict = (t: CliTrust) => t.trusted
    ? { trusted: true, trust: t.trust, teamId: t.teamId, version: t.version, versionSource: t.versionSource }
    : { trusted: false, reason: t.reason, detail: t.detail }
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

  // 6.74.0: COS Control says where its signed CLI is. The verdict is the same check the
  // install makes; a trusted path also makes GET report Parakeet as installable.
  router.post('/stt-settings/parakeet/cli', async (req, res) => {
    try {
      const cliPath = (req.body ?? {}).cliPath
      if (!isCliPathShape(cliPath)) return void res.status(400).json({ error: 'cliPath must be an absolute path to fluidaudiocli.' })
      const t = await trust(cliPath)
      if (t.trusted) offerControlCli(cliPath)
      res.status(t.trusted ? 200 : 422).json(cliVerdict(t))
    } catch (err) {
      res.status(500).json({ error: errMsg(err) })
    }
  })

  router.post('/stt-settings/parakeet/install', async (req, res) => {
    try {
      if (deps.recordingLive()) return void res.status(409).json({ error: 'A recording is live. Install Parakeet after it is saved.' })
      if (parakeetInstalled().installed && !parakeetInstallRunning()) return void res.status(200).json({ started: false, ...view() })
      const body = (req.body ?? {}) as { localSource?: unknown; allowDownload?: unknown; cliPath?: unknown }
      const raw = body.localSource
      if (raw !== undefined && (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 1024)) {
        return void res.status(400).json({ error: 'localSource must be an absolute path.' })
      }
      if (body.allowDownload !== undefined && typeof body.allowDownload !== 'boolean') return void res.status(400).json({ error: 'allowDownload must be true or false.' })
      if (body.cliPath !== undefined && !isCliPathShape(body.cliPath)) return void res.status(400).json({ error: 'cliPath must be an absolute path to fluidaudiocli.' })
      if (!parakeetInstallRunning()) {
        const disk = diskCheck()
        if (!disk.ok) {
          return void res.status(507).json({
            error: `Parakeet needs ${(disk.requiredBytes / 1e9).toFixed(1)} GB free on this Mac. Free some space, then install again. Whisper keeps working.`,
            reason: 'insufficient_disk', freeBytes: disk.freeBytes, requiredBytes: disk.requiredBytes,
          })
        }
        if (typeof body.cliPath === 'string' && !(await pinned(body.cliPath))) {
          const t = await trust(body.cliPath)
          if (!t.trusted) {
            return void res.status(422).json({ error: 'The speech tool in COS Control did not pass its check. Reinstall COS Control, then install again.', reason: 'cli_untrusted', cli: cliVerdict(t) })
          }
          offerControlCli(body.cliPath)
        }
      }
      // Only bytes whose SHA-256 matches the pinned manifest are ever copied from it.
      // A named localSource that lacks a file fails plainly unless allowDownload is true.
      // 6.74.0: allowDownload:false with no localSource also never downloads.
      const options: InstallOptions = {
        ...(raw ? { localSources: [raw], requireLocal: body.allowDownload !== true } : body.allowDownload === false ? { requireLocal: true } : {}),
        ...(typeof body.cliPath === 'string' ? { cliCandidates: [body.cliPath] } : {}),
      }
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
