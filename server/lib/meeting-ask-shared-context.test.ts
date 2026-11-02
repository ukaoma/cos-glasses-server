// 6.97.8: what Miles shares in a meeting question. A pasted public link is read as a page even when the question has no public-intent
// wording; the pasted text and the page become meeting files the live cues' files arm can use. All names and articles below are made up.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./meeting-web-page.js', async (actual) => ({ ...(await actual<typeof import('./meeting-web-page.js')>()), fetchPublicArticle: mocks.fetch }))
const { MeetingAskRuntime } = await import('./meeting-ask-runtime.js')
const { MeetingAskStore } = await import('./meeting-ask-store.js')
const W = await import('./meeting-ask-web.js')
const P = await import('./meeting-ask-pasted.js')
const { WebLookupLedger, setWebLedgerForTests } = await import('./web-lookup-ledger.js')
const { groundedCandidates } = await import('./live-cues-v2-grounded.js')

const ARTICLE = 'https://apnews.com/article/synthetic-harbor-dredging-vote-0a1b2c3d4e5f60718293a4b5c6d7e8f9'
const PAGE_TEXT = 'The harbor commission voted to approve the dredging contract for the northern channel. '.repeat(4) + 'Quartz Basin Marine won the bid.'
const page = (url: string, title = 'Harbor commission approves dredging') => ({ url, title, text: PAGE_TEXT })
const base = { requestId: 'request_12345678', sessionId: 'meeting_test', serverInstanceId: 'server-one', action: 'ask' as const, question: 'What was decided?', elapsedMs: 1000, model: { engine: 'claude' as const, model: 'sonnet' },
  turns: [{ id: 0, elapsedMs: 0, speaker: 'Person', text: 'We will review Friday.' }] }
const answer = (text: string) => JSON.stringify({ sections: [{ label: 'So what', text }], searchQuery: null })

const dirs: string[] = []
let seq = 0
function fixture(replies: string[] = [], overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-shared-')); dirs.push(dir)
  const store = new MeetingAskStore(dir)
  const run = vi.fn(async (_model: unknown, _prompt: string, _system?: string) => ({ text: replies.shift() ?? answer('Done [T1]'), model: 'claude-sonnet-5-5' }))
  const webSearch = vi.fn(async (_q: string, _signal?: unknown, _options?: unknown) => ({ sources: [], notices: [] }))
  const runtime = new MeetingAskRuntime({ reviewAnswers: false, finalized: () => ({ sources: [], notices: [] }), domains: () => [{ id: 'quilt', label: 'Quilt' }, { id: 'personal', label: 'Personal' }], store, identity: () => 'server-one',
    admissions: () => true, lease: () => ({ release: vi.fn(), id: 'lease', kind: 'meeting_ask' } as any), catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku', 'sonnet'] }],
    run, search: async () => ({ sources: [], notices: [] }), webSearch, webCapability: () => ({ available: true, engine: 'claude:haiku' }), ...overrides } as any)
  const ledger = new WebLookupLedger(join(dir, 'ledger.json'), () => Date.parse('2026-11-02T18:00:00Z'))
  setWebLedgerForTests(ledger)
  return { runtime, store, run, webSearch, ledger }
}
type F = ReturnType<typeof fixture>
async function ask(f: F, question: string, extra: Record<string, unknown> = {}) {
  const req = { ...base, requestId: `request_${String(++seq).padStart(8, '0')}`, question, ...extra }
  await f.runtime.submit(req)
  for (let i = 0; i < 400; i++) {
    const e = f.runtime.get(req.requestId)
    if (!['pending', 'running'].includes(e.status)) return e
    await new Promise(r => setTimeout(r, 2))
  }
  throw new Error('never terminal')
}
beforeEach(() => { mocks.fetch.mockReset(); mocks.fetch.mockImplementation(async (url: string) => page(url)) })
afterEach(() => { setWebLedgerForTests(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// What the gate reads. Pure.
describe('pastedPublicUrls: the links the user typed that may be read', () => {
  it('admits a public https link with no intent wording, and trims the punctuation around it', () => {
    expect(W.pastedPublicUrls(`This is the article we are discussing, by the way: ${ARTICLE}.`)).toEqual({ urls: [ARTICLE], refused: [] })
    expect(W.pastedPublicUrls(`see (${ARTICLE}), thanks`).urls).toEqual([ARTICLE])
    expect(W.pastedPublicUrls('read https://en.wikipedia.org/wiki/Harbor_(disambiguation) now').urls).toEqual(['https://en.wikipedia.org/wiki/Harbor_(disambiguation)'])
    expect(W.pastedPublicUrls('http://example.org/a and http://example.org/a').urls).toEqual(['http://example.org/a'])
  })
  it('refuses a private host, a loopback, a link-local address, a non-web scheme and an odd port, as not public', () => {
    for (const u of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'https://192.168.1.20/report', 'http://10.0.0.5/a', 'http://169.254.169.254/latest', 'http://[::1]/x', 'https://nas.local/files', 'https://example.com:8443/a', 'http://intranet.internal/wiki'])
      expect(W.pastedPublicUrls(`look at ${u}`), u).toEqual({ urls: [], refused: ['pasted_not_public'] })
    expect(W.pastedPublicUrls('open file:///etc/passwd and ftp://example.com/x')).toEqual({ urls: [], refused: [] })   // not web links at all: never even looked at
  })
  it('refuses a link with credentials, a key or token in it, or a query parameter named like a credential, as a secret', () => {
    for (const u of ['https://user:hunter2@example.com/a', 'https://example.com/a?token=abcdef123456', 'https://example.com/a?api_key=zzz999', 'https://example.com/a?X-Amz-Signature=abc123def456', 'https://example.com/a?sessionid=77bb',
      'https://example.com/sk-abcdefghijklmnopqrstuvwxyz0123456789/page', 'https://example.com/a?auth=1234abcd'])
      expect(W.pastedPublicUrls(`read ${u}`), u).toEqual({ urls: [], refused: ['pasted_secret'] })
  })
  it('keeps ordinary links that only look odd: tracking parameters, long hex ids, a parameter that merely contains letters', () => {
    for (const u of [ARTICLE, 'https://example.com/a?utm_source=x&utm_medium=y', 'https://example.com/a?monkey=1&author=jo&page=2'])
      expect(W.pastedPublicUrls(u).urls, u).toEqual([u])
  })
  it('looks at no more than two links: the third is ignored, even when an earlier one was refused', () => {
    expect(W.pastedPublicUrls('https://a.example.org/1 https://b.example.org/2 https://c.example.org/3')).toEqual({ urls: ['https://a.example.org/1', 'https://b.example.org/2'], refused: ['pasted_over_limit'] })
    expect(W.pastedPublicUrls('http://localhost/x https://a.example.org/1 https://c.example.org/3')).toEqual({ urls: ['https://a.example.org/1'], refused: ['pasted_not_public', 'pasted_over_limit'] })
  })
  it('reads the question text only: a link that is not in it is not here', () => {
    expect(W.pastedPublicUrls('What did we decide about the harbor?')).toEqual({ urls: [], refused: [] })
  })
})

describe('the old gate withheld Miles\'s 11:45 question shape; the new path admits it', () => {
  const question = `This is the article we are discussing by the way: ${ARTICLE}`
  it('replay: no public-intent wording, so a search is withheld as before, but the typed link is admitted', () => {
    expect(W.publicIntent(question)).toBe(false)
    expect(W.explicitWebRequest(question)).toBe(false)
    expect(W.publicSearchGate({ question, query: 'Harbor dredging vote' })).toMatchObject({ ok: false, reason: 'no_public_intent' })   // 6.97.7: the notice Miles saw
    expect(W.pastedPublicUrls(question)).toEqual({ urls: [ARTICLE], refused: [] })                                                       // 6.97.8: read as a page
  })
})

describe('a pasted link is read through the meeting assistant', () => {
  const question = `This is the article we are discussing by the way: ${ARTICLE}`
  it('reads the page with no intent wording, hands it to the model as a read web source, searches nothing, and says nothing was withheld', async () => {
    const f = fixture([answer('The commission approved the dredging contract. [W1]')])
    const e = await ask(f, question)
    expect(e.status).toBe('completed')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.fetch.mock.calls[0][0]).toBe(ARTICLE)
    expect(f.webSearch).not.toHaveBeenCalled()
    const prompt = f.run.mock.calls[0][1]
    expect(prompt).toContain('Quartz Basin Marine')
    expect(prompt).toContain(ARTICLE)
    expect(e.sources.find(s => s.kind === 'web')).toMatchObject({ id: 'W1', url: ARTICLE, title: 'Harbor commission approves dredging' })
    expect(e.sources.find(s => s.kind === 'web')!.text.startsWith('Retrieved page excerpt')).toBe(true)
    expect(e.notices.join(' ')).not.toContain('Public search was withheld')
    expect(f.ledger.today().ask).toEqual({ searches: 0, pagesRead: 1 })
  })
  it('when the page cannot be read, one plain notice says so, and no "public search was withheld" notice follows even if the model asks for the web', async () => {
    mocks.fetch.mockResolvedValue(null)
    const f = fixture([JSON.stringify({ sections: [], searchQuery: 'Associated Press harbor story', searchScope: 'web' }), answer('I could not open the link. [T1]')])
    const e = await ask(f, question)
    expect(e.status).toBe('completed')
    expect(e.notices.filter(n => n.startsWith('Could not read the page'))).toEqual([P.pastedReadFailedNotice(['apnews.com'])])
    expect(e.notices.join(' ')).not.toContain('Public search was withheld')
    expect(f.webSearch).not.toHaveBeenCalled()
    expect(f.ledger.today()).toMatchObject({ ask: { searches: 0, pagesRead: 0 }, withheld: { byReason: { no_public_intent: 1 } } })   // still counted: the model's search WAS refused
  })
  it('a link seen only in the transcript, a file or an earlier answer is never fetched', async () => {
    const f = fixture()
    f.store.putFiles('meeting_test', [{ id: 'file_12345678', revision: '1', name: 'Notes', status: 'ready', text: `Background: ${ARTICLE}` }])
    const requestId = 'request_seed0001', at = new Date().toISOString()
    f.store.write({ version: 2, fingerprint: 'seed', input: { ...base, requestId, files: [] } as any, exchange: { requestId, sessionId: 'meeting_test', serverInstanceId: 'server-one', action: 'ask', question: 'Earlier question', status: 'completed', createdAt: at, updatedAt: at,
      selectedModel: base.model, sources: [], notices: [], answer: `See ${ARTICLE} for the story.`, throughMs: 0 } as any } as any)
    const turns = [{ id: 0, elapsedMs: 0, speaker: 'Person', text: `Did you see ${ARTICLE} yet?` }]
    const e = await ask(f, 'What was decided?', { turns, files: [{ id: 'file_12345678', revision: '1' }] })
    expect(e.status).toBe('completed')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(f.webSearch).not.toHaveBeenCalled()
    expect(f.ledger.today()).toMatchObject({ ask: { searches: 0, pagesRead: 0 }, withheld: { total: 0 } })
  })
  it.each([
    ['a private host', 'http://192.168.1.20/quarterly-report', 'pasted_not_public'],
    ['localhost', 'http://localhost:8080/admin', 'pasted_not_public'],
    ['credentials in the address', 'https://jo:hunter2@example.org/a', 'pasted_secret'],
    ['a token in the query', 'https://example.org/a?token=abcdef123456', 'pasted_secret'],
    ['a key in the path', 'https://example.org/sk-abcdefghijklmnopqrstuvwxyz0123456789', 'pasted_secret'],
  ])('refuses %s: never fetched, one plain notice, counted as withheld', async (_name, url, reason) => {
    const f = fixture()
    const e = await ask(f, `Take a look at this: ${url}`)
    expect(e.status).toBe('completed')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(e.notices).toContain(P.PASTED_REFUSED_NOTICE)
    expect(f.ledger.today().withheld.byReason).toEqual({ [reason]: 1 })
  })
  it('reads at most two links: the third is not fetched and the notice says only two are read', async () => {
    const f = fixture()
    const e = await ask(f, 'Here are three: https://a.example.org/one https://b.example.org/two https://c.example.org/three')
    expect(mocks.fetch.mock.calls.map(c => c[0]).sort()).toEqual(['https://a.example.org/one', 'https://b.example.org/two'])
    expect(e.notices).toContain(P.PASTED_OVER_LIMIT_NOTICE)
    expect(f.ledger.today()).toMatchObject({ ask: { pagesRead: 2 }, withheld: { byReason: { pasted_over_limit: 1 } } })
  })
  it('a question that excludes public information reads no link', async () => {
    const f = fixture()
    await ask(f, `Without public information, what does ${ARTICLE} have to do with us?`)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('only a typed question reads links: a preset never does', async () => {
    const f = fixture([JSON.stringify({ sections: [{ label: 'So what', text: 'Recap. [T1]' }], searchQuery: null })])
    await ask(f, `Catch me up ${ARTICLE}`, { action: 'catch_up' })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('re-asking about the article reuses the page read: with the link again, and by pointing at "the article" without it', async () => {
    const f = fixture([answer('Approved. [W1]'), answer('Again. [W1]'), answer('From the page. [W1]')])
    await ask(f, question)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    const again = await ask(f, `Back to ${ARTICLE} for a second`)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(again.notices.join(' ')).toContain('Reused the page')
    const pointing = await ask(f, 'What does the article say about the winning bidder?')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(f.run.mock.calls[2][1]).toContain('Quartz Basin Marine')
    expect(pointing.sources.find(s => s.kind === 'web')).toMatchObject({ url: ARTICLE })
    expect(f.ledger.today().ask.pagesRead).toBe(1)                     // reuse is not a new read
  })
  it('a reuse does not reach past the user\'s own typed links, or past 15 minutes', () => {
    const at = Date.parse('2026-11-02T18:00:00Z')
    const source = { id: 'W1', kind: 'web' as const, title: 't', url: ARTICLE, text: 'Retrieved page excerpt (may be partial): ' + PAGE_TEXT, retrievedAt: new Date(at).toISOString() }
    const row = (over: Record<string, unknown>) => ({ requestId: 'r', sessionId: 'meeting_test', serverInstanceId: 'server-one', action: 'ask', status: 'completed', createdAt: new Date(at).toISOString(), question: `read ${ARTICLE}`, sources: [source], ...over }) as any
    expect(W.recentPastedPagesFromUserLinks([row({})], 'meeting_test', 'server-one', at + 60_000)).toHaveLength(1)
    expect(W.recentPastedPagesFromUserLinks([row({})], 'meeting_test', 'server-one', at + 16 * 60_000)).toHaveLength(0)       // read 16 minutes ago
    expect(W.recentPastedPagesFromUserLinks([row({ question: 'What was decided?' })], 'meeting_test', 'server-one', at + 60_000)).toHaveLength(0)   // the link was not the user's
    expect(W.recentPastedPagesFromUserLinks([row({})], 'other_meeting', 'server-one', at + 60_000)).toHaveLength(0)
    expect(W.pointsAtEarlierLink('What does the article say?')).toBe(true)
    expect(W.pointsAtEarlierLink(`What does the article at ${ARTICLE} say?`)).toBe(false)
    expect(W.pointsAtEarlierLink('What was decided?')).toBe(false)
  })
})

describe('what Miles shares becomes meeting context the live cues can use', () => {
  const LONG = 'The county approved the orbital greenhouse subsidy for the riverfront district. Supporters said the subsidy would bring greenhouse jobs, while opponents worried about water rights along the riverfront. '.repeat(3)
  const cueFiles = (f: F, sessionId = 'meeting_test') => f.store.files(sessionId)
  it('pasted text over 400 characters becomes a ready file named "Pasted text HH:MM", and the cues\' files arm can return a passage of it', async () => {
    const f = fixture()
    expect(LONG.length).toBeGreaterThan(400)
    const e = await ask(f, `Here is the piece we are reading:\n\n${LONG}`)
    const files = cueFiles(f)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ status: 'ready', name: expect.stringMatching(/^Pasted text \d{2}:\d{2}$/) })
    expect(files[0].text).toContain('orbital greenhouse subsidy')
    expect(e.notices.join(' ')).toContain(`Kept for live cues: "${files[0].name}"`)
    const found = groundedCandidates({ cueMemory: [], notes: [], files, transcript: new Set(), window: 'Now the room is on the orbital greenhouse subsidy and the riverfront district water rights.', selfIds: new Set(), meetingDomain: null, today: '2026-11-02' })
    expect(found.candidates).toHaveLength(1)
    expect(found.candidates[0]).toMatchObject({ id: 'F1', arm: 'files', kind: 'file', fileId: files[0].id, title: files[0].name })
  })
  it('text of 400 characters or fewer, links excluded, is not kept; a long link does not make a short question long', async () => {
    const f = fixture()
    await ask(f, 'x'.repeat(380) + ' ' + ARTICLE + '/' + 'y'.repeat(300))
    expect(cueFiles(f).filter(x => x.id.startsWith('paste_'))).toHaveLength(0)
    expect(P.pastedTextFile('z'.repeat(P.PASTED_TEXT_MIN_CHARS), 0)).toBeNull()
    expect(P.pastedTextFile('z'.repeat(P.PASTED_TEXT_MIN_CHARS + 1), 0)).not.toBeNull()
  })
  it('a key in pasted text is already redacted before it is kept, and a file that still carries one is refused with a notice', async () => {
    const f = fixture()
    const e = await ask(f, `${LONG} and my key is sk-abcdefghijklmnopqrstuvwxyz0123456789`)
    expect(e.status).toBe('completed')
    const kept = cueFiles(f).filter(x => x.id.startsWith('paste_'))
    expect(kept).toHaveLength(1)
    expect(kept[0].text).toContain('sk-REDACTED')
    expect(kept[0].text).not.toContain('abcdefghijklmnopqrstuvwxyz')
    // The store-side guard, for text that was not redacted upstream.
    const raw = { id: 'paste_0123456789abcdef', revision: 'r1', name: 'Pasted text 11:49', status: 'ready' as const, text: `${LONG} sk-abcdefghijklmnopqrstuvwxyz0123456789` }
    const result = P.keepPastedContext(f.store, 'meeting_test', [raw])
    expect(result.added).toEqual([])
    expect(result.notices).toEqual(['"Pasted text 11:49" was not added to live cue context because it contains a key or token.'])
    expect(cueFiles(f).some(x => x.id === raw.id)).toBe(false)
  })
  it('a page that was read becomes a file named by its title, holding the address; asking again keeps one file', async () => {
    const f = fixture([answer('Approved. [W1]'), answer('Still. [W1]')])
    await ask(f, `This is the article: ${ARTICLE}`)
    const files = cueFiles(f)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ name: 'Harbor commission approves dredging', status: 'ready' })
    expect(files[0].text.startsWith(ARTICLE)).toBe(true)
    expect(files[0].text).toContain('Quartz Basin Marine')
    const again = await ask(f, `This is the article: ${ARTICLE}`)
    expect(cueFiles(f)).toHaveLength(1)
    expect(again.notices.join(' ')).not.toContain('Kept for live cues')      // nothing new was kept
  })
  it('belongs to its own meeting: another meeting\'s cues never see it', async () => {
    const f = fixture()
    await ask(f, `${LONG}`, { sessionId: 'meeting_personal_one' })
    expect(cueFiles(f, 'meeting_personal_one')).toHaveLength(1)
    expect(cueFiles(f, 'meeting_test')).toHaveLength(0)
  })
  it(`keeps at most ${P.PASTED_FILES_PER_MEETING} pasted items per meeting and says so for the next`, async () => {
    const f = fixture()
    for (let i = 0; i < P.PASTED_FILES_PER_MEETING; i++) await ask(f, `${LONG} item${i}`)
    expect(cueFiles(f).filter(x => x.id.startsWith('paste_'))).toHaveLength(P.PASTED_FILES_PER_MEETING)
    const e = await ask(f, `${LONG} one too many`)
    expect(cueFiles(f).filter(x => x.id.startsWith('paste_'))).toHaveLength(P.PASTED_FILES_PER_MEETING)
    expect(e.notices.join(' ')).toContain(`already holds ${P.PASTED_FILES_PER_MEETING} pasted items`)
    expect(e.status).toBe('completed')
  })
  it('a full file space never fails the answer: it becomes a notice', async () => {
    const f = fixture()
    f.store.putFiles('meeting_test', Array.from({ length: 5 }, (_, i) => ({ id: `big_file_${i}0000`, revision: '1', name: `Big ${i}`, status: 'ready' as const, text: 'q'.repeat(99_900) })))
    const e = await ask(f, LONG)
    expect(e.status).toBe('completed')
    expect(e.notices.join(' ')).toContain('could not be added to live cue context: the meeting file space is full')
  })
  it('the same pasted text twice is one file, and the clock in the name is the local time', () => {
    const a = P.pastedTextFile(LONG, Date.parse('2026-11-02T17:49:00Z')), b = P.pastedTextFile(LONG, Date.parse('2026-11-02T19:00:00Z'))
    expect(a!.id).toBe(b!.id)
    expect(a!.name).toMatch(/^Pasted text \d{2}:\d{2}$/)
  })
})

describe('the meeting assistant counts its own lookups where they are decided', () => {
  const webAsk = (searchQuery: string) => JSON.stringify({ sections: [], searchQuery, searchScope: 'web' })
  it('an admitted search is dispatched as the meeting assistant\'s, so searchMeetingWeb counts it under ask', async () => {
    const f = fixture([webAsk('Shopify CEO'), answer('Done. [T1]')])
    await ask(f, 'Who is the CEO of Shopify?')
    expect(f.webSearch).toHaveBeenCalledTimes(1)
    expect(f.webSearch.mock.calls[0][2]).toEqual({ feature: 'ask' })
    expect(f.ledger.today().withheld.total).toBe(0)
  })
  it('a search the model proposes and the gate refuses is counted as withheld, with the gate\'s reason', async () => {
    const f = fixture([webAsk('Quartz plan'), answer('Local only. [T1]')])
    const e = await ask(f, 'Remind me what the Quartz plan involved')
    expect(f.webSearch).not.toHaveBeenCalled()
    expect(e.notices.join(' ')).toContain('Public search was withheld')
    expect(f.ledger.today().withheld).toEqual({ total: 1, byReason: { no_public_intent: 1 }, byFeature: { cues: 0, ask: 1, factCheck: 0 } })
  })
  it('an explicit request that is refused up front and again when the model proposes a search is one withheld lookup, not two', async () => {
    const f = fixture([webAsk('wife birthday gift'), answer('No. [T1]')])
    await ask(f, 'Search the web for my wife birthday gift ideas')
    expect(f.webSearch).not.toHaveBeenCalled()
    expect(f.ledger.today().withheld).toMatchObject({ total: 1, byReason: { personal: 1 } })
  })
  it('a pasted link beside a question the gate would refuse still counts that refusal, but the user sees only the link notice', async () => {
    mocks.fetch.mockResolvedValue(null)
    const f = fixture([webAsk('Harbor story'), answer('Could not open it. [T1]')])
    const e = await ask(f, `Here is the story ${ARTICLE} and nothing else.`)
    expect(e.notices.join(' ')).not.toContain('Public search was withheld')
    expect(e.notices.some(n => n.startsWith('Could not read the page'))).toBe(true)
    expect(f.ledger.today().withheld.byReason).toEqual({ no_public_intent: 1 })
  })
})
