import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECOVERED_RECEIPT, markRecoveredNoSpeech } from './unsaved-audio-quarantine.js'

/**
 * A quarantined capture that holds no speech must CLEAR, not retry forever.
 *
 * Measured on 2026-08-25: `meeting_1787606672705_1cl5cj`, 6 chunks, 33 seconds,
 * transcribing to zero words. The recover route threw
 * `recovery produced an empty transcript`, so the capture never got a receipt,
 * never left the unsaved list, and was retried on every boot and every button
 * press -- 1,131 failures in the stderr log, alternating with the auto-recover
 * path logging success for the same session. The panel said "1 recoverable".
 * The user pressed Recover and nothing happened, because nothing could.
 */

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cos-quarantine-'))
  mkdirSync(d, { recursive: true })
  return d
}

describe('a silent capture is receipted, not retried', () => {
  it('writes a receipt, which is what makes it leave the unsaved list', () => {
    const dir = scratchDir()
    expect(existsSync(join(dir, RECOVERED_RECEIPT))).toBe(false)
    markRecoveredNoSpeech(dir, 6)
    // listQuarantine reports `recovered` purely from this file's existence.
    expect(existsSync(join(dir, RECOVERED_RECEIPT)), 'no receipt means it retries forever').toBe(true)
  })

  it('records the outcome so silence is auditable, not indistinguishable from a save', () => {
    const dir = scratchDir()
    markRecoveredNoSpeech(dir, 6)
    const r = JSON.parse(readFileSync(join(dir, RECOVERED_RECEIPT), 'utf8'))
    expect(r.outcome, 'a no-speech receipt must not look like a normal save').toBe('no_speech')
    expect(r.words).toBe(0)
    expect(r.chunkFiles).toBe(6)
    expect(r.savedFilename, 'nothing was saved, so it must not claim a filename').toBeUndefined()
    expect(typeof r.recoveredAt).toBe('string')
  })

  it('does NOT delete the audio — a wrong silence verdict must stay recoverable', () => {
    const dir = scratchDir()
    writeFileSync(join(dir, 'chunk_0000.wav'), 'RIFF....')
    markRecoveredNoSpeech(dir, 1)
    expect(
      existsSync(join(dir, 'chunk_0000.wav')),
      'audio deleted on a silence verdict — a bad decode would destroy the capture',
    ).toBe(true)
  })

  it('is idempotent, so a repeat press cannot corrupt the receipt', () => {
    const dir = scratchDir()
    markRecoveredNoSpeech(dir, 6)
    markRecoveredNoSpeech(dir, 6)
    const r = JSON.parse(readFileSync(join(dir, RECOVERED_RECEIPT), 'utf8'))
    expect(r.outcome).toBe('no_speech')
  })
})

describe('the route no longer throws on an empty transcript', () => {
  it('receipts instead of throwing', () => {
    const src = readFileSync(new URL('../routes/meeting.ts', import.meta.url).pathname, 'utf8')
    expect(
      src.includes("throw new Error('recovery produced an empty transcript')"),
      'the throw is back — captures with no speech will retry forever again',
    ).toBe(false)
    const at = src.indexOf('if (!transcript.trim())')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 1400)).toContain('markRecoveredNoSpeech(quarantineDir')
  })
})
