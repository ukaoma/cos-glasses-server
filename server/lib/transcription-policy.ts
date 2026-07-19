import { getKeyStatus } from './openai-key.js'

/**
 * Cloud transcription is a two-factor opt-in. Merely having an OpenAI key on
 * the machine must never route voice away from local Whisper.
 */
export const OPENAI_WHISPER_FALLBACK_ENV = 'COS_OPENAI_WHISPER_FALLBACK'

export interface TranscriptionPolicySnapshot {
  mode: 'local-only' | 'local-then-openai'
  localRequired: true
  openaiFallbackConfigured: boolean
  openaiFallbackReady: boolean
}

export function getTranscriptionPolicySnapshot(): TranscriptionPolicySnapshot {
  const openaiFallbackConfigured = process.env[OPENAI_WHISPER_FALLBACK_ENV] === '1'
  const openaiFallbackReady = openaiFallbackConfigured && getKeyStatus().hasKey
  return {
    mode: openaiFallbackReady ? 'local-then-openai' : 'local-only',
    localRequired: true,
    openaiFallbackConfigured,
    openaiFallbackReady,
  }
}

export function isOpenAIWhisperFallbackReady(): boolean {
  return getTranscriptionPolicySnapshot().openaiFallbackReady
}
