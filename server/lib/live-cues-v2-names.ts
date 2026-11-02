// 6.97.8: the spellings the cue writer may use for a name. The transcript misspells names ("Bori" for Vori, "Niall" for
// Niala), and the server already knows the right ones: the speakers the ASR path reported for THIS meeting, the owner, and the
// terms the owner taught the decoder that are written like names. Enrolled voice profiles are deliberately left out: that store holds
// everyone the glasses ever heard, household included, and none of it belongs in a work meeting's prompt. No new data source and
// no network: the same readers the general-cue name gate uses (live-cues-general-topic.ts ProfileNameSource), handed to the same
// local writer that already sees the transcript. Pure but for those readers; a reader that fails just contributes nothing.

import { isGenericSpeakerLabel, realProfileNames, type ProfileNameSource } from './live-cues-general-topic.js'

/** Most names a prompt carries. A meeting names a handful of people and products; the rest is the owner's whole vocabulary. */
export const KNOWN_NAMES_MAX = 60
/** Most characters of names a prompt carries. */
export const KNOWN_NAMES_CHARS = 700
const NAME_MAX_CHARS = 32
const NAME_MAX_WORDS = 3

/** What the writer is told about the list. It rides in the prompt data, so no writer rule text changes. */
export const KNOWN_NAMES_USE = 'Spell a person, company or product exactly as listed when a word in the window sounds like it and the context fits. Speech to text misspells names. Never add a name the window does not hint at.'

/** A vocabulary term worth listing: short, and written like a name or a product (a capital letter somewhere). Plain work words
 *  the owner taught the decoder ("retail", "pos") are not names, and a long phrase is not a spelling. */
function looksLikeName(term: string): boolean {
  return term.length >= 3 && term.length <= NAME_MAX_CHARS && term.split(/\s+/).length <= NAME_MAX_WORDS && /\p{Lu}/u.test(term) && !/[\x00-\x1f\x7f]/.test(term)
}

/** Per name in the prompt: the quotes, the comma and the space the JSON adds around it. */
const NAME_OVERHEAD_CHARS = 4

/** The names for one meeting, most useful first: the meeting's speakers, the owner, then the vocabulary names. A name that does not
 *  fit is skipped, not the end of the list. */
export async function knownNamesFor(speakers: readonly string[], src: ProfileNameSource = realProfileNames): Promise<string[]> {
  const candidates: string[] = []
  for (const s of speakers) if (typeof s === 'string') candidates.push(s)
  try { candidates.push(src.ownerName()) } catch { /* no profile */ }
  try { candidates.push(...src.vocabulary().filter(looksLikeName)) } catch { /* no vocabulary */ }
  const seen = new Set<string>(), out: string[] = []
  let chars = 0
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const name = raw.replace(/\s+/g, ' ').trim()
    const key = name.toLowerCase()
    // The owner's placeholder name ("User") and the ASR's generic labels ("Speaker 2") are not names, wherever they came from.
    if (!name || name.length > NAME_MAX_CHARS || seen.has(key) || key === 'user' || isGenericSpeakerLabel(name)) continue
    if (out.length >= KNOWN_NAMES_MAX) break
    if (chars + name.length + NAME_OVERHEAD_CHARS > KNOWN_NAMES_CHARS) continue
    seen.add(key); out.push(name); chars += name.length + NAME_OVERHEAD_CHARS
  }
  return out
}
