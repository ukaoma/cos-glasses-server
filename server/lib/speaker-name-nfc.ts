/**
 * Speaker names are compared and stored in NFC.
 *
 * Foundation's `Process` turns an argument into decomposed Unicode (NFD): COS Control's helper sent `Pólya` and the server
 * received the bytes `50 6f cc 81 6c 79 61`, where NFC is `50 c3 b3 6c 79 61`. A sidecar written by the pipeline holds NFC, so a
 * confirm of "Brigitta Pólya" answered 409 `No chunk in this meeting is labelled` while 11 chunks carried that name.
 *
 * Two rules, applied everywhere a name arrives in a request or is matched against stored data:
 *   1. Normalize a name to NFC at the route boundary (`bodyName`, `nfc`), so nothing decomposed is ever WRITTEN to a sidecar, a
 *      ledger or a voice profile.
 *   2. Compare with NFC on both sides (`sameSpeakerName`), so a name already stored decomposed (written before this existed)
 *      still matches its composed spelling. Stored data is not rewritten.
 */
export function nfc(name: string): string { return name.normalize('NFC') }

export function sameSpeakerName(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && (a === b || nfc(a) === nfc(b))
}

/** A request value as a name: a string in NFC, or '' for anything else. */
export function bodyName(value: unknown): string { return typeof value === 'string' ? nfc(value) : '' }

/** A regular expression source that matches `name` in either form, for text that may hold either. */
export function nameForms(name: string, escape: (s: string) => string): string {
  const composed = nfc(name), decomposed = name.normalize('NFD')
  return composed === decomposed ? escape(composed) : `(?:${escape(composed)}|${escape(decomposed)})`
}

/** A record id carries a filename, and Control's helper hands it over decomposed: equal when they are the same text in NFC. */
export function sameRecordId(requested: unknown, expected: string): boolean {
  return typeof requested === 'string' && (requested === expected || nfc(requested) === nfc(expected))
}
