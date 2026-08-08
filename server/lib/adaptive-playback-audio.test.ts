import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  adaptivePlaybackAudio,
  adaptivePlaybackEnabled,
  adaptivePlaybackStatus,
  analyzePlaybackWav,
} from './adaptive-playback-audio.js'

function pcm16Wav(samples: number[], sampleRate = 16_000): Buffer {
  const dataBytes = samples.length * 2
  const out = Buffer.alloc(44 + dataBytes)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + dataBytes, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(dataBytes, 40)
  samples.forEach((sample, index) => out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), 44 + index * 2))
  return out
}

function sine(amplitude: number, frequency: number, seconds = 1): number[] {
  return Array.from({ length: 16_000 * seconds }, (_, i) => Math.round(amplitude * Math.sin(2 * Math.PI * frequency * i / 16_000)))
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cos-adaptive-playback-'))
  delete process.env.COS_MEETING_AUDIO_ADAPTIVE_PLAYBACK
})

afterEach(() => {
  delete process.env.COS_MEETING_AUDIO_ADAPTIVE_PLAYBACK
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('adaptive retained-audio profiling', () => {
  it('classifies clipped, quiet, low-frequency, and ordinary indoor captures deterministically', () => {
    const clipped = analyzePlaybackWav(pcm16Wav(Array.from({ length: 16_000 }, (_, i) => i % 3 === 0 ? 32767 : -32768)))
    const quiet = analyzePlaybackWav(pcm16Wav(sine(300, 500)))
    const wind = analyzePlaybackWav(pcm16Wav(sine(4_000, 60)))
    const indoor = analyzePlaybackWav(pcm16Wav(sine(2_600, 700)))

    expect(clipped?.profile).toBe('hot_clipped')
    expect(clipped?.clippedSampleRatio).toBeGreaterThan(0.5)
    expect(quiet?.profile).toBe('quiet')
    expect(wind?.profile).toBe('wind_noisy')
    expect(indoor?.profile).toBe('clean_indoor')
  })

  it('rejects malformed and unsupported audio instead of guessing', () => {
    expect(analyzePlaybackWav(Buffer.alloc(44))).toBeNull()
    const stereo = pcm16Wav(sine(1_000, 440))
    stereo.writeUInt16LE(2, 22)
    expect(analyzePlaybackWav(stereo)).toBeNull()
  })
})

describe('canary boundary', () => {
  it('is explicit opt-in and returns the immutable raw path when off', async () => {
    const session = join(dir, 'meeting-audio', 'meeting_a')
    mkdirSync(session, { recursive: true })
    const raw = join(session, 'chunk_0000.wav')
    writeFileSync(raw, pcm16Wav(sine(2_000, 440)))

    expect(adaptivePlaybackEnabled()).toBe(false)
    const result = await adaptivePlaybackAudio(raw)
    expect(result).toEqual({ path: raw, mode: 'raw', profile: null, reason: 'disabled' })
    expect(adaptivePlaybackStatus()).toMatchObject({
      supported: true,
      enabled: false,
      mode: 'retained_replay_only',
      rawPreserved: true,
      liveRecordingProtected: true,
    })
  })

  it('falls back to raw for an enabled canary with a non-PCM input', async () => {
    process.env.COS_MEETING_AUDIO_ADAPTIVE_PLAYBACK = '1'
    const session = join(dir, 'meeting-audio', 'meeting_b')
    mkdirSync(session, { recursive: true })
    const raw = join(session, 'chunk_0000.wav')
    writeFileSync(raw, Buffer.from('not audio'))

    const result = await adaptivePlaybackAudio(raw)
    expect(result.path).toBe(raw)
    expect(result.mode).toBe('raw')
    expect(result.reason).toBe('unsupported_wav')
  })
})
