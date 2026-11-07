/**
 * The session pet on COS Control Web (Miles 11/06: "pets brought to the COS ... on home").
 *
 * COS Control keeps the active pet as horizontal PNG strips plus `session-pet-states.json`
 * in `~/Library/Application Support/COS Control`. The web reads that same map, so the phone
 * shows the pet the Mac shows, with no copy to keep in step.
 *
 * The Mac's 1x strips are 256 px tall and up to ~56,000 px wide (Windu's working cast is
 * 184 frames, 3.2 MB). That is too much for a phone to decode at once, so each pose is
 * resized to WEB_PET_HEIGHT with macOS `sips` and cut into chunks no wider than
 * WEB_PET_MAX_CHUNK_WIDTH, each holding whole frames. The result is cached on disk, keyed by
 * the source file's size and mtime, so a pet change on the Mac shows on the next load.
 *
 * `sips` quirk (measured 11/06): `--cropOffset 0 0` crops from the CENTER, while any other
 * offset is measured from the top-left. The first chunk is therefore cut by flipping the
 * strip, cropping from the far end, and flipping back. Pixel-identical to a direct crop.
 */
import crypto from 'crypto'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/** The poses COS Control's live pet uses (PetSpritePose.liveCases). */
export const WEB_PET_POSES = ['idle', 'patrol', 'waiting', 'working', 'duel', 'trio', 'swarm', 'done', 'error', 'attention'] as const
export type WebPetPose = typeof WEB_PET_POSES[number]
/** Frame height sent to the phone, in pixels. */
export const WEB_PET_HEIGHT = 160
/** Widest chunk sent, in pixels. Keeps each decoded image near 5 MB. */
export const WEB_PET_MAX_CHUNK_WIDTH = 8192

export interface PetPoseSource { pose: WebPetPose; file: string; frames: number; interval: number; width: number; height: number; size: number; mtimeMs: number }
export interface PetPosePlan extends PetPoseSource { outHeight: number; frameWidth: number; perChunk: number; chunks: number; key: string }

export function controlSupportDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COS_CONTROL_SUPPORT_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'COS Control')
}

/** Width and height from a PNG's IHDR, or null for anything that is not a PNG. */
export function pngSize(file: string): { width: number; height: number } | null {
  let fd: number | null = null
  try {
    // Non-blocking: a FIFO planted at this path would otherwise hang the whole server (hazard-invariants.test.ts).
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    if (!fs.fstatSync(fd).isFile()) return null
    const head = Buffer.alloc(24)
    if (fs.readSync(fd, head, 0, 24, 0) < 24) return null
    if (head.readUInt32BE(0) !== 0x89504e47 || head.toString('ascii', 12, 16) !== 'IHDR') return null
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** A file name from the state map, kept inside the support folder. */
function insideDir(dir: string, name: unknown): string | null {
  if (typeof name !== 'string' || !name || name.includes('\0') || path.isAbsolute(name)) return null
  const full = path.resolve(dir, name)
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null
}

/** Read the Mac's pet. Poses with a missing, unreadable or mismatched strip are left out. */
export function readPetSources(dir: string): Partial<Record<WebPetPose, PetPoseSource>> {
  let map: { poses?: Record<string, { file?: unknown; frames?: unknown; interval?: unknown }> }
  const mapFile = path.join(dir, 'session-pet-states.json')
  try {
    // Only a regular file is read: readFileSync on a FIFO blocks the event loop.
    if (!fs.statSync(mapFile).isFile()) return {}
    map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  } catch { return {} }
  const out: Partial<Record<WebPetPose, PetPoseSource>> = {}
  for (const pose of WEB_PET_POSES) {
    const row = map?.poses?.[pose]
    if (!row) continue
    const file = insideDir(dir, row.file)
    const frames = Number(row.frames)
    if (!file || !Number.isInteger(frames) || frames < 1 || frames > 1000) continue
    let stat: fs.Stats
    try { stat = fs.statSync(file) } catch { continue }
    if (!stat.isFile()) continue
    const size = pngSize(file)
    if (!size || size.height < 8 || size.width % frames !== 0) continue
    const interval = Number(row.interval)
    out[pose] = {
      pose, file, frames, interval: Number.isFinite(interval) && interval >= 0.01 && interval <= 2 ? interval : 0.12,
      width: size.width, height: size.height, size: stat.size, mtimeMs: stat.mtimeMs,
    }
  }
  return out
}

/** How a pose is resized and chunked. Frame width is rounded once, so every chunk holds whole frames. */
export function planPose(src: PetPoseSource, height = WEB_PET_HEIGHT, maxChunk = WEB_PET_MAX_CHUNK_WIDTH): PetPosePlan {
  const frameWidth = Math.max(1, Math.round((src.width / src.frames) * (height / src.height)))
  const perChunk = Math.max(1, Math.floor(maxChunk / frameWidth))
  const chunks = Math.ceil(src.frames / perChunk)
  const key = crypto.createHash('sha256')
    .update(`${src.file}\0${src.size}\0${src.mtimeMs}\0${src.frames}\0${height}\0${maxChunk}\0v1`)
    .digest('hex').slice(0, 16)
  return { ...src, outHeight: height, frameWidth, perChunk, chunks, key }
}

export function webPetManifest(dir: string = controlSupportDir(), pet = 'mac') {
  const sources = readPetSources(dir)
  const poses: Record<string, { frames: number; interval: number; frameWidth: number; height: number; perChunk: number; chunks: string[] }> = {}
  for (const pose of WEB_PET_POSES) {
    const src = sources[pose]
    if (!src) continue
    const p = planPose(src)
    poses[pose] = {
      frames: p.frames, interval: p.interval, frameWidth: p.frameWidth, height: WEB_PET_HEIGHT, perChunk: p.perChunk,
      chunks: Array.from({ length: p.chunks }, (_, i) => `/api/web-pet/sheet/${pose}/${i}?pet=${encodeURIComponent(pet)}&v=${p.key}`),
    }
  }
  return { available: Object.keys(poses).length > 0, poses }
}

type Run = (cmd: string, args: string[]) => Promise<void>
const sips: Run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()))
})

export interface PetChunkOptions { cacheDir: string; run?: Run; sipsPath?: string }
const inflight = new Map<string, Promise<string>>()

/**
 * The PNG path for one chunk of one pose, building it on first request. Every chunk of the pose
 * is built together, so a pose costs one resize. Concurrent requests share one build.
 */
export function petChunk(plan: PetPosePlan, index: number, opts: PetChunkOptions): Promise<string> {
  if (!Number.isInteger(index) || index < 0 || index >= plan.chunks) return Promise.reject(new Error('no_such_chunk'))
  const base = path.join(opts.cacheDir, `${plan.pose}-${plan.key}`)
  const target = `${base}-${index}.png`
  if (fs.existsSync(target)) return Promise.resolve(target)
  let job = inflight.get(base)
  if (!job) {
    job = buildPose(plan, base, opts).finally(() => inflight.delete(base))
    inflight.set(base, job)
  }
  return job.then(() => target)
}

async function buildPose(plan: PetPosePlan, base: string, opts: PetChunkOptions): Promise<string> {
  const run = opts.run ?? sips
  const bin = opts.sipsPath ?? '/usr/bin/sips'
  fs.mkdirSync(opts.cacheDir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(opts.cacheDir, '.build-'))
  try {
    const H = plan.outHeight
    const total = plan.frameWidth * plan.frames
    const resized = path.join(tmp, 'resized.png')
    await run(bin, ['-z', String(H), String(total), plan.file, '--out', resized])
    let flipped: string | null = null
    for (let i = 0; i < plan.chunks; i++) {
      const x = i * plan.perChunk * plan.frameWidth
      const w = Math.min(plan.perChunk, plan.frames - i * plan.perChunk) * plan.frameWidth
      const out = path.join(tmp, `${i}.png`)
      if (plan.chunks === 1) {
        fs.copyFileSync(resized, out)
      } else if (x === 0) {
        // `--cropOffset 0 0` means centre to sips: cut the first chunk from the mirrored strip's far end.
        if (!flipped) { flipped = path.join(tmp, 'flipped.png'); await run(bin, ['-f', 'horizontal', resized, '--out', flipped]) }
        const far = path.join(tmp, `${i}-far.png`)
        await run(bin, ['-c', String(H), String(w), '--cropOffset', '0', String(total - w), flipped, '--out', far])
        await run(bin, ['-f', 'horizontal', far, '--out', out])
      } else {
        await run(bin, ['-c', String(H), String(w), '--cropOffset', '0', String(x), resized, '--out', out])
      }
    }
    for (let i = 0; i < plan.chunks; i++) fs.renameSync(path.join(tmp, `${i}.png`), `${base}-${i}.png`)
    // Drop this pose's older builds (a pet change on the Mac makes a new key).
    const keep = path.basename(base) + '-'
    for (const name of fs.readdirSync(opts.cacheDir)) {
      if (name.startsWith(`${plan.pose}-`) && !name.startsWith(keep) && name.endsWith('.png')) fs.rmSync(path.join(opts.cacheDir, name), { force: true })
    }
    return base
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Height of the first-frame previews in the pet picker. */
export const WEB_PET_PREVIEW_HEIGHT = 96

/**
 * One still frame (the first frame of idle, else of the first pose this pet has) for the picker, built once
 * with sips and cached. Uses the same flip-and-crop as the first chunk, since sips reads offset 0 as centre.
 */
export function petPreview(dir: string, cacheDir: string, opts: { run?: Run; sipsPath?: string } = {}): Promise<string> {
  const sources = readPetSources(dir)
  const src = sources.idle ?? WEB_PET_POSES.map((p) => sources[p]).find(Boolean)
  if (!src) return Promise.reject(new Error('no_pet_art'))
  const plan = planPose(src, WEB_PET_PREVIEW_HEIGHT)
  const target = path.join(cacheDir, `preview-${plan.key}.png`)
  if (fs.existsSync(target)) return Promise.resolve(target)
  let job = inflight.get(target)
  if (!job) {
    job = (async () => {
      const run = opts.run ?? sips
      const bin = opts.sipsPath ?? '/usr/bin/sips'
      fs.mkdirSync(cacheDir, { recursive: true })
      const tmp = fs.mkdtempSync(path.join(cacheDir, '.preview-'))
      try {
        const H = plan.outHeight, total = plan.frameWidth * plan.frames, w = plan.frameWidth
        const resized = path.join(tmp, 'resized.png'), out = path.join(tmp, 'out.png')
        await run(bin, ['-z', String(H), String(total), plan.file, '--out', resized])
        if (plan.frames === 1) {
          fs.copyFileSync(resized, out)
        } else {
          const flipped = path.join(tmp, 'flipped.png'), far = path.join(tmp, 'far.png')
          await run(bin, ['-f', 'horizontal', resized, '--out', flipped])
          await run(bin, ['-c', String(H), String(w), '--cropOffset', '0', String(total - w), flipped, '--out', far])
          await run(bin, ['-f', 'horizontal', far, '--out', out])
        }
        fs.renameSync(out, target)
        return target
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    })().finally(() => inflight.delete(target))
    inflight.set(target, job)
  }
  return job
}
