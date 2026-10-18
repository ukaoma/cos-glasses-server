// Transcript cleanup (6.77.0): the undoable record of every edit, and the one place that
// writes a cleaned transcript.
//
// Modelled on meeting-corrections.ts: the ledger is written FIRST, as intent, and the
// files follow. Each applied edit keeps the ORIGINAL words beside the replacement and
// enough of the surrounding line to find it again, so any one span can be restored later
// (POST /api/meeting/:id/transcript-cleanup/undo) without touching the edits around it.
//
// WRITES. Sidecar first, markdown second, as the meeting store does: the markdown is the
// visible commit. Both files are re-read immediately before writing and compared with the
// copies the cleanup started from; any difference (a human relabel, a summary, a second
// writer) and nothing is written: `changed_during_cleanup`. Only the `## Transcript`
// section and the sidecar's `batchTranscript` (kept equal to the canonical text, as the
// Nemotron final pass keeps it), `transcriptCleanup` summary and `lifecycleRevision` change.
//
// One ledger per meeting, `transcript-cleanup/ledger/<id>.jsonl`, deleted with the meeting
// (sweepTranscriptCleanupData). A torn or unknown row is counted, never trusted.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { cleanupDir, sessionFile } from './transcript-cleanup-screen.js'
import { joinTranscriptLines, parseTranscriptLines, type TranscriptLine } from './transcript-cleanup-text.js'

export const TRANSCRIPT_SECTION = /## Transcript\n\n([\s\S]*)$/
export function readTranscriptSection(markdown: string): string | null {
  const match = TRANSCRIPT_SECTION.exec(markdown)
  return match ? match[1].replace(/\n+$/, '') : null
}
export function replaceTranscriptSection(markdown: string, transcript: string): string | null {
  if (!TRANSCRIPT_SECTION.test(markdown)) return null
  return markdown.replace(TRANSCRIPT_SECTION, () => `## Transcript\n\n${transcript}\n`)
}
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export type RunPhase = 'intent' | 'done' | 'skipped' | 'failed'
export interface RunRow {
  kind: 'run'
  runId: string
  phase: RunPhase
  at: string
  inputSha: string
  outputSha?: string
  model?: string
  reason?: string
  /** Why the model was not asked, while fuzzy fixes still applied (correction_skipped style). */
  modelSkipped?: string
}
export interface EditRow {
  kind: 'edit'
  id: string
  runId: string
  at: string
  line: number
  /** Offset of the replacement in the cleaned line. */
  offset: number
  original: string
  replacement: string
  before: string
  after: string
  /** sha-256 of the whole cleaned line when the run committed: while it still matches, offsets are exact. */
  lineSha: string
  source: 'fuzzy' | 'model'
  reasons?: string[]
}
export interface RevertRow { kind: 'revert'; editId: string; at: string }
export type LedgerRow = RunRow | EditRow | RevertRow

export function appendLedger(sessionId: string, rows: LedgerRow[]): boolean {
  const path = sessionFile('ledger', sessionId)
  if (!path || rows.length === 0) return false
  try {
    mkdirSync(cleanupDir('ledger'), { recursive: true, mode: 0o700 })
    appendFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function readLedger(sessionId: string): { rows: LedgerRow[]; unusable: number } {
  const path = sessionFile('ledger', sessionId)
  if (!path || !existsSync(path)) return { rows: [], unusable: 0 }
  let raw = ''
  try { raw = readFileSync(path, 'utf8') } catch { return { rows: [], unusable: 0 } }
  const rows: LedgerRow[] = []
  let unusable = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      if (o.kind === 'run' && typeof o.runId === 'string' && typeof o.inputSha === 'string' && ['intent', 'done', 'skipped', 'failed'].includes(o.phase as string)) rows.push(o as unknown as RunRow)
      else if (o.kind === 'edit' && typeof o.id === 'string' && typeof o.line === 'number' && typeof o.offset === 'number'
        && typeof o.original === 'string' && typeof o.replacement === 'string' && typeof o.before === 'string' && typeof o.after === 'string'
        && typeof o.lineSha === 'string') rows.push(o as unknown as EditRow)
      else if (o.kind === 'revert' && typeof o.editId === 'string') rows.push(o as unknown as RevertRow)
      else unusable++
    } catch { unusable++ }
  }
  return { rows, unusable }
}

/** A completed run already produced (or started from) this exact transcript: do not run again. */
export function alreadyCleaned(sessionId: string, transcriptSha: string): boolean {
  return readLedger(sessionId).rows.some(r => r.kind === 'run' && (r.phase === 'done' || r.phase === 'skipped')
    && (r.outputSha === transcriptSha || r.inputSha === transcriptSha))
}

export interface PlannedEdit {
  line: number
  start: number
  end: number
  replacement: string
  source: 'fuzzy' | 'model'
  reasons?: string[]
}

const CONTEXT_CHARS = 24

export type AppliedEdit = PlannedEdit & { original: string; offset: number; before: string; after: string; lineSha: string }

/**
 * Apply non-overlapping edits to the lines. Returns the new lines and, per edit, where its
 * replacement now sits and the text around it. An overlapping edit is dropped (the earlier
 * one in the line wins), which cannot happen for spans and fixes built from distinct tokens.
 */
export function applyPlannedEdits(lines: readonly TranscriptLine[], edits: readonly PlannedEdit[]): {
  lines: TranscriptLine[]
  applied: AppliedEdit[]
} {
  const next = lines.map(l => ({ ...l }))
  const applied: AppliedEdit[] = []
  const byLine = new Map<number, PlannedEdit[]>()
  for (const e of edits) byLine.set(e.line, [...(byLine.get(e.line) ?? []), e])
  for (const [lineIndex, list] of byLine) {
    const line = next.find(l => l.index === lineIndex)
    if (!line || !line.editable) continue
    const sorted = [...list].sort((a, b) => a.start - b.start)
    const source = line.text
    let out = ''
    let cursor = 0
    const placed: Array<{ edit: PlannedEdit; offset: number }> = []
    for (const e of sorted) {
      if (e.start < cursor || e.end > source.length || e.start >= e.end) continue
      out += source.slice(cursor, e.start)
      placed.push({ edit: e, offset: out.length })
      out += e.replacement
      cursor = e.end
    }
    out += source.slice(cursor)
    line.text = out
    for (const { edit, offset } of placed) {
      applied.push({
        ...edit,
        original: source.slice(edit.start, edit.end),
        offset,
        before: out.slice(Math.max(0, offset - CONTEXT_CHARS), offset),
        after: out.slice(offset + edit.replacement.length, offset + edit.replacement.length + CONTEXT_CHARS),
        lineSha: sha256(out),
      })
    }
  }
  return { lines: next, applied }
}

export class CleanupWriteError extends Error {
  constructor(readonly code: 'changed_during_cleanup' | 'no_transcript' | 'sidecar_unreadable' | 'write_failed', message?: string) { super(message ?? code) }
}

/**
 * Write a new transcript section into the meeting, if neither file changed since it was
 * read. `summary` lands under the sidecar's `transcriptCleanup`; it must hold counts only.
 */
export function commitCleanTranscript(options: {
  meetingPath: string
  sidecarPath: string
  markdown: string
  sidecarText: string
  transcript: string
  summary: Record<string, unknown>
  write?: (path: string, data: string) => void
}): void {
  const write = options.write ?? ((path: string, data: string) => durableAtomicWriteFileSync(path, data, { mode: 0o600 }))
  const oldSection = readTranscriptSection(options.markdown)
  const nextMarkdown = replaceTranscriptSection(options.markdown, options.transcript)
  if (oldSection === null || nextMarkdown === null) throw new CleanupWriteError('no_transcript')
  let sidecar: Record<string, unknown>
  try {
    const parsed = JSON.parse(options.sidecarText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    sidecar = parsed as Record<string, unknown>
  } catch { throw new CleanupWriteError('sidecar_unreadable') }
  if (typeof sidecar.batchTranscript === 'string' && sidecar.batchTranscript.replace(/\n+$/, '') === oldSection) sidecar.batchTranscript = options.transcript
  sidecar.transcriptCleanup = options.summary
  sidecar.lifecycleRevision = Number(sidecar.lifecycleRevision ?? 0) + 1
  let markdownNow: string, sidecarNow: string
  try {
    markdownNow = readFileSync(options.meetingPath, 'utf8')
    sidecarNow = readFileSync(options.sidecarPath, 'utf8')
  } catch { throw new CleanupWriteError('changed_during_cleanup', 'meeting files unreadable at commit') }
  if (markdownNow !== options.markdown || sidecarNow !== options.sidecarText) throw new CleanupWriteError('changed_during_cleanup')
  try {
    write(options.sidecarPath, JSON.stringify(sidecar, null, 2))
  } catch (error) { throw new CleanupWriteError('write_failed', `sidecar: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)) }
  try {
    write(options.meetingPath, nextMarkdown)
  } catch (error) {
    try { write(options.sidecarPath, options.sidecarText) } catch { /* the two files now disagree; say so */ }
    throw new CleanupWriteError('write_failed', `markdown: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200))
  }
}

export type UndoOutcome =
  | { ok: true; reverted: string[] }
  | { ok: false; status: number; error: string }

/**
 * Restore the original words of one edit, or of every live edit of one run. Refuses
 * (409 stale) when the cleaned words are no longer where the ledger left them: a later
 * edit by hand, a relabel that split the line, or a re-transcription.
 */
export function undoCleanupEdits(options: {
  sessionId: string
  meetingPath: string
  sidecarPath: string
  editId?: string
  runId?: string
  now?: () => Date
  write?: (path: string, data: string) => void
}): UndoOutcome {
  const { rows } = readLedger(options.sessionId)
  const reverted = new Set(rows.filter((r): r is RevertRow => r.kind === 'revert').map(r => r.editId))
  const edits = rows.filter((r): r is EditRow => r.kind === 'edit' && !reverted.has(r.id))
  const targets = options.editId ? edits.filter(e => e.id === options.editId) : options.runId ? edits.filter(e => e.runId === options.runId) : []
  if (!targets.length) {
    const known = rows.some(r => r.kind === 'edit' && (r.id === options.editId || r.runId === options.runId))
    return known ? { ok: false, status: 409, error: 'already_reverted' } : { ok: false, status: 404, error: 'edit_not_found' }
  }
  let markdown: string, sidecarText: string
  try {
    markdown = readFileSync(options.meetingPath, 'utf8')
    sidecarText = readFileSync(options.sidecarPath, 'utf8')
  } catch { return { ok: false, status: 404, error: 'meeting_missing' } }
  const section = readTranscriptSection(markdown)
  if (section === null) return { ok: false, status: 409, error: 'no_transcript' }
  const lines = parseTranscriptLines(section)
  // Later edits first inside a line, so earlier offsets stay true.
  const ordered = [...targets].sort((a, b) => a.line - b.line || b.offset - a.offset)
  // A line still exactly as the run left it: every offset is exact. Otherwise each edit is
  // found again by its words and their surroundings, and must be found exactly once.
  const untouched = new Map<number, boolean>()
  for (const edit of ordered) {
    const line = lines.find(l => l.index === edit.line)
    if (!line) return { ok: false, status: 409, error: 'stale' }
    if (!untouched.has(line.index)) untouched.set(line.index, sha256(line.text) === edit.lineSha)
    let at = -1
    if (untouched.get(line.index) && line.text.slice(edit.offset, edit.offset + edit.replacement.length) === edit.replacement) at = edit.offset
    else {
      const needle = edit.before + edit.replacement + edit.after
      const first = line.text.indexOf(needle)
      if (first >= 0 && line.text.indexOf(needle, first + 1) < 0) at = first + edit.before.length
    }
    if (at < 0) return { ok: false, status: 409, error: 'stale' }
    line.text = line.text.slice(0, at) + edit.original + line.text.slice(at + edit.replacement.length)
  }
  const transcript = joinTranscriptLines(lines)
  const now = (options.now ?? (() => new Date()))().toISOString()
  const live = edits.length - targets.length
  try {
    commitCleanTranscript({
      meetingPath: options.meetingPath, sidecarPath: options.sidecarPath, markdown, sidecarText, transcript,
      summary: { ...currentSummary(sidecarText), liveEdits: live, revertedAt: now },
      write: options.write,
    })
  } catch (error) {
    const code = error instanceof CleanupWriteError ? error.code : 'write_failed'
    return { ok: false, status: code === 'changed_during_cleanup' ? 409 : 500, error: code }
  }
  appendLedger(options.sessionId, targets.map(t => ({ kind: 'revert' as const, editId: t.id, at: now })))
  return { ok: true, reverted: targets.map(t => t.id) }
}

function currentSummary(sidecarText: string): Record<string, unknown> {
  try {
    const s = (JSON.parse(sidecarText) as Record<string, unknown>).transcriptCleanup
    return s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {}
  } catch { return {} }
}

/** The ledger as the review route shows it: runs, and each edit with whether it is still live. */
export function ledgerView(sessionId: string): { runs: RunRow[]; edits: Array<EditRow & { reverted: boolean }>; unusable: number } {
  const { rows, unusable } = readLedger(sessionId)
  const reverted = new Set(rows.filter((r): r is RevertRow => r.kind === 'revert').map(r => r.editId))
  const runs = new Map<string, RunRow>()
  for (const r of rows) if (r.kind === 'run') runs.set(r.runId, r)
  return {
    runs: [...runs.values()],
    edits: rows.filter((r): r is EditRow => r.kind === 'edit').map(e => ({ ...e, reverted: reverted.has(e.id) })),
    unusable,
  }
}

export const newRunId = (): string => `tc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
export const newEditId = (): string => `te_${randomUUID().replace(/-/g, '').slice(0, 16)}`
