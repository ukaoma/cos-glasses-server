/** Public polish choices. Haiku is the cost-first default. */
export const DICTATION_CLEAN_MODELS = ['haiku', 'sonnet', 'luna-5.6-fast'] as const
export type DictationCleanModel = typeof DICTATION_CLEAN_MODELS[number]
export const LUNA_DICTATION_CLI_MODEL = 'gpt-5.6-luna-none-fast'
/** The polish choice that runs through Cursor, whose path has no system prompt. */
export const LUNA_DICTATION_MODEL = 'luna-5.6-fast'
export function isDictationCleanModel(value: unknown): value is DictationCleanModel {
  return value === 'sonnet' || value === 'luna-5.6-fast' || value === 'haiku'
}
