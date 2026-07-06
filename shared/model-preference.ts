export type ClaudeModelPreference = 'opus' | 'sonnet' | 'haiku'
export type CodexModelPreference = 'codex-high'
export type ModelPreference = ClaudeModelPreference | CodexModelPreference

export const DEFAULT_MODEL = 'sonnet' as const
export const CODEX_HIGH_MODEL: CodexModelPreference = 'codex-high'

// Optional codex model passed to `codex exec --model`. Empty (the default) means
// "use whatever model your codex CLI is configured for" — so the public server
// never pins a specific (possibly unreleased) model id. Set COS_CODEX_MODEL to
// pin one. COS_CODEX_REASONING_EFFORT tunes the reasoning level (default high).
export const CODEX_MODEL_ID = process.env.COS_CODEX_MODEL ?? ''
export const CODEX_HIGH_REASONING_EFFORT = process.env.COS_CODEX_REASONING_EFFORT ?? 'high'

export const MODEL_OPTIONS: ModelPreference[] = ['opus', 'sonnet', 'haiku', 'codex-high']

const MODEL_SET = new Set<ModelPreference>(['opus', 'sonnet', 'haiku', 'codex-high'])

export function isModelPreference(value: unknown): value is ModelPreference {
  return typeof value === 'string' && MODEL_SET.has(value as ModelPreference)
}

export function normalizeModelPreference(value: unknown): ModelPreference | undefined {
  return isModelPreference(value) ? value : undefined
}

export function isClaudeModel(model: ModelPreference): model is ClaudeModelPreference {
  return model === 'opus' || model === 'sonnet' || model === 'haiku'
}

export function isCodexModel(model: ModelPreference): model is CodexModelPreference {
  return model === 'codex-high'
}

export function modelLabel(model: ModelPreference): string {
  switch (model) {
    case 'sonnet': return 'Sonnet'
    case 'haiku': return 'Haiku'
    case 'codex-high': return 'Codex High'
    case 'opus':
    default:
      return 'Opus'
  }
}

export function modelShortLabel(model: ModelPreference): string {
  switch (model) {
    case 'sonnet': return 'Sonnet'
    case 'haiku': return 'Haiku'
    case 'codex-high': return 'Codex H'
    case 'opus':
    default:
      return 'Opus'
  }
}

export function modelButtonLabel(model: ModelPreference): string {
  switch (model) {
    case 'sonnet': return 'SNNT'
    case 'haiku': return 'HAIKU'
    case 'codex-high': return 'CODEX H'
    case 'opus':
    default:
      return 'OPUS'
  }
}

export function modelTag(model: ModelPreference): string {
  switch (model) {
    case 'sonnet': return 'S'
    case 'haiku': return 'H'
    case 'codex-high': return 'CH'
    case 'opus':
    default:
      return 'O'
  }
}

export function modelBracketTag(model: ModelPreference): string {
  return ` [${modelTag(model)}]`
}
