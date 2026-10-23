// 6.87.0: the level strip's numbers. Pure, so every bound is pinned here.
import { describe, expect, it } from 'vitest'
import { CHUNK_LEVELS_LIMIT, chunkLevel, normalizedLevel, restoreChunkLevels, withChunkLevel } from './chunk-levels.js'

describe('normalizedLevel', () => {
  it('maps RMS on a dBFS scale: -60 dBFS and under is 0, -10 dBFS and over is 1', () => {
    expect(normalizedLevel(32768 * 10 ** (-60 / 20))).toBe(0)
    expect(normalizedLevel(32768 * 10 ** (-10 / 20))).toBe(1)
    expect(normalizedLevel(32768 * 10 ** (-35 / 20))).toBe(0.5)
    expect(normalizedLevel(2000)).toBe(0.714)
    expect(normalizedLevel(150)).toBe(0.264)                 // the RMS quiet gate sits a quarter of the way up
    expect(normalizedLevel(32768)).toBe(1)
    expect(normalizedLevel(1)).toBe(0)
  })
  it('zero, negative and non-finite RMS read as 0, never NaN', () => {
    for (const rms of [0, -5, NaN, Infinity, -Infinity]) expect(normalizedLevel(rms)).toBe(0)
  })
})

describe('chunkLevel', () => {
  it('rounds speech seconds to two decimals and keeps null when the gate used RMS', () => {
    expect(chunkLevel(4, 2000, 1.23456)).toEqual({ i: 4, level: 0.714, speechSec: 1.23 })
    expect(chunkLevel(4, 2000, null)).toEqual({ i: 4, level: 0.714, speechSec: null })
    expect(chunkLevel(4, 2000, NaN)).toEqual({ i: 4, level: 0.714, speechSec: null })
    expect(chunkLevel(4, 2000, -1)).toEqual({ i: 4, level: 0.714, speechSec: 0 })
  })
})

describe('withChunkLevel', () => {
  it('keeps index order whatever order chunks arrive in, and a second entry for an index replaces the first', () => {
    let levels = withChunkLevel(undefined, { i: 2, level: 0.2, speechSec: 1 })
    levels = withChunkLevel(levels, { i: 0, level: 0.4, speechSec: 2 })
    levels = withChunkLevel(levels, { i: 2, level: 0.9, speechSec: 3 })
    expect(levels).toEqual([{ i: 0, level: 0.4, speechSec: 2 }, { i: 2, level: 0.9, speechSec: 3 }])
    // A late chunk with a lower index lands in its place, not at the end.
    expect(withChunkLevel(levels, { i: 1, level: 0.5, speechSec: 0 }).map(l => l.i)).toEqual([0, 1, 2])
  })
  it(`keeps the newest ${CHUNK_LEVELS_LIMIT} indexes`, () => {
    let levels = withChunkLevel(undefined, { i: 0, level: 0, speechSec: 0 })
    for (let i = 1; i <= CHUNK_LEVELS_LIMIT; i++) levels = withChunkLevel(levels, { i, level: 0, speechSec: 0 })
    expect(levels).toHaveLength(CHUNK_LEVELS_LIMIT)
    expect(levels[0].i).toBe(1)
    expect(levels.at(-1)!.i).toBe(CHUNK_LEVELS_LIMIT)
  })
  it('exactly the limit is kept whole', () => {
    let levels: ReturnType<typeof withChunkLevel> = []
    for (let i = 0; i < CHUNK_LEVELS_LIMIT; i++) levels = withChunkLevel(levels, { i, level: 0, speechSec: 0 })
    expect(levels).toHaveLength(CHUNK_LEVELS_LIMIT)
    expect(levels[0].i).toBe(0)
  })
  it('never mutates its input', () => {
    const before = [{ i: 0, level: 0.1, speechSec: 0 }]
    withChunkLevel(before, { i: 1, level: 0.2, speechSec: 0 })
    expect(before).toEqual([{ i: 0, level: 0.1, speechSec: 0 }])
  })
})

describe('restoreChunkLevels', () => {
  it('keeps only well-formed entries, one per index, in order', () => {
    expect(restoreChunkLevels([
      { i: 3, level: 0.5, speechSec: 2 },
      { i: 1, level: 0.25, speechSec: null },
      { i: -1, level: 0.5, speechSec: 1 },
      { i: 1.5, level: 0.5, speechSec: 1 },
      { i: 4, level: 1.5, speechSec: 1 },
      { i: 5, level: -0.1, speechSec: 1 },
      { i: 6, level: NaN, speechSec: 1 },
      { i: 7, level: '0.5', speechSec: 1 },
      { i: 8, level: 0.5, speechSec: -1 },
      { i: 9, level: 0.5, speechSec: 'loud' },
      { i: 10, level: 0.5 },
      null, 'text', 7,
      { i: 3, level: 0.75, speechSec: 4 },
    ])).toEqual([{ i: 1, level: 0.25, speechSec: null }, { i: 3, level: 0.75, speechSec: 4 }])
  })
  it('anything that is not an array restores to none', () => {
    for (const value of [undefined, null, {}, 'levels', 3]) expect(restoreChunkLevels(value)).toEqual([])
  })
  it('a hand-edited file cannot grow the record past the bound', () => {
    const raw = Array.from({ length: CHUNK_LEVELS_LIMIT + 50 }, (_, i) => ({ i, level: 0.5, speechSec: 1 }))
    const levels = restoreChunkLevels(raw)
    expect(levels).toHaveLength(CHUNK_LEVELS_LIMIT)
    expect(levels[0].i).toBe(50)
  })
})
