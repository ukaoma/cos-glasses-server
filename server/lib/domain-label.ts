/** Human label for a domain key.
 *
 *  `hermit_crabs` should read "Hermit Crabs" in a picker, but the label must be
 *  DERIVED, never a lookup table: a table is how one user's four business units
 *  ended up compiled into everyone's build. A user-supplied domain that is
 *  already prose ("DNP study") is returned as-is apart from its separators. */
export function domainLabel(name: string): string {
  const words = name.split(/[_-]+/).filter(Boolean)
  if (words.length === 0) return name
  // Only lowercase words are title-cased. A name the user already capitalised
  // ("DNP study", "iOS") keeps their capitalisation.
  return words.map(w => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}
