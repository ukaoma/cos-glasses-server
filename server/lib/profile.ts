// Profile loader — reads user identity from .cos-profile.json (gitignored)
// Falls back to generic defaults for users who haven't configured a profile

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'

const APP_ROOT = resolve(import.meta.dirname, '../..')

const PLACEHOLDER_OWNER_NAMES = new Set(['your name', 'user'])
const PLACEHOLDER_VOCABULARY = new Set(['nameone', 'nametwo', 'yourcompany', 'productname'])
const PLACEHOLDER_CORRECTIONS = new Set(['soundalike\u0000yourname'])

/** The profile in the data home. Survives updates; the APP_ROOT copy does not. */
export function homeProfilePath(): string {
  return resolve(homedir(), '.cos-glasses', '.cos-profile.json')
}

// Single canonical path — used by BOTH the reader and the writer so a glossary
// PUT can never write to a different file than the cache reads from. Lazy +
// env-overridable (COS_PROFILE_PATH) so tests can target a temp file.
//
// APP_ROOT is the INSTALLED PACKAGE root. For a managed install that is inside
// the generation directory, which an update replaces wholesale — so a profile
// there is destroyed on every upgrade, and a fresh managed install has no
// profile at all (loadProfile() catches to {} and every field silently takes
// its default). Relying on COS_PROFILE_PATH alone is not enough either: the
// launcher rebuilds its environment from the release manifest rather than the
// existing plist, so an operator-set value is dropped by the next
// install/update/repair. Prefer the data home whenever a profile lives there.
//
// Order: explicit override → ~/.cos-glasses/.cos-profile.json → package root.
function profilePath(): string {
  const override = process.env.COS_PROFILE_PATH?.trim()
  if (override) return resolve(override)
  const home = homeProfilePath()
  if (existsSync(home)) return home
  return resolve(APP_ROOT, '.cos-profile.json')
}

let profileCache: Record<string, unknown> | null = null

function loadProfile(): Record<string, unknown> {
  if (profileCache) return profileCache
  try {
    profileCache = JSON.parse(readFileSync(profilePath(), 'utf-8'))
    return profileCache!
  } catch {
    profileCache = {}
    return profileCache
  }
}

/** Null the in-memory profile cache so the next read reloads from disk.
 *  Call after any write to .cos-profile.json (e.g. the glossary PUT). This is
 *  the ROOT cache every getter reads through — busting it is necessary but NOT
 *  sufficient: the decoder snapshots in whisper-local.ts (resetDecoderCaches)
 *  must be cleared too. */
export function clearProfileCache(): void {
  profileCache = null
}

/** Read-modify-write merge of top-level fields into .cos-profile.json.
 *  Reads the CURRENT file fresh (not the cache) so untouched keys
 *  (domain_keywords, system_prompt_context, owner_name, ...) are preserved,
 *  writes atomically, then busts the cache. Returns the merged profile. */
export function updateProfileFields(patch: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = {}
  try {
    current = JSON.parse(readFileSync(profilePath(), 'utf-8')) as Record<string, unknown>
  } catch {
    current = {} // missing/corrupt — start fresh; merge still proceeds
  }
  const merged = { ...current, ...patch }
  atomicWriteFileSync(profilePath(), JSON.stringify(merged, null, 2))
  clearProfileCache()
  return merged
}

export function loadProfileField(field: string, fallback: string): string {
  const profile = loadProfile()
  const value = profile[field]
  return typeof value === 'string' ? value : fallback
}

export function getOwnerName(): string {
  const value = loadProfileField('owner_name', 'User').trim()
  return !value || PLACEHOLDER_OWNER_NAMES.has(value.toLowerCase()) ? 'User' : value
}

/** Short speaker label for the glasses wearer, used by diarization to fast-path
 *  the owner's voiceprint. Defaults to 'Me'. Configure via owner_speaker_label. */
export function getOwnerSpeakerLabel(): string {
  return loadProfileField('owner_speaker_label', 'Me')
}

export function getVocabulary(): string[] {
  const profile = loadProfile()
  if (!Array.isArray(profile.vocabulary)) return []
  const seen = new Set<string>()
  return (profile.vocabulary as unknown[]).flatMap(value => {
    if (typeof value !== 'string') return []
    const term = value.trim()
    const key = term.toLowerCase()
    if (!term || PLACEHOLDER_VOCABULARY.has(key) || seen.has(key)) return []
    seen.add(key)
    return [term]
  })
}

/** Typed correction map shared by every decoder caller. The legacy profile
 * stores this field as a JSON string, while hand-authored profiles sometimes
 * use an object; accept both and ignore the factory example pair. */
export function getWhisperCorrections(): Record<string, string> {
  const raw = loadProfile().whisper_corrections
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { return {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const corrections: Record<string, string> = {}
  for (const [sourceRaw, targetRaw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof targetRaw !== 'string') continue
    const source = sourceRaw.trim()
    const target = targetRaw.trim()
    if (!source || !target) continue
    if (PLACEHOLDER_CORRECTIONS.has(`${source.toLowerCase()}\u0000${target.toLowerCase()}`)) continue
    corrections[source] = target
  }
  return corrections
}

export interface TranscriptionProfileStatus {
  configured: boolean
  ownerConfigured: boolean
  vocabularyTerms: number
  ignoredPlaceholderTerms: number
  ignoredPlaceholderCorrection: boolean
}

/** Path-free setup truth for startup warnings, health, and COS Control. */
export function getTranscriptionProfileStatus(): TranscriptionProfileStatus {
  const profile = loadProfile()
  const rawOwner = typeof profile.owner_name === 'string' ? profile.owner_name.trim() : ''
  const rawVocabulary = Array.isArray(profile.vocabulary)
    ? (profile.vocabulary as unknown[]).filter((value): value is string => typeof value === 'string')
    : []
  const ignoredPlaceholderTerms = rawVocabulary.filter(term => PLACEHOLDER_VOCABULARY.has(term.trim().toLowerCase())).length
  const rawCorrections = (() => {
    const value = profile.whisper_corrections
    if (typeof value === 'string') {
      try { return JSON.parse(value) as unknown } catch { return null }
    }
    return value
  })()
  const ignoredPlaceholderCorrection = Boolean(
    rawCorrections
      && typeof rawCorrections === 'object'
      && !Array.isArray(rawCorrections)
      && Object.entries(rawCorrections as Record<string, unknown>).some(([source, target]) =>
        typeof target === 'string'
        && PLACEHOLDER_CORRECTIONS.has(`${source.trim().toLowerCase()}\u0000${target.trim().toLowerCase()}`)),
  )
  const ownerConfigured = Boolean(rawOwner) && !PLACEHOLDER_OWNER_NAMES.has(rawOwner.toLowerCase())
  const vocabularyTerms = getVocabulary().length
  return {
    configured: ownerConfigured || vocabularyTerms > 0 || Object.keys(getWhisperCorrections()).length > 0,
    ownerConfigured,
    vocabularyTerms,
    ignoredPlaceholderTerms,
    ignoredPlaceholderCorrection,
  }
}

export function getSystemContext(): string {
  return loadProfileField('system_prompt_context', '')
}

export function getDomainKeywords(): Record<string, string[]> {
  const profile = loadProfile()
  const dk = profile.domain_keywords
  return (dk && typeof dk === 'object') ? dk as Record<string, string[]> : {}
}

/** Editable negative/cleanup rules (whole:/strip:/replace:/flag:) authored via
 *  the glossary PUT. Parsed + applied by hallucination-filter.ts. Returns the
 *  raw rule lines; non-string entries are dropped defensively. */
export function getNegativeRules(): string[] {
  const profile = loadProfile()
  return Array.isArray(profile.negative_rules)
    ? (profile.negative_rules as unknown[]).filter((r): r is string => typeof r === 'string')
    : []
}
