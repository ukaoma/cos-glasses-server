// 6.99.31 Phase 3: the phone key's proof assembly (server/web-signer/signer-proof.js), the REAL file the
// 3144 page loads, checked against the SERVER's own code: its JCS, its SAS, its enrollment proof check
// (WebKeyEnrollments.start and prove), its COSE parser and its turn acceptance (WebKeyAuthority.accept,
// which runs the passkey verifier). If the page and the server ever disagree on one byte, these fail.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign, webcrypto } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '../../shared/web-turn-envelope.js'
import { fingerprintOfSpki, kidOfSpki, parseEnvelopeHeader } from '../lib/web-key-envelope.js'
import { sasOf, WebKeyEnrollments, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from '../lib/web-key-registry.js'
import { coseP256ToSpki, parsePasskeyHeader, turnPasskeyChallenge } from '../lib/web-key-passkey.js'
import { WebKeyAuthority, wordsDigest } from '../lib/web-key-authority.js'
import { anchoredEntry, INTEGRITY_OK, ORIGIN, p256, passkeyAssertion, passkeyOf, credentialIdOf, seedRegistry, SELF_DNS, type TestKey } from '../lib/__fixtures__/web-key-kit.js'

const HERE = dirname(fileURLToPath(import.meta.url))
type Proof = Record<string, any>
function loadProof(): Proof {
  const win: Record<string, unknown> = { crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob }
  new Function('window', readFileSync(join(HERE, 'signer-proof.js'), 'utf8'))(win)
  return win.COSSignerProof as Proof
}
const P = loadProof()
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const buf = (v: Uint8Array): Buffer => Buffer.from(v)
const NOW = 1_786_000_000_000
const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'

describe('JCS and words: the page encodes exactly as the server', () => {
  it('canonicalJson agrees byte for byte with shared/web-turn-envelope.ts', () => {
    const samples = [
      { b: 2, a: [1, 'x', null, true, false], c: { z: 'éé ', y: '"\\\n' } },
      { emoji: '\u{1F600} ok', nested: { k: [{ q: 1 }, { p: 'x' }] }, n: 9007199254740991 },
    ]
    for (const s of samples) expect(P.canonicalJson(s)).toBe(canonicalJson(s))
  })
  it('refuses what the protocol never signs: floats and lone surrogates', () => {
    expect(() => P.canonicalJson({ a: 1.5 })).toThrow('not_signable')
    expect(() => P.canonicalJson({ a: '\ud800' })).toThrow('not_signable')
    expect(() => P.canonicalJson({ ['\udc00']: 1 })).toThrow('not_signable')
  })
  it('trims trailing ASCII whitespace only; inner whitespace is exact', () => {
    expect(P.signedWords('Yes  do it \t\r\n \n')).toBe('Yes  do it')
    expect(P.signedWords('  lead\n\nmiddle  ')).toBe('  lead\n\nmiddle')
    expect(P.signedWords('no trailing')).toBe('no trailing')
  })
  it('the words digest is the server wordsDigest (CRLF as LF, UTF-8 byte length)', async () => {
    const words = 'Line one\r\nline two é'
    expect(await P.wordsDigest(words)).toEqual(wordsDigest(words))
  })
})

describe('enrollment math: the code the phone shows is the server code', () => {
  it('sasCommit is hex sha256(r); sasCode equals the server sasOf(challenge, spki, r)', async () => {
    const r = new Uint8Array(32).map((_, i) => i * 7)
    const challenge = new Uint8Array(32).map((_, i) => 255 - i)
    const spki = p256().der
    expect(await P.sasCommit(r)).toBe(createHash('sha256').update(r).digest('hex'))
    for (let i = 0; i < 20; i++) {
      challenge[0] = i
      expect(await P.sasCode(challenge, new Uint8Array(spki), r)).toBe(sasOf(Buffer.from(challenge), spki, Buffer.from(r)))
    }
  })
  it('kid and fingerprint equal the server helpers', async () => {
    const k = p256()
    expect(await P.kidOf(new Uint8Array(k.der))).toBe(kidOfSpki(k.der))
    expect(await P.fingerprintOf(new Uint8Array(k.der))).toBe(fingerprintOfSpki(k.der))
  })
  it('the proof-of-possession object is the server proofMessage, key for key', () => {
    const p = { enrollId: 'e1', challenge: 'c'.repeat(43), aud: 'a'.repeat(64), origin: ORIGIN, kid: 'k'.repeat(22), phoneNonce: 'r'.repeat(43), passkeyCredentialId: 'cred', passkeySpkiSha256: 'b'.repeat(64) }
    expect(P.canonicalJson(P.enrollProofMessage(p))).toBe(canonicalJson(WebKeyEnrollments.proofMessage(p)))
  })
  it('COSE built on the phone parses on the server to the SPKI the phone hashed', () => {
    const k = p256()
    const xy = P.xyFromSpki(new Uint8Array(k.der))
    expect(xy).not.toBeNull()
    const cose = P.coseFromXY(xy.x, xy.y)
    const serverSpki = coseP256ToSpki(Buffer.from(cose).toString('base64url'))
    expect(serverSpki && serverSpki.equals(buf(P.spkiFromXY(xy.x, xy.y)))).toBe(true)
    expect(serverSpki && serverSpki.equals(k.der)).toBe(true)
  })
  it('reads the credential key from an attestation object when getPublicKey() is missing', () => {
    const k = p256()
    const xy = P.xyFromSpki(new Uint8Array(k.der))
    const cose = Buffer.from(P.coseFromXY(xy.x, xy.y))
    const credId = Buffer.from('credential-id-16')
    const authData = Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x45]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cose])
    // {"fmt": "none", "attStmt": {}, "authData": h'...'}
    const att = Buffer.concat([Buffer.from([0xa3, 0x63]), Buffer.from('fmt'), Buffer.from([0x64]), Buffer.from('none'), Buffer.from([0x67]), Buffer.from('attStmt'), Buffer.from([0xa0, 0x68]), Buffer.from('authData'), Buffer.from([0x59, authData.length >> 8, authData.length & 0xff]), authData])
    const got = P.passkeyXY({ attestationObject: new Uint8Array(att) })
    expect(buf(got.x).equals(buf(xy.x)) && buf(got.y).equals(buf(xy.y))).toBe(true)
    // Without the attested-credential flag there is no key to read.
    authData[32] = 0x05
    const att2 = Buffer.concat([att.subarray(0, att.length - authData.length), authData])
    expect(P.passkeyXY({ attestationObject: new Uint8Array(att2) })).toBeNull()
  })
  it('a full enrollment with a NON-extractable WebCrypto key passes the server prove, and the server SAS is the local one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signer-enroll-'))
    try {
      const anchor = p256()
      seedRegistry(join(dir, 'web-keys.json'), anchor)
      const registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => NOW)
      const enroll = new WebKeyEnrollments(registry, { now: () => NOW, deviceAllowed: () => true })
      const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      expect(pair.privateKey.extractable).toBe(false)
      const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey))
      const r = webcrypto.getRandomValues(new Uint8Array(32))
      const start = enroll.start({ spki: P.b64url(spki), label: 'iPhone', userAgent: 'Safari', remote: '100.64.0.9', sasCommit: await P.sasCommit(r) }, { selfDnsName: SELF_DNS, origin: ORIGIN })
      expect(start.ok).toBe(true)
      if (!start.ok) return
      const code = await P.sasCode(P.fromB64url(start.challenge), spki, r)
      const passkey = p256()
      const xy = P.xyFromSpki(new Uint8Array(passkey.der))
      const msg = P.jcsBytes(P.enrollProofMessage({
        enrollId: start.enrollId, challenge: start.challenge, aud: start.aud, origin: ORIGIN, kid: await P.kidOf(spki),
        phoneNonce: P.b64url(r), passkeyCredentialId: 'cred-1', passkeySpkiSha256: P.hex(await P.sha256(P.spkiFromXY(xy.x, xy.y))),
      }))
      const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, msg))
      const assertion = passkeyAssertion(passkey, buf(await P.sha256(msg)), { credentialId: 'cred-1' })
      const proved = enroll.prove({ enrollId: start.enrollId, signature: P.b64url(sig), phoneNonce: P.b64url(r), passkey: { publicKey: P.b64url(P.coseFromXY(xy.x, xy.y)), credentialId: 'cred-1', assertion } })
      expect(proved).toEqual({ ok: true, sas: code, fingerprint: await P.fingerprintOf(spki) })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('assembleTurnProof: the seam, accepted by the server authority as is', () => {
  let dir: string
  let anchor: TestKey
  let phone: TestKey
  let authority: WebKeyAuthority
  let nonces: WebKeyNonces
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'signer-proof-'))
    anchor = p256()
    phone = p256()
    seedRegistry(join(dir, 'web-keys.json'), anchor, [anchoredEntry(anchor, phone)])
    const registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => NOW)
    nonces = new WebKeyNonces(join(dir, 'nonces.json'), () => NOW)
    authority = new WebKeyAuthority({ registry, nonces, packets: new WebKeyPackets(() => NOW), integrity: () => INTEGRITY_OK, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => NOW })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function issued(): { nonce: string; aud: string; epoch: number } {
    const n = nonces.issue()
    if (!n.ok) throw new Error(n.reason)
    return { nonce: n.nonce, aud: authority.registry.aud(SELF_DNS)!, epoch: 0 }
  }
  const calls: string[] = []
  function nodeSigner(key: TestKey = phone, opts: { assertKey?: TestKey; badLength?: boolean } = {}) {
    return {
      kid: key.kid,
      signEnvelope: async (bytes: Uint8Array) => {
        calls.push('sign')
        const s = sign('sha256', Buffer.from(bytes), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
        return new Uint8Array(opts.badLength ? s.subarray(0, 63) : s)
      },
      // The passkey assertion is made over WHATEVER challenge the page derived. The server checks it against its own.
      assert: async (challenge: Uint8Array) => {
        calls.push('assert')
        return passkeyAssertion(opts.assertKey ?? passkeyOf(phone), Buffer.from(challenge), { credentialId: credentialIdOf(phone) })
      },
    }
  }
  const handoff = (over: Record<string, unknown> = {}) => ({
    words: 'Yes install and proceed  \n', provider: 'claude', sessionId: SID, bindingId: 'b-1', scope: { kind: 'message' },
    turn: { epoch: 3, targetKey: '6:claude:36:' + SID, clientTurnId: 'turn-web-key-0001' }, ...over,
  })
  const candidate = (proof: Proof) => ({ envelope: proof.headers['x-cos-web-envelope'], signature: proof.headers['x-cos-web-sig'], passkey: proof.headers['x-cos-web-passkey'], requestOrigin: ORIGIN })
  const ctx = (proof: Proof) => ({ provider: 'claude', sessionId: SID, bindingId: 'b-1', turnId: 'turn-web-key-0001', words: proof.body.prompt as string, attachments: [] })

  it('the server accepts the page-built proof: signature, passkey over sha256(envelope JCS), words, target', async () => {
    calls.length = 0
    const proof = await P.assembleTurnProof({ handoff: handoff(), nonce: issued(), signer: nodeSigner(), origin: ORIGIN, nowMs: NOW })
    expect(calls).toEqual(['sign', 'assert'])
    const verdict = authority.accept(candidate(proof), ctx(proof))
    expect(verdict).toMatchObject({ ok: true })
    // The challenge the page gave the passkey is exactly the server's turnPasskeyChallenge.
    const parsed = parseEnvelopeHeader(proof.headers['x-cos-web-envelope'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(buf(proof.challenge).equals(turnPasskeyChallenge(parsed.bytes))).toBe(true)
    expect(parsePasskeyHeader(proof.headers['x-cos-web-passkey'])).not.toBeNull()
  })
  it('the words signed, posted and returned are the trimmed words; the server would refuse the untrimmed ones', async () => {
    const proof = await P.assembleTurnProof({ handoff: handoff(), nonce: issued(), signer: nodeSigner(), origin: ORIGIN, nowMs: NOW })
    expect(proof.words).toBe('Yes install and proceed')
    expect(proof.body.prompt).toBe(proof.words)
    expect(plain(proof.envelope).wordsSha256).toBe(wordsDigest('Yes install and proceed').sha256)
    // The server hashes what it receives: the untrimmed words do not match the signed hash.
    expect(authority.accept(candidate(proof), { ...ctx(proof), words: 'Yes install and proceed  \n' })).toEqual({ ok: false, reason: 'words_changed' })
  })
  it('a challenge other than sha256(envelope JCS) is refused by the server (passkey_challenge_mismatch)', async () => {
    const signer = nodeSigner()
    const wrong = { ...signer, assert: async (c: Uint8Array) => signer.assert(new Uint8Array(await P.sha256(c))) }
    const proof = await P.assembleTurnProof({ handoff: handoff(), nonce: issued(), signer: wrong, origin: ORIGIN, nowMs: NOW })
    expect(authority.accept(candidate(proof), ctx(proof))).toEqual({ ok: false, reason: 'passkey_challenge_mismatch' })
  })
  it('the envelope names the origin the page passes, never one in the handoff', async () => {
    const proof = await P.assembleTurnProof({ handoff: handoff({ origin: 'https://evil.example:3144' }), nonce: issued(), signer: nodeSigner(), origin: ORIGIN, nowMs: NOW })
    expect(plain(proof.envelope).origin).toBe(ORIGIN)
    await expect(P.assembleTurnProof({ handoff: handoff(), nonce: issued(), signer: nodeSigner(), origin: 'http://' + SELF_DNS + ':3144', nowMs: NOW })).rejects.toThrow('origin_invalid')
  })
  it('lifetime and iat stay inside the server bounds (iat backdated 30 s, exp 600 s on)', async () => {
    const proof = await P.assembleTurnProof({ handoff: handoff(), nonce: issued(), signer: nodeSigner(), origin: ORIGIN, nowMs: NOW })
    const env = plain(proof.envelope)
    expect(env.iat).toBe(NOW / 1000 - 30)
    expect(env.exp - env.iat).toBe(600)
    expect(env.fork).toBe(false)
    expect(env.attachments).toEqual([])
    expect(env.kver).toBe(1)
    expect(env.turnId).toBe('turn-web-key-0001')
    expect(env.bindingId).toBe('b-1')
  })
  it('refuses files, empty words, a short signature and an unknown scope before asking for Face ID', async () => {
    calls.length = 0
    await expect(P.assembleTurnProof({ handoff: handoff({ attachments: [{ id: 'm1' }] }), nonce: issued(), signer: nodeSigner(), origin: ORIGIN, nowMs: NOW })).rejects.toThrow('attachments_not_signable')
    await expect(P.assembleTurnProof({ handoff: handoff({ words: ' \n\t' }), nonce: issued(), signer: nodeSigner(), origin: ORIGIN, nowMs: NOW })).rejects.toThrow('words_empty')
    await expect(P.assembleTurnProof({ handoff: handoff({ scope: { kind: 'install' } }), nonce: issued(), signer: nodeSigner(), origin: ORIGIN, nowMs: NOW })).rejects.toThrow('scope_not_allowed')
    expect(calls).toEqual([])
    await expect(P.assembleTurnProof({ handoff: handoff(), nonce: issued(), signer: nodeSigner(phone, { badLength: true }), origin: ORIGIN, nowMs: NOW })).rejects.toThrow('signature_not_p1363')
    expect(calls).toEqual(['sign'])
  })
  it('a signature by another key is refused (the page signs with the enrolled key only)', async () => {
    const other = p256()
    const proof = await P.assembleTurnProof({ handoff: handoff(), nonce: issued(), signer: { ...nodeSigner(other), kid: phone.kid }, origin: ORIGIN, nowMs: NOW })
    expect(authority.accept(candidate(proof), ctx(proof))).toEqual({ ok: false, reason: 'signature_invalid' })
  })
})

describe('the signer origin key pair the kit uses is ordinary P-256 (sanity for the vectors above)', () => {
  it('node and WebCrypto export the same SPKI prefix', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
    expect(P.xyFromSpki(new Uint8Array(der))).not.toBeNull()
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    expect(P.xyFromSpki(new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey)))).not.toBeNull()
  })
})


describe('the signer checks the full packet preimage before signing', () => {
  const packet = { v: 'cos-web-packet/1', packetId: 'AAECAwQFBgcICQoL', action: 'publish', artifact: 'gotcos-site-manifest', version: '7.0.6', digest: 'sha256:' + 'a'.repeat(64), channel: 'gotcos-site', provider: 'codex', sessionId: SID, createdAt: NOW, exp: NOW + 1800000 }
  const hash = createHash('sha256').update(canonicalJson(packet), 'utf8').digest('hex')
  const h = { provider: 'codex', sessionId: SID, packet, scope: { kind: 'approve', action: packet.action, artifact: packet.artifact, version: packet.version, digest: packet.digest, channel: packet.channel, packetSha256: hash } }
  it('the exact preimage is accepted, independently of a server verdict', async () => {
    expect(await P.validateHandoffPacket(h, NOW)).toEqual(packet)
  })
  it('changed bytes, receiver, channel, expiry, unknown scope and missing preimage are refused', async () => {
    for (const changed of [
      { ...h, packet: { ...packet, digest: 'sha256:' + 'b'.repeat(64) } },
      { ...h, packet: { ...packet, digest: 'sha256:' + 'b'.repeat(64) }, scope: { ...h.scope, digest: 'sha256:' + 'b'.repeat(64) } },
      { ...h, packet: { ...packet, sessionId: 'other-session' } },
      { ...h, scope: { ...h.scope, channel: 'release-docs' } },
      { ...h, packet: { ...packet, extra: true } },
      { ...h, packet: null },
      { ...h, scope: { ...h.scope, channel: 'all-release' } },
      { ...h, scope: { ...h.scope, action: 'push-main', channel: 'git-main' } },
    ]) await expect(P.validateHandoffPacket(changed, NOW)).rejects.toBeTruthy()
    await expect(P.validateHandoffPacket(h, packet.exp + 1)).rejects.toHaveProperty('reason', 'packet_expired')
  })
})
