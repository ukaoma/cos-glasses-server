// Strict document/video validation and derivative generation for user uploads.
// Paths and filenames never enter the public attachment contract. The upload
// body arrives as a STAGED FILE, not a Buffer: at the 100 MB video cap an
// in-memory body would be a 100 MB allocation per concurrent upload, and both
// ffprobe and pdftotext want a path anyway. No URL ingestion; the only paths
// accepted are ones this server staged itself.

import { spawn } from 'node:child_process'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { MediaMime } from '../../shared/media-attachment.js'

/** Images and documents — the contract's `otherMaxBytes`. Unchanged. */
export const MAX_OTHER_MEDIA_BYTES = 64 * 1024 * 1024          // 67108864
/** Video — the contract's `videoMaxBytes`. Measured: a real phone upload runs
 *  3840x2160/30fps at 25.5 Mbps, so 64 MiB buys ~21s and 100 MB buys ~31s.
 *  This does NOT unlock long video (a 3-minute 4K original is ~570 MB — only
 *  chunked upload unlocks length); it stops an ordinary clip being refused. */
export const MAX_VIDEO_MEDIA_BYTES = 100 * 1024 * 1024         // 104857600
/** Hard ceiling for any single-shot body, applied before its kind is known. */
export const MAX_SINGLE_SHOT_MEDIA_BYTES = Math.max(MAX_OTHER_MEDIA_BYTES, MAX_VIDEO_MEDIA_BYTES)
/** Advertised chunked-upload geometry (contract §1). Published on health so the
 *  client never hardcodes a cap; the two repos have already diverged once. */
export const MEDIA_CHUNK_BYTES = 8 * 1024 * 1024               // 8388608
export const MAX_CHUNKED_MEDIA_BYTES = 2 * 1024 * 1024 * 1024  // 2147483648
/** Mirrors VIDEO_COMPRESSION_LABEL in server/lib/video-compression.ts. It has
 *  to be a copy: that module imports getRichMediaProcessingCapabilities from
 *  THIS file, so importing its label back would be a circular import. The two
 *  are pinned together by a test instead of by the compiler. */
export const ADVERTISED_VIDEO_COMPRESSION_LABEL = 'x265-crf30'
/** Bytes needed to classify an upload from its magic numbers. ISO-BMFF needs
 *  12 ('ftyp' at offset 4); every other sniff here needs fewer. */
export const MEDIA_SNIFF_BYTES = 12
export const MAX_DOCUMENT_TEXT_CHARS = 100_000
export const MAX_VIDEO_DURATION_MS = 20 * 60_000
export const MAX_DERIVATIVE_IMAGES = 8

// ── Video summary frames ────────────────────────────────────────────────────────
// DELIBERATELY SEPARATE from MAX_DERIVATIVE_IMAGES, which the PDF path also uses
// (pdftoppm -l): raising that shared constant would silently give every PDF 16 pages.
//
// What was here: min(8, max(1, ceil(durationMs / 15_000))) — one frame per 15 seconds,
// capped at 8. Measured against real assets that produced:
//   11.7s 4K clip     ->  1 frame
//   43.6s fridge sweep ->  3 frames   (Msg 796: "I only got 3 samples")
//   20 min (the cap)  ->  8 frames, one per 2.5 MINUTES
// A 12-second video summarised by a single still is not a summary, and 3 frames missed
// the entire contents of a refrigerator the user was asking about.
export const VIDEO_SUMMARY_FRAMES_MIN = 8
export const VIDEO_SUMMARY_FRAMES_MAX = 16
/** One frame per ~6s of footage, between the floor and the ceiling. */
const VIDEO_SUMMARY_SECONDS_PER_FRAME = 6
/** Candidates sampled per window; the sharpest one is kept. More candidates cost
 *  only temp I/O, but the search is pointless beyond a handful per window. */
export const VIDEO_SUMMARY_CANDIDATES_PER_FRAME = 5

/**
 * How many stills represent a video.
 *
 * Uniform intervals, not random: random sampling clusters and leaves gaps, while a
 * uniform grid provably covers start to finish and is reproducible across runs — which
 * matters when the same video is asked about twice.
 *
 * 12 frames is the target for a typical clip: roughly one per 8% of the runtime, about
 * 15K tokens at 1280px wide, leaving room for a transcript and the question in one turn.
 * Below the floor of 8 whole segments go unseen; above the ceiling of 16 the marginal
 * still adds little to a SUMMARY and that budget is better spent on a targeted
 * native-resolution pass over a named time window.
 */
export function videoSummaryFrameCount(durationMs: number): number {
  const seconds = Number.isFinite(durationMs) ? Math.max(0, durationMs) / 1000 : 0
  const scaled = Math.round(seconds / VIDEO_SUMMARY_SECONDS_PER_FRAME)
  return Math.min(VIDEO_SUMMARY_FRAMES_MAX, Math.max(VIDEO_SUMMARY_FRAMES_MIN, scaled))
}

/**
 * Pick the sharpest candidate in each window, by encoded JPEG size.
 *
 * At a FIXED quality setting, a sharper frame carries more high-frequency detail and
 * therefore encodes larger; a motion-blurred one compresses down. Measured on the real
 * 480x360 fridge sweep: within one second the spread was 1.45x (27,311 vs 18,852 bytes),
 * and inspecting both ends confirmed it — the largest frame reads "Mootopia WHOLE / 13g /
 * LACTOSE FREE" and the smallest is unreadable smear. Those are the exact labels that
 * previously required a manual frame-by-frame pass to recover.
 *
 * This is a proxy, not a Laplacian: it needs no image library, no new dependency, and one
 * ffmpeg pass. It can be fooled by a window where the sharp frames are also the emptiest,
 * which costs a slightly worse still rather than a wrong answer.
 */
export function pickSharpestPerWindow(
  candidates: readonly { name: string; bytes: number }[],
  windows: number,
): string[] {
  if (candidates.length === 0 || windows <= 0) return []
  const ordered = [...candidates].sort((a, b) => a.name.localeCompare(b.name))
  const perWindow = Math.max(1, Math.floor(ordered.length / windows))
  const picked: string[] = []
  for (let w = 0; w < windows; w++) {
    const start = w * perWindow
    // The final window absorbs any remainder, so no candidate is silently dropped.
    const slice = w === windows - 1 ? ordered.slice(start) : ordered.slice(start, start + perWindow)
    if (slice.length === 0) continue
    picked.push(slice.reduce((best, c) => (c.bytes > best.bytes ? c : best), slice[0]).name)
  }
  return picked
}
const PROCESS_STDERR_MAX = 8_192
const PROCESS_TIMEOUT_MS = 30_000

let richMediaCapabilityCache: { pdf: boolean; video: boolean } | null = null

export type RichMediaErrorCode =
  | 'unsupported_attachment_format'
  | 'attachment_too_large'
  | 'corrupt_attachment'
  | 'attachment_processing_unavailable'
  | 'attachment_processing_failed'
  | 'video_too_long'

export class RichMediaSafetyError extends Error {
  constructor(readonly code: RichMediaErrorCode, message: string) {
    super(message)
    this.name = 'RichMediaSafetyError'
  }
}

/** The original stays on disk. `originalPath` is the staged file the caller
 *  handed in — the caller still owns it and MOVES it into place on publish. */
interface PreparedOriginalFile {
  originalPath: string
  originalBytes: number
}

export type PreparedDocumentFile = PreparedOriginalFile & {
  category: 'document'
  mime: Extract<MediaMime, 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json' | 'application/pdf'>
  extractedText: string
  textTruncated: boolean
  pageImages: Buffer[]
}

export type PreparedVideoFile = PreparedOriginalFile & {
  category: 'video'
  mime: Extract<MediaMime, 'video/mp4' | 'video/quicktime'>
  width: number
  height: number
  durationMs: number
  frames: Buffer[]
}

export type PreparedRichMediaFile = PreparedDocumentFile | PreparedVideoFile

export type PreparedDocument = Omit<PreparedDocumentFile, keyof PreparedOriginalFile> & { original: Buffer }
export type PreparedVideo = Omit<PreparedVideoFile, keyof PreparedOriginalFile> & { original: Buffer }
export type PreparedRichMedia = PreparedDocument | PreparedVideo

export interface MediaLimits {
  videoMaxBytes: number
  otherMaxBytes: number
  chunkedUploadEnabled: boolean
  chunkBytes: number
  chunkedMaxBytes: number
  videoCompression: string | null
}

/** The limits block published on GET /api/health. The server is the single
 *  authority: the client must read these rather than carry its own constants.
 *  `videoCompression` is null — not false — when ffmpeg/ffprobe are missing,
 *  because the field's value is the encode label the client displays. */
export async function getMediaLimits(
  options: { chunkedUploadEnabled: boolean },
): Promise<MediaLimits> {
  const capabilities = await getRichMediaProcessingCapabilities()
  return {
    videoMaxBytes: MAX_VIDEO_MEDIA_BYTES,
    otherMaxBytes: MAX_OTHER_MEDIA_BYTES,
    chunkedUploadEnabled: options.chunkedUploadEnabled,
    chunkBytes: MEDIA_CHUNK_BYTES,
    chunkedMaxBytes: MAX_CHUNKED_MEDIA_BYTES,
    videoCompression: capabilities.video ? ADVERTISED_VIDEO_COMPRESSION_LABEL : null,
  }
}

async function executableReady(command: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ready)
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(command, args, { stdio: 'ignore' })
    } catch {
      finish(false)
      return
    }
    timer = setTimeout(() => {
      proc.kill('SIGKILL')
      finish(false)
    }, 2_000)
    timer.unref?.()
    proc.once('error', () => finish(false))
    proc.once('close', code => finish(code === 0))
  })
}

/** Public capability only—never paths. Cached because health is polled often. */
export async function getRichMediaProcessingCapabilities(): Promise<{ pdf: boolean; video: boolean }> {
  if (richMediaCapabilityCache) return { ...richMediaCapabilityCache }
  const [pdftotext, pdftoppm, ffmpeg, ffprobe] = await Promise.all([
    executableReady('pdftotext', ['-v']),
    executableReady('pdftoppm', ['-v']),
    executableReady('ffmpeg', ['-version']),
    executableReady('ffprobe', ['-version']),
  ])
  richMediaCapabilityCache = { pdf: pdftotext && pdftoppm, video: ffmpeg && ffprobe }
  return { ...richMediaCapabilityCache }
}

export function _resetRichMediaCapabilityCacheForTests(): void {
  richMediaCapabilityCache = null
}

function boundedLabel(label: string | undefined): string {
  return (label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
}

function fileExtension(label: string | undefined): string {
  return extname(boundedLabel(label)).toLowerCase()
}

function isPdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-'
}

/** True when the leading bytes are ISO-BMFF (MP4/MOV). Decided from the magic
 *  numbers and never from the declared Content-Type, because this predicate
 *  also picks the byte cap: a text file claiming video/mp4 must not buy the
 *  100 MB ceiling. */
export function isVideoUploadHead(head: Buffer): boolean {
  return head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp'
}

/** Read only the leading bytes of a staged upload. Classification must not
 *  require loading a 100 MB body. */
function readHead(path: string, length = MEDIA_SNIFF_BYTES): Buffer {
  const buffer = Buffer.alloc(length)
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const read = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read)
  } catch {
    throw new RichMediaSafetyError('corrupt_attachment', 'staged attachment could not be read')
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* fd already gone */ }
    }
  }
}

function decodeStrictUtf8(bytes: Buffer): string {
  if (bytes.includes(0)) throw new RichMediaSafetyError('corrupt_attachment', 'text attachment contains NUL bytes')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new RichMediaSafetyError('corrupt_attachment', 'text attachment is not valid UTF-8')
  }
  const sample = text.slice(0, 20_000)
  const printable = [...sample].filter(ch => ch === '\n' || ch === '\r' || ch === '\t' || ch >= ' ').length
  if (sample.length > 0 && printable / sample.length < 0.9) {
    throw new RichMediaSafetyError('corrupt_attachment', 'text attachment contains too much control data')
  }
  return text.replace(/\r\n?/g, '\n')
}

function capText(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\u0000/g, '').trim()
  if (normalized.length <= MAX_DOCUMENT_TEXT_CHARS) return { text: normalized, truncated: false }
  return {
    text: `${normalized.slice(0, MAX_DOCUMENT_TEXT_CHARS)}\n\n[Document truncated by COS at ${MAX_DOCUMENT_TEXT_CHARS} characters.]`,
    truncated: true,
  }
}

async function runProcess(command: string, args: string[], timeoutMs = PROCESS_TIMEOUT_MS): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let stderr = ''
    const proc = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill('SIGKILL')
      reject(new RichMediaSafetyError('attachment_processing_failed', `${command} timed out`))
    }, timeoutMs)
    timer.unref?.()
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < PROCESS_STDERR_MAX) stderr += chunk.toString('utf8').slice(0, PROCESS_STDERR_MAX - stderr.length)
    })
    proc.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const code = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'attachment_processing_unavailable'
        : 'attachment_processing_failed'
      reject(new RichMediaSafetyError(code, `${command} unavailable: ${error.message}`))
    })
    proc.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new RichMediaSafetyError('corrupt_attachment', `${command} rejected attachment`))
    })
  })
}

async function processPdf(sourcePath: string, byteLength: number): Promise<PreparedDocumentFile> {
  // Derivatives go to a PRIVATE work dir, never beside the source: the staging
  // directory holds other concurrent uploads, and the page-image scan below is
  // a directory listing.
  const work = mkdtempSync(join(tmpdir(), 'cos-pdf-'))
  const output = join(work, 'content.txt')
  const pagesPrefix = join(work, 'page')
  try {
    await runProcess('pdftotext', ['-layout', '-enc', 'UTF-8', sourcePath, output])
    const rawText = readFileSync(output, 'utf8')
    const capped = capText(rawText)
    const pageImages: Buffer[] = []
    try {
      await runProcess('pdftoppm', ['-jpeg', '-r', '120', '-f', '1', '-l', String(MAX_DERIVATIVE_IMAGES), sourcePath, pagesPrefix])
      for (const name of readdirSync(work).filter(name => /^page-\d+\.jpg$/i.test(name)).sort().slice(0, MAX_DERIVATIVE_IMAGES)) {
        pageImages.push(readFileSync(join(work, name)))
      }
    } catch (error) {
      if (capped.text.length === 0) throw error
    }
    if (capped.text.length === 0 && pageImages.length === 0) {
      throw new RichMediaSafetyError('corrupt_attachment', 'PDF contains no extractable text or pages')
    }
    return {
      category: 'document', mime: 'application/pdf',
      originalPath: sourcePath, originalBytes: byteLength,
      extractedText: capped.text, textTruncated: capped.truncated, pageImages,
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* private tmp cleanup */ }
  }
}

interface ProbePayload {
  format?: { duration?: string; format_name?: string; tags?: Record<string, string> }
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>
}

async function processVideo(
  sourcePath: string,
  byteLength: number,
  label: string | undefined,
  declaredMime: string | undefined,
): Promise<PreparedVideoFile> {
  // Frames go to a private work dir; the source is read in place. ffprobe and
  // ffmpeg both identify ISO-BMFF by probing content, so the staged file needs
  // no .mp4/.mov extension — only the reported MIME depends on the label.
  const work = mkdtempSync(join(tmpdir(), 'cos-video-'))
  const ext = fileExtension(label) === '.mov' ? '.mov' : '.mp4'
  const input = sourcePath
  const probePath = join(work, 'probe.json')
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      const proc = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,width,height',
        '-of', 'json', input,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        proc.kill('SIGKILL')
        reject(new RichMediaSafetyError('attachment_processing_failed', 'ffprobe timed out'))
      }, 10_000)
      proc.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 64_000) stdout += chunk.toString('utf8') })
      proc.stderr.on('data', (chunk: Buffer) => { if (stderr.length < PROCESS_STDERR_MAX) stderr += chunk.toString('utf8') })
      proc.once('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new RichMediaSafetyError(
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'attachment_processing_unavailable' : 'attachment_processing_failed',
          `ffprobe unavailable: ${error.message}`,
        ))
      })
      proc.once('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          reject(new RichMediaSafetyError('corrupt_attachment', 'ffprobe rejected video'))
          return
        }
        writeFileSync(probePath, stdout, { mode: 0o600 })
        resolve()
      })
    })
    let probe: ProbePayload
    try { probe = JSON.parse(readFileSync(probePath, 'utf8')) as ProbePayload } catch {
      throw new RichMediaSafetyError('corrupt_attachment', 'ffprobe returned invalid metadata')
    }
    const stream = probe.streams?.find(item => item.codec_type === 'video')
    const durationMs = Math.round(Number(probe.format?.duration) * 1000)
    if (!stream || !Number.isFinite(stream.width) || !Number.isFinite(stream.height)
      || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new RichMediaSafetyError('corrupt_attachment', 'attachment has no valid video stream')
    }
    if (durationMs > MAX_VIDEO_DURATION_MS) {
      throw new RichMediaSafetyError('video_too_long', `video exceeds ${MAX_VIDEO_DURATION_MS / 60_000} minute limit`)
    }
    // Uniform windows across the whole runtime, then the SHARPEST candidate in each.
    // Sampling candidates at a duration-derived rate keeps the total constant no matter
    // how long the video is: a 20-minute recording costs the same temp I/O as a 12-second
    // one, in ONE ffmpeg pass.
    const frameCount = videoSummaryFrameCount(durationMs)
    const candidateCount = frameCount * VIDEO_SUMMARY_CANDIDATES_PER_FRAME
    const fps = Math.max(0.001, candidateCount / (durationMs / 1000))
    await runProcess('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', input,
      // min(1280,iw) rather than a bare 1280: the old filter UPSCALED a 480x360 source to
      // 1280x960, paying ~7x the image tokens for detail that was never captured. It only
      // ever downscales now.
      '-vf', `fps=${fps.toFixed(6)},scale='min(1280,iw)':-2`,
      '-frames:v', String(candidateCount), '-q:v', '3', join(work, 'cand-%04d.jpg'),
    ])
    const candidates = readdirSync(work)
      .filter(name => /^cand-\d+\.jpg$/i.test(name))
      .map(name => ({ name, bytes: statSync(join(work, name)).size }))
    const frames = pickSharpestPerWindow(candidates, frameCount)
      .map(name => readFileSync(join(work, name)))
    if (frames.length === 0) throw new RichMediaSafetyError('corrupt_attachment', 'video produced no review frames')
    const mime: PreparedVideoFile['mime'] = declaredMime === 'video/quicktime' || ext === '.mov'
      ? 'video/quicktime' : 'video/mp4'
    return {
      category: 'video', mime,
      originalPath: sourcePath, originalBytes: byteLength,
      width: Math.floor(stream.width!), height: Math.floor(stream.height!), durationMs, frames,
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* private tmp cleanup */ }
  }
}

/** Production entry point: validate an already-staged upload file in place.
 *  The returned `originalPath` is the caller's own staged file — this module
 *  never moves, renames, or deletes it. */
/**
 * How the bytes arrived. This decides the ceiling, and it has to be threaded in
 * rather than assumed.
 *
 * THE DEFECT THIS FIXES. finalize for a chunked upload calls this same function —
 * deliberately, so validation, the cap, the atomic rename and compression are not
 * forked. But it inherited the SINGLE-SHOT cap, so a 200 MB video transferred all
 * 25 chunks and was then refused at finalize with a raw 413. That is worse than the
 * feature not existing: before it, the same file was refused in milliseconds with a
 * readable message. Two independent reviewers found this, and the suite already
 * contained the proof (prepareRichMediaFromFile rejects above the cap) without ever
 * wiring it to the chunked route.
 */
export type MediaTransferMode = 'single_shot' | 'chunked'

/**
 * The applicable ceiling. Per-kind on purpose, and NOT a flat chunked number.
 *
 * Only VIDEO gets the chunked ceiling. Documents and images stay at the single-shot
 * cap even when chunked, because the text path does
 * `capText(decodeStrictUtf8(readFileSync(sourcePath)))` — a whole-file Buffer plus a
 * whole-file JS string. A 2 GiB .txt would allocate 2 GiB and then throw
 * ERR_STRING_TOO_LONG at V8's ~512 MB string limit, inside the request, in the
 * process that also owns the G2 bridge and whisper. Streaming the upload only to
 * blow up reading it back would defeat the entire point of the rewrite.
 */
export function mediaCeilingBytes(isVideo: boolean, transfer: MediaTransferMode = 'single_shot'): number {
  if (!isVideo) return MAX_OTHER_MEDIA_BYTES
  return transfer === 'chunked' ? MAX_CHUNKED_MEDIA_BYTES : MAX_VIDEO_MEDIA_BYTES
}

export async function prepareRichMediaFromFile(
  sourcePath: string,
  options: { label?: string; declaredMime?: string; byteLength: number; transfer?: MediaTransferMode },
): Promise<PreparedRichMediaFile> {
  if (options.byteLength === 0) throw new RichMediaSafetyError('corrupt_attachment', 'attachment is empty')
  const head = readHead(sourcePath)
  // Two caps now, so the cap check has to know WHAT it is looking at. The
  // classification is byte-authoritative for exactly that reason.
  const isVideo = isVideoUploadHead(head)
  const cap = mediaCeilingBytes(isVideo, options.transfer)
  if (options.byteLength > cap) {
    throw new RichMediaSafetyError('attachment_too_large', `attachment exceeds ${cap} byte limit`)
  }
  if (isPdf(head)) return processPdf(sourcePath, options.byteLength)
  if (isVideo) return processVideo(sourcePath, options.byteLength, options.label, options.declaredMime)

  const ext = fileExtension(options.label)
  const declared = (options.declaredMime ?? '').toLowerCase().split(';', 1)[0]
  const textMime: PreparedDocumentFile['mime'] | null = ext === '.md' || ext === '.markdown' || declared === 'text/markdown'
    ? 'text/markdown'
    : ext === '.csv' || declared === 'text/csv'
      ? 'text/csv'
      : ext === '.json' || declared === 'application/json'
        ? 'application/json'
        : ext === '.txt' || declared === 'text/plain'
          ? 'text/plain'
          : null
  if (!textMime) throw new RichMediaSafetyError('unsupported_attachment_format', 'supported files: TXT, MD, CSV, JSON, PDF, MP4, MOV')
  // Text has to be decoded to be validated at all, and it is bounded by the
  // 64 MiB `otherMaxBytes` cap enforced above.
  const capped = capText(decodeStrictUtf8(readFileSync(sourcePath)))
  return {
    category: 'document', mime: textMime,
    originalPath: sourcePath, originalBytes: options.byteLength,
    extractedText: capped.text, textTruncated: capped.truncated, pageImages: [],
  }
}

/** In-memory entry point for callers that already hold the bytes. Stages them
 *  to a private temp file and delegates, so there is exactly ONE validation
 *  path — a second one is a second place for the safety rules to rot. */
export async function prepareRichMedia(
  bytes: Buffer,
  options: { label?: string; declaredMime?: string },
): Promise<PreparedRichMedia> {
  if (bytes.length === 0) throw new RichMediaSafetyError('corrupt_attachment', 'attachment is empty')
  const work = mkdtempSync(join(tmpdir(), 'cos-attachment-'))
  const sourcePath = join(work, 'source.bin')
  try {
    writeFileSync(sourcePath, bytes, { mode: 0o600 })
    const prepared = await prepareRichMediaFromFile(sourcePath, {
      label: options.label,
      declaredMime: options.declaredMime,
      byteLength: bytes.length,
    })
    // The caller's Buffer IS the original — swap it in rather than reading the
    // staged copy back off disk.
    const { originalPath: _path, originalBytes: _bytes, ...rest } = prepared
    return { ...rest, original: bytes } as PreparedRichMedia
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* private tmp cleanup */ }
  }
}
