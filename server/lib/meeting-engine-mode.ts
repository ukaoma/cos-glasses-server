// One predicate, read by every surface that behaves differently on a Mac with
// the COS pipeline than on a Mac without it.
//
// `imports` means nothing else here brings meetings in, so the server does: it
// imports Fireflies meetings and writes derived records under the imports root.
//
// On a Mac whose own pipeline already files Fireflies meetings into operations/,
// the server must not import them a second time — two writers producing
// near-identical records is how one meeting becomes two rows that each look
// canonical. Such a Mac is in one of two modes:
//
//   `advise`  the engine reads and shows what it WOULD do. It writes nothing
//             outside the imports root. This is the starting mode everywhere.
//   `apply`   the engine decides and the pipeline applies each decision into
//             operations/, additively and revertibly.
//
// WHY A FILE AND NOT AN ENVIRONMENT FLAG (v3 blocker 7). Four processes have to
// agree: this server, the hourly meeting sync, the meeting watcher and COS
// Control. An env flag is read per process from whatever launched it, so a
// LaunchAgent updated for one of them silently disagrees with the other three.
// One file at the shared default data path is read the same way by all of them.
//
// THE SERVER IS THE ONLY WRITER. The pipeline reads the file and never writes
// it; Control changes it through POST /api/meeting-engine/mode.
//
// ABSENT OR UNREADABLE MEANS ADVISE. The safe mode is the one that writes
// nothing into a person's meeting tree, so every failure to read the file lands
// there rather than on `apply`.
//
// The pipeline check is the STRICTER of the two available:
// `g2RecordingsReachOperations` requires both the venv Python and
// sync_meetings.py to exist, which is the same condition the save path uses to
// decide whether a recording can reach operations at all. Reading env live
// (rather than caching) matters because COS Control can change COS_SCRIPTS_DIR
// under a running server.

import { readFileSync } from 'node:fs'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { g2RecordingsReachOperations } from './g2-ops-handoff.js'

export type MeetingEngineMode = 'advise' | 'imports' | 'apply'

/** The modes a pipeline Mac can be switched between. `imports` is not a choice. */
export type MeetingEnginePipelineMode = 'advise' | 'apply'

export const MERGE_MODE_FILENAME = 'merge-engine.json'
export const MERGE_MODE_SCHEMA = 1

export interface MergeModeFile {
  schema: number
  mode: MeetingEnginePipelineMode
  changedAt: string
  changedBy: 'control'
}

export function mergeModeFilePath(): string {
  return dataPath(MERGE_MODE_FILENAME)
}

/**
 * The mode recorded in the file, for a Mac that has a pipeline.
 *
 * Every failure — missing file, unreadable file, bad JSON, an unknown schema, an
 * unknown mode — answers `advise`. A file that cannot be understood must never
 * be read as permission to write into operations/.
 */
export function readMergeModeFile(path: string = mergeModeFilePath()): MeetingEnginePipelineMode {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return 'advise'
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MergeModeFile>
    if (parsed?.schema !== MERGE_MODE_SCHEMA) return 'advise'
    return parsed.mode === 'apply' ? 'apply' : 'advise'
  } catch {
    return 'advise'
  }
}

/** Write the mode file atomically. The server is the only caller. */
export function writeMergeModeFile(
  mode: MeetingEnginePipelineMode,
  options: { path?: string; now?: () => number } = {},
): MergeModeFile {
  const record: MergeModeFile = {
    schema: MERGE_MODE_SCHEMA,
    mode,
    changedAt: new Date((options.now ?? Date.now)()).toISOString(),
    changedBy: 'control',
  }
  durableAtomicWriteFileSync(options.path ?? mergeModeFilePath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return record
}

export function meetingEngineMode(): MeetingEngineMode {
  if (!g2RecordingsReachOperations()) return 'imports'
  return readMergeModeFile()
}

/** Whether this Mac may be switched between advise and apply at all. */
export function meetingEngineIsPipelineMac(): boolean {
  return g2RecordingsReachOperations()
}
