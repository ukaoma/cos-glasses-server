/**
 * Meeting context keys (6.64.0): the ids COS Control files a meeting's dropped files under.
 *
 * Miles, 2026-10-06: "link" meetings with files dragged onto them, the way Work cards take files, so a screen or slide
 * shared in a meeting becomes agent context. COS Control keeps the files on the Mac (`~/cos-data/meeting-context`); the
 * server only says which key a meeting answers to.
 *
 * READ-ONLY, FROM IDS THE MEETING ALREADY CARRIES. Plan v1 wrote a marker into the meeting file and failed review: more
 * than a dozen writers regenerate, archive or race those files, and a write changes the hashes merge suggestions, merge
 * decisions, Work review and speaker review depend on. So the key is read from the meeting's own source ids:
 *   - `g2:<sessionId>` from its `.g2-chunks.json` sidecar (the speaker system's key; moves with every G2 rename);
 *   - `ff:<id>` from its `.fireflies.json` sidecar;
 *   - `g2:<id>` for every `<!-- g2-session -->` the file declares, which is how a merged meeting also shows the files of
 *     the capture it absorbed.
 * Measured 2026-10-06: 649 of 656 meetings from August to October carry at least one.
 *
 * IDENTITY IS AN EXACT ID. Never a title or a date (the rule `resolveMergedScribe` already keeps). Two live meetings whose
 * own sidecars give the same PRIMARY key are `ambiguous`: Control adds and removes nothing there and never files a card
 * link under their keys (files already dropped stay with the cards linked to the meeting they were dropped on).
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A key as Control stores it. The id part is the server's own marker grammar (`G2_SESSION_MARKER`). */
export const MEETING_CONTEXT_KEY = /^(?:g2|ff):[A-Za-z0-9:_-]{3,96}$/
const SOURCE_ID = /^[A-Za-z0-9:_-]{3,96}$/

const SIDECAR_HEAD_BYTES = 4096

/**
 * The value of a TOP-LEVEL string field in the head of a JSON object, or undefined.
 *
 * A Fireflies sidecar is up to megabytes of sentences, so only its head is read, and a regex alone would also match an
 * `"id"` nested inside `participants` or `sentences` if the key order ever changed. This walks the head tracking depth
 * and strings, and answers only for a key at depth 1.
 */
export function topLevelStringField(head: string, field: string): string | undefined {
  let depth = 0
  let i = 0
  while (i < head.length) {
    const c = head[i]
    if (c === '"') {
      let j = i + 1
      let raw = ''
      while (j < head.length && head[j] !== '"') {
        if (head[j] === '\\') { raw += head.slice(j, j + 2); j += 2; continue }
        raw += head[j]; j += 1
      }
      if (j >= head.length) return undefined
      // A key at depth 1 is followed by a colon; read its value if it is the one asked for.
      let k = j + 1
      while (k < head.length && /\s/.test(head[k])) k += 1
      if (depth === 1 && head[k] === ':' && raw === field) {
        k += 1
        while (k < head.length && /\s/.test(head[k])) k += 1
        if (head[k] !== '"') return undefined
        const end = head.indexOf('"', k + 1)
        if (end < 0) return undefined
        const value = head.slice(k + 1, end)
        return value.includes('\\') ? undefined : value
      }
      i = j + 1
      continue
    }
    if (c === '{' || c === '[') depth += 1
    else if (c === '}' || c === ']') depth -= 1
    i += 1
  }
  return undefined
}

/** The Fireflies transcript id in `<stem>.fireflies.json` beside a meeting, if there is one. Reads 4 KB, never a link. */
export function firefliesSidecarId(monthDir: string, meetingFilename: string): string | undefined {
  if (!meetingFilename.endsWith('.md')) return undefined
  const path = join(monthDir, meetingFilename.replace(/\.md$/, '.fireflies.json'))
  let fd: number | null = null
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return undefined
    if (dirname(realpathSync(path)) !== realpathSync(monthDir)) return undefined
    // Non-blocking and no-follow (hazard-invariants): a FIFO planted under the sidecar's name must never hang the
    // server's one thread, and a link swapped in after the lstat is refused at the open itself.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    if (!fstatSync(fd).isFile()) return undefined
    const buffer = Buffer.alloc(Math.min(SIDECAR_HEAD_BYTES, stat.size))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const id = topLevelStringField(buffer.subarray(0, read).toString('utf8'), 'id')
    return id && SOURCE_ID.test(id) ? id : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* already closed */ } }
  }
}

/** The ordered, de-duplicated keys for one meeting. The first is primary: the capture's own sidecar, then Fireflies,
 *  then what the file declares. */
export function meetingContextKeys(sources: { g2SessionId?: string; firefliesId?: string; declared?: readonly string[] }): string[] {
  const keys: string[] = []
  const add = (prefix: 'g2' | 'ff', id: string | undefined) => {
    if (!id || !SOURCE_ID.test(id)) return
    const key = `${prefix}:${id}`
    if (!keys.includes(key)) keys.push(key)
  }
  add('g2', sources.g2SessionId)
  add('ff', sources.firefliesId)
  for (const id of sources.declared ?? []) add('g2', id)
  return keys
}

export interface MeetingContextFields {
  contextKeys: string[]
  contextSupported: boolean
  contextAmbiguous?: true
  contextReason?: 'no_source_id' | 'read_only_record' | 'conflict_copy' | 'ambiguous'
}

/**
 * What a row or a detail says about its files.
 *
 * `claimants` is how many live meetings have this meeting's primary key as THEIR primary key (this one included). Two
 * or more is ambiguous: the keys still go out, so Control can show files already there, but nothing is added or sent.
 */
export function meetingContextFields(keys: string[], options: { conflictCopy?: boolean; claimants?: number } = {}): MeetingContextFields {
  if (options.conflictCopy) return { contextKeys: [], contextSupported: false, contextReason: 'conflict_copy' }
  if (keys.length === 0) return { contextKeys: [], contextSupported: false, contextReason: 'no_source_id' }
  if ((options.claimants ?? 1) > 1) return { contextKeys: keys, contextSupported: false, contextAmbiguous: true, contextReason: 'ambiguous' }
  return { contextKeys: keys, contextSupported: true }
}

/** Fields for a record this release does not key: a direct library, an import or a re-derived (blended) record. */
export function readOnlyContext(): MeetingContextFields {
  return { contextKeys: [], contextSupported: false, contextReason: 'read_only_record' }
}
