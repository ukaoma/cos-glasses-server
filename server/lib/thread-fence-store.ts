// Durable storage for target fences.
//
// A fence shuts a native thread that may already hold an undelivered COS turn. It
// is the one piece of state whose LOSS writes twice into a real human conversation
// — agent-session-binding-registry.ts records the incident verbatim: "the
// process-local fence re-opened on restart and delivered a second copy."
//
// SEPARATE FROM THE DECISIONS, matching thread-turn-queue-store.ts: TargetGuard
// holds the rules and takes load/save as injected callbacks, so its behaviour stays
// testable in memory and only production touches the disk.
//
// UNDER THE DATA HOME, never the generation directory, which Update Server replaces
// wholesale. Same lesson as the stranded voice profiles.
//
// NEVER TTL'd AND NEVER EVICTED. `heads` and fork refs both bound their maps, and
// both evict in the SAFE direction — losing a head asks the user to acknowledge,
// losing a fork ref makes them find the thread by hand. Losing a fence silently
// reopens a thread that may hold an undelivered turn, so the only way an entry
// leaves this file is an explicit operator release.

import { durableAtomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export interface FenceRecord {
  /** The raw target key. On disk only — it embeds the private native thread id and
   *  is never emitted by any route. Callers outside this module use the digest. */
  targetKey: string
  provider: string
  reason: string
  /** The head digest as it stood BEFORE the ambiguous turn. Null ONLY when the
   *  failure happened before the head was read — `head` is scoped to the try, so
   *  the route-error site reads a hoisted copy rather than nothing. */
  headBefore: string | null
  turnId: string
  bindingId: string | null
  fencedAt: number
}

export function fencePath(): string {
  return dataPath('thread-fences.json')
}

function isFenceRecord(r: unknown): r is FenceRecord {
  return !!r && typeof r === 'object'
    && typeof (r as FenceRecord).targetKey === 'string' && (r as FenceRecord).targetKey.length > 0
    && typeof (r as FenceRecord).provider === 'string'
    && typeof (r as FenceRecord).reason === 'string'
    && typeof (r as FenceRecord).fencedAt === 'number'
}

/** The raw array on disk, or [] when the file is missing or was quarantined. */
function rawRows(): unknown[] {
  const loaded = loadJsonOrQuarantine<unknown>(fencePath())
  if (loaded.status === 'corrupt') {
    // Quarantined to `<path>.corrupt-<ts>` rather than discarded: the bytes are
    // the only record of which threads were fenced, and this is the one state
    // whose silent loss double-writes a real conversation.
    console.warn(`[thread-fence-store] fence file was corrupt, quarantined as ${loaded.quarantinedAs}`)
    return []
  }
  if (loaded.status !== 'ok') return []
  if (!Array.isArray(loaded.data)) {
    console.warn('[thread-fence-store] fence file is not an array — treating as empty')
    return []
  }
  return loaded.data
}

/**
 * Every stored fence this build can understand.
 *
 * A missing or corrupt file reads as empty. That fails OPEN, deliberately:
 * failing closed would refuse every thread on the machine with no way back,
 * while failing open is exactly the pre-6.36.10 behaviour (the fence was
 * process-local and died on restart), so it cannot be a regression. A corrupt
 * file is quarantined rather than dropped, so the evidence survives.
 */
export function readFences(): FenceRecord[] {
  return rawRows().filter(isFenceRecord)
}

/**
 * Replace the stored set, PRESERVING rows this build could not validate.
 *
 * THE MERGE IS THE WHOLE POINT. `TargetGuard` holds only the rows `readFences`
 * understood and saves its map wholesale, so without this a single unrecognised
 * row — a newer schema, a partial write, one bad field — would be erased by the
 * next fence on an unrelated thread, silently reopening every other fenced
 * thread. Preserved rows are inert (nothing enforces a fence that is not in the
 * map) but they are never destroyed by a write that did not understand them.
 *
 * Uses the DURABLE writer, not the lightweight one: fsync of bytes, metadata and
 * directory, plus a randomized exclusive temp name so two independent writers
 * cannot share `<path>.tmp`.
 */
export function writeFences(rows: FenceRecord[]): void {
  const preserved = rawRows().filter(r => !isFenceRecord(r))
  if (preserved.length > 0) {
    console.warn(`[thread-fence-store] preserving ${preserved.length} unrecognised fence row(s) through this write`)
  }
  durableAtomicWriteFileSync(fencePath(), `${JSON.stringify([...rows, ...preserved], null, 2)}\n`)
}
