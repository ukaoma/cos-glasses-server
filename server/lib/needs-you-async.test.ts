/**
 * The build after 7.0.46 (lead 2026-11-14 22:0x; Work card task:personal:ce1f04b2f016): the Needs you count answers at
 * once. The status op never waits on `learning_events.py needs-you` (10 s or more on a loaded Mac); the reader refreshes
 * in the background inside the TTL, keeps the last good block on disk with a one-hour cap, and says 'not_set_up' only
 * when COS_SCRIPTS_DIR is unset. Fake CLI runs, temp files, an injected clock. Placeholder words only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dataPath } from './data-dir.js'
import { createNeedsYouReader, NEEDS_YOU_FILE, NEEDS_YOU_SHOW_LIMIT_MS, NEEDS_YOU_TIMEOUT_MS, NEEDS_YOU_TTL_MS, type NeedsYouPeek } from './learning-needs-you.js'
import { computeNeedsYou, dispatchMemoriesWebOp, type LoopbackFetchFn } from './web-memories-bridge.js'

const T0 = Date.parse('2026-11-14T22:00:00.000Z')
const BLOCK = { count: 41, limit: 7, gates: { prune_ready: 40, attribution: 1 }, items: [], bar: 0.8 }
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })
/** A scripts dir with cos_python and learning_events.py present (their contents never run: `run` is faked). */
function scripts(withPython = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'needs-you-async-')); roots.push(dir)
  if (withPython) writeFileSync(join(dir, 'cos_python'), '')
  writeFileSync(join(dir, 'learning_events.py'), '')
  return dir
}
const ok = (block: unknown = BLOCK) => async () => ({ code: 0, stdout: JSON.stringify(block) })
const flush = () => new Promise(r => setTimeout(r, 0))

describe('peek: what the status op shows at once', () => {
  it('not_set_up only when COS_SCRIPTS_DIR is unset; nothing runs', () => {
    for (const scriptsDir of [null, '']) {
      let runs = 0
      const r = createNeedsYouReader({ scriptsDir, run: async () => { runs += 1; return { code: 0, stdout: '{}' } } })
      expect(r.peek()).toEqual({ state: 'not_set_up' })
      expect(runs).toBe(0)
    }
  })

  it('every other failure is unknown, never not_set_up: no cos_python, a non-zero exit, a timeout, bad JSON, a crash', async () => {
    const cases: Array<[string, NonNullable<Parameters<typeof createNeedsYouReader>[0]>['run']]> = [
      [scripts(false), ok()],                                                 // the directory is set, cos_python is not there
      [scripts(), async () => ({ code: 1, stdout: JSON.stringify(BLOCK) })],  // a non-zero exit
      [scripts(), async () => ({ code: 143, stdout: '' })],                   // killed at the time limit
      [scripts(), async () => ({ code: 0, stdout: 'not json' })],             // bad JSON
      [scripts(), async () => { throw new Error('spawn failed') }],           // the spawn itself fails
    ]
    for (const [scriptsDir, run] of cases) {
      const r = createNeedsYouReader({ scriptsDir, run })
      expect(r.peek().state).toBe('unknown')
      await flush()
      expect(r.peek()).toEqual({ state: 'unknown' })
    }
  })

  it('never waits: a CLI that never answers still gives an immediate unknown, and the read is started once', async () => {
    let runs = 0
    const r = createNeedsYouReader({ scriptsDir: scripts(), run: () => { runs += 1; return new Promise(() => {}) } })
    const t = Date.now()
    expect(r.peek()).toEqual({ state: 'unknown' })
    expect(r.peek()).toEqual({ state: 'unknown' })
    expect(Date.now() - t).toBeLessThan(50)
    expect(runs).toBe(1)   // single flight
  })

  it('the background read uses the TTL-derived limit, then the block shows with its read time', async () => {
    let clock = T0
    const limits: number[] = []
    const r = createNeedsYouReader({ scriptsDir: scripts(), now: () => clock, run: async (_f, _a, ms) => { limits.push(ms); return ok()() } })
    expect(r.peek().state).toBe('unknown')
    await flush()
    expect(limits).toEqual([NEEDS_YOU_TIMEOUT_MS])
    expect(r.peek()).toMatchObject({ state: 'ok', at: T0, block: { count: 41 } })
  })

  it('refreshes only once the block is past the TTL, and keeps showing it meanwhile', async () => {
    let clock = T0, runs = 0
    const r = createNeedsYouReader({ scriptsDir: scripts(), now: () => clock, run: async () => { runs += 1; return ok()() } })
    r.peek(); await flush()
    expect(runs).toBe(1)
    clock = T0 + NEEDS_YOU_TTL_MS - 1
    expect(r.peek().state).toBe('ok'); await flush()
    expect(runs).toBe(1)
    clock = T0 + NEEDS_YOU_TTL_MS
    expect(r.peek()).toMatchObject({ state: 'ok', at: T0 }); await flush()
    expect(runs).toBe(2)
    expect(r.peek()).toMatchObject({ state: 'ok', at: T0 + NEEDS_YOU_TTL_MS })
  })

  it('a failed refresh keeps the last good block until the one-hour cap, then shows unknown', async () => {
    let clock = T0, good = true
    const r = createNeedsYouReader({ scriptsDir: scripts(), now: () => clock, run: async () => (good ? ok()() : { code: 1, stdout: '' }) })
    r.peek(); await flush()
    good = false
    clock = T0 + NEEDS_YOU_SHOW_LIMIT_MS
    expect(r.peek()).toMatchObject({ state: 'ok', at: T0 }); await flush()
    clock = T0 + NEEDS_YOU_SHOW_LIMIT_MS + 1
    expect(r.peek()).toEqual({ state: 'unknown' })
  })
})

describe('the last good block on disk', () => {
  function file() { const d = mkdtempSync(join(tmpdir(), 'needs-you-file-')); roots.push(d); return join(d, 'learning-needs-you.json') }

  it('a good read is saved (0600) and a new reader, as after an install, shows it at once with its age', async () => {
    const f = file()
    let clock = T0
    const first = createNeedsYouReader({ scriptsDir: scripts(), now: () => clock, file: f, run: ok() })
    first.peek(); await flush()
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ v: 1, at: T0, block: { count: 41 } })
    clock = T0 + 10 * 60_000
    let runs = 0
    const second = createNeedsYouReader({ scriptsDir: scripts(), now: () => clock, file: f, run: () => { runs += 1; return new Promise(() => {}) } })
    expect(second.peek()).toMatchObject({ state: 'ok', at: T0, block: { count: 41 } })
    expect(runs).toBe(1)   // past the TTL, so a refresh starts behind it
  })

  it('a saved block over the one-hour cap is not shown', () => {
    const f = file()
    writeFileSync(f, JSON.stringify({ v: 1, at: T0 - NEEDS_YOU_SHOW_LIMIT_MS - 1, block: BLOCK }))
    expect(createNeedsYouReader({ scriptsDir: scripts(), now: () => T0, file: f, run: () => new Promise(() => {}) }).peek()).toEqual({ state: 'unknown' })
    writeFileSync(f, JSON.stringify({ v: 1, at: T0 - NEEDS_YOU_SHOW_LIMIT_MS, block: BLOCK }))
    expect(createNeedsYouReader({ scriptsDir: scripts(), now: () => T0, file: f, run: () => new Promise(() => {}) }).peek().state).toBe('ok')
  })

  it('a foreign, malformed, future, empty or linked file is ignored', () => {
    const f = file()
    const reader = () => createNeedsYouReader({ scriptsDir: scripts(), now: () => T0, file: f, run: () => new Promise(() => {}) }).peek()
    for (const text of ['{not json', JSON.stringify({ v: 2, at: T0, block: BLOCK }), JSON.stringify({ v: 1, at: 'x', block: BLOCK }),
      JSON.stringify({ v: 1, at: T0 + 1000, block: BLOCK }), JSON.stringify({ v: 1, at: T0, block: { gates: {} } }), JSON.stringify({ v: 1, at: T0, block: [] })]) {
      writeFileSync(f, text)
      expect(reader()).toEqual({ state: 'unknown' })
    }
    rmSync(f)
    const real = join(f + '.real'); writeFileSync(real, JSON.stringify({ v: 1, at: T0, block: BLOCK })); symlinkSync(real, f)
    expect(reader()).toEqual({ state: 'unknown' })
  })

  it('with COS_SCRIPTS_DIR unset, neither peek nor read shows a saved block', async () => {
    const f = file()
    writeFileSync(f, JSON.stringify({ v: 1, at: T0, block: BLOCK }))
    const r = createNeedsYouReader({ scriptsDir: null, now: () => T0, file: f })
    expect(r.peek()).toEqual({ state: 'not_set_up' })
    expect(await r.read()).toBeNull()
  })

  it('memory only unless a file is given (tests and probes never write the data dir)', async () => {
    const target = dataPath(NEEDS_YOU_FILE)
    rmSync(target, { force: true })
    const r = createNeedsYouReader({ scriptsDir: scripts(), now: () => T0, run: ok() })
    r.peek(); await flush()
    expect(r.peek().state).toBe('ok')
    expect(existsSync(target)).toBe(false)
  })
})

describe('needsYou in the status', () => {
  it('not_set_up: total is the meetings, decisions and the quarantine batch are not drawn (null, never 0)', () => {
    expect(computeNeedsYou(null, 3, { notSetUp: true })).toEqual({ meetings: 3, decisions: null, quarantineBatch: null, total: 3, learning: 'not_set_up', ageSeconds: null, fresh: null })
    expect(computeNeedsYou(BLOCK, 3, { notSetUp: true }).total).toBe(3)
    expect(computeNeedsYou(null, null, { notSetUp: true }).total).toBeNull()
  })

  it('unknown stays null; a read block carries its age, fresh only under the TTL', () => {
    expect(computeNeedsYou(null, 3)).toEqual({ meetings: 3, decisions: null, quarantineBatch: null, total: null, learning: 'unknown', ageSeconds: null, fresh: null })
    expect(computeNeedsYou(BLOCK, 17, { ageMs: NEEDS_YOU_TTL_MS - 1 })).toEqual({ meetings: 17, decisions: 1, quarantineBatch: 1, total: 19, learning: 'read', ageSeconds: 89, fresh: true })
    expect(computeNeedsYou(BLOCK, 17, { ageMs: NEEDS_YOU_TTL_MS })).toMatchObject({ ageSeconds: 90, fresh: false })
    expect(computeNeedsYou(BLOCK, 17, { ageMs: 25 * 60_000 })).toMatchObject({ total: 19, ageSeconds: 1500, fresh: false })
  })

  const loopback: LoopbackFetchFn = async path => path === '/api/health'
    ? { status: 200, body: { server_version: '7.0.46' } }
    : { status: 200, body: { available: true, learning: { available: true, total: 9 }, memory: {}, threads: {}, graph: {} } }
  const status = (peek: () => NeedsYouPeek, now = T0) => dispatchMemoriesWebOp('status', {}, loopback, 'x', undefined, () => 5, peek, () => now)

  it('the status answers from the peek, with its states', async () => {
    const notSetUp = await status(() => ({ state: 'not_set_up' }))
    expect(notSetUp.details.needsYou).toEqual({ meetings: 5, decisions: null, quarantineBatch: null, total: 5, learning: 'not_set_up', ageSeconds: null, fresh: null })
    expect(notSetUp.details.learningToReview).toBeNull()
    const saved = await status(() => ({ state: 'ok', block: BLOCK, at: T0 - 600_000 }))
    expect(saved.details.needsYou).toEqual({ meetings: 5, decisions: 1, quarantineBatch: 1, total: 7, learning: 'read', ageSeconds: 600, fresh: false })
    expect(saved.details.learningToReviewTotal).toBe(41)
    const unknown = await status(() => ({ state: 'unknown' }))
    expect(unknown.details.needsYou).toMatchObject({ total: null, learning: 'unknown' })
    const thrown = await status(() => { throw new Error('reader broke') })
    expect(thrown.ok).toBe(true)
    expect(thrown.details.needsYou).toMatchObject({ total: null, learning: 'unknown' })
  })

  it('the default status path never awaits a CLI that never answers', async () => {
    const r = createNeedsYouReader({ scriptsDir: scripts(), run: () => new Promise(() => {}) })
    const t = Date.now()
    const out = await dispatchMemoriesWebOp('status', {}, loopback, 'x', undefined, () => 5, () => r.peek())
    expect(Date.now() - t).toBeLessThan(1000)
    expect(out.details.needsYou).toMatchObject({ meetings: 5, total: null, learning: 'unknown' })
  })
})
