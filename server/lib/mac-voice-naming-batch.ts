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
// store changes, which this batch's own first commit also does, so from then on the store's stamp taken right after
// that commit stands in for it: any write since then that is not ours stops the batch as `suggestions_stale`.
//
// JOURNAL. Intent is durable before anything is touched and the outcome after. A process that dies leaves `running`,
// which reads as `interrupted` once no live batch owns it, and Undo works out what landed by inspection. Refusals that
// wrote nothing leave no journal.
//
// WHICH SAMPLES. The profile store has no sample ids, so a sample is its source plus a sha256 of its vector, taken by
// diffing the profile around the one synchronous commit. `retractEmbeddingsBySource` matches on source alone, and the
// broad session retraction would also remove earlier single namings from this call, which are a person's decisions.
// So Undo finds the exact indices and passes a predicate that walks them in the store's index order, and it can only
// ever match a sample whose source is the one recorded at that index.
//
// EVICTED SAMPLES ARE RESTORED WHEN THAT IS SAFE. A Mac-assigned sample only ever evicts another Mac-assigned one, and
// one label can replace a person's whole Mac allowance, so losing them on Undo would cost earlier decisions. Vectors go
// back through the normal enrolment path, skipping its near-duplicate check, only if nothing would be displaced, the
// profile still exists and no person has since moved that name in the sample's own meeting. Anything else is counted
// as not restored. A restored sample becomes the newest Mac-assigned one, so eviction order is not preserved.
// Vectors kept for this are scrubbed after Undo, and forgetMacVoiceNamingPerson scrubs them when a person is deleted.
//
// LATER HUMAN ACTIONS WIN. A label a person changed afterwards is left alone and the batch's samples for it are still
// retracted, because that change says the batch was wrong. A label a person CONFIRMED afterwards keeps its samples too.
// A sample moved to another profile by a later merge is not chased.
//
// DRAINS. Planning is read-only and holds no lease. Each write section holds its own `api_mutation` lease and the
// meeting sync lock. isMacVoiceNamingBatchPost is what index.ts needs in order to let the route answer its own refusal.

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
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
  evictedRestored: number
  evictedNotRestored: number
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
  markdownBefore: string | null
  markdownAfterHash: string | null
  attendeeEdits: number
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

/** Exactly these identities, in one store write. Runs without awaiting, so the indices cannot go stale. */
function retractSamples(name: string, ids: SampleId[]): number {
  const samples = profileSamples(name)
  if (!samples || ids.length === 0) return 0
  const wanted = new Map<string, number>()
  for (const id of ids) wanted.set(sampleKey(id), (wanted.get(sampleKey(id)) ?? 0) + 1)
  const drop = new Set<number>()
  for (let i = 0; i < samples.length; i++) {
    const key = sampleKey(samples[i])
    const count = wanted.get(key) ?? 0
    if (count > 0) { drop.add(i); wanted.set(key, count - 1) }
  }
  if (drop.size === 0) return 0
  let index = 0
  const { removed } = retractEmbeddingsBySource(name, source => {
    const at = index++
    return drop.has(at) && samples[at].source === source
  })
  if (removed !== drop.size) throw new Error(`removed ${removed} of ${drop.size} samples`)
  return removed
}

/** True when `enrollEmbedding` would make room by dropping something. Mirrors its makeRoomForSample. */
function wouldDisplace(samples: SampleCopy[]): boolean {
  const macCount = samples.filter(s => isMacAssign(s.source)).length
  return samples.length >= MAX_EMBEDDINGS_PER_SPEAKER || macCount >= macAssignCapFor(samples.length, macCount)
}

function restoreEvicted(step: Step, evicted: SampleCopy[]): { restored: number; notRestored: number } {
  let restored = 0
  let notRestored = step.evictedForgotten ?? 0
  for (const sample of evicted) {
    const samples = profileSamples(step.name)
    if (samples?.some(s => sampleKey(s) === sampleKey(sample))) continue
    const session = sample.source.startsWith(`${MAC_ASSIGN_SOURCE}:`) ? sample.source.slice(MAC_ASSIGN_SOURCE.length + 1) : ''
    const movedSince = session !== '' && appliedCorrections(session).some(row => row.from === step.name && row.at >= step.at)
    if (!samples || wouldDisplace(samples) || movedSince) { notRestored++; continue }
    if (enrollEmbedding(step.name, Float32Array.from(sample.embedding), sample.source, true).success) restored++
    else notRestored++
  }
  return { restored, notRestored }
}

/** What this step did to the profile. A step that died inside its commit is worked out from what is there now. */
function sampleEffects(step: Step): { added: SampleId[]; evicted: SampleCopy[] } {
  if (step.state === 'named') return { added: step.added, evicted: step.evicted }
  const current = profileSamples(step.name) ?? []
  const planned = new Set(step.planned)
  const added = subtractSamples(current.filter(s => s.source === step.source && planned.has(s.hash)), step.before)
  // No added sample means the commit never ran, so a missing sample left for some other reason.
  const evicted = added.length > 0 ? subtractSamples(step.macBefore ?? [], current.map(sampleKey)) : []
  return { added: added.map(({ source, hash }) => ({ source, hash })), evicted }
}

// ── Journal ──────────────────────────────────────────────────────────────────

const sessionFolder = (sessionId: string): string => dataPath(MAC_VOICE_NAMING_BATCH_DIR, sessionId.replace(/:/g, '_'))
const journalPath = (sessionId: string, batchId: string): string => dataPath(MAC_VOICE_NAMING_BATCH_DIR, sessionId.replace(/:/g, '_'), `${batchId}.json`)

function writeJournal(journal: Journal): void {
  const path = journalPath(journal.sessionId, journal.batchId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(path, `${JSON.stringify(journal)}\n`, FILE_MODE)
}

function parseJournal(text: string, sessionId: string, batchId: string): Journal | null {
  try {
    const parsed = JSON.parse(text) as Journal
    return parsed?.version === 1 && parsed.sessionId === sessionId && parsed.batchId === batchId && Array.isArray(parsed.steps) ? parsed : null
  } catch { return null }
}

function readJournal(sessionId: string, batchId: string): Journal | null {
  try { return parseJournal(readFileSync(journalPath(sessionId, batchId), 'utf-8'), sessionId, batchId) } catch { return null }
}

/** Person deleted: drop the voiceprints journals hold for them. Their count stays, reported as not restored. */
export function forgetMacVoiceNamingPerson(name: string): { batches: number; vectors: number } {
  const out = { batches: 0, vectors: 0 }
  let folders: string[] = []
  try { folders = readdirSync(dataPath(MAC_VOICE_NAMING_BATCH_DIR)) } catch { return out }
  for (const folder of folders) {
    let files: string[] = []
    try { files = readdirSync(dataPath(MAC_VOICE_NAMING_BATCH_DIR, folder)).filter(file => file.endsWith('.json')) } catch { continue }
    for (const file of files) {
      let journal: Journal
      try { journal = JSON.parse(readFileSync(dataPath(MAC_VOICE_NAMING_BATCH_DIR, folder, file), 'utf-8')) as Journal } catch { continue }
      let vectors = 0
      for (const step of journal.steps ?? []) {
        if (step.name !== name) continue
        vectors += step.evicted.length + (step.macBefore?.length ?? 0)
        step.evictedForgotten = (step.evictedForgotten ?? 0) + step.evicted.length
        step.evicted = []
        delete step.macBefore
      }
      if (vectors === 0) continue
      writeJournal(journal)
      out.batches++
      out.vectors += vectors
    }
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

/**
 * The markdown with this step's turns back on the old label, or null when that cannot be done honestly.
 * Nothing changed since: the exact bytes. Otherwise turn order is the join key, not turn text: undoSpeakerMarkdown
 * refuses a turn whose words repeat, and "Yeah." repeats on every real call.
 */
function revertedMarkdown(current: string, step: Step): string | null {
  if (step.markdownBefore === null) return current
  if (sha256(current) === step.markdownAfterHash) return step.markdownBefore
  if (step.attendeeEdits > 0) return null
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
  return lines.join('\n')
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

    active.set(sessionId, null)
    const batchId = randomUUID()
    let journal = null as Journal | null
    let expected = { sidecar: checked.sidecar, markdown: readText(meetingPath) }
    let ownStoreStamp = null as string | null
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
      // The plan yielded, so anything may have started or moved while it ran.
      const blockedAfter = blockReason(sessionId)
      if (blockedAfter) return refuse(blockedAfter)
      if (pendingCorrections(sessionId).length > 0) return refuse('correction_pending')
      let work: { release: () => void }
      try { work = acquireWork() } catch { return refuse('maintenance') }
      let lock: { release: () => void } | undefined
      try {
        try { lock = await acquireLock() } catch { return refuse('sync_running') }
        if (moved()) return refuse('meeting_changed')
        if (ownStoreStamp === null) {
          const current = suggestions(sessionId)
          if (!current || current.sourceRevision !== revision() || !itemIsSuggested(current, item)) return refuse('suggestions_stale')
        } else if (profileStoreStamp() !== ownStoreStamp) return refuse('suggestions_stale')
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
          markdownBefore: rewrites ? expected.markdown : null,
          markdownAfterHash: rewrites && edit ? sha256(edit.markdown) : null,
          attendeeEdits: edit?.attendees ?? 0,
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
        ownStoreStamp = profileStoreStamp()
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
    if (step.markdownBefore !== null && (markdown === null || nextMarkdown === null)) return 'transcript_changed'
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
    // The key on this row is the correction it takes back, which is what appliedCorrections filters on.
    appendCorrection(sessionId, { ...row, phase: 'reverted', at: new Date().toISOString(), batchId: step.correctionId })
    return null
  }

  function undoStep(journal: Journal, step: Step, meeting: { sidecarPath: string; meetingPath: string }): StepUndo {
    const { sessionId, batchId } = journal
    const own = new Set(journal.steps.map(s => s.correctionId))
    const prior = step.undo
    const totals = (state: StepUndo['state'], removed: number, restored: number, notRestored: number, reason?: string, nothingApplied?: boolean): StepUndo => ({
      state,
      ...(reason ? { reason } : {}),
      samplesRemoved: (prior?.samplesRemoved ?? 0) + removed,
      evictedRestored: (prior?.evictedRestored ?? 0) + restored,
      evictedNotRestored: notRestored,
      ...(nothingApplied ? { nothingApplied } : {}),
    })
    const sidecar = readText(meeting.sidecarPath)
    let doc: Record<string, unknown>
    try { doc = JSON.parse(sidecar ?? '') as Record<string, unknown> } catch { return totals('left', 0, 0, prior?.evictedNotRestored ?? 0, 'sidecar_unreadable') }
    const rows = readCorrections(sessionId).rows
    const verdict = verdictFor(step, own, rows, doc)
    if (verdict === 'confirmed_by_person') return totals('left', 0, 0, prior?.evictedNotRestored ?? 0, verdict)
    let reason: string | null = verdict === 'label_changed_by_person' ? verdict : null
    if (verdict === 'applied') reason = revertLabel(sessionId, batchId, step, meeting, sidecar ?? '')
    // An interrupted batch may have left its own intent open. Undo is what closes it.
    for (const open of pendingCorrections(sessionId)) {
      if (open.id === step.correctionId || open.id.startsWith(`${step.correctionId}:undo:`)) appendCorrection(sessionId, { ...open, phase: 'failed', at: new Date().toISOString(), error: 'interrupted, closed by batch undo' })
    }
    let removed = 0
    let restored = { restored: 0, notRestored: 0 }
    try {
      const effects = sampleEffects(step)
      removed = retractSamples(step.name, effects.added)
      restored = restoreEvicted(step, effects.evicted)
    } catch (error) {
      log(`samples not reverted for ${step.label} in ${batchId}: ${String(error)}`)
      reason = 'profile_store_unavailable'
    }
    if (!reason || PERMANENT_LEFT.has(reason)) {
      step.evicted = []
      delete step.macBefore
    }
    const nothingApplied = verdict === 'not_applied' && step.state !== 'named' && removed === 0
    return totals(reason ? 'left' : 'reverted', removed, restored.restored, restored.notRestored, reason ?? undefined, nothingApplied)
  }

  function undoResult(journal: Journal, transient: Map<Step, string>, revision: string, dryRun: boolean, wouldRemove = 0, wouldRestore = 0, verdicts?: Map<Step, Verdict>): NamingBatchUndoResult {
    const reverted = new Map<number, { labels: string[]; name: string }>()
    const left = new Map<string, { labels: string[]; name: string; reason: string }>()
    let samplesRemoved = wouldRemove
    let evictedRestored = wouldRestore
    let evictedNotRestored = 0
    for (const step of journal.steps) {
      if (step.state === 'refused') continue
      samplesRemoved += step.undo?.samplesRemoved ?? 0
      evictedRestored += step.undo?.evictedRestored ?? 0
      evictedNotRestored += step.undo?.evictedNotRestored ?? 0
      const verdict = verdicts?.get(step)
      const reason = transient.get(step)
        ?? (verdict === 'confirmed_by_person' || verdict === 'label_changed_by_person' ? verdict : undefined)
        ?? (step.undo?.state === 'left' ? step.undo.reason ?? 'not_reverted' : undefined)
      if (reason) {
        const key = `${step.itemIndex}|${reason}`
        const entry = left.get(key) ?? { labels: [], name: step.name, reason }
        entry.labels.push(step.label)
        left.set(key, entry)
      } else if (!step.undo?.nothingApplied && !(verdict === 'not_applied' && step.state !== 'named')) {
        const entry = reverted.get(step.itemIndex) ?? { labels: [], name: step.name }
        entry.labels.push(step.label)
        reverted.set(step.itemIndex, entry)
      }
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
    const journal = readJournal(sessionId, batchId)
    if (!journal) return refusal('batch_not_found', revision())
    if (active.has(sessionId)) return refusal('batch_running', revision())
    // Already done: answer the same thing again and touch nothing, whatever else is going on.
    if (journal.state === 'undone') return undoResult(journal, new Map(), revision(), !confirm)
    const blocked = blockReason(sessionId)
    if (blocked) return refusal(blocked, revision())
    const own = journal.steps.map(step => step.correctionId)
    if (pendingCorrections(sessionId).some(open => !own.some(id => open.id === id || open.id.startsWith(`${id}:undo:`)))) return refusal('correction_pending', revision())
    const settled = (step: Step): boolean => step.undo?.state === 'reverted' || (step.undo?.state === 'left' && PERMANENT_LEFT.has(step.undo.reason ?? ''))
    const steps = journal.steps.filter(step => step.state !== 'refused' && !settled(step)).reverse()

    if (!confirm) {
      let doc: Record<string, unknown>
      try { doc = JSON.parse(readText(meeting.sidecarPath) ?? '') as Record<string, unknown> } catch { return refusal('sidecar_unreadable', revision()) }
      const rows = readCorrections(sessionId).rows
      const verdicts = new Map<Step, Verdict>()
      let wouldRemove = 0
      let wouldRestore = 0
      for (const step of steps) {
        const verdict = verdictFor(step, new Set(own), rows, doc)
        verdicts.set(step, verdict)
        if (verdict === 'confirmed_by_person') continue
        const effects = sampleEffects(step)
        const samples = profileSamples(step.name) ?? []
        wouldRemove += effects.added.length - subtractSamples(effects.added, samples.map(sampleKey)).length
        wouldRestore += subtractSamples(effects.evicted, samples.map(sampleKey)).length
      }
      return undoResult(journal, new Map(), revision(), true, wouldRemove, wouldRestore, verdicts)
    }

    active.set(sessionId, batchId)
    const transient = new Map<Step, string>()
    try {
      for (const step of steps) {
        await yieldToLoop()
        const stop = blockReason(sessionId)
        if (stop) { transient.set(step, stop); continue }
        let work: { release: () => void }
        try { work = acquireWork() } catch { transient.set(step, 'maintenance'); continue }
        let lock: { release: () => void } | undefined
        try {
          try { lock = await acquireLock() } catch { transient.set(step, 'sync_running'); continue }
          step.undo = undoStep(journal, step, meeting)
          writeJournal(journal)
        } finally {
          lock?.release()
          work.release()
        }
      }
      journal.state = transient.size === 0 && journal.steps.every(step => step.state === 'refused' || step.undo?.state === 'reverted') ? 'undone' : 'undo_partial'
      writeJournal(journal)
    } finally {
      active.delete(sessionId)
    }
    return undoResult(journal, transient, revision(), false)
  }

  function list(sessionId: string): { batches: NamingBatchListEntry[] } {
    let files: string[] = []
    try { files = readdirSync(sessionFolder(sessionId)).filter(file => BATCH_ID.test(file.replace(/\.json$/, ''))) } catch { return { batches: [] } }
    const batches = files.map((file): NamingBatchListEntry => {
      const batchId = file.replace(/\.json$/, '')
      const journal = readJournal(sessionId, batchId)
      return journal
        ? { batchId, at: journal.at, state: listState(journal), named: namedEntries(journal), undoAvailable: journalUndoAvailable(journal) }
        : { batchId, at: '', state: 'unreadable', named: [], undoAvailable: false }
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
