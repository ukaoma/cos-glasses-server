// The daily web ledger is incremented where each lookup really happens: searchMeetingWeb for a search and the pages it reads,
// the fact check's gate for a refused claim. Real searchMeetingWeb, a fake search model, a fake page reader, a scratch ledger.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ run: vi.fn(), fetch: vi.fn() }))
vi.mock('./meeting-ask-runner.js', async (actual) => ({ ...(await actual<typeof import('./meeting-ask-runner.js')>()), runMeetingAskModel: mocks.run }))
vi.mock('./meeting-web-page.js', async (actual) => ({ ...(await actual<typeof import('./meeting-web-page.js')>()), fetchPublicArticle: mocks.fetch }))
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }))
const { searchMeetingWeb } = await import('./meeting-ask-web.js')
const { originQuery } = await import('./meeting-fact-check.js')
const { WebLookupLedger, setWebLedgerForTests } = await import('./web-lookup-ledger.js')

const dirs: string[] = []
let ledger: InstanceType<typeof WebLookupLedger>
beforeEach(() => {
  mocks.run.mockReset(); mocks.fetch.mockReset()
  const dir = mkdtempSync(join(tmpdir(), 'web-ledger-sites-')); dirs.push(dir)
  ledger = new WebLookupLedger(join(dir, 'ledger.json'), () => Date.parse('2026-11-02T18:00:00Z'))
  setWebLedgerForTests(ledger)
})
afterEach(() => { setWebLedgerForTests(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fakeSearch(urls: string[]) {
  mocks.run.mockImplementation(async (_m: unknown, _p: string, _s: string, _signal: unknown, adapter: { workspace: string; stdin: string }) => {
    const query = JSON.parse(adapter.stdin).query
    writeFileSync(join(adapter.workspace, 'events.jsonl'), JSON.stringify({ tool: 'WebSearch', allowed: true, query }) + '\n')
    writeFileSync(join(adapter.workspace, 'result.json'), JSON.stringify({ results: ['Summary.', { content: urls.map((url, i) => ({ title: `Result ${i}`, url })) }] }))
    return { text: '{"done":true}' }
  })
}
const page = (url: string) => ({ url, text: 'Readable text about elephant weight. '.repeat(10) })
const sig = () => AbortSignal.timeout(5000)

describe('searchMeetingWeb counts the search where it is dispatched, and the pages it reads', () => {
  it('a plain call is the meeting assistant: one search, and the two pages that read', async () => {
    fakeSearch(['https://a.example.org/1', 'https://b.example.org/2', 'https://c.example.org/3'])
    mocks.fetch.mockImplementation(async (url: string) => page(url))
    await searchMeetingWeb('elephant weight car', sig())
    expect(ledger.today()).toMatchObject({ ask: { searches: 1, pagesRead: 2 }, cues: { searches: 0, pagesRead: 0 }, factCheck: { searches: 0, pagesRead: 0 } })
  })
  it('the general cues\' audit caller counts as cues', async () => {
    fakeSearch(['https://a.example.org/1'])
    mocks.fetch.mockImplementation(async (url: string) => page(url))
    await searchMeetingWeb('elephant weight car', sig(), { auditCaller: 'live_cues_general' })
    expect(ledger.today()).toMatchObject({ cues: { searches: 1, pagesRead: 1 }, ask: { searches: 0, pagesRead: 0 } })
  })
  it('an explicit feature wins, so the fact check counts as the fact check', async () => {
    fakeSearch(['https://a.example.org/1'])
    mocks.fetch.mockImplementation(async (url: string) => page(url))
    await searchMeetingWeb('elephant weight car', sig(), { feature: 'factCheck' })
    expect(ledger.today()).toMatchObject({ factCheck: { searches: 1, pagesRead: 1 }, ask: { searches: 0, pagesRead: 0 }, cues: { searches: 0 } })
  })
  it('a search whose pages could not be read is still a search, with zero pages read', async () => {
    fakeSearch(['https://a.example.org/1', 'https://b.example.org/2'])
    mocks.fetch.mockResolvedValue(null)
    await searchMeetingWeb('elephant weight car', sig())
    expect(ledger.today().ask).toEqual({ searches: 1, pagesRead: 0 })
  })
  it('a search that threw still ran, so it is counted', async () => {
    mocks.run.mockRejectedValue(new Error('provider down'))
    const out = await searchMeetingWeb('elephant weight car', sig())
    expect(out.sources).toEqual([])
    expect(ledger.today().ask.searches).toBe(1)
  })
  it('a query that carries a secret never reaches the search, so nothing is counted', async () => {
    const out = await searchMeetingWeb('elephant sk-abcdefghijklmnopqrstuvwxyz0123456789', sig())
    expect(out.notices[0]).toContain('secret')
    expect(mocks.run).not.toHaveBeenCalled()
    expect(ledger.today().ask.searches).toBe(0)
  })
})

describe('the fact check counts a claim its gate refuses', () => {
  it('a refused query is withheld under the gate reason; an admitted one counts nothing', () => {
    expect(originQuery('elephant weight', null)).toBe('elephant weight')
    expect(ledger.today().withheld.total).toBe(0)
    expect(originQuery('wife birthday party', null)).toBeUndefined()           // a personal category word
    expect(ledger.today().withheld).toEqual({ total: 1, byReason: { personal: 1 }, byFeature: { cues: 0, ask: 0, factCheck: 1 } })
  })
})
