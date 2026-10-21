import { isDictationCleanModel, type DictationCleanModel } from '../lib/dictation-clean-models.js'
import { Router } from 'express'
import { createHash } from 'node:crypto'
import type { Response } from 'express'
import { resolve } from 'node:path'
import {
  createPromptDraft,
  loadPromptDraftMeta,
  savePromptDraftChunk,
  readPromptDraftChunks,
  markPromptDraftFinalized,
  markPromptDraftChunkTranscript,
  markPromptDraftError,
  getMissingChunkIndexes,
  prunePromptDrafts,
  transcriptQualityRank,
  type PromptDraftTranscriptRecord,
} from '../lib/prompt-draft-store.js'
import { SPEECH_UNKNOWN, guardPromptTail, speechWindowsFromWav } from '../lib/prompt-tail-guard.js'
import {
  transcribeAudioBuffer,
  resolveTranscribeMode,
  NoSpeechDetectedError,
  OpenAIWhisperBudgetExhaustedError,
  TranscriptionUnavailableError,
} from '../lib/transcribe-audio.js'
import { getHighQualityTranscriptionCapability } from '../lib/whisper-local.js'
import {
  stripInlineHallucinationsOneShot,
  stripInlineHallucinations,
  stripPromptDictationArtifacts,
  isFullHallucination,
  isCaptionCreditHallucination,
  isBrandUrlOnly,
  clearSessionHallucinationState,
  applyNegativeRules,
} from '../lib/hallucination-filter.js'
import { applyCorrections } from '../lib/whisper-local.js'
import { applyFuzzyCorrections } from '../lib/fuzzy-correct.js'
import { getAllSpeakerNames } from '../lib/speaker-embeddings.js'
import { transcribeWhisperPreview } from '../lib/whisper-preview.js'
import { currentDictationPlan, runParakeetDictation } from '../lib/dictation-stt.js'
import { dictationSlotForMode, legacyDictationKey, type DictationPlan } from '../lib/stt-settings.js'
import { autoCleanDictation, AUTOCLEAN_MAX_CHARS } from '../lib/dictation-clean.js'
import { fillerPassEnabled, stripDisfluencies } from '../lib/dictation-fillers.js'
import { polishBudgetExhausted, recordPolishCall, type PolishBucket } from '../lib/dictation-polish-budget.js'
import { polishNeed, skipCleanEnabled } from '../lib/dictation-polish-need.js'
import {
  discardPolishPrewarm, isPrewarmModel, prewarmEnabled, PrewarmUnavailableError, runWarmPolish,
  startPolishPrewarm, takePolishPrewarm,
} from '../lib/dictation-prewarm.js'
import { getVocabulary, getWhisperCorrections } from '../lib/profile.js'
import { correctionOnlyForms } from '../lib/glossary-learn.js'
import { polishLinkProblem, renderSpokenPaths, spokenPathsEnabled } from '../lib/dictation-format.js'
import { createBreaker } from '../lib/claude-circuit.js'
import { logTokenAudit } from '../lib/token-audit.js'
import { emitDisplay } from '../lib/display-bus.js'
import {
  acquireMaintenanceWork,
  maintenanceAdmissionsOpen,
  MaintenanceLifecycleError,
  maintenanceErrorPayload,
  type MaintenanceWorkLease,
} from '../lib/maintenance-lifecycle.js'

export const promptDraftsRouter = Router()

const MAX_CHUNK_BYTES = 25 * 1024 * 1024
const MAX_DRAFT_BYTES = 256 * 1024 * 1024
const MAX_CHUNKS = 600
/** Purpose-scoped keys (legacy). Prefer modeQualityJobs for HQ warm↔finalize dedupe. */
const chunkTranscriptJobs = new Map<string, Promise<string>>()
/** Shared decode per draft/chunk/mode/hash — warm:hq and final:hq await the same promise. */
const modeQualityJobs = new Map<string, Promise<string>>()
const finalizeJobs = new Map<string, Promise<any>>()
let warmTail: Promise<void> = Promise.resolve()
let hqWarmTail: Promise<void> = Promise.resolve()
/** Peek decodes — drop-while-busy; never chained onto warmTail (HOL vs HQ). */
let peekTail: Promise<void> = Promise.resolve()
let peekBusy = false

/** Speculative HQ warm while speaking. Set COS_HQ_SPECULATIVE_WARM=0 to restore Fast-only warm. */
function speculativeHqWarmEnabled(): boolean {
  return !['0', 'false', 'off'].includes((process.env.COS_HQ_SPECULATIVE_WARM ?? '1').toLowerCase())
}

const autoCleanBreakers = {
  sonnet: createBreaker({ label: 'dictation-autoclean-sonnet' }),
  'luna-5.6-fast': createBreaker({ label: 'dictation-autoclean-luna' }),
  haiku: createBreaker({ label: 'dictation-autoclean-haiku' }),
}
const autoCleanDefaultEnabled = () => ['1', 'true', 'on'].includes((process.env.COS_DICTATION_AUTOCLEAN ?? '').toLowerCase())

/** 6.79.1, additive on finalize answers: why the polish model did not run (or did not finish). */
export type PolishSkipped = 'disabled' | 'too_long' | 'breaker_open' | 'daily_cap' | 'failed' | 'clean'
/** 6.79.2, additive when finalize was given a prewarmToken: what became of that warm process. */
export type PrewarmOutcome = 'used' | 'missed' | 'discarded'

interface AutoCleanRequest { enabled?: boolean; model?: DictationCleanModel }
function routeAutoClean(req: { body?: any; query?: any }): AutoCleanRequest {
  const rawEnabled = req.body?.autoclean ?? req.query?.autoclean
  const enabled = rawEnabled === undefined ? undefined : ['1', 'true', 'on'].includes(String(rawEnabled).toLowerCase())
  const rawModel = String(req.body?.autocleanModel ?? req.query?.autocleanModel ?? '').toLowerCase()
  // An unknown model must never silently select another provider.
  if (rawModel && !isDictationCleanModel(rawModel)) return { enabled: false }
  return { enabled, model: isDictationCleanModel(rawModel) ? rawModel : undefined }
}

async function cleanOutboundDictation(
  text: string,
  opts: AutoCleanRequest & { bucket: PolishBucket; signal?: AbortSignal; prewarmToken?: string },
): Promise<{ text: string; polishSkipped?: PolishSkipped; prewarm?: PrewarmOutcome }> {
  const result = await polishOutboundDictation(text, opts)
  // A warm process the model call did not take must not sit until its TTL.
  if (opts.prewarmToken && !result.prewarm) {
    return { ...result, prewarm: discardPolishPrewarm(opts.prewarmToken) ? 'discarded' : 'missed' }
  }
  return result
}

async function polishOutboundDictation(
  text: string,
  opts: AutoCleanRequest & { bucket: PolishBucket; signal?: AbortSignal; prewarmToken?: string },
): Promise<{ text: string; polishSkipped?: PolishSkipped; prewarm?: PrewarmOutcome }> {
  let cleaned = applyNegativeRules(applyCorrections(text)).replace(/\s+/g, ' ').trim() || text
  // applyCorrections above is an EXACT string map, so it only fixes misspellings someone
  // already hand-authored. A novel miss ("Rileyy" for Riley, "Exampel" for Example) sails
  // through it. The Levenshtein pass is what catches those, and until now it had exactly
  // ONE call site — transcribe-audio.ts:252, the server-transcription route — so phone
  // Moonshine dictation, which arrives here as text, never got it. Same construction and
  // same non-fatal posture as that site, deliberately: targets are speaker names plus
  // vocabulary, and a throw must never cost the user their transcript.
  //
  // Runs BEFORE the autoclean LLM so the model sees corrected proper nouns rather than
  // being asked to guess at them, and it still helps on every path where autoclean is
  // off, over the char cap, or breaker-open.
  try {
    const fuzzyTargets = [...getAllSpeakerNames(), ...getVocabulary()]
    const { text: corrected, replacements } = applyFuzzyCorrections(cleaned, fuzzyTargets)
    if (replacements > 0) {
      console.log(`[prompt-draft] Fuzzy corrected ${replacements} word(s)`)
      cleaned = corrected
    }
  } catch (fuzzyErr: any) {
    console.warn(`[prompt-draft] Fuzzy correction failed (non-fatal): ${fuzzyErr?.message ?? fuzzyErr}`)
  }
  // 6.79.1: um/uh never survive a skipped polish. Meeting lines stay faithful.
  if (opts.bucket !== 'meeting' && fillerPassEnabled()) cleaned = stripDisfluencies(cleaned)
  // 6.83.1: "forward slash pricing," is "/pricing," even when the model is skipped. One word
  // at a phrase end only; slugs of several words are the model's (dictation-format.ts).
  if (opts.bucket !== 'meeting' && spokenPathsEnabled()) cleaned = renderSpokenPaths(cleaned)
  if (!(opts.enabled ?? autoCleanDefaultEnabled())) return { text: cleaned, polishSkipped: 'disabled' }
  const model = opts.model ?? 'haiku'
  const autoCleanBreaker = autoCleanBreakers[model]
  if (cleaned.length > AUTOCLEAN_MAX_CHARS) return { text: cleaned, polishSkipped: 'too_long' }
  // 6.79.2, off by default: nothing for the model to fix (see dictation-polish-need.ts).
  if (skipCleanEnabled() && polishNeed(cleaned) === null) return { text: cleaned, polishSkipped: 'clean' }
  if (autoCleanBreaker.isOpen()) return { text: cleaned, polishSkipped: 'breaker_open' }
  if (polishBudgetExhausted(opts.bucket)) return { text: cleaned, polishSkipped: 'daily_cap' }
  const startedAt = Date.now()
  recordPolishCall(opts.bucket)
  // 6.79.2: a warm process started at key press answers without the CLI's start-up cost.
  const warmEntry = opts.prewarmToken ? takePolishPrewarm(opts.prewarmToken, model) : null
  let prewarm: PrewarmOutcome | undefined = opts.prewarmToken ? 'missed' : undefined
  try {
    let polished: string | null = null
    if (warmEntry) {
      try {
        polished = (await runWarmPolish(warmEntry, cleaned, getVocabulary(), { signal: opts.signal })).trim()
        prewarm = 'used'
      } catch (err) {
        // Nothing was sent: the cold path below is the same call, not a second one.
        if (!(err instanceof PrewarmUnavailableError)) throw err
      }
    }
    if (polished === null) polished = (await autoCleanDictation(cleaned, getVocabulary(), { model, signal: opts.signal })).trim()
    autoCleanBreaker.recordSuccess()
    logTokenAudit({
      source: 'g2-dictation-autoclean', model, inputChars: cleaned.length, outputChars: polished.length,
      durationMs: Date.now() - startedAt, caller: `dictation_autoclean_${opts.bucket}`,
    })
    // 6.83.1: the model never invents a link and never drops one the dictionary wrote. Its
    // answer is refused (the pre-polish text goes out, as on any failed polish) rather than
    // pasting a URL nobody said. The call still counted: it ran.
    const linkProblem = polished ? polishLinkProblem(cleaned, polished, correctionOnlyForms(getWhisperCorrections())) : null
    if (linkProblem) {
      console.warn(`[prompt-draft] auto-clean answer refused: ${linkProblem}`)
      return { text: cleaned, ...(prewarm ? { prewarm } : {}), polishSkipped: 'failed' }
    }
    return { text: polished || cleaned, ...(prewarm ? { prewarm } : {}) }
  } catch (err: any) {
    autoCleanBreaker.recordFailure()
    console.warn(`[prompt-draft] auto-clean failed (glossary-only): ${err?.message ?? err}`)
    return { text: cleaned, polishSkipped: 'failed', ...(prewarm ? { prewarm } : {}) }
  }
}

/** Finalize already-transcribed phone text through the same glossary + optional
 * AI cleanup used by server-owned prompt drafts. This route accepts text only:
 * Moonshine audio and rolling preview audio never leave the phone. */
promptDraftsRouter.post('/dictation/finalize', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  const surface = req.body?.surface
  const model = req.body?.autocleanModel
  if (!text) return res.status(400).json({ error: 'text_required' })
  if (text.length > AUTOCLEAN_MAX_CHARS) {
    return res.status(413).json({ error: 'text_too_large', maxChars: AUTOCLEAN_MAX_CHARS })
  }
  if (surface !== 'message' && surface !== 'meeting') {
    return res.status(400).json({ error: 'invalid_surface' })
  }
  if (model !== undefined && !isDictationCleanModel(model)) {
    return res.status(400).json({ error: 'invalid_autoclean_model' })
  }
  const rawToken = req.body?.prewarmToken
  if (rawToken !== undefined && (typeof rawToken !== 'string' || !PREWARM_TOKEN.test(rawToken))) {
    return res.status(400).json({ error: 'invalid_prewarm_token' })
  }

  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  const { text: finalText, polishSkipped, prewarm } = await cleanOutboundDictation(text, {
    enabled: true,
    model,
    bucket: surface,
    signal: abort.signal,
    prewarmToken: rawToken,
  })
  // 6.79.1: polishSkipped only when the model did not polish, so a polished answer is unchanged.
  // 6.79.2: prewarm only when the request carried a prewarmToken.
  res.json({
    text: finalText, surface, polished: finalText !== text,
    ...(polishSkipped ? { polishSkipped } : {}), ...(prewarm ? { prewarm } : {}),
  })
})

const PREWARM_TOKEN = /^[0-9a-f-]{36}$/

/** 6.79.2: start the polish process at key press. Fire and forget: every refusal is a normal
 * answer, and finalize without a token (or with a dead one) spawns as before. */
promptDraftsRouter.post('/dictation/polish/prewarm', (req, res) => {
  const model = req.body?.model ?? 'haiku'
  const surface = req.body?.surface ?? 'message'
  if (!isDictationCleanModel(model)) return res.status(400).json({ error: 'invalid_autoclean_model' })
  if (surface !== 'message' && surface !== 'meeting') return res.status(400).json({ error: 'invalid_surface' })
  if (!prewarmEnabled()) return res.status(409).json({ error: 'prewarm_unavailable', reason: 'disabled' })
  if (!isPrewarmModel(model)) return res.status(409).json({ error: 'prewarm_unavailable', reason: 'model' })
  if (autoCleanBreakers[model].isOpen()) return res.status(409).json({ error: 'prewarm_unavailable', reason: 'breaker_open' })
  if (polishBudgetExhausted(surface)) return res.status(409).json({ error: 'prewarm_unavailable', reason: 'daily_cap' })
  try {
    res.json(startPolishPrewarm(model))
  } catch (err: any) {
    res.status(409).json({ error: 'prewarm_unavailable', reason: 'cli' })
  }
})

promptDraftsRouter.delete('/dictation/polish/prewarm/:token', (req, res) => {
  res.json({ discarded: discardPolishPrewarm(req.params.token) })
})

async function readRawBody(req: AsyncIterable<Buffer | Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_CHUNK_BYTES) throw Object.assign(new Error('audio chunk too large'), { status: 413 })
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function routeMode(req: { body?: { mode?: string }; query?: { mode?: string | string[] } }) {
  return resolveTranscribeMode(
    (typeof req.body?.mode === 'string' ? req.body.mode : undefined) ??
    (typeof req.query?.mode === 'string' ? req.query.mode : undefined),
  )
}

const sessionId = (draftId: string) => `prompt-draft:${draftId}`
const audioHash = (audio: Buffer) => createHash('sha256').update(audio).digest('hex')
function isCurrentChunk(draftId: string, chunkIndex: number, audio: Buffer): boolean {
  try {
    return Boolean(readPromptDraftChunks(draftId).find(chunk => chunk.chunkIndex === chunkIndex)?.audioBuffer.equals(audio))
  } catch {
    return false
  }
}
function sanitizeTranscript(draftId: string, text: string, learnInline = true): string {
  const artifactCleaned = stripPromptDictationArtifacts(text).trim()
  if (isBrandUrlOnly(artifactCleaned)) return ''
  const oneShot = stripInlineHallucinationsOneShot(artifactCleaned).trim()
  const cleaned = learnInline ? stripInlineHallucinations(oneShot, sessionId(draftId)).trim() : oneShot
  return !cleaned || isFullHallucination(cleaned) ? '' : cleaned
}

async function sendDraftError(res: Response, draftId: string, err: any): Promise<void> {
  // Maintenance rejection is an admission result, not a draft failure. Keep
  // the recoverable draft untouched so the phone can retry after maintenance.
  if (err instanceof MaintenanceLifecycleError) {
    if (err.retryAfterSeconds != null) res.setHeader('Retry-After', String(err.retryAfterSeconds))
    return void res.status(err.status).json({ ...maintenanceErrorPayload(err), draftPreserved: true })
  }
  if (err instanceof NoSpeechDetectedError) return void res.status(204).send()
  if (err instanceof OpenAIWhisperBudgetExhaustedError) {
    await markPromptDraftError(draftId, err.message)
    return void res.status(503).json({ error: err.message, reason: 'openai_whisper_budget_exhausted', spent_today_usd: err.spentTodayUsd, cap_usd: err.capUsd })
  }
  if (err instanceof TranscriptionUnavailableError) {
    await markPromptDraftError(draftId, err.message)
    return void res.status(err.status).json({ error: err.message, reason: err.reason, retryable: true, draftPreserved: true })
  }
  await markPromptDraftError(draftId, err.message).catch(() => null)
  res.status(err.status ?? 500).json({ error: err.message })
}

// 6.73.0: the setting key is part of every decode key, so a decode made under
// one STT selection is never shared with or reused for another.
function modeQualityKey(draftId: string, chunkIndex: number, mode: 'hq' | 'fast', hash: string, sttKey: string): string {
  return `${draftId}:${chunkIndex}:${mode}:${hash}:${sttKey}`
}

/** The setting key a stored record was made under (pre-6.73 records: the 6.72.0 defaults). */
export function recordSttKey(record: PromptDraftTranscriptRecord): string {
  return record.sttKey ?? legacyDictationKey(record.requestedMode)
}

function planFor(mode: 'hq' | 'fast'): DictationPlan {
  return currentDictationPlan(dictationSlotForMode(mode))
}

async function transcribeChunk(draftId: string, chunkIndex: number, audio: Buffer, mode: 'hq' | 'fast', purpose: 'warm' | 'final', plan: DictationPlan = planFor(mode)): Promise<string> {
  const hash = audioHash(audio)
  const purposeKey = `${draftId}:${chunkIndex}:${purpose}:${mode}:${hash}:${plan.key}`
  const sharedKey = modeQualityKey(draftId, chunkIndex, mode, hash, plan.key)

  // HQ warm and HQ finalize must share one decode (plan step 8a).
  const existingShared = modeQualityJobs.get(sharedKey)
  if (existingShared) {
    try {
      const text = await existingShared
      if (purpose === 'final' && text) {
        const current = loadPromptDraftMeta(draftId)
        const warm = current?.warmTranscripts?.[String(chunkIndex)]
        const cachedFinal = current?.finalTranscripts?.[String(chunkIndex)]
        // Trust the shared job text + mode key. Warm metadata is only used when
        // it still matches this decode — a late Fast warm must not relabel HQ.
        const warmMatches = Boolean(
          warm
          && warm.hash === hash
          && warm.requestedMode === mode
          && warm.text === text,
        )
        const record: PromptDraftTranscriptRecord = {
          text,
          hash,
          requestedMode: mode,
          actualQuality: warmMatches
            ? warm!.actualQuality
            : (mode === 'hq' ? 'hq' : 'fast'),
          backend: warmMatches ? warm!.backend : 'shared-inflight',
          degraded: warmMatches ? warm!.degraded : false,
          ...(warmMatches && warm!.degradationReason ? { degradationReason: warm!.degradationReason } : {}),
          sttKey: plan.key,
          ...(warmMatches && warm!.engine ? { engine: warm!.engine } : {}),
          ...(warmMatches && warm!.engineReason ? { engineReason: warm!.engineReason } : {}),
        }
        if (
          !cachedFinal
          || cachedFinal.hash !== hash
          || transcriptQualityRank(cachedFinal.actualQuality) < transcriptQualityRank(record.actualQuality)
        ) {
          await markPromptDraftChunkTranscript(draftId, chunkIndex, record, 'final')
        }
      }
      return text
    } catch {
      // Shared warm failed under local-only; fall through so finalize can retry with automatic.
    }
  }

  const existing = chunkTranscriptJobs.get(purposeKey)
  if (existing) return existing

  const job = (async () => {
    try {
      // Speculative warm is always local-only. Finalize may use automatic cloud fallback.
      const policy = purpose === 'warm' ? 'local-only' as const : 'automatic' as const
      const result = await transcribeAudioBuffer(audio, { mode, policy, dictationPlan: plan })
      if (!isCurrentChunk(draftId, chunkIndex, audio)) return ''
      // 6.45.4 — the sentence Whisper invents after the speaker stops. Never trims
      // audio; drops a trailing sentence only on the junk lexicon or on silence
      // plus the decoder's own low confidence (prompt-tail-guard.ts).
      const guarded = guardPromptTail({ text: result.text, words: result.words, speech: speechWindowsFromWav(audio) })
      for (const drop of guarded.dropped) {
        console.warn(`[prompt-draft] tail_drop ${draftId}/${chunkIndex} ${purpose}/${mode} (${drop.reason}, start=${drop.startSec ?? '?'}s, lastSpeech=${guarded.lastSpeechEndSec ?? '?'}s, p=${drop.meanProbability?.toFixed(2) ?? '?'}): "${drop.text.slice(0, 100)}"`)
      }
      if (guarded.dropped.length > 0 && !guarded.text.trim()) throw new NoSpeechDetectedError(result.text)
      const text = sanitizeTranscript(draftId, guarded.text)
      const record: PromptDraftTranscriptRecord = {
        text, hash, requestedMode: result.requestedMode, actualQuality: result.actualQuality,
        backend: result.backend, degraded: result.degraded,
        ...(result.degradationReason ? { degradationReason: result.degradationReason } : {}),
        sttKey: result.dictationKey, engine: result.engine,
        ...(result.engineReason ? { engineReason: result.engineReason } : {}),
      }
      await markPromptDraftChunkTranscript(draftId, chunkIndex, record, purpose)
      console.log(`[prompt-draft] chunk ${draftId}/${chunkIndex}: ${result.elapsedMs.toFixed(1)}ms | ${result.backend}${result.engineReason ? ` (${result.engineReason})` : ''} | ${purpose}/${mode} | ${text.length} chars`)
      return text
    } catch (err) {
      if (err instanceof NoSpeechDetectedError) {
        // Large-v3 can rarely replace a clipped but valid phrase with a stock
        // caption credit. Keep the already-decoded Fast text for this one
        // recognized failure shape instead of persisting either the artifact
        // or an empty gap. Other no-speech results retain existing behavior.
        if (mode === 'hq' && isCaptionCreditHallucination(err.rawText)) {
          const fastJob = [...modeQualityJobs.entries()].find(([key]) => key.startsWith(`${draftId}:${chunkIndex}:fast:${hash}:`))?.[1]
          if (fastJob) {
            try { await fastJob } catch { /* normal no-speech path below */ }
          }
          const fast = loadPromptDraftMeta(draftId)?.warmTranscripts?.[String(chunkIndex)]
          if (
            fast
            && fast.hash === hash
            && fast.requestedMode === 'fast'
            && fast.actualQuality === 'fast'
            && fast.text.trim()
          ) {
            if (purpose === 'final') {
              await markPromptDraftChunkTranscript(draftId, chunkIndex, {
                ...fast,
                requestedMode: 'hq',
                degraded: true,
                degradationReason: 'hq_caption_credit_hallucination',
                sttKey: plan.key,
              }, 'final')
            }
            console.warn(`[prompt-draft] dropped HQ caption-credit hallucination ${draftId}/${chunkIndex}; retained Fast text`)
            return fast.text
          }
        }
        await markPromptDraftChunkTranscript(draftId, chunkIndex, {
          text: '', hash, requestedMode: mode, actualQuality: mode, backend: 'no-speech', degraded: false, sttKey: plan.key,
        }, purpose)
        return ''
      }
      throw err
    } finally {
      chunkTranscriptJobs.delete(purposeKey)
      modeQualityJobs.delete(sharedKey)
    }
  })()
  chunkTranscriptJobs.set(purposeKey, job)
  modeQualityJobs.set(sharedKey, job)
  return job
}

export function isReusableTranscript(
  cached: PromptDraftTranscriptRecord | undefined,
  hash: string,
  mode: 'hq' | 'fast',
  sttKey: string,
): boolean {
  if (!cached || cached.hash !== hash || cached.requestedMode !== mode) return false
  // 6.73.0: a decode made under a different STT selection is decoded again.
  if (recordSttKey(cached) !== sttKey) return false
  if (cached.backend.startsWith('legacy')) return false
  if (mode === 'fast') return cached.actualQuality === 'fast' || cached.actualQuality === 'cloud'
  // mode === 'hq'
  if (cached.actualQuality === 'hq' || cached.actualQuality === 'cloud') return true
  // Degraded turbo after an HQ request: retry when large-v3 can still run.
  // If HQ is unavailable, reuse to avoid a pointless second turbo decode.
  if (cached.actualQuality === 'fast') return !getHighQualityTranscriptionCapability().hqAvailable
  return false
}

async function finalizeDraft(draftId: string, mode: 'hq' | 'fast', autoClean: AutoCleanRequest, signal?: AbortSignal) {
  const meta = loadPromptDraftMeta(draftId)
  if (!meta) throw Object.assign(new Error('draft not found'), { status: 404 })
  const texts: string[] = []
  const transcriptRecords: PromptDraftTranscriptRecord[] = []
  // One STT snapshot for the whole finalize: a settings change mid-finalize never mixes selections.
  const plan = planFor(mode)
  for (const chunk of readPromptDraftChunks(draftId)) {
    try {
      const hash = audioHash(chunk.audioBuffer)
      // Await in-flight HQ warm before deciding cache miss (plan step 8b belt).
      if (mode === 'hq') {
        const inflight = modeQualityJobs.get(modeQualityKey(draftId, chunk.chunkIndex, 'hq', hash, plan.key))
        if (inflight) {
          try { await inflight } catch { /* finalize may retry with automatic below */ }
        }
      }
      const current = loadPromptDraftMeta(draftId)
      const cached = current?.finalTranscripts?.[String(chunk.chunkIndex)] ?? current?.warmTranscripts?.[String(chunk.chunkIndex)]
      // Reuse only a decode that still matches the requested mode's quality bar.
      // When Settings HQ is available, never treat a degraded turbo warm as final
      // — that left finished chats on Fast text while REVIEW looked "HQ ready".
      // Legacy records stay excluded (reconstructed provenance).
      const reusable = isReusableTranscript(cached, hash, mode, plan.key)
      const raw = reusable ? cached!.text : await transcribeChunk(draftId, chunk.chunkIndex, chunk.audioBuffer, mode, 'final', plan)
      const text = sanitizeTranscript(draftId, raw, !reusable)
      if (text.trim()) {
        texts.push(text.trim())
        const latest = loadPromptDraftMeta(draftId)
        const used = latest?.finalTranscripts?.[String(chunk.chunkIndex)]
          ?? latest?.warmTranscripts?.[String(chunk.chunkIndex)]
          ?? cached
        if (used && used.hash === hash) transcriptRecords.push(used)
      }
    } catch (err) {
      if (err instanceof NoSpeechDetectedError) continue
      throw err
    }
  }
  const text = texts.join(' ').replace(/\s+/g, ' ').trim()
  if (!text) {
    await markPromptDraftError(draftId, 'No speech detected')
    throw new NoSpeechDetectedError()
  }
  const { text: finalText, polishSkipped } = await cleanOutboundDictation(text, { ...autoClean, bucket: 'prompt_draft', signal })
  const finalized = await markPromptDraftFinalized(draftId, finalText)
  const qualities = transcriptRecords.map(record => record.actualQuality)
  const actualQuality: 'hq' | 'fast' | 'cloud' = qualities.includes('cloud')
    ? 'cloud'
    : qualities.length > 0 && qualities.every(quality => quality === 'hq')
      ? 'hq'
      : 'fast'
  const degraded = mode === 'hq' && (actualQuality !== 'hq' || transcriptRecords.some(record => record.degraded))
  const backends = [...new Set(transcriptRecords.map(record => record.backend))]
  const degradationReason = transcriptRecords.find(record => record.degradationReason)?.degradationReason
  const engines = [...new Set(transcriptRecords.map(record => record.engine ?? 'whisper'))]
  const engineReason = transcriptRecords.find(record => record.engineReason)?.engineReason
  return {
    draftId,
    text: finalText,
    recovered: true,
    chunkCount: finalized.receivedChunkIndexes.length,
    missingChunks: getMissingChunkIndexes(finalized),
    expiresAt: finalized.expiresAt,
    requestedMode: mode,
    actualQuality,
    degraded,
    backend: backends.length === 1 ? backends[0] : 'mixed',
    ...(degradationReason ? { degradationReason } : {}),
    // 6.73.0, additive.
    engine: engines.length === 1 ? engines[0] : engines.length === 0 ? plan.engine : 'mixed',
    ...(engineReason ? { engineReason } : {}),
    // 6.79.1, additive.
    ...(polishSkipped ? { polishSkipped } : {}),
  }
}

const prunedAtBoot = maintenanceAdmissionsOpen() ? prunePromptDrafts() : 0
if (prunedAtBoot) console.log(`[prompt-draft] pruned ${prunedAtBoot} expired draft(s)`)
const pruneTimer = setInterval(() => {
  if (maintenanceAdmissionsOpen()) prunePromptDrafts()
}, 60 * 60 * 1000)
pruneTimer.unref?.()

promptDraftsRouter.post('/prompt-drafts/start', (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    maintenanceLease = acquireMaintenanceWork('prompt_draft_write')
    const requestedId = typeof req.body?.recoveryId === 'string' ? req.body.recoveryId : undefined
    const meta = createPromptDraft(requestedId)
    res.json({ draftId: meta.draftId, recoveryId: requestedId ?? meta.draftId, remapped: Boolean(requestedId && requestedId !== meta.draftId), expiresAt: meta.expiresAt, status: meta.status })
  } catch (err: any) {
    if (err instanceof MaintenanceLifecycleError) {
      if (err.retryAfterSeconds != null) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      res.status(err.status).json(maintenanceErrorPayload(err))
      return
    }
    res.status(err.status ?? 500).json({ error: err.message })
  } finally {
    maintenanceLease?.release()
  }
})

/**
 * Provisional Turbo peek — cosmetic lens UX only.
 * Does NOT save chunks, advance the recovery ledger, or write warm/final transcripts.
 * Drop-while-busy: overlapping peeks return 204 without queueing behind HQ warm.
 */
promptDraftsRouter.post('/prompt-drafts/:draftId/peek', async (req, res) => {
  try {
    const meta = loadPromptDraftMeta(req.params.draftId)
    if (!meta) return void res.status(404).json({ error: 'draft not found' })

    const rawIndex = Array.isArray(req.query.chunkIndex) ? req.query.chunkIndex[0] : req.query.chunkIndex
    const chunkIndex = Number(rawIndex)
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return void res.status(400).json({ error: 'chunkIndex required' })
    }
    const rawGen = Array.isArray(req.query.peekGen) ? req.query.peekGen[0] : req.query.peekGen
    const peekGen = Number(rawGen)
    if (!Number.isInteger(peekGen) || peekGen < 0) {
      return void res.status(400).json({ error: 'peekGen required' })
    }

    if (peekBusy) {
      return void res.status(204).send()
    }

    const audio = await readRawBody(req)
    if (!audio.length) return void res.status(400).json({ error: 'empty audio' })
    if (audio.length > MAX_CHUNK_BYTES) return void res.status(413).json({ error: 'audio chunk too large' })

    const lease = acquireMaintenanceWork('prompt_draft_peek', {
      allowDuringDrain: true,
      phase: 'queued',
    })

    peekBusy = true
    const draftId = req.params.draftId
    peekTail = peekTail.then(async () => {
      lease.setPhase('active')
      try {
        // 6.73.0: the live preview follows the Preview model. Parakeet runs on the
        // shared one-at-a-time preview lane; any miss is the 6.72.0 Whisper peek.
        const plan = currentDictationPlan('preview')
        let raw: string | null = null
        let engine: 'whisper' | 'parakeet-ultra' = 'whisper'
        if (plan.engine === 'parakeet-ultra') {
          const outcome = await runParakeetDictation(audio, plan, 'preview')
          if (outcome.ok) { raw = applyCorrections(outcome.text); engine = 'parakeet-ultra' }
        }
        if (raw === null) raw = (await transcribeWhisperPreview(audio)).text
        // 6.45.4: the same whole-sentence filler rule as the commit path, so an
        // invented closing line never paints on the lens only to vanish later.
        const text = sanitizeTranscript(draftId, guardPromptTail({ text: raw, speech: SPEECH_UNKNOWN }).text, false)
        if (!text) return
        if (!loadPromptDraftMeta(draftId)) return
        emitDisplay({
          type: 'prompt_transcript',
          data: { draftId, chunkIndex, text, provisional: true, peekGen, engine },
        })
      } catch (err: any) {
        if (!(err instanceof NoSpeechDetectedError)) {
          console.warn(`[prompt-draft] peek failed ${draftId}/${chunkIndex}: ${err?.message ?? err}`)
        }
      } finally {
        peekBusy = false
        lease.release()
      }
    }).catch(() => {
      peekBusy = false
      lease.release()
    })

    res.json({ draftId, chunkIndex, peekGen, accepted: true })
  } catch (err: any) {
    if (err instanceof MaintenanceLifecycleError) {
      if (err.retryAfterSeconds != null) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      return void res.status(err.status).json({ ...maintenanceErrorPayload(err), draftPreserved: true })
    }
    res.status(err.status ?? (err.message === 'draft not found' ? 404 : 500)).json({ error: err.message })
  }
})

promptDraftsRouter.post('/prompt-drafts/:draftId/chunks', async (req, res) => {
  let maintenanceLease: MaintenanceWorkLease | undefined
  try {
    const raw = Array.isArray(req.query.chunkIndex) ? req.query.chunkIndex[0] : req.query.chunkIndex
    const chunkIndex = Number(raw)
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= MAX_CHUNKS) return res.status(400).json({ error: 'invalid chunkIndex' })
    const before = loadPromptDraftMeta(req.params.draftId)
    if (!before) return res.status(404).json({ error: 'draft not found' })
    maintenanceLease = acquireMaintenanceWork('prompt_draft_write')
    const audio = await readRawBody(req)
    if (audio.length < 44) return res.status(400).json({ error: 'audio too short' })
    const existingBytes = before.chunkBytes[String(chunkIndex)] ?? 0
    const nextTotal = Object.values(before.chunkBytes).reduce((sum, bytes) => sum + bytes, 0) - existingBytes + audio.length
    if (nextTotal > MAX_DRAFT_BYTES) return res.status(413).json({ error: 'prompt draft too large' })
    const meta = await savePromptDraftChunk(req.params.draftId, chunkIndex, audio)
    const requestedMode = routeMode(req)
    const warmLease = acquireMaintenanceWork('prompt_draft_warm', {
      allowDuringDrain: true,
      phase: 'queued',
    })
    // Fast warm feeds the live HUD. Speculative HQ (when Settings HQ / default)
    // overwrites warmTranscripts with actualQuality=hq for near-instant finalize.
    warmTail = warmTail.then(async () => {
      warmLease.setPhase('active')
      const text = await transcribeChunk(req.params.draftId, chunkIndex, audio, 'fast', 'warm')
      // The durability ACK above remains immediate. Publish the optional warm
      // transcript only after rechecking that this exact audio still owns the
      // chunk index; a retry/replacement must never paint stale words.
      if (!isCurrentChunk(req.params.draftId, chunkIndex, audio)) return
      const warm = loadPromptDraftMeta(req.params.draftId)?.warmTranscripts?.[String(chunkIndex)]
      emitDisplay({
        type: 'prompt_transcript',
        data: { draftId: req.params.draftId, chunkIndex, text, ...(warm?.requestedMode === 'fast' && warm.engine ? { engine: warm.engine } : {}) },
      })
    }).catch(err => {
      console.warn(`[prompt-draft] warm transcription failed ${req.params.draftId}/${chunkIndex}: ${err.message}`)
    }).finally(() => warmLease.release())

    if (requestedMode === 'hq' && speculativeHqWarmEnabled()) {
      const hqLease = acquireMaintenanceWork('prompt_draft_warm', {
        allowDuringDrain: true,
        phase: 'queued',
      })
      hqWarmTail = hqWarmTail.then(async () => {
        hqLease.setPhase('active')
        // Cache only — never emitDisplay HQ (avoids HUD flicker). local-only via purpose=warm.
        await transcribeChunk(req.params.draftId, chunkIndex, audio, 'hq', 'warm')
      }).catch(err => {
        console.warn(`[prompt-draft] speculative HQ warm failed ${req.params.draftId}/${chunkIndex}: ${err.message}`)
      }).finally(() => hqLease.release())
    }

    res.json({ draftId: meta.draftId, chunkIndex, acked: true, receivedChunkIndexes: meta.receivedChunkIndexes, chunkBytes: meta.chunkBytes[String(chunkIndex)] ?? audio.length, transcriptPending: true, expiresAt: meta.expiresAt })
  } catch (err: any) {
    if (err instanceof MaintenanceLifecycleError) {
      if (err.retryAfterSeconds != null) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      return void res.status(err.status).json(maintenanceErrorPayload(err))
    }
    res.status(err.status ?? (err.message === 'draft not found' ? 404 : 500)).json({ error: err.message })
  } finally {
    maintenanceLease?.release()
  }
})

async function finalizeRequest(req: any, res: Response): Promise<void> {
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  try {
    const mode = routeMode(req)
    const key = `${req.params.draftId}:${mode}`
    let job = finalizeJobs.get(key)
    if (!job) {
      const finalizeLease = acquireMaintenanceWork('prompt_draft_finalize')
      job = finalizeDraft(req.params.draftId, mode, routeAutoClean(req), abort.signal)
        .finally(() => finalizeLease.release())
      finalizeJobs.set(key, job)
      job.finally(() => finalizeJobs.delete(key)).catch(() => {})
    }
    res.json(await job)
  } catch (err: any) {
    await sendDraftError(res, req.params.draftId, err)
  } finally {
    clearSessionHallucinationState(sessionId(req.params.draftId))
  }
}

promptDraftsRouter.post('/prompt-drafts/:draftId/finalize', finalizeRequest)
promptDraftsRouter.post('/prompt-drafts/:draftId/retry', finalizeRequest)
promptDraftsRouter.get('/prompt-drafts/:draftId', (req, res) => {
  try {
    const meta = loadPromptDraftMeta(req.params.draftId)
    if (!meta) return res.status(404).json({ error: 'draft not found' })
    res.json({ ...meta, missingChunks: getMissingChunkIndexes(meta) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
