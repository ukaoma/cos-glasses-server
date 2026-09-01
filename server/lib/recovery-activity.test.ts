import { EventEmitter } from 'node:events'
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetRecoveryActivityForTests,
  acquireMaintenance,
  createRecordingLease,
  getRecoveryActivityStatus,
  recoveryAdmissionMiddleware,
  redactCapabilityPath,
  releaseRecordingLease,
  classifyRecoveryRoute,
  tryAcquireOperationLease,
} from './recovery-activity.js'

const TICKET = `1780000000.${'a'.repeat(64)}`

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

  /**
   * EXEMPT_EXACT matches whole strings, so the ticketed form the 6.42.0 display
   * stream added would otherwise classify as 'request' and take a lease. SSE has no
   * `finish`, and `close` only downgrades a lease to a 120s grace window a live
   * socket never reaches — one connected lens would hold the recovery gate open
   * indefinitely and 409 every COS Control server restart.
   */
  it('exempts the ticketed display stream, not just the bare path', () => {
    expect(classifyRecoveryRoute('GET', '/api/display-stream')).toBe('exempt')
    expect(classifyRecoveryRoute('GET', `/api/display-stream/${TICKET}`)).toBe('exempt')
    expect(classifyRecoveryRoute('GET', `/api/display-stream/${TICKET}?bootId=x&eventId=3`)).toBe('exempt')
    expect(classifyRecoveryRoute('HEAD', `/api/display-stream/${TICKET}`)).toBe('exempt')
    // The prefix must not become a wildcard for the rest of the API.
    expect(classifyRecoveryRoute('POST', `/api/display-stream/${TICKET}`)).toBe('operation')
    expect(classifyRecoveryRoute('GET', '/api/display-session')).toBe('request')
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

/**
 * GET /api/recovery/status publishes every lease `kind` verbatim. A kind built from
 * the raw request path would therefore republish a LIVE bearer capability — a valid
 * display ticket, or a TTS playback UUID — as plain text in a diagnostic response.
 */
describe('lease kinds never republish a capability URL', () => {
  function runMiddleware(method: string, url: string): void {
    const res = new EventEmitter() as unknown as Response
    const req = { method, originalUrl: url, path: url.split('?')[0] } as unknown as Request
    const next = (() => {}) as NextFunction
    recoveryAdmissionMiddleware(req, res, next)
  }

  it('redacts the ticket and the TTS capability at the point the kind is built', () => {
    expect(redactCapabilityPath(`/api/display-stream/${TICKET}`)).toBe('/api/display-stream/<ticket>')
    expect(redactCapabilityPath('/api/tts/play/00000000-0000-4000-8000-000000000000'))
      .toBe('/api/tts/play/<capability>')
    // Paths with nothing to hide pass through untouched.
    expect(redactCapabilityPath('/api/display-stream')).toBe('/api/display-stream')
    expect(redactCapabilityPath('/api/models')).toBe('/api/models')
  })

  it('never records a ticket in an active lease, even on a non-exempt method', () => {
    // POST is not exempt, so this DOES take a lease — which is exactly the case
    // where an unredacted kind would surface on /api/recovery/status.
    runMiddleware('POST', `/api/display-stream/${TICKET}`)
    const kinds = getRecoveryActivityStatus().active.map(entry => entry.kind)
    expect(kinds).toContain('POST /api/display-stream/<ticket>')
    for (const kind of kinds) expect(kind).not.toContain('a'.repeat(64))
  })

  it('takes no lease at all for the exempt ticketed GET', () => {
    runMiddleware('GET', `/api/display-stream/${TICKET}`)
    expect(getRecoveryActivityStatus().active).toEqual([])
  })
})
