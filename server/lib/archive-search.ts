// Literal text search across the daily conversation archive.
//
// WHY THIS NEVER CALLS JSON.parse. The archive is 175 day files spanning six
// months, and their sizes are wildly skewed: the median day is 36 KB but
// 2026-07-30 is 327 MB of agent transcript (283,356 exchanges). Parsing that
// into JS objects would cost multiple GB of heap on a server that also runs the
// wearer's live glasses session. A day file is therefore scanned as raw bytes
// and never materialised.
//
// The cost of that choice is attribution: a hit reports its DATE and a text
// snippet, not a chat index. Callers open the day through the existing
// /archive/:date/chats routes for structure. Day-level attribution is what a
// stream can give safely, and the existing routes already cover the rest.
//
// Measured on the real corpus: a full literal scan of a 90-day window is ~2.4s,
// so this needs no index, no background build, and nothing that can drift out of
// sync with the archive itself.
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export const MIN_QUERY_CHARS = 2
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
export const SNIPPET_RADIUS = 120
/** Per-day snippet cap. A term appearing 40,000 times in one 327 MB day must not
 *  return 40,000 snippets; the count still reports the true total. */
export const MAX_SNIPPETS_PER_DAY = 3
const CHUNK_BYTES = 1 << 20

export interface ArchiveSearchHit {
  date: string
  matches: number
  snippets: string[]
}

export interface ArchiveSearchResult {
  hits: ArchiveSearchHit[]
  scannedDays: number
  bytesScanned: number
  truncated: boolean
}

/** YYYY-MM-DD, the archive's own filename contract. Lexical order IS date order,
 *  which is what makes the range filter a string compare. */
export function isArchiveDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function datesInRange(dates: string[], from?: string, to?: string): string[] {
  return dates
    .filter(isArchiveDate)
    .filter(d => (from ? d >= from : true) && (to ? d <= to : true))
    .sort()
    .reverse()
}

function cleanSnippet(raw: string): string {
  // The scan runs over JSON source, so a snippet arrives carrying escape
  // sequences and structural punctuation. Unescape the common ones and collapse
  // whitespace so the caller can render it as prose.
  return raw
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectSnippets(hay: string, needle: string, offset: number, out: string[], cap: number): number {
  let found = 0
  let i = hay.indexOf(needle)
  while (i !== -1) {
    found++
    if (out.length < cap) {
      const start = Math.max(0, i - SNIPPET_RADIUS)
      const end = Math.min(hay.length, i + needle.length + SNIPPET_RADIUS)
      const snippet = cleanSnippet(hay.slice(start, end))
      if (snippet) out.push(snippet)
    }
    i = hay.indexOf(needle, i + needle.length)
  }
  void offset
  return found
}

/**
 * Scan ONE day file. Returns null when the term never appears.
 *
 * The overlap is the whole reason this is a separate function with its own test.
 * A 1 MB chunk boundary can fall in the middle of the search term, and a naive
 * per-chunk indexOf silently misses it — the failure mode is a search that works
 * in every test fixture and quietly loses hits on real multi-megabyte days.
 * Each chunk is therefore prefixed with the last (needle.length - 1) characters
 * of the previous one, and matches inside that carried prefix are not counted
 * twice because the search resumes past the needle.
 */
export async function searchArchiveFile(
  filePath: string,
  needleLower: string,
): Promise<{ matches: number; snippets: string[]; bytes: number } | null> {
  let matches = 0
  const snippets: string[] = []
  let bytes = 0
  let carry = ''
  const overlap = Math.max(0, needleLower.length - 1)

  await new Promise<void>((resolveDone, rejectDone) => {
    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: CHUNK_BYTES })
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      bytes += Buffer.byteLength(text, 'utf8')
      const hay = carry + text
      matches += collectSnippets(hay.toLowerCase(), needleLower, 0, snippets, MAX_SNIPPETS_PER_DAY)
      // Snippets are taken from the lowercased haystack so their offsets line up;
      // that costs original casing but keeps the match arithmetic honest.
      carry = hay.slice(Math.max(0, hay.length - overlap))
    })
    stream.on('error', rejectDone)
    stream.on('end', () => resolveDone())
  })

  return matches > 0 ? { matches, snippets, bytes } : null
}

/**
 * Search a set of archive days, newest first, stopping once `limit` days have
 * matched. Days are scanned in order so an early-exit favours recent history,
 * which is what a person browsing "what did I say about X" actually wants.
 */
export async function searchArchive(opts: {
  dir: string
  dates: string[]
  query: string
  from?: string
  to?: string
  limit?: number
}): Promise<ArchiveSearchResult> {
  const query = (opts.query ?? '').trim()
  if (query.length < MIN_QUERY_CHARS) {
    throw new Error(`query must be at least ${MIN_QUERY_CHARS} characters`)
  }
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
  const needleLower = query.toLowerCase()
  const candidates = datesInRange(opts.dates, opts.from, opts.to)

  const hits: ArchiveSearchHit[] = []
  let scannedDays = 0
  let bytesScanned = 0
  let truncated = false

  for (const date of candidates) {
    if (hits.length >= limit) {
      truncated = true
      break
    }
    const filePath = resolve(opts.dir, `${date}.json`)
    try {
      await stat(filePath)
    } catch {
      continue // listed but absent: a rotation mid-scan is not an error
    }
    scannedDays++
    try {
      const found = await searchArchiveFile(filePath, needleLower)
      if (found) {
        bytesScanned += found.bytes
        hits.push({ date, matches: found.matches, snippets: found.snippets })
      } else {
        // still counts toward bytes so callers can report honest scan cost
        bytesScanned += (await stat(filePath)).size
      }
    } catch {
      continue // an unreadable day must not abort the whole search
    }
  }

  return { hits, scannedDays, bytesScanned, truncated }
}
