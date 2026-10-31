// 6.96.3: name several of a saved Mac call's voices at once, with a real batch Undo.
//
// WHY. Suggest names finds voices worth naming; a person reviews the list and confirms. A wrong batch would write
// wrong samples into the same profiles the G2 uses, so the preview and a full Undo are part of the feature.
//
// ONE WRITE PATH. Each label goes through what POST /meeting/:sessionId/relabel does for one voice: relabelSidecarJson
// and relabelMeetingMarkdown over the same copy of the meeting, the same intent/applied ledger rows, then
// planMacVoiceAssignment and commitMacVoiceAssignment with no `force`. renameMeetingSpeaker is deliberately NOT used:
// on real Mac calls its position-based markdown edit resolves almost no turns, because the markdown is not an
// index-parallel rendering of the chunks, so `[Voice N]:` would stay in the transcript while the sidecar said a name.
//
// ALL OR NOTHING BEFORE THE FIRST WRITE, THEN STOP AT THE FIRST REFUSAL. Every item must be a current high-confidence
// suggestion for this session and revision. The flag is trusted as given: `score` is rounded, so it is never
// recomputed here. A restart loses suggestions on purpose, and the answer is to click Suggest names again. The check is
// repeated immediately before each write, because a profile can change during a batch. Suggestions read null once the
// store changes, which this batch's own first commit also does, so from then on the store's stamp and the meeting's
// revision, both taken right after that commit, stand in for it: any write since then that is not ours stops the batch
// as `suggestions_stale`.
//
// JOURNAL. Intent is durable before anything is touched and the outcome after. A process that dies leaves `running`,
// which reads as `interrupted` once no live batch owns it, and Undo works out what landed by inspection. Refusals that
// wrote nothing leave no journal. It holds no transcript words: turn positions and hashes are enough for an exact
// restore, and only an attendee section a step edited is copied, names only. Journals last 30 days, then Undo is gone.
//
// WHICH SAMPLES. The profile store has no sample ids, so a sample is its source plus a sha256 of its vector, taken by
// diffing the profile around the one synchronous commit. `retractEmbeddingsBySource` matches on source alone, and the
// broad session retraction would also remove earlier single namings from this call, which are a person's decisions.
// So Undo finds the exact indices, in the named profile and then in any other a merge moved them to, and passes a
// predicate that walks them in the store's index order and can only match the source recorded at that index. A sample
// no profile holds is reported: `partial`, reason `samples_not_found`, the voice listed there as well as under `reverted`.
//
// EVICTED SAMPLES ARE RESTORED WHEN THAT IS SAFE. A Mac-assigned sample only ever evicts another Mac-assigned one, and
// one label can replace a person's whole Mac allowance, so losing them on Undo would cost earlier decisions. Vectors go
// back through the normal enrolment path, skipping its near-duplicate check, only if nothing would be displaced, the
// profile still exists and that name has not since been moved or taken back in the sample's own meeting, which is what
// stops a sample of an undone batch coming back. Anything else is counted as not restored. A restored sample becomes the
// newest Mac-assigned one, so eviction order is not preserved. A vector leaves the journal once it is restored or can
// never be. One with no room yet, or whose enrolment failed, stays until a later Undo of that name retries it or the
// journal expires, so two overlapping batches end at the same samples in either Undo order.
// forgetMacVoiceNamingPerson scrubs vectors when a person is deleted, including from a batch still in memory.
//
// LATER HUMAN ACTIONS WIN. A label a person changed afterwards is left alone and the batch's samples for it are still
// retracted, because that change says the batch was wrong. A label a person CONFIRMED afterwards keeps its samples too.
//
// THE LEDGER AFTER AN UNDO. `reverted` goes on the applied row's id, and the undo's own intent closes `failed`. That is
// the only shape mac-speaker-shadow-repair's reader accepts, and the ledger is append-only, so anything else would
// block that capture's call view for good.
//
// DRAINS. Planning is read-only and holds no lease. Each write section holds its own `api_mutation` lease and the
// meeting sync lock. isMacVoiceNamingBatchPost is what index.ts needs in order to let the route answer its own refusal.

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Router } from 'express'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { cosOperationsMeetingsConfigured, findCosOperationsMeetingBySessionId, findDirectLibraryMeetingBySessionId } from './cos-operations-meetings.js'
import { dataPath } from './data-dir.js'
import { MAC_ASSIGN_SOURCE, isMacAssign, macAssignCapFor } from './embedding-eviction.js'
import { MAC_CAPTURE_ID } from './mac-recording.js'
import { commitMacVoiceAssignment, planMacVoiceAssignment, type MacAssignInput, type MacAssignPlan, type MacAssignReport } from './mac-voice-assignment.js'
import { isVoiceLabel } from './mac-voice-labels.js'
import { currentVoiceSuggestions, neverSuggested, voiceSuggestionRecordingLease, type VoiceSuggestion } from './mac-voice-suggestions.js'
import { acquireMaintenanceWork, maintenanceAdmissionsOpen } from './maintenance-lifecycle.js'
import { appendCorrection, appliedCorrections, pendingCorrections, readCorrections, type CorrectionRow } from './meeting-corrections.js'
import { relabelMeetingMarkdown, relabelSidecarJson } from './meeting-relabel.js'
import { acquireMeetingSyncLock } from './meeting-sync-lock.js'
import { getOwnerName, getOwnerSpeakerLabel } from './profile.js'
import { MAX_EMBEDDINGS_PER_SPEAKER, enrollEmbedding, readVoiceProfiles, retractEmbeddingsBySource } from './speaker-embeddings.js'
import { assertVoiceEvidenceSource } from './voice-evidence-guard.js'

export const MAC_VOICE_NAMING_BATCH_DIR = 'mac-voice-naming-batches'
const SESSION_ID = /^[A-Za-z0-9:_-]{3,96}$/
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_ITEMS = 99
/** How long a batch can be undone. After this its journal, with any voiceprints and attendee copies in it, is deleted. */
export const MAC_VOICE_NAMING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const FILE_MODE = { mode: 0o600 }
/** Reasons a retry cannot change: the person's action stands. */
const PERMANENT_LEFT = new Set(['label_changed_by_person', 'confirmed_by_person'])

export interface NamingBatchItem { labels: string[]; name: string }
export interface NamingBatchRequest { sourceRevision: string; items: NamingBatchItem[]; confirm?: boolean }
export interface NamedEntry { labels: string[]; name: string; samplesAdded: number }
export interface NotNamedEntry { labels: string[]; name: string; reason: string }
export interface NamingBatchResult {
  batchId: string
  state: 'applied' | 'partial' | 'refused'
  reason?: string
  named: NamedEntry[]
  notNamed: NotNamedEntry[]
  sourceRevision: string
  undoAvailable: boolean
  dryRun?: true
}
export interface NamingBatchUndoResult {
  state: 'undone' | 'partial' | 'refused'
  reason?: string
  reverted: Array<{ labels: string[]; name: string }>
  left: Array<{ labels: string[]; name: string; reason: string }>
  samplesRemoved: number
  /** Samples this batch had evicted that went back, and those that could not. */
  evictedRestored: number
  evictedNotRestored: number
  sourceRevision: string
  dryRun?: true
}
export type NamingBatchListState = 'running' | 'applied' | 'partial' | 'interrupted' | 'undone' | 'undo_partial' | 'unreadable'
export interface NamingBatchListEntry { batchId: string; at: string; state: NamingBatchListState; named: NamedEntry[]; undoAvailable: boolean }

interface SampleId { source: string; hash: string }
interface SampleCopy extends SampleId { embedding: number[] }
interface StepUndo {
  state: 'reverted' | 'left'
  reason?: string
  samplesRemoved: number
  /** Samples this step added that no profile holds any more. */
  samplesNotFound: number
  evictedRestored: number
  /** Evicted samples that can never come back: the person is gone, or the name moved in their meeting. */
  evictedDropped: number
  /** An interrupted step that had changed nothing: done, and not reported as reverted. */
  nothingApplied?: boolean
}
interface Step {
  itemIndex: number
  label: string
  name: string
  /** `intent` left on disk means the process died inside this step. `refused` wrote nothing. */
  state: 'intent' | 'named' | 'failed' | 'refused'
  at: string
  correctionId: string
  changed: number[]
  /** Null when this step did not rewrite the markdown. */
  markdownBeforeHash: string | null
  attendeeEdits: number
  /** The section's body, only when this step edited it. Names, never words. */
  attendeesBefore: string | null
  attendeesAfterHash: string | null
  turnCount: number
  /** Which `[Name]:` turns, by order in the transcript, this step rewrote. */
  turns: number[]
  source: string
  planned: string[]
  before: string[]
  /** Candidates for eviction, kept only until the commit reports what really left. */
  macBefore?: SampleCopy[]
  added: SampleId[]
  evicted: SampleCopy[]
  /** Set once Undo has worked out `added` and `evicted` for a step that died before its journal said. */
  effectsKnown?: boolean
  retractStarted?: boolean
  evictedForgotten?: number
  samplesAdded: number
  undo?: StepUndo
}
interface Journal {
  version: 1
  batchId: string
  sessionId: string
  at: string
  state: 'running' | 'applied' | 'partial' | 'undone' | 'undo_partial'
  sourceRevisionBefore: string
  items: NamingBatchItem[]
  steps: Step[]
}

type Refusal = { status: number; body: Record<string, unknown> } | null

export interface NamingBatchDeps {
  store: { findBySessionId(sessionId: string): { sidecarPath: string; filepath: string } | null }
  captureActive: () => boolean
  reviewRevision: (meetingPath: string, sidecarPath: string) => string
  callViewMutationRefusal: (sessionId: string) => Refusal
  finalizingRefusal: (sessionId: string) => Refusal
  /** Everything below defaults to the real thing; tests override single seams. */
  suggestions?: (sessionId: string) => { sourceRevision: string; suggestions: VoiceSuggestion[] } | null
  recordingLease?: () => boolean
  admissionsOpen?: () => boolean
  acquireLock?: () => Promise<{ release: () => void }>
  acquireWork?: () => { release: () => void }
  plan?: (input: MacAssignInput) => Promise<MacAssignPlan>
  commit?: (sessionId: string, plan: MacAssignPlan) => MacAssignReport
  log?: (line: string) => void
}

// ── Samples ──────────────────────────────────────────────────────────────────

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
/** Stored rows are the float32 values as JSON doubles, so this hash survives the trip through the store. */
const vectorHash = (vector: ArrayLike<number>): string => createHash('sha256').update(Buffer.from(Float32Array.from(vector).buffer)).digest('hex')
const sampleKey = (sample: SampleId): string => `${sample.source}#${sample.hash}`

function profileSamples(name: string): SampleCopy[] | null {
  const profile = readVoiceProfiles().profiles.find(p => p.name === name)
  return profile ? profile.embeddings.map((embedding, i) => ({ source: profile.sources?.[i] ?? 'unknown', hash: vectorHash(embedding), embedding })) : null
}

/** `a` minus `b` as multisets, keeping `a`'s order. */
function subtractSamples<T extends SampleId>(a: T[], b: string[]): T[] {
  const left = new Map<string, number>()
  for (const key of b) left.set(key, (left.get(key) ?? 0) + 1)
  return a.filter(sample => {
    const key = sampleKey(sample)
    const count = left.get(key) ?? 0
    if (count === 0) return true
    left.set(key, count - 1)
    return false
  })
}

/**
 * Where these identities are now, by profile and index: the named profile first, then every other one, because a later
 * merge moves samples with their source intact. `notFound` counts what no profile holds.
 */
function locateSamples(name: string, ids: SampleId[]): { found: Array<{ owner: string; samples: SampleCopy[]; drop: Set<number> }>; notFound: number } {
  const wanted = new Map<string, number>()
  for (const id of ids) wanted.set(sampleKey(id), (wanted.get(sampleKey(id)) ?? 0) + 1)
  let notFound = ids.length
  const found: Array<{ owner: string; samples: SampleCopy[]; drop: Set<number> }> = []
  if (ids.length === 0) return { found, notFound }
  const owners = [name, ...readVoiceProfiles().profiles.map(p => p.name).filter(owner => owner !== name)]
  for (const owner of owners) {
    if (notFound === 0) break
    const samples = profileSamples(owner) ?? []
    const drop = new Set<number>()
    samples.forEach((sample, i) => {
      const count = wanted.get(sampleKey(sample)) ?? 0
      if (count === 0) return
      drop.add(i)
      wanted.set(sampleKey(sample), count - 1)
      notFound--
    })
    if (drop.size > 0) found.push({ owner, samples, drop })
  }
  return { found, notFound }
}

/** Exactly these identities, wherever they are now. Runs without awaiting, so the indices cannot go stale. */
function retractSamples(name: string, ids: SampleId[]): { removed: number; notFound: number } {
  const { found, notFound } = locateSamples(name, ids)
  let removed = 0
  for (const { owner, samples, drop } of found) {
    let index = 0
    const out = retractEmbeddingsBySource(owner, source => {
      const at = index++
      return drop.has(at) && samples[at].source === source
    })
    removed += out.removed
    if (out.removed !== drop.size) throw new Error(`removed ${out.removed} of ${drop.size} samples from one profile`)
  }
  return { removed, notFound }
}

/** True when `enrollEmbedding` would make room by dropping something. Mirrors its makeRoomForSample. */
function wouldDisplace(samples: SampleCopy[]): boolean {
  const macCount = samples.filter(s => isMacAssign(s.source)).length
  return samples.length >= MAX_EMBEDDINGS_PER_SPEAKER || macCount >= macAssignCapFor(samples.length, macCount)
}

/**
 * Has that name been taken back or moved in the meeting this sample came from, since this step? A `reverted` row counts:
 * a sample from a batch that was undone after it was evicted must not come back. `own` is this journal's corrections,
 * whose rows say nothing about a person.
 */
function nameMovedInItsMeeting(sample: SampleId, step: Step, own: Set<string>): boolean {
  // A Mac-assigned sample only ever evicts another Mac-assigned one, so every evicted source names its meeting.
  const session = sample.source.slice(MAC_ASSIGN_SOURCE.length + 1)
  const later = (row: CorrectionRow) => !own.has(row.id) && row.from === step.name && row.at >= step.at
  return appliedCorrections(session).some(later) || readCorrections(session).rows.some(row => row.phase === 'reverted' && later(row))
}

/** One pass. `keep` is what another pass could still restore: no room yet, or enrolment failed. `dropped` is final. */
function restoreEvicted(step: Step, evicted: SampleCopy[], own: Set<string>): { restored: number; dropped: number; keep: SampleCopy[]; enrolFailed: boolean } {
  const out = { restored: 0, dropped: 0, keep: [] as SampleCopy[], enrolFailed: false }
  for (const sample of evicted) {
    const samples = profileSamples(step.name)
    if (samples?.some(s => sampleKey(s) === sampleKey(sample))) continue
    if (!samples || nameMovedInItsMeeting(sample, step, own)) { out.dropped++; continue }
    if (wouldDisplace(samples)) { out.keep.push(sample); continue }
    if (enrollEmbedding(step.name, Float32Array.from(sample.embedding), sample.source, true).success) out.restored++
    else { out.keep.push(sample); out.enrolFailed = true }
  }
  return out
}

/** What this step did to the profile. A step that died inside its commit is worked out from what is there now. */
function sampleEffects(step: Step): { added: SampleId[]; evicted: SampleCopy[] } {
  if (step.state === 'named' || step.effectsKnown) return { added: step.added, evicted: step.evicted }
  const current = profileSamples(step.name) ?? []
  const planned = new Set(step.planned)
  const added = subtractSamples(current.filter(s => s.source === step.source && planned.has(s.hash)), step.before)
  // No added sample means the commit never ran, so a missing sample left for some other reason.
  const evicted = added.length > 0 ? subtractSamples(step.macBefore ?? [], current.map(sampleKey)) : []
  return { added: added.map(({ source, hash }) => ({ source, hash })), evicted }
}

// ── Journal ──────────────────────────────────────────────────────────────────

const sessionFolder = (sessionId: string): string => dataPath(MAC_VOICE_NAMING_BATCH_DIR, sessionId.replace(/:/g, '_'))
const journalPath = (sessionId: string, batchId: string): string => join(sessionFolder(sessionId), `${batchId}.json`)

/** Names deleted in this process, and when. A batch still in memory must not write their voiceprints back. */
const forgotten = new Map<string, string>()

/** Drops what a person's deletion must not leave behind. Returns the number of voiceprints dropped. */
function scrubForName(step: Step, name: string): number {
  if (step.attendeesBefore?.includes(name)) step.attendeesBefore = null
  if (step.name !== name) return 0
  const vectors = step.evicted.length + (step.macBefore?.length ?? 0)
  step.evictedForgotten = (step.evictedForgotten ?? 0) + step.evicted.length
  step.evicted = []
  delete step.macBefore
  return vectors
}

function writeJournal(journal: Journal): void {
  for (const step of journal.steps) {
    for (const [name, at] of forgotten) if (step.at <= at) scrubForName(step, name)
  }
  const path = journalPath(journal.sessionId, journal.batchId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(path, `${JSON.stringify(journal)}\n`, FILE_MODE)
}

function isExpired(path: string, now = Date.now()): boolean {
  try { return now - statSync(path).mtimeMs > MAC_VOICE_NAMING_RETENTION_MS } catch { return false }
}

/** `missing` covers a journal past retention: it no longer exists as far as anyone is told. */
function loadJournal(sessionId: string, batchId: string): Journal | 'missing' | 'unreadable' {
  const path = journalPath(sessionId, batchId)
  if (isExpired(path)) return 'missing'
  let text: string
  try { text = readFileSync(path, 'utf-8') } catch { return 'missing' }
  try {
    const parsed = JSON.parse(text) as Journal
    return parsed?.version === 1 && parsed.sessionId === sessionId && parsed.batchId === batchId && Array.isArray(parsed.steps) ? parsed : 'unreadable'
  } catch { return 'unreadable' }
}

/** Every journal on disk, as paths. */
function journalFiles(): Array<{ session: string; batchId: string; path: string }> {
  const out: Array<{ session: string; batchId: string; path: string }> = []
  let folders: string[] = []
  try { folders = readdirSync(dataPath(MAC_VOICE_NAMING_BATCH_DIR)) } catch { return out }
  for (const session of folders) {
    let files: string[] = []
    try { files = readdirSync(dataPath(MAC_VOICE_NAMING_BATCH_DIR, session)) } catch { continue }
    for (const file of files) {
      const batchId = file.replace(/\.json$/, '')
      if (BATCH_ID.test(batchId)) out.push({ session, batchId, path: dataPath(MAC_VOICE_NAMING_BATCH_DIR, session, file) })
    }
  }
  return out
}

/** Undo is offered for the retention window, and the voiceprints and attendee copies go with the journal after it. */
function pruneExpiredJournals(): void {
  for (const { path } of journalFiles()) {
    if (isExpired(path)) { try { unlinkSync(path) } catch { /* the next pass tries again */ } }
  }
}

/** Person deleted: drop the voiceprints journals hold for them. Their count stays, reported as not restored. */
export function forgetMacVoiceNamingPerson(name: string): { batches: number; vectors: number } {
  forgotten.set(name, new Date().toISOString())
  const out = { batches: 0, vectors: 0 }
  for (const { path } of journalFiles()) {
    let journal: Journal
    try { journal = JSON.parse(readFileSync(path, 'utf-8')) as Journal } catch { continue }
    const before = JSON.stringify(journal)
    let vectors = 0
    for (const step of journal.steps ?? []) vectors += scrubForName(step, name)
    if (JSON.stringify(journal) === before) continue
    writeJournal(journal)
    out.batches++
    out.vectors += vectors
  }
  return out
}

// ── Markdown ─────────────────────────────────────────────────────────────────

const TURN = /^\[[^\]\r\n]+\]:/

/** Line numbers of `[Name]:` turns in the Transcript section, which is what relabelMeetingMarkdown rewrites. */
function transcriptTurnLines(lines: string[]): number[] {
  const out: number[] = []
  let inside = false
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) inside = /^##\s+Transcript\s*$/.test(lines[i])
    else if (inside && TURN.test(lines[i])) out.push(i)
  }
  return out
}

/** The Attendees section's body, as relabelMeetingMarkdown bounds it. Null when there is none. */
function attendeeRange(md: string): { start: number; end: number } | null {
  const heading = /^##\s+Attendees\s*$/m.exec(md)
  if (!heading) return null
  const start = heading.index + heading[0].length
  const next = /^##\s+/m.exec(md.slice(start))
  return { start, end: next ? start + next.index : md.length }
}

/**
 * The markdown with this step's edits taken back, or null when that cannot be done honestly. The journal keeps no words:
 * turn order finds the turns and the attendee section is names only, which restores the exact bytes when nothing else
 * has changed. Turn order and not turn text, because undoSpeakerMarkdown refuses a turn whose words repeat, and "Yeah." repeats on
 * every real call.
 */
function revertedMarkdown(current: string, step: Step): string | null {
  if (step.markdownBeforeHash === null) return current
  if (sha256(current) === step.markdownBeforeHash) return current
  const lines = current.split('\n')
  const turns = transcriptTurnLines(lines)
  if (turns.length !== step.turnCount) return null
  const from = `[${step.name}]:`
  const to = `[${step.label}]:`
  for (const ordinal of step.turns) {
    const line = lines[turns[ordinal]]
    if (line.startsWith(to)) continue
    if (!line.startsWith(from)) return null
    lines[turns[ordinal]] = to + line.slice(from.length)
  }
  const next = lines.join('\n')
  if (step.attendeeEdits === 0) return next
  const range = attendeeRange(next)
  if (!range || step.attendeesBefore === null || sha256(next.slice(range.start, range.end)) !== step.attendeesAfterHash) return null
  return next.slice(0, range.start) + step.attendeesBefore + next.slice(range.end)
}

// ── The batch ────────────────────────────────────────────────────────────────

const sameLabels = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
const readText = (path: string): string | null => { try { return readFileSync(path, 'utf-8') } catch { return null } }
const yieldToLoop = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })
/** Every store write is an atomic rename, so any write by anyone changes this. */
function profileStoreStamp(): string {
  try { const info = statSync(dataPath('voice-profiles.json')); return `${info.ino}:${info.size}:${info.mtimeMs}` } catch { return 'missing' }
}
const itemIsSuggested = (current: { suggestions: VoiceSuggestion[] }, item: NamingBatchItem): boolean => current.suggestions.find(s => s.name === item.name && sameLabels(s.labels, item.labels))?.highConfidence === true

/** One batch or Undo per session at a time, in this process. The value is the journal it is writing, once it has one. */
const active = new Map<string, string | null>()

function isOwnerName(name: string): boolean {
  let label: string | undefined
  let owner: string | undefined
  try { label = getOwnerSpeakerLabel() } catch { /* MU is still refused */ }
  try { owner = getOwnerName() } catch { /* MU is still refused */ }
  return neverSuggested(name, label) || neverSuggested(name, owner)
}

function namedEntries(journal: Journal): NamedEntry[] {
  const byItem = new Map<number, NamedEntry>()
  for (const step of journal.steps) {
    if (step.state !== 'named') continue
    const entry = byItem.get(step.itemIndex) ?? { labels: [], name: step.name, samplesAdded: 0 }
    entry.labels.push(step.label)
    entry.samplesAdded += step.samplesAdded
    byItem.set(step.itemIndex, entry)
  }
  return [...byItem.values()]
}

function journalUndoAvailable(journal: Journal): boolean {
  if (active.get(journal.sessionId) === journal.batchId) return false
  return journal.steps.some(step => step.state !== 'refused' && step.undo?.state !== 'reverted' && !(step.undo?.state === 'left' && PERMANENT_LEFT.has(step.undo.reason ?? '')))
}

function listState(journal: Journal): NamingBatchListState {
  return journal.state === 'running' && active.get(journal.sessionId) !== journal.batchId ? 'interrupted' : journal.state
}

/** The attendee section before and the hash after, when a step edited it. */
function attendeeCopies(before: string | null, after: string | null): { attendeesBefore: string | null; attendeesAfterHash: string | null } {
  const beforeRange = before === null ? null : attendeeRange(before)
  const afterRange = after === null ? null : attendeeRange(after)
  if (before === null || after === null || !beforeRange || !afterRange) return { attendeesBefore: null, attendeesAfterHash: null }
  return { attendeesBefore: before.slice(beforeRange.start, beforeRange.end), attendeesAfterHash: sha256(after.slice(afterRange.start, afterRange.end)) }
}

export interface MacVoiceNamingBatches {
  run(sessionId: string, request: NamingBatchRequest): Promise<NamingBatchResult>
  undo(sessionId: string, batchId: string, confirm: boolean): Promise<NamingBatchUndoResult>
  list(sessionId: string): { batches: NamingBatchListEntry[] }
}

export function createMacVoiceNamingBatches(deps: NamingBatchDeps): MacVoiceNamingBatches {
  const suggestions = deps.suggestions ?? currentVoiceSuggestions
  const recordingLease = deps.recordingLease ?? (() => voiceSuggestionRecordingLease())
  const admissionsOpen = deps.admissionsOpen ?? maintenanceAdmissionsOpen
  const acquireLock = deps.acquireLock ?? acquireMeetingSyncLock
  const acquireWork = deps.acquireWork ?? (() => acquireMaintenanceWork('api_mutation'))
  const plan = deps.plan ?? planMacVoiceAssignment
  const commit = deps.commit ?? commitMacVoiceAssignment
  const log = deps.log ?? ((line: string) => console.log(`[mac-naming-batch] ${line}`))

  /** The same copy of the meeting relabel writes: operations first, read-only libraries refused. */
  function resolveMeeting(sessionId: string): { refused: string } | { sidecarPath: string; meetingPath: string } {
    if (assertVoiceEvidenceSource([sessionId]) || !MAC_CAPTURE_ID.test(sessionId)) return { refused: 'not_saved_mac_capture' }
    const operations = cosOperationsMeetingsConfigured() ? findCosOperationsMeetingBySessionId(sessionId) : null
    if (operations?.mergedScribeConflict?.length) return { refused: 'record_source_mismatch' }
    if (operations) return { sidecarPath: operations.sidecarPath, meetingPath: operations.meetingPath }
    if (findDirectLibraryMeetingBySessionId(sessionId)) return { refused: 'direct_library_read_only' }
    const saved = deps.store.findBySessionId(sessionId)
    return saved ? { sidecarPath: saved.sidecarPath, meetingPath: saved.filepath } : { refused: 'not_saved_mac_capture' }
  }

  function blockReason(sessionId: string): string | null {
    if (deps.captureActive() || recordingLease()) return 'recording_active'
    if (!admissionsOpen()) return 'maintenance'
    if (deps.finalizingRefusal(sessionId)) return 'meeting_finalizing'
    const view = deps.callViewMutationRefusal(sessionId)
    return view ? String(view.body.reason ?? 'derived_call_view') : null
  }

  /** Whole-batch checks. Writes nothing and awaits nothing. */
  function preflight(sessionId: string, request: NamingBatchRequest, meeting: { sidecarPath: string; meetingPath: string }, revision: string): { reason: string; item?: number } | { sidecar: string } {
    const blocked = blockReason(sessionId)
    if (blocked) return { reason: blocked }
    if (pendingCorrections(sessionId).length > 0) return { reason: 'correction_pending' }
    const seen = new Set<string>()
    for (const [item, { labels, name }] of request.items.entries()) {
      if (isOwnerName(name)) return { reason: 'owner_refused', item }
      for (const label of labels) {
        if (!isVoiceLabel(label)) return { reason: 'label_not_anonymous', item }
        if (seen.has(label)) return { reason: 'duplicate_label', item }
        seen.add(label)
      }
    }
    const current = suggestions(sessionId)
    if (!current || current.sourceRevision !== request.sourceRevision || current.sourceRevision !== revision) return { reason: 'suggestions_stale' }
    for (const [index, item] of request.items.entries()) {
      if (!itemIsSuggested(current, item)) return { reason: 'not_high_confidence', item: index }
    }
    const sidecar = readText(meeting.sidecarPath)
    if (sidecar === null) return { reason: 'sidecar_unreadable' }
    let carried: Set<unknown>
    try {
      const rows = (JSON.parse(sidecar) as { chunks?: unknown }).chunks
      if (!Array.isArray(rows)) return { reason: 'sidecar_unreadable' }
      carried = new Set(rows.map(row => (row as { speaker?: unknown } | null)?.speaker))
    } catch { return { reason: 'sidecar_unreadable' } }
    for (const [item, { labels }] of request.items.entries()) {
      if (labels.some(label => !carried.has(label))) return { reason: 'label_not_anonymous', item }
    }
    return { sidecar }
  }

  async function run(sessionId: string, request: NamingBatchRequest): Promise<NamingBatchResult> {
    const confirm = request.confirm === true
    const base = (reason: string, notNamed: NotNamedEntry[], sourceRevision: string): NamingBatchResult => ({
      batchId: '', state: 'refused', reason, named: [], notNamed, sourceRevision, undoAvailable: false, ...(confirm ? {} : { dryRun: true as const }),
    })
    const allRefused = (reason: string, item?: number): NotNamedEntry[] => request.items.map((entry, i) => ({ labels: entry.labels, name: entry.name, reason: item === undefined || item === i ? reason : 'not_attempted' }))
    const meeting = resolveMeeting(sessionId)
    if ('refused' in meeting) return base(meeting.refused, allRefused(meeting.refused), '')
    const { sidecarPath, meetingPath } = meeting
    const revision = (): string => deps.reviewRevision(meetingPath, sidecarPath)
    const before = revision()
    if (active.has(sessionId)) return base('batch_running', allRefused('batch_running'), before)
    const checked = preflight(sessionId, request, meeting, before)
    if ('reason' in checked) return base(checked.reason, allRefused(checked.reason, checked.item), before)

    if (confirm) pruneExpiredJournals()
    active.set(sessionId, null)
    const batchId = randomUUID()
    let journal = null as Journal | null
    let expected = { sidecar: checked.sidecar, markdown: readText(meetingPath) }
    /** What this batch left, after its last commit. Null until it has written anything. */
    let own = null as { store: string; revision: string } | null
    const wouldName = new Map<number, NamedEntry>()
    const moved = (): boolean => readText(sidecarPath) !== expected.sidecar || readText(meetingPath) !== expected.markdown

    /** One label through the normal path. `named` is true when the label landed, even if the samples then failed. */
    const nameLabel = async (itemIndex: number, item: NamingBatchItem, label: string): Promise<{ named: boolean; stop: string | null }> => {
      const { name } = item
      const refuse = (stop: string) => ({ named: false, stop })
      const blocked = blockReason(sessionId)
      if (blocked) return refuse(blocked)
      const rename = relabelSidecarJson(expected.sidecar, label, name, [])
      if (!rename.ok) return refuse('label_not_anonymous')
      const ownerLabel = getOwnerSpeakerLabel()
      const assignment = await plan({ sessionId, from: label, to: name, changed: rename.value.changed, sidecar: JSON.parse(expected.sidecar) as Record<string, unknown>, ownerLabel })
      if (assignment.report.skipped !== null) return refuse(assignment.report.skipped)
      if (assignment.report.gates.length > 0) return refuse(assignment.report.gates[0])
      if (!confirm) {
        const entry = wouldName.get(itemIndex) ?? { labels: [], name, samplesAdded: 0 }
        entry.labels.push(label)
        entry.samplesAdded += assignment.report.enrolled
        wouldName.set(itemIndex, entry)
        return { named: true, stop: null }
      }
      let work: { release: () => void }
      try { work = acquireWork() } catch { return refuse('maintenance') }
      let lock: { release: () => void } | undefined
      try {
        try { lock = await acquireLock() } catch { return refuse('sync_running') }
        // The plan yielded and the lock waited, so anything may have started or moved by now.
        const blockedAtLock = blockReason(sessionId)
        if (blockedAtLock) return refuse(blockedAtLock)
        if (pendingCorrections(sessionId).length > 0) return refuse('correction_pending')
        if (moved()) return refuse('meeting_changed')
        if (own === null) {
          const current = suggestions(sessionId)
          if (!current || current.sourceRevision !== revision() || !itemIsSuggested(current, item)) return refuse('suggestions_stale')
        } else if (profileStoreStamp() !== own.store || revision() !== own.revision) return refuse('suggestions_stale')
        // From here to the release nothing awaits, so the profile diff below is exactly the commit.
        const md = expected.markdown === null ? null : relabelMeetingMarkdown(expected.markdown, label, name)
        const edit = md?.ok ? md.value : null
        const rewrites = !!edit && (edit.attendees > 0 || edit.transcript > 0)
        const lines = expected.markdown?.split('\n') ?? []
        const turnLines = transcriptTurnLines(lines)
        const at = new Date().toISOString()
        const correctionId = `${sessionId}:${label}>${name}:${Date.now().toString(36)}`
        const samplesBefore = profileSamples(name) ?? []
        const source = `${MAC_ASSIGN_SOURCE}:${sessionId}`
        const step: Step = {
          itemIndex, label, name, state: 'intent', at, correctionId, changed: rename.value.changed,
          markdownBeforeHash: rewrites && expected.markdown !== null ? sha256(expected.markdown) : null,
          attendeeEdits: edit?.attendees ?? 0,
          ...attendeeCopies(expected.markdown, edit?.attendees ? edit.markdown : null),
          turnCount: turnLines.length,
          turns: turnLines.flatMap((line, ordinal) => (lines[line].startsWith(`[${label}]:`) ? [ordinal] : [])),
          source,
          planned: assignment.selected.map(vectorHash),
          before: samplesBefore.map(sampleKey),
          macBefore: samplesBefore.filter(sample => isMacAssign(sample.source)),
          added: [], evicted: [], samplesAdded: 0,
        }
        const opened: Journal = journal ?? { version: 1, batchId, sessionId, at, state: 'running', sourceRevisionBefore: before, items: request.items, steps: [] }
        opened.steps.push(step)
        active.set(sessionId, batchId)
        try { writeJournal(opened) } catch (error) {
          opened.steps.pop()
          log(`journal not writable, stopping ${batchId}: ${String(error)}`)
          return refuse('journal_unwritable')
        }
        journal = opened
        const row: CorrectionRow = { id: correctionId, phase: 'intent', at, from: label, to: name, chunks: rename.value.changed, scope: 'meeting', source: `mac-naming-batch:${batchId}` }
        if (!appendCorrection(sessionId, row)) {
          step.state = 'refused'
          writeJournal(opened)
          return refuse('ledger_unwritable')
        }
        try {
          durableAtomicWriteFileSync(sidecarPath, rename.value.json, FILE_MODE)
          if (rewrites && edit) durableAtomicWriteFileSync(meetingPath, edit.markdown, FILE_MODE)
        } catch (error) {
          appendCorrection(sessionId, { ...row, phase: 'failed', at: new Date().toISOString(), error: String(error) })
          step.state = 'failed'
          writeJournal(opened)
          return refuse('write_failed')
        }
        appendCorrection(sessionId, { ...row, phase: 'applied', at: new Date().toISOString(), surfaces: { sidecar: rename.value.changed.length, attendees: edit?.attendees ?? 0, transcript: edit?.transcript ?? 0 }, proseStale: edit?.proseStale ?? false })
        expected = { sidecar: rename.value.json, markdown: rewrites && edit ? edit.markdown : expected.markdown }
        const report = commit(sessionId, assignment)
        own = { store: profileStoreStamp(), revision: revision() }
        const samplesAfter = profileSamples(name) ?? []
        step.added = subtractSamples(samplesAfter, samplesBefore.map(sampleKey)).map(({ source: s, hash }) => ({ source: s, hash }))
        step.evicted = subtractSamples(samplesBefore, samplesAfter.map(sampleKey))
        step.samplesAdded = step.added.length
        step.state = 'named'
        delete step.macBefore
        writeJournal(opened)
        return { named: true, stop: report.skipped }
      } finally {
        lock?.release()
        work.release()
      }
    }

    const notNamedByItem = new Map<string, NotNamedEntry>()
    const noteNotNamed = (itemIndex: number, label: string, name: string, reason: string): void => {
      const key = `${itemIndex}|${reason}`
      const entry = notNamedByItem.get(key) ?? { labels: [], name, reason }
      entry.labels.push(label)
      notNamedByItem.set(key, entry)
    }
    let stop: string | null = null
    try {
      for (const [itemIndex, item] of request.items.entries()) {
        for (const label of item.labels) {
          if (stop) { noteNotNamed(itemIndex, label, item.name, 'not_attempted'); continue }
          const outcome = await nameLabel(itemIndex, item, label)
          stop = outcome.stop
          if (!outcome.named) noteNotNamed(itemIndex, label, item.name, outcome.stop ?? 'not_named')
        }
      }
      if (journal) {
        const finished: Journal = journal
        finished.state = stop ? 'partial' : 'applied'
        writeJournal(finished)
      }
    } catch (error) {
      // Same outcome as a process dying here: nothing more is written, the journal stays `running`, and it reads
      // `interrupted` once this batch lets go of the session.
      log(`interrupted ${batchId}: ${error instanceof Error ? error.message : String(error)}`)
      stop = 'interrupted'
    } finally {
      active.delete(sessionId)
    }
    const landed = journal
    const named = landed ? namedEntries(landed) : [...wouldName.values()]
    // A label that never reached a verdict because the batch died mid-item stays unnamed like the rest.
    if (stop === 'interrupted') {
      const done = new Set(named.flatMap(entry => entry.labels))
      const listed = new Set([...notNamedByItem.values()].flatMap(entry => entry.labels))
      for (const [itemIndex, item] of request.items.entries()) for (const label of item.labels) if (!done.has(label) && !listed.has(label)) noteNotNamed(itemIndex, label, item.name, 'interrupted')
    }
    const notNamed = [...notNamedByItem.values()]
    return {
      batchId: landed ? batchId : '',
      state: named.length === 0 && !landed?.steps.some(step => step.state !== 'refused') ? 'refused' : stop ? 'partial' : 'applied',
      ...(stop ? { reason: stop } : {}),
      named,
      notNamed,
      sourceRevision: revision(),
      undoAvailable: !!landed && journalUndoAvailable(landed),
      ...(confirm ? {} : { dryRun: true as const }),
    }
  }

  // ── Undo ───────────────────────────────────────────────────────────────────

  type Verdict = 'confirmed_by_person' | 'label_changed_by_person' | 'applied' | 'not_applied'

  function verdictFor(step: Step, own: Set<string>, rows: CorrectionRow[], doc: Record<string, unknown>): Verdict {
    const revoked = new Set(rows.filter(r => r.phase === 'reverted').map(r => r.batchId ?? r.id))
    const later = rows.filter(r => !own.has(r.id) && !revoked.has(r.batchId ?? r.id) && r.at >= step.at)
    const overlaps = (r: CorrectionRow) => r.chunks.some(i => step.changed.includes(i))
    if (later.some(r => (r.phase === 'confirmed' || r.phase === 'confirmed-chunks') && r.to === step.name && (r.chunks.length === 0 || overlaps(r)))) return 'confirmed_by_person'
    if (later.some(r => r.phase === 'applied' && overlaps(r))) return 'label_changed_by_person'
    const chunks = Array.isArray(doc.chunks) ? doc.chunks as Array<{ speaker?: unknown } | null> : []
    const speakers = step.changed.map(i => chunks[i]?.speaker)
    if (speakers.every(speaker => speaker === step.name)) return 'applied'
    return speakers.every(speaker => speaker === step.label) ? 'not_applied' : 'label_changed_by_person'
  }

  /** Puts one step's label back: markdown, then sidecar, so a crash can never leave the sidecar reverted alone. */
  function revertLabel(sessionId: string, batchId: string, step: Step, meeting: { sidecarPath: string; meetingPath: string }, sidecar: string): string | null {
    const markdown = readText(meeting.meetingPath)
    const nextMarkdown = markdown === null ? null : revertedMarkdown(markdown, step)
    if (step.markdownBeforeHash !== null && nextMarkdown === null) return 'transcript_changed'
    const inverse = relabelSidecarJson(sidecar, step.name, step.label, step.changed)
    if (!inverse.ok) return 'label_changed_by_person'
    const row: CorrectionRow = { id: `${step.correctionId}:undo:${Date.now().toString(36)}`, phase: 'intent', at: new Date().toISOString(), from: step.name, to: step.label, chunks: step.changed, scope: 'meeting', source: `mac-naming-batch-undo:${batchId}` }
    if (!appendCorrection(sessionId, row)) return 'ledger_unwritable'
    try {
      if (nextMarkdown !== null && nextMarkdown !== markdown) durableAtomicWriteFileSync(meeting.meetingPath, nextMarkdown, FILE_MODE)
      durableAtomicWriteFileSync(meeting.sidecarPath, inverse.value.json, FILE_MODE)
    } catch (error) {
      appendCorrection(sessionId, { ...row, phase: 'failed', at: new Date().toISOString(), error: String(error) })
      return 'write_failed'
    }
    return null
  }

  /**
   * The ledger's half of a revert. `reverted` goes on the applied row's own id, whenever one still counts, so a retry
   * after a crash finishes the job: that id is what appliedCorrections and the repair reader key on, and the undo's own
   * intent closes `failed` because an intent may only be followed by applied or failed. Null when all of it landed.
   */
  function recordRevert(sessionId: string, batchId: string, step: Step): string | null {
    if (!appliedCorrections(sessionId).some(row => row.id === step.correctionId)) return null
    const row: CorrectionRow = { id: step.correctionId, phase: 'reverted', at: new Date().toISOString(), from: step.name, to: step.label, chunks: step.changed, scope: 'meeting', source: `mac-naming-batch-undo:${batchId}` }
    return appendCorrection(sessionId, row) ? null : 'ledger_unwritable'
  }

  function closeOwnIntents(sessionId: string, step: Step): string | null {
    let reason: string | null = null
    for (const open of pendingCorrections(sessionId)) {
      if (open.id !== step.correctionId && !open.id.startsWith(`${step.correctionId}:undo:`)) continue
      if (!appendCorrection(sessionId, { ...open, phase: 'failed', at: new Date().toISOString(), error: 'closed by batch undo' })) reason = 'ledger_unwritable'
    }
    return reason
  }

  function undoStep(journal: Journal, step: Step, meeting: { sidecarPath: string; meetingPath: string }): StepUndo {
    const { sessionId, batchId } = journal
    const own = new Set(journal.steps.map(s => s.correctionId))
    const prior = step.undo
    const totals = (state: StepUndo['state'], extra: { removed?: number; restored?: number; dropped?: number; notFound?: number; reason?: string | null; nothingApplied?: boolean } = {}): StepUndo => ({
      state,
      ...(extra.reason ? { reason: extra.reason } : {}),
      samplesRemoved: (prior?.samplesRemoved ?? 0) + (extra.removed ?? 0),
      samplesNotFound: (prior?.samplesNotFound ?? 0) + (extra.notFound ?? 0),
      evictedRestored: (prior?.evictedRestored ?? 0) + (extra.restored ?? 0),
      evictedDropped: (prior?.evictedDropped ?? 0) + (extra.dropped ?? 0),
      ...(extra.nothingApplied ? { nothingApplied: true } : {}),
    })
    const sidecar = readText(meeting.sidecarPath)
    let doc: Record<string, unknown>
    try { doc = JSON.parse(sidecar ?? '') as Record<string, unknown> } catch { return totals('left', { reason: 'sidecar_unreadable' }) }
    const verdict = verdictFor(step, own, readCorrections(sessionId).rows, doc)
    if (verdict === 'confirmed_by_person') {
      // The name and its samples stand, so what they evicted stays out. Nothing is kept for a restore that cannot happen.
      const dropped = sampleEffects(step).evicted.length
      step.added = []
      step.evicted = []
      step.effectsKnown = true
      delete step.macBefore
      step.attendeesBefore = null
      const closing = closeOwnIntents(sessionId, step)
      return totals('left', { reason: closing ?? verdict, dropped })
    }
    let reason: string | null = verdict === 'label_changed_by_person' ? verdict : null
    if (verdict === 'applied') reason = revertLabel(sessionId, batchId, step, meeting, sidecar ?? '')
    if (reason === null) reason = recordRevert(sessionId, batchId, step)
    reason = closeOwnIntents(sessionId, step) ?? reason
    let removed = 0
    let notFound = 0
    let restored = 0
    let dropped = 0
    try {
      const effects = sampleEffects(step)
      step.effectsKnown = true
      step.evicted = effects.evicted
      step.added = effects.added
      // Durable before the store changes: a retry after a crash here must not report its own retraction as missing.
      const retrying = step.retractStarted === true
      step.retractStarted = true
      writeJournal(journal)
      const out = retractSamples(step.name, step.added)
      removed = out.removed
      notFound = retrying ? 0 : out.notFound
      step.added = []
      delete step.macBefore
      const back = restoreEvicted(step, step.evicted, own)
      step.evicted = back.keep
      restored = back.restored
      dropped = back.dropped
      if (back.enrolFailed) reason = 'profile_store_unavailable'
    } catch (error) {
      log(`samples not reverted for ${step.label} in ${batchId}: ${String(error)}`)
      reason = 'profile_store_unavailable'
    }
    if (!reason) step.attendeesBefore = null
    return totals(reason ? 'left' : 'reverted', { removed, notFound, restored, dropped, reason, nothingApplied: verdict === 'not_applied' && step.state !== 'named' && removed === 0 })
  }

  /** A sample with no room when its batch was undone may have room now that a later batch is undone too. */
  function retryKeptRestores(): void {
    for (const { session, batchId } of journalFiles()) {
      const journal = loadJournal(session, batchId)
      if (typeof journal === 'string') continue
      const own = new Set(journal.steps.map(s => s.correctionId))
      let changed = false
      for (const step of journal.steps) {
        if (!step.undo || step.evicted.length === 0) continue
        const back = restoreEvicted(step, step.evicted, own)
        step.evicted = back.keep
        step.undo.evictedRestored += back.restored
        step.undo.evictedDropped += back.dropped
        changed = changed || back.restored + back.dropped > 0
      }
      if (changed) writeJournal(journal)
    }
  }

  function undoResult(journal: Journal, transient: Map<string, string>, revision: string, dryRun: boolean, wouldRemove = 0, wouldRestore = 0, verdicts?: Map<string, Verdict>, wouldMissNames?: Map<string, number>): NamingBatchUndoResult {
    const reverted = new Map<number, { labels: string[]; name: string }>()
    const left = new Map<string, { labels: string[]; name: string; reason: string }>()
    let samplesRemoved = wouldRemove
    let evictedRestored = wouldRestore
    let evictedNotRestored = 0
    const leave = (step: Step, reason: string): void => {
      const key = `${step.itemIndex}|${reason}`
      const entry = left.get(key) ?? { labels: [], name: step.name, reason }
      entry.labels.push(step.label)
      left.set(key, entry)
    }
    for (const step of journal.steps) {
      if (step.state === 'refused') continue
      samplesRemoved += step.undo?.samplesRemoved ?? 0
      evictedRestored += step.undo?.evictedRestored ?? 0
      if (step.undo) evictedNotRestored += step.undo.evictedDropped + step.evicted.length + (step.evictedForgotten ?? 0)
      const verdict = verdicts?.get(step.correctionId)
      const reason = transient.get(step.correctionId)
        ?? (verdict === 'confirmed_by_person' || verdict === 'label_changed_by_person' ? verdict : undefined)
        ?? (step.undo?.state === 'left' ? step.undo.reason ?? 'not_reverted' : undefined)
      if (reason) leave(step, reason)
      else if (!step.undo?.nothingApplied && !(verdict === 'not_applied' && step.state !== 'named')) {
        const entry = reverted.get(step.itemIndex) ?? { labels: [], name: step.name }
        entry.labels.push(step.label)
        reverted.set(step.itemIndex, entry)
      }
      // The label may be back and a sample still unaccounted for: a voice can be in both lists, and the answer is partial.
      if ((step.undo?.samplesNotFound ?? 0) + (wouldMissNames?.get(step.correctionId) ?? 0) > 0) leave(step, 'samples_not_found')
    }
    return {
      state: left.size > 0 ? 'partial' : 'undone',
      reverted: [...reverted.values()],
      left: [...left.values()],
      samplesRemoved,
      evictedRestored,
      evictedNotRestored,
      sourceRevision: revision,
      ...(dryRun ? { dryRun: true as const } : {}),
    }
  }

  async function undo(sessionId: string, batchId: string, confirm: boolean): Promise<NamingBatchUndoResult> {
    const refusal = (reason: string, sourceRevision: string): NamingBatchUndoResult => ({
      state: 'refused', reason, reverted: [], left: [], samplesRemoved: 0, evictedRestored: 0, evictedNotRestored: 0, sourceRevision, ...(confirm ? {} : { dryRun: true as const }),
    })
    const meeting = resolveMeeting(sessionId)
    if ('refused' in meeting) return refusal(meeting.refused, '')
    const revision = (): string => deps.reviewRevision(meeting.meetingPath, meeting.sidecarPath)
    const journal = loadJournal(sessionId, batchId)
    if (journal === 'missing') return refusal('batch_not_found', revision())
    if (journal === 'unreadable') return refusal('journal_unreadable', revision())
    if (active.has(sessionId)) return refusal('batch_running', revision())
    // Already done: answer the same thing again and touch nothing, whatever else is going on.
    if (journal.state === 'undone') return undoResult(journal, new Map(), revision(), !confirm)
    const blocked = blockReason(sessionId)
    if (blocked) return refusal(blocked, revision())
    const own = journal.steps.map(step => step.correctionId)
    if (pendingCorrections(sessionId).some(open => !own.some(id => open.id === id || open.id.startsWith(`${id}:undo:`)))) return refusal('correction_pending', revision())
    const steps = journal.steps.filter(step => step.state !== 'refused' && step.undo?.state !== 'reverted').reverse()

    if (!confirm) {
      let doc: Record<string, unknown>
      try { doc = JSON.parse(readText(meeting.sidecarPath) ?? '') as Record<string, unknown> } catch { return refusal('sidecar_unreadable', revision()) }
      const rows = readCorrections(sessionId).rows
      const verdicts = new Map<string, Verdict>()
      const misses = new Map<string, number>()
      let wouldRemove = 0
      let wouldRestore = 0
      for (const step of steps) {
        const verdict = verdictFor(step, new Set(own), rows, doc)
        verdicts.set(step.correctionId, verdict)
        if (verdict === 'confirmed_by_person') continue
        const effects = sampleEffects(step)
        const located = locateSamples(step.name, effects.added)
        wouldRemove += effects.added.length - located.notFound
        misses.set(step.correctionId, located.notFound)
        wouldRestore += subtractSamples(effects.evicted, (profileSamples(step.name) ?? []).map(sampleKey)).length
      }
      return undoResult(journal, new Map(), revision(), true, wouldRemove, wouldRestore, verdicts, misses)
    }

    active.set(sessionId, batchId)
    const transient = new Map<string, string>()
    try {
      for (const step of steps) {
        await yieldToLoop()
        let work: { release: () => void }
        try { work = acquireWork() } catch { transient.set(step.correctionId, 'maintenance'); continue }
        let lock: { release: () => void } | undefined
        try {
          try { lock = await acquireLock() } catch { transient.set(step.correctionId, 'sync_running'); continue }
          // A recording may have started while this waited for the lock. Nothing awaits between here and the journal.
          const stopAtLock = blockReason(sessionId)
          if (stopAtLock) { transient.set(step.correctionId, stopAtLock); continue }
          step.undo = undoStep(journal, step, meeting)
          writeJournal(journal)
        } finally {
          lock?.release()
          work.release()
        }
      }
      const clean = transient.size === 0 && journal.steps.every(step => step.state === 'refused' || (step.undo?.state === 'reverted' && !step.undo.samplesNotFound))
      journal.state = clean ? 'undone' : 'undo_partial'
      writeJournal(journal)
      // Best effort and bounded by the same checks as a write. A failure here must not turn a finished Undo into an error.
      if (!blockReason(sessionId)) {
        let work: { release: () => void } | undefined
        try {
          work = acquireWork()
          retryKeptRestores()
        } catch (error) {
          log(`kept samples not retried after ${batchId}: ${String(error)}`)
        } finally {
          work?.release()
        }
      }
    } finally {
      active.delete(sessionId)
    }
    const reread = loadJournal(sessionId, batchId)
    return undoResult(typeof reread === 'string' ? journal : reread, transient, revision(), false)
  }

  function list(sessionId: string): { batches: NamingBatchListEntry[] } {
    let files: string[] = []
    try { files = readdirSync(sessionFolder(sessionId)).filter(file => BATCH_ID.test(file.replace(/\.json$/, ''))) } catch { return { batches: [] } }
    const batches = files.flatMap((file): NamingBatchListEntry[] => {
      const batchId = file.replace(/\.json$/, '')
      const journal = loadJournal(sessionId, batchId)
      if (journal === 'missing') return []
      return [typeof journal === 'string'
        ? { batchId, at: '', state: 'unreadable', named: [], undoAvailable: false }
        : { batchId, at: journal.at, state: listState(journal), named: namedEntries(journal), undoAvailable: journalUndoAvailable(journal) }]
    })
    return { batches: batches.sort((a, b) => b.at.localeCompare(a.at)) }
  }

  return { run, undo, list }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** For index.ts's `lifecycleOwned`: these own their lease per write and refuse on their own during a drain. */
export function isMacVoiceNamingBatchPost(path: string): boolean {
  return /^\/meeting\/[A-Za-z0-9:_-]{3,96}\/voice-naming-batch(?:\/[0-9a-f-]{36}\/undo)?$/.test(path)
}

function parseItems(value: unknown): NamingBatchItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) return null
  const items: NamingBatchItem[] = []
  for (const raw of value as Array<{ labels?: unknown; name?: unknown } | null>) {
    const labels = raw?.labels
    const name = raw?.name
    if (typeof name !== 'string' || name.length === 0 || name.length > 120) return null
    if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_ITEMS || labels.some(label => typeof label !== 'string')) return null
    items.push({ labels: labels as string[], name })
  }
  return items
}

export function registerMacVoiceNamingBatchRoutes(router: Router, deps: NamingBatchDeps): void {
  const batches = createMacVoiceNamingBatches(deps)
  // Also at startup, so voiceprints do not outlive retention on a Mac that names nothing more.
  pruneExpiredJournals()
  const invalidSession = (sessionId: string): boolean => !SESSION_ID.test(sessionId)

  router.get('/meeting/:sessionId/voice-naming-batch', (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    if (invalidSession(sessionId)) { res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' }); return }
    res.set('Cache-Control', 'private, no-store')
    res.json(batches.list(sessionId))
  })

  router.post('/meeting/:sessionId/voice-naming-batch', async (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    res.set('Cache-Control', 'private, no-store')
    if (invalidSession(sessionId)) { res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' }); return }
    const items = parseItems(req.body?.items)
    if (!items || typeof req.body?.sourceRevision !== 'string') { res.status(400).json({ error: 'sourceRevision and items are required', reason: 'invalid_items' }); return }
    try {
      res.json(await batches.run(sessionId, { sourceRevision: req.body.sourceRevision, items, confirm: req.body?.confirm === true }))
    } catch (error) {
      console.error('[mac-naming-batch] refused:', error)
      res.status(500).json({ error: 'The batch could not run', reason: 'internal_error' })
    }
  })

  router.post('/meeting/:sessionId/voice-naming-batch/:batchId/undo', async (req, res) => {
    const sessionId = String(req.params.sessionId ?? '')
    const batchId = String(req.params.batchId ?? '')
    res.set('Cache-Control', 'private, no-store')
    if (invalidSession(sessionId)) { res.status(400).json({ error: 'Invalid sessionId', reason: 'invalid_session_id' }); return }
    if (!BATCH_ID.test(batchId)) { res.status(400).json({ error: 'Invalid batchId', reason: 'invalid_batch_id' }); return }
    try {
      res.json(await batches.undo(sessionId, batchId, req.body?.confirm === true))
    } catch (error) {
      console.error('[mac-naming-batch] undo failed:', error)
      res.status(500).json({ error: 'The Undo could not finish. Ask again; it is safe to repeat', reason: 'internal_error' })
    }
  })
}
