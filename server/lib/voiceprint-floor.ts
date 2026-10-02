// The least audio the voiceprint names a voice from. One source for the
// whole-chunk check in transcribe-stream and the per-track check in Nemotron
// naming, so the two can never drift apart.
export const VOICEPRINT_MIN_AUDIO_SEC = 2.0
