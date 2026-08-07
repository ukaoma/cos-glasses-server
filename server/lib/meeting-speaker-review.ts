// Per-meeting speaker review — the data behind COS Control's naming panel.
//
// The panel's job is to let a human name voices from what they REMEMBER, so the
// primary output here is verbatim phrases, not similarity scores. A score cannot
// tell you who someone is; "I'll follow up with both Andrews on music targeting"
// can.
//
// It also carries the diagnostic that actually catches a broken profile.
// Similarity between profile centroids does NOT distinguish "two people who
// sound alike" from "one voice split across two labels" — measured on the live
// store, Chris Krubeck and Luke Henry sat at 0.85 while genuinely being
// separate rows. What discriminates is RUN LENGTH within a single meeting:
//
//   MU + Chris Krubeck (known two people) : flip rate 0.069, mean run 30.0
//   Luke H + Luke Henry                   : flip rate 0.361, mean run 2.79
//   Chris Krubeck + Luke Henry            : flip rate 0.381, mean run 3.47
//   Scott Taylor + Dylan Jackson          : flip rate 0.344, mean run 2.80
//
// Real conversation holds the floor for ~30 consecutive segments. A pair that
// swaps every ~3 is the identifier oscillating mid-turn, which means those two
// profiles cannot be told apart and any name applied to either is a guess.
//
// Everything here is pure over a chunk array so it can be tested by execution.

/** One transcript chunk as stored in the `.g2-chunks.json` sidecar. */
export interface ReviewChunk {
  text?: string
  speaker?: string
  /**
   * RAW capture index — the number in `chunk_NNNN.wav`, NOT this chunk's position
   * in the array.
   *
   * These differ and the gap grows through a meeting. Measured on the 2026-08-06
   * Ditto sidecar: 885 compacted chunks against raw indices 0..945 with 36 gaps,
   * so array position 884 is really raw chunk 940 — a 56-chunk error, minutes of
   * audio. `chunks` is filtered to text-bearing entries (transcribe-stream's
   * getSessionChunks) while the WAV is written for EVERY received chunk before
   * ASR, so the position can never address the audio. Populated from the
   * sidecar's `chunkEntries`, which exists precisely to preserve these.
   */
  chunkIndex?: number
  /** MILLISECONDS from meeting start. Confirmed against the writer:
   *  meeting.ts accumulates `elapsed += row.durationMs`. Treating this as
   *  seconds reports a 32-minute meeting as 30,936 minutes. */
  elapsed?: number
  similarity?: number
}

/** Labels that mean "nobody was identified", not a person. */
export const UNATTRIBUTED = new Set(['Unknown', 'Ext', '', 'Speaker 1', 'Speaker 2', 'Speaker 3'])

/**
 * Prefix for a voice a human de-attributed, numbered so distinct people stay
 * distinct.
 *
 * De-attributing to a single shared `Ext` folded every corrected voice into one
 * row: on the 2026-08-06 Ditto meeting Miles named five wrong attributions, and
 * collapsing them would have destroyed his ability to tell those five voices
 * apart afterwards — which is exactly what he then needs playback for. Numbering
 * keeps them separable while asserting no identity.
 */
export const DEATTRIBUTED_PREFIX = 'Unidentified'

/** True when a label asserts no identity — the exact set, or a numbered
 *  de-attribution. Prefix-aware so `Unidentified 3` is treated as unnamed. */
export function isUnattributed(label: string): boolean {
  return UNATTRIBUTED.has(label) || new RegExp(`^${DEATTRIBUTED_PREFIX} \\d+$`).test(label)
}

/** Calibrated from the control pair above. A pair must be BOTH flip-happy and
 *  short-run to be called unreliable — either alone has honest explanations
 *  (a rapid-fire exchange is flip-happy; a brief interjection is short-run). */
export const THRASH_FLIP_RATE = 0.20
export const THRASH_MEAN_RUN = 8
/** Below the search-accept threshold a name was never asserted with confidence. */
export const CONFIDENT_SIMILARITY = 0.65

/**
 * FLOOR FOR PRESENTING A NAME AT ALL.
 *
 * The identifier accepts a match at SEARCH_THRESHOLD = 0.55, so a single segment
 * scoring 0.55 currently arrives in the panel wearing somebody's full name. On
 * Miles's 2026-08-06 Ditto meeting that produced Richard Jenkins (1 segment,
 * 0.60), Luke Henry (1 segment, 0.55), Dylan Jackson (2 segments, 0.58) and
 * Navaz Sharif (3 segments, 0.58) — and he confirmed none of them were in the
 * room. Presenting those as names is the defect; the reviewer then has to undo
 * an assertion the system should never have made.
 *
 * Standing rule this enforces: speaker identity is a SUGGESTION, never an
 * assertion. Below the floor the row is "unidentified" and the label survives
 * only as a scored candidate.
 *
 * A floor cannot catch everything — a wrong match can still score well — so this
 * removes obvious noise rather than guaranteeing correctness.
 */
export const ASSERT_MIN_SIMILARITY = CONFIDENT_SIMILARITY
export const ASSERT_MIN_SEGMENTS = 3

export type Reliability = 'confident' | 'weak' | 'unreliable' | 'unattributed'

/**
 * Which measurement produced `speakingMs`.
 *
 * `words` is real voiced time from the HQ batch pass's word timings — silence is
 * excluded by construction. `chunks` is wall-clock deltas with each chunk capped
 * at the capture ceiling, which is coarser and still contains the sub-ceiling
 * pauses. They are not comparable across meetings, so any UI showing a trend
 * must not mix them silently.
 */
export type SpeakingTimeSource = 'words' | 'chunks'

export interface ThrashPair {
  speaker: string
  flipRate: number
  meanRun: number
  sharedSegments: number
}

export interface Phrase {
  text: string
  /** Milliseconds from meeting start, matching the sidecar. */
  atMs: number
  similarity: number | null
  /**
   * Raw capture index for playback, or null when the sidecar cannot supply one
   * (pre-`chunkEntries` captures). Null means "do not offer playback" — a
   * guessed index plays somebody else's voice, which is worse than no button
   * on a screen whose whole purpose is confirming identity.
   */
  chunkIndex: number | null
}

export interface VoiceReview {
  label: string
  segments: number
  /** Voiced milliseconds credited to this voice. See `SpeakingTimeSource` for
   *  how it was measured — the two methods are not comparable. */
  speakingMs: number
  meanSimilarity: number | null
  /** Mean consecutive-run length across the WHOLE meeting. Not comparable to
   *  the pair-scoped run in `thrashesWith`: in a 13-voice meeting every
   *  speaker's whole-sequence run is short (measured: 3.36 for the owner), so
   *  this is a talkativeness texture, never a reliability signal. */
  meanRun: number
  longestRun: number
  isOwner: boolean
  /** A human confirmed this label for this meeting; the floor is waived. */
  confirmedByHuman: boolean
  reliability: Reliability
  /**
   * Whether `label` may be shown to a human AS A NAME.
   *
   * False means the UI must render the row as unidentified and offer `label`
   * only as a scored candidate. Carried as data rather than left to each client
   * to re-derive, so the phone, the lens and Control cannot disagree about
   * whether a name was earned.
   */
  nameAsserted: boolean
  /** Why the name is not asserted — so a UI can explain rather than just hide. */
  assertionBlockers: string[]
  thrashesWith: ThrashPair[]
  phrases: Phrase[]
}

/** One stretch of the meeting held by a single label. */
export interface TimelineSpan {
  /** The label as stored. Whether it may be SHOWN as a name is still governed by
   *  the matching voice row's `nameAsserted` — a span is not a second opinion. */
  speaker: string
  /** Milliseconds from meeting start. `elapsed` on a chunk is its START offset:
   *  meeting.ts assigns `elapsed` and only then does `elapsed += durationMs`. */
  startMs: number
  endMs: number
  segments: number
}

/**
 * Collapse the chunk sequence into consecutive same-speaker spans.
 *
 * This exists because the ribbon needs a TIME axis. The previous ribbon drew one
 * rectangle per voice sized by share of segments and labelled itself "who spoke,
 * in order" — there was no ordering in it at all, so hovering could not report
 * anything true.
 *
 * Non-monotonic or missing `elapsed` values are carried forward rather than
 * trusted: a span with a negative width would render as an invisible or
 * inverted block, which is worse than a slightly wrong boundary.
 */
export function speakerTimeline(chunks: ReviewChunk[], durationMs: number): TimelineSpan[] {
  const spans: TimelineSpan[] = []
  let cursor = 0
  for (const c of chunks) {
    const label = c.speaker ?? ''
    const raw = typeof c.elapsed === 'number' && Number.isFinite(c.elapsed) ? c.elapsed : 0
    // ONE clamp does all three jobs, because `cursor` is monotonic and never
    // negative: it recovers a missing value, a negative value, and a value that
    // goes backwards. Mutation showed the extra Math.max(0, raw) and the
    // `: cursor` fallback were both unreachable behind it.
    const startMs = Math.max(cursor, raw)
    cursor = startMs
    const last = spans[spans.length - 1]
    if (last && last.speaker === label) {
      last.segments++
    } else {
      spans.push({ speaker: label, startMs, endMs: startMs, segments: 1 })
    }
  }
  // Each span ends where the next begins. The LAST one is the problem: `elapsed`
  // is a start offset, and on real sidecars `durationMs` frequently equals the
  // final chunk's start exactly (measured on 2026-08-06 Ditto: both 5,783,732),
  // so taking the meeting end verbatim leaves the closing turn zero-width — a
  // 1.5pt sliver for what may be a long monologue.
  //
  // The tail gets ONE TYPICAL CHUNK of width, derived from the median gap between
  // this meeting's own chunk starts. That is measured from the data rather than
  // invented, and it is the shortest defensible non-zero answer.
  const gaps: number[] = []
  for (let i = 1; i < spans.length; i++) {
    const d = spans[i].startMs - spans[i - 1].startMs
    if (d > 0) gaps.push(d)
  }
  gaps.sort((a, b) => a - b)
  const typicalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0
  for (let i = 0; i < spans.length; i++) {
    const next = spans[i + 1]
    if (next) {
      spans[i].endMs = Math.max(spans[i].startMs, next.startMs)
    } else if (durationMs > spans[i].startMs) {
      // A real meeting end, later than this span's start: use it verbatim.
      spans[i].endMs = durationMs
    } else {
      // durationMs is absent, or equals the final chunk's start (the common real
      // case). Fall back to one typical chunk so the closing turn has width.
      spans[i].endMs = spans[i].startMs + typicalGap
    }
  }
  return spans
}

export interface MeetingSpeakerReview {
  segments: number
  /** False when no chunk carries a real speaker — a recovered capture. */
  attributed: boolean
  /**
   * Segments belonging to voices this review asserts a NAME for.
   *
   * `attributed` is a boolean that only goes false at 100% unidentified, so a
   * meeting where 295 of 299 chunks matched nobody still reports `true` and
   * renders as though it were normally attributed. This is the graded version:
   * measured Ext share across 14 retained sessions ran from 24% to 100%.
   *
   * Counts SEGMENTS OF ASSERTED VOICES, not chunks carrying a person-shaped
   * label — see the derivation for why those differ. Denominator is `segments`
   * (every chunk, including unlabelled ones), so `assertedSegments / segments`
   * is the ratio every client should compute.
   *
   * Not named "coverage": `coverageRatio` in batch-transcript-quality.ts is an
   * unrelated word-overlap measure and the two must not read as siblings.
   */
  assertedSegments: number
  /** How `speakingMs` was measured. */
  speakingTimeSource: SpeakingTimeSource
  /** Voiced ms belonging to voices shown WITH A NAME. The headline number. */
  attributedSpeakingMs: number
  /** Voiced ms belonging to voices the panel refuses to name. */
  unattributedSpeakingMs: number
  /**
   * Voiced ms in the meeting, crosstalk counted ONCE.
   *
   * `attributed + unattributed` does NOT equal this, and must not be presented
   * as though it does: when two people talk over each other both are credited,
   * so per-speaker figures legitimately exceed wall clock. Measured on a real
   * 5.2-minute capture the per-speaker times summed to 6.0 minutes.
   */
  voicedMs: number
  /**
   * Wall clock that produced no voice at all.
   *
   * Reported rather than distributed, because it is frequently large and is not
   * all silence: a measured 2026-08-06 capture lost 93% of its chunks in
   * transfer. THE invariant is `voicedMs + notCapturedMs = durationMs`.
   */
  notCapturedMs: number
  durationMs: number
  voices: VoiceReview[]
  /** Chronological spans, so a ribbon can be a timeline instead of a share bar. */
  timeline: TimelineSpan[]
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/**
 * Attach raw capture indices to a compacted chunk array.
 *
 * The i-th compacted chunk is the i-th TEXT-BEARING `chunkEntries` row, whose
 * `chunkIndex` is the raw WAV number. Verified against every 2026-07/08 sidecar
 * that carries chunkEntries: the text-bearing count always equals the compacted
 * count and the text lines up positionally.
 *
 * Returns the chunks UNCHANGED when the counts disagree or chunkEntries is
 * absent. A partial or shifted mapping is worse than none: it would silently
 * point playback at a neighbouring speaker, and this screen exists to confirm
 * identity.
 */
export function attachRawChunkIndices(chunks: ReviewChunk[], chunkEntries: unknown): ReviewChunk[] {
  if (!Array.isArray(chunkEntries)) return chunks
  const textBearing = chunkEntries.filter(e => {
    const chunk = (e as { chunk?: { text?: unknown } } | null)?.chunk
    return typeof chunk?.text === 'string' && chunk.text.trim() !== ''
  })
  if (textBearing.length !== chunks.length) return chunks
  return chunks.map((c, i) => {
    const raw = (textBearing[i] as { chunkIndex?: unknown }).chunkIndex
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
      ? { ...c, chunkIndex: raw }
      : c
  })
}

/** Consecutive-run lengths for one speaker across the whole meeting. */
export function speakerRuns(sequence: string[], speaker: string): number[] {
  const runs: number[] = []
  let cur = 0
  for (const s of sequence) {
    if (s === speaker) cur++
    else if (cur > 0) { runs.push(cur); cur = 0 }
  }
  if (cur > 0) runs.push(cur)
  return runs
}

/**
 * How often the label flips between exactly two speakers, ignoring everyone
 * else. Restricting to the pair is the point: a third person interjecting
 * should not make two other speakers look like they are thrashing.
 */
export function pairFlipRate(
  sequence: string[],
  a: string,
  b: string,
): { flipRate: number; meanRun: number; sharedSegments: number } | null {
  const pair = sequence.filter(s => s === a || s === b)
  if (pair.length < 6) return null            // too little to characterise
  if (!pair.includes(a) || !pair.includes(b)) return null

  let flips = 0
  const runs: number[] = []
  let cur = 1
  for (let i = 1; i < pair.length; i++) {
    if (pair[i] === pair[i - 1]) cur++
    else { flips++; runs.push(cur); cur = 1 }
  }
  runs.push(cur)
  return {
    flipRate: flips / (pair.length - 1),
    meanRun: mean(runs),
    sharedSegments: pair.length,
  }
}

/** Words that carry no identifying information. */
const FILLER = /^(?:yeah|yep|okay|ok|right|sure|mm+|uh+|um+|hmm+|got it|exactly|thanks?|no|yes)[.!?]?$/i

/**
 * Score a line by how much it would help a human recognise the speaker.
 *
 * Length matters (a longer line carries more voice), but so does specificity:
 * a proper noun, a number, or a domain term is what makes someone say "that's
 * Graham." A long line of pleasantries scores lower than a short line naming a
 * brand and a figure.
 */
export function phraseScore(text: string): number {
  const trimmed = text.trim()
  if (!trimmed || FILLER.test(trimmed)) return 0
  const words = trimmed.split(/\s+/)
  if (words.length < 6) return 0

  let score = Math.min(words.length, 28)
  // Mid-sentence capitals — names, brands, products.
  const propers = words.slice(1).filter(w => /^[A-Z][a-zA-Z]{2,}/.test(w)).length
  score += Math.min(propers, 4) * 6
  // Figures, percentages, money — highly memorable.
  if (/\d/.test(trimmed)) score += 5
  // Penalise a line that is mostly filler even if long.
  const fillerWords = words.filter(w => FILLER.test(w)).length
  score -= fillerWords * 3
  return Math.max(score, 0)
}

/**
 * Pick up to `limit` representative lines, spread across the meeting.
 *
 * Spread is enforced deliberately: the three best-scoring lines often sit
 * seconds apart in one monologue, which tells you far less about a speaker than
 * three lines from the beginning, middle, and end. Every phrase carries its
 * timestamp so a reviewer can place it against their memory of the meeting.
 */
export function selectPhrases(
  chunks: ReviewChunk[],
  speaker: string,
  limit = 3,
  durationMs = 0,
): Phrase[] {
  const owned = chunks
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.speaker ?? '') === speaker)
    .map(({ c }) => ({
      text: (c.text ?? '').trim(),
      atMs: typeof c.elapsed === 'number' ? c.elapsed : 0,
      similarity: typeof c.similarity === 'number' ? c.similarity : null,
      chunkIndex: typeof c.chunkIndex === 'number' ? c.chunkIndex : null,
      score: phraseScore(c.text ?? ''),
    }))
    .filter(p => p.score > 0)

  if (owned.length === 0) return []

  const span = durationMs > 0 ? durationMs : Math.max(...owned.map(p => p.atMs), 1)
  const minGap = span / (limit * 2)   // no two picks from the same stretch

  const picked: typeof owned = []
  for (const cand of [...owned].sort((a, b) => b.score - a.score)) {
    if (picked.length >= limit) break
    if (picked.some(p => Math.abs(p.atMs - cand.atMs) < minGap)) continue
    picked.push(cand)
  }
  // Backfill on a short meeting where the gap rule excluded everything.
  if (picked.length < limit) {
    for (const cand of [...owned].sort((a, b) => b.score - a.score)) {
      if (picked.length >= limit) break
      if (!picked.includes(cand)) picked.push(cand)
    }
  }
  return picked
    .sort((a, b) => a.atMs - b.atMs)
    .map(({ text, atMs, similarity, chunkIndex }) => ({ text, atMs, similarity, chunkIndex }))
}

/**
 * The capture ceiling. A chunk is VAD-flushed with a 2.5s floor and a hard
 * ceiling here, so no single chunk can carry more voice than this no matter how
 * long the wall-clock gap before it was.
 *
 * Measured on 1,000 retained chunk WAVs: median 6,050ms, max 7,100ms (the
 * ceiling overshoots because RMS is sampled every ~200ms), and ZERO chunks under
 * 2s. The ceiling is the normal flush, not an edge case.
 */
export const CHUNK_CEILING_MS = 7_100

/**
 * Voiced milliseconds credited to each chunk, index-aligned to `chunks`.
 *
 * WHY A CAP. `elapsed` is a wall-clock offset, so the delta between consecutive
 * chunks is that chunk's audio PLUS all the dead air before it. Uncapped, that
 * dead air gets credited to whoever happened to speak last: on the 2026-08-04
 * "Design Gaps" meeting the deltas sum to 50.2 minutes against 8.1 minutes of
 * actual speech — a 6.2x inflation, with a 36.6s MEDIAN gap that would sail
 * under any outlier rule. One chunk elsewhere in the corpus credits 77.5
 * continuous minutes to a single speaker.
 *
 * Capping at the ceiling makes each chunk contribute at most the audio it could
 * physically hold. Everything the cap removes is real elapsed time that was
 * never captured, and it is reported as `notCapturedMs` rather than distributed.
 */
export function creditedChunkMs(chunks: ReviewChunk[]): number[] {
  let prev = 0
  return chunks.map(c => {
    const at = typeof c.elapsed === 'number' && Number.isFinite(c.elapsed) ? c.elapsed : prev
    // Monotonic: a sidecar with a backwards or missing elapsed contributes 0
    // rather than a negative that would silently subtract from someone's total.
    const delta = Math.max(0, at - prev)
    prev = Math.max(prev, at)
    return Math.min(delta, CHUNK_CEILING_MS)
  })
}

/** One batch segment's word-level speaker timing, as the sidecar stores it. */
export interface SpeakerWordSegment {
  /** Absolute ms offset of this segment; word times are RELATIVE to it. */
  startElapsed?: number
  speakerWords?: Array<{ start?: number; end?: number; speaker?: string }>
}

/** Total length of a set of intervals, counting overlap ONCE. */
export function unionMs(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let total = 0
  let [start, end] = sorted[0]
  for (const [a, b] of sorted.slice(1)) {
    if (a > end) { total += end - start; start = a; end = b }
    else if (b > end) { end = b }
  }
  return total + (end - start)
}

/**
 * Voiced milliseconds per speaker, from the word timings the HQ batch pass
 * already wrote into the sidecar.
 *
 * WHY UNION AND NOT A SUM. Word intervals overlap — both within a segment and
 * across the overlapping batch windows. Measured over six real meetings, naively
 * summing word durations totals 1.20x to 1.50x the meeting's own duration, which
 * is impossible for voiced time. Union counts overlap once and lands at 0.75x to
 * 0.97x, always under wall clock, which is the shape the answer must have.
 *
 * This is real voiced time: silence between words is excluded by construction,
 * so it needs no ceiling, no gap heuristic, and no retained audio.
 */
export function speakerWordIntervals(
  segments: SpeakerWordSegment[],
): Map<string, Array<[number, number]>> {
  const byLabel = new Map<string, Array<[number, number]>>()
  for (const seg of segments) {
    const offset = typeof seg.startElapsed === 'number' && Number.isFinite(seg.startElapsed)
      ? seg.startElapsed
      : 0
    for (const w of seg.speakerWords ?? []) {
      const a = w.start
      const b = w.end
      if (typeof a !== 'number' || typeof b !== 'number') continue
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue
      const label = w.speaker ?? ''
      if (!byLabel.has(label)) byLabel.set(label, [])
      byLabel.get(label)!.push([offset + a * 1000, offset + b * 1000])
    }
  }
  return byLabel
}

/** Voiced ms per speaker, overlap within a speaker counted once. */
export function speakerWordMs(segments: SpeakerWordSegment[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const [label, ivs] of speakerWordIntervals(segments)) out.set(label, Math.round(unionMs(ivs)))
  return out
}

/**
 * The meeting-level decomposition.
 *
 * `voicedMs + notCapturedMs = durationMs` is the invariant that HOLDS.
 * attributed + unattributed does NOT sum to voiced, because a named and an
 * unnamed speaker can talk over each other and both are credited.
 */
function speakingBuckets(
  voices: VoiceReview[],
  intervalsFor: (label: string) => Array<[number, number]>,
  durationMs: number,
): {
  attributedSpeakingMs: number
  unattributedSpeakingMs: number
  voicedMs: number
  notCapturedMs: number
} {
  const gather = (pick: (v: VoiceReview) => boolean) =>
    Math.round(unionMs(voices.filter(pick).flatMap(v => intervalsFor(v.label))))
  const voiced = gather(() => true)
  return {
    attributedSpeakingMs: gather(v => v.nameAsserted),
    unattributedSpeakingMs: gather(v => !v.nameAsserted),
    voicedMs: voiced,
    // Wall clock that produced no voice at all: silence, dropped chunks, and
    // time the capture never saw. Reported, never distributed to a speaker.
    notCapturedMs: Math.max(0, durationMs - voiced),
  }
}

/** Build the whole review for one meeting's chunks. */
export function reviewMeetingSpeakers(
  chunks: ReviewChunk[],
  options: {
    owner?: string
    phrasesPerVoice?: number
    durationMs?: number
    /**
     * Labels a human vouched for in THIS meeting. The floor is a guard against
     * the identifier over-claiming; it was never meant to overrule a person who
     * was in the room. A confirmed label asserts its name with no rewrite —
     * the sidecar already carries it.
     */
    confirmed?: Set<string>
    /**
     * The sidecar's `batchSegments`, when the HQ pass has run. Their word
     * timings give real voiced time; without them speaking time falls back to
     * capped chunk deltas.
     */
    batchSegments?: SpeakerWordSegment[]
  } = {},
): MeetingSpeakerReview {
  const owner = options.owner ?? 'Me'
  const confirmed = options.confirmed ?? new Set<string>()
  const limit = options.phrasesPerVoice ?? 3
  const sequence = chunks.map(c => c.speaker ?? '')
  // The caller's durationMs (the sidecar's own) is the meeting's true end.
  // Falling back to max(elapsed) uses the START of the last chunk, which makes
  // the final timeline span zero-width — so prefer the real value and only
  // derive when it is absent.
  const lastStart = chunks.reduce((max, c) => Math.max(max, typeof c.elapsed === 'number' ? c.elapsed : 0), 0)
  const durationMs = typeof options.durationMs === 'number' && options.durationMs > lastStart
    ? options.durationMs
    : lastStart

  const labels = [...new Set(sequence)].filter(s => s.length > 0)
  const named = labels.filter(l => !isUnattributed(l))

  // Word timings when the HQ batch pass produced them (82 of 92 sidecars
  // measured), capped chunk deltas otherwise. The two are NOT interchangeable —
  // words are voiced time, deltas are wall clock with the silence capped off —
  // so the answer carries which one produced it.
  const wordIntervals = speakerWordIntervals(options.batchSegments ?? [])
  const speakingTimeSource: SpeakingTimeSource = wordIntervals.size > 0 ? 'words' : 'chunks'

  // The fallback expresses chunks as intervals too, so both paths decompose
  // through the same union arithmetic. `elapsed` is the chunk END, so a chunk
  // covers [end - credited, end] — non-overlapping by construction, because
  // `credited` is already the capped gap to the previous chunk.
  const chunkIntervals = new Map<string, Array<[number, number]>>()
  if (speakingTimeSource === 'chunks') {
    const credited = creditedChunkMs(chunks)
    chunks.forEach((c, i) => {
      if (credited[i] <= 0) return
      const end = typeof c.elapsed === 'number' && Number.isFinite(c.elapsed) ? c.elapsed : 0
      const label = c.speaker ?? ''
      if (!chunkIntervals.has(label)) chunkIntervals.set(label, [])
      chunkIntervals.get(label)!.push([end - credited[i], end])
    })
  }

  const intervalsFor = (label: string): Array<[number, number]> =>
    (speakingTimeSource === 'words' ? wordIntervals : chunkIntervals).get(label) ?? []
  const speakingFor = (label: string): number => Math.round(unionMs(intervalsFor(label)))

  const voices: VoiceReview[] = labels.map(label => {
    const own = chunks.filter(c => (c.speaker ?? '') === label)
    const sims = own.map(c => c.similarity).filter((s): s is number => typeof s === 'number' && s > 0)
    const runs = speakerRuns(sequence, label)
    const unattributed = isUnattributed(label)

    const thrashesWith: ThrashPair[] = []
    if (!unattributed) {
      for (const other of named) {
        if (other === label) continue
        const p = pairFlipRate(sequence, label, other)
        if (!p) continue
        if (p.flipRate > THRASH_FLIP_RATE && p.meanRun < THRASH_MEAN_RUN) {
          thrashesWith.push({
            speaker: other,
            flipRate: Math.round(p.flipRate * 1000) / 1000,
            meanRun: Math.round(p.meanRun * 100) / 100,
            sharedSegments: p.sharedSegments,
          })
        }
      }
      thrashesWith.sort((a, b) => b.flipRate - a.flipRate)
    }

    const meanSim = sims.length ? Math.round(mean(sims) * 1000) / 1000 : null
    const reliability: Reliability = unattributed
      ? 'unattributed'
      : thrashesWith.length > 0
        ? 'unreliable'
        : (meanSim ?? 0) >= CONFIDENT_SIMILARITY ? 'confident' : 'weak'

    // What stops this label being presented as a name. Collected as reasons
    // rather than a bare boolean: "2 segments" and "similarity 0.58" are
    // different problems and a reviewer deserves to see which one applies.
    const assertionBlockers: string[] = []
    if (unattributed) {
      assertionBlockers.push('no name was ever assigned to this voice')
    } else if (confirmed.has(label)) {
      // A human said this is them. Blockers stay OFF the list rather than being
      // listed-then-overridden, because a reviewer reading "similarity 0.56
      // below 0.65" under a name they personally confirmed would reasonably
      // conclude the confirmation had not taken. `thrashesWith` still renders,
      // so a genuinely mixed row is still visibly mixed.
    } else if (label === owner) {
      // The wearer is exempt. Their identity is established by wearing the
      // device, not by cosine — and the owner is verified at exactly this floor
      // (VERIFY_THRESHOLD 0.65), so they sit permanently on the boundary and any
      // thrash pair flips them. Measured across the 2026-08-06 corpus: the owner
      // row read "Unidentified voice" in 4 of 9 meetings, including one with 285
      // of their own segments. `thrashesWith` still renders, so a mixed row is
      // still visible — the name is asserted, the caveat is not hidden.
    } else {
      if (own.length < ASSERT_MIN_SEGMENTS) {
        assertionBlockers.push(`only ${own.length} segment${own.length === 1 ? '' : 's'} (needs ${ASSERT_MIN_SEGMENTS})`)
      }
      if ((meanSim ?? 0) < ASSERT_MIN_SIMILARITY) {
        assertionBlockers.push(`similarity ${(meanSim ?? 0).toFixed(2)} below ${ASSERT_MIN_SIMILARITY}`)
      }
      if (thrashesWith.length > 0) {
        assertionBlockers.push(`swaps with ${thrashesWith[0].speaker} every ${Math.round(thrashesWith[0].meanRun)} segments`)
      }
    }

    return {
      label,
      segments: own.length,
      speakingMs: speakingFor(label),
      meanSimilarity: meanSim,
      meanRun: Math.round(mean(runs) * 100) / 100,
      longestRun: runs.length ? Math.max(...runs) : 0,
      isOwner: label === owner,
      /** True when a human vouched for this label in this meeting. */
      confirmedByHuman: confirmed.has(label),
      reliability,
      nameAsserted: assertionBlockers.length === 0,
      assertionBlockers,
      thrashesWith,
      phrases: selectPhrases(chunks, label, limit, durationMs),
    }
  })

  voices.sort((a, b) => b.segments - a.segments)
  return {
    segments: chunks.length,
    attributed: named.length > 0,
    // Derived from `nameAsserted`, NOT from `isUnattributed`. Those two answer
    // different questions and diverge badly: measured on session 0i1xv3, the
    // label-based count is 287 of 379 segments while only 177 belong to voices
    // the panel actually shows with a name — a 29-point gap. A header built on
    // labels would claim three quarters of the meeting was identified above a
    // list of rows reading "Unidentified voice", which is the confusion this
    // number exists to remove.
    assertedSegments: voices.reduce((n, v) => (v.nameAsserted ? n + v.segments : n), 0),
    speakingTimeSource,
    // UNION, not sum. Speakers overlap — crosstalk means two people are each
    // correctly credited for the same wall-clock second, so per-speaker times
    // legitimately add up to MORE than the meeting. Verified against a real
    // 5.2-minute capture where the per-speaker figures summed to 6.0 minutes.
    // Summing here produced a bucket total larger than the meeting itself.
    //
    // Split by nameAsserted PER VOICE, never per segment: a per-segment floor
    // cannot express ASSERT_MIN_SEGMENTS nor carry the owner and confirmed
    // waivers, so it contradicts the rows above it (measured on 2026-08-02 "G2
    // App Fixes": panel names MU for 47.3%, per-segment floor 14.9%).
    ...speakingBuckets(voices, intervalsFor, durationMs),
    durationMs,
    voices,
    timeline: speakerTimeline(chunks, durationMs),
  }
}
