/** Public choices. Haiku remains accepted only for older clients. */
export const DICTATION_CLEAN_MODELS = ['sonnet', 'luna-5.6-fast'] as const
export type DictationCleanModel = typeof DICTATION_CLEAN_MODELS[number] | 'haiku'
export const LUNA_DICTATION_CLI_MODEL = 'gpt-5.6-luna-none-fast'
export function isDictationCleanModel(value: unknown): value is DictationCleanModel {
  return value === 'sonnet' || value === 'luna-5.6-fast' || value === 'haiku'
}
