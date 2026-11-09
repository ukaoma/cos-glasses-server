// 6.99.31 Phase 3: the 3143 to 3144 handoff (lib/web-key-handoff.ts) and its two routes in
// routes/web-key.ts, plus the signer-listener gate on the phone's key steps. Real router, real
// registry and authority; the web path and the listener port are named by test headers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHandoffRequest, WEB_KEY_HANDOFF_MAX_OPEN, WEB_KEY_HANDOFF_TTL_MS, WebKeySignHandoffs } from './web-key-handoff.js'
import { WebKeyAuthority } from './web-key-authority.js'
import { WebKeyEnrollments, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from './web-key-registry.js'
import { createWebKeyRouter, type WebKeyRouterDeps } from '../routes/web-key.js'
import { anchoredEntry, INTEGRITY_OK, ORIGIN, p256, seedRegistry, SELF_DNS } from './__fixtures__/web-key-kit.js'

const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const TK = '6:claude:36:' + SID
const BODY = { bindingId: 'b-1', epoch: 2, targetKey: TK, clientTurnId: 'turn-web-key-0001', prompt: 'Yes, go ahead.' }
let clock = 1_786_000_000_000

describe('parseHandoffRequest', () => {
  it('takes the turn fields and the words; never a provider or session from the body', () => {
    const p = parseHandoffRequest({ ...BODY, provider: 'codex', sessionId: 'other', acknowledgedRevision: 'rev:1' })
    expect(p).toEqual({ ok: true, request: { words: 'Yes, go ahead.', turn: { bindingId: 'b-1', epoch: 2, targetKey: TK, clientTurnId: 'turn-web-key-0001', acknowledgedRevision: 'rev:1' }, packetSha256: null } })
  })
  it('refuses files (they cannot be signed yet), empty words, long words and bad ids', () => {
    expect(parseHandoffRequest({ ...BODY, attachmentIds: ['m_1'] })).toEqual({ ok: false, reason: 'attachments_not_signable' })
    expect(parseHandoffRequest({ ...BODY, attachmentIds: [] }).ok).toBe(true)
    expect(parseHandoffRequest({ ...BODY, prompt: '  \n ' })).toEqual({ ok: false, reason: 'invalid_request' })
    expect(parseHandoffRequest({ ...BODY, prompt: 'x'.repeat(8001) })).toEqual({ ok: false, reason: 'words_too_long' })
    expect(parseHandoffRequest({ ...BODY, clientTurnId: 'short' })).toEqual({ ok: false, reason: 'invalid_request' })
    expect(parseHandoffRequest({ ...BODY, epoch: 0 })).toEqual({ ok: false, reason: 'invalid_request' })
    expect(parseHandoffRequest({ ...BODY, bindingId: '../x' })).toEqual({ ok: false, reason: 'invalid_request' })
    expect(parseHandoffRequest({ ...BODY, packetSha256: 'nothex' })).toEqual({ ok: false, reason: 'invalid_request' })
  })
})

describe('WebKeySignHandoffs', () => {
  const req = () => { const p = parseHandoffRequest(BODY); if (!p.ok) throw new Error(p.reason); return p.request }
  it('claims once; a second claim is refused', () => {
    const h = new WebKeySignHandoffs(() => clock)
    const c = h.create(req(), { provider: 'claude', sessionId: SID })
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.handoffId).toMatch(/^[A-Za-z0-9_-]{24}$/)
    const first = h.claim(c.handoffId)
    expect(first).toMatchObject({ ok: true, handoff: { words: 'Yes, go ahead.', provider: 'claude', sessionId: SID, bindingId: 'b-1', scope: { kind: 'message' }, attachments: [] } })
    expect(h.claim(c.handoffId)).toEqual({ ok: false, reason: 'handoff_claimed' })
  })
  it('lives two minutes: claimable at exp, expired one ms later', () => {
    let at = clock
    const h = new WebKeySignHandoffs(() => at)
    const a = h.create(req(), { provider: 'claude', sessionId: SID })
    const b = h.create(req(), { provider: 'claude', sessionId: SID })
    if (!a.ok || !b.ok) throw new Error('create')
    expect(a.exp).toBe(clock + WEB_KEY_HANDOFF_TTL_MS)
    at = a.exp
    expect(h.claim(a.handoffId).ok).toBe(true)
    at = b.exp + 1
    expect(h.claim(b.handoffId)).toEqual({ ok: false, reason: 'handoff_expired' })
  })
  it('caps open handoffs, refuses an unknown or malformed id and an unsignable scope', () => {
    const h = new WebKeySignHandoffs(() => clock)
    for (let i = 0; i < WEB_KEY_HANDOFF_MAX_OPEN; i++) expect(h.create(req(), { provider: 'claude', sessionId: SID }).ok).toBe(true)
    expect(h.create(req(), { provider: 'claude', sessionId: SID })).toEqual({ ok: false, reason: 'handoff_cap_reached' })
    expect(h.claim('a'.repeat(24))).toEqual({ ok: false, reason: 'handoff_unknown' })
    expect(h.claim('../../etc')).toEqual({ ok: false, reason: 'handoff_unknown' })
    expect(new WebKeySignHandoffs(() => clock).create(req(), { provider: 'claude', sessionId: SID }, { kind: 'install' } as never)).toEqual({ ok: false, reason: 'scope_not_allowed' })
  })
})

describe('routes: handoff create and claim, signer-only key steps', () => {
  let dir: string
  let server: Server
  let base: string
  let enabled: boolean
  let authority: WebKeyAuthority
  let handoffs: WebKeySignHandoffs
  let binding: { provider: string; sessionId: string; epoch: number; targetKey: string } | null
  let extra: Partial<WebKeyRouterDeps>

  async function start(entries = true): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'web-key-handoff-'))
    const anchor = p256()
    seedRegistry(join(dir, 'web-keys.json'), anchor, entries ? [anchoredEntry(anchor, p256())] : [])
    const registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
    authority = new WebKeyAuthority({ registry, nonces: new WebKeyNonces(join(dir, 'n.json'), () => clock), packets: new WebKeyPackets(() => clock), integrity: () => INTEGRITY_OK, selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN, enabled: () => enabled, now: () => clock })
    handoffs = new WebKeySignHandoffs(() => clock)
    const app = express()
    app.use(express.json())
    app.use('/api', createWebKeyRouter({
      authority, enrollments: new WebKeyEnrollments(registry, { now: () => clock, deviceAllowed: () => true }),
      isWebRequest: req => req.headers['x-test-web'] === '1', apiToken: () => 'tok', selfDnsName: () => SELF_DNS, expectedOrigin: () => ORIGIN,
      isSignerRequest: req => req.headers['x-test-signer'] === '1', handoffs, resolveBinding: () => binding,
      ...extra,
    }))
    app.use((_req, res) => { res.status(404).json({ fallthrough: true }) })
    await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  beforeEach(() => { enabled = true; binding = { provider: 'claude', sessionId: SID, epoch: 2, targetKey: TK }; extra = {} })
  afterEach(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) })

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-web': '1', ...headers }, body: JSON.stringify(body) })
  const signer = { 'x-test-signer': '1', origin: ORIGIN }
  async function create(): Promise<string> {
    const res = await post('/api/web-key/handoff', BODY)
    expect(res.status).toBe(201)
    return (await res.json() as { handoffId: string }).handoffId
  }

  it('flag off: both handoff routes fall through exactly as any unknown path (no route exists)', async () => {
    enabled = false
    await start()
    for (const p of ['/api/web-key/handoff', '/api/web-key/handoff/claim']) {
      const res = await post(p, BODY, signer)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ fallthrough: true })
    }
  })
  it('create: web path only; needs an enrolled key; the destination is the binding, never the body', async () => {
    await start()
    expect((await post('/api/web-key/handoff', BODY, { 'x-test-web': '0' })).status).toBe(403)
    const res = await post('/api/web-key/handoff', { ...BODY, provider: 'codex', sessionId: 'someone-else' })
    expect(res.status).toBe(201)
    const b = await res.json() as { handoffId: string; signerUrl: string }
    expect(b.signerUrl).toBe(`${ORIGIN}/#h=${b.handoffId}`)
    expect(b.signerUrl).not.toContain('go ahead')
    const claimed = await (await post('/api/web-key/handoff/claim', { handoffId: b.handoffId }, signer)).json() as { handoff: Record<string, unknown> }
    expect(claimed.handoff).toMatchObject({ provider: 'claude', sessionId: SID, words: 'Yes, go ahead.' })
  })
  it('create: no enrolled phone key, unknown binding, a binding that moved, files', async () => {
    await start(false)
    expect(await (await post('/api/web-key/handoff', BODY)).json()).toEqual({ ok: false, error: 'no_phone_key' })
    await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true })
    await start()
    expect(await (await post('/api/web-key/handoff', { ...BODY, attachmentIds: ['m_1'] })).json()).toEqual({ ok: false, error: 'attachments_not_signable' })
    binding = { provider: 'claude', sessionId: SID, epoch: 3, targetKey: TK }
    expect((await post('/api/web-key/handoff', BODY)).status).toBe(409)
    binding = { provider: 'claude', sessionId: SID, epoch: 2, targetKey: 'other' }
    expect(await (await post('/api/web-key/handoff', BODY)).json()).toEqual({ ok: false, error: 'binding_changed' })
    binding = null
    expect(await (await post('/api/web-key/handoff', BODY)).json()).toEqual({ ok: false, error: 'unknown_binding' })
  })
  it('create with a packet: approve scope, only for the session that asked', async () => {
    await start()
    const pk = authority.packets.create({ action: 'install', artifact: '@gotcos/glasses-server', version: '6.99.31', digest: 'sha256:' + 'a'.repeat(64), channel: 'mac-local' }, { provider: 'claude', sessionId: SID })
    if (!pk.ok) throw new Error(pk.reason)
    const res = await post('/api/web-key/handoff', { ...BODY, packetSha256: pk.packetSha256 })
    expect(res.status).toBe(201)
    const id = (await res.json() as { handoffId: string }).handoffId
    const claimed = await (await post('/api/web-key/handoff/claim', { handoffId: id }, signer)).json() as { handoff: { scope: Record<string, unknown> } }
    expect(claimed.handoff.scope).toEqual({ kind: 'approve', action: 'install', artifact: '@gotcos/glasses-server', version: '6.99.31', digest: 'sha256:' + 'a'.repeat(64), channel: 'mac-local', packetSha256: pk.packetSha256 })
    binding = { provider: 'claude', sessionId: 'another-session', epoch: 2, targetKey: TK }
    expect(await (await post('/api/web-key/handoff', { ...BODY, packetSha256: pk.packetSha256 })).json()).toEqual({ ok: false, error: 'packet_session_mismatch' })
    expect(await (await post('/api/web-key/handoff', { ...BODY, packetSha256: 'b'.repeat(64) })).json()).toEqual({ ok: false, error: 'packet_unknown' })
  })
  it('packet list is authenticated, receiver-filtered and refuses disabled push-main', async () => {
    await start()
    const fields = { action: 'publish', artifact: '@gotcos/glasses-server', version: '7.0.6', digest: 'sha256:' + 'a'.repeat(64), channel: 'npm-latest' }
    const ours = authority.packets.create(fields, { provider: 'claude', sessionId: SID })
    authority.packets.create(fields, { provider: 'codex', sessionId: SID })
    const disabled = authority.packets.create({ ...fields, action: 'push-main', channel: 'git-main' }, { provider: 'claude', sessionId: SID })
    if (!ours.ok || !disabled.ok) throw new Error('packet setup')
    const url = '/api/web-key/packets?provider=claude&sessionId=' + encodeURIComponent(SID)
    expect((await fetch(base + url)).status).toBe(401)
    const listed = await (await fetch(base + url, { headers: { 'x-test-web': '1' } })).json() as any
    expect(listed.packets).toEqual([{ packet: ours.packet, packetSha256: ours.packetSha256 }])
    expect(await (await post('/api/web-key/handoff', { ...BODY, packetSha256: disabled.packetSha256 })).json()).toEqual({ ok: false, error: 'approve_action_not_enabled' })
    clock += 1800001
    expect(await (await post('/api/web-key/handoff', { ...BODY, packetSha256: ours.packetSha256 })).json()).toEqual({ ok: false, error: 'packet_unknown' })
  })
  it('claim: only on the signer listener, only naming the signer origin, only once, only in time', async () => {
    await start()
    const id = await create()
    expect(await (await post('/api/web-key/handoff/claim', { handoffId: id }, { origin: ORIGIN })).json()).toEqual({ ok: false, error: 'signer_origin_required' })
    expect(await (await post('/api/web-key/handoff/claim', { handoffId: id }, { 'x-test-signer': '1', origin: 'https://' + SELF_DNS + ':3143' })).json()).toEqual({ ok: false, error: 'signer_origin_required' })
    expect(await (await post('/api/web-key/handoff/claim', { handoffId: id }, { 'x-test-signer': '1' })).json()).toEqual({ ok: false, error: 'signer_origin_required' })
    expect((await post('/api/web-key/handoff/claim', { handoffId: id }, { ...signer, 'x-test-web': '0' })).status).toBe(403)
    expect((await post('/api/web-key/handoff/claim', { handoffId: id }, signer)).status).toBe(200)
    expect((await post('/api/web-key/handoff/claim', { handoffId: id }, signer)).status).toBe(409)
    const late = await create()
    clock += WEB_KEY_HANDOFF_TTL_MS + 1
    const res = await post('/api/web-key/handoff/claim', { handoffId: late }, signer)
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ ok: false, error: 'handoff_expired' })
  })
  it('claim without a signer-listener check wired is refused (never open by default)', async () => {
    extra = { isSignerRequest: undefined }
    await start()
    const id = await create()
    expect(await (await post('/api/web-key/handoff/claim', { handoffId: id }, signer)).json()).toEqual({ ok: false, error: 'signer_origin_required' })
  })
  it('the phone key steps answer only on the signer listener when the deployment can tell', async () => {
    await start()
    for (const p of ['/api/web-key/nonce', '/api/web-key/enroll/start', '/api/web-key/enroll/prove']) {
      expect(await (await post(p, {})).json(), p).toEqual({ ok: false, error: 'signer_origin_required' })
    }
    expect((await post('/api/web-key/nonce', {}, signer)).status).toBe(201)
  })
  it('without the signer check wired (the pre-Phase-3 rig), the key steps behave as before', async () => {
    extra = { isSignerRequest: undefined }
    await start()
    expect((await post('/api/web-key/nonce', {})).status).toBe(201)
  })
})
