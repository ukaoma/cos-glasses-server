import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DISPLAY_TICKET_TTL_SECONDS,
  explainDisplayTicket,
  mintDisplayTicket,
  verifyDisplayTicket,
} from './display-ticket.js'

const TOKEN = 'test-pairing-token-0123456789'
const NOW = 1_780_000_000_000

describe('display stream capability ticket', () => {
  it('mints a path-safe ticket that verifies under the same token', () => {
    const ticket = mintDisplayTicket(TOKEN, NOW)
    expect(ticket).toMatch(/^\d{1,15}\.[0-9a-f]{64}$/)
    // Path-safe: no percent-encoding needed, which is what lets it be a segment
    // rather than a query param (see api-auth.ts's no-query-token rule).
    expect(encodeURIComponent(ticket)).toBe(ticket)
    expect(verifyDisplayTicket(TOKEN, ticket, NOW)).toBe(true)
  })

  it('expires, and is already invalid the instant it turns stale', () => {
    const ticket = mintDisplayTicket(TOKEN, NOW)
    const expiresAt = NOW + DISPLAY_TICKET_TTL_SECONDS * 1000
    expect(verifyDisplayTicket(TOKEN, ticket, expiresAt - 1000)).toBe(true)
    expect(verifyDisplayTicket(TOKEN, ticket, expiresAt)).toBe(false)
    expect(verifyDisplayTicket(TOKEN, ticket, expiresAt + 60_000)).toBe(false)
  })

  it('rejects a forged expiry — the claim cannot be edited without the key', () => {
    const ticket = mintDisplayTicket(TOKEN, NOW)
    const [, sig] = ticket.split('.')
    const farFuture = Math.floor(NOW / 1000) + 86_400
    expect(verifyDisplayTicket(TOKEN, `${farFuture}.${sig}`, NOW)).toBe(false)
  })

  it('rejects a tampered signature', () => {
    const ticket = mintDisplayTicket(TOKEN, NOW)
    const [exp, sig] = ticket.split('.')
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    expect(verifyDisplayTicket(TOKEN, `${exp}.${flipped}`, NOW)).toBe(false)
  })

  it('is invalidated by pairing-token rotation — the reason it needs no store', () => {
    const ticket = mintDisplayTicket(TOKEN, NOW)
    expect(verifyDisplayTicket('a-different-token', ticket, NOW)).toBe(false)
  })

  it('is domain-separated, so a bare-integer HMAC elsewhere cannot be reused here', () => {
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const exp = Math.floor(NOW / 1000) + DISPLAY_TICKET_TTL_SECONDS
    const withoutPurpose = createHmac('sha256', TOKEN).update(String(exp)).digest('hex')
    expect(verifyDisplayTicket(TOKEN, `${exp}.${withoutPurpose}`, NOW)).toBe(false)
  })

  it('fails closed on every malformed shape', () => {
    const exp = Math.floor(NOW / 1000) + 60
    for (const bad of [
      '', '.', 'x', `${exp}`, `${exp}.`, `.${'a'.repeat(64)}`,
      `${exp}.${'a'.repeat(63)}`,          // too short
      `${exp}.${'a'.repeat(65)}`,          // too long
      `${exp}.${'A'.repeat(64)}`,          // uppercase hex is not our format
      `-${exp}.${'a'.repeat(64)}`,         // negative expiry
      `${exp}.${'z'.repeat(64)}`,          // non-hex
      null, undefined, 42, {}, [],
    ] as unknown[]) {
      expect(verifyDisplayTicket(TOKEN, bad, NOW)).toBe(false)
    }
  })

  /**
   * The subject here is the `!apiToken` guard in verifyDisplayTicket, and the only
   * way to reach it is with a ticket whose signature WOULD otherwise match — i.e.
   * one keyed on the same empty string.
   *
   * The previous version of this test minted under the REAL token and verified under
   * '', so the signature mismatch rejected it and the guard was never executed:
   * deleting `!apiToken` left the test green. Mutation-verified 2026-08-31.
   *
   * mintDisplayTicket now refuses an empty key, so the empty-key ticket is built
   * here. The first assertion proves the construction is the real signer's, not an
   * invented one — if the recipe drifted, it fails before the guard is tested.
   */
  it('fails closed on an empty server token — same empty key on BOTH sides', () => {
    const exp = Math.floor(NOW / 1000) + DISPLAY_TICKET_TTL_SECONDS
    const sign = (key: string) => createHmac('sha256', key).update(`display-stream:${exp}`).digest('hex')

    expect(verifyDisplayTicket(TOKEN, `${exp}.${sign(TOKEN)}`, NOW)).toBe(true)
    expect(verifyDisplayTicket('', `${exp}.${sign('')}`, NOW)).toBe(false)
  })

  // A ticket keyed on '' can never verify, so returning one would advertise a dead
  // capability. Refusing at the mint forces every caller to decide what to publish
  // when the server has no token, instead of publishing a placeholder.
  it('refuses to mint without an API token rather than returning a dead ticket', () => {
    expect(() => mintDisplayTicket('', NOW)).toThrow(/non-empty API token/)
  })

  it('mints a TTL long enough to survive a backgrounded Even Hub WebView', () => {
    // The Even Hub review loop locks the phone for five minutes and the WebView is
    // suspended while backgrounded, so it cannot re-mint. A TTL at or under that
    // window guarantees a dead ticket on the reviewer's exact path.
    expect(DISPLAY_TICKET_TTL_SECONDS).toBeGreaterThanOrEqual(600)
    const ticket = mintDisplayTicket(TOKEN, NOW)
    expect(verifyDisplayTicket(TOKEN, ticket, NOW + 5 * 60_000)).toBe(true)
  })
})

describe('explainDisplayTicket names the refusal', () => {
  it('returns each verdict for its cause, and verify agrees on ok', () => {
    const good = mintDisplayTicket(TOKEN, NOW)
    expect(explainDisplayTicket(TOKEN, good, NOW)).toBe('ok')
    expect(verifyDisplayTicket(TOKEN, good, NOW)).toBe(true)
    expect(explainDisplayTicket(TOKEN, good, NOW + (DISPLAY_TICKET_TTL_SECONDS + 1) * 1000)).toBe('expired')
    expect(explainDisplayTicket('other-token', good, NOW)).toBe('bad-signature')
    expect(explainDisplayTicket(TOKEN, 'not-a-ticket', NOW)).toBe('malformed')
    expect(explainDisplayTicket(TOKEN, good.toUpperCase(), NOW)).toBe('malformed')
    expect(explainDisplayTicket('', good, NOW)).toBe('malformed')
    // Expiry outranks signature: a stale ticket is 'expired' even when forged, so
    // the compare is never reached for the common case.
    const staleForged = mintDisplayTicket('other-token', NOW - (DISPLAY_TICKET_TTL_SECONDS + 5) * 1000)
    expect(explainDisplayTicket(TOKEN, staleForged, NOW)).toBe('expired')
  })
})
