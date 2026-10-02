import { describe, expect, it } from 'vitest'
import {
  absorbFlickers,
  channelForSpan,
  estimateTokenTimes,
  exclusiveTrackWav,
  readPcm16Mono,
  snapToPunctuation,
  splitTokens,
  tokenTimesFromWords,
  tracksIn,
} from './nemotron-segments.js'
import { activityOf, wavOf } from './__fixtures__/nemotron-helpers.js'

describe('word-to-track mapping', () => {
  it('maps each whisper word to the channel active under it', () => {
    // Channel 0 speaks 0-2 s, channel 3 speaks 2.5-5 s.
    const a = activityOf(5, [[0, 0, 2], [3, 2.5, 5]])
    const tokens = splitTokens('Yeah that works. So the budget moves.')
    const words = [
      { word: 'Yeah', start: 0.1, end: 0.4, probability: 0.9 },
      { word: 'that', start: 0.5, end: 0.8, probability: 0.9 },
      { word: 'works.', start: 0.9, end: 1.6, probability: 0.9 },
      { word: 'So', start: 2.6, end: 2.8, probability: 0.9 },
      { word: 'the', start: 2.9, end: 3.0, probability: 0.9 },
      { word: 'budget', start: 3.1, end: 3.6, probability: 0.9 },
      { word: 'moves.', start: 3.7, end: 4.2, probability: 0.9 },
    ]
    const times = tokenTimesFromWords(tokens, words)!
    expect(times).not.toBeNull()
    const channels = tokens.map((_, i) => channelForSpan(a, times[i].start, times[i].end))
    expect(channels).toEqual([0, 0, 0, 3, 3, 3, 3])
  })

  it('aligns sub-word whisper tokens to text words', () => {
    const tokens = splitTokens("I'm here")
    const words = [
      { word: 'I', start: 0.0, end: 0.2, probability: 1 },
      { word: "'m", start: 0.2, end: 0.4, probability: 1 },
      { word: 'here', start: 0.5, end: 0.9, probability: 1 },
    ]
    const times = tokenTimesFromWords(tokens, words)!
    expect(times[0].start).toBeCloseTo(0.0)
    expect(times[0].end).toBeCloseTo(0.4)
    expect(times[1].start).toBeCloseTo(0.5)
  })

  it('refuses word timings that do not match the text', () => {
    expect(tokenTimesFromWords(splitTokens('completely different words here'), [
      { word: 'nothing', start: 0, end: 1, probability: 1 },
      { word: 'alike', start: 1, end: 2, probability: 1 },
    ])).toBeNull()
  })

  it('a silent span takes the nearest active channel within the pad, and none beyond it', () => {
    const a = activityOf(4, [[2, 1.0, 2.0]])
    expect(channelForSpan(a, 2.1, 2.2)).toBe(2)
    expect(channelForSpan(a, 3.0, 3.2)).toBeNull()
  })

  it('an overlapping span goes to the channel with more probability mass', () => {
    const a = activityOf(3, [[0, 0, 3], [1, 1, 1.4]])
    expect(channelForSpan(a, 1.0, 1.4)).toBe(0) // equal mass: the lower channel index keeps it
    const strong = activityOf(3, [[0, 0, 3]], 0.6)
    for (let f = 100; f < 140; f++) strong.probs[f * 8 + 1] = 0.95
    expect(channelForSpan(strong, 1.0, 1.4)).toBe(1)
  })
})

describe('estimated timing (the live server path has no word clocks)', () => {
  it('lays the text over the speech frames in proportion to word length', () => {
    const a = activityOf(6, [[0, 0, 2], [1, 3, 6]])
    const tokens = splitTokens('aa bb cc dd')
    const times = estimateTokenTimes(tokens, a, 0, 6)!
    // 2 s + 3 s of speech, four equal words: 1.25 s of speech each.
    expect(times[0].start).toBeCloseTo(0)
    expect(times[1].end).toBeLessThanOrEqual(3.6)
    expect(times[3].end).toBeCloseTo(6, 1)
  })

  it('returns null when Nemotron heard no speech', () => {
    expect(estimateTokenTimes(['hello'], activityOf(2, []), 0, 2)).toBeNull()
  })

  it('moves a mid-phrase boundary to the phrase end within two words', () => {
    const tokens = splitTokens('Yeah. So the plan is set')
    expect(snapToPunctuation(tokens, [0, 0, 1, 1, 1, 1])).toEqual([0, 1, 1, 1, 1, 1])
    expect(snapToPunctuation(tokens, [0, 1, 1, 1, 1, 1])).toEqual([0, 1, 1, 1, 1, 1])
  })

  it('absorbs a one-word flicker between the same speaker', () => {
    const tokens = splitTokens('one two three four')
    const times = tokens.map((_, i) => ({ start: i * 0.3, end: i * 0.3 + 0.2 }))
    expect(absorbFlickers(tokens, [0, 0, 1, 0], times)).toEqual([0, 0, 0, 0])
    expect(absorbFlickers(tokens, [0, 0, 1, 1], times)).toEqual([0, 0, 1, 1])
  })
})

describe('tracks and their audio', () => {
  it('ignores a channel shorter than half a second', () => {
    const a = activityOf(6, [[0, 0, 5], [4, 5.2, 5.5]])
    expect(tracksIn(a, 0, a.frames).map(t => t.channel)).toEqual([0])
  })

  it('orders tracks by voiced time and counts exclusive time', () => {
    const a = activityOf(6, [[0, 0, 2], [1, 1.5, 6]])
    const tracks = tracksIn(a, 0, a.frames)
    expect(tracks.map(t => t.channel)).toEqual([1, 0])
    expect(tracks[0].exclusiveSec).toBeCloseTo(4, 1)
    expect(tracks[1].exclusiveSec).toBeCloseTo(1.5, 1)
  })

  it('cuts only the frames where the track speaks alone', () => {
    const a = activityOf(4, [[0, 0, 2], [1, 1, 4]])
    const pcm = readPcm16Mono(wavOf(4, t => (t < 2 ? 100 : -100)))!
    const wav0 = exclusiveTrackWav(a, 0, pcm)!
    expect((wav0.length - 44) / 32_000).toBeCloseTo(1, 1)
    const wav1 = exclusiveTrackWav(a, 1, pcm)!
    expect((wav1.length - 44) / 32_000).toBeCloseTo(2, 1)
    expect(wav1.readInt16LE(44)).toBe(-100)
  })
})
