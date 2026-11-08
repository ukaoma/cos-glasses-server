// 6.99.31 Phase 3: the REAL signer page script (server/web-signer/signer.js, with the real
// signer-proof.js) in a small fake DOM, driven the way taps are. The "server" behind its fetch is the
// server's own code: WebKeyEnrollments for setup, WebKeySignHandoffs for the handoff, WebKeyNonces,
// and WebKeyAuthority.accept (passkey verifier included) for the signed turn. Only the browser parts
// are fakes: IndexedDB (an in-memory store) and the passkey authenticator (a node P-256 key).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, sign, webcrypto } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebKeyEnrollments, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from '../lib/web-key-registry.js'
import { WebKeyAuthority } from '../lib/web-key-authority.js'
import { WebKeySignHandoffs } from '../lib/web-key-handoff.js'
import { parseEnvelopeHeader } from '../lib/web-key-envelope.js'
import { kidOfSpki } from '../lib/web-key-envelope.js'
import { anchoredEntry, INTEGRITY_OK, ORIGIN, p256, seedRegistry, SELF_DNS, signB64, type TestKey } from '../lib/__fixtures__/web-key-kit.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROOF_SRC = readFileSync(join(HERE, 'signer-proof.js'), 'utf8')
const PAGE_SRC = readFileSync(join(HERE, 'signer.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
// The page stamps iat from Date.now(), so the server here runs on the real clock too.
const NOW = Date.now()
const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }

class El {
  hidden = false; textContent = ''; value = ''; disabled = false; href = ''
  private listeners: Array<(ev: unknown) => unknown> = []
  constructor(readonly id: string) {}
  addEventListener(_type: string, fn: (ev: unknown) => unknown) { this.listeners.push(fn) }
  tap(isTrusted = true): unknown { let out: unknown; for (const fn of this.listeners) out = fn({ isTrusted }); return out }
}

interface Rig {
  W: Record<string, any>
  els: Map<string, El>
  el: (id: string) => El
  fetches: Array<{ path: string; method: string; headers: Record<string, string>; body: any }>
  store: { record: any; gets: number }
  creates: any[]
  gets: any[]
  visible: () => string[]
}

function rig(opts: { record?: any; hash?: string; framed?: boolean; route: (path: string, method: string, body: any, headers: Record<string, string>) => { status: number; body: unknown }; passkey: TestKey; credentialId: string; cancelPasskey?: boolean }): Rig {
  const ids = [...HTML.matchAll(/id="([a-z-]+)"/g)].map(m => m[1])
  const els = new Map(ids.map(id => [id, new El(id)]))
  for (const id of ids) if (/<section id="[^"]+" hidden>/.test(HTML) && HTML.includes(`<section id="${id}" hidden>`)) els.get(id)!.hidden = true
  els.get('enroll-label')!.value = 'iPhone'
  const fetches: Rig['fetches'] = []
  const store = { record: opts.record ?? null, gets: 0 }
  const creates: any[] = [], gets: any[] = []
  const location = { hostname: SELF_DNS, origin: ORIGIN, pathname: '/', hash: opts.hash ?? '' }
  const W: Record<string, any> = {
    crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
    setTimeout: (fn: () => void) => setImmediate(fn),
    location,
    history: { replaceState: (_s: unknown, _t: string, url: string) => { location.hash = ''; location.pathname = url } },
    document: { getElementById: (id: string) => els.get(id) ?? null },
    COSSignerStore: {
      get: async () => { store.gets += 1; return store.record },
      put: async (r: any) => { store.record = r },
      clear: async () => { store.record = null },
    },
    fetch: async (path: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : undefined
      fetches.push({ path, method: init.method, headers: init.headers, body })
      const out = opts.route(path, init.method, body, init.headers)
      return { status: out.status, text: async () => JSON.stringify(out.body) }
    },
    navigator: {
      credentials: {
        create: async (o: any) => {
          creates.push(o)
          return { rawId: new Uint8Array(Buffer.from(opts.credentialId, 'base64url')), response: { getPublicKey: () => new Uint8Array(opts.passkey.der) } }
        },
        get: async (o: any) => {
          gets.push(o)
          if (opts.cancelPasskey) throw new Error('NotAllowedError')
          const challenge = Buffer.from(o.publicKey.challenge)
          const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.toString('base64url'), origin: ORIGIN }), 'utf8')
          const auth = Buffer.concat([createHash('sha256').update(o.publicKey.rpId, 'utf8').digest(), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])])
          const sig = sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), { key: opts.passkey.privateKey, dsaEncoding: 'der' })
          return { rawId: new Uint8Array(Buffer.from(o.publicKey.allowCredentials[0].id)), response: { authenticatorData: new Uint8Array(auth), clientDataJSON: new Uint8Array(client), signature: new Uint8Array(sig) } }
        },
      },
    },
  }
  W.self = W
  W.top = opts.framed ? {} : W
  new Function('window', PROOF_SRC)(W)
  new Function('window', PAGE_SRC)(W)
  const el = (id: string) => els.get(id)!
  return { W, els, el, fetches, store, creates, gets, visible: () => ['loading', 'framed', 'enroll', 'pending', 'sign', 'done', 'idle', 'problem'].filter(id => !el(id).hidden) }
}

let dir: string
let anchor: TestKey
let registry: WebKeyRegistry
let enroll: WebKeyEnrollments
let nonces: WebKeyNonces
let handoffs: WebKeySignHandoffs
let authority: WebKeyAuthority
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signer-page-'))
  anchor = p256()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function server(entries: ReturnType<typeof anchoredEntry>[] = []) {
  seedRegistry(join(dir, 'web-keys.json'), anchor, entries)
  registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => NOW)
  enroll = new WebKeyEnrollments(registry, { now: () => NOW, deviceAllowed: () => true })
  nonces = new WebKeyNonces(join(dir, 'nonces.json'), () => NOW)
  handoffs = new WebKeySignHandoffs(() => NOW)
  authority = new WebKeyAuthority({ registry, nonces, packets: new WebKeyPackets(() => NOW), integrity: () => INTEGRITY_OK, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => true, now: () => NOW })
}
const turnsSeen: Array<{ verdict: unknown; headers: Record<string, string>; body: any }> = []
function route(path: string, method: string, body: any, headers: Record<string, string>) {
  if (path === '/api/web-key/enroll/start' && method === 'POST') { const r = enroll.start({ ...body, userAgent: 'Safari', remote: '100.64.0.9' }, { selfDnsName: SELF_DNS, origin: ORIGIN }); return { status: r.ok ? 201 : 400, body: r.ok ? r : { ok: false, error: r.reason } } }
  if (path === '/api/web-key/enroll/prove' && method === 'POST') { const r = enroll.prove(body); return { status: r.ok ? 200 : 400, body: r.ok ? r : { ok: false, error: r.reason } } }
  if (path.startsWith('/api/web-key/enroll/status')) return { status: 200, body: { ok: true, status: enroll.status(new URL(path, ORIGIN).searchParams.get('enrollId')) } }
  if (path === '/api/web-key/handoff/claim') { const c = handoffs.claim(body.handoffId); return { status: c.ok ? 200 : 404, body: c.ok ? { ok: true, handoff: c.handoff } : { ok: false, error: c.reason } } }
  if (path === '/api/web-key/nonce') { const n = nonces.issue(); return { status: 201, body: n.ok ? { ok: true, nonce: n.nonce, exp: n.exp, aud: registry.aud(SELF_DNS), epoch: registry.epoch() } : { ok: false } } }
  const m = /^\/api\/agent-sessions\/bindings\/([^/]+)\/turns$/.exec(path)
  if (m && method === 'POST') {
    const verdict = authority.accept({ envelope: headers['x-cos-web-envelope'], signature: headers['x-cos-web-sig'], passkey: headers['x-cos-web-passkey'], requestOrigin: ORIGIN },
      { provider: 'claude', sessionId: SID, bindingId: m[1], turnId: body.clientTurnId, words: body.prompt, attachments: [] })
    turnsSeen.push({ verdict, headers, body })
    return { status: 200, body: { outcome: 'completed', turnId: 't1' } }
  }
  return { status: 404, body: { ok: false, error: 'not_found' } }
}

describe('never in a frame', () => {
  it('framed: shows the framed note and reads nothing (no key store, no claim)', async () => {
    server()
    const passkey = p256()
    const r = rig({ framed: true, hash: '#h=' + 'a'.repeat(24), route, passkey, credentialId: 'Y3JlZC0x' })
    await r.W.COSSigner.ready
    expect(r.visible()).toEqual(['framed'])
    expect(r.fetches).toEqual([])
    expect(r.store.gets).toBe(0)
  })
})

describe('enrollment: device key and passkey in one step, the code computed on the phone', () => {
  it('shows the locally computed code, which equals the server SAS; becomes enrolled once the Mac approves', async () => {
    server()
    const passkey = p256()
    const r = rig({ route, passkey, credentialId: 'Y3JlZC0xMjM0NTY3OA' })
    await r.W.COSSigner.ready
    expect(r.visible()).toEqual(['enroll'])
    // Tap 1: the passkey prompt comes first, before any request; then the device key, start and the proof signature.
    const tap1 = r.el('enroll-start').tap(true) as Promise<void>
    expect(r.creates).toHaveLength(1)
    expect(r.fetches).toEqual([])
    await tap1
    expect(r.gets).toEqual([])
    expect(r.el('enroll-confirm').hidden).toBe(false)
    expect(r.el('enroll-start').hidden).toBe(true)
    // Tap 2: Face ID over the proof is the first thing it does, then prove.
    const fetchesBefore = r.fetches.length
    const done = r.el('enroll-confirm').tap(true) as Promise<void>
    expect(r.gets).toHaveLength(1)
    expect(r.fetches.length).toBe(fetchesBefore)
    await flush()
    expect(r.visible()).toEqual(['pending'])
    const pending = enroll.pendingView()!
    const approval = pending.approval as Record<string, any>
    expect(r.el('pending-code').textContent.replace(' ', '')).toBe(approval.sas)
    expect(r.el('pending-fingerprint').textContent).toBe(approval.fingerprint)
    // Passkey: user verification required, resident key preferred, rpId the full host, ES256.
    expect(r.creates).toHaveLength(1)
    const pk = r.creates[0].publicKey
    expect(pk.rp.id).toBe(SELF_DNS)
    expect(pk.authenticatorSelection).toMatchObject({ residentKey: 'preferred', userVerification: 'required' })
    expect(pk.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }])
    expect(r.gets[0].publicKey.userVerification).toBe('required')
    // The key stays on the phone, non-extractable, and the server bound the passkey the page made.
    expect(r.store.record.keyPair.privateKey.extractable).toBe(false)
    expect(approval.passkey_credential_id).toBe('Y3JlZC0xMjM0NTY3OA')
    expect(approval.passkey_spki_sha256).toBe(createHash('sha256').update(passkey.der).digest('hex'))
    // The Mac approves with the anchor (what COS Control does after Touch ID).
    expect(enroll.approve(pending.enrollId, signB64(anchor, Buffer.from(String(pending.approvalJcs), 'base64url')), SELF_DNS)).toMatchObject({ ok: true })
    await done
    expect(r.visible()).toEqual(['idle'])
    expect(r.store.record.state).toBe('enrolled')
    expect(registry.activeCount(SELF_DNS)).toBe(1)
  })
  it('a Mac code that differs from the phone code stops setup and forgets the key', async () => {
    server()
    const real = enroll.prove.bind(enroll)
    enroll.prove = ((input: Parameters<typeof real>[0]) => { const p = real(input); return p.ok ? { ...p, sas: p.sas === '000000' ? '000001' : '000000' } : p }) as typeof enroll.prove
    const r = rig({ route, passkey: p256(), credentialId: 'Y3JlZC0x' })
    await r.W.COSSigner.ready
    await r.el('enroll-start').tap(true)
    expect(r.el('enroll-confirm').tap(false)).toBeUndefined()
    await r.el('enroll-confirm').tap(true)
    expect(r.visible()).toEqual(['problem'])
    expect(r.el('problem-text').textContent).toContain('does not match')
    expect(r.store.record).toBeNull()
  })
  it('a script-made click does not start setup', async () => {
    server()
    const r = rig({ route, passkey: p256(), credentialId: 'Y3JlZC0x' })
    await r.W.COSSigner.ready
    expect(r.el('enroll-start').tap(false)).toBeUndefined()
    await flush()
    expect(r.fetches).toEqual([])
    expect(r.creates).toEqual([])
  })
})

describe('per-turn signing', () => {
  async function enrolledRig(words = 'Yes, install 6.99.31 on this Mac.  \n', channel?: string, cancelPasskey = false) {
    // The kit names the credential `cred-<kid>`; a real rawId is always canonical base64url, so pick a key whose
    // fixture id round-trips (the page sends back b64url(rawId), exactly as Safari's bytes would give).
    let pair: CryptoKeyPair, der: Buffer, phone: TestKey
    do {
      pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      der = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey))
      phone = { der, spki: der.toString('base64url'), kid: kidOfSpki(der) } as unknown as TestKey
    } while (Buffer.from(`cred-${phone.kid}`, 'base64url').toString('base64url') !== `cred-${phone.kid}`)
    const passkey = p256()
    const entry = anchoredEntry(anchor, phone, { passkey })
    server([entry])
    const credentialId = entry.approval.passkey_credential_id
    const record = { kid: phone.kid, keyPair: pair, spki: phone.spki, credentialId, label: 'iPhone', state: 'enrolled', fingerprint: 'X' }
    const artifacts: Record<string, string> = { 'gotcos-site': 'gotcos-site-manifest', 'control-downloads': 'cos-control-downloads-manifest', 'release-docs': 'cos-release-docs-manifest' }
    const p = channel ? authority.packets.create({ action: 'publish', artifact: artifacts[channel] ?? '@gotcos/glasses-server', version: '7.0.6', digest: 'sha256:' + 'a'.repeat(64), channel }, { provider: 'claude', sessionId: SID }) : null
    if (p && !p.ok) throw new Error(p.reason)
    const pk = p && p.ok ? p : null
    const scope = pk ? { kind: 'approve' as const, action: pk.packet.action, artifact: pk.packet.artifact, version: pk.packet.version, digest: pk.packet.digest, channel: pk.packet.channel, packetSha256: pk.packetSha256 } : { kind: 'message' as const }
    const created = handoffs.create({ words, turn: { bindingId: 'b-1', epoch: 2, targetKey: 'tk', clientTurnId: 'turn-web-key-0001' }, packetSha256: pk?.packetSha256 ?? null }, { provider: 'claude', sessionId: SID }, scope, pk?.packet ?? null)
    if (!created.ok) throw new Error(created.reason)
    turnsSeen.length = 0
    const r = rig({ record, hash: '#h=' + created.handoffId, route, passkey, credentialId, cancelPasskey })
    await r.W.COSSigner.ready
    return { r, handoffId: created.handoffId, packet: pk }
  }

  it('claims the handoff once, clears the id from the address, shows the exact words, target and scope', async () => {
    const { r, handoffId } = await enrolledRig()
    expect(r.fetches[0]).toMatchObject({ path: '/api/web-key/handoff/claim', method: 'POST', body: { handoffId } })
    expect(r.W.location.hash).toBe('')
    expect(r.visible()).toEqual(['sign'])
    expect(r.el('sign-words').textContent).toBe('Yes, install 6.99.31 on this Mac.')
    expect(r.el('sign-provider').textContent).toBe('Claude')
    expect(r.el('sign-session').textContent).toBe(SID)
    expect(r.el('sign-scope').textContent).toContain('Message only')
  })
  it('a real tap signs: the words on screen are the words hashed, posted and accepted by the server', async () => {
    const { r } = await enrolledRig()
    // The nonce is already in hand, so the tap's first request is the signed turn, after Face ID.
    const tap = r.el('sign-approve').tap(true) as Promise<void>
    await tap
    expect(r.fetches.map(f => f.path)).toEqual(['/api/web-key/handoff/claim', '/api/web-key/nonce', '/api/agent-sessions/bindings/b-1/turns'])
    expect(r.visible()).toEqual(['done'])
    expect(turnsSeen).toHaveLength(1)
    const t = turnsSeen[0]
    expect(t.verdict).toEqual(expect.objectContaining({ ok: true }))
    const shown = r.el('sign-words').textContent
    expect(t.body.prompt).toBe(shown)
    const env = parseEnvelopeHeader(t.headers['x-cos-web-envelope'])
    expect(env.ok).toBe(true)
    if (!env.ok) return
    expect(env.envelope.wordsSha256).toBe(createHash('sha256').update(shown, 'utf8').digest('hex'))
    expect(env.envelope.origin).toBe(ORIGIN)
    expect(env.envelope.sessionId).toBe(SID)
    // Face ID over sha256(envelope JCS), user verification required, the full host as rpId.
    const g = r.gets[0].publicKey
    expect(Buffer.from(g.challenge).equals(createHash('sha256').update(env.bytes).digest())).toBe(true)
    expect(g.userVerification).toBe('required')
    expect(g.rpId).toBe(SELF_DNS)
  })
  it('a script-made click signs nothing', async () => {
    const { r } = await enrolledRig()
    expect(r.el('sign-approve').tap(false)).toBeUndefined()
    await flush()
    expect(r.fetches.map(f => f.path)).toEqual(['/api/web-key/handoff/claim', '/api/web-key/nonce'])
    expect(r.gets).toEqual([])
    expect(turnsSeen).toEqual([])
  })
  it('words on screen changed after they were shown: nothing is signed', async () => {
    const { r } = await enrolledRig()
    r.el('sign-words').textContent = 'Yes, publish to npm latest.'
    await r.el('sign-approve').tap(true)
    expect(r.visible()).toEqual(['problem'])
    expect(r.gets).toEqual([])
    expect(turnsSeen).toEqual([])
  })
  it.each(['npm-next', 'npm-latest', 'control-appcast', 'hub-alias', 'gotcos-site', 'control-downloads', 'release-docs'])('shows the full %s packet and user-verifies the exact scoped publish', async channel => {
    const { r, packet } = await enrolledRig('Approve this exact release.', channel)
    expect(packet).not.toBeNull()
    const shown = r.el('sign-packet').textContent
    for (const value of [packet!.packet.artifact, packet!.packet.version, packet!.packet.channel, packet!.packet.digest, SID, packet!.packetSha256]) expect(shown).toContain(value)
    const targets: Record<string, string> = { 'gotcos-site': 'gotcos.com website (cos-starter Pages)', 'control-downloads': 'COS Control GitHub release downloads and approved latest aliases', 'release-docs': 'Public COS release documentation' }
    if (targets[channel]) {
      expect(shown).toContain('Deployment target: ' + targets[channel])
      expect(shown).toContain('limited to this exact manifest SHA-256')
    }
    expect(r.gets).toEqual([])
    await r.el('sign-approve').tap(true)
    expect(r.gets).toHaveLength(1)
    expect(turnsSeen).toHaveLength(1)
    expect(turnsSeen[0].verdict).toMatchObject({ ok: true, proof: { scope: { kind: 'approve', action: 'publish', channel, packetSha256: packet!.packetSha256 } } })
    expect(authority.packets.get(packet!.packetSha256)).toBeNull()
  })
  it('denied or cancelled passkey never sends a turn or consumes the packet', async () => {
    const { r, packet } = await enrolledRig('Approve this exact release.', 'npm-latest', true)
    await r.el('sign-approve').tap(true)
    expect(r.visible()).toEqual(['problem'])
    expect(r.el('problem-text').textContent).toContain('cancelled')
    expect(turnsSeen).toEqual([])
    expect(authority.packets.get(packet!.packetSha256)).not.toBeNull()
  })
  it('Cancel on the review screen never asks for a passkey or sends a turn', async () => {
    const { r, packet } = await enrolledRig('Approve this exact release.', 'npm-latest')
    await r.el('sign-cancel').tap(true)
    expect(r.visible()).toEqual(['problem'])
    expect(r.gets).toEqual([])
    expect(turnsSeen).toEqual([])
    expect(authority.packets.get(packet!.packetSha256)).not.toBeNull()
  })
  it('changing displayed release details refuses before asking for the passkey', async () => {
    const { r } = await enrolledRig('Approve this exact release.', 'npm-latest')
    r.el('sign-packet').textContent += ' another channel'
    await r.el('sign-approve').tap(true)
    expect(r.visible()).toEqual(['problem'])
    expect(r.gets).toEqual([])
    expect(turnsSeen).toEqual([])
  })
  it('a claimed handoff cannot be claimed again (a reload shows the problem, not the words)', async () => {
    const { handoffId } = await enrolledRig()
    expect(handoffs.claim(handoffId)).toEqual({ ok: false, reason: 'handoff_claimed' })
  })
})
