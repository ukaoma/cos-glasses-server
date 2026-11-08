/**
 * The content parts of the preview contract (preview engine phase 1, PLAN 4c). Pure transforms of bytes that were
 * already authorized and read by the resolver (agent-session-output-images.ts `previewFile`), plus the headers each
 * part is served with. Every part has a FIXED type; nothing a file says about itself decides how it is served.
 *
 *   raw      octet-stream attachment, sandbox CSP
 *   inline   a PDF for the browser's viewer (images go through the normalizer instead)
 *   text     JSON: a UTF-8 window, 512 KiB per call, `more` for "load more" (HTML: up to 8 MiB, one call)
 *   table    JSON: CSV or TSV rows, 200 a page, 50 columns, 5,000 rows in all
 *   html     the page as text/html under `CSP: sandbox` (no scripts, opaque origin, no network), full length (32 MiB)
 *   html-run the page under `CSP: sandbox allow-scripts` and `connect-src 'none'`: scripts run, nothing is fetched
 *            Both HTML parts also carry a CSP <meta> injected at the top of the document (PLAN 6), so the policy holds
 *            even where a response header is lost on the way (a proxy, a saved copy, a future srcdoc frame).
 *   thumb    PNG from Quick Look (`qlmanage -t`), see preview-thumbs.ts
 */

export const TEXT_WINDOW_MAX = 512 * 1024
/** HTML is shown full length (PLAN 5: the 512 KiB cut is gone), up to the raw-file cap. */
export const HTML_PREVIEW_MAX = 32 * 1024 * 1024
export const TABLE_PAGE_ROWS = 200
export const TABLE_COLUMNS_MAX = 50
export const TABLE_ROWS_MAX = 5000
export const TABLE_CELL_CHARS = 1000
export const TABLE_BYTES_MAX = 16 * 1024 * 1024

export type PreviewPart = 'raw' | 'inline' | 'text' | 'table' | 'html' | 'html-run' | 'thumb'
export const PREVIEW_PARTS: readonly PreviewPart[] = ['raw', 'inline', 'text', 'table', 'html', 'html-run', 'thumb']

/** Scripts off: nothing runs, nothing is fetched (a remote image is a tracking pixel and leaks the phone's address). */
export const HTML_SAFE_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
/**
 * "Run scripts" (Miles decision 3): inline script runs in a unique opaque origin (no allow-same-origin), with no
 * network (`connect-src 'none'`, no remote script, image, style or font), no forms, no popups and no top navigation
 * (sandbox tokens other than allow-scripts are absent). It can read only itself, never the COS cookie or API.
 */
export const HTML_RUN_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
export const DERIVED_CSP = "sandbox; default-src 'none'"
/**
 * The policies injected as a <meta> (a meta CSP cannot carry `sandbox` or `frame-ancestors`; the header and the frame's
 * own sandbox attribute carry those). Two policies are both enforced, so a page's own looser meta never widens these.
 */
export const HTML_SAFE_META_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'"
export const HTML_RUN_META_CSP = "default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"

/**
 * The page with a CSP <meta> as the first thing the parser sees after any BOM, leading whitespace, comments and the
 * doctype (a tag before the doctype would put the page in quirks mode). Nothing before that point can load anything.
 * Bytes are spliced, never re-encoded, so a page in another charset is not changed beyond the inserted tag.
 */
export function withCspMeta(bytes: Buffer, part: 'html' | 'html-run'): Buffer {
  const policy = part === 'html-run' ? HTML_RUN_META_CSP : HTML_SAFE_META_CSP
  const tag = Buffer.from(`<meta http-equiv="Content-Security-Policy" content="${policy}">`, 'utf8')
  // The prefix is ASCII in every case that matters; latin1 keeps one char per byte so offsets are byte offsets.
  const head = bytes.subarray(0, 64 * 1024).toString('latin1')
  let at = head.charCodeAt(0) === 0xef && head.charCodeAt(1) === 0xbb && head.charCodeAt(2) === 0xbf ? 3 : 0
  for (let guard = 0; guard < 64; guard++) {
    const ws = /^[\t\n\f\r ]*/.exec(head.slice(at))![0].length
    at += ws
    if (head.startsWith('<!--', at)) {
      const end = head.indexOf('-->', at + 4)
      if (end < 0) break
      at = end + 3; continue
    }
    if (/^<!doctype[\s>]/i.test(head.slice(at, at + 10))) {
      const end = head.indexOf('>', at)
      if (end < 0) break
      at = end + 1; continue
    }
    break
  }
  return Buffer.concat([bytes.subarray(0, at), tag, bytes.subarray(at)])
}

function asciiName(name: string): string { return name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[ .]+/, '') || 'file' }

/** Headers for each part. `nosniff`, `no-store` and same-origin CORP on every one. */
export function previewHeaders(part: PreviewPart, name: string): Record<string, string> {
  const base: Record<string, string> = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Cross-Origin-Resource-Policy': 'same-origin' }
  const disposition = (kind: 'inline' | 'attachment') => `${kind}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
  switch (part) {
    case 'raw': return { ...base, 'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition('attachment'), 'Content-Security-Policy': DERIVED_CSP }
    case 'inline': return { ...base, 'Content-Type': 'application/pdf', 'Content-Disposition': disposition('inline') }
    case 'html': return { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline', 'Content-Security-Policy': HTML_SAFE_CSP, 'Referrer-Policy': 'no-referrer' }
    case 'html-run': return { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline', 'Content-Security-Policy': HTML_RUN_CSP, 'Referrer-Policy': 'no-referrer' }
    case 'thumb': return { ...base, 'Content-Type': 'image/png', 'Content-Disposition': 'inline', 'Content-Security-Policy': DERIVED_CSP }
    default: return { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Security-Policy': DERIVED_CSP }
  }
}

/** A NUL byte in the first 8 KiB: a binary file, never shown as words. */
export function looksBinary(bytes: Buffer): boolean { return bytes.subarray(0, 8192).includes(0) }

function charStart(bytes: Buffer, at: number): number {
  let i = Math.max(0, Math.min(at, bytes.length))
  while (i < bytes.length && i > 0 && (bytes[i] & 0xc0) === 0x80) i--
  return i
}

/** A UTF-8 window that never splits a character. `end` is where the next window starts. */
export function textWindow(bytes: Buffer, offset: number, limit: number, max = TEXT_WINDOW_MAX): { text: string; offset: number; end: number; size: number; more: boolean } {
  const want = Math.max(1, Math.min(max, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : max))
  let start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  if (start > bytes.length) start = bytes.length
  // A start inside a character moves forward to the next one.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  let end = Math.min(bytes.length, start + want)
  if (end < bytes.length) { const c = charStart(bytes, end); end = c > start ? c : end }
  let text = bytes.subarray(start, end).toString('utf8')
  if (start === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { text, offset: start, end, size: bytes.length, more: end < bytes.length }
}

/**
 * RFC 4180 rows from CSV (or TSV): quoted fields, doubled quotes, CR LF or LF, a newline inside quotes. Bounded: at most
 * TABLE_ROWS_MAX rows are ever read, TABLE_COLUMNS_MAX columns per row and TABLE_CELL_CHARS per cell are kept.
 */
export function tableRows(text: string, delimiter: ',' | '\t', limitRows = TABLE_ROWS_MAX): { rows: string[][]; complete: boolean; columnsCut: boolean } {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, columnsCut = false, i = 0
  const push = () => {
    if (row.length < TABLE_COLUMNS_MAX) row.push(cell.length > TABLE_CELL_CHARS ? cell.slice(0, TABLE_CELL_CHARS - 1) + '…' : cell)
    else columnsCut = true
    cell = ''
  }
  const endRow = () => { push(); rows.push(row); row = [] }
  if (text.charCodeAt(0) === 0xfeff) i = 1
  for (; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { if (cell.length <= TABLE_CELL_CHARS) cell += '"'; i++ } else quoted = false }
      else if (cell.length <= TABLE_CELL_CHARS) cell += c
      continue
    }
    if (c === '"' && cell === '') { quoted = true; continue }
    if (c === delimiter) { push(); continue }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
      if (rows.length >= limitRows) return { rows, complete: i + 1 >= text.length, columnsCut }
      continue
    }
    if (cell.length <= TABLE_CELL_CHARS) cell += c
  }
  if (cell !== '' || row.length) endRow()
  return { rows, complete: true, columnsCut }
}

/** One page of a table: the header row always first, then rows [offset, offset + TABLE_PAGE_ROWS). */
export function tablePage(bytes: Buffer, name: string, offset: number): { header: string[]; rows: string[][]; offset: number; next: number; more: boolean; capped: boolean; columnsCut: boolean } {
  const text = bytes.subarray(0, TABLE_BYTES_MAX).toString('utf8')
  const delimiter = /\.tsv$/i.test(name) ? '\t' : ','
  const parsed = tableRows(text, delimiter, TABLE_ROWS_MAX + 1)
  const all = parsed.rows
  const header = all[0] ?? []
  const body = all.slice(1, TABLE_ROWS_MAX + 1)
  const start = Math.max(0, Math.min(body.length, Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0))
  const page = body.slice(start, start + TABLE_PAGE_ROWS)
  const next = start + page.length
  const capped = !parsed.complete || bytes.length > TABLE_BYTES_MAX || all.length > TABLE_ROWS_MAX
  return { header, rows: page, offset: start, next, more: next < body.length, capped, columnsCut: parsed.columnsCut }
}
