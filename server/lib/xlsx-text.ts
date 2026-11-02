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
} as const

export type XlsxErrorCode = 'too_large' | 'not_a_workbook' | 'encrypted' | 'unsupported_zip' | 'corrupt'
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function unescapeXml(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return ENTITIES[name.toLowerCase()]
    const code = hex ? parseInt(hex, 16) : Number(dec)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
  })
}
/** The text of every <t> in a fragment, phonetic guides left out. */
function textOf(fragment: string): string {
  const withoutGuides = fragment.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '')
  let out = ''
  for (const m of withoutGuides.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1])
  return out
}
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]) : undefined
}
/** Column letters to a zero-based index: A is 0, AA is 26. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? ''
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
const clean = (value: string): string => value.replace(/[\t\r\n]+/g, ' ').trim().slice(0, XLSX_LIMITS.maxCellChars)

function sharedStrings(xml: string | null): string[] {
  if (!xml) return []
  const out: string[] = []
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1]))
  return out
}

function cellValue(tag: string, body: string, strings: readonly string[]): string {
  const type = attr(tag, 't')
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (type === 'inlineStr') return textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '')
  if (v === undefined) return ''
  const value = unescapeXml(v)
  if (type === 's') return strings[Number(value)] ?? ''
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'
  return value
}

/** Rows of one sheet as tab-separated text, at most maxRowsPerSheet non-empty rows. */
function sheetRows(xml: string, strings: readonly string[]): { lines: string[]; cut: boolean } {
  const lines: string[] = []
  const rowPattern = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g
  for (let m = rowPattern.exec(xml); m; m = rowPattern.exec(xml)) {
    if (!m[1]) continue
    const cells: string[] = []
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let next = 0
    for (let c = cellPattern.exec(m[1]); c; c = cellPattern.exec(m[1])) {
      const ref = attr(c[1], 'r')
      const at = ref ? columnIndex(ref) : next
      if (at >= XLSX_LIMITS.maxColumns) break
      const value = clean(cellValue(c[1], c[2] ?? '', strings))
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
export function extractXlsxText(bytes: Buffer): XlsxText {
  if (bytes.length > XLSX_LIMITS.maxBytes) throw new XlsxError('too_large', `workbook exceeds ${XLSX_LIMITS.maxBytes} bytes`)
  const entries = readEntries(bytes)
  const part = (name: string, cap: number): string | null => {
    const entry = entries.get(name)
    return entry ? readPart(bytes, entry, cap) : null
  }
  const workbook = part('xl/workbook.xml', XLSX_LIMITS.maxPartBytes)
  if (!workbook) throw new XlsxError('not_a_workbook', 'no workbook part')
  const rels = new Map<string, string>()
  for (const m of (part('xl/_rels/workbook.xml.rels', XLSX_LIMITS.maxPartBytes) ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id'), target = attr(m[1], 'Target')
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  const sheets: Array<{ name: string; path: string }> = []
  let ordinal = 0
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    ordinal += 1
    const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1]
    sheets.push({ name: clean(attr(m[1], 'name') ?? `Sheet${ordinal}`) || `Sheet${ordinal}`, path: (rid && rels.get(rid)) || `xl/worksheets/sheet${ordinal}.xml` })
  }
  if (!sheets.length) throw new XlsxError('not_a_workbook', 'no sheets')
  const strings = sharedStrings(part('xl/sharedStrings.xml', XLSX_LIMITS.maxSharedStringsBytes))
  const blocks: string[] = []
  let truncated = false, used = 0
  // The cut marker is added after the cap is reached, so the budget leaves room for it and the whole text stays within maxChars.
  const budget = XLSX_LIMITS.maxChars - CUT_NOTE.length - 2
  let capped = false
  const push = (block: string): boolean => {
    if (used + block.length + 2 > budget) {
      capped = true
      const room = budget - used - 2
      if (room > 0) blocks.push(block.slice(0, room))
      truncated = true
      return false
    }
    blocks.push(block)
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
    const { lines, cut } = sheetRows(xml, strings)
    if (cut) truncated = true
    if (!push([`Sheet: ${sheet.name}`, ...lines, ...(cut ? [`[Only the first ${XLSX_LIMITS.maxRowsPerSheet} rows of this sheet are read.]`] : [])].join('\n'))) break
  }
  const text = blocks.join('\n\n').trim()
  return { text: capped ? `${text}\n\n${CUT_NOTE}` : text, truncated, sheets: sheets.length }
}
