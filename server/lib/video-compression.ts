// x265 re-encode for stored video. Bitrate only, never geometry: resolution and
// frame rate are what later frame-mining depends on and upscaling cannot recover
// them, so no scale filter is ever added and an output whose geometry drifted from
// the input is rejected rather than kept.
//
// Measured on the real 3840x2160 30fps 25.5 Mbps phone upload (2026-08-10):
//   libx265 -crf 30                        2.7x smaller, SSIM 0.969  <- chosen
//   libx265 -crf 34                        5.5x smaller, SSIM 0.953
//   hevc_videotoolbox at comparable size   SSIM 0.858
// Hardware encoding is far worse per byte, which is why this runs SOFTWARE x265
// despite being roughly real time. Two other settings tried produced files LARGER
// than the source, which is why the size comparison below is a real guard.
//
// This module knows nothing about the media store: it takes a path, returns a path
// inside workDir, and never modifies or deletes its input. Placement is the caller's
// job through the existing rename boundary in media-store.ts.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { getRichMediaProcessingCapabilities } from './rich-media-safety.js'

export const VIDEO_COMPRESSION_CRF = 30
export const VIDEO_COMPRESSION_LABEL = 'x265-crf30'

const PROBE_TIMEOUT_MS = 10_000
const PROCESS_STDOUT_MAX = 64_000
const PROCESS_STDERR_MAX = 8_192
const REASON_MAX_CHARS = 200
// x265 -preset medium encodes at roughly real time on the measured 4K asset, so 4x
// duration is headroom for a loaded machine without letting a background encode run
// unbounded. A timeout costs only wasted CPU — the original is never touched — so the
// ceiling is allowed to be generous rather than trying to cover the 20-minute ingest
// cap, which no sane wall-clock bound could.
const ENCODE_TIMEOUT_PER_SECOND_MS = 4_000
const ENCODE_TIMEOUT_FLOOR_MS = 60_000
const ENCODE_TIMEOUT_CEILING_MS = 20 * 60_000
const UNKNOWN_DURATION_TIMEOUT_MS = 5 * 60_000
// hevc decode runs many times faster than encode; this only has to prove the file
// parses end to end.
const DECODE_TIMEOUT_FLOOR_MS = 30_000
const DECODE_TIMEOUT_CEILING_MS = 5 * 60_000
// ffprobe reports rationals, so 30/1 and 30000/1001 both parse to floats. 0.01 fps is
// looser than float noise and still tighter than every real rate change worth
// catching (29.97 vs 30 differ by 0.03).
const FPS_EQUALITY_TOLERANCE = 0.01

let timeoutOverrides: { encodeMs?: number; decodeMs?: number } | null = null

export type CompressionStatus =
  | 'compressed'            // outputPath is a validated, smaller file
  | 'skipped_unavailable'   // ffmpeg or ffprobe missing
  | 'skipped_not_smaller'   // encode produced >= input; keep the original
  | 'skipped_not_video'
  | 'failed'                // encode or validation failed; keep the original

export interface CompressionResult {
  status: CompressionStatus
  outputPath?: string
  originalBytes: number
  compressedBytes?: number
  width?: number
  height?: number
  reason?: string           // bounded, safe to log, never a full path
}

type ProcessOutcome =
  | { kind: 'ok'; stdout: string }
  | { kind: 'rejected'; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'unavailable' }
  | { kind: 'spawn_error'; message: string }

interface ProbeStream {
  codec_type?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
}

interface ProbePayload {
  format?: { duration?: string }
  streams?: ProbeStream[]
}

interface VideoGeometry {
  width: number
  height: number
  fps: number | null
  durationMs: number | null
}

type ProbeOutcome =
  | { kind: 'ok'; geometry: VideoGeometry }
  | { kind: 'no_video' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; reason: string }

/**
 * Reasons are logged, and the attachment contract has always refused to let paths or
 * filenames reach a log line. Known paths are replaced by name first, then any
 * remaining separator-bearing token is scrubbed as a backstop.
 */
function boundedReason(text: string, paths: string[] = []): string {
  let scrubbed = text
  for (const path of paths) {
    if (!path) continue
    scrubbed = scrubbed.split(path).join('[path]')
    // Only strip a bare basename that actually looks like a filename. A directory's
    // basename is often an ordinary word ('work', 'data') and blanket substitution
    // would mangle the diagnostic instead of protecting it.
    const name = basename(path)
    if (name.length >= 5 && name.includes('.')) scrubbed = scrubbed.split(name).join('[file]')
  }
  return scrubbed
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .split(' ')
    .map(word => (word.includes('/') || word.includes('\\') ? '[path]' : word))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_MAX_CHARS)
}

/** Same spawn/timeout/stderr idiom as the ffprobe call in rich-media-safety.ts. */
async function runBounded(command: string, args: string[], timeoutMs: number): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>(resolve => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (outcome: ProcessOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return resolve({ kind: 'spawn_error', message: (error as Error).message })
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      finish({ kind: 'timeout' })
    }, timeoutMs)
    timer.unref?.()
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < PROCESS_STDOUT_MAX) stdout += chunk.toString('utf8')
    })
    // Tail, not head: libx265 prints a long info banner before any real error, so the
    // diagnostic line is at the end of stderr rather than the start.
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-PROCESS_STDERR_MAX)
    })
    proc.once('error', error => {
      const enoent = (error as NodeJS.ErrnoException).code === 'ENOENT'
      finish(enoent ? { kind: 'unavailable' } : { kind: 'spawn_error', message: error.message })
    })
    proc.once('close', code => {
      finish(code === 0 ? { kind: 'ok', stdout } : { kind: 'rejected', stderr })
    })
  })
}

function parseRate(value: string | undefined): number | null {
  if (!value) return null
  const [numerator, denominator] = value.split('/')
  const top = Number(numerator)
  const bottom = denominator === undefined ? 1 : Number(denominator)
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top <= 0) return null
  return top / bottom
}

async function probeGeometry(path: string): Promise<ProbeOutcome> {
  const probe = await runBounded('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate',
    '-of', 'json', path,
  ], PROBE_TIMEOUT_MS)
  if (probe.kind === 'unavailable') return { kind: 'unavailable' }
  if (probe.kind === 'timeout') return { kind: 'failed', reason: 'ffprobe timed out' }
  if (probe.kind === 'spawn_error') return { kind: 'failed', reason: boundedReason(`ffprobe failed: ${probe.message}`, [path]) }
  // A non-zero probe means the bytes are not readable video at all. That is reported
  // as failed rather than skipped_not_video on purpose: skipped is silent, and a
  // caller handing this module a document or a truncated file should be visible.
  if (probe.kind === 'rejected') return { kind: 'failed', reason: boundedReason('ffprobe rejected input', [path]) }

  let payload: ProbePayload
  try {
    payload = JSON.parse(probe.stdout) as ProbePayload
  } catch {
    return { kind: 'failed', reason: 'ffprobe returned invalid metadata' }
  }
  const stream = payload.streams?.find(item => item.codec_type === 'video')
  if (!stream) return { kind: 'no_video' }
  const width = Number(stream.width)
  const height = Number(stream.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { kind: 'failed', reason: 'video stream has no usable dimensions' }
  }
  const durationSeconds = Number(payload.format?.duration)
  return {
    kind: 'ok',
    geometry: {
      width,
      height,
      fps: parseRate(stream.r_frame_rate) ?? parseRate(stream.avg_frame_rate),
      durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds * 1000)
        : null,
    },
  }
}

function encodeTimeoutMs(durationMs: number | null): number {
  if (timeoutOverrides?.encodeMs !== undefined) return timeoutOverrides.encodeMs
  if (durationMs === null) return UNKNOWN_DURATION_TIMEOUT_MS
  const scaled = Math.round((durationMs / 1000) * ENCODE_TIMEOUT_PER_SECOND_MS)
  return Math.min(ENCODE_TIMEOUT_CEILING_MS, Math.max(ENCODE_TIMEOUT_FLOOR_MS, scaled))
}

function decodeTimeoutMs(durationMs: number | null): number {
  if (timeoutOverrides?.decodeMs !== undefined) return timeoutOverrides.decodeMs
  if (durationMs === null) return DECODE_TIMEOUT_FLOOR_MS
  return Math.min(DECODE_TIMEOUT_CEILING_MS, Math.max(DECODE_TIMEOUT_FLOOR_MS, durationMs))
}

/** Only ever called on our own output inside workDir; force means a missing file is fine. */
function discardOutput(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* work-dir cleanup is best effort; the caller's retention clock sweeps the rest */
  }
}

/**
 * Re-encode one video to x265 inside workDir. Never touches inputPath, never writes
 * outside workDir, and every failure mode leaves the original as the only thing the
 * caller needs to keep.
 */
export async function compressVideoFile(
  inputPath: string,
  workDir: string,
): Promise<CompressionResult> {
  let originalBytes: number
  try {
    const stat = statSync(inputPath)
    if (!stat.isFile()) return { status: 'failed', originalBytes: 0, reason: 'input is not a regular file' }
    originalBytes = stat.size
  } catch {
    return { status: 'failed', originalBytes: 0, reason: 'input is unreadable' }
  }
  if (originalBytes === 0) return { status: 'failed', originalBytes: 0, reason: 'input is empty' }

  // Gated on the detection health already polls, so this never becomes a second probe
  // of the same two binaries that can disagree with what health advertises.
  const capabilities = await getRichMediaProcessingCapabilities()
  if (!capabilities.video) {
    return { status: 'skipped_unavailable', originalBytes, reason: 'ffmpeg or ffprobe unavailable' }
  }

  const source = await probeGeometry(inputPath)
  if (source.kind === 'unavailable') return { status: 'skipped_unavailable', originalBytes, reason: 'ffprobe unavailable' }
  if (source.kind === 'no_video') return { status: 'skipped_not_video', originalBytes, reason: 'input has no video stream' }
  if (source.kind === 'failed') return { status: 'failed', originalBytes, reason: source.reason }
  const { width, height, fps, durationMs } = source.geometry

  try {
    mkdirSync(workDir, { recursive: true })
  } catch {
    return { status: 'failed', originalBytes, width, height, reason: 'work directory unavailable' }
  }

  // Keep the input's container: -tag:v hvc1 is valid in MP4 and QuickTime alike, while
  // remuxing a .mov into .mp4 can fail outright on an audio codec MP4 has no tag for,
  // wasting the whole encode. Same .mov/.mp4 choice rich-media-safety.ts makes.
  const suffix = extname(inputPath).toLowerCase() === '.mov' ? '.mov' : '.mp4'
  const outputPath = join(workDir, `cos-x265-${randomBytes(6).toString('hex')}${suffix}`)
  const scrub = [inputPath, outputPath, workDir]

  const encode = await runBounded('ffmpeg', [
    '-nostdin', '-v', 'error', '-y',
    '-i', inputPath,
    '-c:v', 'libx265', '-crf', String(VIDEO_COMPRESSION_CRF), '-preset', 'medium', '-tag:v', 'hvc1',
    '-c:a', 'copy',
    outputPath,
  ], encodeTimeoutMs(durationMs))
  if (encode.kind !== 'ok') {
    // A killed or rejected ffmpeg leaves a partial file behind; it must not survive to
    // look like a finished encode to anything that scans workDir.
    discardOutput(outputPath)
    if (encode.kind === 'unavailable') {
      return { status: 'skipped_unavailable', originalBytes, width, height, reason: 'ffmpeg unavailable' }
    }
    if (encode.kind === 'timeout') {
      return { status: 'failed', originalBytes, width, height, reason: `encode timed out after ${encodeTimeoutMs(durationMs)}ms` }
    }
    const detail = encode.kind === 'rejected' ? encode.stderr : encode.message
    return { status: 'failed', originalBytes, width, height, reason: boundedReason(`encode failed: ${detail}`, scrub) }
  }

  let compressedBytes: number
  try {
    compressedBytes = statSync(outputPath).size
  } catch {
    return { status: 'failed', originalBytes, width, height, reason: 'encode produced no output file' }
  }
  if (compressedBytes === 0) {
    discardOutput(outputPath)
    return { status: 'failed', originalBytes, compressedBytes, width, height, reason: 'encode produced an empty file' }
  }
  // Measured: two encoder settings inflated the real 4K asset. A larger "compressed"
  // file is strictly worse than the original, so this is a skip and not a result.
  if (compressedBytes >= originalBytes) {
    discardOutput(outputPath)
    return { status: 'skipped_not_smaller', originalBytes, compressedBytes, width, height }
  }

  const encoded = await probeGeometry(outputPath)
  if (encoded.kind !== 'ok') {
    discardOutput(outputPath)
    const reason = encoded.kind === 'failed' ? encoded.reason : `output probe returned ${encoded.kind}`
    return { status: 'failed', originalBytes, compressedBytes, width, height, reason: boundedReason(`output unverifiable: ${reason}`, scrub) }
  }
  if (encoded.geometry.width !== width || encoded.geometry.height !== height) {
    discardOutput(outputPath)
    return {
      status: 'failed', originalBytes, compressedBytes, width, height,
      reason: `output ${encoded.geometry.width}x${encoded.geometry.height} differs from input ${width}x${height}`,
    }
  }
  // Only enforced when the input's own rate is readable — a genuinely variable-rate
  // source reports 0/0 and has no rate to preserve.
  if (fps !== null) {
    if (encoded.geometry.fps === null) {
      discardOutput(outputPath)
      return { status: 'failed', originalBytes, compressedBytes, width, height, reason: 'output frame rate unreadable' }
    }
    if (Math.abs(encoded.geometry.fps - fps) > FPS_EQUALITY_TOLERANCE) {
      discardOutput(outputPath)
      return {
        status: 'failed', originalBytes, compressedBytes, width, height,
        reason: `output ${encoded.geometry.fps.toFixed(3)} fps differs from input ${fps.toFixed(3)} fps`,
      }
    }
  }

  // Prove it decodes end to end before anyone is told this file can replace the
  // original. Exit code alone from the encode does not establish that.
  const decode = await runBounded('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-',
  ], decodeTimeoutMs(durationMs))
  if (decode.kind !== 'ok') {
    discardOutput(outputPath)
    const detail = decode.kind === 'rejected'
      ? decode.stderr
      : decode.kind === 'spawn_error' ? decode.message : decode.kind
    return {
      status: 'failed', originalBytes, compressedBytes, width, height,
      reason: boundedReason(`output failed decode validation: ${detail}`, scrub),
    }
  }

  return { status: 'compressed', outputPath, originalBytes, compressedBytes, width, height }
}

/** Timeouts are minutes wide by design, so tests override them rather than wait. */
export function _setCompressionTimeoutOverridesForTests(
  overrides: { encodeMs?: number; decodeMs?: number } | null,
): void {
  timeoutOverrides = overrides
}
