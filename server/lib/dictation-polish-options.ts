import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

/**
 * 6.91.0: "Previous polish", the one polish option COS Control can set (plan r2). The person can
 * go back to the 6.90.0 prompt (v3) from Control's own Settings, with no terminal and no restart,
 * and G2 follows because the option lives on the server.
 *
 * - `promptVersion: "default"` (prompt v4, the default) or `"v3"`.
 * - The environment wins when it names a version (COS_DICTATION_POLISH_PROMPT, or the
 *   COS_DICTATION_PROMPT_VERSION alias): dictation-clean.ts dictationPolishPromptVersion.
 * - Stored atomically in the data dir, mode 0600; "default" deletes the file. A missing or
 *   malformed file reads as "default".
 */
export const POLISH_OPTIONS_PROTOCOL = 1
export const POLISH_OPTIONS_FILE = 'dictation-polish-options.json'
export const POLISH_PROMPT_OPTIONS = ['default', 'v3'] as const
export type PolishPromptOption = typeof POLISH_PROMPT_OPTIONS[number]

export interface PolishOptions { promptVersion: PolishPromptOption; updatedAt: string | null }

const filePath = () => dataPath(POLISH_OPTIONS_FILE)
let cache: { mtimeMs: number; size: number; value: PolishOptions } | null = null

export function readPolishOptions(): PolishOptions {
  const off: PolishOptions = { promptVersion: 'default', updatedAt: null }
  let stat: { mtimeMs: number; size: number }
  try { const s = statSync(filePath()); stat = { mtimeMs: s.mtimeMs, size: s.size } } catch { cache = null; return off }
  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return { ...cache.value }
  let value = off
  try {
    const parsed = JSON.parse(readFileSync(filePath(), 'utf8'))
    if ((POLISH_PROMPT_OPTIONS as readonly string[]).includes(parsed?.promptVersion)) {
      value = { promptVersion: parsed.promptVersion, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null }
    }
  } catch { /* malformed reads as default */ }
  cache = { ...stat, value }
  return { ...value }
}

export function writePolishOptions(promptVersion: PolishPromptOption, now: Date = new Date()): PolishOptions {
  cache = null
  if (promptVersion === 'default') {
    try { unlinkSync(filePath()) } catch (err: any) { if (err?.code !== 'ENOENT') throw err }
    return { promptVersion, updatedAt: null }
  }
  const stored: PolishOptions = { promptVersion, updatedAt: now.toISOString() }
  atomicWriteFileSync(filePath(), JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 })
  return stored
}

export function __resetPolishOptionsCacheForTests(): void { cache = null }

export type DictationPolishPromptVersion = 'v1' | 'v2' | 'v3' | 'v4'
/** The newest prompt, the default on the models in V4_DEFAULT_MODELS. */
export const DEFAULT_DICTATION_POLISH_PROMPT: DictationPolishPromptVersion = 'v4'
export const DICTATION_POLISH_PROMPT_VERSIONS: readonly DictationPolishPromptVersion[] = ['v1', 'v2', 'v3', 'v4']
export type PromptVersionSource = 'env' | 'option' | 'default'

/**
 * 6.91.0 (canary C1): prompt v4 passed on Sonnet and failed on Haiku (CHANGELOG), so it is the
 * default on Sonnet only. Haiku, Luna and any other or unnamed model keep v3, byte for byte the
 * 6.90.0 prompt. The environment and the "Previous polish" option still override every model.
 */
export const V4_DEFAULT_MODELS: readonly string[] = ['sonnet']
export const POLISH_MODEL_DEFAULTS = ['haiku', 'sonnet', 'luna-5.6-fast'] as const

export function defaultPromptFor(model: string | undefined): DictationPolishPromptVersion {
  return model !== undefined && V4_DEFAULT_MODELS.includes(model) ? DEFAULT_DICTATION_POLISH_PROMPT : 'v3'
}

/**
 * Which prompt runs, and why: COS_DICTATION_POLISH_PROMPT (v1 to v4) when it names one, else the
 * alias COS_DICTATION_PROMPT_VERSION (3 or v3), else this file's option ("v3"), else the model's
 * default (v4 on Sonnet, v3 otherwise). With no model named, the newest default (v4) is reported.
 */
export function dictationPolishPromptChoice(env: NodeJS.ProcessEnv = process.env, model?: string): { version: DictationPolishPromptVersion; source: PromptVersionSource } {
  const raw = (env.COS_DICTATION_POLISH_PROMPT ?? '').trim().toLowerCase()
  if ((DICTATION_POLISH_PROMPT_VERSIONS as readonly string[]).includes(raw)) return { version: raw as DictationPolishPromptVersion, source: 'env' }
  const alias = (env.COS_DICTATION_PROMPT_VERSION ?? '').trim().toLowerCase().replace(/^(\d)$/, 'v$1')
  if ((DICTATION_POLISH_PROMPT_VERSIONS as readonly string[]).includes(alias)) return { version: alias as DictationPolishPromptVersion, source: 'env' }
  if (readPolishOptions().promptVersion === 'v3') return { version: 'v3', source: 'option' }
  return { version: model === undefined ? DEFAULT_DICTATION_POLISH_PROMPT : defaultPromptFor(model), source: 'default' }
}

export function dictationPolishPromptVersion(env: NodeJS.ProcessEnv = process.env, model?: string): DictationPolishPromptVersion {
  return dictationPolishPromptChoice(env, model).version
}

/**
 * 6.91.0: the model and prompt pairs the learned style and the literal register were canaried on
 * (C2 and C3 ran on Sonnet with v4 only). Any other pair gets neither: no learned style, no
 * register block, no literal check, and no `polishRegister` in the answer.
 */
export function styleAndRegisterApply(model: string | undefined, version: DictationPolishPromptVersion): boolean {
  return model === 'sonnet' && version === 'v4'
}
