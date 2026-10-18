// 6.78.0 (P3): the attempt journal, pin metadata, and the release of pins a dead boot left.
//
// A "restart" here is what it is in production: the instance is abandoned without any
// shutdown code, and a NEW instance opens the same file. Pins loaded at hydration belong
// to a boot that is gone, whatever metadata they carry.
//
// The store sits inside a real `.cos-glasses/data` dot directory, like the registry suite,
// because the production data home is one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSessionBindingRegistry,
  ATTEMPT_RETENTION_MS,
  DEFAULT_TERMINAL_RETENTION_MS,
  MAX_ATTEMPTS_PER_TARGET,
  type BindingRegistryOptions,
  PIN_ORPHAN_FENCE_MS,
  makePinChildProbe,
} from './agent-session-binding-registry.js'
import { targetKey } from './agent-session-binding-store.js'
import { MAX_ATTACHED_TIMEOUT_MS } from './attached-provider-adapter.js'

const THREAD = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const KEY = targetKey('claude', THREAD)
const T0 = 1_786_845_785_997
const TTL = 15 * 60 * 1000

let root = ''
let storePath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-binding-registry-p3-'))
  const dataHome = join(root, '.cos-glasses', 'data')
  mkdirSync(dataHome, { recursive: true, mode: 0o700 })
  storePath = join(dataHome, 'agent-session-bindings.json')
})
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function open(options: Partial<BindingRegistryOptions> = {}): AgentSessionBindingRegistry {
  return AgentSessionBindingRegistry.open({ filePath: storePath, onWarn: () => {}, now: T0, bootId: 'boot-1', pinBootReap: () => true, ...options })
}

function attached(r: AgentSessionBindingRegistry, bindingId = 'bind-1', now = T0): void {
  const created = r.create({ bindingId, cosSessionId: 'cos-1', provider: 'claude', nativeThreadId: THREAD, workspaceFingerprint: 'w', sourceFingerprint: 's', ttlMs: TTL, now })
  expect(created.reason).toBeNull()
  expect(r.activate(bindingId, now).reason).toBeNull()
}

const disk = () => JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, any>

describe('the attempt journal: written with the pin, settled with the unpin', () => {
  it('pin carries the pin metadata and opens the attempt IN THE SAME COMMIT', () => {
    const r = open()
    attached(r)
    expect(r.pin('bind-1', 'job-1', T0, { pinMeta: { clientTurnId: 'ct-journal-1' }, attempt: { clientTurnId: 'ct-journal-1', mode: 'turn' } }).reason).toBeNull()
    const raw = disk()
    expect(raw.records[0].pinMeta).toEqual({ 'job-1': { clientTurnId: 'ct-journal-1', bootId: 'boot-1' } })
    expect(raw.records[0].binding.pinnedJobs).toEqual(['job-1'])
    expect(raw.attempts[KEY]['ct-journal-1']).toEqual({ bootId: 'boot-1', at: T0, mode: 'turn', exit: 'pending' })
  })

  it('unpin records the exit and drops the pin metadata with the pin', () => {
    const r = open()
    attached(r)
    r.pin('bind-1', 'job-1', T0, { pinMeta: { clientTurnId: 'ct-journal-2' }, attempt: { clientTurnId: 'ct-journal-2', mode: 'turn' } })
    expect(r.unpin('bind-1', 'job-1', T0 + 1, { attemptExit: { clientTurnId: 'ct-journal-2', exit: 'sent' } }).reason).toBeNull()
    const raw = disk()
    expect(raw.records[0].pinMeta).toBeUndefined()
    expect(raw.attempts[KEY]['ct-journal-2'].exit).toBe('sent')
    expect(open().attemptFor('claude', THREAD, 'ct-journal-2')).toEqual({ attempt: { bootId: 'boot-1', at: T0, mode: 'turn', exit: 'sent' }, evictedThrough: null })
  })

  it('a turn whose pin was already dropped still records its exit: an attempt-only commit is a commit', () => {
    // The leaked-pin reap can take a pin while its turn is still running. When that turn
    // ends, its unpin changes no pin, but the exit must land: a `pending` left behind reads
    // as "in flight" for the rest of this boot and as unknown after the next restart.
    const r = open({ stalePinMs: 1_000 })
    attached(r)
    r.pin('bind-1', 'job-1', T0, { attempt: { clientTurnId: 'ct-journal-9', mode: 'turn' } })
    expect(r.reap(T0 + 2_000).pinsDropped).toBe(1)
    expect(r.get('bind-1')?.pinnedJobs).toEqual([])
    expect(r.unpin('bind-1', 'job-1', T0 + 3_000, { attemptExit: { clientTurnId: 'ct-journal-9', exit: 'sent' } }).reason).toBeNull()
    expect(disk().attempts[KEY]['ct-journal-9'].exit).toBe('sent')
    expect(open().attemptFor('claude', THREAD, 'ct-journal-9')?.attempt?.exit).toBe('sent')
  })

  it('with no extras, a pin writes the 6.77 shape: no pinMeta, no attempts key', () => {
    const r = open()
    attached(r)
    r.pin('bind-1', 'job-1', T0)
    r.unpin('bind-1', 'job-1', T0 + 1)
    const raw = disk()
    expect(Object.keys(raw)).toEqual(['version', 'epochHighWater', 'turns', 'records'])
    expect(Object.keys(raw.records[0])).toEqual(['binding', 'createdAt', 'updatedAt', 'terminalAt', 'lastUnpinAt', 'pinnedAt'])
  })

  it('survives the binding being reaped: the journal is target-scoped, the ledger is not', () => {
    const r = open()
    attached(r)
    r.pin('bind-1', 'job-1', T0, { attempt: { clientTurnId: 'ct-journal-3', mode: 'turn' } })
    r.recordTurn('bind-1', 'ct-journal-3', { outcome: 'completed' }, T0 + 1)
    r.unpin('bind-1', 'job-1', T0 + 2, { attemptExit: { clientTurnId: 'ct-journal-3', exit: 'sent' } })
    const later = T0 + TTL + DEFAULT_TERMINAL_RETENTION_MS + 60_000
    expect(r.reap(later).removed).toEqual(['bind-1'])
    expect(r.findTurnForTarget('claude', THREAD, 'ct-journal-3')).toBeNull()
    expect(open().attemptFor('claude', THREAD, 'ct-journal-3')?.attempt?.exit).toBe('sent')
  })

  it('beginAttempt and settleAttempt are durable; settling a key that never began invents nothing', () => {
    const r = open()
    expect(r.beginAttempt('claude', THREAD, 'ct-steer-1', 'steer', T0)).toBe(true)
    expect(disk().attempts[KEY]['ct-steer-1']).toEqual({ bootId: 'boot-1', at: T0, mode: 'steer', exit: 'pending' })
    expect(r.settleAttempt('claude', THREAD, 'ct-steer-1', 'unknown', T0 + 5)).toBe(true)
    expect(open().attemptFor('claude', THREAD, 'ct-steer-1')?.attempt?.exit).toBe('unknown')
    expect(r.settleAttempt('claude', THREAD, 'ct-never-began', 'not_sent', T0)).toBe(true)
    expect(open().attemptFor('claude', THREAD, 'ct-never-began')).toEqual({ attempt: null, evictedThrough: null })
    expect(r.beginAttempt('claude', 'not a thread', 'ct-steer-2', 'steer', T0)).toBe(false)
  })

  it('findTurnForTarget reads only the bindings of that thread', () => {
    const OTHER = 'b5c3c5ee-f51d-4c19-9b22-d9ab129d208e'
    const r = open()
    attached(r)
    r.recordTurn('bind-1', 'ct-scoped-01', { outcome: 'completed', status: 200 }, T0 + 1)
    expect(r.findTurnForTarget('claude', THREAD, 'ct-scoped-01')?.result).toMatchObject({ outcome: 'completed' })
    expect(r.findTurnForTarget('claude', OTHER, 'ct-scoped-01')).toBeNull()
    expect(r.findTurnForTarget('codex', THREAD, 'ct-scoped-01')).toBeNull()
  })

  it('a degraded store answers null (unknown), never "no attempt"', () => {
    writeFileSync(storePath, '{ not json')
    const r = open()
    expect(r.attemptFor('claude', THREAD, 'ct-anything')).toBeNull()
    expect(r.beginAttempt('claude', THREAD, 'ct-anything', 'steer', T0)).toBe(false)
  })

  it('an evicted key reads as unknown: shedding by age or count raises evictedThrough', () => {
    const r = open()
    r.beginAttempt('claude', THREAD, 'ct-old-0001', 'steer', T0)
    // A write ATTEMPT_RETENTION_MS later sheds the old row and records that it did.
    r.beginAttempt('claude', THREAD, 'ct-new-0001', 'steer', T0 + ATTEMPT_RETENTION_MS + 1)
    const lookup = open().attemptFor('claude', THREAD, 'ct-old-0001')
    expect(lookup).toEqual({ attempt: null, evictedThrough: T0 })
    // Count: one target past MAX_ATTEMPTS_PER_TARGET sheds its oldest. The full journal is
    // seeded on disk rather than written one durable commit at a time (257 fsyncs ran past
    // the 5 s test budget on a loaded Mac); the write that crosses the cap is the real one.
    const raw = disk()
    for (let i = 0; i < MAX_ATTEMPTS_PER_TARGET; i++) {
      raw.attempts[KEY][`ct-count-${String(i).padStart(4, '0')}`] = { bootId: 'boot-1', at: T0 + ATTEMPT_RETENTION_MS + 10 + i, mode: 'turn', exit: 'sent' }
    }
    writeFileSync(storePath, JSON.stringify(raw))
    const c = open()
    expect(c.attemptFor('claude', THREAD, 'ct-count-0000')?.attempt?.exit).toBe('sent')
    expect(c.beginAttempt('claude', THREAD, `ct-count-${String(MAX_ATTEMPTS_PER_TARGET).padStart(4, '0')}`, 'turn', T0 + ATTEMPT_RETENTION_MS + 10 + MAX_ATTEMPTS_PER_TARGET)).toBe(true)
    expect(open().attemptFor('claude', THREAD, 'ct-count-0000')?.attempt).toBeNull()
    expect(open().attemptFor('claude', THREAD, 'ct-count-0000')?.evictedThrough).toBeGreaterThanOrEqual(T0 + ATTEMPT_RETENTION_MS + 10)
  })

  it('a malformed persisted attempt is dropped and the journal admits it may have forgotten one', () => {
    const r = open()
    attached(r)
    const raw = disk()
    raw.attempts = { [KEY]: { 'ct-bad-0001': { bootId: 'b', at: 'yesterday', mode: 'turn', exit: 'pending' }, 'ct-good-001': { bootId: 'b', at: T0, mode: 'turn', exit: 'sent' } } }
    writeFileSync(storePath, JSON.stringify(raw))
    const reopened = open({ now: T0 + 7 })
    expect(reopened.attemptFor('claude', THREAD, 'ct-bad-0001')).toEqual({ attempt: null, evictedThrough: T0 + 7 })
    expect(reopened.attemptFor('claude', THREAD, 'ct-good-001')?.attempt?.exit).toBe('sent')
  })
})

describe('pins a dead boot left: released at the orphan window, never before', () => {
  function crashedWithPin(meta: boolean): void {
    const life1 = open({ bootId: 'boot-dead' })
    attached(life1)
    expect(life1.pin('bind-1', 'job-1', T0, meta ? { pinMeta: { clientTurnId: 'ct-orphan-1' }, attempt: { clientTurnId: 'ct-orphan-1', mode: 'turn' } } : {}).reason).toBeNull()
    // The process dies here: no unpin, no shutdown code.
  }

  it('holds the thread until now - pinnedAt >= PIN_ORPHAN_FENCE_MS (31 min), then frees it', () => {
    // P7 S6: the longest turn the attached adapter accepts, plus one minute.
    expect(PIN_ORPHAN_FENCE_MS).toBe(31 * 60_000)
    expect(PIN_ORPHAN_FENCE_MS).toBe(MAX_ATTACHED_TIMEOUT_MS + 60_000)
    crashedWithPin(true)
    // The restart is at the pin's own instant, so the pin is the later of the two clocks.
    const life2 = open({ bootId: 'boot-2', now: T0 })
    expect(life2.attachBlocked('claude', THREAD, T0 + PIN_ORPHAN_FENCE_MS - 1)).toBe(true)
    expect(life2.orphanPinHold('claude', THREAD, T0 + PIN_ORPHAN_FENCE_MS - 1)).toEqual({ releasesAt: T0 + PIN_ORPHAN_FENCE_MS })
    expect(life2.get('bind-1')?.pinnedJobs).toEqual(['job-1'])
    // Due but not yet released (the hold is a read; it releases nothing): no time in the past.
    expect(life2.orphanPinHold('claude', THREAD, T0 + PIN_ORPHAN_FENCE_MS)).toBeNull()
    expect(life2.get('bind-1')?.pinnedJobs).toEqual(['job-1'])
    expect(life2.attachBlocked('claude', THREAD, T0 + PIN_ORPHAN_FENCE_MS)).toBe(false)
    expect(life2.get('bind-1')?.pinnedJobs).toEqual([])
    expect(life2.orphanPinHold('claude', THREAD, T0 + PIN_ORPHAN_FENCE_MS)).toBeNull()
  })

  it('and 31 minutes after the restart: an old pin does not free the thread a minute after the crash', () => {
    crashedWithPin(true)
    // Pinned at T0, the boot died 30 minutes later, and this boot opened the store then.
    // now - pinnedAt reaches 31 minutes a minute after the restart; the orphan child may still be writing.
    const restart = T0 + 30 * 60_000
    const life2 = open({ bootId: 'boot-2', now: restart })
    expect(life2.reapOrphanedPins(restart + 60_000)).toEqual({ released: 0, recorded: 0 })
    expect(life2.attachBlocked('claude', THREAD, restart + PIN_ORPHAN_FENCE_MS - 1)).toBe(true)
    expect(life2.orphanPinHold('claude', THREAD, restart + 60_000)).toEqual({ releasesAt: restart + PIN_ORPHAN_FENCE_MS })
    expect(life2.get('bind-1')?.pinnedJobs).toEqual(['job-1'])
    expect(life2.attachBlocked('claude', THREAD, restart + PIN_ORPHAN_FENCE_MS)).toBe(false)
    expect(life2.get('bind-1')?.pinnedJobs).toEqual([])
  })

  it('a released pin that named its turn leaves an ambiguous ledger record, and its pending attempt reads unknown', () => {
    crashedWithPin(true)
    const life2 = open({ bootId: 'boot-2' })
    expect(life2.reapOrphanedPins(T0 + PIN_ORPHAN_FENCE_MS)).toEqual({ released: 1, recorded: 1 })
    const record = life2.findTurnForTarget('claude', THREAD, 'ct-orphan-1')
    expect(record?.result).toMatchObject({ outcome: 'ambiguous', deliveryState: 'unknown', retryable: false, reason: 'delivery_unknown_after_restart', status: 409 })
    expect(life2.findTurn('bind-1', 'ct-orphan-1')).not.toBeNull()
    expect(life2.attemptFor('claude', THREAD, 'ct-orphan-1')?.attempt?.exit).toBe('unknown')
  })

  it('a pre-6.78 pin (no metadata) is released with no record: the documented upgrade-window gap', () => {
    crashedWithPin(false)
    const life2 = open({ bootId: 'boot-2' })
    expect(life2.reapOrphanedPins(T0 + PIN_ORPHAN_FENCE_MS)).toEqual({ released: 1, recorded: 0 })
    expect(life2.get('bind-1')?.pinnedJobs).toEqual([])
  })

  it('a turn that finished before the crash keeps its own record; no ambiguous one is added', () => {
    const life1 = open({ bootId: 'boot-dead' })
    attached(life1)
    life1.pin('bind-1', 'job-1', T0, { pinMeta: { clientTurnId: 'ct-done-001' } })
    life1.recordTurn('bind-1', 'ct-done-001', { outcome: 'completed', status: 200 }, T0 + 1)
    const life2 = open({ bootId: 'boot-2' })
    expect(life2.reapOrphanedPins(T0 + PIN_ORPHAN_FENCE_MS)).toEqual({ released: 1, recorded: 0 })
    expect(life2.findTurnForTarget('claude', THREAD, 'ct-done-001')?.result).toMatchObject({ outcome: 'completed' })
  })

  it("never releases this boot's own pin, however old", () => {
    const r = open()
    attached(r)
    r.pin('bind-1', 'job-live', T0, { pinMeta: { clientTurnId: 'ct-live-001' } })
    expect(r.reapOrphanedPins(T0 + 10 * PIN_ORPHAN_FENCE_MS)).toEqual({ released: 0, recorded: 0 })
    expect(r.attachBlocked('claude', THREAD, T0 + 10 * PIN_ORPHAN_FENCE_MS)).toBe(true)
    expect(r.orphanPinHold('claude', THREAD, T0 + 60_000)).toBeNull()
  })

  it('an attach releases a due orphan pin lazily and goes through', () => {
    crashedWithPin(true)
    const life2 = open({ bootId: 'boot-2' })
    expect(life2.create({ bindingId: 'bind-2', cosSessionId: 'cos-1', provider: 'claude', nativeThreadId: THREAD, workspaceFingerprint: 'w', sourceFingerprint: 's', ttlMs: TTL, now: T0 + 60_000 }).reason).toBe('target_busy')
    const later = T0 + PIN_ORPHAN_FENCE_MS + 1
    expect(life2.create({ bindingId: 'bind-3', cosSessionId: 'cos-1', provider: 'claude', nativeThreadId: THREAD, workspaceFingerprint: 'w', sourceFingerprint: 's', ttlMs: TTL, now: later }).reason).toBeNull()
  })

  it('a release is not activity: a lease still live when its dead pin frees yields to the next attach at once', () => {
    // The binding outlives the orphan window (a long lease), so only its idle clock decides.
    // `updatedAt` is that clock (IDLE_LEASE_YIELD_MS): restarting it at the release would hold
    // the thread another 90 s for a client that died with the boot.
    const life1 = open({ bootId: 'boot-dead' })
    expect(life1.create({ bindingId: 'bind-1', cosSessionId: 'cos-1', provider: 'claude', nativeThreadId: THREAD, workspaceFingerprint: 'w', sourceFingerprint: 's', ttlMs: 60 * 60_000, now: T0 }).reason).toBeNull()
    expect(life1.activate('bind-1', T0).reason).toBeNull()
    life1.pin('bind-1', 'job-1', T0, { pinMeta: { clientTurnId: 'ct-long-lease' } })
    const life2 = open({ bootId: 'boot-2', now: T0 })
    const at = T0 + PIN_ORPHAN_FENCE_MS
    expect(life2.create({ bindingId: 'bind-2', cosSessionId: 'cos-1', provider: 'claude', nativeThreadId: THREAD, workspaceFingerprint: 'w', sourceFingerprint: 's', ttlMs: TTL, now: at }).reason).toBeNull()
    expect(life2.get('bind-1')?.pinnedJobs).toEqual([])
  })

  it('COS_PIN_BOOT_REAP off: nothing is released before the 24 h reap, and no hold is reported', () => {
    crashedWithPin(true)
    const life2 = open({ bootId: 'boot-2', pinBootReap: () => false })
    expect(life2.reapOrphanedPins(T0 + 2 * PIN_ORPHAN_FENCE_MS)).toEqual({ released: 0, recorded: 0 })
    expect(life2.attachBlocked('claude', THREAD, T0 + 2 * PIN_ORPHAN_FENCE_MS)).toBe(true)
    expect(life2.orphanPinHold('claude', THREAD, T0 + 60_000)).toBeNull()
  })
})

describe('P7 S6: a dead boot\'s pin that names its resume child waits for that child', () => {
  const CHILD = { pid: 48_123, startMs: T0 - 5_000 }
  function crashedWithChild(): void {
    const life1 = open({ bootId: 'boot-dead' })
    attached(life1)
    expect(life1.pin('bind-1', 'job-1', T0, { pinMeta: { clientTurnId: 'ct-child-001' }, attempt: { clientTurnId: 'ct-child-001', mode: 'turn' } }).reason).toBeNull()
    expect(life1.notePinChild('bind-1', 'job-1', CHILD).reason).toBeNull()
  }

  it('notePinChild persists the pid and measured start with the pin, and touches nothing else', () => {
    const r = open()
    attached(r)
    r.pin('bind-1', 'job-1', T0, { pinMeta: { clientTurnId: 'ct-child-002' } })
    const before = disk().records[0]
    expect(r.notePinChild('bind-1', 'job-1', CHILD).reason).toBeNull()
    const after = disk().records[0]
    expect(after.pinMeta).toEqual({ 'job-1': { clientTurnId: 'ct-child-002', bootId: 'boot-1', child: CHILD } })
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.pinnedAt).toEqual(before.pinnedAt)
    // Read back on the next boot.
    expect(open().get('bind-1')?.pinnedJobs).toEqual(['job-1'])
  })

  it('records nothing for a pin without metadata, an unknown job, an inherited pin, or a malformed child', () => {
    const r = open()
    attached(r)
    r.pin('bind-1', 'job-plain', T0)
    expect(r.notePinChild('bind-1', 'job-plain', CHILD).reason).toBeNull()
    expect(r.notePinChild('bind-1', 'job-missing', CHILD).reason).toBeNull()
    r.pin('bind-1', 'job-meta', T0, { pinMeta: { clientTurnId: 'ct-child-003' } })
    for (const bad of [{ pid: 0, startMs: T0 }, { pid: 1, startMs: T0 }, { pid: 1.5, startMs: T0 }, { pid: 77, startMs: Number.NaN }, { pid: 77, startMs: 0 }]) {
      expect(r.notePinChild('bind-1', 'job-meta', bad).reason).toBeNull()
    }
    expect(disk().records[0].pinMeta).toEqual({ 'job-meta': { clientTurnId: 'ct-child-003', bootId: 'boot-1' } })
    // A pin a dead boot left is never rewritten by this boot.
    const life2 = open({ bootId: 'boot-2' })
    expect(life2.notePinChild('bind-1', 'job-meta', CHILD).reason).toBeNull()
    expect(disk().records[0].pinMeta['job-meta'].child).toBeUndefined()
  })

  it('past the window, a running child keeps the pin (no time promised); once gone it releases with its record', () => {
    crashedWithChild()
    let state: 'running' | 'gone' = 'running'
    const probed: unknown[] = []
    const life2 = open({ bootId: 'boot-2', pinChildProbe: child => { probed.push(child); return state } })
    // Inside the window the child is not even asked about.
    expect(life2.orphanPinHold('claude', THREAD, T0 + 60_000)).toEqual({ releasesAt: T0 + PIN_ORPHAN_FENCE_MS })
    expect(probed).toEqual([])
    const past = T0 + PIN_ORPHAN_FENCE_MS + 10 * 60_000
    expect(life2.reapOrphanedPins(past)).toEqual({ released: 0, recorded: 0 })
    expect(life2.attachBlocked('claude', THREAD, past)).toBe(true)
    const hold = life2.orphanPinHold('claude', THREAD, past)
    expect(hold?.childRunning).toBe(true)
    expect(Number.isNaN(hold?.releasesAt)).toBe(true)
    expect(probed[0]).toEqual(CHILD)
    state = 'gone'
    expect(life2.orphanPinHold('claude', THREAD, past)).toBeNull()
    expect(life2.reapOrphanedPins(past)).toEqual({ released: 1, recorded: 1 })
    expect(life2.attemptFor('claude', THREAD, 'ct-child-001')?.attempt?.exit).toBe('unknown')
  })

  it('a gone child does not release early: the window still holds first', () => {
    crashedWithChild()
    const life2 = open({ bootId: 'boot-2', pinChildProbe: () => 'gone' })
    expect(life2.reapOrphanedPins(T0 + PIN_ORPHAN_FENCE_MS - 1)).toEqual({ released: 0, recorded: 0 })
    expect(life2.reapOrphanedPins(T0 + PIN_ORPHAN_FENCE_MS)).toEqual({ released: 1, recorded: 1 })
  })

  it('a probe that throws keeps the pin (fails closed)', () => {
    crashedWithChild()
    const life2 = open({ bootId: 'boot-2', pinChildProbe: () => { throw new Error('ps') } })
    expect(life2.reapOrphanedPins(T0 + 2 * PIN_ORPHAN_FENCE_MS)).toEqual({ released: 0, recorded: 0 })
  })

  it('the default probe: ESRCH is gone, a live pid with its own start is running, a reused pid is gone, an unmeasurable start keeps the hold', () => {
    const exited = spawnSync(process.execPath, ['-e', ''])
    expect(exited.pid).toBeGreaterThan(1)
    expect(makePinChildProbe()({ pid: exited.pid!, startMs: T0 })).toBe('gone')
    const self = { pid: process.pid, startMs: 1_000_000 }
    expect(makePinChildProbe()(self)).toBe('running')
    // EPERM (launchd, pid 1, not ours to signal) is a live process: fail closed.
    if (process.getuid?.() !== 0) expect(makePinChildProbe()({ pid: 1, startMs: 1 })).toBe('running')
    expect(makePinChildProbe(() => self.startMs + 1_000)(self)).toBe('running')
    expect(makePinChildProbe(() => self.startMs + 1_501)(self)).toBe('gone')
    expect(makePinChildProbe(() => self.startMs - 60_000)(self)).toBe('gone')
    expect(makePinChildProbe(() => null)(self)).toBe('running')
    expect(makePinChildProbe(() => { throw new Error('ps') })(self)).toBe('running')
  })
})
