// Behavioral tests for the attachability verdict surface.
//
// WHAT THESE ASSERT ON. The outcome a caller acts on is `attachable`, and every
// occupancy case here is driven through the real HTTP route into the real
// `threadOccupancy`. The detector's own suite records why: an earlier version
// checked `owners.length === 0` and called that "not treated as free", which
// asserted the INPUT to the bug and named it the absence of the bug. Nothing
// below asserts on source text, and nothing compares two literals.
//
// FIXTURE REALISM. The ids, pid, socket path and the UTC/local procStart pair are
// the real values observed on this machine on 2026-08-15, matching
// lib/thread-occupancy.test.ts. The injected directories are created under a temp
// root that CONTAINS A DOT COMPONENT, because both production roots are dot
// directories (~/.claude, ~/.codex) and a bare mktemp path structurally cannot
// contain one. That gap is how a real bug shipped in this repo before, when
// `res.sendFile` refused every path under `~/.cos-glasses` while every test
// passed against `/var/folders/...`. The binding fixtures are deliberately loaded
// with the leaky values the real type permits: a cosSessionId containing ':' and
// '/', and fingerprints that are raw filesystem paths. A redaction test against a
// sanitized fixture proves nothing.

import express from 'express'
import { mkdirSync, mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTACHABLE_COPY,
  REASON_COPY,
  UNKNOWN_REASON_COPY,
  WRITE_REASON_COPY,
  createAgentSessionBindingsRouter,
  opaqueRevision,
  type AgentSessionBindingsDeps,
  type AttachedTurnRequest,
  type BindingRegistry,
  type WriteRefusal,
  threadAttachEnabled,
} from './agent-session-bindings.js'
import {
  threadOccupancy,
  type Occupancy,
  type OccupancyProbes,
  type OccupancyReason,
  type ThreadOwner,
} from '../lib/thread-occupancy.js'
import { boundToMarker, targetKey, type NativeBinding } from '../lib/agent-session-binding-store.js'
import { AgentSessionBindingRegistry } from '../lib/agent-session-binding-registry.js'
import { CosSpawnLedger } from '../lib/agent-session-ownership-store.js'

const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const OTHER_SID = '80927570-0000-4000-8000-000000000000'
const CODEX_THREAD = '019fc80a-cc79-7921-8541-298e71695afd'
const PID = 7872
const SOCKET = '/tmp/cc-socks/7872.sock'
const CWD = '/Users/ukaoma/Documents/GitHub/cos-glasses-server'
const PROC_START_UTC = 'Sun Aug 16 02:03:05 2026'
const ACTUAL_START_MS = Date.UTC(2026, 7, 16, 2, 3, 5) // 21:03:05 CDT, the same instant
const NOW = 1_786_000_000_000

let claudeDir = ''
let codexDir = ''
let storeFile = ''
let idSeq = 0

/** Deterministic ids. Must satisfy BINDING_ID_RE once prefixed, and PIN_JOB_ID_RE bare. */
const nextId = (): string => `n${++idSeq}`

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: PID,
    sessionId: SID,
    procStart: PROC_START_UTC,
    messagingSocketPath: SOCKET,
    cwd: CWD,
    // Present so no test can pass by reading a field that cannot identify
    // anything: a CLI `claude -p` reports these identically to a desktop window.
    kind: 'interactive',
    entrypoint: 'claude-desktop',
    ...over,
  }
}

function probes(over: Partial<OccupancyProbes> = {}): OccupancyProbes {
  return {
    isAlive: () => true,
    processStartMs: () => ACTUAL_START_MS,
    fileExists: () => true,
    dirExists: () => true,
    readDir: () => [`${PID}.json`],
    readFile: () => JSON.stringify(record()),
    lockHolders: () => [],
    cosSpawnedPids: () => new Map<number, number>(),
    ...over,
  }
}

/**
 * The same live foreign holder as `probes()`, plus a transcript clock.
 *
 * `workingProbes` reports a transcript written this instant, so the holder is
 * measured WORKING and the gate refuses with `native_thread_working`.
 * `idleHolderProbes` reports one written ten minutes ago: held open, demonstrably
 * not writing, which is the case the 6.32.0 relaxation exists for.
 *
 * Bare `probes()` deliberately has NO clock and therefore still produces
 * `live_desktop_process`. That is the pre-relaxation behaviour every other case
 * in this file asserts, and it has to keep working untouched.
 */
function workingProbes(over: Partial<OccupancyProbes> = {}): OccupancyProbes {
  return probes({ transcriptMtimeMs: () => Date.now(), ...over })
}

function idleHolderProbes(over: Partial<OccupancyProbes> = {}): OccupancyProbes {
  return probes({ transcriptMtimeMs: () => Date.now() - 10 * 60_000, ...over })
}

/** Probes that throw on contact. Anything that still returns a verdict never probed. */
function hostileProbes(): OccupancyProbes {
  const boom = (): never => { throw new Error('probe must not run') }
  return {
    isAlive: boom,
    processStartMs: boom,
    fileExists: boom,
    dirExists: boom,
    readDir: boom,
    readFile: boom,
    lockHolders: boom,
    cosSpawnedPids: boom,
  }
}

function binding(over: Partial<NativeBinding> = {}): NativeBinding {
  return {
    bindingId: 'bnd-2026-08-15-01',
    // Both of the next three are the values the type actually permits and that a
    // careless projection would forward. SAFE_ID_RE allows ':' and '/' in a
    // sessionId, and nothing constrains a "fingerprint" to be a hash.
    cosSessionId: 'cos/chat:42',
    provider: 'claude',
    nativeThreadId: SID,
    targetKey: targetKey('claude', SID),
    workspaceFingerprint: CWD,
    sourceFingerprint: SOCKET,
    nativeHeadAtAttach: null,
    epoch: 3,
    state: 'active',
    expiresAt: NOW + 60_000,
    pinnedJobs: [],
    ...over,
  }
}

function deps(over: Partial<AgentSessionBindingsDeps> = {}): AgentSessionBindingsDeps {
  return {
    probes: probes(),
    dirs: { claudeSessionsDir: claudeDir, codexLocksDir: codexDir },
    now: () => NOW,
    bindings: reg(() => []),
    // The write feature is OFF by default in production (plan 4.9), so the suite
    // must opt IN explicitly. Leaving it implicit would mean every test below
    // silently exercised the disabled short-circuit instead of the real code.
    attachEnabled: true,
    ...over,
  }
}

/** A wired registry. `available` is required, so every fixture must answer it. */
function reg(list: () => readonly NativeBinding[], available: () => boolean = () => true) {
  return { list, available }
}

// ------------------------------------------------------------------ write side
//
// The attach and turn suites run against the REAL AgentSessionBindingRegistry on
// a real file wherever the behavior under test is the registry's — the durable
// epoch floor, one binding per target, pin lifetime. A fake registry cannot
// demonstrate a high-water mark that survives a rehydrate, and re-implementing
// one in the test would be a test of the test. Fakes appear only where the point
// IS the pathological answer.

const FREE_THREAD_RECORD = () => JSON.stringify(record({ sessionId: OTHER_SID }))

/** Probes for a thread with no live owner: the registry exists and names someone else. */
function freeProbes(over: Partial<OccupancyProbes> = {}): OccupancyProbes {
  return probes({ readFile: FREE_THREAD_RECORD, ...over })
}

function openRegistry(): AgentSessionBindingRegistry {
  return AgentSessionBindingRegistry.open({ filePath: storeFile, now: NOW, onWarn: () => {} })
}

/** Bind the real registry into the router's dependency shape, with optional holes punched. */
function wire(r: AgentSessionBindingRegistry, over: Partial<BindingRegistry> = {}): BindingRegistry {
  return {
    list: () => r.list(),
    available: () => r.available(),
    create: input => r.create(input),
    activate: (id, now) => r.activate(id, now),
    forceDetach: (id, now) => r.forceDetach(id, now),
    get: id => r.get(id),
    checkQueuedPrompt: (claim, now) => r.checkQueuedPrompt(claim, now),
    pin: (id, job, now) => r.pin(id, job, now),
    unpin: (id, job, now) => r.unpin(id, job, now),
    // Forwarded, or the replay short-circuit is silently absent and every
    // idempotency test would exercise the un-guarded path while looking correct.
    findTurn: (id, turnId) => r.findTurn(id, turnId),
    recordTurn: (id, turnId, result, now) => r.recordTurn(id, turnId, result, now),
    ...over,
  }
}

/** A registry that answers whatever the case needs, for states the real one will not produce. */
function fakeReg(binding: NativeBinding | null, over: Partial<BindingRegistry> = {}): BindingRegistry {
  return {
    list: () => (binding ? [binding] : []),
    available: () => true,
    create: () => ({ binding: null, reason: 'registry_full' }),
    activate: () => ({ binding: null, reason: 'terminal_state' }),
    forceDetach: () => ({ binding: null, reason: 'unknown_binding' }),
    get: () => binding,
    checkQueuedPrompt: () => ({ ok: true, reason: null }),
    pin: () => (binding ? { binding, reason: null } : { binding: null, reason: 'unknown_binding' }),
    unpin: () => (binding ? { binding, reason: null } : { binding: null, reason: 'unknown_binding' }),
    ...over,
  }
}

const RESOLUTION = { workspaceFingerprint: CWD, sourceFingerprint: SOCKET }

function writeDeps(over: Partial<AgentSessionBindingsDeps> = {}): AgentSessionBindingsDeps {
  return {
    probes: freeProbes(),
    dirs: { claudeSessionsDir: claudeDir, codexLocksDir: codexDir },
    now: () => NOW,
    bindings: wire(openRegistry()),
    // Write tests exercise the enabled path; the gate's own tests drive OFF.
    attachEnabled: true,
    resolveTarget: () => RESOLUTION,
    nativeHead: () => 'native-head-1',
    deliverAttachedTurn: async () => ({ status: 'completed', nativeRevisionAfter: 'native-head-1' }),
    // The real ledger is process-wide; every write test injects its own so one
    // test cannot vouch for another test's pid.
    ownership: { record: () => 'recorded', release: () => true },
    newId: nextId,
    ...over,
  }
}

interface PostResult { status: number; body: any; text: string }

async function post(base: string, path: string, body?: unknown): Promise<PostResult> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await res.text()
  const result = { status: res.status, body: text.length > 0 ? JSON.parse(text) : null, text }

  // A turn is admitted with 202 and delivered in the background, so the outcome a
  // caller cares about arrives in the durable ledger rather than in this response.
  // Settle it here and hand back what the turn ACTUALLY produced — the ledger's own
  // recorded status and terminal body — so a test reads the real result of the real
  // queued path instead of a fabricated one.
  //
  // Deliberately not a synchronous test mode: a sync fixture could not reproduce
  // the properties that are new here (the 202, the ledger as the only reporting
  // channel, the status route), which is precisely the class of substitution that
  // leaves a suite green while the shipped path is dead.
  if (result.status === 202 && result.body?.outcome === 'queued') {
    const clientTurnId = result.body?.clientTurnId
    const bindingId = result.body?.bindingId
    if (typeof clientTurnId === 'string' && typeof bindingId === 'string') {
      const final = await settled(base, bindingId, clientTurnId)
      const { recordedStatus, polled: _polled, ...body } = final as Record<string, unknown>
      return {
        status: typeof recordedStatus === 'number' ? recordedStatus : 200,
        body,
        text: JSON.stringify(body),
      }
    }
  }
  return result
}

const attachPath = (provider = 'claude', threadId = SID) =>
  `/api/agent-sessions/${provider}/${threadId}/attach`
const turnsPath = (bindingId: string) => `/api/agent-sessions/bindings/${bindingId}/turns`

/**
 * Wait for a QUEUED turn to reach a terminal outcome, and return it.
 *
 * A turn is admitted with 202 and delivered in the background, because a provider
 * turn runs for minutes and a phone cannot hold a request open across it. So the
 * outcome these tests care about arrives in the durable turn ledger, not in the
 * POST response.
 *
 * Polls the REAL status route rather than reaching into the route's internals.
 * There is deliberately no test-only hook to await the background promise: a
 * backdoor would let the shipped polling path rot while the suite stayed green,
 * and the poll IS what the client does.
 */
async function settled(
  base: string,
  bindingId: string,
  clientTurnId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4_000
  let last: PostResult | null = null
  while (Date.now() < deadline) {
    const res = await fetch(`${base}${turnsPath(bindingId)}/${clientTurnId}`)
    const text = await res.text()
    last = { status: res.status, body: text.length > 0 ? JSON.parse(text) : null, text }
    const outcome = last.body?.outcome
    // 404 `unknown` is a legitimate waiting state here as well as a terminal
    // answer: the ledger only records a turn once it settles.
    if (outcome !== 'pending' && outcome !== 'unknown' && outcome !== 'unavailable') {
      return last.body as Record<string, unknown>
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`turn ${clientTurnId} never settled; last=${last?.text ?? 'none'}`)
}

/**
 * Run a turn to its terminal outcome and return that outcome.
 *
 * Asserts the 202 admission internally, so a test reading the terminal result is
 * still proving the turn was queued rather than run inline. A synchronous refusal
 * (every gate before the queue point) is returned as-is: those never reach the
 * ledger by design, because a pre-delivery "no" must stay re-evaluatable.
 */
async function turnOutcome(
  base: string,
  a: { bindingId: string },
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await post(base, turnsPath(a.bindingId), body)
  if (res.status !== 202) return res.body as Record<string, unknown>
  expect(res.body).toMatchObject({ outcome: 'queued', deliveryState: 'pending' })
  return settled(base, a.bindingId, String(body.clientTurnId))
}

async function attach(
  d: AgentSessionBindingsDeps,
  body: unknown = { cosSessionId: 'cos/chat:42' },
  provider = 'claude',
  threadId = SID,
): Promise<PostResult> {
  return post(await start(d), attachPath(provider, threadId), body)
}

/** Attach on a live base URL and return the fields a turn needs. */
async function attached(base: string, threadId = SID): Promise<{
  bindingId: string
  epoch: number
  boundTo: string
  revision: string
  targetKey: string
  res: PostResult
}> {
  const res = await post(base, attachPath('claude', threadId), { cosSessionId: 'cos/chat:42' })
  return {
    bindingId: res.body?.bindingId,
    epoch: res.body?.epoch,
    boundTo: res.body?.boundTo,
    revision: res.body?.revision,
    targetKey: targetKey('claude', threadId),
    res,
  }
}

const PROMPT = 'keep going on the parser'

const closers: Array<() => Promise<void>> = []

/**
 * `parseJson: false` reproduces a remount above the global body parser, which is
 * the one production wiring mistake that makes `req.body` undefined.
 */
async function start(d: AgentSessionBindingsDeps, opts: { parseJson?: boolean } = {}): Promise<string> {
  const app = express()
  // Mirrors index.ts:262, which installs the parser before this router at :296.
  if (opts.parseJson !== false) app.use(express.json({ limit: '10mb' }))
  app.use('/api', createAgentSessionBindingsRouter(d))
  const server = await new Promise<ReturnType<typeof app.listen>>(r => {
    const l = app.listen(0, '127.0.0.1', () => r(l))
  })
  closers.push(() => new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res()))))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function attachability(
  d: AgentSessionBindingsDeps,
  provider = 'claude',
  threadId = SID,
): Promise<{ status: number; body: any; cacheControl: string | null; text: string }> {
  const base = await start(d)
  const res = await fetch(`${base}/api/agent-sessions/${provider}/${threadId}/attachability`)
  const text = await res.text()
  return {
    status: res.status,
    body: JSON.parse(text),
    cacheControl: res.headers.get('cache-control'),
    text,
  }
}

async function bindings(
  d: AgentSessionBindingsDeps,
): Promise<{ status: number; body: any; cacheControl: string | null; text: string }> {
  const base = await start(d)
  const res = await fetch(`${base}/api/agent-sessions/bindings`)
  const text = await res.text()
  return { status: res.status, body: JSON.parse(text), cacheControl: res.headers.get('cache-control'), text }
}

beforeEach(() => {
  const parent = mkdtempSync(join(tmpdir(), 'cos-attachability-'))
  claudeDir = resolve(parent, '.claude-fixture', 'sessions')
  codexDir = resolve(parent, '.codex-fixture', 'thread-writer-locks')
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(codexDir, { recursive: true })
  // Durable binding store, under a dot component for the same reason as above.
  storeFile = resolve(parent, '.cos-glasses-fixture', 'agent-session-bindings.json')
  mkdirSync(resolve(parent, '.cos-glasses-fixture'), { recursive: true })
  idSeq = 0
})

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

describe('the one verdict that opens the gate', () => {
  it('is attachable only after a real scan finds no owner', async () => {
    // The directory exists (the detector applies here), the record parses, and it
    // names a DIFFERENT thread. That is positive proof of an empty registry.
    const { status, body } = await attachability(
      deps({ probes: probes({ readFile: () => JSON.stringify(record({ sessionId: OTHER_SID })) }) }),
    )
    expect(status).toBe(200)
    expect(body).toEqual({
      attachable: true,
      reason: null,
      reasonCopy: ATTACHABLE_COPY,
      ownerCount: 0,
    })
  })

  it('refuses a live foreign owner and names it in words the footer can show', async () => {
    const { status, body } = await attachability(deps())
    expect(status).toBe(200)
    expect(body.attachable).toBe(false)
    expect(body.reason).toBe('live_desktop_process')
    expect(body.ownerCount).toBe(1)
    // Plan 4.3: the refusal must read as deliberate safety, name the reason
    // plainly, and offer Fork.
    expect(body.reasonCopy).toContain('Open on your Mac')
    expect(body.reasonCopy).toContain('Fork')
  })

  it('attaches over an owner the spawn ledger proves is ours, and still counts it', async () => {
    // Self-ownership is the ONLY path that turns a live owner into attachable, and
    // it requires the recorded process start to match, so a recycled pid cannot
    // forge it. The count stays 1: this route never reports fewer owners than it saw.
    const { body } = await attachability(
      deps({ probes: probes({ cosSpawnedPids: () => new Map([[PID, ACTUAL_START_MS]]) }) }),
    )
    expect(body.attachable).toBe(true)
    expect(body.ownerCount).toBe(1)
  })

  it('does NOT attach when the ledger names our pid but the process start disagrees', async () => {
    // Same pid, different process. PID reuse must not forge self-ownership.
    const { body } = await attachability(
      deps({ probes: probes({ cosSpawnedPids: () => new Map([[PID, ACTUAL_START_MS - 90_000]]) }) }),
    )
    expect(body.attachable).toBe(false)
    expect(body.reason).toBe('live_desktop_process')
  })
})

describe('"the mechanism is absent" is not "the mechanism found nothing"', () => {
  it('gives the two states different reasons and only one of them attaches', async () => {
    const scanned = await attachability(
      deps({ probes: probes({ readFile: () => JSON.stringify(record({ sessionId: OTHER_SID })) }) }),
    )
    const absent = await attachability(deps({ probes: probes({ dirExists: () => false }) }))

    expect(scanned.body.attachable).toBe(true)
    expect(scanned.body.reason).toBeNull()
    expect(absent.body.attachable).toBe(false)
    expect(absent.body.reason).toBe('detector_unavailable')
  })

  it('an empty registry directory on a build with no registry never reads as free', async () => {
    // Claude Code only writes sessions/<pid>.json from 2.1.224. On an older build
    // the directory is missing while attachable-looking threads exist.
    const { body } = await attachability(deps({ probes: probes({ dirExists: () => false, readDir: () => [] }) }))
    expect(body.attachable).toBe(false)
  })
})

describe('validation happens before the filesystem does', () => {
  it('rejects a malformed id without probing anything', async () => {
    // Hostile probes throw on contact, so `probe_failed` here would mean the id
    // reached the scan. `invalid_thread_id` is only reachable by validating first.
    const { status, body } = await attachability(deps({ probes: hostileProbes() }), 'claude', 'not-a-uuid')
    expect(status).toBe(200)
    expect(body).toMatchObject({ attachable: false, reason: 'invalid_thread_id' })
  })

  it('rejects the 8-character display form, which is what a lens row shows', async () => {
    const { body } = await attachability(deps({ probes: hostileProbes() }), 'claude', SID.slice(0, 8))
    expect(body).toMatchObject({ attachable: false, reason: 'invalid_thread_id' })
  })

  it('rejects an uppercase id rather than normalising it', async () => {
    // Accepting two spellings of one thread would mint two different targetKeys
    // for the same target, which is a mutex bypass one phase later.
    const { body } = await attachability(deps({ probes: hostileProbes() }), 'claude', SID.toUpperCase())
    expect(body).toMatchObject({ attachable: false, reason: 'invalid_thread_id' })
  })

  it('rejects an id carrying a filesystem suffix', async () => {
    // codexLockPath interpolates this straight into a path.
    const { body } = await attachability(deps({ probes: hostileProbes() }), 'codex', `${CODEX_THREAD}.lock`)
    expect(body).toMatchObject({ attachable: false, reason: 'invalid_thread_id' })
  })

  it('never attaches on a path-traversal id', async () => {
    const encoded = encodeURIComponent('../../.codex/thread-writer-locks/x')
    const base = await start(deps({ probes: hostileProbes() }))
    const res = await fetch(`${base}/api/agent-sessions/codex/${encoded}/attachability`)
    if (res.status === 200) {
      expect(await res.json()).toMatchObject({ attachable: false, reason: 'invalid_thread_id' })
    } else {
      // Express may refuse to match the encoded separator at all. Also safe.
      expect(res.status).toBe(404)
    }
  })

  it('treats an unrecognised provider as a capability gap, not an error status', async () => {
    const { status, body } = await attachability(deps({ probes: hostileProbes() }), 'cursor')
    expect(status).toBe(200)
    expect(body).toMatchObject({ attachable: false, reason: 'unsupported_provider' })
  })

  it('does not case-normalise the provider either', async () => {
    const { body } = await attachability(deps({ probes: hostileProbes() }), 'Claude')
    expect(body).toMatchObject({ attachable: false, reason: 'unsupported_provider' })
  })

  it('reports the provider gap ahead of the id gap, matching the detector', async () => {
    // Pins the precedence so this route and threadOccupancy cannot drift apart.
    const { body } = await attachability(deps({ probes: hostileProbes() }), 'cursor', 'not-a-uuid')
    expect(body.reason).toBe('unsupported_provider')
  })
})

describe('the feature gate (plan 4.9): OFF is the pre-existing behavior', () => {
  it('does not ROUTE the write endpoints when disabled', async () => {
    // 404, not 403. An unregistered path means a disabled server holds no
    // reachable write code at all, which is stronger than a handler that declines.
    const base = await start(deps({ attachEnabled: false }))
    for (const path of [
      `/api/agent-sessions/claude/${SID}/attach`,
      '/api/agent-sessions/bindings/bind-1/turns',
      // Fork is deliberately NOT in this list — see the fork test below.
    ]) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      })
      expect(res.status).toBe(404)
    }
  })

  it('DOES route FORK even when the gate is off', async () => {
    // The correction. With fork behind the same flag, the shipping default was
    // incoherent: seventeen refusal strings say "Fork it instead", the lens draws
    // an enabled Fork row, and the tap got a bare Express 404 with no reason.
    //
    // The counter-argument is real and worth stating: fork does spawn a provider
    // CLI in the user's workspace, so it is not free. But the flag exists to gate
    // WRITING INTO AN EXISTING CONVERSATION, which fork does not do — the source
    // stays byte-identical, measured — and Miles specified the off-state as
    // "read-only sessions with the fork-only functionality". Fork available while
    // off is the requirement, not an accident.
    const base = await start(deps({ attachEnabled: false }))
    const res = await fetch(`${base}/api/agent-sessions/claude/${SID}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    })
    expect(res.status).not.toBe(404)
  })

  it('DOES route them when enabled, so 404 cannot become the answer in both states', async () => {
    const base = await start(deps())
    const res = await fetch(`${base}/api/agent-sessions/claude/${SID}/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).not.toBe(404)
  })

  it('keeps the read-only surface working when disabled', async () => {
    // Everything that existed before this feature must be unaffected.
    const base = await start(deps({ attachEnabled: false }))
    expect((await fetch(`${base}/api/agent-sessions/bindings`)).status).toBe(200)
  })

  it('reads the env var strictly, so a truthy-looking value stays OFF', () => {
    const prior = process.env.COS_THREAD_ATTACH_ENABLED
    try {
      for (const v of ['true', 'yes', 'on', '2', '']) {
        process.env.COS_THREAD_ATTACH_ENABLED = v
        expect(threadAttachEnabled()).toBe(false)
      }
      process.env.COS_THREAD_ATTACH_ENABLED = '1'
      expect(threadAttachEnabled()).toBe(true)
      delete process.env.COS_THREAD_ATTACH_ENABLED
      expect(threadAttachEnabled()).toBe(false)
    } finally {
      if (prior === undefined) delete process.env.COS_THREAD_ATTACH_ENABLED
      else process.env.COS_THREAD_ATTACH_ENABLED = prior
    }
  })
})

describe('every doubt the detector can raise reaches the wire as a refusal', () => {
  const cases: Array<{ reason: OccupancyReason; d: () => AgentSessionBindingsDeps; provider?: string; id?: string }> = [
    { reason: 'live_desktop_process', d: () => deps() },
    // Same live holder, but with a transcript clock that says it is mid-write.
    { reason: 'native_thread_working', d: () => deps({ probes: workingProbes() }) },
    // Hostile probes prove the disabled path never reaches the filesystem: if the
    // short-circuit were removed, these probes throw and the reason becomes
    // probe_failed instead.
    { reason: 'attach_disabled', d: () => deps({ attachEnabled: false, probes: hostileProbes() }) },
    { reason: 'unsupported_provider', d: () => deps({ probes: hostileProbes() }), provider: 'cursor' },
    { reason: 'invalid_thread_id', d: () => deps({ probes: hostileProbes() }), id: 'nope' },
    { reason: 'detector_unavailable', d: () => deps({ probes: probes({ dirExists: () => false }) }) },
    { reason: 'registry_unreadable', d: () => deps({ probes: probes({ readFile: () => null }) }) },
    {
      reason: 'unverifiable_process_start',
      d: () => deps({ probes: probes({ processStartMs: () => ACTUAL_START_MS - 90_000 }) }),
    },
    {
      reason: 'unverifiable_liveness_socket',
      d: () => deps({ probes: probes({ fileExists: () => false }) }),
    },
    {
      reason: 'probe_failed',
      d: () => deps({ probes: probes({ readDir: () => { throw new Error('EACCES') } }) }),
    },
  ]

  it('covers the whole reason enum, so a new reason cannot ship untested', () => {
    // Guards both directions: a reason added to REASON_COPY without a route case
    // fails here, and a case for a reason with no copy fails here too. The
    // compiler already refuses a REASON_COPY missing a union member.
    expect(new Set(cases.map(c => c.reason))).toEqual(new Set(Object.keys(REASON_COPY)))
  })

  for (const c of cases) {
    it(`${c.reason}: 200, not attachable, and non-empty footer copy`, async () => {
      const { status, body } = await attachability(c.d(), c.provider ?? 'claude', c.id ?? SID)
      expect(status).toBe(200)
      expect(body.attachable).toBe(false)
      expect(body.reason).toBe(c.reason)
      expect(body.reasonCopy).toBe(REASON_COPY[c.reason])
      expect(body.reasonCopy.length).toBeGreaterThan(0)
      expect(Object.keys(body).sort()).toEqual(['attachable', 'ownerCount', 'reason', 'reasonCopy'])
    })
  }
})

describe('codex uses its own detector and fails closed the same way', () => {
  it('an open writer-lock descriptor is a live owner', async () => {
    const { body } = await attachability(
      deps({ probes: probes({ lockHolders: () => [PID] }) }),
      'codex',
      CODEX_THREAD,
    )
    expect(body).toMatchObject({ attachable: false, reason: 'live_desktop_process', ownerCount: 1 })
  })

  it('no holders on an existing locks directory is genuinely free', async () => {
    // lsof -t exits 1 with empty output when nothing holds the file. That is not
    // an error, and the lock FILE outliving its run is why holders is the signal.
    const { body } = await attachability(deps(), 'codex', CODEX_THREAD)
    expect(body).toMatchObject({ attachable: true, ownerCount: 0 })
  })

  it('a missing locks directory is a capability gap, not an empty one', async () => {
    const { body } = await attachability(
      deps({ probes: probes({ dirExists: () => false }) }),
      'codex',
      CODEX_THREAD,
    )
    expect(body).toMatchObject({ attachable: false, reason: 'detector_unavailable' })
  })
})

describe('the route refuses a verdict that contradicts itself', () => {
  const contradiction = (verdict: Occupancy) => deps({ occupancy: () => verdict })
  const foreign: ThreadOwner = {
    provider: 'claude',
    threadId: SID,
    pid: PID,
    source: 'claude-registry',
    selfOwned: false,
  }

  it('will not attach over an owner that is not proved to be ours', async () => {
    const { body } = await attachability(contradiction({ attachable: true, owners: [foreign], reason: null }))
    expect(body.attachable).toBe(false)
    expect(body.ownerCount).toBe(1)
  })

  it('will not attach when a reason is present', async () => {
    const { body } = await attachability(
      contradiction({ attachable: true, owners: [], reason: 'live_desktop_process' }),
    )
    expect(body).toMatchObject({ attachable: false, reason: 'live_desktop_process' })
  })

  /**
   * The 6.32.0 exemption, and its exact boundary. `idleHolder` is the ONLY way a
   * foreign owner may ride an attachable verdict, and it must be the literal
   * `true` -- a truthy-looking value is a malformed verdict, and a malformed
   * verdict buys nothing.
   */
  it('forwards a foreign owner only when the verdict declares idleHolder', async () => {
    const declared = await attachability(
      contradiction({ attachable: true, owners: [foreign], reason: null, idleHolder: true }),
    )
    expect(declared.body).toMatchObject({ attachable: true, reason: null, ownerCount: 1 })

    for (const forged of [1, 'true', 'yes', {}, [true]]) {
      const { body } = await attachability(contradiction({
        attachable: true, owners: [foreign], reason: null,
        idleHolder: forged as unknown as true,
      }))
      expect(body.attachable).toBe(false)
    }
  })

  it('does not let idleHolder excuse any other contradiction', async () => {
    // It exempts a foreign OWNER and nothing else. A reason present alongside
    // attachable, or a non-array owners field, is still a defect.
    const withReason = await attachability(contradiction({
      attachable: true, owners: [foreign], reason: 'live_desktop_process', idleHolder: true,
    }))
    expect(withReason.body).toMatchObject({ attachable: false, reason: 'live_desktop_process' })

    const badOwners = await attachability(contradiction({
      attachable: true, owners: 'none' as unknown as ThreadOwner[], reason: null, idleHolder: true,
    }))
    expect(badOwners.body).toMatchObject({ attachable: false, ownerCount: 0 })
  })

  it('will not attach when the owner list is not a list', async () => {
    const { body } = await attachability(
      contradiction({ attachable: true, owners: 'none' as unknown as ThreadOwner[], reason: null }),
    )
    expect(body).toMatchObject({ attachable: false, ownerCount: 0 })
  })

  it('renders a refusal for a reason this build does not recognise', async () => {
    const { body } = await attachability(
      contradiction({ attachable: false, owners: [], reason: 'reason_from_the_future' as OccupancyReason }),
    )
    expect(body.attachable).toBe(false)
    expect(body.reasonCopy).toBe(UNKNOWN_REASON_COPY)
    expect(body.reasonCopy.length).toBeGreaterThan(0)
  })

  it('turns a throwing detector into a refusal rather than a 500', async () => {
    const { status, body } = await attachability(
      deps({ occupancy: () => { throw new Error('detector bug') } }),
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({ attachable: false, reason: 'probe_failed' })
  })
})

describe('missing dependencies are a capability gap, not a crash and not an attach', () => {
  it('answers detector_unavailable when the probes were never wired', async () => {
    const { status, body } = await attachability({ attachEnabled: true } as AgentSessionBindingsDeps)
    expect(status).toBe(200)
    expect(body).toMatchObject({ attachable: false, reason: 'detector_unavailable' })
  })

  it('answers detector_unavailable when the dirs were never wired', async () => {
    const { body } = await attachability(
      { probes: probes(), now: () => NOW, bindings: { list: () => [] }, attachEnabled: true } as unknown as AgentSessionBindingsDeps,
    )
    expect(body).toMatchObject({ attachable: false, reason: 'detector_unavailable' })
  })

  it('marks the binding list unavailable when the registry was never wired', async () => {
    const { status, body } = await bindings({} as AgentSessionBindingsDeps)
    expect(status).toBe(503)
    expect(body).toMatchObject({ available: false, bindings: [], reason: 'binding_registry_unwired' })
  })

  it('says a missing clock is a wiring gap, not a failed read', async () => {
    // Registry fully wired; only the clock is absent.
    const { body } = await bindings({ bindings: reg(() => []) } as unknown as AgentSessionBindingsDeps)
    expect(body.reason).toBe('binding_registry_unwired')
  })

  it('refuses a registry that cannot answer whether it is usable', async () => {
    const { status, body } = await bindings(
      deps({ bindings: { list: () => [] } as unknown as AgentSessionBindingsDeps['bindings'] }),
    )
    expect(status).toBe(503)
    expect(body.reason).toBe('binding_registry_unwired')
  })
})

describe('the response says nothing that identifies the thread, the process, or the machine', () => {
  it('carries exactly four fields and no path, pid, or native id', async () => {
    const { body, text } = await attachability(deps())
    expect(Object.keys(body).sort()).toEqual(['attachable', 'ownerCount', 'reason', 'reasonCopy'])
    expect(text).not.toContain(String(PID))
    expect(text).not.toContain(SID)
    expect(text).not.toContain(SID.slice(0, 8))
    expect(text).not.toContain('/tmp/')
    expect(text).not.toContain(CWD)
    expect(text).not.toContain(claudeDir)
    expect(text).not.toContain(targetKey('claude', SID))
    // A standing proof no future field can be path-shaped: nothing this route
    // returns contains a path separator at all.
    expect(text).not.toContain('/')
  })

  it('is never cached, because the verdict is a liveness answer', async () => {
    const { cacheControl } = await attachability(deps())
    expect(cacheControl).toContain('no-store')
  })
})

describe('the binding list', () => {
  it('shows non-terminal leases only', async () => {
    const rows = [
      binding({ bindingId: 'staging-one', state: 'staging' }),
      binding({ bindingId: 'active-one', state: 'active' }),
      binding({ bindingId: 'detaching-one', state: 'detaching' }),
      binding({ bindingId: 'detached-one', state: 'detached' }),
    ]
    const { status, body } = await bindings(deps({ bindings: reg(() => rows) }))
    expect(status).toBe(200)
    expect(body.available).toBe(true)
    expect(body.bindings.map((b: any) => b.bindingId)).toEqual(['staging-one', 'active-one'])
  })

  it('redacts every row to the same non-identifying shape', async () => {
    const { body, text } = await bindings(deps({ bindings: reg(() => [binding()]) }))
    expect(Object.keys(body.bindings[0]).sort()).toEqual([
      'bindingId', 'epoch', 'expired', 'expiresAt', 'pinned', 'provider', 'state',
    ])
    expect(text).not.toContain(SID)
    expect(text).not.toContain(targetKey('claude', SID))
    expect(text).not.toContain('cos/chat:42')
    expect(text).not.toContain(CWD)
    expect(text).not.toContain(SOCKET)
    expect(text).not.toContain('/')
  })

  it('reports expiry against the injected clock', async () => {
    const rows = [
      binding({ bindingId: 'fresh', expiresAt: NOW + 1 }),
      binding({ bindingId: 'lapsed', expiresAt: NOW - 1 }),
    ]
    const { body } = await bindings(deps({ bindings: reg(() => rows) }))
    expect(body.bindings.map((b: any) => [b.bindingId, b.expired])).toEqual([['fresh', false], ['lapsed', true]])
  })

  it('never reports a pinned lease as expired, because live work outranks the TTL', async () => {
    const rows = [binding({ bindingId: 'pinned', expiresAt: NOW - 60_000, pinnedJobs: ['job-1'] })]
    const { body } = await bindings(deps({ bindings: reg(() => rows) }))
    expect(body.bindings[0]).toMatchObject({ pinned: true, expired: false })
  })

  it('does NOT answer with an empty list when it could not read the registry', async () => {
    // The outcome that matters: a caller must not be able to read this as
    // "nothing is bound". An empty 200 here would be indistinguishable from the
    // genuinely-empty case below.
    const thrown = await bindings(deps({ bindings: reg(() => { throw new Error('EIO') }) }))
    const empty = await bindings(deps({ bindings: reg(() => []) }))

    expect(thrown.status).toBe(503)
    expect(thrown.body.available).toBe(false)
    // A read that failed, distinct from a registry that was never wired in.
    expect(thrown.body.reason).toBe('binding_registry_unavailable')
    expect(empty.status).toBe(200)
    expect(empty.body.available).toBe(true)
    expect(empty.body.bindings).toEqual([])
  })

  it('does NOT answer with an empty list when the durable store hydrated degraded', async () => {
    // The seam that made `available` a required member. The real registry
    // (lib/agent-session-binding-registry.ts:578) answers `list()` with [] in this
    // state instead of throwing, so a route that only guarded the throw would have
    // published "nothing is bound" from a store it could not read.
    const degraded = await bindings(deps({ bindings: reg(() => [], () => false) }))
    const genuinelyEmpty = await bindings(deps({ bindings: reg(() => []) }))

    expect(degraded.status).toBe(503)
    expect(degraded.body).toMatchObject({ available: false, bindings: [], reason: 'binding_registry_degraded' })
    expect(genuinelyEmpty.status).toBe(200)
    expect(genuinelyEmpty.body.available).toBe(true)
  })

  it('treats a non-boolean usability answer as unusable', async () => {
    const fuzzy = reg(() => [binding()], (() => 'probably') as unknown as () => boolean)
    const { status, body } = await bindings(deps({ bindings: fuzzy }))
    expect(status).toBe(503)
    expect(body.reason).toBe('binding_registry_degraded')
  })

  it('reports a throwing usability probe as a failed read, not as usable', async () => {
    const { status, body } = await bindings(
      deps({ bindings: reg(() => [binding()], () => { throw new Error('EIO') }) }),
    )
    expect(status).toBe(503)
    expect(body.reason).toBe('binding_registry_unavailable')
  })

  it('marks the whole listing unavailable rather than silently dropping a bad row', async () => {
    // A shorter list would tell an operator a binding is gone when it may be live
    // and holding a native target.
    const rows = [binding(), { ...binding({ bindingId: 'broken' }), nativeThreadId: 'not-a-uuid' }]
    const { status, body } = await bindings(deps({ bindings: reg(() => rows as NativeBinding[]) }))
    expect(status).toBe(503)
    expect(body).toMatchObject({ available: false, bindings: [] })
  })

  it('rejects a row whose state is not a real state', async () => {
    const rows = [{ ...binding(), state: 'toString' as unknown as NativeBinding['state'] }]
    const { status, body } = await bindings(deps({ bindings: reg(() => rows) }))
    expect(status).toBe(503)
    expect(body.available).toBe(false)
  })

  it('rejects a registry that does not return a list at all', async () => {
    const { status, body } = await bindings(
      deps({ bindings: reg(() => null as unknown as NativeBinding[]) }),
    )
    expect(status).toBe(503)
    expect(body.available).toBe(false)
  })

  it('rejects an unusable clock rather than computing expiry from it', async () => {
    const { status, body } = await bindings(
      deps({ bindings: reg(() => [binding()]), now: () => Number.NaN }),
    )
    expect(status).toBe(503)
    expect(body.available).toBe(false)
  })

  it('is never cached either', async () => {
    const { cacheControl } = await bindings(deps({ bindings: reg(() => [binding()]) }))
    expect(cacheControl).toContain('no-store')
  })
})

describe('attach is gated on the occupancy verdict, not advised by it', () => {
  it('mints an active lease when the thread is provably free', async () => {
    const r = openRegistry()
    const res = await attach(writeDeps({ bindings: wire(r) }))

    expect(res.status).toBe(201)
    expect(res.body.attached).toBe(true)
    expect(res.body.epoch).toBe(1)
    // The one outcome a caller depends on: a live lease now exists for this target.
    const live = r.getByThread('claude', SID, NOW)
    expect(live?.bindingId).toBe(res.body.bindingId)
    expect(live?.state).toBe('active')
    expect(live?.nativeHeadAtAttach).toBe(opaqueRevision('native-head-1'))
  })

  // Every doubt the detector can raise, driven through attach. The assertion is
  // that NOTHING WAS CREATED — a refusal that still leaves a lease behind would
  // let the turn route run against a thread attach just declined.
  const refusals: Array<{ reason: OccupancyReason; d: () => AgentSessionBindingsDeps; provider?: string; id?: string }> = [
    { reason: 'live_desktop_process', d: () => writeDeps({ probes: probes() }) },
    { reason: 'native_thread_working', d: () => writeDeps({ probes: workingProbes() }) },
    { reason: 'unsupported_provider', d: () => writeDeps({ probes: hostileProbes() }), provider: 'cursor' },
    { reason: 'invalid_thread_id', d: () => writeDeps({ probes: hostileProbes() }), id: 'not-a-uuid' },
    { reason: 'detector_unavailable', d: () => writeDeps({ probes: freeProbes({ dirExists: () => false }) }) },
    { reason: 'registry_unreadable', d: () => writeDeps({ probes: freeProbes({ readFile: () => null }) }) },
    {
      reason: 'unverifiable_process_start',
      d: () => writeDeps({ probes: probes({ processStartMs: () => ACTUAL_START_MS - 90_000 }) }),
    },
    { reason: 'unverifiable_liveness_socket', d: () => writeDeps({ probes: probes({ fileExists: () => false }) }) },
    {
      reason: 'probe_failed',
      d: () => writeDeps({ probes: freeProbes({ readDir: () => { throw new Error('EACCES') } }) }),
    },
  ]

  for (const c of refusals) {
    it(`refuses on ${c.reason} and creates no binding`, async () => {
      const r = openRegistry()
      const res = await attach({ ...c.d(), bindings: wire(r) }, { cosSessionId: 'cos-1' }, c.provider ?? 'claude', c.id ?? SID)
      expect(res.body.attached).toBe(false)
      expect(res.body.reason).toBe(c.reason)
      expect(res.body.reasonCopy).toBe(REASON_COPY[c.reason])
      expect(r.list()).toEqual([])
    })
  }

  it('gives a live desktop owner the same words the attachability probe gives', async () => {
    // A lens that renders one renders the other, because it is one string.
    const refused = await attach(writeDeps({ probes: probes() }))
    const probed = await attachability(deps())
    expect(refused.body.reasonCopy).toBe(probed.body.reasonCopy)
    expect(refused.body.reasonCopy).toContain('Fork')
  })
})

describe('one lease per target, and an epoch that only ever goes up', () => {
  it('refuses a second attach rather than silently re-binding', async () => {
    const r = openRegistry()
    const base = await start(writeDeps({ bindings: wire(r) }))
    const first = await attached(base)
    const second = await post(base, attachPath(), { cosSessionId: 'cos-2' })

    expect(second.status).toBe(409)
    expect(second.body.reason).toBe('native_target_busy')
    // The first lease is untouched: not replaced, not re-epoched, still the owner.
    expect(r.getByThread('claude', SID, NOW)?.bindingId).toBe(first.bindingId)
    expect(r.getByThread('claude', SID, NOW)?.epoch).toBe(1)
  })

  it('does not restart the epoch after the previous lease is gone, even across a reopen', async () => {
    // The replay window. A prompt queued against epoch 1 must never match a later
    // attach to the same thread, so the floor has to come from durable state and
    // not from whatever binding happens to be in memory.
    const r1 = openRegistry()
    const base1 = await start(writeDeps({ bindings: wire(r1) }))
    const first = await attached(base1)
    expect(first.epoch).toBe(1)
    r1.forceDetach(first.bindingId, NOW)

    const second = await attached(base1)
    expect(second.epoch).toBe(2)
    r1.forceDetach(second.bindingId, NOW)

    // A different registry instance over the same file: a process restart.
    const r2 = openRegistry()
    const base2 = await start(writeDeps({ bindings: wire(r2) }))
    const third = await attached(base2)
    expect(third.epoch).toBe(3)
  })

  it('frees the target when activation fails, instead of stranding it busy', async () => {
    const r = openRegistry()
    const broken = await start(writeDeps({ bindings: wire(r, { activate: () => ({ binding: null, reason: 'binding_expired' }) }) }))
    const failed = await post(broken, attachPath(), { cosSessionId: 'cos-1' })
    expect(failed.status).toBe(409)
    expect(failed.body.reason).toBe('binding_expired')

    // The outcome that matters: the next attach is not locked out by the corpse
    // of the one that never activated.
    const healthy = await start(writeDeps({ bindings: wire(r) }))
    const next = await post(healthy, attachPath(), { cosSessionId: 'cos-1' })
    expect(next.status).toBe(201)
    expect(r.getByThread('claude', SID, NOW)?.bindingId).toBe(next.body.bindingId)
  })
})

describe('attach refuses anything it cannot establish for itself', () => {
  const cases: Array<{ name: string; reason: WriteRefusal; d: () => AgentSessionBindingsDeps; body?: unknown }> = [
    { name: 'no COS chat named', reason: 'invalid_request', d: () => writeDeps(), body: {} },
    { name: 'a body that is not an object', reason: 'invalid_request', d: () => writeDeps(), body: ['cos-1'] },
    {
      name: 'a COS chat id shaped like junk',
      reason: 'invalid_request',
      d: () => writeDeps(),
      body: { cosSessionId: '../../etc' },
    },
    {
      name: 'no target resolver wired',
      reason: 'target_unresolvable',
      d: () => writeDeps({ resolveTarget: undefined }),
    },
    {
      name: 'a resolver that cannot place the thread',
      reason: 'target_unresolvable',
      d: () => writeDeps({ resolveTarget: () => null }),
    },
    {
      name: 'a resolver that throws',
      reason: 'target_unresolvable',
      d: () => writeDeps({ resolveTarget: () => { throw new Error('no cwd') } }),
    },
    {
      name: 'a resolver that answers half',
      reason: 'target_unresolvable',
      d: () => writeDeps({ resolveTarget: () => ({ workspaceFingerprint: CWD, sourceFingerprint: '' }) }),
    },
    {
      name: 'no head module wired',
      reason: 'native_head_unavailable',
      d: () => writeDeps({ nativeHead: undefined }),
    },
    {
      name: 'a head module that cannot read the thread',
      reason: 'native_head_unavailable',
      d: () => writeDeps({ nativeHead: () => null }),
    },
    {
      name: 'a head module that throws',
      reason: 'native_head_unavailable',
      d: () => writeDeps({ nativeHead: () => { throw new Error('ENOENT') } }),
    },
    {
      name: 'a registry that cannot record the lease',
      reason: 'attach_failed',
      d: () => writeDeps({ bindings: fakeReg(null) }),
    },
    {
      name: 'a read-only registry',
      reason: 'binding_registry_unwired',
      d: () => writeDeps({ bindings: reg(() => []) as BindingRegistry }),
    },
    {
      name: 'a registry that hydrated degraded',
      reason: 'binding_registry_degraded',
      d: () => writeDeps({ bindings: fakeReg(null, { available: () => false }) }),
    },
    {
      name: 'a registry that cannot say whether it works',
      reason: 'binding_registry_unavailable',
      d: () => writeDeps({ bindings: fakeReg(null, { available: () => { throw new Error('EIO') } }) }),
    },
    {
      name: 'a clock that is not a clock',
      reason: 'binding_registry_unavailable',
      d: () => writeDeps({ now: () => Number.NaN }),
    },
  ]

  for (const c of cases) {
    it(`refuses ${c.name}`, async () => {
      const res = await attach(c.d(), c.body === undefined ? { cosSessionId: 'cos-1' } : c.body)
      expect(res.body.attached).toBe(false)
      expect(res.body.reason).toBe(c.reason)
      expect(res.body.reasonCopy.length).toBeGreaterThan(0)
      expect(res.status).toBe(c.reason === 'invalid_request' ? 400 : c.reason.startsWith('binding_registry') ? 503 : 409)
    })
  }

  it('treats an unparsed body as unreadable rather than as an empty one', async () => {
    const r = openRegistry()
    const base = await start(writeDeps({ bindings: wire(r) }), { parseJson: false })
    const res = await post(base, attachPath(), { cosSessionId: 'cos-1' })
    expect(res.body.reason).toBe('invalid_request')
    expect(r.list()).toEqual([])
  })

  // Distinct from a detector that ran and found nothing, and distinct from one
  // that threw: this build cannot check for a live owner at all. Without the
  // wiring gate the same request still refuses, but as `probe_failed`, which
  // tells an operator a probe misbehaved rather than that a build is wired wrong.
  it('names a missing detector as a capability gap, not a failed probe', async () => {
    const r = openRegistry()
    const res = await attach({
      ...writeDeps({ bindings: wire(r) }),
      probes: undefined as unknown as OccupancyProbes,
    })
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('detector_unavailable')
    expect(r.list()).toEqual([])
  })

  it('names missing directories the same way', async () => {
    const res = await attach({
      ...writeDeps(),
      dirs: undefined as unknown as AgentSessionBindingsDeps['dirs'],
    })
    expect(res.body.reason).toBe('detector_unavailable')
  })
})

describe('the attach response identifies nothing', () => {
  it('carries no native id, no target key, no path and no marker that embeds one', async () => {
    const res = await attach(writeDeps())
    expect(res.status).toBe(201)
    expect(Object.keys(res.body).sort()).toEqual([
      'attached', 'binding', 'bindingId', 'boundTo', 'epoch', 'reason', 'reasonCopy', 'revision',
    ])
    // Same redacted row shape the list route publishes.
    expect(Object.keys(res.body.binding).sort()).toEqual([
      'bindingId', 'epoch', 'expired', 'expiresAt', 'pinned', 'provider', 'state',
    ])
    expect(res.text).not.toContain(SID)
    expect(res.text).not.toContain(SID.slice(0, 8))
    expect(res.text).not.toContain(targetKey('claude', SID))
    expect(res.text).not.toContain(CWD)
    expect(res.text).not.toContain(SOCKET)
    expect(res.text).not.toContain(String(PID))
    expect(res.text).not.toContain('native-head-1')
    expect(res.text).not.toContain('/')
  })

  it('publishes a boundTo the server can recompute but a reader cannot unpack', async () => {
    const r = openRegistry()
    const res = await attach(writeDeps({ bindings: wire(r) }))
    const live = r.get(res.body.bindingId)!
    // The raw marker is length-prefixed over the targetKey, so it contains the
    // private native id verbatim. What ships is the digest of it.
    expect(boundToMarker(live)).toContain(SID)
    expect(res.body.boundTo).toBe(opaqueRevision(boundToMarker(live)))
    expect(res.body.boundTo).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is never cached', async () => {
    const base = await start(writeDeps())
    const res = await fetch(`${base}${attachPath()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cosSessionId: 'cos-1' }),
    })
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})

// ------------------------------------------------------------------ turns

/** A binding shaped for the fake-registry cases, carrying the default head baseline. */
function fakeBinding(over: Partial<NativeBinding> = {}): NativeBinding {
  return binding({ nativeHeadAtAttach: opaqueRevision('native-head-1'), ...over })
}

let claimSeq = 0
/**
 * A turn claim with a FRESH idempotency key each call.
 *
 * Shared was wrong once the turn ledger existed: every test posting the same key
 * meant a later test replayed an earlier one's recorded result, which showed up as
 * a single test passing alone and failing in the suite. The ledger doing exactly
 * its job, on the fixture.
 */
const fakeClaim = () => ({
  prompt: PROMPT,
  epoch: 3,
  targetKey: targetKey('claude', SID),
  clientTurnId: `ct-seq-${String(++claimSeq).padStart(6, '0')}`,
})

describe('a turn delivers only after the thread is re-proved free', () => {
  it('sends the prompt and the exact native id, and reports a delivered turn', async () => {
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      deliverAttachedTurn: async req => {
        calls.push(req)
        return { status: 'completed', nativeRevisionAfter: 'native-head-1' }
      },
    }))
    const a = await attached(base)
    const out = await turnOutcome(base, a, {
      prompt: PROMPT, clientTurnId: 'ct-ml-0001', epoch: a.epoch, targetKey: a.targetKey, boundTo: a.boundTo,
    })

    expect(out).toMatchObject({ outcome: 'completed', deliveryState: 'delivered', retryable: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'claude',
      nativeThreadId: SID,
      prompt: PROMPT,
      epoch: 1,
      bindingId: a.bindingId,
      workspaceFingerprint: CWD,
      sourceFingerprint: SOCKET,
      // The RAW token, so an adapter can re-assert it; only the digest ships.
      expectedNativeHead: 'native-head-1',
    })
  })

  it('refuses a turn when a desktop process appeared after the attach', async () => {
    // Plan 4.3 step 6, and the residual risk option B leaves open. Terminal, not
    // a warning: COS has no lock that can fence a live desktop writer.
    let free = true
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      probes: probes({ readFile: () => (free ? FREE_THREAD_RECORD() : JSON.stringify(record())) }),
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = await attached(base)
    expect(a.res.status).toBe(201)

    free = false
    const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0001' })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      reason: 'live_desktop_process',
      deliveryState: 'not_delivered',
      outcome: 'refused',
    })
    expect(calls).toHaveLength(0)
  })

  it('refuses when the live-owner check itself becomes unavailable', async () => {
    let ready = true
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      probes: freeProbes({ dirExists: () => ready }),
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = await attached(base)
    ready = false
    const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0002' })

    expect(res.body.reason).toBe('detector_unavailable')
    expect(calls).toHaveLength(0)
  })
})

describe('the native head watermark, and the second turn that must not be refused for it', () => {
  it('lets a second turn through after the first turn moved the head itself', async () => {
    // The regression that reads as a detector bug: turn one advances the native
    // head, so a binding still holding its attach baseline refuses every turn
    // after the first.
    const head = { value: 'h1' }
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      nativeHead: () => head.value,
      deliverAttachedTurn: async req => {
        calls.push(req)
        head.value = `h${calls.length + 1}`
        return { status: 'completed', nativeRevisionAfter: head.value }
      },
    }))
    const a = await attached(base)
    const body = { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0003' }

    const first = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0001' })
    const second = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0002' })

    expect(first.body.outcome).toBe('completed')
    expect(second.body.outcome).toBe('completed')
    expect(calls).toHaveLength(2)
    expect(second.body.revision).toBe(opaqueRevision('h3'))
  })

  it('re-reads the head itself when the adapter does not report one', async () => {
    const head = { value: 'h1' }
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      nativeHead: () => head.value,
      deliverAttachedTurn: async req => {
        calls.push(req)
        head.value = 'h2'
        return { status: 'completed' } // no nativeRevisionAfter
      },
    }))
    const a = await attached(base)
    const body = { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0004' }

    expect((await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0003' })).body.outcome).toBe('completed')
    expect((await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0004' })).body.outcome).toBe('completed')
    expect(calls).toHaveLength(2)
  })

  it('refuses a turn when the desktop moved the thread, and says only that it moved', async () => {
    const head = { value: 'h1' }
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      nativeHead: () => head.value,
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = await attached(base)
    head.value = 'the user typed something on their mac'

    const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0005' })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      reason: 'native_thread_changed',
      changed: true,
      deliveryState: 'not_delivered',
      revision: opaqueRevision('the user typed something on their mac'),
    })
    expect(calls).toHaveLength(0)
    // Only a changed signal and an opaque revision. Never a diff, never content.
    expect(res.text).not.toContain('the user typed')
    expect(res.body.reasonCopy).toContain('changed')
  })

  it('accepts Continue Anyway as a new admission carrying the acknowledged revision', async () => {
    const head = { value: 'h1' }
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      nativeHead: () => head.value,
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed', nativeRevisionAfter: head.value } },
    }))
    const a = await attached(base)
    head.value = 'h2'
    const body = { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0006' }

    const refused = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0005' })
    const accepted = await post(base, turnsPath(a.bindingId), { ...body, acknowledgedRevision: refused.body.revision })

    expect(refused.body.reason).toBe('native_thread_changed')
    expect(accepted.body.outcome).toBe('completed')
    expect(calls).toHaveLength(1)
  })

  it('does not accept an acknowledgement of some earlier revision', async () => {
    // Acknowledging h2 must not license delivery into h3.
    const head = { value: 'h1' }
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      nativeHead: () => head.value,
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = await attached(base)
    head.value = 'h2'
    const stale = (await post(base, turnsPath(a.bindingId), {
      prompt: PROMPT, clientTurnId: 'ct-ml-0002', epoch: a.epoch, targetKey: a.targetKey,
    })).body.revision

    head.value = 'h3'
    const res = await post(base, turnsPath(a.bindingId), {
      prompt: PROMPT, clientTurnId: 'ct-ml-0003', epoch: a.epoch, targetKey: a.targetKey, acknowledgedRevision: stale,
    })

    expect(res.body).toMatchObject({ reason: 'native_thread_changed', revision: opaqueRevision('h3') })
    expect(calls).toHaveLength(0)
  })

  it('refuses rather than delivering blind when the head cannot be read at turn time', async () => {
    const head: { value: string | null } = { value: 'native-head-1' }
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      nativeHead: () => head.value,
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = await attached(base)
    head.value = null

    const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0007' })
    expect(res.body.reason).toBe('native_head_unavailable')
    expect(calls).toHaveLength(0)
  })
})

describe('COS must be able to tell its own child from a desktop window', () => {
  const CHILD_PID = 424242
  const LEDGER_NOW = Date.UTC(2026, 0, 2, 9, 30, 0)
  const CHILD_START_MS = LEDGER_NOW - 5_000
  // Same instant, in the UTC-formatted `ps lstart` shape Claude writes.
  const CHILD_PROC_START = 'Fri Jan 2 09:29:55 2026'

  /**
   * Probes for the moment that matters: our own `claude --resume` child has just
   * registered ITSELF in the sessions directory, against the very id we target.
   */
  function childProbes(ledger: CosSpawnLedger, registered: () => boolean): OccupancyProbes {
    return {
      isAlive: () => true,
      processStartMs: pid => (pid === CHILD_PID ? CHILD_START_MS : ACTUAL_START_MS),
      fileExists: () => true,
      dirExists: () => true,
      readDir: () => (registered() ? [`${CHILD_PID}.json`] : []),
      readFile: () => JSON.stringify(record({ pid: CHILD_PID, procStart: CHILD_PROC_START })),
      lockHolders: () => [],
      cosSpawnedPids: () => ledger.snapshot(),
    }
  }

  it('records the spawn with the MEASURED process start, so its own child reads as ours', async () => {
    const ledger = new CosSpawnLedger({ now: () => LEDGER_NOW })
    let registered = false
    let spawnAccepted: boolean | null = null
    let seenDuringDelivery: Occupancy | null = null
    const dirs = { claudeSessionsDir: claudeDir, codexLocksDir: codexDir }
    const probeSet = childProbes(ledger, () => registered)

    const base = await start(writeDeps({
      probes: probeSet,
      ownership: { record: (pid, startMs) => ledger.record(pid, startMs), release: pid => ledger.release(pid) },
      deliverAttachedTurn: async req => {
        // The child registers itself against our target id, then we claim it.
        registered = true
        spawnAccepted = req.onSpawn(CHILD_PID)
        // What a fresh occupancy check sees while our own child is live.
        seenDuringDelivery = threadOccupancy('claude', SID, probeSet, dirs)
        return { status: 'completed', nativeRevisionAfter: 'native-head-1' }
      },
    }))

    const a = await attached(base)
    const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0008' })

    expect(res.body.outcome).toBe('completed')
    expect(spawnAccepted).toBe(true)
    // The whole point: our own child is an owner, and it is recognised as OURS.
    // Recording a wall clock instead of the measured start puts the ledger entry
    // outside the 1500 ms tolerance and this flips to live_desktop_process, after
    // which every later turn on the thread refuses forever.
    expect(seenDuringDelivery!.owners).toHaveLength(1)
    expect(seenDuringDelivery!.owners[0]).toMatchObject({ pid: CHILD_PID, selfOwned: true })
    expect(seenDuringDelivery!.attachable).toBe(true)
    // Released in the finally, so the ledger does not accumulate dead children.
    expect(ledger.snapshot().has(CHILD_PID)).toBe(false)
  })

  it('releases the spawn even when the adapter throws', async () => {
    const ledger = new CosSpawnLedger({ now: () => LEDGER_NOW })
    const base = await start(writeDeps({
      probes: childProbes(ledger, () => false),
      ownership: { record: (pid, startMs) => ledger.record(pid, startMs), release: pid => ledger.release(pid) },
      deliverAttachedTurn: async req => {
        req.onSpawn(CHILD_PID)
        throw new Error('provider died')
      },
    }))
    const a = await attached(base)
    await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0009' })
    expect(ledger.snapshot().has(CHILD_PID)).toBe(false)
  })

  it('tells the adapter to abort when the child cannot be identified', async () => {
    // No measurable process start means COS could never recognise this child, so
    // delivering would poison the next occupancy check on this thread.
    const ledger = new CosSpawnLedger({ now: () => LEDGER_NOW })
    let spawnAccepted: boolean | null = null
    const base = await start(writeDeps({
      // The registry directory is empty (nothing owns the thread) and no process
      // start is measurable for anything.
      probes: { ...childProbes(ledger, () => false), processStartMs: () => null },
      ownership: { record: (pid, startMs) => ledger.record(pid, startMs), release: pid => ledger.release(pid) },
      deliverAttachedTurn: async req => {
        spawnAccepted = req.onSpawn(CHILD_PID)
        return spawnAccepted ? { status: 'completed' } : { status: 'aborted', reason: 'unidentifiable child' }
      },
    }))
    const a = await attached(base)
    const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0010' })

    expect(spawnAccepted).toBe(false)
    expect(res.body).toMatchObject({ reason: 'provider_never_opened', deliveryState: 'not_delivered' })
    expect(ledger.snapshot().has(CHILD_PID)).toBe(false)
  })

  it('refuses the spawn on its own when the start cannot be measured, not only when the ledger objects', async () => {
    // Two independent guards sit here: this route checks that a start was
    // measured, and the ledger separately rejects an implausible one. With a
    // ledger that accepts anything — which is what an injected or future ledger
    // may be — only the route's own check stands between an unidentifiable child
    // and a delivered turn.
    let spawnAccepted: boolean | null = null
    const accepting = { record: () => 'recorded', release: () => true }
    const base = await start(writeDeps({
      probes: freeProbes({ processStartMs: () => null }),
      ownership: accepting,
      deliverAttachedTurn: async req => {
        spawnAccepted = req.onSpawn(CHILD_PID)
        return spawnAccepted ? { status: 'completed' } : { status: 'aborted' }
      },
    }))
    const a = await attached(base)
    const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0011' })

    expect(spawnAccepted).toBe(false)
    expect(res.body.reason).toBe('provider_never_opened')
  })

  it('tells the adapter to abort when the ledger refuses the claim', async () => {
    let spawnAccepted: boolean | null = null
    const base = await start(writeDeps({
      ownership: { record: () => 'rejected_start_not_recent', release: () => false },
      deliverAttachedTurn: async req => {
        spawnAccepted = req.onSpawn(CHILD_PID)
        return spawnAccepted ? { status: 'completed' } : { status: 'aborted' }
      },
    }))
    const a = await attached(base)
    const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0012' })
    expect(spawnAccepted).toBe(false)
    expect(res.body.reason).toBe('provider_never_opened')
  })
})

/** A delivery the test can hold open. */
function heldDelivery() {
  let open!: () => void
  const gate = new Promise<void>(resolve => { open = resolve })
  const calls: AttachedTurnRequest[] = []
  return {
    calls,
    open,
    deliver: async (req: AttachedTurnRequest) => {
      calls.push(req)
      await gate
      return { status: 'completed' as const, nativeRevisionAfter: 'native-head-1' }
    },
  }
}

// ---------------------------------------------------------------------- fork
//
// `FORKED_SID` is the real id `claude --fork-session` produced from a live source
// thread on this machine on 2026-08-16. The route's own contract is that it never
// puts a value like this on the wire, so the redaction tests below are only
// meaningful with a real one in the fixture.

const FORKED_SID = 'd92ad220-34b4-4f67-b2d8-1d1dd00a2dce'
const FORK_BODY = { cosSessionId: 'cos/chat:42', prompt: PROMPT }

const forkPath = (provider = 'claude', threadId = SID) =>
  `/api/agent-sessions/${provider}/${threadId}/fork`

/** The shape `server/lib/fork-thread.ts` really returns on a clean fork. */
const FORK_SUCCESS = {
  ok: true,
  provider: 'claude',
  sourceNativeThreadId: SID,
  newNativeThreadId: FORKED_SID,
  forkState: 'created',
  sourceIntegrity: 'verified_unchanged',
  reason: null,
  exitCode: 0,
  durationMs: 812,
} as const

/** Provably nothing was created: the binary was never found. */
const FORK_CLEAN_FAILURE = {
  ok: false,
  provider: 'claude',
  sourceNativeThreadId: SID,
  newNativeThreadId: null,
  forkState: 'none',
  sourceIntegrity: 'unverified',
  reason: 'binary_not_found',
  detail: 'claude:not_found',
  exitCode: null,
  stderrClass: 'none',
  durationMs: 4,
} as const

/** The worst outcome the feature has: the ORIGINAL moved while we copied it. */
const FORK_MUTATED = {
  ok: false,
  provider: 'claude',
  sourceNativeThreadId: SID,
  newNativeThreadId: FORKED_SID,
  forkState: 'created',
  sourceIntegrity: 'mutated',
  reason: 'source_thread_mutated',
  detail: 'after:ok',
  exitCode: 0,
  stderrClass: 'none',
  durationMs: 903,
} as const

function forkDeps(over: Partial<AgentSessionBindingsDeps> = {}): AgentSessionBindingsDeps {
  return writeDeps({
    forkThread: () => FORK_SUCCESS,
    // Server-side, absolute. The client never sends this.
    resolveForkWorkspace: () => CWD,
    ...over,
  })
}

function heldFork() {
  let open!: () => void
  const gate = new Promise<void>(resolve => { open = resolve })
  const seen = { n: 0 }
  return {
    get calls() { return seen.n },
    open,
    // Only the FIRST call is held. Gating every call deadlocks any test that needs
    // a second fork to COMPLETE while the first is still in flight, which is
    // exactly the concurrency this helper exists to set up.
    fork: async () => { if (++seen.n === 1) await gate; return FORK_SUCCESS },
  }
}

describe('one COS turn per native target at a time', () => {
  it('refuses a second turn while the first is still in flight, then allows one after', async () => {
    const held = heldDelivery()
    const base = await start(writeDeps({ deliverAttachedTurn: held.deliver }))
    const a = await attached(base)
    const body = { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0013' }

    const inFlight = post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0006' })
    // Let the first request reach the adapter before the second is admitted.
    while (held.calls.length === 0) await new Promise(r => setTimeout(r, 2))

    const second = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0007' })
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ reason: 'native_turn_in_progress', deliveryState: 'not_delivered' })
    expect(held.calls).toHaveLength(1)

    held.open()
    expect((await inFlight).body.outcome).toBe('completed')

    // The claim is released on the way out, so the thread is usable again.
    const third = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0008' })
    expect(third.body.outcome).toBe('completed')
    expect(held.calls).toHaveLength(2)
  })

  it('holds the binding pinned for the whole turn and lets go afterwards', async () => {
    // A pinned binding never expires, which is what stops the lease dying under a
    // running turn. A pin that outlived the turn would make it immortal instead.
    const r = openRegistry()
    let pinnedDuring: readonly string[] = []
    const base = await start(writeDeps({
      bindings: wire(r),
      deliverAttachedTurn: async req => {
        pinnedDuring = r.get(req.bindingId)?.pinnedJobs ?? []
        return { status: 'completed', nativeRevisionAfter: 'native-head-1' }
      },
    }))
    const a = await attached(base)
    await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0014' })

    expect(pinnedDuring).toHaveLength(1)
    expect(r.get(a.bindingId)?.pinnedJobs).toEqual([])
  })

  it('unpins even when the adapter throws', async () => {
    const r = openRegistry()
    const base = await start(writeDeps({
      bindings: wire(r),
      deliverAttachedTurn: async () => { throw new Error('provider died') },
    }))
    const a = await attached(base)
    await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0015' })
    expect(r.get(a.bindingId)?.pinnedJobs).toEqual([])
  })

  it('does not deliver when the binding cannot be pinned', async () => {
    const calls: AttachedTurnRequest[] = []
    const res = await post(
      await start(writeDeps({
        bindings: fakeReg(fakeBinding(), { pin: () => ({ binding: null, reason: 'too_many_pins' }) }),
        deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
      })),
      turnsPath('bnd-2026-08-15-01'),
      fakeClaim(),
    )
    expect(res.body.reason).toBe('pin_failed')
    expect(calls).toHaveLength(0)
  })
})

describe('a turn whose delivery cannot be accounted for shuts the target', () => {
  const unaccountable: Array<{ name: string; deliver: () => Promise<unknown> }> = [
    { name: 'the adapter throws', deliver: async () => { throw new Error('socket closed') } },
    { name: 'the adapter returns nothing', deliver: async () => undefined },
    { name: 'the adapter returns a status this build does not know', deliver: async () => ({ status: 'partial' }) },
    { name: 'the adapter returns a bare string', deliver: async () => 'ok' },
    { name: 'the adapter returns an array', deliver: async () => [{ status: 'completed' }] },
  ]

  for (const c of unaccountable) {
    it(`reports unknown delivery and refuses a retry when ${c.name}`, async () => {
      const base = await start(writeDeps({ deliverAttachedTurn: c.deliver }))
      const a = await attached(base)
      const body = { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0016' }
      const first = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0009' })

      expect(first.body).toMatchObject({
        outcome: 'ambiguous',
        deliveryState: 'unknown',
        retryable: false,
        reason: 'delivery_ambiguous',
      })
      expect(first.body.reasonCopy).toContain('check before sending again')

      // Plan 4.6: the reservation is HELD. A second turn — the shape of the
      // client Retry button, which mints a fresh identity that clears every other
      // fence — must not deliver a second copy into a real conversation.
      const second = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0010' })
      expect(second.body).toMatchObject({
        reason: 'native_target_fenced',
        retryable: false,
        deliveryState: 'unknown',
      })
    })
  }

  // `server/lib/attached-provider-adapter.ts` reports `{ ok, delivery }`, not
  // `{ status }`. Recognising that shape here rather than through a wiring shim
  // removes the place a mapping bug would live, and every combination this build
  // cannot map still lands on ambiguous.
  const adapterShapes: Array<{ result: unknown; outcome: string; deliveryState: string }> = [
    { result: { ok: true, delivery: 'delivered' }, outcome: 'completed', deliveryState: 'delivered' },
    { result: { ok: false, delivery: 'not_attempted' }, outcome: 'refused', deliveryState: 'not_delivered' },
    { result: { ok: false, delivery: 'aborted' }, outcome: 'refused', deliveryState: 'not_delivered' },
    { result: { ok: false, delivery: 'ambiguous' }, outcome: 'ambiguous', deliveryState: 'unknown' },
    { result: { ok: false, delivery: 'delivered' }, outcome: 'ambiguous', deliveryState: 'unknown' },
    // Contradictions: succeeded, but not delivered. Never read as done.
    { result: { ok: true, delivery: 'ambiguous' }, outcome: 'ambiguous', deliveryState: 'unknown' },
    { result: { ok: true, delivery: 'not_attempted' }, outcome: 'ambiguous', deliveryState: 'unknown' },
    // A delivery state from a newer adapter than this build knows.
    { result: { ok: false, delivery: 'partially_streamed' }, outcome: 'ambiguous', deliveryState: 'unknown' },
    { result: { ok: true }, outcome: 'ambiguous', deliveryState: 'unknown' },
  ]

  for (const c of adapterShapes) {
    it(`reads ${JSON.stringify(c.result)} as ${c.outcome}`, async () => {
      const base = await start(writeDeps({ deliverAttachedTurn: async () => c.result }))
      const a = await attached(base)
      const res = await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0017' })
      expect(res.body.outcome).toBe(c.outcome)
      expect(res.body.deliveryState).toBe(c.deliveryState)
    })
  }

  it('fences the TARGET, so re-attaching does not open it again', async () => {
    const r = openRegistry()
    const base = await start(writeDeps({
      bindings: wire(r),
      deliverAttachedTurn: async () => { throw new Error('socket closed') },
    }))
    const a = await attached(base)
    await post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0018' })

    // Even with the old lease gone, the thread stays shut.
    r.forceDetach(a.bindingId, NOW)
    const again = await post(base, attachPath(), { cosSessionId: 'cos-2' })
    expect(again.status).toBe(409)
    expect(again.body.reason).toBe('native_target_fenced')
  })

  it('does NOT fence when the provider provably never opened the session', async () => {
    // The distinction plan 4.6 item 4 exists for: if every spawn failure were
    // ambiguous, the scary state would become the default failure UX.
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      deliverAttachedTurn: async req => {
        calls.push(req)
        return calls.length === 1
          ? { status: 'aborted', reason: 'ENOENT' }
          : { status: 'completed', nativeRevisionAfter: 'native-head-1' }
      },
    }))
    const a = await attached(base)
    const body = { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0019' }

    const aborted = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0011' })
    expect(aborted.body).toMatchObject({
      reason: 'provider_never_opened',
      deliveryState: 'not_delivered',
      retryable: true,
    })

    const retried = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0012' })
    expect(retried.body.outcome).toBe('completed')
  })

  it('treats a bug in the route AROUND a delivery as unknown, and one before it as nothing sent', async () => {
    // Two failures that look alike from outside and must not be reported alike.
    const beforeDelivery = await post(
      await start(writeDeps({ bindings: fakeReg(fakeBinding(), { get: () => { throw new Error('EIO') } }) })),
      turnsPath('bnd-2026-08-15-01'),
      fakeClaim(),
    )
    expect(beforeDelivery.body).toMatchObject({
      reason: 'turn_failed',
      deliveryState: 'not_delivered',
      retryable: true,
    })

    const aroundDelivery = await (async () => {
      const base = await start(writeDeps({
        // Throws on the way OUT of a delivery that already happened.
        deliverAttachedTurn: async () => ({
          status: 'completed',
          get nativeRevisionAfter(): string { throw new Error('after read failed') },
        }),
      }))
      const a = await attached(base)
      return post(base, turnsPath(a.bindingId), { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0020' })
    })()
    expect(aroundDelivery.body).toMatchObject({ deliveryState: 'unknown', retryable: false })
  })
})

describe('a turn must prove which lease and which target it belongs to', () => {
  const claimCases: Array<{ name: string; reason: WriteRefusal; body: (a: { epoch: number; targetKey: string; boundTo: string }) => unknown }> = [
    { name: 'a prompt written against an earlier attach', reason: 'stale_epoch', body: a => ({ prompt: PROMPT, epoch: a.epoch + 1, targetKey: a.targetKey , clientTurnId: 'ct-auto-0021' }) },
    { name: 'a claim naming another thread', reason: 'target_mismatch', body: a => ({ prompt: PROMPT, epoch: a.epoch, targetKey: targetKey('claude', OTHER_SID) , clientTurnId: 'ct-auto-0022' }) },
    { name: 'a boundTo marker that does not match', reason: 'target_mismatch', body: a => ({ prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey, boundTo: 'f'.repeat(32) , clientTurnId: 'ct-auto-0023' }) },
    { name: 'no prompt', reason: 'invalid_request', body: a => ({ epoch: a.epoch, targetKey: a.targetKey }) },
    { name: 'an empty prompt', reason: 'invalid_request', body: a => ({ prompt: '   ', epoch: a.epoch, targetKey: a.targetKey }) },
    { name: 'no epoch', reason: 'invalid_request', body: a => ({ prompt: PROMPT, targetKey: a.targetKey }) },
    { name: 'an epoch that is not an integer', reason: 'invalid_request', body: a => ({ prompt: PROMPT, epoch: 1.5, targetKey: a.targetKey , clientTurnId: 'ct-auto-0024' }) },
    { name: 'no target key', reason: 'invalid_request', body: a => ({ prompt: PROMPT, epoch: a.epoch }) },
    { name: 'an acknowledgement that is not a revision', reason: 'invalid_request', body: a => ({ prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey, acknowledgedRevision: 'yes' , clientTurnId: 'ct-auto-0025' }) },
  ]

  for (const c of claimCases) {
    it(`refuses ${c.name} without delivering`, async () => {
      const calls: AttachedTurnRequest[] = []
      const base = await start(writeDeps({
        deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
      }))
      const a = await attached(base)
      const res = await post(base, turnsPath(a.bindingId), c.body(a))
      expect(res.body.reason).toBe(c.reason)
      expect(calls).toHaveLength(0)
    })
  }

  it('refuses an oversized prompt rather than shipping it', async () => {
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      maxPromptChars: 16,
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = await attached(base)
    const res = await post(base, turnsPath(a.bindingId), {
      prompt: 'x'.repeat(17), epoch: a.epoch, targetKey: a.targetKey,
    })
    expect(res.body.reason).toBe('invalid_request')
    expect(calls).toHaveLength(0)
  })

  it('treats an unparsed body as unreadable rather than as an empty turn', async () => {
    const calls: AttachedTurnRequest[] = []
    const base = await start(
      writeDeps({ deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } } }),
      { parseJson: false },
    )
    const res = await post(base, turnsPath('bnd-anything'), { prompt: PROMPT, epoch: 1, targetKey: 'k' , clientTurnId: 'ct-auto-0026' })
    expect(res.body.reason).toBe('invalid_request')
    expect(calls).toHaveLength(0)
  })

  const stateCases: Array<{ name: string; reason: WriteRefusal; bindings: () => BindingRegistry }> = [
    { name: 'a lease this server never issued', reason: 'unknown_binding', bindings: () => wire(openRegistry()) },
    { name: 'a lease still staging', reason: 'binding_not_active', bindings: () => fakeReg(fakeBinding({ state: 'staging' })) },
    { name: 'a lease being detached', reason: 'binding_detached', bindings: () => fakeReg(fakeBinding({ state: 'detaching' })) },
    { name: 'a detached lease', reason: 'binding_detached', bindings: () => fakeReg(fakeBinding({ state: 'detached' })) },
    { name: 'a lapsed lease', reason: 'binding_expired', bindings: () => fakeReg(fakeBinding({ expiresAt: NOW - 1 })) },
    {
      name: 'a lease the registry says cannot run work',
      reason: 'binding_unusable',
      bindings: () => fakeReg(fakeBinding(), { checkQueuedPrompt: () => ({ ok: false, reason: 'terminal_state' }) }),
    },
    {
      name: 'a lease whose stored thread id is not an id',
      reason: 'binding_unusable',
      bindings: () => fakeReg(fakeBinding({ nativeThreadId: SID.slice(0, 8) })),
    },
  ]

  // The queued-prompt gate and the binding it names are two reads of one store,
  // and the store's own header records that an earlier version had the full set
  // of checks in one place and a bare comparison in the other. These two prove
  // the route does not hand its whole safety to a single call: a registry whose
  // gate says yes while its record says otherwise is still refused.
  it('does not deliver on a stale epoch even when the queued-prompt gate waves it through', async () => {
    const calls: AttachedTurnRequest[] = []
    const res = await post(
      await start(writeDeps({
        bindings: fakeReg(fakeBinding({ epoch: 3 })),
        deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
      })),
      turnsPath('bnd-2026-08-15-01'),
      { ...fakeClaim(), epoch: 99 },
    )
    expect(res.body.reason).toBe('stale_epoch')
    expect(calls).toHaveLength(0)
  })

  it('does not deliver to another thread even when the queued-prompt gate waves it through', async () => {
    const calls: AttachedTurnRequest[] = []
    const res = await post(
      await start(writeDeps({
        bindings: fakeReg(fakeBinding()),
        deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
      })),
      turnsPath('bnd-2026-08-15-01'),
      { ...fakeClaim(), targetKey: targetKey('claude', OTHER_SID) },
    )
    expect(res.body.reason).toBe('target_mismatch')
    expect(calls).toHaveLength(0)
  })

  for (const c of stateCases) {
    it(`refuses ${c.name}`, async () => {
      const calls: AttachedTurnRequest[] = []
      const res = await post(
        await start(writeDeps({
          bindings: c.bindings(),
          deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
        })),
        turnsPath('bnd-2026-08-15-01'),
        fakeClaim(),
      )
      expect(res.body.reason).toBe(c.reason)
      expect(calls).toHaveLength(0)
    })
  }
})

describe('a turn cannot run on a build that is not equipped to run one', () => {
  // Status is stated per case rather than derived from the router's own table,
  // which would only assert that the table equals itself. 503 says "this build or
  // this machine cannot"; 409 says "the world is in a state you can act on".
  const gaps: Array<{ name: string; reason: WriteRefusal; status: number; over: Partial<AgentSessionBindingsDeps> }> = [
    { name: 'no attached adapter', reason: 'adapter_unwired', status: 503, over: { deliverAttachedTurn: undefined } },
    {
      name: 'no spawn ledger',
      reason: 'adapter_unwired',
      status: 503,
      over: { ownership: {} as AgentSessionBindingsDeps['ownership'] },
    },
    { name: 'no head module', reason: 'native_head_unavailable', status: 409, over: { nativeHead: undefined } },
    {
      name: 'a read-only registry',
      reason: 'binding_registry_unwired',
      status: 503,
      over: { bindings: reg(() => []) as BindingRegistry },
    },
    {
      name: 'no probes',
      reason: 'detector_unavailable',
      status: 503,
      over: { probes: undefined as unknown as OccupancyProbes },
    },
    {
      name: 'a degraded registry',
      reason: 'binding_registry_degraded',
      status: 503,
      over: { bindings: fakeReg(fakeBinding(), { available: () => false }) },
    },
    {
      name: 'a registry that cannot say whether it works',
      reason: 'binding_registry_unavailable',
      status: 503,
      over: { bindings: fakeReg(fakeBinding(), { available: () => { throw new Error('EIO') } }) },
    },
  ]

  for (const c of gaps) {
    it(`refuses with ${c.reason} when there is ${c.name}`, async () => {
      const res = await post(await start(writeDeps(c.over)), turnsPath('bnd-2026-08-15-01'), fakeClaim())
      expect(res.body.reason).toBe(c.reason)
      expect(res.status).toBe(c.status)
      expect(res.body.deliveryState).toBe('not_delivered')
    })
  }
})

describe('the turn response says nothing about the conversation it moved', () => {
  it('echoes no prompt, no native id, no target key and no path', async () => {
    const base = await start(writeDeps())
    const a = await attached(base)
    const res = await post(base, turnsPath(a.bindingId), {
      prompt: PROMPT, clientTurnId: 'ct-ml-0004', epoch: a.epoch, targetKey: a.targetKey, boundTo: a.boundTo,
    })
    expect(res.status).toBe(200)
    expect(res.text).not.toContain(PROMPT)
    expect(res.text).not.toContain('parser')
    expect(res.text).not.toContain(SID)
    expect(res.text).not.toContain(SID.slice(0, 8))
    expect(res.text).not.toContain(targetKey('claude', SID))
    expect(res.text).not.toContain(CWD)
    expect(res.text).not.toContain(SOCKET)
    expect(res.text).not.toContain(String(PID))
    expect(res.text).not.toContain('native-head-1')
    expect(res.text).not.toContain('/')
  })

  it('is never cached', async () => {
    const base = await start(writeDeps())
    const a = await attached(base)
    const res = await fetch(`${base}${turnsPath(a.bindingId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0027' }),
    })
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})

describe('every way a write can be refused reaches the wire with words', () => {
  /** Attach with the default free thread, then run one turn with the given body. */
  const oneTurn = async (over: Partial<AgentSessionBindingsDeps>, body?: (a: {
    epoch: number; targetKey: string; boundTo: string; revision: string
  }) => unknown): Promise<PostResult> => {
    const base = await start(writeDeps(over))
    const a = await attached(base)
    return post(base, turnsPath(a.bindingId), body ? body(a) : { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0028' })
  }

  const cases: Array<{ reason: WriteRefusal; run: () => Promise<PostResult> }> = [
    // The occupancy half, driven through attach so the shared copy is proved on
    // the write surface too and not only on the read-only probe.
    { reason: 'live_desktop_process', run: () => attach(writeDeps({ probes: probes() })) },
    { reason: 'native_thread_working', run: () => attach(writeDeps({ probes: workingProbes() })) },
    { reason: 'unsupported_provider', run: () => attach(writeDeps({ probes: hostileProbes() }), { cosSessionId: 'c' }, 'cursor') },
    { reason: 'invalid_thread_id', run: () => attach(writeDeps({ probes: hostileProbes() }), { cosSessionId: 'c' }, 'claude', 'nope') },
    { reason: 'detector_unavailable', run: () => attach(writeDeps({ probes: freeProbes({ dirExists: () => false }) })) },
    { reason: 'registry_unreadable', run: () => attach(writeDeps({ probes: freeProbes({ readFile: () => null }) })) },
    {
      reason: 'unverifiable_process_start',
      run: () => attach(writeDeps({ probes: probes({ processStartMs: () => ACTUAL_START_MS - 90_000 }) })),
    },
    { reason: 'unverifiable_liveness_socket', run: () => attach(writeDeps({ probes: probes({ fileExists: () => false }) })) },
    {
      reason: 'probe_failed',
      run: () => attach(writeDeps({ probes: freeProbes({ readDir: () => { throw new Error('EACCES') } }) })),
    },

    // The write half.
    { reason: 'invalid_request', run: () => attach(writeDeps(), {}) },
    { reason: 'binding_registry_unwired', run: () => attach(writeDeps({ bindings: reg(() => []) as BindingRegistry })) },
    {
      reason: 'binding_registry_degraded',
      run: () => attach(writeDeps({ bindings: fakeReg(null, { available: () => false }) })),
    },
    {
      reason: 'binding_registry_unavailable',
      run: () => attach(writeDeps({ bindings: fakeReg(null, { available: () => { throw new Error('EIO') } }) })),
    },
    { reason: 'target_unresolvable', run: () => attach(writeDeps({ resolveTarget: () => null })) },
    { reason: 'native_head_unavailable', run: () => attach(writeDeps({ nativeHead: () => null })) },
    { reason: 'attach_failed', run: () => attach(writeDeps({ bindings: fakeReg(null) })) },
    {
      reason: 'native_target_busy',
      run: async () => {
        const base = await start(writeDeps())
        await attached(base)
        return post(base, attachPath(), { cosSessionId: 'cos-2' })
      },
    },
    {
      reason: 'native_thread_changed',
      run: () => {
        const head = { value: 'h1' }
        let attachedOnce = false
        return oneTurn({
          nativeHead: () => {
            if (!attachedOnce) { attachedOnce = true; return head.value }
            return 'h2'
          },
        })
      },
    },
    {
      reason: 'native_turn_in_progress',
      run: async () => {
        const held = heldDelivery()
        const base = await start(writeDeps({ deliverAttachedTurn: held.deliver }))
        const a = await attached(base)
        const body = { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0029' }
        const inFlight = post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0013' })
        while (held.calls.length === 0) await new Promise(r => setTimeout(r, 2))
        const second = await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0014' })
        held.open()
        await inFlight
        return second
      },
    },
    {
      reason: 'native_target_fenced',
      run: async () => {
        const base = await start(writeDeps({ deliverAttachedTurn: async () => { throw new Error('lost') } }))
        const a = await attached(base)
        const body = { prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey , clientTurnId: 'ct-auto-0030' }
        await post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0015' })
        return post(base, turnsPath(a.bindingId), { ...body, clientTurnId: 'ct-multi-0016' })
      },
    },
    {
      reason: 'unknown_binding',
      run: async () => post(await start(writeDeps()), turnsPath('bnd-never-issued'), {
        prompt: PROMPT, epoch: 1, targetKey: targetKey('claude', SID), clientTurnId: 'ct-unknown-bind',
      }),
    },
    { reason: 'binding_not_active', run: () => turnOnFake(fakeReg(fakeBinding({ state: 'staging' }))) },
    { reason: 'binding_detached', run: () => turnOnFake(fakeReg(fakeBinding({ state: 'detached' }))) },
    { reason: 'binding_expired', run: () => turnOnFake(fakeReg(fakeBinding({ expiresAt: NOW - 1 }))) },
    {
      reason: 'binding_unusable',
      run: () => turnOnFake(fakeReg(fakeBinding(), { checkQueuedPrompt: () => ({ ok: false, reason: 'terminal_state' }) })),
    },
    { reason: 'stale_epoch', run: () => oneTurn({}, a => ({ prompt: PROMPT, epoch: a.epoch + 7, targetKey: a.targetKey , clientTurnId: 'ct-auto-0031' })) },
    {
      reason: 'target_mismatch',
      run: () => oneTurn({}, a => ({ prompt: PROMPT, epoch: a.epoch, targetKey: targetKey('claude', OTHER_SID) , clientTurnId: 'ct-auto-0032' })),
    },
    {
      reason: 'pin_failed',
      run: () => turnOnFake(fakeReg(fakeBinding(), { pin: () => ({ binding: null, reason: 'invalid_job_id' }) })),
    },
    { reason: 'adapter_unwired', run: () => oneTurn({ deliverAttachedTurn: undefined }) },
    { reason: 'provider_never_opened', run: () => oneTurn({ deliverAttachedTurn: async () => ({ status: 'aborted' }) }) },
    { reason: 'delivery_ambiguous', run: () => oneTurn({ deliverAttachedTurn: async () => ({ status: '?' }) }) },
    {
      reason: 'turn_failed',
      run: () => turnOnFake(fakeReg(fakeBinding(), { get: () => { throw new Error('EIO') } })),
    },
    // ------------------------------------------------------------------ fork
    { reason: 'fork_unwired', run: () => forkOnce({ forkThread: undefined }) },
    { reason: 'fork_unsupported_provider', run: () => forkOnce({}, 'cursor') },
    { reason: 'fork_invalid_thread_id', run: () => forkOnce({}, 'claude', '6d12ff82') },
    { reason: 'fork_workspace_unresolvable', run: () => forkOnce({ resolveForkWorkspace: () => null }) },
    {
      reason: 'fork_in_progress',
      run: async () => {
        // Bounded concurrency matters on this route specifically: it spawns a
        // provider CLI, so an unclaimed retry loop is one child per request.
        const held = heldFork()
        const base = await start(forkDeps({ forkThread: held.fork }))
        const inFlight = post(base, forkPath(), FORK_BODY)
        while (held.calls === 0) await new Promise(r => setTimeout(r, 2))
        const second = await post(base, forkPath(), FORK_BODY)
        held.open()
        await inFlight
        return second
      },
    },
    { reason: 'fork_failed', run: () => forkOnce({ forkThread: () => FORK_CLEAN_FAILURE }) },
    { reason: 'fork_source_mutated', run: () => forkOnce({ forkThread: () => FORK_MUTATED }) },
    { reason: 'fork_orphan_possible', run: () => forkOnce({ forkThread: () => ({ ok: false, forkState: 'possible' }) }) },
  ]

  async function turnOnFake(bindings: BindingRegistry): Promise<PostResult> {
    return post(await start(writeDeps({ bindings })), turnsPath('bnd-2026-08-15-01'), fakeClaim())
  }

  function forkOnce(
    over: Partial<AgentSessionBindingsDeps> = {},
    provider = 'claude',
    threadId = SID,
  ): Promise<PostResult> {
    return start(forkDeps(over)).then(base => post(base, forkPath(provider, threadId), FORK_BODY))
  }

  it('covers the whole refusal vocabulary, so a new one cannot ship untested', () => {
    // Both directions, exactly like the occupancy table above: a member with copy
    // and no case fails here, and a case for a member with no copy fails here. The
    // compiler already refuses a copy map missing a union member.
    // `attach_disabled` is the one member with no case, and that is STRUCTURAL
    // rather than an omission: it applies only when the feature is off, and when
    // the feature is off these routes are never registered, so a write can never
    // be refused for it (the gate suite above asserts the 404 instead). Named
    // explicitly so the exclusion is a decision a reader can check, not a hole.
    const unreachableAsWriteRefusal = new Set(['attach_disabled'])
    const vocabulary = new Set(
      [...Object.keys(REASON_COPY), ...Object.keys(WRITE_REASON_COPY)]
        .filter(reason => !unreachableAsWriteRefusal.has(reason)),
    )
    expect(new Set(cases.map(c => c.reason))).toEqual(vocabulary)
    // And prove the exclusion is honest: it must still carry footer copy, because
    // the attachability surface DOES render it.
    for (const reason of unreachableAsWriteRefusal) {
      expect((REASON_COPY as Record<string, string>)[reason]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  for (const c of cases) {
    it(`${c.reason}: refused, with footer copy and no path in the body`, async () => {
      const res = await c.run()
      expect(res.body.reason).toBe(c.reason)
      expect(typeof res.body.reasonCopy).toBe('string')
      expect(res.body.reasonCopy.length).toBeGreaterThan(0)
      expect(res.status).not.toBe(200)
      expect(res.status).not.toBe(201)
      expect(res.status).toBeLessThan(504)
      expect(res.text).not.toContain('/')
    })
  }
})


describe('a repeated POST replays instead of delivering twice', () => {
  // COST: measured on a disposable thread 2026-08-16. Two byte-identical POSTs both
  // returned `completed` and the user's REAL transcript ended up with two copies of
  // the turn. The client cannot tell "delivered but the 200 was lost" from "never
  // arrived", so retrying is correct behaviour and only the server can make it safe.
  const claim = (key: string) => ({
    prompt: PROMPT, epoch: 1, targetKey: targetKey('claude', SID), clientTurnId: key,
  })

  it('delivers ONCE for two identical POSTs', async () => {
    const calls: AttachedTurnRequest[] = []
    const bindings = wire(openRegistry())
    const base = await start(writeDeps({
      bindings,
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = (await post(base, attachPath(), { cosSessionId: 'cos-1' })).body

    const first = await post(base, turnsPath(a.bindingId), claim('ct-repeat-0001'))
    const second = await post(base, turnsPath(a.bindingId), claim('ct-repeat-0001'))

    expect(calls).toHaveLength(1)
    expect(first.body.outcome).toBe('completed')
    expect(second.body.outcome).toBe('completed')
    expect(second.body.replayed).toBe(true)
    expect(first.body.replayed).toBeUndefined()
  })

  it('delivers TWICE for two genuinely different turns', async () => {
    // The paired assertion: a guard that replayed everything would pass the test
    // above and break the feature.
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      bindings: wire(openRegistry()),
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = (await post(base, attachPath(), { cosSessionId: 'cos-1' })).body
    await post(base, turnsPath(a.bindingId), claim('ct-distinct-0001'))
    await post(base, turnsPath(a.bindingId), claim('ct-distinct-0002'))
    expect(calls).toHaveLength(2)
  })

  it('REFUSES a turn with no idempotency key', async () => {
    // A turn without one cannot be made safe, so it is rejected rather than
    // delivered on a best-effort basis.
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      bindings: wire(openRegistry()),
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = (await post(base, attachPath(), { cosSessionId: 'cos-1' })).body
    for (const bad of [undefined, '', 'short', 'has space', 'x'.repeat(200)]) {
      const res = await post(base, turnsPath(a.bindingId), {
        prompt: PROMPT, epoch: 1, targetKey: targetKey('claude', SID),
        ...(bad === undefined ? {} : { clientTurnId: bad }),
      })
      expect(res.body.reason).toBe('invalid_request')
    }
    expect(calls).toHaveLength(0)
  })

  it('replays an AMBIGUOUS outcome too, which is the one a client most wants to retry', async () => {
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      bindings: wire(openRegistry()),
      deliverAttachedTurn: async req => {
        calls.push(req)
        return { ok: false, delivery: 'ambiguous', reason: 'provider_exit_nonzero' }
      },
    }))
    const a = (await post(base, attachPath(), { cosSessionId: 'cos-1' })).body
    const first = await post(base, turnsPath(a.bindingId), claim('ct-ambig-0001'))
    const second = await post(base, turnsPath(a.bindingId), claim('ct-ambig-0001'))
    expect(first.body.outcome).toBe('ambiguous')
    expect(second.body.outcome).toBe('ambiguous')
    expect(second.body.replayed).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('does NOT replay a pre-delivery refusal, which must stay re-evaluatable', async () => {
    // A stale epoch or a busy target may be fine by the time the client retries.
    // Replaying a stale "no" would be its own bug.
    const calls: AttachedTurnRequest[] = []
    const base = await start(writeDeps({
      bindings: wire(openRegistry()),
      deliverAttachedTurn: async req => { calls.push(req); return { status: 'completed' } },
    }))
    const a = (await post(base, attachPath(), { cosSessionId: 'cos-1' })).body
    const stale = { ...claim('ct-stale-0001'), epoch: 99 }
    const first = await post(base, turnsPath(a.bindingId), stale)
    expect(first.body.outcome).toBe('refused')
    // Same key, now with a valid epoch: it must be evaluated, not replayed.
    const retry = await post(base, turnsPath(a.bindingId), claim('ct-stale-0001'))
    expect(retry.body.outcome).toBe('completed')
    expect(retry.body.replayed).toBeUndefined()
    expect(calls).toHaveLength(1)
  })
})

// =============================================================================
// Fork
//
// The action seventeen refusal strings already recommend. Everything below drives
// the real HTTP route; the only fake is the fork module itself, because spawning a
// real provider CLI in a unit test is forbidden here.

describe('fork does not ask whether the thread is busy', () => {
  it('forks a thread that a live desktop process is holding', async () => {
    // THE WHOLE POINT OF THE ROUTE. `probes()` describes a thread owned by a live
    // desktop Claude — the exact condition that makes attach refuse. Fork appends
    // to nothing, so it must proceed. A gate added here would refuse precisely
    // when fork is the only path the user has left.
    const d = forkDeps({ probes: probes() })
    const { status, body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(status).toBe(201)
    expect(body.forked).toBe(true)
  })

  it('refuses to ATTACH to that same thread, so the contrast is real', async () => {
    // Without this the test above could be passing because the fixture is free
    // rather than because fork ignores occupancy.
    const { status, body } = await attach(writeDeps({ probes: probes() }))
    expect(status).not.toBe(201)
    expect(body.reason).toBe('live_desktop_process')
  })

  it('forks without touching a single probe', async () => {
    // `hostileProbes()` throws on contact. A 201 is only reachable if no occupancy
    // work happened at all — stronger than asserting a particular verdict.
    const d = forkDeps({ probes: hostileProbes() })
    const { status } = await post(await start(d), forkPath(), FORK_BODY)
    expect(status).toBe(201)
  })

  it('forks a thread that is already attached to a COS chat', async () => {
    // `native_target_busy` guards a WRITE into the target. A copy is not a write.
    const base = await start(forkDeps())
    await attached(base)
    const { status, body } = await post(base, forkPath(), FORK_BODY)
    expect(status).toBe(201)
    expect(body.forked).toBe(true)
  })

  it('forks a thread whose target has been fenced by an ambiguous turn', async () => {
    // A fence means a COS turn may or may not have landed, and the user is told to
    // go and look. Copying it is safe and is very often the next thing they want,
    // so the fence must not reach this route.
    const base = await start(forkDeps({ deliverAttachedTurn: async () => { throw new Error('lost') } }))
    const a = await attached(base)
    const fenced = await post(base, turnsPath(a.bindingId), {
      prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey, clientTurnId: 'ct-fence-fork-1',
    })
    expect(fenced.body.outcome).toBe('ambiguous')

    const { status, body } = await post(base, forkPath(), FORK_BODY)
    expect(status).toBe(201)
    expect(body.forked).toBe(true)
  })
})

describe('what the fork route puts on the wire', () => {
  it('answers 201 with an opaque reference and a named integrity verdict', async () => {
    const { status, body } = await post(await start(forkDeps()), forkPath(), FORK_BODY)
    expect(status).toBe(201)
    expect(body.forked).toBe(true)
    expect(body.reason).toBeNull()
    expect(typeof body.reasonCopy).toBe('string')
    expect(body.reasonCopy.length).toBeGreaterThan(0)
    expect(body.forkRef).toMatch(/^[0-9a-f]{32}$/)
    expect(body.sourceIntegrity).toBe('verified_unchanged')
    expect(body.orphanPossible).toBe(false)
  })

  it('never puts the forked thread id, the source id, the prompt or a path on the wire', async () => {
    // Same redaction contract as every other route here: a fresh fork's id is
    // exactly as identifying as an existing thread's.
    const { text } = await post(await start(forkDeps()), forkPath(), FORK_BODY)
    expect(text).not.toContain(FORKED_SID)
    expect(text).not.toContain(SID)
    expect(text).not.toContain(PROMPT)
    expect(text).not.toContain('/')
  })

  it('reports unverified integrity as unverified, never as confirmed', async () => {
    // "COS could not read the original at both ends" must not be rendered as
    // "the original is confirmed untouched".
    const d = forkDeps({ forkThread: () => ({ ...FORK_SUCCESS, sourceIntegrity: 'unverified' }) })
    const { status, body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(status).toBe(201)
    expect(body.sourceIntegrity).toBe('unverified')
  })

  it('hands back the same reference for the same forked thread', async () => {
    // Deterministic, so a client can recognise it across requests. It is a digest
    // of values the caller already holds, not a secret.
    const base = await start(forkDeps())
    const first = await post(base, forkPath(), FORK_BODY)
    const second = await post(base, forkPath(), FORK_BODY)
    expect(first.body.forkRef).toBe(second.body.forkRef)
  })

  it('sets no-store, because a fork reference names a thread that did not exist before', async () => {
    const base = await start(forkDeps())
    const res = await fetch(`${base}${forkPath()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FORK_BODY),
    })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('the fork route resolves its own execution fields', () => {
  it('spawns in the workspace the SERVER resolved, ignoring one the client sent', async () => {
    // Plan 4.2: the client may not send a path, an executable, a model or a
    // permission mode. A body carrying `cwd` must change nothing.
    const seen: any[] = []
    const d = forkDeps({
      forkThread: req => { seen.push(req); return FORK_SUCCESS },
      resolveForkWorkspace: () => CWD,
    })
    await post(await start(d), forkPath(), { ...FORK_BODY, cwd: '/tmp/attacker', policy: 'agent' })
    expect(seen[0].cwd).toBe(CWD)
    expect(seen[0].policy).toBe('read_only')
  })

  it('passes the path provider and thread id straight through', async () => {
    const seen: any[] = []
    const d = forkDeps({ forkThread: req => { seen.push(req); return FORK_SUCCESS } })
    await post(await start(d), forkPath('claude', SID), FORK_BODY)
    expect(seen[0].provider).toBe('claude')
    expect(seen[0].nativeThreadId).toBe(SID)
    expect(seen[0].prompt).toBe(PROMPT)
  })

  it('refuses a relative workspace rather than spawning against the server cwd', async () => {
    // A relative path resolves against the SERVER's working directory, so the copy
    // would land in the wrong project while every response looked correct.
    let called = 0
    const d = forkDeps({
      resolveForkWorkspace: () => 'server/lib',
      forkThread: () => { called++; return FORK_SUCCESS },
    })
    const { body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(body.reason).toBe('fork_workspace_unresolvable')
    expect(called).toBe(0)
  })

  it('refuses when the workspace resolver throws', async () => {
    const d = forkDeps({ resolveForkWorkspace: () => { throw new Error('EACCES') } })
    const { body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(body.reason).toBe('fork_workspace_unresolvable')
  })

  const badBodies: [string, unknown][] = [
    ['no body at all', undefined],
    ['a missing prompt', { cosSessionId: 'cos-1' }],
    ['a blank prompt', { cosSessionId: 'cos-1', prompt: '   ' }],
    ['a non-string prompt', { cosSessionId: 'cos-1', prompt: 42 }],
    ['a missing cosSessionId', { prompt: 'hello' }],
    ['a malformed cosSessionId', { cosSessionId: 'has spaces', prompt: 'hello' }],
  ]
  for (const [label, body] of badBodies) {
    it(`refuses ${label} without calling the fork module`, async () => {
      let called = 0
      const d = forkDeps({ forkThread: () => { called++; return FORK_SUCCESS } })
      const res = await post(await start(d), forkPath(), body)
      expect(res.body.reason).toBe('invalid_request')
      expect(called).toBe(0)
    })
  }
})

describe('the fork route believes nothing the module did not say', () => {
  it('refuses a success whose new id is the SOURCE id', async () => {
    // The router does not import `fork-thread.ts`, so a structurally-matching
    // object would otherwise be taken at its word — and the value at stake is
    // whether COS hands the user their own LIVE thread back, labelled as a copy.
    const d = forkDeps({ forkThread: () => ({ ...FORK_SUCCESS, newNativeThreadId: SID }) })
    const { body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(body.forked).toBe(false)
    expect(body.reason).toBe('fork_source_mutated')
  })

  it('refuses a success whose new id is not a valid thread id', async () => {
    const d = forkDeps({ forkThread: () => ({ ...FORK_SUCCESS, newNativeThreadId: 'd92ad220' }) })
    const { body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(body.forked).toBe(false)
    expect(body.orphanPossible).toBe(true)
  })

  it('refuses a success carrying an integrity verdict this build does not know', async () => {
    const d = forkDeps({ forkThread: () => ({ ...FORK_SUCCESS, sourceIntegrity: 'probably_fine' }) })
    const { body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(body.forked).toBe(false)
    expect(body.orphanPossible).toBe(true)
  })

  it('treats an unrecognised result as possibly-orphaned, not as a clean failure', async () => {
    // "I do not recognise this" is not "nothing happened". Only an explicit
    // forkState of `none` earns the clean failure.
    for (const result of [null, undefined, [], 'done', { status: 'ok' }, { ok: false }]) {
      const d = forkDeps({ forkThread: () => result })
      const { body } = await post(await start(d), forkPath(), FORK_BODY)
      expect(body.forked).toBe(false)
      expect(body.orphanPossible).toBe(true)
    }
  })

  it('reports a clean failure as retryable with no orphan', async () => {
    const { body } = await post(await start(forkDeps({ forkThread: () => FORK_CLEAN_FAILURE })), forkPath(), FORK_BODY)
    expect(body.reason).toBe('fork_failed')
    expect(body.orphanPossible).toBe(false)
    expect(body.retryable).toBe(true)
  })

  it('does not offer a retry after the original was mutated', async () => {
    // The user needs to look at their own thread before anything else touches it.
    const { body } = await post(await start(forkDeps({ forkThread: () => FORK_MUTATED })), forkPath(), FORK_BODY)
    expect(body.reason).toBe('fork_source_mutated')
    expect(body.retryable).toBe(false)
  })

  it('reports a possible orphan when the module throws', async () => {
    const d = forkDeps({ forkThread: () => { throw new Error('spawn exploded') } })
    const { body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(body.reason).toBe('fork_orphan_possible')
    expect(body.orphanPossible).toBe(true)
  })

  it('reports a possible orphan when the module rejects', async () => {
    const d = forkDeps({ forkThread: async () => { throw new Error('async explosion') } })
    const { body } = await post(await start(d), forkPath(), FORK_BODY)
    expect(body.orphanPossible).toBe(true)
  })

  it('releases the per-source claim so a later fork is not blocked forever', async () => {
    // A claim leaked on the failure path locks the source out of forking for the
    // life of the process, which is the one way this route could become worse than
    // not existing.
    const base = await start(forkDeps({ forkThread: () => FORK_CLEAN_FAILURE }))
    await post(base, forkPath(), FORK_BODY)
    const second = await post(base, forkPath(), FORK_BODY)
    expect(second.body.reason).toBe('fork_failed')
    expect(second.body.reason).not.toBe('fork_in_progress')
  })

  it('releases the claim after the module throws', async () => {
    const base = await start(forkDeps({ forkThread: () => { throw new Error('boom') } }))
    await post(base, forkPath(), FORK_BODY)
    const second = await post(base, forkPath(), FORK_BODY)
    expect(second.body.reason).not.toBe('fork_in_progress')
  })

  it('lets a different thread fork while one is in flight', async () => {
    // The claim is per SOURCE, not global. A single serialising lock would make
    // fork useless the moment two chats used it at once.
    const held = heldFork()
    const base = await start(forkDeps({ forkThread: held.fork }))
    const inFlight = post(base, forkPath('claude', SID), FORK_BODY)
    while (held.calls === 0) await new Promise(r => setTimeout(r, 2))
    const other = await post(base, forkPath('claude', OTHER_SID), FORK_BODY)
    held.open()
    await inFlight
    expect(other.status).toBe(201)
  })

  it('does not let a fork claim block a continuation on the same thread', async () => {
    // Distinct key namespaces. A fork and a turn on one thread are independent.
    const held = heldFork()
    const base = await start(forkDeps({ forkThread: held.fork }))
    const a = await attached(base)
    const inFlight = post(base, forkPath('claude', SID), FORK_BODY)
    while (held.calls === 0) await new Promise(r => setTimeout(r, 2))
    const turn = await post(base, turnsPath(a.bindingId), {
      prompt: PROMPT, epoch: a.epoch, targetKey: a.targetKey, clientTurnId: 'ct-fork-parallel-1',
    })
    held.open()
    await inFlight
    expect(turn.body.outcome).toBe('completed')
  })
})
