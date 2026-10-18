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

  it('6.78.0 (P7 S4): marks the exit clean before the kickstart, and before the exit(1) fallback', () => {
    vi.useFakeTimers()
    const order: string[] = []
    const kickstart = vi.fn(() => { order.push('kickstart') })
    const exitProcess = vi.fn(() => { order.push('exit') })
    scheduleManagedServerRestart({ kickstart, exitProcess, delayMs: 10, beforeRestart: () => order.push('clean') })
    vi.advanceTimersByTime(10)
    expect(order).toEqual(['clean', 'kickstart'])
    // kickstart did not kill us: the fallback exit(1) comes after the clean mark.
    vi.advanceTimersByTime(2_000)
    expect(order).toEqual(['clean', 'kickstart', 'exit'])

    const failing: string[] = []
    scheduleManagedServerRestart({
      kickstart: () => { failing.push('kickstart'); throw new Error('no launchctl') },
      exitProcess: () => { failing.push('exit') },
      onError: () => {},
      delayMs: 10,
      beforeRestart: () => failing.push('clean'),
    })
    vi.advanceTimersByTime(10)
    expect(failing).toEqual(['clean', 'kickstart', 'exit'])
  })

  it('6.78.0 (P7 S4): a throwing beforeRestart never stops the restart', () => {
    vi.useFakeTimers()
    const kickstart = vi.fn()
    const onError = vi.fn()
    scheduleManagedServerRestart({ kickstart, onError, delayMs: 10, beforeRestart: () => { throw new Error('ledger') } })
    vi.advanceTimersByTime(10)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(kickstart).toHaveBeenCalledTimes(1)
  })

  it('honors COS_DISABLE_SELF_RESTART (and then marks nothing clean)', () => {
    vi.useFakeTimers()
    process.env.COS_DISABLE_SELF_RESTART = '1'
    const beforeRestart = vi.fn()
    scheduleManagedServerRestart({ kickstart: vi.fn(), delayMs: 10, beforeRestart })
    vi.advanceTimersByTime(10)
    expect(beforeRestart).not.toHaveBeenCalled()
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
