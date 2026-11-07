// G2 authority Tier 1, web origin (6.99.29). A turn Miles types into a session's box on COS
// Control Web reaches the session through the same turn, queue and fork routes the glasses use,
// signed in with the `cos_web_session` cookie instead of X-Cos-Token. These tests drive the REAL
// /api gate (requireApiToken), the REAL cookie check (isWebSessionAuthorized) and real listeners,
// and assert the text each delivery path actually hands the session.
//
// The "phone" is this Mac's LAN address with the own-address list narrowed to loopback (the socket
// is real; only the list is injected). COS_WEB_CONTROL_LAN=1 lets the cookie path accept a LAN
// socket, standing in for the tailnet address a phone really uses. A second provenance lists the
// LAN address as the Mac's own, which is the "turn from this Mac" case.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-web-turns-'))
  process.env.COS_DATA_DIR = dir
  return { dir }
})
import express from 'express'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireApiToken } from '../lib/api-auth.js'
import { mintWebSessionCookieValue, setWebSessionEpochFile, isWebSessionAuthorized, WEB_SESSION_COOKIE_NAME } from '../lib/web-session-auth.js'
import {
  describeG2Turn, G2TurnLedger, G2TurnProvenance, stripG2TurnFooter, turnFooter, turnTextSha256, type OriginRequest,
} from '../lib/g2-turn-provenance.js'
import { createAgentSessionBindingsRouter, type AgentSessionBindingsDeps, type BindingRegistry } from './agent-session-bindings.js'
import { createThreadTurnQueueRouter, type ThreadTurnQueueDeps } from './thread-turn-queue.js'
import { createG2TurnsRouter } from './g2-turns.js'
import { AgentSessionBindingRegistry } from '../lib/agent-session-binding-registry.js'
import { targetKey } from '../lib/agent-session-binding-store.js'
import { deliverOverPeerInbox, __resetPeerInboxSuspects, type TranscriptRowLike } from '../lib/session-peer-inbox.js'
import { deliverQueuedTurnOverLoopback } from '../lib/thread-turn-queue-deliver.js'
import { readQueue, writeQueue } from '../lib/thread-turn-queue-store.js'
import type { Occupancy } from '../lib/thread-occupancy.js'
import { TURN_ATTACHMENTS_HEADING, type TurnAttachmentStore } from '../lib/session-turn-attachments.js'
import { MediaStoreError } from '../lib/media-store.js'
import type { MediaAttachmentRef } from '../../shared/media-attachment.js'

const LAN = Object.values(networkInterfaces()).flat().find(e => e && e.family === 'IPv4' && !e.internal)?.address ?? null
const TOKEN = 'api-token-web-test'
const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const CODEX_THREAD = '019fc80a-cc79-7921-8541-298e71695afd'
const NOW = 1_786_000_000_000
const WORDS = 'Yes install and proceed'
const M1 = 'm_' + 'a'.repeat(24)
const M1_PATH = '/Users/me/.cos-glasses/data/media/assets/' + M1 + '/original-normalized.jpg'
const M1_REF: MediaAttachmentRef = { id: M1, kind: 'user_photo', mime: 'image/jpeg', width: 1024, height: 768, createdAt: '2026-11-07T14:00:00.000Z', bytes: 220_000, label: 'Screenshot.png' }
const files: TurnAttachmentStore = {
  resolveUsable(id) {
    if (id !== M1) throw new MediaStoreError('media_not_found', 'nope')
    return { record: { ref: M1_REF }, path: M1_PATH }
  },
  async associate() {},
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
  delete process.env.COS_SESSION_STEER
  delete process.env.COS_QUEUE_RESEND
})
afterAll(() => {
  if (savedLan === undefined) delete process.env.COS_WEB_CONTROL_LAN
  else process.env.COS_WEB_CONTROL_LAN = savedLan
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  rmSync(FIXTURE.dir, { recursive: true, force: true })
})

/** `mac`: the LAN address is this Mac's own (a turn typed on the Mac itself). */
function provenance(opts: { mac?: boolean } = {}): G2TurnProvenance {
  const dir = mkdtempSync(join(tmpdir(), 'web-prov-'))
  roots.push(dir)
  return new G2TurnProvenance({
    ledger: new G2TurnLedger(join(dir, 'g2-turn-ledger.jsonl')),
    pairedInstance: () => null,
    ownAddresses: () => ({ addresses: new Set(['127.0.0.1', '::1', ...(opts.mac && LAN ? [LAN] : [])]), bridgeSubnets: [] }),
    // Production wiring: the cookie path, exactly as the /api gate checks it.
    webSession: (req: OriginRequest) => isWebSessionAuthorized({ method: req.method, headers: req.headers, socket: { remoteAddress: req.socket?.remoteAddress ?? undefined } }, TOKEN),
  })
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

interface Rig {
  lan: string
  loop: string
  port: number
  spawned: string[]
}

/**
 * One server, as production mounts it: the /api gate, the JSON parser, the bindings, queue and
 * provenance routers. Listening on every interface so the web request can come in on the LAN
 * address while the drainer posts to loopback.
 */
async function rig(p: G2TurnProvenance, over: Partial<AgentSessionBindingsDeps> = {}, queueOver: Partial<ThreadTurnQueueDeps> = {}, gate: () => Occupancy = () => ({ attachable: true, owners: [], reason: null })): Promise<Rig> {
  const root = join(FIXTURE.dir, `bind-${++seq}`)
  mkdirSync(root, { recursive: true })
  const r = AgentSessionBindingRegistry.open({ filePath: join(root, 'agent-session-bindings.json'), now: NOW, onWarn: () => {}, bootId: 'boot-web', pinBootReap: () => true })
  const spawned: string[] = []
  const d: AgentSessionBindingsDeps = {
    probes: { isAlive: () => true, processStartMs: () => NOW, fileExists: () => true, dirExists: () => true, readDir: () => [], readFile: () => '{}', lockHolders: () => [], cosSpawnedPids: () => new Map(), cursorAgentSession: () => null },
    dirs: { claudeSessionsDir: '/x/.claude/sessions', codexLocksDir: '/x/.codex', cursorChatsDir: '/x/.cursor' },
    now: () => clock, bindings: wire(r), attachEnabled: true, occupancy: gate,
    resolveTarget: () => ({ workspaceFingerprint: 'w', sourceFingerprint: 's' }), nativeHead: () => 'head-1',
    deliverAttachedTurn: async (req: { prompt: string }) => { spawned.push(req.prompt); return { status: 'completed', nativeRevisionAfter: 'head-1' } },
    ownership: { record: () => 'recorded', release: () => true },
    newId: () => `n${++seq}`,
    turnAttachmentStore: files,
    forkThread: () => ({ ok: true, newNativeThreadId: 'b7c1d2e3-1111-4222-8333-444455556666', integrity: 'verified_unchanged', detail: 'after:ok', exitCode: 0, stderrClass: 'none', durationMs: 5 }),
    resolveForkWorkspace: () => '/Users/me/project',
    provenance: p,
    ...over,
  } as AgentSessionBindingsDeps
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use(express.json())
  app.use('/api', createAgentSessionBindingsRouter(d))
  app.use('/api', createThreadTurnQueueRouter({
    occupancy: () => ({ attachable: false, reason: 'native_thread_working' }),
    turnEnded: () => false,
    activity: () => 'working',
    deliver: async () => ({ ok: true }),
    now: () => 10_000,
    turnAttachmentStore: files,
    provenance: p,
    ...queueOver,
  }))
  app.use('/api', createG2TurnsRouter({ provenance: p, apiToken: () => TOKEN }))
  const server: Server = await new Promise(res => { const l = app.listen(0, '0.0.0.0', () => res(l)) })
  closers.push(() => new Promise<void>(res => { server.closeAllConnections(); server.close(() => res()) }))
  const port = (server.address() as AddressInfo).port
  return { lan: `http://${LAN}:${port}`, loop: `http://127.0.0.1:${port}`, port, spawned }
}

function cookie(): string {
  return `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN).value}`
}
/** What COS Control Web's apiAnswer() sends: the cookie, X-COS-Web: 1, and the page's own Origin. */
function webHeaders(base: string): Record<string, string> {
  return { cookie: cookie(), 'x-cos-web': '1', origin: base }
}
const tokenHeaders = { 'x-cos-token': TOKEN }

async function call(base: string, method: string, path: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, text }
}

/** Attach then send, as continueSession() in web-control/app.js does. */
async function turn(base: string, clientTurnId: string, headers: Record<string, string>, extra: Record<string, unknown> = {}, provider = 'claude', threadId = SID) {
  clock += 91_000
  const a = await call(base, 'POST', `/api/agent-sessions/${provider}/${threadId}/attach`, { cosSessionId: 'cos-web-1' }, headers)
  expect(a.status, a.text).toBe(201)
  return call(base, 'POST', `/api/agent-sessions/bindings/${a.body.bindingId}/turns`, { clientTurnId, prompt: WORDS, epoch: a.body.epoch, targetKey: targetKey(provider as 'claude', threadId), ...extra }, headers)
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10))
}

const webFooted = (words: string, id: string) => `${words}\n${turnFooter(id, 'web')}`

/**
 * A live Claude session's peer inbox, for real: a unix socket that records the frame Claude Code
 * would receive and writes the `enqueue` row Claude Code writes when it accepts one.
 */
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

describe.skipIf(!LAN)('web origin: a signed-in COS Control Web turn into a live Claude session', () => {
  it('end to end through the peer inbox: the frame the session receives ends with the COS-WEB footer, and the endpoint vouches for it', async () => {
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    const res = await turn(r.lan, 'ctwebLive0001', webHeaders(r.lan))
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ outcome: 'completed', via: 'live' })
    expect(live.frames).toEqual([webFooted(WORDS, 'ctwebLive0001')])
    expect(live.frames[0].endsWith(`\n[COS-WEB turn ctwebLive0001 · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ctwebLive0001]`)).toBe(true)
    // The verifier's call: the token, over loopback, on either path.
    for (const path of ['/api/g2-turns/ctwebLive0001', '/api/turn-provenance/ctwebLive0001']) {
      const v = await call(r.loop, 'GET', path, undefined, tokenHeaders)
      expect(v.status).toBe(200)
      expect(v.body).toMatchObject({
        found: true, verifiedOrigin: true, sealed: true, originKind: 'web', via: 'live',
        textSha256: turnTextSha256(WORDS), target: { provider: 'claude', sessionId: SID },
        origin: { remote: LAN, loopback: false, ownAddress: false, client: 'web', webSession: true, tokenPresented: false },
      })
      // The hash is of exactly the words the session got, footer taken off.
      expect(turnTextSha256(stripG2TurnFooter(live.frames[0]).text)).toBe(v.body.textSha256)
    }
    // The endpoint itself is the Mac's: a browser cookie does not open it.
    const byCookie = await call(r.lan, 'GET', '/api/turn-provenance/ctwebLive0001', undefined, { cookie: cookie(), origin: r.lan })
    expect(byCookie).toMatchObject({ status: 401, body: { found: false, error: 'token_required' } })
  })

  it('with files: the footer follows the files block, and the hash covers words plus files', async () => {
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    const res = await turn(r.lan, 'ctwebFiles001', webHeaders(r.lan), { attachmentIds: [M1] })
    expect(res.status, res.text).toBe(200)
    const composed = `${WORDS}\n\n${TURN_ATTACHMENTS_HEADING}\n- Photo "Screenshot.png" (image/jpeg, 1024x768, 215 KB): "${M1_PATH}"`
    expect(live.frames).toEqual([webFooted(composed, 'ctwebFiles001')])
    const answer = await describeG2Turn(p, 'ctwebFiles001', Date.now())
    expect(answer).toMatchObject({ verifiedOrigin: true, originKind: 'web', textSha256: turnTextSha256(composed) })
    expect(turnTextSha256(stripG2TurnFooter(live.frames[0]).text)).toBe(answer!.textSha256)
    expect(turnTextSha256(WORDS)).not.toBe(answer!.textSha256)
  })
})

describe.skipIf(!LAN)('web origin: what is never verified', () => {
  it('a token turn from a non-Mac address: no footer, ledgered unverified', async () => {
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'cttokenLan001', tokenHeaders)).status).toBe(200)
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(p, 'cttokenLan001', Date.now())).toMatchObject({ verifiedOrigin: false, originKind: null, origin: { client: 'unknown', tokenPresented: true, webSession: false } })
  })

  it('a token AND a valid cookie together: the token rules the web path out', async () => {
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctboth0000001', { ...webHeaders(r.lan), ...tokenHeaders })).status).toBe(200)
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(p, 'ctboth0000001', Date.now())).toMatchObject({ verifiedOrigin: false, originKind: null, origin: { tokenPresented: true, webSession: false } })
  })

  it('a cookie turn from this Mac\'s own address: no footer, ledgered local', async () => {
    const p = provenance({ mac: true })
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctwebMac00001', webHeaders(r.lan))).status).toBe(200)
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(p, 'ctwebMac00001', Date.now())).toMatchObject({ verifiedOrigin: false, originKind: null, origin: { ownAddress: true, client: 'local' } })
  })

  it('a cookie turn over loopback (Control Web open on the Mac): no footer, ledgered local', async () => {
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.loop, 'ctwebLoop0001', webHeaders(r.loop))).status).toBe(200)
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(p, 'ctwebLoop0001', Date.now())).toMatchObject({ verifiedOrigin: false, originKind: null, origin: { loopback: true, client: 'local' } })
  })

  it('a cookie without X-COS-Web is refused at the gate and never reaches a session', async () => {
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    const a = await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/attach`, { cosSessionId: 'cos-web-1' }, { cookie: cookie(), origin: r.lan })
    expect(a.status).toBe(401)
    expect(live.frames).toEqual([])
  })

  it('a forged, expired or missing cookie from a non-Mac address is no web turn, whatever else it says', async () => {
    const p = provenance()
    const base = { method: 'POST', socket: { remoteAddress: LAN! } }
    const page = { 'x-cos-web': '1', origin: `http://${LAN}:3141`, host: `${LAN}:3141` }
    const good = { ...page, cookie: cookie() }
    expect(p.originOf({ ...base, headers: good })).toMatchObject({ verifiedOrigin: true, origin: { client: 'web' } })
    const forged = { ...page, cookie: `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue('some-other-token').value}` }
    const expired = { ...page, cookie: `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN, Date.now() - 8 * 24 * 3_600_000).value}` }
    for (const headers of [forged, expired, page, { ...good, 'x-cos-web': '0' }, { ...good, origin: 'http://evil.example' }, { ...good, 'x-cos-client': 'glasses' as const, cookie: '' }]) {
      expect(p.originOf({ ...base, headers }), JSON.stringify(headers)).toMatchObject({ verifiedOrigin: false })
      expect(p.originOf({ ...base, headers }).origin.client).not.toBe('web')
    }
  })

  it('a webSession check that throws is no web turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-prov-'))
    roots.push(dir)
    const p = new G2TurnProvenance({
      ledger: new G2TurnLedger(join(dir, 'l.jsonl')), pairedInstance: () => null,
      ownAddresses: () => ({ addresses: new Set(['127.0.0.1']), bridgeSubnets: [] }),
      webSession: () => { throw new Error('boom') },
    })
    const verdict = p.originOf({ method: 'POST', socket: { remoteAddress: '100.81.195.27' }, headers: {} })
    expect(verdict).toMatchObject({ verifiedOrigin: false, origin: { client: 'unknown', webSession: false } })
  })
})

describe.skipIf(!LAN)('web origin: every delivery path', () => {
  it('live but unverified: the text may be in the session, so it is ledgered', async () => {
    const p = provenance()
    const r = await rig(p, { deliverLiveTurn: async () => ({ ok: false, reason: 'unverified' }) })
    await turn(r.lan, 'ctwebUnver001', webHeaders(r.lan))
    expect(await describeG2Turn(p, 'ctwebUnver001', Date.now())).toMatchObject({ via: 'live-unverified', verifiedOrigin: true, originKind: 'web' })
  })

  it('resume child: the spawned turn gets the footed prompt', async () => {
    const p = provenance()
    const r = await rig(p, { deliverLiveTurn: async () => ({ ok: false, reason: 'no_record' }) })
    const res = await turn(r.lan, 'ctwebSpawn001', webHeaders(r.lan))
    expect(res.status, res.text).toBe(202)
    await until(() => r.spawned.length > 0)
    expect(r.spawned).toEqual([webFooted(WORDS, 'ctwebSpawn001')])
    expect(await describeG2Turn(p, 'ctwebSpawn001', Date.now())).toMatchObject({ via: 'spawn', verifiedOrigin: true, originKind: 'web' })
  })

  it('Codex app queue hop: the Codex app gets the footed prompt', async () => {
    const p = provenance()
    const codex: string[] = []
    const holder: Occupancy = { attachable: true, owners: [{ provider: 'codex', threadId: CODEX_THREAD, pid: 77, source: 'codex-writer-lock', selfOwned: false }], reason: null, idleHolder: true }
    const r = await rig(p, { deliverCodexLiveTurn: async req => { codex.push(req.prompt); return { ok: true, reason: 'delivered', queuedId: 'q-1' } } }, {}, () => holder)
    const res = await turn(r.lan, 'ctwebCodex001', webHeaders(r.lan), {}, 'codex', CODEX_THREAD)
    expect(res.status, res.text).toBe(200)
    expect(codex).toEqual([webFooted(WORDS, 'ctwebCodex001')])
    expect(await describeG2Turn(p, 'ctwebCodex001', Date.now())).toMatchObject({ via: 'codex-live', verifiedOrigin: true, originKind: 'web', target: { provider: 'codex', sessionId: CODEX_THREAD } })
  })

  it('fork: the copy gets the footed prompt (files included), ledgered against the source', async () => {
    const p = provenance()
    const forks: string[] = []
    const r = await rig(p, { forkThread: (req: { prompt: string }) => { forks.push(req.prompt); return { ok: true, newNativeThreadId: 'b7c1d2e3-1111-4222-8333-444455556666', integrity: 'verified_unchanged', detail: 'after:ok', exitCode: 0, stderrClass: 'none', durationMs: 5 } } } as Partial<AgentSessionBindingsDeps>)
    const res = await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/fork`, { cosSessionId: 'cos-web-1', prompt: WORDS, clientForkId: 'cfwebFork0001', attachmentIds: [M1] }, webHeaders(r.lan))
    expect(res.status, res.text).toBeLessThan(300)
    await until(() => forks.length > 0)
    const composed = `${WORDS}\n\n${TURN_ATTACHMENTS_HEADING}\n- Photo "Screenshot.png" (image/jpeg, 1024x768, 215 KB): "${M1_PATH}"`
    expect(forks).toEqual([webFooted(composed, 'cfwebFork0001')])
    expect(await describeG2Turn(p, 'cfwebFork0001', Date.now())).toMatchObject({ via: 'fork', verifiedOrigin: true, originKind: 'web', textSha256: turnTextSha256(composed), target: { fork: true } })
  })

  it('queue park, then the drain over loopback with the X-Cos-Token: the carry keeps the web origin and the session gets the footer', async () => {
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    const thread = SID
    const park = await call(r.lan, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: 'ctwebQueue001', cosSessionId: 'cos-web-1', prompt: WORDS }, webHeaders(r.lan))
    expect(park.status, park.text).toBe(202)
    expect(await describeG2Turn(p, 'ctwebQueue001', Date.now())).toMatchObject({ via: 'queue', verifiedOrigin: true, originKind: 'web' })
    const row = readQueue('claude', thread, 10_000).find(t => t.clientTurnId === 'ctwebQueue001')!
    clock += 91_000
    expect(await deliverQueuedTurnOverLoopback(row, r.port, TOKEN, t => p.issueCarry(t))).toEqual({ ok: true })
    expect(live.frames).toEqual([webFooted(WORDS, 'ctwebQueue001')])
    expect(await describeG2Turn(p, 'ctwebQueue001', Date.now())).toMatchObject({ via: 'drain-live', verifiedOrigin: true, originKind: 'web' })
    writeQueue('claude', thread, [])
  })

  it('the same drain without a carry is the token on loopback: local, unfooted', async () => {
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/queued-turns`, { clientTurnId: 'ctwebQueue002', cosSessionId: 'cos-web-1', prompt: WORDS }, webHeaders(r.lan))
    const row = readQueue('claude', SID, 10_000).find(t => t.clientTurnId === 'ctwebQueue002')!
    clock += 91_000
    expect(await deliverQueuedTurnOverLoopback(row, r.port, TOKEN)).toEqual({ ok: true })
    expect(live.frames).toEqual([WORDS])
    expect(await describeG2Turn(p, 'ctwebQueue002', Date.now())).toMatchObject({ via: 'live', verifiedOrigin: false, origin: { client: 'local' } })
    writeQueue('claude', SID, [])
  })

  it('queue edit from the web replaces the parked origin; an edit by token over loopback makes it local', async () => {
    const p = provenance()
    const r = await rig(p)
    const thread = `thr-web-${++seq}`
    await call(r.loop, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns`, { clientTurnId: 'ctwebEdit0001', cosSessionId: 'cos-web-1', prompt: 'from an agent' }, tokenHeaders)
    expect(p.queuedVerdict('claude', thread, 'ctwebEdit0001', 'from an agent')?.verifiedOrigin).toBe(false)
    expect((await call(r.lan, 'PATCH', `/api/agent-sessions/claude/${thread}/queued-turns/ctwebEdit0001`, { prompt: WORDS }, webHeaders(r.lan))).status).toBe(200)
    expect(p.queuedVerdict('claude', thread, 'ctwebEdit0001', WORDS)).toMatchObject({ verifiedOrigin: true, origin: { client: 'web' } })
    expect(await describeG2Turn(p, 'ctwebEdit0001', Date.now())).toMatchObject({ via: 'queue-edit', verifiedOrigin: true, originKind: 'web' })
    expect((await call(r.loop, 'PATCH', `/api/agent-sessions/claude/${thread}/queued-turns/ctwebEdit0001`, { prompt: 'agent words' }, tokenHeaders)).status).toBe(200)
    expect(p.queuedVerdict('claude', thread, 'ctwebEdit0001', 'agent words')?.verifiedOrigin).toBe(false)
  })

  it('Send again from the web: the copy carries the web origin', async () => {
    process.env.COS_QUEUE_RESEND = '1'
    const p = provenance()
    const r = await rig(p)
    const thread = `thr-web-${++seq}`
    writeQueue('claude', thread, [{ clientTurnId: 'ctwebResend01', cosSessionId: 'cos-web-1', provider: 'claude', threadId: thread, prompt: WORDS, queuedAt: 9_000, status: 'refused', attempts: 1, settledAt: 9_500, reason: 'x' }])
    const res = await call(r.lan, 'POST', `/api/agent-sessions/claude/${thread}/queued-turns/ctwebResend01/resend`, { clientTurnId: 'ctwebResend02', cosSessionId: 'cos-web-1' }, webHeaders(r.lan))
    expect(res.status, res.text).toBe(200)
    expect(p.queuedVerdict('claude', thread, 'ctwebResend02', WORDS)).toMatchObject({ verifiedOrigin: true, origin: { client: 'web' } })
    expect(await describeG2Turn(p, 'ctwebResend02', Date.now())).toMatchObject({ via: 'queue-resend', verifiedOrigin: true, originKind: 'web' })
  })

  it('native Codex queue edit from the web: footed COS-WEB; the listing shows the words', async () => {
    const p = provenance()
    const native = [{ id: 'native-one', input: [{ type: 'text', text: 'whole message' }] }]
    const r = await rig(p, {}, { nativeQueue: {
      list: async () => native as never,
      update: async (_t: string, id: string, prompt: string) => { native.find(x => x.id === id)!.input[0].text = prompt },
      cancel: async () => true,
    } as never })
    const path = `/api/agent-sessions/codex/${CODEX_THREAD}/queued-turns`
    expect((await call(r.lan, 'PATCH', `${path}/codex-native:native-one`, { prompt: WORDS }, webHeaders(r.lan))).body).toEqual({ updated: true })
    const sent = native[0].input[0].text
    const id = /\[COS-WEB turn (cnedit-[0-9a-f]{24}) /.exec(sent)?.[1]
    expect(sent).toBe(webFooted(WORDS, id!))
    expect(await describeG2Turn(p, id!, Date.now())).toMatchObject({ via: 'codex-native-edit', verifiedOrigin: true, originKind: 'web' })
    expect((await call(r.lan, 'GET', path, undefined, { cookie: cookie() })).body.turns[0]).toMatchObject({ prompt: WORDS })
  })

  it('steer into the running turn: the peer inbox gets the footed prompt', async () => {
    process.env.COS_SESSION_STEER = '1'
    const p = provenance()
    const live = await liveSession()
    const r = await rig(p, {}, {
      deliverLiveTurn: live.deliverLiveTurn,
      steerProbe: () => ({ peerInbox: true, waitingOnPrompt: false }),
      continueLive: () => true,
      attempts: { begin: () => true, settle: () => true },
    })
    const res = await call(r.lan, 'POST', `/api/agent-sessions/claude/${SID}/queued-turns`, { clientTurnId: 'ctwebSteer001', cosSessionId: 'cos-web-1', prompt: WORDS, mode: 'steer' }, webHeaders(r.lan))
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ state: 'delivered', reason: 'steered' })
    expect(live.frames).toEqual([webFooted(WORDS, 'ctwebSteer001')])
    expect(await describeG2Turn(p, 'ctwebSteer001', Date.now())).toMatchObject({ via: 'steer', verifiedOrigin: true, originKind: 'web' })
    writeQueue('claude', SID, [])
  })
})

describe.skipIf(!LAN)('the G2 rule still holds on the current routes (ported a3c8c4b)', () => {
  it('a token turn naming the ring owner for its address is footed COS-G2 and verified as g2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g2-prov-'))
    roots.push(dir)
    const p = new G2TurnProvenance({
      ledger: new G2TurnLedger(join(dir, 'l.jsonl')),
      pairedInstance: device => (device === LAN ? 'muytwk3t-lafw' : null),
      ownAddresses: () => ({ addresses: new Set(['127.0.0.1', '::1']), bridgeSubnets: [] }),
      webSession: (req: OriginRequest) => isWebSessionAuthorized({ method: req.method, headers: req.headers, socket: { remoteAddress: req.socket?.remoteAddress ?? undefined } }, TOKEN),
    })
    const live = await liveSession()
    const r = await rig(p, { deliverLiveTurn: live.deliverLiveTurn })
    expect((await turn(r.lan, 'ctg2Live00001', { ...tokenHeaders, 'x-cos-client-instance': 'muytwk3t-lafw', 'x-cos-client': 'glasses' })).status).toBe(200)
    expect(live.frames).toEqual([`${WORDS}\n${turnFooter('ctg2Live00001', 'glasses')}`])
    expect(await describeG2Turn(p, 'ctg2Live00001', Date.now())).toMatchObject({ verifiedOrigin: true, originKind: 'g2', origin: { client: 'glasses', tokenPresented: true, webSession: false } })
  })
})
