// POST /api/transcribe: one-shot transcription (message-query path). 6.73.0: the engine
// follows the STT settings (docs/dictation-stt-contract.md); Whisper is the fallback.
// 6.74.0: Mac dictation (requiredEngine=local) follows its own dictation setting and
// never leaves this Mac; POST /api/transcribe/benchmark is the onboarding check.
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
  BENCHMARK_MAX_BYTES, BenchmarkRefusedError, parseBenchmarkEngines, runDictationBenchmark,
} from '../lib/dictation-benchmark.js'
import {
  acquireMaintenanceWork,
  MaintenanceLifecycleError,
  maintenanceErrorPayload,
  type MaintenanceWorkLease,
} from '../lib/maintenance-lifecycle.js'

export const transcribeRouter = Router()
// A Mac client checks this before transferring microphone audio. Older servers must not
// silently ignore the requested engine and use a configured cloud fallback.
// 6.74.0: desktopDictationVersion stays 1, because COS Control 0.5.316 and earlier accept
// exactly 1. desktopDictationVersions lists 2: requiredEngine=local (the dictation setting).
transcribeRouter.get('/transcribe/capabilities', (_req, res) => {
  res.json({
    desktopDictationVersion: 1,
    desktopDictationVersions: [1, 2],
    requiredEngines: ['parakeet-ultra', 'local'],
    localOnly: true,
    dictionary: 'cos',
    benchmark: 1,
    // 6.77.0: post-save transcript cleanup. suggestions = /api/transcript-cleanup/suggestions,
    // screenContext = POST /api/meeting/:sessionId/screen-context.
    transcriptCleanup: { protocol: 1, suggestions: 1, screenContext: 1 },
  })
})

const REQUIRED_ENGINES = new Set(['parakeet-ultra', 'local'])

async function readCapped(req: AsyncIterable<unknown>, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += part.length
    if (size > cap) return null
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

// POST /api/transcribe/benchmark?engines=whisper,parakeet-ultra: raw 16 kHz WAV body.
// Bounded in dictation-benchmark.ts (one at a time, never while recording, timeouts).
transcribeRouter.post('/transcribe/benchmark', async (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    const engines = parseBenchmarkEngines(req.query.engines)
    if (!engines) return res.status(400).json({ error: 'engines must list whisper and/or parakeet-ultra.', reason: 'invalid_engine' })
    maintenanceLease = acquireMaintenanceWork('one_shot_transcription')
    const audio = await readCapped(req, BENCHMARK_MAX_BYTES)
    if (!audio) return res.status(413).json({ error: 'The sample is longer than two minutes.', reason: 'audio_too_large' })
    const result = await runDictationBenchmark(audio, engines)
    res.json(result)
  } catch (err: any) {
    if (err instanceof MaintenanceLifecycleError) {
      if (err.retryAfterSeconds != null) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      return res.status(err.status).json(maintenanceErrorPayload(err))
    }
    if (err instanceof BenchmarkRefusedError) return res.status(err.status).json({ error: err.message, reason: err.reason })
    res.status(500).json({ error: err.message })
  } finally {
    maintenanceLease?.release()
  }
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
    const rawEngine = req.query.requiredEngine
    if (rawEngine !== undefined && (typeof rawEngine !== 'string' || !REQUIRED_ENGINES.has(rawEngine))) {
      return res.status(400).json({ error: 'invalid_required_engine' })
    }
    const requiredEngine = rawEngine as 'parakeet-ultra' | 'local' | undefined
    const audioBuffer = await readCapped(req, requiredEngine ? 3_840_044 : 25 * 1024 * 1024)
    if (!audioBuffer) return res.status(413).json({ error: 'audio_too_large' })

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
      // 6.74.0, Mac dictation only.
      ...(result.dictationSetting ? { dictationSetting: result.dictationSetting } : {}),
      ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
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
      // The 6.73.x body for every caller; Mac dictation on requiredEngine=local adds
      // the one action it offers, and says when a retry cannot succeed.
      return res.status(err.status).json({
        error: err.message,
        reason: err.reason,
        retryable: err.hint ? err.hint.retryable : true,
        ...(err.hint ? { action: err.hint.action, detail: err.hint.detail } : {}),
      })
    }
    res.status(500).json({ error: err.message })
  } finally {
    maintenanceLease?.release()
  }
})
