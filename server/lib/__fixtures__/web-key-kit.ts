// Test kit for the enrolled phone key (6.99.31). Real P-256 keys from node:crypto, real P1363
// signatures, real JCS. Never shipped (server/lib/__fixtures__/** is outside the package).
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  canonicalJson, WEB_ANCHOR_STATEMENT_VERSION, WEB_ENROLL_APPROVE_VERSION, WEB_PASSKEY_ASSERTION_VERSION, WEB_TURN_ENVELOPE_VERSION, type WebTurnEnvelope,
} from '../../../shared/web-turn-envelope.js'
import { fingerprintOfSpki, kidOfSpki, sha256Hex } from '../web-key-envelope.js'
import { audOf, type WebKeyApproval, type WebKeyEntry } from '../web-key-registry.js'
import { wordsDigest, type IntegrityReport } from '../web-key-authority.js'
import type { PasskeyAssertion } from '../web-key-passkey.js'

export interface TestKey { privateKey: KeyObject; der: Buffer; spki: string; kid: string }

export function p256(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return { privateKey, der, spki: der.toString('base64url'), kid: kidOfSpki(der) }
}

export function signB64(key: TestKey, data: Buffer | string): string {
  return sign('sha256', typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
}

export function signJcs(key: TestKey, value: unknown): string {
  return signB64(key, canonicalJson(value))
}

export const SELF_DNS = 'ukaoma-mac-studio.tail38457f.ts.net'
/** The signer origin (review B2/W2): 3144, never the big app's 3143. */
export const ORIGIN = `https://${SELF_DNS}:3144`
/** An anchor registered 25 hours before the fixed test clock (1_786_000_000_000): past its 24 h maturity. */
export const MATURE_ANCHOR_SET_AT = 1_786_000_000_000 - 25 * 3_600_000
/** Integrity on and passing (review W1). */
export const INTEGRITY_OK: IntegrityReport = Object.freeze({ enabled: true, lastCheckOk: true, checkedAt: 1_786_000_000_000, manifestSha256: 'a'.repeat(64) }) as IntegrityReport

// Every phone key gets one companion passkey key (the WebAuthn credential bound in its approval).
const passkeys = new WeakMap<TestKey, TestKey>()
export function passkeyOf(phone: TestKey): TestKey {
  let k = passkeys.get(phone)
  if (!k) { k = p256(); passkeys.set(phone, k) }
  return k
}
export const credentialIdOf = (phone: TestKey): string => `cred-${phone.kid}`

/** The passkey public key as a COSE_Key (CBOR), base64url, exactly as WebAuthn reports it. */
export function coseOf(key: TestKey): string {
  const jwk = key.privateKey.export({ format: 'jwk' }) as { x: string; y: string }
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url')
  // {1: 2, 3: -7, -1: 1, -2: x, -3: y}
  return Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]).toString('base64url')
}

/** A WebAuthn assertion by `passkey` over `challenge`, with every field overridable for reject tests. */
export function passkeyAssertion(passkey: TestKey, challenge: Buffer, opts: { credentialId: string; origin?: string; rpId?: string; flags?: number; type?: string; challengeOverride?: string; crossOrigin?: boolean } ): PasskeyAssertion {
  const client = Buffer.from(JSON.stringify({
    type: opts.type ?? 'webauthn.get',
    challenge: opts.challengeOverride ?? challenge.toString('base64url'),
    origin: opts.origin ?? ORIGIN,
    ...(opts.crossOrigin !== undefined ? { crossOrigin: opts.crossOrigin } : {}),
  }), 'utf8')
  const authData = Buffer.concat([createHash('sha256').update(opts.rpId ?? SELF_DNS, 'utf8').digest(), Buffer.from([opts.flags ?? 0x05]), Buffer.from([0, 0, 0, 7])])
  const signed = Buffer.concat([authData, createHash('sha256').update(client).digest()])
  return {
    credentialId: opts.credentialId,
    authenticatorData: authData.toString('base64url'),
    clientDataJSON: client.toString('base64url'),
    signature: sign('sha256', signed, { key: passkey.privateKey, dsaEncoding: 'der' }).toString('base64url'),
  }
}

/** The `x-cos-web-passkey` header for an envelope: the phone's passkey, challenge sha256(envelope JCS). */
export function passkeyHeaderFor(phone: TestKey, env: unknown, opts: Partial<Parameters<typeof passkeyAssertion>[2]> & { passkey?: TestKey } = {}): string {
  const challenge = createHash('sha256').update(canonicalJson(env), 'utf8').digest()
  const envOrigin = typeof (env as { origin?: unknown })?.origin === 'string' ? (env as { origin: string }).origin : ORIGIN
  const a = passkeyAssertion(opts.passkey ?? passkeyOf(phone), challenge, { credentialId: credentialIdOf(phone), origin: envOrigin, ...opts })
  return Buffer.from(canonicalJson({ v: WEB_PASSKEY_ASSERTION_VERSION, ...a }), 'utf8').toString('base64url')
}

/** COS Control's anchor bootstrap body: the anchor's self-signature over its statement. */
export function anchorRegistrationBody(anchor: TestKey, createdAt: number): { anchorPub: string; statement: string; signature: string } {
  const statement = { v: WEB_ANCHOR_STATEMENT_VERSION, spkiSha256: sha256Hex(anchor.der), fingerprint: fingerprintOfSpki(anchor.der), createdAt }
  return { anchorPub: anchor.spki, statement: Buffer.from(canonicalJson(statement), 'utf8').toString('base64url'), signature: signJcs(anchor, statement) }
}

/** An entry the anchor approved, exactly as the ceremony would have written it. */
export function anchoredEntry(anchor: TestKey, phone: TestKey, opts: { aud?: string; epoch?: number; kver?: number; label?: string; revokedAt?: number; at?: number; rotates?: string | null; passkey?: TestKey } = {}): WebKeyEntry {
  const aud = opts.aud ?? audOf(anchor.der, SELF_DNS)
  const passkey = opts.passkey ?? passkeyOf(phone)
  const approval: WebKeyApproval = {
    v: WEB_ENROLL_APPROVE_VERSION,
    enrollId: `e-${phone.kid.slice(0, 8)}`,
    kid: phone.kid,
    spki: phone.spki,
    spki_sha256: sha256Hex(phone.der),
    fingerprint: fingerprintOfSpki(phone.der),
    label: opts.label ?? 'iPhone',
    userAgent: 'Safari',
    remote: '100.101.102.103',
    challenge: 'c'.repeat(43),
    sasCommit: 'd'.repeat(64),
    phoneNonce: 'r'.repeat(43),
    sas: '123456',
    aud,
    origin: ORIGIN,
    kver: opts.kver ?? 1,
    epoch: opts.epoch ?? 0,
    rotates: opts.rotates ?? null,
    passkey_credential_id: credentialIdOf(phone),
    passkey_spki_sha256: sha256Hex(passkey.der),
    enrolledAt: opts.at ?? 1_786_000_000_000,
    exp: (opts.at ?? 1_786_000_000_000) + 300_000,
  }
  return {
    kid: phone.kid, spki: phone.spki, label: opts.label ?? 'iPhone', enrolledAt: approval.enrolledAt, kver: approval.kver,
    passkeySpki: passkey.spki, approval, anchorSig: signJcs(anchor, approval),
    ...(typeof opts.revokedAt === 'number' ? { revokedAt: opts.revokedAt, revokeReason: 'test' } : {}),
  }
}

/**
 * Write a registry file as COS Control's bootstrap would leave it: anchorPub plus its registration
 * record (self-signed statement, setAt). `registration: false` writes an anchorPub with NO record
 * (the B1 attack: a key dropped into web-keys.json).
 */
export function seedRegistry(file: string, anchor: TestKey | null, entries: WebKeyEntry[] = [], epoch = 0, opts: { setAt?: number; registration?: boolean } = {}): void {
  const setAt = opts.setAt ?? MATURE_ANCHOR_SET_AT
  const reg = anchor && opts.registration !== false ? anchorRegistrationBody(anchor, setAt) : null
  writeFileSync(file, `${JSON.stringify({
    v: 1, anchorPub: anchor ? anchor.spki : null,
    anchorRegistration: reg ? { statement: reg.statement, signature: reg.signature, setAt } : null,
    epoch, entries,
  }, null, 2)}\n`)
}

export function envelopeFor(phone: TestKey, anchor: TestKey, fields: Partial<WebTurnEnvelope> & { words?: string; nowS?: number } = {}): WebTurnEnvelope {
  const nowS = fields.nowS ?? 1_786_000_000
  const words = fields.words ?? 'Yes install and proceed'
  const digest = wordsDigest(words)
  const { words: _w, nowS: _n, ...rest } = fields
  return {
    v: WEB_TURN_ENVELOPE_VERSION,
    aud: audOf(anchor.der, SELF_DNS),
    origin: ORIGIN,
    kid: phone.kid,
    kver: 1,
    epoch: 0,
    turnId: 'turn-web-key-0001',
    nonce: 'n'.repeat(22),
    iat: nowS,
    exp: nowS + 600,
    provider: 'claude',
    sessionId: 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d',
    bindingId: null,
    fork: false,
    wordsSha256: digest.sha256,
    wordsLen: digest.len,
    attachments: [],
    scope: { kind: 'message' },
    ...rest,
  }
}

export function encodeEnvelope(env: unknown): string {
  return Buffer.from(canonicalJson(env), 'utf8').toString('base64url')
}

/** The three headers a signed web turn carries: envelope, phone-key signature, passkey assertion. */
export function signedHeaders(phone: TestKey, env: unknown): { 'x-cos-web-envelope': string; 'x-cos-web-sig': string; 'x-cos-web-passkey': string } {
  return { 'x-cos-web-envelope': encodeEnvelope(env), 'x-cos-web-sig': signJcs(phone, env), 'x-cos-web-passkey': passkeyHeaderFor(phone, env) }
}
