import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterCalibrationRows, purgeSpeakerCalibrationRows } from './speaker-calibration-log.js'

let dir = ''
let logPath = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cos-calibration-'))
  logPath = join(dir, 'speaker-calibration.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function rows(...entries: Array<Record<string, unknown>>): string {
  return entries.map(e => JSON.stringify(e)).join('\n') + '\n'
}

describe('calibration rows are matched exactly on the speaker field', () => {
  it('drops the target and keeps everyone else', () => {
    const { text, result } = filterCalibrationRows(rows(
      { ts: 't1', speaker: 'Clem Ukaoma', similarity: 0.6, matched: true },
      { ts: 't2', speaker: 'MU', similarity: 0.9, matched: true },
      { ts: 't3', speaker: 'Clem Ukaoma', similarity: 0.58, matched: true },
    ), 'Clem Ukaoma')
    expect(result).toEqual({ removed: 2, retained: 1, unparsable: 0 })
    expect(text).toBe(rows({ ts: 't2', speaker: 'MU', similarity: 0.9, matched: true }))
  })

  it('does NOT substring-match — "Miles" must not take "Miles Mallard"', () => {
    const { result, text } = filterCalibrationRows(rows(
      { ts: 't1', speaker: 'Miles Mallard' },
      { ts: 't2', speaker: 'Miles' },
    ), 'Miles')
    expect(result.removed).toBe(1)
    expect(text).toContain('Miles Mallard')
  })

  it('RETAINS an unparsable row rather than assuming it belongs to the target', () => {
    const raw = `{"speaker":"MU"}\nthis is not json\n{"speaker":"Clem Ukaoma"}\n`
    const { text, result } = filterCalibrationRows(raw, 'Clem Ukaoma')
    expect(result).toEqual({ removed: 1, retained: 2, unparsable: 1 })
    expect(text).toContain('this is not json')
  })

  it('tolerates a truncated final row and blank lines', () => {
    const raw = `{"speaker":"MU"}\n\n{"speaker":"Clem Uka`
    const { result } = filterCalibrationRows(raw, 'Clem Ukaoma')
    expect(result.removed).toBe(0)
    expect(result.unparsable).toBe(1)
  })

  it('returns empty text when every row goes', () => {
    const { text } = filterCalibrationRows(rows({ speaker: 'A' }, { speaker: 'A' }), 'A')
    expect(text).toBe('')
  })

  it('ignores a non-string speaker field', () => {
    const { result } = filterCalibrationRows(rows({ speaker: 42 }, { speaker: null }), 'A')
    expect(result.removed).toBe(0)
    expect(result.retained).toBe(2)
  })
})

describe('purging the log on disk', () => {
  it('rewrites atomically and leaves no temp file', () => {
    writeFileSync(logPath, rows({ speaker: 'Clem Ukaoma' }, { speaker: 'MU' }))
    const result = purgeSpeakerCalibrationRows(logPath, 'Clem Ukaoma')
    expect(result.removed).toBe(1)
    expect(readFileSync(logPath, 'utf-8')).toBe(rows({ speaker: 'MU' }))
    expect(require('node:fs').readdirSync(dir).filter((f: string) => f.includes('.tmp'))).toEqual([])
  })

  it('dryRun counts without touching the file', () => {
    const original = rows({ speaker: 'Clem Ukaoma' }, { speaker: 'MU' })
    writeFileSync(logPath, original)
    expect(purgeSpeakerCalibrationRows(logPath, 'Clem Ukaoma', { dryRun: true }).removed).toBe(1)
    expect(readFileSync(logPath, 'utf-8')).toBe(original)
  })

  it('does not rewrite when nothing matched', () => {
    writeFileSync(logPath, rows({ speaker: 'MU' }))
    const before = readFileSync(logPath, 'utf-8')
    expect(purgeSpeakerCalibrationRows(logPath, 'Nobody').removed).toBe(0)
    expect(readFileSync(logPath, 'utf-8')).toBe(before)
  })

  it('is a no-op on a missing log', () => {
    expect(purgeSpeakerCalibrationRows(logPath, 'Anyone')).toEqual({ removed: 0, retained: 0, unparsable: 0 })
    expect(existsSync(logPath)).toBe(false)
  })
})
