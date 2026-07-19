import type { ClaudeRunConfig, ClaudeRunRecord } from './claude-run-ledger.js'
import type { CodexRunConfig, CodexRunRecord } from './codex-run-ledger.js'

export const CLI_DEBUG_CAPABILITY = Object.freeze({
  schemaVersion: 1,
  providers: Object.freeze({ claude: true, codex: true }),
  metadataOnly: true,
})

export type SafeCliRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'client_disconnected'

export interface SafeCliDebugLatestRun {
  status: SafeCliRunStatus
  model: string
  concreteModel?: string
  effort?: string
  resumed: boolean
  durationMs?: number
  updatedAt: string
  errorCode?: string
}

export interface SafeCliDebugProvider {
  supported: true
  persistenceEnabled: boolean
  workspaceConfigured: boolean
  latestRun: SafeCliDebugLatestRun | null
}

export interface SafeCliDebugResponse {
  schemaVersion: 1
  providers: {
    claude: SafeCliDebugProvider
    codex: SafeCliDebugProvider
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function safeStatus(value: unknown): SafeCliRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed'
    || value === 'cancelled' || value === 'client_disconnected'
    ? value
    : 'failed'
}

function safeModelLabel(value: unknown, provider: 'claude' | 'codex'): string | undefined {
  const model = optionalString(value)
  if (!model || model.length > 96) return undefined
  const allowed = provider === 'claude'
    ? /^(?:claude-|opus(?:\[1m\])?$|sonnet(?:\[1m\])?$|fable(?:\[1m\])?$|haiku(?:\[1m\])?$)[a-z0-9._\[\]-]*$/i
    : /^(?:gpt-|codex-)[a-z0-9._\[\]-]*$/i
  return allowed.test(model) ? model : undefined
}

function safeEffort(value: unknown): string | undefined {
  const effort = optionalString(value)?.toLowerCase()
  return effort && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'].includes(effort)
    ? effort
    : undefined
}

function safeTimestamp(value: unknown): string {
  const timestamp = optionalString(value)
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString()
}

function safeErrorCode(provider: 'claude' | 'codex', value: unknown): string | undefined {
  const candidate = optionalString(value)
  if (!candidate) return undefined
  const allowed = new Set([
    `${provider}.cli_unavailable`,
    `${provider}.permission_denied`,
    `${provider}.auth_error`,
    `${provider}.timeout`,
    `${provider}.nonzero_exit`,
    `${provider}.error`,
    `${provider}.interrupted`,
  ])
  return allowed.has(candidate) ? candidate : `${provider}.error`
}

export function safeClaudeLatestRun(run?: ClaudeRunRecord): SafeCliDebugLatestRun | null {
  if (!run) return null
  const concreteModel = safeModelLabel(run.resolvedModelId ?? run.cliModelId, 'claude')
  const effort = safeEffort(run.effortLevel)
  const errorCode = safeErrorCode('claude', run.errorCode)
  return {
    status: safeStatus(run.status),
    model: safeModelLabel(run.model, 'claude') ?? 'unknown',
    ...(concreteModel ? { concreteModel } : {}),
    ...(effort ? { effort } : {}),
    resumed: run.resumed === true,
    ...(optionalFiniteNumber(run.durationMs) !== undefined ? { durationMs: run.durationMs } : {}),
    updatedAt: safeTimestamp(run.updatedAt),
    ...(errorCode ? { errorCode } : {}),
  }
}

export function safeCodexLatestRun(run?: CodexRunRecord): SafeCliDebugLatestRun | null {
  if (!run) return null
  const concreteModel = safeModelLabel(run.cliModel, 'codex')
  const effort = safeEffort(run.reasoningEffort)
  const errorCode = safeErrorCode('codex', run.errorCode)
  return {
    status: safeStatus(run.status),
    model: safeModelLabel(run.model, 'codex') ?? 'unknown',
    ...(concreteModel ? { concreteModel } : {}),
    ...(effort ? { effort } : {}),
    resumed: run.resumed === true,
    ...(optionalFiniteNumber(run.durationMs) !== undefined ? { durationMs: run.durationMs } : {}),
    updatedAt: safeTimestamp(run.updatedAt),
    ...(errorCode ? { errorCode } : {}),
  }
}

export function safeCliDebugResponse(
  claudeConfig: ClaudeRunConfig,
  claudeRun: ClaudeRunRecord | undefined,
  codexConfig: CodexRunConfig,
  codexRun: CodexRunRecord | undefined,
): SafeCliDebugResponse {
  return {
    schemaVersion: 1,
    providers: {
      claude: {
        supported: true,
        persistenceEnabled: claudeConfig.persistenceEnabled === true,
        workspaceConfigured: Boolean(claudeConfig.cwd),
        latestRun: safeClaudeLatestRun(claudeRun),
      },
      codex: {
        supported: true,
        persistenceEnabled: codexConfig.persistenceEnabled === true,
        workspaceConfigured: Boolean(codexConfig.cwd),
        latestRun: safeCodexLatestRun(codexRun),
      },
    },
  }
}

/** Compatibility projection for build 210 and earlier Settings panels.
 * Every returned key is an explicit public-safe allowlist entry. */
export function safeLegacyClaudeResponse(config: ClaudeRunConfig, runs: ClaudeRunRecord[]) {
  return {
    schemaVersion: 1,
    config: {
      persistenceEnabled: config.persistenceEnabled === true,
      workspaceConfigured: Boolean(config.cwd),
      cwd: config.cwd ? 'Configured workspace' : 'Not configured',
      defaultEffortLevel: safeEffort(config.defaultEffortLevel) ?? 'high',
      contentPreviewsEnabled: false,
    },
    runs: runs.map(run => {
      const latest = safeClaudeLatestRun(run)!
      return {
        status: latest.status,
        model: latest.model,
        ...(latest.concreteModel ? {
          cliModelId: latest.concreteModel,
          resolvedModelId: latest.concreteModel,
        } : {}),
        ...(latest.effort ? { effortLevel: latest.effort } : {}),
        ...(typeof latest.resumed === 'boolean' ? { resumed: latest.resumed } : {}),
        ...(latest.durationMs !== undefined ? { durationMs: latest.durationMs } : {}),
        ...(latest.updatedAt ? { updatedAt: latest.updatedAt } : {}),
        ...(latest.errorCode ? { errorCode: latest.errorCode } : {}),
      }
    }),
  }
}

/** Compatibility projection for build 210 and earlier Settings panels.
 * Engine sessions are deliberately absent: their thread ids are resumable
 * runtime handles, not display metadata. */
export function safeLegacyCodexResponse(config: CodexRunConfig, runs: CodexRunRecord[]) {
  return {
    schemaVersion: 1,
    config: {
      persistenceEnabled: config.persistenceEnabled === true,
      workspaceConfigured: Boolean(config.cwd),
      cwd: config.cwd ? 'Configured workspace' : 'Not configured',
      cliModel: safeModelLabel(config.cliModel, 'codex') ?? 'unknown',
      reasoningEffort: safeEffort(config.reasoningEffort) ?? 'high',
      contentPreviewsEnabled: false,
    },
    runs: runs.map(run => {
      const latest = safeCodexLatestRun(run)!
      return {
        status: latest.status,
        model: latest.model,
        ...(latest.concreteModel ? { cliModel: latest.concreteModel } : {}),
        ...(latest.effort ? { reasoningEffort: latest.effort } : {}),
        ...(typeof latest.resumed === 'boolean' ? { resumed: latest.resumed } : {}),
        ...(latest.durationMs !== undefined ? { durationMs: latest.durationMs } : {}),
        ...(latest.updatedAt ? { updatedAt: latest.updatedAt } : {}),
        ...(latest.errorCode ? { errorCode: latest.errorCode } : {}),
      }
    }),
  }
}
