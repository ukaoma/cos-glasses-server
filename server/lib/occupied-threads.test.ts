import { describe, it, expect } from 'vitest'
import { occupiedThreads } from './occupied-threads.js'
import type { OccupancyDirs, OccupancyProbes } from './thread-occupancy.js'

const A = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const B = 'b1111111-2222-4333-8444-555555555555'
const C = 'c9999999-8888-4777-8666-555555555555'

const DIRS: OccupancyDirs = {
  claudeSessionsDir: '/claude/sessions',
  codexLocksDir: '/codex/locks',
}

/**
 * A registry entry as Claude Code writes it.
 *
 * `procStart` must be in `ps -o lstart` format and `messagingSocketPath` must
 * stat — the matcher requires both, and a fixture missing either produces "no
 * owner" while looking perfectly plausible.
 */
const PROC_START = 'Sat Aug 16 10:00:00 2026'
const PROC_START_MS = Date.UTC(2026, 7, 16, 10, 0, 0)

const rec = (pid: number, sessionId: string) => JSON.stringify({
  pid, sessionId, procStart: PROC_START, kind: 'interactive',
  entrypoint: 'claude-desktop', cwd: '/tmp', startedAt: 1,
  messagingSocketPath: `/tmp/cos-${pid}.sock`,
})

function probes(over: Partial<OccupancyProbes> = {}): OccupancyProbes {
  return {
    dirExists: () => true,
    fileExists: () => true,
    readDir: () => [],
    readFile: () => null,
    isAlive: () => true,
    processStartMs: () => PROC_START_MS,
    cosSpawnedPids: () => new Map(),
    ...over,
  } as OccupancyProbes
}

/** One live desktop process holding thread A. */
function registryWith(entries: Record<string, string>): Partial<OccupancyProbes> {
  return {
    readDir: () => Object.keys(entries),
    readFile: (path: string) => {
      const name = path.split('/').pop() ?? ''
      return entries[name] ?? null
    },
  }
}

describe('one pass, many threads', () => {
  it('reports the thread a desktop process is holding', () => {
    const scan = occupiedThreads('claude', [A, B], probes(registryWith({
      '101.json': rec(101, A),
    })), DIRS)
    expect(scan.occupied.has(A)).toBe(true)
    expect(scan.occupied.get(A)?.foreignOwners).toBe(1)
    expect(scan.occupied.has(B)).toBe(false)
  })

  it('leaves an unheld thread out entirely', () => {
    const scan = occupiedThreads('claude', [B], probes(registryWith({
      '101.json': rec(101, A),
    })), DIRS)
    expect(scan.occupied.size).toBe(0)
    expect(scan.degraded).toBe(false)
  })

  it('counts COS\'s own turn as RUNNING but not as foreign', () => {
    // Two different questions. "Is an agent working here" is yes -- and hiding it
    // would blank the very screen the user opens to watch their own queued turn.
    // "Would a Continue be refused" is no, because self-owned work does not block
    // a write. The write gate reads foreignOwners; the badge reads owners.
    const scan = occupiedThreads('claude', [A], probes({
      ...registryWith({ '101.json': rec(101, A) }),
      cosSpawnedPids: () => new Map([[101, PROC_START_MS]]),
    }), DIRS)
    expect(scan.occupied.get(A)?.owners).toBe(1)
    expect(scan.occupied.get(A)?.foreignOwners).toBe(0)
  })

  it('marks a desktop-held thread as foreign, which is what blocks a write', () => {
    const scan = occupiedThreads('claude', [A], probes(registryWith({
      '101.json': rec(101, A),
    })), DIRS)
    expect(scan.occupied.get(A)?.owners).toBe(1)
    expect(scan.occupied.get(A)?.foreignOwners).toBe(1)
  })

  it('deduplicates ids so a repeated row is scanned once', () => {
    let reads = 0
    const scan = occupiedThreads('claude', [A, A, A], probes({
      readDir: () => { reads++; return ['101.json'] },
      readFile: () => rec(101, A),
    }), DIRS)
    expect(reads).toBe(1)
    expect(scan.occupied.size).toBe(1)
  })

  it('drops invalid ids before they reach a filesystem path', () => {
    // Reaches `codexLockPath` on the codex branch.
    const scan = occupiedThreads('claude', ['../../etc/passwd', '', 'nope'], probes(), DIRS)
    expect(scan.occupied.size).toBe(0)
    expect(scan.degraded).toBe(false)
  })

  it('returns nothing, undegraded, for a provider with no write path', () => {
    // Cursor is honestly unsupported, not a failure to report.
    const scan = occupiedThreads('cursor', [A], probes(), DIRS)
    expect(scan.occupied.size).toBe(0)
    expect(scan.degraded).toBe(false)
  })
})

describe('a hint fails the OPPOSITE way to the write gate', () => {
  // `threadOccupancy` fails CLOSED — doubt means refuse, because getting it wrong
  // costs someone's conversation. A hint that failed closed would paint every
  // session as running the moment a probe hiccuped. Doubt here means "unknown",
  // rendered as not-running, and the real gate still refuses at the write.
  it('an unreadable registry marks the scan degraded, not everything running', () => {
    const scan = occupiedThreads('claude', [A, B], probes({
      readDir: () => ['101.json'],
      readFile: () => null,     // unreadable
    }), DIRS)
    expect(scan.degraded).toBe(true)
    expect(scan.occupied.size).toBe(0)
  })

  it('a missing detector degrades rather than reporting everything free', () => {
    const scan = occupiedThreads('claude', [A], probes({ dirExists: () => false }), DIRS)
    expect(scan.degraded).toBe(true)
    expect(scan.occupied.size).toBe(0)
  })

  it('one thread throwing does not lose the others', () => {
    let n = 0
    const scan = occupiedThreads('claude', [A, B], probes({
      readDir: () => { n++; if (n === 1) throw new Error('EIO'); return ['102.json'] },
      readFile: () => rec(102, B),
    }), DIRS)
    expect(scan.degraded).toBe(true)
    expect(scan.occupied.has(B)).toBe(true)
  })

  it('never throws, whatever the probes do', () => {
    expect(() => occupiedThreads('claude', [A, B, C], probes({
      dirExists: () => { throw new Error('boom') },
      readDir: () => { throw new Error('boom') },
      readFile: () => { throw new Error('boom') },
    }), DIRS)).not.toThrow()
  })
})

describe('cost, which is the whole reason this module exists', () => {
  it('reads the registry directory EXACTLY once for many threads', () => {
    // The regression this guards, measured: reusing `claudeOwners` per thread
    // re-read the whole registry and re-ran `ps` per entry, costing 771ms across
    // 45 real sessions on this machine.
    //
    // Asserts exactly 1, not "<= n". The first version allowed three scans for
    // three threads, so it passed while the code did the very thing it was written
    // to prevent.
    let dirScans = 0
    occupiedThreads('claude', [A, B, C], probes({
      readDir: () => { dirScans++; return ['101.json', '102.json'] },
      readFile: (p: string) => (p.endsWith('101.json') ? rec(101, A) : rec(102, B)),
    }), DIRS)
    expect(dirScans).toBe(1)
  })

  it('runs ps at most once per pid, however many threads ask', () => {
    const psCalls: number[] = []
    occupiedThreads('claude', [A, B, C], probes({
      readDir: () => ['101.json', '102.json'],
      readFile: (p: string) => (p.endsWith('101.json') ? rec(101, A) : rec(102, B)),
      processStartMs: (pid: number) => { psCalls.push(pid); return PROC_START_MS },
    }), DIRS)
    expect(psCalls.length).toBe(new Set(psCalls).size)
  })

  it('reads each registry FILE once, not once per requested thread', () => {
    const reads: string[] = []
    occupiedThreads('claude', [A, B, C], probes({
      readDir: () => ['101.json'],
      readFile: (p: string) => { reads.push(p); return rec(101, A) },
    }), DIRS)
    expect(reads.length).toBe(1)
  })

  it('does no work at all for an empty list', () => {
    let touched = 0
    const scan = occupiedThreads('claude', [], probes({
      dirExists: () => { touched++; return true },
      readDir: () => { touched++; return [] },
    }), DIRS)
    expect(touched).toBe(0)
    expect(scan.degraded).toBe(false)
  })
})
