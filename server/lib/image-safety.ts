// Image ingestion safety — every byte that enters the media store passes
// through here. Magic-byte type detection (never trust MIME or filename),
// header dimension parsing (decompression-bomb defense BEFORE any decode),
// strict base64, and ffmpeg normalization (EXIF/metadata stripped, bounded
// output size, deterministic JPEG profile).
//
// ffmpeg runs via spawn with an argument array — never a shell string — with
// -nostdin, a hard timeout, bounded stderr, and private tmp paths. If ffmpeg
// is unavailable the caller gets a typed `media_processing_unavailable`
// failure; unnormalized originals are NEVER stored as a fallback.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaMime } from '../../shared/media-attachment.js'

// ── Limits (Release A contract) ──────────────────────────────────────────────

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024        // 2 MiB decoded per source image
// Agent artifacts are often lossless PNG/WebP/HEIC/AVIF and can be larger
// than the phone-upload contract before COS re-encodes them. This separate,
// trusted-local boundary stays bounded and still probes dimensions before a
// full decode; normalized bytes return to the original JPEG contract.
export const MAX_OUTPUT_ARTIFACT_BYTES = 16 * 1024 * 1024
export const MAX_BATCH_BYTES = 8 * 1024 * 1024        // 8 MiB decoded per request
export const MAX_MEGAPIXELS = 16_000_000              // 16 MP per source image
export const NORMALIZED_MAX_EDGE = 1024               // longest edge after normalization
export const THUMB_MAX_EDGE = 256
const FFMPEG_TIMEOUT_MS = 15_000
const FFMPEG_STDERR_CAP = 4096

// ── Typed failures ───────────────────────────────────────────────────────────

export type ImageSafetyErrorCode =
  | 'invalid_base64'
  | 'unsupported_format'
  | 'image_too_large'
  | 'dimensions_too_large'
  | 'corrupt_image'
  | 'media_processing_unavailable'
  | 'normalization_failed'

export class ImageSafetyError extends Error {
  readonly code: ImageSafetyErrorCode
  constructor(code: ImageSafetyErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ImageSafetyError'
  }
}

// ── Strict base64 ────────────────────────────────────────────────────────────
// Node's Buffer.from(b64) silently tolerates garbage; reject malformed input
// explicitly so a truncated/hostile payload can't half-decode into the store.

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

export function strictBase64Decode(b64: unknown): Buffer {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new ImageSafetyError('invalid_base64', 'image data must be a non-empty base64 string')
  }
  const clean = b64.replace(/\s+/g, '')
  if (clean.length % 4 !== 0 || !BASE64_RE.test(clean)) {
    throw new ImageSafetyError('invalid_base64', 'malformed base64 image data')
  }
  const buf = Buffer.from(clean, 'base64')
  // Round-trip length check catches embedded padding / truncation.
  const expected = (clean.length / 4) * 3 - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0)
  if (buf.length !== expected) {
    throw new ImageSafetyError('invalid_base64', 'base64 image data failed round-trip validation')
  }
  return buf
}

// ── Magic-byte type detection ────────────────────────────────────────────────
// JPEG: FF D8 FF. PNG: 89 50 4E 47 0D 0A 1A 0A. Everything else — SVG, GIF,
// PDF, HEIC, polyglots, data URIs — is rejected at this gate.

export function sniffImageType(buf: Buffer): MediaMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png'
  return null
}

export type OutputArtifactType = MediaMime | 'image/webp' | 'image/heic' | 'image/avif'

/** Magic-byte allowlist for already-local agent artifacts. Filenames and
 * claimed MIME are never trusted. SVG/GIF/PDF remain rejected. */
export function sniffOutputArtifactType(buf: Buffer): OutputArtifactType | null {
  const baseline = sniffImageType(buf)
  if (baseline) return baseline
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const declaredBoxSize = buf.readUInt32BE(0)
    const boxEnd = Math.min(buf.length, declaredBoxSize >= 16 ? declaredBoxSize : 16, 256)
    const brands: string[] = [buf.toString('ascii', 8, 12)]
    for (let offset = 16; offset + 4 <= boxEnd; offset += 4) brands.push(buf.toString('ascii', offset, offset + 4))
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return 'image/avif'
    if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand))) {
      return 'image/heic'
    }
  }
  return null
}

// ── Header dimension parsing ─────────────────────────────────────────────────
// Read declared dimensions from the container header itself so the megapixel
// gate runs BEFORE any pixel decode (decompression-bomb defense).

export function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  // IHDR must be the first chunk: 8-byte signature, 4-byte len, 'IHDR', W, H.
  if (buf.length < 24) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

export function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  // Walk JPEG markers to the first SOF0-SOF15 frame header (excluding
  // DHT/DAC/RST which share the 0xC0 nibble but aren't frames).
  let off = 2
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null
    const marker = buf[off + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2
      continue
    }
    const size = buf.readUInt16BE(off + 2)
    if (size < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (off + 9 > buf.length) return null
      const height = buf.readUInt16BE(off + 5)
      const width = buf.readUInt16BE(off + 7)
      if (width === 0 || height === 0) return null
      return { width, height }
    }
    off += 2 + size
  }
  return null
}

export function parseImageDimensions(buf: Buffer, mime: MediaMime): { width: number; height: number } | null {
  return mime === 'image/png' ? parsePngDimensions(buf) : parseJpegDimensions(buf)
}

// ── Pre-normalization validation ─────────────────────────────────────────────

export interface ValidatedImage {
  bytes: Buffer
  mime: MediaMime
  width: number
  height: number
}

/** Full ingestion gate for ONE source image: type sniff, size cap, header
 *  dimension consistency, megapixel bomb defense. Throws ImageSafetyError. */
export function validateSourceImage(bytes: Buffer): ValidatedImage {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageSafetyError('image_too_large', `image is ${bytes.length} bytes (max ${MAX_IMAGE_BYTES})`)
  }
  const mime = sniffImageType(bytes)
  if (!mime) {
    throw new ImageSafetyError('unsupported_format', 'only JPEG and PNG images are accepted')
  }
  const dims = parseImageDimensions(bytes, mime)
  if (!dims) {
    throw new ImageSafetyError('corrupt_image', 'image header has no readable dimensions')
  }
  if (dims.width * dims.height > MAX_MEGAPIXELS) {
    throw new ImageSafetyError('dimensions_too_large', `${dims.width}x${dims.height} exceeds ${MAX_MEGAPIXELS / 1e6}MP limit`)
  }
  return { bytes, mime, width: dims.width, height: dims.height }
}

// ── ffmpeg availability ──────────────────────────────────────────────────────

let ffmpegReady: boolean | null = null

/** Probe ffmpeg once per process. Health surfaces this as mediaProcessingReady. */
export async function isMediaProcessingReady(): Promise<boolean> {
  if (ffmpegReady !== null) return ffmpegReady
  ffmpegReady = await new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok) } }
    try {
      const proc = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] })
      const timer = setTimeout(() => { proc.kill('SIGKILL'); settle(false) }, 5_000)
      proc.on('close', (code) => { clearTimeout(timer); settle(code === 0) })
      proc.on('error', () => { clearTimeout(timer); settle(false) })
    } catch {
      settle(false)
    }
  })
  return ffmpegReady
}

/** Test hook — reset the cached probe result. */
export function _resetMediaProcessingProbe(): void {
  ffmpegReady = null
}

// ── ffmpeg normalization ─────────────────────────────────────────────────────

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let settled = false
    const settle = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const proc = spawn('ffmpeg', ['-nostdin', '-v', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle(new ImageSafetyError('normalization_failed', 'ffmpeg timed out'))
    }, FFMPEG_TIMEOUT_MS)
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < FFMPEG_STDERR_CAP) stderr += chunk.toString().slice(0, FFMPEG_STDERR_CAP - stderr.length)
    })
    proc.on('close', (code) => {
      if (code === 0) settle()
      else settle(new ImageSafetyError('normalization_failed', `ffmpeg exit ${code}: ${stderr.trim().slice(0, 300)}`))
    })
    proc.on('error', (err) => {
      settle(new ImageSafetyError('media_processing_unavailable', `ffmpeg unavailable: ${err.message}`))
    })
  })
}

function probeImageDimensions(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolveProbe, rejectProbe) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (result?: { width: number; height: number }, err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) rejectProbe(err)
      else resolveProbe(result!)
    }
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle(undefined, new ImageSafetyError('normalization_failed', 'ffprobe timed out'))
    }, 5_000)
    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < FFMPEG_STDERR_CAP) stdout += chunk.toString().slice(0, FFMPEG_STDERR_CAP - stdout.length)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < FFMPEG_STDERR_CAP) stderr += chunk.toString().slice(0, FFMPEG_STDERR_CAP - stderr.length)
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        settle(undefined, new ImageSafetyError('corrupt_image', `ffprobe rejected image: ${stderr.trim().slice(0, 200)}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: unknown; height?: unknown }> }
        const width = parsed.streams?.[0]?.width
        const height = parsed.streams?.[0]?.height
        if (!Number.isInteger(width) || !Number.isInteger(height) || Number(width) <= 0 || Number(height) <= 0) {
          throw new Error('missing dimensions')
        }
        settle({ width: Number(width), height: Number(height) })
      } catch {
        settle(undefined, new ImageSafetyError('corrupt_image', 'image probe returned no readable dimensions'))
      }
    })
    proc.on('error', (err) => {
      settle(undefined, new ImageSafetyError('media_processing_unavailable', `ffprobe unavailable: ${err.message}`))
    })
  })
}

export interface NormalizedImage {
  /** Normalized primary asset — metadata-stripped JPEG, longest edge <= 1024. */
  normalized: Buffer
  /** Thumbnail — same profile, longest edge <= 256. */
  thumb: Buffer
  width: number
  height: number
  mime: 'image/jpeg'
}

// ── G2 lens variant (Release B) ──────────────────────────────────────────────
// The canary run of 2026-07-10 (G2 S211GABA296089, SDK 0.0.9) proved 288x144
// image containers on hardware. The lens variant is EXACTLY that size — the
// firmware TILES undersized data (canary injection evidence), so exact
// dimensions are a hard contract, guaranteed here by scale+pad.
export const G2_VARIANT_W = 288
export const G2_VARIANT_H = 144

/** Render the on-lens variant from an already-normalized asset: fit inside
 *  288x144, pad to exactly 288x144 with black bars, grayscale, PNG (the
 *  hardware-proven payload format — the phone host converts to Gray4). */
export async function renderG2Variant(normalizedBytes: Buffer): Promise<Buffer> {
  if (!(await isMediaProcessingReady())) {
    throw new ImageSafetyError('media_processing_unavailable', 'G2 variant rendering requires ffmpeg')
  }
  const workDir = mkdtempSync(join(tmpdir(), 'cos-media-g2-'))
  const inPath = join(workDir, 'in')
  const outPath = join(workDir, 'g2.png')
  try {
    writeFileSync(inPath, normalizedBytes, { mode: 0o600 })
    await runFfmpeg([
      '-i', inPath,
      '-frames:v', '1',
      '-vf', [
        `scale=${G2_VARIANT_W}:${G2_VARIANT_H}:force_original_aspect_ratio=decrease`,
        `pad=${G2_VARIANT_W}:${G2_VARIANT_H}:(ow-iw)/2:(oh-ih)/2:black`,
        'format=gray',
      ].join(','),
      '-map_metadata', '-1',
      '-c:v', 'png',
      '-f', 'image2', '-y', outPath,
    ])
    const out = readFileSync(outPath)
    const dims = parsePngDimensions(out)
    if (!dims || dims.width !== G2_VARIANT_W || dims.height !== G2_VARIANT_H) {
      throw new ImageSafetyError('normalization_failed', `G2 variant is ${dims?.width}x${dims?.height}, expected ${G2_VARIANT_W}x${G2_VARIANT_H}`)
    }
    return out
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Normalize a VALIDATED source image: strip all metadata/EXIF, clamp the
 *  longest edge, re-encode to a deterministic JPEG profile, and emit a
 *  thumbnail. Runs in a private tmp dir; one output frame per invocation. */
export async function normalizeImage(source: ValidatedImage): Promise<NormalizedImage> {
  if (!(await isMediaProcessingReady())) {
    throw new ImageSafetyError('media_processing_unavailable', 'image normalization requires ffmpeg')
  }
  const workDir = mkdtempSync(join(tmpdir(), 'cos-media-'))
  const inPath = join(workDir, 'in')
  const outPath = join(workDir, 'normalized.jpg')
  const thumbPath = join(workDir, 'thumb.jpg')
  try {
    writeFileSync(inPath, source.bytes, { mode: 0o600 })
    const scale = (edge: number) =>
      `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`
    await runFfmpeg([
      '-i', inPath,
      '-frames:v', '1',
      '-vf', scale(NORMALIZED_MAX_EDGE),
      '-map_metadata', '-1',
      '-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p',
      '-f', 'image2', '-y', outPath,
    ])
    await runFfmpeg([
      '-i', outPath,
      '-frames:v', '1',
      '-vf', scale(THUMB_MAX_EDGE),
      '-map_metadata', '-1',
      '-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p',
      '-f', 'image2', '-y', thumbPath,
    ])
    const normalized = readFileSync(outPath)
    const thumb = readFileSync(thumbPath)
    const dims = parseJpegDimensions(normalized)
    if (!dims) {
      throw new ImageSafetyError('normalization_failed', 'normalized output has no readable dimensions')
    }
    if (Math.max(dims.width, dims.height) > NORMALIZED_MAX_EDGE) {
      throw new ImageSafetyError('normalization_failed', 'normalized output exceeded edge limit')
    }
    return { normalized, thumb, width: dims.width, height: dims.height, mime: 'image/jpeg' }
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Normalize a trusted, already-local model artifact. This is deliberately
 * separate from the public phone-upload gate: up to 16 MiB JPEG/PNG/WebP/
 * HEIC/AVIF is accepted by magic, probed for a <=16 MP first frame, stripped,
 * clamped, and re-encoded into the same deterministic JPEG + thumbnail form. */
export async function normalizeOutputArtifact(bytes: Buffer): Promise<NormalizedImage> {
  if (bytes.length <= 0 || bytes.length > MAX_OUTPUT_ARTIFACT_BYTES) {
    throw new ImageSafetyError('image_too_large', `output artifact is ${bytes.length} bytes (max ${MAX_OUTPUT_ARTIFACT_BYTES})`)
  }
  if (!sniffOutputArtifactType(bytes)) {
    throw new ImageSafetyError('unsupported_format', 'output artifact must be JPEG, PNG, WebP, HEIC/HEIF, or AVIF')
  }
  if (!(await isMediaProcessingReady())) {
    throw new ImageSafetyError('media_processing_unavailable', 'image normalization requires ffmpeg')
  }

  const workDir = mkdtempSync(join(tmpdir(), 'cos-output-media-'))
  const inPath = join(workDir, 'in')
  const outPath = join(workDir, 'normalized.jpg')
  const thumbPath = join(workDir, 'thumb.jpg')
  try {
    writeFileSync(inPath, bytes, { mode: 0o600 })
    const dims = await probeImageDimensions(inPath)
    if (dims.width * dims.height > MAX_MEGAPIXELS) {
      throw new ImageSafetyError('dimensions_too_large', `${dims.width}x${dims.height} exceeds ${MAX_MEGAPIXELS / 1e6}MP limit`)
    }
    const scale = (edge: number) =>
      `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`
    await runFfmpeg([
      '-i', inPath,
      '-frames:v', '1',
      '-vf', scale(NORMALIZED_MAX_EDGE),
      '-map_metadata', '-1',
      '-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p',
      '-f', 'image2', '-y', outPath,
    ])
    await runFfmpeg([
      '-i', outPath,
      '-frames:v', '1',
      '-vf', scale(THUMB_MAX_EDGE),
      '-map_metadata', '-1',
      '-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p',
      '-f', 'image2', '-y', thumbPath,
    ])
    const normalized = readFileSync(outPath)
    const thumb = readFileSync(thumbPath)
    const normalizedDims = parseJpegDimensions(normalized)
    if (!normalizedDims || Math.max(normalizedDims.width, normalizedDims.height) > NORMALIZED_MAX_EDGE) {
      throw new ImageSafetyError('normalization_failed', 'normalized output dimensions are invalid')
    }
    // Re-enter the original byte/type/dimension contract before publication.
    validateSourceImage(normalized)
    return {
      normalized,
      thumb,
      width: normalizedDims.width,
      height: normalizedDims.height,
      mime: 'image/jpeg',
    }
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
