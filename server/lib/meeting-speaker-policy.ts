// Per-capture identity matching. Transcription continues when names are withheld.
import { readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { AUTO_ENROLL_THRESHOLD } from './voiceprint-floor.js'

export const SPEAKER_MODES = ['standard', 'high-confidence', 'anonymous'] as const
export type SpeakerMode = typeof SPEAKER_MODES[number]
export function isSpeakerMode(value: unknown): value is SpeakerMode {
  return typeof value === 'string' && SPEAKER_MODES.includes(value as SpeakerMode)
}
function path(sessionId: string): string {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) throw new Error('Invalid session ID')
  return join(dataPath('speaker-policy'), createHash('sha256').update(sessionId).digest('hex') + '.json')
}
export function readSpeakerPolicy(sessionId: string): { mode: SpeakerMode; revision: string; error?: string } {
  try {
    const raw = readFileSync(path(sessionId), 'utf8')
    const value = JSON.parse(raw)
    if (value.sessionId !== sessionId || !isSpeakerMode(value.mode)) throw new Error('Invalid speaker policy')
    return { mode: value.mode, revision: createHash('sha256').update(raw).digest('hex') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'standard', revision: 'unset' }
    // Corrupt policy must never silently restore identity matching.
    return { mode: 'anonymous', revision: 'unreadable', error: String(error) }
  }
}
export function writeSpeakerPolicy(sessionId: string, mode: SpeakerMode, expectedRevision: string): void {
  if (!isSpeakerMode(mode)) throw new Error('Invalid speaker mode')
  if (readSpeakerPolicy(sessionId).revision !== expectedRevision) throw new Error('Speaker policy changed; refresh first')
  mkdirSync(dataPath('speaker-policy'), { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(path(sessionId), JSON.stringify({ sessionId, mode }), { mode: 0o600 })
}
export function policyLabel<T extends { speaker: string; similarity?: number | null }>(value: T, mode: SpeakerMode): T {
  if (mode === 'standard') return value
  if (mode === 'high-confidence' && typeof value.similarity === 'number' && Number.isFinite(value.similarity) && value.similarity >= AUTO_ENROLL_THRESHOLD && value.similarity <= 1) return value
  return { ...value, speaker: 'Ext', similarity: 0 }
}

/** Missing markers are legacy Standard. Malformed markers fail closed. */
export function captureSpeakerMode(value: unknown): SpeakerMode {
  return value === undefined ? 'standard' : isSpeakerMode(value) ? value : 'anonymous'
}
