import { describe, expect, it } from 'vitest'
import {
  evaluateBatchQuality,
  selectBatchTranscriptForPersistence,
  type BatchResult,
} from './batch-transcript-quality.js'

function candidate(text: string, timedWords = 0): Pick<BatchResult, 'text' | 'words'> {
  return {
    text,
    words: Array.from({ length: timedWords }, (_value, index) => ({
      word: `word-${index}`,
      start: index * 0.1,
      end: index * 0.1 + 0.08,
      probability: 0.99,
    })),
  }
}

describe('batch transcript quality bouncer', () => {
  it('rejects a long prompted sentence repeated across otherwise distinct segments', () => {
    const repeated = 'The assistant offers detailed guidance that helps members compare choices and understand the next financial step clearly.'
    const results = Array.from({ length: 53 }, (_value, index) => candidate(
      `Segment ${index} covers a distinct customer discussion, owner, deadline, and follow-up decision. ${repeated}`,
      12,
    ))
    const report = evaluateBatchQuality(results, 1_500)
    expect(report.coverageRatio).toBeGreaterThan(0.5)
    expect(report).toMatchObject({ accepted: false, reason: 'repetitive-output', maxRepeatedUnitCount: 53 })
    expect(report.duplicateWordRatio).toBeGreaterThan(0.08)
  })

  it('keeps the 50% coverage floor, accepting the exact boundary', () => {
    const insufficient = evaluateBatchQuality([
      candidate('This short batch result captured only one isolated sentence from the entire meeting.'),
    ], 500)
    expect(insufficient).toMatchObject({ accepted: false, reason: 'insufficient-coverage' })

    const fiftyWords = Array.from({ length: 50 }, (_value, index) => `distinct${index}`).join(' ')
    const exact = evaluateBatchQuality([candidate(fiftyWords)], 100)
    expect(exact.coverageRatio).toBe(0.5)
    expect(exact.accepted).toBe(true)
  })

  it('accepts varied segments with adequate coverage', () => {
    const texts = [
      'Marketing reviewed campaign attribution, channel pacing, creative approvals, and the next launch milestone.',
      'Engineering explained the database migration, rollback sequence, query latency, and remaining observability work.',
      'Finance compared renewal scenarios, forecast assumptions, cash timing, and the final approval owner.',
      'Customer success summarized onboarding friction, training requests, support volume, and account health signals.',
      'Sales discussed qualification gaps, territory coverage, pipeline hygiene, and follow-up expectations for managers.',
      'Operations mapped fulfillment capacity, staffing constraints, vendor dependencies, and contingency planning for demand.',
      'Product reviewed accessibility feedback, mobile navigation, design tradeoffs, and acceptance criteria for release.',
      'Legal identified contract language, privacy requirements, retention limits, and open questions for outside counsel.',
      'Research presented interview themes, sample limitations, competitor evidence, and recommendations for another study.',
      'Leadership aligned quarterly priorities, decision rights, communication cadence, and escalation paths for blocked work.',
      'Security assessed authentication controls, audit coverage, incident response ownership, and remediation sequencing.',
      'The final recap assigned concrete actions, named accountable owners, confirmed due dates, and documented dependencies.',
    ]
    const report = evaluateBatchQuality(texts.map(text => candidate(text, 16)), 170)
    expect(report).toMatchObject({ accepted: true, reason: 'accepted', maxRepeatedUnitCount: 0 })
  })

  it('allows short repetition and three legitimate long refrains', () => {
    const refrain = 'We need to confirm the customer owner before the team commits to the final launch date.'
    const report = evaluateBatchQuality([
      candidate(`Yes. Yes. Yes. ${refrain} The first discussion covered scope and staffing.`),
      candidate(`Yes. ${refrain} The second discussion covered budget and procurement.`),
      candidate(`Yes. ${refrain} The third discussion covered rollout risks and support.`),
      candidate('The final discussion assigned follow-up work to separate owners with explicit due dates.'),
    ], 70)
    expect(report).toMatchObject({ accepted: true, reason: 'accepted', maxRepeatedUnitCount: 3 })
  })

  it('rejects near-duplicates that differ only by a trailing number', () => {
    const report = evaluateBatchQuality(
      Array.from({ length: 30 }, (_value, index) => candidate(
        `The assistant invented the same detailed guidance sentence across every segment with reference ${index}.`,
      )),
      270,
    )
    expect(report).toMatchObject({ accepted: false, reason: 'repetitive-output' })
  })

  it('allows complete batch recovery larger than an interrupted live stream', () => {
    const report = evaluateBatchQuality(
      Array.from({ length: 12 }, (_value, index) => candidate(
        `Distinct discussion ${String.fromCharCode(97 + index)} covered ownership, evidence, tradeoffs, dependencies, timing, and the next decision.`,
      )),
      60,
    )
    expect(report.coverageRatio).toBeGreaterThan(1.75)
    expect(report.accepted).toBe(true)
  })

  it('requires independent evidence with no streaming baseline', () => {
    const report = evaluateBatchQuality([
      candidate('A lone batch sentence cannot safely replace an empty live transcript without another independent segment.'),
    ], 0)
    expect(report).toMatchObject({ accepted: false, reason: 'insufficient-batch-evidence' })
  })

  it('falls back to complete text when one segment lacks timed speaker words', () => {
    const segments = [
      {
        text: 'First segment has complete timed speaker words for this discussion.',
        speakerWords: Array.from({ length: 9 }, (_value, index) => ({
          word: `first-${index}`, start: index, end: index + 0.5, speaker: 'Speaker A',
        })),
      },
      {
        text: 'Second segment has valid text but no timestamp output from the fallback backend.',
        speakerWords: [],
      },
    ]
    expect(selectBatchTranscriptForPersistence('complete plain transcript', segments)).toEqual({
      text: 'complete plain transcript',
      source: 'batch-text',
    })
  })

  it('uses speaker words only when every segment is represented', () => {
    const segments = [
      {
        text: 'Alex confirmed the owner and deadline today.',
        speakerWords: ['Alex', 'confirmed', 'the', 'owner', 'and', 'deadline', 'today'].map((word, index) => ({
          word, start: index, end: index + 0.5, speaker: 'Speaker A',
        })),
      },
      {
        text: 'Jordan confirmed the final review milestone.',
        speakerWords: ['Jordan', 'confirmed', 'the', 'final', 'review', 'milestone'].map((word, index) => ({
          word, start: index, end: index + 0.5, speaker: 'Speaker B',
        })),
      },
    ]
    expect(selectBatchTranscriptForPersistence('plain transcript', segments)).toEqual({
      text: '[Speaker A]: Alex confirmed the owner and deadline today\n[Speaker B]: Jordan confirmed the final review milestone',
      source: 'speaker-words',
    })
  })
})
