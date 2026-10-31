import { describe, expect, it } from 'vitest'
import { MacParakeetUnavailableError } from './mac-recording-asr.js'
import { ParakeetError } from './parakeet.js'

describe('MacParakeetUnavailableError names what actually failed', () => {
  it('an error that never reached the CLI is not called cli_failed', () => {
    const error = new MacParakeetUnavailableError(new Error('secret words from the call'))
    expect(error.reason).toBe('mac_parakeet_internal')
    expect(error.message).toContain('(internal)')
    expect(error.message).not.toContain('cli_failed')
    expect(error.message).not.toContain('secret words')
  })

  it('a non-Error throw is internal too', () => {
    expect(new MacParakeetUnavailableError('text').reason).toBe('mac_parakeet_internal')
  })

  it('a real CLI failure keeps its reason and its exit data', () => {
    const error = new MacParakeetUnavailableError(new ParakeetError('cli_failed', '', { exitCode: 23, signal: null, stderr: 'fatal error' }))
    expect(error.reason).toBe('mac_parakeet_cli_failed')
    expect(error.message).toContain('(cli_failed)')
    expect(error.message).toContain('exit code=23')
  })

  it('the other Parakeet reasons pass through, for Mac and iPhone', () => {
    expect(new MacParakeetUnavailableError(new ParakeetError('timeout', 'slow')).reason).toBe('mac_parakeet_timeout')
    expect(new MacParakeetUnavailableError(new ParakeetError('busy', 'full'), 'iPhone').reason).toBe('phone_parakeet_busy')
    expect(new MacParakeetUnavailableError(new Error('x'), 'iPhone').reason).toBe('phone_parakeet_internal')
  })
})
