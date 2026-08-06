import { describe, expect, it } from 'vitest'
import { ageHours, partitionExpiredAudio } from './audio-retention.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const TTL = 14 * DAY

describe('age-based retention for saved speaker audio', () => {
  it('expires only what is past the window', () => {
    const { expired, retained } = partitionExpiredAudio([
      { name: 'old.wav', mtimeMs: NOW - 15 * DAY },
      { name: 'edge.wav', mtimeMs: NOW - 14 * DAY },      // exactly at TTL: keep
      { name: 'fresh.wav', mtimeMs: NOW - 1 * DAY },
    ], NOW, TTL)
    expect(expired.map(f => f.name)).toEqual(['old.wav'])
    expect(retained.map(f => f.name)).toEqual(['edge.wav', 'fresh.wav'])
  })

  it('is per file, so one fresh chunk does not immortalise a whole directory', () => {
    // The ext-audio sweep keys off files[0] and deletes all-or-nothing. Chunks
    // for one speaker accumulate across weeks, so that rule either keeps
    // month-old audio or deletes today's capture.
    const files = Array.from({ length: 30 }, (_, i) => ({
      name: `c${i}.wav`,
      mtimeMs: NOW - (i < 20 ? 20 * DAY : 1 * DAY),
    }))
    const { expired, retained } = partitionExpiredAudio(files, NOW, TTL)
    expect(expired).toHaveLength(20)
    expect(retained).toHaveLength(10)
  })

  it('RETAINS a file whose mtime could not be read', () => {
    // A failed stat yields 0, which is 1970 — treating that as "ancient" would
    // delete real audio on the strength of an unreadable timestamp.
    const { expired, retained } = partitionExpiredAudio([
      { name: 'unstattable.wav', mtimeMs: 0 },
      { name: 'nan.wav', mtimeMs: NaN },
    ], NOW, TTL)
    expect(expired).toEqual([])
    expect(retained).toHaveLength(2)
  })

  it('retains everything when nothing is old', () => {
    const { expired } = partitionExpiredAudio([{ name: 'a.wav', mtimeMs: NOW }], NOW, TTL)
    expect(expired).toEqual([])
  })

  it('handles an empty directory', () => {
    expect(partitionExpiredAudio([], NOW, TTL)).toEqual({ expired: [], retained: [] })
  })

  it('reports age in hours for the purge log line', () => {
    expect(ageHours(NOW - 90 * 60 * 1000, NOW)).toBe(1.5)
  })
})
