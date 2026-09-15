/**
 * What a suggestion is ABOUT, resolved on the server (6.47.0, QA1).
 *
 * WHY THIS EXISTS. A suggestion carries canonical ids and a phrase count: a G2 `sessionId`
 * and a Fireflies vendor id. That is everything the engine needs and nothing a person does.
 * "Shares 47 phrases" between `s_9f2a...` and `01JQ...` is not a question anyone can answer.
 *
 * WHY THE SERVER AND NOT THE CLIENT. COS Control tried to resolve the two sides itself and
 * could only do it in imports mode: it re-derived `imported:fireflies:<h16>` from the vendor
 * id and looked the row up in the imported library. On a PIPELINE Mac — the one surface
 * where a person actually reviews these, because advise mode is the whole point of the
 * review gate — there is no imported library. The Fireflies side lives in the operations
 * tree under a path only the server knows, so the row never resolved and every suggestion
 * rendered as two opaque ids with `resolved` hard-coded from whether an index was empty.
 *
 * THREE PLACES A SIDE CAN LIVE, tried in order, and `resolved: false` when it is in none of
 * them — which is a real state (a deleted recording, a transcript the vendor removed) and is
 * reported rather than papered over.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  findCosOperationsMeetingBySessionId,
  resolveCosOperationsDir,
} from './cos-operations-meetings.js'
import {
  type ImportedMeetingLibrary,
  getImportedMeetingLibrary,
  importHash,
  importRecordId,
} from './imported-meeting-library.js'
import type { CanonicalInputs, MergeSuggestionRecord } from './meeting-actions-store.js'
import { getMeetingStore, parseField, type MeetingStore } from './meeting-store.js'

/** Bounded read for an operations `.fireflies.json`. Same ceiling the engine uses. */
export const SIDE_SIDECAR_MAX_BYTES = 64 * 1024 * 1024

export type SuggestionSideKind = 'g2' | 'fireflies'

export interface SuggestionSide {
  kind: SuggestionSideKind
  /** The canonical id: a G2 `sessionId`, or the Fireflies vendor id. */
  id: string
  /** The record that still holds it, in the form `/api/meetings` uses. */
  recordId?: string
  title?: string
  /** Epoch ms. Absent when nothing on disk could say when this happened. */
  startMs?: number
  durationMinutes?: number
  /** Which library the side was found in. */
  source?: 'imported' | 'cos_operations' | 'standalone_recordings'
  /** False when nothing on this Mac holds this id any more. */
  resolved: boolean
}

export interface SuggestionWithSides extends MergeSuggestionRecord {
  sides: SuggestionSide[]
}

export interface SideResolverDeps {
  library?: ImportedMeetingLibrary
  store?: MeetingStore
  /** Operations-relative `.fireflies.json` path per vendor id, from the engine's own scan. */
  firefliesScribeRelPaths?: Record<string, { sidecarRelPath?: string; scribeRelPath?: string }>
}

function minutesFromDurationField(value: string | undefined): number | undefined {
  const match = value?.match(/(\d+)/)
  return match ? Number(match[1]) : undefined
}

function epochFromDateField(date: string | undefined, time: string | undefined): number | undefined {
  if (!date) return undefined
  const parsed = Date.parse(time ? `${date}T${time}` : date)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The imported library's own row for a Fireflies id, when this Mac imported it. */
function firefliesFromImports(id: string, library: ImportedMeetingLibrary): SuggestionSide | null {
  const recordId = importRecordId('fireflies', importHash(id))
  const row = library.list().find(candidate => candidate.recordId === recordId)
  if (!row) return null
  return {
    kind: 'fireflies',
    id,
    recordId,
    title: row.title,
    ...(epochFromDateField(row.date, row.time) !== undefined ? { startMs: epochFromDateField(row.date, row.time)! } : {}),
    ...(row.durationMinutes !== undefined ? { durationMinutes: row.durationMinutes } : {}),
    source: 'imported',
    resolved: true,
  }
}

/**
 * The operations tree's own scribe for a Fireflies id, on a pipeline Mac.
 *
 * The `.fireflies.json` sidecar is the only file that maps a vendor id to a path, so the
 * caller hands over the map the engine's collector already built. Without it this side is
 * unresolvable on exactly the Macs where the review happens.
 */
function firefliesFromOperations(
  id: string,
  paths: SideResolverDeps['firefliesScribeRelPaths'],
): SuggestionSide | null {
  const entry = paths?.[id]
  const operationsDir = resolveCosOperationsDir()
  if (!entry || !operationsDir) return null
  const relPath = entry.scribeRelPath ?? entry.sidecarRelPath?.replace(/\.fireflies\.json$/, '.md')
  if (!relPath) return null
  const absolute = join(operationsDir, relPath)
  const parts = relPath.split('/')
  // `<domain>/meetings/<month>/<filename>` is the operations shape; anything else is a path
  // this server did not write and has no record id for.
  const recordId = parts.length >= 4 && parts[1] === 'meetings'
    ? `ops:${parts[0]}:${parts[2]}:${parts[parts.length - 1]}`
    : undefined
  let title = basename(relPath, '.md')
  let startMs: number | undefined
  let durationMinutes: number | undefined
  if (existsSync(absolute)) {
    try {
      const head = readFileSync(absolute, 'utf8').slice(0, 4096)
      title = head.match(/^#\s+(.+)$/m)?.[1]?.trim() || title
      const dateField = parseField(head, 'Date')
      const [datePart, timePart] = (dateField ?? '').split(/\s+/)
      startMs = epochFromDateField(datePart, timePart)
      durationMinutes = minutesFromDurationField(parseField(head, 'Duration'))
    } catch {
      // A scribe that cannot be read still resolves to a path and a name.
    }
  }
  // The sidecar is authoritative about the vendor's own clock and length.
  const sidecarRel = entry.sidecarRelPath
  if (sidecarRel) {
    const sidecarPath = join(operationsDir, sidecarRel)
    try {
      if (statSync(sidecarPath).size <= SIDE_SIDECAR_MAX_BYTES) {
        const doc = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>
        if (typeof doc.date === 'number' && Number.isFinite(doc.date)) startMs = doc.date
        if (typeof doc.duration === 'number' && Number.isFinite(doc.duration)) durationMinutes = Math.round(doc.duration)
        if (typeof doc.title === 'string' && doc.title.trim()) title = doc.title.trim()
      }
    } catch {
      // Fall back to whatever the scribe said.
    }
  }
  return {
    kind: 'fireflies',
    id,
    ...(recordId ? { recordId } : {}),
    title,
    ...(startMs !== undefined ? { startMs } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    source: 'cos_operations',
    resolved: true,
  }
}

/** `Date` and `Duration` out of a meeting file's metadata table. */
function stampFromMeetingHead(path: string): { title?: string; startMs?: number; durationMinutes?: number } {
  try {
    const head = readFileSync(path, 'utf8').slice(0, MEETING_HEAD_BYTES)
    const [datePart, timePart] = (parseField(head, 'Date') ?? '').split(/\s+/)
    return {
      ...(head.match(/^#\s+(.+)$/m)?.[1]?.trim() ? { title: head.match(/^#\s+(.+)$/m)![1].trim() } : {}),
      ...(epochFromDateField(datePart, timePart) !== undefined ? { startMs: epochFromDateField(datePart, timePart)! } : {}),
      ...(minutesFromDurationField(parseField(head, 'Duration')) !== undefined
        ? { durationMinutes: minutesFromDurationField(parseField(head, 'Duration'))! }
        : {}),
    }
  } catch {
    return {}
  }
}

/** Enough to clear a scribe's title and metadata table whatever order its rows are in. */
export const MEETING_HEAD_BYTES = 4096

/** A G2 capture: the operations copy first, then this Mac's own recordings store. */
function g2Side(sessionId: string, store: MeetingStore): SuggestionSide {
  const operations = findCosOperationsMeetingBySessionId(sessionId)
  if (operations) {
    const stamp = stampFromMeetingHead(operations.meetingPath)
    return {
      kind: 'g2',
      id: sessionId,
      recordId: `ops:${operations.domain}:${operations.month}:${operations.filename}`,
      title: stamp.title ?? operations.title,
      ...(stamp.startMs !== undefined ? { startMs: stamp.startMs } : {}),
      ...(stamp.durationMinutes !== undefined ? { durationMinutes: stamp.durationMinutes } : {}),
      source: 'cos_operations',
      resolved: true,
    }
  }
  try {
    const found = store.findBySessionId(sessionId)
    if (found) {
      const stamp = stampFromMeetingHead(found.filepath)
      return {
        kind: 'g2',
        id: sessionId,
        recordId: `standalone:${sessionId}`,
        title: stamp.title ?? found.title,
        ...(stamp.startMs !== undefined ? { startMs: stamp.startMs } : {}),
        durationMinutes: stamp.durationMinutes ?? found.durationMin,
        source: 'standalone_recordings',
        resolved: true,
      }
    }
  } catch {
    // An unreadable store is an unresolved side, not a failed request.
  }
  return { kind: 'g2', id: sessionId, resolved: false }
}

/** Every side of one suggestion, in a stable order: captures first, then transcripts. */
export function resolveSuggestionSides(
  inputs: CanonicalInputs,
  deps: SideResolverDeps = {},
): SuggestionSide[] {
  const library = deps.library ?? getImportedMeetingLibrary()
  const store = deps.store ?? getMeetingStore()
  const sides: SuggestionSide[] = inputs.sessionIds.map(sessionId => g2Side(sessionId, store))
  for (const id of inputs.firefliesIds) {
    sides.push(
      firefliesFromImports(id, library)
      ?? firefliesFromOperations(id, deps.firefliesScribeRelPaths)
      ?? { kind: 'fireflies', id, resolved: false },
    )
  }
  return sides
}

/** Attach sides to every row of a suggestion list. */
export function withSuggestionSides(
  rows: readonly MergeSuggestionRecord[],
  deps: SideResolverDeps = {},
): SuggestionWithSides[] {
  return rows.map(row => ({ ...row, sides: resolveSuggestionSides(row.inputs, deps) }))
}
