// speechWindowsFromWav executes against a mocked VAD. An unmeasured result must
// read as UNKNOWN, never as silence, and a long chunk is measured on its tail.
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.resetModules(); vi.doUnmock('./vad-silero.js') })

/** A 16 kHz mono 16-bit WAV of `seconds` seconds. */
function wav(seconds: number): Buffer {
  const pcm = Math.round(seconds * 16_000) * 2
  const b = Buffer.alloc(44 + pcm)
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16_000, 24); b.writeUInt32LE(32_000, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm, 40)
  return b
}

async function withVad(trim: (buf: Buffer) => unknown, available = true) {
  vi.resetModules()
  vi.doMock('./vad-silero.js', () => ({ isSileroAvailable: () => available, trimSilence: trim }))
  return (await import('./prompt-tail-guard.js'))
}

describe('speechWindowsFromWav (6.45.4)', () => {
  it('reports unknown when the VAD model is not loaded', async () => {
    const { speechWindowsFromWav, SPEECH_UNKNOWN } = await withVad(() => { throw new Error('must not be called') }, false)
    expect(speechWindowsFromWav(wav(3))).toEqual(SPEECH_UNKNOWN)
  })

  it('reports unknown, not silence, when the VAD fell back without measuring (short audio, internal error)', async () => {
    const { speechWindowsFromWav, SPEECH_UNKNOWN } = await withVad(() => ({ trimmedWav: Buffer.alloc(0), speechRatio: 0, segments: [] }))
    expect(speechWindowsFromWav(wav(3))).toEqual(SPEECH_UNKNOWN)
    const { speechWindowsFromWav: throwing } = await withVad(() => { throw new Error('onnx') })
    expect(throwing(wav(3))).toEqual(SPEECH_UNKNOWN)
  })

  it('takes the end of the last measured speech window', async () => {
    const { speechWindowsFromWav } = await withVad(() => ({
      trimmedWav: Buffer.alloc(0), speechRatio: 0.4, measured: true,
      segments: [{ startSample: 16_000, sampleCount: 32_000 }, { startSample: 80_000, sampleCount: 24_000 }],
    }))
    expect(speechWindowsFromWav(wav(7))).toEqual({ available: true, lastSpeechEndSec: 6.5, speechRatio: 0.4, whole: true })
  })

  it('a measured silent chunk reports speech end 0 and whole', async () => {
    const { speechWindowsFromWav } = await withVad(() => ({ trimmedWav: Buffer.alloc(0), speechRatio: 0, segments: [], measured: true }))
    expect(speechWindowsFromWav(wav(4))).toEqual({ available: true, lastSpeechEndSec: 0, speechRatio: 0, whole: true })
  })

  it('measures only the last 10 s of a long chunk and offsets the windows', async () => {
    const seen: number[] = []
    const { speechWindowsFromWav, TAIL_WINDOW_SEC } = await withVad((buf: Buffer) => {
      seen.push(buf.length)
      return { trimmedWav: Buffer.alloc(0), speechRatio: 0.1, segments: [{ startSample: 8_000, sampleCount: 16_000 }], measured: true }
    })
    // 25 s chunk: the VAD sees a 10 s window starting at 15 s; a segment ending
    // 1.5 s into the window ends at 16.5 s of the chunk.
    const r = speechWindowsFromWav(wav(25))
    expect(seen).toEqual([44 + TAIL_WINDOW_SEC * 32_000])
    expect(r).toEqual({ available: true, lastSpeechEndSec: 16.5, speechRatio: 0.1, whole: false })
    // and a silent tail reports the window offset, not 0
    const { speechWindowsFromWav: silent } = await withVad(() => ({ trimmedWav: Buffer.alloc(0), speechRatio: 0, segments: [], measured: true }))
    expect(silent(wav(25))).toEqual({ available: true, lastSpeechEndSec: 15, speechRatio: 0, whole: false })
  })

  it('hands an odd-length body over whole rather than windowing it off a sample boundary', async () => {
    const seen: number[] = []
    const { speechWindowsFromWav } = await withVad((buf: Buffer) => {
      seen.push(buf.length)
      // the real VAD refuses an odd body (Int16Array on an odd byteLength throws) -> unmeasured
      return { trimmedWav: Buffer.alloc(0), speechRatio: 0, segments: [] }
    })
    const odd = Buffer.concat([wav(25), Buffer.alloc(1)])
    expect(speechWindowsFromWav(odd).available).toBe(false)
    expect(seen).toEqual([odd.length])
  })
})
