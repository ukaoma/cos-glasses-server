import { describe, it, expect } from 'vitest'
import { resolveWhisperBinary } from '../../bin/whisper-runtime.cjs'

describe('Whisper runtime path contract', () => {
  it('uses the managed path even without Homebrew or PATH', () => {
    const path = '/Users/new user/Library/Application Support/COS Control/runtime/whisper/1.9.1/bin/whisper-server'
    expect(resolveWhisperBinary('whisper-server', { COS_WHISPER_SERVER_BIN: path }, p => p === path)).toBe(path)
  })
  it('fails closed for a missing or relative override even when brew works', () => {
    for (const path of ['/missing/server', 'relative/server', '   ']) {
      expect(resolveWhisperBinary('whisper-server', { COS_WHISPER_SERVER_BIN: path }, p => p.startsWith('/opt/homebrew'))).toBeNull()
    }
  })
  it('keeps separate overrides and the existing fallback order', () => {
    expect(resolveWhisperBinary('whisper-cli', { COS_WHISPER_SERVER_BIN: '/other' }, p => p === '/usr/local/bin/whisper-cli')).toBe('/usr/local/bin/whisper-cli')
    expect(resolveWhisperBinary('whisper-cli', { PATH: '/custom:relative' }, p => p === '/custom/whisper-cli')).toBe('/custom/whisper-cli')
    expect(resolveWhisperBinary('whisper-cli', { PATH: '.' }, () => false)).toBeNull()
  })
})
