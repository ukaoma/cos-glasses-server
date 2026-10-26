// 6.92.0 (plan r3, A-W0c): the offline eval harnesses. Nothing here runs a model: the case counts are
// pinned, and each harness's default --max-calls is at least the calls its default run makes, so a
// default run never refuses itself (the custom-polish run was 201 calls against a 200 default, and
// the format canary 45 against 40).
import { describe, expect, it } from 'vitest'
import { CASES, REPEAT_IDS } from './dictation-polish-eval.js'
import { CANARY, FORMAT_DEFAULT_MAX_CALLS } from './dictation-format-eval.js'
import { CUSTOM_POLISH_DEFAULT_MAX_CALLS, LITERAL_CASES, PROBES, STYLE_CASES, STYLE_PROBES, jobs } from './dictation-custom-polish-eval.js'

describe('6.92.0 dictation eval harness limits', () => {
  it('case counts are pinned', () => {
    expect(CASES).toHaveLength(50)
    const byCategory: Record<string, number> = {}
    for (const c of CASES) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1
    expect(byCategory).toEqual({ filler: 12, backtrack: 11, format: 6, names: 6, preserve: 15 })
    expect(REPEAT_IDS).toHaveLength(15)
    expect(CANARY).toHaveLength(45)
    expect(PROBES).toHaveLength(9)
    expect(jobs()).toHaveLength(201)
    expect([STYLE_CASES.length, STYLE_PROBES.length, LITERAL_CASES.length]).toEqual([4, 2, 3])
  })

  it('the custom-polish default fits its cap', () => {
    expect(CUSTOM_POLISH_DEFAULT_MAX_CALLS).toBe(205)
    expect(jobs().length).toBeLessThanOrEqual(CUSTOM_POLISH_DEFAULT_MAX_CALLS)
  })

  it('the format default --max-calls is at least the number of cases of every set', () => {
    expect(FORMAT_DEFAULT_MAX_CALLS).toBe(50)
    const preserve = CASES.filter(c => c.category === 'preserve').length
    for (const n of [CANARY.length, CASES.length, preserve]) expect(n).toBeLessThanOrEqual(FORMAT_DEFAULT_MAX_CALLS)
  })

  it('the style and literal suites fit the 40-call default (k=3)', () => {
    const style = 2 * 3 * STYLE_CASES.length + 3 * STYLE_PROBES.length
    const literal = 3 * LITERAL_CASES.length
    expect([style, literal]).toEqual([30, 9])
    expect(Math.max(style, literal)).toBeLessThanOrEqual(40)
  })
})
