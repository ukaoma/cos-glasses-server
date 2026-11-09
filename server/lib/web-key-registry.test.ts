// 6.99.31: the enrolled phone key registry and ceremony (plan §4.3, §4.7). Real keys, real
// signatures. The anchor stands for COS Control's Secure Enclave key (Touch ID); the test signs
// with a software key, which is exactly what the server can and cannot tell apart: nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { audOf, deviceAllowlistFrom, sasOf, WEB_ANCHOR_MATURITY_MS, WEB_ENROLL_MAX_PROOF_ATTEMPTS, WEB_ENROLL_TTL_MS, WebKeyEnrollments, WebKeyNonces, WebKeyRegistry, WEB_NONCE_MAX_OUTSTANDING } from './web-key-registry.js'
import { anchoredEntry, anchorRegistrationBody, coseOf, credentialIdOf, ORIGIN, p256, passkeyAssertion, passkeyOf, seedRegistry, SELF_DNS, signB64, signJcs, type TestKey } from './__fixtures__/web-key-kit.js'
import { canonicalBytes, fingerprintOfSpki, sha256Hex } from './web-key-envelope.js'
import { coseP256ToSpki } from './web-key-passkey.js'

let dir: string
let anchor: TestKey
let clock: number
let registry: WebKeyRegistry
let enroll: WebKeyEnrollments
const file = () => join(dir, 'web-keys.json')

function open(): void {
  registry = new WebKeyRegistry(file(), join(dir, 'audit.jsonl'), () => clock)
  enroll = new WebKeyEnrollments(registry, { now: () => clock, deviceAllowed: (r) => r === DEVICE })
}
const DEVICE = '100.64.0.9'
// The phone's SAS nonce r: committed (sha256) at start, revealed at prove (review W3).
const nonceR = new WeakMap<TestKey, Buffer>()
const rOf = (phone: TestKey): Buffer => { let r = nonceR.get(phone); if (!r) { r = randomBytes(32); nonceR.set(phone, r) } return r }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'web-key-reg-'))
  anchor = p256()
  clock = 1_786_000_000_000
  seedRegistry(file(), anchor)
  open()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ctx = { selfDnsName: SELF_DNS, origin: ORIGIN }
const startFor = (phone: TestKey, extra: Record<string, unknown> = {}) => enroll.start({ spki: phone.spki, label: 'iPhone Duo', userAgent: 'Safari', remote: DEVICE, sasCommit: sha256Hex(rOf(phone)), ...extra }, ctx)

type Started = { enrollId: string; challenge: string; aud: string; origin: string; kid: string }
/** Proof of possession as the signer page makes it: phone-key signature, r revealed, passkey assertion over the proof bytes. */
function proveFor(phone: TestKey, started: Started, opts: { signer?: TestKey; msg?: Partial<Started>; r?: Buffer; passkey?: TestKey; assertionPasskey?: TestKey; flags?: number; origin?: string; cose?: string } = {}) {
  const passkey = opts.passkey ?? passkeyOf(phone)
  const r = opts.r ?? rOf(phone)
  const m = { ...started, ...opts.msg }
  const msg = WebKeyEnrollments.proofMessage({ ...m, phoneNonce: r.toString('base64url'), passkeyCredentialId: credentialIdOf(phone), passkeySpkiSha256: sha256Hex(passkey.der) })
  const challenge = createHash('sha256').update(canonicalBytes(msg)!).digest()
  const assertion = passkeyAssertion(opts.assertionPasskey ?? passkey, challenge, { credentialId: credentialIdOf(phone), flags: opts.flags, origin: opts.origin })
  return enroll.prove({ enrollId: started.enrollId, signature: signJcs(opts.signer ?? phone, msg), phoneNonce: r.toString('base64url'), passkey: { credentialId: credentialIdOf(phone), publicKey: opts.cose ?? coseOf(passkey), assertion } })
}

/** The whole ceremony: start, prove, Control reads pending, the anchor signs, approve. */
function ceremony(phone: TestKey, opts: { signer?: TestKey; rotates?: string } = {}) {
  const s = startFor(phone, opts.rotates ? { rotates: opts.rotates } : {})
  if (!s.ok) throw new Error(s.reason)
  const p = proveFor(phone, s)
  if (!p.ok) throw new Error(p.reason)
  const view = enroll.pendingView()!
  const sig = signB64(opts.signer ?? anchor, Buffer.from(view.approvalJcs as string, 'base64url'))
  return enroll.approve(s.enrollId, sig, SELF_DNS)
}

describe('enrollment ceremony', () => {
  it('start, proof of possession, SAS on both screens, anchor approval, then the key is active', () => {
    const phone = p256()
    const s = startFor(phone)
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.aud).toBe(audOf(anchor.der, SELF_DNS))
    expect(s.origin).toBe(ORIGIN)
    expect(enroll.pendingView()).toBeNull() // not shown to Control before the key proves possession
    const p = proveFor(phone, s)
    expect(p).toEqual({ ok: true, sas: sasOf(Buffer.from(s.challenge, 'base64url'), phone.der, rOf(phone)), fingerprint: fingerprintOfSpki(phone.der) })
    const view = enroll.pendingView()!
    // The approval binds the full fingerprint, the code, the challenge (nonce), expiry, aud and epoch.
    expect(view.approval).toMatchObject({ kid: phone.kid, sas: (p as { sas: string }).sas, challenge: s.challenge, exp: s.exp, aud: s.aud, epoch: 0, kver: 1 })
    const sig = signB64(anchor, Buffer.from(view.approvalJcs as string, 'base64url'))
    expect(enroll.approve(s.enrollId, sig, SELF_DNS)).toEqual({ ok: true, kid: phone.kid })
    expect(registry.entryState(phone.kid, SELF_DNS).ok).toBe(true)
    expect(enroll.status(s.enrollId)).toBe('enrolled')
    // Durable, and still anchored after a restart.
    open()
    expect(registry.entryState(phone.kid, SELF_DNS).ok).toBe(true)
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
    for (const ev of ['enroll_start', 'enroll_proven', 'enroll_approved']) expect(audit).toContain(`"event":"${ev}"`)
  })

  it('the token alone approves nothing: no signature, a forged one, or one by another key', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    proveFor(phone, s)
    expect(enroll.approve(s.enrollId, undefined, SELF_DNS)).toEqual({ ok: false, reason: 'anchor_signature_invalid' })
    expect(enroll.approve(s.enrollId, 'A'.repeat(86), SELF_DNS)).toEqual({ ok: false, reason: 'anchor_signature_invalid' })
    const view = enroll.pendingView()!
    expect(enroll.approve(s.enrollId, signB64(p256(), Buffer.from(view.approvalJcs as string, 'base64url')), SELF_DNS)).toEqual({ ok: false, reason: 'anchor_signature_invalid' })
    // A signature over a DIFFERENT approval (another code) is refused: the anchor signs what was shown.
    const other = { ...(view.approval as Record<string, unknown>), sas: '000000' }
    expect(enroll.approve(s.enrollId, signJcs(anchor, other), SELF_DNS)).toEqual({ ok: false, reason: 'anchor_signature_invalid' })
    expect(registry.entryState(phone.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_unknown' })
  })

  it('cannot approve before proof of possession', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    expect(enroll.approve(s.enrollId, 'x', SELF_DNS)).toEqual({ ok: false, reason: 'not_proven' })
  })

  it('proof with the wrong key fails, and three failures burn the request', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    const wrong = p256()
    for (let i = 1; i < WEB_ENROLL_MAX_PROOF_ATTEMPTS; i += 1) expect(proveFor(phone, s, { signer: wrong })).toEqual({ ok: false, reason: 'proof_invalid' })
    expect(proveFor(phone, s, { signer: wrong })).toEqual({ ok: false, reason: 'enroll_burned' })
    // Burned: even the right key cannot finish it now.
    expect(proveFor(phone, s)).toEqual({ ok: false, reason: 'enroll_unknown' })
    expect(enroll.status(s.enrollId)).toBe('burned')
  })

  it('proof over another aud or origin fails (the challenge binds the server identity)', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    expect(proveFor(phone, s, { msg: { origin: 'https://evil.example:3143' } })).toEqual({ ok: false, reason: 'proof_invalid' })
    expect(proveFor(phone, s, { msg: { aud: 'f'.repeat(64) } })).toEqual({ ok: false, reason: 'proof_invalid' })
  })

  it('one pending request at a time: a second start is refused, never replaces the first', () => {
    const a = startFor(p256())
    expect(a.ok).toBe(true)
    expect(startFor(p256())).toEqual({ ok: false, reason: 'enrollment_pending' })
    expect(enroll.status((a as { enrollId: string }).enrollId)).toBe('started')
  })

  it('expiry: an expired request cannot be proven or approved, and a new start is allowed', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    proveFor(phone, s)
    const view = enroll.pendingView()!
    clock += WEB_ENROLL_TTL_MS + 1
    expect(enroll.approve(s.enrollId, signB64(anchor, Buffer.from(view.approvalJcs as string, 'base64url')), SELF_DNS)).toEqual({ ok: false, reason: 'enroll_unknown' })
    expect(enroll.status(s.enrollId)).toBe('expired')
    expect(startFor(p256()).ok).toBe(true)
  })

  it('a key key-substituted between start and approve is not the key approved', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    // An attacker's key cannot prove for this enrollId (the challenge is bound to the started kid).
    const attacker = p256()
    expect(proveFor(phone, s, { signer: attacker, msg: { kid: attacker.kid } })).toEqual({ ok: false, reason: 'proof_invalid' })
  })

  it('cap of 2 active keys; an existing key is never replaced or re-admitted', () => {
    const a = p256(); const b = p256()
    expect(ceremony(a).ok).toBe(true)
    expect(ceremony(b).ok).toBe(true)
    expect(startFor(p256())).toEqual({ ok: false, reason: 'key_cap_reached' })
    registry.revoke(a.kid, 'lost', 'web')
    expect(startFor(a)).toEqual({ ok: false, reason: 'key_already_enrolled' })
  })

  it('rotation: new key through the full ceremony, then the old key is revoked (allowed at the cap)', () => {
    const a = p256(); const b = p256()
    ceremony(a); ceremony(b)
    const c = p256()
    expect(ceremony(c, { rotates: a.kid })).toEqual({ ok: true, kid: c.kid })
    expect(registry.entryState(a.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_revoked' })
    expect(registry.entryState(c.kid, SELF_DNS).ok).toBe(true)
    expect(startFor(p256(), { rotates: 'nope' })).toEqual({ ok: false, reason: 'rotate_unknown_key' })
  })

  it('revoke-all during a pending approval: the approval is refused (epoch changed)', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    proveFor(phone, s)
    const view = enroll.pendingView()!
    registry.revokeAll('token')
    expect(enroll.approve(s.enrollId, signB64(anchor, Buffer.from(view.approvalJcs as string, 'base64url')), SELF_DNS)).toEqual({ ok: false, reason: 'epoch_changed' })
  })

  it('refusals: no anchor, unknown MagicDNS name, bad key, bad label', () => {
    seedRegistry(file(), null); open()
    expect(startFor(p256())).toEqual({ ok: false, reason: 'anchor_not_registered' })
    seedRegistry(file(), anchor); open()
    expect(enroll.start({ spki: p256().spki, label: 'x', userAgent: '', remote: DEVICE, sasCommit: 'a'.repeat(64) }, { selfDnsName: null, origin: ORIGIN })).toEqual({ ok: false, reason: 'aud_unavailable' })
    expect(enroll.start({ spki: 'AAAA', label: 'x', userAgent: '', remote: DEVICE, sasCommit: 'a'.repeat(64) }, ctx)).toEqual({ ok: false, reason: 'invalid_key' })
    // A real key on another curve (P-384) is not a phone key.
    const p384 = (generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url')
    expect(enroll.start({ spki: p384, label: 'x', userAgent: '', remote: DEVICE, sasCommit: 'a'.repeat(64) }, ctx)).toEqual({ ok: false, reason: 'invalid_key' })
    expect(startFor(p256(), { label: '' })).toEqual({ ok: false, reason: 'invalid_label' })
    expect(startFor(p256(), { label: 'a\nb' })).toEqual({ ok: false, reason: 'invalid_label' })
  })
})

describe('registry trust', () => {
  it('an entry written into the file without a valid anchorSig enrolls nothing', () => {
    const phone = p256()
    const forged = anchoredEntry(p256(), phone)
    seedRegistry(file(), anchor, [forged]); open()
    expect(registry.entryState(phone.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_unanchored' })
    expect(registry.activeCount(SELF_DNS)).toBe(0)
  })
  it('an approval naming this install but signed by another key does not count (the signature itself is checked)', () => {
    const phone = p256()
    seedRegistry(file(), anchor, [anchoredEntry(p256(), phone, { aud: audOf(anchor.der, SELF_DNS) })]); open()
    expect(registry.entryState(phone.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_unanchored' })
  })
  it('an approval for another install (aud) does not count here', () => {
    const phone = p256()
    seedRegistry(file(), anchor, [anchoredEntry(anchor, phone, { aud: audOf(anchor.der, 'other-mac.tail00000.ts.net') })]); open()
    expect(registry.entryState(phone.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_unanchored' })
  })
  it('a revocation is durable and never needs the anchor', () => {
    const phone = p256()
    seedRegistry(file(), anchor, [anchoredEntry(anchor, phone)]); open()
    expect(registry.revoke(phone.kid, 'lost phone', 'token')).toBe(true)
    seedRegistry(join(dir, 'unused.json'), null)
    open()
    expect(registry.entryState(phone.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_revoked' })
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toContain('"event":"revoke"')
  })
  it('revoke-all revokes every key and bumps the epoch', () => {
    const a = p256(); const b = p256()
    seedRegistry(file(), anchor, [anchoredEntry(anchor, a), anchoredEntry(anchor, b)]); open()
    expect(registry.revokeAll('web')).toBe(1)
    expect(registry.activeCount(SELF_DNS)).toBe(0)
    open()
    expect(registry.epoch()).toBe(1)
  })
})

describe('nonces', () => {
  it('single use, durable, bounded', () => {
    const nonces = new WebKeyNonces(join(dir, 'n.json'), () => clock)
    const a = nonces.issue()
    if (!a.ok) throw new Error(a.reason)
    expect(nonces.consume(a.nonce, 'auth-1')).toBe('ok')
    expect(nonces.consume(a.nonce, 'auth-1')).toBe('nonce_spent')
    expect(new WebKeyNonces(join(dir, 'n.json'), () => clock).consume(a.nonce, 'auth-2')).toBe('nonce_spent')
    for (let i = 0; i < WEB_NONCE_MAX_OUTSTANDING; i += 1) expect(nonces.issue().ok).toBe(true)
    expect(nonces.issue()).toEqual({ ok: false, reason: 'nonce_cap_reached' })
  })
  it('spend: one winner per authorization', () => {
    const nonces = new WebKeyNonces(join(dir, 'n.json'), () => clock)
    expect(nonces.spend(['auth-1'], 's', 'claude')).toEqual({ ok: true })
    expect(nonces.spend(['auth-1'], 's', 'claude')).toEqual({ ok: false, reason: 'already_consumed' })
    expect(new WebKeyNonces(join(dir, 'n.json'), () => clock).spend(['auth-1'], 's2', 'codex')).toEqual({ ok: false, reason: 'already_consumed' })
  })
})

// ---------------------------------------------------------------------------------------------
// Review fixes (qa_6.99.30_plan_review.md). W10's negative matrix names are in the titles.
// ---------------------------------------------------------------------------------------------

describe('B1 anchor registration (COS Control bootstrap)', () => {
  beforeEach(() => { seedRegistry(file(), null); open() })
  it('a self-signed statement registers the anchor, records setAt, and it is not mature for 24 h', () => {
    const r = registry.registerAnchor(anchorRegistrationBody(anchor, clock), 'control')
    expect(r).toEqual({ ok: true, spkiSha256: sha256Hex(anchor.der), fingerprint: fingerprintOfSpki(anchor.der), setAt: clock, replaced: false })
    expect(registry.anchor()?.setAt).toBe(clock)
    expect(registry.anchorMature()).toBe(false)
    clock += WEB_ANCHOR_MATURITY_MS
    expect(registry.anchorMature()).toBe(true)
    open() // durable: the record is in the file
    expect(registry.anchor()?.spkiSha256).toBe(sha256Hex(anchor.der))
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toContain('"event":"anchor_registered"')
  })
  it('refusals: another key\'s statement, a bad self-signature, non-canonical bytes, a stale createdAt, a non-P-256 key', () => {
    const other = p256()
    const body = anchorRegistrationBody(anchor, clock)
    expect(registry.registerAnchor({ ...anchorRegistrationBody(other, clock), anchorPub: anchor.spki }, 'control')).toEqual({ ok: false, reason: 'statement_mismatch' })
    expect(registry.registerAnchor({ ...body, signature: anchorRegistrationBody(other, clock).signature }, 'control')).toEqual({ ok: false, reason: 'anchor_signature_invalid' })
    const pretty = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(body.statement, 'base64url').toString('utf8')), null, 1)).toString('base64url')
    expect(registry.registerAnchor({ ...body, statement: pretty }, 'control')).toEqual({ ok: false, reason: 'statement_not_canonical' })
    expect(registry.registerAnchor(anchorRegistrationBody(anchor, clock - 11 * 60_000), 'control')).toEqual({ ok: false, reason: 'statement_stale' })
    expect(registry.registerAnchor({ ...body, anchorPub: 'AAAA' }, 'control')).toEqual({ ok: false, reason: 'invalid_key' })
    expect(registry.anchor()).toBeNull()
  })
  it('replacing the anchor revokes every key and bumps the epoch', () => {
    const phone = p256()
    seedRegistry(file(), anchor, [anchoredEntry(anchor, phone)]); open()
    const next = p256()
    const r = registry.registerAnchor(anchorRegistrationBody(next, clock), 'control')
    expect(r.ok && r.replaced).toBe(true)
    expect(registry.epoch()).toBe(1)
    expect(registry.entryState(phone.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_revoked' })
  })
  it('W10 anchor swap: an anchorPub in the file without its record cannot start an enrollment', () => {
    seedRegistry(file(), anchor, [], 0, { registration: false }); open()
    expect(registry.anchorRefusal()).toBe('anchor_unregistered')
    expect(startFor(p256())).toEqual({ ok: false, reason: 'anchor_unregistered' })
  })
})

describe('W3 SAS commit-reveal', () => {
  it('the phone must reveal the r it committed to before the challenge', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    expect(proveFor(phone, s, { r: randomBytes(32) })).toEqual({ ok: false, reason: 'commit_mismatch' })
    expect(proveFor(phone, s).ok).toBe(true)
  })
  it('start refuses a missing or malformed commitment', () => {
    expect(startFor(p256(), { sasCommit: undefined })).toEqual({ ok: false, reason: 'invalid_commit' })
    expect(startFor(p256(), { sasCommit: 'A'.repeat(64) })).toEqual({ ok: false, reason: 'invalid_commit' })
  })
  it('W10 SAS grinding: offline, a server can match an attacker SAS by picking challenges WITHOUT r (old scheme), but not when r is committed and unknown', () => {
    const phoneDer = p256().der
    const attackerDer = p256().der
    // Old scheme (sha256(challenge || spki)): the server sees both SPKIs before it picks, so it can
    // grind challenges until SAS(attacker) equals SAS(phone). Expected tries ~10^6; we cap the demo
    // at a 2-digit prefix (100x fewer) to keep the test fast, which proves the search is feasible.
    const old = (c: Buffer, der: Buffer) => String(createHash('sha256').update(c).update(der).digest().readUInt32BE(0) % 1_000_000).padStart(6, '0')
    let tries = 0
    let found = false
    while (tries < 20_000 && !found) { const c = randomBytes(32); tries += 1; found = old(c, phoneDer).slice(0, 2) === old(c, attackerDer).slice(0, 2) }
    expect(found).toBe(true)
    // New scheme: the phone's SAS depends on r, which the server learns only AFTER it fixed the
    // challenge. For a fixed challenge, two different r values give independent SAS values, so the
    // challenge the server picked predicts nothing about the code the phone will show.
    const c = randomBytes(32)
    const r1 = randomBytes(32), r2 = randomBytes(32)
    const sasPhone = [r1, r2].map(r => sasOf(c, phoneDer, r))
    expect(sasPhone[0]).not.toBe(sasPhone[1])
    // And the server-side SAS for the attacker key (computed with the same revealed r) matches the
    // phone's only by chance: equal to a 1-in-10^6 guess, not something the server could steer.
    expect(sasOf(c, attackerDer, r1)).not.toBe(sasOf(c, phoneDer, r1))
  })
})

describe('B2 enrollment binds a user-verified passkey', () => {
  it('the approval carries the passkey credential id and key hash; the entry carries its SPKI', () => {
    const phone = p256()
    expect(ceremony(phone).ok).toBe(true)
    const e = registry.entry(phone.kid)!
    expect(e.approval.passkey_credential_id).toBe(credentialIdOf(phone))
    expect(e.approval.passkey_spki_sha256).toBe(sha256Hex(passkeyOf(phone).der))
    expect(e.passkeySpki).toBe(passkeyOf(phone).spki)
    const st = registry.entryState(phone.kid, SELF_DNS)
    expect(st.ok).toBe(true)
  })
  it('no passkey, a broken COSE key, an assertion by another key, no UV, or the 3143 origin: refused', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    expect(enroll.prove({ enrollId: s.enrollId, signature: 'x', phoneNonce: rOf(phone).toString('base64url') })).toEqual({ ok: false, reason: 'passkey_malformed' })
    expect(proveFor(phone, s, { cose: 'AAAA' })).toEqual({ ok: false, reason: 'passkey_malformed' })
    open()
    const s2 = startFor(phone)
    if (!s2.ok) throw new Error(s2.reason)
    expect(proveFor(phone, s2, { assertionPasskey: p256() })).toEqual({ ok: false, reason: 'passkey_invalid' })
    expect(proveFor(phone, s2, { flags: 0x01 })).toEqual({ ok: false, reason: 'passkey_invalid' })
    open()
    const s3 = startFor(phone)
    if (!s3.ok) throw new Error(s3.reason)
    expect(proveFor(phone, s3, { origin: `https://${SELF_DNS}:3143` })).toEqual({ ok: false, reason: 'passkey_invalid' })
    expect(proveFor(phone, s3).ok).toBe(true)
  })
  it('the COSE decoder takes exactly an EC2 P-256 ES256 key', () => {
    const k = p256()
    expect(coseP256ToSpki(coseOf(k))?.equals(k.der)).toBe(true)
    const bad = Buffer.from(coseOf(k), 'base64url'); bad[4] = 0x25 // alg -6, not -7
    expect(coseP256ToSpki(bad.toString('base64url'))).toBeNull()
    expect(coseP256ToSpki(Buffer.concat([Buffer.from(coseOf(k), 'base64url'), Buffer.from([0])]).toString('base64url'))).toBeNull()
  })
})

describe('W4 Control shows only what it signs', () => {
  it('pendingView hands back the approval and its JCS bytes, nothing displayable outside them', () => {
    const phone = p256()
    const s = startFor(phone)
    if (!s.ok) throw new Error(s.reason)
    proveFor(phone, s)
    const view = enroll.pendingView()!
    expect(Object.keys(view).sort()).toEqual(['approval', 'approvalJcs', 'enrollId', 'exp', 'startedAt'])
    const a = JSON.parse(Buffer.from(view.approvalJcs as string, 'base64url').toString('utf8'))
    expect(a).toEqual(view.approval)
    // Everything Control displays derives from those bytes alone.
    expect(a.fingerprint).toBe(fingerprintOfSpki(Buffer.from(a.spki, 'base64url')))
    expect(a.sas).toBe(sasOf(Buffer.from(a.challenge, 'base64url'), Buffer.from(a.spki, 'base64url'), Buffer.from(a.phoneNonce, 'base64url')))
    expect(sha256Hex(Buffer.from(a.phoneNonce, 'base64url'))).toBe(a.sasCommit)
    expect(a).toMatchObject({ label: 'iPhone Duo', userAgent: 'Safari', remote: DEVICE, origin: ORIGIN, rotates: null })
  })
})

describe('W6 device allowlist and the enrolling socket', () => {
  it('a device off the allowlist cannot start; the default allowlist refuses everyone', () => {
    expect(startFor(p256(), { remote: '100.64.0.10' })).toEqual({ ok: false, reason: 'device_not_allowed' })
    const strict = new WebKeyEnrollments(registry, { now: () => clock })
    expect(strict.start({ spki: p256().spki, label: 'x', userAgent: '', remote: DEVICE, sasCommit: 'a'.repeat(64) }, ctx)).toEqual({ ok: false, reason: 'device_not_allowed' })
  })
  it('COS_WEB_KEY_DEVICES: empty refuses, listed addresses (IPv4-mapped too) pass', () => {
    expect(deviceAllowlistFrom({})('100.64.0.9')).toBe(false)
    const allow = deviceAllowlistFrom({ COS_WEB_KEY_DEVICES: ' 100.64.0.9, fd7a:115c:a1e0::1 ' })
    expect(allow('100.64.0.9')).toBe(true)
    expect(allow('::ffff:100.64.0.9')).toBe(true)
    expect(allow('fd7a:115c:a1e0::1')).toBe(true)
    expect(allow('100.64.0.10')).toBe(false)
  })
  it('the approval records the normalized socket address', () => {
    const phone = p256()
    const s = startFor(phone, { remote: '::ffff:100.64.0.9' })
    if (!s.ok) throw new Error(s.reason)
    proveFor(phone, s)
    expect((enroll.pendingView()!.approval as Record<string, unknown>).remote).toBe(DEVICE)
  })
})

describe('W8 rotation is inside the anchor signature', () => {
  it('the approval names the rotated kid, so a server cannot revoke another key with it', () => {
    const a = p256(); const b = p256()
    ceremony(a); ceremony(b)
    const c = p256()
    const s = startFor(c, { rotates: a.kid })
    if (!s.ok) throw new Error(s.reason)
    proveFor(c, s)
    const view = enroll.pendingView()!
    expect((view.approval as Record<string, unknown>).rotates).toBe(a.kid)
    expect(enroll.approve(s.enrollId, signB64(anchor, Buffer.from(view.approvalJcs as string, 'base64url')), SELF_DNS).ok).toBe(true)
    expect(registry.entryState(a.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_revoked' })
    expect(registry.entryState(b.kid, SELF_DNS).ok).toBe(true)
    expect(registry.entry(c.kid)!.approval.rotates).toBe(a.kid)
  })
})

describe('B3 one consume namespace and W10 nonce-store rollback', () => {
  it('spend sets every key in one write, and refuses if ANY key was spent (nothing partial)', () => {
    const nonces = new WebKeyNonces(join(dir, 'n.json'), () => clock)
    expect(nonces.spend(['turn:t1', 'web:aud:auth1'], 's', 'claude')).toEqual({ ok: true })
    expect(nonces.spend(['turn:t2', 'web:aud:auth1'], 's', 'claude')).toEqual({ ok: false, reason: 'already_consumed' })
    expect(nonces.spend(['turn:t1', 'web:aud:auth2'], 's', 'claude')).toEqual({ ok: false, reason: 'already_consumed' })
    // t2 was not set by the refused call.
    expect(nonces.spend(['turn:t2'], 's', 'claude')).toEqual({ ok: true })
    expect(nonces.spend([], 's', 'claude')).toEqual({ ok: false, reason: 'invalid_keys' })
  })
  it('W10 nonce-store rollback: restoring an older web-key-nonces.json re-opens a spent nonce SERVER-SIDE (documented limit; the verifier\'s own consume store and the 15 min expiry bound it)', () => {
    const f = join(dir, 'n.json')
    const nonces = new WebKeyNonces(f, () => clock)
    const issued = nonces.issue()
    if (!issued.ok) throw new Error(issued.reason)
    const snapshot = readFileSync(f, 'utf8')
    expect(nonces.consume(issued.nonce, 'a1')).toBe('ok')
    writeFileSync(f, snapshot)
    expect(new WebKeyNonces(f, () => clock).consume(issued.nonce, 'a1')).toBe('ok')
    // ...but never past the nonce's own expiry.
    writeFileSync(f, snapshot)
    clock += 15 * 60_000 + 1
    expect(new WebKeyNonces(f, () => clock).consume(issued.nonce, 'a1')).toBe('nonce_expired')
  })
})

describe('B1 the registration record must be the anchor speaking about itself', () => {
  function writeReg(statementKey: TestKey, signer: TestKey): void {
    const stmt = { v: 'cos-web-anchor/1', spkiSha256: sha256Hex(statementKey.der), fingerprint: fingerprintOfSpki(statementKey.der), createdAt: clock }
    writeFileSync(file(), JSON.stringify({ v: 1, anchorPub: anchor.spki, anchorRegistration: { statement: Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(stmt).sort()))).toString('base64url'), signature: signJcs(signer, stmt), setAt: clock - 90_000_000 }, epoch: 0, entries: [] }))
    open()
  }
  it('a statement naming the anchor but signed by another key does not register it', () => {
    writeReg(anchor, p256())
    expect(registry.anchorRefusal()).toBe('anchor_unregistered')
  })
  it('a statement the anchor signed about ANOTHER key does not register the anchor', () => {
    writeReg(p256(), anchor)
    expect(registry.anchorRefusal()).toBe('anchor_unregistered')
  })
  it('the good record does (control for the two above)', () => {
    writeReg(anchor, anchor)
    expect(registry.anchorRefusal()).toBeNull()
  })
  it('an approval the anchor signed whose spki field names another key than spki_sha256 is not anchored', () => {
    const phone = p256()
    const e = anchoredEntry(anchor, phone)
    const approval = { ...e.approval, spki: p256().spki }
    seedRegistry(file(), anchor, [{ ...e, approval, anchorSig: signJcs(anchor, approval) }]); open()
    expect(registry.entryState(phone.kid, SELF_DNS)).toEqual({ ok: false, reason: 'key_unanchored' })
  })
})
