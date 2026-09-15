import { describe, expect, it } from 'vitest'
import { type EngineScoreResult, runEngine, runEngineInWorker } from './worker.js'
import { LONG_RECORDING_S } from './split.js'
import { firefliesMeeting, g2Capture, matchingPair, phrase } from './__fixtures__/synthetic.js'

const START = Date.UTC(2026, 7, 20, 15, 0, 0)

describe('the engine end to end', () => {
  it('scores, groups and suggests in one pass', () => {
    const merged = matchingPair({ k: 120, sessionId: 's-auto', firefliesId: 'f-auto' })
    const weak = matchingPair({ k: 15, sessionId: 's-weak', firefliesId: 'f-weak', startMs: START + 7_200_000 })
    const result = runEngine({
      kind: 'score',
      g2: [merged.capture, weak.capture],
      fireflies: [merged.meeting, weak.meeting],
    }) as EngineScoreResult
    expect(result.tierCounts).toEqual({ auto_merge: 1, suggest: 1, none: 0 })
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ primaryFirefliesId: 'f-auto', sessionIds: ['s-auto'] })
    expect(result.suggestions).toEqual([{ kind: 'merge', sessionIds: ['s-weak'], firefliesIds: ['f-weak'], evidence: { K1: 15, K2: 0 } }])
  })

  it('splits a long recording instead of merging a capture into the whole of it', () => {
    const blocks = [phrase('first', 60, 60, 1800), phrase('second', 60, 2100, 1800)]
    const meeting = firefliesMeeting({ id: 'f-long', startMs: START, durationS: LONG_RECORDING_S + 600, phrases: blocks })
    const captures = blocks.map((block, i) => g2Capture({
      sessionId: `s${i}`,
      startMs: START + block.startS * 1000,
      durationMs: (block.endS - block.startS) * 1000,
      phrases: [block],
      offsetMs: 0,
    }))
    const result = runEngine({ kind: 'score', g2: captures, fireflies: [meeting] }) as EngineScoreResult
    expect(result.splits.map(plan => plan.firefliesId)).toEqual(['f-long'])
    expect(result.groups).toHaveLength(0)
  })
})

describe('the worker thread', () => {
  it('returns exactly what the same call returns in process', async () => {
    const { capture, meeting } = matchingPair({ k: 120 })
    const request = { kind: 'score' as const, g2: [capture], fireflies: [meeting] }
    const local = runEngine(request)
    const remote = await runEngineInWorker(request)
    expect(JSON.stringify(remote)).toBe(JSON.stringify(local))
  }, 60_000)

  it('renders a merged record over the thread too', async () => {
    const { capture, meeting } = matchingPair({ k: 120 })
    const remote = await runEngineInWorker({
      kind: 'derive_merge',
      input: { actionId: 'a_worker', tier: 'auto', primary: meeting, captures: [capture], evidence: { k1: 120, k2: 0 } },
    })
    expect(remote.kind).toBe('derive')
    if (remote.kind !== 'derive' || !remote.result.ok) throw new Error('expected a record')
    expect(remote.result.record.markdown).toContain('## Transcript')
  }, 60_000)

  it('carries the thread\'s own error back to the caller, not a generic one', async () => {
    // The message has to survive the thread boundary: "something failed" sends whoever is
    // debugging this to the wrong place.
    await expect(runEngineInWorker({ kind: 'nonsense' } as never))
      .rejects.toThrow(/unknown engine request kind: nonsense/)
  }, 60_000)
})
