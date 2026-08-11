import { describe, expect, it } from 'vitest'
import { insertSortedUnique, analyzeChunkGaps } from './transcribe-stream.js'

describe('insertSortedUnique', () => {
  it('appends an ascending sequence in O(1) order', () => {
    const arr: number[] = []
    for (const n of [0, 1, 2, 3, 4]) insertSortedUnique(arr, n)
    expect(arr).toEqual([0, 1, 2, 3, 4])
  })

  it('ignores a duplicate of the last element', () => {
    const arr = [0, 1, 2]
    insertSortedUnique(arr, 2)
    expect(arr).toEqual([0, 1, 2])
  })

  it('inserts an out-of-order (retry) index in sorted position', () => {
    const arr = [0, 2, 3]
    insertSortedUnique(arr, 1)
    expect(arr).toEqual([0, 1, 2, 3])
  })

  it('ignores a duplicate in the middle', () => {
    const arr = [0, 2, 3]
    insertSortedUnique(arr, 2)
    expect(arr).toEqual([0, 2, 3])
  })

  it('rejects negative and non-integer indices', () => {
    const arr = [0, 1]
    insertSortedUnique(arr, -1)
    insertSortedUnique(arr, 1.5)
    expect(arr).toEqual([0, 1])
  })
})

describe('analyzeChunkGaps', () => {
  it('reports a complete transfer (no gaps)', () => {
    const r = analyzeChunkGaps([0, 1, 2, 3], 3, 4)
    expect(r.missingIndices).toEqual([])
    expect(r.completeness).toBe(1)
    expect(r.received).toBe(4)
    expect(r.expected).toBe(4)
    expect(r.stored).toBe(4)
  })

  it('detects a single mid-stream lost chunk', () => {
    const r = analyzeChunkGaps([0, 1, 3], 3, 3)
    expect(r.missingIndices).toEqual([2])
    expect(r.completeness).toBeCloseTo(0.75, 5)
    expect(r.received).toBe(3)
    expect(r.expected).toBe(4)
  })

  it('detects multiple gaps', () => {
    const r = analyzeChunkGaps([0, 3], 3, 2)
    expect(r.missingIndices).toEqual([1, 2])
    expect(r.completeness).toBe(0.5)
  })

  it('detects trailing lost chunks (gap at the tail)', () => {
    const r = analyzeChunkGaps([0, 1], 3, 2)
    expect(r.missingIndices).toEqual([2, 3])
    expect(r.completeness).toBe(0.5)
  })

  it('treats an empty session as complete', () => {
    const r = analyzeChunkGaps([], -1, 0)
    expect(r.missingIndices).toEqual([])
    expect(r.expected).toBe(0)
    expect(r.completeness).toBe(1)
    expect(r.received).toBe(0)
  })

  it('counts distinct received indices (dedups)', () => {
    const r = analyzeChunkGaps([0, 0, 1], 1, 2)
    expect(r.received).toBe(2)
    expect(r.completeness).toBe(1)
    expect(r.missingIndices).toEqual([])
  })

  it('does not flag a received-but-silent chunk as a gap', () => {
    // 4 chunks all received; only 2 had usable text (stored=2). Completeness
    // is 100% — silence is not loss.
    const r = analyzeChunkGaps([0, 1, 2, 3], 3, 2)
    expect(r.missingIndices).toEqual([])
    expect(r.completeness).toBe(1)
    expect(r.stored).toBe(2)
  })
})
