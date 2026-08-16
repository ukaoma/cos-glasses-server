import { describe, it, expect } from 'vitest'
import {
  CosSpawnLedger,
  MAX_SPAWN_START_AGE_MS,
  MAX_TRACKED_SPAWNS,
  SPAWN_ENTRY_TTL_MS,
  cosSpawnedPids,
  recordCosSpawn,
  releaseCosSpawn,
  type SpawnLedgerOptions,
} from './agent-session-ownership-store'
import { PROC_START_TOLERANCE_MS, threadOccupancy, type OccupancyProbes } from './thread-occupancy'

// Every value below was observed on this machine 2026-08-15 by spawning the
// providers exactly as the bridges do (`detached: true`, piped stdio). Fixture
// realism is load-bearing twice over: the pid/procStart pair is the real one
// Claude wrote for a COS-shaped `claude -p`, and both data roots are DOT
// directories, which is the class of production value a `mktemp` fixture
// structurally cannot express.
const CLAUDE_DIR = '/Users/ukaoma/.claude/sessions'
const CODEX_DIR = '/Users/ukaoma/.codex/thread-writer-locks'
const DIRS = { claudeSessionsDir: CLAUDE_DIR, codexLocksDir: CODEX_DIR }

const SID = '4baee514-fc15-4737-8011-8f7528b3d053'
const CODEX_THREAD = '01a00893-e8e5-7730-b5d9-0493fc4b26f5'
const PID = 98602
const CODEX_PID = 99301
const PROC_START_UTC = 'Sun Aug 16 03:15:43 2026'
/** Same instant as PROC_START_UTC. Local `ps` printed it as 22:15:43 CDT. */
const START_MS = Date.UTC(2026, 7, 16, 3, 15, 43)

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Render an epoch ms as Claude writes `procStart`: `ps lstart` layout, UTC
 * clock. Needed wherever a fixture has to keep the registry record and the live
 * process-start probe describing the SAME instant — changing one without the
 * other tests the registry's own mismatch guard instead of the ledger.
 */
function procStartUtc(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

/**
 * The literal `~/.claude/sessions/98602.json` written by a CLI `claude -p` that
 * this test suite's own probe spawned.
 *
 * `kind` and `entrypoint` are kept because they are the trap: the live DESKTOP
 * record for pid 7872 carries the identical pair. If a future change tries to
 * self-identify from a self-reported field, these values make it pass on a
 * desktop window too.
 */
function registryRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: PID,
    sessionId: SID,
    cwd: '/private/tmp',
    startedAt: 1786850143882,
    procStart: PROC_START_UTC,
    version: '2.1.229',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'claude-desktop',
    messagingSocketPath: `/tmp/cc-socks/${PID}.sock`,
    ...over,
  }
}

/** A live Claude owner of SID at PID. Only the ledger can make this attachable. */
function claudeProbes(
  cosSpawned: () => ReadonlyMap<number, number>,
  over: Partial<OccupancyProbes> = {},
): OccupancyProbes {
  return {
    isAlive: () => true,
    processStartMs: () => START_MS,
    fileExists: () => true,
    dirExists: () => true,
    readDir: () => [`${PID}.json`],
    readFile: () => JSON.stringify(registryRecord()),
    lockHolders: () => [],
    cosSpawnedPids: cosSpawned,
    ...over,
  }
}

/** A live Codex owner of CODEX_THREAD, holding the writer lock at CODEX_PID. */
function codexProbes(
  cosSpawned: () => ReadonlyMap<number, number>,
  over: Partial<OccupancyProbes> = {},
): OccupancyProbes {
  return {
    isAlive: () => true,
    processStartMs: () => START_MS,
    fileExists: () => true,
    dirExists: () => true,
    readDir: () => [],
    readFile: () => null,
    lockHolders: () => [CODEX_PID],
    cosSpawnedPids: cosSpawned,
    ...over,
  }
}

/**
 * The only assertion that means anything here.
 *
 * The ledger has no user-visible behavior of its own — its entire purpose is to
 * move `threadOccupancy` from "occupied by a live desktop process" to
 * "attachable". Asserting on `snapshot()` contents alone would pin the
 * intermediate value and could pass while the verdict was wrong in either
 * direction, which is the exact test failure this project has shipped before.
 */
function verdict(probes: OccupancyProbes, provider = 'claude', id = SID) {
  const o = threadOccupancy(provider, id, probes, DIRS)
  return { attachable: o.attachable, reason: o.reason, selfOwned: o.owners.map(owner => owner.selfOwned) }
}

const OCCUPIED = { attachable: false, reason: 'live_desktop_process', selfOwned: [false] }
const ATTACHABLE = { attachable: true, reason: null, selfOwned: [true] }

function fresh(options: SpawnLedgerOptions = {}) {
  let t = START_MS + 5
  const ledger = new CosSpawnLedger({ now: () => t, ...options })
  return {
    ledger,
    advance: (ms: number) => { t += ms },
    set: (ms: number) => { t = ms },
    now: () => t,
  }
}

describe('the ledger is what makes a live owner attachable', () => {
  it('leaves a live owner occupied when nothing was recorded', () => {
    const { ledger } = fresh()
    expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(OCCUPIED)
  })

  it('turns our own spawn attachable once recorded', () => {
    const { ledger } = fresh()
    expect(ledger.record(PID, START_MS)).toBe('recorded')
    expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(ATTACHABLE)
  })

  it('does the same for a Codex writer-lock holder', () => {
    const { ledger } = fresh()
    expect(verdict(codexProbes(() => ledger.snapshot()), 'codex', CODEX_THREAD))
      .toEqual(OCCUPIED)
    expect(ledger.record(CODEX_PID, START_MS)).toBe('recorded')
    expect(verdict(codexProbes(() => ledger.snapshot()), 'codex', CODEX_THREAD))
      .toEqual(ATTACHABLE)
  })

  it('claims only the pid it was given', () => {
    const { ledger } = fresh()
    ledger.record(PID + 1, START_MS)
    expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(OCCUPIED)
  })

  it('re-occupies the thread after release', () => {
    const { ledger } = fresh()
    ledger.record(PID, START_MS)
    expect(ledger.release(PID)).toBe(true)
    expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(OCCUPIED)
  })

  it('releasing an unrelated pid does not disturb the claim', () => {
    const { ledger } = fresh()
    ledger.record(PID, START_MS)
    expect(ledger.release(PID + 1)).toBe(false)
    expect(ledger.release('98602')).toBe(false)
    expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(ATTACHABLE)
  })
})

describe('a bare pid is not an identity', () => {
  it('refuses the claim when the pid was recycled into a different process', () => {
    // We spawned 98602 and it died. Three hours later the OS handed 98602 to
    // someone's desktop Claude, which now owns SID. A Set-of-pids ledger says
    // "ours" here; the start time is what says otherwise.
    const { ledger } = fresh()
    expect(ledger.record(PID, START_MS)).toBe('recorded')

    const recycledStart = START_MS + 3 * 60 * 60_000
    const probes = claudeProbes(() => ledger.snapshot(), {
      processStartMs: () => recycledStart,
      readFile: () => JSON.stringify(registryRecord({ procStart: 'Sun Aug 16 06:15:43 2026' })),
    })
    expect(verdict(probes)).toEqual(OCCUPIED)
  })

  it('tolerates one-second start resolution but not a different process', () => {
    const { ledger } = fresh()
    ledger.record(PID, START_MS)

    const near = claudeProbes(() => ledger.snapshot(), {
      processStartMs: () => START_MS + (PROC_START_TOLERANCE_MS - 100),
    })
    expect(verdict(near).attachable).toBe(true)

    // The registry and the probe agree the live process started later, so the
    // only disagreement left is with the ledger — which is the guard under test.
    const laterStart = START_MS + PROC_START_TOLERANCE_MS + 1_500
    const far = claudeProbes(() => ledger.snapshot(), {
      processStartMs: () => laterStart,
      readFile: () => JSON.stringify(registryRecord({ procStart: procStartUtc(laterStart) })),
    })
    expect(verdict(far)).toEqual(OCCUPIED)
  })

  it('cannot self-identify when the live start is unknowable', () => {
    // `processStartMs` returning null is the probe saying "I could not tell".
    // That must not resolve to "close enough".
    const { ledger } = fresh()
    ledger.record(PID, START_MS)
    const probes = claudeProbes(() => ledger.snapshot(), { processStartMs: () => null })
    expect(verdict(probes).attachable).toBe(false)
  })

  it('overwrites a stale entry when the same pid is spawned again', () => {
    const clock = fresh()
    clock.ledger.record(PID, START_MS)

    const laterStart = START_MS + 10 * 60_000
    clock.set(laterStart + 5)
    expect(clock.ledger.record(PID, laterStart)).toBe('recorded')

    const nowLive = claudeProbes(() => clock.ledger.snapshot(), {
      processStartMs: () => laterStart,
      readFile: () => JSON.stringify(registryRecord({ procStart: 'Sun Aug 16 03:25:43 2026' })),
    })
    expect(verdict(nowLive).attachable).toBe(true)

    // And the superseded start no longer vouches for anything.
    const stillOld = claudeProbes(() => clock.ledger.snapshot(), { processStartMs: () => START_MS })
    expect(verdict(stillOld).attachable).toBe(false)
  })
})

describe('malformed claims are refused rather than stored', () => {
  const badPids: Array<[string, unknown]> = [
    ['zero', 0],
    ['negative (a process GROUP in kill semantics)', -PID],
    ['minus one', -1],
    ['fractional', 98602.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined, which ProviderProcessMetadata.pid permits', undefined],
    ['null', null],
    ['numeric string', '98602'],
    ['beyond any pid space', 2 ** 31],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ]

  for (const [label, pid] of badPids) {
    it(`rejects a pid that is ${label}`, () => {
      const { ledger } = fresh()
      expect(ledger.record(pid, START_MS)).toBe('rejected_pid')
      expect(ledger.snapshot().size).toBe(0)
    })
  }

  it('refuses to vouch for the server process itself', () => {
    const { ledger } = fresh()
    expect(ledger.record(process.pid, START_MS)).toBe('rejected_self_pid')
    expect(ledger.snapshot().has(process.pid)).toBe(false)
  })

  const badStarts: Array<[string, unknown]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -1],
    ['undefined', undefined],
    ['null', null],
    ['a date string', '2026-08-16T03:15:43Z'],
  ]

  for (const [label, startMs] of badStarts) {
    it(`rejects a start time that is ${label}`, () => {
      const { ledger } = fresh()
      expect(ledger.record(PID, startMs)).toBe('rejected_start')
      expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(OCCUPIED)
    })
  }

  it('rejects a start old enough to describe a process we did not just spawn', () => {
    const clock = fresh()
    clock.set(START_MS + MAX_SPAWN_START_AGE_MS + 1)
    expect(clock.ledger.record(PID, START_MS)).toBe('rejected_start_not_recent')
    expect(verdict(claudeProbes(() => clock.ledger.snapshot()))).toEqual(OCCUPIED)
  })

  it('accepts a start inside the recency window', () => {
    const clock = fresh()
    clock.set(START_MS + MAX_SPAWN_START_AGE_MS - 1)
    expect(clock.ledger.record(PID, START_MS)).toBe('recorded')
  })

  it('rejects a start in the future beyond clock skew', () => {
    const clock = fresh()
    clock.set(START_MS - (PROC_START_TOLERANCE_MS + 1_000))
    expect(clock.ledger.record(PID, START_MS)).toBe('rejected_start_not_recent')
    expect(verdict(claudeProbes(() => clock.ledger.snapshot()))).toEqual(OCCUPIED)
  })
})

describe('retention is bounded, and the bound fails closed', () => {
  it('drops the claim once the TTL passes, leaving our own child looking foreign', () => {
    const clock = fresh()
    clock.ledger.record(PID, START_MS)
    expect(verdict(claudeProbes(() => clock.ledger.snapshot())).attachable).toBe(true)

    clock.advance(SPAWN_ENTRY_TTL_MS)
    expect(verdict(claudeProbes(() => clock.ledger.snapshot()))).toEqual(OCCUPIED)
    expect(clock.ledger.stats().evictedExpired).toBeGreaterThan(0)
  })

  it('keeps the claim for the longest legitimate provider run', () => {
    // 21 minutes is the `providerTimeoutMs` default; a run that long must not
    // lose its own identity mid-flight.
    const clock = fresh()
    clock.ledger.record(PID, START_MS)
    clock.advance(21 * 60_000)
    expect(verdict(claudeProbes(() => clock.ledger.snapshot())).attachable).toBe(true)
  })

  it('treats a backwards clock as expiry, not as extra life', () => {
    const clock = fresh()
    clock.ledger.record(PID, START_MS)
    clock.advance(-1)
    expect(verdict(claudeProbes(() => clock.ledger.snapshot()))).toEqual(OCCUPIED)
  })

  it('never exceeds the shipped capacity, evicting the oldest first', () => {
    const clock = fresh()
    const firstPid = 1_000
    for (let i = 0; i < MAX_TRACKED_SPAWNS + 8; i++) {
      clock.advance(1)
      expect(clock.ledger.record(firstPid + i, clock.now())).toBe('recorded')
    }
    const snap = clock.ledger.snapshot()
    expect(snap.size).toBeLessThanOrEqual(MAX_TRACKED_SPAWNS)
    expect(snap.has(firstPid)).toBe(false)
    expect(snap.has(firstPid + MAX_TRACKED_SPAWNS + 7)).toBe(true)
    expect(clock.ledger.stats().evictedCapacity).toBeGreaterThan(0)
  })

  it('an evicted pid stops being ours', () => {
    const clock = fresh({ maxEntries: 2 })
    clock.ledger.record(PID, START_MS)
    expect(verdict(claudeProbes(() => clock.ledger.snapshot())).attachable).toBe(true)

    clock.advance(1)
    clock.ledger.record(PID + 1, clock.now())
    clock.advance(1)
    clock.ledger.record(PID + 2, clock.now())

    expect(verdict(claudeProbes(() => clock.ledger.snapshot()))).toEqual(OCCUPIED)
  })

  it('overwriting a live entry does not evict a peer', () => {
    const clock = fresh({ maxEntries: 2 })
    clock.ledger.record(PID, START_MS)
    clock.advance(1)
    clock.ledger.record(CODEX_PID, clock.now())

    clock.advance(1)
    expect(clock.ledger.record(CODEX_PID, clock.now())).toBe('recorded')
    expect(verdict(claudeProbes(() => clock.ledger.snapshot())).attachable).toBe(true)
  })
})

describe('the ledger cannot be written from the outside', () => {
  it('hands out a copy, so a mutated snapshot forges nothing', () => {
    const { ledger } = fresh()
    const stolen = ledger.snapshot() as Map<number, number>
    stolen.set(PID, START_MS)

    expect(ledger.snapshot().has(PID)).toBe(false)
    expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(OCCUPIED)
  })

  it('gives each scan its own map', () => {
    const { ledger } = fresh()
    ledger.record(PID, START_MS)
    const first = ledger.snapshot() as Map<number, number>
    first.delete(PID)
    expect(ledger.snapshot().has(PID)).toBe(true)
  })
})

describe('internal failure resolves to "nothing is ours"', () => {
  it('returns an empty ledger instead of throwing when the clock fails', () => {
    let broken = false
    let t = START_MS + 5
    const ledger = new CosSpawnLedger({
      now: () => {
        if (broken) throw new Error('clock probe failed')
        return t
      },
    })
    expect(ledger.record(PID, START_MS)).toBe('recorded')
    broken = true

    expect(() => ledger.snapshot()).not.toThrow()
    expect(ledger.snapshot().size).toBe(0)
    // The whole scan must survive: a local failure here denies self-ownership
    // without collapsing the Claude registry evidence into `probe_failed`.
    expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(OCCUPIED)
    expect(ledger.stats().snapshotFailures).toBeGreaterThan(0)
  })

  it('rejects rather than throws when the clock fails during record', () => {
    const ledger = new CosSpawnLedger({ now: () => { throw new Error('clock probe failed') } })
    expect(ledger.record(PID, START_MS)).toBe('rejected_internal')
    expect(ledger.snapshot().size).toBe(0)
  })

  it('separates an idle ledger from a broken one', () => {
    // Both answer "no owners of ours". Only `stats` says which, and an operator
    // needs that to tell a quiet install from a failing probe.
    const idle = fresh().ledger
    expect(idle.snapshot().size).toBe(0)
    expect(idle.stats().snapshotFailures).toBe(0)

    const brokenLedger = new CosSpawnLedger({ now: () => { throw new Error('clock probe failed') } })
    expect(brokenLedger.snapshot().size).toBe(0)
    expect(brokenLedger.stats().snapshotFailures).toBeGreaterThan(0)
  })

  it('counts why claims were refused', () => {
    const { ledger } = fresh()
    ledger.record(0, START_MS)
    ledger.record(PID, Number.NaN)
    const stats = ledger.stats()
    expect(stats.rejected).toBe(2)
    expect(stats.lastRejection).toBe('rejected_start')
    expect(stats.tracked).toBe(0)
  })
})

describe('the ledger does not survive a server restart', () => {
  it('a still-live detached child is foreign to the new process', () => {
    // Bridges spawn with `detached: true`, so the child can outlive us. The new
    // server cannot control it, so treating it as ours would be wrong as well
    // as unsafe.
    const before = fresh()
    before.ledger.record(PID, START_MS)
    expect(verdict(claudeProbes(() => before.ledger.snapshot())).attachable).toBe(true)

    const afterRestart = fresh()
    expect(verdict(claudeProbes(() => afterRestart.ledger.snapshot()))).toEqual(OCCUPIED)
  })

  it('clear() drops every claim', () => {
    const { ledger } = fresh()
    ledger.record(PID, START_MS)
    ledger.clear()
    expect(verdict(claudeProbes(() => ledger.snapshot()))).toEqual(OCCUPIED)
  })
})

describe('the exported probe is wired to the process-wide ledger', () => {
  // Exercises the shipped Date.now clock, which every injected-clock test above
  // bypasses.
  it('records and releases through the module-level functions', () => {
    const pid = 424_242
    try {
      expect(cosSpawnedPids().has(pid)).toBe(false)
      // Whole seconds, because `procStart` has one-second resolution and this
      // fixture has to describe one instant in both formats.
      const startMs = Math.floor(Date.now() / 1000) * 1000
      expect(recordCosSpawn(pid, startMs)).toBe('recorded')

      const snapshot = cosSpawnedPids()
      expect(snapshot.get(pid)).toBe(startMs)

      const probes = claudeProbes(cosSpawnedPids, {
        readDir: () => [`${pid}.json`],
        readFile: () => JSON.stringify(registryRecord({ pid, procStart: procStartUtc(startMs) })),
        processStartMs: () => startMs,
      })
      expect(verdict(probes).attachable).toBe(true)

      expect(releaseCosSpawn(pid)).toBe(true)
      expect(verdict(probes)).toEqual(OCCUPIED)
    } finally {
      releaseCosSpawn(pid)
    }
  })
})
