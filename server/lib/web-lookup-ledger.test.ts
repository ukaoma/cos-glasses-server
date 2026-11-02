import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebLookupLedger, WEB_LEDGER_MAX_REASONS } from './web-lookup-ledger.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function setup(startIso = '2026-11-02T15:00:00.000Z') {
  const dir = mkdtempSync(join(tmpdir(), 'web-ledger-')); dirs.push(dir)
  const file = join(dir, 'ledger.json')
  const clock = { at: Date.parse(startIso) }
  return { dir, file, clock, ledger: new WebLookupLedger(file, () => clock.at) }
}
const ZERO = { searches: 0, pagesRead: 0 }

describe('web lookup ledger', () => {
  it('counts searches, pages read and withheld lookups by feature, and totals the withheld by reason across features', () => {
    const { ledger } = setup()
    ledger.search('cues'); ledger.search('ask'); ledger.search('ask'); ledger.search('factCheck')
    ledger.pagesRead('ask', 2); ledger.pagesRead('factCheck'); ledger.pagesRead('cues', 0)
    ledger.withheld('ask', 'no_public_intent'); ledger.withheld('ask', 'no_public_intent'); ledger.withheld('cues', 'personal'); ledger.withheld('factCheck', 'no_public_intent')
    expect(ledger.today()).toEqual({
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), readable: true,
      cues: { searches: 1, pagesRead: 0 }, ask: { searches: 2, pagesRead: 2 }, factCheck: { searches: 1, pagesRead: 1 },
      withheld: { total: 4, byReason: { no_public_intent: 3, personal: 1 }, byFeature: { cues: 1, ask: 2, factCheck: 1 } },
    })
  })
  it('a fresh data dir is readable and all zero', () => {
    expect(setup().ledger.today()).toMatchObject({ readable: true, cues: ZERO, ask: ZERO, factCheck: ZERO, withheld: { total: 0, byReason: {} } })
  })
  it('persists across instances (the server restarting keeps the day)', () => {
    const a = setup()
    a.ledger.search('ask')
    expect(new WebLookupLedger(a.file, () => a.clock.at).today().ask.searches).toBe(1)
  })
  it('rolls over at the local midnight, not the UTC one: the state names its own zone', () => {
    const { file, clock, ledger } = setup('2026-11-02T01:00:00.000Z')   // 19:00 on Nov 1 in Chicago
    writeFileSync(file, JSON.stringify({ v: 1, zone: 'America/Chicago', day: '2026-11-01', features: { cues: { searches: 3, pagesRead: 0, withheld: {} }, ask: { searches: 5, pagesRead: 1, withheld: { personal: 2 } }, factCheck: { searches: 0, pagesRead: 0, withheld: {} } } }))
    expect(ledger.today()).toMatchObject({ day: '2026-11-01', ask: { searches: 5, pagesRead: 1 }, withheld: { total: 2 } })   // 02:00 UTC is still Nov 1 in the file's zone
    clock.at = Date.parse('2026-11-02T06:30:00.000Z')                  // 00:30 Nov 2 in Chicago
    expect(ledger.today()).toMatchObject({ day: '2026-11-02', readable: true, cues: ZERO, ask: ZERO, withheld: { total: 0, byReason: {} } })
    ledger.search('ask')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ day: '2026-11-02', features: { ask: { searches: 1, pagesRead: 0, withheld: {} } } })
  })
  it('a day in the future (a clock set back) is not trusted: nothing is counted into it, the view says unreadable, and the file is left alone', () => {
    const { file, ledger } = setup()
    const future = JSON.stringify({ v: 1, zone: 'UTC', day: '2099-01-01', features: { cues: { searches: 9, pagesRead: 0, withheld: {} }, ask: { searches: 9, pagesRead: 0, withheld: {} }, factCheck: { searches: 9, pagesRead: 0, withheld: {} } } })
    writeFileSync(file, future)
    expect(ledger.today().readable).toBe(false)
    expect(ledger.search('ask')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(future)
    expect(readdirSync(join(file, '..'))).toEqual(['ledger.json'])
  })
  it.each([
    ['unparseable', 'not json {'],
    ['wrong version', JSON.stringify({ v: 2 })],
    ['a missing feature', JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-02', features: { cues: { searches: 0, pagesRead: 0, withheld: {} } } })],
    ['a negative count', JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-02', features: { cues: { searches: -1, pagesRead: 0, withheld: {} }, ask: { searches: 0, pagesRead: 0, withheld: {} }, factCheck: { searches: 0, pagesRead: 0, withheld: {} } } })],
    ['a fractional count', JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-02', features: { cues: { searches: 0.5, pagesRead: 0, withheld: {} }, ask: { searches: 0, pagesRead: 0, withheld: {} }, factCheck: { searches: 0, pagesRead: 0, withheld: {} } } })],
    ['a bad zone', JSON.stringify({ v: 1, zone: 'Mars/Olympus', day: '2026-11-02', features: {} })],
    ['a bad reason key', JSON.stringify({ v: 1, zone: 'UTC', day: '2026-11-02', features: { cues: { searches: 0, pagesRead: 0, withheld: { 'Bad Key': 1 } }, ask: { searches: 0, pagesRead: 0, withheld: {} }, factCheck: { searches: 0, pagesRead: 0, withheld: {} } } })],
  ])('an unreadable file (%s) fails safe: the view says so, recording never throws, and the bad file is moved aside so counting resumes', (_name, content) => {
    const { dir, file, ledger } = setup()
    writeFileSync(file, content)
    expect(ledger.today()).toMatchObject({ readable: false, cues: ZERO, ask: ZERO, factCheck: ZERO, withheld: { total: 0 } })   // zeros that say they are not today's numbers
    expect(() => ledger.search('ask')).not.toThrow()
    expect(readFileSync(join(dir, 'ledger.json.unreadable'), 'utf8')).toBe(content)
    expect(ledger.today()).toMatchObject({ readable: true, ask: { searches: 1, pagesRead: 0 } })
  })
  it('a ledger that cannot be written never throws and never blocks the caller', () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'blocker'), 'a file where a directory would need to be')
    const broken = new WebLookupLedger(join(dir, 'blocker', 'ledger.json'), () => Date.now())
    expect(broken.search('ask')).toBe(false)
    expect(broken.withheld('cues', 'personal')).toBe(false)
    expect(broken.pagesRead('ask', 3)).toBe(false)
    expect(broken.today().readable).toBe(false)
  })
  it('recording survives a failure anywhere inside it (a clock that throws): it returns false and the lookup goes on', () => {
    const { file } = setup()
    const broken = new WebLookupLedger(file, () => { throw new Error('clock unavailable') })
    expect(() => broken.search('ask')).not.toThrow()
    expect(broken.search('ask')).toBe(false)
    expect(broken.withheld('cues', 'personal')).toBe(false)
  })
  it('a reason that is not a code is counted as other, and the distinct reasons per feature are capped', () => {
    const { ledger } = setup()
    ledger.withheld('ask', 'This Has Spaces and the question text itself'); ledger.withheld('ask', '')
    expect(ledger.today().withheld.byReason).toEqual({ other: 2 })
    for (let i = 0; i < WEB_LEDGER_MAX_REASONS + 5; i++) ledger.withheld('cues', `reason_${i}`)
    const reasons = Object.keys(ledger.today().withheld.byReason)
    expect(reasons.length).toBeLessThanOrEqual(WEB_LEDGER_MAX_REASONS + 1)      // the cap, plus 'other'
    expect(ledger.today().withheld.byFeature.cues).toBe(WEB_LEDGER_MAX_REASONS + 5)
    expect(ledger.today().withheld.byReason.other).toBe(5 + 2)
  })
  it('writes private and atomic: mode 0600, no temp file left behind, creates its own folder', () => {
    const { dir } = setup()
    const nested = join(dir, 'a', 'b', 'ledger.json')
    const ledger = new WebLookupLedger(nested, () => Date.now())
    ledger.search('ask')
    expect(statSync(nested).mode & 0o777).toBe(0o600)
    expect(existsSync(`${nested}.tmp`)).toBe(false)
  })
})
