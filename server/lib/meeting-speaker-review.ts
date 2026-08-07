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
    durationMs,
    voices,
    timeline: speakerTimeline(chunks, durationMs),
  }
}
