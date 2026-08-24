import { describe, expect, it } from 'vitest'
import { LATER_CHUNK_CHARS, MAX_CHUNKS, splitForChunks } from '../routes/tts.js'

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

  // The property the whole fix rests on, stated CUMULATIVELY.
  //
  // The first version of this test compared one chunk's render time against its
  // own playback time. Both sides are linear in length, so it reduced to
  // `1.9 < 17.54` and passed for every input -- including LATER_CHUNK_CHARS =
  // 100_000, which restores the exact bug. A test that cannot fail is decoration.
  //
  // The real failure was cumulative and serialized: the sidecar renders behind
  // one lock, so segment k is not ready until segments 0..k have ALL rendered,
  // while playback only has to get through 0..k-1. That is the comparison.
  const RENDER_MS_PER_CHAR = 1.9      // measured on this machine
  const SPEECH_CHARS_PER_SEC = 19     // measured
  const MAX_PLAYBACK_RATE = 3         // voice-output.ts clamps here

  function worstMarginSec(chunks: string[], rate: number): number {
    let renderedMs = 0, playedMs = 0, worst = Infinity
    chunks.forEach((c, i) => {
      renderedMs += c.length * RENDER_MS_PER_CHAR
      // Segment 0 is requested at t=0 and simply blocks for its own render;
      // sub-second is fine and is not what broke. Margins start at segment 1.
      if (i > 0) worst = Math.min(worst, (playedMs - renderedMs) / 1000)
      playedMs += (c.length / SPEECH_CHARS_PER_SEC) * 1000 / rate
    })
    return worst
  }

  it('renders ahead of playback cumulatively, at every speed the client allows', () => {
    for (const chars of [6_781, 20_000, 40_000]) {
      const text = LOREM.repeat(Math.ceil(chars / LOREM.length)).slice(0, chars)
      const chunks = splitForChunks(text)
      for (const rate of [1, 1.25, 2, MAX_PLAYBACK_RATE]) {
        expect(worstMarginSec(chunks, rate), `${chars} chars at ${rate}x`)
          .toBeGreaterThan(0)
      }
    }
  })

  // The same measure applied to what actually shipped and failed: one 250-char
  // prefix and one 6,531-char tail at the user's 1.25x. If this ever passes, the
  // measure has stopped describing the bug.
  it('scores the OLD two-segment split as the failure it was', () => {
    const old = ['x'.repeat(250), 'x'.repeat(6_531)]
    expect(worstMarginSec(old, 1.25)).toBeLessThan(0)
  })

  it('covers the largest reply the local cap allows, without a giant final chunk', () => {
    // MAX_CHUNKS x LATER_CHUNK_CHARS must reach MAX_LOCAL_TTS_CHARS, or the
    // overflow lands in one oversized final segment -- which the OpenAI path then
    // trims PER SEGMENT, silently dropping text.
    const MAX_LOCAL_TTS_CHARS = 40_000
    const chunks = splitForChunks('x '.repeat(MAX_LOCAL_TTS_CHARS / 2))
    const longest = Math.max(...chunks.map((c) => c.length))
    // No segment may exceed the later-chunk cap. If MAX_CHUNKS stops covering the
    // input, the remainder is glued onto the last chunk and this blows past it.
    expect(longest).toBeLessThanOrEqual(LATER_CHUNK_CHARS * 1.1)
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
    const huge = LOREM.repeat(2_000)          // ~88k chars, well past the ceiling
    const chunks = splitForChunks(huge)
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS)
    expect(words(chunks.join(' '))).toEqual(words(huge))
  })

  it('is stable — same input, same chunks', () => {
    const text = LOREM.repeat(120)
    expect(splitForChunks(text)).toEqual(splitForChunks(text))
  })
})
