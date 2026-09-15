/**
 * Additive render of a merged record or a split piece, plus its `.derived.json` sidecar
 * (6.47.0, WS3).
 *
 * PURE. No filesystem, no network. It reads the clock only through the timestamps its
 * inputs carry.
 *
 * ADDITIVE, NEVER REDUCTIVE (D12). Every input's content survives into the output: the
 * Fireflies transcript with resolved labels, one `## G2 Capture` section per capture, the
 * alternate transcript of every duplicate recording, the union of attendees, and a Sources
 * table naming each input and its role. Nothing here edits, archives or replaces a source.
 *
 * DETERMINISTIC. The same inputs must produce the same bytes, because re-derive writes only
 * when the bytes differ, and a re-render that reordered a map would rewrite every record on
 * every run.
 */

import { createHash } from 'node:crypto'
import {
  type FirefliesMeetingInput,
  type FirefliesSentenceInput,
  type G2RecordingInput,
  g2TimedWords,
  labelIntervals,
  median,
} from './evidence.js'
import { type AttributionState, type Alignment, alignRecording } from './align.js'
import {
  type AttributeMode,
  type SentenceLabel,
  type SpeakerVerification,
  ATTRIBUTE_MODE,
  attributeSentences,
  isGenericLabel,
} from './attribute.js'
import type { SplitPiece } from './split.js'

/** Sidecar schema version. A reader that does not know this version must not guess. */
export const DERIVED_SIDECAR_VERSION = 1

/** The markdown a derived record may reach before its transcripts move to the sidecar. */
export const MARKDOWN_MAX_BYTES = 9 * 1024 * 1024

/** The sidecar's own ceiling, read by a bounded reader separate from the markdown cap. */
export const DERIVED_SIDECAR_MAX_BYTES = 32 * 1024 * 1024

/** Every derived record carries this domain; `originDomain` keeps the source's own. */
export const DERIVED_DOMAIN = 'imported'

export const MERGED_SOURCE_LABEL = 'G2 Glasses + Fireflies'
export const SPLIT_SOURCE_LABEL = 'Fireflies (split)'

export type DerivedKind = 'merge' | 'split'
export type DerivedTier = 'auto' | 'accepted_suggestion'

export interface DerivedInputFingerprint {
  kind: 'g2' | 'fireflies'
  id: string
  sha256: string | null
  correctionRevision?: number
  batchApplied?: boolean
}

export interface DerivedAlignment {
  sessionId: string
  offsetMs: number | null
  anchors: number
  madMs: number | null
  attribution: AttributionState
}

export interface DerivedSidecar {
  version: number
  actionId: string
  kind: DerivedKind
  inputs: DerivedInputFingerprint[]
  tier: DerivedTier
  evidence: { K1: number; K2: number }
  offsetMs: number | null
  anchors: number
  mad: number | null
  attribution: AttributionState
  alignments: DerivedAlignment[]
  labels: Array<Pick<SentenceLabel, 'index' | 'ffLabel' | 'g2Label' | 'share' | 'similarity' | 'windowOffsetMs'> & { outcome: SentenceLabel['outcome'] }>
  conflicts: number[]
  pieces: SplitPiece[]
  overflow?: { sections: string[] }
}

export interface DerivedRecord {
  markdown: string
  sidecar: DerivedSidecar
  verification: SpeakerVerification[]
}

export type DeriveResult =
  | { ok: true; record: DerivedRecord }
  | { ok: false; error: 'derived_too_large'; markdownBytes: number; sidecarBytes: number }

export interface RenderLimits {
  markdownMaxBytes?: number
  sidecarMaxBytes?: number
}

export interface MergeDeriveInput {
  actionId: string
  tier: DerivedTier
  /** The fullest recording of the meeting; it supplies the transcript, summary and items. */
  primary: FirefliesMeetingInput
  /** Duplicate recordings of the same meeting, kept in full as alternates. */
  alternates?: readonly FirefliesMeetingInput[]
  /** Every G2 capture of this meeting, in start order. */
  captures: readonly G2RecordingInput[]
  evidence: { k1: number; k2: number }
  /** Coarse offset per capture from pairing; the clock offset is used when absent. */
  coarseOffsetMsBySession?: Record<string, number>
  attributeMode?: AttributeMode
  limits?: RenderLimits
}

export interface PieceDeriveInput {
  actionId: string
  tier: DerivedTier
  source: FirefliesMeetingInput
  piece: SplitPiece
  pieceCount: number
  /** Captures whose content defines this piece. */
  captures: readonly G2RecordingInput[]
  attributeMode?: AttributeMode
  limits?: RenderLimits
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Identity of a derived record's inputs. Re-derive when this changes; skip when it does not. */
export function fingerprintKey(inputs: readonly DerivedInputFingerprint[]): string {
  const canonical = [...inputs]
    .map(input => `${input.kind}:${input.id}:${input.sha256 ?? ''}:${input.correctionRevision ?? ''}:${input.batchApplied ?? ''}`)
    .sort()
    .join('|')
  return sha256Hex(canonical)
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

/** `YYYY-MM-DD HH:MM` in local time, the form the meeting parsers read. */
export function formatDateTime(epochMs: number): string {
  const date = new Date(epochMs)
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function formatClock(epochMs: number): string {
  const date = new Date(epochMs)
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** `[HH:MM:SS]` from the start of the recording. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `[${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}]`
}

function minutesOf(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60))
}

function transcriptLine(elapsedMs: number, speaker: string, text: string): string {
  const name = speaker.trim() === '' ? 'Unknown' : speaker.trim()
  return `${formatElapsed(elapsedMs)} ${name}: ${String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()}`
}

function firefliesLines(sentences: readonly FirefliesSentenceInput[], labels?: readonly SentenceLabel[]): string[] {
  return sentences.map((sentence, index) => {
    const label = labels?.[index]?.resolvedLabel ?? String(sentence.speaker_name ?? '')
    return transcriptLine((Number(sentence.start_time ?? 0) || 0) * 1000, label, String(sentence.text ?? ''))
  })
}

function captureLines(capture: G2RecordingInput): string[] {
  const chunks = (capture.chunks ?? []).filter(chunk => typeof chunk.elapsed === 'number' && Number.isFinite(chunk.elapsed))
  if (chunks.length > 0) return chunks.map(chunk => transcriptLine(chunk.elapsed as number, String(chunk.speaker ?? ''), String(chunk.text ?? '')))
  // No chunk text: fall back to the batch pass's own words so the capture is never empty.
  const { words } = g2TimedWords(capture)
  return words.length > 0 ? [transcriptLine(words[0].timeMs, '', words.map(word => word.token).join(' '))] : []
}

function attendeeUnion(primary: FirefliesMeetingInput, alternates: readonly FirefliesMeetingInput[], captures: readonly G2RecordingInput[], labels: readonly SentenceLabel[]): string[] {
  const names = new Set<string>()
  for (const meeting of [primary, ...alternates]) {
    for (const participant of meeting.participants ?? []) if (participant.trim()) names.add(participant.trim())
    for (const sentence of meeting.sentences) {
      const name = String(sentence.speaker_name ?? '').trim()
      if (name) names.add(name)
    }
  }
  for (const label of labels) if (label.resolvedLabel.trim()) names.add(label.resolvedLabel.trim())
  for (const capture of captures) {
    for (const chunk of capture.chunks ?? []) {
      const name = String(chunk.speaker ?? '').trim()
      if (name) names.add(name)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

function verificationRow(verification: readonly SpeakerVerification[]): string {
  if (verification.length === 0) return 'none'
  return verification
    .map(entry => entry.humanConfirmed && entry.medianSimilarity <= 0
      ? `${entry.name} (confirmed, ${entry.sentences} sentences)`
      : `${entry.name} (voice match ${entry.medianSimilarity.toFixed(2)}, ${entry.sentences} sentences)`)
    .join('; ')
}

function fieldTable(rows: ReadonlyArray<readonly [string, string]>): string[] {
  return ['| Field | Value |', '|-------|-------|', ...rows.map(([key, value]) => `| **${key}** | ${value} |`)]
}

function sourcesTable(rows: ReadonlyArray<{ role: string; kind: string; id: string; start: string; length: string }>): string[] {
  return [
    '| Role | Kind | Id | Start | Length |',
    '|------|------|----|-------|--------|',
    ...rows.map(row => `| ${row.role} | ${row.kind} | ${row.id} | ${row.start} | ${row.length} |`),
  ]
}

function sectionsOf(lines: string[]): string {
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function attributionStateOf(alignment: Alignment, mode: AttributeMode): AttributionState {
  if (mode === 'capture_only') return 'capture_only'
  return alignment.aligned ? 'aligned' : 'unaligned'
}

function fingerprintsOf(meetings: readonly FirefliesMeetingInput[], captures: readonly G2RecordingInput[]): DerivedInputFingerprint[] {
  return [
    ...meetings.map(meeting => ({ kind: 'fireflies' as const, id: meeting.id, sha256: meeting.sha256 ?? null })),
    ...captures.map(capture => ({
      kind: 'g2' as const,
      id: capture.sessionId,
      sha256: capture.sha256 ?? null,
      correctionRevision: capture.correctionRevision,
      batchApplied: capture.batchApplied,
    })),
  ]
}

/**
 * Build a merged record: the Fireflies transcript with resolved labels, every capture, and
 * every duplicate recording's transcript.
 */
export function renderMergedRecord(input: MergeDeriveInput): DeriveResult {
  const alternates = input.alternates ?? []
  const mode = input.attributeMode ?? ATTRIBUTE_MODE
  const alignments = input.captures.map(capture => {
    const { words } = g2TimedWords(capture)
    const coarse = input.coarseOffsetMsBySession?.[capture.sessionId]
      ?? (capture.startMs - input.primary.startMs)
    return { capture, alignment: alignRecording(words, input.primary.sentences, coarse) }
  })
  const attribution = attributeSentences(
    input.primary.sentences,
    alignments.map(entry => ({ sessionId: entry.capture.sessionId, alignment: entry.alignment, labels: labelIntervals(entry.capture) })),
    mode,
  )

  const head = [
    `# ${input.primary.title?.trim() || 'Merged meeting'}`,
    '',
    ...fieldTable([
      ['Date', formatDateTime(input.primary.startMs)],
      ['Duration', `${minutesOf(input.primary.durationS)} minutes`],
      ['Source', MERGED_SOURCE_LABEL],
      ['Domain', DERIVED_DOMAIN],
      ['Speaker Verification', verificationRow(attribution.verification)],
    ]),
    '',
  ]
  const summary = input.primary.summary?.trim() ? ['## Summary', '', input.primary.summary.trim(), ''] : []
  const actionItems = (input.primary.actionItems ?? []).filter(item => item.trim())
  const items = actionItems.length > 0 ? ['## Action Items', '', ...actionItems.map(item => `- ${item.trim()}`), ''] : []
  const attendees = attendeeUnion(input.primary, alternates, input.captures, attribution.labels)
  const attendeeSection = attendees.length > 0 ? ['## Attendees', '', ...attendees.map(name => `- ${name}`), ''] : []
  const sources = [
    '## Sources',
    '',
    ...sourcesTable([
      { role: 'Primary transcript', kind: 'Fireflies', id: input.primary.id, start: formatDateTime(input.primary.startMs), length: `${minutesOf(input.primary.durationS)} min` },
      ...alternates.map(meeting => ({ role: 'Alternate transcript', kind: 'Fireflies', id: meeting.id, start: formatDateTime(meeting.startMs), length: `${minutesOf(meeting.durationS)} min` })),
      ...input.captures.map(capture => ({ role: 'Capture', kind: 'G2', id: capture.sessionId, start: formatDateTime(capture.startMs), length: `${minutesOf(capture.durationMs / 1000)} min` })),
    ]),
    '',
  ]

  const captureSection = input.captures.length > 0
    ? ['## G2 Capture', '', ...input.captures.flatMap((capture, index) => [
        `### Capture ${index + 1} — ${formatClock(capture.startMs)}, ${minutesOf(capture.durationMs / 1000)} min`,
        '',
        ...captureLines(capture),
        '',
      ])]
    : []
  const alternateSection = alternates.length > 0
    ? ['## Alternate Transcript', '', ...alternates.flatMap(meeting => [
        `### Fireflies ${meeting.id}`,
        '',
        ...firefliesLines(meeting.sentences),
        '',
      ])]
    : []
  const transcript = ['## Transcript', '', ...firefliesLines(input.primary.sentences, attribution.labels), '']

  const sidecar: DerivedSidecar = {
    version: DERIVED_SIDECAR_VERSION,
    actionId: input.actionId,
    kind: 'merge',
    inputs: fingerprintsOf([input.primary, ...alternates], input.captures),
    tier: input.tier,
    evidence: { K1: input.evidence.k1, K2: input.evidence.k2 },
    offsetMs: alignments[0]?.alignment.offsetMs ?? null,
    anchors: alignments[0]?.alignment.anchors ?? 0,
    mad: alignments[0]?.alignment.madMs ?? null,
    attribution: alignments[0] ? attributionStateOf(alignments[0].alignment, mode) : 'unaligned',
    alignments: alignments.map(entry => ({
      sessionId: entry.capture.sessionId,
      offsetMs: entry.alignment.offsetMs,
      anchors: entry.alignment.anchors,
      madMs: entry.alignment.madMs,
      attribution: attributionStateOf(entry.alignment, mode),
    })),
    labels: attribution.labels.map(label => ({
      index: label.index,
      ffLabel: label.ffLabel,
      g2Label: label.g2Label,
      share: label.share,
      similarity: label.similarity,
      windowOffsetMs: label.windowOffsetMs,
      outcome: label.outcome,
    })),
    conflicts: attribution.conflicts,
    pieces: [],
  }

  return finish(
    [...head, ...summary, ...items, ...attendeeSection, ...sources],
    [captureSection, alternateSection],
    transcript,
    sidecar,
    attribution.verification,
    input.limits,
  )
}

/** Build one piece of a split recording. */
export function renderSplitPiece(input: PieceDeriveInput): DeriveResult {
  const mode = input.attributeMode ?? ATTRIBUTE_MODE
  const startS = input.piece.startS
  const endS = input.piece.endS
  const sentences = input.source.sentences.filter(sentence => {
    const at = Number(sentence.start_time ?? 0) || 0
    return at >= startS && at < endS
  })
  const shifted: FirefliesSentenceInput[] = sentences.map(sentence => ({
    ...sentence,
    start_time: (Number(sentence.start_time ?? 0) || 0) - startS,
    end_time: (Number(sentence.end_time ?? 0) || 0) - startS,
  }))
  const pieceMeeting: FirefliesMeetingInput = {
    ...input.source,
    startMs: input.source.startMs + startS * 1000,
    durationS: Math.max(0, endS - startS),
    sentences: shifted,
  }
  const alignments = input.captures.map(capture => {
    const { words } = g2TimedWords(capture)
    return { capture, alignment: alignRecording(words, shifted, capture.startMs - pieceMeeting.startMs) }
  })
  const attribution = attributeSentences(
    shifted,
    alignments.map(entry => ({ sessionId: entry.capture.sessionId, alignment: entry.alignment, labels: labelIntervals(entry.capture) })),
    mode,
  )

  const title = `${input.source.title?.trim() || 'Recording'} (part ${input.piece.index + 1} of ${input.pieceCount})`
  const head = [
    `# ${title}`,
    '',
    ...fieldTable([
      ['Date', formatDateTime(pieceMeeting.startMs)],
      ['Duration', `${minutesOf(pieceMeeting.durationS)} minutes`],
      ['Source', SPLIT_SOURCE_LABEL],
      ['Domain', DERIVED_DOMAIN],
      ['Speaker Verification', verificationRow(attribution.verification)],
    ]),
    '',
  ]
  const attendees = attendeeUnion(pieceMeeting, [], input.captures, attribution.labels)
  const attendeeSection = attendees.length > 0 ? ['## Attendees', '', ...attendees.map(name => `- ${name}`), ''] : []
  const sources = [
    '## Sources',
    '',
    ...sourcesTable([
      { role: `Long recording, part ${input.piece.index + 1} of ${input.pieceCount}`, kind: 'Fireflies', id: input.source.id, start: formatDateTime(input.source.startMs), length: `${minutesOf(input.source.durationS)} min` },
      ...input.captures.map(capture => ({ role: 'Capture', kind: 'G2', id: capture.sessionId, start: formatDateTime(capture.startMs), length: `${minutesOf(capture.durationMs / 1000)} min` })),
    ]),
    '',
  ]
  const captureSection = input.captures.length > 0
    ? ['## G2 Capture', '', ...input.captures.flatMap((capture, index) => [
        `### Capture ${index + 1} — ${formatClock(capture.startMs)}, ${minutesOf(capture.durationMs / 1000)} min`,
        '',
        ...captureLines(capture),
        '',
      ])]
    : []
  const transcript = ['## Transcript', '', ...firefliesLines(shifted, attribution.labels), '']

  const sidecar: DerivedSidecar = {
    version: DERIVED_SIDECAR_VERSION,
    actionId: input.actionId,
    kind: 'split',
    inputs: fingerprintsOf([input.source], input.captures),
    tier: input.tier,
    evidence: { K1: 0, K2: 0 },
    offsetMs: alignments[0]?.alignment.offsetMs ?? null,
    anchors: alignments[0]?.alignment.anchors ?? 0,
    mad: alignments[0]?.alignment.madMs ?? null,
    attribution: alignments[0] ? attributionStateOf(alignments[0].alignment, mode) : 'unaligned',
    alignments: alignments.map(entry => ({
      sessionId: entry.capture.sessionId,
      offsetMs: entry.alignment.offsetMs,
      anchors: entry.alignment.anchors,
      madMs: entry.alignment.madMs,
      attribution: attributionStateOf(entry.alignment, mode),
    })),
    labels: attribution.labels.map(label => ({
      index: label.index,
      ffLabel: label.ffLabel,
      g2Label: label.g2Label,
      share: label.share,
      similarity: label.similarity,
      windowOffsetMs: label.windowOffsetMs,
      outcome: label.outcome,
    })),
    conflicts: attribution.conflicts,
    pieces: [input.piece],
  }

  return finish([...head, ...attendeeSection, ...sources], [captureSection], transcript, sidecar, attribution.verification, input.limits)
}

// ── The pipeline patch (6.47.0, WS4, apply mode) ──────────────────────────────
//
// WHY A PATCH AND NOT A FILE (v3 blocker 11). In apply mode the merged content goes into a
// scribe the COS pipeline already wrote, and that scribe is RICHER than anything this
// module renders: an LLM summary, decisions, action items, notes, a domain folder and a
// title a person may have corrected. Handing the pipeline a whole file would replace all of
// it with a thinner one. The engine emits only what it ADDS, and the pipeline splices.
//
// The row forms below are the ones the private blend already writes
// (`sync_meetings.py:1934-1968`), not new ones, so a merged scribe is indistinguishable
// from a hand-blended one to every existing reader.

/** The Source row a blended operations scribe carries. Source order is the pipeline's. */
export const PIPELINE_SOURCES_LABEL = 'Fireflies + G2 Glasses'

/** Stamped on a blended scribe by the old path and by this one; the old path reads it. */
export const MARKER_BLENDED = '<!-- g2-transcript-blended -->'
export const MARKER_MERGE_ACTION_PREFIX = '<!-- merge-action: '
export const MARKER_G2_SESSION_PREFIX = '<!-- g2-session: '
export const MARKER_G2_SOURCE_PREFIX = '<!-- g2-source: '

/**
 * The `g2-source` marker, in the form the COS pipeline already writes
 * (`sync_meetings.py`, `g2_source_marker()`): the sidecar's BASENAME, with any `--` escaped
 * to `- -`.
 *
 * WHY THE BASENAME AND NOT THE OPERATIONS-RELATIVE PATH. The pipeline's own blend
 * verification compares the marker it finds against the marker it would write, and it writes
 * the basename. A server-written marker carrying a full relative path is therefore a marker
 * the pipeline reads as "not mine", which makes `blend_verified` fail and lets a later
 * refresh append a second G2 Capture section to a scribe that already has one.
 *
 * WHY `--` HAS TO GO. `--` cannot appear inside an HTML comment: a strict parser rejects the
 * whole document, and an iCloud-conflict name (`x 2.g2-chunks.json`) is not the only way a
 * meeting filename acquires one. The pipeline escapes it, so this does too, byte for byte.
 *
 * The operations-relative path is NOT lost: it stays in the decision's inputs
 * (`sidecarRelPath`) and in the derived sidecar, which is where a reader that needs to open
 * the file looks.
 */
export function g2SourceMarker(sidecarRelPath: string): string {
  const base = sidecarRelPath.split('/').pop() ?? sidecarRelPath
  return `${MARKER_G2_SOURCE_PREFIX}${base.replace(/--/g, '- -')} -->`
}

/**
 * A generic Fireflies label is mapped to a G2 name only when that name holds the label
 * nearly outright.
 *
 * WHY BOTH A SHARE AND A FLOOR ON COUNT. The map is applied to EVERY line carrying that
 * label, including lines no capture covered, so it is an assertion about the whole speaker
 * rather than about the sentences that were measured. A 100% agreement over two sentences is
 * not evidence of that; 70% over five is the weakest thing that is.
 */
export const SPEAKER_MAP_MIN_SHARE = 0.7
export const SPEAKER_MAP_MIN_SENTENCES = 5

export interface PipelineSpeakerMapEntry {
  name: string
  similarity: number
  sentences: number
}

export interface PipelinePatch {
  /** Markdown inserted before `## Transcript`, in order. */
  sections: string[]
  /** Metadata-table rows, as whole lines. */
  rows: string[]
  /** Comment markers appended to the scribe. */
  markers: string[]
  /** `{ firefliesLabel: { name, similarity, sentences } }` for generic labels only. */
  speakerMap: Record<string, PipelineSpeakerMapEntry>
  /** What the Speaker Verification row says, for Control to render without re-parsing. */
  verification: SpeakerVerification[]
}

export interface PipelinePatchInput extends MergeDeriveInput {
  /** Operations-relative `.g2-chunks.json` path per capture, for the `g2-source` marker. */
  sidecarRelPathBySession?: Record<string, string>
}

/**
 * Build the patch the pipeline splices into an existing Fireflies scribe.
 *
 * It runs the SAME alignment and attribution as `renderMergedRecord`, so a record derived in
 * imports mode and a scribe blended in apply mode carry identical speaker conclusions. What
 * differs is only what is emitted: additions, never a replacement.
 */
export function renderPipelinePatch(input: PipelinePatchInput): PipelinePatch {
  const alternates = input.alternates ?? []
  const mode = input.attributeMode ?? ATTRIBUTE_MODE
  const alignments = input.captures.map(capture => {
    const { words } = g2TimedWords(capture)
    const coarse = input.coarseOffsetMsBySession?.[capture.sessionId]
      ?? (capture.startMs - input.primary.startMs)
    return { capture, alignment: alignRecording(words, input.primary.sentences, coarse) }
  })
  const attribution = attributeSentences(
    input.primary.sentences,
    alignments.map(entry => ({ sessionId: entry.capture.sessionId, alignment: entry.alignment, labels: labelIntervals(entry.capture) })),
    mode,
  )

  const sections: string[] = []
  if (input.captures.length > 0) {
    sections.push(sectionsOf(['## G2 Capture', '', ...input.captures.flatMap((capture, index) => [
      `### Capture ${index + 1} — ${formatClock(capture.startMs)}, ${minutesOf(capture.durationMs / 1000)} min`,
      '',
      ...captureLines(capture),
      '',
    ])]))
  }
  if (alternates.length > 0) {
    sections.push(sectionsOf(['## Alternate Transcript', '', ...alternates.flatMap(meeting => [
      `### Fireflies ${meeting.id}`,
      '',
      ...firefliesLines(meeting.sentences),
      '',
    ])]))
  }

  const rows = [
    `| **Sources** | ${PIPELINE_SOURCES_LABEL} |`,
    `| **Speaker Verification** | ${verificationRow(attribution.verification)} |`,
  ]

  const markers = [
    MARKER_BLENDED,
    ...input.captures.flatMap(capture => {
      const relPath = input.sidecarRelPathBySession?.[capture.sessionId]
      return [
        ...(relPath ? [g2SourceMarker(relPath)] : []),
        `${MARKER_G2_SESSION_PREFIX}${capture.sessionId} -->`,
      ]
    }),
    `${MARKER_MERGE_ACTION_PREFIX}${input.actionId} -->`,
  ]

  return {
    sections,
    rows,
    markers,
    speakerMap: speakerMapFrom(attribution.labels),
    verification: attribution.verification,
  }
}

/**
 * One G2 name per generic Fireflies label, where the evidence is overwhelming.
 *
 * Only GENERIC labels are mapped. A Fireflies label that already names a person is a name a
 * person's calendar or a human gave, and D13's rule that a voiceprint never overwrites a
 * human name is enforced here as well as in `attribute.ts`.
 */
export function speakerMapFrom(labels: readonly SentenceLabel[]): Record<string, PipelineSpeakerMapEntry> {
  const byLabel = new Map<string, { total: number; names: Map<string, { count: number; similarities: number[] }> }>()
  for (const label of labels) {
    if (!isGenericLabel(label.ffLabel)) continue
    const entry = byLabel.get(label.ffLabel) ?? { total: 0, names: new Map() }
    entry.total += 1
    if (label.g2Label && !isGenericLabel(label.g2Label)) {
      const name = entry.names.get(label.g2Label) ?? { count: 0, similarities: [] }
      name.count += 1
      name.similarities.push(label.similarity)
      entry.names.set(label.g2Label, name)
    }
    byLabel.set(label.ffLabel, entry)
  }

  const map: Record<string, PipelineSpeakerMapEntry> = {}
  for (const [ffLabel, entry] of [...byLabel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (entry.names.size !== 1) continue
    const [name, stats] = [...entry.names.entries()][0]
    if (stats.count < SPEAKER_MAP_MIN_SENTENCES) continue
    if (entry.total === 0 || stats.count / entry.total < SPEAKER_MAP_MIN_SHARE) continue
    map[ffLabel] = {
      name,
      similarity: Number(median(stats.similarities).toFixed(2)),
      sentences: stats.count,
    }
  }
  return map
}

/**
 * Assemble, and move the attached transcripts to the sidecar rather than lose them when the
 * markdown is too big for its readers. Failing loudly beats writing a record that silently
 * dropped a source.
 */
function finish(
  head: string[],
  attachable: string[][],
  transcript: string[],
  sidecar: DerivedSidecar,
  verification: SpeakerVerification[],
  limits: RenderLimits | undefined,
): DeriveResult {
  const markdownMax = limits?.markdownMaxBytes ?? MARKDOWN_MAX_BYTES
  const sidecarMax = limits?.sidecarMaxBytes ?? DERIVED_SIDECAR_MAX_BYTES
  const attached = attachable.filter(section => section.length > 0)
  let markdown = sectionsOf([...head, ...attached.flat(), ...transcript])
  let record: DerivedSidecar = sidecar
  if (byteLength(markdown) > markdownMax && attached.length > 0) {
    const overflow = attached.map(section => sectionsOf(section))
    record = { ...sidecar, overflow: { sections: overflow } }
    markdown = sectionsOf([
      ...head,
      '## Attached Transcripts',
      '',
      `Kept in the sidecar: this record is over ${markdownMax} bytes of markdown.`,
      '',
      ...transcript,
    ])
  }
  const sidecarBytes = byteLength(JSON.stringify(record))
  const markdownBytes = byteLength(markdown)
  if (markdownBytes > markdownMax || sidecarBytes > sidecarMax) {
    return { ok: false, error: 'derived_too_large', markdownBytes, sidecarBytes }
  }
  return { ok: true, record: { markdown, sidecar: record, verification } }
}
