import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBreaker } from './claude-circuit.js'

describe('createBreaker', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('stays closed below the failure threshold', () => {
    const b = createBreaker({ label: 'test', maxFailures: 2, cooldownMs: 1000 })
    expect(b.isOpen()).toBe(false)
    b.recordFailure()
    expect(b.isOpen()).toBe(false) // 1 < 2
  })

  it('opens at the threshold, then half-opens after the cooldown', () => {
    const b = createBreaker({ label: 'test', maxFailures: 2, cooldownMs: 1000 })
    b.recordFailure()
    b.recordFailure()
    expect(b.isOpen()).toBe(true) // 2 >= 2, within cooldown
    vi.advanceTimersByTime(1001)
    expect(b.isOpen()).toBe(false) // cooldown elapsed → half-open trial
  })

  it('closes again on success', () => {
    const b = createBreaker({ label: 'test', maxFailures: 2, cooldownMs: 1000 })
    b.recordFailure()
    b.recordFailure()
    expect(b.isOpen()).toBe(true)
    b.recordSuccess()
    expect(b.isOpen()).toBe(false)
  })
})
