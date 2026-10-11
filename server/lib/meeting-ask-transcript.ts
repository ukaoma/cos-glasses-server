/**
 * The transcript Meeting Ask reads for one session (6.71.1). A live recording comes from memory. Once it
 * ends, memory is cleared and the saved record holds the words, so a recently ended meeting stays askable:
 *   1. live: the in-memory session (ids are chunk indices);
 *   2. the durable active-session file (data/active-sessions/<id>.json), kept while a capture is unsaved;
 *   3. the saved record's sidecar (<date>_<title>_<hash>.g2-chunks.json) chunk entries, same chunk indices
 *      as the live recording, so turn ids in earlier answers still point at the same turns;
 *   4. the saved Markdown "## Transcript" section, when the sidecar holds no chunks (ids are line numbers).
 * Only when none holds a word is it 404 meeting_transcript_unavailable. Read-only: nothing is written.
 */
import { lstatSync, readFileSync } from 'node:fs'
import type { MeetingAskTranscript, MeetingAskTurn } from '../../shared/meeting-ask.js'
import { AskError } from './live-cos-ask.js'
import { redactSecrets } from './lens-gist-engines.js'

interface ChunkLike { text?: unknown; speaker?: unknown; elapsed?: unknown }
interface IndexedChunk { chunkIndex: number; chunk: ChunkLike }
export interface AskTranscriptSources {
  live: (sessionId: string) => { entries: IndexedChunk[]; startTime: number } | null
  /** state 'closed' with its last activity once the live session ended; anything else otherwise. */
  status: (sessionId: string) => { state: string; lastActivityAt?: string | null }
  activeFile: (sessionId: string) => string | null
  saved: (sessionId: string) => { sidecarPath: string; filepath: string } | null
  read: (path: string) => string | null
  now: () => number
}
const MAX_FILE_BYTES = 64 * 1024 * 1024
export function readBoundedFile(path: string): string | null {
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch { return null }
}
function toTurns(entries: IndexedChunk[]): MeetingAskTurn[] {
  const seen = new Set<number>()
  return entries.flatMap(({ chunkIndex, chunk }) => {
    if (!Number.isSafeInteger(chunkIndex) || seen.has(chunkIndex) || !chunk || typeof chunk.text !== 'string' || !chunk.text.trim()) return []
    seen.add(chunkIndex)
    const elapsed = typeof chunk.elapsed === 'number' && Number.isFinite(chunk.elapsed) ? Math.max(0, chunk.elapsed) : 0
    return [{ id: chunkIndex, elapsedMs: elapsed, speaker: typeof chunk.speaker === 'string' && chunk.speaker ? chunk.speaker.slice(0, 100) : 'Ext', text: redactSecrets(chunk.text) }]
  }).sort((a, b) => a.elapsedMs - b.elapsedMs || a.id - b.id)
}
function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}
/** chunkEntries/chunksIndexed keep the original chunk index; a dense legacy `chunks` array uses its position. */
function fileEntries(doc: Record<string, unknown>): IndexedChunk[] {
  if (Array.isArray(doc.chunkEntries)) return (doc.chunkEntries as any[]).filter(e => e && typeof e === 'object').map(e => ({ chunkIndex: e.chunkIndex, chunk: e.chunk }))
  if (Array.isArray(doc.chunksIndexed)) return (doc.chunksIndexed as any[]).filter(e => e && typeof e === 'object').map(e => ({ chunkIndex: e.i, chunk: e.c }))
  return Array.isArray(doc.chunks) ? (doc.chunks as ChunkLike[]).map((chunk, chunkIndex) => ({ chunkIndex, chunk })) : []
}
function markdownTurns(markdown: string | null): MeetingAskTurn[] {
  const section = markdown?.split(/\n## Transcript\n/)[1]
  if (!section) return []
  return section.split('\n').flatMap((line, i) => {
    const m = /^\[([^\]\n]{1,100})\]:\s?(.*)$/.exec(line)
    const text = (m ? m[2] : line).trim()
    // Gap markers are not words anyone said.
    if (!text || /^\[… audio gap/.test(line)) return []
    return [{ id: i, elapsedMs: 0, speaker: m ? m[1] : 'Ext', text: redactSecrets(text) }]
  })
}
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
function ended(turns: MeetingAskTurn[], durationMs: number | null, endedAt: number | null, notices: string[], source: MeetingAskTranscript['source']): MeetingAskTranscript {
  return { turns, elapsedMs: Math.max(durationMs ?? 0, ...turns.map(t => t.elapsedMs), 0), notices: ['This meeting has ended. Answers use its saved transcript.', ...notices], ended: true, ...(endedAt !== null ? { endedAt: new Date(endedAt).toISOString() } : {}), source }
}

export function resolveAskTranscript(sessionId: string, deps: AskTranscriptSources): MeetingAskTranscript {
  const live = deps.live(sessionId)
  if (live) {
    const turns = toTurns(live.entries)
    return { turns, elapsedMs: Math.max(deps.now() - live.startTime, ...turns.map(t => t.elapsedMs), 0), notices: [], source: 'live' }
  }
  const status = deps.status(sessionId)
  const closedAt = status.state === 'closed' && status.lastActivityAt ? Date.parse(status.lastActivityAt) : NaN
  const active = parseJson(deps.activeFile(sessionId))
  if (active && active.sessionId === sessionId) {
    const turns = toTurns(fileEntries(active))
    const start = finite(active.startTime), last = finite(active.lastActivityAt)
    if (turns.length) return ended(turns, start !== null && last !== null ? last - start : null, Number.isFinite(closedAt) ? closedAt : last, [], 'active_file')
  }
  const saved = deps.saved(sessionId)
  if (saved) {
    const sidecar = parseJson(deps.read(saved.sidecarPath))
    const start = finite(sidecar?.startTime), duration = finite(sidecar?.durationMs)
    const endedAt = Number.isFinite(closedAt) ? closedAt : start !== null && duration !== null ? start + duration : null
    if (sidecar && sidecar.sessionId === sessionId) {
      const turns = toTurns(fileEntries(sidecar))
      if (turns.length) return ended(turns, duration, endedAt, [], 'saved')
    }
    const turns = markdownTurns(deps.read(saved.filepath))
    if (turns.length) return ended(turns, duration, endedAt, ['Turn times are not available for this saved transcript.'], 'saved')
  }
  throw new AskError('meeting_transcript_unavailable', 404)
}
