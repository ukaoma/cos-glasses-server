import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { hqCliVadEnabled } from './whisper-local.js'

describe('hqCliVadEnabled (A0 word-loss gate)', () => {
  it('disables CLI --vad for interactive / default (prompt HQ)', () => {
    expect(hqCliVadEnabled('interactive')).toBe(false)
    expect(hqCliVadEnabled(undefined)).toBe(false)
  })

  it('enables CLI --vad for meeting batch when VAD model is present', () => {
    const modelPath = `${process.env.HOME}/.local/share/whisper-models/ggml-silero-v5.1.2.bin`
    const expected = process.env.COS_WHISPER_VAD !== '0' && existsSync(modelPath)
    expect(hqCliVadEnabled('batch')).toBe(expected)
  })
})
