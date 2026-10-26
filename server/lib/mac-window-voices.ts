// 6.93.0: live Mac voice continuity by window replay.
//
// Why: the live path ran Nemotron on each 6 s chunk alone, so the model's speaker
// cache never crossed a chunk boundary and every chunk started over. On the
// natural 36 s fixture the per-chunk anchors returned no labels at all, while one
// continuous pass kept two clean voices through all five boundaries.
//
// What: for chunk k the route runs the SAME pinned CLI on the last few durable raw
// chunks (at most MAC_WINDOW_MAX_CHUNKS, at most MAC_WINDOW_MAX_SAMPLES). Inside
// one window the model's slots are consistent. A slot is carried to a capture
// track only through frames this capture already attributed (the overlap): one to
// one, at least MAC_WINDOW_CARRY_MIN_FRAMES of exclusive overlap, at least
// MAC_WINDOW_CARRY_AGREEMENT of those frames on one track. Anything weaker leaves
// the slot without a track, so its words stay `Ext`.
//
// A track is shown as `Voice N` only after clean proof in TWO distinct original
// chunks with distinct audio (each: MAC_WINDOW_PROOF_FRAMES exclusive, purity at
// least MAC_WINDOW_PROOF_PURITY). Numbers only grow; a corrupt state never
// restarts at Voice 1. A voice silent for longer than the window cannot be
// crosswalked: it reads `Ext` or, after its own two proofs, a NEW number. It is
// never given another voice's number. That split is the documented limit.
//
// A `Voice N` is capture-local acoustic continuity, never a person: similarity 0,
// never a profile, never enrolled or trained. No audio, embedding or probability
// matrix is stored: only per-frame track ids for the last few chunks.
//
// Switch: COS_MAC_LIVE_VOICES=window (default off). It also needs
// COS_MAC_VOICE_LABELS on. Any other value keeps the 6.92.1 per-chunk anchors.
import { NEMOTRON_CHANNELS } from './nemotron-cli.js'
import { ACTIVE_THRESHOLD, type Activity } from './nemotron-segments.js'
import { macVoiceLabelsEnabled, voiceLabel } from './mac-voice-labels.js'

export const MAC_WINDOW_MAX_CHUNKS = 5
/** 30 s of 16 kHz audio: bounds the CLI's work per chunk (measured about 0.26 s warm). */
export const MAC_WINDOW_MAX_SAMPLES = 480_000
export const MAC_WINDOW_SAMPLES_PER_FRAME = 160
export const MAC_WINDOW_CARRY_MIN_FRAMES = 100
export const MAC_WINDOW_CARRY_AGREEMENT = 0.8
export const MAC_WINDOW_NEW_TRACK_FRAMES = 200
export const MAC_WINDOW_PROOF_FRAMES = 200
export const MAC_WINDOW_PROOF_PURITY = 0.9
export const MAC_WINDOW_PROOFS = 2
/** Capture tracks, confirmed or not. Past this, new slots stay `Ext` (no eviction, no renumbering). */
export const MAC_WINDOW_MAX_TRACKS = 12
const MAX_VOICE = 99
// Per-frame codes stored for recent chunks. Track ids are 0..MAX_TRACKS-1.
const NONE = -1
const OVERLAP = -2
const UNTRACKED = -3

export function macWindowVoicesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.COS_MAC_LIVE_VOICES ?? '').trim().toLowerCase() === 'window' && macVoiceLabelsEnabled(env)
}

export interface MacWindowTrack {
  id: number
  /** The confirmed Voice number, or null while unproven. */
  voice: number | null
  proofs: Array<{ chunk: number; audioSha256: string }>
}

export interface MacWindowVoiceState {
  version: 1
  kind: 'window'
  /** Next track id. Never reused. */
  nextTrack: number
  /** Highest Voice number handed out. Never lowered. */
  voices: number
  tracks: MacWindowTrack[]
  /** The newest chunks' per-frame codes (base64 Int8), oldest first, at most MAC_WINDOW_MAX_CHUNKS - 1. */
  recent: Array<{ chunk: number; frames: string }>
}

export function emptyMacWindowVoices(): MacWindowVoiceState {
  return { version: 1, kind: 'window', nextTrack: 0, voices: 0, tracks: [], recent: [] }
}

const isIndex = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
const SHA = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function decodeFrames(frames: string): Int8Array | null {
  if (typeof frames !== 'string' || frames.length > 64_000 || !BASE64.test(frames) || frames.length % 4) return null
  const bytes = Buffer.from(frames, 'base64')
  if (bytes.toString('base64') !== frames) return null
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)
}

function encodeFrames(codes: Int8Array): string {
  return Buffer.from(codes.buffer, codes.byteOffset, codes.length).toString('base64')
}

/** Corrupt or foreign state is unavailable, never a fresh start. */
export function validMacWindowVoices(value: unknown): value is MacWindowVoiceState {
  const s = value as MacWindowVoiceState | null
  if (!s || typeof s !== 'object' || s.version !== 1 || s.kind !== 'window') return false
  if (!isIndex(s.nextTrack) || s.nextTrack > MAC_WINDOW_MAX_TRACKS || !isIndex(s.voices) || s.voices > MAX_VOICE) return false
  if (!Array.isArray(s.tracks) || s.tracks.length !== s.nextTrack || !Array.isArray(s.recent) || s.recent.length > MAC_WINDOW_MAX_CHUNKS - 1) return false
  const voices = new Set<number>()
  for (let i = 0; i < s.tracks.length; i++) {
    const t = s.tracks[i]
    if (!t || t.id !== i || !Array.isArray(t.proofs) || t.proofs.length > MAC_WINDOW_PROOFS) return false
    if (!t.proofs.every(p => p && isIndex(p.chunk) && typeof p.audioSha256 === 'string' && SHA.test(p.audioSha256))) return false
    if (new Set(t.proofs.map(p => p.chunk)).size !== t.proofs.length || new Set(t.proofs.map(p => p.audioSha256)).size !== t.proofs.length) return false
    if (t.voice !== null) {
      if (!isIndex(t.voice) || t.voice < 1 || t.voice > s.voices || voices.has(t.voice) || t.proofs.length < MAC_WINDOW_PROOFS) return false
      voices.add(t.voice)
    } else if (t.proofs.length >= MAC_WINDOW_PROOFS) return false
  }
  let last = -1
  for (const r of s.recent) {
    if (!r || !isIndex(r.chunk) || r.chunk <= last) return false
    const codes = decodeFrames(r.frames)
    if (!codes || codes.length === 0 || codes.some(c => c < UNTRACKED || c >= s.nextTrack)) return false
    last = r.chunk
  }
  return true
}

export interface MacWindowChunk {
  chunk: number
  /** Samples of this chunk inside the window WAV (the window is these chunks back to back). */
  samples: number
}

export interface MacWindowPlan {
  chunks: MacWindowChunk[]
}

/**
 * Which durable chunks go in chunk k's window: k and the contiguous run before it,
 * newest first, until MAC_WINDOW_MAX_CHUNKS or MAC_WINDOW_MAX_SAMPLES. A missing
 * chunk ends the run (no gap is ever bridged). `samplesOf` returns null when a
 * chunk has no durable WAV.
 */
export function planMacWindow(chunkIndex: number, samplesOf: (chunk: number) => number | null): MacWindowPlan | null {
  if (!isIndex(chunkIndex)) return null
  const own = samplesOf(chunkIndex)
  if (!isIndex(own) || own === 0 || own > MAC_WINDOW_MAX_SAMPLES) return null
  const chunks: MacWindowChunk[] = [{ chunk: chunkIndex, samples: own }]
  let total = own
  for (let c = chunkIndex - 1; c >= 0 && chunks.length < MAC_WINDOW_MAX_CHUNKS; c--) {
    const n = samplesOf(c)
    if (!isIndex(n) || n === 0 || total + n > MAC_WINDOW_MAX_SAMPLES) break
    chunks.unshift({ chunk: c, samples: n })
    total += n
  }
  return { chunks }
}

export interface MacWindowResult {
  /** The state to commit with this chunk (the input is not mutated). */
  state: MacWindowVoiceState
  /** Activity for the current chunk alone, in its own time base (frame 0 = chunk start). */
  chunkActivity: Activity
  /** Confirmed `Voice N` for a window slot, or null (the slot's words stay `Ext`). */
  labelOf: (slot: number) => string | null
  /** Counts for the log line; never text. */
  stats: { overlapChunks: number; carried: number; created: number; confirmed: number }
}

function activeSlots(a: Activity, f: number): number[] {
  const out: number[] = []
  for (let c = 0; c < NEMOTRON_CHANNELS; c++) if (a.probs[f * NEMOTRON_CHANNELS + c] >= ACTIVE_THRESHOLD) out.push(c)
  return out
}

/**
 * Crosswalk one window's activity onto the capture's tracks and return chunk k's
 * labels. Pure. Returns null (no labels) on any geometry it cannot trust.
 */
export function crosswalkMacWindow(input: {
  state: MacWindowVoiceState
  window: Activity
  plan: MacWindowPlan
  audioSha256: string
}): MacWindowResult | null {
  const { window, plan, audioSha256 } = input
  if (!validMacWindowVoices(input.state) || !SHA.test(audioSha256) || !plan.chunks.length) return null
  if (!Number.isInteger(window.frames) || window.frames <= 0 || window.probs.length !== window.frames * NEMOTRON_CHANNELS) return null
  for (const v of window.probs) if (!Number.isFinite(v) || v < 0 || v > 1) return null
  const state: MacWindowVoiceState = structuredClone(input.state)
  const current = plan.chunks[plan.chunks.length - 1]
  // Window frame offset of each chunk: its first sample / 160 (Mac chunks are 6 s, so exact).
  const offsets = new Map<number, number>()
  let sample = 0
  for (const c of plan.chunks) { offsets.set(c.chunk, Math.floor(sample / MAC_WINDOW_SAMPLES_PER_FRAME)); sample += c.samples }
  const expectedFrames = 1 + Math.floor((sample + 112) / MAC_WINDOW_SAMPLES_PER_FRAME)
  if (window.frames !== expectedFrames) return null
  const start = offsets.get(current.chunk)!
  const length = Math.floor(current.samples / MAC_WINDOW_SAMPLES_PER_FRAME)

  // 1. Overlap evidence: frames of earlier window chunks this capture attributed.
  const votes = new Map<number, Map<number, number>>()
  const exclusiveInOverlap = new Map<number, number>()
  let overlapChunks = 0
  for (const r of state.recent) {
    if (r.chunk >= current.chunk || !offsets.has(r.chunk)) continue
    const codes = decodeFrames(r.frames)!
    const off = offsets.get(r.chunk)!
    const n = Math.min(codes.length, Math.floor(plan.chunks.find(c => c.chunk === r.chunk)!.samples / MAC_WINDOW_SAMPLES_PER_FRAME))
    overlapChunks++
    for (let i = 0; i < n; i++) {
      const slots = activeSlots(window, off + i)
      if (slots.length !== 1) continue
      const slot = slots[0]
      exclusiveInOverlap.set(slot, (exclusiveInOverlap.get(slot) ?? 0) + 1)
      const track = codes[i]
      if (track < 0) continue
      const row = votes.get(slot) ?? new Map<number, number>()
      row.set(track, (row.get(track) ?? 0) + 1)
      votes.set(slot, row)
    }
  }
  // 2. One-to-one carry, strongest first. A tie can never reach the 0.8 agreement, so it is refused there.
  const candidates: Array<{ slot: number; track: number; count: number }> = []
  for (const [slot, row] of votes) for (const [track, count] of row) candidates.push({ slot, track, count })
  candidates.sort((a, b) => b.count - a.count || a.slot - b.slot || a.track - b.track)
  const slotTrack = new Map<number, number>()
  const usedTracks = new Set<number>()
  for (const c of candidates) {
    if (slotTrack.has(c.slot) || usedTracks.has(c.track)) continue
    if (c.count < MAC_WINDOW_CARRY_MIN_FRAMES || c.count / exclusiveInOverlap.get(c.slot)! < MAC_WINDOW_CARRY_AGREEMENT) continue
    slotTrack.set(c.slot, c.track)
    usedTracks.add(c.track)
  }
  const carried = slotTrack.size
  // 3. New tracks: only a slot with no attributed overlap at all (it may be an
  //    existing voice the crosswalk could not prove; then it stays untracked).
  const exclusiveNew = new Map<number, number>()
  const sharedNew = new Map<number, number>()
  for (let i = 0; i < length && start + i < window.frames; i++) {
    const slots = activeSlots(window, start + i)
    if (slots.length === 1) exclusiveNew.set(slots[0], (exclusiveNew.get(slots[0]) ?? 0) + 1)
    else for (const s of slots) sharedNew.set(s, (sharedNew.get(s) ?? 0) + 1)
  }
  let created = 0
  for (const [slot, n] of [...exclusiveNew.entries()].sort((a, b) => a[0] - b[0])) {
    if (slotTrack.has(slot) || votes.has(slot) || n < MAC_WINDOW_NEW_TRACK_FRAMES) continue
    if (state.nextTrack >= MAC_WINDOW_MAX_TRACKS) continue
    const id = state.nextTrack++
    state.tracks.push({ id, voice: null, proofs: [] })
    slotTrack.set(slot, id)
    created++
  }
  // 4. Proof for this chunk, then confirmation.
  let confirmed = 0
  for (const [slot, track] of slotTrack) {
    const ex = exclusiveNew.get(slot) ?? 0
    const purity = ex / Math.max(1, ex + (sharedNew.get(slot) ?? 0))
    const t = state.tracks[track]
    if (ex < MAC_WINDOW_PROOF_FRAMES || purity < MAC_WINDOW_PROOF_PURITY || t.voice !== null) continue
    if (t.proofs.some(p => p.chunk === current.chunk || p.audioSha256 === audioSha256)) continue
    t.proofs.push({ chunk: current.chunk, audioSha256 })
    if (t.proofs.length >= MAC_WINDOW_PROOFS) {
      if (state.voices >= MAX_VOICE) { t.proofs.pop(); continue }
      t.voice = ++state.voices
      confirmed++
    }
  }
  // 5. Remember this chunk's frames for the next window (bounded, no audio).
  const codes = new Int8Array(length)
  for (let i = 0; i < length; i++) {
    const slots = start + i < window.frames ? activeSlots(window, start + i) : []
    codes[i] = slots.length === 0 ? NONE : slots.length > 1 ? OVERLAP : (slotTrack.get(slots[0]) ?? UNTRACKED)
  }
  state.recent = [...state.recent.filter(r => r.chunk !== current.chunk), { chunk: current.chunk, frames: encodeFrames(codes) }]
    .sort((a, b) => a.chunk - b.chunk)
    .slice(-(MAC_WINDOW_MAX_CHUNKS - 1))
  // The chunk's own activity: the same frames a standalone chunk run would have.
  const chunkFrames = Math.min(window.frames - start, 1 + Math.floor((current.samples + 112) / MAC_WINDOW_SAMPLES_PER_FRAME))
  const chunkActivity: Activity = {
    frames: chunkFrames,
    probs: window.probs.slice(start * NEMOTRON_CHANNELS, (start + chunkFrames) * NEMOTRON_CHANNELS),
  }
  const snapshot = state.tracks.map(t => t.voice)
  const labelOf = (slot: number): string | null => {
    const track = slotTrack.get(slot)
    const voice = track === undefined ? null : snapshot[track]
    return voice ? voiceLabel(voice) : null
  }
  return { state, chunkActivity, labelOf, stats: { overlapChunks, carried, created, confirmed } }
}
