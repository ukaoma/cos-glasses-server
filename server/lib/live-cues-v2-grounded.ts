// Live cues v3 grounded retrieval: pure helpers that turn the three retrieval arms (cue_memory.py, the owner's COS notes, and the
// files attached to this meeting) into the candidates the grounded judge sees. Nothing here calls a model, reads a disk or
// logs; live-cues-v2.ts runs the arms and the judge and passes what they returned.
//
// Rules, each from the 2026-11-01 replay and its validation:
//   - self and twin exclusion: a meeting's own filed copy, or its twin's, was in cue_memory's raw top 8 for 579 of 614 windows
//     and rank 1 for 432, so a candidate is dropped when its record is this session or a known twin, or when its text shares
//     at least 15% of its 6-word sequences with what has been said so far;
//   - personal-domain notes stay out of a meeting that is not personal;
//   - one meeting is one candidate however many arms found it (date and normalised title, memory id, record id, file id);
//   - at most M1..M4 from cue_memory, N1 from the notes, F1 from the files, six in all.

import { notesQueryTerms } from './live-cues-v2-notes.js'
import type { MemoryNote } from './live-cues-v2.js'
import type { CueSourceRef } from '../../shared/live-cues-v2.js'

export const GROUNDED_LIMITS = {
  /** Shared 6-word sequences, as a share of the candidate's own, at which it counts as this conversation. */
  selfOverlap: 0.15,
  shingleWords: 6,
  /** cue_memory.py is asked for this many so that exclusions still leave `cueMemoryTop` (the replay's rule). */
  cueMemoryRaw: 8,
  cueMemoryTop: 4,
  notesTop: 1,
  filesTop: 1,
  maxCandidates: 6,
  /** A file passage is at most this long, and so is what the judge reads of it. */
  fileChars: 300,
  /** A passage must share this many of the window's salient words to be offered at all. */
  fileMinTerms: 2,
  fileWindowTerms: 12,
} as const

export type GroundedArm = 'cue_memory' | 'notes' | 'files'
export type GroundedKind = 'meeting' | 'memory' | 'file'
/** A candidate for the judge: the note fields the judge and the writer read, plus where it came from. */
export interface GroundedNote extends MemoryNote { arm: GroundedArm; kind: GroundedKind }

/** The file fields grounded cues read (a MeetingAskFile). */
export interface GroundedFile { id: string; name: string; status: string; text: string }

/** Python's meeting_canonical.normalize_title: lower case, ASCII punctuation to spaces, whitespace collapsed. */
export function normalizeMeetingTitle(title: string): string {
  return title.toLowerCase().replace(/[!-/:-@[-`{-~]/g, ' ').split(/\s+/).filter(Boolean).join(' ')
}

/** Every identity a candidate answers to; two candidates sharing one are the same meeting, memory or file. */
export function candidateIdentities(c: Pick<MemoryNote, 'date' | 'title' | 'recordId' | 'memoryId' | 'fileId'>): string[] {
  const ids: string[] = []
  // A file is dated with the meeting it was attached to and named by its file name; that says nothing about a past meeting.
  if (c.date && c.title && !c.fileId) ids.push(`meeting:${c.date}|${normalizeMeetingTitle(c.title)}`)
  if (c.recordId) ids.push(`record:${c.recordId}`)
  if (c.memoryId) ids.push(`memory:${c.memoryId}`)
  if (c.fileId) ids.push(`file:${c.fileId}`)
  return ids
}

/** The set of 6-word sequences in `text` (lower case, letters, digits and apostrophes). */
export function shingleSet(text: string, n: number = GROUNDED_LIMITS.shingleWords): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? []
  const out = new Set<string>()
  for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '))
  return out
}

/** The share of the candidate's own 6-word sequences that also appear in the transcript so far (0 when it has none). */
export function sixGramOverlap(candidateText: string, transcript: Set<string>): number {
  const own = shingleSet(candidateText)
  if (!own.size) return 0
  let shared = 0
  for (const s of own) if (transcript.has(s)) shared += 1
  return shared / own.size
}

/** Ids that mean "this conversation": the session and its known twins, also in the library's `standalone:` form. */
export function selfIdSet(sessionId: string, twins: Iterable<string> = []): Set<string> {
  const out = new Set<string>()
  for (const id of [sessionId, ...twins]) { out.add(id); out.add(`standalone:${id}`) }
  return out
}

export function isSelfCopy(c: Pick<MemoryNote, 'notes' | 'recordId' | 'sessionId'>, transcript: Set<string>, selfIds: ReadonlySet<string>): boolean {
  if ((c.recordId && selfIds.has(c.recordId)) || (c.sessionId && selfIds.has(c.sessionId))) return true
  return sixGramOverlap(c.notes, transcript) >= GROUNDED_LIMITS.selfOverlap
}

/** A personal-domain note never reaches a meeting that is not personal. An unknown meeting domain counts as not personal. */
export function isForeignPersonal(noteDomain: string | undefined, meetingDomain: string | null): boolean {
  const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase()
  return norm(noteDomain) === 'personal' && norm(meetingDomain) !== 'personal'
}

/** Kind and locator from a retrieved note's key: `memory:<id>` and `meeting:<recordId>` come from the notes arm, anything
 *  else (cue_memory.py's `date|title`, or no key) is a meeting with no record id known. */
function describe(note: MemoryNote, arm: GroundedArm): Omit<GroundedNote, 'id'> {
  const key = note.key ?? ''
  if (key.startsWith('memory:') && key.length > 'memory:'.length) return { ...note, arm, kind: 'memory', memoryId: key.slice('memory:'.length) }
  if (key.startsWith('meeting:') && key.length > 'meeting:'.length) return { ...note, arm, kind: 'meeting', recordId: key.slice('meeting:'.length) }
  return { ...note, arm, kind: 'meeting' }
}

/** Passages of at most `max` characters: blank-line blocks, then sentences, then a hard cut. */
export function passagesOf(text: string, max: number = GROUNDED_LIMITS.fileChars): string[] {
  const out: string[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const flat = block.replace(/\s+/g, ' ').trim()
    if (!flat) continue
    if (flat.length <= max) { out.push(flat); continue }
    let cur = ''
    for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
      if (cur && cur.length + 1 + sentence.length > max) { out.push(cur); cur = '' }
      cur = cur ? `${cur} ${sentence}` : sentence
      while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max) }
    }
    if (cur) out.push(cur)
  }
  return out
}

/** The one file passage that best matches the window, or null. Only `ready` files count (a secret-held file has no text and is
 *  never read, whatever it carries), a passage must share at least fileMinTerms of the window's salient words, and the first
 *  best passage wins a tie. */
export function bestFilePassage(files: GroundedFile[], window: string): { file: GroundedFile; passage: string } | null {
  const terms = notesQueryTerms(window, GROUNDED_LIMITS.fileWindowTerms)
  if (!terms.length) return null
  let best: { file: GroundedFile; passage: string; score: number } | null = null
  for (const file of files) {
    if (file.status !== 'ready' || typeof file.text !== 'string' || !file.text.trim()) continue
    for (const passage of passagesOf(file.text)) {
      const words = new Set(passage.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      const score = terms.reduce((n, t) => n + (words.has(t) ? 1 : 0), 0)
      if (score >= GROUNDED_LIMITS.fileMinTerms && (!best || score > best.score)) best = { file, passage, score }
    }
  }
  return best ? { file: best.file, passage: best.passage } : null
}

export interface GroundedInputs {
  /** cue_memory.py's answer, up to cueMemoryRaw, best first. */
  cueMemory: MemoryNote[]
  /** The owner's COS notes, best first. */
  notes: MemoryNote[]
  files: GroundedFile[]
  /** What has been said so far in this meeting (speaker labels removed). */
  transcript: string
  /** The last part of it: what the room is on now. */
  window: string
  selfIds: ReadonlySet<string>
  /** The confirmed domain of this meeting, or null. */
  meetingDomain: string | null
  /** This meeting's local date (YYYY-MM-DD): a file is dated with the meeting it was attached to. */
  today: string
}

/** The candidates for the judge, in order M1..M4, N1, F1, with ids that keep their kind. `excludedSelf` counts the notes dropped
 *  as this conversation or its twin. Files are the owner's own attachments to this meeting, so the self rule does not apply
 *  to them: a document the room reads from is what a file cue is for. */
export function groundedCandidates(i: GroundedInputs): { candidates: GroundedNote[]; excludedSelf: number } {
  const transcript = shingleSet(i.transcript)
  const seen = new Set<string>()
  const out: GroundedNote[] = []
  let excludedSelf = 0
  const take = (list: MemoryNote[], arm: GroundedArm, limit: number, prefix: string) => {
    let n = 0
    for (const raw of list) {
      if (n >= limit || out.length >= GROUNDED_LIMITS.maxCandidates) return
      const note = describe(raw, arm)
      if (isSelfCopy(note, transcript, i.selfIds)) { excludedSelf += 1; continue }
      if (isForeignPersonal(note.domain, i.meetingDomain)) continue
      const identities = candidateIdentities(note)
      if (identities.some(id => seen.has(id))) continue
      for (const id of identities) seen.add(id)
      n += 1
      out.push({ ...note, id: `${prefix}${n}` })
    }
  }
  take(i.cueMemory, 'cue_memory', GROUNDED_LIMITS.cueMemoryTop, 'M')
  take(i.notes, 'notes', GROUNDED_LIMITS.notesTop, 'N')
  if (out.length < GROUNDED_LIMITS.maxCandidates) {
    const hit = bestFilePassage(i.files, i.window)
    if (hit) {
      out.push({ id: 'F1', date: i.today, title: hit.file.name.replace(/\s+/g, ' ').trim().slice(0, 90), notes: hit.passage, key: `file:${hit.file.id}`,
        arm: 'files', kind: 'file', fileId: hit.file.id })
    }
  }
  return { candidates: out, excludedSelf }
}

/** The cue source for a kept candidate: the opaque id, the date and title as before, and (v3) its kind with its one locator. */
export function groundedSource(note: GroundedNote, id: string): CueSourceRef {
  const base: CueSourceRef = { id, date: note.date, title: note.title, kind: note.kind }
  if (note.kind === 'memory' && note.memoryId) return { ...base, memoryId: note.memoryId }
  if (note.kind === 'file' && note.fileId) return { ...base, fileId: note.fileId }
  if (note.kind === 'meeting' && note.recordId) return { ...base, recordId: note.recordId }
  return base
}
