import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { NemotronRunError, type NemotronRun, type RunNemotronOptions } from './nemotron-cli.js'
import {
  NemotronLiveRuntime,
  nameChunkSegments,
  resolveLiveLabels,
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

  it('fallback on a missing CLI: no run time is claimed', async () => {
    const labels = await resolveLiveLabels(input(Promise.resolve({ ok: false, reason: 'cli_missing' })))
    expect(labels).toMatchObject({ speaker: 'Silas Larson', diarizer: { fallback: 'cli_missing' }, record: { reason: 'cli_missing', ms: null } })
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

  it('fallback on timeout: the reason comes back, and three in a row re-warm in the background', async () => {
    const { home, env } = fakeHome()
    let warmRuns = 0
    const run = vi.fn((options: RunNemotronOptions) => {
      if (options.timeoutMs > 10_000) { warmRuns++; return Promise.resolve(runOf(1, [])) }
      return Promise.reject(new NemotronRunError('timeout', 'no result within 1500 ms'))
    })
    let now = 1_000_000
    const lines: string[] = []
    const runtime = new NemotronLiveRuntime({ env: () => env, home: () => home, run, log: l => lines.push(l), now: () => now })
    await runtime.startWarmup()
    now += 11 * 60_000
    for (let i = 0; i < 3; i++) expect(await runtime.diarize('/a.wav')).toMatchObject({ ok: false, reason: 'timeout' })
    await Promise.resolve()
    expect(lines.join('\n')).toContain('repeated Nemotron timeouts; re-warming')
    expect(warmRuns).toBe(2)
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
    expect(runtime.snapshot().chunks).toEqual({ nemotron: 1, voiceprint: 2, reasons: { timeout: 1, busy: 1 } })
    expect(runtime.snapshot().last).toMatchObject({ outcome: 'voiceprint', reason: 'busy' })
    expect(lines).toEqual([
      '[diarizer] chunk #4 nemotron 140 ms tracks=2 segments=2 timing=estimated named=2',
      '[diarizer] chunk #5 fallback=timeout after 1500 ms -> voiceprint',
      '[diarizer] chunk #6 fallback=busy -> voiceprint',
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
