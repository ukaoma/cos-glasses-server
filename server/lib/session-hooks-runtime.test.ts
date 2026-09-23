// The composition root's own rules: the two-scan memory lives here (not in the pure
// deriver), a COS child's pid is remembered past its exit, and off means off.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { recordCosSpawn, releaseCosSpawn } from './agent-session-ownership-store.js'
import { COS_PID_TOMBSTONE_MS, __resetSessionHooksForTests, claudeDeskRunning, deriveForRow, deskTurnEndedAt, haltHandedOffTurn, isCosSpawnedPid, registryEntrypointSync, registryIdleAfterStop, registryRecordSync, sessionHooksEnabled, sessionSignalStore, startSessionHooksRuntime } from './session-hooks-runtime.js'
import { HALT_MARKER_TTL_MS, __resetHaltRearmsForTests, clearHaltMarker, hasHaltMarker, hasPendingHaltRearm, writeHaltMarker } from './session-halt.js'
import { __resetThreadCancelsForTests, noteThreadCancelled } from './session-cancel.js'
import { OPEN_TURN_CEILING_MS } from './session-state-derive.js'
import type { HookEnvelope } from './session-hook-events.js'
import { dataPath } from './data-dir.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEAD_GRACE_MS, MISS_LIMIT } from './session-state-derive.js'

const saved: Record<string, string | undefined> = {}
const KEYS = ['COS_CLAUDE_SESSIONS_ENABLED', 'COS_SESSION_HOOKS', 'COS_GLASSES_HOME', 'COS_SESSION_HOOKS_SPOOL_DIR', 'COS_CLAUDE_SESSIONS_DIR'] as const

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
  delete process.env.COS_SESSION_HOOKS
  __resetSessionHooksForTests()
})
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  __resetSessionHooksForTests()
})

describe('sessionHooksEnabled', () => {
  it('follows COS_CLAUDE_SESSIONS_ENABLED unless COS_SESSION_HOOKS says otherwise', () => {
    expect(sessionHooksEnabled()).toBe(true)
    process.env.COS_SESSION_HOOKS = '0'
    expect(sessionHooksEnabled()).toBe(false)
    process.env.COS_SESSION_HOOKS = 'on'
    expect(sessionHooksEnabled()).toBe(true)
    delete process.env.COS_SESSION_HOOKS
    delete process.env.COS_CLAUDE_SESSIONS_ENABLED
    expect(sessionHooksEnabled()).toBe(false)
  })
})

describe('deriveForRow', () => {
  const id = 'a1b2c3d4-0000-4000-8000-000000000001'
  const dead = { alive: false, status: 'idle', waitingFor: null, statusUpdatedAt: 10, lastActiveAt: 10 }
  const transcript = { inFlight: false, lastActivityAt: 5 }

  it('carries the dead-scan memory between requests: MISS_LIMIT scans AND DEAD_GRACE_MS apart', () => {
    const t0 = 1_000_000
    const first = deriveForRow({ sessionId: id, registry: dead, transcript, now: t0 })
    expect(first).toMatchObject({ agent_state: 'idle', state_source: 'transcript', deadScans: 1 })
    // A client refresh is two requests milliseconds apart: still not a death.
    const second = deriveForRow({ sessionId: id, registry: dead, transcript, now: t0 + 5 })
    expect(second).toMatchObject({ agent_state: 'idle', deadScans: MISS_LIMIT })
    const third = deriveForRow({ sessionId: id, registry: dead, transcript, now: t0 + DEAD_GRACE_MS })
    expect(third).toMatchObject({ agent_state: 'ended', state_source: 'registry', deadScans: MISS_LIMIT + 1 })
    // The eight-character registry id and the full id share one memory once the store knows the session.
    const short = deriveForRow({ sessionId: id.slice(0, 8), registry: dead, transcript, now: t0 + DEAD_GRACE_MS + 1 })
    expect(short?.deadScans).toBe(1) // unknown to the store: its own key, its own memory
  })

  it('returns nothing for a row it has no facts for, and nothing at all when the feature is off', () => {
    expect(deriveForRow({ sessionId: id })).toBeUndefined()
    process.env.COS_SESSION_HOOKS = '0'
    expect(deriveForRow({ sessionId: id, registry: dead, transcript, now: 1 })).toBeUndefined()
  })
})

describe('isCosSpawnedPid', () => {
  it('remembers a released child pid for COS_PID_TOMBSTONE_MS, so its synchronous SessionEnd is still a child event', () => {
    const pid = 90_000 + Math.floor(Math.random() * 9_000) // almost surely no such process: the ps fallback finds no parent
    const t0 = Date.now()
    expect(isCosSpawnedPid(pid, t0)).toBe(false)
    expect(recordCosSpawn(pid, t0)).toBe('recorded')
    try {
      expect(isCosSpawnedPid(pid, t0)).toBe(true)
    } finally {
      releaseCosSpawn(pid)
    }
    expect(isCosSpawnedPid(pid, t0 + COS_PID_TOMBSTONE_MS)).toBe(true)
    expect(isCosSpawnedPid(pid, t0 + COS_PID_TOMBSTONE_MS + 1)).toBe(false)
    expect(isCosSpawnedPid(null, t0)).toBe(false)
  })
})

describe('registryIdleAfterStop (the engine\'s end of turn, 6.48.1)', () => {
  const SID = 'a1b2c3d4-0000-4000-8000-000000000001'
  const record = (dir: string, pid: number, over: Record<string, unknown>) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: SID, entrypoint: 'claude-desktop', ...over }))

  it('is true only for a record that says idle AT OR AFTER the Stop; busy, idle-before, and no record are not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
    expect(registryIdleAfterStop(SID, 5_000, dir)).toBeNull()
    record(dir, 100, { status: 'idle', statusUpdatedAt: 4_999 })
    expect(registryIdleAfterStop(SID, 5_000, dir)).toBe(false)     // idle from BEFORE this Stop: the hooks have not returned
    record(dir, 100, { status: 'idle', statusUpdatedAt: 5_000 })
    expect(registryIdleAfterStop(SID, 5_000, dir)).toBe(true)
    record(dir, 100, { status: 'idle', statusUpdatedAt: 5_030 })
    expect(registryIdleAfterStop(SID, 5_000, dir)).toBe(true)
    record(dir, 100, { status: 'busy', statusUpdatedAt: 5_030 })     // a prompt typed after the hooks returned
    expect(registryIdleAfterStop(SID, 5_000, dir)).toBe(false)
    record(dir, 100, { status: 'idle' })                             // no stamp: not vouched
    expect(registryIdleAfterStop(SID, 5_000, dir)).toBe(false)
  })

  it('reads the TAB\'s record when a COS child shares the session id, and the child\'s only when it is alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
    // The child's file sorts FIRST in the directory (a naive first-match would return it).
    const child = 100 + Math.floor(Math.random() * 100)
    const tab = 90_000 + Math.floor(Math.random() * 9_000)
    record(dir, child, { entrypoint: 'sdk-cli', status: 'busy', statusUpdatedAt: 6_000 })
    expect(recordCosSpawn(child, Date.now())).toBe('recorded')
    try {
      expect(registryRecordSync(SID, dir)).toMatchObject({ pid: child, entrypoint: 'sdk-cli' })  // alone: the child answers
      record(dir, tab, { status: 'idle', statusUpdatedAt: 5_000 })
      expect(registryRecordSync(SID, dir)).toMatchObject({ pid: tab, entrypoint: 'claude-desktop' })
      expect(registryIdleAfterStop(SID, 5_000, dir)).toBe(true)     // the child's `busy` does not veto the tab's idle
    } finally {
      releaseCosSpawn(child)
    }
  })
})

describe('registryEntrypointSync', () => {
  it('reads the entrypoint off the record that names the session, ignoring torn files and foreign names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
    writeFileSync(join(dir, '100.json'), JSON.stringify({ pid: 100, sessionId: 'A1B2C3D4-0000-4000-8000-000000000001', entrypoint: 'sdk-cli', kind: 'interactive' }))
    writeFileSync(join(dir, '101.json'), '{ torn')
    writeFileSync(join(dir, 'notes.json'), JSON.stringify({ sessionId: 'a1b2c3d4-0000-4000-8000-000000000002', entrypoint: 'cli' }))
    mkdirSync(join(dir, '102.json'))
    expect(registryEntrypointSync('a1b2c3d4-0000-4000-8000-000000000001', dir)).toBe('sdk-cli')
    expect(registryEntrypointSync('a1b2c3d4-0000-4000-8000-000000000002', dir)).toBeNull()
    expect(registryEntrypointSync('a1b2c3d4-0000-4000-8000-000000000003', dir)).toBeNull()
    expect(registryEntrypointSync('a1b2c3d4-0000-4000-8000-000000000001', join(dir, 'missing'))).toBeNull()
  })
})

describe('the boot replay', () => {
  it('restores the entrypoint the ledger row carries, so a print run that ended inside the window is still a run after a restart (QA W1)', () => {
    // A scratch home for the runtime files, spool and registry; the ledger lives at the
    // (already isolated) data path, where this test seeds it BEFORE the boot.
    const home = mkdtempSync(join(tmpdir(), 'cos-runtime-'))
    process.env.COS_GLASSES_HOME = home
    process.env.COS_SESSION_HOOKS_SPOOL_DIR = join(home, 'spool')
    process.env.COS_CLAUDE_SESSIONS_DIR = join(home, 'sessions')   // empty: the registry has been reaped
    mkdirSync(join(home, 'sessions'), { recursive: true })
    const job = 'a1b2c3d4-0000-4000-8000-00000000f00d'
    const tab = 'b2c3d4e5-0000-4000-8000-00000000cafe'
    const now = Date.now()
    const row = (ts: number, event: string, session_id: string, extra: Record<string, unknown>, entrypoint?: string) =>
      JSON.stringify({ key: `${ts}-1-${event}.json`, ts, ppid: 1, event, session_id, ...(entrypoint ? { entrypoint } : {}), payload: { session_id, ...extra } })
    writeFileSync(dataPath('session-hook-events.jsonl'), [
      row(now - 5_000, 'SessionStart', job, { source: 'startup' }),
      row(now - 4_000, 'UserPromptSubmit', job, { prompt: 'hi' }, 'sdk-cli'),
      row(now - 3_000, 'Stop', job, { last_assistant_message: 'done' }, 'sdk-cli'),
      row(now - 2_000, 'SessionEnd', job, { reason: 'other' }, 'sdk-cli'),
      row(now - 1_500, 'SessionStart', tab, { source: 'startup' }),
      row(now - 1_000, 'UserPromptSubmit', tab, { prompt: 'hello' }, 'claude-desktop'),
    ].join('\n') + '\n')
    const runtime = startSessionHooksRuntime({ port: 3141 })
    try {
      expect(sessionSignalStore.get(job)?.entrypoint).toBe('sdk-cli')
      expect(sessionSignalStore.get(job)?.ended).not.toBeNull()
      expect(sessionSignalStore.get(tab)?.entrypoint).toBe('claude-desktop')
    } finally {
      runtime.stop()
    }
  })
})

describe('claudeDeskRunning (6.53.0, the cancel route\'s desk probe)', () => {
  const SID = 'a1b2c3d4-0000-4000-8000-0000000cafe1'
  const env = (event: HookEnvelope['event'], ts: number, payload: Record<string, unknown> = {}): HookEnvelope =>
    ({ ts, ppid: 1, event, sessionId: SID, payload: { session_id: SID, ...payload } })
  const record = (dir: string, pid: number, status: string) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: SID, entrypoint: 'claude-desktop', status, statusUpdatedAt: 1 }))

  it('the hooks: an open turn inside the ceiling is running; a Stop, a SessionEnd or silence past the ceiling is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
    const t0 = 1_000_000
    expect(claudeDeskRunning(SID, t0, dir)).toBe(false)
    sessionSignalStore.apply(env('UserPromptSubmit', t0, { prompt: 'go' }), false)
    expect(claudeDeskRunning(SID, t0 + 1, dir)).toBe(true)
    expect(claudeDeskRunning(SID, t0 + OPEN_TURN_CEILING_MS, dir)).toBe(true)
    expect(claudeDeskRunning(SID, t0 + OPEN_TURN_CEILING_MS + 1, dir)).toBe(false)
    sessionSignalStore.apply(env('Stop', t0 + 10), false)
    expect(claudeDeskRunning(SID, t0 + 11, dir)).toBe(false)
    sessionSignalStore.apply(env('UserPromptSubmit', t0 + 20, { prompt: 'again' }), false)
    expect(claudeDeskRunning(SID, t0 + 21, dir)).toBe(true)
    sessionSignalStore.apply(env('SessionEnd', t0 + 30, { reason: 'other' }), false)
    expect(claudeDeskRunning(SID, t0 + 31, dir)).toBe(false)
  })

  it('the registry: the session\'s own busy record with a live pid; idle, dead, or a COS child is not', () => {
    process.env.COS_SESSION_HOOKS = '0' // no hook signal at all: the registry alone answers
    // A real live process that is not this one (the spawn ledger refuses its own pid).
    const live = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    const pid = live.pid!
    try {
      const dir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
      record(dir, pid, 'busy')
      expect(claudeDeskRunning(SID, Date.now(), dir)).toBe(true)
      record(dir, pid, 'idle')
      expect(claudeDeskRunning(SID, Date.now(), dir)).toBe(false)
      const deadDir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
      record(deadDir, 2_147_483_000, 'busy') // no such process
      expect(claudeDeskRunning(SID, Date.now(), deadDir)).toBe(false)
      // A COS child's record is the route's own in-flight turn, never a desk run.
      const childDir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
      record(childDir, pid, 'busy')
      expect(recordCosSpawn(pid, Date.now())).toBe('recorded')
      try {
        expect(claudeDeskRunning(SID, Date.now(), childDir)).toBe(false)
      } finally {
        releaseCosSpawn(pid)
      }
    } finally {
      live.kill('SIGKILL')
    }
  })
})

describe('halt markers die with their session (6.53.0)', () => {
  const SID = 'a1b2c3d4-0000-4000-8000-0000000cafe2'
  const env = (event: HookEnvelope['event'], ts: number): HookEnvelope =>
    ({ ts, ppid: 1, event, sessionId: SID, payload: { session_id: SID, reason: 'other' } })

  function boot() {
    const home = mkdtempSync(join(tmpdir(), 'cos-runtime-'))
    process.env.COS_GLASSES_HOME = home
    process.env.COS_SESSION_HOOKS_SPOOL_DIR = join(home, 'spool')
    process.env.COS_CLAUDE_SESSIONS_DIR = join(home, 'sessions')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    return startSessionHooksRuntime({ port: 3141 })
  }

  it('SessionEnd clears the marker; Stop, a child\'s SessionEnd, and a SessionEnd older than the cancel do not', () => {
    const at = Date.now()
    writeHaltMarker(SID, { at, clientCancelId: 'cc-end-1' })
    const runtime = boot()
    try {
      sessionSignalStore.apply(env('Stop', at + 10), false)
      expect(hasHaltMarker(SID)).toBe(true)
      sessionSignalStore.apply(env('SessionEnd', at + 20), true) // a COS child ending
      expect(hasHaltMarker(SID)).toBe(true)
      sessionSignalStore.apply(env('SessionEnd', at - 5_000), false) // drained late, from before the cancel
      expect(hasHaltMarker(SID)).toBe(true)
      sessionSignalStore.apply(env('SessionEnd', at + 30), false)
      expect(hasHaltMarker(SID)).toBe(false)
    } finally {
      runtime.stop()
    }
  })

  it('the boot sweeps markers past their hour, and stop() unsubscribes', () => {
    const now = Date.now()
    const old = 'a1b2c3d4-0000-4000-8000-0000000cafe3'
    writeHaltMarker(old, { at: now - HALT_MARKER_TTL_MS - 1, clientCancelId: 'cc-old' })
    writeHaltMarker(SID, { at: now, clientCancelId: 'cc-new' })
    const runtime = boot()
    expect(hasHaltMarker(old)).toBe(false)
    expect(hasHaltMarker(SID)).toBe(true)
    runtime.stop()
    sessionSignalStore.apply(env('SessionEnd', now + 10), false)
    expect(hasHaltMarker(SID)).toBe(true)
  })
})

// 6.53.3 (review A5): after a killed `claude -p` COS turn the hooks still show its turn open
// (a SIGKILLed child fires no Stop or SessionEnd), and until 6.53.2 the lens offered a
// phantom "Cancel run" (desk_run) on a thread where nothing runs.
describe('claudeDeskRunning weighs the cancel on record (6.53.3)', () => {
  const SID = 'a1b2c3d4-0000-4000-8000-0000000cafe7'
  const env = (event: HookEnvelope['event'], ts: number, payload: Record<string, unknown> = {}): HookEnvelope =>
    ({ ts, ppid: 1, event, sessionId: SID, payload: { session_id: SID, ...payload } })
  const record = (dir: string, pid: number, status: string, statusUpdatedAt: number) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: SID, entrypoint: 'claude-desktop', status, statusUpdatedAt }))
  afterEach(() => __resetThreadCancelsForTests())

  it('a cos_turn cancel with nothing since: the open turn is the dead child\'s, not a desk run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
    const t0 = 1_000_000
    sessionSignalStore.apply(env('UserPromptSubmit', t0, { prompt: 'go' }), false)
    sessionSignalStore.apply(env('PreToolUse', t0 + 5, { tool_name: 'Bash', tool_input: { command: 'make' } }), false)
    expect(claudeDeskRunning(SID, t0 + 100, dir)).toBe(true)
    noteThreadCancelled('claude', SID, t0 + 50, 'cos_turn')
    expect(claudeDeskRunning(SID, t0 + 100, dir)).toBe(false)
    // Anything the session does after the cancel is live again.
    sessionSignalStore.apply(env('PostToolUse', t0 + 60, { tool_name: 'Bash', tool_input: { command: 'make' } }), false)
    expect(claudeDeskRunning(SID, t0 + 100, dir)).toBe(true)
  })

  it('a desk_run cancel: still running until the desk itself says the run ended after the cancel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
    const t0 = 2_000_000
    sessionSignalStore.apply(env('UserPromptSubmit', t0, { prompt: 'go' }), false)
    sessionSignalStore.apply(env('PreToolUse', t0 + 5, { tool_name: 'Bash', tool_input: { command: 'make' } }), false)
    noteThreadCancelled('claude', SID, t0 + 50, 'desk_run')
    // Inside a long tool: the run the person cancelled is still going (tap again = rearm).
    expect(claudeDeskRunning(SID, t0 + 100, dir)).toBe(true)
    expect(deskTurnEndedAt(SID, dir)).toBeNull()
    // An idle flip from before the cancel is the previous turn's.
    record(dir, 2_147_483_001, 'idle', t0 + 40)
    expect(claudeDeskRunning(SID, t0 + 100, dir)).toBe(true)
    // The halt took: the registry flipped idle after the cancel.
    record(dir, 2_147_483_001, 'idle', t0 + 70)
    expect(deskTurnEndedAt(SID, dir)).toBe(t0 + 70)
    expect(claudeDeskRunning(SID, t0 + 100, dir)).toBe(false)
  })

  it('deskTurnEndedAt reads the hooks\' own end only while no turn is open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-registry-'))
    const t0 = 3_000_000
    sessionSignalStore.apply(env('UserPromptSubmit', t0, { prompt: 'go' }), false)
    expect(deskTurnEndedAt(SID, dir)).toBeNull()
    sessionSignalStore.apply(env('Stop', t0 + 10), false)
    expect(deskTurnEndedAt(SID, dir)).toBe(t0 + 10)
    sessionSignalStore.apply(env('UserPromptSubmit', t0 + 20, { prompt: 'again' }), false)
    expect(deskTurnEndedAt(SID, dir)).toBeNull()
    sessionSignalStore.apply(env('StopFailure', t0 + 30, { error_type: 'rate_limit' }), false)
    expect(deskTurnEndedAt(SID, dir)).toBe(t0 + 30)
    sessionSignalStore.apply(env('SessionEnd', t0 + 40, { reason: 'other' }), false)
    expect(deskTurnEndedAt(SID, dir)).toBe(t0 + 40)
  })
})

// 6.53.3 (review A6): the runtime re-arms a handed-off turn's marker through that turn's own
// UserPromptSubmit, which the hook script answers by deleting the marker.
describe('a handed-off turn\'s halt marker is re-armed through its own prompt (6.53.3)', () => {
  const SID = 'a1b2c3d4-0000-4000-8000-0000000cafe8'
  const PROMPT = 'keep going on the parser'
  const env = (event: HookEnvelope['event'], ts: number, payload: Record<string, unknown> = {}): HookEnvelope =>
    ({ ts, ppid: 1, event, sessionId: SID, payload: { session_id: SID, ...payload } })
  afterEach(() => __resetHaltRearmsForTests())

  function boot() {
    const home = mkdtempSync(join(tmpdir(), 'cos-runtime-'))
    process.env.COS_GLASSES_HOME = home
    process.env.COS_SESSION_HOOKS_SPOOL_DIR = join(home, 'spool')
    process.env.COS_CLAUDE_SESSIONS_DIR = join(home, 'sessions')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    return startSessionHooksRuntime({ port: 3141 })
  }

  it('a busy session: armed now, deleted by the delivered prompt, written back by the server', () => {
    const runtime = boot()
    try {
      const sentAt = Date.now()
      // The desk was mid-turn when COS handed the prompt over (its turn began earlier).
      sessionSignalStore.apply(env('UserPromptSubmit', sentAt - 60_000, { prompt: 'the desk\'s own work' }), false)
      expect(haltHandedOffTurn(SID, { at: sentAt, clientCancelId: 'cc-rearm-1' }, { promptMarker: PROMPT, sentAt })).toBe(true)
      expect(hasHaltMarker(SID)).toBe(true)
      expect(hasPendingHaltRearm(SID)).toBe(true)
      // The marker stops the desk run; a COS child's prompt on the id never re-arms.
      clearHaltMarker(SID)
      sessionSignalStore.apply(env('UserPromptSubmit', sentAt + 10, { prompt: PROMPT }), true)
      expect(hasHaltMarker(SID)).toBe(false)
      // The delivered turn is dequeued: the hook deleted the marker, the server puts it back.
      sessionSignalStore.apply(env('UserPromptSubmit', sentAt + 20, { prompt: PROMPT }), false)
      expect(hasHaltMarker(SID)).toBe(true)
      expect(hasPendingHaltRearm(SID)).toBe(false)
    } finally {
      runtime.stop()
    }
  })

  it('an idle session that already took the turn: armed once, never re-armed by the next desk prompt', () => {
    const runtime = boot()
    try {
      const sentAt = Date.now()
      sessionSignalStore.apply(env('UserPromptSubmit', sentAt + 5, { prompt: PROMPT }), false)
      expect(haltHandedOffTurn(SID, { at: sentAt, clientCancelId: 'cc-rearm-2' }, { promptMarker: PROMPT, sentAt })).toBe(true)
      expect(hasPendingHaltRearm(SID)).toBe(false)
      clearHaltMarker(SID)
      sessionSignalStore.apply(env('UserPromptSubmit', sentAt + 50, { prompt: PROMPT }), false)
      expect(hasHaltMarker(SID)).toBe(false)
    } finally {
      runtime.stop()
    }
  })

  it('SessionEnd drops a pending re-arm', () => {
    const runtime = boot()
    try {
      const sentAt = Date.now()
      haltHandedOffTurn(SID, { at: sentAt, clientCancelId: 'cc-rearm-3' }, { promptMarker: PROMPT, sentAt })
      expect(hasPendingHaltRearm(SID)).toBe(true)
      sessionSignalStore.apply(env('SessionEnd', sentAt + 5, { reason: 'other' }), false)
      expect(hasPendingHaltRearm(SID)).toBe(false)
    } finally {
      runtime.stop()
    }
  })
})
