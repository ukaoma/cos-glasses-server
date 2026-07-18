import { describe, expect, it } from 'vitest'
import {
  LOCAL_FIRST_MEETING_IDLE_RETENTION_MS,
  compressIndexRanges,
  localFirstMeetingsCapability,
  retainedUntilIso,
} from './local-first-meetings-contract.js'

describe('local-first meetings server contract', () => {
  it('advertises only after stable server identity exists', () => {
    expect(localFirstMeetingsCapability(null)).toBeNull()
    expect(localFirstMeetingsCapability('server-stable-id')).toEqual({
      protocolVersion: 1,
      serverInstanceId: 'server-stable-id',
      idempotentSave: true,
      sessionStatus: true,
      retentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS,
    })
  })

  it('compresses sparse, duplicated, and out-of-order indices exactly', () => {
    expect(compressIndexRanges([7, 2, 1, 2, -1, 4, 3, 10, 9, Number.NaN])).toEqual([
      [1, 4],
      [7, 7],
      [9, 10],
    ])
  })

  it('derives retention from last activity rather than meeting start', () => {
    const lastActivityAt = Date.UTC(2026, 6, 17, 18, 30, 0)
    expect(retainedUntilIso(lastActivityAt)).toBe(
      new Date(lastActivityAt + LOCAL_FIRST_MEETING_IDLE_RETENTION_MS).toISOString(),
    )
    expect(retainedUntilIso(null)).toBeNull()
  })
})
