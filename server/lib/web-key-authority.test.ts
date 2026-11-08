// 6.99.31: server acceptance of a signed Control Web turn (plan §4.5). Every reject path, each
// against an envelope that is otherwise good (the accept case passes first, in the same rig), so
// each refusal is caused by exactly the one thing the test changes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestDigest, WebKeyAuthority, wordsDigest, type IntegrityReport, type WebKeyContext } from './web-key-authority.js'
import { WEB_ANCHOR_MATURITY_MS, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from './web-key-registry.js'
import { anchoredEntry, credentialIdOf, encodeEnvelope, envelopeFor, INTEGRITY_OK, MATURE_ANCHOR_SET_AT, ORIGIN, p256, passkeyHeaderFor, passkeyOf, seedRegistry, SELF_DNS, signJcs, type TestKey } from './__fixtures__/web-key-kit.js'
import { APPROVE_ACTION_CHANNELS, canonicalJson, MESSAGE_SCOPE_MEANING, notAuthorizedFor, parseWebTurnScope, type WebTurnEnvelope } from '../../shared/web-turn-envelope.js'
import { parseEnvelopeHeader, sha256Hex } from './web-key-envelope.js'

const NOW_S = 1_786_000_000
const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const WORDS = 'Yes install and proceed'
const REC = { turnId: 'turn-web-key-0001', target: { provider: 'claude', sessionId: SID } }

let dir: string
let anchor: TestKey
let phone: TestKey
let clock: number
let enabled: boolean
let registry: WebKeyRegistry
let nonces: WebKeyNonces
let packets: WebKeyPackets
let authority: WebKeyAuthority
let integrity: IntegrityReport | null

function build(entries = () => [anchoredEntry(anchor, phone)], epoch = 0): void {
  seedRegistry(join(dir, 'web-keys.json'), anchor, entries(), epoch)
  registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
  nonces = new WebKeyNonces(join(dir, 'nonces.json'), () => clock)
  packets = new WebKeyPackets(() => clock)
  authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => enabled, now: () => clock })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'web-key-auth-'))
  anchor = p256()
  phone = p256()
  clock = NOW_S * 1000
  enabled = true
  integrity = INTEGRITY_OK
  build()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ctx = (over: Partial<WebKeyContext> = {}): WebKeyContext => ({ provider: 'claude', sessionId: SID, turnId: 'turn-web-key-0001', words: WORDS, attachments: [], ...over })

function nonce(): string {
  const issued = nonces.issue()
  if (!issued.ok) throw new Error(issued.reason)
  return issued.nonce
}

function candidate(env: WebTurnEnvelope, opts: { signer?: TestKey; origin?: string | null; sig?: string | null; raw?: string; passkey?: string | null } = {}) {
  return {
    envelope: opts.raw ?? encodeEnvelope(env),
    signature: opts.sig === undefined ? signJcs(opts.signer ?? phone, env) : opts.sig,
    requestOrigin: opts.origin === undefined ? ORIGIN : opts.origin,
    passkey: opts.passkey === undefined ? passkeyHeaderFor(phone, env) : opts.passkey,
  }
}

function good(over: Partial<WebTurnEnvelope> & { words?: string; nowS?: number } = {}): WebTurnEnvelope {
  return envelopeFor(phone, anchor, { nonce: nonce(), nowS: NOW_S, ...over })
}

describe('accept: the good case', () => {
  it('vouches an envelope that matches everything, and returns a self-proving proof', () => {
    const env = good()
    const r = authority.accept(candidate(env), ctx())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.proof.kid).toBe(phone.kid)
    expect(r.proof.scope).toEqual({ kind: 'message' })
    expect(Buffer.from(r.proof.envelope, 'base64url').toString('utf8')).toBe(canonicalJson(env))
    expect(registry.list(SELF_DNS)[0].lastUsedAt).toBe(clock)
  })
})

describe('accept: every reject path', () => {
  it('flag off', () => {
    enabled = false
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'web_key_authority_off' })
  })
  it('wrong key: signed by a key that is not the enrolled one', () => {
    expect(authority.accept(candidate(good(), { signer: p256() }), ctx())).toEqual({ ok: false, reason: 'signature_invalid' })
  })
  it('wrong key: a kid nobody enrolled', () => {
    const other = p256()
    const env = envelopeFor(other, anchor, { nonce: nonce(), nowS: NOW_S })
    expect(authority.accept(candidate(env, { signer: other }), ctx())).toEqual({ ok: false, reason: 'key_unknown' })
  })
  it('wrong key: an entry whose anchorSig is not the anchor (a line written into web-keys.json)', () => {
    build(() => [anchoredEntry(p256(), phone)])
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'key_unanchored' })
  })
  it('revoked key', () => {
    registry.revoke(phone.kid, 'lost', 'web')
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'key_revoked' })
  })
  it('old epoch after revoke-all style bump (key re-anchored at the new epoch, envelope at the old)', () => {
    build(() => [anchoredEntry(anchor, phone, { epoch: 1 })], 1)
    expect(authority.accept(candidate(good({ epoch: 0 })), ctx())).toEqual({ ok: false, reason: 'epoch_stale' })
  })
  it('stale key version', () => {
    expect(authority.accept(candidate(good({ kver: 2 })), ctx())).toEqual({ ok: false, reason: 'key_version_stale' })
  })
  it('expired', () => {
    const env = good()
    clock = (env.exp + 1) * 1000
    expect(authority.accept(candidate(env), ctx())).toEqual({ ok: false, reason: 'signature_expired' })
  })
  it('lifetime over 15 minutes', () => {
    expect(authority.accept(candidate(good({ exp: NOW_S + 901 })), ctx())).toEqual({ ok: false, reason: 'lifetime_invalid' })
  })
  it('iat in the future beyond the 60 s skew; exactly 60 s is accepted', () => {
    expect(authority.accept(candidate(good({ iat: NOW_S + 61, exp: NOW_S + 600 })), ctx())).toEqual({ ok: false, reason: 'iat_in_future' })
    expect(authority.accept(candidate(good({ iat: NOW_S + 60, exp: NOW_S + 600 })), ctx()).ok).toBe(true)
  })
  it('replayed nonce: the same envelope twice', () => {
    const env = good()
    expect(authority.accept(candidate(env), ctx()).ok).toBe(true)
    expect(authority.accept(candidate(env), ctx())).toEqual({ ok: false, reason: 'nonce_spent' })
  })
  it('a nonce this server never issued', () => {
    expect(authority.accept(candidate(envelopeFor(phone, anchor, { nonce: 'z'.repeat(22), nowS: NOW_S })), ctx())).toEqual({ ok: false, reason: 'nonce_unknown' })
  })
  it('an expired nonce', () => {
    const env = good()
    clock += 15 * 60_000 + 1
    // The envelope itself is still in date (its own exp is later): only the nonce has lapsed.
    const late = { ...env, iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 60 }
    expect(authority.accept(candidate(late), ctx())).toEqual({ ok: false, reason: 'nonce_expired' })
  })
  it('a failing envelope does not burn its nonce', () => {
    const env = good()
    expect(authority.accept(candidate(env), ctx({ words: 'something else' })).ok).toBe(false)
    expect(authority.accept(candidate(env), ctx()).ok).toBe(true)
  })
  it('wrong aud', () => {
    expect(authority.accept(candidate(good({ aud: 'f'.repeat(64) })), ctx())).toEqual({ ok: false, reason: 'aud_mismatch' })
  })
  it('wrong origin in the envelope, or a request Origin that is not the signing origin (http never signs)', () => {
    expect(authority.accept(candidate(good({ origin: 'https://evil.example:3143' })), ctx())).toEqual({ ok: false, reason: 'origin_mismatch' })
    expect(authority.accept(candidate(good(), { origin: `http://${SELF_DNS}:3141` }), ctx())).toEqual({ ok: false, reason: 'origin_mismatch' })
    expect(authority.accept(candidate(good(), { origin: null }), ctx())).toEqual({ ok: false, reason: 'origin_mismatch' })
  })
  it('wrong destination: another session, another provider, another binding', () => {
    expect(authority.accept(candidate(good()), ctx({ sessionId: 'b7c1d2e3-1111-4222-8333-444455556666' }))).toEqual({ ok: false, reason: 'destination_mismatch' })
    expect(authority.accept(candidate(good()), ctx({ provider: 'codex' }))).toEqual({ ok: false, reason: 'destination_mismatch' })
    expect(authority.accept(candidate(good({ bindingId: 'bind-a' })), ctx({ bindingId: 'bind-b' }))).toEqual({ ok: false, reason: 'destination_mismatch' })
  })
  it('unknown destination (a new session) is never vouched', () => {
    expect(authority.accept(candidate(good()), ctx({ sessionId: null }))).toEqual({ ok: false, reason: 'destination_unbound' })
  })
  it('fork, either side', () => {
    expect(authority.accept(candidate(good({ fork: true })), ctx())).toEqual({ ok: false, reason: 'fork_destination_unbound' })
    expect(authority.accept(candidate(good()), ctx({ fork: true }))).toEqual({ ok: false, reason: 'fork_destination_unbound' })
  })
  it('another turn id', () => {
    expect(authority.accept(candidate(good()), ctx({ turnId: 'turn-web-key-0002' }))).toEqual({ ok: false, reason: 'turn_id_mismatch' })
  })
  it('changed words: one character, whitespace only, a trailing space (exact bytes, no collapsing)', () => {
    expect(authority.accept(candidate(good()), ctx({ words: 'Yes install and proceed!' }))).toEqual({ ok: false, reason: 'words_changed' })
    expect(authority.accept(candidate(good()), ctx({ words: 'Yes  install and proceed' }))).toEqual({ ok: false, reason: 'words_changed' })
    expect(authority.accept(candidate(good()), ctx({ words: `${WORDS} ` }))).toEqual({ ok: false, reason: 'words_changed' })
    // Same byte length, one letter different: the hash decides, not the length.
    expect(authority.accept(candidate(good()), ctx({ words: 'Yes install and proceeD' }))).toEqual({ ok: false, reason: 'words_changed' })
  })
  it('CRLF is the one normalization: signed with LF, received with CRLF, still the same words', () => {
    expect(authority.accept(candidate(good({ words: 'line one\nline two' })), ctx({ words: 'line one\r\nline two' })).ok).toBe(true)
  })
  it('changed files: another file, a changed hash, reordered, one dropped, unreadable', () => {
    const files = [{ id: 'm_a', sha256: 'a'.repeat(64), bytes: 10, name: 'a.png' }, { id: 'm_b', sha256: 'b'.repeat(64), bytes: 20, name: 'b.png' }]
    const manifest = files.map(f => ({ id: f.id, sha256: f.sha256 }))
    expect(authority.accept(candidate(good({ attachments: files })), ctx({ attachments: manifest })).ok).toBe(true)
    expect(authority.accept(candidate(good({ attachments: files })), ctx({ attachments: [manifest[0], { id: 'm_b', sha256: 'c'.repeat(64) }] }))).toEqual({ ok: false, reason: 'attachments_changed' })
    expect(authority.accept(candidate(good({ attachments: files })), ctx({ attachments: [manifest[1], manifest[0]] }))).toEqual({ ok: false, reason: 'attachments_changed' })
    expect(authority.accept(candidate(good({ attachments: files })), ctx({ attachments: [manifest[0]] }))).toEqual({ ok: false, reason: 'attachments_changed' })
    expect(authority.accept(candidate(good({ attachments: files })), ctx({ attachments: [manifest[0], { id: 'm_c', sha256: 'b'.repeat(64) }] }))).toEqual({ ok: false, reason: 'attachments_changed' })
    expect(authority.accept(candidate(good({ attachments: files })), ctx({ attachments: null }))).toEqual({ ok: false, reason: 'attachments_unsealable' })
  })
  it('out-of-list scope: never-list actions and unknown kinds have no spelling', () => {
    for (const scope of [
      { kind: 'approve', action: 'send-email', artifact: 'x', version: '1', digest: 'd', channel: 'c', packetSha256: 'a'.repeat(64) },
      { kind: 'approve', action: 'delete-data', artifact: 'x', version: '1', digest: 'd', channel: 'c', packetSha256: 'a'.repeat(64) },
      { kind: 'credentials' },
      { kind: 'message', action: 'install' },
      { kind: 'approve', action: 'install', artifact: 'x', version: '1', digest: 'd', channel: 'c', packetSha256: 'a'.repeat(64), money: 1 },
      // A never-list action with every other field valid: only the closed action list refuses it.
      { kind: 'approve', action: 'send-email', artifact: 'cos-control', version: '0.5.375', digest: `sha256:${'a'.repeat(64)}`, channel: 'mac-local', packetSha256: 'a'.repeat(64) },
      { kind: 'approve', action: 'toString', artifact: 'cos-control', version: '0.5.375', digest: `sha256:${'a'.repeat(64)}`, channel: 'mac-local', packetSha256: 'a'.repeat(64) },
      // Every field valid, plus one extra key: only the exact key set refuses it.
      { kind: 'approve', action: 'install', artifact: 'cos-control', version: '0.5.375', digest: `sha256:${'a'.repeat(64)}`, channel: 'mac-local', packetSha256: 'a'.repeat(64), money: 1 },
    ]) {
      const env = { ...good(), scope } as unknown as WebTurnEnvelope
      expect(authority.accept(candidate(env), ctx())).toEqual({ ok: false, reason: 'scope_not_allowed' })
    }
  })
  it('unknown envelope version, unknown key, non-canonical bytes, missing signature', () => {
    expect(authority.accept(candidate({ ...good(), v: 'cos-web-turn/2' } as unknown as WebTurnEnvelope), ctx())).toEqual({ ok: false, reason: 'envelope_version_unknown' })
    expect(authority.accept(candidate({ ...good(), extra: 1 } as unknown as WebTurnEnvelope), ctx())).toEqual({ ok: false, reason: 'envelope_malformed' })
    const env = good()
    const pretty = Buffer.from(JSON.stringify(env, null, 1), 'utf8').toString('base64url')
    expect(authority.accept(candidate(env, { raw: pretty }), ctx())).toEqual({ ok: false, reason: 'envelope_not_canonical' })
    expect(authority.accept(candidate(good(), { sig: null }), ctx())).toEqual({ ok: false, reason: 'signature_missing' })
  })
  it('no anchor registered, or the MagicDNS name unknown: nothing is vouched', () => {
    seedRegistry(join(dir, 'web-keys.json'), null, [anchoredEntry(anchor, phone)])
    registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'anchor_not_registered' })
    build()
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => null, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'aud_unavailable' })
  })
  it('an unreadable registry or nonce store fails closed', () => {
    writeFileSync(join(dir, 'web-keys.json'), '{not json')
    registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    expect(registry.unreadable).toBe(true)
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'anchor_not_registered' })
    build()
    const env = good()
    writeFileSync(join(dir, 'nonces.json'), '{not json')
    nonces = new WebKeyNonces(join(dir, 'nonces.json'), () => clock)
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(authority.accept(candidate(env), ctx())).toEqual({ ok: false, reason: 'nonce_store_unavailable' })
  })
  it('a spent nonce stays spent across a restart (durable store)', () => {
    const env = good()
    expect(authority.accept(candidate(env), ctx()).ok).toBe(true)
    nonces = new WebKeyNonces(join(dir, 'nonces.json'), () => clock)
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(authority.accept(candidate(env), ctx())).toEqual({ ok: false, reason: 'nonce_spent' })
  })
})

describe('approve scope: an exact open packet', () => {
  const CHANNEL: Record<string, string> = { install: 'mac-local', publish: 'npm-next', 'push-main': 'git-main' }
  function packet(action = 'install', channel?: string, creator?: { provider: string; sessionId: string }) {
    const made = packets.create({ action, artifact: '@gotcos/glasses-server', version: '6.99.31', digest: `sha512:${'a'.repeat(128)}`, channel: channel ?? CHANNEL[action] }, creator ?? { provider: 'claude', sessionId: SID })
    if (!made.ok) throw new Error(made.reason)
    return made
  }
  const scopeOf = (p: ReturnType<typeof packet>) => ({ kind: 'approve' as const, action: p.packet.action, artifact: p.packet.artifact, version: p.packet.version, digest: p.packet.digest, channel: p.packet.channel, packetSha256: p.packetSha256 })

  it('install against the packet the session posted is vouched, once', () => {
    const p = packet()
    const env = good({ scope: scopeOf(p) })
    expect(authority.accept(candidate(env), ctx()).ok).toBe(true)
    // The packet is closed: a second envelope naming it finds nothing.
    expect(authority.accept(candidate(good({ scope: scopeOf(p) })), ctx())).toEqual({ ok: false, reason: 'packet_unknown' })
  })
  it('an altered version, artifact or channel is refused', () => {
    const p = packet()
    expect(authority.accept(candidate(good({ scope: { ...scopeOf(p), version: '6.99.32' } })), ctx())).toEqual({ ok: false, reason: 'packet_mismatch' })
    expect(authority.accept(candidate(good({ scope: { ...scopeOf(p), artifact: 'cos-control' } })), ctx())).toEqual({ ok: false, reason: 'packet_mismatch' })
    const pub = packet('publish', 'npm-next')
    expect(authority.accept(candidate(good({ scope: { ...scopeOf(pub), channel: 'npm-latest' } })), ctx())).toEqual({ ok: false, reason: 'packet_mismatch' })
    expect(authority.accept(candidate(good({ scope: { ...scopeOf(p), packetSha256: 'e'.repeat(64) } })), ctx())).toEqual({ ok: false, reason: 'packet_unknown' })
  })
  it('W10 packet not created by the receiving session: an approve for another session\'s packet is refused', () => {
    const p = packet()
    const other = 'b7c1d2e3-1111-4222-8333-444455556666'
    expect(authority.accept(candidate(good({ scope: scopeOf(p), sessionId: other })), ctx({ sessionId: other }))).toEqual({ ok: false, reason: 'packet_session_mismatch' })
    const codexPacket = packet('install', undefined, { provider: 'codex', sessionId: SID })
    expect(authority.accept(candidate(good({ scope: scopeOf(codexPacket) })), ctx())).toEqual({ ok: false, reason: 'packet_session_mismatch' })
  })
  it('scoped publish is enabled; push-main is still refused', () => {
    expect(authority.accept(candidate(good({ scope: scopeOf(packet('publish')) })), ctx()).ok).toBe(true)
    expect(authority.accept(candidate(good({ scope: scopeOf(packet('push-main')) })), ctx())).toEqual({ ok: false, reason: 'approve_action_not_enabled' })
  })
  it.each(['npm-next', 'npm-latest', 'control-appcast', 'hub-alias', 'gotcos-site', 'control-downloads', 'release-docs'])('publish %s is exact, user-verified and one-shot', channel => {
    const artifacts: Record<string, string> = { 'gotcos-site': 'gotcos-site-manifest', 'control-downloads': 'cos-control-downloads-manifest', 'release-docs': 'cos-release-docs-manifest' }
    const p = packets.create({ action: 'publish', artifact: artifacts[channel] ?? '@gotcos/glasses-server', version: '7.0.6', digest: `sha256:${'a'.repeat(64)}`, channel }, { provider: 'claude', sessionId: SID })
    if (!p.ok) throw new Error(p.reason)
    const env = good({ scope: scopeOf(p) })
    // Cookie/token possession without the passkey, or an assertion denied user verification, confers no approval.
    expect(authority.accept(candidate(env, { passkey: null }), ctx())).toEqual({ ok: false, reason: 'passkey_missing' })
    expect(authority.accept(candidate(env, { passkey: passkeyHeaderFor(phone, env, { flags: 1 }) }), ctx())).toEqual({ ok: false, reason: 'passkey_not_user_verified' })
    expect(packets.get(p.packetSha256)).not.toBeNull()
    expect(authority.accept(candidate(env), ctx()).ok).toBe(true)
    expect(packets.get(p.packetSha256)).toBeNull()
    expect(authority.accept(candidate(env), ctx()).ok).toBe(false)
  })
  it('a changed artifact digest and an expired packet cannot be approved', () => {
    const p = packet('publish')
    expect(authority.accept(candidate(good({ scope: { ...scopeOf(p), digest: `sha256:${'b'.repeat(64)}` } })), ctx())).toEqual({ ok: false, reason: 'packet_mismatch' })
    clock += 1800001
    expect(authority.accept(candidate(good({ nowS: Math.floor(clock / 1000), scope: scopeOf(p) })), ctx())).toEqual({ ok: false, reason: 'packet_unknown' })
  })
  it('a packet naming any never-list action is refused at creation', () => {
    for (const action of ['send-email', 'delete', 'move-money', 'credentials', 'security-settings', 'permission-prompt', 'INSTALL']) {
      expect(packets.create({ action, artifact: 'a', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, channel: 'mac-local' }, { provider: 'claude', sessionId: SID })).toEqual({ ok: false, reason: 'action_not_allowed' })
    }
  })
})

describe('recheck at a queue drain', () => {
  function accepted() {
    const r = authority.accept(candidate(good()), ctx())
    if (!r.ok) throw new Error(r.reason)
    return r.proof
  }
  it('holds while in date, enrolled and unchanged', () => {
    expect(authority.recheck(accepted(), WORDS, '')).toBeNull()
  })
  it('expired by the drain: never re-dated', () => {
    const proof = accepted()
    clock = (proof.exp + 1) * 1000
    expect(authority.recheck(proof, WORDS, '')).toBe('signature_expired')
  })
  it('revoked before the drain', () => {
    const proof = accepted()
    registry.revoke(phone.kid, 'lost', 'token')
    expect(authority.recheck(proof, WORDS, '')).toBe('key_revoked')
  })
  it('revoke-all before the drain', () => {
    const proof = accepted()
    registry.revokeAll('web')
    expect(authority.recheck(proof, WORDS, '')).toBe('key_revoked')
  })
  it('the words in the queue file changed (whitespace too)', () => {
    expect(authority.recheck(accepted(), `${WORDS}\n`, '')).toBe('words_changed')
  })
  it('the flag turned off', () => {
    const proof = accepted()
    enabled = false
    expect(authority.recheck(proof, WORDS, '')).toBe('web_key_authority_off')
  })
  it('review (the endpoint re-verify) also refuses with the flag off, and verifies with it on', () => {
    const proof = accepted()
    expect(authority.review(proof, REC).reason).toBeNull()
    enabled = false
    expect(authority.review(proof, REC)).toEqual({ reason: 'web_key_authority_off', entry: null, facts: null })
  })
})

describe('stored proof cannot bypass current approval boundaries', () => {
  function proofFor(env: WebTurnEnvelope) {
    const r = authority.accept(candidate(good()), ctx())
    if (!r.ok) throw new Error(r.reason)
    const signature = signJcs(phone, env)
    return { ...r.proof, envelope: encodeEnvelope(env), signature, authId: sha256Hex(Buffer.from(signature, 'base64url')), scope: env.scope,
      provider: env.provider, sessionId: env.sessionId, wordsSha256: env.wordsSha256, iat: env.iat, exp: env.exp, passkey: JSON.parse(Buffer.from(passkeyHeaderFor(phone, env), 'base64url').toString('utf8')) }
  }
  it.each([
    [{ aud: 'f'.repeat(64) }, 'aud_mismatch'],
    [{ origin: 'https://other.example:3144' }, 'origin_mismatch'],
    [{ fork: true }, 'fork_destination_unbound'],
    [{ iat: NOW_S - 1000, exp: NOW_S - 1 }, 'lifetime_invalid'],
    [{ iat: NOW_S - 700, exp: NOW_S - 1 }, 'signature_expired'],
    [{ iat: NOW_S + 61, exp: NOW_S + 600 }, 'iat_in_future'],
    [{ scope: { kind: 'approve', action: 'push-main', artifact: 'cos-server', version: '7.0.6', digest: 'sha256:' + 'a'.repeat(64), channel: 'git-main', packetSha256: 'b'.repeat(64) } }, 'approve_action_not_enabled'],
  ] as Array<[Partial<WebTurnEnvelope>, string]>)('a genuine signature with invalid boundary %j refuses', (over, reason) => {
    const env = good(over)
    expect(authority.review(proofFor(env), REC).reason).toBe(reason)
  })
})

describe('wire format', () => {
  it('wordsDigest is sha256 of the exact UTF-8 with CRLF to LF only', () => {
    expect(wordsDigest('a\r\nb ')).toEqual({ sha256: wordsDigest('a\nb ').sha256, len: 4 })
    expect(wordsDigest('é').len).toBe(2)
  })
  it('JCS golden: sorted keys, no whitespace, escapes as JSON.stringify (shared with the Python verifier)', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x"\n\u2028é'], A: { z: 0 } })).toBe('{"A":{"z":0},"a":[true,null,"x\\"\\n\u2028é"],"b":1}')
    expect(() => canonicalJson({ a: 1.5 })).toThrow()
    expect(() => canonicalJson({ a: '\ud800' })).toThrow()
  })
  it('parseEnvelopeHeader refuses garbage, oversize and padded base64', () => {
    expect(parseEnvelopeHeader('!!!').ok).toBe(false)
    expect(parseEnvelopeHeader('a'.repeat(20_000)).ok).toBe(false)
    expect(parseEnvelopeHeader(`${encodeEnvelope(good())}=`).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Review fixes (qa_6.99.30_plan_review.md): each case is otherwise the good case, so each refusal
// is caused by exactly the one thing it changes. W10's negative matrix names are in the titles.
// ---------------------------------------------------------------------------------------------

describe('B1 anchor bootstrap: a key in web-keys.json alone is not an anchor', () => {
  it('W10 anchor swap: an anchorPub written into the file without its registration record vouches nothing', () => {
    seedRegistry(join(dir, 'web-keys.json'), anchor, [anchoredEntry(anchor, phone)], 0, { registration: false })
    registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(registry.anchor()).toBeNull()
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'anchor_unregistered' })
  })
  it('a registration record self-signed by ANOTHER key does not register this anchorPub', () => {
    const attacker = p256()
    seedRegistry(join(dir, 'web-keys.json'), attacker, [anchoredEntry(anchor, phone)])
    const raw = JSON.parse(readFileSync(join(dir, 'web-keys.json'), 'utf8'))
    raw.anchorPub = anchor.spki
    writeFileSync(join(dir, 'web-keys.json'), JSON.stringify(raw))
    registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    expect(registry.anchorRefusal()).toBe('anchor_unregistered')
  })
  it('a new anchor vouches nothing for 24 hours; at exactly 24 hours it does', () => {
    build(() => [anchoredEntry(anchor, phone)])
    seedRegistry(join(dir, 'web-keys.json'), anchor, [anchoredEntry(anchor, phone)], 0, { setAt: clock - WEB_ANCHOR_MATURITY_MS + 1 })
    registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'anchor_too_new' })
    clock += 1
    expect(authority.accept(candidate(good()), ctx()).ok).toBe(true)
  })
  it('the maturity constant is 24 hours and the kit seeds a mature anchor', () => {
    expect(WEB_ANCHOR_MATURITY_MS).toBe(86_400_000)
    expect(NOW_S * 1000 - MATURE_ANCHOR_SET_AT).toBeGreaterThan(WEB_ANCHOR_MATURITY_MS)
  })
})

describe('B2 passkey: a user-verified WebAuthn assertion over sha256(envelope JCS) on every vouched turn', () => {
  const pk = (env: WebTurnEnvelope, opts: Parameters<typeof passkeyHeaderFor>[2]) => candidate(env, { passkey: passkeyHeaderFor(phone, env, opts) })
  it('no assertion, no vouch', () => {
    expect(authority.accept(candidate(good(), { passkey: null }), ctx())).toEqual({ ok: false, reason: 'passkey_missing' })
  })
  it('garbage or a non-canonical header', () => {
    expect(authority.accept(candidate(good(), { passkey: 'not-a-header' }), ctx())).toEqual({ ok: false, reason: 'passkey_malformed' })
    const env = good()
    const pretty = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(passkeyHeaderFor(phone, env), 'base64url').toString('utf8')), null, 1)).toString('base64url')
    expect(authority.accept(candidate(env, { passkey: pretty }), ctx())).toEqual({ ok: false, reason: 'passkey_malformed' })
  })
  it('another credential id than the anchored one', () => {
    expect(authority.accept(pk(good(), { credentialId: 'cred-other' }), ctx())).toEqual({ ok: false, reason: 'passkey_credential_mismatch' })
  })
  it('an assertion made for another envelope (challenge mismatch)', () => {
    const env = good()
    const other = { ...env, wordsLen: env.wordsLen + 1 }
    expect(authority.accept(candidate(env, { passkey: passkeyHeaderFor(phone, other) }), ctx())).toEqual({ ok: false, reason: 'passkey_challenge_mismatch' })
  })
  it('exact origin including the port: an assertion from the 3143 app origin is refused (rpId alone is port-agnostic)', () => {
    expect(authority.accept(pk(good(), { origin: `https://${SELF_DNS}:3143` }), ctx())).toEqual({ ok: false, reason: 'passkey_origin_mismatch' })
    expect(authority.accept(pk(good(), { crossOrigin: true }), ctx())).toEqual({ ok: false, reason: 'passkey_origin_mismatch' })
  })
  it('rpIdHash must be sha256 of the full ts.net host', () => {
    expect(authority.accept(pk(good(), { rpId: 'ts.net' }), ctx())).toEqual({ ok: false, reason: 'passkey_rpid_mismatch' })
  })
  it('UP and UV flags both required', () => {
    expect(authority.accept(pk(good(), { flags: 0x01 }), ctx())).toEqual({ ok: false, reason: 'passkey_not_user_verified' })
    expect(authority.accept(pk(good(), { flags: 0x04 }), ctx())).toEqual({ ok: false, reason: 'passkey_not_user_verified' })
  })
  it('type must be webauthn.get', () => {
    expect(authority.accept(pk(good(), { type: 'webauthn.create' }), ctx())).toEqual({ ok: false, reason: 'passkey_type_invalid' })
  })
  it('signed by a passkey that is not the anchored one', () => {
    expect(authority.accept(pk(good(), { passkey: p256() }), ctx())).toEqual({ ok: false, reason: 'passkey_invalid' })
  })
  it('an entry whose passkeySpki does not match the anchored hash is unanchored', () => {
    const e = anchoredEntry(anchor, phone)
    build(() => [{ ...e, passkeySpki: p256().spki }])
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'key_unanchored' })
  })
  it('the accepted proof carries the assertion (self-proving for the verifier)', () => {
    const r = authority.accept(candidate(good()), ctx())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.proof.passkey.credentialId).toBe(credentialIdOf(phone))
    expect(passkeyOf(phone)).toBe(passkeyOf(phone))
  })
})

describe('W1 integrity: authority on with integrity off or failing vouches nothing', () => {
  it('canary 8 / W10 integrity-off downgrade: integrity not running (COS_WEB_CONTROL_INTEGRITY=0)', () => {
    integrity = null
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'integrity_off' })
    integrity = { ...INTEGRITY_OK, enabled: false }
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'integrity_off' })
  })
  it('integrity on but its last check failed', () => {
    integrity = { ...INTEGRITY_OK, lastCheckOk: false }
    expect(authority.accept(candidate(good()), ctx())).toEqual({ ok: false, reason: 'integrity_failed' })
  })
  it('the proof records integrity at accept, and the drain re-check refuses once it fails', () => {
    const r = authority.accept(candidate(good()), ctx())
    if (!r.ok) throw new Error(r.reason)
    expect(r.proof.integrity).toEqual(INTEGRITY_OK)
    integrity = { ...INTEGRITY_OK, lastCheckOk: false }
    expect(authority.recheck(r.proof, WORDS, '')).toBe('integrity_failed')
    expect(authority.review(r.proof, REC).reason).toBe('integrity_failed')
  })
})

describe('B3 the turn answer compares the ledger record with the envelope (record relabelling)', () => {
  function accepted() {
    const r = authority.accept(candidate(good()), ctx())
    if (!r.ok) throw new Error(r.reason)
    return r.proof
  }
  it('canary 10 / W10 record relabel: another target session, provider or turn id', () => {
    const proof = accepted()
    expect(authority.review(proof, REC).reason).toBeNull()
    expect(authority.review(proof, { ...REC, target: { provider: 'claude', sessionId: 'b7c1d2e3-1111-4222-8333-444455556666' } }).reason).toBe('record_envelope_mismatch')
    expect(authority.review(proof, { ...REC, target: { provider: 'codex', sessionId: SID } }).reason).toBe('record_envelope_mismatch')
    expect(authority.review(proof, { ...REC, turnId: 'turn-web-key-0002' }).reason).toBe('record_envelope_mismatch')
  })
  it('a copied proof field that differs from the envelope (words hash, session, authId, scope)', () => {
    const proof = accepted()
    expect(authority.review({ ...proof, wordsSha256: 'f'.repeat(64) }, REC).reason).toBe('record_envelope_mismatch')
    expect(authority.review({ ...proof, sessionId: 'x' }, REC).reason).toBe('record_envelope_mismatch')
    expect(authority.review({ ...proof, authId: 'f'.repeat(64) }, REC).reason).toBe('record_envelope_mismatch')
    expect(authority.review({ ...proof, scope: { kind: 'approve', action: 'install', artifact: 'a', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, channel: 'mac-local', packetSha256: 'a'.repeat(64) } }, REC).reason).toBe('record_envelope_mismatch')
  })
  it('the answer exposes the anchor fingerprint and age, epoch, revocations, integrity and both consume keys', () => {
    const proof = accepted()
    const facts = authority.review(proof, REC).facts as Record<string, any>
    expect(facts.anchor).toMatchObject({ spkiSha256: sha256Hex(anchor.der), mature: true, setAt: MATURE_ANCHOR_SET_AT, ageMs: clock - MATURE_ANCHOR_SET_AT })
    expect(facts.anchor.fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/)
    expect(facts.epoch).toBe(0)
    expect(facts.revoked).toEqual([])
    expect(facts.integrity).toEqual(INTEGRITY_OK)
    expect(facts.integrityAtAccept).toEqual(INTEGRITY_OK)
    expect(facts.consumeKeys).toEqual([`turn:${REC.turnId}`, `web:${facts.aud}:${proof.authId}`])
  })
  it('a stored proof without its passkey (an older or edited record) never re-verifies', () => {
    const { passkey: _p, ...rest } = accepted()
    expect(authority.review(rest as never, REC).reason).toBe('passkey_missing')
  })
})

describe('drain re-check compares the parked files too (review note)', () => {
  it('the seal\'s manifest digest must equal the signed manifest', () => {
    const files = [{ id: 'm_a', sha256: 'a'.repeat(64), bytes: 10, name: 'a.png' }]
    const r = authority.accept(candidate(good({ attachments: files })), ctx({ attachments: [{ id: 'm_a', sha256: 'a'.repeat(64) }] }))
    if (!r.ok) throw new Error(r.reason)
    expect(authority.recheck(r.proof, WORDS, manifestDigest([{ id: 'm_a', sha256: 'a'.repeat(64) }]))).toBeNull()
    expect(authority.recheck(r.proof, WORDS, manifestDigest([{ id: 'm_a', sha256: 'b'.repeat(64) }]))).toBe('attachments_changed')
    expect(authority.recheck(r.proof, WORDS, '')).toBe('attachments_changed')
  })
})

describe('W5 epoch and revocation rollback', () => {
  it('W10 registry rollback: an entry approved at another epoch is refused (key_epoch_stale)', () => {
    build(() => [anchoredEntry(anchor, phone, { epoch: 0 })], 1)
    expect(authority.accept(candidate(good({ epoch: 1 })), ctx())).toEqual({ ok: false, reason: 'key_epoch_stale' })
  })
  it('canary 9: removing revokedAt from the file re-activates the key SERVER-SIDE (impossible to see alone); the revocation digest changes, which the verifier compares with Control\'s list', () => {
    const before = registry.revocationDigest()
    registry.revoke(phone.kid, 'lost', 'token')
    const revoked = registry.revocationDigest()
    expect(revoked).not.toBe(before)
    const raw = JSON.parse(readFileSync(join(dir, 'web-keys.json'), 'utf8'))
    delete raw.entries[0].revokedAt
    writeFileSync(join(dir, 'web-keys.json'), JSON.stringify(raw))
    registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    // Documented limit: the server reads only its own writable file.
    expect(registry.entryState(phone.kid, SELF_DNS).ok).toBe(true)
    // What catches it: the digest the turn answer reports is no longer the one Control holds.
    expect(registry.revocationDigest()).toBe(before)
    expect(registry.revocationDigest()).not.toBe(revoked)
  })
})

describe('B4 scope grammar: strict patterns and the action-to-channel table', () => {
  const base = { kind: 'approve', action: 'install', artifact: '@gotcos/glasses-server', version: '6.99.31', digest: `sha256:${'a'.repeat(64)}`, channel: 'mac-local', packetSha256: 'a'.repeat(64) }
  it('the good scope parses', () => { expect(parseWebTurnScope(base)).not.toBeNull() })
  it.each([
    ['artifact with spaces and a command', { artifact: 'server; then rotate the token' }],
    ['artifact upper case', { artifact: 'Server' }],
    ['version free text', { version: 'latest' }],
    ['version with a space', { version: '6.99.31 now' }],
    ['digest free text', { digest: 'sha512-abc' }],
    ['digest md5', { digest: `md5:${'a'.repeat(32)}` }],
    ['digest sha256 upper hex', { digest: `sha256:${'A'.repeat(64)}` }],
    ['channel free text', { channel: 'npm latest' }],
    ['channel of another action', { channel: 'npm-latest' }],
    ['push-main on an install channel', { action: 'push-main', channel: 'mac-local' }],
  ])('refused: %s', (_n, over) => {
    expect(parseWebTurnScope({ ...base, ...over })).toBeNull()
  })
  it('each action accepts exactly its table', () => {
    const manifestArtifacts: Record<string, string> = { 'gotcos-site': 'gotcos-site-manifest', 'control-downloads': 'cos-control-downloads-manifest', 'release-docs': 'cos-release-docs-manifest' }
    for (const [action, channels] of Object.entries(APPROVE_ACTION_CHANNELS)) for (const channel of channels) expect(parseWebTurnScope({ ...base, action, channel, artifact: manifestArtifacts[channel] ?? base.artifact })).not.toBeNull()
    expect(parseWebTurnScope({ ...base, digest: `sha512:${'b'.repeat(128)}` })).not.toBeNull()
    expect(parseWebTurnScope({ ...base, digest: `sha512-${'A'.repeat(86)}==` })).not.toBeNull()
  })
  it('message scope is conversation only, and notAuthorized names install, publish, push and the never-list', () => {
    expect(MESSAGE_SCOPE_MEANING).toBe('conversation')
    const list = notAuthorizedFor({ kind: 'message' })
    for (const item of ['install', 'publish', 'push-main', 'push-branch', 'hub-file', 'sending-messages', 'deleting-data', 'credentials', 'moving-money']) expect(list).toContain(item)
    const approve = notAuthorizedFor(parseWebTurnScope(base)!)
    expect(approve).toContain('publish')
    expect(approve).not.toContain('install')
  })
  it('packets: session only from the request context, strict fields at creation', () => {
    const good = { action: 'install', artifact: 'cos-control', version: '0.5.375', digest: `sha256:${'a'.repeat(64)}`, channel: 'mac-local' }
    expect(packets.create({ ...good, sessionId: SID }, { provider: 'claude', sessionId: SID })).toEqual({ ok: false, reason: 'session_from_context_only' })
    expect(packets.create({ ...good, provider: 'claude' }, { provider: 'claude', sessionId: SID })).toEqual({ ok: false, reason: 'session_from_context_only' })
    expect(packets.create(good, null)).toEqual({ ok: false, reason: 'creator_unknown' })
    expect(packets.create(good, { provider: 'claude', sessionId: '' })).toEqual({ ok: false, reason: 'creator_unknown' })
    expect(packets.create({ ...good, channel: 'npm-latest' }, { provider: 'claude', sessionId: SID })).toEqual({ ok: false, reason: 'invalid_packet' })
    expect(packets.create({ ...good, digest: 'whatever' }, { provider: 'claude', sessionId: SID })).toEqual({ ok: false, reason: 'invalid_packet' })
    const made = packets.create(good, { provider: 'codex', sessionId: 'sess-1' })
    expect(made.ok && made.packet.sessionId).toBe('sess-1')
    expect(made.ok && made.packet.provider).toBe('codex')
  })
})

describe('review (turn answer) re-checks anchor, passkey and integrity-at-accept', () => {
  function accepted() {
    const r = authority.accept(candidate(good()), ctx())
    if (!r.ok) throw new Error(r.reason)
    return r.proof
  }
  it('an anchor replaced in the file without its record, or one too new, re-verifies nothing', () => {
    const proof = accepted()
    seedRegistry(join(dir, 'web-keys.json'), anchor, [anchoredEntry(anchor, phone)], 0, { registration: false })
    registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(authority.review(proof, REC).reason).toBe('anchor_unregistered')
    seedRegistry(join(dir, 'web-keys.json'), anchor, [anchoredEntry(anchor, phone)], 0, { setAt: clock - 1000 })
    registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    authority = new WebKeyAuthority({ registry, nonces, packets, integrity: () => integrity, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => clock })
    expect(authority.review(proof, REC).reason).toBe('anchor_too_new')
  })
  it('a stored assertion swapped for one by another passkey is refused', () => {
    const proof = accepted()
    const env = JSON.parse(Buffer.from(proof.envelope, 'base64url').toString('utf8'))
    const forged = JSON.parse(Buffer.from(passkeyHeaderFor(phone, env, { passkey: p256() }), 'base64url').toString('utf8'))
    const { v: _v, ...assertion } = forged
    expect(authority.review({ ...proof, passkey: assertion }, REC).reason).toBe('passkey_invalid')
  })
  it('a stored proof that says integrity was off at accept never re-verifies, even if it passes now', () => {
    const proof = accepted()
    expect(authority.review({ ...proof, integrity: { ...INTEGRITY_OK, enabled: false } }, REC).reason).toBe('integrity_off')
    expect(authority.review({ ...proof, integrity: { ...INTEGRITY_OK, lastCheckOk: false } }, REC).reason).toBe('integrity_off')
  })
})

describe('words ending in whitespace (the footer step trims them, so they could never verify)', () => {
  it('signed words that end in a space or newline are refused; inner whitespace is kept exact', () => {
    expect(authority.accept(candidate(good({ words: `${WORDS} ` })), ctx({ words: `${WORDS} ` }))).toEqual({ ok: false, reason: 'words_trailing_whitespace' })
    expect(authority.accept(candidate(good({ words: `${WORDS}\n` })), ctx({ words: `${WORDS}\r\n` }))).toEqual({ ok: false, reason: 'words_trailing_whitespace' })
    expect(authority.accept(candidate(good({ words: 'a  b\n\nc' })), ctx({ words: 'a  b\n\nc' })).ok).toBe(true)
  })
})
