// Speaker merge shadow mode (6.95.0): the gates, ported EXACTLY from the research tool.
//
// SOURCE OF TRUTH. `community-1-fluidaudio-v1/scripts/hybrid.py` `decide()` (round 2) and
// the report assembly in `round3/propose.py`, on CPython 3.15. Production `Voice N` labels
// stay the base; FluidAudio's offline Community-1 clusters only PROPOSE that two of them
// are one person. A voice may join a merge only when all hold:
//   (a) at least `majority` (0.8) of its FluidAudio-covered speech is on one cluster, and
//       at least half of its speech is covered at all;
//   (b) it has at least `floorSeconds` (15 s) of production speech;
//   (c) its window-embedding centroid lies inside the target cluster's own spread,
//       measured leave-fragment-out against the 95th percentile.
// Named labels, `Ext` and every non-Voice label are frozen: never merged into or out of.
// The post-hoc anchor ratio is computed and REPORTED ONLY. It decides nothing.
//
// LOG ONLY. Nothing here writes, and nothing calls a writer: the output is a proposal record.
//
// Order and rounding are part of the contract: Python dicts iterate in insertion order,
// max()/most_common(1) keep the FIRST maximum, sorted() is stable, gates compare ROUNDED
// values and reason strings use Python %-formatting. Every one of those is kept below,
// with the Python-compatible numerics in speaker-shadow-numeric.ts.

import { PY_VOICE_LABEL, codePointCompare, pyClock, pyFirstInt, pyFixed, pyRound, pyRoundInt, pySum } from './speaker-shadow-numeric.js'

export const SHADOW_SAMPLE_RATE = 16_000
/** The round-2 gates, fixed before scoring (RESULT-ROUND2.md). */
export const SHADOW_GATES = Object.freeze({ majority: 0.8, minCoveredFraction: 0.5, floorSeconds: 15, anchorRatioPostHoc: 1.5 })

/** One production segment on the reconstructed timeline: [lo, hi) samples and its label. */
export type ShadowSegment = readonly [lo: number, hi: number, label: string]
/** A FluidAudio turn in seconds (float32 values widened, end clipped to the audio). */
export interface ShadowTurn { start: number; end: number; speaker: string }
/** One `--export-embeddings` row (the fields decide() reads). */
export interface ShadowEmbeddingRow { startTime: number; endTime: number; cluster: number; embedding256: number[] }
/** Where a production segment came from, for listen pointers. Same order as the segments. */
export interface ShadowSegmentSource { chunkIndex: number; start: number; end: number; abs: number }

export function isShadowVoiceLabel(label: string): boolean {
  return PY_VOICE_LABEL.test(label)
}

// ── Vector helpers (hybrid.py norm / mean_dir / cosdist / p95) ───────────────

export function norm(v: readonly number[]): number[] {
  const squares = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) squares[i] = v[i] * v[i]
  const n = Math.sqrt(pySum(squares)) || 1.0
  return v.map(x => x / n)
}

export function meanDir(vs: readonly number[][]): number[] {
  const s = new Array<number>(vs[0].length).fill(0)
  for (const v of vs) for (let i = 0; i < v.length; i++) s[i] += v[i]
  return norm(s)
}

export function cosdist(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  const products = new Array<number>(n)
  for (let i = 0; i < n; i++) products[i] = a[i] * b[i]
  return 1.0 - pySum(products)
}

export function p95(values: readonly number[]): number {
  const xs = [...values].sort((x, y) => x - y)
  const k = 0.95 * (xs.length - 1)
  const f = Math.floor(k), c = Math.ceil(k)
  return f === c ? xs[f] : xs[f] + (xs[c] - xs[f]) * (k - f)
}

// ── Interval helpers (common.py interval_samples / exact_overlap) ────────────

const KEY_SEP = '\u0000'
type Interval = readonly [lo: number, hi: number, label: string]

/** FluidAudio turns as sample intervals, validated like common.py. */
export function intervalSamples(turns: readonly ShadowTurn[], total: number): Interval[] {
  return turns.map(t => {
    const { start: a, end: b, speaker: label } = t
    if (typeof label !== 'string' || !label || label.includes(KEY_SEP)) throw new Error('bad FluidAudio turn label')
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(a >= 0 && a < b && b <= total / SHADOW_SAMPLE_RATE + 1e-6)) throw new Error('bad FluidAudio turn time')
    return [Math.max(0, pyRoundInt(a * SHADOW_SAMPLE_RATE)), Math.min(total, pyRoundInt(b * SHADOW_SAMPLE_RATE)), label] as const
  })
}

/** Turns sorted by start with the longest span, so a query scans only what can overlap. */
export class IntervalIndex {
  private readonly rows: Interval[]
  private readonly maxSpan: number
  constructor(intervals: readonly Interval[]) {
    this.rows = [...intervals].sort((x, y) => x[0] - y[0])
    this.maxSpan = this.rows.reduce((m, [a, b]) => Math.max(m, b - a), 0)
  }
  /** Every interval with a < hi and b > lo (the set common.py crops to). */
  overlapping(lo: number, hi: number): Interval[] {
    const rows = this.rows
    let left = 0, right = rows.length
    const from = lo - this.maxSpan
    while (left < right) { const mid = (left + right) >> 1; if (rows[mid][0] < from) left = mid + 1; else right = mid }
    const out: Interval[] = []
    for (let i = left; i < rows.length && rows[i][0] < hi; i++) if (rows[i][1] > lo) out.push(rows[i])
    return out
  }
}

/**
 * Samples of [lo, hi) by active-label set, in Python dict order (first appearance as the
 * points ascend). Keys are the sorted labels joined by NUL; '' is "no cluster active".
 */
export function exactOverlap(lo: number, hi: number, index: IntervalIndex): Map<string, number> {
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || !(lo >= 0 && lo < hi)) throw new Error('exact_overlap range')
  const boundaries = new Set<number>([lo, hi])
  const cropped: Array<[number, number, string]> = []
  for (const [a0, b0, label] of index.overlapping(lo, hi)) {
    const a = Math.max(lo, a0), b = Math.min(hi, b0)
    if (a < b) { cropped.push([a, b, label]); boundaries.add(a); boundaries.add(b) }
  }
  const points = [...boundaries].sort((x, y) => x - y)
  const counts = new Map<string, number>()
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1]
    const active = [...new Set(cropped.filter(([x, y]) => x <= a && y >= b).map(([, , label]) => label))].sort(codePointCompare)
    const key = active.join(KEY_SEP)
    counts.set(key, (counts.get(key) ?? 0) + (b - a))
  }
  let sum = 0
  for (const n of counts.values()) sum += n
  if (sum !== hi - lo) throw new Error('exact_overlap accounting')
  return counts
}

const isSingle = (key: string) => key !== '' && !key.includes(KEY_SEP)

function mergeIv(iv: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [a, b] of [...iv].sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]))) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(b, last[1])
    else out.push([a, b])
  }
  return out
}

// ── decide() ─────────────────────────────────────────────────────────────────

export type ShadowOutlier =
  | { pass: false; reason: string }
  | { pass: boolean; fragmentCentroidDistance: number; clusterP95Distance: number; raw: { distance: number; p95: number } }

export interface ShadowVoiceRow {
  seconds: number
  coveredFraction: number
  topCluster: string | null
  majority: number
  fragmentEmbeddings: number
  otherClusterMembers: number
  outlier: ShadowOutlier
  eligible: boolean
  reasons: string[]
}

export interface ShadowItem { vec: number[]; exportCluster: string; outputCluster: string | null; voice: string | null }
export interface ShadowGroup { cluster: string; voices: string[]; anchor: string | null; mergedIntoAnchor: string[] }

export interface ShadowDecision {
  voices: Map<string, Array<[number, number]>>
  rows: Map<string, ShadowVoiceRow>
  groups: ShadowGroup[]
  rejected: Array<{ voice: string; cluster: string; reasons: string[] }>
  remap: Map<string, string>
  proposed: number
  accepted: number
  agree: number
  withOut: number
  items: ShadowItem[]
  voiceBefore: number
  voiceAfter: number
  index: IntervalIndex
}

export function decide(
  segs: readonly ShadowSegment[],
  total: number,
  regularTurns: readonly ShadowTurn[],
  emb: readonly ShadowEmbeddingRow[],
  nSec: number = SHADOW_GATES.floorSeconds,
  majority: number = SHADOW_GATES.majority,
): ShadowDecision {
  const SR = SHADOW_SAMPLE_RATE
  const index = new IntervalIndex(intervalSamples(regularTurns, total))

  const collected = new Map<string, Array<[number, number]>>()
  for (const [lo, hi, label] of segs) {
    if (!isShadowVoiceLabel(label)) continue
    const list = collected.get(label)
    if (list) list.push([lo, hi]); else collected.set(label, [[lo, hi]])
  }
  const voices = new Map<string, Array<[number, number]>>()
  for (const [v, iv] of collected) voices.set(v, mergeIv(iv))

  // Embedding attribution: a window belongs to the voice holding >= 50% of its span.
  const items: ShadowItem[] = []
  for (const e of emb) {
    const lo = pyRoundInt(e.startTime * SR), hi = pyRoundInt(e.endTime * SR)
    if (hi <= lo) continue
    if (!Number.isInteger(e.cluster)) throw new Error('embedding cluster is not an integer')
    let best: string | null = null, bestN = 0
    for (const [v, iv] of voices) {
      let n = 0
      for (const [a, b] of iv) if (a < hi && b > lo) n += Math.max(0, Math.min(hi, b) - Math.max(lo, a))
      if (n > bestN) { best = v; bestN = n }
    }
    const cover = lo < total ? exactOverlap(lo, Math.min(hi, total), index) : new Map<string, number>()
    let outLabel: string | null = null, outN = -Infinity
    for (const [key, n] of cover) if (isSingle(key) && n > outN) { outLabel = key; outN = n }
    items.push({ vec: norm(e.embedding256), exportCluster: `S${e.cluster + 1}`, outputCluster: outLabel, voice: best !== null && bestN >= 0.5 * (hi - lo) ? best : null })
  }
  let agree = 0, withOut = 0
  for (const x of items) if (x.outputCluster) { withOut++; if (x.exportCluster === x.outputCluster) agree++ }

  const rows = new Map<string, ShadowVoiceRow>()
  for (const [v, iv] of voices) {
    let dur = 0
    for (const [a, b] of iv) dur += b - a
    const counts = new Map<string, number>()
    for (const [a, b] of iv) for (const [key, n] of exactOverlap(a, b, index)) counts.set(key, (counts.get(key) ?? 0) + n)
    let covered = 0
    for (const [key, n] of counts) if (key !== '') covered += n
    let top: string | null = null, topN = 0, topSeen = false
    for (const [key, n] of counts) if (isSingle(key) && (!topSeen || n > topN)) { top = key; topN = n; topSeen = true }
    rows.set(v, {
      seconds: pyRound(dur / SR, 2),
      coveredFraction: dur ? pyRound(covered / dur, 3) : 0,
      topCluster: top,
      majority: covered ? pyRound(topN / covered, 3) : 0,
      fragmentEmbeddings: 0, otherClusterMembers: 0,
      outlier: { pass: false, reason: '' }, eligible: false, reasons: [],
    })
  }

  // (c) outlier check against the voice's top cluster; membership = export cluster label.
  for (const [v, r] of rows) {
    const k = r.topCluster
    const frag = items.filter(x => x.voice === v).map(x => x.vec)
    const members = items.filter(x => x.exportCluster === k && x.voice !== v).map(x => x.vec)
    r.fragmentEmbeddings = frag.length
    r.otherClusterMembers = members.length
    if (k === null || frag.length < 3 || members.length < 5) {
      r.outlier = { pass: false, reason: `insufficient embeddings (fragment ${frag.length}, others ${members.length})` }
      continue
    }
    const c = meanDir(members)
    const thr = p95(members.map(m => cosdist(m, c)))
    const d = cosdist(meanDir(frag), c)
    r.outlier = { pass: d <= thr, fragmentCentroidDistance: pyRound(d, 4), clusterP95Distance: pyRound(thr, 4), raw: { distance: d, p95: thr } }
  }

  for (const r of rows.values()) {
    const reasons: string[] = []
    if (!(r.coveredFraction >= 0.5)) reasons.push(`(a) covered ${pyFixed(r.coveredFraction, 2)} < 0.50`)
    if (!(r.majority >= majority)) reasons.push(`(a) majority ${pyFixed(r.majority, 2)} < ${pyFixed(majority, 2)}`)
    if (!(r.seconds >= nSec)) reasons.push(`(b) ${pyFixed(r.seconds, 1)} s < ${pyFixed(nSec, 0)} s`)
    if (!r.outlier.pass) {
      const o = r.outlier
      reasons.push('(c) ' + ('reason' in o ? o.reason : `centroid ${pyFixed(o.fragmentCentroidDistance, 3)} > p95 ${pyFixed(o.clusterP95Distance, 3)}`))
    }
    r.eligible = reasons.length === 0
    r.reasons = reasons
  }

  const byCluster = new Map<string, string[]>()
  for (const [v, r] of rows) {
    if (r.topCluster && r.majority > 0.5) {
      const list = byCluster.get(r.topCluster)
      if (list) list.push(v); else byCluster.set(r.topCluster, [v])
    }
  }
  const longestFirst = (vs: string[]) => [...vs].sort((a, b) => rows.get(b)!.seconds - rows.get(a)!.seconds)
  const remap = new Map<string, string>()
  const rejected: ShadowDecision['rejected'] = []
  const groups: ShadowGroup[] = []
  let proposed = 0, accepted = 0
  for (const [k, vs] of [...byCluster].sort((x, y) => codePointCompare(x[0], y[0]))) {
    if (vs.length < 2) continue
    proposed += vs.length - 1
    const ok = longestFirst(vs.filter(v => rows.get(v)!.eligible))
    const anchor = ok[0] ?? null
    const merged = ok.slice(1)
    accepted += merged.length
    for (const v of merged) remap.set(v, anchor!)
    for (const v of vs) {
      if (!ok.includes(v)) rejected.push({ voice: v, cluster: k, reasons: rows.get(v)!.reasons })
      else if (v === anchor && !merged.length) rejected.push({ voice: v, cluster: k, reasons: ['no other eligible voice in this cluster'] })
    }
    groups.push({ cluster: k, voices: longestFirst(vs), anchor, mergedIntoAnchor: merged })
  }

  return {
    voices, rows, groups, rejected, remap, proposed, accepted, agree, withOut, items,
    voiceBefore: voices.size,
    voiceAfter: new Set([...voices.keys()].map(v => remap.get(v) ?? v)).size,
    index,
  }
}

// ── Report assembly (round3/propose.py), log only ────────────────────────────

export interface ShadowListenPointer { chunkIndex: number; inFileStart: number; inFileEnd: number; callTime: string }
export interface ShadowVoiceEntry {
  voice: string
  seconds: number
  coveredFraction: number
  topCluster: string | null
  majority: number
  outlierPass: boolean
  outlierDistance: number | null
  outlierP95: number | null
  outlierNote: string | null
  /** UNVALIDATED post-hoc check, reported only (fragment centroid vs the kept voice's spread). */
  anchorRatioPostHoc: number | null
  eligible: boolean
  reasons: string[]
  listen: ShadowListenPointer[]
}
/** A non-Voice label sharing the cluster, as a hint only ("cluster also holds 65 s of ..."). */
export interface ShadowOtherLabel { label: string; seconds: number }
export interface ShadowAccepted { cluster: string; keepLabel: string; merge: string[]; voices: ShadowVoiceEntry[]; otherLabelsInCluster: ShadowOtherLabel[] }
export type ShadowRejected = ShadowVoiceEntry & { cluster: string; wouldJoin: string | null; otherLabelsInCluster: ShadowOtherLabel[] }
export interface ShadowUntouched { voice: string; seconds: number; why: string }

export interface ShadowProposals {
  productionVoices: number
  voicesAfter: number
  frozenOtherLabels: string[]
  fluidAudioClusters: number
  proposedMerges: number
  acceptedMerges: number
  rejectedMerges: number
  embeddingClusterAgreement: [agree: number, withOutputCluster: number, total: number]
  accepted: ShadowAccepted[]
  rejected: ShadowRejected[]
  untouched: ShadowUntouched[]
}

function listenPointers(label: string, byLabel: Map<string, ShadowSegmentSource[]>, k = 3): ShadowListenPointer[] {
  const segs = byLabel.get(label) ?? []
  if (!segs.length) return []
  const pick = (score: (s: ShadowSegmentSource) => number, max: boolean) => segs.reduce((best, s) => (max ? score(s) > score(best) : score(s) < score(best)) ? s : best)
  const picks = [pick(s => s.end - s.start, true), pick(s => s.abs, false), pick(s => s.abs, true)]
  const seen = new Set<number>(), out: ShadowListenPointer[] = []
  for (const s of picks) {
    if (seen.has(s.chunkIndex)) continue
    seen.add(s.chunkIndex)
    out.push({ chunkIndex: s.chunkIndex, inFileStart: pyRound(s.start, 2), inFileEnd: pyRound(s.end, 2), callTime: pyClock(s.abs) })
  }
  return out.slice(0, k)
}

/** The proposal report for one meeting, exactly as round3/propose.py assembles it (minus transcript text and file paths). */
export function buildShadowProposals(
  D: ShadowDecision,
  segs: readonly ShadowSegment[],
  sources: readonly ShadowSegmentSource[],
  regularTurns: readonly ShadowTurn[],
): ShadowProposals {
  const SR = SHADOW_SAMPLE_RATE
  const rows = D.rows
  if (sources.length !== segs.length) throw new Error('segment sources out of step')
  const byLabel = new Map<string, ShadowSegmentSource[]>()
  segs.forEach(([, , label], i) => { const list = byLabel.get(label); if (list) list.push(sources[i]); else byLabel.set(label, [sources[i]]) })

  const vecs = new Map<string, number[][]>()
  for (const it of D.items) if (it.voice) { const list = vecs.get(it.voice); if (list) list.push(it.vec); else vecs.set(it.voice, [it.vec]) }
  const ratio = (v: string, anchor: string): number | null => {
    const A = vecs.get(anchor) ?? [], B = vecs.get(v) ?? []
    if (v === anchor || A.length < 3 || B.length < 3) return null
    const ca = meanDir(A)
    const thr = p95(A.map(x => cosdist(x, ca)))
    return thr > 0 ? pyRound(cosdist(meanDir(B), ca) / thr, 2) : null
  }

  // Named / non-Voice labels sharing each FluidAudio cluster (caution only; never merged).
  const named = new Map<string, Map<string, number>>()
  for (const [lo, hi, label] of segs) {
    if (isShadowVoiceLabel(label)) continue
    for (const [key, n] of exactOverlap(lo, hi, D.index)) {
      if (!isSingle(key)) continue
      let inner = named.get(key)
      if (!inner) { inner = new Map(); named.set(key, inner) }
      inner.set(label, (inner.get(label) ?? 0) + n)
    }
  }

  const voiceEntry = (v: string, anchor: string): ShadowVoiceEntry => {
    const r = rows.get(v)!
    const o = r.outlier
    return {
      voice: v, seconds: r.seconds, coveredFraction: r.coveredFraction, topCluster: r.topCluster, majority: r.majority,
      outlierPass: o.pass,
      outlierDistance: 'reason' in o ? null : o.fragmentCentroidDistance,
      outlierP95: 'reason' in o ? null : o.clusterP95Distance,
      outlierNote: 'reason' in o ? o.reason : null,
      anchorRatioPostHoc: ratio(v, anchor), eligible: r.eligible, reasons: r.reasons,
      listen: listenPointers(v, byLabel),
    }
  }

  const accepted: ShadowAccepted[] = [], rejected: ShadowRejected[] = []
  const grouped = new Set<string>()
  for (const g of D.groups) {
    const anchor = g.anchor || g.voices[0]
    for (const v of g.voices) grouped.add(v)
    const members = g.voices.map(v => voiceEntry(v, anchor))
    const caution: ShadowOtherLabel[] = [...(named.get(g.cluster) ?? new Map<string, number>())]
      .sort((x, y) => y[1] - x[1])
      .filter(([, n]) => n >= SR)
      .map(([label, n]) => ({ label, seconds: pyRound(n / SR, 1) }))
    if (g.mergedIntoAnchor.length) {
      const kept = [g.anchor, ...g.mergedIntoAnchor]
      accepted.push({ cluster: g.cluster, keepLabel: g.anchor!, merge: g.mergedIntoAnchor, voices: members.filter(m => kept.includes(m.voice)), otherLabelsInCluster: caution })
    }
    for (const m of members) {
      const v = m.voice
      if (g.mergedIntoAnchor.includes(v) || (v === g.anchor && g.mergedIntoAnchor.length)) continue
      if (v === anchor) rejected.push({ cluster: g.cluster, wouldJoin: null, ...m, reasons: [...m.reasons, 'no other voice on this cluster passed every gate'], otherLabelsInCluster: caution })
      else rejected.push({ cluster: g.cluster, wouldJoin: anchor, ...m, otherLabelsInCluster: caution })
    }
  }

  const untouched: ShadowUntouched[] = []
  const byNumber = [...rows].sort((x, y) => (pyFirstInt(x[0]) ?? 0) - (pyFirstInt(y[0]) ?? 0))
  for (const [v, r] of byNumber) {
    if (grouped.has(v)) continue
    let why: string
    if (!r.topCluster || r.coveredFraction === 0) why = 'FluidAudio did not cover this voice'
    else if (r.majority <= 0.5) why = `no FluidAudio cluster holds a majority of it (top ${r.topCluster} ${pyFixed(r.majority, 2)})`
    else why = `the only voice on FluidAudio cluster ${r.topCluster}`
    untouched.push({ voice: v, seconds: r.seconds, why })
  }

  return {
    productionVoices: D.voiceBefore,
    voicesAfter: D.voiceAfter,
    frozenOtherLabels: [...new Set(segs.map(([, , label]) => label).filter(label => !isShadowVoiceLabel(label)))].sort(codePointCompare),
    fluidAudioClusters: new Set(regularTurns.map(t => t.speaker)).size,
    proposedMerges: D.proposed,
    acceptedMerges: D.accepted,
    rejectedMerges: rejected.filter(x => x.wouldJoin).length,
    embeddingClusterAgreement: [D.agree, D.withOut, D.items.length],
    accepted, rejected, untouched,
  }
}

/** adapt.py native_segments + to_turns: float32 times, end clipped to the audio, empty turns dropped. */
export function nativeTurns(segments: ReadonlyArray<{ speakerId: unknown; startTimeSeconds: unknown; endTimeSeconds: unknown }>, totalSeconds: number): { turns: ShadowTurn[]; clipped: number; dropped: number } {
  const turns: ShadowTurn[] = []
  let clipped = 0, dropped = 0
  for (const s of segments) {
    if (typeof s.speakerId !== 'string' || typeof s.startTimeSeconds !== 'number' || typeof s.endTimeSeconds !== 'number') throw new Error('bad FluidAudio segment')
    const start = Math.fround(s.startTimeSeconds)
    let end = Math.fround(s.endTimeSeconds)
    if (end > totalSeconds) { end = totalSeconds; clipped++ }
    if (!(start < end)) { dropped++; continue }
    turns.push({ start, end, speaker: s.speakerId })
  }
  return { turns, clipped, dropped }
}
