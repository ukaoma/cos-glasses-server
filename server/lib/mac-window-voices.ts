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
// A carried slot is used only if the current chunk AGREES (QA W1): the same chunk
// diarized alone (the per-chunk run, an independent view) must put the slot's
// exclusive frames on one channel (MAC_WINDOW_AGREE_PURITY of the frames it can
// place, MAC_WINDOW_AGREE_COVERAGE of them placed). A window model that merged a
// new voice into an old slot is therefore not carried: the slot gets no label and
// no proof this chunk, and its frames are stored as untracked so the error cannot
// feed the next window.
//
// A track is shown as `Voice N` only after clean proof in TWO distinct original
// chunks with distinct audio (each: MAC_WINDOW_PROOF_FRAMES exclusive, purity at
// least MAC_WINDOW_PROOF_PURITY). Numbers only grow; a corrupt state never
// restarts at Voice 1. A track no recent window frame refers to is evicted (QA W3),
// so a long meeting cannot spend the MAC_WINDOW_MAX_TRACKS ids; its number stays
// spent. A voice silent for longer than the window cannot be crosswalked: it reads
// `Ext` or, after its own two proofs, a NEW number (the saved meeting's final pass
// numbers what live did not prove). It is never given another voice's number.
//
// A `Voice N` is capture-local acoustic continuity, never a person: similarity 0,
// never a profile, never enrolled or trained. No audio, embedding or probability
// matrix is stored: only per-frame track ids for the last few chunks.
//
// Switch: COS_MAC_LIVE_VOICES=window (default off; see mac-voice-labels.ts). It also
// needs COS_MAC_VOICE_LABELS not off. `anchors` runs the 6.92.1 per-chunk anchors
// instead; unset or anything else runs neither, so every live Mac chunk is `Ext`.
import { MAC_AUDIO } from './mac-recording.js'
import { NEMOTRON_CHANNELS, NEMOTRON_FRAME_SEC } from './nemotron-cli.js'
import { ACTIVE_THRESHOLD, type Activity } from './nemotron-segments.js'
import { macLiveVoicesMode, voiceLabel } from './mac-voice-labels.js'

export const MAC_WINDOW_MAX_CHUNKS = 5
/** One Mac chunk's most audio (30 s at 16 kHz), derived from the capture contract. Bounds the CLI's work per chunk (measured about 0.26 s warm). */
export const MAC_WINDOW_MAX_SAMPLES = MAC_AUDIO.sampleRate * (MAC_AUDIO.maxChunkMs / 1000)
/** The CLI's frame hop: NEMOTRON_FRAME_SEC (10 ms) of 16 kHz audio = 160 samples. */
export const MAC_WINDOW_SAMPLES_PER_FRAME = Math.round(MAC_AUDIO.sampleRate * NEMOTRON_FRAME_SEC)
/**
 * The CLI's mel front end frames a clip of N samples as 1 + floor((N + FFT - WINDOW) / hop):
 * n_fft 512 minus window 400 = 112 (measured: 36 s -> 3601 frames; a mismatch refuses the window).
 */
export const MAC_WINDOW_FFT_SAMPLES = 512
export const MAC_WINDOW_FRAME_SAMPLES = 400
export const MAC_WINDOW_FRAME_TAIL_SAMPLES = MAC_WINDOW_FFT_SAMPLES - MAC_WINDOW_FRAME_SAMPLES
/** Frames the CLI returns for `samples` of audio. The one place the geometry is written down. */
export function macWindowFrameCount(samples: number): number {
  return 1 + Math.floor((samples + MAC_WINDOW_FRAME_TAIL_SAMPLES) / MAC_WINDOW_SAMPLES_PER_FRAME)
}
export const MAC_WINDOW_CARRY_MIN_FRAMES = 100
export const MAC_WINDOW_CARRY_AGREEMENT = 0.8
export const MAC_WINDOW_NEW_TRACK_FRAMES = 200
export const MAC_WINDOW_PROOF_FRAMES = 200
export const MAC_WINDOW_PROOF_PURITY = 0.9
export const MAC_WINDOW_PROOFS = 2
/** Carried-slot agreement with the chunk diarized alone (QA W1): share of the slot's exclusive frames the per-chunk run must place, and the share of those on one channel. */
export const MAC_WINDOW_AGREE_COVERAGE = 0.5
export const MAC_WINDOW_AGREE_PURITY = 0.9
/** Live capture tracks (ids 0..11). A track no recent frame refers to is evicted and its id reused; past this at once, new slots stay `Ext`. */
export const MAC_WINDOW_MAX_TRACKS = 12
const MAX_VOICE = 99
// Per-frame codes stored for recent chunks. Track ids are 0..MAX_TRACKS-1.
const NONE = -1
const OVERLAP = -2
const UNTRACKED = -3

export function macWindowVoicesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return macLiveVoicesMode(env) === 'window'
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
  /** Every track id is below this (at most MAC_WINDOW_MAX_TRACKS). Ids of evicted tracks are reused, only once no recent frame refers to them. */
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
  if (!Array.isArray(s.tracks) || s.tracks.length > s.nextTrack || !Array.isArray(s.recent) || s.recent.length > MAC_WINDOW_MAX_CHUNKS - 1) return false
  const voices = new Set<number>()
  let lastId = -1
  for (let i = 0; i < s.tracks.length; i++) {
    const t = s.tracks[i]
    if (!t || !isIndex(t.id) || t.id <= lastId || t.id >= s.nextTrack || !Array.isArray(t.proofs) || t.proofs.length > MAC_WINDOW_PROOFS) return false
    lastId = t.id
    if (!t.proofs.every(p => p && isIndex(p.chunk) && typeof p.audioSha256 === 'string' && SHA.test(p.audioSha256))) return false
    if (new Set(t.proofs.map(p => p.chunk)).size !== t.proofs.length || new Set(t.proofs.map(p => p.audioSha256)).size !== t.proofs.length) return false
    if (t.voice !== null) {
      if (!isIndex(t.voice) || t.voice < 1 || t.voice > s.voices || voices.has(t.voice) || t.proofs.length < MAC_WINDOW_PROOFS) return false
      voices.add(t.voice)
    } else if (t.proofs.length >= MAC_WINDOW_PROOFS) return false
  }
  const ids = new Set(s.tracks.map(t => t.id))
  let last = -1
  for (const r of s.recent) {
    if (!r || !isIndex(r.chunk) || r.chunk <= last) return false
    const codes = decodeFrames(r.frames)
    // A frame may only name a track that still exists (an evicted id has no frame).
    if (!codes || codes.length === 0 || codes.some(c => c < UNTRACKED || (c >= 0 && !ids.has(c)))) return false
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

export interface MacWindowStats {
  overlapChunks: number
  /** Slots carried to an existing track through the overlap (before the agreement check). */
  carried: number
  /** Carried slots that speak in this chunk and that the chunk diarized alone did not agree with: no label, no proof, frames stored untracked. (A carried slot silent in this chunk is not counted.) */
  withheld: number
  created: number
  confirmed: number
  /** Tracks dropped because no recent frame refers to them. */
  evicted: number
  /** New tracks refused because every id was in use. */
  capped: number
}

export interface MacWindowResult {
  /** The state to commit with this chunk (the input is not mutated). */
  state: MacWindowVoiceState
  /** Activity for the current chunk alone, in its own time base (frame 0 = chunk start). */
  chunkActivity: Activity
  /** Confirmed `Voice N` for a window slot, or null (the slot's words stay `Ext`). */
  labelOf: (slot: number) => string | null
  /** Counts for the log line; never text. */
  stats: MacWindowStats
}

function activeSlots(a: Activity, f: number): number[] {
  const out: number[] = []
  for (let c = 0; c < NEMOTRON_CHANNELS; c++) if (a.probs[f * NEMOTRON_CHANNELS + c] >= ACTIVE_THRESHOLD) out.push(c)
  return out
}

/**
 * Does the chunk diarized alone put this slot's exclusive frames on one channel?
 * `alone` is the per-chunk run's activity in the chunk's own time base. A merged
 * window slot (two voices) splits across channels there; a slot the per-chunk run
 * cannot place is not agreed with. No evidence is no agreement.
 */
export function chunkAgreesWithSlot(window: Activity, start: number, length: number, slot: number, alone: Activity | null): boolean {
  if (!alone || alone.probs.length !== alone.frames * NEMOTRON_CHANNELS) return false
  let own = 0
  let covered = 0
  const perChannel = new Map<number, number>()
  for (let i = 0; i < length && start + i < window.frames; i++) {
    const slots = activeSlots(window, start + i)
    if (slots.length !== 1 || slots[0] !== slot) continue
    own++
    if (i >= alone.frames) continue
    const there = activeSlots(alone, i)
    if (there.length !== 1) continue
    covered++
    perChannel.set(there[0], (perChannel.get(there[0]) ?? 0) + 1)
  }
  // A slot with no exclusive frame here (own = 0) places nothing (covered = 0): no agreement.
  if (covered === 0 || covered < own * MAC_WINDOW_AGREE_COVERAGE) return false
  return Math.max(...perChannel.values()) / covered >= MAC_WINDOW_AGREE_PURITY
}

/**
 * Crosswalk one window's activity onto the capture's tracks and return chunk k's
 * labels. Pure. Returns null (no labels) on any geometry it cannot trust.
 * `chunkAlone` is the same chunk diarized by itself (or null when that run is not
 * available): a carried slot is used only if it agrees with it (QA W1).
 */
export function crosswalkMacWindow(input: {
  state: MacWindowVoiceState
  window: Activity
  plan: MacWindowPlan
  audioSha256: string
  chunkAlone: Activity | null
}): MacWindowResult | null {
  const { window, plan, audioSha256 } = input
  if (!validMacWindowVoices(input.state) || !SHA.test(audioSha256) || !plan.chunks.length) return null
  if (!Number.isInteger(window.frames) || window.frames <= 0 || window.probs.length !== window.frames * NEMOTRON_CHANNELS) return null
  for (const v of window.probs) if (!Number.isFinite(v) || v < 0 || v > 1) return null
  const state: MacWindowVoiceState = structuredClone(input.state)
  const current = plan.chunks[plan.chunks.length - 1]
  // Window frame offset of each chunk: its first sample / 160. Chunks are whole frames in practice (6 s); an odd length shifts later offsets by under a frame, which the geometry check below still bounds.
  const offsets = new Map<number, number>()
  let sample = 0
  for (const c of plan.chunks) { offsets.set(c.chunk, Math.floor(sample / MAC_WINDOW_SAMPLES_PER_FRAME)); sample += c.samples }
  if (window.frames !== macWindowFrameCount(sample)) return null
  const start = offsets.get(current.chunk)!
  const length = Math.floor(current.samples / MAC_WINDOW_SAMPLES_PER_FRAME)
  const trackById = (id: number) => state.tracks.find(t => t.id === id)!

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
  // 2. One-to-one carry, strongest first. Two tracks tied on ONE slot cannot reach the 0.8 agreement, so
  //    that slot is refused there. Two slots tied for ONE track go to the lower slot index; if that slot is not
  //    the one speaking in this chunk, step 2b withholds it (it has no exclusive frames here) and the
  //    other slot gets no track either: no label, never the wrong one.
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
  // 2b. The current chunk must agree (QA W1). A slot whose overlap says "track T"
  //     while this chunk's own audio says "two voices here" is not carried: it gets
  //     no label and no proof, and its frames below are stored untracked.
  const exclusiveNew = new Map<number, number>()
  const sharedNew = new Map<number, number>()
  for (let i = 0; i < length && start + i < window.frames; i++) {
    const slots = activeSlots(window, start + i)
    if (slots.length === 1) exclusiveNew.set(slots[0], (exclusiveNew.get(slots[0]) ?? 0) + 1)
    else for (const s of slots) sharedNew.set(s, (sharedNew.get(s) ?? 0) + 1)
  }
  let withheld = 0
  for (const slot of [...slotTrack.keys()]) {
    // A carried slot that is silent here (no exclusive frame) has nothing to label or prove this chunk: it
    // simply is not used, and is not a disagreement. A speaking one must be agreed with.
    if ((exclusiveNew.get(slot) ?? 0) === 0) { slotTrack.delete(slot); continue }
    if (chunkAgreesWithSlot(window, start, length, slot, input.chunkAlone)) continue
    slotTrack.delete(slot)
    withheld++
  }
  // 3. New tracks: only a slot with no attributed overlap at all (it may be an
  //    existing voice the crosswalk could not prove; then it stays untracked).
  let created = 0
  let capped = 0
  for (const [slot, n] of [...exclusiveNew.entries()].sort((a, b) => a[0] - b[0])) {
    if (slotTrack.has(slot) || votes.has(slot) || n < MAC_WINDOW_NEW_TRACK_FRAMES) continue
    // The lowest id no track holds. An evicted id is free: no recent frame refers to it.
    let id = 0
    while (id < MAC_WINDOW_MAX_TRACKS && state.tracks.some(t => t.id === id)) id++
    if (id >= MAC_WINDOW_MAX_TRACKS) { capped++; continue }
    state.tracks.push({ id, voice: null, proofs: [] })
    state.tracks.sort((a, b) => a.id - b.id)
    state.nextTrack = Math.max(state.nextTrack, id + 1)
    slotTrack.set(slot, id)
    created++
  }
  // 4. Proof for this chunk, then confirmation.
  let confirmed = 0
  for (const [slot, track] of slotTrack) {
    const ex = exclusiveNew.get(slot) ?? 0
    const purity = ex / Math.max(1, ex + (sharedNew.get(slot) ?? 0))
    const t = trackById(track)
    if (ex < MAC_WINDOW_PROOF_FRAMES || purity < MAC_WINDOW_PROOF_PURITY || t.voice !== null) continue
    if (t.proofs.some(p => p.chunk === current.chunk || p.audioSha256 === audioSha256)) continue
    t.proofs.push({ chunk: current.chunk, audioSha256 })
    if (t.proofs.length >= MAC_WINDOW_PROOFS) {
      if (state.voices >= MAX_VOICE) { t.proofs.pop(); continue }
      t.voice = ++state.voices
      confirmed++
    }
  }
  // The labels this chunk may show, taken before any eviction.
  const labelByTrack = new Map<number, number | null>(state.tracks.map(t => [t.id, t.voice]))
  // 5. Remember this chunk's frames for the next window (bounded, no audio).
  const codes = new Int8Array(length)
  for (let i = 0; i < length; i++) {
    const slots = start + i < window.frames ? activeSlots(window, start + i) : []
    codes[i] = slots.length === 0 ? NONE : slots.length > 1 ? OVERLAP : (slotTrack.get(slots[0]) ?? UNTRACKED)
  }
  state.recent = [...state.recent.filter(r => r.chunk !== current.chunk), { chunk: current.chunk, frames: encodeFrames(codes) }]
    .sort((a, b) => a.chunk - b.chunk)
    .slice(-(MAC_WINDOW_MAX_CHUNKS - 1))
  // 6. Evict (QA W3): a track no remembered frame refers to can never be carried
  //    again, so it only spends an id. Its Voice number stays spent (`voices` never drops).
  const referenced = new Set<number>()
  for (const r of state.recent) for (const c of decodeFrames(r.frames)!) if (c >= 0) referenced.add(c)
  const before = state.tracks.length
  state.tracks = state.tracks.filter(t => referenced.has(t.id))
  const evicted = before - state.tracks.length
  // The chunk's own activity: the same frames a standalone chunk run would have.
  const chunkFrames = Math.min(window.frames - start, macWindowFrameCount(current.samples))
  const chunkActivity: Activity = {
    frames: chunkFrames,
    probs: window.probs.slice(start * NEMOTRON_CHANNELS, (start + chunkFrames) * NEMOTRON_CHANNELS),
  }
  const labelOf = (slot: number): string | null => {
    const track = slotTrack.get(slot)
    const voice = track === undefined ? null : labelByTrack.get(track)
    return voice ? voiceLabel(voice) : null
  }
  return { state, chunkActivity, labelOf, stats: { overlapChunks, carried, withheld, created, confirmed, evicted, capped } }
}
