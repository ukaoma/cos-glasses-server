// "Private" as a PRIVACY reference, not as an ordinary adjective.
//
// A blocklist of private nouns (notes, pricing, ...) lets every other private thing through ("private funding round from Blackstone",
// "my private hospital stay", "Acme's private valuation"), so this is inverted: the bare word "private" (and privately, privacy) blocks,
// EXCEPT inside a short list of public phrases: private aviation, jet(s), plane(s), pilot(s), equity, school(s), sector, label,
// market(s), company/companies, credit, and "privately held". Those are the subjects of public statistics and news.
// Even a public phrase blocks when the question also
//   - has a privacy phrase anywhere: stays private, keep ... private, in private, private for now, privately told (all caught because
//     they carry a bare "private"), or off the record, between us; or
//   - has a possessive or a person on it: my, our, his, her, their, your, <Name>'s ("Stephen's private plane crash rate",
//     "private equity ... our CEO owns").
// One helper, used by every gate that read the bare word (the Ask search gate, the public-topic and fact-check query filter, the
// public-resource request check). The live-cue deny list keeps the bare word (live-cues-general-topic.ts): its queries are chosen by a
// model, not typed by the user.
const PUBLIC_PHRASE = 'aviation|jets?|planes?|pilots?|equity|schools?|sector|label|markets?|compan(?:y|ies)|credit'
const PUBLIC_PHRASES = new RegExp(`\\bprivate\\s+(?:${PUBLIC_PHRASE})\\b|\\bprivately\\s+held\\b`, 'gi')
const MARKER = /\bprivate(?:ly)?\b|\bprivacy\b/i
// Phrases that make a question private WITHOUT the word "private" (every phrase with the word is already caught by the bare-word rule below).
const PRIVACY_PHRASES: readonly RegExp[] = [
  /\boff\s+the\s+record\b/i,
  /\bbetween\s+(?:us|you\s+and\s+me)\b/i,
]
const POSSESSIVE = /\b(?:my|our|his|her|their|your|mine|ours|hers|theirs)\b/i
// <Name>'s, except the contractions that are not possessives.
const NOT_POSSESSIVE = new Set(['what', 'it', 'that', 'there', 'here', 'who', 'how', 'let', 'he', 'she', 'where', 'when', 'why', 'one', 'this'])
function hasPossessive(text: string): boolean {
  if (POSSESSIVE.test(text)) return true
  for (const m of text.matchAll(/\b([\p{L}][\p{L}\p{N}&.-]*)['’]s\b/gu)) if (!NOT_POSSESSIVE.has(m[1].toLowerCase())) return true
  return false
}
/** True when `text` uses "private" as a privacy marker. "private aviation", "private equity", "private jet" alone are not. */
export function privateReference(text: string): boolean {
  if (!MARKER.test(text)) return false
  if (PRIVACY_PHRASES.some(p => p.test(text))) return true
  const rest = text.replace(PUBLIC_PHRASES, ' ')
  if (MARKER.test(rest)) return true                            // any other "private": notes, funding round, valuation, dinner, hospital ...
  return hasPossessive(text)                                    // only public phrases are left: still private if it is someone's
}
