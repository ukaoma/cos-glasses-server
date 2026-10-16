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

import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync,
} from 'node:fs'
import { homedir, setPriority, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { PARAKEET_CLI, PARAKEET_MODELS, type PinnedModel } from './parakeet-manifest.js'
import { checkDeveloperIdCli, controlCliCandidates, COS_TEAM_ID, findTrustedCli, isCliPathShape, type CliTrustDeps, type CliTrustReason } from './parakeet-cli-trust.js'
import type { HypWord } from './stt-resolver.js'

export type ParakeetModelId = 'parakeet-ultra'
export const PARAKEET_TMP_PREFIX = 'cos-parakeet-'
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
/** At most 40 characters (Control truncates there). */
export const PARAKEET_VERSION_LABEL = `Ultra ${PARAKEET_MODELS[0].revision.slice(0, 8)}, CLI ${PARAKEET_CLI.version}`

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
/** 6.74.0: why an install failed, for a client that picks the action from a code. */
export type InstallErrorCode = 'cancelled' | 'insufficient_disk' | 'sha_mismatch' | 'download_failed' | 'stalled' | 'cli_untrusted' | 'cli_missing' | 'failed'
export interface InstallProgress {
  state: InstallPhase
  bytesDone: number
  bytesTotal: number
  error: string | null
  errorCode?: InstallErrorCode | null
  /** Where the bytes came from: files copied from a verified local copy, and files downloaded. */
  source?: { filesLocal: number; filesDownloaded: number; localSources: string[] }
}

export interface InstallReceipt {
  schema: 1
  /** trust (6.74.0): 'sha256' (absent before 6.74.0) is the pinned upstream bytes;
   *  'developer-id' is COS Control's signed build, its own hash and size recorded at install. */
  cli: { version: string; sha256: string; size?: number; trust?: 'sha256' | 'developer-id'; teamId?: string }
  models: Array<{ id: string; revision: string; bytes: number }>
  bytes: number
  installedAt: string
}

const TOTAL_BYTES = PARAKEET_CLI.size + PARAKEET_MODELS.reduce((n, m) => n + m.files.reduce((k, f) => k + f.size, 0), 0)
let progress: InstallProgress = { state: 'idle', bytesDone: 0, bytesTotal: TOTAL_BYTES, error: null }
let installing: Promise<void> | null = null
let installAbort: AbortController | null = null
let installedCache: { at: number; value: { installed: boolean; bytes: number } } | null = null

export function getInstallProgress(): InstallProgress {
  return { ...progress, ...(progress.source ? { source: { ...progress.source, localSources: [...progress.source.localSources] } } : {}) }
}

/**
 * Cheap: the receipt plus a size check of every pinned file. The full hash
 * check happens at install, and the CLI's hash once per process (cliVerified).
 */
export function parakeetInstalled(now = Date.now()): { installed: boolean; bytes: number } {
  if (installedCache && now - installedCache.at < 5_000) return installedCache.value
  let value = { installed: false, bytes: 0 }
  try {
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8')) as InstallReceipt
    const sizeOk = (path: string, size: number) => { try { return statSync(path).size === size } catch { return false } }
    const cliOk = receipt?.schema === 1 && receiptCliOk(receipt.cli, sizeOk)
    const modelsOk = PARAKEET_MODELS.every(m =>
      receipt.models?.some(r => r.id === m.id && r.revision === m.revision)
      && m.files.every(f => sizeOk(join(parakeetModelDir(m.id as ParakeetModelId), f.path), f.size)))
    if (cliOk && modelsOk) value = { installed: true, bytes: receipt.bytes }
  } catch { /* not installed */ }
  installedCache = { at: now, value }
  return value
}

/** The receipt's CLI is one this server trusts, and the installed file has its size. */
function receiptCliOk(cli: InstallReceipt['cli'] | undefined, sizeOk: (path: string, size: number) => boolean): boolean {
  if (!cli || cli.version !== PARAKEET_CLI.version) return false
  if (cli.trust === 'developer-id') {
    return cli.teamId === COS_TEAM_ID && typeof cli.sha256 === 'string' && /^[0-9a-f]{64}$/.test(cli.sha256)
      && typeof cli.size === 'number' && sizeOk(parakeetCliPath(), cli.size)
  }
  return cli.sha256 === PARAKEET_CLI.sha256 && sizeOk(parakeetCliPath(), PARAKEET_CLI.size)
}

function readReceipt(): InstallReceipt | null {
  try { return JSON.parse(readFileSync(receiptPath(), 'utf8')) as InstallReceipt } catch { return null }
}

/** 6.74.0: how the installed CLI was trusted, for GET. */
export function installedCliTrust(): 'sha256' | 'developer-id' | null {
  const cli = readReceipt()?.cli
  return cli ? cli.trust ?? 'sha256' : null
}

export function resetParakeetInstallCache(): void { installedCache = null; cliHashCache.clear() }

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null) } }))
  return hash.digest('hex')
}

function fileStat(path: string): { size: number; mtimeMs: number } | null {
  try { const st = statSync(path); return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null } catch { return null }
}
function fileSize(path: string): number | null { return fileStat(path)?.size ?? null }

/** A pinned CLI hash, computed once per (path, size, mtime) for the life of the process. */
const cliHashCache = new Map<string, boolean>()
async function isPinnedCli(path: string): Promise<boolean> {
  const st = fileStat(path)
  if (!st || st.size !== PARAKEET_CLI.size) return false
  const key = `${path}\0${st.size}\0${st.mtimeMs}`
  const known = cliHashCache.get(key)
  if (known !== undefined) return known
  const ok = await sha256File(path).then(h => h === PARAKEET_CLI.sha256, () => false)
  cliHashCache.set(key, ok)
  return ok
}

/** Synchronous view of the CLI check for GET: true or false once checked, null while unknown. */
function knownPinnedCli(path: string): boolean | null {
  const st = fileStat(path)
  if (!st || st.size !== PARAKEET_CLI.size) return false
  return cliHashCache.get(`${path}\0${st.size}\0${st.mtimeMs}`) ?? null
}

/**
 * Where an already-verified local copy of the models might be. Every candidate
 * must still match the pinned hash. `<data>/stt/parakeet-sources` is the
 * documented drop-in: link or copy a folder holding `parakeet-ultra/`
 * (or FluidAudio's own repo folder name) there, and an install
 * started with an empty body uses it instead of downloading.
 */
export function defaultLocalSources(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const extra = (env.COS_PARAKEET_LOCAL_SOURCES ?? '').split(':').map(s => s.trim()).filter(Boolean)
  return [...extra, join(parakeetRoot(env), '..', 'parakeet-sources'), join(home, 'Library', 'Application Support', 'FluidAudio', 'Models')]
}

export function defaultCliCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const out: string[] = []
  if (env.COS_NEMOTRON_CLI) out.push(env.COS_NEMOTRON_CLI)
  out.push(join(home, '.cos-glasses', 'bin', 'fluidaudiocli'))
  return out
}

/** The first candidate CLI that is the pinned build, or null. */
export async function findPinnedCli(candidates: string[] = defaultCliCandidates()): Promise<string | null> {
  for (const c of candidates) if (await isPinnedCli(c)) return c
  return null
}

/** For GET (no I/O beyond stat): is a pinned CLI known to be on this Mac? null until checked. */
export function pinnedCliKnown(candidates: string[] = defaultCliCandidates()): boolean | null {
  let unknown = false
  for (const c of candidates) {
    const k = knownPinnedCli(c)
    if (k === true) return true
    if (k === null) unknown = true
  }
  if (unknown) void findPinnedCli(candidates)
  return unknown ? null : false
}

function modelDirCandidates(model: PinnedModel, sources: string[]): string[] {
  const repoName = model.repo.split('/').pop()!
  const out: string[] = []
  for (const src of sources) {
    for (const name of [model.id, repoName]) out.push(join(src, name))
    out.push(join(src, 'models', model.id))
  }
  return [...new Set(out)]
}

export class ParakeetInstallError extends Error {
  constructor(message: string, readonly code: InstallErrorCode = 'failed') { super(message); this.name = 'ParakeetInstallError' }
}

/** 6.74.0: an install needs this much free space where it installs (654 MB of model,
 *  the CLI, a staging copy of each file before the swap, and headroom). */
export const INSTALL_MIN_FREE_BYTES = 1_500_000_000

/** Free bytes on the volume holding `dir` (its nearest existing ancestor), or null when unknown. */
export function freeBytesAt(dir: string): number | null {
  let probe = resolve(dir)
  for (let i = 0; i < 64; i++) {
    if (existsSync(probe)) {
      try { const st = statfsSync(probe); return Number(st.bavail) * Number(st.bsize) } catch { return null }
    }
    const up = dirname(probe)
    if (up === probe) return null
    probe = up
  }
  return null
}

/** The disk precheck the install route and the installer share. */
export function parakeetDiskCheck(freeBytes: (dir: string) => number | null = freeBytesAt, required = INSTALL_MIN_FREE_BYTES): { ok: boolean; freeBytes: number | null; requiredBytes: number } {
  const free = freeBytes(parakeetRoot())
  // Unknown free space does not block: the per-file writes still fail plainly on a full disk.
  return { ok: free === null || free >= required, freeBytes: free, requiredBytes: required }
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>

/** A download that delivers no bytes for this long is abandoned. */
export const INSTALL_IDLE_TIMEOUT_MS = 60_000

export interface InstallOptions {
  /** Extra directories or files to look in before downloading. */
  localSources?: string[]
  /** Fail (plainly) instead of downloading a file the local sources lack. */
  requireLocal?: boolean
  cliCandidates?: string[]
  fetchImpl?: FetchLike
  idleTimeoutMs?: number
  /** 6.74.0, tests: codesign and version probes for a Developer ID CLI. */
  trustDeps?: CliTrustDeps
  /** 6.74.0, tests: where COS Control's signed CLI may be (defaults to /Applications and ~/Applications). */
  controlCliCandidates?: string[]
  /** 6.74.0, tests: free space probe. */
  freeBytes?: (dir: string) => number | null
}

/** Start the install, or join the one already running. */
export function installParakeet(options: InstallOptions = {}): Promise<void> {
  if (installing) return installing
  installAbort = new AbortController()
  installing = runInstall(options, installAbort.signal).finally(() => { installing = null; installAbort = null })
  return installing
}

export function parakeetInstallRunning(): boolean { return installing !== null }

/** Stop a running install; nothing partial is kept. */
export function cancelParakeetInstall(): boolean {
  if (!installAbort) return false
  installAbort.abort(new ParakeetInstallError('The install was cancelled.', 'cancelled'))
  return true
}

async function runInstall(options: InstallOptions, signal: AbortSignal): Promise<void> {
  const root = parakeetRoot()
  const localSources = [...(options.localSources ?? []), ...defaultLocalSources()]
  progress = { state: 'verifying', bytesDone: 0, bytesTotal: TOTAL_BYTES, error: null, errorCode: null, source: { filesLocal: 0, filesDownloaded: 0, localSources: [] } }
  const usedSources = new Set<string>()
  let staging: string | null = null
  try {
    // 0. Disk precheck (6.74.0), before anything is written.
    const disk = parakeetDiskCheck(options.freeBytes)
    if (!disk.ok) {
      throw new ParakeetInstallError(`Parakeet needs ${formatGb(disk.requiredBytes)} free on this Mac; ${formatGb(disk.freeBytes ?? 0)} is free. Free some space, then install again. Whisper keeps working.`, 'insufficient_disk')
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    staging = join(root, `.staging-${randomBytes(6).toString('hex')}`)
    mkdirSync(join(staging, 'bin'), { recursive: true, mode: 0o700 })

    // 1. The CLI. FluidAudio publishes no binary: a SHA-256 pinned local copy, or
    //    (6.74.0) the build COS Control ships signed with the COS Developer ID.
    const cliTarget = join(staging, 'bin', 'fluidaudiocli')
    const cli = await findPinnedCli([...(options.cliCandidates ?? []), ...(options.localSources ?? []).map(src => fileSize(src) !== null ? src : join(src, 'fluidaudiocli')), ...defaultCliCandidates()])
    let receiptCli: InstallReceipt['cli']
    if (cli) {
      copyFileSync(cli, cliTarget)
      if (await sha256File(cliTarget) !== PARAKEET_CLI.sha256) throw new ParakeetInstallError('The FluidAudio CLI changed while it was being copied. Try again.')
      receiptCli = { version: PARAKEET_CLI.version, sha256: PARAKEET_CLI.sha256, size: PARAKEET_CLI.size, trust: 'sha256' }
    } else {
      const signedCandidates = [...new Set([...(options.cliCandidates ?? []).filter(isCliPathShape), ...(options.controlCliCandidates ?? controlCliCandidates())])]
      const signed = await findTrustedCli(signedCandidates, options.trustDeps)
      if (!signed) {
        const seen = signedCandidates.find(path => fileSize(path) !== null)
        if (seen) {
          const why = await checkDeveloperIdCli(seen, options.trustDeps)
          const reason: CliTrustReason = why.trusted ? 'signature_invalid' : why.reason
          throw new ParakeetInstallError(`The speech tool in COS Control did not pass its check (${reason}). Reinstall COS Control, then install again.`, 'cli_untrusted')
        }
        throw new ParakeetInstallError(`The speech tool Parakeet needs is not on this Mac. Update COS Control, which includes it, then install again.`, 'cli_missing')
      }
      copyFileSync(signed.path, cliTarget)
      // Prove the copy, not only the source: the installed bytes must be signed and unchanged.
      const copy = await checkDeveloperIdCli(cliTarget, options.trustDeps)
      if (!copy.trusted || copy.sha256 !== signed.sha256) throw new ParakeetInstallError('The speech tool changed while it was being copied. Try again.', 'cli_untrusted')
      receiptCli = { version: PARAKEET_CLI.version, sha256: copy.sha256, size: copy.size, trust: 'developer-id', teamId: COS_TEAM_ID }
    }
    chmodSync(cliTarget, 0o755)
    progress.bytesDone += PARAKEET_CLI.size

    // 2. The models: a matching local copy first, else the pinned Hugging Face revision.
    const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    const idleMs = options.idleTimeoutMs ?? INSTALL_IDLE_TIMEOUT_MS
    for (const model of PARAKEET_MODELS) {
      const candidates = modelDirCandidates(model, localSources)
      for (const file of model.files) {
        if (signal.aborted) throw new ParakeetInstallError('The install was cancelled.', 'cancelled')
        const target = join(staging, 'models', model.id, file.path)
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        let placed = false
        for (const dir of candidates) {
          const src = join(dir, file.path)
          if (fileSize(src) !== file.size) continue
          if (await sha256File(src) !== file.sha256) continue
          copyFileSync(src, target)
          placed = true
          usedSources.add(dir)
          progress.source!.filesLocal++
          break
        }
        if (!placed && options.requireLocal) {
          throw new ParakeetInstallError(`No copy of ${model.id} ${file.path} with the pinned SHA-256 was found in ${(options.localSources ?? []).join(', ') || 'the local sources'}. Check the path, or install with allowDownload to fetch it.`)
        }
        if (!placed) {
          progress.state = 'downloading'
          const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`
          // One controller per file: user cancel, or no bytes for idleMs.
          const ctl = new AbortController()
          const onCancel = () => ctl.abort(new ParakeetInstallError('The install was cancelled.', 'cancelled'))
          signal.addEventListener('abort', onCancel, { once: true })
          let idle: ReturnType<typeof setTimeout> | null = null
          const arm = () => {
            if (idle) clearTimeout(idle)
            idle = setTimeout(() => ctl.abort(new ParakeetInstallError(`The download stalled (no data for ${Math.round(idleMs / 1000)} s). Nothing was installed; try again.`, 'stalled')), idleMs)
            idle.unref?.()
          }
          arm()
          const partial = `${target}.partial`
          let written = 0
          try {
            const res = await fetchImpl(url, { signal: ctl.signal })
            if (!res.ok || !res.body) throw new ParakeetInstallError(`Download failed (${res.status}) for ${model.id} ${file.path}.`, 'download_failed')
            const counter = new Transform({ transform(chunk, _e, cb) {
              arm()
              written += chunk.length
              if (written > file.size) { cb(new ParakeetInstallError(`${model.id} ${file.path} is larger than the pinned size.`, 'sha_mismatch')); return }
              progress.bytesDone += chunk.length
              cb(null, chunk)
            } })
            await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(partial, { mode: 0o600 }), { signal: ctl.signal })
          } catch (error) {
            const why = ctl.signal.reason
            if (why instanceof ParakeetInstallError) throw why
            if (error instanceof ParakeetInstallError) throw error
            throw new ParakeetInstallError(`Download failed for ${model.id} ${file.path}: ${error instanceof Error ? error.message : String(error)}`, 'download_failed')
          } finally {
            if (idle) clearTimeout(idle)
            signal.removeEventListener('abort', onCancel)
            progress.bytesDone -= written // re-counted once below, after verification
          }
          renameSync(partial, target)
          progress.source!.filesDownloaded++
        }
        progress.state = 'verifying'
        if (fileSize(target) !== file.size || await sha256File(target) !== file.sha256) {
          throw new ParakeetInstallError(`${model.id} ${file.path} does not match its pinned SHA-256. Nothing was installed.`, 'sha_mismatch')
        }
        progress.bytesDone += file.size
      }
    }
    progress.source!.localSources = [...usedSources]

    const receipt: InstallReceipt = {
      schema: 1,
      cli: receiptCli,
      models: PARAKEET_MODELS.map(m => ({ id: m.id, revision: m.revision, bytes: m.files.reduce((n, f) => n + f.size, 0) })),
      bytes: TOTAL_BYTES,
      installedAt: new Date().toISOString(),
    }
    durableAtomicWriteFileSync(join(staging, 'install.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })

    // 3. Swap. A crash between the two renames leaves only `.old-*`; boot
    //    (sweepParakeetStaging) puts it back as current.
    const current = currentDir()
    const old = existsSync(current) ? join(root, `.old-${Date.now()}-${randomBytes(3).toString('hex')}`) : null
    if (old) renameSync(current, old)
    renameSync(staging!, current)
    if (old) rmSync(old, { recursive: true, force: true })
    mkdirSync(parakeetHome(), { recursive: true, mode: 0o700 })
    resetParakeetInstallCache()
    for (const id of warm.keys()) warm.delete(id)
    progress = { ...progress, state: 'installed', bytesDone: TOTAL_BYTES, bytesTotal: TOTAL_BYTES, error: null, errorCode: null }
  } catch (error) {
    if (staging) rmSync(staging, { recursive: true, force: true })
    const message = error instanceof ParakeetInstallError ? error.message : `Install failed: ${error instanceof Error ? error.message : String(error)}`
    const code: InstallErrorCode = error instanceof ParakeetInstallError ? error.code : 'failed'
    progress = { ...progress, state: 'failed', bytesTotal: TOTAL_BYTES, error: message, errorCode: code, source: progress.source ? { ...progress.source, localSources: [...usedSources] } : undefined }
    throw new ParakeetInstallError(message, code)
  }
}

function formatGb(bytes: number): string { return `${(bytes / 1e9).toFixed(1)} GB` }

/**
 * Boot: put back an install a crash left mid-swap (no `current`, an `.old-*`
 * present), then remove staging and old directories.
 */
export function sweepParakeetStaging(): { removed: number; restored: boolean } {
  let removed = 0, restored = false
  try {
    const root = parakeetRoot()
    const names = readdirSync(root)
    const olds = names.filter(n => n.startsWith('.old-')).sort()
    if (!existsSync(currentDir()) && olds.length) {
      renameSync(join(root, olds.at(-1)!), currentDir())
      restored = true
      olds.pop()
    }
    for (const name of names) {
      if (!name.startsWith('.staging-') && !(name.startsWith('.old-') && olds.includes(name))) continue
      rmSync(join(root, name), { recursive: true, force: true })
      removed++
    }
  } catch { /* nothing installed yet */ }
  if (restored) resetParakeetInstallCache()
  return { removed, restored }
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
  /** preview: one at a time, a busy lane is a miss. batch: queued, lower CPU priority.
   *  interactive (6.73.0, dictation final and Fast mode): normal priority, never queued
   *  behind a meeting batch, at most INTERACTIVE_LANE_MAX at once; beyond that it is busy. */
  lane: 'preview' | 'batch' | 'warmup' | 'interactive'
  timeoutMs: number
  signal?: AbortSignal
  spawnImpl?: SpawnLike
  /** Tests only: a different sandbox-exec path. There is no environment override. */
  sandboxExec?: string
  /** 6.74.0 benchmark: called with the child's pid once it is spawned (peak memory sampling). */
  onSpawn?: (pid: number) => void
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

/**
 * Sandbox profile: no network at all, and writes only to this run's temp
 * directory and the private CoreML cache HOME (plus /dev streams). Reads stay
 * allowed (the CLI loads system frameworks); that is a documented limit, not a
 * guarantee about what it could read. Paths are realpath'd: the sandbox matches
 * resolved paths, so a /tmp or symlinked data dir would otherwise never match.
 */
export function parakeetSandboxProfile(workDir: string, homeDir: string, userTempDir: string | null = darwinUserTempDir()): string {
  const q = (path: string) => { let real = path; try { real = realpathSync(path) } catch { /* not created yet */ } return real.replace(/\\/g, '\\\\').replace(/"/g, '\\"') }
  // FluidAudio buffers audio over about 15 s in NSTemporaryDirectory (the per-user
  // /var/folders/../T), not in TMPDIR; measured 2026-10-13, a 36 s HQ window failed without it.
  const temp = userTempDir ? ` (subpath "${q(userTempDir)}")` : ''
  return `(version 1)(allow default)(deny network*)(deny file-write*)`
    + `(allow file-write* (subpath "${q(workDir)}") (subpath "${q(homeDir)}")${temp} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/") (regex #"^/dev/tty"))`
}

let userTempCache: string | null | undefined
/** The per-user temp directory macOS gives NSTemporaryDirectory (confstr DARWIN_USER_TEMP_DIR). */
export function darwinUserTempDir(): string | null {
  if (userTempCache !== undefined) return userTempCache
  try {
    const out = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    userTempCache = out.startsWith('/') ? out : null
  } catch { userTempCache = null }
  return userTempCache
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
/** A prompt's Fast warm and HQ warm can overlap for one chunk; a third waits for Whisper. */
export const INTERACTIVE_LANE_MAX = 2
let interactiveRunning = 0

export function transcribeParakeet(wav: Buffer, options: ParakeetRunOptions): Promise<ParakeetResult> {
  if (options.lane === 'preview') {
    if (previewBusy) return Promise.reject(new ParakeetError('busy', 'a preview decode is already running'))
    previewBusy = true
    return runParakeet(wav, options).finally(() => { previewBusy = false })
  }
  if (options.lane === 'interactive') {
    if (interactiveRunning >= INTERACTIVE_LANE_MAX) return Promise.reject(new ParakeetError('busy', 'the interactive lane is full'))
    interactiveRunning++
    return runParakeet(wav, options).finally(() => { interactiveRunning-- })
  }
  if (options.lane === 'batch') {
    const job = batchTail.then(() => runParakeet(wav, options))
    batchTail = job.catch(() => undefined)
    return job
  }
  return runParakeet(wav, options)
}

async function runParakeet(wav: Buffer, options: ParakeetRunOptions): Promise<ParakeetResult> {
  // The installed CLI's full hash, once per process (and again if it changes on disk).
  if (!options.spawnImpl && !(await installedCliIntact())) {
    throw new ParakeetError('not_installed', 'the installed FluidAudio CLI no longer matches the hash recorded when it was installed')
  }
  return runParakeetChecked(wav, options)
}

/**
 * 6.74.0, for the diarizer's CLI lookup (synchronous, read on health): the GUI-installed
 * CLI is trusted only when the install is complete and its bytes are known to match the
 * receipt (the pinned hash, or the Developer ID build's recorded hash). null while that
 * hash has not been checked in this process; a check starts in the background.
 */
export function installedCliTrustedNow(): boolean | null {
  if (!parakeetInstalled().installed) return false
  const path = parakeetCliPath()
  const st = fileStat(path)
  if (!st) return false
  const cli = readReceipt()?.cli
  const key = cli?.trust === 'developer-id'
    ? `${path}\0${st.size}\0${st.mtimeMs}\0${cli.sha256}`
    : `${path}\0${st.size}\0${st.mtimeMs}`
  const known = cliHashCache.get(key)
  if (known !== undefined) return known
  void installedCliIntact(path)
  return null
}

/** The installed CLI is byte for byte what the install verified: the pinned hash, or
 *  (6.74.0) the hash of the Developer ID build recorded in the receipt. */
export async function installedCliIntact(path: string = parakeetCliPath()): Promise<boolean> {
  const cli = readReceipt()?.cli
  if (cli?.trust !== 'developer-id') return isPinnedCli(path)
  const st = fileStat(path)
  if (!st || st.size !== cli.size || cli.teamId !== COS_TEAM_ID) return false
  const key = `${path}\0${st.size}\0${st.mtimeMs}\0${cli.sha256}`
  const known = cliHashCache.get(key)
  if (known !== undefined) return known
  const ok = await sha256File(path).then(h => h === cli.sha256, () => false)
  cliHashCache.set(key, ok)
  return ok
}

function runParakeetChecked(wav: Buffer, options: ParakeetRunOptions): Promise<ParakeetResult> {
  const started = Date.now()
  if (!parakeetInstalled().installed) return Promise.reject(new ParakeetError('not_installed', 'Parakeet is not installed'))
  const sandbox = options.sandboxExec ?? SANDBOX_EXEC
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
  const args = ['-p', parakeetSandboxProfile(work, parakeetHome()), parakeetCliPath(), 'transcribe', input,
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
    if (child.pid && options.onSpawn) { try { options.onSpawn(child.pid) } catch { /* sampling only */ } }
    if (child.pid && options.lane !== 'preview' && options.lane !== 'interactive') {
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
/** A warm decode of the 8 s warm-up clip must come back inside this for the preview to use the model. */
export const WARM_DECODE_BUDGET_MS = 1_000
export const FIRST_LOAD_TIMEOUT_MS = 180_000

export function parakeetWarmState(model: ParakeetModelId): WarmRecord {
  return warm.get(model) ?? { state: 'cold', at: 0 }
}

/** 8 s of very quiet noise: the length of a typical preview phrase, so the
 *  warm decode's time says something about a real preview. */
export const WARMUP_SECONDS = 8
export function warmupWav(): Buffer {
  const samples = WARMUP_SECONDS * 16_000
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
  warm.clear(); warming.clear(); previewBusy = false; interactiveRunning = 0; batchTail = Promise.resolve(); installing = null
  progress = { state: 'idle', bytesDone: 0, bytesTotal: TOTAL_BYTES, error: null }
  installedCache = null
}
