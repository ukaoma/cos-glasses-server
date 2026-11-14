// X1 (iPhone pings): RFC 8291 encryption byte for byte against the RFC's own Appendix A, and RFC 8292 VAPID.
import { describe, expect, it } from 'vitest'
import { createDecipheriv, createECDH, hkdfSync, verify } from 'node:crypto'
import {
  b64u,
  encryptPushMessage,
  fromB64u,
  MAX_PLAINTEXT_BYTES,
  newVapidKeys,
  pushServiceOrigin,
  validPushKeys,
  vapidAuthorization,
  vapidPublicKeyObject,
  VAPID_TTL_SECONDS,
} from './web-push-crypto.js'

// RFC 8291 Appendix A (whitespace removed). https://www.rfc-editor.org/rfc/rfc8291#appendix-A
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}
const rfcKeys = { p256dh: RFC.uaPublic, auth: RFC.auth }
const rfcAs = { privateKey: fromB64u(RFC.asPrivate), publicKey: fromB64u(RFC.asPublic) }

/** The receiving side (the phone), from the RFC: what a browser does with the body. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idlen)
  const record = body.subarray(21 + idlen)
  expect(rs).toBe(4096)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const secret = ecdh.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()])
  expect(padded[padded.length - 1]).toBe(0x02)
  return padded.subarray(0, padded.length - 1)
}

describe('X1 web push: RFC 8291 encryption', () => {
  it('reproduces RFC 8291 Appendix A exactly: the 86-octet header and the ciphertext', () => {
    const body = encryptPushMessage(fromB64u(RFC.plaintext), rfcKeys, { as: rfcAs, salt: fromB64u(RFC.salt) })
    expect(b64u(body.subarray(0, 86))).toBe(RFC.header)
    expect(b64u(body.subarray(86))).toBe(RFC.ciphertext)
    expect(body.equals(Buffer.concat([fromB64u(RFC.header), fromB64u(RFC.ciphertext)]))).toBe(true)
  })

  it('the phone decrypts what we send, with a fresh key and salt each time (never the same bytes twice)', () => {
    const ua = createECDH('prime256v1'); ua.generateKeys()
    const auth = Buffer.from('0123456789abcdef')
    const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }
    const msg = Buffer.from(JSON.stringify({ web_push: 8030, notification: { title: 'COS: Test ping', navigate: 'https://x.example/control' } }))
    const a = encryptPushMessage(msg, keys), b = encryptPushMessage(msg, keys)
    expect(a.equals(b)).toBe(false)
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false)
    expect(decrypt(a, ua.getPrivateKey(), ua.getPublicKey(), auth).toString()).toBe(msg.toString())
    expect(decrypt(b, ua.getPrivateKey(), ua.getPublicKey(), auth).toString()).toBe(msg.toString())
  })

  it('refuses a payload over the limit, bad keys and a bad salt', () => {
    expect(() => encryptPushMessage(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1), rfcKeys)).toThrow('payload too large')
    expect(() => encryptPushMessage(Buffer.from('x'), { p256dh: RFC.uaPublic, auth: 'AAAA' })).toThrow('bad subscription keys')
    expect(() => encryptPushMessage(Buffer.from('x'), rfcKeys, { salt: Buffer.alloc(8) })).toThrow('bad salt')
    expect(encryptPushMessage(Buffer.alloc(MAX_PLAINTEXT_BYTES), rfcKeys).length).toBeLessThanOrEqual(4096)
  })

  it('validPushKeys: a real P-256 point and a 16-byte secret only', () => {
    expect(validPushKeys(rfcKeys)).toBe(true)
    expect(validPushKeys({ p256dh: RFC.uaPublic, auth: b64u(Buffer.alloc(15)) })).toBe(false)
    const notOnCurve = Buffer.from(fromB64u(RFC.uaPublic)); notOnCurve[40] ^= 0xff
    expect(validPushKeys({ p256dh: b64u(notOnCurve), auth: RFC.auth })).toBe(false)
    const compressed = Buffer.from(fromB64u(RFC.uaPublic)); compressed[0] = 0x02
    expect(validPushKeys({ p256dh: b64u(compressed), auth: RFC.auth })).toBe(false)
    for (const bad of [null, {}, { p256dh: 'not base64!', auth: RFC.auth }, { p256dh: RFC.uaPublic }]) expect(validPushKeys(bad)).toBe(false)
  })
})

describe('X1 web push: RFC 8292 VAPID', () => {
  it('an ES256 JWT for the push service origin, at most a day ahead, signed by our key, with the raw public key', () => {
    const keys = newVapidKeys()
    const now = 1_794_670_000
    const header = vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH6cTPXQ8xsAeBCs?x=1', keys, now, 'https://gotcos.com')
    const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header)!
    expect(m).not.toBeNull()
    expect(JSON.parse(fromB64u(m[1]!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = JSON.parse(fromB64u(m[2]!).toString())
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: now + VAPID_TTL_SECONDS, sub: 'https://gotcos.com' })
    expect(claims.exp - now).toBeLessThanOrEqual(24 * 60 * 60)
    expect(m[4]).toBe(keys.publicKey)
    expect(fromB64u(keys.publicKey).length).toBe(65)
    const ok = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: vapidPublicKeyObject(keys.publicKey), dsaEncoding: 'ieee-p1363' }, fromB64u(m[3]!))
    expect(ok).toBe(true)
  })

  it('pushServiceOrigin drops the path and query: the token names the service, never the subscription', () => {
    expect(pushServiceOrigin('https://web.push.apple.com/abc/def?q=1')).toBe('https://web.push.apple.com')
  })
})
