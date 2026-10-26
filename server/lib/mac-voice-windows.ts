// Candidate temporal evidence planner. Not wired into live capture until natural
// acoustic qualification succeeds. No model, profile, filesystem or channel ID.
import { createHash } from 'node:crypto'

export const MAC_VOICE_WINDOW_MIN_SAMPLES = 12 * 16_000
export const MAC_VOICE_WINDOW_MAX_SAMPLES = 30 * 16_000
export const MAC_VOICE_WINDOW_MAX_SOURCES = 5
export interface MacVoiceSource {
  chunkIndex: number
  audioSha256: string
  startSample: number
  samples: number
}
export interface MacVoiceWindow {
  captureId: string
  sources: MacVoiceSource[]
}
/** Descriptors only: at most four pending + five previous + one last reference.
 * PCM stays in the existing private chunk store, not this durable JSON state. */
export interface MacVoiceWindowState {
  version: 1
  captureId: string
  last: MacVoiceSource | null
  pending: MacVoiceSource[]
  previous: MacVoiceSource[]
}
export type MacVoiceWindowPlan =
  | { status: 'rejected'; reason: 'invalid_state' | 'invalid_source' | 'out_of_order' | 'index_conflict' }
  | { status: 'duplicate' }
  | { status: 'collecting' | 'ready'; next: MacVoiceWindowState; window?: MacVoiceWindow; reset?: 'gap' | 'duplicate_audio' | 'budget' }
const capture = (s: unknown): s is string => typeof s === 'string' && /^mac_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s)
const valid = (s: MacVoiceSource): boolean => !!s && typeof s === 'object' && !Array.isArray(s)
  && Object.keys(s).length === 4 && Object.keys(s).every(k => ['chunkIndex','audioSha256','startSample','samples'].includes(k))
  && Number.isSafeInteger(s.chunkIndex) && s.chunkIndex >= 0
  && typeof s.audioSha256 === 'string' && /^[0-9a-f]{64}$/.test(s.audioSha256)
  && Number.isSafeInteger(s.startSample) && s.startSample >= 0
  && Number.isSafeInteger(s.samples) && s.samples > 0 && s.samples <= MAC_VOICE_WINDOW_MAX_SAMPLES
  && Number.isSafeInteger(s.startSample + s.samples)
const total = (refs: MacVoiceSource[]) => refs.reduce((sum, s) => sum + s.samples, 0)
function contiguous(refs: MacVoiceSource[]): boolean {
  return refs.every((s, i) => valid(s) && (i === 0 || (s.chunkIndex === refs[i-1].chunkIndex + 1
    && s.startSample === refs[i-1].startSample + refs[i-1].samples)))
    && new Set(refs.map(s => s.audioSha256)).size === refs.length
}
const same = (a: MacVoiceSource, b: MacVoiceSource) => a.chunkIndex === b.chunkIndex && a.audioSha256 === b.audioSha256 && a.startSample === b.startSample && a.samples === b.samples
function validState(state: MacVoiceWindowState, id: string): boolean {
  if (!state || Object.keys(state).length !== 5 || !Object.keys(state).every(k => ['version','captureId','last','pending','previous'].includes(k)) || state.version !== 1 || state.captureId !== id || !Array.isArray(state.pending) || !Array.isArray(state.previous)) return false
  if (state.pending.length >= MAC_VOICE_WINDOW_MAX_SOURCES || state.previous.length > MAC_VOICE_WINDOW_MAX_SOURCES
    || !contiguous(state.pending) || !contiguous(state.previous) || total(state.pending) >= MAC_VOICE_WINDOW_MIN_SAMPLES) return false
  if (state.last === null) return state.pending.length === 0 && state.previous.length === 0
  if (!valid(state.last)) return false
  if (state.pending.length && !same(state.pending.at(-1)!, state.last)) return false
  if (state.previous.length && total(state.previous) < MAC_VOICE_WINDOW_MIN_SAMPLES) return false
  if (total(state.previous) > MAC_VOICE_WINDOW_MAX_SAMPLES) return false
  if (state.previous.length) {
    const end = state.previous.at(-1)!
    if (end.chunkIndex > state.last.chunkIndex || (end.chunkIndex === state.last.chunkIndex && !same(end, state.last))) return false
    if (end.chunkIndex < state.last.chunkIndex && state.last.startSample < end.startSample + end.samples) return false
    if (state.pending.length && state.pending[0].startSample < end.startSample + end.samples) return false
  }
  if (state.previous.some(s => state.pending.some(p => p.chunkIndex <= s.chunkIndex || p.audioSha256 === s.audioSha256))) return false
  return true
}
function validWindow(window: MacVoiceWindow): boolean {
  return !!window && Object.keys(window).length === 2 && capture(window.captureId) && Array.isArray(window.sources) && window.sources.length > 0
    && window.sources.length <= MAC_VOICE_WINDOW_MAX_SOURCES && contiguous(window.sources)
    && total(window.sources) >= MAC_VOICE_WINDOW_MIN_SAMPLES && total(window.sources) <= MAC_VOICE_WINDOW_MAX_SAMPLES
}
/** Pure staging: the caller must commit `next` only with the accepted canonical
 * chunk's durable write. A retry after failed persistence starts from the prior
 * state and produces the identical plan; planning never consumes evidence. */
export function planMacVoiceWindow(captureId: string, prior: MacVoiceWindowState | undefined, source: MacVoiceSource): MacVoiceWindowPlan {
  if (!capture(captureId) || (prior !== undefined && !validState(prior, captureId))) return { status: 'rejected', reason: 'invalid_state' }
  if (!valid(source)) return { status: 'rejected', reason: 'invalid_source' }
  const next: MacVoiceWindowState = prior ? structuredClone(prior) : { version: 1, captureId, last: null, pending: [], previous: [] }
  if (next.last && source.chunkIndex === next.last.chunkIndex) return same(source, next.last) ? { status: 'duplicate' } : { status: 'rejected', reason: 'index_conflict' }
  if (next.last && source.chunkIndex < next.last.chunkIndex) return { status: 'rejected', reason: 'out_of_order' }
  if (next.last && source.startSample < next.last.startSample + next.last.samples) return { status: 'rejected', reason: 'out_of_order' }
  let reset: 'gap' | 'duplicate_audio' | 'budget' | undefined
  if (next.last && (source.chunkIndex !== next.last.chunkIndex + 1 || source.startSample !== next.last.startSample + next.last.samples)) {
    next.pending = []; reset = 'gap'
  }
  const previousLast = next.last
  next.last = { ...source }
  if ([...next.pending, ...next.previous, ...(previousLast ? [previousLast] : [])].some(s => s.audioSha256 === source.audioSha256)) {
    next.pending = []
    return { status: 'collecting', next, reset: 'duplicate_audio' }
  }
  if (next.pending.length + 1 > MAC_VOICE_WINDOW_MAX_SOURCES || total(next.pending) + source.samples > MAC_VOICE_WINDOW_MAX_SAMPLES) {
    next.pending = []; reset = 'budget'
  }
  next.pending.push({ ...source })
  if (total(next.pending) < MAC_VOICE_WINDOW_MIN_SAMPLES) {
    // A full descriptor budget that cannot reach the duration floor is unusable.
    if (next.pending.length === MAC_VOICE_WINDOW_MAX_SOURCES) { next.pending = [{ ...source }]; reset = 'budget' }
    return { status: 'collecting', next, ...(reset ? { reset } : {}) }
  }
  const window = { captureId, sources: structuredClone(next.pending) }
  next.previous = structuredClone(next.pending); next.pending = []
  return { status: 'ready', next, window, ...(reset ? { reset } : {}) }
}
/** Different combined hashes are insufficient: overlapping raw inputs, reused
 * audio under another index, and another capture are never independent support. */
export function independentMacVoiceWindows(a: MacVoiceWindow, b: MacVoiceWindow): boolean {
  return validWindow(a) && validWindow(b) && a.captureId === b.captureId
    && !a.sources.some(x => b.sources.some(y => x.chunkIndex === y.chunkIndex || x.audioSha256 === y.audioSha256
      || (x.startSample < y.startSample + y.samples && y.startSample < x.startSample + x.samples)))
}
/** Materialize one bounded ephemeral WAV after checking every original hash and
 * canonical ingress format. Never bridge gaps, pad silence, truncate or resample. */
export function assembleMacVoiceWindow(window: MacVoiceWindow, inputs: Array<{ source: MacVoiceSource; audio: Buffer }>): Buffer | null {
  if (!validWindow(window) || !Array.isArray(inputs) || inputs.length !== window.sources.length) return null
  for (let i=0; i<inputs.length; i++) {
    const input = inputs[i]
    if (!input || !valid(input.source) || !Buffer.isBuffer(input.audio)) return null
    const { source, audio } = input
    if (!same(source, window.sources[i]) || audio.length !== 44 + source.samples * 2
      || audio.toString('ascii',0,4) !== 'RIFF' || audio.toString('ascii',8,12) !== 'WAVE'
      || audio.toString('ascii',12,16) !== 'fmt ' || audio.readUInt32LE(16) !== 16
      || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16_000
      || audio.readUInt32LE(28) !== 32_000 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
      || audio.toString('ascii',36,40) !== 'data' || audio.readUInt32LE(40) !== source.samples * 2
      || audio.readUInt32LE(4) !== audio.length - 8 || createHash('sha256').update(audio).digest('hex') !== source.audioSha256) return null
  }
  const header = Buffer.from(inputs[0].audio.subarray(0,44)), bytes = total(window.sources) * 2
  header.writeUInt32LE(36+bytes,4); header.writeUInt32LE(bytes,40)
  return Buffer.concat([header, ...inputs.map(input => input.audio.subarray(44))], 44+bytes)
}
