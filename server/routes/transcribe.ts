// POST /api/transcribe: one-shot transcription (message-query path). 6.73.0: the engine
// follows the STT settings (docs/dictation-stt-contract.md); Whisper is the fallback.
//
// The actual Whisper + cleanup pipeline lives in server/lib/transcribe-audio.ts so
// prompt-draft recovery and the legacy one-shot path share exactly the same behavior.

import { Router } from 'express'
import {
  transcribeAudioBuffer,
  resolveTranscribeMode,
  NoSpeechDetectedError,
  OpenAIWhisperBudgetExhaustedError,
  TranscriptionUnavailableError,
} from '../lib/transcribe-audio.js'
import {
  acquireMaintenanceWork,
  MaintenanceLifecycleError,
  maintenanceErrorPayload,
  type MaintenanceWorkLease,
} from '../lib/maintenance-lifecycle.js'

export const transcribeRouter = Router()
// A Mac client checks this before transferring microphone audio. Older servers must not
// silently ignore the requested engine and use a configured cloud fallback.
transcribeRouter.get('/transcribe/capabilities', (_req, res) => {
  res.json({ desktopDictationVersion: 1, requiredEngines: ['parakeet-ultra'], localOnly: true, dictionary: 'cos' })
})

function resolveMode(req: { body?: { mode?: string }; query?: { mode?: string | string[] } }) {
  return resolveTranscribeMode(
    (req.body && typeof req.body.mode === 'string' ? req.body.mode : undefined) ??
    (req.query && typeof req.query.mode === 'string' ? req.query.mode : undefined)
  )
}

// Accept raw binary body up to 25MB (Whisper limit).
transcribeRouter.post('/transcribe', async (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    maintenanceLease = acquireMaintenanceWork('one_shot_transcription')
    const chunks: Buffer[] = []
    const requiredEngine = req.query.requiredEngine
    if (requiredEngine !== undefined && requiredEngine !== 'parakeet-ultra') {
      return res.status(400).json({ error: 'invalid_required_engine' })
    }
    let size = 0
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > (requiredEngine ? 3_840_044 : 25 * 1024 * 1024)) {
        return res.status(413).json({ error: 'audio_too_large' })
      }
      chunks.push(part)
    }
    const audioBuffer = Buffer.concat(chunks)

    if (audioBuffer.length < 100) {
      return res.status(400).json({ error: 'audio too short' })
    }

    const result = await transcribeAudioBuffer(audioBuffer, {
      mode: resolveMode(req),
      ...(requiredEngine ? { requiredEngine, policy: 'local-only' as const, affectsCircuit: false } : {}),
    })
    console.log(`[perf] /transcribe: ${result.elapsedMs.toFixed(1)}ms | mode=${result.mode} | ${result.backend}${result.engineReason ? ` (${result.engineReason})` : ''} | ${result.audioBytes}b | ${result.text.length} chars`)
    res.json({
      text: result.text,
      backend: result.backend,
      mode: result.mode,
      requestedMode: result.requestedMode,
      actualQuality: result.actualQuality,
      degraded: result.degraded,
      ...(result.degradationReason ? { degradationReason: result.degradationReason } : {}),
      // 6.73.0, additive: which engine decoded it and, when the selection could not run, why.
      engine: result.engine,
      ...(result.engineReason ? { engineReason: result.engineReason } : {}),
    })
  } catch (err: any) {
    if (err instanceof MaintenanceLifecycleError) {
      if (err.retryAfterSeconds != null) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      return res.status(err.status).json(maintenanceErrorPayload(err))
    }
    if (err instanceof NoSpeechDetectedError) {
      console.log(`[perf] /transcribe: DROPPED (hallucination or empty): ${err.rawText.length} chars`)
      return res.status(204).send()
    }
    if (err instanceof OpenAIWhisperBudgetExhaustedError) {
      console.error(`[transcribe] ${err.message}`)
      return res.status(503).json({
        error: err.message,
        reason: 'openai_whisper_budget_exhausted',
        spent_today_usd: err.spentTodayUsd,
        cap_usd: err.capUsd,
      })
    }
    if (err instanceof TranscriptionUnavailableError) {
      console.warn(`[transcribe] ${err.message}`)
      return res.status(err.status).json({
        error: err.message,
        reason: err.reason,
        retryable: true,
      })
    }
    res.status(500).json({ error: err.message })
  } finally {
    maintenanceLease?.release()
  }
})
