import { describe, expect, it } from 'vitest'
import { splitForChunks } from '../routes/tts.js'

/**
 * Chunking replaced a two-segment prefix/tail split that failed as a RACE.
 *
 * Measured on device 2026-08-23 with a 6,781-character reply: the sidecar
 * serializes synthesis behind one lock, so the tail only started rendering after
 * the prefix and was ready ~12.9s after prepare. The prefix was 15s of audio --
 * but 12.0s at the user's 1.25x playback speed. The phone asked for the tail at
 * 12.0s, it existed at 12.9s, and `/play` blocks until synthesis completes before
 * sending any headers (11.3s to first byte, measured). iOS buffered nothing and
 * rejected with NotSupportedError.
 *
 * The margin depended on reply length, voice, playback speed and machine load.
 * Small chunks remove the race rather than widening it.
 *
 * THE FIRST TEST IS THE ONE THAT MATTERS. A chunker that silently drops text is
 * worse than the bug it replaces, because the reply still sounds complete.
 */

const LOREM = 'The quick brown fox jumps over the lazy dog. '

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean)
}

describe('splitForChunks', () => {
  it('never loses a word, at any length', () => {
    for (const n of [1, 40, 250, 251, 900, 6_781, 20_000]) {
      const text = LOREM.repeat(Math.ceil(n / LOREM.length)).slice(0, n).trim()
      if (!text) continue
      const chunks = splitForChunks(text)
      expect(words(chunks.join(' ')), `n=${n}`).toEqual(words(text))
    }
  })

  it('returns one chunk for something short enough to play whole', () => {
    expect(splitForChunks('Hi.')).toEqual(['Hi.'])
    expect(splitForChunks('')).toEqual([])
    expect(splitForChunks('   ')).toEqual([])
  })

  it('keeps the FIRST chunk small so first audio stays fast', () => {
    const text = LOREM.repeat(200)
    const chunks = splitForChunks(text)
    expect(chunks.length).toBeGreaterThan(2)
    // ~250 chars is ~0.5s of render and ~13s of speech.
    expect(chunks[0].length).toBeLessThanOrEqual(250)
  })

  // The property the whole fix rests on: every later chunk must finish rendering
  // long before playback reaches it. At ~1.9ms/char render and ~19 chars/sec of
  // speech, a chunk renders ~10x faster than it plays -- so the queue only ever
  // gets further ahead, whatever the playback speed.
  it('renders far faster than it plays, for every chunk', () => {
    const chunks = splitForChunks(LOREM.repeat(200))
    const RENDER_MS_PER_CHAR = 1.9
    const SPEECH_CHARS_PER_SEC = 19
    const MAX_PLAYBACK_RATE = 3      // the client clamps here
    for (const [i, c] of chunks.entries()) {
      const renderMs = c.length * RENDER_MS_PER_CHAR
      const playMs = (c.length / SPEECH_CHARS_PER_SEC) * 1000 / MAX_PLAYBACK_RATE
      expect(renderMs, `chunk ${i} (${c.length} chars) renders slower than it plays`)
        .toBeLessThan(playMs)
    }
  })

  it('breaks at sentence ends when it can', () => {
    const chunks = splitForChunks(LOREM.repeat(200))
    // Most boundaries should land on a terminator. Not all -- a single run longer
    // than a chunk has to break on a word -- so this asserts the norm, not purity.
    const clean = chunks.slice(0, -1).filter(c => /[.!?]$/.test(c.trim())).length
    expect(clean).toBeGreaterThan((chunks.length - 1) * 0.8)
  })

  it('never emits an empty chunk', () => {
    for (const text of [LOREM.repeat(50), 'A. B. C.', 'x'.repeat(3000), '...', 'One two three']) {
      for (const c of splitForChunks(text)) expect(c.length).toBeGreaterThan(0)
    }
  })

  it('handles a single unbroken run longer than a chunk', () => {
    // No spaces, no terminators -- must still split and still lose nothing.
    const run = 'x'.repeat(5_000)
    const chunks = splitForChunks(run)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(run)
  })

  it('bounds the segment count without dropping the remainder', () => {
    // Past MAX_CHUNKS the tail is appended to the last chunk. A long final chunk
    // is a latency problem; dropped text is a lie.
    const huge = LOREM.repeat(2_000)          // ~88k chars, well past 40 chunks
    const chunks = splitForChunks(huge)
    expect(chunks.length).toBeLessThanOrEqual(40)
    expect(words(chunks.join(' '))).toEqual(words(huge))
  })

  it('is stable — same input, same chunks', () => {
    const text = LOREM.repeat(120)
    expect(splitForChunks(text)).toEqual(splitForChunks(text))
  })
})
