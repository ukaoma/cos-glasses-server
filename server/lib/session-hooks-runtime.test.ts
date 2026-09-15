// The composition root's own rules: the two-scan memory lives here (not in the pure
// deriver), a COS child's pid is remembered past its exit, and off means off.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordCosSpawn, releaseCosSpawn } from './agent-session-ownership-store.js'
import { COS_PID_TOMBSTONE_MS, __resetSessionHooksForTests, deriveForRow, isCosSpawnedPid, sessionHooksEnabled } from './session-hooks-runtime.js'
import { DEAD_GRACE_MS, MISS_LIMIT } from './session-state-derive.js'

const saved: Record<string, string | undefined> = {}
const KEYS = ['COS_CLAUDE_SESSIONS_ENABLED', 'COS_SESSION_HOOKS'] as const

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
