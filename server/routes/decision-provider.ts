/** Mounted behind the ordinary /api token and mutation-lease middleware. Selection only; no credential egress. */
import { Router } from 'express'
import { JEV_MODEL, resolveJevKey } from '../lib/jev.js'
import { resolveSubqKey, subqKeyStatus } from '../lib/subq-key.js'
import { SUBQ_MODEL } from '../lib/decision-provider.js'
import { decisionSettingsView, DecisionSettingsError, patchDecisionSettings, readDecisionSettings, writeDecisionSettings, type DecisionProvider, type DecisionSettings } from '../lib/decision-settings.js'
export interface DecisionProviderRouteDeps {
  read: () => DecisionSettings
  write: (settings: DecisionSettings) => void
  configured: () => Record<DecisionProvider, boolean>
  env: NodeJS.ProcessEnv
  keyStatus: () => { jev: { configured:boolean; source:string }; subq: { configured:boolean; source:string } }
}
export function createDecisionProviderRouter(overrides: Partial<DecisionProviderRouteDeps> = {}): Router {
  const deps: DecisionProviderRouteDeps = { read: readDecisionSettings, write: writeDecisionSettings, configured: () => ({ jev: !!resolveJevKey(), subq: !!resolveSubqKey() }), env: process.env, keyStatus: () => { const jev = resolveJevKey(); return { jev: { configured:!!jev, source:jev?.source ?? 'none' }, subq:subqKeyStatus() } }, ...overrides }
  const router = Router()
  const view = (settings: DecisionSettings) => ({ ...decisionSettingsView(settings, deps.configured(), deps.env), models: { jev: JEV_MODEL, subq: SUBQ_MODEL }, keyStatus: deps.keyStatus(),
    capabilities: { choices: ['jev','subq'], workflows: ['session','completion','search'], hotReload: true, fallback: false, subqImages: true, subqKeySource: 'config-or-env' } })
  router.use('/decision-provider', (_req,res,next) => { res.set('Cache-Control','private, no-store'); next() })
  router.get('/decision-provider', (_req,res) => {
    try { res.json(view(deps.read())) } catch { res.status(503).json({ error: { code: 'decision_settings_unavailable', message: 'Decision provider settings could not be read.' } }) }
  })
  router.patch('/decision-provider', (req,res) => {
    try {
      const next = patchDecisionSettings(deps.read(), req.body)
      const result = view(next) // validate effective environment and build safe response BEFORE committing
      deps.write(next)
      res.json(result)
    } catch (e) {
      if (e instanceof DecisionSettingsError && e.code === 'decision_settings_conflict') return void res.status(409).json({ error: { code: e.code, message: 'Decision settings changed. Reload them before saving.' } })
      if (e instanceof DecisionSettingsError && e.code === 'invalid_decision_settings') return void res.status(400).json({ error: { code: e.code, message: 'Choose jev or subq, or null to clear a saved setting. Unknown fields are not accepted.' } })
      res.status(503).json({ error: { code: 'decision_settings_unavailable', message: 'Decision provider settings could not be saved.' } })
    }
  })
  return router
}
