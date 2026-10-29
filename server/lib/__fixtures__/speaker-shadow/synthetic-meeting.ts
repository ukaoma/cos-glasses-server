// A synthetic Mac meeting for the speaker shadow tests. Fictional people, generated audio,
// generated embeddings: nothing here came from a recording.
//
// Each gate has one voice designed to fail it and nothing else, and one cluster where the
// UNVALIDATED anchor ratio is high on a merge that every real gate accepts:
//
//   S1  Voice 1 (Avery, 40 s) + Voice 2 (Avery, 22 s)   -> accepted: Voice 2 into Voice 1
//       Voice 5 (Casey, 20 s, FluidAudio put her in S1) -> rejected (c): embedding outlier
//       Dana Fictional (named, 3 s)                     -> frozen; reported as a hint
//   S2  Voice 3 (Blake, 38 s) + Voice 10 (Blake, 16 s)  -> accepted: Voice 10 into Voice 3
//       Voice 4 (Blake, 10 s)                           -> rejected (b): under the 15 s floor
//       Voice 6 (Blake; FluidAudio: 12 s S2, 8 s S3)    -> rejected (a): majority 0.60
//       Voice 7 (20 s, only 8 s covered)                -> rejected (a): covered 0.40
//   S3  Voice 8 (Drew, 30 s)                            -> untouched: the only voice on S3
//   S4  Voice 11 (Emery, tight) + Voice 12 (Emery, offset) + broad Ext speech
//                                                       -> accepted, anchor ratio above 1.5
//   --  Voice 9 (16 s, no FluidAudio speech)            -> untouched: not covered
//   --  Voice 13 (Avery, 15.00 s exactly, on S1)        -> exactly at the floor: passes (b)

import { createHash } from 'node:crypto'

export const SR = 16_000
export const CHUNK_SECONDS = 10

export interface SpanSpec { label: string; start: number; end: number; person: string; cluster: number | null; coveredUntil?: number; secondCluster?: { from: number; cluster: number; person: string } }

/** Every production span, in time order. `cluster` is FluidAudio's (0-based, S1 = 0). */
export const SYNTHETIC_SPANS: SpanSpec[] = [
  { label: 'Voice 1', start: 0, end: 40, person: 'avery', cluster: 0 },
  { label: 'Voice 2', start: 40, end: 62, person: 'avery', cluster: 0 },
  { label: 'Voice 3', start: 62, end: 100, person: 'blake', cluster: 1 },
  { label: 'Voice 4', start: 100, end: 110, person: 'blake', cluster: 1 },
  { label: 'Voice 5', start: 110, end: 130, person: 'casey', cluster: 0 },
  { label: 'Voice 6', start: 130, end: 150, person: 'blake', cluster: 1, secondCluster: { from: 142, cluster: 2, person: 'blake' } },
  { label: 'Voice 7', start: 150, end: 170, person: 'blake', cluster: 1, coveredUntil: 158 },
  { label: 'Dana Fictional', start: 170, end: 173, person: 'avery', cluster: 0 },
  { label: 'Voice 8', start: 173, end: 203, person: 'drew', cluster: 2 },
  { label: 'Voice 9', start: 203, end: 219, person: 'nobody', cluster: null },
  { label: 'Voice 10', start: 219, end: 235, person: 'blake', cluster: 1 },
  { label: 'Voice 11', start: 235, end: 265, person: 'emery-tight', cluster: 3 },
  { label: 'Voice 12', start: 265, end: 285, person: 'emery-offset', cluster: 3 },
  { label: 'Ext', start: 285, end: 325, person: 'emery-broad', cluster: 3 },
  { label: 'Voice 13', start: 325, end: 340, person: 'avery', cluster: 0 },
]
export const SYNTHETIC_SECONDS = 340

/** mulberry32: small, deterministic, good enough for test noise. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12), v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / n)
}

const BASE: Record<string, number> = { avery: 11, blake: 23, casey: 37, drew: 41, emery: 53, nobody: 61 }
function direction(person: string): number[] {
  const root = person.split('-')[0]
  const r = rng(BASE[root] ?? 97)
  const d = unit(Array.from({ length: 256 }, () => gauss(r)))
  if (person === 'emery-offset') {
    // Same person, a small consistent offset: inside the cluster's broad spread, far from Voice 11's tight one.
    const off = unit(Array.from({ length: 256 }, () => gauss(rng(77))))
    return unit(d.map((x, i) => x + 0.16 * off[i]))
  }
  return d
}
const SIGMA: Record<string, number> = { 'emery-tight': 0.004, 'emery-broad': 0.06 }

/** FluidAudio-style embedding rows: 2 s windows, 1 s hop, inside each covered span. */
export function syntheticEmbeddings(): Array<{ startTime: number; endTime: number; cluster: number; embedding256: number[]; chunkIndex: number; speakerIndex: number }> {
  const rows: Array<{ startTime: number; endTime: number; cluster: number; embedding256: number[]; chunkIndex: number; speakerIndex: number }> = []
  let seed = 1000
  for (const span of SYNTHETIC_SPANS) {
    if (span.cluster === null) continue
    const coveredEnd = span.coveredUntil ?? span.end
    for (let t = span.start; t + 2 <= coveredEnd; t += 1) {
      const second = span.secondCluster && t >= span.secondCluster.from ? span.secondCluster : null
      if (span.secondCluster && t < span.secondCluster.from && t + 2 > span.secondCluster.from) continue
      const person = second ? second.person : span.person
      const sigma = SIGMA[person] ?? 0.04
      const r = rng(seed++)
      const dir = direction(person)
      rows.push({ startTime: t, endTime: t + 2, cluster: second ? second.cluster : span.cluster, embedding256: dir.map(x => x + sigma * gauss(r)), chunkIndex: Math.floor(t / CHUNK_SECONDS), speakerIndex: 0 })
    }
  }
  return rows
}

/** FluidAudio-style native segments (float32-exact times). */
export function syntheticNative(): { segments: Array<{ speakerId: string; startTimeSeconds: number; endTimeSeconds: number; qualityScore: number }> } {
  const segments: Array<{ speakerId: string; startTimeSeconds: number; endTimeSeconds: number; qualityScore: number }> = []
  for (const span of SYNTHETIC_SPANS) {
    if (span.cluster === null) continue
    const coveredEnd = span.coveredUntil ?? span.end
    if (span.secondCluster) {
      segments.push({ speakerId: `S${span.cluster + 1}`, startTimeSeconds: span.start, endTimeSeconds: span.secondCluster.from, qualityScore: 1 })
      segments.push({ speakerId: `S${span.secondCluster.cluster + 1}`, startTimeSeconds: span.secondCluster.from, endTimeSeconds: coveredEnd, qualityScore: 1 })
    } else {
      segments.push({ speakerId: `S${span.cluster + 1}`, startTimeSeconds: span.start, endTimeSeconds: coveredEnd, qualityScore: 1 })
    }
  }
  return { segments }
}

export function pcmWav(samples: Int16Array): Buffer {
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24)
  header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export interface SyntheticMeeting {
  sessionId: string
  sidecar: Record<string, unknown>
  wavs: Map<number, Buffer>
}

/** The finalized sidecar and its chunk WAVs (10 s chunks of quiet deterministic noise). */
export function syntheticMeeting(sessionId = 'mac_00000000-0000-4000-8000-0000000000aa'): SyntheticMeeting {
  const chunks = Math.ceil(SYNTHETIC_SECONDS / CHUNK_SECONDS)
  const wavs = new Map<number, Buffer>()
  const chunkEntries: Array<{ chunkIndex: number; chunk: Record<string, unknown> }> = []
  for (let i = 0; i < chunks; i++) {
    const c0 = i * CHUNK_SECONDS, c1 = c0 + CHUNK_SECONDS
    const samples = new Int16Array(CHUNK_SECONDS * SR)
    const r = rng(5000 + i)
    for (let k = 0; k < samples.length; k++) samples[k] = Math.round((r() - 0.5) * 200)
    const wav = pcmWav(samples)
    wavs.set(i, wav)
    const segments = SYNTHETIC_SPANS
      .filter(s => s.start < c1 && s.end > c0)
      .map(s => ({ speaker: s.label, startSec: Math.max(s.start, c0) - c0, endSec: Math.min(s.end, c1) - c0 }))
    const longest = [...segments].sort((a, b) => (b.endSec - b.startSec) - (a.endSec - a.startSec))[0]
    chunkEntries.push({ chunkIndex: i, chunk: { text: `synthetic chunk ${i}`, speaker: longest?.speaker ?? 'Ext', elapsed: c0 * 1000, similarity: 0.5, audioSha256: createHash('sha256').update(wav).digest('hex'), segments } })
  }
  return {
    sessionId,
    wavs,
    sidecar: { sessionId, sourceType: 'mac_system_audio', finalizationState: 'complete', chunkEntries },
  }
}

/** The same spans as production segments on the timeline (what the timeline module must produce). */
export function syntheticSegments(): Array<readonly [number, number, string]> {
  const out: Array<readonly [number, number, string]> = []
  for (let i = 0; i < Math.ceil(SYNTHETIC_SECONDS / CHUNK_SECONDS); i++) {
    const c0 = i * CHUNK_SECONDS, c1 = c0 + CHUNK_SECONDS
    for (const s of SYNTHETIC_SPANS) if (s.start < c1 && s.end > c0) out.push([Math.max(s.start, c0) * SR, Math.min(s.end, c1) * SR, s.label] as const)
  }
  return out
}
