// 7.0.8 (Miles 2026-11-08, IMG #43): a Control Web shortcut saved to the iPhone home screen showed a grey "C", because
// iOS ignores the SVG favicon. The page names a 180 px PNG apple-touch-icon, which the asset table serves as image/png.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildWebAssetTable } from '../lib/web-control-static.js'
const DIR = path.dirname(fileURLToPath(import.meta.url))
describe('Control Web home screen icon', () => {
  it('index.html links the apple-touch-icon (versioned by the asset table)', () => {
    const table = buildWebAssetTable(DIR)
    const html = table.get('/index.html')!.body.toString('utf8')
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/control\/apple-touch-icon\.png\?v=[0-9a-f]+">/)
  })
  it('the icon is a real 180 x 180 PNG served as image/png', () => {
    const entry = buildWebAssetTable(DIR).get('/apple-touch-icon.png')!
    expect(entry.type).toBe('image/png')
    const png = readFileSync(path.join(DIR, 'apple-touch-icon.png'))
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180])
  })
})
