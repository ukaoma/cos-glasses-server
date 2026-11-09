// Server acceptance of a signed Control Web turn (6.99.31, plan §4.5). Behind
// COS_WEB_KEY_AUTHORITY (default off). Off, nothing here is consulted and a web turn is exactly
// what 6.99.29 made it: recorded, never vouched (`web_cookie_derivable_from_token`).
//
// A web turn is vouched (`authority: 'web-key'`) only when EVERY check below holds. Any failure
// delivers the turn unvouched with the specific reason, never refuses it outright: the words were
// typed by someone holding a valid cookie, and the receiving agent still sees them as a request.
//
//   - the request already passed the full web cookie path with no token and a non-local socket
//     (G2TurnProvenance.originOf decides that; only then is an envelope even read)
//   - the envelope is exactly `cos-web-turn/1`, canonical JCS bytes, closed scope
//   - an anchor is registered; `aud` is this install; `origin` is the expected https origin and is
//     the Origin the browser stamped on this very request
//   - the key is enrolled with a valid anchorSig, is not revoked; `kver` and `epoch` are current
//   - the P-256 signature verifies over those bytes
//   - `iat`/`exp` within bounds (exp - iat <= 15 min, iat at most 60 s ahead, now <= exp)
//   - not a fork, and provider/session (and binding, when signed) equal the route's real target
//   - the turn id, the exact words (CRLF to LF only) and the ordered attachment manifest match
//   - an `approve` scope matches an open packet byte for byte, the packet was created by the very
//     session the envelope names (review B4), and the action is enabled (install or publish)
//   - the anchor has a valid bootstrap record and is past its 24 h maturity (review B1)
//   - served-asset integrity is enabled AND its last check passed (review W1)
//   - a user-verified WebAuthn assertion by the anchored passkey over sha256(envelope JCS) (B2)
//   - the single-use server nonce is unspent (spent last, so a failing envelope never burns it)

import { createHash } from 'node:crypto'
import { readSwitch } from './env-switch.js'
import { b64url, canonicalBytes, fromB64url, parseEnvelopeHeader, sha256Hex, verifyP1363 } from './web-key-envelope.js'
import type { WebKeyNonces, WebKeyPackets, WebKeyRegistry } from './web-key-registry.js'
import { webKeyRpId } from './web-key-origin.js'
import { parsePasskeyHeader, turnPasskeyChallenge, verifyPasskeyAssertion, WEB_PASSKEY_HEADER, type PasskeyAssertion } from './web-key-passkey.js'
import {
  signedWordsText, WEB_TURN_IAT_SKEW_S, WEB_TURN_MAX_LIFETIME_S, type WebTurnEnvelope, type WebTurnScope,
} from '../../shared/web-turn-envelope.js'

export const WEB_ENVELOPE_HEADER = 'x-cos-web-envelope'
export const WEB_SIGNATURE_HEADER = 'x-cos-web-sig'
/** Exact scoped install/publish only. Push-main remains refused (`approve_action_not_enabled`). */
export const WEB_KEY_ENABLED_APPROVE_ACTIONS: ReadonlySet<string> = new Set(['install', 'publish'])

/** The served-asset integrity state the authority reads (review W1). Null: integrity is not running. */
export interface IntegrityReport { enabled: boolean; lastCheckOk: boolean; checkedAt: number | null; manifestSha256: string | null }

/** The ordered attachment manifest's digest, the same function the queue seal uses (g2-turn-provenance attachmentsDigest). */
export function manifestDigest(manifest: ReadonlyArray<{ id: string; sha256: string }>): string {
  if (manifest.length === 0) return ''
  return createHash('sha256').update(JSON.stringify(manifest.map(e => [e.id, e.sha256])), 'utf8').digest('hex')
}

export function webKeyAuthorityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_WEB_KEY_AUTHORITY, false)
}

/** The raw headers of a web request that carries an envelope; judged only once the route knows its target. */
export interface WebKeyCandidate { envelope: string; signature: string | null; requestOrigin: string | null; passkey?: string | null }

/** What a vouched web-key turn carries: self-proving (the envelope bytes and the signature). */
export interface WebKeyProof {
  kid: string
  kver: number
  epoch: number
  iat: number
  exp: number
  authId: string
  /** base64url of the exact JCS bytes the phone signed. */
  envelope: string
  signature: string
  scope: WebTurnScope
  wordsSha256: string
  provider: string
  sessionId: string
  /** The user-verified WebAuthn assertion over sha256(envelope JCS) (review B2). */
  passkey: PasskeyAssertion
  /** Served-asset integrity when this turn was accepted (review W1). */
  integrity: IntegrityReport
}

/** What the route knows when it judges: the real destination, the exact words and the files. */
export interface WebKeyContext {
  provider: string
  /** The actual receiving session. Null: unknown (a new session), never vouched. */
  sessionId: string | null
  bindingId?: string | null
  turnId: string
  /** The words exactly as received, BEFORE any files block. */
  words: string
  /** The ordered manifest (id + content hash). Null: the files could not be read (unvouched). */
  attachments: ReadonlyArray<{ id: string; sha256: string }> | null
  fork?: boolean
}

export type WebKeyVerdict = { ok: true; proof: WebKeyProof } | { ok: false; reason: string }

export function wordsDigest(words: string): { sha256: string; len: number } {
  const text = Buffer.from(signedWordsText(words), 'utf8')
  return { sha256: createHash('sha256').update(text).digest('hex'), len: text.length }
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const raw = headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.length > 0 ? v.trim() : null
}

/** The envelope headers of a request, or null when it carries none. */
export function webKeyCandidateOf(headers: Record<string, string | string[] | undefined>): WebKeyCandidate | null {
  const envelope = headerValue(headers, WEB_ENVELOPE_HEADER)
  if (envelope === null) return null
  return { envelope, signature: headerValue(headers, WEB_SIGNATURE_HEADER), requestOrigin: headerValue(headers, 'origin'), passkey: headerValue(headers, WEB_PASSKEY_HEADER) }
}

export interface WebKeyAuthorityDeps {
  registry: WebKeyRegistry
  nonces: WebKeyNonces
  packets: WebKeyPackets
  /** This Mac's MagicDNS name (aud is bound to it). Null: aud is unknown and nothing is vouched. */
  selfDnsName: () => string | null
  /** The one origin a phone signs from: webKeySignerOrigin() (`https://<selfDnsName>:3144`). Null: none. */
  expectedOrigin: () => string | null
  /** Served-asset integrity (review W1). Absent or null: integrity is off, so nothing is vouched. */
  integrity?: () => IntegrityReport | null
  enabled?: () => boolean
  now?: () => number
}

export class WebKeyAuthority {
  private readonly now: () => number

  constructor(readonly deps: WebKeyAuthorityDeps) {
    this.now = deps.now ?? Date.now
  }

  enabled(): boolean {
    try { return (this.deps.enabled ?? webKeyAuthorityEnabled)() } catch { return false }
  }

  get registry(): WebKeyRegistry { return this.deps.registry }
  get nonces(): WebKeyNonces { return this.deps.nonces }
  get packets(): WebKeyPackets { return this.deps.packets }

  /** The integrity state now, or a refusal reason: off or failing means no vouch (review W1). */
  integrityNow(): { ok: true; report: IntegrityReport } | { ok: false; reason: 'integrity_off' | 'integrity_failed'; report: IntegrityReport | null } {
    let report: IntegrityReport | null = null
    try { report = this.deps.integrity ? this.deps.integrity() : null } catch { report = null }
    if (!report || report.enabled !== true) return { ok: false, reason: 'integrity_off', report }
    if (report.lastCheckOk !== true) return { ok: false, reason: 'integrity_failed', report }
    return { ok: true, report: { enabled: true, lastCheckOk: true, checkedAt: report.checkedAt ?? null, manifestSha256: report.manifestSha256 ?? null } }
  }

  /** Judge one candidate against the route's real target. Never throws (a throw reads as a refusal). */
  accept(candidate: WebKeyCandidate, ctx: WebKeyContext): WebKeyVerdict {
    try { return this.acceptInner(candidate, ctx) } catch (error) {
      console.error(`[web-key] accept failed: ${error instanceof Error ? error.message : error}`)
      return { ok: false, reason: 'web_key_check_failed' }
    }
  }

  private acceptInner(candidate: WebKeyCandidate, ctx: WebKeyContext): WebKeyVerdict {
    if (!this.enabled()) return { ok: false, reason: 'web_key_authority_off' }
    if (!candidate.signature) return { ok: false, reason: 'signature_missing' }
    const parsed = parseEnvelopeHeader(candidate.envelope)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    const env: WebTurnEnvelope = parsed.envelope
    const registry = this.deps.registry
    const anchorRefusal = registry.anchorRefusal()
    if (anchorRefusal) return { ok: false, reason: anchorRefusal }
    if (!registry.anchorMature()) return { ok: false, reason: 'anchor_too_new' }
    const integrity = this.integrityNow()
    if (!integrity.ok) return { ok: false, reason: integrity.reason }
    const selfDns = this.deps.selfDnsName()
    const aud = registry.aud(selfDns)
    if (!aud) return { ok: false, reason: 'aud_unavailable' }
    if (env.aud !== aud) return { ok: false, reason: 'aud_mismatch' }
    const origin = this.deps.expectedOrigin()
    if (!origin) return { ok: false, reason: 'origin_unavailable' }
    if (env.origin !== origin || candidate.requestOrigin !== origin) return { ok: false, reason: 'origin_mismatch' }
    const state = registry.entryState(env.kid, selfDns)
    if (!state.ok) return { ok: false, reason: state.reason }
    if (env.kver !== state.entry.kver) return { ok: false, reason: 'key_version_stale' }
    if (env.epoch !== registry.epoch()) return { ok: false, reason: 'epoch_stale' }
    if (!verifyP1363(state.key, parsed.bytes, candidate.signature)) return { ok: false, reason: 'signature_invalid' }
    // Review B2: the phone key alone vouches nothing. A user-verified passkey assertion by the
    // anchored passkey, over sha256(these exact envelope bytes), from this exact origin.
    if (!candidate.passkey) return { ok: false, reason: 'passkey_missing' }
    const assertion = parsePasskeyHeader(candidate.passkey)
    if (!assertion) return { ok: false, reason: 'passkey_malformed' }
    const rpId = webKeyRpId(selfDns)
    if (!rpId) return { ok: false, reason: 'aud_unavailable' }
    const pk = verifyPasskeyAssertion(assertion, {
      challenge: turnPasskeyChallenge(parsed.bytes), origin, rpId,
      credentialId: state.entry.approval.passkey_credential_id, publicKey: state.passkeyKey,
    })
    if (!pk.ok) return { ok: false, reason: pk.reason }
    const nowS = Math.floor(this.now() / 1000)
    if (env.exp <= env.iat || env.exp - env.iat > WEB_TURN_MAX_LIFETIME_S) return { ok: false, reason: 'lifetime_invalid' }
    if (env.iat > nowS + WEB_TURN_IAT_SKEW_S) return { ok: false, reason: 'iat_in_future' }
    if (nowS > env.exp) return { ok: false, reason: 'signature_expired' }
    // Forks and unknown destinations are delivered unvouched (the receiving child has no id yet).
    if (env.fork || ctx.fork === true) return { ok: false, reason: 'fork_destination_unbound' }
    if (ctx.sessionId === null) return { ok: false, reason: 'destination_unbound' }
    if (env.provider !== ctx.provider || env.sessionId !== ctx.sessionId) return { ok: false, reason: 'destination_mismatch' }
    if (env.bindingId !== null && env.bindingId !== (ctx.bindingId ?? null)) return { ok: false, reason: 'destination_mismatch' }
    if (env.turnId !== ctx.turnId) return { ok: false, reason: 'turn_id_mismatch' }
    const words = wordsDigest(ctx.words)
    if (env.wordsSha256 !== words.sha256 || env.wordsLen !== words.len) return { ok: false, reason: 'words_changed' }
    // The footer step trims trailing whitespace before it appends (footed()), so words ending in
    // whitespace could never verify downstream. Refuse them here: the signer trims before hashing.
    if (/[\t\n\v\f\r ]$/.test(signedWordsText(ctx.words))) return { ok: false, reason: 'words_trailing_whitespace' }
    if (ctx.attachments === null) return { ok: false, reason: 'attachments_unsealable' }
    if (env.attachments.length !== ctx.attachments.length
      || env.attachments.some((a, i) => a.id !== ctx.attachments![i].id || a.sha256 !== ctx.attachments![i].sha256)) {
      return { ok: false, reason: 'attachments_changed' }
    }
    let packetSha: string | null = null
    if (env.scope.kind === 'approve') {
      const scope = env.scope
      const packet = this.deps.packets.get(scope.packetSha256)
      if (!packet) return { ok: false, reason: 'packet_unknown' }
      const bytes = canonicalBytes(packet)
      if (!bytes || sha256Hex(bytes) !== scope.packetSha256) return { ok: false, reason: 'packet_mismatch' }
      if (packet.action !== scope.action || packet.artifact !== scope.artifact || packet.version !== scope.version
        || packet.digest !== scope.digest || packet.channel !== scope.channel) {
        return { ok: false, reason: 'packet_mismatch' }
      }
      // Review B4: only the session that created the packet (request context, never body) may be
      // the one this approval is delivered to.
      if (packet.provider !== env.provider || packet.sessionId !== env.sessionId) return { ok: false, reason: 'packet_session_mismatch' }
      if (!WEB_KEY_ENABLED_APPROVE_ACTIONS.has(scope.action)) return { ok: false, reason: 'approve_action_not_enabled' }
      packetSha = scope.packetSha256
    }
    // authId = sha256(signature bytes) (plan §4.4): the one consume key for this authorization.
    const authId = sha256Hex(fromB64url(candidate.signature) as Buffer)
    // LAST: a failing envelope never burns its nonce, and a replay of a good one finds it spent.
    const spent = this.deps.nonces.consume(env.nonce, authId)
    if (spent !== 'ok') return { ok: false, reason: spent }
    if (packetSha !== null) this.deps.packets.close(packetSha)
    registry.noteUsed(env.kid)
    return {
      ok: true,
      proof: {
        kid: env.kid, kver: env.kver, epoch: env.epoch, iat: env.iat, exp: env.exp, authId,
        envelope: b64url(parsed.bytes), signature: candidate.signature, scope: env.scope, wordsSha256: env.wordsSha256,
        provider: env.provider, sessionId: env.sessionId, passkey: assertion, integrity: integrity.report,
      },
    }
  }

  /**
   * At a queue drain or a Cursor Stop hand-off (plan §4.5): the parked approval still holds only
   * while the flag is on, the signature has not expired (never re-dated), the key is not revoked,
   * the epoch has not moved, integrity still passes, the words are still the signed words, and the
   * parked files (the seal's manifest digest) are still the signed manifest. Null when it holds.
   */
  recheck(proof: WebKeyProof, words: string, attachmentsDigest: string): string | null {
    try {
      if (!this.enabled()) return 'web_key_authority_off'
      if (Math.floor(this.now() / 1000) > proof.exp) return 'signature_expired'
      const state = this.deps.registry.entryState(proof.kid, this.deps.selfDnsName())
      if (!state.ok) return state.reason
      if (proof.epoch !== this.deps.registry.epoch()) return 'epoch_stale'
      const integrity = this.integrityNow()
      if (!integrity.ok) return integrity.reason
      if (wordsDigest(words).sha256 !== proof.wordsSha256) return 'words_changed'
      const parsed = parseEnvelopeHeader(proof.envelope)
      if (!parsed.ok) return parsed.reason
      if (parsed.envelope.scope.kind === 'approve' && !WEB_KEY_ENABLED_APPROVE_ACTIONS.has(parsed.envelope.scope.action)) return 'approve_action_not_enabled'
      // Review note "drain checks words, not files": the signed manifest must equal the parked one.
      if (manifestDigest(parsed.envelope.attachments) !== attachmentsDigest) return 'attachments_changed'
      return null
    } catch {
      return 'web_key_check_failed'
    }
  }

  /**
   * For GET /api/g2-turns/:id: re-verify a stored proof (it is self-proving, so a record read back
   * from disk can still vouch), and say whether the key is revoked now. Null reason: it verifies.
   * `record` is the ledger row's own fields: every one must equal the signed envelope (review B3),
   * so a ledger edit cannot pair a genuine envelope with another session, turn or text.
   */
  review(proof: WebKeyProof, record: { turnId: string; target: { provider: string; sessionId: string } }): { reason: string | null; entry: Record<string, unknown> | null; facts: Record<string, unknown> | null } {
    try {
      if (!this.enabled()) return { reason: 'web_key_authority_off', entry: null, facts: null }
      const parsed = parseEnvelopeHeader(proof.envelope)
      if (!parsed.ok) return { reason: parsed.reason, entry: null, facts: null }
      const env = parsed.envelope
      const registry = this.deps.registry
      const stored = registry.entry(env.kid)
      const entry = stored ? {
        kid: stored.kid, spki: stored.spki, passkeySpki: stored.passkeySpki, kver: stored.kver, label: stored.label,
        approval: stored.approval, anchorSig: stored.anchorSig, ...(typeof stored.revokedAt === 'number' ? { revokedAt: stored.revokedAt } : {}),
      } : null
      const anchor = registry.anchor()
      const integrity = this.integrityNow()
      const at = this.now()
      const facts: Record<string, unknown> = {
        aud: env.aud,
        wordsSha256: env.wordsSha256,
        anchor: anchor ? { spkiSha256: anchor.spkiSha256, fingerprint: anchor.fingerprint, setAt: anchor.setAt, ageMs: Math.max(0, at - anchor.setAt), mature: registry.anchorMature() } : null,
        epoch: registry.epoch(),
        revoked: registry.revocations(),
        revocationDigest: registry.revocationDigest(),
        integrity: integrity.report ?? { enabled: false, lastCheckOk: false, checkedAt: null, manifestSha256: null },
        integrityAtAccept: proof.integrity ?? null,
        consumeKeys: [`turn:${env.turnId}`, `web:${env.aud}:${proof.authId}`],
      }
      const sigBytes = fromB64url(proof.signature)
      const same = (a: unknown, b: unknown): boolean => canonicalBytes(a)?.equals(canonicalBytes(b) ?? Buffer.alloc(0)) === true
      if (record.turnId !== env.turnId || record.target?.provider !== env.provider || record.target?.sessionId !== env.sessionId
        || proof.kid !== env.kid || proof.kver !== env.kver || proof.epoch !== env.epoch || proof.iat !== env.iat || proof.exp !== env.exp
        || proof.provider !== env.provider || proof.sessionId !== env.sessionId || proof.wordsSha256 !== env.wordsSha256
        || !same(proof.scope, env.scope) || !sigBytes || proof.authId !== sha256Hex(sigBytes)) {
        return { reason: 'record_envelope_mismatch', entry, facts }
      }
      const nowS = Math.floor(at / 1000)
      if (env.exp <= env.iat || env.exp - env.iat > WEB_TURN_MAX_LIFETIME_S) return { reason: 'lifetime_invalid', entry, facts }
      if (env.iat > nowS + WEB_TURN_IAT_SKEW_S) return { reason: 'iat_in_future', entry, facts }
      if (nowS > env.exp) return { reason: 'signature_expired', entry, facts }
      if (env.fork) return { reason: 'fork_destination_unbound', entry, facts }
      if (env.scope.kind === 'approve' && !WEB_KEY_ENABLED_APPROVE_ACTIONS.has(env.scope.action)) return { reason: 'approve_action_not_enabled', entry, facts }
      const refusal = registry.anchorRefusal()
      if (refusal) return { reason: refusal, entry, facts }
      if (!registry.anchorMature()) return { reason: 'anchor_too_new', entry, facts }
      if (env.aud !== registry.aud(this.deps.selfDnsName())) return { reason: 'aud_mismatch', entry, facts }
      if (env.origin !== this.deps.expectedOrigin()) return { reason: 'origin_mismatch', entry, facts }
      const state = registry.entryState(env.kid, this.deps.selfDnsName())
      if (!state.ok) return { reason: state.reason, entry, facts }
      if (!verifyP1363(state.key, parsed.bytes, proof.signature)) return { reason: 'signature_invalid', entry, facts }
      if (env.epoch !== registry.epoch()) return { reason: 'epoch_stale', entry, facts }
      const rpId = webKeyRpId(this.deps.selfDnsName())
      if (!proof.passkey || !rpId) return { reason: 'passkey_missing', entry, facts }
      const pk = verifyPasskeyAssertion(proof.passkey, {
        challenge: turnPasskeyChallenge(parsed.bytes), origin: env.origin, rpId,
        credentialId: state.entry.approval.passkey_credential_id, publicKey: state.passkeyKey,
      })
      if (!pk.ok) return { reason: pk.reason, entry, facts }
      if (!proof.integrity || proof.integrity.enabled !== true || proof.integrity.lastCheckOk !== true) return { reason: 'integrity_off', entry, facts }
      if (!integrity.ok) return { reason: integrity.reason, entry, facts }
      return { reason: null, entry, facts }
    } catch {
      return { reason: 'web_key_check_failed', entry: null, facts: null }
    }
  }
}
