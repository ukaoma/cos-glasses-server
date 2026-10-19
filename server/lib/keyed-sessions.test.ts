// Key lanes K1 P3 (plan v4 7.3): the keyed-session store and the attach and fork refusals.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dataDir = mkdtempSync(join(tmpdir(), 'kl-p3-keyed-'))
process.env.COS_DATA_DIR = dataDir

const keyed = await import('./keyed-sessions.js')
const { deliverAttachedTurn } = await import('./attached-provider-adapter.js')
const { forkThread } = await import('./fork-thread.js')
const lanes = await import('./key-lanes.js')

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))
beforeEach(() => {
  rmSync(keyed.keyedSessionsPath(), { force: true })
  keyed.__resetKeyedSessionsForTests()
})

const KEYED = '6d12ff82-51fa-48b0-9e83-f4091a4f4c98'
const PLAIN = 'd92ad220-34b4-4f67-b2d8-1d1dd00a2dce'

describe('keyed-sessions.json', () => {
  it('reading never creates: no file, nothing keyed, data dir untouched', () => {
    const before = readdirSync(dataDir).sort()
    expect(keyed.anyKeyedSessions()).toBe(false)
    expect(keyed.isKeyedSession(KEYED)).toBe(false)
    expect(keyed.isKeyedCosSession('cos-1')).toBe(false)
    expect(keyed.keyedSessionIds()).toEqual([])
    expect(readdirSync(dataDir).sort()).toEqual(before)
    expect(existsSync(keyed.keyedSessionsPath())).toBe(false)
  })

  it('a recorded session is keyed, persisted 0600, idempotent, and survives a restart (file only)', () => {
    keyed.recordKeyedSession({ id: KEYED, engine: 'claude', profileId: 'sonnet-key', cosSessionId: 'cos-1' })
    keyed.recordKeyedSession({ id: KEYED, engine: 'claude', profileId: 'sonnet-key', cosSessionId: 'cos-1' })
    expect(statSync(keyed.keyedSessionsPath()).mode & 0o777).toBe(0o600)
    keyed.__resetKeyedSessionsForTests() // a new boot: memory gone, the file remains
    expect(keyed.isKeyedSession(KEYED)).toBe(true)
    expect(keyed.isKeyedSession(PLAIN)).toBe(false)
    expect(keyed.isKeyedCosSession('cos-1')).toBe(true)
    expect(keyed.keyedSessionIds()).toEqual([KEYED])
  })

  it('a failed write still refuses for the rest of the boot', () => {
    const decoy = join(dataDir, 'decoy.json')
    writeFileSync(decoy, '{}')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A symlinked target makes the private writer refuse.
    symlinkSync(decoy, keyed.keyedSessionsPath())
    try {
      keyed.recordKeyedSession({ id: KEYED, engine: 'claude', profileId: 'p' })
      expect(spy).toHaveBeenCalled()
      expect(keyed.isKeyedSession(KEYED)).toBe(true)
    } finally {
      spy.mockRestore()
      rmSync(keyed.keyedSessionsPath(), { force: true })
      rmSync(decoy, { force: true })
    }
  })

  it('a malformed id is not recorded; a torn file reads as empty and is left in place', () => {
    keyed.recordKeyedSession({ id: '../../etc', engine: 'claude', profileId: 'p' })
    expect(existsSync(keyed.keyedSessionsPath())).toBe(false)
    writeFileSync(keyed.keyedSessionsPath(), '{ torn', { mode: 0o600 })
    expect(keyed.isKeyedSession(KEYED)).toBe(false)
    expect(existsSync(keyed.keyedSessionsPath())).toBe(true)
  })

  it('feeds keyedSessionIds to the P1 status provider', () => {
    keyed.recordKeyedSession({ id: KEYED, engine: 'claude', profileId: 'p' })
    expect(lanes.keyLanesStatusProvider().keyedSessionIds?.()).toEqual([KEYED])
  })
})

// Deps whose spawn must never be reached for a keyed thread.
function deps() {
  const spawn = vi.fn(() => { throw new Error('spawn must not run') })
  return {
    spawn,
    deps: {
      now: () => 1_786_000_000_000,
      preflight: () => ({ attachable: true, reason: null }),
      resolveBinary: () => ({ ok: true, path: '/usr/bin/false', source: 'absolute' }),
      spawn,
      processStartMs: () => 1,
      recordSpawn: () => 'recorded',
      releaseSpawn: () => true,
      terminate: () => {},
    } as any,
  }
}

describe('attach and fork refuse a keyed thread before anything is built (plan 7.3)', () => {
  it('attach: keyed_session, not_attempted, no spawn; a plain thread goes on to the provider', async () => {
    keyed.recordKeyedSession({ id: KEYED, engine: 'claude', profileId: 'sonnet-key' })
    const d = deps()
    const r = await deliverAttachedTurn({ provider: 'claude', nativeThreadId: KEYED, prompt: 'hi', cwd: '/tmp', policy: 'session_posture', deps: d.deps })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('keyed_session')
    expect(r.delivery).toBe('not_attempted')
    expect(d.spawn).not.toHaveBeenCalled()
    const p = deps()
    const plain = await deliverAttachedTurn({ provider: 'claude', nativeThreadId: PLAIN, prompt: 'hi', cwd: '/tmp', policy: 'session_posture', deps: p.deps })
    expect(plain.ok === false && plain.reason).not.toBe('keyed_session')
    expect(p.spawn).toHaveBeenCalledTimes(1)
  })

  it('fork: keyed_session, forkState none, no spawn; a plain thread goes on to the provider', async () => {
    keyed.recordKeyedSession({ id: KEYED, engine: 'claude', profileId: 'sonnet-key' })
    const d = deps()
    const r = await forkThread({ provider: 'claude', nativeThreadId: KEYED, prompt: 'hi', cwd: '/tmp', policy: 'read_only', deps: d.deps })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('keyed_session')
    expect(r.forkState).toBe('none')
    expect(d.spawn).not.toHaveBeenCalled()
    const p = deps()
    const plain = await forkThread({ provider: 'claude', nativeThreadId: PLAIN, prompt: 'hi', cwd: '/tmp', policy: 'read_only', deps: p.deps })
    expect(plain.ok === false && plain.reason).not.toBe('keyed_session')
    expect(p.spawn).toHaveBeenCalledTimes(1)
  })

  it('with nothing ever keyed, the same keyed-looking id is attached as today', async () => {
    const d = deps()
    const r = await deliverAttachedTurn({ provider: 'claude', nativeThreadId: KEYED, prompt: 'hi', cwd: '/tmp', policy: 'session_posture', deps: d.deps })
    expect(r.ok === false && r.reason).not.toBe('keyed_session')
    expect(d.spawn).toHaveBeenCalledTimes(1)
  })
})
