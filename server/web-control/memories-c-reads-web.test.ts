/**
 * Memories C reads (the build after 7.0.43, F1 17:2x, S1's needsYou on the bridge status): the rail and Today show the one
 * Needs you number the Memories page shows. A null total shows no number (never a guess from the older fields); a server
 * without needsYou keeps the older lines. These run the real shell.js and app.js code. Placeholder numbers only.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeNeedsYou, dispatchMemoriesWebOp, type LoopbackFetchFn } from '../lib/web-memories-bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(HERE, p), 'utf8')
const SHELL = read('shell.js'), APP = read('app.js')

// The real rail story block from shell.js (loadStories, Memories), run on a status.
function rail(details: Record<string, unknown>): { text: string; hot: boolean } {
  const start = SHELL.indexOf('    // Memories (TodayHome.memoriesStory)')
  const end = SHELL.indexOf('    // Dictation lives on the Mac', start)
  expect(start, 'the rail Memories block').toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  let out = { text: '', hot: false }
  const fakeThen = (v: unknown) => ({ then: (fn: (x: unknown) => unknown) => fn(v) })
  // eslint-disable-next-line no-new-func
  new Function('soft', 'storyApi', 'setStory', 'FALLBACK', SHELL.slice(start, end))(
    (p: unknown) => p, () => fakeThen({ details }), (_n: string, text: string, hot: boolean) => { out = { text, hot } }, { memories: 'fallback' })
  return out
}

// The real Today status read from app.js (loadToday's memories extra), run on a status answer.
function todayRead(answer: unknown): Record<string, unknown> {
  const a = APP.indexOf("extras.push(api('/api/web-bridge/memories'")
  const s = APP.indexOf('.then(function (d) {', a), e = APP.indexOf('}, function () { TODAY.memories', s)
  expect(a, 'the Today memories read').toBeGreaterThan(0); expect(s).toBeGreaterThan(a); expect(e).toBeGreaterThan(s)
  const body = APP.slice(s + '.then(function (d) {'.length, e)
  const TODAY: Record<string, unknown> = { memories: { state: 'pending', n: 0 } }
  // eslint-disable-next-line no-new-func
  new Function('TODAY', 'd', body)(TODAY, answer)
  return TODAY.memories as Record<string, unknown>
}

const OLD = { learningToReview: 7, learningToReviewTotal: 41 }
const NY = (total: unknown, rest: Record<string, unknown> = { meetings: 17, decisions: 1, quarantineBatch: 1 }) => ({ ...OLD, needsYou: { ...rest, total } })

describe('the rail reads needsYou.total', () => {
  it('his numbers: 19 need you, not "Next 7 of 41"', () => {
    expect(rail(NY(19))).toEqual({ text: '19 need you', hot: true })
  })
  it('one, and none', () => {
    expect(rail(NY(1))).toEqual({ text: '1 needs you', hot: true })
    expect(rail(NY(0))).toEqual({ text: 'Nothing needs you', hot: false })
  })
  it('a null total shows no number, never the older fields', () => {
    expect(rail(NY(null, { meetings: null, decisions: 1, quarantineBatch: 1 }))).toEqual({ text: 'fallback', hot: false })
  })
  it('a total that is not a whole number reads as unknown', () => {
    for (const bad of [1.5, -1, '19', Number.NaN]) expect(rail(NY(bad)), String(bad)).toEqual({ text: 'fallback', hot: false })
  })
  it('a server without needsYou keeps the older line', () => {
    expect(rail(OLD)).toEqual({ text: 'Next 7 of 41', hot: true })
    expect(rail({ learningToReview: 3, learningToReviewTotal: 3 })).toEqual({ text: '3 to review', hot: true })
    expect(rail({ ...OLD, needsYou: [19] })).toEqual({ text: 'Next 7 of 41', hot: true })
  })
})

describe('Today reads needsYou.total', () => {
  it('his numbers: 19, with the parts', () => {
    const m = todayRead({ details: NY(19) })
    expect(m.state).toBe('answered'); expect(m.n).toBe(19)
    expect(m.ny).toEqual({ meetings: 17, decisions: 1, quarantineBatch: 1, total: 19 })
  })
  it('a null or broken total: could not read, marked partial, and no count', () => {
    for (const bad of [null, 1.5, -2, '19']) {
      const m = todayRead({ details: NY(bad) })
      expect(m, String(bad)).toEqual({ state: 'failed', n: 0, partial: true })
    }
  })
  it('a server without needsYou keeps learningToReview', () => {
    expect(todayRead({ details: OLD })).toEqual({ state: 'answered', n: 7 })
    expect(todayRead({ details: {} })).toEqual({ state: 'failed', n: 0 })
    expect(todayRead(null)).toEqual({ state: 'failed', n: 0 })
    // Q1 18:23 survivor: a needsYou that is an array is not the server's object, so the older field stays in charge.
    expect(todayRead({ details: { ...OLD, needsYou: [19] } })).toEqual({ state: 'answered', n: 7 })
  })
  it('a partial answer waits the minute before Today reads it again (no CLI on every paint)', () => {
    const cond = /if \(force === true \|\| Date\.now\(\) - TODAY\.extraAt > 60000 \|\| TODAY\.voices\.state === 'failed' \|\| \(TODAY\.memories\.state === 'failed' && !TODAY\.memories\.partial\)\) \{/
    expect(APP.match(new RegExp(cond.source, 'g'))?.length).toBe(1)
  })
})

describe('end to end with the server: the rail and Today show the server\'s sum', () => {
  const loopback: LoopbackFetchFn = async path => path === '/api/health'
    ? { status: 200, body: { server_version: '7.0.43' } }
    : { status: 200, body: { available: true, learning: { available: true, total: 90 }, memory: {}, threads: {}, graph: {} } }
  const HIS = { count: 41, limit: 7, gates: { prune_ready: 40, attribution: 1 }, items: [], bar: 0.8 }

  it('17 meetings, 1 decision and the batch: 19 everywhere', async () => {
    const out = await dispatchMemoriesWebOp('status', {}, loopback, 'x', async () => HIS, () => 17)
    expect(out.details.needsYou).toEqual(computeNeedsYou(HIS, 17))
    expect(rail(out.details)).toEqual({ text: '19 need you', hot: true })
    expect(todayRead({ details: out.details }).n).toBe(19)
  })
  it('meetings unreadable: no number on either', async () => {
    const out = await dispatchMemoriesWebOp('status', {}, loopback, 'x', async () => HIS, () => null)
    expect(rail(out.details).text).toBe('fallback')
    expect(todayRead({ details: out.details })).toEqual({ state: 'failed', n: 0, partial: true })
  })
})
