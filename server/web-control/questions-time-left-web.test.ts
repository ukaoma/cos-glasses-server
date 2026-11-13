/**
 * 7.0.32 (X1's parity ask 1, with the 8-hour question wait): the time left on a waiting question reads hours and
 * minutes from one hour on, so an 8-hour question shows "7 h 59 m left", not "480 min left". Runs questions.js's own
 * timeLeft.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes/questions.js'), 'utf8')
const start = SRC.indexOf('  function timeLeft(s) {'), end = SRC.indexOf('\n  }\n', start)
// eslint-disable-next-line no-new-func
const timeLeft = new Function(SRC.slice(start, end + 4) + '\nreturn timeLeft;')() as (s: number) => string

describe('questions.js timeLeft: hours and minutes from one hour', () => {
  it('an 8-hour question reads hours and minutes, rounded down', () => {
    expect(start).toBeGreaterThan(-1)
    expect(timeLeft(8 * 3600)).toBe('8 h left')
    expect(timeLeft(8 * 3600 - 1)).toBe('7 h 59 m left')
    expect(timeLeft(7 * 3600 + 59 * 60 + 59)).toBe('7 h 59 m left')
    expect(timeLeft(3600)).toBe('1 h left')
    expect(timeLeft(3600 + 60)).toBe('1 h 1 m left')
  })
  it('under an hour it reads as before: minutes from 100 s, seconds below', () => {
    expect(timeLeft(3599)).toBe('60 min left')
    expect(timeLeft(600)).toBe('10 min left')
    expect(timeLeft(100)).toBe('2 min left')
    expect(timeLeft(99)).toBe('99 s left')
    expect(timeLeft(5)).toBe('5 s left')
  })
  it('never says "480 min" or more minutes than an hour', () => {
    for (const s of [3600, 7200, 28799, 28800]) expect(timeLeft(s)).not.toMatch(/min/)
  })
})
