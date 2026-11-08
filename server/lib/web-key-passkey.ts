// WebAuthn passkey assertions for the enrolled phone key (6.99.31, review B2). node:crypto only.
//
// Every vouched web turn carries a user-verified assertion whose challenge is
// base64url(sha256(envelope JCS bytes)). The passkey's credential id and public key hash are inside
// the anchor-signed enrollment approval, so a script on the signer origin that holds only the
// phone key (non-extractable but usable without a tap) cannot vouch anything without Miles's face
// or finger at that moment. Field rules: docs/web-key-verifier-contract.md section 5.

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { canonicalBytes, fromB64url, parseP256Spki } from './web-key-envelope.js'
import { WEB_PASSKEY_ASSERTION_VERSION } from '../../shared/web-turn-envelope.js'

export const WEB_PASSKEY_HEADER = 'x-cos-web-passkey'
export const PASSKEY_FLAG_UP = 0x01
export const PASSKEY_FLAG_UV = 0x04

export interface PasskeyAssertion {
  credentialId: string
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

const ASSERTION_KEYS = ['v', 'credentialId', 'authenticatorData', 'clientDataJSON', 'signature'] as const

function isB64url(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= max && fromB64url(s) !== null
}

/** The four assertion fields from an object (`v` optional), or null. */
export function parsePasskeyAssertion(v: unknown, requireVersion = false): PasskeyAssertion | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  const allowed = new Set<string>(ASSERTION_KEYS)
  if (keys.some(k => !allowed.has(k))) return null
  if (requireVersion || 'v' in o) { if (o.v !== WEB_PASSKEY_ASSERTION_VERSION) return null }
  if (!isB64url(o.credentialId, 1024) || !isB64url(o.authenticatorData, 4096) || !isB64url(o.clientDataJSON, 4096) || !isB64url(o.signature, 256)) return null
  return { credentialId: o.credentialId, authenticatorData: o.authenticatorData, clientDataJSON: o.clientDataJSON, signature: o.signature }
}

/** The `x-cos-web-passkey` header: base64url of the canonical JCS of a `cos-web-passkey/1` object. */
export function parsePasskeyHeader(header: unknown): PasskeyAssertion | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 12 * 1024) return null
  const bytes = fromB64url(header)
  if (!bytes) return null
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { return null }
  const a = parsePasskeyAssertion(parsed, true)
  if (!a) return null
  const canonical = canonicalBytes({ v: WEB_PASSKEY_ASSERTION_VERSION, ...a })
  return canonical && canonical.equals(bytes) ? a : null
}

// ---- minimal CBOR (RFC 8949) for a COSE_Key map: small int keys, ints and byte strings only ----

function readHead(buf: Buffer, pos: number): { major: number; val: number; next: number } | null {
  if (pos >= buf.length) return null
  const ib = buf[pos]
  const major = ib >> 5
  const info = ib & 0x1f
  if (info < 24) return { major, val: info, next: pos + 1 }
  if (info === 24 && pos + 1 < buf.length) return { major, val: buf[pos + 1], next: pos + 2 }
  if (info === 25 && pos + 2 < buf.length) return { major, val: buf.readUInt16BE(pos + 1), next: pos + 3 }
  return null
}

function readInt(buf: Buffer, pos: number): { value: number; next: number } | null {
  const h = readHead(buf, pos)
  if (!h) return null
  if (h.major === 0) return { value: h.val, next: h.next }
  if (h.major === 1) return { value: -1 - h.val, next: h.next }
  return null
}

/**
 * A COSE EC2 P-256 ES256 public key (base64url CBOR) as P-256 SPKI DER, or null. Exactly the map
 * {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x (32 bytes), -3: y (32 bytes)}; anything else refused.
 */
export function coseP256ToSpki(coseB64url: unknown): Buffer | null {
  const buf = fromB64url(coseB64url)
  if (!buf || buf.length > 256) return null
  const head = readHead(buf, 0)
  if (!head || head.major !== 5 || head.val !== 5) return null
  let pos = head.next
  const map = new Map<number, number | Buffer>()
  for (let i = 0; i < 5; i += 1) {
    const k = readInt(buf, pos)
    if (!k || map.has(k.value)) return null
    pos = k.next
    const h = readHead(buf, pos)
    if (!h) return null
    if (h.major === 2) {
      if (h.next + h.val > buf.length) return null
      map.set(k.value, buf.subarray(h.next, h.next + h.val))
      pos = h.next + h.val
    } else {
      const v = readInt(buf, pos)
      if (!v) return null
      map.set(k.value, v.value)
      pos = v.next
    }
  }
  if (pos !== buf.length) return null
  const x = map.get(-2)
  const y = map.get(-3)
  if (map.get(1) !== 2 || map.get(3) !== -7 || map.get(-1) !== 1) return null
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) return null
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' })
    const der = key.export({ format: 'der', type: 'spki' }) as Buffer
    return parseP256Spki(der.toString('base64url')) ? der : null
  } catch {
    return null
  }
}

export type PasskeyVerdict = { ok: true; signCount: number } | { ok: false; reason: 'passkey_malformed' | 'passkey_credential_mismatch' | 'passkey_type_invalid' | 'passkey_challenge_mismatch' | 'passkey_origin_mismatch' | 'passkey_rpid_mismatch' | 'passkey_not_user_verified' | 'passkey_invalid' }

/**
 * Verify one WebAuthn assertion. `challenge` is the raw challenge bytes (the phone passed them to
 * navigator.credentials.get, so clientDataJSON carries their base64url). Never throws.
 */
export function verifyPasskeyAssertion(a: PasskeyAssertion, expect: { challenge: Buffer; origin: string; rpId: string; credentialId: string; publicKey: KeyObject }): PasskeyVerdict {
  try {
    if (a.credentialId !== expect.credentialId) return { ok: false, reason: 'passkey_credential_mismatch' }
    const authData = fromB64url(a.authenticatorData)
    const clientBytes = fromB64url(a.clientDataJSON)
    const sig = fromB64url(a.signature)
    if (!authData || !clientBytes || !sig || authData.length < 37) return { ok: false, reason: 'passkey_malformed' }
    let client: Record<string, unknown>
    try {
      const parsed = JSON.parse(clientBytes.toString('utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'passkey_malformed' }
      client = parsed as Record<string, unknown>
    } catch { return { ok: false, reason: 'passkey_malformed' } }
    if (client.type !== 'webauthn.get') return { ok: false, reason: 'passkey_type_invalid' }
    if (client.challenge !== expect.challenge.toString('base64url')) return { ok: false, reason: 'passkey_challenge_mismatch' }
    if (client.origin !== expect.origin || (client.crossOrigin !== undefined && client.crossOrigin !== false)) return { ok: false, reason: 'passkey_origin_mismatch' }
    const rpIdHash = createHash('sha256').update(expect.rpId, 'utf8').digest()
    if (!authData.subarray(0, 32).equals(rpIdHash)) return { ok: false, reason: 'passkey_rpid_mismatch' }
    const flags = authData[32]
    if ((flags & PASSKEY_FLAG_UP) === 0 || (flags & PASSKEY_FLAG_UV) === 0) return { ok: false, reason: 'passkey_not_user_verified' }
    const signed = Buffer.concat([authData, createHash('sha256').update(clientBytes).digest()])
    if (!verify('sha256', signed, { key: expect.publicKey, dsaEncoding: 'der' }, sig)) return { ok: false, reason: 'passkey_invalid' }
    return { ok: true, signCount: authData.readUInt32BE(33) }
  } catch {
    return { ok: false, reason: 'passkey_invalid' }
  }
}

/** The challenge a turn's passkey assertion signs: sha256 of the envelope's JCS bytes. */
export function turnPasskeyChallenge(envelopeBytes: Buffer): Buffer {
  return createHash('sha256').update(envelopeBytes).digest()
}
