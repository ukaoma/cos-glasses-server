// What may become a voice-profile name.
//
// WHY THIS EXISTS (Chelsie Hodgkiss, first-time user, 2026-08-25)
// Saying "enroll my voice" and continuing to talk produced a profile whose
// NAME was the entire ~40-second transcript. Two runs, two junk profiles, one
// embedding each. Because no junk name ever equals owner_speaker_label,
// /api/voice/status reported `enrolled: false` forever, and editing
// voice-profiles.json by hand did not help — the server rewrites it from
// memory.
//
// The client bug was a $-anchored command regex falling through to a
// named-enrollment branch whose capture group had no length bound. That is
// fixed in the app (cos-glasses-app src/Main.ts). This module is the SERVER
// side of the same guard: the app ships in an EHPK on its own release train,
// so an old client must not be able to write a sentence into the profile store.
//
// Counterpart: cos-glasses-app/src/lib/speaker-name.ts — keep the rules and the
// test vectors in both repos in step.

/** Longest plausible human name we will store. */
export const MAX_SPEAKER_NAME_CHARS = 40
/** Most words a name may have ("Maria del Carmen Ruiz" is four). */
export const MAX_SPEAKER_NAME_WORDS = 4

/** Words that mean "the wearer", never a third party's name. */
const SELF_REFERENTIAL = /^(?:my|me|mine|myself|voice|voiceprint|my\s+voice|my\s+voiceprint)$/i

/** A name never BEGINS with these. "My Voice Please" is short enough and
 *  clean enough to pass every other rule, so the leading word is the only
 *  thing that gives it away. */
const LEADS_WITH_SELF = /^(?:my|me|mine|myself|voice|voiceprint)\b/i

export type SpeakerNameRejection =
  | 'empty'
  | 'too_long'
  | 'too_many_words'
  | 'sentence_like'
  | 'invalid_characters'
  | 'self_referential'

export interface SpeakerNameCheck {
  ok: boolean
  reason?: SpeakerNameRejection
  /** Human-readable, safe to show on the lens. */
  message?: string
}

const MESSAGES: Record<SpeakerNameRejection, string> = {
  empty: 'A voice profile needs a name.',
  too_long: `That name is too long (limit ${MAX_SPEAKER_NAME_CHARS} characters). It looks like speech, not a name.`,
  too_many_words: `That name has too many words (limit ${MAX_SPEAKER_NAME_WORDS}). It looks like speech, not a name.`,
  sentence_like: 'That looks like a sentence, not a name.',
  invalid_characters: 'A name may only contain letters, spaces, hyphens and apostrophes.',
  self_referential: 'Use "enroll my voice" to enrol yourself.',
}

/**
 * Is this a plausible person's name for a voice profile?
 *
 * Deliberately strict. A false reject costs one clear error message; a false
 * accept writes an unusable profile into a store the user cannot repair by
 * hand.
 */
export function checkSpeakerName(
  raw: string | undefined | null,
  opts: { ownerLabel?: string } = {},
): SpeakerNameCheck {
  const name = (raw ?? '').trim()
  if (!name) return fail('empty')
  // The wearer's own label MUST pass. It defaults to 'Me' (profile.ts:104),
  // which is itself self-referential — without this the guard would reject the
  // very self-enrolment it exists to protect.
  const owner = opts.ownerLabel?.trim()
  const isOwner = !!owner && name.toLowerCase() === owner.toLowerCase()
  if (!isOwner && (SELF_REFERENTIAL.test(name) || LEADS_WITH_SELF.test(name))) {
    return fail('self_referential')
  }
  if (name.length > MAX_SPEAKER_NAME_CHARS) return fail('too_long')
  if (name.split(/\s+/).length > MAX_SPEAKER_NAME_WORDS) return fail('too_many_words')
  // Sentence punctuation is the clearest signal that speech was captured.
  if (/[.!?,;:]/.test(name)) return fail('sentence_like')
  // Unicode letters, marks, spaces, hyphens, apostrophes. No digits, no symbols.
  if (!/^[\p{L}\p{M}][\p{L}\p{M}\s'’-]*$/u.test(name)) return fail('invalid_characters')
  return { ok: true }
}

function fail(reason: SpeakerNameRejection): SpeakerNameCheck {
  return { ok: false, reason, message: MESSAGES[reason] }
}
