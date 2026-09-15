/**
 * Fine alignment between a G2 capture and a Fireflies transcript (6.47.0, WS3).
 *
 * PURE. No filesystem, no network, no clock.
 *
 * Alignment exists ONLY to decide whether per-sentence relabelling is allowed. A capture
 * that fails to align is still attached to the merged record in full — nothing is dropped,
 * the Fireflies labels simply stand.
 *
 * WHY SENTENCE STARTS. Fireflies gives an exact `start_time` per sentence, while word
 * times inside a sentence are interpolated by this engine. Anchoring on the first trigram
 * of a sentence measures against a real timestamp; anchoring on arbitrary words measures
 * against the interpolation and inflates the spread. Measured on 10 real pairs, sentence
 * starts land at MAD 1.5 to 3.3 s.
 */

import {
  type FirefliesSentenceInput,
  type TimedWord,
  firefliesTimedWords,
  median,
  medianAbsoluteDeviation,
  normalizeWords,
  trigramKey,
  uniqueTrigrams,
} from './evidence.js'

/** How far an anchor's offset may sit from the coarse offset before it is a different conversation. */
export const ALIGN_BAND_S = 300

/** Anchors needed before the offsets are a measurement rather than a coincidence. */
export const ALIGN_MIN_ANCHORS = 8

/**
 * Spread allowed around the median offset, in ms.
 *
 * Chosen from the same 10 pairs it is measured on, which is a real weakness and is why
 * the share gate and the 0.55 similarity floor, not this threshold, are what keep a wrong
 * name off a sentence.
 */
export const ALIGN_MAX_MAD_MS = 3500

/** Clock drift is not constant over an hour, so the offset is re-measured per window. */
export const ALIGN_WINDOW_MS = 120_000

/** A window with fewer anchors than this has no offset of its own and inherits one. */
export const ALIGN_WINDOW_MIN_ANCHORS = 3

export type AttributionState = 'aligned' | 'unaligned' | 'capture_only'

export interface AlignmentAnchor {
  /** Milliseconds from the G2 capture start. */
  g2Ms: number
  /** `firefliesMs - g2Ms`. */
  offsetMs: number
}

export interface Alignment {
  aligned: boolean
  anchors: number
  /** Null when there were too few anchors to measure. */
  madMs: number | null
  /** Median offset across all anchors. Null when unmeasured. */
  offsetMs: number | null
  samples: AlignmentAnchor[]
  windows: Map<number, number>
}

/**
 * Anchors: Fireflies sentence-initial trigrams that are unique in BOTH transcripts.
 *
 * Unique on both sides for the same reason pairing needs it — a phrase that recurs cannot
 * say which moment this is — and sentence-initial so the Fireflies time is exact.
 */
export function sentenceStartAnchors(
  g2Words: readonly TimedWord[],
  sentences: readonly FirefliesSentenceInput[],
  coarseOffsetMs: number,
  bandS: number = ALIGN_BAND_S,
): AlignmentAnchor[] {
  const g2Trigrams = uniqueTrigrams(g2Words)
  const firefliesTrigrams = uniqueTrigrams(firefliesTimedWords(sentences))
  const anchors: AlignmentAnchor[] = []
  for (const sentence of sentences) {
    const tokens = normalizeWords(sentence.text)
    if (tokens.length < 3) continue
    const key = trigramKey(tokens[0], tokens[1], tokens[2])
    if (!firefliesTrigrams.has(key)) continue
    const g2Ms = g2Trigrams.get(key)
    if (g2Ms === undefined) continue
    const firefliesMs = (Number(sentence.start_time ?? 0) || 0) * 1000
    const offsetMs = firefliesMs - g2Ms
    if (Math.abs(offsetMs - coarseOffsetMs) <= bandS * 1000) anchors.push({ g2Ms, offsetMs })
  }
  return anchors
}

/**
 * Per-window offsets over G2 time.
 *
 * A sparse window inherits from the nearest window that has enough anchors, earlier one
 * first on a tie. Inheriting a neighbour keeps a quiet stretch on its neighbours' drift
 * instead of snapping it back to the whole-meeting median, which is the larger error by
 * the end of a long call.
 */
export function windowOffsets(
  anchors: readonly AlignmentAnchor[],
  windowMs: number = ALIGN_WINDOW_MS,
  minAnchors: number = ALIGN_WINDOW_MIN_ANCHORS,
): Map<number, number> {
  const byWindow = new Map<number, number[]>()
  for (const anchor of anchors) {
    const index = Math.floor(anchor.g2Ms / windowMs)
    const bucket = byWindow.get(index)
    if (bucket) bucket.push(anchor.offsetMs)
    else byWindow.set(index, [anchor.offsetMs])
  }
  const resolved = new Map<number, number>()
  for (const [index, offsets] of byWindow) {
    if (offsets.length >= minAnchors) resolved.set(index, median(offsets))
  }
  if (resolved.size === 0) return resolved
  for (const index of byWindow.keys()) {
    if (resolved.has(index)) continue
    let best: number | null = null
    let bestDistance = Infinity
    for (const candidate of resolved.keys()) {
      const distance = Math.abs(candidate - index)
      if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
        best = candidate
        bestDistance = distance
      }
    }
    if (best !== null) resolved.set(index, resolved.get(best)!)
  }
  return resolved
}

/** Measure the alignment of one capture against one transcript. */
export function alignRecording(
  g2Words: readonly TimedWord[],
  sentences: readonly FirefliesSentenceInput[],
  coarseOffsetMs: number,
): Alignment {
  const samples = sentenceStartAnchors(g2Words, sentences, coarseOffsetMs)
  if (samples.length < ALIGN_MIN_ANCHORS) {
    return { aligned: false, anchors: samples.length, madMs: null, offsetMs: null, samples, windows: new Map() }
  }
  const offsets = samples.map(s => s.offsetMs)
  const offsetMs = median(offsets)
  const madMs = medianAbsoluteDeviation(offsets)
  return {
    aligned: madMs <= ALIGN_MAX_MAD_MS,
    anchors: samples.length,
    madMs,
    offsetMs,
    samples,
    windows: windowOffsets(samples),
  }
}

/** The offset to use for a moment in G2 time. */
export function offsetAt(alignment: Alignment, g2Ms: number, windowMs: number = ALIGN_WINDOW_MS): number {
  const fallback = alignment.offsetMs ?? 0
  if (alignment.windows.size === 0) return fallback
  return alignment.windows.get(Math.floor(g2Ms / windowMs)) ?? fallback
}
