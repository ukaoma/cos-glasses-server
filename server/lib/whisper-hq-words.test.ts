import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseWhisperCliFullJson } from './whisper-local.js'

describe('batch HQ word restore (CPU whisper-cli -ojf)', () => {
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

  it('treats VAD-empty transcription arrays as safe empty results', () => {
    const parsed = parseWhisperCliFullJson(JSON.stringify({
      result: { language: 'en' },
      transcription: [],
    }))
    expect(parsed).toEqual({ text: '', words: [] })
  })

  it('keeps batch word capture on whisper-cli JSON, never live verbose_json', () => {
    const source = readFileSync(new URL('./whisper-local.ts', import.meta.url), 'utf8')
    expect(source).toContain("const captureBatchWords = opts.priority === 'batch'")
    expect(source).toContain("args.push('-ojf', '-of', outBase)")
    expect(source).toContain("formData.append('response_format', 'json')")
    expect(source).not.toMatch(/formData\.append\('response_format',\s*'verbose_json'\)/)
    expect(source).not.toContain("'-dtw'")
  })
})
