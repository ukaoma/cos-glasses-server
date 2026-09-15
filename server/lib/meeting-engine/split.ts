/**
 * Splitting one long recording into the meetings it actually holds (6.47.0, WS3).
 *
 * PURE. No filesystem, no network, no clock.
 *
 * A recorder left running across a morning produces one three-hour "meeting" that is
 * really three. The boundaries come from CONTENT: where each separate capture's shared
 * phrases begin and end inside the long recording, snapped outward to a real silence.
 * Measured against Miles's own manual split of the Aug 20 recording, the four boundaries
 * land 27, 25, 42 and 42 s from where he put them.
 *
 * Calendar events and silence alone were measured and rejected: the calendar flagged 40 of
 * 42 long recordings as spanning, which is noise, not a signal. Those cases stay
 * suggestions in this release.
 */

import {
  type AnchorSample,
  type FirefliesMeetingInput,
  type G2RecordingInput,
  anchorsInBand,
  contentEvidence,
  g2TimedWords,
  speechGaps,
} from './evidence.js'

/** Two hours. Below this, a recording holding two meetings is rare enough to leave alone. */
export const LONG_RECORDING_S = 7200

/** Shared phrases a capture needs before its span may cut the recording. */
export const SPLIT_MIN_ANCHORS = 30

/** One capture inside a long recording is a partial capture, not a split. */
export const SPLIT_MIN_INSIDE_RECORDINGS = 2

/** A silence this long is a real gap between meetings, not a pause for breath. */
export const SPLIT_GAP_S = 90

/** How far a span edge may be moved to land on that silence. */
export const SPLIT_SNAP_S = 90

/** A piece shorter than this is an artefact; it joins its neighbour. */
export const MIN_PIECE_S = 120

/** When one capture covers this much of the recording, they are one meeting: pair, do not split. */
export const SPLIT_PAIRING_COVERAGE = 0.8

/** Span edges are percentiles, so one stray early or late anchor cannot stretch a piece. */
export const SPAN_LOW_PERCENTILE = 0.01
export const SPAN_HIGH_PERCENTILE = 0.99

export interface ContentSpan {
  sessionId: string
  /** Seconds from the recording start, after snapping to silence. */
  startS: number
  endS: number
  /** Before snapping, for the report and the tests. */
  rawStartS: number
  rawEndS: number
  anchors: number
  offsetMs: number
  /** The capture's extent on the recording's timeline, as a fraction of the recording. */
  coverage: number
}

export type PieceKind = 'matched' | 'unmatched'

export interface SplitPiece {
  index: number
  startS: number
  endS: number
  kind: PieceKind
  /** The captures whose content defines this piece, in span order. */
  sessionIds: string[]
}

export type SplitRefusal =
  | 'not_long_enough'
  | 'too_few_inside'
  | 'one_capture_covers_recording'

export interface SplitPlan {
  firefliesId: string
  split: boolean
  refusal?: SplitRefusal
  spans: ContentSpan[]
  pieces: SplitPiece[]
}

function percentileAt(sorted: readonly number[], fraction: number): number {
  return sorted[Math.trunc(fraction * (sorted.length - 1))]
}

/**
 * Move a span edge onto the near side of a nearby silence.
 *
 * A start moves to where speech RESUMES and an end to where it STOPS, so the silence
 * between two meetings belongs to neither piece's content and the boundary sits where a
 * person would put it.
 */
export function snapToGap(
  timeS: number,
  gaps: readonly { startS: number; endS: number }[],
  edge: 'start' | 'end',
  withinS: number = SPLIT_SNAP_S,
): number {
  let best: number | null = null
  let bestDistance = Infinity
  for (const gap of gaps) {
    const candidate = edge === 'start' ? gap.endS : gap.startS
    const distance = Math.abs(candidate - timeS)
    if (distance <= withinS && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best ?? timeS
}

/** Where one capture's content sits inside one recording. */
export function contentSpanFor(
  recording: G2RecordingInput,
  meeting: FirefliesMeetingInput,
  minAnchors: number = SPLIT_MIN_ANCHORS,
): ContentSpan | null {
  const { words } = g2TimedWords(recording)
  const evidence = contentEvidence(words, meeting.sentences)
  if (evidence.offsetMs === null) return null
  const cluster: AnchorSample[] = anchorsInBand(evidence.samples, evidence.offsetMs)
  if (cluster.length < minAnchors) return null
  const times = cluster.map(sample => sample.firefliesMs)
  const rawStartS = percentileAt(times, SPAN_LOW_PERCENTILE) / 1000
  const rawEndS = percentileAt(times, SPAN_HIGH_PERCENTILE) / 1000
  const gaps = speechGaps(meeting.sentences, SPLIT_GAP_S)
  const offsetS = evidence.offsetMs / 1000
  const captureEndS = offsetS + recording.durationMs / 1000
  const covered = Math.max(0, Math.min(meeting.durationS, captureEndS) - Math.max(0, offsetS))
  return {
    sessionId: recording.sessionId,
    startS: snapToGap(rawStartS, gaps, 'start'),
    endS: snapToGap(rawEndS, gaps, 'end'),
    rawStartS,
    rawEndS,
    anchors: cluster.length,
    offsetMs: evidence.offsetMs,
    coverage: meeting.durationS > 0 ? covered / meeting.durationS : 0,
  }
}

/**
 * Resolve two spans that claim the same seconds.
 *
 * A silence inside the contested stretch is the honest boundary. Without one, the midpoint
 * at least keeps every second in exactly one piece, which is the property the pieces must
 * have.
 */
export function resolveOverlap(
  endOfEarlier: number,
  startOfLater: number,
  gaps: readonly { startS: number; endS: number }[],
): number {
  const low = Math.min(startOfLater, endOfEarlier)
  const high = Math.max(startOfLater, endOfEarlier)
  for (const gap of gaps) {
    if (gap.startS >= low && gap.endS <= high) return gap.startS
  }
  return (low + high) / 2
}

/** Merge pieces under the minimum into the earlier neighbour, or the later one when first. */
export function mergeShortPieces(pieces: readonly SplitPiece[], minPieceS: number = MIN_PIECE_S): SplitPiece[] {
  const working = pieces.map(piece => ({ ...piece, sessionIds: [...piece.sessionIds] }))
  for (;;) {
    if (working.length <= 1) break
    const index = working.findIndex(piece => piece.endS - piece.startS < minPieceS)
    if (index === -1) break
    const short = working[index]
    const intoIndex = index > 0 ? index - 1 : 1
    const into = working[intoIndex]
    into.startS = Math.min(into.startS, short.startS)
    into.endS = Math.max(into.endS, short.endS)
    for (const sessionId of short.sessionIds) {
      if (!into.sessionIds.includes(sessionId)) into.sessionIds.push(sessionId)
    }
    if (into.sessionIds.length > 0) into.kind = 'matched'
    working.splice(index, 1)
  }
  return working.map((piece, index) => ({ ...piece, index }))
}

/**
 * The pieces of one long recording.
 *
 * Every second of the recording lands in exactly one piece, including the stretches no
 * capture matched: dropping them would lose content, which this release never does.
 */
export function splitPlanFor(
  meeting: FirefliesMeetingInput,
  recordings: readonly G2RecordingInput[],
  options: { minInside?: number; longRecordingS?: number } = {},
): SplitPlan {
  const longRecordingS = options.longRecordingS ?? LONG_RECORDING_S
  const minInside = options.minInside ?? SPLIT_MIN_INSIDE_RECORDINGS
  const spans = recordings
    .map(recording => contentSpanFor(recording, meeting))
    .filter((span): span is ContentSpan => span !== null)
    .sort((a, b) => (a.startS - b.startS) || (a.sessionId < b.sessionId ? -1 : 1))

  if (meeting.durationS < longRecordingS) return { firefliesId: meeting.id, split: false, refusal: 'not_long_enough', spans, pieces: [] }
  if (spans.length < minInside) return { firefliesId: meeting.id, split: false, refusal: 'too_few_inside', spans, pieces: [] }
  if (spans.some(span => span.coverage >= SPLIT_PAIRING_COVERAGE)) {
    return { firefliesId: meeting.id, split: false, refusal: 'one_capture_covers_recording', spans, pieces: [] }
  }

  const gaps = speechGaps(meeting.sentences, SPLIT_GAP_S)
  const bounded = spans.map(span => ({
    ...span,
    startS: Math.max(0, Math.min(meeting.durationS, span.startS)),
    endS: Math.max(0, Math.min(meeting.durationS, span.endS)),
  }))
  for (let i = 0; i + 1 < bounded.length; i++) {
    if (bounded[i].endS > bounded[i + 1].startS) {
      const boundary = resolveOverlap(bounded[i].endS, bounded[i + 1].startS, gaps)
      bounded[i].endS = boundary
      bounded[i + 1].startS = boundary
    }
  }

  const pieces: SplitPiece[] = []
  let cursor = 0
  for (const span of bounded) {
    const start = Math.max(cursor, span.startS)
    if (start > cursor) pieces.push({ index: pieces.length, startS: cursor, endS: start, kind: 'unmatched', sessionIds: [] })
    const end = Math.max(start, span.endS)
    pieces.push({ index: pieces.length, startS: start, endS: end, kind: 'matched', sessionIds: [span.sessionId] })
    cursor = end
  }
  if (cursor < meeting.durationS) {
    pieces.push({ index: pieces.length, startS: cursor, endS: meeting.durationS, kind: 'unmatched', sessionIds: [] })
  }
  return { firefliesId: meeting.id, split: true, spans: bounded, pieces: mergeShortPieces(pieces) }
}
