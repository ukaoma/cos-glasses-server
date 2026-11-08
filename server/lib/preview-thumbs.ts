/**
 * Card thumbnails from Quick Look (preview engine phase 1, PLAN 6 and 7). `qlmanage -t` is built into macOS and runs
 * the Mac's own sandboxed Quick Look extensions; it drew page 1 of a PDF, DOCX, PPTX, XLSX and HTML headless in 0.26 to
 * 0.48 s in the plan's canary, and its HTML thumbnail runs no script and loads no remote image (canary 3).
 *
 * - Runs on a PRIVATE COPY of bytes the resolver already validated (no TOCTOU on the original), in a 0700 temp folder,
 *   with an argument array, `nice`, a 10 s timeout and SIGKILL past it. Two at once, machine-wide in this process.
 * - The output must be a real PNG under 4 MiB, or there is no thumbnail.
 * - Cached on disk under the data folder, keyed by the file's identity (device, inode, size, mtime, ctime), never by
 *   path. 128 MiB and 7 days at most; the oldest go first. A hit refreshes its age.
 * - When Quick Look cannot run (no window server, a launchd context that refuses it, a timeout), the answer is
 *   `unavailable` and the card says there is no preview image. It never fails the card.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { dataPath } from './data-dir.js'

export const THUMB_SIZE = 256
export const THUMB_TIMEOUT_MS = 10_000
export const THUMB_CONCURRENCY = 2
export const THUMB_CACHE_BYTES = 128 * 1024 * 1024
export const THUMB_CACHE_AGE_MS = 7 * 24 * 60 * 60_000
export const THUMB_OUTPUT_MAX = 4 * 1024 * 1024
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface Identity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
export type RunResult = { code: number | null; signal: string | null; timedOut: boolean }
export interface ThumbDeps {
  dir(): string
  tmp(): string
  now(): number
  run(file: string, args: string[], timeoutMs: number): Promise<RunResult>
}

/**
 * 7.0.5 canary 4: Quick Look reads an HTML page with no declared charset as Latin-1, so a UTF-8 page thumbnails as
 * mojibake ("CafÃ©"). In the PRIVATE copy only, and only when the page declares no charset and its bytes are valid
 * UTF-8, `<meta charset="utf-8">` goes right after `<head>` (or first, when there is no head). Proven under launchd.
 */
export function withUtf8Charset(bytes: Buffer, name: string): Buffer {
  if (!/\.html?$/i.test(name)) return bytes
  const head = bytes.subarray(0, 4096).toString('latin1')
  if (/<meta\b[^>]*\bcharset\s*=/i.test(head)) return bytes
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return bytes }
  const tag = Buffer.from('<meta charset="utf-8">')
  const m = /<head\b[^>]*>/i.exec(head)
  const at = m ? m.index + m[0].length : 0
  return Buffer.concat([bytes.subarray(0, at), tag, bytes.subarray(at)])
}

export function thumbKey(identity: Identity): string {
  // v2 (7.0.5): HTML thumbnails drawn before the charset fix were mojibake; a new key draws them again.
  return createHash('sha256').update(JSON.stringify(['thumb-v2', THUMB_SIZE, identity.dev, identity.ino, identity.size, identity.mtimeMs, identity.ctimeMs])).digest('hex')
}

const realRun: ThumbDeps['run'] = (file, args, timeoutMs) => new Promise(resolve => {
  const child = execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true }, err => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null
    resolve({ code: e ? (typeof e.code === 'number' ? e.code : null) : 0, signal: e?.signal ?? null, timedOut: !!e?.killed })
  })
  child.stdin?.end()
})

export function createThumbnailer(deps: ThumbDeps) {
  let active = 0
  const evict = (dir: string) => {
    let entries: Array<{ path: string; size: number; at: number }> = []
    try {
      entries = readdirSync(dir).filter(n => /^[a-f0-9]{64}\.png$/.test(n)).map(n => {
        const p = join(dir, n), st = statSync(p)
        return { path: p, size: st.size, at: st.mtimeMs }
      })
    } catch { return }
    const now = deps.now()
    entries.sort((a, b) => a.at - b.at)
    let total = entries.reduce((n, e) => n + e.size, 0)
    for (const e of entries) {
      if (now - e.at <= THUMB_CACHE_AGE_MS && total <= THUMB_CACHE_BYTES) continue
      try { rmSync(e.path, { force: true }); total -= e.size } catch { /* next */ }
    }
  }
  return {
    get active() { return active },
    /** The cached or new PNG for these bytes, or why there is none. */
    async thumbnail(bytes: Buffer, name: string, identity: Identity): Promise<{ status: 'ok'; path: string } | { status: 'unavailable' | 'busy' }> {
      const dir = deps.dir()
      const key = thumbKey(identity)
      const cached = join(dir, key + '.png')
      try {
        const st = statSync(cached)
        if (deps.now() - st.mtimeMs <= THUMB_CACHE_AGE_MS && st.size > PNG.length) {
          const t = new Date(deps.now()); try { utimesSync(cached, t, t) } catch { /* age only */ }
          return { status: 'ok', path: cached }
        }
      } catch { /* not cached */ }
      if (active >= THUMB_CONCURRENCY) return { status: 'busy' }
      active++
      const work = mkdtempSync(join(deps.tmp(), 'cos-preview-'))
      try {
        chmodSync(work, 0o700)
        // A fixed base name with the original extension: Quick Look picks its generator by extension, and no
        // file name a session wrote reaches the command line.
        const ext = extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)
        const copy = join(work, 'preview' + ext)
        writeFileSync(copy, withUtf8Charset(bytes, name), { mode: 0o600 })
        const out = join(work, 'out'); mkdirSync(out, { mode: 0o700 })
        const result = await deps.run('/usr/bin/nice', ['-n', '10', '/usr/bin/qlmanage', '-t', '-s', String(THUMB_SIZE), '-o', out, copy], THUMB_TIMEOUT_MS)
        if (result.timedOut || result.code !== 0) return { status: 'unavailable' }
        const produced = join(out, 'preview' + ext + '.png')
        let png: Buffer
        try { png = readFileSync(produced) } catch { return { status: 'unavailable' } }
        if (png.length <= PNG.length || png.length > THUMB_OUTPUT_MAX || !png.subarray(0, 8).equals(PNG)) return { status: 'unavailable' }
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const staged = join(dir, key + '.' + process.pid + '.tmp')
        writeFileSync(staged, png, { mode: 0o600 })
        renameSync(staged, cached)
        evict(dir)
        return { status: 'ok', path: cached }
      } catch { return { status: 'unavailable' } }
      finally {
        active--
        try { rmSync(work, { recursive: true, force: true }) } catch { /* temp */ }
      }
    },
  }
}

export const previewThumbnailer = createThumbnailer({
  dir: () => dataPath('preview-thumbs'),
  tmp: () => tmpdir(),
  now: Date.now,
  run: realRun,
})
