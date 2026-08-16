import { describe, it, expect } from 'vitest'
import {
  CLAUDE_REGISTRY_FILENAME,
  claudeOwners,
  codexLockPath,
  codexOwners,
  parseProcStartUtcMs,
  processStartMatches,
  threadOccupancy,
  type OccupancyProbes,
} from './thread-occupancy'

// Values below are the REAL ones observed on this machine 2026-08-15, not
// invented shapes. Fixture realism is the point: a fixture that cannot express
// the production value cannot catch the production bug. The UTC/local pair in
// particular is the exact pair that produced a false PID-reuse verdict.
const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const OTHER_SID = '80927570-0000-4000-8000-000000000000'
const PROC_START_UTC = 'Sun Aug 16 02:03:05 2026'
const ACTUAL_START_MS = Date.UTC(2026, 7, 16, 2, 3, 5) // same instant, 21:03:05 CDT
const CLAUDE_DIR = '/home/.claude/sessions'
const CODEX_DIR = '/home/.codex/thread-writer-locks'

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 7872,
    sessionId: SID,
    procStart: PROC_START_UTC,
    messagingSocketPath: '/tmp/cc-socks/7872.sock',
    // Fields observed alongside, deliberately present so a test cannot pass by
    // reading one that must never be trusted for identity (see note 3).
    kind: 'interactive',
    entrypoint: 'claude-desktop',
    cwd: '/Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff',
    ...over,
  }
}

function probes(over: Partial<OccupancyProbes> = {}): OccupancyProbes {
  return {
    isAlive: () => true,
    processStartMs: () => ACTUAL_START_MS,
    fileExists: () => true,
    readDir: () => ['7872.json'],
    readFile: () => JSON.stringify(record()),
    lockHolders: () => [],
    cosSpawnedPids: () => new Set<number>(),
    ...over,
  }
}

describe('procStart is UTC while ps is local', () => {
  it('reads the recorded value as UTC, not local', () => {
    expect(parseProcStartUtcMs(PROC_START_UTC)).toBe(ACTUAL_START_MS)
  })

  it('matches the live process despite the five-hour display difference', () => {
    // The regression this exists for: comparing the strings, or parsing the
    // recorded value as local time, marks a healthy session as PID-reused.
    expect(processStartMatches(PROC_START_UTC, ACTUAL_START_MS)).toBe(true)
  })

  it('tolerates sub-second rounding but not a different process', () => {
    expect(processStartMatches(PROC_START_UTC, ACTUAL_START_MS + 900)).toBe(true)
    expect(processStartMatches(PROC_START_UTC, ACTUAL_START_MS + 60_000)).toBe(false)
  })

  it('treats an unparseable or absent start as NOT matching', () => {
    for (const bad of [undefined, null, '', 'yesterday', 42, {}]) {
      expect(processStartMatches(bad, ACTUAL_START_MS)).toBe(false)
    }
    expect(processStartMatches(PROC_START_UTC, null)).toBe(false)
  })
})

describe('claude occupancy', () => {
  it('finds the live owner of the thread', () => {
    const r = claudeOwners(SID, probes(), CLAUDE_DIR)!
    expect(r.owners).toHaveLength(1)
    expect(r.owners[0]).toMatchObject({ pid: 7872, provider: 'claude', selfOwned: false })
  })

  it('does not match a DIFFERENT session in the same directory', () => {
    // Two desktop tabs were open during the probe; the registry distinguished
    // them. If this ever matches, occupancy has become "is any Claude running",
    // which is the useless form the whole design rejected.
    const r = claudeOwners(OTHER_SID, probes(), CLAUDE_DIR)!
    expect(r.owners).toHaveLength(0)
  })

  it('never matches on a truncated id', () => {
    // ClaudePeer.id is sessionId.slice(0, 8) for display. Occupancy is a safety
    // decision and must require the full id.
    const r = claudeOwners(SID.slice(0, 8), probes(), CLAUDE_DIR)!
    expect(r.owners).toHaveLength(0)
  })

  it('ignores a stale record whose PID is dead', () => {
    // Observed live: 64256.json persisted for a process dead since Aug 14,
    // because reaping happens on clean exit and a crash skips it.
    const r = claudeOwners(SID, probes({ isAlive: () => false }), CLAUDE_DIR)!
    expect(r.owners).toHaveLength(0)
    expect(r.unverifiable).toBe(false)
  })

  it('refuses a recycled PID rather than trusting the stale record', () => {
    const r = claudeOwners(
      SID,
      probes({ processStartMs: () => ACTUAL_START_MS + 86_400_000 }),
      CLAUDE_DIR,
    )!
    expect(r.owners).toHaveLength(0)
    expect(r.unverifiable).toBe(true)
  })

  it('does not accept an alive PID whose socket is missing', () => {
    const r = claudeOwners(SID, probes({ fileExists: () => false }), CLAUDE_DIR)!
    expect(r.owners).toHaveLength(0)
    expect(r.unverifiable).toBe(true)
  })

  it('only reads <pid>.json, not every json in the directory', () => {
    const r = claudeOwners(
      SID,
      probes({ readDir: () => ['config.json', 'notes.json', '.DS_Store'] }),
      CLAUDE_DIR,
    )!
    expect(r.owners).toHaveLength(0)
    expect(CLAUDE_REGISTRY_FILENAME.test('7872.json')).toBe(true)
    expect(CLAUDE_REGISTRY_FILENAME.test('config.json')).toBe(false)
  })

  it('returns null (not empty) when the directory cannot be read', () => {
    const r = claudeOwners(SID, probes({ readDir: () => { throw new Error('EACCES') } }), CLAUDE_DIR)
    expect(r).toBeNull()
  })

  it('survives a corrupt registry file without treating the thread as free', () => {
    const r = claudeOwners(SID, probes({ readFile: () => '{ not json' }), CLAUDE_DIR)!
    expect(r.owners).toHaveLength(0)
  })
})

describe('codex occupancy', () => {
  it('a held lock is an owner', () => {
    const r = codexOwners('019fc80a', probes({ lockHolders: () => [4224] }), CODEX_DIR)!
    expect(r.owners).toHaveLength(1)
    expect(r.owners[0]).toMatchObject({ pid: 4224, source: 'codex-writer-lock' })
  })

  it('a lock FILE with no holder is not occupancy', () => {
    // Observed live twice: the thread lock file outlived its `codex exec`, and
    // .coordination.lock exists permanently held by nobody. Existence proves
    // nothing; only an open descriptor does.
    const r = codexOwners('019fc80a', probes({ lockHolders: () => [] }), CODEX_DIR)!
    expect(r.owners).toHaveLength(0)
  })

  it('an absent lock file means nobody', () => {
    const r = codexOwners('019fc80a', probes({ fileExists: () => false }), CODEX_DIR)!
    expect(r.owners).toHaveLength(0)
  })

  it('builds the path from the thread id', () => {
    expect(codexLockPath('019fc80a', CODEX_DIR)).toBe(`${CODEX_DIR}/019fc80a.lock`)
  })

  it('returns null when the holder probe fails', () => {
    const r = codexOwners(
      '019fc80a',
      probes({ lockHolders: () => { throw new Error('lsof missing') } }),
      CODEX_DIR,
    )
    expect(r).toBeNull()
  })
})

describe('the attach precondition', () => {
  const dirs = { claudeSessionsDir: CLAUDE_DIR, codexLocksDir: CODEX_DIR }

  it('is NOT attachable while a desktop process owns the thread', () => {
    const o = threadOccupancy('claude', SID, probes(), dirs)
    expect(o.attachable).toBe(false)
    expect(o.reason).toBe('live_desktop_process')
  })

  it('is attachable when the owner is a process COS spawned itself', () => {
    // Self-recursion (4.4): our own driver is not a foreign writer. This must be
    // decided by the spawn ledger, never by entrypoint/kind, which a CLI run
    // reports identically to a desktop window.
    const o = threadOccupancy(
      'claude',
      SID,
      probes({ cosSpawnedPids: () => new Set([7872]) }),
      dirs,
    )
    expect(o.attachable).toBe(true)
    expect(o.owners[0]!.selfOwned).toBe(true)
  })

  it('does not let entrypoint or kind decide self-ownership', () => {
    // Same record, same desktop-looking fields, empty ledger -> still foreign.
    const o = threadOccupancy(
      'claude',
      SID,
      probes({ readFile: () => JSON.stringify(record({ entrypoint: 'cli', kind: 'print' })) }),
      dirs,
    )
    expect(o.attachable).toBe(false)
  })

  it('is attachable when nobody holds the thread', () => {
    const o = threadOccupancy('claude', SID, probes({ readDir: () => [] }), dirs)
    expect(o.attachable).toBe(true)
    expect(o.reason).toBeNull()
  })

  it('fails CLOSED when a probe throws', () => {
    const o = threadOccupancy(
      'claude',
      SID,
      probes({ readDir: () => { throw new Error('EACCES') } }),
      dirs,
    )
    expect(o.attachable).toBe(false)
    expect(o.reason).toBe('probe_failed')
  })

  it('fails CLOSED on an unverifiable process rather than reporting free', () => {
    const o = threadOccupancy('claude', SID, probes({ fileExists: () => false }), dirs)
    expect(o.attachable).toBe(false)
    expect(o.reason).toBe('unverifiable_process_start')
  })

  it('reports cursor and unknown providers as unsupported, not free', () => {
    for (const p of ['cursor', 'gemini', '']) {
      const o = threadOccupancy(p, SID, probes(), dirs)
      expect(o.attachable).toBe(false)
      expect(o.reason).toBe('unsupported_provider')
    }
  })

  it('routes codex through the writer lock', () => {
    const busy = threadOccupancy('codex', '019fc80a', probes({ lockHolders: () => [4224] }), dirs)
    expect(busy.attachable).toBe(false)
    const free = threadOccupancy('codex', '019fc80a', probes({ lockHolders: () => [] }), dirs)
    expect(free.attachable).toBe(true)
  })
})
