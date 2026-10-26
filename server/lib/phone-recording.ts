/** Explicit iPhone microphone provenance. Default-off future protocol; never G2 or Mac audio. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { macError, validateMacWav } from './mac-recording.js'
import { readSpeakerPolicy, writeSpeakerPolicy } from './meeting-speaker-policy.js'
import { readSttSettings } from './stt-settings.js'
import { parakeetInstalled } from './parakeet.js'

export const PHONE_SOURCE_TYPE = 'iphone_microphone' as const
export const PHONE_CAPTURE_ID = /^phone_(?:[0-9]{13}_)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
export interface PhoneRecording { version: 1; captureId: string; sessionId: string; sourceType: typeof PHONE_SOURCE_TYPE; speakerPolicy: 'anonymous'; startTime: number; closedAt?: number }
export function phoneMicrophoneMeetingsCapability(serverInstanceId: string | null) {
  let reason = 'disabled'
  if (process.env.COS_IPHONE_MICROPHONE_MEETINGS === '1') {
    try { reason = !serverInstanceId ? 'server_identity_unavailable' : readSttSettings().hq !== 'parakeet-ultra' ? 'parakeet_not_selected' : !parakeetInstalled().installed ? 'parakeet_not_installed' : 'ready' }
    catch { reason = 'parakeet_unavailable' }
  }
  return { enabled: reason === 'ready', protocolVersion: 1 as const, sourceType: PHONE_SOURCE_TYPE, speakerPolicy: 'anonymous' as const, asrModel: 'parakeet-ultra', dictionary: 'server-profile-corrections', reason }
}
/** Phone IDs and the new source marker must agree, including on rejected/replayed requests. */
export function assertPhoneProvenance(id: string, fields: Record<string, unknown> | undefined): boolean {
  const phone = id.startsWith('phone_')
  if (!phone && fields?.sourceType !== PHONE_SOURCE_TYPE && fields?.speakerPolicy !== 'anonymous') return false
  if (!PHONE_CAPTURE_ID.test(id) || fields?.sourceType !== PHONE_SOURCE_TYPE || fields?.speakerPolicy !== 'anonymous') throw macError(400, 'phone_provenance_required', 'iPhone microphone capture requires its phone ID, source type and anonymous policy')
  return true
}
function pathFor(id: string): string {
  if (!PHONE_CAPTURE_ID.test(id)) throw macError(400, 'invalid_phone_capture_id', 'Invalid iPhone capture ID')
  return join(dataPath('phone-recordings'), id + '.json')
}
export function readPhoneRecording(id: string): PhoneRecording | null {
  if (!id.startsWith('phone_')) return null
  const path = pathFor(id)
  try {
    if (lstatSync(path).isSymbolicLink()) throw Error('symbolic link')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 4096) throw Error('invalid metadata')
      const value = JSON.parse(readFileSync(fd, 'utf8'))
      if (value.version !== 1 || value.captureId !== id || value.sessionId !== id || value.sourceType !== PHONE_SOURCE_TYPE || value.speakerPolicy !== 'anonymous' || !Number.isSafeInteger(value.startTime) || value.startTime <= 0 || (value.closedAt !== undefined && (!Number.isSafeInteger(value.closedAt) || value.closedAt <= 0))) throw Error('invalid metadata')
      return value
    } finally { closeSync(fd) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw macError(409, 'phone_capture_metadata_unreadable', 'iPhone capture provenance is unreadable; audio is retained')
  }
}
export function requirePhoneRecording(id: string): PhoneRecording {
  const value = readPhoneRecording(id)
  if (!value) throw macError(409, 'phone_capture_provenance_missing', 'iPhone capture provenance is missing; audio is retained')
  if (readSpeakerPolicy(id).mode !== 'anonymous' || readSpeakerPolicy(id).revision === 'unreadable') throw macError(409, 'phone_capture_policy_changed', 'iPhone microphone capture is anonymous')
  return value
}
export function admitPhoneRecording(id: string, startTime: unknown, serverInstanceId: string): PhoneRecording {
  const capability = phoneMicrophoneMeetingsCapability(serverInstanceId)
  if (!capability.enabled) throw macError(503, 'phone_microphone_' + capability.reason, 'iPhone microphone recording is unavailable: ' + capability.reason)
  const prior = readPhoneRecording(id)
  if (prior) {
    if (prior.closedAt) throw macError(410, 'session_closed', 'Capture is already saved')
    if (startTime !== undefined && Number(startTime) !== prior.startTime) throw macError(409, 'phone_capture_conflict', 'Capture ID already belongs to another start time')
    return requirePhoneRecording(id)
  }
  // Never retroactively turn an old/unlabelled recording into a phone capture.
  if (existsSync(dataPath('active-sessions', id + '.json')) || existsSync(dataPath('session-audio', id)) || existsSync(dataPath('meeting-audio', id)) || existsSync(dataPath('pending-batch', id)) || existsSync(dataPath('unsaved-audio', id))) throw macError(409, 'phone_capture_provenance_missing', 'Existing audio has no admitted iPhone provenance')
  const at = Number(startTime)
  const epoch = /^phone_([0-9]{13})_/.exec(id)?.[1]
  if (epoch && Number(epoch) !== at) throw macError(409, 'phone_capture_conflict', 'Capture ID does not match its original start time')
  if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now() + 300000) throw macError(400, 'phone_start_time_required', 'Original iPhone capture start time required')
  const policy = readSpeakerPolicy(id)
  if (policy.revision !== 'unset' && policy.mode !== 'anonymous') throw macError(409, 'phone_capture_policy_conflict', 'Capture has an incompatible speaker policy')
  if (policy.revision === 'unset') writeSpeakerPolicy(id, 'anonymous', policy.revision)
  const value: PhoneRecording = { version: 1, captureId: id, sessionId: id, sourceType: PHONE_SOURCE_TYPE, speakerPolicy: 'anonymous', startTime: at }
  mkdirSync(dataPath('phone-recordings'), { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(pathFor(id), JSON.stringify(value), { mode: 0o600 })
  return value
}
export function closePhoneRecording(id: string): void {
  const value = requirePhoneRecording(id)
  if (!value.closedAt) durableAtomicWriteFileSync(pathFor(id), JSON.stringify({ ...value, closedAt: Date.now() }), { mode: 0o600 })
}
export function validatePhoneWav(audio: Buffer): number {
  try { return validateMacWav(audio) } catch { throw macError(400, 'invalid_phone_audio', 'Expected a bounded canonical 16-kHz mono PCM16 WAV') }
}
/** A receipt precedes ASR so retry after decode failure cannot overwrite accepted raw audio. */
export function persistPhoneChunkReceipt(id: string, chunkIndex: number, audioSha256: string, elapsed: number, durationMs: number): void {
  requirePhoneRecording(id)
  const dir = dataPath('phone-recording-chunks', id), path = join(dir, chunkIndex + '.json')
  const value = { chunkIndex, audioSha256, elapsed, durationMs }
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw Error('invalid receipt')
    if (JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== JSON.stringify(value)) throw Error('conflict')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw macError(409, 'phone_chunk_conflict', 'Chunk index holds different audio/timing or unreadable metadata')
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(path, JSON.stringify(value), { mode: 0o600 })
}
