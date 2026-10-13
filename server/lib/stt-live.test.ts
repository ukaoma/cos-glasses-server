import { describe, expect, it, vi } from 'vitest'

vi.mock('./audio-enhance.js', () => ({ enhanceAudio: vi.fn(async (audio: Buffer, opts?: { profile?: string }) => Buffer.concat([audio, Buffer.from(opts?.profile ?? 'full')])) }))
const { decideQuiet, asrFrontEnd, QUIET_SPEECH_SEC, chunkRms, silenceDropsAllowed } = await import('./stt-live.js')

function wav(amplitude: number, seconds = 6): Buffer {
  const n = seconds * 16_000
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) pcm.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24); h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

describe('live quiet gate (6.72.0)', () => {
  const vad = (seconds: number | null, available = true) => ({ available: () => available, speechSeconds: () => seconds })

  it('silero: quiet below the speech threshold, regardless of loudness', () => {
    expect(decideQuiet(wav(3000), 'silero', vad(QUIET_SPEECH_SEC - 0.01))).toMatchObject({ isQuiet: true, gate: 'silero' })
    expect(decideQuiet(wav(3000), 'silero', vad(QUIET_SPEECH_SEC))).toMatchObject({ isQuiet: false, gate: 'silero' })
    expect(decideQuiet(wav(10), 'silero', vad(4))).toMatchObject({ isQuiet: false, gate: 'silero', speechSec: 4 })
  })

  it('silero unavailable or unmeasured falls back to the RMS gate, never to "quiet"', () => {
    expect(decideQuiet(wav(3000), 'silero', vad(null))).toMatchObject({ isQuiet: false, gate: 'rms_fallback', speechSec: null })
    expect(decideQuiet(wav(100), 'silero', vad(null))).toMatchObject({ isQuiet: true, gate: 'rms_fallback' })
    expect(decideQuiet(wav(3000), 'silero', vad(0, false))).toMatchObject({ isQuiet: false, gate: 'rms' })
  })

  it('rms setting keeps the pre-6.72 gate (RMS below 150) and never asks Silero', () => {
    const speechSeconds = vi.fn(() => 0)
    expect(decideQuiet(wav(149), 'rms', { available: () => true, speechSeconds })).toMatchObject({ isQuiet: true, gate: 'rms' })
    expect(decideQuiet(wav(151), 'rms', { available: () => true, speechSeconds })).toMatchObject({ isQuiet: false, gate: 'rms' })
    expect(speechSeconds).not.toHaveBeenCalled()
    expect(Math.round(chunkRms(wav(200)))).toBe(200)
  })

  it('silence text drops stay on RMS, even when Silero calls the chunk quiet', () => {
    const loudShortName = decideQuiet(wav(3000), 'silero', vad(0.3))
    expect(loudShortName.isQuiet).toBe(true)
    expect(silenceDropsAllowed(loudShortName)).toBe(false)
    expect(silenceDropsAllowed(decideQuiet(wav(100), 'silero', vad(0.1)))).toBe(true)
  })

  it('front end: highpass is the light profile, full is the old chain', async () => {
    const a = Buffer.from('x')
    expect((await asrFrontEnd(a, 'highpass')).toString()).toBe('xlight')
    expect((await asrFrontEnd(a, 'full')).toString()).toBe('xfull')
  })
})

describe('Silero speech seconds on real audio (sherpa, windowed)', () => {
  it('hears both phrases of a 5 s synthetic clip (about 3.6 s of speech)', async () => {
    const { readFileSync } = await import('node:fs')
    const { initSileroVAD, measureSpeechSeconds } = await import('./vad-silero.js')
    expect(initSileroVAD()).toBe(true)
    const clip = readFileSync(new URL('./__fixtures__/synthetic-speech-two-phrases.wav', import.meta.url))
    const seconds = measureSpeechSeconds(clip)!
    expect(seconds).toBeGreaterThan(3)
    expect(seconds).toBeLessThan(4.6)
    const silence = Buffer.concat([clip.subarray(0, 44), Buffer.alloc(clip.length - 44)])
    expect(measureSpeechSeconds(silence)).toBe(0)
    expect(measureSpeechSeconds(clip.subarray(0, 100))).toBeNull()
  })
})
