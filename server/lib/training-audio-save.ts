import { readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_SAVED_TRAINING_CHUNKS = 30
const pending = new Map<string, Set<string>>()
/** Disk is authoritative after training or TTL deletion. Reservations cover the
 * asynchronous write window so concurrent captures cannot exceed the cap. */
export async function saveTrainingAudioSample(directory: string, filename: string, audio: Buffer): Promise<boolean> {
  const files = new Set(readdirSync(directory).filter(f => f.endsWith('.wav')))
  const reservations = pending.get(directory) ?? new Set<string>()
  if (files.has(filename) || reservations.has(filename)) return false
  const count = new Set([...files, ...reservations]).size
  if (count >= MAX_SAVED_TRAINING_CHUNKS) return false
  reservations.add(filename)
  pending.set(directory, reservations)
  try {
    await writeFile(join(directory, filename), audio, { mode: 0o600 })
    return true
  } finally {
    reservations.delete(filename)
    if (!reservations.size) pending.delete(directory)
  }
}
