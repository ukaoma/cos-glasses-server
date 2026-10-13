// Where the STT settings meet the decoders (6.72.0): what this Mac can run,
// the live quiet gate and ASR front end, and the meeting preview dispatch.

import { existsSync } from 'node:fs'
import { enhanceAudio } from './audio-enhance.js'
import {
  applyCorrections,
  getHighQualityTranscriptionCapability,
  getWhisperCommitCapability,
  transcribeLocal,
  WHISPER_TURBO_MODEL_PATH,
} from './whisper-local.js'
import { transcribeWhisperMeetingPreview } from './whisper-preview.js'
import { MetalPreviewContendedError } from './whisper-metal-gate.js'
import {
  getInstallProgress, parakeetInstalled, parakeetInstallRunning, parakeetWarmState,
  PARAKEET_VERSION_LABEL, transcribeParakeet, warmParakeet, type ParakeetModelId,
} from './parakeet.js'
import {
  effectiveStt, readSttSettings, type EffectiveStt, type ParakeetStatus,
  type SttCapabilities,
} from './stt-settings.js'

/** The live preview's Parakeet model. v2 over Ultra on the live-lane evidence (docs/stt-672-evaluation.md). */
export const PREVIEW_PARAKEET_MODEL: ParakeetModelId = 'parakeet-v2'
/** Above this a preview is late enough to be useless; the request is a miss. */
export const PARAKEET_PREVIEW_TIMEOUT_MS = 1_500

export function currentSttCapabilities(): SttCapabilities {
  const commit = getWhisperCommitCapability()
  const hq = getHighQualityTranscriptionCapability()
  const installed = parakeetInstalled().installed
  const warm = parakeetWarmState(PREVIEW_PARAKEET_MODEL).state
  return {
    turboModel: existsSync(WHISPER_TURBO_MODEL_PATH),
    liveLargeV3: commit.effectiveModel === 'large-v3',
    hqLargeV3: hq.hqAvailable && hq.model === 'large-v3',
    parakeetInstalled: installed,
    parakeetPreviewWarm: installed && warm === 'warm',
    parakeetPreviewWarming: installed && warm === 'warming',
    previewDisabledByEnv: process.env.COS_WHISPER_MEETING_PREVIEW === '0',
  }
}

export function currentEffectiveStt(): EffectiveStt {
  return effectiveStt(readSttSettings(), currentSttCapabilities())
}

export function parakeetStatus(recordingLive: boolean): ParakeetStatus {
  const installed = parakeetInstalled()
  const progress = getInstallProgress()
  const running = parakeetInstallRunning()
  const sandbox = existsSync('/usr/bin/sandbox-exec')
  const installable = !installed.installed && !running && sandbox && process.platform === 'darwin' && process.arch === 'arm64'
  const warm = parakeetWarmState(PREVIEW_PARAKEET_MODEL)
  const note = installed.installed
    ? 'Installed. Runs offline on the Neural Engine.'
    : running
      ? 'Installing.'
      : !sandbox || process.platform !== 'darwin' || process.arch !== 'arm64'
        ? 'Parakeet needs an Apple silicon Mac.'
        : recordingLive
          ? 'Install after the live recording is saved.'
          : 'About 1.1 GB. Installs the pinned models and checks every file.'
  return {
    installed: installed.installed,
    installable,
    version: PARAKEET_VERSION_LABEL,
    bytes: installed.installed ? installed.bytes : progress.bytesDone,
    progress: { ...progress, state: installed.installed && !running ? 'installed' : progress.state },
    warm: { preview: warm.state },
    note,
  }
}

/** Start warming the preview model when it is selected; never awaited by a chunk. */
export function ensurePreviewWarm(): void {
  const settings = readSttSettings()
  if (settings.preview !== 'parakeet' || !parakeetInstalled().installed) return
  const state = parakeetWarmState(PREVIEW_PARAKEET_MODEL).state
  // A failed warm-up is retried at most every 2 minutes, never per chunk.
  if (state === 'warm' || state === 'warming') return
  if (state === 'failed' && Date.now() - parakeetWarmState(PREVIEW_PARAKEET_MODEL).at < 120_000) return
  void warmParakeet(PREVIEW_PARAKEET_MODEL).then(ok => {
    console.log(`[stt] Parakeet preview ${ok ? 'warm' : 'not warm'}: ${JSON.stringify(parakeetWarmState(PREVIEW_PARAKEET_MODEL))}`)
  })
}

// ── Meeting preview ──────────────────────────────────────────────────────────

export interface PreviewResult {
  text: string
  model: string
  backend: string
}

export interface PreviewDeps {
  effective: () => EffectiveStt
  turbo: (audio: Buffer) => Promise<{ text: string; model: string; backend: string } | null>
  largeV3: (audio: Buffer) => Promise<{ text: string } | null>
  parakeet: (audio: Buffer) => Promise<{ text: string } | null>
  frontEnd: (audio: Buffer) => Promise<Buffer>
}

const defaultPreviewDeps: PreviewDeps = {
  effective: () => currentEffectiveStt(),
  turbo: audio => transcribeWhisperMeetingPreview(audio),
  largeV3: async audio => {
    try {
      const result = await transcribeLocal(audio, undefined, undefined, { affectsCircuit: false, promptPolicy: 'none', metalPriority: 'preview' })
      return { text: result.text }
    } catch (error) {
      if (error instanceof MetalPreviewContendedError) return null
      throw error
    }
  },
  parakeet: async audio => {
    const result = await transcribeParakeet(audio, { model: PREVIEW_PARAKEET_MODEL, lane: 'preview', timeoutMs: PARAKEET_PREVIEW_TIMEOUT_MS })
    return { text: applyCorrections(result.text) }
  },
  // Every preview engine hears the highpass front end. The full chain is never
  // applied to a cosmetic preview (it lifts background speech and costs time).
  frontEnd: audio => enhanceAudio(audio, { profile: 'light' }),
}

/**
 * Cosmetic preview for the still-open phrase. Never durable, never attributed.
 * A failure of the chosen engine falls back to Turbo for this request; null is
 * a quiet miss (the caller answers 204).
 */
export async function transcribeMeetingPreview(audio: Buffer, deps: PreviewDeps = defaultPreviewDeps): Promise<PreviewResult | null> {
  let eff: EffectiveStt | null = null
  try { eff = deps.effective() } catch (error) {
    console.warn(`[stt] preview settings unreadable, using Turbo: ${error instanceof Error ? error.message : error}`)
  }
  if (!eff) {
    const t = await deps.turbo(await deps.frontEnd(audio))
    return t ? { text: t.text, model: t.model, backend: t.backend } : null
  }
  if (eff.settings.preview === 'parakeet' && eff.preview.engine !== 'parakeet') ensurePreviewWarm()
  const input = await deps.frontEnd(audio)
  if (eff.preview.engine === 'parakeet') {
    try {
      const r = await deps.parakeet(input)
      if (r) return { text: r.text, model: PREVIEW_PARAKEET_MODEL, backend: 'fluidaudio-coreml' }
    } catch (error) {
      console.warn(`[stt] Parakeet preview missed, using Turbo: ${error instanceof Error ? error.message : error}`)
    }
  } else if (eff.preview.engine === 'large-v3') {
    try {
      const r = await deps.largeV3(input)
      return r ? { text: r.text, model: 'large-v3', backend: 'whisper-server' } : null
    } catch (error) {
      console.warn(`[stt] Large-v3 preview missed, using Turbo: ${error instanceof Error ? error.message : error}`)
    }
  }
  const t = await deps.turbo(input)
  return t ? { text: t.text, model: t.model, backend: t.backend } : null
}
