/** Preview engine phase 1: text windows, the CSV/TSV table and its caps, and the header contract for every part. */
import { describe, expect, it } from 'vitest'
import {
  HTML_RUN_CSP, HTML_SAFE_CSP, looksBinary, PREVIEW_PARTS, previewHeaders, TABLE_CELL_CHARS, TABLE_COLUMNS_MAX, TABLE_PAGE_ROWS, TABLE_ROWS_MAX,
  tablePage, tableRows, textWindow,
} from './preview-content.js'

describe('textWindow', () => {
  it('never splits a UTF-8 character, and the next window starts where this one ended', () => {
    const bytes = Buffer.from('ab€cd', 'utf8') // € is 3 bytes at offsets 2..4
    const first = textWindow(bytes, 0, 3)
    expect(first).toMatchObject({ text: 'ab', offset: 0, end: 2, more: true, size: 7 })
    const second = textWindow(bytes, first.end, 3)
    expect(second).toMatchObject({ text: '€', end: 5, more: true })
    expect(textWindow(bytes, 3, 10), 'a start inside a character moves forward').toMatchObject({ text: 'cd', offset: 5, more: false })
  })
  it('caps the window and strips a BOM', () => {
    const big = Buffer.alloc(2000, 'x')
    expect(textWindow(big, 0, 10_000, 1000).text.length).toBe(1000)
    expect(textWindow(Buffer.from('﻿hi', 'utf8'), 0, 100).text).toBe('hi')
    expect(textWindow(big, -5, NaN, 1000).offset).toBe(0)
  })
  it('a NUL in the first 8 KiB is binary', () => {
    expect(looksBinary(Buffer.from('a\u0000b'))).toBe(true)
    expect(looksBinary(Buffer.from('plain words'))).toBe(false)
  })
})

describe('tables', () => {
  it('RFC 4180: quotes, doubled quotes, CRLF, a newline inside quotes; TSV by extension', () => {
    expect(tableRows('a,"b,c","say ""hi"""\r\n1,"two\nlines",3\n', ',').rows).toEqual([['a', 'b,c', 'say "hi"'], ['1', 'two\nlines', '3']])
    expect(tablePage(Buffer.from('a\tb\n1\t2\n'), 'x.tsv', 0)).toMatchObject({ header: ['a', 'b'], rows: [['1', '2']], more: false })
  })
  it(`pages of ${TABLE_PAGE_ROWS}, at most ${TABLE_ROWS_MAX} rows, ${TABLE_COLUMNS_MAX} columns and ${TABLE_CELL_CHARS} characters a cell`, () => {
    const lines = ['h'].concat(Array.from({ length: TABLE_ROWS_MAX + 50 }, (_, i) => String(i)))
    const csv = Buffer.from(lines.join('\n') + '\n')
    const p0 = tablePage(csv, 'x.csv', 0)
    expect(p0.rows).toHaveLength(TABLE_PAGE_ROWS)
    expect(p0).toMatchObject({ header: ['h'], offset: 0, next: TABLE_PAGE_ROWS, more: true, capped: true })
    const last = tablePage(csv, 'x.csv', TABLE_ROWS_MAX - 10)
    expect(last.rows).toHaveLength(10)
    expect(last.more).toBe(false)
    const wide = tablePage(Buffer.from(Array.from({ length: 80 }, (_, i) => 'c' + i).join(',') + '\n' + 'x'.repeat(5000) + '\n'), 'w.csv', 0)
    expect(wide.header).toHaveLength(TABLE_COLUMNS_MAX)
    expect(wide.columnsCut).toBe(true)
    expect(wide.rows[0][0].length).toBe(TABLE_CELL_CHARS)
    expect(tablePage(Buffer.from('a\n1\n'), 'x.csv', 0)).toMatchObject({ capped: false, more: false })
  })
})

describe('the header contract for every part', () => {
  it('nosniff, no-store and same-origin CORP on every part; each part has its fixed type', () => {
    const types: Record<string, RegExp> = {
      raw: /^application\/octet-stream$/, inline: /^application\/pdf$/, text: /^application\/json/, table: /^application\/json/,
      html: /^text\/html; charset=utf-8$/, 'html-run': /^text\/html; charset=utf-8$/, thumb: /^image\/png$/,
    }
    for (const part of PREVIEW_PARTS) {
      const h = previewHeaders(part, 'Q3 plan€.md')
      expect(h['X-Content-Type-Options'], part).toBe('nosniff')
      expect(h['Cache-Control'], part).toBe('private, no-store')
      expect(h['Cross-Origin-Resource-Policy'], part).toBe('same-origin')
      expect(h['Content-Type'], part).toMatch(types[part])
    }
    expect(previewHeaders('raw', 'a.html')['Content-Disposition']).toMatch(/^attachment;/)
    expect(previewHeaders('raw', 'a.html')['Content-Security-Policy']).toBe("sandbox; default-src 'none'")
    expect(previewHeaders('inline', 'a.pdf')['Content-Disposition']).toMatch(/^inline;/)
  })
  it('HTML is only ever served sandboxed: scripts off with no network, or scripts on in an opaque origin with no network', () => {
    const safe = previewHeaders('html', 'r.html')['Content-Security-Policy']
    expect(safe).toBe(HTML_SAFE_CSP)
    expect(safe).toMatch(/^sandbox;/)
    expect(safe).not.toMatch(/allow-/)
    expect(safe).toContain("default-src 'none'")
    expect(safe).not.toMatch(/script-src|https?:/)
    const run = previewHeaders('html-run', 'r.html')['Content-Security-Policy']
    expect(run).toBe(HTML_RUN_CSP)
    expect(run).toMatch(/^sandbox allow-scripts;/)
    expect(run).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/)
    expect(run).toContain("connect-src 'none'")
    expect(run).toContain("default-src 'none'")
    expect(run).toContain("form-action 'none'")
    expect(run).not.toMatch(/https?:|\*/)
  })
})
