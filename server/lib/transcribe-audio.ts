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
import { enhanceAudio } from './audio-enhance.js'
import {
  stripInlineHallucinationsOneShot,
  isFullHallucination,
  isVocabEchoOnly,
  countVocabTerms,
} from './hallucination-filter.js'
import { getOpenAIKey, tryGetOpenAIKey } from './openai-key.js'
import { getTranscriptionPolicySnapshot, isOpenAIWhisperFallbackReady } from './transcription-policy.js'

export { OpenAIWhisperBudgetExhaustedError, estimateAudioSeconds }

export type TranscribeMode = 'hq' | 'fast'

export interface TranscribeAudioResult {
  text: string
  backend: string
  mode: TranscribeMode
  requestedMode: TranscribeMode
  actualQuality: 'hq' | 'fast' | 'cloud'
  degraded: boolean
  elapsedMs: number
  audioBytes: number
}

export type TranscriptionBackendPolicy = 'automatic' | 'local-only'

export class TranscriptionUnavailableError extends Error {
  readonly status = 503
  constructor(readonly reason: 'local_asr_unavailable' | 'local_asr_restarting' | 'openai_key_missing', message?: string) {
    super(message ?? reason)
    this.name = 'TranscriptionUnavailableError'
  }
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
  opts: { mode?: TranscribeMode; policy?: TranscriptionBackendPolicy } = {},
): Promise<TranscribeAudioResult> {
  const requestedMode = opts.mode ?? 'hq'
  const policy = opts.policy ?? 'automatic'
  const audioSeconds = estimateAudioSeconds(audioBuffer)
  const effectiveMode: TranscribeMode =
    requestedMode === 'hq' && audioSeconds > HQ_MAX_SECONDS ? 'fast' : requestedMode

  if (effectiveMode !== requestedMode) {
    console.log(`[transcribe] mode downgrade: hq → fast (audio ${audioSeconds.toFixed(1)}s > cap ${HQ_MAX_SECONDS}s)`)
  }

  let text: string
  let backend: string
  let actualQuality: 'hq' | 'fast' | 'cloud'
  const tStart = performance.now()

  if (effectiveMode === 'hq') {
    try {
      const enhanced = await enhanceAudio(audioBuffer)
      const result = await transcribeHighQuality(enhanced)
      text = result.text
      backend = 'hq-large-v3'
      actualQuality = 'hq'
    } catch (hqErr: any) {
      console.warn(`[transcribe] HQ path failed, falling back to fast: ${hqErr.message}`)
      try {
        const result = await transcribeLocal(audioBuffer)
        text = result.text
        backend = `fast-local-${result.backend}`
        actualQuality = 'fast'
      } catch (localErr: any) {
        const unavailable = policy === 'local-only'
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
      const result = await transcribeLocal(audioBuffer)
      text = result.text
      backend = `fast-local-${result.backend}`
      actualQuality = 'fast'
    } catch (localErr: any) {
      const unavailable = policy === 'local-only'
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
    const unavailable = policy === 'local-only'
      ? new TranscriptionUnavailableError('local_asr_unavailable', 'Local transcription is unavailable; retry after Whisper recovers')
      : unavailableAfterLocalFailure()
    if (unavailable) {
      throw unavailable
    }
    text = await transcribeCloud(audioBuffer)
    backend = 'cloud'
    actualQuality = 'cloud'
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
    backend,
    mode: effectiveMode,
    requestedMode,
    actualQuality,
    degraded: requestedMode === 'hq' && actualQuality !== 'hq',
    elapsedMs,
    audioBytes: audioBuffer.length,
  }
}
