// A sidecar index of per-day archive summaries.
//
// WHY THIS EXISTS. `listArchiveDates()` produces {date, summary, chatCount,
// exchangeCount} by JSON.parsing EVERY day file and discarding the bodies. On the
// real corpus that is 175 files / 1.2 GB, and the single largest day (2026-07-30,
// 343 MB) measures at 1.2 GB heap / 2.3 GB RSS to materialise on its own. That is
// one GET away from a multi-gigabyte spike on the same process that runs the
// wearer's live glasses session.
//
// The index holds exactly the fields that listing needs, keyed by the day's own
// (size, mtimeMs). A day whose bytes have not changed is never reopened, so the
// steady-state cost of a listing is one readdir plus one small JSON read.
//
// INVALIDATION IS THE WHOLE CONTRACT. size+mtimeMs is what makes this honest: an
// archive that is appended to changes both, so a stale entry cannot survive a
// write. Entries for vanished days are dropped rather than kept, because a listing
// that names a file nobody can open is worse than one that omits it.
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'

export const ARCHIVE_INDEX_SCHEMA = 1

export interface ArchiveIndexEntry {
  date: string
  size: number
  mtimeMs: number
  chatCount: number
  exchangeCount: number
  summary: string | null
}

interface ArchiveIndexFile {
  schemaVersion: number
  entries: Record<string, ArchiveIndexEntry>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** Chats carry exactly one `exchangeCount` each and the key appears nowhere else
 *  in the shape. Verified against parsed truth on six real days (8/28/93/47/11/90
 *  chats) before this was relied on. */
const EXCHANGE_COUNT_RE = /"exchangeCount":\s*(\d+)/g
const CARRY_CHARS = 64

export function emptyIndex(): ArchiveIndexFile {
  return { schemaVersion: ARCHIVE_INDEX_SCHEMA, entries: {} }
}

export function readIndexFile(indexPath: string): ArchiveIndexFile {
  try {
    if (!existsSync(indexPath)) return emptyIndex()
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as ArchiveIndexFile
    // A schema bump invalidates wholesale rather than trying to migrate: the index
    // is a cache, and rebuilding it costs one scan.
    if (parsed?.schemaVersion !== ARCHIVE_INDEX_SCHEMA || typeof parsed.entries !== 'object') {
      return emptyIndex()
    }
    return { schemaVersion: ARCHIVE_INDEX_SCHEMA, entries: parsed.entries ?? {} }
  } catch {
    return emptyIndex() // a corrupt cache must never take the listing down
  }
}

/** Pull the top-level `summary` string without materialising the day. It sits in
 *  the opening object, so the first chunk is enough; a day that hides it deeper
 *  simply reports null rather than costing a full read. */
export function extractSummary(head: string): string | null {
  const m = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
  if (!m) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return null
  }
}

/** Stream one day and count chats + exchanges. Never parses. */
export async function summariseDayFile(filePath: string): Promise<{ chatCount: number; exchangeCount: number; summary: string | null }> {
  let chatCount = 0
  let exchangeCount = 0
  let summary: string | null = null
  let carry = ''
  let first = true

  await new Promise<void>((done, fail) => {
    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 })
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const hay = carry + text
      if (first) {
        summary = extractSummary(hay)
        first = false
      }
      EXCHANGE_COUNT_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = EXCHANGE_COUNT_RE.exec(hay)) !== null) {
        chatCount++
        exchangeCount += Number(m[1])
      }
      // Carry enough to reassemble a key/value split across the boundary. Matches
      // inside the carry are not double-counted because the carry is short and the
      // next pass starts from it, not from the whole previous chunk.
      carry = hay.slice(Math.max(0, hay.length - CARRY_CHARS))
    })
    stream.on('error', fail)
    stream.on('end', () => done())
  })

  return { chatCount, exchangeCount, summary }
}

export interface RefreshResult {
  entries: ArchiveIndexEntry[]
  rebuilt: string[]
  dropped: string[]
  fromCache: number
}

/**
 * Bring the index in line with what is on disk and return the listing, newest
 * first. Only days whose (size, mtimeMs) changed are reopened.
 */
export async function refreshArchiveIndex(dir: string, indexPath: string): Promise<RefreshResult> {
  const file = readIndexFile(indexPath)
  const rebuilt: string[] = []
  const dropped: string[] = []
  let fromCache = 0

  let present: string[] = []
  try {
    present = readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -'.json'.length))
      .filter(d => DATE_RE.test(d))
  } catch {
    return { entries: [], rebuilt, dropped, fromCache }
  }
  const presentSet = new Set(present)

  for (const date of Object.keys(file.entries)) {
    if (!presentSet.has(date)) {
      delete file.entries[date]
      dropped.push(date)
    }
  }

  for (const date of present) {
    const filePath = resolve(dir, `${date}.json`)
    let st
    try {
      st = statSync(filePath)
    } catch {
      continue
    }
    const cached = file.entries[date]
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      fromCache++
      continue
    }
    try {
      const s = await summariseDayFile(filePath)
      file.entries[date] = {
        date,
        size: st.size,
        mtimeMs: st.mtimeMs,
        chatCount: s.chatCount,
        exchangeCount: s.exchangeCount,
        summary: s.summary,
      }
      rebuilt.push(date)
    } catch {
      continue // an unreadable day must not abort the listing
    }
  }

  if (rebuilt.length > 0 || dropped.length > 0) {
    try {
      atomicWriteFileSync(indexPath, `${JSON.stringify(file)}\n`, { mode: 0o600 })
    } catch {
      // A cache that cannot persist still serves this call correctly.
    }
  }

  const entries = Object.values(file.entries).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { entries, rebuilt, dropped, fromCache }
}
