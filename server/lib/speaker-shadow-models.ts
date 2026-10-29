// Speaker shadow mode (6.95.0): the pinned FluidAudio Community-1 diarizer models.
//
// NEVER DOWNLOADED BY THE SERVER. FluidAudio's CLI fetches models from Hugging Face
// whenever its cache folder is missing or its revision marker is unknown, so the server
// runs the CLI only after every pinned file below is present and hashes to its pin, and
// always under sandbox-exec with network denied (a CLI that tried anyway fails closed).
// The models must already be on the Mac, in `<data>/speaker-shadow/models/speaker-diarization`
// (or COS_SPEAKER_SHADOW_MODELS): the Hugging Face repo files at the pinned revision.
// Anything else is skipped as `models_missing` or `models_mismatch` and logged.
//
// LAYOUT. The CLI reads `$HOME/Library/Application Support/FluidAudio/Models/speaker-diarization`.
// The server gives it a private HOME whose model folder holds only symlinks to the
// verified files plus the revision marker. The sandbox lets the CLI write in that HOME
// (CoreML keeps its compiled cache there) but not through a symlink, because the sandbox
// matches resolved paths: the verified model bytes are read-only to the CLI.
//
// License: CC-BY-4.0 scoped (NOTICE.md in the repo at this revision). Attribution is
// required before these models ship inside a build; the server ships none of them.

import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { dataPath } from './data-dir.js'

export interface ShadowPinnedFile { path: string; size: number; sha256: string }

/** FluidInference/speaker-diarization-coreml, the revision FluidAudio 0.17.4 pins (ModelNames.swift Repo.diarizer). */
export const SHADOW_MODEL_REPO = 'FluidInference/speaker-diarization-coreml'
export const SHADOW_MODEL_REVISION = 'df2625ac79a7ac6b65ad868fee6d80f320da4232'
/** FluidAudio's local folder name for that repo (not the repo name: the round-1 canary lost a run to this). */
export const SHADOW_MODEL_FOLDER = 'speaker-diarization'
/** What FluidAudio writes after a download; without it the CLI deletes the folder and re-downloads. */
export const SHADOW_REVISION_MARKER = { path: '.fluidaudio-revision', content: `${SHADOW_MODEL_REVISION}\n`, sha256: '1f6ae38637c86e0998be2d231a1431a5a3c37010e9337b682e635cd5c147ef7a' } as const

// From the canary's model-manifest.json and the repo's file listing at the pinned revision.
export const SHADOW_MODEL_FILES: readonly ShadowPinnedFile[] = [
  { path: 'Embedding.mlmodelc/analytics/coremldata.bin', size: 243, sha256: '8d6706436639b53830b4dbe8aaf9c9a843f7f582d63e16f3cb8bb7c6ccd58682' },
  { path: 'Embedding.mlmodelc/coremldata.bin', size: 704, sha256: '4a705bac27d151d9642f37609296042a15602a42253039e0921dc9e75da7e004' },
  { path: 'Embedding.mlmodelc/metadata.json', size: 2818, sha256: '1854371eb6b438fb8aeac96afb45c999af7902581c06afdfcd7ff3cb1ce66be5' },
  { path: 'Embedding.mlmodelc/model.mil', size: 78432, sha256: '22fa958aef72a561c21f874a07cbdcd30fdf40ee961c0bc2fb67c119273b46d3' },
  { path: 'Embedding.mlmodelc/weights/weight.bin', size: 13412288, sha256: '99356b2985b8d43880a657024d941d450b38820451ccff903f76ed4e52d1868b' },
  { path: 'FBank.mlmodelc/analytics/coremldata.bin', size: 243, sha256: '0e8bd3a8b82ac123580989f490e4d9245127c535857630b543311268accc3f0a' },
  { path: 'FBank.mlmodelc/coremldata.bin', size: 853, sha256: '57ac436bb0671cbb5527a339134d695f752eb77f7a18966b93c6835335595759' },
  { path: 'FBank.mlmodelc/metadata.json', size: 3409, sha256: '2623785f5d186893b82d01e84aa33a7704ef763c3309e02055f22dc9d871ce9a' },
  { path: 'FBank.mlmodelc/model.mil', size: 15667, sha256: '27aaeb21569e81bdbe2eef87789f50a37cfea800039bd134448a9417de2f30ed' },
  { path: 'FBank.mlmodelc/weights/weight.bin', size: 1776896, sha256: '9e83fdd3ea78064b078069e4d9141603c61c47a27fd19e7e3142ff7476f8db36' },
  { path: 'PldaRho.mlmodelc/analytics/coremldata.bin', size: 243, sha256: '8940ea6044dbcbefa22da8cc41e0b485e1fb5ed89aecaf37c6e0c483a97ddcd7' },
  { path: 'PldaRho.mlmodelc/coremldata.bin', size: 763, sha256: '4d9741477f721c79b09fcdfe455110c4b7d4272e2de3496bf1729d966d3ee418' },
  { path: 'PldaRho.mlmodelc/metadata.json', size: 2749, sha256: 'b314cf25a93e46b4076883a6f5a2f8848b73c3851bd9d36074d067f35a1c7945' },
  { path: 'PldaRho.mlmodelc/model.mil', size: 7613, sha256: '83aee2e5310d19b5f202aea97d07a0e12102556d1b32ef3ed08b36f7f9725041' },
  { path: 'PldaRho.mlmodelc/weights/weight.bin', size: 200192, sha256: '80f7d229202636d372428c90596f11a91545f07da77259f07153aaf225914a36' },
  { path: 'Segmentation.mlmodelc/analytics/coremldata.bin', size: 243, sha256: '64265f8e7ad41a5f68d630c15288c2499cca5892ad49e20096819cdeac004cdb' },
  { path: 'Segmentation.mlmodelc/coremldata.bin', size: 812, sha256: 'ea51481b8bd3e496ad3cf16f066ddaa37f20e8772eaac76b3393c28de20e06bc' },
  { path: 'Segmentation.mlmodelc/metadata.json', size: 3410, sha256: '88dbf0b07208fe142e1729c2b4c974ad3599fcb2ae5d5f18fce782b225384124' },
  { path: 'Segmentation.mlmodelc/model.mil', size: 43063, sha256: 'd37e4ce30b406a6b34f765f769b9baed3178cc0c2b2e299c641daa43a052dd3f' },
  { path: 'Segmentation.mlmodelc/weights/weight.bin', size: 5959360, sha256: 'c3189a64946c75bc24fcb98afe89ad78c52bdbadfdf65e857fb1b81e2cc9fbb2' },
  { path: 'plda-parameters.json', size: 89416, sha256: '38ee28d4269c076cef254ee760bbd811f0738a92e0f01f9699ad372828c5de8f' },
]

/** The top-level names the private HOME links to. Each must hold exactly its pinned files. */
export const SHADOW_MODEL_ENTRIES: readonly string[] = [...new Set(SHADOW_MODEL_FILES.map(f => f.path.split('/')[0]))]

export function speakerShadowRoot(): string {
  return dataPath('speaker-shadow')
}

export function speakerShadowModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COS_SPEAKER_SHADOW_MODELS?.trim()
  return override ? resolve(override) : join(speakerShadowRoot(), 'models', SHADOW_MODEL_FOLDER)
}

/** The CLI's private HOME (CoreML compiled cache and the linked model folder). */
export function speakerShadowHome(): string {
  return join(speakerShadowRoot(), 'home')
}

export type ShadowModelCheck =
  | { ok: true; dir: string; bytes: number }
  | { ok: false; reason: 'models_missing' | 'models_mismatch'; detail: string }

/** Cheap pre-check for the scheduler: every pinned file exists with its size. No hashing. */
export function shadowModelsPresent(dir: string): boolean {
  return SHADOW_MODEL_FILES.every(f => { try { const st = statSync(join(dir, f.path)); return st.isFile() && st.size === f.size } catch { return false } })
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null) } }))
  return hash.digest('hex')
}

function listFiles(root: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, rel))) {
    const path = rel ? `${rel}/${name}` : name
    const st = lstatSync(join(root, path))
    if (st.isSymbolicLink()) throw new Error(`symlink inside the model folder: ${path}`)
    if (st.isDirectory()) out.push(...listFiles(root, path))
    else out.push(path)
  }
  return out
}

/**
 * Full check: every pinned file hashes to its pin, and each linked entry holds exactly the
 * pinned files (an extra file inside a `.mlmodelc` would be read by CoreML unverified).
 * Runs in the worker, before every diarization.
 */
export async function verifyShadowModels(dir: string): Promise<ShadowModelCheck> {
  let real: string
  try { real = realpathSync(dir) } catch { return { ok: false, reason: 'models_missing', detail: 'model folder not found' } }
  let bytes = 0
  for (const f of SHADOW_MODEL_FILES) {
    const path = join(real, f.path)
    let size: number
    try {
      const st = lstatSync(path)
      if (!st.isFile()) return { ok: false, reason: 'models_mismatch', detail: `${f.path} is not a regular file` }
      size = st.size
    } catch { return { ok: false, reason: 'models_missing', detail: `${f.path} is missing` } }
    if (size !== f.size || await sha256File(path) !== f.sha256) return { ok: false, reason: 'models_mismatch', detail: `${f.path} does not match its pinned SHA-256` }
    bytes += size
  }
  const pinned = new Set(SHADOW_MODEL_FILES.map(f => f.path))
  for (const entry of SHADOW_MODEL_ENTRIES) {
    if (!lstatSync(join(real, entry)).isDirectory()) continue
    let files: string[]
    try { files = listFiles(real, entry) } catch (error) { return { ok: false, reason: 'models_mismatch', detail: error instanceof Error ? error.message : String(error) } }
    const extra = files.filter(p => !pinned.has(p))
    if (extra.length) return { ok: false, reason: 'models_mismatch', detail: `unpinned file in ${entry}: ${extra[0]}` }
  }
  return { ok: true, dir: real, bytes }
}

/**
 * Rebuild the private HOME's model folder: symlinks to the verified entries and the
 * revision marker. The folder only ever holds links and the marker, so rebuilding it from
 * scratch loses nothing (fs.rm unlinks a symlink, never its target).
 */
export function prepareShadowHome(home: string, verifiedDir: string): string {
  const folder = join(home, 'Library', 'Application Support', 'FluidAudio', 'Models', SHADOW_MODEL_FOLDER)
  mkdirSync(join(home, 'Library', 'Application Support', 'FluidAudio', 'Models'), { recursive: true, mode: 0o700 })
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { mode: 0o700 })
  for (const entry of SHADOW_MODEL_ENTRIES) symlinkSync(join(verifiedDir, entry), join(folder, entry))
  writeFileSync(join(folder, SHADOW_REVISION_MARKER.path), SHADOW_REVISION_MARKER.content, { mode: 0o600 })
  return folder
}
