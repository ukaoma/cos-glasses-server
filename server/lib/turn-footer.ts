// The one trailing verify line a vouched glasses or phone turn carries into an agent session (G2
// authority Tier 1, 6.99.29). PURE: no I/O, no imports, so the stream grammar
// (session-stream-events.ts), the transcript readers and the queue evidence can take the line off
// without importing the ledger. lib/g2-turn-provenance.ts re-exports all of it.
//
//   [COS-G2 turn <id> · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py <id> --session <your session id> --provider claude]
//
// The provider is filled in (claude, codex or cursor): the server footing the turn knows which
// harness it delivers into (Codex re-audit of 910eb90). The session stays a placeholder ON PURPOSE:
// the receiving agent states its OWN session id and the verifier compares it with the record, so a
// message that landed in the wrong session does not verify there. An unknown provider keeps the
// `<claude|codex|cursor>` placeholder rather than naming a wrong one.
//
// The COS-WEB tag is reserved for a future web origin backed by a device key the API token cannot
// produce. In 6.99.29 no turn is footed COS-WEB: a web turn is recorded, never vouched. The readers
// still take either tag off.
//
// The verifier (MU-Chief-Staff operations/scripts/verify_g2_turn.py) mirrors G2_TURN_FOOTER_RE.
//
// FOOTER-SHAPED LINES IN TYPED TEXT ARE REFUSED (QA 6.99.29). Only the server writes a footer, so
// words that carry anything that looks like one are refused at every route that hands words to a
// session (turns, queue park and edit, steer, fork, Send again, native Codex queue edit).

/** The footer tag per origin: the glasses and the phone keep COS-G2, a web turn says COS-WEB. */
export function turnFooterTag(client: string): 'COS-G2' | 'COS-WEB' {
  return client === 'web' ? 'COS-WEB' : 'COS-G2'
}

/** The harnesses the verifier accepts for --provider. */
export const FOOTER_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor'])

/** The footer's --provider value: the receiving harness when it is one the verifier knows, else the placeholder. */
export function footerProvider(provider: string | null | undefined): string {
  return typeof provider === 'string' && FOOTER_PROVIDERS.has(provider) ? provider : '<claude|codex|cursor>'
}

export function turnFooter(turnId: string, client: string = 'glasses', provider?: string | null): string {
  return `[${turnFooterTag(client)} turn ${turnId} · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ${turnId} --session <your session id> --provider ${footerProvider(provider)}]`
}

/**
 * Anything that looks like a footer, anywhere in the text: `[COS-G2 turn` or `[COS-WEB turn`, any
 * case, with spaces or any dash between the parts. Lenient on purpose: refusing a lookalike costs a
 * retyped line; accepting one could put a second footer in front of a reader.
 */
export const TURN_FOOTER_SHAPED_RE = /\[\s*COS[-\u2010-\u2015\u2212\s]*(?:G2|WEB)\s+turn\b/i

/** Whether typed words carry a footer-shaped line (refused: only the server writes a footer). */
export function hasFooterShapedLine(text: string): boolean {
  return typeof text === 'string' && TURN_FOOTER_SHAPED_RE.test(text)
}

/** The refusal copy for a footer-shaped line, shown where the words were typed. */
export const FOOTER_LINE_REFUSED_COPY = 'This message has a line that looks like a COS verify footer ("[COS-G2 turn" or "[COS-WEB turn"). Only COS writes those lines. Take that line out and send it again.'

/** The refusal copy for a turn id this server already used for a different turn. */
export const TURN_ID_IN_USE_COPY = 'That message id was already used for a different message. Send it again as a new message.'

/** The 6.66 name, kept: a glasses or phone footer. */
export function g2TurnFooter(turnId: string, provider?: string | null): string {
  return turnFooter(turnId, 'glasses', provider)
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
