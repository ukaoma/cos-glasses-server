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
