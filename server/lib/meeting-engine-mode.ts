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

/**
 * What kind of Mac this install has been observed to be.
 *
 * WHY IT IS REMEMBERED. `g2RecordingsReachOperations()` is a LIVE probe: it stats the COS
 * venv's python and `sync_meetings.py`. Those two go missing for reasons that have nothing
 * to do with this Mac's identity — iCloud evicting the checkout, a `pip` rebuild, COS
 * Control changing `COS_SCRIPTS_DIR` between two reads. Every one of those made the predicate
 * answer `imports`, and `imports` is the one mode that lets the server IMPORT Fireflies
 * meetings the pipeline already files, which is how one meeting becomes two rows that each
 * look canonical.
 *
 * A Mac that has once been seen with a pipeline is remembered as one. A transient negative
 * then keeps the recorded mode (advise, the safe default) rather than flipping to imports,
 * and the disagreement is reported in engine status as an alarm instead of acted on.
 */
export type MeetingEngineMacClass = 'pipeline' | 'standalone'

export interface MergeModeFile {
  schema: number
  mode: MeetingEnginePipelineMode
  changedAt: string
  changedBy: 'control' | 'server'
  /** The Mac class this install has been observed to be. Absent on a pre-QA1 file. */
  macClass?: MeetingEngineMacClass
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
/** The whole file, or null when it cannot be understood. */
export function readMergeModeRecord(path: string = mergeModeFilePath()): MergeModeFile | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MergeModeFile>
    if (parsed?.schema !== MERGE_MODE_SCHEMA) return null
    return {
      schema: MERGE_MODE_SCHEMA,
      mode: parsed.mode === 'apply' ? 'apply' : 'advise',
      changedAt: typeof parsed.changedAt === 'string' ? parsed.changedAt : new Date(0).toISOString(),
      changedBy: parsed.changedBy === 'server' ? 'server' : 'control',
      ...(parsed.macClass === 'pipeline' || parsed.macClass === 'standalone' ? { macClass: parsed.macClass } : {}),
    }
  } catch {
    return null
  }
}

export function readMergeModeFile(path: string = mergeModeFilePath()): MeetingEnginePipelineMode {
  return readMergeModeRecord(path)?.mode ?? 'advise'
}

/** Write the mode file atomically. The server is the only caller. */
export function writeMergeModeFile(
  mode: MeetingEnginePipelineMode,
  options: { path?: string; now?: () => number; macClass?: MeetingEngineMacClass; changedBy?: 'control' | 'server' } = {},
): MergeModeFile {
  const path = options.path ?? mergeModeFilePath()
  const macClass = options.macClass ?? readMergeModeRecord(path)?.macClass
  const record: MergeModeFile = {
    schema: MERGE_MODE_SCHEMA,
    mode,
    changedAt: new Date((options.now ?? Date.now)()).toISOString(),
    changedBy: options.changedBy ?? 'control',
    ...(macClass ? { macClass } : {}),
  }
  durableAtomicWriteFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return record
}

/**
 * Remember the Mac class, at most once per process per class.
 *
 * Bounded on purpose: `meetingEngineMode()` is called on every list, every detail, every
 * status poll and every import refusal, and a write per call would be a write per request.
 * The class only ever changes when a person installs or removes the COS pipeline, so once
 * per process is enough to notice it.
 */
let rememberedMacClass: MeetingEngineMacClass | null = null

/** Test seam: forget what this process has already written. */
export function resetRememberedMacClass(): void {
  rememberedMacClass = null
}

function rememberMacClass(macClass: MeetingEngineMacClass, current: MergeModeFile | null): void {
  if (rememberedMacClass === macClass) return
  rememberedMacClass = macClass
  try {
    writeMergeModeFile(current?.mode ?? 'advise', { macClass, changedBy: 'server' })
  } catch {
    // The data home is not writable. The predicate still answers; only the memory is lost.
  }
}

/**
 * The mode, and what it was decided from.
 *
 * A LIVE POSITIVE ALWAYS WINS: a Mac that can reach operations right now is a pipeline Mac,
 * whatever the file says. A live NEGATIVE only wins when the file has never seen a pipeline
 * here. That asymmetry is deliberate — being wrong towards `advise` writes nothing, and being
 * wrong towards `imports` imports meetings the pipeline already owns.
 */
export function meetingEngineModeDetail(): {
  mode: MeetingEngineMode
  observedMacClass: MeetingEngineMacClass
  recordedMacClass?: MeetingEngineMacClass
  /** True when the recorded class and the live probe disagree. Reported, never acted on. */
  macClassChanged: boolean
} {
  const reaches = g2RecordingsReachOperations()
  const record = readMergeModeRecord()
  const observedMacClass: MeetingEngineMacClass = reaches ? 'pipeline' : 'standalone'
  const recordedMacClass = record?.macClass

  if (reaches) {
    rememberMacClass('pipeline', record)
    return { mode: record?.mode ?? 'advise', observedMacClass, ...(recordedMacClass ? { recordedMacClass } : {}), macClassChanged: recordedMacClass === 'standalone' }
  }
  if (recordedMacClass === 'pipeline') {
    // A transient negative. Keep the recorded mode and raise the alarm instead of importing
    // meetings a pipeline that is merely unreadable right now still owns.
    return { mode: record?.mode ?? 'advise', observedMacClass, recordedMacClass, macClassChanged: true }
  }
  rememberMacClass('standalone', record)
  return { mode: 'imports', observedMacClass, ...(recordedMacClass ? { recordedMacClass } : {}), macClassChanged: false }
}

export function meetingEngineMode(): MeetingEngineMode {
  return meetingEngineModeDetail().mode
}

/** Whether this Mac may be switched between advise and apply at all. */
export function meetingEngineIsPipelineMac(): boolean {
  return meetingEngineModeDetail().mode !== 'imports'
}
