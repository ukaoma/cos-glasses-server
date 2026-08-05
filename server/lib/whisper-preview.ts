// Adaptive provisional transcription:
//   Balanced -> isolated Small.en cosmetic preview + Turbo live commit
//   Max      -> isolated Turbo cosmetic preview + Large-v3 live commit
//   polish   -> Large-v3 save pass (unchanged)

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  applyCorrections,
  getWhisperCommitCapability,
  getWhisperHealth,
  transcribeLocal,
  type WhisperCommitModel,
  type WhisperTranscriptionTier,
} from './whisper-local.js'
import { MetalPreviewContendedError, tryAcquireMetalPreview } from './whisper-metal-gate.js'

export type WhisperPreviewRequest = 'auto' | 'small.en' | 'turbo' | 'off'
export type WhisperPreviewModel = 'small.en' | WhisperCommitModel | null
type WhisperPreviewSidecarModel = 'small.en' | 'large-v3-turbo'
export type WhisperPreviewReason =
  | 'disabled'
  | 'small_model_missing'
  | 'preview_binary_missing'
  | 'preview_port_busy'
  | 'preview_start_failed'
  | 'preview_sidecar_unavailable'
  | 'turbo_unavailable'
  | 'large_v3_model_missing'
  | 'turbo_model_missing'
  | null

export interface WhisperPreviewCapability {
  requested: WhisperPreviewRequest
  effectiveModel: WhisperPreviewModel
  ready: boolean
  backend: 'whisper-preview-server' | 'whisper-server' | null
  degraded: boolean
  reason: WhisperPreviewReason
  previewDegraded: boolean
  commitDegraded: boolean
  commitReason: 'large_v3_model_missing' | 'turbo_model_missing' | null
  committedModel: WhisperCommitModel
  requestedCommitModel: 'turbo' | 'large-v3'
  requestedTier: WhisperTranscriptionTier
  effectiveTier: WhisperTranscriptionTier
  promptPolicy: 'none'
}

const MODEL_DIR = join(process.env.HOME ?? homedir(), '.local/share/whisper-models')
export const WHISPER_SMALL_EN_MODEL_PATH = join(MODEL_DIR, 'ggml-small.en.bin')
const WHISPER_TURBO_MODEL_PATH = join(MODEL_DIR, 'ggml-large-v3-turbo.bin')
const VAD_MODEL_PATH = join(MODEL_DIR, 'ggml-silero-v5.1.2.bin')
const VAD_ENABLED = process.env.COS_WHISPER_VAD !== '0'
const WHISPER_SERVER = ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server']
  .find(existsSync) ?? '/opt/homebrew/bin/whisper-server'
const PREVIEW_PORT = 8177
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`
const PROCESS_PROBE_TIMEOUT_MS = 2_000
const LSOF_BIN = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof'

let previewProcess: ChildProcess | null = null
let previewAvailable = false
let previewStarting = false
let previewFailure: WhisperPreviewReason = null
let previewWorkerModel: WhisperPreviewSidecarModel | null = null
let warnedInvalidChoice = false

interface ProcessEntry {
  pid: number
  ppid: number
  command: string
}

function runProcessProbe(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8', timeout: PROCESS_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
    }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
  })
}

async function previewListeningPids(): Promise<number[]> {
  try {
    const output = await runProcessProbe(LSOF_BIN, ['-nP', `-iTCP:${PREVIEW_PORT}`, '-sTCP:LISTEN', '-t'])
    return output.split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0)
  } catch (error: any) {
    if (error?.code === 1 || error?.status === 1) return []
    throw new Error(`unable to inspect preview port ${PREVIEW_PORT}`)
  }
}

async function listProcesses(): Promise<ProcessEntry[]> {
  const output = await runProcessProbe('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='])
  return output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
}

function isCosPreviewCommand(command: string): boolean {
  const firstToken = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
  const executablePath = firstToken?.[1] ?? firstToken?.[2] ?? firstToken?.[3] ?? ''
  return basename(executablePath) === 'whisper-server'
    && new RegExp(`(?:^|\\s)--port(?:=|\\s+)${PREVIEW_PORT}(?:\\s|$)`).test(command)
    && [WHISPER_SMALL_EN_MODEL_PATH, WHISPER_TURBO_MODEL_PATH]
      .some(modelPath => command.includes(modelPath))
}

/** Reap only a listener proven to be our exact COS preview/8177 command. An
 * unrelated local service is never contacted with audio or terminated. */
async function reclaimPreviewPort(): Promise<'clear' | 'reaped' | 'foreign'> {
  const listeners = await previewListeningPids()
  if (listeners.length === 0) return 'clear'
  const processes = await listProcesses()
  const byPid = new Map(processes.map(entry => [entry.pid, entry]))
  if (!listeners.every(pid => isCosPreviewCommand(byPid.get(pid)?.command ?? ''))) return 'foreign'

  const targets = new Set(listeners)
  let changed = true
  while (changed) {
    changed = false
    for (const entry of processes) {
      if (!targets.has(entry.pid) && targets.has(entry.ppid)) {
        targets.add(entry.pid)
        changed = true
      }
    }
  }
  for (const pid of [...targets].reverse()) {
    try { process.kill(pid, 'SIGKILL') } catch (error: any) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await previewListeningPids()).length === 0) return 'reaped'
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`verified COS preview worker still owns port ${PREVIEW_PORT}`)
}

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
  if (!raw && process.env.COS_WHISPER_TRANSCRIPTION_TIER) {
    return process.env.COS_WHISPER_TRANSCRIPTION_TIER.trim().toLowerCase() === 'max'
      ? 'turbo'
      : 'small.en'
  }
  const normalized = normalizeWhisperPreviewRequest(raw)
  if (raw && normalized === 'auto' && !['auto', 'adaptive'].includes(raw.trim().toLowerCase()) && !warnedInvalidChoice) {
    warnedInvalidChoice = true
    console.warn(`[whisper-preview] Unknown model "${raw}"; using adaptive selection.`)
  }
  return normalized
}

function selectedPreviewModel(requested = requestedPreviewModel()): WhisperPreviewModel {
  if (requested === 'off') return null
  const primary = getWhisperCommitCapability().effectiveModel
  if (requested === 'turbo') {
    return existsSync(WHISPER_TURBO_MODEL_PATH) ? 'large-v3-turbo' : primary
  }
  if (requested === 'small.en') return existsSync(WHISPER_SMALL_EN_MODEL_PATH) ? 'small.en' : primary
  return existsSync(WHISPER_SMALL_EN_MODEL_PATH) ? 'small.en' : primary
}

function sidecarModelPath(model: WhisperPreviewSidecarModel): string {
  return model === 'small.en' ? WHISPER_SMALL_EN_MODEL_PATH : WHISPER_TURBO_MODEL_PATH
}

function needsPreviewSidecar(model: WhisperPreviewModel): model is WhisperPreviewSidecarModel {
  return model !== null && model !== getWhisperCommitCapability().effectiveModel
}

export function getWhisperPreviewCapability(): WhisperPreviewCapability {
  const commit = getWhisperCommitCapability()
  const requested = requestedPreviewModel()
  if (requested === 'off') {
    return {
      requested, effectiveModel: null, ready: false, backend: null,
      degraded: commit.degraded, reason: commit.reason ?? 'disabled',
      previewDegraded: false, commitDegraded: commit.degraded, commitReason: commit.reason,
      committedModel: commit.effectiveModel,
      requestedCommitModel: commit.requestedModel,
      requestedTier: commit.requestedTier, effectiveTier: commit.effectiveTier,
      promptPolicy: 'none',
    }
  }

  const selected = selectedPreviewModel(requested)
  const primaryReady = getWhisperHealth().server
  const sidecarExpected = needsPreviewSidecar(selected)
  if (sidecarExpected && previewAvailable && previewWorkerModel === selected) {
    return {
      requested, effectiveModel: selected, ready: true,
      backend: 'whisper-preview-server', degraded: commit.degraded, reason: commit.reason,
      previewDegraded: false, commitDegraded: commit.degraded, commitReason: commit.reason,
      committedModel: commit.effectiveModel,
      requestedCommitModel: commit.requestedModel,
      requestedTier: commit.requestedTier, effectiveTier: commit.effectiveTier,
      promptPolicy: 'none',
    }
  }

  const selectedModelMissing = requested === 'small.en' && !existsSync(WHISPER_SMALL_EN_MODEL_PATH)
    ? 'small_model_missing'
    : requested === 'turbo' && !existsSync(WHISPER_TURBO_MODEL_PATH)
      ? 'turbo_model_missing'
      : null
  const previewDegraded = sidecarExpected || selectedModelMissing !== null
  const reason: WhisperPreviewReason = commit.reason
    ? commit.reason
    : selectedModelMissing
      ? selectedModelMissing
      : sidecarExpected
      ? (previewFailure ?? (previewStarting ? null : 'preview_sidecar_unavailable'))
      : primaryReady ? null : 'turbo_unavailable'
  return {
    requested,
    effectiveModel: primaryReady ? commit.effectiveModel : selected,
    ready: primaryReady,
    backend: primaryReady ? 'whisper-server' : null,
    degraded: previewDegraded || commit.degraded,
    reason,
    previewDegraded,
    commitDegraded: commit.degraded,
    commitReason: commit.reason,
    committedModel: commit.effectiveModel,
    requestedCommitModel: commit.requestedModel,
    requestedTier: commit.requestedTier,
    effectiveTier: commit.effectiveTier,
    promptPolicy: 'none',
  }
}

async function endpointReady(path: '/health' | '/inference', init?: RequestInit, timeoutMs = 1_000): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
  return fetch(`${PREVIEW_URL}${path}`, { ...init, signal })
}

/** Start the optional isolated preview worker. Balanced uses Small.en; Max
 * uses Turbo while its canonical live worker remains Large-v3. Failure is
 * cosmetic: every recovery/finalization path stays untouched. */
export async function startWhisperPreviewServer(): Promise<void> {
  const requested = requestedPreviewModel()
  const selected = selectedPreviewModel(requested)
  if (!needsPreviewSidecar(selected) || previewProcess || previewAvailable || previewStarting) return
  const modelPath = sidecarModelPath(selected)
  if (!existsSync(modelPath)) {
    previewFailure = selected === 'small.en' ? 'small_model_missing' : 'turbo_model_missing'
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
      const portState = await reclaimPreviewPort()
      if (portState === 'foreign') {
        previewFailure = 'preview_port_busy'
        return
      }
      if (portState === 'reaped') {
        console.log('[whisper-preview] reaped a stale COS preview worker before restart')
      }
    } catch (error) {
      previewFailure = 'preview_start_failed'
      console.warn(`[whisper-preview] port preflight failed: ${error instanceof Error ? error.message : error}`)
      return
    }

    const args = [
      '-m', modelPath,
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
    previewWorkerModel = selected
    child.once('close', code => {
      if (previewProcess !== child) return
      previewProcess = null
      previewAvailable = false
      previewWorkerModel = null
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
          const committed = getWhisperCommitCapability().effectiveModel
          console.log(`[whisper-preview] ${selected} ready for provisional text; committed text remains ${committed}`)
          return
        }
      } catch { /* model still loading */ }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    try { child.kill('SIGKILL') } catch { /* already exited */ }
    if (previewProcess === child) previewProcess = null
    previewWorkerModel = null
    previewFailure = 'preview_start_failed'
  } finally {
    previewStarting = false
  }
}

function waitForPreviewClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (closed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off('close', onClose)
      resolve(closed)
    }
    const onClose = () => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    child.once('close', onClose)
  })
}

export async function stopWhisperPreviewServer(): Promise<void> {
  const child = previewProcess
  previewProcess = null
  previewAvailable = false
  previewStarting = false
  previewWorkerModel = null
  if (child) {
    try { child.kill('SIGTERM') } catch { /* already exited */ }
    if (!await waitForPreviewClose(child, 2_000)) {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      await waitForPreviewClose(child, 1_000)
    }
  }
}

async function transcribeViaPreviewServer(audioBuffer: Buffer, signal: AbortSignal): Promise<string> {
  const formData = new FormData()
  formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/wav' }), 'recording.wav')
  formData.append('response_format', 'json')
  // Preview text is cosmetic and the same audio is authoritatively decoded by
  // the commit lane. Never bias this provisional decode with profile vocabulary.
  formData.append('suppress_non_speech', 'true')
  const response = await endpointReady('/inference', { method: 'POST', body: formData, signal }, 5_000)
  if (!response.ok) throw new Error(`preview server ${response.status}`)
  const result = await response.json() as { text?: unknown }
  if (typeof result.text !== 'string') throw new Error('preview server returned invalid text')
  return applyCorrections(result.text.trim())
}

/** Cosmetic preview only. A sidecar failure falls through to the existing
 * non-circuit canonical decode and can never write committed transcript state. */
export async function transcribeWhisperPreview(audioBuffer: Buffer): Promise<{
  text: string
  model: 'small.en' | WhisperCommitModel
  backend: 'whisper-preview-server' | 'whisper-server'
  }> {
  if (previewAvailable && previewWorkerModel) {
    const workerModel = previewWorkerModel
    const previewLease = tryAcquireMetalPreview()
    if (!previewLease) {
      return { text: '', model: workerModel, backend: 'whisper-preview-server' }
    }
    try {
      return {
        text: await transcribeViaPreviewServer(audioBuffer, previewLease.signal),
        model: workerModel,
        backend: 'whisper-preview-server',
      }
    } catch (error) {
      if (previewLease.signal.aborted) {
        return { text: '', model: workerModel, backend: 'whisper-preview-server' }
      }
      const failedModel = previewWorkerModel
      previewAvailable = false
      previewWorkerModel = null
      previewFailure = 'preview_sidecar_unavailable'
      console.warn(`[whisper-preview] ${failedModel} preview failed; falling back to canonical worker: ${error instanceof Error ? error.message : error}`)
    } finally {
      previewLease.release()
    }
  }
  try {
    const result = await transcribeLocal(audioBuffer, undefined, undefined, {
      affectsCircuit: false,
      promptPolicy: 'none',
      metalPriority: 'preview',
    })
    return { text: result.text, model: getWhisperCommitCapability().effectiveModel, backend: 'whisper-server' }
  } catch (error) {
    if (error instanceof MetalPreviewContendedError) {
      return { text: '', model: getWhisperCommitCapability().effectiveModel, backend: 'whisper-server' }
    }
    throw error
  }
}

/**
 * Meeting-preview canary: use only the isolated Turbo sidecar.
 *
 * Unlike prompt preview, this path never falls through to the canonical
 * Large-v3 worker. A missing, busy, preempted, or failed sidecar is a silent
 * cosmetic miss; durable meeting transcription continues on its unchanged
 * canonical path.
 */
export async function transcribeWhisperMeetingPreview(audioBuffer: Buffer): Promise<{
  text: string
  model: 'large-v3-turbo'
  backend: 'whisper-preview-server'
} | null> {
  if (!previewAvailable || previewWorkerModel !== 'large-v3-turbo') return null
  const previewLease = tryAcquireMetalPreview()
  if (!previewLease) return null
  try {
    return {
      text: await transcribeViaPreviewServer(audioBuffer, previewLease.signal),
      model: 'large-v3-turbo',
      backend: 'whisper-preview-server',
    }
  } catch (error) {
    if (previewLease.signal.aborted) return null
    previewAvailable = false
    previewWorkerModel = null
    previewFailure = 'preview_sidecar_unavailable'
    console.warn(`[whisper-preview] meeting Turbo preview failed; canonical meeting ASR was not affected: ${error instanceof Error ? error.message : error}`)
    return null
  } finally {
    previewLease.release()
  }
}
