// The record of every speaker correction a human has made, per meeting.
//
// WHY A LEDGER AND NOT JUST A REWRITE. A relabel mutates files in place: the
// chunk sidecar, the attendee list, the transcript turn labels. If that is all
// that happens, three things become impossible:
//
//   1. UNDO. Once "Luke H" has become "Luke Henry" in the sidecar, nothing
//      remembers it was ever anything else. A mistaken correction is permanent.
//   2. CRASH RECOVERY. A rewrite touches several files. Die between them and the
//      meeting is half-corrected with no trace of what was intended.
//   3. TRAINING. Piece 3 turns a correction into an enrollment. It needs to know
//      WHICH chunks a human vouched for, and to be able to retract that vouching
//      later if the correction is undone.
//
// So the ledger is written FIRST, as intent, and the rewrite follows. A row with
// an intent and no outcome is a correction that did not finish — visible rather
// than silent.
//
// WHAT IS DELIBERATELY NOT CORRECTED. The meeting markdown's Summary, Topics,
// Decisions and Action Items are LLM prose that refers to people by BARE FIRST
// NAME ("Jeremy pushed back", "Chris raised Beamer sentiment"). Verified on a
// real scribe: 6 of 12 speakers appear that way. This org has two Kyles, two
// Jacobuses and two Chrises, so a find/replace on a first name in narrative text
// would silently rewrite a sentence about a different person. Prose is left
// alone and flagged stale instead — `proseStale` on the applied row.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'

export const CORRECTIONS_DIR = 'meeting-corrections'

/**
 * A correction is recorded in two phases sharing one id.
 * `intent` goes down before any file is touched; `applied` or `failed` closes it.
 * An unclosed intent is an incomplete correction, not a successful one.
 */
export type CorrectionPhase = 'intent' | 'applied' | 'failed' | 'confirmed'
/**
 * A human confirming the identifier was RIGHT about a label the display floor
 * demoted.
 *
 * Distinct from a rename, and it has to be: `relabelSidecarJson` rejects
 * `from === to`, so "yes, this really is Queen Ukaoma" cannot be expressed as a
 * correction at all. The floor exists because a 0.56 match is not evidence — but
 * a person who was in the room IS evidence, and there was no way to record it.
 * The panel demoted the row, told the reviewer to name it, and then offered a
 * list that deliberately excluded the one name they wanted.
 *
 * A confirmation rewrites NOTHING. The sidecar already carries the label; this
 * only records that a human vouched for it, so the review stops presenting it
 * as unearned. Scoped to one meeting like every other correction.
 */
export const CONFIRMATION_PHASE = 'confirmed' as const

/** Runtime counterpart of CorrectionPhase. Must stay in step with it. */
const VALID_PHASES = new Set<string>(['intent', 'applied', 'failed', 'confirmed'])

/** Narrowing guard, so the reader keeps its type safety with one phase list. */
function isCorrectionPhase(value: unknown): value is CorrectionPhase {
  return typeof value === 'string' && VALID_PHASES.has(value)
}

export interface CorrectionSurfaces {
  /** Chunks whose `speaker` changed in the sidecar. */
  sidecar: number
  /** Lines changed in the markdown attendee list. */
  attendees: number
  /** `[Name]:` turn labels changed in the markdown transcript. */
  transcript: number
}

export interface CorrectionRow {
  id: string
  phase: CorrectionPhase
  /** ISO timestamp, supplied by the caller so this module stays deterministic. */
  at: string
  from: string
  to: string
  /**
   * The exact chunk indices this correction covers. Explicit rather than derived,
   * because piece 3 enrolls precisely these and must be able to retract
   * precisely these. An empty array means "every chunk carrying `from`", which
   * is resolved at apply time and written back onto the applied row.
   */
  chunks: number[]
  /**
   * 'meeting' is the only scope. Corrections are per-meeting BY DESIGN: the
   * identifier mishearing one voice in one room does not mean every past chunk
   * was wrong, and rewriting history on a single correction is how a small
   * mistake becomes an unrecoverable one.
   */
  scope: 'meeting'
  surfaces?: CorrectionSurfaces
  /** True when narrative prose still carries the old label. See the header. */
  proseStale?: boolean
  /** Why an attempt failed, on a `failed` row. */
  error?: string
}

function sessionFile(sessionId: string): string | null {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return null
  const dir = dataPath(CORRECTIONS_DIR)
  const path = join(dir, `${sessionId.replace(/:/g, '_')}.jsonl`)
  return resolve(path).startsWith(resolve(dir) + '/') ? path : null
}

/**
 * Append one row. Returns false rather than throwing on a bad session id or an
 * unwritable directory — but note the caller's contract: if the INTENT row
 * cannot be written, the rewrite must not proceed. An unrecorded mutation is
 * exactly what this file exists to prevent.
 */
export function appendCorrection(sessionId: string, row: CorrectionRow): boolean {
  const path = sessionFile(sessionId)
  if (!path) return false
  try {
    mkdirSync(dataPath(CORRECTIONS_DIR), { recursive: true, mode: 0o700 })
    appendFileSync(path, JSON.stringify(row) + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export interface CorrectionReadResult {
  rows: CorrectionRow[]
  /** Lines that could not be parsed. Surfaced, because a correction history read
   *  partially is a correction history that lies about what a human decided. */
  unusable: number
  missing: boolean
}

export function readCorrections(sessionId: string): CorrectionReadResult {
  const path = sessionFile(sessionId)
  if (!path || !existsSync(path)) return { rows: [], unusable: 0, missing: true }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { rows: [], unusable: 0, missing: true }
  }
  const rows: CorrectionRow[] = []
  let unusable = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.from !== 'string' || typeof o.to !== 'string') { unusable++; continue }
      // Kept as one list so adding a phase to the TYPE cannot silently make
      // every such row unusable at read time — which is exactly what happened
      // when 'confirmed' was added: appendCorrection wrote it, this dropped it,
      // and the confirmation vanished with no error anywhere.
      if (!isCorrectionPhase(o.phase)) { unusable++; continue }
      rows.push({
        id: o.id,
        phase: o.phase,
        at: typeof o.at === 'string' ? o.at : '',
        from: o.from,
        to: o.to,
        chunks: Array.isArray(o.chunks) ? o.chunks.filter((n): n is number => typeof n === 'number') : [],
        scope: 'meeting',
        surfaces: isSurfaces(o.surfaces) ? o.surfaces : undefined,
        proseStale: typeof o.proseStale === 'boolean' ? o.proseStale : undefined,
        error: typeof o.error === 'string' ? o.error : undefined,
      })
    } catch {
      unusable++
    }
  }
  return { rows, unusable, missing: false }
}

function isSurfaces(v: unknown): v is CorrectionSurfaces {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.sidecar === 'number' && typeof o.attendees === 'number' && typeof o.transcript === 'number'
}

/**
 * Corrections that recorded an intent and never closed it.
 *
 * This is the crash signal. A process that died mid-rewrite leaves exactly this,
 * and a meeting with a pending correction should be treated as possibly
 * half-written rather than clean.
 */
/**
 * Labels a human has confirmed for this meeting.
 *
 * Read by the speaker review to clear the display floor for exactly those
 * labels. A confirmation is per-meeting and never global: vouching for a voice
 * in one room says nothing about a different room, which is the same reasoning
 * that makes every correction here meeting-scoped.
 */
export function confirmedLabels(sessionId: string): Set<string> {
  const confirmed = new Set<string>()
  for (const row of readCorrections(sessionId).rows) {
    if (row.phase === 'confirmed') confirmed.add(row.to)
  }
  return confirmed
}

export function pendingCorrections(sessionId: string): CorrectionRow[] {
  const { rows } = readCorrections(sessionId)
  const closed = new Set(rows.filter(r => r.phase !== 'intent').map(r => r.id))
  return rows.filter(r => r.phase === 'intent' && !closed.has(r.id))
}

/** Only the corrections that actually landed — the ones piece 3 may train on. */
export function appliedCorrections(sessionId: string): CorrectionRow[] {
  return readCorrections(sessionId).rows.filter(r => r.phase === 'applied')
}

/**
 * Follow a chain of applied corrections to the label a voice now carries.
 *
 * Chains happen: a voice labelled 'Ext' is corrected to 'Luke H', then later to
 * 'Luke Henry'. Asking "what is Ext now?" must answer 'Luke Henry', not stop at
 * the first hop. Cycles are possible if a human corrects A→B then B→A, so the
 * walk is bounded by the number of corrections and returns the last label
 * reached rather than looping.
 */
export function currentLabelFor(sessionId: string, originalLabel: string): string {
  const applied = appliedCorrections(sessionId)
  let label = originalLabel
  const seen = new Set<string>([label])
  for (let hop = 0; hop < applied.length; hop++) {
    // Latest applied correction FROM the current label wins: a later human
    // decision supersedes an earlier one.
    const next = [...applied].reverse().find(r => r.from === label)
    if (!next || seen.has(next.to)) break
    label = next.to
    seen.add(label)
  }
  return label
}

/** Counts for /api/health — pending is the number that matters. */
export function correctionStoreStats(): {
  sessions: number
  applied: number
  pending: number
  failed: number
} {
  const dir = dataPath(CORRECTIONS_DIR)
  if (!existsSync(dir)) return { sessions: 0, applied: 0, pending: 0, failed: 0 }
  let sessions = 0, applied = 0, pending = 0, failed = 0
  try {
    for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
      try {
        statSync(join(dir, name))
        sessions++
        const id = name.replace(/\.jsonl$/, '')
        const { rows } = readCorrections(id)
        applied += rows.filter(r => r.phase === 'applied').length
        failed += rows.filter(r => r.phase === 'failed').length
        pending += pendingCorrections(id).length
      } catch { /* skip unreadable */ }
    }
  } catch { /* report what we have */ }
  return { sessions, applied, pending, failed }
}
