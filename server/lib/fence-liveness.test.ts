import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fenceLiveness, makePidStartProbe, START_MATCH_TOLERANCE_MS } from './fence-liveness.js'

const START = 1_700_000_000_000

describe('fenceLiveness', () => {
  it('reports none_running only when every recorded child is provably gone', () => {
    const v = fenceLiveness(
      [{ pid: 10, startMs: START }, { pid: 11, startMs: START }],
      { pidStartMs: () => null },
    )
    expect(v).toMatchObject({ state: 'none_running', recorded: 2, running: 0, unverifiable: 0 })
  })

  it('reports running when a live pid matches its recorded start', () => {
    const v = fenceLiveness([{ pid: 10, startMs: START }], { pidStartMs: () => START })
    expect(v.state).toBe('running')
    expect(v.running).toBe(1)
  })

  // The reason spawns records a start at all. FenceRecord: "a pid alone cannot be
  // distinguished from a recycled one."
  it('does not mistake a RECYCLED pid for our child', () => {
    const v = fenceLiveness(
      [{ pid: 10, startMs: START }],
      { pidStartMs: () => START + 60 * 60 * 1000 },  // same pid, an hour later
    )
    expect(v.state).toBe('none_running')
    expect(v.running).toBe(0)
    expect(v.recycled).toBe(1)
  })

  it('tolerates ps one-second rounding but not a real gap', () => {
    const near = fenceLiveness([{ pid: 10, startMs: START }],
      { pidStartMs: () => START + START_MATCH_TOLERANCE_MS - 1 })
    expect(near.state).toBe('running')
    const far = fenceLiveness([{ pid: 10, startMs: START }],
      { pidStartMs: () => START + START_MATCH_TOLERANCE_MS + 1 })
    expect(far.state).toBe('none_running')
    expect(far.recycled).toBe(1)
  })

  // FenceRecord: "An EMPTY list means no child was ever spawned, which no resolver
  // may ever read as 'nothing landed'."
  it('never reads an empty or missing spawn list as none_running', () => {
    for (const input of [[], undefined, null]) {
      const v = fenceLiveness(input, { pidStartMs: () => null })
      expect(v.state, JSON.stringify(input)).toBe('unknown')
      expect(v.recorded).toBe(0)
    }
  })

  it('fails closed when a probe throws', () => {
    const v = fenceLiveness(
      [{ pid: 10, startMs: START }],
      { pidStartMs: () => { throw new Error('ps unavailable') } },
    )
    expect(v.state).toBe('unknown')
    expect(v.unverifiable).toBe(1)
  })

  it('a live child outranks an unreadable probe', () => {
    // One certain "still writing" is worth more than one "cannot tell": the caller
    // is deciding whether to admit a second writer to the same transcript.
    const v = fenceLiveness(
      [{ pid: 10, startMs: START }, { pid: 11, startMs: START }],
      { pidStartMs: (pid) => { if (pid === 11) throw new Error('nope'); return START } },
    )
    expect(v.state).toBe('running')
    expect(v.running).toBe(1)
    expect(v.unverifiable).toBe(1)
  })

  it('treats a malformed spawn row as unverifiable, not as gone', () => {
    const v = fenceLiveness(
      [{ pid: 0, startMs: START }, { pid: 5, startMs: Number.NaN }],
      { pidStartMs: () => null },
    )
    expect(v.state).toBe('unknown')
    expect(v.unverifiable).toBe(2)
  })
})

describe('makePidStartProbe', () => {
  it('returns null for a pid that is not running', () => {
    expect(makePidStartProbe(() => null)(999)).toBeNull()
    expect(makePidStartProbe(() => '   ')(999)).toBeNull()
  })

  it('THROWS on unparseable output rather than reporting the child gone', () => {
    // Silently returning null here would read a live child as ended, which is the
    // one direction this whole module must not fail in.
    expect(() => makePidStartProbe(() => 'not a date')(10)).toThrow(/unparseable/)
  })

  // Execution against the real thing: `ps -o lstart=` is the only start-time
  // keyword macOS offers (`etimes` is not a valid keyword), so the format this
  // parses is worth pinning against the actual binary rather than a fixture.
  it('parses this very process out of real ps output', () => {
    const probe = makePidStartProbe((pid) => {
      try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' })
      } catch {
        return null
      }
    })
    const started = probe(process.pid)
    expect(started).not.toBeNull()
    // Within a day of now, and not in the future beyond ps's one-second rounding.
    expect(started as number).toBeLessThanOrEqual(Date.now() + 1_000)
    expect(started as number).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000)

    // And a pid that cannot exist reads as not running, not as a throw.
    expect(probe(0)).toBeNull()
  })
})
