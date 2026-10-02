// Pure geometry between Nemotron's 10 ms speaker probabilities and transcript
// words. No I/O, no clock, no model: everything here is a function of its input
// so the live path, the final pass and the replay share one implementation.
//
// Coordinates: an Activity is a [frames x 8] matrix whose frame 0 is time 0 of
// the audio it was computed on (a chunk for the live path, the meeting timeline
// for the final pass). Times are seconds in that same coordinate system.

import type { WhisperWord } from './whisper-local.js'
import { NEMOTRON_CHANNELS } from './nemotron-cli.js'

export const ACTIVE_THRESHOLD = 0.5
const FPS = 100
const SAMPLES_PER_FRAME = 160
/** A channel shorter than this inside the span is noise, not a speaker. */
export const MIN_TRACK_SEC = 0.5
/** The voiceprint needs about this much of one voice to name it. */
export const NAME_TRACK_MIN_SEC = 2.0

export interface Activity {
  frames: number
  probs: Float32Array
}

export interface TokenTime {
  start: number
  end: number
}

export interface Track {
  channel: number
  /** Seconds the channel is active. */
  activeSec: number
  /** Seconds the channel is the only active channel. */
  exclusiveSec: number
}

export function isActive(a: Activity, frame: number, channel: number): boolean {
  return a.probs[frame * NEMOTRON_CHANNELS + channel] >= ACTIVE_THRESHOLD
}

export function frameRange(a: Activity, startSec: number, endSec: number): [number, number] {
  const f0 = Math.max(0, Math.min(a.frames, Math.round(startSec * FPS)))
  const f1 = Math.max(f0, Math.min(a.frames, Math.round(endSec * FPS)))
  return [f0, f1]
}

/** Channels holding at least minTrackSec inside [f0, f1), most active first. */
export function tracksIn(a: Activity, f0: number, f1: number, minTrackSec = MIN_TRACK_SEC): Track[] {
  const active = new Array<number>(NEMOTRON_CHANNELS).fill(0)
  const exclusive = new Array<number>(NEMOTRON_CHANNELS).fill(0)
  for (let f = Math.max(0, f0); f < Math.min(a.frames, f1); f++) {
    let n = 0
    let last = -1
    for (let c = 0; c < NEMOTRON_CHANNELS; c++) {
      if (isActive(a, f, c)) { active[c]++; n++; last = c }
    }
    if (n === 1) exclusive[last]++
  }
  const tracks: Track[] = []
  for (let c = 0; c < NEMOTRON_CHANNELS; c++) {
    if (active[c] / FPS >= minTrackSec) tracks.push({ channel: c, activeSec: active[c] / FPS, exclusiveSec: exclusive[c] / FPS })
  }
  return tracks.sort((x, y) => y.activeSec - x.activeSec || x.channel - y.channel)
}

/** Frames in [f0, f1) where any channel is active. */
export function speechFrames(a: Activity, f0: number, f1: number): number[] {
  const out: number[] = []
  for (let f = Math.max(0, f0); f < Math.min(a.frames, f1); f++) {
    for (let c = 0; c < NEMOTRON_CHANNELS; c++) {
      if (isActive(a, f, c)) { out.push(f); break }
    }
  }
  return out
}

/**
 * The channel that holds a span: the largest summed probability over frames
 * where the channel is active. Widened by padSec when nothing is active inside
 * the span (a word at the edge of a turn). Null when no channel is active nearby.
 */
export function channelForSpan(
  a: Activity,
  startSec: number,
  endSec: number,
  allowed?: ReadonlySet<number>,
  padSec = 0.3,
): number | null {
  const pick = (from: number, to: number): number | null => {
    const sums = new Array<number>(NEMOTRON_CHANNELS).fill(0)
    for (let f = Math.max(0, from); f < Math.min(a.frames, to); f++) {
      for (let c = 0; c < NEMOTRON_CHANNELS; c++) {
        if (allowed && !allowed.has(c)) continue
        const p = a.probs[f * NEMOTRON_CHANNELS + c]
        if (p >= ACTIVE_THRESHOLD) sums[c] += p
      }
    }
    let best: number | null = null
    for (let c = 0; c < NEMOTRON_CHANNELS; c++) {
      if (sums[c] > 0 && (best === null || sums[c] > sums[best])) best = c
    }
    return best
  }
  let [f0, f1] = frameRange(a, startSec, endSec)
  if (f1 <= f0) f1 = Math.min(a.frames, f0 + 1)
  const inside = pick(f0, f1)
  if (inside !== null) return inside
  const pad = Math.round(padSec * FPS)
  return pick(f0 - pad, f1 + pad)
}

const norm = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Text split so that joining with one space gives the text back exactly. */
export function splitTokens(text: string): string[] {
  return text.split(' ')
}

/** True when the token carries a spoken word (not empty, not bare punctuation). */
export function isWordToken(token: string): boolean {
  return norm(token).length > 0
}

/**
 * Times for each text token from ASR word timings, matched character by
 * character after normalising both sides. Whisper tokens can be sub-words
 * ("I", "'m") and corrections can rewrite words, so an exact 1:1 zip is wrong.
 * Returns null when fewer than 80% of word tokens find a match.
 */
export function tokenTimesFromWords(tokens: string[], words: WhisperWord[], offsetSec = 0): TokenTime[] | null {
  const chars: Array<{ ch: string; t0: number; t1: number }> = []
  for (const word of words) {
    const w = norm(word.word ?? '')
    if (!w || !Number.isFinite(word.start) || !Number.isFinite(word.end)) continue
    const span = Math.max(0, word.end - word.start)
    for (let k = 0; k < w.length; k++) {
      chars.push({ ch: w[k], t0: offsetSec + word.start + span * (k / w.length), t1: offsetSec + word.start + span * ((k + 1) / w.length) })
    }
  }
  const out: Array<TokenTime | null> = []
  let pointer = 0
  let considered = 0
  let matched = 0
  const SKIP = 12
  for (const token of tokens) {
    const t = norm(token)
    if (!t) { out.push(null); continue }
    considered++
    let found = -1
    for (let s = pointer; s <= Math.min(pointer + SKIP, chars.length - t.length); s++) {
      let ok = true
      for (let k = 0; k < t.length; k++) if (chars[s + k].ch !== t[k]) { ok = false; break }
      if (ok) { found = s; break }
    }
    if (found < 0) { out.push(null); continue }
    out.push({ start: chars[found].t0, end: chars[found + t.length - 1].t1 })
    pointer = found + t.length
    matched++
  }
  if (considered === 0 || matched / considered < 0.8) return null
  return fillTimes(out)
}

/** Interpolate missing token times from their neighbours. */
function fillTimes(times: Array<TokenTime | null>): TokenTime[] {
  const out = times.slice()
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue
    let prev = i - 1
    while (prev >= 0 && !out[prev]) prev--
    let next = i + 1
    while (next < out.length && !times[next]) next++
    const at = prev >= 0 ? out[prev]!.end : next < out.length ? times[next]!.start : 0
    const to = next < out.length ? times[next]!.start : at
    out[i] = { start: at, end: Math.max(at, to) }
  }
  return out as TokenTime[]
}

/**
 * Times for each token when the ASR gave none: the text is laid over the frames
 * where Nemotron hears speech, in proportion to each token's length. Whisper's
 * live server path returns compact JSON without word clocks (its verbose JSON
 * can crash the native server), so this is the live path's normal case.
 */
export function estimateTokenTimes(tokens: string[], a: Activity, startSec: number, endSec: number): TokenTime[] | null {
  const [f0, f1] = frameRange(a, startSec, endSec)
  const speech = speechFrames(a, f0, f1)
  if (speech.length === 0) return null
  const weights = tokens.map(token => norm(token).length)
  const total = weights.reduce((sum, w) => sum + w, 0)
  const n = speech.length
  if (total === 0) return tokens.map(() => ({ start: speech[0] / FPS, end: (speech[n - 1] + 1) / FPS }))
  const out: TokenTime[] = []
  let cum = 0
  for (const w of weights) {
    const s = (cum / total) * n
    const e = ((cum + w) / total) * n
    cum += w
    const i0 = Math.min(n - 1, Math.floor(s))
    const i1 = Math.min(n - 1, Math.max(i0, Math.ceil(e) - 1))
    out.push({ start: speech[i0] / FPS, end: (speech[i1] + 1) / FPS })
  }
  return out
}

/** Fill unlabelled tokens from the token before (or after, at the start). */
export function fillLabels<T>(labels: Array<T | null>, fallback: T): T[] {
  const firstKnown = labels.find(label => label !== null)
  let carry: T = firstKnown ?? fallback
  return labels.map(label => {
    if (label !== null) carry = label
    return carry
  })
}

const PUNCT_END = /[.?!,;:]["')\]]?$/

/**
 * Estimated timings put a turn change mid-phrase. Move each boundary to the
 * nearest token that ends a phrase, at most maxShift tokens away, never across
 * another boundary.
 */
export function snapToPunctuation<T>(tokens: string[], labels: T[], maxShift = 2): T[] {
  const out = labels.slice()
  const boundaries: number[] = []
  for (let i = 1; i < out.length; i++) if (out[i] !== out[i - 1]) boundaries.push(i)
  for (let bi = 0; bi < boundaries.length; bi++) {
    const b = boundaries[bi]
    if (PUNCT_END.test(tokens[b - 1] ?? '')) continue
    const lo = bi > 0 ? boundaries[bi - 1] + 1 : 1
    const hi = bi + 1 < boundaries.length ? boundaries[bi + 1] - 1 : out.length - 1
    let target = -1
    for (let d = 1; d <= maxShift && target < 0; d++) {
      for (const cand of [b - d, b + d]) {
        if (cand < lo || cand > hi) continue
        if (PUNCT_END.test(tokens[cand - 1] ?? '')) { target = cand; break }
      }
    }
    if (target < 0) continue
    const before = out[b - 1]
    const after = out[b]
    if (target < b) for (let i = target; i < b; i++) out[i] = after
    else for (let i = b; i < target; i++) out[i] = before
    boundaries[bi] = target
  }
  return out
}

/**
 * A run of one word, shorter than minSec and flanked by the same label on both
 * sides, is a flicker, not a turn. Absorb it.
 */
export function absorbFlickers<T>(tokens: string[], labels: T[], times: TokenTime[], minSec = 0.4): T[] {
  const out = labels.slice()
  let i = 0
  while (i < out.length) {
    let j = i
    while (j + 1 < out.length && out[j + 1] === out[i]) j++
    const words = tokens.slice(i, j + 1).filter(isWordToken).length
    const span = (times[j]?.end ?? 0) - (times[i]?.start ?? 0)
    if (i > 0 && j + 1 < out.length && out[i - 1] === out[j + 1] && words <= 1 && span < minSec) {
      for (let k = i; k <= j; k++) out[k] = out[i - 1]
    }
    i = j + 1
  }
  return out
}

export interface LabelRun<T> {
  label: T
  from: number
  /** Exclusive. */
  to: number
}

export function runsOf<T>(labels: T[]): Array<LabelRun<T>> {
  const runs: Array<LabelRun<T>> = []
  for (let i = 0; i < labels.length; i++) {
    const last = runs.at(-1)
    if (last && last.label === labels[i]) last.to = i + 1
    else runs.push({ label: labels[i], from: i, to: i + 1 })
  }
  return runs
}

export interface Pcm16 {
  pcm: Buffer
  sampleRate: number
}

/** 16-bit mono PCM from a WAV, finding the data chunk like speaker-embeddings does. */
export function readPcm16Mono(wav: Buffer): Pcm16 | null {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let channels = 0
  let bits = 0
  let sampleRate = 0
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 24 <= wav.length) {
      channels = wav.readUInt16LE(offset + 10)
      sampleRate = wav.readUInt32LE(offset + 12)
      bits = wav.readUInt16LE(offset + 22)
    }
    if (id === 'data') {
      if (channels !== 1 || bits !== 16) return null
      const start = offset + 8
      const end = Math.min(wav.length, start + size)
      return { pcm: wav.subarray(start, end - ((end - start) % 2)), sampleRate }
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

export function pcm16ToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm])
}

/** The 44-byte header of a 16-bit mono PCM WAV holding pcmBytes of audio. */
export function wavHeader(pcmBytes: number, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcmBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcmBytes, 40)
  return header
}

/** The audio where only this channel speaks, as a WAV, for the voiceprint. */
export function exclusiveTrackWav(a: Activity, channel: number, audio: Pcm16): Buffer | null {
  if (audio.sampleRate !== 16_000) return null
  const parts: Buffer[] = []
  for (let f = 0; f < a.frames; f++) {
    if (!isActive(a, f, channel)) continue
    let others = false
    for (let c = 0; c < NEMOTRON_CHANNELS; c++) if (c !== channel && isActive(a, f, c)) { others = true; break }
    if (others) continue
    const from = f * SAMPLES_PER_FRAME * 2
    const to = Math.min(audio.pcm.length, from + SAMPLES_PER_FRAME * 2)
    if (from >= to) break
    parts.push(audio.pcm.subarray(from, to))
  }
  return parts.length ? pcm16ToWav(Buffer.concat(parts)) : null
}
