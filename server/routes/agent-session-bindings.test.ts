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
  createAgentSessionBindingsRouter,
  type AgentSessionBindingsDeps,
} from './agent-session-bindings.js'
import type { Occupancy, OccupancyProbes, OccupancyReason, ThreadOwner } from '../lib/thread-occupancy.js'
import { targetKey, type NativeBinding } from '../lib/agent-session-binding-store.js'

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
    ...over,
  }
}

/** A wired registry. `available` is required, so every fixture must answer it. */
function reg(list: () => readonly NativeBinding[], available: () => boolean = () => true) {
  return { list, available }
}

const closers: Array<() => Promise<void>> = []

async function start(d: AgentSessionBindingsDeps): Promise<string> {
  const app = express()
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

describe('every doubt the detector can raise reaches the wire as a refusal', () => {
  const cases: Array<{ reason: OccupancyReason; d: () => AgentSessionBindingsDeps; provider?: string; id?: string }> = [
    { reason: 'live_desktop_process', d: () => deps() },
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
    const { status, body } = await attachability({} as AgentSessionBindingsDeps)
    expect(status).toBe(200)
    expect(body).toMatchObject({ attachable: false, reason: 'detector_unavailable' })
  })

  it('answers detector_unavailable when the dirs were never wired', async () => {
    const { body } = await attachability(
      { probes: probes(), now: () => NOW, bindings: { list: () => [] } } as unknown as AgentSessionBindingsDeps,
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
