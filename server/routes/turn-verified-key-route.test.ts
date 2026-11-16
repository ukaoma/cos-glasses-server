// Two route pins on POST /api/agent-sessions/bindings/:bindingId/turns, built on the harness of
// turn-provenance-web-key.test.ts (real /api gate, real cookie check, real provenance and web-key
// authority, a real peer-inbox socket standing in for the open session) and, for the ask, the real
// TurnEndAskTracker exactly as agent-session-bindings.test.ts drives it.
//
// A: a client turn id that already carried a phone-key verified web turn is never delivered a second
//    time by a plain web turn with the same words (and the reverse order).
// B: a plain web turn (ordinary words, no turnEndAskId) to an idle Claude session that has an open
//    turn-end question: what the route does with it, and what the open ask reads afterwards.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

const FIXTURE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cos-turn-verified-key-'))
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
import { describeG2Turn, G2TurnLedger, G2TurnProvenance, turnFooter, WEB_UNVOUCHED_REASON, type OriginRequest } from '../lib/g2-turn-provenance.js'
import { createAgentSessionBindingsRouter, type AgentSessionBindingsDeps, type BindingRegistry } from './agent-session-bindings.js'
import { AgentSessionBindingRegistry } from '../lib/agent-session-binding-registry.js'
import { targetKey } from '../lib/agent-session-binding-store.js'
import { deliverOverPeerInbox, __resetPeerInboxSuspects, type TranscriptRowLike } from '../lib/session-peer-inbox.js'
import type { Occupancy } from '../lib/thread-occupancy.js'
import { WebKeyAuthority } from '../lib/web-key-authority.js'
import { WebKeyNonces, WebKeyPackets, WebKeyRegistry } from '../lib/web-key-registry.js'
import { anchoredEntry, envelopeFor, INTEGRITY_OK, p256, seedRegistry, SELF_DNS, signedHeaders, type TestKey } from '../lib/__fixtures__/web-key-kit.js'
import { TurnEndAskTracker, WRAP_UP_TOOL, __setTurnEndAsksForTests, isTurnEndAnswerPrompt } from '../lib/turn-end-ask.js'
import type { HookEnvelope } from '../lib/session-hook-events.js'

const LAN = Object.values(networkInterfaces()).flat().find(e => e && e.family === 'IPv4' && !e.internal)?.address ?? null
const TOKEN = 'api-token-turn-verified-key-test'
const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const NOW = 1_786_000_000_000
const WORDS = 'Yes install and proceed'

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
})
afterAll(() => {
  if (savedLan === undefined) delete process.env.COS_WEB_CONTROL_LAN
  else process.env.COS_WEB_CONTROL_LAN = savedLan
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  rmSync(FIXTURE.dir, { recursive: true, force: true })
})

interface Stack { anchor: TestKey; phone: TestKey; nonces: WebKeyNonces; p: G2TurnProvenance; origin: { value: string | null } }

/** turn-provenance-web-key.test.ts `stack()`: a seeded registry with one enrolled phone key, the real authority. */
function stack(): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'turn-verified-key-stack-'))
  roots.push(dir)
  const anchor = p256()
  const phone = p256()
  seedRegistry(join(dir, 'web-keys.json'), anchor, [anchoredEntry(anchor, phone)])
  const registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'web-key-audit.jsonl'))
  const nonces = new WebKeyNonces(join(dir, 'web-key-nonces.json'))
  const origin = { value: null as string | null }
  const authority = new WebKeyAuthority({ registry, nonces, packets: new WebKeyPackets(), integrity: () => INTEGRITY_OK, selfDnsName: () => SELF_DNS, expectedOrigin: () => origin.value, now: () => Date.now() })
  const p = new G2TurnProvenance({
    ledger: new G2TurnLedger(join(dir, 'g2-turn-ledger.jsonl')),
    pairedInstance: () => null,
    ownAddresses: () => ({ addresses: new Set(['127.0.0.1', '::1']), bridgeSubnets: [] }),
    webSession: (req: OriginRequest) => isWebSessionAuthorized({ method: req.method, headers: req.headers, socket: { remoteAddress: req.socket?.remoteAddress ?? undefined } }, TOKEN),
    webKey: authority,
  })
  return { anchor, phone, nonces, p, origin }
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

/** turn-provenance-web-key.test.ts `rig()`, the bindings router only. `spawned` counts the resume-child fallback. */
async function rig(s: Stack, over: Partial<AgentSessionBindingsDeps> = {}, gate: () => Occupancy = () => ({ attachable: true, owners: [], reason: null })) {
  const root = join(FIXTURE.dir, `bind-${++seq}`)
  mkdirSync(root, { recursive: true })
  const r = AgentSessionBindingRegistry.open({ filePath: join(root, 'agent-session-bindings.json'), now: NOW, onWarn: () => {}, bootId: 'boot-turn-verified-key', pinBootReap: () => true })
  const spawned: string[] = []
  const d: AgentSessionBindingsDeps = {
    probes: { isAlive: () => true, processStartMs: () => NOW, fileExists: () => true, dirExists: () => true, readDir: () => [], readFile: () => '{}', lockHolders: () => [], cosSpawnedPids: () => new Map(), cursorAgentSession: () => null },
    dirs: { claudeSessionsDir: '/x/.claude/sessions', codexLocksDir: '/x/.codex', cursorChatsDir: '/x/.cursor' },
    now: () => clock, bindings: wire(r), attachEnabled: true, occupancy: gate,
    resolveTarget: () => ({ workspaceFingerprint: 'w', sourceFingerprint: 's' }), nativeHead: () => 'head-1',
    deliverAttachedTurn: async (req: { prompt: string }) => { spawned.push(req.prompt); return { status: 'completed', nativeRevisionAfter: 'head-1' } },
    ownership: { record: () => 'recorded', release: () => true },
    newId: () => `n${++seq}`,
    provenance: s.p,
    ...over,
  } as AgentSessionBindingsDeps
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use(express.json())
  app.use('/api', createAgentSessionBindingsRouter(d))
  const server: Server = await new Promise(res => { const l = app.listen(0, '0.0.0.0', () => res(l)) })
  closers.push(() => new Promise<void>(res => { server.closeAllConnections(); server.close(() => res()) }))
  const port = (server.address() as AddressInfo).port
  s.origin.value = `http://${LAN}:${port}`
  return { lan: `http://${LAN}:${port}`, spawned }
}

function cookie(): string { return `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN).value}` }
function webHeaders(base: string): Record<string, string> { return { cookie: cookie(), 'x-cos-web': '1', origin: base } }

async function call(base: string, method: string, path: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
  return { status: res.status, body: parsed, text }
}

interface Bound { bindingId: string; epoch: number }
async function attach(base: string): Promise<Bound> {
  clock += 91_000
  const a = await call(base, 'POST', `/api/agent-sessions/claude/${SID}/attach`, { cosSessionId: 'cos-web-1' }, webHeaders(base))
  expect(a.status, a.text).toBe(201)
  return { bindingId: a.body.bindingId, epoch: a.body.epoch }
}
async function postTurn(base: string, b: Bound, clientTurnId: string, headers: Record<string, string>, extra: Record<string, unknown> = {}, prompt = WORDS) {
  return call(base, 'POST', `/api/agent-sessions/bindings/${b.bindingId}/turns`, { clientTurnId, prompt, epoch: b.epoch, targetKey: targetKey('claude', SID), ...extra }, headers)
}

/** turn-provenance-web-key.test.ts `liveSession()`: the open session's peer inbox; `frames` is every text it received. */
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

/** An envelope signed by the enrolled phone for this turn id, with a fresh server nonce. */
function signed(s: Stack, turnId: string): Record<string, string> {
  const issued = s.nonces.issue()
  if (!issued.ok) throw new Error(issued.reason)
  return signedHeaders(s.phone, envelopeFor(s.phone, s.anchor, { nonce: issued.nonce, nowS: Math.floor(Date.now() / 1000), origin: s.origin.value!, turnId, sessionId: SID }))
}

const webFooted = (text: string, id: string) => `${text}\n${turnFooter(id, 'web', 'claude')}`

const PLAIN_UNVOUCHED = { originKind: 'web', verifiedOrigin: false, reason: WEB_UNVOUCHED_REASON }

describe.skipIf(!LAN)('A: a phone-key verified web turn and a plain web turn under one clientTurnId K', () => {
  // Pin (QA, before release freeze). The verified turn is delivered under K. The plain retry (same binding, same
  // words, same K, no proof headers) is answered by the binding's turn ledger, the REPLAY at
  // agent-session-bindings.ts:3402-3411 (findTurn reads every binding of the target), before provenance is read:
  // an idempotent replay of the FIRST turn's result, 200 with `replayed: true`. Delivered exactly once.
  // provenance.reusesTurnId (turn_id_in_use) is not what answers here; the next test pins it as the second layer.
  it('verified first, then plain: the plain turn is an idempotent replay of the verified one, delivered once, record still web-key', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const b = await attach(r.lan)
    const K = 'ctvkPin000001'
    const first = await postTurn(r.lan, b, K, { ...webHeaders(r.lan), ...signed(s, K) })
    expect(first.status, first.text).toBe(200)
    expect(first.body).toMatchObject({ outcome: 'completed', deliveryState: 'delivered', via: 'live' })
    expect(await describeG2Turn(s.p, K, Date.now())).toMatchObject({ originKind: 'web', verifiedOrigin: true, reason: null, authority: 'web-key' })

    const second = await postTurn(r.lan, b, K, webHeaders(r.lan))
    expect(second.status, second.text).toBe(200)
    expect(second.body).toEqual({ ...first.body, replayed: true })

    expect(live.frames).toEqual([webFooted(WORDS, K)])
    expect(r.spawned).toEqual([])
    // The plain retry did not overwrite the verified record.
    expect(await describeG2Turn(s.p, K, Date.now())).toMatchObject({ originKind: 'web', verifiedOrigin: true, reason: null, authority: 'web-key' })
  })

  it('plain first, then verified (reverse): the verified turn is an idempotent replay of the plain one, delivered once, never vouched', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
    const b = await attach(r.lan)
    const K = 'ctvkPin000002'
    const first = await postTurn(r.lan, b, K, webHeaders(r.lan))
    expect(first.status, first.text).toBe(200)
    expect(first.body).toMatchObject({ outcome: 'completed', deliveryState: 'delivered', via: 'live' })

    const second = await postTurn(r.lan, b, K, { ...webHeaders(r.lan), ...signed(s, K) })
    expect(second.status, second.text).toBe(200)
    expect(second.body).toEqual({ ...first.body, replayed: true })

    expect(live.frames).toEqual([WORDS])
    expect(r.spawned).toEqual([])
    const rec = await describeG2Turn(s.p, K, Date.now())
    expect(rec).toMatchObject(PLAIN_UNVOUCHED)
    expect(rec).not.toHaveProperty('authority')
  })

  // The second layer, reached only when the binding ledger holds no record of K (here: a second router with its own
  // registry sharing the one provenance ledger). provenance.reusesTurnId refuses (g2-turn-provenance.ts:584-603;
  // sameTurn :242-249 differs on verifiedOrigin): 400, reason invalid_request, error turn_id_in_use,
  // outcome refused, not delivered (refuseTurn at agent-session-bindings.ts:3550-3552).
  it('second layer, no binding-ledger record of K: reusesTurnId refuses 400 turn_id_in_use in both orders, nothing delivered again', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    for (const order of ['verified-then-plain', 'plain-then-verified'] as const) {
      const s = stack()
      const live = await liveSession()
      const r1 = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
      const K = order === 'verified-then-plain' ? 'ctvkPin000003' : 'ctvkPin000004'
      const firstHeaders = order === 'verified-then-plain' ? { ...webHeaders(r1.lan), ...signed(s, K) } : webHeaders(r1.lan)
      const first = await postTurn(r1.lan, await attach(r1.lan), K, firstHeaders)
      expect(first.status, first.text).toBe(200)
      const r2 = await rig(s, { deliverLiveTurn: live.deliverLiveTurn })
      const secondHeaders = order === 'verified-then-plain' ? webHeaders(r2.lan) : { ...webHeaders(r2.lan), ...signed(s, K) }
      const second = await postTurn(r2.lan, await attach(r2.lan), K, secondHeaders)
      expect(second.status, `${order}: ${second.text}`).toBe(400)
      expect(second.body).toMatchObject({ outcome: 'refused', reason: 'invalid_request', error: 'turn_id_in_use', retryable: false, deliveryState: 'not_delivered' })
      expect(live.frames, order).toEqual([order === 'verified-then-plain' ? webFooted(WORDS, K) : WORDS])
      expect(r1.spawned.length + r2.spawned.length).toBe(0)
      // The held record is still the first turn's. Read against the first rig's page origin (the one K's envelope, if
      // any, was signed for): the second rig listening moved the authority's expected origin to its own port.
      s.origin.value = r1.lan
      expect(await describeG2Turn(s.p, K, Date.now())).toMatchObject(order === 'verified-then-plain' ? { verifiedOrigin: true, authority: 'web-key' } : PLAIN_UNVOUCHED)
    }
  })
})

describe.skipIf(!LAN)('B: a plain web turn to an idle Claude session with an open turn-end question', () => {
  const ORDINARY = 'Also check the release notes before you start'
  const ANSWER = 'Answer sent from COS Control Web through COS, not typed in this session: Yes, check readiness'
  const P = 'p-ask-0001'
  const T0 = 1_794_633_000_000
  const STOPPED = T0 + 4_700
  const ID = `turn_end:${STOPPED}`
  const OPEN = { ask: 'Run a read-only readiness check?', choices: ['Yes, check readiness', 'Not tonight'], stoppedAt: STOPPED }
  const trackers: TurnEndAskTracker[] = []
  afterEach(() => { for (const t of trackers.splice(0)) t.stop(); __setTurnEndAsksForTests(null) })

  const env = (event: HookEnvelope['event'], ts: number, payload: Record<string, unknown> = {}): HookEnvelope =>
    ({ ts, ppid: 4242, event, sessionId: SID, payload: { session_id: SID, ...payload } })
  /** agent-session-bindings.test.ts `asked()`: the session's turn ended with a wrap_up ask, then Stop. */
  const asked = (): HookEnvelope[] => [
    env('UserPromptSubmit', T0 - 10_000, { prompt: 'go', prompt_id: P }),
    env('PostToolUse', T0, { tool_name: WRAP_UP_TOOL, prompt_id: P, tool_input: { recap: 'r', ask: OPEN.ask, actions: [{ label: OPEN.choices[0] }, { label: OPEN.choices[1] }] } }),
    env('Stop', STOPPED, { last_assistant_message: 'done', prompt_id: P }),
  ]

  /** The real tracker wired as index.ts wires it (openTurnEndAsk / turnEndAskAnswered), an ask open and shown. */
  async function askRig() {
    __setTurnEndAsksForTests(true)
    const askClock = { now: T0 + 200_000 }
    const tracker = new TurnEndAskTracker({ now: () => askClock.now, enabled: () => true, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, pollMs: 3_600_000 })
    trackers.push(tracker)
    for (const e of asked()) tracker.observe(e, false)
    await tracker.tick()
    expect(tracker.visibleAsk(SID)).toEqual(OPEN)
    const reads: string[] = []
    const s = stack()
    const live = await liveSession()
    const r = await rig(s, {
      deliverLiveTurn: live.deliverLiveTurn,
      openTurnEndAsk: (sid: string) => { reads.push(sid); return tracker.visibleAsk(sid) },
      turnEndAskAnswered: (sid: string, at: number) => tracker.answeredAsk(sid, at),
    })
    return { tracker, askClock, reads, live, r }
  }

  // Fact pinned: the plain turn is DELIVERED (200 completed, live, once). The route never reads the ask for it
  // (namesAsk at agent-session-bindings.ts:3565 needs a turnEndAskId AND the contract answer words), so it neither
  // refuses, holds, nor marks the ask: right after the 200 the ask still reads OPEN, unchanged, with nobody named as
  // having answered it. The ask changes only when the session's own UserPromptSubmit hook for those words lands
  // (turn-end-ask.ts:281-300): the tracker then reads it ANSWERED with by 'mac' (turnAskAnswerSurface,
  // turn-end-ask.ts:136-142: plain web words carry no "Answer sent from COS Control Web" prefix and, unvouched, no
  // footer), and a later named answer is refused turn_end_ask_moved, answered: true, answeredBy: 'mac'.
  it('delivered once; the ask stays open until the session hook, which then records it answered by the Mac', async () => {
    const { tracker, askClock, reads, live, r } = await askRig()
    expect(isTurnEndAnswerPrompt(ORDINARY)).toBe(false)
    const b = await attach(r.lan)
    const res = await postTurn(r.lan, b, 'ctvkAsk000001', webHeaders(r.lan), {}, ORDINARY)
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ outcome: 'completed', deliveryState: 'delivered', via: 'live', reason: null })
    expect(live.frames).toEqual([ORDINARY])
    expect(r.spawned).toEqual([])
    // The route did not consult the ask at all for this turn.
    expect(reads).toEqual([])
    // Right after the 200: still open, the same ask (what the question card shows), nobody answered it.
    expect(tracker.visibleAsk(SID)).toEqual(OPEN)
    expect(tracker.peekAsk(SID)).toEqual(OPEN)
    expect(tracker.answeredAsk(SID, STOPPED)).toBeNull()
    expect(tracker.recentlyAnswered()).toEqual([])

    // The session's UserPromptSubmit hook for exactly the text it received (fed here, as the hook runtime would).
    askClock.now += 1_000
    tracker.observe(env('UserPromptSubmit', askClock.now, { prompt: live.frames[0], prompt_id: 'p-web-plain' }), false)
    expect(tracker.visibleAsk(SID)).toBeNull()
    expect(tracker.answeredAsk(SID, STOPPED)).toEqual({ answeredAt: askClock.now, by: 'mac' })
    expect(tracker.recentlyAnswered()).toEqual([{ sessionId: SID, ask: OPEN.ask, stoppedAt: STOPPED, answeredAt: askClock.now, by: 'mac' }])

    // A named answer tapped after that: refused, told the Mac answered it, nothing more delivered.
    const late = await postTurn(r.lan, b, 'ctvkAsk000002', webHeaders(r.lan), { turnEndAskId: ID }, ANSWER)
    expect(late.status, late.text).toBe(409)
    expect(late.body).toMatchObject({ reason: 'turn_end_ask_moved', answered: true, answeredBy: 'mac', askNow: null, deliveryState: 'not_delivered' })
    expect(live.frames).toEqual([ORDINARY])
  })

  // The window between the plain turn's 200 and the session's hook: the route set no first-answer mark (only a named
  // answer sets one, agent-session-bindings.ts:3626-3637), so a named answer to the still-open ask is delivered as well.
  it('before the hook lands, a named answer to the same ask is also delivered (the plain turn set no first-answer mark)', async () => {
    const { tracker, live, r } = await askRig()
    const b = await attach(r.lan)
    const plain = await postTurn(r.lan, b, 'ctvkAsk000003', webHeaders(r.lan), {}, ORDINARY)
    expect(plain.status, plain.text).toBe(200)
    const named = await postTurn(r.lan, b, 'ctvkAsk000004', webHeaders(r.lan), { turnEndAskId: ID }, ANSWER)
    expect(named.status, named.text).toBe(200)
    expect(named.body).toMatchObject({ outcome: 'completed', deliveryState: 'delivered', via: 'live' })
    expect(live.frames).toEqual([ORDINARY, ANSWER])
    expect(tracker.visibleAsk(SID)).toEqual(OPEN)
  })
})
