import type { WhisperWord } from './whisper-local.js'
import {
  transcribeLocal,
  transcribeHighQuality,
  getWhisperBackend,
  applyCorrections,
} from './whisper-local.js'
import { getVocabulary, getOwnerName } from './profile.js'
import { applyFuzzyCorrections } from './fuzzy-correct.js'
import { getAllSpeakerNames } from './speaker-embeddings.js'
import {
  assertOpenAIWhisperBudget,
  recordOpenAIWhisperUsage,
  estimateAudioSeconds,
  OpenAIWhisperBudgetExhaustedError,
} from './openai-whisper-budget.js'
import {
  stripInlineHallucinationsOneShot,
  isFullHallucination,
  isVocabEchoOnly,
  countVocabTerms,
} from './hallucination-filter.js'
import { getOpenAIKey, tryGetOpenAIKey } from './openai-key.js'
import { getTranscriptionPolicySnapshot, isOpenAIWhisperFallbackReady } from './transcription-policy.js'
import {
  currentDesktopDictationPlan, currentDesktopFailureHint, currentDictationPlan, runParakeetDictation,
  type DesktopFailureHint, type DictationParakeetOutcome,
} from './dictation-stt.js'
import {
  dictationSlotForMode, type DesktopDictationId, type DesktopDictationPlan, type DictationEngine, type DictationPlan, type DictationSlot,
} from './stt-settings.js'

export { OpenAIWhisperBudgetExhaustedError, estimateAudioSeconds }

export type TranscribeMode = 'hq' | 'fast'

export interface TranscribeAudioResult {
  text: string
  /** 6.45.4 — the decoder's timed words with token probability, when the backend produced them. */
  words?: WhisperWord[]
  backend: string
  mode: TranscribeMode
  requestedMode: TranscribeMode
  actualQuality: 'hq' | 'fast' | 'cloud'
  degraded: boolean
  degradationReason?: string
  elapsedMs: number
  audioBytes: number
  /** 6.73.0: the engine that decoded this audio. */
  engine: DictationEngine
  /** Why the selected engine did not run (a reason code), when it did not. */
  engineReason?: string
  /** The setting this decode followed (see DictationPlan.key). */
  dictationKey: string
  /** 6.74.0, Mac dictation (requiredEngine=local) only: why auto used Whisper instead of Parakeet. */
  fallbackReason?: string
  /** 6.74.0, Mac dictation only: the dictation engine setting this decode followed. */
  dictationSetting?: DesktopDictationId
}

/** 6.74.0: what a Mac dictation request asks for. parakeet-ultra is COS Control 0.5.316 and
 *  earlier (Parakeet only, the 6.73.x 503); local is 0.5.317 and later (the dictation setting). */
export type RequiredEngine = 'parakeet-ultra' | 'local'

/** Injected by tests; production reads the settings and runs Parakeet. */
export interface DictationSttDeps {
  plan: (slot: DictationSlot) => DictationPlan
  parakeet: (audio: Buffer, plan: DictationPlan) => Promise<DictationParakeetOutcome>
  /** 6.74.0: the Mac dictation plan (its own setting). Defaults to the production plan. */
  desktopPlan?: (slot: DictationSlot) => DesktopDictationPlan
  /** 6.74.0: the action a failed Mac dictation offers. */
  failureHint?: (kind: 'no_local_engine' | 'parakeet_unavailable', parakeetReason: string | null) => DesktopFailureHint
}
export const defaultDictationSttDeps: DictationSttDeps = {
  plan: slot => currentDictationPlan(slot),
  parakeet: (audio, plan) => runParakeetDictation(audio, plan, 'interactive'),
  desktopPlan: slot => currentDesktopDictationPlan(slot),
  failureHint: (kind, reason) => currentDesktopFailureHint(kind, reason),
}

export type TranscriptionBackendPolicy = 'automatic' | 'local-only'

export class TranscriptionUnavailableError extends Error {
  readonly status = 503
  constructor(
    readonly reason: 'local_asr_unavailable' | 'local_asr_restarting' | 'openai_key_missing' | 'parakeet_unavailable' | 'no_local_engine',
    message?: string,
    /** 6.74.0, Mac dictation (requiredEngine=local) only. Absent everywhere else, so older bodies are unchanged. */
    readonly hint?: DesktopFailureHint,
  ) {
    super(message ?? reason)
    this.name = 'TranscriptionUnavailableError'
  }
}

/** Plain sentences for Mac dictation failures. COS Control shows them as is. */
export const DESKTOP_MESSAGES: Record<'no_local_engine' | 'parakeet_unavailable', Record<DesktopFailureHint['action'], string>> = {
  no_local_engine: {
    install_parakeet: 'No dictation engine is ready on this Mac. Install Parakeet in Transcription settings.',
    use_whisper: 'No dictation engine is ready on this Mac. Open Transcription settings to set one up.',
    retry_when_warm: 'The dictation engine is starting. Try again in a few seconds.',
    open_transcription_settings: 'No dictation engine is ready on this Mac. Open Transcription settings to set one up.',
  },
  parakeet_unavailable: {
    install_parakeet: 'Dictation is set to Parakeet, which is not installed. Install Parakeet, or choose Automatic in Transcription settings.',
    use_whisper: 'Dictation is set to Parakeet, which cannot transcribe right now. Choose Automatic or Whisper in Transcription settings.',
    retry_when_warm: 'Parakeet is warming up. Try again in a few seconds.',
    open_transcription_settings: 'Dictation is set to Parakeet, which cannot transcribe right now. Open Transcription settings.',
  },
}

export class NoSpeechDetectedError extends Error {
  readonly reason = 'no_speech'

  constructor(readonly rawText = '') {
    super('No speech detected')
    this.name = 'NoSpeechDetectedError'
  }
}

// HQ clips > this fall back to fast mode — large-v3 latency scales roughly linearly
// with audio length and beam-search × best-of amplifies that. 60s is the user-perceived
// ceiling (anything longer is a dictation, not a query — use meetings instead).
const HQ_MAX_SECONDS = 60

function unavailableAfterLocalFailure(): TranscriptionUnavailableError | null {
  const fallback = getTranscriptionPolicySnapshot()
  if (fallback.openaiFallbackReady) return null
  return fallback.openaiFallbackConfigured
    ? new TranscriptionUnavailableError('openai_key_missing', 'Local transcription is unavailable and the explicitly configured OpenAI fallback has no key')
    : new TranscriptionUnavailableError('local_asr_unavailable', 'Local transcription is unavailable; retry after Whisper recovers')
}

/** Transcribe via OpenAI Whisper API (cloud fallback).
 *  Budget-gated: throws OpenAIWhisperBudgetExhaustedError if today's $5 cap is spent.
 *  Ledger only ticks on SUCCESSFUL responses so retries that never reach the API
 *  aren't double-counted. */
async function transcribeCloud(audioBuffer: Buffer): Promise<string> {
  // Defense in depth: every cloud chokepoint rechecks the explicit two-factor
  // opt-in. A key alone is never authority to upload user audio.
  if (!isOpenAIWhisperFallbackReady()) {
    throw unavailableAfterLocalFailure()!
  }

  if (!tryGetOpenAIKey()) {
    throw new TranscriptionUnavailableError('openai_key_missing', 'OpenAI key missing; retry after local Whisper recovers')
  }

  assertOpenAIWhisperBudget()
  const key = getOpenAIKey()
  const audioSeconds = estimateAudioSeconds(audioBuffer)

  // Detect format from magic bytes.
  const isWav = audioBuffer.length >= 4 && audioBuffer.toString('ascii', 0, 4) === 'RIFF'
  const filename = isWav ? 'recording.wav' : 'recording.webm'
  const mimeType = isWav ? 'audio/wav' : 'audio/webm'

  const boundary = '----COS' + Date.now()
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  const modelPart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`
  const languagePart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen`
  const vocab = getVocabulary()
  const cloudPrompt = vocab.length > 0
    ? [getOwnerName(), ...vocab].join(', ')
    : `${getOwnerName()}, COS Glasses, Even G2`
  const promptPart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${cloudPrompt}`
  const footer = `\r\n--${boundary}--\r\n`

  const body = Buffer.concat([
    Buffer.from(header),
    audioBuffer,
    Buffer.from(modelPart),
    Buffer.from(languagePart),
    Buffer.from(promptPart),
    Buffer.from(footer),
  ])

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Whisper API ${response.status}: ${errText.slice(0, 200)}`)
  }

  const result = await response.json() as { text: string }
  recordOpenAIWhisperUsage(audioSeconds)
  return result.text
}

export function resolveTranscribeMode(raw: unknown): TranscribeMode {
  return String(raw ?? '').toLowerCase() === 'fast' ? 'fast' : 'hq'
}

export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  opts: {
    mode?: TranscribeMode
    policy?: TranscriptionBackendPolicy
    /** When false, turbo/server failures do not move the shared meeting circuit breaker. */
    affectsCircuit?: boolean
    /** A plan snapshot taken by the caller (prompt finalize takes one for every chunk). */
    dictationPlan?: DictationPlan
    sttDeps?: DictationSttDeps
    /** Mac dictation. Never uploads audio. parakeet-ultra never substitutes Whisper (6.73.x);
     *  local (6.74.0) follows the dictation setting. */
    requiredEngine?: RequiredEngine
  } = {},
): Promise<TranscribeAudioResult> {
  const requestedMode = opts.mode ?? 'hq'
  const policy = opts.policy ?? 'automatic'
  const affectsCircuit = opts.affectsCircuit !== false
  const audioSeconds = estimateAudioSeconds(audioBuffer)
  const effectiveMode: TranscribeMode =
    requestedMode === 'hq' && audioSeconds > HQ_MAX_SECONDS ? 'fast' : requestedMode

  if (effectiveMode !== requestedMode) {
    console.log(`[transcribe] mode downgrade: hq → fast (audio ${audioSeconds.toFixed(1)}s > cap ${HQ_MAX_SECONDS}s)`)
  }

  let text!: string
  let words: WhisperWord[] | undefined
  let backend!: string
  let actualQuality!: 'hq' | 'fast' | 'cloud'
  let degradationReason: string | undefined = effectiveMode !== requestedMode ? 'audio_too_long' : undefined
  const tStart = performance.now()

  // 6.73.0: Fast mode follows the Preview model, otherwise the HQ model. One plan
  // per decode; a long clip downgraded to Fast is planned for the Fast slot.
  const sttDeps = opts.sttDeps ?? defaultDictationSttDeps
  const slot = dictationSlotForMode(effectiveMode)
  // 6.74.0: Mac dictation follows its own setting, never the Preview model.
  const desktop: DesktopDictationPlan | null = opts.requiredEngine
    ? (sttDeps.desktopPlan ?? defaultDictationSttDeps.desktopPlan!)(slot)
    : null
  const plan: DictationPlan = desktop ?? (opts.dictationPlan && opts.dictationPlan.slot === slot ? opts.dictationPlan : sttDeps.plan(slot))
  // Old Control (requiredEngine=parakeet-ultra) and the explicit parakeet-ultra setting are strict.
  const legacyStrict = opts.requiredEngine === 'parakeet-ultra'
  const settingStrict = opts.requiredEngine === 'local' && desktop?.whisperAllowed === false
  const hint = (kind: 'no_local_engine' | 'parakeet_unavailable', reason: string | null) =>
    (sttDeps.failureHint ?? defaultDictationSttDeps.failureHint!)(kind, reason)
  const strictRefusal = (reason: string | null) => {
    const h = hint('parakeet_unavailable', reason)
    return new TranscriptionUnavailableError('parakeet_unavailable', DESKTOP_MESSAGES.parakeet_unavailable[h.action], h)
  }
  if (legacyStrict && plan.engine !== 'parakeet-ultra') {
    throw new TranscriptionUnavailableError('parakeet_unavailable', 'Parakeet is not ready. Select Parakeet for dictation in Transcription settings and retry.')
  }
  if (settingStrict && plan.engine !== 'parakeet-ultra') throw strictRefusal(plan.reason)
  let engine: DictationEngine = 'whisper'
  let engineReason: string | null = plan.reason
  let decoded = false
  if (plan.engine === 'parakeet-ultra') {
    const outcome = await sttDeps.parakeet(audioBuffer, plan)
    if (outcome.ok) {
      text = outcome.text
      backend = 'parakeet-ultra'
      actualQuality = effectiveMode
      engine = 'parakeet-ultra'
      engineReason = null
      decoded = true
    } else {
      engineReason = outcome.reason
    }
  }

  if (!decoded && legacyStrict) {
    throw new TranscriptionUnavailableError('parakeet_unavailable', 'Parakeet could not transcribe this audio. Retry when it is ready; no other engine was used.')
  }
  if (!decoded && settingStrict) throw strictRefusal(engineReason)
  // Mac dictation on auto or whisper: local Whisper only, and a Whisper that cannot run is
  // no_local_engine with one action, never the cloud.
  const desktopLocal = opts.requiredEngine === 'local'
  const effectivePolicy: TranscriptionBackendPolicy = desktopLocal ? 'local-only' : policy
  try {
  if (decoded) {
    // Parakeet ran: nothing below. Its word clocks are not passed to the prompt tail
    // guard, whose confidence rule is calibrated on Whisper token probabilities.
  } else if (effectiveMode === 'hq') {
    try {
      // A0 (2026-07-30): ffmpeg enhance light (highpass=f=80) was measured dropping
      // leading speech on compose ("device just for your awareness"). Meeting batch
      // still enhances in meeting-batch-transcribe.ts — this path is prompt/interactive only.
      const result = await transcribeHighQuality(audioBuffer, undefined, { priority: 'interactive', words: true })
      text = result.text
      words = result.words
      actualQuality = result.actualQuality
      if (result.actualQuality === 'hq') {
        backend = 'hq-large-v3'
      } else {
        backend = result.backend === 'whisper-cli' ? 'fast-cli-turbo' : 'fast-local-server'
        degradationReason = result.degradationReason ?? 'hq_unavailable'
      }
    } catch (hqErr: any) {
      console.warn(`[transcribe] HQ path failed, falling back to fast: ${hqErr.message}`)
      degradationReason = 'hq_decode_failed'
      try {
        const result = await transcribeLocal(audioBuffer, undefined, undefined, { affectsCircuit })
        text = result.text
        words = result.words
        backend = `fast-local-${result.backend}`
        actualQuality = 'fast'
      } catch (localErr: any) {
        const unavailable = effectivePolicy === 'local-only'
          ? new TranscriptionUnavailableError('local_asr_unavailable', 'Local transcription is unavailable; retry after Whisper recovers')
          : unavailableAfterLocalFailure()
        if (unavailable) {
          console.warn(`[transcribe] Fast local unavailable; preserving audio for retry: ${localErr.message}`)
          throw unavailable
        }
        console.warn(`[transcribe] Fast local also failed; using explicitly enabled OpenAI fallback: ${localErr.message}`)
        text = await transcribeCloud(audioBuffer)
        backend = 'cloud'
        actualQuality = 'cloud'
      }
    }
  } else if (effectiveMode === 'fast') {
    try {
      const result = await transcribeLocal(audioBuffer, undefined, undefined, { affectsCircuit })
      text = result.text
      words = result.words
      backend = `fast-local-${result.backend}`
      actualQuality = 'fast'
    } catch (localErr: any) {
      const unavailable = effectivePolicy === 'local-only'
        ? new TranscriptionUnavailableError('local_asr_unavailable', 'Local transcription is unavailable; retry after Whisper recovers')
        : unavailableAfterLocalFailure()
      if (unavailable) {
        console.warn(`[transcribe] Local unavailable; preserving audio for retry: ${localErr.message}`)
        throw unavailable
      }
      console.warn(`[transcribe] Local whisper failed (${getWhisperBackend()}); using explicitly enabled OpenAI fallback: ${localErr.message}`)
      text = await transcribeCloud(audioBuffer)
      backend = 'cloud'
      actualQuality = 'cloud'
    }
  } else {
    const unavailable = effectivePolicy === 'local-only'
      ? new TranscriptionUnavailableError('local_asr_unavailable', 'Local transcription is unavailable; retry after Whisper recovers')
      : unavailableAfterLocalFailure()
    if (unavailable) {
      throw unavailable
    }
    text = await transcribeCloud(audioBuffer)
    backend = 'cloud'
    actualQuality = 'cloud'
  }
  } catch (error) {
    if (desktopLocal && error instanceof TranscriptionUnavailableError) {
      const h = hint('no_local_engine', engineReason)
      throw new TranscriptionUnavailableError('no_local_engine', DESKTOP_MESSAGES.no_local_engine[h.action], h)
    }
    throw error
  }

  if (text && text.length > 0) {
    try {
      text = applyCorrections(text)
    } catch (corrErr: any) {
      console.warn(`[transcribe] applyCorrections failed (non-fatal): ${corrErr.message}`)
    }
  }

  if (text && text.length > 0) {
    try {
      text = stripInlineHallucinationsOneShot(text)
    } catch (stripErr: any) {
      console.warn(`[transcribe] Hallucination strip failed (non-fatal): ${stripErr.message}`)
    }
  }

  if (text && text.length > 0) {
    try {
      const fuzzyTargets = [...getAllSpeakerNames(), ...getVocabulary()]
      const { text: corrected, replacements } = applyFuzzyCorrections(text, fuzzyTargets)
      if (replacements > 0) {
        console.log(`[transcribe] Fuzzy corrected ${replacements} word(s)`)
        text = corrected
      }
    } catch (fuzzyErr: any) {
      console.warn(`[transcribe] Fuzzy correction failed (non-fatal): ${fuzzyErr.message}`)
    }
  }

  const elapsedMs = performance.now() - tStart
  // A one-shot message/dictation that is NOTHING but a list of seeded vocab terms
  // (>=2 distinct) is a whisper prompt-echo, not speech — drop it like the meeting
  // path does. A single terse brand mention stays (could be a real one-word message).
  const vocabEcho = isVocabEchoOnly(text) && countVocabTerms(text) >= 2
  if (!text || isFullHallucination(text) || vocabEcho) {
    throw new NoSpeechDetectedError(text || '')
  }

  return {
    text: text.trim(),
    ...(words && words.length > 0 ? { words } : {}),
    backend,
    mode: effectiveMode,
    requestedMode,
    actualQuality,
    degraded: requestedMode === 'hq' && actualQuality !== 'hq',
    ...(degradationReason ? { degradationReason } : {}),
    elapsedMs,
    audioBytes: audioBuffer.length,
    engine,
    ...(engineReason ? { engineReason } : {}),
    dictationKey: plan.key,
    ...(desktop ? { dictationSetting: desktop.setting } : {}),
    // A fallback is auto wanting Parakeet and getting Whisper; an explicit whisper setting is not one.
    ...(desktopLocal && desktop?.setting === 'auto' && engine === 'whisper' && engineReason ? { fallbackReason: engineReason } : {}),
  }
}
