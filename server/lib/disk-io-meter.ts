/**
 * Opt-in per-path disk I/O meter (S1, 2026-11-09). COS_DISK_IO_METER=1 turns it on; default off.
 *
 * Why: macOS filed 12 "disk writes" resource reports against the server's node process
 * (2.1 to 8.6 GB over 0.5 to 6 h) with JavaScript frames unsymbolicated, so no report could
 * name a file. Measured from outside on 11/09 (proc_pid_rusage, idle, no meeting): 111.7 KB/s
 * written and about 1.8 to 5 MB/s read. The largest writer (work-reviews/reviews.json) is fixed;
 * the rest could not be attributed without root. With the meter on, the server logs once an
 * hour which paths took the bytes:
 *
 *   [disk-io] 60 min: wrote 152.3 MB in 1,204 writes, read 3.1 GB in 9,880 reads; top writes: ...
 *
 * How: wraps the synchronous and promise write/read entry points of node:fs and
 * node:fs/promises, then calls syncBuiltinESMExports() so modules that already imported
 * named bindings see the wrappers. Each wrapper calls the original and only counts bytes;
 * errors and return values pass through unchanged. Streams (createWriteStream) are not
 * counted. Paths are folded so ids and temp suffixes group: "~/.cos-glasses/data/active-sessions/*.json".
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { homedir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'

interface Tally { bytes: number; ops: number }
interface Window { startedAt: number; writes: Map<string, Tally>; reads: Map<string, Tally> }

let windowState: Window | null = null
let restore: (() => void) | null = null
let reportTimer: ReturnType<typeof setInterval> | null = null
const fdPaths = new Map<number, string>()
/** Node's own fs functions call each other (appendFileSync calls writeFileSync, which calls
 * openSync and writeSync). Only the outermost wrapped call counts. */
let depth = 0
function nested<T>(run: () => T): T {
  depth++
  try { return run() } finally { depth-- }
}

const HOME = homedir()

/** Group a path: home as ~, temp suffixes dropped, id-like segments as *. */
export function foldPath(path: string): string {
  let p = path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
  p = p.replace(/(\.\d+\.[0-9a-f]+)?\.tmp$/i, '')           // atomic-write temp names
  p = p.replace(/\.corrupt-\d+$/, '.corrupt-*')
  p = p.replace(/(^|[/._-])[0-9a-f]{8,}(?=$|[/._-])/gi, '$1*') // hashes, uuids, hex ids
  p = p.replace(/(^|[/._-])\d{6,}(?=$|[/._-])/g, '$1*')      // epoch ms, pids in names
  p = p.replace(/meeting_\*_[a-z0-9]+/gi, 'meeting_*')
  return p
}

function byteLength(data: unknown, encoding?: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
  if (data && typeof (data as ArrayBufferView).byteLength === 'number') return (data as ArrayBufferView).byteLength
  return 0
}

function keyFor(target: unknown): string {
  if (typeof target === 'number') return fdPaths.get(target) ?? `fd:${target}`
  if (typeof target === 'string') return foldPath(target)
  if (target instanceof URL) return foldPath(target.pathname)
  if (Buffer.isBuffer(target)) return foldPath(target.toString())
  if (target && typeof (target as { fd?: unknown }).fd === 'number') return fdPaths.get((target as { fd: number }).fd) ?? 'filehandle'
  return 'unknown'
}

function count(kind: 'writes' | 'reads', target: unknown, bytes: number, outer: boolean): void {
  if (!windowState || bytes <= 0 || !outer) return
  const map = windowState[kind]
  const key = keyFor(target)
  const tally = map.get(key)
  if (tally) { tally.bytes += bytes; tally.ops++ } else map.set(key, { bytes, ops: 1 })
}

export interface DiskIoReport {
  windowMs: number
  wroteBytes: number; writeOps: number
  readBytes: number; readOps: number
  topWrites: Array<{ path: string; bytes: number; ops: number }>
  topReads: Array<{ path: string; bytes: number; ops: number }>
}

/** The current window's totals (diagnostics, tests). Null when the meter is off. */
export function diskIoSnapshot(top = 10): DiskIoReport | null {
  if (!windowState) return null
  const sum = (m: Map<string, Tally>) => [...m.values()].reduce((a, t) => ({ bytes: a.bytes + t.bytes, ops: a.ops + t.ops }), { bytes: 0, ops: 0 })
  const rank = (m: Map<string, Tally>) => [...m.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top)
    .map(([path, t]) => ({ path, bytes: t.bytes, ops: t.ops }))
  const w = sum(windowState.writes), r = sum(windowState.reads)
  return {
    windowMs: Date.now() - windowState.startedAt,
    wroteBytes: w.bytes, writeOps: w.ops, readBytes: r.bytes, readOps: r.ops,
    topWrites: rank(windowState.writes), topReads: rank(windowState.reads),
  }
}

function mb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
}

/** One log line for the window, then start a new window. */
export function reportDiskIo(log: (line: string) => void = line => console.log(line)): DiskIoReport | null {
  const report = diskIoSnapshot(8)
  if (!report || !windowState) return null
  const fmt = (rows: DiskIoReport['topWrites']) => rows.map(r => `${r.path} ${mb(r.bytes)} (${r.ops})`).join('; ') || 'none'
  log(`[disk-io] ${Math.round(report.windowMs / 60_000)} min: wrote ${mb(report.wroteBytes)} in ${report.writeOps} writes, `
    + `read ${mb(report.readBytes)} in ${report.readOps} reads; top writes: ${fmt(report.topWrites)}; top reads: ${fmt(report.topReads)}`)
  windowState = { startedAt: Date.now(), writes: new Map(), reads: new Map() }
  return report
}

export function diskIoMeterRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_DISK_IO_METER === '1'
}

/** Install the wrappers. Idempotent. Returns false when already installed. */
export function installDiskIoMeter(options: { reportEveryMs?: number } = {}): boolean {
  if (restore) return false
  windowState = { startedAt: Date.now(), writes: new Map(), reads: new Map() }
  const f = fs as unknown as Record<string, any>
  const p = fsPromises as unknown as Record<string, any>
  const saved: Array<[Record<string, any>, string, unknown]> = []
  const wrap = (obj: Record<string, any>, name: string, make: (orig: any) => any) => {
    const orig = obj[name]
    if (typeof orig !== 'function') return
    saved.push([obj, name, orig])
    obj[name] = make(orig)
  }
  wrap(f, 'openSync', orig => function (this: unknown, path: unknown, ...rest: unknown[]) {
    const fd = nested(() => orig.call(this, path, ...rest))
    if (typeof fd === 'number' && (typeof path === 'string' || path instanceof URL)) fdPaths.set(fd, keyFor(path))
    return fd
  })
  wrap(f, 'closeSync', orig => function (this: unknown, fd: number, ...rest: unknown[]) {
    fdPaths.delete(fd)
    return orig.call(this, fd, ...rest)
  })
  wrap(f, 'writeFileSync', orig => function (this: unknown, target: unknown, data: unknown, options?: unknown) {
    const outer = depth === 0
    const result = nested(() => orig.call(this, target, data, options))
    count('writes', target, byteLength(data, typeof options === 'string' ? options : (options as { encoding?: unknown } | undefined)?.encoding), outer)
    return result
  })
  wrap(f, 'appendFileSync', orig => function (this: unknown, target: unknown, data: unknown, options?: unknown) {
    const outer = depth === 0
    const result = nested(() => orig.call(this, target, data, options))
    count('writes', target, byteLength(data, typeof options === 'string' ? options : (options as { encoding?: unknown } | undefined)?.encoding), outer)
    return result
  })
  wrap(f, 'writeSync', orig => function (this: unknown, fd: number, ...rest: unknown[]) {
    const outer = depth === 0
    const written = nested(() => orig.call(this, fd, ...rest))
    count('writes', fd, typeof written === 'number' ? written : 0, outer)
    return written
  })
  wrap(f, 'readFileSync', orig => function (this: unknown, target: unknown, ...rest: unknown[]) {
    const outer = depth === 0
    const result = nested(() => orig.call(this, target, ...rest))
    count('reads', target, byteLength(result), outer)
    return result
  })
  wrap(f, 'readSync', orig => function (this: unknown, fd: number, ...rest: unknown[]) {
    const outer = depth === 0
    const read = nested(() => orig.call(this, fd, ...rest))
    count('reads', fd, typeof read === 'number' ? read : 0, outer)
    return read
  })
  for (const name of ['writeFile', 'appendFile'] as const) {
    wrap(p, name, orig => async function (this: unknown, target: unknown, data: unknown, options?: unknown) {
      const result = await orig.call(this, target, data, options)
      count('writes', target, byteLength(data, typeof options === 'string' ? options : (options as { encoding?: unknown } | undefined)?.encoding), true)
      return result
    })
  }
  wrap(p, 'readFile', orig => async function (this: unknown, target: unknown, ...rest: unknown[]) {
    const result = await orig.call(this, target, ...rest)
    count('reads', target, byteLength(result), true)
    return result
  })
  syncBuiltinESMExports()
  restore = () => {
    for (const [obj, name, orig] of saved) obj[name] = orig
    syncBuiltinESMExports()
  }
  const every = options.reportEveryMs ?? 60 * 60_000
  if (every > 0) {
    reportTimer = setInterval(() => { reportDiskIo() }, every)
    reportTimer.unref?.()
  }
  console.log(`[disk-io] meter on (COS_DISK_IO_METER=1): ${every > 0 ? `one line every ${Math.round(every / 60_000)} min` : 'reports on request only'}`)
  return true
}

/** Remove the wrappers (tests, and a clean shutdown). */
export function uninstallDiskIoMeter(): void {
  if (reportTimer) clearInterval(reportTimer)
  reportTimer = null
  restore?.()
  restore = null
  windowState = null
  fdPaths.clear()
}
