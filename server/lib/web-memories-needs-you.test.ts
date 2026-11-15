/**
 * The build after 7.0.42 (Memories C, lead 2026-11-14 15:49): status `needsYou`, the one number the rail, Today and the
 * Memories page all show. F1's option (a): the 11-08 predicate is unchanged, prune counts as one batch, cues count by
 * meeting. Placeholder words only.
 */
import { describe, expect, it } from 'vitest'
import { computeNeedsYou, dispatchMemoriesWebOp, NEEDS_YOU_CUE_DAYS, type LoopbackFetchFn } from './web-memories-bridge.js'

// His Mac on 2026-11-14 (F1's plan): 41 needing review, 40 of them prune_ready and 1 attribution; 17 meetings to rate.
const HIS = { count: 41, limit: 7, gates: { prune_ready: 40, attribution: 1 }, items: [], bar: 0.8 }

describe('computeNeedsYou', () => {
  it('his numbers: 17 meetings + 1 decision + 1 quarantine batch = 19', () => {
    expect(computeNeedsYou(HIS, 17)).toMatchObject({ meetings: 17, decisions: 1, quarantineBatch: 1, total: 19 })
  })

  it('prune counts as one batch however many wait, and none when none wait', () => {
    expect(computeNeedsYou({ count: 5, gates: { prune_ready: 5 } }, 0)).toMatchObject({ meetings: 0, decisions: 0, quarantineBatch: 1, total: 1 })
    expect(computeNeedsYou({ count: 3, gates: { attribution: 2, rule_ready: 1 } }, 2)).toMatchObject({ meetings: 2, decisions: 3, quarantineBatch: 0, total: 5 })
    expect(computeNeedsYou({ count: 0, gates: {} }, 0)).toMatchObject({ meetings: 0, decisions: 0, quarantineBatch: 0, total: 0 })
  })

  it('decisions count past the shown cap (the producer\'s count), not the shown items', () => {
    const shownSeven = { count: 30, limit: 7, gates: { scope: 30 }, items: Array.from({ length: 7 }, (_, i) => ({ lesson_id: `l${i}`, gate: 'scope' })) }
    expect(computeNeedsYou(shownSeven, 0).decisions).toBe(30)
  })

  it('a part it cannot read is null, and so is the total: no number built from a guess', () => {
    expect(computeNeedsYou(HIS, null)).toMatchObject({ meetings: null, decisions: 1, quarantineBatch: 1, total: null })
    expect(computeNeedsYou(null, 17)).toMatchObject({ meetings: 17, decisions: null, quarantineBatch: null, total: null })
    // A block without gates cannot be split into decisions and the batch.
    expect(computeNeedsYou({ count: 41 }, 17)).toMatchObject({ meetings: 17, decisions: null, quarantineBatch: null, total: null })
    expect(computeNeedsYou({ count: 41, gates: [] as unknown as Record<string, number> }, 17).total).toBeNull()
    // A meetings count that is not a whole number reads as unknown.
    for (const bad of [-1, 1.5, Number.NaN]) expect(computeNeedsYou(HIS, bad).meetings).toBeNull()
  })

  it('a malformed prune_ready count reads as none, never as a negative', () => {
    for (const bad of [-3, 2.5, '40']) expect(computeNeedsYou({ count: 41, gates: { prune_ready: bad as unknown as number } }, 0)).toMatchObject({ meetings: 0, decisions: 41, quarantineBatch: 0, total: 41 })
    expect(computeNeedsYou({ count: 2, gates: { prune_ready: 5 } }, 0).decisions).toBe(0)
  })
})

describe('status carries needsYou beside the old fields', () => {
  const loopback: LoopbackFetchFn = async path => path === '/api/health'
    ? { status: 200, body: { server_version: '7.0.42' } }
    : { status: 200, body: { available: true, learning: { available: true, total: 90 }, memory: {}, threads: {}, graph: {} } }

  it('reads the meetings count with the 7-day window and keeps learningToReview for older clients', async () => {
    let asked = 0
    const out = await dispatchMemoriesWebOp('status', {}, loopback, 'x', async () => HIS, () => { asked += 1; return 17 })
    expect(out.details.needsYou).toMatchObject({ meetings: 17, decisions: 1, quarantineBatch: 1, total: 19 })
    expect(asked).toBe(1)
    expect(out.details.learningToReview).toBe(0)        // the shown open items: unchanged behaviour
    expect(out.details.learningToReviewTotal).toBe(41)  // unchanged
    expect(NEEDS_YOU_CUE_DAYS).toBe(7)
  })

  it('a meetings counter that throws or a needs-you reader that fails leaves the total null, and status still answers', async () => {
    const thrown = await dispatchMemoriesWebOp('status', {}, loopback, 'x', async () => HIS, () => { throw new Error('verdicts unreadable') })
    expect(thrown.ok).toBe(true)
    expect(thrown.details.needsYou).toMatchObject({ meetings: null, decisions: 1, quarantineBatch: 1, total: null })
    const noBlock = await dispatchMemoriesWebOp('status', {}, loopback, 'x', async () => null, () => 4)
    expect(noBlock.details.needsYou).toMatchObject({ meetings: 4, decisions: null, quarantineBatch: null, total: null })
  })
})
