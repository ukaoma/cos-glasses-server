/**
 * Content evidence for the meeting merge engine (6.47.0, WS3).
 *
 * PURE. No filesystem, no network, no clock. Every number is a named export.
 *
 * WHY CONTENT AND NOT TIME. The rules design (start gap, duration fit, attendee-name
 * corroboration) scored 58.1% with 9 cross-meeting pairs against Miles's existing merges.
 * Scoring by shared transcript content instead scored 72.2% with 6 disputes, and all 6
 * disputes look like reference errors: the picked meeting shared 1,176 to 5,251 phrases
 * with the capture while the referenced one shared 0 to 5. Time now only selects
 * candidates; content decides.
 *
 * PARITY. Every function here mirrors the measured Python (`canary_imports.py`,
 * `canary_v2.py`) operation for operation, including floating-point evaluation order and
 * tie-breaking, because `server/scripts/engine-canary.ts` must reproduce its tier counts
 * (161 / 21 / 16 on 198 recordings, ±2). Deviations from that arithmetic are bugs, even
 * when they look like cleanups.
 */

/** One transcript word with the millisecond time it was spoken. */
export interface TimedWord {
  token: string
  timeMs: number
}

/** Where G2 word times came from. `chunks` is the fallback when no HQ batch pass ran. */
export type G2TimingMode = 'batch_relative' | 'batch_absolute' | 'chunks' | 'none'

export interface G2ChunkInput {
  text?: string
  speaker?: string
  elapsed?: number
  similarity?: number
  /** Set by `meeting-speaker-labels.ts` when a human named this chunk. */
  speakerCorrectionBatchId?: string
}

export interface G2BatchWordInput {
  word?: string
  start?: number
  end?: number
}

export interface G2BatchSegmentInput {
  startElapsed?: number
  endElapsed?: number
  words?: G2BatchWordInput[]
}

/** One G2 recording, as the runner snapshots it from `.g2-chunks.json`. */
export interface G2RecordingInput {
  sessionId: string
  /** Wall-clock epoch ms of the capture start. */
  startMs: number
  durationMs: number
  chunks?: G2ChunkInput[]
  batchSegments?: G2BatchSegmentInput[]
  /** Fingerprint fields, carried through to the derived sidecar. */
  sha256?: string
  correctionRevision?: number
  batchApplied?: boolean
  title?: string
  domain?: string
  /** Epoch ms the capture finalized; the runner uses it for the D14 advisory rule. */
  finalizedAtMs?: number
}

export interface FirefliesSentenceInput {
  text?: string
  speaker_name?: string
  speaker_id?: string
  /** Seconds from the recording start. */
  start_time?: number
  end_time?: number
}

/** One Fireflies meeting, as the importer or the advise-mode sidecar reader snapshots it. */
export interface FirefliesMeetingInput {
  id: string
  /** Wall-clock epoch ms of the recording start. */
  startMs: number
  /** Seconds. Zero or negative means unknown, which makes it ineligible as a candidate. */
  durationS: number
  sentences: FirefliesSentenceInput[]
  title?: string
  organizerEmail?: string
  participants?: string[]
  summary?: string
  actionItems?: string[]
  sha256?: string
}

/**
 * Offset histogram bin width. Ten seconds is wide enough to absorb the per-word timing
 * error of two independent transcribers and narrow enough that a different meeting's
 * shared phrases scatter across bins instead of stacking in one.
 */
export const EVIDENCE_BIN_MS = 10_000

/** Nominal length of the last chunk, which has no successor to bound it. */
export const G2_CHUNK_TAIL_MS = 6_000

/** Ceiling on how far one chunk's words may be spread in the no-batch fallback. */
export const G2_CHUNK_SPREAD_MAX_MS = 12_000

/**
 * Slack when deciding whether a batch segment's word times are relative to its own start
 * or absolute. A median word time inside the segment's own length (plus this) means
 * relative.
 */
export const G2_BATCH_RELATIVE_MARGIN_S = 5

/**
 * Python's `//` on floats, exactly: `math.floor` of the quotient, with the same correction
 * for a quotient that lands a hair under an integer. `Math.floor(x / y)` disagrees on
 * those boundary values, which would move a trigram into the neighbouring bin and change K.
 */
export function pythonFloorDiv(value: number, divisor: number): number {
  const mod = value % divisor
  let div = (value - mod) / divisor
  if (mod !== 0 && (divisor < 0) !== (mod < 0)) div -= 1
  if (div !== 0) {
    const floored = Math.floor(div)
    return div - floored > 0.5 ? floored + 1 : floored
  }
  return 0
}

/** The bin an offset falls in. */
export function offsetBin(offsetMs: number, binMs: number = EVIDENCE_BIN_MS): number {
  return pythonFloorDiv(offsetMs, binMs)
}

/** `statistics.median`: the middle value, or the mean of the two middle values. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of empty set')
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Median absolute deviation about the median. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const centre = median(values)
  return median(values.map(v => Math.abs(v - centre)))
}

const WORD_PATTERN = /[a-z0-9]+/g

/**
 * Lowercase, drop apostrophes, split on anything that is not `[a-z0-9]`.
 *
 * Dropping the apostrophe before splitting keeps "we'll" one token in both transcripts;
 * splitting on it first would produce "we" and "ll" on one side only.
 */
export function normalizeWords(text: string | undefined | null): string[] {
  return (text ?? '').toLowerCase().replace(/'/g, '').match(WORD_PATTERN) ?? []
}

const TRIGRAM_SEPARATOR = '\u0000'

/** The map key for one trigram. Shared so alignment cannot build it differently. */
export function trigramKey(a: string, b: string, c: string): string {
  return `${a}${TRIGRAM_SEPARATOR}${b}${TRIGRAM_SEPARATOR}${c}`
}

/**
 * Word trigrams that occur EXACTLY ONCE, timed at their middle word.
 *
 * Uniqueness is what makes a match evidence rather than coincidence: "let me share my"
 * appears in every meeting, so a repeated trigram carries no information about WHICH
 * meeting this is. Insertion order is first occurrence, which the bin tie-break depends on.
 */
export function uniqueTrigrams(words: readonly TimedWord[]): Map<string, number> {
  const times = new Map<string, number[]>()
  for (let i = 0; i + 2 < words.length; i++) {
    const key = trigramKey(words[i].token, words[i + 1].token, words[i + 2].token)
    const existing = times.get(key)
    if (existing) existing.push(words[i + 1].timeMs)
    else times.set(key, [words[i + 1].timeMs])
  }
  const unique = new Map<string, number>()
  for (const [key, ts] of times) if (ts.length === 1) unique.set(key, ts[0])
  return unique
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * G2 words with times, from the HQ batch pass when it ran and from chunk timings otherwise.
 *
 * The relative-or-absolute decision is per recording, not per segment: a mixed verdict
 * would shift half the words by their segment start and leave the rest, which scatters
 * every trigram offset and destroys K.
 */
export function g2TimedWords(recording: G2RecordingInput): { words: TimedWord[]; mode: G2TimingMode } {
  const words: TimedWord[] = []
  const segments = recording.batchSegments ?? []
  let mode: G2TimingMode = 'none'
  if (segments.length > 0) {
    let relative = 0
    let absolute = 0
    for (const segment of segments) {
      const timed = (segment.words ?? []).filter(w => isFiniteNumber(w.start))
      if (timed.length === 0) continue
      const segmentLengthS = ((segment.endElapsed ?? 0) - (segment.startElapsed ?? 0)) / 1000
      const middle = median(timed.map(w => w.start as number))
      if (middle <= segmentLengthS + G2_BATCH_RELATIVE_MARGIN_S) relative++
      else absolute++
    }
    mode = relative >= absolute ? 'batch_relative' : 'batch_absolute'
    for (const segment of segments) {
      const base = mode === 'batch_relative' ? (segment.startElapsed ?? 0) : 0
      for (const word of segment.words ?? []) {
        if (!isFiniteNumber(word.start)) continue
        for (const token of normalizeWords(word.word)) words.push({ token, timeMs: base + word.start * 1000 })
      }
    }
  }
  if (words.length === 0) {
    const chunks = (recording.chunks ?? []).filter(c => isFiniteNumber(c.elapsed))
    mode = 'chunks'
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const elapsed = chunk.elapsed as number
      const next = i + 1 < chunks.length ? (chunks[i + 1].elapsed as number) : elapsed + G2_CHUNK_TAIL_MS
      const tokens = normalizeWords(chunk.text)
      for (let k = 0; k < tokens.length; k++) {
        const spread = ((k + 0.5) / Math.max(1, tokens.length)) * Math.min(G2_CHUNK_SPREAD_MAX_MS, next - elapsed)
        words.push({ token: tokens[k], timeMs: elapsed + spread })
      }
    }
  }
  return { words, mode }
}

/** Fireflies words, spread evenly inside each sentence's own start and end. */
export function firefliesTimedWords(sentences: readonly FirefliesSentenceInput[]): TimedWord[] {
  const words: TimedWord[] = []
  for (const sentence of sentences) {
    const tokens = normalizeWords(sentence.text)
    const start = Number(sentence.start_time ?? 0) || 0
    const end = Number(sentence.end_time ?? 0) || 0
    for (let k = 0; k < tokens.length; k++) {
      const timeS = start + ((k + 0.5) / Math.max(1, tokens.length)) * Math.max(0, end - start)
      words.push({ token: tokens[k], timeMs: timeS * 1000 })
    }
  }
  return words
}

/** One shared trigram: where it sits in the Fireflies recording, and the offset it implies. */
export interface AnchorSample {
  /** Milliseconds from the Fireflies recording start. */
  firefliesMs: number
  /** Milliseconds from the G2 capture start. */
  g2Ms: number
  /** `firefliesMs - g2Ms`. */
  offsetMs: number
}

/**
 * A window of believable offsets, centred on what the two clocks say.
 *
 * Shared phrases whose implied offset sits outside it are boilerplate — the same agenda
 * read out in a different meeting — not evidence about THIS one.
 */
export interface EvidenceBand {
  centreMs: number
  halfWidthMs: number
}

export interface ContentEvidence {
  /** Anchors in the densest offset bin plus its two neighbours. */
  k: number
  /** Start of the densest bin, in ms. Null when nothing is shared. */
  offsetMs: number | null
  /** Every shared unique trigram that counted, for the split spans. */
  samples: AnchorSample[]
  /** Shared trigrams the band threw out. Zero when no band was applied. */
  outsideBand: number
}

/**
 * Shared unique trigrams, counted in the densest offset bin and its neighbours.
 *
 * ±1 bin because a real match's offsets straddle a bin edge as often as not; counting the
 * single densest bin alone would halve K for an unlucky recording.
 *
 * TIE-BREAK. `Counter.most_common(1)` returns the FIRST bin at the maximum in insertion
 * order, and insertion order is the G2 trigram order. A `Map` preserves that, so ties
 * resolve the way the measurement resolved them.
 */
export function contentEvidence(
  g2Words: readonly TimedWord[],
  firefliesSentences: readonly FirefliesSentenceInput[],
  binMs: number = EVIDENCE_BIN_MS,
  band?: EvidenceBand,
): ContentEvidence {
  return contentEvidenceFromTrigrams(
    uniqueTrigrams(g2Words),
    uniqueTrigrams(firefliesTimedWords(firefliesSentences)),
    binMs,
    band,
  )
}

/** The same, when both trigram maps are already built (the split scores many captures against one recording). */
export function contentEvidenceFromTrigrams(
  g2Trigrams: Map<string, number>,
  firefliesTrigrams: Map<string, number>,
  binMs: number = EVIDENCE_BIN_MS,
  band?: EvidenceBand,
): ContentEvidence {
  const bins = new Map<number, number>()
  const samples: AnchorSample[] = []
  let outsideBand = 0
  for (const [key, g2Ms] of g2Trigrams) {
    const firefliesMs = firefliesTrigrams.get(key)
    if (firefliesMs === undefined) continue
    const offsetMs = firefliesMs - g2Ms
    if (band && Math.abs(offsetMs - band.centreMs) > band.halfWidthMs) {
      outsideBand++
      continue
    }
    samples.push({ firefliesMs, g2Ms, offsetMs })
    const bin = offsetBin(offsetMs, binMs)
    bins.set(bin, (bins.get(bin) ?? 0) + 1)
  }
  if (bins.size === 0) return { k: 0, offsetMs: null, samples, outsideBand }
  let densest = 0
  let best = -1
  for (const [bin, count] of bins) {
    if (count > best) {
      best = count
      densest = bin
    }
  }
  const k = best + (bins.get(densest - 1) ?? 0) + (bins.get(densest + 1) ?? 0)
  return { k, offsetMs: densest * binMs, samples, outsideBand }
}

/** The anchors that back an offset: the densest bin and its neighbours, by Fireflies time. */
export function anchorsInBand(samples: readonly AnchorSample[], offsetMs: number, binMs: number = EVIDENCE_BIN_MS): AnchorSample[] {
  const densest = pythonFloorDiv(offsetMs, binMs)
  return samples
    .filter(sample => Math.abs(offsetBin(sample.offsetMs, binMs) - densest) <= 1)
    .sort((a, b) => a.firefliesMs - b.firefliesMs)
}

/** A silence between consecutive sentences, in seconds from the recording start. */
export interface SpeechGap {
  startS: number
  endS: number
}

/**
 * Silences of at least `minGapS` between CONSECUTIVE sentences.
 *
 * Consecutive, not against a running maximum end: that is what the measurement did, and
 * the Aug 20 boundaries it produced (27, 25, 42, 42 s from Miles's manual splits) are the
 * gate this must reproduce.
 */
export function speechGaps(sentences: readonly FirefliesSentenceInput[], minGapS: number): SpeechGap[] {
  const spans = sentences
    .map(s => [Number(s.start_time ?? 0) || 0, Number(s.end_time ?? 0) || 0] as const)
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  const gaps: SpeechGap[] = []
  for (let i = 0; i + 1 < spans.length; i++) {
    const endOfThis = spans[i][1]
    const startOfNext = spans[i + 1][0]
    if (startOfNext - endOfThis >= minGapS) gaps.push({ startS: endOfThis, endS: startOfNext })
  }
  return gaps
}

/** A G2 speaker label with the interval it covers, in ms from the capture start. */
export interface LabelInterval {
  startMs: number
  endMs: number
  speaker: string
  similarity: number
  humanConfirmed: boolean
}

/**
 * Chunk labels as intervals. A chunk owns the time until the next chunk starts; the last
 * owns `G2_CHUNK_TAIL_MS`.
 */
export function labelIntervals(recording: G2RecordingInput): LabelInterval[] {
  const labelled = (recording.chunks ?? [])
    .filter(c => isFiniteNumber(c.elapsed))
    .map(c => ({
      elapsed: c.elapsed as number,
      speaker: String(c.speaker ?? ''),
      similarity: Number(c.similarity ?? 0) || 0,
      humanConfirmed: typeof c.speakerCorrectionBatchId === 'string' && c.speakerCorrectionBatchId.length > 0,
    }))
    .sort((a, b) => (a.elapsed - b.elapsed) || a.speaker.localeCompare(b.speaker))
  return labelled.map((label, i) => ({
    startMs: label.elapsed,
    endMs: i + 1 < labelled.length ? labelled[i + 1].elapsed : label.elapsed + G2_CHUNK_TAIL_MS,
    speaker: label.speaker,
    similarity: label.similarity,
    humanConfirmed: label.humanConfirmed,
  }))
}

/** Interval helpers shared by pairing and split. */
export function overlapMs(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]))
}

/** Overlap as a fraction of the SHORTER interval. */
export function overlapFraction(a: readonly [number, number], b: readonly [number, number]): number {
  const shorter = Math.min(a[1] - a[0], b[1] - b[0])
  return shorter > 0 ? overlapMs(a, b) / shorter : 0
}

export function g2Interval(recording: G2RecordingInput): [number, number] {
  return [recording.startMs, recording.startMs + recording.durationMs]
}

export function firefliesInterval(meeting: FirefliesMeetingInput): [number, number] {
  return [meeting.startMs, meeting.startMs + meeting.durationS * 1000]
}
