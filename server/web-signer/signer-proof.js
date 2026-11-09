// The phone key's proof assembly (6.99.31, plan Phase 3). ONE module, no DOM, no network, no storage:
// it turns a handoff plus a server nonce into the exact envelope bytes, asks a SIGNER for the two
// proofs, and returns the three headers and the turn body. The signer is an interface:
//
//   { kid, signEnvelope(bytes) -> Promise<Uint8Array(64) P1363>, assert(challengeBytes) -> Promise<{
//       credentialId, authenticatorData, clientDataJSON, signature }> (all base64url) }
//
// The 3144 page (signer.js) implements it with a WebCrypto key and a passkey with Face ID. That is the
// complete approval path for every user, including people with only a phone and a Mac (Miles,
// 2026-11-07). An optional companion signer (the COS glasses app) could implement the same interface
// later and reuse everything below; nothing here assumes one exists, and none is ever required.
//
// The enrollment math lives here too (the SAS commit-reveal, the 6-digit code, the proof-of-possession
// object), so the code the phone shows is computed on the phone, from the same bytes the server uses.
// Field rules: docs/web-key-verifier-contract.md. Classic script: it defines window.COSSignerProof.
(function (root) {
  'use strict'

  var ENVELOPE_VERSION = 'cos-web-turn/1'
  var ENROLL_PROOF_VERSION = 'cos-web-enroll/2'
  var PASSKEY_VERSION = 'cos-web-passkey/1'
  /** Seconds an envelope lives. The server allows at most 900. */
  var ENVELOPE_LIFETIME_S = 600
  /** How far back iat is set, so a phone clock a little ahead of the Mac is still inside the 60 s skew. */
  var IAT_BACKDATE_S = 30
  var TRAILING_WS = /[\t\n\v\f\r ]+$/
  var TURN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
  var NONCE = /^[A-Za-z0-9_-]{22,64}$/
  var HEX64 = /^[0-9a-f]{64}$/
  var PROVIDERS = { claude: 1, codex: 1, cursor: 1 }
  // P-256 SubjectPublicKeyInfo DER header for an uncompressed point (what node and WebCrypto export).
  var SPKI_P256_PREFIX = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04]

  function fail(reason) { var e = new Error(reason); e.reason = reason; return e }
  function bytes(v) { return v instanceof Uint8Array ? v : new Uint8Array(v && v.buffer ? v.buffer.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength) : v) }
  function concat() {
    var parts = Array.prototype.map.call(arguments, bytes), n = 0, i
    for (i = 0; i < parts.length; i++) n += parts[i].length
    var out = new Uint8Array(n), at = 0
    for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length }
    return out
  }
  function utf8(s) { return new root.TextEncoder().encode(s) }

  function b64url(v) {
    var b = bytes(v), s = ''
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
    return root.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  /** Strict base64url (no padding, no other alphabet), or null. */
  function fromB64url(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
    var p = s.replace(/-/g, '+').replace(/_/g, '/')
    while (p.length % 4) p += '='
    var bin = root.atob(p), out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  function hex(v) {
    var b = bytes(v), s = ''
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16)
    return s
  }
  function sha256(v) {
    return root.crypto.subtle.digest('SHA-256', bytes(v)).then(function (d) { return new Uint8Array(d) })
  }

  // ── RFC 8785 JCS, the same rules as shared/web-turn-envelope.ts canonicalJson ──
  function hasLoneSurrogate(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) {
        var n = s.charCodeAt(i + 1)
        if (!(n >= 0xdc00 && n <= 0xdfff)) return true
        i++
      } else if (c >= 0xdc00 && c <= 0xdfff) return true
    }
    return false
  }
  function isPlain(v) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    var proto = Object.getPrototypeOf(v)
    return proto === null || Object.getPrototypeOf(proto) === null
  }
  function canonicalJson(value) {
    if (value === null) return 'null'
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw fail('not_signable')
      return JSON.stringify(value)
    }
    if (typeof value === 'string') {
      if (hasLoneSurrogate(value)) throw fail('not_signable')
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
    if (isPlain(value)) {
      return '{' + Object.keys(value).sort().map(function (k) {
        if (hasLoneSurrogate(k)) throw fail('not_signable')
        return JSON.stringify(k) + ':' + canonicalJson(value[k])
      }).join(',') + '}'
    }
    throw fail('not_signable')
  }
  function jcsBytes(value) { return utf8(canonicalJson(value)) }

  // ── words ──
  /**
   * The words exactly as they are shown, signed and sent. Trailing ASCII whitespace goes (the server
   * refuses signed words that end in it, `words_trailing_whitespace`); nothing else changes.
   */
  function signedWords(words) { return String(words == null ? '' : words).replace(TRAILING_WS, '') }
  /** sha256 and UTF-8 length of the words with CRLF as LF, the server's wordsDigest. */
  function wordsDigest(words) {
    var b = utf8(String(words).replace(/\r\n/g, '\n'))
    return sha256(b).then(function (d) { return { sha256: hex(d), len: b.length } })
  }

  // ── the envelope ──
  function scopeOf(s) {
    if (!s || s.kind === 'message') {
      if (s && Object.keys(s).length !== 1) throw fail('scope_not_allowed')
      return { kind: 'message' }
    }
    if (s.kind === 'approve') {
      var keys = ['kind', 'action', 'artifact', 'version', 'digest', 'channel', 'packetSha256']
      if (Object.keys(s).length !== keys.length || keys.some(function (k) { return typeof s[k] !== 'string' })) throw fail('scope_not_allowed')
      var channels = { install: ['mac-local'], publish: ['npm-next', 'npm-latest', 'control-appcast', 'hub-alias', 'gotcos-site', 'control-downloads', 'release-docs'] }
      if (!Object.prototype.hasOwnProperty.call(channels, s.action) || channels[s.action].indexOf(s.channel) < 0
        || !/^[a-z0-9@][a-z0-9@._/-]{0,127}$/.test(s.artifact) || !/^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,32})?$/.test(s.version)
        || !/^(sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128}|sha512-[A-Za-z0-9+/]{86}==)$/.test(s.digest) || !HEX64.test(s.packetSha256)) throw fail('scope_not_allowed')
      var manifests = { 'gotcos-site': 'gotcos-site-manifest', 'control-downloads': 'cos-control-downloads-manifest', 'release-docs': 'cos-release-docs-manifest' }
      if (Object.prototype.hasOwnProperty.call(manifests, s.channel) && (s.artifact !== manifests[s.channel] || !/^sha256:[0-9a-f]{64}$/.test(s.digest))) throw fail('scope_not_allowed')
      return { kind: 'approve', action: s.action, artifact: s.artifact, version: s.version, digest: s.digest, channel: s.channel, packetSha256: s.packetSha256 }
    }
    throw fail('scope_not_allowed')
  }

  /** Verify the full packet before display AND again before signing. A packet is still only a request. */
  function validateHandoffPacket(h, nowMs) {
    return Promise.resolve().then(function () {
      var scope = scopeOf(h && h.scope), p = h && h.packet
      if (scope.kind === 'message') { if (p != null) throw fail('packet_mismatch'); return null }
      var keys = ['v', 'packetId', 'action', 'artifact', 'version', 'digest', 'channel', 'provider', 'sessionId', 'createdAt', 'exp']
      if (!isPlain(p) || Object.keys(p).length !== keys.length || keys.some(function (k) { return !Object.prototype.hasOwnProperty.call(p, k) })
        || p.v !== 'cos-web-packet/1' || !/^[A-Za-z0-9_-]{16}$/.test(p.packetId)
        || !Number.isSafeInteger(p.createdAt) || p.createdAt < 0 || !Number.isSafeInteger(p.exp) || p.exp <= p.createdAt || p.exp - p.createdAt > 1800000
        || p.provider !== h.provider || p.sessionId !== h.sessionId
        || ['action', 'artifact', 'version', 'digest', 'channel'].some(function (k) { return p[k] !== scope[k] })) throw fail('packet_mismatch')
      if (!Number.isSafeInteger(nowMs) || nowMs > p.exp || p.createdAt > nowMs + 60000) throw fail('packet_expired')
      return sha256(jcsBytes(p)).then(function (d) { if (hex(d) !== scope.packetSha256) throw fail('packet_mismatch'); return p })
    })
  }

  /**
   * The envelope object, from the handoff (what to say, to whom), the server's nonce answer (nonce,
   * aud, key epoch), the signer's kid, and THIS page's own origin. The origin is never taken from the
   * server or the handoff: a page on another origin cannot get a signature that names this one.
   */
  function buildEnvelope(f) {
    if (!f || typeof f !== 'object') throw fail('envelope_input_missing')
    var words = signedWords(f.words)
    if (!words.trim()) throw fail('words_empty')
    if (f.attachments && f.attachments.length) throw fail('attachments_not_signable')
    if (typeof f.origin !== 'string' || !/^https:\/\/[^/\s]+$/.test(f.origin)) throw fail('origin_invalid')
    if (typeof f.aud !== 'string' || !HEX64.test(f.aud)) throw fail('aud_invalid')
    if (typeof f.kid !== 'string' || f.kid.length !== 22) throw fail('kid_invalid')
    if (!Number.isSafeInteger(f.epoch) || f.epoch < 0) throw fail('epoch_invalid')
    if (typeof f.turnId !== 'string' || !TURN_ID.test(f.turnId)) throw fail('turn_id_invalid')
    if (typeof f.nonce !== 'string' || !NONCE.test(f.nonce)) throw fail('nonce_invalid')
    if (!PROVIDERS[f.provider]) throw fail('provider_invalid')
    if (typeof f.sessionId !== 'string' || !f.sessionId || f.sessionId.length > 128) throw fail('session_invalid')
    if (f.bindingId !== null && (typeof f.bindingId !== 'string' || !f.bindingId || f.bindingId.length > 128)) throw fail('binding_invalid')
    var nowS = Math.floor(Number(f.nowMs) / 1000)
    if (!Number.isSafeInteger(nowS) || nowS <= IAT_BACKDATE_S) throw fail('clock_invalid')
    var iat = nowS - IAT_BACKDATE_S
    var scope = scopeOf(f.scope)
    return wordsDigest(words).then(function (d) {
      return {
        words: words,
        envelope: {
          v: ENVELOPE_VERSION, aud: f.aud, origin: f.origin, kid: f.kid, kver: 1, epoch: f.epoch,
          turnId: f.turnId, nonce: f.nonce, iat: iat, exp: iat + ENVELOPE_LIFETIME_S,
          provider: f.provider, sessionId: f.sessionId, bindingId: f.bindingId,
          fork: false, wordsSha256: d.sha256, wordsLen: d.len, attachments: [], scope: scope,
        },
      }
    })
  }

  /** The raw passkey challenge for a turn: sha256 of the envelope's JCS bytes. clientDataJSON carries its base64url. */
  function passkeyChallenge(envelopeBytes) { return sha256(envelopeBytes) }

  function passkeyHeader(a) {
    var fields = ['credentialId', 'authenticatorData', 'clientDataJSON', 'signature']
    if (!a || fields.some(function (k) { return typeof a[k] !== 'string' || !a[k] || fromB64url(a[k]) === null })) throw fail('passkey_malformed')
    return b64url(jcsBytes({ v: PASSKEY_VERSION, credentialId: a.credentialId, authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature }))
  }

  /**
   * THE seam (an optional second signer type may plug in here later; the page signer is complete on its own). Build the envelope, sign its JCS bytes with the
   * device key, then ask for a user-verified passkey assertion over sha256 of those same bytes, in
   * that order. Returns what the turn route takes: the three headers and the body.
   *
   * input: { handoff, nonce: { nonce, aud, epoch }, signer, origin, nowMs }
   */
  function assembleTurnProof(input) {
    var h = input && input.handoff, n = input && input.nonce, signer = input && input.signer
    if (!h || !h.turn || !n || !signer || typeof signer.signEnvelope !== 'function' || typeof signer.assert !== 'function') return Promise.reject(fail('proof_input_missing'))
    var built
    return validateHandoffPacket(h, input.nowMs).then(function () {
      return buildEnvelope({
        words: h.words, attachments: h.attachments, origin: input.origin, aud: n.aud, kid: signer.kid, epoch: n.epoch,
        turnId: h.turn.clientTurnId, nonce: n.nonce, provider: h.provider, sessionId: h.sessionId,
        bindingId: h.bindingId == null ? null : h.bindingId, scope: h.scope, nowMs: input.nowMs,
      })
    }).then(function (b) {
      built = b
      built.bytes = jcsBytes(b.envelope)
      return signer.signEnvelope(built.bytes)
    }).then(function (sig) {
      var s = bytes(sig)
      if (s.length !== 64) throw fail('signature_not_p1363')
      built.signature = b64url(s)
      return passkeyChallenge(built.bytes)
    }).then(function (challenge) {
      built.challenge = challenge
      return signer.assert(challenge)
    }).then(function (assertion) {
      var body = { prompt: built.words, epoch: h.turn.epoch, targetKey: h.turn.targetKey, clientTurnId: h.turn.clientTurnId }
      if (h.turn.acknowledgedRevision) body.acknowledgedRevision = h.turn.acknowledgedRevision
      if (h.turn.boundTo) body.boundTo = h.turn.boundTo
      return {
        words: built.words,
        envelope: built.envelope,
        envelopeBytes: built.bytes,
        challenge: built.challenge,
        headers: {
          'x-cos-web-envelope': b64url(built.bytes),
          'x-cos-web-sig': built.signature,
          'x-cos-web-passkey': passkeyHeader(assertion),
        },
        body: body,
      }
    })
  }

  // ── enrollment math (review W3 commit-reveal; contract section 3) ──
  /** hex(sha256(r)): what the phone sends at start, before the server picks its challenge. */
  function sasCommit(r) { return sha256(r).then(hex) }
  /** The 6-digit code: uint32_be(sha256(challenge || spkiDer || r)[0:4]) mod 1_000_000, zero-padded. Computed here, on the phone. */
  function sasCode(challenge, spkiDer, r) {
    return sha256(concat(challenge, spkiDer, r)).then(function (d) {
      var n = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3]
      return String(n % 1000000).padStart(6, '0')
    })
  }
  function kidOf(spkiDer) { return sha256(spkiDer).then(function (d) { return b64url(d).slice(0, 22) }) }
  function fingerprintOf(spkiDer) {
    return sha256(spkiDer).then(function (d) {
      var h = hex(d).slice(0, 16).toUpperCase()
      return h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16)
    })
  }
  /** The proof-of-possession object (`cos-web-enroll/2`), exactly the server's WebKeyEnrollments.proofMessage. */
  function enrollProofMessage(p) {
    return {
      v: ENROLL_PROOF_VERSION, enrollId: p.enrollId, challenge: p.challenge, aud: p.aud, origin: p.origin, kid: p.kid,
      phoneNonce: p.phoneNonce, passkey_credential_id: p.passkeyCredentialId, passkey_spki_sha256: p.passkeySpkiSha256,
    }
  }

  // ── passkey public key: P-256 x and y, as COSE (what the server takes) and as SPKI (what it hashes) ──
  function spkiFromXY(x, y) { return concat(SPKI_P256_PREFIX, x, y) }
  function xyFromSpki(spki) {
    var b = bytes(spki)
    if (b.length !== SPKI_P256_PREFIX.length + 64) return null
    for (var i = 0; i < SPKI_P256_PREFIX.length; i++) if (b[i] !== SPKI_P256_PREFIX[i]) return null
    return { x: b.slice(27, 59), y: b.slice(59, 91) }
  }
  /** COSE_Key {1: 2, 3: -7, -1: 1, -2: x, -3: y}, CBOR. */
  function coseFromXY(x, y) {
    return concat([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20], x, [0x22, 0x58, 0x20], y)
  }

  // A minimal CBOR reader for the attestation object and the COSE key in it (maps, arrays, ints,
  // byte and text strings, simple values). Only used when the browser has no getPublicKey().
  function cborRead(b, pos) {
    if (pos >= b.length) throw fail('cbor')
    var ib = b[pos], major = ib >> 5, info = ib & 31, val, next = pos + 1
    if (info < 24) val = info
    else if (info === 24) { val = b[next]; next += 1 }
    else if (info === 25) { val = (b[next] << 8) | b[next + 1]; next += 2 }
    else if (info === 26) { val = ((b[next] << 24) >>> 0) + (b[next + 1] << 16) + (b[next + 2] << 8) + b[next + 3]; next += 4 }
    else throw fail('cbor')
    if (major === 0) return { value: val, next: next }
    if (major === 1) return { value: -1 - val, next: next }
    if (major === 2) { if (next + val > b.length) throw fail('cbor'); return { value: b.slice(next, next + val), next: next + val } }
    if (major === 3) { if (next + val > b.length) throw fail('cbor'); return { value: new root.TextDecoder().decode(b.slice(next, next + val)), next: next + val } }
    if (major === 4) { var arr = []; for (var i = 0; i < val; i++) { var e = cborRead(b, next); arr.push(e.value); next = e.next } return { value: arr, next: next } }
    if (major === 5) {
      var map = new Map()
      for (var j = 0; j < val; j++) { var k = cborRead(b, next); var v = cborRead(b, k.next); map.set(k.value, v.value); next = v.next }
      return { value: map, next: next }
    }
    if (major === 7) return { value: info === 21 ? true : info === 20 ? false : null, next: next }
    throw fail('cbor')
  }
  function xyFromCose(cose) {
    var m = cose instanceof Map ? cose : cborRead(bytes(cose), 0).value
    var x = m.get(-2), y = m.get(-3)
    if (m.get(1) !== 2 || m.get(3) !== -7 || m.get(-1) !== 1 || !x || !y || x.length !== 32 || y.length !== 32) return null
    return { x: bytes(x), y: bytes(y) }
  }
  /** The credential public key from a WebAuthn attestation object (fmt "none" or any other). */
  function xyFromAttestation(attestationObject) {
    var obj = cborRead(bytes(attestationObject), 0).value
    var auth = obj instanceof Map ? obj.get('authData') : null
    if (!auth || auth.length < 55) return null
    if ((auth[32] & 0x40) === 0) return null
    var credLen = (auth[53] << 8) | auth[54]
    var at = 55 + credLen
    if (at >= auth.length) return null
    return xyFromCose(cborRead(auth, at).value)
  }
  /** x and y from a registration response: getPublicKey() when the browser has it, else the attestation object. */
  function passkeyXY(response) {
    if (response && typeof response.getPublicKey === 'function') {
      var spki = response.getPublicKey()
      var xy = spki ? xyFromSpki(spki) : null
      if (xy) return xy
    }
    return response && response.attestationObject ? xyFromAttestation(response.attestationObject) : null
  }

  root.COSSignerProof = {
    ENVELOPE_LIFETIME_S: ENVELOPE_LIFETIME_S,
    IAT_BACKDATE_S: IAT_BACKDATE_S,
    b64url: b64url, fromB64url: fromB64url, hex: hex, sha256: sha256, utf8: utf8,
    canonicalJson: canonicalJson, jcsBytes: jcsBytes,
    signedWords: signedWords, wordsDigest: wordsDigest,
    buildEnvelope: buildEnvelope, passkeyChallenge: passkeyChallenge, passkeyHeader: passkeyHeader,
    assembleTurnProof: assembleTurnProof, validateHandoffPacket: validateHandoffPacket,
    sasCommit: sasCommit, sasCode: sasCode, kidOf: kidOf, fingerprintOf: fingerprintOf, enrollProofMessage: enrollProofMessage,
    spkiFromXY: spkiFromXY, xyFromSpki: xyFromSpki, coseFromXY: coseFromXY, xyFromCose: xyFromCose,
    xyFromAttestation: xyFromAttestation, passkeyXY: passkeyXY,
  }
})(typeof window !== 'undefined' ? window : globalThis)
