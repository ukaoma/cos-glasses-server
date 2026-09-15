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
} from './evidence.js'
import { type AttributionState, type Alignment, alignRecording } from './align.js'
import {
  type AttributeMode,
  type SentenceLabel,
  type SpeakerVerification,
  ATTRIBUTE_MODE,
  attributeSentences,
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
