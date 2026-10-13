import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ run: vi.fn(), fetch: vi.fn() }))
vi.mock('./meeting-ask-runner.js', async (actual) => ({ ...(await actual<typeof import('./meeting-ask-runner.js')>()), runMeetingAskModel: mocks.run }))
vi.mock('./meeting-web-page.js', async (actual) => ({ ...(await actual<typeof import('./meeting-web-page.js')>()), fetchPublicArticle: mocks.fetch }))
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }))
const { searchMeetingWeb, prioritizeWebPages, UNREADABLE_RESULT_HOSTS, userWebQuery } = await import('./meeting-ask-web.js')
const { articleText } = await import('./meeting-web-page.js')
const { defaultOwnerArea } = await import('./meeting-fact-check.js')
const { getOwnerHomeArea, clearProfileCache } = await import('./profile.js')

const hits = (urls: string[]) => ({ results: ['Summary of the search.', { content: urls.map((url, i) => ({ title: `Result ${i}`, url })) }] })
function fakeSearch(urls: string[], seen: { stdin?: any }) {
  mocks.run.mockImplementation(async (_m: unknown, _p: string, _s: string, _signal: unknown, adapter: { workspace: string; stdin: string }) => {
    seen.stdin = JSON.parse(adapter.stdin)
    writeFileSync(join(adapter.workspace, 'events.jsonl'), JSON.stringify({ tool: 'WebSearch', allowed: true, query: seen.stdin.query }) + '\n')
    writeFileSync(join(adapter.workspace, 'result.json'), JSON.stringify(hits(urls)))
    return { text: '{"done":true}' }
  })
}
beforeEach(() => { mocks.run.mockReset(); mocks.fetch.mockReset() })

describe('6.71.13 public page reading', () => {
  it('asks search to skip hosts the reader cannot open', async () => {
    const seen: { stdin?: any } = {}
    fakeSearch(['https://a.example.org/1', 'https://b.example.org/2'], seen)
    mocks.fetch.mockResolvedValue(null)
    await searchMeetingWeb('elephant weight car', AbortSignal.timeout(5000))
    expect(seen.stdin.blockedDomains).toEqual(UNREADABLE_RESULT_HOSTS)
    expect(seen.stdin.blockedDomains).toContain('rome2rio.com')
    expect(seen.stdin.query).toBe('elephant weight car')
  })
  it('tries four candidates and keeps two reads, so blocked pages no longer leave nothing read', async () => {
    fakeSearch(['https://a.example.org/1', 'https://b.example.org/2', 'https://c.example.org/3', 'https://d.example.org/4', 'https://e.example.org/5'], {})
    mocks.fetch.mockImplementation(async (url: string) => /\/[34]$/.test(url) ? { url, text: 'Readable text about elephant weight. '.repeat(10) } : null)
    const out = await searchMeetingWeb('elephant weight car', AbortSignal.timeout(5000))
    expect(mocks.fetch).toHaveBeenCalledTimes(4)
    expect(out.sources.filter(s => s.text.startsWith('Retrieved page excerpt')).map(s => s.url)).toEqual(['https://c.example.org/3', 'https://d.example.org/4'])
    expect(out.notices[0]).toContain('2 result pages read')
    // The fifth result is never fetched; the focus words reach the reader.
    expect(mocks.fetch.mock.calls.map(c => c[0])).not.toContain('https://e.example.org/5')
    expect(mocks.fetch.mock.calls[0][3]).toEqual(['elephant', 'weight', 'car'])
  })
  it('stops the search model as soon as its result is on disk', async () => {
    const { AskProcessError } = await import('./meeting-ask-runner.js')
    let stopped = false
    mocks.run.mockImplementation((_m: unknown, _p: string, _s: string, signal: AbortSignal, adapter: { workspace: string; stdin: string }) => new Promise((_resolve, reject) => {
      const q = JSON.parse(adapter.stdin).query
      writeFileSync(join(adapter.workspace, 'events.jsonl'), JSON.stringify({ tool: 'WebSearch', allowed: true, query: q }) + '\n')
      writeFileSync(join(adapter.workspace, 'result.json'), JSON.stringify(hits(['https://a.example.org/1'])))
      signal.addEventListener('abort', () => { stopped = true; reject(new AskProcessError('cancelled')) })
    }))
    mocks.fetch.mockImplementation(async (url: string) => ({ url, text: 'Readable text about elephant weight. '.repeat(10) }))
    const out = await Promise.race([searchMeetingWeb('elephant weight car', AbortSignal.timeout(5000)), new Promise(r => setTimeout(() => r('hung'), 2000))])
    expect(out).not.toBe('hung'); expect(stopped).toBe(true)
    expect((out as any).sources.some((s: any) => s.text.startsWith('Retrieved page excerpt'))).toBe(true)
    // A caller's own cancellation still cancels.
    const cancelled = new AbortController(); cancelled.abort()
    mocks.run.mockRejectedValue(new AskProcessError('cancelled'))
    await expect(searchMeetingWeb('elephant weight car', cancelled.signal)).rejects.toThrow()
  })
  it('keeps at most two reads when more candidates answer', async () => {
    fakeSearch(['https://a.example.org/1', 'https://b.example.org/2', 'https://c.example.org/3', 'https://d.example.org/4'], {})
    mocks.fetch.mockImplementation(async (url: string) => ({ url, text: 'Readable text about elephant weight. '.repeat(10) }))
    const out = await searchMeetingWeb('elephant weight car', AbortSignal.timeout(5000))
    expect(out.sources.filter(s => s.text.startsWith('Retrieved page excerpt'))).toHaveLength(2)
  })
  it('stops waiting once two pages have read', async () => {
    fakeSearch(['https://a.example.org/1', 'https://b.example.org/2', 'https://c.example.org/3'], {})
    mocks.fetch.mockImplementation((url: string) => url.endsWith('/3') ? new Promise(() => {}) : Promise.resolve({ url, text: 'Readable text about elephant weight. '.repeat(10) }))
    const out = await Promise.race([searchMeetingWeb('elephant weight car', AbortSignal.timeout(5000)), new Promise(r => setTimeout(() => r('hung'), 1000))])
    expect(out).not.toBe('hung')
    expect((out as any).sources.filter((s: any) => s.text.startsWith('Retrieved page excerpt'))).toHaveLength(2)
  })
  it('reads a result that names more query words first among equally preferred hosts', () => {
    const s = (id: string, title: string) => ({ id, kind: 'web' as const, title, text: 'Search result title and URL only; page not fetched.', url: `https://${id}.example.net/` })
    expect(prioritizeWebPages([s('w1', 'Cheap fares'), s('w2', 'Austin to Kansas City flight time and driving time')], 'austin kansas city flight time driving').map(x => x.id)).toEqual(['w2', 'w1'])
    expect(prioritizeWebPages([s('w1', 'Same words'), s('w2', 'Same words')], 'same words').map(x => x.id)).toEqual(['w1', 'w2'])
  })
  it('extracts the longest article, falls back to the body, and keeps the window that names the claim', () => {
    expect(articleText('<article>tiny card</article><main>' + 'Elephants weigh about six tonnes. '.repeat(20) + '</main>')).toContain('Elephants weigh about six tonnes.')
    expect(articleText('<article>card</article><div>' + 'Body text about heartbeats over a lifetime. '.repeat(20) + '</div>')).toContain('heartbeats over a lifetime')
    const long = '<main>' + 'Filler sentence here. '.repeat(600) + 'The drive from Austin to Kansas City is about 730 miles. ' + 'More filler words. '.repeat(600) + '</main>'
    expect(articleText(long)).not.toContain('730 miles')
    expect(articleText(long, ['austin', 'kansas', 'miles'])).toContain('730 miles')
    expect(articleText(long, ['austin']).length).toBe(6000)
  })
  it('never treats request words as the search subject', () => {
    expect(userWebQuery("I'm asking you to fact check the claim")).toBeNull()
    expect(userWebQuery('Run it omg')).toBeNull()
    expect(userWebQuery('Search the web for Shopify pricing')).toBe('Shopify pricing')
  })
})

describe('owner area', () => {
  it('reads a city label from the profile, never an address, and falls back to the phone weather area', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owner-area-'))
    const previous = process.env.COS_PROFILE_PATH
    try {
      process.env.COS_PROFILE_PATH = join(dir, 'profile.json')
      writeFileSync(process.env.COS_PROFILE_PATH, JSON.stringify({ home_city: 'Austin, TX' })); clearProfileCache()
      expect(getOwnerHomeArea()).toBe('Austin, TX')
      writeFileSync(process.env.COS_PROFILE_PATH, JSON.stringify({ home_city: '1200 Main St, Austin' })); clearProfileCache()
      expect(getOwnerHomeArea()).toBeNull()
      const weather = join(dir, 'welcome-weather.json')
      writeFileSync(weather, JSON.stringify({ lat: 30.1, lon: -97.1, city: 'Cedar Park, TX' }))
      expect(defaultOwnerArea(() => 'Austin, TX', weather)).toEqual({ text: 'Austin, TX', source: 'profile' })
      expect(defaultOwnerArea(() => null, weather)).toEqual({ text: 'Cedar Park, TX', source: 'phone_area' })
      writeFileSync(weather, JSON.stringify({ city: '30.1, -97.1' }))
      expect(defaultOwnerArea(() => null, weather)).toBeNull()
      expect(defaultOwnerArea(() => null, join(dir, 'missing.json'))).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.COS_PROFILE_PATH; else process.env.COS_PROFILE_PATH = previous
      clearProfileCache(); rmSync(dir, { recursive: true, force: true })
    }
  })
})
