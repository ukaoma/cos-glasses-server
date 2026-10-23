import { describe, expect, it } from 'vitest'
import type { TranscriptGapReport } from '../routes/transcribe-stream.js'
import {
  PHONE_FINAL_INDEX_MAX_AHEAD,
  chunksOutstanding,
  parsePhoneFinalChunkIndex,
  phoneFinalChunkIndex,
  withPhoneFinalIndex,
} from './transfer-integrity.js'

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
/** The shape transcribe-stream analyzeChunkGaps returns (built here so this file imports no route module). */
function analyzeChunkGaps(received: number[], maxIndex: number, stored: number): TranscriptGapReport {
  const got = new Set(received)
  const missingIndices = range(0, maxIndex).filter(i => !got.has(i))
  return { received: got.size, stored, maxIndex, expected: maxIndex + 1, missingIndices, completeness: maxIndex >= 0 ? got.size / (maxIndex + 1) : 1 }
}

describe('6.88.0: transfer integrity counts what the phone captured', () => {
  it('t2xs9u: 74 received, the phone captured through 120: 61.1%, 47 missing (was 100%)', () => {
    const report = analyzeChunkGaps(range(0, 73), 73, 74)
    expect(report.completeness).toBe(1)
    const counted = withPhoneFinalIndex(report, 120)!
    expect(counted).toMatchObject({ received: 74, stored: 74, maxIndex: 120, expected: 121 })
    expect(counted.missingIndices).toEqual(range(74, 120))
    expect(Math.floor(counted.completeness * 1_000) / 10).toBe(61.1)
    expect(chunksOutstanding(report, 120)).toBe(47)
  })

  it('keeps holes the Mac already knew of, and adds the tail', () => {
    const report = analyzeChunkGaps([0, 1, 3], 3, 3)
    const counted = withPhoneFinalIndex(report, 5)!
    expect(counted.missingIndices).toEqual([2, 4, 5])
    expect(counted.expected).toBe(6)
    expect(chunksOutstanding(report, 5)).toBe(3)
    expect(chunksOutstanding(report, 1)).toBe(0)
  })

  it('changes nothing when the phone said nothing new', () => {
    const report = analyzeChunkGaps(range(0, 9), 9, 10)
    expect(withPhoneFinalIndex(report, null)).toBe(report)
    expect(withPhoneFinalIndex(report, 9)).toBe(report)
    expect(withPhoneFinalIndex(report, 4)).toBe(report)
    expect(withPhoneFinalIndex(null, 9)).toBeNull()
    expect(chunksOutstanding(report, null)).toBe(0)
    expect(chunksOutstanding(null, 3)).toBe(4)
  })

  it('caps a final index far past the Mac\'s chunks', () => {
    const report = analyzeChunkGaps(range(0, 9), 9, 10)
    const counted = withPhoneFinalIndex(report, 999_999)!
    expect(counted.maxIndex).toBe(9 + PHONE_FINAL_INDEX_MAX_AHEAD)
    expect(counted.missingIndices.length).toBe(PHONE_FINAL_INDEX_MAX_AHEAD)
  })

  it('reads a final index the way the stop route does, and takes the highest any window said', () => {
    expect(parsePhoneFinalChunkIndex(120)).toBe(120)
    expect(parsePhoneFinalChunkIndex(-1)).toBe(-1)
    expect(parsePhoneFinalChunkIndex(-2)).toBeNull()
    expect(parsePhoneFinalChunkIndex(1.5)).toBeNull()
    expect(parsePhoneFinalChunkIndex('120')).toBeNull()
    expect(parsePhoneFinalChunkIndex(1_000_001)).toBeNull()
    expect(phoneFinalChunkIndex(120, 110, null, undefined)).toBe(120)
    expect(phoneFinalChunkIndex(-1, null)).toBeNull()
    expect(phoneFinalChunkIndex()).toBeNull()
  })
})
