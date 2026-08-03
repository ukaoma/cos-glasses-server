// Adaptive provisional transcription. This sidecar is deliberately isolated
// from the authoritative large-v3-turbo server in whisper-local.ts:
//   small.en  -> cosmetic prompt preview only
//   turbo     -> committed live transcript (unchanged)
//   large-v3  -> HQ save/polish (unchanged)

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyCorrections, getWhisperHealth, transcribeLocal } from './whisper-local.js'
import { getOwnerName, getVocabulary } from './profile.js'

export type WhisperPreviewRequest = 'auto' | 'small.en' | 'turbo' | 'off'
export type WhisperPreviewModel = 'small.en' | 'large-v3-turbo' | null
export type WhisperPreviewReason =
  | 'disabled'
  | 'small_model_missing'
  | 'preview_binary_missing'
  | 'preview_port_busy'
  | 'preview_start_failed'
  | 'preview_sidecar_unavailable'
  | 'turbo_unavailable'
  | null

export interface WhisperPreviewCapability {
  requested: WhisperPreviewRequest
  effectiveModel: WhisperPreviewModel
  ready: boolean
  backend: 'whisper-preview-server' | 'whisper-server' | null
  degraded: boolean
  reason: WhisperPreviewReason
  committedModel: 'large-v3-turbo'
}

const MODEL_DIR = join(process.env.HOME ?? homedir(), '.local/share/whisper-models')
export const WHISPER_SMALL_EN_MODEL_PATH = join(MODEL_DIR, 'ggml-small.en.bin')
const VAD_MODEL_PATH = join(MODEL_DIR, 'ggml-silero-v5.1.2.bin')
const VAD_ENABLED = process.env.COS_WHISPER_VAD !== '0'
const WHISPER_SERVER = ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server']
  .find(existsSync) ?? '/opt/homebrew/bin/whisper-server'
const PREVIEW_PORT = 8177
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`

let previewProcess: ChildProcess | null = null
let previewAvailable = false
let previewStarting = false
let previewFailure: WhisperPreviewReason = null
let warnedInvalidChoice = false

export function normalizeWhisperPreviewRequest(raw?: string): WhisperPreviewRequest {
  const value = raw?.trim().toLowerCase()
  // Backward compatibility is deliberate: simply updating the server keeps
  // the old Turbo preview. Guided Setup opts the user into Small.en.
  if (!value) return 'turbo'
  if (value === 'auto' || value === 'adaptive') return 'auto'
  if (value === 'small' || value === 'small.en' || value === 'ggml-small.en.bin') return 'small.en'
  if (value === 'turbo' || value === 'large-v3-turbo' || value === 'ggml-large-v3-turbo.bin') return 'turbo'
  if (value === 'off' || value === 'disabled' || value === '0') return 'off'
  return 'auto'
}

function requestedPreviewModel(): WhisperPreviewRequest {
  const raw = process.env.COS_WHISPER_PREVIEW_MODEL
    ?? process.env.COS_WHISPER_REALTIME_MODEL // migration alias for early private installs
  const normalized = normalizeWhisperPreviewRequest(raw)
  if (raw && normalized === 'auto' && !['auto', 'adaptive'].includes(raw.trim().toLowerCase()) && !warnedInvalidChoice) {
    warnedInvalidChoice = true
    console.warn(`[whisper-preview] Unknown model "${raw}"; using adaptive selection.`)
  }
  return normalized
}

function selectedPreviewModel(requested = requestedPreviewModel()): WhisperPreviewModel {
  if (requested === 'off') return null
  if (requested === 'turbo') return 'large-v3-turbo'
  if (requested === 'small.en') return existsSync(WHISPER_SMALL_EN_MODEL_PATH) ? 'small.en' : 'large-v3-turbo'
  return existsSync(WHISPER_SMALL_EN_MODEL_PATH) ? 'small.en' : 'large-v3-turbo'
}

export function getWhisperPreviewCapability(): WhisperPreviewCapability {
  const requested = requestedPreviewModel()
  if (requested === 'off') {
    return {
      requested, effectiveModel: null, ready: false, backend: null,
      degraded: false, reason: 'disabled', committedModel: 'large-v3-turbo',
    }
  }

  const smallPresent = existsSync(WHISPER_SMALL_EN_MODEL_PATH)
  const selected = selectedPreviewModel(requested)
  const turboReady = getWhisperHealth().server
  if (selected === 'small.en' && previewAvailable) {
    return {
      requested, effectiveModel: 'small.en', ready: true,
      backend: 'whisper-preview-server', degraded: false, reason: null,
      committedModel: 'large-v3-turbo',
    }
  }

  const smallWasExpected = requested === 'small.en' || (requested === 'auto' && smallPresent)
  const reason: WhisperPreviewReason = requested === 'small.en' && !smallPresent
    ? 'small_model_missing'
    : smallWasExpected
      ? (previewFailure ?? (previewStarting ? null : 'preview_sidecar_unavailable'))
      : turboReady ? null : 'turbo_unavailable'
  return {
    requested,
    effectiveModel: turboReady ? 'large-v3-turbo' : selected,
    ready: turboReady,
    backend: turboReady ? 'whisper-server' : null,
    degraded: smallWasExpected,
    reason,
    committedModel: 'large-v3-turbo',
  }
}

async function endpointReady(path: '/health' | '/inference', init?: RequestInit, timeoutMs = 1_000): Promise<Response> {
  return fetch(`${PREVIEW_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

/** Start the optional small.en preview worker. Failure is cosmetic: committed
 * Turbo and every recovery/finalization path stay untouched. */
export async function startWhisperPreviewServer(): Promise<void> {
  const requested = requestedPreviewModel()
  if (selectedPreviewModel(requested) !== 'small.en' || previewProcess || previewAvailable || previewStarting) return
  if (!existsSync(WHISPER_SMALL_EN_MODEL_PATH)) {
    previewFailure = 'small_model_missing'
    return
  }
  if (!existsSync(WHISPER_SERVER)) {
    previewFailure = 'preview_binary_missing'
    return
  }

  previewStarting = true
  previewFailure = null
  try {
    try {
      const occupied = await endpointReady('/health')
      if (occupied.ok) {
        previewFailure = 'preview_port_busy'
        return
      }
    } catch { /* clear port is expected */ }

    const args = [
      '-m', WHISPER_SMALL_EN_MODEL_PATH,
      '-t', '16',
      '-l', 'en',
      '-fa',
      '--no-speech-thold', '0.7',
      '--host', '127.0.0.1',
      '--port', String(PREVIEW_PORT),
    ]
    if (VAD_ENABLED && existsSync(VAD_MODEL_PATH)) {
      args.push('--vad', '--vad-model', VAD_MODEL_PATH)
    }
    const child = spawn(WHISPER_SERVER, args, { stdio: 'ignore', detached: false })
    previewProcess = child
    child.once('close', code => {
      if (previewProcess !== child) return
      previewProcess = null
      previewAvailable = false
      previewFailure = code === 0 ? 'preview_sidecar_unavailable' : 'preview_start_failed'
    })
    child.once('error', () => {
      previewAvailable = false
      previewFailure = 'preview_start_failed'
    })

    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break
      try {
        const response = await endpointReady('/health', undefined, 1_000)
        if (response.ok) {
          previewAvailable = true
          previewFailure = null
          console.log('[whisper-preview] small.en ready for provisional text; committed text remains Turbo')
          return
        }
      } catch { /* model still loading */ }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    try { child.kill('SIGKILL') } catch { /* already exited */ }
    if (previewProcess === child) previewProcess = null
    previewFailure = 'preview_start_failed'
  } finally {
    previewStarting = false
  }
}

export function stopWhisperPreviewServer(): void {
  const child = previewProcess
  previewProcess = null
  previewAvailable = false
  previewStarting = false
  if (child) {
    try { child.kill('SIGTERM') } catch { /* already exited */ }
  }
}

function previewPrompt(): string {
  const vocabulary = getVocabulary()
  return vocabulary.length > 0
    ? [getOwnerName(), ...vocabulary].join(', ')
    : `${getOwnerName()}. COS Glasses. Even G2.`
}

async function transcribeViaPreviewServer(audioBuffer: Buffer): Promise<string> {
  const formData = new FormData()
  formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/wav' }), 'recording.wav')
  formData.append('response_format', 'json')
  formData.append('prompt', previewPrompt())
  formData.append('suppress_non_speech', 'true')
  const response = await endpointReady('/inference', { method: 'POST', body: formData }, 5_000)
  if (!response.ok) throw new Error(`preview server ${response.status}`)
  const result = await response.json() as { text?: unknown }
  if (typeof result.text !== 'string') throw new Error('preview server returned invalid text')
  return applyCorrections(result.text.trim())
}

/** Cosmetic preview only. A small-worker failure falls through to the existing
 * non-circuit Turbo decode and can never write committed transcript state. */
export async function transcribeWhisperPreview(audioBuffer: Buffer): Promise<{
  text: string
  model: 'small.en' | 'large-v3-turbo'
  backend: 'whisper-preview-server' | 'whisper-server'
}> {
  if (previewAvailable) {
    try {
      return { text: await transcribeViaPreviewServer(audioBuffer), model: 'small.en', backend: 'whisper-preview-server' }
    } catch (error) {
      previewAvailable = false
      previewFailure = 'preview_sidecar_unavailable'
      console.warn(`[whisper-preview] small.en preview failed; falling back to Turbo: ${error instanceof Error ? error.message : error}`)
    }
  }
  const result = await transcribeLocal(audioBuffer, undefined, undefined, { affectsCircuit: false })
  return { text: result.text, model: 'large-v3-turbo', backend: 'whisper-server' }
}
