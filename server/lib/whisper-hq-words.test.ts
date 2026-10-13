import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  classifyHighQualityTranscriptionCapability,
  getHighQualityCheckpointFingerprint,
  parseWhisperCliFullJson,
} from './whisper-local.js'

describe('batch HQ word restore (CPU whisper-cli -ojf)', () => {
  it('partitions progressive caches by timestamp mode and supports rollback', () => {
    const prior = process.env.COS_BATCH_HQ_TIMESTAMPS
    try {
      process.env.COS_BATCH_HQ_TIMESTAMPS = '0'
      const legacy = getHighQualityCheckpointFingerprint()
      process.env.COS_BATCH_HQ_TIMESTAMPS = '1'
      expect(getHighQualityCheckpointFingerprint()).not.toBe(legacy)
      process.env.COS_BATCH_HQ_TIMESTAMPS = '0'
      expect(getHighQualityCheckpointFingerprint()).toBe(legacy)
    } finally {
      if (prior === undefined) delete process.env.COS_BATCH_HQ_TIMESTAMPS
      else process.env.COS_BATCH_HQ_TIMESTAMPS = prior
    }
  })
  it('fails closed with a stable, path-free HQ capability reason', () => {
    expect(classifyHighQualityTranscriptionCapability({
      enabled: false, cliPresent: true, turboReady: true, largeV3Present: true,
    }).reason).toBe('hq_disabled')
    expect(classifyHighQualityTranscriptionCapability({
      enabled: true, cliPresent: false, turboReady: false, largeV3Present: false,
    }).reason).toBe('whisper_cli_missing')
    expect(classifyHighQualityTranscriptionCapability({
      enabled: true, cliPresent: true, turboReady: false, largeV3Present: true,
    }).reason).toBe('turbo_model_missing')
    expect(classifyHighQualityTranscriptionCapability({
      enabled: true, cliPresent: true, turboReady: true, largeV3Present: false,
    }).reason).toBe('large_v3_model_missing')
    expect(classifyHighQualityTranscriptionCapability({
      enabled: true, cliPresent: true, turboReady: true, largeV3Present: true,
    })).toEqual({ hqAvailable: true, model: 'large-v3', backend: 'whisper-cli', reason: null })
  })

  it('parses timed words and drops special tokens', () => {
    const parsed = parseWhisperCliFullJson(JSON.stringify({
      transcription: [{
        text: ' hello world',
        tokens: [
          { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 0.9 },
          { text: ' hello', offsets: { from: 0, to: 320 }, p: 0.8 },
          { text: ' world', offsets: { from: 320, to: 700 }, p: 0.7 },
          { text: '<|endoftext|>', offsets: { from: 700, to: 700 }, p: 0.1 },
        ],
      }],
    }))

    expect(parsed.text).toBe('hello world')
    expect(parsed.words).toEqual([
      { word: 'hello', start: 0, end: 0.32, probability: 0.8 },
      { word: 'world', start: 0.32, end: 0.7, probability: 0.7 },
    ])
  })

  it('merges sub-word tokens into spoken words on leading-space boundaries', () => {
    const parsed = parseWhisperCliFullJson(JSON.stringify({ transcription: [
      { text: " I'm Quilt-ing.", tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 1 },
        { text: ' I', offsets: { from: 20, to: 40 }, p: 0.8 },
        { text: "'m", offsets: { from: 50, to: 150 }, p: 0.9 },
        { text: ' Qu', offsets: { from: 150, to: 300 }, p: 0.7 },
        { text: 'ilt', offsets: { from: 300, to: 400 }, p: 0.95 },
        { text: '-ing.', offsets: { from: 400, to: 600 }, p: 0.6 },
      ] },
      { text: ' Next', tokens: [{ text: ' Next', offsets: { from: 700, to: 900 }, p: 0.5 }] },
    ] }))
    expect(parsed.words.map(w => w.word)).toEqual(['I', "'m", 'Qu', 'ilt', '-ing.', 'Next'])
    expect(parsed.spokenWords).toEqual([
      { word: "I'm", start: 0.02, end: 0.15, probability: 0.8 },
      { word: 'Quilt-ing.', start: 0.15, end: 0.6, probability: 0.6 },
      { word: 'Next', start: 0.7, end: 0.9, probability: 0.5 },
    ])
  })

  it('treats VAD-empty transcription arrays as safe empty results', () => {
    const parsed = parseWhisperCliFullJson(JSON.stringify({
      result: { language: 'en' },
      transcription: [],
    }))
    expect(parsed).toEqual({ text: '', words: [], spokenWords: [] })
  })

  it('keeps batch word capture on whisper-cli JSON, never live verbose_json', () => {
    const source = readFileSync(new URL('./whisper-local.ts', import.meta.url), 'utf8')
    expect(source).toContain("const captureWords = opts.priority === 'batch' || opts.words === true")
    expect(source).toContain("args.push('-ojf', '-of', outBase)")
    expect(source).toContain("formData.append('response_format', 'json')")
    expect(source).not.toMatch(/formData\.append\('response_format',\s*'verbose_json'\)/)
    expect(source).not.toContain("'-dtw'")
  })
})
