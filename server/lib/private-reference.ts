// "Private" as a PRIVACY reference, not as an ordinary adjective.
//
// The word used to block every public lookup it appeared in, so "private aviation", "private jet", "private equity", "private school",
// "private label" and "privately held" (all public subjects) were withheld as personal. It blocks only when it points at the user's own
// or a confidential thing: "my private notes", "the private conversation we had", "keep this private", "our private pricing", "private
// beta of our app", "in private", "privately told". One helper, used by every gate that read the bare word (the Ask search gate, the
// public-topic and fact-check query filter, the live-cue deny list, the public-resource request check).
const PRIVATE_THING = [
  'info', 'information', 'data', 'details?', 'matters?', 'conversations?', 'discussions?', 'chats?', 'talks?', 'threads?', 'notes?', 'messages?', 'dms?', 'emails?', 'calls?',
  'numbers?', 'address(?:es)?', 'life', 'lives', 'accounts?', 'keys?', 'repos?', 'repositor(?:y|ies)', 'channels?', 'docs?', 'documents?', 'files?', 'meetings?',
  'deals?', 'pricing', 'contracts?', 'budgets?', 'quotes?', 'beta',
].join('|')
const PATTERNS: readonly RegExp[] = [
  // private + a thing that belongs to the user or the room
  new RegExp(`\\bprivate\\s+(?:${PRIVATE_THING})\\b`, 'i'),
  // "in private" as an ending or before a conjunction, never "in private aviation"
  /\bin\s+private\b(?=\s*(?:$|[.,;:!?)]|\b(?:and|but|so|because|with|when|then|though)\b))/i,
  // "keep it private", "keep this strictly private", "keep private"
  /\bkeep\s+(?:(?:it|this|that|them|these|those)\s+)?(?:strictly\s+|totally\s+|completely\s+)?private\b/i,
  // "this is private", "that's private", "it was private" at the end of a clause
  /\b(?:is|are|was|were|'s|’s)\s+(?:strictly\s+|totally\s+|completely\s+)?private\s*(?:$|[.,;:!?)])/i,
  // "privately told / said / shared ..."
  /\bprivately\s+(?:told|said|shared|messaged|sent|confided|discussed|admitted|asked|texted)\b/i,
]
/** True when `text` uses "private" as a privacy marker. "private aviation", "private equity", "private jet" are not. */
export function privateReference(text: string): boolean {
  return PATTERNS.some(p => p.test(text))
}
