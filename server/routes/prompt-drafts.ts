import { Router } from 'express'
import { createHash } from 'node:crypto'
import type { Response } from 'express'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
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
  type PromptDraftTranscriptRecord,
} from '../lib/prompt-draft-store.js'
import {
  transcribeAudioBuffer,
  resolveTranscribeMode,
  NoSpeechDetectedError,
  OpenAIWhisperBudgetExhaustedError,
  TranscriptionUnavailableError,
} from '../lib/transcribe-audio.js'
import {
  stripInlineHallucinationsOneShot,
  stripInlineHallucinations,
  stripPromptDictationArtifacts,
  isFullHallucination,
  isBrandUrlOnly,
  clearSessionHallucinationState,
  applyNegativeRules,
} from '../lib/hallucination-filter.js'
import { applyCorrections } from '../lib/whisper-local.js'
import { autoCleanDictation, AUTOCLEAN_MAX_CHARS } from '../lib/dictation-clean.js'
import { getVocabulary } from '../lib/profile.js'
import { createBreaker } from '../lib/claude-circuit.js'
import { logTokenAudit } from '../lib/token-audit.js'
import { atomicWriteFileSync } from '../lib/atomic-fs.js'
import { dataPath } from '../lib/data-dir.js'
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

/** Speculative HQ warm while speaking. Set COS_HQ_SPECULATIVE_WARM=0 to restore Fast-only warm. */
function speculativeHqWarmEnabled(): boolean {
  return !['0', 'false', 'off'].includes((process.env.COS_HQ_SPECULATIVE_WARM ?? '1').toLowerCase())
}

const autoCleanBreaker = createBreaker({ label: 'dictation-autoclean' })
const autoCleanCountFile = () => process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE || dataPath('.dictation_autoclean_count.json')
const autoCleanDefaultEnabled = () => ['1', 'true', 'on'].includes((process.env.COS_DICTATION_AUTOCLEAN ?? '').toLowerCase())
const autoCleanDailyCap = () => {
  const value = Number.parseInt(process.env.COS_DICTATION_AUTOCLEAN_MAX_PER_DAY || '200', 10)
  return Number.isFinite(value) && value > 0 ? value : 200
}
function autoCleanCountToday(): number {
  try {
    const raw = JSON.parse(readFileSync(autoCleanCountFile(), 'utf-8'))
    if (raw?.date === new Date().toISOString().slice(0, 10) && Number.isFinite(raw?.count)) return raw.count
  } catch {}
  return 0
}
function recordAutoCleanCall(): void {
  try {
    const file = autoCleanCountFile()
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
    atomicWriteFileSync(file, JSON.stringify({ date: new Date().toISOString().slice(0, 10), count: autoCleanCountToday() + 1 }), { mode: 0o600 })
  } catch {}
}

interface AutoCleanRequest { enabled?: boolean; model?: 'haiku' | 'sonnet' }
function routeAutoClean(req: { body?: any; query?: any }): AutoCleanRequest {
  const rawEnabled = req.body?.autoclean ?? req.query?.autoclean
  const enabled = rawEnabled === undefined ? undefined : ['1', 'true', 'on'].includes(String(rawEnabled).toLowerCase())
  const rawModel = String(req.body?.autocleanModel ?? req.query?.autocleanModel ?? '').toLowerCase()
  return { enabled, model: rawModel === 'sonnet' ? 'sonnet' : rawModel === 'haiku' ? 'haiku' : undefined }
}

async function cleanOutboundDictation(text: string, opts: AutoCleanRequest & { signal?: AbortSignal }): Promise<string> {
  let cleaned = applyNegativeRules(applyCorrections(text)).replace(/\s+/g, ' ').trim() || text
  if (!(opts.enabled ?? autoCleanDefaultEnabled())) return cleaned
  if (cleaned.length > AUTOCLEAN_MAX_CHARS || autoCleanBreaker.isOpen() || autoCleanCountToday() >= autoCleanDailyCap()) return cleaned
  const startedAt = Date.now()
  const model = opts.model === 'sonnet' ? 'sonnet' : 'haiku'
  recordAutoCleanCall()
  try {
    const polished = (await autoCleanDictation(cleaned, getVocabulary(), { model, signal: opts.signal })).trim()
    autoCleanBreaker.recordSuccess()
    logTokenAudit({
      source: 'g2-dictation-autoclean', model, inputChars: cleaned.length, outputChars: polished.length,
      durationMs: Date.now() - startedAt, caller: 'dictation_autoclean',
    })
    return polished || cleaned
  } catch (err: any) {
    autoCleanBreaker.recordFailure()
    console.warn(`[prompt-draft] auto-clean failed (glossary-only): ${err?.message ?? err}`)
    return cleaned
  }
}

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

function modeQualityKey(draftId: string, chunkIndex: number, mode: 'hq' | 'fast', hash: string): string {
  return `${draftId}:${chunkIndex}:${mode}:${hash}`
}

async function transcribeChunk(draftId: string, chunkIndex: number, audio: Buffer, mode: 'hq' | 'fast', purpose: 'warm' | 'final'): Promise<string> {
  const hash = audioHash(audio)
  const purposeKey = `${draftId}:${chunkIndex}:${purpose}:${mode}:${hash}`
  const sharedKey = modeQualityKey(draftId, chunkIndex, mode, hash)

  // HQ warm and HQ finalize must share one decode (plan step 8a).
  const existingShared = modeQualityJobs.get(sharedKey)
  if (existingShared) {
    try {
      const text = await existingShared
      if (purpose === 'final' && text) {
        const current = loadPromptDraftMeta(draftId)
        const warm = current?.warmTranscripts?.[String(chunkIndex)]
        const cachedFinal = current?.finalTranscripts?.[String(chunkIndex)]
        if (!cachedFinal || cachedFinal.hash !== hash) {
          await markPromptDraftChunkTranscript(draftId, chunkIndex, {
            text,
            hash,
            requestedMode: warm?.requestedMode ?? mode,
            actualQuality: warm?.actualQuality ?? (mode === 'hq' ? 'hq' : 'fast'),
            backend: warm?.backend ?? 'shared-inflight',
            degraded: warm?.degraded ?? false,
            ...(warm?.degradationReason ? { degradationReason: warm.degradationReason } : {}),
          }, 'final')
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
      const result = await transcribeAudioBuffer(audio, { mode, policy })
      if (!isCurrentChunk(draftId, chunkIndex, audio)) return ''
      const text = sanitizeTranscript(draftId, result.text)
      const record: PromptDraftTranscriptRecord = {
        text, hash, requestedMode: result.requestedMode, actualQuality: result.actualQuality,
        backend: result.backend, degraded: result.degraded,
        ...(result.degradationReason ? { degradationReason: result.degradationReason } : {}),
      }
      await markPromptDraftChunkTranscript(draftId, chunkIndex, record, purpose)
      console.log(`[prompt-draft] chunk ${draftId}/${chunkIndex}: ${result.elapsedMs.toFixed(1)}ms | ${result.backend} | ${purpose}/${mode} | ${text.length} chars`)
      return text
    } catch (err) {
      if (err instanceof NoSpeechDetectedError) {
        await markPromptDraftChunkTranscript(draftId, chunkIndex, {
          text: '', hash, requestedMode: mode, actualQuality: mode, backend: 'no-speech', degraded: false,
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

async function finalizeDraft(draftId: string, mode: 'hq' | 'fast', autoClean: AutoCleanRequest, signal?: AbortSignal) {
  const meta = loadPromptDraftMeta(draftId)
  if (!meta) throw Object.assign(new Error('draft not found'), { status: 404 })
  const texts: string[] = []
  const transcriptRecords: PromptDraftTranscriptRecord[] = []
  for (const chunk of readPromptDraftChunks(draftId)) {
    try {
      const hash = audioHash(chunk.audioBuffer)
      // Await in-flight HQ warm before deciding cache miss (plan step 8b belt).
      if (mode === 'hq') {
        const inflight = modeQualityJobs.get(modeQualityKey(draftId, chunk.chunkIndex, 'hq', hash))
        if (inflight) {
          try { await inflight } catch { /* finalize may retry with automatic below */ }
        }
      }
      const current = loadPromptDraftMeta(draftId)
      const cached = current?.finalTranscripts?.[String(chunk.chunkIndex)] ?? current?.warmTranscripts?.[String(chunk.chunkIndex)]
      // Reuse the exact requested-mode decode even when HQ truthfully degraded
      // to turbo. Finalize's automatic policy would make the same local choice
      // again after a successful turbo result, so a second decode adds latency
      // without improving quality. Legacy records stay excluded because their
      // decoder provenance was reconstructed during migration.
      const reusable = Boolean(
        cached
        && cached.hash === hash
        && cached.requestedMode === mode
        && !cached.backend.startsWith('legacy'),
      )
      const raw = reusable ? cached!.text : await transcribeChunk(draftId, chunk.chunkIndex, chunk.audioBuffer, mode, 'final')
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
  const finalText = await cleanOutboundDictation(text, { ...autoClean, signal })
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
      emitDisplay({
        type: 'prompt_transcript',
        data: { draftId: req.params.draftId, chunkIndex, text },
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
