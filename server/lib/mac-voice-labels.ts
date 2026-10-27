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
//   COS_MAC_LIVE_VOICES unset / empty / window  window:
//                       the 6.93.0 window replay (bounded timeout budget, back-off
//                       to per-chunk when 2 of the last 3 window runs timed out). THE DEFAULT.
//                       Any other value not named below also means window, and logs
//                       `mac_live_voices_unrecognised` once so a typo is not silent.
//   COS_MAC_LIVE_VOICES=anchors   the 6.92.1 per-chunk acoustic anchors.
//   COS_MAC_LIVE_VOICES=off (also 0, false, no, none, disable, disabled, never)  the opt-out:
//                       every live Mac chunk is `Ext`, exactly as 6.92.0; the saved pass
//                       numbers all voices.
// COS_MAC_VOICE_LABELS off also turns both live modes off.
// Known limit: a clean hand-over between two people exactly at a chunk boundary can
// give the new speaker the previous number (R1). The saved pass keeps every live number,
// so it stays in the saved meeting. Assigning such a `Voice N` to a profile is gated
// (mac-voice-assignment.ts: below the floor, a mixed group, or too little audio is refused
// unless forced), so a wrong number does not silently become a wrong voiceprint.

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

/** Every spelling of "off" these switches accept (6.93.0 added none, disable, disabled, never). */
export const OFF_WORDS: readonly string[] = ['0', 'false', 'off', 'no', 'none', 'disable', 'disabled', 'never']

/** On unless explicitly switched off. The environment is read once at server start, so a change needs a restart. */
export function macVoiceLabelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.COS_MAC_VOICE_LABELS ?? '').trim().toLowerCase()
  return !OFF_WORDS.includes(raw)
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

const warnedUnrecognised = new Set<string>()

/** Test seam: forget which values have already been warned about. */
export function __resetMacLiveVoicesWarningsForTests(): void { warnedUnrecognised.clear() }

/**
 * Which live `Voice N` path may run for a Mac chunk. `window` unless COS_MAC_LIVE_VOICES
 * says off (any word in OFF_WORDS) or `anchors`, or COS_MAC_VOICE_LABELS is off. A value
 * that is none of those still means `window` (a typo of window is the likely case), but
 * logs `mac_live_voices_unrecognised` once per value. The environment is read once at
 * server start, so changing either switch needs a restart.
 */
export function macLiveVoicesMode(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = console.warn): MacLiveVoicesMode {
  if (!macVoiceLabelsEnabled(env)) return 'off'
  const raw = String(env.COS_MAC_LIVE_VOICES ?? '').trim().toLowerCase()
  if (OFF_WORDS.includes(raw)) return 'off'
  if (raw === 'anchors') return 'anchors'
  if (raw !== '' && raw !== 'window' && !warnedUnrecognised.has(raw)) {
    if (warnedUnrecognised.size >= 16) warnedUnrecognised.clear()
    warnedUnrecognised.add(raw)
    warn(`[mac-voices] mac_live_voices_unrecognised: COS_MAC_LIVE_VOICES=${raw.slice(0, 40)} is not a mode (window, anchors, off); using window`)
  }
  return 'window'
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
