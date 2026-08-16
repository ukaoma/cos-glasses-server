import { describe, it, expect } from 'vitest'
import {
  CLAUDE_REGISTRY_FILENAME,
  claudeOwners,
  codexLockPath,
  codexOwners,
  isSelfOwned,
  parseProcStartUtcMs,
  processStartMatches,
  threadOccupancy,
  ACTIVE_RECENTLY_WINDOW_MS,
  holderActivity,
  isActiveRecently,
  type OccupancyProbes,
  type OccupancyReason,
} from './thread-occupancy'

// Values below are the REAL ones observed on this machine 2026-08-15. Fixture
// realism is the point: a fixture that cannot express the production value
// cannot catch the production bug. The UTC/local pair is the exact pair that
// produced a false PID-reuse verdict, and the Codex id is the full UUID that
// actually names a lock file on disk.
const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const OTHER_SID = '80927570-0000-4000-8000-000000000000'
const CODEX_THREAD = '019fc80a-cc79-7921-8541-298e71695afd'
const PROC_START_UTC = 'Sun Aug 16 02:03:05 2026'
const ACTUAL_START_MS = Date.UTC(2026, 7, 16, 2, 3, 5) // 21:03:05 CDT, same instant
const CLAUDE_DIR = '/home/.claude/sessions'
const CODEX_DIR = '/home/.codex/thread-writer-locks'
const DIRS = { claudeSessionsDir: CLAUDE_DIR, codexLocksDir: CODEX_DIR }

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 7872,
    sessionId: SID,
    procStart: PROC_START_UTC,
    messagingSocketPath: '/tmp/cc-socks/7872.sock',
    // Present so a test cannot pass by reading a field that must never be
    // trusted for identity: a CLI `claude -p` reports these identically.
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
    readDir: () => ['7872.json'],
    readFile: () => JSON.stringify(record()),
    lockHolders: () => [],
    cosSpawnedPids: () => new Map<number, number>(),
    ...over,
  }
}

/**
 * The assertion that matters. An earlier suite checked `owners.length === 0` and
 * called that "not treated as free" — but empty owners with no doubt IS the free
 * verdict, so those tests asserted the input to the bug and named it the
 * absence of the bug. Every occupancy case goes through the real verdict.
 */
function expectOccupied(p: OccupancyProbes, reason: OccupancyReason, provider = 'claude', id = SID) {
  const o = threadOccupancy(provider, id, p, DIRS)
  expect({ attachable: o.attachable, reason: o.reason }).toEqual({ attachable: false, reason })
}

describe('procStart is UTC while ps is local', () => {
  it('reads the recorded value as UTC, not local', () => {
    expect(parseProcStartUtcMs(PROC_START_UTC)).toBe(ACTUAL_START_MS)
  })

  it('matches the live process despite the five-hour display difference', () => {
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

describe('no path returns attachable while a live owner exists', () => {
  it('finds the live owner and refuses to attach', () => {
    const o = threadOccupancy('claude', SID, probes(), DIRS)
    expect(o.attachable).toBe(false)
    expect(o.reason).toBe('live_desktop_process')
    expect(o.owners[0]).toMatchObject({ pid: 7872, provider: 'claude', selfOwned: false })
  })

  // Each case below has a live owner (pid 7872) present in the registry. All of
  // them returned attachable:true in the first implementation.
  it('refuses a truncated 8-char display id instead of finding nothing', () => {
    expectOccupied(probes(), 'invalid_thread_id', 'claude', SID.slice(0, 8))
  })

  it('refuses a path-traversal id before it can reach a filesystem path', () => {
    expectOccupied(probes(), 'invalid_thread_id', 'claude', '../../etc/passwd')
    expectOccupied(probes(), 'invalid_thread_id', 'codex', '../../etc/passwd')
  })

  it('refuses ids that SAFE_ID_RE would permit', () => {
    for (const bad of ['native:something', 'abc@host', 'a.b.c', 'x'.repeat(128), SID.toUpperCase()]) {
      expectOccupied(probes(), 'invalid_thread_id', 'claude', bad)
    }
  })

  it('treats corrupt JSON as doubt, not absence', () => {
    expectOccupied(probes({ readFile: () => '{ not json' }), 'registry_unreadable')
  })

  it('treats an unreadable record (null) as doubt, not absence', () => {
    // The documented "unreadable" signal. It previously failed OPEN while the
    // undocumented throw path failed closed — the two were inverted.
    expectOccupied(probes({ readFile: () => null }), 'registry_unreadable')
  })

  it('treats a non-object JSON body as doubt', () => {
    expectOccupied(probes({ readFile: () => '"7872"' }), 'registry_unreadable')
    expectOccupied(probes({ readFile: () => '[]' }), 'registry_unreadable')
  })

  it('treats a malformed pid on a matching record as doubt', () => {
    // The record already claims THIS thread, so discarding it is not "no owner".
    for (const pid of ['7872a', undefined, -1, 0, 1.5, true, '0x1ec0', ['7872']]) {
      expectOccupied(probes({ readFile: () => JSON.stringify(record({ pid })) }), 'registry_unreadable')
    }
  })

  it('treats an absent registry directory as detector_unavailable, not free', () => {
    // Claude Code only writes this registry from 2.1.224. On an older build the
    // directory is missing while attachable-looking threads exist.
    expectOccupied(probes({ dirExists: () => false }), 'detector_unavailable')
  })

  it('refuses when the directory cannot be read', () => {
    expectOccupied(probes({ readDir: () => { throw new Error('EACCES') } }), 'probe_failed')
  })

  it('refuses when the spawn ledger throws', () => {
    // The single most safety-critical probe, and the one previously unwrapped.
    expectOccupied(probes({ cosSpawnedPids: () => { throw new Error('ledger down') } }), 'probe_failed')
  })

  it('refuses an implausibly large registry rather than scanning it', () => {
    const many = Array.from({ length: 501 }, (_, i) => `${i + 1}.json`)
    expectOccupied(probes({ readDir: () => many }), 'registry_unreadable')
  })
})

describe('attachable requires positive proof of an empty registry', () => {
  it('attaches when the directory exists and holds no matching record', () => {
    const o = threadOccupancy('claude', SID, probes({ readDir: () => [] }), DIRS)
    expect(o).toEqual({ attachable: true, owners: [], reason: null })
  })

  it('attaches when the only records belong to other sessions', () => {
    const o = threadOccupancy('claude', OTHER_SID, probes(), DIRS)
    expect(o.attachable).toBe(true)
  })

  it('ignores a stale record whose PID is dead', () => {
    // 64256.json persisted for a process dead since Aug 14: reaping happens on
    // clean exit and a crash skips it. Genuinely dead is genuinely no owner.
    const o = threadOccupancy('claude', SID, probes({ isAlive: () => false }), DIRS)
    expect(o.attachable).toBe(true)
  })

  it('only reads <pid>.json', () => {
    // The live directory really does hold <pid>.<sha256>.key files alongside.
    const o = threadOccupancy('claude', SID, probes({
      readDir: () => ['7872.088e9148.key', 'config.json', '.DS_Store'],
    }), DIRS)
    expect(o.attachable).toBe(true)
    expect(CLAUDE_REGISTRY_FILENAME.test('7872.json')).toBe(true)
    expect(CLAUDE_REGISTRY_FILENAME.test('7872.088e9148.key')).toBe(false)
    expect(CLAUDE_REGISTRY_FILENAME.test('config.json')).toBe(false)
  })
})

describe('PID reuse cannot forge identity in either direction', () => {
  it('refuses a recycled PID in the registry', () => {
    expectOccupied(
      probes({ processStartMs: () => ACTUAL_START_MS + 86_400_000 }),
      'unverifiable_process_start',
    )
  })

  it('names a missing socket distinctly from a process-start failure', () => {
    expectOccupied(probes({ fileExists: () => false }), 'unverifiable_liveness_socket')
  })

  it('refuses a recycled PID in the SPAWN LEDGER', () => {
    // The only path that turns a live owner into attachable. A bare pid Set
    // could not express this: the ledger entry must also match the start time.
    const stale = new Map([[7872, ACTUAL_START_MS - 86_400_000]])
    expectOccupied(probes({ cosSpawnedPids: () => stale }), 'live_desktop_process')
  })

  it('accepts a genuine self-owned process', () => {
    const ours = new Map([[7872, ACTUAL_START_MS]])
    const o = threadOccupancy('claude', SID, probes({ cosSpawnedPids: () => ours }), DIRS)
    expect(o.attachable).toBe(true)
    expect(o.owners[0]!.selfOwned).toBe(true)
  })

  it('isSelfOwned requires both membership and a matching start', () => {
    const ledger = new Map([[7872, ACTUAL_START_MS]])
    expect(isSelfOwned(7872, ACTUAL_START_MS, ledger)).toBe(true)
    expect(isSelfOwned(7872, ACTUAL_START_MS + 900, ledger)).toBe(true) // tolerance
    expect(isSelfOwned(7872, ACTUAL_START_MS + 60_000, ledger)).toBe(false)
    expect(isSelfOwned(7872, null, ledger)).toBe(false)
    expect(isSelfOwned(9999, ACTUAL_START_MS, ledger)).toBe(false)
  })

  it('does not let entrypoint or kind decide self-ownership', () => {
    // Same record with CLI-looking fields, empty ledger -> still foreign.
    expectOccupied(
      probes({ readFile: () => JSON.stringify(record({ entrypoint: 'cli', kind: 'print' })) }),
      'live_desktop_process',
    )
  })
})

describe('codex occupancy', () => {
  const codexProbes = (over: Partial<OccupancyProbes> = {}) => probes({ readDir: () => [], ...over })

  it('a held lock is an owner', () => {
    const o = threadOccupancy('codex', CODEX_THREAD, codexProbes({ lockHolders: () => [4224] }), DIRS)
    expect(o.attachable).toBe(false)
    expect(o.reason).toBe('live_desktop_process')
    expect(o.owners[0]).toMatchObject({ pid: 4224, source: 'codex-writer-lock' })
  })

  it('a lock FILE with no holder is not occupancy', () => {
    // Observed twice: a thread lock file outlived its `codex exec`, and
    // .coordination.lock exists permanently held by nobody.
    const o = threadOccupancy('codex', CODEX_THREAD, codexProbes({ lockHolders: () => [] }), DIRS)
    expect(o.attachable).toBe(true)
  })

  it('an absent locks DIRECTORY is detector_unavailable, not free', () => {
    expectOccupied(codexProbes({ dirExists: () => false }), 'detector_unavailable', 'codex', CODEX_THREAD)
  })

  it('rejects malformed holder pids as doubt', () => {
    expectOccupied(
      codexProbes({ lockHolders: () => [0, -1, Number.NaN] as number[] }),
      'registry_unreadable', 'codex', CODEX_THREAD,
    )
  })

  it('a recycled PID cannot forge self-ownership on the lock either', () => {
    const stale = new Map([[4224, ACTUAL_START_MS - 86_400_000]])
    expectOccupied(
      codexProbes({ lockHolders: () => [4224], cosSpawnedPids: () => stale }),
      'live_desktop_process', 'codex', CODEX_THREAD,
    )
  })

  it('refuses when the holder probe fails', () => {
    expectOccupied(
      codexProbes({ lockHolders: () => { throw new Error('lsof missing') } }),
      'probe_failed', 'codex', CODEX_THREAD,
    )
  })

  it('builds the path from the full thread id', () => {
    // The real filename on disk is the full UUID, not the display form.
    expect(codexLockPath(CODEX_THREAD, CODEX_DIR)).toBe(`${CODEX_DIR}/${CODEX_THREAD}.lock`)
  })
})

describe('unsupported providers', () => {
  it('reports cursor and unknowns as unsupported, never free', () => {
    for (const p of ['cursor', 'gemini', '']) {
      expectOccupied(probes(), 'unsupported_provider', p)
    }
  })

  it('checks the provider before the thread id', () => {
    // An unrecognised provider is a capability gap; reporting invalid_thread_id
    // for it would send the user chasing the wrong problem.
    const o = threadOccupancy('cursor', 'nonsense', probes(), DIRS)
    expect(o.reason).toBe('unsupported_provider')
  })
})

describe('scan-level results carry doubt separately from owners', () => {
  it('claudeOwners reports doubt with zero owners', () => {
    const r = claudeOwners(SID, probes({ readFile: () => null }), CLAUDE_DIR)
    expect(r.owners).toHaveLength(0)
    expect(r.doubt).toBe('registry_unreadable')
  })

  it('codexOwners can report doubt too', () => {
    const r = codexOwners(CODEX_THREAD, probes({ lockHolders: () => [-1] }), CODEX_DIR)
    expect(r.owners).toHaveLength(0)
    expect(r.doubt).toBe('registry_unreadable')
  })
})

// ===========================================================================
// THE IDLE-HOLDER RELAXATION (6.32.0)
// ===========================================================================
//
// These execute the real `threadOccupancy`. They are not source-shape checks:
// every one of them drives a verdict out of the function, so a mutation to the
// branch fails here rather than passing on a grep.

describe('holderActivity separates measured-idle from unmeasurable', () => {
  const NOW = ACTUAL_START_MS

  it('calls a transcript written inside the window WORKING', () => {
    expect(holderActivity(NOW, NOW)).toBe('working')
    expect(holderActivity(NOW - (ACTIVE_RECENTLY_WINDOW_MS - 1), NOW)).toBe('working')
  })

  it('calls a transcript written outside the window IDLE', () => {
    expect(holderActivity(NOW - (ACTIVE_RECENTLY_WINDOW_MS + 1), NOW)).toBe('idle')
    expect(holderActivity(NOW - 10 * 60_000, NOW)).toBe('idle')
  })

  /**
   * THE ONE THAT MATTERS. `isActiveRecently` answers false for every one of
   * these, and false is the permissive answer at a gate. If `holderActivity`
   * ever collapses to that boolean, an unreadable transcript becomes a licence
   * to write into someone's open conversation.
   */
  it('calls an unmeasurable reading UNKNOWN, never idle', () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(holderActivity(bad as number | null | undefined, NOW)).toBe('unknown')
      expect(isActiveRecently(bad as number | null | undefined, NOW)).toBe(false)
    }
    expect(holderActivity(NOW, NaN)).toBe('unknown')
  })

  it('refuses a far-future transcript rather than reading it as idle', () => {
    // A clock this server cannot reason about must not hand out the permissive
    // answer forever. Ordinary skew still lands inside the window as working.
    expect(holderActivity(NOW + 5_000, NOW)).toBe('working')
    expect(holderActivity(NOW + 7 * 24 * 3_600_000, NOW)).toBe('unknown')
  })
})

describe('a foreign holder blocks on WORKING, not on merely held', () => {
  const idleClock = (): Partial<OccupancyProbes> => ({
    transcriptMtimeMs: () => Date.now() - 10 * 60_000,
  })
  const workingClock = (): Partial<OccupancyProbes> => ({ transcriptMtimeMs: () => Date.now() })

  it('attaches to a live foreign holder measured idle, and says so', () => {
    const o = threadOccupancy('claude', SID, probes(idleClock()), DIRS)
    expect({ attachable: o.attachable, reason: o.reason }).toEqual({ attachable: true, reason: null })
    // The owner is still REPORTED. Relaxing the gate must not make COS claim the
    // thread is unowned; ownerCount is what stops a client being more confident
    // than the server.
    expect(o.owners).toHaveLength(1)
    expect(o.owners[0]).toMatchObject({ pid: 7872, selfOwned: false })
    // And the permissive outcome is DECLARED, which is what projectAttachability
    // requires before it will forward an attachable verdict carrying a foreigner.
    expect(o.idleHolder).toBe(true)
  })

  it('still refuses a holder that is writing right now', () => {
    const o = threadOccupancy('claude', SID, probes(workingClock()), DIRS)
    expect({ attachable: o.attachable, reason: o.reason })
      .toEqual({ attachable: false, reason: 'native_thread_working' })
    expect(o.idleHolder).toBeUndefined()
  })

  it('refuses with the original reason when no clock is wired at all', () => {
    // The default probe set has no `transcriptMtimeMs`. This is the pre-6.32.0
    // gate, and it is what an install gets by doing nothing.
    const o = threadOccupancy('claude', SID, probes(), DIRS)
    expect({ attachable: o.attachable, reason: o.reason })
      .toEqual({ attachable: false, reason: 'live_desktop_process' })
    expect(o.idleHolder).toBeUndefined()
  })

  it('refuses when the clock cannot read the transcript', () => {
    for (const clock of [() => null, () => NaN, () => { throw new Error('EACCES') }]) {
      const o = threadOccupancy('claude', SID, probes({ transcriptMtimeMs: clock as () => number }), DIRS)
      expect({ attachable: o.attachable, reason: o.reason })
        .toEqual({ attachable: false, reason: 'live_desktop_process' })
    }
  })

  /**
   * The relaxation must not swallow the doubt reasons. "The scan could not see"
   * and "the holder is idle" are different findings, and only the second one is
   * permissive. A registry it cannot read is not an idle holder.
   */
  it('does not let an idle clock override a scan that could not see', () => {
    const o = threadOccupancy('claude', SID, probes({
      ...idleClock(),
      // A NUMERIC name, because `CLAUDE_REGISTRY_FILENAME` is `^\d+\.json$` and
      // a non-matching entry is skipped silently -- the first version of this
      // fixture used 'garbage.json' and therefore raised no doubt at all.
      readDir: () => ['7872.json', '9999.json'],
      readFile: (p: string) => p.endsWith('9999.json') ? null : JSON.stringify(record()),
    }), DIRS)
    expect({ attachable: o.attachable, reason: o.reason })
      .toEqual({ attachable: false, reason: 'registry_unreadable' })
  })

  it('applies to codex holders too, not just claude', () => {
    const held = (over: Partial<OccupancyProbes>) => probes({ lockHolders: () => [4224], ...over })
    expect(threadOccupancy('codex', CODEX_THREAD, held(workingClock()), DIRS).reason)
      .toBe('native_thread_working')
    const idle = threadOccupancy('codex', CODEX_THREAD, held(idleClock()), DIRS)
    expect({ attachable: idle.attachable, idleHolder: idle.idleHolder })
      .toEqual({ attachable: true, idleHolder: true })
  })

  it('never marks idleHolder on a verdict with no foreign owner', () => {
    // A thread COS owns, or one with no owner at all, is attachable on the
    // ordinary path. Marking it would hand projectAttachability's contradiction
    // check a blanket exemption it must never have.
    const ours = probes({ ...idleClock(), cosSpawnedPids: () => new Map([[7872, ACTUAL_START_MS]]) })
    expect(threadOccupancy('claude', SID, ours, DIRS).idleHolder).toBeUndefined()
    const empty = probes({ ...idleClock(), readDir: () => [] })
    const free = threadOccupancy('claude', SID, empty, DIRS)
    expect({ attachable: free.attachable, idleHolder: free.idleHolder })
      .toEqual({ attachable: true, idleHolder: undefined })
  })
})
