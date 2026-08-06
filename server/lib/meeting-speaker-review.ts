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
  /** MILLISECONDS from meeting start. Confirmed against the writer:
   *  meeting.ts accumulates `elapsed += row.durationMs`. Treating this as
   *  seconds reports a 32-minute meeting as 30,936 minutes. */
  elapsed?: number
  similarity?: number
}

/** Labels that mean "nobody was identified", not a person. */
export const UNATTRIBUTED = new Set(['Unknown', 'Ext', '', 'Speaker 1', 'Speaker 2', 'Speaker 3'])

/** Calibrated from the control pair above. A pair must be BOTH flip-happy and
 *  short-run to be called unreliable — either alone has honest explanations
 *  (a rapid-fire exchange is flip-happy; a brief interjection is short-run). */
export const THRASH_FLIP_RATE = 0.20
export const THRASH_MEAN_RUN = 8
/** Below the search-accept threshold a name was never asserted with confidence. */
export const CONFIDENT_SIMILARITY = 0.65

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
  reliability: Reliability
  thrashesWith: ThrashPair[]
  phrases: Phrase[]
}

export interface MeetingSpeakerReview {
  segments: number
  /** False when no chunk carries a real speaker — a recovered capture. */
  attributed: boolean
  durationMs: number
  voices: VoiceReview[]
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
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
    .map(({ text, atMs, similarity }) => ({ text, atMs, similarity }))
}

/** Build the whole review for one meeting's chunks. */
export function reviewMeetingSpeakers(
  chunks: ReviewChunk[],
  options: { owner?: string; phrasesPerVoice?: number } = {},
): MeetingSpeakerReview {
  const owner = options.owner ?? 'Me'
  const limit = options.phrasesPerVoice ?? 3
  const sequence = chunks.map(c => c.speaker ?? '')
  const durationMs = chunks.reduce((max, c) => Math.max(max, typeof c.elapsed === 'number' ? c.elapsed : 0), 0)

  const labels = [...new Set(sequence)].filter(s => s.length > 0)
  const named = labels.filter(l => !UNATTRIBUTED.has(l))

  const voices: VoiceReview[] = labels.map(label => {
    const own = chunks.filter(c => (c.speaker ?? '') === label)
    const sims = own.map(c => c.similarity).filter((s): s is number => typeof s === 'number' && s > 0)
    const runs = speakerRuns(sequence, label)
    const unattributed = UNATTRIBUTED.has(label)

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

    return {
      label,
      segments: own.length,
      meanSimilarity: meanSim,
      meanRun: Math.round(mean(runs) * 100) / 100,
      longestRun: runs.length ? Math.max(...runs) : 0,
      isOwner: label === owner,
      reliability,
      thrashesWith,
      phrases: selectPhrases(chunks, label, limit, durationMs),
    }
  })

  voices.sort((a, b) => b.segments - a.segments)
  return { segments: chunks.length, attributed: named.length > 0, durationMs, voices }
}
