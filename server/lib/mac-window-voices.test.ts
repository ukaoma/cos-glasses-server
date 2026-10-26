import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NEMOTRON_CHANNELS } from './nemotron-cli.js'
import type { Activity } from './nemotron-segments.js'
import {
  chunkAgreesWithSlot,
  crosswalkMacWindow,
  emptyMacWindowVoices,
  macWindowFrameCount,
  macWindowVoicesEnabled,
  planMacWindow,
  validMacWindowVoices,
  MAC_WINDOW_FRAME_TAIL_SAMPLES,
  MAC_WINDOW_MAX_CHUNKS,
  MAC_WINDOW_MAX_SAMPLES,
  MAC_WINDOW_MAX_TRACKS,
  MAC_WINDOW_SAMPLES_PER_FRAME,
  type MacWindowPlan,
  type MacWindowVoiceState,
} from './mac-window-voices.js'

const CHUNK = 96_000

/** The current chunk of a window, as the per-chunk run would see it alone (same partition, own frame grid). */
function soloOf(window: Activity, plan: MacWindowPlan): Activity {
  const before = plan.chunks.slice(0, -1).reduce((n, c) => n + c.samples, 0)
  const start = Math.floor(before / MAC_WINDOW_SAMPLES_PER_FRAME)
  const frames = macWindowFrameCount(plan.chunks[plan.chunks.length - 1].samples)
  return { frames, probs: window.probs.slice(start * NEMOTRON_CHANNELS, (start + frames) * NEMOTRON_CHANNELS) }
}
/** crosswalkMacWindow with the chunk-alone view defaulting to "agrees" (the window's own slice), unless a test passes one. */
function cross(input: Omit<Parameters<typeof crosswalkMacWindow>[0], 'chunkAlone'> & { chunkAlone?: Activity | null }) {
  return crosswalkMacWindow({ ...input, chunkAlone: input.chunkAlone === undefined ? soloOf(input.window, input.plan) : input.chunkAlone })
}
const digest = (n: number) => n.toString(16).padStart(64, '0')
/** Per chunk: [speaker, startSec, endSec] in chunk-local seconds. Speakers are truth ids, not slots. */
type Timeline = Array<Array<[number, number, number]>>

/** What a window run returns: each speaker on `slotOf(speaker)` for this window (slots differ per window). */
function windowActivity(timeline: Timeline, lo: number, k: number, slotOf: (speaker: number) => number): Activity {
  const chunks = k - lo + 1
  const frames = 1 + Math.floor((chunks * CHUNK + 112) / 160)
  const probs = new Float32Array(frames * NEMOTRON_CHANNELS).fill(0.02)
  for (let c = lo; c <= k; c++) for (const [speaker, start, end] of timeline[c] ?? []) {
    const off = (c - lo) * 600
    for (let f = off + Math.round(start * 100); f < Math.min(frames, off + Math.round(end * 100)); f++) probs[f * NEMOTRON_CHANNELS + slotOf(speaker)] = 0.9
  }
  return { frames, probs }
}

/** Drive a capture chunk by chunk. Returns, per chunk, the label each truth speaker got. */
function capture(timeline: Timeline, permute = (k: number, speaker: number) => (speaker + k) % NEMOTRON_CHANNELS) {
  let state: MacWindowVoiceState = emptyMacWindowVoices()
  const out: Array<Record<number, string | null>> = []
  for (let k = 0; k < timeline.length; k++) {
    const plan = planMacWindow(k, () => CHUNK)!
    const lo = plan.chunks[0].chunk
    const result = cross({ state, window: windowActivity(timeline, lo, k, s => permute(k, s)), plan, audioSha256: digest(k) })
    expect(result).not.toBeNull()
    state = result!.state
    expect(validMacWindowVoices(JSON.parse(JSON.stringify(state)))).toBe(true)
    const labels: Record<number, string | null> = {}
    for (const [speaker] of timeline[k]) labels[speaker] = result!.labelOf(permute(k, speaker))
    out.push(labels)
  }
  return { out, state }
}

const A = 0, B = 1, C = 2
const whole = (speaker: number): Array<[number, number, number]> => [[speaker, 0, 6]]

describe('window replay continuity', () => {
  it('keeps one number per voice across chunk boundaries even when window slots are permuted every chunk', () => {
    const { out, state } = capture([whole(A), whole(A), whole(B), whole(B), whole(A), whole(B)])
    expect(out.map(l => Object.values(l)[0])).toEqual([null, 'Voice 1', null, 'Voice 2', 'Voice 1', 'Voice 2'])
    expect(state.voices).toBe(2)
    expect(state.recent).toHaveLength(MAC_WINDOW_MAX_CHUNKS - 1)
  })

  it('labels both voices of a mixed chunk once each is proven, including a short turn by a confirmed voice', () => {
    const { out } = capture([whole(A), whole(A), [[A, 0, 3], [B, 3, 6]], whole(B), [[A, 0, 0.8], [B, 1, 6]]])
    expect(out[2]).toEqual({ [A]: 'Voice 1', [B]: null })
    expect(out[3]).toEqual({ [B]: 'Voice 2' })
    expect(out[4]).toEqual({ [A]: 'Voice 1', [B]: 'Voice 2' })
  })

  it('never gives a voice that returns after the window another voice\'s number (it waits for its own proof)', () => {
    const tl: Timeline = [whole(A), whole(A), whole(B), whole(B), whole(B), whole(B), whole(B), whole(A), whole(A), whole(A)]
    const { out } = capture(tl)
    expect(out[7][A]).toBeNull()
    expect(out[8][A]).toBe('Voice 3') // a split, never a wrong merge with Voice 2
    expect(out[9][A]).toBe('Voice 3')
    expect(out.slice(2, 7).every(l => l[B] === (l === out[2] ? null : 'Voice 2'))).toBe(true)
  })

  it('a voice that returns inside the window keeps its number', () => {
    const { out } = capture([whole(A), whole(A), whole(B), whole(B), whole(A)])
    expect(out[4][A]).toBe('Voice 1')
  })

  it('refuses an ambiguous carry: a slot whose overlap splits between two tracks gets no track and no new number', () => {
    // chunks 0,1: A; 2,3: B. Chunk 4's window merges A and B onto ONE slot (a model merge).
    const tl: Timeline = [whole(A), whole(A), whole(B), whole(B), whole(C)]
    const merged = (k: number, s: number) => (k === 4 ? 5 : (s + k) % NEMOTRON_CHANNELS)
    let state = emptyMacWindowVoices()
    for (let k = 0; k < 4; k++) {
      const plan = planMacWindow(k, () => CHUNK)!
      state = cross({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, s => merged(k, s)), plan, audioSha256: digest(k) })!.state
    }
    const plan = planMacWindow(4, () => CHUNK)!
    const r = cross({ state, window: windowActivity(tl, 0, 4, s => merged(4, s)), plan, audioSha256: digest(4) })!
    expect(r.labelOf(5)).toBeNull()
    expect(r.stats.carried).toBe(0)
    expect(r.stats.created).toBe(0) // it had attributed overlap, so it may be an existing voice: no new number
    expect(r.state.nextTrack).toBe(state.nextTrack)
  })

  it('refuses a carry below 80% agreement even without a tie (a model merge of A and B onto one slot)', () => {
    const tl: Timeline = [whole(A), whole(A), whole(B), whole(C)]
    const slotOf = (k: number, s: number) => (k === 3 ? (s === C ? 6 : 5) : s)
    let state = emptyMacWindowVoices()
    for (let k = 0; k < 3; k++) {
      const plan = planMacWindow(k, () => CHUNK)!
      state = cross({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, s => slotOf(k, s)), plan, audioSha256: digest(k) })!.state
    }
    // Chunk 3's window puts A and B on slot 5 (A 12 s, B 6 s: 67% A) and C on slot 6.
    const plan = planMacWindow(3, () => CHUNK)!
    const r = cross({ state, window: windowActivity(tl, 0, 3, s => slotOf(3, s)), plan, audioSha256: digest(3) })!
    expect(r.stats.carried).toBe(0)
    expect(r.labelOf(5)).toBeNull()
  })

  it('carries one slot per track: a second slot on the same voice does not also get its number', () => {
    // A speaks in chunks 0 and 1; chunk 2's window puts chunk 0's A on slot 1 and chunk 1's A on slot 2.
    const tl: Timeline = [whole(A), whole(A), whole(A)]
    let state = emptyMacWindowVoices()
    for (let k = 0; k < 2; k++) {
      const plan = planMacWindow(k, () => CHUNK)!
      state = cross({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, () => 0), plan, audioSha256: digest(k) })!.state
    }
    const plan = planMacWindow(2, () => CHUNK)!
    const w = windowActivity([[], [], []], 0, 2, () => 0)
    // Chunk 0's A on slot 1, chunk 1's A on slot 2, and chunk 2 has both slots speaking (a halves split).
    for (let f = 0; f < 1800; f++) w.probs[f * NEMOTRON_CHANNELS + (f < 600 ? 1 : f < 1200 ? 2 : f < 1500 ? 1 : 2)] = 0.9
    const r = cross({ state, window: w, plan, audioSha256: digest(2) })!
    expect(r.stats.carried).toBe(1)
    expect([r.labelOf(1), r.labelOf(2)].filter(Boolean)).toEqual(['Voice 1'])
  })

  it('two slots tied for one track: the lower slot wins the tie, and if it is not the one speaking now nobody is labeled', () => {
    const tl: Timeline = [whole(A), whole(A), whole(A)]
    let state = emptyMacWindowVoices()
    for (let k = 0; k < 2; k++) {
      const plan = planMacWindow(k, () => CHUNK)!
      state = cross({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, () => 0), plan, audioSha256: digest(k) })!.state
    }
    const plan = planMacWindow(2, () => CHUNK)!
    const w = windowActivity([[], [], []], 0, 2, () => 0)
    // Chunk 0's A on slot 1, chunk 1's A on slot 2 (a tie of 600 frames each), and ONLY slot 2 speaks in chunk 2.
    for (let f = 0; f < 1800; f++) w.probs[f * NEMOTRON_CHANNELS + (f < 600 ? 1 : 2)] = 0.9
    const r = cross({ state, window: w, plan, audioSha256: digest(2) })!
    // Slot 1 won the tie but is silent here: not used, and not a disagreement. Slot 2 lost the tie: no track.
    expect(r.stats).toMatchObject({ carried: 1, withheld: 0, created: 0 })
    expect([r.labelOf(1), r.labelOf(2)]).toEqual([null, null])
  })

  it('stops handing out numbers at Voice 99 instead of throwing', () => {
    const codes = new Int8Array(600).fill(-1).fill(0, 0, 300)
    const state: MacWindowVoiceState = {
      version: 1, kind: 'window', nextTrack: 1, voices: 99,
      tracks: [{ id: 0, voice: null, proofs: [{ chunk: 0, audioSha256: digest(0) }] }],
      recent: [{ chunk: 0, frames: Buffer.from(codes.buffer).toString('base64') }],
    }
    expect(validMacWindowVoices(state)).toBe(true)
    const plan = planMacWindow(1, () => CHUNK)!
    const r = cross({ state, window: windowActivity([[[A, 0, 3]], [[A, 0, 6]]], 0, 1, () => 2), plan, audioSha256: digest(1) })!
    expect(r.stats.carried).toBe(1)
    expect(r.stats.confirmed).toBe(0)
    expect(r.state.voices).toBe(99)
    expect(r.labelOf(2)).toBeNull()
    expect(r.state.tracks[0].proofs).toHaveLength(1) // the second proof was not kept: no number exists to give
  })

  it('a first voice needs two seconds alone before it gets a track', () => {
    const plan = planMacWindow(0, () => CHUNK)!
    const r = cross({ state: emptyMacWindowVoices(), window: windowActivity([[[A, 0, 1.9]]], 0, 0, s => s), plan, audioSha256: digest(0) })!
    expect(r.stats.created).toBe(0)
    expect(r.state.nextTrack).toBe(0)
  })

  it('needs at least one second of exclusive overlap to carry a track', () => {
    const tl: Timeline = [whole(A), [[A, 0, 6]], [[A, 5.2, 6]], [[A, 0, 6]]]
    // Chunk 3's window [1..3] holds A in chunk 1 (6 s) and chunk 2 (0.8 s): carried through chunk 1.
    expect(capture(tl).out[3][A]).toBe('Voice 1')
    // Chunk 2's window loses chunk 0 (no durable WAV), so its only attributed overlap is
    // chunk 1's 0.8 s: nothing is carried, and the slot cannot mint a new number either.
    let state = emptyMacWindowVoices()
    const short: Timeline = [whole(A), [[A, 5.2, 6]], whole(A)]
    for (let k = 0; k < 3; k++) {
      const plan = planMacWindow(k, c => (k === 2 && c === 0 ? null : CHUNK))!
      const r = cross({ state, window: windowActivity(short, plan.chunks[0].chunk, k, s => s), plan, audioSha256: digest(k) })!
      state = r.state
      if (k === 1) expect(r.stats.carried).toBe(1)
      if (k === 2) { expect(r.stats.carried).toBe(0); expect(r.stats.created).toBe(0); expect(r.labelOf(A)).toBeNull() }
    }
  })

  it('a proof needs two seconds of the voice alone at purity 0.9 in that chunk', () => {
    // Chunk 1: A alone 4 s, A over B 2 s (purity 0.67) -> no proof. Chunk 2: A alone 1.5 s -> no proof.
    const { out } = capture([whole(A), [[A, 0, 6], [B, 4, 6]], [[A, 0, 1.5]], whole(A)])
    expect(out.map(l => l[A])).toEqual([null, null, null, 'Voice 1'])
  })

  it('identical audio at a new index is not a second proof', () => {
    let state = emptyMacWindowVoices()
    const tl: Timeline = [whole(A), whole(A), whole(A)]
    const labels: Array<string | null> = []
    for (let k = 0; k < 3; k++) {
      const plan = planMacWindow(k, () => CHUNK)!
      const r = cross({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, s => s), plan, audioSha256: digest(0) })!
      state = r.state; labels.push(r.labelOf(A))
    }
    expect(labels).toEqual([null, null, null])
  })

  it('evicts tracks no recent frame refers to, so a long meeting never spends the ids (QA W3)', () => {
    // Fourteen different one-chunk voices (more than the 12 ids), then a voice that speaks twice.
    const X = 14
    const tl: Timeline = [...Array.from({ length: 14 }, (_, c) => [[c, 0, 6]] as Timeline[number]), whole(X), whole(X)]
    const slot = (_k: number, speaker: number) => speaker % NEMOTRON_CHANNELS
    const { out, state } = capture(tl, slot)
    expect(out[15][X]).toBe('Voice 1') // with no eviction every id was spent by chunk 11 and this voice never got a track
    expect(state.voices).toBe(1)
    expect(state.tracks.length).toBeLessThanOrEqual(MAC_WINDOW_MAX_CHUNKS)
    // Freed ids are reused: ids stay inside 0..11 however long the meeting runs.
    expect(state.tracks.every(t => t.id < MAC_WINDOW_MAX_TRACKS)).toBe(true)
    expect(state.nextTrack).toBeLessThanOrEqual(MAC_WINDOW_MAX_TRACKS)
  })

  it('keeps a confirmed number spent after its track is evicted: the same voice returning is a NEW number, never a reused one', () => {
    const tl: Timeline = [whole(A), whole(A), whole(B), whole(B), whole(B), whole(B), whole(B), whole(B), whole(A), whole(A)]
    const { out, state } = capture(tl)
    expect(state.tracks.map(t => t.voice)).not.toContain(1) // the first A track is gone
    expect(out[9][A]).toBe('Voice 3')
    expect(state.voices).toBe(3)
  })

  it('past the cap new voices stay unlabeled and nothing is renumbered', () => {
    // Twelve live tracks, all still referenced by the remembered chunk.
    const codes = Int8Array.from({ length: 600 }, (_, i) => i % MAC_WINDOW_MAX_TRACKS)
    const state: MacWindowVoiceState = {
      version: 1, kind: 'window', nextTrack: MAC_WINDOW_MAX_TRACKS, voices: 0,
      tracks: Array.from({ length: MAC_WINDOW_MAX_TRACKS }, (_, id) => ({ id, voice: null, proofs: [] })),
      recent: [{ chunk: 0, frames: Buffer.from(codes.buffer).toString('base64') }],
    }
    expect(validMacWindowVoices(state)).toBe(true)
    const plan = planMacWindow(1, () => CHUNK)!
    const r = cross({ state, window: windowActivity([[], [[B, 0, 6]]], 0, 1, () => 7), plan, audioSha256: digest(1) })!
    expect(r.stats.capped).toBe(1)
    expect(r.stats.created).toBe(0)
    expect(r.state.tracks).toHaveLength(MAC_WINDOW_MAX_TRACKS)
    expect(r.labelOf(7)).toBeNull()
  })

  it('does not mutate its input and rejects untrusted geometry or values', () => {
    const plan = planMacWindow(1, () => CHUNK)!
    const tl: Timeline = [whole(A), whole(A)]
    const state = emptyMacWindowVoices()
    const before = structuredClone(state)
    expect(cross({ state, window: windowActivity(tl, 0, 1, s => s), plan, audioSha256: digest(1) })).not.toBeNull()
    expect(state).toEqual(before)
    const short = windowActivity(tl, 1, 1, s => s) // a 6 s matrix for a 12 s plan
    expect(cross({ state, window: short, plan, audioSha256: digest(1) })).toBeNull()
    const bad = windowActivity(tl, 0, 1, s => s); bad.probs[17] = Number.NaN
    expect(cross({ state, window: bad, plan, audioSha256: digest(1) })).toBeNull()
    bad.probs[17] = 1.5
    expect(cross({ state, window: bad, plan, audioSha256: digest(1) })).toBeNull()
    expect(cross({ state, window: windowActivity(tl, 0, 1, s => s), plan, audioSha256: 'nope' })).toBeNull()
  })
})

describe('window plan', () => {
  it('takes the contiguous durable run before the chunk, bounded by count and samples', () => {
    expect(planMacWindow(7, () => CHUNK)!.chunks.map(c => c.chunk)).toEqual([3, 4, 5, 6, 7])
    expect(planMacWindow(7, c => (c === 5 ? null : CHUNK))!.chunks.map(c => c.chunk)).toEqual([6, 7])
    expect(planMacWindow(2, c => (c === 2 ? 480_000 : CHUNK))!.chunks.map(c => c.chunk)).toEqual([2])
    expect(planMacWindow(0, () => CHUNK)!.chunks.map(c => c.chunk)).toEqual([0])
    expect(planMacWindow(3, () => null)).toBeNull()
    expect(planMacWindow(3, c => (c === 3 ? 480_001 : CHUNK))).toBeNull()
    expect(planMacWindow(-1, () => CHUNK)).toBeNull()
  })
})

describe('window state validation fails closed', () => {
  const good = (): MacWindowVoiceState => capture([whole(A), whole(A), whole(B), whole(B)]).state
  it('accepts a real state and rejects each corruption', () => {
    expect(validMacWindowVoices(good())).toBe(true)
    const cases: Array<(s: any) => void> = [
      s => { s.version = 2 },
      s => { s.kind = 'anchors' },
      s => { s.voices = 1 }, // a track holds Voice 2 above the high-water
      s => { s.tracks[1].voice = 1 }, // duplicate number
      s => { s.tracks[0].voice = null }, // two proofs but no number
      s => { s.tracks[0].proofs = [s.tracks[0].proofs[0]] }, // a number with one proof
      s => { s.tracks[0].proofs[1].chunk = s.tracks[0].proofs[0].chunk },
      s => { s.tracks[0].proofs[1].audioSha256 = s.tracks[0].proofs[0].audioSha256 },
      s => { s.tracks[0].proofs[0].audioSha256 = ['x'.repeat(64)] },
      s => { s.nextTrack = MAC_WINDOW_MAX_TRACKS + 1 },
      s => { s.nextTrack = 1 }, // a track id at or above the high-water
      s => { s.tracks[0].id = 1 },
      s => { s.recent.reverse() },
      s => { s.recent[0].frames = 'not base64!' },
      s => { s.recent[0].frames = Buffer.from([9]).toString('base64') }, // unknown track id
      s => { s.recent[0].frames = '' },
      s => { s.recent[0].frames = 'A'.repeat(64_004) }, // longer than any chunk can need
      s => { s.tracks.splice(1, 1) }, // a remembered frame names a track that no longer exists
      s => { s.recent.push(...s.recent.map((r: any) => ({ ...r, chunk: r.chunk + 100 }))) }, // too many
      s => { s.recent[0].chunk = '1' },
    ]
    for (const corrupt of cases) {
      const s = good(); corrupt(s)
      expect(validMacWindowVoices(s)).toBe(false)
      expect(cross({ state: s, window: windowActivity([whole(A)], 0, 0, x => x), plan: planMacWindow(0, () => CHUNK)!, audioSha256: digest(9) })).toBeNull()
    }
  })
})

describe('switch', () => {
  it('is on by default; off for COS_MAC_LIVE_VOICES=off or anchors; COS_MAC_VOICE_LABELS off wins', () => {
    expect(macWindowVoicesEnabled({})).toBe(true)
    expect(macWindowVoicesEnabled({ COS_MAC_LIVE_VOICES: '1' })).toBe(true) // unrecognised is the default, not an opt-out
    expect(macWindowVoicesEnabled({ COS_MAC_LIVE_VOICES: ' Window ' })).toBe(true)
    expect(macWindowVoicesEnabled({ COS_MAC_LIVE_VOICES: 'anchors' })).toBe(false) // the 6.92.1 anchors are the other mode, not this one
    for (const off of ['off', '0', 'false', 'no']) expect(macWindowVoicesEnabled({ COS_MAC_LIVE_VOICES: off })).toBe(false)
    expect(macWindowVoicesEnabled({ COS_MAC_LIVE_VOICES: 'window', COS_MAC_VOICE_LABELS: 'off' })).toBe(false)
    expect(macWindowVoicesEnabled({ COS_MAC_VOICE_LABELS: 'off' })).toBe(false)
  })
  it('reaches a managed install: the managed runtime contract forwards COS_MAC_LIVE_VOICES', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    expect(contract.optionalEnvironment).toContain('COS_MAC_LIVE_VOICES')
  })
})

describe('the current chunk must agree with a carried slot (QA W1)', () => {
  // Chunks 0 and 1 are voice A alone (Voice 1 after chunk 1). Chunk 2 is A for 3 s then a NEW voice C for 3 s.
  // The window model merged C into A's slot 0; the chunk diarized alone separates them.
  const tl: Timeline = [whole(A), whole(A), [[A, 0, 3], [C, 3, 6]], whole(C)]
  const mergedSlot = () => 0
  const run = (agree: boolean) => {
    let state = emptyMacWindowVoices()
    const labels: Array<string | null> = []
    const stats: Array<{ carried: number; withheld: number }> = []
    for (let k = 0; k < tl.length; k++) {
      const plan = planMacWindow(k, () => CHUNK)!
      const window = windowActivity(tl, plan.chunks[0].chunk, k, mergedSlot)
      // The chunk alone: A and C on separate channels, so a merged slot disagrees. `agree` = the check sees what the window saw.
      const alone = agree ? soloOf(window, plan) : windowActivity(tl, k, k, speaker => (speaker === C ? 6 : 4))
      const r = cross({ state, window, plan, audioSha256: digest(k), chunkAlone: alone })!
      state = r.state; labels.push(r.labelOf(0)); stats.push({ carried: r.stats.carried, withheld: r.stats.withheld })
    }
    return { labels, stats, state }
  }

  it('without a separating view the merged slot carries A\'s number onto C\'s words, and the error feeds itself', () => {
    const { labels } = run(true)
    expect(labels).toEqual([null, 'Voice 1', 'Voice 1', 'Voice 1']) // C reads Voice 1 in chunks 2 and 3
  })

  it('when the chunk alone splits the slot, nothing is carried: no label, no proof, no feedback into later windows', () => {
    const { labels, stats, state } = run(false)
    expect(labels).toEqual([null, 'Voice 1', null, null])
    expect(stats[2]).toEqual({ carried: 1, withheld: 1 })
    // Chunk 3 (C alone, merged onto the old slot again) is not carried either: chunk 2's frames were stored untracked.
    expect(stats[3].carried).toBe(0)
    expect(state.voices).toBe(1)
  })

  it('no view of the chunk alone (the per-chunk run was unavailable) withholds every carried slot', () => {
    let state = emptyMacWindowVoices()
    const labels: Array<string | null> = []
    for (let k = 0; k < 3; k++) {
      const plan = planMacWindow(k, () => CHUNK)!
      const r = cross({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, s => s), plan, audioSha256: digest(k), chunkAlone: null })!
      state = r.state; labels.push(r.labelOf(A))
    }
    expect(labels).toEqual([null, null, null]) // chunk 1 carries A but cannot agree: no proof, so never Voice 1
  })

  it('chunkAgreesWithSlot: placed share, one-channel share, silence and missing evidence', () => {
    const window = windowActivity([[[A, 0, 6]]], 0, 0, () => 2)
    const alone = (spans: Array<[number, number, number]>) => windowActivity([spans], 0, 0, speaker => speaker)
    expect(chunkAgreesWithSlot(window, 0, 600, 2, null)).toBe(false)
    expect(chunkAgreesWithSlot(window, 0, 600, 2, alone([[5, 0, 6]]))).toBe(true)
    expect(chunkAgreesWithSlot(window, 0, 600, 2, alone([[5, 0, 5.4], [6, 5.4, 6]]))).toBe(true) // 90% on one channel
    expect(chunkAgreesWithSlot(window, 0, 600, 2, alone([[5, 0, 5.3], [6, 5.3, 6]]))).toBe(false) // 88%
    expect(chunkAgreesWithSlot(window, 0, 600, 2, alone([[5, 0, 2.9]]))).toBe(false) // places 48%
    expect(chunkAgreesWithSlot(window, 0, 600, 2, alone([[5, 0, 3.1]]))).toBe(true) // places 52%
    expect(chunkAgreesWithSlot(window, 0, 600, 3, alone([[5, 0, 6]]))).toBe(false) // the slot is silent here: nothing to agree with
    expect(chunkAgreesWithSlot(window, 0, 600, 2, { frames: 5, probs: new Float32Array(3) })).toBe(false) // malformed
  })
})

describe('untracked frames in the overlap count against a carry', () => {
  it('a slot whose overlap is 60% one track and 40% untracked is not carried', () => {
    // Chunk 0, slot 3 speaking 2.5 s: the first 1.5 s were tracked (track 0), the next 1 s were not.
    const codes = new Int8Array(600).fill(-1)
    codes.fill(0, 0, 150)
    codes.fill(-3, 150, 250)
    const state: MacWindowVoiceState = {
      version: 1, kind: 'window', nextTrack: 1, voices: 0,
      tracks: [{ id: 0, voice: null, proofs: [] }],
      recent: [{ chunk: 0, frames: Buffer.from(codes.buffer).toString('base64') }],
    }
    expect(validMacWindowVoices(state)).toBe(true)
    const plan = planMacWindow(1, () => CHUNK)!
    const w = windowActivity([[[A, 0, 2.5]], [[A, 0, 6]]], 0, 1, () => 3)
    const r = cross({ state, window: w, plan, audioSha256: digest(1) })!
    expect(r.stats.carried).toBe(0) // 150 of 250 exclusive overlap frames agree (0.6)
    expect(r.labelOf(3)).toBeNull()
    // Without the untracked 100 frames the same 150 would carry (1.0).
    const clean = { ...state, recent: [{ chunk: 0, frames: Buffer.from(new Int8Array(600).fill(-1).fill(0, 0, 150).buffer).toString('base64') }] }
    expect(cross({ state: clean, window: windowActivity([[[A, 0, 1.5]], [[A, 0, 6]]], 0, 1, () => 3), plan, audioSha256: digest(1) })!.stats.carried).toBe(1)
  })
})

describe('geometry is derived, not restated', () => {
  it('names the CLI frame geometry once: 160-sample hop, 112 tail, 30 s ceiling', () => {
    expect(MAC_WINDOW_SAMPLES_PER_FRAME).toBe(160)
    expect(MAC_WINDOW_FRAME_TAIL_SAMPLES).toBe(112)
    expect(MAC_WINDOW_MAX_SAMPLES).toBe(480_000)
    expect(macWindowFrameCount(96_000)).toBe(601)
    expect(macWindowFrameCount(576_000)).toBe(3601) // the 36 s fixture the CLI measured
    expect(macWindowFrameCount(0)).toBe(1 + Math.floor(112 / 160))
    // The formula's floor edge: 112 samples of tail make a 48th leftover sample the 161st-sample frame.
    expect(macWindowFrameCount(47)).toBe(1)
    expect(macWindowFrameCount(48)).toBe(2)
    expect(macWindowFrameCount(207)).toBe(2)
    expect(macWindowFrameCount(208)).toBe(3)
  })
})
