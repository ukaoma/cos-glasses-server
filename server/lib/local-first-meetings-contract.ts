export const LOCAL_FIRST_MEETINGS_PROTOCOL_VERSION = 1 as const
export const LOCAL_FIRST_MEETING_IDLE_RETENTION_MS = 4 * 60 * 60 * 1000

export interface LocalFirstMeetingsCapability {
  protocolVersion: typeof LOCAL_FIRST_MEETINGS_PROTOCOL_VERSION
  serverInstanceId: string
  idempotentSave: true
  sessionStatus: true
  retentionMs: number
}

export type MeetingSessionState = 'active' | 'closed' | 'saved' | 'missing'
export type IndexRange = [start: number, end: number]

export function localFirstMeetingsCapability(serverInstanceId: string | null): LocalFirstMeetingsCapability | null {
  if (!serverInstanceId) return null
  return {
    protocolVersion: LOCAL_FIRST_MEETINGS_PROTOCOL_VERSION,
    serverInstanceId,
    idempotentSave: true,
    sessionStatus: true,
    retentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS,
  }
}

/** Exact, compact representation of a sparse received-index ledger. */
export function compressIndexRanges(indices: readonly number[]): IndexRange[] {
  const sorted = Array.from(new Set(
    indices.filter(value => Number.isInteger(value) && value >= 0),
  )).sort((a, b) => a - b)
  if (sorted.length === 0) return []

  const ranges: IndexRange[] = []
  let start = sorted[0]
  let end = start
  for (let index = 1; index < sorted.length; index++) {
    const value = sorted[index]
    if (value === end + 1) {
      end = value
      continue
    }
    ranges.push([start, end])
    start = value
    end = value
  }
  ranges.push([start, end])
  return ranges
}

export function retainedUntilIso(lastActivityAt: number | null): string | null {
  if (lastActivityAt == null || !Number.isFinite(lastActivityAt)) return null
  return new Date(lastActivityAt + LOCAL_FIRST_MEETING_IDLE_RETENTION_MS).toISOString()
}
