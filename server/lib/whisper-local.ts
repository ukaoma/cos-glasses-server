// Local Whisper transcription via whisper-server (persistent) or whisper-cli (fallback)
// Eliminates 1-3s OpenAI API round-trip by running inference on M3 Ultra locally.
//
// Strategy (fastest → slowest):
//   1. whisper-server (persistent daemon, model in RAM) → ~50-100ms
//   2. whisper-cli (spawned per request, model loaded from disk) → ~500-700ms
//   3. OpenAI API (cloud, handled by transcribe.ts) → ~1000-3000ms

import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs'
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

interface WhisperJsonResponse {
  text?: unknown
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
const ownedServerChildren = new Set<ChildProcess>()
const ownedHqChildren = new Set<ReturnType<typeof spawn>>()

// Circuit breaker: track consecutive server failures to detect hung process
let serverConsecutiveFailures = 0
const SERVER_FAILURE_THRESHOLD = 3   // After 3 consecutive failures, auto-restart
let serverRestarting = false          // Exposed in the existing health shape
let serverStarting = false            // Initial model load is not a circuit failure
let serverStartPromise: Promise<void> | null = null
let serverRestartPromise: Promise<WhisperRestartResult> | null = null
let serverHealthProbe: Promise<boolean> | null = null

interface ProcessEntry {
  pid: number
  ppid: number
  command: string
}

export interface WhisperRestartResult {
  status: 'recovered' | 'failed'
  error?: string
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function listProcesses(): ProcessEntry[] {
  // `command=` includes arguments, which lets us distinguish this COS-owned
  // port/model signature from unrelated whisper-server instances.
  const output = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
  })
}

function listeningPids(): number[] {
  try {
    const output = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${WHISPER_SERVER_PORT}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8' },
    )
    return output.split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0)
  } catch (err: any) {
    // lsof uses exit 1 for "no matches". Anything else means we could not
    // prove the port state, so startup must fail closed.
    if (err?.status === 1) return []
    throw new Error(`unable to inspect whisper-server port ${WHISPER_SERVER_PORT}: ${err?.message ?? err}`)
  }
}

function isCosWhisperServerCommand(command: string): boolean {
  const executable = /(?:^|\s)(?:\S*\/)?whisper-server(?:\s|$)/.test(command)
  const configuredPort = new RegExp(`(?:^|\\s)--port(?:=|\\s+)${WHISPER_SERVER_PORT}(?:\\s|$)`).test(command)
  return executable && configuredPort && command.includes(MODEL_PATH)
}

function collectDescendants(processes: ProcessEntry[], roots: Iterable<number>): Set<number> {
  const descendants = new Set<number>(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const entry of processes) {
      if (!descendants.has(entry.pid) && descendants.has(entry.ppid)) {
        descendants.add(entry.pid)
        changed = true
      }
    }
  }
  return descendants
}

function signalPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (err: any) {
    if (err?.code !== 'ESRCH') throw err
  }
}

async function waitForOwnedChildClose(child: ChildProcess, timeoutMs = 2_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
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

/**
 * Kill every whisper-server we own or can identify as stale, plus all of its
 * descendants. Direct children are awaited so Node reaps them before another
 * model process is allowed to bind the port.
 */
async function killAndReapWhisperProcesses(): Promise<void> {
  serverAvailable = false

  for (let round = 0; round < 3; round++) {
    const processes = listProcesses()
    const ownedPids = [...ownedServerChildren]
      .map(child => child.pid)
      .filter((pid): pid is number => typeof pid === 'number')
    const staleWhisperPids = processes
      .filter(entry => isCosWhisperServerCommand(entry.command))
      .map(entry => entry.pid)
    const targets = collectDescendants(processes, [...ownedPids, ...staleWhisperPids])

    if (targets.size === 0 && ownedServerChildren.size === 0) break

    // Descendants first prevents a model worker from surviving its supervisor.
    const depth = new Map<number, number>()
    const byPid = new Map(processes.map(entry => [entry.pid, entry]))
    const getDepth = (pid: number): number => {
      if (depth.has(pid)) return depth.get(pid)!
      const parent = byPid.get(pid)?.ppid
      const value = parent && targets.has(parent) ? getDepth(parent) + 1 : 0
      depth.set(pid, value)
      return value
    }
    const orderedTargets = [...targets].sort((a, b) => getDepth(b) - getDepth(a))

    for (const pid of orderedTargets) {
      const ownedChild = [...ownedServerChildren].find(child => child.pid === pid)
      if (ownedChild) {
        try { ownedChild.kill('SIGKILL') } catch { /* already exited */ }
      } else {
        signalPid(pid)
      }
    }

    const closeResults = await Promise.all([...ownedServerChildren].map(child => waitForOwnedChildClose(child)))
    if (closeResults.some(closed => !closed)) {
      throw new Error('owned whisper-server child did not exit after SIGKILL')
    }
    await sleep(50)
  }

  const remaining = listProcesses().filter(entry => isCosWhisperServerCommand(entry.command))
  if (remaining.length > 0) {
    throw new Error(`stale whisper-server process(es) remain: ${remaining.map(entry => entry.pid).join(', ')}`)
  }

  serverProcess = null
}

async function proveWhisperPortClear(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pids = listeningPids()
    if (pids.length === 0) return
    if (attempt < 19) await sleep(250)
  }
  const pids = listeningPids()
  throw new Error(
    `whisper-server port ${WHISPER_SERVER_PORT} remains occupied${pids.length ? ` by PID(s) ${pids.join(', ')}` : ''}`,
  )
}

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
  if (serverRestartPromise) {
    const result = await serverRestartPromise
    if (result.status === 'failed') {
      throw new Error(result.error ?? 'whisper-server restart failed')
    }
    return
  }
  if (serverStartPromise) return serverStartPromise
  if (serverAvailable && serverProcess) return

  serverStarting = true
  const operation = startWhisperServerAttempt()
  serverStartPromise = operation
  try {
    await operation
  } finally {
    if (serverStartPromise === operation) serverStartPromise = null
    serverStarting = false
  }
}

async function startWhisperServerAttempt(preflightCompleted = false): Promise<void> {
  if (!existsSync(WHISPER_SERVER) || !existsSync(MODEL_PATH)) {
    console.log('[whisper-local] whisper-server or model not found — using CLI fallback')
    return
  }

  // The API process is the sole Whisper owner. Never adopt an untracked daemon:
  // reap stale trees, then prove the fixed local port is free before spawning.
  if (!preflightCompleted) {
    await killAndReapWhisperProcesses()
    await proveWhisperPortClear()
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

  const child = spawn(WHISPER_SERVER, serverArgs, {
    // whisper-server writes per-inference diagnostics. Unread pipes eventually
    // fill and block the daemon, so the supervisor must not leave them buffered.
    stdio: 'ignore',
    detached: false,  // Dies with parent
  })
  serverProcess = child
  ownedServerChildren.add(child)

  child.once('close', (code) => {
    ownedServerChildren.delete(child)
    if (serverProcess !== child) return
    serverAvailable = false
    serverProcess = null
    if (code !== null && code !== 0) {
      console.warn(`[whisper-local] whisper-server exited with code ${code}`)
    }
  })

  // Wait for server to be ready — poll /health every 2s (large models take ~20s to load).
  // Polls are sequential, so a slow health request cannot overlap the next one.
  const maxWaitMs = 45_000
  const pollIntervalMs = 2_000
  const startTime = Date.now()
  let spawnError: Error | null = null
  let childClosed = false
  child.once('error', err => { spawnError = err })
  child.once('close', () => { childClosed = true })

  while (Date.now() - startTime <= maxWaitMs && !spawnError && !childClosed) {
    try {
      const res = await fetch(`${WHISPER_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        serverAvailable = true
        const loadTime = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(`[whisper-local] whisper-server ready on port ${WHISPER_SERVER_PORT} (loaded in ${loadTime}s)`)
        return
      }
    } catch {
      // Model is still loading.
    }
    if (!spawnError && !childClosed && Date.now() - startTime <= maxWaitMs) {
      await sleep(pollIntervalMs)
    }
  }

  // Event-listener assignment is opaque to TypeScript's control-flow analysis.
  const caughtSpawnError = spawnError as Error | null
  const failure = caughtSpawnError
    ? `whisper-server failed to start: ${caughtSpawnError.message}`
    : childClosed
      ? 'whisper-server exited before becoming healthy'
      : `whisper-server startup timeout (${maxWaitMs / 1000}s)`
  console.error(`[whisper-local] ${failure} — reaping child and keeping local backend unavailable`)
  await killAndReapWhisperProcesses()
  await proveWhisperPortClear()
  throw new Error(failure)
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
  for (const proc of ownedHqChildren) {
    try { proc.kill('SIGKILL') } catch { /* already exited */ }
  }
  ownedHqChildren.clear()
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
 * Parse whisper-cli `-ojf` JSON into plain text + timed words.
 *
 * Batch/save path only. Never uses whisper-server `verbose_json` (the live
 * VAD-empty crash vector). Special tokens like `[_BEG_]` / `<|...|>` are dropped.
 */
export function parseWhisperCliFullJson(raw: string): { text: string; words: WhisperWord[] } {
  const data = JSON.parse(raw) as {
    transcription?: Array<{
      text?: unknown
      tokens?: Array<{
        text?: unknown
        p?: unknown
        offsets?: { from?: unknown; to?: unknown }
      }>
    }>
  }
  const segments = Array.isArray(data.transcription) ? data.transcription : []
  const texts: string[] = []
  const words: WhisperWord[] = []

  for (const segment of segments) {
    if (typeof segment.text === 'string' && segment.text.trim()) {
      texts.push(segment.text.trim())
    }
    for (const token of Array.isArray(segment.tokens) ? segment.tokens : []) {
      const tokenText = typeof token.text === 'string' ? token.text.trim() : ''
      if (!tokenText) continue
      if (tokenText.startsWith('[') && tokenText.endsWith(']')) continue
      if (tokenText.startsWith('<|') && tokenText.endsWith('|>')) continue
      const fromMs = typeof token.offsets?.from === 'number' ? token.offsets.from : Number(token.offsets?.from)
      const toMs = typeof token.offsets?.to === 'number' ? token.offsets.to : Number(token.offsets?.to)
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) continue
      words.push({
        word: tokenText,
        start: fromMs / 1000,
        end: toMs / 1000,
        probability: typeof token.p === 'number' && Number.isFinite(token.p) ? token.p : 0,
      })
    }
  }

  return {
    text: texts.join(' ').replace(/\s+/g, ' ').trim(),
    words,
  }
}

/**
 * High-quality transcription for batch/post-meeting use.
 * Uses the full Whisper large-v3 (32-layer) decoder + Silero VAD + beam search.
 * Per 2026-04-16 bake-off: +43% speech capture vs turbo on real G2 audio.
 * Falls back to turbo weights if large-v3 not on disk or COS_BATCH_LARGE_V3=0.
 * Falls back to transcribeLocal if whisper-cli unavailable entirely.
 */
export async function transcribeHighQuality(
  audioBuffer: Buffer,
  context?: string,
  opts: { priority?: 'interactive' | 'batch' } = {},
): Promise<{ text: string; words?: WhisperWord[] }> {
  if (!cliAvailable) {
    // Fall back to server (no beam search available via HTTP API)
    return transcribeLocal(audioBuffer, context)
  }

  const start = Date.now()
  const id = crypto.randomUUID().slice(0, 8)
  const tmpWav = join('/tmp', `cos-whisper-hq-${id}.wav`)
  const outBase = join('/tmp', `cos-whisper-hq-${id}`)
  const jsonPath = `${outBase}.json`
  // Word clocks only on post-meeting CPU polish. Live stays compact JSON.
  const captureBatchWords = opts.priority === 'batch'

  const modelPath = resolveBatchModel()
  const useLargeV3 = modelPath === BATCH_MODEL_LARGE_V3
  const useVad = VAD_ENABLED && existsSync(VAD_MODEL_PATH)

  try {
    writeFileSync(tmpWav, audioBuffer)

    const text = await new Promise<string>((resolve, reject) => {
      const isolateBatchFromLiveMetal = opts.priority === 'batch'
      const args = [
        '-m', modelPath,
        '-f', tmpWav,
        '-t', isolateBatchFromLiveMetal ? '8' : '16',
        '-l', 'en',
        ...(isolateBatchFromLiveMetal ? ['-ng'] : ['-fa']),
        '-bs', '5',           // Beam search width 5 (default disabled)
        '-bo', '5',           // Best-of-5 candidates (default 2)
        '--no-timestamps',
        '-np',
        '--prompt', buildPrompt(context),
      ]
      if (captureBatchWords) {
        args.push('-ojf', '-of', outBase)
      }
      if (useVad) {
        // Same VAD model the streaming path uses. Strips silence windows
        // before the decoder sees them — prevents the silence-hallucination
        // failure mode even with large-v3's more permissive decoder.
        args.push('--vad', '--vad-model', VAD_MODEL_PATH)
      }
      const proc = spawn(WHISPER_CLI, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      ownedHqChildren.add(proc)

      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      // Timeout scaled to decoder complexity: large-v3 is ~4x slower than
      // turbo per bake-off (0.084x vs 0.024x RTF). 30-40s segments × 4x
      // multiplier × beam-search overhead = ~240s safety ceiling for HQ.
      // Turbo retains the old 60s ceiling.
      const timeoutMs = useLargeV3 ? 240_000 : 60_000
      let timedOut = false
      let forceKill: ReturnType<typeof setTimeout> | null = null
      const timeout = setTimeout(() => {
        timedOut = true
        try { proc.kill('SIGTERM') } catch { /* already exited */ }
        forceKill = setTimeout(() => {
          try { proc.kill('SIGKILL') } catch { /* already exited */ }
        }, 2_000)
      }, timeoutMs)

      proc.on('close', (code) => {
        ownedHqChildren.delete(proc)
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        if (timedOut) {
          reject(new Error(`whisper-cli HQ timeout (${timeoutMs / 1000}s, model=${useLargeV3 ? 'large-v3' : 'turbo'})`))
          return
        }
        if (code !== 0) {
          reject(new Error(`whisper-cli HQ exit ${code}: ${stderr.trim().slice(0, 200)}`))
          return
        }
        resolve(stdout.trim())
      })

      proc.on('error', (err) => {
        ownedHqChildren.delete(proc)
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        reject(new Error(`whisper-cli HQ spawn error: ${err.message}`))
      })
    })

    let finalText = text
    let words: WhisperWord[] | undefined
    if (captureBatchWords) {
      try {
        if (existsSync(jsonPath)) {
          const parsed = parseWhisperCliFullJson(readFileSync(jsonPath, 'utf8'))
          if (parsed.text) finalText = parsed.text
          words = parsed.words.length > 0
            ? parsed.words.map(w => ({ ...w, word: applyCorrections(w.word) }))
            : []
        }
      } catch (err) {
        console.warn(
          `[whisper-hq] Batch word JSON parse failed; keeping text-only polish: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const corrected = applyCorrections(finalText)
    const elapsed = Date.now() - start
    const modelTag = useLargeV3 ? 'large-v3' : 'turbo'
    console.log(
      `[whisper-hq] Batch transcribed in ${elapsed}ms ` +
      `(${modelTag}${useVad ? '+vad' : ''}${captureBatchWords ? '+words' : ''}` +
      `${words ? `, ${words.length} words` : ''}): ` +
      `"${corrected.slice(0, 80)}${corrected.length > 80 ? '...' : ''}"`,
    )
    return words ? { text: corrected, words } : { text: corrected }
  } finally {
    try { unlinkSync(tmpWav) } catch { /* cleanup */ }
    if (captureBatchWords) {
      try { unlinkSync(jsonPath) } catch { /* cleanup */ }
    }
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
 *
 * Compact JSON intentionally avoids whisper.cpp's verbose_json language field,
 * which can receive a null C string after VAD returns no speech and crash the
 * native server before an HTTP response exists.
 */
async function transcribeViaServer(audioBuffer: Buffer, context?: string, isQuiet?: boolean): Promise<{ text: string; words?: WhisperWord[] }> {
  const formData = new FormData()
  // Convert Buffer to Uint8Array to satisfy Blob's BlobPart type constraint
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/wav' })
  formData.append('file', blob, 'recording.wav')
  formData.append('response_format', 'json')
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

  const result = await response.json() as WhisperJsonResponse
  if (typeof result.text !== 'string') {
    throw new Error('whisper-server returned invalid compact JSON: missing string text')
  }
  return { text: result.text.trim() }
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
    throw new Error('whisper-server starting — preserve audio for retry')
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
        void restartWhisperServer()
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
    void restartWhisperServer()
  }

  // Throw so the caller applies the configured recovery policy. CLI is
  // intentionally skipped for real-time transcription.
  throw new Error('whisper-server unavailable — apply configured recovery policy')
}

/**
 * Auto-restart whisper-server after circuit breaker triggers.
 * Non-blocking — runs in background while callers preserve audio or apply the
 * explicitly configured fallback policy.
 */
export async function restartWhisperServer(): Promise<WhisperRestartResult> {
  if (serverRestartPromise) return serverRestartPromise

  serverRestarting = true
  const priorStart = serverStartPromise
  const operation = (async (): Promise<WhisperRestartResult> => {
    try {
      // A restart requested during model load runs immediately after that single
      // start attempt completes, then owns the lifecycle until recovery finishes.
      if (priorStart) {
        try { await priorStart } catch { /* restart performs its own clean recovery */ }
      }

      await killAndReapWhisperProcesses()
      await proveWhisperPortClear()

      console.log('[whisper-local] Restarting whisper-server (model load ~20s)...')
      await startWhisperServerAttempt(true)
      if (!serverAvailable) {
        throw new Error('whisper-server did not become healthy')
      }
      serverConsecutiveFailures = 0
      console.log('[whisper-local] Server restarted successfully — circuit breaker CLOSED')
      return { status: 'recovered' }
    } catch (err: any) {
      serverAvailable = false
      // Preserve the existing retry cadence: one failed recovery consumes this
      // breaker cycle, and the next three failed calls may request one new cycle.
      serverConsecutiveFailures = 0
      const message = err?.message ?? String(err)
      console.error(`[whisper-local] Server restart error: ${message} — will retry after next 3 failures`)
      return { status: 'failed', error: message }
    }
  })()

  serverRestartPromise = operation
  try {
    return await operation
  } finally {
    if (serverRestartPromise === operation) serverRestartPromise = null
    serverRestarting = false
  }
}
