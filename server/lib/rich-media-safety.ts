// Strict document/video validation and derivative generation for user uploads.
// Paths and filenames never enter the public attachment contract. Inputs are
// bounded bytes from the authenticated binary route; no URL/path ingestion.

import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { MediaMime } from '../../shared/media-attachment.js'

export const MAX_RICH_MEDIA_BYTES = 64 * 1024 * 1024
export const MAX_DOCUMENT_TEXT_CHARS = 100_000
export const MAX_VIDEO_DURATION_MS = 20 * 60_000
export const MAX_DERIVATIVE_IMAGES = 8
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

export interface PreparedDocument {
  category: 'document'
  mime: Extract<MediaMime, 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json' | 'application/pdf'>
  original: Buffer
  extractedText: string
  textTruncated: boolean
  pageImages: Buffer[]
}

export interface PreparedVideo {
  category: 'video'
  mime: Extract<MediaMime, 'video/mp4' | 'video/quicktime'>
  original: Buffer
  width: number
  height: number
  durationMs: number
  frames: Buffer[]
}

export type PreparedRichMedia = PreparedDocument | PreparedVideo

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

function isIsoBmff(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp'
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

async function processPdf(bytes: Buffer): Promise<PreparedDocument> {
  const root = mkdtempSync(join(tmpdir(), 'cos-pdf-'))
  const input = join(root, 'input.pdf')
  const output = join(root, 'content.txt')
  const pagesPrefix = join(root, 'page')
  try {
    writeFileSync(input, bytes, { mode: 0o600 })
    await runProcess('pdftotext', ['-layout', '-enc', 'UTF-8', input, output])
    const rawText = readFileSync(output, 'utf8')
    const capped = capText(rawText)
    const pageImages: Buffer[] = []
    try {
      await runProcess('pdftoppm', ['-jpeg', '-r', '120', '-f', '1', '-l', String(MAX_DERIVATIVE_IMAGES), input, pagesPrefix])
      for (const name of readdirSync(root).filter(name => /^page-\d+\.jpg$/i.test(name)).sort().slice(0, MAX_DERIVATIVE_IMAGES)) {
        pageImages.push(readFileSync(join(root, name)))
      }
    } catch (error) {
      if (capped.text.length === 0) throw error
    }
    if (capped.text.length === 0 && pageImages.length === 0) {
      throw new RichMediaSafetyError('corrupt_attachment', 'PDF contains no extractable text or pages')
    }
    return {
      category: 'document', mime: 'application/pdf', original: bytes,
      extractedText: capped.text, textTruncated: capped.truncated, pageImages,
    }
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* private tmp cleanup */ }
  }
}

interface ProbePayload {
  format?: { duration?: string; format_name?: string; tags?: Record<string, string> }
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>
}

async function processVideo(bytes: Buffer, label: string | undefined, declaredMime: string | undefined): Promise<PreparedVideo> {
  const root = mkdtempSync(join(tmpdir(), 'cos-video-'))
  const ext = fileExtension(label) === '.mov' ? '.mov' : '.mp4'
  const input = join(root, `input${ext}`)
  const probePath = join(root, 'probe.json')
  try {
    writeFileSync(input, bytes, { mode: 0o600 })
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
    const frameCount = Math.min(MAX_DERIVATIVE_IMAGES, Math.max(1, Math.ceil(durationMs / 15_000)))
    const fps = Math.max(0.001, frameCount / (durationMs / 1000))
    await runProcess('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', input,
      '-vf', `fps=${fps.toFixed(6)},scale=1280:-2:force_original_aspect_ratio=decrease`,
      '-frames:v', String(frameCount), '-q:v', '3', join(root, 'frame-%02d.jpg'),
    ])
    const frames = readdirSync(root)
      .filter(name => /^frame-\d+\.jpg$/i.test(name)).sort().slice(0, MAX_DERIVATIVE_IMAGES)
      .map(name => readFileSync(join(root, name)))
    if (frames.length === 0) throw new RichMediaSafetyError('corrupt_attachment', 'video produced no review frames')
    const mime: PreparedVideo['mime'] = declaredMime === 'video/quicktime' || ext === '.mov'
      ? 'video/quicktime' : 'video/mp4'
    return {
      category: 'video', mime, original: bytes,
      width: Math.floor(stream.width!), height: Math.floor(stream.height!), durationMs, frames,
    }
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* private tmp cleanup */ }
  }
}

export async function prepareRichMedia(
  bytes: Buffer,
  options: { label?: string; declaredMime?: string },
): Promise<PreparedRichMedia> {
  if (bytes.length === 0) throw new RichMediaSafetyError('corrupt_attachment', 'attachment is empty')
  if (bytes.length > MAX_RICH_MEDIA_BYTES) {
    throw new RichMediaSafetyError('attachment_too_large', `attachment exceeds ${MAX_RICH_MEDIA_BYTES} byte limit`)
  }
  if (isPdf(bytes)) return processPdf(bytes)
  if (isIsoBmff(bytes)) return processVideo(bytes, options.label, options.declaredMime)

  const ext = fileExtension(options.label)
  const declared = (options.declaredMime ?? '').toLowerCase().split(';', 1)[0]
  const textMime: PreparedDocument['mime'] | null = ext === '.md' || ext === '.markdown' || declared === 'text/markdown'
    ? 'text/markdown'
    : ext === '.csv' || declared === 'text/csv'
      ? 'text/csv'
      : ext === '.json' || declared === 'application/json'
        ? 'application/json'
        : ext === '.txt' || declared === 'text/plain'
          ? 'text/plain'
          : null
  if (!textMime) throw new RichMediaSafetyError('unsupported_attachment_format', 'supported files: TXT, MD, CSV, JSON, PDF, MP4, MOV')
  const capped = capText(decodeStrictUtf8(bytes))
  return {
    category: 'document', mime: textMime, original: bytes,
    extractedText: capped.text, textTruncated: capped.truncated, pageImages: [],
  }
}
