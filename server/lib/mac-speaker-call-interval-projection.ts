/** Pure derived presentation geometry. This module neither admits identities nor
 * authenticates native execution. Its caller must validate the bound recurrence
 * state/source before preparing support and qualify the resulting packet offline. */
import { createHash } from 'node:crypto'
import type { MacSpeaker256Group, MacSpeaker256State } from './mac-speaker-live-memory.js'
import { hasMacSpeakerProtectedRows, isMacSpeakerHumanProtected } from './mac-speaker-protection.js'
import { pyRoundInt } from './speaker-shadow-numeric.js'

type Doc = Record<string, any>
type RawBinding = MacSpeaker256State['rawBindings'][number]
export type MacSpeakerCallIntervalMembership = 'accepted-only' | 'native-exclusive-members'
export interface MacSpeakerCallNativeInterval { startSample: number; endSample: number; nativeCluster: string }
export interface MacSpeakerCallSupportInterval {
  identityId: string; rawChunkIndex: number; startSample: number; endSample: number
  audioSHA256: string; pcmSHA256: string; evidenceIds: string[]
  origin: 'accepted-interval' | 'native-exclusive-member'
}
export interface MacSpeakerCallIntervalSupport {
  version: 1; membership: MacSpeakerCallIntervalMembership
  sourceSHA256: string; nativeSHA256: string; timelinePCMSHA256: string; totalSamples: number
  rawUsedSamples: number[]; nativeIntervals: MacSpeakerCallNativeInterval[]
  intervals: MacSpeakerCallSupportInterval[]; supportSHA256: string
}
export interface MacSpeakerCallIntervalContext {
  rawBindings: readonly RawBinding[]; groups: readonly MacSpeaker256Group[]
  protectedRawChunkIndices: readonly number[]; displayLabels: Readonly<Record<string, string>>
}
/** Exact HQ words wholly supported by one accepted identity. These coordinates
 * are issued by the projector, never supplied as a caller's naming selector. */
export interface MacSpeakerCallHQWordBinding {
  batchIndex: number; wordIndex: number; identityId: string
  startElapsedMs: number; endElapsedMs: number; rawChunkIndices: number[]
  pieces: Array<{ rawChunkIndex: number; startSample: number; endSample: number; audioSHA256: string; pcmSHA256: string; originalRowSHA256: string }>
}
/** Source geometry for explicit human word review. It carries no acoustic
 * identity or admission claim and includes named/unknown source labels. */
export type MacSpeakerCallHQWordSource = Omit<MacSpeakerCallHQWordBinding, 'identityId'>
const HASH = /^[a-f0-9]{64}$/
const GENERIC = /^(?:Voice [1-9]\d?|Ext|Unknown|Unidentified(?: \d+)?|Speaker \d+)$/
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const fail = (reason: string): never => { throw new Error(`Mac call interval view: ${reason}`) }
const range = (lo: number, hi: number) => Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo >= 0 && hi > lo

/** Sweep ALL native clusters, including withheld identities. A competing native
 * cluster removes support even if it never passed recurrence admission. */
function exclusive(intervals: readonly MacSpeakerCallNativeInterval[]): MacSpeakerCallNativeInterval[] {
  const events = new Map<number, Array<[string, number]>>()
  for (const row of intervals) for (const [point, delta] of [[row.startSample, 1], [row.endSample, -1]]) {
    const list = events.get(point) ?? []; list.push([row.nativeCluster, delta]); events.set(point, list)
  }
  const points = [...events.keys()].sort((a, b) => a - b), active = new Map<string, number>(), out: MacSpeakerCallNativeInterval[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const lo = points[i], hi = points[i + 1]
    for (const [cluster, delta] of events.get(lo)!) { const count = (active.get(cluster) ?? 0) + delta; if (count) active.set(cluster, count); else active.delete(cluster) }
    if (active.size !== 1) continue
    const nativeCluster = active.keys().next().value!, prior = out.at(-1)
    if (prior?.nativeCluster === nativeCluster && prior.endSample === lo) prior.endSample = hi
    else out.push({ startSample: lo, endSample: hi, nativeCluster })
  }
  return out
}

function expectedIntervals(context: MacSpeakerCallIntervalContext, support: Omit<MacSpeakerCallIntervalSupport, 'intervals' | 'supportSHA256'>): MacSpeakerCallSupportInterval[] {
  const protectedRaw = new Set(context.protectedRawChunkIndices), admitted = new Map(context.groups.map(g => [g.nativeCluster, g]))
  if (admitted.size !== context.groups.length) fail('duplicate admitted native cluster')
  const native = exclusive(support.nativeIntervals), out: MacSpeakerCallSupportInterval[] = []
  const add = (g: MacSpeaker256Group, r: RawBinding, startSample: number, endSample: number, origin: MacSpeakerCallSupportInterval['origin']) => {
    if (protectedRaw.has(r.rawChunkIndex)) return
    if (!range(startSample, endSample) || startSample < r.startSample || endSample > r.startSample + support.rawUsedSamples[r.rawChunkIndex]) fail('unsupported raw sample range')
    out.push({ identityId: g.identityId, rawChunkIndex: r.rawChunkIndex, startSample, endSample, audioSHA256: r.audioSHA256, pcmSHA256: r.pcmSHA256, evidenceIds: g.witnesses.map(w => w.evidenceId), origin })
  }
  if (support.membership === 'accepted-only') {
    for (const g of context.groups) for (const span of g.intervals) {
      const r = context.rawBindings[span.rawChunkIndex]
      if (!r || span.identityId !== g.identityId || span.audioSHA256 !== r.audioSHA256 || span.pcmSHA256 !== r.pcmSHA256) fail('accepted interval binding')
      // Re-check exact native exclusivity instead of accepting a caller's span.
      const cover = native.find(n => n.nativeCluster === g.nativeCluster && n.startSample <= span.startSample && n.endSample >= span.endSample)
      if (!cover) fail('accepted interval outside exclusive native support')
      add(g, r, span.startSample, span.endSample, 'accepted-interval')
    }
  } else {
    for (const n of native) {
      const g = admitted.get(n.nativeCluster); if (!g) continue
      for (const r of context.rawBindings) {
        const lo = Math.max(n.startSample, r.startSample), hi = Math.min(n.endSample, r.startSample + support.rawUsedSamples[r.rawChunkIndex])
        if (hi > lo) add(g, r, lo, hi, 'native-exclusive-member')
      }
    }
  }
  return out.sort((a, b) => a.rawChunkIndex - b.rawChunkIndex || a.startSample - b.startSample || a.endSample - b.endSample || a.identityId.localeCompare(b.identityId))
}

function checkSource(context: MacSpeakerCallIntervalContext, support: Omit<MacSpeakerCallIntervalSupport, 'intervals' | 'supportSHA256'>): void {
  if (support.version !== 1 || !['accepted-only', 'native-exclusive-members'].includes(support.membership) || !HASH.test(support.sourceSHA256) || !HASH.test(support.nativeSHA256) || !HASH.test(support.timelinePCMSHA256) || !Number.isSafeInteger(support.totalSamples) || support.totalSamples <= 0 || support.totalSamples > 4 * 3600 * 16000) fail('support identity')
  if (!Array.isArray(support.rawUsedSamples) || support.rawUsedSamples.length !== context.rawBindings.length || !Array.isArray(support.nativeIntervals) || support.nativeIntervals.length > 20000 || context.rawBindings.length > 6000 || context.groups.length > 99) fail('support bounds')
  for (const [i, r] of context.rawBindings.entries()) if (r.rawChunkIndex !== i || !HASH.test(r.audioSHA256) || !HASH.test(r.pcmSHA256) || !HASH.test(r.originalRowSHA256) || !range(r.startSample, r.endSample) || r.endSample > support.totalSamples || !Number.isSafeInteger(support.rawUsedSamples[i]) || support.rawUsedSamples[i] <= 0 || support.rawUsedSamples[i] > r.endSample - r.startSample) fail('raw PCM binding')
  if (new Set(context.protectedRawChunkIndices).size !== context.protectedRawChunkIndices.length || context.protectedRawChunkIndices.some(i => !Number.isInteger(i) || !context.rawBindings[i])) fail('protected source indices')
  // The used prefix must be the actual reconstructed raw intersection. A packet
  // cannot hide an overlapping raw tail by supplying a larger usable count.
  const ordered = [...context.rawBindings].sort((a, b) => a.startSample - b.startSample || a.rawChunkIndex - b.rawChunkIndex)
  if (!ordered.length || Math.max(...ordered.map(r => r.endSample)) !== support.totalSamples) fail('timeline sample bound')
  for (const [i, r] of ordered.entries()) if (support.rawUsedSamples[r.rawChunkIndex] !== Math.min(r.endSample - r.startSample, i + 1 < ordered.length ? ordered[i + 1].startSample - r.startSample : Infinity)) fail('raw used-sample geometry')
  for (const n of support.nativeIntervals) if (!range(n.startSample, n.endSample) || n.endSample > support.totalSamples || typeof n.nativeCluster !== 'string' || !n.nativeCluster || n.nativeCluster.length > 100) fail('native geometry')
  const identities = new Set<string>(), labels = new Set<string>()
  for (const g of context.groups) {
    const label = context.displayLabels[g.identityId]
    if (!/^fluid256_[a-f0-9]{64}$/.test(g.identityId) || identities.has(g.identityId) || typeof label !== 'string' || !/^Anonymous group [1-9]\d{0,5}$/.test(label) || labels.has(label)) fail('anonymous identity namespace')
    if (!Array.isArray(g.witnesses) || g.witnesses.length !== 2 || g.witnesses.some(w => !HASH.test(w.evidenceId) || !range(w.startSample, w.endSample) || !w.rawChunkIndices.length || w.rawChunkIndices.length !== w.pcmSHA256s.length || w.pcmSHA256s.some(h => !HASH.test(h)))) fail('missing identity witnesses')
    const [a, b] = g.witnesses
    if (a.startSample < b.endSample && b.startSample < a.endSample || a.rawChunkIndices.some(i => b.rawChunkIndices.includes(i)) || a.pcmSHA256s.some(h => b.pcmSHA256s.includes(h))) fail('dependent identity witnesses')
    identities.add(g.identityId); labels.add(label)
  }
  if (Object.keys(context.displayLabels).length !== identities.size) fail('display identity cardinality')
}

/** Only call after full-source/state validation in the trusted offline producer.
 * Hashes bind the supplied source; they are not a native-authentication grant. */
export function prepareMacSpeakerCallIntervalSupport(context: MacSpeakerCallIntervalContext, source: Omit<MacSpeakerCallIntervalSupport, 'intervals' | 'supportSHA256'>): MacSpeakerCallIntervalSupport {
  checkSource(context, source)
  const body = { ...structuredClone(source), intervals: expectedIntervals(context, source) }
  if (body.intervals.length > 40000) fail('interval bound')
  return { ...body, supportSHA256: digest(body) }
}

/** Reconstruct support from the bound packet geometry and admitted groups. A
 * missing, expanded, reidentified or rehashed arbitrary interval list refuses. */
export function validateMacSpeakerCallIntervalSupport(context: MacSpeakerCallIntervalContext, support: MacSpeakerCallIntervalSupport): void {
  if (!support || !Array.isArray(support.intervals) || support.intervals.length > 40000) fail('missing support')
  const { supportSHA256, ...body } = support
  if (!HASH.test(supportSHA256) || digest(body) !== supportSHA256) fail('support hash')
  checkSource(context, support)
  if (digest(expectedIntervals(context, support)) !== digest(support.intervals)) fail('support reconstruction')
}

/** Build a closed-over validated projector, avoiding caller-made label maps or
 * mutable projections after validation. The output is a clone; BASE is untouched. */
export function createMacSpeakerCallIntervalProjector(contextInput: MacSpeakerCallIntervalContext, supportInput: MacSpeakerCallIntervalSupport) {
  validateMacSpeakerCallIntervalSupport(contextInput, supportInput)
  const context = structuredClone(contextInput), support = structuredClone(supportInput), protectedRaw = new Set(context.protectedRawChunkIndices)
  const labels = context.displayLabels, byRaw = new Map<number, MacSpeakerCallSupportInterval[]>()
  for (const s of support.intervals) { const list = byRaw.get(s.rawChunkIndex) ?? []; list.push(s); byRaw.set(s.rawChunkIndex, list) }
  const identityFor = (raw: number, lo: number, hi: number): string | null => {
    const r = context.rawBindings[raw]
    if (!r || protectedRaw.has(raw) || !range(lo, hi) || lo < r.startSample || hi > r.endSample) return null
    let end = lo, identity: string | null = null
    for (const s of byRaw.get(raw) ?? []) {
      if (s.endSample <= lo || s.startSample >= hi) continue
      if (identity && identity !== s.identityId || s.startSample > end) return null
      identity = s.identityId; end = Math.max(end, s.endSample)
    }
    return end >= hi ? identity : null
  }
  const eligible = (r: Doc) => !!r && typeof r.speaker === 'string' && GENERIC.test(r.speaker) && !isMacSpeakerHumanProtected(r)
  const samples = (start: unknown, end: unknown): [number, number] | null => {
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null
    if (!Number.isFinite(start * 16000) || !Number.isFinite(end * 16000)) return null
    const lo = pyRoundInt(start * 16000), hi = pyRoundInt(end * 16000)
    return range(lo, hi) ? [lo, hi] : null
  }
  // Presentation and human-review scopes must share this exact geometry. In
  // particular a word crossing raw files cannot jump a gap or an overlap.
  const hqSourceGeometry = (base: Doc): { usableHQWords: number; words: MacSpeakerCallHQWordSource[] } => {
    let usableHQWords = 0
    const words: MacSpeakerCallHQWordSource[] = []
    for (const [batchIndex, batch] of (base.batchSegments ?? []).entries()) {
      if (!Number.isInteger(batch.startChunkIdx) || !Number.isInteger(batch.endChunkIdx) || batch.startChunkIdx < 0 || batch.endChunkIdx < batch.startChunkIdx || batch.endChunkIdx >= context.rawBindings.length || !Array.isArray(batch.speakerWords)) fail('batch geometry')
      const clock: Array<{ raw: number; lo: number; hi: number }> = []; let offset = 0
      for (let raw = batch.startChunkIdx; raw <= batch.endChunkIdx; raw++) { const r = context.rawBindings[raw], n = r.endSample - r.startSample; clock.push({ raw, lo: offset, hi: offset + n }); offset += n }
      for (const [wordIndex, word] of batch.speakerWords.entries()) {
        if (typeof word?.word !== 'string' || !word.word.trim()) continue
        const span = samples(word?.start, word?.end)
        if (!span || span[1] > offset) continue
        usableHQWords++
        if (isMacSpeakerHumanProtected(word)) continue
        const [lo, hi] = span
        let left = 0, right = clock.length
        while (left < right) { const mid = (left + right) >>> 1; if (clock[mid].hi <= lo) left = mid + 1; else right = mid }
        let captureEnd: number | null = null, covered = 0, valid = true
        const pieces: MacSpeakerCallHQWordBinding['pieces'] = []
        for (let i = left; i < clock.length && clock[i].lo < hi; i++) {
          const part = clock[i], r = context.rawBindings[part.raw], a = r.startSample + Math.max(0, lo - part.lo), b = r.startSample + Math.min(part.hi - part.lo, hi - part.lo)
          if (protectedRaw.has(part.raw) || b > r.startSample + support.rawUsedSamples[part.raw] || captureEnd !== null && captureEnd !== a) { valid = false; break }
          captureEnd = b; covered += b - a
          pieces.push({ rawChunkIndex: part.raw, startSample: a, endSample: b, audioSHA256: r.audioSHA256, pcmSHA256: r.pcmSHA256, originalRowSHA256: r.originalRowSHA256 })
        }
        if (valid && pieces.length && covered === hi - lo) words.push({ batchIndex, wordIndex, startElapsedMs: pieces[0].startSample / 16, endElapsedMs: pieces.at(-1)!.endSample / 16, rawChunkIndices: pieces.map(p => p.rawChunkIndex), pieces })
      }
    }
    return { usableHQWords, words }
  }
  const hqGeometry = (base: Doc): { usableHQWords: number; words: MacSpeakerCallHQWordBinding[] } => {
    const source = hqSourceGeometry(base), words: MacSpeakerCallHQWordBinding[] = []
    for (const word of source.words) {
      if (!eligible(base.batchSegments[word.batchIndex].speakerWords[word.wordIndex])) continue
      let identity: string | null = null, valid = true
      for (const piece of word.pieces) {
        const id = identityFor(piece.rawChunkIndex, piece.startSample, piece.endSample)
        if (!id || identity && identity !== id) { valid = false; break }
        identity = id
      }
      if (valid && identity) words.push({ ...word, identityId: identity })
    }
    return { usableHQWords: source.usableHQWords, words }
  }
  return {
    identityFor,
    hqWords(base: Doc): MacSpeakerCallHQWordBinding[] { return hqGeometry(base).words },
    hqWordSources(base: Doc): MacSpeakerCallHQWordSource[] { return hqSourceGeometry(base).words },
    project(base: Doc) {
      const doc = structuredClone(base), changedRaw = new Set<number>()
      let position = 0
      for (const e of doc.chunkEntries) {
        const raw = e.chunkIndex, c = e.chunk, r = context.rawBindings[raw]
        if (typeof c.text !== 'string' || !c.text.trim()) continue
        const root = doc.chunks[position++]
        if (!root || !r || protectedRaw.has(raw) || hasMacSpeakerProtectedRows(c) || hasMacSpeakerProtectedRows(root)) continue
        for (const row of [root, c]) {
          const whole = identityFor(raw, r.startSample, r.endSample)
          if (whole && eligible(row)) { row.speaker = labels[whole]; changedRaw.add(raw) }
          for (const key of ['segments', 'finalSegments', 'words']) for (const nested of row[key] ?? []) {
            if (!eligible(nested)) continue
            const span = samples(key === 'words' ? nested.start : nested.startSec, key === 'words' ? nested.end : nested.endSec)
            const identity = span ? identityFor(raw, r.startSample + span[0], r.startSample + span[1]) : null
            if (identity) { nested.speaker = labels[identity]; changedRaw.add(raw) }
          }
        }
      }
      const hq = hqGeometry(base)
      for (const word of hq.words) doc.batchSegments[word.batchIndex].speakerWords[word.wordIndex].speaker = labels[word.identityId]
      return { doc, changedChunks: changedRaw.size, changedWords: hq.words.length, usableHQWords: hq.usableHQWords }
    },
  }
}
