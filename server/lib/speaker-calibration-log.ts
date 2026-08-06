// speaker-calibration.jsonl — threshold-tuning telemetry, one row per
// identification decision. Every row carries a speaker NAME, so a person's
// trace survives deleting their voice profile unless this file is swept too.
//
// The log is append-only and written from the live identification path with a
// fire-and-forget `appendFileSync`. A rewrite therefore has a genuine (if
// millisecond-wide) race with concurrent appends. That is acceptable HERE and
// nowhere else in this feature: the file is explicitly non-critical tuning data,
// already best-effort, and losing a row written during the swap costs nothing —
// whereas leaving a deleted person's name in 21k rows is the privacy gap the
// delete exists to close. Embedding data is never touched by this module.

import { existsSync, readFileSync } from 'node:fs'
import { durableAtomicWriteFileSync } from './atomic-fs.js'

export interface CalibrationPurgeResult {
  /** Rows whose `speaker` matched and were dropped. */
  removed: number
  /** Rows retained, including rows that could not be parsed. */
  retained: number
  /** Rows that were not valid JSON. Kept — a malformed row is not evidence that
   *  it belongs to the person being deleted, and discarding it would be a
   *  silent data loss dressed up as a privacy fix. */
  unparsable: number
}

/**
 * Filter JSONL text, dropping rows whose `speaker` field matches.
 *
 * Pure so the matching rule can be tested without touching the filesystem.
 * Matching is exact on the `speaker` field only: a substring match would delete
 * every "Miles Mallard" row when removing "Miles", and the name also appears in
 * no other field.
 */
export function filterCalibrationRows(
  raw: string,
  speakerName: string,
): { text: string; result: CalibrationPurgeResult } {
  const lines = raw.split('\n')
  const kept: string[] = []
  const result: CalibrationPurgeResult = { removed: 0, retained: 0, unparsable: 0 }

  for (const line of lines) {
    if (line.trim() === '') continue
    let speaker: unknown
    try {
      speaker = (JSON.parse(line) as { speaker?: unknown }).speaker
    } catch {
      result.unparsable++
      result.retained++
      kept.push(line)
      continue
    }
    if (speaker === speakerName) {
      result.removed++
      continue
    }
    result.retained++
    kept.push(line)
  }

  return { text: kept.length > 0 ? kept.join('\n') + '\n' : '', result }
}

/**
 * Rename a speaker across the log, for a profile merge.
 *
 * Relabel rather than delete: a merge means the two names were always one
 * person, so their calibration history is one history. Dropping the absorbed
 * name's rows would silently discard exactly the evidence needed to tell
 * whether the merge improved identification.
 */
export function relabelCalibrationRows(
  raw: string,
  fromName: string,
  toName: string,
): { text: string; relabeled: number; retained: number; unparsable: number } {
  const out: string[] = []
  let relabeled = 0, retained = 0, unparsable = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      unparsable++; retained++; out.push(line); continue
    }
    // `retained` counts every row that survives, relabeled or not, so
    // `retained === total input rows` is the invariant a caller can assert: a
    // merge must never lose history. (Contrast filterCalibrationRows, where
    // removed + retained = total.)
    retained++
    if (row.speaker === fromName) {
      row.speaker = toName
      relabeled++
      out.push(JSON.stringify(row))
    } else {
      out.push(line)
    }
  }
  return { text: out.length > 0 ? out.join('\n') + '\n' : '', relabeled, retained, unparsable }
}

/** Apply a merge relabel to the log on disk. */
export function relabelSpeakerCalibrationRows(
  logPath: string,
  fromName: string,
  toName: string,
  options: { dryRun?: boolean } = {},
): { relabeled: number; retained: number; unparsable: number } {
  if (!existsSync(logPath)) return { relabeled: 0, retained: 0, unparsable: 0 }
  let raw: string
  try {
    raw = readFileSync(logPath, 'utf-8')
  } catch {
    return { relabeled: 0, retained: 0, unparsable: 0 }
  }
  const { text, relabeled, retained, unparsable } = relabelCalibrationRows(raw, fromName, toName)
  if (relabeled > 0 && !options.dryRun) {
    durableAtomicWriteFileSync(logPath, text, { mode: 0o600 })
  }
  return { relabeled, retained, unparsable }
}

/** Rewrite the log without a given speaker's rows. */
export function purgeSpeakerCalibrationRows(
  logPath: string,
  speakerName: string,
  options: { dryRun?: boolean } = {},
): CalibrationPurgeResult {
  if (!existsSync(logPath)) return { removed: 0, retained: 0, unparsable: 0 }
  let raw: string
  try {
    raw = readFileSync(logPath, 'utf-8')
  } catch {
    return { removed: 0, retained: 0, unparsable: 0 }
  }

  const { text, result } = filterCalibrationRows(raw, speakerName)
  if (result.removed === 0 || options.dryRun) return result

  // Atomic: a torn rewrite of a 2 MB log would leave a half-row that every
  // later parse trips over.
  durableAtomicWriteFileSync(logPath, text, { mode: 0o600 })
  return result
}
