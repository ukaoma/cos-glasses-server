// Capture-local acoustic anchors. These are anonymous continuity evidence, never
// profiles or training samples. Owned by the existing private active-session
// file and deleted with that session. Fixed anchors avoid centroid drift.
import { isVoiceLabel, voiceLabel } from './mac-voice-labels.js'
// Anonymous continuity is an independent decision from named recognition or
// automatic enrollment. These conservative constants are not calibrated claims.
export const MAC_LIVE_MATCH_SIMILARITY = 0.88
export const MAC_LIVE_NEW_VOICE_MAX_SIMILARITY = 0.55
export const MAC_LIVE_MATCH_MARGIN = 0.1

// A bounded active-capture evidence budget, including unconfirmed candidates;
// not Nemotron's channel capacity and not a promise to distinguish every voice.
export const MAC_LIVE_MAX_VOICES = 6
export interface MacLiveVoiceState {
  version: 1
  anchors: Array<{ embedding: number[]; firstChunk: number; firstAudioSha256: string; confirmed: boolean }>
}
const validEmbedding = (e: unknown): e is number[] => Array.isArray(e) && e.length >= 2 && e.length <= 1024 && e.every(x => typeof x === 'number' && Number.isFinite(x)) && Math.hypot(...e) > 0 && Number.isFinite(Math.hypot(...e))
function cosine(a: number[], b: number[]): number {
  // Normalize first: aa*bb and unnormalized dot products can overflow even
  // when both vectors and their individual norms are finite.
  const aa = Math.hypot(...a), bb = Math.hypot(...b)
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i]/aa) * (b[i]/bb)
  return Math.max(-1,Math.min(1,dot))
}
/** Corrupt continuity must stay unavailable, never restart numbering at Voice 1. */
export function validMacLiveVoices(value: unknown): value is MacLiveVoiceState {
  const s = value as MacLiveVoiceState | null
  return !!s && s.version === 1 && Array.isArray(s.anchors) && s.anchors.length <= MAC_LIVE_MAX_VOICES && s.anchors.every(a => validEmbedding(a?.embedding) && Number.isInteger(a.firstChunk) && a.firstChunk >= 0 && /^[0-9a-f]{64}$/.test(a.firstAudioSha256) && typeof a.confirmed === 'boolean') && s.anchors.every(a => a.embedding.length === s.anchors[0].embedding.length)
}
/** Two clean tracks from DIFFERENT chunks must agree before a label appears.
 * Ambiguous/weak matches stay Ext; they never allocate another numbered voice.
 * No profile is consulted and no input channel number is retained. */
export function matchMacLiveVoice(state: MacLiveVoiceState, embedding: Float32Array | null, chunkIndex: number, audioSha256: string): string | null {
  if (!validMacLiveVoices(state) || !embedding || !Number.isInteger(chunkIndex) || chunkIndex < 0 || !/^[0-9a-f]{64}$/.test(audioSha256)) return null
  const e = Array.from(embedding)
  if (!validEmbedding(e) || state.anchors.some(a => a.embedding.length !== e.length)) return null
  const scores = state.anchors.map((a, index) => ({ index, score: cosine(a.embedding, e) })).sort((a,b) => b.score - a.score)
  const best = scores[0]
  if (best && best.score >= MAC_LIVE_MATCH_SIMILARITY) {
    if (scores[1] && best.score - scores[1].score < MAC_LIVE_MATCH_MARGIN) return null
    const anchor = state.anchors[best.index]
    if (anchor.firstChunk !== chunkIndex && anchor.firstAudioSha256 !== audioSha256) anchor.confirmed = true
    return anchor.confirmed ? voiceLabel(best.index + 1) : null
  }
  // Intermediate continuity evidence is uncertain, not a NEW voice. This is
  // owned here and does not follow global identity/enrollment tuning.
  if ((best && best.score >= MAC_LIVE_NEW_VOICE_MAX_SIMILARITY) || state.anchors.length >= MAC_LIVE_MAX_VOICES) return null
  state.anchors.push({ embedding: e, firstChunk: chunkIndex, firstAudioSha256: audioSha256, confirmed: false })
  return null
}
/** Preserve only server-generated anonymous continuity labels after the normal
 * strict identity projection. No client-supplied label can use this escape. */
export function macAnonymousProjection<T extends { speaker: string; similarity?: number }>(raw: T, strict: T): T {
  return isVoiceLabel(raw.speaker) ? { ...strict, speaker: raw.speaker, similarity: 0 } : strict
}
