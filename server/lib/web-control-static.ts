/**
 * Fast static serving for COS Control Web (`/control/*`).
 *
 * Before this, `/control` went straight to `express.static`: no compression and
 * `Cache-Control: public, max-age=0`, so every open on the phone re-asked the Mac about
 * all 22 boot files over Tailscale and downloaded about 1.2 MB of uncompressed JS and CSS
 * plus 770 KB of fonts whenever anything changed.
 *
 * What this does:
 * - Every asset gets a content hash. `index.html` and the CSS files have their
 *   `/control/...` references rewritten to `/control/...?v=<hash>`.
 * - A request whose `?v=` matches the current hash is cached for a year as `immutable`.
 *   Anything else (index.html, a stale or missing `?v=`) is `no-cache`, so it revalidates
 *   with its ETag and a new release is picked up on the next open.
 * - Text assets are served brotli or gzip compressed when the browser accepts it. The
 *   compressed bytes are built on first request and kept in memory.
 * - Files on disk are re-checked at most once per `recheckMs`, so a test copy served from
 *   a worktree picks up edits without a restart.
 *
 * Anything not in the table (a path this walker skips) falls through to `next()`, and the
 * caller keeps `express.static` behind it, so no URL that worked before stops working.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

/** A versioned URL's lifetime. Safe because the hash changes whenever the bytes do. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
/** Unversioned and HTML responses: always revalidate, so a new release shows on the next open. */
export const REVALIDATE_CACHE = 'no-cache'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
}
/** Worth compressing. WOFF2 and images are already compressed. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.ttf'])
/** Files whose `/control/...` references are rewritten to versioned URLs. */
const REWRITTEN = new Set(['.html', '.css'])
/** Only assets of these types get a versioned URL; HTML pages are always revalidated. */
const VERSIONABLE = new Set(['.js', '.css', '.svg', '.json', '.ttf', '.woff2', '.png', '.webp', '.jpg'])

export interface WebAsset {
  /** Path under the mount, with a leading slash: `/panes/work.js`. */
  urlPath: string
  ext: string
  type: string
  body: Buffer
  /** First 16 hex characters of the SHA-256 of `body` (after any rewrite). */
  hash: string
  gzip?: Promise<Buffer>
  br?: Promise<Buffer>
}

export type WebAssetTable = Map<string, WebAsset>

/** Dotfiles are never served. Sources (`.ts`) and maps stay out because TYPES does not list them. */
function skip(name: string): boolean {
  return name.startsWith('.')
}

function walk(dir: string, base = ''): Array<{ urlPath: string; file: string; stat: fs.Stats }> {
  const out: Array<{ urlPath: string; file: string; stat: fs.Stats }> = []
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const name of names.sort()) {
    if (skip(name)) continue
    const file = path.join(dir, name)
    let stat: fs.Stats
    try { stat = fs.statSync(file) } catch { continue }
    const urlPath = `${base}/${name}`
    if (stat.isDirectory()) out.push(...walk(file, urlPath))
    else if (stat.isFile() && TYPES[path.extname(name).toLowerCase()]) out.push({ urlPath, file, stat })
  }
  return out
}

/** A cheap fingerprint of the tree: every path, size and mtime. */
export function treeSignature(dir: string): string {
  return walk(dir).map((f) => `${f.urlPath}:${f.stat.size}:${f.stat.mtimeMs}`).join('|')
}

function sha(body: Buffer): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/**
 * Rewrite `/control/<path>` references (quoted, or inside `url(...)`) to carry `?v=<hash>`.
 * Only references to a known, versionable asset are touched; a reference that already has a
 * query string, or names a file that does not exist, is left exactly as written.
 */
export function rewriteReferences(text: string, mount: string, hashes: Map<string, string>): string {
  const prefix = mount.replace(/\/$/, '')
  const re = new RegExp(`(["'(])${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[A-Za-z0-9_./-]+)(["')])`, 'g')
  return text.replace(re, (whole, open: string, rel: string, close: string) => {
    const hash = hashes.get(rel)
    if (!hash || !VERSIONABLE.has(path.extname(rel).toLowerCase())) return whole
    return `${open}${prefix}${rel}?v=${hash}${close}`
  })
}

/**
 * Build the table. Leaves (JS, fonts, images) are hashed first, then CSS is rewritten against
 * them and hashed, then HTML is rewritten against everything. So a font change gives its CSS a
 * new hash, and that gives index.html new references.
 */
export function buildWebAssetTable(dir: string, mount = '/control'): WebAssetTable {
  const files = walk(dir)
  const hashes = new Map<string, string>()
  const table: WebAssetTable = new Map()
  const read = (file: string): Buffer | null => { try { return fs.readFileSync(file) } catch { return null } }
  const add = (urlPath: string, ext: string, body: Buffer): void => {
    const hash = sha(body)
    hashes.set(urlPath, hash)
    table.set(urlPath, { urlPath, ext, type: TYPES[ext], body, hash })
  }
  const pass = (pick: (ext: string) => boolean): void => {
    for (const f of files) {
      const ext = path.extname(f.urlPath).toLowerCase()
      if (!pick(ext)) continue
      const raw = read(f.file)
      if (!raw) continue
      const body = REWRITTEN.has(ext) ? Buffer.from(rewriteReferences(raw.toString('utf8'), mount, hashes), 'utf8') : raw
      add(f.urlPath, ext, body)
    }
  }
  pass((ext) => !REWRITTEN.has(ext))
  pass((ext) => ext === '.css')
  pass((ext) => ext === '.html')
  return table
}

/** Which encoding to send: brotli, then gzip, then none. `q=0` refuses an encoding. */
export function pickEncoding(acceptEncoding: string | undefined): 'br' | 'gzip' | null {
  const accepted = new Map<string, number>()
  for (const part of String(acceptEncoding || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';')
    if (!name) continue
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    accepted.set(name.trim(), q ? Number(q.slice(2)) || 0 : 1)
  }
  const ok = (name: string): boolean => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0
  if (ok('br')) return 'br'
  if (ok('gzip')) return 'gzip'
  return null
}

function compressed(asset: WebAsset, encoding: 'br' | 'gzip'): Promise<Buffer> {
  if (encoding === 'br') {
    asset.br ??= new Promise((resolve, reject) => zlib.brotliCompress(asset.body, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: asset.body.length },
    }, (err, out) => (err ? reject(err) : resolve(out))))
    return asset.br
  }
  asset.gzip ??= new Promise((resolve, reject) => zlib.gzip(asset.body, { level: 9 }, (err, out) => (err ? reject(err) : resolve(out))))
  return asset.gzip
}

export interface WebControlStaticOptions {
  mount?: string
  /** How often the tree is re-checked for edits. 0 checks on every request. */
  recheckMs?: number
  now?: () => number
}

export function createWebControlStatic(dir: string, opts: WebControlStaticOptions = {}): RequestHandler & { table: () => WebAssetTable } {
  const mount = opts.mount ?? '/control'
  const recheckMs = opts.recheckMs ?? 1000
  const now = opts.now ?? Date.now
  let signature = treeSignature(dir)
  let table = buildWebAssetTable(dir, mount)
  let checkedAt = now()

  const current = (): WebAssetTable => {
    if (now() - checkedAt >= recheckMs) {
      checkedAt = now()
      const next = treeSignature(dir)
      if (next !== signature) { signature = next; table = buildWebAssetTable(dir, mount) }
    }
    return table
  }

  const handler = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return }
    let urlPath = req.path || '/'
    if (urlPath.endsWith('/')) urlPath += 'index.html'
    const asset = current().get(urlPath)
    if (!asset) { next(); return }

    const versioned = VERSIONABLE.has(asset.ext) && req.query.v === asset.hash
    const encoding = COMPRESSIBLE.has(asset.ext) ? pickEncoding(req.headers['accept-encoding'] as string | undefined) : null
    const etag = `"${asset.hash}${encoding ? `-${encoding}` : ''}"`
    res.setHeader('Content-Type', asset.type)
    res.setHeader('Cache-Control', versioned ? IMMUTABLE_CACHE : REVALIDATE_CACHE)
    res.setHeader('ETag', etag)
    if (COMPRESSIBLE.has(asset.ext)) res.setHeader('Vary', 'Accept-Encoding')

    const inm = String(req.headers['if-none-match'] || '')
    if (inm && inm.split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag)) { res.status(304).end(); return }

    const send = (body: Buffer): void => {
      if (encoding) res.setHeader('Content-Encoding', encoding)
      res.setHeader('Content-Length', String(body.length))
      if (req.method === 'HEAD') res.end(); else res.end(body)
    }
    if (!encoding) { send(asset.body); return }
    compressed(asset, encoding).then(send, () => {
      // Compression failed: send the plain bytes rather than nothing.
      res.removeHeader('Content-Encoding')
      res.setHeader('ETag', `"${asset.hash}"`)
      res.setHeader('Content-Length', String(asset.body.length))
      if (req.method === 'HEAD') res.end(); else res.end(asset.body)
    })
  }
  return Object.assign(handler, { table: current })
}
