import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { extractXlsxText, XlsxError, XLSX_LIMITS } from './xlsx-text.js'
import { prepareRichMedia, RichMediaSafetyError } from './rich-media-safety.js'

/** A minimal zip writer for fixtures: entries are deflated or stored, the CRC is not checked by the reader. */
function zip(parts: Record<string, string>, opts: { stored?: boolean; encrypted?: boolean; understate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.from(text, 'utf8'), body = opts.stored ? raw : deflateRawSync(raw), method = opts.stored ? 0 : 8
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(opts.encrypted ? 1 : 0, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(opts.understate ? 100 : raw.length, 22); local.writeUInt16LE(nameBytes.length, 26)
    const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(opts.encrypted ? 1 : 0, 8); head.writeUInt16LE(method, 10)
    head.writeUInt32LE(body.length, 20); head.writeUInt32LE(opts.understate ? 100 : raw.length, 24); head.writeUInt16LE(nameBytes.length, 28); head.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body); central.push(head, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const col = (i: number): string => (i >= 26 ? col(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26))
/** A sheet from rows of cells: a string cell is a shared-string index into `strings`, a number is a numeric cell, null is skipped. */
function sheetXml(rows: Array<Array<string | number | null>>, strings: string[]): string {
  const body = rows.map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => {
    if (v === null) return ''
    if (typeof v === 'number') return `<c r="${col(c)}${r + 1}"><v>${v}</v></c>`
    let at = strings.indexOf(v); if (at < 0) { strings.push(v); at = strings.length - 1 }
    return `<c r="${col(c)}${r + 1}" t="s"><v>${at}</v></c>`
  }).join('')}</row>`).join('')
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}
function workbook(sheets: Array<{ name: string; rows: Array<Array<string | number | null>> }>, extra: Record<string, string> = {}, opts: { stored?: boolean } = {}): Buffer {
  const strings: string[] = []
  const parts: Record<string, string> = {}
  sheets.forEach((s, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows, strings) })
  parts['xl/workbook.xml'] = `<workbook xmlns:r="x"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`
  parts['xl/_rels/workbook.xml.rels'] = `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`
  parts['xl/sharedStrings.xml'] = `<sst>${strings.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`
  return zip({ ...parts, ...extra }, opts)
}

describe('extractXlsxText', () => {
  it('reads sheet names and cell values as tab-separated rows, with shared strings resolved and gaps kept', () => {
    const out = extractXlsxText(workbook([
      { name: 'Pipeline', rows: [['Brand', 'Leads', 'Budget'], ['Bottle POS', 120, 100], [null, null, 5]] },
      { name: 'Notes & Misc', rows: [['Open items'], []] },
    ]))
    expect(out.text).toBe('Sheet: Pipeline\nBrand\tLeads\tBudget\nBottle POS\t120\t100\n\t\t5\n\nSheet: Notes & Misc\nOpen items')
    expect(out.sheets).toBe(2)
    expect(out.truncated).toBe(false)
  })
  it('works on stored (uncompressed) entries too', () => {
    expect(extractXlsxText(workbook([{ name: 'S', rows: [['a', 'b']] }], {}, { stored: true })).text).toBe('Sheet: S\na\tb')
  })
  it('does not evaluate formulas: a formula cell shows its saved value, and booleans, errors, inline strings and entities read plainly', () => {
    const strings: string[] = []
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>42</v></c><c r="B1" t="b"><v>1</v></c><c r="C1" t="e"><v>#DIV/0!</v></c><c r="D1" t="inlineStr"><is><t>Tom &amp; Jerry</t></is></c><c r="E1" t="str"><f>A1&amp;"x"</f><v>42x</v></c></row></sheetData></worksheet>`
    const parts = { 'xl/worksheets/sheet1.xml': sheet, 'xl/workbook.xml': '<workbook><sheets><sheet name="F"/></sheets></workbook>' }
    expect(strings).toEqual([])
    expect(extractXlsxText(zip(parts)).text).toBe('Sheet: F\n42\tTRUE\t#DIV/0!\tTom & Jerry\t42x')
  })
  it('reads rich-text shared strings and skips phonetic guides', () => {
    const parts = {
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
      'xl/sharedStrings.xml': '<sst><si><r><t>Hello </t></r><r><t>world</t></r><rPh><t>ignored</t></rPh></si></sst>',
      'xl/workbook.xml': '<workbook><sheets><sheet name="R"/></sheets></workbook>',
    }
    expect(extractXlsxText(zip(parts)).text).toBe('Sheet: R\nHello world')
  })

  describe('caps hold', () => {
    it(`stops at ${XLSX_LIMITS.maxRowsPerSheet} non-empty rows per sheet and says so`, () => {
      const rows = Array.from({ length: XLSX_LIMITS.maxRowsPerSheet + 25 }, (_, i) => [`row${i}`])
      const out = extractXlsxText(workbook([{ name: 'Big', rows }]))
      const lines = out.text.split('\n')
      expect(lines.filter(l => l.startsWith('row'))).toHaveLength(XLSX_LIMITS.maxRowsPerSheet)
      expect(lines).toContain(`[Only the first ${XLSX_LIMITS.maxRowsPerSheet} rows of this sheet are read.]`)
      expect(out.text).not.toContain(`row${XLSX_LIMITS.maxRowsPerSheet}`)
      expect(out.truncated).toBe(true)
    })
    it(`keeps ${XLSX_LIMITS.maxColumns} columns and ${XLSX_LIMITS.maxCellChars} characters a cell`, () => {
      const wide = Array.from({ length: XLSX_LIMITS.maxColumns + 10 }, (_, i) => `c${i}`)
      const out = extractXlsxText(workbook([{ name: 'W', rows: [wide, ['x'.repeat(XLSX_LIMITS.maxCellChars + 100)]] }]))
      const [, head, long] = out.text.split('\n')
      expect(head.split('\t')).toHaveLength(XLSX_LIMITS.maxColumns)
      expect(head.split('\t').at(-1)).toBe(`c${XLSX_LIMITS.maxColumns - 1}`)
      expect(long).toHaveLength(XLSX_LIMITS.maxCellChars)
    })
    it(`reads ${XLSX_LIMITS.maxSheets} sheets and names the rest`, () => {
      const sheets = Array.from({ length: XLSX_LIMITS.maxSheets + 2 }, (_, i) => ({ name: `S${i + 1}`, rows: [[`v${i + 1}`]] }))
      const out = extractXlsxText(workbook(sheets))
      expect(out.text).toContain(`Sheet: S${XLSX_LIMITS.maxSheets}`)
      expect(out.text).not.toContain(`Sheet: S${XLSX_LIMITS.maxSheets + 1}`)
      expect(out.text).toContain('[2 more sheets not read: S13, S14.]')
    })
    it(`never returns more than ${XLSX_LIMITS.maxChars} characters in all`, () => {
      const rows = Array.from({ length: XLSX_LIMITS.maxRowsPerSheet }, (_, r) => Array.from({ length: XLSX_LIMITS.maxColumns }, (_, c) => `r${r}c${c}${'z'.repeat(60)}`))
      const out = extractXlsxText(workbook(Array.from({ length: XLSX_LIMITS.maxSheets }, (_, i) => ({ name: `Sheet${i}`, rows }))))
      expect(out.text.length).toBeLessThanOrEqual(XLSX_LIMITS.maxChars)
      expect(out.text.endsWith(`[Text cut at ${XLSX_LIMITS.maxChars} characters.]`)).toBe(true)
      expect(out.truncated).toBe(true)
    })
    it('a part that inflates past its cap is not read (a zip bomb stops at the cap) and the sheet says so', () => {
      const bomb = `<worksheet><sheetData>${'<row r="1"><c r="A1"><v>1</v></c></row>'.repeat(Math.ceil(XLSX_LIMITS.maxSheetBytes / 38) + 10)}</sheetData></worksheet>`
      expect(bomb.length).toBeGreaterThan(XLSX_LIMITS.maxSheetBytes)
      const parts = { 'xl/worksheets/sheet1.xml': bomb, 'xl/workbook.xml': '<workbook><sheets><sheet name="Bomb"/></sheets></workbook>' }
      expect(extractXlsxText(zip(parts)).text).toBe('Sheet: Bomb\n[This sheet could not be read.]')
    })
    it('a part whose header understates its size still stops at the inflate cap (the header is not trusted)', () => {
      const bomb = `<worksheet><sheetData>${'<row r="1"><c r="A1"><v>1</v></c></row>'.repeat(Math.ceil(XLSX_LIMITS.maxSheetBytes / 38) + 10)}</sheetData></worksheet>`
      const parts = { 'xl/worksheets/sheet1.xml': bomb, 'xl/workbook.xml': '<workbook><sheets><sheet name="Liar"/></sheets></workbook>' }
      expect(extractXlsxText(zip(parts, { understate: true })).text).toBe('Sheet: Liar\n[This sheet could not be read.]')
    })
    it('a stored part larger than its cap is refused by its header size (nothing inflates it, so the header is the only guard)', () => {
      const padded = `<workbook><sheets><sheet name="Pad"/></sheets></workbook><!--${'x'.repeat(XLSX_LIMITS.maxPartBytes + 1000)}-->`
      expect(() => extractXlsxText(zip({ 'xl/workbook.xml': padded }, { stored: true }))).toThrowError(expect.objectContaining({ code: 'not_a_workbook' }))
    })
    it(`refuses a workbook over ${XLSX_LIMITS.maxBytes} bytes without reading it`, () => {
      expect(() => extractXlsxText(Buffer.alloc(XLSX_LIMITS.maxBytes + 1))).toThrowError(expect.objectContaining({ code: 'too_large' }))
    })
  })

  it('refuses what is not a readable workbook: not a zip, encrypted, no workbook part, no sheets', () => {
    const code = (b: Buffer): string => { try { extractXlsxText(b); return 'ok' } catch (e) { return e instanceof XlsxError ? e.code : 'other' } }
    expect(code(Buffer.from('plain text, not a zip at all, long enough to pass the length check'))).toBe('not_a_workbook')
    expect(code(zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="A"/></sheets></workbook>' }, { encrypted: true }))).toBe('encrypted')
    expect(code(zip({ 'readme.txt': 'hi' }))).toBe('not_a_workbook')
    expect(code(zip({ 'xl/workbook.xml': '<workbook><sheets></sheets></workbook>' }))).toBe('not_a_workbook')
    expect(code(workbook([{ name: 'A', rows: [['x']] }]).subarray(0, 60))).toBe('corrupt')
  })
})

describe('the media ingress admits .xlsx (phone attachments and the files/media route read the same text)', () => {
  it('a workbook becomes a document with the extracted text, by name or by declared type, and a renamed zip is not one', async () => {
    const wb = workbook([{ name: 'Q3', rows: [['Item', 'Cost'], ['Sign', 40]] }])
    const byName = await prepareRichMedia(wb, { label: 'budget.xlsx' })
    expect(byName).toMatchObject({ category: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText: 'Sheet: Q3\nItem\tCost\nSign\t40' })
    const byType = await prepareRichMedia(wb, { label: 'budget', declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary' })
    expect(byType.category === 'document' && byType.extractedText).toContain('Sheet: Q3')
    await expect(prepareRichMedia(wb, { label: 'budget.docx' })).rejects.toBeInstanceOf(RichMediaSafetyError)
    await expect(prepareRichMedia(Buffer.from('not a zip at all, but named xlsx'), { label: 'x.xlsx' })).rejects.toMatchObject({ code: 'unsupported_attachment_format' })
  })
  it('a zip signature is required: CSV bytes named .xlsx but declared text/csv are still read as CSV', async () => {
    const csv = await prepareRichMedia(Buffer.from('a,b\n1,2\n'), { label: 'data.xlsx', declaredMime: 'text/csv' })
    expect(csv).toMatchObject({ category: 'document', mime: 'text/csv', extractedText: 'a,b\n1,2' })
  })
  it('an encrypted workbook is refused; a workbook with no cell values still reports its sheet names', async () => {
    await expect(prepareRichMedia(zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="A"/></sheets></workbook>' }, { encrypted: true }), { label: 'e.xlsx' })).rejects.toMatchObject({ code: 'corrupt_attachment' })
    await expect(prepareRichMedia(workbook([{ name: 'Empty', rows: [[]] }]), { label: 'empty.xlsx' })).resolves.toMatchObject({ extractedText: 'Sheet: Empty' })
  })
})
