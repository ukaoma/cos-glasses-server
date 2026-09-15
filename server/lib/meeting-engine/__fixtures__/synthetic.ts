/**
 * Synthetic meetings for the merge engine's tests.
 *
 * NEVER real meeting text. Every token here is a generated identifier, which also makes the
 * evidence counts exact: when every token in a stream is unique, the number of unique
 * shared trigrams is `tokens - 2`, so a fixture can ask for K = 29 and get K = 29.
 *
 * G2 word times are written as batch-segment words so a fixture controls them to the
 * millisecond; the chunk fallback has its own test rather than being the fixture path.
 */

import type {
  FirefliesMeetingInput,
  FirefliesSentenceInput,
  G2RecordingInput,
} from '../evidence.js'

export interface PhraseSpec {
  tokens: string[]
  startS: number
  endS: number
  speaker?: string
}

/**
 * `n` tokens that appear nowhere else, so every trigram over them is unique.
 *
 * The prefix is stripped to `[a-z0-9]` first: a hyphen or a dot would make `normalizeWords`
 * split each token in two, which doubles the trigram count and quietly turns a fixture that
 * asks for 15 shared phrases into one with 32.
 */
export function tokenRun(prefix: string, n: number): string[] {
  const safe = prefix.toLowerCase().replace(/[^a-z0-9]/g, '')
  return Array.from({ length: n }, (_, i) => `${safe}${i}`)
}

/** The number of tokens a phrase needs to contribute exactly `k` unique trigrams. */
export function tokensForAnchors(k: number): number {
  return k + 2
}

export function phrase(prefix: string, k: number, startS: number, lengthS = 12, speaker = 'Speaker 1'): PhraseSpec {
  return { tokens: tokenRun(prefix, tokensForAnchors(k)), startS, endS: startS + lengthS, speaker }
}

function sentenceOf(spec: PhraseSpec): FirefliesSentenceInput {
  return { text: spec.tokens.join(' '), speaker_name: spec.speaker ?? 'Speaker 1', start_time: spec.startS, end_time: spec.endS }
}

/** The time `firefliesTimedWords` gives token `index` of this phrase, in ms. */
export function firefliesWordMs(spec: PhraseSpec, index: number): number {
  const start = spec.startS
  const end = spec.endS
  return (start + ((index + 0.5) / Math.max(1, spec.tokens.length)) * Math.max(0, end - start)) * 1000
}

/**
 * The first `count` tokens of another phrase, spoken at the same pace.
 *
 * Same pace matters: a shared run repeated at a different speed spreads its offsets across
 * bins, so a fixture asking for "this other meeting shares 30 phrases" would silently get
 * fewer.
 */
export function subPhrase(source: PhraseSpec, count: number, startS: number, speaker = 'Speaker 2'): PhraseSpec {
  const perToken = (source.endS - source.startS) / source.tokens.length
  return { tokens: source.tokens.slice(0, count), startS, endS: startS + perToken * count, speaker }
}

/** The same phrase spoken at a different point in a recording. */
export function shiftPhrase(source: PhraseSpec, deltaS: number): PhraseSpec {
  return { ...source, startS: source.startS + deltaS, endS: source.endS + deltaS }
}

export function firefliesMeeting(options: {
  id: string
  startMs: number
  durationS: number
  phrases: PhraseSpec[]
  title?: string
  participants?: string[]
  summary?: string
  actionItems?: string[]
  sha256?: string
}): FirefliesMeetingInput {
  return {
    id: options.id,
    startMs: options.startMs,
    durationS: options.durationS,
    sentences: options.phrases.map(sentenceOf),
    title: options.title,
    participants: options.participants,
    summary: options.summary,
    actionItems: options.actionItems,
    sha256: options.sha256,
  }
}

export interface CaptureLabel {
  speaker: string
  startS: number
  similarity?: number
  humanConfirmed?: boolean
}

/**
 * A capture whose words sit exactly `offsetMs` before the Fireflies words of the same
 * phrases, so every shared trigram lands in one offset bin and K is the phrase count.
 */
export function g2Capture(options: {
  sessionId: string
  startMs: number
  durationMs: number
  phrases: PhraseSpec[]
  /** `firefliesTime - g2Time`, in ms. */
  offsetMs: number
  /** Per-phrase offsets, when the test needs the anchors to disagree. */
  phraseOffsetsMs?: number[]
  labels?: CaptureLabel[]
  chunkText?: boolean
  sha256?: string
  correctionRevision?: number
  batchApplied?: boolean
}): G2RecordingInput {
  const words = options.phrases.flatMap((spec, phraseIndex) => {
    const offsetMs = options.phraseOffsetsMs?.[phraseIndex] ?? options.offsetMs
    return spec.tokens.map((token, index) => ({
      word: token,
      start: (firefliesWordMs(spec, index) - offsetMs) / 1000,
      end: (firefliesWordMs(spec, index) - offsetMs) / 1000 + 0.3,
    }))
  })
  const last = words.length > 0 ? words[words.length - 1].start : 0
  const chunks = (options.labels ?? []).map(label => ({
    text: options.chunkText === false ? '' : `chunk ${label.speaker}`,
    speaker: label.speaker,
    elapsed: label.startS * 1000,
    similarity: label.similarity ?? 0.9,
    ...(label.humanConfirmed ? { speakerCorrectionBatchId: 'batch-1' } : {}),
  }))
  return {
    sessionId: options.sessionId,
    startMs: options.startMs,
    durationMs: options.durationMs,
    batchSegments: [{ startElapsed: 0, endElapsed: Math.max(1, Math.ceil(last * 1000) + 1000), words }],
    chunks,
    sha256: options.sha256,
    correctionRevision: options.correctionRevision,
    batchApplied: options.batchApplied,
  }
}

// The scene behind the committed pipeline-patch golden (QA round 2, blocker 7).
//
// WHY A SCENE AND NOT AN INLINE FIXTURE. `pipeline-patch.golden.json` is regenerated on BOTH
// sides: this repo's golden test compares the renderer against it byte for byte, and the COS
// pipeline's own validator reads the same file as the shape it must splice. One scene, named
// once, is what makes "the pipeline's fixture came from this renderer" a checkable claim
// rather than a convention.
//
// It deliberately exercises every branch of `renderPipelinePatch` that can put bytes on disk:
// a capture section, an alternate-transcript section, both metadata rows, all four marker
// forms including `g2-source`, and a speaker map that clears both of its floors.

/** The clock the golden is rendered under. `formatClock` reads LOCAL time. */
export const GOLDEN_PATCH_TZ = 'UTC'

export const GOLDEN_PATCH_ACTION_ID = 'a_0123456789abcdef'

export const GOLDEN_PATCH_START_MS = Date.UTC(2026, 7, 20, 15, 0, 0)

export function goldenPatchScene(): {
  primary: FirefliesMeetingInput
  alternate: FirefliesMeetingInput
  capture: G2RecordingInput
  sidecarRelPathBySession: Record<string, string>
  coarseOffsetMsBySession: Record<string, number>
} {
  const phrases = Array.from({ length: 8 }, (_, i) => ({ ...phrase(`g${i}`, 6, 120 + i * 20, 15), speaker: 'Speaker 1' }))
  return {
    primary: firefliesMeeting({
      id: 'ff-golden-primary',
      startMs: GOLDEN_PATCH_START_MS,
      durationS: 1800,
      phrases,
      title: 'Golden synthetic review',
      participants: ['nadia@example.test'],
      summary: 'A synthetic summary.',
      actionItems: ['Send the synthetic follow-up'],
      sha256: 'ff-golden-primary-sha',
    }),
    alternate: firefliesMeeting({
      id: 'ff-golden-alternate',
      startMs: GOLDEN_PATCH_START_MS + 60_000,
      durationS: 1800,
      phrases: [{ ...phrase('galt', 6, 120, 15), speaker: 'Marcus Bell' }],
      title: 'Golden synthetic review',
      sha256: 'ff-golden-alternate-sha',
    }),
    capture: g2Capture({
      sessionId: 'g2-golden-session',
      startMs: GOLDEN_PATCH_START_MS,
      durationMs: 1_800_000,
      phrases,
      offsetMs: 0,
      // TWO labels, deliberately. `labelIntervals` closes the last one after a short tail, so
      // a single label would not reach the phrases and the golden would pin an empty speaker
      // map and an empty verification list: a fixture that pins nothing anybody reads.
      labels: [{ speaker: 'Nadia Okonkwo', startS: 0, similarity: 0.72 }, { speaker: 'Closing Speaker', startS: 900 }],
      sha256: 'g2-golden-sha',
      correctionRevision: 4,
      batchApplied: true,
    }),
    sidecarRelPathBySession: { 'g2-golden-session': 'personal/meetings/2026-08/2026-08-20_Golden.g2-chunks.json' },
    coarseOffsetMsBySession: { 'g2-golden-session': 0 },
  }
}

/** A capture and the meeting it belongs to, sharing `k` trigrams at a zero offset. */
export function matchingPair(options: {
  k: number
  sessionId?: string
  firefliesId?: string
  startMs?: number
  durationS?: number
  labels?: CaptureLabel[]
}): { capture: G2RecordingInput; meeting: FirefliesMeetingInput; phrases: PhraseSpec[] } {
  const startMs = options.startMs ?? Date.UTC(2026, 7, 20, 15, 0, 0)
  const durationS = options.durationS ?? 1800
  const phrases = [phrase(`${options.firefliesId ?? 'f1'}w`, options.k, 60)]
  return {
    capture: g2Capture({
      sessionId: options.sessionId ?? 's1',
      startMs,
      durationMs: durationS * 1000,
      phrases,
      offsetMs: 0,
      labels: options.labels ?? [{ speaker: 'Nadia Okonkwo', startS: 0, similarity: 0.9 }],
    }),
    meeting: firefliesMeeting({
      id: options.firefliesId ?? 'f1',
      startMs,
      durationS,
      phrases,
      title: 'Synthetic meeting',
    }),
    phrases,
  }
}
