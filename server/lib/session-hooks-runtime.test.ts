// The composition root's own rules: the two-scan memory lives here (not in the pure
// deriver), a COS child's pid is remembered past its exit, and off means off.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordCosSpawn, releaseCosSpawn } from './agent-session-ownership-store.js'
import { COS_PID_TOMBSTONE_MS, __resetSessionHooksForTests, deriveForRow, isCosSpawnedPid, registryEntrypointSync, registryIdleAfterStop, registryRecordSync, sessionHooksEnabled, sessionSignalStore, startSessionHooksRuntime } from './session-hooks-runtime.js'
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
