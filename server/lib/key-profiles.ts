// Key lanes (K1, plan v4 sections 3.1, 4.4, 5, 12): saved key profiles, `data/provider-profiles.json`.
//
// A profile binds one saved key to one engine and one model. No secret lives here, only the key's
// ref. `keyLanesActive()` is true only while this file parses with at least one enabled profile.
// Reading never creates: a missing or corrupt file is "no profiles" and is left untouched.
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { isKeyProfileId } from '../../shared/key-preference.js'
import { dataPath } from './data-dir.js'
import type { KeyKind, KeyProfile, KeyProfileEngine, KeyProfileTimeoutTier } from './key-relay-contract.js'
import { KEY_REF_RE } from './key-relay-contract.js'
import { readPrivateJsonFile, writePrivateJsonFile } from './key-store.js'

export const KEY_PROFILES_FILE = 'provider-profiles.json'
export const KEY_PROFILE_ENGINES: readonly KeyProfileEngine[] = ['claude', 'codex', 'direct']
export const KEY_PROFILE_TIMEOUT_TIERS: readonly KeyProfileTimeoutTier[] = ['opus', 'fable', 'sonnet', 'haiku']
export const MAX_KEY_PROFILES = 20
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const LABEL_MAX = 40

interface ProfilesFile {
  v: 1
  profiles: KeyProfile[]
}

export function keyProfilesPath(): string {
  return dataPath(KEY_PROFILES_FILE)
}

function isProfile(v: unknown): v is KeyProfile {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<KeyProfile>
  return isKeyProfileId(p.id)
    && typeof p.label === 'string'
    && typeof p.keyRef === 'string' && KEY_REF_RE.test(p.keyRef)
    && typeof p.engine === 'string' && (KEY_PROFILE_ENGINES as readonly string[]).includes(p.engine)
    && typeof p.model === 'string' && MODEL_ID_RE.test(p.model)
    && typeof p.enabled === 'boolean'
    && typeof p.timeoutTier === 'string' && (KEY_PROFILE_TIMEOUT_TIERS as readonly string[]).includes(p.timeoutTier)
}

let cache: { stamp: string; profiles: KeyProfile[] } | null = null

export function listProfiles(): KeyProfile[] {
  const file = keyProfilesPath()
  let stamp: string
  try {
    const st = statSync(file)
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    cache = null
    return []
  }
  if (cache?.stamp === stamp) return cache.profiles
  const parsed = readPrivateJsonFile(file) as Partial<ProfilesFile> | undefined
  const profiles = parsed && Array.isArray(parsed.profiles)
    ? parsed.profiles.filter(isProfile).map(p => ({ ...p, offerOnV1: p.offerOnV1 === true, directTools: p.directTools === true }))
    : []
  cache = { stamp, profiles }
  return profiles
}

export function enabledProfileCount(): number {
  return listProfiles().filter(p => p.enabled).length
}

export function getProfile(id: string): KeyProfile | undefined {
  return listProfiles().find(p => p.id === id)
}

function writeProfiles(profiles: KeyProfile[]): void {
  const body: ProfilesFile = { v: 1, profiles }
  writePrivateJsonFile(keyProfilesPath(), body)
  cache = null
}

export interface ProfileInput {
  id?: unknown
  label?: unknown
  keyRef?: unknown
  engine?: unknown
  model?: unknown
  enabled?: unknown
  timeoutTier?: unknown
  offerOnV1?: unknown
  directTools?: unknown
}

/**
 * Plan 4.4 model policy at save time: Lane B Claude takes OpenRouter `anthropic/*` slugs or an
 * Anthropic key's own `claude-*` ids; Lane B Codex takes `openai/*` slugs or an OpenAI key's ids;
 * anything else is Lane C (direct) only, which cannot run on an Anthropic key.
 */
export function engineModelProblem(engine: KeyProfileEngine, model: string, keyKind: KeyKind): string | null {
  if (engine === 'claude') {
    if (keyKind === 'openrouter' && model.startsWith('anthropic/')) return null
    if (keyKind === 'anthropic' && model.startsWith('claude-')) return null
    return 'Claude profiles take an anthropic/ model on OpenRouter or a claude- model on an Anthropic key.'
  }
  if (engine === 'codex') {
    if (keyKind === 'openrouter' && model.startsWith('openai/')) return null
    if (keyKind === 'openai' && !model.includes('/')) return null
    return 'Codex profiles take an openai/ model on OpenRouter or a model on an OpenAI key.'
  }
  if (keyKind === 'anthropic') return 'Direct profiles need an OpenRouter, OpenAI or custom key.'
  return null
}

export type ProfileValidation = { ok: true; profile: KeyProfile } | { ok: false; error: string; message: string }

/** Validate an upsert against the saved keys. `keyKindOf` returns undefined for an unknown ref. */
export function validateProfileInput(
  input: ProfileInput,
  keyKindOf: (ref: string) => KeyKind | undefined,
  now: () => Date = () => new Date(),
): ProfileValidation {
  const bad = (message: string): ProfileValidation => ({ ok: false, error: 'invalid_profile', message })
  if (!isKeyProfileId(input.id)) return bad('Profile id is 1 to 32 lowercase letters, digits or dashes.')
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(input.label)) {
    return bad(`Give the profile a name of up to ${LABEL_MAX} characters.`)
  }
  if (typeof input.keyRef !== 'string' || !KEY_REF_RE.test(input.keyRef)) return bad('Pick a saved key.')
  const keyKind = keyKindOf(input.keyRef)
  if (!keyKind) return { ok: false, error: 'unknown_key', message: 'That key is not saved on this Mac.' }
  if (typeof input.engine !== 'string' || !(KEY_PROFILE_ENGINES as readonly string[]).includes(input.engine)) return bad('Pick Claude, Codex or Direct.')
  if (typeof input.model !== 'string' || !MODEL_ID_RE.test(input.model)) return bad('Pick a model.')
  const engine = input.engine as KeyProfileEngine
  const modelProblem = engineModelProblem(engine, input.model, keyKind)
  if (modelProblem) return { ok: false, error: 'model_not_allowed', message: modelProblem }
  const tier = input.timeoutTier === undefined ? 'sonnet' : input.timeoutTier
  if (typeof tier !== 'string' || !(KEY_PROFILE_TIMEOUT_TIERS as readonly string[]).includes(tier)) return bad('Unknown timeout tier.')
  for (const [name, v] of [['enabled', input.enabled], ['offerOnV1', input.offerOnV1], ['directTools', input.directTools]] as const) {
    if (v !== undefined && typeof v !== 'boolean') return bad(`${name} is true or false.`)
  }
  const at = now().toISOString()
  const prior = getProfile(input.id)
  return {
    ok: true,
    profile: {
      id: input.id,
      label: input.label.trim(),
      keyRef: input.keyRef,
      engine,
      model: input.model,
      enabled: input.enabled === undefined ? true : input.enabled === true,
      timeoutTier: tier as KeyProfileTimeoutTier,
      offerOnV1: input.offerOnV1 === true,
      // D7: tools stay off unless the caller turns them on for this profile.
      directTools: input.directTools === true,
      createdAt: prior?.createdAt ?? at,
      updatedAt: at,
    },
  }
}

/** Insert or replace by id. Refuses past MAX_KEY_PROFILES. */
export function upsertProfile(profile: KeyProfile): { ok: true } | { ok: false; error: 'too_many_profiles' } {
  const profiles = [...listProfiles()]
  const i = profiles.findIndex(p => p.id === profile.id)
  if (i < 0 && profiles.length >= MAX_KEY_PROFILES) return { ok: false, error: 'too_many_profiles' }
  if (i >= 0) profiles[i] = profile
  else profiles.push(profile)
  writeProfiles(profiles)
  return { ok: true }
}

/** True when a profile was removed. */
export function deleteProfile(id: string): boolean {
  const profiles = listProfiles()
  const next = profiles.filter(p => p.id !== id)
  if (next.length === profiles.length) return false
  writeProfiles(next)
  return true
}

/** Remove all keys (plan 12). True when a file was deleted. */
export function deleteProfilesFile(): boolean {
  cache = null
  const file = keyProfilesPath()
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}
