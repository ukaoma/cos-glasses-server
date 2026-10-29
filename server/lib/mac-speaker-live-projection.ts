// Label-only presentation of already-qualified Mac acoustic evidence. The writer
// authenticates native/profile receipts before calling this pure projection;
// source geometry is checked again here and the original ASR stays immutable.
import { createHash } from 'node:crypto'
import { isVoiceLabel } from './mac-voice-labels.js'
import { hasMacSpeakerProtectedRows } from './mac-speaker-protection.js'
import { checkSpeakerName } from './speaker-name.js'

export interface MacSpeakerLiveProjectionSpan {
  rawChunkIndex: number
  audioSHA256: string
  pcmSHA256: string
  /** Capture-absolute 16 kHz sample coordinates for one entire original. */
  startSample: number
  endSample: number
  identityId: string
  displayLabel: string
  profileName?: string
  evidenceIds: string[]
}
export interface MacSpeakerLiveSourceChunk {
  text: string
  speaker: string
  elapsed: number
  audioSha256?: string
  audioDurationMs?: number
}
export interface MacSpeakerLiveIndexedChunk<T extends MacSpeakerLiveSourceChunk = MacSpeakerLiveSourceChunk> { i: number; c: T }
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const HASH = /^[a-f0-9]{64}$/
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const anonymous = (v: unknown) => typeof v === 'string' && (['', 'Ext', 'Unknown', 'Unidentified'].includes(v) || isVoiceLabel(v))
const samples = (ms: unknown): number | null => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  const n = ms * 16, rounded = Math.round(n)
  return Number.isSafeInteger(rounded) && Math.abs(n - rounded) <= 1e-6 ? rounded : null
}
type Row = Record<string, unknown>
function canProject(c: MacSpeakerLiveSourceChunk): boolean {
  if (!anonymous(c.speaker) || hasMacSpeakerProtectedRows(c)) return false
  const root = c as unknown as Row
  if (root.overlap === true || root.mixedSpeakers === true) return false
  for (const key of ['segments', 'finalSegments', 'words']) {
    if (root[key] === undefined) continue
    if (!(root[key] as unknown[]).every(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const row = value as Row
      return row.overlap !== true && row.mixedSpeakers !== true
        && (key === 'words' && row.speaker === undefined || anonymous(row.speaker))
        // Different automatic Voice labels in one original are mixed evidence.
        && (row.speaker === undefined || row.speaker === c.speaker)
    })) return false
  }
  return true
}

export function projectMacSpeakerLiveChunks<T extends MacSpeakerLiveSourceChunk>(input: {
  captureId: string
  generation: string
  chunksIndexed: readonly MacSpeakerLiveIndexedChunk<T>[]
  projections: readonly MacSpeakerLiveProjectionSpan[]
}): {
  speakerProjectedChunksIndexed: MacSpeakerLiveIndexedChunk<T>[]
  effectiveOverlaySHA256: string
  sourceBindingSHA256: string
  appliedRawChunkIndices: number[]
  withheld: Array<{ rawChunkIndex: number; reason: string }>
} {
  if (!/^mac_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.captureId) || typeof input.generation !== 'string' || !input.generation.length || input.generation.length > 128
    || !Array.isArray(input.chunksIndexed) || input.chunksIndexed.length > 10_000 || !Array.isArray(input.projections) || input.projections.length > 10_000) throw Error('invalid Mac live projection envelope')
  const originals = [...input.chunksIndexed].sort((a, b) => a.i - b.i)
  const byIndex = new Map<number, MacSpeakerLiveIndexedChunk<T>>()
  for (const row of originals) {
    if (!row || !uint(row.i) || row.i >= 10_000 || byIndex.has(row.i) || !row.c || typeof row.c.text !== 'string' || !row.c.text.trim()
      || typeof row.c.speaker !== 'string' || samples(row.c.elapsed) === null) throw Error('invalid Mac live original chunks')
    byIndex.set(row.i, row)
  }
  const spans = new Map<number, MacSpeakerLiveProjectionSpan>(), labels = new Map<string, string>(), identities = new Map<string, string>()
  for (const p of input.projections) {
    if (!p || !uint(p.rawChunkIndex) || p.rawChunkIndex >= 10_000 || spans.has(p.rawChunkIndex) || !HASH.test(p.audioSHA256) || !HASH.test(p.pcmSHA256)
      || !uint(p.startSample) || !uint(p.endSample) || p.endSample <= p.startSample || p.endSample - p.startSample > 480_000
      || !/^acoustic_[a-f0-9]{16,64}$/.test(p.identityId) || !Array.isArray(p.evidenceIds) || p.evidenceIds.length < 2 || p.evidenceIds.length > 64
      || new Set(p.evidenceIds).size !== p.evidenceIds.length || p.evidenceIds.some((id: unknown) => typeof id !== 'string' || !/^[A-Za-z0-9_:-]{1,160}$/.test(id))
      || (p.profileName !== undefined ? !checkSpeakerName(p.profileName).ok || p.displayLabel !== p.profileName : !isVoiceLabel(p.displayLabel))) throw Error('invalid Mac live projection span')
    if (identities.has(p.identityId) && identities.get(p.identityId) !== p.displayLabel) throw Error('inconsistent Mac live identity label')
    identities.set(p.identityId, p.displayLabel)
    if (p.profileName === undefined) {
      if (labels.has(p.displayLabel) && labels.get(p.displayLabel) !== p.identityId) throw Error('duplicate Mac live voice label')
      labels.set(p.displayLabel, p.identityId)
    }
    spans.set(p.rawChunkIndex, p)
  }
  const ordered = [...spans.values()].sort((a, b) => a.startSample - b.startSample)
  if (ordered.some((p, i) => i > 0 && ordered[i - 1].endSample > p.startSample)) throw Error('overlapping Mac live originals')
  // Old Voice labels are scheduling hints, never acoustic identity. An unused
  // namespace prevents a newly settled group from swallowing unsupported rows.
  for (const row of originals) if (labels.has(row.c.speaker)) {
    const p = spans.get(row.i)
    if (!p || p.identityId !== labels.get(row.c.speaker) || !canProject(row.c)
      || row.c.audioSha256 !== p.audioSHA256 || samples(row.c.elapsed) !== p.startSample
      || samples(row.c.audioDurationMs) !== p.endSample - p.startSample) throw Error('Mac live voice label collides with original')
  }
  const withheld: Array<{ rawChunkIndex: number; reason: string }> = [], appliedRawChunkIndices: number[] = [], changes: unknown[] = []
  for (const p of input.projections) if (!byIndex.has(p.rawChunkIndex)) withheld.push({ rawChunkIndex: p.rawChunkIndex, reason: 'original_missing' })
  const projected = originals.map(({ i, c }) => {
    const next = structuredClone(c), p = spans.get(i)
    if (!p) return { i, c: next }
    const start = samples(c.elapsed), count = samples(c.audioDurationMs)
    let reason: string | undefined
    if (c.audioSha256 !== p.audioSHA256 || start !== p.startSample || count === null || count !== p.endSample - p.startSample) reason = 'original_binding_changed'
    else if (!canProject(c)) reason = 'protected_or_mixed_original'
    if (reason) { withheld.push({ rawChunkIndex: i, reason }); return { i, c: next } }
    next.speaker = p.displayLabel
    for (const key of ['segments', 'finalSegments', 'words']) {
      const rows = (next as unknown as Row)[key] as Row[] | undefined
      for (const row of rows ?? []) if (row.speaker !== undefined) row.speaker = p.displayLabel
    }
    appliedRawChunkIndices.push(i)
    // Do not include unrelated appended ASR in this digest. The writer advances
    // speakerRevision only when an effective claim changes, including withdrawal.
    changes.push({ i, source: sha(c), projection: p })
    return { i, c: next }
  })
  return { speakerProjectedChunksIndexed: projected, sourceBindingSHA256: sha({ captureId: input.captureId, generation: input.generation, originals }),
    effectiveOverlaySHA256: sha({ captureId: input.captureId, generation: input.generation, changes }), appliedRawChunkIndices, withheld }
}
