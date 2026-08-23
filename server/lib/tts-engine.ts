// Local TTS engine mode + OpenAI voice → Kokoro preset map.
// Default product mode: local_first (Kokoro). OpenAI is opt-in escape hatch.
// Modes: openai | openai_primary | local_first | local
// Bare "auto" → local_first.
// Per-request engine: 'local' | 'openai' forces that backend (Settings picker).

export type TtsEngineMode = 'openai' | 'openai_primary' | 'local_first' | 'local'
export type TtsBackend = 'openai' | 'local'
export type TtsEnginePreference = 'local' | 'openai'

/** Cache/engine tag written into hashKey — distinguishes OpenAI audio from Kokoro. */
export type TtsEngineTag = 'openai' | 'kokoro'

export const OPENAI_VOICE_OPTIONS = [
  { id: 'echo', label: 'Echo (default)' },
  { id: 'alloy', label: 'Alloy' },
  { id: 'nova', label: 'Nova' },
  { id: 'sage', label: 'Sage' },
  { id: 'onyx', label: 'Onyx' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'fable', label: 'Fable' },
  { id: 'ash', label: 'Ash' },
  { id: 'coral', label: 'Coral' },
] as const

/** American English Kokoro presets verified on disk (mlx-community/Kokoro-82M-bf16). */
export const KOKORO_VOICE_OPTIONS = [
  { id: 'am_echo', label: 'Echo (am_echo) · default' },
  { id: 'am_michael', label: 'Michael (am_michael)' },
  { id: 'am_fenrir', label: 'Fenrir (am_fenrir)' },
  { id: 'am_puck', label: 'Puck (am_puck)' },
  { id: 'am_onyx', label: 'Onyx (am_onyx)' },
  { id: 'am_eric', label: 'Eric (am_eric)' },
  { id: 'am_liam', label: 'Liam (am_liam)' },
  { id: 'am_adam', label: 'Adam (am_adam)' },
  { id: 'am_santa', label: 'Santa (am_santa)' },
  { id: 'af_heart', label: 'Heart (af_heart)' },
  { id: 'af_bella', label: 'Bella (af_bella)' },
  { id: 'af_nova', label: 'Nova (af_nova)' },
  { id: 'af_sarah', label: 'Sarah (af_sarah)' },
  { id: 'af_sky', label: 'Sky (af_sky)' },
  { id: 'af_nicole', label: 'Nicole (af_nicole)' },
  { id: 'af_jessica', label: 'Jessica (af_jessica)' },
  { id: 'af_alloy', label: 'Alloy (af_alloy)' },
  { id: 'af_aoede', label: 'Aoede (af_aoede)' },
  { id: 'af_kore', label: 'Kore (af_kore)' },
  { id: 'af_river', label: 'River (af_river)' },
] as const

/** British English presets, verified on disk in the same voice pack.
 *
 *  Kept a SEPARATE list rather than folded into the American one: the picker
 *  groups by accent, and a caller that wants "the default set" should not silently
 *  get a British voice. All 54 packaged voices were considered; only these 8 are
 *  added, because the sidecar phonemises with `lang_code="a"` and the remaining 26
 *  (Mandarin, Japanese, Hindi, Spanish, Portuguese, Italian, French) would be read
 *  through an American English grapheme-to-phoneme pass. That produces an accent
 *  artefact, not the language. Exposing them needs a lang_code map and text in the
 *  matching language -- deliberately out of scope, not overlooked. */
export const KOKORO_EN_GB_VOICE_OPTIONS = [
  { id: 'bm_george', label: 'George (bm_george) · British' },
  { id: 'bm_daniel', label: 'Daniel (bm_daniel) · British' },
  { id: 'bm_lewis', label: 'Lewis (bm_lewis) · British' },
  { id: 'bm_fable', label: 'Fable (bm_fable) · British' },
  { id: 'bf_emma', label: 'Emma (bf_emma) · British' },
  { id: 'bf_alice', label: 'Alice (bf_alice) · British' },
  { id: 'bf_isabella', label: 'Isabella (bf_isabella) · British' },
  { id: 'bf_lily', label: 'Lily (bf_lily) · British' },
] as const

export const KOKORO_EN_GB_VOICES = KOKORO_EN_GB_VOICE_OPTIONS.map((v) => v.id)

export const KOKORO_EN_US_VOICES = KOKORO_VOICE_OPTIONS.map((v) => v.id)

// OpenAI id → Kokoro when Settings still sends an OpenAI id on the local path.
const VOICE_MAP: Record<string, string> = {
  echo: 'am_echo',
  alloy: 'af_heart',
  fable: 'af_bella',
  onyx: 'am_onyx',
  nova: 'af_nova',
  shimmer: 'af_sky',
  ash: 'am_fenrir',
  sage: 'af_sarah',
  coral: 'af_jessica',
}

const OPENAI_VOICE_IDS = new Set(OPENAI_VOICE_OPTIONS.map((v) => v.id))
// BOTH accents, and this Set is now what `isKokoroVoiceId` actually checks.
// Omitting either list here would make the picker offer voices the server then
// refuses -- the UI and the server disagreeing in silence.
const KOKORO_VOICE_IDS = new Set<string>([...KOKORO_EN_US_VOICES, ...KOKORO_EN_GB_VOICES])

export function isOpenAIVoiceId(voice: string): boolean {
  return OPENAI_VOICE_IDS.has(voice as typeof OPENAI_VOICE_OPTIONS[number]['id'])
}

/**
 * Is this a Kokoro voice COS actually offers?
 *
 * THE CATALOG, not the shape. This was `/^[a-z]{2}_[a-z0-9]+$/i`, which accepts
 * any id of the right form -- including the 26 non-English voices in the same
 * pack, and including ids for no voice at all. Neither is refused anywhere
 * downstream: the sidecar's `synthesize` falls back through
 * requested -> COS_TTS_KOKORO_VOICE -> am_echo and returns audio, so an
 * unrecognised voice produced a DIFFERENT voice with no error. The caller asked
 * for one thing, got another, and nothing said so.
 *
 * `KOKORO_VOICE_IDS` existed for this and was never read.
 */
export function isKokoroVoiceId(voice: string): boolean {
  return KOKORO_VOICE_IDS.has(voice)
}

export function getTtsEngineMode(): TtsEngineMode {
  const raw = (process.env.COS_TTS_ENGINE || 'local_first').trim().toLowerCase()
  if (raw === 'auto') return 'local_first'
  if (raw === 'openai' || raw === 'openai_primary' || raw === 'local_first' || raw === 'local') {
    return raw
  }
  console.warn(`[tts-engine] unknown COS_TTS_ENGINE=${raw}; using local_first`)
  return 'local_first'
}

/** Resolve which Kokoro preset to synthesize for a local request. */
export function resolveLocalVoice(requested: string): string {
  const v = (requested || '').trim()
  if (v && isKokoroVoiceId(v)) {
    const lower = v.toLowerCase()
    // Accept any on-disk-shaped id; known list is the Settings catalog.
    return lower
  }
  // Env pin only when mapping legacy OpenAI ids (not when client sent Kokoro).
  const pinned = (process.env.COS_TTS_KOKORO_VOICE || '').trim()
  if (pinned && isKokoroVoiceId(pinned)) return pinned.toLowerCase()
  return VOICE_MAP[v] ?? VOICE_MAP.echo
}

/** @deprecated use resolveLocalVoice — kept for tests / call sites. */
export function mapOpenAIVoiceToLocal(openaiVoice: string): string {
  return resolveLocalVoice(openaiVoice)
}

export function localEngineTag(): TtsEngineTag {
  const pinned = (process.env.COS_TTS_LOCAL_ENGINE || 'kokoro').trim().toLowerCase()
  return pinned === 'kokoro' ? 'kokoro' : 'kokoro'
}

export interface TtsRouteDecision {
  backend: TtsBackend
  engineTag: TtsEngineTag
  /** Voice id sent to the chosen backend. */
  backendVoice: string
  /** Voice id from the client (OpenAI or Kokoro). */
  openaiVoice: string
}

/**
 * Pick initial backend for a request.
 *
 * enginePreference:
 *   - 'openai' → cloud (Settings “OpenAI”)
 *   - 'local' → Kokoro (Settings “Local”)
 *   - omitted → daemon COS_TTS_ENGINE (local_first default)
 */
export function decideInitialBackend(opts: {
  openaiVoice: string
  openaiKeyPresent: boolean
  openaiBudgetOk: boolean
  localReady: boolean
  preferOpenAI?: boolean
  enginePreference?: TtsEnginePreference | null
}): TtsRouteDecision {
  const requested = opts.openaiVoice
  const localVoice = resolveLocalVoice(requested)
  const openaiVoice = isOpenAIVoiceId(requested) ? requested : 'echo'
  const local: TtsRouteDecision = {
    backend: 'local',
    engineTag: localEngineTag(),
    backendVoice: localVoice,
    openaiVoice: requested,
  }
  const openai: TtsRouteDecision = {
    backend: 'openai',
    engineTag: 'openai',
    backendVoice: openaiVoice,
    openaiVoice: requested,
  }

  const preferOpenAI =
    opts.preferOpenAI === true || opts.enginePreference === 'openai'
  const forceLocal = opts.enginePreference === 'local'

  if (forceLocal) {
    if (!opts.localReady) {
      throw new Error('Local TTS selected but Kokoro sidecar is not ready')
    }
    return local
  }

  if (preferOpenAI) {
    if (opts.openaiKeyPresent && opts.openaiBudgetOk) return openai
    if (opts.localReady) {
      console.warn('[tts-engine] OpenAI requested but unavailable; using local')
      return local
    }
    throw new Error('OpenAI TTS requested but key/budget unavailable and local TTS not ready')
  }

  // Legacy: bare Kokoro voice id implies local even without enginePreference.
  if (isKokoroVoiceId(requested) && opts.localReady) return local

  const mode = getTtsEngineMode()

  if (mode === 'openai') {
    if (!opts.openaiKeyPresent) {
      throw new Error('COS_TTS_ENGINE=openai but OPENAI_API_KEY is missing')
    }
    if (!opts.openaiBudgetOk) {
      throw new Error('COS_TTS_ENGINE=openai but daily OpenAI TTS budget is exhausted')
    }
    return openai
  }

  if (mode === 'local') {
    if (!opts.localReady) {
      throw new Error('COS_TTS_ENGINE=local but local TTS sidecar is not ready')
    }
    return local
  }

  if (mode === 'local_first') {
    if (opts.localReady) return local
    if (opts.openaiKeyPresent && opts.openaiBudgetOk) return openai
    throw new Error('local TTS unavailable and OpenAI key/budget not usable')
  }

  // openai_primary
  if (opts.openaiKeyPresent && opts.openaiBudgetOk) return openai
  if (opts.localReady) return local
  if (!opts.openaiKeyPresent) {
    throw new Error('OpenAI TTS key missing and local TTS sidecar is not ready')
  }
  throw new Error('OpenAI TTS budget exhausted and local TTS sidecar is not ready')
}

/** After an OpenAI failure, can we fall back to local under this mode? */
export function canFallbackToLocal(
  mode: TtsEngineMode,
  localReady: boolean,
  preferOpenAI = false,
): boolean {
  if (!localReady) return false
  if (preferOpenAI) return true
  return mode === 'openai_primary' || mode === 'local_first'
}

/** After a local failure, can we fall back to OpenAI under this mode? */
export function canFallbackToOpenAI(
  mode: TtsEngineMode,
  openaiKeyPresent: boolean,
  openaiBudgetOk: boolean,
  forceLocal = false,
): boolean {
  if (forceLocal) return false
  return openaiKeyPresent && openaiBudgetOk && mode === 'local_first'
}

