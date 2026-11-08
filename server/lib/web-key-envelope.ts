// Crypto for the enrolled phone key (6.99.31, plan §4.2-4.4). node:crypto only.
//
// Keys are ECDSA P-256 public keys as SubjectPublicKeyInfo DER, carried base64url. Signatures
// are IEEE P1363 (r||s, 64 bytes): what WebCrypto emits on the phone and what CryptoKit's
// `rawRepresentation` gives for the Secure Enclave anchor on the Mac. Every message signed in
// this protocol is the JCS (RFC 8785) encoding of one closed-shape object (shared/web-turn-envelope.ts).

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { canonicalJson, parseWebTurnEnvelope, type WebTurnEnvelope } from '../../shared/web-turn-envelope.js'

const B64URL_RE = /^[A-Za-z0-9_-]*$/

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url')
}

/** Strict base64url (no padding, no other alphabet). Null on anything else. */
export function fromB64url(s: unknown): Buffer | null {
  if (typeof s !== 'string' || !B64URL_RE.test(s) || s.length % 4 === 1) return null
  return Buffer.from(s, 'base64url')
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** A P-256 public key from base64url SPKI DER, or null (wrong curve, not EC, garbage). */
export function parseP256Spki(spkiB64url: unknown): { key: KeyObject; der: Buffer } | null {
  const der = fromB64url(spkiB64url)
  if (!der || der.length < 60 || der.length > 200) return null
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null
    // Re-export so a key with trailing bytes or a non-canonical encoding is refused.
    const canonical = key.export({ format: 'der', type: 'spki' }) as Buffer
    if (!canonical.equals(der)) return null
    return { key, der }
  } catch {
    return null
  }
}

/** `kid = base64url(sha256(SPKI))[0..22]` (plan §4.2). */
export function kidOfSpki(der: Buffer): string {
  return b64url(createHash('sha256').update(der).digest()).slice(0, 22)
}

/** The fingerprint people compare: the first 16 hex of sha256(SPKI), upper case, 4 groups of 4. */
export function fingerprintOfSpki(der: Buffer): string {
  const hex = sha256Hex(der).slice(0, 16).toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

/** The 6-digit SAS both screens show: sha256(challenge || spki), first 4 bytes mod 10^6. */
export function sasOf(challenge: Buffer, spkiDer: Buffer): string {
  const digest = createHash('sha256').update(challenge).update(spkiDer).digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** ECDSA P-256 / SHA-256 over `message`, signature P1363 r||s. Never throws. */
export function verifyP1363(key: KeyObject, message: Buffer | string, sigB64url: unknown): boolean {
  const sig = fromB64url(sigB64url)
  if (!sig || sig.length !== 64) return false
  try {
    return verify('sha256', typeof message === 'string' ? Buffer.from(message, 'utf8') : message, { key, dsaEncoding: 'ieee-p1363' }, sig)
  } catch {
    return false
  }
}

/** The JCS bytes of a closed-shape object, or null when it is not signable. */
export function canonicalBytes(value: unknown): Buffer | null {
  try { return Buffer.from(canonicalJson(value), 'utf8') } catch { return null }
}

/** The largest envelope header accepted (base64url of the JCS bytes). */
export const WEB_ENVELOPE_HEADER_MAX = 12 * 1024

export type EnvelopeParse =
  | { ok: true; envelope: WebTurnEnvelope; bytes: Buffer }
  | { ok: false; reason: 'envelope_malformed' | 'envelope_version_unknown' | 'scope_not_allowed' | 'envelope_not_canonical' }

/**
 * The `x-cos-web-envelope` header: base64url of the envelope's JCS bytes. Its bytes must already
 * be canonical (one message, one signable form), and its shape exactly `cos-web-turn/1`.
 */
export function parseEnvelopeHeader(header: unknown): EnvelopeParse {
  if (typeof header !== 'string' || header.length === 0 || header.length > WEB_ENVELOPE_HEADER_MAX) return { ok: false, reason: 'envelope_malformed' }
  const bytes = fromB64url(header)
  if (!bytes) return { ok: false, reason: 'envelope_malformed' }
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { return { ok: false, reason: 'envelope_malformed' } }
  const shape = parseWebTurnEnvelope(parsed)
  if (!shape.ok) return shape
  const canonical = canonicalBytes(shape.envelope)
  if (!canonical || !canonical.equals(bytes)) return { ok: false, reason: 'envelope_not_canonical' }
  return { ok: true, envelope: shape.envelope, bytes }
}
