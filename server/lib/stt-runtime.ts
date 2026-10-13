// Where the STT settings meet the decoders (6.72.0): what this Mac can run,
// the live quiet gate and ASR front end, and the meeting preview dispatch.

import { existsSync } from 'node:fs'
import {
  applyCorrections,
  getHighQualityTranscriptionCapability,
  getWhisperCommitCapability,
  WHISPER_TURBO_MODEL_PATH,
} from './whisper-local.js'
import { transcribeWhisperMeetingPreview } from './whisper-preview.js'
import { asrFrontEnd } from './stt-live.js'
import {
  getInstallProgress, parakeetInstalled, parakeetInstallRunning, parakeetWarmState, pinnedCliKnown,
  PARAKEET_VERSION_LABEL, transcribeParakeet, warmParakeet, type ParakeetModelId,
} from './parakeet.js'
import {
  effectiveStt, readSttSettings, type EffectiveStt, type FrontEndId, type ParakeetStatus,
  type SttCapabilities,
} from './stt-settings.js'

/** The live preview's Parakeet model. Ultra over v2 on the live-lane evidence
 *  (docs/stt-672-evaluation.md): lower WER, and v2 put text on 3 of 40 clean
 *  non-speech units where Ultra put none. */
export const PREVIEW_PARAKEET_MODEL: ParakeetModelId = 'parakeet-ultra'
/** The phone gives a preview 1.8 s end to end. Parakeet gets this long... */
export const PARAKEET_PREVIEW_TIMEOUT_MS = 900
/** ...and a miss falls back to Turbo only while this much of the budget is left unused. */
export const PREVIEW_TURBO_FALLBACK_BEFORE_MS = 900
/** Consecutive Parakeet preview misses (not busy lanes) that open the breaker. */
export const PREVIEW_BREAKER_MISSES = 3
export const PREVIEW_BREAKER_BASE_MS = 60_000
export const PREVIEW_BREAKER_MAX_MS = 10 * 60_000

// ── Recording probe (registered by the server; avoids an import cycle) ───────
let recordingLiveProbe: () => boolean = () => false
export function setRecordingLiveProbe(probe: () => boolean): void { recordingLiveProbe = probe }
function recordingLive(): boolean { try { return recordingLiveProbe() } catch { return true } }

// ── Preview breaker and counters ─────────────────────────────────────────────
const previewStats = { parakeet: 0, parakeetMisses: 0, turboFallbacks: 0, turbo: 0, nonTurboWithheld: 0, empty: 0 }
let breaker = { misses: 0, openUntil: 0, backoffMs: PREVIEW_BREAKER_BASE_MS }

export function previewBreakerState(now = Date.now()): { open: boolean; retryAt: string | null; misses: number } {
  const open = now < breaker.openUntil
  return { open, retryAt: open ? new Date(breaker.openUntil).toISOString() : null, misses: breaker.misses }
}
export function previewCounters(): typeof previewStats { return { ...previewStats } }

function notePreviewMiss(now = Date.now()): void {
  previewStats.parakeetMisses++
  breaker.misses++
  if (breaker.misses >= PREVIEW_BREAKER_MISSES) {
    breaker.openUntil = now + breaker.backoffMs
    console.warn(`[stt] Parakeet preview missed ${breaker.misses} in a row; Turbo previews for ${Math.round(breaker.backoffMs / 1000)} s`)
    breaker.backoffMs = Math.min(breaker.backoffMs * 2, PREVIEW_BREAKER_MAX_MS)
    breaker.misses = 0
  }
}
function notePreviewHit(): void { breaker = { misses: 0, openUntil: 0, backoffMs: PREVIEW_BREAKER_BASE_MS } }

export function __resetPreviewForTests(): void {
  for (const k of Object.keys(previewStats) as Array<keyof typeof previewStats>) previewStats[k] = 0
  breaker = { misses: 0, openUntil: 0, backoffMs: PREVIEW_BREAKER_BASE_MS }
  recordingLiveProbe = () => false
}

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
    parakeetPreviewWarmFailed: installed && warm === 'failed',
    parakeetPreviewBreakerOpen: installed && previewBreakerState().open,
    previewDisabledByEnv: process.env.COS_WHISPER_MEETING_PREVIEW === '0',
  }
}

export function currentEffectiveStt(): EffectiveStt {
  return effectiveStt(readSttSettings(), currentSttCapabilities())
}

export function parakeetStatus(live: boolean): ParakeetStatus {
  const installed = parakeetInstalled()
  const progress = getInstallProgress()
  const running = parakeetInstallRunning()
  const sandbox = existsSync('/usr/bin/sandbox-exec')
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
  // A button that can never succeed is never offered: the pinned CLI must be on this Mac.
  const cli = appleSilicon ? pinnedCliKnown() : false
  const installable = !installed.installed && !running && sandbox && appleSilicon && cli === true
  const warm = parakeetWarmState(PREVIEW_PARAKEET_MODEL)
  const note = installed.installed
    ? 'Installed. Runs offline on the Neural Engine.'
    : running
      ? 'Installing.'
      : !sandbox || !appleSilicon
        ? 'Parakeet needs an Apple silicon Mac.'
        : cli === false
          ? 'Parakeet needs FluidAudio fluidaudiocli 0.17.4 at ~/.cos-glasses/bin (the speaker-separation tool); this Mac does not have that build.'
          : cli === null
            ? 'Checking this Mac for the FluidAudio CLI.'
            : live
              ? 'Install after the live recording is saved.'
              : 'About 1.1 GB. Installs the pinned models and checks every file.'
  return {
    installed: installed.installed,
    installable,
    version: PARAKEET_VERSION_LABEL,
    bytes: installed.installed ? installed.bytes : progress.bytesDone,
    progress: { ...progress, state: installed.installed && !running ? 'installed' : progress.state },
    warm: { preview: warm.state, ...(warm.error ? { error: warm.error } : {}), ...(warm.at ? { at: new Date(warm.at).toISOString() } : {}) },
    preview: { breaker: previewBreakerState(), counters: previewCounters() },
    note,
  }
}

/** A failed warm-up is retried at most this often, never per chunk. */
export const WARM_RETRY_MS = 120_000

/**
 * Start warming the preview model when it is selected; never awaited by a
 * chunk. Deferred while a recording is live (the first CoreML compile is 12 to
 * 25 s of Neural Engine work next to the live diarizer); a timer retries.
 */
export function ensurePreviewWarm(now = Date.now()): 'started' | 'skipped' | 'deferred' {
  const settings = readSttSettings()
  if (settings.preview !== 'parakeet' || !parakeetInstalled().installed) return 'skipped'
  const w = parakeetWarmState(PREVIEW_PARAKEET_MODEL)
  if (w.state === 'warm' || w.state === 'warming') return 'skipped'
  if (w.state === 'failed' && now - w.at < WARM_RETRY_MS) return 'skipped'
  if (recordingLive()) return 'deferred'
  void warmParakeet(PREVIEW_PARAKEET_MODEL).then(ok => {
    console.log(`[stt] Parakeet preview ${ok ? 'warm' : 'not warm'}: ${JSON.stringify(parakeetWarmState(PREVIEW_PARAKEET_MODEL))}`)
  })
  return 'started'
}

let warmTimer: ReturnType<typeof setInterval> | null = null
/** Server start: one try now, then every minute (a no-op unless Parakeet preview is selected and cold). */
export function startPreviewWarmLoop(): void {
  ensurePreviewWarm()
  if (warmTimer) return
  warmTimer = setInterval(() => { try { ensurePreviewWarm() } catch { /* next tick */ } }, 60_000)
  warmTimer.unref?.()
}
export function stopPreviewWarmLoop(): void { if (warmTimer) clearInterval(warmTimer); warmTimer = null }

// ── Meeting preview ──────────────────────────────────────────────────────────

export interface PreviewResult {
  text: string
  model: string
  backend: string
}

export interface PreviewDeps {
  effective: () => EffectiveStt
  turbo: (audio: Buffer) => Promise<{ text: string; model: string; backend: string } | null>
  parakeet: (audio: Buffer) => Promise<{ text: string } | null>
  frontEnd: (audio: Buffer, frontEnd: FrontEndId) => Promise<Buffer>
  now?: () => number
}

const defaultPreviewDeps: PreviewDeps = {
  effective: () => currentEffectiveStt(),
  turbo: audio => transcribeWhisperMeetingPreview(audio),
  parakeet: async audio => {
    const result = await transcribeParakeet(audio, { model: PREVIEW_PARAKEET_MODEL, lane: 'preview', timeoutMs: PARAKEET_PREVIEW_TIMEOUT_MS })
    return { text: applyCorrections(result.text) }
  },
  frontEnd: (audio, fe) => asrFrontEnd(audio, fe),
}

/**
 * Cosmetic preview for the still-open phrase. Never durable, never attributed.
 *
 * `acceptedModels` is what the client says it accepts (`previewModels`). A
 * client that lists nothing (every phone before 6.10.639) gets Whisper Turbo
 * whatever the setting, so a preview it would reject is never sent. A
 * Parakeet miss falls back to Turbo only while the phone's 1.8 s budget allows
 * (PREVIEW_TURBO_FALLBACK_BEFORE_MS); otherwise it is a quiet miss (204).
 * The Parakeet preview hears the selected ASR front end (highpass by default);
 * the Whisper previews keep raw audio, as before 6.72 (highpass measured
 * slightly worse for Turbo).
 */
export async function transcribeMeetingPreview(audio: Buffer, acceptedModels: readonly string[] = [], deps: PreviewDeps = defaultPreviewDeps): Promise<PreviewResult | null> {
  const now = deps.now ?? (() => performance.now())
  const started = now()
  let eff: EffectiveStt | null = null
  try { eff = deps.effective() } catch (error) {
    console.warn(`[stt] preview settings unreadable, using Turbo: ${error instanceof Error ? error.message : error}`)
  }
  const turbo = async () => {
    previewStats.turbo++
    const t = await deps.turbo(audio)
    return t ? { text: t.text, model: t.model, backend: t.backend } : null
  }
  if (!eff) return turbo()
  if (eff.settings.preview === 'parakeet' && eff.preview.engine !== 'parakeet') ensurePreviewWarm()
  if (eff.preview.engine === 'parakeet') {
    if (!acceptedModels.includes(PREVIEW_PARAKEET_MODEL)) {
      previewStats.nonTurboWithheld++
      return turbo()
    }
    try {
      const r = await deps.parakeet(await deps.frontEnd(audio, eff.frontEnd))
      if (r) { notePreviewHit(); previewStats.parakeet++; return { text: r.text, model: PREVIEW_PARAKEET_MODEL, backend: 'fluidaudio-coreml' } }
    } catch (error) {
      const busy = (error as { reason?: string })?.reason === 'busy'
      if (!busy) notePreviewMiss()
      console.warn(`[stt] Parakeet preview missed${busy ? ' (busy)' : ''}: ${error instanceof Error ? error.message : error}`)
    }
    if (now() - started >= PREVIEW_TURBO_FALLBACK_BEFORE_MS) { previewStats.empty++; return null }
    previewStats.turboFallbacks++
  }
  return turbo()
}
