// speechWindowsFromWav executes against a mocked VAD: unavailable must read as "unknown", never as silence.
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.resetModules(); vi.doUnmock('./vad-silero.js') })

describe('speechWindowsFromWav (6.45.4)', () => {
  it('reports unavailable, not silence, when the VAD model is not loaded', async () => {
    vi.doMock('./vad-silero.js', () => ({
      isSileroAvailable: () => false,
      trimSilence: () => { throw new Error('must not be called when unavailable') },
    }))
    const { speechWindowsFromWav } = await import('./prompt-tail-guard.js')
    expect(speechWindowsFromWav(Buffer.alloc(64_000))).toEqual({ available: false, lastSpeechEndSec: null, speechRatio: 0 })
  })

  it('takes the end of the last speech window from the VAD segments', async () => {
    vi.doMock('./vad-silero.js', () => ({
      isSileroAvailable: () => true,
      trimSilence: () => ({
        trimmedWav: Buffer.alloc(0), speechRatio: 0.4,
        segments: [{ startSample: 16_000, sampleCount: 32_000 }, { startSample: 80_000, sampleCount: 24_000 }],
      }),
    }))
    const { speechWindowsFromWav } = await import('./prompt-tail-guard.js')
    expect(speechWindowsFromWav(Buffer.alloc(64_000))).toEqual({ available: true, lastSpeechEndSec: 6.5, speechRatio: 0.4 })
  })

  it('reports no window when the VAD heard nothing', async () => {
    vi.doMock('./vad-silero.js', () => ({
      isSileroAvailable: () => true,
      trimSilence: () => ({ trimmedWav: Buffer.alloc(0), speechRatio: 0, segments: [] }),
    }))
    const { speechWindowsFromWav } = await import('./prompt-tail-guard.js')
    expect(speechWindowsFromWav(Buffer.alloc(64_000))).toEqual({ available: true, lastSpeechEndSec: null, speechRatio: 0 })
  })
})
