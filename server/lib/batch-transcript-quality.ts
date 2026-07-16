import type { WhisperWord } from './whisper-local.js'

export interface BatchSegment {
  startChunkIdx: number
  endChunkIdx: number
  startElapsed: number
  endElapsed: number
  speakers: string[]
}

export interface BatchResult {
  segment: BatchSegment
  text: string
  words: WhisperWord[]
  speakerWords: Array<{ word: string; start: number; end: number; speaker: string }>
}

export interface BatchTranscription {
  transcriptionQuality: 'batch' | 'streaming'
  batchTranscript?: string
  batchSegments?: BatchResult[]
  qualityReport?: BatchQualityReport
}

export interface BatchTranscriptSelection {
  text: string
  source: 'speaker-words' | 'batch-text'
}

export type BatchQualityReason =
  | 'accepted'
  | 'insufficient-coverage'
  | 'insufficient-batch-evidence'
  | 'repetitive-output'

export interface BatchQualityReport {
  accepted: boolean
  reason: BatchQualityReason
  batchWordCount: number
  streamingWordCount: number
  coverageRatio: number
  timedWordCount: number
  timedWordRatio: number
  maxRepeatedUnitCount: number
  duplicateWordRatio: number
  repeatedUnit?: string
}

interface RepetitionStats {
  maxRepeatedUnitCount: number
  duplicateWordRatio: number
  repeatedUnit?: string
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Speaker timestamps are optional on fallback transcription backends. Use the
 * attributed form only when every non-empty segment is represented; otherwise
 * persist the complete batch text so text-only segments cannot disappear.
 */
export function selectBatchTranscriptForPersistence(
  batchTranscript: string,
  batchSegments: readonly Pick<BatchResult, 'text' | 'speakerWords'>[] | undefined,
): BatchTranscriptSelection {
  const nonEmpty = (batchSegments ?? []).filter(segment => countWords(segment.text) > 0)
  const completeSpeakerCoverage = nonEmpty.length > 0 && nonEmpty.every(segment => {
    const textWords = countWords(segment.text)
    return segment.speakerWords.length >= Math.max(1, Math.floor(textWords * 0.75))
  })

  if (!completeSpeakerCoverage) return { text: batchTranscript, source: 'batch-text' }

  const lines: string[] = []
  for (const segment of nonEmpty) {
    let currentSpeaker = ''
    let currentWords: string[] = []
    for (const speakerWord of segment.speakerWords) {
      const word = speakerWord.word.trim()
      if (!word) continue
      const speaker = speakerWord.speaker || 'Ext'
      if (speaker !== currentSpeaker) {
        if (currentWords.length > 0) lines.push(`[${currentSpeaker}]: ${currentWords.join(' ')}`)
        currentSpeaker = speaker
        currentWords = [word]
      } else {
        currentWords.push(word)
      }
    }
    if (currentWords.length > 0) lines.push(`[${currentSpeaker}]: ${currentWords.join(' ')}`)
  }

  return lines.length > 0
    ? { text: lines.join('\n'), source: 'speaker-words' }
    : { text: batchTranscript, source: 'batch-text' }
}

function normalizeQualityUnit(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A repeated template with only a changing index/date/amount is still the
    // same unit and must not manufacture apparent transcript coverage.
    .replace(/\b\d+\b/g, '<n>')
}

function toLongQualityUnit(raw: string): { normalized: string; sample: string; wordCount: number } | null {
  const sample = raw.replace(/\s+/g, ' ').trim()
  const normalized = normalizeQualityUnit(sample)
  const wordCount = countWords(normalized)
  // Exempt short acknowledgements and ordinary meeting refrains. The observed
  // failure repeated a complete, long prompted sentence dozens of times.
  if (wordCount < 8 || normalized.length < 40) return null
  return { normalized, sample, wordCount }
}

function toLongPrefixUnit(raw: string): { normalized: string; sample: string; wordCount: number } | null {
  const unit = toLongQualityUnit(raw)
  if (!unit) return null
  const prefixWords = unit.normalized.split(/\s+/).slice(0, 12)
  if (prefixWords.length < 12) return null
  return { normalized: prefixWords.join(' '), sample: unit.sample, wordCount: prefixWords.length }
}

function measureRepetition(
  units: readonly { normalized: string; sample: string; wordCount: number }[],
  batchWordCount: number,
): RepetitionStats {
  const counts = new Map<string, { count: number; wordCount: number; sample: string }>()
  for (const unit of units) {
    const current = counts.get(unit.normalized)
    if (current) current.count += 1
    else counts.set(unit.normalized, { count: 1, wordCount: unit.wordCount, sample: unit.sample })
  }

  let maxRepeatedUnitCount = 0
  let duplicateWords = 0
  let repeatedUnit: string | undefined
  for (const entry of counts.values()) {
    if (entry.count <= 1) continue
    duplicateWords += (entry.count - 1) * entry.wordCount
    if (entry.count > maxRepeatedUnitCount) {
      maxRepeatedUnitCount = entry.count
      repeatedUnit = entry.sample.slice(0, 160)
    }
  }

  return {
    maxRepeatedUnitCount,
    duplicateWordRatio: batchWordCount > 0 ? Math.min(1, duplicateWords / batchWordCount) : 0,
    ...(repeatedUnit ? { repeatedUnit } : {}),
  }
}

/**
 * Deterministic bouncer for a post-meeting transcript candidate. Coverage by
 * itself is unsafe: Whisper can repeat one prompted sentence many times and
 * appear to recover the whole meeting. Measure long exact units at segment,
 * sentence, and prefix granularity while leaving short conversational repeats
 * alone.
 */
export function evaluateBatchQuality(
  batchResults: readonly Pick<BatchResult, 'text' | 'words'>[],
  streamingWordCount: number,
): BatchQualityReport {
  const batchText = batchResults.map(result => result.text).join(' ')
  const batchWordCount = countWords(batchText)
  const safeStreamingWordCount = Math.max(0, streamingWordCount)
  const coverageRatio = safeStreamingWordCount > 0
    ? batchWordCount / safeStreamingWordCount
    : (batchWordCount > 0 ? 1 : 0)
  const timedWordCount = batchResults.reduce((sum, result) => sum + (result.words?.length ?? 0), 0)
  const timedWordRatio = batchWordCount > 0 ? timedWordCount / batchWordCount : 0
  const nonEmptySegmentCount = batchResults.filter(result => countWords(result.text) > 0).length

  const segmentUnits = batchResults
    .map(result => toLongQualityUnit(result.text))
    .filter((unit): unit is NonNullable<typeof unit> => unit !== null)
  const segmentStats = measureRepetition(segmentUnits, batchWordCount)

  const sentenceUnits: Array<{ normalized: string; sample: string; wordCount: number }> = []
  for (const result of batchResults) {
    for (const sentence of result.text.match(/[^.!?\n]+(?:[.!?]+|$)/g) ?? []) {
      const unit = toLongQualityUnit(sentence)
      if (unit) sentenceUnits.push(unit)
    }
  }
  const sentenceStats = measureRepetition(sentenceUnits, batchWordCount)

  // Keep segment and sentence prefix populations separate. A one-sentence
  // segment otherwise counts twice and can turn two valid repeats into four.
  const segmentPrefixStats = measureRepetition(
    batchResults
      .map(result => toLongPrefixUnit(result.text))
      .filter((unit): unit is NonNullable<typeof unit> => unit !== null),
    batchWordCount,
  )
  const sentencePrefixStats = measureRepetition(
    batchResults.flatMap(result => (
      result.text.match(/[^.!?\n]+(?:[.!?]+|$)/g) ?? []
    ).map(sentence => toLongPrefixUnit(sentence)))
      .filter((unit): unit is NonNullable<typeof unit> => unit !== null),
    batchWordCount,
  )

  const repetition = [segmentStats, sentenceStats, segmentPrefixStats, sentencePrefixStats]
    .reduce((strongest, candidate) => (
      candidate.duplicateWordRatio > strongest.duplicateWordRatio ? candidate : strongest
    ))

  const repetitiveOutput = (
    repetition.maxRepeatedUnitCount >= 4 && repetition.duplicateWordRatio >= 0.08
  ) || (
    repetition.maxRepeatedUnitCount >= 8 && repetition.duplicateWordRatio >= 0.03
  )

  const reason: BatchQualityReason = safeStreamingWordCount === 0 && (
    batchWordCount < 50 || nonEmptySegmentCount < 2
  )
    ? 'insufficient-batch-evidence'
    : coverageRatio < 0.5
      ? 'insufficient-coverage'
      : repetitiveOutput
        ? 'repetitive-output'
        : 'accepted'

  return {
    accepted: reason === 'accepted',
    reason,
    batchWordCount,
    streamingWordCount: safeStreamingWordCount,
    coverageRatio: Number(coverageRatio.toFixed(4)),
    timedWordCount,
    timedWordRatio: Number(timedWordRatio.toFixed(4)),
    maxRepeatedUnitCount: repetition.maxRepeatedUnitCount,
    duplicateWordRatio: Number(repetition.duplicateWordRatio.toFixed(4)),
    ...(repetition.repeatedUnit ? { repeatedUnit: repetition.repeatedUnit } : {}),
  }
}
