// Speaker shadow mode (6.95.0): the whole-call timeline and the production segments.
//
// A port of round3/propose.py `build_timeline` and its segment loop. READ ONLY: it reads
// the finalized sidecar and the retained chunk WAVs and returns buffers; it never writes.
//
// Placement policy (the canary's): each original chunk starts at floor(elapsed_ms*16+.5),
// rows sort by (start, raw index), an original's tail that runs into the next one's start
// is trimmed, and gaps stay zero. Every original with an `audioSha256` must still match
// it, and each file is read twice with the second read required to hash the same as the
// first, which is what the tool's "rebuild twice, same PCM SHA" check proves.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { hasMacSpeakerProtectedRows } from './mac-speaker-protection.js'
import { SHADOW_SAMPLE_RATE, isShadowVoiceLabel, type ShadowSegment, type ShadowSegmentSource } from './speaker-shadow-decide.js'
import { PY_SPACE_CLASS, pyRoundInt } from './speaker-shadow-numeric.js'

/** A meeting longer than this is not reconstructed (the timeline buffer is 115 MB per hour). */
export const SHADOW_MAX_TIMELINE_SECONDS = 4 * 60 * 60

export class ShadowInputError extends Error {
  constructor(readonly reason: 'bad_sidecar' | 'audio_missing' | 'audio_format' | 'audio_drift' | 'too_long', message: string) {
    super(message)
    this.name = 'ShadowInputError'
  }
}

export interface ShadowChunkEntry { chunkIndex: number; chunk: Record<string, unknown> }
export interface ShadowTimelineRow { rawChunkIndex: number; startSample: number; sampleCount: number; usedSampleCount: number }
export interface ShadowTimeline {
  rows: ShadowTimelineRow[]
  pcm: Buffer
  total: number
  verified: number
  unhashed: number
  unhashedWithText: number[]
  pcmSHA256: string
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const PY_STRIP = new RegExp(`^${PY_SPACE_CLASS}+|${PY_SPACE_CLASS}+$`, 'gu')

/** Validated entries in sidecar order, or a bad_sidecar error. */
export function shadowEntries(sidecar: Record<string, unknown>): ShadowChunkEntry[] {
  const raw = sidecar.chunkEntries
  if (!Array.isArray(raw) || !raw.length) throw new ShadowInputError('bad_sidecar', 'the sidecar has no chunkEntries')
  const seen = new Set<number>()
  return raw.map(item => {
    const e = item as { chunkIndex?: unknown; chunk?: unknown }
    if (!e || typeof e !== 'object' || !Number.isInteger(e.chunkIndex) || (e.chunkIndex as number) < 0 || (e.chunkIndex as number) > 99_999) throw new ShadowInputError('bad_sidecar', 'a chunk entry has no valid chunkIndex')
    if (!e.chunk || typeof e.chunk !== 'object' || Array.isArray(e.chunk)) throw new ShadowInputError('bad_sidecar', 'a chunk entry has no chunk')
    const chunk = e.chunk as Record<string, unknown>
    if (typeof chunk.elapsed !== 'number' || !Number.isFinite(chunk.elapsed)) throw new ShadowInputError('bad_sidecar', 'a chunk has no elapsed clock')
    if (chunk.segments !== undefined && !Array.isArray(chunk.segments)) throw new ShadowInputError('bad_sidecar', 'a chunk has malformed segments')
    if (seen.has(e.chunkIndex as number)) throw new ShadowInputError('bad_sidecar', 'duplicate chunkIndex')
    seen.add(e.chunkIndex as number)
    return { chunkIndex: e.chunkIndex as number, chunk }
  })
}

/** propose.py labels_of: what a later correction would change. Hashed, so a run can refuse labels that moved after finalize. */
export function shadowLabelsHash(entries: readonly ShadowChunkEntry[]): string {
  const projection = entries.map(e => [
    e.chunkIndex,
    e.chunk.speaker ?? null,
    ((e.chunk.segments as unknown[] | undefined) ?? []).map(s => {
      const seg = (s ?? {}) as Record<string, unknown>
      return [seg.speaker ?? null, seg.startSec ?? null, seg.endSec ?? null]
    }),
  ])
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex')
}

/** Python `wave` read of a 16 kHz mono 16-bit PCM file: the declared frames and their bytes. */
export function readPcm16Wav(wav: Buffer): { sampleCount: number; pcm: Buffer } {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new ShadowInputError('audio_format', 'not a RIFF/WAVE file')
  let offset = 12, fmtOk = false
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      if (body + 16 > wav.length) throw new ShadowInputError('audio_format', 'truncated fmt chunk')
      const format = wav.readUInt16LE(body), channels = wav.readUInt16LE(body + 2), rate = wav.readUInt32LE(body + 4), bits = wav.readUInt16LE(body + 14)
      if (format !== 1 || channels !== 1 || rate !== SHADOW_SAMPLE_RATE || bits !== 16) throw new ShadowInputError('audio_format', `expected 16 kHz mono PCM16, got format ${format}, ${channels} ch, ${rate} Hz, ${bits} bit`)
      fmtOk = true
    } else if (id === 'data') {
      if (!fmtOk) throw new ShadowInputError('audio_format', 'data before fmt')
      const sampleCount = Math.floor(size / 2)
      if (body + sampleCount * 2 > wav.length) throw new ShadowInputError('audio_format', 'truncated data chunk')
      return { sampleCount, pcm: wav.subarray(body, body + sampleCount * 2) }
    }
    offset = body + size + (size % 2)
  }
  throw new ShadowInputError('audio_format', 'no data chunk')
}

/** The 44-byte header Python's wave writer emits, then the PCM. */
export function pcm16WavFile(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(SHADOW_SAMPLE_RATE, 24)
  header.writeUInt32LE(SHADOW_SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function readOriginal(path: string): Promise<Buffer> {
  try { return await readFile(path) } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    throw new ShadowInputError(code === 'ENOENT' ? 'audio_missing' : 'audio_format', `original ${path.split('/').pop()}: ${code ?? 'unreadable'}`)
  }
}

/** Every original verified, placed and copied into one PCM buffer. Async reads, one file at a time. */
export async function buildShadowTimeline(entries: readonly ShadowChunkEntry[], originalPath: (chunkIndex: number) => string): Promise<ShadowTimeline> {
  const SR = SHADOW_SAMPLE_RATE
  let verified = 0
  const unhashed: number[] = [], unhashedWithText: number[] = []
  const firstHash = new Map<number, string>()
  const rows: Array<ShadowTimelineRow & { path: string }> = []
  for (const e of entries) {
    const path = originalPath(e.chunkIndex)
    const bytes = await readOriginal(path)
    const digest = sha256(bytes)
    const want = e.chunk.audioSha256
    if (typeof want === 'string' && want) {
      if (digest !== want) throw new ShadowInputError('audio_drift', `original ${e.chunkIndex} no longer matches the sidecar audioSha256`)
      verified++
    } else {
      unhashed.push(e.chunkIndex)
      const text = typeof e.chunk.text === 'string' ? e.chunk.text : ''
      if (text.replace(PY_STRIP, '')) unhashedWithText.push(e.chunkIndex)
    }
    const { sampleCount } = readPcm16Wav(bytes)
    firstHash.set(e.chunkIndex, digest)
    rows.push({ rawChunkIndex: e.chunkIndex, startSample: Math.floor((e.chunk.elapsed as number) * 16 + 0.5), sampleCount, usedSampleCount: 0, path })
  }
  rows.sort((a, b) => (a.startSample - b.startSample) || (a.rawChunkIndex - b.rawChunkIndex))
  if (rows[0].startSample < 0) throw new ShadowInputError('bad_sidecar', 'a chunk starts before the recording')
  const total = Math.max(...rows.map(x => x.startSample + x.sampleCount))
  if (total > SHADOW_MAX_TIMELINE_SECONDS * SR) throw new ShadowInputError('too_long', `the meeting is longer than ${SHADOW_MAX_TIMELINE_SECONDS / 3600} h`)
  const pcm = Buffer.alloc(total * 2)
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i]
    const bytes = await readOriginal(x.path)
    if (sha256(bytes) !== firstHash.get(x.rawChunkIndex)) throw new ShadowInputError('audio_drift', `original ${x.rawChunkIndex} changed while the timeline was built`)
    const raw = readPcm16Wav(bytes).pcm
    const use = i + 1 < rows.length ? Math.min(x.sampleCount, Math.max(0, rows[i + 1].startSample - x.startSample)) : x.sampleCount
    if (!(use > 0)) throw new ShadowInputError('bad_sidecar', `original ${x.rawChunkIndex} is fully shadowed by the next one`)
    x.usedSampleCount = use
    raw.copy(pcm, x.startSample * 2, 0, use * 2)
  }
  return {
    rows: rows.map(({ path: _path, ...row }) => row),
    pcm, total, verified, unhashed: unhashed.length, unhashedWithText, pcmSHA256: sha256(pcm),
  }
}

/** propose.py's segment loop: production labels on the timeline, plus where each came from. */
export function shadowProductionSegments(entries: readonly ShadowChunkEntry[], rows: readonly ShadowTimelineRow[], total: number): { segs: ShadowSegment[]; sources: ShadowSegmentSource[] } {
  const SR = SHADOW_SAMPLE_RATE
  const placed = new Map(rows.map(x => [x.rawChunkIndex, x]))
  // Python's isinstance(x, (int, float)) is true for a JSON boolean, which counts as 0 or 1.
  const num = (x: unknown): number | null => typeof x === 'number' ? x : typeof x === 'boolean' ? Number(x) : null
  const segs: ShadowSegment[] = [], sources: ShadowSegmentSource[] = []
  for (const e of entries) {
    const x = placed.get(e.chunkIndex)!
    const off = x.startSample, end = Math.min(total, off + x.usedSampleCount)
    for (const raw of (e.chunk.segments as unknown[] | undefined) ?? []) {
      const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const a = num(s.startSec), b = num(s.endSec), label = s.speaker
      if (a === null || b === null || !label) continue
      if (typeof label !== 'string') throw new ShadowInputError('bad_sidecar', 'a segment speaker is not a string')
      const lo = off + pyRoundInt(a * SR), hi = Math.min(end, off + pyRoundInt(b * SR))
      if (lo < hi) {
        segs.push([lo, hi, label])
        sources.push({ chunkIndex: e.chunkIndex, start: a, end: Math.min(b, x.usedSampleCount / SR), abs: lo / SR })
      }
    }
  }
  return { segs, sources }
}

/** Voice labels that appear on any chunk a human touched. A hint in the record; it never changes a gate. */
export function shadowHumanProtectedVoices(entries: readonly ShadowChunkEntry[]): string[] {
  const out = new Set<string>()
  for (const e of entries) {
    if (!hasMacSpeakerProtectedRows(e.chunk)) continue
    const labels = [e.chunk.speaker, ...((e.chunk.segments as unknown[] | undefined) ?? []).map(s => (s as Record<string, unknown> | null)?.speaker)]
    for (const label of labels) if (typeof label === 'string' && isShadowVoiceLabel(label)) out.add(label)
  }
  return [...out].sort()
}

/** The meeting's title (the saved markdown's `# ` line), else the sidecar's file name. Read only. */
export async function readShadowMeetingTitle(sidecarPath: string): Promise<string> {
  const fallback = basename(sidecarPath).replace(/\.g2-chunks\.json$/, '')
  try {
    const text = await readFile(sidecarPath.replace(/\.g2-chunks\.json$/, '.md'), 'utf8')
    const line = text.split('\n', 40).find(l => l.startsWith('# '))
    const title = line?.slice(2).trim()
    return title ? title.slice(0, 160) : fallback
  } catch { return fallback }
}

/** The meeting day for the report folder: the sidecar name's YYYY-MM-DD prefix, else null. */
export function shadowMeetingDay(sidecarPath: string): string | null {
  return /^(\d{4}-\d{2}-\d{2})/.exec(basename(sidecarPath))?.[1] ?? null
}
