// The one trailing verify line a glasses, phone or web turn carries into an agent session (G2
// authority Tier 1, 6.99.29). PURE: no I/O, no imports, so the stream grammar
// (session-stream-events.ts), the transcript readers and the queue evidence can take the line off
// without importing the ledger. lib/g2-turn-provenance.ts re-exports all of it.
//
//   [COS-G2 turn <id> · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py <id>]
//   [COS-WEB turn <id> · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py <id>]
//
// The verifier (MU-Chief-Staff operations/scripts/verify_g2_turn.py) mirrors G2_TURN_FOOTER_RE.

/** The footer tag per origin: the glasses and the phone keep COS-G2, a web turn says COS-WEB. */
export function turnFooterTag(client: string): 'COS-G2' | 'COS-WEB' {
  return client === 'web' ? 'COS-WEB' : 'COS-G2'
}

export function turnFooter(turnId: string, client: string = 'glasses'): string {
  return `[${turnFooterTag(client)} turn ${turnId} · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ${turnId}]`
}

/** The 6.66 name, kept: a glasses or phone footer. */
export function g2TurnFooter(turnId: string): string {
  return turnFooter(turnId, 'glasses')
}

/** The footer line as it ends a delivered prompt (either tag). Used by tests and mirrored by the verifier. */
export const G2_TURN_FOOTER_RE = /\n\[COS-(G2|WEB) turn ([A-Za-z0-9][A-Za-z0-9_-]{7,127}) · verify: [^\n\]]*\][\t\n\v\f\r ]*$/

/** The prompt with its footer stripped, and the turn id the footer named (null: no footer). */
export function stripG2TurnFooter(text: string): { text: string; turnId: string | null; tag: 'COS-G2' | 'COS-WEB' | null } {
  const m = G2_TURN_FOOTER_RE.exec(text)
  if (!m) return { text, turnId: null, tag: null }
  return { text: text.slice(0, m.index), turnId: m[2], tag: m[1] === 'WEB' ? 'COS-WEB' : 'COS-G2' }
}

/**
 * The words a transcript row shows with a trailing verify footer taken off, for the code that
 * matches a transcript against the words it sent (queue-turn-evidence.ts). Only a footer at the
 * very end, of either tag, is removed.
 */
export function withoutTurnFooter(text: string): string {
  return stripG2TurnFooter(text).text
}
