/**
 * Candidates, duplicate collapse, tiers and grouping (6.47.0, WS3).
 *
 * PURE. No filesystem, no network, no clock.
 *
 * Measured on 198 G2 recordings that already have a merge: 161 auto, 21 suggest, 16 none,
 * with 155 of the 161 agreeing with the existing merge. `server/scripts/engine-canary.ts`
 * reproduces those counts within ±2 before this ships.
 */

import {
  type FirefliesMeetingInput,
  type G2RecordingInput,
  type G2TimingMode,
  EVIDENCE_BIN_MS,
  contentEvidence,
  firefliesInterval,
  g2Interval,
  g2TimedWords,
  overlapFraction,
} from './evidence.js'

/**
 * How far outside the G2 interval a Fireflies meeting may start or end and still be
 * scored. An hour is generous on purpose: time only selects candidates here, and content
 * refuses the wrong ones. A tight window would instead silently drop the cases where one
 * side's clock or scheduled start is off.
 */
export const CANDIDATE_PAD_S = 3600

/** Shared phrases needed before a merge may happen without asking. */
export const AUTO_MIN_ANCHORS = 30

/** How far the winner must beat the next distinct meeting. */
export const AUTO_DOMINANCE = 3

/** Below this, content evidence is noise and nothing is offered. */
export const SUGGEST_MIN_ANCHORS = 10

/**
 * How far the offset that shared phrases imply may sit from what the two CLOCKS say.
 *
 * WHY A BAND. Content decides which meeting a capture belongs to, but content alone cannot
 * tell a meeting from the boilerplate it shares with its neighbour: a recurring agenda read
 * out in the 10:30 call stacks into one dense bin against the 10:00 capture exactly as a
 * real match does. The clocks separate them.
 *
 * WHY FIFTEEN MINUTES AND NOT FIVE. Measured over all 198 scored recordings, not the ten
 * the alignment sample used: the winning pair's skew runs median 84 s, p90 271 s, with a
 * real tail — 9 of the 167 winners that ARE the recorded merge sit past 300 s and the
 * worst sits at 5,877 s. At a 300 s band three genuine merges collapse from K 5,700, 3,923
 * and 3,980 to K 1, and the reproduction gate fails at 159 / 19 / 20. At 900 s the gate
 * holds (161 / 20 / 17) and the contaminating neighbour, 1,620 s off its clock, is still
 * refused with room to spare.
 *
 * WHAT IT DOES NOT DO. Two meetings less than about fifteen minutes apart are not separated
 * by this rule; K and dominance remain the defence there.
 */
export const PAIRING_CLOCK_BAND_S = 900

/** Two Fireflies recordings of ONE meeting start within this many seconds of each other. */
export const DUPLICATE_START_S = 300

/** ...and overlap by at least this fraction of the shorter one. */
export const DUPLICATE_OVERLAP = 0.8

export type MergeTier = 'auto_merge' | 'suggest' | 'none'

export type CandidateRejectionReason =
  /** Fireflies returned no usable duration, so the interval is unknown. */
  | 'duration_unknown'
  /** Its interval does not reach the padded G2 interval. */
  | 'outside_padded_interval'
  /** Shared phrases exist, but the offset they imply puts the capture outside the recording. */
  | 'offset_outside_interval'

export interface CandidateScore {
  firefliesId: string
  k: number
  offsetMs: number | null
  sentenceCount: number
  startMs: number
  durationS: number
  /** Shared phrases the clock band threw out: high means boilerplate, not a match. */
  anchorsOutsideClockBand: number
}

export interface CandidateRejection {
  firefliesId: string
  reason: CandidateRejectionReason
  k?: number
  offsetMs?: number | null
}

export interface PairingResult {
  sessionId: string
  tier: MergeTier
  /** Shared phrases with the winner. */
  k1: number
  /** Shared phrases with the best OTHER meeting, after duplicate collapse. */
  k2: number
  offsetMs: number | null
  /** The Fireflies meeting a merge would be built on, or null. */
  primaryFirefliesId: string | null
  /** Other recordings of the same meeting; their transcripts are kept as alternates. */
  duplicateFirefliesIds: string[]
  candidates: CandidateScore[]
  rejections: CandidateRejection[]
  timingMode: G2TimingMode
}

export interface MergeGroup {
  primaryFirefliesId: string
  /** Duplicate recordings of the same meeting, in id order. */
  alternateFirefliesIds: string[]
  /** Every G2 capture of this meeting, in start order. */
  sessionIds: string[]
  k1: number
  k2: number
  /**
   * The offset PAIRING measured for each capture, in ms, or null when it measured none.
   *
   * WHY THE GROUP HAS TO CARRY IT. Alignment needs a coarse offset to search around, and
   * without one it falls back to the difference between the two CLOCKS. Pairing already knows
   * better: it found the offset the shared phrases imply, which is the whole point of the
   * evidence step. On the 9 of 167 winners whose clocks disagree by more than 300 s, the
   * clock fallback puts the alignment band (`ALIGN_BAND_S = 300`) entirely off the real
   * anchors, so alignment fails and the capture is attached without relabelling — silently,
   * because "unaligned" is a legitimate outcome.
   */
  offsetMsBySession: Record<string, number | null>
}

export function tierFor(k1: number, k2: number): MergeTier {
  if (k1 >= AUTO_MIN_ANCHORS && k1 >= AUTO_DOMINANCE * Math.max(k2, 1)) return 'auto_merge'
  if (k1 >= AUTO_MIN_ANCHORS) return 'suggest'
  if (k1 >= SUGGEST_MIN_ANCHORS) return 'suggest'
  return 'none'
}

/** Two Fireflies recordings of one meeting. */
export function isDuplicateRecording(a: FirefliesMeetingInput, b: FirefliesMeetingInput): boolean {
  return (
    Math.abs(a.startMs - b.startMs) <= DUPLICATE_START_S * 1000
    && overlapFraction(firefliesInterval(a), firefliesInterval(b)) >= DUPLICATE_OVERLAP
  )
}

/**
 * Fireflies meetings whose interval reaches the G2 interval padded by an hour.
 *
 * Seconds, and these exact comparisons, because the tier measurement used them; moving to
 * milliseconds changes which meetings sit exactly on the boundary.
 */
export function candidatesFor(
  recording: G2RecordingInput,
  meetings: readonly FirefliesMeetingInput[],
): { candidates: FirefliesMeetingInput[]; rejections: CandidateRejection[] } {
  const startS = recording.startMs / 1000 - CANDIDATE_PAD_S
  const endS = (recording.startMs + recording.durationMs) / 1000 + CANDIDATE_PAD_S
  const candidates: FirefliesMeetingInput[] = []
  const rejections: CandidateRejection[] = []
  for (const meeting of meetings) {
    if (!(meeting.durationS > 0)) {
      rejections.push({ firefliesId: meeting.id, reason: 'duration_unknown' })
      continue
    }
    const meetingStartS = meeting.startMs / 1000
    if (meetingStartS < endS && meetingStartS + meeting.durationS > startS) candidates.push(meeting)
    else rejections.push({ firefliesId: meeting.id, reason: 'outside_padded_interval' })
  }
  return { candidates, rejections }
}

/**
 * Does the offset put the G2 capture inside this recording?
 *
 * A contaminating meeting — the one before this one, or last week's run of the same
 * recurring call — shares agenda phrases, and those phrases can stack into one dense bin.
 * When the offset that bin implies would place the capture outside the recording it was
 * supposedly part of, the phrases are boilerplate, not evidence.
 */
export function offsetPlacesCaptureInside(
  offsetMs: number,
  recording: G2RecordingInput,
  meeting: FirefliesMeetingInput,
  padS: number = CANDIDATE_PAD_S,
): boolean {
  const padMs = padS * 1000
  return offsetMs >= -padMs && offsetMs + recording.durationMs <= meeting.durationS * 1000 + padMs
}

/**
 * Score one G2 capture against every Fireflies meeting.
 *
 * The winner's duplicates are collapsed BEFORE dominance is checked. Without that, a
 * meeting recorded twice (two bots in the call) is its own strongest rival and every such
 * capture falls to `suggest` — 16 of the 161 automatic merges are only automatic because
 * of this step.
 */
export function scoreRecording(
  recording: G2RecordingInput,
  meetings: readonly FirefliesMeetingInput[],
): PairingResult {
  const { words, mode } = g2TimedWords(recording)
  const { candidates, rejections } = candidatesFor(recording, meetings)
  const scored: CandidateScore[] = []
  for (const meeting of candidates) {
    // Centred on the clocks: t_ff - t_g2 equals g2Start - ffStart for a real match.
    const evidence = contentEvidence(words, meeting.sentences, EVIDENCE_BIN_MS, {
      centreMs: recording.startMs - meeting.startMs,
      halfWidthMs: PAIRING_CLOCK_BAND_S * 1000,
    })
    if (evidence.offsetMs !== null && !offsetPlacesCaptureInside(evidence.offsetMs, recording, meeting)) {
      rejections.push({ firefliesId: meeting.id, reason: 'offset_outside_interval', k: evidence.k, offsetMs: evidence.offsetMs })
      continue
    }
    scored.push({
      firefliesId: meeting.id,
      k: evidence.k,
      offsetMs: evidence.offsetMs,
      sentenceCount: meeting.sentences.length,
      startMs: meeting.startMs,
      durationS: meeting.durationS,
      anchorsOutsideClockBand: evidence.outsideBand,
    })
  }
  // (k, id) descending: the measurement sorted the same tuples in reverse.
  scored.sort((a, b) => (b.k - a.k) || (a.firefliesId < b.firefliesId ? 1 : a.firefliesId > b.firefliesId ? -1 : 0))

  const empty: PairingResult = {
    sessionId: recording.sessionId,
    tier: 'none',
    k1: 0,
    k2: 0,
    offsetMs: null,
    primaryFirefliesId: null,
    duplicateFirefliesIds: [],
    candidates: scored,
    rejections,
    timingMode: mode,
  }
  if (scored.length === 0) return empty

  const byId = new Map(meetings.map(m => [m.id, m]))
  const top = scored[0]
  const topMeeting = byId.get(top.firefliesId)!
  const cluster = [top]
  const rest: CandidateScore[] = []
  for (const candidate of scored.slice(1)) {
    const meeting = byId.get(candidate.firefliesId)!
    if (isDuplicateRecording(topMeeting, meeting)) cluster.push(candidate)
    else rest.push(candidate)
  }
  const k1 = top.k
  const k2 = rest.length > 0 ? rest[0].k : 0
  const tier = tierFor(k1, k2)
  if (tier === 'none') return { ...empty, candidates: scored, k1, k2, offsetMs: top.offsetMs }

  const primary = pickPrimary(cluster)
  return {
    sessionId: recording.sessionId,
    tier,
    k1,
    k2,
    offsetMs: (cluster.find(c => c.firefliesId === primary.firefliesId) ?? top).offsetMs,
    primaryFirefliesId: primary.firefliesId,
    duplicateFirefliesIds: cluster.filter(c => c.firefliesId !== primary.firefliesId).map(c => c.firefliesId).sort(),
    candidates: scored,
    rejections,
    timingMode: mode,
  }
}

/** The fullest transcript of a meeting leads; the others are kept as alternates. */
export function pickPrimary(cluster: readonly CandidateScore[]): CandidateScore {
  return [...cluster].sort((a, b) =>
    (b.sentenceCount - a.sentenceCount)
    || (b.k - a.k)
    || (a.startMs - b.startMs)
    || (a.firefliesId < b.firefliesId ? -1 : a.firefliesId > b.firefliesId ? 1 : 0),
  )[0]
}

/**
 * One merged record per meeting, holding every capture of it.
 *
 * Blocker 10: scoring is per capture, so two G2 recordings of one meeting — a battery
 * swap, a rejoin — produced two merged records of the same meeting, each claiming the same
 * Fireflies transcript. Grouping by the Fireflies primary is what makes the output one
 * record. A capture belongs to at most one group, because it has one primary.
 */
export function groupAutoMerges(
  results: readonly PairingResult[],
  recordings: readonly G2RecordingInput[],
): MergeGroup[] {
  const startById = new Map(recordings.map(r => [r.sessionId, r.startMs]))
  const groups = new Map<string, MergeGroup>()
  for (const result of results) {
    if (result.tier !== 'auto_merge' || !result.primaryFirefliesId) continue
    const existing = groups.get(result.primaryFirefliesId)
    if (existing) {
      existing.sessionIds.push(result.sessionId)
      for (const id of result.duplicateFirefliesIds) {
        if (!existing.alternateFirefliesIds.includes(id)) existing.alternateFirefliesIds.push(id)
      }
      existing.k1 = Math.max(existing.k1, result.k1)
      existing.k2 = Math.max(existing.k2, result.k2)
      existing.offsetMsBySession[result.sessionId] = result.offsetMs
      continue
    }
    groups.set(result.primaryFirefliesId, {
      primaryFirefliesId: result.primaryFirefliesId,
      alternateFirefliesIds: [...result.duplicateFirefliesIds],
      sessionIds: [result.sessionId],
      k1: result.k1,
      k2: result.k2,
      offsetMsBySession: { [result.sessionId]: result.offsetMs },
    })
  }
  const ordered = [...groups.values()]
  for (const group of ordered) {
    group.sessionIds.sort((a, b) => (startById.get(a) ?? 0) - (startById.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    group.alternateFirefliesIds.sort()
  }
  return ordered.sort((a, b) => (a.primaryFirefliesId < b.primaryFirefliesId ? -1 : a.primaryFirefliesId > b.primaryFirefliesId ? 1 : 0))
}
