import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JEV_KEY_FILE, JEV_LIMITS, JEV_MODEL, JEV_USAGE_FILE, JevClient } from './jev.js'
import { WORK_SEARCH_INSTRUCTIONS, WORK_SEARCH_LIMITS, WORK_SEARCH_NONE, WORK_SEARCH_USAGE_FILE, WorkSearcher, createWorkSearchJevClient, normalizeQuery, rankHits,
  searchOptionText, selectCandidates, workSearchDailyCap, workSearchEnabled, type SearchableRow } from './work-search.js'

const KEY = 'ts_live_' + 'k'.repeat(32)
let dir = ''
beforeEach(() => {
  for (const name of ['TYPESAFE_API_KEY', 'COS_JEV_DAILY_TOKENS', 'COS_JEV_SEARCH_DAILY_TOKENS', 'COS_JEV_SEARCH']) delete process.env[name]
  dir = mkdtempSync(join(tmpdir(), 'work search.'))
  if (existsSync(JEV_KEY_FILE)) unlinkSync(JEV_KEY_FILE)
  process.env.TYPESAFE_API_KEY = KEY
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const name of ['TYPESAFE_API_KEY', 'COS_JEV_DAILY_TOKENS', 'COS_JEV_SEARCH_DAILY_TOKENS', 'COS_JEV_SEARCH']) delete process.env[name]
  vi.restoreAllMocks()
})

const row = (id: string, text: string, extra: Partial<SearchableRow> = {}): SearchableRow => ({ id, domain: 'quilt', text, checked: false, ...extra })
const ID = (n: number) => n.toString(16).padStart(12, '0')
const rows = [row(ID(1), 'Send the Jewel360 LinkedIn article to Nick'), row(ID(2), 'Launch the State of Pet report'), row(ID(3), 'Update the September slides')]

const answer = (probabilities: Record<string, number>, tokens = 9_000) => new Response(JSON.stringify({
  model: JEV_MODEL, answers: { c: { choice: 't0', confidence: 0.9, probabilities, type: 'choice' } }, usage: { input_tokens: tokens } }), { status: 200 })

function searcher(fetchImpl: (...a: any[]) => Promise<Response>, clock = { now: Date.parse('2026-10-06T23:00:00Z') }) {
  const jev = createWorkSearchJevClient(fetchImpl as typeof fetch, () => new Date(clock.now), join(dir, 'search-usage.json'))
  return { jev, search: new WorkSearcher(jev, () => clock.now), clock }
}

describe('option text', () => {
  it('strips Work details links, collapses whitespace and keeps at most 300 characters', () => {
    expect(searchOptionText('Draft  the\n landing page [Work details](cos-work://v1/eyJhIjoxfQ) now')).toBe('Draft the landing page now')
    expect(searchOptionText('[work DETAILS](x) only')).toBe('only')
    const long = searchOptionText('word '.repeat(200))
    expect(long.length).toBeLessThanOrEqual(WORK_SEARCH_LIMITS.optionChars)
    expect(long.endsWith(' ')).toBe(false)
  })
})

describe('candidates', () => {
  const board = [row(ID(1), 'Open quilt'), row(ID(2), 'Done quilt', { checked: true }), row(ID(3), 'Open personal', { domain: 'personal' }),
    row(ID(4), 'Done personal', { domain: 'personal', checked: true }), row(ID(5), 'Renamed', { workIdentity: ID(9) }), row(ID(6), '[Work details](x)')]
  const ids = (picked: SearchableRow[] | null) => picked?.map(r => r.id)
  it('All work covers open cards; a domain board covers that domain, open and completed; Completed covers completed', () => {
    expect(ids(selectCandidates(board, {}))).toEqual([ID(1), ID(3), ID(5)])
    expect(ids(selectCandidates(board, { scope: 'all' }))).toEqual([ID(1), ID(3), ID(5)])
    expect(ids(selectCandidates(board, { domain: 'quilt' }))).toEqual([ID(1), ID(2), ID(5)])
    expect(ids(selectCandidates(board, { scope: 'completed' }))).toEqual([ID(2), ID(4)])
    expect(ids(selectCandidates(board, { scope: 'completed', domain: 'personal' }))).toEqual([ID(4)])
    // Needs attention and In progress are Control's own views: without ids they cover open cards.
    expect(ids(selectCandidates(board, { scope: 'attention' }))).toEqual([ID(1), ID(3), ID(5)])
    expect(ids(selectCandidates(board, { scope: 'progress', domain: 'personal' }))).toEqual([ID(3)])
  })
  it('exact ids win over the view, match a row id or its Work identity, and keep board order', () => {
    expect(ids(selectCandidates(board, { ids: [ID(9), ID(2)], scope: 'all' }))).toEqual([ID(2), ID(5)])
    expect(ids(selectCandidates(board, { ids: [ID(4)], domain: 'quilt' }))).toEqual([ID(4)])
    expect(ids(selectCandidates(board, { ids: [] }))).toEqual([])
  })
  it('refuses more than 254 cards instead of cutting the list', () => {
    const many = Array.from({ length: WORK_SEARCH_LIMITS.maxCandidates + 1 }, (_, i) => row(ID(i + 100), `Task number ${i}`))
    expect(selectCandidates(many, {})).toBeNull()
    expect(selectCandidates(many.slice(1), {})).toHaveLength(WORK_SEARCH_LIMITS.maxCandidates)
  })
})

describe('ranking', () => {
  it('keeps only p of at least 0.02, most likely first, and reports none', () => {
    expect(rankHits({ t0: 0.02, t1: 0.019999, t2: 0.5, t3: 0, none: 0.4 }, [ID(0), ID(1), ID(2), ID(3)]))
      .toEqual({ results: [{ id: ID(2), p: 0.5 }, { id: ID(0), p: 0.02 }], none: 0.4 })
    expect(rankHits({ t0: 0.3 }, [ID(0)])).toEqual({ results: [{ id: ID(0), p: 0.3 }], none: null })
  })
  it('returns at most 20 hits, the most likely ones', () => {
    const ids = Array.from({ length: 30 }, (_, i) => ID(i))
    const probabilities: Record<string, number> = { none: 0.05, t7: 0.6, t9: 0.1 }
    for (let i = 10; i < 30; i++) probabilities[`t${i}`] = 0.021 + i / 10_000
    const { results } = rankHits(probabilities, ids)
    expect(results).toHaveLength(WORK_SEARCH_LIMITS.maxResults)
    expect(results.slice(0, 3)).toEqual([{ id: ID(7), p: 0.6 }, { id: ID(9), p: 0.1 }, { id: ID(29), p: 0.0239 }])
    expect(results.map(r => r.p)).toEqual(results.map(r => r.p).sort((a, b) => b - a))
    expect(results.some(r => r.id === ID(10) || r.id === ID(11))).toBe(false)  // the two least likely fell off
  })
  it('refuses an answer naming a card that was not offered or a probability outside 0 to 1', () => {
    expect(() => rankHits({ t3: 0.5 }, [ID(0)])).toThrow('not offered')
    expect(() => rankHits({ x0: 0.5 }, [ID(0)])).toThrow('not offered')
    expect(() => rankHits({ t0: 1.5 }, [ID(0)])).toThrow('outside')
    expect(() => rankHits(undefined, [ID(0)])).toThrow('no probabilities')
  })
})

describe('WorkSearcher with a fake Jev', () => {
  // Calibration from live Choice calls on 105 Quilt tasks (2026-10-06, plan canaries K1 to K4). Each fixture is the
  // answer shape Jev returns: answers.c = { choice, confidence, probabilities, type }, `none` inside probabilities.
  const live = (probabilities: Record<string, number>, choice = 'none') => async () => new Response(JSON.stringify({ model: JEV_MODEL,
    answers: { c: { choice, confidence: Math.max(...Object.values(probabilities)), probabilities, type: 'choice' } }, usage: { input_tokens: 4_962 } }), { status: 200 })
  const ten = Array.from({ length: 10 }, (_, i) => row(ID(i + 1), `Quilt task number ${i + 1}`))
  it('K1: a targeted query returns the intended card first, even at a low p, and keeps weak runners-up', async () => {
    const out = await searcher(vi.fn(live({ t3: 0.47, t7: 0.12, t1: 0.03, t0: 0.015, t2: 0.001, none: 0.364 }, 't3'))).search.search('linkedin article for nick', ten)
    expect(out).toEqual({ available: true, results: [{ id: ID(4), p: 0.47 }, { id: ID(8), p: 0.12 }, { id: ID(2), p: 0.03 }], none: 0.364, cached: false, tokens: 4_962 })
  })
  it('K2: a nonsense or off-board query is none-dominant and returns no cards at all', async () => {
    const answers: Array<Record<string, number>> = [{ none: 1, t0: 0, t5: 0 }, { none: 0.9981, t2: 0.0011, t9: 0.0008 }, { none: 0.97, t4: 0.019999 }]
    for (const probabilities of answers) {
      const out = await searcher(vi.fn(live(probabilities))).search.search('zebra pancake recipe', ten)
      expect(out).toMatchObject({ available: true, results: [], cached: false })
      expect((out as { none: number }).none).toBeGreaterThanOrEqual(0.97)
    }
  })
  it('K3: a broad query spreads; every card at 0.02 or more comes back in order, with none', async () => {
    const out = await searcher(vi.fn(live({ t0: 0.23, t4: 0.12, t6: 0.06, t8: 0.06, t1: 0.019, t2: 0.011, none: 0.45 }, 'none'))).search.search('website', ten)
    expect(out).toMatchObject({ available: true, none: 0.45 })
    expect((out as { results: Array<{ id: string; p: number }> }).results).toEqual([{ id: ID(1), p: 0.23 }, { id: ID(5), p: 0.12 }, { id: ID(7), p: 0.06 }, { id: ID(9), p: 0.06 }])
  })
  it('ranks by probabilities, never by the answer\'s choice field', async () => {
    const out = await searcher(vi.fn(live({ t2: 0.4, t5: 0.35, none: 0.25 }, 't5'))).search.search('pet report', ten)
    expect((out as { results: Array<{ id: string }> }).results.map(r => r.id)).toEqual([ID(3), ID(6)])
  })
  it('an answer with no probabilities, or no c question at all, degrades to jev_unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bodies = [{ answers: { c: { choice: 't0', confidence: 1, type: 'choice' } } }, { answers: { other: {} } }, { answers: { c: { probabilities: { t0: 'high' } } } }]
    for (const body of bodies) {
      const f = vi.fn(async () => new Response(JSON.stringify({ model: JEV_MODEL, ...body, usage: { input_tokens: 10 } }), { status: 200 }))
      expect(await searcher(f).search.search('slides', ten)).toMatchObject({ available: false, reason: 'jev_unavailable' })
    }
  })
  it('sends one Choice over the cards, in the verified shape, and answers by card id', async () => {
    const f = vi.fn(async () => answer({ t0: 0.9, t1: 0.03, t2: 0.01, none: 0.06 }, 8_800))
    const { search } = searcher(f)
    const result = await search.search('  linkedin piece for nick ', [...rows, row(ID(4), 'Card [Work details](cos-work://v1/abc) text')])
    expect(result).toEqual({ available: true, results: [{ id: ID(1), p: 0.9 }, { id: ID(2), p: 0.03 }], none: 0.06, cached: false, tokens: 8_800 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(JSON.parse(String(init.body))).toEqual({ model: JEV_MODEL, state: { query: 'linkedin piece for nick' }, questions: { c: { type: 'choice',
      instructions: WORK_SEARCH_INSTRUCTIONS, criteria: { t0: rows[0].text, t1: rows[1].text, t2: rows[2].text, t3: 'Card text', none: WORK_SEARCH_NONE } } } })
    expect(WORK_SEARCH_INSTRUCTIONS).toBe('The user typed `query` into the search box of their task board. Which task are they trying to find? Pick the task they mean even when it uses different words, or none if no task fits.')
  })

  it('serves the same query over the same cards from the cache for 10 minutes, then asks again', async () => {
    const f = vi.fn(async () => answer({ t1: 0.8, none: 0.2 }))
    const { search, clock } = searcher(f)
    await search.search('Pet report', rows)
    expect(await search.search('  pet   REPORT ', rows)).toMatchObject({ available: true, cached: true, tokens: 0, results: [{ id: ID(2), p: 0.8 }] })
    expect(f).toHaveBeenCalledTimes(1)
    // A changed card (or a different set) is a different search.
    await search.search('Pet report', [rows[0], row(ID(2), 'Launch the State of Pet report campaign'), rows[2]])
    expect(f).toHaveBeenCalledTimes(2)
    clock.now += WORK_SEARCH_LIMITS.cacheMs - 1
    expect(await search.search('pet report', rows)).toMatchObject({ cached: true })
    clock.now += 1
    expect(await search.search('pet report', rows)).toMatchObject({ cached: false })
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('keeps at most 200 cached searches', async () => {
    const f = vi.fn(async () => answer({ t0: 0.5, none: 0.5 }, 1))
    const { search } = searcher(f)
    for (let i = 0; i <= WORK_SEARCH_LIMITS.cacheEntries; i++) await search.search(`query ${i}`, rows)
    expect(f).toHaveBeenCalledTimes(201)
    expect(await search.search('query 200', rows)).toMatchObject({ cached: true })
    expect(await search.search('query 0', rows)).toMatchObject({ cached: false })  // the oldest went first
  })

  it('shares one request between identical searches in flight', async () => {
    let release!: () => void
    const f = vi.fn(() => new Promise<Response>(r => { release = () => r(answer({ t2: 0.7, none: 0.3 })) }))
    const { search } = searcher(f)
    const a = search.search('slides', rows), b = search.search('SLIDES', rows)
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    release()
    expect((await a)).toEqual(await b)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('answers without Jev for no cards, and refuses more than 254', async () => {
    const f = vi.fn(async () => answer({}))
    const { search } = searcher(f)
    expect(await search.search('anything', [])).toEqual({ available: true, results: [], none: 1, cached: false, tokens: 0 })
    const many = Array.from({ length: WORK_SEARCH_LIMITS.maxCandidates + 1 }, (_, i) => row(ID(i + 1), `Task ${i}`))
    expect(await search.search('anything', many)).toMatchObject({ available: false, reason: 'too_many_candidates' })
    expect(f).not.toHaveBeenCalled()
  })

  it('degrades with a reason: no key, Jev down, a rejected key, a malformed answer', async () => {
    delete process.env.TYPESAFE_API_KEY
    const f = vi.fn(async () => answer({ t0: 1, none: 0 }))
    expect(await searcher(f).search.search('slides', rows)).toMatchObject({ available: false, reason: 'jev_not_configured', message: expect.stringContaining('TypeSafe key') })
    expect(f).not.toHaveBeenCalled()
    process.env.TYPESAFE_API_KEY = KEY
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const reply of [() => new Response('', { status: 503 }), () => new Response('', { status: 401 }), () => answer({ t9: 1 }), () => { throw new Error('offline') }]) {
      expect(await searcher(vi.fn(async () => reply())).search.search('slides', rows)).toMatchObject({ available: false, reason: 'jev_unavailable' })
    }
  })

  it('has its own daily cap (COS_JEV_SEARCH_DAILY_TOKENS), its own ledger, and refuses before sending', async () => {
    const f = vi.fn(async () => answer({ t0: 0.9, none: 0.1 }, 9_000))
    process.env.COS_JEV_DAILY_TOKENS = '1'  // the Work intake / advice cap does not govern search
    const { search, jev } = searcher(f)
    expect(await search.search('linkedin', rows)).toMatchObject({ available: true, tokens: 9_000 })
    expect(jev.usedToday()).toBe(9_000)
    expect(JSON.parse(readFileSync(join(dir, 'search-usage.json'), 'utf8'))).toEqual({ '2026-10-06': 9_000 })
    expect(jev.status().dailyCap).toBe(WORK_SEARCH_LIMITS.defaultDailyTokens)
    process.env.COS_JEV_SEARCH_DAILY_TOKENS = '9100'
    expect(workSearchDailyCap()).toBe(9_100)
    expect(await search.search('pet report', rows)).toMatchObject({ available: false, reason: 'jev_cap_reached', message: expect.stringContaining('budget') })
    expect(f).toHaveBeenCalledTimes(1)
    process.env.COS_JEV_SEARCH_DAILY_TOKENS = 'nonsense'
    expect(workSearchDailyCap()).toBe(WORK_SEARCH_LIMITS.defaultDailyTokens)
  })

  it('has its own breaker: three failures pause search for an hour without calling Jev', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = vi.fn(async () => new Response('', { status: 503 }))
    const { search, jev, clock } = searcher(f)
    const other = new JevClient(f as unknown as typeof fetch, () => new Date(clock.now), join(dir, 'other-usage.json'))
    for (let i = 0; i < JEV_LIMITS.breakerFailures; i++) expect(await search.search(`try ${i}`, rows)).toMatchObject({ reason: 'jev_unavailable' })
    expect(await search.search('try again', rows)).toMatchObject({ available: false, reason: 'jev_breaker_open', message: expect.stringContaining('paused') })
    expect(f).toHaveBeenCalledTimes(JEV_LIMITS.breakerFailures)
    expect(other.status().breakerOpenUntil).toBeNull()
    f.mockImplementation(async () => answer({ t0: 1, none: 0 }))
    clock.now += JEV_LIMITS.breakerMs
    expect(await search.search('try again', rows)).toMatchObject({ available: true })
    expect(jev.status().breakerOpenUntil).toBeNull()
  })
})

it('the switch: COS_JEV_SEARCH=0 (or false, no, off) turns search off; anything else leaves it on', () => {
  expect(workSearchEnabled({})).toBe(true)
  for (const off of ['0', ' false ', 'NO', 'off']) expect(workSearchEnabled({ COS_JEV_SEARCH: off })).toBe(false)
  for (const on of ['1', 'yes', '']) expect(workSearchEnabled({ COS_JEV_SEARCH: on })).toBe(true)
})

it('search spends from its own ledger file, never the one Work intake and session advice share', async () => {
  expect(WORK_SEARCH_USAGE_FILE).not.toBe(JEV_USAGE_FILE)
  expect(WORK_SEARCH_USAGE_FILE.endsWith('jev-search-usage.json')).toBe(true)
  const shared = new JevClient(undefined, () => new Date('2026-10-06T23:00:00Z'))
  const before = shared.usedToday()
  const jev = createWorkSearchJevClient((async () => answer({ t0: 1, none: 0 }, 777)) as unknown as typeof fetch, () => new Date('2026-10-06T23:00:00Z'))
  try {
    await new WorkSearcher(jev).search('linkedin', rows)
    expect(JSON.parse(readFileSync(WORK_SEARCH_USAGE_FILE, 'utf8'))['2026-10-06']).toBeGreaterThanOrEqual(777)
    expect(shared.usedToday()).toBe(before)
  } finally { rmSync(WORK_SEARCH_USAGE_FILE, { force: true }) }
})

it('normalizes case, spacing and Unicode form in the cache key', () => {
  expect(normalizeQuery('  Ｐet\tREPORT ')).toBe('pet report')
})
