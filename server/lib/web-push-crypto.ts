// X1 (iPhone pings, one-ping proof): Web Push message encryption and VAPID, on Node's own crypto. No package.
//
// RFC 8291 (Message Encryption for Web Push) over RFC 8188 `aes128gcm`, one record:
//   ecdh_secret = ECDH(as_private, ua_public)                       P-256
//   IKM         = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info" 0x00 ua_public as_public, 32)
//   CEK         = HKDF(salt=salt, ikm=IKM, info="Content-Encoding: aes128gcm" 0x00, 16)
//   NONCE       = HKDF(salt=salt, ikm=IKM, info="Content-Encoding: nonce" 0x00, 12)
//   body        = salt(16) rs(4, 4096) idlen(1, 65) as_public(65) AES-128-GCM(CEK, NONCE, plaintext 0x02) tag(16)
// Tested byte for byte against RFC 8291 Appendix A (web-push-crypto.test.ts).
//
// RFC 8292 (VAPID): an ES256 JWT { aud: the push service origin, exp: at most 24 h ahead (Apple refuses more than a
// day), sub: a URL or mailto }, sent as `Authorization: vapid t=<jwt>, k=<the raw public key, base64url>`.
//
// Nothing here does I/O, logs, or keeps a key; the store (web-push-store.ts) holds the keys.

import { createECDH, createPrivateKey, createPublicKey, createCipheriv, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto'

export const RECORD_SIZE = 4096
/** Apple: "The payload size is over the limit of 4 KB" (PayloadTooLarge). The plaintext must leave room for the header and tag. */
export const MAX_PLAINTEXT_BYTES = 3_800
/** Apple refuses a JWT whose exp is more than a day ahead (BadJwtToken); 12 h keeps clear of clock skew. */
export const VAPID_TTL_SECONDS = 12 * 60 * 60

export function b64u(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function fromB64u(text: string): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** A subscription's keys as the browser gives them: p256dh (65-byte uncompressed point) and auth (16 bytes). */
export interface PushKeys { p256dh: string; auth: string }

/** True only for keys of the right lengths and an uncompressed P-256 point. */
export function validPushKeys(keys: unknown): keys is PushKeys {
  if (!keys || typeof keys !== 'object') return false
  const k = keys as Record<string, unknown>
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return false
  try {
    const pub = fromB64u(k.p256dh), auth = fromB64u(k.auth)
    if (pub.length !== 65 || pub[0] !== 0x04 || auth.length !== 16) return false
    const probe = createECDH('prime256v1')
    probe.generateKeys()
    probe.computeSecret(pub) // throws on a point not on the curve
    return true
  } catch {
    return false
  }
}

/** The application server's key for one message: a fresh ECDH pair, or a fixed one in tests. */
export interface AsKey { privateKey: Buffer; publicKey: Buffer }
export function freshAsKey(): AsKey {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() }
}

/**
 * RFC 8291 encryption of one push message (a single record). `as` and `salt` are fixed only by tests (Appendix A);
 * otherwise a fresh key and 16 random bytes per message, as the RFC requires.
 */
export function encryptPushMessage(plaintext: Uint8Array, keys: PushKeys, opts: { as?: AsKey; salt?: Buffer } = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('payload too large')
  const uaPublic = fromB64u(keys.p256dh)
  const authSecret = fromB64u(keys.auth)
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys')
  const as = opts.as ?? freshAsKey()
  const salt = opts.salt ?? randomBytes(16)
  if (salt.length !== 16) throw new Error('bad salt')
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(as.privateKey)
  const ecdhSecret = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, as.publicKey])
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(as.publicKey.length, 20)
  return Buffer.concat([header, as.publicKey, body])
}

/** The VAPID key pair as kept on disk: a PKCS#8 PEM private key and the raw public point (base64url). */
export interface VapidKeys { privatePem: string; publicKey: string }
export function newVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return vapidKeysFromRaw(ecdh.getPrivateKey(), ecdh.getPublicKey())
}
/** Builds the stored form from a raw P-256 private scalar and public point (tests use RFC 8292-style fixed keys). */
export function vapidKeysFromRaw(privateRaw: Buffer, publicRaw: Buffer): VapidKeys {
  const x = publicRaw.subarray(1, 33), y = publicRaw.subarray(33, 65)
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(privateRaw), x: b64u(x), y: b64u(y) }, format: 'jwk' })
  return { privatePem: key.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: b64u(publicRaw) }
}
export function vapidPublicKeyObject(publicKey: string): KeyObject {
  const raw = fromB64u(publicKey)
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' })
}

/** The push service origin a JWT's `aud` must name: scheme and host of the endpoint. */
export function pushServiceOrigin(endpoint: string): string {
  const u = new URL(endpoint)
  return `${u.protocol}//${u.host}`
}

/** RFC 8292: the Authorization header value for one request. `sub` is a URL or mailto, never a person's address. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds: number, sub: string): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud: pushServiceOrigin(endpoint), exp: nowSeconds + VAPID_TTL_SECONDS, sub })))
  const signingInput = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(signingInput), { key: createPrivateKey(keys.privatePem), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${signingInput}.${b64u(signature)}, k=${keys.publicKey}`
}
