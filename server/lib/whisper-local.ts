// Local Whisper transcription via whisper-server (persistent) or whisper-cli (fallback)
// Eliminates 1-3s OpenAI API round-trip by running inference on M3 Ultra locally.
//
// Strategy (fastest → slowest):
//   1. whisper-server (persistent daemon, model in RAM) → ~50-100ms
//   2. whisper-cli (spawned per request, model loaded from disk) → ~500-700ms
//   3. OpenAI API (cloud, handled by transcribe.ts) → ~1000-3000ms

import { spawn, execSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import crypto from 'node:crypto'
import { getVocabulary, getOwnerName } from './profile.js'
import { stripBrandUrls } from './hallucination-filter.js'

// Prompt hardening flags (transcription quality, 2026-05-29):
//   COS_PROMPT_V2 — drop the trailing '.' on the vocab prompt and join prompt+context
//     with a space (not '. ') to reduce the caption-training nudge that turns brand
//     proper-nouns into "www.X.com" on low-confidence/silent audio. DEFAULT OFF
//     (opt-in) — brand WER is unmeasurable without asr-bakeoff fixtures, so flip on
//     and A/B before trusting it. Rollback: unset / COS_PROMPT_V2=0.
//   COS_WHISPER_STRIP_BRAND_URLS — strip brand-vocab URLs from the prior-transcript
//     prompt CONTEXT so an already-emitted hallucination can't self-reinforce via the
//     context feedback loop. DEFAULT ON (context priming only — never mutates output).
const PROMPT_V2 = process.env.COS_PROMPT_V2 === '1'
const STRIP_BRAND_URLS = process.env.COS_WHISPER_STRIP_BRAND_URLS !== '0'

// Word-level timestamp types (from whisper.cpp DTW alignment)
export interface WhisperWord {
  word: string
  start: number   // seconds
  end: number     // seconds
  probability: number
}

export interface WhisperSegment {
  text: string
  start: number
  end: number
  words?: WhisperWord[]
}

interface WhisperVerboseResponse {
  text: string
  segments?: WhisperSegment[]
}

// Resolve whisper.cpp binaries across Homebrew prefixes (Apple Silicon
// /opt/homebrew, Intel /usr/local). Downstream code existsSync-guards these
// before use, so a missing binary degrades to CLI/cloud rather than crashing.
function resolveWhisperBin(name: string): string {
  for (const prefix of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (existsSync(`${prefix}/${name}`)) return `${prefix}/${name}`
  }
  return `/opt/homebrew/bin/${name}`
}
const WHISPER_CLI = resolveWhisperBin('whisper-cli')
const WHISPER_SERVER = resolveWhisperBin('whisper-server')
const MODEL_PATH = join(process.env.HOME ?? homedir(), '.local/share/whisper-models/ggml-large-v3-turbo.bin')

// Post-meeting batch transcription uses the full 32-layer Whisper large-v3
// instead of turbo's 4-layer decoder. Bake-off on 2026-04-16 showed the full
// decoder captures +43% more speech content with zero known-hallucinations on
// a real 23.6 min G2 recording. See wk16_2026/asr-bakeoff/report.md.
//
// Streaming path stays on turbo (whisper-server + VAD) for latency. Only the
// post-meeting HQ re-transcription uses large-v3 — runs fire-and-forget after
// meeting save, so the ~4x wall-time cost is invisible to the user.
//
// DISABLE: set COS_BATCH_LARGE_V3=0 to revert HQ path to turbo. Missing-weights
// case is defensive: if ggml-large-v3.bin isn't on disk we log a warning and
// fall back to turbo automatically — no broken batch runs.
const BATCH_MODEL_LARGE_V3 = join(process.env.HOME ?? homedir(), '.local/share/whisper-models/ggml-large-v3.bin')
const BATCH_MODEL_TURBO = MODEL_PATH
const BATCH_LARGE_V3_ENABLED = process.env.COS_BATCH_LARGE_V3 !== '0'

// Silero VAD (ggml) — whisper-server --vad strips silence/noise windows BEFORE the
// decoder runs, eliminating the #1 turbo hallucination trigger (empty-audio chunks
// generating "*sad music*", "thanks for watching", etc.). See openai/whisper#2281
// and whisper.cpp PR 2524. Model downloaded to ~/.local/share/whisper-models/ from
// huggingface.co/ggml-org/whisper-vad.
//
// DISABLE: set COS_WHISPER_VAD=0 to revert to the pre-2026-04-16 behaviour. If VAD
// regresses (e.g. trims quiet speakers on Zoom-through-laptop-mic), that env var
// lets the user fall back fast without a redeploy.
const VAD_MODEL_PATH = join(process.env.HOME ?? homedir(), '.local/share/whisper-models/ggml-silero-v5.1.2.bin')
const VAD_ENABLED = process.env.COS_WHISPER_VAD !== '0'

/** Pick the batch model path. Prefer large-v3 when enabled + on disk; fall
 *  back to turbo otherwise. Logged once per process so we know which decoder
 *  actually ran when reviewing a meeting later. */
let _batchModelResolved: string | null = null
function resolveBatchModel(): string {
  if (_batchModelResolved) return _batchModelResolved
  if (BATCH_LARGE_V3_ENABLED && existsSync(BATCH_MODEL_LARGE_V3)) {
    console.log(`[whisper-local] batch HQ model: ggml-large-v3.bin (full 32-layer decoder)`)
    _batchModelResolved = BATCH_MODEL_LARGE_V3
  } else if (BATCH_LARGE_V3_ENABLED) {
    console.warn(
      `[whisper-local] COS_BATCH_LARGE_V3=1 but weights missing at ${BATCH_MODEL_LARGE_V3}. ` +
      `Batch HQ falling back to turbo. Download: curl -L -o "${BATCH_MODEL_LARGE_V3}" ` +
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin`,
    )
    _batchModelResolved = BATCH_MODEL_TURBO
  } else {
    console.log('[whisper-local] batch HQ model: ggml-large-v3-turbo.bin (COS_BATCH_LARGE_V3=0)')
    _batchModelResolved = BATCH_MODEL_TURBO
  }
  return _batchModelResolved
}

// Domain vocabulary prompt — biases Whisper decoder toward proper nouns it would otherwise garble.
// People names are the biggest win (an unusual surname otherwise transcribed as a common soundalike).
// Loaded from .cos-profile.json vocabulary array, with generic fallback.
function buildWhisperPrompt(): string {
  const vocab = getVocabulary()
  const ownerName = getOwnerName()

  if (vocab.length > 0) {
    // User-configured vocabulary — names, products, acronyms from profile.
    // V2 drops the trailing '.' (sentence-boundary token nudges ".com" completions).
    return [ownerName, ...vocab].join(', ') + (PROMPT_V2 ? '' : '.')
  }

  // Generic fallback — no personal names, just product/format hints
  return `${ownerName}. COS Glasses. Even G2.`
}

// Lazy-cache the prompt (profile is read once and cached in profile.ts)
let _whisperPrompt: string | null = null
function getWhisperPrompt(): string {
  if (!_whisperPrompt) _whisperPrompt = buildWhisperPrompt()
  return _whisperPrompt
}

// whisper-server runs on this port (started at server boot or by LaunchAgent)
const WHISPER_SERVER_PORT = 8178
const WHISPER_SERVER_URL = `http://127.0.0.1:${WHISPER_SERVER_PORT}`

// Track which backends are available
let cliAvailable = false
let serverAvailable = false
let serverProcess: ReturnType<typeof spawn> | null = null

// Circuit breaker: track consecutive server failures to detect hung process
let serverConsecutiveFailures = 0
const SERVER_FAILURE_THRESHOLD = 3   // After 3 consecutive failures, auto-restart
let serverRestarting = false          // Prevents concurrent restart attempts
let serverStarting = false            // Initial model load is not a circuit failure
let serverHealthProbe: Promise<boolean> | null = null

// Check CLI availability at import time
try {
  cliAvailable = existsSync(WHISPER_CLI) && existsSync(MODEL_PATH)
  if (cliAvailable) {
    console.log(`[whisper-local] whisper-cli available at ${WHISPER_CLI}`)
  }
} catch {
  // ignore
}

/**
 * Start whisper-server as a child process (model stays loaded in RAM).
 * Called from index.ts at server boot. Non-blocking.
 */
export async function startWhisperServer(): Promise<void> {
  if (serverStarting) return
  serverStarting = true
  try {
    await startWhisperServerAttempt()
  } finally {
    serverStarting = false
  }
}

async function startWhisperServerAttempt(): Promise<void> {
  if (!existsSync(WHISPER_SERVER) || !existsSync(MODEL_PATH)) {
    console.log('[whisper-local] whisper-server or model not found — using CLI fallback')
    return
  }

  // Check if already running
  try {
    const res = await fetch(`${WHISPER_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) })
    if (res.ok) {
      serverAvailable = true
      console.log('[whisper-local] whisper-server already running on port', WHISPER_SERVER_PORT)
      return
    }
  } catch {
    // Not running — kill any zombie processes before starting fresh
    try {
      execSync('pkill -9 -f "whisper-server"', { stdio: 'ignore' })
      console.log('[whisper-local] Killed stale whisper-server processes')
    } catch { /* none running */ }

    // Wait for port to actually clear (up to 5s)
    for (let i = 0; i < 10; i++) {
      try {
        execSync('lsof -i :8178 -t', { stdio: 'ignore' })
        await new Promise(r => setTimeout(r, 500))
      } catch {
        break // Port clear
      }
    }
  }

  // Assemble startup args. VAD only attaches if the ggml model is actually on
  // disk — missing-file is logged, not fatal (server still boots without VAD).
  const serverArgs = [
    '-m', MODEL_PATH,
    '-t', '16',           // M3 Ultra has 24P+8E cores — 16 threads for short audio chunks
    '-l', 'en',
    '-fa',                // Flash attention — faster self-attention on Apple Silicon
    '--no-speech-thold', '0.7',  // Reject silence more aggressively (default 0.6)
    // DTW removed: 'large-v3-turbo' not a valid preset, crashes server (exit 3)
    // Also incompatible with -fa (flash attention). Revisit word timestamps separately.
    '--host', '127.0.0.1',
    '--port', String(WHISPER_SERVER_PORT),
  ]

  if (VAD_ENABLED && existsSync(VAD_MODEL_PATH)) {
    // Silero VAD pre-filters silent/non-speech windows. Defaults are sane for
    // meeting audio: threshold 0.5, min-speech 250ms, min-silence 100ms. Revisit
    // if Phase 0 measurement shows VAD clipping real speech from quiet speakers.
    serverArgs.push('--vad', '--vad-model', VAD_MODEL_PATH)
    console.log(`[whisper-local] VAD enabled — using ${VAD_MODEL_PATH}`)
  } else if (VAD_ENABLED) {
    console.warn(
      `[whisper-local] VAD requested (COS_WHISPER_VAD != 0) but model missing at ${VAD_MODEL_PATH}. ` +
      `Download: curl -L -o "${VAD_MODEL_PATH}" https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin`,
    )
  } else {
    console.log('[whisper-local] VAD disabled via COS_WHISPER_VAD=0')
  }

  console.log('[whisper-local] Starting whisper-server...')

  serverProcess = spawn(WHISPER_SERVER, serverArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,  // Dies with parent
  })

  // Wait for server to be ready — poll /health every 2s (large models take ~20s to load)
  return new Promise<void>((resolve) => {
    const maxWaitMs = 45_000
    const pollIntervalMs = 2_000
    const startTime = Date.now()

    const pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${WHISPER_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) {
          clearInterval(pollTimer)
          serverAvailable = true
          const loadTime = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`[whisper-local] whisper-server ready on port ${WHISPER_SERVER_PORT} (loaded in ${loadTime}s)`)
          resolve()
        }
      } catch {
        // Not ready yet — keep polling
        if (Date.now() - startTime > maxWaitMs) {
          clearInterval(pollTimer)
          console.warn(`[whisper-local] whisper-server startup timeout (${maxWaitMs / 1000}s) — using CLI fallback`)
          resolve()
        }
      }
    }, pollIntervalMs)

    serverProcess!.on('error', (err) => {
      clearInterval(pollTimer)
      console.error('[whisper-local] whisper-server failed to start:', err.message)
      resolve()
    })

    serverProcess!.on('close', (code) => {
      serverAvailable = false
      serverProcess = null
      if (code !== null && code !== 0) {
        console.warn(`[whisper-local] whisper-server exited with code ${code}`)
      }
    })
  })
}

/**
 * Gracefully stop whisper-server (called on process exit).
 */
export function stopWhisperServer(): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    serverProcess = null
    serverAvailable = false
    console.log('[whisper-local] whisper-server stopped')
  }
}

export function isWhisperLocalAvailable(): boolean {
  // Only advertise server for real-time callers. CLI is reserved for batch
  // (transcribeHighQuality) because cold-loading the model from disk takes ~11s,
  // which is worse than OpenAI cloud (1-3s). When server is down, callers should
  // go straight to cloud without the overhead of entering transcribeLocal → throw.
  return serverAvailable
}

export function getWhisperBackend(): 'server' | 'cli' | 'none' {
  if (serverAvailable) return 'server'
  if (cliAvailable) return 'cli'
  return 'none'
}

/** Detailed health status for diagnostics (/api/health) */
export function getWhisperHealth(): {
  server: boolean
  cli: boolean
  consecutiveFailures: number
  restarting: boolean
  circuitOpen: boolean
} {
  return {
    server: serverAvailable,
    cli: cliAvailable,
    consecutiveFailures: serverConsecutiveFailures,
    restarting: serverRestarting || serverStarting,
    circuitOpen: serverConsecutiveFailures >= SERVER_FAILURE_THRESHOLD,
  }
}

/**
 * Reconcile a cached unavailable flag with the daemon's live health endpoint.
 * Only successful inference resets the failure count: /health can be responsive
 * while the model worker is still hung, and that case must retain the existing
 * three-strike controlled restart.
 */
async function reconcileWhisperServerHealth(): Promise<boolean> {
  if (serverAvailable) return true
  if (serverRestarting || serverStarting) return false
  if (serverHealthProbe) return serverHealthProbe

  serverHealthProbe = (async () => {
    try {
      const res = await fetch(`${WHISPER_SERVER_URL}/health`, { signal: AbortSignal.timeout(1_000) })
      if (!res.ok) return false
      serverAvailable = true
      console.log(`[whisper-local] Health endpoint recovered; retrying inference after ${serverConsecutiveFailures} failure(s)`)
      return true
    } catch {
      return false
    }
  })().finally(() => {
    serverHealthProbe = null
  })

  return serverHealthProbe
}

/**
 * High-quality transcription for batch/post-meeting use.
 * Uses the full Whisper large-v3 (32-layer) decoder + Silero VAD + beam search.
 * Per 2026-04-16 bake-off: +43% speech capture vs turbo on real G2 audio.
 * Falls back to turbo weights if large-v3 not on disk or COS_BATCH_LARGE_V3=0.
 * Falls back to transcribeLocal if whisper-cli unavailable entirely.
 */
export async function transcribeHighQuality(audioBuffer: Buffer, context?: string): Promise<{ text: string; words?: WhisperWord[] }> {
  if (!cliAvailable) {
    // Fall back to server (no beam search available via HTTP API)
    return transcribeLocal(audioBuffer, context)
  }

  const start = Date.now()
  const id = crypto.randomUUID().slice(0, 8)
  const tmpWav = join('/tmp', `cos-whisper-hq-${id}.wav`)

  const modelPath = resolveBatchModel()
  const useLargeV3 = modelPath === BATCH_MODEL_LARGE_V3
  const useVad = VAD_ENABLED && existsSync(VAD_MODEL_PATH)

  try {
    writeFileSync(tmpWav, audioBuffer)

    const text = await new Promise<string>((resolve, reject) => {
      const args = [
        '-m', modelPath,
        '-f', tmpWav,
        '-t', '16',           // Use more threads for batch (no real-time pressure)
        '-l', 'en',
        '-fa',                // Flash attention — Metal win, same flag streaming uses
        '-bs', '5',           // Beam search width 5 (default disabled)
        '-bo', '5',           // Best-of-5 candidates (default 2)
        '--no-timestamps',
        '-np',
        '--prompt', buildPrompt(context),
      ]
      if (useVad) {
        // Same VAD model the streaming path uses. Strips silence windows
        // before the decoder sees them — prevents the silence-hallucination
        // failure mode even with large-v3's more permissive decoder.
        args.push('--vad', '--vad-model', VAD_MODEL_PATH)
      }
      const proc = spawn(WHISPER_CLI, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      // Timeout scaled to decoder complexity: large-v3 is ~4x slower than
      // turbo per bake-off (0.084x vs 0.024x RTF). 30-40s segments × 4x
      // multiplier × beam-search overhead = ~240s safety ceiling for HQ.
      // Turbo retains the old 60s ceiling.
      const timeoutMs = useLargeV3 ? 240_000 : 60_000
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error(`whisper-cli HQ timeout (${timeoutMs / 1000}s, model=${useLargeV3 ? 'large-v3' : 'turbo'})`))
      }, timeoutMs)

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`whisper-cli HQ exit ${code}: ${stderr.trim().slice(0, 200)}`))
          return
        }
        resolve(stdout.trim())
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`whisper-cli HQ spawn error: ${err.message}`))
      })
    })

    const corrected = applyCorrections(text)
    const elapsed = Date.now() - start
    const modelTag = useLargeV3 ? 'large-v3' : 'turbo'
    console.log(`[whisper-hq] Batch transcribed in ${elapsed}ms (${modelTag}${useVad ? '+vad' : ''}): "${corrected.slice(0, 80)}${corrected.length > 80 ? '...' : ''}"`)
    return { text: corrected }
  } finally {
    try { unlinkSync(tmpWav) } catch { /* cleanup */ }
  }
}

/** Build prompt with optional previous transcript context for continuity */
function buildPrompt(context?: string, isQuiet?: boolean): string {
  // During quiet/silence audio, skip vocabulary prompt to reduce decoder bias
  if (isQuiet) return ''
  if (!context || context.length < 10) return getWhisperPrompt()
  // Belt-and-suspenders: strip caption-training-artifact tokens from context
  // before feeding to whisper-server. Primary filter is in transcribe-stream.ts;
  // this catches anything that slipped through (e.g., batch re-transcription path).
  let sanitized = context
    .replace(/[*\[(♪][^*\])♪\n]{1,40}[*\])♪]/g, '')  // *music*, [applause], (laughter), ♪ ♪
    .replace(/\s{2,}/g, ' ')
    .trim()
  // Break the self-reinforcing loop: a brand-URL hallucination that landed in a
  // prior chunk would otherwise feed back through this context and re-seed the
  // next decode. Strip brand URLs from the priming context (output unaffected).
  if (STRIP_BRAND_URLS) sanitized = stripBrandUrls(sanitized)
  // Previous transcript helps Whisper maintain proper noun consistency,
  // continue sentences across chunk boundaries, and reduce hallucinations
  return PROMPT_V2 ? `${getWhisperPrompt()} ${sanitized}` : `${getWhisperPrompt()}. ${sanitized}`
}

/**
 * Transcribe via whisper-server (persistent daemon, ~50-100ms).
 * Returns text + optional word-level timestamps from DTW alignment.
 */
async function transcribeViaServer(audioBuffer: Buffer, context?: string, isQuiet?: boolean): Promise<{ text: string; words?: WhisperWord[] }> {
  const formData = new FormData()
  // Convert Buffer to Uint8Array to satisfy Blob's BlobPart type constraint
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/wav' })
  formData.append('file', blob, 'recording.wav')
  formData.append('response_format', 'verbose_json')  // includes segments[].words[] with DTW
  formData.append('prompt', buildPrompt(context, isQuiet))
  // Anti-hallucination handled by client-side filter + context filtering.
  // Whisper-level entropy/logprob thresholds were too aggressive — silently dropped
  // legitimate speech from quiet sources (laptop speakers through G2 mic).
  formData.append('suppress_non_speech', 'true')  // Suppress special/non-speech tokens (benign)

  const response = await fetch(`${WHISPER_SERVER_URL}/inference`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`whisper-server ${response.status}: ${await response.text()}`)
  }

  const result = await response.json() as WhisperVerboseResponse
  const text = result.text?.trim() || ''

  // Extract word-level timestamps from DTW-aligned segments (defensive — may be absent)
  let words: WhisperWord[] | undefined
  if (result.segments && result.segments.length > 0) {
    const extracted = result.segments.flatMap(s => {
      if (!s.words || !Array.isArray(s.words)) return []
      return s.words.filter(w => typeof w.start === 'number' && typeof w.end === 'number')
    })
    if (extracted.length > 0) words = extracted
  }

  return { text, words }
}

/**
 * Transcribe via whisper-cli (spawned per request, ~500-700ms).
 */
async function transcribeViaCLI(audioBuffer: Buffer, context?: string, isQuiet?: boolean): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8)
  const tmpWav = join('/tmp', `cos-whisper-${id}.wav`)

  try {
    writeFileSync(tmpWav, audioBuffer)

    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(WHISPER_CLI, [
        '-m', MODEL_PATH,
        '-f', tmpWav,
        '-t', '12',
        '-l', 'en',
        '-fa',
        '--no-timestamps',
        '-np',
        '--prompt', buildPrompt(context, isQuiet),
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error('whisper-cli timeout (20s)'))
      }, 20_000)

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`whisper-cli exit ${code}: ${stderr.trim().slice(0, 200)}`))
          return
        }
        const cleaned = stdout.trim()
        if (!cleaned) {
          reject(new Error('whisper-cli returned empty output'))
          return
        }
        resolve(cleaned)
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`whisper-cli spawn error: ${err.message}`))
      })
    })
  } finally {
    try { unlinkSync(tmpWav) } catch { /* ignore */ }
  }
}

// Post-processing correction dictionary — deterministic fixes for names Whisper garbles.
// Prompt biasing is probabilistic; regex replacement is guaranteed.
// User-specific corrections loaded from .cos-profile.json "whisper_corrections" field.
import { loadProfileField } from './profile.js'

function buildCorrections(): Array<[RegExp, string]> {
  const corrections: Array<[RegExp, string]> = []

  // Load user-configured corrections from profile
  // Format: { "whisper_corrections": { "Soundalike": "YourName", ... } }
  try {
    const raw = loadProfileField('whisper_corrections', '')
    if (raw) {
      const map = JSON.parse(raw) as Record<string, string>
      for (const [pattern, replacement] of Object.entries(map)) {
        corrections.push([new RegExp(`\\b${pattern}\\b`, 'gi'), replacement])
      }
    }
  } catch { /* invalid JSON — skip */ }

  return corrections
}

let _corrections: Array<[RegExp, string]> | null = null
function getCorrections(): Array<[RegExp, string]> {
  if (!_corrections) _corrections = buildCorrections()
  return _corrections
}

// Exported so non-live surfaces (outbound dictation finalize) can apply the
// same deterministic name corrections. On the live path this still runs inside
// transcribeLocal; exporting it does not change live behavior.
export function applyCorrections(text: string): string {
  let result = text
  for (const [pattern, replacement] of getCorrections()) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/** Null the lazily-built decoder snapshots so the next decode + correction
 *  reload from a freshly-read profile. Call AFTER clearProfileCache() (profile.ts)
 *  on any glossary/profile write — clearProfileCache busts the root JSON cache,
 *  this busts the two derived snapshots that would otherwise re-serve stale
 *  vocabulary/corrections until a server restart. */
export function resetDecoderCaches(): void {
  _whisperPrompt = null
  _corrections = null
}

/**
 * Transcribe audio locally — tries whisper-server first, then OpenAI cloud (via caller).
 *
 * Fallback strategy for REAL-TIME streaming:
 *   server (50ms) → throw → caller falls to OpenAI cloud (1-3s)
 *
 * We intentionally do NOT fall to whisper-cli for real-time because when the server
 * is unhealthy, CLI cold-loads the 1.5GB model from disk = ~11s per chunk (worse than cloud).
 * CLI is reserved for batch/HQ transcription where latency doesn't matter.
 *
 * Circuit breaker: after SERVER_FAILURE_THRESHOLD consecutive server failures,
 * auto-restart the server process in the background and throw immediately so the
 * caller can use cloud while the server recovers (~20s model load).
 */
export async function transcribeLocal(audioBuffer: Buffer, context?: string, isQuiet?: boolean): Promise<{ text: string; backend: 'server' | 'cli'; words?: WhisperWord[] }> {
  const start = Date.now()

  if (!serverAvailable) {
    await reconcileWhisperServerHealth()
  }

  if (!serverAvailable && (serverStarting || serverRestarting)) {
    throw new Error('whisper-server starting — use preserved/cloud fallback')
  }

  // Try whisper-server first (fastest: ~50-100ms, includes DTW word timestamps)
  if (serverAvailable) {
    try {
      const result = await transcribeViaServer(audioBuffer, context, isQuiet)
      const text = applyCorrections(result.text)
      const words = result.words?.map(w => ({ ...w, word: applyCorrections(w.word) }))
      const elapsed = Date.now() - start
      // Reset circuit breaker on success
      if (serverConsecutiveFailures > 0) {
        console.log(`[whisper-local] Server recovered after ${serverConsecutiveFailures} consecutive failure(s)`)
        serverConsecutiveFailures = 0
      }
      console.log(`[whisper-local] Server transcribed in ${elapsed}ms (${words?.length ?? 0} words): "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`)
      return { text, backend: 'server', words }
    } catch (err: any) {
      serverConsecutiveFailures++
      const isTimeout = err.message.includes('timeout') || err.message.includes('aborted')
      const isDead = err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')

      if (isDead) {
        serverAvailable = false
        console.error(`[whisper-local] Server DEAD (ECONNREFUSED) — marked unavailable. Consecutive failures: ${serverConsecutiveFailures}`)
      } else if (isTimeout) {
        // Server process exists but is hung — mark unavailable so we stop trying
        serverAvailable = false
        console.error(`[whisper-local] Server HUNG (timeout) — marked unavailable. Consecutive failures: ${serverConsecutiveFailures}`)
      }

      // Circuit breaker: auto-restart after threshold
      if (serverConsecutiveFailures >= SERVER_FAILURE_THRESHOLD && !serverRestarting) {
        console.error(`[whisper-local] ⚠ CIRCUIT BREAKER OPEN — ${serverConsecutiveFailures} consecutive failures. Auto-restarting server...`)
        // Non-blocking restart in background
        restartWhisperServer()
      } else if (serverConsecutiveFailures < SERVER_FAILURE_THRESHOLD) {
        console.warn(`[whisper-local] Server failed (${serverConsecutiveFailures}/${SERVER_FAILURE_THRESHOLD} before restart): ${err.message}`)
      }

      // Throw to let caller fall to OpenAI cloud (1-3s) — much faster than CLI cold-start (11s)
      throw new Error(`whisper-server unavailable: ${err.message}`)
    }
  }

  // Server not available — still count toward circuit breaker so auto-restart can fire.
  // Without this, the counter stalls after the first failure marks serverAvailable=false
  // and subsequent calls never increment, so restart never triggers.
  serverConsecutiveFailures++
  if (serverConsecutiveFailures >= SERVER_FAILURE_THRESHOLD && !serverRestarting) {
    console.error(`[whisper-local] CIRCUIT BREAKER OPEN — ${serverConsecutiveFailures} consecutive failures (server unavailable). Auto-restarting...`)
    restartWhisperServer()
  }

  // Throw so caller uses cloud fallback — CLI is intentionally skipped for real-time
  throw new Error('whisper-server unavailable — use cloud fallback')
}

/**
 * Auto-restart whisper-server after circuit breaker triggers.
 * Non-blocking — runs in background while callers use cloud fallback.
 */
async function restartWhisperServer(): Promise<void> {
  if (serverRestarting) return
  serverRestarting = true

  try {
    // Kill any existing server process
    if (serverProcess) {
      try { serverProcess.kill('SIGKILL') } catch {}
      serverProcess = null
    }
    // Also kill any zombie processes
    try {
      execSync('pkill -9 -f "whisper-server"', { stdio: 'ignore' })
    } catch { /* none running */ }

    // Wait for port to clear
    for (let i = 0; i < 6; i++) {
      try {
        execSync('lsof -i :8178 -t', { stdio: 'ignore' })
        await new Promise(r => setTimeout(r, 500))
      } catch {
        break
      }
    }

    console.log('[whisper-local] Restarting whisper-server (model load ~20s)...')
    await startWhisperServer()

    if (serverAvailable) {
      serverConsecutiveFailures = 0
      console.log('[whisper-local] Server restarted successfully — circuit breaker CLOSED')
    } else {
      // Reset counter so the next N failures can trigger another restart attempt
      // Without this, the counter stays >= threshold but serverRestarting is false,
      // so every subsequent call would re-trigger restart in a tight loop
      serverConsecutiveFailures = 0
      console.error('[whisper-local] Server restart failed — reset counter, will retry after next 3 failures. Using cloud fallback.')
    }
  } catch (err: any) {
    serverConsecutiveFailures = 0  // Same reset — allow future retry cycle
    console.error(`[whisper-local] Server restart error: ${err.message} — will retry after next 3 failures`)
  } finally {
    serverRestarting = false
  }
}
