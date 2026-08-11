import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetRecoveryActivityForTests,
  acquireMaintenance,
  createRecordingLease,
  getRecoveryActivityStatus,
  releaseRecordingLease,
  classifyRecoveryRoute,
  tryAcquireOperationLease,
} from './recovery-activity.js'

afterEach(() => {
  vi.useRealTimers()
  __resetRecoveryActivityForTests()
})

describe('recovery activity admission', () => {
  it('blocks maintenance while a recording lease is active', () => {
    createRecordingLease('prompt-recording', 'draft-1')
    const gate = acquireMaintenance()
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.busy[0]).toMatchObject({ kind: 'prompt-recording', id: 'draft-1' })
    gate.release()
  })

  it('expires abandoned recording leases so recovery cannot brick permanently', () => {
    vi.useFakeTimers()
    createRecordingLease('meeting-recording', 'meeting-1')
    vi.advanceTimersByTime(20_001)
    const gate = acquireMaintenance()
    expect(gate.ok).toBe(true)
    gate.release()
  })

  it('closes admission atomically until the maintenance holder releases it', () => {
    const first = acquireMaintenance()
    expect(first.ok).toBe(true)
    const second = acquireMaintenance()
    expect(second.ok).toBe(false)
    first.release()
    expect(getRecoveryActivityStatus().maintenance).toBe(false)
  })

  it('explicit release clears a recording lease immediately', () => {
    createRecordingLease('prompt-recording', 'draft-2')
    releaseRecordingLease('draft-2')
    expect(getRecoveryActivityStatus().active).toEqual([])
  })

  it('classifies live streams as exempt and stateful reads/mutations as operations', () => {
    expect(classifyRecoveryRoute('GET', '/api/display-stream')).toBe('exempt')
    expect(classifyRecoveryRoute('GET', '/api/models')).toBe('operation')
    expect(classifyRecoveryRoute('GET', '/api/media/abc/content?variant=g2')).toBe('operation')
    expect(classifyRecoveryRoute('POST', '/v1/chat/completions')).toBe('operation')
    expect(classifyRecoveryRoute('GET', '/api/cli-session')).toBe('request')
  })

  it('holds explicit operation owners until true settlement', () => {
    const lease = tryAcquireOperationLease('prompt-finalize', 'draft-1')
    expect(lease.ok).toBe(true)
    const failedGate = acquireMaintenance()
    expect(failedGate.ok).toBe(false)
    // Release the failed maintenance gate before settling the operation.
    failedGate.release()
    if (lease.ok) lease.release()
    const gate = acquireMaintenance()
    expect(gate.ok).toBe(true)
    gate.release()
  })
})
