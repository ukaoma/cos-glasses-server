// Plain text from an .xlsx workbook, for meeting context. No dependency: an .xlsx is a zip of XML parts, read here with
// node:zlib and a small bounded zip reader.
//
// What comes out. For each sheet, in workbook order: a "Sheet: <name>" line, then each non-empty row as tab-separated cell
// values. Shared strings are resolved. NO FORMULA IS EVALUATED: a formula cell shows the value Excel last saved with it, and
// numbers and dates are shown exactly as stored (a date is its serial number). Charts, images, comments and macros are not read.
//
// Limits, all enforced while reading, never after:
//   XLSX_LIMITS.maxBytes         10 MB workbook
//   XLSX_LIMITS.maxSheets        12 sheets (later sheets are named in a notice, not read)
//   XLSX_LIMITS.maxRowsPerSheet  200 non-empty rows per sheet
//   XLSX_LIMITS.maxColumns       50 columns per row
//   XLSX_LIMITS.maxCellChars     200 characters per cell
//   XLSX_LIMITS.maxChars         100,000 characters of text in all (the same cap as the other document types)
//   inflate caps                 8 MB for shared strings, 16 MB per sheet, 4 MB for the other parts: a zip bomb stops at the cap
//   total inflated               48 MB across all parts of one workbook
//   work bound                   2 s of scanning in all (checked as the scanners advance); then XlsxError 'too_complex'
// Every scanner below is a linear indexOf pass that stops at a missing close tag. Nothing here uses a lazy [\s\S]*? regex over
// untrusted XML: with unclosed tags those go quadratic and an 8 to 16 MB part would hold the server for hours.
// Anything past a cap is cut and said so in a bracketed line in the text.
import { inflateRawSync } from 'node:zlib';

export const XLSX_LIMITS = {
  maxBytes: 10_000_000,
  maxSheets: 12,
  maxRowsPerSheet: 200,
  maxColumns: 50,
  maxCellChars: 200,
  maxChars: 100_000,
  maxSharedStringsBytes: 8_000_000,
  maxSheetBytes: 16_000_000,
  maxPartBytes: 4_000_000,
  maxTotalInflatedBytes: 48_000_000,
  maxWorkMs: 2_000,
} as const

export type XlsxErrorCode = 'too_large' | 'not_a_workbook' | 'encrypted' | 'unsupported_zip' | 'corrupt' | 'too_complex'
export class XlsxError extends Error {
  constructor(readonly code: XlsxErrorCode, message: string) {
    super(message)
    this.name = 'XlsxError'
  }
}

interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number }

function readEntries(zip: Buffer): Map<string, ZipEntry> {
  if (zip.length < 22 || zip.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('not_a_workbook', 'not a zip file')
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new XlsxError('corrupt', 'no end of central directory')
  const count = zip.readUInt16LE(eocd + 10)
  const cdSize = zip.readUInt32LE(eocd + 12)
  const cdOffset = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new XlsxError('unsupported_zip', 'zip64 is not supported')
  if (cdOffset + cdSize > zip.length || count > 5_000) throw new XlsxError('corrupt', 'central directory out of range')
  const entries = new Map<string, ZipEntry>()
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('corrupt', 'bad central directory entry')
    const flags = zip.readUInt16LE(p + 8)
    if (flags & 1) throw new XlsxError('encrypted', 'the workbook is encrypted')
    const nameLength = zip.readUInt16LE(p + 28), extraLength = zip.readUInt16LE(p + 30), commentLength = zip.readUInt16LE(p + 32)
    if (p + 46 + nameLength > zip.length) throw new XlsxError('corrupt', 'entry name out of range')
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength)
    entries.set(name, { name, method: zip.readUInt16LE(p + 10), compressedSize: zip.readUInt32LE(p + 20), size: zip.readUInt32LE(p + 24), offset: zip.readUInt32LE(p + 42) })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** One part, inflated with a hard output cap. Returns null past the cap or when the part is damaged. */
function readPart(zip: Buffer, entry: ZipEntry, cap: number): string | null {
  const at = entry.offset
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== 0x04034b50) return null
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28)
  if (start + entry.compressedSize > zip.length || entry.size > cap) return null
  const raw = zip.subarray(start, start + entry.compressedSize)
  try {
    const bytes = entry.method === 0 ? raw : entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: cap }) : null
    return bytes ? bytes.toString('utf8') : null
  } catch { return null }
}

/** The work bound: scanners call it as they advance; it reads the clock every 4,096 calls and throws once the deadline has passed. */
class Work {
  private n = 0
  private readonly deadline: number
  constructor(private readonly now: () => number) { this.deadline = now() + XLSX_LIMITS.maxWorkMs }
  tick(): void {
    if ((++this.n & 4095) === 0 && this.now() > this.deadline) throw new XlsxError('too_complex', `workbook took longer than ${XLSX_LIMITS.maxWorkMs} ms to scan`)
  }
}
interface Block { attrs: string; body: string | null }
/**
 * The <tag ...>body</tag> and <tag .../> elements of `xml`, in order, found with indexOf only. A tag without its closing tag ends the
 * scan (nothing after it is trusted), so every position is passed over at most a constant number of times. Nested elements of the same
 * name are not supported (none of the parts read here nest them).
 */
function* blocks(xml: string, tag: string, work: Work): Generator<Block> {
  const open = `<${tag}`, close = `</${tag}>`
  let at = 0
  for (;;) {
    const start = xml.indexOf(open, at)
    if (start < 0) return
    const after = start + open.length
    const c = xml.charCodeAt(after)
    // <row but not <rowBreaks: the name must end here.
    if (!(c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13)) { at = after; continue }
    const gt = xml.indexOf('>', after)
    if (gt < 0) return
    work.tick()
    if (xml.charCodeAt(gt - 1) === 47) {
      yield { attrs: xml.slice(after, gt - 1), body: null }
      at = gt + 1
      continue
    }
    const end = xml.indexOf(close, gt + 1)
    if (end < 0) return
    yield { attrs: xml.slice(after, gt), body: xml.slice(gt + 1, end) }
    at = end + close.length
  }
}
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function unescapeXml(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return ENTITIES[name.toLowerCase()]
    const code = hex ? parseInt(hex, 16) : Number(dec)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
  })
}
/** `fragment` without its <rPh>...</rPh> phonetic guides; an unclosed <rPh> drops the rest. */
function withoutGuides(fragment: string): string {
  let out = '', at = 0
  for (;;) {
    const start = fragment.indexOf('<rPh', at)
    if (start < 0) return out + fragment.slice(at)
    out += fragment.slice(at, start)
    const end = fragment.indexOf('</rPh>', start)
    if (end < 0) return out
    at = end + 6
  }
}
/** The text of every <t> in a fragment, phonetic guides left out. */
function textOf(fragment: string, work: Work): string {
  let out = ''
  for (const t of blocks(withoutGuides(fragment), 't', work)) if (t.body) out += unescapeXml(t.body)
  return out
}
const ATTR_PATTERNS = new Map<string, RegExp>()
function attr(tag: string, name: string): string | undefined {
  let pattern = ATTR_PATTERNS.get(name)
  if (!pattern) ATTR_PATTERNS.set(name, pattern = new RegExp(`\\b${name}="([^"]*)"`))
  const m = pattern.exec(tag)
  return m ? unescapeXml(m[1]) : undefined
}
/** Column letters to a zero-based index: A is 0, AA is 26. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? ''
  let n = 0
  for (const ch of letters.slice(0, 4)) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
const clean = (value: string): string => value.replace(/[\t\r\n]+/g, ' ').trim().slice(0, XLSX_LIMITS.maxCellChars)

function sharedStrings(xml: string | null, work: Work): string[] {
  if (!xml) return []
  const out: string[] = []
  for (const si of blocks(xml, 'si', work)) out.push(si.body ? textOf(si.body, work) : '')
  return out
}

function firstBody(xml: string, tag: string, work: Work): string | undefined {
  for (const b of blocks(xml, tag, work)) return b.body ?? undefined
  return undefined
}
function cellValue(attrs: string, body: string, strings: readonly string[], work: Work): string {
  const type = attr(attrs, 't')
  if (type === 'inlineStr') return textOf(firstBody(body, 'is', work) ?? '', work)
  const v = firstBody(body, 'v', work)
  if (v === undefined) return ''
  const value = unescapeXml(v)
  if (type === 's') return strings[Number(value)] ?? ''
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'
  return value
}

/** Rows of one sheet as tab-separated text, at most maxRowsPerSheet non-empty rows. */
function sheetRows(xml: string, strings: readonly string[], work: Work): { lines: string[]; cut: boolean } {
  const lines: string[] = []
  for (const row of blocks(xml, 'row', work)) {
    if (!row.body) continue
    const cells: string[] = []
    let next = 0
    for (const c of blocks(row.body, 'c', work)) {
      const ref = attr(c.attrs, 'r')
      const at = ref ? columnIndex(ref) : next
      if (at >= XLSX_LIMITS.maxColumns) break
      const value = clean(cellValue(c.attrs, c.body ?? '', strings, work))
      while (cells.length < at) cells.push('')
      cells[at] = value
      next = at + 1
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop()
    if (!cells.length) continue
    if (lines.length >= XLSX_LIMITS.maxRowsPerSheet) return { lines, cut: true }
    lines.push(cells.join('\t'))
  }
  return { lines, cut: false }
}

const CUT_NOTE = `[Text cut at ${XLSX_LIMITS.maxChars} characters.]`
export interface XlsxText { text: string; truncated: boolean; sheets: number }

/** The text of an .xlsx workbook. Throws XlsxError for anything that is not a readable, unencrypted workbook within the limits. */
export function extractXlsxText(bytes: Buffer, options: { now?: () => number } = {}): XlsxText {
  if (bytes.length > XLSX_LIMITS.maxBytes) throw new XlsxError('too_large', `workbook exceeds ${XLSX_LIMITS.maxBytes} bytes`)
  const work = new Work(options.now ?? Date.now)
  const entries = readEntries(bytes)
  let inflated = 0
  const part = (name: string, cap: number): string | null => {
    const entry = entries.get(name)
    const text = entry ? readPart(bytes, entry, cap) : null
    inflated += text?.length ?? 0
    if (inflated > XLSX_LIMITS.maxTotalInflatedBytes) throw new XlsxError('too_complex', `workbook inflates past ${XLSX_LIMITS.maxTotalInflatedBytes} bytes`)
    return text
  }
  const workbook = part('xl/workbook.xml', XLSX_LIMITS.maxPartBytes)
  if (!workbook) throw new XlsxError('not_a_workbook', 'no workbook part')
  const rels = new Map<string, string>()
  for (const m of blocks(part('xl/_rels/workbook.xml.rels', XLSX_LIMITS.maxPartBytes) ?? '', 'Relationship', work)) {
    const id = attr(m.attrs, 'Id'), target = attr(m.attrs, 'Target')
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  const sheets: Array<{ name: string; path: string }> = []
  let ordinal = 0
  for (const m of blocks(workbook, 'sheet', work)) {
    ordinal += 1
    const rid = /\br:id="([^"]*)"/.exec(m.attrs)?.[1]
    sheets.push({ name: clean(attr(m.attrs, 'name') ?? `Sheet${ordinal}`) || `Sheet${ordinal}`, path: (rid && rels.get(rid)) || `xl/worksheets/sheet${ordinal}.xml` })
  }
  if (!sheets.length) throw new XlsxError('not_a_workbook', 'no sheets')
  const strings = sharedStrings(part('xl/sharedStrings.xml', XLSX_LIMITS.maxSharedStringsBytes), work)
  const texts: string[] = []
  let truncated = false, used = 0
  // The cut marker is added after the cap is reached, so the budget leaves room for it and the whole text stays within maxChars.
  const budget = XLSX_LIMITS.maxChars - CUT_NOTE.length - 2
  let capped = false
  const push = (block: string): boolean => {
    if (used + block.length + 2 > budget) {
      capped = true
      const room = budget - used - 2
      if (room > 0) texts.push(block.slice(0, room))
      truncated = true
      return false
    }
    texts.push(block)
    used += block.length + 2
    return true
  }
  for (const [i, sheet] of sheets.entries()) {
    if (i >= XLSX_LIMITS.maxSheets) {
      push(`[${sheets.length - XLSX_LIMITS.maxSheets} more sheet${sheets.length - XLSX_LIMITS.maxSheets === 1 ? '' : 's'} not read: ${sheets.slice(XLSX_LIMITS.maxSheets).map(s => s.name).join(', ')}.]`)
      truncated = true
      break
    }
    const xml = part(sheet.path, XLSX_LIMITS.maxSheetBytes)
    if (xml === null) { if (!push(`Sheet: ${sheet.name}\n[This sheet could not be read.]`)) break; continue }
    const { lines, cut } = sheetRows(xml, strings, work)
    if (cut) truncated = true
    if (!push([`Sheet: ${sheet.name}`, ...lines, ...(cut ? [`[Only the first ${XLSX_LIMITS.maxRowsPerSheet} rows of this sheet are read.]`] : [])].join('\n'))) break
  }
  const text = texts.join('\n\n').trim()
  return { text: capped ? `${text}\n\n${CUT_NOTE}` : text, truncated, sheets: sheets.length }
}
