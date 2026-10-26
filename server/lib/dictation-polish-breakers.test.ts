// 6.92.0 (plan r3, A-W0a): client aborts are neutral to the failure breaker, a slow breaker opens after
// 4 aborts with real model time, and the breakers are keyed by (model, bucket group). Execution tests
// over the real pipeline with the model call faked; nothing is spawned.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// 6.92.0: a private data dir and profile, so another worker's files never reach this one and this
// one's never reach another (all workers share the run's COS_DATA_DIR and COS_PROFILE_PATH).
const SHARED_DATA_DIR = vi.hoisted(() => {
  const shared = { dataDir: process.env.COS_DATA_DIR, profile: process.env.COS_PROFILE_PATH }
  process.env.COS_DATA_DIR = `${shared.dataDir ?? '/tmp'}/private-breakers-${process.pid}-${Math.random().toString(36).slice(2)}`
  process.env.COS_PROFILE_PATH = `${process.env.COS_DATA_DIR}/.cos-profile.json`
  return shared
})
afterAll(() => {
  for (const [key, value] of [['COS_DATA_DIR', SHARED_DATA_DIR.dataDir], ['COS_PROFILE_PATH', SHARED_DATA_DIR.profile]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})


let dir = ''
let model: ReturnType<typeof vi.fn>
let audit: ReturnType<typeof vi.fn>
type Pipeline = typeof import('./dictation-polish-pipeline.js')
let pipeline: Pipeline

/** The model call: `fail` throws like a CLI error; `abort` aborts the request after `modelMs` of model time. */
type Step = { kind: 'ok' } | { kind: 'fail' } | { kind: 'abort'; modelMs: number; killMs?: number }
let script: Step[] = []
let controller: AbortController

async function load() {
  vi.resetModules()
  vi.doMock('./whisper-local.js', () => ({ applyCorrections: (t: string) => t }))
  vi.doMock('./dictation-prewarm.js', () => ({
    takePolishPrewarm: () => null, runWarmPolish: vi.fn(), discardPolishPrewarm: () => false,
    PrewarmUnavailableError: class extends Error {},
  }))
  vi.doMock('./dictation-clean.js', () => ({
    AUTOCLEAN_MAX_CHARS: 8000,
    autoCleanDictation: (model = vi.fn(async (text: string) => {
      const step = script.shift() ?? { kind: 'ok' }
      if (step.kind === 'fail') throw new Error('Auto-clean failed (1)')
      if (step.kind === 'abort') {
        vi.setSystemTime(Date.now() + step.modelMs)
        controller.abort()
        // The reject lands only after the provider process is terminated (killMs later).
        if (step.killMs) vi.setSystemTime(Date.now() + step.killMs)
        throw new Error('Auto-clean aborted')
      }
      return `${text} Polished.`
    })),
  }))
  vi.doMock('./token-audit.js', async (original) => ({ ...(await original<object>()), logTokenAudit: (audit = vi.fn()) }))
  pipeline = await import('./dictation-polish-pipeline.js')
}

async function polish(bucket: 'message' | 'meeting' | 'prompt_draft', name: 'sonnet' | 'haiku' = 'sonnet') {
  controller = new AbortController()
  return pipeline.cleanOutboundDictation('Send the notes to Dana', { enabled: true, model: name, bucket, signal: controller.signal })
}
const run = async (steps: Step[], bucket: 'message' | 'meeting' | 'prompt_draft' = 'message', name: 'sonnet' | 'haiku' = 'sonnet') => {
  const out = []
  for (const step of steps) { script = [step]; out.push(await polish(bucket, name)) }
  return out
}
const ABORT_SLOW: Step = { kind: 'abort', modelMs: 5_000 }
const ABORT_FAST: Step = { kind: 'abort', modelMs: 500 }

describe('6.92.0 dictation polish breakers', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 25, 12, 0, 0))
    dir = mkdtempSync(join(tmpdir(), 'cos-polish-breakers-'))
    process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE = join(dir, 'count.json')
    delete process.env.COS_DICTATION_SLOW_BREAKER_ABORTS
    delete process.env.COS_DICTATION_SLOW_BREAKER_MS
    script = []
    await load()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE
    rmSync(dir, { recursive: true, force: true })
  })

  it('2 client aborts leave the failure breaker closed', async () => {
    await run([ABORT_FAST, ABORT_FAST])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
    expect((await run([{ kind: 'ok' }]))[0].polishSkipped).toBeUndefined()
  })

  it('2 CLI errors open it', async () => {
    await run([{ kind: 'fail' }, { kind: 'fail' }])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(true)
    const calls = model.mock.calls.length
    expect((await run([{ kind: 'ok' }]))[0].polishSkipped).toBe('breaker_open')
    expect(model).toHaveBeenCalledTimes(calls)
  })

  it('an abort followed by an error counts 1', async () => {
    await run([ABORT_SLOW, { kind: 'fail' }])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
    await run([{ kind: 'fail' }])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(true)
  })

  it('4 aborts with at least 4 s of model time open the slow breaker for 5 minutes; a success resets it', async () => {
    await run([ABORT_SLOW, ABORT_SLOW, ABORT_SLOW])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
    await run([ABORT_SLOW])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(true)
    expect((await run([{ kind: 'ok' }]))[0].polishSkipped).toBe('breaker_open')
    vi.setSystemTime(Date.now() + 299_000)
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(true)
    vi.setSystemTime(Date.now() + 2_000)
    // Half-open after 5 minutes: one call goes through, and its success closes the breaker.
    expect((await run([{ kind: 'ok' }]))[0].polishOutcome).toBe('polished')
    await run([ABORT_SLOW, ABORT_SLOW, ABORT_SLOW])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
  })

  it('a success between aborts resets the slow count', async () => {
    await run([ABORT_SLOW, ABORT_SLOW, ABORT_SLOW, { kind: 'ok' }, ABORT_SLOW, ABORT_SLOW, ABORT_SLOW])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
  })

  it('an abort under 4 s of model time does not count toward the slow breaker', async () => {
    await run([ABORT_FAST, ABORT_FAST, ABORT_FAST, ABORT_FAST, ABORT_FAST])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
    expect(pipeline.SLOW_ABORT_MIN_MODEL_MS).toBe(4_000)
    await run([{ kind: 'abort', modelMs: 3_999 }, { kind: 'abort', modelMs: 3_999 }, { kind: 'abort', modelMs: 3_999 }, { kind: 'abort', modelMs: 3_999 }])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
    await run([{ kind: 'abort', modelMs: 4_000 }, { kind: 'abort', modelMs: 4_000 }, { kind: 'abort', modelMs: 4_000 }, { kind: 'abort', modelMs: 4_000 }])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(true)
  })

  it('the model time is stamped at the abort, not when the reject lands after the kill', async () => {
    const lateReject: Step = { kind: 'abort', modelMs: 2_500, killMs: 3_000 }
    await run([lateReject, lateReject, lateReject, lateReject])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
    expect(audit.mock.calls.map(([row]) => row.durationMs)).toEqual([2_500, 2_500, 2_500, 2_500])
  })

  it('COS_DICTATION_SLOW_BREAKER_ABORTS and _MS set the threshold and the open time', async () => {
    process.env.COS_DICTATION_SLOW_BREAKER_ABORTS = '2'
    process.env.COS_DICTATION_SLOW_BREAKER_MS = '60000'
    await run([ABORT_SLOW, ABORT_SLOW])
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(true)
    vi.setSystemTime(Date.now() + 61_000)
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
    expect(pipeline.slowBreakerAborts({})).toBe(4)
    expect(pipeline.slowBreakerMs({})).toBe(300_000)
    for (const bad of ['0', '-1', '2.5', 'x']) expect(pipeline.slowBreakerAborts({ COS_DICTATION_SLOW_BREAKER_ABORTS: bad }), bad).toBe(4)
  })

  it('an abort writes an audit row with outcome aborted (codes only); the answer never says aborted', async () => {
    const [answer] = await run([ABORT_SLOW])
    expect(answer.polishSkipped).toBe('failed')
    expect(answer.polishOutcome).toBeUndefined()
    expect(audit).toHaveBeenCalledTimes(1)
    const row = audit.mock.calls[0][0]
    expect(row).toMatchObject({ polishOutcome: 'aborted', caller: 'dictation_autoclean_message', outputChars: 0, model: 'sonnet' })
    expect(JSON.stringify(row)).not.toContain('Dana')
    // A CLI failure writes no row, as before.
    await run([{ kind: 'fail' }])
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('a meeting failure leaves the message breaker closed (and the reverse)', async () => {
    await run([{ kind: 'fail' }, { kind: 'fail' }], 'meeting')
    expect(pipeline.polishBreakerOpen('sonnet', 'meeting')).toBe(true)
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(false)
    expect(pipeline.polishBreakerOpen('sonnet', 'prompt_draft')).toBe(false)
    expect((await run([{ kind: 'ok' }], 'message'))[0].polishOutcome).toBe('polished')
    await run([{ kind: 'fail' }, { kind: 'fail' }], 'message')
    expect(pipeline.polishBreakerOpen('haiku', 'message')).toBe(false)
  })

  it('message and prompt_draft are one group', async () => {
    await run([{ kind: 'fail' }], 'message')
    await run([{ kind: 'fail' }], 'prompt_draft')
    expect(pipeline.polishBreakerOpen('sonnet', 'message')).toBe(true)
    expect(pipeline.breakerGroupFor('prompt_draft')).toBe('dictation')
    expect(pipeline.breakerGroupFor('meeting')).toBe('meeting')
  })
})
