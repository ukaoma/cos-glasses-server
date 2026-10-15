// Manual Mac canonical chunks follow the saved-meeting model choice. The
// normal preview resolver may fall back to Turbo; canonical Mac audio must not.
import { ParakeetError, transcribeParakeet, type ParakeetFailure } from './parakeet.js'
import type { WhisperWord } from './whisper-local.js'

export const MAC_PARAKEET_TIMEOUT_MS = 30_000

export class MacParakeetUnavailableError extends Error {
  readonly status = 503
  readonly retryable = true
  readonly model = 'parakeet-ultra'
  readonly reason: `mac_parakeet_${ParakeetFailure}`

  constructor(cause: unknown) {
    const reason = cause instanceof ParakeetError ? cause.reason : 'cli_failed'
    super(`Selected Parakeet Ultra could not transcribe this Mac chunk (${reason}); audio is preserved for retry`)
    this.name = 'MacParakeetUnavailableError'
    this.reason = `mac_parakeet_${reason}`
  }
}

/** Interactive admission is bounded and never queues behind saved HQ work.
 * The shared worker verifies the pinned installation and offline sandbox.
 * Cold compilation may use this deadline; no Whisper/cloud fallback is allowed. */
export async function transcribeMacParakeet(audio: Buffer, speechSeconds: number | null): Promise<{
  text: string
  words: WhisperWord[]
  model: 'parakeet-ultra'
  backend: 'fluidaudio-coreml'
  asrProvider: 'server-parakeet'
  latencyMs: number
}> {
  try {
    const result = await transcribeParakeet(audio, {
      model: 'parakeet-ultra',
      lane: 'interactive',
      timeoutMs: MAC_PARAKEET_TIMEOUT_MS,
    })
    if (result.model !== 'parakeet-ultra' || (!result.text.trim() && speechSeconds !== null && speechSeconds >= 0.5)) {
      throw new ParakeetError('bad_output', 'Parakeet did not return the selected model or words over detected speech')
    }
    return {
      text: result.text,
      words: result.words.map(word => ({ ...word, probability: word.probability ?? 0 })),
      model: result.model,
      backend: 'fluidaudio-coreml',
      asrProvider: 'server-parakeet',
      latencyMs: result.wallMs,
    }
  } catch (error) {
    throw new MacParakeetUnavailableError(error)
  }
}
