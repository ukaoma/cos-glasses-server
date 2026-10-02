import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { NemotronRunError, type NemotronRun, type RunNemotronOptions } from './nemotron-cli.js'
import {
  BREAKER_BACKOFF_MS,
  BREAKER_FAILURES,
  LIVE_BUDGET_MS,
  LIVE_MAX_CONCURRENT,
  NemotronLiveRuntime,
  nameChunkSegments,
  resolveLiveLabels,
  resplitSegments,
  type LiveDiarizeOutcome,
} from './nemotron-live.js'
import { activityOf, signVoiceprint, wavOf } from './__fixtures__/nemotron-helpers.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A home with an installed CLI and a complete FluidAudio cache, nothing real. */
function fakeHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'nemotron-live-home-'))
  roots.push(home)
  mkdirSync(join(home, '.cos-glasses', 'bin'), { recursive: true })
  writeFileSync(join(home, '.cos-glasses', 'bin', 'fluidaudiocli'), '')
  const cache = join(home, 'Library', 'Application Support', 'FluidAudio', 'Models', 'nemotron-3-diarization')
  mkdirSync(join(cache, 'monolithic', 'v2', 'Nemotron3Diarizer_fast32.mlmodelc'), { recursive: true })
  writeFileSync(join(cache, 'monolithic', 'v2', 'Nemotron3Diarizer_fast32.mlmodelc', 'coremldata.bin'), 'x')
  writeFileSync(join(cache, 'learnable_sil_emb.bin'), 'x')
  return { home, env: { COS_DIARIZER: 'nemotron' } }
}

function runOf(durationSec: number, spans: Array<[number, number, number]>): NemotronRun {
  return { ...activityOf(durationSec, spans), loadSec: 0.1, audioSec: durationSec, wallMs: 140 }
}

const MU = { speaker: 'MU', similarity: 0.82 }

describe('naming the tracks of one chunk', () => {
  it('a one-track chunk takes the whole-chunk voiceprint and keeps the text whole', () => {
    const identify = vi.fn()
    const result = nameChunkSegments({
      activity: activityOf(6, [[0, 0.2, 5.8]]),
      text: 'The bookings month came in light.',
      audio: wavOf(6, () => 50),
      chunkVoiceprint: { speaker: 'Silas Larson', similarity: 0.7 },
      clientSpeaker: 'MU',
      identify,
    })
    expect(result).toMatchObject({ ok: true, speaker: 'Silas Larson', tracks: 1 })
    if (!result.ok) throw new Error('unreachable')
    expect(result.segments).toEqual([expect.objectContaining({ speaker: 'Silas Larson', text: 'The bookings month came in light.', similarity: 0.7 })])
    expect(identify).not.toHaveBeenCalled()
  })

  it('two long tracks are each named by the voiceprint on their own audio, in time order', () => {
    // MU 0-2.6 s (positive samples), Silas 3-6 s (negative samples).
    const result = nameChunkSegments({
      activity: activityOf(6, [[0, 0, 2.6], [5, 3, 6]]),
      text: 'Yeah I agree with that. So the bookings month came in light again.',
      audio: wavOf(6, t => (t < 2.8 ? 400 : -400)),
      chunkVoiceprint: { speaker: 'Silas Larson', similarity: 0.6 },
      clientSpeaker: 'MU',
      identify: signVoiceprint({ positive: 'MU', negative: 'Silas Larson' }),
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.segments.map(s => s.speaker)).toEqual(['MU', 'Silas Larson'])
    expect(result.segments.map(s => s.text).join(' ')).toBe('Yeah I agree with that. So the bookings month came in light again.')
    expect(result.segments[0].startSec!).toBeLessThan(result.segments[1].startSec!)
    expect(result.identified).toBe(2)
    expect(result.speaker).toBe('Silas Larson')
  })

  it('naming a short track: dominant takes the chunk voiceprint, the other the client label, else Ext', () => {
    const base = {
      // Dominant channel 2 speaks 0-4.5 s; channel 6 interjects 5-5.8 s (0.8 s: too short to name).
      activity: activityOf(6, [[2, 0, 4.5], [6, 5, 5.8]]),
      text: 'We should hold the budget until Monday. Right.',
      audio: wavOf(6, () => 300),
      identify: signVoiceprint({ positive: 'Silas Larson', negative: 'MU' }),
    }
    const withClient = nameChunkSegments({ ...base, chunkVoiceprint: { speaker: 'Silas Larson', similarity: 0.7 }, clientSpeaker: 'MU' })
    if (!withClient.ok) throw new Error(withClient.reason)
    expect(withClient.segments.map(s => [s.speaker, s.text])).toEqual([
      ['Silas Larson', 'We should hold the budget until Monday.'],
      ['MU', 'Right.'],
    ])
    expect(withClient.segments[1].similarity).toBe(0)
    // The client label equals the dominant name: never repeat it onto another voice.
    const sameClient = nameChunkSegments({ ...base, chunkVoiceprint: { speaker: 'Silas Larson', similarity: 0.7 }, clientSpeaker: 'Silas Larson' })
    if (!sameClient.ok) throw new Error(sameClient.reason)
    expect(sameClient.segments.map(s => s.speaker)).toEqual(['Silas Larson', 'Ext'])
    // Unknown is not a name.
    const unknown = nameChunkSegments({ ...base, chunkVoiceprint: { speaker: 'Silas Larson', similarity: 0.7 }, clientSpeaker: 'Unknown' })
    if (!unknown.ok) throw new Error(unknown.reason)
    expect(unknown.segments.map(s => s.speaker)).toEqual(['Silas Larson', 'Ext'])
  })

  it('a track the voiceprint cannot name (Ext) stays Ext; a name is never invented', () => {
    const result = nameChunkSegments({
      activity: activityOf(6, [[0, 0, 2.6], [1, 3, 6]]),
      text: 'Thanks for joining. Happy to be here today.',
      audio: wavOf(6, t => (t < 2.8 ? 400 : -400)),
      chunkVoiceprint: MU,
      clientSpeaker: 'MU',
      identify: wav => (wav.readInt16LE(44) >= 0 ? MU : { speaker: 'Ext', similarity: 0 }),
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.segments.map(s => s.speaker)).toEqual(['MU', 'Ext'])
  })

  it('uses whisper word clocks when the ASR gives them, instead of estimating', () => {
    const words = ['one', 'two', 'three', 'four', 'five'].map((word, i) => ({ word, start: 0.2 + i * 0.5, end: 0.6 + i * 0.5, probability: 0.9 }))
      .concat([{ word: 'six', start: 3.6, end: 4.0, probability: 0.9 }])
    const result = nameChunkSegments({
      activity: activityOf(6, [[0, 0, 3], [1, 3.2, 6]]),
      text: 'one two three four five six',
      words,
      audio: wavOf(6, t => (t < 3.1 ? 400 : -400)),
      chunkVoiceprint: MU,
      clientSpeaker: 'MU',
      identify: signVoiceprint({ positive: 'MU', negative: 'Silas Larson' }),
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.timing).toBe('words')
    // Estimated by length this would split three and three; the clocks say five and one.
    expect(result.segments.map(s => [s.speaker, s.text])).toEqual([['MU', 'one two three four five'], ['Silas Larson', 'six']])
  })

  it('the chunk speaker is the voice that carries the words, not a louder voice with none', () => {
    // Channel 3 talks over the whole chunk in the background; every word sits on channel 0.
    const words = ['one', 'two', 'three'].map((word, i) => ({ word, start: 0.3 + i * 0.4, end: 0.6 + i * 0.4, probability: 0.9 }))
    const result = nameChunkSegments({
      activity: activityOf(6, [[0, 0, 1.6], [3, 0, 6]], 0.9),
      text: 'one two three',
      words,
      audio: wavOf(6, () => 300),
      chunkVoiceprint: MU,
      clientSpeaker: 'MU',
      identify: () => ({ speaker: 'Silas Larson', similarity: 0.7 }),
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.segments.map(s => s.speaker)).toEqual(['MU'])
    expect(result.speaker).toBe('MU')
  })

  it('reports no_speech when Nemotron heard nothing', () => {
    expect(nameChunkSegments({
      activity: activityOf(6, []), text: 'hello', audio: wavOf(6, () => 1), chunkVoiceprint: MU, clientSpeaker: 'MU', identify: () => null,
    })).toEqual({ ok: false, reason: 'no_speech' })
  })
})

describe('live labels never block or lose a chunk', () => {
  const input = (diarize: Promise<LiveDiarizeOutcome>) => ({
    diarize,
    startedAt: 0,
    clock: () => 150,
    text: 'Yeah I agree with that. So the bookings month came in light again.',
    audio: wavOf(6, t => (t < 2.8 ? 400 : -400)),
    voiceprint: { speaker: 'Silas Larson', similarity: 0.6 },
    clientSpeaker: 'MU',
    identify: signVoiceprint({ positive: 'MU', negative: 'Silas Larson' }),
  })

  it('a clean run gives segments with the dominant name as speaker', async () => {
    const labels = await resolveLiveLabels(input(Promise.resolve({ ok: true, run: runOf(6, [[0, 0, 2.6], [5, 3, 6]]) })))
    expect(labels.speaker).toBe('Silas Larson')
    expect(labels.segments?.map(s => s.speaker)).toEqual(['MU', 'Silas Larson'])
    // Nemotron's own run time (140 ms), not the 150 ms the chunk waited.
    expect(labels.diarizer).toMatchObject({ engine: 'nemotron', tracks: 2, ms: 140 })
    expect(labels.record).toMatchObject({ outcome: 'nemotron', segments: 2 })
  })

  it('keeps the whole-chunk voiceprint label recoverable when the dominant track is someone else', async () => {
    const labels = await resolveLiveLabels({ ...input(Promise.resolve({ ok: true, run: runOf(6, [[0, 0, 2.6], [5, 3, 6]]) })), voiceprint: { speaker: 'MU', similarity: 0.66 } })
    expect(labels.speaker).toBe('Silas Larson')
    expect(labels.diarizer).toMatchObject({ voiceprintSpeaker: 'MU', voiceprintSimilarity: 0.66 })
  })

  it('fallback on timeout: the voiceprint label, no segments, the reason recorded', async () => {
    const labels = await resolveLiveLabels(input(Promise.resolve({ ok: false, reason: 'timeout', detail: 'no result within 1500 ms', ms: 1500 })))
    expect(labels).toMatchObject({ speaker: 'Silas Larson', similarity: 0.6, diarizer: { engine: 'voiceprint', fallback: 'timeout' } })
    expect(labels.segments).toBeUndefined()
    expect(labels.record).toMatchObject({ outcome: 'voiceprint', reason: 'timeout', ms: 1500 })
  })

  it('fallback on failure: a crashed CLI or a rejected promise keeps the voiceprint', async () => {
    const crashed = await resolveLiveLabels(input(Promise.resolve({ ok: false, reason: 'cli_failed', detail: 'exit 1' })))
    expect(crashed).toMatchObject({ speaker: 'Silas Larson', diarizer: { fallback: 'cli_failed' } })
    const rejected = await resolveLiveLabels(input(Promise.reject(new Error('boom'))))
    expect(rejected).toMatchObject({ speaker: 'Silas Larson', diarizer: { fallback: 'error' } })
  })

  it('fallback on a missing CLI or models: the voiceprint label, no per-chunk stamp and no per-chunk log', async () => {
    // An install without the CLI is the public default: the warm-up says so once (QA N5).
    for (const reason of ['cli_missing', 'models_missing'] as const) {
      const labels = await resolveLiveLabels(input(Promise.resolve({ ok: false, reason })))
      expect(labels).toEqual({ speaker: 'Silas Larson', similarity: 0.6 })
    }
  })

  it('the voiceprint chosen by config is not a fallback and records nothing', async () => {
    const labels = await resolveLiveLabels(input(Promise.resolve({ ok: false, reason: 'embedding_requested' })))
    expect(labels).toEqual({ speaker: 'Silas Larson', similarity: 0.6 })
  })
})

describe('the live runtime', () => {
  it('fallback on a missing CLI: warm-up reports cli_missing and never spawns', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nemotron-nocli-'))
    roots.push(home)
    const run = vi.fn()
    const lines: string[] = []
    const runtime = new NemotronLiveRuntime({ env: () => ({ COS_DIARIZER: 'nemotron', COS_NEMOTRON_CLI: '/no/such/fluidaudiocli' }), home: () => home, run, log: l => lines.push(l) })
    await runtime.startWarmup()
    expect(await runtime.diarize('/x.wav')).toMatchObject({ ok: false, reason: 'cli_missing' })
    expect(run).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toMatchObject({ active: 'embedding', fallback: 'cli_missing' })
    expect(lines.join('\n')).toContain('tracks=voiceprint names=voiceprint fallback=cli_missing')
  })

  it('a cold model: chunks before the warm-up finishes are `warming`, then Nemotron runs', async () => {
    const { home, env } = fakeHome()
    let releaseWarm: () => void = () => {}
    const run = vi.fn((options: RunNemotronOptions) => options.timeoutMs > 10_000
      ? new Promise<NemotronRun>(resolve => { releaseWarm = () => resolve(runOf(1, [])) })
      : Promise.resolve(runOf(6, [[0, 0, 6]])))
    const lines: string[] = []
    const runtime = new NemotronLiveRuntime({ env: () => env, home: () => home, run, log: l => lines.push(l) })
    const warm = runtime.startWarmup()
    expect(runtime.snapshot()).toMatchObject({ active: 'warming', fallback: 'warming' })
    expect(await runtime.diarize('/chunk.wav')).toMatchObject({ ok: false, reason: 'warming' })
    releaseWarm()
    await warm
    expect(runtime.snapshot()).toMatchObject({ active: 'nemotron', fallback: null, warm: { state: 'ready' } })
    expect(lines.join('\n')).toContain('[diarizer] tracks=nemotron names=voiceprint warm in')
    const ok = await runtime.diarize('/chunk.wav')
    expect(ok.ok).toBe(true)
    // Every live run passes the local models and the Neural Engine, inside the budget.
    const live = run.mock.calls.at(-1)![0]
    expect(live).toMatchObject({ computeUnits: 'ane', timeoutMs: 1500, wavPath: '/chunk.wav' })
    expect(live.modelsDir).toBe(join(home, '.cos-glasses', 'models', 'nemotron-3-diarization'))
  })

  it('caps concurrency: a chunk that finds the lane full is busy, never queued', async () => {
    const { home, env } = fakeHome()
    const pending: Array<() => void> = []
    const run = vi.fn((options: RunNemotronOptions) => options.timeoutMs > 10_000
      ? Promise.resolve(runOf(1, []))
      : new Promise<NemotronRun>(resolve => pending.push(() => resolve(runOf(6, [[0, 0, 6]])))))
    const runtime = new NemotronLiveRuntime({ env: () => env, home: () => home, run, log: () => {}, maxConcurrent: 2 })
    await runtime.startWarmup()
    const first = runtime.diarize('/a.wav')
    const second = runtime.diarize('/b.wav')
    expect(await runtime.diarize('/c.wav')).toMatchObject({ ok: false, reason: 'busy' })
    pending.forEach(release => release())
    expect((await first).ok && (await second).ok).toBe(true)
    expect(runtime.snapshot().inFlight).toBe(0)
  })

  it('the breaker: three failed runs stop spawning, every chunk takes the voiceprint at once, then one warm-up after a bounded rest', async () => {
    const { home, env } = fakeHome()
    let now = 1_000_000
    let cliCalls = 0
    let warmRuns = 0
    const run = vi.fn((options: RunNemotronOptions) => {
      cliCalls++
      if (options.timeoutMs > 10_000) { warmRuns++; return Promise.resolve(runOf(1, [])) }
      return Promise.reject(new NemotronRunError('timeout', 'no result within 1500 ms'))
    })
    const lines: string[] = []
    // Real defaults: no budget, lane or backoff override.
    const runtime = new NemotronLiveRuntime({ env: () => env, home: () => home, run, log: l => lines.push(l), now: () => now })
    await runtime.startWarmup()
    const reasons: string[] = []
    // Twenty chunks, one every 6 s (two minutes), all inside the first rest.
    for (let i = 0; i < 20; i++) {
      now += 6_000
      const outcome = await runtime.diarize('/a.wav')
      reasons.push(outcome.ok ? 'ok' : outcome.reason)
    }
    expect(reasons.slice(0, 3)).toEqual(['timeout', 'timeout', 'timeout'])
    expect(reasons.slice(3).every(reason => reason === 'cooling')).toBe(true)
    expect(cliCalls).toBe(1 + 3) // the warm-up and three budget kills; nothing while cooling
    expect(lines.join('\n')).toContain('[diarizer] breaker open: 3 Nemotron runs failed in a row (last: timeout); voiceprint labels for 2 min, then a fresh warm-up')
    expect(runtime.snapshot()).toMatchObject({ active: 'embedding', fallback: 'cooling', breaker: { open: true, trips: 1 } })
    // The rest is over: one warm-up, then Nemotron is tried again.
    now = 1_000_000 + 18_000 + BREAKER_BACKOFF_MS[0] + 1
    expect(await runtime.diarize('/a.wav')).toMatchObject({ ok: false, reason: 'warming' })
    await Promise.resolve(); await Promise.resolve()
    expect(warmRuns).toBe(2)
    // Still failing: the second rest is twice as long.
    for (let i = 0; i < 3; i++) await runtime.diarize('/a.wav')
    expect(runtime.snapshot().breaker).toMatchObject({ open: true, trips: 2 })
    expect(new Date(runtime.snapshot().breaker.retryAt!).getTime() - now).toBe(BREAKER_BACKOFF_MS[1])
  })

  it('pins the real defaults: 1.5 s budget, a lane of two, the backoff schedule', () => {
    expect(LIVE_BUDGET_MS).toBe(1500)
    expect(LIVE_MAX_CONCURRENT).toBe(2)
    expect(BREAKER_FAILURES).toBe(3)
    expect(BREAKER_BACKOFF_MS).toEqual([120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000])
    const snapshot = new NemotronLiveRuntime({ env: () => ({ COS_DIARIZER: 'nemotron' }), log: () => {} }).snapshot()
    expect(snapshot).toMatchObject({ budgetMs: 1500, maxConcurrent: 2, recent: { window: 5 } })
  })

  it('health never says nemotron while the chunks fall back: warm, then five failures', async () => {
    const { home, env } = fakeHome()
    let fail = false
    const run = vi.fn((options: RunNemotronOptions) => options.timeoutMs > 10_000 || !fail
      ? Promise.resolve(runOf(6, [[0, 0, 6]]))
      : Promise.reject(new NemotronRunError('cli_failed', 'exit 1')))
    const runtime = new NemotronLiveRuntime({ env: () => env, home: () => home, run, log: () => {} })
    await runtime.startWarmup()
    expect(runtime.snapshot().active).toBe('nemotron')
    fail = true
    for (let i = 0; i < 5; i++) {
      const outcome = await runtime.diarize('/a.wav')
      runtime.record({ sessionId: 's', chunkIndex: i }, outcome.ok
        ? { outcome: 'nemotron', ms: 140, segments: 1, tracks: 1, timing: 'estimated', identified: 0 }
        : { outcome: 'voiceprint', reason: outcome.reason, ms: 10 })
    }
    const snapshot = runtime.snapshot()
    expect(snapshot.active).not.toBe('nemotron')
    expect(snapshot.recent).toEqual({ window: 5, nemotron: 0, voiceprint: 5 })
  })

  it('warm but most recent chunks fell back: active says embedding and why, before any breaker', async () => {
    const { home, env } = fakeHome()
    const runtime = new NemotronLiveRuntime({ env: () => env, home: () => home, run: async () => runOf(6, [[0, 0, 6]]), log: () => {} })
    await runtime.startWarmup()
    runtime.record({ sessionId: 's', chunkIndex: 1 }, { outcome: 'nemotron', ms: 140, segments: 1, tracks: 1, timing: 'estimated', identified: 0 })
    runtime.record({ sessionId: 's', chunkIndex: 2 }, { outcome: 'voiceprint', reason: 'busy', ms: null })
    runtime.record({ sessionId: 's', chunkIndex: 3 }, { outcome: 'voiceprint', reason: 'busy', ms: null })
    expect(runtime.snapshot()).toMatchObject({ active: 'embedding', fallback: 'busy', recent: { nemotron: 1, voiceprint: 2 } })
    // A chunk Nemotron ran on and found silent is not a failure.
    runtime.record({ sessionId: 's', chunkIndex: 4 }, { outcome: 'voiceprint', reason: 'no_speech', ms: 120 })
    runtime.record({ sessionId: 's', chunkIndex: 5 }, { outcome: 'nemotron', ms: 140, segments: 1, tracks: 1, timing: 'estimated', identified: 0 })
    runtime.record({ sessionId: 's', chunkIndex: 6 }, { outcome: 'nemotron', ms: 140, segments: 1, tracks: 1, timing: 'estimated', identified: 0 })
    expect(runtime.snapshot()).toMatchObject({ active: 'nemotron', fallback: null, recent: { nemotron: 3, voiceprint: 2 } })
  })

  it('a warm-up whose temp dir cannot be made fails with a reason, never sticks on warming, never rejects', async () => {
    const { home, env } = fakeHome()
    let now = 0
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    const lines: string[] = []
    const runtime = new NemotronLiveRuntime({
      env: () => env, home: () => home, log: l => lines.push(l), now: () => now, sleep: async () => {},
      tmpRoot: () => '/nonexistent-qa-root', run: async () => { throw new Error('never reached') },
    })
    await runtime.startWarmup()
    await new Promise(resolve => setTimeout(resolve, 20))
    process.off('unhandledRejection', onRejection)
    expect(rejections).toEqual([])
    expect(runtime.snapshot()).toMatchObject({ active: 'embedding', fallback: 'warmup_failed', warm: { state: 'failed', error: 'temp_dir' } })
    expect(lines.at(-1)).toBe('[diarizer] tracks=voiceprint names=voiceprint fallback=warmup_failed (temp_dir); next warm-up in 2 min')
    expect(await runtime.diarize('/x.wav')).toMatchObject({ ok: false, reason: 'warmup_failed' })
  })

  it('a lane of two under a backlog of three hundred chunks: never more than two runs', async () => {
    const { home, env } = fakeHome()
    let inFlight = 0
    let peak = 0
    const runtime = new NemotronLiveRuntime({
      env: () => env, home: () => home, log: () => {},
      run: async options => {
        if (options.timeoutMs > 10_000) return runOf(1, [])
        inFlight++; peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 20))
        inFlight--
        return runOf(6, [[0, 0, 5]])
      },
    })
    await runtime.startWarmup()
    const outcomes = await Promise.all(Array.from({ length: 300 }, () => runtime.diarize('/x.wav')))
    expect(peak).toBe(2)
    expect(outcomes.filter(o => o.ok)).toHaveLength(2)
    expect(outcomes.filter(o => !o.ok && o.reason === 'busy')).toHaveLength(298)
    expect(runtime.snapshot().inFlight).toBe(0)
  })

  it('logs the warm-up failure line and the CLI identity once', async () => {
    const { home, env } = fakeHome()
    const lines: string[] = []
    const runtime = new NemotronLiveRuntime({
      env: () => env, home: () => home, log: l => lines.push(l), sleep: async () => {},
      cliIdentity: () => ({ sha256: 'abc123', known: false }),
      run: () => Promise.reject(new NemotronRunError('cli_failed', 'exit 1: Error')),
    })
    await runtime.startWarmup()
    expect(lines).toEqual([
      '[diarizer] fluidaudiocli sha256 abc123 (an unverified build: offline use rests on --models; check its download behaviour)',
      '[diarizer] Nemotron warm-up attempt 1/3 failed (cli_failed): exit 1: Error',
      '[diarizer] Nemotron warm-up attempt 2/3 failed (cli_failed): exit 1: Error',
      '[diarizer] Nemotron warm-up attempt 3/3 failed (cli_failed): exit 1: Error',
      '[diarizer] tracks=voiceprint names=voiceprint fallback=warmup_failed (cli_failed); next warm-up in 2 min',
    ])
    expect(runtime.snapshot().cliKnown).toBe(false)
  })

  it('a failing warm-up retries a bounded number of times, then reports warmup_failed', async () => {
    const { home, env } = fakeHome()
    const run = vi.fn(() => Promise.reject(new NemotronRunError('cli_failed', 'exit 1: Error')))
    const sleep = vi.fn(async () => {})
    const runtime = new NemotronLiveRuntime({ env: () => env, home: () => home, run, log: () => {}, sleep })
    await runtime.startWarmup()
    expect(run).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(call => (call as unknown[])[0])).toEqual([5_000, 30_000])
    expect(await runtime.diarize('/a.wav')).toMatchObject({ ok: false, reason: 'warmup_failed' })
    expect(runtime.snapshot()).toMatchObject({ active: 'embedding', fallback: 'warmup_failed' })
  })

  it('counts every outcome and logs every fallback with its reason', () => {
    const lines: string[] = []
    const runtime = new NemotronLiveRuntime({ env: () => ({ COS_DIARIZER: 'nemotron' }), log: l => lines.push(l) })
    runtime.record({ sessionId: 's', chunkIndex: 4 }, { outcome: 'nemotron', ms: 140, segments: 2, tracks: 2, timing: 'estimated', identified: 2 })
    runtime.record({ sessionId: 's', chunkIndex: 5 }, { outcome: 'voiceprint', reason: 'timeout', ms: 1500 })
    runtime.record({ sessionId: 's', chunkIndex: 6 }, { outcome: 'voiceprint', reason: 'busy', ms: null })
    // State reasons are counted per chunk and logged once per change of state.
    runtime.record({ sessionId: 's', chunkIndex: 7 }, { outcome: 'voiceprint', reason: 'warming', ms: null })
    runtime.record({ sessionId: 's', chunkIndex: 8 }, { outcome: 'voiceprint', reason: 'warming', ms: null })
    expect(runtime.snapshot().chunks).toEqual({ nemotron: 1, voiceprint: 4, reasons: { timeout: 1, busy: 1, warming: 2 } })
    expect(runtime.snapshot().last).toMatchObject({ outcome: 'voiceprint', reason: 'warming' })
    expect(lines).toEqual([
      '[diarizer] chunk #4 nemotron 140 ms tracks=2 segments=2 timing=estimated named=2',
      '[diarizer] chunk #5 fallback=timeout after 1500 ms -> voiceprint',
      '[diarizer] chunk #6 fallback=busy -> voiceprint',
      '[diarizer] chunk #7 fallback=warming -> voiceprint (and every chunk after it until the state changes; counted in health)',
    ])
  })

  it('the voiceprint selected by COS_DIARIZER never warms or runs Nemotron', async () => {
    const run = vi.fn()
    const runtime = new NemotronLiveRuntime({ env: () => ({ COS_DIARIZER: 'embedding' }), run, log: () => {} })
    await runtime.startWarmup()
    expect(await runtime.diarize('/a.wav')).toEqual({ ok: false, reason: 'embedding_requested' })
    expect(run).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toMatchObject({ requested: 'embedding', active: 'embedding', fallback: null })
  })
})

describe('turns always join to the text', () => {
  it('punctuation-only tokens, a double space and two tracks with one name merge into one exact turn', () => {
    const text = 'Yeah , so - we ...  agree. Right'
    for (const names of [{ positive: 'MU', negative: 'MU' }, { positive: 'MU', negative: 'Silas Larson' }]) {
      const result = nameChunkSegments({
        activity: activityOf(6, [[0, 0, 2.6], [5, 3, 6]]),
        text,
        audio: wavOf(6, t => (t < 2.8 ? 400 : -400)),
        chunkVoiceprint: MU,
        clientSpeaker: 'MU',
        identify: signVoiceprint(names),
      })
      if (!result.ok) throw new Error(result.reason)
      expect(result.segments.map(segment => segment.text).join(' ')).toBe(text)
      if (names.negative === 'MU') expect(result.segments).toHaveLength(1)
    }
  })

  it('refits turns to a text recovery stripped, or drops them when the words no longer line up', () => {
    const turns = [
      { speaker: 'MU', text: 'alpha bravo noise', startSec: 0, endSec: 2, similarity: 0.8 },
      { speaker: 'Silas Larson', text: 'phrase charlie', startSec: 2, endSec: 5, similarity: 0.7 },
    ]
    expect(resplitSegments(turns, 'alpha bravo charlie')).toEqual([
      { speaker: 'MU', text: 'alpha bravo', startSec: 0, endSec: 2, similarity: 0.8 },
      { speaker: 'Silas Larson', text: 'charlie', startSec: 2, endSec: 5, similarity: 0.7 },
    ])
    // A whole turn stripped away: its neighbours of one name merge.
    expect(resplitSegments([turns[0], turns[1], { speaker: 'MU', text: 'delta', startSec: 5, endSec: 6, similarity: 0.9 }], 'alpha bravo noise delta'))
      .toEqual([{ speaker: 'MU', text: 'alpha bravo noise delta', startSec: 0, endSec: 6, similarity: 0.9 }])
    // A word rewritten: the turns cannot be trusted.
    expect(resplitSegments(turns, 'alpha brave charlie')).toBeUndefined()
  })
})
