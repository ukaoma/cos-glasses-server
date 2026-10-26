// 6.90.0: unnamed, meeting-stable voice labels for Mac recordings.
//
// A Mac recording hears call audio, video and podcasts through one global tap.
// Named identity still requires the existing strict matching policy. Unknown
// speech stays `Ext` unless clean, independent acoustic observations establish
// capture-local continuity through mac-live-voices.ts. Chunk-local channel IDs
// never become meeting identities. Finalization preserves established live
// numbers; when no live numbers exist, confident final channels can become
// `Voice 1`, `Voice 2`, ... in order of first supporting speech.
//
// A `Voice N` label asserts NO identity. Everywhere a real name is checked it is
// a placeholder, exactly like `Ext` and `Unidentified N`: it is never a profile
// name, never enrolled, never trained, never written into the meeting's
// `speakers` list. A person may rename it (text only) through the relabel route.
//
// Switch: COS_MAC_VOICE_LABELS, on by default; 0, false, off or no turns it off
// and unknown Mac speech stays `Ext`; strict named matching keeps its policy.
// It governs ONLY the after-save pass (6.90.0) and is the master off for the live
// paths below. An explicit `1` is the default, not an opt-in to anything live.
//
// Live voices (6.93.0, on by default): `Voice N` while a Mac recording is running.
// One switch with three modes:
//   COS_MAC_LIVE_VOICES unset / empty / window / any value not named below  window:
//                       the 6.93.0 window replay (bounded timeout budget, back-off
//                       to per-chunk after two timeouts in a row). THE DEFAULT.
//   COS_MAC_LIVE_VOICES=anchors   the 6.92.1 per-chunk acoustic anchors.
//   COS_MAC_LIVE_VOICES=off (also 0, false, no)  the opt-out: every live Mac chunk is
//                       `Ext`, exactly as 6.92.0; the saved pass numbers all voices.
// COS_MAC_VOICE_LABELS off also turns both live modes off.
// Known limit: a clean hand-over between two people exactly at a chunk boundary can
// give the new speaker the previous number (R1). It is a numbering limit, never a name.

// No imports on purpose: placeholder checks are read from the speaker-review,
// relabel and store layers, and this must never pull the Mac registry into them.
const MAC_SOURCE_TYPE = 'mac_system_audio'

/** `Voice 1` .. `Voice 99`. No leading zero, single space, nothing after. */
export const VOICE_LABEL = /^Voice [1-9]\d?$/

export function isVoiceLabel(label: unknown): boolean {
  return typeof label === 'string' && VOICE_LABEL.test(label)
}

export function voiceLabel(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error('voice number out of range')
  return `Voice ${n}`
}

/** On unless explicitly switched off. Read at use, so a managed restart is not needed to turn it off. */
export function macVoiceLabelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.COS_MAC_VOICE_LABELS ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(raw)
}

/**
 * True when a stored chunk (or any of its turns) already carries a `Voice N`.
 * `segments` is shape-checked: a recovered chunk with a malformed field must not
 * throw into the chunk route (QA N3).
 */
export function chunkShowsVoiceLabel(chunk: { speaker?: unknown; segments?: unknown } | null | undefined): boolean {
  if (isVoiceLabel(chunk?.speaker)) return true
  const segments = chunk?.segments
  return Array.isArray(segments) && segments.some(segment => isVoiceLabel((segment as { speaker?: unknown } | null)?.speaker))
}

export type MacLiveVoicesMode = 'off' | 'anchors' | 'window'

/**
 * Which live `Voice N` path may run for a Mac chunk. `window` unless COS_MAC_LIVE_VOICES
 * says `off` (or 0, false, no) or `anchors`, or COS_MAC_VOICE_LABELS is off. Read at use,
 * like the switch above, so turning it off needs no managed restart.
 */
export function macLiveVoicesMode(env: NodeJS.ProcessEnv = process.env): MacLiveVoicesMode {
  if (!macVoiceLabelsEnabled(env)) return 'off'
  const raw = String(env.COS_MAC_LIVE_VOICES ?? '').trim().toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(raw)) return 'off'
  return raw === 'anchors' ? 'anchors' : 'window'
}

/**
 * A sidecar written by the Mac recording save path (`sourceType`), or any `mac_`
 * id. Deliberately broader than MAC_CAPTURE_ID: this answers "could this be Mac
 * audio", and a guard that asks it must fail closed on a malformed Mac id too.
 */
export function isMacCaptureSidecar(sidecar: Record<string, unknown> | null | undefined, sessionId?: string): boolean {
  if (typeof sessionId === 'string' && sessionId.startsWith('mac_')) return true
  if (!sidecar || typeof sidecar !== 'object') return false
  if (sidecar.sourceType === MAC_SOURCE_TYPE) return true
  return typeof sidecar.sessionId === 'string' && sidecar.sessionId.startsWith('mac_')
}
