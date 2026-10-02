// Which model assigns who-spoke-when.
//
// Voiceprints (ERes2Net) name a person. They do not separate two people inside
// one chunk. Nemotron 3 Diarization does that, then the voiceprint names the
// track. COS_DIARIZER selects the track model. The default is Nemotron. If its
// CLI or its local models are missing, the server stays on the voiceprint path
// and says so.
//
// OFFLINE BY CONSTRUCTION. The FluidAudio CLI downloads its models from Hugging
// Face whenever it is run WITHOUT `--models`, and it deletes and re-downloads a
// cache whose weights marker it does not recognise. A meeting must never wait on
// that, so the server always passes `--models <dir>`, a local directory holding
// the compiled bundle and the silence embedding. That code path in FluidAudio
// (Nemotron3Models.load(directory:)) has no network call at all. When no complete
// local directory exists the server does not run the CLI.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type DiarizerMode = 'nemotron' | 'embedding'

/** Why Nemotron cannot run at all on this install. Per-chunk reasons live in nemotron-live.ts. */
export type DiarizerStaticFallback = 'cli_missing' | 'models_missing'

export interface DiarizerChoice {
  requested: DiarizerMode
  active: DiarizerMode
  /** Why Nemotron was not used. Null when the request is what is running. */
  fallback: DiarizerStaticFallback | null
}

/** The canary's preset: 32-frame chunks, about 155x realtime warm on an M3 Ultra. */
export const NEMOTRON_VARIANT = 'fast32'
/** The FluidAudio v0.17.4 cache keeps the compiled preset under this subdirectory. */
export const NEMOTRON_BUNDLE = 'monolithic/v2'
export const NEMOTRON_MODEL_DIRNAME = `Nemotron3Diarizer_${NEMOTRON_VARIANT}.mlmodelc`
export const NEMOTRON_SILENCE_FILE = 'learnable_sil_emb.bin'

const EMBEDDING_ALIASES = new Set(['embedding', 'eres2net', 'voiceprint', 'legacy'])

export function requestedDiarizer(env: NodeJS.ProcessEnv = process.env): DiarizerMode {
  const raw = (env.COS_DIARIZER ?? 'nemotron').trim().toLowerCase()
  return EMBEDDING_ALIASES.has(raw) ? 'embedding' : 'nemotron'
}

/** First existing binary. Never returns a path that is not on disk. */
export function nemotronCliPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  if (typeof env.COS_NEMOTRON_CLI === 'string') {
    return env.COS_NEMOTRON_CLI.length > 0 && existsSync(env.COS_NEMOTRON_CLI) ? env.COS_NEMOTRON_CLI : null
  }
  const installed = join(home, '.cos-glasses', 'bin', 'fluidaudiocli')
  if (existsSync(installed)) return installed
  // Health reads this on every request; on an install with no CLI that was a
  // synchronous `which` per request (QA 6.61.0 N5). Cached for a minute per PATH.
  const key = env.PATH ?? ''
  const now = Date.now()
  if (whichCache && whichCache.key === key && now - whichCache.at < WHICH_CACHE_MS) {
    return whichCache.value && existsSync(whichCache.value) ? whichCache.value : null
  }
  let value: string | null = null
  try {
    const found = execFileSync('which', ['fluidaudiocli'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 }).trim()
    value = found && existsSync(found) ? found : null
  } catch {
    value = null
  }
  whichCache = { key, at: now, value }
  return value
}

const WHICH_CACHE_MS = 60_000
let whichCache: { key: string; at: number; value: string | null } | null = null

/** The directory passed to `--models`. COS_NEMOTRON_MODELS overrides it. */
export function nemotronModelsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.COS_NEMOTRON_MODELS?.trim()
  return override ? override : join(home, '.cos-glasses', 'models', 'nemotron-3-diarization')
}

/** Where FluidAudio's own downloader leaves the models (`fluidaudiocli` run once without `--models`). */
export function fluidAudioCacheDir(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'FluidAudio', 'Models', 'nemotron-3-diarization')
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** A compiled bundle is complete once its coremldata.bin is on disk (FluidAudio's own test). */
export function modelsDirComplete(dir: string): boolean {
  return isFile(join(dir, NEMOTRON_MODEL_DIRNAME, 'coremldata.bin')) && isFile(join(dir, NEMOTRON_SILENCE_FILE))
}

function cacheComplete(home: string): boolean {
  const cache = fluidAudioCacheDir(home)
  return isFile(join(cache, NEMOTRON_BUNDLE, NEMOTRON_MODEL_DIRNAME, 'coremldata.bin'))
    && isFile(join(cache, NEMOTRON_SILENCE_FILE))
}

export interface NemotronModelSource {
  dir: string
  /** env: COS_NEMOTRON_MODELS. cos: ~/.cos-glasses/models already complete.
   *  fluidaudio-cache: complete only after prepareNemotronModelsDir links it. */
  source: 'env' | 'cos' | 'fluidaudio-cache'
}

/** Read-only: where the models are, or null. Never creates anything (health calls this). */
export function nemotronModelSource(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): NemotronModelSource | null {
  const dir = nemotronModelsDir(env, home)
  if (env.COS_NEMOTRON_MODELS?.trim()) {
    // An explicit override is the answer, complete or not. Falling through to a
    // different copy would run weights the operator did not choose.
    return modelsDirComplete(dir) ? { dir, source: 'env' } : null
  }
  if (modelsDirComplete(dir)) return { dir, source: 'cos' }
  if (cacheComplete(home)) return { dir, source: 'fluidaudio-cache' }
  return null
}

/**
 * Make `--models` point at a complete local copy, or return null.
 *
 * FluidAudio keeps the bundle one level below the silence embedding, while
 * `--models` wants both in one directory, so the COS directory holds two symlinks
 * into the FluidAudio cache. Called by the warm-up, never by a health read.
 */
export function prepareNemotronModelsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const found = nemotronModelSource(env, home)
  if (!found) return null
  if (found.source !== 'fluidaudio-cache') return found.dir
  const cache = fluidAudioCacheDir(home)
  const links: Array<[string, string]> = [
    [join(found.dir, NEMOTRON_MODEL_DIRNAME), join(cache, NEMOTRON_BUNDLE, NEMOTRON_MODEL_DIRNAME)],
    [join(found.dir, NEMOTRON_SILENCE_FILE), join(cache, NEMOTRON_SILENCE_FILE)],
  ]
  try {
    mkdirSync(found.dir, { recursive: true, mode: 0o700 })
    try { chmodSync(found.dir, 0o700) } catch { /* best effort */ }
    for (const [link, target] of links) {
      let current: string | null = null
      try {
        if (lstatSync(link).isSymbolicLink()) current = readlinkSync(link)
        else continue // a real file or directory someone placed there wins
      } catch { /* absent */ }
      if (current === target) continue
      if (current !== null) unlinkSync(link)
      symlinkSync(target, link)
    }
  } catch {
    return null
  }
  return modelsDirComplete(found.dir) ? found.dir : null
}

export function activeDiarizer(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): DiarizerChoice {
  const requested = requestedDiarizer(env)
  if (requested === 'embedding') return { requested, active: 'embedding', fallback: null }
  if (!nemotronCliPath(env, home)) return { requested, active: 'embedding', fallback: 'cli_missing' }
  if (!nemotronModelSource(env, home)) return { requested, active: 'embedding', fallback: 'models_missing' }
  return { requested, active: 'nemotron', fallback: null }
}
