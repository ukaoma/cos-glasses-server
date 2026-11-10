/**
 * Compact the session ledger (.glasses_sessions.jsonl) to the latest entry per session.
 *
 * S1 (2026-11-09). Before 7.0.x+S1 every server restart appended every session again, so
 * the ledger on Miles's Mac reached 1.94 GB: 118,221 entries for 588 sessions. The writer is
 * fixed; this tool removes the copies already on disk. It is never run automatically.
 *
 *   npx tsx server/scripts/compact-session-log.ts --file <path> --dry-run   (default; reads only)
 *   npx tsx server/scripts/compact-session-log.ts --file <path> --apply
 *
 * What --apply does, in order:
 *   1. Reads the file once and records, for each session id, where its LAST line starts.
 *   2. Streams the file again into a private temp file in the same folder, keeping each
 *      session's last line (in file order) and every line it cannot parse, verbatim.
 *   3. Copies any bytes a running server appended meanwhile, until the size holds still.
 *   4. Hard-links the original to `<file>.bak-<time>` (no copy, no extra disk), fsyncs the
 *      temp file, renames it over the original (atomic), and copies any last appended bytes
 *      that landed on the old inode.
 *   5. Re-reads the result and checks every session is present exactly once.
 * The backup keeps every byte. Delete it only after checking the result.
 *
 * Imports nothing from the server, so running it starts no server module.
 */
import {
  closeSync, createReadStream, fstatSync, fsyncSync, linkSync, openSync, readSync, renameSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ENTRY_PREFIX = /^\{"session_id":"((?:[^"\\]|\\.)*)"/

/** The session id of one ledger line, or null when the line is not an entry. */
export function lineSessionId(line: Buffer): string | null {
  const head = line.subarray(0, Math.min(line.length, 512)).toString('utf8')
  const m = ENTRY_PREFIX.exec(head)
  if (m) {
    try { return JSON.parse(`"${m[1]}"`) } catch { /* fall through */ }
  }
  try {
    const d = JSON.parse(line.toString('utf8'))
    return d && typeof d.session_id === 'string' && d.session_id ? d.session_id : null
  } catch {
    return null
  }
}

interface Scan {
  /** Bytes read (through the last complete line). */
  end: number
  lines: number
  entries: number
  unparsed: number
  /** session id -> [offset of its last line, length of that line including the newline] */
  last: Map<string, [number, number]>
  /** session id -> how many lines it had */
  copies: Map<string, number>
}

/** Visit complete lines in [from, to). Returns the offset just past the last complete line. */
async function eachLine(path: string, from: number, to: number,
  visit: (line: Buffer, offset: number) => void | Promise<void>): Promise<number> {
  if (to <= from) return from
  let offset = from
  let carry: Buffer[] = []
  let carryLen = 0
  const stream = createReadStream(path, { start: from, end: to - 1, highWaterMark: 1 << 20 })
  for await (const raw of stream) {
    let chunk = raw as Buffer
    let nl = chunk.indexOf(10)
    while (nl !== -1) {
      const piece = chunk.subarray(0, nl)
      const line = carryLen ? Buffer.concat([...carry, piece]) : piece
      carry = []; carryLen = 0
      await visit(line, offset)
      offset += line.length + 1
      chunk = chunk.subarray(nl + 1)
      nl = chunk.indexOf(10)
    }
    if (chunk.length) { carry.push(Buffer.from(chunk)); carryLen += chunk.length }
  }
  return offset
}

async function scan(path: string, size: number): Promise<Scan> {
  const result: Scan = { end: 0, lines: 0, entries: 0, unparsed: 0, last: new Map(), copies: new Map() }
  result.end = await eachLine(path, 0, size, (line, offset) => {
    result.lines++
    if (line.length === 0) return
    const id = lineSessionId(line)
    if (id === null) { result.unparsed++; return }
    result.entries++
    result.last.set(id, [offset, line.length + 1])
    result.copies.set(id, (result.copies.get(id) ?? 0) + 1)
  })
  return result
}

export interface CompactReport {
  file: string
  mode: 'dry-run' | 'apply'
  before: { bytes: number; lines: number; entries: number; sessions: number; unparsedLines: number }
  after: { bytes: number; entries: number; sessions: number; unparsedLinesKept: number }
  mostCopied: Array<{ session: string; copies: number }>
  backup?: string
  appendedDuringRun?: number
  verified?: boolean
}

function copyRange(srcFd: number, dstFd: number, from: number, to: number): number {
  const buf = Buffer.allocUnsafe(1 << 20)
  let pos = from
  while (pos < to) {
    const n = readSync(srcFd, buf, 0, Math.min(buf.length, to - pos), pos)
    if (n <= 0) break
    writeSync(dstFd, buf, 0, n)
    pos += n
  }
  return pos - from
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

export async function compactSessionLog(options: {
  file: string
  apply?: boolean
  now?: Date
  /** Tests only: runs after the rewrite pass, before appended bytes are copied (a writer racing the tool). */
  afterRewrite?: () => void
}): Promise<CompactReport> {
  const file = resolve(options.file)
  const size = statSync(file).size
  const s = await scan(file, size)
  const keptBytes = [...s.last.values()].reduce((sum, [, len]) => sum + len, 0)
  // Unparsed lines are kept verbatim; count their bytes in the estimate.
  let unparsedBytes = 0
  if (s.unparsed) {
    await eachLine(file, 0, s.end, line => { if (line.length && lineSessionId(line) === null) unparsedBytes += line.length + 1 })
  }
  const report: CompactReport = {
    file,
    mode: options.apply ? 'apply' : 'dry-run',
    before: { bytes: size, lines: s.lines, entries: s.entries, sessions: s.last.size, unparsedLines: s.unparsed },
    after: { bytes: keptBytes + unparsedBytes, entries: s.last.size, sessions: s.last.size, unparsedLinesKept: s.unparsed },
    mostCopied: [...s.copies.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([session, copies]) => ({ session, copies })),
  }
  if (!options.apply) return report

  const keepAt = new Set([...s.last.values()].map(([offset]) => offset))
  const dir = dirname(file)
  const tmp = join(dir, `.${basename(file)}.compact-${process.pid}.tmp`)
  const out = openSync(tmp, 'wx', 0o600)
  let renamed = false
  try {
    await eachLine(file, 0, s.end, (line, offset) => {
      if (line.length === 0) return
      if (keepAt.has(offset) || lineSessionId(line) === null) {
        writeSync(out, line)
        writeSync(out, '\n')
      }
    })
    options.afterRewrite?.()
    // Bytes a running server appended while we read: copy verbatim until the size holds.
    const src = openSync(file, 'r')
    let copiedTo = s.end
    let appended = 0
    try {
      for (let i = 0; i < 20; i++) {
        const now = fstatSync(src).size
        if (now <= copiedTo) break
        appended += copyRange(src, out, copiedTo, now)
        copiedTo = now
      }
      fsyncSync(out)
      const backup = `${file}.bak-${stamp(options.now ?? new Date())}`
      linkSync(file, backup) // same inode, no copy; fails if the name exists
      renameSync(tmp, file)
      renamed = true
      report.backup = backup
      // Anything appended to the old inode between the last copy and the rename.
      const late = fstatSync(src).size
      if (late > copiedTo) appended += copyRange(src, out, copiedTo, late)
      fsyncSync(out)
    } finally {
      closeSync(src)
    }
    report.appendedDuringRun = appended
  } finally {
    closeSync(out)
    if (!renamed) { try { unlinkSync(tmp) } catch { /* already gone */ } }
  }

  // Verify: every session from the scan is present, each exactly once (appended tail aside).
  const check = await scan(file, statSync(file).size)
  const missing = [...s.last.keys()].filter(id => !check.copies.has(id))
  const repeated = [...check.copies.entries()].filter(([, n]) => n > 1).map(([id]) => id)
  report.verified = missing.length === 0 && (report.appendedDuringRun ? true : repeated.length === 0)
  report.after = {
    bytes: statSync(file).size,
    entries: check.entries,
    sessions: check.last.size,
    unparsedLinesKept: check.unparsed,
  }
  return report
}

function fmt(bytes: number): string {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GB`
    : bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${bytes} B`
}

async function main(argv: string[]): Promise<number> {
  const fileAt = argv.indexOf('--file')
  const file = fileAt >= 0 ? argv[fileAt + 1] : undefined
  const apply = argv.includes('--apply')
  if (!file || (argv.includes('--dry-run') && apply)) {
    console.error('usage: compact-session-log.ts --file <.glasses_sessions.jsonl> [--dry-run | --apply]')
    return 2
  }
  const r = await compactSessionLog({ file, apply })
  console.log(`${r.mode.toUpperCase()} ${r.file}`)
  console.log(`  before: ${fmt(r.before.bytes)}, ${r.before.entries} entries, ${r.before.sessions} sessions, ${r.before.unparsedLines} unparsed lines`)
  console.log(`  after:  ${fmt(r.after.bytes)}, ${r.after.entries} entries, ${r.after.sessions} sessions, ${r.after.unparsedLinesKept} unparsed lines kept`)
  console.log(`  most copied: ${r.mostCopied.map(m => `${m.session} x${m.copies}`).join(', ')}`)
  if (r.backup) console.log(`  backup (hard link, every original byte): ${r.backup}`)
  if (r.appendedDuringRun) console.log(`  bytes appended by a running server during the run, kept: ${r.appendedDuringRun}`)
  if (r.verified !== undefined) console.log(`  verified: ${r.verified ? 'yes' : 'NO (keep the backup and investigate)'}`)
  console.log(JSON.stringify(r))
  return r.verified === false ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, err => { console.error(err); process.exitCode = 1 })
}
