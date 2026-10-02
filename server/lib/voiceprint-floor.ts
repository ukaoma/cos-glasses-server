// Voiceprint floors shared by every path that names a voice, so they can never
// drift apart.

/** The least audio the voiceprint names a voice from: the whole-chunk check in
 *  transcribe-stream and the per-track check in Nemotron naming. */
export const VOICEPRINT_MIN_AUDIO_SEC = 2.0

/** The similarity at which the voiceprint verifies the WEARER (speaker-embeddings'
 *  owner verify). A full search accepts any profile from 0.55, so a voice can come
 *  back as the wearer between 0.55 and 0.65 without ever passing owner verify;
 *  6.61.1 refuses that for a split track (it named other people as the wearer). */
export const OWNER_VERIFY_SIMILARITY = 0.65
