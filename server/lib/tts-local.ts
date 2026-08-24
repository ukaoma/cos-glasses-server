// Local Kokoro TTS sidecar lifecycle — Whisper-shaped, port 8179.
// Local-first engine with an explicit OpenAI fallback path.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR_DIR = resolve(__dirname, '..', 'tts-sidecar')
const SIDECAR_SCRIPT = join(SIDECAR_DIR, 'server.py')
const BOOTSTRAP = join(SIDECAR_DIR, 'bootstrap.sh')

const TTS_PORT = Number(process.env.COS_TTS_LOCAL_PORT || 8179)
const TTS_HOST = '127.0.0.1'
const TTS_BASE =
  process.env.COS_TTS_LOCAL_URL?.replace(/\/$/, '') || `http://${TTS_HOST}:${TTS_PORT}`
const TTS_PROTOCOL = 'cos-tts-v1'
// Boot-scoped bearer token: an unrelated/orphan process on 8179 cannot be
// mistaken for COS or receive private text after the owning server restarts.
const TTS_AUTH_TOKEN = randomBytes(32).toString('hex')

const MODEL_DIR = join(process.env.HOME ?? homedir(), '.local/share/cos-tts-models')

let serverProcess: ChildProcess | null = null
let serverAvailable = false
let serverStarting = false
let lastError: string | null = null
let engineVersion: string | null = null
let localVoice: string | null = null
let lastFallbackToOpenAI: { at: string; reason: string } | null = null
let lastHealthProbeAt = 0
let healthProbeInFlight: Promise<boolean> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryAttempt = 0
let stopRequested = false

const HEALTH_REFRESH_INTERVAL_MS = 2_000
const HEALTH_REFRESH_TIMEOUT_MS = 400

const FALLBACK_STATE_PATH = dataPath('tts-last-fallback.json')

function loadPersistedFallback(): void {
  try {
    if (!existsSync(FALLBACK_STATE_PATH)) return
    const raw = JSON.parse(readFileSync(FALLBACK_STATE_PATH, 'utf8')) as {
      at?: string
      reason?: string
    }
    if (typeof raw.at === 'string' && typeof raw.reason === 'string') {
      lastFallbackToOpenAI = { at: raw.at, reason: raw.reason.slice(0, 300) }
    }
  } catch { /* ignore corrupt state */ }
}

loadPersistedFallback()

/** Record that Voice Mode escaped Kokoro → OpenAI (survives LaunchAgent restart). */
export function recordLocalTtsFallbackToOpenAI(reason: string): void {
  lastFallbackToOpenAI = { at: new Date().toISOString(), reason: reason.slice(0, 300) }
  console.warn('[tts-local] FALLBACK TO OPENAI:', reason)
  try {
    mkdirSync(dirname(FALLBACK_STATE_PATH), { recursive: true })
    atomicWriteFileSync(FALLBACK_STATE_PATH, `${JSON.stringify(lastFallbackToOpenAI)}\n`)
  } catch {
    try {
      writeFileSync(FALLBACK_STATE_PATH, `${JSON.stringify(lastFallbackToOpenAI)}\n`)
    } catch { /* best-effort persist */ }
  }
}

/** Bound hung sidecar so local_first can fall back before session TTL (~60s). */
export const LOCAL_TTS_SYNTH_TIMEOUT_MS = Number(
  process.env.COS_TTS_LOCAL_TIMEOUT_MS || 12_000,
)

function candidatePythons(): string[] {
  const out: string[] = []
  if (process.env.COS_TTS_PYTHON) out.push(process.env.COS_TTS_PYTHON)
  // Pinned product venv only — bootstrap.sh creates it under MODEL_DIR.
  // Do not hardcode repo/Phase-0 paths (breaks other machines + LaunchAgent hygiene).
  out.push(join(MODEL_DIR, '.venv', 'bin', 'python'))
  return out.filter((p) => p && existsSync(p))
}

/** A path existing is not enough. Upgrades may inherit a Python 3.13 venv or
 * a partial environment whose imports fail. Probe the exact sidecar runtime
 * before bypassing bootstrap. */
async function ttsPythonReady(path: string): Promise<boolean> {
  const probe = [
    'import sys',
    'assert (sys.version_info.major, sys.version_info.minor) in ((3, 11), (3, 12))',
    'import fastapi, mlx_audio, misaki, numpy, soundfile, uvicorn',
  ].join('; ')
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false
    const child = spawn(path, ['-c', probe], {
      stdio: 'ignore',
      detached: false,
      env: process.env,
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      resolvePromise(false)
    }, 15_000)
    timer.unref?.()
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(false)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(code === 0)
    })
  })
}

async function resolveReadyPython(): Promise<string | null> {
  for (const path of candidatePythons()) {
    if (await ttsPythonReady(path)) return path
    console.warn(`[tts-local] existing Python runtime is incompatible or incomplete: ${path}`)
  }
  return null
}

async function ensureBootstrap(): Promise<string | null> {
  let py = await resolveReadyPython()
  if (py) return py
  if (!existsSync(BOOTSTRAP)) {
    lastError = `TTS bootstrap missing at ${BOOTSTRAP}`
    return null
  }
  try {
    mkdirSync(MODEL_DIR, { recursive: true })
    console.log('[tts-local] bootstrapping venv via', BOOTSTRAP)
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn('/bin/bash', [BOOTSTRAP], {
        stdio: 'inherit',
        detached: false,
        env: process.env,
      })
      child.once('error', rejectPromise)
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        rejectPromise(new Error(`bootstrap exited code=${code} signal=${signal}`))
      })
    })
  } catch (err) {
    lastError = `TTS bootstrap failed: ${err instanceof Error ? err.message : String(err)}`
    console.error('[tts-local]', lastError)
    return null
  }
  py = await resolveReadyPython()
  if (!py) lastError = 'TTS bootstrap finished but its Python runtime is incompatible or incomplete'
  return py
}

function clearRetryTimer(): void {
  if (!retryTimer) return
  clearTimeout(retryTimer)
  retryTimer = null
}

function scheduleLocalTtsRetry(): void {
  if (stopRequested || retryTimer || serverStarting || serverAvailable) return
  // Retry forever but cap the quiet background cadence at five minutes. This
  // recovers interrupted first-run model downloads and dependencies installed
  // after boot without hot-looping a permanently unsupported setup.
  const delayMs = Math.min(300_000, 10_000 * (2 ** Math.min(retryAttempt, 5)))
  retryAttempt += 1
  console.warn(`[tts-local] retrying Kokoro startup in ${Math.round(delayMs / 1000)}s`)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void startLocalTtsServer().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      console.error('[tts-local] retry failed:', lastError)
      scheduleLocalTtsRetry()
    })
  }, delayMs)
  retryTimer.unref?.()
}

async function probeHealth(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${TTS_BASE}/health`, {
      headers: { Authorization: `Bearer ${TTS_AUTH_TOKEN}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      serverAvailable = false
      lastError = `local TTS health ${res.status}`
      return false
    }
    const body = (await res.json()) as {
      ready?: boolean
      protocol?: string
      engine?: string
      voice?: string
      error?: string | null
    }
    if (body.ready && body.protocol === TTS_PROTOCOL) {
      serverAvailable = true
      engineVersion = body.engine ?? 'kokoro'
      localVoice = body.voice ?? null
      lastError = null
      return true
    }
    serverAvailable = false
    lastError = body.protocol !== TTS_PROTOCOL
      ? 'local TTS protocol identity mismatch'
      : body.error || 'local TTS reported not ready'
    return false
  } catch (err) {
    serverAvailable = false
    lastError = err instanceof Error ? err.message : String(err)
    return false
  }
}

/** Authenticated liveness refresh used by /api/health; never trusts stale state. */
export async function refreshLocalTtsHealth(): Promise<void> {
  if (process.env.COS_TTS_LOCAL_DISABLE === '1') {
    serverAvailable = false
    lastError = 'disabled via COS_TTS_LOCAL_DISABLE=1'
    return
  }
  if (platform() !== 'darwin' || arch() !== 'arm64') {
    serverAvailable = false
    lastError = 'Local Kokoro requires an Apple silicon Mac (darwin/arm64)'
    return
  }
  const now = Date.now()
  if (now - lastHealthProbeAt < HEALTH_REFRESH_INTERVAL_MS) return
  if (!healthProbeInFlight) {
    healthProbeInFlight = probeHealth(HEALTH_REFRESH_TIMEOUT_MS).finally(() => {
      lastHealthProbeAt = Date.now()
      healthProbeInFlight = null
    })
  }
  await healthProbeInFlight
}

export function isLocalTtsReady(): boolean {
  return serverAvailable
}

export function getLocalTtsHealth(): {
  ready: boolean
  engine: string | null
  version: string | null
  voice: string | null
  ffmpeg: boolean
  espeak: boolean
  port: number
  url: string
  starting: boolean
  error: string | null
  lastFallbackToOpenAI: { at: string; reason: string } | null
  /** Renders in flight plus queued. A reply is chunked into up to MAX_CHUNKS
   *  segments that all pre-warm at once, and the sidecar renders one at a time,
   *  so this is the number that explains a slow or failing segment. It was not
   *  observable on 2026-08-23 and that cost an evening. */
  renderQueueDepth: number
} {
  return {
    ready: serverAvailable,
    engine: engineVersion,
    version: engineVersion,
    voice: localVoice,
    ffmpeg: existsSync('/opt/homebrew/bin/ffmpeg') || existsSync('/usr/local/bin/ffmpeg'),
    espeak: existsSync('/opt/homebrew/bin/espeak-ng') || existsSync('/usr/bin/espeak-ng'),
    port: TTS_PORT,
    url: TTS_BASE,
    starting: serverStarting,
    error: lastError,
    lastFallbackToOpenAI,
    renderQueueDepth: localRenderQueueDepth(),
  }
}

export async function startLocalTtsServer(): Promise<void> {
  if (process.env.COS_TTS_LOCAL_DISABLE === '1') {
    console.log('[tts-local] disabled via COS_TTS_LOCAL_DISABLE=1')
    return
  }
  if (serverStarting) return
  if (platform() !== 'darwin' || arch() !== 'arm64') {
    lastError = 'Local Kokoro requires an Apple silicon Mac (darwin/arm64)'
    console.warn('[tts-local]', lastError)
    return
  }
  stopRequested = false
  clearRetryTimer()
  serverStarting = true
  try {
    if (await probeHealth(1500)) {
      // A healthy listener authenticated with this boot token belongs to this
      // server boot; orphan/foreign listeners cannot pass the probe.
      console.log('[tts-local] already healthy on', TTS_PORT)
      return
    }

    if (!existsSync(SIDECAR_SCRIPT)) {
      lastError = `sidecar missing: ${SIDECAR_SCRIPT}`
      console.error('[tts-local]', lastError)
      return
    }

    const python = await ensureBootstrap()
    if (!python) return

    // Clear stale listener if we own a dead handle
    if (serverProcess) {
      try { serverProcess.kill('SIGTERM') } catch { /* ignore */ }
      serverProcess = null
    }

    console.log(`[tts-local] starting Kokoro sidecar on ${TTS_PORT} via ${python}`)
    const child = spawn(
      python,
      [SIDECAR_SCRIPT, '--host', TTS_HOST, '--port', String(TTS_PORT)],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: false,
        env: {
          ...process.env,
          COS_TTS_AUTH_TOKEN: TTS_AUTH_TOKEN,
          ESPEAK_DATA_PATH: process.env.ESPEAK_DATA_PATH || '/opt/homebrew/share/espeak-ng-data',
          PHONEMIZER_ESPEAK_PATH: process.env.PHONEMIZER_ESPEAK_PATH || '/opt/homebrew/bin/espeak-ng',
          COS_TTS_PORT: String(TTS_PORT),
        },
      },
    )
    serverProcess = child
    let childExited = false
    child.on('exit', (code, signal) => {
      childExited = true
      if (serverProcess === child) {
        serverProcess = null
        serverAvailable = false
        lastError = `sidecar exited code=${code} signal=${signal}`
        console.warn('[tts-local]', lastError)
        scheduleLocalTtsRetry()
      }
    })

    const maxWaitMs = 120_000
    const started = Date.now()
    while (Date.now() - started < maxWaitMs && !childExited) {
      if (await probeHealth(1500)) {
        retryAttempt = 0
        clearRetryTimer()
        console.log(
          `[tts-local] ready on ${TTS_PORT} engine=${engineVersion} voice=${localVoice} ` +
            `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
        )
        return
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    lastError = childExited
      ? lastError || 'sidecar exited before becoming ready'
      : `sidecar startup timeout (${maxWaitMs / 1000}s)`
    console.error('[tts-local]', lastError)
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    serverProcess = null
    serverAvailable = false
  } finally {
    serverStarting = false
    if (!serverAvailable) scheduleLocalTtsRetry()
  }
}

export function stopLocalTtsServer(): void {
  stopRequested = true
  clearRetryTimer()
  if (!serverProcess) return
  try {
    serverProcess.kill('SIGTERM')
  } catch { /* ignore */ }
  serverProcess = null
  serverAvailable = false
}

/** Synthesize via local OpenAI-shaped speech endpoint. Returns full audio Buffer. */

// ── render gate ──────────────────────────────────────────────────────────────
//
// The Kokoro sidecar renders ONE request at a time behind its own lock. Issuing
// N requests concurrently therefore does not make them finish any sooner; it
// only makes each one's timeout run while it waits its turn.
//
// That is what broke playback on 2026-08-23. Chunking turned a reply into 9
// renders, all fired at once by /prepare's pre-warm. Measured on a 6,781-char
// reply: each render took ~2.6s, but segment 5's request spent 11.5s of its
// 12,000ms budget QUEUED. On a slightly busier machine it tipped over, returned
// 502, and iOS surfaced it as NotSupportedError. Five of nine segments played.
//
// The gate makes that queue explicit on our side, which buys two things:
//
//   1. The synthesis timeout starts when a request ACQUIRES the gate, so it
//      bounds RENDER time -- what it was always described as bounding. Waiting
//      for a turn is governed separately, by a derived ceiling (below).
//   2. Playback jumps ahead of pre-warm. A /play request has a user waiting on
//      it; a /prepare pre-warm does not. Without priority, segment 5's playback
//      request queues behind the pre-warms for 6, 7 and 8 -- work that is not
//      needed until minutes later.
//
// Priority never reorders playback against itself: a priority waiter is placed
// after other priority waiters and before every background one.

type RenderWaiter = {
  priority: boolean
  resolve: () => void
  reject: (err: Error) => void
  signal?: AbortSignal
  detach?: () => void
}

let gateBusy = false
const gateWaiters: RenderWaiter[] = []

/** In-flight plus queued renders. Exposed for /api/health and tests. */
export function localRenderQueueDepth(): number {
  return gateWaiters.length + (gateBusy ? 1 : 0)
}

/** Test-only: drop all queued waiters and free the gate. */
export function __resetRenderGate(): void {
  for (const w of gateWaiters.splice(0)) {
    w.detach?.()
    w.reject(makeAbortError('render gate reset'))
  }
  gateBusy = false
}

function makeAbortError(message: string): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

function releaseRenderGate(): void {
  const next = gateWaiters.shift()
  if (!next) {
    gateBusy = false
    return
  }
  // The gate stays held; ownership passes straight to `next`. Setting
  // gateBusy = false here would let a later arrival barge in ahead of a
  // waiter that has already been promised the slot.
  next.detach?.()
  next.resolve()
}

function acquireRenderGate(priority: boolean, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(makeAbortError('local TTS request aborted'))
  if (!gateBusy) {
    gateBusy = true
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: RenderWaiter = { priority, resolve, reject, signal }

    // DERIVED ceiling on queue wait, so a wedged sidecar cannot hang callers
    // forever. Everyone ahead of us is individually bounded by the synthesis
    // timeout, so the longest legitimate wait is that timeout once per render
    // ahead of us -- the one in flight plus everyone already queued.
    //
    // The +1 is not slack, it is a race fix found by the test below. Without it
    // the first waiter's ceiling is exactly one render budget, which expires in
    // a dead heat with the holder's OWN timeout: the holder times out, releases
    // the gate, and the waiter that was about to be served is rejected in the
    // same tick. One extra budget of headroom means the queue always outlives
    // the thing it is waiting for.
    const ahead = gateWaiters.length + 1
    const waitCeilingMs = (ahead + 1) * effectiveSynthTimeoutMs()
    const timer = setTimeout(() => {
      const at = gateWaiters.indexOf(waiter)
      if (at >= 0) gateWaiters.splice(at, 1)
      waiter.detach?.()
      const err = new Error(
        `local TTS queue wait exceeded ${waitCeilingMs}ms behind ${ahead} render(s)`,
      )
      err.name = 'TimeoutError'
      reject(err)
    }, waitCeilingMs)
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }

    const onAbort = () => {
      const at = gateWaiters.indexOf(waiter)
      if (at >= 0) gateWaiters.splice(at, 1)
      waiter.detach?.()
      reject(makeAbortError('local TTS request aborted'))
    }
    waiter.detach = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    if (priority) {
      const firstBackground = gateWaiters.findIndex((w) => !w.priority)
      if (firstBackground < 0) gateWaiters.push(waiter)
      else gateWaiters.splice(firstBackground, 0, waiter)
    } else {
      gateWaiters.push(waiter)
    }
  })
}

function effectiveSynthTimeoutMs(): number {
  return Number.isFinite(LOCAL_TTS_SYNTH_TIMEOUT_MS) && LOCAL_TTS_SYNTH_TIMEOUT_MS > 0
    ? LOCAL_TTS_SYNTH_TIMEOUT_MS
    : 12_000
}

export async function synthesizeLocalTts(opts: {
  text: string
  voice: string
  format: string
  signal?: AbortSignal
  /** True for a request a user is waiting on (/play). False/undefined for
   *  background pre-warm, which yields the sidecar to playback. */
  priority?: boolean
}): Promise<Buffer> {
  // Wait for the sidecar BEFORE starting the synthesis clock. The timeout
  // below is a render budget; it was previously charged for queue time too,
  // which is the whole reason segment 5 of 9 died at 12s while rendering in
  // 2.6s. See the render gate above.
  await acquireRenderGate(opts.priority === true, opts.signal)
  try {
    return await synthesizeLocalTtsRender(opts)
  } finally {
    releaseRenderGate()
  }
}

/** The actual sidecar call. Never invoke directly -- it assumes the caller
 *  holds the render gate, and the timeout it starts is a RENDER budget. */
async function synthesizeLocalTtsRender(opts: {
  text: string
  voice: string
  format: string
  signal?: AbortSignal
}): Promise<Buffer> {
  const timeoutMs = effectiveSynthTimeoutMs()
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal =
    opts.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : opts.signal ?? timeoutSignal

  let res: Response
  try {
    res = await fetch(`${TTS_BASE}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TTS_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: opts.text,
        voice: opts.voice,
        response_format: opts.format,
      }),
      signal,
    })
  } catch (err) {
    const name = (err as { name?: string })?.name
    // A caller abort means the user/request went away. Preserve that signal so
    // the route returns 499 and never mistakes cancellation for a Kokoro
    // failure eligible for OpenAI fallback.
    if (opts.signal?.aborted) {
      const abortError = new Error('local TTS request aborted')
      abortError.name = 'AbortError'
      throw abortError
    }
    if (timeoutSignal.aborted || name === 'TimeoutError') {
      const timeoutError = new Error(`local TTS timed out after ${timeoutMs}ms`)
      timeoutError.name = 'TimeoutError'
      throw timeoutError
    }
    // Fail closed for an AbortError whose source is unknown. Treating it as a
    // synthesis failure could spend cloud budget after a canceled request.
    if (name === 'AbortError') {
      throw err
    }
    serverAvailable = false
    lastError = err instanceof Error ? err.message : String(err)
    throw err
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    serverAvailable = false
    lastError = `local TTS ${res.status}: ${errText.slice(0, 160)}`
    throw new Error(`local TTS ${res.status}: ${errText.slice(0, 300)}`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}
