import { describe, expect, it } from 'vitest'
import { dedupeChats } from './repair-archive-duplicates.js'

/**
 * The repair script's one piece of logic, isolated. Everything else in that file
 * is I/O guarded behind --apply.
 *
 * NOTE the shape of these fixtures: duplicates are ordered with the LONGER copy
 * FIRST wherever completeness is under test. With it last, a naive last-wins
 * dedup satisfies the assertion by accident and the test cannot fail — which is
 * exactly what mutation testing exposed in the sibling archive-dedup suite.
 */
const chat = (sessionId: string, startedAt: number, exchangeCount = 2, id = 0) =>
  ({ id, sessionId, startedAt, exchangeCount, endedAt: startedAt + 1_000, summary: '' })

describe('dedupeChats', () => {
  it('collapses the boot-loop shape: one chat repeated N times', () => {
    const dupes = Array.from({ length: 2_388 }, (_, i) => chat('sess-a', 1_000, 2, i))
    const { kept, removed } = dedupeChats(dupes)
    expect(kept).toHaveLength(1)
    expect(removed).toBe(2_387)
  })

  it('THE CONTROL: leaves a clean day untouched', () => {
    const clean = [chat('a', 1_000), chat('b', 2_000), chat('c', 3_000)]
    const { kept, removed } = dedupeChats(clean)
    expect(kept).toHaveLength(3)
    expect(removed).toBe(0)
  })

  it('keeps the MOST COMPLETE copy, not the first or last seen', () => {
    const { kept } = dedupeChats([
      chat('a', 1_000, 9),   // longest, deliberately FIRST
      chat('a', 1_000, 2),
      chat('a', 1_000, 5),
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0].exchangeCount).toBe(9)
  })

  it('does not merge two chats of the same session with different start times', () => {
    const { kept } = dedupeChats([chat('a', 1_000), chat('a', 7_000)])
    expect(kept).toHaveLength(2)
  })

  it('does not merge different sessions that started at the same instant', () => {
    const { kept } = dedupeChats([chat('a', 1_000), chat('b', 1_000)])
    expect(kept).toHaveLength(2)
  })

  it('renumbers ids contiguously and orders by start time', () => {
    const { kept } = dedupeChats([chat('c', 9_000, 2, 77), chat('a', 1_000, 2, 4), chat('b', 5_000, 2, 12)])
    expect(kept.map(c => c.id)).toEqual([0, 1, 2])
    expect(kept.map(c => c.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('is idempotent — repairing an already-clean list changes nothing', () => {
    const once = dedupeChats([chat('a', 1_000, 9), chat('a', 1_000, 2), chat('b', 2_000)])
    const twice = dedupeChats(once.kept)
    expect(twice.removed).toBe(0)
    expect(twice.kept).toEqual(once.kept)
  })

  it('handles an empty list without throwing', () => {
    expect(dedupeChats([]).kept).toEqual([])
  })
})
