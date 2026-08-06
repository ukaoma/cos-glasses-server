// Age-based retention for saved speaker audio.
//
// The count cap on training-audio (30 WAVs per speaker) is a storage bound, not
// a retention policy: a speaker who is never trained keeps 30 chunks of their
// recorded voice forever, and the only path that ever deleted them was a manual
// /voice/train-g2 call. An unenforced retention policy is worse than none —
// it is a promise the code does not keep.
//
// Split out as a pure function so the expiry rule can be tested by execution
// without a clock, a filesystem, or a running server.

export interface RetentionCandidate {
  name: string
  mtimeMs: number
}

export interface RetentionSplit<T extends RetentionCandidate> {
  expired: T[]
  retained: T[]
}

/**
 * Partition files by age. Per-file rather than per-directory: chunks for one
 * speaker accumulate across weeks, so an all-or-nothing directory check either
 * keeps month-old audio alive because one chunk is fresh, or deletes today's
 * capture because the directory is old.
 *
 * A file with an unreadable/zero mtime is RETAINED. Treating "I could not read
 * the timestamp" as "this is ancient" would delete data on the strength of a
 * failed stat.
 */
export function partitionExpiredAudio<T extends RetentionCandidate>(
  files: T[],
  nowMs: number,
  ttlMs: number,
): RetentionSplit<T> {
  const expired: T[] = []
  const retained: T[] = []
  for (const file of files) {
    const age = nowMs - file.mtimeMs
    if (file.mtimeMs > 0 && Number.isFinite(file.mtimeMs) && age > ttlMs) expired.push(file)
    else retained.push(file)
  }
  return { expired, retained }
}

/** Human-readable age, for the log line that reports a purge. */
export function ageHours(mtimeMs: number, nowMs: number): number {
  return Math.round(((nowMs - mtimeMs) / (60 * 60 * 1000)) * 10) / 10
}
