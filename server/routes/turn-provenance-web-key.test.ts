// 6.99.31: a Control Web turn signed by an enrolled phone key, through the REAL /api gate, the REAL
// cookie check, real listeners and the real turn, queue, fork, g2-turns and web-key routers. Each
// test asserts the exact text the session receives and what GET /api/g2-turns answers.
//
// The "phone" is this Mac's LAN address with the own-address list narrowed to loopback, and
// COS_WEB_CONTROL_LAN=1 lets the cookie path accept it (as in turn-provenance-web.test.ts). The
// signing origin is that LAN page's own origin here; production computes
// https://<MagicDNS name>:3143 (index.ts), which needs Phase 0.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-web-key-turns-'))
  process.env.COS_DATA_DIR = dir
  return { dir }
})
import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireApiToken } from '../lib/api-auth.js'
import { mintWebSessionCookieValue, setWebSessionEpochFile, isWebSessionAuthorized, WEB_SESSION_COOKIE_NAME } from '../lib/web-session-auth.js'
import { describeG2Turn, G2TurnLedger, G2TurnProvenance, turnFooter, WEB_UNVOUCHED_REASON, type OriginRequest } from '../lib/g2-turn-provenance.js'
import { createAgentSessionBindingsRouter, type AgentSessionBindingsDeps, type BindingRegistry } from './agent-session-bindings.js'
import { createThreadTurnQueueRouter, type ThreadTurnQueueDeps } from './thread-turn-queue.js'
import { createG2TurnsRouter } from './g2-turns.js'
import { createWebKeyRouter } from './web-key.js'
import { AgentSessionBindingRegistry } from '../lib/agent-session-binding-registry.js'
import { targetKey } from '../lib/agent-session-binding-store.js'
import { deliverOverPeerInbox, __resetPeerInboxSuspects, type TranscriptRowLike } from '../lib/session-peer-inbox.js'
import { deliverQueuedTurnOverLoopback } from '../lib/thread-turn-queue-deliver.js'
import { readQueue, writeQueue } from '../lib/thread-turn-queue-store.js'
import type { Occupancy } from '../lib/thread-occupancy.js'
import { TURN_ATTACHMENTS_HEADING, type TurnAttachmentStore } from '../lib/session-turn-attachments.js'
import { MediaStoreError } from '../lib/media-store.js'
import type { MediaAttachmentRef } from '../../shared/media-attachment.js'
import { WebKeyAuthority } from '../lib/web-key-authority.js'
import { audOf, WebKeyEnrollments, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from '../lib/web-key-registry.js'
import { fingerprintOfSpki, sha256Hex } from '../lib/web-key-envelope.js'
import { anchoredEntry, anchorRegistrationBody, coseOf, credentialIdOf, envelopeFor, INTEGRITY_OK, p256, passkeyAssertion, passkeyOf, seedRegistry, SELF_DNS, signB64, signedHeaders, signJcs, type TestKey } from '../lib/__fixtures__/web-key-kit.js'
import { canonicalJson, type WebTurnEnvelope } from '../../shared/web-turn-envelope.js'
import { createHash, randomBytes } from 'node:crypto'

const LAN = Object.values(networkInterfaces()).flat().find(e => e && e.family === 'IPv4' && !e.internal)?.address ?? null
const TOKEN = 'api-token-web-key-test'
const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const OTHER_SID = 'c3d4e5f6-2222-4333-8444-555566667777'
const NOW = 1_786_000_000_000
const WORDS = 'Yes install and proceed'
const M1 = 'm_' + 'a'.repeat(24)
const M1_PATH = '/Users/me/.cos-glasses/data/media/assets/' + M1 + '/original-normalized.jpg'
const M1_REF: MediaAttachmentRef = { id: M1, kind: 'user_photo', mime: 'image/jpeg', width: 1024, height: 768, createdAt: '2026-11-07T14:00:00.000Z', bytes: 220_000, label: 'Screenshot.png' }
const HASHES: Record<string, string> = { [M1]: 'a1'.repeat(32) }
const files: TurnAttachmentStore = {
  resolveUsable(id) {
    if (id === M1) return { record: { ref: M1_REF }, path: M1_PATH }
    throw new MediaStoreError('media_not_found', 'nope')
  },
  async associate() {},
  async contentSha256(id) {
    if (!(id in HASHES)) throw new MediaStoreError('media_not_found', 'nope')
    return HASHES[id]
  },
}

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
let savedLan: string | undefined
beforeAll(() => {
  savedLan = process.env.COS_WEB_CONTROL_LAN
  process.env.COS_WEB_CONTROL_LAN = '1'
  setWebSessionEpochFile(null)
})
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  __resetPeerInboxSuspects()
  delete process.env.COS_WEB_KEY_AUTHORITY
  delete process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP
  HASHES[M1] = 'a1'.repeat(32)
})
afterAll(() => {
  if (savedLan === undefined) delete process.env.COS_WEB_CONTROL_LAN
  else process.env.COS_WEB_CONTROL_LAN = savedLan
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  rmSync(FIXTURE.dir, { recursive: true, force: true })
})

interface Stack {
  anchor: TestKey
  phone: TestKey
  registry: WebKeyRegistry
  nonces: WebKeyNonces
  authority: WebKeyAuthority
  enrollments: WebKeyEnrollments
  p: G2TurnProvenance
  /** The page origin the phone signs from (set once the rig listens). */
  origin: { value: string | null }
  /** The authority's clock (real time unless a test moves it). */
  clock: { now: () => number }
  ledgerFile: string
}

/** The real switch: COS_WEB_KEY_AUTHORITY, read at call time (no `enabled` override). */
function stack(opts: { seed?: boolean } = {}): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'web-key-stack-'))
  roots.push(dir)
  const anchor = p256()
  const phone = p256()
  // 7.0.9: `seed: false` starts with no registry file at all (a Mac that never registered an anchor).
  if (opts.seed !== false) seedRegistry(join(dir, 'web-keys.json'), anchor, [anchoredEntry(anchor, phone)])
  const registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'web-key-audit.jsonl'))
  const nonces = new WebKeyNonces(join(dir, 'web-key-nonces.json'))
  const origin = { value: null as string | null }
  const clock = { now: () => Date.now() }
  const authority = new WebKeyAuthority({ registry, nonces, packets: new WebKeyPackets(), integrity: () => INTEGRITY_OK, selfDnsName: () => SELF_DNS, expectedOrigin: () => origin.value, now: () => clock.now() })
  const ledgerFile = join(dir, 'g2-turn-ledger.jsonl')
  const p = new G2TurnProvenance({
    ledger: new G2TurnLedger(ledgerFile),
    pairedInstance: () => null,
    ownAddresses: () => ({ addresses: new Set(['127.0.0.1', '::1']), bridgeSubnets: [] }),
    webSession: (req: OriginRequest) => isWebSessionAuthorized({ method: req.method, headers: req.headers, socket: { remoteAddress: req.socket?.remoteAddress ?? undefined } }, TOKEN),
    webKey: authority,
  })
  return { anchor, phone, registry, nonces, authority, enrollments: new WebKeyEnrollments(registry, { deviceAllowed: () => true }), p, origin, clock, ledgerFile }
}

function wire(r: AgentSessionBindingRegistry): BindingRegistry {
  return {
    list: () => r.list(), available: () => r.available(), create: input => r.create(input), activate: (id, now) => r.activate(id, now),
    forceDetach: (id, now) => r.forceDetach(id, now), get: id => r.get(id), checkQueuedPrompt: (claim, now) => r.checkQueuedPrompt(claim, now),
    pin: (id, job, now, extras) => r.pin(id, job, now, extras), unpin: (id, job, now, extras) => r.unpin(id, job, now, extras),
    findTurn: (id, turnId) => r.findTurn(id, turnId), recordTurn: (id, turnId, result, now) => r.recordTurn(id, turnId, result, now),
    orphanPinHold: (p, t, now) => r.orphanPinHold(p, t, now), notePinChild: (id, job, child) => r.notePinChild(id, job, child),
  }
}

let seq = 0
let clock = NOW

interface Rig { lan: string; loop: string; port: number; forks: string[] }

async function rig(s: Stack, over: Partial<AgentSessionBindingsDeps> = {}, gate: () => Occupancy = () => ({ attachable: true, owners: [], reason: null })): Promise<Rig> {
  const root = join(FIXTURE.dir, `bind-${++seq}`)
  mkdirSync(root, { recursive: true })
  const r = AgentSessionBindingRegistry.open({ filePath: join(root, 'agent-session-bindings.json'), now: NOW, onWarn: () => {}, bootId: 'boot-web-key', pinBootReap: () => true })
  const forks: string[] = []
  const d: AgentSessionBindingsDeps = {
    probes: { isAlive: () => true, processStartMs: () => NOW, fileExists: () => true, dirExists: () => true, readDir: () => [], readFile: () => '{}', lockHolders: () => [], cosSpawnedPids: () => new Map(), cursorAgentSession: () => null },
    dirs: { claudeSessionsDir: '/x/.claude/sessions', codexLocksDir: '/x/.codex', cursorChatsDir: '/x/.cursor' },
    now: () => clock, bindings: wire(r), attachEnabled: true, occupancy: gate,
    resolveTarget: () => ({ workspaceFingerprint: 'w', sourceFingerprint: 's' }), nativeHead: () => 'head-1',
    deliverAttachedTurn: async () => ({ status: 'completed', nativeRevisionAfter: 'head-1' }),
    ownership: { record: () => 'recorded', release: () => true },
    newId: () => `n${++seq}`,
    turnAttachmentStore: files,
    forkThread: () => ({ ok: true, newNativeThreadId: 'b7c1d2e3-1111-4222-8333-444455556666', integrity: 'verified_unchanged', detail: 'after:ok', exitCode: 0, stderrClass: 'none', durationMs: 5 }),
    resolveForkWorkspace: () => '/Users/me/project',
    provenance: s.p,
    ...over,
  } as AgentSessionBindingsDeps
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use(express.json())
  app.use('/api', createAgentSessionBindingsRouter(d))
  app.use('/api', createThreadTurnQueueRouter({
    occupancy: () => ({ attachable: false, reason: 'native_thread_working' }),
    turnEnded: () => false, activity: () => 'working', deliver: async () => ({ ok: true }), now: () => 10_000,
    turnAttachmentStore: files, provenance: s.p,
  } as ThreadTurnQueueDeps))
  app.use('/api', createG2TurnsRouter({ provenance: s.p, apiToken: () => TOKEN }))
  app.use('/api', createWebKeyRouter({
    authority: s.authority, enrollments: s.enrollments,
    isWebRequest: req => s.p.originOf(req).origin.client === 'web',
    apiToken: () => TOKEN, selfDnsName: () => SELF_DNS, expectedOrigin: () => s.origin.value,
  }))
  const server: Server = await new Promise(res => { const l = app.listen(0, '0.0.0.0', () => res(l)) })
  closers.push(() => new Promise<void>(res => { server.closeAllConnections(); server.close(() => res()) }))
  const port = (server.address() as AddressInfo).port
  s.origin.value = `http://${LAN}:${port}`
  return { lan: `http://${LAN}:${port}`, loop: `http://127.0.0.1:${port}`, port, forks }
}

function cookie(): string { return `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN).value}` }
function webHeaders(base: string): Record<string, string> { return { cookie: cookie(), 'x-cos-web': '1', origin: base } }
const tokenHeaders = { 'x-cos-token': TOKEN }

async function call(base: string, method: string, path: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
  return { status: res.status, body: parsed, text }
}

async function turn(base: string, clientTurnId: string, headers: Record<string, string>, extra: Record<string, unknown> = {}, prompt = WORDS) {
  clock += 91_000
  const a = await call(base, 'POST', `/api/agent-sessions/claude/${SID}/attach`, { cosSessionId: 'cos-web-1' }, headers)
  expect(a.status, a.text).toBe(201)
  return call(base, 'POST', `/api/agent-sessions/bindings/${a.body.bindingId}/turns`, { clientTurnId, prompt, epoch: a.body.epoch, targetKey: targetKey('claude', SID), ...extra }, headers)
}

async function framesAtLeast(frames: string[], n: number): Promise<void> {
  for (let i = 0; i < 200 && frames.length < n; i += 1) await new Promise(r => setTimeout(r, 10))
}

async function liveSession(): Promise<{ deliverLiveTurn: NonNullable<AgentSessionBindingsDeps['deliverLiveTurn']>; frames: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'peer-'))
  roots.push(dir)
  const socketPath = join(dir, 's.sock')
  const frames: string[] = []
  const rows: TranscriptRowLike[] = []
  const server: NetServer = createNetServer(sock => {
    let raw = ''
    sock.on('data', c => { raw += c })
    sock.on('end', () => {
      for (const line of raw.split('\n').filter(Boolean)) {
        const frame = JSON.parse(line) as { type: string; message?: { content: string } }
        if (frame.type !== 'user' || !frame.message) continue
        frames.push(frame.message.content)
        rows.push({ type: 'queue-operation', operation: 'enqueue', content: frame.message.content, timestamp: new Date().toISOString() })
      }
    })
  })
  await new Promise<void>(r => server.listen(socketPath, () => r()))
  closers.push(() => new Promise<void>(r => server.close(() => r())))
  return {
    frames,
    deliverLiveTurn: async req => {
      const out = await deliverOverPeerInbox({ provider: req.provider, sessionId: req.sessionId, prompt: req.prompt, enabled: true, verifyTimeoutMs: 2_000, clientTurnId: req.clientTurnId }, {
        records: () => [{ pid: 4242, sessionId: SID, socketPath, peerProtocol: 1, entrypoint: 'cli', status: 'idle', startedAt: 1 }],
        token: () => null,
        transcriptTail: () => rows,
        sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))),
      })
      return { ok: out.ok, reason: out.reason, verifiedBy: out.verifiedBy, pid: out.pid }
    },
  }
}

/** An envelope signed by the stack's phone for this turn id, with a fresh server nonce. */
function signed(s: Stack, turnId: string, over: Partial<WebTurnEnvelope> & { words?: string; signer?: TestKey } = {}): Record<string, string> {
  const issued = s.nonces.issue()
  if (!issued.ok) throw new Error(issued.reason)
  const { signer, ...fields } = over
  const env = envelopeFor(s.phone, s.anchor, { nonce: issued.nonce, nowS: Math.floor(s.clock.now() / 1000), origin: s.origin.value!, turnId, sessionId: SID, ...fields })
  return signer ? { ...signedHeaders(s.phone, env), 'x-cos-web-sig': signJcs(signer, env) } : signedHeaders(s.phone, env)
}

const webFooted = (text: string, id: string) => `${text}\n${turnFooter(id, 'web', 'claude')}`
const COMPOSED = `${WORDS}\n\n${TURN_ATTACHMENTS_HEADING}\n- Photo "Screenshot.png" (image/jpeg, 1024x768, 215 KB): "${M1_PATH}"`

describe.skipIf(!LAN)('flag on: a turn signed by the enrolled phone key', () => {
  it('is vouched as web-key, footed COS-WEB with the receiving provider, and the endpoint returns the self-proving envelope', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const res = await turn(r.lan, 'ctwkLive00001', { ...webHeaders(r.lan), ...signed(s, 'ctwkLive00001') })
    expect(res.status, res.text).toBe(200)
    expect(live.frames).toEqual([webFooted(WORDS, 'ctwkLive00001')])
    expect(live.frames[0]).toContain('[COS-WEB turn ctwkLive00001 · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ctwkLive00001 --session <your session id> --provider claude]')
    const v = await call(r.loop, 'GET', '/api/g2-turns/ctwkLive00001', undefined, tokenHeaders)
    expect(v.body).toMatchObject({ found: true, originKind: 'web', verifiedOrigin: true, reason: null, authority: 'web-key', kid: s.phone.kid, scope: { kind: 'message' }, target: { provider: 'claude', sessionId: SID } })
    expect(typeof v.body.envelope).toBe('string')
    expect(v.body.registryEntry).toMatchObject({ kid: s.phone.kid, spki: s.phone.spki })
    expect(typeof v.body.registryEntry.anchorSig).toBe('string')
    // Review B1/B2/B3/B4/W1/W5: what the verifier reads (docs/web-key-verifier-contract.md section 6).
    expect(v.body.registryEntry.passkeySpki).toBe(passkeyOf(s.phone).spki)
    expect(v.body.passkey).toMatchObject({ credentialId: credentialIdOf(s.phone) })
    expect(v.body).toMatchObject({ scopeMeaning: 'conversation', epoch: 0, revoked: [], integrity: INTEGRITY_OK, integrityAtAccept: INTEGRITY_OK })
    expect(v.body.notAuthorized).toEqual(expect.arrayContaining(['install', 'publish', 'push-main', 'sending-messages', 'deleting-data']))
    expect(v.body.anchor).toMatchObject({ spkiSha256: createHash('sha256').update(s.anchor.der).digest('hex'), mature: true })
    expect(v.body.consumeKeys).toEqual([`turn:ctwkLive00001`, `web:${v.body.aud}:${v.body.authId}`])
    expect(typeof v.body.revocationDigest).toBe('string')
    expect(typeof v.body.wordsSha256).toBe('string')
  })

  it.each(['npm-next', 'npm-latest', 'control-appcast', 'hub-alias', 'gotcos-site', 'control-downloads', 'release-docs'])('the production turn route delivers exact scoped publish on %s', async channel => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack(), live = await liveSession(), r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const artifacts: Record<string, string> = { 'gotcos-site': 'gotcos-site-manifest', 'control-downloads': 'cos-control-downloads-manifest', 'release-docs': 'cos-release-docs-manifest' }
    const fields = { action: 'publish', artifact: artifacts[channel] ?? '@gotcos/glasses-server', version: '7.0.6', digest: 'sha256:' + 'a'.repeat(64), channel }
    const made = await call(r.loop, 'POST', '/api/web-key/packets', fields, { ...tokenHeaders, 'x-cos-provider': 'claude', 'x-cos-session-id': SID })
    expect(made.status, made.text).toBe(201)
    const scope = { kind: 'approve' as const, ...fields, action: 'publish' as const, packetSha256: made.body.packetSha256 }
    const id = 'ctwkPub' + channel.replace(/-/g, '')
    const response = await turn(r.lan, id, { ...webHeaders(r.lan), ...signed(s, id, { scope }) })
    expect(response.status, response.text).toBe(200)
    expect(live.frames).toEqual([webFooted(WORDS, id)])
    const read = await call(r.loop, 'GET', '/api/g2-turns/' + id, undefined, tokenHeaders)
    expect(read.body).toMatchObject({ authority: 'web-key', verifiedOrigin: true, scope, target: { provider: 'claude', sessionId: SID } })
    expect(read.body.notAuthorized).toContain('other-artifact-version-digest-or-channel')
    expect(read.body.notAuthorized).toContain('push-main')
    expect(s.authority.packets.get(made.body.packetSha256)).toBeNull()
    const consume = await call(r.loop, 'POST', '/api/g2-turns/' + id + '/consume', { session: SID, provider: 'claude' }, tokenHeaders)
    expect(consume.status, consume.text).toBe(200)
    expect(consume.body).toMatchObject({ consumed: true, turnId: id })
    expect((await call(r.loop, 'POST', '/api/g2-turns/' + id + '/consume', { session: SID, provider: 'claude' }, tokenHeaders)).status).toBe(409)
  })

  it('canary 10 / B3 record relabel over HTTP: a ledger line naming another session or turn reads record_envelope_mismatch', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctwkRelabel01', { ...webHeaders(r.lan), ...signed(s, 'ctwkRelabel01') })).status).toBe(200)
    const line = JSON.parse(readFileSync(s.ledgerFile, 'utf8').trim().split('\n').pop()!)
    for (const edit of [
      (l: any) => { l.target.sessionId = 'b7c1d2e3-1111-4222-8333-444455556666' },
      (l: any) => { l.target.provider = 'codex' },
      (l: any) => { l.turnId = 'ctwkRelabel02' },
    ]) {
      const copy = JSON.parse(JSON.stringify(line)); edit(copy)
      const f = join(mkdtempSync(join(tmpdir(), 'web-key-relabel-')), 'g2-turn-ledger.jsonl')
      roots.push(join(f, '..'))
      writeFileSync(f, `${JSON.stringify(copy)}\n`)
      const p = new G2TurnProvenance({ ledger: new G2TurnLedger(f), pairedInstance: () => null, webKey: s.authority })
      expect(await describeG2Turn(p, copy.turnId, Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'record_envelope_mismatch' })
    }
  })

  it('self-proving: a fresh process reading the ledger from disk still vouches for it (unlike the in-memory seal)', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctwkDurable01', { ...webHeaders(r.lan), ...signed(s, 'ctwkDurable01') })).status).toBe(200)
    const restarted = new G2TurnProvenance({ ledger: new G2TurnLedger(s.ledgerFile), pairedInstance: () => null, webKey: s.authority })
    expect(await describeG2Turn(restarted, 'ctwkDurable01', Date.now())).toMatchObject({ sealed: false, verifiedOrigin: true, authority: 'web-key' })
    // A ledger line edited on disk (its signature swapped for another key's) vouches for nothing.
    const line = JSON.parse(readFileSync(s.ledgerFile, 'utf8').trim().split('\n').pop()!)
    line.webKey.signature = signB64(p256(), Buffer.from(line.webKey.envelope, 'base64url'))
    const forgedFile = join(mkdtempSync(join(tmpdir(), 'web-key-ledger-')), 'g2-turn-ledger.jsonl')
    roots.push(join(forgedFile, '..'))
    writeFileSync(forgedFile, `${JSON.stringify(line)}\n`)
    const forged = new G2TurnProvenance({ ledger: new G2TurnLedger(forgedFile), pairedInstance: () => null, webKey: s.authority })
    // Review B3: the stored authId no longer matches the swapped signature, so the record is caught first...
    expect(await describeG2Turn(forged, 'ctwkDurable01', Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'record_envelope_mismatch' })
    // ...and with the authId recomputed to match, the signature itself is refused.
    line.webKey.authId = createHash('sha256').update(Buffer.from(line.webKey.signature, 'base64url')).digest('hex')
    writeFileSync(forgedFile, `${JSON.stringify(line)}\n`)
    const forged2 = new G2TurnProvenance({ ledger: new G2TurnLedger(forgedFile), pairedInstance: () => null, webKey: s.authority })
    expect(await describeG2Turn(forged2, 'ctwkDurable01', Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'signature_invalid' })
    // Flag turned off: the same record reads exactly as 6.99.29 reads a web record.
    delete process.env.COS_WEB_KEY_AUTHORITY
    expect(await describeG2Turn(restarted, 'ctwkDurable01', Date.now())).toMatchObject({ verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON })
    expect(await describeG2Turn(restarted, 'ctwkDurable01', Date.now())).not.toHaveProperty('authority')
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    // ...and reads revoked the moment its key is revoked.
    s.registry.revoke(s.phone.kid, 'lost', 'token')
    expect(await describeG2Turn(restarted, 'ctwkDurable01', Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'key_revoked' })
  })

  it('with files: vouched when the signed manifest matches; footer after the files block', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const attachments = [{ id: M1, sha256: HASHES[M1], bytes: 220_000, name: 'Screenshot.png' }]
    const res = await turn(r.lan, 'ctwkFiles0001', { ...webHeaders(r.lan), ...signed(s, 'ctwkFiles0001', { attachments }) }, { attachmentIds: [M1] })
    expect(res.status, res.text).toBe(200)
    expect(live.frames).toEqual([webFooted(COMPOSED, 'ctwkFiles0001')])
  })

  const rejects: Array<[string, (s: Stack) => { id: string; headers: Record<string, string>; extra?: Record<string, unknown>; prompt?: string }, string]> = [
    ['wrong key', s => ({ id: 'ctwkRejKey001', headers: signed(s, 'ctwkRejKey001', { signer: p256() }) }), 'signature_invalid'],
    ['wrong destination (signed for another session)', s => ({ id: 'ctwkRejDst001', headers: signed(s, 'ctwkRejDst001', { sessionId: OTHER_SID }) }), 'destination_mismatch'],
    ['wrong aud', s => ({ id: 'ctwkRejAud001', headers: signed(s, 'ctwkRejAud001', { aud: 'f'.repeat(64) }) }), 'aud_mismatch'],
    ['changed words', s => ({ id: 'ctwkRejWrd001', headers: signed(s, 'ctwkRejWrd001'), prompt: `${WORDS}  now` }), 'words_changed'],
    ['changed words, same length', s => ({ id: 'ctwkRejWrd002', headers: signed(s, 'ctwkRejWrd002'), prompt: 'No! install and proceed' }), 'words_changed'],
    ['changed files (another hash)', s => ({ id: 'ctwkRejFil001', headers: signed(s, 'ctwkRejFil001', { attachments: [{ id: M1, sha256: 'c'.repeat(64), bytes: 1, name: 'x' }] }), extra: { attachmentIds: [M1] } }), 'attachments_changed'],
    ['files sent but none signed', s => ({ id: 'ctwkRejFil002', headers: signed(s, 'ctwkRejFil002'), extra: { attachmentIds: [M1] } }), 'attachments_changed'],
    ['another turn id', s => ({ id: 'ctwkRejTid001', headers: signed(s, 'ctwkRejTid999') }), 'turn_id_mismatch'],
    ['expired', s => ({ id: 'ctwkRejExp001', headers: signed(s, 'ctwkRejExp001', { iat: Math.floor(Date.now() / 1000) - 700, exp: Math.floor(Date.now() / 1000) - 1 }) }), 'signature_expired'],
  ]
  for (const [name, make, reason] of rejects) {
    it(`${name}: delivered unvouched with no footer, the record says ${reason}`, async () => {
      process.env.COS_WEB_KEY_AUTHORITY = '1'
      const s = stack()
      const live = await liveSession()
      const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
      const m = make(s)
      const res = await turn(r.lan, m.id, { ...webHeaders(r.lan), ...m.headers }, m.extra ?? {}, m.prompt ?? WORDS)
      expect(res.status, res.text).toBe(200)
      expect(live.frames).toHaveLength(1)
      expect(live.frames[0]).not.toContain('[COS-')
      expect(await describeG2Turn(s.p, m.id, Date.now())).toMatchObject({ originKind: 'web', verifiedOrigin: false, reason })
    })
  }

  it('revoked key: unvouched', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await call(r.loop, 'POST', '/api/web-key/revoke', { kid: s.phone.kid, reason: 'lost phone' }, tokenHeaders)).status).toBe(200)
    expect((await turn(r.lan, 'ctwkRevoked01', { ...webHeaders(r.lan), ...signed(s, 'ctwkRevoked01') })).status).toBe(200)
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(s.p, 'ctwkRevoked01', Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'key_revoked' })
  })

  it('replayed: the same signed headers under a new turn id never vouch twice', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const headers = signed(s, 'ctwkReplay001')
    expect((await turn(r.lan, 'ctwkReplay001', { ...webHeaders(r.lan), ...headers })).status).toBe(200)
    // The identical turn again: answered from the ledger, never sent twice.
    clock += 91_000
    const second = await turn(r.lan, 'ctwkReplay002', { ...webHeaders(r.lan), ...headers })
    expect(second.status, second.text).toBe(200)
    await framesAtLeast(live.frames, 2)
    expect(live.frames).toEqual([webFooted(WORDS, 'ctwkReplay001'), WORDS])
    expect(await describeG2Turn(s.p, 'ctwkReplay002', Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'turn_id_mismatch' })
  })

  it('replayed nonce: a second envelope reusing a spent nonce is unvouched', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const issued = s.nonces.issue()
    if (!issued.ok) throw new Error('nonce')
    const mk = (id: string) => signedHeaders(s.phone, envelopeFor(s.phone, s.anchor, { nonce: issued.nonce, nowS: Math.floor(Date.now() / 1000), origin: s.origin.value!, turnId: id, sessionId: SID }))
    expect((await turn(r.lan, 'ctwkNonce0001', { ...webHeaders(r.lan), ...mk('ctwkNonce0001') })).status).toBe(200)
    expect((await turn(r.lan, 'ctwkNonce0002', { ...webHeaders(r.lan), ...mk('ctwkNonce0002') })).status).toBe(200)
    await framesAtLeast(live.frames, 2)
    expect(live.frames).toEqual([webFooted(WORDS, 'ctwkNonce0001'), WORDS])
    expect(await describeG2Turn(s.p, 'ctwkNonce0002', Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'nonce_spent' })
  })

  it('out-of-list scope: the envelope is refused as scope_not_allowed, delivered unvouched', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const issued = s.nonces.issue()
    if (!issued.ok) throw new Error('nonce')
    const env = { ...envelopeFor(s.phone, s.anchor, { nonce: issued.nonce, nowS: Math.floor(Date.now() / 1000), origin: s.origin.value!, turnId: 'ctwkScope0001', sessionId: SID }), scope: { kind: 'approve', action: 'send-email', artifact: 'a', version: '1', digest: 'd', channel: 'c', packetSha256: 'a'.repeat(64) } }
    expect((await turn(r.lan, 'ctwkScope0001', { ...webHeaders(r.lan), ...signedHeaders(s.phone, env) })).status).toBe(200)
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(s.p, 'ctwkScope0001', Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'scope_not_allowed' })
  })

  it('fork: the child gets the words with no footer, recorded fork_destination_unbound, nonce left unspent', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const forks: string[] = []
    const r = await rig(s, { forkThread: (input: { prompt: string }) => { forks.push(input.prompt); return { ok: true, newNativeThreadId: 'b7c1d2e3-1111-4222-8333-444455556666', integrity: 'verified_unchanged', detail: 'after:ok', exitCode: 0, stderrClass: 'none', durationMs: 5 } } } as unknown as Partial<AgentSessionBindingsDeps>)
    const res = await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/fork`, { cosSessionId: 'cos-web-1', prompt: WORDS, clientForkId: 'cfwkFork00001' }, { ...webHeaders(r.lan), ...signed(s, 'cfwkFork00001') })
    expect([200, 201, 202]).toContain(res.status)
    for (let i = 0; i < 100 && forks.length === 0; i += 1) await new Promise(x => setTimeout(x, 10))
    expect(forks).toEqual([WORDS])
    expect(await describeG2Turn(s.p, 'cfwkFork00001', Date.now())).toMatchObject({ via: 'fork', originKind: 'web', verifiedOrigin: false, reason: 'fork_destination_unbound' })
    // A fork is refused as a fork before anything else is judged: even a badly signed one says so.
    const bad = await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/fork`, { cosSessionId: 'cos-web-1', prompt: WORDS, clientForkId: 'cfwkFork00002' }, { ...webHeaders(r.lan), ...signed(s, 'cfwkFork00002', { signer: p256() }) })
    expect([200, 201, 202]).toContain(bad.status)
    expect(await describeG2Turn(s.p, 'cfwkFork00002', Date.now())).toMatchObject({ via: 'fork', verifiedOrigin: false, reason: 'fork_destination_unbound' })
  })

  it('a token-bearing request carrying a valid envelope is never web: the envelope is ignored', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctwkToken0001', { ...tokenHeaders, ...webHeaders(r.lan), ...signed(s, 'ctwkToken0001') })).status).toBe(200)
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(s.p, 'ctwkToken0001', Date.now())).toMatchObject({ verifiedOrigin: false })
    expect((await describeG2Turn(s.p, 'ctwkToken0001', Date.now()))?.originKind).not.toBe('web')
    // Judged exactly as without the envelope: its own reason, nothing about a web key.
    expect(await describeG2Turn(s.p, 'ctwkToken0001', Date.now())).toMatchObject({ reason: 'no_client_instance' })
  })

  it('a cookie-only web turn (no envelope) is still exactly 6.99.29: recorded, never vouched', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctwkCookie001', webHeaders(r.lan))).status).toBe(200)
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(s.p, 'ctwkCookie001', Date.now())).toMatchObject({ originKind: 'web', verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON })
  })

  it('consume: one server-enforced winner, bound to the receiving session and provider', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctwkSpend0001', { ...webHeaders(r.lan), ...signed(s, 'ctwkSpend0001') })).status).toBe(200)
    expect((await call(r.loop, 'POST', '/api/g2-turns/ctwkSpend0001/consume', { session: OTHER_SID, provider: 'claude' }, tokenHeaders)).body).toMatchObject({ consumed: false, error: 'destination_mismatch' })
    expect((await call(r.loop, 'POST', '/api/g2-turns/ctwkSpend0001/consume', { session: SID, provider: 'codex' }, tokenHeaders)).body).toMatchObject({ consumed: false, error: 'destination_mismatch' })
    const first = await call(r.loop, 'POST', '/api/g2-turns/ctwkSpend0001/consume', { session: SID, provider: 'claude' }, tokenHeaders)
    expect(first).toMatchObject({ status: 200, body: { consumed: true } })
    expect(await call(r.loop, 'POST', '/api/g2-turns/ctwkSpend0001/consume', { session: SID, provider: 'claude' }, tokenHeaders)).toMatchObject({ status: 409, body: { consumed: false, error: 'already_consumed' } })
    expect((await call(r.lan, 'POST', '/api/g2-turns/ctwkSpend0001/consume', { session: SID, provider: 'claude' }, webHeaders(r.lan))).status).toBe(401)
    // Review B3: both namespaces were spent in the one write.
    expect(first.body.keys).toEqual([`turn:ctwkSpend0001`, expect.stringMatching(/^web:[0-9a-f]{64}:[0-9a-f]{64}$/)])
    const store = JSON.parse(readFileSync(join(s.ledgerFile, '..', 'web-key-nonces.json'), 'utf8'))
    for (const k of first.body.keys) expect(store.consumed).toHaveProperty([k])
  })

  it('B4 packets over HTTP: the creating session comes from x-cos-provider and x-cos-session-id, never the body', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const r = await rig(s)
    const fields = { action: 'install', artifact: '@gotcos/glasses-server', version: '6.99.31', digest: `sha256:${'a'.repeat(64)}`, channel: 'mac-local' }
    expect(await call(r.loop, 'POST', '/api/web-key/packets', { ...fields, provider: 'claude', sessionId: SID }, { ...tokenHeaders, 'x-cos-provider': 'claude', 'x-cos-session-id': SID })).toMatchObject({ status: 400, body: { error: 'session_from_context_only' } })
    expect(await call(r.loop, 'POST', '/api/web-key/packets', fields, tokenHeaders)).toMatchObject({ status: 401, body: { error: 'creator_unknown' } })
    const made = await call(r.loop, 'POST', '/api/web-key/packets', fields, { ...tokenHeaders, 'x-cos-provider': 'codex', 'x-cos-session-id': 'sess-ctx-1' })
    expect(made.status, made.text).toBe(201)
    expect(made.body.packet).toMatchObject({ provider: 'codex', sessionId: 'sess-ctx-1' })
  })
})

describe.skipIf(!LAN)('flag on: a parked signed turn is re-checked at its drain', () => {
  async function parkAndDrain(s: Stack, r: Rig, id: string, before: () => void) {
    const park = await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/queued-turns`, { clientTurnId: id, cosSessionId: 'cos-web-1', prompt: WORDS }, { ...webHeaders(r.lan), ...signed(s, id) })
    expect(park.status, park.text).toBe(202)
    expect(await describeG2Turn(s.p, id, Date.now())).toMatchObject({ via: 'queue', verifiedOrigin: true, authority: 'web-key' })
    before()
    const row = readQueue('claude', SID, 10_000).find(t => t.clientTurnId === id)!
    clock += 91_000
    expect(await deliverQueuedTurnOverLoopback(row, r.port, TOKEN, t => s.p.issueCarry(t))).toEqual({ ok: true })
    writeQueue('claude', SID, [])
  }

  it('in date and enrolled: drained footed COS-WEB, still vouched', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    await parkAndDrain(s, r, 'ctwkQueue0001', () => {})
    expect(live.frames).toEqual([webFooted(WORDS, 'ctwkQueue0001')])
    expect(await describeG2Turn(s.p, 'ctwkQueue0001', Date.now())).toMatchObject({ via: 'drain-live', verifiedOrigin: true, authority: 'web-key' })
  })

  it('mutable queued row scope and target cannot replace the approved publish scope or receiver', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack(), live = await liveSession(), r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const fields = { action: 'publish' as const, artifact: '@gotcos/glasses-server', version: '7.0.6', digest: 'sha256:' + 'a'.repeat(64), channel: 'npm-latest' }
    const made = s.authority.packets.create(fields, { provider: 'claude', sessionId: SID })
    expect(made.ok).toBe(true); if (!made.ok) return
    const scope = { kind: 'approve' as const, ...fields, packetSha256: made.packetSha256 }, id = 'ctwkQueuePub1'
    expect((await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/queued-turns`, { clientTurnId: id, cosSessionId: 'cos-web-1', prompt: WORDS }, { ...webHeaders(r.lan), ...signed(s, id, { scope }) })).status).toBe(202)
    const original = readQueue('claude', SID, 10_000).find(t => t.clientTurnId === id)!
    const forged = { ...scope, channel: 'npm-next', version: '99.0.0' }
    writeQueue('claude', SID, [{ ...original, scope: forged, webKey: { scope: forged }, target: { provider: 'codex', sessionId: OTHER_SID } } as any])
    const diskRow = readQueue('claude', SID, 10_000)[0]
    expect(s.p.queuedVerdict('claude', SID, id, WORDS)).toMatchObject({ verifiedOrigin: true, webKey: { scope } })
    expect(s.p.queuedVerdict('codex', OTHER_SID, id, WORDS)).toBeNull()
    const movedCarry = s.p.issueCarry({ ...diskRow, provider: 'codex', threadId: OTHER_SID })!
    expect(s.p.takeCarry(movedCarry, id, WORDS)).toMatchObject({ verdict: null, seal: null })
    clock += 91_000
    expect(await deliverQueuedTurnOverLoopback(diskRow, r.port, TOKEN, row => s.p.issueCarry(row))).toEqual({ ok: true })
    expect(live.frames).toEqual([webFooted(WORDS, id)])
    expect(await describeG2Turn(s.p, id, Date.now())).toMatchObject({ via: 'drain-live', verifiedOrigin: true, authority: 'web-key', scope, target: { provider: 'claude', sessionId: SID } })
    writeQueue('claude', SID, [])
  })
  it('drained after the signature expired: delivered unvouched, never re-dated', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    await parkAndDrain(s, r, 'ctwkQueueExp1', () => { const later = Date.now() + 11 * 60_000; s.clock.now = () => later })
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(s.p, 'ctwkQueueExp1', Date.now())).toMatchObject({ via: 'drain-live', verifiedOrigin: false, reason: 'signature_expired' })
  })

  it('key revoked while parked: delivered unvouched', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    await parkAndDrain(s, r, 'ctwkQueueRev1', () => {
      s.registry.revoke(s.phone.kid, 'lost', 'web')
      // The Cursor Stop hand-off reads the parked origin through queuedVerdict: re-checked there too.
      expect(s.p.queuedVerdict('claude', SID, 'ctwkQueueRev1', WORDS)).toMatchObject({ verifiedOrigin: false, reason: 'key_revoked' })
    })
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(s.p, 'ctwkQueueRev1', Date.now())).toMatchObject({ verifiedOrigin: false, reason: 'key_revoked' })
  })

  it('an edit from the phone without a fresh signature is unvouched; with one it is vouched again', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const r = await rig(s)
    const id = 'ctwkQueueEdt1'
    expect((await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/queued-turns`, { clientTurnId: id, cosSessionId: 'cos-web-1', prompt: WORDS }, { ...webHeaders(r.lan), ...signed(s, id) })).status).toBe(202)
    expect((await call(r.lan, 'PATCH', `/api/agent-sessions/claude/${SID}/queued-turns/${id}`, { prompt: 'Actually wait' }, webHeaders(r.lan))).status).toBe(200)
    expect(s.p.queuedVerdict('claude', SID, id, 'Actually wait')).toMatchObject({ verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON })
    expect((await call(r.lan, 'PATCH', `/api/agent-sessions/claude/${SID}/queued-turns/${id}`, { prompt: 'Actually go' }, { ...webHeaders(r.lan), ...signed(s, id, { words: 'Actually go' }) })).status).toBe(200)
    expect(s.p.queuedVerdict('claude', SID, id, 'Actually go')).toMatchObject({ verifiedOrigin: true, authority: 'web-key' })
    writeQueue('claude', SID, [])
  })
})

describe.skipIf(!LAN)('flag on: Send again', () => {
  it('a copy needs a fresh signature over its new id; without one it is unvouched (resend_not_reverified)', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    process.env.COS_QUEUE_RESEND = '1'
    try {
      const s = stack()
      const r = await rig(s)
      const thread = `thr-wk-${++seq}`
      await call(r.loop, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: 'ctwkResend001', cosSessionId: 'cos-web-1', prompt: WORDS }, tokenHeaders)
      const q = readQueue('claude', thread, 10_000)
      q[0] = { ...q[0], status: 'refused', settledAt: 10_000, reason: 'x' }
      writeQueue('claude', thread, q)
      const plain = await call(r.lan, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns/ctwkResend001/resend`, { clientTurnId: 'ctwkResend002', cosSessionId: 'cos-web-1' }, webHeaders(r.lan))
      expect(plain.status, plain.text).toBe(200)
      expect(s.p.queuedVerdict('claude', thread, 'ctwkResend002', WORDS)).toMatchObject({ verifiedOrigin: false })
      // A second refused row, sent again with a signature over the copy's id and this thread.
      await call(r.loop, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: 'ctwkResend003', cosSessionId: 'cos-web-1', prompt: WORDS }, tokenHeaders)
      const q2 = readQueue('claude', thread, 10_000).map(t => t.clientTurnId === 'ctwkResend003' ? { ...t, status: 'refused' as const, settledAt: 10_000, reason: 'x' } : t)
      writeQueue('claude', thread, q2)
      const signedResend = await call(r.lan, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns/ctwkResend003/resend`, { clientTurnId: 'ctwkResend004', cosSessionId: 'cos-web-1' }, { ...webHeaders(r.lan), ...signed(s, 'ctwkResend004', { sessionId: thread }) })
      expect(signedResend.status, signedResend.text).toBe(200)
      expect(s.p.queuedVerdict('claude', thread, 'ctwkResend004', WORDS)).toMatchObject({ verifiedOrigin: true, authority: 'web-key' })
      expect(await describeG2Turn(s.p, 'ctwkResend004', Date.now())).toMatchObject({ via: 'queue-resend', verifiedOrigin: true, authority: 'web-key' })
      writeQueue('claude', thread, [])
    } finally { delete process.env.COS_QUEUE_RESEND }
  })
})

describe('defense in depth: a web verdict is vouched only through acceptWebKey', () => {
  it('a hand-made web verdict claiming verifiedOrigin, with no accepted envelope, is recorded unvouched and never footed', () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const forged = { origin: { remote: '100.64.0.9', loopback: false, ownAddress: false, clientInstance: null, client: 'web' as const, tokenPresented: false, webSession: true }, verifiedOrigin: true, reason: null, judgedAt: Date.now() }
    expect(s.p.footed(WORDS, 'ctwkForged001', forged, 'claude')).toBe(WORDS)
    expect(s.p.record({ turnId: 'ctwkForged001', prompt: WORDS, verdict: forged, provider: 'claude', sessionId: SID, via: 'live' })).toMatchObject({ verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON })
    const half = { ...forged, authority: 'web-key' as const }
    expect(s.p.footed(WORDS, 'ctwkForged002', half, 'claude')).toBe(WORDS)
    expect(s.p.record({ turnId: 'ctwkForged002', prompt: WORDS, verdict: half, provider: 'claude', sessionId: SID, via: 'live' })).toMatchObject({ verifiedOrigin: false })
  })
})

describe.skipIf(!LAN)('flag off: identical to 6.99.29', () => {
  it('a signed turn is recorded exactly like a cookie-only turn: no footer, WEB_UNVOUCHED_REASON, no authority, no envelope stored', async () => {
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctwkOffSign01', { ...webHeaders(r.lan), ...signed(s, 'ctwkOffSign01') })).status).toBe(200)
    expect((await turn(r.lan, 'ctwkOffPlain1', webHeaders(r.lan))).status).toBe(200)
    await framesAtLeast(live.frames, 2)
    expect(live.frames).toEqual([WORDS, WORDS])
    const strip = (a: Record<string, unknown> | null) => { const { turnId: _t, createdAt: _c, originJudgedAt: _o, ageMs: _a, ...rest } = a ?? {}; return rest }
    const signedAnswer = await describeG2Turn(s.p, 'ctwkOffSign01', Date.now())
    expect(signedAnswer).toMatchObject({ originKind: 'web', verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON })
    expect(strip(signedAnswer)).toEqual(strip(await describeG2Turn(s.p, 'ctwkOffPlain1', Date.now())))
    const lines = readFileSync(s.ledgerFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => l.reason)).toEqual([WEB_UNVOUCHED_REASON, WEB_UNVOUCHED_REASON])
    for (const line of lines) {
      expect(line).not.toHaveProperty('authority')
      expect(line).not.toHaveProperty('webKey')
      expect(Object.keys(line).sort()).toEqual(['createdAt', 'origin', 'originJudgedAt', 'originKind', 'reason', 'target', 'textSha256', 'turnId', 'verifiedOrigin', 'via'])
    }
  })

  it('a signed fork and a signed Send again ledger exactly what 6.99.29 ledgered (WEB_UNVOUCHED_REASON)', async () => {
    process.env.COS_QUEUE_RESEND = '1'
    try {
      const s = stack()
      const r = await rig(s)
      const fork = await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/fork`, { cosSessionId: 'cos-web-1', prompt: WORDS, clientForkId: 'cfwkOffFork01' }, { ...webHeaders(r.lan), ...signed(s, 'cfwkOffFork01') })
      expect([200, 201, 202]).toContain(fork.status)
      const thread = `thr-wkoff-${++seq}`
      await call(r.loop, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: 'ctwkOffRsnd01', cosSessionId: 'cos-web-1', prompt: WORDS }, tokenHeaders)
      writeQueue('claude', thread, readQueue('claude', thread, 10_000).map(t => ({ ...t, status: 'refused' as const, settledAt: 10_000, reason: 'x' })))
      expect((await call(r.lan, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns/ctwkOffRsnd01/resend`, { clientTurnId: 'ctwkOffRsnd02', cosSessionId: 'cos-web-1' }, { ...webHeaders(r.lan), ...signed(s, 'ctwkOffRsnd02', { sessionId: thread }) })).status).toBe(200)
      for (let i = 0; i < 100 && !readFileSync(s.ledgerFile, 'utf8').includes('cfwkOffFork01'); i += 1) await new Promise(x => setTimeout(x, 10))
      const lines = readFileSync(s.ledgerFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.originKind === 'web')
      expect(lines.map(l => [l.turnId, l.reason]).sort()).toEqual([['cfwkOffFork01', WEB_UNVOUCHED_REASON], ['ctwkOffRsnd02', WEB_UNVOUCHED_REASON]])
      writeQueue('claude', thread, [])
    } finally { delete process.env.COS_QUEUE_RESEND }
  })

  it('a parked signed turn drains unfooted; no nonce is spent', async () => {
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const issued = s.nonces.issue()
    if (!issued.ok) throw new Error('nonce')
    const env = envelopeFor(s.phone, s.anchor, { nonce: issued.nonce, nowS: Math.floor(Date.now() / 1000), origin: s.origin.value!, turnId: 'ctwkOffQueue1', sessionId: SID })
    expect((await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/queued-turns`, { clientTurnId: 'ctwkOffQueue1', cosSessionId: 'cos-web-1', prompt: WORDS }, { ...webHeaders(r.lan), ...signedHeaders(s.phone, env) })).status).toBe(202)
    const row = readQueue('claude', SID, 10_000).find(t => t.clientTurnId === 'ctwkOffQueue1')!
    clock += 91_000
    expect(await deliverQueuedTurnOverLoopback(row, r.port, TOKEN, t => s.p.issueCarry(t))).toEqual({ ok: true })
    expect(live.frames).toEqual([WORDS])
    expect(s.nonces.consume(issued.nonce, 'probe')).toBe('ok')
    writeQueue('claude', SID, [])
  })

  it('no /api/web-key route exists and consume is not a route', async () => {
    const s = stack()
    const r = await rig(s)
    for (const [method, path] of [['GET', '/api/web-key/status'], ['POST', '/api/web-key/nonce'], ['POST', '/api/web-key/enroll/start'], ['POST', '/api/web-key/anchor'], ['POST', '/api/web-key/revoke']] as const) {
      expect((await call(r.loop, method, path, method === 'POST' ? {} : undefined, tokenHeaders)).status, path).toBe(404)
    }
    const consume = await call(r.loop, 'POST', '/api/g2-turns/ctwkAnything1/consume', { session: SID, provider: 'claude' }, tokenHeaders)
    expect(consume.status).toBe(404)
    expect(consume.body).toBeNull()
    expect(consume.text).toContain('Cannot POST')
    // The packets route and the anchor bootstrap do not exist either.
    for (const [method, path] of [['POST', '/api/web-key/packets'], ['GET', '/api/web-key/packets'], ['GET', '/api/web-key/enroll/pending']] as const) {
      expect((await call(r.loop, method, path, method === 'POST' ? {} : undefined, tokenHeaders)).status, path).toBe(404)
    }
  })

  it('the turn answer for a web record has exactly the 6.99.29 key set (no web-key field leaks with the flag unset)', async () => {
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctwkOffKeys01', { ...webHeaders(r.lan), ...signed(s, 'ctwkOffKeys01') })).status).toBe(200)
    const v = await call(r.loop, 'GET', '/api/g2-turns/ctwkOffKeys01', undefined, tokenHeaders)
    expect(Object.keys(v.body).sort()).toEqual(['ageMs', 'createdAt', 'found', 'origin', 'originJudgedAt', 'originKind', 'reason', 'sealed', 'target', 'textSha256', 'turnId', 'verifiedOrigin', 'via'])
    expect(v.body.reason).toBe(WEB_UNVOUCHED_REASON)
  })
})

describe.skipIf(!LAN)('flag on: the enrollment endpoints', () => {
  it('the full ceremony over HTTP: phone start and prove (web only), Control pending and approve (token + anchor signature)', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const r = await rig(s)
    const phone2 = p256()
    // An agent with the token cannot start an enrollment, from anywhere.
    expect((await call(r.lan, 'POST', '/api/web-key/enroll/start', { spki: phone2.spki, label: 'Agent' }, tokenHeaders)).body).toMatchObject({ error: 'web_origin_required' })
    // A cookie over loopback (this Mac) is not the phone either.
    expect((await call(r.loop, 'POST', '/api/web-key/enroll/start', { spki: phone2.spki, label: 'Mac' }, webHeaders(r.loop))).body).toMatchObject({ error: 'web_origin_required' })
    const r2 = randomBytes(32)
    const start = await call(r.lan, 'POST', '/api/web-key/enroll/start', { spki: phone2.spki, label: 'iPad', sasCommit: createHash('sha256').update(r2).digest('hex') }, webHeaders(r.lan))
    expect(start.status, start.text).toBe(201)
    const pk = passkeyOf(phone2)
    const msg = WebKeyEnrollments.proofMessage({ ...start.body, phoneNonce: r2.toString('base64url'), passkeyCredentialId: credentialIdOf(phone2), passkeySpkiSha256: createHash('sha256').update(pk.der).digest('hex') })
    const assertion = passkeyAssertion(pk, createHash('sha256').update(canonicalJson(msg)).digest(), { credentialId: credentialIdOf(phone2), origin: start.body.origin })
    const proveBody = { enrollId: start.body.enrollId, signature: signJcs(phone2, msg), phoneNonce: r2.toString('base64url'), passkey: { credentialId: credentialIdOf(phone2), publicKey: coseOf(pk), assertion } }
    expect((await call(r.loop, 'POST', '/api/web-key/enroll/prove', proveBody, tokenHeaders)).body).toMatchObject({ error: 'web_origin_required' })
    const proved = await call(r.lan, 'POST', '/api/web-key/enroll/prove', proveBody, webHeaders(r.lan))
    expect(proved.body).toMatchObject({ ok: true })
    // Control reads the pending card with the token; the browser cannot.
    expect((await call(r.lan, 'GET', '/api/web-key/enroll/pending', undefined, webHeaders(r.lan))).status).toBe(401)
    const pending = await call(r.loop, 'GET', '/api/web-key/enroll/pending', undefined, tokenHeaders)
    // Review W4: only the approval and its bytes; the displayed values are inside them.
    expect(pending.body.pending.approval).toMatchObject({ sas: proved.body.sas, fingerprint: proved.body.fingerprint, kid: phone2.kid, label: 'iPad' })
    expect(pending.body.pending).not.toHaveProperty('sas')
    // The token alone does not approve.
    expect((await call(r.loop, 'POST', '/api/web-key/enroll/approve', { enrollId: start.body.enrollId }, tokenHeaders)).body).toMatchObject({ error: 'anchor_signature_invalid' })
    const anchorSig = signB64(s.anchor, Buffer.from(pending.body.pending.approvalJcs, 'base64url'))
    expect((await call(r.lan, 'POST', '/api/web-key/enroll/approve', { enrollId: start.body.enrollId, anchorSig }, webHeaders(r.lan))).status).toBe(401)
    expect((await call(r.loop, 'POST', '/api/web-key/enroll/approve', { enrollId: start.body.enrollId, anchorSig }, tokenHeaders)).body).toMatchObject({ ok: true, kid: phone2.kid })
    const keys = await call(r.lan, 'GET', '/api/web-key/keys', undefined, webHeaders(r.lan))
    expect(keys.body.keys.filter((k: { active: boolean }) => k.active).map((k: { kid: string }) => k.kid).sort()).toEqual([s.phone.kid, phone2.kid].sort())
  })

  it('B1 anchor registration: loopback socket, the token and the anchor\'s self-signature; never the phone, never a LAN socket', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const r = await rig(s)
    const next = p256()
    const body = anchorRegistrationBody(next, Date.now())
    // Not from the tailnet/LAN socket, token or cookie.
    for (const headers of [tokenHeaders, webHeaders(r.lan)]) {
      expect(await call(r.lan, 'POST', '/api/web-key/anchor', body, headers)).toMatchObject({ status: 403, body: { error: 'loopback_required' } })
    }
    // Not over loopback without the token (a cookie is not enough), nor behind a local proxy.
    expect(await call(r.loop, 'POST', '/api/web-key/anchor', body, webHeaders(r.loop))).toMatchObject({ status: 401, body: { error: 'token_required' } })
    expect(await call(r.loop, 'POST', '/api/web-key/anchor', body, { ...tokenHeaders, 'x-forwarded-for': '100.64.0.9' })).toMatchObject({ status: 403, body: { error: 'loopback_required' } })
    // The token without the anchor's own signature registers nothing.
    expect(await call(r.loop, 'POST', '/api/web-key/anchor', { ...body, signature: anchorRegistrationBody(p256(), Date.now()).signature }, tokenHeaders)).toMatchObject({ status: 403, body: { error: 'anchor_signature_invalid' } })
    expect(s.registry.anchor()?.b64).toBe(s.anchor.spki)
    const ok = await call(r.loop, 'POST', '/api/web-key/anchor', body, tokenHeaders)
    expect(ok.status, ok.text).toBe(201)
    expect(ok.body).toMatchObject({ ok: true, replaced: true, maturesAt: ok.body.setAt + 86_400_000 })
    expect(s.registry.anchor()?.b64).toBe(next.spki)
    // A fresh anchor is not mature: the status says so, and the old key was revoked by the replacement.
    const status = await call(r.loop, 'GET', '/api/web-key/status', undefined, tokenHeaders)
    expect(status.body).toMatchObject({ anchorRegistered: true, anchorMature: false })
    expect(s.registry.activeCount(SELF_DNS)).toBe(0)
  })

  it('nonces only for the phone; revoke-all from the phone bumps the epoch and voids the key', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const r = await rig(s)
    expect((await call(r.loop, 'POST', '/api/web-key/nonce', {}, tokenHeaders)).body).toMatchObject({ error: 'web_origin_required' })
    expect((await call(r.lan, 'POST', '/api/web-key/nonce', {}, webHeaders(r.lan))).status).toBe(201)
    expect((await call(r.lan, 'POST', '/api/web-key/revoke-all', {}, webHeaders(r.lan))).body).toMatchObject({ ok: true, epoch: 1 })
    expect(s.registry.activeCount(SELF_DNS)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// 7.0.9: COS_WEB_KEY_ANCHOR_BOOTSTRAP. With the authority off, only the anchor status and the anchor
// registration answer; every other surface refuses exactly as with both switches off.
// ---------------------------------------------------------------------------------------------

/** Every web-key surface except status and anchor, plus the consume route, as [method, path, base, headers kind]. */
const NON_BOOTSTRAP_ROUTES: ReadonlyArray<readonly [string, string, Record<string, unknown> | undefined]> = [
  ['POST', '/api/web-key/enroll/start', { spki: 'x', label: 'Phone' }],
  ['POST', '/api/web-key/enroll/prove', { enrollId: 'x' }],
  ['GET', '/api/web-key/enroll/status?enrollId=x', undefined],
  ['GET', '/api/web-key/enroll/pending', undefined],
  ['POST', '/api/web-key/enroll/approve', { enrollId: 'x', anchorSig: 'x' }],
  ['GET', '/api/web-key/keys', undefined],
  ['POST', '/api/web-key/revoke', { kid: 'x' }],
  ['POST', '/api/web-key/revoke-all', {}],
  ['POST', '/api/web-key/nonce', {}],
  ['POST', '/api/web-key/packets', { action: 'publish' }],
  ['GET', '/api/web-key/packets', undefined],
  ['POST', '/api/web-key/handoff', {}],
  ['POST', '/api/web-key/handoff/claim', { handoffId: 'x' }],
  ['POST', '/api/g2-turns/ctwkAnything1/consume', { session: SID, provider: 'claude' }],
]

/** Each non-bootstrap route over loopback with the token and over the LAN with the web cookie: [status, text]. */
async function refusals(r: Rig): Promise<Array<[string, number, string]>> {
  const out: Array<[string, number, string]> = []
  for (const [method, path, body] of NON_BOOTSTRAP_ROUTES) {
    const a = await call(r.loop, method, path, body, tokenHeaders)
    const b = await call(r.lan, method, path, body, webHeaders(r.lan))
    out.push([`token ${method} ${path}`, a.status, a.text], [`web ${method} ${path}`, b.status, b.text])
  }
  return out
}

describe.skipIf(!LAN)('anchor bootstrap only (COS_WEB_KEY_ANCHOR_BOOTSTRAP=1, COS_WEB_KEY_AUTHORITY off)', () => {
  it('bootstrap: enrollment, key list, revoke, nonce, packets, handoff and consume refuse exactly as with both switches off (404 fall-through)', async () => {
    const off = stack()
    const offRig = await rig(off)
    const expected = await refusals(offRig)
    for (const [, status] of expected) expect(status).toBe(404)
    process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP = '1'
    const s = stack()
    const before = readFileSync(join(s.ledgerFile, '..', 'web-keys.json'), 'utf8')
    const r = await rig(s)
    const got = await refusals(r)
    // Same codes and same bodies (the rig's port differs; the 404 page names only the path).
    expect(got).toEqual(expected)
    // Device changes did not happen: the seeded phone is still active, the epoch and file untouched.
    expect(s.registry.activeCount(SELF_DNS)).toBe(1)
    expect(s.registry.epoch()).toBe(0)
    expect(readFileSync(join(s.ledgerFile, '..', 'web-keys.json'), 'utf8')).toBe(before)
  })

  it('bootstrap: the status reply is exactly {ok, enabled false, mode bootstrap, anchor fields, aud, origin, epoch}, token only', async () => {
    process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP = '1'
    const s = stack({ seed: false })
    const r = await rig(s)
    const empty = await call(r.loop, 'GET', '/api/web-key/status', undefined, tokenHeaders)
    expect(empty.status, empty.text).toBe(200)
    expect(empty.body).toEqual({ ok: true, enabled: false, mode: 'bootstrap', anchorRegistered: false, anchorMature: false, anchorSetAt: null, aud: null, origin: s.origin.value, epoch: 0 })
    // A web page cannot read it in bootstrap (nothing on the web needs it while no phone can enroll).
    expect(await call(r.lan, 'GET', '/api/web-key/status', undefined, webHeaders(r.lan))).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
    expect(await call(r.loop, 'GET', '/api/web-key/status', undefined, webHeaders(r.loop))).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
  })

  it('bootstrap: anchor registration works (loopback, token, self-signature), records server setAt, and status reports it', async () => {
    process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP = '1'
    const s = stack({ seed: false })
    const r = await rig(s)
    const mac = p256()
    const body = anchorRegistrationBody(mac, Date.now())
    // The same gates as with the authority on.
    expect(await call(r.lan, 'POST', '/api/web-key/anchor', body, tokenHeaders)).toMatchObject({ status: 403, body: { error: 'loopback_required' } })
    expect(await call(r.loop, 'POST', '/api/web-key/anchor', body, webHeaders(r.loop))).toMatchObject({ status: 401, body: { error: 'token_required' } })
    expect(await call(r.loop, 'POST', '/api/web-key/anchor', body, { ...tokenHeaders, 'x-forwarded-for': '100.64.0.9' })).toMatchObject({ status: 403, body: { error: 'loopback_required' } })
    expect(await call(r.loop, 'POST', '/api/web-key/anchor', { ...body, signature: anchorRegistrationBody(p256(), Date.now()).signature }, tokenHeaders)).toMatchObject({ status: 403, body: { error: 'anchor_signature_invalid' } })
    expect(s.registry.anchor()).toBeNull()
    const t0 = Date.now()
    const ok = await call(r.loop, 'POST', '/api/web-key/anchor', body, tokenHeaders)
    expect(ok.status, ok.text).toBe(201)
    expect(ok.body).toEqual({ ok: true, spkiSha256: sha256Hex(mac.der), fingerprint: fingerprintOfSpki(mac.der), setAt: ok.body.setAt, replaced: false, maturesAt: ok.body.setAt + 86_400_000 })
    expect(ok.body.setAt).toBeGreaterThanOrEqual(t0)
    expect(ok.body.setAt).toBeLessThanOrEqual(Date.now())
    const status = await call(r.loop, 'GET', '/api/web-key/status', undefined, tokenHeaders)
    expect(status.body).toEqual({ ok: true, enabled: false, mode: 'bootstrap', anchorRegistered: true, anchorMature: false, anchorSetAt: ok.body.setAt, aud: audOf(mac.der, SELF_DNS), origin: s.origin.value, epoch: 0 })
  })

  it('bootstrap: a signed web turn is recorded exactly like a cookie-only turn (no vouch, no footer, no nonce spent)', async () => {
    process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP = '1'
    const s = stack()
    expect(s.authority.enabled()).toBe(false)
    expect(s.authority.mode()).toBe('bootstrap')
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const issued = s.nonces.issue()
    if (!issued.ok) throw new Error('nonce')
    const env = envelopeFor(s.phone, s.anchor, { nonce: issued.nonce, nowS: Math.floor(Date.now() / 1000), origin: s.origin.value!, turnId: 'ctwkBootSign1', sessionId: SID })
    expect((await turn(r.lan, 'ctwkBootSign1', { ...webHeaders(r.lan), ...signedHeaders(s.phone, env) })).status).toBe(200)
    expect((await turn(r.lan, 'ctwkBootPlain', webHeaders(r.lan))).status).toBe(200)
    await framesAtLeast(live.frames, 2)
    expect(live.frames).toEqual([WORDS, WORDS])
    const strip = (a: Record<string, unknown> | null) => { const { turnId: _t, createdAt: _c, originJudgedAt: _o, ageMs: _a, ...rest } = a ?? {}; return rest }
    const signedAnswer = await describeG2Turn(s.p, 'ctwkBootSign1', Date.now())
    expect(signedAnswer).toMatchObject({ originKind: 'web', verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON })
    expect(strip(signedAnswer)).toEqual(strip(await describeG2Turn(s.p, 'ctwkBootPlain', Date.now())))
    for (const line of readFileSync(s.ledgerFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))) {
      expect(line).not.toHaveProperty('authority')
      expect(line).not.toHaveProperty('webKey')
    }
    expect(s.nonces.consume(issued.nonce, 'probe')).toBe('ok')
  })

  it('both off (unset, and =0 for either): status and anchor are not routes', async () => {
    for (const env of [{}, { COS_WEB_KEY_ANCHOR_BOOTSTRAP: '0' }, { COS_WEB_KEY_ANCHOR_BOOTSTRAP: '0', COS_WEB_KEY_AUTHORITY: '0' }, { COS_WEB_KEY_ANCHOR_BOOTSTRAP: 'yes' }]) {
      delete process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP; delete process.env.COS_WEB_KEY_AUTHORITY
      Object.assign(process.env, env)
      const s = stack({ seed: false })
      const r = await rig(s)
      const status = await call(r.loop, 'GET', '/api/web-key/status', undefined, tokenHeaders)
      expect(status.status, JSON.stringify(env)).toBe(404)
      expect(status.text).toContain('Cannot GET')
      const anchor = await call(r.loop, 'POST', '/api/web-key/anchor', anchorRegistrationBody(p256(), Date.now()), tokenHeaders)
      expect(anchor.status, JSON.stringify(env)).toBe(404)
      expect(anchor.text).toContain('Cannot POST')
      expect(s.registry.anchor()).toBeNull()
    }
  })

  it('authority on: the status reply is today\'s, byte for byte, whether or not the bootstrap switch is also on', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const r = await rig(s)
    const a = await call(r.loop, 'GET', '/api/web-key/status', undefined, tokenHeaders)
    expect(a.status).toBe(200)
    expect(Object.keys(a.body).sort()).toEqual(['activeKeys', 'anchorMature', 'anchorRefusal', 'anchorRegistered', 'aud', 'enabled', 'epoch', 'nonceStoreReadable', 'ok', 'origin', 'registryReadable'])
    expect(a.body).toMatchObject({ ok: true, enabled: true, anchorRegistered: true, activeKeys: 1 })
    expect(a.body).not.toHaveProperty('mode')
    // The web path still reads it with the authority on (today's behaviour).
    expect((await call(r.lan, 'GET', '/api/web-key/status', undefined, webHeaders(r.lan))).status).toBe(200)
    process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP = '1'
    const b = await call(r.loop, 'GET', '/api/web-key/status', undefined, tokenHeaders)
    expect(b.text).toBe(a.text)
    expect((await call(r.lan, 'POST', '/api/web-key/nonce', {}, webHeaders(r.lan))).status).toBe(201)
  })

  it('anchor reuse: the record written under bootstrap is exactly what the authority reads, and it approves a phone with no re-registration', async () => {
    process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP = '1'
    const s = stack({ seed: false })
    const r = await rig(s)
    const mac = p256()
    const reg = await call(r.loop, 'POST', '/api/web-key/anchor', anchorRegistrationBody(mac, Date.now()), tokenHeaders)
    expect(reg.status, reg.text).toBe(201)
    const file = join(s.ledgerFile, '..', 'web-keys.json')
    const written = readFileSync(file, 'utf8')
    const boot = (await call(r.loop, 'GET', '/api/web-key/status', undefined, tokenHeaders)).body
    // A restart with the authority on: a fresh registry over the same file reads the same anchor.
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const reread = new WebKeyRegistry(file, join(s.ledgerFile, '..', 'web-key-audit.jsonl'))
    expect(reread.anchor()).toMatchObject({ b64: mac.spki, spkiSha256: sha256Hex(mac.der), fingerprint: fingerprintOfSpki(mac.der), setAt: reg.body.setAt })
    expect(reread.anchorRefusal()).toBeNull()
    expect(reread.aud(SELF_DNS)).toBe(boot.aud)
    const authority = await call(r.loop, 'GET', '/api/web-key/status', undefined, tokenHeaders)
    expect(authority.body).toMatchObject({ enabled: true, anchorRegistered: true, anchorRefusal: null, anchorMature: false, aud: boot.aud, epoch: 0, activeKeys: 0 })
    // The mode switch wrote nothing.
    expect(readFileSync(file, 'utf8')).toBe(written)
    // And that anchor approves a phone enrollment now, with no second registration.
    const phone2 = p256()
    const r2 = randomBytes(32)
    const start = await call(r.lan, 'POST', '/api/web-key/enroll/start', { spki: phone2.spki, label: 'iPhone', sasCommit: createHash('sha256').update(r2).digest('hex') }, webHeaders(r.lan))
    expect(start.status, start.text).toBe(201)
    const pk = passkeyOf(phone2)
    const msg = WebKeyEnrollments.proofMessage({ ...start.body, phoneNonce: r2.toString('base64url'), passkeyCredentialId: credentialIdOf(phone2), passkeySpkiSha256: createHash('sha256').update(pk.der).digest('hex') })
    const assertion = passkeyAssertion(pk, createHash('sha256').update(canonicalJson(msg)).digest(), { credentialId: credentialIdOf(phone2), origin: start.body.origin })
    expect((await call(r.lan, 'POST', '/api/web-key/enroll/prove', { enrollId: start.body.enrollId, signature: signJcs(phone2, msg), phoneNonce: r2.toString('base64url'), passkey: { credentialId: credentialIdOf(phone2), publicKey: coseOf(pk), assertion } }, webHeaders(r.lan))).body).toMatchObject({ ok: true })
    const pending = await call(r.loop, 'GET', '/api/web-key/enroll/pending', undefined, tokenHeaders)
    const anchorSig = signB64(mac, Buffer.from(pending.body.pending.approvalJcs, 'base64url'))
    expect((await call(r.loop, 'POST', '/api/web-key/enroll/approve', { enrollId: start.body.enrollId, anchorSig }, tokenHeaders)).body).toMatchObject({ ok: true, kid: phone2.kid })
    expect(s.registry.activeCount(SELF_DNS)).toBe(1)
    expect(s.registry.anchor()?.setAt).toBe(reg.body.setAt)
  })
})
