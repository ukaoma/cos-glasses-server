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
