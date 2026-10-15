/** Private, durable classifier selection. No key storage or account/network changes. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { secureExistingPrivateFile, securePrivateDirectory } from './secure-user-config.js'

export type DecisionProvider = 'jev' | 'subq'
export const DECISION_WORKFLOWS = ['session', 'completion', 'search'] as const
export type DecisionUseCase = typeof DECISION_WORKFLOWS[number]
export interface DecisionSettings { schema: 1; provider?: DecisionProvider; overrides: Partial<Record<DecisionUseCase, DecisionProvider>> }
export class DecisionSettingsError extends Error {
  constructor(readonly code: 'invalid_decision_settings' | 'decision_settings_unavailable' | 'decision_invalid_provider' | 'decision_settings_conflict') { super(code) }
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const provider = (v: unknown): v is DecisionProvider => v === 'jev' || v === 'subq'
const settingsFile = () => dataPath('decision-provider.json')
export function readDecisionSettings(file = settingsFile()): DecisionSettings {
  try {
    secureExistingPrivateFile(file)
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!record(value) || value.schema !== 1 || !record(value.overrides) || Object.keys(value).some(k => !['schema','provider','overrides'].includes(k)) ||
      (value.provider !== undefined && !provider(value.provider)) || Object.entries(value.overrides).some(([key,v]) => !DECISION_WORKFLOWS.includes(key as DecisionUseCase) || !provider(v))) throw new Error('invalid')
    return value as unknown as DecisionSettings
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return { schema: 1, overrides: {} }
    throw new DecisionSettingsError('decision_settings_unavailable')
  }
}
export function decisionSettingsRevision(settings: DecisionSettings): string {
  return createHash('sha256').update(JSON.stringify([settings.provider ?? null, ...DECISION_WORKFLOWS.map(w => settings.overrides[w] ?? null)])).digest('hex')
}
export function patchDecisionSettings(current: DecisionSettings, raw: unknown): DecisionSettings {
  if (!record(raw) || !Object.keys(raw).length || Object.keys(raw).some(k => !['provider','overrides','expectedRevision'].includes(k)) || typeof raw.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.expectedRevision) || (!('provider' in raw) && !('overrides' in raw)) ||
    ('provider' in raw && raw.provider !== null && !provider(raw.provider)) ||
    ('overrides' in raw && (!record(raw.overrides) || !Object.keys(raw.overrides).length || Object.entries(raw.overrides).some(([k,v]) => !DECISION_WORKFLOWS.includes(k as DecisionUseCase) || (v !== null && !provider(v)))))) {
    throw new DecisionSettingsError('invalid_decision_settings')
  }
  if (raw.expectedRevision !== decisionSettingsRevision(current)) throw new DecisionSettingsError('decision_settings_conflict')
  const next: DecisionSettings = { ...current, overrides: { ...current.overrides } }
  if ('provider' in raw) { if (raw.provider === null) delete next.provider; else next.provider = raw.provider as DecisionProvider }
  if (record(raw.overrides)) for (const [key,value] of Object.entries(raw.overrides)) {
    if (value === null) delete next.overrides[key as DecisionUseCase]; else next.overrides[key as DecisionUseCase] = value as DecisionProvider
  }
  return next
}
export function writeDecisionSettings(next: DecisionSettings, file = settingsFile()): void {
  securePrivateDirectory(dirname(file)); secureExistingPrivateFile(file)
  durableAtomicWriteFileSync(file, JSON.stringify(next) + '\n', { mode: 0o600 })
}
export function resolveDecisionSelection(useCase: DecisionUseCase, env: NodeJS.ProcessEnv = process.env, settings = readDecisionSettings()): { provider: DecisionProvider; source: 'config' | 'env' | 'default' } {
  const workflowEnv = env[`COS_DECISION_PROVIDER_${useCase.toUpperCase()}`]
  const choice = settings.overrides[useCase] ?? workflowEnv ?? settings.provider ?? env.COS_DECISION_PROVIDER ?? 'jev'
  const selected = choice.trim().toLowerCase()
  if (!provider(selected)) throw new DecisionSettingsError('decision_invalid_provider')
  return { provider: selected, source: settings.overrides[useCase] !== undefined ? 'config' : workflowEnv !== undefined ? 'env' : settings.provider !== undefined ? 'config' : env.COS_DECISION_PROVIDER !== undefined ? 'env' : 'default' }
}
export function decisionSettingsView(settings: DecisionSettings, configured: Record<DecisionProvider, boolean>, env: NodeJS.ProcessEnv = process.env) {
  const global = resolveDecisionSelection('session', { COS_DECISION_PROVIDER: env.COS_DECISION_PROVIDER }, { schema: 1, provider: settings.provider, overrides: {} })
  const selections = Object.fromEntries(DECISION_WORKFLOWS.map(w => [w, resolveDecisionSelection(w, env, settings)])) as Record<DecisionUseCase, ReturnType<typeof resolveDecisionSelection>>
  return { schema: 1 as const, revision: decisionSettingsRevision(settings), provider: global.provider, overrides: settings.overrides, effective: Object.fromEntries(DECISION_WORKFLOWS.map(w => [w,selections[w].provider])),
    sources: Object.fromEntries(DECISION_WORKFLOWS.map(w => [w,selections[w].source])), configured, saved: { provider: settings.provider ?? null, overrides: settings.overrides } }
}
