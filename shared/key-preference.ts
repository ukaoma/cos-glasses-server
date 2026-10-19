// Key lanes (K1, plan v4 section 5.1): the ONE parser that may read a key profile out of a model
// preference. `isModelPreference` and `normalizeModelPreference` (model-preference.ts) stay
// closed and unchanged, so every site that does not call parsePreference keeps refusing a
// profile exactly as 6.79.0 does. Call this only at the sites plan 5.2 marks Accept.
//
// Encoding: a profile-bound preference is `profile:<id>`. The prefix keeps a profile id from ever
// colliding with a model slot name (`opus` is a valid id shape). On `/v1` a profile is offered as
// `cos-key-<id>` (plan 9.4), handled before `resolveModel` and only for profiles that opt in.
import { normalizeModelPreference, type ModelPreference } from './model-preference.js'

export const KEY_PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const KEY_PROFILE_PREFERENCE_PREFIX = 'profile:'
export const V1_KEY_MODEL_PREFIX = 'cos-key-'

export type ParsedPreference =
  | { kind: 'model'; value: ModelPreference }
  | { kind: 'profile'; id: string }

export function isKeyProfileId(value: unknown): value is string {
  return typeof value === 'string' && KEY_PROFILE_ID_RE.test(value)
}

/** `profile:<id>`, or throws on a malformed id (a caller bug, never user input). */
export function profilePreference(id: string): string {
  if (!isKeyProfileId(id)) throw new Error('invalid key profile id')
  return KEY_PROFILE_PREFERENCE_PREFIX + id
}

/**
 * A model slot (normalized exactly as normalizeModelPreference does, so `codex-high` still
 * migrates), a `profile:<id>`, or undefined for anything else. Never throws.
 */
export function parsePreference(value: unknown): ParsedPreference | undefined {
  const model = normalizeModelPreference(value)
  if (model) return { kind: 'model', value: model }
  if (typeof value !== 'string' || !value.startsWith(KEY_PROFILE_PREFERENCE_PREFIX)) return undefined
  const id = value.slice(KEY_PROFILE_PREFERENCE_PREFIX.length)
  return isKeyProfileId(id) ? { kind: 'profile', id } : undefined
}

/** True only for a well-formed `profile:<id>`. A model slot is false. */
export function isProfilePreference(value: unknown): boolean {
  return parsePreference(value)?.kind === 'profile'
}

/** `/v1` model name for a profile (plan 9.4). */
export function v1KeyModelName(id: string): string {
  if (!isKeyProfileId(id)) throw new Error('invalid key profile id')
  return V1_KEY_MODEL_PREFIX + id
}

/** The profile id in a `cos-key-<id>` `/v1` model name, or undefined. */
export function parseV1KeyModelName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(V1_KEY_MODEL_PREFIX)) return undefined
  const id = value.slice(V1_KEY_MODEL_PREFIX.length)
  return isKeyProfileId(id) ? id : undefined
}
