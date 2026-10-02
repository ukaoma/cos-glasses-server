import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDiarizer, requestedDiarizer } from './diarizer-backend.js'

afterEach(() => {
  delete process.env.COS_DIARIZER
  delete process.env.COS_NEMOTRON_CLI
})

describe('requestedDiarizer', () => {
  it('defaults to nemotron', () => {
    expect(requestedDiarizer({})).toBe('nemotron')
  })

  it('accepts the voiceprint aliases', () => {
    expect(requestedDiarizer({ COS_DIARIZER: 'embedding' })).toBe('embedding')
    expect(requestedDiarizer({ COS_DIARIZER: 'eres2net' })).toBe('embedding')
    expect(requestedDiarizer({ COS_DIARIZER: 'voiceprint' })).toBe('embedding')
  })

  it('treats an unknown value as nemotron', () => {
    expect(requestedDiarizer({ COS_DIARIZER: 'sortformer' })).toBe('nemotron')
  })
})

describe('activeDiarizer', () => {
  it('stays on the voiceprint when that is requested', () => {
    expect(activeDiarizer({ COS_DIARIZER: 'embedding' })).toEqual({
      requested: 'embedding',
      active: 'embedding',
      fallback: null,
    })
  })

  it('falls back when Nemotron is requested and the CLI is missing', () => {
    expect(activeDiarizer({ COS_DIARIZER: 'nemotron', COS_NEMOTRON_CLI: '/no/such/fluidaudiocli' })).toEqual({
      requested: 'nemotron',
      active: 'embedding',
      fallback: 'cli_missing',
    })
  })

  it('uses Nemotron when the CLI file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nemotron-cli-'))
    const cli = join(dir, 'fluidaudiocli')
    writeFileSync(cli, '')
    expect(activeDiarizer({ COS_DIARIZER: 'nemotron', COS_NEMOTRON_CLI: cli })).toEqual({
      requested: 'nemotron',
      active: 'nemotron',
      fallback: null,
    })
    rmSync(dir, { recursive: true, force: true })
  })
})
