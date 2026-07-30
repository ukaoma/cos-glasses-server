import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleManagedServerRestart } from './managed-restart.js'

describe('scheduleManagedServerRestart', () => {
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.COS_DISABLE_SELF_RESTART
    delete process.env.COS_LAUNCHD_LABEL
  })

  it('kickstarts the Control LaunchAgent instead of relying on SIGTERM exit 0', () => {
    vi.useFakeTimers()
    const kickstart = vi.fn()
    const exitProcess = vi.fn()
    scheduleManagedServerRestart({ kickstart, exitProcess, delayMs: 10 })
    vi.advanceTimersByTime(10)
    expect(kickstart).toHaveBeenCalledTimes(1)
    const args = kickstart.mock.calls[0][0] as string[]
    expect(args[0]).toBe('kickstart')
    expect(args[1]).toBe('-k')
    expect(args[2]).toMatch(/^gui\/\d+\/com\.cos\.glasses-server$/)
    expect(exitProcess).not.toHaveBeenCalled()
  })

  it('falls back to exit(1) so KeepAlive SuccessfulExit:false restarts', () => {
    vi.useFakeTimers()
    const kickstart = vi.fn(() => { throw new Error('no launchctl') })
    const exitProcess = vi.fn()
    const onError = vi.fn()
    scheduleManagedServerRestart({ kickstart, exitProcess, onError, delayMs: 10 })
    vi.advanceTimersByTime(10)
    expect(onError).toHaveBeenCalled()
    expect(exitProcess).toHaveBeenCalledWith(1)
  })

  it('honors COS_DISABLE_SELF_RESTART', () => {
    vi.useFakeTimers()
    process.env.COS_DISABLE_SELF_RESTART = '1'
    const kickstart = vi.fn()
    scheduleManagedServerRestart({ kickstart, delayMs: 10 })
    vi.advanceTimersByTime(10)
    expect(kickstart).not.toHaveBeenCalled()
  })
})
