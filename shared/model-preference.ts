export type ClaudeModelPreference = 'opus' | 'fable' | 'sonnet' | 'haiku'

// Stable app-level slots. Concrete GPT model ids resolve at runtime from the
// local Codex CLI catalog, so a shipped glasses app keeps tracking new releases.
export type CodexModelPreference = 'codex-frontier' | 'codex-balanced'
export type ModelPreference = ClaudeModelPreference | CodexModelPreference

// Preserve the public server's established fast, broadly available default.
export const DEFAULT_MODEL = 'sonnet' as const
export const CODEX_FRONTIER_MODEL: CodexModelPreference = 'codex-frontier'
export const CODEX_BALANCED_MODEL: CodexModelPreference = 'codex-balanced'
// Backward-compatible export for callers that predate the two-slot catalog.
export const CODEX_HIGH_MODEL: CodexModelPreference = CODEX_FRONTIER_MODEL
// Existing 6.1–6.3 installs may pin the legacy codex-high slot. Frontier is its
// migration target; Balanced remains auto-catalog even when this override is set.
export const CODEX_MODEL_ID = process.env.COS_CODEX_MODEL?.trim() ?? ''

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
const CODEX_REASONING_EFFORT_SET = new Set<CodexReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function resolveConfiguredCodexReasoningEffort(): CodexReasoningEffort {
  const raw = process.env.COS_CODEX_REASONING_EFFORT?.trim().toLowerCase()
  return raw && CODEX_REASONING_EFFORT_SET.has(raw as CodexReasoningEffort)
    ? raw as CodexReasoningEffort
    : 'high'
}

export const CODEX_HIGH_REASONING_EFFORT: CodexReasoningEffort = resolveConfiguredCodexReasoningEffort()

export const MODEL_OPTIONS: ModelPreference[] = [
  'opus',
  'fable',
  'sonnet',
  CODEX_FRONTIER_MODEL,
  CODEX_BALANCED_MODEL,
]

const MODEL_SET = new Set<ModelPreference>([
  'opus',
  'fable',
  'sonnet',
  'haiku',
  CODEX_FRONTIER_MODEL,
  CODEX_BALANCED_MODEL,
])

// Bare Claude tier aliases resolve to the newest model in that tier at spawn.
// The [1m] suffix keeps the large-context contract without pinning a version.
export const CLAUDE_CLI_MODEL_ID: Record<ClaudeModelPreference, string> = {
  opus: 'opus[1m]',
  fable: 'fable[1m]',
  sonnet: 'sonnet[1m]',
  haiku: 'haiku',
}

export function resolveClaudeCliModelId(model: ClaudeModelPreference): string {
  return CLAUDE_CLI_MODEL_ID[model] ?? CLAUDE_CLI_MODEL_ID[DEFAULT_MODEL]
}

/** Format a concrete Claude CLI model id for diagnostics. */
export function formatResolvedModelDisplay(cliModelId: string | undefined): string {
  if (!cliModelId) return ''
  const oneM = cliModelId.includes('[1m]')
  const bare = cliModelId.replace('[1m]', '')
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(bare)
  if (!match) return cliModelId
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1)
  const version = match[2].split('-').join('.')
  return `${family} ${version}${oneM ? ' (1M)' : ''}`
}

export type EffortPreference = 'high' | 'xhigh' | 'max' | 'ultracode'
export const DEFAULT_EFFORT: EffortPreference = 'high'
export const EFFORT_OPTIONS: EffortPreference[] = ['high', 'xhigh', 'max', 'ultracode']
const EFFORT_SET = new Set<EffortPreference>(EFFORT_OPTIONS)
export const ULTRACODE_KEYWORD = 'ultracode'

export function isEffortPreference(value: unknown): value is EffortPreference {
  return typeof value === 'string' && EFFORT_SET.has(value as EffortPreference)
}

export function normalizeEffortPreference(value: unknown): EffortPreference | undefined {
  return isEffortPreference(value) ? value : undefined
}

/** Map the UI-only ultracode choice to a Claude CLI effort flag. */
export function resolveCliEffortFlag(effort: EffortPreference): 'high' | 'xhigh' | 'max' {
  return effort === 'ultracode' ? 'xhigh' : effort
}

// Codex Fast mode is emitted only when the selected live model advertises it.
export const CODEX_SERVICE_TIER = 'priority'

export function resolveCodexReasoningEffort(effort: EffortPreference | undefined): CodexReasoningEffort {
  if (effort === 'ultracode') return 'ultra'
  if (effort === 'max') return 'max'
  if (effort === 'xhigh') return 'xhigh'
  return 'high'
}

export function effortLabel(effort: EffortPreference): string {
  switch (effort) {
    case 'xhigh': return 'Extra High'
    case 'max': return 'Max'
    case 'ultracode': return 'Ultracode'
    case 'high':
    default:
      return 'High'
  }
}

export function isModelPreference(value: unknown): value is ModelPreference {
  return typeof value === 'string' && MODEL_SET.has(value as ModelPreference)
}

export function normalizeModelPreference(value: unknown): ModelPreference | undefined {
  // Existing installs persist codex-high. Migrate it to the live frontier slot.
  if (value === 'codex-high') return CODEX_FRONTIER_MODEL
  return isModelPreference(value) ? value : undefined
}

export function isClaudeModel(model: ModelPreference): model is ClaudeModelPreference {
  return model === 'opus' || model === 'fable' || model === 'sonnet' || model === 'haiku'
}

export function isCodexModel(model: ModelPreference): model is CodexModelPreference {
  return model === CODEX_FRONTIER_MODEL || model === CODEX_BALANCED_MODEL
}

export interface RuntimeCodexModelLabel {
  preference: CodexModelPreference
  displayName: string
}

const runtimeCodexLabels: Partial<Record<CodexModelPreference, string>> = {}

export function setRuntimeCodexModelLabels(options: RuntimeCodexModelLabel[]): void {
  for (const option of options) {
    if (!isCodexModel(option.preference)) continue
    const label = typeof option.displayName === 'string' ? option.displayName.trim() : ''
    if (label) runtimeCodexLabels[option.preference] = label
  }
}

export function resetRuntimeCodexModelLabels(): void {
  delete runtimeCodexLabels[CODEX_FRONTIER_MODEL]
  delete runtimeCodexLabels[CODEX_BALANCED_MODEL]
}

export function modelLabel(model: ModelPreference): string {
  switch (model) {
    case 'fable': return 'Fable'
    case 'sonnet': return 'Sonnet'
    case 'haiku': return 'Haiku'
    case 'codex-frontier': return runtimeCodexLabels[model] ?? 'GPT Frontier'
    case 'codex-balanced': return runtimeCodexLabels[model] ?? 'GPT Balanced'
    case 'opus':
    default:
      return 'Opus'
  }
}

export function modelShortLabel(model: ModelPreference): string {
  switch (model) {
    case 'fable': return 'Fable'
    case 'sonnet': return 'Sonnet'
    case 'haiku': return 'Haiku'
    case 'codex-frontier': return 'GPT Max'
    case 'codex-balanced': return 'GPT Bal'
    case 'opus':
    default:
      return 'Opus'
  }
}

export function modelButtonLabel(model: ModelPreference): string {
  switch (model) {
    case 'fable': return 'FABLE'
    case 'sonnet': return 'SNNT'
    case 'haiku': return 'HAIKU'
    case 'codex-frontier': return 'GPT MAX'
    case 'codex-balanced': return 'GPT BAL'
    case 'opus':
    default:
      return 'OPUS'
  }
}

export function modelTag(model: ModelPreference): string {
  switch (model) {
    case 'fable': return 'F'
    case 'sonnet': return 'S'
    case 'haiku': return 'H'
    case 'codex-frontier': return 'GF'
    case 'codex-balanced': return 'GB'
    case 'opus':
    default:
      return 'O'
  }
}

export function modelBracketTag(model: ModelPreference): string {
  return ` [${modelTag(model)}]`
}
