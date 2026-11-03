// 6.97.8: a public factual comparison ("is private aviation safer than commercial?") end to end through the real runtime and the real
// searchMeetingWeb, with a fake search model, a fake page reader and a fake answer model. The meeting is synthesized.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ search: vi.fn(), fetch: vi.fn() }))
vi.mock('./meeting-ask-runner.js', async (actual) => ({ ...(await actual<typeof import('./meeting-ask-runner.js')>()), runMeetingAskModel: mocks.search }))
vi.mock('./meeting-web-page.js', async (actual) => ({ ...(await actual<typeof import('./meeting-web-page.js')>()), fetchPublicArticle: mocks.fetch }))
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }))
const { MeetingAskRuntime } = await import('./meeting-ask-runtime.js')
const { MeetingAskStore } = await import('./meeting-ask-store.js')
const W = await import('./meeting-ask-web.js')
const { FACT_CHECK_PLANNER_SYSTEM } = await import('./meeting-fact-check.js')
const { PUBLIC_TOPIC_SYSTEM } = await import('./meeting-public-topic.js')
const { COMPARISON_FINAL, UNCHECKED_FINAL } = await import('./live-cos-ask.js')
const { REVIEW_SYSTEM } = await import('./meeting-ask-review.js')
const { WebLookupLedger, setWebLedgerForTests } = await import('./web-lookup-ledger.js')
const RT = await import('./meeting-ask-runtime.js')

const QUESTION = 'Does private aviation safter or more dangerious than commercial? typical commercial'
const TYPED = new Set(QUESTION.toLowerCase().match(/[a-z]+/g))
const ALLOWED_EXTRA = new Set(['comparison', 'average'])
const base = { requestId: 'request_cmp00001', sessionId: 'meeting_cmp', serverInstanceId: 'server-one', action: 'ask' as const, question: QUESTION, elapsedMs: 600_000, model: { engine: 'claude' as const, model: 'sonnet' } }
const turns = (lines: string[]) => lines.map((text, id) => ({ id, elapsedMs: id * 20_000, speaker: id % 2 ? 'Taylor' : 'Morgan', text }))
const PLAIN_TURNS = turns(['I read that small private planes crash at a much higher rate than airlines.', 'Is that true? I never checked it.', 'The airline pilots have more rules, I think.'])
const FIGURE = 'fatal accidents per 100,000 flight hours'

const dirs: string[] = []
let seq = 0
function setup(opts: { publicTopics?: boolean; review?: boolean; pages?: boolean; answer?: (prompt: any) => unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-cmp-')); dirs.push(dir)
  const store = new MeetingAskStore(dir)
  store.setPublicTopics(!!opts.publicTopics)
  const seen: Array<{ system: string; prompt: any }> = []
  const run = vi.fn(async (_m: unknown, prompt: string, system: string) => {
    if (system === FACT_CHECK_PLANNER_SYSTEM) return { text: '{"claims":[]}', model: 'claude-sonnet-5-5' }
    if (system === PUBLIC_TOPIC_SYSTEM) return { text: '{"publicTopic":false}', model: 'claude-sonnet-5-5' }
    const parsed = JSON.parse(prompt)
    seen.push({ system, prompt: parsed })
    if (system.startsWith(REVIEW_SYSTEM)) return { text: JSON.stringify({ sections: parsed.draft.sections, confidence: parsed.draft.confidence, support: parsed.draft.sections.flatMap((r: any) => [...r.text.matchAll(/\[(W\d+)\]/g)].map(m => ({ id: m[1], quote: parsed.sources.find((s: any) => s.id === m[1]).text.slice(0, 60) }))) }), model: 'claude-sonnet-5-5' }
    const pages = (parsed.evidence as any[]).filter(s => s.kind === 'web' && s.text.startsWith('Retrieved page excerpt'))
    const oneRow = (parsed.labels as string[] | undefined)?.length === 1
    const reply = opts.answer ? opts.answer({ parsed, pages }) : pages.length >= 2 && oneRow
      ? { sections: [{ label: 'So what', text: `Shopify publishes its plan prices on its pricing page [${pages[0].id}].` }], confidence: { level: 'supported', reason: 'One read page.' }, searchQuery: null }
      : pages.length >= 2
      ? { sections: [{ label: 'So what', text: `Taylor was right to doubt it: private flying is far more dangerous per flight hour than airline flying [${pages[0].id}].` },
        { label: 'Details', text: `Airlines: about 0.01 ${FIGURE} [${pages[0].id}]. Charter: about 0.2 to 0.8 [${pages[1].id}]. Private: about 0.7 to 1.0 [${pages[1].id}]. The caveat is that two-pilot charter flights come close to airlines [${pages[1].id}].` }],
        confidence: { level: 'supported', reason: 'Two read pages give the rates.' }, searchQuery: null }
      : { sections: [{ label: 'So what', text: 'Not checked against a source: private flying is generally considered meaningfully riskier per hour than airline flying.' }], confidence: { level: 'low', reason: 'No page was read.' }, searchQuery: null }
    return { text: JSON.stringify(reply), model: 'claude-sonnet-5-5' }
  })
  const runtime = new MeetingAskRuntime({ reviewAnswers: !!opts.review, finalized: () => ({ sources: [], notices: [] }), domains: () => [{ id: 'quilt', label: 'Quilt' }], store, identity: () => 'server-one', admissions: () => true,
    lease: () => ({ release: vi.fn(), id: 'lease', kind: 'meeting_ask' } as any), catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku', 'sonnet'] }],
    run, search: async () => ({ sources: [], notices: [] }), webSearch: W.searchMeetingWeb, webCapability: () => ({ available: true, engine: 'claude:haiku' }), ownerArea: () => null, ownerLabel: () => null, wearer: () => 'Morgan' } as any)
  const ledger = new WebLookupLedger(join(dir, 'ledger.json'), () => Date.parse('2026-11-02T22:43:00Z'))
  setWebLedgerForTests(ledger)
  return { runtime, run, seen, ledger, store }
}
async function ask(f: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
  const req = { ...base, requestId: `request_cmp${String(++seq).padStart(5, '0')}`, turns: PLAIN_TURNS, ...over }
  await f.runtime.submit(req)
  for (let i = 0; i < 1500; i++) {
    const e = f.runtime.get(req.requestId)
    if (!['pending', 'running'].includes(e.status)) return e
    await new Promise(r => setTimeout(r, 2))
  }
  throw new Error('never terminal')
}
let searchNo = 0
beforeEach(() => {
  searchNo = 0
  mocks.search.mockReset(); mocks.fetch.mockReset()
  mocks.search.mockImplementation(async (_m: unknown, _p: string, _s: string, _sig: unknown, adapter: { workspace: string; stdin: string }) => {
    const n = ++searchNo, query = JSON.parse(adapter.stdin).query
    writeFileSync(join(adapter.workspace, 'events.jsonl'), JSON.stringify({ tool: 'WebSearch', allowed: true, query }) + '\n')
    writeFileSync(join(adapter.workspace, 'result.json'), JSON.stringify({ results: ['Summary.', { content: [1, 2, 3, 4].map(i => ({ title: `Safety page ${n}.${i}`, url: `https://safety${n}${i}.example.org/rates` })) }] }))
    return { text: '{"done":true}' }
  })
  mocks.fetch.mockImplementation(async (url: string) => ({ url, title: `Page at ${url}`, text: `Accident rates by operation type, ${FIGURE}. Airlines 0.01, charter 0.2 to 0.8, private 0.7 to 1.0. `.repeat(4) }))
})
afterEach(() => { setWebLedgerForTests(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('Miles\'s 5:43 PM question shape (synthesized meeting)', () => {
  it('is admitted by the gate and runs three searches built only from his words, reading four pages in all', async () => {
    const f = setup()
    const e = await ask(f)
    expect(e.status).toBe('completed')
    expect(mocks.search).toHaveBeenCalledTimes(3)
    const queries = mocks.search.mock.calls.map(c => JSON.parse(c[4].stdin).query as string)
    expect(new Set(queries).size).toBe(3)
    for (const q of queries) for (const w of q.toLowerCase().match(/[a-z]+/g)!) expect(TYPED.has(w) || ALLOWED_EXTRA.has(w), `${q} :: ${w}`).toBe(true)
    expect(queries[0]).toContain('private aviation safter')
    expect(f.ledger.today().ask).toEqual({ searches: 3, pagesRead: 4, pagesFailed: 0 })
    expect(e.notices.join(' ')).not.toMatch(/withheld|No sufficiently clear public topic/)
    // Three searches together: the stated parallelism, not a sum. The fake search takes no time, so assert they were all started before any finished.
    expect(W.COMPARISON_SEARCHES).toBe(3); expect(W.COMPARISON_PAGES).toBe(4)
  })
  it('the answer is a verdict first, then cited figures and one caveat, in the existing So what and Details rows', async () => {
    const f = setup({ review: true })
    const e = await ask(f)
    expect(e.sections!.map(s => s.label)).toEqual(['So what', 'Details', 'Confidence'])
    const [verdict, details] = e.sections!
    expect(verdict.text.split(/[.!?]\s/).length).toBe(1)                                                    // one sentence
    expect(verdict.text).toMatch(/Taylor was right/)
    expect(details.text.match(/\[W\d+\]/g)!.length).toBeGreaterThanOrEqual(3)
    expect(details.text).toMatch(/caveat/i)
    const words = e.sections!.map(s => s.text).join(' ').replace(/\[W\d+\]/g, '').split(/\s+/).length
    expect(words).toBeLessThanOrEqual(200)
    expect(e.sources.filter(s => s.kind === 'web' && s.url).length).toBeGreaterThanOrEqual(2)
    // The prompts carry the shape: the answer system prompt overrides the short-answer rule, the instructions name the verdict, and the reviewer is told.
    const answer = f.seen.find(x => !x.system.startsWith(REVIEW_SYSTEM))!, review = f.seen.find(x => x.system.startsWith(REVIEW_SYSTEM))!
    expect(answer.system).toContain('COMPARISON OVERRIDE')
    expect(answer.prompt.finalInstructions).toContain(COMPARISON_FINAL)
    expect(answer.prompt.labels).toEqual(['So what', 'Details'])
    expect(answer.prompt.searchAllowed).toBe(false)
    expect(review.prompt.comparison).toBe(true)
    expect(review.prompt.labels).toEqual(['So what', 'Details'])
  })
  it('behaves the same in the production flow (public topics on): the fact-check planner finds nothing and the search still runs on his words', async () => {
    const f = setup({ publicTopics: true })
    const e = await ask(f)
    expect(e.status).toBe('completed')
    expect(mocks.search).toHaveBeenCalledTimes(3)
    expect(e.notices.join(' ')).not.toMatch(/No sufficiently clear public topic|Public search was withheld/)
  })
  it('when every page fails to read, the answer is one labeled general-knowledge line, not only "Unverified"', async () => {
    mocks.fetch.mockResolvedValue(null)
    const f = setup({ review: true })
    const e = await ask(f)
    expect(e.status).toBe('completed')
    expect(e.sections![0].text.startsWith('Not checked against a source:')).toBe(true)
    expect(e.sections![0].sources).toEqual([])
    expect(f.ledger.today().ask.pagesFailed).toBeGreaterThan(0)
    const answer = f.seen.find(x => !x.system.startsWith(REVIEW_SYSTEM))!, review = f.seen.find(x => x.system.startsWith(REVIEW_SYSTEM))!
    expect(answer.system).toContain(UNCHECKED_FINAL)
    expect(review.prompt.uncheckedLineAllowed).toBe(true)
    expect(review.system).toContain('Not checked against a source:')
  })
})

describe('timing', () => {
  it('the three searches run together: with each search taking 300 ms the whole Ask waits for about one of them, not three', async () => {
    const f = setup()
    const slow = mocks.search.getMockImplementation()!
    mocks.search.mockImplementation(async (...args: any[]) => { await new Promise(r => setTimeout(r, 300)); return slow(...args) })
    const at = Date.now()
    const e = await ask(f)
    const took = Date.now() - at
    expect(e.status).toBe('completed')
    expect(mocks.search).toHaveBeenCalledTimes(3)
    expect(took).toBeGreaterThanOrEqual(300)
    expect(took).toBeLessThan(850)                    // three in a row would take at least 900
  })
})

describe('what stays out of the search', () => {
  const FAMILY = ['My brother lost his best friend in a crash last spring.', 'The funeral for Dana was hard on my mother and my whole family.', 'Aunt Priya still cannot talk about the accident.', 'Is private aviation really that much worse, I never knew.']
  it('family words in the transcript never reach a query: the search runs on the typed words only', async () => {
    const f = setup({ publicTopics: true })
    const e = await ask(f, { turns: turns(FAMILY) })
    expect(e.status).toBe('completed')
    expect(mocks.search).toHaveBeenCalledTimes(3)
    const sent = mocks.search.mock.calls.map(c => c[4].stdin as string).join(' ').toLowerCase()
    for (const w of ['brother', 'funeral', 'dana', 'mother', 'family', 'priya', 'aunt', 'spring', 'friend']) expect(sent, w).not.toContain(w)
    for (const c of mocks.search.mock.calls) for (const w of (JSON.parse(c[4].stdin).query as string).toLowerCase().match(/[a-z]+/g)!) expect(TYPED.has(w) || ALLOWED_EXTRA.has(w), w).toBe(true)
  })
  it('a real privacy reference in the question is still withheld: no search, nothing counted as searched, and no general-knowledge line offered', async () => {
    const f = setup({ review: true })
    const e = await ask(f, { question: 'Is our private pricing more expensive than the typical average?' })
    expect(mocks.search).not.toHaveBeenCalled()
    expect(f.ledger.today().ask.searches).toBe(0)
    expect(f.ledger.today().withheld.byReason).toMatchObject({ personal: 1 })
    const answer = f.seen.find(x => !x.system.startsWith(REVIEW_SYSTEM))!
    expect(answer.system).not.toContain('Not checked against a source')
    expect(answer.system).not.toContain('COMPARISON OVERRIDE')
    expect(e.notices.join(' ')).toContain('Public search was withheld')
  })
  it('a plain explicit lookup keeps one search and the usual short answer', async () => {
    const f = setup()
    const e = await ask(f, { question: 'Search the web for Shopify pricing', turns: PLAIN_TURNS })
    expect(e.status).toBe('completed')
    expect(mocks.search).toHaveBeenCalledTimes(1)                                      // admitted and explicit, but not a comparison
    const answer = f.seen.find(x => !x.system.startsWith(REVIEW_SYSTEM))!
    expect(answer.system).not.toContain('COMPARISON OVERRIDE')
    expect(answer.prompt.labels).toEqual(['So what'])
  })
})

describe('comparisonQueries', () => {
  it('rearranges only the typed words, adds only comparison and average, and keeps a typo as typed', () => {
    const base = W.userWebQuery(QUESTION)!
    const q = W.comparisonQueries(base, QUESTION)
    expect(q).toEqual([base, 'private aviation safter dangerious average', 'commercial average'])   // the question as admitted, each side on its own
    for (const x of q) expect(W.publicSearchGate({ question: QUESTION, query: x })).toMatchObject({ ok: true })
  })
  it('without a comparator it uses the subject words and fewer than three when they would repeat', () => {
    expect(W.comparisonQueries('private jet crash rate', 'private jet crash rate')).toEqual(['private jet crash rate', 'private jet crash rate comparison', 'private jet crash rate average'])
    expect(W.comparisonQueries('shopify pricing').length).toBeLessThanOrEqual(3)
    expect(new Set(W.comparisonQueries('a than b')).size).toBe(W.comparisonQueries('a than b').length)
    expect(W.comparisonQueries('private jet average', 'private jet average')).toEqual(['private jet average', 'private jet comparison'])      // the third would repeat the first
  })
  it('comparisonQuestion: than, versus, compare, and fact-check requests', () => {
    for (const q of [QUESTION, 'Is X cheaper than Y', 'A versus B', 'Compare A and B', 'can you fact check this']) expect(W.comparisonQuestion(q), q).toBe(true)
    for (const q of ['Who is the CEO of Shopify?', 'What was decided?', 'Search the web for Shopify pricing']) expect(W.comparisonQuestion(q), q).toBe(false)
  })
})

// 6.97.8 deadline: virtual time, realistic latencies. The 2026-11-02 journal: fact_check 2.5 s, public_topic 3.6 s, plan 2.9 + 3.2 s, answer 5.8 s,
// review 5.5 s. A comparison answer is longer (about twice the output), and each search takes 8 s here.
describe('the Ask deadline', () => {
  const { MEETING_ASK_DEADLINE_MS, COMPARISON_DEADLINE_MS, COMPARISON_PHASE_BUDGET_MS } = RT
  const LAT = { factPlanner: 2500, publicTopic: 3600, answerLong: 11_600, reviewLong: 11_000, answerShort: 5800, reviewShort: 5500, search: 8000, page: 1500 }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
  afterEach(() => { vi.useRealTimers() })

  function slowSetup(lat: { answer: number; review: number }, publicTopics = true) {
    const f = setup({ publicTopics, review: true })
    const calls = { factPlanner: 0, publicTopic: 0 }
    const inner = f.run.getMockImplementation()!
    // Like the real runner, a model call stops when the Ask is aborted.
    const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
    })
    f.run.mockImplementation(async (m: unknown, prompt: string, system: string, signal?: AbortSignal) => {
      if (system === FACT_CHECK_PLANNER_SYSTEM) { calls.factPlanner++; await sleep(LAT.factPlanner, signal) }
      else if (system === PUBLIC_TOPIC_SYSTEM) { calls.publicTopic++; await sleep(LAT.publicTopic, signal) }
      else await sleep(system.startsWith(REVIEW_SYSTEM) ? lat.review : lat.answer, signal)
      return inner(m, prompt, system)
    })
    const fast = mocks.search.getMockImplementation()!
    mocks.search.mockImplementation(async (...args: any[]) => { await new Promise(r => setTimeout(r, LAT.search)); return fast(...args) })
    const pages = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation(async (...args: any[]) => { await new Promise(r => setTimeout(r, LAT.page)); return pages(...args) })
    return { f, calls }
  }
  async function runVirtual(f: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
    const req = { ...base, requestId: `request_dl${String(++seq).padStart(6, '0')}`, turns: PLAIN_TURNS, ...over }
    const started = Date.now()
    await f.runtime.submit(req)
    for (let i = 0; i < 1500; i++) {
      const e = f.runtime.get(req.requestId)
      if (!['pending', 'running'].includes(e.status)) return { e, took: Date.now() - started }
      await vi.advanceTimersByTimeAsync(100)
    }
    throw new Error('never terminal')
  }

  it('the comparison bound is the sum of its phase budgets: 3 + 12 + 12 + 12 + 12 + 4 = 55 s; the usual Ask keeps 30 s', () => {
    expect(COMPARISON_PHASE_BUDGET_MS).toEqual({ startup: 3000, searches: 12000, answer: 12000, review: 12000, reviewRepair: 12000, shutdown: 4000 })
    expect(COMPARISON_DEADLINE_MS).toBe(55_000)
    expect(MEETING_ASK_DEADLINE_MS).toBe(30_000)
  })
  it('a comparison that takes 32 s finishes (the 30 s deadline would have cut it), with no fact-check planner, no public-topic call and no plan hop', async () => {
    const { f, calls } = slowSetup({ answer: LAT.answerLong, review: LAT.reviewLong })
    const { e, took } = await runVirtual(f)
    expect(e.status).toBe('completed')
    expect(took).toBeGreaterThan(MEETING_ASK_DEADLINE_MS)                       // longer than the usual deadline allows
    expect(took).toBeLessThan(COMPARISON_DEADLINE_MS)
    expect(calls).toEqual({ factPlanner: 0, publicTopic: 0 })
    expect(e.timings!.phases.map(p => p.phase)).toEqual(['web_search', 'web_search', 'web_search', 'answer', 'review'])
    expect(mocks.search).toHaveBeenCalledTimes(3)
    console.log(`comparison path, virtual ms: total ${e.timings!.totalMs}; phases ${e.timings!.phases.map(p => `${p.phase} ${p.ms}`).join(', ')}`)
  })
  it('a "fact check" question keeps the planner (the skip is for a comparison that is itself the claim)', async () => {
    const { f, calls } = slowSetup({ answer: LAT.answerShort, review: LAT.reviewShort })
    await runVirtual(f, { question: 'Can you fact check whether private aviation is more dangerous than commercial on average' })
    expect(calls.factPlanner).toBe(1)
  })
  it('the comparison bound counts from the start of the run: an answer that never ends is cut at 55 s, not later', async () => {
    const { f } = slowSetup({ answer: 200_000, review: LAT.reviewLong })
    const { e, took } = await runVirtual(f)
    expect(e.status).toBe('failed')
    expect(e.error).toBe('answer_deadline_exceeded')
    expect(took).toBeGreaterThanOrEqual(COMPARISON_DEADLINE_MS - 200)
    expect(took).toBeLessThanOrEqual(COMPARISON_DEADLINE_MS + 400)
  })
  it('the bound counts from the start even when the comparison is chosen late (a pasted link took 1.5 s to read first)', async () => {
    const { f } = slowSetup({ answer: 200_000, review: LAT.reviewLong })
    const { e, took } = await runVirtual(f, { question: `${QUESTION} https://example.org/story` })
    expect(e.status).toBe('failed')
    expect(e.error).toBe('answer_deadline_exceeded')
    expect(took).toBeGreaterThanOrEqual(COMPARISON_DEADLINE_MS - 200)
    expect(took).toBeLessThanOrEqual(COMPARISON_DEADLINE_MS + 400)
  })
  it('a non-comparison Ask keeps the 30 s deadline: the same latencies end it at 30 s', async () => {
    const { f } = slowSetup({ answer: LAT.answerLong, review: LAT.reviewLong })
    const { e, took } = await runVirtual(f, { question: 'Search the web for Shopify pricing' })
    expect(e.status).toBe('failed')
    expect(e.error).toBe('answer_deadline_exceeded')
    expect(took).toBeGreaterThanOrEqual(MEETING_ASK_DEADLINE_MS - 200)
    expect(took).toBeLessThanOrEqual(MEETING_ASK_DEADLINE_MS + 400)
    expect(mocks.search).toHaveBeenCalledTimes(1)
  })
  it('a non-comparison Ask with the journal\'s own latencies finishes well inside 30 s', async () => {
    const { f } = slowSetup({ answer: LAT.answerShort, review: LAT.reviewShort })
    const { e, took } = await runVirtual(f, { question: 'Search the web for Shopify pricing' })
    expect(e.error ?? '').toBe('')
    expect(e.status).toBe('completed')
    expect(took).toBeLessThan(MEETING_ASK_DEADLINE_MS)
  })
})
