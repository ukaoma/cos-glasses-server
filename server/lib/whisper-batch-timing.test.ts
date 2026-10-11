import { afterEach, describe, expect, it } from 'vitest'
import { batchTimestampCanaryEnabled, mapVadTime, parseNativeVadTimeline, remapBatchWords } from './whisper-batch-timing.js'

const log = `whisper_vad: detected 2 speech segments
whisper_vad: vad_segment_info: orig_start: 2.00, orig_end: 3.00, vad_start: 0.00, vad_end: 1.00
whisper_vad: vad_segment_info: orig_start: 7.00, orig_end: 8.00, vad_start: 1.20, vad_end: 2.20
whisper_vad: Reduced audio from 160000 to 35200 samples (78.0% reduction)
`
const originalFlag = process.env.COS_BATCH_HQ_TIMESTAMPS
afterEach(() => {
  if (originalFlag === undefined) delete process.env.COS_BATCH_HQ_TIMESTAMPS
  else process.env.COS_BATCH_HQ_TIMESTAMPS = originalFlag
})
describe('batch timestamp canary', () => {
  it('requires explicit opt-in; rollback and unknown values retain the baseline', () => {
    for (const value of [undefined, '', '0', 'true', '2']) {
      if (value === undefined) delete process.env.COS_BATCH_HQ_TIMESTAMPS
      else process.env.COS_BATCH_HQ_TIMESTAMPS = value
      expect(batchTimestampCanaryEnabled()).toBe(false)
    }
    process.env.COS_BATCH_HQ_TIMESTAMPS = '1'
    expect(batchTimestampCanaryEnabled()).toBe(true)
  })
  it('uses native overlap and maps gap tokens to speech boundaries', () => {
    const table = parseNativeVadTimeline(log)
    expect(mapVadTime(0.3, table)).toBeCloseTo(2.3)
    expect(mapVadTime(1.05, table)).toBe(3)
    expect(mapVadTime(1.15, table)).toBe(7)
    expect(mapVadTime(1.5, table)).toBeCloseTo(7.3)
    expect(mapVadTime(9, table)).toBe(8)
    expect(remapBatchWords([{ word: 'review', start: 1.5, end: 1.8, probability: 0.8 }], log, true)[0]).toMatchObject({ start: 7.3, end: 7.6 })
  })
  it('rejects incomplete, reordered, duplicated and inconsistent native evidence', () => {
    for (const bad of [
      '', log.replace('detected 2', 'detected 3'), log + log,
      log.replace('35200', '80000'), log.replace('orig_start: 7.00', 'orig_start: 1.00'),
      log.replace('vad_start: 1.20', 'vad_start: 0.90'),
      log.replace('orig_end: 8.00', 'orig_end: 80.00'),
      log.split('\n').filter(line => !line.includes('Reduced audio')).join('\n'),
    ]) expect(() => parseNativeVadTimeline(bad)).toThrow()
  })
  it('accepts native VAD-empty output without a mapping and keeps no-VAD clocks', () => {
    expect(remapBatchWords([], '', true)).toEqual([])
    const words = [{ word: 'hello', start: 0.1, end: 0.4, probability: 0.8 }]
    expect(remapBatchWords(words, '', false)).toEqual(words)
    for (const [start, end] of [[NaN, 1], [-1, 1], [2, -1], [0, Infinity]]) {
      expect(() => remapBatchWords([{ ...words[0], start, end }], log, true)).toThrow()
    }
    const backwards = remapBatchWords([{ ...words[0], start: 1.5, end: 1.4 }], log, true)[0]
    expect(backwards.end).toBe(backwards.start)
  })
  it('bounds legitimate final Silero padding to the actual audio duration', () => {
    const padded = log.replace('orig_end: 8.00', 'orig_end: 10.02')
    expect(parseNativeVadTimeline(padded).at(-1)!.originalEnd).toBe(10)
    expect(() => parseNativeVadTimeline(padded.replace('10.02', '10.50'))).toThrow()
  })
})
