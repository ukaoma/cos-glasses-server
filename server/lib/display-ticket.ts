import { createHmac } from 'node:crypto'
import { timingSafeTokenEqual } from './token-auth.js'

/**
 * Short-lived capability for GET /api/display-stream.
 *
 * WHY A CAPABILITY AT ALL. `EventSource` cannot attach `X-Cos-Token` — the same
 * constraint native HTML audio has, which is why `api-auth.ts` already carries a
 * TTS playback capability. This reuses that reviewed shape rather than inventing
 * a second one: **a path segment, GET/HEAD only, and no query-token fallback that
 * could leak into URL logs.**
 *
 * WHY STATELESS. An HMAC over the expiry needs no store, so there is no eviction
 * policy to get wrong, no unbounded Map, and no timer to leak. It also invalidates
 * every outstanding ticket the moment the pairing token rotates, which a UUID store
 * would not. The TTS capability needs a store because its UUID carries no claims;
 * this one carries its own expiry.
 *
 * WHY REPLAY WITHIN THE TTL IS FINE. Minting requires the pairing token, so an
 * attacker who could mint already has full API access. The TTL bounds the value of
 * a ticket that leaks out of a URL, which is the actual threat. Single-use would be
 * strictly worse: the server sends `retry: 3000`, so a browser-initiated reconnect
 * replays the same URL, and a consumed ticket would turn every transport blip into a
 * hard failure.
 */

/**
 * 15 minutes, set by the PLATFORM, not by taste.
 *
 * The first draft used 120s, which is exactly the Even Hub reviewer's boundary: the
 * review rubric checks a two-minute idle, and the pre-submission loop locks the phone
 * for five. A backgrounded Even Hub WebView is SUSPENDED — no timer, no fetch, no
 * re-mint — so a 120s ticket is guaranteed to be dead on the exact path a reviewer
 * exercises, and the app would come back to a content-suppressed stream.
 *
 * The TTL is not what protects the stream. MINTING requires the pairing token, so
 * anyone who can mint already has full API access; the TTL only bounds the value of
 * a ticket that leaks out of a URL (proxy log, screen share, shoulder surf). 15
 * minutes keeps that window small while surviving every suspension a phone actually
 * imposes.
 */
export const DISPLAY_TICKET_TTL_SECONDS = 900

/** Domain separation. Without a purpose string, any future feature that HMACs an
 *  integer under the same key would mint cross-usable display tickets. */
const TICKET_PURPOSE = 'display-stream'

function signature(apiToken: string, expSeconds: number): string {
  return createHmac('sha256', apiToken)
    .update(`${TICKET_PURPOSE}:${expSeconds}`)
    .digest('hex')
}

/**
 * `<expUnixSeconds>.<hex sha256 hmac>` — safe in a path segment, no encoding needed.
 *
 * THROWS on an empty token rather than returning a ticket. An HMAC keyed on '' is a
 * well-formed string that `verifyDisplayTicket` rejects unconditionally (it fails
 * closed on `!apiToken`), so a silent mint would publish a capability that can never
 * be redeemed — the caller would advertise `ticketSupported` and hand out a value
 * that is dead on arrival. Callers must decide what to do without a token; they may
 * not be handed a placeholder.
 */
export function mintDisplayTicket(
  apiToken: string,
  nowMs: number = Date.now(),
): string {
  if (!apiToken) {
    throw new Error('mintDisplayTicket requires a non-empty API token — a ticket minted without one can never verify')
  }
  const exp = Math.floor(nowMs / 1000) + DISPLAY_TICKET_TTL_SECONDS
  return `${exp}.${signature(apiToken, exp)}`
}

/**
 * True only for a well-formed, unexpired, correctly-signed ticket.
 *
 * Fails CLOSED on every malformed input. The expiry is parsed from the ticket
 * itself, so a forged expiry changes the signed message and fails the HMAC — the
 * claim cannot be edited without the key.
 */
export function verifyDisplayTicket(
  apiToken: string,
  ticket: unknown,
  nowMs: number = Date.now(),
): boolean {
  if (typeof ticket !== 'string' || !apiToken) return false
  const separator = ticket.indexOf('.')
  if (separator <= 0) return false
  const expRaw = ticket.slice(0, separator)
  const provided = ticket.slice(separator + 1)
  if (!/^\d{1,15}$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(provided)) return false
  const exp = Number(expRaw)
  if (!Number.isSafeInteger(exp)) return false
  // Expiry is checked BEFORE the compare so a stale ticket cannot be probed for
  // signature validity, and so the common rejection costs no hashing.
  if (Math.floor(nowMs / 1000) >= exp) return false
  return timingSafeTokenEqual(provided, signature(apiToken, exp))
}
