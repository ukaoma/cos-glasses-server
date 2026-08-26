// Even Hub 0.0.14 wearer-vs-other histogram, carried on a meeting chunk.
// Identity is a suggestion. This module parses and logs. It does not name
// people and does not change identifyChunkSpeaker.

export type EvenSpeakerRole = 'self' | 'other' | 'unknown'
export type EvenSpeakerRoleMajority = EvenSpeakerRole | 'tie'

export interface EvenSpeakerRoleHistogram {
  schema: 1
  frames: number
  self: number
  other: number
  unknown: number
  majority: EvenSpeakerRoleMajority
  directionPresent: number
  directionLast: number | null
}

export type EvenSpeakerRoleMode = 'off' | 'log' | 'apply'

export function evenSpeakerRoleMode(): EvenSpeakerRoleMode {
  const raw = (process.env.COS_EVEN_SPEAKER_ROLE ?? 'log').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off'
  if (raw === 'apply') return 'apply'
  return 'log'
}

let applyNotImplementedWarned = false

/** Gate A is not in this slice. apply must not silently change labels. */
export function warnEvenSpeakerRoleApplyNotImplemented(): void {
  if (evenSpeakerRoleMode() !== 'apply' || applyNotImplementedWarned) return
  applyNotImplementedWarned = true
  console.warn('[even-role] COS_EVEN_SPEAKER_ROLE=apply is not implemented; logging only')
}

function majorityOf(self: number, other: number, unknown: number, frames: number): EvenSpeakerRoleMajority {
  if (frames <= 0) return 'unknown'
  if (self > other && self > unknown) return 'self'
  if (other > self && other > unknown) return 'other'
  if (unknown > self && unknown > other) return 'unknown'
  return 'tie'
}

function asNonNegInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null
  return n
}

/** Compact query `eh=self,other,unknown,frames,directionPresent,directionLast`. */
export function parseEvenHubSpeakerRoleQuery(raw: unknown): EvenSpeakerRoleHistogram | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const parts = raw.split(',')
  if (parts.length < 4 || parts.length > 6) return undefined
  const self = asNonNegInt(parts[0])
  const other = asNonNegInt(parts[1])
  const unknown = asNonNegInt(parts[2])
  const frames = asNonNegInt(parts[3])
  if (self == null || other == null || unknown == null || frames == null) return undefined
  if (self + other + unknown !== frames) return undefined
  const directionPresent = parts.length >= 5 ? asNonNegInt(parts[4]) : 0
  if (directionPresent == null) return undefined
  let directionLast: number | null = null
  if (parts.length === 6 && parts[5] !== '') {
    const last = Number(parts[5])
    if (!Number.isFinite(last)) return undefined
    directionLast = last
  }
  return {
    schema: 1,
    frames,
    self,
    other,
    unknown,
    majority: majorityOf(self, other, unknown, frames),
    directionPresent,
    directionLast,
  }
}

export function parseEvenHubSpeakerRoleBody(raw: unknown): EvenSpeakerRoleHistogram | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const self = asNonNegInt(o.self)
  const other = asNonNegInt(o.other)
  const unknown = asNonNegInt(o.unknown)
  const frames = asNonNegInt(o.frames)
  if (self == null || other == null || unknown == null || frames == null) return undefined
  if (self + other + unknown !== frames) return undefined
  const directionPresent = o.directionPresent == null ? 0 : asNonNegInt(o.directionPresent)
  if (directionPresent == null) return undefined
  const directionLast = o.directionLast == null || o.directionLast === ''
    ? null
    : (typeof o.directionLast === 'number' && Number.isFinite(o.directionLast) ? o.directionLast : null)
  return {
    schema: 1,
    frames,
    self,
    other,
    unknown,
    majority: majorityOf(self, other, unknown, frames),
    directionPresent,
    directionLast,
  }
}

export function formatEvenRoleAgreement(opts: {
  chunkIndex: number
  even: EvenSpeakerRoleHistogram
  amp: string
  emb: string
  similarity: number
}): string {
  return `[even-role] chunk=${opts.chunkIndex} even=${opts.even.majority} amp=${opts.amp} emb=${opts.emb} sim=${opts.similarity.toFixed(2)} frames=${opts.even.frames}`
}
