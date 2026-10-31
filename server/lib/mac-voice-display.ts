// 6.96.3: how a saved Mac recording's anonymous voices are DISPLAYED in speaker review.
//
// WHY. One real call returned 61 rows from GET /meeting/:sessionId/speakers: 58 `Voice N`, Ext and two
// names. Speaker shadow already logged, for that call, which of those voices its gates would merge
// (speaker-shadow.ts, proposals.accepted). Miles approved showing that at read time: merged groups
// first, then one expandable row for voices under 15 s after merging. Display only.
//
// WHAT THIS IS NOT. It writes nothing and applies nothing: no label, name, sample, packet or sidecar
// changes, and the words stay one click away under the same labels. There is no flag. The field exists
// only when this Mac has a `proposed` shadow record for this session, so a Mac with shadow off answers
// exactly what it answered before.
//
// THE RESPONSE WINS OVER THE RECORD. The record is a log from when the meeting finished; the labels in
// the current response are the truth. A voice named since then leaves its group, and a current voice the
// record never saw still gets a row. Every anonymous label in the response lands in exactly one bucket.
//
// FAILS TO ABSENT. Any malformed record, unreadable store or unexpected value omits the field, which
// means Control shows what it shows today. Nothing here throws.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isVoiceLabel } from './mac-voice-labels.js'
import { readSpeakerShadowRecords, SPEAKER_SHADOW_RECORDS } from './speaker-shadow.js'
import { speakerShadowRoot } from './speaker-shadow-models.js'

/** A voice with less known speech than this, after merging, folds into the one expandable row. */
export const VOICE_DISPLAY_FOLD_UNDER_SECONDS = 15 as const
/** Past this the store is not read at all. At 12 runs a day it is about two years of records. */
const MAX_STORE_BYTES = 256 * 1024 * 1024
const MAX_RECORDS_PER_SESSION = 100
const EVIDENCE_CACHE_MAX = 32

export interface VoiceDisplay {
  source: 'speaker-shadow'
  recordedAt: string
  foldUnderSeconds: typeof VOICE_DISPLAY_FOLD_UNDER_SECONDS
  /** Two or more labels, largest first. */
  groups: Array<{ id: string; labels: string[]; seconds: number | null }>
  /** 15 s or more, or unknown duration. */
  singles: Array<{ label: string; seconds: number | null }>
  /** Known duration under 15 s after merging. */
  short: Array<{ label: string; seconds: number }>
}

/** The parts of one shadow record display needs. Validated once, so building a view cannot fail. */
export interface VoiceDisplayEvidence {
  recordedAt: string
  groups: Array<{ id: string; labels: string[] }>
  seconds: ReadonlyMap<string, number>
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Null on any problem at all. A label may appear once across the whole record. */
export function voiceDisplayEvidence(record: unknown): VoiceDisplayEvidence | null {
  if (!isRecord(record) || record.status !== 'proposed' || typeof record.recordedAt !== 'string' || !record.recordedAt) return null
  const proposals = record.proposals
  if (!isRecord(proposals)) return null
  const { accepted, rejected, untouched } = proposals
  if (!Array.isArray(accepted) || !Array.isArray(rejected) || !Array.isArray(untouched)) return null

  const seconds = new Map<string, number>()
  const seen = new Set<string>()
  const claim = (label: unknown): label is string => {
    if (typeof label !== 'string' || seen.has(label)) return false
    seen.add(label)
    return true
  }
  const groups: VoiceDisplayEvidence['groups'] = []
  const ids = new Set<string>()
  for (const group of accepted) {
    if (!isRecord(group) || typeof group.cluster !== 'string' || !group.cluster || ids.has(group.cluster)) return null
    ids.add(group.cluster)
    if (!Array.isArray(group.merge) || !Array.isArray(group.voices)) return null
    const labels: string[] = []
    for (const label of [group.keepLabel, ...group.merge]) {
      if (!claim(label)) return null
      labels.push(label)
    }
    for (const row of group.voices) {
      if (!isRecord(row) || typeof row.voice !== 'string' || !labels.includes(row.voice) || !validSeconds(row.seconds)) return null
      seconds.set(row.voice, row.seconds)
    }
    groups.push({ id: `shadow-${group.cluster}`, labels })
  }
  for (const row of [...rejected, ...untouched]) {
    if (!isRecord(row) || !claim(row.voice) || !validSeconds(row.seconds)) return null
    seconds.set(row.voice, row.seconds)
  }
  return { recordedAt: record.recordedAt, groups, seconds }
}

const bySecondsThenLabel = (a: { seconds: number | null; key: string }, b: { seconds: number | null; key: string }): number => {
  if (a.seconds === null && b.seconds !== null) return 1
  if (a.seconds !== null && b.seconds === null) return -1
  if (a.seconds !== null && b.seconds !== null && a.seconds !== b.seconds) return b.seconds - a.seconds
  return a.key.localeCompare(b.key, 'en', { numeric: true })
}

/** Pure. `currentLabels` is the label of every row in the response being answered. */
export function buildVoiceDisplay(evidence: VoiceDisplayEvidence, currentLabels: readonly string[]): VoiceDisplay {
  const current = new Set(currentLabels.filter(isVoiceLabel))
  const secondsOf = (label: string): number | null => evidence.seconds.get(label) ?? null
  const groups: VoiceDisplay['groups'] = []
  const singles: VoiceDisplay['singles'] = []
  const short: VoiceDisplay['short'] = []
  const place = (label: string): void => {
    const seconds = secondsOf(label)
    if (seconds !== null && seconds < VOICE_DISPLAY_FOLD_UNDER_SECONDS) short.push({ label, seconds })
    else singles.push({ label, seconds })
  }

  const grouped = new Set<string>()
  for (const group of evidence.groups) {
    const labels = group.labels.filter(label => current.has(label))
    for (const label of labels) grouped.add(label)
    if (labels.length === 1) place(labels[0])
    else if (labels.length >= 2) {
      const known = labels.map(secondsOf)
      const seconds = known.every((s): s is number => s !== null)
        ? Math.round(known.reduce((sum, s) => sum + s, 0) * 100) / 100
        : null
      groups.push({ id: group.id, labels, seconds })
    }
  }
  for (const label of current) if (!grouped.has(label)) place(label)

  groups.sort((a, b) => bySecondsThenLabel({ seconds: a.seconds, key: a.labels[0] }, { seconds: b.seconds, key: b.labels[0] }))
  singles.sort((a, b) => bySecondsThenLabel({ seconds: a.seconds, key: a.label }, { seconds: b.seconds, key: b.label }))
  short.sort((a, b) => bySecondsThenLabel({ seconds: a.seconds, key: a.label }, { seconds: b.seconds, key: b.label }))
  return { source: 'speaker-shadow', recordedAt: evidence.recordedAt, foldUnderSeconds: VOICE_DISPLAY_FOLD_UNDER_SECONDS, groups, singles, short }
}

/**
 * Who a voice suggestion is for: one entry per group, single and short row when there is a display,
 * otherwise one per anonymous label. Ext and names never appear, on either path.
 */
export function voiceDisplayScopes(display: VoiceDisplay | null, currentLabels: readonly string[]): string[][] {
  if (!display) return [...new Set(currentLabels.filter(isVoiceLabel))].map(label => [label])
  return [
    ...display.groups.map(group => group.labels),
    ...display.singles.map(row => [row.label]),
    ...display.short.map(row => [row.label]),
  ]
}

// Keyed on every proposal file's name, size and mtime. /speakers is opened again and again on one
// meeting; a session with no record would otherwise scan the whole store each time.
const evidenceCache = new Map<string, { signature: string; evidence: VoiceDisplayEvidence | null }>()

export function __clearVoiceDisplayCacheForTests(): void { evidenceCache.clear() }

async function storeSignature(root: string): Promise<string | null> {
  const names = (await readdir(root)).filter(name => name === SPEAKER_SHADOW_RECORDS || /^proposals-[0-9TZ-]+\.jsonl$/.test(name)).sort()
  if (names.length === 0) return null
  let total = 0
  const parts: string[] = []
  for (const name of names) {
    const info = await stat(join(root, name))
    total += info.size
    parts.push(`${name}:${info.size}:${info.mtimeMs}`)
  }
  return total > MAX_STORE_BYTES ? null : parts.join('|')
}

/** The latest `proposed` record for a session. Null when there is none or anything about it is off. Never throws. */
export async function readVoiceDisplayEvidence(sessionId: string, root: string = speakerShadowRoot()): Promise<VoiceDisplayEvidence | null> {
  try {
    const signature = await storeSignature(root)
    if (signature === null) return null
    const key = `${root}\u0000${sessionId}`
    const cached = evidenceCache.get(key)
    if (cached?.signature === signature) return cached.evidence
    const records = await readSpeakerShadowRecords(root, { sessionId, limit: MAX_RECORDS_PER_SESSION })
    const latest = records.find(record => record.status === 'proposed')
    const evidence = latest ? voiceDisplayEvidence(latest) : null
    evidenceCache.delete(key)
    evidenceCache.set(key, { signature, evidence })
    while (evidenceCache.size > EVIDENCE_CACHE_MAX) evidenceCache.delete(evidenceCache.keys().next().value as string)
    return evidence
  } catch {
    return null
  }
}

/** The optional `voiceDisplay` field. Null means leave it out. Never throws. */
export async function readVoiceDisplay(sessionId: string, currentLabels: readonly string[], root: string = speakerShadowRoot()): Promise<VoiceDisplay | null> {
  try {
    const evidence = await readVoiceDisplayEvidence(sessionId, root)
    return evidence ? buildVoiceDisplay(evidence, currentLabels) : null
  } catch {
    return null
  }
}
