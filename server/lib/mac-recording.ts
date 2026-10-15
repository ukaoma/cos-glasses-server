/** Manual, remote-playback-only Mac capture. This registry is independent of
 * live transcription state so provenance and the strict policy survive save,
 * quarantine, finalization and recovery. No capture or model is started here. */
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { readSpeakerPolicy, writeSpeakerPolicy } from './meeting-speaker-policy.js'

export const MAC_SOURCE_TYPE = 'mac_system_audio' as const
export const MAC_CAPTURE_ID = /^mac_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const MAC_AUDIO = { sourceType: MAC_SOURCE_TYPE, sampleRate: 16000, channels: 1, bitsPerSample: 16, maxChunkMs: 30000, maxChunkBytes: 960044, speakerPolicy: 'high-confidence' as const }
export interface MacRecording { version: 1; captureId: string; sessionId: string; sourceType: typeof MAC_SOURCE_TYPE; startTime: number; speakerPolicy: 'high-confidence'; closedAt?: number }
export function macError(status: number, reason: string, message: string): Error & { status: number; reason: string } {
  return Object.assign(new Error(message), { status, reason })
}
function registryPath(id: string): string {
  if (!MAC_CAPTURE_ID.test(id)) throw macError(400, 'invalid_capture_id', 'Invalid Mac capture ID')
  return join(dataPath('mac-recordings'), id + '.json')
}
export function readMacRecording(id: string): MacRecording | null {
  if (!MAC_CAPTURE_ID.test(id)) return null
  try {
    const path = registryPath(id)
    if (lstatSync(path).isSymbolicLink()) throw new Error('symbolic link')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 4096) throw new Error('invalid registry file')
      const value = JSON.parse(readFileSync(fd, 'utf8'))
      if (value.version !== 1 || value.captureId !== id || value.sessionId !== id || value.sourceType !== MAC_SOURCE_TYPE || value.speakerPolicy !== 'high-confidence' || !Number.isSafeInteger(value.startTime) || value.startTime <= 0) throw new Error('invalid registry metadata')
      return value
    } finally { closeSync(fd) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw macError(409, 'mac_capture_metadata_unreadable', 'Mac capture metadata is unreadable; recording was not admitted')
  }
}
export function registerMacRecording(input: unknown): { recording: MacRecording; replayed: boolean } {
  const body = input as Partial<MacRecording> | null
  if (!body || typeof body.captureId !== 'string') throw macError(400, 'invalid_capture_id', 'Mac capture ID required')
  const path = registryPath(body.captureId)
  if (body.sourceType !== MAC_SOURCE_TYPE || !Number.isSafeInteger(body.startTime) || Number(body.startTime) <= 0 || Number(body.startTime) > Date.now() + 300000) throw macError(400, 'invalid_mac_capture', 'Source type and valid capture start time required')
  const prior = readMacRecording(body.captureId)
  if (prior) {
    if (prior.closedAt) throw macError(410, 'session_closed', 'Capture is already saved')
    if (prior.startTime !== body.startTime) throw macError(409, 'mac_capture_conflict', 'Capture ID already belongs to another start time')
    if (readSpeakerPolicy(body.captureId).mode !== 'high-confidence') throw macError(409, 'mac_capture_policy_changed', 'Mac capture requires high-confidence identity policy')
    return { recording: prior, replayed: true }
  }
  const policy = readSpeakerPolicy(body.captureId)
  // A policy written before a crash can be reused, but never overwrite another policy.
  if (policy.revision !== 'unset' && policy.mode !== 'high-confidence') throw macError(409, 'mac_capture_policy_conflict', 'Capture ID has an incompatible identity policy')
  if (policy.revision === 'unset') writeSpeakerPolicy(body.captureId, 'high-confidence', policy.revision)
  const recording: MacRecording = { version: 1, captureId: body.captureId, sessionId: body.captureId, sourceType: MAC_SOURCE_TYPE, startTime: Number(body.startTime), speakerPolicy: 'high-confidence' }
  mkdirSync(dataPath('mac-recordings'), { recursive: true, mode: 0o700 })
  // Registry is the admission commit marker; strict policy is durable first.
  durableAtomicWriteFileSync(path, JSON.stringify(recording), { mode: 0o600 })
  return { recording, replayed: false }
}
export function requireMacRecording(id: string): MacRecording {
  registryPath(id)
  const value = readMacRecording(id)
  if (value?.closedAt) throw macError(410, 'session_closed', 'Capture is already saved')
  if (!value) throw macError(409, 'mac_capture_not_started', 'Start this Mac capture before sending audio')
  if (readSpeakerPolicy(id).mode !== 'high-confidence') throw macError(409, 'mac_capture_policy_changed', 'Mac capture requires high-confidence identity policy')
  return value
}
/** Native bridge intentionally sends one canonical WAV format, never raw HAL buffers. */
export function validateMacWav(audio: Buffer): number {
  if (audio.length < 46 || audio.length > MAC_AUDIO.maxChunkBytes || audio.length % 2 !== 0 ||
      audio.toString('ascii', 0, 4) !== 'RIFF' || audio.readUInt32LE(4) !== audio.length - 8 ||
      audio.toString('ascii', 8, 12) !== 'WAVE' || audio.toString('ascii', 12, 16) !== 'fmt ' || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 || audio.readUInt32LE(28) !== 32000 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 ||
      audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(40) !== audio.length - 44) {
    throw macError(400, 'invalid_mac_audio', 'Expected a bounded canonical 16-kHz mono PCM16 WAV')
  }
  return (audio.length - 44) / 32
}

export function closeMacRecording(id: string): void {
  const value = readMacRecording(id)
  if (value && !value.closedAt) durableAtomicWriteFileSync(registryPath(id), JSON.stringify({ ...value, closedAt: Date.now() }), { mode: 0o600 })
}

export interface MacChunkReceipt { chunkIndex: number; endElapsed: number; durationMs: number; audioSha256: string }
export function macChunkReceipt(id: string, index: number): MacChunkReceipt | null {
  registryPath(id)
  if (!Number.isInteger(index) || index < 0 || index > 9999) throw macError(400, 'invalid_chunk_index', 'Invalid chunk index')
  const path = join(dataPath('mac-recording-chunks'), id, index + '.json')
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('invalid receipt')
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value.chunkIndex !== index || !Number.isFinite(value.endElapsed) || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.durationMs > MAC_AUDIO.maxChunkMs || value.endElapsed < value.durationMs || !/^[0-9a-f]{64}$/.test(value.audioSha256)) throw new Error('invalid receipt')
    return value
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw macError(409, 'mac_chunk_metadata_unreadable', 'Mac chunk receipt is unreadable')
  }
}
export function persistMacChunkReceipt(id: string, value: MacChunkReceipt): void {
  const prior = macChunkReceipt(id, value.chunkIndex)
  if (prior) {
    if (prior.audioSha256 !== value.audioSha256 || prior.endElapsed !== value.endElapsed || prior.durationMs !== value.durationMs) throw macError(409, 'mac_chunk_conflict', 'Chunk index already holds different audio or timing')
    return
  }
  const dir = join(dataPath('mac-recording-chunks'), id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(join(dir, value.chunkIndex + '.json'), JSON.stringify(value), { mode: 0o600 })
}
