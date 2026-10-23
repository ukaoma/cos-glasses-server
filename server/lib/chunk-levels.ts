// 6.87.0: a rough level per live chunk, for COS Control's level strip on glasses meetings.
//
// The quiet gate already measures every chunk (stt-live.ts decideQuiet: RMS and, with Silero, speech seconds). Until
// 6.87.0 those numbers only reached the [perf] line. Now each chunk keeps two numbers on the active session record:
// `level`, 0 to 1 from the chunk's RMS on a dBFS scale, and `speechSec`, the Silero speech seconds (null when the gate
// fell back to RMS). Control reads them from the same active-session file its live transcript reads, so there is no
// new route and no new log line.
//
// NOT TEXT. Two numbers per chunk, bounded to the newest CHUNK_LEVELS_LIMIT chunks, living only as long as the
// active-session record (the 4-hour crash-recovery file, deleted at save). Nothing here logs.

/** The newest chunks kept: about 12 minutes of 6 s chunks, far more than the strip draws. */
export const CHUNK_LEVELS_LIMIT = 120
/** The dBFS that reads as 0: under the quiet gate's RMS 150 (about -47 dBFS) and the room floor of a G2 mic. */
export const LEVEL_FLOOR_DBFS = -60
/** The dBFS that reads as 1: loud close speech. */
export const LEVEL_CEILING_DBFS = -10

export interface ChunkLevel {
  /** The chunk's own index. */
  i: number
  /** 0 to 1, three decimals. */
  level: number
  /** Silero speech seconds, two decimals; null when the quiet gate used RMS. */
  speechSec: number | null
}

/** A chunk's RMS (PCM16 units) as 0 to 1: LEVEL_FLOOR_DBFS and under is 0, LEVEL_CEILING_DBFS and over is 1. */
export function normalizedLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  const dbfs = 20 * Math.log10(rms / 32768)
  const level = (dbfs - LEVEL_FLOOR_DBFS) / (LEVEL_CEILING_DBFS - LEVEL_FLOOR_DBFS)
  return Math.round(Math.min(1, Math.max(0, level)) * 1000) / 1000
}

/** The stored entry for one chunk's quiet decision. */
export function chunkLevel(chunkIndex: number, rms: number, speechSec: number | null): ChunkLevel {
  const speech = speechSec !== null && Number.isFinite(speechSec) ? Math.round(Math.max(0, speechSec) * 100) / 100 : null
  return { i: chunkIndex, level: normalizedLevel(rms), speechSec: speech }
}

/** `levels` with `entry` in index order (a second entry for an index replaces the first), the newest
 *  CHUNK_LEVELS_LIMIT kept. Never mutates its input. */
export function withChunkLevel(levels: readonly ChunkLevel[] | undefined, entry: ChunkLevel): ChunkLevel[] {
  const next = (levels ?? []).filter(l => l.i !== entry.i)
  next.push(entry)
  next.sort((a, b) => a.i - b.i)
  return next.length > CHUNK_LEVELS_LIMIT ? next.slice(next.length - CHUNK_LEVELS_LIMIT) : next
}

/** The levels from a recovered session file: only well-formed entries, one per index, in order, bounded. */
export function restoreChunkLevels(value: unknown): ChunkLevel[] {
  if (!Array.isArray(value)) return []
  let levels: ChunkLevel[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const { i, level, speechSec } = raw as Record<string, unknown>
    if (!Number.isInteger(i) || (i as number) < 0) continue
    if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) continue
    if (speechSec !== null && (typeof speechSec !== 'number' || !Number.isFinite(speechSec) || speechSec < 0)) continue
    levels = withChunkLevel(levels, { i: i as number, level, speechSec: speechSec as number | null })
  }
  return levels
}
