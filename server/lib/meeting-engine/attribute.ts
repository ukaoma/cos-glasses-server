/**
 * Per-sentence speaker labels on a merged record (6.47.0, WS3, decision D13).
 *
 * PURE. No filesystem, no network, no clock.
 *
 * WHAT THIS MAY AND MAY NOT DO. It may put a G2 voice-match name on a Fireflies sentence
 * whose label asserts no identity, and it may note that the two sides agree. It may never
 * overwrite a name a person gave with a name a voiceprint guessed: on a conflict the
 * Fireflies label stands and the disagreement is recorded. Speaker identity is a
 * suggestion, never an assertion, and this is the layer where that rule is enforced.
 *
 * `ATTRIBUTE_MODE = 'capture_only'` returns the engine to the pipeline's older stance —
 * attach the capture, relabel nothing — without touching any other code path.
 */

import {
  type FirefliesSentenceInput,
  type LabelInterval,
  median,
  overlapMs,
} from './evidence.js'
import { type Alignment, offsetAt } from './align.js'

/** The winner must hold this much of the sentence's voiced time. */
export const ATTRIBUTE_MIN_SHARE = 0.6

/**
 * Voice-match floor for naming. This is the same 0.55 that `merge-profiles` refuses below:
 * the number that separates one person from another person with a similar voice.
 */
export const ATTRIBUTE_MIN_SIMILARITY = 0.55

/** Tokens shorter than this ("de", "la", "jr") make two different names look equal. */
export const NAME_TOKEN_MIN_LENGTH = 3

/**
 * Labels that assert no identity. A superset of the server's `UNATTRIBUTED` set and its
 * numbered `Unidentified N` de-attributions, plus the shapes Fireflies produces.
 */
export const GENERIC_LABEL_PATTERN = /^(speaker\s*[a-z0-9]*|unidentified(\s+speaker)?(\s*\d+)?|unknown|ext|remote speaker|voice\s*\d+|)$/i

/** `'relabel'` applies D13. `'capture_only'` keeps every Fireflies label as it is. */
export type AttributeMode = 'relabel' | 'capture_only'

export const ATTRIBUTE_MODE: AttributeMode = 'relabel'

export function isGenericLabel(label: string | undefined | null): boolean {
  return GENERIC_LABEL_PATTERN.test(String(label ?? '').trim())
}

export function nameTokens(label: string | undefined | null): Set<string> {
  return new Set(
    String(label ?? '')
      .toLowerCase()
      .split(/[\s._@-]+/)
      .filter(token => token.length >= NAME_TOKEN_MIN_LENGTH),
  )
}

/** Two labels name the same person when they share a token of real length. */
export function namesAgree(a: string, b: string): boolean {
  const left = nameTokens(a)
  for (const token of nameTokens(b)) if (left.has(token)) return true
  return false
}

export type SentenceOutcome =
  /** The Fireflies label asserted no identity and a G2 name took its place. */
  | 'replaced_generic'
  /** Both sides name the same person. */
  | 'agree'
  /** They disagree; the Fireflies label stands. */
  | 'conflict'
  /** No G2 name qualified; the Fireflies label stands. */
  | 'kept'

export type KeptReason = 'no_g2_audio' | 'low_share' | 'generic_g2' | 'low_similarity' | 'capture_only'

export interface SentenceLabel {
  index: number
  ffLabel: string
  /** The G2 winner, whether or not it was applied. Null when no capture covered the sentence. */
  g2Label: string | null
  /** The label the render uses. */
  resolvedLabel: string
  /** The winner's share of the sentence's voiced time. */
  share: number
  /** The winner's best voice-match similarity. */
  similarity: number
  windowOffsetMs: number | null
  outcome: SentenceOutcome
  keptReason?: KeptReason
  humanConfirmed: boolean
}

export interface SpeakerVerification {
  name: string
  medianSimilarity: number
  sentences: number
  humanConfirmed: boolean
}

export interface AttributionInput {
  sessionId: string
  alignment: Alignment
  labels: readonly LabelInterval[]
}

export interface AttributionResult {
  labels: SentenceLabel[]
  conflicts: number[]
  verification: SpeakerVerification[]
  mode: AttributeMode
}

interface Winner {
  speaker: string
  share: number
  similarity: number
  humanConfirmed: boolean
  windowOffsetMs: number
}

/** The G2 speaker who holds most of one sentence, across every aligned capture. */
function winnerFor(
  sentence: FirefliesSentenceInput,
  captures: readonly AttributionInput[],
): Winner | null {
  const startMs = (Number(sentence.start_time ?? 0) || 0) * 1000
  const endMs = (Number(sentence.end_time ?? 0) || 0) * 1000
  if (!(endMs > startMs)) return null
  const weights = new Map<string, number>()
  const similarities = new Map<string, number>()
  const confirmed = new Map<string, boolean>()
  let windowOffsetMs: number | null = null
  for (const capture of captures) {
    if (!capture.alignment.aligned) continue
    const offset = offsetAt(capture.alignment, startMs - (capture.alignment.offsetMs ?? 0))
    if (windowOffsetMs === null) windowOffsetMs = offset
    const span: [number, number] = [startMs - offset, endMs - offset]
    for (const label of capture.labels) {
      const shared = overlapMs(span, [label.startMs, label.endMs])
      if (shared <= 0) continue
      weights.set(label.speaker, (weights.get(label.speaker) ?? 0) + shared)
      similarities.set(label.speaker, Math.max(similarities.get(label.speaker) ?? 0, label.similarity))
      confirmed.set(label.speaker, (confirmed.get(label.speaker) ?? false) || label.humanConfirmed)
    }
  }
  if (weights.size === 0) return null
  let speaker = ''
  let best = -1
  let total = 0
  for (const [name, weight] of weights) {
    total += weight
    if (weight > best) {
      best = weight
      speaker = name
    }
  }
  return {
    speaker,
    share: total > 0 ? best / total : 0,
    similarity: similarities.get(speaker) ?? 0,
    humanConfirmed: confirmed.get(speaker) ?? false,
    windowOffsetMs: windowOffsetMs ?? 0,
  }
}

/**
 * Resolve every Fireflies sentence against the aligned G2 captures.
 *
 * A name is applied only when it holds the sentence (`ATTRIBUTE_MIN_SHARE`), asserts an
 * identity, and is either a confident voice match or a name a person confirmed. Human
 * confirmation stands in for similarity because a person already answered the question the
 * similarity score estimates.
 */
export function attributeSentences(
  sentences: readonly FirefliesSentenceInput[],
  captures: readonly AttributionInput[],
  mode: AttributeMode = ATTRIBUTE_MODE,
): AttributionResult {
  const labels: SentenceLabel[] = []
  const conflicts: number[] = []
  const applied = new Map<string, { similarities: number[]; humanConfirmed: boolean }>()

  sentences.forEach((sentence, index) => {
    const ffLabel = String(sentence.speaker_name ?? '')
    if (mode === 'capture_only') {
      labels.push({
        index,
        ffLabel,
        g2Label: null,
        resolvedLabel: ffLabel,
        share: 0,
        similarity: 0,
        windowOffsetMs: null,
        outcome: 'kept',
        keptReason: 'capture_only',
        humanConfirmed: false,
      })
      return
    }
    const winner = winnerFor(sentence, captures)
    if (!winner) {
      labels.push({
        index,
        ffLabel,
        g2Label: null,
        resolvedLabel: ffLabel,
        share: 0,
        similarity: 0,
        windowOffsetMs: null,
        outcome: 'kept',
        keptReason: 'no_g2_audio',
        humanConfirmed: false,
      })
      return
    }
    const base = {
      index,
      ffLabel,
      g2Label: winner.speaker,
      share: winner.share,
      similarity: winner.similarity,
      windowOffsetMs: winner.windowOffsetMs,
      humanConfirmed: winner.humanConfirmed,
    }
    const keptReason: KeptReason | null = winner.share < ATTRIBUTE_MIN_SHARE
      ? 'low_share'
      : isGenericLabel(winner.speaker)
        ? 'generic_g2'
        : !winner.humanConfirmed && winner.similarity < ATTRIBUTE_MIN_SIMILARITY
          ? 'low_similarity'
          : null
    if (keptReason) {
      labels.push({ ...base, resolvedLabel: ffLabel, outcome: 'kept', keptReason })
      return
    }
    const record = applied.get(winner.speaker) ?? { similarities: [], humanConfirmed: false }
    record.similarities.push(winner.similarity)
    record.humanConfirmed = record.humanConfirmed || winner.humanConfirmed
    applied.set(winner.speaker, record)
    if (isGenericLabel(ffLabel)) {
      labels.push({ ...base, resolvedLabel: winner.speaker, outcome: 'replaced_generic' })
      return
    }
    if (namesAgree(winner.speaker, ffLabel)) {
      labels.push({ ...base, resolvedLabel: ffLabel, outcome: 'agree' })
      return
    }
    conflicts.push(index)
    labels.push({ ...base, resolvedLabel: ffLabel, outcome: 'conflict' })
  })

  const verification: SpeakerVerification[] = [...applied.entries()]
    .map(([name, record]) => ({
      name,
      medianSimilarity: record.similarities.length > 0 ? median(record.similarities) : 0,
      sentences: record.similarities.length,
      humanConfirmed: record.humanConfirmed,
    }))
    .sort((a, b) => (b.sentences - a.sentences) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return { labels, conflicts, verification, mode }
}
