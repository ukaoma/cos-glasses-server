import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NEMOTRON_CHANNELS } from './nemotron-cli.js'
import type { Activity } from './nemotron-segments.js'
import {
  crosswalkMacWindow,
  emptyMacWindowVoices,
  macWindowVoicesEnabled,
  planMacWindow,
  validMacWindowVoices,
  MAC_WINDOW_MAX_CHUNKS,
  MAC_WINDOW_MAX_TRACKS,
  type MacWindowVoiceState,
} from './mac-window-voices.js'

const CHUNK = 96_000
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
    const result = crosswalkMacWindow({ state, window: windowActivity(timeline, lo, k, s => permute(k, s)), plan, audioSha256: digest(k) })
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
      state = crosswalkMacWindow({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, s => merged(k, s)), plan, audioSha256: digest(k) })!.state
    }
    const plan = planMacWindow(4, () => CHUNK)!
    const r = crosswalkMacWindow({ state, window: windowActivity(tl, 0, 4, s => merged(4, s)), plan, audioSha256: digest(4) })!
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
      state = crosswalkMacWindow({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, s => slotOf(k, s)), plan, audioSha256: digest(k) })!.state
    }
    // Chunk 3's window puts A and B on slot 5 (A 12 s, B 6 s: 67% A) and C on slot 6.
    const plan = planMacWindow(3, () => CHUNK)!
    const r = crosswalkMacWindow({ state, window: windowActivity(tl, 0, 3, s => slotOf(3, s)), plan, audioSha256: digest(3) })!
    expect(r.stats.carried).toBe(0)
    expect(r.labelOf(5)).toBeNull()
  })

  it('carries one slot per track: a second slot on the same voice does not also get its number', () => {
    // A speaks in chunks 0 and 1; chunk 2's window puts chunk 0's A on slot 1 and chunk 1's A on slot 2.
    const tl: Timeline = [whole(A), whole(A), whole(A)]
    let state = emptyMacWindowVoices()
    for (let k = 0; k < 2; k++) {
      const plan = planMacWindow(k, () => CHUNK)!
      state = crosswalkMacWindow({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, () => 0), plan, audioSha256: digest(k) })!.state
    }
    const plan = planMacWindow(2, () => CHUNK)!
    const w = windowActivity([[], [], []], 0, 2, () => 0)
    for (let f = 0; f < 1800; f++) w.probs[f * NEMOTRON_CHANNELS + (f < 600 ? 1 : 2)] = 0.9
    const r = crosswalkMacWindow({ state, window: w, plan, audioSha256: digest(2) })!
    expect(r.stats.carried).toBe(1)
    expect([r.labelOf(1), r.labelOf(2)].filter(Boolean)).toEqual(['Voice 1'])
  })

  it('a first voice needs two seconds alone before it gets a track', () => {
    const plan = planMacWindow(0, () => CHUNK)!
    const r = crosswalkMacWindow({ state: emptyMacWindowVoices(), window: windowActivity([[[A, 0, 1.9]]], 0, 0, s => s), plan, audioSha256: digest(0) })!
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
      const r = crosswalkMacWindow({ state, window: windowActivity(short, plan.chunks[0].chunk, k, s => s), plan, audioSha256: digest(k) })!
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
      const r = crosswalkMacWindow({ state, window: windowActivity(tl, plan.chunks[0].chunk, k, s => s), plan, audioSha256: digest(0) })!
      state = r.state; labels.push(r.labelOf(A))
    }
    expect(labels).toEqual([null, null, null])
  })

  it('caps capture tracks; past the cap new voices stay unlabeled and nothing is evicted or renumbered', () => {
    let state = emptyMacWindowVoices()
    for (let k = 0; k < MAC_WINDOW_MAX_TRACKS + 2; k++) {
      const tl: Timeline = Array.from({ length: k + 1 }, (_, c) => [[c % NEMOTRON_CHANNELS, 0, 6]])
      const plan = planMacWindow(k, c => (c === k ? CHUNK : null))! // no overlap: every chunk is new evidence only
      state = crosswalkMacWindow({ state, window: windowActivity(tl, k, k, s => s), plan, audioSha256: digest(k) })!.state
    }
    expect(state.nextTrack).toBe(MAC_WINDOW_MAX_TRACKS)
    expect(state.voices).toBe(0) // one chunk per track: never two proofs, never a number
  })

  it('does not mutate its input and rejects untrusted geometry or values', () => {
    const plan = planMacWindow(1, () => CHUNK)!
    const tl: Timeline = [whole(A), whole(A)]
    const state = emptyMacWindowVoices()
    const before = structuredClone(state)
    expect(crosswalkMacWindow({ state, window: windowActivity(tl, 0, 1, s => s), plan, audioSha256: digest(1) })).not.toBeNull()
    expect(state).toEqual(before)
    const short = windowActivity(tl, 1, 1, s => s) // a 6 s matrix for a 12 s plan
    expect(crosswalkMacWindow({ state, window: short, plan, audioSha256: digest(1) })).toBeNull()
    const bad = windowActivity(tl, 0, 1, s => s); bad.probs[17] = Number.NaN
    expect(crosswalkMacWindow({ state, window: bad, plan, audioSha256: digest(1) })).toBeNull()
    bad.probs[17] = 1.5
    expect(crosswalkMacWindow({ state, window: bad, plan, audioSha256: digest(1) })).toBeNull()
    expect(crosswalkMacWindow({ state, window: windowActivity(tl, 0, 1, s => s), plan, audioSha256: 'nope' })).toBeNull()
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
      s => { s.nextTrack = 5 },
      s => { s.tracks[0].id = 1 },
      s => { s.recent.reverse() },
      s => { s.recent[0].frames = 'not base64!' },
      s => { s.recent[0].frames = Buffer.from([9]).toString('base64') }, // unknown track id
      s => { s.recent[0].frames = '' },
      s => { s.recent.push(...s.recent.map((r: any) => ({ ...r, chunk: r.chunk + 100 }))) }, // too many
      s => { s.recent[0].chunk = '1' },
    ]
    for (const corrupt of cases) {
      const s = good(); corrupt(s)
      expect(validMacWindowVoices(s)).toBe(false)
      expect(crosswalkMacWindow({ state: s, window: windowActivity([whole(A)], 0, 0, x => x), plan: planMacWindow(0, () => CHUNK)!, audioSha256: digest(9) })).toBeNull()
    }
  })
})

describe('switch', () => {
  it('is off unless COS_MAC_LIVE_VOICES=window, and COS_MAC_VOICE_LABELS off wins', () => {
    expect(macWindowVoicesEnabled({})).toBe(false)
    expect(macWindowVoicesEnabled({ COS_MAC_LIVE_VOICES: '1' })).toBe(false)
    expect(macWindowVoicesEnabled({ COS_MAC_LIVE_VOICES: ' Window ' })).toBe(true)
    expect(macWindowVoicesEnabled({ COS_MAC_LIVE_VOICES: 'window', COS_MAC_VOICE_LABELS: 'off' })).toBe(false)
  })
  it('reaches a managed install: the managed runtime contract forwards COS_MAC_LIVE_VOICES', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    expect(contract.optionalEnvironment).toContain('COS_MAC_LIVE_VOICES')
  })
})
