// 6.74.0: the onboarding dictation check (dictation-benchmark.ts). Engines are injected.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./whisper-local.js', () => ({ applyCorrections: (t: string) => t, getWhisperCommitCapability: () => ({ configured: true, effectiveModel: 'large-v3-turbo' }), transcribeLocal: vi.fn() }))
vi.mock('./parakeet.js', () => ({ parakeetInstalled: () => ({ installed: false }), parakeetWarmState: () => ({ state: 'cold' }), transcribeParakeet: vi.fn(), warmParakeet: vi.fn(), FIRST_LOAD_TIMEOUT_MS: 180_000, ParakeetError: class extends Error {}, parakeetInstallRunning: () => false }))
vi.mock('./stt-runtime.js', () => ({ isRecordingLive: () => false, PREVIEW_PARAKEET_MODEL: 'parakeet-ultra', PARAKEET_PREVIEW_TIMEOUT_MS: 900 }))

import {
  __resetBenchmarkForTests, benchmarkRunning, BenchmarkRefusedError, parseBenchmarkEngines, runDictationBenchmark, type BenchmarkDeps,
} from './dictation-benchmark.js'

function wav(seconds = 30): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * 16_000) * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24)
  h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** A fake clock: each engine call advances it by the time given. */
function deps(over: Partial<BenchmarkDeps> = {}): BenchmarkDeps & { clock: { t: number } } {
  const clock = { t: 0 }
  return {
    clock,
    recordingLive: () => false,
    whisperPresent: () => true,
    whisperModel: () => 'large-v3-turbo',
    whisper: vi.fn(async () => { clock.t += 1500; return { text: 'whisper text' } }),
    parakeetInstalled: () => true,
    parakeetWarm: () => true,
    warmParakeet: vi.fn(async () => { clock.t += 20_000; return true }),
    parakeet: vi.fn(async (_a, _t, onSpawn) => { onSpawn(4242); await new Promise(r => setTimeout(r, 120)); clock.t += 600; return { text: 'parakeet text' } }),
    rss: vi.fn(async () => 300 * 1024 * 1024),
    now: () => clock.t,
    engineTimeoutMs: 60_000,
    totalTimeoutMs: 150_000,
    ...over,
  }
}

beforeEach(() => __resetBenchmarkForTests())
afterEach(() => vi.useRealTimers())

describe('runDictationBenchmark', () => {
  it('runs each installed engine on the same audio and reports rtf, memory and text', async () => {
    const d = deps()
    const audio = wav(30)
    const r = await runDictationBenchmark(audio, ['whisper', 'parakeet-ultra'], d)
    expect(r.audioSeconds).toBe(30)
    expect(r.results).toEqual([
      { engine: 'whisper', model: 'large-v3-turbo', ran: true, elapsedMs: 1500, rtf: 0.05, peakRssBytes: null, text: 'whisper text' },
      { engine: 'parakeet-ultra', model: 'parakeet-ultra', ran: true, elapsedMs: 600, rtf: 0.02, peakRssBytes: 300 * 1024 * 1024, text: 'parakeet text' },
    ])
    expect(d.whisper).toHaveBeenCalledWith(audio, expect.any(AbortSignal))
    expect(d.rss).toHaveBeenCalledWith(4242)
    expect(d.warmParakeet).not.toHaveBeenCalled()
    expect(benchmarkRunning()).toBe(false)
  })

  it('a cold Parakeet warms first; warmupMs is reported and rtf is the warm decode', async () => {
    const d = deps({ parakeetWarm: () => false })
    const r = await runDictationBenchmark(wav(30), ['parakeet-ultra'], d)
    expect(r.results[0]).toMatchObject({ ran: true, warmupMs: 20_000, elapsedMs: 600, rtf: 0.02 })
    const failed = deps({ parakeetWarm: () => false, warmParakeet: vi.fn(async () => false) })
    expect((await runDictationBenchmark(wav(30), ['parakeet-ultra'], failed)).results[0]).toMatchObject({ ran: false, skipped: 'unavailable' })
  })

  it('an engine that is not installed is skipped, not failed', async () => {
    const r = await runDictationBenchmark(wav(30), ['whisper', 'parakeet-ultra'], deps({ parakeetInstalled: () => false, whisperPresent: () => false }))
    expect(r.results.map(x => [x.engine, x.ran, x.skipped])).toEqual([['whisper', false, 'not_installed'], ['parakeet-ultra', false, 'not_installed']])
  })

  it('one run at a time, and never while a recording is live', async () => {
    let release!: () => void
    const slow = deps({ whisper: vi.fn(() => new Promise<{ text: string }>(r => { release = () => r({ text: 'x' }) })) })
    const first = runDictationBenchmark(wav(5), ['whisper'], slow)
    await expect(runDictationBenchmark(wav(5), ['whisper'], deps())).rejects.toMatchObject({ status: 409, reason: 'benchmark_running' })
    release()
    await first
    await expect(runDictationBenchmark(wav(5), ['whisper'], deps({ recordingLive: () => true }))).rejects.toMatchObject({ status: 409, reason: 'recording_live' })
    expect(benchmarkRunning()).toBe(false)
    // A recording that starts between engines stops the run.
    let calls = 0
    await expect(runDictationBenchmark(wav(5), ['whisper', 'parakeet-ultra'], deps({ recordingLive: () => ++calls > 2 }))).rejects.toMatchObject({ reason: 'recording_live' })
    expect(benchmarkRunning()).toBe(false)
  })

  it('a hung engine times out and the next one still runs', async () => {
    const hung = deps({ engineTimeoutMs: 40, whisper: vi.fn(() => new Promise<{ text: string }>(() => {})), parakeet: vi.fn(async () => ({ text: 'quick' })) })
    const r = await runDictationBenchmark(wav(5), ['whisper', 'parakeet-ultra'], hung)
    expect(r.results[0]).toMatchObject({ engine: 'whisper', ran: false, skipped: 'timeout' })
    expect(r.results[1]).toMatchObject({ engine: 'parakeet-ultra', ran: true })
  })

  it('the total budget skips what it cannot fit', async () => {
    const d = deps({ totalTimeoutMs: 1000 })
    const r = await runDictationBenchmark(wav(5), ['whisper', 'parakeet-ultra'], d)
    expect(r.results[1]).toMatchObject({ engine: 'parakeet-ultra', ran: false, skipped: 'total_timeout' })
  })

  it('refuses audio that is not 16 kHz mono WAV, or longer than two minutes', async () => {
    await expect(runDictationBenchmark(Buffer.alloc(3200), ['whisper'], deps())).rejects.toBeInstanceOf(BenchmarkRefusedError)
    await expect(runDictationBenchmark(wav(121), ['whisper'], deps())).rejects.toMatchObject({ status: 413, reason: 'audio_too_large' })
  })

  it('a busy Parakeet lane is reported as busy', async () => {
    const busy = deps({ parakeet: vi.fn(async () => { throw Object.assign(new Error('the interactive lane is full'), { reason: 'busy' }) }) })
    expect((await runDictationBenchmark(wav(5), ['parakeet-ultra'], busy)).results[0]).toMatchObject({ ran: false, skipped: 'busy' })
  })
})

describe('parseBenchmarkEngines', () => {
  it('defaults to every engine and rejects unknown names', () => {
    expect(parseBenchmarkEngines(undefined)).toEqual(['whisper', 'parakeet-ultra'])
    expect(parseBenchmarkEngines('parakeet-ultra,whisper,whisper')).toEqual(['parakeet-ultra', 'whisper'])
    expect(parseBenchmarkEngines('cloud')).toBeNull()
    expect(parseBenchmarkEngines(['whisper'])).toBeNull()
  })
})
