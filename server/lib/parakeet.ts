// Parakeet speech recognition through FluidAudio's CLI on the Neural Engine
// (6.72.0): the HQ engine choice, the HQ second opinion and the experimental
// live preview.
//
// OFFLINE BY CONSTRUCTION. Every run passes `--local-model-dir` (a FluidAudio
// path that never downloads) AND runs under `sandbox-exec` with network denied
// and the installed models read-only. No sandbox, no run. Only the installer
// touches the network, and it accepts a byte only when its SHA-256 matches the
// pinned manifest (parakeet-manifest.ts).
//
// No model call is an LLM. Transcription must never call `claude -p`.
//
// fluidaudiocli 0.17.4 has no server mode, so each decode is one short process.
// What stays warm is the compiled CoreML bundle under the private HOME below:
// measured 2026-10-13 on an M3 Ultra, a 6 s chunk takes about 0.28 s end to end
// once compiled, against 12 to 17 s for the first, compiling run. Callers that
// need a warm model (the live preview) check parakeetWarmState first.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, setPriority, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { PARAKEET_CLI, PARAKEET_MODELS, type PinnedModel } from './parakeet-manifest.js'
import type { HypWord } from './stt-resolver.js'

export type ParakeetModelId = 'parakeet-ultra' | 'parakeet-v2'
export const PARAKEET_TMP_PREFIX = 'cos-parakeet-'
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
export const PARAKEET_VERSION_LABEL = `FluidAudio ${PARAKEET_CLI.version}; Parakeet Ultra ${PARAKEET_MODELS[0].revision.slice(0, 8)}, v2 ${PARAKEET_MODELS[1].revision.slice(0, 8)}`

export function parakeetRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COS_PARAKEET_DIR?.trim()
  return override ? resolve(override) : dataPath('stt', 'parakeet')
}
const currentDir = () => join(parakeetRoot(), 'current')
export const parakeetCliPath = () => join(currentDir(), 'bin', 'fluidaudiocli')
export const parakeetModelDir = (id: ParakeetModelId) => join(currentDir(), 'models', id)
const receiptPath = () => join(currentDir(), 'install.json')
/** CoreML keeps its compiled bundles here. Survives reinstalls, so a reinstall stays warm. */
export const parakeetHome = () => join(parakeetRoot(), 'home')

function pinned(id: ParakeetModelId): PinnedModel {
  const model = PARAKEET_MODELS.find(m => m.id === id)
  if (!model) throw new Error(`unknown Parakeet model ${id}`)
  return model
}

// ── Install state ─────────────────────────────────────────────────────────────

export type InstallPhase = 'idle' | 'downloading' | 'verifying' | 'installed' | 'failed'
export interface InstallProgress {
  state: InstallPhase
  bytesDone: number
  bytesTotal: number
  error: string | null
}

export interface InstallReceipt {
  schema: 1
  cli: { version: string; sha256: string }
  models: Array<{ id: string; revision: string; bytes: number }>
  bytes: number
  installedAt: string
}

const TOTAL_BYTES = PARAKEET_CLI.size + PARAKEET_MODELS.reduce((n, m) => n + m.files.reduce((k, f) => k + f.size, 0), 0)
let progress: InstallProgress = { state: 'idle', bytesDone: 0, bytesTotal: TOTAL_BYTES, error: null }
let installing: Promise<void> | null = null
let installedCache: { at: number; value: { installed: boolean; bytes: number } } | null = null

export function getInstallProgress(): InstallProgress {
  return { ...progress }
}

/**
 * Cheap: the receipt plus a size check of every pinned file. The full hash
 * check happens once, at install. Health and settings reads call this.
 */
export function parakeetInstalled(now = Date.now()): { installed: boolean; bytes: number } {
  if (installedCache && now - installedCache.at < 5_000) return installedCache.value
  let value = { installed: false, bytes: 0 }
  try {
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8')) as InstallReceipt
    const sizeOk = (path: string, size: number) => { try { return statSync(path).size === size } catch { return false } }
    const cliOk = receipt?.schema === 1 && receipt.cli?.sha256 === PARAKEET_CLI.sha256 && sizeOk(parakeetCliPath(), PARAKEET_CLI.size)
    const modelsOk = PARAKEET_MODELS.every(m =>
      receipt.models?.some(r => r.id === m.id && r.revision === m.revision)
      && m.files.every(f => sizeOk(join(parakeetModelDir(m.id as ParakeetModelId), f.path), f.size)))
    if (cliOk && modelsOk) value = { installed: true, bytes: receipt.bytes }
  } catch { /* not installed */ }
  installedCache = { at: now, value }
  return value
}

export function resetParakeetInstallCache(): void { installedCache = null }

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null) } }))
  return hash.digest('hex')
}

function fileSize(path: string): number | null {
  try { const s = statSync(path); return s.isFile() ? s.size : null } catch { return null }
}

/** Places an already-downloaded copy might be. Every candidate must still match the pinned hash. */
export function defaultLocalSources(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const extra = (env.COS_PARAKEET_LOCAL_SOURCES ?? '').split(':').map(s => s.trim()).filter(Boolean)
  return [...extra, join(home, 'Library', 'Application Support', 'FluidAudio', 'Models')]
}

export function defaultCliCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const out: string[] = []
  if (env.COS_NEMOTRON_CLI) out.push(env.COS_NEMOTRON_CLI)
  out.push(join(home, '.cos-glasses', 'bin', 'fluidaudiocli'))
  return out
}

function modelDirCandidates(model: PinnedModel, sources: string[]): string[] {
  const repoName = model.repo.split('/').pop()!
  const legacy = model.id === 'parakeet-v2' ? 'parakeet-tdt-0.6b-v2' : model.id
  const out: string[] = []
  for (const src of sources) {
    for (const name of [model.id, repoName, legacy]) out.push(join(src, name))
    out.push(join(src, 'models', model.id), join(src, 'models', legacy))
  }
  return [...new Set(out)]
}

export class ParakeetInstallError extends Error {
  constructor(message: string) { super(message); this.name = 'ParakeetInstallError' }
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>

export interface InstallOptions {
  /** Extra directories or files to look in before downloading. */
  localSources?: string[]
  cliCandidates?: string[]
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

/** Start the install, or join the one already running. */
export function installParakeet(options: InstallOptions = {}): Promise<void> {
  if (installing) return installing
  installing = runInstall(options).finally(() => { installing = null })
  return installing
}

export function parakeetInstallRunning(): boolean { return installing !== null }

async function runInstall(options: InstallOptions): Promise<void> {
  const root = parakeetRoot()
  progress = { state: 'verifying', bytesDone: 0, bytesTotal: TOTAL_BYTES, error: null }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const staging = join(root, `.staging-${randomBytes(6).toString('hex')}`)
  mkdirSync(join(staging, 'bin'), { recursive: true, mode: 0o700 })
  try {
    // 1. The CLI. FluidAudio publishes no binary, so a pinned local copy is the only source.
    const cliTarget = join(staging, 'bin', 'fluidaudiocli')
    let cliFound = false
    for (const candidate of [...(options.cliCandidates ?? []), ...(options.localSources ?? []).map(s => fileSize(s) !== null ? s : join(s, 'fluidaudiocli')), ...defaultCliCandidates()]) {
      if (fileSize(candidate) !== PARAKEET_CLI.size) continue
      if (await sha256File(candidate) !== PARAKEET_CLI.sha256) continue
      copyFileSync(candidate, cliTarget)
      if (await sha256File(cliTarget) !== PARAKEET_CLI.sha256) throw new ParakeetInstallError('The FluidAudio CLI changed while it was being copied. Try again.')
      chmodSync(cliTarget, 0o755)
      cliFound = true
      break
    }
    if (!cliFound) {
      throw new ParakeetInstallError(`FluidAudio CLI ${PARAKEET_CLI.version} is not on this Mac. It is the same tool speaker separation uses; put it at ~/.cos-glasses/bin/fluidaudiocli, then install again.`)
    }
    progress.bytesDone += PARAKEET_CLI.size

    // 2. The models: a matching local copy first, else the pinned Hugging Face revision.
    const sources = [...(options.localSources ?? []), ...defaultLocalSources()]
    const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    for (const model of PARAKEET_MODELS) {
      const candidates = modelDirCandidates(model, sources)
      for (const file of model.files) {
        if (options.signal?.aborted) throw new ParakeetInstallError('The install was cancelled.')
        const target = join(staging, 'models', model.id, file.path)
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        let placed = false
        for (const dir of candidates) {
          const src = join(dir, file.path)
          if (fileSize(src) !== file.size) continue
          if (await sha256File(src) !== file.sha256) continue
          copyFileSync(src, target)
          placed = true
          break
        }
        if (!placed) {
          progress.state = 'downloading'
          const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`
          const res = await fetchImpl(url, { signal: options.signal })
          if (!res.ok || !res.body) throw new ParakeetInstallError(`Download failed (${res.status}) for ${model.id} ${file.path}.`)
          const partial = `${target}.partial`
          let written = 0
          const counter = new Transform({ transform(chunk, _e, cb) {
            written += chunk.length
            if (written > file.size) { cb(new ParakeetInstallError(`${model.id} ${file.path} is larger than the pinned size.`)); return }
            progress.bytesDone += chunk.length
            cb(null, chunk)
          } })
          await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(partial, { mode: 0o600 }))
          renameSync(partial, target)
          progress.bytesDone -= written // re-counted once below, after verification
        }
        progress.state = 'verifying'
        if (fileSize(target) !== file.size || await sha256File(target) !== file.sha256) {
          throw new ParakeetInstallError(`${model.id} ${file.path} does not match its pinned SHA-256. Nothing was installed.`)
        }
        progress.bytesDone += file.size
      }
    }

    const receipt: InstallReceipt = {
      schema: 1,
      cli: { version: PARAKEET_CLI.version, sha256: PARAKEET_CLI.sha256 },
      models: PARAKEET_MODELS.map(m => ({ id: m.id, revision: m.revision, bytes: m.files.reduce((n, f) => n + f.size, 0) })),
      bytes: TOTAL_BYTES,
      installedAt: new Date().toISOString(),
    }
    durableAtomicWriteFileSync(join(staging, 'install.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })

    // 3. Swap in one rename, so a half-installed copy is never "current".
    const current = currentDir()
    const old = existsSync(current) ? join(root, `.old-${randomBytes(6).toString('hex')}`) : null
    if (old) renameSync(current, old)
    renameSync(staging, current)
    if (old) rmSync(old, { recursive: true, force: true })
    mkdirSync(parakeetHome(), { recursive: true, mode: 0o700 })
    resetParakeetInstallCache()
    for (const id of warm.keys()) warm.delete(id)
    progress = { state: 'installed', bytesDone: TOTAL_BYTES, bytesTotal: TOTAL_BYTES, error: null }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    const message = error instanceof ParakeetInstallError ? error.message : `Install failed: ${error instanceof Error ? error.message : String(error)}`
    progress = { state: 'failed', bytesDone: progress.bytesDone, bytesTotal: TOTAL_BYTES, error: message }
    throw new ParakeetInstallError(message)
  }
}

/** A failed or interrupted install leaves staging directories; remove them at start. */
export function sweepParakeetStaging(): number {
  let removed = 0
  try {
    for (const name of readdirSync(parakeetRoot())) {
      if (!name.startsWith('.staging-') && !name.startsWith('.old-')) continue
      rmSync(join(parakeetRoot(), name), { recursive: true, force: true })
      removed++
    }
  } catch { /* nothing installed yet */ }
  return removed
}

// ── Inference ─────────────────────────────────────────────────────────────────

export type ParakeetFailure = 'not_installed' | 'sandbox_unavailable' | 'busy' | 'timeout' | 'cli_failed' | 'bad_output' | 'spawn_failed' | 'aborted'
export class ParakeetError extends Error {
  constructor(readonly reason: ParakeetFailure, message: string) { super(message); this.name = 'ParakeetError' }
}

export interface ParakeetResult {
  model: ParakeetModelId
  text: string
  /** Spoken words, seconds from the start of the audio. */
  words: HypWord[]
  processingSec: number | null
  wallMs: number
}

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface ParakeetRunOptions {
  model: ParakeetModelId
  /** preview: one at a time, a busy lane is a miss. batch: queued, lower CPU priority. */
  lane: 'preview' | 'batch' | 'warmup'
  timeoutMs: number
  signal?: AbortSignal
  spawnImpl?: SpawnLike
}

const liveChildren = new Set<ChildProcess>()
const liveDirs = new Set<string>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => { killParakeetChildren() })
}

export function killParakeetChildren(): { killed: number; removed: number } {
  let killed = 0, removed = 0
  for (const child of liveChildren) {
    try { if (child.exitCode == null && child.signalCode == null) { child.kill('SIGKILL'); killed++ } } catch { /* gone */ }
  }
  liveChildren.clear()
  for (const dir of liveDirs) { try { rmSync(dir, { recursive: true, force: true }); removed++ } catch { /* best effort */ } }
  liveDirs.clear()
  return { killed, removed }
}

/** Server start: temp directories a previous process left behind. */
export function sweepStaleParakeetTmp(tmpRoot = tmpdir(), minAgeMs = 60_000, now = Date.now()): number {
  let removed = 0
  try {
    for (const name of readdirSync(tmpRoot)) {
      if (!name.startsWith(PARAKEET_TMP_PREFIX)) continue
      const path = join(tmpRoot, name)
      try { if (now - statSync(path).mtimeMs >= minAgeMs) { rmSync(path, { recursive: true, force: true }); removed++ } } catch { /* raced */ }
    }
  } catch { /* no tmp root */ }
  return removed
}

/** Sandbox profile: no network at all; the installed models and CLI are read-only. */
export function parakeetSandboxProfile(installDir: string): string {
  const quoted = installDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `(version 1)(allow default)(deny network*)(deny file-write* (subpath "${quoted}"))`
}

/** The only variables the CLI sees. The server's tokens and keys never reach it. */
export function parakeetChildEnv(home: string, work: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { HOME: home, CFFIXED_USER_HOME: home, TMPDIR: work }
  for (const key of ['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE']) if (typeof env[key] === 'string') out[key] = env[key]
  return out
}

export function parseParakeetJson(raw: string): { text: string; words: HypWord[]; processingSec: number | null } {
  const data = JSON.parse(raw) as { text?: unknown; wordTimings?: unknown; processingTimeSeconds?: unknown }
  if (typeof data?.text !== 'string') throw new ParakeetError('bad_output', 'Parakeet JSON has no text')
  const timings = Array.isArray(data.wordTimings) ? data.wordTimings : []
  const words: HypWord[] = []
  for (const item of timings as Array<Record<string, unknown>>) {
    const word = typeof item?.word === 'string' ? item.word.trim() : ''
    const start = Number(item?.startTime), end = Number(item?.endTime)
    if (!word) continue
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) throw new ParakeetError('bad_output', 'Parakeet word clock is not a finite, non-negative number')
    const p = Number(item?.confidence)
    words.push({ word, start, end: Math.max(start, end), ...(Number.isFinite(p) ? { probability: p } : {}) })
  }
  const processingSec = Number(data.processingTimeSeconds)
  return { text: data.text.trim().replace(/\s+/g, ' '), words, processingSec: Number.isFinite(processingSec) ? processingSec : null }
}

/** FluidAudio 0.17.4 fails a clip under about 0.3 s ("invalidAudioData", exit 0, no
 *  JSON); a meeting's last chunk is often 0.1 to 0.2 s. Pad with silence to this length. */
export const MIN_PARAKEET_AUDIO_SEC = 1.0

/** Zero-pad a 16 kHz mono PCM16 WAV shorter than minSec. Anything else is returned as is. */
export function padShortWav(wav: Buffer, minSec = MIN_PARAKEET_AUDIO_SEC): Buffer {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return wav
  let offset = 12, fmtOk = false
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= wav.length) {
      fmtOk = wav.readUInt16LE(body) === 1 && wav.readUInt16LE(body + 2) === 1 && wav.readUInt32LE(body + 4) === 16_000 && wav.readUInt16LE(body + 14) === 16
    }
    if (id === 'data') {
      if (!fmtOk) return wav
      const pcm = wav.subarray(body, Math.min(wav.length, body + size))
      const want = Math.round(minSec * 16_000) * 2
      if (pcm.length >= want) return wav
      const padded = Buffer.concat([pcm, Buffer.alloc(want - pcm.length)])
      const header = Buffer.alloc(44)
      header.write('RIFF', 0); header.writeUInt32LE(36 + padded.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16_000, 24)
      header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(padded.length, 40)
      return Buffer.concat([header, padded])
    }
    offset = body + size + (size % 2)
  }
  return wav
}

let previewBusy = false
let batchTail: Promise<unknown> = Promise.resolve()

export function transcribeParakeet(wav: Buffer, options: ParakeetRunOptions): Promise<ParakeetResult> {
  if (options.lane === 'preview') {
    if (previewBusy) return Promise.reject(new ParakeetError('busy', 'a preview decode is already running'))
    previewBusy = true
    return runParakeet(wav, options).finally(() => { previewBusy = false })
  }
  if (options.lane === 'batch') {
    const job = batchTail.then(() => runParakeet(wav, options))
    batchTail = job.catch(() => undefined)
    return job
  }
  return runParakeet(wav, options)
}

function runParakeet(wav: Buffer, options: ParakeetRunOptions): Promise<ParakeetResult> {
  const started = Date.now()
  if (!parakeetInstalled().installed) return Promise.reject(new ParakeetError('not_installed', 'Parakeet is not installed'))
  const sandbox = process.env.COS_PARAKEET_SANDBOX_EXEC || SANDBOX_EXEC
  if (!existsSync(sandbox)) return Promise.reject(new ParakeetError('sandbox_unavailable', 'sandbox-exec is missing, so Parakeet cannot be proven offline and does not run'))
  if (options.signal?.aborted) return Promise.reject(new ParakeetError('aborted', 'aborted before start'))
  const model = pinned(options.model)
  let work: string
  try {
    work = mkdtempSync(join(tmpdir(), PARAKEET_TMP_PREFIX))
    chmodSync(work, 0o700)
    mkdirSync(parakeetHome(), { recursive: true, mode: 0o700 })
  } catch (error) {
    return Promise.reject(new ParakeetError('spawn_failed', `temp dir: ${error instanceof Error ? error.message : String(error)}`))
  }
  installExitHook()
  liveDirs.add(work)
  const input = join(work, 'in.wav'), output = join(work, 'out.json')
  writeFileSync(input, padShortWav(wav), { mode: 0o600 })
  const cleanup = () => { liveDirs.delete(work); try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ } }
  const spawnImpl: SpawnLike = options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike)
  const args = ['-p', parakeetSandboxProfile(currentDir()), parakeetCliPath(), 'transcribe', input,
    '--local-model-dir', parakeetModelDir(options.model), '--model-version', model.modelVersion, '--output-json', output]

  return new Promise<ParakeetResult>((resolvePromise, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (error: ParakeetError | null, value?: ParakeetResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      cleanup()
      if (error) reject(error)
      else resolvePromise(value!)
    }
    let child: ChildProcess
    try {
      child = spawnImpl(sandbox, args, { stdio: ['ignore', 'pipe', 'pipe'], env: parakeetChildEnv(parakeetHome(), work) })
    } catch (error) {
      cleanup()
      reject(new ParakeetError('spawn_failed', error instanceof Error ? error.message : String(error)))
      return
    }
    const onAbort = () => { try { child.kill('SIGKILL') } catch { /* gone */ } finish(new ParakeetError('aborted', 'aborted')) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    liveChildren.add(child)
    child.once('close', () => liveChildren.delete(child))
    if (child.pid && options.lane !== 'preview') {
      try { setPriority(child.pid, 10) } catch { /* runs at normal priority */ }
    }
    let stderr = ''
    child.stdout?.on('data', () => { /* the JSON file is the output */ })
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 32_768) stderr += d.toString() })
    timer = setTimeout(() => {
      // SIGKILL: a CoreML compile does not stop for TERM.
      try { child.kill('SIGKILL') } catch { /* gone */ }
      finish(new ParakeetError('timeout', `no result within ${options.timeoutMs} ms`))
    }, options.timeoutMs)
    timer.unref?.()
    child.on('error', error => finish(new ParakeetError('spawn_failed', error.message)))
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) { finish(new ParakeetError('cli_failed', `exit ${code ?? signal}: ${stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 240)}`)); return }
      if (/Unknown option|not supported|transcription failed/i.test(stderr)) { finish(new ParakeetError('cli_failed', 'the CLI rejected an option')); return }
      try {
        const parsed = parseParakeetJson(readFileSync(output, 'utf8'))
        finish(null, { model: options.model, ...parsed, wallMs: Date.now() - started })
      } catch (error) {
        finish(error instanceof ParakeetError ? error : new ParakeetError('bad_output', error instanceof Error ? error.message : String(error)))
      }
    })
  })
}

// ── Warm state ────────────────────────────────────────────────────────────────

export type WarmState = 'cold' | 'warming' | 'warm' | 'failed'
interface WarmRecord { state: WarmState; at: number; firstMs?: number; warmMs?: number; error?: string }
const warm = new Map<ParakeetModelId, WarmRecord>()
const warming = new Map<ParakeetModelId, Promise<boolean>>()
/** A warm decode of 2 s must come back inside this for the preview to use the model. */
export const WARM_DECODE_BUDGET_MS = 1_000
export const FIRST_LOAD_TIMEOUT_MS = 180_000

export function parakeetWarmState(model: ParakeetModelId): WarmRecord {
  return warm.get(model) ?? { state: 'cold', at: 0 }
}

/** 2 s of very quiet noise: enough to load and run every CoreML stage. */
export function warmupWav(): Buffer {
  const samples = 32_000
  const pcm = Buffer.alloc(samples * 2)
  let seed = 7
  for (let i = 0; i < samples; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pcm.writeInt16LE((seed % 41) - 20, i * 2) }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Compile (first run) then time a warm run. Warm only when the second run fits the budget. */
export function warmParakeet(model: ParakeetModelId, spawnImpl?: SpawnLike): Promise<boolean> {
  const running = warming.get(model)
  if (running) return running
  const job = (async () => {
    warm.set(model, { state: 'warming', at: Date.now() })
    try {
      const first = await transcribeParakeet(warmupWav(), { model, lane: 'warmup', timeoutMs: FIRST_LOAD_TIMEOUT_MS, spawnImpl })
      const second = await transcribeParakeet(warmupWav(), { model, lane: 'warmup', timeoutMs: 10_000, spawnImpl })
      const ok = second.wallMs <= WARM_DECODE_BUDGET_MS
      warm.set(model, { state: ok ? 'warm' : 'failed', at: Date.now(), firstMs: first.wallMs, warmMs: second.wallMs, ...(ok ? {} : { error: `warm decode took ${second.wallMs} ms` }) })
      return ok
    } catch (error) {
      warm.set(model, { state: 'failed', at: Date.now(), error: error instanceof Error ? error.message.slice(0, 200) : String(error) })
      return false
    }
  })().finally(() => warming.delete(model))
  warming.set(model, job)
  return job
}

export function __resetParakeetForTests(): void {
  warm.clear(); warming.clear(); previewBusy = false; batchTail = Promise.resolve(); installing = null
  progress = { state: 'idle', bytesDone: 0, bytesTotal: TOTAL_BYTES, error: null }
  installedCache = null
}
